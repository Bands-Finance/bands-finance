/**
 * The exit ladder, pure. Port of the rails in Meridian's agent/src/memeGuard.ts:
 *   - rollStop: a per-band stop percent jittered inside [0.8, 1.0] x the configured limit so
 *     nobody can front-run the exact level (Meridian's stopLinePct); persisted at open in
 *     state.stops[position] and used in place of the global number wherever present.
 *   - out-of-range persistence: a band must sit out of range for ENGINE_OUT_OF_RANGE_SEC before
 *     the LLM may move it (Meridian's OUT_OF_RANGE_MIN_MS), unless it is already down half its stop.
 *   - knife: a drop over the trailing 30 min past ENGINE_KNIFE_PCT blocks opens in that pool
 *     (Meridian's knife gate on tick drift); so does a drop since the last cycle past
 *     ENGINE_CYCLE_KNIFE_PCT, and a slow one past ENGINE_SLOW_KNIFE_PCT over ENGINE_SLOW_KNIFE_MIN.
 * The global cooldown between actions stays in the guards (minSecondsBetweenActions).
 * Nothing here touches the disk or the network; the loop persists the state it returns.
 */
import type { Decision } from "../agent/schema";
import type { RiskLimits } from "../risk/limits";
import type { PriceSample, RiskState } from "../risk/state";
import type { PoolSnapshot, PositionSnapshot } from "../tools/dlmm";
import { binWalkImpactPct } from "../paper/impact";
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
 * Out of range it earns nothing, so every minute costs the fees it would have made. Moving costs what
 * waiting could save (poolMoveCostSol): the rent a re-lay leaves behind, and, where ENGINE_WAIT_COUNTS_SALE
 * says so, the sale of the token a band the price went through holds. Wait until the foregone fees cover
 * the move, and no longer: on a venue where a move costs a dollar that is a minute or two, and a tight
 * band can be re-centred all day. Floors at `minSec` so a pool with no fee estimate still has a brake, and
 * caps at an hour so a dead band is not held forever.
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

/**
 * The drop since the pool's price one cycle ago, in percent (positive = fell): the latest sample against the
 * oldest one taken inside 1.5 cycles before it. Null when there is no such sample: a pool the desk has not
 * watched in the last cycle or so (a pick coming back after a sit-out, a restart) has no "last cycle", and a
 * reference hours old is the slower knives' question, not this one.
 */
export function cycleDropPct(history: readonly PriceSample[] | undefined, cycleMs: number): number | null {
  if (!history || history.length < 2 || !(cycleMs > 0)) return null;
  const sorted = [...history].sort((a, b) => a.ts - b.ts);
  const latest = sorted[sorted.length - 1];
  const ref = sorted.find((s) => s !== latest && s.ts < latest.ts && latest.ts - s.ts <= cycleMs * 1.5);
  if (!ref || !(ref.price > 0)) return null;
  return (1 - latest.price / ref.price) * 100;
}

/** The knives in force (ENGINE_KNIFE_PCT and the two below it); 0 turns the per-cycle or the slow one off. */
export interface KnifeEnv {
  /** ENGINE_KNIFE_PCT over the trailing 30 min */
  knifePct: number;
  /** ENGINE_CYCLE_KNIFE_PCT: the drop since the last cycle that refuses an open (0 = off) */
  cycleKnifePct: number;
  /** the cycle the per-cycle knife reads, ms (CYCLE_INTERVAL_SEC) */
  cycleMs: number;
  /** ENGINE_SLOW_KNIFE_PCT over ENGINE_SLOW_KNIFE_MIN: a bleed, not a crash (0 = off) */
  slowKnifePct: number;
  slowKnifeMs: number;
}

/**
 * The knife reason for a pool, or null, from the three knives in the order they are read:
 *   - the 30-minute knife (ENGINE_KNIFE_PCT): a crash;
 *   - the PER-CYCLE knife (ENGINE_CYCLE_KNIFE_PCT): the last cycle alone fell that far. A flash crash of -40%
 *     in ten minutes read -19.9% at the cycle halfway down it, under the 20% the 30-minute knife wants, and the
 *     desk opened its biggest seat there;
 *   - the SLOW knife (ENGINE_SLOW_KNIFE_PCT over ENGINE_SLOW_KNIFE_MIN): a bleed. -5% an hour never trips a
 *     30-minute knife, and the desk re-laid a full seat into it every hour until the circuit breaker stopped it.
 * Every one of them only refuses opens and re-lays; exits never read a knife as a reason to stay.
 */
export function knivesReason(history: readonly PriceSample[] | undefined, now: number, env: KnifeEnv): string | null {
  const crash = knifeReason(history, now, env.knifePct);
  if (crash) return crash;
  if (env.cycleKnifePct > 0) {
    const drop = cycleDropPct(history, env.cycleMs);
    if (drop !== null && drop > env.cycleKnifePct) return `knife: -${drop.toFixed(1)}% since the last cycle (limit ${env.cycleKnifePct}% a cycle)`;
  }
  if (env.slowKnifePct > 0 && env.slowKnifeMs > 0) return knifeReason(history, now, env.slowKnifePct, env.slowKnifeMs);
  return null;
}

/**
 * How far the price travelled in the window BEFORE this cycle's sample: the same range as rangeOverWindowPct
 * over every sample but the latest. The difference between the two is the part of the hour's travel the last
 * move made on its own, which widens a band and must not also grow its seat (src/agent/policy.ts sizeBand).
 */
export function priorRangeOverWindowPct(history: readonly PriceSample[] | undefined, now: number, windowMs = 60 * 60 * 1000): number | null {
  if (!history || history.length < 3) return null;
  const sorted = [...history].sort((a, b) => a.ts - b.ts);
  return rangeOverWindowPct(sorted.slice(0, -1), now, windowMs);
}

/**
 * PURE. Whether a close ended its seat on the DOWN side, and how: the stop (a STOP directive or the guards'
 * stop-loss override), or a plain close of a quote-only band the price went THROUGH (it holds the token now)
 * at a loss against what went in. A down exit counts on the bench ladder beside a stop (src/engine/breakers.ts)
 * and starts the pool's sit-out (RiskState.rotatedOutAt), which is the wait the learner stretches for a pool
 * that keeps ending this way (src/desk/learning.ts reentryMinFor). A slow bleed never stops a band: it runs
 * through it an hour at a time, and until 22 Sep neither the bench nor the sit-out ever heard of it.
 *
 * Not a down exit: an ask exit (the chain is still working the token; its own end is judged there), a
 * re-lay, a straddle or a pool of our own (the quote-only rule is about bid bands; a straddle's re-centre and
 * its hedge are the stock lane's), and a close that did not lose.
 */
export function downExitOf(i: {
  /** the close landed this cycle */
  closed: boolean;
  /** a STOP directive, or the guards overrode the proposal with the stop-loss close */
  stopped: boolean;
  action: Decision["action"];
  exitAsk?: boolean;
  /** the closed band as observed this cycle, with its entry */
  band: Pick<PositionSnapshot, "inRange" | "binsFromRange" | "valueInSol" | "entryValueSol"> | null | undefined;
  quoteSide: "X" | "Y";
  /** a quote-only bid band's pool (not a stock, a basis pool or a pair of ours) */
  quoteOnly: boolean;
}): "stop" | "through-band" | null {
  if (!i.closed || i.exitAsk) return null;
  if (i.stopped) return "stop";
  if (!i.quoteOnly || i.action !== "CLOSE_POSITION" || !i.band || i.band.inRange) return null;
  const through = i.quoteSide === "Y" ? i.band.binsFromRange < 0 : i.band.binsFromRange > 0;
  const entry = i.band.entryValueSol;
  return through && typeof entry === "number" && entry > 0 && i.band.valueInSol < entry ? "through-band" : null;
}

/** Drop the per-band bookkeeping of a band that no longer exists. */
export function forgetBand(state: RiskState, position: string): void {
  delete state.entryValueSol[position];
  if (state.stops) delete state.stops[position];
  if (state.outOfRangeSince) delete state.outOfRangeSince[position];
  if (state.feesPendingSince) delete state.feesPendingSince[position];
  if (state.launchBands) delete state.launchBands[position];
  if (state.askBands) delete state.askBands[position];
  if (state.proposalBands) delete state.proposalBands[position];
  if (state.hotHeldAt) delete state.hotHeldAt[position];
}

/**
 * PURE. WHAT LEAVING A BAND COSTS, SOL: the sale of the token it holds (its token and token fees, at the
 * sale's fee plus the price impact of walking the pool's bins with it) and the rent a fresh band of the same
 * width at the price would leave behind (the venue's open cost less what comes back on close).
 */
export function bandMoveCostSol(i: {
  /** the token the band would hand back and the close would sell, in token units */
  tokenUi: number;
  tokenPriceInSol: number;
  /** the sale's fee, percent */
  feePct: number;
  /** the sale's price impact, percent */
  impactPct: number;
  /** the rent the re-lay leaves behind, SOL */
  relaySunkSol: number;
}): { saleSol: number; relaySol: number; totalSol: number } {
  const tokenSol = Math.max(0, i.tokenUi) * Math.max(0, i.tokenPriceInSol);
  const pct = Math.max(0, i.feePct) + Math.max(0, i.impactPct);
  const saleSol = Number.isFinite(tokenSol * pct) ? (tokenSol * pct) / 100 : 0;
  const relaySol = Number.isFinite(i.relaySunkSol) ? Math.max(0, i.relaySunkSol) : 0;
  return { saleSol, relaySol, totalSol: saleSol + relaySol };
}

/**
 * PURE. WHAT WAITING CAN SAVE, SOL: the cost the out-of-range wait (moveAfterSec) weighs the missed fees against,
 * for the costliest band in a pool. It used to read the venue's bare open cost alone, the active bin's array, which
 * on a Meteora pool whose arrays exist is 0: every move waited the 120 s floor whatever it cost.
 *
 *   - a band the price ran off on its QUOTE side (all quote) waits for its re-lay: the rent a fresh band of its own
 *     width, laid from the price, leaves behind (`relaySunkSol`). If the price comes back, that rent is never paid.
 *   - a quote-only band the price went THROUGH (all token) is sold on the way out and re-laid lower. Its sale and its
 *     re-lay are paid whenever it leaves, unless the price comes back, and waiting holds the token's price risk,
 *     which this arithmetic cannot see. Counted in full (the sale plus the re-lay) only under ENGINE_WAIT_COUNTS_SALE
 *     (`countSale`). The scenario harness ran it both ways on 22 Sep: counting the sale held such bands to the
 *     hour's cap and cost 17 to 19.5 SOL over three seeds of each wide chop and 1.1 to 2.6 of each bleed and
 *     downtrend, for 3.6 gained in a tight chop; and of the 9 bands the books closed through their range whose pool
 *     was read again within the hour, 8 never came back into range in it. Off, it keeps the bare rent, as before.
 *   - a straddle's pool, or a pool of our own (`quoteOnly` false), keeps the bare rent: a straddle prices its own
 *     re-centre swap in the policy (recentreCost), and nobody else trades a pool of ours.
 */
export function poolMoveCostSol(
  positions: readonly Pick<PositionSnapshot, "lowerBinId" | "upperBinId" | "inRange" | "binsFromRange" | "amountX" | "amountY" | "feeX" | "feeY">[],
  s: Pick<PoolSnapshot, "bins" | "activeBinId" | "binStep" | "tokenPriceInSol">,
  o: { quoteSide: "X" | "Y"; tokenPriceInQuote: number; quoteOnly: boolean; countSale: boolean; feePct: number; impactCapPct: number; rentOnlySol: number; relaySunkSol: (binsBelowActive: number, binsAboveActive: number) => number },
): number {
  const rentOnly = Math.max(0, o.rentOnlySol);
  if (!o.quoteOnly) return rentOnly;
  return positions.reduce((worst, p) => {
    const width = Math.max(0, p.upperBinId - p.lowerBinId);
    let relaySunkSol = rentOnly;
    try {
      relaySunkSol = o.relaySunkSol(o.quoteSide === "Y" ? width : 0, o.quoteSide === "Y" ? 0 : width);
    } catch {
      /* a plan the venue cannot cost keeps the bare estimate */
    }
    const through = !p.inRange && (o.quoteSide === "Y" ? p.binsFromRange < 0 : p.binsFromRange > 0);
    if (!through) return Math.max(worst, relaySunkSol);
    if (!o.countSale) return Math.max(worst, rentOnly);
    const tokenUi = o.quoteSide === "X" ? p.amountY + p.feeY : p.amountX + p.feeX;
    const impactPct = tokenUi > 0 ? Math.min(o.impactCapPct, binWalkImpactPct({ bins: s.bins ?? [], activeBinId: s.activeBinId, quoteSide: o.quoteSide, binStepBps: s.binStep, tokenPriceInQuote: o.tokenPriceInQuote }, "sell", tokenUi)) : 0;
    return Math.max(worst, bandMoveCostSol({ tokenUi, tokenPriceInSol: s.tokenPriceInSol, feePct: tokenUi > 0 ? o.feePct : 0, impactPct, relaySunkSol }).totalSol);
  }, rentOnly);
}
