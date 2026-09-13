import DLMM, { LbPosition, StrategyType } from "@meteora-ag/dlmm";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { config } from "../config";

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

/** Refundable rent for a position account (SDK POSITION_FEE). */
export const POSITION_RENT_SOL = 0.0574;
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
}

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

  const tokenX: TokenInfo = { mint: xMint, symbol: symbolFor(xMint), decimals: xDec, reserve: ui(dlmm.tokenX.amount, xDec) };
  const tokenY: TokenInfo = { mint: yMint, symbol: symbolFor(yMint), decimals: yDec, reserve: ui(dlmm.tokenY.amount, yDec) };
  const address = dlmm.pubkey.toBase58();
  const label = `${tokenX.symbol}/${tokenY.symbol}`;
  const solSide: PoolSnapshot["solSide"] = xMint === SOL_MINT ? "X" : yMint === SOL_MINT ? "Y" : null;
  // The quote: SOL when the pool has it (SOL/USDC itself is a SOL pool), else USDC, else unsupported.
  const quoteSide: "X" | "Y" | null = solSide ?? (xMint === USDC_MINT ? "X" : yMint === USDC_MINT ? "Y" : null);
  if (!quoteSide) throw new UnsupportedQuoteError(address, label);
  const quoteSymbol: QuoteSymbol = solSide ? "SOL" : "USDC";
  const quoteToken = quoteSide === "X" ? tokenX : tokenY;
  const baseToken = quoteSide === "X" ? tokenY : tokenX;
  const solPriceUsd = opts.solPriceUsd !== undefined ? (typeof opts.solPriceUsd === "number" && Number.isFinite(opts.solPriceUsd) && opts.solPriceUsd > 0 ? opts.solPriceUsd : null) : solPriceUsdDefault;
  if (quoteSymbol === "USDC" && solPriceUsd === null) throw new QuotePriceUnknownError(address, label);
  const quotePriceInSol = quoteSymbol === "SOL" ? 1 : 1 / solPriceUsd!;

  const activePrice = Number(active.pricePerToken);
  const tokenPriceInQuote = quoteSide === "X" ? (activePrice > 0 ? 1 / activePrice : 0) : activePrice;
  const tokenPriceInSol = tokenPriceInQuote * quotePriceInSol;

  const fee = dlmm.getFeeInfo();
  const dyn = dlmm.getDynamicFee();

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
    lowerPrice: binPriceUi(d.lowerBinId, s.binStep, xDec, yDec),
    upperPrice: binPriceUi(d.upperBinId, s.binStep, xDec, yDec),
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
