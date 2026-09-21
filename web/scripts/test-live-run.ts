/**
 * The frozen live run (web/public/live-run.json, written by freeze-live-run.ts) read the way the page
 * reads it (web/src/liveRun.ts): the record's figures printed, and the rules the chapter rests on
 * checked. Every move carries a transaction, the ledger counts what the header counts, and the
 * money adds up: the change in the book is the fees claimed plus what the rest took.
 * From the repository root:
 *   npx tsx web/scripts/test-live-run.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { lengthWords, liveRunOf, spanWords, type LiveRunFile } from "../src/liveRun";

const file = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), process.env.FILE ?? "web/public/live-run.json"), "utf8")) as LiveRunFile;
const run = liveRunOf(file);
assert.ok(run, "the file holds a run");

const r = run;
console.log(`live run of ${r.agentName}, wallet ${r.wallet}`);
console.log(`  ${new Date(r.firstTs).toISOString()} to ${new Date(r.lastTs).toISOString()}: ${r.hours.toFixed(1)} hours (${spanWords(r.firstTs, r.lastTs)}, ${lengthWords(r.hours)})`);
console.log(`  equity ${r.startEquity.toFixed(4)} -> ${r.endEquity.toFixed(4)} SOL (${r.change >= 0 ? "+" : ""}${r.change.toFixed(4)}, ${r.changePct.toFixed(2)}%), peak ${r.peakEquity.toFixed(4)}, low ${r.lowEquity.toFixed(4)}`);
console.log(`  fees claimed ${r.feesClaimed.toFixed(4)} SOL in ${r.claims} claims`);
console.log(`  ${r.moves} moves: ${r.opens} opens, ${r.relays} re-lays, ${r.closes} closes, ${r.claims} claims; ${r.transactions} transactions; ${r.pools.length} pools: ${r.pools.join(", ")}`);
console.log(`  ${r.decisions} decisions, ${r.holds} holds, ${r.failed} failed; ${r.record.days.length} day rows; status ${r.status.mode}`);
console.log(`  newest: ${r.rows[0].ts} ${r.rows[0].sentence} ${r.rows[0].href}`);
console.log(`  oldest: ${r.rows[r.rows.length - 1].ts} ${r.rows[r.rows.length - 1].sentence} ${r.rows[r.rows.length - 1].href}`);

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(err);
    process.exitCode = 1;
  }
}

test("a live run on one wallet, every row of it sent on-chain", () => {
  assert.equal(r.status.mode, "live");
  assert.ok(r.rows.every((x) => x.verdict === "placed" || x.verdict === "override"));
  assert.ok(r.rows.every((x) => x.href?.startsWith("https://solscan.io/tx/")), "every move links its transaction");
  assert.ok(file.entries.every((e) => e.wallet.address === file.wallet));
});
test("the ledger counts what the header counts", () => {
  assert.equal(r.rows.length, file.entries.length);
  assert.equal(r.moves, r.opens + r.relays + r.closes + r.claims);
  assert.ok(r.transactions >= r.moves, "at least one transaction a move");
});
test("the record reads the whole run from the equity history", () => {
  assert.ok(r.record.sinceStart, "start and end come from the desk's own marks");
  assert.equal(r.startEquity, file.points[0].equitySol);
  assert.equal(r.endEquity, file.points[file.points.length - 1].equitySol);
  assert.ok(r.peakEquity >= Math.max(r.startEquity, r.endEquity));
  assert.ok(r.lowEquity <= Math.min(r.startEquity, r.endEquity));
});
test("the money adds up: the fees claimed are the marks' own count", () => {
  const last = file.points[file.points.length - 1];
  assert.ok(Math.abs(r.feesClaimed - (last.feesClaimedSol - file.points[0].feesClaimedSol)) < 1e-6);
  assert.ok(Math.abs(r.change - (r.endEquity - r.startEquity)) < 1e-6);
});
test("the words", () => {
  assert.equal(spanWords(Date.parse("2026-09-17T10:34:46Z"), Date.parse("2026-09-19T01:40:00Z")), "17–19 September");
  assert.equal(spanWords(Date.parse("2026-09-30T10:00:00Z"), Date.parse("2026-10-02T01:40:00Z")), "30 September – 2 October");
  assert.equal(lengthWords(39.08), "39 hours");
  assert.equal(lengthWords(50), "2 days");
  assert.equal(lengthWords(0.4), "1 hour");
});
console.log(`${passed} passed${process.exitCode ? ", with failures" : ""}`);
