/**
 * One process holds the key. Port of Meridian's agent/src/houseWallet.ts (one holder of the
 * wallet, a stuck holder exits the process) and agent/src/liveness.ts (a money loop that stops
 * completing ticks is fatal, because a live process with a dead loop manages nothing).
 *
 *   DATA_DIR/engine.lock  { pid, wallet, startedAt, heartbeat }
 *   acquireLock()   at boot: refuse to start when another live process holds the same wallet
 *   heartbeat()     after every completed iteration
 *   startWatchdog() every 60s: a live wallet whose last completed iteration is older than the
 *                   window exits with code 70; a dry-run desk exits 70 only after two windows of
 *                   AWAKE time with no completed iteration (see watchdogStep)
 *   releaseLock()   on clean exit
 *
 * The window is max(3 x CYCLE_INTERVAL_SEC, 900) seconds. A beat is recorded when an iteration
 * COMPLETES, never when it starts, so a hung iteration starves its own heartbeat.
 *
 * HOST SLEEP IS NOT A HANG. The desk runs on a laptop. Every "[watchdog] stale" line in the paper
 * desk's log up to 2026-09-21 (39 of them, the longest 316 minutes) fell inside a Mac sleep: a
 * low-power sleep on battery on 2026-09-17, a clamshell night on 2026-09-20 with a DarkWake every
 * fifteen minutes. A dry-run rule of "stale for two windows, exit" would have restarted the desk on
 * every wake and every DarkWake. So the dry-run rule counts only the time the host was awake.
 *
 * Node's monotonic clocks do not help on macOS: process.hrtime and performance.now both kept counting
 * through the 2026-09-20 sleep (hrtime since boot matched wall time since boot to the minute on
 * 2026-09-21, Node 24). Sleep is therefore read the other way: this timer fires every minute while
 * the host is awake, so a wall-clock gap between two ticks far longer than a minute is the host
 * asleep (or the process stopped). A sleep starts the count again: the loop gets two whole awake
 * windows after every wake, so a night of DarkWakes a few minutes long can never add up to a restart.
 * The price is that a desk whose host never stays awake for half an hour is never restarted by this
 * rule, which is where it stood before.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataPath } from "../lib/ledger";
import { noteHostSleep } from "../status";

export const LOCK_FILE = "engine.lock";
export const WATCH_MS = 60 * 1000;
export const EXIT_CODE_STALE = 70;
/** a gap between watchdog ticks longer than this is the host asleep, not the loop at work */
export const SLEEP_GAP_MS = 3 * WATCH_MS;

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

/** What the dry-run watchdog remembers between ticks. */
export interface AwakeClock {
  /** wall time of the previous tick */
  lastTickAt: number;
  /** the beat being counted from: the last completed iteration, or the start */
  beatAt: number;
  /** awake time since beatAt, or since the last wake if that is later */
  awakeMs: number;
  /** the sleep run in progress: wall time asleep and how many wakes it took (DarkWakes included) */
  asleepMs: number;
  wakes: number;
}

export type WatchVerdict =
  /** a live wallet: the wall-clock rule in startWatchdog decides, unchanged */
  | { kind: "live" }
  /** this tick followed a sleep: nothing is judged on it */
  | { kind: "asleep" }
  | { kind: "ok" }
  /** stale for a window of awake time: logged */
  | { kind: "stale"; awakeMs: number }
  /** stale for two windows of awake time: exit for a restart */
  | { kind: "exit"; awakeMs: number };

export interface WatchStep {
  clock: AwakeClock;
  verdict: WatchVerdict;
  /** set on the first awake tick after a run of sleeps, to be logged once */
  slept: { ms: number; wakes: number } | null;
}

/**
 * PURE. One watchdog tick. `beatAt` is the last completed iteration (or the start). A gap since the
 * previous tick longer than SLEEP_GAP_MS is the host asleep: nothing is judged on that tick and the
 * count starts again from the wake, as it does on a new beat. On a dry-run desk the loop is hung only once it has been stale for two windows of
 * awake time. A live wallet is never judged here.
 */
export function watchdogStep(prev: AwakeClock | null, i: { now: number; beatAt: number; windowMs: number; live: boolean; sleepGapMs?: number }): WatchStep {
  const sleepGap = i.sleepGapMs ?? SLEEP_GAP_MS;
  if (!prev) {
    return { clock: { lastTickAt: i.now, beatAt: i.beatAt, awakeMs: 0, asleepMs: 0, wakes: 0 }, verdict: i.live ? { kind: "live" } : { kind: "ok" }, slept: null };
  }
  const gap = i.now - prev.lastTickAt;
  const asleep = gap > sleepGap;
  const awakeMs = asleep ? 0 : i.beatAt !== prev.beatAt ? Math.min(Math.max(0, gap), Math.max(0, i.now - i.beatAt)) : prev.awakeMs + Math.max(0, gap);
  if (asleep) {
    const clock = { lastTickAt: i.now, beatAt: i.beatAt, awakeMs, asleepMs: prev.asleepMs + gap, wakes: prev.wakes + 1 };
    return { clock, verdict: i.live ? { kind: "live" } : { kind: "asleep" }, slept: null };
  }
  const slept = prev.wakes > 0 ? { ms: prev.asleepMs, wakes: prev.wakes } : null;
  const clock = { lastTickAt: i.now, beatAt: i.beatAt, awakeMs, asleepMs: 0, wakes: 0 };
  if (i.live) return { clock, verdict: { kind: "live" }, slept };
  if (awakeMs >= 2 * i.windowMs) return { clock, verdict: { kind: "exit", awakeMs }, slept };
  if (awakeMs >= i.windowMs) return { clock, verdict: { kind: "stale", awakeMs }, slept };
  return { clock, verdict: { kind: "ok" }, slept };
}

/**
 * Every minute: with a live wallet, a stale loop exits the process with code 70 so the
 * supervisor restarts it (state is persisted, the guards reconcile from chain on boot).
 * On a dry-run desk (paper holds no funds) the same exit comes after two windows of awake
 * time with no completed iteration, and a host sleep is logged once and forgiven.
 * Returns the timer (unref'd) so the process can still exit cleanly.
 */
export function startWatchdog(opts: { cycleIntervalSec: number; live: boolean; exit?: (code: number) => void }): NodeJS.Timeout {
  const windowMs = staleWindowMs(opts.cycleIntervalSec);
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let clock: AwakeClock | null = null;
  const t = setInterval(() => {
    if (!held) return;
    const now = Date.now();
    if (opts.live) {
      if (!loopStale(held.lock, now, windowMs)) return;
      const age = Math.round((now - (held.lock.lastIterationAt ?? held.lock.startedAt)) / 60000);
      console.error(`[watchdog] UNRECOVERABLE: no completed iteration for ${age}m (window ${Math.round(windowMs / 60000)}m) with a live wallet. Exiting ${EXIT_CODE_STALE} for a clean restart.`);
      releaseLock();
      exit(EXIT_CODE_STALE);
      return;
    }
    const beatAt = held.lock.lastIterationAt ?? held.lock.startedAt;
    const step = watchdogStep(clock, { now, beatAt, windowMs, live: false });
    clock = step.clock;
    if (step.slept) {
      console.log(`[watchdog] host slept ${Math.round(step.slept.ms / 60000)}m${step.slept.wakes > 1 ? ` (${step.slept.wakes} wakes)` : ""}; not a hung loop, the loop resumes`);
      noteHostSleep(step.slept.ms, now);
    }
    const wallMin = Math.round((now - beatAt) / 60000);
    const v = step.verdict;
    if (v.kind === "stale") {
      console.error(`[watchdog] stale: no completed iteration for ${Math.round(v.awakeMs / 60000)}m awake (${wallMin}m wall, window ${Math.round(windowMs / 60000)}m); dry-run, restarting at ${Math.round((2 * windowMs) / 60000)}m awake`);
    } else if (v.kind === "exit") {
      console.error(`[watchdog] hung: no completed iteration for ${Math.round(v.awakeMs / 60000)}m awake (${wallMin}m wall, two windows of ${Math.round(windowMs / 60000)}m). Dry-run holds no funds: exiting ${EXIT_CODE_STALE} for launchd to restart.`);
      releaseLock();
      exit(EXIT_CODE_STALE);
    }
  }, WATCH_MS);
  t.unref?.();
  return t;
}
