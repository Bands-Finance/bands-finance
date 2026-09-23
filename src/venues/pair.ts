/**
 * A MADE PAIR as a venue: the pool the desk creates on Meteora DLMM for a pump.fun token (the pair
 * lane, src/screener/pair.ts), worked under the key `pair-<mint>` from the moment the picker takes
 * the token until its band is closed.
 *
 * Two lives:
 *   paper   the pool is virtual. snapshot() is SYNTHETIC: the active price is the reference PumpSwap
 *           row's priceNative from hot.json (read once per tick, cached on the file's mtime), the
 *           active bin comes from the bin math inverted, the bins hold our own deposits only, the
 *           token is X and the quote is Y, and the fees per day are the routing model's. The paper
 *           executor creates the pool in the book on the first open and charges the creation rent.
 *   chain   loadPool derives the customizable-permissionless pair address the SDK derives for
 *           (token, quote) -- from the PAIR alone, not the bin step or the fee -- and asks the chain
 *           whether it exists. If it does (ours from an earlier cycle, or anyone's: there can be only
 *           one such pool per pair), the venue delegates to the Meteora adapter with that pool's real
 *           bin step and fee and the desk SEATS there instead of creating. If it does not, the
 *           snapshot is synthetic like paper's, and the executor builds the create transaction
 *           (buildCreate) before the seed position: broadcast only when PAIR_LIVE=true, DRY_RUN=false
 *           and meteora-dlmm is in LIVE_VENUES; otherwise built, simulated where a key exists, and
 *           journaled as "would create ... and seat ...". Created pools are recorded in
 *           RiskState.pairPools so a restart knows the real address is one of ours.
 *
 * STOCK PAIRS (src/screener/pairStock.ts): the same venue, the same key, a different reference. When
 * the mint is a tokenized stock the board carries (deps.stockRef), the spec is STOCKx/SOL at
 * PAIR_STOCK_BIN_STEP with the fee the stock model picks and PAIR_STOCK_COLLECT_FEE_MODE; the
 * synthetic price is the Backpack perp mid (deps.perpMidUsd) when the ticker has one, else the
 * reference pool's USD price, divided by the SOL price; the model is the stock lane's at the pool's
 * OWN fee and bin step; and the snapshot counts the consecutive cycles the reference has been off the
 * board (refGoneCycles), which the engine turns into a liquidating close.
 *
 * RENT (the SDK's own figures, @meteora-ag/dlmm 1.9.14, 6960 lamports per byte including the 128-byte
 * account overhead): lb pair 0.00718272 SOL (POOL_FEE), two reserve token accounts 0.00203928 each
 * (TOKEN_ACCOUNT_FEE), the oracle 0.0011136 (8 + 24 bytes of metadata; observations are only added by
 * increase_oracle_length), and the seed position's two bin arrays 0.07143744 each (BIN_ARRAY_FEE) --
 * 0.15524976 SOL that never comes back -- plus the position's 0.05740608 (POSITION_FEE), refundable.
 * The creator's own token accounts (idempotent ATAs) are not counted: a Jupiter buy would open the
 * same ATA, and closing one is a chore the desk does not do.
 *
 * The program's constraints, honoured before anything is built: the quote (token Y) must be SOL or
 * USDC ("Quote token must be SOL or USDC" is the program's own error), the bin step in [1, 400],
 * the fee at most 10% and representable (feeBps x 10000 / binStep must be a whole number that fits
 * the base factor), activation by timestamp with no activation point (live at once), no alpha
 * vault, the desk's wallet as creator, no creator on/off control.
 */
import DLMM, {
  ActivationType,
  BIN_ARRAY_FEE,
  CollectFeeMode,
  computeBaseFactorFromFeeBps,
  deriveCustomizablePermissionlessLbPair,
  deriveOracle,
  deriveReserve,
  LBCLMM_PROGRAM_IDS,
  POOL_FEE,
  POSITION_FEE,
  TOKEN_ACCOUNT_FEE,
  type LbPosition,
} from "@meteora-ag/dlmm";
import { getMint } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import BN from "bn.js";
import { loadHotFileCached } from "../hot/store";
import type { HotFile, HotRow } from "../hot/types";
import type { PaperBook } from "../paper/book";
import type { PairPoolRecord } from "../risk/state";
import { activeIdFromPrice, competitionFor, isHouseMint, isPairAddress, pairEnv, pairMintOf, pairModel, pairPoolAddress, pairSeatSol, type PairEnv, chooseFeeBps } from "../screener/pair";
import { chooseStockFeeBps, pairStockEnv, pairStockSeatSol, stockPairModel, type PairStockCandidate, type PairStockEnv } from "../screener/pairStock";
import type { StockTag } from "../screener/types";
import { policyEnv, stockBinsPerSide } from "../agent/policy";
import { sessionClock } from "../basis/session";
import { sessionWidthMultiplier } from "../basis/verdict";
import { config, riskLimits } from "../config";
import { binPrice } from "../tools/bins";
import {
  buildClaimFeesTxs,
  buildClosePositionTxs,
  buildOpenPositionTx,
  getPoolSnapshot,
  getUserPositions,
  OPEN_COST_ESTIMATE_SOL,
  POSITION_RENT_SOL,
  resolveQuote,
  SOL_MINT,
  USDC_MINT,
  type BinRow,
  type OpenPlan,
  type PairSnapshotInfo,
  type PoolSnapshot,
  type QuoteSymbol,
  type TokenInfo,
} from "../tools/dlmm";
import { isLiveVenue } from "./env";
import { meteoraOpenCost, meteoraVenue } from "./meteora";
import type { BuiltTx, OpenCost, Venue, VenuePool } from "./types";

/* ---------- rent ---------- */

/** the lb pair account (SDK POOL_FEE) */
export const PAIR_LB_PAIR_RENT_SOL = POOL_FEE;
/** one reserve token account (SDK TOKEN_ACCOUNT_FEE); a pool has two */
export const PAIR_RESERVE_RENT_SOL = TOKEN_ACCOUNT_FEE;
/** the oracle: 8 + 24 bytes of metadata at (32 + 128) x 6960 lamports */
export const PAIR_ORACLE_RENT_SOL = ((8 + 24 + 128) * 6960) / 1e9;
/** what the create transaction itself pays: lb pair + two reserves + oracle */
export const PAIR_POOL_ACCOUNTS_RENT_SOL = PAIR_LB_PAIR_RENT_SOL + 2 * PAIR_RESERVE_RENT_SOL + PAIR_ORACLE_RENT_SOL;
/** rent that never comes back when the desk makes a pool: the pool's accounts plus the seed's two bin arrays */
export const PAIR_CREATION_RENT_SOL = PAIR_POOL_ACCOUNTS_RENT_SOL + 2 * BIN_ARRAY_FEE;
/** the whole up-front cost of the first seat in a new pool; the position rent (the desk's POSITION_RENT_SOL, the SDK's POSITION_FEE rounded) comes back on close */
export const PAIR_OPEN_COST_SOL = PAIR_CREATION_RENT_SOL + POSITION_RENT_SOL;

/** The SDK's constants the figures above rest on, so a test can pin them against the installed SDK. */
export const PAIR_SDK_RENT = { POOL_FEE, TOKEN_ACCOUNT_FEE, BIN_ARRAY_FEE, POSITION_FEE } as const;

/* ---------- the pure part of the live builder ---------- */

/** The program's quote allowlist for customizable permissionless pairs (its error: "Quote token must be SOL or USDC"). */
export const PAIR_QUOTE_MINTS: Readonly<Record<QuoteSymbol, string>> = { SOL: SOL_MINT, USDC: USDC_MINT };
export const PAIR_MAX_BIN_STEP = 400;
/** MAX_FEE_RATE 1e8 over FEE_PRECISION 1e9: 10% */
export const PAIR_MAX_FEE_BPS = 1000;

export interface PairCreateInput {
  tokenMint: string;
  quoteMint: string;
  binStep: number;
  feeBps: number;
  activeId: number;
  collectFeeMode: "quote" | "both";
  programId?: string;
}

export interface PairCreateParams {
  programId: PublicKey;
  /** the token is X, the quote is Y: the program's quote check is on Y */
  tokenX: PublicKey;
  tokenY: PublicKey;
  lbPair: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
  oracle: PublicKey;
  binStep: number;
  feeBps: number;
  activeId: number;
  baseFactor: number;
  baseFeePowerFactor: number;
  activationType: ActivationType;
  activationPoint: null;
  hasAlphaVault: false;
  creatorPoolOnOffControl: false;
  collectFeeMode: CollectFeeMode;
}

/**
 * PURE (no RPC). Everything the create instruction is built from, with the program's constraints
 * checked here so a refusal is a sentence rather than a simulation log. Throws on a bad input.
 */
export function pairCreateParams(i: PairCreateInput): PairCreateParams {
  const quote = (Object.entries(PAIR_QUOTE_MINTS) as [QuoteSymbol, string][]).find(([, m]) => m === i.quoteMint);
  if (!quote) throw new Error(`quote ${i.quoteMint.slice(0, 6)} is not allowed: the program's customizable permissionless pairs must be quoted in SOL or USDC`);
  if (i.tokenMint === i.quoteMint) throw new Error("the token and the quote are the same mint");
  if (!Number.isInteger(i.binStep) || i.binStep < 1 || i.binStep > PAIR_MAX_BIN_STEP) throw new Error(`bin step ${i.binStep} is outside the program's [1, ${PAIR_MAX_BIN_STEP}]`);
  if (!Number.isInteger(i.feeBps) || i.feeBps < 1 || i.feeBps > PAIR_MAX_FEE_BPS) throw new Error(`fee ${i.feeBps} bps is outside the program's (0, ${PAIR_MAX_FEE_BPS}] (10% max)`);
  if (!Number.isInteger(i.activeId)) throw new Error(`active id ${i.activeId} is not an integer`);
  let baseFactor: BN;
  let baseFeePowerFactor: BN;
  try {
    [baseFactor, baseFeePowerFactor] = computeBaseFactorFromFeeBps(new BN(i.binStep), new BN(i.feeBps));
  } catch (err) {
    throw new Error(`fee ${i.feeBps} bps at bin step ${i.binStep} cannot be represented (${typeof err === "string" ? err : (err as Error).message})`);
  }
  const programId = new PublicKey(i.programId ?? LBCLMM_PROGRAM_IDS["mainnet-beta"]);
  const tokenX = new PublicKey(i.tokenMint);
  const tokenY = new PublicKey(i.quoteMint);
  const [lbPair] = deriveCustomizablePermissionlessLbPair(tokenX, tokenY, programId);
  const [reserveX] = deriveReserve(tokenX, lbPair, programId);
  const [reserveY] = deriveReserve(tokenY, lbPair, programId);
  const [oracle] = deriveOracle(lbPair, programId);
  return {
    programId,
    tokenX,
    tokenY,
    lbPair,
    reserveX,
    reserveY,
    oracle,
    binStep: i.binStep,
    feeBps: i.feeBps,
    activeId: i.activeId,
    baseFactor: baseFactor.toNumber(),
    baseFeePowerFactor: baseFeePowerFactor.toNumber(),
    activationType: ActivationType.Timestamp,
    activationPoint: null,
    hasAlphaVault: false,
    creatorPoolOnOffControl: false,
    collectFeeMode: i.collectFeeMode === "quote" ? CollectFeeMode.OnlyY : CollectFeeMode.InputOnly,
  };
}

/** The pool address the SDK derives for a token/quote pair, from the pair alone. */
export function pairLbPairAddress(tokenMint: string, quoteMint: string, programId: string = LBCLMM_PROGRAM_IDS["mainnet-beta"]): string {
  const [lbPair] = deriveCustomizablePermissionlessLbPair(new PublicKey(tokenMint), new PublicKey(quoteMint), new PublicKey(programId));
  return lbPair.toBase58();
}

/**
 * The create transaction through the SDK (createCustomizablePermissionlessLbPair2), after the pure
 * checks above. Needs the chain for the mint accounts (token program ids) only; nothing is sent.
 */
export async function buildCreatePool(connection: Connection, wallet: PublicKey, i: PairCreateInput): Promise<{ tx: Awaited<ReturnType<typeof DLMM.createCustomizablePermissionlessLbPair2>>; params: PairCreateParams }> {
  const params = pairCreateParams(i);
  const tx = await DLMM.createCustomizablePermissionlessLbPair2(
    connection,
    new BN(params.binStep),
    params.tokenX,
    params.tokenY,
    new BN(params.activeId),
    new BN(params.feeBps),
    params.activationType,
    params.hasAlphaVault,
    wallet,
    undefined,
    params.creatorPoolOnOffControl,
    undefined,
    params.collectFeeMode,
    { cluster: "mainnet-beta" },
  );
  return { tx, params };
}

/** Why the executor will not broadcast a pool creation, or null when it may (dry-run never sends anyway). */
export function pairBroadcastRefusal(env: PairEnv = pairEnv(), dryRun: boolean = config.dryRun, penv: NodeJS.ProcessEnv = process.env): string | null {
  if (dryRun) return null;
  if (!env.live) return "PAIR_LIVE is not true: the create transaction is built and simulated, not sent";
  if (!isLiveVenue("meteora-dlmm", penv)) return "meteora-dlmm is not in LIVE_VENUES: the create transaction is built and simulated, not sent";
  return null;
}

/* ---------- the reference row ---------- */

/**
 * The reference PumpSwap row for a mint in a hot file: the deepest pumpswap pool of the token, else any
 * pump.fun row for it; for a HOUSE mint (`house`), any row at all (the bonding curve, a Meteora pool, whatever).
 */
export function referenceRowFor(hot: HotFile | null, mint: string, house = false): HotRow | null {
  if (!hot) return null;
  const rows = hot.rows.filter((r) => r.baseMint === mint);
  const pump = rows.filter((r) => r.venue === "pumpswap").sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
  return pump[0] ?? rows.find((r) => r.origin === "pump.fun") ?? (house ? [...rows].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0] ?? null : null);
}

/** The hot row the loop should read for a pool: the reference row for a made pair, the pool's own row otherwise. */
export function hotRowForPool(hot: HotFile | null, address: string, env: PairEnv = pairEnv()): HotRow | undefined {
  const mint = pairMintOf(address);
  if (mint) return referenceRowFor(hot, mint, isHouseMint(mint, env)) ?? undefined;
  return hot?.rows.find((r) => r.address === address);
}

/* ---------- the venue ---------- */

export interface PairSpec {
  /** the loop's key: pair-<mint> */
  address: string;
  mint: string;
  symbol: string;
  decimals: number;
  quote: QuoteSymbol;
  quoteMint: string;
  quoteDecimals: number;
  binStep: number;
  feeBps: number;
  collectFeeMode: "quote" | "both";
  /** the real pool address the SDK derives for the pair */
  lbPair: string;
  /** a STOCK pair: the tokenized stock this pool quotes in SOL (src/screener/pairStock.ts); absent on pump.fun pairs */
  stock?: StockTag | null;
  /** a HOUSE token's pool (PAIR_HOUSE_MINTS): always seated, no launch-style exits */
  house?: boolean;
}

export interface PairPool extends VenuePool {
  venue: "meteora-dlmm";
  pair: PairSpec;
  /** the real pool, loaded, when it exists on chain (chain mode only) */
  dlmm: DLMM | null;
  /** the connection loadPool was given, for buildCreate and the existence check */
  connection: Connection;
}

export const isPairPool = (pool: VenuePool): pool is PairPool => "pair" in pool && typeof (pool as PairPool).pair?.mint === "string";

export interface PairVenueDeps {
  /** paper mode: the book, whose pairPools say what exists; null in chain mode */
  paper: () => PaperBook | null;
  /** chain mode: the pools the desk created (state.pairPools) */
  created: () => Record<string, PairPoolRecord>;
  /** the seat the routing model sizes for, in SOL */
  seatSol: () => number;
  solPriceUsd: () => number | null;
  /** the board's rows, for the competing concentrated depth (and a house token's price of last resort) */
  screenRows: () => readonly { address: string; venue: string; baseMint: string; quoteSymbol: string; liquidityUsd: number | null; priceUsd?: number | null }[];
  /** the bins our own paper deposits occupy, for the synthetic snapshot; absent = empty bins */
  ourBins?: (address: string, activeBinId: number, binsEachSide: number, spec: PairSpec) => BinRow[] | null;
  env?: () => PairEnv;
  hot?: () => HotFile | null;
  /** STOCK pairs: the board's candidate for a mint (src/screener/pairStock.ts pairStockCandidatesOf), null when the board does not carry the ticker */
  stockRef?: (mint: string) => PairStockCandidate | null;
  stockEnv?: () => PairStockEnv;
  /** STOCK pairs: the Backpack perp mid for a ticker in USD (this cycle's, else basis.json's), null when none is listed */
  perpMidUsd?: (ticker: string) => number | null;
  /** STOCK pairs: the seat the stock model sizes for, in SOL (default PAIR_STOCK_SEAT_PCT of the book, capped by the max band) */
  stockSeatSol?: () => number;
  /** STOCK pairs: bins per side the model prices our depth at (default: the straddle's width at this bin step for the current US session; a band already open sets its own) */
  stockBinsPerSide?: (binStep: number, address: string) => number;
  /** chain reads, injectable for tests */
  accountExists?: (connection: Connection, address: string) => Promise<boolean>;
  mintDecimals?: (connection: Connection, mint: string) => Promise<number>;
  now?: () => number;
}

/** pump.fun mints are minted with 6 decimals; used when the mint account cannot be read */
export const PUMP_FUN_DECIMALS = 6;

const decimalsCache = new Map<string, number>();
const existsCache = new Set<string>();
/** mint -> the last reference price seen, so a pool marks at it when the reference row goes cold */
const lastRef = new Map<string, { price: number; priceUsd: number | null; at: number; row: HotRow }>();
/** STOCK pairs: mint -> the last price seen (SOL per stock) and the candidate it came from */
const lastStock = new Map<string, { price: number; at: number; candidate: PairStockCandidate }>();
/** STOCK pairs: mint -> consecutive snapshots the reference has been off the board */
const refGone = new Map<string, number>();

async function defaultAccountExists(connection: Connection, address: string): Promise<boolean> {
  const info = await connection.getAccountInfo(new PublicKey(address), "confirmed");
  return !!info;
}

async function defaultMintDecimals(connection: Connection, mint: string): Promise<number> {
  const m = await getMint(connection, new PublicKey(mint));
  return m.decimals;
}

/** Forget the venue's caches (tests). */
export function clearPairCaches(): void {
  decimalsCache.clear();
  existsCache.clear();
  lastRef.clear();
  lastStock.clear();
  refGone.clear();
}

/** The pair venue: a Venue whose handles are PairPools, plus the create-transaction builder. */
export type PairVenue = Omit<Venue, "loadPool"> & {
  loadPool(connection: Connection, address: string): Promise<PairPool>;
  buildCreate(pool: PairPool, owner: PublicKey, snapshot: PoolSnapshot): Promise<BuiltTx>;
  deps: PairVenueDeps;
};

export function createPairVenue(deps: PairVenueDeps): PairVenue {
  const env = () => deps.env?.() ?? pairEnv();
  const hot = () => (deps.hot ? deps.hot() : loadHotFileCached());
  const now = () => deps.now?.() ?? Date.now();
  const accountExists = deps.accountExists ?? defaultAccountExists;
  const mintDecimals = deps.mintDecimals ?? defaultMintDecimals;
  const senv = () => deps.stockEnv?.() ?? pairStockEnv();
  const stockRef = (mint: string): PairStockCandidate | null => deps.stockRef?.(mint) ?? null;
  const stockSeatSol = (): number => deps.stockSeatSol?.() ?? Math.min(pairStockSeatSol(riskLimits.maxTotalExposureSol, senv()), riskLimits.maxPositionSol);
  /** the straddle's bins per side at OUR bin step: STOCK_COVER_PCT x the US session's width, inside MAX_BIN_WIDTH */
  const stockBins = (binStep: number, address: string): number =>
    deps.stockBinsPerSide?.(binStep, address) ?? stockBinsPerSide(binStep, policyEnv().stockCoverPct, riskLimits.maxBinWidth, sessionWidthMultiplier(sessionClock(new Date(now()))));

  /**
   * STOCK pairs: the price in SOL per stock (the perp mid when the ticker has one, else the reference
   * pool's USD price, else the last one seen), and the consecutive cycles the reference has been gone.
   */
  const stockPrice = (spec: PairSpec, solPriceUsd: number | null): { price: number; source: "perp" | "reference" | "last"; stale: boolean; candidate: PairStockCandidate | null; refGoneCycles: number } | null => {
    const c = stockRef(spec.mint);
    const gone = c ? 0 : (refGone.get(spec.mint) ?? 0) + 1;
    refGone.set(spec.mint, gone);
    const sol = solPriceUsd && solPriceUsd > 0 ? solPriceUsd : null;
    const perp = spec.stock ? deps.perpMidUsd?.(spec.stock.ticker) ?? null : null;
    let price: number | null = null;
    let source: "perp" | "reference" | "last" = "last";
    if (sol && perp && perp > 0) {
      price = perp / sol;
      source = "perp";
    } else if (sol && c?.priceUsd && c.priceUsd > 0) {
      price = c.priceUsd / sol;
      source = "reference";
    }
    if (price !== null) {
      const remembered = c ?? lastStock.get(spec.mint)?.candidate ?? null;
      if (remembered) lastStock.set(spec.mint, { price, at: now(), candidate: remembered });
      return { price, source, stale: !c, candidate: c ?? remembered, refGoneCycles: gone };
    }
    const last = lastStock.get(spec.mint);
    return last ? { price: last.price, source: "last", stale: true, candidate: c ?? last.candidate, refGoneCycles: gone } : null;
  };

  /** STOCK pairs: the model at the pool's OWN fee and bin step, for the seat the lane sizes, against the board's reference */
  const stockModelFor = (spec: PairSpec, candidate: PairStockCandidate | null, solPriceUsd: number | null, binStep: number, feeBps: number) => {
    const seatUsd = solPriceUsd && solPriceUsd > 0 ? stockSeatSol() * solPriceUsd : 0;
    const bins = stockBins(binStep, spec.address);
    const ref = candidate
      ? { liquidityUsd: candidate.refLiquidityUsd, vol24hUsd: candidate.vol24hUsd, vol1hUsd: candidate.vol1hUsd, refFeePct: candidate.refFeePct, refQuoteIsSol: candidate.refQuoteIsSol }
      : { liquidityUsd: null, vol24hUsd: null, vol1hUsd: null, refFeePct: 0.25 };
    return { model: stockPairModel(ref, senv(), seatUsd, bins, candidate?.competingDepthUsd ?? 0, { feeBps, binStep }), seatUsd, bins };
  };

  const quoteInfo = (q: QuoteSymbol): { mint: string; decimals: number } => (q === "USDC" ? { mint: USDC_MINT, decimals: 6 } : { mint: SOL_MINT, decimals: 9 });

  const asPair = (pool: VenuePool): PairPool => {
    if (!isPairPool(pool)) throw new Error(`${pool.address} is not a made pair`);
    return pool;
  };

  /** chain mode: load the real pool once it exists; cached positively */
  const ensureLoaded = async (pool: PairPool): Promise<void> => {
    if (pool.dlmm || deps.paper()) return;
    const key = pool.pair.lbPair;
    if (!existsCache.has(key)) {
      if (!(await accountExists(pool.connection, key))) return;
      existsCache.add(key);
    }
    pool.dlmm = await DLMM.create(pool.connection, new PublicKey(key), { cluster: "mainnet-beta" });
    pool.pair.binStep = pool.dlmm.lbPair.binStep;
    pool.pair.feeBps = Math.round(pool.dlmm.getFeeInfo().baseFeeRatePercentage.toNumber() * 100);
  };

  const exists = (pool: PairPool): boolean => {
    const book = deps.paper();
    return book ? !!book.pairPools?.[pool.address] : pool.dlmm !== null;
  };
  const ours = (pool: PairPool): boolean => {
    const book = deps.paper();
    return book ? !!book.pairPools?.[pool.address] : !!deps.created()[pool.address];
  };

  /** the reference price in OUR quote, from the reference row (or the last one seen) */
  const referencePrice = (row: HotRow | null, spec: PairSpec): { price: number; stale: boolean; row: HotRow | null } | null => {
    const solPrice = deps.solPriceUsd();
    const convert = (r: HotRow): number | null => {
      if (r.quoteSymbol === spec.quote && r.priceNative !== null && r.priceNative > 0) return r.priceNative;
      if (spec.quote === "USDC" && r.priceUsd !== null && r.priceUsd > 0) return r.priceUsd;
      if (spec.quote === "SOL" && r.priceUsd !== null && r.priceUsd > 0 && solPrice && solPrice > 0) return r.priceUsd / solPrice;
      return null;
    };
    if (row) {
      const price = convert(row);
      if (price !== null) {
        lastRef.set(spec.mint, { price, priceUsd: row.priceUsd, at: now(), row });
        return { price, stale: false, row };
      }
    }
    const last = lastRef.get(spec.mint);
    return last ? { price: last.price, stale: true, row: last.row } : null;
  };

  /** the bins and the tokens of a synthetic snapshot: our own deposits around the active bin, nothing else */
  const syntheticBins = (spec: PairSpec, activeBinId: number, binsEachSide: number): { bins: BinRow[]; tokenX: TokenInfo; tokenY: TokenInfo; activePrice: number } => {
    const geometry = { binStep: spec.binStep, tokenX: { decimals: spec.decimals }, tokenY: { decimals: spec.quoteDecimals } };
    const own = deps.ourBins?.(spec.address, activeBinId, binsEachSide, spec) ?? null;
    const bins: BinRow[] = [];
    for (let b = activeBinId - binsEachSide; b <= activeBinId + binsEachSide; b++) {
      const mine = own?.find((r) => r.binId === b);
      bins.push({ binId: b, price: binPrice(geometry, b), xAmount: mine?.xAmount ?? 0, yAmount: mine?.yAmount ?? 0, isActive: b === activeBinId });
    }
    const tokenX: TokenInfo = { mint: spec.mint, symbol: spec.symbol, decimals: spec.decimals, reserve: bins.reduce((t, b) => t + b.xAmount, 0) };
    const tokenY: TokenInfo = { mint: spec.quoteMint, symbol: spec.quote, decimals: spec.quoteDecimals, reserve: bins.reduce((t, b) => t + b.yAmount, 0) };
    return { bins, tokenX, tokenY, activePrice: binPrice(geometry, activeBinId) };
  };

  /** STOCK pairs: the synthetic snapshot priced from the perp (or the reference), modelled by the stock lane. */
  const syntheticStock = (pool: PairPool, binsEachSide: number, solPriceUsd: number | null): PoolSnapshot => {
    const spec = pool.pair;
    const px = stockPrice(spec, solPriceUsd);
    if (!px) throw new Error(`${spec.address}: no price for ${spec.symbol}: no Backpack perp mid, no reference pool on the board, none remembered${solPriceUsd ? "" : " (and no SOL price to convert one)"}: the pool cannot be priced this cycle`);
    const activeBinId = activeIdFromPrice(px.price, spec.binStep, spec.decimals, spec.quoteDecimals);
    const { bins, tokenX, tokenY, activePrice } = syntheticBins(spec, activeBinId, binsEachSide);
    const label = `${spec.symbol}/${spec.quote}`;
    const rq = resolveQuote({ address: spec.address, label, tokenX, tokenY, activePrice, solPriceUsd });
    const c = px.candidate;
    const { model, seatUsd, bins: modelBins } = stockModelFor(spec, px.stale ? null : c, solPriceUsd, spec.binStep, spec.feeBps);
    const isThere = exists(pool);
    const pair: PairSnapshotInfo = {
      address: spec.address,
      mint: spec.mint,
      symbol: spec.symbol,
      quote: spec.quote,
      lbPair: spec.lbPair,
      exists: isThere,
      ours: ours(pool),
      synthetic: true,
      stale: px.stale,
      refPool: c?.reference.address ?? null,
      refVenue: c ? `${c.reference.venue}/${c.reference.quoteSymbol}` : null,
      refLiquidityUsd: c?.refLiquidityUsd ?? null,
      refVol24hUsd: px.stale ? null : (c?.vol24hUsd ?? null),
      refVol1hUsd: px.stale ? null : (c?.vol1hUsd ?? null),
      refAgeHours: c?.reference.ageHours ?? null,
      competingDepthUsd: c?.competingDepthUsd ?? 0,
      // a reference nobody reports routes nothing: the share reads 0 while it is gone, like the pump.fun lane's
      routedShareGross: px.stale ? 0 : model.routedShareGross,
      routedShare: px.stale ? 0 : model.routedShare,
      routedVolume24hUsd: px.stale ? 0 : model.routedVolume24hUsd,
      feesPerDayUsd: px.stale ? 0 : model.feesPerDayUsd,
      feesPerDayGrossUsd: px.stale ? 0 : model.feesPerDayGrossUsd,
      ourShare: 1,
      collectFeeMode: spec.collectFeeMode,
      creationRentSol: isThere ? 0 : PAIR_CREATION_RENT_SOL,
      seatUsd,
      stock: spec.stock ?? null,
      priceSource: px.source,
      refGoneCycles: px.refGoneCycles,
      refFeePct: c?.refFeePct,
      modelBinsPerSide: modelBins,
    };
    return {
      address: spec.address,
      label,
      tokenX,
      tokenY,
      solSide: rq.solSide,
      baseToken: rq.baseToken,
      binStep: spec.binStep,
      activeBinId,
      activePrice,
      priceLabel: `${spec.quote} per ${spec.symbol}`,
      tokenPriceInSol: rq.tokenPriceInSol,
      quoteSide: rq.quoteSide,
      quoteToken: rq.quoteToken,
      quoteSymbol: rq.quoteSymbol,
      quotePriceInSol: rq.quotePriceInSol,
      tokenPriceInQuote: rq.tokenPriceInQuote,
      solPriceUsd: rq.solPriceUsd,
      baseFeePct: spec.feeBps / 100,
      maxFeePct: 10,
      dynamicFeePct: spec.feeBps / 100,
      bins,
      liquidityBelowY: bins.filter((b) => b.binId < activeBinId).reduce((t, b) => t + b.yAmount, 0),
      liquidityAboveX: bins.filter((b) => b.binId > activeBinId).reduce((t, b) => t + b.xAmount, 0),
      fetchedAt: new Date(now()).toISOString(),
      priceModel: "meteora-dlmm",
      venue: "meteora-dlmm",
      pair,
    };
  };

  const synthetic = (pool: PairPool, binsEachSide: number, solPriceUsd: number | null): PoolSnapshot => {
    const spec = pool.pair;
    if (spec.stock) return syntheticStock(pool, binsEachSide, solPriceUsd);
    const h = hot();
    const e = env();
    const house = !!spec.house;
    let ref = referencePrice(referenceRowFor(h, spec.mint, house), spec);
    if (!ref && house) {
      // a house token with no hot row: the board's USD price for the mint is the price of last resort (nothing else to open at)
      const boardRow = deps.screenRows().find((r) => r.baseMint === spec.mint && typeof r.priceUsd === "number" && r.priceUsd! > 0);
      const sol = deps.solPriceUsd();
      const px = boardRow ? (spec.quote === "USDC" ? boardRow.priceUsd! : sol && sol > 0 ? boardRow.priceUsd! / sol : null) : null;
      if (px !== null && px > 0) ref = { price: px, stale: true, row: null };
    }
    if (!ref) throw new Error(`${spec.address}: no reference price for ${spec.symbol} in hot.json and none remembered${house ? " (a house token still needs a price to open at: a hot row or a board row for the mint)" : ""}: the pool cannot be priced this cycle`);
    const activeBinId = activeIdFromPrice(ref.price, spec.binStep, spec.decimals, spec.quoteDecimals);
    const geometry = { binStep: spec.binStep, tokenX: { decimals: spec.decimals }, tokenY: { decimals: spec.quoteDecimals } };
    const activePrice = binPrice(geometry, activeBinId);
    const own = deps.ourBins?.(spec.address, activeBinId, binsEachSide, spec) ?? null;
    const bins: BinRow[] = [];
    for (let b = activeBinId - binsEachSide; b <= activeBinId + binsEachSide; b++) {
      const mine = own?.find((r) => r.binId === b);
      bins.push({ binId: b, price: binPrice(geometry, b), xAmount: mine?.xAmount ?? 0, yAmount: mine?.yAmount ?? 0, isActive: b === activeBinId });
    }
    const tokenX: TokenInfo = { mint: spec.mint, symbol: spec.symbol, decimals: spec.decimals, reserve: bins.reduce((t, b) => t + b.xAmount, 0) };
    const tokenY: TokenInfo = { mint: spec.quoteMint, symbol: spec.quote, decimals: spec.quoteDecimals, reserve: bins.reduce((t, b) => t + b.yAmount, 0) };
    const label = `${spec.symbol}/${spec.quote}`;
    const rq = resolveQuote({ address: spec.address, label, tokenX, tokenY, activePrice, solPriceUsd });
    const row = ref.row;
    const seatUsd = solPriceUsd && solPriceUsd > 0 ? deps.seatSol() * solPriceUsd : 0;
    const competition = competitionFor(spec.mint, [...(h?.rows ?? []), ...deps.screenRows()], spec.address);
    // the model at the pool's OWN fee and bin step (the spec chose them), not the env's default
    // a house token's reference may be nothing at all: then the model has nothing to read (share n/a)
    const refKnown = !!row && !ref.stale && row.liquidityUsd !== null;
    const model = pairModel({ liquidityUsd: row?.liquidityUsd ?? null, vol24hUsd: row?.vol24hUsd ?? null, vol1hUsd: row?.vol1hUsd ?? null }, { ...e, feeBps: spec.feeBps, binStep: spec.binStep }, seatUsd, competition.depthUsd);
    const isThere = exists(pool);
    const pair: PairSnapshotInfo = {
      address: spec.address,
      mint: spec.mint,
      symbol: spec.symbol,
      quote: spec.quote,
      lbPair: spec.lbPair,
      exists: isThere,
      ours: ours(pool),
      synthetic: true,
      stale: ref.stale,
      refPool: row?.address ?? null,
      refVenue: row?.venue ?? null,
      refLiquidityUsd: row?.liquidityUsd ?? null,
      refVol24hUsd: ref.stale ? null : (row?.vol24hUsd ?? null),
      refVol1hUsd: ref.stale ? null : (row?.vol1hUsd ?? null),
      refAgeHours: row?.ageHours ?? null,
      competingDepthUsd: competition.depthUsd,
      routedShareGross: refKnown ? model.routedShareGross : 0,
      routedShare: refKnown ? model.routedShare : 0,
      routedVolume24hUsd: refKnown ? model.routedVolume24hUsd : 0,
      feesPerDayUsd: refKnown ? model.feesPerDayUsd : 0,
      ourShare: 1,
      collectFeeMode: spec.collectFeeMode,
      creationRentSol: isThere ? 0 : PAIR_CREATION_RENT_SOL,
      seatUsd,
      ...(house ? { house: true, refKnown } : {}),
    };
    return {
      address: spec.address,
      label,
      tokenX,
      tokenY,
      solSide: rq.solSide,
      baseToken: rq.baseToken,
      binStep: spec.binStep,
      activeBinId,
      activePrice,
      priceLabel: `${spec.quote} per ${spec.symbol}`,
      tokenPriceInSol: rq.tokenPriceInSol,
      quoteSide: rq.quoteSide,
      quoteToken: rq.quoteToken,
      quoteSymbol: rq.quoteSymbol,
      quotePriceInSol: rq.quotePriceInSol,
      tokenPriceInQuote: rq.tokenPriceInQuote,
      solPriceUsd: rq.solPriceUsd,
      baseFeePct: spec.feeBps / 100,
      maxFeePct: 10,
      dynamicFeePct: spec.feeBps / 100,
      bins,
      liquidityBelowY: bins.filter((b) => b.binId < activeBinId).reduce((t, b) => t + b.yAmount, 0),
      liquidityAboveX: bins.filter((b) => b.binId > activeBinId).reduce((t, b) => t + b.xAmount, 0),
      fetchedAt: new Date(now()).toISOString(),
      priceModel: "meteora-dlmm",
      venue: "meteora-dlmm",
      pair,
    };
  };

  const venue = {
    id: "meteora-dlmm" as const,
    deps,

    async loadPool(connection: Connection, address: string): Promise<PairPool> {
      const mint = pairMintOf(address);
      if (!mint) throw new Error(`${address} is not a pair key (pair-<mint>)`);
      const e = env();
      // A STOCK pair: the board carries the ticker (or the desk remembers it), the pool is STOCKx/SOL at the stock lane's terms.
      const stock = stockRef(mint) ?? lastStock.get(mint)?.candidate ?? null;
      if (stock) {
        const se = senv();
        const sq = quoteInfo("SOL");
        let decimals = decimalsCache.get(mint);
        if (decimals === undefined) {
          try {
            decimals = await mintDecimals(connection, mint);
          } catch {
            decimals = stock.baseDecimals;
          }
          decimalsCache.set(mint, decimals);
        }
        const solPrice = deps.solPriceUsd?.() ?? null;
        const seatUsd = solPrice && solPrice > 0 ? stockSeatSol() * solPrice : 0;
        const spec: PairSpec = {
          address: pairPoolAddress(mint),
          mint,
          symbol: stock.symbol,
          decimals,
          quote: "SOL",
          quoteMint: sq.mint,
          quoteDecimals: sq.decimals,
          binStep: se.binStep,
          // the fee the stock model likes for this seat against this reference (or PAIR_STOCK_FEE_BPS as set)
          feeBps: chooseStockFeeBps(
            { liquidityUsd: stock.refLiquidityUsd, vol24hUsd: stock.vol24hUsd, vol1hUsd: stock.vol1hUsd, refFeePct: stock.refFeePct, refQuoteIsSol: stock.refQuoteIsSol },
            se,
            seatUsd,
            stockBins(se.binStep, pairPoolAddress(mint)),
          ),
          collectFeeMode: se.collectFeeMode,
          lbPair: pairLbPairAddress(mint, sq.mint),
          stock: { ticker: stock.ticker, issuer: stock.issuer },
        };
        const pool: PairPool = { venue: "meteora-dlmm", address: spec.address, pair: spec, dlmm: null, connection };
        await ensureLoaded(pool);
        return pool;
      }
      const q = quoteInfo(e.quote);
      const house = isHouseMint(mint, e);
      const row = referenceRowFor(hot(), mint, house);
      let decimals = decimalsCache.get(mint);
      if (decimals === undefined) {
        try {
          decimals = await mintDecimals(connection, mint);
        } catch {
          decimals = PUMP_FUN_DECIMALS;
        }
        decimalsCache.set(mint, decimals);
      }
      const spec: PairSpec = {
        address: pairPoolAddress(mint),
        mint,
        symbol: row?.baseSymbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`,
        decimals,
        quote: e.quote,
        quoteMint: q.mint,
        quoteDecimals: q.decimals,
        binStep: e.binStep,
        // the fee the model likes for this seat against this reference (or PAIR_FEE_BPS as set)
        feeBps: chooseFeeBps(
          { liquidityUsd: row?.liquidityUsd ?? null, vol24hUsd: row?.vol24hUsd ?? null, vol1hUsd: row?.vol1hUsd ?? null },
          e,
          (deps.seatSol?.() ?? 0) * (deps.solPriceUsd?.() ?? 0),
        ),
        collectFeeMode: e.collectFeeMode,
        lbPair: pairLbPairAddress(mint, q.mint),
        ...(house ? { house: true } : {}),
      };
      const pool: PairPool = { venue: "meteora-dlmm", address: spec.address, pair: spec, dlmm: null, connection };
      await ensureLoaded(pool);
      return pool;
    },

    async snapshot(pool: VenuePool, binsEachSide: number, opts: { solPriceUsd: number | null }): Promise<PoolSnapshot> {
      const p = asPair(pool);
      await ensureLoaded(p);
      if (!p.dlmm) return synthetic(p, binsEachSide, opts.solPriceUsd);
      // the real pool: Meteora's read, keyed by the pair alias, with the model riding along
      const real = await getPoolSnapshot(p.dlmm, binsEachSide, { solPriceUsd: opts.solPriceUsd });
      if (p.pair.stock) {
        // a STOCK pair that exists on chain: the real bins and parameters, the stock model at them, the reference-gone count kept
        const spec = p.pair;
        const px = stockPrice(spec, opts.solPriceUsd);
        const c = px?.candidate ?? null;
        const stale = !c || !!px?.stale;
        const feeBps = Math.round(real.baseFeePct * 100);
        const { model, seatUsd, bins: modelBins } = stockModelFor(spec, stale ? null : c, opts.solPriceUsd, real.binStep, feeBps);
        const pair: PairSnapshotInfo = {
          address: spec.address,
          mint: spec.mint,
          symbol: spec.symbol,
          quote: spec.quote,
          lbPair: spec.lbPair,
          exists: true,
          ours: ours(p),
          synthetic: false,
          stale,
          refPool: c?.reference.address ?? null,
          refVenue: c ? `${c.reference.venue}/${c.reference.quoteSymbol}` : null,
          refLiquidityUsd: c?.refLiquidityUsd ?? null,
          refVol24hUsd: c?.vol24hUsd ?? null,
          refVol1hUsd: c?.vol1hUsd ?? null,
          refAgeHours: c?.reference.ageHours ?? null,
          competingDepthUsd: c?.competingDepthUsd ?? 0,
          routedShareGross: stale ? 0 : model.routedShareGross,
          routedShare: stale ? 0 : model.routedShare,
          routedVolume24hUsd: stale ? 0 : model.routedVolume24hUsd,
          feesPerDayUsd: stale ? 0 : model.feesPerDayUsd,
          feesPerDayGrossUsd: stale ? 0 : model.feesPerDayGrossUsd,
          // a real pool may hold other LPs: the bin arithmetic decides our share
          ourShare: null,
          collectFeeMode: spec.collectFeeMode,
          creationRentSol: 0,
          seatUsd,
          stock: spec.stock,
          priceSource: "pool",
          refGoneCycles: px?.refGoneCycles ?? (refGone.get(spec.mint) ?? 0),
          refFeePct: c?.refFeePct,
          modelBinsPerSide: modelBins,
        };
        return { ...real, address: spec.address, label: `${spec.symbol}/${spec.quote}`, pair };
      }
      const h = hot();
      const row = referenceRowFor(h, p.pair.mint, !!p.pair.house);
      const e = env();
      const seatUsd = opts.solPriceUsd && opts.solPriceUsd > 0 ? deps.seatSol() * opts.solPriceUsd : 0;
      const competition = competitionFor(p.pair.mint, [...(h?.rows ?? []), ...deps.screenRows()], p.pair.address);
      const model = pairModel({ liquidityUsd: row?.liquidityUsd ?? null, vol24hUsd: row?.vol24hUsd ?? null, vol1hUsd: row?.vol1hUsd ?? null }, { ...e, binStep: real.binStep, feeBps: Math.round(real.baseFeePct * 100) }, seatUsd, competition.depthUsd);
      const pair: PairSnapshotInfo = {
        address: p.pair.address,
        mint: p.pair.mint,
        symbol: p.pair.symbol,
        quote: p.pair.quote,
        lbPair: p.pair.lbPair,
        exists: true,
        ours: ours(p),
        synthetic: false,
        stale: row === null,
        refPool: row?.address ?? null,
        refVenue: row?.venue ?? null,
        refLiquidityUsd: row?.liquidityUsd ?? null,
        refVol24hUsd: row?.vol24hUsd ?? null,
        refVol1hUsd: row?.vol1hUsd ?? null,
        refAgeHours: row?.ageHours ?? null,
        competingDepthUsd: competition.depthUsd,
        routedShareGross: model.routedShareGross,
        routedShare: model.routedShare,
        routedVolume24hUsd: model.routedVolume24hUsd,
        feesPerDayUsd: model.feesPerDayUsd,
        // a real pool may hold other LPs: the bin arithmetic decides our share
        ourShare: null,
        collectFeeMode: p.pair.collectFeeMode,
        creationRentSol: 0,
        seatUsd,
        ...(p.pair.house ? { house: true, refKnown: !!row && row.liquidityUsd !== null } : {}),
      };
      return { ...real, address: p.pair.address, label: `${p.pair.symbol}/${p.pair.quote}`, pair };
    },

    async positions(pool: VenuePool, owner: PublicKey, snapshot: PoolSnapshot) {
      const p = asPair(pool);
      if (!p.dlmm) return { raw: [], positions: [] };
      return getUserPositions(p.dlmm, owner, snapshot);
    },

    async buildOpen(pool: VenuePool, owner: PublicKey, plan: OpenPlan): Promise<BuiltTx> {
      const p = asPair(pool);
      if (!p.dlmm) throw new Error(`${p.address}: the pool does not exist yet; the executor creates it first (buildCreate)`);
      const { tx, positionKeypair } = await buildOpenPositionTx(p.dlmm, owner, plan);
      return { tx, signers: [positionKeypair], label: `seed ${plan.side ?? "BOTH"} band bins [${plan.minBinId}, ${plan.maxBinId}] in our pair`, positionAddress: positionKeypair.publicKey.toBase58() };
    },

    async buildClose(pool: VenuePool, owner: PublicKey, raw: unknown): Promise<BuiltTx[]> {
      const p = asPair(pool);
      if (!p.dlmm) throw new Error(`${p.address}: no pool on chain to close a band in`);
      const position = raw as LbPosition;
      const txs = await buildClosePositionTxs(p.dlmm, owner, position);
      const addr = position.publicKey.toBase58();
      return txs.map((tx, i) => ({ tx, signers: [], label: `close band ${addr.slice(0, 6)} ${i + 1}/${txs.length}` }));
    },

    /** a band in our own pool is a DLMM position like any other: its account's lamports are the refund */
    async closeRefundSol(connection: Connection, raw: unknown): Promise<number | null> {
      return meteoraVenue.closeRefundSol!(connection, raw);
    },

    async buildClaim(pool: VenuePool, owner: PublicKey, raws: unknown[]): Promise<BuiltTx[]> {
      const p = asPair(pool);
      if (!p.dlmm) throw new Error(`${p.address}: no pool on chain to claim fees in`);
      const txs = await buildClaimFeesTxs(p.dlmm, owner, raws as LbPosition[]);
      return txs.map((tx, i) => ({ tx, signers: [], label: `claim fees ${i + 1}/${txs.length}` }));
    },

    openCostSol(snapshot: PoolSnapshot, plan?: OpenPlan): OpenCost {
      if (snapshot.pair && !snapshot.pair.exists) {
        return { total: PAIR_OPEN_COST_SOL, refundable: POSITION_RENT_SOL, note: "pool creation (lb pair + 2 reserves + oracle) + position + 2 bin arrays" };
      }
      return meteoraOpenCost(snapshot, plan);
    },

    /** The create transaction for a pool that does not exist yet: the pure params, then the SDK. */
    async buildCreate(pool: PairPool, owner: PublicKey, snapshot: PoolSnapshot): Promise<BuiltTx> {
      const spec = pool.pair;
      const { tx, params } = await buildCreatePool(pool.connection, owner, {
        tokenMint: spec.mint,
        quoteMint: spec.quoteMint,
        binStep: spec.binStep,
        feeBps: spec.feeBps,
        activeId: snapshot.activeBinId,
        collectFeeMode: spec.collectFeeMode,
      });
      return {
        tx,
        signers: [],
        label: `create pool ${spec.symbol}/${spec.quote} (${params.lbPair.toBase58().slice(0, 6)}, bin step ${spec.binStep}, fee ${spec.feeBps} bps, active bin ${snapshot.activeBinId})`,
        notes: [`rent ${PAIR_POOL_ACCOUNTS_RENT_SOL.toFixed(6)} SOL for the pool's accounts now, ${(2 * BIN_ARRAY_FEE).toFixed(6)} SOL more for the seed's bin arrays; none of it comes back`],
      };
    },
  };
  return venue;
}

/** The SOL a pair seat may hold at the desk's limits, for the venue's model sizing. */
export const pairSeatSolOf = (maxTotalExposureSol: number, env: PairEnv = pairEnv()): number => pairSeatSol(maxTotalExposureSol, env);

export { isPairAddress, pairMintOf, pairPoolAddress, OPEN_COST_ESTIMATE_SOL as PAIR_SEAT_OPEN_COST_SOL };
