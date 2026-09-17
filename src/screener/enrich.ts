/**
 * Off-chain enrichment for the shortlist: 24h volume, USD prices, market cap, pool age.
 * DexScreener's pairs endpoint, 30 pools per call (Zach, 2026-09-17: "we dont want to use
 * geckoterminal at all since its slow"; its bulk endpoint rate-limited every screen for minutes).
 * Works by pool address for every venue (Meteora, Raydium CLMM, Orca). On-chain data (swaps, bins,
 * signatures, ages of candidates) comes from Helius, never from here.
 */
export interface Enrichment {
  name: string | null;
  baseSymbol: string | null;
  quoteSymbol: string | null;
  /** how GeckoTerminal oriented the pair; when its quote is our base the USD prices are the other way round */
  baseMint: string | null;
  quoteMint: string | null;
  priceUsd: number | null;
  quotePriceUsd: number | null;
  reserveUsd: number | null;
  volume24hUsd: number | null;
  priceChange24hPct: number | null;
  txns24h: number | null;
  fdvUsd: number | null;
  mcapUsd: number | null;
  createdAt: number | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const DEXSCREENER_PAIRS_URL = (addresses: string[]): string => `https://api.dexscreener.com/latest/dex/pairs/solana/${addresses.join(",")}`;

/** PURE. DexScreener's pairs answer as enrichment rows by pool address. */
export function parseDexScreenerEnrichment(json: unknown): Map<string, Enrichment> {
  const out = new Map<string, Enrichment>();
  const pairs = obj(json).pairs;
  if (!Array.isArray(pairs)) return out;
  for (const item of pairs) {
    const p = obj(item);
    const address = typeof p.pairAddress === "string" ? p.pairAddress : null;
    if (!address) continue;
    const base = obj(p.baseToken);
    const quote = obj(p.quoteToken);
    const h24 = obj(obj(p.txns).h24);
    const priceUsd = num(p.priceUsd);
    const priceNative = num(p.priceNative);
    out.set(address, {
      name: base.symbol && quote.symbol ? `${String(base.symbol)} / ${String(quote.symbol)}` : null,
      baseSymbol: base.symbol ? String(base.symbol) : null,
      quoteSymbol: quote.symbol ? String(quote.symbol) : null,
      baseMint: typeof base.address === "string" ? base.address : null,
      quoteMint: typeof quote.address === "string" ? quote.address : null,
      priceUsd,
      // the quote's USD price follows from the two prices DexScreener gives: USD per base over quote per base
      quotePriceUsd: priceUsd !== null && priceNative !== null && priceNative > 0 ? priceUsd / priceNative : null,
      reserveUsd: num(obj(p.liquidity).usd),
      volume24hUsd: num(obj(p.volume).h24),
      priceChange24hPct: num(obj(p.priceChange).h24),
      txns24h: Object.keys(h24).length ? (num(h24.buys) ?? 0) + (num(h24.sells) ?? 0) : null,
      fdvUsd: num(p.fdv),
      mcapUsd: num(p.marketCap),
      createdAt: num(p.pairCreatedAt),
    });
  }
  return out;
}

export async function enrichPools(addresses: string[], { pauseMs = 250, log = (_: string) => {} } = {}): Promise<Map<string, Enrichment>> {
  const out = new Map<string, Enrichment>();
  let retried = false;
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30);
    try {
      const res = await fetch(DEXSCREENER_PAIRS_URL(batch), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      if (res.status === 429 && !retried) {
        retried = true;
        log("dexscreener rate limited; waiting 5s");
        await sleep(5000);
        i -= 30;
        continue;
      }
      retried = false;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const [address, e] of parseDexScreenerEnrichment(await res.json())) out.set(address, e);
    } catch (err) {
      log(`dexscreener batch ${Math.floor(i / 30) + 1} failed: ${(err as Error).message}`);
    }
    if (i + 30 < addresses.length) await sleep(pauseMs);
  }
  return out;
}
