/**
 * The engage loop (docs/talk.md, "Engage"): he answers people who summoned him on X. launchd runs
 * `talk.ts engage` every 120 s (ops/com.bands.mrbands.engage.plist); it is separate from the 15-minute posting tick
 * and never takes tick.lock, because one pass may wait up to 45 s per mention on his brain.
 *
 * The model proposes, the guards decide. His brain (src/talk/replyBrain.ts, his own OpenHermit agent) drafts a reply
 * or says skip; code decides whether anything is posted: the screen before the model, the contract on its answer,
 * vetReply (src/talk/replyGuards.ts) on every text, then postReply and postTweet's own lint, gate and limiter.
 * Mention text is attacker-controlled DATA: it is classified, compared and quoted to the brain inside a data block,
 * never obeyed. Nothing here can move money or touch the desk.
 *
 * One pass, cheapest first; nothing below a "no" runs, so a dormant loop spends $0:
 *   1 TALK_STOP or ENGAGE_STOP   2 X_REPLIES is not "true"   3 the brain is not ready (brainProblem, or brainDown
 *   with the same token)   4 repliesOff (3 "not mentioned" 403s in a row)   5 xGateProblem   6 an X hold (this loop's,
 *   or tick-state.json's backoffUntil, read-only: a 402 is account-wide)   7 the day's read budget   8 engage.lock
 *   9 whoAmI once per access token (must be X_HANDLE and SELF_USER_ID)   10 getMentions since the cursor, 2 pages at
 *   most; the first run seeds the cursor and answers nothing   11 new mentions join `pending`, the cursor moves, save
 *   12 each pending mention, oldest first: opt-out, classify and screen (a skip costs $0), caps (full: defer and end
 *   the pass), claim, draftReply, vetReply, postReply   13 prune: pending past ENGAGE_MAX_AGE_HOURS is stale, handled
 *   past 7 days goes; save; release the lock.
 *
 * State, all in TALK_STATE_PATH: engage-state.json (temp + rename after every mention; unreadable THROWS),
 * engage-optout.json (permanent), x-mentions.jsonl (one row per outcome), engage.log, engage-status.json (the last
 * dormant line, so it is logged once an hour or on change), engage.lock.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OpenHermitFailure } from "../agent/openhermit";
import { backingOff, backoff, DEFAULT_RETRY_BACKOFF_MIN } from "./guards";
import { lintContextOf, normalizeHandle, talkEnv, type TalkEnv } from "./env";
import { normalizeForMatch } from "./lint";
import { INJECTION_RE } from "./drafts";
import { withLock } from "./lock";
import { classifyMention, isFarm, isHollow, looksLikeBot, massTag, optOutIn, SELF_USER_ID, vetReply, type MentionKind } from "./replyGuards";
import { readTickState, tokenHashOf } from "./tick";
import { blockedWordsIn } from "./wordguard";
import { byIdAsc, DRAFTS_FILE, getMentions, linksInMentionBody, postReply, readPosts, readRate, rateProblem, screenMention, TALK_STOP_FILE, whoAmI, xGateProblem, type Mention, type XDeps } from "./x";
import { COPYCAT_MINTS } from "../risk/house";

// ---------------------------------------------------------------- the seam with src/talk/replyBrain.ts

export interface ReplyInput {
  mentionId: string;
  authorHandle: string;
  authorName?: string;
  /** DATA */
  text: string;
  /** DATA */
  parentText: string | null;
  parentIsMine: boolean;
  kind: MentionKind;
  hollow: boolean;
  followUp: boolean;
}

export type ReplyDraft =
  | { kind: "reply"; text: string; source: "template" | "model"; template?: string }
  | { kind: "skip"; why: string; source: "template" | "model" | "contract" }
  | { kind: "down"; failure: OpenHermitFailure; why: string };

export interface ReplyBrain {
  /** why the brain cannot be asked (never the token), or null */
  brainProblem(env: NodeJS.ProcessEnv): string | null;
  /** the fixed-answer templates first, then one fresh session on his gateway agent */
  draftReply(input: ReplyInput, o: { env: NodeJS.ProcessEnv }): Promise<ReplyDraft>;
  /** the numbers the facts block carries: a model reply may hold no other */
  REPLY_FACTS_NUMBERS: readonly string[];
}

/**
 * His brain, loaded at run time so this loop stays dormant (never broken) on a checkout without it: a missing
 * module is a dormant reason like an unset token.
 */
export function loadReplyBrain(): ReplyBrain {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./replyBrain") as Partial<ReplyBrain>;
    if (typeof mod.brainProblem === "function" && typeof mod.draftReply === "function") return { brainProblem: mod.brainProblem, draftReply: mod.draftReply, REPLY_FACTS_NUMBERS: mod.REPLY_FACTS_NUMBERS ?? [] };
  } catch {
    /* not installed */
  }
  const why = "the reply brain (src/talk/replyBrain.ts) is not installed";
  return { brainProblem: () => why, draftReply: async () => ({ kind: "down", failure: "unreachable", why }), REPLY_FACTS_NUMBERS: [] };
}

// ---------------------------------------------------------------- files and constants

export const ENGAGE_STATE_FILE = "engage-state.json";
export const ENGAGE_OPTOUT_FILE = "engage-optout.json";
export const ENGAGE_STATUS_FILE = "engage-status.json";
export const MENTIONS_LOG_FILE = "x-mentions.jsonl";
export const ENGAGE_LOG_FILE = "engage.log";
export const ENGAGE_LOCK_FILE = "engage.lock";
/** present in TALK_STATE_PATH: replies stop, posts go on (TALK_STOP stops both) */
export const ENGAGE_STOP_FILE = "ENGAGE_STOP";

const HOUR = 3600e3;
const DAY = 24 * HOUR;
/** at most this many pages of 100 per pass */
export const MENTION_PAGES = 2;
/** X "not mentioned" 403s in a row before replies turn off */
export const NOT_MENTIONED_403_LIMIT = 3;
/** replies to one conversation per UTC day */
export const CONVERSATION_REPLIES_PER_DAY = 4;
/** seconds between two replies in one pass (no human-pacing jitter: he is labelled automated) */
export const REPLY_SPACING_MS = 5000;
export const HANDLED_KEEP_MS = 7 * DAY;
/** a dormant line is written to engage.log at most this often unless it changes */
const STATUS_EVERY_MS = HOUR;
const NOT_MENTIONED_RE = /x api 403\b.*(mentioned|reply to this conversation|not allowed to reply)/i;

export interface HandledEntry {
  /** "posted <id>", "skip: why", "refused: rule", "stale", "opt-out", "drafting", "posting", "unknown: why", "x 403: ..." */
  outcome: string;
  at: number;
  authorId?: string | null;
  author?: string | null;
  conversationId?: string | null;
}

export type PendingMention = Mention & { queuedAt: number };

export interface EngageState {
  version: 1;
  sinceId: string | null;
  confirmedUserId: string | null;
  confirmedHandle: string | null;
  /** short sha256 of the X access token whose identity was confirmed or refused */
  tokenHash: string | null;
  /** whoAmI answered someone else for this token: not asked again until the token changes */
  identityRefused: string | null;
  pending: PendingMention[];
  handled: Record<string, HandledEntry>;
  /** the gateway refused (unauthorized, not found) this OPENHERMIT_TOKEN: dormant until the token changes or resume */
  brainDown: { why: string; tokenHash: string; at: number } | null;
  transientFails: number;
  backoffUntil: number | null;
  consecutive403: number;
  repliesOff: { why: string; at: number } | null;
  /** UTC day the counters below belong to */
  day: string;
  reads: number;
  modelCalls: number;
  hollow: number;
}

export const emptyEngageState = (): EngageState => ({ version: 1, sinceId: null, confirmedUserId: null, confirmedHandle: null, tokenHash: null, identityRefused: null, pending: [], handled: {}, brainDown: null, transientFails: 0, backoffUntil: null, consecutive403: 0, repliesOff: null, day: "", reads: 0, modelCalls: 0, hollow: 0 });

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const brainTokenHash = (env: NodeJS.ProcessEnv) => sha((env.OPENHERMIT_TOKEN ?? "").trim());

/** Missing: empty. Present but unreadable: THROWS (the loop then reads and posts nothing rather than forget what it did). */
export function readEngageState(statePath: string): EngageState {
  let text: string;
  try {
    text = fs.readFileSync(path.join(statePath, ENGAGE_STATE_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyEngageState();
    throw err;
  }
  const raw = JSON.parse(text) as Partial<EngageState>;
  if (!raw || raw.version !== 1 || !Array.isArray(raw.pending) || typeof raw.handled !== "object" || raw.handled === null) throw new Error(`${ENGAGE_STATE_FILE} is not an engage state file`);
  return { ...emptyEngageState(), ...raw } as EngageState;
}

function writeJsonAtomic(statePath: string, file: string, value: unknown): void {
  fs.mkdirSync(statePath, { recursive: true });
  const target = path.join(statePath, file);
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, target);
}

export const writeEngageState = (statePath: string, s: EngageState) => writeJsonAtomic(statePath, ENGAGE_STATE_FILE, s);

export interface OptOuts {
  version: 1;
  authorIds: string[];
  handles: string[];
}

/** The permanent opt-out list. Missing: empty. Unreadable: THROWS (a promise to people is not dropped silently). */
export function readOptOuts(statePath: string): OptOuts {
  let text: string;
  try {
    text = fs.readFileSync(path.join(statePath, ENGAGE_OPTOUT_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, authorIds: [], handles: [] };
    throw err;
  }
  const raw = JSON.parse(text) as Partial<OptOuts>;
  if (!raw || !Array.isArray(raw.authorIds) || !Array.isArray(raw.handles)) throw new Error(`${ENGAGE_OPTOUT_FILE} is not an opt-out file`);
  return { version: 1, authorIds: raw.authorIds, handles: raw.handles };
}

function addOptOut(statePath: string, m: Mention): void {
  const o = readOptOuts(statePath);
  const h = normalizeHandle(m.authorHandle);
  if (m.authorId && !o.authorIds.includes(m.authorId)) o.authorIds.push(m.authorId);
  if (h && !o.handles.includes(h)) o.handles.push(h);
  writeJsonAtomic(statePath, ENGAGE_OPTOUT_FILE, o);
}

const optedOut = (o: OptOuts, m: Mention) => (!!m.authorId && o.authorIds.includes(m.authorId)) || o.handles.includes(normalizeHandle(m.authorHandle) ?? "");

function appendLine(statePath: string, file: string, line: string): void {
  try {
    fs.mkdirSync(statePath, { recursive: true });
    fs.appendFileSync(path.join(statePath, file), line + "\n");
  } catch {
    /* a log that cannot be written never changes an outcome */
  }
}

export interface MentionLogRow {
  at: string;
  id: string;
  author: string;
  kind?: MentionKind | null;
  outcome: string;
  detail?: string;
  postedId?: string;
}

const logMention = (statePath: string, row: MentionLogRow) => appendLine(statePath, MENTIONS_LOG_FILE, JSON.stringify(row));
const logLine = (statePath: string, now: number, line: string) => appendLine(statePath, ENGAGE_LOG_FILE, `${new Date(now).toISOString()} ${line}`);

/** Write a status line to engage.log when it changed or an hour after it was last written. */
function logStatus(statePath: string, now: number, line: string): void {
  let last: { line?: string; at?: number } = {};
  try {
    last = JSON.parse(fs.readFileSync(path.join(statePath, ENGAGE_STATUS_FILE), "utf8"));
  } catch {
    /* none yet */
  }
  if (last.line === line && typeof last.at === "number" && now - last.at < STATUS_EVERY_MS) return;
  logLine(statePath, now, line);
  try {
    writeJsonAtomic(statePath, ENGAGE_STATUS_FILE, { line, at: now });
  } catch {
    /* the throttle is a courtesy */
  }
}

/** The day's counters, reset on a new UTC day. */
function rollDay(s: EngageState, now: number): void {
  const d = utcDay(now);
  if (s.day !== d) {
    s.day = d;
    s.reads = 0;
    s.modelCalls = 0;
    s.hollow = 0;
  }
}

// ---------------------------------------------------------------- the gates before any spend

export type EngageStatus = "stopped" | "off" | "dormant" | "replies-off" | "gate" | "backoff" | "budget" | "busy" | "identity" | "read-failed" | "seeded" | "ran" | "error";

export interface EngageResult {
  status: EngageStatus;
  detail: string;
  replied: number;
  skipped: number;
  deferred: number;
}

const result = (status: EngageStatus, detail: string, extra: Partial<EngageResult> = {}): EngageResult => ({ status, detail, replied: 0, skipped: 0, deferred: 0, ...extra });

/** Steps 1 to 7: why this pass spends nothing, or null. No network, no writes. */
export function engageGate(t: TalkEnv, env: NodeJS.ProcessEnv, st: EngageState, brain: ReplyBrain, now: number): { status: EngageStatus; line: string } | null {
  if (fs.existsSync(path.join(t.statePath, TALK_STOP_FILE)) || fs.existsSync(path.join(t.statePath, ENGAGE_STOP_FILE))) return { status: "stopped", line: "engage stopped" };
  if (!t.xReplies) return { status: "off", line: "engage off: X_REPLIES is not true" };
  const problem = brain.brainProblem(env);
  if (problem) return { status: "dormant", line: `replies dormant: ${problem}` };
  if (st.brainDown && st.brainDown.tokenHash === brainTokenHash(env)) return { status: "dormant", line: `replies dormant: the gateway refused this OPENHERMIT_TOKEN (${st.brainDown.why}); change it or run talk engage resume` };
  if (st.repliesOff) return { status: "replies-off", line: `replies off: ${st.repliesOff.why}, run talk engage resume` };
  const gate = xGateProblem(t);
  if (gate) return { status: "gate", line: `engage ${gate}` };
  if (backingOff(st, now)) return { status: "backoff", line: `x hold: engage waits until ${new Date(st.backoffUntil!).toISOString().slice(11, 16)} utc after ${st.transientFails} failures` };
  let tickHold: number | null = null;
  try {
    tickHold = readTickState(t.statePath).backoffUntil ?? null;
  } catch (err) {
    return { status: "error", line: `tick-state.json cannot be read (${(err as Error).message.slice(0, 80)}); not calling x` };
  }
  if (typeof tickHold === "number" && now < tickHold) return { status: "backoff", line: `x hold: the posting loop holds x until ${new Date(tickHold).toISOString().slice(11, 16)} utc (account-wide)` };
  const reads = st.day === utcDay(now) ? st.reads : 0;
  if (reads >= t.engageReadsPerDay) return { status: "budget", line: `read budget spent: ${reads} mention posts today, ENGAGE_READS_PER_DAY is ${t.engageReadsPerDay}; waits for the new utc day` };
  return null;
}

// ---------------------------------------------------------------- the screen

export type ScreenResult = { skip: string } | { kind: MentionKind; hollow: boolean; followUp: boolean; parentText: string | null; parentIsMine: boolean };

export interface ScreenContext {
  t: TalkEnv;
  env: NodeJS.ProcessEnv;
  st: EngageState;
  now: number;
  selfId: string;
}

const countsAsReply = (outcome: string) => /^(posted|posting|unknown)/.test(outcome);

/** Everything that decides, before any model call, whether a mention may get an answer. Reads; never writes. */
export function screenForReply(m: Mention, c: ScreenContext, queuedAt = c.now): ScreenResult {
  const { t, st, now } = c;
  const self = t.xHandle;
  const handle = normalizeHandle(m.authorHandle);
  if ((m.authorId && m.authorId === c.selfId) || (handle && handle === self)) return { skip: "himself" };
  const kind = classifyMention(m, c.selfId, self);
  if (!kind) return { skip: "thread-carried: his handle only rides another conversation's reply prefix" };
  const created = m.createdAt ? Date.parse(m.createdAt) : queuedAt;
  if (Number.isFinite(created) && now - created > t.engageMaxAgeHours * HOUR) return { skip: `stale: older than ${t.engageMaxAgeHours}h` };
  const bot = looksLikeBot({ handle: m.authorHandle, bio: m.authorBio }, t.engageDenyHandles);
  if (bot) return { skip: `bot: ${bot}` };
  const screened = screenMention(m, { env: c.env, now });
  if (!screened.reply) return { skip: `screen: ${screened.reason}` };
  if (linksInMentionBody(m.text).length) return { skip: "screen: carries a link" };
  if (INJECTION_RE.test(normalizeForMatch(m.text))) return { skip: "screen: reads like an instruction (data, not a command)" };
  const blocked = [...blockedWordsIn(m.authorHandle), ...blockedWordsIn(m.authorName ?? ""), ...blockedWordsIn(m.text.replace(/@\w{1,15}/g, " "))];
  if (blocked.length) return { skip: `screen: blocked word (${[...new Set(blocked)].join(", ")})` };
  if (kind !== "reply-to-mine" && massTag(m, self)) return { skip: "screen: mass tag" };
  const shill = shillIn(m.text, t);
  if (shill) return { skip: `shill: ${shill}` };
  // the conversation caps: one reply per mention, one per author per conversation a day (two with a question), four per conversation
  if (st.handled[m.id]) return { skip: "already handled" };
  const today = Object.values(st.handled).filter((h) => countsAsReply(h.outcome) && utcDay(h.at) === utcDay(now));
  const conv = m.conversationId ?? null;
  let followUp = false;
  if (conv) {
    const inConv = today.filter((h) => h.conversationId === conv);
    if (inConv.length >= CONVERSATION_REPLIES_PER_DAY) return { skip: `conversation: ${inConv.length} replies in this conversation today` };
    const byAuthor = inConv.filter((h) => (m.authorId && h.authorId === m.authorId) || (!!handle && h.author === handle)).length;
    if (byAuthor >= 2) return { skip: "conversation: already answered this account twice here today" };
    if (byAuthor === 1 && !m.text.includes("?")) return { skip: "conversation: already answered this account here today, and no question came back" };
    followUp = byAuthor === 1;
  }
  const hollow = isHollow(m.text);
  if (hollow) {
    if (isFarm({ createdAt: m.authorCreatedAt, followers: m.authorFollowers }, now)) return { skip: "farm-hollow: a fresh account's empty praise" };
    const used = st.day === utcDay(now) ? st.hollow : 0;
    if (used >= t.engageHollowPerDay) return { skip: `hollow budget spent: ${used} today, ENGAGE_HOLLOW_PER_DAY is ${t.engageHollowPerDay}` };
  }
  const { parentText, parentIsMine } = parentOf(m, c);
  return { kind, hollow, followUp, parentText, parentIsMine };
}

/** Cashtags and addresses in a mention, other than the house token's and the copycat's (a shill is skipped, never corrected). */
export function shillIn(text: string, t: Pick<TalkEnv, "houseSymbols" | "houseMints">): string | null {
  const house = new Set(["bands", "mrbands", ...t.houseSymbols.map((s) => s.toLowerCase())]);
  for (const m of text.matchAll(/(?:^|[^\w$])\$([a-z][a-z0-9_]{0,19})\b/gi)) if (!house.has(m[1].toLowerCase())) return `cashtag $${m[1].toLowerCase()}`;
  for (const a of text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g) ?? []) if (!t.houseMints.includes(a) && !COPYCAT_MINTS.includes(a)) return "an address";
  return null;
}

/** The parent's text: his own from x-posts.jsonl (no extra read), anyone else's from X's expansion. */
function parentOf(m: Mention, c: ScreenContext): { parentText: string | null; parentIsMine: boolean } {
  const mine = (!!m.parentAuthorId && m.parentAuthorId === c.selfId) || (m.inReplyToUserId === c.selfId && !!m.parentId);
  if (mine && m.parentId) {
    const own = readPosts(c.t.statePath).find((p) => p.id === m.parentId);
    return { parentText: own?.text ?? m.parentText ?? null, parentIsMine: true };
  }
  return { parentText: m.parentText ?? null, parentIsMine: false };
}

// ---------------------------------------------------------------- one pass

export interface EngageDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: number;
  fetch?: typeof fetch;
  nonce?: () => string;
  /** his brain; default loadReplyBrain() */
  brain?: ReplyBrain;
  /** the wait between two replies (tests pass a no-op) */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runEngagePass(deps: EngageDeps = {}): Promise<EngageResult> {
  const env = deps.env ?? process.env;
  const t = talkEnv(env, deps.cwd);
  const now = deps.now ?? Date.now();
  const brain = deps.brain ?? loadReplyBrain();
  let st: EngageState;
  try {
    st = readEngageState(t.statePath);
  } catch (err) {
    const line = `${ENGAGE_STATE_FILE} cannot be read (${(err as Error).message.slice(0, 80)}); nothing read, nothing posted`;
    logStatus(t.statePath, now, line);
    return result("error", line);
  }
  const held = engageGate(t, env, st, brain, now);
  if (held) {
    logStatus(t.statePath, now, held.line);
    return result(held.status, held.line);
  }
  const locked = await withLock(path.join(t.statePath, ENGAGE_LOCK_FILE), () => lockedPass(t, env, now, brain, deps));
  return locked.locked ? locked.value : result("busy", `another engage pass holds ${ENGAGE_LOCK_FILE}`);
}

async function lockedPass(t: TalkEnv, env: NodeJS.ProcessEnv, now: number, brain: ReplyBrain, deps: EngageDeps): Promise<EngageResult> {
  let st: EngageState;
  try {
    st = readEngageState(t.statePath);
  } catch (err) {
    return result("error", `${ENGAGE_STATE_FILE} cannot be read (${(err as Error).message.slice(0, 80)}); nothing read, nothing posted`);
  }
  rollDay(st, now);
  if (st.brainDown && st.brainDown.tokenHash !== brainTokenHash(env)) st.brainDown = null;
  const save = () => writeEngageState(t.statePath, st);
  const xDeps: XDeps = { env, now, fetch: deps.fetch, nonce: deps.nonce };
  const retryMin = Number(env.TALK_RETRY_BACKOFF_MIN ?? "") >= 0 && (env.TALK_RETRY_BACKOFF_MIN ?? "").trim() !== "" ? Number(env.TALK_RETRY_BACKOFF_MIN) : DEFAULT_RETRY_BACKOFF_MIN;
  const feed = (outcome: "posted" | "transient") => {
    const b = backoff({ transientFails: st.transientFails, backoffUntil: st.backoffUntil }, outcome, now, retryMin);
    st.transientFails = b.transientFails;
    st.backoffUntil = b.backoffUntil;
    return b.heldMin;
  };

  // 9. identity, once per access token
  const xTokenHash = tokenHashOf((env.X_ACCESS_TOKEN ?? "").trim());
  if (st.tokenHash !== xTokenHash) {
    st.confirmedUserId = null;
    st.confirmedHandle = null;
    st.identityRefused = null;
  }
  if (st.identityRefused) {
    const line = `identity: ${st.identityRefused}; not reading mentions until the access token changes`;
    logStatus(t.statePath, now, line);
    save();
    return result("identity", line);
  }
  if (!st.confirmedUserId) {
    const me = await whoAmI(xDeps);
    if (!me.ok) {
      // any failure feeds the hold, so a bad token is not asked about every two minutes
      feed("transient");
      save();
      const line = `identity: could not check whose account the access token is for (${me.reason})`;
      logStatus(t.statePath, now, line);
      return result("identity", line);
    }
    st.tokenHash = xTokenHash;
    if (me.handle !== t.xHandle || me.id !== SELF_USER_ID) {
      st.identityRefused = `the access token is for @${me.handle} (${me.id}), not @${t.xHandle} (${SELF_USER_ID})`;
      save();
      const line = `identity: ${st.identityRefused}; not reading mentions`;
      logStatus(t.statePath, now, line);
      return result("identity", line);
    }
    st.confirmedUserId = me.id;
    st.confirmedHandle = me.handle;
    save();
  }

  // 10. read, at most two pages; a failure moves nothing
  const fetched: Mention[] = [];
  let newestId: string | null = null;
  let token: string | null = null;
  let truncated = false;
  for (let page = 0; page < MENTION_PAGES; page++) {
    const r = await getMentions(st.sinceId, { userId: st.confirmedUserId!, paginationToken: token }, xDeps);
    if (!r.ok) {
      let line: string;
      if (r.status === 429 && typeof r.resetAt === "number" && r.resetAt > now) {
        st.transientFails += 1;
        st.backoffUntil = r.resetAt;
        line = `read failed: ${r.reason}; waiting for x-rate-limit-reset at ${new Date(r.resetAt).toISOString().slice(11, 16)} utc`;
      } else {
        const heldMin = feed("transient");
        line = `read failed: ${r.reason}${heldMin ? `; holding x for ${heldMin} min` : ""}; the cursor stays`;
      }
      save();
      logLine(t.statePath, now, line);
      return result("read-failed", line);
    }
    st.reads += r.resultCount;
    if (page === 0) newestId = r.newestId;
    fetched.push(...r.mentions);
    token = r.nextToken;
    if (!token) break;
    if (page === MENTION_PAGES - 1) truncated = true;
  }
  feed("posted");
  if (st.sinceId === null) {
    if (newestId) st.sinceId = newestId;
    save();
    const line = `seeded: cursor at ${st.sinceId ?? "none (no mentions yet)"}; ${fetched.length} earlier mention(s) get no reply`;
    logLine(t.statePath, now, line);
    return result("seeded", line);
  }
  // 11. merge into pending, oldest first; the cursor moves
  const known = new Set(st.pending.map((p) => p.id));
  for (const m of fetched.sort(byIdAsc)) {
    if (st.handled[m.id] || known.has(m.id)) continue;
    st.pending.push({ ...m, queuedAt: now });
    known.add(m.id);
  }
  st.pending.sort(byIdAsc);
  if (newestId) st.sinceId = newestId;
  if (truncated) logLine(t.statePath, now, `more than ${MENTION_PAGES * 100} mentions since the cursor: the oldest past that were not read`);
  save();

  // 12. each pending mention, oldest first
  const selfId = st.confirmedUserId!;
  let replied = 0;
  let skipped = 0;
  let deferred = 0;
  let stopReason: string | null = null;
  const recentReplies = () => readPosts(t.statePath).filter((p) => p.type === "reply").slice(-50).map((p) => p.text);
  const finish = (m: Mention, outcome: string, kind: MentionKind | null, detail?: string, postedId?: string) => {
    st.pending = st.pending.filter((p) => p.id !== m.id);
    st.handled[m.id] = { outcome, at: now, authorId: m.authorId ?? null, author: normalizeHandle(m.authorHandle), conversationId: m.conversationId ?? null };
    save();
    logMention(t.statePath, { at: new Date(now).toISOString(), id: m.id, author: m.authorHandle, kind, outcome, ...(detail ? { detail } : {}), ...(postedId ? { postedId } : {}) });
  };
  const putBack = (m: PendingMention) => {
    delete st.handled[m.id];
    if (!st.pending.some((p) => p.id === m.id)) st.pending.push(m);
    st.pending.sort(byIdAsc);
    save();
  };

  let optOuts: OptOuts;
  try {
    optOuts = readOptOuts(t.statePath);
  } catch (err) {
    return result("error", `${ENGAGE_OPTOUT_FILE} cannot be read (${(err as Error).message.slice(0, 80)}); not replying`);
  }

  for (const m of [...st.pending]) {
    if (stopReason) break;
    // a. opt-out, before anything else
    if (optOutIn(m.text)) {
      addOptOut(t.statePath, m);
      optOuts = readOptOuts(t.statePath);
      finish(m, "opt-out", null, "asked him to stop: opted out for good, no reply");
      skipped++;
      continue;
    }
    if (optedOut(optOuts, m)) {
      finish(m, "skip: opted out", null);
      skipped++;
      continue;
    }
    // b. classify and screen: a skip costs $0
    const sc = screenForReply(m, { t, env, st, now, selfId }, m.queuedAt);
    if ("skip" in sc) {
      finish(m, `skip: ${sc.skip}`, classifyMention(m, selfId, t.xHandle));
      skipped++;
      continue;
    }
    // c. caps, without spending: full means defer (it stays pending) and the pass ends
    let capped: string | null = null;
    if (replied >= t.engageRepliesPerPass) capped = `${replied} replies this pass, ENGAGE_REPLIES_PER_PASS is ${t.engageRepliesPerPass}`;
    else if (st.modelCalls >= t.engageModelCallsPerDay) capped = `${st.modelCalls} model calls today, ENGAGE_MODEL_CALLS_PER_DAY is ${t.engageModelCallsPerDay}`;
    else {
      try {
        capped = rateProblem(readRate(t.statePath), t, now, normalizeHandle(m.authorHandle) ?? m.authorHandle);
      } catch (err) {
        capped = `x-rate.json cannot be read (${(err as Error).message.slice(0, 60)})`;
      }
    }
    if (capped) {
      deferred += st.pending.length;
      stopReason = `deferred: ${capped}`;
      break;
    }
    // d. claim
    st.handled[m.id] = { outcome: "drafting", at: now, authorId: m.authorId ?? null, author: normalizeHandle(m.authorHandle), conversationId: m.conversationId ?? null };
    save();
    // e. his brain (the templates run first inside draftReply)
    const input: ReplyInput = { mentionId: m.id, authorHandle: m.authorHandle, ...(m.authorName ? { authorName: m.authorName } : {}), text: m.text, parentText: sc.parentText, parentIsMine: sc.parentIsMine, kind: sc.kind, hollow: sc.hollow, followUp: sc.followUp };
    let draft: ReplyDraft;
    try {
      draft = await brain.draftReply(input, { env });
    } catch (err) {
      draft = { kind: "down", failure: "bad-reply", why: `draftReply threw: ${(err as Error).message.slice(0, 80)}` };
    }
    // a template answers without asking; anything else asked the gateway (a timeout may still have been billed)
    if (draft.kind === "down" || draft.source !== "template") st.modelCalls += 1;
    if (draft.kind === "down") {
      putBack(m);
      if (draft.failure === "unauthorized" || draft.failure === "not-found") {
        st.brainDown = { why: draft.failure, tokenHash: brainTokenHash(env), at: now };
        save();
        stopReason = `brain down: ${draft.failure}; replies dormant until OPENHERMIT_TOKEN changes or talk engage resume`;
      } else stopReason = `brain ${draft.failure}: ${draft.why.slice(0, 120)}; asking nothing more this pass`;
      deferred += st.pending.length;
      break;
    }
    if (sc.hollow) st.hollow += 1;
    if (draft.kind === "skip") {
      finish(m, `skip: ${draft.why.slice(0, 160)}`, sc.kind, `source ${draft.source}`);
      skipped++;
      continue;
    }
    // f. the guards decide; a refused draft is final and never falls back to posting
    const tokenMint = (env.TOKEN_MINT ?? "").trim() || null;
    const refused = vetReply(draft.text, { mention: { text: m.text, parentText: sc.parentText }, source: draft.source, recentReplies: recentReplies(), allowedNumbers: brain.REPLY_FACTS_NUMBERS, tokenMint, lint: lintContextOf(t) });
    if (refused) {
      appendLine(t.statePath, DRAFTS_FILE, JSON.stringify({ at: new Date(now).toISOString(), type: "reply", text: draft.text, reason: `vet: ${refused.rule}: ${refused.detail}`, replyTo: m.id, replyToHandle: normalizeHandle(m.authorHandle) }));
      finish(m, `refused: ${refused.rule}`, sc.kind, refused.detail);
      skipped++;
      continue;
    }
    // g. post, at most once
    if (replied > 0) await (deps.sleep ?? defaultSleep)(REPLY_SPACING_MS);
    st.handled[m.id] = { ...st.handled[m.id], outcome: "posting" };
    save();
    const r = await postReply(draft.text, { tweetId: m.id, handle: m.authorHandle }, xDeps);
    if (r.posted) {
      st.consecutive403 = 0;
      feed("posted");
      finish(m, `posted ${r.id}`, sc.kind, `source ${draft.source}`, r.id);
      replied++;
      continue;
    }
    const reason = r.reason;
    if (NOT_MENTIONED_RE.test(reason)) {
      st.consecutive403 += 1;
      if (st.consecutive403 >= NOT_MENTIONED_403_LIMIT) st.repliesOff = { why: `${st.consecutive403} "not mentioned" 403s in a row (${reason.slice(0, 120)})`, at: now };
      finish(m, `x 403: not mentioned`, sc.kind, reason);
      if (st.repliesOff) {
        stopReason = `replies off: ${st.repliesOff.why}`;
        logLine(t.statePath, now, stopReason);
      }
      continue;
    }
    if (/^x api (402|429|5\d\d)\b/.test(reason)) {
      // X said no, so nothing went out: it goes back and waits for the hold
      putBack(m);
      const heldMin = feed("transient");
      stopReason = `${reason.slice(0, 160)}${heldMin ? `; holding x for ${heldMin} min` : ""}`;
      deferred += st.pending.length;
      break;
    }
    if (/^x api unreachable/.test(reason)) {
      // the POST may have landed: never retried (at most once)
      feed("transient");
      finish(m, `unknown: ${reason}`, sc.kind);
      stopReason = reason;
      break;
    }
    if (/^(rate: |stopped:)/.test(reason)) {
      // our own limiter or the stop file: defer, and this is not an X failure
      putBack(m);
      stopReason = `deferred: ${reason.slice(0, 160)}`;
      deferred += st.pending.length;
      break;
    }
    finish(m, `refused: ${reason.slice(0, 160)}`, sc.kind);
    skipped++;
  }

  // 13. prune
  const maxAge = t.engageMaxAgeHours * HOUR;
  for (const p of [...st.pending]) {
    const created = p.createdAt ? Date.parse(p.createdAt) : p.queuedAt;
    if (Number.isFinite(created) && now - created > maxAge) finish(p, "stale", null, `older than ${t.engageMaxAgeHours}h while pending`);
  }
  for (const [id, h] of Object.entries(st.handled)) if (now - h.at > HANDLED_KEEP_MS) delete st.handled[id];
  save();
  const detail = `${replied} replied, ${skipped} skipped, ${st.pending.length} pending${stopReason ? `; ${stopReason}` : ""}`;
  logLine(t.statePath, now, `pass: ${detail}`);
  return result("ran", detail, { replied, skipped, deferred });
}

// ---------------------------------------------------------------- the operator's commands

/** `talk engage status`: free, no network. */
export function engageStatus(deps: { env?: NodeJS.ProcessEnv; cwd?: string; now?: number; brain?: ReplyBrain } = {}): string[] {
  const env = deps.env ?? process.env;
  const t = talkEnv(env, deps.cwd);
  const now = deps.now ?? Date.now();
  const brain = deps.brain ?? loadReplyBrain();
  let st: EngageState;
  try {
    st = readEngageState(t.statePath);
  } catch (err) {
    return [`engage error: ${ENGAGE_STATE_FILE} cannot be read (${(err as Error).message.slice(0, 80)})`];
  }
  const gate = engageGate(t, env, st, brain, now);
  const today = st.day === utcDay(now);
  let repliesToday = 0;
  try {
    repliesToday = readRate(t.statePath).replies.filter((r) => utcDay(r.at) === utcDay(now)).length;
  } catch {
    /* shown as 0 */
  }
  let optouts = 0;
  try {
    const o = readOptOuts(t.statePath);
    optouts = o.handles.length;
  } catch {
    /* shown as 0 */
  }
  return [
    `mode      ${gate ? gate.line : "on: the next pass reads mentions and may reply"}`,
    `brain     ${brain.brainProblem(env) ?? (st.brainDown ? `refused this token (${st.brainDown.why})` : "ready")}`,
    `account   ${st.confirmedHandle ? `@${st.confirmedHandle} (${st.confirmedUserId})` : "not confirmed yet"}`,
    `cursor    ${st.sinceId ?? "none (the first pass seeds it and answers nothing)"}`,
    `pending   ${st.pending.length}`,
    `today     ${today ? st.reads : 0} of ${t.engageReadsPerDay} mention reads, ${repliesToday} of ${t.repliesPerDay} replies, ${today ? st.modelCalls : 0} of ${t.engageModelCallsPerDay} model calls, ${today ? st.hollow : 0} of ${t.engageHollowPerDay} hollow`,
    `hold      ${backingOff(st, now) ? `until ${new Date(st.backoffUntil!).toISOString()}` : "none"}${st.transientFails ? ` (${st.transientFails} failures in a row)` : ""}`,
    `403s      ${st.consecutive403} "not mentioned" in a row${st.repliesOff ? `; replies off: ${st.repliesOff.why}` : ""}`,
    `opt-outs  ${optouts}`,
  ];
}

/** `talk engage resume`: clears repliesOff and brainDown (after the operator fixed the cause). */
export function engageResume(deps: { env?: NodeJS.ProcessEnv; cwd?: string; now?: number } = {}): string {
  const t = talkEnv(deps.env ?? process.env, deps.cwd);
  const run = () => {
    const st = readEngageState(t.statePath);
    const was = [st.repliesOff ? "replies off" : null, st.brainDown ? "brain down" : null, st.identityRefused ? "identity refused" : null].filter(Boolean);
    st.repliesOff = null;
    st.brainDown = null;
    st.consecutive403 = 0;
    st.identityRefused = null;
    writeEngageState(t.statePath, st);
    logLine(t.statePath, deps.now ?? Date.now(), `resume: cleared ${was.join(", ") || "nothing"}`);
    return was.length ? `cleared: ${was.join(", ")}` : "nothing to clear";
  };
  return run();
}

export interface PreviewRow {
  id: string;
  author: string;
  outcome: string;
  text?: string;
}

/**
 * `talk engage preview <mentions.json> [--no-model]`: classify, screen, brain and vet on a saved X response. No X
 * read and no post, ever, and nothing written: the state is read for the caps and never saved.
 */
export async function previewMentions(mentions: readonly Mention[], deps: { env?: NodeJS.ProcessEnv; cwd?: string; now?: number; brain?: ReplyBrain; model: boolean }): Promise<PreviewRow[]> {
  const env = deps.env ?? process.env;
  const t = talkEnv(env, deps.cwd);
  const now = deps.now ?? Date.now();
  const brain = deps.brain ?? loadReplyBrain();
  let st = emptyEngageState();
  try {
    st = readEngageState(t.statePath);
  } catch {
    /* a preview reads what it can */
  }
  rollDay(st, now);
  let optOuts: OptOuts = { version: 1, authorIds: [], handles: [] };
  try {
    optOuts = readOptOuts(t.statePath);
  } catch {
    /* as above */
  }
  const recent = readPosts(t.statePath).filter((p) => p.type === "reply").slice(-50).map((p) => p.text);
  const out: PreviewRow[] = [];
  for (const m of [...mentions].sort(byIdAsc)) {
    const row = (outcome: string, text?: string) => out.push({ id: m.id, author: m.authorHandle, outcome, ...(text !== undefined ? { text } : {}) });
    if (optOutIn(m.text)) {
      row("opt-out");
      continue;
    }
    if (optedOut(optOuts, m)) {
      row("skip: opted out");
      continue;
    }
    const sc = screenForReply(m, { t, env, st: { ...st, handled: { ...st.handled } }, now, selfId: st.confirmedUserId ?? SELF_USER_ID });
    if ("skip" in sc) {
      row(`skip: ${sc.skip}`);
      continue;
    }
    if (!deps.model) {
      row(`would ask the brain (${sc.kind}${sc.hollow ? ", hollow" : ""}${sc.followUp ? ", follow-up" : ""})`);
      continue;
    }
    const problem = brain.brainProblem(env);
    if (problem) {
      row(`brain dormant: ${problem}`);
      continue;
    }
    const draft = await brain.draftReply({ mentionId: m.id, authorHandle: m.authorHandle, ...(m.authorName ? { authorName: m.authorName } : {}), text: m.text, parentText: sc.parentText, parentIsMine: sc.parentIsMine, kind: sc.kind, hollow: sc.hollow, followUp: sc.followUp }, { env });
    if (draft.kind === "down") {
      row(`brain ${draft.failure}: ${draft.why}`);
      continue;
    }
    if (draft.kind === "skip") {
      row(`skip (${draft.source}): ${draft.why}`);
      continue;
    }
    const refused = vetReply(draft.text, { mention: { text: m.text, parentText: sc.parentText }, source: draft.source, recentReplies: recent, allowedNumbers: brain.REPLY_FACTS_NUMBERS, tokenMint: (env.TOKEN_MINT ?? "").trim() || null, lint: lintContextOf(t) });
    row(refused ? `refused: ${refused.rule}: ${refused.detail}` : `would reply (${draft.source})`, draft.text);
  }
  return out;
}
