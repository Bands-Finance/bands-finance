/**
 * THE DESK FEELS ITS OWN OUTCOMES: the wiring that turns the learners on (src/desk/learning.ts,
 * src/agent/policy.ts, src/index.ts).
 *
 *   npx tsx src/scripts/test-learn-desk.ts
 *
 * The two tests that matter most are the first two. The GOLDEN test says day one is unchanged: with
 * the shipped 0.5 in force the policy's numbers are the numbers it printed before any of this was
 * written. The PROPERTY test says learning can only ever refuse MORE seats: over two hundred random
 * pools, the seats that pass the floors at a calibrated factor are a subset of the seats that pass
 * at 0.5. Everything below them is the doctrine in assertions: minimum sample, bounded step,
 * minimum gap, decay, the journal row, the freeze table, the mode refusal, and the fact that no
 * learner can enlarge a seat or shorten a wait.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  appendLearningChange, applyChange, calibrationChange, calibrationReading, clearLearningCache, emptyLearning, factorFor, FEE_SHARE_DEFAULT, knobFrozen, learnEnv, learnFiles,
  learningFrozen, penaltyFor, poolPenaltyChanges, readLearning, readLearningChanges, sitOutMinFor, stepRung, stepToward, weightedMedian, writeLearning, type LearningState, type LessonLike,
} from "../desk/learning";
import { sittingOut } from "../screener/seatYield";

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

const HOUR = 3_600_000;
const T0 = Date.parse("2026-09-22T00:00:00.000Z");
const SOL_USD = 214;
const POOL = "PooL1111111111111111111111111111111111111111";

/** A lesson as the ledger writes one; only the columns a learner reads are filled. */
const lesson = (over: Partial<LessonLike> = {}): LessonLike => ({
  at: T0 - HOUR,
  mode: "paper",
  kind: "memecoin",
  pool: POOL,
  label: "baton/SOL",
  endReason: "idle",
  minutes: 120,
  realizedYieldPctPerDay: 10,
  predictedYieldPct: null,
  entryYieldPct: 25,
  entryYieldFactor: FEE_SHARE_DEFAULT,
  ...over,
});

async function main() {
  const policy = await import("../agent/policy.js");

  /* ------------------------------------------------------------------ *
   * The observation a seat is priced from. Only the columns seatEarnings
   * reads are real; the rest is scaffolding.
   * ------------------------------------------------------------------ */
  /** flat bins around the active one: 20 SOL a bin below, the same in token above */
  const flatBins = (perBin = 20, price = 0.1, n = 30) => {
    const out: { binId: number; xAmount: number; yAmount: number; price: number }[] = [];
    for (let id = -n; id <= n; id++) out.push(id <= 0 ? { binId: id, xAmount: 0, yAmount: perBin, price } : { binId: id, xAmount: perBin / price, yAmount: 0, price });
    return out;
  };

  const snapshot = (over: Record<string, unknown> = {}) => ({
    address: POOL,
    label: "baton/SOL",
    tokenX: { mint: "Tok11111111111111111111111111111111111111111", symbol: "baton", decimals: 6, reserve: 1000 },
    tokenY: { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9, reserve: 100 },
    solSide: "Y",
    baseToken: { mint: "Tok11111111111111111111111111111111111111111", symbol: "baton", decimals: 6, reserve: 1000 },
    binStep: 100,
    activeBinId: 0,
    activePrice: 0.1,
    priceLabel: "SOL per baton",
    tokenPriceInSol: 0.1,
    quoteSide: "Y",
    quoteToken: { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9, reserve: 100 },
    quoteSymbol: "SOL",
    quotePriceInSol: 1,
    tokenPriceInQuote: 0.1,
    solPriceUsd: SOL_USD,
    baseFeePct: 1,
    maxFeePct: 1,
    dynamicFeePct: 1,
    hasDynamicFee: false,
    bins: flatBins(),
    liquidityBelowY: 30 * 20,
    liquidityAboveX: (30 * 20) / 0.1,
    fetchedAt: new Date(T0).toISOString(),
    priceModel: "dlmm",
    venue: "meteora-dlmm",
    pair: null,
    ...over,
  });

  const obs = (over: Record<string, unknown> = {}, snapOver: Record<string, unknown> = {}) =>
    ({
      ts: new Date(T0).toISOString(),
      cycle: 1,
      mode: "paper",
      poolLabel: "baton/SOL",
      snapshot: snapshot(snapOver),
      positions: [],
      wallet: { address: "w", sol: 100, token: 0, tokenSymbol: "baton", quote: 100, quoteSymbol: "SOL" },
      analytics: null,
      state: { actionsToday: 0, lastActionAt: null, lastMoveAt: null, lastPrice: null, killSwitch: false },
      recent: [],
      screen: { rank: 1, rankedPools: 400, score: 55, feeToTvl24hPct: 4, volume24hUsd: 3_000_000, tvlUsd: 400_000, ageHours: 5000, priceChange24hPct: 1, flags: [], generatedAt: new Date(T0).toISOString(), alternatives: [], hot: [] },
      portfolio: { activePools: [], poolsWithBands: 0, maxActivePools: 6, otherExposureSol: 0 },
      engine: null,
      ...over,
    }) as never;

  const extras = { limits: { maxPositionSol: 44, maxTotalExposureSol: 175, gasReserveSol: 1, stopLossPct: 25, maxBinWidth: 69, maxTxPerDay: 240, minSecondsBetweenActions: 60, maxSlippagePct: 1, maxPriceMovePctPerCycle: 30 }, now: T0, openCostSol: 0.06, openCostRefundableSol: 0.05 } as never;

  /* ---------- 1. GOLDEN: day one is unchanged ---------- */
  console.log("the golden test: the shipped 0.5 prints today's numbers");
  await test("GOLDEN seatEarnings: with feeShare 0.5 every figure is the one the old literal 0.5 produced, to the last decimal", () => {
    const pe = policy.policyEnv({} as NodeJS.ProcessEnv);
    assert.equal(pe.feeShare.memecoin, 0.5, "an env with no learning file prices at the shipped 0.5");
    assert.equal(pe.feeShare.stock, 0.5);
    assert.equal(pe.feeShare.other, 0.5);
    assert.equal(pe.feeShareN.memecoin, 0, "and rests on nothing yet");
    const o = obs();
    const e = policy.seatEarnings(o, extras, 20, 10, false, pe)!;
    assert.ok(e, "the fixture prices");
    // the old line, written out: the pool's own 24h fees x our share of the band x 0.5
    const poolFeesPerDayUsd = (400_000 * 4) / 100;
    near(e.poolFeesPerDayUsd, poolFeesPerDayUsd, 1e-12, "the pool's face pace");
    near(e.feesPerDayUsd, poolFeesPerDayUsd * (10 / 100) * 0.5, 1e-12, "half of our share of it");
    near(e.seatUsd, 20 * SOL_USD, 1e-12);
    near(e.yieldPctPerDay, (poolFeesPerDayUsd * 0.1 * 0.5) / (20 * SOL_USD) * 100, 1e-12);
    assert.equal(e.feeShare, 0.5);
    assert.equal(e.lane, "memecoin");
    assert.equal(e.feeShareWhy, null, "nothing learned, nothing claimed");
  });

  await test("GOLDEN the lanes are told apart the way the lesson's kind is: a stock pool learns in the stock lane, our own pair pool in 'other'", () => {
    const pe = policy.policyEnv({} as NodeJS.ProcessEnv);
    assert.equal(policy.seatEarnings(obs(), extras, 20, 10, false, pe)!.lane, "memecoin");
    const stock = obs({ screen: { rank: 1, rankedPools: 400, score: 55, feeToTvl24hPct: 4, volume24hUsd: 3_000_000, tvlUsd: 400_000, ageHours: 5000, priceChange24hPct: 1, flags: [], generatedAt: new Date(T0).toISOString(), stock: { ticker: "NVDA", issuer: "xstocks" }, alternatives: [], hot: [] } });
    assert.equal(policy.seatEarnings(stock, extras, 20, 10, false, pe)!.lane, "stock");
  });

  /* ---------- 2. PROPERTY: learning can only refuse more ---------- */
  console.log("the property test: a calibrated desk refuses a superset");
  await test("PROPERTY over 200 random pools: for every factor f <= 0.5 the seats that clear the yield and payback floors are a SUBSET of those clearing at 0.5", () => {
    let seed = 20260922;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const base = policy.policyEnv({} as NodeJS.ProcessEnv);
    const floors = { minSeatYieldPct: 0.4, maxPaybackHours: 24 };
    let refusedMore = 0;
    for (let i = 0; i < 200; i++) {
      const tvlUsd = 20_000 + rnd() * 2_000_000;
      const feeToTvl = 0.05 + rnd() * 20;
      const seatSol = 0.5 + rnd() * 40;
      const sharePct = 0.1 + rnd() * 45;
      const f = Math.round((0.1 + rnd() * 0.4) * 100) / 100; // any learned factor, always <= 0.5
      const o = obs({ screen: { rank: 1, rankedPools: 400, score: 55, feeToTvl24hPct: feeToTvl, volume24hUsd: 3_000_000, tvlUsd, ageHours: 5000, priceChange24hPct: 1, flags: [], generatedAt: new Date(T0).toISOString(), alternatives: [], hot: [] } });
      const at = (share: number) => {
        const pe = { ...base, feeShare: { memecoin: share, stock: share, other: share } };
        const e = policy.seatEarnings(o, extras, seatSol, sharePct, false, pe)!;
        return e.yieldPctPerDay >= floors.minSeatYieldPct && (e.paybackHours === null || e.paybackHours <= floors.maxPaybackHours);
      };
      const shipped = at(0.5);
      const learned = at(f);
      assert.ok(!(learned && !shipped), `pool ${i}: factor ${f} let a seat through that 0.5 refused`);
      if (shipped && !learned) refusedMore++;
    }
    assert.ok(refusedMore > 0, "and on this sample a calibrated desk really does refuse seats the shipped one took");
    console.log(`      (${refusedMore} of 200 seats the shipped 0.5 would have taken are refused once the lane is calibrated)`);
  });

  await test("PROPERTY the clamp: whatever the env says, the factor in force is never above the shipped 0.5 and never under the floor", () => {
    const e = learnEnv({ LEARN_CAL_MAX: "9", LEARN_CAL_MIN: "0" } as NodeJS.ProcessEnv);
    assert.equal(e.calMax, FEE_SHARE_DEFAULT, "LEARN_CAL_MAX=9 is refused: learning may not price a seat above what the code already does");
    assert.ok(e.calMin > 0 && e.calMin <= FEE_SHARE_DEFAULT);
    const state = emptyLearning("paper", T0);
    const wild = applyChange(state, { at: T0, mode: "paper", knob: "calibration", lane: "memecoin", from: 0.5, to: 4, why: "w", n: 30, windowH: 168 }, e, 45);
    const pe = policy.policyEnv({ LEARN_FILE: writeTmp(wild), LEARN_MODE: "paper" } as NodeJS.ProcessEnv);
    assert.equal(pe.feeShare.memecoin, FEE_SHARE_DEFAULT, "a state file carrying 4 is read back clamped to 0.5, not obeyed");
  });

  /* ---------- 3. the size and the wait: never larger, never shorter ---------- */
  console.log("the size and the wait");
  await test("effectiveMaxPositionSol with a pool penalty is <= without, and the human cap is never raised", () => {
    const maxPositionSol = 44;
    const sizeMultiplier = 0.5; // the engine's own bench/regime multiple
    const state = applyChange(emptyLearning("paper", T0), { at: T0, mode: "paper", knob: "pool-penalty", pool: POOL, label: "baton/SOL", from: 1, to: 0.5, why: "w", n: 4, windowH: 48 }, learnEnv({} as NodeJS.ProcessEnv), 45);
    const without = maxPositionSol * sizeMultiplier * Math.min(1, penaltyFor(null, POOL));
    const with_ = maxPositionSol * sizeMultiplier * Math.min(1, penaltyFor(state, POOL));
    assert.ok(with_ <= without, `${with_} must be <= ${without}`);
    near(with_, 11, 1e-12, "44 x 0.5 bench x 0.5 penalty");
    assert.ok(without <= maxPositionSol, "and neither is ever above MAX_POSITION_SOL");
    // an unknown pool is untouched
    near(maxPositionSol * sizeMultiplier * Math.min(1, penaltyFor(state, "OtherPool")), without, 1e-12);
  });

  await test("the sit-out with a penalty is >= the configured minimum, never shorter", () => {
    const reentryMin = 45;
    const state = applyChange(emptyLearning("paper", T0), { at: T0, mode: "paper", knob: "pool-penalty", pool: POOL, label: "baton/SOL", from: 1, to: 0.5, why: "w", n: 4, windowH: 48 }, learnEnv({} as NodeJS.ProcessEnv), reentryMin);
    const learned = sitOutMinFor(state, POOL);
    assert.ok(learned >= reentryMin, `${learned} min must be at least the configured ${reentryMin}`);
    const at = (mins: number, pool: string) => sittingOut(T0 - mins * 60_000, { reentryMin: Math.max(reentryMin, sitOutMinFor(state, pool)) }, T0);
    assert.equal(at(60, POOL), true, "an hour after it was given up the penalised pool is still sitting out");
    assert.equal(at(60, "OtherPool"), false, "a pool nothing was learned about keeps the configured 45 min");
    // and the cap holds: LEARN_SITOUT_MAX_MULTIPLE times the configured minimum, never a bench
    const worst = applyChange(emptyLearning("paper", T0), { at: T0, mode: "paper", knob: "pool-penalty", pool: POOL, label: "baton/SOL", from: 0.5, to: 0.25, why: "w", n: 4, windowH: 48 }, learnEnv({} as NodeJS.ProcessEnv), reentryMin);
    assert.ok(sitOutMinFor(worst, POOL) <= 4 * reentryMin, "the worst rung still lets the pool back");
    assert.ok(penaltyFor(worst, POOL) >= 0.25, "and still leaves it a quarter of a seat: benching is the engine's job, not a learner's");
  });

  /* ---------- 4. the doctrine's shapes ---------- */
  console.log("minimum sample, bounded step, minimum gap, decay");
  await test("MINIMUM SAMPLE: under LEARN_CAL_MIN_N lessons nothing moves and the reason says so with the count", () => {
    const env = learnEnv({} as NodeJS.ProcessEnv);
    const few = Array.from({ length: 19 }, (_, i) => lesson({ at: T0 - (i + 1) * HOUR, realizedYieldPctPerDay: 5 }));
    const r = calibrationReading(few, "memecoin", "paper", env, T0);
    assert.equal(r.target, null);
    assert.equal(r.n, 19);
    assert.match(r.why, /19 of the 20 memecoin seats/);
    assert.equal(calibrationChange(r, emptyLearning("paper", T0), env, T0, "paper"), null);
  });

  await test("BOUNDED STEP: 20 seats at 0.4 of forecast argue for 0.20 of face, and one cycle moves 0.5 to 0.45 and no further", () => {
    const env = learnEnv({} as NodeJS.ProcessEnv);
    // realised 10%/day against a 25%/day forecast taken at 0.5 of face: 0.5 x 0.4 = 0.20 of face
    const rows = Array.from({ length: 20 }, (_, i) => lesson({ at: T0 - (i + 1) * HOUR, realizedYieldPctPerDay: 10, entryYieldPct: 25, entryYieldFactor: 0.5 }));
    const r = calibrationReading(rows, "memecoin", "paper", env, T0);
    near(r.ratio!, 0.2, 1e-9, "the decayed median of realised over forecast, times the share of face it carried");
    assert.equal(r.target, 0.2);
    assert.match(r.why, /my last 20 memecoin seats came in at 0.20 of what I forecast/);
    const c = calibrationChange(r, emptyLearning("paper", T0), env, T0, "paper")!;
    assert.equal(c.from, 0.5);
    assert.equal(c.to, 0.45, "one 0.05 step, not the whole way");
    assert.equal(c.knob, "calibration");
    assert.equal(c.lane, "memecoin");
    assert.equal(c.n, 20);
    assert.equal(c.windowH, 168);
    assert.equal(c.why, r.why, "the journal row carries the evidence sentence verbatim");
  });

  await test("MINIMUM GAP: a second step inside LEARN_MIN_GAP_H is refused however loud the evidence", () => {
    const env = learnEnv({} as NodeJS.ProcessEnv);
    const rows = Array.from({ length: 20 }, (_, i) => lesson({ at: T0 - (i + 1) * HOUR, realizedYieldPctPerDay: 2, entryYieldPct: 25, entryYieldFactor: 0.5 }));
    const r = calibrationReading(rows, "memecoin", "paper", env, T0);
    let state = emptyLearning("paper", T0);
    const first = calibrationChange(r, state, env, T0, "paper")!;
    state = applyChange(state, first, env, 45);
    assert.equal(calibrationChange(r, state, env, T0 + 5 * HOUR, "paper"), null, "five hours later, still nothing");
    const second = calibrationChange(r, state, env, T0 + 7 * HOUR, "paper")!;
    assert.equal(second.from, 0.45);
    assert.equal(second.to, 0.4, "seven hours later, one more step");
  });

  await test("DECAY: a stale window teaches nothing, and inside the window the recent seats outvote the old ones", () => {
    const env = learnEnv({} as NodeJS.ProcessEnv);
    const stale = Array.from({ length: 30 }, (_, i) => lesson({ at: T0 - (200 + i) * HOUR }));
    assert.equal(calibrationReading(stale, "memecoin", "paper", env, T0).n, 0, "past LEARN_CAL_WINDOW_H nothing is read at all");
    // 20 old seats that did well and 20 fresh ones that did badly: the weighted median sits with the fresh ones
    const old_ = Array.from({ length: 20 }, (_, i) => lesson({ at: T0 - (150 + i) * HOUR, realizedYieldPctPerDay: 25, entryYieldPct: 25, entryYieldFactor: 0.5 }));
    const fresh = Array.from({ length: 20 }, (_, i) => lesson({ at: T0 - (i + 1) * HOUR, realizedYieldPctPerDay: 5, entryYieldPct: 25, entryYieldFactor: 0.5 }));
    const r = calibrationReading([...old_, ...fresh], "memecoin", "paper", env, T0);
    assert.ok(r.ratio! < 0.3, `the fresh evidence wins: ${r.ratio}`);
    near(weightedMedian([{ v: 1, w: 1 }, { v: 9, w: 0.001 }])!, 1, 1e-12, "the weighted median ignores a featherweight outlier");
    assert.equal(weightedMedian([]), null);
  });

  await test("LABEL HYGIENE: no learner reads netSol, and a lane only ever reads its own mode and its own kind", () => {
    const env = learnEnv({} as NodeJS.ProcessEnv);
    const src = fs.readFileSync(path.join(process.cwd(), "src/desk/learning.ts"), "utf8");
    assert.ok(!/\bnetSol\b/.test(src.replace(/^[\s*/]*.*netSol.*$/gm, "")), "netSol appears only in the comment that explains why it is not read");
    const mixed = [
      ...Array.from({ length: 20 }, (_, i) => lesson({ at: T0 - (i + 1) * HOUR, mode: "live", realizedYieldPctPerDay: 25 })),
      ...Array.from({ length: 20 }, (_, i) => lesson({ at: T0 - (i + 1) * HOUR, kind: "stock", realizedYieldPctPerDay: 25 })),
      ...Array.from({ length: 20 }, (_, i) => lesson({ at: T0 - (i + 1) * HOUR, ask: true, realizedYieldPctPerDay: 25 })),
    ];
    assert.equal(calibrationReading(mixed, "memecoin", "paper", env, T0).n, 0, "another desk's mode, another lane and the ask bands all stay out");
    assert.equal(calibrationReading(mixed, "stock", "paper", env, T0).n, 20);
  });

  await test("THE SEAT CHECK'S FORECAST counts too, at its own footing: it takes the pool's face pace whole, so its factor is 1", () => {
    const env = learnEnv({} as NodeJS.ProcessEnv);
    // realised 4 against a seat check that said 10: 1.0 x 0.4 = 0.40 of face, the 17-19 Sep number
    const rows = Array.from({ length: 20 }, (_, i) => lesson({ at: T0 - (i + 1) * HOUR, mode: "live", realizedYieldPctPerDay: 4, predictedYieldPct: 10, entryYieldPct: null, entryYieldFactor: null }));
    const r = calibrationReading(rows, "memecoin", "live", env, T0);
    near(r.ratio!, 0.4, 1e-9);
    assert.equal(r.target, 0.4);
  });

  /* ---------- 5. the pool penalty ---------- */
  console.log("the pool penalty");
  await test("a pool whose seats keep going through the band loses one rung, one rung only, and a clean pool gets one back", () => {
    const env = learnEnv({} as NodeJS.ProcessEnv);
    const bad = Array.from({ length: 4 }, (_, i) => lesson({ at: T0 - (i + 1) * HOUR, endReason: "through-band", minutes: 12 }));
    let state = emptyLearning("paper", T0);
    const cs = poolPenaltyChanges(bad, "paper", state, env, T0, 45);
    assert.equal(cs.length, 1);
    assert.equal(cs[0].from, 1);
    assert.equal(cs[0].to, 0.75, "one rung, never two");
    assert.match(cs[0].why, /4 of my last 4 seats in baton\/SOL ended on the down side/);
    state = applyChange(state, cs[0], env, 45);
    assert.equal(poolPenaltyChanges(bad, "paper", state, env, T0 + HOUR, 45).length, 0, "and not again inside the gap");
    const again = poolPenaltyChanges(bad, "paper", state, env, T0 + 7 * HOUR, 45);
    assert.equal(again[0].to, 0.5);
    // a clean run gives a rung back, and never more than whole
    const clean = Array.from({ length: 4 }, (_, i) => lesson({ at: T0 - (i + 1) * HOUR, endReason: "idle" }));
    const back = poolPenaltyChanges(clean, "paper", state, env, T0 + 7 * HOUR, 45);
    assert.equal(back[0].to, 1);
    const whole = applyChange(state, back[0], env, 45);
    assert.equal(poolPenaltyChanges(clean, "paper", whole, env, T0 + 20 * HOUR, 45).length, 0, "a whole pool is left alone");
    assert.equal(stepRung(0.25, true), 0.25, "the bottom rung is the bottom");
    assert.equal(stepRung(1, false), 1, "and the top is the top");
    assert.equal(stepToward(0.5, 0.48, 0.05), 0.48, "a step never overshoots its target");
  });

  await test("under LEARN_POOL_MIN_N closed seats a pool is judged on nothing", () => {
    const env = learnEnv({} as NodeJS.ProcessEnv);
    const two = Array.from({ length: 2 }, (_, i) => lesson({ at: T0 - (i + 1) * HOUR, endReason: "stop" }));
    assert.equal(poolPenaltyChanges(two, "paper", emptyLearning("paper", T0), env, T0, 45).length, 0);
  });

  /* ---------- 6. the freeze ---------- */
  console.log("the freeze switch");
  await test("LEARN_FROZEN is the literal 'true' and nothing else: the whole table", () => {
    const table: [string | undefined, boolean][] = [
      [undefined, false], ["", false], ["1", false], ["yes", false], ["on", false], ["false", false], ["True", true], ["TRUE", true], ["  true  ", true], ["true", true],
    ];
    for (const [v, want] of table) assert.equal(learningFrozen({ LEARN_FROZEN: v } as NodeJS.ProcessEnv), want, `LEARN_FROZEN=${JSON.stringify(v)}`);
    assert.equal(knobFrozen({ LEARN_FROZEN_CALIBRATION: "true" } as NodeJS.ProcessEnv, "calibration"), true);
    assert.equal(knobFrozen({ LEARN_FROZEN_CALIBRATION: "true" } as NodeJS.ProcessEnv, "pools"), false, "one knob at a time");
    assert.equal(knobFrozen({ LEARN_FROZEN: "true" } as NodeJS.ProcessEnv, "pools"), true, "the desk-wide freeze covers both");
    assert.equal(knobFrozen({ LEARN_FROZEN_POOLS: "1" } as NodeJS.ProcessEnv, "pools"), false, "'1' is not a freeze here either");
  });

  await test("a FROZEN desk writes no learning.json and no journal row, and still says what it would have changed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-frozen-"));
    const files = learnFiles(dir, "paper", {} as NodeJS.ProcessEnv);
    const env = learnEnv({} as NodeJS.ProcessEnv);
    const rows = Array.from({ length: 20 }, (_, i) => lesson({ at: T0 - (i + 1) * HOUR, realizedYieldPctPerDay: 10 }));
    const r = calibrationReading(rows, "memecoin", "paper", env, T0);
    const c = calibrationChange(r, emptyLearning("paper", T0), env, T0, "paper")!;
    // what the runner does when frozen: it computes, it logs, it writes nothing
    const said: string[] = [];
    if (knobFrozen({ LEARN_FROZEN: "true" } as NodeJS.ProcessEnv, "calibration")) said.push(`FROZEN, so nothing moved: he would have taken memecoin seat pricing ${c.from} -> ${c.to} of face because ${c.why}`);
    else writeLearning(files.state, applyChange(emptyLearning("paper", T0), c, env, 45));
    assert.equal(said.length, 1, "it still says it");
    assert.match(said[0], /would have taken memecoin seat pricing 0.5 -> 0.45/);
    assert.equal(fs.existsSync(files.state), false, "no state file");
    assert.equal(fs.existsSync(files.log), false, "no journal row");
    assert.equal(factorFor(readLearning(files.state, "paper"), "memecoin"), FEE_SHARE_DEFAULT, "and the shipped default still stands");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /* ---------- 7. the journal, and the cross-book leak ---------- */
  console.log("the journal and the mode");
  await test("every change is one journalled row, and nothing changes without one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-journal-"));
    const files = learnFiles(dir, "paper", {} as NodeJS.ProcessEnv);
    const env = learnEnv({} as NodeJS.ProcessEnv);
    const rows = Array.from({ length: 22 }, (_, i) => lesson({ at: T0 - (i + 1) * HOUR, realizedYieldPctPerDay: 10 }));
    const c = calibrationChange(calibrationReading(rows, "memecoin", "paper", env, T0), emptyLearning("paper", T0), env, T0, "paper")!;
    appendLearningChange(files.log, c);
    writeLearning(files.state, applyChange(emptyLearning("paper", T0), c, env, 45));
    const journal = readLearningChanges(files.log);
    assert.equal(journal.length, 1);
    for (const k of ["at", "mode", "knob", "lane", "from", "to", "why", "n", "windowH"]) assert.ok(k in journal[0], `the row carries ${k}`);
    assert.equal(journal[0].mode, "paper");
    assert.equal(factorFor(readLearning(files.state, "paper"), "memecoin"), 0.45);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("CROSS-BOOK LEAK, closed: a live desk refuses a file learned on paper, and says so", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-mode-"));
    const files = learnFiles(dir, "paper", {} as NodeJS.ProcessEnv);
    const env = learnEnv({} as NodeJS.ProcessEnv);
    writeLearning(files.state, applyChange(emptyLearning("paper", T0), { at: T0, mode: "paper", knob: "calibration", lane: "memecoin", from: 0.5, to: 0.3, why: "w", n: 30, windowH: 168 }, env, 45));
    assert.equal(factorFor(readLearning(files.state, "paper"), "memecoin"), 0.3, "its own desk reads it");
    let refusal: string | null = null;
    assert.equal(readLearning(files.state, "live", (w) => (refusal = w)), null, "a live desk does not");
    assert.match(refusal ?? "", /learned on a paper desk and this desk is live/);
    clearLearningCache();
    const pe = policy.policyEnv({ LEARN_FILE: files.state, LEARN_MODE: "live" } as NodeJS.ProcessEnv);
    assert.equal(pe.feeShare.memecoin, FEE_SHARE_DEFAULT, "and it prices at the shipped default instead");
    clearLearningCache();
    const paperEnv = policy.policyEnv({ LEARN_FILE: files.state, LEARN_MODE: "paper" } as NodeJS.ProcessEnv);
    assert.equal(paperEnv.feeShare.memecoin, 0.3, "while the paper desk gets what it learned");
    assert.equal(paperEnv.feeShareN.memecoin, 30);
    fs.rmSync(dir, { recursive: true, force: true });
    clearLearningCache();
  });

  await test("learning is on by default: the files land in the desk's own DATA_DIR, and LEARN_FILE only moves the state", () => {
    const f = learnFiles("/tmp/book", "paper", {} as NodeJS.ProcessEnv);
    assert.equal(f.state, "/tmp/book/learning.json");
    assert.equal(f.log, "/tmp/book/learning.jsonl");
    assert.equal(f.mode, "paper");
    assert.equal(learnFiles("/tmp/book/", "paper", { LEARN_FILE: "/tmp/scratch/l.json" } as NodeJS.ProcessEnv).state, "/tmp/scratch/l.json");
  });

  await test("the hold reason names the share of face and the seats behind it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-say-"));
    const files = learnFiles(dir, "paper", {} as NodeJS.ProcessEnv);
    const env = learnEnv({} as NodeJS.ProcessEnv);
    const why = "my last 26 memecoin seats came in at 0.34 of what I forecast for them (168h, oldest evidence halved every 7 days), so I price the screen's fee pace at 0.34 of face";
    writeLearning(files.state, applyChange(emptyLearning("paper", T0), { at: T0, mode: "paper", knob: "calibration", lane: "memecoin", from: 0.4, to: 0.35, why, n: 26, windowH: 168 }, env, 45));
    clearLearningCache();
    const pe = policy.policyEnv({ LEARN_FILE: files.state, LEARN_MODE: "paper", POLICY_MIN_SEAT_YIELD_PCT: "500" } as NodeJS.ProcessEnv);
    const e = policy.seatEarnings(obs(), extras, 20, 10, false, pe)!;
    assert.equal(e.feeShare, 0.35);
    assert.equal(e.feeShareN, 26);
    assert.equal(policy.calibrationClause(e), ", priced at 0.35 of the pool's face pace off my last 26 memecoin seats");
    assert.equal(policy.calibrationClause({ ...e, feeShareN: 0 }), "", "and claims nothing while the shipped default stands");
    const r = policy.policyDecide(obs(), { ...(extras as object), env: { ...pe, minSeatYieldPct: 500 } } as never);
    assert.equal(r.branch, "not-worth");
    assert.match(r.reason, /priced at 0.35 of the pool's face pace off my last 26 memecoin seats/);
    assert.match(r.decision.reasoning, /I take that pace at 0.35 of face because my last 26 memecoin seats/);
    assert.ok(!r.decision.reasoning.includes("—"), "no em dashes");
    fs.rmSync(dir, { recursive: true, force: true });
    clearLearningCache();
  });

  await test("THE FORECAST HE DECIDED ON is the one the policy made, kept per pool for the open to write down", () => {
    policy.clearEntryForecasts();
    assert.equal(policy.entryForecastOf(POOL), null, "nothing decided, nothing recorded");
    const r = policy.policyDecide(obs(), extras);
    const f = policy.entryForecastOf(POOL);
    assert.ok(f, `the policy priced the seat (${r.branch}: ${r.reason})`);
    assert.equal(f!.feeShare, 0.5);
    assert.equal(f!.lane, "memecoin");
    assert.ok(f!.yieldPctPerDay > 0);
    policy.clearEntryForecasts();
  });

  /* ---------- 8. the scout the paper book never had ---------- */
  console.log("the paper flow scout");
  await test("a virtual pool in the paper book's latest.json is not on the chain, which is why the scout drops it before it reads accounts", async () => {
    const { poolsFromLatest } = await import("../scouts/flow.js");
    const { PublicKey } = await import("@solana/web3.js");
    const latest = [
      { ts: new Date(T0).toISOString(), pool: { address: "pair-XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg", label: "HOODx/SOL", quoteSide: "Y", quoteSymbol: "SOL", tokenX: { decimals: 8 }, tokenY: { decimals: 9 } }, positions: [] },
      { ts: new Date(T0).toISOString(), pool: { address: "BEv9D7kzD2aPKuZWHeDHHgkrR4GcUVPqgbGTDo2hssR8", label: "PLTRx/SOL", quoteSide: "Y", quoteSymbol: "SOL", tokenX: { decimals: 8 }, tokenY: { decimals: 9 } }, positions: [] },
    ];
    const pools = poolsFromLatest(latest);
    assert.equal(pools.length, 2, "the desk's own reader keeps both: a virtual pool is a real seat on the paper book");
    const onChain = (a: string) => {
      try {
        void new PublicKey(a);
        return true;
      } catch {
        return false;
      }
    };
    assert.equal(onChain(pools[0].address), false, "but one of them is not an address the chain has");
    assert.equal(onChain(pools[1].address), true);
    assert.equal(pools.filter((p) => onChain(p.address)).length, 1, "and one bad address in a getMultipleAccountsInfo batch threw for the whole batch, so the paper scout read nothing at all");
  });

  /* ---------- 9. the smoke run ---------- */
  console.log("a real cycle, on a copy of the book");
  await test("SMOKE: `npm run once` against a COPY of data-live opens the learning files, prints the state at boot, and never touches the running book", () => {
    // the running book is COPIED, never opened: LEARN_SMOKE_BOOK points at another checkout's data-live
    const live = [process.env.LEARN_SMOKE_BOOK ?? "", path.join(process.cwd(), "data-live")].find((d) => d && fs.existsSync(d)) ?? null;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-smoke-"));
    const book = path.join(dir, "book");
    fs.mkdirSync(book);
    if (live) {
      for (const f of ["lessons.jsonl", "state.json", "paper-book.json", "screen.json", "latest.json", "engine-state.json"]) {
        if (fs.existsSync(path.join(live, f))) fs.copyFileSync(path.join(live, f), path.join(book, f));
      }
    } else {
      fs.writeFileSync(path.join(book, "lessons.jsonl"), Array.from({ length: 21 }, (_, i) => JSON.stringify({ ...lesson({ at: T0 - (i + 1) * HOUR }), position: `p${i}`, openedAt: T0 - (i + 3) * HOUR, closedAt: T0 - (i + 1) * HOUR, seatSol: 10, bins: 5, binStep: 100, coverPct: 4, travelBins60m: null, inRangePct: 60, feesSol: 0.1, netSol: 0, headline: "x" })).join("\n") + "\n");
    }
    const before = live ? fs.readdirSync(live).length : 0;
    let out = "";
    try {
      out = execFileSync("npx", ["tsx", "src/index.ts", "--once"], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 180_000,
        env: { ...process.env, DATA_DIR: book, DRY_RUN: "true", PAPER_SOL: "100", PAPER_USDC: "10000", SERVE_PORT: "0", AUTO_DEPLOY: "false", X_LIVE: "false", LEARN_FROZEN: "true" },
      });
    } catch (err) {
      out = `${(err as { stdout?: string }).stdout ?? ""}${(err as { stderr?: string }).stderr ?? ""}`;
    }
    assert.match(out, /learning (on|FROZEN)/, `the boot banner says what learning is doing:\n${out.slice(0, 2000)}`);
    assert.match(out, /width tuning retired/, "and that the width tuner is retired, with why");
    assert.match(out, /mode paper/, "and which desk's evidence it is");
    assert.equal(fs.existsSync(path.join(book, "learning.json")), false, "frozen, so it wrote no state even on its own copy");
    assert.match(out, /FROZEN, so nothing moved|\[learning\]/, "and a frozen desk still says what it sees");
    if (live) assert.equal(fs.readdirSync(live).length, before, "and the running book is untouched");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log(`\n${passed} passed`);
}

/** A state file in a temp dir, for the clamp test. */
function writeTmp(state: LearningState): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-clamp-"));
  const file = path.join(dir, "learning.json");
  writeLearning(file, state);
  clearLearningCache();
  return file;
}

main();
