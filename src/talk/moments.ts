/**
 * The builder voice's picker (docs/talk.md, "The builder voice"): CODE PICKS, HIS MODEL WORDS, CODE DECIDES. PURE.
 *
 * Each tick, code gathers candidate MOMENTS from what happened, scores them, and picks at most one:
 *   daily      the one fixed-time post, 14:00-15:00 UTC (TALK_DAILY_HOUR_UTC), with a template fallback
 *   desk       a paper close with its lessons.jsonl row (a close at or below -1 SOL stays eligible all its UTC day)
 *   followup   a close in a pool he posted about in the last 24h
 *   refusals   his entry rules refusing his own moves on one pool 3 or more times in a UTC day
 *   halt       a halt holding his paper desk for 30 minutes or more
 *   learner    where the fee forecast's learners stand (a count that moved), at most one in his last 14 posts
 *   screener   one screener observation a day, from 16 UTC, at most one in his last 14 posts
 *   arc        the arc's dates: judging opens 28 Sep, closes 7 Oct, paper ends after 8 Oct
 *   build      a public line of the build ledger (src/talk/buildLedger.ts), 7 days at most, one a UTC day
 *              (BUILD_POSTS_PER_DAY); a "miss" row is an owned miss
 *   promise    a promised row he posted, closed with a done post (a row that resolves it) or a slipped one (past due)
 * The per-close, open, strap and milestone kinds of the older loop are retired here: a close is a moment only with
 * its lesson, and the fee milestone is gone (a fee total goes out only with the book's result, in the facts).
 *
 * Scores (higher first, a moment under MIN_SCORE is silence, never filler):
 *   daily 100; promise 55; a close at or below -1 SOL 90 and more; halt 50; arc 40; refusals 35; a close 30,
 *   plus 15 at 0.5 SOL either way and 20 as a follow-up; build 30 (an owned miss 42), less 2 a day of age;
 *   learner 18 (58 when a forecast reaches its count); screener 16.
 *   Desk moments lose 5 a hour of age (not the losses at or below -1 SOL); a moment of the same type as his last
 *   post loses 15 while that post is under SAME_TYPE_WINDOW_MS old (no shape twice in a row). On 24 Sep the penalty
 *   had no end: with the desk quiet his last post was a build note, every build note sat under the floor, and he said
 *   nothing for 6 hours.
 * Freshness: a desk event within 30 minutes is written as news; later it is a past-tense follow-up with no clock
 * time in its facts; a desk event older than 3 hours is dropped (a big loss is kept its UTC day).
 * Coverage: a close is told as a story only when the journal holds decision rows across the band's life (no gap
 * over 60 minutes); otherwise it is left to the daily card, which names the worst close by pool.
 * Fallbacks (Zach, 23 Sep: "the account must keep posting"): a close and a halt carry a plain post built from their
 * own facts, which goes out only when his model cannot be asked (the gateway down, the day's cap spent); the daily
 * card's template goes out on any failure, as before.
 */
import type { JournalEntry } from "../journal";
import type { Lesson } from "../learn/lessons";
import type { PaperClosed } from "../paper/book";
import type { BuildRow } from "./buildLedger";
import { amt, bookHeadlineFacts, blockOf, count, CTX, dateOf, fact, hoursOf, paperMethodFacts, pct, realRunFacts, standingFacts, timeOf, usd, type Fact, type FactsBlock, type Figure } from "./facts";
import type { PostLength } from "./postGuards";
import type { StackFigures } from "./strap";
import { labelBlocked } from "./wordguard";
import type { BuilderPostType } from "./x";

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const MIN_SCORE = 20;
/** the same shape as his last post is penalised only while that post is this fresh */
export const SAME_TYPE_WINDOW_MS = 3 * 60 * 60e3;
/** a desk event this fresh is news; older, a past-tense follow-up */
export const FRESH_MS = 30 * MIN;
/** a desk event older than this is dropped (a close at or below BIG_LOSS_SOL is kept its UTC day) */
export const DESK_MAX_AGE_MS = 3 * HOUR;
export const BIG_LOSS_SOL = -1;
/** a close told as a story needs journal rows across the band's life with no gap longer than this */
export const COVERAGE_GAP_MS = 60 * MIN;
export const BUILD_MAX_AGE_MS = 7 * DAY;

export type MomentType = BuilderPostType | "daily";

export interface Moment {
  key: string;
  type: MomentType;
  /** when the thing happened (epoch ms) */
  at: number;
  score: number;
  length: PostLength;
  /** a past-tense follow-up: no clock time */
  past: boolean;
  /** what to write, for his model */
  brief: string;
  facts: FactsBlock;
  /** the post key this follows (the repeat rule skips it) */
  followUpOf: string | null;
  /** an arc post may restate the real run */
  arc: boolean;
  /** passes the soft daily target (5): the daily, a big loss, a promise due */
  urgent: boolean;
  /** the daily card's template, used when his model is down, over its cap, or its draft fails */
  template?: string;
  /** a plain post from the moment's own facts, used only when his model cannot be asked (never over his skip) */
  fallback?: string;
}

export interface PostMemory {
  at: number;
  text: string;
  key: string | null;
  type: string;
}

export interface LearningCount {
  category: string;
  n: number;
  need: number;
}

export interface ScreenPool {
  name: string;
  venue: string;
  tvlUsd: number | null;
  feeToTvl24hPct: number | null;
  rank: number | null;
}

export interface MomentInputs {
  /** build notes allowed on a UTC day (TALK_BUILD_POSTS_PER_DAY; default BUILD_POSTS_PER_DAY) */
  buildPostsPerDay?: number;
  now: number;
  /** why desk data is too old to post about positions, or null: then only build, promise and arc moments */
  stale: string | null;
  bookStart: { startSol: number; startUsdc: number; startedAt: number };
  /** the paper book's headline facts (src/talk/facts.ts bookHeadlineFacts), empty without a book */
  headline: Fact[];
  /** the paper book's closed bands (the daily's worst close) */
  closed: readonly Pick<PaperClosed, "address" | "label" | "closedAt" | "realizedSol">[];
  /** the last 24 hours of the paper book (src/talk/strap.ts stackFigures), or null */
  day: StackFigures | null;
  /** paper lessons of the last 48h */
  lessons: readonly Lesson[];
  journal: readonly JournalEntry[];
  /** the oldest journal entry read (the tail's start), for coverage */
  journalFrom: number | null;
  learning: readonly LearningCount[];
  screen: readonly ScreenPool[];
  build: readonly BuildRow[];
  /** his loop posts and dry records of the last 7 days, oldest first */
  posts: readonly PostMemory[];
  /** keys posted, drafted or refused in the dedupe window */
  seen: ReadonlySet<string>;
  dailyHourUtc: number;
  /** tick-state's lastDailyDay */
  lastDailyDay: string | null;
}

// ---------------------------------------------------------------- helpers

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** A pool label as a post may print it: "ORE/SOL" kept as the pool spells it; anything else (a scam word, an @, a $) is not printed. */
export function tickerOf(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").replace(/\s*\/\s*/g, "/").trim();
  if (!/^[A-Za-z0-9.]{1,12}\/[A-Za-z0-9.]{1,12}$/.test(s)) return null;
  return labelBlocked(s) ? null : s;
}
/** A journal line he may quote: plain text, no tags, no numbers of 4 decimals, no blocked word, 12-160 characters. */
export function quotable(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (s.length < 12 || s.length > 160) return null;
  if (/[^\x20-\x7E]|[@#$"{}`]|\d\.\d{3,}/.test(s)) return null;
  if (labelBlocked(s)) return null;
  return s;
}
/** The first sentence of a reasoning, if quotable. */
const firstSentence = (s: string | null | undefined): string | null => quotable(String(s ?? "").split(/(?<=[.!?])\s/)[0]);

const ENDINGS: Record<string, string> = {
  "through-band": "Price went through the band and out the other side.",
  idle: "Price left the band and stayed away, so I closed it.",
  stop: "My stop closed it.",
  faded: "The pool's flow faded, so I closed it.",
  rotated: "I closed it to make room for a pool that ranked higher.",
  "exit-list": "The pool went on my exit list.",
  consolidated: "I folded it into a band I already held in that pool.",
  flatten: "I flattened the book.",
  expire: "The band ran out its time.",
  sold: "Its offer above the price filled and the band emptied.",
  close: "I closed it.",
};

const fig = (id: string, text: string, book: Figure["book"], extra: Partial<Figure> = {}): Figure => ({ id, text, book, ...extra });

/** Blocks carry the standing facts and the SOL/USD spelling. */
function block(key: string, i: MomentInputs, facts: Fact[], tickers: string[] = [], quotes: string[] = []): FactsBlock {
  return blockOf(key, [...standingFacts({ now: i.now, ...i.bookStart }), ...facts], ["SOL/USD", ...tickers], quotes);
}

/** A paper fee figure: printed only with its net (needs) and with the book's result (the guards' fee rule). */
const feeFig = (id: string, value: number, needs: string[]): Figure => fig(id, amt(value), "paper", { needs, fee: true, ...CTX.fees });

// ---------------------------------------------------------------- gatherers

function dailyMoment(i: MomentInputs): Moment | null {
  const now = i.now;
  const today = utcDay(now);
  const hour = new Date(now).getUTCHours();
  if (hour < i.dailyHourUtc || hour >= i.dailyHourUtc + 1) return null;
  if (i.lastDailyDay === today || i.seen.has(`daily:${today}`)) return null;
  if (i.stale || !i.day) return null;
  const d = i.day;
  const dayN = Math.floor((Date.parse(today) - Date.parse(utcDay(i.bookStart.startedAt))) / DAY) + 1;
  const worst = i.closed.filter((c) => c.closedAt > now - DAY && c.closedAt <= now).reduce<(typeof i.closed)[number] | null>((w, c) => (!w || c.realizedSol < w.realizedSol ? c : w), null);
  const worstLabel = worst ? tickerOf(worst.label) : null;
  const net = d.netRealizedSol;
  const figures: Figure[] = [
    fig("daily.n", String(dayN), "paper", { near: /\bday\b/i }),
    feeFig("daily.fees", d.feesRealizedSol, ["daily.net"]),
    fig("daily.net", amt(net), "paper", { negative: net < 0, positive: net > 0 }),
    fig("daily.closed", count(d.closedBands), "paper", { next: /^\W*(bands?|closes?|closed)\b/i }),
    fig("daily.up", count(d.closedUp), "paper", { next: /^(\W*\w+){0,2}?\W*up\b/i }),
  ];
  const lines = [
    `Day ${dayN} on paper, over the last 24 hours: ${amt(d.feesRealizedSol)} SOL in fees realized, and ${net >= 0 ? `${amt(net)} SOL kept` : `a net loss of ${amt(net)} SOL`} after losses, rent, swaps and network fees. ${count(d.closedBands)} bands closed, ${count(d.closedUp)} of them up.`,
  ];
  if (worst && worst.realizedSol < 0 && worstLabel) {
    figures.push(fig("daily.worst", amt(worst.realizedSol), "paper", { negative: true }));
    lines.push(`The worst close was ${worstLabel}, down ${amt(worst.realizedSol)} SOL.`);
  }
  const facts = [fact("daily", lines.join(" "), "paper", "data-live/ledger.jsonl (stackFigures, last 24h); paper-book.json closed[] realizedSol", figures), ...i.headline];
  const headlinePct = i.headline.flatMap((f) => f.figures).find((g) => g.id === "book.pct");
  const since = dateOf(i.bookStart.startedAt);
  const tpl = [
    `Day ${dayN} on paper: ${amt(d.feesRealizedSol)} SOL in fees over the last 24 hours, and ${net >= 0 ? `${amt(net)} SOL kept after losses and costs` : `a net loss of ${amt(net)} SOL after losses and costs`}.`,
    d.closedBands > 0 ? `${count(d.closedBands)} bands closed, ${count(d.closedUp)} up.` : "No band closed.",
    ...(worst && worst.realizedSol < 0 && worstLabel ? [`The worst was ${worstLabel}, down ${amt(worst.realizedSol)} SOL.`] : []),
    ...(headlinePct ? [`The book is ${headlinePct.negative ? "down" : "up"} about ${headlinePct.text} since ${since} at today's SOL price.`] : []),
  ].join(" ");
  return {
    key: `daily:${today}`,
    type: "daily",
    at: now,
    score: 100,
    length: "long",
    past: false,
    brief:
      "The daily card, the one fixed-time post. Open with \"Day N on paper:\". Give the day's fees with the day's net beside them, how many bands closed and how many were up, the worst close by pool with its loss, and the book's result since the start. Nothing else.",
    facts: block(`daily:${today}`, i, facts, worstLabel ? [worstLabel] : []),
    followUpOf: null,
    arc: false,
    urgent: true,
    template: tpl,
  };
}

/** Whether the journal holds decision rows across a band's life. */
export function covered(journal: readonly JournalEntry[], journalFrom: number | null, pool: string, openedAt: number, closedAt: number): boolean {
  if (journalFrom === null || journalFrom > openedAt) return false;
  const ts = journal.filter((e) => e.pool.address === pool).map((e) => Date.parse(e.ts)).filter((t) => t >= openedAt && t <= closedAt);
  const points = [openedAt, ...ts.sort((a, b) => a - b), closedAt];
  for (let k = 1; k < points.length; k++) if (points[k] - points[k - 1] > COVERAGE_GAP_MS) return false;
  return true;
}

function closeMoments(i: MomentInputs, notes: string[]): Moment[] {
  if (i.stale) return [];
  const out: Moment[] = [];
  const today = utcDay(i.now);
  for (const l of i.lessons) {
    if (l.mode !== "paper" || l.closedAt > i.now) continue;
    const key = `close:${l.position}`;
    if (i.seen.has(key)) continue;
    const age = i.now - l.closedAt;
    const big = l.netSol <= BIG_LOSS_SOL;
    if (age > DESK_MAX_AGE_MS && !(big && utcDay(l.closedAt) === today)) continue;
    const label = tickerOf(l.label);
    if (!label) continue;
    if (!covered(i.journal, i.journalFrom, l.pool, l.openedAt, l.closedAt)) {
      notes.push(`coverage: ${label} closed ${amt(l.netSol)} SOL but the journal has a gap over that band's life; left to the daily card`);
      continue;
    }
    const fresh = age <= FRESH_MS;
    const earlier = [...i.posts].reverse().find((p) => i.now - p.at <= DAY && p.at < l.closedAt && p.text.toLowerCase().includes(label.toLowerCase()));
    const net = l.netSol;
    const figures: Figure[] = [fig("close.net", amt(net), "paper", { negative: net < 0, positive: net > 0 }), fig("close.hours", hoursOf(l.closedAt - l.openedAt), "paper", CTX.hours)];
    const parts = [
      `On paper I closed my band on ${label}${fresh ? ` at ${timeOf(l.closedAt)}` : ` earlier (${dateOf(l.closedAt)})`} after ${hoursOf(l.closedAt - l.openedAt)} hours: ${net < 0 ? `a loss of ${amt(net)} SOL` : `net ${amt(net)} SOL`} for the band's whole life, rent and swaps included.`,
    ];
    if (l.feesSol > 0) {
      figures.push(feeFig("close.fees", l.feesSol, ["close.net"]));
      parts.push(`${amt(l.feesSol)} SOL of fees came in while it was open; they are inside that result, not on top of it.`);
    }
    if (typeof l.inRangePct === "number") {
      figures.push(fig("close.inrange", pct(l.inRangePct), "paper", CTX.inRange));
      parts.push(`It was in range for ${pct(l.inRangePct)} of my checks.`);
    }
    parts.push(ENDINGS[l.endReason] ?? ENDINGS.close);
    if (typeof l.tokensLeftSol === "number" && Math.abs(l.tokensLeftSol) >= 0.005) {
      figures.push(fig("close.tokensLeft", amt(l.tokensLeftSol), "paper", { near: /\b(tokens?|hold|held)\b/i }));
      parts.push(`${amt(l.tokensLeftSol)} SOL of that result is tokens I still hold, counted at the close's price.`);
    }
    const facts: Fact[] = [fact("close", parts.join(" "), "paper", `data-live/lessons.jsonl ${l.position}`, figures), ...i.headline];
    if (earlier) facts.push(fact("earlier", `My earlier post about ${label} went out ${dateOf(earlier.at)}${fresh ? ` at ${timeOf(earlier.at)}` : ""}; it is in the memory block.`, "none", "data-talk/x-posts.jsonl", []));
    const q = quotable(l.headline);
    // the fallback says what the facts say, in their words: the net for the band's life, the hours, the range, the end
    const fallback = [
      earlier
        ? `Follow-up on ${label}: on paper that band closed after ${hoursOf(l.closedAt - l.openedAt)} hours${fresh ? `, at ${timeOf(l.closedAt)}` : ""}, ${net < 0 ? `a loss of ${amt(net)} SOL` : `net ${amt(net)} SOL`} for its whole life, rent and swaps included.`
        : `${fresh ? `At ${timeOf(l.closedAt)}` : "Earlier"} I closed my band on ${label} after ${hoursOf(l.closedAt - l.openedAt)} hours: ${net < 0 ? `a loss of ${amt(net)} SOL` : `net ${amt(net)} SOL`} on paper, rent and swaps included.`,
      ...(typeof l.inRangePct === "number" ? [`It was in range for ${pct(l.inRangePct)} of my checks.`] : []),
      // the plain "I closed it." would say the first sentence twice
      ...(ENDINGS[l.endReason] && l.endReason !== "close" ? [ENDINGS[l.endReason]] : []),
    ].join(" ");
    let score = 30 + (big ? 60 : 0) + (Math.abs(net) >= 0.5 ? 15 : 0) + (earlier ? 20 : 0) + (net < 0 ? 5 : 0);
    if (!big) score -= (age / HOUR) * 5;
    out.push({
      key,
      type: earlier ? "followup" : "desk",
      at: l.closedAt,
      score,
      length: "long",
      past: !fresh,
      brief: [
        earlier ? `A follow-up on your earlier post about ${label} (it is in the memory block): open with "Follow-up on ${label}:" and say how that band ended.` : `One band of your paper desk closed on ${label}.`,
        "Say the net for the band's life plainly (a loss is said as a loss, with the amount) and at most one reason from the facts. Fees only with the net and the book's result beside them, or not at all.",
        fresh ? "It happened in the last 30 minutes." : 'It happened more than 30 minutes ago: write it as a past-tense follow-up ("earlier today"), with no clock time.',
        q ? "Your journal's line for it may be quoted word for word if it carries the reason." : "",
      ]
        .filter(Boolean)
        .join(" "),
      facts: block(key, i, facts, [label], q ? [q] : []),
      followUpOf: earlier?.key ?? null,
      arc: false,
      urgent: big,
      fallback,
    });
  }
  return out;
}

const refused = (e: JournalEntry) => e.llm?.source === "llm" && (!e.allowed || e.decision?.action !== e.proposal?.action);

function refusalMoments(i: MomentInputs): Moment[] {
  if (i.stale) return [];
  const today = utcDay(i.now);
  const todays = i.journal.filter((e) => utcDay(Date.parse(e.ts)) === today && Date.parse(e.ts) <= i.now);
  const mine = todays.filter((e) => e.llm?.source === "llm");
  const byPool = new Map<string, JournalEntry[]>();
  for (const e of mine.filter(refused)) byPool.set(e.pool.address, [...(byPool.get(e.pool.address) ?? []), e]);
  const out: Moment[] = [];
  for (const [pool, rows] of byPool) {
    if (rows.length < 3) continue;
    const label = tickerOf(rows[0].pool.label);
    const key = `refusals:${today}:${pool.slice(0, 12)}`;
    if (!label || i.seen.has(key)) continue;
    const last = rows[rows.length - 1];
    const at = Date.parse(last.ts);
    const q = firstSentence(last.proposal?.reasoning);
    const refusedAll = mine.filter(refused).length;
    const facts = [
      fact(
        "refusals",
        `Today on my paper desk, my entry rules refused ${rows.length} of my own moves on ${label}. Across every pool today, they refused ${refusedAll} of the ${mine.length} calls I made myself.`,
        "none",
        "data-live/decisions.jsonl (llm.source llm; decision differs from proposal, or not allowed)",
        [fig("refusals.pool", String(rows.length), "none"), fig("refusals.all", String(refusedAll), "none"), fig("refusals.calls", String(mine.length), "none")],
      ),
    ];
    const age = i.now - at;
    if (age > DESK_MAX_AGE_MS) continue;
    out.push({
      key,
      type: "desk",
      at,
      score: 35 - (age / HOUR) * 5,
      length: "medium",
      past: age > FRESH_MS,
      brief: `Your own entry rules refused your moves on ${label} several times today. Say it in the first person as a fact about how you work: you propose, your rules decide. No verdict on the pool.${q ? " One line of your own reasoning may be quoted word for word." : ""}`,
      facts: block(key, i, facts, [label], q ? [q] : []),
      followUpOf: null,
      arc: false,
      urgent: false,
    });
  }
  return out;
}

/** halted rows further apart than this are two halts */
export const HALT_BREAK_MS = 45 * MIN;

/** a halt in force: the kill switch or a halt named in the entry (a band's own stop is not a halt: "STOP" in capitals only) */
const isHalt = (text: string): boolean => /kill.?switch|\bhalt(ed|s)?\b/i.test(text) || /\bSTOP\b/.test(text);

function haltMoment(i: MomentInputs): Moment | null {
  const recent = i.journal.filter((e) => i.now - Date.parse(e.ts) <= 2 * HOUR && Date.parse(e.ts) <= i.now);
  const halted = recent.filter((e) => isHalt([...(e.violations ?? []), ...(e.overrides ?? []), e.headline ?? ""].join(" ")));
  if (halted.length < 6 || halted.length < recent.length / 2) return null;
  // the start of the unbroken halted run across the whole journal tail, not the 2-hour window: halted rows no more
  // than HALT_BREAK_MS apart (a desk writes one every cycle while it holds)
  const all = i.journal.filter((e) => Date.parse(e.ts) <= i.now).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const haltedTs = all.filter((e) => isHalt([...(e.violations ?? []), ...(e.overrides ?? []), e.headline ?? ""].join(" "))).map((e) => Date.parse(e.ts));
  let since = haltedTs[haltedTs.length - 1];
  for (let k = haltedTs.length - 2; k >= 0 && since - haltedTs[k] <= HALT_BREAK_MS; k--) since = haltedTs[k];
  if (i.now - since < 30 * MIN) return null;
  // the tail may start inside the halt: then "since at least", and the key still names this run's start as read
  const atLeast = all.length > 0 && since - Date.parse(all[0].ts) <= HALT_BREAK_MS;
  const key = `halt:${new Date(since).toISOString().slice(0, 16)}`;
  // once per halt: a halt key already seen inside this run is this halt. The older day keys ("halt:2026-09-19")
  // count for any day the run touches; when the tail starts inside the run, any earlier halt key counts too
  // (the run's true start is out of sight, so it may be this one: fail closed)
  for (const k of i.seen) {
    if (!k.startsWith("halt:")) continue;
    const stamp = k.slice(5);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(stamp);
    const from = Date.parse(day ? `${stamp}T00:00:00Z` : `${stamp}:00Z`);
    const to = day ? from + DAY - 1 : from;
    if (!Number.isFinite(from)) continue;
    if (to >= since - HALT_BREAK_MS && from <= i.now) return null;
    if (atLeast && to < since) return null;
  }
  const haltLine = `A halt has held my paper desk since ${atLeast ? "at least " : ""}${timeOf(since)} on ${dateOf(since)}: it opens no new band while the halt is in force. Exits keep running.`;
  const facts = [fact("halt", haltLine, "none", "data-live/decisions.jsonl (kill-switch holds)", [])];
  return {
    key,
    type: "halt",
    at: since,
    score: 50,
    length: "medium",
    past: false,
    brief: "A halt is holding your paper desk. Say what it stops and since when, plainly, as your own fact.",
    facts: block(key, i, facts),
    followUpOf: null,
    arc: false,
    urgent: true,
    fallback: haltLine,
  };
}

function learnerMoment(i: MomentInputs): Moment | null {
  if (i.posts.slice(-14).some((p) => p.type === "learner")) return null;
  const cands = i.learning.filter((c) => (c.category === "memecoin" || c.category === "stock") && c.n > 0 && !i.seen.has(`learn:${c.category}:${c.n}`));
  if (!cands.length) return null;
  const c = cands.reduce((a, b) => (b.n / b.need > a.n / a.need ? b : a));
  const done = c.n >= c.need;
  const what = c.category === "memecoin" ? "memecoin" : "tokenized-stock";
  const key = `learn:${c.category}:${c.n}`;
  const others = i.learning.filter((x) => x !== c && (x.category === "memecoin" || x.category === "stock"));
  const facts = [
    fact(
      "learner",
      done
        ? `My fee forecast for ${what} pools now has ${c.n} closed bands it can score, the ${c.need} it waits for, so it may move for the first time.`
        : `My fee forecast for ${what} pools moves only after ${c.need} closed bands it can score. ${c.n} have closed so far.${others.map((o) => ` For ${o.category === "memecoin" ? "memecoins" : "stocks"} it is ${o.n} of ${o.need}.`).join("")}`,
      "none",
      "data-live/mrbands.log [learning] lines",
      [],
    ),
  ];
  return {
    key,
    type: "learner",
    at: i.now,
    score: done ? 58 : 18,
    length: "short",
    past: false,
    brief: "Where your fee forecast's learning stands, in one or two plain sentences. No promise of what it will do.",
    facts: block(key, i, facts),
    followUpOf: null,
    arc: false,
    urgent: false,
  };
}

function screenerMoment(i: MomentInputs): Moment | null {
  const hour = new Date(i.now).getUTCHours();
  const key = `screen:${utcDay(i.now)}`;
  if (hour < 16 || i.seen.has(key) || i.posts.slice(-14).some((p) => p.type === "screener")) return null;
  const pools = i.screen
    .filter((p) => p.venue === "meteora-dlmm" && typeof p.tvlUsd === "number" && p.tvlUsd >= 50_000 && typeof p.feeToTvl24hPct === "number")
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))
    .slice(0, 3)
    .map((p) => ({ ...p, label: tickerOf(p.name) }))
    .filter((p) => p.label);
  if (!pools.length) return null;
  const facts = pools.map((p, k) =>
    fact(
      `screen.${k}`,
      `From my screener: ${p.label} holds ${usd(p.tvlUsd!)} and paid ${p.feeToTvl24hPct!.toFixed(2)}% of that in fees over 24 hours${p.rank ? `, rank ${p.rank} of the pools I score` : ""}.`,
      "none",
      "data-live/screen.json",
      [],
    ),
  );
  return {
    key,
    type: "screener",
    at: i.now,
    score: 16,
    length: "medium",
    past: false,
    brief: "One observation from your screener, as a fact about the pools. No verdict on whether a pool is good, cheap, worth a band or worth anything; no advice.",
    facts: block(key, i, facts, pools.map((p) => p.label!)),
    followUpOf: null,
    arc: false,
    urgent: false,
  };
}

function arcMoment(i: MomentInputs): Moment | null {
  const today = utcDay(i.now);
  const days: Record<string, string> = {
    "2026-09-28": "Judging of AnsemHack's Clawrena opens today and runs to 7 Oct.",
    "2026-10-07": "Today is the last day of judging for AnsemHack's Clawrena.",
    "2026-10-08": "Today is the last day my book is on paper, as planned since 14 Sep.",
  };
  const line = days[today];
  const key = `arc:${today}`;
  if (!line || i.seen.has(key) || new Date(i.now).getUTCHours() < 15) return null;
  const facts = [fact("arc", line, "none", "docs/clawrena.md; docs/sprint.md", []), ...realRunFacts(), ...i.headline];
  return {
    key,
    type: "arc",
    at: i.now,
    score: 40,
    length: "long",
    past: false,
    brief: "Where you stand in your own arc today, as facts: the date, that the book is paper, and your one real-money run's result once. No slogan, no closing line.",
    facts: block(key, i, facts),
    followUpOf: null,
    arc: true,
    urgent: false,
  };
}

/** at most this many build notes (an owned miss included) on a UTC day, by default; TALK_BUILD_POSTS_PER_DAY raises it */
export const BUILD_POSTS_PER_DAY = 1;

function buildMoments(i: MomentInputs, shortToday: boolean): Moment[] {
  const out: Moment[] = [];
  const today = utcDay(i.now);
  if (i.posts.filter((p) => utcDay(p.at) === today && (p.type === "build" || p.type === "miss")).length >= (i.buildPostsPerDay ?? BUILD_POSTS_PER_DAY)) return out;
  for (const r of i.build) {
    if (!r.public || r.at > i.now || i.now - r.at > BUILD_MAX_AGE_MS) continue;
    if (r.resolves) continue; // a row that keeps a promise goes out as the promise's done post
    const key = `build:${r.id}`;
    if (i.seen.has(key)) continue;
    const ageDays = (i.now - r.at) / DAY;
    const facts = [fact(`build.${r.id}`, r.text, r.book, r.source)];
    if (r.book === "paper") facts.push(...i.headline);
    if (r.id.startsWith("paper-")) facts.push(...paperMethodFacts());
    const short = !shortToday && r.text.length <= 110 && r.kind !== "miss";
    out.push({
      key,
      type: r.kind === "miss" ? "miss" : "build",
      at: r.at,
      score: (r.kind === "miss" ? 42 : 30) + (r.kind === "rule" || r.kind === "cost" ? 4 : 0) - 2 * ageDays + (short ? 2 : 0),
      length: short ? "short" : r.kind === "miss" ? "long" : r.text.length > 200 ? "long" : "medium",
      past: false,
      brief:
        r.kind === "miss"
          ? "An owned miss from your build ledger: what you got wrong, what it cost, and what changed, plainly and in the first person. No apology theatre, no lesson line at the end."
          : "A build note from your build ledger, as a plain fact about what is now true: what you built, cut or fixed and what it changes. Not a changelog (no \"I built X: it does Y\"), no announcement tone, no closing line.",
      facts: block(key, i, facts),
      followUpOf: null,
      arc: false,
      urgent: false,
    });
  }
  return out;
}

function promiseMoments(i: MomentInputs): Moment[] {
  const out: Moment[] = [];
  for (const r of i.build) {
    if (!r.promise || !i.seen.has(`build:${r.id}`)) continue;
    const key = `promise:${r.id}`;
    if (i.seen.has(key)) continue;
    const kept = i.build.find((x) => x.resolves === r.id && x.public && x.at <= i.now);
    const dueEnd = Date.parse(utcDay(r.promise.due)) + DAY;
    if (!kept && i.now < dueEnd) continue;
    const posted = i.posts.find((p) => p.key === `build:${r.id}`);
    const facts = [
      fact("promise", `I said on ${posted ? dateOf(posted.at) : dateOf(r.at)}: ${r.text}`, r.book, r.source),
      kept ? fact("promise.done", kept.text, kept.book, kept.source) : fact("promise.slipped", `It was due by ${dateOf(r.promise.due)} and it is not done yet.`, "none", "build ledger"),
    ];
    out.push({
      key,
      type: "promise",
      at: kept ? kept.at : dueEnd,
      score: 55,
      length: "medium",
      past: false,
      brief: kept ? "Close a promise you made in public: say it is done, and what is now true. Plainly, no victory lap." : "Close a promise you made in public: say it slipped, plainly, and what is still true. No excuse, no new date unless the facts give one.",
      facts: block(key, i, facts),
      followUpOf: posted?.key ?? null,
      arc: false,
      urgent: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------- the pick

export interface PickOptions {
  postsPerDay: number;
  /** the soft target: past it only an urgent moment goes (default 5) */
  targetPerDay: number;
  minGapMin: number;
  gapJitterMin: number;
  windowPosts: number;
  windowHours: number;
  dayStartUtc: number;
  nightPosts: number;
  /** jitter in minutes for a key (guards.ts jitterMin) */
  jitter: (key: string, max: number) => number;
}

export interface PickResult {
  pick: Moment | null;
  /** every moment, scored, best first */
  moments: Moment[];
  notes: string[];
  /** why nothing goes this tick although a moment waits */
  held: string | null;
}

/** Every moment this tick, scored and sorted (best first). */
export function gatherMoments(i: MomentInputs, notes: string[] = []): Moment[] {
  const today = utcDay(i.now);
  const shortToday = i.posts.some((p) => utcDay(p.at) === today && p.text.length <= 100);
  const all: Moment[] = [];
  const daily = dailyMoment(i);
  if (daily) all.push(daily);
  all.push(...closeMoments(i, notes), ...refusalMoments(i), ...buildMoments(i, shortToday), ...promiseMoments(i));
  for (const m of [haltMoment(i), learnerMoment(i), screenerMoment(i), arcMoment(i)]) if (m) all.push(m);
  const last = i.posts.length ? i.posts[i.posts.length - 1] : null;
  const lastType = last && i.now - last.at < SAME_TYPE_WINDOW_MS ? last.type : null;
  for (const m of all) if (m.type !== "daily" && m.type === lastType) m.score -= 15;
  return all.sort((a, b) => b.score - a.score || a.at - b.at);
}

/** The one moment that goes this tick, or why none does. Caps are the loop's own (POSTS_PER_DAY and the spacing). */
export function pickMoment(i: MomentInputs, o: PickOptions): PickResult {
  const notes: string[] = [];
  const moments = gatherMoments(i, notes).filter((m) => {
    if (m.score >= MIN_SCORE) return true;
    notes.push(`quiet: ${m.key} scores ${m.score.toFixed(0)}, under ${MIN_SCORE}; nothing fills silence`);
    return false;
  });
  if (!moments.length) return { pick: null, moments, notes, held: null };
  const now = i.now;
  const today = utcDay(now);
  const hour = new Date(now).getUTCHours();
  const todays = i.posts.filter((p) => utcDay(p.at) === today);
  const hold = (why: string): PickResult => ({ pick: null, moments, notes, held: why });
  if (todays.length >= o.postsPerDay) return hold(`cap: ${todays.length} posts today, POSTS_PER_DAY is ${o.postsPerDay}`);
  let pool = moments;
  const dailyDone = i.lastDailyDay === today || i.seen.has(`daily:${today}`);
  // the daily's slot: from 13:15 UTC until it goes (inside its hour), nothing else takes the gap it needs
  const minutes = hour * 60 + new Date(now).getUTCMinutes();
  if (!dailyDone && minutes >= i.dailyHourUtc * 60 - 45 && hour < i.dailyHourUtc + 1) {
    const d = pool.filter((m) => m.type === "daily");
    if (!d.length) return hold("the daily card's slot is kept");
    pool = d;
  }
  if (!dailyDone && hour < i.dailyHourUtc + 1 && todays.length >= o.postsPerDay - 1) {
    pool = pool.filter((m) => m.type === "daily");
    if (!pool.length) return hold(`the day's last slot is kept for the daily card (${todays.length} of ${o.postsPerDay} used)`);
  }
  if (todays.length >= o.targetPerDay) {
    pool = pool.filter((m) => m.urgent);
    if (!pool.length) return hold(`target: ${todays.length} posts today, the target is ${o.targetPerDay}; only a daily, a big loss or a promise goes`);
  }
  const times = i.posts.map((p) => p.at).filter((t) => t <= now);
  const last = times.length ? Math.max(...times) : null;
  if (last !== null && o.minGapMin > 0) {
    const since = now - last;
    const waitOf = (m: Moment) => (m.type === "daily" ? Math.min(45, o.minGapMin) : o.minGapMin + o.jitter(m.key, o.gapJitterMin));
    const ok = pool.filter((m) => since >= waitOf(m) * MIN);
    if (!ok.length) return hold(`gap: the last post went ${Math.round(since / MIN)} min ago; ${pool[0].key} waits ${waitOf(pool[0])} min`);
    pool = ok;
  }
  if (o.windowPosts > 0 && o.windowHours > 0) {
    const inWindow = times.filter((t) => now - t < o.windowHours * HOUR).length;
    if (inWindow >= o.windowPosts) {
      pool = pool.filter((m) => m.type === "daily");
      if (!pool.length) return hold(`window: ${inWindow} posts in the last ${o.windowHours}h`);
    }
  }
  if (o.nightPosts > 0 && hour < o.dayStartUtc && todays.length >= o.nightPosts) return hold(`night: ${todays.length} posts before ${o.dayStartUtc}:00 UTC`);
  return { pick: pool[0], moments, notes, held: null };
}
