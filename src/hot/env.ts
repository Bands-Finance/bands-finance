/**
 * Hot-watch knobs, read straight from the environment with defaults. src/config.ts is not ours to
 * edit, so this mirrors the screener's venueEnv() pattern: one function, one object, no globals.
 */
export interface HotEnv {
  /** seconds between ticks */
  intervalSec: number;
  /** HOT_GECKOTERMINAL: read GeckoTerminal's trending, PumpSwap and sibling lists (off: slow and rate-limited; DexScreener and the board stand) */
  geckoterminal: boolean;
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
  /** a token whose trending pool traded less than this in 24h is not worth a sibling lookup */
  siblingMinVol24hUsd: number;
  /** cap on GeckoTerminal token-pool lookups per tick */
  siblingLookups: number;
  /** how long a token's sibling list is good for, in minutes */
  siblingTtlMin: number;
  /** pages of GeckoTerminal's top PumpSwap pools (20 rows each) read per tick; 0 turns the source off */
  pumpswapPages: number;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function hotEnv(env: NodeJS.ProcessEnv = process.env): HotEnv {
  return {
    intervalSec: num(env.HOT_INTERVAL_SEC, 120),
    geckoterminal: (env.HOT_GECKOTERMINAL ?? "").trim().toLowerCase() === "true",
    minLiquidityUsd: num(env.HOT_MIN_LIQUIDITY_USD, 20_000),
    minAgeHours: num(env.HOT_MIN_AGE_HOURS, 12),
    surgeDailyPct: num(env.HOT_SURGE_DAILY_PCT, 5),
    maxRows: num(env.HOT_MAX_ROWS, 60),
    boardTop: num(env.HOT_BOARD_TOP, 150),
    onchainReads: num(env.HOT_ONCHAIN_READS, 8),
    siblingMinVol24hUsd: num(env.HOT_SIBLING_MIN_VOL_24H_USD, 500_000),
    siblingLookups: num(env.HOT_SIBLING_LOOKUPS, 6),
    siblingTtlMin: num(env.HOT_SIBLING_TTL_MIN, 30),
    pumpswapPages: Math.max(0, Math.floor(num(env.HOT_PUMPSWAP_PAGES, 1))),
  };
}
