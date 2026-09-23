/**
 * The hot watch: a fast loop beside the 15-minute screener. Every tick (2 minutes by default) it
 * reads short-window volume from cheap public sources, computes what a dollar of liquidity earned
 * in the last hour, ranks the surges, records them and hands the loop a list.
 *
 *   runHotTick(opts?)     one tick: fetch, compute, write data/hot.json + data/hot-history.jsonl, return the HotFile
 *   loadHot()             the latest tick from disk, or null
 *   hotRoutes(app)        GET /api/hot
 *   startHotWatch(opts)   a self-scheduling timer that never overlaps ticks and catches every error
 *   hotPicks(hot, opts)   the tradable surges, best heat first, for pickPools
 *
 * Sources: GeckoTerminal trending (5m + 1h) finds what moves; GeckoTerminal's top PumpSwap pools
 * (HOT_PUMPSWAP_PAGES pages of 20) bring the biggest graduated pump.fun tokens, which the pair lane
 * (src/screener/pair.ts) reads as REFERENCE pools; DexScreener refreshes the board's top rows, every
 * held pool, the trending and the PumpSwap candidates in one pass. Fee rates come from our own board
 * row when the pool is on it; a trending Meteora DLMM pool off the board is read live once (capped
 * per tick, cached an hour); anything else off the board has no fee and is shown by turnover.
 * Nothing here edits src/config.ts: knobs are HOT_* in the environment (src/hot/env.ts).
 *
 * SIBLING POOLS. Trending ranks pools, not tokens, and a token's biggest pool is often one we
 * cannot quote: WET trended in WET/PTN on Raydium ($2.9M in 24h, a quote the book cannot seat)
 * while its WET/SOL pools on Meteora, which the desk could have worked, never trended because they
 * are smaller. So when a token turns up on trending (or high on the board) in a pool we cannot
 * trade, and that pool is carrying real volume, we ask GeckoTerminal for the token's OTHER pools
 * (GET /networks/solana/tokens/{mint}/pools, same row shape as trending) and let the tradable ones
 * into the same pipeline as anything else. Capped at HOT_SIBLING_LOOKUPS calls a tick, most
 * promising token first, each token's answer cached for HOT_SIBLING_TTL_MIN.
 */
import { Connection } from "@solana/web3.js";
import type { Hono } from "hono";
import { config } from "../config";
import { readRecent } from "../journal";
import { loadScreen } from "../screener";
import type { ScreenedPool, ScreenResult } from "../screener/types";
import { getPoolSnapshot, loadPool } from "../tools/dlmm";
import { launchEnv, launchVerdict, type LaunchEnv } from "../screener/launch";
import { isTradableVenue } from "../venues/env";
import { hotEnv, type HotEnv } from "./env";
import { heatOf, hotMetrics, type HotInputs } from "./score";
import { fetchDexScreener, fetchPumpSwap, fetchTokenPools, fetchTrending, originOf, SOL_MINT, USDC_MINT, type SourceOpts } from "./sources";
import { appendHistory, heldPools, loadHotFile, readHistoryTail, saveHotFile } from "./store";
import { detectSurges, SURGE_STICKY_MS, SURGE_WINDOW_MS } from "./surge";
import type { HotFile, HotHistoryRow, HotRow, PoolSample } from "./types";
import { rpcConnection } from "../lib/timedFetch";

export { hotEnv, type HotEnv } from "./env";
export { FADING_MIN_VOL1H, FADING_SHARE, heatOf, hotMetrics, NOMINAL_FEE_PCT, type Heat, type HeatOpts, type HotInputs, type HotMetrics } from "./score";
export {
  DEXSCREENER_URL,
  fetchDexScreener,
  fetchPumpSwap,
  fetchTokenPools,
  fetchTrending,
  originOf,
  parseDexScreener,
  parseGeckoPools,
  parsePumpSwapPools,
  parseTokenPools,
  parseTrending,
  PUMPSWAP_URL,
  quoteSymbolOf,
  splitName,
  TOKEN_POOLS_URL,
  TRENDING_URL,
  venueOfDex,
  type SiblingResult,
  type SourceOpts,
  type SourceResult,
} from "./sources";
export { appendHistory, heldPools, HISTORY_FILE, HOT_FILE, loadHotFile, parseHistory, readHistoryTail, rolledTape, saveHotFile, TAPE_MAX_BYTES } from "./store";
export { detectSurges, latestByAddress, SURGE_MIN_ACCELERATION, SURGE_STICKY_MS, SURGE_TOP_N, SURGE_WINDOW_MS, topTenSeen, type SurgeCandidate, type SurgeVerdict } from "./surge";
export { launchEnv, launchSeats, launchVerdict, type LaunchCandidate, type LaunchEnv, type LaunchVerdict } from "../screener/launch";
export type { HotFeeSource, HotFile, HotHistoryRow, HotRow, HotSources, PoolSample } from "./types";

/* ---------- the live Meteora fee read, with its cache ---------- */

export interface FeeCacheEntry {
  feePct: number | null;
  at: number;
}
/** a fee rate read from chain is good for an hour; a failed read is not retried for ten minutes */
export const FEE_CACHE_MS = 3600e3;
export const FEE_FAIL_CACHE_MS = 10 * 60e3;
const defaultFeeCache = new Map<string, FeeCacheEntry>();

let connection: Connection | null = null;
/** The fee traders pay in a DLMM pool right now: the dynamic fee when the pool has one, else the base. Throws when the pool cannot be read or valued. */
export async function readMeteoraFee(address: string, solPriceUsd: number | null): Promise<number | null> {
  connection ??= rpcConnection(config.rpcUrl);
  const dlmm = await loadPool(connection, address);
  const s = await getPoolSnapshot(dlmm, 0, { solPriceUsd });
  return s.dynamicFeePct > 0 ? s.dynamicFeePct : s.baseFeePct;
}

/* ---------- pure pieces of the tick (tested without a network) ---------- */

/** A source's price change describes its base; when its quote is our base the move is the reciprocal. */
export function flipPct(p: number | null): number | null {
  if (p === null || p <= -100) return null;
  return 100 / (1 + p / 100) - 100;
}

/** Price changes and prices oriented to our base token; volume, liquidity and counts are symmetric. */
export function orient(s: PoolSample, baseMint: string): PoolSample {
  const flipped = s.quoteMint !== null && s.quoteMint === baseMint && s.baseMint !== baseMint;
  if (!flipped) return s;
  return {
    ...s,
    priceChange5mPct: flipPct(s.priceChange5mPct),
    priceChange1hPct: flipPct(s.priceChange1hPct),
    priceChange24hPct: flipPct(s.priceChange24hPct),
    // the source priced ITS base in our token; our base in its units is the reciprocal
    priceNative: s.priceNative !== null && s.priceNative > 0 ? 1 / s.priceNative : null,
    priceUsd: s.quotePriceUsd,
    quotePriceUsd: s.priceUsd,
    // the source sized ITS base, which is our quote: nothing is known about ours
    marketCapUsd: null,
  };
}

export interface Identity {
  name: string;
  venue: string;
  baseMint: string;
  baseSymbol: string;
  quoteMint: string;
  quoteSymbol: string;
}

const short = (m: string) => (m.length > 10 ? `${m.slice(0, 4)}…${m.slice(-4)}` : m);

/** Who the pool is: the board row knows best, then GeckoTerminal, then DexScreener. */
export function identityOf(board: ScreenedPool | undefined, trend: PoolSample | undefined, dex: PoolSample | undefined): Identity | null {
  if (board) return { name: board.name, venue: board.venue, baseMint: board.baseMint, baseSymbol: board.baseSymbol, quoteMint: board.quoteMint, quoteSymbol: board.quoteSymbol };
  const s = trend ?? dex;
  if (!s) return null;
  const other = s === trend ? dex : trend;
  const baseMint = s.baseMint ?? other?.baseMint ?? "";
  const quoteMint = s.quoteMint ?? other?.quoteMint ?? "";
  const baseSymbol = s.baseSymbol ?? other?.baseSymbol ?? short(baseMint);
  const quoteSymbol = s.quoteSymbol ?? other?.quoteSymbol ?? short(quoteMint);
  return { name: s.name ?? other?.name ?? `${baseSymbol} / ${quoteSymbol}`, venue: s.venue, baseMint, baseSymbol, quoteMint, quoteSymbol };
}

/** The short-window figures: DexScreener first (one fresh pass over everything), GeckoTerminal fills the gaps. */
export function inputsOf(dex: PoolSample | undefined, trend: PoolSample | undefined, feePct: number | null, ageHours: number | null): HotInputs {
  const pick = <T>(a: T | null | undefined, b: T | null | undefined): T | null => (a !== null && a !== undefined ? a : b ?? null);
  return {
    vol1hUsd: pick(dex?.vol1hUsd, trend?.vol1hUsd),
    vol5mUsd: pick(dex?.vol5mUsd, trend?.vol5mUsd),
    vol24hUsd: pick(dex?.vol24hUsd, trend?.vol24hUsd),
    liquidityUsd: pick(dex?.liquidityUsd, trend?.liquidityUsd),
    feePct,
    buys1h: pick(dex?.buys1h, trend?.buys1h),
    sells1h: pick(dex?.sells1h, trend?.sells1h),
    buys5m: pick(dex?.buys5m, trend?.buys5m),
    sells5m: pick(dex?.sells5m, trend?.sells5m),
    priceChange5mPct: pick(dex?.priceChange5mPct, trend?.priceChange5mPct),
    priceChange1hPct: pick(dex?.priceChange1hPct, trend?.priceChange1hPct),
    priceChange24hPct: pick(dex?.priceChange24hPct, trend?.priceChange24hPct),
    ageHours,
  };
}

/**
 * The board's fee for a pool: the fee a trader pays now, which every venue's row carries in dynamicFeePct (Meteora's is
 * base + variable since src/screener/scan.ts meteoraBoardFees), and never under the base: a board written before that
 * fix holds the variable part alone, and a pool that moved at all read at a sliver of its fee (a 1% pool at 0.003%).
 */
export const boardFee = (p: Pick<ScreenedPool, "baseFeePct" | "dynamicFeePct">): number => Math.max(p.dynamicFeePct > 0 ? p.dynamicFeePct : 0, p.baseFeePct);

/** SOL in USD from a trending row: a SOL-quoted pair's quote price, or a SOL-based pair's own price. */
export function solPriceFromSamples(samples: PoolSample[]): number | null {
  for (const s of samples) {
    if (s.quoteMint === SOL_MINT && s.quotePriceUsd) return s.quotePriceUsd;
    if (s.baseMint === SOL_MINT && s.priceUsd) return s.priceUsd;
  }
  return null;
}

/** The board's top rows by rank, as a map. */
export function boardTop(screen: ScreenResult | null, n: number): Map<string, ScreenedPool> {
  const out = new Map<string, ScreenedPool>();
  for (const p of [...(screen?.pools ?? [])].sort((a, b) => a.rank - b.rank).slice(0, Math.max(0, n))) out.set(p.address, p);
  return out;
}

/* ---------- sibling pools: a token that trended somewhere we cannot trade ---------- */

export interface SiblingCacheEntry {
  samples: PoolSample[];
  at: number;
  /** false when the lookup FAILED: the entry is a negative cache and expires on its own, shorter clock */
  ok?: boolean;
}
const defaultSiblingCache = new Map<string, SiblingCacheEntry>();

/**
 * A FAILED sibling lookup is remembered this long, whatever HOT_SIBLING_TTL_MIN says. Without it a
 * mint whose lookup errors is re-queried every tick and eats the whole HOT_SIBLING_LOOKUPS budget,
 * starving every token behind it. Same idea as FEE_FAIL_CACHE_MS above.
 */
export const SIBLING_FAIL_TTL_MS = 5 * 60e3;

/** At most this many of one token's pools join the tick. A token can have twenty; six is already generous. */
export const SIBLINGS_PER_TOKEN = 6;

/** A pool we could actually put a band in: a venue the loop trades, quoted in SOL or USDC. */
export const isQuotableVenue = (venue: string, quoteMint: string | null, tradable: (v: string) => boolean): boolean =>
  tradable(venue) && (quoteMint === SOL_MINT || quoteMint === USDC_MINT);

export interface SiblingTarget {
  mint: string;
  /** the symbol as the untradable row spelled it, for the log line */
  symbol: string;
  /** the 24h volume of the pool that flagged this token: what makes it promising */
  vol24hUsd: number;
  /** the untradable pool that flagged it */
  from: string;
}

/**
 * PURE. Which tokens are worth a sibling lookup this tick, most promising first.
 *
 * A token qualifies when the rows we already have for it are ALL untradable (wrong venue or a quote
 * the book cannot seat) and the best of them cleared minVol24hUsd. A token that already has a pool
 * we could quote needs no lookup: trending found it. Tokens on the mints of the quotes themselves
 * (SOL, USDC) are skipped; so are tokens whose list is still cached.
 */
export function siblingTargets(
  samples: readonly PoolSample[],
  o: { minVol24hUsd: number; max: number; tradable: (venue: string) => boolean; cached?: (mint: string) => boolean },
): SiblingTarget[] {
  const best = new Map<string, SiblingTarget>();
  const quotable = new Set<string>();
  for (const s of samples) {
    const mint = s.baseMint;
    if (!mint || mint === SOL_MINT || mint === USDC_MINT) continue;
    if (isQuotableVenue(s.venue, s.quoteMint, o.tradable)) {
      quotable.add(mint);
      continue;
    }
    const vol = s.vol24hUsd ?? 0;
    const prev = best.get(mint);
    if (!prev || vol > prev.vol24hUsd) best.set(mint, { mint, symbol: s.baseSymbol ?? mint.slice(0, 6), vol24hUsd: vol, from: s.address });
  }
  return [...best.values()]
    .filter((t) => !quotable.has(t.mint) && t.vol24hUsd >= o.minVol24hUsd && !o.cached?.(t.mint))
    .sort((a, b) => b.vol24hUsd - a.vol24hUsd)
    .slice(0, Math.max(0, o.max));
}

/**
 * PURE. The siblings of one token that are worth carrying into the tick: pools on a venue the loop
 * trades, quoted in SOL or USDC, biggest 24h volume first, at most SIBLINGS_PER_TOKEN. The liquidity
 * floor is NOT applied here: heatOf owns that gate, and applying it twice would hide a pool whose
 * GeckoTerminal reserve is stale but whose DexScreener figure is not.
 */
export function usableSiblings(samples: readonly PoolSample[], mint: string, tradable: (venue: string) => boolean, max = SIBLINGS_PER_TOKEN): PoolSample[] {
  return samples
    .filter((s) => s.baseMint === mint && isQuotableVenue(s.venue, s.quoteMint, tradable))
    .sort((a, b) => (b.vol24hUsd ?? 0) - (a.vol24hUsd ?? 0))
    .slice(0, Math.max(0, max));
}

/* ---------- the tick ---------- */

export interface HotTickOptions {
  log?: (s: string) => void;
  now?: number;
  /** data directory (default config.dataDir) */
  dataDir?: string;
  env?: Partial<HotEnv>;
  /** the board; undefined loads data/screen.json, null means no board */
  screen?: ScreenResult | null;
  /** pools with positions; undefined reads the journal */
  held?: string[];
  /** trending durations to ask GeckoTerminal for */
  durations?: string[];
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** live Meteora fee reader (default: chain through config.rpcUrl) */
  readFee?: (address: string, solPriceUsd: number | null) => Promise<number | null>;
  feeCache?: Map<string, FeeCacheEntry>;
  /** which venues the loop can actually trade (default TRADABLE_VENUES); decides what counts as a quotable sibling */
  tradableVenue?: (venue: string) => boolean;
  /** mint -> the token's pools, cached for HOT_SIBLING_TTL_MIN; module-level by default so a tick does not refetch */
  siblingCache?: Map<string, SiblingCacheEntry>;
}

const fmtUsd = (n: number | null) => (n === null ? "n/a" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`);
const fmtPct = (n: number | null, d = 1) => (n === null ? "n/a" : `${n.toFixed(d)}%`);
const fmtSigned = (n: number | null, d = 1) => (n === null ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`);

/** One line of numbers for a row: the console's SURGE line and the script's table share the vocabulary. */
export function describeRow(r: HotRow): string {
  return [
    `liq ${fmtUsd(r.liquidityUsd)}`,
    `vol 1h ${fmtUsd(r.vol1hUsd)}`,
    `fee ${r.feePct === null ? "n/a" : fmtPct(r.feePct, 2)}`,
    `fee/TVL 1h ${fmtPct(r.feeToTvl1hPct, 2)}`,
    `daily ${fmtPct(r.feeToTvlDailyPct)}`,
    `accel ${r.acceleration === null ? "n/a" : `${r.acceleration.toFixed(1)}x`}`,
    `sells ${r.sellShare1h === null ? "n/a" : `${(r.sellShare1h * 100).toFixed(0)}%`}`,
    `1h ${fmtSigned(r.priceChange1hPct)}`,
    `heat ${r.heat}`,
    r.flags.length ? r.flags.join(",") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function runHotTick(opts: HotTickOptions = {}): Promise<HotFile> {
  const env: HotEnv = { ...hotEnv(), ...opts.env };
  const log = opts.log ?? console.log;
  const now = opts.now ?? Date.now();
  const dir = opts.dataDir ?? config.dataDir;
  const t0 = Date.now();
  const so: SourceOpts = { fetchImpl: opts.fetchImpl, sleep: opts.sleep, log };
  const readFee = opts.readFee ?? readMeteoraFee;
  const feeCache = opts.feeCache ?? defaultFeeCache;
  const siblingCache = opts.siblingCache ?? defaultSiblingCache;
  const tradable = opts.tradableVenue ?? ((v: string) => isTradableVenue(v));

  // The board, the held pools, the trending candidates.
  const screen = opts.screen === undefined ? loadScreen() : opts.screen;
  const board = boardTop(screen, env.boardTop);
  const held = opts.held ?? heldPools(readRecent(400));
  const none = { samples: [], calls: 0, errors: [] as string[] };
  const trending = env.geckoterminal ? await fetchTrending(opts.durations ?? ["5m", "1h"], so) : none;
  const trendByAddr = new Map<string, PoolSample>();
  for (const s of trending.samples) if (!trendByAddr.has(s.address)) trendByAddr.set(s.address, s);
  const errors = [...trending.errors];
  // The top PumpSwap pools by 24h volume: the pair lane's reference pools. They merge like trending
  // rows (same shape, same DexScreener refresh), and their tokens seed the sibling lookups below, which
  // is how the lane learns what concentrated pools already compete for the token's flow.
  const pump = env.geckoterminal && env.pumpswapPages > 0 ? await fetchPumpSwap(env.pumpswapPages, so) : { samples: [], calls: 0, errors: [] };
  for (const s of pump.samples) if (!trendByAddr.has(s.address)) trendByAddr.set(s.address, s);
  errors.push(...pump.errors);

  // Sibling pools. A token that trended (or sits high on the board) in a pool we cannot trade gets
  // its other pools looked up, so the desk sees the WET/SOL it could have quoted and not only the
  // WET/PTN it could not. Board rows join the search as untradable trending rows would.
  const siblingSeed: PoolSample[] = [...trending.samples, ...pump.samples];
  for (const p of board.values()) {
    siblingSeed.push({
      source: "trending",
      address: p.address,
      name: p.name,
      venue: p.venue,
      baseMint: p.baseMint,
      quoteMint: p.quoteMint,
      baseSymbol: p.baseSymbol,
      quoteSymbol: p.quoteSymbol,
      priceUsd: p.priceUsd,
      marketCapUsd: p.mcapUsd ?? p.fdvUsd ?? null,
      quotePriceUsd: null,
      priceNative: p.price > 0 ? p.price : null,
      liquidityUsd: p.tvlUsd,
      vol5mUsd: null,
      vol1hUsd: null,
      vol24hUsd: p.volume24hUsd,
      buys5m: null,
      sells5m: null,
      buys1h: null,
      sells1h: null,
      priceChange5mPct: null,
      priceChange1hPct: null,
      priceChange24hPct: p.priceChange24hPct,
      createdAt: null,
    });
  }
  const ttlMs = Math.max(0, env.siblingTtlMin) * 60e3;
  // STRICTLY older than the TTL. An entry stamped this tick is never stale, so HOT_SIBLING_TTL_MIN=0
  // means "do not reuse the list on the NEXT tick", not "throw away the list this tick just paid for".
  const stale = (e: SiblingCacheEntry) => now - e.at > (e.ok === false ? SIBLING_FAIL_TTL_MS : ttlMs);
  const cached = (mint: string) => {
    const hit = siblingCache.get(mint);
    return !!hit && !stale(hit);
  };
  const targets = siblingTargets(siblingSeed, { minVol24hUsd: env.siblingMinVol24hUsd, max: env.siblingLookups, tradable, cached });
  let siblingLookups = 0;
  if (targets.length && env.geckoterminal) {
    log(`[hot] sibling lookup: ${targets.map((t) => `${t.symbol} ${fmtUsd(t.vol24hUsd)}/24h in ${t.from.slice(0, 6)} (untradable)`).join(" · ")}`);
    const got = await fetchTokenPools(targets.map((t) => t.mint), so);
    siblingLookups = got.calls;
    errors.push(...got.errors);
    // Every mint we spent a call on is recorded, answered or not: a failure is cached NEGATIVELY so
    // one broken mint cannot monopolise the budget tick after tick.
    for (const t of targets) {
      const rows = got.byMint.get(t.mint);
      siblingCache.set(t.mint, rows ? { samples: rows, at: now, ok: true } : { samples: [], at: now, ok: false });
    }
  }
  // Everything cached and still fresh, tradable rows only, joins the tick as a trending row would.
  const siblingByAddr = new Map<string, PoolSample>();
  for (const [mint, hit] of [...siblingCache]) {
    if (stale(hit)) {
      siblingCache.delete(mint); // the cache is the only thing here that would grow forever
      continue;
    }
    for (const s of usableSiblings(hit.samples, mint, tradable)) {
      if (!trendByAddr.has(s.address) && !board.has(s.address)) siblingByAddr.set(s.address, s);
    }
  }
  for (const [addr, s] of siblingByAddr) trendByAddr.set(addr, s);

  // One DexScreener pass over everything we care about.
  const universe = [...new Set([...board.keys(), ...held, ...trendByAddr.keys()])];
  const dex = universe.length ? await fetchDexScreener(universe, so) : { samples: [], calls: 0, errors: [] };
  const dexByAddr = new Map(dex.samples.map((s) => [s.address, s] as const));
  errors.push(...dex.errors);

  const solPriceUsd = screen?.solPriceUsd ?? solPriceFromSamples([...trending.samples, ...pump.samples]);
  const screenAgeHours = screen ? Math.max(0, (now - Date.parse(screen.generatedAt)) / 3600e3) : 0;

  // Candidates: identity + inputs; fee from the board where we have it.
  interface Candidate {
    address: string;
    id: Identity;
    board: ScreenedPool | undefined;
    dex: PoolSample | undefined;
    trend: PoolSample | undefined;
    feePct: number | null;
    feeSource: HotRow["feeSource"];
    ageHours: number | null;
  }
  const candidates: Candidate[] = [];
  for (const address of universe) {
    const b = board.get(address);
    const id = identityOf(b, trendByAddr.get(address), dexByAddr.get(address));
    if (!id) continue;
    const d = dexByAddr.get(address) ? orient(dexByAddr.get(address)!, id.baseMint) : undefined;
    const t = trendByAddr.get(address) ? orient(trendByAddr.get(address)!, id.baseMint) : undefined;
    if (!d && !t) continue;
    const createdAt = d?.createdAt ?? t?.createdAt ?? null;
    const ageHours = createdAt !== null ? (now - createdAt) / 3600e3 : b?.ageHours !== null && b?.ageHours !== undefined ? b.ageHours + screenAgeHours : null;
    candidates.push({ address, id, board: b, dex: d, trend: t, feePct: b ? boardFee(b) : null, feeSource: b ? "board" : null, ageHours });
  }

  // Trending Meteora DLMM pools off the board: read the fee live, highest turnover first, capped and cached.
  // Only SOL- and USDC-quoted pools: getPoolSnapshot refuses any other quote, and the loop cannot trade them.
  const needFee = candidates
    .filter((c) => !c.board && c.id.venue === "meteora-dlmm" && (c.id.quoteSymbol === "SOL" || c.id.quoteSymbol === "USDC"))
    .map((c) => ({ c, turnover: (c.dex?.vol1hUsd ?? c.trend?.vol1hUsd ?? 0) / Math.max(c.dex?.liquidityUsd ?? c.trend?.liquidityUsd ?? 1, 1) }))
    .sort((a, b) => b.turnover - a.turnover)
    .map((x) => x.c);
  let onchainReads = 0;
  const toRead: Candidate[] = [];
  for (const c of needFee) {
    const hit = feeCache.get(c.address);
    if (hit && now - hit.at < (hit.feePct === null ? FEE_FAIL_CACHE_MS : FEE_CACHE_MS)) {
      c.feePct = hit.feePct;
      c.feeSource = hit.feePct === null ? null : "onchain";
    } else if (toRead.length < env.onchainReads) toRead.push(c);
  }
  // One at a time: a DLMM load is several RPC calls already, and the public endpoint rate-limits connections.
  await mapLimit(toRead, 1, async (c) => {
    onchainReads++;
    try {
      c.feePct = await readFee(c.address, solPriceUsd);
      c.feeSource = c.feePct === null ? null : "onchain";
    } catch (err) {
      c.feePct = null;
      c.feeSource = null;
      const msg = `onchain fee ${c.id.name} (${c.address.slice(0, 6)}): ${(err as Error).message.replace(/\s+/g, " ").trim().slice(0, 160)}`;
      errors.push(msg);
      log(`[hot] ${msg}`);
    }
    feeCache.set(c.address, { feePct: c.feePct, at: now });
  });

  // Metrics, heat, order.
  const prev = loadHotFile(dir);
  const prevByAddr = new Map((prev?.rows ?? []).map((r) => [r.address, r] as const));
  const history = readHistoryTail(dir, now - SURGE_WINDOW_MS);
  const firstSeenTape = new Map<string, number>();
  for (const h of history) firstSeenTape.set(h.address, Math.min(firstSeenTape.get(h.address) ?? Infinity, h.ts));
  const nowIso = new Date(now).toISOString();

  type Scored = { c: Candidate; m: ReturnType<typeof hotMetrics>; heat: number; flags: string[] };
  const scored: Scored[] = [];
  for (const c of candidates) {
    const m = hotMetrics(inputsOf(c.dex, c.trend, c.feePct, c.ageHours));
    const h = heatOf(m, env);
    if (h.excluded) continue;
    scored.push({ c, m, heat: h.heat, flags: h.flags });
  }
  scored.sort((a, b) => b.heat - a.heat || (b.m.feeToTvlDailyPct ?? 0) - (a.m.feeToTvlDailyPct ?? 0) || (b.m.turnover1h ?? 0) - (a.m.turnover1h ?? 0));
  const kept = scored.slice(0, env.maxRows);

  const surges = detectSurges(
    kept.map((s) => ({ address: s.c.address, feeToTvlDailyPct: s.m.feeToTvlDailyPct, acceleration: s.m.acceleration })),
    history,
    { surgeDailyPct: env.surgeDailyPct, now },
  );
  const surgeRule = new Map(surges.map((s) => [s.address, s.rule] as const));

  const rows: HotRow[] = kept.map(({ c, m, heat, flags }) => {
    const p = prevByAddr.get(c.address);
    const firedNow = surgeRule.has(c.address);
    const prevSurgeAt = p?.surgeAt ? Date.parse(p.surgeAt) : NaN;
    const surgeAt = firedNow ? nowIso : Number.isFinite(prevSurgeAt) && now - prevSurgeAt < SURGE_STICKY_MS ? p!.surgeAt : null;
    const firstTape = firstSeenTape.get(c.address);
    const pick = <T>(a: T | null | undefined, b: T | null | undefined): T | null => (a !== null && a !== undefined ? a : b ?? null);
    return {
      address: c.address,
      name: c.id.name,
      venue: c.id.venue,
      baseMint: c.id.baseMint,
      baseSymbol: c.id.baseSymbol,
      quoteMint: c.id.quoteMint,
      quoteSymbol: c.id.quoteSymbol,
      priceUsd: pick(c.dex?.priceUsd, pick(c.trend?.priceUsd, c.board?.priceUsd)),
      marketCapUsd: pick(c.dex?.marketCapUsd, pick(c.trend?.marketCapUsd, c.board ? (c.board.mcapUsd ?? c.board.fdvUsd ?? null) : null)),
      priceNative: pick(c.dex?.priceNative, pick(c.trend?.priceNative, c.board && c.board.price > 0 ? c.board.price : null)),
      origin: originOf(c.id.baseMint, c.id.venue),
      onBoard: !!c.board,
      screenRank: c.board?.rank ?? null,
      stock: c.board?.stock ?? null,
      vol1hUsd: m.vol1hUsd,
      vol5mUsd: m.vol5mUsd,
      vol24hUsd: m.vol24hUsd,
      liquidityUsd: m.liquidityUsd,
      feePct: m.feePct,
      feeSource: c.feeSource,
      fees1hUsd: m.fees1hUsd,
      feeToTvl1hPct: m.feeToTvl1hPct,
      feeToTvlDailyPct: m.feeToTvlDailyPct,
      turnover1h: m.turnover1h,
      acceleration: m.acceleration,
      buys1h: m.buys1h,
      sells1h: m.sells1h,
      buys5m: m.buys5m,
      sells5m: m.sells5m,
      sellShare1h: m.sellShare1h,
      sellShare5m: m.sellShare5m,
      priceChange5mPct: m.priceChange5mPct,
      priceChange1hPct: m.priceChange1hPct,
      priceChange24hPct: m.priceChange24hPct,
      ageHours: m.ageHours === null ? null : Math.round(m.ageHours * 10) / 10,
      heat,
      flags,
      surge: surgeAt !== null,
      surgeAt,
      firstSeenAt: p?.firstSeenAt ?? (firstTape !== undefined ? new Date(firstTape).toISOString() : nowIso),
      lastSeenAt: nowIso,
    };
  });

  const file: HotFile = {
    generatedAt: nowIso,
    tickMs: Date.now() - t0,
    sources: { trending: trending.samples.length, dexscreener: dex.samples.length, onchainReads, siblingLookups, siblingRows: rows.filter((r) => siblingByAddr.has(r.address)).length, pumpswap: pump.samples.length, errors },
    rows,
  };
  saveHotFile(dir, file);
  appendHistory(
    dir,
    rows.map((r): HotHistoryRow => {
      const h: HotHistoryRow = { ts: now, address: r.address, venue: r.venue, vol1hUsd: r.vol1hUsd, vol5mUsd: r.vol5mUsd, liquidityUsd: r.liquidityUsd, feeToTvl1hPct: r.feeToTvl1hPct, sellShare1h: r.sellShare1h, priceChange1hPct: r.priceChange1hPct, heat: r.heat };
      if (surgeRule.has(r.address)) h.surge = true;
      return h;
    }),
  );

  const top = rows[0];
  log(
    `[hot] ${rows.length} rows · trending ${trending.samples.length}${env.pumpswapPages > 0 ? ` · pumpswap ${pump.samples.length}` : ""} · dexscreener ${dex.samples.length}/${universe.length} · onchain ${onchainReads}` +
      `${siblingByAddr.size ? ` · siblings ${file.sources.siblingRows}/${siblingByAddr.size} from ${siblingLookups} lookup${siblingLookups === 1 ? "" : "s"}` : ""} · ${surges.length} surge${surges.length === 1 ? "" : "s"}` +
      `${errors.length ? ` · ${errors.length} source error${errors.length === 1 ? "" : "s"}` : ""} · ${(file.tickMs / 1000).toFixed(1)}s` +
      (top ? ` · top ${top.name} ${fmtPct(top.feeToTvlDailyPct)}/day` : ""),
  );
  for (const r of rows) if (surgeRule.has(r.address)) log(`[hot] SURGE ${r.name} · ${r.venue} · ${surgeRule.get(r.address)} · ${describeRow(r)}`);
  return file;
}

/* ---------- reading, serving, scheduling, picking ---------- */

export function loadHot(dir: string = config.dataDir): HotFile | null {
  return loadHotFile(dir);
}

/** GET /api/hot: the latest tick, or 404 with a plain reason. */
export function hotRoutes(app: Hono, { dir = config.dataDir }: { dir?: string } = {}): void {
  app.get("/api/hot", (c) => {
    const hot = loadHot(dir);
    return hot ? c.json(hot) : c.json({ error: "no hot watch yet; run `npm run hot`" }, 404);
  });
}

export interface HotWatch {
  /** when the last tick finished (success or failure), ms since epoch */
  readonly lastTickAt: number | null;
  readonly running: boolean;
  readonly ticks: number;
  readonly errors: number;
  stop(): void;
}

export interface HotWatchOptions {
  intervalSec?: number;
  log?: (s: string) => void;
  /** the tick to run (default runHotTick); injectable for tests */
  tick?: (opts: HotTickOptions) => Promise<unknown>;
  /** ms before the first tick (default 0) */
  delayMs?: number;
}

/**
 * Self-scheduling: the next tick is armed only after the current one settles, so ticks never
 * overlap even when a tick runs longer than the interval. Every error is caught and logged.
 */
export function startHotWatch(o: HotWatchOptions = {}): HotWatch {
  const intervalMs = Math.max(1, (o.intervalSec ?? hotEnv().intervalSec) * 1000);
  const log = o.log ?? console.log;
  const tick = o.tick ?? runHotTick;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let running = false;
  let lastTickAt: number | null = null;
  let ticks = 0;
  let errors = 0;
  const run = async () => {
    timer = null;
    if (stopped || running) return;
    running = true;
    try {
      await tick({ log });
    } catch (err) {
      errors++;
      log(`[hot] tick failed: ${(err as Error).message}`);
    } finally {
      ticks++;
      lastTickAt = Date.now();
      running = false;
      if (!stopped) timer = setTimeout(run, intervalMs);
    }
  };
  timer = setTimeout(run, Math.max(0, o.delayMs ?? 0));
  return {
    get lastTickAt() {
      return lastTickAt;
    },
    get running() {
      return running;
    },
    get ticks() {
      return ticks;
    },
    get errors() {
      return errors;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export interface HotPickOptions {
  /** the loop's venue rule, e.g. (r) => r.venue === "meteora-dlmm" */
  tradable: (row: HotRow) => boolean;
  /** how many to hand back (default 3) */
  max?: number;
  /** liquidity floor in USD (default HOT_MIN_LIQUIDITY_USD) */
  minLiquidityUsd?: number;
  /**
   * The launch lane (src/screener/launch.ts). When given, a row flagged `new` is kept if the lane
   * admits it: being new is the whole point of a launch, and the lane's own floors are harsher than
   * anything this filter applies. `true` reads the lane from the environment. Everything else still
   * applies: `dumping` and `wild` still drop a row, and so does the liquidity floor.
   */
  launch?: LaunchEnv | boolean | null;
}

/** flags that keep a row off the tradable list */
export const UNTRADABLE_FLAGS = ["new", "dumping", "wild"];

/** A hot row as the launch lane reads it. The row already carries every figure the lane needs. */
export const launchRowOf = (r: HotRow) => ({
  ageHours: r.ageHours,
  liquidityUsd: r.liquidityUsd,
  vol24hUsd: r.vol24hUsd,
  vol1hUsd: r.vol1hUsd,
  turnover24h: r.vol24hUsd !== null && r.liquidityUsd !== null && r.liquidityUsd > 0 ? r.vol24hUsd / r.liquidityUsd : null,
  quoteSymbol: r.quoteSymbol,
  sellShare1h: r.sellShare1h,
  priceChange1hPct: r.priceChange1hPct,
  flags: r.flags,
});

/** Rows the loop may work: tradable venue, SOL or USDC quote, not new/dumping/wild, above the liquidity floor, best heat first. */
export function hotPicks(hot: HotFile | null, o: HotPickOptions): HotRow[] {
  if (!hot) return [];
  const floor = o.minLiquidityUsd ?? hotEnv().minLiquidityUsd;
  const lane = o.launch === true ? launchEnv() : o.launch === false || !o.launch ? null : o.launch;
  const admitted = (r: HotRow) => !!lane && lane.on && launchVerdict(launchRowOf(r), lane).ok;
  const blocked = (r: HotRow) => {
    const flags = admitted(r) ? r.flags.filter((f) => f !== "new") : r.flags;
    return flags.some((f) => UNTRADABLE_FLAGS.includes(f));
  };
  return hot.rows
    .filter((r) => o.tradable(r) && (r.quoteSymbol === "SOL" || r.quoteSymbol === "USDC") && !blocked(r) && (r.liquidityUsd ?? 0) >= floor && r.heat > 0)
    .sort((a, b) => b.heat - a.heat)
    .slice(0, Math.max(0, o.max ?? 3));
}
