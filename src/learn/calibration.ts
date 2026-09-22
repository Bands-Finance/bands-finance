/**
 * THE FORECAST CALIBRATION: the first knob that learns from what actually happened, and the one the
 * evidence asks for. Over the 17-19 Sep real-money run the desk's own seat forecast came in at a median
 * 0.39 of what the seats realised, too high on 48 of 52 priced seats. Band width, the knob the first
 * tuner reaches for, separates nothing in either book. The level does.
 *
 * WHAT IT MOVES. One number: the in-range haircut in seatEarnings (src/agent/policy.ts, the literal 0.5
 * "halved because a band earns only while price is inside it"). Split in two so each half means
 * something and can be checked on its own:
 *   inRangeFactor - of a seat's life, the share the price spent inside the band. Measured.
 *   paceFactor    - of the fees the screen says the pool pays, the share a seat captured WHILE in range.
 * Their product is what the haircut should have been. It is hard-clamped to [0.1, 0.5]: never above the
 * 0.5 the code already uses, so a calibrated desk refuses MORE seats than today and never fewer. It
 * cannot open a seat the shipped code would refuse, and it touches no limit, stop, cap or breaker.
 *
 * WHY THE FACTOR IN FORCE IS PART OF THE ARITHMETIC. A ratio of realised to forecast only says what the
 * right factor is once it is read against the factor that MADE the forecast: read raw it oscillates,
 * 0.5 -> 0.39 -> 0.5 for ever. So the pace half carries entryYieldFactor (the haircut in force at the
 * open, the shipped 0.5 when a lesson predates the stamp), and the loop converges instead of ringing.
 *
 * PAPER FEES ARE MODELLED. A paper seat's fees come out of the same formula as the forecast
 * (src/paper/mark.ts accrueFees: pool pace x share x 0.5), so a paper pace factor would score the screen
 * against itself and always read 1.0. On a paper desk the pace half is therefore the SEED measured on
 * the real-money run and never moves; only the in-range half learns, because where the price went is a
 * fact the paper book did not invent.
 *
 * Everything here is pure. Nothing in this file reads or writes a file, and nothing imports the engine.
 */
import { forecastOf, type LearningChange, type Lesson } from "./lessons";

export type Lane = "memecoin" | "stock";
export const LANES: readonly Lane[] = ["memecoin", "stock"];

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

export interface CalEnv {
  /** how fast old seats stop voting (LEARN_CAL_HALFLIFE_H, hours) */
  halflifeMs: number;
  /** the most the factor may move in one change (LEARN_CAL_STEP) */
  step: number;
  /** closed seats in the lane and mode before anything moves (LEARN_CAL_MIN_SAMPLE) */
  minSample: number;
  /** the least time between two changes of the same knob (LEARN_MIN_GAP_MIN) */
  minGapMs: number;
  /** the pace a paper desk uses, from the real-money run (LEARN_PACE_SEED) */
  paceSeed: number;
  /** the haircut the shipped code uses, and the ceiling (LEARN_CAL_BASE) */
  base: number;
  /** the product's bounds (LEARN_CAL_MIN / LEARN_CAL_MAX) */
  min: number;
  max: number;
}

/**
 * LEARN_PACE_SEED's default: the median of (realised / forecast) x 0.5 / (in-range share) over the 39
 * priced, observed seats of the 17-19 Sep real-money run. It is a memecoin figure, it is frozen while
 * the book is paper, and docs/learning.md says both out loud.
 */
export const PACE_SEED_1719_SEP = 0.33;

export function calEnv(env: NodeJS.ProcessEnv = process.env): CalEnv {
  return {
    halflifeMs: Math.max(1, num(env.LEARN_CAL_HALFLIFE_H, 168)) * 3_600_000,
    step: clamp(num(env.LEARN_CAL_STEP, 0.05), 0.01, 0.1),
    minSample: Math.max(5, Math.floor(num(env.LEARN_CAL_MIN_SAMPLE, 20))),
    minGapMs: Math.max(0, num(env.LEARN_MIN_GAP_MIN, 360)) * 60_000,
    paceSeed: clamp(num(env.LEARN_PACE_SEED, PACE_SEED_1719_SEP), 0.2, 1),
    base: clamp(num(env.LEARN_CAL_BASE, 0.5), 0.1, 0.5),
    min: clamp(num(env.LEARN_CAL_MIN, 0.1), 0.05, 0.5),
    max: clamp(num(env.LEARN_CAL_MAX, 0.5), 0.1, 0.5),
  };
}

/** A desk whose fees are real money, and therefore whose pace is evidence. */
export const isLiveBook = (mode: string): boolean => mode === "live";

/** PURE. A lesson this lane may learn its in-range share from. */
export const usableForInRange = (l: Lesson, lane: Lane, mode: string): boolean =>
  l.kind === lane && !l.ask && (l.mode ?? "live") === mode && typeof l.inRangePct === "number" && l.inRangePct !== null;

/** PURE. A lesson this lane may learn its pace from: a live book's, priced at the open, and observed in range. */
export const usableForPace = (l: Lesson, lane: Lane): boolean =>
  l.kind === lane && !l.ask && isLiveBook(l.mode ?? "live") && forecastOf(l) !== null && typeof l.inRangePct === "number" && (l.inRangePct ?? 0) > 0;

/** PURE. Exponentially weighted mean with a half-life: an old seat stops voting on its own. */
export function ewma(samples: readonly { at: number; v: number }[], now: number, halflifeMs: number): number | null {
  let w = 0;
  let sum = 0;
  for (const s of samples) {
    const age = Math.max(0, now - s.at);
    const weight = Math.pow(0.5, age / halflifeMs);
    w += weight;
    sum += weight * s.v;
  }
  return w > 0 ? sum / w : null;
}

export interface LaneCalibration {
  lane: Lane;
  /** of a seat's life, the share the price spent in the band: clamped [0.25, 1] */
  inRangeFactor: number;
  /** of the pool's pace, the share a seat captured while in range: clamped [0.2, 1] */
  paceFactor: number;
  /** their product, clamped [LEARN_CAL_MIN, LEARN_CAL_MAX]: what the haircut should be */
  combined: number;
  /** closed seats behind the in-range half */
  n: number;
  /** closed seats behind the pace half; 0 when it is the seed */
  paceN: number;
  paceSource: "seed" | "live";
  /** true when n is under LEARN_CAL_MIN_SAMPLE: the shipped default stands and the page says so */
  weak: boolean;
  /** the newest seat that voted; null when none did */
  asOf: number | null;
  windowH: number;
  /** the evidence sentence, printed verbatim by the page, the API and `npm run learning` */
  why: string;
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

/**
 * PURE. What each lane's haircut should be, from the lessons. Never a side effect and never a file: the
 * caller decides whether it may act on this (the freeze switch, the step and the gap all sit in
 * calibrationStep).
 */
export function calibrationFrom(lessons: readonly Lesson[], env: CalEnv, now: number, mode: string): Record<Lane, LaneCalibration> {
  const out = {} as Record<Lane, LaneCalibration>;
  const windowH = Math.round(env.halflifeMs / 3_600_000);
  // a seat that closed after the moment being read has not happened yet: an as-of read must not see it
  const upTo = lessons.filter((l) => l.at <= now);
  for (const lane of LANES) {
    const forInRange = upTo.filter((l) => usableForInRange(l, lane, mode));
    const inRaw = ewma(forInRange.map((l) => ({ at: l.at, v: (l.inRangePct as number) / 100 })), now, env.halflifeMs);
    const inRangeFactor = clamp(inRaw ?? 1, 0.25, 1);
    const live = isLiveBook(mode);
    const forPace = live ? upTo.filter((l) => usableForPace(l, lane)) : [];
    // the pace a seat captured, read against the haircut that made its forecast: realised / (forecast /
    // factor) / in-range share. Without the factor the loop rings between 0.5 and 0.39 for ever.
    const paceRaw = live
      ? ewma(
          forPace.map((l) => {
            const f = forecastOf(l)!;
            const factor = typeof l.entryYieldFactor === "number" && l.entryYieldFactor > 0 ? l.entryYieldFactor : env.base;
            return { at: l.at, v: (l.realizedYieldPctPerDay / f.pct) * factor / ((l.inRangePct as number) / 100) };
          }),
          now,
          env.halflifeMs,
        )
      : null;
    const paceFactor = clamp(paceRaw ?? env.paceSeed, 0.2, 1);
    const combined = clamp(inRangeFactor * paceFactor, env.min, env.max);
    const n = forInRange.length;
    const weak = n < env.minSample;
    const asOf = forInRange.length ? Math.max(...forInRange.map((l) => l.at)) : null;
    const paceSource: "seed" | "live" = paceRaw === null ? "seed" : "live";
    const why = weak
      ? `${n} closed ${lane} seat${n === 1 ? "" : "s"} on the ${mode} book, under the ${env.minSample} a change needs: the shipped ${env.base} stands`
      : `${n} closed ${lane} seats on the ${mode} book sat in range ${pct(inRangeFactor)} of their lives and captured ${pct(paceFactor)} of the pool's pace while they were${paceSource === "seed" ? " (the 17-19 Sep real-money figure, frozen while the book is paper)" : ` (${forPace.length} priced live seats)`}: a seat is worth ${r2(combined)} of the pool's day, not ${env.base}. ${windowH}h half-life`;
    out[lane] = { lane, inRangeFactor: r3(inRangeFactor), paceFactor: r3(paceFactor), combined: r2(combined), n, paceN: forPace.length, paceSource, weak, asOf, windowH, why };
  }
  return out;
}

export interface CalibrationStepInput {
  /** the factor in force now (the shipped base until one has been learned) */
  current: number;
  cal: LaneCalibration;
  env: CalEnv;
  /** the last change of THIS knob in THIS lane, from the journal */
  last: LearningChange | null;
  now: number;
  mode: string;
}

/** What the step decided: a change to journal, or the sentence saying why it held. */
export interface CalibrationDecision {
  change: LearningChange | null;
  held: string | null;
}

/**
 * PURE. The one bounded step the lane's evidence buys, if any. One step per cycle, never inside the gap,
 * never under the sample, never outside [min, max] and therefore never above the shipped 0.5.
 */
export function calibrationStep(i: CalibrationStepInput): CalibrationDecision {
  const { cal, env, now } = i;
  const current = clamp(i.current, env.min, env.max);
  if (cal.weak) return { change: null, held: `${cal.lane}: ${cal.n} closed seats, under the ${env.minSample} a change needs` };
  if (i.last && now - i.last.at < env.minGapMs) {
    const mins = Math.round((env.minGapMs - (now - i.last.at)) / 60_000);
    return { change: null, held: `${cal.lane}: last moved ${Math.round((now - i.last.at) / 60_000)} min ago, ${mins} min of the ${Math.round(env.minGapMs / 60_000)} min gap left` };
  }
  const target = clamp(cal.combined, env.min, env.max);
  const gap = target - current;
  if (Math.abs(gap) < env.step / 2) return { change: null, held: `${cal.lane}: the factor in force (${r2(current)}) is already what the seats argue for (${r2(target)})` };
  const to = r2(clamp(current + Math.sign(gap) * Math.min(env.step, Math.abs(gap)), env.min, env.max));
  if (to === r2(current)) return { change: null, held: `${cal.lane}: already at the ${gap > 0 ? "ceiling" : "floor"}` };
  return {
    change: { at: now, mode: i.mode, knob: "calibration", lane: cal.lane, from: r2(current), to, why: `${cal.why}. ${gap < 0 ? "Marking the forecast down" : "Letting it back up"} one step, ${r2(current)} -> ${to}`, n: cal.n, windowH: cal.windowH },
    held: null,
  };
}

/*
 * There was an applyCalibration() here that put the learned haircut on a policy env field called
 * `yieldFactor`. The desk has no such field: policyEnv() in src/agent/policy.ts carries the haircut
 * as feeShare[lane] and puts it there itself, from the journalled state. A helper that looks as if it
 * applies a learned number but is wired to nothing is worse than no helper, so it is gone, and
 * policyEnv is the one place a learned factor reaches a decision.
 */

/* ---------- the ratio he updates, rather than a sentence in a doc ---------- */

export interface ForecastRatio {
  n: number;
  /** the middle seat's realised over forecast; null when nothing was priced */
  median: number | null;
  /** the same weighted by the fees each seat actually claimed: the big seats' verdict */
  feeWeighted: number | null;
  /** seats whose forecast was too high */
  tooHigh: number;
  /** of n, how many were scored against the open's own forecast rather than the last seat check's */
  fromEntry: number;
  /** true under LEARN_CAL_MIN_SAMPLE: the page prints it with the count and the word */
  weak: boolean;
  line: string;
}

/**
 * PURE. How the forecast did against the book, the number docs/sprint.md states as prose and nothing
 * recomputes. Seats only: an ask band is an exit, not a seat the desk chose.
 */
export function forecastRatio(lessons: readonly Lesson[], minSample = 20, label = ""): ForecastRatio {
  const scored = lessons
    .filter((l) => !l.ask)
    .map((l) => ({ l, f: forecastOf(l) }))
    .filter((x): x is { l: Lesson; f: { pct: number; source: "entry" | "seat-check" } } => x.f !== null)
    .map((x) => ({ ratio: x.l.realizedYieldPctPerDay / x.f.pct, fees: Math.max(0, x.l.feesSol), source: x.f.source }));
  const n = scored.length;
  const weak = n < minSample;
  if (n === 0) return { n: 0, median: null, feeWeighted: null, tooHigh: 0, fromEntry: 0, weak: true, line: `${label ? `${label}: ` : ""}no priced seat has closed yet` };
  const sorted = [...scored].sort((a, b) => a.ratio - b.ratio).map((x) => x.ratio);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const feeSum = scored.reduce((t, x) => t + x.fees, 0);
  const feeWeighted = feeSum > 0 ? scored.reduce((t, x) => t + x.ratio * x.fees, 0) / feeSum : null;
  const tooHigh = scored.filter((x) => x.ratio < 1).length;
  const fromEntry = scored.filter((x) => x.source === "entry").length;
  const line = `${label ? `${label}: ` : ""}${n} priced seats came in at a median ${r3(median)} of the forecast${feeWeighted !== null ? `, ${r3(feeWeighted)} weighted by the fees they claimed` : ""}; ${tooHigh} of ${n} were forecast too high${weak ? ` (WEAK: under ${minSample} seats)` : ""}`;
  return { n, median: r3(median), feeWeighted: feeWeighted === null ? null : r3(feeWeighted), tooHigh, fromEntry, weak, line };
}
