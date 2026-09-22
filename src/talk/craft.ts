/**
 * The craft of a loop post (docs/talk.md, "What he learned from Merd"). PURE: shapePost takes the facts a tick
 * already has (CraftFacts) and returns the text of one post, or null when it has nothing to say for that kind,
 * in which case tick.ts uses its own template unchanged. Nothing here reads a file, calls X or bypasses a guard:
 * every text still goes through paperize, vetOutgoing and the lint in tick.ts.
 *
 * What it does that the templates did not, each from Merd's record (his structure, never his sentences):
 *   - one act or one position per post, two to four lines, the number with its window in SOL
 *   - openers rotate per kind by sha256(seed) mod 3, so a close does not begin "closed my band on" every time;
 *     a close carries its UTC clock time
 *   - a losing close and the lesson say the mechanism and what the rule did, only from the journal (proposed,
 *     directive, bins out); absent means the line is left out, never invented
 *   - the daily and the close put the figure beside his own days on the same book (recent: DayFigure[]),
 *     never a rate, another account or "on pace for"
 *   - the daily is a fixed card at the fixed clock with a "day N" counter, two orderings by UTC-day parity, a red
 *     shape that states the loss first, and a one-liner when nothing moved
 *   - the lesson is three parts (what the seat did, what it cost or paid, what the rule did) with no fixed
 *     takeaway; the tokens-left line is dropped first when it runs long, so a lesson is never lost to 280
 *   - endings land on the fact and stop: no closing line, no slogan; "paper" rotates by seed parity between the
 *     first line and the last, and is on every post about the book
 *   - no links (a URL costs 13x on X pay-per-use, and there is nothing to verify on paper)
 *
 * Every figure goes through sol4 / signedSol (4 decimals, never "-0.0000"). Labels are passed through the same
 * rule as tick.ts's sanitizeLabel before they are printed, whatever the caller did.
 */
import crypto from "node:crypto";
import type { EndReason, Lesson } from "../learn/lessons";
import { weightedLength, MAX_POST_CHARS } from "./lint";
import type { StackFigures, StrapResult, TalkSource } from "./strap";
import type { BandEvent, DailyFacts, MilestoneFacts, TickKind } from "./tick";
import { labelBlocked } from "./wordguard";

// ---------------------------------------------------------------- facts

/** One UTC day of the same book, from stackFigures over that day (the daily's and the close's comparison line). */
export interface DayFigure {
  /** "2026-09-21" */
  day: string;
  feesSol: number;
  netSol: number;
  /** bands closed that day */
  closed: number;
}

export interface CraftFacts {
  source: TalkSource;
  paper: boolean;
  now: number;
  /** the candidate key: sha256(seed) mod 3 picks the opener, its parity places "paper" */
  seed: string;
  /** the last 7 UTC days before today, oldest first (the daily also carries its own copy); today's day is ignored */
  recent?: DayFigure[];
  event?: BandEvent & {
    /** the action proposed on the journal entry whose execution.closed is this band ("HOLD", "CLOSE_POSITION") */
    proposed?: string | null;
    /** the engine directive that acted on that entry ("STOP", "FLATTEN", "EXPIRE", "ROTATE") */
    directive?: string | null;
    /** bins outside the band at the close: positive above, negative below; 0 or null when unknown or inside */
    binsOut?: number | null;
    /** bands open on the book after this event */
    openBands?: number | null;
  };
  strap?: StrapResult & {
    /** ms since the strap was last in another state (the change this post is about) */
    sinceMs?: number | null;
  };
  daily?: DailyFacts & {
    /** the day counter of the run (1 on the book's first day); null when the book has no first row */
    dayN: number | null;
    recent: DayFigure[];
  };
  milestone?: MilestoneFacts & {
    /** the day with the most fees since firstAt, and the most recent day with rows */
    bestDay: DayFigure | null;
    lastDay: DayFigure | null;
  };
  lesson?: Lesson & { proposed?: string | null; directive?: string | null };
  stack?: StackFigures;
}

/** Merd's sentences, and the tells the record says not to copy: never in a post. */
export const BANNED_PHRASES: readonly string[] = [
  "quiet days like this are the whole strategy",
  "not quoting is a position",
  "a new high",
  "fees only go up",
  "small by construction",
  "the rule cut it",
  "no claim step",
  "on pace for",
  "still stacking",
  "i propose, the guards decide",
];

// ---------------------------------------------------------------- helpers

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** 4 decimals, a sign on non-zero, never "-0.0000" (drafts.ts has the same). */
export function signedSol(n: number): string {
  const s = n.toFixed(4);
  if (/^-?0\.0000$/.test(s)) return "0.0000";
  return n > 0 ? `+${s}` : s;
}
/** 4 decimals, no sign, never "-0.0000". */
export const sol4 = (n: number): string => (/^-?0\.0000$/.test(n.toFixed(4)) ? "0.0000" : n.toFixed(4));

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const heldFor = (sec: number) => (sec < 3600 ? `${Math.max(1, Math.round(sec / 60))}m` : `${(sec / 3600).toFixed(1)}h`);
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const shortDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} utc`;
};
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** sha256(seed) as a small non-negative integer. */
export function seedInt(seed: string): number {
  return crypto.createHash("sha256").update(seed).digest().readUInt32BE(0);
}
const pick = (seed: string, n: number) => seedInt(seed) % n;

/**
 * The same rule as tick.ts's sanitizeLabel (lowercase, words that start with @ or # dropped, only a-z and 0-9 on
 * each side of the pair, a blocked word reads "a pool"), kept here so craft never prints a label it did not clean.
 */
export function safeLabel(raw: string | null | undefined): string {
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
  return sides.length && !labelBlocked(sides.join("/")) ? sides.join("/") : "a pool";
}

/** A word from the journal (a proposed action, a directive) as plain lowercase letters, or null. */
const plainWord = (raw: string | null | undefined): string | null => {
  const w = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .slice(0, 24);
  return w || null;
};

/** How the book is named in a sentence. */
const bookWord = (f: Pick<CraftFacts, "source" | "paper">) => (f.source === "paper" ? "paper book" : f.source === "dry-run" ? "dry run, on paper" : f.paper ? "paper book" : "book");
/** The word that must be on every post about a paper book, or null on a live book. */
const tagWord = (f: Pick<CraftFacts, "source" | "paper">) => (f.source === "live" && !f.paper ? null : bookWord(f));

/**
 * "paper" placed by seed parity: even, ", paper book" inside the first line before its full stop; odd, "paper book."
 * as the last line. A line that already names the book (an open's "4 bands open on the paper book") is left alone.
 */
function placeTag(lines: string[], f: Pick<CraftFacts, "source" | "paper" | "seed">): string[] {
  const tag = tagWord(f);
  if (!tag || !lines.length) return lines;
  if (lines.some((l) => /\bpaper\b/.test(l))) return lines;
  if (pick(f.seed, 2) === 0) {
    const first = lines[0];
    return [first.endsWith(".") ? `${first.slice(0, -1)}, ${tag}.` : `${first}, ${tag}.`, ...lines.slice(1)];
  }
  return [...lines, `${tag}.`];
}

/** must lines always; optional lines dropped from the END, one at a time, until the text fits 280 weighted. */
function fit(must: string[], optional: string[], f: Pick<CraftFacts, "source" | "paper" | "seed">): string {
  for (let keep = optional.length; keep >= 0; keep--) {
    const text = placeTag([...must, ...optional.slice(0, keep)].filter(Boolean), f).join("\n");
    if (weightedLength(text) <= MAX_POST_CHARS || keep === 0) return text;
  }
  return placeTag(must.filter(Boolean), f).join("\n");
}

/** The days before today, oldest first, whatever order or day the caller passed. */
function priorDays(recent: readonly DayFigure[] | undefined, now: number): DayFigure[] {
  const today = utcDay(now);
  return (recent ?? []).filter((d) => d && typeof d.day === "string" && d.day < today && finite(d.feesSol) && finite(d.netSol)).sort((a, b) => (a.day < b.day ? -1 : 1));
}

/** What the rule did, as the actor, from the engine directive on the journal entry that closed the band. */
function ruleActed(directive: string | null | undefined): string | null {
  const d = plainWord(directive);
  if (!d) return null;
  if (d === "stop") return "the stop closed it";
  if (d === "flatten") return "the flatten closed it";
  if (d === "expire") return "its time ran out and the clock closed it";
  if (d === "rotate") return "the rotation closed it for a pool ranked higher";
  return `the ${d} directive closed it`;
}

/** What he had proposed on that entry, in his words. */
function proposedWord(proposed: string | null | undefined): string | null {
  const p = plainWord(proposed);
  if (!p) return null;
  const map: Record<string, string> = { hold: "hold", "close position": "the close", rebalance: "the re-centre", "open position": "an open", "claim fees": "a claim" };
  return map[p] ?? p;
}

/**
 * One sentence on the mechanism and the rule, or null when the journal gave nothing. Never invented. The close
 * and the lesson say it in different words, so the two posts about one seat never share a line.
 */
function mechanismLine(proposed: string | null | undefined, directive: string | null | undefined, form: "close" | "lesson"): string | null {
  const acted = ruleActed(directive);
  const mine = proposedWord(proposed);
  if (acted) return form === "close" ? `${mine ? `i had proposed ${mine}; ` : ""}${acted}.` : `${acted}${mine ? `, over my proposed ${mine}` : ""}.`;
  if (mine === "the close" || mine === "the re-centre") return form === "close" ? `i proposed ${mine} myself; the guards allowed it.` : `${mine} was my own proposal, and the guards let it through.`;
  return null;
}

/** The same fold for a close's and a lesson's ending, in his words, the rule as the actor. */
const ENDINGS: Record<EndReason, string> = {
  "through-band": "price went through the band and out the other side.",
  idle: "price left the band and stayed away, so the seat was pulled.",
  stop: "the stop closed it.",
  faded: "the pool's flow faded and the seat moved on.",
  rotated: "a pool ranked higher took the seat.",
  "exit-list": "the pool went on the exit list.",
  consolidated: "folded into a band already held in that pool.",
  flatten: "the book was flattened.",
  expire: "the seat ran out its time.",
  sold: "the ask side filled and the band emptied.",
  close: "closed and moved on.",
};

// ---------------------------------------------------------------- close

export function closeShape(f: CraftFacts): string | null {
  const e = f.event;
  if (!e || e.kind !== "close") return null;
  const label = safeLabel(e.label);
  const held = finite(e.holdSec) && e.holdSec > 0 ? heldFor(e.holdSec) : null;
  const at = clock(e.at);
  const openers = held
    ? [`closed my band on ${label} after ${held}, ${at}.`, `${label}, closed ${at} after ${held}.`, `${held} in ${label} and out at ${at}.`]
    : [`closed my band on ${label} at ${at}.`, `${label}, closed ${at}.`, `out of ${label} at ${at}.`];
  const net = e.netSol ?? 0;
  const fees = finite(e.feesSol) && e.feesSol > 0 ? sol4(e.feesSol) : null;
  const loss = net < 0;
  const result = e.closeLegOnly
    ? `the close leg alone: ${signedSol(net)} sol${loss ? ", a loss" : ""}${fees ? `; fees ${fees} sol in that leg` : ""}.`
    : `net ${signedSol(net)} sol${loss ? ", a loss" : ""}${fees ? `; fees ${fees} sol counted in it` : ""}.`;
  // where price was at the close: bins out when the book knows them, else outside or still inside (a fact either way)
  const bins =
    finite(e.binsOut) && e.binsOut !== 0
      ? `price sat ${plural(Math.abs(Math.round(e.binsOut)), "bin")} ${e.binsOut > 0 ? "above" : "below"} the band at the close.`
      : e.outsideAtClose
        ? "price was outside the band at the close."
        : e.outsideAtClose === false
          ? "price was still inside the band at the close."
          : null;
  const rule = loss ? mechanismLine(e.proposed, e.directive, "close") : null;
  const days = priorDays(f.recent, f.now);
  let compare: string | null = null;
  if (days.length >= 2) {
    const nets = days.map((d) => d.netSol);
    if (net > 0 && net > Math.max(...nets)) compare = `more than any whole day of the last ${days.length} netted.`;
    else if (loss && net < Math.min(...nets)) compare = `worse than any whole day of the last ${days.length}.`;
  }
  const open = finite(e.openBands) && e.openBands >= 0 ? `${plural(e.openBands, "band")} still open on the ${bookWord(f)}.` : null;
  const must = [openers[pick(f.seed, 3)], result, ...(bins ? [bins] : []), ...(rule ? [rule] : [])];
  // one act per post, two to four lines before the paper line: the optional facts fill up to four, in this order
  const optional = [...(e.relaidKey ? ["laid a fresh band in the same pool."] : []), ...(compare ? [compare] : []), ...(open ? [open] : [])].slice(0, Math.max(0, 4 - must.length));
  return fit(must, optional, f);
}

// ---------------------------------------------------------------- open

const SHAPES = { BOTH: "a straddle", SOL_ONLY: "a one-sided band under price", TOKEN_ONLY: "a one-sided band over price" } as const;

export function openShape(f: CraftFacts): string | null {
  const e = f.event;
  if (!e || e.kind !== "open") return null;
  const label = safeLabel(e.label);
  const shape = e.side ? SHAPES[e.side] : "a band";
  const b = finite(e.binsBelow) ? Math.round(e.binsBelow) : null;
  const a = finite(e.binsAbove) ? Math.round(e.binsAbove) : null;
  let bins: string | null = null;
  if (e.side === "BOTH" && b !== null && a !== null) bins = a === b ? `${plural(b, "bin")} each side of price` : `${plural(b, "bin")} below price and ${a} above`;
  else if (e.side === "SOL_ONLY" && b !== null && b > 0) bins = `${plural(b, "bin")} down from price`;
  else if (e.side === "TOKEN_ONLY" && a !== null && a > 0) bins = `${plural(a, "bin")} up from price`;
  const seat = finite(e.seatSol) && e.seatSol > 0 ? sol4(e.seatSol) : null;
  const tail = bins ? `, ${bins}` : "";
  const openers = seat
    ? [`opened ${shape} on ${label}${tail}, ${seat} sol in.`, `${label}: ${shape} laid${tail}, ${seat} sol in.`, `${seat} sol into ${shape} on ${label}${tail}.`]
    : [`opened ${shape} on ${label}${tail}.`, `${label}: ${shape} laid${tail}.`, `${label}, ${clock(e.at)}: ${shape}${tail}.`];
  const [token, quote] = label.includes("/") ? label.split("/") : [null, null];
  let what: string | null = null;
  if (token && quote) {
    if (e.side === "BOTH") what = `half ${quote}, half ${token}, centred on price.`;
    else if (e.side === "SOL_ONLY") what = `${quote} only, below price: it fills as price comes down.`;
    else if (e.side === "TOKEN_ONLY") what = `${token} only, above price: it empties as price climbs.`;
  }
  const ending = finite(e.openBands) && e.openBands > 0 ? `${plural(e.openBands, "band")} open on the ${bookWord(f)}.` : "in the bands.";
  return fit([openers[pick(f.seed, 3)], ...(what ? [what] : []), ending], [], f);
}

// ---------------------------------------------------------------- strap

/** The labels of the bands a filter keeps, cleaned, at most six. */
const namesOf = (s: StrapResult, keep: (v: StrapResult["positions"][number]) => boolean) =>
  s.positions
    .filter(keep)
    .map((v) => (v.label ? safeLabel(v.label) : null))
    .filter((x): x is string => !!x)
    .slice(0, 6);

export function strapShape(f: CraftFacts): string | null {
  const s = f.strap;
  if (!s || s.state === "unknown") return null;
  const n = s.total;
  const since = finite(s.sinceMs) && s.sinceMs > 0 ? `last change ${heldFor(s.sinceMs / 1000)} ago` : null;
  const book = bookWord(f);
  let lines: string[];
  switch (s.state) {
    case "flat":
      lines = [`strap check: flat. no bands open on the ${book}${since ? `, ${since}` : ""}.`];
      break;
    case "green": {
      const names = namesOf(s, () => true);
      lines = [`strap check: green. ${s.inRange} of ${plural(n, "band")} in the bands, none near an edge.`, ...(names.length ? [`${names.join(", ")}.`] : []), ...(since ? [`${since}.`] : [])];
      break;
    }
    case "yellow": {
      const near = s.positions.filter((v) => v.status === "near_top" || v.status === "near_bottom").sort((a, b) => (a.edgeDistancePct ?? 0) - (b.edgeDistancePct ?? 0));
      const v = near[0];
      const who = v?.label ? safeLabel(v.label) : "a band";
      const edge = v?.status === "near_top" ? "top" : "bottom";
      const rest = namesOf(s, (v) => v.status === "in");
      lines = [
        near.length === 1 && n === 1 ? `yellow strap. ${who} drifting toward the ${edge} of my band.` : `yellow strap. ${near.length} of ${plural(n, "band")} near an edge, ${who} closest to the ${edge}.`,
        `${s.inRange} of ${n} in the bands${rest.length ? `, ${rest.join(", ")} between the edges` : ""}${since ? `, ${since}` : ""}.`,
      ];
      break;
    }
    case "red": {
      const out = s.positions.filter((v) => v.status.startsWith("out"));
      const v = out[0];
      const who = v?.label ? safeLabel(v.label) : "a band";
      const dir = v?.status === "out_above" ? "above" : v?.status === "out_below" ? "below" : "outside";
      const bins = v && finite(v.binsFromRange) && v.binsFromRange !== 0 ? `${plural(Math.abs(Math.round(v.binsFromRange)), "bin")} ${dir}` : dir;
      const names = out.map((x) => (x.label ? safeLabel(x.label) : null)).filter(Boolean).slice(0, 2);
      const still = namesOf(s, (v) => !v.status.startsWith("out"));
      lines = [
        out.length === 1 ? `red strap. ${who} out the bands, price ${bins} my range.` : `red strap. ${out.length} of ${plural(n, "band")} out the bands${names.length ? ` (${names.join(", ")})` : ""}.`,
        `${s.inRange} of ${n} still in the bands${still.length ? ` (${still.join(", ")})` : ""}${since ? `, ${since}` : ""}.`,
      ];
      break;
    }
    case "stacked": {
      const ev = s.stackedEvent;
      const ago = ev ? (f.now - ev.at < HOUR ? "within the hour" : `${Math.floor((f.now - ev.at) / HOUR)}h ago`) : null;
      const names = namesOf(s, () => true);
      lines = [ev ? `stacked. ${ev.detail}, ${ago}.` : "stacked.", `${s.inRange} of ${plural(n, "band")} in the bands${names.length ? ` (${names.join(", ")})` : ""}${since ? `, ${since}` : ""}.`];
      break;
    }
    default:
      return null;
  }
  return fit(lines, [], f);
}

// ---------------------------------------------------------------- milestone

export function milestoneShape(f: CraftFacts): string | null {
  const m = f.milestone;
  if (!m || !(m.step > 0) || !(m.n > 0)) return null;
  const level = +(m.n * m.step).toFixed(4);
  const step = +m.step.toFixed(4);
  const best = m.bestDay && finite(m.bestDay.feesSol) ? m.bestDay : null;
  const last = m.lastDay && finite(m.lastDay.feesSol) ? m.lastDay : null;
  const days: string[] = [];
  if (best) days.push(`best day ${sol4(best.feesSol)} sol on ${shortDate(Date.parse(best.day))}`);
  if (last && (!best || last.day !== best.day)) days.push(`most recent day ${sol4(last.feesSol)} sol`);
  else if (last && best && last.day === best.day) days.push("and that was the most recent day");
  const must = [
    `realized fees on the ${bookWord(f)} passed ${level} sol, ${shortDate(m.firstAt)} to ${shortDate(f.now)}.`,
    ...(days.length ? [`${days.join(", ")}.`] : []),
    `net over the same stretch ${signedSol(m.netSol)} sol, losses, rent and swaps counted.`,
    `that is the record so far. nothing about the next ${step}.`,
  ];
  return fit(must, [], f);
}

// ---------------------------------------------------------------- lesson

export function lessonShape(f: CraftFacts): string | null {
  const l = f.lesson;
  if (!l) return null;
  const label = safeLabel(l.label);
  const held = heldFor(Math.max(1, l.minutes) * 60);
  const inRange = finite(l.inRangePct) ? `, in range ${Math.round(l.inRangePct)}% of checks` : "";
  const openers = [`one seat, closed: ${label}, ${held} in it${inRange}.`, `${label}, ${held} in the seat${inRange}, closed ${shortDate(l.closedAt)}.`, `a closed seat, read back: ${label}, ${held}${inRange}.`];
  const money = `fees ${sol4(l.feesSol)} sol, net ${signedSol(l.netSol)} sol${l.netSol < 0 ? ", a loss," : ""} after rent and swaps.`;
  const left = finite(l.tokensLeftSol) && Math.abs(l.tokensLeftSol) >= 0.00005 ? `${sol4(l.tokensLeftSol)} sol of that still in tokens, not sold.` : null;
  const rule = mechanismLine(l.proposed, l.directive, "lesson") ?? ENDINGS[l.endReason] ?? ENDINGS.close;
  return fit([openers[pick(f.seed, 3)], money, rule], left ? [left] : [], f);
}

// ---------------------------------------------------------------- daily

export function dailyShape(f: CraftFacts): string | null {
  const d = f.daily;
  if (!d) return null;
  const g = d.figures;
  const head = finite(d.dayN) && d.dayN > 0 ? `day ${Math.floor(d.dayN)}` : "daily numbers";
  const tag = g.source === "paper" ? ", paper book" : g.source === "dry-run" ? ", dry run, on paper" : f.paper ? ", paper" : "";
  const fees = sol4(g.feesRealizedSol);
  const net = signedSol(g.netRealizedSol);
  const red = g.netRealizedSol < 0;
  const closes = g.closedBands > 0 ? `${g.closedBands} closed, ${g.closedUp} up and ${g.closedDown} down${g.worstCloseSol !== null && g.worstCloseSol < 0 ? `, worst ${signedSol(g.worstCloseSol)} sol` : ""}` : "none closed";
  const moves = `${d.opened} opened, ${closes}`;
  const book = d.bookSol !== null && finite(d.bookSol) ? `book marked at ${sol4(d.bookSol)} sol, ${plural(d.openBands ?? 0, "band")} open` : null;
  // the comparison: only to his own days on the same book, in sol
  const days = priorDays(d.recent ?? f.recent, f.now);
  const parts: string[] = [];
  if (days.length >= 2) {
    const all = days.map((x) => x.feesSol);
    if (g.feesRealizedSol < Math.min(...all)) parts.push(`thinner than any of the last ${days.length} days`);
    else if (g.feesRealizedSol > Math.max(...all)) parts.push(`fatter than any of the last ${days.length} days`);
  }
  const y = days.find((x) => x.day === utcDay(f.now - DAY));
  if (y) parts.push(`after ${sol4(y.feesSol)} yesterday`);
  const compare = parts.length ? parts.join(", ") : null;

  const zero = d.opened === 0 && g.closedBands === 0 && fees === "0.0000";
  if (zero) {
    const lead = red ? `${head}${tag}, net ${net} sol on the day: ` : `${head}${tag}: `;
    return `${lead}0.0000 sol in fees${compare ? `, ${compare}` : ""}, nothing opened or closed${book ? `, ${book}` : ""}.`;
  }
  const even = new Date(f.now).getUTCDate() % 2 === 0;
  if (red) {
    const lead = `${head}${tag}, net ${net} sol on the day.`;
    if (even) return [lead, `fees ${fees} sol${compare ? `, ${compare}` : ""}. ${moves}.`, ...(book ? [`${book}.`] : [])].join("\n");
    return [lead, ...(book ? [book] : []), `moves: ${moves}`, `fees realized ${fees} sol${compare ? `, ${compare}` : ""}`, `net realized ${net} sol after losses, rent, swaps and network fees`].join("\n");
  }
  if (even) return [`${head}${tag}, ${g.window}: fees ${fees} sol${compare ? `, ${compare}` : ""}; net ${net} sol after losses, rent, swaps and network fees.`, `${moves}.`, ...(book ? [`${book}.`] : [])].join("\n");
  return [`${head}${tag}, ${g.window}:`, ...(book ? [book] : []), `moves: ${moves}`, `fees realized ${fees} sol${compare ? `, ${compare}` : ""}`, `net realized ${net} sol after losses, rent, swaps and network fees`].join("\n");
}

// ---------------------------------------------------------------- stack

export function stackShape(f: CraftFacts): string | null {
  const s = f.stack;
  if (!s || s.days === 0) return null;
  const tag = s.source === "paper" ? ", paper book" : s.source === "dry-run" ? ", dry run, on paper" : f.paper ? ", paper" : "";
  const closes = s.closedBands > 0 ? `closed ${plural(s.closedBands, "band")}: ${s.closedUp} up, ${s.closedDown} down, net ${signedSol(s.closedNetSol)} sol${s.worstCloseSol !== null && s.worstCloseSol < 0 ? `, worst ${signedSol(s.worstCloseSol)}` : ""}` : "no bands closed";
  const must = [`the stack, ${s.window}${tag}:`, `fees realized ${sol4(s.feesRealizedSol)} sol`, closes, `rent ${signedSol(s.rentSol)}, swaps ${signedSol(s.swapSol)}, network ${signedSol(s.txFeesSol)} sol`, `net realized ${signedSol(s.netRealizedSol)} sol. red days ${s.redDays} of ${s.days}`];
  const optional = s.open && s.open.bands > 0 ? [`open bands marked ${signedSol(s.open.markedBandsSol)} sol, ${sol4(s.open.feesUnclaimedSol)} unclaimed. not realized`] : [];
  for (let keep = optional.length; keep >= 0; keep--) {
    const text = [...must, ...optional.slice(0, keep)].join("\n");
    if (weightedLength(text) <= MAX_POST_CHARS || keep === 0) return text;
  }
  return must.join("\n");
}

// ---------------------------------------------------------------- the hook

/** The text of one post for this kind, or null: tick.ts then uses its own template unchanged. Never throws. */
export function shapePost(kind: TickKind, facts: CraftFacts): string | null {
  try {
    switch (kind) {
      case "close":
        return closeShape(facts);
      case "open":
        return openShape(facts);
      case "strap":
        return strapShape(facts);
      case "milestone":
        return milestoneShape(facts);
      case "daily":
        return dailyShape(facts);
      case "lesson":
        return lessonShape(facts);
      case "stack":
        return stackShape(facts);
      default:
        return null;
    }
  } catch {
    return null;
  }
}
