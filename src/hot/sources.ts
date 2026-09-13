/**
 * Short-window sources for the hot watch.
 *   GeckoTerminal trending  GET /networks/solana/trending_pools?page=1&duration=5m|1h  what is moving now, no address list needed
 *   DexScreener batch       GET /latest/dex/pairs/solana/<a>,<b>,...  (30 per call)   fresh 5m/1h numbers for pools we name
 * Parsers are pure and take the raw JSON. Fetchers take an injectable fetch and sleep so tests run
 * with no network. GeckoTerminal allows ~30 calls/min: a 429 waits 20 s and retries, like the
 * screener's enrich.ts (whose pacing state is deliberately not shared).
 */
import { config } from "../config";
import type { PoolSample } from "./types";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = config.usdcMint;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ---------- dex ids ---------- */

/**
 * Map a source's dex id to our venue names. GeckoTerminal says meteora / raydium-clmm / orca; DexScreener
 * says meteora / raydium / orca and tells the program apart through labels (DLMM, CLMM, CPMM, wp).
 * Anything else stays verbatim (pumpswap, meteora-damm-v2, ...) so the row still says where it lives.
 */
export function venueOfDex(dexId: string, labels: string[] = []): string {
  const id = dexId.trim().toLowerCase();
  const tags = labels.map((l) => l.toUpperCase());
  switch (id) {
    case "meteora":
      return tags.some((t) => t.startsWith("DAMM")) ? "meteora-damm-v2" : "meteora-dlmm";
    case "raydium":
      return tags.includes("CLMM") ? "raydium-clmm" : tags.includes("CPMM") ? "raydium-cpmm" : "raydium";
    case "raydium-clmm":
      return "raydium-clmm";
    case "orca":
      return "orca-whirlpool";
    default:
      return id;
  }
}

/** "SOL" | "USDC" by mint, else the symbol the source gave (or the shortened mint). */
export function quoteSymbolOf(mint: string | null, symbol: string | null): string {
  if (mint === SOL_MINT) return "SOL";
  if (mint === USDC_MINT) return "USDC";
  if (symbol === "WSOL") return "SOL";
  return symbol ?? (mint ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : "?");
}

/** GeckoTerminal names look like "JubJub / ZEC" or "SOL / USDC 0.04%": split into symbols. */
export function splitName(name: string | null): { base: string | null; quote: string | null } {
  if (!name) return { base: null, quote: null };
  const parts = name.split(" / ");
  if (parts.length < 2) return { base: name.trim() || null, quote: null };
  const quote = parts.slice(1).join(" / ").replace(/\s+[\d.]+%$/, "").trim();
  return { base: parts[0].trim() || null, quote: quote || null };
}

/* ---------- parsers ---------- */

export function parseTrending(json: unknown): PoolSample[] {
  const out: PoolSample[] = [];
  for (const item of (obj(json).data as unknown[]) ?? []) {
    const d = obj(item);
    const at = obj(d.attributes);
    const rel = obj(d.relationships);
    const address = str(at.address);
    if (!address) continue;
    const baseMint = str(obj(obj(rel.base_token).data).id)?.replace(/^solana_/, "") ?? null;
    const quoteMint = str(obj(obj(rel.quote_token).data).id)?.replace(/^solana_/, "") ?? null;
    const dexId = str(obj(obj(rel.dex).data).id) ?? "unknown";
    const name = str(at.name);
    const sym = splitName(name);
    const vol = obj(at.volume_usd);
    const tx = obj(at.transactions);
    const m5 = obj(tx.m5);
    const h1 = obj(tx.h1);
    const chg = obj(at.price_change_percentage);
    const created = at.pool_created_at ? Date.parse(String(at.pool_created_at)) : NaN;
    out.push({
      source: "trending",
      address,
      name,
      venue: venueOfDex(dexId),
      baseMint,
      quoteMint,
      baseSymbol: sym.base,
      quoteSymbol: quoteSymbolOf(quoteMint, sym.quote),
      priceUsd: num(at.base_token_price_usd),
      quotePriceUsd: num(at.quote_token_price_usd),
      liquidityUsd: num(at.reserve_in_usd),
      vol5mUsd: num(vol.m5),
      vol1hUsd: num(vol.h1),
      vol24hUsd: num(vol.h24),
      buys5m: num(m5.buys),
      sells5m: num(m5.sells),
      buys1h: num(h1.buys),
      sells1h: num(h1.sells),
      priceChange5mPct: num(chg.m5),
      priceChange1hPct: num(chg.h1),
      priceChange24hPct: num(chg.h24),
      createdAt: Number.isFinite(created) ? created : null,
    });
  }
  return out;
}

export function parseDexScreener(json: unknown): PoolSample[] {
  const out: PoolSample[] = [];
  for (const item of (obj(json).pairs as unknown[]) ?? []) {
    const p = obj(item);
    const address = str(p.pairAddress);
    if (!address || (p.chainId && p.chainId !== "solana")) continue;
    const base = obj(p.baseToken);
    const quote = obj(p.quoteToken);
    const labels = Array.isArray(p.labels) ? p.labels.map(String) : [];
    const vol = obj(p.volume);
    const tx = obj(p.txns);
    const m5 = obj(tx.m5);
    const h1 = obj(tx.h1);
    const chg = obj(p.priceChange);
    const baseMint = str(base.address);
    const quoteMint = str(quote.address);
    const baseSymbol = str(base.symbol);
    const quoteSymbol = quoteSymbolOf(quoteMint, str(quote.symbol));
    out.push({
      source: "dexscreener",
      address,
      name: baseSymbol ? `${baseSymbol} / ${quoteSymbol}` : null,
      venue: venueOfDex(str(p.dexId) ?? "unknown", labels),
      baseMint,
      quoteMint,
      baseSymbol,
      quoteSymbol,
      priceUsd: num(p.priceUsd),
      quotePriceUsd: null,
      liquidityUsd: num(obj(p.liquidity).usd),
      vol5mUsd: num(vol.m5),
      vol1hUsd: num(vol.h1),
      vol24hUsd: num(vol.h24),
      buys5m: num(m5.buys),
      sells5m: num(m5.sells),
      buys1h: num(h1.buys),
      sells1h: num(h1.sells),
      priceChange5mPct: num(chg.m5),
      priceChange1hPct: num(chg.h1),
      priceChange24hPct: num(chg.h24),
      createdAt: num(p.pairCreatedAt),
    });
  }
  return out;
}

/* ---------- fetchers ---------- */

export interface SourceOpts {
  fetchImpl?: typeof fetch;
  log?: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** ms to wait after a 429 before retrying the same call */
  backoffMs?: number;
  /** ms between consecutive GeckoTerminal calls */
  paceMs?: number;
}

export interface SourceResult {
  samples: PoolSample[];
  /** HTTP calls made, retries included */
  calls: number;
  errors: string[];
}

export const TRENDING_URL = (duration: string, page = 1) => `https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=${page}&duration=${duration}`;
export const DEXSCREENER_URL = (addresses: string[]) => `https://api.dexscreener.com/latest/dex/pairs/solana/${addresses.join(",")}`;

async function getJson(url: string, o: Required<Pick<SourceOpts, "fetchImpl" | "sleep" | "backoffMs" | "log">>, counter: { calls: number }, retries = 2): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    counter.calls++;
    const res = await o.fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (res.status === 429 && attempt < retries) {
      o.log(`[hot] rate limited by ${new URL(url).host}; waiting ${Math.round(o.backoffMs / 1000)}s`);
      await o.sleep(o.backoffMs);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}

/** GeckoTerminal trending for each duration asked, one page each. A duration that fails is reported, the rest still count. */
export async function fetchTrending(durations: string[] = ["5m", "1h"], opts: SourceOpts = {}): Promise<SourceResult> {
  const o = { fetchImpl: opts.fetchImpl ?? fetch, sleep: opts.sleep ?? defaultSleep, backoffMs: opts.backoffMs ?? 20_000, log: opts.log ?? (() => {}), paceMs: opts.paceMs ?? 2200 };
  const counter = { calls: 0 };
  const samples: PoolSample[] = [];
  const errors: string[] = [];
  for (let i = 0; i < durations.length; i++) {
    const d = durations[i];
    try {
      samples.push(...parseTrending(await getJson(TRENDING_URL(d), o, counter)));
    } catch (err) {
      const msg = `trending ${d}: ${(err as Error).message}`;
      errors.push(msg);
      o.log(`[hot] ${msg}`);
    }
    if (i + 1 < durations.length) await o.sleep(o.paceMs);
  }
  return { samples, calls: counter.calls, errors };
}

/** DexScreener pairs for the addresses given, 30 per call, three calls in flight at a time. A failed batch is reported and skipped. */
export async function fetchDexScreener(addresses: string[], opts: SourceOpts = {}): Promise<SourceResult> {
  const o = { fetchImpl: opts.fetchImpl ?? fetch, sleep: opts.sleep ?? defaultSleep, backoffMs: opts.backoffMs ?? 2000, log: opts.log ?? (() => {}) };
  const counter = { calls: 0 };
  const samples: PoolSample[] = [];
  const errors: string[] = [];
  const unique = [...new Set(addresses.filter(Boolean))];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += 30) batches.push(unique.slice(i, i + 30));
  for (let i = 0; i < batches.length; i += 3) {
    await Promise.all(
      batches.slice(i, i + 3).map(async (batch, j) => {
        try {
          samples.push(...parseDexScreener(await getJson(DEXSCREENER_URL(batch), o, counter)));
        } catch (err) {
          const msg = `dexscreener batch ${i + j + 1}/${batches.length}: ${(err as Error).message}`;
          errors.push(msg);
          o.log(`[hot] ${msg}`);
        }
      }),
    );
  }
  return { samples, calls: counter.calls, errors };
}
