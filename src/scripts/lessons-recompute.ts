/**
 * Re-derive every lesson's net from the ledger with today's accounting (src/learn/lessons.ts seatNetSol).
 *   DATA_DIR=data-mainnet npm run lessons:recompute          shows before and after, writes nothing
 *   DATA_DIR=data-mainnet npm run lessons:recompute -- --write   backs the file up beside itself, then rewrites it
 * Only netSol and tokensLeftSol change: the seat's facts (bins, minutes, in-range share, why it ended) were
 * observed when it closed and the ledger cannot give them back. A lesson whose rows are no longer in the
 * ledger is left as it was.
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readLedgerRows } from "../engine/ledger";
import { LESSONS_FILE, lessonOf, type BandMeta, type Lesson } from "../learn/lessons";

const dir = process.env.DATA_DIR ?? "data";
const file = path.join(dir, LESSONS_FILE);
const write = process.argv.includes("--write");
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
  const meta: BandMeta = { pool: l.pool, label: l.label, kind: l.kind, openedAt: l.openedAt, seatSol: l.seatSol, bins: l.bins, binStep: l.binStep, coverPct: l.coverPct, travelBins60m: l.travelBins60m, predictedYieldPct: l.predictedYieldPct };
  const again = lessonOf({ meta, position: l.position, stats: null, rows, closedAt: l.closedAt, endReason: l.endReason, headline: l.headline, mode: l.mode });
  const diff = Math.abs(again.netSol - l.netSol) > 5e-7 || (again.tokensLeftSol ?? 0) !== (l.tokensLeftSol ?? 0);
  console.log(`${l.label.padEnd(12)} closed ${new Date(l.closedAt).toISOString().slice(11, 16)}Z  ${l.endReason.padEnd(12)} net ${l.netSol >= 0 ? "+" : ""}${l.netSol.toFixed(4)} -> ${again.netSol >= 0 ? "+" : ""}${again.netSol.toFixed(4)} SOL${(again.tokensLeftSol ?? 0) > 0 ? ` (of it ${again.tokensLeftSol!.toFixed(4)} in tokens left unsold)` : ""}${diff ? "" : "  unchanged"}`);
  if (!diff) return line;
  changed++;
  return JSON.stringify({ ...l, netSol: again.netSol, tokensLeftSol: again.tokensLeftSol });
});
if (!write) {
  console.log(`${changed} of ${lines.length} would change. Nothing written; pass -- --write to rewrite ${file}.`);
} else if (changed > 0) {
  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(file, backup);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, out.join("\n") + "\n");
  renameSync(tmp, file);
  console.log(`${changed} of ${lines.length} rewritten. The old file is ${backup}.`);
} else console.log("nothing to change");
