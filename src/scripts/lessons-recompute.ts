/**
 * TWO JOBS ON THE CASEBOOK, both read-only unless you pass --write.
 *
 * 1. RECOMPUTE (the default). Re-derive every lesson's net from the ledger with today's accounting
 *    (src/learn/lessons.ts seatNetSol).
 *      DATA_DIR=data-mainnet npm run lessons:recompute             shows before and after, writes nothing
 *      DATA_DIR=data-mainnet npm run lessons:recompute -- --write  backs the file up beside itself, then rewrites it
 *    Only netSol, tokensLeftSol and the drift decomposition change: the seat's facts (bins, minutes,
 *    in-range share, why it ended) were observed when it closed and the ledger cannot give them back. A
 *    lesson whose rows are no longer in the ledger is left as it was.
 *
 * 2. BACKFILL (--backfill). Write the lessons that were never written. The lesson writer landed on
 *    2026-09-18; the paper book had already closed 88 bands and only 21 of them have a lesson. The 67
 *    missing ones are not a rounding error in the corpus: they contain every seat that was priced out
 *    and every seat the stop took, which is precisely what the learners need and what the kept 21 have
 *    none of.
 *      DATA_DIR=data-live npm run lessons:recompute -- --backfill            shows what it would write
 *      DATA_DIR=data-live npm run lessons:recompute -- --backfill --write    backs up, then writes
 *    Reconstructed, never invented, and each source named:
 *      the band            DATA_DIR/paper-book.json closed[]: bins, hold, fees, why it ended
 *      the money           DATA_DIR/ledger.jsonl through seatNetSol, the same arithmetic as a live close
 *      the in-range share  DATA_DIR/decisions.jsonl: one journal row per pool per cycle carries that
 *                          cycle's positions with inRange on them, which is exactly what the desk counts
 *      the bin step        the journal's pool block, else the book's made pairs, else today's screen
 *    What cannot be reconstructed is left null and says so: travelBins60m (the scout's reading at the
 *    open) and entryYieldPct (the desk did not keep the open's forecast until this sprint). Every row is
 *    stamped backfilled: true so no surface can pass it off as a live observation. It never overwrites a
 *    row that exists, so running it twice writes nothing the second time.
 */
import { createReadStream } from "node:fs";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { coveragePct } from "../agent/policy";
import { readLedgerRows, type LedgerRow } from "../engine/ledger";
import { endReasonOf, LESSONS_FILE, lessonOf, type BandMeta, type EndReason, type Lesson } from "../learn/lessons";

const dir = process.env.DATA_DIR ?? "data";
const file = path.join(dir, LESSONS_FILE);
const write = process.argv.includes("--write");
const backfill = process.argv.includes("--backfill");

/* ---------- 1. recompute ---------- */

function recompute(): void {
  if (!existsSync(file)) {
    console.log(`no lessons at ${file}`);
    process.exit(0);
  }
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const ledger = readLedgerRows();
  let changed = 0;
  const out = lines.map((line) => {
    let l: Lesson;
    try {
      l = JSON.parse(line) as Lesson;
    } catch {
      return line;
    }
    const mode = (l.mode ?? "live") === "live" ? "live" : "dry-run";
    const rows = ledger.filter((r) => r.mode === mode);
    if (!rows.some((r) => r.position === l.position)) {
      console.log(`${l.label.padEnd(12)} ${new Date(l.closedAt).toISOString().slice(11, 16)}Z  no ledger rows: left as it was`);
      return line;
    }
    const meta: BandMeta = { pool: l.pool, label: l.label, kind: l.kind, openedAt: l.openedAt, seatSol: l.seatSol, bins: l.bins, binStep: l.binStep, coverPct: l.coverPct, travelBins60m: l.travelBins60m, predictedYieldPct: l.predictedYieldPct, entryYieldPct: l.entryYieldPct ?? null, entrySource: l.entrySource ?? null, entryCoveredMin: l.entryCoveredMin ?? null, entrySharePct: l.entrySharePct ?? null, entryYieldFactor: l.entryYieldFactor ?? null, ...(l.ask ? { ask: true } : {}) };
    const again = lessonOf({ meta, position: l.position, stats: null, rows, closedAt: l.closedAt, endReason: l.endReason, headline: l.headline, mode: l.mode });
    const diff = Math.abs(again.netSol - l.netSol) > 5e-7 || (again.tokensLeftSol ?? 0) !== (l.tokensLeftSol ?? 0) || (again.quoteDriftSol ?? null) !== (l.quoteDriftSol ?? null);
    const drift = again.quoteDriftSol;
    console.log(`${l.label.padEnd(12)} closed ${new Date(l.closedAt).toISOString().slice(11, 16)}Z  ${l.endReason.padEnd(12)} net ${l.netSol >= 0 ? "+" : ""}${l.netSol.toFixed(4)} -> ${again.netSol >= 0 ? "+" : ""}${again.netSol.toFixed(4)} SOL${(again.tokensLeftSol ?? 0) > 0 ? ` (of it ${again.tokensLeftSol!.toFixed(4)} in tokens left unsold)` : ""}${drift ? ` (of it ${drift.toFixed(4)} the quote's drift against SOL, ${again.netSolExDrift!.toFixed(4)} the seat's own)` : ""}${diff ? "" : "  unchanged"}`);
    if (!diff) return line;
    changed++;
    // the lesson keeps every observed fact; only what the ledger can re-derive is rewritten
    return JSON.stringify({ ...l, netSol: again.netSol, tokensLeftSol: again.tokensLeftSol, quoteDriftSol: again.quoteDriftSol, netSolExDrift: again.netSolExDrift });
  });
  if (!write) {
    console.log(`${changed} of ${lines.length} would change. Nothing written; pass -- --write to rewrite ${file}.`);
  } else if (changed > 0) {
    backup();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, out.join("\n") + "\n");
    renameSync(tmp, file);
    console.log(`${changed} of ${lines.length} rewritten.`);
  } else console.log("nothing to change");
}

function backup(): string {
  const b = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(file, b);
  console.log(`the old file is ${b}`);
  return b;
}

/* ---------- 2. backfill ---------- */

interface ClosedBand {
  address: string;
  pool: string;
  label: string;
  quoteSymbol: string;
  /** "BOTH" for a straddle, else a one-sided band: it says where the active bin sat at the open */
  side?: string;
  lowerBinId: number;
  upperBinId: number;
  openedAt: number;
  closedAt: number;
  closedActiveBinId?: number;
  entryValueSol: number;
  feeSol?: number;
  holdSec?: number;
  reason?: string;
}

/** PURE. The directive that closed a band and the rest of its reason, from the paper book's line. */
export function splitReason(reason: string): { kind: string | null; rotate: string | null; headline: string } {
  const m = /^(STOP|ROTATE|EXPIRE|FLATTEN):\s*(.*)$/s.exec(reason.trim());
  if (!m) return { kind: null, rotate: null, headline: reason };
  return { kind: m[1], rotate: m[1] === "ROTATE" ? m[2] : null, headline: m[2] };
}

/**
 * PURE. The lane a closed band belongs to, in the desk's own order: a tokenized stock first whatever
 * venue it trades on, then a made pair, then a memecoin (src/index.ts). The stock test is the MINT, never
 * the ticker in the label: the paper book held a pump.fun token called GOOGL and another called NIKE, and
 * a ticker match would have filed both under the stock lane.
 */
export function kindOf(pool: string, mint: string | null, stockPools: ReadonlySet<string>, stockMints: ReadonlySet<string>): BandMeta["kind"] {
  if (stockPools.has(pool) || (mint !== null && stockMints.has(mint))) return "stock";
  return pool.startsWith("pair-") ? "other" : "memecoin";
}

/**
 * PURE. The band's reach each way in bins, the half-width convention a live lesson uses. It comes from
 * the band's own shape, never from where the price happened to be at the close: a price that ran 190
 * bins away does not make the band 569% wide.
 */
export function reachBins(bins: number, side: string | undefined): number {
  const width = Math.max(1, bins - 1);
  return side === "BOTH" ? Math.max(1, Math.round(width / 2)) : width;
}

/**
 * PURE. The closed bands that have no lesson yet, oldest first. This is the whole of the backfill's
 * idempotency: a band whose position is already in the file is never touched, so a second run writes
 * nothing and a lesson the desk wrote at the close always wins over a reconstruction.
 */
export function missingBands<T extends { address: string; closedAt: number }>(closed: readonly T[], existing: readonly { position: string }[]): T[] {
  const have = new Set(existing.map((l) => l.position));
  return closed.filter((b) => !have.has(b.address)).sort((a, b) => a.closedAt - b.closedAt);
}

/** One pass over the journal: the bin step and label each pool showed, and each band's in-range cycles. */
async function scanJournal(dataDir: string): Promise<{ binStep: Map<string, number>; stats: Map<string, { cycles: number; inRange: number }> }> {
  const binStep = new Map<string, number>();
  const stats = new Map<string, { cycles: number; inRange: number }>();
  const jf = path.join(dataDir, "decisions.jsonl");
  if (!existsSync(jf)) return { binStep, stats };
  const rl = readline.createInterface({ input: createReadStream(jf), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let d: { pool?: { address?: string; binStep?: number }; positions?: { address?: string; inRange?: boolean }[] };
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.pool?.address && typeof d.pool.binStep === "number" && d.pool.binStep > 0) binStep.set(d.pool.address, d.pool.binStep);
    for (const p of d.positions ?? []) {
      if (!p.address) continue;
      const s = stats.get(p.address) ?? { cycles: 0, inRange: 0 };
      s.cycles += 1;
      if (p.inRange) s.inRange += 1;
      stats.set(p.address, s);
    }
  }
  return { binStep, stats };
}

async function runBackfill(): Promise<void> {
  const dataDir = path.resolve(process.cwd(), dir);
  const bookFile = path.join(dataDir, "paper-book.json");
  if (!existsSync(bookFile)) {
    console.log(`no paper book at ${bookFile}: the backfill reads closed paper bands`);
    return;
  }
  const mode = (process.env.LESSON_MODE ?? "paper").trim() || "paper";
  const ledgerMode: LedgerRow["mode"] = mode === "live" ? "live" : "dry-run";
  const book = JSON.parse(readFileSync(bookFile, "utf8")) as { closed?: ClosedBand[]; pairPools?: Record<string, { binStep?: number; mint?: string }> };
  const closed = book.closed ?? [];
  const existing: Lesson[] = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Lesson) : [];
  const missing = missingBands(closed, existing);
  console.log(`${closed.length} closed bands in the book, ${existing.length} lessons on record, ${missing.length} missing`);
  if (missing.length === 0) {
    console.log("nothing to backfill");
    return;
  }

  const { binStep: journalStep, stats } = await scanJournal(dataDir);
  const stockPools = new Set<string>();
  const stockMints = new Set<string>();
  try {
    const screen = JSON.parse(readFileSync(path.join(dataDir, "screen.json"), "utf8")) as { pools?: { address: string; stock?: unknown }[] };
    for (const p of screen.pools ?? []) if (p.stock) stockPools.add(p.address);
  } catch {
    /* the screen is a convenience here, not a requirement */
  }
  try {
    const mints = JSON.parse(readFileSync(path.join(dataDir, "stock-mints.json"), "utf8")) as { mints?: Record<string, unknown> };
    for (const m of Object.keys(mints.mints ?? {})) stockMints.add(m);
  } catch {
    /* same */
  }
  const fromLessons = new Map<string, number>();
  for (const l of existing) if (l.binStep > 0) fromLessons.set(l.pool, l.binStep);
  const stepOf = (pool: string): number | null => journalStep.get(pool) ?? fromLessons.get(pool) ?? book.pairPools?.[pool]?.binStep ?? null;

  const rows = readLedgerRows().filter((r) => r.mode === ledgerMode);
  const written: Lesson[] = [];
  const skipped: string[] = [];
  for (const b of missing) {
    const step = stepOf(b.pool);
    if (step === null) {
      skipped.push(`${b.label} (${b.address}): no bin step on record for ${b.pool.slice(0, 8)}`);
      continue;
    }
    if (!rows.some((r) => r.position === b.address)) {
      skipped.push(`${b.label} (${b.address}): no ledger rows`);
      continue;
    }
    const bins = b.upperBinId - b.lowerBinId + 1;
    const reach = reachBins(bins, b.side);
    const { kind: directive, rotate, headline } = splitReason(b.reason ?? "");
    const endReason: EndReason = endReasonOf(directive, rotate, headline);
    const meta: BandMeta = {
      pool: b.pool,
      label: b.label,
      kind: kindOf(b.pool, book.pairPools?.[b.pool]?.mint ?? rows.find((r) => r.position === b.address && r.tokenMint)?.tokenMint ?? null, stockPools, stockMints),
      openedAt: b.openedAt,
      seatSol: b.entryValueSol,
      bins,
      binStep: step,
      coverPct: coveragePct(step, reach),
      travelBins60m: null,
      predictedYieldPct: null,
      entryYieldPct: null,
      entrySource: null,
      entryCoveredMin: null,
      entrySharePct: null,
      entryYieldFactor: null,
    };
    const st = stats.get(b.address) ?? null;
    const l = lessonOf({ meta, position: b.address, stats: st, rows, closedAt: b.closedAt, endReason, headline: b.reason ?? "", mode, ledgerMode });
    written.push({ ...l, backfilled: true });
  }

  const byTime = [...existing, ...written].sort((a, b) => a.at - b.at || a.position.localeCompare(b.position));
  const tally: Record<string, number> = {};
  for (const l of written) tally[l.endReason] = (tally[l.endReason] ?? 0) + 1;
  for (const l of written) {
    console.log(
      `+ ${l.label.padEnd(12)} ${new Date(l.closedAt).toISOString().slice(5, 16)}Z ${l.kind.padEnd(8)} ${l.endReason.padEnd(12)} ${l.minutes.toFixed(0).padStart(5)} min, ${String(l.bins).padStart(3)} bins (${l.coverPct.toFixed(1)}%), in range ${l.inRangePct === null ? "n/a " : `${l.inRangePct.toFixed(0).padStart(3)}%`}, fees ${l.feesSol.toFixed(4)}, net ex-drift ${(l.netSolExDrift ?? l.netSol) >= 0 ? "+" : ""}${(l.netSolExDrift ?? l.netSol).toFixed(4)} SOL`,
    );
  }
  for (const s of skipped) console.log(`- skipped ${s}`);
  console.log(`\n${written.length} lessons reconstructed, ${skipped.length} skipped, ${byTime.length} rows in the file afterwards`);
  console.log(`  by end: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  console.log(`  in-range share reconstructed for ${written.filter((l) => l.inRangePct !== null).length} of ${written.length}`);
  if (!write) {
    console.log(`Nothing written; pass -- --backfill --write to write ${file}.`);
    return;
  }
  if (existsSync(file)) backup();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, byTime.map((l) => JSON.stringify(l)).join("\n") + "\n");
  renameSync(tmp, file);
  console.log(`${file} now holds ${byTime.length} lessons, ${written.length} of them backfilled.`);
}

async function main(): Promise<void> {
  if (backfill) await runBackfill();
  else recompute();
}

// only when it is the script being run: the tests import the pure helpers above
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
