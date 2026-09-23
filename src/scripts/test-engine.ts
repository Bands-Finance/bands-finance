/**
 * Engine tests with synthetic data. No RPC, no LLM, no disk.
 *   npm run test:engine
 */
import assert from "node:assert/strict";
import type { EngineConfig } from "../config";
import type { RiskLimits } from "../risk/limits";
import type { RiskState } from "../risk/state";
import { quoteMath, quoteOf, toQuote, toSol, USDC_MINT, type PoolSnapshot, type PositionSnapshot } from "../tools/dlmm";
import { entryValueOf, toOpenPlan } from "../executor";
import {
  collectsOnDay,
  dailyClose,
  feeGainSinceLastSkim,
  feesRealizedSol,
  inventory,
  LedgerRow,
  netCashSol,
  quoteOfRow,
  realizedOnDaySol,
  summary,
  workingSol,
} from "../engine/ledger";
import { antiChurn, bandMoveCostSol, bandStopPct, cycleDropPct, downExitOf, drawdownPct, dropOverWindowPct, forgetBand, knifeReason, knivesReason, poolMoveCostSol, priorRangeOverWindowPct, recordPrice, rollStop, stopEntryOf, trackOutOfRange, moveAfterSec, rangeOverWindowPct } from "../engine/exit";
import { askBandRecord, askBinsFor, askExitEnv, askExitOf, askExpiry, askOnlyPools, askOpenParams, askPoolsOf, askStopBasis, isAskExit } from "../engine/askExit";
import type { Decision } from "../agent/schema";
import {
  benchMultiplier,
  benchView,
  circuitLimitSol,
  circuitLossSol,
  circuitVerdict,
  clearHalt,
  clearStandDown,
  emptyEngineState,
  engineView,
  markedDrawdownSol,
  portfolioVerdict,
  recordStop,
  regimeView,
  standingDown,
  stopsInWindow,
} from "../engine/breakers";
import { clearFeesPending, collectDirective, skimPlan, trackFeesPending, unclaimedFeesQuote, unclaimedFeesSol } from "../engine/collect";
import { engineDirective } from "../engine/directives";
import { CARRY_HAIRCUT_PCT, carriedBands, carriedUsdToSol, foldMarksHealth, marksHealth, marksStale, MARKS_STALE_CYCLES, noteMarks, readOfBook, recordMarks, resetMarksHealth } from "../engine/marks";
import { lockBlocks, loopStale, staleWindowMs } from "../engine/watchdog";
import { binWalkImpactPct } from "../paper/impact";

const limits: RiskLimits = {
  maxPositionSol: 0.5,
  maxTotalExposureSol: 1,
  gasReserveSol: 0.1,
  stopLossPct: 15,
  maxBinWidth: 69,
  maxTxPerDay: 24,
  minSecondsBetweenActions: 600,
  maxSlippagePct: 1,
  maxPriceMovePctPerCycle: 40,
};

const cfg: EngineConfig = {
  outOfRangeSec: 600,
  knifePct: 20,
  circuitFloorSol: 0.05,
  portfolioFloorSol: 0.15,
  collectMinSol: 0.005,
  collectFloorSol: 0.001,
  collectMaxPerDay: 30,
  skim: false,
  floatTargetSol: 1,
  treasuryAddress: "",
  expectedWallet: "",
};

const TREASURY = "7bandA1xQm9vKZr4TgH2sLp8eWc3nYd6uFj5kRt1oMz2";

const snapshot: PoolSnapshot = {
  address: "pool",
  label: "ANSEM/SOL",
  tokenX: { mint: "ansem", symbol: "ANSEM", decimals: 6, reserve: 5_000_000 },
  tokenY: { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9, reserve: 5000 },
  solSide: "Y",
  baseToken: { mint: "ansem", symbol: "ANSEM", decimals: 6, reserve: 5_000_000 },
  binStep: 20,
  activeBinId: 260,
  activePrice: 0.002,
  priceLabel: "SOL per ANSEM",
  tokenPriceInSol: 0.002,
  baseFeePct: 0.2,
  maxFeePct: 10,
  dynamicFeePct: 0.22,
  bins: [],
  liquidityBelowY: 180,
  liquidityAboveX: 100_000,
  fetchedAt: new Date().toISOString(),
};

const position = (over: Partial<PositionSnapshot> = {}): PositionSnapshot => ({
  address: "pos1",
  lowerBinId: 241,
  upperBinId: 260,
  lowerPrice: 0.00162,
  upperPrice: 0.00168,
  widthBins: 20,
  inRange: true,
  binsFromRange: 0,
  amountX: 0,
  amountY: 0.25,
  feeX: 0,
  feeY: 0.001,
  valueInSol: 0.251,
  solInPosition: 0.251,
  lastUpdatedAt: 0,
  ...over,
});

const freshState = (over: Partial<RiskState> = {}): RiskState => ({
  day: "2026-09-12",
  actionsToday: 0,
  lastActionAt: null,
  lastPrice: null,
  entryValueSol: {},
  stops: {},
  outOfRangeSince: {},
  feesPendingSince: {},
  priceHistory: {},
  ...over,
});

const DAY = "2026-09-12";
const T0 = Date.parse(`${DAY}T12:00:00Z`);
const H = 3600_000;
const M = 60_000;

const row = (over: Partial<LedgerRow>): LedgerRow => ({
  ts: T0,
  mode: "live",
  sig: "sig",
  pool: "pool",
  position: "pos1",
  mech: "open",
  solDelta: 0,
  tokenDelta: 0,
  tokenMint: "ansem",
  markTokenInSol: 0.002,
  rentSol: 0,
  txFeeSol: -0.00001,
  basis: "exact",
  note: "",
  ...over,
});

const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-9, msg ?? `${a} is not within 1e-9 of ${b}`);

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n += 1;
  console.log(`ok ${n} - ${name}`);
}

// ---- ledger --------------------------------------------------------------------------------------

const rows: LedgerRow[] = [
  row({ ts: T0 - 26 * H, mech: "open", solDelta: -0.25, rentSol: -0.0574, txFeeSol: -0.00001 }), // yesterday
  row({ ts: T0 - 2 * H, mech: "collect", solDelta: 0.003, tokenDelta: 1, feeSol: 0.005, txFeeSol: -0.000005 }),
  row({ ts: T0 - 1 * H, mech: "close", solDelta: 0.2, tokenDelta: 20, feeSol: 0.002, rentSol: 0.0574, txFeeSol: -0.00001, entryValueSol: 0.25 }),
  row({ ts: T0, mech: "open", position: "pos2", solDelta: -0.1, rentSol: -0.0574, txFeeSol: -0.00001, basis: "marked" }),
  row({ ts: T0 - 3 * H, mode: "dry-run", mech: "collect", solDelta: 5, feeSol: 5, basis: "marked" }), // must never fold with live
];

test("ledger: fees realized = collect rows + fee legs of close rows, one mode at a time", () => {
  assert.equal(feesRealizedSol(rows, "live"), 0.007);
  assert.equal(feesRealizedSol(rows, "dry-run"), 5);
});

test("ledger: net cash sums exact rows only (sol + rent + fee)", () => {
  const exact = -0.25 - 0.0574 - 0.00001 + 0.003 - 0.000005 + 0.2 + 0.0574 - 0.00001;
  assert.equal(netCashSol(rows, "live"), Math.round(exact * 1e6) / 1e6);
  assert.equal(netCashSol(rows, "dry-run"), 0);
});

test("ledger: inventory by mint at the latest mark, reported as marked", () => {
  const inv = inventory(rows, "live");
  assert.equal(inv.length, 1);
  assert.equal(inv[0].mint, "ansem");
  assert.equal(inv[0].units, 21);
  assert.equal(inv[0].markedSol, 0.042);
});

test("ledger: daily close per UTC day", () => {
  const d = dailyClose(rows, "live");
  assert.equal(d[DAY].collectedSol, 0.007);
  assert.equal(d[DAY].collects, 1);
  assert.equal(d["2026-09-11"].rows, 1);
  assert.equal(collectsOnDay(rows, "live", DAY), 1);
  assert.equal(collectsOnDay(rows, "dry-run", DAY), 1, "the dry-run collect counts in its own mode only");
});

test("ledger: working SOL folds from state, summary keeps exact and marked apart", () => {
  assert.equal(workingSol({ a: 0.25, b: 0.1 }), 0.35);
  const s = summary(rows, "live", { pos2: 0.1 });
  assert.equal(s.rows, 4);
  assert.equal(s.exact.rows, 3);
  assert.equal(s.marked.rows, 1);
  assert.equal(s.marked.inventorySol, 0.042);
  assert.equal(s.workingSol, 0.1);
  assert.equal(s.feesRealizedSol, 0.007);
  assert.ok(!("total" in s), "no field adds exact to marked");
});

test("ledger: realized on a day = collects + (close back - entry) + fees of other rows", () => {
  // collect: 0.003 + 1*0.002 - 0.000005 ; close: 0.2 + 20*0.002 - 0.00001 - 0.25 ; open today: -0.00001
  const expected = 0.003 + 0.002 - 0.000005 + (0.2 + 0.04 - 0.00001 - 0.25) - 0.00001;
  assert.equal(realizedOnDaySol(rows, "live", DAY), Math.round(expected * 1e6) / 1e6);
});

test("ledger: fee gain since the last skim row", () => {
  assert.equal(feeGainSinceLastSkim(rows, "live").gainSol, 0.007);
  const withSkim = [...rows, row({ ts: T0 - 90 * M, mech: "skim", solDelta: -0.003 })];
  const g = feeGainSinceLastSkim(withSkim, "live");
  assert.equal(g.gainSol, 0.002);
  assert.equal(g.lastSkimAt, T0 - 90 * M);
});

// ---- exit ladder ---------------------------------------------------------------------------------

test("rollStop lands in [0.8, 1.0] x the limit and never above it", () => {
  assert.equal(rollStop(limits, () => 0), 12);
  assert.equal(rollStop(limits, () => 0.5), 13.5);
  assert.equal(rollStop(limits, () => 0.999999), 15);
  assert.equal(rollStop(limits, () => 1.5), 15);
  for (let i = 0; i < 200; i++) {
    const s = rollStop(limits);
    assert.ok(s >= 12 && s <= 15, `rolled ${s}`);
  }
  assert.equal(bandStopPct({ pos1: 13.2 }, "pos1", limits), 13.2);
  assert.equal(bandStopPct({}, "pos1", limits), 15);
  assert.equal(bandStopPct({ pos1: 40 }, "pos1", limits), 15, "a stop above the limit is ignored");
});

test("out-of-range tracking sets on first sight, clears when back in range", () => {
  const state = freshState();
  trackOutOfRange(state, [position({ inRange: false })], T0);
  assert.equal(state.outOfRangeSince!.pos1, T0);
  trackOutOfRange(state, [position({ inRange: false })], T0 + M);
  assert.equal(state.outOfRangeSince!.pos1, T0, "the first sighting sticks");
  trackOutOfRange(state, [position({ inRange: true })], T0 + 2 * M);
  assert.equal(state.outOfRangeSince!.pos1, undefined);
});

test("anti-churn blocks a young out-of-range move, allows an old one or a drawdown past half the stop", () => {
  const close = { action: "CLOSE_POSITION" as const, open: null, positionAddress: "pos1", reasoning: "", confidence: 1, headline: "" };
  const p = position({ inRange: false, binsFromRange: -2 });
  const young = freshState({ outOfRangeSince: { pos1: T0 - 100_000 } });
  assert.match(antiChurn(close, [p], young, limits, 600, T0)!, /anti-churn: pos1 is out of range for 100s, minimum 600s/);
  const old = freshState({ outOfRangeSince: { pos1: T0 - 601_000 } });
  assert.equal(antiChurn(close, [p], old, limits, 600, T0), null);
  const hurt = position({ inRange: false, valueInSol: 0.27 });
  const dd = freshState({ outOfRangeSince: { pos1: T0 - 1000 }, entryValueSol: { pos1: 0.3 } });
  assert.equal(antiChurn(close, [hurt], dd, limits, 600, T0), null, "-10% is past half of a 15% stop");
  // an all-quote band the price ran off on the quote side may be RE-LAID after the idle wait: no sale, nothing to churn
  const idleY = position({ inRange: false, binsFromRange: 2 }); // above a Y-quoted band: still all SOL
  const relay = { ...close, action: "REBALANCE" as const };
  assert.equal(antiChurn(relay, [idleY], young, limits, 600, T0, undefined, { sec: 90, quoteSide: "Y" }), null, "100 s out, idle wait 90 s: the re-lay goes");
  assert.match(antiChurn(relay, [idleY], young, limits, 600, T0, undefined, { sec: 120, quoteSide: "Y" })!, /minimum 120s/, "the idle wait is what it waits for");
  assert.match(antiChurn(close, [idleY], young, limits, 600, T0, undefined, { sec: 90, quoteSide: "Y" })!, /minimum 600s/, "a CLOSE is a sale of nothing here, but it is not a re-lay: the ordinary minimum");
  const through = position({ inRange: false, binsFromRange: -2 }); // below a Y-quoted band: the band turned into token
  assert.match(antiChurn(relay, [through], young, limits, 600, T0, undefined, { sec: 90, quoteSide: "Y" })!, /minimum 600s/, "through the band on the token side: a paid move, the ordinary minimum");
  assert.equal(antiChurn(relay, [position({ inRange: false, binsFromRange: -2 })], young, limits, 600, T0, undefined, { sec: 90, quoteSide: "X" }), null, "an X-quoted band idles on the other side");
  const hold = { ...close, action: "HOLD" as const, positionAddress: null };
  assert.equal(antiChurn(hold, [p], young, limits, 600, T0), null);
});

test("price history trims to 6h and the knife reads the trailing 30 min", () => {
  const state = freshState();
  recordPrice(state, "pool", 1.0, T0 - 7 * H);
  recordPrice(state, "pool", 1.0, T0 - 40 * M);
  recordPrice(state, "pool", 0.95, T0 - 20 * M);
  recordPrice(state, "pool", 0.7, T0);
  const hist = state.priceHistory!.pool;
  assert.equal(hist.length, 3, "the 7h-old sample is gone");
  const drop = dropOverWindowPct(hist, T0)!;
  assert.ok(Math.abs(drop - 30) < 1e-9, `drop ${drop}`);
  assert.match(knifeReason(hist, T0, 20)!, /knife: -30.0% in 30 min \(limit 20%\)/);
  assert.equal(knifeReason(hist, T0, 35), null);
  assert.equal(knifeReason([{ ts: T0, price: 1 }], T0, 20), null, "one sample is no verdict");
  const young = dropOverWindowPct([{ ts: T0 - 10 * M, price: 1 }, { ts: T0, price: 0.9 }], T0)!;
  assert.ok(Math.abs(young - 10) < 1e-9, `two young samples still judge (${young})`);
});

test("forgetBand drops every per-band record", () => {
  const state = freshState({ entryValueSol: { pos1: 1 }, stops: { pos1: 13 }, outOfRangeSince: { pos1: 1 }, feesPendingSince: { pos1: 1 } });
  forgetBand(state, "pos1");
  assert.deepEqual([state.entryValueSol, state.stops, state.outOfRangeSince, state.feesPendingSince], [{}, {}, {}, {}]);
  near(drawdownPct(position({ valueInSol: 0.24 }), 0.3)!, 20);
  assert.equal(drawdownPct(position(), undefined), null);
  near(drawdownPct(position({ valueInSol: 0.27 }), 0.3, 0.03)!, 20, "the fees inside the band are set aside before the drawdown is read");
  near(drawdownPct(position({ valueInSol: 0.27 }), 0.3, 0)!, 10);
});

// ---- breakers ------------------------------------------------------------------------------------

test("bench ladder: x1, x0.5, x0.25, benched at 3, self-clearing as the window rolls", () => {
  assert.deepEqual([0, 1, 2, 3, 5].map(benchMultiplier), [1, 0.5, 0.25, 0, 0]);
  const e = emptyEngineState();
  recordStop(e, "pool", T0 - 5 * H);
  recordStop(e, "pool", T0 - 3 * H);
  assert.equal(benchView(e, "pool", T0).multiplier, 0.25);
  recordStop(e, "pool", T0 - 1 * H);
  const b = benchView(e, "pool", T0);
  assert.equal(b.benched, true);
  assert.match(b.reason!, /benched: 3 stop-loss closes/);
  assert.equal(stopsInWindow(e.stopTimes.pool, T0 + 1.5 * H), 2, "the oldest aged out");
  assert.equal(benchView(e, "pool", T0 + 1.5 * H).multiplier, 0.25);
  assert.equal(benchView(e, "pool", T0 + 7 * H).multiplier, 1);
  assert.equal(benchView(e, "other", T0).reason, null);
});

test("board regime: median 24h move across the worked pools", () => {
  assert.equal(regimeView([]).multiplier, 1);
  assert.equal(regimeView([null, null]).medianMove24hPct, null);
  assert.equal(regimeView([2, -3, 8]).multiplier, 1);
  const half = regimeView([-2, -8, -30]);
  assert.equal(half.multiplier, 0.5);
  assert.equal(half.medianMove24hPct, -8);
  assert.match(half.reason!, /regime: board median -8.0% over 24h across 3 pools: size x0.5/);
  const off = regimeView([-20, -16, 1]);
  assert.equal(off.multiplier, 0);
  assert.match(off.reason!, /opens off/);
  assert.equal(regimeView([-6, -4]).medianMove24hPct, -5);
  assert.equal(regimeView([-6, -4]).multiplier, 1, "-5 is the edge of full size");
});

test("circuit breaker: limit scales with working, loss nets realized with marked drawdown", () => {
  assert.equal(circuitLimitSol(0.1, 0.05), 0.05);
  near(circuitLimitSol(1, 0.05), 0.15);
  near(markedDrawdownSol([{ valueInSol: 0.2, entryValueSol: 0.25 }, { valueInSol: 0.3, entryValueSol: 0.25 }, { valueInSol: 1 }]), -0.05);
  near(circuitLossSol(0.01, -0.05), 0.04);
  assert.equal(circuitLossSol(0.1, -0.05), 0);
  near(circuitLossSol(-0.02, 0), 0.02);
});

test("circuit breaker: two confirming marks -> stage 1 (4h), second trip that day -> stage 2 (6h), re-armed", () => {
  let c = emptyEngineState().circuit;
  let v = circuitVerdict(c, 0.06, 0.3, DAY, T0, { floorSol: 0.05 });
  assert.equal(v.tripped, false);
  assert.equal(v.next.streak, 1);
  v = circuitVerdict(v.next, 0.06, 0.3, DAY, T0 + 5 * M, { floorSol: 0.05 });
  assert.equal(v.tripped, true);
  assert.equal(v.stage, 1);
  assert.equal(v.next.haltUntil, T0 + 5 * M + 4 * H);
  assert.match(v.reason!, /circuit breaker stage 1/);
  // halted: the same loss judges nothing
  v = circuitVerdict(v.next, 0.06, 0.3, DAY, T0 + 10 * M, { floorSol: 0.05 });
  assert.equal(v.tripped, false);
  assert.equal(v.stage, 1);
  // after the halt, the same loss is not NEW loss: re-armed at 0.06
  const after = T0 + 5 * M + 4 * H + M;
  v = circuitVerdict(v.next, 0.06, 0.3, DAY, after, { floorSol: 0.05 });
  assert.equal(v.tripped, false);
  assert.equal(v.next.stage, 0);
  // another full limit of loss trips stage 2 for 6h
  v = circuitVerdict(v.next, 0.12, 0.3, DAY, after + M, { floorSol: 0.05 });
  v = circuitVerdict(v.next, 0.12, 0.3, DAY, after + 2 * M, { floorSol: 0.05 });
  assert.equal(v.tripped, true);
  assert.equal(v.stage, 2);
  assert.equal(v.next.haltUntil, after + 2 * M + 6 * H);
  assert.equal(v.next.trips, 2);
  // a new day resets trips and the arm; a halt in progress carries over
  const tomorrow = "2026-09-13";
  const nv = circuitVerdict(v.next, 0.12, 0.3, tomorrow, after + 3 * M, { floorSol: 0.05 });
  assert.equal(nv.next.trips, 0);
  assert.equal(nv.next.armedAtLossSol, 0);
  assert.equal(nv.next.haltUntil, v.next.haltUntil);
  // a single mark never trips
  const one = circuitVerdict(emptyEngineState().circuit, 1, 0.3, DAY, T0, { floorSol: 0.05 });
  assert.equal(one.tripped, false);
  // a bigger working book raises the limit
  const big = circuitVerdict(emptyEngineState().circuit, 0.1, 1, DAY, T0, { floorSol: 0.05 });
  near(big.limitSol, 0.15);
  assert.equal(big.next.streak, 0);
});

test("clear-halt lifts a halt", () => {
  const e = emptyEngineState();
  e.circuit.haltUntil = T0 + H;
  e.circuit.stage = 1;
  const r = clearHalt(e);
  assert.equal(r.cleared, true);
  assert.equal(e.circuit.haltUntil, 0);
  assert.equal(clearHalt(e).cleared, false);
});

test("portfolio breaker: three confirming marks -> flatten + 12h stand-down; only the operator clears it", () => {
  let p = emptyEngineState().portfolio;
  let v = portfolioVerdict(p, 2.0, DAY, T0, { floorSol: 0.15 });
  assert.equal(v.next.hwmSol, 2.0, "day-open equity seeds the high-water");
  v = portfolioVerdict(v.next, 2.1, DAY, T0 + 5 * M, { floorSol: 0.15 });
  assert.equal(v.next.hwmSol, 2.1, "ratchets on up-marks");
  near(v.limitSol, 0.315);
  v = portfolioVerdict(v.next, 1.7, DAY, T0 + 10 * M, { floorSol: 0.15 });
  assert.equal(v.fire, false);
  assert.equal(v.next.streak, 1);
  v = portfolioVerdict(v.next, 1.7, DAY, T0 + 15 * M, { floorSol: 0.15 });
  assert.equal(v.next.streak, 2);
  // a recovering mark resets the streak
  v = portfolioVerdict(v.next, 1.9, DAY, T0 + 20 * M, { floorSol: 0.15 });
  assert.equal(v.next.streak, 0);
  v = portfolioVerdict(v.next, 1.7, DAY, T0 + 25 * M, { floorSol: 0.15 });
  v = portfolioVerdict(v.next, 1.7, DAY, T0 + 30 * M, { floorSol: 0.15 });
  v = portfolioVerdict(v.next, 1.7, DAY, T0 + 35 * M, { floorSol: 0.15 });
  assert.equal(v.fire, true);
  assert.equal(v.next.standDownUntil, T0 + 35 * M + 12 * H);
  assert.match(v.reason!, /portfolio breaker: equity 1.7000 SOL is 0.4000 SOL below the day's high 2.1000/);
  assert.equal(v.next.hwmSol, 1.7, "re-armed at the surviving level");
  assert.equal(standingDown(v.next, T0 + 36 * M), true);
  // standing down: nothing judged, even a crater
  v = portfolioVerdict(v.next, 0.5, DAY, T0 + 40 * M, { floorSol: 0.15 });
  assert.equal(v.fire, false);
  assert.equal(v.next.streak, 0);
  assert.equal(standingDown(v.next, T0 + 35 * M + 12 * H + 1), false);
  const e = emptyEngineState();
  e.portfolio = v.next;
  const r = clearStandDown(e);
  assert.equal(r.cleared, true);
  assert.equal(standingDown(e.portfolio, T0 + 40 * M), false);
  assert.equal(e.portfolio.day, "", "the next mark re-seeds the high-water");
  // the floor applies to a small book
  assert.equal(portfolioVerdict(emptyEngineState().portfolio, 0.5, DAY, T0, { floorSol: 0.15 }).limitSol, 0.15);
});

test("engine view: size multiplier = bench x regime, halts and stand-downs only while in force", () => {
  const e = emptyEngineState();
  recordStop(e, "pool", T0 - H);
  e.circuit.haltUntil = T0 + H;
  e.circuit.stage = 1;
  e.circuit.reason = "r";
  e.portfolio.standDownUntil = T0 - 1;
  const v = engineView(e, "pool", regimeView([-8, -9, -10]), "knife: x", 3, T0);
  assert.equal(v.sizeMultiplier, 0.25);
  assert.equal(v.haltedUntil, T0 + H);
  assert.equal(v.haltStage, 1);
  assert.equal(v.standDownUntil, null);
  assert.equal(v.knife, "knife: x");
  assert.equal(v.collectsToday, 3);
});

// ---- collect + skim ------------------------------------------------------------------------------

test("collect: claim at >= min, or after 2h pending above the floor, capped per day", () => {
  near(unclaimedFeesSol(position({ feeX: 1, feeY: 0.001 }), snapshot), 0.003);
  near(unclaimedFeesSol(position({ feeX: 0.001, feeY: 1 }), { solSide: "X", tokenPriceInSol: 0.002 }), 0.003);
  const state = freshState();
  const big = position({ feeY: 0.006 });
  const plan = collectDirective([big], snapshot, state, T0, cfg, 0)!;
  assert.equal(plan.positionAddress, "pos1");
  assert.match(plan.reason, /collect: 0.00600 SOL unclaimed on pos1 >= 0.005 SOL/);
  assert.equal(collectDirective([big], snapshot, state, T0, cfg, 30), null, "daily cap");
  assert.equal(collectDirective([big], snapshot, state, T0, { ...cfg, collectMaxPerDay: 0 }, 30)!.positionAddress, "pos1", "a cap of 0 is no cap: the 31st claim of the day goes through");
  // the pending clock: a busy band never reads zero fees, so without a reset on the claim it would claim dust every cycle
  const busy = position({ address: "pos9", feeY: 0.002 });
  trackFeesPending(state, [busy], snapshot, T0 - 3 * H, cfg.collectFloorSol);
  assert.match(collectDirective([busy], snapshot, state, T0, cfg, 0)!.reason, /pending 180 min/);
  clearFeesPending(state, ["pos9"]);
  assert.equal(state.feesPendingSince!.pos9, undefined, "the claim landed: the clock is gone");
  trackFeesPending(state, [busy], snapshot, T0 + M, cfg.collectFloorSol);
  assert.equal(collectDirective([busy], snapshot, state, T0 + 2 * M, cfg, 0), null, "fees again above the floor a minute later: two hours to wait, not one cycle");
  assert.match(collectDirective([busy], snapshot, state, T0 + M + 2 * H, cfg, 0)!.reason, /pending 120 min/);
  const small = position({ address: "pos2", feeY: 0.002 });
  assert.equal(collectDirective([small], snapshot, state, T0, cfg, 0), null, "below min, no pending clock yet");
  trackFeesPending(state, [small], snapshot, T0 - 3 * H, cfg.collectFloorSol);
  assert.equal(state.feesPendingSince!.pos2, T0 - 3 * H);
  const pend = collectDirective([small], snapshot, state, T0, cfg, 0)!;
  assert.match(pend.reason, /pending 180 min/);
  assert.equal(collectDirective([small], snapshot, state, T0 - 2 * H + M, cfg, 0), null, "not yet 2h");
  const dust = position({ address: "pos3", feeY: 0.0005 });
  trackFeesPending(state, [dust], snapshot, T0, cfg.collectFloorSol);
  assert.equal(state.feesPendingSince!.pos3, undefined, "below the floor never starts the clock");
  trackFeesPending(state, [position({ address: "pos2", feeY: 0 })], snapshot, T0, cfg.collectFloorSol);
  assert.equal(state.feesPendingSince!.pos2, undefined, "claimed: the clock clears");
  // the richest qualifying band wins
  assert.equal(collectDirective([position({ address: "a", feeY: 0.006 }), position({ address: "b", feeY: 0.009 })], snapshot, state, T0, cfg, 0)!.positionAddress, "b");
});

test("skim: dormant by default, needs a valid treasury, keeps float + gas reserve, sends 75% of fee gain", () => {
  const fees = [row({ mech: "collect", feeSol: 0.04 })];
  assert.equal(skimPlan(5, fees, "live", cfg, 0.1), null, "ENGINE_SKIM off");
  assert.equal(skimPlan(5, fees, "live", { ...cfg, skim: true }, 0.1), null, "no treasury");
  assert.equal(skimPlan(5, fees, "live", { ...cfg, skim: true, treasuryAddress: "not-a-key" }, 0.1), null, "bad treasury");
  const on = { ...cfg, skim: true, treasuryAddress: TREASURY };
  const plan = skimPlan(5, fees, "live", on, 0.1)!;
  assert.equal(plan.amountSol, 0.03);
  assert.equal(plan.lamports, 30_000_000);
  assert.equal(plan.treasury, TREASURY);
  assert.equal(skimPlan(1.05, fees, "live", on, 0.1), null, "wallet at or below float + gas reserve");
  assert.equal(skimPlan(1.12, fees, "live", on, 0.1)!.amountSol, 0.02, "capped at the excess above float + reserve");
  assert.equal(skimPlan(5, [], "live", on, 0.1), null, "no fee gain");
  assert.equal(skimPlan(5, fees, "dry-run", on, 0.1), null, "live fees do not fold into a dry-run skim");
  const skimmed = [...fees, row({ ts: T0 + M, mech: "skim", solDelta: -0.03 })];
  assert.equal(skimPlan(5, skimmed, "live", on, 0.1), null, "already skimmed");
});

// ---- directives ----------------------------------------------------------------------------------

const dctx = (over: Partial<Parameters<typeof engineDirective>[0]> = {}) => ({
  now: T0,
  snapshot,
  positions: [] as PositionSnapshot[],
  state: freshState(),
  engine: emptyEngineState(),
  cfg,
  limits,
  collectsToday: 0,
  ...over,
});

test("directives: none on a quiet book", () => {
  assert.equal(engineDirective(dctx({ positions: [position()] })), null);
});

test("directives: STOP at the per-band stop, the worst band first", () => {
  const state = freshState({ entryValueSol: { pos1: 0.3, pos2: 0.3 }, stops: { pos1: 12 } });
  const p1 = position({ valueInSol: 0.26 }); // -13.3% vs stop 12
  const p2 = position({ address: "pos2", valueInSol: 0.2, feeX: 0, feeY: 0 }); // -33.3% vs default 15
  const d = engineDirective(dctx({ positions: [p1, p2], state }))!;
  assert.equal(d.kind, "STOP");
  assert.equal(d.decision.action, "CLOSE_POSITION");
  assert.equal(d.decision.positionAddress, "pos2");
  assert.match(d.reason, /stop: pos2 is 33.3% below entry on its market value, fees aside/);
  // the same band with 0.02 SOL of fees waiting inside it reads the same market drawdown: the fees are set aside first
  const rich = engineDirective(dctx({ positions: [position({ address: "pos2", valueInSol: 0.22, feeX: 0, feeY: 0.02 })], state }))!;
  assert.match(rich.reason, /stop: pos2 is 33.3% below entry/);
  const only1 = engineDirective(dctx({ positions: [p1], state }))!;
  assert.equal(only1.decision.positionAddress, "pos1");
  assert.match(only1.reason, /stop 12.00%/);
  assert.equal(engineDirective(dctx({ positions: [position({ valueInSol: 0.27 })], state })), null, "-10% is inside a 12% stop");
});

test("directives: FLATTEN outranks STOP while standing down, largest band first, nothing once flat", () => {
  const e = emptyEngineState();
  e.portfolio.standDownUntil = T0 + H;
  e.portfolio.standDownReason = "portfolio breaker: test";
  const state = freshState({ entryValueSol: { pos1: 0.3 } });
  const d = engineDirective(dctx({ engine: e, state, positions: [position({ valueInSol: 0.2 }), position({ address: "pos2", valueInSol: 0.5 })] }))!;
  assert.equal(d.kind, "FLATTEN");
  assert.equal(d.decision.positionAddress, "pos2");
  assert.equal(engineDirective(dctx({ engine: e, positions: [] })), null);
});

test("directives: COLLECT only when the guards' rate limits would let it through", () => {
  const rich = position({ feeY: 0.01 });
  const d = engineDirective(dctx({ positions: [rich] }))!;
  assert.equal(d.kind, "COLLECT");
  assert.equal(d.decision.action, "CLAIM_FEES");
  assert.equal(d.decision.positionAddress, "pos1");
  // a recent band move does not cool a claim down; only the daily cap and the collect cap can stop it
  assert.equal(engineDirective(dctx({ positions: [rich], state: freshState({ lastActionAt: T0 - 60_000, lastMoveByPool: { pool: T0 - 60_000 } }) }))?.kind, "COLLECT", "claims are not cooled down");
  assert.equal(engineDirective(dctx({ positions: [rich], state: freshState({ actionsToday: 24 }) })), null, "daily cap");
  assert.equal(engineDirective(dctx({ positions: [rich], collectsToday: 30 })), null, "collect cap");
  // a stop beats a collect
  const state = freshState({ entryValueSol: { pos1: 0.5 } });
  assert.equal(engineDirective(dctx({ positions: [position({ feeY: 0.01, valueInSol: 0.4 })], state }))!.kind, "STOP");
});

// ---- watchdog ------------------------------------------------------------------------------------

test("watchdog: the stale window and the one-key rule", () => {
  assert.equal(staleWindowMs(300), 900_000);
  assert.equal(staleWindowMs(600), 1_800_000);
  const alive = () => true;
  const dead = () => false;
  const lock = { pid: 99, wallet: "W", startedAt: T0 - H, heartbeat: T0 - 60_000, lastIterationAt: T0 - 60_000 };
  assert.equal(lockBlocks(lock, "W", T0, 900_000, 1, alive), true, "fresh heartbeat, same wallet, alive: blocked");
  assert.equal(lockBlocks(lock, "W", T0, 900_000, 99, alive), false, "our own pid");
  assert.equal(lockBlocks(lock, "other", T0, 900_000, 1, alive), false, "a different wallet");
  assert.equal(lockBlocks({ ...lock, heartbeat: T0 - 901_000 }, "W", T0, 900_000, 1, alive), false, "stale heartbeat");
  assert.equal(lockBlocks(lock, "W", T0, 900_000, 1, dead), false, "holder is gone");
  assert.equal(lockBlocks(null, "W", T0, 900_000, 1, alive), false);
  assert.equal(loopStale({ startedAt: T0 - 2 * H, lastIterationAt: T0 - 10 * M }, T0, 900_000), false);
  assert.equal(loopStale({ startedAt: T0 - 2 * H, lastIterationAt: T0 - 16 * M }, T0, 900_000), true);
  assert.equal(loopStale({ startedAt: T0 - 16 * M, lastIterationAt: null }, T0, 900_000), true, "never completed: judged from the start");
});

// ---- USDC-quoted pools ------------------------------------------------------------------------------
// NVDAx/USDC at $180 with SOL at $102: 1 USDC = 1/102 SOL.

const SOL_USD = 102;
const NVDAX = { mint: "nvdax", symbol: "NVDAx", decimals: 8, reserve: 10_000 };
const USDC = { mint: USDC_MINT, symbol: "USDC", decimals: 6, reserve: 1_500_000 };
const usdcSnapshot: PoolSnapshot = {
  address: "pool-usdc",
  label: "NVDAx/USDC",
  tokenX: NVDAX,
  tokenY: USDC,
  solSide: null,
  baseToken: NVDAX,
  binStep: 10,
  activeBinId: 4200,
  activePrice: 180,
  priceLabel: "USDC per NVDAx",
  tokenPriceInSol: 180 / SOL_USD,
  quoteSide: "Y",
  quoteToken: USDC,
  quoteSymbol: "USDC",
  quotePriceInSol: 1 / SOL_USD,
  tokenPriceInQuote: 180,
  solPriceUsd: SOL_USD,
  baseFeePct: 0.1,
  maxFeePct: 5,
  dynamicFeePct: 0.12,
  bins: [],
  liquidityBelowY: 250_000,
  liquidityAboveX: 1_200,
  fetchedAt: new Date().toISOString(),
};
const usdcXSnapshot: PoolSnapshot = { ...usdcSnapshot, address: "pool-usdc-x", label: "USDC/NVDAx", tokenX: USDC, tokenY: NVDAX, activePrice: 1 / 180, quoteSide: "X" };

test("quote: a snapshot without quote fields reads as SOL-quoted; a USDC snapshot converts at the SOL price", () => {
  const legacy = quoteOf(snapshot);
  assert.deepEqual([legacy.side, legacy.symbol, legacy.priceInSol, legacy.tokenPriceInQuote, legacy.token.symbol], ["Y", "SOL", 1, 0.002, "SOL"]);
  assert.deepEqual(quoteMath({ solSide: "X", tokenPriceInSol: 0.002 }), { side: "X", priceInSol: 1, tokenPriceInQuote: 0.002 });
  const u = quoteOf(usdcSnapshot);
  assert.deepEqual([u.side, u.symbol, u.token.mint], ["Y", "USDC", USDC_MINT]);
  near(u.priceInSol, 1 / SOL_USD);
  near(u.tokenPriceInQuote, 180);
  near(usdcSnapshot.tokenPriceInSol, u.tokenPriceInQuote * u.priceInSol, "tokenPriceInSol = tokenPriceInQuote x quotePriceInSol");
  // valuation: 1 NVDAx + 100 USDC = 280 USDC = 280/102 SOL; the SOL pool is unchanged
  near(toQuote(1, 100, usdcSnapshot), 280);
  near(toSol(1, 100, usdcSnapshot), 280 / SOL_USD);
  near(toSol(100, 1, usdcXSnapshot), 280 / SOL_USD, "quote on the X side");
  near(toSol(10, 0.25, snapshot), 0.27);
});

test("quote: the executor maps amountSol onto the quote side and values the entry in SOL", () => {
  const o = { side: "SOL_ONLY" as const, amountSol: 40, amountToken: 0, binsBelowActive: 19, binsAboveActive: 0, strategy: "Spot" as const };
  const y = toOpenPlan(o, usdcSnapshot);
  assert.equal(y.amountY.toString(), "40000000", "40 USDC on Y, 6 decimals");
  assert.equal(y.amountX.toString(), "0");
  const x = toOpenPlan(o, usdcXSnapshot);
  assert.equal(x.amountX.toString(), "40000000", "the quote sits on X here");
  assert.equal(x.amountY.toString(), "0");
  near(entryValueOf(o, usdcSnapshot), 40 / SOL_USD);
  near(entryValueOf({ ...o, side: "BOTH", amountToken: 1 }, usdcSnapshot), 220 / SOL_USD);
  const sol = toOpenPlan({ ...o, amountSol: 0.25 }, snapshot);
  assert.equal(sol.amountY.toString(), "250000000", "SOL pool: unchanged mapping");
  near(entryValueOf({ ...o, amountSol: 0.25 }, snapshot), 0.25);
});

test("collect: fees in a USDC pool are valued through quotePriceInSol", () => {
  const p = position({ feeX: 1, feeY: 20 }); // 1 NVDAx + 20 USDC = 200 USDC
  near(unclaimedFeesQuote(p, usdcSnapshot), 200);
  near(unclaimedFeesSol(p, usdcSnapshot), 200 / SOL_USD);
  near(unclaimedFeesSol(position({ feeX: 20, feeY: 1 }), usdcXSnapshot), 200 / SOL_USD);
  // 0.6 USDC of fees = 0.00588 SOL: over the 0.005 SOL collect threshold
  const plan = collectDirective([position({ feeY: 0.6 })], usdcSnapshot, freshState(), T0, cfg, 0)!;
  assert.equal(plan.positionAddress, "pos1");
  assert.match(plan.reason, /collect: 0.00588 SOL unclaimed/);
  assert.equal(collectDirective([position({ feeY: 0.4 })], usdcSnapshot, freshState(), T0, cfg, 0), null, "0.4 USDC = 0.0039 SOL is under the threshold");
  const state = freshState();
  trackFeesPending(state, [position({ feeY: 0.15 })], usdcSnapshot, T0, cfg.collectFloorSol); // 0.00147 SOL > 0.001 floor
  assert.equal(state.feesPendingSince!.pos1, T0);
});

test("ledger: quote fields default to SOL on old rows and fold in SOL on USDC rows", () => {
  const old = quoteOfRow(row({ solDelta: -0.25 }));
  assert.deepEqual(old, { quoteMint: "So11111111111111111111111111111111111111112", quoteDelta: -0.25, markQuoteInSol: 1 });
  const usdcOpen = row({ mech: "open", solDelta: -40 / SOL_USD, quoteDelta: -40, quoteMint: USDC_MINT, markQuoteInSol: 1 / SOL_USD, markTokenInSol: 180 / SOL_USD, tokenMint: "nvdax", rentSol: -0.0574 });
  const usdcClose = row({ ts: T0 + H, mech: "close", solDelta: 30 / SOL_USD, quoteDelta: 30, quoteMint: USDC_MINT, markQuoteInSol: 1 / SOL_USD, tokenDelta: 0.06, markTokenInSol: 180 / SOL_USD, tokenMint: "nvdax", rentSol: 0.0574, feeSol: 0.5 / SOL_USD, entryValueSol: 40 / SOL_USD });
  const q = quoteOfRow(usdcClose);
  near(q.quoteDelta, 30);
  near(q.quoteDelta * q.markQuoteInSol, usdcClose.solDelta, "solDelta is the quote leg at the row's mark");
  const mixed = [...rows, usdcOpen, usdcClose];
  const r6 = (n: number) => Math.round(n * 1e6) / 1e6; // the folds round to 6 decimals
  near(netCashSol(mixed, "live"), r6(netCashSol(rows, "live") + (-40 / SOL_USD - 0.0574 - 0.00001) + (30 / SOL_USD + 0.0574 - 0.00001)));
  near(feesRealizedSol(mixed, "live"), r6(0.007 + 0.5 / SOL_USD));
  const inv = inventory(mixed, "live").find((l) => l.mint === "nvdax")!;
  near(inv.units, 0.06);
  near(inv.markedSol, r6(0.06 * (180 / SOL_USD)));
  // realized today: the close gives back 30 USDC + 0.06 NVDAx at mark against a 40 USDC entry
  const closeBack = 30 / SOL_USD + 0.06 * (180 / SOL_USD);
  near(realizedOnDaySol(mixed, "live", DAY), r6(realizedOnDaySol(rows, "live", DAY) + (closeBack - 0.00001 - 40 / SOL_USD) - 0.00001));
});

test("rangeOverWindowPct: the travel high to low, not the net move", () => {
  const now = 1_000_000;
  const h = [
    { ts: now - 50 * 60_000, price: 100 },
    { ts: now - 30 * 60_000, price: 103 },
    { ts: now - 10 * 60_000, price: 99 },
    { ts: now, price: 100 },
  ];
  // up 3, down 4, back to where it started: the net move is 0% and the travel is 4.04%
  assert.equal(Math.round(rangeOverWindowPct(h, now)! * 100) / 100, 4.04);
  // samples outside the window do not count
  assert.equal(rangeOverWindowPct([{ ts: now - 120 * 60_000, price: 50 }, ...h], now, 60 * 60_000)!.toFixed(2), "4.04");
  assert.equal(rangeOverWindowPct([h[0]], now), null, "one sample says nothing");
  assert.equal(rangeOverWindowPct(undefined, now), null);
});

test("moveAfterSec: a band moves once the fees it is missing cover the move", () => {
  // $0.90 to move, $2,000/day of fees when in range: the foregone fees cover it in about 39 seconds,
  // so the 60s floor binds. The same move on a venue charging $21 waits fifteen minutes.
  assert.equal(moveAfterSec(0.9, 2000, 60), 60);
  assert.equal(Math.round(moveAfterSec(21, 2000, 60)), 907);
  // no fee estimate, or a free move: the configured minimum is all we have
  assert.equal(moveAfterSec(0.9, null, 600), 600);
  assert.equal(moveAfterSec(0, 2000, 600), 600);
  // a dead band is not held forever
  assert.equal(moveAfterSec(21, 0.5, 60), 3600);
});

test("the knives: a drop in the last cycle alone and a slow bleed over hours refuse opens beside the 30-minute crash", () => {
  const env = { knifePct: 20, cycleKnifePct: 5, cycleMs: 5 * M, slowKnifePct: 10, slowKnifeMs: 240 * M };
  // the flash crash of the scenario harness: -40% in ten minutes, the cycle halfway down it reads -19.9%, under the 30-minute knife
  const crash = [{ ts: T0 - 10 * M, price: 1 }, { ts: T0 - 5 * M, price: 1 }, { ts: T0, price: 0.801 }];
  assert.equal(knifeReason(crash, T0, 20), null, "the 30-minute knife lets -19.9% through");
  assert.match(knivesReason(crash, T0, env)!, /^knife: -19\.9% since the last cycle \(limit 5% a cycle\)$/);
  // -4% in a cycle is inside the per-cycle knife
  assert.equal(knivesReason([{ ts: T0 - 5 * M, price: 1 }, { ts: T0, price: 0.96 }], T0, env), null);
  // early cycles 90 s apart read the whole drop inside the last cycle and a half, not just the last 90 s
  const early = [{ ts: T0 - 6 * M, price: 1 }, { ts: T0 - 3 * M, price: 0.98 }, { ts: T0 - 1.5 * M, price: 0.96 }, { ts: T0, price: 0.94 }];
  assert.equal(Math.round(cycleDropPct(early, 5 * M)! * 10) / 10, 6);
  // a pool coming back after a sit-out has no last cycle: an hour-old sample is the slower knives' business
  assert.equal(cycleDropPct([{ ts: T0 - 60 * M, price: 1 }, { ts: T0, price: 0.9 }], 5 * M), null);
  assert.equal(knivesReason([{ ts: T0 - 60 * M, price: 1 }, { ts: T0, price: 0.93 }], T0, env), null);
  // the 30-minute knife still reads first
  assert.match(knivesReason([{ ts: T0 - 20 * M, price: 1 }, { ts: T0 - 5 * M, price: 0.75 }, { ts: T0, price: 0.74 }], T0, env)!, /in 30 min \(limit 20%\)$/);
  // a slow bleed, -5% an hour sampled every five minutes: no cycle and no half hour trips, four hours do
  const bleed = Array.from({ length: 61 }, (_, i) => ({ ts: T0 - (300 - i * 5) * M, price: Math.pow(0.95, (i * 5) / 60) }));
  assert.equal(knifeReason(bleed, T0, 20), null);
  assert.equal(cycleDropPct(bleed, 5 * M)! < 1, true);
  assert.match(knivesReason(bleed, T0, env)!, /^knife: -18\.5% in 240 min \(limit 10%\)$/);
  // two hours into it (-9.75%) the slow knife still waits
  assert.equal(knivesReason(bleed.filter((b) => b.ts <= T0 - 180 * M), T0 - 180 * M, env), null);
  // 0 turns either knife off
  assert.match(knivesReason(crash, T0, { ...env, cycleKnifePct: 0 })!, /in 240 min/, "the per-cycle knife off: the slow one still reads the drop");
  assert.equal(knivesReason(crash, T0, { ...env, cycleKnifePct: 0, slowKnifePct: 0 }), null);
  assert.equal(knivesReason(bleed, T0, { ...env, slowKnifePct: 0 }), null);
});

test("priorRangeOverWindowPct: the hour's travel before this cycle's sample, so the last move's own travel can be told apart", () => {
  const h = [{ ts: T0 - 50 * M, price: 1 }, { ts: T0 - 25 * M, price: 1.002 }, { ts: T0 - 5 * M, price: 1 }, { ts: T0, price: 0.96 }];
  near(Math.round(priorRangeOverWindowPct(h, T0)! * 1000) / 1000, 0.2);
  near(Math.round(rangeOverWindowPct(h, T0)! * 100) / 100, 4.38);
  assert.equal(priorRangeOverWindowPct(h.slice(-2), T0), null, "two samples: nothing before the last to read");
  assert.equal(priorRangeOverWindowPct(undefined, T0), null);
});

test("downExitOf: a stop, or a quote-only band closed through its range at a loss, is a down exit; an ask, a re-lay, a straddle or a close in profit is not", () => {
  const through = position({ inRange: false, binsFromRange: -6, valueInSol: 0.2, entryValueSol: 0.25, amountX: 90, amountY: 0 });
  const base = { closed: true, stopped: false, action: "CLOSE_POSITION" as const, band: through, quoteSide: "Y" as const, quoteOnly: true };
  assert.equal(downExitOf(base), "through-band");
  assert.equal(downExitOf({ ...base, stopped: true }), "stop");
  assert.equal(downExitOf({ ...base, stopped: true, quoteOnly: false }), "stop", "a stop is a stop in any pool");
  assert.equal(downExitOf({ ...base, band: { ...through, valueInSol: 0.26 } }), null, "through the band but up on the seat");
  assert.equal(downExitOf({ ...base, band: { ...through, binsFromRange: 3 } }), null, "the price ran off the quote side: an idle band");
  assert.equal(downExitOf({ ...base, quoteSide: "X", band: { ...through, binsFromRange: 6 } }), "through-band", "a quote-X band is run through from below");
  assert.equal(downExitOf({ ...base, quoteOnly: false }), null, "a straddle's close is the stock lane's");
  assert.equal(downExitOf({ ...base, exitAsk: true }), null, "an ask exit: the chain is still working the token");
  assert.equal(downExitOf({ ...base, action: "REBALANCE" }), null);
  assert.equal(downExitOf({ ...base, closed: false }), null);
  assert.equal(downExitOf({ ...base, band: { ...through, entryValueSol: undefined } }), null, "no entry, no loss to read");
  // on the bench ladder beside the stops: a bleed's third losing close benches the pool
  const e = emptyEngineState();
  recordStop(e, "pool", T0 - 2 * H);
  assert.match(benchView(e, "pool", T0).reason!, /^1 stop-loss close or losing close through the band in the last 6h: size x0\.5$/);
  recordStop(e, "pool", T0 - 1 * H);
  recordStop(e, "pool", T0);
  assert.match(benchView(e, "pool", T0).reason!, /^benched: 3 stop-loss closes or losing closes through the band in the last 6h/);
});

test("the out-of-range wait counts what waiting can save: an idle band's re-lay rent at its own width; a band run through keeps the bare rent unless ENGINE_WAIT_COUNTS_SALE", () => {
  // the cost of leaving a band full of token: 44 SOL of it at 0.66% (the pool's current fee) and 0.4% of impact
  const c = bandMoveCostSol({ tokenUi: 22_000, tokenPriceInSol: 0.002, feePct: 0.66, impactPct: 0.4, relaySunkSol: 0.0715 });
  near(c.saleSol, 44 * 0.0106);
  near(c.relaySol, 0.0715);
  near(c.totalSol, 44 * 0.0106 + 0.0715);
  // at $117 and $4,500 a day of the band's fees that is paid for after about 16 minutes, where the rent alone waits the floor
  assert.equal(Math.round(moveAfterSec(c.totalSol * 117, 4500, 120)), Math.round((c.totalSol * 117) / (4500 / 86400)));
  assert.equal(moveAfterSec(0, 4500, 120), 120);
  // the pool, band by band, from the snapshot's own bins
  const bins = Array.from({ length: 21 }, (_, i) => ({ binId: 250 + i, price: 0.002, xAmount: 250 + i > 260 ? 5000 : 0, yAmount: 250 + i < 260 ? 9 : 0, isActive: 250 + i === 260 }));
  const s = { ...snapshot, bins };
  const through = position({ lowerBinId: 265, upperBinId: 284, inRange: false, binsFromRange: -5, amountX: 4_000, amountY: 0, feeX: 10, feeY: 0 });
  const idle = position({ lowerBinId: 230, upperBinId: 249, inRange: false, binsFromRange: 11, amountX: 0, amountY: 8, feeX: 0, feeY: 0 });
  const sunk: [number, number][] = [];
  const opts = { quoteSide: "Y" as const, tokenPriceInQuote: 0.002, quoteOnly: true, countSale: false, feePct: 0.66, impactCapPct: 8, rentOnlySol: 0, relaySunkSol: (below: number, above: number) => (sunk.push([below, above]), 0.0715) };
  // an idle band waits for its re-lay into a fresh bin array: the rent it would leave behind (it used to read the active bin's array alone: 0)
  near(poolMoveCostSol([idle], s, opts), 0.0715, "the re-lay's rent at the band's own width");
  assert.deepEqual(sunk, [[19, 0]], "costed as a band of its width from the price, on the quote side");
  // a band the price went through keeps the bare rent: its sale and its re-lay come whenever it leaves unless the price comes back
  near(poolMoveCostSol([through], s, opts), 0, "the bare rent, as before");
  near(poolMoveCostSol([through, idle], s, opts), 0.0715, "the costliest band of the pool");
  // ENGINE_WAIT_COUNTS_SALE: the sale at the fee plus the impact of walking the bins, and the re-lay
  const counted = poolMoveCostSol([through], s, { ...opts, countSale: true });
  assert.ok(counted > 4010 * 0.002 * 0.0066 + 0.0715, `the sale's fee, its impact and the re-lay's rent: ${counted}`);
  const impact = binWalkImpactPct({ bins, activeBinId: 260, quoteSide: "Y", binStepBps: 20, tokenPriceInQuote: 0.002 }, "sell", 4010);
  assert.ok(impact > 0, "a 4,010-token sale walks past the active bin");
  near(counted, 0.0715 + (4010 * 0.002 * (0.66 + impact)) / 100, "the sale at its fee and impact, and the re-lay");
  // a straddle's pool and a pool of ours keep the bare rent
  near(poolMoveCostSol([through, idle], s, { ...opts, quoteOnly: false, countSale: true, rentOnlySol: 0.01 }), 0.01);
  // a re-lay the venue cannot cost keeps the bare rent
  near(poolMoveCostSol([idle], s, { ...opts, relaySunkSol: () => { throw new Error("no plan"); }, rentOnlySol: 0.02 }), 0.02);
});

// ---- the ask exit (src/engine/askExit.ts) --------------------------------------------------------

test("askExitEnv: off unless EXIT_ASK=true; the knobs default and floor", () => {
  assert.equal(askExitEnv({}).on, false);
  assert.equal(askExitEnv({ EXIT_ASK: "TRUE " }).on, true);
  assert.deepEqual(askExitEnv({}), { on: false, coverPct: 3, minSol: 0.2, stopPct: 10, maxHoldMin: 240, relaySec: 180, onStop: false });
  const e = askExitEnv({ EXIT_ASK: "true", EXIT_ASK_COVER_PCT: "5", EXIT_ASK_MIN_SOL: "0.5", EXIT_ASK_STOP_PCT: "8", EXIT_ASK_MAX_MIN: "0", EXIT_ASK_RELAY_SEC: "-5", EXIT_ASK_ON_STOP: "true" });
  assert.deepEqual(e, { on: true, coverPct: 5, minSol: 0.5, stopPct: 8, maxHoldMin: 0, relaySec: 0, onStop: true });
  assert.equal(askExitEnv({ EXIT_ASK_COVER_PCT: "abc" }).coverPct, 3);
});

test("askBinsFor: the bins that reach the cover at this step, at least one, inside the width", () => {
  assert.equal(askBinsFor(100, 3, 69), 3); // 1%/bin: three bins for 3%
  assert.equal(askBinsFor(20, 3, 69), 15); // 0.2%/bin
  assert.equal(askBinsFor(100, 0.1, 69), 1);
  assert.equal(askBinsFor(1, 50, 69), 68); // capped at the width less the active bin
});

const throughBand = (over: Partial<PositionSnapshot> = {}): PositionSnapshot =>
  position({ inRange: false, binsFromRange: -3, amountX: 130, amountY: 0, feeX: 2, feeY: 0.0004, valueInSol: 0.2644, solInPosition: 0.0004, entryValueSol: 0.3, ...over });

const closeOf = (over: Partial<Decision> = {}): Decision => ({ action: "CLOSE_POSITION", open: null, positionAddress: "pos1", liquidate: true, reasoning: "Through the band.", confidence: 0.75, headline: "3 bins through the band and 700s out. Off the table.", ...over });

test("askExitOf: a close that would sell the token becomes a REBALANCE into a TOKEN_ONLY ask band from the active bin up, marked exitAsk", () => {
  const env = askExitEnv({ EXIT_ASK: "true" });
  const d = askExitOf(closeOf(), { snapshot, positions: [throughBand()], walletToken: 0.5, askBands: {}, env, maxBinWidth: 69 })!;
  assert.ok(d);
  assert.equal(d.action, "REBALANCE");
  assert.equal(d.exitAsk, true);
  assert.equal(d.liquidate, undefined);
  assert.equal(d.positionAddress, "pos1");
  // the band's token incl. its base fees, plus the wallet's, floored to six decimals; SOL side zero; from the active bin 3% up at 0.2%/bin
  assert.deepEqual(d.open, { side: "TOKEN_ONLY", amountSol: 0, amountToken: 132.5, binsBelowActive: 0, binsAboveActive: 15, strategy: "Spot" });
  assert.ok(d.headline.endsWith("Laid as an ask."), d.headline);
  assert.ok(d.headline.includes("through the band"), "the lesson still reads the reason off the headline");
  assert.ok(d.reasoning.includes("laid as an ask band from bin 260 15 bins up"));
  assert.ok(isAskExit(d));
  assert.ok(!isAskExit(closeOf()));
});

test("askExitOf: stays a sale when off, when the token is not worth a position, for an ask band's own close, or for a band not on the book", () => {
  const on = askExitEnv({ EXIT_ASK: "true" });
  assert.equal(askExitOf(closeOf(), { snapshot, positions: [throughBand()], walletToken: 0, askBands: {}, env: askExitEnv({}), maxBinWidth: 69 }), null);
  // 130 ANSEM at 0.002 = 0.26 SOL: over the 0.2 SOL default, under a 0.5 SOL floor
  assert.equal(askExitOf(closeOf(), { snapshot, positions: [throughBand()], walletToken: 0, askBands: {}, env: askExitEnv({ EXIT_ASK: "true", EXIT_ASK_MIN_SOL: "0.5" }), maxBinWidth: 69 }), null);
  // an all-SOL band (idle, pulled) holds no token: nothing to lay
  assert.equal(askExitOf(closeOf(), { snapshot, positions: [position()], walletToken: 0, askBands: {}, env: on, maxBinWidth: 69 }), null);
  const ask = askBandRecord(undefined, { pool: "pool", from: "bid", tokens: 130, markSol: 0.26, now: T0 });
  assert.equal(askExitOf(closeOf(), { snapshot, positions: [throughBand()], walletToken: 0, askBands: { pos1: ask }, env: on, maxBinWidth: 69 }), null);
  assert.equal(askExitOf(closeOf({ positionAddress: "nope" }), { snapshot, positions: [throughBand()], walletToken: 0, askBands: {}, env: on, maxBinWidth: 69 }), null);
  assert.equal(askExitOf(closeOf({ action: "HOLD" }), { snapshot, positions: [throughBand()], walletToken: 0, askBands: {}, env: on, maxBinWidth: 69 }), null);
});

test("askOpenParams: the ask sits on the token side of the active bin (up when the quote is Y, down when it is X)", () => {
  const up = askOpenParams(100, snapshot, { coverPct: 2 }, 69);
  assert.deepEqual([up.binsBelowActive, up.binsAboveActive], [0, 10]);
  const usdcX: PoolSnapshot = { ...snapshot, tokenX: { mint: USDC_MINT, symbol: "USDC", decimals: 6, reserve: 1 }, tokenY: { mint: "nvdax", symbol: "NVDAx", decimals: 8, reserve: 1 }, baseToken: { mint: "nvdax", symbol: "NVDAx", decimals: 8, reserve: 1 }, solSide: null, quoteSide: "X", quotePriceInSol: 0.005, tokenPriceInQuote: 180, tokenPriceInSol: 0.9 };
  const down = askOpenParams(1.23456789, usdcX, { coverPct: 2 }, 69);
  assert.deepEqual([down.binsBelowActive, down.binsAboveActive], [10, 0]);
  assert.equal(down.amountToken, 1.234567, "floored to six decimals");
});

test("askBandRecord: the first ask starts the chain at this mark and clock; a re-lay carries them, counts, and banks what the closing link handed back", () => {
  const first = askBandRecord(undefined, { pool: "pool", from: "bid", tokens: 130, markSol: 0.26, now: T0 });
  assert.deepEqual(first, { pool: "pool", since: T0, basisSol: 0.26, from: "bid", tokens: 130, relays: 0, bankedSol: 0 });
  const again = askBandRecord(first, { pool: "pool", from: "ask1", tokens: 131, markSol: 0.22, now: T0 + 10 * M, bankedSol: 0.01 });
  assert.deepEqual(again, { pool: "pool", since: T0, basisSol: 0.26, from: "bid", tokens: 131, relays: 1, bankedSol: 0.01 });
  const third = askBandRecord(again, { pool: "pool", from: "ask2", tokens: 131, markSol: 0.2, now: T0 + 20 * M, bankedSol: 0.015 });
  assert.equal(third.bankedSol, 0.025);
  assert.equal(third.relays, 2);
});

test("askStopBasis / stopEntryOf: the chain's stop measures what is left against the basis less what it banked; nothing to protect once it is whole", () => {
  const a = askBandRecord(undefined, { pool: "pool", from: "bid", tokens: 1000, markSol: 10, now: T0 });
  assert.equal(askStopBasis(a), 10);
  // the chain sold 4 SOL of the token on the way up and handed it back at the re-lay: the 6 SOL still on the book is the whole of what is left
  const relaid = askBandRecord(a, { pool: "pool", from: "ask1", tokens: 600, markSol: 6, now: T0 + 5 * M, bankedSol: 4 });
  assert.equal(askStopBasis(relaid), 6);
  const state = freshState({ entryValueSol: { ask2: 6 }, stops: { ask2: 10 }, askBands: { ask2: relaid } });
  const p = position({ address: "ask2", inRange: false, binsFromRange: -3, amountX: 600, amountY: 0, feeX: 0, feeY: 0, valueInSol: 5.94, solInPosition: 0 });
  assert.equal(engineDirective(dctx({ positions: [p], state })), null, "1% under what is left: no stop");
  // without the banked SOL the same band would read 41% down and be sold: the bug this field exists for
  const naive = freshState({ entryValueSol: { ask2: 6 }, stops: { ask2: 10 }, askBands: { ask2: { ...relaid, bankedSol: 0 } } });
  assert.equal(engineDirective(dctx({ positions: [p], state: naive }))!.kind, "STOP");
  // banked the whole basis back: the chain is whole whatever the rest is worth
  const whole = askBandRecord(a, { pool: "pool", from: "ask1", tokens: 100, markSol: 1, now: T0 + 9 * M, bankedSol: 10 });
  assert.equal(askStopBasis(whole), undefined);
  assert.equal(stopEntryOf(freshState({ entryValueSol: { ask3: 1 }, askBands: { ask3: whole } }), position({ address: "ask3" })), undefined);
  assert.equal(engineDirective(dctx({ positions: [position({ address: "ask3", inRange: false, binsFromRange: -9, amountX: 100, amountY: 0, feeX: 0, feeY: 0, valueInSol: 0.5, solInPosition: 0 })], state: freshState({ entryValueSol: { ask3: 1 }, stops: { ask3: 10 }, askBands: { ask3: whole } }) })), null);
});

test("stopEntryOf: an ask band's stop reads the chain's basis, every other band its entry", () => {
  const ask = askBandRecord(undefined, { pool: "pool", from: "bid", tokens: 130, markSol: 0.26, now: T0 });
  const state = freshState({ entryValueSol: { ask1: 0.22, pos1: 0.3 }, askBands: { ask1: ask } });
  assert.equal(stopEntryOf(state, position({ address: "ask1" })), 0.26);
  assert.equal(stopEntryOf(state, position({ address: "pos1" })), 0.3);
  assert.equal(stopEntryOf(state, position({ address: "pos9", entryValueSol: 0.1 })), 0.1);
});

test("directives: STOP measures an ask band against the chain's basis, not the re-lay's mark", () => {
  const ask = askBandRecord(undefined, { pool: "pool", from: "bid", tokens: 130, markSol: 0.3, now: T0 });
  // re-laid at 0.25; now worth 0.26: 13% under the chain's basis, up on its own entry
  const state = freshState({ entryValueSol: { ask1: 0.25 }, stops: { ask1: 10 }, askBands: { ask1: ask } });
  const p = position({ address: "ask1", inRange: false, binsFromRange: -4, amountX: 130, amountY: 0, feeX: 0, feeY: 0, valueInSol: 0.26, solInPosition: 0 });
  const d = engineDirective(dctx({ positions: [p], state }))!;
  assert.equal(d.kind, "STOP");
  assert.ok(d.reason.includes("ask band ask1") && d.reason.includes("13.3% below the mark its chain was laid at"), d.reason);
  // the same band on its own entry alone would be up: no stop
  const own = freshState({ entryValueSol: { ask1: 0.25 }, stops: { ask1: 10 } });
  assert.equal(engineDirective(dctx({ positions: [p], state: own })), null);
});

test("directives: COLLECT never claims on an ask band (its close claims; a claim would take the cycle its sold-out close needs)", () => {
  const ask = askBandRecord(undefined, { pool: "pool", from: "bid", tokens: 130, markSol: 0.26, now: T0 });
  // an ask band sold out, fat with quote fees
  const p = position({ address: "ask1", inRange: false, binsFromRange: 3, amountX: 0, amountY: 0.27, feeX: 0, feeY: 0.02, valueInSol: 0.29, solInPosition: 0.29 });
  const withRecord = freshState({ entryValueSol: { ask1: 0.26 }, askBands: { ask1: ask } });
  assert.equal(engineDirective(dctx({ positions: [p], state: withRecord })), null);
  const plain = engineDirective(dctx({ positions: [p], state: freshState({ entryValueSol: { ask1: 0.26 } }) }))!;
  assert.equal(plain.kind, "COLLECT", "the same band without the record is claimed on");
});

test("askOpenParams never lays more than is held: the floor cannot round over the sum the guards check", () => {
  for (const tokens of [0.1 + 0.2, 132.5, 1 / 3, 1e-7 + 5, 999999.9999995]) {
    const o = askOpenParams(tokens, snapshot, { coverPct: 3 }, 69);
    assert.ok(o.amountToken <= tokens, `${o.amountToken} > ${tokens}`);
    assert.ok(o.amountToken >= tokens - 1e-6 - 1e-12, `${o.amountToken} too far under ${tokens}`);
  }
});

test("directives: EXPIRE ends an ask chain past EXIT_ASK_MAX_MIN, liquidating; not before, not without a limit", () => {
  const ask = askBandRecord(undefined, { pool: "pool", from: "bid", tokens: 130, markSol: 0.26, now: T0 - 241 * M });
  const state = freshState({ entryValueSol: { ask1: 0.26 }, askBands: { ask1: ask } });
  const p = position({ address: "ask1", inRange: false, binsFromRange: -2, amountX: 130, amountY: 0, feeX: 0, feeY: 0, valueInSol: 0.26, solInPosition: 0 });
  const d = engineDirective(dctx({ positions: [p], state, askExit: { maxHoldMin: 240 } }))!;
  assert.equal(d.kind, "EXPIRE");
  assert.equal(d.decision.action, "CLOSE_POSITION");
  assert.equal(d.decision.liquidate, true);
  assert.ok(d.reason.includes("241 min (limit 240"), d.reason);
  assert.equal(engineDirective(dctx({ positions: [p], state, askExit: { maxHoldMin: 300 } })), null);
  assert.equal(engineDirective(dctx({ positions: [p], state, askExit: { maxHoldMin: 0 } })), null);
  assert.equal(engineDirective(dctx({ positions: [p], state })), null);
  // another pool's ask is not this pool's
  assert.equal(askExpiry([p], { ask1: { ...ask, pool: "other" } }, "pool", T0, 240), null);
});

test("antiChurn: a sold-out ask closes at once; one under the price follows it after the relay wait; its final close is never churn", () => {
  const ask = askBandRecord(undefined, { pool: "pool", from: "bid", tokens: 130, markSol: 0.26, now: T0 - 10 * M });
  const state = freshState({ entryValueSol: { ask1: 0.26 }, stops: { ask1: 10 }, outOfRangeSince: { ask1: T0 - 30_000 }, askBands: { ask1: ask } });
  const close = closeOf({ positionAddress: "ask1" });
  const relay: Decision = { ...close, action: "REBALANCE", liquidate: undefined, exitAsk: true, open: askOpenParams(130, snapshot, { coverPct: 3 }, 69) };
  const sold = position({ address: "ask1", inRange: false, binsFromRange: 5, amountX: 0, amountY: 0.27, valueInSol: 0.27, solInPosition: 0.27 });
  const under = position({ address: "ask1", inRange: false, binsFromRange: -5, amountX: 130, amountY: 0, valueInSol: 0.25, solInPosition: 0 });
  const askArg = { relaySec: 180, quoteSide: "Y" as const };
  assert.equal(antiChurn(close, [sold], state, limits, 600, T0, snapshot, undefined, askArg), null, "sold out: the close is the exit's completion");
  assert.equal(antiChurn(relay, [sold], state, limits, 600, T0, snapshot, undefined, askArg), null);
  assert.match(antiChurn(relay, [under], state, limits, 600, T0, snapshot, undefined, askArg)!, /ask band ask1 is under the price for 30s, it follows the price after 180s/);
  assert.equal(antiChurn(relay, [under], state, limits, 600, T0 + 160_000, snapshot, undefined, askArg), null, "past the relay wait");
  assert.equal(antiChurn(close, [under], state, limits, 600, T0, snapshot, undefined, askArg), null, "the chain's end is an exit");
  // a bid band is judged as before; its ask exit (a REBALANCE marked exitAsk, no sale) waits the ask's wait, not the paid-move minimum
  const bid = freshState({ entryValueSol: { pos1: 0.3 }, outOfRangeSince: { pos1: T0 - 30_000 } });
  assert.match(antiChurn(closeOf(), [throughBand({ valueInSol: 0.29 })], bid, limits, 600, T0, snapshot, undefined, askArg)!, /anti-churn: pos1 is out of range for 30s, minimum 600s/);
  const exitAsk: Decision = { ...closeOf(), action: "REBALANCE", liquidate: undefined, exitAsk: true, open: askOpenParams(132, snapshot, { coverPct: 3 }, 69) };
  assert.match(antiChurn(exitAsk, [throughBand({ valueInSol: 0.29 })], bid, limits, 600, T0, snapshot, undefined, askArg)!, /minimum 180s/);
  assert.equal(antiChurn(exitAsk, [throughBand({ valueInSol: 0.29 })], bid, limits, 600, T0 + 160_000, snapshot, undefined, askArg), null);
  assert.match(antiChurn(exitAsk, [throughBand({ valueInSol: 0.29 })], bid, limits, 600, T0 + 160_000, snapshot, undefined, undefined)!, /minimum 600s/, "without the ask's wait the ordinary minimum stands");
});

test("forgetBand clears the ask record; askPoolsOf / askOnlyPools read the book", () => {
  const ask = askBandRecord(undefined, { pool: "pool", from: "bid", tokens: 130, markSol: 0.26, now: T0 });
  const state = freshState({ entryValueSol: { ask1: 0.26 }, askBands: { ask1: ask, ask2: { ...ask, pool: "pool2" } } });
  assert.deepEqual([...askPoolsOf(state.askBands)].sort(), ["pool", "pool2"]);
  const only = askOnlyPools(state.askBands, new Map([["pool", [position({ address: "ask1" })]], ["pool2", [position({ address: "ask2" }), position({ address: "bid2" })]], ["pool3", []]]));
  assert.deepEqual([...only], ["pool"]);
  forgetBand(state, "ask1");
  assert.deepEqual(Object.keys(state.askBands!), ["ask2"]);
  assert.equal(askOnlyPools(undefined, new Map()).size, 0);
});

// ---- the marks when a pool cannot be observed (src/engine/marks.ts) ----------------------------------

const blindInput = (over: Partial<Parameters<typeof carriedBands>[0]> = {}): Parameters<typeof carriedBands>[0] => ({
  blindPools: ["blind"],
  held: ["b1"],
  marks: { b1: { pool: "blind", valueSol: 0.4, at: T0 - 5 * M } },
  entryValueSol: { b1: 0.5 },
  metaPool: {},
  stops: {},
  stopLossPct: 15,
  ...over,
});

test("marks: a band in a blind pool is carried at its last mark less the haircut, and raises the measured drawdown", () => {
  const seen = [{ valueInSol: 0.3, entryValueSol: 0.3 }];
  const carried = carriedBands(blindInput());
  assert.equal(carried.length, 1);
  assert.equal(carried[0].basis, "last mark");
  near(carried[0].valueInSol, 0.4 * (1 - CARRY_HAIRCUT_PCT / 100));
  const without = markedDrawdownSol(seen);
  const withCarry = markedDrawdownSol([...seen, ...carried]);
  near(without, 0);
  near(withCarry, 0.38 - 0.5, "0.12 below its entry, counted");
  assert.ok(circuitLossSol(0, withCarry) > circuitLossSol(0, without));
  // a pool that is not blind carries nothing: its bands are read this cycle
  assert.deepEqual(carriedBands(blindInput({ blindPools: ["other"] })), []);
  // a pool with no bands contributes nothing
  assert.deepEqual(carriedBands(blindInput({ held: [] })), []);
  // a band closed during the cycle (its entry forgotten) is not carried
  assert.deepEqual(carriedBands(blindInput({ entryValueSol: {} })), []);
});

test("marks: a band with no mark is carried at its entry less its full stop; with neither it is left out", () => {
  const c = carriedBands(blindInput({ marks: {}, metaPool: { b1: "blind" }, stops: { b1: 12 } }));
  assert.equal(c[0].basis, "entry less stop");
  near(c[0].valueInSol, 0.5 * 0.88);
  near(carriedBands(blindInput({ marks: {}, metaPool: { b1: "blind" } }))[0].valueInSol, 0.5 * 0.85, "no rolled stop: the configured one");
  assert.deepEqual(carriedBands(blindInput({ marks: {}, metaPool: {} })), [], "no pool on record: nothing says it is in the blind pool");
  assert.deepEqual(carriedBands(blindInput({ marks: {}, metaPool: { b1: "blind" }, entryValueSol: { b1: 0 } })), [], "no value on record");
});

test("marks: a carried mark never raises the equity", () => {
  for (const valueSol of [0, 0.01, 0.4, 0.5, 0.9, 5]) {
    for (const haircutPct of [0, 5, 50, 100]) {
      const c = carriedBands(blindInput({ marks: { b1: { pool: "blind", valueSol, at: T0 } }, haircutPct }));
      assert.ok(c[0].valueInSol <= valueSol, `${valueSol} carried at ${c[0].valueInSol}`);
    }
  }
  // the whole-book sum: the carried band adds no more than its last mark did when its pool was read
  const wallet = 1;
  const read = wallet + 0.4;
  const blind = wallet + carriedBands(blindInput())[0].valueInSol;
  assert.ok(blind < read);
  // unpriced USDC: a holding buys less SOL, a debt costs more, and no price at all is nothing
  assert.ok(carriedUsdToSol(150, 150) < 1);
  assert.ok(carriedUsdToSol(-150, 150) < -1);
  assert.equal(carriedUsdToSol(150, null), 0);
  assert.equal(carriedUsdToSol(0, 150), 0);
});

test("marks: a blind pool with a losing band trips the circuit breaker on its carried marks", () => {
  // a 1 SOL band last marked at 0.85 in a pool that has gone dark; the limit is 15% of 1 SOL working, 0.15
  const input = blindInput({ marks: { b1: { pool: "blind", valueSol: 0.85, at: T0 } }, entryValueSol: { b1: 1 } });
  let c = emptyEngineState().circuit;
  for (let i = 0; i < 2; i += 1) {
    const loss = circuitLossSol(0, markedDrawdownSol(carriedBands(input)));
    near(loss, 1 - 0.85 * 0.95, "on the limit at its last mark, past it once carried");
    const v = circuitVerdict(c, loss, 1, DAY, T0 + i * 5 * M, { floorSol: 0.05 });
    c = v.next;
    if (i === 1) {
      assert.equal(v.tripped, true, "two carried marks past the limit trip it");
      assert.equal(v.stage, 1);
    }
  }
});

test("marks: recordMarks keeps a blind pool's marks, refreshes the decided, seeds the opened, drops the closed", () => {
  const prev = { b1: { pool: "blind", valueSol: 0.4, at: T0 - M }, b2: { pool: "read", valueSol: 0.3, at: T0 - M }, gone: { pool: "read", valueSol: 0.2, at: T0 - M } };
  const next = recordMarks(prev, [{ pool: "read", address: "b2", valueInSol: 0.28 }], [{ pool: "read", address: "b3", entryValueSol: 0.25 }], { b1: 0.5, b2: 0.3, b3: 0.25 }, T0);
  assert.deepEqual(next, {
    b1: { pool: "blind", valueSol: 0.4, at: T0 - M },
    b2: { pool: "read", valueSol: 0.28, at: T0 },
    b3: { pool: "read", valueSol: 0.25, at: T0 },
  });
});

test("marks: the stale count climbs on incomplete cycles, is stale at 3, and resets on the first complete one", () => {
  let h = { skippedMarks: 0, lastCompleteMarkAt: null as number | null, cycle: null as number | null };
  h = foldMarksHealth(h, true, T0, 1);
  assert.equal(h.lastCompleteMarkAt, T0);
  for (let i = 2; i <= 4; i += 1) h = foldMarksHealth(h, false, T0 + i * M, i);
  assert.equal(h.skippedMarks, 3);
  assert.equal(marksStale(h), true);
  assert.equal(h.lastCompleteMarkAt, T0, "an incomplete cycle keeps the last complete time");
  h = foldMarksHealth(h, true, T0 + 5 * M, 5);
  assert.deepEqual(h, { skippedMarks: 0, lastCompleteMarkAt: T0 + 5 * M, cycle: 5 });
  assert.equal(marksStale(h), false);
  // the read /api/status shows
  resetMarksHealth();
  noteMarks(false, T0, 1);
  noteMarks(false, T0 + M, 2);
  assert.deepEqual(marksHealth(), { skippedMarks: 2, lastCompleteMarkAt: null, stale: false });
  noteMarks(false, T0 + 2 * M, 3);
  assert.equal(marksHealth().stale, true);
  noteMarks(true, T0 + 3 * M, 4);
  assert.deepEqual(marksHealth(), { skippedMarks: 0, lastCompleteMarkAt: T0 + 3 * M, stale: false });
  resetMarksHealth();
});

test("marks: a pick that holds no band and cannot be read never makes the read incomplete", () => {
  // the paper pair pool that could not be priced for 590 cycles, held nothing on this run: the book is read whole
  let streaks: Record<string, number> = {};
  let h = { skippedMarks: 0, lastCompleteMarkAt: null as number | null, cycle: null as number | null };
  for (let c = 1; c <= 10; c += 1) {
    const r = readOfBook({ picks: ["spcx", "pair", "sol"], decided: ["spcx", "sol"], held: ["spcx"], usdcUnpriced: false, streaks });
    streaks = r.streaks;
    assert.deepEqual(r.blind, ["pair"]);
    assert.deepEqual(r.heldBlind, []);
    assert.equal(r.complete, true);
    h = foldMarksHealth(h, r.counts, T0 + c * M, c);
  }
  assert.equal(h.skippedMarks, 0);
  assert.equal(marksStale(h), false, "opens are not blocked over a pick with nothing in it");
  // unpriced USDC still makes a cycle incomplete
  assert.equal(readOfBook({ picks: ["a"], decided: ["a"], held: ["a"], usdcUnpriced: true, streaks: {} }).counts, false);
});

test("marks: one held pool blind for good is set aside at MARKS_STALE_CYCLES and written down; the rest of the book opens again", () => {
  // the paper pair pool held a band and could not be priced from cycle 1: SPCX, also held, read fine every cycle
  let streaks: Record<string, number> = {};
  let h = { skippedMarks: 0, lastCompleteMarkAt: null as number | null, cycle: null as number | null };
  const stale: boolean[] = [];
  let last = readOfBook({ picks: [], decided: [], held: [], usdcUnpriced: false, streaks });
  for (let c = 1; c <= 20; c += 1) {
    last = readOfBook({ picks: ["spcx", "pair"], decided: ["spcx"], held: ["spcx", "pair"], usdcUnpriced: false, streaks });
    streaks = last.streaks;
    h = foldMarksHealth(h, last.counts, T0 + c * M, c);
    stale.push(marksStale(h));
    if (c < MARKS_STALE_CYCLES) assert.deepEqual(last.setAside, [], `cycle ${c}: carried, not yet set aside`);
  }
  assert.deepEqual(last.setAside, ["pair"]);
  assert.equal(last.complete, false, "the equity history still takes whole reads only");
  assert.equal(last.counts, true);
  assert.equal(stale.some(Boolean), false, "it never blocks the book for good");
  assert.equal(streaks.pair, 20);
  // its band is written down to its entry less the full stop, below its carried mark
  const c = carriedBands(blindInput({ blindPools: ["pair"], marks: { b1: { pool: "pair", valueSol: 0.48, at: T0 } }, entryValueSol: { b1: 0.5 }, writtenDown: last.setAside }));
  assert.equal(c[0].basis, "written down");
  near(c[0].valueInSol, 0.5 * 0.85);
  // a carried mark already under the floor stays at the mark: the write-down never raises a value
  const lower = carriedBands(blindInput({ blindPools: ["pair"], marks: { b1: { pool: "pair", valueSol: 0.3, at: T0 } }, writtenDown: ["pair"] }));
  near(lower[0].valueInSol, 0.3 * (1 - CARRY_HAIRCUT_PCT / 100));
  // the pool reads again: its streak is gone and it is no longer set aside
  const back = readOfBook({ picks: ["spcx", "pair"], decided: ["spcx", "pair"], held: ["spcx", "pair"], usdcUnpriced: false, streaks });
  assert.deepEqual(back.streaks, {});
  assert.deepEqual(back.setAside, []);
  assert.equal(back.complete, true);
});

test("marks: when nothing at all is decided, nothing is set aside and the block stands", () => {
  // the RPC, not one pool: every held pool blind, however long
  let streaks: Record<string, number> = { a: 9, b: 9 };
  let h = { skippedMarks: 0, lastCompleteMarkAt: null as number | null, cycle: null as number | null };
  for (let c = 1; c <= MARKS_STALE_CYCLES; c += 1) {
    const r = readOfBook({ picks: ["a", "b", "c"], decided: [], held: ["a", "b"], usdcUnpriced: false, streaks });
    streaks = r.streaks;
    assert.deepEqual(r.setAside, []);
    h = foldMarksHealth(h, r.counts, T0 + c * M, c);
  }
  assert.equal(marksStale(h), true);
  // two held pools blind while a third is read: each is set aside only on its own streak
  const r = readOfBook({ picks: ["a", "b", "c"], decided: ["c"], held: ["a", "b", "c"], usdcUnpriced: false, streaks: { a: MARKS_STALE_CYCLES } });
  assert.deepEqual(r.setAside, ["a"]);
  assert.equal(r.counts, false, "b has been blind one cycle: that cycle still counts as incomplete");
});

console.log(`${n} engine tests passed (with USDC-quote, ask-exit and carried-mark checks)`);
