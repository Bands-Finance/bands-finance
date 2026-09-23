export type Action = "HOLD" | "OPEN_POSITION" | "CLOSE_POSITION" | "CLAIM_FEES" | "REBALANCE";

export interface OpenParams {
  side: "SOL_ONLY" | "TOKEN_ONLY" | "BOTH";
  amountSol: number;
  amountToken: number;
  binsBelowActive: number;
  binsAboveActive: number;
  strategy: string;
  /** stock straddles: base token bought (Jupiter) before the deposit; absent or 0 otherwise */
  acquireToken?: number;
}

export interface Decision {
  action: Action;
  open: OpenParams | null;
  positionAddress: string | null;
  reasoning: string;
  confidence: number;
  headline: string;
  /** CLOSE_POSITION on a stock band: the token that comes back is sold into the quote; absent = false */
  liquidate?: boolean;
  /** REBALANCE only: the closing band's token is laid as an ask band instead of sold (the ask exit) */
  exitAsk?: boolean;
}

export interface BinRow {
  binId: number;
  price: number;
  xAmount: number;
  yAmount: number;
  isActive: boolean;
}

export interface Position {
  address: string;
  lowerBinId: number;
  upperBinId: number;
  lowerPrice: number;
  upperPrice: number;
  widthBins: number;
  inRange: boolean;
  binsFromRange: number;
  amountX: number;
  amountY: number;
  feeX: number;
  feeY: number;
  valueInSol: number;
  solInPosition: number;
  lastUpdatedAt: number;
  entryValueSol?: number;
  /** the rent the band gets back on close, SOL, when the journal carries it (older journals: by the entry's mode) */
  rentSol?: number;
}

export interface TxReport {
  label: string;
  ok: boolean;
  signature?: string;
  error?: string;
  unitsConsumed?: number;
  skipped?: string;
}

export interface Execution {
  mode: "none" | "dry-run" | "live" | "paper";
  ok: boolean;
  txs: TxReport[];
  opened?: { address: string; entryValueSol: number };
  closed?: string;
  notes: string[];
}

export interface Analytics {
  source: string;
  priceUsd: number | null;
  volume24hUsd: number | null;
  tvlUsd: number | null;
  fees24hUsd: number | null;
  feeToTvl24hPct: number | null;
  priceChange24hPct: number | null;
  txns24h: number | null;
  note: string;
}

export interface JournalPool {
  address: string;
  label: string;
  tokenX: { symbol: string; decimals: number };
  tokenY: { symbol: string; decimals: number };
  solSide: "X" | "Y" | null;
  binStep: number;
  activeBinId: number;
  price: number;
  priceLabel: string;
  tokenPriceInSol: number;
  baseFeePct: number;
  dynamicFeePct: number;
  bins: BinRow[];
  /** the quote token; absent on older entries, which are SOL-quoted */
  quoteSymbol?: "SOL" | "USDC";
  quoteMint?: string;
  quoteSide?: "X" | "Y";
  /** SOL per one quote unit (1 for SOL) */
  quotePriceInSol?: number;
  /** quote per base token */
  tokenPriceInQuote?: number;
  /** the venue the pool lives on; absent on entries written before venues: meteora-dlmm */
  venue?: "meteora-dlmm" | "raydium-clmm" | "orca-whirlpool";
  /** the tokenized stock on the base side, when the desk knew it; absent on older entries */
  stock?: StockTag | null;
}

export interface JournalEntry {
  id: string;
  ts: string;
  cycle: number;
  mode: "dry-run" | "live" | "paper";
  agent?: { id: string; name: string };
  pool: JournalPool;
  wallet: { address: string; sol: number; token: number; tokenSymbol: string };
  positions: Position[];
  analytics: Analytics | null;
  /** who authored the decision: the model, the desk policy standing in for it, an engine directive, an approved outside proposal, or a bare hold when nothing answered */
  llm: { source: "llm" | "fallback" | "policy" | "screen" | "engine" | "proposal"; model: string; note?: string; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } };
  proposal: Decision;
  decision: Decision;
  allowed: boolean;
  violations: string[];
  overrides: string[];
  passed: string[];
  emergency: boolean;
  execution: Execution;
  headline: string;
  /** the engine's view for this cycle; only the parts the site renders are typed here */
  engine?: {
    /** a pool the desk MADE (the pair lane): our own Meteora DLMM pool for a token, keyed pair-<mint> */
    pair?: {
      refPool: string | null;
      refVenue: string | null;
      refLiquidityUsd: number | null;
      /** the routing model's share of the reference pool's flow, after and before the split with competing depth */
      routedShare: number;
      routedShareGross: number;
      competingDepthUsd: number;
      feeBps: number;
      binStep: number;
      /** creation rent that never comes back (0 once the pool exists) */
      rentSol: number;
      lbPair: string | null;
      exists: boolean;
      ours: boolean;
      seatCapSol: number;
      stopPct: number;
      maxHoldMin: number;
    };
  };
  screen?: { rank: number; rankedPools: number; score: number; feeToTvl24hPct: number | null; flow?: FlowContext | null } | null;
}

/** The flow scout's last hour for a pool, as the desk journals it (src/scouts/flow.ts on the desk). Quote units. */
export interface FlowContext {
  asOf: number;
  quoteSymbol: string;
  swaps15m: number;
  volume15mQuote: number;
  fees15mQuote: number;
  /** fees paid in the bins his band covers (the bins' whole fees, not yet his share) */
  ours15mQuote: number;
  swaps60m: number;
  volume60mQuote: number;
  fees60mQuote: number;
  ours60mQuote: number;
  feesPerDayQuote60m: number | null;
  feesPerDayQuote15m: number | null;
  lastPrice: number | null;
  lastSwapAt: number | null;
  largest15m: { volumeQuote: number; dir: "buy" | "sell" } | null;
}

/** One point of the desk's equity per cycle, from its own marks (src/journal EquityPoint on the desk). */
export interface EquityHistoryPoint {
  t: number;
  cycle: number;
  agent: string;
  mode: "paper" | "dry-run" | "live";
  equitySol: number;
  walletSol: number;
  quoteSol: number;
  quoteUsdc: number;
  bandsSol: number;
  tokensSol: number;
  hedgeSol: number;
  bands: number;
  pools: number;
  /** fees claimed to the wallet since the run began, SOL */
  feesClaimedSol: number;
  solPriceUsd: number | null;
}

export interface RiskLimits {
  maxPositionSol: number;
  maxTotalExposureSol: number;
  gasReserveSol: number;
  stopLossPct: number;
  maxBinWidth: number;
  maxTxPerDay: number;
  minSecondsBetweenActions: number;
  maxSlippagePct: number;
  maxPriceMovePctPerCycle: number;
}

/** Where a pool lives. Snapshots from before venues carry no venue field: treat them as Meteora. */
export type Venue = "meteora-dlmm" | "raydium-clmm" | "orca-whirlpool";
export type StockIssuer = "xstocks" | "backpack" | "ondo" | "unknown";
/** A tokenized stock on the base side of a pool; issuer "unknown" is a stock-shaped symbol on a mint no known issuer owns. */
export interface StockTag {
  ticker: string;
  issuer: StockIssuer;
}
export interface VenueCount {
  venue: Venue;
  scanned: number;
  live: number;
  ranked: number;
}

export interface ScreenedPool {
  address: string;
  /** missing on old snapshots: defaults to "meteora-dlmm" */
  venue?: Venue;
  /** venue-neutral price step in bps (Meteora bin step, Raydium/Orca tick spacing); missing on old snapshots: use binStep */
  stepBps?: number;
  /** tokenized stock on the base side; missing on old snapshots */
  stock?: StockTag | null;
  name: string;
  baseSymbol: string;
  quoteSymbol: "SOL" | "USDC";
  baseMint: string;
  quoteMint: string;
  binStep: number;
  baseFeePct: number;
  dynamicFeePct: number;
  activeBinId: number;
  price: number;
  tvlQuote: number;
  quoteShare: number;
  lastTradeAt: number | null;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  fees24hUsd: number | null;
  /** onchain: Meteora fee counters; estimate: volume x base fee; api: the venue's own 24h figure */
  feesSource: "onchain" | "estimate" | "api" | null;
  feesWindowHours: number | null;
  feeToTvl24hPct: number | null;
  turnover24h: number | null;
  priceChange24hPct: number | null;
  binRangePct: number | null;
  txns24h: number | null;
  mcapUsd: number | null;
  fdvUsd?: number | null;
  ageHours: number | null;
  priceUsd: number | null;
  score: number;
  flags: string[];
  rank: number;
}

export interface ScreenResult {
  generatedAt: string;
  scanMs: number;
  /** Meteora pools read on-chain; venues[] carries every venue when present */
  scannedPools: number;
  livePools: number;
  rankedPools: number;
  solPriceUsd: number | null;
  pools: ScreenedPool[];
  /** per-venue counts; missing on old snapshots */
  venues?: VenueCount[];
  /** pools whose base is a tokenized stock from a known issuer; missing on old snapshots */
  stocks?: number;
}

/* ---------- platform: identity, your own Mr Bands, credits (src/platform on the server) ---------- */

export type RiskLevel = "conservative" | "balanced" | "aggressive";
export type AgentStyle = "concise" | "balanced" | "deep";
export type FocusArea = "market-making" | "yield" | "directional" | "research";

export interface AgentSettings {
  name?: string;
  riskAppetite?: RiskLevel;
  focus?: FocusArea[];
  style?: AgentStyle;
  goal?: string;
  voice?: string;
}

export interface AccountData {
  address: string;
  linkedAt: number;
}

export interface WalletSession {
  token: string;
  address: string;
  expiresAt: number;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  ts: string;
}

export interface CreditPack {
  id: string;
  usd: number;
  credits: number;
  bonusPct?: number;
}

export interface CreditsInfo {
  balance: number;
  freeMessages: number;
  packs: CreditPack[];
  /** whether a message is actually being charged for on this host */
  enforced: boolean;
}

/* ---------- the hot watch: 2-minute surge loop (src/hot on the server) ---------- */

/** One pool as the hot watch sees it. Venue is one of the screener's names or the source's dex id verbatim. */
export interface HotRow {
  address: string;
  name: string;
  venue: string;
  baseMint: string;
  baseSymbol: string;
  quoteMint: string;
  /** "SOL" | "USDC" | the quote's own symbol */
  quoteSymbol: string;
  onBoard: boolean;
  screenRank: number | null;
  stock: StockTag | null;
  vol1hUsd: number | null;
  vol5mUsd: number | null;
  vol24hUsd: number | null;
  liquidityUsd: number | null;
  /** the fee traders pay, in percent; null when nobody reported it */
  feePct: number | null;
  feeSource: "board" | "onchain" | null;
  fees1hUsd: number | null;
  /** what a dollar in the pool earned in the last 60 minutes, in percent */
  feeToTvl1hPct: number | null;
  /** feeToTvl1hPct x 24 */
  feeToTvlDailyPct: number | null;
  turnover1h: number | null;
  /** last hour vs the day's hourly pace: 1 = steady, 3 = three times */
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
  /** 0..100 */
  heat: number;
  flags: string[];
  surge: boolean;
  surgeAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface HotFile {
  generatedAt: string;
  tickMs: number;
  sources: { trending: number; dexscreener: number; onchainReads: number; errors: string[] };
  rows: HotRow[];
}
