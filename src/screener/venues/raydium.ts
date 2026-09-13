/**
 * Raydium CLMM through the public v3 API. Concentrated pools only for now: the same list
 * endpoint serves poolType=standard (constant product), which is a later option, not this one.
 *
 * GET https://api-v3.raydium.io/pools/info/list?poolType=concentrated&poolSortField=volume24h&sortType=desc&pageSize=500&page=N
 *  -> { success, data: { count, hasNextPage, data: [ { id, programId, type: "Concentrated", price, tvl, feeRate,
 *       mintA:{address,symbol,decimals,name}, mintB:{...}, mintAmountA, mintAmountB,
 *       day:{ volume, volumeQuote, volumeFee, apr, feeApr, priceMin, priceMax }, week, month,
 *       config:{ tickSpacing, tradeFeeRate, protocolFeeRate }, openTime, hasDynamicFee, burnPercent } ] } }
 */
import type { VenuePool } from "../types";
import { cleanSymbol, getJson, num, pickQuote, tickFromPrice } from "./common";

export const RAYDIUM_API = "https://api-v3.raydium.io/pools/info/list";
export const RAYDIUM_CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const PAGE_SIZE = 500;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

export const raydiumPageUrl = (page: number, pageSize = PAGE_SIZE) =>
  `${RAYDIUM_API}?poolType=concentrated&poolSortField=volume24h&sortType=desc&pageSize=${pageSize}&page=${page}`;

/** Page until hasNextPage is false or the page cap is hit; sorted by volume, so the cap keeps the live pools. */
export async function fetchRaydium({
  maxPages,
  log = () => {},
  fetchImpl = fetch,
  pauseMs = 300,
  backoffMs = 1500,
}: {
  maxPages: number;
  log?: (s: string) => void;
  fetchImpl?: typeof fetch;
  pauseMs?: number;
  backoffMs?: number;
}): Promise<{ rows: unknown[]; pages: number }> {
  const rows: unknown[] = [];
  let pages = 0;
  for (let page = 1; page <= maxPages; page++) {
    const json = obj(await getJson(raydiumPageUrl(page), { fetchImpl, log, label: "raydium", backoffMs }));
    if (json.success === false) throw new Error(`raydium: ${String(json.msg ?? "success=false")}`);
    const data = obj(json.data);
    const list = Array.isArray(data.data) ? data.data : [];
    rows.push(...list);
    pages++;
    if (!data.hasNextPage || list.length === 0) break;
    if (page < maxPages && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
  }
  return { rows, pages };
}

/** One API row -> the screener's shape, or null when the pool is not SOL/USDC-quoted or not a CLMM pool. */
export function normalizeRaydium(row: unknown, now = Date.now()): VenuePool | null {
  const r = obj(row);
  if (r.type !== undefined && r.type !== "Concentrated") return null;
  if (r.programId !== undefined && r.programId !== RAYDIUM_CLMM_PROGRAM) return null;
  const a = obj(r.mintA);
  const b = obj(r.mintB);
  const mintA = String(a.address ?? "");
  const mintB = String(b.address ?? "");
  const quote = pickQuote(mintA, mintB);
  if (!quote) return null;
  const priceBPerA = num(r.price);
  if (priceBPerA === null || !(priceBPerA > 0)) return null;
  const base = quote.side === "A" ? b : a;
  const baseMint = quote.side === "A" ? mintB : mintA;
  const baseDecimals = num(base.decimals) ?? 0;
  const amtA = num(r.mintAmountA) ?? 0;
  const amtB = num(r.mintAmountB) ?? 0;
  const reserveQuote = quote.side === "A" ? amtA : amtB;
  const reserveBase = quote.side === "A" ? amtB : amtA;
  // Raydium's price is B per A; the board wants quote per base.
  const price = quote.side === "B" ? priceBPerA : 1 / priceBPerA;
  const tvlQuote = reserveQuote + reserveBase * price;
  const cfg = obj(r.config);
  const day = obj(r.day);
  const feeRate = num(r.feeRate) ?? (num(cfg.tradeFeeRate) ?? 0) / 1e6;
  const baseFeePct = feeRate * 100;
  const openTime = num(r.openTime) ?? 0;
  const baseSymbol = cleanSymbol(base.symbol, baseMint);
  return {
    address: String(r.id),
    venue: "raydium-clmm",
    baseMint,
    quoteMint: quote.side === "A" ? mintA : mintB,
    quoteSymbol: quote.symbol,
    baseDecimals,
    quoteDecimals: quote.decimals,
    stepBps: num(cfg.tickSpacing) ?? 1,
    binStep: num(cfg.tickSpacing) ?? 1,
    baseFeePct,
    // The list API reports one fee rate; a dynamic-fee pool charges more when the market moves, so this understates it.
    dynamicFeePct: baseFeePct,
    activeBinId: tickFromPrice(priceBPerA, num(a.decimals) ?? 0, num(b.decimals) ?? 0),
    price,
    reserveBase,
    reserveQuote,
    tvlQuote,
    quoteShare: tvlQuote > 0 ? reserveQuote / tvlQuote : 0,
    lastTradeAt: null,
    volatilityAccumulator: 0,
    maxVolatilityAccumulator: 0,
    protocolFeeBase: "0",
    protocolFeeQuote: "0",
    protocolSharePct: ((num(cfg.protocolFeeRate) ?? 0) / 1e6) * 100,
    name: `${baseSymbol} / ${quote.symbol}`,
    baseSymbol,
    baseName: typeof base.name === "string" ? base.name : null,
    tvlUsd: num(r.tvl),
    volume24hUsd: num(day.volume),
    fees24hUsd: num(day.volumeFee),
    // day.priceMin/priceMax give a range, not a change: GeckoTerminal fills this.
    priceChange24hPct: null,
    ageHours: openTime > 0 && openTime * 1000 < now ? (now - openTime * 1000) / 3600e3 : null,
    adaptiveFee: r.hasDynamicFee === true,
  };
}
