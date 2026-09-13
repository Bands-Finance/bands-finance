/**
 * The screener: scan every DLMM pool on chain, pull Raydium CLMM and Orca Whirlpools from their
 * public APIs, shortlist by volume and liquidity, enrich, measure Meteora fees from chain where
 * history allows, score, rank one board across venues, persist to data/screen.json.
 */
import fs from "node:fs";
import path from "node:path";
import { Connection } from "@solana/web3.js";
import { config } from "../config";
import { Enrichment, enrichPools } from "./enrich";
import { loadHistory, recordSamples, windowStats } from "./history";
import { scanOnchain } from "./scan";
import { scorePool } from "./score";
import { stockOf, verifiedStock } from "./stocks";
import { scanVenues, SOL_MINT, venueEnv, VENUE_LABEL, VenueScan } from "./venues";
import type { ScreenedPool, ScreenResult, Venue, VenueCount, VenuePool } from "./types";

export { ALL_VENUES, API_VENUES, VENUE_LABEL, venueEnv } from "./venues";
export { ISSUER_LABEL, parseStockMints, stockOf, verifiedStock } from "./stocks";
export type { FeesSource, ScreenedPool, ScreenResult, StockIssuer, StockTag, Venue, VenueCount, VenuePool } from "./types";

const short = (m: string) => `${m.slice(0, 4)}…${m.slice(-4)}`;
export const SCREEN_FILE = () => path.resolve(process.cwd(), config.dataDir, "screen.json");

type Partial = Omit<ScreenedPool, "score" | "flags" | "rank">;

/** Only Meteora DLMM is executable for now: the executor speaks DLMM. The rest of the board is for eyes. */
export function tradableVenue(p: Pick<ScreenedPool, "venue">): boolean {
  return p.venue === "meteora-dlmm";
}

/* ---------- loading, with the old single-venue shape still accepted ---------- */

type LegacyPool = Omit<ScreenedPool, "venue" | "stepBps" | "stock"> & { venue?: Venue; stepBps?: number; stock?: ScreenedPool["stock"] };
export type LegacyScreen = Omit<ScreenResult, "pools" | "venues" | "stocks"> & { pools: LegacyPool[]; venues?: VenueCount[]; stocks?: number };

/** A screen.json written before venues existed is a Meteora-only board: fill the new fields so every reader sees one shape. */
export function normalizeScreen(raw: LegacyScreen): ScreenResult {
  const pools: ScreenedPool[] = raw.pools.map((p) => ({
    ...p,
    venue: p.venue ?? "meteora-dlmm",
    stepBps: p.stepBps ?? p.binStep,
    stock: p.stock === undefined ? stockOf(p.baseMint, p.baseSymbol) : p.stock,
  }));
  const venues: VenueCount[] = raw.venues ?? [{ venue: "meteora-dlmm", scanned: raw.scannedPools, live: raw.livePools, ranked: pools.length }];
  const stocks = raw.stocks ?? pools.filter((p) => verifiedStock(p.stock)).length;
  return { ...raw, pools, venues, stocks };
}

export function loadScreen(): ScreenResult | null {
  try {
    return normalizeScreen(JSON.parse(fs.readFileSync(SCREEN_FILE(), "utf8")) as LegacyScreen);
  } catch {
    return null;
  }
}

/* ---------- pure pieces of the pipeline (tested without a network) ---------- */

/** One shortlist across venues: 24h volume first, then liquidity; pools with no volume figure sort last. */
export function shortlistUnion<T extends { volume24hUsd: number | null; tvlUsd: number | null }>(rows: T[], cap: number): T[] {
  return [...rows].sort((a, b) => (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1) || (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1)).slice(0, Math.max(0, cap));
}

/** The deepest SOL/USDC pool on any API venue prices SOL when GeckoTerminal is unavailable. */
export function venueSolPrice(pools: VenuePool[]): number | null {
  let best: VenuePool | null = null;
  for (const p of pools) {
    if (p.quoteSymbol !== "USDC" || p.baseMint !== SOL_MINT) continue;
    if (!best || (p.tvlUsd ?? 0) > (best.tvlUsd ?? 0)) best = p;
  }
  return best && best.price > 0 ? best.price : null;
}

/** A venue API row as a board row. The API's TVL, volume and fees are the figures; the rest waits for GeckoTerminal. */
export function partialFromVenue(v: VenuePool, quoteUsd: number | null): Partial {
  const { adaptiveFee: _adaptive, baseName, ...rest } = v;
  void _adaptive;
  const tvlUsd = v.tvlUsd ?? (quoteUsd !== null ? v.tvlQuote * quoteUsd : null);
  const estimate = v.volume24hUsd !== null ? v.volume24hUsd * (v.baseFeePct / 100) : null;
  const fees24hUsd = v.fees24hUsd ?? estimate;
  return {
    ...rest,
    stock: stockOf(v.baseMint, v.baseSymbol, baseName),
    tvlUsd,
    volume24hUsd: v.volume24hUsd,
    fees24hUsd,
    feesSource: fees24hUsd === null ? null : v.fees24hUsd !== null ? "api" : "estimate",
    feesWindowHours: null,
    feeToTvl24hPct: fees24hUsd !== null && tvlUsd ? (fees24hUsd / tvlUsd) * 100 : null,
    turnover24h: v.volume24hUsd !== null && tvlUsd ? v.volume24hUsd / tvlUsd : null,
    priceChange24hPct: v.priceChange24hPct,
    binRangePct: null,
    txns24h: null,
    mcapUsd: null,
    fdvUsd: null,
    ageHours: v.ageHours,
    priceUsd: quoteUsd !== null ? v.price * quoteUsd : null,
  };
}

/** Fill what the venue left null from GeckoTerminal. An API or on-chain figure is never overwritten. */
export function fillFromGecko(p: Partial, e: Enrichment | undefined, now = Date.now()): Partial {
  if (!e) return p;
  // GeckoTerminal sometimes orients the pair the other way round; then its USD prices are swapped and
  // its token-level figures (mcap, fdv, 24h move) describe our quote, which the board must not show as the base.
  const flipped = e.quoteMint !== null && e.quoteMint === p.baseMint;
  if (p.priceUsd === null) p.priceUsd = flipped ? e.quotePriceUsd : e.priceUsd;
  if (p.txns24h === null) p.txns24h = e.txns24h;
  if (p.ageHours === null && e.createdAt) p.ageHours = (now - e.createdAt) / 3600e3;
  if (!flipped) {
    if (p.priceChange24hPct === null) p.priceChange24hPct = e.priceChange24hPct;
    if (p.mcapUsd === null) p.mcapUsd = e.mcapUsd ?? e.fdvUsd;
    if (p.fdvUsd === null) p.fdvUsd = e.fdvUsd;
  }
  if (p.volume24hUsd === null && e.volume24hUsd !== null) {
    p.volume24hUsd = e.volume24hUsd;
    if (p.tvlUsd) p.turnover24h = e.volume24hUsd / p.tvlUsd;
  }
  return p;
}

/** Per-venue counts for the result: what the venue returned, what passed the filters, what made the board. */
export function venueCounts(meteora: { scanned: number; live: number }, scans: VenueScan[], board: ScreenedPool[]): VenueCount[] {
  const ranked = (v: Venue) => board.filter((p) => p.venue === v).length;
  return [
    { venue: "meteora-dlmm", scanned: meteora.scanned, live: meteora.live, ranked: ranked("meteora-dlmm") },
    ...scans.map((s) => ({ venue: s.venue, scanned: s.scanned, live: s.live, ranked: ranked(s.venue) })),
  ];
}

/* ---------- the run ---------- */

export async function runScreen(connection: Connection, log: (s: string) => void = console.log): Promise<ScreenResult> {
  const o = config.screen;
  const venv = venueEnv();
  const t0 = Date.now();

  // Meteora from chain and the API venues side by side. A venue API failing is logged and the board
  // goes on without it; the chain scan failing throws, as before, so the caller falls back to the saved screen.
  const [scan, venueScans] = await Promise.all([
    scanOnchain(connection, { activeHours: o.activeHours, maxLive: o.maxLive, minTvlSol: o.minTvlSol, log }),
    scanVenues({ venues: venv.venues, minTvlSol: o.minTvlSol, raydiumMaxPages: venv.raydiumMaxPages, orcaMaxPages: venv.orcaMaxPages, log }),
  ]);
  log(`[screen] scanned ${scan.scanned} DLMM pools, ${scan.live} traded in ${o.activeHours}h, ${scan.pools.length} above the liquidity floor (${scan.scanMs}ms)`);

  // Meteora's shortlist and enrichment stay exactly as they were: top by on-chain liquidity, sampled for fee history, priced by GeckoTerminal.
  const shortlist = scan.pools.slice(0, o.maxPools);
  const history = loadHistory();
  recordSamples(history, shortlist);
  const enriched = await enrichPools(shortlist.map((p) => p.address), { log });
  log(`[screen] enriched ${enriched.size}/${shortlist.length} Meteora pools`);

  const venuePools = venueScans.flatMap((v) => v.pools);
  const geckoSol = [...enriched.values()].find((e) => e.quoteSymbol === "SOL" && e.quotePriceUsd)?.quotePriceUsd ?? null;
  const solPriceUsd = geckoSol ?? venueSolPrice(venuePools);
  if (geckoSol === null && solPriceUsd !== null) log(`[screen] SOL priced from a venue SOL/USDC pool: $${solPriceUsd.toFixed(2)}`);
  const quoteUsd = (q: "SOL" | "USDC") => (q === "USDC" ? 1 : solPriceUsd);
  const now = Date.now();

  const meteoraRows: Partial[] = shortlist.map((p) => {
    const e = enriched.get(p.address);
    const qUsd = quoteUsd(p.quoteSymbol);
    const tvlUsd = qUsd !== null ? p.tvlQuote * qUsd : e?.reserveUsd ?? null;
    const win = windowStats(history, p);
    const useOnchain = win !== null && win.hours >= 6;
    const feesEstimate = e?.volume24hUsd !== null && e?.volume24hUsd !== undefined ? e.volume24hUsd * (p.baseFeePct / 100) : null;
    const fees24hUsd = useOnchain && qUsd !== null ? (win.feesQuote * qUsd * 24) / win.hours : feesEstimate;
    const baseSymbol = e?.baseSymbol ?? short(p.baseMint);
    return {
      ...p,
      venue: "meteora-dlmm",
      stepBps: p.binStep,
      stock: stockOf(p.baseMint, baseSymbol),
      name: e?.name ?? `${short(p.baseMint)} / ${p.quoteSymbol}`,
      baseSymbol,
      tvlUsd,
      volume24hUsd: e?.volume24hUsd ?? null,
      fees24hUsd,
      feesSource: fees24hUsd === null ? null : useOnchain ? "onchain" : "estimate",
      feesWindowHours: useOnchain ? Math.round(win.hours * 10) / 10 : null,
      feeToTvl24hPct: fees24hUsd !== null && tvlUsd ? (fees24hUsd / tvlUsd) * 100 : null,
      turnover24h: e?.volume24hUsd !== null && e?.volume24hUsd !== undefined && tvlUsd ? e.volume24hUsd / tvlUsd : null,
      priceChange24hPct: e?.priceChange24hPct ?? null,
      binRangePct: win ? Math.round(win.binRangePct * 100) / 100 : null,
      txns24h: e?.txns24h ?? null,
      mcapUsd: e?.mcapUsd ?? e?.fdvUsd ?? null,
      fdvUsd: e?.fdvUsd ?? null,
      ageHours: e?.createdAt ? (now - e.createdAt) / 3600e3 : null,
      priceUsd: e?.priceUsd ?? null,
    };
  });
  const venueRows: Partial[] = venuePools.map((v) => partialFromVenue(v, quoteUsd(v.quoteSymbol)));

  // One shortlist across venues, then GeckoTerminal fills what the venue APIs do not report (24h move, mcap, fdv, age, USD price).
  const cut = shortlistUnion([...meteoraRows, ...venueRows], o.maxPools);
  const toFill = cut.filter((p) => p.venue !== "meteora-dlmm");
  if (toFill.length) {
    const fill = await enrichPools(toFill.map((p) => p.address), { log });
    for (const p of toFill) fillFromGecko(p, fill.get(p.address), now);
    log(`[screen] geckoterminal filled ${fill.size}/${toFill.length} ${toFill.map((p) => VENUE_LABEL[p.venue]).filter((v, i, a) => a.indexOf(v) === i).join(" + ")} pools`);
  }

  const adaptive = new Set(venuePools.filter((v) => v.adaptiveFee).map((v) => v.address));
  const pools: ScreenedPool[] = cut.map((p) => ({ ...p, ...scorePool(p, { adaptiveFee: adaptive.has(p.address) }), rank: 0 }));
  pools.sort((a, b) => b.score - a.score || (b.feeToTvl24hPct ?? 0) - (a.feeToTvl24hPct ?? 0));
  pools.forEach((p, i) => (p.rank = i + 1));

  const venues = venueCounts(scan, venueScans, pools);
  const stocks = pools.filter((p) => verifiedStock(p.stock)).length;
  log(`[screen] board: ${pools.length} pools (${venues.map((v) => `${VENUE_LABEL[v.venue]} ${v.ranked}`).join(", ")}), ${stocks} tokenized stocks, ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const result: ScreenResult = {
    generatedAt: new Date().toISOString(),
    scanMs: scan.scanMs,
    scannedPools: scan.scanned,
    livePools: scan.live,
    rankedPools: pools.length,
    solPriceUsd,
    pools,
    venues,
    stocks,
  };
  fs.mkdirSync(path.dirname(SCREEN_FILE()), { recursive: true });
  fs.writeFileSync(SCREEN_FILE(), JSON.stringify(result));
  return result;
}
