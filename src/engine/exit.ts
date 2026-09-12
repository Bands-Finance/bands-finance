/**
 * The exit ladder, pure. Port of the rails in Meridian's agent/src/memeGuard.ts:
 *   - rollStop: a per-band stop percent jittered inside [0.8, 1.0] x the configured limit so
 *     nobody can front-run the exact level (Meridian's stopLinePct); persisted at open in
 *     state.stops[position] and used in place of the global number wherever present.
 *   - out-of-range persistence: a band must sit out of range for ENGINE_OUT_OF_RANGE_SEC before
 *     the LLM may move it (Meridian's OUT_OF_RANGE_MIN_MS), unless it is already down half its stop.
 *   - knife: a drop over the trailing 30 min past ENGINE_KNIFE_PCT blocks opens in that pool
 *     (Meridian's knife gate on tick drift).
 * The global cooldown between actions stays in the guards (minSecondsBetweenActions).
 * Nothing here touches the disk or the network; the loop persists the state it returns.
 */
import type { Decision } from "../agent/schema";
import type { RiskLimits } from "../risk/limits";
import type { PriceSample, RiskState } from "../risk/state";
import type { PositionSnapshot } from "../tools/dlmm";

export const PRICE_HISTORY_MS = 6 * 60 * 60 * 1000;
export const KNIFE_WINDOW_MS = 30 * 60 * 1000;

/** A stop percent in [0.8, 1.0] x limits.stopLossPct, two decimals, never above the limit. */
export function rollStop(limits: Pick<RiskLimits, "stopLossPct">, rng: () => number = Math.random): number {
  const u = Math.min(Math.max(rng(), 0), 1);
  const pct = Math.round(limits.stopLossPct * (0.8 + 0.2 * u) * 100) / 100;
  return Math.min(pct, limits.stopLossPct);
}

/** The stop that applies to one band: its rolled stop when present, else the configured limit. */
export function bandStopPct(stops: Record<string, number> | undefined, position: string, limits: Pick<RiskLimits, "stopLossPct">): number {
  const s = stops?.[position];
  return typeof s === "number" && s > 0 && s <= limits.stopLossPct ? s : limits.stopLossPct;
}

/** Percent below entry, positive when the band is under water; null without a usable entry. */
export function drawdownPct(p: Pick<PositionSnapshot, "valueInSol">, entryValueSol: number | undefined): number | null {
  if (!entryValueSol || entryValueSol <= 0) return null;
  return (1 - p.valueInSol / entryValueSol) * 100;
}

/** Keep state.outOfRangeSince honest: set when first seen out of range, cleared when back in range. */
export function trackOutOfRange(state: Pick<RiskState, "outOfRangeSince">, positions: readonly Pick<PositionSnapshot, "address" | "inRange">[], now: number): void {
  const since = (state.outOfRangeSince ??= {});
  for (const p of positions) {
    if (p.inRange) delete since[p.address];
    else if (!(p.address in since)) since[p.address] = now;
  }
}

/** Seconds a band has been out of range (0 while in range or unknown). */
export function outOfRangeSec(outOfRangeSince: Record<string, number> | undefined, position: string, now: number): number {
  const since = outOfRangeSince?.[position];
  return typeof since === "number" ? Math.max(0, (now - since) / 1000) : 0;
}

/**
 * Anti-churn for LLM-proposed moves. A REBALANCE or CLOSE of an out-of-range band that has not
 * sat out of range for the minimum is blocked, unless the band is already down at least half its
 * stop. An in-range band is not judged here (the model may still close into a dislocation).
 * Returns the violation string or null. Never applied to engine directives.
 */
export function antiChurn(
  decision: Decision,
  positions: readonly PositionSnapshot[],
  state: Pick<RiskState, "outOfRangeSince" | "stops" | "entryValueSol">,
  limits: Pick<RiskLimits, "stopLossPct">,
  minSec: number,
  now: number,
): string | null {
  if (decision.action !== "REBALANCE" && decision.action !== "CLOSE_POSITION") return null;
  const p = positions.find((x) => x.address === decision.positionAddress);
  if (!p) return null; // the close-target check reports this
  if (p.inRange) return null;
  const sec = outOfRangeSec(state.outOfRangeSince, p.address, now);
  if (sec >= minSec) return null;
  const dd = drawdownPct(p, state.entryValueSol[p.address]);
  const stop = bandStopPct(state.stops, p.address, limits);
  if (dd !== null && dd >= stop / 2) return null;
  return `anti-churn: ${p.address.slice(0, 6)} is out of range for ${Math.round(sec)}s, minimum ${minSec}s`;
}

/** Append a price sample and trim the pool's history to the trailing window. */
export function recordPrice(state: Pick<RiskState, "priceHistory">, pool: string, price: number, now: number, windowMs = PRICE_HISTORY_MS): void {
  if (!(price > 0) || !Number.isFinite(price)) return;
  const all = (state.priceHistory ??= {});
  const h = all[pool] ?? [];
  h.push({ ts: now, price });
  all[pool] = h.filter((s) => now - s.ts <= windowMs);
}

/**
 * Drop over the trailing window, in percent (positive = fell). The reference is the sample at
 * the window's edge: the oldest sample inside it, extended to the last sample before it, so a
 * knife is visible as soon as two samples exist. Null with fewer than two samples.
 */
export function dropOverWindowPct(history: readonly PriceSample[] | undefined, now: number, windowMs = KNIFE_WINDOW_MS): number | null {
  if (!history || history.length < 2) return null;
  const sorted = [...history].sort((a, b) => a.ts - b.ts);
  const latest = sorted[sorted.length - 1];
  const edge = now - windowMs;
  let ref: PriceSample | null = null;
  for (const s of sorted) {
    if (s.ts <= edge) ref = s; // the last sample before the window
    else {
      if (!ref) ref = s; // none before it: the oldest inside
      break;
    }
  }
  if (!ref || ref === latest || !(ref.price > 0)) return null;
  return (1 - latest.price / ref.price) * 100;
}

/** The knife reason for a pool, or null when the tape is not falling that fast. */
export function knifeReason(history: readonly PriceSample[] | undefined, now: number, knifePct: number, windowMs = KNIFE_WINDOW_MS): string | null {
  const drop = dropOverWindowPct(history, now, windowMs);
  if (drop === null || drop <= knifePct) return null;
  return `knife: -${drop.toFixed(1)}% in ${Math.round(windowMs / 60000)} min (limit ${knifePct}%)`;
}

/** Drop the per-band bookkeeping of a band that no longer exists. */
export function forgetBand(state: RiskState, position: string): void {
  delete state.entryValueSol[position];
  if (state.stops) delete state.stops[position];
  if (state.outOfRangeSince) delete state.outOfRangeSince[position];
  if (state.feesPendingSince) delete state.feesPendingSince[position];
}
