/**
 * Guard tests with synthetic data. No RPC, no LLM.
 *   npm test
 */
import assert from "node:assert/strict";
import { EngineGuardContext, evaluate, GuardContext, NO_ENGINE } from "../risk/guards";
import type { RiskLimits } from "../risk/limits";
import type { RiskState } from "../risk/state";
import type { Decision } from "../agent/schema";
import { USDC_MINT, type PoolSnapshot, type PositionSnapshot } from "../tools/dlmm";

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

const freshState = (): RiskState => ({
  day: "2026-09-10",
  actionsToday: 0,
  lastActionAt: null,
  lastPrice: null,
  entryValueSol: {},
  stops: {},
  outOfRangeSince: {},
  feesPendingSince: {},
  priceHistory: {},
});
const engine = (over: Partial<EngineGuardContext> = {}): EngineGuardContext => ({ ...NO_ENGINE, outOfRangeSince: {}, stops: {}, ...over });

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
  engine: engine(),
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

// ---- engine context ----

const closeOf = (addr: string): Decision => ({ ...open(), action: "CLOSE_POSITION", open: null, positionAddress: addr });
const NOW = Date.now();

test("circuit-breaker halt blocks opens, never a close", () => {
  const e = engine({ haltedUntil: NOW + 3600_000 });
  const v = evaluate(open(), ctx({ engine: e }), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /circuit breaker: opens halted/);
  assert.equal(evaluate(closeOf("pos1"), ctx({ engine: e, positions: [position] }), limits).allowed, true);
  const rebalance: Decision = { ...open(), action: "REBALANCE", positionAddress: "pos1" };
  assert.equal(evaluate(rebalance, ctx({ engine: e, positions: [position], state: { ...freshState(), outOfRangeSince: { pos1: NOW - 900_000 } } }), limits).allowed, false);
});

test("stand-down blocks opens, never a close", () => {
  const e = engine({ standDownUntil: NOW + 3600_000 });
  const v = evaluate(open(), ctx({ engine: e }), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /stand-down/);
  assert.equal(evaluate(closeOf("pos1"), ctx({ engine: e, positions: [position] }), limits).allowed, true);
});

test("an expired halt or stand-down no longer blocks", () => {
  const e = engine({ haltedUntil: NOW - 1, standDownUntil: NOW - 1 });
  assert.equal(evaluate(open(), ctx({ engine: e }), limits).allowed, true);
});

test("benched pool blocks opens with the bench reason", () => {
  const e = engine({ benched: true, benchReason: "benched: 3 stop-loss closes in the last 6h (the oldest ages out on its own)", sizeMultiplier: 0 });
  const v = evaluate(open(), ctx({ engine: e }), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /benched: 3 stop-loss closes/);
});

test("regime 0 blocks opens; regime 0.5 caps the band at half the limit", () => {
  const off = engine({ sizeMultiplier: 0, regimeReason: "regime: board median -18.0% over 24h across 3 pools: opens off" });
  assert.match(evaluate(open(), ctx({ engine: off }), limits).violations.join(), /regime: board median/);
  const half = engine({ sizeMultiplier: 0.5, regimeReason: "regime: board median -8.0% over 24h across 3 pools: size x0.5" });
  const v = evaluate(open({ amountSol: 0.3 }), ctx({ engine: half }), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /band size 0.3000 SOL > max 0.2500 \(0.5 x limit after bench\/regime\)/);
  assert.equal(evaluate(open({ amountSol: 0.25 }), ctx({ engine: half }), limits).allowed, true);
  // above the hard limit the plain message wins, whatever the multiplier
  const big = evaluate(open({ amountSol: 0.75 }), ctx({ engine: half }), limits).violations.join(";");
  assert.match(big, /band size 0.7500 SOL > max 0.5(;|$)/);
  assert.doesNotMatch(big, /after bench\/regime/);
});

test("knife blocks opens in that pool", () => {
  const e = engine({ knife: "knife: -24.0% in 30 min (limit 20%)" });
  const v = evaluate(open(), ctx({ engine: e }), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /knife: -24.0%/);
  assert.equal(evaluate(closeOf("pos1"), ctx({ engine: e, positions: [position] }), limits).allowed, true);
});

test("anti-churn: the LLM may not move a band that has not sat out of range for the minimum", () => {
  const oor = { ...position, inRange: false, binsFromRange: -3 };
  const soon = ctx({ positions: [oor], engine: engine({ outOfRangeSince: { pos1: NOW - 100_000 } }) });
  const v = evaluate(closeOf("pos1"), soon, limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /anti-churn: pos1 is out of range for 100s, minimum 600s/);
  const rebalance: Decision = { ...open(), action: "REBALANCE", positionAddress: "pos1" };
  assert.equal(evaluate(rebalance, soon, limits).allowed, false);
  const late = ctx({ positions: [oor], engine: engine({ outOfRangeSince: { pos1: NOW - 700_000 } }) });
  assert.equal(evaluate(closeOf("pos1"), late, limits).allowed, true);
  // an in-range band is not judged by anti-churn
  assert.equal(evaluate(closeOf("pos1"), ctx({ positions: [position] }), limits).allowed, true);
});

test("anti-churn yields when the band is down at least half its stop", () => {
  const hurt = { ...position, inRange: false, binsFromRange: -3, valueInSol: 0.27 }; // -10% vs 0.3, stop 15 -> half is 7.5
  const state = { ...freshState(), entryValueSol: { pos1: 0.3 } };
  const v = evaluate(closeOf("pos1"), ctx({ positions: [hurt], state, engine: engine({ outOfRangeSince: { pos1: NOW - 60_000 } }) }), limits);
  assert.equal(v.allowed, true, v.violations.join("; "));
  assert.equal(v.emergency, false);
});

test("an engine close is an emergency: no anti-churn, no cooldown, no cap, no kill switch, no halt, no stand-down", () => {
  const state = { ...freshState(), actionsToday: 24, lastActionAt: NOW - 10_000 };
  const e = engine({ haltedUntil: NOW + 3600_000, standDownUntil: NOW + 3600_000, benched: true, knife: "knife: -30% in 30 min (limit 20%)" });
  const v = evaluate(closeOf("pos1"), ctx({ positions: [position], state, killSwitch: true, engine: e, source: "engine" }), limits);
  assert.equal(v.allowed, true, v.violations.join("; "));
  assert.equal(v.emergency, true);
  assert.equal(v.decision.action, "CLOSE_POSITION");
});

test("the only thing that stops an engine close is a position that is not ours", () => {
  const v = evaluate(closeOf("nope"), ctx({ positions: [position], source: "engine" }), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /not one of ours/);
});

test("CLOSE_POSITION from the LLM is exempt from cooldown and the daily cap", () => {
  const state = { ...freshState(), actionsToday: 24, lastActionAt: NOW - 10_000, outOfRangeSince: { pos1: NOW - 900_000 } };
  const oor = { ...position, inRange: false, binsFromRange: -3 };
  const v = evaluate(closeOf("pos1"), ctx({ positions: [oor], state, engine: engine({ outOfRangeSince: { pos1: NOW - 900_000 } }) }), limits);
  assert.equal(v.allowed, true, v.violations.join("; "));
  assert.equal(v.emergency, false);
  // a claim is not an exit: the cap still applies
  const claim: Decision = { ...open(), action: "CLAIM_FEES", open: null, positionAddress: null };
  assert.match(evaluate(claim, ctx({ positions: [position], state }), limits).violations.join(), /daily action cap/);
});

test("an engine COLLECT is not an exit: the guards still rate-limit it", () => {
  const claim: Decision = { ...open(), action: "CLAIM_FEES", open: null, positionAddress: "pos1" };
  const state = { ...freshState(), lastActionAt: NOW - 10_000 };
  const v = evaluate(claim, ctx({ positions: [position], state, source: "engine" }), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /cooldown/);
  assert.equal(evaluate(claim, ctx({ positions: [position], source: "engine" }), limits).allowed, true);
});

test("the per-band stop replaces the global limit when present", () => {
  const state = { ...freshState(), entryValueSol: { pos1: 0.3 } };
  const hurt = { ...position, valueInSol: 0.26 }; // -13.3%: inside the 15% limit, past a 12% rolled stop
  assert.equal(evaluate(open(), ctx({ state, positions: [hurt] }), limits).emergency, false);
  const v = evaluate(open(), ctx({ state, positions: [hurt], engine: engine({ stops: { pos1: 12 } }) }), limits);
  assert.equal(v.emergency, true);
  assert.equal(v.decision.action, "CLOSE_POSITION");
  assert.match(v.overrides.join(), /stop 12.00%/);
});

test("an engine STOP that already closes the band at its stop is passed through, not overridden", () => {
  const state = { ...freshState(), entryValueSol: { pos1: 0.3, pos2: 0.3 } };
  const hurt1 = { ...position, valueInSol: 0.25 };
  const hurt2 = { ...position, address: "pos2", valueInSol: 0.2 };
  const v = evaluate(closeOf("pos2"), ctx({ state, positions: [hurt1, hurt2], source: "engine" }), limits);
  assert.equal(v.allowed, true);
  assert.equal(v.decision.positionAddress, "pos2");
  assert.equal(v.overrides.length, 0);
  assert.equal(v.emergency, true);
});

// ---- USDC-quoted pools ----
// NVDAx/USDC at $180, SOL at $102: 1 USDC = 1/102 SOL. The limits above are SOL (0.5 per band = 51 USDC).

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
/** the same pool with USDC as token X: the quote-only band then sits at/above the active bin */
const usdcXSnapshot: PoolSnapshot = {
  ...usdcSnapshot,
  address: "pool-usdc-x",
  label: "USDC/NVDAx",
  tokenX: USDC,
  tokenY: NVDAX,
  activePrice: 1 / 180,
  priceLabel: "NVDAx per USDC",
  quoteSide: "X",
  liquidityBelowY: 1_200,
  liquidityAboveX: 250_000,
};
const uctx = (over: Partial<GuardContext> = {}): GuardContext => ctx({ snapshot: usdcSnapshot, walletSol: 1, walletQuote: 100, ...over });
/** a 40 USDC quote-only band, 19 bins under the active bin */
const uopen = (over: Partial<NonNullable<Decision["open"]>> = {}): Decision => open({ amountSol: 40, ...over });

test("USDC pool: a quote-only band passes, sized in SOL at the SOL price", () => {
  const v = evaluate(uopen(), uctx(), limits);
  assert.equal(v.allowed, true, v.violations.join("; "));
  assert.equal(v.decision.action, "OPEN_POSITION");
  assert.match(v.passed.join(), /open size 0\.3922 SOL \(40\.00 USDC\)/);
});

test("USDC pool: the deposit is checked against the USDC balance, not the SOL balance", () => {
  const short = evaluate(uopen(), uctx({ walletQuote: 30 }), limits);
  assert.equal(short.allowed, false);
  assert.match(short.violations.join(), /not enough USDC: want 40, have 30/);
  // walletQuote defaults to walletSol: a caller that never learned about quotes is judged as a SOL wallet, i.e. short of USDC
  const legacy = evaluate(uopen(), ctx({ snapshot: usdcSnapshot, walletSol: 1 }), limits);
  assert.equal(legacy.allowed, false);
  assert.match(legacy.violations.join(), /not enough USDC: want 40, have 1/);
});

test("USDC pool: the gas reserve is checked against real SOL minus rent only, whatever the USDC balance", () => {
  const v = evaluate(uopen(), uctx({ walletSol: 0.25, walletQuote: 10_000 }), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /wallet would hold 0\.0496 SOL after ~0\.200 rent \(the USDC deposit spends no SOL\), below gas reserve 0\.1/);
  // 0.31 SOL covers rent + reserve even though 40 USDC is worth more than the wallet's SOL
  assert.equal(evaluate(uopen(), uctx({ walletSol: 0.31, walletQuote: 10_000 }), limits).allowed, true);
});

test("USDC pool: band size and total exposure count in SOL", () => {
  const big = evaluate(uopen({ amountSol: 60 }), uctx(), limits); // 60 USDC = 0.588 SOL > 0.5
  assert.equal(big.allowed, false);
  assert.match(big.violations.join(), /band size 0\.5882 SOL \(60\.00 USDC\) > max 0\.5/);
  const held = { ...position, address: "posu", amountY: 45, feeY: 0.9, valueInSol: 0.9, solInPosition: 0.9, quoteInPosition: 91.8 };
  const over = evaluate(uopen({ amountSol: 20 }), uctx({ positions: [held], walletSol: 2 }), limits); // 0.9 + 0.196 > 1
  assert.equal(over.allowed, false);
  assert.match(over.violations.join(), /total exposure would be 1\.0961 SOL > max 1/);
  const elsewhere = evaluate(uopen({ amountSol: 20 }), uctx({ otherExposureSol: 0.85 }), limits);
  assert.match(elsewhere.violations.join(), /total exposure/);
});

test("USDC pool: geometry when the quote is Y (USDC-only at/below, base-only at/above)", () => {
  const v = evaluate(uopen({ binsAboveActive: 5 }), uctx(), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /SOL_ONLY \(USDC-only\) band must sit at\/below the active bin/);
  const t = evaluate(uopen({ side: "TOKEN_ONLY", amountSol: 0, amountToken: 1, binsBelowActive: 3, binsAboveActive: 10 }), uctx({ walletToken: 5 }), limits);
  assert.equal(t.allowed, false);
  assert.match(t.violations.join(), /TOKEN_ONLY band must sit at\/above the active bin/);
  const tokenWithUsdc = evaluate(uopen({ side: "TOKEN_ONLY", amountSol: 5, amountToken: 1, binsBelowActive: 0, binsAboveActive: 10 }), uctx({ walletToken: 5 }), limits);
  assert.match(tokenWithUsdc.violations.join(), /TOKEN_ONLY band must not deposit USDC/);
  assert.equal(evaluate(uopen({ side: "TOKEN_ONLY", amountSol: 0, amountToken: 0.2, binsBelowActive: 0, binsAboveActive: 10 }), uctx({ walletToken: 5 }), limits).allowed, true);
});

test("USDC pool: geometry when the quote is X (USDC-only at/above, base-only at/below)", () => {
  const xctx = uctx({ snapshot: usdcXSnapshot });
  const below = evaluate(uopen(), xctx, limits); // 19 bins below: wrong side for a quote-X pool
  assert.equal(below.allowed, false);
  assert.match(below.violations.join(), /SOL_ONLY \(USDC-only\) band must sit at\/above the active bin/);
  const above = evaluate(uopen({ binsBelowActive: 0, binsAboveActive: 19 }), xctx, limits);
  assert.equal(above.allowed, true, above.violations.join("; "));
  assert.match(above.passed.join(), /open size 0\.3922 SOL \(40\.00 USDC\)/);
  const t = evaluate(uopen({ side: "TOKEN_ONLY", amountSol: 0, amountToken: 0.2, binsBelowActive: 0, binsAboveActive: 10 }), uctx({ snapshot: usdcXSnapshot, walletToken: 5 }), limits);
  assert.match(t.violations.join(), /TOKEN_ONLY band must sit at\/below the active bin/);
});

test("USDC pool: a REBALANCE frees the closing band's USDC and its SOL exposure", () => {
  const held = { ...position, address: "posu", amountY: 45, feeY: 0.9, valueInSol: 0.45, solInPosition: 0.45, quoteInPosition: 45.9 };
  const rebalance: Decision = { ...uopen({ amountSol: 45 }), action: "REBALANCE", positionAddress: "posu" };
  const v = evaluate(rebalance, uctx({ positions: [held], walletQuote: 0, walletSol: 0.5 }), limits);
  assert.equal(v.allowed, true, v.violations.join("; "));
  const tooMuch: Decision = { ...uopen({ amountSol: 50 }), action: "REBALANCE", positionAddress: "posu" };
  assert.match(evaluate(tooMuch, uctx({ positions: [held], walletQuote: 0, walletSol: 0.5 }), limits).violations.join(), /not enough USDC: want 50, have 0 \+ 45\.9000 back/);
});

test("USDC pool: the stop-loss reads valueInSol like any other pool", () => {
  const state = { ...freshState(), entryValueSol: { posu: 0.5 } };
  const hurt = { ...position, address: "posu", valueInSol: 0.42, solInPosition: 0.1, quoteInPosition: 10.2 }; // -16%
  const v = evaluate(uopen(), uctx({ state, positions: [hurt] }), limits);
  assert.equal(v.emergency, true);
  assert.equal(v.decision.action, "CLOSE_POSITION");
  assert.equal(v.decision.positionAddress, "posu");
});

test("basis rule refuses opens in a stock pool, exits still pass", () => {
  const e = engine({ basisReason: "basis: pool is +1.40% over the NVDA perp (limit 1.00%): arbitrage flow will sell into the band" });
  const v = evaluate(open(), ctx({ engine: e }), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /basis: pool is \+1\.40%/);
  const close: Decision = { ...open(), action: "CLOSE_POSITION", open: null, positionAddress: position.address };
  assert.equal(evaluate(close, ctx({ engine: e, positions: [position] }), limits).allowed, true);
});

console.log(`${n} guard tests passed (with portfolio, engine, USDC-quote and basis checks)`);
