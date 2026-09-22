/**
 * THE LEARNERS, every decision function in src/learn and the pure helpers the backfill reconstructs with.
 *   npx tsx src/scripts/test-learn.ts
 *
 * The rules this file exists to hold, one assertion each:
 *   - the freeze table, to the letter: only the literal "true" freezes
 *   - the calibration is clamped to [0.1, 0.5] and can therefore only ever refuse MORE seats
 *   - a perfect forecast reproduces today's 0.5 exactly (day-one behaviour provably unchanged)
 *   - one bounded step per change, never under the sample, never inside the gap
 *   - a paper lesson never moves the pace factor, and one desk's file never rides into another's
 *   - the pool memory is in [0.25, 1], decays to 1.0 on its own, and never reads netSol
 *   - the quote's drift against SOL is decomposed off the seat's own result
 * The last block is a read-only pass over the real books on this machine, so the numbers the site
 * prints are checked against the files every time the suite runs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { policyEnv } from "../agent/policy";
import type { LedgerRow } from "../engine/ledger";
import { calEnv, calibrationFrom, calibrationStep, ewma, forecastRatio, PACE_SEED_1719_SEP, type Lane } from "../learn/calibration";
import { calibrationFrozen, freezeLine, freezeState, isFrozenValue, learningFrozen, poolsFrozen } from "../learn/freeze";
import { appendLearningChange, applyTuning, endReasonOf, forecastOf, LEARNING_FILE, LEARNING_LOG, LESSONS_FILE, lessonLine, lessonOf, modeOf, quoteDriftOf, readLearningChanges, readLearning, readLessons, writeLearning, tuneEnv, tuneFromLessons, TUNING_FILE, type BandMeta, type LearningChange, type Lesson } from "../learn/lessons";
import { downExit, endSideOf, endSideTally, poolMemoryEnv, poolPenalty } from "../learn/poolMemory";
import { clearLearnedCache, learnedLines, learnedView } from "../learn/view";
import { kindOf, missingBands, reachBins, splitReason } from "./lessons-recompute";

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
    assert.equal(l.mode, "live");
    const rehearsal = lessonOf({ meta, position: "POS", stats: null, rows, closedAt: T0 + 30 * 60_000, endReason: "close", headline: "", mode: "dry-run", ledgerMode: "dry-run" });
    assert.deepEqual([rehearsal.mode, rehearsal.netSol, rehearsal.feesSol], ["dry-run", 0, 0], "a rehearsal reads only its own ledger rows: none here");
  });

  await test("lessonOf: a liquidation that also sells fee tokens earlier seats left in the wallet is shared out by token count (ALLINU, 17 Sep: +0.69 recorded, -0.07 true)", () => {
    const m: BandMeta = { ...meta, pool: "ALLINU", label: "ALLINU/SOL", seatSol: 2.475, bins: 46, binStep: 50 };
    const a = (o: Partial<LedgerRow> & Pick<LedgerRow, "ts" | "mech" | "solDelta">) => row({ pool: "ALLINU", markTokenInSol: 0.00019, ...o });
    const rows = [
      a({ ts: T0, mech: "open", solDelta: -2.475, rentSol: -0.0419 }),
      a({ ts: T0 + 142 * 60_000, mech: "close", solDelta: 0.1589, rentSol: 0.0574, feeSol: 0.3444, tokenDelta: 11652.28326 }),
      // the wallet also held 4,014.89 ALLINU of fee tokens from earlier seats: the swap sold the lot
      a({ ts: T0 + 142 * 60_000 + 3_000, mech: "swap", solDelta: 2.99507, position: null, tokenDelta: -15667.17423 }),
    ];
    const l = lessonOf({ meta: m, position: "POS", stats: null, rows, closedAt: T0 + 142 * 60_000, endReason: "through-band", headline: "" });
    const share = 11652.28326 / 15667.17423;
    near(l.netSol, -2.475 - 0.0419 + 0.1589 + 0.0574 + (2.99507 - 0.000005) * share - 0.000005 * 2, 1e-6, "only the seat's own tokens' share of the swap");
    assert.ok(l.netSol < 0 && l.netSol > -0.1, `a small loss, not a +0.69 win: ${l.netSol}`);
    assert.equal(l.tokensLeftSol, 0);
  });

  await test("lessonOf: tokens the seat handed back and nobody sold count at the close's mark; a re-lay's new seat does not claim the old seat's liquidation; a bought token half is charged to the seat", () => {
    // fee tokens from two collects stay in the wallet unsold; the close returns SOL only
    const unsold = [
      row({ ts: T0, mech: "open", solDelta: -7.5 }),
      row({ ts: T0 + 10 * 60_000, mech: "collect", solDelta: 0.1, feeSol: 0.16, tokenDelta: 2000 }),
      row({ ts: T0 + 20 * 60_000, mech: "close", solDelta: 7.5, feeSol: 0.0, tokenDelta: 1000, markTokenInSol: 0.00004 }),
    ];
    const u = lessonOf({ meta, position: "POS", stats: null, rows: unsold, closedAt: T0 + 20 * 60_000, endReason: "idle", headline: "" });
    near(u.tokensLeftSol ?? 0, 3000 * 0.00004, 1e-9, "3,000 tokens left, at the close's mark");
    near(u.netSol, -7.5 + 0.1 + 7.5 + 3000 * 0.00004 - 0.000005 * 3, 1e-9, "net counts them");
    // a re-lay: the old seat closes and is liquidated seconds before the new seat opens; the new seat's window reaches back over that swap
    const relay = [
      row({ ts: T0 - 5_000, mech: "close", solDelta: 1.0, position: "OLD", tokenDelta: 50_000 }),
      row({ ts: T0 - 3_000, mech: "swap", solDelta: 1.5, position: null, tokenDelta: -50_000 }),
      row({ ts: T0, mech: "open", solDelta: -2.5 }),
      row({ ts: T0 + 30 * 60_000, mech: "close", solDelta: 2.6, feeSol: 0.1 }),
    ];
    const n = lessonOf({ meta, position: "POS", stats: null, rows: relay, closedAt: T0 + 30 * 60_000, endReason: "idle", headline: "" });
    near(n.netSol, -2.5 + 2.6 - 0.000005 * 2, 1e-9, "the old seat's liquidation is not the new seat's money");
    const old = lessonOf({ meta: { ...meta, openedAt: T0 - 3600_000 }, position: "OLD", stats: null, rows: relay, closedAt: T0 - 5_000, endReason: "idle", headline: "" });
    near(old.netSol, 1.0 + 1.5 - 0.000005 * 2, 1e-9, "it is the old seat's");
    // a two-sided open: the token half is bought first, then deposited
    const both = [
      row({ ts: T0 - 4_000, mech: "swap", solDelta: -1.0, position: null, tokenDelta: 30_000 }),
      row({ ts: T0, mech: "open", solDelta: -1.0, tokenDelta: -30_000 }),
      row({ ts: T0 + 60 * 60_000, mech: "close", solDelta: 1.1, tokenDelta: 28_000 }),
      row({ ts: T0 + 60 * 60_000 + 2_000, mech: "swap", solDelta: 0.95, position: null, tokenDelta: -28_000 }),
    ];
    const b = lessonOf({ meta, position: "POS", stats: null, rows: both, closedAt: T0 + 60 * 60_000, endReason: "close", headline: "" });
    near(b.netSol, -1.0 - 1.0 + 1.1 + 0.95 - 0.000005 * 4, 1e-9, "the buy and the sell are both the seat's");
  });

  await test("endReasonOf: the directive first, then the rotation's reason, then the policy's headline", () => {
    assert.equal(endReasonOf("STOP", null, "x"), "stop");
    assert.equal(endReasonOf(null, null, "In range. Fees ticking. Nothing to do.", ["stop-loss: 6jQRGh is 15.2% below entry (7.5000 -> 6.3600 SOL), stop 14.10%; forcing CLOSE"]), "stop", "the guards' stop overrides the proposal's headline");
    assert.equal(endReasonOf("ROTATE", "on the operator's exit list (ROTATE_OUT_POOLS): the book moves on", "x"), "exit-list");
    assert.equal(endReasonOf("ROTATE", "its own flow faded: ...", "x"), "faded");
    assert.equal(endReasonOf("ROTATE", "MRVL earns ... while NVDAx, already held, earns ...", "x"), "consolidated");
    assert.equal(endReasonOf("ROTATE", "MCDx earns ... while DKNG would earn about ...", "x"), "rotated");
    assert.equal(endReasonOf(null, null, "4 bins through the band and 1512s out. Off the table."), "through-band");
    assert.equal(endReasonOf(null, null, "Price ran off the top. Idle 2000s, off the table."), "idle");
    assert.equal(endReasonOf(null, null, "Closing."), "close");
    // the ask exit: the bid band's reason survives the suffix; the ask's own end is "sold" or the engine's
    assert.equal(endReasonOf(null, null, "4 bins through the band and 1512s out. Off the table. Laid as an ask."), "through-band");
    assert.equal(endReasonOf("STOP", null, "Stop hit. Bands off the table. Laid as an ask."), "stop");
    assert.equal(endReasonOf(null, null, "Sold out through the ask. 2.41 SOL back."), "sold");
    assert.equal(endReasonOf("EXPIRE", null, "The ask had its time. Selling what is left."), "expire");
  });

  console.log("tuning");
  const lesson = (label: string, endReason: Lesson["endReason"], minutes: number, inRangePct: number | null, realized: number, at = T0): Lesson => ({
    at, mode: "live", pool: label, label, position: `${label}-${at}`, kind: "memecoin", openedAt: at - minutes * 60_000, closedAt: at, minutes, seatSol: 7.5, bins: 5, binStep: 100, coverPct: 4, travelBins60m: 24, inRangePct, endReason, feesSol: 0.1, netSol: 0, predictedYieldPct: null, realizedYieldPctPerDay: realized, headline: "",
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
    assert.equal(tuneFromLessons([...pricedOut.slice(1), { ...pricedOut[0], ask: true }], { volMultiple: 0.75 }, null, env, now), null, "an ask band's lesson is an exit's, not a seat's: it does not teach the width");
    // only what was learned since the last change counts: after the gap the same five lessons buy nothing more
    const later = now + 7 * 3_600_000;
    const changed = { volMultiple: 1, history: [{ at: now, knob: "volMultiple" as const, from: 0.75, to: 1, why: "" }] };
    assert.equal(tuneFromLessons(pricedOut, { volMultiple: 1 }, changed, env, later), null, "the lessons that bought the first step are older than it");
    const fresh = pricedOut.map((l, i) => ({ ...l, at: now + (i + 1) * 3_600_000 }));
    assert.deepEqual([tuneFromLessons(fresh, { volMultiple: 1 }, changed, env, later)!.from, tuneFromLessons(fresh, { volMultiple: 1 }, changed, env, later)!.to], [1, 1.25], "five new seats, most priced out again: one more step");
    // a stop inside the window is priced out too (a band narrower than the stop goes through it first); a rehearsal's lessons teach nothing live
    const stopped = [lesson("A", "stop", 8, 10, 0), lesson("B", "stop", 20, 10, 0), lesson("C", "through-band", 10, 10, 0), lesson("D", "close", 90, 80, 30), lesson("E", "idle", 200, 5, 1)];
    assert.equal(tuneFromLessons(stopped, { volMultiple: 0.75 }, null, env, now)!.to, 1);
    assert.equal(tuneFromLessons(stopped.map((l) => ({ ...l, mode: "dry-run" })), { volMultiple: 0.75 }, null, env, now), null);
    assert.equal(tuneFromLessons(stopped.map((l) => ({ ...l, mode: "paper" })), { volMultiple: 0.75 }, null, env, now, "paper")!.to, 1, "a paper desk learns from its own");
  });

  await test("applyTuning: the tuned multiple rides beside the configured one, inside the bounds; nothing without a tuning file", () => {
    const base: { volMultiple: number; tunedVolMultiple?: number; other: number } = { volMultiple: 0.75, other: 1 };
    assert.deepEqual(applyTuning(base, null, { min: 0.5, max: 1.5 }), base);
    const t = applyTuning(base, { volMultiple: 1.25, history: [] }, { min: 0.5, max: 1.5 });
    assert.deepEqual([t.volMultiple, t.tunedVolMultiple], [0.75, 1.25], "the env's multiple stays for stock pools; the tuned one is for the rest");
    assert.equal(applyTuning(base, { volMultiple: 9, history: [] }, { min: 0.5, max: 1.5 }).tunedVolMultiple, 1.5, "bounded");
    assert.equal(applyTuning(base, { history: [] }, { min: 0.5, max: 1.5 }).tunedVolMultiple, undefined);
  });

  await runLearners();
  console.log(`\n${passed} learning tests passed`);
}

/* ================= the learners ================= */

const LES = (o: Partial<Lesson> & Pick<Lesson, "at">): Lesson => ({
  mode: "live", pool: "POOL", label: "X/SOL", position: `p-${o.at}-${Math.random().toString(36).slice(2, 7)}`, kind: "memecoin", openedAt: o.at - 60 * 60_000, closedAt: o.at,
  minutes: 60, seatSol: 10, bins: 9, binStep: 50, coverPct: 4, travelBins60m: null, inRangePct: 50, endReason: "close", feesSol: 0.1, netSol: 0.05,
  predictedYieldPct: 100, realizedYieldPctPerDay: 50, headline: "", ...o,
});

const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "mrbands-learn-"));

async function runLearners(): Promise<void> {
  const NOW = Date.parse("2026-09-22T06:00:00Z");
  const H = 3_600_000;

  console.log("\nfreeze");
  await test("learningFrozen: only the literal \"true\" freezes; \"1\", \"yes\", \"on\" and a typo leave learning running", () => {
    for (const v of ["true", "TRUE", " True ", "\ttrue\n"]) assert.equal(isFrozenValue(v), true, `${JSON.stringify(v)} should freeze`);
    for (const v of [undefined, "", " ", "1", "yes", "on", "y", "false", "no", "0", "ture", "true "]) assert.equal(isFrozenValue(v as string | undefined), ["true "].includes(v as string), `${JSON.stringify(v)} should not freeze`);
    assert.equal(learningFrozen({}), false, "unset is not frozen: a switch that turns itself on by accident is as bad as one that turns itself off");
    assert.equal(learningFrozen({ LEARN_FROZEN: "1" }), false);
    assert.equal(learningFrozen({ LEARN_FROZEN: "true" }), true);
    // per knob, and the blanket switch covers both
    assert.deepEqual([calibrationFrozen({}), poolsFrozen({})], [false, false]);
    assert.deepEqual([calibrationFrozen({ LEARN_FROZEN_CALIBRATION: "true" }), poolsFrozen({ LEARN_FROZEN_CALIBRATION: "true" })], [true, false]);
    assert.deepEqual([calibrationFrozen({ LEARN_FROZEN_POOLS: "true" }), poolsFrozen({ LEARN_FROZEN_POOLS: "true" })], [false, true]);
    assert.deepEqual([calibrationFrozen({ LEARN_FROZEN: "true" }), poolsFrozen({ LEARN_FROZEN: "true" })], [true, true]);
    assert.deepEqual(freezeState({ LEARN_FROZEN_POOLS: "true" }), { all: false, calibration: false, pools: true });
    assert.match(freezeLine(freezeState({ LEARN_FROZEN: "true" })), /^learning frozen \(LEARN_FROZEN=true\)/);
    assert.equal(freezeLine(freezeState({})), "learning on");
    assert.match(freezeLine(freezeState({ LEARN_FROZEN_POOLS: "true" })), /pool memory is frozen/);
  });

  console.log("\nthe quote's drift");
  await test("quoteDriftOf: a USDC seat's SOL/USD move is taken off the seat's own result; a SOL seat has none (AMD/USDC, 18 Sep: -6.014 SOL of which -6.346 was drift)", () => {
    const usdc = (o: Partial<LedgerRow> & Pick<LedgerRow, "ts" | "mech" | "solDelta">): LedgerRow => row({ quoteMint: "USDC", markQuoteInSol: 0.0086, ...o });
    const rows = [
      usdc({ ts: T0, mech: "open", solDelta: -22, markQuoteInSol: 0.0086 }),
      usdc({ ts: T0 + 60 * 60_000, mech: "close", solDelta: 16.2, markQuoteInSol: 0.0074 }),
    ];
    const drift = quoteDriftOf(rows, 22)!;
    near(drift, 22 * (0.0074 / 0.0086 - 1), 1e-5, "the seat is booked in SOL and SOL moved under it");
    assert.ok(drift < 0, "SOL up against USDC reads as a loss the seat never made");
    const l = lessonOf({ meta: { ...meta, seatSol: 22 }, position: "POS", stats: null, rows, closedAt: T0 + 60 * 60_000, endReason: "stop", headline: "" });
    near(l.netSolExDrift!, l.netSol - drift, 1e-6, "netSolExDrift is what the seat itself did");
    assert.ok(l.netSol < l.netSolExDrift!, "the drift was the loss, not the seat");
    // a SOL pool marks its quote at 1 at both ends
    assert.equal(quoteDriftOf([row({ ts: T0, mech: "open", solDelta: -10, markQuoteInSol: 1 }), row({ ts: T0 + 60_000, mech: "close", solDelta: 10, markQuoteInSol: 1 })], 10), null);
    assert.equal(quoteDriftOf([row({ ts: T0, mech: "open", solDelta: -10 })], 10), null, "no close, no drift");
    assert.equal(lessonOf({ meta, position: "POS", stats: null, rows: [row({ ts: T0, mech: "open", solDelta: -7.5 }), row({ ts: T0 + 60_000, mech: "close", solDelta: 7.5 })], closedAt: T0 + 60_000, endReason: "close", headline: "" }).quoteDriftSol, null);
  });

  console.log("\ncalibration");
  await test("calibrationFrom: the product is clamped to [0.1, 0.5], so a calibrated desk never prices a seat above what the shipped code already does", () => {
    const env = calEnv({});
    assert.deepEqual([env.base, env.min, env.max, env.step, env.minSample, env.paceSeed], [0.5, 0.1, 0.5, 0.05, 20, PACE_SEED_1719_SEP]);
    // a book that never left the band and always paid what was forecast: the ceiling, which is today's number
    const perfect = Array.from({ length: 25 }, (_, i) => LES({ at: NOW - i * H, inRangePct: 100, predictedYieldPct: 100, realizedYieldPctPerDay: 100, entryYieldFactor: 0.5 }));
    const c = calibrationFrom(perfect, env, NOW, "live");
    assert.deepEqual([c.memecoin.inRangeFactor, c.memecoin.paceFactor, c.memecoin.combined], [1, 0.5, 0.5], "GOLDEN: a perfect forecast reproduces the shipped 0.5 exactly");
    assert.equal(c.memecoin.weak, false);
    // a book that spent half its life out of range and paid a third of the forecast while in it
    const poor = Array.from({ length: 25 }, (_, i) => LES({ at: NOW - i * H, inRangePct: 50, predictedYieldPct: 120, realizedYieldPctPerDay: 20, entryYieldFactor: 0.5 }));
    const p = calibrationFrom(poor, env, NOW, "live");
    near(p.memecoin.inRangeFactor, 0.5, 1e-9);
    assert.ok(p.memecoin.combined < 0.5 && p.memecoin.combined >= 0.1, `${p.memecoin.combined} inside the clamp and under the ceiling`);
    // nothing, however good, gets above the ceiling
    const wild = Array.from({ length: 30 }, (_, i) => LES({ at: NOW - i * H, inRangePct: 100, predictedYieldPct: 1, realizedYieldPctPerDay: 900, entryYieldFactor: 0.5 }));
    assert.equal(calibrationFrom(wild, env, NOW, "live").memecoin.combined, 0.5, "a forecast that was far too LOW still cannot buy a bigger seat than the shipped code allows");
    // nothing, however bad, gets under the floor
    const awful = Array.from({ length: 30 }, (_, i) => LES({ at: NOW - i * H, inRangePct: 1, predictedYieldPct: 900, realizedYieldPctPerDay: 0, entryYieldFactor: 0.5 }));
    assert.equal(calibrationFrom(awful, env, NOW, "live").memecoin.combined, 0.1, "and the floor holds too");
    for (const l of [c, p, calibrationFrom(wild, env, NOW, "live"), calibrationFrom(awful, env, NOW, "live")]) {
      for (const lane of ["memecoin", "stock"] as Lane[]) {
        assert.ok(l[lane].combined <= 0.5 && l[lane].combined >= 0.1, `${lane} ${l[lane].combined} inside [0.1, 0.5]`);
        assert.ok(l[lane].inRangeFactor <= 1 && l[lane].inRangeFactor >= 0.25, "the in-range half is bounded too");
        assert.ok(l[lane].paceFactor <= 1 && l[lane].paceFactor >= 0.2, "and the pace half");
      }
    }
  });

  await test("calibrationFrom: a paper lesson never moves the pace factor, because a paper desk's fees come out of the same formula as the forecast", () => {
    const env = calEnv({});
    const paper = Array.from({ length: 25 }, (_, i) => LES({ at: NOW - i * H, mode: "paper", inRangePct: 80, predictedYieldPct: 100, realizedYieldPctPerDay: 500 }));
    const c = calibrationFrom(paper, env, NOW, "paper");
    assert.equal(c.memecoin.paceFactor, PACE_SEED_1719_SEP, "the seed, whatever the paper book claims to have earned");
    assert.equal(c.memecoin.paceSource, "seed");
    assert.equal(c.memecoin.paceN, 0, "no paper lesson votes on the pace");
    near(c.memecoin.inRangeFactor, 0.8, 1e-9, "where the price went IS a fact the paper book did not invent, so the in-range half learns");
    assert.match(c.memecoin.why, /frozen while the book is paper/);
    // and a live book's lessons do not teach the paper desk either: the lane is read in the desk's own mode
    assert.equal(calibrationFrom(paper.map((l) => ({ ...l, mode: "live" })), env, NOW, "paper").memecoin.n, 0);
  });

  await test("calibrationFrom: the EWMA decays, a stock lesson never teaches the memecoin lane, and an ask band teaches neither", () => {
    const env = calEnv({});
    // one recent seat and one a fortnight old: the recent one carries the read
    const mixed = [LES({ at: NOW - 14 * 24 * H, inRangePct: 100 }), LES({ at: NOW, inRangePct: 0 })];
    const f = calibrationFrom(mixed, env, NOW, "live").memecoin.inRangeFactor;
    assert.ok(f < 0.3, `old evidence stops voting on its own: ${f}`);
    assert.equal(calibrationFrom([LES({ at: NOW, kind: "stock", inRangePct: 90 })], env, NOW, "live").memecoin.n, 0);
    assert.equal(calibrationFrom([LES({ at: NOW, kind: "stock", inRangePct: 90 })], env, NOW, "live").stock.n, 1);
    assert.equal(calibrationFrom([LES({ at: NOW, ask: true, inRangePct: 90 })], env, NOW, "live").memecoin.n, 0, "an ask band is an exit, not a seat he chose");
    assert.equal(calibrationFrom([LES({ at: NOW + H, inRangePct: 0 })], env, NOW, "live").memecoin.n, 0, "a seat that closes after the moment being read has not happened yet");
    assert.equal(ewma([], NOW, 100), null);
    near(ewma([{ at: NOW, v: 1 }, { at: NOW, v: 0 }], NOW, H)!, 0.5, 1e-9);
  });

  await test("calibrationStep: one bounded step, never under the sample, never inside the gap, and it stops when it gets there", () => {
    const env = calEnv({});
    const poor = Array.from({ length: 25 }, (_, i) => LES({ at: NOW - i * H, inRangePct: 40, predictedYieldPct: 100, realizedYieldPctPerDay: 10, entryYieldFactor: 0.5 }));
    const cal = calibrationFrom(poor, env, NOW, "live").memecoin;
    assert.ok(cal.combined < 0.3, `the seats argue for ${cal.combined}`);
    const first = calibrationStep({ current: 0.5, cal, env, last: null, now: NOW, mode: "live" });
    assert.deepEqual([first.change!.knob, first.change!.lane, first.change!.from, first.change!.to], ["calibration", "memecoin", 0.5, 0.45], "one step of 0.05, not the whole way");
    assert.equal(first.change!.mode, "live");
    assert.equal(first.change!.n, 25);
    assert.match(first.change!.why, /25 closed memecoin seats on the live book sat in range 40%/);
    assert.match(first.change!.why, /Marking the forecast down one step, 0.5 -> 0.45/);
    // the gap
    const inGap: LearningChange = { at: NOW - 60 * 60_000, mode: "live", knob: "calibration", lane: "memecoin", from: 0.5, to: 0.45, why: "", n: 25, windowH: 168 };
    assert.equal(calibrationStep({ current: 0.45, cal, env, last: inGap, now: NOW, mode: "live" }).change, null, "an hour after the last step, inside the six-hour gap");
    assert.match(calibrationStep({ current: 0.45, cal, env, last: inGap, now: NOW, mode: "live" }).held!, /min of the 360 min gap left/);
    assert.ok(calibrationStep({ current: 0.45, cal, env, last: { ...inGap, at: NOW - 7 * H }, now: NOW, mode: "live" }).change, "after the gap it may move again");
    // the sample
    const thin = calibrationFrom(poor.slice(0, 5), env, NOW, "live").memecoin;
    assert.equal(thin.weak, true);
    assert.equal(calibrationStep({ current: 0.5, cal: thin, env, last: null, now: NOW, mode: "live" }).change, null);
    assert.match(calibrationStep({ current: 0.5, cal: thin, env, last: null, now: NOW, mode: "live" }).held!, /5 closed seats, under the 20 a change needs/);
    // it converges and then stops: walk it down one step at a time
    let f = 0.5;
    const seen: number[] = [f];
    for (let i = 0; i < 40; i++) {
      const d = calibrationStep({ current: f, cal, env, last: null, now: NOW, mode: "live" });
      if (!d.change) break;
      assert.ok(Math.abs(d.change.to - f) <= env.step + 1e-9, "never more than one step");
      f = d.change.to;
      seen.push(f);
    }
    assert.ok(seen.length > 2 && seen.length < 20, `it walks there: ${seen.join(" -> ")}`);
    assert.ok(seen.every((v, i) => i === 0 || v <= seen[i - 1]), "monotone, never a step back up on the same evidence");
    near(f, cal.combined, env.step, "it lands on what the seats argue for and holds");
    assert.match(calibrationStep({ current: f, cal, env, last: null, now: NOW, mode: "live" }).held!, /already what the seats argue for/);
  });

  await test("PROPERTY: a calibrated factor only ever refuses MORE seats than the shipped one, never fewer (200 random books)", () => {
    const env = calEnv({});
    // the shipped gate: seat yield scales linearly in the factor, and a seat under the floor is refused
    const takes = (factor: number, poolFeesUsd: number, sharePct: number, seatUsd: number, floorPct: number): boolean => (((poolFeesUsd * (sharePct / 100) * factor) / seatUsd) * 100) >= floorPct;
    let rnd = 20260922;
    const next = (): number => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
    let refusedMore = 0;
    for (let t = 0; t < 200; t++) {
      const n = 20 + Math.floor(next() * 30);
      const book = Array.from({ length: n }, (_, i) => LES({ at: NOW - i * H, inRangePct: Math.round(next() * 100), predictedYieldPct: 1 + next() * 400, realizedYieldPctPerDay: next() * 400, entryYieldFactor: 0.5 }));
      const cal = calibrationFrom(book, env, NOW, "live").memecoin;
      assert.ok(cal.combined <= env.base + 1e-12, `${cal.combined} is never above the shipped ${env.base}`);
      assert.ok(cal.combined >= env.min - 1e-12);
      const factor = cal.weak ? env.base : cal.combined;
      const poolFeesUsd = 100 + next() * 100_000;
      const sharePct = 1 + next() * 49;
      const seatUsd = 100 + next() * 10_000;
      // a floor drawn around the yield the shipped factor would show, so the two answers can differ
      const yieldAtBase = ((poolFeesUsd * (sharePct / 100) * env.base) / seatUsd) * 100;
      const floorPct = yieldAtBase * (0.3 + next() * 1.2);
      const before = takes(env.base, poolFeesUsd, sharePct, seatUsd, floorPct);
      const after = takes(factor, poolFeesUsd, sharePct, seatUsd, floorPct);
      assert.ok(!(after && !before), "a calibrated desk never takes a seat the shipped code would have refused");
      if (before && !after) refusedMore++;
    }
    assert.ok(refusedMore > 0, "and on this evidence it does refuse some it would have taken");
  });

  console.log("\nthe pool memory");
  await test("poolPenalty: a down exit shrinks the seat and lengthens the sit-out, in [0.25, 1], capped, and it decays back on its own", () => {
    const env = poolMemoryEnv({ METEORA_STOCK_REENTRY_MIN: "60" });
    assert.deepEqual([env.minSeats, env.windowMs / H, env.baseSitOutMin, env.sitOutMaxMin], [3, 48, 60, 240]);
    assert.equal(downExit(LES({ at: NOW, endReason: "through-band" })), true);
    assert.equal(downExit(LES({ at: NOW, endReason: "stop" })), true);
    assert.equal(downExit(LES({ at: NOW, endReason: "idle" })), false, "off the TOP is the side that made money");
    assert.deepEqual([endSideOf(LES({ at: NOW, endReason: "idle" })), endSideOf(LES({ at: NOW, endReason: "stop" })), endSideOf(LES({ at: NOW, endReason: "rotated" }))], ["up", "down", "other"]);
    const clean = [1, 2, 3, 4].map((i) => LES({ at: NOW - i * H, endReason: "idle" }));
    assert.deepEqual([poolPenalty(clean, "POOL", "live", NOW, env).sizeMultiple, poolPenalty(clean, "POOL", "live", NOW, env).sitOutMin], [1, 0], "a clean pool is untouched: exactly today's behaviour");
    // under the sample nothing happens, however bad it looks
    const two = [LES({ at: NOW - H, endReason: "stop" }), LES({ at: NOW - 2 * H, endReason: "through-band" })];
    assert.deepEqual([poolPenalty(two, "POOL", "live", NOW, env).sizeMultiple, poolPenalty(two, "POOL", "live", NOW, env).sitOutMin], [1, 0]);
    assert.match(poolPenalty(two, "POOL", "live", NOW, env).why, /under the 3 the memory needs/);
    // one down exit in the window
    const one = [LES({ at: NOW - H, endReason: "through-band" }), ...clean.slice(0, 3)];
    const p1 = poolPenalty(one, "POOL", "live", NOW, env);
    assert.deepEqual([p1.sizeMultiple, p1.sitOutMin, p1.down], [0.5, 120, 1]);
    // two or more
    const p2 = poolPenalty([LES({ at: NOW - H, endReason: "through-band" }), LES({ at: NOW - 2 * H, endReason: "stop" }), ...clean.slice(0, 2)], "POOL", "live", NOW, env);
    assert.deepEqual([p2.sizeMultiple, p2.sitOutMin, p2.down], [0.25, 240, 2]);
    assert.match(p2.why, /went down through the band or hit the stop inside 48h/);
    assert.match(p2.why, /Down seats have never come back on this book/);
    // the cap
    assert.equal(poolPenalty([LES({ at: NOW - H, endReason: "stop" }), LES({ at: NOW - 2 * H, endReason: "stop" }), ...clean.slice(0, 2)], "POOL", "live", NOW, poolMemoryEnv({ METEORA_STOCK_REENTRY_MIN: "600" })).sitOutMin, 240, "never more sit-out than the cap");
    // the decay: the same seats, three days later
    const later = NOW + 72 * H;
    const p3 = poolPenalty([LES({ at: NOW - H, endReason: "through-band" }), LES({ at: NOW - 2 * H, endReason: "stop" }), ...clean.slice(0, 2)], "POOL", "live", later, env);
    assert.deepEqual([p3.sizeMultiple, p3.sitOutMin], [1, 0], "the window empties and the pool is forgiven with no second decision");
    // another pool's seats, and another desk's, are not this one's
    assert.equal(poolPenalty(one.map((l) => ({ ...l, pool: "OTHER" })), "POOL", "live", NOW, env).sizeMultiple, 1);
    assert.equal(poolPenalty(one.map((l) => ({ ...l, mode: "paper" })), "POOL", "live", NOW, env).sizeMultiple, 1);
    assert.equal(poolPenalty(one.map((l) => ({ ...l, ask: true })), "POOL", "live", NOW, env).sizeMultiple, 1);
  });

  await test("poolPenalty NEVER reads netSol: -8.479 SOL of SOL/USD drift sits inside the paper book's USDC seats and must not teach him anything", () => {
    const env = poolMemoryEnv({ METEORA_STOCK_REENTRY_MIN: "60" });
    const seats = [LES({ at: NOW - H, endReason: "through-band" }), LES({ at: NOW - 2 * H, endReason: "stop" }), LES({ at: NOW - 3 * H, endReason: "idle" })];
    const a = poolPenalty(seats, "POOL", "live", NOW, env);
    const b = poolPenalty(seats.map((l) => ({ ...l, netSol: -999, netSolExDrift: 999, feesSol: 0 })), "POOL", "live", NOW, env);
    assert.deepEqual([a.sizeMultiple, a.sitOutMin], [b.sizeMultiple, b.sitOutMin], "the money changed by a thousand SOL and the memory did not move");
    // the end side is what it reads, and the drift cannot fake that
    const tally = endSideTally([...seats, LES({ at: NOW, endReason: "idle", netSol: -6.014, netSolExDrift: 0.332 })]);
    const up = tally.find((t) => t.side === "up")!;
    assert.equal(up.n, 2);
    near(up.net, 0.05 + 0.332, 1e-9, "the table reports the seat's own result, drift taken out");
    assert.equal(up.winners, 2, "AMD/USDC was a winner ex-drift, with the price 48 bins ABOVE the band");
  });

  console.log("\nthe files: one desk's numbers never ride into another's");
  await test("applyTuning and readLearning refuse a file stamped for another desk", () => {
    const base: { volMultiple: number; tunedVolMultiple?: number } = { volMultiple: 0.75 };
    const bounds = { min: 0.5, max: 1.5 };
    assert.equal(applyTuning(base, { volMultiple: 1.25, mode: "paper", history: [] }, bounds, "live").tunedVolMultiple, undefined, "a paper-learned width never rides into the live desk");
    assert.equal(applyTuning(base, { volMultiple: 1.25, mode: "live", history: [] }, bounds, "paper").tunedVolMultiple, undefined, "and not the other way either");
    assert.equal(applyTuning(base, { volMultiple: 1.25, mode: "live", history: [] }, bounds, "live").tunedVolMultiple, 1.25);
    assert.equal(applyTuning(base, { volMultiple: 1.25, history: [] }, bounds, "live").tunedVolMultiple, 1.25, "a file written before modes existed is still read: it predates the leak, and the bounds still hold");
    assert.equal(applyTuning(base, { volMultiple: 1.25, mode: "paper", history: [] }, bounds).tunedVolMultiple, 1.25, "a caller that names no mode gets the old behaviour");
    assert.deepEqual([modeOf(null), modeOf({}), modeOf({ mode: " " }), modeOf({ mode: "paper" })], [null, null, null, "paper"]);
  });

  await test("the retired width tuner reaches no decision unless LEARN_WIDTH_TUNING is the literal \"true\"", () => {
    const dir = tmpDir();
    const file = path.join(dir, TUNING_FILE);
    // a width a human never journalled, in the file the live desk's env still names
    fs.writeFileSync(file, JSON.stringify({ volMultiple: 1.4, mode: "live", history: [] }));
    const env = { TUNING_FILE: file, DRY_RUN: "true", LEARN_FILE: path.join(dir, "no-such-learning.json") } as NodeJS.ProcessEnv;
    assert.equal(policyEnv(env).tunedVolMultiple, undefined, "TUNING_FILE alone changes nothing: no journal, no sample, no step, no freeze");
    assert.equal(policyEnv({ ...env, LEARN_WIDTH_TUNING: "1" }).tunedVolMultiple, undefined, "and only the literal true turns it on, like every other switch here");
    assert.equal(policyEnv({ ...env, LEARN_WIDTH_TUNING: "true" }).tunedVolMultiple, 1.4, "asked for by name, it is read, and its bounds still hold");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("the journal: a change is a row with its evidence, the state is mode-stamped, and a paper desk cannot read a live file", () => {
    const dir = tmpDir();
    const log = path.join(dir, LEARNING_LOG);
    const state = path.join(dir, LEARNING_FILE);
    assert.deepEqual(readLearningChanges(log), [], "no journal yet is not an error");
    assert.equal(readLearning(state, "paper"), null);
    const c: LearningChange = { at: NOW, mode: "paper", knob: "calibration", lane: "memecoin", from: 0.5, to: 0.45, why: "21 closed memecoin seats sat in range 40% of their lives", n: 21, windowH: 168 };
    appendLearningChange(log, c);
    appendLearningChange(log, { ...c, at: NOW + H, from: 0.45, to: 0.4 });
    fs.appendFileSync(log, "not json\n");
    const back = readLearningChanges(log);
    assert.equal(back.length, 2, "a torn line is skipped, the rest still read");
    assert.deepEqual(back[0], c);
    assert.equal(readLearningChanges(log, NOW + 1).length, 1, "and an as-of read sees only what had happened by then");
    writeLearning(state, { mode: "paper", updatedAt: NOW, calibration: { memecoin: { lane: "memecoin", factor: 0.13, n: 21, at: NOW, why: c.why } }, pools: {} });
    assert.equal(readLearning(state, "paper")!.calibration.memecoin!.factor, 0.13, "the desk's own reader is the only one, so the page cannot read a shape the desk never writes");
    assert.equal(readLearning(state, "live"), null, "the live desk does not read the paper desk's factor");
    assert.equal(readLearning(state, "paper")!.mode, "paper", "the mode is on the file to say whose numbers these are");
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0, "the write is atomic: no temp file left behind");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log("\nthe backfill");
  await test("the backfill's pure parts: the directive that closed a band, the lane from the MINT not the ticker, the band's own reach, and idempotency", () => {
    assert.deepEqual(splitReason("STOP: stop: paper- is 13.7% below entry (28.2795 -> 24.4057 SOL), stop 12.09%"), { kind: "STOP", rotate: null, headline: "stop: paper- is 13.7% below entry (28.2795 -> 24.4057 SOL), stop 12.09%" });
    assert.equal(splitReason("ROTATE: its own flow faded: nothing for 40 min").rotate, "its own flow faded: nothing for 40 min");
    assert.equal(endReasonOf(...(({ kind, rotate, headline }) => [kind, rotate, headline] as const)(splitReason("ROTATE: its own flow faded: x"))), "faded");
    assert.equal(splitReason("12 bins through the band and 1512s out. Off the table.").kind, null);
    assert.equal(endReasonOf(null, null, splitReason("12 bins through the band and 1512s out. Off the table.").headline), "through-band");
    assert.equal(splitReason("EXPIRE: launch band paper-: the pool's last hour traded $0").kind, "EXPIRE");
    // the lane: a pump.fun token called GOOGL is not a tokenized stock, and the mint is what says so
    const stockMints = new Set(["XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX"]);
    assert.equal(kindOf("pair-8YZ", "8YZNvtFBgxThktBPEKRVihxTSE19RKVzvFAAAcfX5EVk", new Set(), stockMints), "other", "the pump token named GOOGL");
    assert.equal(kindOf("pair-Xsp", "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX", new Set(), stockMints), "stock", "MSFTx, by its mint");
    assert.equal(kindOf("REAL", null, new Set(["REAL"]), stockMints), "stock", "the screen says the pool is a stock pool");
    assert.equal(kindOf("REAL", "somememecoin", new Set(), stockMints), "memecoin");
    // the reach: the band's own shape, never where the price ended up
    assert.deepEqual([reachBins(9, "BOTH"), reachBins(9, "SOL_ONLY"), reachBins(5, "BOTH"), reachBins(1, "BOTH")], [4, 8, 2, 1]);
    // idempotency: a band with a lesson is never written twice, and the desk's own lesson always wins
    const closed = [{ address: "a", closedAt: 3 }, { address: "b", closedAt: 1 }, { address: "c", closedAt: 2 }];
    assert.deepEqual(missingBands(closed, []).map((b) => b.address), ["b", "c", "a"], "oldest first, so the file stays in timestamp order");
    assert.deepEqual(missingBands(closed, [{ position: "b" }]).map((b) => b.address), ["c", "a"]);
    assert.deepEqual(missingBands(closed, closed.map((b) => ({ position: b.address }))), [], "a second run writes nothing");
  });

  console.log("\nthe view the four surfaces read");
  await test("learnedView: the factor in force, what bought it, the freeze, the caveats, and never a claim the code cannot back", () => {
    const dir = tmpDir();
    const lessons = Array.from({ length: 25 }, (_, i) => LES({ at: NOW - i * H, mode: "paper", inRangePct: 40, predictedYieldPct: 100, realizedYieldPctPerDay: 10 }));
    fs.writeFileSync(path.join(dir, LESSONS_FILE), lessons.map((l) => JSON.stringify(l)).join("\n") + "\n");
    clearLearnedCache();
    const v = learnedView(dir, "paper", "POOL", {}, NOW, 0);
    assert.equal(v.mode, "paper");
    assert.equal(v.base, 0.5);
    assert.equal(v.lessonsTotal, 25);
    const meme = v.lanes.find((l) => l.lane === "memecoin")!;
    assert.equal(meme.inForce, 0.5, "nothing has been applied yet, so the shipped number is what is in force");
    assert.ok(meme.target !== null && meme.target < 0.5, "and the seats already argue for less");
    assert.equal(meme.evidence!.paceSource, "seed", "the in-range second opinion borrows the 17-19 Sep pace and says so");
    assert.ok(meme.evidence!.combined < 0.5);
    assert.equal(v.changes.length, 0);
    assert.equal(v.pool!.seats.length, 5, "the last five closes of the pool asked for");
    assert.equal(v.frozen.all, false);
    assert.match(v.caveats[0], /model is not switched on yet/);
    assert.match(v.caveats[1], /paper book/);
    assert.match(v.caveats[2], /never raise or loosen a limit/);
    assert.match(caveatOf(v, 42), /42% of his calls came from his model/);
    clearLearnedCache();
    assert.equal(learnedView(dir, "paper", "POOL", { LEARN_FROZEN: "true" }, NOW, 0).frozen.all, true);
    const lines = learnedLines(v);
    assert.ok(lines.some((l) => l.includes("learning on")), lines.join("\n"));
    assert.ok(lines.some((l) => l.includes("no change has been made yet")), "an empty history says so rather than showing nothing");
    assert.ok(lines.some((l) => /ended down/.test(l)));
    clearLearnedCache();
    assert.equal(learnedView(dir, "live", undefined, {}, NOW, 0).lessonsTotal, 0, "the live surface shows no paper seat");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log("\nthe real books on this machine");
  await test("SMOKE, read only: the numbers the page would print are recomputed from data-mainnet and data-live and match the run", () => {
    // the books are not in git, so they are only here on a machine that has traded. LEARN_SMOKE_DIRS
    // points the pass at another checkout's data dirs ("<mainnet>,<paper>").
    const named = (process.env.LEARN_SMOKE_DIRS ?? "").split(",").map((d) => d.trim()).filter(Boolean);
    const repo = process.cwd();
    const mainnet = named[0] ?? path.join(repo, "data-mainnet");
    const paper = named[1] ?? path.join(repo, "data-live");
    if (!fs.existsSync(path.join(mainnet, LESSONS_FILE))) {
      console.log("      (no data-mainnet on this machine: skipped)");
      return;
    }
    const lessons = readLessons(path.join(mainnet, LESSONS_FILE)).filter((l) => (l.mode ?? "live") === "live");
    assert.ok(lessons.length >= 55, `${lessons.length} live lessons on the 17-19 Sep run`);
    const ratio = forecastRatio(lessons, 20, "live");
    assert.equal(ratio.n, 52, "52 of the run's seats carried a forecast");
    assert.ok(ratio.median !== null && ratio.median > 0.35 && ratio.median < 0.45, `the median came in at ${ratio.median} of forecast`);
    assert.equal(ratio.tooHigh, 48, "48 of 52 were forecast too high");
    const sides = endSideTally(lessons);
    const up = sides.find((s) => s.side === "up")!;
    const down = sides.find((s) => s.side === "down")!;
    assert.deepEqual([up.n, up.winners], [38, 29], "38 seats ended off the top, 29 of them winners");
    near(up.net, 4.311, 0.002, "+4.311 SOL on the up side");
    assert.deepEqual([down.n, down.winners], [7, 0], "7 went down through the band or hit the stop, and not one came back");
    near(down.net, -2.401, 0.002, "-2.401 SOL on the down side");
    // every lesson on both books survives the learners without an exception or a number out of bounds
    const env = calEnv({});
    for (const [dir, mode] of [[mainnet, "live"], [paper, "paper"]] as const) {
      if (!fs.existsSync(path.join(dir, LESSONS_FILE))) continue;
      const all = readLessons(path.join(dir, LESSONS_FILE));
      const cal = calibrationFrom(all, env, Date.now(), mode);
      for (const lane of ["memecoin", "stock"] as Lane[]) {
        assert.ok(cal[lane].combined <= 0.5 && cal[lane].combined >= 0.1, `${dir} ${lane}: ${cal[lane].combined}`);
        assert.ok(Number.isFinite(cal[lane].inRangeFactor) && Number.isFinite(cal[lane].paceFactor));
      }
      for (const l of all) {
        const f = forecastOf(l);
        assert.ok(f === null || f.pct > 0);
        const p = poolPenalty(all, l.pool, mode, Date.now(), poolMemoryEnv({}));
        assert.ok(p.sizeMultiple <= 1 && p.sizeMultiple >= 0.25, `${l.label}: ${p.sizeMultiple}`);
        assert.ok(p.sitOutMin >= 0 && p.sitOutMin <= 240);
      }
      clearLearnedCache();
      assert.ok(learnedLines(learnedView(dir, mode, undefined, {}, Date.now(), 0)).length > 5);
    }
  });
}

/** the caveat a surface would print at a given model share, without rebuilding the whole view */
const caveatOf = (v: { caveats: string[] }, llmShare: number): string => (llmShare > 0 ? `${Math.round(llmShare)}% of his calls came from his model; these knobs are his rulebook's either way.` : v.caveats[0]);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
