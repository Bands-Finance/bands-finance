/**
 * Shapes of the hot watch: what a short-window source reports about a pool (PoolSample), what a
 * tick publishes (HotRow / HotFile), and the compact per-tick tape row (HotHistoryRow).
 */
import type { StockTag } from "../screener/types";

/** Where a pool's fee rate came from: our own board row, a live Meteora read, or nowhere (null feePct). */
export type HotFeeSource = "board" | "onchain" | null;

export interface HotRow {
  address: string;
  name: string;
  /** "meteora-dlmm" | "raydium-clmm" | "orca-whirlpool", or the source's dex id verbatim (pumpswap, meteora-damm-v2, ...) */
  venue: string;
  baseMint: string;
  baseSymbol: string;
  quoteMint: string;
  /** "SOL" | "USDC" | the quote's own symbol */
  quoteSymbol: string;
  /** the pool sits on the screener's board (data/screen.json) */
  onBoard: boolean;
  screenRank: number | null;
  /** tokenized stock on the base side, from the board row */
  stock: StockTag | null;

  vol1hUsd: number | null;
  vol5mUsd: number | null;
  vol24hUsd: number | null;
  liquidityUsd: number | null;
  /** the fee traders pay, in percent: dynamic when known, else base; null when nobody told us */
  feePct: number | null;
  feeSource: HotFeeSource;
  /** vol1h x feePct / 100 */
  fees1hUsd: number | null;
  /** fees1h / liquidity x 100: what a dollar in the pool earned in the last hour */
  feeToTvl1hPct: number | null;
  /** feeToTvl1hPct x 24: the return the LP sees if the last hour repeats all day */
  feeToTvlDailyPct: number | null;
  /** vol1h / liquidity */
  turnover1h: number | null;
  /** (vol1h x 24) / vol24h: 1 = steady, 3 = three times the daily pace */
  acceleration: number | null;
  buys1h: number | null;
  sells1h: number | null;
  buys5m: number | null;
  sells5m: number | null;
  sellShare1h: number | null;
  sellShare5m: number | null;
  priceChange5mPct: number | null;
  priceChange1hPct: number | null;
  priceChange24hPct: number | null;
  ageHours: number | null;

  /** 0..100, fee yield first, braked by liquidity, age and price behaviour */
  heat: number;
  flags: string[];
  /** a surge fired for this pool on this tick or within the last 30 minutes */
  surge: boolean;
  /** when the latest surge fired, if within the sticky window */
  surgeAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface HotSources {
  /** trending rows GeckoTerminal returned across the durations asked for */
  trending: number;
  /** pools DexScreener returned a pair for */
  dexscreener: number;
  /** live Meteora fee reads made this tick */
  onchainReads: number;
  /** GeckoTerminal token-pool lookups made this tick (sibling discovery) */
  siblingLookups?: number;
  /** pools the sibling lookups added to this tick that trending never mentioned */
  siblingRows?: number;
  /** what failed, in plain words; empty when every source answered */
  errors: string[];
}

export interface HotFile {
  generatedAt: string;
  tickMs: number;
  sources: HotSources;
  rows: HotRow[];
}

/** One compact row per pool per tick, appended to data/hot-history.jsonl for the tape. */
export interface HotHistoryRow {
  ts: number;
  address: string;
  venue: string;
  vol1hUsd: number | null;
  vol5mUsd: number | null;
  liquidityUsd: number | null;
  feeToTvl1hPct: number | null;
  sellShare1h: number | null;
  priceChange1hPct: number | null;
  heat: number;
  /** present only on the tick a surge fired */
  surge?: true;
}

/** A pool as a short-window source reports it. Nulls are what the source did not say. */
export interface PoolSample {
  /** "siblings": GeckoTerminal's other pools for a token that trended somewhere we cannot trade */
  source: "trending" | "dexscreener" | "siblings";
  address: string;
  name: string | null;
  /** the source's dex id, already mapped through venueOfDex */
  venue: string;
  baseMint: string | null;
  quoteMint: string | null;
  baseSymbol: string | null;
  quoteSymbol: string | null;
  priceUsd: number | null;
  /** USD price of the quote token (GeckoTerminal only): prices SOL when the quote is SOL */
  quotePriceUsd: number | null;
  liquidityUsd: number | null;
  vol5mUsd: number | null;
  vol1hUsd: number | null;
  vol24hUsd: number | null;
  buys5m: number | null;
  sells5m: number | null;
  buys1h: number | null;
  sells1h: number | null;
  priceChange5mPct: number | null;
  priceChange1hPct: number | null;
  priceChange24hPct: number | null;
  /** pool creation time, ms since epoch */
  createdAt: number | null;
}
