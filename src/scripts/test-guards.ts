/**
 * Guard tests with synthetic data. No RPC, no LLM.
 *   npm test
 */
import assert from "node:assert/strict";
import { EngineGuardContext, evaluate, GuardContext, NO_ENGINE } from "../risk/guards";
import { MARKS_STALE_CYCLES } from "../engine/marks";
import type { RiskLimits } from "../risk/limits";
import type { RiskState } from "../risk/state";
import type { Decision } from "../agent/schema";
import { USDC_MINT, type PoolSnapshot, type PositionSnapshot } from "../tools/dlmm";
import { COPYCAT_MINTS, houseMintsOf, housePoolViolation, houseSwapViolation } from "../risk/house";
import { JupiterClient } from "../tools/jupiter";

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

test("a single-sided band with no bins on its side is refused on its shape (a CLMM cannot even cost it)", () => {
  const none = evaluate(open({ binsBelowActive: 0, binsAboveActive: 0 }), ctx(), limits);
  assert.equal(none.allowed, false);
  assert.match(none.violations.join(), /SOL_ONLY band needs at least one bin below the active bin/);
  const tok = evaluate(open({ side: "TOKEN_ONLY", amountSol: 0, amountToken: 1, binsBelowActive: 0, binsAboveActive: 0 }), ctx({ walletToken: 10 }), limits);
  assert.match(tok.violations.join(), /TOKEN_ONLY band needs at least one bin above the active bin/);
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

test("marks stale: after MARKS_STALE_CYCLES incomplete cycles an OPEN is refused, a CLOSE and a CLAIM go through", () => {
  const stale = { skippedMarks: MARKS_STALE_CYCLES };
  const refused = evaluate(open(), ctx(stale), limits);
  assert.equal(refused.allowed, false);
  assert.equal(refused.decision.action, "HOLD");
  assert.match(refused.violations.join(), /^marks stale: 3 cycles running/);
  const relay: Decision = { ...open(), action: "REBALANCE", positionAddress: "pos1" };
  assert.match(evaluate(relay, ctx({ ...stale, positions: [position], walletSol: 2 }), limits).violations.join(), /marks stale/, "a re-lay adds a band: refused too");
  const close: Decision = { ...open(), action: "CLOSE_POSITION", open: null, positionAddress: "pos1" };
  const closed = evaluate(close, ctx({ ...stale, positions: [position] }), limits);
  assert.equal(closed.allowed, true, closed.violations.join("; "));
  const claim: Decision = { ...open(), action: "CLAIM_FEES", open: null, positionAddress: "pos1" };
  const claimed = evaluate(claim, ctx({ ...stale, positions: [position] }), limits);
  assert.equal(claimed.allowed, true, claimed.violations.join("; "));
  // two incomplete cycles are not yet stale; a complete one (the counter back at 0) opens as before
  assert.equal(evaluate(open(), ctx({ skippedMarks: MARKS_STALE_CYCLES - 1 }), limits).allowed, true);
  assert.equal(evaluate(open(), ctx({ skippedMarks: 0 }), limits).allowed, true);
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
  const recent = { ...freshState(), lastActionAt: Date.now() - 60_000, lastMoveByPool: { pool: Date.now() - 60_000 } };
  const v = evaluate(open(), ctx({ state: recent }), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /cooldown/);
  // the cooldown is per pool: a move elsewhere does not block this pool
  const elsewhere = { ...freshState(), lastActionAt: Date.now() - 60_000, lastMoveByPool: { other: Date.now() - 60_000 } };
  assert.equal(evaluate(open(), ctx({ state: elsewhere }), limits).allowed, true);
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
  // a band through its stop is mostly token: the forced close sells it back, never leaves it in the wallet
  assert.equal(v.decision.liquidate, true);
});

test("venue gate: a held band on a venue off TRADABLE_VENUES is observed and may close, but nothing opens there", () => {
  const prev = process.env.TRADABLE_VENUES;
  process.env.TRADABLE_VENUES = "meteora-dlmm";
  try {
    const onRaydium = { ...snapshot, venue: "raydium-clmm" as const };
    const v = evaluate(open(), ctx({ snapshot: onRaydium }), limits);
    assert.equal(v.allowed, false);
    assert.match(v.violations.join(), /venue: raydium-clmm is not in TRADABLE_VENUES \(meteora-dlmm\); holding what we hold there, opening nothing new/);
    const close: Decision = { ...open(), action: "CLOSE_POSITION", open: null, positionAddress: "pos1" };
    const c = evaluate(close, ctx({ snapshot: onRaydium, positions: [position] }), limits);
    assert.equal(c.allowed, true, c.violations.join("; "));
    process.env.TRADABLE_VENUES = "meteora-dlmm,raydium-clmm";
    assert.equal(evaluate(open(), ctx({ snapshot: onRaydium }), limits).allowed, true);
  } finally {
    if (prev === undefined) delete process.env.TRADABLE_VENUES;
    else process.env.TRADABLE_VENUES = prev;
  }
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

test("an engine COLLECT is not an exit: the daily cap still applies, the cooldown does not", () => {
  const claim: Decision = { ...open(), action: "CLAIM_FEES", open: null, positionAddress: "pos1" };
  const capped = { ...freshState(), actionsToday: 24 };
  const v = evaluate(claim, ctx({ positions: [position], state: capped, source: "engine" }), limits);
  assert.equal(v.allowed, false);
  assert.match(v.violations.join(), /daily action cap/);
  const recentMove = { ...freshState(), lastActionAt: NOW - 10_000, lastMoveByPool: { pool: NOW - 10_000 } };
  assert.equal(evaluate(claim, ctx({ positions: [position], state: recentMove, source: "engine" }), limits).allowed, true);
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

test("stop-loss reads the band's market value: the fees waiting inside it are set aside, so a claim cannot bring a band nearer its stop", () => {
  const state = { ...freshState(), lastActionAt: Date.now() - 60_000, entryValueSol: { pos1: 0.3 } };
  // value 0.27 with 0.03 of unclaimed fees inside: market value 0.24, -20% -> the stop fires although the headline value is only -10%
  const rich = { ...position, valueInSol: 0.27, feeY: 0.03, feeX: 0 };
  const v = evaluate(open(), ctx({ state, positions: [rich] }), limits);
  assert.equal(v.decision.action, "CLOSE_POSITION", "the market drawdown is what the stop reads");
  assert.match(v.overrides.join(), /20\.0% below entry on its market value, fees aside/);
  // the same band after the claim: value 0.24, no fees inside: the same -20%, the same verdict
  const claimed = { ...position, valueInSol: 0.24, feeY: 0, feeX: 0 };
  assert.equal(evaluate(open(), ctx({ state, positions: [claimed] }), limits).decision.action, "CLOSE_POSITION");
  // a band down 12% on the market with 8% of fees inside is not at a 15% stop, before or after claiming
  const fine = { ...position, valueInSol: 0.288, feeY: 0.024, feeX: 0 };
  assert.equal(evaluate(open(), ctx({ state, positions: [fine] }), limits).decision.action, "OPEN_POSITION");
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

// ---- the stock straddle: BOTH bands with an acquire leg, liquidating closes ----

/** a straddle on NVDAx/USDC at $180: 20 USDC + 0.111 NVDAx (~20 USDC) both sides of the active bin, the NVDAx bought first */
const straddle = (over: Partial<NonNullable<Decision["open"]>> = {}): Decision => open({ side: "BOTH", amountSol: 20, amountToken: 0.111, acquireToken: 0.111, binsBelowActive: 15, binsAboveActive: 15, ...over });

test("straddle: a BOTH band with acquireToken passes when the quote covers both halves and the purchase (with slippage); the size counts both legs", () => {
  // 20 USDC + 0.111 x 180 x 1.01 = 40.18 USDC of quote; the wallet holds no NVDAx, the swap brings it in
  const v = evaluate(straddle(), uctx({ walletQuote: 41, walletToken: 0 }), limits);
  assert.equal(v.allowed, true, v.violations.join("; "));
  assert.match(v.passed.join(), /open size 0\.3920 SOL \(39\.98 USDC\), width 31/);
  const short = evaluate(straddle(), uctx({ walletQuote: 39, walletToken: 0 }), limits);
  assert.equal(short.allowed, false);
  assert.match(short.violations.join(), /not enough USDC: want 20 \+ 20\.18 to buy 0\.111 NVDAx \(incl\. 1% slippage\), have 39/);
  // the wallet already holds the token half: nothing to buy, only the quote half is spent
  const held = evaluate(straddle({ acquireToken: 0 }), uctx({ walletQuote: 21, walletToken: 0.2 }), limits);
  assert.equal(held.allowed, true, held.violations.join("; "));
  const notHeld = evaluate(straddle({ acquireToken: 0 }), uctx({ walletQuote: 21, walletToken: 0.05 }), limits);
  assert.match(notHeld.violations.join(), /not enough NVDAx: want 0\.111, have 0\.05/);
});

test("straddle: the purchase is budgeted at the swap's own slippage when SWAP_SLIPPAGE_BPS is wider than MAX_SLIPPAGE_PCT", () => {
  // 41 USDC covers 20 + 20.18 at 1%; at 3% the buy needs 20.58 and the same wallet is short
  const prev = process.env.SWAP_SLIPPAGE_BPS;
  process.env.SWAP_SLIPPAGE_BPS = "300";
  try {
    const v = evaluate(straddle(), uctx({ walletQuote: 40.5, walletToken: 0 }), limits);
    assert.equal(v.allowed, false);
    assert.match(v.violations.join(), /want 20 \+ 20\.58 to buy 0\.111 NVDAx \(incl\. 3% slippage\), have 40\.5/);
    assert.equal(evaluate(straddle(), uctx({ walletQuote: 41, walletToken: 0 }), limits).allowed, true);
  } finally {
    if (prev === undefined) delete process.env.SWAP_SLIPPAGE_BPS;
    else process.env.SWAP_SLIPPAGE_BPS = prev;
  }
});

test("straddle: acquireToken is only for BOTH, never more than the token leg, never negative", () => {
  assert.match(evaluate(uopen({ acquireToken: 0.1 }), uctx(), limits).violations.join(), /acquireToken is only for a BOTH band/);
  assert.match(evaluate(straddle({ acquireToken: 0.5 }), uctx({ walletQuote: 200 }), limits).violations.join(), /acquireToken 0\.5 exceeds the token leg 0\.111/);
  assert.match(evaluate(straddle({ acquireToken: -1 }), uctx({ walletQuote: 200 }), limits).violations.join(), /acquireToken must be a non-negative number/);
});

test("straddle: geometry needs a bin on each side and both amounts", () => {
  assert.match(evaluate(straddle({ binsBelowActive: 0 }), uctx({ walletQuote: 50 }), limits).violations.join(), /BOTH band must straddle the active bin/);
  assert.match(evaluate(straddle({ binsAboveActive: 0 }), uctx({ walletQuote: 50 }), limits).violations.join(), /BOTH band must straddle the active bin/);
  assert.match(evaluate(straddle({ amountToken: 0, acquireToken: 0 }), uctx({ walletQuote: 50 }), limits).violations.join(), /BOTH band needs amountSol > 0 \(USDC\) and amountToken > 0 \(NVDAx\)/);
});

test("straddle: a REBALANCE counts the closing band's token and quote toward the new halves", () => {
  // the old straddle holds 0.05 NVDAx + 35 USDC (+ fees); the wallet holds nothing: the re-centre needs 0.06 more NVDAx bought (10.91 USDC at 1% slippage) plus the 20 USDC half, from the 35.5 USDC back
  const old = { ...position, address: "posu", amountX: 0.05, amountY: 35, feeX: 0.001, feeY: 0.5, valueInSol: (35.5 + 0.051 * 180) / SOL_USD, solInPosition: 35.5 / SOL_USD, quoteInPosition: 35.5, inRange: false, binsFromRange: 20 };
  const reb: Decision = { ...straddle({ acquireToken: 0.06 }), action: "REBALANCE", positionAddress: "posu" };
  const state = { ...freshState(), outOfRangeSince: { posu: NOW - 900_000 } };
  const e = engine({ outOfRangeSince: { posu: NOW - 900_000 } });
  const v = evaluate(reb, uctx({ positions: [old], walletQuote: 0, walletToken: 0, state, engine: e }), limits);
  assert.equal(v.allowed, true, v.violations.join("; "));
  // without the purchase the token leg is short
  const noBuy: Decision = { ...straddle({ acquireToken: 0 }), action: "REBALANCE", positionAddress: "posu" };
  assert.match(evaluate(noBuy, uctx({ positions: [old], walletQuote: 0, walletToken: 0, state, engine: e }), limits).violations.join(), /not enough NVDAx: want 0\.111, have 0 \+ 0\.051000 back from the closing band/);
});

test("liquidate: a close that sells the token back is an exit like any other, never blocked; the flag rides through", () => {
  const close: Decision = { ...open(), action: "CLOSE_POSITION", open: null, positionAddress: "pos1", liquidate: true };
  const state = { ...freshState(), actionsToday: 24, lastActionAt: NOW - 10_000 };
  const e = engine({ haltedUntil: NOW + 3600_000, standDownUntil: NOW + 3600_000, benched: true, knife: "knife: -30% in 30 min (limit 20%)", basisReason: "basis: off" });
  const v = evaluate(close, ctx({ positions: [{ ...position, inRange: false, binsFromRange: -3 }], state, killSwitch: true, engine: { ...e, outOfRangeSince: { pos1: NOW - 900_000 } } }), limits);
  assert.equal(v.allowed, true, v.violations.join("; "));
  assert.equal(v.decision.liquidate, true);
  assert.equal(v.decision.action, "CLOSE_POSITION");
  const engineClose = evaluate(close, ctx({ positions: [position], source: "engine", killSwitch: true }), limits);
  assert.equal(engineClose.allowed, true);
  assert.equal(engineClose.decision.liquidate, true);
});

// ---- the ask exit (src/engine/askExit.ts): a REBALANCE that closes a band into an ask band is judged as the exit it is
const throughBand: PositionSnapshot = { ...position, inRange: false, binsFromRange: -3, amountX: 130, amountY: 0, feeX: 2, feeY: 0.0004, valueInSol: 0.222, solInPosition: 0.0004 };
const askExit = (over: Partial<Decision> = {}): Decision => ({
  ...open({ side: "TOKEN_ONLY", amountSol: 0, amountToken: 132, binsBelowActive: 0, binsAboveActive: 15 }),
  action: "REBALANCE",
  positionAddress: "pos1",
  exitAsk: true,
  ...over,
});

test("ask exit: passes on the closing band's token (incl. its base fees), skips the cooldown, the daily cap, the price check, the size limits and the open gates", () => {
  const state = { ...freshState(), actionsToday: 24, lastActionAt: NOW - 10_000, lastMoveByPool: { pool: NOW - 10_000 }, lastPrice: 0.004, entryValueSol: { pos1: 0.3 } };
  const e = engine({ haltedUntil: NOW + 3600_000, benched: true, knife: "knife: -30% in 30 min (limit 20%)", sizeMultiplier: 0.25, outOfRangeSince: { pos1: NOW - 900_000 }, outOfRangeSec: 600 });
  const notAtStop = { ...throughBand, valueInSol: 0.29 };
  const v = evaluate(askExit(), ctx({ now: NOW, positions: [notAtStop], state, engine: e, walletSol: 1 }), { ...limits, maxPositionSol: 0.1 });
  assert.equal(v.allowed, true, v.violations.join("; "));
  assert.equal(v.decision.action, "REBALANCE");
  assert.equal(v.decision.exitAsk, true);
  assert.equal(v.emergency, false, "a policy ask exit is not an emergency, just never held");
  // more token than the band and the wallet hold: refused like any deposit
  const tooMuch = evaluate(askExit({ open: { ...askExit().open!, amountToken: 140 } }), ctx({ now: NOW, positions: [throughBand], state, engine: e }), limits);
  assert.ok(tooMuch.violations.some((x) => x.startsWith("not enough ANSEM")), tooMuch.violations.join("; "));
  // the geometry is still the TOKEN_ONLY geometry
  const wrongSide = evaluate(askExit({ open: { ...askExit().open!, binsBelowActive: 2, binsAboveActive: 0 } }), ctx({ now: NOW, positions: [throughBand], state, engine: e }), limits);
  assert.ok(wrongSide.violations.some((x) => x.includes("TOKEN_ONLY band must sit at/above")), wrongSide.violations.join("; "));
  // an ordinary REBALANCE in the same spot is held by the cooldown and the gates as before
  const plain = evaluate({ ...askExit(), exitAsk: undefined }, ctx({ now: NOW, positions: [notAtStop], state, engine: e }), limits);
  assert.equal(plain.allowed, false);
  assert.ok(plain.violations.some((x) => x.startsWith("cooldown")) && plain.violations.some((x) => x.startsWith("knife")), plain.violations.join("; "));
});

test("ask exit: a band at its stop may leave into an ask (no override to a sale); an engine ask exit is an emergency; the kill switch still blocks the open", () => {
  // 0.3 in, 0.222 now, fees aside: 27% down, past the stop
  const state = { ...freshState(), entryValueSol: { pos1: 0.3 } };
  const v = evaluate(askExit(), ctx({ now: NOW, positions: [throughBand], state }), limits);
  assert.equal(v.allowed, true, v.violations.join("; "));
  assert.equal(v.decision.action, "REBALANCE", "not overridden to a CLOSE");
  assert.equal(v.overrides.length, 0);
  assert.equal(v.emergency, true);
  assert.ok(v.passed.some((x) => x.includes("into an ask")), v.passed.join("; "));
  const fromEngine = evaluate(askExit(), ctx({ now: NOW, positions: [{ ...throughBand, valueInSol: 0.29 }], state: { ...freshState(), entryValueSol: { pos1: 0.3 }, actionsToday: 24 }, source: "engine" }), limits);
  assert.equal(fromEngine.allowed, true, fromEngine.violations.join("; "));
  assert.equal(fromEngine.emergency, true);
  // an ordinary REBALANCE of a band at its stop is still overridden into the sale
  const plain = evaluate({ ...askExit(), exitAsk: undefined }, ctx({ now: NOW, positions: [throughBand], state }), limits);
  assert.equal(plain.decision.action, "CLOSE_POSITION");
  assert.equal(plain.decision.liquidate, true);
  // the kill switch: no ask laid (the loop never proposes one under it; the guards agree), the stop then forces the sale
  const killed = evaluate(askExit(), ctx({ now: NOW, positions: [throughBand], state, killSwitch: true }), limits);
  assert.equal(killed.allowed, false);
  assert.ok(killed.violations.some((x) => x.startsWith("kill switch")), killed.violations.join("; "));
});

test("ask exit: the stop reads an ask band against its chain's basis", () => {
  const ask = { pool: "pool", since: NOW - 60_000, basisSol: 0.3, from: "bid", tokens: 130, relays: 1, bankedSol: 0 };
  // re-laid at 0.25, worth 0.26 now: up on its own entry, 13% under the chain's basis; its stop is 10%
  const state = { ...freshState(), entryValueSol: { ask1: 0.25 }, askBands: { ask1: ask } };
  const p: PositionSnapshot = { ...throughBand, address: "ask1", valueInSol: 0.26, feeX: 0, feeY: 0 };
  const v = evaluate({ ...open(), action: "HOLD", open: null }, ctx({ now: NOW, positions: [p], state, engine: engine({ stops: { ask1: 10 } }) }), limits);
  assert.equal(v.decision.action, "CLOSE_POSITION");
  assert.ok(v.overrides[0].includes("ask1 is 13.3% below entry"), v.overrides[0]);
  // the same band, no ask record: judged on its own entry, no stop
  const own = evaluate({ ...open(), action: "HOLD", open: null }, ctx({ now: NOW, positions: [p], state: { ...state, askBands: {} }, engine: engine({ stops: { ask1: 10 } }) }), limits);
  assert.equal(own.decision.action, "HOLD");
  // what the chain has already banked in SOL comes off the basis: the same band is not down at all
  const banked = evaluate({ ...open(), action: "HOLD", open: null }, ctx({ now: NOW, positions: [p], state: { ...state, askBands: { ask1: { ...ask, bankedSol: 0.04 } } }, engine: engine({ stops: { ask1: 10 } }) }), limits);
  assert.equal(banked.decision.action, "HOLD", "0.26 against a basis of 0.30 less 0.04 banked: whole");
});

// ---- H1: the desk never swaps its own token or the copycat's, and never seats a pool that holds either ----
const HOUSE = "MRBANDSm1ntXXXXXXXXXXXXXXXXXXXXXXXXXXXXpump";
const COPYCAT = "JAARLUawF9DTauc9pHUyYpga8mDU3172cY7NzLfhpJ6m";
const h1 = { house: [HOUSE], copycat: COPYCAT_MINTS };
const housePool: PoolSnapshot = { ...snapshot, address: "housepool", label: "MRBANDS/SOL", tokenX: { ...snapshot.tokenX, mint: HOUSE, symbol: "MRBANDS" }, baseToken: { ...snapshot.baseToken, mint: HOUSE, symbol: "MRBANDS" } };

test("H1: the house mint is TOKEN_MINT plus PAIR_HOUSE_MINTS, de-duplicated; empty until the token exists; the copycat is on the list", () => {
  assert.deepEqual(houseMintsOf({}), []);
  assert.deepEqual(houseMintsOf({ TOKEN_MINT: ` ${HOUSE} ` }), [HOUSE]);
  assert.deepEqual(houseMintsOf({ TOKEN_MINT: HOUSE, PAIR_HOUSE_MINTS: `b, ${HOUSE}` }), [HOUSE, "b"]);
  assert.deepEqual([...COPYCAT_MINTS], [COPYCAT]);
});

test("H1: any swap leg with the house mint in or out is refused, and the copycat's too; other legs pass", () => {
  assert.match(houseSwapViolation("So11111111111111111111111111111111111111112", HOUSE, h1)!, /output is the house mint .*never swaps its own token/);
  assert.match(houseSwapViolation(HOUSE, "So11111111111111111111111111111111111111112", h1)!, /input is the house mint/);
  assert.match(houseSwapViolation(COPYCAT, "So11111111111111111111111111111111111111112", h1)!, /copycat token: .*not ours/);
  assert.match(houseSwapViolation("So11111111111111111111111111111111111111112", COPYCAT, { house: [], copycat: COPYCAT_MINTS })!, /copycat/, "the copycat is refused before our token exists");
  assert.equal(houseSwapViolation("ansem", "So11111111111111111111111111111111111111112", h1), null);
  assert.equal(housePoolViolation({ address: "p", mints: ["ansem", "So11111111111111111111111111111111111111112"] }, h1), null);
});

test("H1: no band in the house token's pool, SOL_ONLY or a straddle with an acquire leg, the mint on either side; the verdict says why", () => {
  const plain = evaluate(open(), ctx({ snapshot: housePool, untouchable: h1 }), limits);
  assert.equal(plain.allowed, false);
  assert.equal(plain.decision.action, "HOLD");
  assert.ok(plain.violations.some((x) => /house token: MRBANDS\/SOL \(housepool\) holds the house mint/.test(x)), plain.violations.join("; "));
  const withAcquire = evaluate(open({ side: "BOTH", amountSol: 0.2, amountToken: 10, acquireToken: 10, binsBelowActive: 5, binsAboveActive: 5 }), ctx({ snapshot: housePool, untouchable: h1 }), limits);
  assert.ok(withAcquire.violations.some((x) => x.startsWith("house token:")), withAcquire.violations.join("; "));
  // the house mint on the quote side of a pool is caught as well
  const quoteSide: PoolSnapshot = { ...snapshot, tokenY: { ...snapshot.tokenY, mint: HOUSE } };
  assert.ok(evaluate(open(), ctx({ snapshot: quoteSide, untouchable: h1 }), limits).violations.some((x) => x.startsWith("house token:")));
  // the ordinary pool is untouched by the rule and says it passed
  const fine = evaluate(open(), ctx({ untouchable: h1 }), limits);
  assert.equal(fine.allowed, true, fine.violations.join("; "));
  assert.ok(fine.passed.includes("house-token"));
});

test("H1: the copycat's pool is never seated either", () => {
  const copyPool: PoolSnapshot = { ...snapshot, address: "copypool", label: "BANDS/SOL", tokenX: { ...snapshot.tokenX, mint: COPYCAT }, baseToken: { ...snapshot.baseToken, mint: COPYCAT } };
  const v = evaluate(open(), ctx({ snapshot: copyPool, untouchable: { house: [], copycat: COPYCAT_MINTS } }), limits);
  assert.equal(v.allowed, false);
  assert.ok(v.violations.some((x) => /copycat token: BANDS\/SOL \(copypool\) .*not ours/.test(x)), v.violations.join("; "));
});

test("H1: the guard reads TOKEN_MINT from the environment when the context names no list; exits are not held by it", () => {
  const before = process.env.TOKEN_MINT;
  process.env.TOKEN_MINT = HOUSE;
  try {
    assert.ok(evaluate(open(), ctx({ snapshot: housePool }), limits).violations.some((x) => x.startsWith("house token:")));
    const inHouse = { ...position, address: "hpos" };
    const close = evaluate({ action: "CLOSE_POSITION", open: null, positionAddress: "hpos", reasoning: "test", confidence: 1, headline: "test" }, ctx({ snapshot: housePool, positions: [inHouse] }), limits);
    assert.equal(close.allowed, true, close.violations.join("; "));
  } finally {
    if (before === undefined) delete process.env.TOKEN_MINT;
    else process.env.TOKEN_MINT = before;
  }
});

async function jupiterDoor(): Promise<void> {
  const before = process.env.TOKEN_MINT;
  process.env.TOKEN_MINT = HOUSE;
  let calls = 0;
  const client = new JupiterClient({ fetch: async () => (calls++, new Response("{}")), minGapMs: 0, maxRetries: 0 });
  try {
    await assert.rejects(client.quote({ inputMint: "So11111111111111111111111111111111111111112", outputMint: HOUSE, amount: 1000n }), /quote refused: house token: the swap's output is the house mint/);
    await assert.rejects(client.quote({ inputMint: HOUSE, outputMint: "So11111111111111111111111111111111111111112", amount: 1000n }), /quote refused: house token: the swap's input/);
    await assert.rejects(client.quote({ inputMint: COPYCAT, outputMint: "So11111111111111111111111111111111111111112", amount: 1000n }), /quote refused: copycat token/);
    const fakeQuote = { inputMint: HOUSE, outputMint: "So11111111111111111111111111111111111111112", inAmount: 1n, outAmount: 1n, otherAmountThreshold: 1n, swapMode: "ExactIn" as const, slippageBps: 50, priceImpactPct: 0, routeLabels: [], raw: {} };
    await assert.rejects(client.buildSwap(fakeQuote, "9q3VKDrHBusoxsWEBwkzNmRe51AV5kGEMA2Yic5EPkVW"), /swap refused: house token/);
    assert.equal(calls, 0, "refused before any request to Jupiter");
  } finally {
    if (before === undefined) delete process.env.TOKEN_MINT;
    else process.env.TOKEN_MINT = before;
  }
  n += 1;
  console.log(`ok ${n} - H1: the Jupiter door refuses a house or copycat leg on quote and on build, before any request`);
}

jupiterDoor().then(
  () => console.log(`${n} guard tests passed (with portfolio, engine, stale-marks, USDC-quote, basis, straddle, ask-exit and house-token checks)`),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
