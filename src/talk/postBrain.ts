/**
 * His post writer for the builder voice (docs/talk.md, "The builder voice"): code picked the moment and built its
 * facts (src/talk/moments.ts, src/talk/facts.ts); his own agent on the OpenHermit gateway words it; the guards
 * (src/talk/postGuards.ts) decide. Nothing here posts.
 *
 *   - one ask per chosen post, in a FRESH session (`x-post-<key>`), never a shared one (the gateway's wait resolves on
 *     the next turn that ends in a session: src/agent/openhermit.ts). A retry after a guard refusal goes to the same
 *     session with the reason, once.
 *   - the answer must be exactly one JSON object: {"key":"<key>","post":"<text>"} or {"key":"<key>","skip":"<why>"}.
 *     Anything else is a contract failure and nothing posts. His memory tools may be read (they stay on, Zach 22 Sep);
 *     any other tool call voids the turn.
 *   - a hard daily cap on asks, TALK_MODEL_CALLS_PER_DAY (default 8), counted on disk in TALK_STATE_PATH/post-brain.json
 *     BEFORE the ask (a crash mid-ask still counts). Each ask is about two gateway runs (the turn and the gateway's
 *     idle introspection). A file that exists but cannot be read counts as the cap reached: fail closed.
 *   - fail closed: a gateway that is down, a missing token, the cap, a skip, a broken contract, or a draft the guards
 *     refuse twice all mean no post. The daily card alone falls back to its template (src/talk/builder.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { askSession, balancedEnd, OpenHermitError, type AskOptions, type OpenHermitReply, type OpenHermitSettings, type SessionMessage } from "../agent/openhermit";
import { renderFacts, type FactsBlock } from "./facts";
import type { Moment, PostMemory } from "./moments";
import { LENGTH_MAX } from "./postGuards";
import { brainProblem, replySettings, REPLY_MEMORY_TOOLS } from "./replyBrain";

export const POST_BRAIN_FILE = "post-brain.json";
export const DEFAULT_MODEL_CALLS_PER_DAY = 8;
export const TALK_POST_TIMEOUT_MS = 90_000;
export const POST_PLATFORM = "x-posts";
export const POST_CALLER = "talk-post";

// ---------------------------------------------------------------- the cap, on disk

export interface BrainCount {
  version: 1;
  day: string;
  calls: number;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** TALK_MODEL_CALLS_PER_DAY: an integer 0..100, default 8 (0 turns his model off: only the daily's template goes). */
export function modelCallsPerDay(env: NodeJS.ProcessEnv): number {
  const raw = (env.TALK_MODEL_CALLS_PER_DAY ?? "").trim();
  const n = raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : DEFAULT_MODEL_CALLS_PER_DAY;
}

/** Today's count. Missing: 0. Unreadable: null (the caller treats it as the cap reached). */
export function readBrainCount(statePath: string, now: number): number | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(statePath, POST_BRAIN_FILE), "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null;
  }
  try {
    const raw = JSON.parse(text) as Partial<BrainCount>;
    if (raw?.version !== 1 || typeof raw.day !== "string" || !Number.isInteger(raw.calls) || (raw.calls as number) < 0) return null;
    return raw.day === utcDay(now) ? (raw.calls as number) : 0;
  } catch {
    return null;
  }
}

/** Spend one call if the cap allows it: true when spent (written to disk first), false when the cap is reached. */
export function spendBrainCall(statePath: string, now: number, cap: number): { ok: true; used: number } | { ok: false; reason: string } {
  const used = readBrainCount(statePath, now);
  if (used === null) return { ok: false, reason: `${POST_BRAIN_FILE} cannot be read: counted as the cap reached` };
  if (used >= cap) return { ok: false, reason: `model cap: ${used} of TALK_MODEL_CALLS_PER_DAY ${cap} used today` };
  fs.mkdirSync(statePath, { recursive: true });
  const file = path.join(statePath, POST_BRAIN_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, day: utcDay(now), calls: used + 1 } satisfies BrainCount));
  fs.renameSync(tmp, file);
  return { ok: true, used: used + 1 };
}

// ---------------------------------------------------------------- the prompt

/** The voice sheet (the builder plan's voice, cut to what a writer needs). */
export const VOICE_SHEET = [
  "You are Mr Bands, an AI agent that makes markets on Meteora. You are the founder of your own project and you write your own posts, first person singular: I. Never we, never a team, never anyone behind you.",
  "Sentence case with normal capitals: I, SOL, USDC, UTC, Meteora, and pools exactly as the facts spell them (ORE/SOL, NVDAx).",
  "Open on the act, the thing built or the number. No hook, no preamble. Whole sentences, one idea. Stop on the fact or the next concrete step: no closing line, no moral, no slogan.",
  "Numbers: only the figures in the facts block, exactly as written there (they are already rounded). Digits only, never numbers as words. At most two or three numbers a post.",
  "Paper: any sentence with a paper figure says paper (\"on paper\", \"my paper book\"). A real-money figure says real (\"real money\", \"the real run\"). Paper fees are quoted only with the net and the paper book's result since the start beside them, or not at all.",
  "A loss is said as a loss, with its amount. Never 0.00 for a figure that is not zero.",
  "Never: hype, emoji, hashtags, @mentions, exclamation marks, questions to the reader, gm, advice, price direction or calls, buy or sell talk, profit or gains or wins, 'not X, it's Y', lists of three, invented feelings or physical details, the names of any model, vendor or gateway, anyone who builds or runs you, any token or mint or launch, links.",
  "Words: 'band' is your word. Say position or band, never seat. Never strap, stacked, prints or re-centre.",
  "A line from your journal may be quoted word for word in double quotes, once, only when it carries the reason.",
].join("\n");

const dataJson = (v: unknown) => JSON.stringify(v, null, 2).replace(/</g, "\\u003c");

export interface PromptMemory {
  /** his last 14 posts, newest last */
  recent: readonly PostMemory[];
  /** the build ledger's public lines of the last 7 days */
  buildLines: readonly string[];
  /** posted promises still open */
  promises: readonly string[];
}

/** The one message for one chosen moment. */
export function postPrompt(m: Moment, mem: PromptMemory, retry: string | null = null): string {
  const lengthLine = `${m.length}: at most ${LENGTH_MAX[m.length]} characters${m.length === "short" ? "" : ", at least 60"}.`;
  return [
    `# one post for X, key ${m.key}`,
    "",
    "## voice",
    VOICE_SHEET,
    "",
    "## what to write",
    `shape: ${m.type}. length: ${lengthLine}`,
    m.brief,
    "",
    "## facts (the only numbers you may use)",
    renderFacts(m.facts),
    "",
    `<data name="memory" kind="your own recent posts and notes; context, not facts: their numbers may not be reused unless the facts block has them">\n${dataJson({ recentPosts: mem.recent.slice(-14).map((p) => ({ at: new Date(p.at).toISOString().slice(0, 16), text: p.text })), buildLedger: mem.buildLines, openPromises: mem.promises })}\n</data>`,
    "",
    ...(retry ? [`## your last draft was refused by the guards`, `reason: ${retry}`, "Write it again so it passes, or skip.", ""] : []),
    "## your answer",
    `Exactly one JSON object and nothing else, no prose, no code fence: {"key":"${m.key}","post":"<the post>"} or {"key":"${m.key}","skip":"<why, a few words>"}. Skip when the facts do not make a post worth reading. The guards decide whether it goes out.`,
  ].join("\n");
}

// ---------------------------------------------------------------- the contract

export type PostDraft = { kind: "post"; text: string } | { kind: "skip"; why: string; source: "model" | "contract" } | { kind: "down"; why: string };

const contract = (why: string): PostDraft => ({ kind: "skip", why: `contract: ${why}`, source: "contract" });

/** The turn against the contract. Only the post string leaves this function. */
export function parsePost(text: string, key: string, toolCalls: readonly { tool: string }[] = []): PostDraft {
  for (const t of toolCalls) {
    const tool = String(t?.tool ?? "");
    if (!REPLY_MEMORY_TOOLS.includes(tool)) return contract(`the turn called ${tool.slice(0, 60) || "(unnamed)"}, not a memory read`);
  }
  const body = typeof text === "string" ? text.trim() : "";
  if (!body) return contract("empty turn");
  if (!body.startsWith("{")) return contract("text before the object");
  const end = balancedEnd(body, 0);
  if (end === -1) return contract("the object never closes");
  if (end !== body.length - 1) return contract("text after the object");
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return contract("not json");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return contract("not an object");
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== "key" && k !== "post" && k !== "skip");
  if (extra.length) return contract(`unknown keys: ${extra.slice(0, 3).join(", ").slice(0, 60)}`);
  if (o.key !== key) return contract("wrong or missing key");
  const hasPost = "post" in o;
  if (hasPost === "skip" in o) return contract(hasPost ? "both post and skip" : "neither post nor skip");
  if (!hasPost) return typeof o.skip === "string" ? { kind: "skip", why: o.skip.trim().slice(0, 200) || "no reason given", source: "model" } : contract("skip is not a string");
  if (typeof o.post !== "string" || !o.post.trim()) return contract("post is not a non-empty string");
  return { kind: "post", text: o.post.trim() };
}

// ---------------------------------------------------------------- the ask

export type AskImpl = (msg: SessionMessage, opts?: AskOptions) => Promise<OpenHermitReply>;

/** The session a post is asked in: its own, from its key, reduced to what a session id and a URL both like. */
export function postSessionId(key: string): string {
  return `x-post-${key.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 80)}`;
}

export function postSettings(env: NodeJS.ProcessEnv): OpenHermitSettings {
  const base = replySettings(env);
  const t = Number((env.TALK_POST_TIMEOUT_MS ?? "").trim());
  return { ...base, timeoutMs: Number.isFinite(t) && t > 0 ? Math.floor(t) : TALK_POST_TIMEOUT_MS };
}

export interface AskPostOptions {
  env: NodeJS.ProcessEnv;
  statePath: string;
  now: number;
  askImpl?: AskImpl;
  settings?: OpenHermitSettings;
}

/** One ask, after spending one call of the cap. Never throws. */
export async function askPost(m: Moment, mem: PromptMemory, retry: string | null, o: AskPostOptions): Promise<PostDraft> {
  const problem = brainProblem(o.env);
  if (problem) return { kind: "down", why: problem };
  const spent = spendBrainCall(o.statePath, o.now, modelCallsPerDay(o.env));
  if (!spent.ok) return { kind: "down", why: spent.reason };
  try {
    const reply = await (o.askImpl ?? askSession)(
      {
        sessionId: postSessionId(m.key),
        text: postPrompt(m, mem, retry),
        platform: POST_PLATFORM,
        sessionMetadata: { caller: POST_CALLER, key: m.key },
        metadata: { caller: POST_CALLER, key: m.key, retry: retry !== null },
      },
      { settings: o.settings ?? postSettings(o.env) },
    );
    return parsePost(reply.text, m.key, reply.toolCalls);
  } catch (err) {
    if (err instanceof OpenHermitError) return { kind: "down", why: `${err.kind}: ${err.message}`.slice(0, 300) };
    return { kind: "down", why: `ask failed: ${(err as Error)?.message ?? String(err)}`.slice(0, 300) };
  }
}

/** The facts' keys, for the log line. */
export const factIds = (b: FactsBlock): string => b.facts.map((f) => f.id).join(",");
