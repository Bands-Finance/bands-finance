/**
 * One process holds the key. Port of Meridian's agent/src/houseWallet.ts (one holder of the
 * wallet, a stuck holder exits the process) and agent/src/liveness.ts (a money loop that stops
 * completing ticks is fatal, because a live process with a dead loop manages nothing).
 *
 *   DATA_DIR/engine.lock  { pid, wallet, startedAt, heartbeat }
 *   acquireLock()   at boot: refuse to start when another live process holds the same wallet
 *   heartbeat()     after every completed iteration
 *   startWatchdog() every 60s: a live wallet whose last completed iteration is older than the
 *                   window exits with code 70; in dry-run it only logs
 *   releaseLock()   on clean exit
 *
 * The window is max(3 x CYCLE_INTERVAL_SEC, 900) seconds. A beat is recorded when an iteration
 * COMPLETES, never when it starts, so a hung iteration starves its own heartbeat.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataPath } from "../lib/ledger";

export const LOCK_FILE = "engine.lock";
export const WATCH_MS = 60 * 1000;
export const EXIT_CODE_STALE = 70;

export interface EngineLock {
  pid: number;
  wallet: string;
  startedAt: number;
  heartbeat: number;
  /** epoch ms of the last COMPLETED iteration; null before the first */
  lastIterationAt: number | null;
}

/** The staleness window: several cycles, floored so a slow cycle is not judged alone. */
export function staleWindowMs(cycleIntervalSec: number): number {
  return Math.max(3 * cycleIntervalSec, 900) * 1000;
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** PURE: does an existing lock still hold the key for this wallet? */
export function lockBlocks(existing: EngineLock | null, wallet: string, now: number, windowMs: number, selfPid: number, alive: (pid: number) => boolean): boolean {
  if (!existing) return false;
  if (existing.pid === selfPid) return false;
  if (existing.wallet !== wallet) return false;
  if (now - existing.heartbeat >= windowMs) return false;
  return alive(existing.pid);
}

/** PURE: is the loop stale at `now`? Judged from the last completed iteration, or the start. */
export function loopStale(lock: Pick<EngineLock, "startedAt" | "lastIterationAt">, now: number, windowMs: number): boolean {
  return now - (lock.lastIterationAt ?? lock.startedAt) > windowMs;
}

export function readLock(file = dataPath(LOCK_FILE)): EngineLock | null {
  try {
    if (!existsSync(file)) return null;
    const l = JSON.parse(readFileSync(file, "utf8")) as Partial<EngineLock>;
    if (typeof l.pid !== "number" || typeof l.wallet !== "string" || typeof l.heartbeat !== "number") return null;
    return { pid: l.pid, wallet: l.wallet, startedAt: l.startedAt ?? l.heartbeat, heartbeat: l.heartbeat, lastIterationAt: l.lastIterationAt ?? null };
  } catch {
    return null;
  }
}

function writeLock(lock: EngineLock, file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(lock, null, 2));
}

let held: { lock: EngineLock; file: string } | null = null;

/** Take the lock or throw with a clear message. */
export function acquireLock(wallet: string, cycleIntervalSec: number, file = dataPath(LOCK_FILE), now = Date.now()): EngineLock {
  const existing = readLock(file);
  const windowMs = staleWindowMs(cycleIntervalSec);
  if (lockBlocks(existing, wallet, now, windowMs, process.pid, pidAlive)) {
    const age = Math.round((now - existing!.heartbeat) / 1000);
    throw new Error(
      `another process (pid ${existing!.pid}) holds the key for wallet ${wallet} (heartbeat ${age}s ago, window ${Math.round(windowMs / 1000)}s). ` +
        `One process holds the key. Stop it first, or remove ${file} if it is dead.`,
    );
  }
  const lock: EngineLock = { pid: process.pid, wallet, startedAt: now, heartbeat: now, lastIterationAt: null };
  writeLock(lock, file);
  held = { lock, file };
  return lock;
}

/** Stamp a completed iteration. */
export function heartbeat(now = Date.now()): void {
  if (!held) return;
  held.lock.heartbeat = now;
  held.lock.lastIterationAt = now;
  try {
    writeLock(held.lock, held.file);
  } catch (err) {
    console.error(`[watchdog] heartbeat write failed: ${(err as Error).message.slice(0, 120)}`);
  }
}

export function releaseLock(): void {
  if (!held) return;
  try {
    const onDisk = readLock(held.file);
    if (onDisk && onDisk.pid === process.pid) unlinkSync(held.file);
  } catch {
    /* nothing to release */
  }
  held = null;
}

export function currentLock(): EngineLock | null {
  return held ? { ...held.lock } : null;
}

/**
 * Every minute: with a live wallet, a stale loop exits the process with code 70 so the
 * supervisor restarts it (state is persisted, the guards reconcile from chain on boot);
 * in dry-run it only logs. Returns the timer (unref'd) so the process can still exit cleanly.
 */
export function startWatchdog(opts: { cycleIntervalSec: number; live: boolean; exit?: (code: number) => void }): NodeJS.Timeout {
  const windowMs = staleWindowMs(opts.cycleIntervalSec);
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const t = setInterval(() => {
    if (!held) return;
    const now = Date.now();
    if (!loopStale(held.lock, now, windowMs)) return;
    const age = Math.round((now - (held.lock.lastIterationAt ?? held.lock.startedAt)) / 60000);
    if (opts.live) {
      console.error(`[watchdog] UNRECOVERABLE: no completed iteration for ${age}m (window ${Math.round(windowMs / 60000)}m) with a live wallet. Exiting ${EXIT_CODE_STALE} for a clean restart.`);
      releaseLock();
      exit(EXIT_CODE_STALE);
      return;
    }
    console.error(`[watchdog] stale: no completed iteration for ${age}m (window ${Math.round(windowMs / 60000)}m); dry-run, so only logging`);
  }, WATCH_MS);
  t.unref?.();
  return t;
}
