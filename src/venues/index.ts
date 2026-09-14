/**
 * Venue lookup: which adapter serves a pool, and where a pool lives.
 *   venueOf(id)                          the adapter (Orca throws: not tradable yet)
 *   detectVenue(connection, address)     the screen's venue when the pool is on the board, else the
 *                                        account's owner program; cached per address
 *   loadVenuePool(connection, address)   detect + load, the pair the loop caches
 *   poolsWithPositions(connection, owner) pools the owner holds a position in, across tradable venues
 * Env (env.ts): tradableVenues(), liveVenues(), isTradableVenue(), isLiveVenue(), bookEnv() ...
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { loadScreen } from "../screener";
import { VENUE_IDS } from "./types";
import { meteoraVenue } from "./meteora";
import { raydiumVenue } from "./raydium";
import type { Venue, VenueId, VenuePool } from "./types";

export * from "./types";
export * from "./env";
export { stockBookPools } from "./stocks";
export { meteoraVenue, meteoraOpenCost, type MeteoraPool } from "./meteora";
export {
  raydiumVenue,
  clmmOpenCost,
  clmmBins,
  toClmmPositionSnapshot,
  CLMM_OPEN_COST_DEFAULT_SOL,
  CLMM_POSITION_RENT_SOL,
  CLMM_PROTOCOL_POSITION_RENT_SOL,
  CLMM_TICK_ARRAY_RENT_SOL,
  RENT_LAMPORTS_PER_BYTE,
  rentSol,
  type ClmmPosition,
  type RaydiumPool,
} from "./raydium";

export const METEORA_DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
export const RAYDIUM_CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
export const ORCA_WHIRLPOOL_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";

export const VENUE_BY_PROGRAM: Readonly<Record<string, VenueId>> = {
  [METEORA_DLMM_PROGRAM]: "meteora-dlmm",
  [RAYDIUM_CLMM_PROGRAM]: "raydium-clmm",
  [ORCA_WHIRLPOOL_PROGRAM]: "orca-whirlpool",
};

export function venueOf(id: VenueId | string): Venue {
  switch (id) {
    case "meteora-dlmm":
      return meteoraVenue;
    case "raydium-clmm":
      return raydiumVenue;
    case "orca-whirlpool":
      throw new Error("orca-whirlpool is not tradable yet: no venue adapter (next after Raydium CLMM)");
    default:
      throw new Error(`unknown venue ${id}`);
  }
}

/** The venue a pool program's owner id maps to, or null. */
export const venueOfProgram = (owner: string): VenueId | null => VENUE_BY_PROGRAM[owner] ?? null;

const cache = new Map<string, VenueId>();

/** Forget cached venues (tests). */
export function clearVenueCache(): void {
  cache.clear();
}

/** The connection surface detectVenue needs, so a test can hand it a fake. */
export type VenueLookupConnection = Pick<Connection, "getAccountInfo">;

/**
 * Where a pool lives: the hint (the screen's venue when the caller has it), else the screen on disk,
 * else the account's owner program. Cached: a pool never moves. Throws for an unknown program or a
 * missing account.
 */
export async function detectVenue(connection: VenueLookupConnection, address: string, hint?: VenueId | null): Promise<VenueId> {
  const cached = cache.get(address);
  if (cached) return cached;
  let venue: VenueId | null = hint ?? null;
  if (!venue) {
    const row = loadScreen()?.pools.find((p) => p.address === address);
    if (row) venue = row.venue;
  }
  if (!venue) {
    const info = await connection.getAccountInfo(new PublicKey(address));
    if (!info) throw new Error(`no account at ${address}: not a pool`);
    const owner = info.owner.toBase58();
    venue = venueOfProgram(owner);
    if (!venue) throw new Error(`${address} is owned by ${owner}, not a pool program the desk knows (Meteora DLMM, Raydium CLMM, Orca Whirlpool)`);
  }
  cache.set(address, venue);
  return venue;
}

/**
 * Detect and load: the {venue, pool} pair the loop caches per address. Any venue with an adapter
 * loads, tradable or not: a band we HOLD must be observed, guarded and closable even after its venue
 * is taken out of TRADABLE_VENUES. Whether we may OPEN there is the guards' question
 * (src/risk/guards.ts refuses opens on a venue that is not tradable), not the loader's.
 */
export async function loadVenuePool(connection: Connection, address: string, hint?: VenueId | null): Promise<{ venue: Venue; pool: VenuePool }> {
  const id = await detectVenue(connection, address, hint);
  const venue = venueOf(id);
  return { venue, pool: await venue.loadPool(connection, address) };
}

/** Every venue that has an adapter, whether or not TRADABLE_VENUES names it. */
export const adapterVenues = (): VenueId[] => VENUE_IDS.filter((id) => id !== "orca-whirlpool");

/**
 * Pools the owner holds a position in, on EVERY venue with an adapter (not just the tradable ones:
 * what we hold, we manage). Throws when any venue fails to answer: a partial list would let a held
 * band drop out of the cycle unguarded and out of the marks, and three such cycles read as a crater
 * to the portfolio breaker. The loop skips the cycle instead and asks again next time.
 */
export async function poolsWithPositions(connection: Connection, owner: PublicKey, log: (s: string) => void = () => {}): Promise<{ address: string; venue: VenueId }[]> {
  const out: { address: string; venue: VenueId }[] = [];
  for (const id of adapterVenues()) {
    const venue = venueOf(id);
    if (!venue.poolsWithPositions) continue;
    try {
      for (const address of await venue.poolsWithPositions(connection, owner)) out.push({ address, venue: id });
    } catch (err) {
      log(`[venues] could not list ${id} positions: ${(err as Error).message}`);
      throw new Error(`could not list ${id} positions (${(err as Error).message}); skipping the cycle rather than working a partial list`);
    }
  }
  return out;
}
