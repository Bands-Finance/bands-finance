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
  POOL_ADDRESS: z.string().default(""),
  AUTO_DEPLOY: z.string().default("false"),
  CYCLE_INTERVAL_SEC: z.coerce.number().default(300),
  // stop after this many cycles (0 = run until stopped); for bounded dry runs
  MAX_CYCLES: z.coerce.number().default(0),
  DATA_DIR: z.string().default("data"),
  LPAGENT_API_URL: z.string().default("https://api.lpagent.io/open-api/v1"),
  LPAGENT_API_KEY: z.string().default(""),
  AGENT_ID: z.string().default("mr-bands"),
  AGENT_NAME: z.string().default("Mr Bands"),
  SERVE_PORT: z.coerce.number().default(0),
  SCREEN_INTERVAL_SEC: z.coerce.number().default(900),
  SCREEN_ACTIVE_HOURS: z.coerce.number().default(24),
  SCREEN_MAX_LIVE: z.coerce.number().default(1500),
  // the ranked board is shared across Meteora, Raydium and Orca; 400 keeps enough Meteora rows to trade
  SCREEN_MAX_POOLS: z.coerce.number().default(400),
  SCREEN_MIN_TVL_SOL: z.coerce.number().default(20),
  MAX_ACTIVE_POOLS: z.coerce.number().default(3),

  MAX_POSITION_SOL: z.coerce.number().default(0.5),
  MAX_TOTAL_EXPOSURE_SOL: z.coerce.number().default(1),
  GAS_RESERVE_SOL: z.coerce.number().default(0.1),
  STOP_LOSS_PCT: z.coerce.number().default(15),
  MAX_BIN_WIDTH: z.coerce.number().default(69),
  MAX_TX_PER_DAY: z.coerce.number().default(24),
  MIN_SECONDS_BETWEEN_ACTIONS: z.coerce.number().default(600),
  MAX_SLIPPAGE_PCT: z.coerce.number().default(1),
  MAX_PRICE_MOVE_PCT_PER_CYCLE: z.coerce.number().default(40),

  // ---- the engine (src/engine): exit ladder, breakers, collect and skim policies ----
  ENGINE_OUT_OF_RANGE_SEC: z.coerce.number().default(600),
  ENGINE_KNIFE_PCT: z.coerce.number().default(20),
  ENGINE_CIRCUIT_FLOOR_SOL: z.coerce.number().default(0.05),
  ENGINE_PORTFOLIO_FLOOR_SOL: z.coerce.number().default(0.15),
  ENGINE_COLLECT_MIN_SOL: z.coerce.number().default(0.005),
  ENGINE_COLLECT_FLOOR_SOL: z.coerce.number().default(0.001),
  ENGINE_COLLECT_MAX_PER_DAY: z.coerce.number().default(30),
  ENGINE_SKIM: z.string().default("false"),
  ENGINE_FLOAT_TARGET_SOL: z.coerce.number().default(1),
  TREASURY_ADDRESS: z.string().default(""),
  EXPECTED_WALLET: z.string().default(""),
  USDC_MINT: z.string().default("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
});

const raw = Raw.parse(env);

/** Engine settings (src/engine). Dormant by default: the skim is off until ENGINE_SKIM=true and a treasury is set. */
export interface EngineConfig {
  /** a band must sit out of range this long before the LLM may rebalance or close it (anti-churn) */
  outOfRangeSec: number;
  /** a drop larger than this over the trailing 30 min blocks opens in that pool */
  knifePct: number;
  /** circuit breaker: today's loss limit is max(this, 15% of working SOL) */
  circuitFloorSol: number;
  /** portfolio breaker: equity drawdown limit is max(this, 15% of the day's high-water equity) */
  portfolioFloorSol: number;
  /** claim when unclaimed fees on a band reach this many SOL-equivalent */
  collectMinSol: number;
  /** fees above this start the 2h pending clock */
  collectFloorSol: number;
  /** max fee claims per UTC day, counted from the ledger */
  collectMaxPerDay: number;
  /** only the literal "true" turns the treasury skim on */
  skim: boolean;
  /** wallet SOL kept as working float; only the excess above float + gas reserve is skimmable */
  floatTargetSol: number;
  /** skim destination; "" means unset (skim stays off) */
  treasuryAddress: string;
  /** when set, the loaded keypair must derive to this pubkey (live refuses, dry-run warns) */
  expectedWallet: string;
}

export const config = {
  rpcUrl: raw.RPC_URL,
  walletSecretKey: raw.WALLET_SECRET_KEY,
  anthropicApiKey: raw.ANTHROPIC_API_KEY,
  model: raw.MODEL,
  // Only the literal "false" disables dry-run. Typos keep you safe.
  dryRun: raw.DRY_RUN.trim().toLowerCase() !== "false",
  /** pools Mr Bands must always watch, on top of what the screener picks */
  pinnedPools: raw.POOL_ADDRESS.split(",").map((s) => s.trim()).filter(Boolean),
  /** after each screen, push a snapshot to Vercel (npm run web:deploy) */
  autoDeploy: raw.AUTO_DEPLOY.trim().toLowerCase() === "true",
  cycleIntervalSec: raw.CYCLE_INTERVAL_SEC,
  maxCycles: raw.MAX_CYCLES,
  dataDir: raw.DATA_DIR,
  lpagentApiUrl: raw.LPAGENT_API_URL,
  lpagentApiKey: raw.LPAGENT_API_KEY,
  agentId: raw.AGENT_ID,
  agentName: raw.AGENT_NAME,
  /** when > 0, `npm start` also serves the bands.finance API + site on this port */
  servePort: raw.SERVE_PORT,
  screen: {
    intervalSec: raw.SCREEN_INTERVAL_SEC,
    activeHours: raw.SCREEN_ACTIVE_HOURS,
    maxLive: raw.SCREEN_MAX_LIVE,
    maxPools: raw.SCREEN_MAX_POOLS,
    minTvlSol: raw.SCREEN_MIN_TVL_SOL,
  },
  maxActivePools: raw.MAX_ACTIVE_POOLS,
  /** the USDC mint: the second quote the desk trades (xStocks and most majors are USDC-quoted) */
  usdcMint: raw.USDC_MINT.trim(),
  engine: {
    outOfRangeSec: raw.ENGINE_OUT_OF_RANGE_SEC,
    knifePct: raw.ENGINE_KNIFE_PCT,
    circuitFloorSol: raw.ENGINE_CIRCUIT_FLOOR_SOL,
    portfolioFloorSol: raw.ENGINE_PORTFOLIO_FLOOR_SOL,
    collectMinSol: raw.ENGINE_COLLECT_MIN_SOL,
    collectFloorSol: raw.ENGINE_COLLECT_FLOOR_SOL,
    collectMaxPerDay: raw.ENGINE_COLLECT_MAX_PER_DAY,
    skim: raw.ENGINE_SKIM.trim().toLowerCase() === "true",
    floatTargetSol: raw.ENGINE_FLOAT_TARGET_SOL,
    treasuryAddress: raw.TREASURY_ADDRESS.trim(),
    expectedWallet: raw.EXPECTED_WALLET.trim(),
  } as EngineConfig,
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
