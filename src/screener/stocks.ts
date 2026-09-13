/**
 * The tokenized-stock lens. xStocks (Backed) mints all start with "Xs" and carry symbols like
 * NVDAx; a symbol alone proves nothing (memecoins imitate the pattern), so the mint prefix decides.
 * STOCK_MINTS adds Backpack Securities / Sunrise-listed mints by hand.
 */
import type { StockIssuer, StockTag } from "./types";

/** TICKER + lowercase x, e.g. NVDAx, BRK.Bx */
const XSTOCK_SYMBOL = /^[A-Z.]{1,6}x$/;
const XSTOCK_MINT_PREFIX = "Xs";

/**
 * Parse STOCK_MINTS: comma-separated `mint` or `mint:TICKER` pairs. Every mint listed is treated as
 * a Backpack-issued stock; a missing ticker falls back to the pool's symbol.
 */
export function parseStockMints(raw: string | undefined = process.env.STOCK_MINTS): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const part of (raw ?? "").split(",")) {
    const s = part.trim();
    if (!s) continue;
    const [mint, ticker] = s.split(":").map((x) => x.trim());
    if (mint) out.set(mint, ticker ? ticker.toUpperCase() : null);
  }
  return out;
}

let listed: Map<string, string | null> | null = null;
const listedMints = () => (listed ??= parseStockMints());

function tickerFromSymbol(symbol: string): string {
  return XSTOCK_SYMBOL.test(symbol) ? symbol.slice(0, -1) : symbol.toUpperCase();
}

/**
 * Tag a base token as a tokenized stock, or null.
 *  - mint starts with "Xs" and the symbol matches TICKERx -> xstocks
 *  - mint listed in STOCK_MINTS, or a token name the venue API labels "... - Backpack Securities" -> backpack
 *  - symbol matches TICKERx but the mint is nobody's -> "unknown" (shown as unverified, never counted)
 */
export function stockOf(mint: string, symbol: string, name?: string | null, extra: Map<string, string | null> = listedMints()): StockTag | null {
  const sym = (symbol ?? "").trim();
  if (extra.has(mint)) return { ticker: extra.get(mint) ?? tickerFromSymbol(sym), issuer: "backpack" };
  if (name && /backpack securities/i.test(name) && sym) return { ticker: tickerFromSymbol(sym), issuer: "backpack" };
  const looksLikeStock = XSTOCK_SYMBOL.test(sym);
  if (mint.startsWith(XSTOCK_MINT_PREFIX) && looksLikeStock) return { ticker: sym.slice(0, -1), issuer: "xstocks" };
  if (looksLikeStock) return { ticker: sym.slice(0, -1), issuer: "unknown" };
  return null;
}

/** A stock the board counts: one whose issuer is known. */
export const verifiedStock = (s: StockTag | null | undefined): s is StockTag => !!s && s.issuer !== "unknown";

export const ISSUER_LABEL: Record<StockIssuer, string> = {
  xstocks: "xStocks",
  backpack: "Backpack",
  unknown: "unverified",
};
