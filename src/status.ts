/**
 * HIS STATE, READABLE. A small in-process registry the desk reports into as it goes, and one reader,
 * snapshot(), that GET /api/status serves (src/server.ts). Nothing here decides anything: it only
 * remembers when things last happened, so a desk with no human watching it can be checked at a glance.
 *
 *   noteIteration(ts)                   a cycle completed (src/index.ts, beside the heartbeat)
 *   noteScreen(ok, ts)                  the screener ran, or failed (src/index.ts ensureScreen)
 *   noteDeploy(ok, ts)                  a snapshot push finished (src/publish/deploy.ts onDone)
 *   noteHostSleep(ms, ts)               the watchdog saw the host sleep (src/engine/watchdog.ts)
 *   noteMarks({ skipped, lastCompleteAt, stale, setAside })   the book's marks, each cycle (src/engine/marks.ts noteMarks);
 *                                       setAside names a held pool blind so long its bands are written down
 *   noteAutoApprove({ today, total })   outside proposals approved by desk code, at boot and at each approval
 *                                       (src/platform/autoDecide.ts noteDeskApprovals)
 *
 * The registry lives in the desk's process. A server started on its own (`npm run serve`) sees it
 * empty, so the route falls back to the engine lock for the last iteration.
 *
 * Also here: decisionSources(), the share of the last hour's decisions the model made against the
 * desk policy, read from the END of decisions.jsonl (tens of megabytes; never read whole); and
 * readLearnedView(), what the learner journalled in DATA_DIR/learning.jsonl read back as the one
 * shape his observation, /api/status, the site and the MCP tool all print (src/learn/view.ts).
 */
import fs from "node:fs";
import path from "node:path";

export interface StatusSnapshot {
  lastIterationAt: number | null;
  iterations: number;
  screen: { lastAt: number | null; ok: boolean | null; lastOkAt: number | null };
  deploy: { lastAt: number | null; ok: boolean | null };
  marks: { skipped: number; lastCompleteAt: number | null; stale: boolean; setAside?: string[] } | null;
  autoApprove: { today: number; total: number } | null;
  hostSleep: { lastMs: number; at: number } | null;
}

function empty(): StatusSnapshot {
  return {
    lastIterationAt: null,
    iterations: 0,
    screen: { lastAt: null, ok: null, lastOkAt: null },
    deploy: { lastAt: null, ok: null },
    marks: null,
    autoApprove: null,
    hostSleep: null,
  };
}

let state: StatusSnapshot = empty();

export function noteIteration(ts = Date.now()): void {
  state.lastIterationAt = ts;
  state.iterations += 1;
}

export function noteScreen(ok: boolean, ts = Date.now()): void {
  state.screen = { lastAt: ts, ok, lastOkAt: ok ? ts : state.screen.lastOkAt };
}

export function noteDeploy(ok: boolean, ts = Date.now()): void {
  state.deploy = { lastAt: ts, ok };
}

export function noteHostSleep(ms: number, ts = Date.now()): void {
  state.hostSleep = { lastMs: ms, at: ts };
}

/**
 * The marks counter as the loop last noted it: consecutive incomplete cycles, whether that blocks opens yet, and
 * the held pools set aside for staying blind (src/engine/marks.ts), named only when there are any.
 */
export function noteMarks(m: { skipped: number; lastCompleteAt: number | null; stale: boolean; setAside?: string[] }): void {
  state.marks = { skipped: m.skipped, lastCompleteAt: m.lastCompleteAt, stale: m.stale, ...(m.setAside?.length ? { setAside: [...m.setAside] } : {}) };
}

/** The desk's own approvals of outside proposals: this UTC day and all time, counted from the board on disk. */
export function noteAutoApprove(a: { today: number; total: number }): void {
  state.autoApprove = { today: a.today, total: a.total };
}

/** A copy of everything noted so far. */
export function snapshot(): StatusSnapshot {
  return JSON.parse(JSON.stringify(state)) as StatusSnapshot;
}

/** Tests only: forget everything. */
export function resetStatus(): void {
  state = empty();
}

export interface DecisionSources {
  sinceMs: number;
  total: number;
  /** count per llm.source ("llm", "policy", "engine", "proposal", "fallback") */
  bySource: Record<string, number>;
  /** share of the window's decisions, 0..1; null when there were none */
  llmShare: number | null;
  policyShare: number | null;
  /** true when the byte cap stopped the read before it reached the start of the window */
  truncated: boolean;
}

/**
 * Count the llm.source of every journal entry at or after `sinceMs`, walking the file backwards in
 * chunks and stopping at the first entry older than the window. Entries are appended in time order,
 * so the walk reads the last hour and nothing more. `maxBytes` bounds it whatever the file holds.
 */
export function decisionSources(file: string, sinceMs: number, opts: { chunkBytes?: number; maxBytes?: number } = {}): DecisionSources {
  const chunkBytes = opts.chunkBytes ?? 256 * 1024;
  const maxBytes = opts.maxBytes ?? 32 * 1024 * 1024;
  const bySource: Record<string, number> = {};
  let total = 0;
  let truncated = false;
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    let pos = fs.fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    let read = 0;
    let done = false;
    // one line, newest first; false once it is older than the window
    const take = (line: string): boolean => {
      if (!line.trim()) return true;
      let e: { ts?: string; llm?: { source?: string } };
      try {
        e = JSON.parse(line);
      } catch {
        return true; // a torn write: skip it
      }
      const t = e.ts ? Date.parse(e.ts) : NaN;
      if (!Number.isFinite(t)) return true;
      if (t < sinceMs) return false;
      const src = e.llm?.source ?? "unknown";
      bySource[src] = (bySource[src] ?? 0) + 1;
      total++;
      return true;
    };
    while (pos > 0 && !done) {
      if (read >= maxBytes) {
        truncated = true;
        break;
      }
      const len = Math.min(chunkBytes, pos);
      pos -= len;
      read += len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      const joined = Buffer.concat([buf, carry]);
      // everything after the first newline is whole lines; before it may be the tail of an older line
      const nl = pos > 0 ? joined.indexOf(10) : -1;
      const whole = nl >= 0 ? joined.subarray(nl + 1) : pos === 0 ? joined : Buffer.alloc(0);
      carry = nl >= 0 ? joined.subarray(0, nl) : pos === 0 ? Buffer.alloc(0) : joined;
      const lines = whole.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!take(lines[i])) {
          done = true;
          break;
        }
      }
    }
  } catch {
    /* no journal yet: nothing decided */
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  const share = (k: string) => (total > 0 ? (bySource[k] ?? 0) / total : null);
  return { sinceMs, total, bySource, llmShare: share("llm"), policyShare: share("policy"), truncated };
}

/* ---------------------------------------------------------------------------------------------
 * WHAT HE LEARNED, READ BACK OFF DISK.
 *
 * The learner (src/learn) decides and journals; nothing is learned here. readLearnedView() reads
 * DATA_DIR/learning.jsonl, the append-only record of every knob move, and DATA_DIR/lessons.jsonl,
 * the per-seat casebook, and renders them as the one LearnedView the four surfaces print
 * (src/learn/view.ts). Because the journal IS the source, the site, the API, the MCP tool and his
 * own observation cannot disagree with the desk: they are all reading the same rows.
 *
 * Two rules are enforced here rather than trusted:
 *   CROSS-BOOK  a change whose `mode` is not this desk's is refused, so a paper-learned number can
 *               never ride into the live desk unlabelled. Lessons live inside one DATA_DIR, so a
 *               lesson with no mode field (written before the field existed) is taken as the desk's.
 *   NO FACTOR WITHOUT ITS SAMPLE  every factor carries n, minSample and underSample. Under the
 *               sample the shipped default stands and the surface says so.
 * Reads are bounded (the tail of each file) and read-only. Nothing here writes.
 * ------------------------------------------------------------------------------------------- */
import { NEVER_TOUCHED, emptyLearnedView, type LearnMode, type LearnedChange, type LearnedFactor, type LearnedRatio, type LearnedSeat, type LearnedView } from "./learn/view";

/** What ships in code: the flat haircut at src/agent/policy.ts, which learning may lower and never raise. */
export const DEFAULT_CALIBRATION = 0.5;
/** A pool with no penalty learned yet trades at its full size. The penalty may only shrink it. */
export const DEFAULT_POOL_PENALTY = 1;
/** The calibration may not move under this many scored seats in the lane. */
export const CALIBRATION_MIN_SAMPLE = 20;
/** A pool penalty may not move under this many closed seats in the pool. */
export const POOL_MIN_SAMPLE = 3;

/** One row of lessons.jsonl, as the surfaces need it. Fields the learner may not yet write are optional. */
interface LessonRow {
  at?: number;
  mode?: string;
  pool?: string;
  label?: string;
  kind?: string;
  minutes?: number;
  bins?: number;
  coverPct?: number | null;
  inRangePct?: number | null;
  endReason?: string;
  feesSol?: number;
  netSol?: number;
  netExDriftSol?: number | null;
  driftSol?: number | null;
  predictedYieldPct?: number | null;
  realizedYieldPctPerDay?: number | null;
}

/**
 * The last whole lines of a JSONL file, oldest first, reading at most `maxBytes` from the end. A
 * torn first line is dropped. A missing file is no rows, never a throw.
 */
export function readJsonlTail<T>(file: string, maxBytes = 1024 * 1024): T[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(maxBytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    // the read started mid-file: the first line may be the tail of an older one
    if (len < size) lines.shift();
    const rows: T[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as T);
      } catch {
        /* a torn write: skip it */
      }
    }
    return rows;
  } catch {
    return [];
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * The freeze table, read from the environment. Only the literal "true" (trimmed, lower-cased) freezes
 * learning: unset, "1", "yes" and "on" are NOT frozen, because a switch that half-means something is
 * worse than no switch. src/learn/freeze.ts is the desk's authority; this mirrors its table so a
 * surface can say "frozen" without importing the learner, and test-learn-surface asserts the table.
 */
export function learnFrozen(env: NodeJS.ProcessEnv = process.env): { all: boolean; calibration: boolean; pools: boolean } {
  const on = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "true";
  const all = on(env.LEARN_FROZEN);
  return { all, calibration: all || on(env.LEARN_FROZEN_CALIBRATION), pools: all || on(env.LEARN_FROZEN_POOLS) };
}

/** The median of a list, or null when it is empty. */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** How his forecast has come in against what the seats realised. Null until a seat carries both. */
export function forecastRatio(rows: LessonRow[]): LearnedRatio | null {
  const ratios: number[] = [];
  let tooHigh = 0;
  for (const r of rows) {
    const p = r.predictedYieldPct;
    const a = r.realizedYieldPctPerDay;
    if (typeof p !== "number" || !Number.isFinite(p) || p <= 0) continue;
    if (typeof a !== "number" || !Number.isFinite(a)) continue;
    const ratio = a / p;
    ratios.push(ratio);
    if (ratio < 1) tooHigh++;
  }
  const m = median(ratios);
  return m === null ? null : { median: Number(m.toFixed(3)), n: ratios.length, tooHigh };
}

const seatOf = (r: LessonRow): LearnedSeat => ({
  at: r.at ?? 0,
  pool: r.pool ?? "",
  label: r.label ?? "?",
  minutes: r.minutes ?? 0,
  bins: r.bins ?? 0,
  coverPct: r.coverPct ?? null,
  inRangePct: r.inRangePct ?? null,
  endReason: r.endReason ?? "unknown",
  feesSol: r.feesSol ?? 0,
  netSol: r.netSol ?? 0,
  netExDriftSol:
    typeof r.netExDriftSol === "number" ? r.netExDriftSol : typeof r.driftSol === "number" && typeof r.netSol === "number" ? r.netSol - r.driftSol : null,
  predictedYieldPct: r.predictedYieldPct ?? null,
  realizedYieldPctPerDay: r.realizedYieldPctPerDay ?? null,
});

export interface LearnedViewOptions {
  /** where learning.jsonl and lessons.jsonl live; defaults to the desk's DATA_DIR */
  dir: string;
  /** the desk's own book: a change from any other mode is refused */
  mode: LearnMode;
  /** true only once his model is answering; the surfaces say so either way */
  modelOn?: boolean;
  /** build the view for one pool: its last closed seats ride along for his observation */
  pool?: { address: string; label?: string } | null;
  /** how many of that pool's seats to carry (default 5) */
  seats?: number;
  /** how far back a seat may be and still be shown, hours (default 168, a week) */
  seatWindowH?: number;
  /** how many journalled changes to carry (default 5) */
  changes?: number;
  env?: NodeJS.ProcessEnv;
  now?: number;
}

/**
 * The view, read off disk. No RPC, no writes, no decisions: what the learner journalled, plus the
 * counts the journal rests on, in the shape every surface renders.
 */
export function readLearnedView(opts: LearnedViewOptions): LearnedView {
  const now = opts.now ?? Date.now();
  const view = emptyLearnedView(opts.mode, now);
  view.modelOn = opts.modelOn ?? false;
  view.frozen = learnFrozen(opts.env ?? process.env);

  const rawLessons = readJsonlTail<LessonRow>(path.join(opts.dir, "lessons.jsonl"));
  // lessons live inside one DATA_DIR, so a row with no mode is this desk's: the field is newer than the file
  const lessons = rawLessons.filter((r) => r.mode === undefined || r.mode === opts.mode);
  const refusedLessons: Record<string, number> = {};
  for (const r of rawLessons) if (r.mode !== undefined && r.mode !== opts.mode) refusedLessons[r.mode] = (refusedLessons[r.mode] ?? 0) + 1;
  // a change carries the book it was learned on, and a foreign book's number is refused outright
  const rawChanges = readJsonlTail<LearnedChange>(path.join(opts.dir, "learning.jsonl")).filter(
    (c) => c && typeof c.at === "number" && (c.knob === "calibration" || c.knob === "pool-penalty"),
  );
  const changes = rawChanges.filter((c) => c.mode === opts.mode).sort((a, b) => b.at - a.at);
  view.refused = { lessons: refusedLessons, changes: rawChanges.length - changes.length };

  const byEndReason: Record<string, number> = {};
  for (const r of lessons) byEndReason[r.endReason ?? "unknown"] = (byEndReason[r.endReason ?? "unknown"] ?? 0) + 1;
  view.lessons = { total: lessons.length, byEndReason, ratio: forecastRatio(lessons) };
  view.changes = changes.slice(0, opts.changes ?? 5);

  // the calibration, per lane: the newest journalled value in force, and the sample it rests on
  const lanes = new Set<string>(["memecoin", "stock"]);
  for (const c of changes) if (c.knob === "calibration") lanes.add(c.lane);
  const factors: LearnedFactor[] = [];
  for (const lane of lanes) {
    const laneLessons = lessons.filter((r) => (r.kind ?? "memecoin") === lane);
    const ratio = forecastRatio(laneLessons);
    const last = changes.find((c) => c.knob === "calibration" && c.lane === lane) ?? null;
    const n = ratio?.n ?? 0;
    factors.push({
      knob: "calibration",
      lane,
      label: lane,
      factor: last ? last.to : DEFAULT_CALIBRATION,
      defaultFactor: DEFAULT_CALIBRATION,
      n,
      minSample: CALIBRATION_MIN_SAMPLE,
      underSample: n < CALIBRATION_MIN_SAMPLE,
      asOf: laneLessons.length ? Math.max(...laneLessons.map((r) => r.at ?? 0)) : null,
      lastMovedAt: last ? last.at : null,
      why: last ? last.why : null,
      frozen: view.frozen.calibration,
      ratio,
    });
  }

  // a pool penalty exists only where one was journalled: a pool nobody learned about trades at full size
  const seenPools = new Set<string>();
  for (const c of changes) {
    if (c.knob !== "pool-penalty" || seenPools.has(c.lane)) continue;
    seenPools.add(c.lane);
    const poolLessons = lessons.filter((r) => r.pool === c.lane);
    factors.push({
      knob: "pool-penalty",
      lane: c.lane,
      label: c.label ?? poolLessons[poolLessons.length - 1]?.label ?? c.lane.slice(0, 6),
      factor: c.to,
      defaultFactor: DEFAULT_POOL_PENALTY,
      n: poolLessons.length,
      minSample: POOL_MIN_SAMPLE,
      underSample: poolLessons.length < POOL_MIN_SAMPLE,
      asOf: poolLessons.length ? Math.max(...poolLessons.map((r) => r.at ?? 0)) : null,
      lastMovedAt: c.at,
      why: c.why,
      frozen: view.frozen.pools,
      ratio: null,
    });
  }
  view.factors = factors;

  if (opts.pool) {
    const cutoff = now - (opts.seatWindowH ?? 168) * 3_600_000;
    const mine = lessons.filter((r) => r.pool === opts.pool!.address && (r.at ?? 0) >= cutoff).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    view.pool = { address: opts.pool.address, label: opts.pool.label ?? mine[0]?.label ?? opts.pool.address.slice(0, 6) };
    view.seats = mine.slice(0, opts.seats ?? 5).map(seatOf);
  }
  view.neverTouched = NEVER_TOUCHED;
  return view;
}
