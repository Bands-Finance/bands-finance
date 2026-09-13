/** Where a pool lives. Meteora is read from chain; Raydium and Orca come from their public APIs. */
export type Venue = "meteora-dlmm" | "raydium-clmm" | "orca-whirlpool";

/**
 * Where fees24hUsd came from: "onchain" is Meteora's measured protocol-fee deltas, "estimate" is
 * volume x base fee, "api" is the venue's own 24h fee figure (Raydium day.volumeFee, Orca stats.24h.fees).
 */
export type FeesSource = "onchain" | "estimate" | "api";

export type StockIssuer = "xstocks" | "backpack" | "unknown";

/** A tokenized stock on the base side of a pool. issuer "unknown" means the symbol looks like a stock but the mint is not a known issuer's. */
export interface StockTag {
  ticker: string;
  issuer: StockIssuer;
}

export interface OnchainPool {
  address: string;
  baseMint: string;
  quoteMint: string;
  quoteSymbol: "SOL" | "USDC";
  baseDecimals: number;
  quoteDecimals: number;
  /**
   * Meteora: the bin step in basis points. Raydium / Orca: equals stepBps (the tick spacing),
   * kept so every consumer of binStep keeps working; prefer stepBps for venue-neutral code.
   */
  binStep: number;
  baseFeePct: number;
  dynamicFeePct: number;
  /** Meteora: the active bin id. Orca: the current tick index. Raydium: the tick index derived from the reported price. */
  activeBinId: number;
  /** quote per base, UI units */
  price: number;
  reserveBase: number;
  reserveQuote: number;
  /** total pool liquidity valued in quote units */
  tvlQuote: number;
  /** share of TVL sitting on the quote side, 0..1 */
  quoteShare: number;
  lastTradeAt: number | null;
  volatilityAccumulator: number;
  maxVolatilityAccumulator: number;
  protocolFeeBase: string;
  protocolFeeQuote: string;
  protocolSharePct: number;
}

/**
 * A pool as a venue adapter hands it over: the on-chain shape, plus what the venue's API already
 * knows (TVL, volume, fees, 24h move, age). Nulls are filled by GeckoTerminal later, never overwritten.
 */
export interface VenuePool extends OnchainPool {
  venue: Venue;
  /** venue-neutral price step in basis points: Meteora bin step, Raydium/Orca tick spacing (one tick is one bp) */
  stepBps: number;
  name: string;
  baseSymbol: string;
  /** the base token's long name as the venue lists it (Backpack stocks are labelled "... - Backpack Securities") */
  baseName: string | null;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  fees24hUsd: number | null;
  priceChange24hPct: number | null;
  ageHours: number | null;
  /** the venue charges a variable fee on top of the base (Orca adaptive fee, Raydium dynamic fee) */
  adaptiveFee: boolean;
}

export interface ScreenedPool extends OnchainPool {
  /** defaults to "meteora-dlmm" when a snapshot predates venues */
  venue: Venue;
  /** venue-neutral price step in basis points: Meteora bin step, Raydium/Orca tick spacing */
  stepBps: number;
  /** tokenized stock on the base side, or null */
  stock: StockTag | null;
  name: string;
  baseSymbol: string;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  fees24hUsd: number | null;
  feesSource: FeesSource | null;
  /** hours of on-chain fee samples behind fees24hUsd when feesSource is onchain */
  feesWindowHours: number | null;
  feeToTvl24hPct: number | null;
  turnover24h: number | null;
  priceChange24hPct: number | null;
  /** (max bin - min bin) x binStep over the sample window, in percent */
  binRangePct: number | null;
  txns24h: number | null;
  mcapUsd: number | null;
  fdvUsd: number | null;
  ageHours: number | null;
  priceUsd: number | null;
  score: number;
  flags: string[];
  rank: number;
}

/** Per-venue counts: pools the venue returned, pools that passed the live/liquidity filters, pools on the board. */
export interface VenueCount {
  venue: Venue;
  scanned: number;
  live: number;
  ranked: number;
}

export interface ScreenResult {
  generatedAt: string;
  scanMs: number;
  /** Meteora DLMM pools read on-chain (kept as the on-chain figure; venues[] has the rest) */
  scannedPools: number;
  /** Meteora DLMM pools that traded within the active window */
  livePools: number;
  rankedPools: number;
  solPriceUsd: number | null;
  pools: ScreenedPool[];
  venues: VenueCount[];
  /** pools on the board whose base is a tokenized stock from a known issuer */
  stocks: number;
}
