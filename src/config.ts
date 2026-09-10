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
  DATA_DIR: z.string().default("data"),
  LPAGENT_API_URL: z.string().default("https://api.lpagent.io/open-api/v1"),
  LPAGENT_API_KEY: z.string().default(""),
  AGENT_ID: z.string().default("mr-bands"),
  AGENT_NAME: z.string().default("Mr Bands"),
  SERVE_PORT: z.coerce.number().default(0),
  SCREEN_INTERVAL_SEC: z.coerce.number().default(900),
  SCREEN_ACTIVE_HOURS: z.coerce.number().default(24),
  SCREEN_MAX_LIVE: z.coerce.number().default(1500),
  SCREEN_MAX_POOLS: z.coerce.number().default(300),
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
});

const raw = Raw.parse(env);

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
