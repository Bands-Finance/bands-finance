/**
 * THE MEMECOIN FLOOR: which non-stock tokens the desk may pick. Zach (2026-09-15): "when selecting
 * memecoins we should be selecting tokens in a higher range not on launch maybe about 1million
 * market cap".
 *
 * Replayed on the paper book's first day (2026-09-15) the two halves did different work:
 *   - the AGE floor (not on launch, 24h) would have kept the desk out of GOOGL, HUHCAT, CAT, NIKE and
 *     OpenAI, whose closed bands lost 12.7 SOL between them (GOOGL fell 86% in five minutes at 8.6h old);
 *   - the MARKET CAP floor ($1M) changes little on that day: every memecoin the desk entered was already
 *     above it except DJT, INDEX and CAT, which made a small profit;
 *   - tokens that clear both (baton, ALLINU, EMBER, ZCAT, STONK, LOOM) still lost 20 SOL, falling
 *     through their bands. The floor is a guardrail, not the answer to trend losses.
 *
 * Applied by the picker (src/index.ts pickPools) to every lane that can seat a memecoin: the hot list,
 * the screener board, the launch lane and the pump.fun pair lane. Tokenized stocks and the house token
 * are never judged by it. A token whose market cap or age nobody reported is refused while the
 * corresponding floor is on: the floor exists to keep out what cannot be checked.
 *
 * Env: MEME_MIN_MARKET_CAP_USD (1000000; 0 = off), MEME_MAX_MARKET_CAP_USD (unset = no ceiling),
 * MEME_MIN_AGE_HOURS (24; 0 = off). Pure.
 */

export interface MemeFloorEnv {
  minMarketCapUsd: number;
  maxMarketCapUsd: number | null;
  minAgeHours: number;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function memeFloorEnv(env: NodeJS.ProcessEnv = process.env): MemeFloorEnv {
  const max = (env.MEME_MAX_MARKET_CAP_USD ?? "").trim();
  const maxN = max === "" ? null : Number(max);
  return {
    minMarketCapUsd: Math.max(0, num(env.MEME_MIN_MARKET_CAP_USD, 1_000_000)),
    maxMarketCapUsd: maxN !== null && Number.isFinite(maxN) && maxN > 0 ? maxN : null,
    minAgeHours: Math.max(0, num(env.MEME_MIN_AGE_HOURS, 24)),
  };
}

export interface MemeCandidate {
  symbol: string;
  marketCapUsd: number | null;
  /** hours since the pool (or the token's first pool) was created */
  ageHours: number | null;
  /** a tokenized stock: never judged by the memecoin floor */
  stock?: unknown;
  /** the house token (PAIR_HOUSE_MINTS): always seated, never judged */
  house?: boolean;
  /** the value of the pool's holdings of the token itself, USD (the quote side excluded): a cap far under it is not a reading */
  tokenSideUsd?: number | null;
  /** the pool's day of volume, USD: stands in for an unreadable market cap when it is at least the floor */
  volume24hUsd?: number | null;
  /** the token's day, percent: an unreadable cap never stands in for a token in collapse */
  priceChange24hPct?: number | null;
}

const usd = (n: number): string => (n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : `$${Math.round(n).toLocaleString("en-US")}`);

/** PURE. Null when the token may be picked, else the reason in the desk's voice, naming the number. */
export function memeRefusal(c: MemeCandidate, env: MemeFloorEnv): string | null {
  if (c.stock || c.house) return null;
  if (env.minAgeHours > 0) {
    if (c.ageHours === null || !Number.isFinite(c.ageHours)) return `${c.symbol}: age unknown, and the desk does not pick a memecoin it cannot date`;
    if (c.ageHours < env.minAgeHours) return `${c.symbol} is ${c.ageHours.toFixed(1)}h old, under the ${env.minAgeHours}h memecoin floor: not on launch`;
  }
  if (env.minMarketCapUsd > 0 || env.maxMarketCapUsd !== null) {
    if (c.marketCapUsd === null || !Number.isFinite(c.marketCapUsd) || c.marketCapUsd <= 0) return `${c.symbol}: market cap unknown, and the desk does not pick a memecoin it cannot size`;
    // A cap under what the pool itself holds of the token is not a reading: the supply cannot be smaller than one pool's
    // reserve of it (wXMR: $623 against thousands of dollars of wXMR in the pool and $1M of daily volume, a wrapped asset
    // the venue's supply figure cannot size). A day's volume of at least the floor stands in, on a token that is not
    // collapsing, and never for a ceiling, which no stand-in can judge. The pool's quote side is not counted.
    const unreadable = typeof c.tokenSideUsd === "number" && c.tokenSideUsd > 0 && c.marketCapUsd < c.tokenSideUsd;
    if (unreadable) {
      if (env.maxMarketCapUsd !== null) return `${c.symbol}: market cap reads ${usd(c.marketCapUsd)}, under the ${usd(c.tokenSideUsd!)} of ${c.symbol} the pool holds, so it cannot be right, and a ceiling cannot be judged without it`;
      const falling = typeof c.priceChange24hPct === "number" && c.priceChange24hPct <= -50;
      if (typeof c.volume24hUsd === "number" && c.volume24hUsd >= env.minMarketCapUsd && !falling) return null;
      return `${c.symbol}: market cap reads ${usd(c.marketCapUsd)}, under the ${usd(c.tokenSideUsd!)} of ${c.symbol} the pool holds, so it cannot be right, and ${falling ? `a token down ${Math.abs(c.priceChange24hPct!).toFixed(0)}% on the day` : c.volume24hUsd ? `${usd(c.volume24hUsd)} of daily volume` : "no volume figure"} ${falling ? "cannot" : "is too little to"} stand in for the ${usd(env.minMarketCapUsd)} floor`;
    }
    if (c.marketCapUsd < env.minMarketCapUsd) return `${c.symbol} is at ${usd(c.marketCapUsd)} market cap, under the ${usd(env.minMarketCapUsd)} memecoin floor`;
    if (env.maxMarketCapUsd !== null && c.marketCapUsd > env.maxMarketCapUsd) return `${c.symbol} is at ${usd(c.marketCapUsd)} market cap, over the ${usd(env.maxMarketCapUsd)} memecoin ceiling`;
  }
  return null;
}

/** A one-line summary of what the floor kept out this cycle, or null when it kept out nothing. */
export function memeFloorLine(refused: readonly string[], env: MemeFloorEnv): string | null {
  if (!refused.length) return null;
  const rule = [env.minAgeHours > 0 ? `>= ${env.minAgeHours}h old` : null, env.minMarketCapUsd > 0 ? `>= ${usd(env.minMarketCapUsd)} market cap` : null, env.maxMarketCapUsd !== null ? `<= ${usd(env.maxMarketCapUsd)}` : null].filter(Boolean).join(", ");
  const shown = refused.slice(0, 4).join("; ");
  return `memecoin floor (${rule}) kept out ${refused.length}: ${shown}${refused.length > 4 ? `; and ${refused.length - 4} more` : ""}`;
}
