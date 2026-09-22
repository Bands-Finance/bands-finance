/**
 * WHAT HE LEARNS, and the only two knobs it may move. Zach (2026-09-22): "lets be sure our agent is
 * actually self learning."
 *
 * The doctrine: the LLM proposes, the guards decide, and a learner may only tune HOW he trades
 * inside ranges a human fixed in code. Both knobs here are MULTIPLIERS <= 1 applied through a path
 * that already exists and already only tightens:
 *
 *   1. THE CALIBRATION, per lane. Today the desk prices a seat at half the pool's face fee pace
 *      (src/agent/policy.ts, the literal 0.5: "a band earns only while price is inside it"). The
 *      live book says that is still too generous: over the 17-19 Sep real-money run a seat came in
 *      at a median 0.40 of what was forecast for it, too high 48 times out of 52. So the 0.5
 *      becomes a learned share of face, hard-clamped to [0.1, 0.5]. It can never be raised above
 *      the 0.5 the code already uses, so a calibrated desk always refuses MORE seats, never fewer.
 *   2. THE POOL PENALTY, per pool. A pool whose recent seats ended by going THROUGH the band, or on
 *      the stop, gets a smaller seat and a longer sit-out. Clamped to [0.25, 1.0]: it can never
 *      enlarge a seat and it can never bench a pool. Benching is the engine's job, not a learner's.
 *
 * What it may NEVER touch, and nothing here can reach: MAX_POSITION_SOL, MAX_TOTAL_EXPOSURE_SOL,
 * the stop-loss, the daily caps, the kill switch, the circuit and portfolio breakers, H1. Those stay
 * exactly where a human set them. Nothing in this file imports src/engine/breakers.ts or writes the
 * engine's state, and the penalty is a multiplier the guards see, not a guard.
 *
 * The shapes the doctrine asks for, all in the pure functions below:
 *   MINIMUM SAMPLE  the calibration needs LEARN_CAL_MIN_N lessons in the lane, the penalty needs
 *                   LEARN_POOL_MIN_N closed seats in the pool. Under it the shipped default stands
 *                   and the public surface says so with the count.
 *   BOUNDED STEP    one step per knob per cycle (calibration LEARN_CAL_STEP, penalty one rung), and
 *                   LEARN_MIN_GAP_H between two changes of the same knob.
 *   DECAY           the calibration is a weighted median over LEARN_CAL_WINDOW_H with a 7-day
 *                   half-life; the penalty reads a LEARN_POOL_WINDOW_H window. Old evidence stops
 *                   voting on its own.
 *   JOURNAL         every change is one row in DATA_DIR/learning.jsonl with the evidence sentence
 *                   the site and the API print verbatim. Nothing changes without a row.
 *   FREEZE          learningFrozen(): LEARN_FROZEN is frozen on the literal "true" and nothing else.
 *                   A frozen desk still writes lessons and still logs what it WOULD have changed.
 *   MODE            every state file carries the desk's mode and a reader refuses another desk's
 *                   file, so a paper-learned number can never ride into the live desk unlabelled.
 *   LABEL HYGIENE   no learner reads netSol. -8.479 SOL of SOL/USD drift sits inside the USDC-quoted
 *                   paper seats, and a seat can be stopped on drift while the price sits above the
 *                   band. The learners key on the END SIDE and on the yield ratio only.
 *
 * PACKAGE NOTE (learn-desk, 2026-09-22): this file is the desk's own copy of the learn-core
 * contract, written here because learn-core had not landed when the wiring was built. When
 * src/learn/ ships its calibration, freeze and view modules, delete this file and re-point the four
 * imports in src/index.ts and src/agent/policy.ts at them: the signatures below are the agreed ones.
 */
import fs from "node:fs";
import { calibrationFrozen, poolsFrozen } from "../learn/freeze";

export type Lane = "memecoin" | "stock" | "other";
export const LANES: readonly Lane[] = ["memecoin", "stock", "other"];

/** The shipped share of face a seat is priced at, and the hard ceiling on anything learned. */
export const FEE_SHARE_DEFAULT = 0.5;

export const LEARNING_FILE = "learning.json";
export const LEARNING_LOG = "learning.jsonl";

/** The rungs the pool penalty moves between, best first. One rung per change. */
export const PENALTY_RUNGS: readonly number[] = [1, 0.75, 0.5, 0.25];

/* ---------- env ---------- */

export interface LearnEnv {
  /** how far back the calibration reads lessons (LEARN_CAL_WINDOW_H). 168h, not 24h: the paper book closes about 11 seats a day and at most 4 of them memecoin, so a 24h window is unfillable by arithmetic. */
  calWindowH: number;
  /** lessons in the lane before the calibration may move (LEARN_CAL_MIN_N) */
  calMinN: number;
  /** one step, in share of face (LEARN_CAL_STEP) */
  calStep: number;
  /** the hard clamp on the product. calMax is never above FEE_SHARE_DEFAULT: learning may not price a seat above what the code already does. */
  calMin: number;
  calMax: number;
  /** the half-life of the evidence, hours (LEARN_CAL_HALF_LIFE_H) */
  calHalfLifeH: number;
  /** the pool penalty's window (LEARN_POOL_WINDOW_H) */
  poolWindowH: number;
  /** closed seats in the pool before its penalty may move (LEARN_POOL_MIN_N) */
  poolMinN: number;
  /** the share of a pool's recent seats that must have ended through the band or on the stop for the penalty to step down (LEARN_POOL_BAD_SHARE) */
  poolBadShare: number;
  /** the longest sit-out a penalty may ask for, as a multiple of the configured re-entry minimum (LEARN_SITOUT_MAX_MULTIPLE) */
  sitOutMaxMultiple: number;
  /** the least time between two changes of the same knob (LEARN_MIN_GAP_H) */
  minGapMs: number;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function learnEnv(env: NodeJS.ProcessEnv = process.env): LearnEnv {
  return {
    calWindowH: Math.max(1, num(env.LEARN_CAL_WINDOW_H, 168)),
    calMinN: Math.max(1, Math.floor(num(env.LEARN_CAL_MIN_N, 20))),
    calStep: Math.min(0.25, Math.max(0.01, num(env.LEARN_CAL_STEP, 0.05))),
    // the floor is settable; the ceiling is not allowed past the shipped 0.5, whatever the env says
    calMin: Math.min(FEE_SHARE_DEFAULT, Math.max(0.01, num(env.LEARN_CAL_MIN, 0.1))),
    calMax: Math.min(FEE_SHARE_DEFAULT, Math.max(0.02, num(env.LEARN_CAL_MAX, FEE_SHARE_DEFAULT))),
    calHalfLifeH: Math.max(1, num(env.LEARN_CAL_HALF_LIFE_H, 168)),
    poolWindowH: Math.max(1, num(env.LEARN_POOL_WINDOW_H, 48)),
    poolMinN: Math.max(1, Math.floor(num(env.LEARN_POOL_MIN_N, 3))),
    poolBadShare: Math.min(1, Math.max(0.01, num(env.LEARN_POOL_BAD_SHARE, 0.5))),
    sitOutMaxMultiple: Math.min(12, Math.max(1, num(env.LEARN_SITOUT_MAX_MULTIPLE, 4))),
    minGapMs: Math.max(0, num(env.LEARN_MIN_GAP_H, 6)) * 3_600_000,
  };
}

/**
 * The freeze switch is spelled exactly once, in src/learn/freeze.ts: frozen only on the literal
 * "true", trimmed and lower-cased, so "TRUE" freezes and "1", "yes" and "on" do not. The desk, the
 * API, the site and the MCP tool all read that one table, which is why they can never disagree about
 * whether he is learning. This re-exports it rather than restating it.
 */
export { learningFrozen } from "../learn/freeze";

export type Knob = "calibration" | "pools";

/** PURE. The per-knob freeze, on top of the desk-wide one, by the same literal-"true" rule. */
export function knobFrozen(env: NodeJS.ProcessEnv, knob: Knob): boolean {
  return knob === "calibration" ? calibrationFrozen(env) : poolsFrozen(env);
}

/* ---------- state ---------- */

export interface LearnedCalibration {
  lane: Lane;
  /** the share of the pool's face fee pace a seat is priced at */
  factor: number;
  n: number;
  at: number;
  why: string;
}

export interface LearnedPool {
  pool: string;
  label: string;
  /** <= 1 always: the seat multiplier this pool's recent seats argue for */
  penalty: number;
  /** the least this pool sits out after it is given up, minutes */
  sitOutMin: number;
  n: number;
  at: number;
  why: string;
}

export interface LearningState {
  /** the desk that learned it. A reader refuses a file whose mode is not its own. */
  mode: string;
  calibration: Partial<Record<Lane, LearnedCalibration>>;
  pools: Record<string, LearnedPool>;
  updatedAt: number;
}

export interface LearningChange {
  at: number;
  mode: string;
  knob: "calibration" | "pool-penalty";
  lane?: Lane;
  pool?: string;
  label?: string;
  from: number;
  to: number;
  /** the evidence sentence, printed verbatim by the API, the site and `npm run learning` */
  why: string;
  n: number;
  windowH: number;
}

export const emptyLearning = (mode: string, now = Date.now()): LearningState => ({ mode, calibration: {}, pools: {}, updatedAt: now });

/** PURE. The share of face in force for a lane: what was learned, else the shipped default. */
export const factorFor = (state: LearningState | null, lane: Lane, fallback = FEE_SHARE_DEFAULT): number => {
  const c = state?.calibration?.[lane];
  return c && Number.isFinite(c.factor) ? c.factor : fallback;
};

/** PURE. A pool's seat multiplier: <= 1 always, 1 when nothing was learned about it. */
export const penaltyFor = (state: LearningState | null, pool: string): number => {
  const p = state?.pools?.[pool];
  return p && Number.isFinite(p.penalty) ? Math.min(1, Math.max(PENALTY_RUNGS[PENALTY_RUNGS.length - 1], p.penalty)) : 1;
};

/** PURE. A pool's learned sit-out in minutes, 0 when nothing was learned about it. */
export const sitOutMinFor = (state: LearningState | null, pool: string): number => {
  const p = state?.pools?.[pool];
  return p && Number.isFinite(p.sitOutMin) ? Math.max(0, p.sitOutMin) : 0;
};

/* ---------- the evidence ---------- */

/** What a learner reads off a lesson. Never netSol: the drift sits inside it. */
export interface LessonLike {
  at: number;
  mode?: string;
  kind: string;
  pool: string;
  label: string;
  endReason: string;
  minutes: number;
  realizedYieldPctPerDay: number;
  predictedYieldPct: number | null;
  /** what the desk forecast AT THE OPEN, when it recorded one (src/index.ts) */
  entryYieldPct?: number | null;
  /** the share of face that forecast already carried; absent means the seat check's, which takes face whole */
  entryYieldFactor?: number | null;
  ask?: boolean;
}

const laneOfKind = (kind: string): Lane => (kind === "stock" ? "stock" : kind === "other" ? "other" : "memecoin");

/** PURE. The forecast a lesson is scored against, and the share of face it already carried. */
export function forecastOf(l: LessonLike): { forecast: number; factor: number } | null {
  const entry = typeof l.entryYieldPct === "number" && l.entryYieldPct > 0 ? l.entryYieldPct : null;
  if (entry !== null) return { forecast: entry, factor: typeof l.entryYieldFactor === "number" && l.entryYieldFactor > 0 ? l.entryYieldFactor : FEE_SHARE_DEFAULT };
  // the seat check's reading (src/screener/seatYield.ts) takes the pool's fee pace whole: factor 1
  const seen = typeof l.predictedYieldPct === "number" && l.predictedYieldPct > 0 ? l.predictedYieldPct : null;
  return seen === null ? null : { forecast: seen, factor: 1 };
}

/** PURE. The weighted median of value/weight pairs: half the weight below it, half above. */
export function weightedMedian(rows: readonly { v: number; w: number }[]): number | null {
  const ok = rows.filter((r) => Number.isFinite(r.v) && r.w > 0).sort((a, b) => a.v - b.v);
  if (!ok.length) return null;
  const total = ok.reduce((t, r) => t + r.w, 0);
  let seen = 0;
  for (const r of ok) {
    seen += r.w;
    if (seen >= total / 2) return r.v;
  }
  return ok[ok.length - 1].v;
}

export interface CalibrationReading {
  lane: Lane;
  /** the share of face the evidence argues for, already clamped; null when the sample is short */
  target: number | null;
  n: number;
  /** the decayed median of realised over forecast, before the clamp; null when the sample is short */
  ratio: number | null;
  windowH: number;
  /** the sentence the surfaces print */
  why: string;
}

/**
 * PURE. What the lane's recent lessons say a seat is worth, as a share of the pool's face fee pace.
 * Each lesson contributes realised/forecast times the share of face that forecast already carried,
 * weighted by a 7-day half-life, and the weighted MEDIAN decides: one seat that made 3.4x its
 * forecast must not buy back a whole lane's haircut. The result is clamped to [calMin, calMax], and
 * calMax is never above the shipped 0.5.
 */
export function calibrationReading(lessons: readonly LessonLike[], lane: Lane, mode: string, env: LearnEnv, now: number): CalibrationReading {
  const since = now - env.calWindowH * 3_600_000;
  const rows: { v: number; w: number }[] = [];
  for (const l of lessons) {
    if (l.ask) continue;
    if ((l.mode ?? "live") !== mode) continue;
    if (laneOfKind(l.kind) !== lane) continue;
    if (!(l.at >= since && l.at <= now)) continue;
    const f = forecastOf(l);
    if (!f) continue;
    if (!Number.isFinite(l.realizedYieldPctPerDay) || l.realizedYieldPctPerDay < 0) continue;
    const ageH = Math.max(0, (now - l.at) / 3_600_000);
    rows.push({ v: (l.realizedYieldPctPerDay / f.forecast) * f.factor, w: Math.pow(0.5, ageH / env.calHalfLifeH) });
  }
  const n = rows.length;
  if (n < env.calMinN) {
    return { lane, target: null, n, ratio: null, windowH: env.calWindowH, why: `${n} of the ${env.calMinN} ${lane} seats the calibration wants have closed with a forecast to score in the last ${env.calWindowH}h, so the shipped ${FEE_SHARE_DEFAULT} of face stands` };
  }
  const ratio = weightedMedian(rows);
  if (ratio === null) return { lane, target: null, n, ratio: null, windowH: env.calWindowH, why: `no ${lane} seat in the last ${env.calWindowH}h carries a forecast to score, so the shipped ${FEE_SHARE_DEFAULT} of face stands` };
  const target = Math.min(env.calMax, Math.max(env.calMin, Math.round(ratio * 100) / 100));
  return {
    lane,
    target,
    n,
    ratio,
    windowH: env.calWindowH,
    why: `my last ${n} ${lane} seats came in at ${ratio.toFixed(2)} of what I forecast for them (${env.calWindowH}h, oldest evidence halved every ${Math.round(env.calHalfLifeH / 24)} days), so I price the screen's fee pace at ${target.toFixed(2)} of face`,
  };
}

/** PURE. One bounded step from `from` toward `to`, never past it, rounded to the step's precision. */
export function stepToward(from: number, to: number, step: number): number {
  if (Math.abs(to - from) <= step) return Math.round(to * 1000) / 1000;
  return Math.round((from + Math.sign(to - from) * step) * 1000) / 1000;
}

/**
 * PURE. The one calibration change this lane argues for, or null: one step, never inside the gap,
 * never outside the clamp. A short sample changes nothing.
 */
export function calibrationChange(reading: CalibrationReading, state: LearningState, env: LearnEnv, now: number, mode: string): LearningChange | null {
  if (reading.target === null) return null;
  const cur = state.calibration[reading.lane];
  const from = cur ? cur.factor : FEE_SHARE_DEFAULT;
  if (cur && now - cur.at < env.minGapMs) return null;
  const to = stepToward(from, reading.target, env.calStep);
  if (to === from) return null;
  const clamped = Math.min(env.calMax, Math.max(env.calMin, to));
  if (clamped === from) return null;
  return { at: now, mode, knob: "calibration", lane: reading.lane, from, to: clamped, why: reading.why, n: reading.n, windowH: reading.windowH };
}

/** PURE. One rung down (worse) or up (back toward 1), never past the ends. */
export function stepRung(from: number, down: boolean): number {
  const i = PENALTY_RUNGS.findIndex((r) => Math.abs(r - from) < 1e-9);
  const at = i === -1 ? 0 : i;
  const next = Math.min(PENALTY_RUNGS.length - 1, Math.max(0, at + (down ? 1 : -1)));
  return PENALTY_RUNGS[next];
}

/** A seat that ended on the DOWN side: through the bottom of the band, or on the stop. */
export const endedBadly = (endReason: string): boolean => endReason === "through-band" || endReason === "stop";

/**
 * PURE. The pool penalties the recent lessons argue for: at most one rung per pool per cycle, never
 * inside the gap, always inside [0.25, 1]. Down when more than `poolBadShare` of the pool's recent
 * closed seats went through the band or hit the stop; back up one rung when none of them did. The
 * sit-out follows the rung and is capped at `sitOutMaxMultiple` times the configured re-entry
 * minimum, so a learner can stretch a wait but never turn it into a bench.
 */
export function poolPenaltyChanges(lessons: readonly LessonLike[], mode: string, state: LearningState, env: LearnEnv, now: number, reentryMin: number): LearningChange[] {
  const since = now - env.poolWindowH * 3_600_000;
  const byPool = new Map<string, LessonLike[]>();
  for (const l of lessons) {
    if (l.ask) continue;
    if ((l.mode ?? "live") !== mode) continue;
    if (!(l.at >= since && l.at <= now)) continue;
    if (!l.pool) continue;
    (byPool.get(l.pool) ?? byPool.set(l.pool, []).get(l.pool)!).push(l);
  }
  const out: LearningChange[] = [];
  for (const [pool, rows] of byPool) {
    if (rows.length < env.poolMinN) continue;
    const cur = state.pools[pool];
    if (cur && now - cur.at < env.minGapMs) continue;
    const from = cur ? cur.penalty : 1;
    const bad = rows.filter((r) => endedBadly(r.endReason));
    const down = bad.length > env.poolBadShare * rows.length;
    if (!down && bad.length > 0) continue; // mixed: nothing argued either way
    if (!down && from >= 1) continue; // already whole
    const to = stepRung(from, down);
    if (to === from) continue;
    const label = rows[rows.length - 1].label;
    out.push({
      at: now,
      mode,
      knob: "pool-penalty",
      pool,
      label,
      from,
      to,
      n: rows.length,
      windowH: env.poolWindowH,
      why: down
        ? `${bad.length} of my last ${rows.length} seats in ${label} ended on the down side (${bad.map((b) => `${b.endReason} after ${Math.round(b.minutes)} min`).join(", ")}), so I take a smaller seat there and wait longer before going back`
        : `my last ${rows.length} seats in ${label} all ended without going through the band or hitting the stop, so I give the pool back a rung of its size`,
    });
  }
  return out;
}

/** PURE. The state with one change applied. The penalty's sit-out follows its rung. */
export function applyChange(state: LearningState, c: LearningChange, env: LearnEnv, reentryMin: number): LearningState {
  if (c.knob === "calibration" && c.lane) {
    return { ...state, calibration: { ...state.calibration, [c.lane]: { lane: c.lane, factor: c.to, n: c.n, at: c.at, why: c.why } }, updatedAt: c.at };
  }
  if (c.knob === "pool-penalty" && c.pool) {
    const rung = PENALTY_RUNGS.findIndex((r) => Math.abs(r - c.to) < 1e-9);
    const multiple = Math.min(env.sitOutMaxMultiple, 1 + Math.max(0, rung));
    return { ...state, pools: { ...state.pools, [c.pool]: { pool: c.pool, label: c.label ?? c.pool, penalty: c.to, sitOutMin: Math.round(Math.max(0, reentryMin) * multiple), n: c.n, at: c.at, why: c.why } }, updatedAt: c.at };
  }
  return state;
}

/* ---------- files ---------- */

/**
 * The learning state, or null. A file whose mode is not this desk's is REFUSED with a line: today
 * ops/live.env points the halted live desk at a shared tuning path, and a paper-learned number must
 * never ride into a live desk unlabelled.
 */
export function readLearning(file: string, mode: string, onRefusal?: (why: string) => void): LearningState | null {
  let raw: LearningState;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as LearningState;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  if (raw.mode !== mode) {
    onRefusal?.(`${file} was learned on a ${raw.mode ?? "nameless"} desk and this desk is ${mode}: refused, the shipped defaults stand`);
    return null;
  }
  return { mode: raw.mode, calibration: raw.calibration ?? {}, pools: raw.pools ?? {}, updatedAt: raw.updatedAt ?? 0 };
}

export function writeLearning(file: string, state: LearningState): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export function appendLearningChange(file: string, c: LearningChange): void {
  fs.appendFileSync(file, JSON.stringify(c) + "\n");
}

/**
 * The journal back. A torn line is SKIPPED, not fatal: an append cut off by a restart must never cost
 * him the rest of his public record, and this is the only reader the surfaces have. `sinceMs` narrows
 * it to the changes after a moment, for an as-of read.
 */
export function readLearningChanges(file: string, sinceMs = 0): LearningChange[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as LearningChange;
        } catch {
          return null;
        }
      })
      .filter((c): c is LearningChange => !!c && typeof c.at === "number" && c.at >= sinceMs);
  } catch {
    return [];
  }
}

/** The state file, re-read at most every 30 s: the policy asks for the factor many times a cycle. */
let cache: { file: string; mode: string; at: number; s: LearningState | null } | null = null;
export function readLearningCached(file: string, mode: string, now = Date.now()): LearningState | null {
  if (cache && cache.file === file && cache.mode === mode && now - cache.at < 30_000) return cache.s;
  cache = { file, mode, at: now, s: readLearning(file, mode) };
  return cache.s;
}
/** Tests and the one-shot runner read a fresh file. */
export const clearLearningCache = (): void => {
  cache = null;
};

/* ---------- where the files live ---------- */

/**
 * PURE. The learning files for a desk. Learning is ON BY DEFAULT and the paths default to the
 * desk's own DATA_DIR, deliberately: the width tuner sat dark for a week because TUNING_FILE was
 * unset in the service and nothing said so. The honest off switch is LEARN_FROZEN=true, which is
 * loud, per-knob and printed in the boot banner; an unset variable is not an off switch.
 * LEARN_FILE overrides the state path for a rehearsal or a scratch run.
 */
export function learnFiles(dataDir: string, mode: string, env: NodeJS.ProcessEnv = process.env): { state: string; log: string; mode: string } {
  const override = (env.LEARN_FILE ?? "").trim();
  const dir = dataDir.replace(/\/+$/, "");
  return { state: override || `${dir}/${LEARNING_FILE}`, log: `${dir}/${LEARNING_LOG}`, mode };
}
