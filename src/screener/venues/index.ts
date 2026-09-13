/**
 * The off-chain venues: Raydium CLMM and Orca Whirlpools through their public APIs, normalised
 * into the same shape the on-chain Meteora scan produces so one scorer ranks all three.
 */
import type { Venue, VenuePool } from "../types";
import { fetchRaydium, normalizeRaydium } from "./raydium";
import { fetchOrca, normalizeOrca } from "./orca";

export { SOL_MINT, USDC_MINT, pickQuote, tickFromPrice, cleanSymbol, num, getJson } from "./common";
export type { QuotePick } from "./common";

export const ALL_VENUES: Venue[] = ["meteora-dlmm", "raydium-clmm", "orca-whirlpool"];
/** the venues read through an API; Meteora is always scanned on-chain */
export const API_VENUES: Venue[] = ["raydium-clmm", "orca-whirlpool"];

export const VENUE_LABEL: Record<Venue, string> = {
  "meteora-dlmm": "Meteora",
  "raydium-clmm": "Raydium",
  "orca-whirlpool": "Orca",
};

/** Screener knobs read straight from the environment (src/config.ts is not ours to edit). */
export function venueEnv(env: NodeJS.ProcessEnv = process.env) {
  const int = (k: string, d: number) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : d;
  };
  const raw = (env.SCREEN_VENUES ?? "").trim();
  const venues = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Venue => (API_VENUES as string[]).includes(s));
  return {
    /** the API venues to screen (SCREEN_VENUES, default both; "none" turns them off); Meteora is always scanned on-chain */
    venues: raw.toLowerCase() === "none" ? [] : venues.length ? venues : API_VENUES,
    /** Raydium pages of 500, sorted by 24h volume so the cap keeps the live pools */
    raydiumMaxPages: int("SCREEN_RAYDIUM_MAX_PAGES", 4),
    /** Orca pages of 200, same ordering */
    orcaMaxPages: int("SCREEN_ORCA_MAX_PAGES", 5),
  };
}

export interface VenueScan {
  venue: Venue;
  /** rows the API returned */
  scanned: number;
  /** rows that are SOL/USDC-quoted, traded in the last day and above the liquidity floor */
  live: number;
  pools: VenuePool[];
  ms: number;
  pages: number;
  error: string | null;
}

export interface VenueScanOptions {
  venues: Venue[];
  /** minimum liquidity in quote units (SOL pools; USDC pools use x100), as scan.ts applies it */
  minTvlSol: number;
  raydiumMaxPages: number;
  orcaMaxPages: number;
  log?: (s: string) => void;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
  pauseMs?: number;
  backoffMs?: number;
}

/** Live means: traded in the last day, above the same liquidity floor the on-chain scan applies. */
export function isLive(p: VenuePool, minTvlSol: number): boolean {
  const floor = p.quoteSymbol === "SOL" ? minTvlSol : minTvlSol * 100;
  return (p.volume24hUsd ?? 0) > 0 && p.tvlQuote >= floor;
}

async function scanOne(
  venue: Venue,
  fetchRows: () => Promise<{ rows: unknown[]; pages: number }>,
  normalize: (row: unknown, now: number) => VenuePool | null,
  minTvlSol: number,
  log: (s: string) => void,
): Promise<VenueScan> {
  const t0 = Date.now();
  try {
    const { rows, pages } = await fetchRows();
    const now = Date.now();
    const seen = new Set<string>();
    const pools: VenuePool[] = [];
    for (const row of rows) {
      const p = normalize(row, now);
      if (!p || seen.has(p.address) || !isLive(p, minTvlSol)) continue;
      seen.add(p.address);
      pools.push(p);
    }
    pools.sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0) || (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
    const ms = Date.now() - t0;
    log(`[${VENUE_LABEL[venue].toLowerCase()}] ${rows.length} pools from the API over ${pages} page${pages === 1 ? "" : "s"}, ${pools.length} live SOL/USDC pools above the floor (${ms}ms)`);
    return { venue, scanned: rows.length, live: pools.length, pools, ms, pages, error: null };
  } catch (err) {
    const msg = (err as Error).message;
    log(`[${VENUE_LABEL[venue].toLowerCase()}] failed: ${msg}`);
    return { venue, scanned: 0, live: 0, pools: [], ms: Date.now() - t0, pages: 0, error: msg };
  }
}

/** Fetch and normalise every API venue in parallel. A venue that fails yields an empty scan with its error, never a throw. */
export async function scanVenues(opts: VenueScanOptions): Promise<VenueScan[]> {
  const log = opts.log ?? (() => {});
  const common = { log, fetchImpl: opts.fetchImpl, pauseMs: opts.pauseMs, backoffMs: opts.backoffMs };
  const jobs: Promise<VenueScan>[] = [];
  if (opts.venues.includes("raydium-clmm")) {
    jobs.push(scanOne("raydium-clmm", () => fetchRaydium({ maxPages: opts.raydiumMaxPages, ...common }), normalizeRaydium, opts.minTvlSol, log));
  }
  if (opts.venues.includes("orca-whirlpool")) {
    jobs.push(scanOne("orca-whirlpool", () => fetchOrca({ maxPages: opts.orcaMaxPages, ...common }), normalizeOrca, opts.minTvlSol, log));
  }
  return Promise.all(jobs);
}

