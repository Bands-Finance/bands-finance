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
 * Sources: GeckoTerminal trending (5m + 1h) finds what moves; DexScreener refreshes the board's top
 * rows, every held pool and the trending candidates in one pass. Fee rates come from our own board
 * row when the pool is on it; a trending Meteora DLMM pool off the board is read live once (capped
 * per tick, cached an hour); anything else off the board has no fee and is shown by turnover.
 * Nothing here edits src/config.ts: knobs are HOT_* in the environment (src/hot/env.ts).
 */
import { Connection } from "@solana/web3.js";
import type { Hono } from "hono";
import { config } from "../config";
import { readRecent } from "../journal";
import { loadScreen } from "../screener";
import type { ScreenedPool, ScreenResult } from "../screener/types";
import { getPoolSnapshot, loadPool } from "../tools/dlmm";
import { hotEnv, type HotEnv } from "./env";
import { heatOf, hotMetrics, type HotInputs } from "./score";
import { fetchDexScreener, fetchTrending, SOL_MINT, type SourceOpts } from "./sources";
import { appendHistory, heldPools, loadHotFile, readHistoryTail, saveHotFile } from "./store";
import { detectSurges, SURGE_STICKY_MS, SURGE_WINDOW_MS } from "./surge";
import type { HotFile, HotHistoryRow, HotRow, PoolSample } from "./types";

export { hotEnv, type HotEnv } from "./env";
export { FADING_MIN_VOL1H, FADING_SHARE, heatOf, hotMetrics, NOMINAL_FEE_PCT, type Heat, type HeatOpts, type HotInputs, type HotMetrics } from "./score";
export { DEXSCREENER_URL, fetchDexScreener, fetchTrending, parseDexScreener, parseTrending, quoteSymbolOf, splitName, TRENDING_URL, venueOfDex, type SourceOpts, type SourceResult } from "./sources";
export { appendHistory, heldPools, HISTORY_FILE, HOT_FILE, loadHotFile, parseHistory, readHistoryTail, saveHotFile } from "./store";
export { detectSurges, latestByAddress, SURGE_MIN_ACCELERATION, SURGE_STICKY_MS, SURGE_TOP_N, SURGE_WINDOW_MS, topTenSeen, type SurgeCandidate, type SurgeVerdict } from "./surge";
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
  connection ??= new Connection(config.rpcUrl, "confirmed");
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

/** Price changes oriented to our base token; volume, liquidity and counts are symmetric. */
export function orient(s: PoolSample, baseMint: string): PoolSample {
  const flipped = s.quoteMint !== null && s.quoteMint === baseMint && s.baseMint !== baseMint;
  if (!flipped) return s;
  return { ...s, priceChange5mPct: flipPct(s.priceChange5mPct), priceChange1hPct: flipPct(s.priceChange1hPct), priceChange24hPct: flipPct(s.priceChange24hPct) };
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

/** The board's fee for a pool: the dynamic fee when the venue reported one, else the base. */
export const boardFee = (p: Pick<ScreenedPool, "baseFeePct" | "dynamicFeePct">): number => (p.dynamicFeePct > 0 ? p.dynamicFeePct : p.baseFeePct);

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

  // The board, the held pools, the trending candidates.
  const screen = opts.screen === undefined ? loadScreen() : opts.screen;
  const board = boardTop(screen, env.boardTop);
  const held = opts.held ?? heldPools(readRecent(400));
  const trending = await fetchTrending(opts.durations ?? ["5m", "1h"], so);
  const trendByAddr = new Map<string, PoolSample>();
  for (const s of trending.samples) if (!trendByAddr.has(s.address)) trendByAddr.set(s.address, s);

  // One DexScreener pass over everything we care about.
  const universe = [...new Set([...board.keys(), ...held, ...trendByAddr.keys()])];
  const dex = universe.length ? await fetchDexScreener(universe, so) : { samples: [], calls: 0, errors: [] };
  const dexByAddr = new Map(dex.samples.map((s) => [s.address, s] as const));
  const errors = [...trending.errors, ...dex.errors];

  const solPriceUsd = screen?.solPriceUsd ?? solPriceFromSamples(trending.samples);
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
    return {
      address: c.address,
      name: c.id.name,
      venue: c.id.venue,
      baseMint: c.id.baseMint,
      baseSymbol: c.id.baseSymbol,
      quoteMint: c.id.quoteMint,
      quoteSymbol: c.id.quoteSymbol,
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
    sources: { trending: trending.samples.length, dexscreener: dex.samples.length, onchainReads, errors },
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
    `[hot] ${rows.length} rows · trending ${trending.samples.length} · dexscreener ${dex.samples.length}/${universe.length} · onchain ${onchainReads} · ${surges.length} surge${surges.length === 1 ? "" : "s"}` +
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
}

/** flags that keep a row off the tradable list */
export const UNTRADABLE_FLAGS = ["new", "dumping", "wild"];

/** Rows the loop may work: tradable venue, SOL or USDC quote, not new/dumping/wild, above the liquidity floor, best heat first. */
export function hotPicks(hot: HotFile | null, o: HotPickOptions): HotRow[] {
  if (!hot) return [];
  const floor = o.minLiquidityUsd ?? hotEnv().minLiquidityUsd;
  return hot.rows
    .filter(
      (r) =>
        o.tradable(r) &&
        (r.quoteSymbol === "SOL" || r.quoteSymbol === "USDC") &&
        !r.flags.some((f) => UNTRADABLE_FLAGS.includes(f)) &&
        (r.liquidityUsd ?? 0) >= floor &&
        r.heat > 0,
    )
    .sort((a, b) => b.heat - a.heat)
    .slice(0, Math.max(0, o.max ?? 3));
}
