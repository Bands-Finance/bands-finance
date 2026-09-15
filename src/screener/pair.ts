/**
 * The PAIR LANE: the desk does not only seat in other people's pools. For a pump.fun token that
 * meets OUR criteria it makes a pool of its own on Meteora DLMM and seats its liquidity there.
 *
 * WHY IT CAN WORK. After graduation a pump.fun token trades on PumpSwap, a constant-product AMM,
 * in a TOKEN/SOL pool. A constant-product pool spreads its depth over every price: a $50k pool
 * offers about $250 of depth per 1% of price move. A few thousand dollars concentrated in 1% bins
 * at the current price is far deeper IN RANGE, and routers (Jupiter) split every swap across pools
 * by execution cost, so a small concentrated pool becomes the cheaper route for most trade sizes
 * even at a higher fee. Fees on Meteora go to whoever holds liquidity in the active bin: a pool
 * that is entirely ours pays us everything it earns.
 *
 * WHY IT CAN FAIL. pump.fun tokens dump, and whoever holds the concentrated liquidity absorbs the
 * sells first. So the lane inherits the launch lane's harsher terms (a capped seat, a tighter stop,
 * a maximum hold, the volume-fade EXPIRE) and works one pool at a time.
 *
 * THE RULES, in order, every refusal naming the number that failed:
 *   PAIR_LANE on; origin pump.fun; the reference pool is on PumpSwap (graduated, not the bonding
 *   curve) and quoted in SOL or USDC; age inside [PAIR_MIN_AGE_MIN, PAIR_MAX_AGE_HOURS]; reference
 *   liquidity >= PAIR_MIN_REF_LIQUIDITY_USD; 24h volume >= PAIR_MIN_VOLUME_24H_USD; last hour >=
 *   PAIR_MIN_VOLUME_1H_USD; turnover >= PAIR_MIN_TURNOVER; not being dumped (the launch lane's
 *   rule); a reference price to open at. A watchlist DENY wins; at most PAIR_MAX_POOLS of ours open.
 *
 * THE HOUSE TOKEN. Zach's own launch (the AnsemHack Clawrena entry, a token launched on ClawPump,
 * which launches on pump.fun) is a mint on PAIR_HOUSE_MINTS: ALWAYS admitted by this lane whatever
 * its age, volume or liquidity (only an explicit watchlist DENY refuses it), seated at
 * PAIR_HOUSE_SEAT_PCT of the book, never counted against PAIR_MAX_POOLS, and carrying NONE of the
 * launch-style exits (no maximum hold, no volume-fade EXPIRE: it is our own token and the pool
 * stays up; the ordinary stop and the re-centre apply). Its reference for the model is whatever row
 * the hot watch or the board has for the mint (the bonding curve, PumpSwap, anything); with none,
 * the pool is still made once a price is known and the model reports share n/a (nothing accrues on
 * paper until a reference exists).
 *
 * OTHER POOLS ARE NOT A REFUSAL. Zach: "we simply need to supplement additional liquidity
 * ourselves." A token that clears the criteria gets our liquidity whatever else exists. What
 * exists still matters twice: (1) Meteora derives a customizable-permissionless pool's address from
 * the token pair ALONE, so if one already exists for TOKEN/quote the desk seats in it instead of
 * creating (src/venues/pair.ts); (2) competing concentrated depth (existing Meteora / Raydium /
 * Orca SOL- or USDC-quoted pools for the mint) splits the flow that leaves PumpSwap with us in
 * proportion to depth, which the routing model below applies to the fee estimate.
 *
 * THE ROUTING MODEL (a MODEL, not a measurement). For a trade of size D the all-in cost is
 *   ours   = our fee + the walk across our bins: binStep/2 x (D / depth per bin), in percent,
 *            and beyond our total depth we cannot fill at all
 *   theirs = PUMPSWAP_FEE_PCT + 2D/L  (constant product, small-trade approximation, L = their liquidity)
 * routedShare integrates "ours is cheaper" over a log-uniform trade-size distribution on
 * [PAIR_TRADE_MIN_USD, PAIR_TRADE_MAX_USD], value-weighted, and then splits that share with the
 * competing concentrated depth by depth. Fees per day for our pool = min(vol24h, vol1h x 24) x
 * routedShare x our fee; the paper book accrues them with the same in-range factor as every other
 * band (src/paper/mark.ts), our share of our own pool being 100% while nobody else is in it.
 *
 * This file is pure: no disk, no network, no clock. The pool itself lives in src/venues/pair.ts;
 * the seat's shape in src/agent/policy.ts; the exits are the launch lane's (src/engine/directives.ts).
 */
import type { HotRow } from "../hot/types";
import { dumpingReason, h, usd, type LaunchEnv } from "./launch";

export interface PairEnv {
  /** PAIR_LANE: anything but "true" (or unset) turns the whole lane off */
  on: boolean;
  /** PAIR_MIN_AGE_MIN: nothing in the reference pool's first half hour */
  minAgeMin: number;
  /** PAIR_MAX_AGE_HOURS: past this the launch is over */
  maxAgeHours: number;
  /** PAIR_MIN_REF_LIQUIDITY_USD: the reference pool must hold this much */
  minRefLiquidityUsd: number;
  /** PAIR_MIN_VOLUME_24H_USD */
  minVolume24hUsd: number;
  /** PAIR_MIN_VOLUME_1H_USD: the flow must still be happening now */
  minVolume1hUsd: number;
  /** PAIR_MIN_TURNOVER: 24h volume / reference liquidity */
  minTurnover: number;
  /** PAIR_MAX_POOLS: pools of ours holding a band at once */
  maxPools: number;
  /** keep one seat of the book for the lane while it holds no pool, so ordinary picks cannot fill the book against it (PAIR_RESERVE_SEAT, default on) */
  reserveSeat: boolean;
  /** PAIR_QUOTE: the quote our pool is made in (the program allows SOL or USDC) */
  quote: "SOL" | "USDC";
  /** PAIR_BIN_STEP: bin step in bps (100 = 1% per bin) */
  binStep: number;
  /** PAIR_FEE_BPS: the base fee our pool charges */
  feeBps: number;
  /** PAIR_FEE_BPS was set explicitly: use it as is instead of choosing from the menu */
  feeBpsFixed: boolean;
  /** PAIR_FEE_MENU: the fees (bps) the lane may pick from per pool, by the routing model; default 25, 50, 100 */
  feeMenuBps: number[];
  /** PAIR_COLLECT_FEE_MODE: "quote" collects every fee in the quote token (the SDK's OnlyY), "both" in whichever token came in */
  collectFeeMode: "quote" | "both";
  /** PAIR_SEAT_PCT: the seat is this percent of MAX_TOTAL_EXPOSURE_SOL, half quote half token */
  seatPct: number;
  /** PAIR_BINS_EACH_SIDE: bins on each side of the active bin */
  binsEachSide: number;
  /** PAIR_STOP_PCT: the per-band stop, rolled like the launch lane's */
  stopPct: number;
  /** PAIR_MAX_HOLD_MIN: a pair band older than this is closed by EXPIRE */
  maxHoldMin: number;
  /** PAIR_LIVE: only the literal "true" lets the executor broadcast a pool creation (with DRY_RUN=false and Meteora in LIVE_VENUES) */
  live: boolean;
  /** PAIR_TRADE_MIN_USD / PAIR_TRADE_MAX_USD: the trade-size distribution the routing model integrates over */
  tradeMinUsd: number;
  tradeMaxUsd: number;
  /** PUMPSWAP_FEE_PCT: what PumpSwap charges a trader */
  pumpswapFeePct: number;
  /** PAIR_HOUSE_MINTS: our own tokens, always seated (see THE HOUSE TOKEN above); default none */
  houseMints: string[];
  /** PAIR_HOUSE_SEAT_PCT: a house seat is this percent of MAX_TOTAL_EXPOSURE_SOL */
  houseSeatPct: number;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const onByDefault = (v: string | undefined): boolean => v === undefined || v.trim() === "" || v.trim().toLowerCase() === "true";

export function pairEnv(env: NodeJS.ProcessEnv = process.env): PairEnv {
  const quote = (env.PAIR_QUOTE ?? "").trim().toUpperCase();
  const mode = (env.PAIR_COLLECT_FEE_MODE ?? "").trim().toLowerCase();
  return {
    on: onByDefault(env.PAIR_LANE),
    minAgeMin: Math.max(0, num(env.PAIR_MIN_AGE_MIN, 30)),
    maxAgeHours: Math.max(0, num(env.PAIR_MAX_AGE_HOURS, 48)),
    minRefLiquidityUsd: Math.max(0, num(env.PAIR_MIN_REF_LIQUIDITY_USD, 30_000)),
    minVolume24hUsd: Math.max(0, num(env.PAIR_MIN_VOLUME_24H_USD, 1_000_000)),
    minVolume1hUsd: Math.max(0, num(env.PAIR_MIN_VOLUME_1H_USD, 100_000)),
    minTurnover: Math.max(0, num(env.PAIR_MIN_TURNOVER, 5)),
    maxPools: Math.max(0, Math.floor(num(env.PAIR_MAX_POOLS, 1))),
    reserveSeat: onByDefault(env.PAIR_RESERVE_SEAT),
    quote: quote === "USDC" ? "USDC" : "SOL",
    binStep: Math.min(400, Math.max(1, Math.floor(num(env.PAIR_BIN_STEP, 100)))),
    feeBps: Math.max(1, Math.floor(num(env.PAIR_FEE_BPS, 50))),
    feeBpsFixed: (env.PAIR_FEE_BPS ?? "").trim() !== "",
    feeMenuBps: feeMenu(env.PAIR_FEE_MENU),
    collectFeeMode: mode === "both" ? "both" : "quote",
    seatPct: Math.max(0, num(env.PAIR_SEAT_PCT, 10)),
    binsEachSide: Math.max(1, Math.floor(num(env.PAIR_BINS_EACH_SIDE, 2))),
    stopPct: Math.max(0, num(env.PAIR_STOP_PCT, 10)),
    maxHoldMin: Math.max(0, num(env.PAIR_MAX_HOLD_MIN, 240)),
    live: (env.PAIR_LIVE ?? "").trim().toLowerCase() === "true",
    tradeMinUsd: Math.max(1, num(env.PAIR_TRADE_MIN_USD, 50)),
    tradeMaxUsd: Math.max(1, num(env.PAIR_TRADE_MAX_USD, 5_000)),
    pumpswapFeePct: Math.max(0, num(env.PUMPSWAP_FEE_PCT, 0.25)),
    houseMints: parseMintList(env.PAIR_HOUSE_MINTS),
    houseSeatPct: Math.max(0, num(env.PAIR_HOUSE_SEAT_PCT, 10)),
  };
}

/** "mintA, mintB" -> ["mintA", "mintB"], deduplicated; unset or empty -> none. */
export function parseMintList(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const m = part.trim();
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

/** A mint on PAIR_HOUSE_MINTS: our own token. */
export const isHouseMint = (mint: string | null | undefined, env: PairEnv): boolean => !!mint && env.houseMints.includes(mint);

/** The SOL a house seat may hold: PAIR_HOUSE_SEAT_PCT of the book's total exposure limit. */
export const pairHouseSeatSol = (maxTotalExposureSol: number, env: PairEnv): number => Math.max(0, (maxTotalExposureSol * env.houseSeatPct) / 100);

/** What the verdict says of a house mint. */
export const HOUSE_NOTE = "house token: always seated";

/** "25,50,100" -> [25, 50, 100]: whole bps in (0, 1000], deduplicated, ascending; unset or empty -> the default menu (the pump.fun lane's unless the caller passes its own). */
export function feeMenu(raw: string | undefined, defaults: readonly number[] = [25, 50, 100]): number[] {
  const src = (raw ?? "").trim();
  const parts = src === "" ? defaults.map(String) : src.split(",");
  const out = new Set<number>();
  for (const p of parts) {
    const n = Math.floor(Number(p.trim()));
    if (Number.isFinite(n) && n >= 1 && n <= 1000) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * MODEL. The base fee for a pool we are about to make: with PAIR_FEE_BPS unset, the fee on the menu
 * that earns the most under the routing model for THIS seat against THIS reference; a higher fee
 * buys more per trade and loses the small trades to PumpSwap, a lower fee wins them back, and which
 * side of that trade pays depends on how deep the reference pool is next to our seat. A fixed
 * PAIR_FEE_BPS is honoured as is. Competing depth scales every fee's take alike, so it does not move
 * the choice and is left out.
 */
export function chooseFeeBps(ref: { liquidityUsd: number | null; vol24hUsd: number | null; vol1hUsd: number | null }, env: PairEnv, seatUsd: number): number {
  if (env.feeBpsFixed || env.feeMenuBps.length === 0 || !(seatUsd > 0)) return env.feeBps;
  let best = env.feeBps;
  let bestFees = -1;
  for (const feeBps of env.feeMenuBps) {
    const fees = pairModel(ref, { ...env, feeBps }, seatUsd).feesPerDayUsd;
    if (fees > bestFees + 1e-9) {
      best = feeBps;
      bestFees = fees;
    }
  }
  return bestFees > 0 ? best : env.feeBps;
}

/* ---------- the address of a made pair ---------- */

/** The loop's key for our pool for a mint: virtual in paper mode, and the alias of the real pool once one exists. */
export const pairPoolAddress = (mint: string): string => `pair-${mint}`;
export const isPairAddress = (address: string): boolean => address.startsWith("pair-");
export const pairMintOf = (address: string): string | null => (isPairAddress(address) ? address.slice(5) || null : null);

/* ---------- admission ---------- */

/** What the lane reads about the REFERENCE pool. The hot watch's row carries every field (src/hot/types.ts). */
export interface PairRow {
  address: string;
  baseMint: string;
  baseSymbol: string;
  name: string;
  /** the reference pool's venue: must be pumpswap */
  venue: string;
  quoteSymbol: string;
  origin: "pump.fun" | null;
  ageHours: number | null;
  liquidityUsd: number | null;
  vol24hUsd: number | null;
  vol1hUsd: number | null;
  turnover24h?: number | null;
  sellShare1h?: number | null;
  priceChange1hPct?: number | null;
  flags?: string[];
  /** quote per base in the reference pool: what our pool opens at */
  priceNative: number | null;
  priceUsd?: number | null;
}

/** A concentrated pool for the same mint that will share the flow leaving PumpSwap with us. */
export interface CompetingPool {
  address: string;
  venue: string;
  quoteSymbol: string;
  liquidityUsd: number;
}

export interface Competition {
  /** the sum of the competitors' liquidity, USD */
  depthUsd: number;
  pools: CompetingPool[];
}

export type PairVerdict =
  | { ok: true; ageHours: number; turnover: number; refLiquidityUsd: number; competingDepthUsd: number; competitors: CompetingPool[]; house?: boolean; note?: string }
  | { ok: false; reason: string };

/** The venues whose SOL/USDC pools count as competing concentrated depth (every venue with a bin model). */
export const CONCENTRATED_VENUES: readonly string[] = ["meteora-dlmm", "raydium-clmm", "orca-whirlpool"];

/**
 * PURE. Whether the pair lane makes a pool for this token, or the number that stopped it. Other
 * pools never refuse: `competition` only rides along in the verdict so the model can split the flow.
 */
export function pairVerdict(row: PairRow, env: PairEnv, competition: Competition | null = null): PairVerdict {
  if (!env.on) return { ok: false, reason: "the pair lane is off (PAIR_LANE is not true)" };
  // THE HOUSE TOKEN: our own mint clears every floor by definition; only a watchlist DENY (the seating rule's) refuses it.
  if (isHouseMint(row.baseMint, env)) {
    const liq = row.liquidityUsd !== null && Number.isFinite(row.liquidityUsd) ? row.liquidityUsd : 0;
    const v24 = row.vol24hUsd !== null && Number.isFinite(row.vol24hUsd) ? row.vol24hUsd : 0;
    return {
      ok: true,
      house: true,
      note: HOUSE_NOTE,
      ageHours: row.ageHours !== null && Number.isFinite(row.ageHours) ? row.ageHours : 0,
      turnover: liq > 0 ? Math.round((v24 / liq) * 100) / 100 : 0,
      refLiquidityUsd: liq,
      competingDepthUsd: competition?.depthUsd ?? 0,
      competitors: competition?.pools ?? [],
    };
  }
  if (row.origin !== "pump.fun") return { ok: false, reason: "not a pump.fun token: the pair lane makes markets in graduated pump.fun tokens only" };
  if (row.venue !== "pumpswap") return { ok: false, reason: `the reference pool is on ${row.venue}, not PumpSwap: the lane wants the token graduated and trading on pump.fun's AMM` };
  if (row.quoteSymbol !== "SOL" && row.quoteSymbol !== "USDC") return { ok: false, reason: `the reference pool is quoted in ${row.quoteSymbol}, and the pair lane prices its pool from a SOL or USDC reference` };

  const age = row.ageHours;
  if (age === null || !Number.isFinite(age)) return { ok: false, reason: "age unknown: the pair lane needs to know how old the reference pool is" };
  if (age > env.maxAgeHours) return { ok: false, reason: `age ${h(age)} is past the ${env.maxAgeHours}h pair window: the launch is over` };
  if (age * 60 < env.minAgeMin) return { ok: false, reason: `age ${h(age)} is inside the first ${env.minAgeMin} min: nothing in its first half hour` };

  const liq = row.liquidityUsd;
  if (liq === null || !Number.isFinite(liq)) return { ok: false, reason: "reference liquidity unknown: the pair lane will not price a pool against a number nobody reported" };
  if (liq < env.minRefLiquidityUsd) return { ok: false, reason: `reference liquidity ${usd(liq)} is under the ${usd(env.minRefLiquidityUsd)} pair floor` };

  const v24 = row.vol24hUsd;
  if (v24 === null || !Number.isFinite(v24)) return { ok: false, reason: "24h volume unknown: fees come from volume, and nobody reported any" };
  if (v24 < env.minVolume24hUsd) return { ok: false, reason: `24h volume ${usd(v24)} is under the ${usd(env.minVolume24hUsd)} pair floor` };

  const v1 = row.vol1hUsd;
  if (v1 === null || !Number.isFinite(v1)) return { ok: false, reason: "last hour's volume unknown: the pair lane will not trade a 24h number on its own" };
  if (v1 < env.minVolume1hUsd) return { ok: false, reason: `the last hour traded ${usd(v1)}, under the ${usd(env.minVolume1hUsd)} pair floor: the 24h figure has already happened` };

  const turnover = typeof row.turnover24h === "number" && Number.isFinite(row.turnover24h) ? row.turnover24h : liq > 0 ? v24 / liq : 0;
  if (turnover < env.minTurnover) {
    return { ok: false, reason: `turnover ${turnover.toFixed(1)}x (${usd(v24)} traded on ${usd(liq)} of liquidity) is under the ${env.minTurnover}x pair floor` };
  }

  const dumping = dumpingReason(row.sellShare1h, row.priceChange1hPct, row.flags ?? []);
  if (dumping) return { ok: false, reason: dumping };

  const px = row.priceNative;
  if (px === null || !Number.isFinite(px) || px <= 0) return { ok: false, reason: "reference price unknown: nothing to open the pool at" };

  return {
    ok: true,
    ageHours: age,
    turnover: Math.round(turnover * 100) / 100,
    refLiquidityUsd: liq,
    competingDepthUsd: competition?.depthUsd ?? 0,
    competitors: competition?.pools ?? [],
  };
}

/**
 * PURE. The concentrated SOL/USDC pools for a mint among the rows given (hot rows, siblings included,
 * and the screen board, as the caller concatenates them), deepest first. `ownAddress` (our own pool's
 * key) is never a competitor of itself.
 */
export function competitionFor(
  mint: string,
  rows: readonly { address: string; venue: string; baseMint: string; quoteSymbol: string; liquidityUsd: number | null }[],
  ownAddress?: string | null,
): Competition {
  const seen = new Set<string>();
  const pools: CompetingPool[] = [];
  for (const r of rows) {
    if (r.baseMint !== mint || r.address === ownAddress || seen.has(r.address)) continue;
    if (!CONCENTRATED_VENUES.includes(r.venue)) continue;
    if (r.quoteSymbol !== "SOL" && r.quoteSymbol !== "USDC") continue;
    const liq = r.liquidityUsd;
    if (liq === null || !Number.isFinite(liq) || liq <= 0) continue;
    seen.add(r.address);
    pools.push({ address: r.address, venue: r.venue, quoteSymbol: r.quoteSymbol, liquidityUsd: liq });
  }
  pools.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  return { depthUsd: pools.reduce((t, p) => t + p.liquidityUsd, 0), pools };
}

/* ---------- the routing model ---------- */

export interface RoutedShareInput {
  /** our pool's fee, percent (PAIR_FEE_BPS / 100) */
  ourFeePct: number;
  /** our depth in ONE bin, USD: (seat / 2) / bins on that side */
  ourDepthPerBinUsd: number;
  binStepBps: number;
  /** the reference pool's fee, percent (PUMPSWAP_FEE_PCT) */
  theirFeePct: number;
  /** the reference pool's liquidity, USD (both sides) */
  theirLiquidityUsd: number;
  tradeMinUsd: number;
  tradeMaxUsd: number;
  /** bins on the side a trade walks (PAIR_BINS_EACH_SIDE); default 5 */
  ourBins?: number;
  /** competing concentrated depth for the mint, USD; default 0 */
  competingConcentratedDepthUsd?: number;
  /** integration steps over log trade size; default 400 */
  steps?: number;
}

/** MODEL. The all-in cost of a trade of size D against our pool, percent; null when we cannot fill it. */
export function ourCostPct(tradeUsd: number, i: RoutedShareInput): number | null {
  const bins = i.ourBins ?? 5;
  if (!(i.ourDepthPerBinUsd > 0) || !(bins > 0) || !(tradeUsd > 0)) return null;
  const binsUsed = tradeUsd / i.ourDepthPerBinUsd;
  if (binsUsed > bins) return null;
  return i.ourFeePct + ((i.binStepBps / 100) / 2) * binsUsed;
}

/** MODEL. The all-in cost of a trade of size D against the constant-product reference pool, percent (fee + 2D/L). */
export function theirCostPct(tradeUsd: number, i: Pick<RoutedShareInput, "theirFeePct" | "theirLiquidityUsd">): number {
  if (!(i.theirLiquidityUsd > 0)) return Number.POSITIVE_INFINITY;
  return i.theirFeePct + (200 * tradeUsd) / i.theirLiquidityUsd;
}

/**
 * MODEL. The fraction, by value, of the reference pool's flow for which our pool is the cheaper
 * route: `gross` before anyone else's concentrated depth, `net` after splitting with it by depth.
 * Log-uniform trade sizes on [tradeMinUsd, tradeMaxUsd], value-weighted, trapezoid rule.
 */
export function routedShareBreakdown(i: RoutedShareInput): { gross: number; net: number; ourDepthUsd: number } {
  const bins = i.ourBins ?? 5;
  const ourDepthUsd = Math.max(0, i.ourDepthPerBinUsd) * Math.max(0, bins) * 2;
  if (!(i.ourDepthPerBinUsd > 0) || !(bins > 0) || !(i.tradeMaxUsd > 0)) return { gross: 0, net: 0, ourDepthUsd };
  const gross = valueWeightedShare(i, (d) => {
    const ours = ourCostPct(d, i);
    return ours !== null && ours < theirCostPct(d, i);
  });
  return { gross, net: splitWithCompetingDepth(gross, ourDepthUsd, i.competingConcentratedDepthUsd), ourDepthUsd };
}

/**
 * MODEL. The fraction, by value, of log-uniform trade sizes on [tradeMinUsd, tradeMaxUsd] for which
 * `wins(D)` holds: value-weighted, trapezoid rule over `steps` (default 400). Shared by every lane's
 * routing model; what "wins" means (which route is cheaper) is the caller's.
 */
export function valueWeightedShare(i: Pick<RoutedShareInput, "tradeMinUsd" | "tradeMaxUsd" | "steps">, wins: (tradeUsd: number) => boolean): number {
  const clamp = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
  if (!(i.tradeMaxUsd > 0)) return 0;
  const lo = Math.log(Math.max(1e-9, Math.min(i.tradeMinUsd, i.tradeMaxUsd)));
  const hi = Math.log(Math.max(1e-9, i.tradeMaxUsd));
  const steps = Math.max(1, Math.floor(i.steps ?? 400));
  if (hi <= lo) return wins(Math.exp(hi)) ? 1 : 0;
  let won = 0;
  let total = 0;
  for (let k = 0; k <= steps; k++) {
    const d = Math.exp(lo + ((hi - lo) * k) / steps);
    const w = d * (k === 0 || k === steps ? 0.5 : 1); // value-weighted, trapezoid ends
    total += w;
    if (wins(d)) won += w;
  }
  return clamp(total > 0 ? won / total : 0);
}

/** The flow that leaves the reference pool is split with competing concentrated depth in proportion to depth. Shared by every lane. */
export function splitWithCompetingDepth(share: number, ourDepthUsd: number, competingUsd: number | undefined): number {
  const c = competingUsd !== undefined && Number.isFinite(competingUsd) && competingUsd > 0 ? competingUsd : 0;
  if (c <= 0) return share;
  const net = ourDepthUsd + c > 0 ? (share * ourDepthUsd) / (ourDepthUsd + c) : 0;
  return Math.min(1, Math.max(0, Number.isFinite(net) ? net : 0));
}

/** MODEL. routedShareBreakdown's net share in [0, 1]. */
export const routedShare = (i: RoutedShareInput): number => routedShareBreakdown(i).net;

/** MODEL. Fees per day for our pool: min(vol24h, vol1h x 24) x share x our fee. Unknown volume accrues nothing. */
export function pairFeesPerDayUsd(vol24hUsd: number | null, vol1hUsd: number | null, share: number, ourFeePct: number): number {
  const v24 = vol24hUsd !== null && Number.isFinite(vol24hUsd) && vol24hUsd > 0 ? vol24hUsd : null;
  const v1 = vol1hUsd !== null && Number.isFinite(vol1hUsd) && vol1hUsd >= 0 ? vol1hUsd * 24 : null;
  const vol = v24 !== null && v1 !== null ? Math.min(v24, v1) : (v24 ?? v1);
  if (vol === null || !(share > 0) || !(ourFeePct > 0)) return 0;
  return vol * Math.min(1, share) * (ourFeePct / 100);
}

export interface PairModel {
  seatUsd: number;
  ourDepthPerBinUsd: number;
  ourDepthUsd: number;
  routedShareGross: number;
  routedShare: number;
  /** the reference volume the model routes to us in a day, USD */
  routedVolume24hUsd: number;
  feesPerDayUsd: number;
  competingDepthUsd: number;
}

/** MODEL. The whole picture for one seat against one reference row. */
export function pairModel(
  ref: { liquidityUsd: number | null; vol24hUsd: number | null; vol1hUsd: number | null },
  env: PairEnv,
  seatUsd: number,
  competingDepthUsd = 0,
): PairModel {
  const ourDepthPerBinUsd = seatUsd > 0 ? seatUsd / 2 / env.binsEachSide : 0;
  const b = routedShareBreakdown({
    ourFeePct: env.feeBps / 100,
    ourDepthPerBinUsd,
    binStepBps: env.binStep,
    theirFeePct: env.pumpswapFeePct,
    theirLiquidityUsd: ref.liquidityUsd ?? 0,
    tradeMinUsd: env.tradeMinUsd,
    tradeMaxUsd: env.tradeMaxUsd,
    ourBins: env.binsEachSide,
    competingConcentratedDepthUsd: competingDepthUsd,
  });
  const v24 = ref.vol24hUsd ?? null;
  const v1 = ref.vol1hUsd ?? null;
  const daily = v24 !== null && v1 !== null ? Math.min(v24, v1 * 24) : (v24 ?? (v1 !== null ? v1 * 24 : 0));
  return {
    seatUsd,
    ourDepthPerBinUsd,
    ourDepthUsd: b.ourDepthUsd,
    routedShareGross: b.gross,
    routedShare: b.net,
    routedVolume24hUsd: daily * b.net,
    feesPerDayUsd: pairFeesPerDayUsd(v24, v1, b.net, env.feeBps / 100),
    competingDepthUsd,
  };
}

/* ---------- the pool's geometry ---------- */

/**
 * PURE. The DLMM bin whose price is nearest `priceQuotePerToken` (UI units, the token being X and the
 * quote Y): the inverse of src/tools/bins.ts binPrice, price = (1 + step/1e4)^id x 10^(xDec - yDec).
 */
export function activeIdFromPrice(priceQuotePerToken: number, binStep: number, tokenDecimals: number, quoteDecimals: number): number {
  if (!(priceQuotePerToken > 0) || !Number.isFinite(priceQuotePerToken)) throw new Error(`activeIdFromPrice: bad price ${priceQuotePerToken}`);
  if (!(binStep > 0)) throw new Error(`activeIdFromPrice: bad bin step ${binStep}`);
  const perLamport = priceQuotePerToken / Math.pow(10, tokenDecimals - quoteDecimals);
  return Math.round(Math.log(perLamport) / Math.log(1 + binStep / 10_000));
}

/** The SOL a pair seat may hold: PAIR_SEAT_PCT of the book's total exposure limit. */
export const pairSeatSol = (maxTotalExposureSol: number, env: PairEnv): number => Math.max(0, (maxTotalExposureSol * env.seatPct) / 100);

/**
 * The launch lane's terms with the pair lane's numbers: the stop, the maximum hold and the seat cap
 * are the pair's, the fade floor stays the launch lane's. A pair band is recorded in state.launchBands
 * with this, so the tighter stop, the EXPIRE directive and the seat count all apply unchanged.
 */
export function pairLaunchEnv(pair: PairEnv, launch: LaunchEnv): LaunchEnv {
  return { ...launch, on: true, seatPct: pair.seatPct, stopPct: pair.stopPct, maxHoldMin: pair.maxHoldMin };
}

/* ---------- seating ---------- */

export interface PairCandidate extends PairRow {
  heat?: number;
}

/** Every hot row the lane could judge: the pump.fun rows, and any row of a house mint whatever its venue. The verdict does the rest. */
export const pairCandidatesOf = (rows: readonly HotRow[], houseMints: readonly string[] = []): PairCandidate[] =>
  rows
    .filter((r) => r.origin === "pump.fun" || houseMints.includes(r.baseMint))
    .map((r) => ({
      address: r.address,
      baseMint: r.baseMint,
      baseSymbol: r.baseSymbol,
      name: r.name,
      venue: r.venue,
      quoteSymbol: r.quoteSymbol,
      origin: r.origin,
      ageHours: r.ageHours,
      liquidityUsd: r.liquidityUsd,
      vol24hUsd: r.vol24hUsd,
      vol1hUsd: r.vol1hUsd,
      turnover24h: r.vol24hUsd !== null && r.liquidityUsd !== null && r.liquidityUsd > 0 ? r.vol24hUsd / r.liquidityUsd : null,
      sellShare1h: r.sellShare1h,
      priceChange1hPct: r.priceChange1hPct,
      flags: r.flags,
      priceNative: r.priceNative,
      priceUsd: r.priceUsd,
      heat: r.heat,
    }));

export interface PairSeatOptions {
  env: PairEnv;
  /** seats left in the book before MAX_ACTIVE_POOLS is reached */
  freeSeats: number;
  /** pools of ours already holding a band: they count against PAIR_MAX_POOLS */
  poolsTaken?: number;
  /** the wallet can seat this quote at the minimum (PAIR_QUOTE must be fundable) */
  quoteOk: (quoteSymbol: string) => boolean;
  /** an explicit watchlist DENY on the token (src/screener/watchlist.ts watchlistDenial); an allow-list miss never counts */
  denied?: (row: PairCandidate) => string | null;
  /** pools the picker has already seated this cycle (our pair key or any other) */
  hasPool?: (address: string) => boolean;
  /** base mints already holding a seat: one seat per token, as everywhere else in the picker */
  hasToken?: (baseMint: string) => boolean;
  /** the competing concentrated pools for a mint, for the verdict's model inputs */
  competition?: (mint: string) => Competition | null;
  /**
   * What a seat in this token is worth by the routing model (fees per day, USD): candidates are
   * taken best first, and one the model routes nothing to is skipped rather than given the lane's
   * only seat for the policy to refuse. Absent = order by the last hour's volume.
   */
  worth?: (row: PairCandidate) => number;
}

export interface PairSeat {
  row: PairCandidate;
  verdict: Extract<PairVerdict, { ok: true }>;
  /** our pool's key: pair-<mint> */
  address: string;
  /** a house token's seat: never counted against PAIR_MAX_POOLS */
  house?: boolean;
}

/** A house mint with no row anywhere: the seat is still made; the model has nothing to read until a row appears. */
export const houseCandidateOf = (mint: string, env: PairEnv): PairCandidate => ({
  address: "",
  baseMint: mint,
  baseSymbol: `${mint.slice(0, 4)}…${mint.slice(-4)}`,
  name: "house token",
  venue: "none",
  quoteSymbol: env.quote,
  origin: null,
  ageHours: null,
  liquidityUsd: null,
  vol24hUsd: null,
  vol1hUsd: null,
  priceNative: null,
  priceUsd: null,
});

/**
 * PURE. The house tokens' seats (PAIR_HOUSE_MINTS): every house mint not already seated, denied or
 * out of room, with its row from `rows` when one exists and a bare candidate when none does. They
 * never count against PAIR_MAX_POOLS; the picker takes them right after held and pinned pools.
 */
export function pairHouseSeats(rows: readonly PairCandidate[], o: Pick<PairSeatOptions, "env" | "freeSeats" | "quoteOk" | "denied" | "hasPool" | "hasToken">): PairSeat[] {
  const out: PairSeat[] = [];
  // the house token is our own launch, not a lane pick: it is seated even with the pump.fun pair lane off
  let free = Math.max(0, o.freeSeats);
  for (const mint of o.env.houseMints) {
    if (free <= 0) break;
    const address = pairPoolAddress(mint);
    if (o.hasPool?.(address) || o.hasToken?.(mint)) continue;
    if (!o.quoteOk(o.env.quote)) continue;
    const row = rows.filter((r) => r.baseMint === mint).sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0] ?? houseCandidateOf(mint, o.env);
    if (o.denied?.(row)) continue;
    // judged with the lane on: the lane switch governs pump.fun picks, not our own token
    const verdict = pairVerdict(row, { ...o.env, on: true }, null);
    if (!verdict.ok) continue;
    out.push({ row, verdict, address, house: true });
    free--;
  }
  return out;
}

/**
 * PURE. The pump.fun tokens to make a pool for, busiest last hour first, at most PAIR_MAX_POOLS
 * (counting the ones already held) and never more than the book has room for. The whole seating
 * rule; the picker in src/index.ts only supplies the rows and the callbacks, LAST, after every
 * other lane has had its chance.
 */
export function pairSeats(rows: readonly PairCandidate[], o: PairSeatOptions): PairSeat[] {
  if (!o.env.on) return [];
  // the house tokens first: always seated, never counted against PAIR_MAX_POOLS
  const out: PairSeat[] = pairHouseSeats(rows, o);
  let pools = Math.max(0, o.poolsTaken ?? 0);
  let free = Math.max(0, o.freeSeats - out.length);
  const takenTokens = new Set<string>(out.map((h) => h.row.baseMint));
  const worthOf = (row: PairCandidate): number => (o.worth ? o.worth(row) : (row.vol1hUsd ?? 0));
  const ordered = [...rows].sort((a, b) => worthOf(b) - worthOf(a) || (b.vol1hUsd ?? 0) - (a.vol1hUsd ?? 0) || (b.vol24hUsd ?? 0) - (a.vol24hUsd ?? 0) || (b.heat ?? 0) - (a.heat ?? 0));
  for (const row of ordered) {
    if (pools >= o.env.maxPools || free <= 0) break;
    if (!row.baseMint || isHouseMint(row.baseMint, o.env)) continue;
    if (o.worth && !(worthOf(row) > 0)) continue;
    const address = pairPoolAddress(row.baseMint);
    if (o.hasPool?.(address) || o.hasPool?.(row.address)) continue;
    if (takenTokens.has(row.baseMint) || o.hasToken?.(row.baseMint)) continue;
    if (!o.quoteOk(o.env.quote)) continue;
    if (o.denied?.(row)) continue;
    const verdict = pairVerdict(row, o.env, o.competition?.(row.baseMint) ?? null);
    if (!verdict.ok) continue;
    out.push({ row, verdict, address });
    takenTokens.add(row.baseMint);
    pools++;
    free--;
  }
  return out;
}
