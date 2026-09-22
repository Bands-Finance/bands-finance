/**
 * A lock file for the talking layer's read-modify-write sections: the rate file around a post (src/talk/x.ts)
 * and the whole tick (src/talk/tick.ts). Two processes can never both hold it, so two ticks (or a tick and a
 * manual `talk post`) can never read the same rate state and both post.
 *
 * The lock is a file created with O_EXCL ("wx") holding the owner's pid, the time and a random token. A lock
 * whose owner process is gone, or that is older than `staleMs`, is taken over (a crashed tick must not silence
 * him for good); anything else is busy and the caller backs off. Release removes the file only while it still
 * holds this owner's token. No dependency; nothing here touches the network.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_LOCK_STALE_MS = 10 * 60e3;

export interface LockOptions {
  staleMs?: number;
  now?: () => number;
  /** whether a pid is alive (tests) */
  alive?: (pid: number) => boolean;
}

interface LockBody {
  pid: number;
  at: number;
  token: string;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readBody(file: string): LockBody | null {
  try {
    const b = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LockBody>;
    return typeof b.pid === "number" && typeof b.at === "number" && typeof b.token === "string" ? (b as LockBody) : null;
  } catch {
    return null;
  }
}

/** Take the lock, or null when another live owner holds it. The returned function releases it. */
export function acquireLock(file: string, o: LockOptions = {}): (() => void) | null {
  const now = o.now ?? Date.now;
  const staleMs = o.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const alive = o.alive ?? pidAlive;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body: LockBody = { pid: process.pid, at: now(), token: crypto.randomBytes(8).toString("hex") };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      try {
        fs.writeSync(fd, JSON.stringify(body));
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        const held = readBody(file);
        if (held && held.token === body.token) fs.rmSync(file, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const held = readBody(file);
      // a lock with an unreadable body is only taken over once it is old: it may be mid-write
      let mtime = now();
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue; // gone between the open and the stat: try again
      }
      const stale = held ? !alive(held.pid) || now() - held.at > staleMs : now() - mtime > staleMs;
      if (!stale || attempt > 0) return null;
      fs.rmSync(file, { force: true });
    }
  }
  return null;
}

export type Locked<T> = { locked: true; value: T } | { locked: false };

/** Run `fn` holding the lock; `{ locked: false }` without running it when the lock is busy. */
export async function withLock<T>(file: string, fn: () => Promise<T> | T, o: LockOptions = {}): Promise<Locked<T>> {
  const release = acquireLock(file, o);
  if (!release) return { locked: false };
  try {
    return { locked: true, value: await fn() };
  } finally {
    release();
  }
}
