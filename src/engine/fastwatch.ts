/**
 * THE FAST WATCH. The desk decides once a cycle (300 s); a memecoin moves 6% in six minutes and, on
 * paper day one, 86% inside one interval. The flow scout already knows the pool's last traded bin every
 * five seconds (DATA_DIR/flow.json). Between cycles the loop reads that file every FAST_WATCH_SEC and,
 * when a held band's price has LEFT the band or is NEAR ITS STOP, starts the next cycle at once. The
 * watch never trades: the early cycle observes the chain and goes through the same directives, policy
 * and guards as any other. Pure here; the loop owns the file read and the pacing.
 */

export interface WatchedBand {
  pool: string;
  label: string;
  position: string;
  lowerBinId: number;
  upperBinId: number;
  /** which side of the pool is the quote: a quote-only band on Y sits from the price down, on X from the price up */
  quoteSide: "X" | "Y";
  binStep: number;
  /** in range at the cycle that last observed it */
  inRange: boolean;
  /** the band's stop, percent below entry */
  stopPct: number;
  /** drawdown already on the book at the last mark, percent of entry (negative when up) */
  drawdownPct: number;
  /** epoch ms the band was first seen out of range (state.outOfRangeSince), null when in range */
  outSince?: number | null;
  /** the idle re-lay wait the policy applies to it, seconds (POLICY_IDLE_RELAY_SEC) */
  idleWaitSec?: number;
  /** epoch ms of the cycle that last observed it: a wake-up is owed only for a wait that ran out since */
  observedAt?: number;
}

export interface FastReading {
  /** the bin of the pool's last swap, as the scout read it */
  bin: number | null;
  /** epoch ms the scout wrote the reading */
  asOf: number;
}

export interface FastEnv {
  /** FAST_WATCH_SEC: how often the loop looks between cycles (0 = off) */
  everySec: number;
  /** FAST_MIN_GAP_SEC: the least time between two early cycles */
  minGapSec: number;
  /** FAST_MAX_PER_HOUR: early cycles an hour, at most */
  maxPerHour: number;
  /** FAST_STOP_NEAR: the share of the stop at which the watch wakes the cycle (0.85 = at 85% of the way to it) */
  stopNear: number;
  /** FAST_STALE_SEC: a reading older than this is no reading */
  staleSec: number;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function fastEnv(env: NodeJS.ProcessEnv = process.env): FastEnv {
  return {
    everySec: Math.max(0, num(env.FAST_WATCH_SEC, 15)),
    minGapSec: Math.max(10, num(env.FAST_MIN_GAP_SEC, 90)),
    maxPerHour: Math.max(0, Math.floor(num(env.FAST_MAX_PER_HOUR, 12))),
    stopNear: Math.min(1, Math.max(0.1, num(env.FAST_STOP_NEAR, 0.85))),
    staleSec: Math.max(5, num(env.FAST_STALE_SEC, 60)),
  };
}

export interface FastTrigger {
  pool: string;
  label: string;
  kind: "left-band" | "stop-near" | "idle-due";
  detail: string;
}

/**
 * PURE. Whether this band's reading should start a cycle now.
 *  - left-band: it was in range when last observed and the last swap is outside it (the out-of-range
 *    clock, the idle re-lay and the through-band rule all start from the cycle that first sees it).
 *  - stop-near: the price is through the band on the token side and the loss since the band's middle
 *    (where a one-sided band's fills average) plus what was already on the book is within FAST_STOP_NEAR
 *    of the stop.
 */
export function fastTrigger(b: WatchedBand, reading: FastReading | null, now: number, env: FastEnv): FastTrigger | null {
  if (!reading || reading.bin === null || now - reading.asOf > env.staleSec * 1000) return null;
  const bin = reading.bin;
  const outside = bin < b.lowerBinId || bin > b.upperBinId;
  // the token side of a quote-only band: below it when the quote is Y, above it when the quote is X
  const throughTokenSide = b.quoteSide === "Y" ? bin < b.lowerBinId : bin > b.upperBinId;
  if (throughTokenSide) {
    const mid = (b.lowerBinId + b.upperBinId) / 2;
    const binsPast = b.quoteSide === "Y" ? mid - bin : bin - mid;
    const lossPct = (1 - Math.pow(1 + b.binStep / 10_000, -binsPast)) * 100;
    const total = Math.max(lossPct, b.drawdownPct);
    if (total >= b.stopPct * env.stopNear) {
      return { pool: b.pool, label: b.label, kind: "stop-near", detail: `the last swap is at bin ${bin}, ${Math.round(binsPast)} bins past the middle of band [${b.lowerBinId}, ${b.upperBinId}]: about ${total.toFixed(1)}% down against a ${b.stopPct.toFixed(1)}% stop` };
    }
  }
  if (b.inRange && outside) {
    return { pool: b.pool, label: b.label, kind: "left-band", detail: `the last swap is at bin ${bin}, outside band [${b.lowerBinId}, ${b.upperBinId}] that was in range at the last cycle` };
  }
  // the idle wait ran out since the last cycle: the re-lay is due now, not at the next scheduled cycle
  if (!b.inRange && outside && !throughTokenSide && b.outSince && b.idleWaitSec && b.idleWaitSec > 0) {
    const due = b.outSince + b.idleWaitSec * 1000;
    if (now >= due && (b.observedAt ?? 0) < due) {
      return { pool: b.pool, label: b.label, kind: "idle-due", detail: `idle ${Math.round((now - b.outSince) / 1000)}s ${b.quoteSide === "Y" ? "above" : "below"} band [${b.lowerBinId}, ${b.upperBinId}], past the ${b.idleWaitSec}s wait: the re-lay is due` };
    }
  }
  return null;
}

/** PURE. Whether another early cycle is allowed now, given the ones already taken (epoch ms, any order). */
export function earlyCycleAllowed(taken: readonly number[], now: number, env: FastEnv): boolean {
  if (env.everySec <= 0 || env.maxPerHour <= 0) return false;
  const lastHour = taken.filter((t) => now - t < 3_600_000);
  if (lastHour.length >= env.maxPerHour) return false;
  const last = lastHour.length ? Math.max(...lastHour) : 0;
  return now - last >= env.minGapSec * 1000;
}
