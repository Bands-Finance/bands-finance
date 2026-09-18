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
import { askStopBasis } from "./askExit";
import { unclaimedFeesSol, type CollectSnapshot } from "./collect";

export const PRICE_HISTORY_MS = 6 * 60 * 60 * 1000;
export const KNIFE_WINDOW_MS = 30 * 60 * 1000;

/**
 * A stop percent in [0.8, 1.0] x limits.stopLossPct, two decimals, never above the limit.
 *
 * `tighterPct` rolls the jitter around a TIGHTER number instead (the launch lane's LAUNCH_STOP_PCT,
 * src/screener/launch.ts): same jitter, same shape, same place on disk (state.stops), so the guards
 * and the engine's STOP directive read it exactly as they read any other band's stop. It can only
 * tighten: a value at or above the configured limit is ignored, and the result is still capped.
 */
export function rollStop(limits: Pick<RiskLimits, "stopLossPct">, rng: () => number = Math.random, tighterPct?: number | null): number {
  const base = typeof tighterPct === "number" && Number.isFinite(tighterPct) && tighterPct > 0 ? Math.min(tighterPct, limits.stopLossPct) : limits.stopLossPct;
  const u = Math.min(Math.max(rng(), 0), 1);
  const pct = Math.round(base * (0.8 + 0.2 * u) * 100) / 100;
  return Math.min(pct, limits.stopLossPct);
}

/** The stop that applies to one band: its rolled stop when present, else the configured limit. */
export function bandStopPct(stops: Record<string, number> | undefined, position: string, limits: Pick<RiskLimits, "stopLossPct">): number {
  const s = stops?.[position];
  return typeof s === "number" && s > 0 && s <= limits.stopLossPct ? s : limits.stopLossPct;
}

/** Percent below entry, positive when the band is under water; null without a usable entry. */
/**
 * How far a band's MARKET value has fallen below what went in, percent. The fees waiting inside the
 * band are set aside first (feesSol): a band's value includes them, so without this a claim would
 * move a band closer to its stop although nothing was lost, and a fee-rich band would sit further
 * from it than its token exposure warrants (2026-09-18: claiming 1.2 SOL from GP took its cushion
 * from 25% to 12%). The stop bounds what price does to the capital; fees are income beside it.
 */
export function drawdownPct(p: Pick<PositionSnapshot, "valueInSol">, entryValueSol: number | undefined, feesSol = 0): number | null {
  if (!entryValueSol || entryValueSol <= 0) return null;
  return (1 - Math.max(0, p.valueInSol - Math.max(0, feesSol)) / entryValueSol) * 100;
}

/**
 * The entry a band's STOP is measured against: for an ask band (src/engine/askExit.ts) the mark the
 * first ask of its chain was laid at, so the chain's stop bounds the whole chain and not each re-lay;
 * for every other band its entry value. (The ledger keeps entryValueSol as each position's own entry:
 * the stop's basis and the P&L basis are different numbers on a re-laid ask.)
 */
export function stopEntryOf(state: Pick<RiskState, "entryValueSol" | "askBands">, p: Pick<PositionSnapshot, "address" | "entryValueSol">): number | undefined {
  const ask = state.askBands?.[p.address];
  if (ask) return askStopBasis(ask);
  return state.entryValueSol[p.address] ?? p.entryValueSol;
}

/** drawdownPct with the band's unclaimed fees read off the snapshot. */
export function marketDrawdownPct(p: Pick<PositionSnapshot, "valueInSol" | "feeX" | "feeY">, snapshot: CollectSnapshot, entryValueSol: number | undefined): number | null {
  return drawdownPct(p, entryValueSol, unclaimedFeesSol(p, snapshot));
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
/**
 * How long a band should sit out of range before moving it is worth the cost.
 *
 * Out of range it earns nothing, so every minute costs the fees it would have made. Moving costs the
 * rent that does not come back plus the swap fees on the token half. Wait until the foregone fees
 * cover the move, and no longer: on a venue where a move costs a dollar that is a minute or two, and
 * a tight band can be re-centred all day. Floors at `minSec` so a pool with no fee estimate still has
 * a brake, and caps at an hour so a dead band is not held forever.
 */
export function moveAfterSec(moveCostUsd: number, feesPerDayUsd: number | null, minSec: number, maxSec = 3600): number {
  if (!feesPerDayUsd || feesPerDayUsd <= 0 || moveCostUsd <= 0) return minSec;
  const perSec = feesPerDayUsd / 86400;
  return Math.min(maxSec, Math.max(minSec, moveCostUsd / perSec));
}

export function antiChurn(
  decision: Decision,
  positions: readonly PositionSnapshot[],
  state: Pick<RiskState, "outOfRangeSince" | "stops" | "entryValueSol" | "askBands">,
  limits: Pick<RiskLimits, "stopLossPct">,
  minSec: number,
  now: number,
  snapshot?: CollectSnapshot,
  /** the shorter wait an all-quote band may be re-laid after (POLICY_IDLE_RELAY_SEC): following the price costs no swap */
  idle?: { sec: number; quoteSide: "X" | "Y" },
  /** the wait an ask band (src/engine/askExit.ts) sits under the price before it follows it down (EXIT_ASK_RELAY_SEC) */
  ask?: { relaySec: number; quoteSide: "X" | "Y" },
): string | null {
  if (decision.action !== "REBALANCE" && decision.action !== "CLOSE_POSITION") return null;
  const p = positions.find((x) => x.address === decision.positionAddress);
  if (!p) return null; // the close-target check reports this
  if (p.inRange) return null;
  const sec = outOfRangeSec(state.outOfRangeSince, p.address, now);
  const quoteSide = ask?.quoteSide ?? idle?.quoteSide ?? "Y";
  const onQuoteSide = quoteSide === "Y" ? p.binsFromRange > 0 : p.binsFromRange < 0;
  // an ask band the price ran up through holds only quote: it sold out, and closing it is the exit's completion, never churn;
  // one the price fell under still holds the token, and follows the price down after its own wait (a close and an open, no sale)
  if (state.askBands?.[p.address]) {
    if (onQuoteSide) return null;
    const relay = Math.max(0, ask?.relaySec ?? 0);
    if (decision.action === "REBALANCE" && sec >= relay) return null;
    if (decision.action === "CLOSE_POSITION") return null; // the chain's end (stop, expiry, kill switch): an exit
    return `anti-churn: ask band ${p.address.slice(0, 6)} is under the price for ${Math.round(sec)}s, it follows the price after ${relay}s`;
  }
  // a band the price ran off on the quote side still holds only quote: re-laying it is a close and an open, no sale, so
  // the idle wait governs it, not the paid-move minimum (18 Sep: the 600 s fallback held TACZ's free re-lays nineteen times).
  // The ask exit of a band the price fell through is the same kind of move (its token goes into an ask, no sale): the ask's wait.
  const idleSide = idle && idle.sec > 0 && onQuoteSide;
  const askMove = decision.action === "REBALANCE" && decision.exitAsk === true && ask && ask.relaySec > 0;
  const minHere = idleSide && decision.action === "REBALANCE" ? Math.min(minSec, idle.sec) : askMove ? Math.min(minSec, ask.relaySec) : minSec;
  if (sec >= minHere) return null;
  const dd = snapshot ? marketDrawdownPct(p, snapshot, stopEntryOf(state, p)) : drawdownPct(p, stopEntryOf(state, p));
  const stop = bandStopPct(state.stops, p.address, limits);
  if (dd !== null && dd >= stop / 2) return null;
  return `anti-churn: ${p.address.slice(0, 6)} is out of range for ${Math.round(sec)}s, minimum ${minHere}s`;
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
/**
 * How far the price actually travelled in the window, high to low, as a percent of the low. This is
 * the pool's own recent volatility measured from what we watched, not a 24h figure: it is what the
 * band has to survive between re-centres. Null when there is not enough history to say.
 */
export function rangeOverWindowPct(history: readonly PriceSample[] | undefined, now: number, windowMs = 60 * 60 * 1000): number | null {
  if (!history || history.length < 2) return null;
  const win = history.filter((h) => now - h.ts <= windowMs && h.price > 0);
  if (win.length < 2) return null;
  const hi = Math.max(...win.map((h) => h.price));
  const lo = Math.min(...win.map((h) => h.price));
  return lo > 0 ? ((hi - lo) / lo) * 100 : null;
}

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
  if (state.launchBands) delete state.launchBands[position];
  if (state.askBands) delete state.askBands[position];
}
