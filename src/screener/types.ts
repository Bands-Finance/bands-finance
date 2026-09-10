export interface OnchainPool {
  address: string;
  baseMint: string;
  quoteMint: string;
  quoteSymbol: "SOL" | "USDC";
  baseDecimals: number;
  quoteDecimals: number;
  binStep: number;
  baseFeePct: number;
  dynamicFeePct: number;
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

export interface ScreenedPool extends OnchainPool {
  name: string;
  baseSymbol: string;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  fees24hUsd: number | null;
  feesSource: "onchain" | "estimate" | null;
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

export interface ScreenResult {
  generatedAt: string;
  scanMs: number;
  scannedPools: number;
  livePools: number;
  rankedPools: number;
  solPriceUsd: number | null;
  pools: ScreenedPool[];
}
