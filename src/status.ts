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
 * shape his observation, /api/status, the site and the MCP tool all print (src/learn/surface.ts).
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
  /** count per llm.source ("llm", "policy", "screen", "engine", "proposal", "fallback"); "screen" is a desk-policy hold the model was never asked about */
  bySource: Record<string, number>;
  /** share of the window's decisions, 0..1; null when there were none */
  llmShare: number | null;
  policyShare: number | null;
  /** the share the screen answered without the model (src/agent/decide.ts screenDecision); never counted in llmShare */
  screenShare: number | null;
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
  return { sinceMs, total, bySource, llmShare: share("llm"), policyShare: share("policy"), screenShare: share("screen"), truncated };
}

/* ---------------------------------------------------------------------------------------------
 * WHAT HE LEARNED, READ BACK OFF DISK.
 *
 * The learner (src/learn) decides and journals; nothing is learned here. readLearnedView() reads
 * DATA_DIR/learning.jsonl, the append-only record of every knob move, and DATA_DIR/lessons.jsonl,
 * the per-seat casebook, and renders them as the one LearnedView the four surfaces print
 * (src/learn/surface.ts). Because the journal IS the source, the site, the API, the MCP tool and his
 * own observation cannot disagree with the desk: they are all reading the same rows.
 *
 * Two rules are enforced here rather than trusted:
 *   CROSS-BOOK  a change whose `mode` is not this desk's is refused, so a paper-learned number can
 *               never ride into the live desk unlabelled. Lessons live inside one DATA_DIR, so a
 *               lesson with no mode field (written before the field existed) is taken as the desk's.
 *   NO FACTOR WITHOUT ITS SAMPLE  every factor carries n, minSample and underSample. Under the
 *               sample AND never moved, the shipped default stands and the surface says so. A knob
 *               that HAS moved prints the number in force whatever the sample now reads: the desk is
 *               pricing at it either way, and a page saying "it has not moved" beside the row that
 *               moved it is the one thing the journal exists to prevent (lastMovedAt is the test).
 * Reads are bounded (the tail of each file) and read-only. Nothing here writes.
 * ------------------------------------------------------------------------------------------- */
import { FEE_SHARE_DEFAULT, learnEnv } from "./desk/learning";
import { forecastOf } from "./learn/lessons";
import { freezeState } from "./learn/freeze";
import { NEVER_TOUCHED, emptyLearnedView, type LearnMode, type LearnedChange, type LearnedFactor, type LearnedRatio, type LearnedSeat, type LearnedView } from "./learn/surface";

/**
 * The thresholds the page quotes are the LEARNER'S OWN, read from the same env the desk reads, not a
 * second set typed here: an operator who raises LEARN_CAL_MIN_N must not leave the page saying "0 of
 * the 20 it needs" while the desk is waiting for 30.
 */
/** What ships in code: the flat haircut at src/agent/policy.ts, which learning may lower and never raise. */
export const DEFAULT_CALIBRATION = FEE_SHARE_DEFAULT;
/** A pool with no penalty learned yet trades at its full size. The penalty may only shrink it. */
export const DEFAULT_POOL_PENALTY = 1;
/** The calibration may not move under this many scored seats in the lane (LEARN_CAL_MIN_N). */
export const calibrationMinSample = (env: NodeJS.ProcessEnv = process.env): number => learnEnv(env).calMinN;
/** A pool penalty may not move under this many closed seats in the pool (LEARN_POOL_MIN_N). */
export const poolMinSample = (env: NodeJS.ProcessEnv = process.env): number => learnEnv(env).poolMinN;

/**
 * One row of lessons.jsonl, as the surfaces need it. Fields the learner may not yet write are optional.
 *
 * THE NAMES ARE THE WRITER'S (src/learn/lessons.ts lessonOf): `netSolExDrift` and `quoteDriftSol`.
 * This used to declare `netExDriftSol` and `driftSol`, which nothing writes, so the decomposition was
 * always null and his observation, the site panel and the free bands_lessons tool printed `netSol`
 * alone: the one number every header in the package says must never be read alone. AMD/USDC's stop
 * rendered as "net -6.014 SOL" where the row on disk says quoteDriftSol -6.346 and netSolExDrift
 * +0.332 - the seat was up and the price was above the band. The old spellings are kept as fallbacks
 * for any file that carries them.
 */
interface LessonRow {
  at?: number;
  /** when the seat was opened, as lessonOf writes it; `at` is its close */
  openedAt?: number;
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
  /** the seat's net with the quote token's own move taken out, as lessonOf writes it */
  netSolExDrift?: number | null;
  /** the quote token's move against SOL over the seat's life, as lessonOf writes it */
  quoteDriftSol?: number | null;
  /** the spellings an older file may carry */
  netExDriftSol?: number | null;
  driftSol?: number | null;
  predictedYieldPct?: number | null;
  /** what he forecast AT THE OPEN, the learners' training label */
  entryYieldPct?: number | null;
  realizedYieldPctPerDay?: number | null;
  /** an ask band (src/engine/askExit.ts): inventory being worked off, not a seat the desk chose */
  ask?: boolean;
}

/** PURE. The drift-free net of a row, whichever spelling it carries; null when it carries neither. */
function exDriftOf(r: LessonRow): number | null {
  if (typeof r.netSolExDrift === "number") return r.netSolExDrift;
  if (typeof r.netExDriftSol === "number") return r.netExDriftSol;
  const drift = typeof r.quoteDriftSol === "number" ? r.quoteDriftSol : typeof r.driftSol === "number" ? r.driftSol : null;
  return drift !== null && typeof r.netSol === "number" ? Math.round((r.netSol - drift) * 1e6) / 1e6 : null;
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
 * worse than no switch. src/learn/freeze.ts is the desk's authority and this delegates to it, so the
 * surface and the desk can never disagree about whether he is learning. test-learn-surface asserts
 * the table against this function, which means it asserts the learner's.
 */
export function learnFrozen(env: NodeJS.ProcessEnv = process.env): { all: boolean; calibration: boolean; pools: boolean } {
  return freezeState(env);
}

/** The median of a list, or null when it is empty. */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * How his forecast has come in against what the seats realised. Null until a seat carries both.
 *
 * SCORED THE WAY THE DESK SCORES IT: forecastOf (src/learn/lessons.ts) takes the entry forecast first
 * and the last seat check only as a fallback, which is what calibrationReading counts. Reading
 * predictedYieldPct alone gave this a different, usually smaller sample than the knob it describes, so
 * every surface could say "not enough seats yet, 0 of the 20 it needs, so it has not moved" with the
 * change row that moved it listed two lines below. It also drops the ask bands: an ask band is a
 * closed seat's token being worked off over the price, not a seat the desk chose, and no learner
 * counts one.
 */
export function forecastRatio(rows: LessonRow[]): LearnedRatio | null {
  const ratios: number[] = [];
  let tooHigh = 0;
  for (const r of rows) {
    if (r.ask) continue;
    const f = forecastOf({ entryYieldPct: r.entryYieldPct ?? null, predictedYieldPct: r.predictedYieldPct ?? null });
    const a = r.realizedYieldPctPerDay;
    if (!f) continue;
    if (typeof a !== "number" || !Number.isFinite(a)) continue;
    const ratio = a / f.pct;
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
  netExDriftSol: exDriftOf(r),
  quoteDriftSol: typeof r.quoteDriftSol === "number" ? r.quoteDriftSol : typeof r.driftSol === "number" ? r.driftSol : null,
  // the forecast the desk scores, entry first: what the seat check last said is the fallback, not the label
  predictedYieldPct: forecastOf({ entryYieldPct: r.entryYieldPct ?? null, predictedYieldPct: r.predictedYieldPct ?? null })?.pct ?? null,
  entryYieldPct: r.entryYieldPct ?? null,
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
  const calMin = calibrationMinSample(opts.env ?? process.env);
  const poolMin = poolMinSample(opts.env ?? process.env);
  const view = emptyLearnedView(opts.mode, now);
  view.modelOn = opts.modelOn ?? false;
  view.frozen = learnFrozen(opts.env ?? process.env);

  const rawLessons = readJsonlTail<LessonRow>(path.join(opts.dir, "lessons.jsonl"));
  // lessons live inside one DATA_DIR, so a row with no mode is this desk's: the field is newer than the file.
  // An ask band is a closed seat's token being worked off over the price (src/engine/askExit.ts), not a seat
  // the desk chose: src/learn/view.ts filters them out of every count and so does this, or the same book
  // reads "59 seats" on the site and "55 closed seats on record" in `npm run learning`.
  const lessons = rawLessons.filter((r) => (r.mode === undefined || r.mode === opts.mode) && !r.ask);
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
  // the first seat this casebook rests on, so a surface can date the count (a fresh DATA_DIR starts at 0)
  const opens = lessons.map((r) => r.openedAt ?? r.at).filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  view.since = opens.length ? Math.min(...opens) : null;
  view.changes = changes.slice(0, opts.changes ?? 5);

  // the calibration, per lane: the newest journalled value in force, and the sample it rests on
  const lanes = new Set<string>(["memecoin", "stock"]);
  for (const c of changes) if (c.knob === "calibration" && c.lane) lanes.add(c.lane);
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
      minSample: calMin,
      underSample: n < calMin,
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
    // the desk journals a pool's row under `pool`; `lane` is the older spelling and still read
    const addr = c.pool ?? c.lane;
    if (c.knob !== "pool-penalty" || !addr || seenPools.has(addr)) continue;
    seenPools.add(addr);
    const poolLessons = lessons.filter((r) => r.pool === addr);
    factors.push({
      knob: "pool-penalty",
      lane: addr,
      label: c.label ?? poolLessons[poolLessons.length - 1]?.label ?? addr.slice(0, 6),
      factor: c.to,
      defaultFactor: DEFAULT_POOL_PENALTY,
      n: poolLessons.length,
      minSample: poolMin,
      underSample: poolLessons.length < poolMin,
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
