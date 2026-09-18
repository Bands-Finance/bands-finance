/**
 * Files of the hot watch, under the data directory:
 *   hot.json           the latest tick (HotFile), rewritten whole every tick
 *   hot-history.jsonl  one compact row per pool per tick, rolled down to its last half past
 *                      HOT_TAPE_MAX_BYTES (32 MB) so a six-hour window cannot cost gigabytes a year
 * Only the tail of the tape is ever read back (the trailing surge window), so the roll can never take
 * anything a reader asks for. Also: which pools the journal says we hold.
 */
import fs from "node:fs";
import path from "node:path";
import type { HotFile, HotHistoryRow } from "./types";

export const HOT_FILE = (dir: string) => path.resolve(process.cwd(), dir, "hot.json");
export const HISTORY_FILE = (dir: string) => path.resolve(process.cwd(), dir, "hot-history.jsonl");

let cached: { file: string; mtimeMs: number; size: number; hot: HotFile | null } | null = null;

/**
 * The latest tick, re-read only when hot.json changed on disk (its mtime and size): a caller that
 * asks several times per pool per tick gets the same parse back, so the file is read ONCE per tick.
 */
export function loadHotFileCached(dir: string = process.env.DATA_DIR?.trim() || "data"): HotFile | null {
  const file = HOT_FILE(dir);
  let mtimeMs: number;
  let size: number;
  try {
    const st = fs.statSync(file);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {
    cached = null;
    return null;
  }
  if (cached && cached.file === file && cached.mtimeMs === mtimeMs && cached.size === size) return cached.hot;
  const hot = loadHotFile(dir);
  cached = { file, mtimeMs, size, hot };
  return hot;
}

export function loadHotFile(dir: string): HotFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(HOT_FILE(dir), "utf8")) as HotFile;
    return raw && Array.isArray(raw.rows) ? raw : null;
  } catch {
    return null;
  }
}

/** Written whole, temp + rename: a reader (the loop, the site) never sees a torn tick. */
export function saveHotFile(dir: string, file: HotFile): void {
  const target = HOT_FILE(dir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file));
  fs.renameSync(tmp, target);
}

/**
 * The tape is telemetry, and only its tail is ever read (readHistoryTail's trailing bytes, over the
 * surge window). Left alone it grew 10 MB a day (2026-09-18: 13 MB in a day and a half, on its way to
 * 3.7 GB a year) for the sake of a six-hour window. Past HOT_TAPE_MAX_BYTES it is rolled down to its
 * last half, on a line boundary, so what any reader can ask for is always still there.
 */
export const TAPE_MAX_BYTES = (): number => {
  const raw = Number(process.env.HOT_TAPE_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 32 * 1024 * 1024;
};

/**
 * PURE. The tail to keep of a tape that has grown past the cap: the last `keep` bytes from the first
 * line boundary inside them, so no half-row survives. Null when it is short enough to leave alone.
 */
export function rolledTape(text: string, maxBytes: number): string | null {
  if (Buffer.byteLength(text) <= maxBytes) return null;
  const keep = Math.max(1, Math.floor(maxBytes / 2));
  const buf = Buffer.from(text);
  const tail = buf.subarray(Math.max(0, buf.length - keep)).toString("utf8");
  const nl = tail.indexOf("\n");
  return nl >= 0 ? tail.slice(nl + 1) : "";
}

export function appendHistory(dir: string, rows: HotHistoryRow[]): void {
  if (!rows.length) return;
  const file = HISTORY_FILE(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // roll the tape when it outgrows the cap; a failure here must never cost the tick its append
  try {
    const max = TAPE_MAX_BYTES();
    if (fs.statSync(file).size <= max) return;
    const rolled = rolledTape(fs.readFileSync(file, "utf8"), max);
    if (rolled === null) return;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, rolled);
    fs.renameSync(tmp, file);
  } catch {
    /* the tape keeps growing rather than the tick failing: the housekeeping job is the backstop */
  }
}

/** Parse tape text (possibly starting mid-line) into rows at or after sinceMs. Bad lines are skipped. */
export function parseHistory(text: string, sinceMs: number): HotHistoryRow[] {
  const out: HotHistoryRow[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const r = JSON.parse(line) as HotHistoryRow;
      if (typeof r.ts === "number" && typeof r.address === "string" && r.ts >= sinceMs) out.push(r);
    } catch {
      // a partial first line from the tail read, or a torn write: skip it
    }
  }
  return out;
}

/** Rows since sinceMs from the last maxBytes of the tape (6h of 60 rows every 2 minutes is ~2.5MB). */
export function readHistoryTail(dir: string, sinceMs: number, maxBytes = 8 * 1024 * 1024): HotHistoryRow[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(HISTORY_FILE(dir), "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return parseHistory(text, sinceMs);
  } catch {
    return [];
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Pools the journal says we hold: the newest entry per pool decides, and it counts when that entry
 * carries at least one position. Entries newest first, as src/journal's readRecent returns them.
 */
export function heldPools(entries: Array<{ pool: { address: string }; positions: unknown[] }>): string[] {
  const seen = new Set<string>();
  const held: string[] = [];
  for (const e of entries) {
    const addr = e?.pool?.address;
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    if (Array.isArray(e.positions) && e.positions.length > 0) held.push(addr);
  }
  return held;
}
