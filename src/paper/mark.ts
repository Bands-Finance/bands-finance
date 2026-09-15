/**
 * Marking a paper band against the live pool. Pure: (band, snapshot, context) -> the band's
 * contents, its PositionSnapshot, and the fees it accrued since the last mark.
 *
 * The bin model is the DLMM's own, stateless: every bin of the band carries a quote notional
 * (Spot: the deposit spread evenly over the bins it was laid in). A bin on the quote side of the
 * active bin holds that notional as quote; a bin on the other side holds it as base token,
 * converted at THAT bin's price (binPriceUi); the active bin holds both, split by the pool's own
 * composition in it (every LP in a bin shares the bin's mix). When the quote is token Y the quote
 * side is below the active bin: a fall through the band buys token bin by bin at each bin's price
 * and a recovery sells it back at the same prices, so the deposit returns exactly; what shows as
 * a marked loss in between is the token bought above the current price, valued at the current
 * price. When the quote is token X the sides flip.
 *
 * Fees: while in range, fees per mark = (screen fees24hUsd, else volume24hUsd x dynamicFeePct,
 * else 0) x our share of the band x 0.5 x dt/86400, converted to quote at the SOL price, split
 * half quote / half token at the current price. Our share = deposit / (band depth + deposit),
 * the depth being the snapshot's quote-side liquidity scaled to the band's width, capped at 50%.
 * dt is capped at MAX_MARK_GAP_SEC so a restart never accrues a day of fees in one mark.
 *
 * A MADE PAIR (snapshot.pair, src/venues/pair.ts) accrues the same way with two substitutions: the
 * pool's fees per day are the routing model's (what the reference pool's flow pays us at our fee),
 * and our share is the snapshot's ourShare (1 while nobody else is in our pool) instead of the bin
 * arithmetic. With collectFeeMode "quote" every fee lands on the quote side.
 */
import { binPrice } from "../tools/bins";
import { quoteMath, type BinRow, type PoolSnapshot, type PositionSnapshot } from "../tools/dlmm";
import type { BandValue, PaperBand, PaperBook, PaperMark } from "./book";
import { paperHedgeEquityUsd } from "./hedge";

export const MAX_MARK_GAP_SEC = 3600;
export const MAX_SHARE = 0.5;
/** the active-bin split when the snapshot carries no liquidity row for it */
export const UNKNOWN_SPLIT = 0.5;

/** The fields of a snapshot the mark reads; a test can build one without the rest. */
export type MarkSnapshot = Pick<PoolSnapshot, "activeBinId" | "activePrice" | "binStep" | "bins" | "liquidityBelowY" | "liquidityAboveX" | "dynamicFeePct" | "solSide" | "tokenPriceInSol"> &
  Partial<Pick<PoolSnapshot, "quoteSide" | "quotePriceInSol" | "tokenPriceInQuote" | "solPriceUsd" | "priceModel" | "pair">> & {
    tokenX: Pick<PoolSnapshot["tokenX"], "decimals">;
    tokenY: Pick<PoolSnapshot["tokenY"], "decimals">;
  };

export interface FeeSource {
  fees24hUsd: number | null;
  volume24hUsd: number | null;
}

export interface MarkContext {
  now: number;
  /** the pool's 24h figures from the screen (or the hot watch); null accrues nothing */
  fees: FeeSource | null;
  /** the screen's SOL price; a SOL-quoted pool cannot convert fees without it */
  solPriceUsd: number | null;
}

/** Price of the base token in quote units at a bin (under the band's price model): Y per X when the quote is Y, X per Y when it is X. */
export function quotePerTokenAt(binId: number, band: Pick<PaperBand, "binStep" | "xDecimals" | "yDecimals" | "quoteSide" | "priceModel">): number {
  const p = binPrice({ binStep: band.binStep, priceModel: band.priceModel, tokenX: { decimals: band.xDecimals }, tokenY: { decimals: band.yDecimals } }, binId);
  return band.quoteSide === "Y" ? p : p > 0 ? 1 / p : 0;
}

/** The bins the quote and the token were laid in at open (Spot: even over each set). */
export function depositBins(band: Pick<PaperBand, "lowerBinId" | "upperBinId" | "openedBinId" | "quoteSide">): { quoteBins: number[]; tokenBins: number[] } {
  const quoteBelow = band.quoteSide === "Y";
  const quoteBins: number[] = [];
  const tokenBins: number[] = [];
  for (let i = band.lowerBinId; i <= band.upperBinId; i++) {
    const onQuoteSide = quoteBelow ? i <= band.openedBinId : i >= band.openedBinId;
    const onTokenSide = quoteBelow ? i >= band.openedBinId : i <= band.openedBinId;
    if (onQuoteSide) quoteBins.push(i);
    if (onTokenSide) tokenBins.push(i);
  }
  return { quoteBins, tokenBins };
}

/** Quote notional per bin: what each bin's slice is worth in quote at its own price. */
export function binNotionals(band: Pick<PaperBand, "lowerBinId" | "upperBinId" | "openedBinId" | "quoteSide" | "quoteDeposit" | "tokenDeposit" | "binStep" | "xDecimals" | "yDecimals" | "priceModel">): Map<number, number> {
  const { quoteBins, tokenBins } = depositBins(band);
  const out = new Map<number, number>();
  for (let i = band.lowerBinId; i <= band.upperBinId; i++) out.set(i, 0);
  if (band.quoteDeposit > 0 && quoteBins.length) {
    const per = band.quoteDeposit / quoteBins.length;
    for (const i of quoteBins) out.set(i, out.get(i)! + per);
  }
  if (band.tokenDeposit > 0 && tokenBins.length) {
    const per = band.tokenDeposit / tokenBins.length;
    for (const i of tokenBins) out.set(i, out.get(i)! + per * quotePerTokenAt(i, band));
  }
  return out;
}

/** The quote fraction of the active bin's liquidity in the snapshot (every LP in the bin shares its mix). */
export function activeBinQuoteShare(s: MarkSnapshot, quoteSide: "X" | "Y"): number {
  const row = s.bins.find((b) => b.binId === s.activeBinId);
  if (!row) return UNKNOWN_SPLIT;
  const yValue = row.yAmount;
  const xValue = row.xAmount * (row.price > 0 ? row.price : s.activePrice);
  const total = xValue + yValue;
  if (!(total > 0)) return UNKNOWN_SPLIT;
  return quoteSide === "Y" ? yValue / total : xValue / total;
}

/** What the band holds right now, from its notionals and the active bin. */
export function bandContents(band: PaperBand, s: MarkSnapshot): { amountQuote: number; amountToken: number } {
  const notionals = binNotionals(band);
  const quoteBelow = band.quoteSide === "Y";
  const a = s.activeBinId;
  const split = activeBinQuoteShare(s, band.quoteSide);
  let amountQuote = 0;
  let amountToken = 0;
  for (const [i, n] of notionals) {
    if (n <= 0) continue;
    if (i === a) {
      amountQuote += n * split;
      const per = quotePerTokenAt(i, band);
      if (per > 0) amountToken += (n * (1 - split)) / per;
    } else if (quoteBelow ? i < a : i > a) {
      amountQuote += n;
    } else {
      const per = quotePerTokenAt(i, band);
      if (per > 0) amountToken += n / per;
    }
  }
  return { amountQuote, amountToken };
}

/** Liquidity on the quote side of the active bin, scaled from the observed bins to the band's width, quote units. */
export function bandDepthQuote(band: Pick<PaperBand, "quoteSide" | "lowerBinId" | "upperBinId">, s: MarkSnapshot): number {
  const quoteBelow = band.quoteSide === "Y";
  const observed = s.bins.filter((b) => (quoteBelow ? b.binId < s.activeBinId : b.binId > s.activeBinId)).length || 1;
  const sideLiquidity = quoteBelow ? s.liquidityBelowY : s.liquidityAboveX;
  const width = band.upperBinId - band.lowerBinId + 1;
  return (sideLiquidity / observed) * width;
}

/** Our share of the band's liquidity: deposit / (depth + deposit), capped. */
export function shareOfBand(depositQuote: number, depthQuote: number, cap = MAX_SHARE): number {
  if (!(depositQuote > 0)) return 0;
  const raw = depositQuote / (Math.max(0, depthQuote) + depositQuote);
  return Math.min(cap, raw);
}

/** The pool's fees per day in USD from what the screen knows, else volume x the dynamic fee, else 0. */
export function feesPerDayUsd(fees: FeeSource | null, dynamicFeePct: number): number {
  if (!fees) return 0;
  if (typeof fees.fees24hUsd === "number" && Number.isFinite(fees.fees24hUsd) && fees.fees24hUsd > 0) return fees.fees24hUsd;
  if (typeof fees.volume24hUsd === "number" && Number.isFinite(fees.volume24hUsd) && fees.volume24hUsd > 0 && dynamicFeePct > 0) return (fees.volume24hUsd * dynamicFeePct) / 100;
  return 0;
}

export interface FeeAccrual {
  dtSec: number;
  inRange: boolean;
  shareOfBand: number;
  depthQuote: number;
  feesPerDayUsd: number;
  /** what accrued this mark, quote units, before the split */
  feeQuoteTotal: number;
  feeQuote: number;
  feeToken: number;
  note: string | null;
}

/** Fees accrued since the band's last mark. Pure: the caller adds them to the band. */
export function accrueFees(band: PaperBand, s: MarkSnapshot, ctx: MarkContext, quoteSymbol: "SOL" | "USDC"): FeeAccrual {
  const q = quoteMath(s);
  const dtSec = Math.min(MAX_MARK_GAP_SEC, Math.max(0, (ctx.now - band.lastMarkAt) / 1000));
  const inRange = s.activeBinId >= band.lowerBinId && s.activeBinId <= band.upperBinId;
  const depthQuote = bandDepthQuote(band, s);
  const depositQuote = band.quoteDeposit + band.tokenDeposit * q.tokenPriceInQuote;
  // A made pair: our share of our own pool is what the snapshot says (1 while nobody else is in it),
  // and the fees per day are the routing model's, not a screen figure the pool does not have.
  const pair = s.pair;
  const share = pair && pair.ourShare !== null ? Math.min(1, Math.max(0, pair.ourShare)) : shareOfBand(depositQuote, depthQuote);
  const perDay = pair ? Math.max(0, pair.feesPerDayUsd) : feesPerDayUsd(ctx.fees, s.dynamicFeePct);
  const base: Omit<FeeAccrual, "feeQuoteTotal" | "feeQuote" | "feeToken" | "note"> = { dtSec, inRange, shareOfBand: share, depthQuote, feesPerDayUsd: perDay };
  if (!inRange || dtSec <= 0 || perDay <= 0) {
    const why = !inRange ? "out of range: no fees" : perDay <= 0 ? (pair ? "the routing model sends no flow to our pool: nothing accrued" : "no 24h fee figure for this pool: nothing accrued") : null;
    return { ...base, feeQuoteTotal: 0, feeQuote: 0, feeToken: 0, note: why };
  }
  const feeUsd = perDay * share * 0.5 * (dtSec / 86400);
  let feeQuoteTotal: number;
  if (quoteSymbol === "USDC") feeQuoteTotal = feeUsd;
  else if (ctx.solPriceUsd && ctx.solPriceUsd > 0) feeQuoteTotal = feeUsd / ctx.solPriceUsd;
  else return { ...base, feeQuoteTotal: 0, feeQuote: 0, feeToken: 0, note: "no SOL price to convert fees: nothing accrued" };
  // a made pair collecting in the quote only takes every fee on the quote side
  if (pair?.collectFeeMode === "quote") return { ...base, feeQuoteTotal, feeQuote: feeQuoteTotal, feeToken: 0, note: null };
  const feeQuote = feeQuoteTotal / 2;
  const feeToken = q.tokenPriceInQuote > 0 ? feeQuote / q.tokenPriceInQuote : 0;
  return { ...base, feeQuoteTotal, feeQuote, feeToken: q.tokenPriceInQuote > 0 ? feeToken : 0, note: null };
}

/** The band's contents and marks at this snapshot, without touching the band. */
export function valueBand(band: PaperBand, s: MarkSnapshot): BandValue {
  const q = quoteMath(s);
  const { amountQuote, amountToken } = bandContents(band, s);
  return {
    amountQuote,
    amountToken,
    feeQuote: band.feeQuote,
    feeToken: band.feeToken,
    tokenPriceInQuote: q.tokenPriceInQuote,
    quotePriceInSol: q.priceInSol,
    activeBinId: s.activeBinId,
    price: s.activePrice,
    inRange: s.activeBinId >= band.lowerBinId && s.activeBinId <= band.upperBinId,
  };
}

/** The PositionSnapshot the loop, the guards, the engine and the journal expect. */
export function toPaperPosition(band: PaperBand, v: BandValue, s: MarkSnapshot): PositionSnapshot {
  const quoteIsX = band.quoteSide === "X";
  const amountX = quoteIsX ? v.amountQuote : v.amountToken;
  const amountY = quoteIsX ? v.amountToken : v.amountQuote;
  const feeX = quoteIsX ? v.feeQuote : v.feeToken;
  const feeY = quoteIsX ? v.feeToken : v.feeQuote;
  const inRange = v.inRange;
  const binsFromRange = inRange ? 0 : s.activeBinId < band.lowerBinId ? s.activeBinId - band.lowerBinId : s.activeBinId - band.upperBinId;
  const quoteInPosition = v.amountQuote + v.feeQuote;
  const valueInSol = (quoteInPosition + (v.amountToken + v.feeToken) * v.tokenPriceInQuote) * v.quotePriceInSol;
  return {
    address: band.address,
    lowerBinId: band.lowerBinId,
    upperBinId: band.upperBinId,
    lowerPrice: band.lowerPrice,
    upperPrice: band.upperPrice,
    widthBins: band.upperBinId - band.lowerBinId + 1,
    inRange,
    binsFromRange,
    amountX,
    amountY,
    feeX,
    feeY,
    valueInSol,
    solInPosition: quoteInPosition * v.quotePriceInSol,
    quoteInPosition,
    lastUpdatedAt: Math.floor(band.lastMarkAt / 1000),
    entryValueSol: band.entryValueSol,
  };
}

export interface MarkedBand {
  band: PaperBand;
  value: BandValue;
  position: PositionSnapshot;
  fees: FeeAccrual;
}

/** Mark one band: accrue fees, refresh its last-mark fields, return the loop's view of it. */
export function markBand(band: PaperBand, s: MarkSnapshot, ctx: MarkContext): MarkedBand {
  const fees = accrueFees(band, s, ctx, band.quoteSymbol);
  band.feeQuote += fees.feeQuote;
  band.feeToken += fees.feeToken;
  band.lastMarkAt = Math.max(band.lastMarkAt, ctx.now);
  band.lastActiveBinId = s.activeBinId;
  const value = valueBand(band, s);
  const position = toPaperPosition(band, value, s);
  const mark: PaperMark = {
    at: ctx.now,
    activeBinId: s.activeBinId,
    price: s.activePrice,
    tokenPriceInQuote: value.tokenPriceInQuote,
    quotePriceInSol: value.quotePriceInSol,
    valueInSol: position.valueInSol,
    quoteInPosition: position.quoteInPosition ?? position.solInPosition,
    amountQuote: value.amountQuote,
    amountToken: value.amountToken,
    feeSol: (value.feeQuote + value.feeToken * value.tokenPriceInQuote) * value.quotePriceInSol,
    inRange: value.inRange,
    binsFromRange: position.binsFromRange,
  };
  band.lastMark = mark;
  return { band, value, position, fees };
}

/** Mark every band of a pool and remember the token's price for the offline report. Returns the loop's positions. */
export function markPool(book: PaperBook, s: PoolSnapshot, ctx: MarkContext): PositionSnapshot[] {
  book.tokenMarks[s.baseToken.mint] = { symbol: s.baseToken.symbol, priceInSol: s.tokenPriceInSol, at: ctx.now };
  if (ctx.solPriceUsd && ctx.solPriceUsd > 0) book.solPriceUsd = ctx.solPriceUsd;
  else if (s.solPriceUsd && s.solPriceUsd > 0) book.solPriceUsd = s.solPriceUsd;
  book.lastMarkAt = ctx.now;
  // a made pair remembers what the model said at this mark, for the offline report
  const made = s.pair ? book.pairPools?.[s.address] : undefined;
  if (made && s.pair) {
    made.lastRoutedShare = s.pair.routedShare;
    made.lastRoutedShareGross = s.pair.routedShareGross;
    made.lastFeesPerDayUsd = s.pair.feesPerDayUsd;
    made.lastPrice = s.activePrice;
    made.lastMarkAt = ctx.now;
    made.lastRefStale = s.pair.stale;
  }
  return book.bands.filter((b) => b.pool === s.address).map((b) => markBand(b, s, ctx).position);
}

/**
 * The bin rows our own paper bands occupy in a pool, at an active bin: what a made pair's synthetic
 * snapshot shows as its liquidity (nobody else is in the pool). Quote-side bins hold quote, token-side
 * bins hold token at their own bin price, the active bin splits UNKNOWN_SPLIT.
 */
export function paperBinRows(book: PaperBook, pool: string, activeBinId: number, binsEachSide: number, geometry: { binStep: number; xDecimals: number; yDecimals: number }): BinRow[] {
  const rows = new Map<number, BinRow>();
  const price = (i: number) => binPrice({ binStep: geometry.binStep, tokenX: { decimals: geometry.xDecimals }, tokenY: { decimals: geometry.yDecimals } }, i);
  for (let i = activeBinId - binsEachSide; i <= activeBinId + binsEachSide; i++) rows.set(i, { binId: i, price: price(i), xAmount: 0, yAmount: 0, isActive: i === activeBinId });
  for (const band of book.bands) {
    if (band.pool !== pool) continue;
    const quoteBelow = band.quoteSide === "Y";
    for (const [i, n] of binNotionals(band)) {
      if (n <= 0) continue;
      const row = rows.get(i);
      if (!row) continue;
      const per = quotePerTokenAt(i, band);
      const quoteHere = i === activeBinId ? n * UNKNOWN_SPLIT : (quoteBelow ? i < activeBinId : i > activeBinId) ? n : 0;
      const tokenHere = per > 0 ? (n - quoteHere) / per : 0;
      if (quoteBelow) {
        row.yAmount += quoteHere;
        row.xAmount += tokenHere;
      } else {
        row.xAmount += quoteHere;
        row.yAmount += tokenHere;
      }
    }
  }
  return [...rows.values()];
}

/**
 * Every open band at its last mark plus the wallet, in SOL. Null marks count at zero. tokensMarkedSol
 * is the wallet's token inventory against its cost basis. hedgeSol is the virtual perp book's net
 * P&L (src/paper/hedge.ts) at the last SOL price; it is part of equitySol.
 */
export function bookEquitySol(book: PaperBook): { walletSol: number; usdcSol: number; tokensSol: number; tokensBasisSol: number; tokensMarkedSol: number; bandsSol: number; feesUnclaimedSol: number; hedgeSol: number; hedgeUsd: number; equitySol: number } {
  const usdcInSol = book.solPriceUsd && book.solPriceUsd > 0 ? 1 / book.solPriceUsd : 0;
  const hedgeUsd = paperHedgeEquityUsd(book.hedge).netUsd;
  const hedgeSol = hedgeUsd * usdcInSol;
  const usdcSol = book.wallet.usdc * usdcInSol;
  let tokensSol = 0;
  let tokensBasisSol = 0;
  for (const [mint, units] of Object.entries(book.wallet.tokens)) {
    tokensSol += units * (book.tokenMarks[mint]?.priceInSol ?? 0);
    tokensBasisSol += book.tokenBasisSol?.[mint] ?? 0;
  }
  let bandsSol = 0;
  let feesUnclaimedSol = 0;
  for (const b of book.bands) {
    bandsSol += b.lastMark?.valueInSol ?? b.entryValueSol;
    feesUnclaimedSol += b.lastMark?.feeSol ?? 0;
  }
  return { walletSol: book.wallet.sol, usdcSol, tokensSol, tokensBasisSol, tokensMarkedSol: tokensSol - tokensBasisSol, bandsSol, feesUnclaimedSol, hedgeSol, hedgeUsd, equitySol: book.wallet.sol + usdcSol + tokensSol + bandsSol + hedgeSol };
}

/** Base token held in a pool's paper bands at their last marks (incl. unclaimed base fees): the hedge's inventory. */
export function paperPoolTokenInventory(book: PaperBook, pool: string): number {
  let total = 0;
  for (const b of book.bands) {
    if (b.pool !== pool) continue;
    total += b.lastMark ? b.lastMark.amountToken + b.feeToken : b.tokenDeposit + b.feeToken;
  }
  return total;
}
