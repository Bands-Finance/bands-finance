/**
 * Files of the hot watch, under the data directory:
 *   hot.json           the latest tick (HotFile), rewritten whole every tick
 *   hot-history.jsonl  one compact row per pool per tick, append-only, never trimmed
 * Only the tail of the tape is ever read back (the trailing surge window), so the file may grow
 * for months without slowing a tick. Also: which pools the journal says we hold.
 */
import fs from "node:fs";
import path from "node:path";
import type { HotFile, HotHistoryRow } from "./types";

export const HOT_FILE = (dir: string) => path.resolve(process.cwd(), dir, "hot.json");
export const HISTORY_FILE = (dir: string) => path.resolve(process.cwd(), dir, "hot-history.jsonl");

export function loadHotFile(dir: string): HotFile | null {
  try {
    const raw = JSON.parse(fs.readFileSync(HOT_FILE(dir), "utf8")) as HotFile;
    return raw && Array.isArray(raw.rows) ? raw : null;
  } catch {
    return null;
  }
}

export function saveHotFile(dir: string, file: HotFile): void {
  fs.mkdirSync(path.dirname(HOT_FILE(dir)), { recursive: true });
  fs.writeFileSync(HOT_FILE(dir), JSON.stringify(file));
}

export function appendHistory(dir: string, rows: HotHistoryRow[]): void {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(HISTORY_FILE(dir)), { recursive: true });
  fs.appendFileSync(HISTORY_FILE(dir), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
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
