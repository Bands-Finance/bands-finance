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
  /** SUSTAINED HEAT (src/hot/sustained.ts): an hour counts as hot when the pool's fee/TVL was at least this, percent an hour */
  sustainedFeePct: number;
  /** ... on at least this much liquidity, USD: a hot hour on a puddle is not evidence */
  sustainedLiqUsd: number;
  /** hot hours inside the window needed to qualify; 0 turns the exemption off */
  sustainedHours: number;
  /** the trailing window the hot hours are counted in, hours */
  sustainedWindowHours: number;
  /** a pool selling harder than this share of its last hour does not qualify, whatever the tape says */
  sustainedMaxSellShare: number;
  /** the seat a pool admitted on sustained heat gets, as a multiple of the seat it would otherwise get (0.5 = half); 0.1 to 1, since 0 is no seat, not a smaller one */
  sustainedSeat: number;
  /**
   * HOT_SUSTAINED_MODE: "on" admits qualifying pools past the memecoin floor; "shadow" counts the hours and logs the
   * SUSTAINED line with "(shadow: would be admitted)" but admits nothing, so the rule can be watched on the live tape
   * before it seats a coin. Anything but the literal "shadow" is on.
   */
  sustainedMode: "shadow" | "on";
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
    sustainedFeePct: num(env.HOT_SUSTAINED_FEE_PCT, 0.3),
    sustainedLiqUsd: num(env.HOT_SUSTAINED_LIQ_USD, 100_000),
    sustainedHours: Math.max(0, num(env.HOT_SUSTAINED_HOURS, 12)),
    sustainedWindowHours: Math.max(1, num(env.HOT_SUSTAINED_WINDOW_HOURS, 16)),
    sustainedMaxSellShare: num(env.HOT_SUSTAINED_MAX_SELL_SHARE, 0.9),
    sustainedSeat: Math.min(1, Math.max(0.1, num(env.HOT_SUSTAINED_SEAT, 0.5))),
    sustainedMode: (env.HOT_SUSTAINED_MODE ?? "").trim().toLowerCase() === "shadow" ? "shadow" : "on",
  };
}
