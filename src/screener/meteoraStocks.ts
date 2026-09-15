/**
 * METEORA'S TOKENIZED STOCKS: the pools behind the "RWA" tab at meteora.ag, read from Meteora's own pool
 * discovery API (the same one the app uses: GET https://pool-discovery-api.datapi.meteora.ag/pools?category=rwa).
 * Zach (2026-09-15): "lets stick with stocks", and pointed at meteora.ag's tokenized stocks.
 *
 * Two jobs:
 *
 * 1. TAGGING. Meteora labels every token: "stocks", and the issuer ("xstocks", "backpack", "ondo", or
 *    "prestocks" / "tessera" / "pre-ipo" for pre-IPO synthetics). Our own detector knew xStocks by mint
 *    prefix and Backpack Securities only by a token name the on-chain scan never reads, so SKHY, MU,
 *    BROS, SPCX and NKE sat on the board untagged and were judged as memecoins. The tags are written to
 *    DATA_DIR/stock-mints.json, which src/screener/stocks.ts reads, so the screener, the fast watch and
 *    the basis feed all see them. Pre-IPO synthetics are tagged issuer "unknown": not counted as stocks
 *    (verifiedStock is false) and kept out of the memecoin lanes too.
 *
 * 2. THE LANE. The busiest real Meteora DLMM stock pools, quoted in SOL or USDC, from the issuers
 *    METEORA_STOCK_ISSUERS allows, with enough depth and volume, best fee/TVL first, one pool per ticker.
 *    The desk supplements their liquidity with a straddle, hedged on Backpack where a perp exists.
 *
 * On 2026-09-15 the category held 1,198 pools: 752 DLMM pools on stock tokens, 53 with more than $10k of
 * depth, 17 trading more than $100k a day. SKHY-USDC traded $2.9M on $2.4M; MU-USDC $2.2M on $3.9M.
 *
 * Pure except fetchMeteoraStockPools (takes its fetch) and the stock-mints file helpers.
 */
import fs from "node:fs";
import path from "node:path";
import type { StockIssuer, StockTag } from "./types";

export const METEORA_POOL_DISCOVERY = "https://pool-discovery-api.datapi.meteora.ag";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const STOCK_MINTS_FILE = "stock-mints.json";

export interface MeteoraStockEnv {
  on: boolean;
  issuers: StockIssuer[];
  minTvlUsd: number;
  maxPools: number;
  refreshMin: number;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function meteoraStockEnv(env: NodeJS.ProcessEnv = process.env): MeteoraStockEnv {
  const raw = (env.METEORA_STOCK_ISSUERS ?? "").trim();
  const issuers = (raw === "" ? ["xstocks", "backpack", "ondo"] : raw.split(",").map((s) => s.trim().toLowerCase())).filter(
    (s): s is StockIssuer => s === "xstocks" || s === "backpack" || s === "ondo",
  );
  return {
    on: (env.METEORA_STOCKS ?? "").trim().toLowerCase() !== "false",
    issuers,
    minTvlUsd: Math.max(0, num(env.METEORA_STOCK_MIN_TVL_USD, 20_000)),
    maxPools: Math.max(0, Math.floor(num(env.METEORA_STOCK_MAX_POOLS, 3))),
    refreshMin: Math.max(1, num(env.METEORA_STOCK_REFRESH_MIN, 15)),
  };
}

export interface MeteoraStockPool {
  address: string;
  poolType: "dlmm" | "damm_v2" | string;
  mint: string;
  symbol: string;
  name: string;
  ticker: string;
  /** "unknown" for pre-IPO synthetics and stock-tagged tokens without a known issuer */
  issuer: StockIssuer;
  tags: string[];
  quoteMint: string;
  quoteSymbol: "SOL" | "USDC" | string;
  binStep: number | null;
  feePct: number | null;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  fees24hUsd: number | null;
  /** fees a day over TVL, percent (Meteora's fee_tvl_ratio) */
  feeToTvl24hPct: number | null;
  priceUsd: number | null;
  createdAt: number | null;
}

const n = (x: unknown): number | null => {
  const v = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
  return Number.isFinite(v) ? v : null;
};

const PRE_IPO_TAGS = ["prestocks", "pre-ipo", "tessera"];

/** PURE. The issuer Meteora's tags name, "unknown" for pre-IPO synthetics, null when the token is not a stock at all. */
export function issuerOfTags(tags: readonly string[]): StockIssuer | null {
  const t = tags.map((s) => s.toLowerCase());
  if (!t.includes("stocks") && !t.includes("equities") && !t.some((x) => PRE_IPO_TAGS.includes(x))) return null;
  if (t.some((x) => PRE_IPO_TAGS.includes(x))) return "unknown";
  if (t.includes("xstocks")) return "xstocks";
  if (t.includes("backpack")) return "backpack";
  if (t.includes("ondo")) return "ondo";
  return "unknown";
}

/** PURE. The ticker: NVDAx -> NVDA (xStocks), MRNAon -> MRNA (Ondo), SKHY stays SKHY (Backpack). */
export function tickerOf(symbol: string, issuer: StockIssuer): string {
  const s = (symbol ?? "").trim();
  if (issuer === "xstocks" && /^[A-Za-z.]{1,6}x$/.test(s)) return s.slice(0, -1).toUpperCase();
  if (issuer === "ondo" && /^[A-Za-z.]{1,6}on$/.test(s)) return s.slice(0, -2).toUpperCase();
  return s.toUpperCase();
}

/** PURE. Meteora's /pools answer as stock pools; rows whose base token is not a stock are dropped. */
export function parseMeteoraPools(json: unknown): MeteoraStockPool[] {
  const rows = (json as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return [];
  const out: MeteoraStockPool[] = [];
  for (const r of rows as Record<string, any>[]) {
    if (!r || r.is_blacklisted === true) continue;
    const x = r.token_x ?? {};
    const y = r.token_y ?? {};
    const tags: string[] = Array.isArray(x.tags) ? x.tags.map(String) : [];
    const issuer = issuerOfTags(tags);
    if (!issuer || !x.address || !r.pool_address) continue;
    const quoteMint = String(y.address ?? "");
    out.push({
      address: String(r.pool_address),
      poolType: String(r.pool_type ?? ""),
      mint: String(x.address),
      symbol: String(x.symbol ?? ""),
      name: String(x.name ?? ""),
      ticker: tickerOf(String(x.symbol ?? ""), issuer),
      issuer,
      tags,
      quoteMint,
      quoteSymbol: quoteMint === SOL_MINT ? "SOL" : quoteMint === USDC_MINT ? "USDC" : String(y.symbol ?? ""),
      binStep: n(r.dlmm_params?.bin_step),
      feePct: n(r.fee_pct),
      tvlUsd: n(r.tvl),
      volume24hUsd: n(r.volume),
      fees24hUsd: n(r.fee),
      feeToTvl24hPct: n(r.fee_tvl_ratio),
      priceUsd: n(x.price),
      createdAt: n(r.pool_created_at),
    });
  }
  return out;
}

/** PURE. Every stock mint Meteora tags, with its ticker and issuer: what src/screener/stocks.ts reads. */
export function stockMintMap(pools: readonly MeteoraStockPool[]): Record<string, { ticker: string; issuer: StockIssuer; symbol: string }> {
  const out: Record<string, { ticker: string; issuer: StockIssuer; symbol: string }> = {};
  for (const p of pools) if (!out[p.mint]) out[p.mint] = { ticker: p.ticker, issuer: p.issuer, symbol: p.symbol };
  return out;
}

/**
 * PURE. The pools the lane may seat: DLMM, SOL or USDC quoted, an allowed issuer, at least the depth and
 * the volume floors, one per ticker (the best by fee/TVL), best first.
 */
export function meteoraStockCandidates(pools: readonly MeteoraStockPool[], env: MeteoraStockEnv, o: { minVolume24hUsd: number; quoteOk: (q: string) => boolean }): MeteoraStockPool[] {
  if (!env.on) return [];
  const eligible = pools.filter(
    (p) =>
      p.poolType === "dlmm" &&
      env.issuers.includes(p.issuer) &&
      (p.quoteSymbol === "SOL" || p.quoteSymbol === "USDC") &&
      o.quoteOk(p.quoteSymbol) &&
      (p.tvlUsd ?? 0) >= env.minTvlUsd &&
      (p.volume24hUsd ?? 0) >= o.minVolume24hUsd,
  );
  const best = new Map<string, MeteoraStockPool>();
  for (const p of [...eligible].sort((a, b) => (b.feeToTvl24hPct ?? -1) - (a.feeToTvl24hPct ?? -1) || (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0))) {
    if (!best.has(p.ticker)) best.set(p.ticker, p);
  }
  return [...best.values()];
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Read the RWA category, busiest first, until a page falls under `stopBelowVolumeUsd` or `maxPages` is read. */
export async function fetchMeteoraStockPools(o: { fetch?: FetchLike; pageSize?: number; maxPages?: number; stopBelowVolumeUsd?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<MeteoraStockPool[]> {
  const fetchImpl: FetchLike = o.fetch ?? ((input, init) => fetch(input, init));
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pageSize = o.pageSize ?? 100;
  const out: MeteoraStockPool[] = [];
  let after: string | null = null;
  for (let page = 1; page <= (o.maxPages ?? 12); page++) {
    const q = new URLSearchParams({ category: "rwa", page_size: String(pageSize), sort_by: "volume_24h:desc" });
    if (after) q.set("after_key", after);
    else q.set("page", String(page));
    const res = await fetchImpl(`${METEORA_POOL_DISCOVERY}/pools?${q.toString()}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Meteora pool discovery HTTP ${res.status}`);
    const json = (await res.json()) as { data?: unknown[]; has_more?: boolean; after_key?: string | null };
    const rows = parseMeteoraPools(json);
    out.push(...rows);
    const vols = (json.data ?? []).map((r) => n((r as { volume?: unknown }).volume) ?? 0);
    const lowest = vols.length ? Math.min(...vols) : 0;
    if (!json.has_more || !vols.length) break;
    if (o.stopBelowVolumeUsd !== undefined && lowest < o.stopBelowVolumeUsd) break;
    after = json.after_key ?? null;
    if (!after) break;
    await sleep(400);
  }
  return out;
}

/** Written whole, temp + rename, so the screener never reads a torn file. */
export function saveStockMints(dataDir: string, map: Record<string, { ticker: string; issuer: StockIssuer; symbol: string }>, now = Date.now()): void {
  const file = path.join(dataDir, STOCK_MINTS_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ generatedAt: new Date(now).toISOString(), source: "meteora pool discovery, category rwa", mints: map }));
  fs.renameSync(tmp, file);
}

/** The tag a mint carries in the file, or null. */
export const stockTagFromMap = (map: Record<string, { ticker: string; issuer: StockIssuer }> | null, mint: string): StockTag | null => {
  const m = map?.[mint];
  return m ? { ticker: m.ticker, issuer: m.issuer } : null;
};
