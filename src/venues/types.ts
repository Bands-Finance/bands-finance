/**
 * The venue layer: one interface every trading venue implements, so the loop, the executor, the
 * paper desk and the scripts never touch a venue SDK directly.
 *   meteora.ts   Meteora DLMM, wrapping src/tools/dlmm.ts unchanged
 *   raydium.ts   Raydium CLMM through @raydium-io/raydium-sdk-v2 (ships dormant: paper and dry-run
 *                until LIVE_VENUES includes it)
 *   index.ts     venueOf(id), detectVenue(connection, address), loadVenuePool, poolsWithPositions
 *   env.ts       TRADABLE_VENUES / LIVE_VENUES / BOOK / PRIORITY_FEE_MICROLAMPORTS / STOCK_MIN_LIQUIDITY_USD
 *
 * Every venue speaks the desk's bin model (src/tools/bins.ts): a PoolSnapshot with bins around an
 * active bin and PositionSnapshots with bin ranges. What a "bin" is on chain is the venue's business.
 */
import type { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { OpenPlan, PoolSnapshot, PositionSnapshot } from "../tools/dlmm";

/** The venues the screener knows. Orca has no adapter yet: venueOf("orca-whirlpool") throws. */
export type VenueId = "meteora-dlmm" | "raydium-clmm" | "orca-whirlpool";
export const VENUE_IDS: readonly VenueId[] = ["meteora-dlmm", "raydium-clmm", "orca-whirlpool"];

/** A loaded pool. Adapters extend this with their SDK handle; callers only see venue and address. */
export interface VenuePool {
  venue: VenueId;
  address: string;
}

/** One transaction ready for the wallet: legacy or versioned, with every signer the wallet does not hold. */
export interface BuiltTx {
  tx: Transaction | VersionedTransaction;
  /** extra signers (a fresh position keypair or NFT mint); the wallet adds its own key */
  signers: Keypair[];
  label: string;
  /** an open: the address the position will be known by (Meteora position account, Raydium NFT mint) */
  positionAddress?: string;
  /** anything the caller should surface (dry-run assumptions, clipped ranges) */
  notes?: string[];
}

/** What an open costs up front, in SOL, and how much of it comes back on close. */
export interface OpenCost {
  total: number;
  refundable: number;
  note?: string;
}

export interface SnapshotOpts {
  /** the SOL price in USD, needed to value a USDC-quoted pool in SOL */
  solPriceUsd: number | null;
}

export interface Venue {
  id: VenueId;
  loadPool(connection: Connection, address: string): Promise<VenuePool>;
  /** read the pool: bins around the active bin, fees, reserves, the quote view */
  snapshot(pool: VenuePool, binsEachSide: number, opts: SnapshotOpts): Promise<PoolSnapshot>;
  /** the owner's positions in this pool; raw[i] is whatever the venue needs to close/collect positions[i] */
  positions(pool: VenuePool, owner: PublicKey, snapshot: PoolSnapshot): Promise<{ raw: unknown[]; positions: PositionSnapshot[] }>;
  buildOpen(pool: VenuePool, owner: PublicKey, plan: OpenPlan, snapshot: PoolSnapshot): Promise<BuiltTx>;
  /** remove all liquidity, collect fees, close the position account */
  buildClose(pool: VenuePool, owner: PublicKey, raw: unknown, snapshot: PoolSnapshot): Promise<BuiltTx[]>;
  /** collect fees only */
  buildClaim(pool: VenuePool, owner: PublicKey, raws: unknown[], snapshot: PoolSnapshot): Promise<BuiltTx[]>;
  /** the up-front cost of an open; without a plan, the cost of a typical band near the price */
  openCostSol(snapshot: PoolSnapshot, plan?: OpenPlan): OpenCost;
  /** pools in which the owner holds a position on this venue (for the loop's "pools with bands") */
  poolsWithPositions?(connection: Connection, owner: PublicKey): Promise<string[]>;
}
