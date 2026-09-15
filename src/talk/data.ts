/**
 * What the talking layer reads, from one DATA_DIR, read-only: the tail of decisions.jsonl, the paper
 * book (paper-book.json) and the ledger (ledger.jsonl). Nothing here writes, and nothing here touches
 * the chain. The pure modules (strap.ts, drafts.ts) take what this returns.
 *
 * Positions for the strap:
 *   paper      the paper book's open bands at their last marks (the book is the paper desk's truth);
 *              a band not marked yet, or a book whose last mark is older than 3 cycles, is stale
 *   live       the newest journal entry per pool among the last two cycles, minus the bands that
 *              entry closed; a band that entry opened has no snapshot until the next cycle, so the
 *              strap is unknown for that cycle rather than a count that leaves it out
 */
import fs from "node:fs";
import path from "node:path";
import type { LedgerRow } from "../engine/ledger";
import { isLedgerRow, LEDGER_FILE } from "../engine/ledger";
import type { JournalEntry } from "../journal";
import { loadPaperBook, PAPER_BOOK_FILE, type PaperBook } from "../paper/book";
import { bookEquitySol } from "../paper/mark";
import type { TalkEnv } from "./env";
import { STALE_CYCLES, fmtAge, stackedEventOf, stackFigures, type OpenMarks, type StackFigures, type StrapInput, type StrapPositionInput, type TalkSource } from "./strap";

export const JOURNAL_FILE = "decisions.jsonl";
/** how much of the journal's tail is read (about a week of a six-pool desk) */
export const JOURNAL_TAIL_BYTES = 64 * 1024 * 1024;

export interface JournalTail {
  /** oldest first */
  entries: JournalEntry[];
  /** true when the file is longer than the tail read: entries before `from` exist but were not read */
  truncated: boolean;
  /** epoch ms of the oldest entry read */
  from: number | null;
}

export interface TalkData {
  dataDir: string;
  now: number;
  journal: JournalTail;
  newestEntryAt: number | null;
  book: PaperBook | null;
  rows: LedgerRow[];
  source: TalkSource;
}

export function readJournalTail(file: string, maxBytes = JOURNAL_TAIL_BYTES): JournalTail {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    const entries: JournalEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as JournalEntry;
        if (e && typeof e.ts === "string" && Number.isFinite(Date.parse(e.ts)) && e.pool && Array.isArray(e.positions)) entries.push(e);
      } catch {
        /* a torn write or the partial first line */
      }
    }
    entries.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    return { entries, truncated: start > 0, from: entries.length ? Date.parse(entries[0].ts) : null };
  } catch {
    return { entries: [], truncated: false, from: null };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export function readLedgerFile(file: string): LedgerRow[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows: LedgerRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (isLedgerRow(r)) rows.push(r);
    } catch {
      /* torn line */
    }
  }
  return rows;
}

/**
 * Live only when the newest entry says live. Otherwise a paper book in the directory means paper: paper
 * desks journaled their entries as "dry-run" before the journal learned "paper" (review C19), and calling
 * a dry run "paper" still never presents it as live.
 */
export function sourceOf(journal: JournalTail, book: PaperBook | null): TalkSource {
  const newest = journal.entries[journal.entries.length - 1];
  if (newest?.mode === "live") return "live";
  if (newest?.mode === "paper" || book) return "paper";
  return newest ? "dry-run" : "live";
}

export function loadTalkData(env: Pick<TalkEnv, "dataDir">, now = Date.now(), tailBytes = JOURNAL_TAIL_BYTES): TalkData {
  const journal = readJournalTail(path.join(env.dataDir, JOURNAL_FILE), tailBytes);
  const book = loadPaperBook(path.join(env.dataDir, PAPER_BOOK_FILE));
  const rows = readLedgerFile(path.join(env.dataDir, LEDGER_FILE));
  const newest = journal.entries[journal.entries.length - 1];
  return { dataDir: env.dataDir, now, journal, newestEntryAt: newest ? Date.parse(newest.ts) : null, book, rows, source: sourceOf(journal, book) };
}

const lower = (s: string) => s.toLowerCase();

/** Positions and staleness for strapOf. */
export function strapInputOf(data: TalkData, env: Pick<TalkEnv, "cycleIntervalSec" | "feeMilestoneSol" | "stackedEvents">): StrapInput {
  const staleMs = STALE_CYCLES * env.cycleIntervalSec * 1000;
  const stackedEvent = stackedEventOf(data.rows, data.source, env);
  const base = { stackedEvent, now: data.now, dataAt: data.newestEntryAt };
  if (data.source === "paper") {
    const book = data.book;
    if (!book) return { ...base, positions: [], staleReason: "the journal says paper but there is no paper book to read bands from" };
    const unmarked = book.bands.find((b) => !b.lastMark);
    if (unmarked) return { ...base, positions: [], staleReason: `paper band on ${lower(unmarked.label)} has no mark yet` };
    if (book.bands.length && (book.lastMarkAt === null || data.now - book.lastMarkAt > staleMs)) {
      return { ...base, positions: [], staleReason: `the paper book's last mark is ${book.lastMarkAt === null ? "missing" : `${fmtAge(data.now - book.lastMarkAt)} old`}` };
    }
    const positions: StrapPositionInput[] = book.bands.map((b) => ({ inRange: b.lastMark!.inRange, lowerPrice: b.lowerPrice, upperPrice: b.upperPrice, activePrice: b.lastMark!.price, label: lower(b.label), binsFromRange: b.lastMark!.binsFromRange }));
    return { ...base, positions };
  }
  return { ...base, ...journalPositions(data.journal.entries, data.newestEntryAt, env.cycleIntervalSec) };
}

/** Live and dry-run: the newest entry per pool in the last two cycles, less what that entry closed. */
export function journalPositions(entries: readonly JournalEntry[], newestAt: number | null, cycleIntervalSec: number): { positions: StrapPositionInput[]; staleReason: string | null } {
  if (newestAt === null) return { positions: [], staleReason: null };
  const since = newestAt - 2 * cycleIntervalSec * 1000;
  const newestByPool = new Map<string, JournalEntry>();
  for (const e of entries) {
    const ts = Date.parse(e.ts);
    if (ts < since) continue;
    const prev = newestByPool.get(e.pool.address);
    if (!prev || Date.parse(prev.ts) <= ts) newestByPool.set(e.pool.address, e);
  }
  const positions: StrapPositionInput[] = [];
  let pending = 0;
  for (const e of newestByPool.values()) {
    const closed = e.execution?.ok ? e.execution.closed : undefined;
    if (e.execution?.ok && e.execution.opened) pending += 1;
    for (const pos of e.positions) {
      if (closed && pos.address === closed) continue;
      positions.push({ inRange: pos.inRange, lowerPrice: pos.lowerPrice, upperPrice: pos.upperPrice, activePrice: e.pool.price, label: lower(e.pool.label), binsFromRange: pos.binsFromRange });
    }
  }
  // a band opened this cycle exists but has no snapshot yet: counting the others alone would undercount the book
  if (pending) return { positions, staleReason: `${pending} band(s) opened in the newest cycle and not marked yet` };
  return { positions, staleReason: null };
}

/** The paper book's open marks (unrealized). Live books: unclaimed fees and marks from the journal positions. */
export function openMarksOf(data: TalkData, cycleIntervalSec: number): OpenMarks | null {
  if (data.source === "paper") {
    if (!data.book) return null;
    const eq = bookEquitySol(data.book);
    const marked = data.book.bands.reduce((t, b) => t + ((b.lastMark?.valueInSol ?? b.entryValueSol) - b.entryValueSol), 0);
    return { feesUnclaimedSol: eq.feesUnclaimedSol, markedBandsSol: marked, bands: data.book.bands.length, asOf: data.book.lastMarkAt };
  }
  if (data.newestEntryAt === null) return null;
  const since = data.newestEntryAt - 2 * cycleIntervalSec * 1000;
  const newestByPool = new Map<string, JournalEntry>();
  for (const e of data.journal.entries) if (Date.parse(e.ts) >= since) newestByPool.set(e.pool.address, e);
  let fees = 0;
  let marked = 0;
  let bands = 0;
  for (const e of newestByPool.values()) {
    const q = e.pool.quotePriceInSol && e.pool.quotePriceInSol > 0 ? e.pool.quotePriceInSol : 1;
    const quoteSide = e.pool.quoteSide ?? e.pool.solSide ?? "Y";
    for (const p of e.positions) {
      if (e.execution?.ok && e.execution.closed === p.address) continue;
      bands += 1;
      const feeQuote = quoteSide === "Y" ? p.feeY : p.feeX;
      const feeToken = quoteSide === "Y" ? p.feeX : p.feeY;
      fees += feeQuote * q + feeToken * e.pool.tokenPriceInSol;
      if (typeof p.entryValueSol === "number") marked += p.valueInSol - p.entryValueSol;
    }
  }
  return { feesUnclaimedSol: fees, markedBandsSol: marked, bands, asOf: data.newestEntryAt };
}

export function stackFiguresOf(data: TalkData, windowMs: number, cycleIntervalSec: number): StackFigures {
  return stackFigures({ rows: data.rows, source: data.source, since: data.now - windowMs, until: data.now, open: openMarksOf(data, cycleIntervalSec) });
}
