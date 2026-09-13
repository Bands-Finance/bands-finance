/**
 * Off-chain enrichment for the shortlist: 24h volume, USD prices, market cap, pool age.
 * GeckoTerminal's public bulk endpoint, 30 pools per call, paced under its rate limit.
 * Works by pool address for every venue (Meteora, Raydium CLMM, Orca).
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

export async function enrichPools(addresses: string[], { pauseMs = 2200, log = (_: string) => {} } = {}): Promise<Map<string, Enrichment>> {
  const out = new Map<string, Enrichment>();
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30);
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/multi/${batch.join(",")}?include=base_token,quote_token`;
    try {
      const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      if (res.status === 429) {
        log("geckoterminal rate limited; waiting 20s");
        await sleep(20000);
        i -= 30;
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = obj(await res.json());
      const tokens = new Map<string, Obj>();
      for (const inc of (json.included as unknown[]) ?? []) {
        const t = obj(inc);
        if (t.type === "token") tokens.set(String(obj(t.attributes).address), obj(t.attributes));
      }
      for (const item of (json.data as unknown[]) ?? []) {
        const d = obj(item);
        const at = obj(d.attributes);
        const rel = obj(d.relationships);
        const baseId = String(obj(obj(rel.base_token).data).id ?? "").replace(/^solana_/, "");
        const quoteId = String(obj(obj(rel.quote_token).data).id ?? "").replace(/^solana_/, "");
        const h24 = obj(obj(at.transactions).h24);
        const created = at.pool_created_at ? Date.parse(String(at.pool_created_at)) : NaN;
        out.set(String(at.address), {
          name: at.name ? String(at.name) : null,
          baseSymbol: tokens.get(baseId)?.symbol ? String(tokens.get(baseId)!.symbol) : null,
          quoteSymbol: tokens.get(quoteId)?.symbol ? String(tokens.get(quoteId)!.symbol) : null,
          baseMint: baseId || null,
          quoteMint: quoteId || null,
          priceUsd: num(at.base_token_price_usd),
          quotePriceUsd: num(at.quote_token_price_usd),
          reserveUsd: num(at.reserve_in_usd),
          volume24hUsd: num(obj(at.volume_usd).h24),
          priceChange24hPct: num(obj(at.price_change_percentage).h24),
          txns24h: Object.keys(h24).length ? (num(h24.buys) ?? 0) + (num(h24.sells) ?? 0) : null,
          fdvUsd: num(at.fdv_usd),
          mcapUsd: num(at.market_cap_usd),
          createdAt: Number.isFinite(created) ? created : null,
        });
      }
    } catch (err) {
      log(`geckoterminal batch ${i / 30 + 1} failed: ${(err as Error).message}`);
    }
    if (i + 30 < addresses.length) await sleep(pauseMs);
  }
  return out;
}
