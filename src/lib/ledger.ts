/**
 * Append-only JSONL ledgers under DATA_DIR. Ported from Meridian's ledger.ts without the
 * Postgres mirror: the file is the source of truth and every read path folds it.
 *
 *   appendLedger("credits.jsonl", row)   the one write path for durable rows
 *   ledgerView("credits.jsonl", fold)    a folded view rebuilt only when the file changes
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { config } from "../config";

export function dataPath(file: string): string {
  return path.resolve(process.cwd(), config.dataDir, file);
}

export function appendLedger(file: string, row: object): void {
  const p = dataPath(file);
  mkdirSync(path.dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(row) + "\n");
}

/** Every parsed row of a ledger, oldest first. Missing file = []. Bad lines are skipped. */
export function readLedger<T = unknown>(file: string): T[] {
  let text: string;
  try {
    text = readFileSync(dataPath(file), "utf8");
  } catch {
    return [];
  }
  const rows: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      /* a torn write; skip the line */
    }
  }
  return rows;
}

/**
 * A folded view invalidated on the file's size+mtime, not on our own writes, because more
 * than one process may append (the loop, the server, a CLI) and a cache that only trusted
 * its own writes would serve a stale view forever.
 */
export function ledgerView<T>(file: string, fold: (rows: unknown[]) => T): { get(): T; reset(): void } {
  let cached: { value: T; size: number; mtimeMs: number } | null = null;
  return {
    get(): T {
      let st: { size: number; mtimeMs: number } | null = null;
      try {
        const s = statSync(dataPath(file));
        st = { size: s.size, mtimeMs: s.mtimeMs };
      } catch {
        st = null;
      }
      if (cached && st && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.value;
      const value = fold(st ? readLedger(file) : []);
      if (st) cached = { value, size: st.size, mtimeMs: st.mtimeMs };
      return value;
    },
    reset(): void {
      cached = null;
    },
  };
}
