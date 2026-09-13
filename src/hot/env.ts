/**
 * Hot-watch knobs, read straight from the environment with defaults. src/config.ts is not ours to
 * edit, so this mirrors the screener's venueEnv() pattern: one function, one object, no globals.
 */
export interface HotEnv {
  /** seconds between ticks */
  intervalSec: number;
  /** pools with less liquidity than this are dropped outright */
  minLiquidityUsd: number;
  /** pools younger than this are flagged "new" and kept off the tradable list */
  minAgeHours: number;
  /** a pool crossing this daily fee/TVL pace (with acceleration >= 2) is a surge */
  surgeDailyPct: number;
  /** rows kept in data/hot.json, best heat first */
  maxRows: number;
  /** how many of the screener's top rows get a short-window refresh each tick */
  boardTop: number;
  /** cap on live Meteora fee reads per tick for trending pools off the board */
  onchainReads: number;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function hotEnv(env: NodeJS.ProcessEnv = process.env): HotEnv {
  return {
    intervalSec: num(env.HOT_INTERVAL_SEC, 120),
    minLiquidityUsd: num(env.HOT_MIN_LIQUIDITY_USD, 20_000),
    minAgeHours: num(env.HOT_MIN_AGE_HOURS, 12),
    surgeDailyPct: num(env.HOT_SURGE_DAILY_PCT, 5),
    maxRows: num(env.HOT_MAX_ROWS, 60),
    boardTop: num(env.HOT_BOARD_TOP, 150),
    onchainReads: num(env.HOT_ONCHAIN_READS, 8),
  };
}
