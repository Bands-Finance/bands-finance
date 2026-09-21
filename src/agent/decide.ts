/**
 * Ask Mr Bands what to do. The LLM answers when credentials exist; without them, or when the
 * call throws or the model refuses, the desk policy (src/agent/policy.ts) proposes instead, with
 * source "policy" and a note saying why. A bare HOLD ("fallback") remains only for the case where
 * the policy itself throws. Never throws.
 *
 * Two model backends: DECIDER=anthropic asks Claude directly (structured output, the persona as the
 * system prompt); DECIDER=openhermit posts the observation to Mr Bands' agent on the OpenHermit
 * gateway (src/agent/openhermit.ts), where the persona lives in his instructions. DECIDER=policy
 * asks nobody. Unset, the choice is what it always was: anthropic with a key, else policy. Whatever
 * answers, the reply walks the same road: exitAsk dropped, the desk policy advises on any move of
 * money, the guards decide.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config, riskLimits } from "../config";
import { buildSystemPrompt } from "./persona";
import { policyDecide, type PolicyExtras, type PolicyResult } from "./policy";
import { Decision, DecisionSchema, holdDecision } from "./schema";
import { formatObservation, Observation } from "./observation";
import { askForDecision, extractDecision, openHermitAvailable, OpenHermitError, openHermitSettings } from "./openhermit";

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
  /** whether a held straddle may re-lay bigger this cycle (one money move a pass); defaults to allowed */
  grow?: PolicyExtras["grow"];
  /** the ask bands on the book and the ask exit's settings, for the policy (src/engine/askExit.ts) */
  askExit?: PolicyExtras["askExit"];
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

/** A key in the config or an auth token in the environment; without either Claude is not asked directly. */
export function hasAnthropicCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(config.anthropicApiKey || (env.ANTHROPIC_AUTH_TOKEN && env.ANTHROPIC_AUTH_TOKEN.trim()));
}

export type Decider = "anthropic" | "openhermit" | "policy";

/**
 * Who is asked each cycle. DECIDER names a backend; unset (or an unknown word) keeps the old rule,
 * anthropic when there are credentials for it and the desk policy otherwise, so nobody who has not
 * set it sees a change. Read at call time like the desk's other toggles.
 */
export function deciderOf(env: NodeJS.ProcessEnv = process.env): Decider {
  const v = (env.DECIDER ?? "").trim().toLowerCase();
  if (v === "anthropic" || v === "openhermit" || v === "policy") return v;
  return hasAnthropicCredentials(env) ? "anthropic" : "policy";
}

/** Whether a model will be asked at all: the chosen backend has what it needs. The desk's boot log and the talk layer read this. */
export function hasLlmCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  const decider = deciderOf(env);
  if (decider === "openhermit") return openHermitAvailable(env);
  if (decider === "policy") return false;
  return hasAnthropicCredentials(env);
}

function fallback(note: string): DecideResult {
  return { decision: holdDecision(`${note} Holding.`, "Can't think straight. Holding."), source: "fallback", model: config.model, note };
}

/**
 * Whether the desk policy may open or rebalance on a LIVE book (DRY_RUN=false). Only the literal
 * "true" says yes. Without it, a live process that has no model (no key, an expired key, an API
 * outage) holds instead of trading on the policy: the engine's own exits (stop, flatten, expire)
 * do not pass through here and keep running either way.
 */
export function policyMayTradeLive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.POLICY_LIVE === "true";
}

/** The desk policy's proposal, as the decision the model would otherwise have made. */
export function policyDecideResult(observation: Observation, note: string, opts: DecideOptions = {}, dryRun: boolean = config.dryRun, env: NodeJS.ProcessEnv = process.env): DecideResult {
  try {
    const r = policyDecide(observation, { limits: riskLimits, hot: opts.hot, openCostSol: opts.openCostSol, grow: opts.grow, askExit: opts.askExit });
    const trades = r.decision.action === "OPEN_POSITION" || r.decision.action === "REBALANCE";
    if (trades && !dryRun && !policyMayTradeLive(env)) {
      const verb = r.decision.action === "OPEN_POSITION" ? "open" : "rebalance";
      const held = holdDecision(
        `${note} The desk policy would ${verb} here (${r.reason}), but this book is live and POLICY_LIVE is not set: without the model, only the engine's exits run. Holding.`,
        "No model, no new bands.",
      );
      return { decision: held, source: "policy", model: "desk-policy", note: `${note} Desk policy (${r.branch}) withheld on a live book without POLICY_LIVE: ${r.reason}.` };
    }
    return { decision: r.decision, source: "policy", model: "desk-policy", note: `${note} Desk policy (${r.branch}): ${r.reason}.` };
  } catch (err) {
    return fallback(`${note} Desk policy failed: ${(err as Error).message}.`);
  }
}

/**
 * THE MODEL ADVISES, THE ENTRY RULES BIND. The rules learned on the live desk (the scout reads a pool before
 * it is seated, an hour of coverage, the swap-impact cap, the width rule, the grow limits) live in the desk
 * policy, and the guards enforce none of them. So when the model wants to put money to work (OPEN or
 * REBALANCE), the policy is asked too: where the policy would not, the model's proposal is a HOLD that says
 * so; where it would, the policy's own action and sizing are used with the model's words. The model stays
 * free to hold, to claim and to close, which the guards judge as before. MODEL_ADVISES=false turns this off.
 * PURE.
 */
export function adviseWithPolicy(model: Decision, policy: PolicyResult): { decision: Decision; note: string | null } {
  // an ASK band (src/engine/askExit.ts) is worked off by its own rules: the model may not end the chain with a sale
  // while the policy says it is working, waiting or following the price (the stop and the hold are the engine's)
  if (model.action === "CLOSE_POSITION" && policy.branch.startsWith("ask-") && policy.decision.action !== "CLOSE_POSITION" && policy.decision.positionAddress === model.positionAddress) {
    return {
      decision: { ...policy.decision, reasoning: `${model.reasoning} The ask band is worked off by the desk's rules: ${policy.reason}.`.slice(0, 1900) },
      note: `model CLOSE of an ask band replaced by the desk policy's ${policy.decision.action} (${policy.branch}): ${policy.reason}`,
    };
  }
  const wantsIn = model.action === "OPEN_POSITION" || model.action === "REBALANCE";
  if (!wantsIn) return { decision: model, note: null };
  const p = policy.decision;
  const policyIn = (p.action === "OPEN_POSITION" || p.action === "REBALANCE") && !!p.open;
  if (!policyIn) {
    return {
      decision: holdDecision(
        `The model proposed ${model.action} (${model.headline}) and the desk's entry rules do not allow it here: ${policy.reason} (${policy.branch}). ${model.reasoning}`.slice(0, 1900),
        "Model wanted in. The entry rules say no. Holding.",
      ),
      note: `model ${model.action} refused by the desk policy's entry rules (${policy.branch}): ${policy.reason}`,
    };
  }
  return {
    decision: { ...model, action: p.action, open: p.open, positionAddress: p.positionAddress, liquidate: p.liquidate, exitAsk: p.exitAsk, reasoning: `${model.reasoning} Sized by the desk policy: ${policy.reason}.`.slice(0, 1900) },
    note: `model ${model.action} taken with the desk policy's action and sizing (${policy.branch}): ${policy.reason}`,
  };
}

export const modelAdvises = (env: NodeJS.ProcessEnv = process.env): boolean => (env.MODEL_ADVISES ?? "").trim().toLowerCase() !== "false";

/** A policy result after the model was asked and did not answer usably: the model id goes in the note, the author stays the policy. */
function policyAfterModel(observation: Observation, note: string, opts: DecideOptions, usage: LlmUsage, model: string): DecideResult {
  const r = policyDecideResult(observation, note, opts);
  return { ...r, usage, note: `${r.note ?? note} (${model} was asked.)` };
}

/**
 * A decision the model gave, made the desk's: the ask exit is the desk's to mark, never the model's (a model
 * REBALANCE marked exitAsk would skip the cooldown, the size limits and every open gate in src/risk/guards.ts),
 * so the flag is dropped and the desk sets it where it belongs; then the policy is asked when the model wants
 * money to work, and when it wants to close an ASK band (worked off by the desk's rules). Both backends end here.
 */
function acceptModelDecision(raw: Decision, observation: Observation, opts: DecideOptions, model: string, usage: LlmUsage): DecideResult {
  const parsed: Decision = raw.exitAsk ? { ...raw, exitAsk: undefined } : raw;
  const closesAsk = parsed.action === "CLOSE_POSITION" && !!parsed.positionAddress && !!opts.askExit?.bands[parsed.positionAddress];
  if (modelAdvises() && (parsed.action === "OPEN_POSITION" || parsed.action === "REBALANCE" || closesAsk)) {
    const advised = adviseWithPolicy(parsed, policyDecide(observation, { limits: riskLimits, hot: opts.hot, openCostSol: opts.openCostSol, grow: opts.grow, askExit: opts.askExit }));
    return { decision: advised.decision, source: "llm", model, usage, note: advised.note ?? undefined };
  }
  return { decision: parsed, source: "llm", model, usage };
}

const NO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * The OpenHermit backend: post the observation to the agent's session and read the Decision JSON out of
 * his reply. Every failure is named in the note and the desk policy proposes; the client's own deadline
 * (OPENHERMIT_TIMEOUT_MS) bounds the wait, so a cycle never hangs on the gateway. Never throws.
 */
async function decideWithOpenHermit(observation: Observation, opts: DecideOptions): Promise<DecideResult> {
  const settings = openHermitSettings();
  const model = `openhermit:${settings.agentId}`;
  if (!settings.token) return policyDecideResult(observation, "DECIDER=openhermit but OPENHERMIT_TOKEN is not set.", opts);
  try {
    const reply = await askForDecision(observation, { settings });
    const found = extractDecision(reply.text);
    if (!found.decision) return policyAfterModel(observation, `OpenHermit reply was not a decision (${found.error}).`, opts, NO_USAGE, model);
    return acceptModelDecision(found.decision, observation, opts, reply.model ?? model, NO_USAGE);
  } catch (err) {
    if (err instanceof OpenHermitError) {
      const why = err.message.replace(/\.$/, "");
      const note =
        err.kind === "unreachable" ? `OpenHermit unreachable (${why}).`
        : err.kind === "unauthorized" ? `OpenHermit refused the token (${err.status ?? "auth"}): check OPENHERMIT_TOKEN.`
        : err.kind === "timeout" ? `OpenHermit timed out (${why}).`
        : err.kind === "not-found" ? `OpenHermit has no agent or session for the desk (${why}).`
        : err.kind === "bad-reply" ? `OpenHermit reply was not a decision (${why}).`
        : `OpenHermit gateway error (${why}).`;
      return policyAfterModel(observation, note, opts, NO_USAGE, model);
    }
    return policyAfterModel(observation, `OpenHermit call failed: ${(err as Error).message}.`, opts, NO_USAGE, model);
  }
}

/** Ask Mr Bands what to do. Never throws: without a key or on any failure the desk policy proposes. */
export async function decide(observation: Observation, opts: DecideOptions = {}): Promise<DecideResult> {
  const decider = deciderOf();
  if (decider === "openhermit") return decideWithOpenHermit(observation, opts);
  if (decider === "policy") return policyDecideResult(observation, hasAnthropicCredentials() ? "DECIDER=policy: the model is not asked." : "No ANTHROPIC_API_KEY configured.", opts);
  if (!hasAnthropicCredentials()) return policyDecideResult(observation, "No ANTHROPIC_API_KEY configured.", opts);
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
      return policyAfterModel(observation, `Model declined to answer (${why}).`, opts, usage, response.model);
    }
    if (response.stop_reason === "max_tokens") {
      return policyAfterModel(observation, "Model output was truncated.", opts, usage, response.model);
    }
    const raw = response.parsed_output;
    if (!raw) {
      return policyAfterModel(observation, "Model output did not match the decision schema.", opts, usage, response.model);
    }
    return acceptModelDecision(raw, observation, opts, response.model, usage);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return policyDecideResult(observation, "Anthropic auth failed: check ANTHROPIC_API_KEY.", opts);
    if (err instanceof Anthropic.RateLimitError) return policyDecideResult(observation, "Anthropic rate limit hit.", opts);
    if (err instanceof Anthropic.APIConnectionError) return policyDecideResult(observation, "Could not reach the Anthropic API.", opts);
    if (err instanceof Anthropic.APIError) return policyDecideResult(observation, `Anthropic API error ${err.status}: ${err.message}`, opts);
    return policyDecideResult(observation, `LLM call failed: ${(err as Error).message}`, opts);
  }
}
