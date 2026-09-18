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
import { antiChurn, bandStopPct, drawdownPct, dropOverWindowPct, forgetBand, knifeReason, recordPrice, rollStop, trackOutOfRange, moveAfterSec, rangeOverWindowPct } from "../engine/exit";
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
import { lockBlocks, loopStale, staleWindowMs } from "../engine/watchdog";

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


console.log(`${n} engine tests passed (with USDC-quote checks)`);
