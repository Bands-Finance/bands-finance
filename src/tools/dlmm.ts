import DLMM, { deriveBinArray, LbPosition, StrategyType } from "@meteora-ag/dlmm";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { config } from "../config";
import type { StockTag } from "../screener/types";
import { binPrice, type BandSide, type PriceModel } from "./bins";
import type { VenueId } from "../venues/types";
import { transferFeeFor, type TransferFee } from "./transferFee";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
/** The USDC mint (config USDC_MINT). USDC is the second quote the desk trades; every xStock pool is USDC-quoted. */
export const USDC_MINT = config.usdcMint;

/** The quotes the desk can size, guard and ledger. Everything is still accounted in SOL; a USDC figure is converted at the SOL price. */
export type QuoteSymbol = "SOL" | "USDC";

/** Mint -> symbol. Extend as you add pools. Unknown mints render as a short hash. */
export const KNOWN_TOKENS: Record<string, string> = {
  [SOL_MINT]: "SOL",
  [USDC_MINT]: "USDC",
  "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump": "ANSEM",
};

/**
 * Refundable rent for a position account (SDK POSITION_FEE, 8248 bytes at the old 6960 lamports a byte). Kept as
 * the conservative up-front ESTIMATE the policy and the guards size with; it is not what the chain refunds today.
 */
export const POSITION_RENT_SOL = 0.0574;
/** Rent-exempt lamports per account byte (incl. its 128 bytes of overhead), measured on mainnet 2026-09-14. */
export const RENT_LAMPORTS_PER_BYTE = 5080;
/** A DLMM position account, the SDK's POSITION_MIN_SIZE: 8120 bytes of data. */
export const POSITION_ACCOUNT_BYTES = 8120;
/**
 * What a position account opened today holds, and so what closing it refunds: (8120 + 128) x 5080 lamports =
 * 0.04189984 SOL, exactly what 57 of the 68 real opens of 17-19 Sep measured. A live close books the account's
 * own lamports read before the close (src/executor.ts); this is the figure when that read fails.
 */
export const POSITION_RENT_NOW_SOL = ((POSITION_ACCOUNT_BYTES + 128) * RENT_LAMPORTS_PER_BYTE) / 1e9;
/** Rent for a bin array account. Paid once per array by whoever initializes it; not refunded to the LP. */
export const BIN_ARRAY_RENT_SOL = 0.0715;
/** Conservative up-front cost estimate for opening a band that may need two fresh bin arrays. */
export const OPEN_COST_ESTIMATE_SOL = POSITION_RENT_SOL + 2 * BIN_ARRAY_RENT_SOL;

export function symbolFor(mint: string): string {
  return KNOWN_TOKENS[mint] ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

export interface TokenInfo {
  mint: string;
  symbol: string;
  decimals: number;
  /** pool reserve in UI units */
  reserve: number;
  /** a Token-2022 mint's transfer fee (src/tools/transferFee.ts): every move in or out of the wallet pays it; absent or null = none */
  transferFee?: TransferFee | null;
}

export interface BinRow {
  binId: number;
  /** price of X in Y, UI units */
  price: number;
  xAmount: number;
  yAmount: number;
  isActive: boolean;
}

export interface PoolSnapshot {
  address: string;
  label: string;
  tokenX: TokenInfo;
  tokenY: TokenInfo;
  /** which side of the pair is native SOL (null if neither, e.g. a USDC-quoted pool) */
  solSide: "X" | "Y" | null;
  /** the token being made a market in: the non-quote side */
  baseToken: TokenInfo;
  binStep: number;
  activeBinId: number;
  /** price of one X in Y, UI units */
  activePrice: number;
  priceLabel: string;
  /** base token priced in SOL: tokenPriceInQuote x quotePriceInSol (every SOL-denominated consumer reads this) */
  tokenPriceInSol: number;
  baseFeePct: number;
  maxFeePct: number;
  dynamicFeePct: number;
  bins: BinRow[];
  /** Y liquidity sitting in the observed bins below active (bid depth) */
  liquidityBelowY: number;
  /** X liquidity sitting in the observed bins above active (ask depth) */
  liquidityAboveX: number;
  fetchedAt: string;
  // ---- the quote abstraction. Optional on the type so a snapshot literal built before it existed
  //      (tests, callers outside this repo) still types; read them through quoteOf() / quoteMath(),
  //      which default to the SOL-quoted meaning: quoteSide = solSide ?? "Y", quotePriceInSol = 1.
  /** which side of the pair is the quote token (SOL or USDC) */
  quoteSide?: "X" | "Y";
  quoteToken?: TokenInfo;
  quoteSymbol?: QuoteSymbol;
  /** one quote token in SOL: 1 for SOL pools, 1 / solPriceUsd for USDC pools */
  quotePriceInSol?: number;
  /** base token priced in the quote token, UI units (what the LLM and the paper desk size in) */
  tokenPriceInQuote?: number;
  /** the SOL price the quote conversion used, when one was known (informational for SOL pools) */
  solPriceUsd?: number | null;
  // ---- the venue. Absent on snapshots written before venues existed: Meteora DLMM.
  /** which price model the bins follow (src/tools/bins.ts); absent = meteora-dlmm */
  priceModel?: PriceModel;
  /** the venue the pool was read from; absent = meteora-dlmm */
  venue?: VenueId;
  /** CLMM: the pool charges a variable fee on top of the base (Raydium dynamic fee); Meteora's variable fee is dynamicFeePct */
  hasDynamicFee?: boolean;
  /** CLMM only: the tick state behind the bins (src/venues/raydium.ts) */
  clmm?: ClmmState;
  /** Meteora only: which bin arrays around the price exist on chain (src/venues/meteora.ts sizes rent from it) */
  dlmm?: DlmmState;
  /** a pool the desk made (or will make) for a pump.fun token, the PAIR LANE (src/venues/pair.ts, src/screener/pair.ts); absent elsewhere */
  pair?: PairSnapshotInfo;
}

/**
 * What a made pair's snapshot knows beyond the bins: where its price comes from, what the routing
 * model says, and what it costs to bring into being. The paper mark reads ourShare, feesPerDayUsd and
 * collectFeeMode; the policy and the journal read the rest.
 */
export interface PairSnapshotInfo {
  /** the loop's key for the pool: pair-<mint> */
  address: string;
  mint: string;
  symbol: string;
  quote: QuoteSymbol;
  /** the customizable-permissionless pool address Meteora derives for (token, quote); the real pool once it exists */
  lbPair: string | null;
  /** the pool exists: on chain, or in the paper book */
  exists: boolean;
  /** the desk created it (a pair created by someone else is seated, not made) */
  ours: boolean;
  /** the snapshot was made from the reference price rather than read from a pool */
  synthetic: boolean;
  /** the reference row has gone cold: the price is the last one seen, and the fade exit is on its way */
  stale: boolean;
  refPool: string | null;
  refVenue: string | null;
  refLiquidityUsd: number | null;
  refVol24hUsd: number | null;
  refVol1hUsd: number | null;
  refAgeHours: number | null;
  /** competing concentrated depth for the mint, USD */
  competingDepthUsd: number;
  /** the routing model: before and after the split with competitors, and what it pays */
  routedShareGross: number;
  routedShare: number;
  routedVolume24hUsd: number;
  feesPerDayUsd: number;
  /** our share of the pool's fees: 1 while nobody else is in it, null to fall back to the bin arithmetic */
  ourShare: number | null;
  collectFeeMode: "quote" | "both";
  /** rent that never comes back when the pool must be created first (0 when it exists) */
  creationRentSol: number;
  /** the seat the model was sized for, USD */
  seatUsd: number;
  /** a STOCK pair (src/screener/pairStock.ts): the tokenized stock our pool quotes in SOL; absent on pump.fun pairs */
  stock?: StockTag | null;
  /** stock pairs: where the synthetic price came from (the perp mid, the reference pool's USD price, or the last one seen) */
  priceSource?: "perp" | "reference" | "last" | "pool";
  /** stock pairs: consecutive snapshots the reference has been off the board (the lane closes at PAIR_STOCK_REF_GONE_CYCLES) */
  refGoneCycles?: number;
  /** stock pairs: the reference pool's fee the model priced the two-hop route with, percent */
  refFeePct?: number;
  /** stock pairs: fees per day before the split with competing SOL-quoted depth */
  feesPerDayGrossUsd?: number;
  /** stock pairs: the bins per side the model priced our depth at */
  modelBinsPerSide?: number;
  /** a HOUSE token's pool (PAIR_HOUSE_MINTS, src/screener/pair.ts): always seated, no launch-style exits */
  house?: boolean;
  /** false when the model had no reference row to read (a house token before its first pool): share n/a, nothing accrues */
  refKnown?: boolean;
}

/** What a CLMM snapshot keeps of the pool's tick state, enough to size a band's rent without the chain. */
export interface ClmmState {
  tickSpacing: number;
  tickCurrent: number;
  /** the pool's sqrt price, Q64.64, as a decimal string */
  sqrtPriceX64: string;
  /** the pool's active liquidity, as a decimal string */
  liquidity: string;
  /** start ticks of the tick arrays that exist on chain around the price; a band landing outside them pays tick-array rent */
  initializedTickArrays: number[];
}

/** Bins per Meteora bin array (the SDK's MAX_BIN_ARRAY_SIZE). */
export const BINS_PER_BIN_ARRAY = 70;
/** Bin arrays read either side of the active one: a band wider than this pays for what it cannot see. */
export const BIN_ARRAYS_EACH_SIDE = 2;

/** What a DLMM snapshot keeps of the pool's bin arrays, enough to size a band's rent without the chain. */
export interface DlmmState {
  /** indexes of the bin arrays that exist on chain, of the ones read around the active bin */
  initializedBinArrays: number[];
  /** the indexes that were read; an index outside them is unknown and priced as fresh */
  readBinArrays: number[];
}

/** PURE. The bin array holding a bin (floor division, as the SDK's binIdToBinArrayIndex). */
export const binArrayIndexOf = (binId: number): number => Math.floor(binId / BINS_PER_BIN_ARRAY);

/** The quote side of a snapshot with the SOL-pool defaults filled in. */
export interface QuoteView {
  side: "X" | "Y";
  symbol: QuoteSymbol;
  token: TokenInfo;
  /** one quote token in SOL */
  priceInSol: number;
  /** base token in quote units */
  tokenPriceInQuote: number;
}

type QuoteMathInput = Pick<PoolSnapshot, "solSide" | "tokenPriceInSol"> & Partial<Pick<PoolSnapshot, "quoteSide" | "quotePriceInSol" | "tokenPriceInQuote">>;

/** The numbers of the quote side for a snapshot or any Pick of one: SOL-quoted defaults when the quote fields are absent. */
export function quoteMath(s: QuoteMathInput): Pick<QuoteView, "side" | "priceInSol" | "tokenPriceInQuote"> {
  const side: "X" | "Y" = s.quoteSide ?? (s.solSide === "X" ? "X" : "Y");
  const priceInSol = typeof s.quotePriceInSol === "number" && Number.isFinite(s.quotePriceInSol) && s.quotePriceInSol > 0 ? s.quotePriceInSol : 1;
  const tokenPriceInQuote = typeof s.tokenPriceInQuote === "number" && Number.isFinite(s.tokenPriceInQuote) ? s.tokenPriceInQuote : s.tokenPriceInSol / priceInSol;
  return { side, priceInSol, tokenPriceInQuote };
}

/** The full quote view of a snapshot, token and symbol included. */
export function quoteOf(s: PoolSnapshot): QuoteView {
  const m = quoteMath(s);
  const token = s.quoteToken ?? (m.side === "X" ? s.tokenX : s.tokenY);
  const symbol: QuoteSymbol = s.quoteSymbol ?? (token.mint === USDC_MINT ? "USDC" : "SOL");
  return { ...m, token, symbol };
}

/** Thrown by getPoolSnapshot for a USDC-quoted pool when no SOL price is known: the pool cannot be valued in SOL, so it is not tradable this cycle. */
export class QuotePriceUnknownError extends Error {
  constructor(readonly pool: string, label: string) {
    super(`${label} (${pool}) is USDC-quoted and no SOL price is known: pass solPriceUsd (the screen's) to getPoolSnapshot or call setSolPriceUsd(); skipping it keeps the book valued in SOL`);
    this.name = "QuotePriceUnknownError";
  }
}

/** Thrown by getPoolSnapshot for a pool quoted in neither SOL nor USDC: the guards and the ledger have no unit for it. */
export class UnsupportedQuoteError extends Error {
  constructor(readonly pool: string, label: string) {
    super(`${label} (${pool}) is quoted in neither SOL nor USDC: not tradable by the desk`);
    this.name = "UnsupportedQuoteError";
  }
}

let solPriceUsdDefault: number | null = null;

/** The SOL price getPoolSnapshot falls back to when the caller passes none (the loop sets it from each screen). */
export function setSolPriceUsd(price: number | null | undefined): void {
  solPriceUsdDefault = typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
}

export function getSolPriceUsd(): number | null {
  return solPriceUsdDefault;
}

export interface PositionSnapshot {
  address: string;
  lowerBinId: number;
  upperBinId: number;
  lowerPrice: number;
  upperPrice: number;
  widthBins: number;
  inRange: boolean;
  /** 0 when in range; negative = active bin is below the band; positive = above */
  binsFromRange: number;
  amountX: number;
  amountY: number;
  feeX: number;
  feeY: number;
  /** total value incl. unclaimed fees, in SOL (a USDC pool is valued through quotePriceInSol) */
  valueInSol: number;
  /** quote-side tokens in the position incl. quote fees, in SOL-equivalent (= quoteInPosition x quotePriceInSol; for SOL pools, what returns as SOL on close before rent) */
  solInPosition: number;
  /** quote-side tokens in the position incl. quote fees, in quote units (what returns as quote on close, before rent); absent on snapshots written before USDC pools existed (then = solInPosition) */
  quoteInPosition?: number;
  lastUpdatedAt: number;
  /** value in SOL when the band was opened (or first seen); set by the loop from risk state */
  entryValueSol?: number;
  /** the rent closing the band refunds, SOL, when the book knows it (a paper band's recorded refund); the site adds it to equity */
  rentSol?: number;
}

/** DLMM bin price: (1 + binStep/10000)^binId per lamport, scaled to UI decimals. */
export function binPriceUi(binId: number, binStep: number, xDecimals: number, yDecimals: number): number {
  return Math.pow(1 + binStep / 10_000, binId) * Math.pow(10, xDecimals - yDecimals);
}

function ui(raw: bigint | string | BN, decimals: number): number {
  return Number(raw.toString()) / 10 ** decimals;
}

/** Convert a UI amount to raw units without float precision loss. */
export function toRawBN(amount: number, decimals: number): BN {
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`bad amount ${amount}`);
  const [whole, frac = ""] = amount.toFixed(decimals).split(".");
  const raw = `${whole}${frac.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return new BN(raw);
}

/** Value of (amountX, amountY) in the quote token, UI units. */
export function toQuote(amountX: number, amountY: number, s: PoolSnapshot): number {
  if (quoteMath(s).side === "X") return amountX + (s.activePrice > 0 ? amountY / s.activePrice : 0);
  return amountY + amountX * s.activePrice;
}

/** Value of (amountX, amountY) expressed in SOL: the quote value at quotePriceInSol (1 for a SOL pool, so unchanged there). */
export function toSol(amountX: number, amountY: number, s: PoolSnapshot): number {
  return toQuote(amountX, amountY, s) * quoteMath(s).priceInSol;
}

export async function loadPool(connection: Connection, address: string): Promise<DLMM> {
  return DLMM.create(connection, new PublicKey(address));
}

export interface SnapshotOptions {
  /** the SOL price in USD, needed to value a USDC-quoted pool; defaults to setSolPriceUsd()'s value */
  solPriceUsd?: number | null;
}

/** The quote view of a pair, resolved the same way on every venue (see resolveQuote). */
export interface ResolvedQuote {
  solSide: "X" | "Y" | null;
  quoteSide: "X" | "Y";
  quoteSymbol: QuoteSymbol;
  quoteToken: TokenInfo;
  baseToken: TokenInfo;
  quotePriceInSol: number;
  tokenPriceInQuote: number;
  tokenPriceInSol: number;
  solPriceUsd: number | null;
}

/**
 * Which side of a pair is the quote and what the base is worth, for any venue: SOL when the pool has
 * it (SOL/USDC itself is a SOL pool), else USDC valued at the SOL price, else unsupported. Throws
 * QuotePriceUnknownError / UnsupportedQuoteError exactly as getPoolSnapshot always has.
 */
export function resolveQuote(i: { address: string; label: string; tokenX: TokenInfo; tokenY: TokenInfo; activePrice: number; solPriceUsd?: number | null }): ResolvedQuote {
  const xMint = i.tokenX.mint;
  const yMint = i.tokenY.mint;
  const solSide: PoolSnapshot["solSide"] = xMint === SOL_MINT ? "X" : yMint === SOL_MINT ? "Y" : null;
  const quoteSide: "X" | "Y" | null = solSide ?? (xMint === USDC_MINT ? "X" : yMint === USDC_MINT ? "Y" : null);
  if (!quoteSide) throw new UnsupportedQuoteError(i.address, i.label);
  const quoteSymbol: QuoteSymbol = solSide ? "SOL" : "USDC";
  const quoteToken = quoteSide === "X" ? i.tokenX : i.tokenY;
  const baseToken = quoteSide === "X" ? i.tokenY : i.tokenX;
  const solPriceUsd = i.solPriceUsd !== undefined ? (typeof i.solPriceUsd === "number" && Number.isFinite(i.solPriceUsd) && i.solPriceUsd > 0 ? i.solPriceUsd : null) : solPriceUsdDefault;
  if (quoteSymbol === "USDC" && solPriceUsd === null) throw new QuotePriceUnknownError(i.address, i.label);
  const quotePriceInSol = quoteSymbol === "SOL" ? 1 : 1 / solPriceUsd!;
  const tokenPriceInQuote = quoteSide === "X" ? (i.activePrice > 0 ? 1 / i.activePrice : 0) : i.activePrice;
  return { solSide, quoteSide, quoteSymbol, quoteToken, baseToken, quotePriceInSol, tokenPriceInQuote, tokenPriceInSol: tokenPriceInQuote * quotePriceInSol, solPriceUsd };
}

/**
 * Read a pool. A SOL-quoted pool needs nothing else. A USDC-quoted pool needs a SOL price
 * (opts.solPriceUsd, else the module default from setSolPriceUsd) and throws
 * QuotePriceUnknownError without one: a pool the desk cannot value in SOL is not observed,
 * so no guard, breaker or ledger row ever sees an unconverted USDC figure. A pool quoted in
 * neither throws UnsupportedQuoteError.
 */
export async function getPoolSnapshot(dlmm: DLMM, binsEachSide = 10, opts: SnapshotOptions = {}): Promise<PoolSnapshot> {
  await dlmm.refetchStates();
  const [active, around] = await Promise.all([
    dlmm.getActiveBin(),
    dlmm.getBinsAroundActiveBin(binsEachSide, binsEachSide),
  ]);

  const xMint = dlmm.tokenX.publicKey.toBase58();
  const yMint = dlmm.tokenY.publicKey.toBase58();
  const xDec = dlmm.tokenX.mint.decimals;
  const yDec = dlmm.tokenY.mint.decimals;

  // a Token-2022 transfer fee is read off the mints DLMM.create already loaded, once per mint (src/tools/transferFee.ts)
  const feeX = transferFeeFor(xMint, dlmm.tokenX.mint);
  const feeY = transferFeeFor(yMint, dlmm.tokenY.mint);
  const tokenX: TokenInfo = { mint: xMint, symbol: symbolFor(xMint), decimals: xDec, reserve: ui(dlmm.tokenX.amount, xDec), ...(feeX ? { transferFee: feeX } : {}) };
  const tokenY: TokenInfo = { mint: yMint, symbol: symbolFor(yMint), decimals: yDec, reserve: ui(dlmm.tokenY.amount, yDec), ...(feeY ? { transferFee: feeY } : {}) };
  const address = dlmm.pubkey.toBase58();
  const label = `${tokenX.symbol}/${tokenY.symbol}`;
  const activePrice = Number(active.pricePerToken);
  // The quote: SOL when the pool has it (SOL/USDC itself is a SOL pool), else USDC, else unsupported.
  const { solSide, quoteSide, quoteSymbol, quoteToken, baseToken, quotePriceInSol, tokenPriceInQuote, tokenPriceInSol, solPriceUsd } = resolveQuote({ address, label, tokenX, tokenY, activePrice, solPriceUsd: opts.solPriceUsd });

  const fee = dlmm.getFeeInfo();
  const dyn = dlmm.getDynamicFee();

  // Which bin arrays around the price exist: an open only pays rent for the ones it creates. A failed
  // read leaves the state out, and the open is priced at the two-array estimate.
  let dlmmState: DlmmState | undefined;
  try {
    const mid = binArrayIndexOf(active.binId);
    const readBinArrays = Array.from({ length: 2 * BIN_ARRAYS_EACH_SIDE + 1 }, (_, i) => mid - BIN_ARRAYS_EACH_SIDE + i);
    const keys = readBinArrays.map((i) => deriveBinArray(dlmm.pubkey, new BN(i), dlmm.program.programId)[0]);
    const infos = await dlmm.program.provider.connection.getMultipleAccountsInfo(keys);
    dlmmState = { readBinArrays, initializedBinArrays: readBinArrays.filter((_, k) => !!infos[k]) };
  } catch {
    dlmmState = undefined;
  }

  const bins: BinRow[] = around.bins.map((b) => ({
    binId: b.binId,
    price: Number(b.pricePerToken),
    xAmount: ui(b.xAmount, xDec),
    yAmount: ui(b.yAmount, yDec),
    isActive: b.binId === active.binId,
  }));

  return {
    address,
    label,
    tokenX,
    tokenY,
    solSide,
    baseToken,
    binStep: dlmm.lbPair.binStep,
    activeBinId: active.binId,
    activePrice,
    priceLabel: `${tokenY.symbol} per ${tokenX.symbol}`,
    tokenPriceInSol,
    quoteSide,
    quoteToken,
    quoteSymbol,
    quotePriceInSol,
    tokenPriceInQuote,
    solPriceUsd,
    baseFeePct: fee.baseFeeRatePercentage.toNumber(),
    maxFeePct: fee.maxFeeRatePercentage.toNumber(),
    dynamicFeePct: dyn.toNumber(),
    bins,
    liquidityBelowY: bins.filter((b) => b.binId < active.binId).reduce((s, b) => s + b.yAmount, 0),
    liquidityAboveX: bins.filter((b) => b.binId > active.binId).reduce((s, b) => s + b.xAmount, 0),
    fetchedAt: new Date().toISOString(),
    priceModel: "meteora-dlmm",
    venue: "meteora-dlmm",
    ...(dlmmState ? { dlmm: dlmmState } : {}),
  };
}

export function toPositionSnapshot(p: LbPosition, s: PoolSnapshot): PositionSnapshot {
  const d = p.positionData;
  const xDec = s.tokenX.decimals;
  const yDec = s.tokenY.decimals;
  const amountX = ui(d.totalXAmount, xDec);
  const amountY = ui(d.totalYAmount, yDec);
  const feeX = ui(d.feeX, xDec);
  const feeY = ui(d.feeY, yDec);
  const inRange = s.activeBinId >= d.lowerBinId && s.activeBinId <= d.upperBinId;
  const binsFromRange = inRange
    ? 0
    : s.activeBinId < d.lowerBinId
      ? s.activeBinId - d.lowerBinId
      : s.activeBinId - d.upperBinId;
  const q = quoteMath(s);
  const quoteInPosition = q.side === "X" ? amountX + feeX : amountY + feeY;
  const solInPosition = quoteInPosition * q.priceInSol;
  return {
    address: p.publicKey.toBase58(),
    lowerBinId: d.lowerBinId,
    upperBinId: d.upperBinId,
    lowerPrice: binPrice(s, d.lowerBinId),
    upperPrice: binPrice(s, d.upperBinId),
    widthBins: d.upperBinId - d.lowerBinId + 1,
    inRange,
    binsFromRange,
    amountX,
    amountY,
    feeX,
    feeY,
    valueInSol: toSol(amountX + feeX, amountY + feeY, s),
    solInPosition,
    quoteInPosition,
    lastUpdatedAt: Number(d.lastUpdatedAt.toString()),
  };
}

export async function getUserPositions(
  dlmm: DLMM,
  owner: PublicKey,
  s: PoolSnapshot,
): Promise<{ raw: LbPosition[]; positions: PositionSnapshot[] }> {
  const { userPositions } = await dlmm.getPositionsByUserAndLbPair(owner);
  return { raw: userPositions, positions: userPositions.map((p) => toPositionSnapshot(p, s)) };
}

export interface OpenPlan {
  minBinId: number;
  maxBinId: number;
  amountX: BN;
  amountY: BN;
  strategyType: StrategyType;
  slippagePct: number;
  /** the decision's side; a CLMM venue uses it to keep a single-sided band on one side of the price (absent = BOTH) */
  side?: BandSide;
}

export const STRATEGY_BY_NAME: Record<"Spot" | "Curve" | "BidAsk", StrategyType> = {
  Spot: StrategyType.Spot,
  Curve: StrategyType.Curve,
  BidAsk: StrategyType.BidAsk,
};

export async function buildOpenPositionTx(
  dlmm: DLMM,
  owner: PublicKey,
  plan: OpenPlan,
): Promise<{ tx: Transaction; positionKeypair: Keypair }> {
  const positionKeypair = Keypair.generate();
  const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: positionKeypair.publicKey,
    totalXAmount: plan.amountX,
    totalYAmount: plan.amountY,
    strategy: { minBinId: plan.minBinId, maxBinId: plan.maxBinId, strategyType: plan.strategyType },
    user: owner,
    slippage: plan.slippagePct,
  });
  return { tx, positionKeypair };
}

/** Remove 100% of liquidity, claim fees and close the position account (rent refunded). */
export async function buildClosePositionTxs(dlmm: DLMM, owner: PublicKey, position: LbPosition): Promise<Transaction[]> {
  return dlmm.removeLiquidity({
    user: owner,
    position: position.publicKey,
    fromBinId: position.positionData.lowerBinId,
    toBinId: position.positionData.upperBinId,
    bps: new BN(10_000),
    shouldClaimAndClose: true,
  });
}

export async function buildClaimFeesTxs(dlmm: DLMM, owner: PublicKey, positions: LbPosition[]): Promise<Transaction[]> {
  return dlmm.claimAllSwapFee({ owner, positions });
}
