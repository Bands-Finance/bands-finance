import DLMM, { LbPosition, StrategyType } from "@meteora-ag/dlmm";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

/** Mint -> symbol. Extend as you add pools. Unknown mints render as a short hash. */
export const KNOWN_TOKENS: Record<string, string> = {
  [SOL_MINT]: "SOL",
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
  /** which side of the pair is native SOL (null if neither) */
  solSide: "X" | "Y" | null;
  /** the non-SOL token */
  baseToken: TokenInfo;
  binStep: number;
  activeBinId: number;
  /** price of one X in Y, UI units */
  activePrice: number;
  priceLabel: string;
  /** base token priced in SOL */
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
  /** total value incl. unclaimed fees, in SOL */
  valueInSol: number;
  /** SOL-side tokens in the position incl. SOL fees (what returns as SOL on close, before rent) */
  solInPosition: number;
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

/** Value of (amountX, amountY) expressed in SOL. Falls back to Y as quote if SOL is not in the pool. */
export function toSol(amountX: number, amountY: number, s: PoolSnapshot): number {
  if (s.solSide === "X") return amountX + (s.activePrice > 0 ? amountY / s.activePrice : 0);
  return amountY + amountX * s.activePrice;
}

export async function loadPool(connection: Connection, address: string): Promise<DLMM> {
  return DLMM.create(connection, new PublicKey(address));
}

export async function getPoolSnapshot(dlmm: DLMM, binsEachSide = 10): Promise<PoolSnapshot> {
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
  const solSide: PoolSnapshot["solSide"] = xMint === SOL_MINT ? "X" : yMint === SOL_MINT ? "Y" : null;
  const baseToken = solSide === "X" ? tokenY : tokenX;

  const activePrice = Number(active.pricePerToken);
  const tokenPriceInSol = solSide === "X" ? (activePrice > 0 ? 1 / activePrice : 0) : activePrice;

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
    address: dlmm.pubkey.toBase58(),
    label: `${tokenX.symbol}/${tokenY.symbol}`,
    tokenX,
    tokenY,
    solSide,
    baseToken,
    binStep: dlmm.lbPair.binStep,
    activeBinId: active.binId,
    activePrice,
    priceLabel: `${tokenY.symbol} per ${tokenX.symbol}`,
    tokenPriceInSol,
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
  const solInPosition = s.solSide === "X" ? amountX + feeX : amountY + feeY;
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
