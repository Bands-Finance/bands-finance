/**
 * HIS STATE, READABLE. A small in-process registry the desk reports into as it goes, and one reader,
 * snapshot(), that GET /api/status serves (src/server.ts). Nothing here decides anything: it only
 * remembers when things last happened, so a desk with no human watching it can be checked at a glance.
 *
 *   noteIteration(ts)                   a cycle completed (src/index.ts, beside the heartbeat)
 *   noteScreen(ok, ts)                  the screener ran, or failed (src/index.ts ensureScreen)
 *   noteDeploy(ok, ts)                  a snapshot push finished (src/publish/deploy.ts onDone)
 *   noteHostSleep(ms, ts)               the watchdog saw the host sleep (src/engine/watchdog.ts)
 *   noteMarks({ skipped, lastCompleteAt, stale })   the book's marks, each cycle (src/engine/marks.ts noteMarks)
 *   noteAutoApprove({ today, total })   outside proposals approved by desk code, at boot and at each approval
 *                                       (src/platform/autoDecide.ts noteDeskApprovals)
 *
 * The registry lives in the desk's process. A server started on its own (`npm run serve`) sees it
 * empty, so the route falls back to the engine lock for the last iteration.
 *
 * Also here: decisionSources(), the share of the last hour's decisions the model made against the
 * desk policy, read from the END of decisions.jsonl (tens of megabytes; never read whole).
 */
import fs from "node:fs";

export interface StatusSnapshot {
  lastIterationAt: number | null;
  iterations: number;
  screen: { lastAt: number | null; ok: boolean | null; lastOkAt: number | null };
  deploy: { lastAt: number | null; ok: boolean | null };
  marks: { skipped: number; lastCompleteAt: number | null; stale: boolean } | null;
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

/** The marks counter as the loop last noted it: consecutive incomplete cycles, and whether that blocks opens yet. */
export function noteMarks(m: { skipped: number; lastCompleteAt: number | null; stale: boolean }): void {
  state.marks = { skipped: m.skipped, lastCompleteAt: m.lastCompleteAt, stale: m.stale };
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
