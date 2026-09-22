/**
 * THE POOL MEMORY: how long a pool that just priced him out has to sit before he sits down in it again,
 * and how much of a seat he is willing to put back when he does.
 *
 * The evidence, from the 17-19 Sep real-money run: seats that ended ABOVE the band made +4.311 SOL over
 * 38 closes with 29 winners; seats that went DOWN through the band or hit the stop lost 2.401 SOL over
 * 7 closes with no winners at all. Not one of them came back. The end SIDE separates the book; the band
 * width does not. So the knob is the down side's response, and it is one-directional by construction.
 *
 * WHAT IT MOVES, and only this: a multiple on the seat the sizing rule would already have given (never
 * above 1.0, so it can only ever make a seat smaller), and extra minutes on the sit-out the ranking
 * already keeps (src/screener/seatYield.ts sittingOut, METEORA_STOCK_REENTRY_MIN), capped. It cannot
 * bench a pool, it cannot enlarge a seat, and it touches no limit, stop, cap or breaker: MAX_POSITION_SOL
 * and the exposure caps are the ceiling it multiplies UNDER.
 *
 * IT NEVER READS netSol. -8.479 SOL of SOL/USD drift sits inside the 32 USDC-quoted paper seats, and the
 * worst "loss" in the paper book (AMD/USDC, stopped at -6.014 SOL) was +0.332 SOL ex-drift with the price
 * 48 bins ABOVE the band. A learner that read the money would have learned the wrong lesson from it. It
 * reads why the seat ended, which the drift cannot fake.
 *
 * Everything here is pure, and the window decays: as the 48 hours empty the multiple walks back to 1.0
 * and the extra sit-out to zero on its own, with no second decision.
 */
import type { Lesson } from "./lessons";

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export interface PoolMemoryEnv {
  /** closed seats in the pool and mode before any penalty applies (LEARN_POOL_MIN_SEATS) */
  minSeats: number;
  /** how far back a down exit still counts (LEARN_POOL_WINDOW_H, hours) */
  windowMs: number;
  /** the sit-out the ranking already keeps, which the penalty multiplies (METEORA_STOCK_REENTRY_MIN) */
  baseSitOutMin: number;
  /** the most sit-out the memory may ever ask for (LEARN_POOL_SITOUT_MAX_MIN) */
  sitOutMaxMin: number;
  /** the smallest seat multiple it may ever ask for (LEARN_POOL_MIN_MULTIPLE) */
  minMultiple: number;
}

export function poolMemoryEnv(env: NodeJS.ProcessEnv = process.env): PoolMemoryEnv {
  return {
    minSeats: Math.max(2, Math.floor(num(env.LEARN_POOL_MIN_SEATS, 3))),
    windowMs: Math.max(1, num(env.LEARN_POOL_WINDOW_H, 48)) * 3_600_000,
    baseSitOutMin: Math.max(0, num(env.METEORA_STOCK_REENTRY_MIN, 60)),
    sitOutMaxMin: Math.max(0, num(env.LEARN_POOL_SITOUT_MAX_MIN, 240)),
    minMultiple: Math.min(1, Math.max(0.1, num(env.LEARN_POOL_MIN_MULTIPLE, 0.25))),
  };
}

/** PURE. A seat the price went DOWN through, or the stop took: the side that never came back. */
export const downExit = (l: Lesson): boolean => l.endReason === "through-band" || l.endReason === "stop";

export interface PoolPenalty {
  pool: string;
  /** a multiple on the seat the sizing rule would give, in [minMultiple, 1]: never above 1 */
  sizeMultiple: number;
  /** extra minutes on top of the sit-out the ranking already keeps, 0 when there is nothing to remember */
  sitOutMin: number;
  /** closed seats in this pool and mode inside the window */
  n: number;
  /** down exits among them */
  down: number;
  /** closed seats in this pool and mode, all time: the minimum sample is read on this */
  seen: number;
  /** the evidence sentence, printed verbatim */
  why: string;
}

/**
 * PURE. What this pool has earned the right to, from its own closes. Under the minimum sample nothing
 * happens and the sentence says how far off it is; with the window empty the multiple is 1.0 and the
 * extra sit-out 0, which is exactly today's behaviour.
 */
export function poolPenalty(lessons: readonly Lesson[], pool: string, mode: string, now: number, env: PoolMemoryEnv): PoolPenalty {
  const mine = lessons.filter((l) => l.pool === pool && !l.ask && (l.mode ?? "live") === mode && l.at <= now);
  const none = (why: string, n = 0, down = 0): PoolPenalty => ({ pool, sizeMultiple: 1, sitOutMin: 0, n, down, seen: mine.length, why });
  if (mine.length < env.minSeats) return none(`${mine.length} closed seat${mine.length === 1 ? "" : "s"} here on the ${mode} book, under the ${env.minSeats} the memory needs: full size, no extra wait`);
  const recent = mine.filter((l) => now - l.at <= env.windowMs);
  const downs = recent.filter(downExit);
  const windowH = Math.round(env.windowMs / 3_600_000);
  if (downs.length === 0) return none(`${recent.length} of ${mine.length} closed seats here in the last ${windowH}h, none of them through the bottom or on the stop: full size, no extra wait`, recent.length, 0);
  const hard = downs.length >= 2;
  const sizeMultiple = Math.min(1, Math.max(env.minMultiple, hard ? 0.25 : 0.5));
  const sitOutMin = Math.min(env.sitOutMaxMin, Math.round(env.baseSitOutMin * (hard ? 4 : 2)));
  const last = Math.max(...downs.map((l) => l.at));
  const ago = Math.round((now - last) / 60_000);
  const why = `${downs.length} of the last ${recent.length} seats here went down through the band or hit the stop inside ${windowH}h (${downs.map((l) => `${l.label} ${l.endReason}`).join(", ")}, the last ${ago} min ago): ${sizeMultiple} of the seat and ${sitOutMin} min of sit-out. Down seats have never come back on this book`;
  return { pool, sizeMultiple, sitOutMin, n: recent.length, down: downs.length, seen: mine.length, why };
}

/**
 * PURE. The penalty as a journal row, for the desk to append when it starts applying a new one. A
 * penalty is a read of the window, not a stored number, so the row is the record that it took effect.
 */
export const penaltyChange = (p: PoolPenalty, mode: string, from: number, now: number, windowH: number) => ({
  at: now,
  mode,
  knob: "pool-penalty" as const,
  pool: p.pool,
  from,
  to: p.sizeMultiple,
  why: p.why,
  n: p.n,
  windowH,
});

/* ---------- the end side, which is what separates the book ---------- */

export interface EndSideRow {
  side: "up" | "down" | "other";
  n: number;
  /** SOL, drift taken out where the lesson carries it */
  net: number;
  winners: number;
  feesSol: number;
}

/** PURE. Where a seat ended: off the top, through the bottom (or on the stop), or neither. */
export const endSideOf = (l: Lesson): EndSideRow["side"] => (downExit(l) ? "down" : l.endReason === "idle" ? "up" : "other");

/** PURE. The table the report and the page print: the up side, the down side, and the rest. */
export function endSideTally(lessons: readonly Lesson[]): EndSideRow[] {
  const sides: EndSideRow["side"][] = ["up", "down", "other"];
  return sides.map((side) => {
    const rows = lessons.filter((l) => !l.ask && endSideOf(l) === side);
    const net = rows.reduce((t, l) => t + (typeof l.netSolExDrift === "number" ? l.netSolExDrift : l.netSol), 0);
    return {
      side,
      n: rows.length,
      net: Math.round(net * 1000) / 1000,
      winners: rows.filter((l) => (typeof l.netSolExDrift === "number" ? l.netSolExDrift : l.netSol) > 0).length,
      feesSol: Math.round(rows.reduce((t, l) => t + l.feesSol, 0) * 1000) / 1000,
    };
  });
}
