/**
 * ONE VIEW, four surfaces. /api/status, the "what he learned" panel on mrbands.finance, the free
 * bands_lessons MCP tool and `npm run learning` all read LearnedView and nothing else, so they can never
 * disagree with each other or with the files. LearnedView is the only symbol this package shares with
 * the desk branch and the surface branch.
 *
 * It is a READ. It never learns, never writes and never decides: it says what is in force, what bought
 * it, what has not got there yet, and whether learning is frozen. The honest caveats travel with the
 * numbers (`caveats`) so no surface can print a factor without them.
 */
import fs from "node:fs";
import path from "node:path";
import { calEnv, calibrationFrom, forecastRatio, LANES, type ForecastRatio, type Lane, type LaneCalibration } from "./calibration";
import { freezeLine, freezeState, type FreezeState } from "./freeze";
import { LESSONS_FILE, readLessons, type Lesson } from "./lessons";
import { LANES as DESK_LANES, LEARNING_FILE, LEARNING_LOG, calibrationReading, factorFor, learnEnv, readLearning, readLearningChanges, type Lane as DeskLane, type LearningChange } from "../desk/learning";
import { endSideTally, poolMemoryEnv, poolPenalty, type EndSideRow, type PoolPenalty } from "./poolMemory";

/** One closed seat as the casebook shows it: the facts, never the money on its own. */
export interface SeatCard {
  at: number;
  label: string;
  pool: string;
  kind: string;
  minutes: number;
  bins: number;
  coverPct: number;
  inRangePct: number | null;
  endReason: string;
  feesSol: number;
  /** the money with the quote token's drift against SOL taken out */
  netSolExDrift: number;
  /** what he forecast at the open, percent a day, and what the seat actually paid */
  entryYieldPct: number | null;
  realizedYieldPctPerDay: number;
  backfilled: boolean;
}

export interface LearnedLane {
  lane: DeskLane;
  /** the factor in force on the desk right now, read off DATA_DIR/learning.json */
  inForce: number;
  /**
   * What the desk's own learner (src/desk/learning.ts) will step toward, and the ONLY target any
   * surface prints: the decayed median of realised over forecast. Null while its sample is short,
   * when the shipped default stands.
   */
  target: number | null;
  /** how many scoreable seats bought that target */
  n: number;
  /** the desk learner's sentence, printed verbatim */
  why: string;
  windowH: number;
  /**
   * THE SECOND OPINION, evidence only: the in-range half of the same question, which the backfilled
   * paper seats can answer even though they carry no forecast. Nothing on the desk moves on it, and a
   * surface that prints it says so.
   */
  evidence: { inRangeFactor: number; paceFactor: number; paceSource: "seed" | "live"; combined: number; n: number; weak: boolean; asOf: number | null; why: string } | null;
  lastChange: LearningChange | null;
}

export interface LearnedView {
  mode: string;
  /** the shipped haircut, which is also the ceiling: no learner may ever price a seat above it */
  base: number;
  frozen: FreezeState;
  frozenLine: string;
  lanes: LearnedLane[];
  /** every change, newest first, at most 5 */
  changes: LearningChange[];
  /** the book-wide realised-over-forecast line, recomputed from the lessons every time */
  ratio: ForecastRatio;
  /** where seats ended and what each side did */
  endSides: EndSideRow[];
  lessonsTotal: number;
  /** end reasons by count, for the page's table */
  byEndReason: Record<string, number>;
  /** the pool asked for, when one was */
  pool: { penalty: PoolPenalty; seats: SeatCard[] } | null;
  /** the lines no surface may drop */
  caveats: string[];
  asOf: number;
}

const cardOf = (l: Lesson): SeatCard => ({
  at: l.at,
  label: l.label,
  pool: l.pool,
  kind: l.kind,
  minutes: l.minutes,
  bins: l.bins,
  coverPct: Math.round(l.coverPct * 100) / 100,
  inRangePct: l.inRangePct,
  endReason: l.endReason,
  feesSol: l.feesSol,
  netSolExDrift: typeof l.netSolExDrift === "number" ? l.netSolExDrift : l.netSol,
  entryYieldPct: l.entryYieldPct ?? l.predictedYieldPct ?? null,
  realizedYieldPctPerDay: l.realizedYieldPctPerDay,
  backfilled: l.backfilled === true,
});

/** The three lines every surface prints beside the numbers. Never dropped, never softened. */
export function caveatsFor(mode: string, llmShare: number): string[] {
  return [
    llmShare > 0
      ? `${Math.round(llmShare)}% of his calls came from his model; these knobs are his rulebook's either way.`
      : "His model is not switched on yet: every proposal on this desk comes from his rulebook, and these knobs are the rulebook's, not the model's.",
    mode === "live" ? "Real money." : `This is the ${mode} book. The fees on it are modelled by the same formula as the forecast, so only the in-range half of the calibration is learned here; the pace half is the 17-19 Sep real-money figure, frozen while the book is paper.`,
    "Learning may never raise or loosen a limit. MAX_POSITION_SOL, the exposure caps, the stop-loss, the daily caps, the kill switch, the breakers and H1 are human-set, and no learner writes them.",
  ];
}

/** The files, re-read at most every 30 s: a page and an API route both ask on every request. */
interface Cached {
  key: string;
  at: number;
  lessons: Lesson[];
  changes: LearningChange[];
  inForce: Record<string, number>;
}
let cache: Cached | null = null;

function load(dataDir: string, mode: string, now: number): Cached {
  const key = `${dataDir}|${mode}`;
  if (cache && cache.key === key && now - cache.at < 30_000) return cache;
  const lessons = readLessons(path.join(dataDir, LESSONS_FILE));
  const changes = readLearningChanges(path.join(dataDir, LEARNING_LOG));
  // the desk is the only writer of learning.json, so the desk's own reader is what says what is in force
  const state = readLearning(path.join(dataDir, LEARNING_FILE), mode);
  const inForce: Record<string, number> = {};
  for (const lane of DESK_LANES) inForce[lane] = factorFor(state, lane);
  cache = { key, at: now, lessons, changes, inForce };
  return cache;
}

/** For the tests and for a script that has just written a file: the next read hits the disk. */
export const clearLearnedCache = (): void => {
  cache = null;
};

export function learnedView(dataDir: string, mode: string, pool?: string, env: NodeJS.ProcessEnv = process.env, now = Date.now(), llmShare = 0): LearnedView {
  const { lessons, changes, inForce } = load(path.resolve(dataDir), mode, now);
  const ce = calEnv(env);
  const cal = calibrationFrom(lessons, ce, now, mode);
  // the whole view is an AS-OF read: nothing that closed after `now` votes anywhere in it
  const mine = lessons.filter((l) => (l.mode ?? "live") === mode && !l.ask && l.at <= now);
  const le = learnEnv(env);
  const lanes: LearnedLane[] = DESK_LANES.map((lane) => {
    const reading = calibrationReading(mine, lane, mode, le, now);
    const c: LaneCalibration | undefined = (cal as Partial<Record<string, LaneCalibration>>)[lane];
    const last = [...changes].filter((x) => x.knob === "calibration" && x.lane === lane && x.mode === mode && x.at <= now).sort((a, b) => b.at - a.at)[0] ?? null;
    return {
      lane,
      inForce: inForce[lane] ?? ce.base,
      target: reading.target,
      n: reading.n,
      why: reading.why,
      windowH: reading.windowH,
      evidence: c ? { inRangeFactor: c.inRangeFactor, paceFactor: c.paceFactor, paceSource: c.paceSource, combined: c.combined, n: c.n, weak: c.weak, asOf: c.asOf, why: c.why } : null,
      lastChange: last,
    };
  });
  const byEndReason: Record<string, number> = {};
  for (const l of mine) byEndReason[l.endReason] = (byEndReason[l.endReason] ?? 0) + 1;
  const poolView = pool
    ? {
        penalty: poolPenalty(lessons, pool, mode, now, poolMemoryEnv(env)),
        seats: mine
          .filter((l) => l.pool === pool)
          .sort((a, b) => b.at - a.at)
          .slice(0, 5)
          .map(cardOf),
      }
    : null;
  return {
    mode,
    base: ce.base,
    frozen: freezeState(env),
    frozenLine: freezeLine(freezeState(env)),
    lanes,
    changes: [...changes].filter((c) => c.mode === mode && c.at <= now).sort((a, b) => b.at - a.at).slice(0, 5),
    ratio: forecastRatio(mine, ce.minSample, mode),
    endSides: endSideTally(mine),
    lessonsTotal: mine.length,
    byEndReason,
    pool: poolView,
    caveats: caveatsFor(mode, llmShare),
    asOf: now,
  };
}

/** The view as lines, for `npm run learning` and for anyone checking the page against the files. */
export function learnedLines(v: LearnedView): string[] {
  const out: string[] = [];
  out.push(`${v.mode} book, ${v.lessonsTotal} closed seats on record. ${v.frozenLine}.`);
  out.push(v.ratio.line);
  for (const l of v.lanes) {
    out.push(`  ${l.lane.padEnd(9)} factor in force ${l.inForce.toFixed(2)}${l.target === null ? " (the shipped default)" : ""}, the desk is stepping toward ${l.target === null ? "nothing yet" : l.target.toFixed(2)}, n=${l.n}${l.target === null ? " WEAK" : ""}`);
    out.push(`             ${l.why}`);
    const e = l.evidence;
    if (e) out.push(`             second opinion, not acted on: in range ${e.inRangeFactor.toFixed(2)} x pace ${e.paceFactor.toFixed(2)}${e.paceSource === "seed" ? ", seed" : ""} = ${e.combined.toFixed(2)}, n=${e.n}${e.weak ? " WEAK" : ""}`);
  }
  for (const s of v.endSides) out.push(`  ended ${s.side.padEnd(6)} n=${String(s.n).padStart(3)}  net ${s.net >= 0 ? "+" : ""}${s.net.toFixed(3)} SOL ex-drift, ${s.winners} winner${s.winners === 1 ? "" : "s"}, fees ${s.feesSol.toFixed(3)} SOL`);
  if (v.changes.length === 0) out.push("  no change has been made yet: every one of them would appear here with its evidence");
  for (const c of v.changes) out.push(`  ${new Date(c.at).toISOString().slice(0, 16)}Z ${c.knob}${c.lane ? ` ${c.lane}` : ""}${c.pool ? ` ${c.pool.slice(0, 6)}` : ""} ${c.from} -> ${c.to}: ${c.why}`);
  if (v.pool) {
    out.push(`  ${v.pool.penalty.pool.slice(0, 6)}: ${v.pool.penalty.sizeMultiple} of the seat, ${v.pool.penalty.sitOutMin} min extra sit-out. ${v.pool.penalty.why}`);
    for (const s of v.pool.seats) out.push(`    ${s.label.padEnd(12)} ${s.minutes} min, ${s.bins} bins, in range ${s.inRangePct === null ? "n/a" : `${s.inRangePct}%`}, ended ${s.endReason}, fees ${s.feesSol.toFixed(4)} SOL, net ex-drift ${s.netSolExDrift >= 0 ? "+" : ""}${s.netSolExDrift.toFixed(4)} SOL`);
  }
  for (const c of v.caveats) out.push(`  - ${c}`);
  return out;
}

/** True when the data dir has a lessons file at all: a surface says "nothing yet" rather than guessing. */
export const hasLessons = (dataDir: string): boolean => fs.existsSync(path.join(path.resolve(dataDir), LESSONS_FILE));
