import "dotenv/config";
import { z } from "zod";
import type { RiskLimits } from "./risk/limits";

// dotenv sets `KEY=` to an empty string; treat those as unset so defaults apply.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ""),
);

const Raw = z.object({
  RPC_URL: z.string().default("https://api.mainnet-beta.solana.com"),
  WALLET_SECRET_KEY: z.string().default(""),
  ANTHROPIC_API_KEY: z.string().default(""),
  MODEL: z.string().default("claude-opus-5"),
  DRY_RUN: z.string().default("true"),
  POOL_ADDRESS: z.string().default("6e7V9eegCHw997T72MxgwwJipZ6GJyZF8NvjkzT1rvpN"),
  CYCLE_INTERVAL_SEC: z.coerce.number().default(300),
  DATA_DIR: z.string().default("data"),
  LPAGENT_API_URL: z.string().default(""),

  MAX_POSITION_SOL: z.coerce.number().default(0.5),
  MAX_TOTAL_EXPOSURE_SOL: z.coerce.number().default(1),
  GAS_RESERVE_SOL: z.coerce.number().default(0.1),
  STOP_LOSS_PCT: z.coerce.number().default(15),
  MAX_BIN_WIDTH: z.coerce.number().default(69),
  MAX_TX_PER_DAY: z.coerce.number().default(24),
  MIN_SECONDS_BETWEEN_ACTIONS: z.coerce.number().default(600),
  MAX_SLIPPAGE_PCT: z.coerce.number().default(1),
  MAX_PRICE_MOVE_PCT_PER_CYCLE: z.coerce.number().default(40),
});

const raw = Raw.parse(env);

export const config = {
  rpcUrl: raw.RPC_URL,
  walletSecretKey: raw.WALLET_SECRET_KEY,
  anthropicApiKey: raw.ANTHROPIC_API_KEY,
  model: raw.MODEL,
  // Only the literal "false" disables dry-run. Typos keep you safe.
  dryRun: raw.DRY_RUN.trim().toLowerCase() !== "false",
  poolAddress: raw.POOL_ADDRESS,
  cycleIntervalSec: raw.CYCLE_INTERVAL_SEC,
  dataDir: raw.DATA_DIR,
  lpagentApiUrl: raw.LPAGENT_API_URL,
} as const;

export const riskLimits: RiskLimits = {
  maxPositionSol: raw.MAX_POSITION_SOL,
  maxTotalExposureSol: raw.MAX_TOTAL_EXPOSURE_SOL,
  gasReserveSol: raw.GAS_RESERVE_SOL,
  stopLossPct: raw.STOP_LOSS_PCT,
  maxBinWidth: raw.MAX_BIN_WIDTH,
  maxTxPerDay: raw.MAX_TX_PER_DAY,
  minSecondsBetweenActions: raw.MIN_SECONDS_BETWEEN_ACTIONS,
  maxSlippagePct: raw.MAX_SLIPPAGE_PCT,
  maxPriceMovePctPerCycle: raw.MAX_PRICE_MOVE_PCT_PER_CYCLE,
};

if (!config.dryRun && !config.walletSecretKey) {
  throw new Error("DRY_RUN=false requires WALLET_SECRET_KEY. Refusing to start.");
}
