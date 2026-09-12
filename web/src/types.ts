export type Action = "HOLD" | "OPEN_POSITION" | "CLOSE_POSITION" | "CLAIM_FEES" | "REBALANCE";

export interface OpenParams {
  side: "SOL_ONLY" | "TOKEN_ONLY" | "BOTH";
  amountSol: number;
  amountToken: number;
  binsBelowActive: number;
  binsAboveActive: number;
  strategy: string;
}

export interface Decision {
  action: Action;
  open: OpenParams | null;
  positionAddress: string | null;
  reasoning: string;
  confidence: number;
  headline: string;
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
  mode: "none" | "dry-run" | "live";
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
}

export interface JournalEntry {
  id: string;
  ts: string;
  cycle: number;
  mode: "dry-run" | "live";
  agent?: { id: string; name: string };
  pool: JournalPool;
  wallet: { address: string; sol: number; token: number; tokenSymbol: string };
  positions: Position[];
  analytics: Analytics | null;
  llm: { source: "llm" | "fallback"; model: string; note?: string; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } };
  proposal: Decision;
  decision: Decision;
  allowed: boolean;
  violations: string[];
  overrides: string[];
  passed: string[];
  emergency: boolean;
  execution: Execution;
  headline: string;
  screen?: { rank: number; rankedPools: number; score: number; feeToTvl24hPct: number | null } | null;
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

export interface ScreenedPool {
  address: string;
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
  feesSource: "onchain" | "estimate" | null;
  feesWindowHours: number | null;
  feeToTvl24hPct: number | null;
  turnover24h: number | null;
  priceChange24hPct: number | null;
  binRangePct: number | null;
  txns24h: number | null;
  mcapUsd: number | null;
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
