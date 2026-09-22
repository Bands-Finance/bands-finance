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
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config, riskLimits } from "../config";
import { buildSystemPrompt } from "./persona";
import { policyDecide, type PolicyBranch, type PolicyExtras, type PolicyResult } from "./policy";
import { Decision, DecisionSchema, holdDecision } from "./schema";
import { formatObservation, Observation } from "./observation";
import { abandonDecisionSession, askForDecision, extractDecision, openHermitAvailable, OpenHermitError, openHermitSettings } from "./openhermit";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface DecideResult {
  decision: Decision;
  /** "llm" when the model answered; "policy" when the desk policy proposed (no key, the call failed, the day's model budget is spent); "screen" when the desk policy's hold needed no model (the model was not asked); "fallback" when we substituted a bare HOLD; "engine" when a directive replaced the call */
  source: "llm" | "fallback" | "engine" | "proposal" | "policy" | "screen";
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

/** Whether a model will be asked at all: the chosen backend has what it needs. The desk's boot banner reads this (src/index.ts); the talk layer asks hasAnthropicCredentials, being Anthropic's alone. */
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

/**
 * AN OUTSIDE PROPOSAL MEETS THE ENTRY RULES TOO. An approved proposal (src/platform/proposals.ts) is asked of the
 * desk policy exactly as a model's move is (adviseWithPolicy, always on: MODEL_ADVISES does not reach it), and on a
 * live book it needs POLICY_LIVE like any open made without the model. What the policy may not do is swap the ask:
 * a HOLD, another action, another band or another side is a REFUSAL, returned as a desk-written HOLD with the
 * reason, and the substitute never runs under the proposal's id. Where the policy agrees to open, the band is laid
 * the policy's way (its width, its geometry) at no more than the proposal asked for: the policy's size scaled down
 * to the proposal's amounts, never up. PURE.
 */
export function adviseProposal(
  proposed: Decision,
  policy: PolicyResult,
  opts: { id: string; live: boolean; policyLive: boolean },
): { ok: true; decision: Decision; note: string } | { ok: false; decision: Decision; reason: string } {
  const refuse = (reason: string) => ({
    ok: false as const,
    reason,
    decision: holdDecision(`Outside proposal ${opts.id} refused: ${reason}. ${proposed.reasoning}`.slice(0, 1900), "Outside proposal refused. Holding."),
  });
  if (proposed.action === "OPEN_POSITION") {
    if (!proposed.open) return refuse("an open with no band");
    if (opts.live && !opts.policyLive) return refuse("this book is live and POLICY_LIVE is not set, so nothing opens without the model");
    const advised = adviseWithPolicy(proposed, policy).decision;
    const a = advised.open;
    if (advised.action !== "OPEN_POSITION" || advised.positionAddress !== null || !a) return refuse(`the desk policy would not open here (${policy.branch}): ${policy.reason}`);
    if (a.side !== proposed.open.side) return refuse(`the desk policy would open a ${a.side} band here, not the ${proposed.open.side} band asked for (${policy.branch}): ${policy.reason}`);
    // never bigger than asked: one factor for both legs keeps the policy's mix of quote and token
    const factors = [1];
    if (a.amountSol > 0) factors.push(proposed.open.amountSol / a.amountSol);
    if (a.amountToken > 0) factors.push(proposed.open.amountToken / a.amountToken);
    const k = Math.max(0, Math.min(...factors));
    if (!(k > 0)) return refuse(`the desk policy's band needs a leg the proposal did not fund (${policy.branch}): ${policy.reason}`);
    const open = k < 1 ? { ...a, amountSol: a.amountSol * k, amountToken: a.amountToken * k, ...(a.acquireToken ? { acquireToken: a.acquireToken * k } : {}) } : a;
    return {
      ok: true,
      decision: { ...advised, open },
      note: `proposal ${opts.id} laid by the desk policy (${policy.branch})${k < 1 ? `, scaled to the ${r4(proposed.open.amountSol)} quote asked for` : ""}: ${policy.reason}`,
    };
  }
  if (proposed.action === "CLOSE_POSITION") {
    const advised = adviseWithPolicy(proposed, policy).decision;
    if (advised.action !== "CLOSE_POSITION" || advised.positionAddress !== proposed.positionAddress) return refuse(`the desk policy keeps that band (${policy.branch}): ${policy.reason}`);
    return { ok: true, decision: advised, note: `proposal ${opts.id}: the desk policy has no objection to the close` };
  }
  return refuse(`a proposal may only open or close a band, not ${proposed.action}`);
}

const r4 = (n: number): string => String(Math.round(n * 1e4) / 1e4);

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

/* ---------------------------------------------------------------------------------------------
 * THE SCREEN AND THE CAP. The model proposes, the guards decide; these two only make the model be
 * asked LESS. Neither changes what the policy or the guards decide, and every answer the model does
 * give still walks acceptModelDecision (the advice) and then the guards.
 *
 * THE SCREEN. Most cycles need no judgement: the band is in range and earning, or a gate refuses any
 * open. When the desk policy's own answer is a HOLD from one of SCREENED_BRANCHES, that hold is the
 * cycle's decision, journalled with source "screen" and model "desk-policy" so nothing downstream (his
 * X loop, his site, /api/status) calls it a model decision. The gated holds are the policy's hard
 * refusals: "gated" (kill switch, breakers, bench, regime, knife, basis and session, the action cap,
 * the cooldown, the price-move limit, a full book), "no-size" (no room in the budget for a minimum
 * seat), "flagged" (a pool flagged thin, dumping, new or wild) and "not-worth" (under a floor: volume,
 * score, seat yield, payback). None of those has a band to close, and a model OPEN there is refused by
 * adviseWithPolicy anyway, so asking would only cost money. Every other branch (an open, a close, a
 * rebalance, the waits, "moved", "lively", "hot-hold", the ask exit's branches) reaches the model as
 * before, and so does a policy that throws: a screen that cannot read the policy screens nothing.
 *
 * THE CAP. MODEL_CALLS_PER_DAY (default 200, never above 500) model calls a UTC day, counted in
 * DATA_DIR/model-budget.json before each call, so a restart cannot reset it and a call that times out
 * still counts. Past the cap the desk policy proposes with the note "model budget spent for the day".
 * ------------------------------------------------------------------------------------------- */

/** The policy branches whose HOLD is answered without the model: in range (the band is earning), and the gated holds (a gate, the budget or a floor refuses any open). */
export const SCREENED_BRANCHES: readonly PolicyBranch[] = ["in-range", "gated", "no-size", "flagged", "not-worth"];

const SCREENED_WHY: Partial<Record<PolicyBranch, string>> = {
  "in-range": "in-range hold, the band is earning",
  gated: "gated hold, a gate refuses any open",
  "no-size": "gated hold, no room for a minimum seat",
  flagged: "gated hold, the pool is flagged",
  "not-worth": "gated hold, under the desk's floor",
};

/** The screened answer, or null when this cycle goes to the model. PURE but for the policy's clock. */
export function screenDecision(observation: Observation, opts: DecideOptions = {}): DecideResult | null {
  let r: PolicyResult;
  try {
    r = policyDecide(observation, { limits: riskLimits, hot: opts.hot, openCostSol: opts.openCostSol, grow: opts.grow, askExit: opts.askExit });
  } catch {
    return null;
  }
  if (r.decision.action !== "HOLD" || !SCREENED_BRANCHES.includes(r.branch)) return null;
  return { decision: r.decision, source: "screen", model: "desk-policy", note: `Screened (${r.branch}: ${SCREENED_WHY[r.branch]}): ${r.reason}. The model was not asked.` };
}

export const MODEL_CALLS_DEFAULT = 200;
export const MODEL_CALLS_CEILING = 500;

/** The day's cap on model calls. A whole number from 0 up to the ceiling applies; above the ceiling is the ceiling; anything else is the default. */
export function modelCallCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.MODEL_CALLS_PER_DAY ?? "").trim();
  if (!/^\d+$/.test(raw)) return MODEL_CALLS_DEFAULT;
  return Math.min(Number(raw), MODEL_CALLS_CEILING);
}

export const modelBudgetFile = (): string => path.join(path.resolve(process.cwd(), config.dataDir), "model-budget.json");

export interface ModelBudget {
  /** the UTC day, YYYY-MM-DD */
  day: string;
  used: number;
  cap: number;
}

const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** The day's count as the file holds it; a new UTC day starts at 0. Null when the file is there and unreadable. */
function readUsed(file: string, day: string): number | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null;
  }
  try {
    const j = JSON.parse(text) as { day?: unknown; used?: unknown };
    if (typeof j.day !== "string" || typeof j.used !== "number" || !Number.isFinite(j.used) || j.used < 0) return null;
    return j.day === day ? j.used : 0;
  } catch {
    return null;
  }
}

function writeUsed(file: string, day: string, used: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ day, used }) + "\n");
  fs.renameSync(tmp, file);
}

/** What /api/status reports: the day's model calls and the cap. Read-only. An unreadable file reads as the cap spent, as spendModelCall treats it. */
export function modelBudget(now: number = Date.now(), env: NodeJS.ProcessEnv = process.env, file: string = modelBudgetFile()): ModelBudget {
  const day = utcDay(now);
  const cap = modelCallCap(env);
  return { day, used: readUsed(file, day) ?? cap, cap };
}

/**
 * Spend one model call from the day's budget, written to disk BEFORE the call is made. Returns the
 * budget after the spend, or ok false (nothing spent) when the cap is reached. Fails closed: a file that
 * cannot be read is taken as the day spent (and written so, so the next day starts clean), and a count
 * that cannot be written is a call not made.
 */
export function spendModelCall(now: number = Date.now(), env: NodeJS.ProcessEnv = process.env, file: string = modelBudgetFile()): { ok: boolean; budget: ModelBudget; why?: string } {
  const day = utcDay(now);
  const cap = modelCallCap(env);
  const used = readUsed(file, day);
  if (used === null) {
    try {
      writeUsed(file, day, cap);
    } catch {
      /* the refusal below stands either way */
    }
    return { ok: false, budget: { day, used: cap, cap }, why: "the budget file was unreadable, taken as spent" };
  }
  if (used >= cap) return { ok: false, budget: { day, used, cap } };
  try {
    writeUsed(file, day, used + 1);
  } catch (err) {
    return { ok: false, budget: { day, used, cap }, why: `the count could not be written (${(err as Error).message})` };
  }
  return { ok: true, budget: { day, used: used + 1, cap } };
}

/** The cap: null when the call is paid for and may be made, else the desk policy's proposal with the note. */
function budgetRefusal(observation: Observation, opts: DecideOptions): DecideResult | null {
  const spend = spendModelCall();
  if (spend.ok) return null;
  const b = spend.budget;
  return policyDecideResult(observation, `model budget spent for the day (${b.used}/${b.cap} calls, UTC ${b.day}${spend.why ? `; ${spend.why}` : ""}).`, opts);
}

const NO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * The OpenHermit backend: post the observation to the agent's session and read the Decision JSON out of
 * his reply. Every failure is named in the note and the desk policy proposes; the client's own deadline
 * (OPENHERMIT_TIMEOUT_MS) bounds the wait, so a cycle never hangs on the gateway. Never throws.
 */
/**
 * The cycle a dead gateway has already cost us a wait in. The desk decides its pools one after another,
 * so without this a gateway that is down but accepting (or simply slow) charges OPENHERMIT_TIMEOUT_MS
 * per pool - six pools, six minutes, every pass. One missed deadline is enough to know; the rest of that
 * cycle goes to the policy, and the next cycle tries the gateway again.
 */
let gatewayDownInCycle: number | null = null;

async function decideWithOpenHermit(observation: Observation, opts: DecideOptions): Promise<DecideResult> {
  const settings = openHermitSettings();
  const model = `openhermit:${settings.agentId}`;
  if (!settings.token) return policyDecideResult(observation, "DECIDER=openhermit but OPENHERMIT_TOKEN is not set.", opts);
  const screened = screenDecision(observation, opts);
  if (screened) return screened;
  if (gatewayDownInCycle === observation.cycle) {
    return policyAfterModel(observation, "OpenHermit did not answer an earlier pool this cycle; not asked again.", opts, NO_USAGE, model);
  }
  const refused = budgetRefusal(observation, opts);
  if (refused) return refused;
  try {
    const reply = await askForDecision(observation, { settings });
    const found = extractDecision(reply.text, { cycle: observation.cycle });
    if (!found.decision) {
      // a late answer to an older observation: the session is one turn behind, so the client starts a new one
      if (found.stale) abandonDecisionSession(observation);
      return policyAfterModel(observation, `OpenHermit reply was not a decision (${found.error}).`, opts, NO_USAGE, model);
    }
    return acceptModelDecision(found.decision, observation, opts, reply.model ?? model, NO_USAGE);
  } catch (err) {
    if (err instanceof OpenHermitError) {
      if (err.kind === "timeout" || err.kind === "unreachable") gatewayDownInCycle = observation.cycle;
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
  const notAsked = screenDecision(observation, opts) ?? budgetRefusal(observation, opts);
  if (notAsked) return notAsked;
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
