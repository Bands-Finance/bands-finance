/**
 * SUSTAINED HEAT. Pure: takes one pool's rows off the tape (data/hot-history.jsonl, one row every
 * tick), sorted by ts, and says whether the pool has been paying for long enough to be trusted past
 * the memecoin floor's age and market-cap lines.
 *
 * Why it exists. The floor (src/screener/memeFloor.ts) refuses a memecoin under MEME_MIN_AGE_HOURS
 * old or under MEME_MIN_MARKET_CAP_USD, because launch-hour memecoins lost 38.9 SOL on the first
 * paper day (15 Sep). On 23 Sep the desk seated xHYPE/USDC anyway (its cap reads under what the pool
 * holds, so a day of volume stood in) and that one pool made most of the book's profit since; the
 * same days CRACKER/SOL paid fee/TVL over 0.3% an hour on $117k of liquidity for 25 of 48 hours and
 * was refused every cycle at 98h old, as were GP, GROK, FEELSGOOD, SHARTCOIN and SI. Zach (24 Sep):
 * "we need to monitor for entries like this one again since it seems like it has been hot for a
 * couple days now". So: a pool the desk's own tape has watched pay, hour after hour, is admitted on
 * that evidence, with a smaller seat (HOT_SUSTAINED_SEAT) and the ordinary stops.
 *
 * The rule. The trailing HOT_SUSTAINED_WINDOW_HOURS are cut into hour buckets back from now. An hour
 * is HOT when the median fee/TVL of its ticks is at least HOT_SUSTAINED_FEE_PCT an hour AND the
 * median liquidity of its ticks is at least HOT_SUSTAINED_LIQ_USD (the median, so one torn tick
 * neither makes nor breaks an hour, and an hour whose liquidity really sat under the line is not
 * hot: a hot hour on a puddle is not evidence). A pool qualifies with at least HOT_SUSTAINED_HOURS
 * hot hours in the window, gaps allowed (25 of 48 is the shape we saw), on a venue the desk trades,
 * unless its latest tick sold more than HOT_SUSTAINED_MAX_SELL_SHARE of the hour: a pool being
 * dumped right now is not seated on yesterday's fees. HOT_SUSTAINED_HOURS=0 turns it off; the hours
 * are still counted so the row can show them.
 *
 * What the floor adds on top of this verdict (src/screener/memeFloor.ts memeVerdict): the pool's age
 * must be known and at least MEME_SUSTAINED_MIN_AGE_HOURS, and it must not be in collapse. And
 * HOT_SUSTAINED_MODE=shadow (src/hot/env.ts) keeps the count and the log line but admits nothing.
 */
import type { HotHistoryRow } from "./types";

/** the knobs, by their environment names (src/hot/env.ts reads them) */
export const SUSTAINED_ENV = {
  feePct: "HOT_SUSTAINED_FEE_PCT",
  liqUsd: "HOT_SUSTAINED_LIQ_USD",
  hours: "HOT_SUSTAINED_HOURS",
  windowHours: "HOT_SUSTAINED_WINDOW_HOURS",
  maxSellShare: "HOT_SUSTAINED_MAX_SELL_SHARE",
  seat: "HOT_SUSTAINED_SEAT",
  mode: "HOT_SUSTAINED_MODE",
  /** read by the memecoin floor, not the hot watch: the youngest a pool may be and still be seated on its tape */
  minAgeHours: "MEME_SUSTAINED_MIN_AGE_HOURS",
} as const;

export const SUSTAINED_HOUR_MS = 3600e3;

export interface SustainedEnv {
  sustainedFeePct: number;
  sustainedLiqUsd: number;
  sustainedHours: number;
  sustainedWindowHours: number;
  sustainedMaxSellShare: number;
}

export interface SustainedVerdict {
  /** hot hours inside the window */
  hours: number;
  qualifies: boolean;
  /** the verdict in plain words, with the numbers */
  note: string;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const fmtUsd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`);

/**
 * PURE. The hour buckets of the window, oldest first: each hour's median fee/TVL and median liquidity
 * over the ticks that reported both, or null for an hour the tape has no such tick in.
 */
export function hourBuckets(rows: readonly HotHistoryRow[], now: number, windowHours: number): Array<{ feePct: number; liquidityUsd: number } | null> {
  const fees: number[][] = Array.from({ length: windowHours }, () => []);
  const liqs: number[][] = Array.from({ length: windowHours }, () => []);
  for (const r of rows) {
    if (r.ts > now || r.feeToTvl1hPct === null || r.liquidityUsd === null) continue;
    const i = Math.floor((now - r.ts) / SUSTAINED_HOUR_MS);
    if (i < 0 || i >= windowHours) continue;
    fees[i].push(r.feeToTvl1hPct);
    liqs[i].push(r.liquidityUsd);
  }
  return fees.map((f, i) => (f.length ? { feePct: median(f), liquidityUsd: median(liqs[i]) } : null)).reverse();
}

/** PURE. Sustained heat for one pool: `rows` are its tape rows, `tradable` whether its venue is one the desk trades. */
export function sustainedHeat(rows: readonly HotHistoryRow[], now: number, env: SustainedEnv, tradable = true): SustainedVerdict {
  const windowHours = Math.max(1, Math.floor(env.sustainedWindowHours));
  const buckets = hourBuckets(rows, now, windowHours);
  const hot = buckets.filter((b) => b !== null && b.feePct >= env.sustainedFeePct && b.liquidityUsd >= env.sustainedLiqUsd);
  const hours = hot.length;
  const line = `fee/TVL >= ${env.sustainedFeePct}%/h on >= ${fmtUsd(env.sustainedLiqUsd)}`;
  const tally = `hot ${hours} of the last ${windowHours}h (${line}${hours ? `, median ${median(hot.map((b) => b!.feePct)).toFixed(2)}%/h over them` : ""})`;
  if (env.sustainedHours <= 0) return { hours, qualifies: false, note: `${tally}; sustained heat is off (${SUSTAINED_ENV.hours}=0)` };
  if (hours < env.sustainedHours) return { hours, qualifies: false, note: `${tally}, under the ${env.sustainedHours} the desk wants` };
  if (!tradable) return { hours, qualifies: false, note: `${tally}, but not on a venue the desk trades` };
  let latest: HotHistoryRow | null = null;
  for (const r of rows) if (r.ts <= now && (!latest || r.ts > latest.ts)) latest = r;
  const sells = latest?.sellShare1h ?? null;
  if (sells !== null && sells > env.sustainedMaxSellShare) {
    return { hours, qualifies: false, note: `${tally}, but sells were ${(sells * 100).toFixed(0)}% of the last hour, over the ${(env.sustainedMaxSellShare * 100).toFixed(0)}% it may be while being seated` };
  }
  return { hours, qualifies: true, note: `${tally}${sells !== null ? `; sells ${(sells * 100).toFixed(0)}% of the last hour` : ""}` };
}
