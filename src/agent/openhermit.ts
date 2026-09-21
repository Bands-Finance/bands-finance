/**
 * Mr Bands the AGENT lives on OpenHermit; the desk stays the desk. This is the desk's side of that
 * split: a small client for the OpenHermit gateway (docs/transport-protocol.md in the OpenHermit repo)
 * that posts one observation to the agent's session for a pool and waits for his answer. His persona
 * is in the agent's instructions on the gateway, put there at provisioning, so every message carries
 * only the observation and a two-line instruction to answer with the Decision JSON alone. His hands
 * (the desk's own MCP server) are registered on the gateway, not here.
 *
 * One session per desk mode and pool ("desk:<mode>:<pool>"): the gateway keeps the turn history, so he
 * sees what he said about the pool last cycle, and the paper desk and the live desk (one agent answers
 * both) never read each other's. A session is opened once per process (POST /sessions reopens an
 * existing one) and remembered in memory; a 404 on a post (the gateway restarted and forgot it) opens
 * it again. askSession is the transport on its own, for the CLI's `ask` and anything else that wants
 * to put one message in front of him without pretending to be the desk.
 *
 * Nothing here decides anything. The reply is parsed against DecisionSchema and handed to decide(),
 * which runs the same advice-and-guards path an Anthropic reply takes; anything unusable throws a
 * typed OpenHermitError and decide() falls back to the desk policy. The whole exchange (open + post)
 * shares one deadline, OPENHERMIT_TIMEOUT_MS, so a cycle can never hang on the gateway.
 */
import { Decision, DecisionSchema } from "./schema";
import { formatObservation, Observation } from "./observation";

export interface OpenHermitSettings {
  /** the gateway's base URL (OPENHERMIT_GATEWAY_URL, default http://127.0.0.1:4000) */
  gatewayUrl: string;
  /** the agent's id on the gateway (OPENHERMIT_AGENT_ID, default mr-bands) */
  agentId: string;
  /** the bearer the desk posts with (OPENHERMIT_TOKEN, the gateway's admin token); empty = the backend is unavailable */
  token: string;
  /** the deadline for one ask, open and post together (OPENHERMIT_TIMEOUT_MS, default 60000) */
  timeoutMs: number;
}

// The deadline is per POOL, and the desk decides its pools one after another: six pools at 120s is a
// twelve-minute cycle on a desk that means to look every few minutes. 60s is what one answer is worth;
// past that the policy is the better trade. decide() also breaks the circuit for the rest of a cycle
// once the gateway has missed one deadline, so a dead gateway costs one pool's wait, not every pool's.
export const OPENHERMIT_DEFAULTS = { gatewayUrl: "http://127.0.0.1:4000", agentId: "mr-bands", timeoutMs: 60_000 } as const;

const str = (v: string | undefined): string => (v ?? "").trim();

/** Read at call time, like the desk's other toggles (MODEL_ADVISES, POLICY_LIVE), so a test can pin the environment. */
export function openHermitSettings(env: NodeJS.ProcessEnv = process.env): OpenHermitSettings {
  const timeout = Number(str(env.OPENHERMIT_TIMEOUT_MS));
  return {
    gatewayUrl: (str(env.OPENHERMIT_GATEWAY_URL) || OPENHERMIT_DEFAULTS.gatewayUrl).replace(/\/+$/, ""),
    agentId: str(env.OPENHERMIT_AGENT_ID) || OPENHERMIT_DEFAULTS.agentId,
    token: str(env.OPENHERMIT_TOKEN),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : OPENHERMIT_DEFAULTS.timeoutMs,
  };
}

/** The backend can be asked: a token is set. The gateway being up is a separate question, answered per call. */
export function openHermitAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return openHermitSettings(env).token !== "";
}

export type OpenHermitFailure = "unreachable" | "unauthorized" | "not-found" | "timeout" | "bad-reply" | "http";

/** Why an ask failed, in a form decide() can name in its note without reading the message. */
export class OpenHermitError extends Error {
  constructor(
    public readonly kind: OpenHermitFailure,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "OpenHermitError";
  }
}

export interface OpenHermitReply {
  /** the agent's final text for the turn (null when the turn ended without one) */
  text: string;
  toolCalls: { tool: string; isError: boolean; text?: string }[];
  /** the model that answered, when the gateway says (it does not today; the agent id stands in) */
  model?: string;
  /** wall time for the whole ask, open included */
  ms: number;
  sessionId: string;
}

/** "desk:<mode>:" + the pool address, reduced to what a session id and a URL both like. Base58 addresses pass through untouched. */
export function decisionSessionId(poolAddress: string, mode: Observation["mode"]): string {
  const slug = poolAddress.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "pool";
  return `desk:${mode}:${slug}`;
}

/**
 * Sessions the gateway still owes an answer on, and the round we are now on with them.
 *
 * The gateway's wait mode subscribes to the SESSION and resolves on the first turn that ends in it
 * (apps/gateway/src/app.ts), while a message posted during a running turn queues behind it
 * (agent-runner: `session.queue = session.queue.then(run, run)`). So once one ask has outrun its
 * deadline, the next ask in that session can be handed the LATE ANSWER TO THE LAST OBSERVATION -
 * a decision priced on numbers that have moved, possibly naming a position that has since closed.
 * The cycle stamp below catches such an answer; this leaves the wedged session behind entirely, so
 * the desk is not reading one turn late for the rest of the run. The pool's history is the price.
 */
const abandonedSessions = new Map<string, number>();

/** The session to ask in now: the pool's own, or a fresh round of it if the last one was left behind. */
export function deskSessionId(observation: Observation): string {
  const base = decisionSessionId(observation.snapshot.address, observation.mode);
  const round = abandonedSessions.get(base) ?? 0;
  return round === 0 ? base : `${base}-r${round}`;
}

/** Walk away from this pool's session: the gateway owes it an answer we will never line up again. */
export function abandonDecisionSession(observation: Observation): void {
  const base = decisionSessionId(observation.snapshot.address, observation.mode);
  abandonedSessions.set(base, (abandonedSessions.get(base) ?? 0) + 1);
}

/**
 * The message: the observation exactly as the Anthropic backend sees it, then the two lines that turn
 * a chat agent into a structured one. The schema is spelled out in words because the gateway offers
 * no structured-output mode; DecisionSchema still has the last word on what comes back.
 */
export function decisionPrompt(observation: Observation): string {
  const fields =
    "action (one of HOLD, OPEN_POSITION, CLOSE_POSITION, CLAIM_FEES, REBALANCE), " +
    "open (null unless OPEN_POSITION or REBALANCE: an object with side (SOL_ONLY, TOKEN_ONLY or BOTH), amountSol, amountToken, " +
    "binsBelowActive, binsAboveActive, strategy (Spot, Curve or BidAsk) and optionally acquireToken), " +
    "positionAddress (a string for CLOSE_POSITION and REBALANCE, else null), reasoning (2-5 sentences of numeric reasoning), " +
    "confidence (0 to 1), headline (one line in your voice, at most 90 characters), and optionally liquidate (CLOSE_POSITION only, a boolean)";
  return (
    `${formatObservation(observation)}\n\n` +
    `Answer with ONLY one JSON object and nothing else, no prose and no code fence, with the fields ${fields}, ` +
    `and cycle, which must be exactly ${observation.cycle}.\n` +
    `The pool's label is ${observation.poolLabel}. This is cycle ${observation.cycle}: copy that number into the cycle ` +
    `field so an answer that arrives late can be told from an answer to this observation. A reply without it is thrown away.`
  );
}

/**
 * The first balanced {...} in the text that parses as a Decision. Fences are stripped first; strings
 * inside the object are walked so a brace in the reasoning cannot end it early. Returns the zod error
 * (or "no JSON object") when nothing usable is there.
 *
 * With `expect.cycle`, the object must also carry that cycle: the desk asked for it in the prompt, and
 * a reply carrying a different one is the late answer to an earlier observation (see abandonedSessions).
 * `stale` is set on that case alone, so the caller can leave the session behind; DecisionSchema drops
 * the field itself, being neither strict nor passthrough.
 */
export function extractDecision(
  text: string,
  expect: { cycle?: number } = {},
): { decision: Decision; error?: undefined; stale?: undefined } | { decision?: undefined; error: string; stale?: true } {
  const body = text.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
  let firstError: string | null = null;
  let sawObject = false;
  for (let start = body.indexOf("{"); start !== -1; start = body.indexOf("{", start + 1)) {
    const end = balancedEnd(body, start);
    if (end === -1) continue;
    sawObject = true;
    let raw: unknown;
    try {
      raw = JSON.parse(body.slice(start, end + 1));
    } catch (err) {
      firstError ??= `not JSON: ${(err as Error).message}`;
      continue;
    }
    const parsed = DecisionSchema.safeParse(raw);
    if (!parsed.success) {
      firstError ??= parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ");
      continue;
    }
    if (typeof expect.cycle === "number") {
      const stamp = (raw as { cycle?: unknown }).cycle;
      const n = typeof stamp === "number" ? stamp : typeof stamp === "string" ? Number(stamp) : NaN;
      if (!Number.isFinite(n)) {
        firstError ??= `no cycle in the reply (cycle ${expect.cycle} was asked for)`;
        continue;
      }
      if (n !== expect.cycle) return { error: `answers cycle ${n}, not ${expect.cycle}: a late turn`, stale: true };
    }
    return { decision: parsed.data };
  }
  return { error: firstError ?? (sawObject ? "no decision in the reply" : "no JSON object in the reply") };
}

function balancedEnd(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

export interface AskOptions {
  settings?: OpenHermitSettings;
  /** the fetch to use (tests hand in their own); defaults to the global one */
  fetchImpl?: typeof fetch;
}

export interface SessionMessage {
  /** the session to post into; opened (or resumed) first when this process has not yet */
  sessionId: string;
  text: string;
  /** who is talking, as the gateway's source.platform (the desk by default) */
  platform?: string;
  /** stored on the session when it is opened */
  sessionMetadata?: Record<string, unknown>;
  /** stored on the message */
  metadata?: Record<string, unknown>;
}

/** Sessions this process has opened on the gateway, keyed "<gatewayUrl>|<agentId>|<sessionId>". */
const openedSessions = new Set<string>();

/** Forget every opened session and every abandoned round (tests; a gateway restart needs no help, the 404 path handles it). */
export function forgetSessions(): void {
  openedSessions.clear();
  abandonedSessions.clear();
}

/**
 * Put one message in front of the agent and wait for the turn to end. Throws an OpenHermitError; never
 * returns without text. The deadline covers the whole exchange: an open that takes most of it leaves the
 * post only the rest.
 */
export async function askSession(msg: SessionMessage, opts: AskOptions = {}): Promise<OpenHermitReply> {
  const settings = opts.settings ?? openHermitSettings();
  if (!settings.token) throw new OpenHermitError("unauthorized", "OPENHERMIT_TOKEN is not set");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const started = Date.now();
  const deadline = started + settings.timeoutMs;
  const { sessionId } = msg;
  const key = `${settings.gatewayUrl}|${settings.agentId}|${sessionId}`;
  const base = `${settings.gatewayUrl}/api/agents/${encodeURIComponent(settings.agentId)}/sessions`;
  const headers = { "content-type": "application/json", authorization: `Bearer ${settings.token}` };

  const call = async (url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> => {
    const left = deadline - Date.now();
    if (left <= 0) throw new OpenHermitError("timeout", `no time left after ${settings.timeoutMs}ms`);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), left);
    try {
      const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctl.signal });
      const text = await res.text();
      let json: Record<string, unknown> | null = null;
      try {
        json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json };
    } catch (err) {
      if (ctl.signal.aborted) throw new OpenHermitError("timeout", `no reply within ${settings.timeoutMs}ms`);
      throw new OpenHermitError("unreachable", `${settings.gatewayUrl}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  };

  const errorMessage = (json: Record<string, unknown> | null, fallback: string): string => {
    const e = json?.error;
    if (typeof e === "string") return e;
    if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") return (e as { message: string }).message;
    return fallback;
  };

  const open = async (): Promise<void> => {
    const r = await call(base, {
      sessionId,
      source: { kind: "api", interactive: false, platform: msg.platform ?? "mr-bands-desk", type: "direct" },
      ...(msg.sessionMetadata ? { metadata: msg.sessionMetadata } : {}),
    });
    if (r.status === 401 || r.status === 403) throw new OpenHermitError("unauthorized", errorMessage(r.json, "the gateway refused the token"), r.status);
    if (r.status === 404) throw new OpenHermitError("not-found", errorMessage(r.json, `agent ${settings.agentId} is not on the gateway`), r.status);
    if (r.status < 200 || r.status >= 300) throw new OpenHermitError("http", `open session ${sessionId}: ${errorMessage(r.json, `HTTP ${r.status}`)}`, r.status);
    openedSessions.add(key);
  };

  const post = async () => {
    const left = Math.max(1, deadline - Date.now());
    const url = `${base}/${encodeURIComponent(sessionId)}/messages?wait=true&timeout=${left}`;
    return call(url, { text: msg.text, mentioned: true, ...(msg.metadata ? { metadata: msg.metadata } : {}) });
  };

  if (!openedSessions.has(key)) await open();
  let r = await post();
  if (r.status === 404) {
    // the gateway does not know the session (it restarted, or a first post raced its open): open it and post once more
    openedSessions.delete(key);
    await open();
    r = await post();
  }
  if (r.status === 401 || r.status === 403) throw new OpenHermitError("unauthorized", errorMessage(r.json, "the gateway refused the token"), r.status);
  if (r.status === 404) throw new OpenHermitError("not-found", errorMessage(r.json, `session ${sessionId} on agent ${settings.agentId}`), r.status);
  if (r.status === 504) throw new OpenHermitError("timeout", errorMessage(r.json, "the gateway gave up waiting for the agent"), r.status);
  if (r.status < 200 || r.status >= 300) throw new OpenHermitError("http", errorMessage(r.json, `HTTP ${r.status}`), r.status);
  const json = r.json ?? {};
  if (json.triggered === false) throw new OpenHermitError("bad-reply", "the gateway did not trigger the agent (triggered: false)");
  if (typeof json.text !== "string" || !json.text.trim()) {
    throw new OpenHermitError("bad-reply", typeof json.error === "string" ? `the turn ended with an error: ${json.error}` : "the turn ended without text");
  }
  const toolCalls = Array.isArray(json.toolCalls)
    ? (json.toolCalls as Record<string, unknown>[]).map((t) => ({ tool: String(t.tool ?? ""), isError: t.isError === true, ...(typeof t.text === "string" ? { text: t.text } : {}) }))
    : [];
  // json.model reaches the journal and the public page. The gateway does not send it today, and when it
  // does the string is the host's, not ours: take a short slug or nothing.
  const named = typeof json.model === "string" ? json.model.trim() : "";
  const model = /^[A-Za-z0-9/_.:-]{1,80}$/.test(named) ? named : undefined;
  return { text: json.text, toolCalls, ...(model ? { model } : {}), ms: Date.now() - started, sessionId };
}

/** Ask the agent for a decision on one observation, in the pool's session for this desk mode. Throws an OpenHermitError. */
export async function askForDecision(observation: Observation, opts: AskOptions = {}): Promise<OpenHermitReply> {
  const pool = observation.snapshot.address;
  try {
    return await askSession(
      {
        sessionId: deskSessionId(observation),
        text: decisionPrompt(observation),
        sessionMetadata: { pool, label: observation.poolLabel, mode: observation.mode },
        metadata: { cycle: observation.cycle, pool },
      },
      opts,
    );
  } catch (err) {
    // we stopped waiting, the gateway did not: whatever that turn says will arrive in the session after
    // this observation is history, so the next ask starts a round the desk is alone in
    if (err instanceof OpenHermitError && err.kind === "timeout") abandonDecisionSession(observation);
    throw err;
  }
}
