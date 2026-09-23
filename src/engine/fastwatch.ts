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
  /**
   * an ASK band (src/engine/askExit.ts): all token when the price is under it, so its loss since the last
   * mark is the price's own move from `markBinId` (the active bin at that mark), on top of `drawdownPct`;
   * sold out when the price is over it, which is worth a cycle at once
   */
  ask?: boolean;
  /** the active bin at the cycle that last observed it (an ask band's loss is measured from here) */
  markBinId?: number;
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
  kind: "left-band" | "stop-near" | "idle-due" | "ask-sold";
  detail: string;
}

/**
 * PURE. Whether this band's reading should start a cycle now.
 *  - left-band: it was in range when last observed and the last swap is outside it (the out-of-range
 *    clock, the idle re-lay and the through-band rule all start from the cycle that first sees it).
 *  - stop-near: the price is through the band on the token side and the loss since the band's middle
 *    (where a one-sided band's fills average) plus what was already on the book is within FAST_STOP_NEAR
 *    of the stop. An ASK band is all token under the price: its loss is the price's move from the bin it
 *    was last marked at, compounded on the drawdown that mark already showed against the chain's basis.
 *  - ask-sold: the price is over an ask band: it sold out, and the SOL is booked at the next cycle, now.
 */
export function fastTrigger(b: WatchedBand, reading: FastReading | null, now: number, env: FastEnv): FastTrigger | null {
  if (!reading || reading.bin === null || now - reading.asOf > env.staleSec * 1000) return null;
  const bin = reading.bin;
  const outside = bin < b.lowerBinId || bin > b.upperBinId;
  // the token side of a quote-only band: below it when the quote is Y, above it when the quote is X
  const throughTokenSide = b.quoteSide === "Y" ? bin < b.lowerBinId : bin > b.upperBinId;
  if (b.ask) {
    // under the ask: all token; what the price did since the last mark, on top of what that mark already showed
    if (throughTokenSide) {
      const from = b.markBinId ?? (b.quoteSide === "Y" ? b.lowerBinId : b.upperBinId);
      const binsDown = b.quoteSide === "Y" ? from - bin : bin - from;
      const moveFactor = binsDown > 0 ? Math.pow(1 + b.binStep / 10_000, -binsDown) : 1;
      const total = (1 - (1 - Math.max(0, b.drawdownPct) / 100) * moveFactor) * 100;
      if (total >= b.stopPct * env.stopNear) {
        return { pool: b.pool, label: b.label, kind: "stop-near", detail: `the last swap is at bin ${bin}, ${Math.max(0, Math.round(binsDown))} bins under the ask's last mark at bin ${from}: about ${total.toFixed(1)}% down against the chain's ${b.stopPct.toFixed(1)}% stop` };
      }
      return null;
    }
    // over the ask: sold out, and a sold-out ask left alone is a bid nobody chose. Owed once: a cycle that already
    // saw it sold (the mark's bin over the band) has decided on it, and is not woken again for the same reading.
    const seenSold = b.markBinId !== undefined && (b.quoteSide === "Y" ? b.markBinId > b.upperBinId : b.markBinId < b.lowerBinId);
    if (outside && !seenSold) {
      return { pool: b.pool, label: b.label, kind: "ask-sold", detail: `the last swap is at bin ${bin}, ${b.quoteSide === "Y" ? "over" : "under"} ask band [${b.lowerBinId}, ${b.upperBinId}]: it sold out; booking the ${b.quoteSide === "Y" ? "SOL" : "quote"} now` };
    }
    return null;
  }
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

/** A band laid this cycle, as the execution and the decision describe it. */
export interface LaidBand {
  pool: string;
  label: string;
  /** the position the open made */
  position: string;
  /** the active bin the band was laid from, and the open's reach either side of it */
  activeBinId: number;
  binsBelowActive: number;
  binsAboveActive: number;
  quoteSide: "X" | "Y";
  binStep: number;
  /** the band's rolled stop, percent (state.stops, written as the open landed) */
  stopPct: number;
  /** what went in, SOL (the open's entry value) */
  entrySol: number;
  /** an ask band: the chain's basis its stop reads (src/engine/askExit.ts); absent for a bid band or a straddle */
  askBasisSol?: number | null;
  idleWaitSec: number;
  now: number;
}

/**
 * PURE. A band laid THIS cycle (an open, a re-lay, an ask), watched from the open's own geometry until the next
 * cycle observes it. The watch list is built from the positions the cycle observed at its start, so a band opened
 * or re-laid in it used to be unwatched for a whole interval, exactly the minutes that matter most: a flash crash
 * stopped a fresh band at 23.8% against a 13.9% stop, and TACZ's re-laid band sat 356 s unwatched on 18 Sep while
 * the price went four bins through its bottom. Laid at the price it is in range; a bid band has lost nothing yet,
 * an ask band carries the chain's drawdown against its basis.
 */
export function laidBandWatch(l: LaidBand): WatchedBand {
  const drawdownPct = l.askBasisSol && l.askBasisSol > 0 ? (1 - l.entrySol / l.askBasisSol) * 100 : 0;
  return {
    pool: l.pool,
    label: l.label,
    position: l.position,
    lowerBinId: l.activeBinId - Math.max(0, l.binsBelowActive),
    upperBinId: l.activeBinId + Math.max(0, l.binsAboveActive),
    quoteSide: l.quoteSide,
    binStep: l.binStep,
    inRange: true,
    stopPct: l.stopPct,
    drawdownPct,
    outSince: null,
    idleWaitSec: l.idleWaitSec,
    observedAt: l.now,
    ...(l.askBasisSol !== undefined && l.askBasisSol !== null ? { ask: true, markBinId: l.activeBinId } : {}),
  };
}
