/**
 * The STOCK PAIR LANE: the desk makes and works its own Meteora DLMM pools for TOKENIZED STOCKS
 * quoted in SOL (Zach: "focus on meteora pools initially and setting up different pools with our
 * native token and tokenized stocks"; the native token is SOL).
 *
 * WHY IT CAN WORK. Today's board holds 52 tokenized-stock pools, all but one on Raydium CLMM or
 * Orca and mostly USDC-quoted (SPY/USDC $2.7M, NVDA/USDC $2.1M ...); Meteora holds one (MCD/SOL,
 * $38k). SOL-quoted demand exists (SPY/SOL on Raydium: $1.1M of TVL, $823k a day). A SOL holder
 * buying a stock today routes SOL -> USDC -> STOCKx through two pools; a STOCKx/SOL pool of ours is
 * a single hop, and Jupiter splits every swap across pools by execution cost. The seat is a
 * two-sided STRADDLE (half SOL, half stock, the stock half bought through Jupiter first), hedged
 * short on Backpack's perp where one is listed, so the fees are earned delta-neutral.
 *
 * WHY IT CAN FAIL. A small pool cannot out-depth a deep reference: the hop it saves a SOL holder
 * (PAIR_HOP_FEE_PCT) is a few basis points, and the walk across thin bins costs more than that
 * for any trade bigger than a bin. The routing model below says so honestly, and the picker
 * skips a ticker the model routes nothing to rather than pay rent for it.
 *
 * THE RULES, in order, every refusal naming the number that failed (the launch lane's voice):
 *   PAIR_STOCK_LANE on; the ticker is in PAIR_STOCK_TICKERS when that list is set (unset = every
 *   xStock on the board); the reference pool (the ticker's deepest by TVL on any venue) holds
 *   >= PAIR_STOCK_MIN_REF_LIQUIDITY_USD; the ticker's 24h volume (summed over its pools) is
 *   >= PAIR_STOCK_MIN_VOLUME_24H_USD; the reference is not flagged thin or no-24h-data; it has a
 *   USD price. A watchlist DENY wins; at most PAIR_STOCK_MAX_POOLS of ours, one per ticker.
 *
 * THE ROUTING MODEL (a MODEL, not a measurement), for a SOL holder's trade of size D (USD):
 *   theirs = PAIR_HOP_FEE_PCT (the SOL/USDC leg: fee + impact on a deep pool; 0 when the reference
 *            is itself SOL-quoted) + the reference pool's fee (the board's baseFeePct, else 0.25)
 *            + impact, where a concentrated pool holds PAIR_REF_DEPTH_PER_PCT of its TVL within 1%
 *            of price: impactPct = D / (TVL x PAIR_REF_DEPTH_PER_PCT)   (a trade that eats the whole
 *            1% of depth moves the price 1%)
 *   ours   = our fee + the walk across our bins: binStep/2 x (D / depth per bin), in percent, as in
 *            src/screener/pair.ts ourCostPct; beyond our total depth on a side we cannot fill at all
 * routedShare integrates "ours is cheaper" over log-uniform trade sizes on [PAIR_STOCK_TRADE_MIN_USD,
 * PAIR_STOCK_TRADE_MAX_USD], value-weighted (the pair lane's integrator), then splits that share with
 * the OTHER SOL-quoted concentrated pools for the ticker (SPY/SOL on Raydium is competition; the
 * USDC route is the reference) by depth (the pair lane's split). Fees per day = min(ticker vol24h,
 * vol1h x 24 when the hot watch has it) x share x our fee; shown gross (before the split) and net.
 *
 * This file is pure: no disk, no network, no clock. The pool lives in src/venues/pair.ts (the pair
 * venue, keyed pair-<mint>); the seat's shape is the stock straddle in src/agent/policy.ts; the
 * exits are the ordinary stop, the cost-based re-centre, the stock policy's own closes and one
 * guard of this lane's: the reference off the board for PAIR_STOCK_REF_GONE_CYCLES cycles closes.
 */
import { usd } from "./launch";
import { CONCENTRATED_VENUES, feeMenu, ourCostPct, pairPoolAddress, splitWithCompetingDepth, valueWeightedShare, type CompetingPool } from "./pair";
import type { StockTag } from "./types";

export interface PairStockEnv {
  /** PAIR_STOCK_LANE: anything but "true" (or unset) turns the lane off */
  on: boolean;
  /** PAIR_STOCK_TICKERS: the tickers the lane may make pools for; null (unset) = every xStock on the board */
  tickers: string[] | null;
  /**
   * PAIR_STOCK_PINNED_TICKERS: the stocks the agent is PAIRED with (the Clawrena entry: NVDA). A pinned
   * ticker is always admitted (the liquidity and volume floors, the thin flags and the model's payback
   * are waived: the pin is the operator's judgement), seated first, and still counts against
   * PAIR_STOCK_MAX_POOLS. The loop first works the ticker's existing Meteora pools (src/screener/pinnedStock.ts);
   * this lane makes our own only when Meteora has none the wallet can fund.
   */
  pinnedTickers: string[];
  /** PAIR_STOCK_MIN_REF_LIQUIDITY_USD: the reference pool must hold this much */
  minRefLiquidityUsd: number;
  /** PAIR_STOCK_MIN_VOLUME_24H_USD: the ticker's pools together must trade this much a day */
  minVolume24hUsd: number;
  /** PAIR_STOCK_MAX_POOLS: stock pools of ours holding a band at once, one per ticker */
  maxPools: number;
  /** PAIR_STOCK_RESERVE_SEATS: seats of MAX_ACTIVE_POOLS kept from ordinary picks while the lane holds fewer stock pools than this */
  reserveSeats: number;
  /** PAIR_STOCK_BIN_STEP: bin step in bps (20 = 0.2% per bin: equities move a percent or two a day) */
  binStep: number;
  /** PAIR_STOCK_FEE_BPS: the base fee, when forced; otherwise the model chooses from the menu */
  feeBps: number;
  feeBpsFixed: boolean;
  /** PAIR_STOCK_FEE_MENU: the fees (bps) the lane may pick from per pool; default 10, 25, 50 */
  feeMenuBps: number[];
  /** PAIR_STOCK_COLLECT_FEE_MODE: "both" (default: a straddle earns both sides and the inventory is hedged) or "quote" */
  collectFeeMode: "quote" | "both";
  /** PAIR_STOCK_SEAT_PCT: the seat is this percent of MAX_TOTAL_EXPOSURE_SOL, half SOL half stock */
  seatPct: number;
  /** PAIR_STOCK_TRADE_MIN_USD / PAIR_STOCK_TRADE_MAX_USD: the trade-size distribution the model integrates over */
  tradeMinUsd: number;
  tradeMaxUsd: number;
  /** PAIR_HOP_FEE_PCT: what the SOL/USDC leg costs a SOL holder on the reference route (fee + impact on a deep pool) */
  hopFeePct: number;
  /** PAIR_REF_DEPTH_PER_PCT: the share of a concentrated reference pool's TVL that sits within 1% of price */
  refDepthPerPct: number;
  /** PAIR_STOCK_REF_GONE_CYCLES: the reference off the board for this many cycles closes the band */
  refGoneCycles: number;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const onByDefault = (v: string | undefined): boolean => v === undefined || v.trim() === "" || v.trim().toLowerCase() === "true";

/** "SPY, nvdax ,MSFT" -> ["SPY", "NVDA", "MSFT"]: a trailing lowercase x (the xStock symbol) is dropped; empty -> null (every xStock). */
export function parseStockTickers(raw: string | undefined): string[] | null {
  const src = (raw ?? "").trim();
  if (src === "") return null;
  const out: string[] = [];
  for (const part of src.split(",")) {
    const t = part.trim();
    if (!t) continue;
    const ticker = (/^[A-Za-z.]{1,6}x$/.test(t) ? t.slice(0, -1) : t).toUpperCase();
    if (!out.includes(ticker)) out.push(ticker);
  }
  return out.length ? out : null;
}

export const PAIR_STOCK_FEE_MENU_DEFAULT: readonly number[] = [10, 25, 50];

export function pairStockEnv(env: NodeJS.ProcessEnv = process.env): PairStockEnv {
  const mode = (env.PAIR_STOCK_COLLECT_FEE_MODE ?? "").trim().toLowerCase();
  return {
    on: onByDefault(env.PAIR_STOCK_LANE),
    tickers: parseStockTickers(env.PAIR_STOCK_TICKERS),
    pinnedTickers: parseStockTickers(env.PAIR_STOCK_PINNED_TICKERS) ?? [],
    minRefLiquidityUsd: Math.max(0, num(env.PAIR_STOCK_MIN_REF_LIQUIDITY_USD, 100_000)),
    minVolume24hUsd: Math.max(0, num(env.PAIR_STOCK_MIN_VOLUME_24H_USD, 500_000)),
    maxPools: Math.max(0, Math.floor(num(env.PAIR_STOCK_MAX_POOLS, 3))),
    reserveSeats: Math.max(0, Math.floor(num(env.PAIR_STOCK_RESERVE_SEATS, 2))),
    binStep: Math.min(400, Math.max(1, Math.floor(num(env.PAIR_STOCK_BIN_STEP, 20)))),
    feeBps: Math.max(1, Math.floor(num(env.PAIR_STOCK_FEE_BPS, 25))),
    feeBpsFixed: (env.PAIR_STOCK_FEE_BPS ?? "").trim() !== "",
    feeMenuBps: feeMenu(env.PAIR_STOCK_FEE_MENU, PAIR_STOCK_FEE_MENU_DEFAULT),
    collectFeeMode: mode === "quote" ? "quote" : "both",
    seatPct: Math.max(0, num(env.PAIR_STOCK_SEAT_PCT, 15)),
    tradeMinUsd: Math.max(1, num(env.PAIR_STOCK_TRADE_MIN_USD, 100)),
    tradeMaxUsd: Math.max(1, num(env.PAIR_STOCK_TRADE_MAX_USD, 20_000)),
    hopFeePct: Math.max(0, num(env.PAIR_HOP_FEE_PCT, 0.04)),
    refDepthPerPct: Math.max(1e-6, num(env.PAIR_REF_DEPTH_PER_PCT, 0.1)),
    refGoneCycles: Math.max(1, Math.floor(num(env.PAIR_STOCK_REF_GONE_CYCLES, 3))),
  };
}

/** The SOL a stock pair seat may hold: PAIR_STOCK_SEAT_PCT of the book's total exposure limit. */
export const pairStockSeatSol = (maxTotalExposureSol: number, env: PairStockEnv): number => Math.max(0, (maxTotalExposureSol * env.seatPct) / 100);

/** The reference pool's fee for the model: the board's base fee when it reported one, else 0.25%. */
export const REF_FEE_PCT_DEFAULT = 0.25;
export const refFeePctOf = (baseFeePct: number | null | undefined): number => (typeof baseFeePct === "number" && Number.isFinite(baseFeePct) && baseFeePct > 0 ? baseFeePct : REF_FEE_PCT_DEFAULT);

/* ---------- candidates: the board grouped by ticker ---------- */

/** What the lane reads of a board row (src/screener/types.ts ScreenedPool carries every field). */
export interface StockPoolRow {
  address: string;
  venue: string;
  baseMint: string;
  baseSymbol: string;
  name: string;
  quoteSymbol: string;
  baseDecimals?: number;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  baseFeePct?: number | null;
  stepBps?: number | null;
  /** quote per base as the board reports it */
  price?: number | null;
  priceUsd: number | null;
  ageHours?: number | null;
  priceChange24hPct?: number | null;
  flags: string[];
  stock: StockTag | null;
}

/** One ticker on the board, as the lane judges it. */
export interface PairStockCandidate {
  ticker: string;
  issuer: StockTag["issuer"];
  mint: string;
  /** the token's symbol as the board names it ("SPYx") */
  symbol: string;
  name: string;
  baseDecimals: number;
  /** the ticker's deepest pool by TVL on any venue: what a SOL holder routes through today */
  reference: StockPoolRow;
  /** every pool of the ticker on the board */
  pools: StockPoolRow[];
  refLiquidityUsd: number | null;
  refFeePct: number;
  /** the reference is itself SOL-quoted: a SOL holder needs no hop there */
  refQuoteIsSol: boolean;
  /** the ticker's 24h volume, summed over its pools */
  vol24hUsd: number | null;
  /** the last hour's volume, summed over the hot watch's rows for the mint; null when the watch has none */
  vol1hUsd: number | null;
  priceUsd: number | null;
  /** the other SOL-quoted concentrated pools for the ticker: competition for the flow that leaves the USDC route */
  competitors: CompetingPool[];
  competingDepthUsd: number;
}

/** The issuers the lane makes pools for: xStocks (Backed). Backpack Securities mints are off the lane until it is told otherwise. */
export const PAIR_STOCK_ISSUERS: readonly StockTag["issuer"][] = ["xstocks"];

/**
 * PURE. The board grouped by ticker for the lane's issuers: the reference is the ticker's deepest
 * pool by TVL on any venue, the volume the sum over its pools, the competition the other SOL-quoted
 * concentrated pools for the mint. `ownKey` (our own pair-<mint>) is never a competitor of itself.
 */
export function pairStockCandidatesOf(
  rows: readonly StockPoolRow[],
  hotRows: readonly { baseMint: string; vol1hUsd: number | null }[] = [],
  issuers: readonly StockTag["issuer"][] = PAIR_STOCK_ISSUERS,
): PairStockCandidate[] {
  const byMint = new Map<string, StockPoolRow[]>();
  for (const r of rows) {
    if (!r.stock || !issuers.includes(r.stock.issuer) || !r.baseMint) continue;
    (byMint.get(r.baseMint) ?? byMint.set(r.baseMint, []).get(r.baseMint)!).push(r);
  }
  const out: PairStockCandidate[] = [];
  for (const [mint, pools] of byMint) {
    const ordered = [...pools].sort((a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1));
    const reference = ordered[0];
    const ticker = reference.stock!.ticker;
    const vols = pools.map((p) => p.volume24hUsd).filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
    const hot1h = hotRows.filter((h) => h.baseMint === mint && typeof h.vol1hUsd === "number" && Number.isFinite(h.vol1hUsd!)).map((h) => h.vol1hUsd!);
    const own = pairPoolAddress(mint);
    const competitors: CompetingPool[] = ordered
      .filter((p) => p.address !== reference.address && p.address !== own && p.quoteSymbol === "SOL" && CONCENTRATED_VENUES.includes(p.venue) && typeof p.tvlUsd === "number" && p.tvlUsd > 0)
      .map((p) => ({ address: p.address, venue: p.venue, quoteSymbol: p.quoteSymbol, liquidityUsd: p.tvlUsd! }));
    out.push({
      ticker,
      issuer: reference.stock!.issuer,
      mint,
      symbol: reference.baseSymbol,
      name: reference.name,
      baseDecimals: typeof reference.baseDecimals === "number" && Number.isInteger(reference.baseDecimals) ? reference.baseDecimals : 8,
      reference,
      pools: ordered,
      refLiquidityUsd: typeof reference.tvlUsd === "number" && Number.isFinite(reference.tvlUsd) ? reference.tvlUsd : null,
      refFeePct: refFeePctOf(reference.baseFeePct),
      refQuoteIsSol: reference.quoteSymbol === "SOL",
      vol24hUsd: vols.length ? vols.reduce((t, v) => t + v, 0) : null,
      vol1hUsd: hot1h.length ? hot1h.reduce((t, v) => t + v, 0) : null,
      priceUsd: typeof reference.priceUsd === "number" && Number.isFinite(reference.priceUsd) && reference.priceUsd > 0 ? reference.priceUsd : null,
      competitors,
      competingDepthUsd: competitors.reduce((t, c) => t + c.liquidityUsd, 0),
    });
  }
  // one per ticker: two mints under one ticker keep the deeper reference
  const byTicker = new Map<string, PairStockCandidate>();
  for (const c of out.sort((a, b) => (b.refLiquidityUsd ?? -1) - (a.refLiquidityUsd ?? -1))) if (!byTicker.has(c.ticker)) byTicker.set(c.ticker, c);
  return [...byTicker.values()];
}

/** The candidate for a mint, when the board carries the ticker. */
export const pairStockCandidateFor = (cands: readonly PairStockCandidate[], mint: string): PairStockCandidate | null => cands.find((c) => c.mint === mint) ?? null;

/* ---------- admission ---------- */

export type PairStockVerdict =
  | { ok: true; refLiquidityUsd: number; vol24hUsd: number; refFeePct: number; competingDepthUsd: number; competitors: CompetingPool[]; pinned?: boolean }
  | { ok: false; reason: string };

/** Whether a ticker is pinned (PAIR_STOCK_PINNED_TICKERS). */
export const isPinnedTicker = (env: Pick<PairStockEnv, "pinnedTickers">, ticker: string): boolean => env.pinnedTickers.includes(ticker.toUpperCase());

/** PURE. Whether the lane makes a STOCKx/SOL pool for this ticker, or the number that stopped it. Other pools never refuse. */
export function pairStockVerdict(c: PairStockCandidate, env: PairStockEnv): PairStockVerdict {
  if (!env.on) return { ok: false, reason: "the stock pair lane is off (PAIR_STOCK_LANE is not true)" };
  // A pinned ticker is the agent's pair: every floor is waived, only a price to open at is required.
  if (isPinnedTicker(env, c.ticker)) {
    const px = c.priceUsd;
    if (px === null || !(px > 0)) return { ok: false, reason: `pinned ${c.ticker} has no price to open a pool at` };
    return { ok: true, refLiquidityUsd: c.refLiquidityUsd ?? 0, vol24hUsd: c.vol24hUsd ?? 0, refFeePct: c.refFeePct, competingDepthUsd: c.competingDepthUsd, competitors: c.competitors, pinned: true };
  }
  if (env.tickers && !env.tickers.includes(c.ticker)) return { ok: false, reason: `${c.ticker} is not in PAIR_STOCK_TICKERS (${env.tickers.join(", ")})` };

  const liq = c.refLiquidityUsd;
  if (liq === null || !Number.isFinite(liq)) return { ok: false, reason: "reference liquidity unknown: the stock pair lane will not price a pool against a number nobody reported" };
  if (liq < env.minRefLiquidityUsd) return { ok: false, reason: `reference liquidity ${usd(liq)} (${c.reference.venue} ${c.symbol}/${c.reference.quoteSymbol}) is under the ${usd(env.minRefLiquidityUsd)} stock pair floor` };

  const v24 = c.vol24hUsd;
  if (v24 === null || !Number.isFinite(v24)) return { ok: false, reason: "24h volume unknown: fees come from volume, and nobody reported any" };
  if (v24 < env.minVolume24hUsd) return { ok: false, reason: `24h volume ${usd(v24)} across ${c.pools.length} ${c.ticker} pool(s) is under the ${usd(env.minVolume24hUsd)} stock pair floor` };

  if (c.reference.flags.includes("thin")) return { ok: false, reason: `the reference pool is flagged thin: a band priced from it would be priced from nothing` };
  if (c.reference.flags.includes("no-24h-data")) return { ok: false, reason: `the reference pool is flagged no-24h-data: nothing to judge the flow by` };

  const px = c.priceUsd;
  if (px === null || !(px > 0)) return { ok: false, reason: "reference price unknown: nothing to open the pool at" };

  return { ok: true, refLiquidityUsd: liq, vol24hUsd: v24, refFeePct: c.refFeePct, competingDepthUsd: c.competingDepthUsd, competitors: c.competitors };
}

/* ---------- the routing model ---------- */

export interface StockRoutedInput {
  /** our pool's fee, percent */
  ourFeePct: number;
  /** our depth in ONE bin, USD: (seat / 2) / bins per side */
  ourDepthPerBinUsd: number;
  binStepBps: number;
  /** bins on the side a trade walks */
  ourBins: number;
  /** the SOL/USDC leg a SOL holder pays on the reference route, percent (0 when the reference is SOL-quoted) */
  hopFeePct: number;
  /** the reference pool's fee, percent */
  refFeePct: number;
  /** the reference pool's TVL, USD */
  refLiquidityUsd: number;
  /** the share of that TVL within 1% of price */
  refDepthPerPct: number;
  tradeMinUsd: number;
  tradeMaxUsd: number;
  /** competing SOL-quoted concentrated depth for the ticker, USD; default 0 */
  competingConcentratedDepthUsd?: number;
  steps?: number;
}

/** MODEL. What a SOL holder pays through the reference route for a trade of size D, percent: hop + fee + D / (TVL x depth per 1%). */
export function referenceCostPct(tradeUsd: number, i: Pick<StockRoutedInput, "hopFeePct" | "refFeePct" | "refLiquidityUsd" | "refDepthPerPct">): number {
  if (!(i.refLiquidityUsd > 0) || !(i.refDepthPerPct > 0)) return Number.POSITIVE_INFINITY;
  return i.hopFeePct + i.refFeePct + tradeUsd / (i.refLiquidityUsd * i.refDepthPerPct);
}

/** MODEL. Our cost for a trade of size D (fee + the walk), or null when our bins cannot fill it: the pair lane's ourCostPct at our geometry. */
export const ourStockCostPct = (tradeUsd: number, i: Pick<StockRoutedInput, "ourFeePct" | "ourDepthPerBinUsd" | "binStepBps" | "ourBins">): number | null =>
  ourCostPct(tradeUsd, { ourFeePct: i.ourFeePct, ourDepthPerBinUsd: i.ourDepthPerBinUsd, binStepBps: i.binStepBps, ourBins: i.ourBins, theirFeePct: 0, theirLiquidityUsd: 0, tradeMinUsd: 0, tradeMaxUsd: 0 });

/**
 * MODEL. The fraction, by value, of the ticker's flow for which our single-hop pool is the cheaper
 * route: `gross` before anyone else's SOL-quoted depth, `net` after splitting with it by depth.
 */
export function stockRoutedShareBreakdown(i: StockRoutedInput): { gross: number; net: number; ourDepthUsd: number } {
  const ourDepthUsd = Math.max(0, i.ourDepthPerBinUsd) * Math.max(0, i.ourBins) * 2;
  if (!(i.ourDepthPerBinUsd > 0) || !(i.ourBins > 0) || !(i.tradeMaxUsd > 0)) return { gross: 0, net: 0, ourDepthUsd };
  const gross = valueWeightedShare(i, (d) => {
    const ours = ourStockCostPct(d, i);
    return ours !== null && ours < referenceCostPct(d, i);
  });
  return { gross, net: splitWithCompetingDepth(gross, ourDepthUsd, i.competingConcentratedDepthUsd), ourDepthUsd };
}

/** What the model reads of a reference: the candidate's figures, or a test's. */
export interface StockRefFigures {
  liquidityUsd: number | null;
  vol24hUsd: number | null;
  vol1hUsd: number | null;
  refFeePct: number;
  /** the reference is SOL-quoted: no hop */
  refQuoteIsSol?: boolean;
}

export interface PairStockModel {
  seatUsd: number;
  binsPerSide: number;
  feeBps: number;
  binStep: number;
  ourDepthPerBinUsd: number;
  ourDepthUsd: number;
  hopFeePct: number;
  refFeePct: number;
  routedShareGross: number;
  routedShare: number;
  /** the volume the model expects in a day: min(vol24h, vol1h x 24) */
  dailyVolumeUsd: number;
  routedVolume24hUsd: number;
  /** fees per day before the split with competing depth (what the single hop alone wins) */
  feesPerDayGrossUsd: number;
  /** fees per day after the split: what the lane expects to earn */
  feesPerDayUsd: number;
  competingDepthUsd: number;
  /** the two routes' costs at the smallest trade the model considers, percent (ours null when a bin cannot fill it) */
  ourCostAtMinPct: number | null;
  refCostAtMinPct: number;
}

/**
 * MODEL. The whole picture for one seat against one reference: at `binsPerSide` bins of `binStep`
 * (the straddle's own width: STOCK_COVER_PCT x the session's width, at OUR bin step) and the fee
 * given (the pool's own, never the env's default: see commit 011907b for the mistake).
 */
export function stockPairModel(
  ref: StockRefFigures,
  env: PairStockEnv,
  seatUsd: number,
  binsPerSide: number,
  competingDepthUsd = 0,
  over: { feeBps?: number; binStep?: number } = {},
): PairStockModel {
  const feeBps = over.feeBps ?? env.feeBps;
  const binStep = over.binStep ?? env.binStep;
  const bins = Math.max(0, Math.floor(binsPerSide));
  const ourDepthPerBinUsd = seatUsd > 0 && bins > 0 ? seatUsd / 2 / bins : 0;
  const hopFeePct = ref.refQuoteIsSol ? 0 : env.hopFeePct;
  const input: StockRoutedInput = {
    ourFeePct: feeBps / 100,
    ourDepthPerBinUsd,
    binStepBps: binStep,
    ourBins: bins,
    hopFeePct,
    refFeePct: ref.refFeePct,
    refLiquidityUsd: ref.liquidityUsd ?? 0,
    refDepthPerPct: env.refDepthPerPct,
    tradeMinUsd: env.tradeMinUsd,
    tradeMaxUsd: env.tradeMaxUsd,
    competingConcentratedDepthUsd: competingDepthUsd,
  };
  const b = stockRoutedShareBreakdown(input);
  const v24 = ref.vol24hUsd !== null && Number.isFinite(ref.vol24hUsd) && ref.vol24hUsd > 0 ? ref.vol24hUsd : null;
  const v1 = ref.vol1hUsd !== null && Number.isFinite(ref.vol1hUsd) && ref.vol1hUsd >= 0 ? ref.vol1hUsd * 24 : null;
  const daily = v24 !== null && v1 !== null ? Math.min(v24, v1) : (v24 ?? v1 ?? 0);
  const fee = feeBps / 10_000;
  return {
    seatUsd,
    binsPerSide: bins,
    feeBps,
    binStep,
    ourDepthPerBinUsd,
    ourDepthUsd: b.ourDepthUsd,
    hopFeePct,
    refFeePct: ref.refFeePct,
    routedShareGross: b.gross,
    routedShare: b.net,
    dailyVolumeUsd: daily,
    routedVolume24hUsd: daily * b.net,
    feesPerDayGrossUsd: daily * b.gross * fee,
    feesPerDayUsd: daily * b.net * fee,
    competingDepthUsd,
    ourCostAtMinPct: ourStockCostPct(env.tradeMinUsd, input),
    refCostAtMinPct: referenceCostPct(env.tradeMinUsd, input),
  };
}

/**
 * MODEL. The fee for a stock pool we are about to make: with PAIR_STOCK_FEE_BPS unset, the fee on
 * the menu that earns the most under the model for THIS seat against THIS reference. Competing depth
 * scales every fee's take alike, so it does not move the choice. A fixed fee is honoured as is.
 */
export function chooseStockFeeBps(ref: StockRefFigures, env: PairStockEnv, seatUsd: number, binsPerSide: number): number {
  if (env.feeBpsFixed || env.feeMenuBps.length === 0 || !(seatUsd > 0)) return env.feeBps;
  let best = env.feeBps;
  let bestFees = -1;
  for (const feeBps of env.feeMenuBps) {
    const fees = stockPairModel(ref, env, seatUsd, binsPerSide, 0, { feeBps }).feesPerDayUsd;
    if (fees > bestFees + 1e-9) {
      best = feeBps;
      bestFees = fees;
    }
  }
  return bestFees > 0 ? best : env.feeBps;
}

/* ---------- seating ---------- */

export interface PairStockSeatOptions {
  env: PairStockEnv;
  /** seats left in the book before MAX_ACTIVE_POOLS is reached */
  freeSeats: number;
  /** stock pools of ours already holding a band: they count against PAIR_STOCK_MAX_POOLS */
  poolsTaken?: number;
  /** the wallet can seat SOL at the minimum */
  quoteOk: (quoteSymbol: "SOL") => boolean;
  /** an explicit watchlist DENY on the token (src/screener/watchlist.ts watchlistDenial); an allow-list miss never counts */
  denied?: (c: PairStockCandidate) => string | null;
  /** pools the picker has already seated this cycle (our pair key or any other) */
  hasPool?: (address: string) => boolean;
  /** base mints already holding a seat: one seat per token, as everywhere else in the picker */
  hasToken?: (baseMint: string) => boolean;
  /** what a seat in this ticker is worth by the model (fees per day, USD): best first, and zero is skipped. Absent = by 24h volume. */
  worth?: (c: PairStockCandidate) => number;
}

export interface PairStockSeat {
  candidate: PairStockCandidate;
  verdict: Extract<PairStockVerdict, { ok: true }>;
  /** our pool's key: pair-<mint> */
  address: string;
  worthUsdPerDay: number | null;
}

/**
 * PURE. The tickers to make a STOCKx/SOL pool for, best by the model first, at most PAIR_STOCK_MAX_POOLS
 * (counting the ones already held), one per ticker, never more than the book has room for. The picker
 * in src/index.ts supplies the rows and the callbacks, RIGHT AFTER held and pinned pools.
 */
export function pairStockSeats(cands: readonly PairStockCandidate[], o: PairStockSeatOptions): PairStockSeat[] {
  const out: PairStockSeat[] = [];
  if (!o.env.on) return out;
  let pools = Math.max(0, o.poolsTaken ?? 0);
  let free = Math.max(0, o.freeSeats);
  const takenTickers = new Set<string>();
  const worthOf = (c: PairStockCandidate): number => (o.worth ? o.worth(c) : (c.vol24hUsd ?? 0));
  const pinnedRank = (c: PairStockCandidate): number => {
    const i = o.env.pinnedTickers.indexOf(c.ticker);
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  };
  // pinned tickers first, in the order the operator listed them; then the model's best
  const ordered = [...cands].sort((a, b) => pinnedRank(a) - pinnedRank(b) || worthOf(b) - worthOf(a) || (b.vol24hUsd ?? 0) - (a.vol24hUsd ?? 0) || (b.refLiquidityUsd ?? 0) - (a.refLiquidityUsd ?? 0));
  for (const c of ordered) {
    if (pools >= o.env.maxPools || free <= 0) break;
    if (!c.mint || takenTickers.has(c.ticker)) continue;
    const verdict = pairStockVerdict(c, o.env);
    if (!verdict.ok) continue;
    const address = pairPoolAddress(c.mint);
    if (o.hasPool?.(address)) continue;
    if (o.hasToken?.(c.mint)) continue;
    if (!o.quoteOk("SOL")) continue;
    if (o.denied?.(c)) continue;
    const worth = o.worth ? worthOf(c) : null;
    // a pinned ticker is seated whatever the model says it earns
    if (o.worth && !(worth! > 0) && !verdict.pinned) continue;
    out.push({ candidate: c, verdict, address, worthUsdPerDay: worth });
    takenTickers.add(c.ticker);
    pools++;
    free--;
  }
  return out;
}

/** The seats an ordinary pick must leave for the lane: the reserve less the stock pools already held, never negative. */
export const pairStockReserve = (env: PairStockEnv, held: number): number => (env.on ? Math.max(0, Math.min(env.reserveSeats, env.maxPools) - Math.max(0, held)) : 0);
