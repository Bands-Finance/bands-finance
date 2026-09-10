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
