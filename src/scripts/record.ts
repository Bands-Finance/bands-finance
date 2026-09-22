/**
 * The real-money record, recomputed from the files on disk: fees, the book, the per-seat sum, and why
 * they disagree, line by line (src/learn/record.ts). Read-only: it opens files and prints.
 *   npm run record                                  data-mainnet and web/public/live-run.json
 *   DATA_DIR=/path/to/data-mainnet npm run record   another copy of the data
 *   npm run record -- --site path/to/live-run.json  another frozen site file
 * docs/sprint.md ("One headline number") quotes what it prints.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isLedgerRow, type LedgerRow } from "../engine/ledger";
import type { Lesson } from "../learn/lessons";
import { bookOf, cashChecks, feeTally, flowOf, reconcile, type BookPoint } from "../learn/record";

const dir = process.env.DATA_DIR ?? "data-mainnet";
const siteArg = process.argv.indexOf("--site");
const siteFile = siteArg > 0 ? process.argv[siteArg + 1] : path.join("web", "public", "live-run.json");
const MODE = "live";

function jsonl<T>(file: string): T[] {
  const p = path.join(dir, file);
  if (!existsSync(p)) return [];
  const out: T[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* a torn line */
    }
  }
  return out;
}

const at = (t: number) => new Date(t).toISOString().slice(5, 16).replace("T", " ") + "Z";
const s4 = (n: number) => `${n >= 0 ? "+" : "-"}${Math.abs(n).toFixed(4)}`;
const f4 = (n: number) => n.toFixed(4);

function main(): void {
  const rows = jsonl<unknown>("ledger.jsonl").filter(isLedgerRow).filter((r) => r.mode === MODE) as LedgerRow[];
  const points = jsonl<BookPoint & { mode?: string }>("equity.jsonl").filter((p) => (p.mode ?? MODE) === MODE);
  const lessons = jsonl<Lesson>("lessons.jsonl").filter((l) => (l.mode ?? "live") === MODE && typeof l.netSol === "number");
  if (rows.length === 0 || points.length === 0) {
    console.log(`no ${MODE} ledger or equity marks in ${dir}. Point DATA_DIR at the run's data.`);
    process.exit(1);
  }
  const book = bookOf(points)!;
  const fees = feeTally(rows);
  const rec = reconcile(rows, lessons);

  // the journal: what the desk says it executed
  const journal = jsonl<{ decision?: { action?: string }; execution?: { mode?: string; ok?: boolean; txs?: { signature?: string | null }[] } }>("decisions.jsonl");
  const executed = journal.filter((e) => e.execution?.mode === MODE && e.execution.ok);
  const jClaims = executed.filter((e) => e.decision?.action === "CLAIM_FEES").length;
  const jSigs = new Set(journal.flatMap((e) => (e.execution?.mode === MODE ? (e.execution.txs ?? []).map((t) => t.signature).filter((s): s is string => !!s) : [])));
  const offJournal = rows.filter((r) => r.sig && !jSigs.has(r.sig));

  console.log(`THE RECORD, ${MODE}, from ${dir}: ${rows.length} ledger rows, ${points.length} equity marks, ${lessons.length} lessons, ${journal.length} journal entries`);
  console.log(`  run: ${at(book.startAt)} to ${at(book.endAt)} (the last mark), ${((book.endAt - book.startAt) / 3600e3).toFixed(1)} hours`);

  console.log(`\nFEES (ledger.jsonl: collect rows and the fee leg of close rows, each at its own mark)`);
  console.log(`  claims          ${String(fees.claims).padStart(3)} rows   ${f4(fees.claimSol)} SOL   (of it ${f4(fees.claimCashSol)} paid in SOL, ${f4(fees.claimSol - fees.claimCashSol)} in tokens at the claim's mark)`);
  console.log(`  close fee legs  ${String(fees.closesWithFees).padStart(3)} rows   ${f4(fees.closeFeeSol)} SOL`);
  console.log(`  fees realised           ${f4(fees.totalSol)} SOL`);
  console.log(`  check: equity.jsonl last feesClaimedSol ${f4(book.endFeesClaimedSol)} (${s4(book.endFeesClaimedSol - fees.totalSol)}; a claim after the last mark lands here and not there)`);
  console.log(`  check: the journal has ${jClaims} executed claims; ${offJournal.length} ledger row(s) carry a signature the journal never saw (${offJournal.map((r) => `${r.mech} ${at(r.ts)}`).join(", ") || "none"})`);

  const cashEnd = book.startSol + rec.cashChangeSol;
  console.log(`\nTHE BOOK (equity.jsonl, the desk's own marks: wallet + bands + tokens)`);
  console.log(`  start  ${f4(book.startSol)} SOL  ${at(book.startAt)}`);
  console.log(`  peak   ${f4(book.peakSol)} SOL  ${at(book.peakAt)}`);
  console.log(`  low    ${f4(book.lowSol)} SOL  ${at(book.lowAt)}`);
  console.log(`  end    ${f4(book.endSol)} SOL  ${at(book.endAt)}, with ${f4(book.endBandsSol)} still in a band and ${f4(book.endTokensSol)} in tokens, at the mark`);
  console.log(`  net on the marks       ${s4(book.changeSol)} SOL`);
  console.log(`  net in cash (ledger)   ${s4(rec.cashChangeSol)} SOL: every live row summed, the last band closed and its tokens sold, so the book ends at ${f4(cashEnd)} SOL, all SOL`);
  console.log(`  between the two        ${s4(cashEnd - book.endSol)} SOL: what the band open at the last mark, the claim after it and ${f4(book.endTokensSol)} of tokens came to beyond their mark`);
  const late = rows.filter((r) => r.ts > book.endAt);
  if (late.length) console.log(`    rows after the last mark: ${late.map((r) => `${r.mech} ${at(r.ts)} ${s4(flowOf(r))}`).join(", ")}`);
  for (const c of cashChecks(points, rows)) console.log(`  check, all cash at ${at(c.t)}: the wallet read ${f4(c.walletSol)}, the ledger says ${f4(c.ledgerSol)} (${s4(c.gapSol)})`);

  console.log(`\nTHE PER-SEAT SUM (lessons.jsonl, ${rec.seats} seats) TO THE CASH (ledger.jsonl)`);
  const noMode = lessons.filter((l) => !l.mode);
  console.log(`  per-seat sum, as written                         ${s4(rec.seatSumSol)} SOL   (${lessons.length - noMode.length} lessons tagged live: ${s4(lessons.filter((l) => l.mode).reduce((t, l) => t + l.netSol, 0))}; ${noMode.length} written before the tag: ${s4(noMode.reduce((t, l) => t + l.netSol, 0))})`);
  for (const t of rec.terms) {
    if (t.count === 0 && Math.abs(t.sol) < 5e-7) continue;
    console.log(`  ${s4(t.sol)}  ${t.label} [${t.count}]`);
  }
  console.log(`  = the ledger's cash change                       ${s4(rec.cashChangeSol)} SOL   (unexplained ${s4(rec.residualSol)})`);
  for (const u of rec.unlessoned) console.log(`    no lesson: ${u.position.slice(0, 6)} in ${u.pool.slice(0, 6)}, ${at(u.openedAt)} to ${u.closedAt ? at(u.closedAt) : "open"}, ${s4(u.flowSol)} SOL${u.before ? "" : " (after lessons began)"}`);

  if (existsSync(siteFile)) {
    const site = JSON.parse(readFileSync(siteFile, "utf8")) as { points: BookPoint[]; entries: { decision: { action: string }; execution: { ok?: boolean; txs: { signature?: string | null }[] } }[]; peakEquitySol?: number; lowEquitySol?: number };
    const sb = bookOf(site.points);
    const claims = site.entries.filter((e) => e.decision.action === "CLAIM_FEES").length;
    const sigs = site.entries.reduce((n, e) => n + e.execution.txs.filter((t) => t.signature).length, 0);
    const sFees = sb ? sb.endFeesClaimedSol - site.points.reduce((m, p) => (p.t < m.t ? p : m)).feesClaimedSol : NaN;
    const row = (what: string, site: string, here: string) => console.log(`  ${what.padEnd(14)} site ${site.padEnd(12)} here ${here.padEnd(12)} ${site === here ? "agrees" : "DISAGREES"}`);
    console.log(`\nTHE SITE'S FILE (${siteFile}), as web/src/liveRun.ts reads it, against the above`);
    if (sb) {
      row("start", f4(sb.startSol), f4(book.startSol));
      row("end", f4(sb.endSol), f4(book.endSol));
      row("net", s4(sb.changeSol), s4(book.changeSol));
      row("peak", f4(site.peakEquitySol ?? sb.peakSol), f4(book.peakSol));
      row("low", f4(site.lowEquitySol ?? sb.lowSol), f4(book.lowSol));
      row("fees", f4(sFees), f4(fees.totalSol));
    }
    row("claims", String(claims), String(fees.claims));
    row("transactions", String(sigs), String(jSigs.size));
  }
}

main();
