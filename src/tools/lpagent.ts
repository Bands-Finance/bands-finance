/**
 * External pool analytics: volume, TVL, fees, USD price.
 *
 * Source order:
 *   1. LP Agent open API (docs.lpagent.io) when LPAGENT_API_KEY is set:
 *      GET {LPAGENT_API_URL}/pools/{pool}/info with header x-api-key.
 *      Returns tokenInfo (usdPrice), feeInfo, poolStats (TVL / fees / volumes) and
 *      liquidityViz (activeBin, bins). poolStats field names are not documented, so
 *      they are read defensively; the raw object is kept for the journal.
 *   2. GeckoTerminal public API (no key). Fees estimated as volume x base fee.
 *
 * Analytics are advisory. The loop keeps working when this returns null.
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

async function getJson(url: string, headers: Record<string, string> = {}, timeoutMs = 8000): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json", ...headers },
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

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

/** First finite value among candidate keys (LP Agent's poolStats keys are undocumented). */
function pick(o: Obj, keys: string[]): number | null {
  for (const k of keys) {
    const n = num(o[k]);
    if (n !== null) return n;
  }
  return null;
}

function fromLpAgent(payload: unknown, snapshot?: PoolSnapshot): PoolAnalytics {
  const d = obj(obj(payload).data);
  const tokens = (Array.isArray(d.tokenInfo) ? d.tokenInfo : [])
    .map((t) => (Array.isArray(obj(t).data) ? obj((obj(t).data as unknown[])[0]) : obj(t)))
    .filter((t) => Object.keys(t).length > 0);
  const base = tokens.find((t) => t.symbol !== "SOL" && (!snapshot || t.id === snapshot.baseToken.mint)) ?? tokens[0];
  const ps = obj(d.poolStats);
  const volume = pick(ps, ["volume24h", "volume_24h", "trade_volume_24h", "volume24hUsd", "volume"]);
  const tvl = pick(ps, ["tvl", "tvlUsd", "liquidity", "tvl_usd"]);
  const feesDirect = pick(ps, ["fees24h", "fees_24h", "fee24h", "fees24hUsd"]);
  const baseFeePct = num(obj(d.feeInfo).baseFeeRatePercentage) ?? snapshot?.baseFeePct ?? null;
  const fees = feesDirect ?? (volume !== null && baseFeePct !== null ? volume * (baseFeePct / 100) : null);
  return {
    source: "lpagent",
    priceUsd: base ? num(base.usdPrice) : null,
    volume24hUsd: volume,
    tvlUsd: tvl,
    fees24hUsd: fees,
    feeToTvl24hPct: tvl && fees ? (fees / tvl) * 100 : null,
    priceChange24hPct: pick(ps, ["priceChange24h", "price_change_24h"]),
    txns24h: pick(ps, ["txns24h", "trades24h", "swaps24h"]),
    note: feesDirect === null ? "fees24h estimated as volume x base fee" : "LP Agent pool stats",
  };
}

function fromGecko(payload: unknown, snapshot?: PoolSnapshot): PoolAnalytics {
  const attrs = obj(obj(obj(payload).data).attributes);
  const volume = num(obj(attrs.volume_usd).h24);
  const tvl = num(attrs.reserve_in_usd);
  const h24 = obj(obj(attrs.transactions).h24);
  const txns = Object.keys(h24).length ? (num(h24.buys) ?? 0) + (num(h24.sells) ?? 0) : null;
  const fees = volume !== null && snapshot ? volume * (snapshot.baseFeePct / 100) : null;
  // GeckoTerminal calls the pair base/quote in its own order; ours is "the quote sits on side Y" for SOL and USDC pools alike.
  const solIsQuote = snapshot ? (snapshot.quoteSide ?? snapshot.solSide ?? "Y") === "Y" : false;
  return {
    source: "geckoterminal",
    priceUsd: num(solIsQuote ? attrs.base_token_price_usd : attrs.quote_token_price_usd),
    volume24hUsd: volume,
    tvlUsd: tvl,
    fees24hUsd: fees,
    feeToTvl24hPct: tvl && fees ? (fees / tvl) * 100 : null,
    priceChange24hPct: num(obj(attrs.price_change_percentage).h24),
    txns24h: txns,
    note: "fees24h estimated as volume x base fee",
  };
}

export async function fetchPoolAnalytics(poolAddress: string, snapshot?: PoolSnapshot): Promise<PoolAnalytics | null> {
  if (config.lpagentApiKey) {
    try {
      const base = config.lpagentApiUrl.replace(/\/$/, "");
      return fromLpAgent(await getJson(`${base}/pools/${poolAddress}/info`, { "x-api-key": config.lpagentApiKey }), snapshot);
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
