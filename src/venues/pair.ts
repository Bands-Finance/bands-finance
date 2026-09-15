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
import { config } from "../config";
import { loadHotFileCached } from "../hot/store";
import type { HotFile, HotRow } from "../hot/types";
import type { PaperBook } from "../paper/book";
import type { PairPoolRecord } from "../risk/state";
import { activeIdFromPrice, competitionFor, isPairAddress, pairEnv, pairMintOf, pairModel, pairPoolAddress, pairSeatSol, type PairEnv, chooseFeeBps } from "../screener/pair";
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
import { meteoraOpenCost } from "./meteora";
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

/** The reference PumpSwap row for a mint in a hot file: the deepest pumpswap pool of the token, else any pump.fun row for it. */
export function referenceRowFor(hot: HotFile | null, mint: string): HotRow | null {
  if (!hot) return null;
  const rows = hot.rows.filter((r) => r.baseMint === mint);
  const pump = rows.filter((r) => r.venue === "pumpswap").sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
  return pump[0] ?? rows.find((r) => r.origin === "pump.fun") ?? null;
}

/** The hot row the loop should read for a pool: the reference row for a made pair, the pool's own row otherwise. */
export function hotRowForPool(hot: HotFile | null, address: string): HotRow | undefined {
  const mint = pairMintOf(address);
  if (mint) return referenceRowFor(hot, mint) ?? undefined;
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
  /** the board's rows, for the competing concentrated depth */
  screenRows: () => readonly { address: string; venue: string; baseMint: string; quoteSymbol: string; liquidityUsd: number | null }[];
  /** the bins our own paper deposits occupy, for the synthetic snapshot; absent = empty bins */
  ourBins?: (address: string, activeBinId: number, binsEachSide: number, spec: PairSpec) => BinRow[] | null;
  env?: () => PairEnv;
  hot?: () => HotFile | null;
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

  const synthetic = (pool: PairPool, binsEachSide: number, solPriceUsd: number | null): PoolSnapshot => {
    const spec = pool.pair;
    const h = hot();
    const ref = referencePrice(referenceRowFor(h, spec.mint), spec);
    if (!ref) throw new Error(`${spec.address}: no reference price for ${spec.symbol} in hot.json and none remembered: the pool cannot be priced this cycle`);
    const e = env();
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
    const model = pairModel({ liquidityUsd: row?.liquidityUsd ?? null, vol24hUsd: row?.vol24hUsd ?? null, vol1hUsd: row?.vol1hUsd ?? null }, e, seatUsd, competition.depthUsd);
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
      routedShareGross: ref.stale ? 0 : model.routedShareGross,
      routedShare: ref.stale ? 0 : model.routedShare,
      routedVolume24hUsd: ref.stale ? 0 : model.routedVolume24hUsd,
      feesPerDayUsd: ref.stale ? 0 : model.feesPerDayUsd,
      ourShare: 1,
      collectFeeMode: spec.collectFeeMode,
      creationRentSol: isThere ? 0 : PAIR_CREATION_RENT_SOL,
      seatUsd,
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
      const q = quoteInfo(e.quote);
      const row = referenceRowFor(hot(), mint);
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
      const h = hot();
      const row = referenceRowFor(h, p.pair.mint);
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

    async buildClaim(pool: VenuePool, owner: PublicKey, raws: unknown[]): Promise<BuiltTx[]> {
      const p = asPair(pool);
      if (!p.dlmm) throw new Error(`${p.address}: no pool on chain to claim fees in`);
      const txs = await buildClaimFeesTxs(p.dlmm, owner, raws as LbPosition[]);
      return txs.map((tx, i) => ({ tx, signers: [], label: `claim fees ${i + 1}/${txs.length}` }));
    },

    openCostSol(snapshot: PoolSnapshot): OpenCost {
      if (snapshot.pair && !snapshot.pair.exists) {
        return { total: PAIR_OPEN_COST_SOL, refundable: POSITION_RENT_SOL, note: "pool creation (lb pair + 2 reserves + oracle) + position + 2 bin arrays" };
      }
      return meteoraOpenCost();
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
