/**
 * Platform env, parsed on its own (ports the platform-side knobs of Meridian's agent/src/config.ts
 * plus the env reads scattered through credits.ts, spendGuards.ts, chatLimits.ts and httpGuards.ts).
 * Deliberately separate from src/config.ts: that file boots the trading loop and throws on a bad
 * wallet setup; this one must load in the API process and in tests with nothing but defaults.
 *
 * Parsed FRESH on every call. The values are read at use time (a chat turn, a rate-limit check)
 * rather than pinned at import, so CREDITS_ENFORCED or CHAT_MAX_TURNS_PER_DAY=0 can be flipped
 * in the environment and take effect on the next request, which is what a kill switch is for.
 * A mistyped number falls back to its default rather than removing a ceiling; zero is honoured.
 *
 * Every key is documented in .env.platform.example.
 */
import "dotenv/config";
import { z } from "zod";

/** Non-negative integer with a default; unparseable or negative input keeps the default. */
const int = (def: number) =>
  z.preprocess((v) => {
    if (v === undefined || v === null || v === "") return def;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
  }, z.number());

const Raw = z.object({
  BANDS_SESSION_SECRET: z.string().default(""),
  ANTHROPIC_API_KEY: z.string().default(""),
  USER_AGENT_MODEL: z.string().default("claude-sonnet-5"),
  USER_AGENT_MAX_TOKENS: int(1536),
  CHAT_MAX_TURNS_PER_DAY: int(50_000),
  CHAT_MAX_TURNS_PER_WALLET_PER_DAY: int(200),
  CHAT_CONCURRENCY: int(40),
  CHAT_RATE_BURST: int(5),
  CHAT_RATE_REFILL_MS: int(3000),
  CHAT_ACQUIRE_TIMEOUT_MS: int(15_000),
  STREAM_IDLE_TIMEOUT_MS: int(120_000),
  GLOBAL_RATE_PER_MIN: int(1800),
  AUTH_RATE_PER_MIN: int(30),
  CREDITS_ENFORCED: z.string().default("false"),
  CREDITS_FREE_MESSAGES: int(50),
  PLATFORM_OPERATOR_TOKEN: z.string().default(""),
});

export interface PlatformEnv {
  sessionSecret: string;
  anthropicApiKey: string;
  userAgentModel: string;
  userAgentMaxTokens: number;
  chatMaxTurnsPerDay: number;
  chatMaxTurnsPerWalletPerDay: number;
  chatConcurrency: number;
  chatRateBurst: number;
  chatRateRefillMs: number;
  chatAcquireTimeoutMs: number;
  streamIdleTimeoutMs: number;
  globalRatePerMin: number;
  authRatePerMin: number;
  /** only the literal "true" (or "on") charges credits; anything else meters without billing */
  creditsEnforced: boolean;
  creditsFreeMessages: number;
  operatorToken: string;
}

export function platformEnv(): PlatformEnv {
  // dotenv sets `KEY=` to an empty string; treat those as unset so defaults apply.
  const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const raw = Raw.parse(env);
  const enforced = raw.CREDITS_ENFORCED.trim().toLowerCase();
  return {
    sessionSecret: raw.BANDS_SESSION_SECRET,
    anthropicApiKey: raw.ANTHROPIC_API_KEY.trim(),
    userAgentModel: raw.USER_AGENT_MODEL.trim(),
    userAgentMaxTokens: Math.max(256, raw.USER_AGENT_MAX_TOKENS),
    chatMaxTurnsPerDay: raw.CHAT_MAX_TURNS_PER_DAY,
    chatMaxTurnsPerWalletPerDay: raw.CHAT_MAX_TURNS_PER_WALLET_PER_DAY,
    chatConcurrency: Math.max(1, raw.CHAT_CONCURRENCY),
    chatRateBurst: Math.max(1, raw.CHAT_RATE_BURST),
    chatRateRefillMs: Math.max(100, raw.CHAT_RATE_REFILL_MS),
    chatAcquireTimeoutMs: raw.CHAT_ACQUIRE_TIMEOUT_MS,
    streamIdleTimeoutMs: Math.max(1000, raw.STREAM_IDLE_TIMEOUT_MS),
    globalRatePerMin: Math.max(1, raw.GLOBAL_RATE_PER_MIN),
    authRatePerMin: Math.max(1, raw.AUTH_RATE_PER_MIN),
    creditsEnforced: enforced === "true" || enforced === "on",
    creditsFreeMessages: raw.CREDITS_FREE_MESSAGES,
    operatorToken: raw.PLATFORM_OPERATOR_TOKEN.trim(),
  };
}
