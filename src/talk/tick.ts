/**
 * The autonomous posting loop (docs/talk.md, "The posting loop"). launchd runs `talk.ts tick` every 15 minutes
 * (ops/com.bands.mrbands.talk.plist); each tick:
 *
 *   1. reads what happened from DATA_DIR (the journal tail, the paper book, the ledger, lessons.jsonl) and his own
 *      state from TALK_STATE_PATH (x-posts.jsonl, x-drafts.jsonl, x-rate.json via x.ts, tick-state.json)
 *   2. builds candidate posts from EVENTS: a band opened or closed (one post each; a close says its outcome in SOL,
 *      a loss as plainly as a win), a strap state change (only on a change), a fee milestone, the daily numbers once
 *      a UTC day from TALK_DAILY_HOUR_UTC, a lesson from a newly closed seat at most once a UTC day, the weekly
 *      stack on UTC Mondays
 *   3. picks AT MOST ONE by a fixed priority (PRIORITY below), skipping any event key already posted or drafted in
 *      the last 7 days, and nothing once the UTC day holds POSTS_PER_DAY (default 6 for the loop) posts or drafts
 *   4. vets it (vetOutgoing: the lint, plus the loop's own stricter rules) and never posts a text that fails; the
 *      failure is logged in x-drafts.jsonl with the reason
 *   5. hands it to postTweet (x.ts), which posts only when X_LIVE=true and otherwise appends it to x-drafts.jsonl;
 *      the loop records every result (a tweet id, or the draft as `dry: true`) in x-posts.jsonl
 *
 * Safety, in code:
 *   - the whole tick runs under TALK_STATE_PATH/tick.lock, and x.ts holds x-rate.lock around read-rate, post and
 *     write-rate, so two ticks can never double-post
 *   - every pool and token label from on-chain data goes through sanitizeLabel: no @, # or $, only plain symbols,
 *     so a pool named "$SCAM @someone" can never make him tag an account or cashtag a token; vetOutgoing also
 *     refuses any @, # or $ in a loop post
 *   - links only to LOOP_LINK_HOSTS (mrbands.finance, solscan.io, app.meteora.ag)
 *   - NO replies and no reading mentions: nothing here calls replyToMention, screenMention or reads mentions
 *   - a TALK_STOP file in TALK_STATE_PATH stops the tick before anything, and again right before posting
 *   - data older than 3 cycles (the paper book's last mark, or the newest journal entry) posts nothing
 *   - while the desk is paper (DRY_RUN, or a book that is not live), every post says "paper": added if a template
 *     left it out, and a post without it is refused
 *
 * planTick is PURE (facts + state in, one choice out); runTick is the thin runner. Nothing here trades.
 */
import fs from "node:fs";
import path from "node:path";
import type { LedgerRow } from "../engine/ledger";
import { readLessons, LESSONS_FILE, type Lesson } from "../learn/lessons";
import type { PaperBook, PaperSide } from "../paper/book";
import { bookEquitySol } from "../paper/mark";
import { loadTalkData, stackFiguresOf, strapInputOf, type TalkData } from "./data";
import { signedSol, sourceTag, stackUpdate, strapCheck, type DraftResult } from "./drafts";
import { lintContextOf, talkEnv, type TalkEnv } from "./env";
import { linksIn, lintText, weightedLength, MAX_POST_CHARS } from "./lint";
import { withLock } from "./lock";
import { rowsForSource, stackFigures, STALE_CYCLES, fmtAge, strapOf, type StackFigures, type StrapResult, type StrapState, type TalkSource } from "./strap";
import { DRAFTS_FILE, POSTS_FILE, postTweet, readDrafts, readPostLog, type XDeps, type XPostType } from "./x";

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const TICK_STATE_FILE = "tick-state.json";
export const TICK_LOCK_FILE = "tick.lock";
export const STOP_FILE = "TALK_STOP";
/** the loop's own default; POSTS_PER_DAY in the env overrides it */
export const LOOP_POSTS_PER_DAY = 6;
export const DEFAULT_DAILY_HOUR_UTC = 14;
/** realized fees crossing a multiple of this is a loop milestone post (TALK_LOOP_MILESTONE_SOL) */
export const DEFAULT_LOOP_MILESTONE_SOL = 10;
/** an open or close older than this is old news: not posted */
export const EVENT_FRESH_MS = 2 * HOUR;
/** event keys posted or drafted inside this window are never used again */
export const DEDUPE_MS = 7 * DAY;
/** at most one strap post in this long, however often the state flips */
export const STRAP_COOLDOWN_MS = 3 * HOUR;
/** the only hosts a loop post may link to */
export const LOOP_LINK_HOSTS: readonly string[] = ["mrbands.finance", "solscan.io", "app.meteora.ag"];

export type TickKind = "close" | "open" | "strap" | "milestone" | "daily" | "lesson" | "stack";
/** Highest first. A fee milestone sits after a strap change and before the daily numbers. */
export const PRIORITY: readonly TickKind[] = ["close", "open", "strap", "milestone", "daily", "lesson", "stack"];
export type ForceKind = "strap" | "daily" | "lesson" | "stack";
export const FORCE_KINDS: readonly ForceKind[] = ["strap", "daily", "lesson", "stack"];

// ---------------------------------------------------------------- labels

/**
 * A pool or token label from on-chain data, made safe to print: lowercase, words that start with @ or # dropped,
 * then every character that is not a-z or 0-9 removed from each side of the pair. "$SCAM @someone/SOL" reads
 * "scam/sol"; a label with nothing left reads "a pool".
 */
export function sanitizeLabel(raw: string | null | undefined): string {
  const sides = String(raw ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .split("/")
    .slice(0, 2)
    .map((side) =>
      side
        .split(/\s+/)
        .filter((w) => w && !/^[@#＠＃]/.test(w))
        .join("")
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 12),
    )
    .filter(Boolean);
  return sides.length ? sides.join("/") : "a pool";
}

// ---------------------------------------------------------------- events

export interface BandEvent {
  kind: "open" | "close";
  /** "open:<band address>" / "close:<band address>" */
  key: string;
  at: number;
  pool: string;
  /** sanitized */
  label: string;
  side?: PaperSide | null;
  binsBelow?: number | null;
  binsAbove?: number | null;
  seatSol?: number | null;
  netSol?: number;
  feesSol?: number | null;
  holdSec?: number | null;
  outsideAtClose?: boolean | null;
  /** the key of an open in the same pool within two cycles after this close (a re-centre): the close covers it */
  relaidKey?: string | null;
}

/** Opens and closes from the paper book (paper) or the ledger (live), labels sanitized, oldest first. */
export function bandEvents(data: Pick<TalkData, "book" | "rows" | "journal" | "source">, cycleIntervalSec: number): BandEvent[] {
  const out: BandEvent[] = [];
  if (data.source !== "live" && data.book) {
    const b = data.book;
    for (const x of b.bands) {
      const below = x.openedBinId - x.lowerBinId;
      const above = x.upperBinId - x.openedBinId;
      out.push({ kind: "open", key: `open:${x.address}`, at: x.openedAt, pool: x.pool, label: sanitizeLabel(x.label), side: x.side, binsBelow: below >= 0 ? below : null, binsAbove: above >= 0 ? above : null, seatSol: x.entryValueSol });
    }
    for (const x of b.closed) {
      out.push({ kind: "open", key: `open:${x.address}`, at: x.openedAt, pool: x.pool, label: sanitizeLabel(x.label), side: x.side, binsBelow: null, binsAbove: null, seatSol: x.entryValueSol });
      out.push({ kind: "close", key: `close:${x.address}`, at: x.closedAt, pool: x.pool, label: sanitizeLabel(x.label), netSol: x.realizedSol, feesSol: x.feeSol, holdSec: x.holdSec, outsideAtClose: !x.inRangeAtClose });
    }
  } else if (data.source === "live") {
    const labels = new Map<string, string>();
    for (const e of data.journal.entries) labels.set(e.pool.address, e.pool.label);
    const rows = rowsForSource(data.rows, "live").filter((r) => r.position);
    const openedAt = new Map<string, number>();
    for (const r of rows) if (r.mech === "open") openedAt.set(r.position!, r.ts);
    for (const r of rows) {
      const label = sanitizeLabel(labels.get(r.pool) ?? null);
      if (r.mech === "open") out.push({ kind: "open", key: `open:${r.position}`, at: r.ts, pool: r.pool, label, seatSol: null, side: null, binsBelow: null, binsAbove: null });
      if (r.mech === "close") {
        const back = r.solDelta + r.tokenDelta * (r.markTokenInSol || 0);
        const opened = openedAt.get(r.position!);
        out.push({ kind: "close", key: `close:${r.position}`, at: r.ts, pool: r.pool, label, netSol: back - (r.entryValueSol ?? back), feesSol: r.feeSol ?? null, holdSec: opened !== undefined ? (r.ts - opened) / 1000 : null, outsideAtClose: null });
      }
    }
  }
  const twoCycles = 2 * cycleIntervalSec * 1000;
  for (const c of out) {
    if (c.kind !== "close") continue;
    const next = out.find((o) => o.kind === "open" && o.pool === c.pool && o.at >= c.at && o.at - c.at <= twoCycles);
    c.relaidKey = next?.key ?? null;
  }
  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.key) ? false : (seen.add(e.key), true))).sort((a, b) => a.at - b.at || (a.kind === "close" ? -1 : 1));
}

// ---------------------------------------------------------------- text

const sol4 = (n: number) => (/^-?0\.0000$/.test(n.toFixed(4)) ? "0.0000" : n.toFixed(4));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const heldFor = (sec: number) => (sec < 3600 ? `${Math.max(1, Math.round(sec / 60))}m` : `${(sec / 3600).toFixed(1)}h`);
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const shortDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"][d.getUTCMonth()]}`;
};

/** "paper book." / "dry run, nothing broadcast." from drafts.ts, as its own last line. */
const tagged = (lines: string[], source: TalkSource) => [...lines, sourceTag(source)].filter(Boolean).join("\n");

/** Paper said in code: a paper-desk post that does not say "paper" gets it added. */
export function paperize(text: string, paper: boolean): string {
  return paper && !/\bpaper\b/i.test(text) ? `${text}\n(paper)` : text;
}

export function closeText(e: BandEvent, source: TalkSource): string {
  const net = e.netSol ?? 0;
  const fees = e.feesSol ?? null;
  const feePart = fees !== null && fees > 0 ? ` fees ${sol4(fees)} sol counted in it.` : "";
  const lines = [
    `closed my band on ${e.label}${e.holdSec ? ` after ${heldFor(e.holdSec)}` : ""}.`,
    net < 0 ? `net ${signedSol(net)} sol, a loss.${feePart}` : `net ${signedSol(net)} sol.${feePart}`,
  ];
  if (e.outsideAtClose) lines.push("price was outside the band when it closed.");
  if (e.relaidKey) lines.push("laid a fresh band in the same pool.");
  return tagged(lines, source);
}

const SHAPES: Record<PaperSide, string> = { BOTH: "a straddle", SOL_ONLY: "a one-sided band under price", TOKEN_ONLY: "a one-sided band over price" };

export function openText(e: BandEvent, source: TalkSource): string {
  const shape = e.side ? SHAPES[e.side] : "a band";
  const b = e.binsBelow;
  const a = e.binsAbove;
  const bins = e.side === "BOTH" && typeof b === "number" && typeof a === "number" ? (a === b ? `, ${plural(b, "bin")} each side of price` : `, ${plural(b, "bin")} below price and ${a} above`) : "";
  const seat = typeof e.seatSol === "number" && e.seatSol > 0 ? `, ${sol4(e.seatSol)} sol in` : "";
  return tagged([`opened ${shape} on ${e.label}${bins}${seat}.`, "in the bands. i propose, the guards decide."], source);
}

export interface DailyFacts {
  figures: StackFigures;
  opened: number;
  bookSol: number | null;
  openBands: number | null;
}

export function dailyText(d: DailyFacts, withLink: boolean): string {
  const f = d.figures;
  const tag = f.source === "paper" ? ", paper book" : f.source === "dry-run" ? ", dry run" : "";
  const closes = f.closedBands > 0 ? `${f.closedBands} closed, ${f.closedUp} up and ${f.closedDown} down${f.worstCloseSol !== null && f.worstCloseSol < 0 ? `, worst ${signedSol(f.worstCloseSol)} sol` : ""}` : "none closed";
  const lines = [
    `daily numbers, ${f.window}${tag}:`,
    ...(d.bookSol !== null ? [`book marked at ${sol4(d.bookSol)} sol, ${plural(d.openBands ?? 0, "band")} open`] : []),
    `moves: ${d.opened} opened, ${closes}`,
    `fees realized ${sol4(f.feesRealizedSol)} sol`,
    `net realized ${signedSol(f.netRealizedSol)} sol after losses, rent, swaps and network fees`,
    ...(withLink ? ["mrbands.finance"] : []),
  ];
  return lines.join("\n");
}

export interface MilestoneFacts {
  /** multiples of the step crossed so far */
  n: number;
  step: number;
  firstAt: number;
  netSol: number;
}

export function milestoneText(m: MilestoneFacts, source: TalkSource): string {
  const book = source === "paper" ? "the paper book" : source === "dry-run" ? "the dry run" : "the book";
  return [
    `realized fees on ${book} passed ${+(m.n * m.step).toFixed(4)} sol since ${shortDate(m.firstAt)}.`,
    `fees are not profit: net realized over the same stretch is ${signedSol(m.netSol)} sol, losses, rent and swaps included.`,
  ].join("\n");
}

const ENDINGS: Record<Lesson["endReason"], string> = {
  "through-band": "price went through the band and out the other side.",
  idle: "price left the band and stayed away, so i pulled it.",
  stop: "the stop closed it.",
  faded: "the pool's flow faded and the seat moved on.",
  rotated: "the seat went to a pool ranked higher.",
  "exit-list": "the pool went on the exit list.",
  consolidated: "folded into a band already held in that pool.",
  flatten: "the book was flattened.",
  expire: "the seat ran out its time.",
  sold: "the ask side filled and the band emptied.",
  close: "closed and moved on.",
};

export function lessonFromSeat(l: Lesson, source: TalkSource): string {
  const label = sanitizeLabel(l.label);
  const inRange = typeof l.inRangePct === "number" ? `, in range ${Math.round(l.inRangePct)}% of checks` : "";
  const left = typeof l.tokensLeftSol === "number" && Math.abs(l.tokensLeftSol) >= 0.00005 ? ` ${sol4(l.tokensLeftSol)} sol of that still in tokens, not sold.` : "";
  const takeaway =
    l.netSol < 0 && l.feesSol > 0 ? "fees came in and the seat still lost. fees are not profit." : l.netSol < 0 ? "a loss, logged like the wins." : "net above zero this time. not every seat is.";
  return tagged(
    [`what one closed seat taught me: ${label}, ${heldFor(l.minutes * 60)} in the seat${inRange}.`, `fees ${sol4(l.feesSol)} sol, net ${signedSol(l.netSol)} sol.${left}`, `${ENDINGS[l.endReason] ?? ENDINGS.close} ${takeaway}`],
    source,
  );
}

// ---------------------------------------------------------------- vetting

export interface VetViolation {
  rule: string;
  detail: string;
}

/** X counts every link, bare domains included, as 23: stricter than the lint's weighting. */
export function loopLength(text: string): number {
  let n = weightedLength(text);
  for (const l of linksIn(text)) if (!/^https?:\/\//i.test(l)) n += Math.max(0, 23 - [...l].length);
  return n;
}

export function loopLinkAllowed(link: string): boolean {
  try {
    const u = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`);
    return !u.username && !u.password && LOOP_LINK_HOSTS.includes(u.hostname.toLowerCase().replace(/\.$/, ""));
  } catch {
    return false;
  }
}

/** Everything a loop post must pass before it may go out: the loop's own rules, then the lint. */
export function vetOutgoing(text: string, o: { paper: boolean; env: Pick<TalkEnv, "operatorHandle" | "houseSymbols" | "houseMints"> }): VetViolation[] {
  const v: VetViolation[] = [];
  if (/[@#$＠＃＄]/.test(text)) v.push({ rule: "loop-symbols", detail: "the loop never tags, hashtags or cashtags (@, # or $)" });
  for (const l of linksIn(text)) if (!loopLinkAllowed(l)) v.push({ rule: "loop-link", detail: `link not on the loop's allowlist (${LOOP_LINK_HOSTS.join(", ")}): ${l}` });
  if (o.paper && !/\bpaper\b/i.test(text)) v.push({ rule: "loop-paper", detail: 'the desk is paper and the post does not say "paper"' });
  const len = loopLength(text);
  if (len > MAX_POST_CHARS) v.push({ rule: "length", detail: `${len} > ${MAX_POST_CHARS} with links counted as 23` });
  const lint = lintText(text, lintContextOf(o.env as TalkEnv));
  for (const x of lint.violations) v.push({ rule: x.rule, detail: x.detail });
  return v;
}

// ---------------------------------------------------------------- state

export interface TickState {
  version: 1;
  lastTickAt: number | null;
  /** the last known strap state (never "unknown") */
  lastStrap: StrapState | null;
  lastStrapPostAt: number | null;
  lastDailyDay: string | null;
  lastLessonDay: string | null;
  lastStackDay: string | null;
  /** milestones crossed at the last tick; null until the first tick seeds it (no post for history) */
  milestoneN: number | null;
}

export const emptyTickState = (): TickState => ({ version: 1, lastTickAt: null, lastStrap: null, lastStrapPostAt: null, lastDailyDay: null, lastLessonDay: null, lastStackDay: null, milestoneN: null });

/** Missing: empty. Present but unreadable: THROWS (the loop then posts nothing rather than forget what it did). */
export function readTickState(statePath: string): TickState {
  let text: string;
  try {
    text = fs.readFileSync(path.join(statePath, TICK_STATE_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyTickState();
    throw err;
  }
  const raw = JSON.parse(text) as Partial<TickState>;
  if (!raw || raw.version !== 1) throw new Error(`${TICK_STATE_FILE} is not a tick state file`);
  return { ...emptyTickState(), ...raw };
}

export function writeTickState(statePath: string, s: TickState): void {
  fs.mkdirSync(statePath, { recursive: true });
  const file = path.join(statePath, TICK_STATE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, file);
}

export interface LoopLog {
  /** event keys posted, drafted or refused in the dedupe window */
  seen: Set<string>;
  /** the loop's posts and dry drafts on the current UTC day */
  postsToday: number;
}

export function loopLogOf(statePath: string, now: number): LoopLog {
  const since = now - DEDUPE_MS;
  const seen = new Set<string>();
  let postsToday = 0;
  for (const p of readPostLog(statePath)) {
    const at = Date.parse(p.at);
    if (!(at >= since)) continue;
    if (p.key) seen.add(p.key);
    if (!p.replyTo && utcDay(at) === utcDay(now)) postsToday += 1;
  }
  for (const d of readDrafts(statePath)) if (d.key && Date.parse(d.at) >= since) seen.add(d.key);
  return { seen, postsToday };
}

// ---------------------------------------------------------------- the plan (pure)

export interface TickFacts {
  now: number;
  source: TalkSource;
  paper: boolean;
  /** why the data is too old to post about positions, or null */
  staleReason: string | null;
  events: BandEvent[];
  strap: StrapResult;
  milestone: MilestoneFacts | null;
  daily: DailyFacts;
  stack7d: StackFigures;
  /** lessons of this book's mode, newest last */
  lessons: Lesson[];
  env: TalkEnv;
}

export interface Candidate {
  kind: TickKind;
  key: string;
  at: number;
  text: string;
  type: XPostType;
}

export interface TickPlan {
  pick: Candidate | null;
  candidates: Candidate[];
  /** why something that could have been a post is not one */
  notes: string[];
  stale: string | null;
  capped: boolean;
  /** the state to write whatever happens to the pick; planTick already advanced the gate of the picked kind */
  nextState: TickState;
}

export interface PlanOptions {
  postsPerDay: number;
  dailyHourUtc: number;
  force?: ForceKind | null;
}

export function planTick(f: TickFacts, st: TickState, log: LoopLog, o: PlanOptions): TickPlan {
  const now = f.now;
  const today = utcDay(now);
  const next: TickState = { ...st, lastTickAt: now };
  const notes: string[] = [];
  const empty = (extra: Partial<TickPlan> = {}): TickPlan => ({ pick: null, candidates: [], notes, stale: null, capped: false, nextState: next, ...extra });
  if (f.staleReason) return empty({ stale: f.staleReason });

  const seen = new Set(log.seen);
  // a close that was posted covers the re-laid open in the same pool
  for (const e of f.events) if (e.kind === "close" && e.relaidKey && seen.has(e.key)) seen.add(e.relaidKey);
  const cands: Candidate[] = [];
  const add = (kind: TickKind, key: string, at: number, type: XPostType, text: string) => cands.push({ kind, key, at, type, text: paperize(text, f.paper) });
  const fromDraft = (kind: TickKind, key: string, d: DraftResult) => {
    if (d.ok) add(kind, key, now, d.type, d.text);
    else notes.push(`${kind}: ${d.reason}${d.violations.length ? ` (${d.violations.map((v) => v.rule).join(", ")})` : ""}`);
  };
  const force = o.force ?? null;

  if (!force) {
    const fresh = f.events.filter((e) => now - e.at <= EVENT_FRESH_MS && e.at <= now && !seen.has(e.key));
    const relaid = new Set(fresh.filter((e) => e.kind === "close" && e.relaidKey).map((e) => e.relaidKey!));
    for (const e of fresh) {
      if (e.kind === "close") add("close", e.key, e.at, "close", closeText(e, f.source));
      else if (!relaid.has(e.key)) add("open", e.key, e.at, "open", openText(e, f.source));
    }
  }

  // the strap memory moves to the current state unless a change is waiting behind a higher-priority post
  // (then it stays, so the change is still a change next tick; a state that flips back simply stops being one)
  const strapKnown = f.strap.state !== "unknown";
  if (strapKnown) next.lastStrap = f.strap.state;
  if (force === "strap" || (!force && strapKnown && st.lastStrap && st.lastStrap !== f.strap.state)) {
    if (!force && st.lastStrapPostAt !== null && now - st.lastStrapPostAt < STRAP_COOLDOWN_MS) notes.push(`strap: ${st.lastStrap} to ${f.strap.state}, but a strap post went out ${fmtAge(now - st.lastStrapPostAt)} ago`);
    else {
      const before = cands.length;
      fromDraft("strap", `strap:${st.lastStrap ?? "none"}>${f.strap.state}:${Math.floor(now / (15 * MIN))}`, strapCheck(f.strap, { source: f.source, now, env: f.env }));
      if (!force && cands.length > before) next.lastStrap = st.lastStrap;
    }
  }

  if (!force && f.milestone) {
    if (st.milestoneN === null || f.milestone.n < st.milestoneN) next.milestoneN = f.milestone.n;
    else if (f.milestone.n > st.milestoneN) add("milestone", `milestone:${f.source}:${+(f.milestone.n * f.milestone.step).toFixed(4)}`, now, "milestone", milestoneText(f.milestone, f.source));
  }

  if (force === "daily" || (!force && new Date(now).getUTCHours() >= o.dailyHourUtc && st.lastDailyDay !== today)) {
    const key = `daily:${today}`;
    if (!force && seen.has(key)) next.lastDailyDay = today;
    else {
      const withLink = dailyText(f.daily, true);
      add("daily", key, now, "daily", loopLength(paperize(withLink, f.paper)) <= MAX_POST_CHARS ? withLink : dailyText(f.daily, false));
    }
  }

  if (force === "lesson" || (!force && st.lastLessonDay !== today)) {
    // the most telling seat closed in the last 24h (the biggest net either way); a forced lesson falls back to one already used
    const unseen = (l: Lesson) => !seen.has(`lesson:${l.position}`);
    const recent = f.lessons.filter((l) => !l.ask && now - l.closedAt <= DAY && l.closedAt <= now && (force || unseen(l)));
    const best = recent.sort((a, b) => Number(unseen(b)) - Number(unseen(a)) || Math.abs(b.netSol) - Math.abs(a.netSol) || b.closedAt - a.closedAt)[0];
    if (best) add("lesson", `lesson:${best.position}`, best.closedAt, "lesson", lessonFromSeat(best, f.source));
    else if (force) notes.push("lesson: no seat closed in the last 24h");
  }

  if (force === "stack" || (!force && new Date(now).getUTCDay() === 1 && st.lastStackDay !== today)) {
    const key = `stack:${today}`;
    if (!force && seen.has(key)) next.lastStackDay = today;
    else fromDraft("stack", key, stackUpdate(f.stack7d, { env: f.env }));
  }

  const rank = (k: TickKind) => PRIORITY.indexOf(k);
  cands.sort((a, b) => rank(a.kind) - rank(b.kind) || a.at - b.at);
  if (cands.length && log.postsToday >= o.postsPerDay) {
    notes.push(`cap: ${log.postsToday} posts today, POSTS_PER_DAY is ${o.postsPerDay}; ${cands.length} candidate(s) wait`);
    // nothing was used: a waiting strap change stays a change
    return empty({ candidates: cands, capped: true, nextState: { ...next, lastStrap: cands.some((c) => c.kind === "strap") && !force ? st.lastStrap : next.lastStrap } });
  }
  const pick = cands[0] ?? null;
  if (pick) {
    if (pick.kind === "strap") {
      next.lastStrapPostAt = now;
      if (strapKnown) next.lastStrap = f.strap.state;
    }
    if (pick.kind === "daily") next.lastDailyDay = today;
    if (pick.kind === "lesson") next.lastLessonDay = today;
    if (pick.kind === "stack") next.lastStackDay = today;
    if (pick.kind === "milestone" && f.milestone) next.milestoneN = f.milestone.n;
  }
  return { pick, candidates: cands, notes, stale: null, capped: false, nextState: next };
}

// ---------------------------------------------------------------- facts (pure over the loaded data)

/** Fees realized on this book (claims plus the fee legs of closes) and how many multiples of `step` they crossed. */
export function milestoneOf(rows: readonly LedgerRow[], source: TalkSource, step: number, now: number): MilestoneFacts | null {
  const mine = rowsForSource(rows, source).filter((r) => r.ts <= now);
  if (!mine.length || !(step > 0)) return null;
  const fees = mine.reduce((t, r) => t + (r.mech === "collect" || r.mech === "close" ? (r.feeSol ?? 0) : 0), 0);
  const firstAt = Math.min(...mine.map((r) => r.ts));
  const all = stackFigures({ rows, source, since: firstAt, until: now });
  return { n: Math.floor(fees / step + 1e-9), step, firstAt, netSol: all.netRealizedSol };
}

export function factsOf(data: TalkData, t: TalkEnv, lessons: readonly Lesson[], o: { paperDesk: boolean; milestoneSol: number }): TickFacts {
  const now = data.now;
  const paper = o.paperDesk || data.source !== "live";
  const staleMs = STALE_CYCLES * t.cycleIntervalSec * 1000;
  const freshAt = data.source === "paper" ? (data.book?.lastMarkAt ?? null) : data.newestEntryAt;
  const staleReason =
    freshAt === null
      ? `no ${data.source === "paper" ? "paper book mark" : "journal entry"} to read`
      : now - freshAt > staleMs
        ? `the newest ${data.source === "paper" ? "paper book mark" : "journal entry"} is ${fmtAge(now - freshAt)} old, more than ${STALE_CYCLES} cycles (${fmtAge(staleMs)})`
        : null;
  const input = strapInputOf(data, t);
  const strap = strapOf({ ...input, positions: input.positions.map((p) => ({ ...p, label: sanitizeLabel(p.label) })) }, t);
  const day = stackFiguresOf(data, DAY, t.cycleIntervalSec);
  const opened = rowsForSource(data.rows, data.source).filter((r) => r.mech === "open" && r.position && r.ts >= now - DAY && r.ts <= now).length;
  const book: PaperBook | null = data.source === "paper" ? data.book : null;
  const mode = data.source === "live" ? "live" : data.source;
  return {
    now,
    source: data.source,
    paper,
    staleReason,
    events: bandEvents(data, t.cycleIntervalSec),
    strap,
    milestone: milestoneOf(data.rows, data.source, o.milestoneSol, now),
    daily: { figures: day, opened, bookSol: book ? bookEquitySol(book).equitySol : null, openBands: book ? book.bands.length : null },
    stack7d: stackFiguresOf(data, 7 * DAY, t.cycleIntervalSec),
    lessons: lessons.filter((l) => l.mode === mode),
    env: t,
  };
}

// ---------------------------------------------------------------- the runner

export type TickStatus = "stopped" | "busy" | "error" | "stale" | "idle" | "capped" | "refused-lint" | "drafted" | "posted" | "not-posted";

export interface TickOutcome {
  status: TickStatus;
  detail: string;
  pick?: Candidate | null;
  violations?: VetViolation[];
  plan?: TickPlan;
  id?: string;
}

export interface TickOptions {
  env?: NodeJS.ProcessEnv;
  /** config.dryRun: the desk is paper */
  paperDesk: boolean;
  now?: number;
  fetch?: XDeps["fetch"];
  force?: ForceKind | null;
  /** the journal tail to read (default 8 MB: the tick needs the newest cycles only) */
  tailBytes?: number;
  cwd?: string;
}

const intEnv = (env: NodeJS.ProcessEnv, key: string, d: number, min: number, max: number) => {
  const raw = (env[key] ?? "").trim();
  const n = raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : d;
};

function appendRow(statePath: string, file: string, row: object): void {
  fs.mkdirSync(statePath, { recursive: true });
  fs.appendFileSync(path.join(statePath, file), JSON.stringify(row) + "\n");
}

export const stopFileOf = (statePath: string) => path.join(statePath, STOP_FILE);

export async function runTick(o: TickOptions): Promise<TickOutcome> {
  const env = o.env ?? process.env;
  const t = talkEnv(env, o.cwd);
  const now = o.now ?? Date.now();
  if (fs.existsSync(stopFileOf(t.statePath))) return { status: "stopped", detail: `${STOP_FILE} is in ${t.statePath}: posting halted` };
  const postsPerDay = Math.floor(intEnv(env, "POSTS_PER_DAY", LOOP_POSTS_PER_DAY, 0, 1000));
  const dailyHourUtc = Math.floor(intEnv(env, "TALK_DAILY_HOUR_UTC", DEFAULT_DAILY_HOUR_UTC, 0, 23));
  const milestoneSol = intEnv(env, "TALK_LOOP_MILESTONE_SOL", DEFAULT_LOOP_MILESTONE_SOL, 1e-9, 1e9);

  const locked = await withLock(path.join(t.statePath, TICK_LOCK_FILE), async (): Promise<TickOutcome> => {
    let st: TickState;
    try {
      st = readTickState(t.statePath);
    } catch (err) {
      return { status: "error", detail: `${TICK_STATE_FILE} cannot be read (${(err as Error).message.slice(0, 80)}); not posting` };
    }
    const data = loadTalkData(t, now, o.tailBytes ?? 8 * 1024 * 1024);
    const lessons = readLessons(path.join(t.dataDir, LESSONS_FILE), now - 2 * DAY);
    const facts = factsOf(data, t, lessons, { paperDesk: o.paperDesk, milestoneSol });
    const plan = planTick(facts, st, loopLogOf(t.statePath, now), { postsPerDay, dailyHourUtc, force: o.force });
    const done = (out: TickOutcome): TickOutcome => {
      writeTickState(t.statePath, plan.nextState);
      return { plan, ...out };
    };
    if (plan.stale) return done({ status: "stale", detail: `data stale, nothing about positions: ${plan.stale}` });
    if (plan.capped) return done({ status: "capped", detail: plan.notes[plan.notes.length - 1] ?? "cap" });
    const pick = plan.pick;
    if (!pick) return done({ status: "idle", detail: plan.notes.length ? plan.notes.join("; ") : "nothing new" });

    const at = new Date(now).toISOString();
    const violations = vetOutgoing(pick.text, { paper: facts.paper, env: t });
    if (violations.length) {
      const reason = `lint: ${violations.map((v) => `${v.rule}: ${v.detail}`).join("; ")}`;
      appendRow(t.statePath, DRAFTS_FILE, { at, type: pick.type, text: pick.text, reason, violations, key: pick.key });
      return done({ status: "refused-lint", detail: reason, pick, violations });
    }
    if (fs.existsSync(stopFileOf(t.statePath))) return { status: "stopped", detail: `${STOP_FILE} appeared before posting: halted`, pick, plan };

    const postEnv = { ...env, POSTS_PER_DAY: String(postsPerDay) };
    const r = await postTweet(pick.text, { type: pick.type, key: pick.key }, { env: postEnv, now, fetch: o.fetch });
    if (r.posted) return done({ status: "posted", detail: `posted ${r.id}`, pick, id: r.id });
    if (r.reason.startsWith("dormant")) {
      appendRow(t.statePath, POSTS_FILE, { id: `draft:${pick.key}`, text: pick.text, type: pick.type, at, replyTo: null, replyToHandle: null, key: pick.key, dry: true });
      return done({ status: "drafted", detail: r.reason, pick });
    }
    return done({ status: "not-posted", detail: r.reason, pick });
  });
  return locked.locked ? locked.value : { status: "busy", detail: `another tick holds ${TICK_LOCK_FILE}` };
}
