/**
 * SELF-LEARNING, the first loop. Zach (2026-09-17): "We need to make sure our system is agentic and
 * self learning meaning that it takes note of mistakes and makes adjustments necessary to improve
 * steadily over time."
 *
 * Two parts, both pure where they decide:
 *   1. LESSONS: every closed seat becomes a record (lessonOf): what the scout measured at entry, the
 *      width laid, how long it stayed in range, why it ended, the fees claimed against the seat
 *      check's prediction, the net result. Appended to DATA_DIR/lessons.jsonl.
 *   2. TUNING: from the recent lessons, a bounded knob moves one fixed step at a time
 *      (tuneFromLessons), each change written with its evidence to DATA_DIR/tuning.json, which the
 *      policy reads live (applyTuning). Band width is the first knob: through-band exits within
 *      minutes of laying widen it (baton/SOL was priced out of a 4% band in six minutes on a token
 *      moving 24 bins an hour), long idle stretches at low yield narrow it.
 * The guards, the stops and the exposure limits are never touched here: the tuner proposes width,
 * the guards still decide every trade.
 */
import fs from "node:fs";
import type { LedgerRow } from "../engine/ledger";

export type SeatKind = "memecoin" | "stock" | "other";

/** What the desk knew when it laid the band, kept in state per position until the band closes. */
export interface BandMeta {
  pool: string;
  label: string;
  kind: SeatKind;
  openedAt: number;
  seatSol: number;
  /** bins in the band, all sides */
  bins: number;
  binStep: number;
  /** percent of price the band covers each way (approximate for a one-sided band: its whole reach) */
  coverPct: number;
  /** the scout's measured travel in the hour before the open, in bins; null when it had no reading */
  travelBins60m: number | null;
  /** the last seat check's yield on this seat, percent a day; null until one ran */
  predictedYieldPct: number | null;
}

export interface RangeStats {
  cycles: number;
  inRange: number;
}

export type EndReason = "through-band" | "idle" | "stop" | "faded" | "rotated" | "exit-list" | "consolidated" | "flatten" | "expire" | "close";

export interface Lesson {
  at: number;
  /** the desk's mode when the seat closed: a rehearsal's or a paper book's lesson never teaches the live knob */
  mode: string;
  pool: string;
  label: string;
  position: string;
  kind: SeatKind;
  openedAt: number;
  closedAt: number;
  minutes: number;
  seatSol: number;
  bins: number;
  binStep: number;
  coverPct: number;
  travelBins60m: number | null;
  /** cycles in range over cycles observed, percent; null when never observed */
  inRangePct: number | null;
  endReason: EndReason;
  /** fees claimed on the seat (collects and the close's fee leg), SOL */
  feesSol: number;
  /** SOL that came back less SOL that went in, rent and network fees included */
  netSol: number;
  predictedYieldPct: number | null;
  /** fees over the seat, per day, percent */
  realizedYieldPctPerDay: number;
  headline: string;
}

/** PURE. Why a seat ended, from the directive that closed it or the policy's headline. */
export function endReasonOf(directiveKind: string | null, rotateReason: string | null, headline: string, guardOverrides: readonly string[] = []): EndReason {
  const h = headline.toLowerCase();
  const rr = (rotateReason ?? "").toLowerCase();
  // the guards' own stop overrides whatever was proposed: the headline is then the proposal's, not the reason
  if (directiveKind === "STOP" || guardOverrides.some((o) => /^stop-loss/i.test(o))) return "stop";
  if (directiveKind === "FLATTEN") return "flatten";
  if (directiveKind === "EXPIRE") return "expire";
  if (directiveKind === "ROTATE") {
    if (rr.includes("operator's exit list")) return "exit-list";
    if (rr.includes("its own flow faded")) return "faded";
    if (rr.includes("already held")) return "consolidated";
    return "rotated";
  }
  if (h.includes("through the band")) return "through-band";
  if (h.includes("ran off the top") || h.includes("idle")) return "idle";
  return "close";
}

/**
 * PURE. The lesson of a closed seat from its meta, its range stats and the ledger rows that belong
 * to it: the position's own rows, plus the pool's swap rows inside the seat's life (the token half
 * bought at the open, the liquidation at the close).
 */
export function lessonOf(i: { meta: BandMeta; position: string; stats: RangeStats | null; rows: readonly LedgerRow[]; closedAt: number; endReason: EndReason; headline: string; mode?: string; ledgerMode?: LedgerRow["mode"] }): Lesson {
  const { meta, stats } = i;
  const rows = i.ledgerMode ? i.rows.filter((r) => r.mode === i.ledgerMode) : i.rows;
  const mine = rows.filter((r) => r.position === i.position || (r.pool === meta.pool && r.mech === "swap" && r.ts >= meta.openedAt - 120_000 && r.ts <= i.closedAt + 180_000));
  const netSol = mine.reduce((t, r) => t + r.solDelta + r.rentSol + r.txFeeSol, 0);
  const feesSol = mine.reduce((t, r) => t + (r.mech === "collect" ? (r.feeSol ?? Math.max(0, r.solDelta)) : r.mech === "close" ? (r.feeSol ?? 0) : 0), 0);
  const minutes = Math.max(1 / 60, (i.closedAt - meta.openedAt) / 60_000);
  const realizedYieldPctPerDay = meta.seatSol > 0 ? (feesSol / meta.seatSol) * (1440 / minutes) * 100 : 0;
  return {
    at: i.closedAt,
    mode: i.mode ?? "live",
    pool: meta.pool,
    label: meta.label,
    position: i.position,
    kind: meta.kind,
    openedAt: meta.openedAt,
    closedAt: i.closedAt,
    minutes: Math.round(minutes * 10) / 10,
    seatSol: meta.seatSol,
    bins: meta.bins,
    binStep: meta.binStep,
    coverPct: meta.coverPct,
    travelBins60m: meta.travelBins60m,
    inRangePct: stats && stats.cycles > 0 ? Math.round((stats.inRange / stats.cycles) * 1000) / 10 : null,
    endReason: i.endReason,
    feesSol: Math.round(feesSol * 1e6) / 1e6,
    netSol: Math.round(netSol * 1e6) / 1e6,
    predictedYieldPct: meta.predictedYieldPct,
    realizedYieldPctPerDay: Math.round(realizedYieldPctPerDay * 100) / 100,
    headline: i.headline,
  };
}

/** One line for the log and the journal. */
export const lessonLine = (l: Lesson): string =>
  `[lesson] ${l.label}: ${l.minutes} min, ${l.bins} bins (${l.coverPct.toFixed(1)}% of price${l.travelBins60m !== null ? ` against ${l.travelBins60m} bins of travel the hour before` : ""}), in range ${l.inRangePct === null ? "n/a" : `${l.inRangePct}%`} of the time, ended ${l.endReason}; fees ${l.feesSol.toFixed(4)} SOL (${l.realizedYieldPctPerDay.toFixed(1)}%/day realized${l.predictedYieldPct !== null ? ` vs ${l.predictedYieldPct.toFixed(1)}% predicted` : ""}), net ${l.netSol >= 0 ? "+" : ""}${l.netSol.toFixed(4)} SOL`;

/* ---------- tuning ---------- */

export interface TuningChange {
  at: number;
  knob: "volMultiple";
  from: number;
  to: number;
  why: string;
}

export interface Tuning {
  volMultiple?: number;
  history: TuningChange[];
}

export interface TuneEnv {
  /** the step the width multiple moves by (LEARN_WIDTH_STEP) */
  step: number;
  /** its bounds (LEARN_WIDTH_MIN / LEARN_WIDTH_MAX) */
  min: number;
  max: number;
  /** the least time between two changes of the same knob (LEARN_MIN_GAP_MIN) */
  minGapMs: number;
  /** how many recent lessons a rule reads (LEARN_WINDOW) */
  window: number;
  /** a through-band exit this soon after laying counts as "priced out" (LEARN_PRICED_OUT_MIN) */
  pricedOutMin: number;
  /** the idle rule: in range this much of the time and earning under this yield, the band is wider than it needs (LEARN_IDLE_IN_RANGE_PCT, LEARN_IDLE_YIELD_PCT) */
  idleInRangePct: number;
  idleYieldPct: number;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function tuneEnv(env: NodeJS.ProcessEnv = process.env): TuneEnv {
  return {
    step: Math.max(0.05, num(env.LEARN_WIDTH_STEP, 0.25)),
    min: Math.max(0.1, num(env.LEARN_WIDTH_MIN, 0.5)),
    max: Math.max(0.2, num(env.LEARN_WIDTH_MAX, 1.5)),
    minGapMs: Math.max(0, num(env.LEARN_MIN_GAP_MIN, 360)) * 60_000,
    window: Math.max(2, Math.floor(num(env.LEARN_WINDOW, 5))),
    pricedOutMin: Math.max(1, num(env.LEARN_PRICED_OUT_MIN, 30)),
    idleInRangePct: Math.max(0, num(env.LEARN_IDLE_IN_RANGE_PCT, 90)),
    idleYieldPct: Math.max(0, num(env.LEARN_IDLE_YIELD_PCT, 2)),
  };
}

/**
 * PURE. The one change the recent memecoin lessons argue for, if any: widen when most of the last
 * seats were priced out within minutes of laying; narrow when they sat in range nearly all the time
 * and earned under the floor. One step, inside the bounds, never twice inside the gap.
 */
export function tuneFromLessons(lessons: readonly Lesson[], current: { volMultiple: number }, tuning: Tuning | null, env: TuneEnv, now: number, mode = "live"): TuningChange | null {
  const last = tuning?.history.length ? tuning.history[tuning.history.length - 1] : null;
  if (last && now - last.at < env.minGapMs) return null;
  // only what was learned SINCE the last change counts: the same five lessons must not buy a second
  // step after the gap, and the step just taken has to show in new seats before another follows
  const recent = lessons.filter((l) => l.kind === "memecoin" && (l.mode ?? "live") === mode && (!last || l.at > last.at)).slice(-env.window);
  if (recent.length < env.window) return null;
  // priced out: through the band, or stopped (a band narrower than the stop goes through it first), within minutes of laying
  const isPricedOut = (l: Lesson) => (l.endReason === "through-band" || l.endReason === "stop") && l.minutes <= env.pricedOutMin;
  const pricedOut = recent.filter(isPricedOut).length;
  const round = (v: number) => Math.round(v * 100) / 100;
  if (pricedOut * 2 > recent.length && current.volMultiple < env.max) {
    const to = round(Math.min(env.max, current.volMultiple + env.step));
    return { at: now, knob: "volMultiple", from: current.volMultiple, to, why: `${pricedOut} of the last ${recent.length} memecoin seats were priced out of the band within ${env.pricedOutMin} min of laying (${recent.filter(isPricedOut).map((l) => `${l.label} ${l.minutes} min`).join(", ")}): the band follows more of the token's travel` };
  }
  const idle = recent.filter((l) => l.inRangePct !== null && l.inRangePct >= env.idleInRangePct && l.realizedYieldPctPerDay < env.idleYieldPct).length;
  if (idle === recent.length && current.volMultiple > env.min) {
    const to = round(Math.max(env.min, current.volMultiple - env.step));
    return { at: now, knob: "volMultiple", from: current.volMultiple, to, why: `the last ${recent.length} memecoin seats sat in range ${env.idleInRangePct}% of the time or more and earned under ${env.idleYieldPct}%/day: the band is wider than the flow needs` };
  }
  return null;
}

/**
 * PURE. The policy env with the tuned knob beside the configured one, inside the tuner's bounds. The
 * multiple is learned from memecoin seats, so it rides as `tunedVolMultiple` and the policy applies it
 * to pools that are not stocks; `volMultiple` stays what the env says.
 */
export function applyTuning<T extends { volMultiple: number; tunedVolMultiple?: number }>(env: T, tuning: Tuning | null, bounds: Pick<TuneEnv, "min" | "max">): T {
  if (!tuning || typeof tuning.volMultiple !== "number" || !Number.isFinite(tuning.volMultiple)) return env;
  return { ...env, tunedVolMultiple: Math.min(bounds.max, Math.max(bounds.min, tuning.volMultiple)) };
}

/* ---------- files ---------- */

export const LESSONS_FILE = "lessons.jsonl";
export const TUNING_FILE = "tuning.json";

export function appendLesson(file: string, lesson: Lesson): void {
  fs.appendFileSync(file, JSON.stringify(lesson) + "\n");
}

export function readLessons(file: string, sinceMs = 0): Lesson[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Lesson)
      .filter((l) => l && typeof l.at === "number" && l.at >= sinceMs);
  } catch {
    return [];
  }
}

export function readTuning(file: string): Tuning | null {
  try {
    const t = JSON.parse(fs.readFileSync(file, "utf8")) as Tuning;
    return t && Array.isArray(t.history) ? t : null;
  } catch {
    return null;
  }
}

export function writeTuning(file: string, t: Tuning): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(t, null, 2));
  fs.renameSync(tmp, file);
}

/** The tuning file, re-read at most every 30 s: the policy calls policyEnv() many times a cycle. */
let cache: { file: string; at: number; t: Tuning | null } | null = null;
export function readTuningCached(file: string, now = Date.now()): Tuning | null {
  if (cache && cache.file === file && now - cache.at < 30_000) return cache.t;
  cache = { file, at: now, t: readTuning(file) };
  return cache.t;
}
