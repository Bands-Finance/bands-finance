/**
 * Raydium CLMM as a venue, through @raydium-io/raydium-sdk-v2 (web3.js 1.x, bn.js 5).
 *
 * Bin model (src/tools/bins.ts): one bin = one tick-spacing step. activeBinId = floor(tickCurrent /
 * tickSpacing), binStep = tickSpacing (a tick is one basis point), price(bin) = 1.0001^(bin x spacing).
 * The snapshot's bins come from the tick arrays around the price: the pool's active liquidity is
 * walked outward tick by tick (liquidityNet at every initialised tick) and turned into token amounts
 * per bin (X above the price, Y below, the active bin split at the current sqrt price).
 *
 * Positions are NFTs: the owner's position accounts are found through the SDK, mapped to bins
 * (tickLower / spacing .. tickUpper / spacing - 1), amounts from liquidity and the sqrt prices, fees
 * from the position's owed fees plus the fee growth since its last update.
 *
 * Transactions are V0 (lookup tables) built by the SDK; the wallet signs and broadcasts them
 * (src/tools/wallet.ts). Open = openPositionFromBase (single-sided when the band sits on one side of
 * the price, from-liquidity when it straddles), a fresh Token-2022 position NFT mint as an extra
 * signer. Close = decreaseLiquidity(100%) + closePosition in one transaction. Claim = decrease with
 * zero liquidity (collects fees and rewards). Priority fee: PRIORITY_FEE_MICROLAMPORTS.
 *
 * Ships dormant: tradable in paper and dry-run; the executor refuses to broadcast until LIVE_VENUES
 * includes raydium-clmm.
 */
import {
  CLMM_PROGRAM_ID,
  LiquidityMathUtil,
  PersonalPositionLayout,
  PoolUtils,
  PositionUtils,
  ProtocolPositionLayout,
  Raydium,
  TickArrayLayout,
  TickUtil,
  TxVersion,
  clmmComputeInfoToApiInfo,
  fetchMultipleMintInfos,
  getMultipleAccountsInfoWithCustomFlags,
  splAccountLayout,
  toApiV3Token,
  type ApiV3PoolInfoConcentratedItem,
  type ClmmKeys,
} from "@raydium-io/raydium-sdk-v2";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { config, riskLimits } from "../config";
import { binPrice, clmmBandTicks, tickArrayStart, tickToBin, ticksToBins, TICK_ARRAY_SIZE } from "../tools/bins";
import { quoteMath, resolveQuote, symbolFor, type BinRow, type OpenPlan, type PoolSnapshot, type PositionSnapshot, type TokenInfo } from "../tools/dlmm";
import { priorityFeeMicroLamports } from "./env";
import type { BuiltTx, OpenCost, SnapshotOpts, Venue, VenuePool } from "./types";

export const RAYDIUM_CLMM_PROGRAM = CLMM_PROGRAM_ID.toBase58();

type PoolRead = Awaited<ReturnType<Raydium["clmm"]["getPoolInfoFromRpc"]>>;
type TickArrayState = ReturnType<typeof TickArrayLayout.decode>;
type TickState = TickArrayState["ticks"][number];
/** a decoded personal position account: what the SDK needs to close or collect */
export type ClmmPosition = ReturnType<typeof PersonalPositionLayout.decode>;

export interface RaydiumPool extends VenuePool {
  venue: "raydium-clmm";
  connection: Connection;
  /** the last pool read (snapshot()); positions() and the builders reuse it instead of re-reading */
  last: PoolRead | null;
}

// ---- rent -------------------------------------------------------------------------------------
/**
 * Rent-exempt minimum = (bytes + 128) x this many lamports. Measured on mainnet 2026-09-14:
 * getMinimumBalanceForRentExemption(10240) = 52,669,440 and a fresh 281-byte position account holds
 * 2,077,720 lamports. (Meteora's constants predate the rent change and stay as they are.)
 */
export const RENT_LAMPORTS_PER_BYTE = 5080;
export const rentSol = (bytes: number): number => ((bytes + 128) * RENT_LAMPORTS_PER_BYTE) / 1e9;
/** account sizes: the SDK's layout spans (checked against the SDK in test-venues) and measured NFT accounts */
export const CLMM_PERSONAL_POSITION_BYTES = 281;
export const CLMM_PROTOCOL_POSITION_BYTES = 225;
export const CLMM_TICK_ARRAY_BYTES = 10240;
/** Token-2022 position NFT mint with metadata pointer + metadata: 479-480 bytes on the SPYx/USDC pool */
export const CLMM_NFT_MINT_2022_BYTES = 479;
/** Token-2022 associated token account holding the NFT (ImmutableOwner extension) */
export const CLMM_NFT_TOKEN_ACCOUNT_BYTES = 170;
/** refunded on close: close_position closes the position account, the NFT token account and (Token-2022) the mint */
export const CLMM_POSITION_RENT_SOL = rentSol(CLMM_PERSONAL_POSITION_BYTES) + rentSol(CLMM_NFT_MINT_2022_BYTES) + rentSol(CLMM_NFT_TOKEN_ACCOUNT_BYTES);
/** paid once per (pool, tickLower, tickUpper) pair when the pair is new; never refunded. Counted on every open (conservative). */
export const CLMM_PROTOCOL_POSITION_RENT_SOL = rentSol(CLMM_PROTOCOL_POSITION_BYTES);
/** per tick array the band lands on that nobody has initialised yet; never refunded */
export const CLMM_TICK_ARRAY_RENT_SOL = rentSol(CLMM_TICK_ARRAY_BYTES);
/** an open on initialised tick arrays (the usual case near the price) */
export const CLMM_OPEN_COST_DEFAULT_SOL = CLMM_POSITION_RENT_SOL + CLMM_PROTOCOL_POSITION_RENT_SOL;

/**
 * What an open costs on a CLMM pool. With a plan, the band's tick arrays are checked against the
 * ones the snapshot saw on chain; each missing one adds a tick array's rent. Without a plan (the
 * policy sizing a typical band near the price) the arrays are assumed to exist.
 */
export function clmmOpenCost(snapshot: Pick<PoolSnapshot, "binStep" | "activeBinId" | "clmm"> & Partial<Pick<PoolSnapshot, "quoteSide" | "solSide">>, plan?: Pick<OpenPlan, "minBinId" | "maxBinId" | "side">): OpenCost {
  const refundable = CLMM_POSITION_RENT_SOL;
  if (!plan) return { total: CLMM_OPEN_COST_DEFAULT_SOL, refundable, note: "position NFT + protocol position; tick arrays assumed initialised" };
  const spacing = snapshot.clmm?.tickSpacing ?? snapshot.binStep;
  const quoteSide: "X" | "Y" = snapshot.quoteSide ?? (snapshot.solSide === "X" ? "X" : "Y");
  const a = snapshot.activeBinId;
  const geom = clmmBandTicks(a, spacing, a - plan.minBinId, plan.maxBinId - a, plan.side ?? "BOTH", quoteSide);
  const starts = [...new Set([tickArrayStart(geom.tickLower, spacing), tickArrayStart(geom.tickUpper, spacing)])];
  const known = snapshot.clmm?.initializedTickArrays;
  const fresh = known ? starts.filter((s) => !known.includes(s)) : starts;
  const total = refundable + CLMM_PROTOCOL_POSITION_RENT_SOL + fresh.length * CLMM_TICK_ARRAY_RENT_SOL;
  const note = fresh.length ? `${fresh.length} tick array(s) to initialise at ${fresh.join(", ")} (${CLMM_TICK_ARRAY_RENT_SOL.toFixed(4)} SOL each, not refunded)` : "tick arrays initialised; position NFT + protocol position";
  return { total, refundable, note };
}

// ---- helpers ----------------------------------------------------------------------------------
const asRaydium = (pool: VenuePool): RaydiumPool => {
  if (pool.venue !== "raydium-clmm" || !("connection" in pool)) throw new Error(`${pool.address} is not a Raydium pool handle`);
  return pool as RaydiumPool;
};

const ui = (raw: BN | bigint | string | number, decimals: number): number => Number(raw.toString()) / 10 ** decimals;
const sqrtAt = (tick: number): BN => TickUtil.getSqrtPriceAtTick(tick);
const nonNeg = (b: BN): BN => (b.isNeg() ? new BN(0) : b);

/** An SDK instance bound to an owner. Raydium.load is local (no token list, no feature check): it costs nothing. */
async function sdkFor(connection: Connection, owner?: PublicKey): Promise<Raydium> {
  return Raydium.load({ connection, owner, disableLoadToken: true, disableFeatureCheck: true, notSubscribeAccountChange: true, blockhashCommitment: "confirmed" });
}

async function readPool(pool: RaydiumPool): Promise<PoolRead> {
  const sdk = await sdkFor(pool.connection);
  const read = await readPoolInfo(sdk, pool.address);
  pool.last = read;
  return read;
}

/**
 * The SDK's getPoolInfoFromRpc, with the reward rows converted safely. The SDK turns each reward's
 * emissionsPerSecondX64 into a per-second figure with bn.js `divn(10 ** decimals)`, and divn asserts
 * for divisors above 2^26, so every pool paying rewards in a token with 8+ decimals (SOL, most
 * memecoins) threw "Assertion failed" on read. We never trade rewards; the rows are rebuilt with
 * BN division so the read cannot throw on them. Everything else is the SDK's own composition.
 */
export async function readPoolInfo(sdk: Raydium, poolId: string): Promise<PoolRead> {
  const connection = sdk.connection;
  const rpcData = await sdk.clmm.getRpcClmmPoolInfo({ poolId });
  const live = (r: { mint: PublicKey }) => !r.mint.equals(PublicKey.default);
  const mintSet = new Set([rpcData.mintA.toBase58(), rpcData.mintB.toBase58(), ...rpcData.rewardInfos.filter(live).map((r) => r.mint.toBase58())]);
  const mintInfos = await fetchMultipleMintInfos({ connection, mints: Array.from(mintSet).map((m) => new PublicKey(m)) });
  const { computeClmmPoolInfo, computePoolTickData } = await sdk.clmm.getComputeClmmPoolInfos({ clmmPoolsRpcInfo: { [poolId]: rpcData }, mintInfos });
  const compute = computeClmmPoolInfo[poolId];
  const vaultData = await getMultipleAccountsInfoWithCustomFlags(connection, [{ pubkey: rpcData.vaultA }, { pubkey: rpcData.vaultB }]);
  if (!vaultData[0].accountInfo || !vaultData[1].accountInfo) throw new Error("pool vault data not found");
  const decimalsOf = (mint: string): number => mintInfos[mint]?.decimals ?? 6;
  const apiToken = (mint: PublicKey) => toApiV3Token({ address: mint.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), decimals: decimalsOf(mint.toBase58()) });
  const poolInfo = clmmComputeInfoToApiInfo({ ...compute, rewardInfos: [] }, mintInfos);
  poolInfo.rewardDefaultInfos = compute.rewardInfos.filter(live).map((r) => ({
    mint: apiToken(r.mint),
    perSecond: safePerSecond(r.emissionsPerSecondX64, decimalsOf(r.mint.toBase58())),
    startTime: r.openTime.toNumber(),
    endTime: r.endTime.toNumber(),
  }));
  poolInfo.mintAmountA = Number(splAccountLayout.decode(vaultData[0].accountInfo.data).amount.toString());
  poolInfo.mintAmountB = Number(splAccountLayout.decode(vaultData[1].accountInfo.data).amount.toString());
  const poolKeys: ClmmKeys = {
    ...compute,
    exBitmapAccount: compute.exBitmapAccount.toBase58(),
    observationId: compute.observationId.toBase58(),
    id: poolId,
    programId: rpcData.programId.toBase58(),
    openTime: rpcData.startTime.toString(),
    vault: { A: rpcData.vaultA.toBase58(), B: rpcData.vaultB.toBase58() },
    config: poolInfo.config,
    rewardInfos: compute.rewardInfos.filter((r) => !r.vault.equals(PublicKey.default)).map((r) => ({ mint: apiToken(r.mint), vault: r.vault.toBase58() })),
  };
  return { poolInfo, poolKeys, computePoolInfo: compute, tickData: computePoolTickData, rpcPoolInfo: rpcData, tickArrays: Object.values(computePoolTickData[poolId]) };
}

/** emissions per second in whole tokens; BN division instead of the SDK's divn, which asserts past 2^26 */
export function safePerSecond(emissionsPerSecondX64: BN, decimals: number): number {
  const scaled = emissionsPerSecondX64.div(new BN(10).pow(new BN(Math.max(0, Math.floor(decimals)))));
  return Number(scaled.toString());
}

const lastOrRead = async (pool: RaydiumPool): Promise<PoolRead> => pool.last ?? readPool(pool);

/** liquidityNet at every initialised tick in the fetched arrays, by tick */
function initializedTicks(arrays: TickArrayState[]): Map<number, TickState> {
  const out = new Map<number, TickState>();
  for (const arr of arrays) for (const t of arr.ticks) if (!t.liquidityGross.isZero() || !t.liquidityNet.isZero()) out.set(t.tick, t);
  return out;
}

/** The tick state for a tick from the fetched arrays, or null when its array was not fetched. */
function tickStateOf(arrays: TickArrayState[], tick: number, spacing: number): TickState | null {
  const start = tickArrayStart(tick, spacing);
  const arr = arrays.find((a) => a.startTickIndex === start);
  if (!arr) return null;
  const offset = (tick - start) / spacing;
  return arr.ticks[offset] ?? null;
}

export interface ClmmBinInput {
  tickSpacing: number;
  tickCurrent: number;
  sqrtPriceX64: BN;
  liquidity: BN;
  /** liquidityNet by initialised tick */
  ticks: Map<number, Pick<TickState, "liquidityNet">>;
}

/**
 * Token amounts per bin around the active bin, from the pool's liquidity and the initialised ticks.
 * Liquidity at a bin above the price = L + sum of liquidityNet over ticks in (tickCurrent, binLower];
 * below = L - sum over ticks in (binLower, tickCurrent]. Bins above hold X, bins below hold Y, the
 * active bin holds both, split at the current sqrt price. Pure: the caller passes decoded state.
 */
export function clmmBins(p: ClmmBinInput, price: (binId: number) => number, xDec: number, yDec: number, binsEachSide: number): BinRow[] {
  const s = p.tickSpacing;
  const active = tickToBin(p.tickCurrent, s);
  const rows: BinRow[] = [];
  const sorted = [...p.ticks.entries()].sort((a, b) => a[0] - b[0]);
  const liquidityAt = (binId: number): BN => {
    let l = p.liquidity.clone();
    const lower = binId * s;
    if (binId > active) {
      for (const [t, st] of sorted) if (t > p.tickCurrent && t <= lower) l = l.add(st.liquidityNet);
    } else if (binId < active) {
      for (const [t, st] of sorted) if (t > lower && t <= p.tickCurrent) l = l.sub(st.liquidityNet);
    }
    return nonNeg(l);
  };
  for (let i = active - binsEachSide; i <= active + binsEachSide; i++) {
    const lower = sqrtAt(i * s);
    const upper = sqrtAt((i + 1) * s);
    let x = new BN(0);
    let y = new BN(0);
    if (i > active) x = LiquidityMathUtil.getDeltaAmountAUnsigned(lower, upper, liquidityAt(i), false);
    else if (i < active) y = LiquidityMathUtil.getDeltaAmountBUnsigned(lower, upper, liquidityAt(i), false);
    else {
      x = LiquidityMathUtil.getDeltaAmountAUnsigned(p.sqrtPriceX64, upper, p.liquidity, false);
      y = LiquidityMathUtil.getDeltaAmountBUnsigned(lower, p.sqrtPriceX64, p.liquidity, false);
    }
    rows.push({ binId: i, price: price(i), xAmount: ui(x, xDec), yAmount: ui(y, yDec), isActive: i === active });
  }
  return rows;
}

export interface ClmmPoolState {
  tickCurrent: number;
  sqrtPriceX64: BN;
  feeGrowthGlobalX64A: BN;
  feeGrowthGlobalX64B: BN;
}

/**
 * A CLMM position as the desk's PositionSnapshot. Bins from the ticks, amounts from liquidity and
 * the sqrt prices, fees from the owed counters plus the growth since the last update when the tick
 * states are known (else the owed counters alone). Pure.
 */
export function toClmmPositionSnapshot(
  p: Pick<ClmmPosition, "nftMint" | "tickLower" | "tickUpper" | "liquidity" | "feeGrowthInsideLastX64A" | "feeGrowthInsideLastX64B" | "tokenFeesOwedA" | "tokenFeesOwedB">,
  pool: ClmmPoolState,
  s: PoolSnapshot,
  ticks: { lower: TickState; upper: TickState } | null,
  fetchedAtSec: number = Math.floor(Date.now() / 1000),
): PositionSnapshot {
  const spacing = s.clmm?.tickSpacing ?? s.binStep;
  const { lowerBinId, upperBinId } = ticksToBins(p.tickLower, p.tickUpper, spacing);
  const xDec = s.tokenX.decimals;
  const yDec = s.tokenY.decimals;
  const amounts = LiquidityMathUtil.getAmountsForLiquidity(pool.sqrtPriceX64, sqrtAt(p.tickLower), sqrtAt(p.tickUpper), p.liquidity, false);
  const fees = ticks
    ? PositionUtils.GetPositionFees(pool, p, ticks.lower, ticks.upper)
    : { tokenFeeAmountA: p.tokenFeesOwedA, tokenFeeAmountB: p.tokenFeesOwedB };
  const amountX = ui(amounts.amountA, xDec);
  const amountY = ui(amounts.amountB, yDec);
  const feeX = ui(nonNeg(fees.tokenFeeAmountA), xDec);
  const feeY = ui(nonNeg(fees.tokenFeeAmountB), yDec);
  const inRange = s.activeBinId >= lowerBinId && s.activeBinId <= upperBinId;
  const binsFromRange = inRange ? 0 : s.activeBinId < lowerBinId ? s.activeBinId - lowerBinId : s.activeBinId - upperBinId;
  const q = quoteMath(s);
  const quoteInPosition = q.side === "X" ? amountX + feeX : amountY + feeY;
  const tokenInPosition = q.side === "X" ? amountY + feeY : amountX + feeX;
  return {
    address: p.nftMint.toBase58(),
    lowerBinId,
    upperBinId,
    lowerPrice: binPrice(s, lowerBinId),
    upperPrice: binPrice(s, upperBinId),
    widthBins: upperBinId - lowerBinId + 1,
    inRange,
    binsFromRange,
    amountX,
    amountY,
    feeX,
    feeY,
    valueInSol: (quoteInPosition + tokenInPosition * q.tokenPriceInQuote) * q.priceInSol,
    solInPosition: quoteInPosition * q.priceInSol,
    quoteInPosition,
    lastUpdatedAt: fetchedAtSec,
  };
}

/** amounts x (1 - slippage), BN */
const lessSlippage = (amount: BN, slippagePct: number): BN => {
  const bps = Math.max(0, Math.min(10_000, Math.round(slippagePct * 100)));
  return amount.muln(10_000 - bps).divn(10_000);
};
const plusSlippage = (amount: BN, slippagePct: number): BN => {
  const bps = Math.max(0, Math.round(slippagePct * 100));
  return amount.muln(10_000 + bps).divn(10_000);
};

const computeBudget = () => ({ units: 600_000, microLamports: priorityFeeMicroLamports() });

export type ClmmDeposit =
  | { mode: "base"; base: "MintA" | "MintB"; baseAmount: BN; otherAmountMax: BN }
  | { mode: "liquidity"; amountMaxA: BN; amountMaxB: BN };

/**
 * Which deposit an open makes, from the band's geometry: a band under the price deposits only token
 * Y (base MintB, nothing of A), a band over it only token X (base MintA); a band that straddles the
 * price deposits both, each amount a cap plus the allowed slippage. Pure.
 */
export function depositFor(geom: { singleSided: "X" | "Y" | null }, plan: Pick<OpenPlan, "amountX" | "amountY" | "slippagePct">): ClmmDeposit {
  if (geom.singleSided === "Y") {
    if (plan.amountY.isZero()) throw new Error("a band under the price deposits token Y: amountY is zero");
    return { mode: "base", base: "MintB", baseAmount: plan.amountY, otherAmountMax: new BN(0) };
  }
  if (geom.singleSided === "X") {
    if (plan.amountX.isZero()) throw new Error("a band over the price deposits token X: amountX is zero");
    return { mode: "base", base: "MintA", baseAmount: plan.amountX, otherAmountMax: new BN(0) };
  }
  if (plan.amountX.isZero() || plan.amountY.isZero()) throw new Error("a band across the price needs both tokens");
  return { mode: "liquidity", amountMaxA: plusSlippage(plan.amountX, plan.slippagePct), amountMaxB: plusSlippage(plan.amountY, plan.slippagePct) };
}

/** The SDK's Signer[] minus the owner, as the Keypairs the wallet must add (the position NFT mint). */
const extraSigners = (signers: { publicKey: PublicKey; secretKey?: Uint8Array }[], owner: PublicKey): Keypair[] =>
  signers.filter((s) => !s.publicKey.equals(owner) && s.secretKey).map((s) => Keypair.fromSecretKey(s.secretKey!));

/**
 * The SDK builds an open only when the wallet already holds an account for the deposit token (a
 * funded wallet always does). In dry-run with a wallet that holds none (the ephemeral key), the
 * ATA is assumed to exist so the transaction can still be built and inspected.
 */
async function ensureDepositAccount(sdk: Raydium, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey, symbol: string, notes: string[]): Promise<void> {
  await sdk.account.fetchWalletTokenAccounts({ forceUpdate: true });
  const raws = sdk.account.tokenAccountRawInfos;
  if (raws.some((r) => r.accountInfo.mint.equals(mint))) return;
  if (!config.dryRun) throw new Error(`wallet ${owner.toBase58()} holds no ${symbol} token account: fund it before opening on Raydium`);
  const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
  const accountInfo = {
    mint,
    owner,
    amount: new BN(0),
    delegateOption: 0,
    delegate: PublicKey.default,
    state: 1,
    isNativeOption: 0,
    isNative: new BN(0),
    delegatedAmount: new BN(0),
    closeAuthorityOption: 0,
    closeAuthority: PublicKey.default,
  };
  sdk.account.updateTokenAccount({
    tokenAccounts: [...sdk.account.tokenAccounts, { publicKey: ata, mint, amount: new BN(0), isAssociated: true, isNative: false, programId: tokenProgram }],
    tokenAccountRawInfos: [...raws, { pubkey: ata, programId: tokenProgram, accountInfo: accountInfo as (typeof raws)[number]["accountInfo"] }],
  });
  notes.push(`dry-run: the wallet holds no ${symbol} account; the transaction assumes its ATA ${ata.toBase58().slice(0, 6)}… exists (a funded wallet's does)`);
}

// ---- the venue ---------------------------------------------------------------------------------
export const raydiumVenue: Venue = {
  id: "raydium-clmm",

  async loadPool(connection: Connection, address: string): Promise<RaydiumPool> {
    const pool: RaydiumPool = { venue: "raydium-clmm", address, connection, last: null };
    const read = await readPool(pool);
    if (read.poolKeys.programId !== RAYDIUM_CLMM_PROGRAM) throw new Error(`${address} is owned by ${read.poolKeys.programId}, not the Raydium CLMM program`);
    return pool;
  },

  async snapshot(pool, binsEachSide, opts: SnapshotOpts): Promise<PoolSnapshot> {
    const rp = asRaydium(pool);
    const read = await readPool(rp);
    const rpc = read.rpcPoolInfo;
    const spacing = rpc.tickSpacing;
    const xMint = rpc.mintA.toBase58();
    const yMint = rpc.mintB.toBase58();
    const xDec = rpc.mintDecimalsA;
    const yDec = rpc.mintDecimalsB;
    const tokenX: TokenInfo = { mint: xMint, symbol: symbolFor(xMint), decimals: xDec, reserve: ui(read.poolInfo.mintAmountA, xDec) };
    const tokenY: TokenInfo = { mint: yMint, symbol: symbolFor(yMint), decimals: yDec, reserve: ui(read.poolInfo.mintAmountB, yDec) };
    const label = `${tokenX.symbol}/${tokenY.symbol}`;
    const activePrice = rpc.currentPrice;
    const q = resolveQuote({ address: rp.address, label, tokenX, tokenY, activePrice, solPriceUsd: opts.solPriceUsd });
    const activeBinId = tickToBin(rpc.tickCurrent, spacing);
    const priceOf = (binId: number) => binPrice({ binStep: spacing, priceModel: "clmm", tokenX, tokenY }, binId);
    const bins = clmmBins(
      { tickSpacing: spacing, tickCurrent: rpc.tickCurrent, sqrtPriceX64: rpc.sqrtPriceX64, liquidity: rpc.liquidity, ticks: initializedTicks(read.tickArrays) },
      priceOf,
      xDec,
      yDec,
      binsEachSide,
    );
    const feePct = (read.poolInfo.config.tradeFeeRate / 1_000_000) * 100;
    const dyn = rpc.dynamicFeeInfo;
    const hasDynamicFee = !!read.poolInfo.hasDynamicFee || (!!dyn && dyn.dynamicFeeControl > 0);
    return {
      address: rp.address,
      label,
      tokenX,
      tokenY,
      solSide: q.solSide,
      baseToken: q.baseToken,
      binStep: spacing,
      activeBinId,
      activePrice,
      priceLabel: `${tokenY.symbol} per ${tokenX.symbol}`,
      tokenPriceInSol: q.tokenPriceInSol,
      quoteSide: q.quoteSide,
      quoteToken: q.quoteToken,
      quoteSymbol: q.quoteSymbol,
      quotePriceInSol: q.quotePriceInSol,
      tokenPriceInQuote: q.tokenPriceInQuote,
      solPriceUsd: q.solPriceUsd,
      baseFeePct: feePct,
      maxFeePct: feePct,
      dynamicFeePct: feePct,
      hasDynamicFee,
      bins,
      liquidityBelowY: bins.filter((b) => b.binId < activeBinId).reduce((t, b) => t + b.yAmount, 0),
      liquidityAboveX: bins.filter((b) => b.binId > activeBinId).reduce((t, b) => t + b.xAmount, 0),
      fetchedAt: new Date().toISOString(),
      priceModel: "clmm",
      venue: "raydium-clmm",
      clmm: {
        tickSpacing: spacing,
        tickCurrent: rpc.tickCurrent,
        sqrtPriceX64: rpc.sqrtPriceX64.toString(),
        liquidity: rpc.liquidity.toString(),
        initializedTickArrays: read.tickArrays.map((t) => t.startTickIndex).sort((a, b) => a - b),
      },
    };
  },

  async positions(pool, owner, snapshot) {
    const rp = asRaydium(pool);
    const read = await lastOrRead(rp);
    const sdk = await sdkFor(rp.connection, owner);
    const all = await sdk.clmm.getOwnerPositionInfo({ programId: read.poolKeys.programId });
    const mine = all.filter((p) => p.poolId.toBase58() === rp.address);
    const rpc = read.rpcPoolInfo;
    const spacing = rpc.tickSpacing;
    // tick states for the fee growth: from the arrays already read, else one fetch for the rest
    const missing = new Set<number>();
    for (const p of mine) for (const t of [p.tickLower, p.tickUpper]) if (!tickStateOf(read.tickArrays, t, spacing)) missing.add(t);
    const arrays: TickArrayState[] = [...read.tickArrays];
    if (missing.size) {
      const programId = new PublicKey(read.poolKeys.programId);
      const poolId = new PublicKey(rp.address);
      const fetched = await PoolUtils.fetchMultipleTickArrayInfo({ connection: rp.connection, tickInfoList: [...missing].map((tick) => ({ programId, poolId, tick, tickSpacing: spacing })) });
      for (const a of fetched) if (a) arrays.push(a);
    }
    const state: ClmmPoolState = { tickCurrent: rpc.tickCurrent, sqrtPriceX64: rpc.sqrtPriceX64, feeGrowthGlobalX64A: rpc.feeGrowthGlobalX64A, feeGrowthGlobalX64B: rpc.feeGrowthGlobalX64B };
    const fetchedAtSec = Math.floor(Date.parse(snapshot.fetchedAt) / 1000) || Math.floor(Date.now() / 1000);
    const positions = mine.map((p) => {
      const lower = tickStateOf(arrays, p.tickLower, spacing);
      const upper = tickStateOf(arrays, p.tickUpper, spacing);
      return toClmmPositionSnapshot(p, state, snapshot, lower && upper ? { lower, upper } : null, fetchedAtSec);
    });
    return { raw: mine, positions };
  },

  async buildOpen(pool, owner, plan: OpenPlan, snapshot): Promise<BuiltTx> {
    const rp = asRaydium(pool);
    const read = await lastOrRead(rp);
    const sdk = await sdkFor(rp.connection, owner);
    const rpc = read.rpcPoolInfo;
    const spacing = rpc.tickSpacing;
    const a = snapshot.activeBinId;
    const side = plan.side ?? "BOTH";
    const geom = clmmBandTicks(a, spacing, a - plan.minBinId, plan.maxBinId - a, side, quoteMath(snapshot).side);
    const notes: string[] = [];
    if (geom.note) notes.push(geom.note);
    const poolInfo: ApiV3PoolInfoConcentratedItem = read.poolInfo;
    const poolKeys: ClmmKeys = read.poolKeys;
    const mintA = new PublicKey(poolInfo.mintA.address);
    const mintB = new PublicKey(poolInfo.mintB.address);
    const programA = new PublicKey(poolInfo.mintA.programId);
    const programB = new PublicKey(poolInfo.mintB.programId);
    const common = { poolInfo, poolKeys, ownerInfo: { useSOLBalance: true }, nft2022: true, txVersion: TxVersion.V0, computeBudgetConfig: computeBudget() } as const;
    const deposit = depositFor(geom, plan);
    const isSol = (mint: string) => mint === "So11111111111111111111111111111111111111112";
    let built;
    if (deposit.mode === "base") {
      if (deposit.base === "MintB" && !isSol(poolInfo.mintB.address)) await ensureDepositAccount(sdk, owner, mintB, programB, snapshot.tokenY.symbol, notes);
      if (deposit.base === "MintA" && !isSol(poolInfo.mintA.address)) await ensureDepositAccount(sdk, owner, mintA, programA, snapshot.tokenX.symbol, notes);
      built = await sdk.clmm.openPositionFromBase({ ...common, tickLower: geom.tickLower, tickUpper: geom.tickUpper, base: deposit.base, baseAmount: deposit.baseAmount, otherAmountMax: deposit.otherAmountMax });
    } else {
      // two-sided: the liquidity both amounts can fund at the current price, each amount a cap (plus the allowed slippage)
      const liquidity = LiquidityMathUtil.getLiquidityFromAmounts(rpc.sqrtPriceX64, sqrtAt(geom.tickLower), sqrtAt(geom.tickUpper), plan.amountX, plan.amountY);
      if (liquidity.isZero()) throw new Error("a two-sided band needs both tokens at the current price");
      if (!isSol(poolInfo.mintA.address)) await ensureDepositAccount(sdk, owner, mintA, programA, snapshot.tokenX.symbol, notes);
      if (!isSol(poolInfo.mintB.address)) await ensureDepositAccount(sdk, owner, mintB, programB, snapshot.tokenY.symbol, notes);
      built = await sdk.clmm.openPositionFromLiquidity({ ...common, tickLower: geom.tickLower, tickUpper: geom.tickUpper, liquidity, amountMaxA: deposit.amountMaxA, amountMaxB: deposit.amountMaxB, base: null });
    }
    const nftMint = (built.extInfo as { nftMint?: PublicKey }).nftMint;
    const signers = extraSigners(built.signers, owner);
    return {
      tx: built.transaction,
      signers,
      label: `open ${side} band bins [${geom.lowerBinId}, ${geom.upperBinId}]`,
      positionAddress: (nftMint ?? signers[0]?.publicKey)?.toBase58(),
      notes,
    };
  },

  async buildClose(pool, owner, raw): Promise<BuiltTx[]> {
    const rp = asRaydium(pool);
    const read = await lastOrRead(rp);
    const sdk = await sdkFor(rp.connection, owner);
    const p = raw as ClmmPosition;
    const rpc = read.rpcPoolInfo;
    const amounts = LiquidityMathUtil.getAmountsForLiquidity(rpc.sqrtPriceX64, sqrtAt(p.tickLower), sqrtAt(p.tickUpper), p.liquidity, false);
    const slippagePct = riskLimits.maxSlippagePct;
    const built = await sdk.clmm.decreaseLiquidity({
      poolInfo: read.poolInfo,
      poolKeys: read.poolKeys,
      ownerPosition: p,
      ownerInfo: { useSOLBalance: true, closePosition: true },
      liquidity: p.liquidity,
      amountMinA: lessSlippage(amounts.amountA, slippagePct),
      amountMinB: lessSlippage(amounts.amountB, slippagePct),
      txVersion: TxVersion.V0,
      computeBudgetConfig: computeBudget(),
    });
    return [{ tx: built.transaction, signers: extraSigners(built.signers, owner), label: `close band ${p.nftMint.toBase58().slice(0, 6)} 1/1` }];
  },

  async buildClaim(pool, owner, raws): Promise<BuiltTx[]> {
    const rp = asRaydium(pool);
    const read = await lastOrRead(rp);
    const sdk = await sdkFor(rp.connection, owner);
    const positions = raws as ClmmPosition[];
    const out: BuiltTx[] = [];
    for (const [i, p] of positions.entries()) {
      const built = await sdk.clmm.decreaseLiquidity({
        poolInfo: read.poolInfo,
        poolKeys: read.poolKeys,
        ownerPosition: p,
        ownerInfo: { useSOLBalance: true, closePosition: false },
        liquidity: new BN(0),
        amountMinA: new BN(0),
        amountMinB: new BN(0),
        txVersion: TxVersion.V0,
        computeBudgetConfig: computeBudget(),
      });
      out.push({ tx: built.transaction, signers: extraSigners(built.signers, owner), label: `claim fees ${i + 1}/${positions.length}` });
    }
    return out;
  },

  openCostSol(snapshot, plan): OpenCost {
    return clmmOpenCost(snapshot, plan);
  },

  async poolsWithPositions(connection: Connection, owner: PublicKey): Promise<string[]> {
    const sdk = await sdkFor(connection, owner);
    const all = await sdk.clmm.getOwnerPositionInfo({ programId: CLMM_PROGRAM_ID });
    return [...new Set(all.map((p) => p.poolId.toBase58()))];
  },
};

/** The SDK's layout spans, for the test that pins the rent constants to them. */
export const SDK_SPANS = { personalPosition: PersonalPositionLayout.span, protocolPosition: ProtocolPositionLayout.span, tickArray: TickArrayLayout.span, ticksPerArray: TICK_ARRAY_SIZE };
