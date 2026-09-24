/**
 * The builder voice's tick (docs/talk.md, "The builder voice"), the posting loop's default since 22 Sep
 * (TALK_VOICE=builder; TALK_VOICE=ledger keeps the older lowercase ledger cards for a rollback). runTick
 * (src/talk/tick.ts) calls it under the tick lock, after the stop file and the X backoff.
 *
 *   1. read: the paper book and its report (the headline and the SOL/USD valuation term), the last 24 hours, the
 *      paper lessons of 48h, the journal tail, the learners' counts in mrbands.log, the screener snapshot, the
 *      build ledger, his own posts of 7 days
 *   2. CODE PICKS: pickMoment (src/talk/moments.ts), at most one, under POSTS_PER_DAY and the loop's spacing
 *   3. HIS MODEL WORDS: askPost (src/talk/postBrain.ts), one fresh session per post, under TALK_MODEL_CALLS_PER_DAY
 *      paced across the day (src/talk/pace.ts: past the hour's share, the moment waits for a later tick)
 *   4. CODE DECIDES: vetBuilderPost (src/talk/postGuards.ts); one retry with the reason; then silence, except the
 *      daily card, whose template (built from the same facts) goes through the same guards, and a close or a halt
 *      when his model cannot be asked at all (the gateway down, the day's cap spent): its fallback, from its own
 *      facts, goes through the same guards (Zach, 23 Sep: "the account must keep posting")
 *   5. post through postTweet (src/talk/x.ts) with the sentence-case lint. Only with TALK_BUILDER_LIVE=true does a
 *      builder post reach X; until then every pick is a dry record and a draft row (the plan's 48 hours dry).
 *
 * Nothing here trades, reads mentions or replies.
 */
import fs from "node:fs";
import { syncAutoBuild } from "./autoBuild";
import path from "node:path";
import { readLessons, LESSONS_FILE } from "../learn/lessons";
import { loadTalkData, stackFiguresOf } from "./data";
import { lintContextOf, type TalkEnv } from "./env";
import { bookHeadlineFacts, bookStartOf } from "./facts";
import { backoff, jitterMin, type RecentText } from "./guards";
import { readBuildLedger } from "./buildLedger";
import { pickMoment, tickerOf, type LearningCount, type Moment, type MomentInputs, type PostMemory, type ScreenPool } from "./moments";
import { PERSONALITY_FILE, readPersonality } from "./personality";
import { DEFAULT_TAKE_POSTS_PER_DAY, deskDayOf, readDexOverview, stockBoardOf, type Opinion, type TakeInputs } from "./takes";
import { askPost, factIds, type AskImpl, type PostDraft, type PromptMemory } from "./postBrain";
import { brainProblem } from "./replyBrain";
import { vetBuilderPost, type BuilderRefusal, type BuilderVetContext } from "./postGuards";
import { STALE_CYCLES, fmtAge } from "./strap";
import { confirmIdentity, loopLogOf, stopFileOf, STOP_FILE, type TickOutcome, type TickState } from "./tick";
import { DRAFTS_FILE, POSTS_FILE, postTweet, readPostLog, retryableReason, unresolvedIntentKeys, xGateProblem, type XDeps } from "./x";

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const DEFAULT_TARGET_POSTS_PER_DAY = 5;
export const LEARNING_LOG = "mrbands.log";
export const SCREEN_FILE = "screen.json";

export interface BuilderTickOptions {
  t: TalkEnv;
  env: NodeJS.ProcessEnv;
  now: number;
  st: TickState;
  paperDesk: boolean;
  /** a preview: the pick, its facts and (for the daily) its template; no model call, nothing written or posted */
  force: boolean;
  postsPerDay: number;
  dailyHourUtc: number;
  retryBackoffMin: number;
  fetch?: XDeps["fetch"];
  /** his agent's transport (tests hand in a fake) */
  askImpl?: AskImpl;
  /** the repo root the build seed is read from (default process.cwd()) */
  cwd?: string;
  tailBytes?: number;
}

export interface BuilderOutcome extends TickOutcome {
  moment?: Moment | null;
  text?: string;
  /** who wrote the text: his model, or the daily's template or a moment's fallback */
  source?: "model" | "template";
  /** the state runTick writes */
  state: TickState;
}

const intEnv = (env: NodeJS.ProcessEnv, key: string, d: number, min: number, max: number) => {
  const raw = (env[key] ?? "").trim();
  const n = raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : d;
};
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ---------------------------------------------------------------- reading

const LEARN_RE = /\[learning\] (\w+): (\d+) of the (\d+)/g;

/** The newest count per category from the tail of mrbands.log ("[learning] memecoin: 17 of the 20 ..."). */
export function learningCountsOf(logText: string): LearningCount[] {
  const latest = new Map<string, LearningCount>();
  for (const m of logText.matchAll(LEARN_RE)) latest.set(m[1], { category: m[1], n: Number(m[2]), need: Number(m[3]) });
  return [...latest.values()];
}

function readTail(file: string, bytes: number): string {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

export function screenPoolsOf(file: string): ScreenPool[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { pools?: unknown };
    if (!Array.isArray(raw.pools)) return [];
    return raw.pools.slice(0, 200).map((p: Record<string, unknown>) => ({
      name: String(p.name ?? ""),
      venue: String(p.venue ?? ""),
      tvlUsd: typeof p.tvlUsd === "number" ? p.tvlUsd : null,
      feeToTvl24hPct: typeof p.feeToTvl24hPct === "number" ? p.feeToTvl24hPct : null,
      rank: typeof p.rank === "number" ? p.rank : null,
    }));
  } catch {
    return [];
  }
}

/** Everything the picker reads, from the files. */
export async function momentInputsOf(o: Pick<BuilderTickOptions, "t" | "now" | "paperDesk" | "dailyHourUtc" | "st" | "cwd" | "tailBytes"> & { env?: NodeJS.ProcessEnv }): Promise<{ inputs: MomentInputs; recent: RecentText[]; linksToday: number }> {
  const { t, now } = o;
  const data = loadTalkData(t, now, o.tailBytes ?? 8 * 1024 * 1024);
  const book = data.source === "paper" ? data.book : null;
  const staleMs = STALE_CYCLES * t.cycleIntervalSec * 1000;
  const freshAt = data.source === "paper" ? (data.book?.lastMarkAt ?? null) : data.newestEntryAt;
  const stale = freshAt === null ? "no paper book mark or journal entry to read" : now - freshAt > staleMs ? `the newest mark is ${fmtAge(now - freshAt)} old, more than ${STALE_CYCLES} cycles` : null;
  let headline: MomentInputs["headline"] = [];
  if (book) {
    try {
      const { paperSummary } = await import("../paper/report.js");
      headline = bookHeadlineFacts(paperSummary(book, [], now, data.rows));
    } catch {
      headline = [];
    }
  }
  const log = loopLogOf(t.statePath, now);
  const posts: PostMemory[] = readPostLog(t.statePath)
    .filter((p) => !p.replyTo && typeof p.text === "string" && Date.parse(p.at) >= now - 7 * DAY && Date.parse(p.at) <= now)
    .map((p) => ({ at: Date.parse(p.at), text: p.text, key: p.key ?? null, type: p.type }))
    .sort((a, b) => a.at - b.at);
  const lessons = readLessons(path.join(t.dataDir, LESSONS_FILE), now - 2 * DAY).filter((l) => l.mode === "paper");
  const buildPerDay = Number((process.env.TALK_BUILD_POSTS_PER_DAY ?? "").trim());
  const deskLog = readTail(path.join(t.dataDir, LEARNING_LOG), 512 * 1024);
  // takes (src/talk/takes.ts), only with TALK_TAKES=true: his approved opinions and what each topic stands on
  const env = o.env ?? process.env;
  let takes: TakeInputs | null = null;
  if ((env.TALK_TAKES ?? "").trim() === "true") {
    let opinions: Opinion[] = [];
    try {
      if (fs.existsSync(path.join(t.statePath, PERSONALITY_FILE))) opinions = readPersonality(t.statePath, now).opinions;
    } catch {
      opinions = []; // a personality file that does not validate is Zach's to fix; takes go on from the facts alone
    }
    takes = {
      perDay: Math.floor(intEnv(env, "TALK_TAKE_POSTS_PER_DAY", DEFAULT_TAKE_POSTS_PER_DAY, 0, 24)),
      opinions,
      dexes: await readDexOverview(t.statePath, now),
      stocks: stockBoardOf(deskLog),
      desk: deskDayOf(data.journal.entries, now),
      openBands: (data.book?.bands ?? []).map((b) => ({ label: tickerOf(b.label) ?? "", openedAt: b.openedAt })).filter((b) => b.label),
    };
  }
  const inputs: MomentInputs = {
    ...(Number.isFinite(buildPerDay) && buildPerDay >= 0 && (process.env.TALK_BUILD_POSTS_PER_DAY ?? "").trim() ? { buildPostsPerDay: Math.floor(buildPerDay) } : {}),
    now,
    stale,
    bookStart: bookStartOf(data.book),
    headline,
    closed: data.book?.closed ?? [],
    day: data.source === "paper" ? stackFiguresOf(data, DAY, t.cycleIntervalSec) : null,
    lessons,
    journal: data.journal.entries,
    journalFrom: data.journal.from,
    learning: learningCountsOf(deskLog),
    screen: screenPoolsOf(path.join(t.dataDir, SCREEN_FILE)),
    build: readBuildLedger(t.statePath, o.cwd ?? process.cwd()).rows,
    posts,
    // a POST that never got X's answer may be on X: its key is used (never a second, differently worded post)
    seen: new Set([...log.seen, ...unresolvedIntentKeys(t.statePath, now - 7 * DAY)]),
    dailyHourUtc: o.dailyHourUtc,
    lastDailyDay: o.st.lastDailyDay,
    takes,
  };
  const recent: RecentText[] = posts.map((p) => ({ at: p.at, text: p.text, key: p.key, type: p.type }));
  const linksToday = posts.filter((p) => utcDay(p.at) === utcDay(now) && /\.(finance|io|ag)\b/.test(p.text)).length;
  return { inputs, recent, linksToday };
}

/** What his model reads besides the facts: his last 14 posts, the build ledger's public lines of 7 days, open promises. */
export function promptMemoryOf(i: MomentInputs): PromptMemory {
  const posted = (id: string) => i.seen.has(`build:${id}`);
  return {
    recent: i.posts.slice(-14),
    buildLines: i.build.filter((r) => r.public && r.at <= i.now && i.now - r.at <= 7 * DAY).map((r) => r.text),
    promises: i.build.filter((r) => r.public && r.promise && posted(r.id) && !i.seen.has(`promise:${r.id}`)).map((r) => r.text),
  };
}

// ---------------------------------------------------------------- drafting

export interface Drafted {
  text: string | null;
  source: "model" | "template" | null;
  /** why nothing may go out (the last refusal or the model's state) */
  reason: string | null;
  /** the gateway was down or the cap reached: the key stays unspent (the next tick may ask again) */
  transient: boolean;
  /** the last text the model gave, for the draft row */
  lastDraft: string | null;
  asks: number;
}

/** Ask, vet, retry once with the reason, then the daily's template, a fallback (his model not asked), or silence. */
export async function draftMoment(m: Moment, vet: BuilderVetContext, mem: PromptMemory, o: { env: NodeJS.ProcessEnv; statePath: string; now: number; askImpl?: AskImpl }): Promise<Drafted> {
  let asks = 0;
  let lastDraft: string | null = null;
  let reason: string | null = null;
  let transient = false;
  let retry: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const d: PostDraft = await askPost(m, mem, retry, o);
    if (d.kind === "down") {
      // paced: this hour's share of the cap is spent; the moment waits for a later tick, no fallback
      if (d.paced) return { text: null, source: null, reason: `model paced: ${d.why}`, transient: attempt === 0, lastDraft, asks };
      transient = attempt === 0;
      reason = `model down: ${d.why}`;
      if (attempt === 0 && m.fallback) {
        // his model cannot be asked at all: the moment's own plain post, through the same guards
        const r = vetBuilderPost(m.fallback, { ...vet, fallback: true });
        if (!r) return { text: m.fallback, source: "template", reason, transient: false, lastDraft, asks };
        reason = `${reason}; the fallback too: ${r.rule}: ${r.detail}`;
      }
      break;
    }
    asks++;
    if (d.kind === "skip") {
      reason = `model ${d.source === "contract" ? "broke the contract" : "skipped"}: ${d.why}`;
      break;
    }
    lastDraft = d.text;
    const r: BuilderRefusal | null = vetBuilderPost(d.text, vet);
    if (!r) return { text: d.text, source: "model", reason: null, transient: false, lastDraft, asks };
    reason = `guards: ${r.rule}: ${r.detail}`;
    retry = `${r.rule}: ${r.detail}`;
  }
  if (m.template) {
    const r = vetBuilderPost(m.template, vet);
    if (!r) return { text: m.template, source: "template", reason, transient: false, lastDraft, asks };
    reason = `${reason ?? ""}; the template too: ${r.rule}: ${r.detail}`.replace(/^; /, "");
    return { text: null, source: null, reason, transient: false, lastDraft, asks };
  }
  return { text: null, source: null, reason, transient, lastDraft, asks };
}

function appendRow(statePath: string, file: string, row: object): void {
  fs.mkdirSync(statePath, { recursive: true });
  fs.appendFileSync(path.join(statePath, file), JSON.stringify(row) + "\n");
}

// ---------------------------------------------------------------- the tick

export async function runBuilderTick(o: BuilderTickOptions): Promise<BuilderOutcome> {
  const { t, env, now, st } = o;
  const untouched: TickState = { ...st, lastTickAt: now };
  // one line a tick in talk.log when his model cannot be asked at all (no gateway token, or one too short to be
  // real): only the daily's template could go out then. Never the token, only why (brainProblem).
  const brainWhy = brainProblem(env);
  if (brainWhy) console.log(`[talk] builder: his model cannot be asked: ${brainWhy}; only the daily card's template can go out`);
  // the auto build log: new commits (his own repo, and his work on the runtime he runs on) become build rows first
  const auto = syncAutoBuild({ cwd: o.cwd ?? process.cwd(), statePath: t.statePath, runtimeRepo: (env.TALK_RUNTIME_REPO ?? "").trim() || null });
  if (auto.added.length) console.log(`[talk] build log: ${auto.added.length} new row(s): ${auto.added.join(", ")}`);
  if (auto.note) console.log(`[talk] ${auto.note}`);
  const { inputs, recent, linksToday } = await momentInputsOf(o);
  const plan = pickMoment(inputs, {
    postsPerDay: o.postsPerDay,
    targetPerDay: Math.floor(intEnv(env, "TALK_TARGET_POSTS_PER_DAY", DEFAULT_TARGET_POSTS_PER_DAY, 1, 1000)),
    minGapMin: intEnv(env, "TALK_MIN_GAP_MIN", 90, 0, 24 * 60),
    gapJitterMin: Math.floor(intEnv(env, "TALK_GAP_JITTER_MIN", 45, 0, 24 * 60)),
    windowPosts: Math.floor(intEnv(env, "TALK_WINDOW_POSTS", 2, 0, 1000)),
    windowHours: intEnv(env, "TALK_WINDOW_HOURS", 6, 0, 24),
    dayStartUtc: Math.floor(intEnv(env, "TALK_DAY_START_UTC", 12, 0, 23)),
    nightPosts: Math.floor(intEnv(env, "TALK_NIGHT_POSTS", 2, 0, 1000)),
    jitter: jitterMin,
  });
  const notes = plan.notes;
  const m = plan.pick;
  const vetOf = (x: Moment): BuilderVetContext => ({ facts: x.facts, length: x.length, lint: lintContextOf(t), recent, followUpOf: x.followUpOf, type: x.type, past: x.past, arc: x.arc, linksToday });
  if (o.force) {
    const x = m ?? plan.moments[0] ?? null;
    if (!x) return { status: "preview", detail: `nothing to preview${notes.length ? `: ${notes.join("; ")}` : ""}`, moment: null, state: untouched };
    const tpl = x.template ? vetBuilderPost(x.template, vetOf(x)) : null;
    return {
      status: "preview",
      detail: `preview only (no model call, nothing written): ${x.key} ${x.type} ${x.length}${x.past ? " past-tense" : ""}, score ${x.score.toFixed(0)}, facts ${factIds(x.facts)}${plan.held ? `; held: ${plan.held}` : ""}${x.template ? `; template ${tpl ? `refused (${tpl.rule}: ${tpl.detail})` : "passes"}` : ""}`,
      moment: x,
      text: x.template,
      state: untouched,
    };
  }
  if (plan.held) return { status: /^cap:/.test(plan.held) ? "capped" : "spaced", detail: plan.held, moment: m, state: untouched };
  if (!m) return { status: "idle", detail: notes.length ? notes.join("; ") : "nothing worth a post", state: untouched };

  const at = new Date(now).toISOString();
  const today = utcDay(now);
  const vet = vetOf(m);
  const drafted = await draftMoment(m, vet, promptMemoryOf(inputs), { env, statePath: t.statePath, now, askImpl: o.askImpl });
  const spentState: TickState = { ...untouched, ...(m.type === "daily" ? { lastDailyDay: today } : {}) };
  if (!drafted.text) {
    // the gateway down or the cap on the first ask: nothing spent, the next tick may try again (the cap still binds)
    if (drafted.transient) return { status: "not-posted", detail: `${m.key}: ${drafted.reason} (the key stays unspent)`, moment: m, state: untouched };
    appendRow(t.statePath, DRAFTS_FILE, { at, type: m.type, text: drafted.lastDraft ?? "", reason: `builder: ${drafted.reason ?? "no text"}`, key: m.key });
    return { status: "refused-lint", detail: `${m.key}: ${drafted.reason ?? "no text"}; nothing posted`, moment: m, state: spentState };
  }
  const text = drafted.text;
  if (fs.existsSync(stopFileOf(t.statePath))) return { status: "stopped", detail: `${STOP_FILE} appeared before posting: halted`, moment: m, text, state: untouched };

  const afterX = (result: "posted" | "dormant" | "transient" | "other", reason: string) => {
    const b = backoff({ transientFails: st.transientFails ?? 0, backoffUntil: st.backoffUntil ?? null }, result, now, o.retryBackoffMin);
    return { state: { transientFails: b.transientFails, backoffUntil: b.backoffUntil }, detail: b.heldMin > 0 ? `x: ${b.transientFails} transient failures in a row (${reason}), backing off ${b.heldMin} min` : null };
  };
  // builder posts reach X only with TALK_BUILDER_LIVE=true: until then X_LIVE is withheld and every pick is a dry record
  const builderLive = (env.TALK_BUILDER_LIVE ?? "").trim() === "true";
  const postEnv: NodeJS.ProcessEnv = { ...env, POSTS_PER_DAY: String(o.postsPerDay) };
  if (!builderLive) delete postEnv.X_LIVE;
  let confirmed: Pick<TickState, "confirmedHandle" | "confirmedTokenHash"> = {};
  if (builderLive && xGateProblem(t) === null) {
    const id = await confirmIdentity(st, t, env, now, o.fetch);
    if (!id.ok) {
      appendRow(t.statePath, DRAFTS_FILE, { at, type: m.type, text, reason: id.reason });
      const x = afterX(id.transient ? "transient" : "other", id.reason);
      return { status: "not-posted", detail: x.detail ?? id.reason, moment: m, text, state: { ...untouched, ...x.state } };
    }
    confirmed = { confirmedHandle: id.handle, confirmedTokenHash: id.tokenHash };
  }
  const who = drafted.source === "template" ? `${m.type === "daily" ? "the daily's template" : "its fallback"} (${drafted.reason ?? "model not used"})` : "his model";
  const r = await postTweet(text, { type: m.type, key: m.key, sentenceCase: true, intent: true }, { env: postEnv, now, fetch: o.fetch });
  if (r.posted) return { status: "posted", detail: `posted ${r.id}: ${m.key}, written by ${who}`, moment: m, text, source: drafted.source ?? undefined, id: r.id, state: { ...spentState, ...confirmed, ...afterX("posted", "").state } };
  if (r.reason.startsWith("dormant")) {
    appendRow(t.statePath, POSTS_FILE, { id: `draft:${m.key}`, text, type: m.type, at, replyTo: null, replyToHandle: null, key: m.key, dry: true });
    return { status: "drafted", detail: `${builderLive ? r.reason : "dry: TALK_BUILDER_LIVE is not \"true\""}; ${m.key}, written by ${who}`, moment: m, text, source: drafted.source ?? undefined, state: { ...spentState, ...afterX("dormant", "").state } };
  }
  if (retryableReason(r.reason)) {
    const x = afterX("transient", r.reason);
    // X may have taken it (a timeout after the POST, a 5xx): the intent stays open and the key counts as used
    const maybeOnX = /^x api (unreachable|5\d\d)/.test(r.reason);
    return { status: "not-posted", detail: x.detail ?? `${r.reason} (${maybeOnX ? "X may hold it: the key counts as used, never reworded" : "will retry"})`, moment: m, text, state: { ...(maybeOnX ? spentState : untouched), ...confirmed, ...x.state } };
  }
  return { status: "not-posted", detail: r.reason, moment: m, text, state: { ...spentState, ...confirmed } };
}
