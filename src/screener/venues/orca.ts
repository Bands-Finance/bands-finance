/**
 * Orca Whirlpools through the public v2 API.
 *
 * GET https://api.orca.so/v2/solana/pools?size=200&sort=volume24h:desc[&next=<cursor>]
 *  -> { data: [ { address, tokenMintA, tokenMintB, tokenA:{symbol,decimals,...}, tokenB:{...}, tickSpacing,
 *       feeRate (400 = 0.04%, hundredths of a bp), price (B per A), tvlUsdc, liquidity, sqrtPrice, tickCurrentIndex,
 *       tokenBalanceA, tokenBalanceB (raw), stats: { "24h": { volume, fees, yieldOverTvl, priceDelta }, "7d": {...} },
 *       adaptiveFeeEnabled, adaptiveFee: { currentRate, maxRate, variables: { lastMajorSwapTimestamp } } | null,
 *       hasWarning, tradeEnableTimestamp, updatedAt } ], meta: { cursor: { next, previous } } }
 * Numbers arrive as strings. The next page is requested with `next=<meta.cursor.next>` (the documented
 * parameter; `cursor=` is ignored by the API and returns the first page again).
 */
import type { VenuePool } from "../types";
import { cleanSymbol, getJson, num, pickQuote } from "./common";

export const ORCA_API = "https://api.orca.so/v2/solana/pools";
const PAGE_SIZE = 200;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

export const orcaPageUrl = (cursor: string | null, size = PAGE_SIZE) =>
  `${ORCA_API}?size=${size}&sort=volume24h:desc${cursor ? `&next=${encodeURIComponent(cursor)}` : ""}`;

/** Follow meta.cursor.next until it runs out or the page cap is hit. */
export async function fetchOrca({
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
  let cursor: string | null = null;
  let pages = 0;
  const seenCursors = new Set<string>();
  while (pages < maxPages) {
    const json = obj(await getJson(orcaPageUrl(cursor), { fetchImpl, log, label: "orca", backoffMs }));
    const list = Array.isArray(json.data) ? json.data : [];
    rows.push(...list);
    pages++;
    const next = obj(obj(json.meta).cursor).next;
    if (typeof next !== "string" || !next || list.length === 0 || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
    if (pages < maxPages && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
  }
  return { rows, pages };
}

const parseTs = (v: unknown): number | null => {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) && t > 0 ? t : null;
};

/** One API row -> the screener's shape, or null when the pool is not SOL/USDC-quoted. */
export function normalizeOrca(row: unknown, now = Date.now()): VenuePool | null {
  const r = obj(row);
  const mintA = String(r.tokenMintA ?? "");
  const mintB = String(r.tokenMintB ?? "");
  const quote = pickQuote(mintA, mintB);
  if (!quote) return null;
  const priceBPerA = num(r.price);
  if (priceBPerA === null || !(priceBPerA > 0)) return null;
  const a = obj(r.tokenA);
  const b = obj(r.tokenB);
  const base = quote.side === "A" ? b : a;
  const baseMint = quote.side === "A" ? mintB : mintA;
  const baseDecimals = num(base.decimals) ?? 0;
  const decA = num(a.decimals) ?? 0;
  const decB = num(b.decimals) ?? 0;
  const balA = (num(r.tokenBalanceA) ?? 0) / 10 ** decA;
  const balB = (num(r.tokenBalanceB) ?? 0) / 10 ** decB;
  const reserveQuote = quote.side === "A" ? balA : balB;
  const reserveBase = quote.side === "A" ? balB : balA;
  // Orca's price is B per A; the board wants quote per base.
  const price = quote.side === "B" ? priceBPerA : 1 / priceBPerA;
  const tvlQuote = reserveQuote + reserveBase * price;
  const feeRate = num(r.feeRate) ?? 0; // hundredths of a basis point
  const baseFeePct = feeRate / 10000;
  const adaptive = r.adaptiveFeeEnabled === true;
  const adaptiveRate = adaptive ? (num(obj(r.adaptiveFee).currentRate) ?? 0) : 0;
  const s24 = obj(obj(r.stats)["24h"]);
  const priceDelta = num(s24.priceDelta);
  const enabledAt = parseTs(r.tradeEnableTimestamp);
  const baseSymbol = cleanSymbol(base.symbol, baseMint);
  const tickSpacing = num(r.tickSpacing) ?? 1;
  return {
    address: String(r.address),
    venue: "orca-whirlpool",
    baseMint,
    quoteMint: quote.side === "A" ? mintA : mintB,
    quoteSymbol: quote.symbol,
    baseDecimals,
    quoteDecimals: quote.decimals,
    stepBps: tickSpacing,
    binStep: tickSpacing,
    baseFeePct,
    // Adaptive pools add a variable rate on top of the base; the API reports the current one.
    dynamicFeePct: (feeRate + adaptiveRate) / 10000,
    activeBinId: num(r.tickCurrentIndex) ?? 0,
    price,
    reserveBase,
    reserveQuote,
    tvlQuote,
    quoteShare: tvlQuote > 0 ? reserveQuote / tvlQuote : 0,
    lastTradeAt: adaptive ? parseTs(obj(obj(r.adaptiveFee).variables).lastMajorSwapTimestamp) : null,
    volatilityAccumulator: adaptive ? (num(obj(obj(r.adaptiveFee).variables).volatilityAccumulator) ?? 0) : 0,
    maxVolatilityAccumulator: adaptive ? (num(obj(obj(r.adaptiveFee).constants).maxVolatilityAccumulator) ?? 0) : 0,
    protocolFeeBase: String((quote.side === "A" ? r.protocolFeeOwedB : r.protocolFeeOwedA) ?? "0"),
    protocolFeeQuote: String((quote.side === "A" ? r.protocolFeeOwedA : r.protocolFeeOwedB) ?? "0"),
    // protocolFeeRate is in basis points of the fee: 1300 = 13% of fees go to the protocol.
    protocolSharePct: (num(r.protocolFeeRate) ?? 0) / 100,
    name: `${baseSymbol} / ${quote.symbol}`,
    baseSymbol,
    baseName: typeof base.name === "string" ? base.name : null,
    tvlUsd: num(r.tvlUsdc),
    volume24hUsd: num(s24.volume),
    fees24hUsd: num(s24.fees),
    priceChange24hPct: priceDelta === null ? null : priceDelta * 100,
    ageHours: enabledAt !== null && enabledAt < now ? (now - enabledAt) / 3600e3 : null,
    adaptiveFee: adaptive,
  };
}
