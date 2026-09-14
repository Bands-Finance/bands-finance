/**
 * Ask Mr Bands what to do. The LLM answers when credentials exist; without them, or when the
 * call throws or the model refuses, the desk policy (src/agent/policy.ts) proposes instead, with
 * source "policy" and a note saying why. A bare HOLD ("fallback") remains only for the case where
 * the policy itself throws. Never throws.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config, riskLimits } from "../config";
import { buildSystemPrompt } from "./persona";
import { policyDecide, type PolicyExtras } from "./policy";
import { Decision, DecisionSchema, holdDecision } from "./schema";
import { formatObservation, Observation } from "./observation";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface DecideResult {
  decision: Decision;
  /** "llm" when the model answered; "policy" when the desk policy proposed (no key, or the call failed); "fallback" when we substituted a bare HOLD; "engine" when a directive replaced the call */
  source: "llm" | "fallback" | "engine" | "proposal" | "policy";
  model: string;
  usage?: LlmUsage;
  note?: string;
}

export interface DecideOptions {
  /** the hot list, for the policy (pools off the screen carry no hot rows in their observation) */
  hot?: PolicyExtras["hot"];
  /** the venue's open cost in SOL, for the policy's sizing (defaults to the Meteora estimate) */
  openCostSol?: number;
}

/** An engine directive stands in for the model this cycle: the LLM is not called. */
export function engineDecideResult(decision: Decision, note: string): DecideResult {
  return { decision, source: "engine", model: "engine", note };
}

/** An approved outside proposal (src/platform/proposals.ts) standing in for the LLM this cycle. The guards still decide. */
export function proposalDecideResult(decision: Decision, note: string): DecideResult {
  return { decision, source: "proposal", model: "proposal", note };
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  // Credentials resolve from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
  if (!client) client = new Anthropic(config.anthropicApiKey ? { apiKey: config.anthropicApiKey } : {});
  return client;
}

/** A key in the config or an auth token in the environment; without either the model is not asked. */
export function hasLlmCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(config.anthropicApiKey || (env.ANTHROPIC_AUTH_TOKEN && env.ANTHROPIC_AUTH_TOKEN.trim()));
}

function fallback(note: string): DecideResult {
  return { decision: holdDecision(`${note} Holding.`, "Can't think straight. Holding."), source: "fallback", model: config.model, note };
}

/** The desk policy's proposal, as the decision the model would otherwise have made. */
export function policyDecideResult(observation: Observation, note: string, opts: DecideOptions = {}): DecideResult {
  try {
    const r = policyDecide(observation, { limits: riskLimits, hot: opts.hot, openCostSol: opts.openCostSol });
    return { decision: r.decision, source: "policy", model: "desk-policy", note: `${note} Desk policy (${r.branch}): ${r.reason}.` };
  } catch (err) {
    return fallback(`${note} Desk policy failed: ${(err as Error).message}.`);
  }
}

/** Ask Mr Bands what to do. Never throws: without a key or on any failure the desk policy proposes. */
export async function decide(observation: Observation, opts: DecideOptions = {}): Promise<DecideResult> {
  if (!hasLlmCredentials()) return policyDecideResult(observation, "No ANTHROPIC_API_KEY configured.", opts);
  try {
    const response = await getClient().messages.parse({
      model: config.model,
      max_tokens: 16000,
      system: [
        {
          type: "text",
          text: buildSystemPrompt(riskLimits, observation.poolLabel),
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: formatObservation(observation) }],
      output_config: { format: zodOutputFormat(DecisionSchema) },
    });

    const usage: LlmUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    };

    if (response.stop_reason === "refusal") {
      const why = response.stop_details?.explanation ?? "no explanation";
      return { ...policyDecideResult(observation, `Model declined to answer (${why}).`, opts), usage, model: response.model };
    }
    if (response.stop_reason === "max_tokens") {
      return { ...policyDecideResult(observation, "Model output was truncated.", opts), usage, model: response.model };
    }
    const parsed = response.parsed_output;
    if (!parsed) {
      return { ...policyDecideResult(observation, "Model output did not match the decision schema.", opts), usage, model: response.model };
    }
    return { decision: parsed, source: "llm", model: response.model, usage };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return policyDecideResult(observation, "Anthropic auth failed: check ANTHROPIC_API_KEY.", opts);
    if (err instanceof Anthropic.RateLimitError) return policyDecideResult(observation, "Anthropic rate limit hit.", opts);
    if (err instanceof Anthropic.APIConnectionError) return policyDecideResult(observation, "Could not reach the Anthropic API.", opts);
    if (err instanceof Anthropic.APIError) return policyDecideResult(observation, `Anthropic API error ${err.status}: ${err.message}`, opts);
    return policyDecideResult(observation, `LLM call failed: ${(err as Error).message}`, opts);
  }
}
