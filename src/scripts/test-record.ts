/**
 * The record of a real-money run (src/learn/record.ts): fees, the book, and the walk from the per-seat
 * sum to the ledger's cash, on a small made-up run where every term is known by hand.
 *   npx tsx src/scripts/test-record.ts
 */
import assert from "node:assert/strict";
import type { LedgerRow } from "../engine/ledger";
import { seatNetSol } from "../learn/lessons";
import { bookOf, cashChecks, feeTally, reconcile, seatCashOf, seatSwaps, type BookPoint } from "../learn/record";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(err);
    process.exitCode = 1;
  }
}
const near = (a: number, b: number, tol = 1e-9, what = "") => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what} expected ${b}, got ${a}`);

const P = "Pool1111";
const row = (ts: number, mech: LedgerRow["mech"], position: string | null, solDelta: number, tokenDelta: number, mark: number, extra: Partial<LedgerRow> = {}): LedgerRow => ({
  ts, mode: "live", sig: `sig${ts}`, pool: P, position, mech, solDelta, tokenDelta, tokenMint: "Tok", markTokenInSol: mark, rentSol: 0, txFeeSol: 0, basis: "exact", note: "", ...extra,
});

/**
 * The run, by hand:
 *   C  opened before lessons were kept: -1 in, a claim of 0.01 SOL and 5 tokens (0.06 at the mark), +1.2 back. Cash +0.21.
 *   A  a swap buys its token half (-1 for 100), it deposits -1 and the 100, claims 0.05, closes for +0.5 and 200 tokens it
 *      does not sell: tokensLeft 200 x 0.01 = 2.0. Net -1 -1 +0.05 +0.5 +2.0 = +0.55 (the lesson on disk says +0.57).
 *   B  re-lays 150 of A's tokens with -0.5: no swap bought them, so it is charged 150 x 0.008 = 1.2. Closes for +0.4 and
 *      150 tokens (0.02 of fees in it), sells them for +0.9. Net -0.5 +0.4 +0.9 -1.2 = -0.4.
 *   A swap long after sells A's last 50 tokens for +0.3: no seat's window holds it.
 * Cash: +0.21 -1.5 +0.05 +0.8 +0.3 = -0.14.
 */
const rows: LedgerRow[] = [
  row(0, "open", "C", -1, 0, 0.01),
  row(5, "collect", "C", 0.01, 5, 0.01, { feeSol: 0.06 }),
  row(10, "close", "C", 1.2, 0, 0.01),
  row(100_000, "swap", null, -1, 100, 0.01),
  row(100_001, "open", "A", -1, -100, 0.01),
  row(500_000, "collect", "A", 0.05, 0, 0.01, { feeSol: 0.05 }),
  row(1_000_000, "close", "A", 0.5, 200, 0.01),
  row(5_000_000, "open", "B", -0.5, -150, 0.008),
  row(6_000_000, "close", "B", 0.4, 150, 0.006, { feeSol: 0.02 }),
  row(6_000_100, "swap", null, 0.9, -150, 0.006),
  row(9_000_000, "swap", null, 0.3, -50, 0.006),
];
const seatA = { pool: P, position: "A", openedAt: 100_001, closedAt: 1_000_000 };
const seatB = { pool: P, position: "B", openedAt: 5_000_000, closedAt: 6_000_000 };

async function main() {
  console.log("fees");
  await test("feeTally: claims at their mark (part in tokens) plus the fee legs of closes", () => {
    const f = feeTally(rows);
    assert.equal(f.claims, 2);
    near(f.claimSol, 0.11);
    near(f.claimCashSol, 0.06, 1e-9, "0.05 of C's claim came as tokens");
    assert.equal(f.closesWithFees, 1);
    near(f.closeFeeSol, 0.02);
    near(f.totalSol, 0.13);
  });

  console.log("the book");
  const pts: BookPoint[] = [
    { t: 0, equitySol: 10, walletSol: 10, bandsSol: 0, tokensSol: 0, bands: 0, feesClaimedSol: 0 },
    { t: 100, equitySol: 12, walletSol: 9, bandsSol: 3, tokensSol: 0, bands: 1, feesClaimedSol: 0.1 },
    { t: 200, equitySol: 9.9, walletSol: 9.9, bandsSol: 0, tokensSol: 0, bands: 0, feesClaimedSol: 0.2 },
    { t: 300, equitySol: 9.9, walletSol: 9.9, bandsSol: 0, tokensSol: 0, bands: 0, feesClaimedSol: 0.2 },
    { t: 400, equitySol: 9.9, walletSol: 9.9, bandsSol: 0, tokensSol: 0, bands: 0, feesClaimedSol: 0.2 },
    { t: 500, equitySol: 9.8, walletSol: 9.8, bandsSol: 0, tokensSol: 0, bands: 0, feesClaimedSol: 0.2 },
    { t: 600, equitySol: 9.5, walletSol: 8, bandsSol: 1.4, tokensSol: 0.1, bands: 1, feesClaimedSol: 0.3 },
  ];
  await test("bookOf: start, end, peak and low from the marks, in any order", () => {
    const b = bookOf([...pts].reverse())!;
    assert.equal(b.startSol, 10);
    assert.equal(b.endSol, 9.5);
    near(b.changeSol, -0.5);
    assert.equal(b.peakSol, 12);
    assert.equal(b.peakAt, 100);
    assert.equal(b.lowSol, 9.5);
    near(b.endBandsSol, 1.4);
    assert.deepEqual(b.flat.map((f) => f.t), [0, 200, 300, 400, 500]);
    assert.equal(bookOf([]), null);
  });
  await test("cashChecks: an all-cash mark with no row since the last mark must match the ledger; a gap is money it never saw", () => {
    const cash = [row(50, "open", "X", -1, 0, 1), row(150, "close", "X", 0.9, 0, 1)];
    const c = cashChecks(pts, cash);
    assert.deepEqual(c.map((x) => x.t), [300, 500], "200 had a row since the mark before; 400 repeats 300");
    near(c[0].ledgerSol, 9.9);
    near(c[0].gapSol, 0);
    near(c[1].gapSol, -0.1, 1e-9, "0.1 left the wallet with no ledger row");
  });

  console.log("a seat, taken apart");
  await test("seatCashOf: own cash + swap share + tokens left + unbought = seatNetSol, for each seat", () => {
    for (const s of [seatA, seatB]) {
      const c = seatCashOf(rows, s);
      const direct = seatNetSol(rows.filter((r) => r.position === s.position), seatSwaps(rows, s), s.position).netSol;
      near(c.netSol, direct, 1e-12, `${s.position} net`);
      near(c.ownSol + c.swapSol + c.tokensLeftSol + c.unboughtSol, c.netSol, 1e-12, `${s.position} parts`);
    }
    const a = seatCashOf(rows, seatA);
    near(a.netSol, 0.55);
    near(a.ownSol, -0.45);
    near(a.swapSol, -1, 1e-9, "the buy of its token half, in full");
    near(a.tokensLeftSol, 2.0);
    near(a.unboughtSol, 0);
    const b = seatCashOf(rows, seatB);
    near(b.netSol, -0.4);
    near(b.swapSol, 0.9);
    near(b.unboughtSol, -1.2, 1e-9, "150 of A's tokens, charged at B's open mark");
  });

  console.log("from the per-seat sum to the cash");
  await test("reconcile: every term by hand, and nothing left over", () => {
    const r = reconcile(rows, [
      { ...seatA, netSol: 0.57 },
      { ...seatB, netSol: -0.4 },
    ]);
    near(r.seatSumSol, 0.17);
    near(r.cashChangeSol, -0.14);
    const term = (k: string) => r.terms.find((t) => t.key === k)!;
    near(term("stale").sol, -0.02, 1e-9, "A's lesson was written 0.02 high");
    assert.equal(term("stale").count, 1);
    near(term("tokensLeft").sol, -2.0);
    near(term("unbought").sol, 1.2);
    near(term("seatsBefore").sol, 0.21);
    assert.equal(term("seatsBefore").count, 1);
    near(term("seatsAfter").sol, 0);
    near(term("swapsUnshared").sol, 0.3, 1e-9, "the late sale of A's last 50");
    assert.equal(term("swapsUnshared").count, 1);
    near(term("otherRows").sol, 0);
    near(r.residualSol, 0, 1e-12);
    assert.deepEqual(r.unlessoned.map((u) => [u.position, u.before]), [["C", true]]);
  });
  await test("reconcile: a seat written twice is taken apart once and its copy shows as unexplained; a row no seat covers lands in a term", () => {
    const extra = [...rows, row(9_500_000, "rent", null, 0, 0, 0, { rentSol: -0.002, txFeeSol: -0.000005 })];
    const r = reconcile(extra, [
      { ...seatA, netSol: 0.55 },
      { ...seatA, netSol: 0.55 },
      { ...seatB, netSol: -0.4 },
    ]);
    assert.equal(r.seats, 2);
    near(r.terms.find((t) => t.key === "otherRows")!.sol, -0.002005);
    near(r.residualSol, 0.55, 1e-9, "the copy of A stays in the sum as written, and nothing explains it");
  });

  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
}
main();
