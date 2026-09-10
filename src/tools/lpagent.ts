/**
 * External pool analytics ("LP Agent"-style stats: volume, TVL, fees, price in USD).
 *
 * Source order:
 *   1. LPAGENT_API_URL if configured: GET {url}/pool/{address}, expected to return a JSON
 *      object with any of: priceUsd, volume24hUsd, tvlUsd, fees24hUsd, priceChange24hPct.
 *      Adapt `fromLpAgent` to the real payload once you have access.
 *   2. GeckoTerminal public API (no key). Fees are estimated as volume * base fee.
 *
 * Analytics are advisory. The loop must keep working when this returns null.
 */
import { config } from "../config";
import type { PoolSnapshot } from "./dlmm";

export interface PoolAnalytics {
  source: string;
  priceUsd: number | null;
  volume24hUsd: number | null;
  tvlUsd: number | null;
  fees24hUsd: number | null;
  /** fees24h / tvl, in percent. The number LPs actually care about. */
  feeToTvl24hPct: number | null;
  priceChange24hPct: number | null;
  txns24h: number | null;
  note: string;
}

async function getJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fromLpAgent(payload: unknown): PoolAnalytics {
  const p = (payload ?? {}) as Record<string, unknown>;
  const tvl = num(p.tvlUsd);
  const fees = num(p.fees24hUsd);
  return {
    source: "lpagent",
    priceUsd: num(p.priceUsd),
    volume24hUsd: num(p.volume24hUsd),
    tvlUsd: tvl,
    fees24hUsd: fees,
    feeToTvl24hPct: tvl && fees ? (fees / tvl) * 100 : null,
    priceChange24hPct: num(p.priceChange24hPct),
    txns24h: num(p.txns24h),
    note: "LP Agent endpoint",
  };
}

function fromGecko(payload: unknown, snapshot?: PoolSnapshot): PoolAnalytics {
  const attrs = ((payload as { data?: { attributes?: Record<string, unknown> } })?.data?.attributes ?? {}) as Record<string, unknown>;
  const volume = num((attrs.volume_usd as Record<string, unknown> | undefined)?.h24);
  const tvl = num(attrs.reserve_in_usd);
  const h24 = (attrs.transactions as Record<string, Record<string, unknown>> | undefined)?.h24;
  const txns = h24 ? (num(h24.buys) ?? 0) + (num(h24.sells) ?? 0) : null;
  // Estimate fees from volume and the pool's base fee. Dynamic fees make the real number higher.
  const fees = volume !== null && snapshot ? volume * (snapshot.baseFeePct / 100) : null;
  const solIsQuote = snapshot?.solSide === "Y";
  return {
    source: "geckoterminal",
    priceUsd: num(solIsQuote ? attrs.base_token_price_usd : attrs.quote_token_price_usd),
    volume24hUsd: volume,
    tvlUsd: tvl,
    fees24hUsd: fees,
    feeToTvl24hPct: tvl && fees ? (fees / tvl) * 100 : null,
    priceChange24hPct: num((attrs.price_change_percentage as Record<string, unknown> | undefined)?.h24),
    txns24h: txns,
    note: "fees24h estimated as volume x base fee",
  };
}

export async function fetchPoolAnalytics(poolAddress: string, snapshot?: PoolSnapshot): Promise<PoolAnalytics | null> {
  if (config.lpagentApiUrl) {
    try {
      const base = config.lpagentApiUrl.replace(/\/$/, "");
      return fromLpAgent(await getJson(`${base}/pool/${poolAddress}`));
    } catch (err) {
      console.warn(`[lpagent] ${(err as Error).message}; falling back to GeckoTerminal`);
    }
  }
  try {
    const payload = await getJson(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}`);
    return fromGecko(payload, snapshot);
  } catch (err) {
    console.warn(`[lpagent] analytics unavailable: ${(err as Error).message}`);
    return null;
  }
}
