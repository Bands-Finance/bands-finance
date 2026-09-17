/**
 * The self-learning loop (src/learn/lessons.ts): the lesson of a closed seat, and the width tuner.
 *   npx tsx src/scripts/test-learn.ts
 */
import assert from "node:assert/strict";
import type { LedgerRow } from "../engine/ledger";
import { applyTuning, endReasonOf, lessonLine, lessonOf, tuneEnv, tuneFromLessons, type BandMeta, type Lesson } from "../learn/lessons";

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
const near = (a: number, b: number, tol = 1e-9, what = "") => assert.ok(Math.abs(a - b) <= tol, `${what} expected ${b}, got ${a}`);

const T0 = Date.parse("2026-09-17T13:21:00Z");
const row = (o: Partial<LedgerRow> & Pick<LedgerRow, "ts" | "mech" | "solDelta">): LedgerRow => ({
  mode: "live", sig: "s", pool: "POOL", position: "POS", tokenDelta: 0, tokenMint: "M", markTokenInSol: 0.00003, rentSol: 0, txFeeSol: -0.000005, basis: "exact", note: "", ...o,
});
const meta: BandMeta = { pool: "POOL", label: "baton/SOL", kind: "memecoin", openedAt: T0, seatSol: 7.5, bins: 5, binStep: 100, coverPct: 4.06, travelBins60m: 24, predictedYieldPct: 216.6 };

async function main() {
  console.log("lessons");
  await test("lessonOf: baton's seat, 30 minutes, priced out; net from the ledger's SOL, rent and fees; the realized yield from the claims", () => {
    const rows = [
      row({ ts: T0, mech: "open", solDelta: -7.5, rentSol: -0.043414 }),
      row({ ts: T0 + 6 * 60_000, mech: "collect", solDelta: 0.146, feeSol: 0.146 }),
      row({ ts: T0 + 15 * 60_000, mech: "collect", solDelta: 0.149, feeSol: 0.149 }),
      row({ ts: T0 + 25 * 60_000, mech: "collect", solDelta: 0.1825, feeSol: 0.1825 }),
      row({ ts: T0 + 30 * 60_000, mech: "close", solDelta: 0.0, rentSol: 0.043414, feeSol: 0.001, tokenDelta: 210307 }),
      row({ ts: T0 + 30 * 60_000 + 20_000, mech: "swap", solDelta: 7.0205, position: null, tokenDelta: -210307 }),
      row({ ts: T0 + 3 * 60_000, mech: "collect", solDelta: 0.5, position: "OTHER", pool: "ELSEWHERE" }),
    ];
    const l = lessonOf({ meta, position: "POS", stats: { cycles: 6, inRange: 2 }, rows, closedAt: T0 + 30 * 60_000, endReason: "through-band", headline: "4 bins through the band and 1512s out. Off the table." });
    assert.equal(l.minutes, 30);
    near(l.feesSol, 0.146 + 0.149 + 0.1825 + 0.001, 1e-9, "fees");
    near(l.netSol, -7.5 + 0.146 + 0.149 + 0.1825 + 0.0 + 7.0205 - 0.000005 * 6, 1e-9, "net: SOL in and out, the rent that came back, six network fees");
    assert.equal(l.inRangePct, 33.3);
    near(l.realizedYieldPctPerDay, ((0.146 + 0.149 + 0.1825 + 0.001) / 7.5) * (1440 / 30) * 100, 0.01, "realized yield");
    assert.equal(l.endReason, "through-band");
    assert.match(lessonLine(l), /^\[lesson\] baton\/SOL: 30 min, 5 bins \(4\.1% of price against 24 bins of travel the hour before\), in range 33\.3% of the time, ended through-band; fees 0\.4785 SOL \(306\.2%\/day realized vs 216\.6% predicted\), net -0\.0020 SOL$/);
    assert.equal(lessonOf({ meta, position: "POS", stats: null, rows: [], closedAt: T0 + 60_000, endReason: "close", headline: "" }).inRangePct, null);
  });

  await test("endReasonOf: the directive first, then the rotation's reason, then the policy's headline", () => {
    assert.equal(endReasonOf("STOP", null, "x"), "stop");
    assert.equal(endReasonOf("ROTATE", "on the operator's exit list (ROTATE_OUT_POOLS): the book moves on", "x"), "exit-list");
    assert.equal(endReasonOf("ROTATE", "its own flow faded: ...", "x"), "faded");
    assert.equal(endReasonOf("ROTATE", "MRVL earns ... while NVDAx, already held, earns ...", "x"), "consolidated");
    assert.equal(endReasonOf("ROTATE", "MCDx earns ... while DKNG would earn about ...", "x"), "rotated");
    assert.equal(endReasonOf(null, null, "4 bins through the band and 1512s out. Off the table."), "through-band");
    assert.equal(endReasonOf(null, null, "Price ran off the top. Idle 2000s, off the table."), "idle");
    assert.equal(endReasonOf(null, null, "Closing."), "close");
  });

  console.log("tuning");
  const lesson = (label: string, endReason: Lesson["endReason"], minutes: number, inRangePct: number | null, realized: number, at = T0): Lesson => ({
    at, pool: label, label, position: `${label}-${at}`, kind: "memecoin", openedAt: at - minutes * 60_000, closedAt: at, minutes, seatSol: 7.5, bins: 5, binStep: 100, coverPct: 4, travelBins60m: 24, inRangePct, endReason, feesSol: 0.1, netSol: 0, predictedYieldPct: null, realizedYieldPctPerDay: realized, headline: "",
  });
  await test("tuneFromLessons: three of the last five seats priced out within thirty minutes widens the band one step; the gap, the bounds and a thin record hold it; all-idle narrows", () => {
    const env = tuneEnv({});
    assert.deepEqual([env.step, env.min, env.max, env.window, env.pricedOutMin], [0.25, 0.5, 1.5, 5, 30]);
    const now = T0 + 3_600_000;
    const pricedOut = [lesson("A", "through-band", 6, 20, 300), lesson("B", "close", 90, 80, 30), lesson("C", "through-band", 12, 30, 200), lesson("D", "through-band", 25, 40, 100), lesson("E", "stop", 40, 50, 10)];
    const c = tuneFromLessons(pricedOut, { volMultiple: 0.75 }, null, env, now)!;
    assert.deepEqual([c.knob, c.from, c.to], ["volMultiple", 0.75, 1]);
    assert.match(c.why, /^3 of the last 5 memecoin seats were priced out of the band within 30 min of laying \(A 6 min, C 12 min, D 25 min\)/);
    assert.equal(tuneFromLessons(pricedOut, { volMultiple: 1.5 }, null, env, now), null, "at the ceiling");
    assert.equal(tuneFromLessons(pricedOut, { volMultiple: 0.75 }, { volMultiple: 0.75, history: [{ at: now - 3_600_000, knob: "volMultiple", from: 0.5, to: 0.75, why: "" }] }, env, now), null, "an hour since the last change: inside the six-hour gap");
    assert.equal(tuneFromLessons(pricedOut.slice(0, 4), { volMultiple: 0.75 }, null, env, now), null, "four lessons are not a window of five");
    assert.equal(tuneFromLessons([lesson("A", "through-band", 45, 20, 300), ...pricedOut.slice(1)], { volMultiple: 0.75 }, null, env, now), null, "two of five priced out is not most");
    const idle = [1, 2, 3, 4, 5].map((i) => lesson(`I${i}`, "idle", 120, 95, 1));
    const n = tuneFromLessons(idle, { volMultiple: 1 }, null, env, now)!;
    assert.deepEqual([n.from, n.to], [1, 0.75]);
    assert.match(n.why, /sat in range 90% of the time or more and earned under 2%\/day/);
    assert.equal(tuneFromLessons(idle, { volMultiple: 0.5 }, null, env, now), null, "at the floor");
    assert.equal(tuneFromLessons([...idle.slice(1), { ...idle[0], kind: "stock" }], { volMultiple: 1 }, null, env, now), null, "stock seats do not teach the memecoin width");
  });

  await test("applyTuning: the tuned multiple on top of the env, inside the bounds; nothing without a tuning file", () => {
    const base = { volMultiple: 0.75, other: 1 };
    assert.deepEqual(applyTuning(base, null, { min: 0.5, max: 1.5 }), base);
    assert.equal(applyTuning(base, { volMultiple: 1.25, history: [] }, { min: 0.5, max: 1.5 }).volMultiple, 1.25);
    assert.equal(applyTuning(base, { volMultiple: 9, history: [] }, { min: 0.5, max: 1.5 }).volMultiple, 1.5, "bounded");
    assert.equal(applyTuning(base, { history: [] }, { min: 0.5, max: 1.5 }).volMultiple, 0.75);
  });

  console.log(`\n${passed} learning tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
