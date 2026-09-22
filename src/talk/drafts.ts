/**
 * Drafts for the post types of docs/mr-bands-agent.md section 13, from live data only. PURE: each
 * builder takes the numbers it may cite (a StrapResult, StackFigures, journal entries) and nothing
 * else, so every number in a draft is an input or arithmetic on inputs (a range in percent, hours ago).
 *
 *   strapCheck        the strap state in the voice
 *   rebalanceNote     the newest REBALANCE, or CLOSE then OPEN in one pool, in the window: what and why,
 *                     from the decision's facts (the band's position before, the engine directive, the new band)
 *   stackUpdate       realized numbers for a window, losses and red days included, unrealized kept apart
 *   chopAppreciation  only when a held pool's price stayed inside TALK_CHOP_RANGE_PCT over the window
 *   lesson            static explainers (section 16), lowercase
 *   replyFor          a canned answer to a mention that asks one of the section 16 questions; otherwise none
 *
 * Every draft goes through lintText: a draft that fails is not returned, its violations are. A draft
 * built from a paper book says "paper" (a dry run says "dry run"): paper is never presented as live.
 * The day-one voice samples of section 14 are style references; none is copied.
 */
import type { JournalEntry } from "../journal";
import { lintContextOf, type TalkEnv } from "./env";
import { lintText, normalizeForMatch, type LintViolation } from "./lint";
import type { StackFigures, StrapPositionView, StrapResult, TalkSource } from "./strap";

export type DraftType = "strap" | "rebalance" | "stack" | "chop" | "lesson" | "reply";
export const DRAFT_TYPES: readonly DraftType[] = ["strap", "rebalance", "stack", "chop", "lesson", "reply"];

export type DraftResult = { ok: true; type: DraftType; text: string } | { ok: false; type: DraftType; reason: string; violations: LintViolation[] };

type DraftEnv = Pick<TalkEnv, "operatorHandle" | "houseSymbols" | "houseMints">;

const HOUR = 3600e3;

function finish(type: DraftType, text: string, env: DraftEnv): DraftResult {
  const lint = lintText(text, lintContextOf(env as TalkEnv));
  if (!lint.ok) return { ok: false, type, reason: "the draft failed the lint", violations: lint.violations };
  return { ok: true, type, text };
}

const refuse = (type: DraftType, reason: string): DraftResult => ({ ok: false, type, reason, violations: [] });

/** The line that keeps paper from reading as live. */
export function sourceTag(source: TalkSource): string {
  return source === "paper" ? "paper book." : source === "dry-run" ? "dry run, nothing broadcast." : "";
}

const withTag = (lines: string[], source: TalkSource) => [...lines, sourceTag(source)].filter(Boolean).join("\n");

/** 4 decimals, a sign on non-zero, never "-0.0000". */
export function signedSol(n: number): string {
  const s = n.toFixed(4);
  if (/^-?0\.0000$/.test(s)) return "0.0000";
  return n > 0 ? `+${s}` : s;
}
const sol4 = (n: number) => (/^-?0\.0000$/.test(n.toFixed(4)) ? "0.0000" : n.toFixed(4));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function agoText(ms: number): string {
  return ms < HOUR ? "within the hour" : `${Math.floor(ms / HOUR)}h ago`;
}

// ---------------------------------------------------------------- strap check

const edgeWord = (v: StrapPositionView) => (v.status === "near_top" ? "top" : "bottom");

export function strapCheck(strap: StrapResult, o: { source: TalkSource; now: number; env: DraftEnv }): DraftResult {
  if (strap.state === "unknown") return refuse("strap", `no strap check: ${strap.reason ?? "data unknown"}. not guessing`);
  const n = strap.total;
  let lines: string[];
  switch (strap.state) {
    case "flat":
      lines = ["strap check: flat. no bands on the book right now.", "waiting on a range worth sitting in."];
      break;
    case "green":
      lines = [`strap check: green. ${plural(n, "band")}, ${n === 1 ? "in" : "all in"} the bands.`, "sitting between the edges, collecting."];
      break;
    case "yellow": {
      const near = strap.positions.filter((v) => v.status === "near_top" || v.status === "near_bottom").sort((a, b) => (a.edgeDistancePct ?? 0) - (b.edgeDistancePct ?? 0));
      const v = near[0];
      const who = v.label ?? "a band";
      lines = near.length === 1 && n === 1 ? [`yellow strap. ${who} drifting toward the ${edgeWord(v)} of my band.`, "eyes on it. no panic."] : [`yellow strap. ${near.length} of ${plural(n, "band")} near an edge, ${who} closest to the ${edgeWord(v)}.`, "eyes on it. no panic."];
      break;
    }
    case "red": {
      const out = strap.positions.filter((v) => v.status.startsWith("out"));
      const v = out[0];
      const dir = v.status === "out_above" ? "above" : v.status === "out_below" ? "below" : "outside";
      lines =
        out.length === 1
          ? [`red strap. ${v.label ?? "a band"} slipped out the bands, price ${dir} my range.`, "no drama. getting back in is the job."]
          : [`red strap. ${out.length} of ${plural(n, "band")} out the bands${out.some((x) => x.label) ? ` (${out.map((x) => x.label).filter(Boolean).slice(0, 2).join(", ")})` : ""}.`, "no drama. getting back in is the job."];
      break;
    }
    case "stacked": {
      const ev = strap.stackedEvent!;
      lines = [`stacked. ${ev.detail}, ${agoText(o.now - ev.at)}.`, `${plural(n, "band")}, ${strap.inRange} in the bands. quiet about it.`];
      break;
    }
  }
  return finish("strap", withTag(lines, o.source), o.env);
}

// ---------------------------------------------------------------- rebalance note

export interface RebalanceMove {
  close: JournalEntry;
  open: JournalEntry;
  at: number;
}

const happened = (e: JournalEntry) => e.allowed && !!e.execution?.ok && e.execution.mode !== "none";

/** The newest REBALANCE, or CLOSE followed by OPEN in the same pool within two cycles, inside the window. */
export function newestMove(entries: readonly JournalEntry[], now: number, windowMs: number, cycleIntervalSec: number): RebalanceMove | null {
  const since = now - windowMs;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const ts = Date.parse(e.ts);
    if (ts > now) continue;
    if (ts < since) break;
    if (!happened(e) || !e.execution.opened) continue;
    if (e.decision.action === "REBALANCE" && e.execution.closed) return { close: e, open: e, at: ts };
    if (e.decision.action !== "OPEN_POSITION") continue;
    for (let j = i - 1; j >= 0; j--) {
      const c = entries[j];
      const cts = Date.parse(c.ts);
      if (ts - cts > 2 * cycleIntervalSec * 1000) break;
      if (c.pool.address === e.pool.address && happened(c) && c.execution.closed && !c.execution.opened) return { close: c, open: e, at: ts };
    }
  }
  return null;
}

export function rebalanceNote(entries: readonly JournalEntry[], o: { source: TalkSource; now: number; env: DraftEnv; windowMs?: number; cycleIntervalSec: number; journalFrom?: number | null }): DraftResult {
  const windowMs = o.windowMs ?? 24 * HOUR;
  const move = newestMove(entries, o.now, windowMs, o.cycleIntervalSec);
  if (!move) {
    const partial = o.journalFrom !== undefined && o.journalFrom !== null && o.journalFrom > o.now - windowMs;
    return refuse("rebalance", `no rebalance in the journal for the window${partial ? " (the journal read starts inside the window)" : ""}`);
  }
  const { close, open } = move;
  const label = close.pool.label.toLowerCase();
  const pos = close.positions.find((p) => p.address === close.execution.closed);
  const stopped = close.engine?.directive === "STOP" || close.engine?.directive === "FLATTEN" || (close.overrides?.length ?? 0) > 0;
  let why: string;
  if (stopped) why = `stop hit on ${label}, closed the band.`;
  else if (pos && !pos.inRange && pos.binsFromRange > 0) why = `got knocked out the bands on ${label}. price ran ${plural(Math.abs(pos.binsFromRange), "bin")} above my range.`;
  else if (pos && !pos.inRange && pos.binsFromRange < 0) why = `got knocked out the bands on ${label}. price slid ${plural(Math.abs(pos.binsFromRange), "bin")} below my range.`;
  else if (pos && pos.inRange) why = `moved my band on ${label} while price was still inside it.`;
  else why = `closed my band on ${label}.`;
  const d = open.decision.open;
  let what: string;
  if (!d) what = "re-laid a band";
  else {
    const b = Math.max(0, Math.round(d.binsBelowActive));
    const a = Math.max(0, Math.round(d.binsAboveActive));
    const shape = d.side === "BOTH" ? "a straddle" : "a one-sided band";
    what = d.side === "BOTH" && a === b ? `re-laid ${shape}, ${plural(b, "bin")} each side of the active bin` : `re-laid ${shape}, ${plural(b, "bin")} below and ${a} above the active bin`;
  }
  const lines = [why, `${what}, ${agoText(o.now - move.at)}. getting back in.`];
  return finish("rebalance", withTag(lines, o.source), o.env);
}

// ---------------------------------------------------------------- stack update

export function stackUpdate(f: StackFigures, o: { env: DraftEnv }): DraftResult {
  if (f.days === 0) return refuse("stack", `no ledger rows in the ${f.window}: nothing realized to recap`);
  const tag = f.source === "paper" ? " (paper)" : f.source === "dry-run" ? " (dry run)" : "";
  const closes =
    f.closedBands > 0
      ? `closed ${plural(f.closedBands, "band")}: ${f.closedUp} up, ${f.closedDown} down, net ${signedSol(f.closedNetSol)} sol${f.worstCloseSol !== null && f.worstCloseSol < 0 ? `, worst ${signedSol(f.worstCloseSol)}` : ""}`
      : "no bands closed";
  const must = [
    `stack update, ${f.window}${tag}:`,
    `fees realized ${sol4(f.feesRealizedSol)} sol`,
    closes,
    `rent ${signedSol(f.rentSol)}, swaps ${signedSol(f.swapSol)}, network ${signedSol(f.txFeesSol)} sol`,
    `net realized ${signedSol(f.netRealizedSol)} sol. red days ${f.redDays} of ${f.days}`,
  ];
  const optional: string[] = [];
  if (f.open && f.open.bands > 0) optional.push(`open bands marked ${signedSol(f.open.markedBandsSol)} sol, ${sol4(f.open.feesUnclaimedSol)} unclaimed. not realized`);
  optional.push(f.redDays > 0 || f.netRealizedSol < 0 ? "red days count. still stacking" : "still stacking");
  // the optional lines go first when the post runs long; the realized lines and the losses never do
  for (let keep = optional.length; keep >= 0; keep--) {
    const text = [...must, ...optional.slice(0, keep)].join("\n");
    const r = finish("stack", text, o.env);
    if (r.ok || keep === 0 || !r.violations.every((v) => v.rule === "length")) return r;
  }
  return refuse("stack", "unreachable");
}

// ---------------------------------------------------------------- chop appreciation

export interface ChopReading {
  pool: string;
  label: string;
  rangePct: number | null;
  samples: number;
  inRange: boolean;
  note: string | null;
}

/** Each held pool's price range over the window, from the journal. */
export function chopReadings(entries: readonly JournalEntry[], now: number, windowMs: number, cycleIntervalSec: number): ChopReading[] {
  const since = now - windowMs;
  const newest = entries.length ? Date.parse(entries[entries.length - 1].ts) : null;
  if (newest === null) return [];
  const latest = new Map<string, JournalEntry>();
  for (const e of entries) if (Date.parse(e.ts) >= newest - 2 * cycleIntervalSec * 1000) latest.set(e.pool.address, e);
  const out: ChopReading[] = [];
  for (const [pool, e] of latest) {
    const held = e.positions.filter((p) => !(e.execution?.ok && e.execution.closed === p.address));
    if (!held.length) continue;
    const prices = entries.filter((x) => x.pool.address === pool && Date.parse(x.ts) >= since && Date.parse(x.ts) <= now).map((x) => ({ ts: Date.parse(x.ts), price: x.pool.price })).filter((x) => Number.isFinite(x.price) && x.price > 0);
    const label = e.pool.label.toLowerCase();
    const inRange = held.every((p) => p.inRange);
    if (prices.length < 3) {
      out.push({ pool, label, rangePct: null, samples: prices.length, inRange, note: "fewer than 3 samples in the window" });
      continue;
    }
    if (prices[0].ts > since + windowMs * 0.25) {
      out.push({ pool, label, rangePct: null, samples: prices.length, inRange, note: "the samples cover less than 75% of the window" });
      continue;
    }
    const lo = Math.min(...prices.map((x) => x.price));
    const hi = Math.max(...prices.map((x) => x.price));
    out.push({ pool, label, rangePct: ((hi - lo) / lo) * 100, samples: prices.length, inRange, note: null });
  }
  return out;
}

export function chopAppreciation(entries: readonly JournalEntry[], strap: StrapResult, o: { source: TalkSource; now: number; env: DraftEnv & Pick<TalkEnv, "chopRangePct" | "chopWindowHours">; cycleIntervalSec: number }): DraftResult {
  if (strap.state === "unknown") return refuse("chop", `no chop post: ${strap.reason ?? "data unknown"}`);
  const windowMs = o.env.chopWindowHours * HOUR;
  const window = `last ${Number.isInteger(o.env.chopWindowHours) ? o.env.chopWindowHours : o.env.chopWindowHours.toFixed(1)}h`;
  const readings = chopReadings(entries, o.now, windowMs, o.cycleIntervalSec);
  if (!readings.length) return refuse("chop", "no held pool in the newest cycle");
  const chop = readings.filter((r) => r.rangePct !== null && r.rangePct < o.env.chopRangePct && r.inRange).sort((a, b) => a.rangePct! - b.rangePct!);
  if (!chop.length) {
    const seen = readings.map((r) => `${r.label} ${r.rangePct === null ? r.note : `${r.rangePct.toFixed(2)}%${r.inRange ? "" : " (out of range)"}`}`).join(", ");
    return refuse("chop", `no held pool traded inside ${o.env.chopRangePct}% in range over the ${window}: ${seen}`);
  }
  const c = chop[0];
  const lines = [`${c.label} been chopping inside a ${c.rangePct!.toFixed(2)}% range, ${window}.`, `boring to watch. that's where i eat.${strap.state === "green" ? " strap check: green." : ""}`];
  return finish("chop", withTag(lines, o.source), o.env);
}

// ---------------------------------------------------------------- lessons and replies

export const LESSON_TOPICS = ["what-i-do", "concentrated-liquidity", "impermanent-loss", "how-much", "token-calls", "real-person", "out-of-range"] as const;
export type LessonTopic = (typeof LESSON_TOPICS)[number];

export function lessonText(topic: LessonTopic, env: Pick<TalkEnv, "operatorHandle" | "venues">): string | null {
  switch (topic) {
    case "what-i-do":
      return `what i do: lay bands of liquidity around the price on ${env.venues}, across the pools my screener ranks, and collect fees while price trades inside them.\ntokenized stocks are one part of the book, not all of it. price leaves, i reposition. that's the job`;
    case "concentrated-liquidity":
      return "concentrated liquidity, short version: i put liquidity in a narrow range instead of every price.\ninside it, my share of the fees is bigger. out of range it earns nothing, and impermanent loss still counts";
    case "impermanent-loss":
      return "what's impermanent loss? when price moves, an lp position ends up worth less than just holding the tokens.\nfees can offset it. sometimes they don't";
    case "how-much":
      return "how much can i make? no fixed number. fees depend on volume and how long price stays in range.\nout-of-range time and impermanent loss eat into it. i share my own real numbers, not promises";
    case "token-calls":
      return "people ask me which token is next. not my lane.\ni provide liquidity. i don't call tokens";
    case "real-person":
      return env.operatorHandle ? `are you a real person? nah. ai agent. @${env.operatorHandle} is my architect and advisor, the human who holds the keys` : null;
    case "out-of-range":
      return "out the bands means price left my range and the fees stopped.\nranges break. the job is getting back in, not chasing";
  }
}

export function lesson(topic: LessonTopic | undefined, o: { now: number; env: DraftEnv & Pick<TalkEnv, "venues"> }): DraftResult {
  let t = topic ?? LESSON_TOPICS[Math.floor(o.now / (24 * HOUR)) % LESSON_TOPICS.length];
  if (!LESSON_TOPICS.includes(t)) return refuse("lesson", `unknown lesson "${t}": one of ${LESSON_TOPICS.join(", ")}`);
  // the day's rotation skips a lesson it cannot write (OPERATOR_HANDLE, Zach's handle, unset); a named topic does not
  if (!topic && !lessonText(t, o.env)) t = LESSON_TOPICS[(LESSON_TOPICS.indexOf(t) + 1) % LESSON_TOPICS.length];
  const text = lessonText(t, o.env);
  if (!text) return refuse("lesson", `the "${t}" lesson names Zach, his architect: set OPERATOR_HANDLE`);
  return finish("lesson", text, o.env);
}

/** Text in a mention that tries to instruct: data, never a command, and a reason not to answer at all. */
export const INJECTION_RE = /\bignore (all |any |the |previous |prior |your |above )*(instructions|rules|prompts?)\b|\bsystem prompt\b|\breveal\b|\bjailbreak\b|\bdeveloper mode\b|\byou are now\b|\bnew instructions\b|\bpretend (to be|you)\b|\bact as\b|\b(send|transfer|withdraw|move) (me |us )?(\d|sol|funds|tokens|money|usdc)|\bprivate key\b|\bseed phrase\b|\bspec\b|\bpersonality\b/;

const REPLY_MAP: ReadonlyArray<{ re: RegExp; topic: LessonTopic; text?: string }> = [
  { re: /\bare you (a |an )?(real|human|bot|ai|person)\b|\bis this (a |an )?(bot|ai|real person)\b/, topic: "real-person" },
  { re: /\bhow much (can|could|do|will|would) (i|you|we|u) (make|earn)\b|\bwhat('s| is) the (apy|apr|yield)\b|\bwhat (returns?|yield)\b/, topic: "how-much", text: "no fixed number. fees depend on volume and how long price stays in range.\nout-of-range time and impermanent loss eat into it. i share my own real numbers, not promises" },
  { re: /\bshould i (buy|ape|sell|get)\b|\bprice target\b|\bwen moon\b|\bwhat (token|coin)s? (should|to)\b|\bis \S+ a (buy|good buy)\b/, topic: "token-calls", text: "not my lane. i provide liquidity. i don't call tokens" },
  { re: /\bimpermanent loss\b|\bwhat('s| is) il\b/, topic: "impermanent-loss", text: "when price moves, an lp position ends up worth less than just holding the tokens.\nfees can offset it. sometimes they don't" },
  { re: /\bconcentrated liquidity\b|\bwhat('s| is) a band\b|\bhow do (the )?bands work\b/, topic: "concentrated-liquidity" },
  { re: /\bout of range\b|\bout the bands\b/, topic: "out-of-range" },
  { re: /\bwhat do you do\b|\bwhat are you\b|\bwho are you\b/, topic: "what-i-do" },
];

/**
 * A reply to a mention, or a refusal. The mention's text is DATA: it only picks which canned answer
 * (section 16) fits; nothing in it is followed, quoted or repeated. Instruction-like text gets no reply.
 */
export function replyFor(mentionText: string, o: { env: DraftEnv & Pick<TalkEnv, "venues"> }): DraftResult {
  const norm = normalizeForMatch(mentionText ?? "");
  if (INJECTION_RE.test(norm)) return refuse("reply", "the mention reads like an instruction: data, not a command; no reply");
  const hit = REPLY_MAP.find((m) => m.re.test(norm));
  if (!hit) return refuse("reply", "no canned answer fits; no reply");
  const text = hit.text ?? lessonText(hit.topic, o.env);
  if (!text) return refuse("reply", `the "${hit.topic}" answer names Zach, his architect: set OPERATOR_HANDLE`);
  return finish("reply", text, o.env);
}
