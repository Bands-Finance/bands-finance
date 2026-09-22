/**
 * The posting loop's cadence guards, PURE, ported from what went wrong on Merd's timeline (Zach's earlier agent,
 * /Users/zach/dev/meridian, 296 live posts, Jul to Sep 2026). Each guard is pinned to the incident it comes from;
 * none of them writes, reads a file or touches X. planTick and runTick (src/talk/tick.ts) call them.
 *
 *   similarity / tooSimilar   meaningful-word overlap against the loop's own recent texts: a reworded repeat drew
 *                             93 impressions against 2,165, and the same product claim reworded ten times fell from
 *                             579 impressions to 26. Raw text, numbers and labels kept. tick.ts applies it to the
 *                             milestone only: an open, a strap or a lesson is a templated claim about a different
 *                             seat or state, and two of them overlap 0.85 to 1.00 by construction (six straddles in
 *                             six pools: 12 of 15 pairs over the bar; two green straps three days apart: 1.00), so
 *                             the filter refused the genuine events it was meant to let through, and masking the
 *                             figures and labels would make every two identical. The key dedupe, the day's caps and
 *                             the strap cooldown ration those kinds instead.
 *   statTokens / repeatedStat the same 4-decimal SOL figure restated in a milestone or lesson post of the last 24h
 *                             (a lesson repeating the milestone's net): a reader sees one talking point twice. Never
 *                             against a close, an open or a strap: a fee figure two seats share is a coincidence
 *   markersIn / selfEcho      a draft's own metadata ("**REPLY**", "Reasoning:") on the timeline, and an answer
 *                             returned twice inside one text: 37 of Merd's reply and skip drafts leaked before his
 *                             cleanReply existed. Insurance for the day a model rewrite exists here.
 *   jitterMin                 a deterministic 0..N minute jitter per event key: 78% of Merd's same-day gaps sat
 *                             within 230-250 min because the floor equalled the tick, the cron made visible
 *   eventCaps                 the day's event slots (close, open, strap, milestone share TALK_EVENT_POSTS_PER_DAY),
 *                             the open, strap and per-pool sub-caps, the loss-close exemption: six seats and a 2h
 *                             freshness could spend the whole day's cap on six near-identical posts
 *   backoff                   after 3 consecutive transient X refusals the loop stops calling X for a while,
 *                             doubling to a cap: 59 identical "Daily print" failures retried every 15 minutes for
 *                             14 hours on a 402, 81 posts lost
 */
import crypto from "node:crypto";

const MIN = 60e3;

// ---------------------------------------------------------------- similarity

/** function words that carry no meaning for overlap (Merd's postGuards.ts STOP list) */
const STOP = new Set(
  "the a an and or but of to in on at is are was were it its this that for with as by from you your i my we our they them there here now just still like about into over under more most some any all not no than then so if while when what which who how why be been being have has had do does did can could would should will".split(
    " ",
  ),
);

/** the meaningful words of a text: lowercase, non-alphanumerics as spaces, words of 2 characters or fewer and stop words dropped */
export function meaningfulWords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** Meaningful-word overlap, 0..1, over the smaller set so a short post is not diluted by a long one. */
export function similarity(a: string, b: string): number {
  const A = meaningfulWords(a);
  const B = meaningfulWords(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

/** Merd's 0.45 fired on 7 of 174 free-text drafts; templates share more words, so the loop's threshold is higher (and the milestone is the one kind it filters). */
export const SIMILARITY_MAX = 0.85;

export interface RecentText {
  /** epoch ms */
  at: number;
  text: string;
  /** the loop's event key, when the record has one */
  key?: string | null;
  type?: string | null;
}

/** The recent text this one repeats (the highest overlap at or over `max`), or null. */
export function tooSimilar(text: string, recent: readonly RecentText[], max = SIMILARITY_MAX): { hit: RecentText; score: number } | null {
  let best: { hit: RecentText; score: number } | null = null;
  for (const r of recent) {
    const score = similarity(text, r.text);
    if (score >= max && (!best || score > best.score)) best = { hit: r, score };
  }
  return best;
}

// ---------------------------------------------------------------- repeated figures

/** Every 4-decimal figure in a text ("0.0915", "-0.5000"), the way the loop prints SOL; a bare zero is not a figure. */
export function statTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(/(?<![\d.])(\d+\.\d{4})(?![\d.])/g)) if (!/^0\.0000$/.test(m[1])) out.add(m[1]);
  return out;
}

/** A 4-decimal figure this text shares with a recent one, with the record it repeats, or null. */
export function repeatedStat(text: string, recent: readonly RecentText[]): { stat: string; hit: RecentText } | null {
  const mine = statTokens(text);
  if (!mine.size) return null;
  for (const r of recent) for (const t of statTokens(r.text)) if (mine.has(t)) return { stat: t, hit: r };
  return null;
}

// ---------------------------------------------------------------- markers and echo

/** the metadata a drafting model leaves in its answer, and that a timeline must never see */
const MARKER_LINE_RE = /^\s*[*_`>#~"'(]*\s*(reasoning|draft|post|note|reply|quote)\s*[*_`~]*\s*:/i;
const SKIP_LINE_RE = /^\s*[*_`>#~"'(]*\s*skip\b/i;

/** Why the text carries draft markers ("**", a "reasoning:" / "draft:" / "post:" / "note:" label, a "skip" line), or null. */
export function markersIn(text: string): string | null {
  if (text.includes("**")) return 'markdown emphasis ("**")';
  for (const line of text.split("\n")) {
    const m = line.match(MARKER_LINE_RE);
    if (m) return `a "${m[1].toLowerCase()}:" label`;
    if (SKIP_LINE_RE.test(line)) return 'a "skip" line';
  }
  return null;
}

/** the sentences of a text: after . ! ? (not inside a number) or a line break */
const sentencesOf = (s: string): string[] =>
  s
    .split(/(?<=[.!?])(?!\d)|\n/)
    .map((p) => p.trim())
    .filter(Boolean);

/** A sentence, keyed on its letters and digits, that appears twice inside one text (keys of 12 characters or fewer may recur), or null. */
export function selfEcho(text: string): string | null {
  const seen = new Set<string>();
  for (const p of sentencesOf(text)) {
    const key = p.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (key.length > 12 && seen.has(key)) return p;
    seen.add(key);
  }
  return null;
}

// ---------------------------------------------------------------- jitter

/** sha256(key) mod (maxMin + 1): the same key always waits the same extra minutes, across ticks and restarts. */
export function jitterMin(key: string, maxMin: number): number {
  if (!(maxMin > 0)) return 0;
  const h = crypto.createHash("sha256").update(key).digest();
  return h.readUInt32BE(0) % (Math.floor(maxMin) + 1);
}

// ---------------------------------------------------------------- the day's event slots

/** at most this many event posts (open, close, strap, milestone) about one pool on a UTC day */
export const POOL_EVENT_POSTS_PER_DAY = 2;
/** at most this many strap posts on a UTC day: a red, green, red flip inside a day is one story, not three */
export const STRAP_POSTS_PER_DAY = 2;

export type EventKind = "close" | "open" | "strap" | "milestone";
export const EVENT_KINDS: readonly EventKind[] = ["close", "open", "strap", "milestone"];

export interface CapCandidate {
  kind: string;
  key: string;
  /** the pool the event is about (open, close), null for the others */
  pool?: string | null;
  /** a close that lost: exempt from the event and pool caps, never from POSTS_PER_DAY or the daily's kept slot */
  loss?: boolean;
}

export interface TodayEntry {
  key: string | null;
  type: string;
}

export interface CapOptions {
  /** 0: off */
  eventPostsPerDay: number;
  /** 0: off */
  openPostsPerDay: number;
  poolPostsPerDay?: number;
  strapPostsPerDay?: number;
}

export interface CapResult<C extends CapCandidate> {
  eligible: C[];
  /** why each dropped candidate waits */
  notes: string[];
}

/**
 * Which candidates the day's event slots still allow. Counts today's loop records by type (dry records included)
 * and by pool (a record's pool resolved through `poolOf` on its key). A losing close passes the event and pool caps:
 * a loss is never the thing that stays quiet.
 */
export function eventCaps<C extends CapCandidate>(today: readonly TodayEntry[], cands: readonly C[], poolOf: (key: string) => string | null, o: CapOptions): CapResult<C> {
  const events = today.filter((t) => (EVENT_KINDS as readonly string[]).includes(t.type));
  const byType = new Map<string, number>();
  for (const t of events) byType.set(t.type, (byType.get(t.type) ?? 0) + 1);
  const byPool = new Map<string, number>();
  for (const t of events) {
    const pool = t.key ? poolOf(t.key) : null;
    if (pool) byPool.set(pool, (byPool.get(pool) ?? 0) + 1);
  }
  const poolCap = o.poolPostsPerDay ?? POOL_EVENT_POSTS_PER_DAY;
  const strapCap = o.strapPostsPerDay ?? STRAP_POSTS_PER_DAY;
  const eligible: C[] = [];
  const notes: string[] = [];
  for (const c of cands) {
    if (!(EVENT_KINDS as readonly string[]).includes(c.kind)) {
      eligible.push(c);
      continue;
    }
    const opens = byType.get("open") ?? 0;
    const straps = byType.get("strap") ?? 0;
    const inPool = c.pool ? (byPool.get(c.pool) ?? 0) : 0;
    if (o.eventPostsPerDay > 0 && events.length >= o.eventPostsPerDay && !c.loss) {
      notes.push(`${c.kind}: ${events.length} event posts today, TALK_EVENT_POSTS_PER_DAY is ${o.eventPostsPerDay}; ${c.key} waits`);
      continue;
    }
    if (c.kind === "open" && o.openPostsPerDay > 0 && opens >= o.openPostsPerDay) {
      notes.push(`open: ${opens} opens posted today, TALK_OPEN_POSTS_PER_DAY is ${o.openPostsPerDay}; ${c.key} waits (the daily counts opened bands)`);
      continue;
    }
    if (c.kind === "strap" && strapCap > 0 && straps >= strapCap) {
      notes.push(`strap: ${straps} strap posts today, the day's limit is ${strapCap}; a flip inside a day is one story`);
      continue;
    }
    if (c.pool && poolCap > 0 && inPool >= poolCap && !c.loss) {
      notes.push(`${c.kind}: ${inPool} event posts about ${c.pool.slice(0, 8)} today, the limit per pool is ${poolCap}; ${c.key} waits`);
      continue;
    }
    eligible.push(c);
  }
  return { eligible, notes };
}

// ---------------------------------------------------------------- backoff

export const DEFAULT_RETRY_BACKOFF_MIN = 60;
/** the longest hold, however many failures in a row */
export const MAX_RETRY_BACKOFF_MIN = 360;
/** transient refusals in a row before the first hold */
export const BACKOFF_AFTER_FAILS = 3;

export interface BackoffState {
  /** retryable X refusals in a row (x.ts retryableReason); reset by a post that went or a dormant result */
  transientFails: number;
  /** the loop does not call X before this (epoch ms), or null */
  backoffUntil: number | null;
}

export type XOutcome = "posted" | "dormant" | "transient" | "other";

/** Minutes the n-th hold lasts: the base at 3 failures, doubling each failure after, capped. */
export function backoffMinutes(transientFails: number, baseMin: number): number {
  if (transientFails < BACKOFF_AFTER_FAILS || !(baseMin > 0)) return 0;
  return Math.min(MAX_RETRY_BACKOFF_MIN, baseMin * 2 ** (transientFails - BACKOFF_AFTER_FAILS));
}

/**
 * The next backoff state after an X result. A transient refusal counts; the third in a row (and every one after)
 * starts a hold, doubling from `baseMin` to MAX_RETRY_BACKOFF_MIN. A posted or dormant result clears it. Any
 * other result (a final X refusal, nothing sent) leaves it as it is. `baseMin` 0 turns the hold off.
 */
export function backoff(prev: BackoffState, result: XOutcome, now: number, baseMin: number): BackoffState & { heldMin: number } {
  if (result === "posted" || result === "dormant") return { transientFails: 0, backoffUntil: null, heldMin: 0 };
  if (result !== "transient") return { ...prev, heldMin: 0 };
  const transientFails = (prev.transientFails ?? 0) + 1;
  const heldMin = backoffMinutes(transientFails, baseMin);
  return { transientFails, backoffUntil: heldMin > 0 ? now + heldMin * MIN : null, heldMin };
}

/** Whether a hold is on at `now`. */
export const backingOff = (s: { backoffUntil?: number | null }, now: number): boolean => typeof s.backoffUntil === "number" && now < s.backoffUntil;
