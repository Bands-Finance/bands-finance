/**
 * Guard tests with synthetic data. No RPC, no LLM.
 *   npm test
 */
import assert from "node:assert/strict";
import { evaluate, GuardContext } from "../risk/guards";
import type { RiskLimits } from "../risk/limits";
import type { RiskState } from "../risk/state";
import type { Decision } from "../agent/schema";
import type { PoolSnapshot, PositionSnapshot } from "../tools/dlmm";

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

const snapshot: PoolSnapshot = {
  address: "pool",
  label: "ANSEM/SOL",
  tokenX: { mint: "ansem", symbol: "ANSEM", decimals: 6, reserve: 5_000_000 },
  tokenY: { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9, reserve: 5000 },
  solSide: "Y",
  baseToken: { mint: "ansem", symbol: "ANSEM", decimals: 6, reserve: 5_000_000 },
  binStep: 20,
  activeBinId: 260,
  activePrice: 0.00168,
  priceLabel: "SOL per ANSEM",
  tokenPriceInSol: 0.00168,
  baseFeePct: 0.2,
  maxFeePct: 10,
  dynamicFeePct: 0.22,
  bins: [],
  liquidityBelowY: 180,
  liquidityAboveX: 100_000,
  fetchedAt: new Date().toISOString(),
};

const freshState = (): RiskState => ({ day: "2026-09-10", actionsToday: 0, lastActionAt: null, lastPrice: null, entryValueSol: {} });

const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
  now: Date.now(),
  snapshot,
  positions: [],
  walletSol: 1,
  walletToken: 0,
  state: freshState(),
  killSwitch: false,
  otherExposureSol: 0,
  poolsWithBands: 0,
  maxActivePools: 3,
  ...over,
});

const open = (over: Partial<NonNullable<Decision["open"]>> = {}): Decision => ({
  action: "OPEN_POSITION",
  open: { side: "SOL_ONLY", amountSol: 0.25, amountToken: 0, binsBelowActive: 19, binsAboveActive: 0, strategy: "Spot", ...over },
  positionAddress: null,
  reasoning: "test",
  confidence: 0.8,
  headline: "test",
});

const position: PositionSnapshot = {
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
};

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n += 1;
  console.log(`ok ${n} - ${name}`);
}

test("valid SOL_ONLY band passes", () => {
  const v = evaluate(open(), ctx(), limits);
  assert.equal(v.allowed, true, v.violations.join("; "));
  assert.equal(v.decision.action, "OPEN_POSITION");
});

test("oversized band is rejected and becomes HOLD", () => {
  const v = evaluate(open({ amountSol: 0.75 }), ctx(), limits);
  assert.equal(v.allowed, false);
  assert.equal(v.decision.action, "HOLD");
  assert.match(v.violations.join(), /band size/);
});

test("gas reserve is protected", () => {
  const v = evaluate(open({ amountSol: 0.4 }), ctx({ walletSol: 0.55 }), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /gas reserve/);
});

test("total exposure cap counts existing bands", () => {
  const big = { ...position, valueInSol: 0.9, solInPosition: 0.9 };
  const v = evaluate(open({ amountSol: 0.2 }), ctx({ positions: [big], walletSol: 2 }), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /total exposure/);
});

test("band width cap", () => {
  const v = evaluate(open({ binsBelowActive: 80 }), ctx(), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /width/);
});

test("SOL_ONLY band must sit at/below active when SOL is Y", () => {
  const v = evaluate(open({ binsAboveActive: 5 }), ctx(), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /at\/below/);
});

test("TOKEN_ONLY needs token balance", () => {
  const v = evaluate(open({ side: "TOKEN_ONLY", amountSol: 0, amountToken: 100, binsBelowActive: 0, binsAboveActive: 10 }), ctx({ walletToken: 10 }), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /not enough ANSEM/);
});

test("kill switch blocks new exposure", () => {
  const v = evaluate(open(), ctx({ killSwitch: true }), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /kill switch/);
});

test("kill switch still allows closing", () => {
  const close: Decision = { ...open(), action: "CLOSE_POSITION", open: null, positionAddress: "pos1" };
  const v = evaluate(close, ctx({ killSwitch: true, positions: [position] }), limits);
  assert.equal(v.allowed, true, v.violations.join("; "));
});

test("price move sanity check", () => {
  const state = { ...freshState(), lastPrice: 0.004 };
  const v = evaluate(open(), ctx({ state }), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /price moved/);
});

test("daily cap and cooldown", () => {
  const capped = { ...freshState(), actionsToday: 24 };
  assert.equal(evaluate(open(), ctx({ state: capped }), limits).allowed, false);
  const recent = { ...freshState(), lastActionAt: Date.now() - 60_000 };
  const v = evaluate(open(), ctx({ state: recent }), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /cooldown/);
});

test("stop-loss overrides the model and skips the cooldown", () => {
  const state = { ...freshState(), lastActionAt: Date.now() - 60_000, entryValueSol: { pos1: 0.3 } };
  const hurt = { ...position, valueInSol: 0.25 }; // -16.7%
  const v = evaluate(open(), ctx({ state, positions: [hurt] }), limits);
  assert.equal(v.emergency, true);
  assert.equal(v.allowed, true, v.violations.join("; "));
  assert.equal(v.decision.action, "CLOSE_POSITION");
  assert.equal(v.decision.positionAddress, "pos1");
  assert.equal(v.proposal.action, "OPEN_POSITION");
});

test("closing a band we do not own is rejected", () => {
  const close: Decision = { ...open(), action: "CLOSE_POSITION", open: null, positionAddress: "nope" };
  const v = evaluate(close, ctx({ positions: [position] }), limits);
  assert.equal(v.allowed, false);
});

test("rebalance frees the closed band's exposure and SOL", () => {
  const big = { ...position, valueInSol: 0.9, solInPosition: 0.9 };
  const rebalance: Decision = { ...open({ amountSol: 0.5 }), action: "REBALANCE", positionAddress: "pos1" };
  const v = evaluate(rebalance, ctx({ positions: [big], walletSol: 0.2 }), limits);
  assert.equal(v.allowed, true, v.violations.join("; "));
});

test("HOLD always passes", () => {
  const hold: Decision = { ...open(), action: "HOLD", open: null };
  assert.equal(evaluate(hold, ctx({ killSwitch: true }), limits).allowed, true);
});

test("exposure in other pools counts toward the total cap", () => {
  const v = evaluate(open({ amountSol: 0.3 }), ctx({ otherExposureSol: 0.8, walletSol: 2 }), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /total exposure/);
});

test("pool cap blocks a band in a new pool but not a rebalance in a held one", () => {
  const v = evaluate(open(), ctx({ poolsWithBands: 3, maxActivePools: 3 }), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /already working/);
  const rebalance: Decision = { ...open(), action: "REBALANCE", positionAddress: "pos1" };
  assert.equal(evaluate(rebalance, ctx({ poolsWithBands: 3, maxActivePools: 3, positions: [position] }), limits).allowed, true);
});

console.log(`${n} guard tests passed (with portfolio checks)`);
