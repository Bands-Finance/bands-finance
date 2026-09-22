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
 *   - the tick reads no mentions and posts no replies: replies are the engage loop's (src/talk/engage.ts, its own job)
 *   - a TALK_STOP file in TALK_STATE_PATH stops the tick before anything, and again right before posting (and
 *     postTweet itself refuses while it is there)
 *   - live, the access token must be X_HANDLE's (confirmIdentity, once per token); a transient X failure is retried
 *   - spacing (spacingHold): a gap between posts (plus a per-key jitter for event posts), a rolling window, a night
 *     share, the daily's kept slot; the day's event slots (guards.ts eventCaps): close, open, strap and milestone share
 *     TALK_EVENT_POSTS_PER_DAY, opens and straps have their own share, one pool at most two a day, a losing close
 *     exempt (a loss is never the thing that stays quiet)
 *   - repeats (guards.ts): a milestone that overlaps a post of the last 7 days, or a milestone or lesson restating a
 *     4-decimal figure a milestone or lesson post of the last 24h carried, is a note, not a post; its key stays
 *     unspent and the next candidate goes. An open, a strap or a lesson is never a word-overlap repeat: they are
 *     templated claims about different seats and states (two straddles in two pools share 0.85 to 0.93 of their
 *     words by construction), and the key dedupe, the day's caps and the strap cooldown ration them; a close is
 *     always said, the daily and the stack repeat by design
 *   - craft (src/talk/craft.ts shapePost, through PlanOptions.shape): the text of every candidate is reshaped from
 *     the same facts; null, a throw or a text over 280 means the template here; every shaped text still goes
 *     through paperize and vetOutgoing
 *   - the daily numbers outrank the event kinds from their hour until they have gone (the fixed card at the fixed clock)
 *   - backoff (guards.ts): after 3 transient X refusals in a row the tick does not call X for TALK_RETRY_BACKOFF_MIN
 *     (60) minutes, doubling to 360, kept in tick-state.json; one line per hold, no draft row per held tick
 *   - a close's figures are the band's whole life (bandlife.ts); labels with blocked words read "a pool" (wordguard.ts)
 *   - `--force` only previews: nothing written, recorded or posted
 *   - data older than 3 cycles (the paper book's last mark, or the newest journal entry) posts nothing
 *   - while the desk is paper (DRY_RUN, or a book that is not live), every post says "paper": added if a template
 *     left it out, and a post without it is refused
 *
 * planTick is PURE (facts + state in, one choice out); runTick is the thin runner. Nothing here trades.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LedgerRow } from "../engine/ledger";
import type { JournalEntry } from "../journal";
import { readLessons, LESSONS_FILE, type Lesson } from "../learn/lessons";
import type { PaperBook, PaperSide } from "../paper/book";
import { bookEquitySol } from "../paper/mark";
import { loadTalkData, stackFiguresOf, strapInputOf, type TalkData } from "./data";
import { signedSol, sourceTag, stackUpdate, strapCheck, type DraftResult } from "./drafts";
import { lintContextOf, talkEnv, type TalkEnv } from "./env";
import { linksIn, lintText, weightedLength, MAX_POST_CHARS } from "./lint";
import { withLock } from "./lock";
import { rowsForSource, stackFigures, STALE_CYCLES, fmtAge, strapOf, type StackFigures, type StrapResult, type StrapState, type TalkSource } from "./strap";
import { DRAFTS_FILE, POSTS_FILE, postTweet, readDrafts, readPostLog, retryableReason, TALK_STOP_FILE, whoAmI, xGateProblem, type XDeps, type XPostType } from "./x";
import { bandLifeOf } from "./bandlife";
import { shapePost, type CraftFacts, type DayFigure } from "./craft";
import { backingOff, backoff, DEFAULT_RETRY_BACKOFF_MIN, eventCaps, EVENT_KINDS, jitterMin, markersIn, POOL_EVENT_POSTS_PER_DAY, repeatedStat, selfEcho, STRAP_POSTS_PER_DAY, tooSimilar, type RecentText, type TodayEntry } from "./guards";
import { blockedWordsIn, labelBlocked } from "./wordguard";
import type { Moment } from "./moments";
import type { AskImpl } from "./postBrain";

export { DEFAULT_RETRY_BACKOFF_MIN, POOL_EVENT_POSTS_PER_DAY, STRAP_POSTS_PER_DAY };

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const TICK_STATE_FILE = "tick-state.json";
export const TICK_LOCK_FILE = "tick.lock";
export const STOP_FILE = TALK_STOP_FILE;
/** the loop's own default; POSTS_PER_DAY in the env overrides it */
export const LOOP_POSTS_PER_DAY = 6;
export const DEFAULT_DAILY_HOUR_UTC = 14;
/**
 * Spacing, so the cap is not spent in a burst at 00:00 UTC (8pm EDT) and then silent through the US day:
 *   - at least TALK_MIN_GAP_MIN (90) minutes between two loop posts (dry records count)
 *   - at most TALK_WINDOW_POSTS (2) posts in any rolling TALK_WINDOW_HOURS (6) hours
 *   - at most TALK_NIGHT_POSTS (2) posts before TALK_DAY_START_UTC (12, 8am EDT) on a UTC day
 *   - the last slot of the day is kept for the daily numbers until they have gone
 *   - the once-a-day posts open in the US day: the lesson from TALK_LESSON_HOUR_UTC (18), the Monday stack from
 *     TALK_STACK_HOUR_UTC (15), a fee milestone from TALK_DAY_START_UTC (12); the daily from TALK_DAILY_HOUR_UTC (14)
 *   - an event post (close, open, strap, milestone) waits the gap plus TALK_GAP_JITTER_MIN (45) minutes at most,
 *     the exact number fixed by its key (guards.ts jitterMin; a strap's by the time its change was first seen, since
 *     its key carries the tick), so the 15-minute tick over a flat floor does not print the same 90-105 minute gap
 *     every time; the daily, the lesson and the stack keep the plain gap
 *   - the event kinds share TALK_EVENT_POSTS_PER_DAY (4) of the day's slots, opens TALK_OPEN_POSTS_PER_DAY (2) of
 *     those, straps STRAP_POSTS_PER_DAY (2), one pool POOL_EVENT_POSTS_PER_DAY (2); a losing close passes the
 *     event and pool caps
 * 0 turns a gap, jitter, window, night share or event cap off.
 */
export const DEFAULT_MIN_GAP_MIN = 90;
export const DEFAULT_GAP_JITTER_MIN = 45;
export const DEFAULT_WINDOW_POSTS = 2;
export const DEFAULT_WINDOW_HOURS = 6;
export const DEFAULT_DAY_START_UTC = 12;
export const DEFAULT_NIGHT_POSTS = 2;
export const DEFAULT_LESSON_HOUR_UTC = 18;
export const DEFAULT_STACK_HOUR_UTC = 15;
export const DEFAULT_EVENT_POSTS_PER_DAY = 4;
export const DEFAULT_OPEN_POSTS_PER_DAY = 2;
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
 * then every character that is not a-z or 0-9 removed from each side of the pair. "$PEPE @someone/SOL" reads
 * "pepe/sol"; a label with nothing left, or with a blocked word in it (wordguard.ts: slurs, hate, sexual and scam
 * words, "$SCAM" included), reads "a pool".
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
  // a slur, hate, sexual or scam word in a memecoin symbol is never printed under his name (src/talk/wordguard.ts)
  return sides.length && !labelBlocked(sides.join("/")) ? sides.join("/") : "a pool";
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
  /** a close: over the band's whole life (bandLifeOf in factsOf), or the close leg alone when closeLegOnly */
  netSol?: number;
  feesSol?: number | null;
  closeLegOnly?: boolean;
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
    ...(e.closeLegOnly
      ? [`the close leg alone: ${signedSol(net)} sol${net < 0 ? ", a loss" : ""}.${fees !== null && fees > 0 ? ` fees ${sol4(fees)} sol in that leg.` : ""}`]
      : [net < 0 ? `net ${signedSol(net)} sol, a loss.${feePart}` : `net ${signedSol(net)} sol.${feePart}`]),
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

/**
 * The template lesson. The tokens-left clause is the one optional part: it goes first when the whole runs over
 * 280 (a loss with fees and unsold tokens rendered 287 and the day's lesson was silently refused by the vet).
 */
export function lessonFromSeat(l: Lesson, source: TalkSource): string {
  const label = sanitizeLabel(l.label);
  const inRange = typeof l.inRangePct === "number" ? `, in range ${Math.round(l.inRangePct)}% of checks` : "";
  const left = typeof l.tokensLeftSol === "number" && Math.abs(l.tokensLeftSol) >= 0.00005 ? ` ${sol4(l.tokensLeftSol)} sol of that still in tokens, not sold.` : "";
  const takeaway =
    l.netSol < 0 && l.feesSol > 0 ? "fees came in and the seat still lost. fees are not profit." : l.netSol < 0 ? "a loss, logged like the wins." : "net above zero this time. not every seat is.";
  const render = (tokensLeft: string) =>
    tagged([`what one closed seat taught me: ${label}, ${heldFor(l.minutes * 60)} in the seat${inRange}.`, `fees ${sol4(l.feesSol)} sol, net ${signedSol(l.netSol)} sol.${tokensLeft}`, `${ENDINGS[l.endReason] ?? ENDINGS.close} ${takeaway}`], source);
  const full = render(left);
  // measured with the "(paper)" line planTick may add (no change when the text already says paper)
  return left && loopLength(paperize(full, true)) > MAX_POST_CHARS ? render("") : full;
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
  const words = blockedWordsIn(text);
  if (words.length) v.push({ rule: "loop-words", detail: `a blocked word (slur, hate, sexual or scam): ${words.join(", ")}` });
  for (const l of linksIn(text)) if (!loopLinkAllowed(l)) v.push({ rule: "loop-link", detail: `link not on the loop's allowlist (${LOOP_LINK_HOSTS.join(", ")}): ${l}` });
  if (o.paper && !/\bpaper\b/i.test(text)) v.push({ rule: "loop-paper", detail: 'the desk is paper and the post does not say "paper"' });
  // a draft's own metadata, or an answer returned twice: 37 of Merd's reply and skip drafts reached his timeline this way
  const marker = markersIn(text);
  if (marker) v.push({ rule: "loop-markers", detail: `a draft marker in the text: ${marker}` });
  const echo = selfEcho(text);
  if (echo) v.push({ rule: "self-echo", detail: `a sentence said twice in one post: "${echo.slice(0, 60)}"` });
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
  /** the handle GET /2/users/me confirmed for the access token, and a short sha256 of that token (never the token) */
  confirmedHandle?: string | null;
  confirmedTokenHash?: string | null;
  /** transient X refusals in a row (guards.ts backoff); reset by a post that went or a dormant result */
  transientFails?: number;
  /** the tick does not call X before this (epoch ms): TALK_RETRY_BACKOFF_MIN after the third transient refusal, doubling */
  backoffUntil?: number | null;
  /** when a strap change still waiting behind other posts was first seen (the craft's "last change N ago"); null when none waits */
  strapChangedAt?: number | null;
}

export const emptyTickState = (): TickState => ({ version: 1, lastTickAt: null, lastStrap: null, lastStrapPostAt: null, lastDailyDay: null, lastLessonDay: null, lastStackDay: null, milestoneN: null, confirmedHandle: null, confirmedTokenHash: null, transientFails: 0, backoffUntil: null, strapChangedAt: null });

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
  /** when each post or dry draft in the dedupe window went (ms), for the spacing rules; absent reads as none */
  times?: number[];
  /** the loop's records on the current UTC day, with their key and type, for the event caps (guards.ts eventCaps); absent reads as none */
  todayEntries?: TodayEntry[];
  /** the loop's records on the current UTC day counted by record type (open, close, strap, ...); absent reads as none */
  todayByType?: Record<string, number>;
  /** the texts the loop posted or drafted in the dedupe window (dry records included), for the repeat guards; absent reads as none */
  recentTexts?: RecentText[];
}

export function loopLogOf(statePath: string, now: number): LoopLog {
  const since = now - DEDUPE_MS;
  const seen = new Set<string>();
  let postsToday = 0;
  const times: number[] = [];
  const todayEntries: TodayEntry[] = [];
  const todayByType: Record<string, number> = {};
  const recentTexts: RecentText[] = [];
  for (const p of readPostLog(statePath)) {
    const at = Date.parse(p.at);
    if (!(at >= since)) continue;
    if (p.key) seen.add(p.key);
    if (!p.replyToHandle) times.push(at);
    if (!p.replyTo && utcDay(at) === utcDay(now)) {
      postsToday += 1;
      todayEntries.push({ key: p.key ?? null, type: p.type });
      todayByType[p.type] = (todayByType[p.type] ?? 0) + 1;
    }
    if (!p.replyTo && typeof p.text === "string") recentTexts.push({ at, text: p.text, key: p.key ?? null, type: p.type });
  }
  // a draft refused for a transient reason (X down, 429, the rate lock busy, the stop file) is not used: retried
  for (const d of readDrafts(statePath)) {
    const at = Date.parse(d.at);
    if (!(at >= since)) continue;
    if (d.key && !d.retry) seen.add(d.key);
    // a text the lint refused was never seen, and one to be retried would be compared with itself: neither is a recent text
    if (!d.replyTo && !d.retry && !/^lint:/.test(d.reason) && typeof d.text === "string") recentTexts.push({ at, text: d.text, key: d.key ?? null, type: d.type });
  }
  return { seen, postsToday, times, todayEntries, todayByType, recentTexts };
}

// ---------------------------------------------------------------- the plan (pure)

/**
 * What the journal says about the cycle that closed a band: the action his model proposed and the one the guards
 * decided, the engine directive that applied, and how many bins price sat outside the band. Null when the journal
 * tail does not hold that cycle; a line built on these is omitted then, never invented.
 */
export interface CloseContext {
  /** his proposal on that cycle; null on a directive cycle, where the model is not called and the journal's proposal is the engine's own decision */
  proposed: string | null;
  decided: string | null;
  directive: string | null;
  /** who answered that cycle (the journal's llm.source: "llm", "policy", "engine", "proposal", "fallback"); the craft words a policy close as his own rule's */
  source: string | null;
  /** the position's binsFromRange at the close: 0 in range, negative below, positive above */
  binsOut: number | null;
}

export const NO_CLOSE_CONTEXT: CloseContext = { proposed: null, decided: null, directive: null, source: null, binsOut: null };

/** The craft hook (src/talk/craft.ts shapePost): the shaped text for a candidate, or null to keep the template. */
export type ShapePost = typeof shapePost;
export type { CraftFacts, DayFigure };

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
  /** day N of the run (see CraftFacts.dayN) */
  dayN: number | null;
  /** the last 7 UTC days' figures, oldest first */
  recent: DayFigure[];
  /** every UTC day of the run with ledger rows, oldest first (the milestone's best and most recent day) */
  days: DayFigure[];
  /** the closing cycle's journal context by band address */
  closes: Record<string, CloseContext>;
}

export interface Candidate {
  kind: TickKind;
  key: string;
  at: number;
  text: string;
  type: XPostType;
  /** the pool an open or close is about, for the per-pool cap */
  pool?: string | null;
  /** a close that lost: passes the event and pool caps */
  loss?: boolean;
  /** the key the gap jitter is seeded on when it must differ from `key`: a strap's key carries the tick, and a jitter rolled again every tick is no jitter */
  jitterKey?: string;
}

export interface TickPlan {
  pick: Candidate | null;
  candidates: Candidate[];
  /** why something that could have been a post is not one */
  notes: string[];
  stale: string | null;
  capped: boolean;
  /** held by a spacing rule (the gap, the window, the night share, the daily's kept slot): the candidates wait */
  spaced: boolean;
  /** the state to write whatever happens to the pick; planTick already advanced the gate of the picked kind */
  nextState: TickState;
}

export interface PlanOptions {
  postsPerDay: number;
  dailyHourUtc: number;
  force?: ForceKind | null;
  /** the spacing rules; each absent one takes its DEFAULT_* above */
  minGapMin?: number;
  /** an event post waits the gap plus 0..this minutes, fixed by its key (0: off) */
  gapJitterMin?: number;
  windowPosts?: number;
  windowHours?: number;
  dayStartUtc?: number;
  nightPosts?: number;
  lessonHourUtc?: number;
  stackHourUtc?: number;
  /** the day's event slots (close, open, strap, milestone) and the opens' share of them (0: off) */
  eventPostsPerDay?: number;
  openPostsPerDay?: number;
  /** the daily numbers end with mrbands.finance (TALK_DAILY_LINK=true); off by default: a post with a URL costs 13x on X pay-per-use */
  dailyLink?: boolean;
  /** the craft hook (src/talk/craft.ts shapePost); absent or null from it: the template */
  shape?: ShapePost | null;
}

const isEventKind = (k: TickKind): boolean => (EVENT_KINDS as readonly string[]).includes(k);

export function planTick(f: TickFacts, st: TickState, log: LoopLog, o: PlanOptions): TickPlan {
  const now = f.now;
  const today = utcDay(now);
  const next: TickState = { ...st, lastTickAt: now };
  const notes: string[] = [];
  const strapKnown = f.strap.state !== "unknown";
  const empty = (extra: Partial<TickPlan> = {}): TickPlan => {
    const plan: TickPlan = { pick: null, candidates: [], notes, stale: null, capped: false, spaced: false, nextState: next, ...extra };
    plan.nextState = { ...plan.nextState, strapChangedAt: strapChangedAt(plan.nextState, st, f, strapKnown && !f.staleReason, now) };
    return plan;
  };
  const hour = new Date(now).getUTCHours();
  const dayStartUtc = o.dayStartUtc ?? DEFAULT_DAY_START_UTC;
  if (f.staleReason) return empty({ stale: f.staleReason });

  const seen = new Set(log.seen);
  // a close that was posted covers the re-laid open in the same pool
  for (const e of f.events) if (e.kind === "close" && e.relaidKey && seen.has(e.key)) seen.add(e.relaidKey);
  const cands: Candidate[] = [];
  const common = { now, source: f.source, paper: f.paper, recent: f.recent };
  /**
   * The craft hook's text for a candidate, or the template; a hook that throws, or a text over 280 with the paper
   * line counted (a refused text spends the key and a fixed card is lost for the day), is a note and the template goes.
   */
  const shaped = (kind: TickKind, key: string, template: string, facts: Omit<CraftFacts, keyof typeof common | "seed">): string => {
    if (!o.shape) return template;
    try {
      const text = o.shape(kind, { ...common, seed: key, ...facts }) ?? template;
      const len = loopLength(paperize(text, f.paper));
      if (len > MAX_POST_CHARS) {
        notes.push(`craft: ${kind} ${key} ran ${len} characters, over ${MAX_POST_CHARS}; the template goes`);
        return template;
      }
      return text;
    } catch (err) {
      notes.push(`craft: ${kind} ${key} fell back to the template (${(err as Error).message.slice(0, 80)})`);
      return template;
    }
  };
  const add = (kind: TickKind, key: string, at: number, type: XPostType, text: string, extra: Pick<Candidate, "pool" | "loss" | "jitterKey"> = {}) => cands.push({ kind, key, at, type, text: paperize(text, f.paper), ...extra });
  const closeContext = (address: string): CloseContext => f.closes[address] ?? NO_CLOSE_CONTEXT;
  const force = o.force ?? null;
  const poolByKey = new Map(f.events.map((e) => [e.key, e.pool] as const));
  const recentTexts = log.recentTexts ?? [];
  /**
   * Why a candidate repeats a recent post (guards.ts): for a milestone, word overlap with a loop text of the last 7
   * days (never with an earlier milestone: a new round level in the same form is a new fact, not a reworded claim);
   * for a milestone or a lesson, a 4-decimal figure a milestone or lesson post of the last 24h carried (a lesson
   * repeating the milestone's net is the case it is for). A candidate is never compared with its own key's earlier
   * record. Not compared, by design: an open, a strap or a lesson against the loop's other texts (templated claims
   * about different seats and states share most of their words whatever the pool; the key dedupe, the day's caps
   * and the strap cooldown ration them), and any figure against a close, an open or a strap (a fee figure two seats
   * share is a coincidence, not a talking point twice; the lesson's figures are its own close's by bandlife.ts).
   */
  const repeatReason = (kind: TickKind, key: string, text: string): string | null => {
    const others = recentTexts.filter((r) => r.key !== key);
    if (kind === "milestone") {
      const sim = tooSimilar(text, others.filter((r) => r.type !== "milestone"));
      if (sim) return `repeat: ${kind} ${key} has ${sim.score.toFixed(2)} overlap with the ${sim.hit.type ?? "post"} of ${shortDate(sim.hit.at)}; the key stays unspent`;
    }
    if (kind === "milestone" || kind === "lesson") {
      const day = others.filter((r) => now - r.at <= DAY && (r.type === "milestone" || r.type === "lesson"));
      const stat = repeatedStat(text, day);
      if (stat) return `repeat: ${kind} ${key} restates ${stat.stat} from the ${stat.hit.type ?? "post"} of ${shortDate(stat.hit.at)}; the key stays unspent`;
    }
    return null;
  };

  if (!force) {
    const fresh = f.events.filter((e) => now - e.at <= EVENT_FRESH_MS && e.at <= now && !seen.has(e.key));
    const relaid = new Set(fresh.filter((e) => e.kind === "close" && e.relaidKey).map((e) => e.relaidKey!));
    for (const e of fresh) {
      if (e.kind === "close") add("close", e.key, e.at, "close", shaped("close", e.key, closeText(e, f.source), { event: { ...e, ...closeContext(e.key.slice("close:".length)), openBands: f.daily.openBands } }), { pool: e.pool, loss: (e.netSol ?? 0) < 0 });
      else if (!relaid.has(e.key)) add("open", e.key, e.at, "open", shaped("open", e.key, openText(e, f.source), { event: { ...e, openBands: f.daily.openBands } }), { pool: e.pool });
    }
  }

  // the strap memory moves to the current state unless a change is waiting behind a higher-priority post
  // (then it stays, so the change is still a change next tick; a state that flips back simply stops being one)
  if (strapKnown) next.lastStrap = f.strap.state;
  if (force === "strap" || (!force && strapKnown && st.lastStrap && st.lastStrap !== f.strap.state)) {
    if (!force && st.lastStrapPostAt !== null && now - st.lastStrapPostAt < STRAP_COOLDOWN_MS) notes.push(`strap: ${st.lastStrap} to ${f.strap.state}, but a strap post went out ${fmtAge(now - st.lastStrapPostAt)} ago`);
    else {
      const key = `strap:${st.lastStrap ?? "none"}>${f.strap.state}:${Math.floor(now / (15 * MIN))}`;
      const d = strapCheck(f.strap, { source: f.source, now, env: f.env });
      if (d.ok) {
        // a change that waited behind other posts keeps the time it was first seen (strapChangedAt); the jitter is
        // seeded on that time, not on the key's tick slot, so a waiting strap's wait is the same on every tick
        const changedAt = st.strapChangedAt ?? now;
        add("strap", key, now, d.type, shaped("strap", key, d.text, { strap: { ...f.strap, sinceMs: now - changedAt } }), { jitterKey: `strap:${st.lastStrap ?? "none"}>${f.strap.state}:${changedAt}` });
        if (!force) next.lastStrap = st.lastStrap;
      } else notes.push(`strap: ${d.reason}${d.violations.length ? ` (${d.violations.map((v) => v.rule).join(", ")})` : ""}`);
    }
  }

  if (!force && f.milestone) {
    if (st.milestoneN === null || f.milestone.n < st.milestoneN) next.milestoneN = f.milestone.n;
    else if (f.milestone.n > st.milestoneN && hour >= dayStartUtc) {
      const key = `milestone:${f.source}:${+(f.milestone.n * f.milestone.step).toFixed(4)}`;
      // completed days only: today's partial day is neither the best day nor the most recent one
      const past = f.days.filter((d) => d.day < today);
      const bestDay = past.length ? past.reduce((b, d) => (d.feesSol > b.feesSol ? d : b)) : null;
      const lastDay = past.length ? past[past.length - 1] : null;
      add("milestone", key, now, "milestone", shaped("milestone", key, milestoneText(f.milestone, f.source), { milestone: { ...f.milestone, bestDay, lastDay } }));
    }
  }

  if (force === "daily" || (!force && hour >= o.dailyHourUtc && st.lastDailyDay !== today)) {
    const key = `daily:${today}`;
    if (!force && seen.has(key)) next.lastDailyDay = today;
    else {
      const plain = shaped("daily", key, dailyText(f.daily, false), { daily: { ...f.daily, dayN: f.dayN, recent: f.recent } });
      const withLink = `${plain}\nmrbands.finance`;
      add("daily", key, now, "daily", o.dailyLink && loopLength(paperize(withLink, f.paper)) <= MAX_POST_CHARS ? withLink : plain);
    }
  }

  if (force === "lesson" || (!force && hour >= (o.lessonHourUtc ?? DEFAULT_LESSON_HOUR_UTC) && st.lastLessonDay !== today)) {
    // the most telling seat closed in the last 24h (the biggest net either way); a seat whose lesson would repeat a
    // recent post falls through to the next unseen seat; a forced lesson falls back to one already used
    const unseen = (l: Lesson) => !seen.has(`lesson:${l.position}`);
    const recent = f.lessons.filter((l) => !l.ask && now - l.closedAt <= DAY && l.closedAt <= now && (force || unseen(l)));
    recent.sort((a, b) => Number(unseen(b)) - Number(unseen(a)) || Math.abs(b.netSol) - Math.abs(a.netSol) || b.closedAt - a.closedAt);
    let picked = false;
    for (const l of recent) {
      const key = `lesson:${l.position}`;
      const text = paperize(shaped("lesson", key, lessonFromSeat(l, f.source), { lesson: { ...l, ...closeContext(l.position) } }), f.paper);
      const why = force ? null : repeatReason("lesson", key, text);
      if (why) {
        notes.push(why);
        continue;
      }
      add("lesson", key, l.closedAt, "lesson", text);
      picked = true;
      break;
    }
    if (!picked && force) notes.push("lesson: no seat closed in the last 24h");
  }

  if (force === "stack" || (!force && new Date(now).getUTCDay() === 1 && hour >= (o.stackHourUtc ?? DEFAULT_STACK_HOUR_UTC) && st.lastStackDay !== today)) {
    const key = `stack:${today}`;
    if (!force && seen.has(key)) next.lastStackDay = today;
    else {
      const d = stackUpdate(f.stack7d, { env: f.env });
      if (d.ok) add("stack", key, now, d.type, shaped("stack", key, d.text, { stack: f.stack7d }));
      else notes.push(`stack: ${d.reason}${d.violations.length ? ` (${d.violations.map((v) => v.rule).join(", ")})` : ""}`);
    }
  }

  // a strap change dropped by a cap is one story already told: the memory moves on
  let strapDropped = false;
  if (!force) {
    // repeats: a note, not a draft row, and the key stays unspent; only the milestone (see repeatReason)
    for (let i = cands.length - 1; i >= 0; i--) {
      const c = cands[i];
      if (c.kind !== "milestone") continue;
      const why = repeatReason(c.kind, c.key, c.text);
      if (!why) continue;
      notes.push(why);
      cands.splice(i, 1);
    }
  }

  // the daily numbers outrank the event kinds from their hour until they have gone: the fixed card at the fixed clock
  const rank = (k: TickKind) => (k === "daily" ? -1 : PRIORITY.indexOf(k));
  cands.sort((a, b) => rank(a.kind) - rank(b.kind) || a.at - b.at);
  const strapWaits = () => cands.some((c) => c.kind === "strap") && !force;
  if (cands.length && log.postsToday >= o.postsPerDay) {
    notes.push(`cap: ${log.postsToday} posts today, POSTS_PER_DAY is ${o.postsPerDay}; ${cands.length} candidate(s) wait`);
    // nothing was used: a waiting strap change stays a change
    return empty({ candidates: cands, capped: true, nextState: { ...next, lastStrap: strapWaits() ? st.lastStrap : next.lastStrap } });
  }
  if (cands.length && !force) {
    const caps = eventCaps(log.todayEntries ?? [], cands, (key) => poolByKey.get(key) ?? null, { eventPostsPerDay: o.eventPostsPerDay ?? DEFAULT_EVENT_POSTS_PER_DAY, openPostsPerDay: o.openPostsPerDay ?? DEFAULT_OPEN_POSTS_PER_DAY });
    notes.push(...caps.notes);
    if (cands.some((c) => c.kind === "strap") && !caps.eligible.some((c) => c.kind === "strap")) strapDropped = true;
    if (!caps.eligible.length) return empty({ candidates: cands, capped: true, nextState: { ...next, lastStrap: strapKnown && strapDropped ? f.strap.state : next.lastStrap } });
    cands.splice(0, cands.length, ...caps.eligible);
  }
  if (strapKnown && strapDropped && !strapWaits()) next.lastStrap = f.strap.state;
  if (cands.length && !force) {
    const held = spacingHold(cands, st, log, o, now, today, hour, dayStartUtc);
    notes.push(...held.notes);
    if (held.reason) {
      notes.push(`spaced: ${held.reason}; ${cands.length} candidate(s) wait`);
      return empty({ candidates: cands, spaced: true, nextState: { ...next, lastStrap: strapWaits() ? st.lastStrap : next.lastStrap } });
    }
    cands.splice(0, cands.length, ...held.eligible);
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
  next.strapChangedAt = strapChangedAt(next, st, f, strapKnown, now);
  return { pick, candidates: cands, notes, stale: null, capped: false, spaced: false, nextState: next };
}

/** When the strap change still waiting in `next` was first seen: kept from the last tick, or now; null when no change waits. */
const strapChangedAt = (next: TickState, st: TickState, f: TickFacts, strapKnown: boolean, now: number): number | null => (strapKnown && next.lastStrap && next.lastStrap !== f.strap.state ? (st.strapChangedAt ?? now) : null);

/**
 * PURE. Whether the spacing rules hold every candidate this tick (a reason), and otherwise which candidates may go:
 * the gap is per candidate (an event kind waits the gap plus its key's jitter; the daily, the lesson and the stack
 * the plain gap), the window holds everything but the daily numbers (the fixed card at the fixed clock: Merd's
 * print landed within 12 minutes of its gate 6 of 6 times, and it was the one shape people bookmarked), the night
 * share holds everything, and while the daily has not gone today the day's last slot is theirs. `notes` says which
 * candidates a rule held while others may go.
 */
export function spacingHold(cands: readonly Candidate[], st: TickState, log: LoopLog, o: PlanOptions, now: number, today: string, hour: number, dayStartUtc: number): { reason: string | null; eligible: Candidate[]; notes: string[] } {
  const times = (log.times ?? []).filter((at) => at <= now);
  const last = times.length ? Math.max(...times) : null;
  const gapMin = o.minGapMin ?? DEFAULT_MIN_GAP_MIN;
  const jitter = o.gapJitterMin ?? DEFAULT_GAP_JITTER_MIN;
  const notes: string[] = [];
  let pool = [...cands];
  if (gapMin > 0 && last !== null) {
    const since = now - last;
    const waitOf = (c: Candidate) => gapMin + (isEventKind(c.kind) ? jitterMin(c.jitterKey ?? c.key, jitter) : 0);
    const held = pool.filter((c) => since < waitOf(c) * MIN);
    if (held.length === pool.length) {
      const c = held[0];
      const extra = waitOf(c) - gapMin;
      return { reason: `the last post went ${fmtAge(since)} ago, TALK_MIN_GAP_MIN is ${gapMin}${extra > 0 ? ` plus ${extra} min of jitter for the ${c.kind}` : ""}`, eligible: [], notes };
    }
    for (const c of held) notes.push(`gap: ${c.kind} ${c.key} waits ${waitOf(c)} min after the last post (${fmtAge(since)} ago)`);
    pool = pool.filter((c) => !held.includes(c));
  }
  const windowPosts = o.windowPosts ?? DEFAULT_WINDOW_POSTS;
  const windowHours = o.windowHours ?? DEFAULT_WINDOW_HOURS;
  if (windowPosts > 0 && windowHours > 0) {
    const inWindow = times.filter((at) => now - at < windowHours * HOUR).length;
    if (inWindow >= windowPosts) {
      const daily = pool.filter((c) => c.kind === "daily");
      if (!daily.length) return { reason: `${inWindow} posts in the last ${windowHours}h, TALK_WINDOW_POSTS is ${windowPosts}`, eligible: [], notes };
      for (const c of pool) if (c.kind !== "daily") notes.push(`window: ${c.kind} ${c.key} waits, ${inWindow} posts in the last ${windowHours}h; the daily numbers pass`);
      pool = daily;
    }
  }
  const nightPosts = o.nightPosts ?? DEFAULT_NIGHT_POSTS;
  if (nightPosts > 0 && hour < dayStartUtc) {
    const night = times.filter((at) => utcDay(at) === today).length;
    if (night >= nightPosts) return { reason: `${night} posts before ${dayStartUtc}:00 UTC, TALK_NIGHT_POSTS is ${nightPosts}`, eligible: [], notes };
  }
  const dailyWaiting = st.lastDailyDay !== today && !log.seen.has(`daily:${today}`);
  if (dailyWaiting && o.postsPerDay >= 2 && log.postsToday >= o.postsPerDay - 1) {
    const eligible = pool.filter((c) => c.kind === "daily");
    return eligible.length ? { reason: null, eligible, notes } : { reason: `the day's last slot is kept for the daily numbers (${log.postsToday} of ${o.postsPerDay} used)`, eligible: [], notes };
  }
  return { reason: null, eligible: pool, notes };
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

/** This book's realized figures per UTC day from `since` (its first row) to `until`, oldest first, days without rows left out. */
export function dayFiguresOf(rows: readonly LedgerRow[], source: TalkSource, since: number, until: number): DayFigure[] {
  const out: DayFigure[] = [];
  for (let day = Date.parse(utcDay(since)); day <= until; day += DAY) {
    const f = stackFigures({ rows, source, since: Math.max(day, since), until: Math.min(day + DAY - 1, until) });
    if (f.days > 0) out.push({ day: utcDay(day), feesSol: f.feesRealizedSol, netSol: f.netRealizedSol, closed: f.closedBands });
  }
  return out;
}

/** Day N of a run: UTC days from the day of its first row to the day of `now`, the first day being 1. */
export const dayNumberOf = (firstAt: number, now: number): number => Math.floor((Date.parse(utcDay(now)) - Date.parse(utcDay(firstAt))) / DAY) + 1;

/**
 * The closing cycle's journal context by band address: what was proposed, decided and directed, who answered, and
 * where price sat. On a directive cycle (src/index.ts: `engineDecideResult` stands in for the model) the entry's
 * proposal is the engine's own CLOSE_POSITION with llm.source "engine", so `proposed` is null there: the loop never
 * says "i had proposed the close" about a close it did not propose.
 */
export function closeContextsOf(entries: readonly JournalEntry[]): Record<string, CloseContext> {
  const out: Record<string, CloseContext> = {};
  for (const e of entries) {
    const closed = e.execution?.ok ? e.execution.closed : undefined;
    if (!closed) continue;
    const pos = e.positions.find((p) => p.address === closed);
    const source = e.llm?.source ?? null;
    out[closed] = { proposed: source === "engine" ? null : (e.proposal?.action ?? null), decided: e.decision?.action ?? null, directive: e.engine?.directive ?? null, source, binsOut: typeof pos?.binsFromRange === "number" ? pos.binsFromRange : null };
  }
  return out;
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
  const bookLessons = lessons.filter((l) => l.mode === mode);
  const bookRows = rowsForSource(data.rows, data.source);
  // a close says the band's whole life (claims while it was open included), the same figures its lesson gives
  const events = bandEvents(data, t.cycleIntervalSec).map((e) => {
    if (e.kind !== "close") return e;
    const pos = e.key.slice("close:".length);
    const life = bandLifeOf({ position: pos, pool: e.pool, openedAt: null, closedAt: e.at, rows: bookRows, lessons: bookLessons, closeLeg: { netSol: e.netSol ?? 0, feesSol: e.feesSol ?? null } });
    return { ...e, netSol: life.netSol, feesSol: life.feesSol, closeLegOnly: life.closeLegOnly };
  });
  const milestone = milestoneOf(data.rows, data.source, o.milestoneSol, now);
  const days = milestone ? dayFiguresOf(data.rows, data.source, milestone.firstAt, now) : [];
  return {
    now,
    source: data.source,
    paper,
    staleReason,
    events,
    strap,
    milestone,
    daily: { figures: day, opened, bookSol: book ? bookEquitySol(book).equitySol : null, openBands: book ? book.bands.length : null },
    stack7d: stackFiguresOf(data, 7 * DAY, t.cycleIntervalSec),
    lessons: bookLessons,
    env: t,
    dayN: milestone ? dayNumberOf(milestone.firstAt, now) : null,
    recent: days.filter((d) => Date.parse(d.day) > now - 7 * DAY),
    days,
    closes: closeContextsOf(data.journal.entries),
  };
}

// ---------------------------------------------------------------- the runner

export type TickStatus = "stopped" | "busy" | "error" | "stale" | "idle" | "capped" | "spaced" | "refused-lint" | "preview" | "drafted" | "posted" | "not-posted" | "backoff";

export interface TickOutcome {
  status: TickStatus;
  detail: string;
  pick?: Candidate | null;
  violations?: VetViolation[];
  plan?: TickPlan;
  id?: string;
  /** the builder voice (src/talk/builder.ts): the moment picked, its text, and who wrote it */
  moment?: Moment | null;
  text?: string;
  source?: "model" | "template";
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
  /** the craft hook; absent: src/talk/craft.ts shapePost; null: the templates in this file */
  shape?: ShapePost | null;
  /**
   * "builder" (the default, TALK_VOICE unset): the builder voice, src/talk/builder.ts. "ledger" (TALK_VOICE=ledger):
   * the older lowercase ledger cards below (close, open, strap, milestone, daily, lesson, stack), kept for a rollback.
   */
  voice?: "builder" | "ledger";
  /** the builder voice's transport to his agent (tests hand in a fake) */
  askImpl?: AskImpl;
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

/** A short sha256 of the access token: enough to notice a new token, never the token. */
export const tokenHashOf = (token: string) => crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);

/**
 * Whether the access token posts as X_HANDLE. Asked of X (GET /2/users/me) once per token and handle; the answer
 * is kept in tick-state.json as the handle and a hash of the token, and asked again when either changes.
 */
export async function confirmIdentity(st: TickState, t: TalkEnv, env: NodeJS.ProcessEnv, now: number, fetchImpl?: XDeps["fetch"]): Promise<{ ok: true; handle: string; tokenHash: string } | { ok: false; reason: string; transient: boolean }> {
  const tokenHash = tokenHashOf((env.X_ACCESS_TOKEN ?? "").trim());
  if (st.confirmedHandle && st.confirmedHandle === t.xHandle && st.confirmedTokenHash === tokenHash) return { ok: true, handle: st.confirmedHandle, tokenHash };
  const me = await whoAmI({ env, now, fetch: fetchImpl });
  if (!me.ok) return { ok: false, reason: `identity: could not check whose account the access token is for (${me.reason}); not posting (will retry)`, transient: retryableReason(me.reason) };
  if (me.handle !== t.xHandle) return { ok: false, reason: `identity: the access token is for @${me.handle}, not X_HANDLE @${t.xHandle}; regenerate it signed in as his account; not posting`, transient: false };
  return { ok: true, handle: me.handle, tokenHash };
}

export async function runTick(o: TickOptions): Promise<TickOutcome> {
  const env = o.env ?? process.env;
  const t = talkEnv(env, o.cwd);
  const now = o.now ?? Date.now();
  if (fs.existsSync(stopFileOf(t.statePath))) return { status: "stopped", detail: `${STOP_FILE} is in ${t.statePath}: posting halted` };
  const postsPerDay = Math.floor(intEnv(env, "POSTS_PER_DAY", LOOP_POSTS_PER_DAY, 0, 1000));
  const dailyHourUtc = Math.floor(intEnv(env, "TALK_DAILY_HOUR_UTC", DEFAULT_DAILY_HOUR_UTC, 0, 23));
  const milestoneSol = intEnv(env, "TALK_LOOP_MILESTONE_SOL", DEFAULT_LOOP_MILESTONE_SOL, 1e-9, 1e9);
  const retryBackoffMin = intEnv(env, "TALK_RETRY_BACKOFF_MIN", DEFAULT_RETRY_BACKOFF_MIN, 0, 24 * 60);
  const shape = o.shape === undefined ? shapePost : (o.shape ?? undefined);
  const planOpts: PlanOptions = {
    postsPerDay,
    dailyHourUtc,
    force: o.force,
    shape,
    minGapMin: intEnv(env, "TALK_MIN_GAP_MIN", DEFAULT_MIN_GAP_MIN, 0, 24 * 60),
    gapJitterMin: Math.floor(intEnv(env, "TALK_GAP_JITTER_MIN", DEFAULT_GAP_JITTER_MIN, 0, 24 * 60)),
    eventPostsPerDay: Math.floor(intEnv(env, "TALK_EVENT_POSTS_PER_DAY", DEFAULT_EVENT_POSTS_PER_DAY, 0, 1000)),
    openPostsPerDay: Math.floor(intEnv(env, "TALK_OPEN_POSTS_PER_DAY", DEFAULT_OPEN_POSTS_PER_DAY, 0, 1000)),
    windowPosts: Math.floor(intEnv(env, "TALK_WINDOW_POSTS", DEFAULT_WINDOW_POSTS, 0, 1000)),
    windowHours: intEnv(env, "TALK_WINDOW_HOURS", DEFAULT_WINDOW_HOURS, 0, 24),
    dayStartUtc: Math.floor(intEnv(env, "TALK_DAY_START_UTC", DEFAULT_DAY_START_UTC, 0, 23)),
    nightPosts: Math.floor(intEnv(env, "TALK_NIGHT_POSTS", DEFAULT_NIGHT_POSTS, 0, 1000)),
    lessonHourUtc: Math.floor(intEnv(env, "TALK_LESSON_HOUR_UTC", DEFAULT_LESSON_HOUR_UTC, 0, 23)),
    stackHourUtc: Math.floor(intEnv(env, "TALK_STACK_HOUR_UTC", DEFAULT_STACK_HOUR_UTC, 0, 23)),
    dailyLink: (env.TALK_DAILY_LINK ?? "").trim() === "true",
  };

  const locked = await withLock(path.join(t.statePath, TICK_LOCK_FILE), async (): Promise<TickOutcome> => {
    let st: TickState;
    try {
      st = readTickState(t.statePath);
    } catch (err) {
      return { status: "error", detail: `${TICK_STATE_FILE} cannot be read (${(err as Error).message.slice(0, 80)}); not posting` };
    }
    // a hold after transient X refusals: no data read, no plan, no draft row, nothing used; a preview still runs
    if (!o.force && backingOff(st, now)) {
      writeTickState(t.statePath, { ...st, lastTickAt: now });
      return { status: "backoff", detail: `x: backing off until ${new Date(st.backoffUntil!).toISOString().slice(11, 16)} utc after ${st.transientFails ?? 0} transient failures in a row; nothing sent this tick` };
    }
    const voice = o.voice ?? ((env.TALK_VOICE ?? "").trim() === "ledger" ? "ledger" : "builder");
    if (voice === "builder") {
      const { runBuilderTick } = await import("./builder.js");
      const r = await runBuilderTick({ t, env, now, st, paperDesk: o.paperDesk, force: !!o.force, postsPerDay, dailyHourUtc, retryBackoffMin, fetch: o.fetch, askImpl: o.askImpl, cwd: o.cwd, tailBytes: o.tailBytes });
      const { state, ...out } = r;
      if (!o.force) writeTickState(t.statePath, state);
      return out;
    }
    const data = loadTalkData(t, now, o.tailBytes ?? 8 * 1024 * 1024);
    const lessons = readLessons(path.join(t.dataDir, LESSONS_FILE), now - 2 * DAY);
    const facts = factsOf(data, t, lessons, { paperDesk: o.paperDesk, milestoneSol });
    const plan = planTick(facts, st, loopLogOf(t.statePath, now), planOpts);
    const done = (out: TickOutcome, state: TickState = plan.nextState): TickOutcome => {
      writeTickState(t.statePath, state);
      return { plan, ...out };
    };
    // nothing was used: the next tick plans again from the same state (the gates did not move)
    const untouched = (): TickState => ({ ...st, lastTickAt: now });
    if (o.force) {
      // a preview: the vetted text, and nothing written, recorded or posted (the real gates and keys stay unspent);
      // over the cap it still shows what would have gone
      const pick = plan.pick ?? plan.candidates[0] ?? null;
      if (!pick) return { status: "preview", detail: `nothing to preview${plan.notes.length ? `: ${plan.notes.join("; ")}` : ""}`, pick: null, plan };
      const v = vetOutgoing(pick.text, { paper: facts.paper, env: t });
      return { status: "preview", detail: v.length ? `preview only, and it would be refused: ${v.map((x) => x.rule).join(", ")}` : `preview only: nothing posted, drafted or recorded${plan.capped ? `; ${plan.notes[plan.notes.length - 1]}` : ""}`, pick, plan, ...(v.length ? { violations: v } : {}) };
    }
    const pick = plan.pick;
    if (plan.stale) return done({ status: "stale", detail: `data stale, nothing about positions: ${plan.stale}` });
    if (plan.capped) return done({ status: "capped", detail: plan.notes[plan.notes.length - 1] ?? "cap" });
    if (plan.spaced) return done({ status: "spaced", detail: plan.notes[plan.notes.length - 1] ?? "spaced" });
    if (!pick) return done({ status: "idle", detail: plan.notes.length ? plan.notes.join("; ") : "nothing new" });

    const at = new Date(now).toISOString();
    const violations = vetOutgoing(pick.text, { paper: facts.paper, env: t });
    if (violations.length) {
      const reason = `lint: ${violations.map((v) => `${v.rule}: ${v.detail}`).join("; ")}`;
      appendRow(t.statePath, DRAFTS_FILE, { at, type: pick.type, text: pick.text, reason, violations, key: pick.key });
      return done({ status: "refused-lint", detail: reason, pick, violations });
    }
    if (fs.existsSync(stopFileOf(t.statePath))) return { status: "stopped", detail: `${STOP_FILE} appeared before posting: halted`, pick, plan };

    /**
     * The backoff counter after an X result (guards.ts backoff): a transient refusal counts, the third in a row
     * starts a hold (TALK_RETRY_BACKOFF_MIN, doubling to 360 min), a post that went or a dormant result clears it.
     * Merd retried one 402 every 15 minutes for 14 hours; the hold is the one loud line instead.
     */
    const afterX = (result: "posted" | "dormant" | "transient" | "other", reason: string): { state: Pick<TickState, "transientFails" | "backoffUntil">; detail: string | null } => {
      const b = backoff({ transientFails: st.transientFails ?? 0, backoffUntil: st.backoffUntil ?? null }, result, now, retryBackoffMin);
      const state = { transientFails: b.transientFails, backoffUntil: b.backoffUntil };
      return { state, detail: b.heldMin > 0 ? `x: ${b.transientFails} transient failures in a row (${reason}), backing off ${b.heldMin} min` : null };
    };

    // live: the access token must speak for X_HANDLE (a token made on the operator's own account would post as him)
    let confirmed: Pick<TickState, "confirmedHandle" | "confirmedTokenHash"> = {};
    if (xGateProblem(t) === null) {
      const id = await confirmIdentity(st, t, env, now, o.fetch);
      if (!id.ok) {
        appendRow(t.statePath, DRAFTS_FILE, { at, type: pick.type, text: pick.text, reason: id.reason });
        const x = afterX(id.transient ? "transient" : "other", id.reason);
        return done({ status: "not-posted", detail: x.detail ?? id.reason, pick }, { ...untouched(), ...x.state });
      }
      confirmed = { confirmedHandle: id.handle, confirmedTokenHash: id.tokenHash };
    }

    const postEnv = { ...env, POSTS_PER_DAY: String(postsPerDay) };
    const r = await postTweet(pick.text, { type: pick.type, key: pick.key }, { env: postEnv, now, fetch: o.fetch });
    if (r.posted) return done({ status: "posted", detail: `posted ${r.id}`, pick, id: r.id }, { ...plan.nextState, ...confirmed, ...afterX("posted", "").state });
    if (r.reason.startsWith("dormant")) {
      appendRow(t.statePath, POSTS_FILE, { id: `draft:${pick.key}`, text: pick.text, type: pick.type, at, replyTo: null, replyToHandle: null, key: pick.key, dry: true });
      return done({ status: "drafted", detail: r.reason, pick }, { ...plan.nextState, ...afterX("dormant", "").state });
    }
    // X down, 429, out of balance, the rate lock busy, the stop file: the key stays unused and the gates stay put
    if (retryableReason(r.reason)) {
      const x = afterX("transient", r.reason);
      return done({ status: "not-posted", detail: x.detail ?? `${r.reason} (will retry)`, pick }, { ...untouched(), ...confirmed, ...x.state });
    }
    return done({ status: "not-posted", detail: r.reason, pick }, { ...plan.nextState, ...confirmed });
  });
  return locked.locked ? locked.value : { status: "busy", detail: `another tick holds ${TICK_LOCK_FILE}` };
}
