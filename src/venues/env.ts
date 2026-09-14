/**
 * Venue knobs, read straight from the environment (src/config.ts is not edited):
 *   TRADABLE_VENUES             venues the desk may observe and trade, comma-separated
 *                               (default "meteora-dlmm,raydium-clmm"; "none" keeps every venue off)
 *   LIVE_VENUES                 venues the executor may BROADCAST on (default "meteora-dlmm"); a venue
 *                               that is tradable but not live runs in paper and dry-run only
 *   BOOK                        "all" (default) or "stocks": tokenized-stock pools are picked first
 *   STOCK_MIN_LIQUIDITY_USD     liquidity floor for the stock book (default 250000)
 *   PRIORITY_FEE_MICROLAMPORTS  compute-unit price for Raydium transactions (default 0)
 * Pure functions of an env object so tests pin their own.
 */
import { VENUE_IDS, type VenueId } from "./types";

export const DEFAULT_TRADABLE_VENUES: readonly VenueId[] = ["meteora-dlmm", "raydium-clmm"];
export const DEFAULT_LIVE_VENUES: readonly VenueId[] = ["meteora-dlmm"];
export const DEFAULT_STOCK_MIN_LIQUIDITY_USD = 250_000;

export type Book = "all" | "stocks";

export const isVenueId = (v: string): v is VenueId => (VENUE_IDS as readonly string[]).includes(v);

/** "a, b" -> [a, b] keeping only known venue ids, in order, deduplicated; "none" -> []; unset -> the fallback. */
export function parseVenueList(raw: string | undefined, fallback: readonly VenueId[]): VenueId[] {
  if (raw === undefined || raw.trim() === "") return [...fallback];
  if (raw.trim().toLowerCase() === "none") return [];
  const out: VenueId[] = [];
  for (const part of raw.split(",")) {
    const v = part.trim().toLowerCase();
    if (isVenueId(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

export function tradableVenues(env: NodeJS.ProcessEnv = process.env): VenueId[] {
  return parseVenueList(env.TRADABLE_VENUES, DEFAULT_TRADABLE_VENUES);
}

/** The venues LIVE_VENUES names. A venue must also be tradable to be live: see isLiveVenue. */
export function liveVenues(env: NodeJS.ProcessEnv = process.env): VenueId[] {
  return parseVenueList(env.LIVE_VENUES, DEFAULT_LIVE_VENUES);
}

export function isTradableVenue(venue: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (tradableVenues(env) as string[]).includes(venue);
}

/** Tradable and listed in LIVE_VENUES: the executor may broadcast on it when DRY_RUN=false. */
export function isLiveVenue(venue: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return isTradableVenue(venue, env) && (liveVenues(env) as string[]).includes(venue);
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function bookEnv(env: NodeJS.ProcessEnv = process.env): Book {
  return (env.BOOK ?? "").trim().toLowerCase() === "stocks" ? "stocks" : "all";
}

export function stockMinLiquidityUsd(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(0, num(env.STOCK_MIN_LIQUIDITY_USD, DEFAULT_STOCK_MIN_LIQUIDITY_USD));
}

export function priorityFeeMicroLamports(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(0, Math.floor(num(env.PRIORITY_FEE_MICROLAMPORTS, 0)));
}
