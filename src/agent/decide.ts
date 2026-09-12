import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config, riskLimits } from "../config";
import { buildSystemPrompt } from "./persona";
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
  /** "llm" when the model answered; "fallback" when we substituted a HOLD; "engine" when a directive replaced the call */
  source: "llm" | "fallback" | "engine" | "proposal";
  model: string;
  usage?: LlmUsage;
  note?: string;
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

function fallback(note: string): DecideResult {
  return { decision: holdDecision(`${note} Holding.`, "Can't think straight. Holding."), source: "fallback", model: config.model, note };
}

/** Ask Mr Bands what to do. Never throws: any failure becomes a HOLD with a note. */
export async function decide(observation: Observation): Promise<DecideResult> {
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
      return { ...fallback(`Model declined to answer (${why}).`), usage, model: response.model };
    }
    if (response.stop_reason === "max_tokens") {
      return { ...fallback("Model output was truncated."), usage, model: response.model };
    }
    const parsed = response.parsed_output;
    if (!parsed) {
      return { ...fallback("Model output did not match the decision schema."), usage, model: response.model };
    }
    return { decision: parsed, source: "llm", model: response.model, usage };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return fallback("Anthropic auth failed: check ANTHROPIC_API_KEY.");
    if (err instanceof Anthropic.RateLimitError) return fallback("Anthropic rate limit hit.");
    if (err instanceof Anthropic.APIConnectionError) return fallback("Could not reach the Anthropic API.");
    if (err instanceof Anthropic.APIError) return fallback(`Anthropic API error ${err.status}: ${err.message}`);
    return fallback(`LLM call failed: ${(err as Error).message}`);
  }
}
