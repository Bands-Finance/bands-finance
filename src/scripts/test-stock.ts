/**
 * Stock-book tests: the straddle end to end, pure (no RPC, no LLM, no network; writes only to a temp dir).
 *   npm run test:stock
 * Covers: the policy's straddle geometry and acquire sizing on a SPYx/USDC CLMM fixture (the guards
 * accept exactly what the policy proposes), the session width, the re-centre trigger (churn-wait,
 * REBALANCE with a buy or a sale, liquidating CLOSE when gated), the guards on acquire/liquidate,
 * paperSwap's math and the paper wallet's buy/sell, the paper hedge book by hand (open, add, mark,
 * funding, buy back, close), the paper executor's swap legs with the ledger's swap rows, the USD
 * report view and its identity, and the hedge desk wired to a fake Backpack client (paper fill,
 * plan-only, live order).
 */
// The straddle tests are about geometry and legs, not economics: the fixtures' pools are thin enough
// that the policy's seat-yield floor would refuse them, so it is switched off here. The floor and the
// payback test have their own tests in src/scripts/test-paper.ts.
process.env.POLICY_MIN_SEAT_YIELD_PCT = "0";
process.env.POLICY_MAX_PAYBACK_HOURS = "0";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BN from "bn.js";
import type { Observation } from "../agent/observation";
import type { Decision } from "../agent/schema";
import type { JournalEntry } from "../journal";
import type { HedgeClient } from "../engine/hedgeDesk";
import type { RiskLimits } from "../risk/limits";
import type { Verdict } from "../risk/guards";
import type { PoolSnapshot, PositionSnapshot } from "../tools/dlmm";

// Everything that reads src/config.ts is imported after the environment is pinned.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mr-bands-stock-"));
process.env.DATA_DIR = tmp;
process.env.ANTHROPIC_API_KEY = "";
delete process.env.ANTHROPIC_AUTH_TOKEN;
process.env.DRY_RUN = "true";
process.env.WALLET_SECRET_KEY = "";
process.env.PAPER_SOL = "";
process.env.PAPER_SOL = "100"; // "Hedged." means the hedge desk acts: paper's virtual hedge here (src/agent/policy.ts hedgeArmed)
process.env.MAX_POSITION_SOL = "22.5";
process.env.MAX_TOTAL_EXPOSURE_SOL = "90";
process.env.GAS_RESERVE_SOL = "1";
process.env.STOP_LOSS_PCT = "15";
process.env.MAX_BIN_WIDTH = "69";
process.env.MAX_TX_PER_DAY = "24";
process.env.MIN_SECONDS_BETWEEN_ACTIONS = "600";
process.env.MAX_SLIPPAGE_PCT = "1";
process.env.MAX_PRICE_MOVE_PCT_PER_CYCLE = "40";
process.env.POLICY_COVER_PCT = "5";
process.env.POLICY_MIN_SCORE = "20";
delete process.env.STOCK_COVER_PCT;
delete process.env.SWAP_FEE_PCT;
delete process.env.SWAP_SLIPPAGE_BPS;
delete process.env.PAPER_HEDGE_FEE_PCT;
delete process.env.HEDGE_LIVE;
delete process.env.HEDGE_MAX_NOTIONAL_USD;
delete process.env.HEDGE_MIN_REBALANCE_USD;
delete process.env.BACKPACK_API_KEY;
delete process.env.BACKPACK_API_SECRET;
process.env.BOOK = "stocks";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err);
    process.exit(1);
  }
}
const near = (a: number | null | undefined, b: number, tol = 1e-6, what = "") => {
  assert.ok(a !== null && a !== undefined && Number.isFinite(a), `${what} expected ${b}, got ${a}`);
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what} expected ${b}, got ${a} (tol ${tol})`);
};

const limits: RiskLimits = { maxPositionSol: 22.5, maxTotalExposureSol: 90, gasReserveSol: 1, stopLossPct: 15, maxBinWidth: 69, maxTxPerDay: 24, minSecondsBetweenActions: 600, maxSlippagePct: 1, maxPriceMovePctPerCycle: 40 };
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SPYX_MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const SPYX_POOL = "6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE";
const PERP = "SPY.US_USDC_PERP";
const T0 = Date.parse("2026-09-14T17:30:00.000Z"); // Monday 13:30 ET: the regular US session
const SOL_USD = 100;

async function main(): Promise<void> {
  const bins = await import("../tools/bins.js");
  const raydium = await import("../venues/raydium.js");
  const venues = await import("../venues/index.js");
  const sdk = await import("@raydium-io/raydium-sdk-v2");
  const policy = await import("../agent/policy.js");
  const { evaluate } = await import("../risk/guards.js");
  const { emptyState } = await import("../risk/state.js");
  const { execute } = await import("../executor.js");
  const paper = await import("../paper/index.js");
  const jup = await import("../tools/jupiter.js");
  const ledger = await import("../engine/ledger.js");
  const hedge = await import("../engine/hedge.js");
  const desk = await import("../engine/hedgeDesk.js");

  /** SPYx/USDC as the Raydium adapter reads it: X = SPYx (8 dec), Y = USDC (6 dec), spacing 10, tick 20383 (~767 USDC). */
  const SPACING = 10;
  const TICK = 20383;
  const ACTIVE = bins.tickToBin(TICK, SPACING);
  const L = new BN("22888489973583");
  const clmmPrice = (bin: number) => bins.binPrice({ binStep: SPACING, priceModel: "clmm", tokenX: { decimals: 8 }, tokenY: { decimals: 6 } }, bin);
  function snapAt(active: number, over: Partial<PoolSnapshot> = {}): PoolSnapshot {
    const tick = active * SPACING + 3;
    const sqrt = sdk.TickUtil.getSqrtPriceAtTick(tick);
    const tokenX = { mint: SPYX_MINT, symbol: "SPYx", decimals: 8, reserve: 1099.19 };
    const tokenY = { mint: USDC_MINT, symbol: "USDC", decimals: 6, reserve: 1_579_043.63 };
    const activePrice = sdk.TickUtil.sqrtPriceX64ToPrice(sqrt, 8, 6).toNumber();
    const rows = raydium.clmmBins({ tickSpacing: SPACING, tickCurrent: tick, sqrtPriceX64: sqrt, liquidity: L, ticks: new Map() }, clmmPrice, 8, 6, 10);
    return {
      address: SPYX_POOL,
      label: "SPYx/USDC",
      tokenX,
      tokenY,
      solSide: null,
      baseToken: tokenX,
      binStep: SPACING,
      activeBinId: active,
      activePrice,
      priceLabel: "USDC per SPYx",
      tokenPriceInSol: activePrice / SOL_USD,
      quoteSide: "Y",
      quoteToken: tokenY,
      quoteSymbol: "USDC",
      quotePriceInSol: 1 / SOL_USD,
      tokenPriceInQuote: activePrice,
      solPriceUsd: SOL_USD,
      baseFeePct: 0.1,
      maxFeePct: 0.1,
      dynamicFeePct: 0.1,
      hasDynamicFee: false,
      bins: rows,
      liquidityBelowY: rows.filter((b) => b.binId < active).reduce((t, b) => t + b.yAmount, 0),
      liquidityAboveX: rows.filter((b) => b.binId > active).reduce((t, b) => t + b.xAmount, 0),
      fetchedAt: new Date(T0).toISOString(),
      priceModel: "clmm",
      venue: "raydium-clmm",
      clmm: { tickSpacing: SPACING, tickCurrent: tick, sqrtPriceX64: sqrt.toString(), liquidity: L.toString(), initializedTickArrays: [19200, 19800, 20400, 21000] },
      ...over,
    };
  }
  const s0 = snapAt(ACTIVE);
  const P = s0.activePrice;
  const engineObs = (over: Partial<NonNullable<Observation["engine"]>> = {}): NonNullable<Observation["engine"]> => ({
    halt: null,
    standDown: null,
    bench: { stops6h: 0, multiplier: 1, benched: false, reason: null },
    regime: { medianMove24hPct: 0, multiplier: 1, reason: null },
    sizeMultiplier: 1,
    effectiveMaxPositionSol: 22.5,
    stops: {},
    outOfRangeSec: {},
    minOutOfRangeSec: 600,
    knife: null,
    collectsToday: 0,
    collectMaxPerDay: 30,
    basis: { session: "regular", minutesToOpen: 0, basisPct: 0.69, perpSymbol: PERP, perpMid: 758.4, widthMultiplier: 1, reason: null },
    ...over,
  });
  function obs(over: Partial<Observation> = {}, snapshot: PoolSnapshot = s0): Observation {
    return {
      ts: new Date(T0).toISOString(),
      cycle: 1,
      mode: "dry-run",
      poolLabel: snapshot.label,
      snapshot,
      positions: [],
      wallet: { address: "w", sol: 100, token: 0, tokenSymbol: "SPYx", quote: 5000, quoteSymbol: "USDC" },
      analytics: null,
      state: { actionsToday: 0, lastActionAt: null, lastMoveAt: null, lastPrice: null, killSwitch: false },
      recent: [],
      screen: { rank: 30, rankedPools: 400, score: 4.3, feeToTvl24hPct: 0.16, volume24hUsd: 3_500_000, tvlUsd: 2_238_060, ageHours: 2000, priceChange24hPct: 0.4, flags: [], generatedAt: new Date(T0).toISOString(), stock: { ticker: "SPY", issuer: "xstocks" }, alternatives: [], hot: [] },
      portfolio: { activePools: [], poolsWithBands: 0, maxActivePools: 4, otherExposureSol: 0 },
      engine: engineObs(),
      ...over,
    };
  }
  // the re-centre cost gate is off here (these tests are about the re-centre itself); its own test turns it on
  const x = { limits, env: { book: "stocks" as const, stockRecentreMaxPaybackHours: 0 }, now: T0, openCostSol: raydium.CLMM_OPEN_COST_DEFAULT_SOL };
  const guardCtx = (o: Observation, over: Partial<Parameters<typeof evaluate>[1]> = {}) => ({
    now: T0,
    snapshot: o.snapshot,
    positions: o.positions,
    walletSol: o.wallet.sol,
    walletToken: o.wallet.token,
    walletQuote: o.wallet.quote,
    state: emptyState(),
    killSwitch: false,
    otherExposureSol: 0,
    poolsWithBands: 0,
    maxActivePools: 4,
    openCostSol: raydium.CLMM_OPEN_COST_DEFAULT_SOL,
    ...over,
  });
  const voice = (d: Decision) => {
    assert.ok(d.headline.length <= 90, `headline ${d.headline.length} chars: ${d.headline}`);
    assert.ok(!d.headline.includes("—") && !d.reasoning.includes("—"), "no em dashes");
    assert.ok(d.reasoning.split(/[.!?]\s/).length >= 2, "at least two sentences");
    assert.match(d.reasoning, /\d/, "numbers in the reasoning");
  };

  console.log("policy: straddle geometry and acquire sizing");
  await test("no band, 5000 USDC and no SPYx: a 31-bin BOTH straddle, 15 bins each side (1.5% of price), half USDC half SPYx, the SPYx bought first; the max band binds", () => {
    const r = policy.policyDecide(obs(), x);
    assert.equal(r.branch, "open", r.reason);
    const d = r.decision;
    const o = d.open!;
    assert.equal(o.side, "BOTH");
    assert.equal(o.strategy, "Spot");
    assert.equal(o.binsBelowActive, 15);
    assert.equal(o.binsAboveActive, 15);
    assert.equal(policy.stockBinsPerSide(10, 1.5, 69, 1), 15);
    // max band 22.5 SOL = 2250 USDC: 1125 USDC + 1125 / P SPYx, all of it bought
    assert.equal(o.amountSol, 1125);
    near(o.amountToken, Math.floor((1125 / P) * 1e6) / 1e6, 1e-12, "token half");
    assert.equal(o.acquireToken, o.amountToken);
    assert.match(d.reasoning, /31-bin Spot straddle from bin \d+ to \d+ \(15 bins each side, 1\.51% of price each way\)/);
    assert.match(d.reasoning, /buying [\d.]+ SPYx first \(the wallet holds 0\)/);
    assert.match(d.reasoning, /bound by max band 22\.5 SOL/);
    assert.match(d.reasoning, /hedged short on Backpack SPY\.US_USDC_PERP/);
    assert.match(d.headline, /^Straddling SPYx\/USDC: 1125 USDC \+ [\d.]+ SPYx across 31 bins\. Hedged\.$/);
    voice(d);
    // the guards accept exactly this: 1125 + the purchase at 1% slippage fits 5000 USDC
    const v = evaluate(d, guardCtx(obs()), limits);
    assert.deepEqual(v.violations, []);
    assert.match(v.passed.join(), /width 31/);
  });
  await test("the wallet binds: 1000 USDC funds the quote half plus the token half bought at 1% slippage, and the guards agree to the cent", () => {
    const o = obs({ wallet: { address: "w", sol: 100, token: 0, tokenSymbol: "SPYx", quote: 1000, quoteSymbol: "USDC" } });
    const r = policy.policyDecide(o, x);
    assert.equal(r.branch, "open", r.reason);
    const p = r.decision.open!;
    // S = 2 x 950 / 2.01 = 945.27: 472.63 USDC + 472.63 / P SPYx
    near(p.amountSol, Math.floor(((2 * 950) / 2.01 / 2) * 100) / 100, 1e-9, "quote half");
    near(p.amountToken * P, p.amountSol, 2e-3, "token half worth the quote half");
    assert.equal(p.acquireToken, p.amountToken);
    const spend = p.amountSol + p.acquireToken! * P * 1.01;
    assert.ok(spend <= 950.0001 && spend > 940, `spend ${spend} inside 95% of the wallet`);
    assert.match(r.decision.reasoning, /bound by the wallet's 1000 USDC and 0 SPYx/);
    assert.deepEqual(evaluate(r.decision, guardCtx(o), limits).violations, []);
  });
  await test("the wallet already holds SPYx: nothing is bought, the quote half alone is spent; a partial holding buys only the shortfall", () => {
    const rich = obs({ wallet: { address: "w", sol: 100, token: 5, tokenSymbol: "SPYx", quote: 1000, quoteSymbol: "USDC" } });
    const r = policy.policyDecide(rich, x);
    assert.equal(r.branch, "open", r.reason);
    assert.equal(r.decision.open!.amountSol, 950, "S = 2 x 950: the quote half binds, the token half is held");
    assert.equal(r.decision.open!.acquireToken, 0);
    assert.match(r.decision.reasoning, /the wallet already holds the SPYx half/);
    assert.deepEqual(evaluate(r.decision, guardCtx(rich), limits).violations, []);
    const some = obs({ wallet: { address: "w", sol: 100, token: 0.5, tokenSymbol: "SPYx", quote: 5000, quoteSymbol: "USDC" } });
    const r2 = policy.policyDecide(some, x);
    near(r2.decision.open!.acquireToken!, r2.decision.open!.amountToken - 0.5, 1e-6, "buys the shortfall");
    assert.match(r2.decision.reasoning, /buying [\d.]+ SPYx first \(the wallet holds 0\.5\)/);
    assert.deepEqual(evaluate(r2.decision, guardCtx(some), limits).violations, []);
  });
  await test("depth binds: a thin pool caps the seat at both sides' depth (share 50%); the exposure room and the size multiplier cap it too", () => {
    const thin = snapAt(ACTIVE, { liquidityBelowY: 300, liquidityAboveX: 0.4 }); // 30 USDC/bin below, 0.04 SPYx/bin (~30 USDC) above
    const r = policy.policyDecide(obs({}, thin), x);
    assert.equal(r.branch, "open", r.reason);
    const depth = 30 * 15 + 0.04 * 15 * P;
    near(r.decision.open!.amountSol, Math.floor((Math.floor(depth * 100) / 100 / 2) * 100) / 100, 1e-9, "half the depth");
    assert.match(r.decision.reasoning, /bound by half the band's depth on both sides/);
    assert.match(r.decision.reasoning, /our share of the band 50%/);
    const room = policy.policyDecide(obs({ portfolio: { activePools: [], poolsWithBands: 3, maxActivePools: 4, otherExposureSol: 85 } }), x);
    assert.equal(room.decision.open!.amountSol, 250, "5 SOL of room = 500 USDC, half each side");
    const half = policy.policyDecide(obs({ engine: engineObs({ sizeMultiplier: 0.5, effectiveMaxPositionSol: 11.25 }) }), x);
    assert.equal(half.decision.open!.amountSol, 562.5);
    const tiny = policy.policyDecide(obs({ wallet: { address: "w", sol: 100, token: 0, tokenSymbol: "SPYx", quote: 300, quoteSymbol: "USDC" } }), x);
    assert.equal(tiny.branch, "no-size");
    assert.match(tiny.reason, /under the minimum seat/);
    const thinner = policy.policyDecide(obs({}, snapAt(ACTIVE, { liquidityBelowY: 100, liquidityAboveX: 0.1 })), x);
    assert.equal(thinner.branch, "no-size", "265 USDC of depth: under the 4.5 SOL minimum seat");
    assert.match(thinner.reason, /bound by half the band's depth on both sides \(265\.\d\d USDC\)\) is under the minimum seat 4\.5 SOL/);
    const broke = policy.policyDecide(obs({ wallet: { address: "w", sol: 1.005, token: 0, tokenSymbol: "SPYx", quote: 5000, quoteSymbol: "USDC" } }), x);
    assert.equal(broke.branch, "no-size");
    assert.match(broke.reason, /gas reserve/);
  });
  await test("a non-stock pool keeps the quote-only band (BOOK=stocks or not); a stock pool on BOOK=all still needs a score or a hot row, then straddles", () => {
    const plain = obs({ screen: { ...obs().screen!, stock: null, score: 30 }, engine: engineObs({ basis: undefined }) });
    const r = policy.policyDecide(plain, x);
    assert.equal(r.branch, "open");
    assert.equal(r.decision.open!.side, "SOL_ONLY");
    assert.equal(r.decision.open!.binsAboveActive, 0);
    const all = policy.policyDecide(obs(), { ...x, env: { book: "all" } });
    assert.equal(all.branch, "not-worth");
    const scored = policy.policyDecide(obs({ screen: { ...obs().screen!, score: 30 } }), { ...x, env: { book: "all" } });
    assert.equal(scored.branch, "open");
    assert.equal(scored.decision.open!.side, "BOTH");
  });

  console.log("policy: session width");
  await test("pre/after x1.5 -> 22 bins each side, closed x2 -> 30; each side capped so the band fits MAX_BIN_WIDTH; the clock is used when the loop gives no multiplier", () => {
    const after = policy.policyDecide(obs({ engine: engineObs({ basis: { ...engineObs().basis!, session: "after", widthMultiplier: 1.5 } }) }), x);
    assert.equal(after.decision.open!.binsBelowActive, 22);
    assert.equal(after.decision.open!.binsAboveActive, 22);
    assert.match(after.decision.reasoning, /45-bin Spot straddle .*\(x1\.5 for the after US session\)/);
    const closed = policy.policyDecide(obs({ engine: engineObs({ basis: { ...engineObs().basis!, session: "closed", widthMultiplier: 2 } }) }), x);
    assert.equal(closed.decision.open!.binsBelowActive, 30);
    const narrow = policy.policyDecide(obs({ engine: engineObs({ basis: { ...engineObs().basis!, session: "closed", widthMultiplier: 2 } }) }), { ...x, limits: { ...limits, maxBinWidth: 21 } });
    assert.equal(narrow.decision.open!.binsBelowActive, 10, "(21 - 1) / 2");
    assert.equal(policy.stockBinsPerSide(1, 1.5, 69, 2), 34, "a 1 bps pool is capped by the width, not the cover");
    assert.equal(policy.stockBinsPerSide(60, 1.5, 69, 1), 2, "1.5% at 60 bps rounds to 2 bins; the floor is 1, not 3");
    assert.equal(policy.stockBinsPerSide(400, 0.2, 69, 1), 1, "a band is never narrower than the one bin that earns");
    // no multiplier from the loop: the NYSE clock decides (Sunday = closed = x2)
    const sunday = policy.policyDecide(obs({ engine: engineObs({ basis: undefined }) }), { ...x, now: Date.parse("2026-09-13T17:30:00.000Z") });
    assert.equal(sunday.decision.open!.binsBelowActive, 30);
  });

  console.log("policy: re-centre trigger");
  /** a paper straddle opened at ACTIVE (1125 USDC + the matching SPYx, 15 bins each side), marked at `active` */
  function straddleAt(active: number): { pos: PositionSnapshot; snap: PoolSnapshot; book: ReturnType<typeof paper.emptyBook> } {
    const book = paper.emptyBook(100, 10_000, T0 - 3600e3);
    const tokenHalf = Math.floor((1125 / P) * 1e6) / 1e6;
    paper.buyToken(book, { quoteSymbol: "USDC", tokenMint: SPYX_MINT, tokenSymbol: "SPYx", tokenPriceInQuote: P, quotePriceInSol: 0.01, tokenOut: tokenHalf, feePct: 0.1 });
    paper.openBand(book, {
      pool: SPYX_POOL, label: "SPYx/USDC", quoteSymbol: "USDC", quoteSide: "Y", quoteMint: USDC_MINT, tokenMint: SPYX_MINT, tokenSymbol: "SPYx", xDecimals: 8, yDecimals: 6, binStep: SPACING,
      activeBinId: ACTIVE, activePrice: P, tokenPriceInQuote: P, quotePriceInSol: 0.01, lowerBinId: ACTIVE - 15, upperBinId: ACTIVE + 15, lowerPrice: clmmPrice(ACTIVE - 15), upperPrice: clmmPrice(ACTIVE + 15),
      side: "BOTH", strategy: "Spot", amountQuote: 1125, amountToken: tokenHalf, slippagePct: 0.3, now: T0 - 3600e3, priceModel: "clmm", rentChargedSol: raydium.CLMM_OPEN_COST_DEFAULT_SOL, rentRefundableSol: raydium.CLMM_POSITION_RENT_SOL,
    });
    const snap = snapAt(active);
    const [pos] = paper.markPool(book, snap, { now: T0, fees: null, solPriceUsd: SOL_USD });
    return { pos, snap, book };
  }
  await test("in range: HOLD; out of range under the engine minimum: HOLD (churn-wait)", () => {
    const inr = straddleAt(ACTIVE + 5);
    const r = policy.policyDecide(obs({ positions: [inr.pos] }, inr.snap), x);
    assert.equal(r.branch, "in-range");
    assert.match(r.decision.reasoning, /Straddle paper- covers bins \[\d+, \d+\]/);
    voice(r.decision);
    const out = straddleAt(ACTIVE + 20);
    assert.equal(out.pos.inRange, false);
    assert.equal(out.pos.binsFromRange, 5);
    const wait = policy.policyDecide(obs({ positions: [out.pos], engine: engineObs({ outOfRangeSec: { [out.pos.address]: 100 } }) }, out.snap), x);
    assert.equal(wait.branch, "churn-wait");
    assert.match(wait.decision.reasoning, /5 bins above straddle .* Out of range 100s against the engine minimum 600s/);
    voice(wait.decision);
  });
  await test("seatEarnings: the flow scout's last hour sets the pool's fee pace when it is there; the 24h figure otherwise", () => {
    const o = obs({});
    const base = policy.seatEarnings(o, x, 20, 10, false)!;
    assert.ok(base.poolFeesPerDayUsd > 0);
    const flow = { asOf: T0, quoteSymbol: "USDC", swaps15m: 4, volume15mQuote: 1000, fees15mQuote: 1, ours15mQuote: 1, swaps60m: 12, volume60mQuote: 4000, fees60mQuote: 4, ours60mQuote: 4, feesPerDayQuote60m: 96, feesPerDayQuote15m: 96, lastPrice: null, lastSwapAt: T0, largest15m: null };
    const withFlow = policy.seatEarnings(obs({ screen: { ...o.screen!, flow } }), x, 20, 10, false)!;
    // 96 USDC a day at 0.01 SOL per USDC and the fixture's SOL price
    near(withFlow.poolFeesPerDayUsd, 96 * 0.01 * o.snapshot.solPriceUsd!, 1e-9);
    assert.notEqual(withFlow.poolFeesPerDayUsd, base.poolFeesPerDayUsd);
    const quiet = policy.seatEarnings(obs({ screen: { ...o.screen!, flow: { ...flow, feesPerDayQuote60m: null } } }), x, 20, 10, false)!;
    near(quiet.poolFeesPerDayUsd, base.poolFeesPerDayUsd, 1e-9, "under three swaps in the hour the 24h figure stands");
  });

  await test("half a straddle: the band holds only its USDC half while the wallet holds the SPYx half: REBALANCE that re-lays both without a swap; with no SPYx in the wallet the in-range hold stands", () => {
    const inr = straddleAt(ACTIVE + 5);
    assert.ok(inr.pos.amountX > 0.5, `the fixture's band holds ${inr.pos.amountX} SPYx`);
    // the seat's token half, what the swap would have bought: the wallet holds all of it, the band none
    const tokenHalf = Math.floor((1125 / P) * 1e6) / 1e6;
    const half = { ...inr.pos, amountX: 0, feeX: 0, valueInSol: inr.pos.valueInSol / 2, solInPosition: inr.pos.solInPosition / 2, quoteInPosition: (inr.pos.quoteInPosition ?? 0) };
    const o = obs({ positions: [half], wallet: { address: "w", sol: 100, token: tokenHalf, tokenSymbol: "SPYx", quote: 3000, quoteSymbol: "USDC" } }, inr.snap);
    const r = policy.policyDecide(o, x);
    assert.equal(r.branch, "rebalance", r.reason);
    assert.equal(r.decision.action, "REBALANCE");
    assert.equal(r.decision.positionAddress, half.address);
    assert.equal(r.decision.open!.side, "BOTH");
    assert.equal(r.decision.open!.acquireToken, 0, "the wallet has the token half: nothing to buy");
    assert.match(r.decision.headline, /^Half a straddle in SPYx\/USDC\. Laying both halves: /);
    assert.match(r.decision.reasoning, /holds only its USDC half: the wallet holds [\d.]+ SPYx, the token half, idle/);
    assert.match(r.reason, /half-laid: re-laying/);
    voice(r.decision);
    // the price climbed a bin since: the active bin turned some of the USDC into SPYx; still half a straddle
    const drifted = { ...half, amountX: 0.08, amountY: half.amountY - 0.08 * P };
    const r2 = policy.policyDecide(obs({ positions: [drifted], wallet: { address: "w", sol: 100, token: tokenHalf, tokenSymbol: "SPYx", quote: 3000, quoteSymbol: "USDC" } }, inr.snap), x);
    assert.equal(r2.branch, "rebalance", r2.reason);
    // no token in the wallet: the half-laid rule has nothing to re-lay with; the grow rule takes it
    // from here, the band being half the seat the book has room for, and buys the token half
    const empty = policy.policyDecide(obs({ positions: [half], wallet: { address: "w", sol: 100, token: 0, tokenSymbol: "SPYx", quote: 3000, quoteSymbol: "USDC" } }, inr.snap), x);
    assert.equal(empty.branch, "rebalance", empty.reason);
    assert.match(empty.reason, /growing from 11\.\d+ to 22\.\d+ SOL/);
    assert.ok((empty.decision.open!.acquireToken ?? 0) > 0, "buys the token half");
    assert.equal(policy.policyDecide(obs({ positions: [half], wallet: { address: "w", sol: 100, token: 0, tokenSymbol: "SPYx", quote: 3000, quoteSymbol: "USDC" } }, inr.snap), { ...x, env: { ...x.env, stockGrowMinPct: 0 } }).branch, "in-range", "with growing off, the band holds");
    const whole = policy.policyDecide(obs({ positions: [inr.pos], wallet: { address: "w", sol: 100, token: tokenHalf, tokenSymbol: "SPYx", quote: 3000, quoteSymbol: "USDC" } }, inr.snap), x);
    assert.equal(whole.branch, "in-range", "a band that holds both halves is left alone even with spare token in the wallet");
  });

  await test("grow: a straddle at an old cap re-lays bigger when the book has room for a much larger seat (STOCK_GROW_MIN_PCT); not at the cap, not twice a pass, not young, not when the added seat's fees would not earn the re-lay back", () => {
    const inr = straddleAt(ACTIVE + 5);
    const wallet = { address: "w", sol: 100, token: 0, tokenSymbol: "SPYx", quote: 3000, quoteSymbol: "USDC" };
    // the engine's effective max band moves with the limit (the fixture's engine view pins it at 22.5)
    const o = obs({ positions: [inr.pos], wallet, engine: engineObs({ effectiveMaxPositionSol: 45 }) }, inr.snap);
    const roomy = { ...x, limits: { ...limits, maxPositionSol: 45 } };
    const r = policy.policyDecide(o, roomy);
    assert.equal(r.branch, "rebalance", r.reason);
    assert.equal(r.decision.action, "REBALANCE");
    assert.equal(r.decision.positionAddress, inr.pos.address);
    assert.equal(r.decision.open!.side, "BOTH");
    assert.ok(r.decision.open!.amountSol > 1125 * 1.4, `grew to ${r.decision.open!.amountSol} USDC a side`);
    assert.ok((r.decision.open!.acquireToken ?? 0) > 0, "the added token half is bought");
    assert.match(r.decision.headline, /^Growing the seat in SPYx\/USDC: 22\.\d to \d+(\.\d)? SOL\.$/);
    assert.match(r.decision.reasoning, /holding 22\.\d+ SOL; the book has room for \d+(\.\d+)? SOL here \(bound by max band 45 SOL\)/);
    assert.match(r.reason, /growing from 22\.\d+ to/);
    voice(r.decision);
    assert.equal(policy.policyDecide(o, x).branch, "in-range", "at the cap: nothing to grow into");
    assert.equal(policy.policyDecide(o, { ...roomy, grow: { allowed: false } }).branch, "in-range", "money already moved this pass: the other pools' exposure is stale");
    assert.equal(policy.policyDecide(o, { ...roomy, env: { ...x.env, stockGrowMinPct: 0 } }).branch, "in-range", "off by env");
    assert.equal(policy.policyDecide(o, { ...roomy, env: { ...x.env, stockGrowMinPct: 120 } }).branch, "in-range", "45 is not 2.2 x 22.5");
    const young = obs({ positions: [inr.pos], wallet, engine: engineObs({ effectiveMaxPositionSol: 45 }), state: { ...o.state, lastMoveAt: T0 - 12 * 60_000 } }, inr.snap);
    assert.equal(policy.policyDecide(young, roomy).branch, "in-range", "twelve minutes since the last move: too young for the 15-minute default");
    assert.equal(policy.policyDecide(young, { ...roomy, env: { ...x.env, stockGrowMinAgeMin: 10 } }).branch, "rebalance");
    const gated = policy.policyDecide(obs({ ...young, state: { ...o.state, lastMoveAt: T0 - 5 * 60_000 } }, inr.snap), { ...roomy, env: { ...x.env, stockGrowMinAgeMin: 4 } });
    assert.equal(gated.branch, "gated", "the open gate (10 minutes between actions) still stands over the grow");
    assert.match(gated.reason, /could grow to \d+(\.\d+)? SOL; gated: /);
    const slow = policy.policyDecide(o, { ...roomy, env: { ...x.env, stockRecentreMaxPaybackHours: 0.0001 } });
    assert.equal(slow.branch, "in-range", slow.reason);
    assert.match(slow.reason, /could grow to \d+(\.\d+)? SOL; payback [\d.]+h > 0.0001h/);
    assert.match(slow.decision.headline, /^Room to grow in SPYx\/USDC, not worth the re-lay\. Holding\.$/);
    voice(slow.decision);
  });

  await test("price above the band past the minimum: REBALANCE to a fresh straddle around the new price, buying the token half (the old band is all USDC); the guards accept it", () => {
    const out = straddleAt(ACTIVE + 20);
    near(out.pos.amountX, 0, 1e-9, "all quote now");
    const o = obs({ positions: [out.pos], wallet: { address: "w", sol: 100, token: 0, tokenSymbol: "SPYx", quote: 3000, quoteSymbol: "USDC" }, engine: engineObs({ outOfRangeSec: { [out.pos.address]: 700 } }) }, out.snap);
    const r = policy.policyDecide(o, x);
    assert.equal(r.branch, "rebalance", r.reason);
    const d = r.decision;
    assert.equal(d.action, "REBALANCE");
    assert.equal(d.positionAddress, out.pos.address);
    assert.equal(d.open!.side, "BOTH");
    assert.equal(d.open!.binsBelowActive, 15);
    assert.equal(d.open!.amountSol, 1125, "the max band binds again");
    near(d.open!.amountToken, Math.floor((1125 / out.snap.activePrice) * 1e6) / 1e6, 1e-12);
    assert.equal(d.open!.acquireToken, d.open!.amountToken, "nothing held, nothing coming back: the whole token half is bought");
    assert.match(d.reasoning, /Re-centring: close it, then lay 1125 USDC \+ [\d.]+ SPYx as a 31-bin straddle/);
    assert.match(d.reasoning, /buying [\d.]+ SPYx first \(the wallet holds 0, the closing band returns 0\)/);
    voice(d);
    const state = { ...emptyState(), entryValueSol: { [out.pos.address]: out.pos.entryValueSol! } };
    const v = evaluate(d, guardCtx(o, { state, engine: { haltedUntil: null, standDownUntil: null, sizeMultiplier: 1, benched: false, benchReason: null, regimeReason: null, knife: null, outOfRangeSince: { [out.pos.address]: T0 - 700e3 }, stops: {}, outOfRangeSec: 600 } }), limits);
    assert.deepEqual(v.violations, []);
  });
  await test("re-centre cost gate: a re-centre the seat's fees take past STOCK_RECENTRE_MAX_PAYBACK_HOURS to earn back waits for the price, up to STOCK_RECENTRE_MAX_WAIT_MIN; a cheap one goes at once", () => {
    const out = straddleAt(ACTIVE + 20);
    const o = (sec: number, screen?: Partial<NonNullable<Observation["screen"]>>) =>
      obs({ positions: [out.pos], wallet: { address: "w", sol: 100, token: 0, tokenSymbol: "SPYx", quote: 3000, quoteSymbol: "USDC" }, engine: engineObs({ outOfRangeSec: { [out.pos.address]: sec } }), ...(screen ? { screen: { ...obs().screen!, ...screen } } : {}) }, out.snap);
    const gated = { ...x, env: { book: "stocks" as const } };
    const wait = policy.policyDecide(o(700), gated);
    assert.equal(wait.branch, "recentre-wait", wait.reason);
    assert.equal(wait.decision.action, "HOLD");
    assert.match(wait.decision.reasoning, /A fresh 31-bin straddle is allowed, but re-centring costs about [\d.]+ SOL \([\d.]+ SOL of swap at [\d.]+%\) and the seat's fees, about [\d.]+ SOL a day, take [\d.]+h to earn it back/);
    assert.match(wait.reason, /re-centre pays back in [\d.]+h > 4h, waiting up to 120m/);
    voice(wait.decision);
    // the pure cost: the swap is the token bought at the route's fee, the rent what the venue does not refund
    const sz = { acquireToken: 2, surplusToken: 0, seatSol: 20, sharePct: 10 };
    const q = { side: "Y", symbol: "USDC", token: out.snap.quoteToken!, priceInSol: 0.01, tokenPriceInQuote: 500 } as never;
    const rc = policy.recentreCost(o(700), { ...x, openCostSol: 0.2, openCostRefundableSol: 0.05 } as never, q, sz);
    near(rc.swapSol, 2 * 500 * 0.01 * (policy.swapFeePctFor(out.snap) / 100), 1e-12);
    near(rc.rentSol, 0.15, 1e-12);
    near(rc.costSol, rc.swapSol + 0.15, 1e-12);
    // past the wait it re-centres anyway
    assert.equal(policy.policyDecide(o(7300), gated).branch, "rebalance");
    // a pool whose fees pay the re-centre back fast: no wait
    assert.equal(policy.policyDecide(o(700, { tvlUsd: 100_000, feeToTvl24hPct: 400 }), { ...gated, openCostSol: 0, openCostRefundableSol: 0 }).branch, "rebalance");
    // a pool nothing priced (no fee figure): the gate does not guess, it re-centres
    assert.equal(policy.policyDecide(o(700, { feeToTvl24hPct: null }), gated).branch, "rebalance");
    assert.equal(policy.swapFeePctFor({ baseFeePct: 0.5 }, { SWAP_DEXES: "Meteora DLMM", SWAP_FEE_PCT: "0.1" }), 0.5, "Meteora-only routes pay the pool's fee");
    assert.equal(policy.swapFeePctFor({ baseFeePct: 0.5 }, { SWAP_FEE_PCT: "0.1" }), 0.1);
  });
  await test("price below the band: the old straddle is all SPYx, the re-centre sells the surplus back (no purchase)", () => {
    const out = straddleAt(ACTIVE - 20);
    near(out.pos.amountY, 0, 1e-9, "all token now");
    assert.ok(out.pos.amountX > 2, `token back ${out.pos.amountX}`);
    const o = obs({ positions: [out.pos], wallet: { address: "w", sol: 100, token: 0, tokenSymbol: "SPYx", quote: 3000, quoteSymbol: "USDC" }, engine: engineObs({ outOfRangeSec: { [out.pos.address]: 700 } }) }, out.snap);
    const r = policy.policyDecide(o, x);
    assert.equal(r.branch, "rebalance", r.reason);
    assert.equal(r.decision.open!.acquireToken, 0);
    assert.match(r.decision.reasoning, /selling [\d.]+ SPYx of the [\d.]+ the closing band returns/);
    assert.match(r.reason, /selling/);
    const state = { ...emptyState(), entryValueSol: { [out.pos.address]: out.pos.entryValueSol! } };
    const v = evaluate(r.decision, guardCtx(o, { state, engine: { haltedUntil: null, standDownUntil: null, sizeMultiplier: 1, benched: false, benchReason: null, regimeReason: null, knife: null, outOfRangeSince: { [out.pos.address]: T0 - 700e3 }, stops: {}, outOfRangeSec: 600 } }), limits);
    assert.deepEqual(v.violations, []);
  });
  await test("gated (basis rule, knife, kill switch): CLOSE with liquidate: true so the book returns to USDC; no size: the same", () => {
    const out = straddleAt(ACTIVE + 20);
    const e = engineObs({ outOfRangeSec: { [out.pos.address]: 700 } });
    const gated = policy.policyDecide(obs({ positions: [out.pos], engine: { ...e, basis: { ...e.basis!, reason: "NYSE opens in 12 min (< 30): the open reprices the stock, no new bands until it settles" } } }, out.snap), x);
    assert.equal(gated.branch, "close");
    assert.equal(gated.decision.action, "CLOSE_POSITION");
    assert.equal(gated.decision.liquidate, true);
    assert.equal(gated.decision.positionAddress, out.pos.address);
    assert.match(gated.decision.reasoning, /A fresh straddle is off \(NYSE opens in 12 min/);
    assert.match(gated.decision.reasoning, /its SPYx is sold back to USDC/);
    voice(gated.decision);
    const knife = policy.policyDecide(obs({ positions: [out.pos], engine: { ...e, knife: "knife: -25.0% in 30 min" } }, out.snap), x);
    assert.equal(knife.decision.liquidate, true);
    const kill = policy.policyDecide(obs({ positions: [out.pos], engine: e, state: { ...obs().state, killSwitch: true } }, out.snap), x);
    assert.equal(kill.branch, "close");
    const noSize = policy.policyDecide(obs({ positions: [out.pos], engine: e, wallet: { address: "w", sol: 1.001, token: 0, tokenSymbol: "SPYx", quote: 3000, quoteSymbol: "USDC" } }, out.snap), x);
    assert.equal(noSize.branch, "close");
    assert.match(noSize.reason, /gas reserve/);
  });

  await test("quote(): Jupiter's priceImpactPct is a fraction on the wire and a percent in the client", async () => {
    const wire = { inputMint: "A", outputMint: "B", inAmount: "1000", outAmount: "990", otherAmountThreshold: "985", swapMode: "ExactIn", slippageBps: 50, priceImpactPct: "0.0031", routePlan: [{ swapInfo: { label: "PumpSwap" } }] };
    const client = new jup.JupiterClient({ fetch: async () => new Response(JSON.stringify(wire), { status: 200, headers: { "content-type": "application/json" } }) });
    const q = await client.quote({ inputMint: "A", outputMint: "B", amount: 1000 });
    near(q.priceImpactPct, 0.31, 1e-12);
    assert.deepEqual(q.routeLabels, ["PumpSwap"]);
    // SWAP_DEXES rides on the quote as Jupiter's `dexes` parameter; unset sends none
    const urls: string[] = [];
    const meteoraOnly = new jup.JupiterClient({ dexes: ["Meteora DLMM"], fetch: async (u) => { urls.push(String(u)); return new Response(JSON.stringify(wire), { status: 200 }); } });
    await meteoraOnly.quote({ inputMint: "A", outputMint: "B", amount: 1000 });
    assert.equal(new URL(urls[0]).searchParams.get("dexes"), "Meteora DLMM");
    const anyRoute = new jup.JupiterClient({ dexes: null, fetch: async (u) => { urls.push(String(u)); return new Response(JSON.stringify(wire), { status: 200 }); } });
    await anyRoute.quote({ inputMint: "A", outputMint: "B", amount: 1000 });
    assert.equal(new URL(urls[1]).searchParams.get("dexes"), null);
  });

  console.log("paperSwap and the paper wallet's legs");
  await test("paperSwap: out = in x rate x (1 - fee); paperCostToBuy is its inverse; env defaults", () => {
    const f = jup.paperSwap(100, 1 / 767, 0.1);
    near(f.amountOut, 99.9 / 767, 1e-12);
    near(f.feeIn, 0.1, 1e-12);
    assert.equal(f.feePct, 0.1);
    near(jup.paperCostToBuy(1, 767, 0.1), 767 / 0.999, 1e-12);
    near(jup.paperSwap(jup.paperCostToBuy(2.5, 767, 0.1), 1 / 767, 0.1).amountOut, 2.5, 1e-12, "buy exactly 2.5 tokens");
    near(jup.paperSwap(2, 767, 0.1).amountOut, 2 * 767 * 0.999, 1e-12, "sell 2 tokens");
    assert.throws(() => jup.paperSwap(-1, 1, 0.1), /bad amountIn/);
    assert.throws(() => jup.paperSwap(1, 0, 0.1), /bad rate/);
    assert.deepEqual(jup.jupiterEnv({}), { apiUrl: "https://lite-api.jup.ag/swap/v1", slippageBps: 50, feePct: 0.1, dexes: null });
    assert.deepEqual(jup.jupiterEnv({ JUPITER_API_URL: "https://x.test/v1/", SWAP_SLIPPAGE_BPS: "25.7", SWAP_FEE_PCT: "0.3", SWAP_DEXES: " Meteora DLMM ,Meteora DLMM, " }), { apiUrl: "https://x.test/v1", slippageBps: 25, feePct: 0.3, dexes: ["Meteora DLMM"] });
    assert.equal(jup.meteoraOnlyRoutes(["Meteora DLMM", "Meteora DAMM v2"]), true);
    assert.equal(jup.meteoraOnlyRoutes(["Meteora DLMM", "Raydium CLMM"]), false);
    assert.equal(jup.meteoraOnlyRoutes(null), false);
    assert.equal(jup.toRawUnits(1.5, 8).toString(), "150000000");
    assert.equal(jup.toRawUnits(0.1234567891, 8).toString(), "12345679");
    near(jup.fromRawUnits(13048663n, 8), 0.13048663, 1e-15);
  });
  await test("buyToken / sellToken: the wallet moves, the fee lands in swapCostSol (and by mint), the equity identity holds through both", () => {
    const book = paper.emptyBook(1, 1000, T0);
    book.solPriceUsd = SOL_USD;
    book.tokenMarks[SPYX_MINT] = { symbol: "SPYx", priceInSol: 767 / SOL_USD, at: T0 };
    const start = paper.bookEquitySol(book).equitySol;
    const buy = paper.buyToken(book, { quoteSymbol: "USDC", tokenMint: SPYX_MINT, tokenSymbol: "SPYx", tokenPriceInQuote: 767, quotePriceInSol: 0.01, tokenOut: 1, feePct: 0.1 });
    near(buy.amountIn, 767 / 0.999, 1e-9);
    near(buy.amountOut, 1, 1e-9);
    near(book.wallet.usdc, 1000 - 767 / 0.999, 1e-9);
    near(book.wallet.tokens[SPYX_MINT], 1, 1e-9);
    near(book.swapCostSol!, buy.feeIn * 0.01, 1e-7, "the book keeps 9 decimals");
    near(book.swapCostByMint![SPYX_MINT], buy.feeIn * 0.01, 1e-7);
    near(paper.bookEquitySol(book).equitySol, start - book.swapCostSol!, 1e-9, "equity falls by the fee only");
    const sell = paper.sellToken(book, { quoteSymbol: "USDC", tokenMint: SPYX_MINT, tokenSymbol: "SPYx", tokenPriceInQuote: 767, quotePriceInSol: 0.01, tokenIn: 1, feePct: 0.1 });
    near(sell.amountOut, 767 * 0.999, 1e-9);
    assert.equal(book.wallet.tokens[SPYX_MINT], undefined, "sold out");
    near(paper.bookEquitySol(book).equitySol, start - book.swapCostSol!, 1e-9, "identity after the round trip");
    assert.throws(() => paper.sellToken(book, { quoteSymbol: "USDC", tokenMint: SPYX_MINT, tokenSymbol: "SPYx", tokenPriceInQuote: 767, quotePriceInSol: 0.01, tokenIn: 1 }), /cannot sell/);
    assert.throws(() => paper.buyToken(book, { quoteSymbol: "USDC", tokenMint: SPYX_MINT, tokenSymbol: "SPYx", tokenPriceInQuote: 767, quotePriceInSol: 0.01, tokenOut: 100 }), /paper wallet holds/);
  });

  console.log("paper hedge book by hand");
  await test("open, add, mark, funding, buy back, close: qty, average entry, fees, unrealized, realized and funding by hand", () => {
    const h = paper.emptyHedgeBook();
    const f1 = paper.fillPaperHedge(h, { pool: SPYX_POOL, symbol: PERP, ticker: "SPY", side: "Ask", quantity: 1.5, price: 760, now: T0, feePct: 0.02 });
    assert.deepEqual([f1.quantity, f1.qtyAfter, f1.entryAfter, f1.closed], [1.5, 1.5, 760, false]);
    near(f1.feeUsd, 1.5 * 760 * 0.0002, 1e-9);
    assert.equal(paper.paperShortQty(h, SPYX_POOL), 1.5);
    near(paper.markPaperHedge(h, SPYX_POOL, 765, T0 + 60e3)!.unrealizedUsd, -7.5, 1e-9, "(760 - 765) x 1.5");
    // 30 min at +0.001%/h: a short is PAID on a positive rate
    const fund = paper.accruePaperFunding(h, SPYX_POOL, 0.00001, 765, T0 + 1800e3)!;
    near(fund.hours, 0.5, 1e-9);
    near(fund.fundingUsd, -(1.5 * 765 * 0.00001 * 0.5), 1e-9, "received");
    near(h.fundingPaidUsd, fund.fundingUsd, 1e-12);
    const eq = paper.paperHedgeEquityUsd(h);
    near(eq.unrealizedUsd, -7.5, 1e-9);
    near(eq.netUsd, -7.5 - h.fundingPaidUsd - f1.feeUsd, 1e-9);
    near(eq.notionalUsd, 1.5 * 765, 1e-9);
    // funding gap is capped at an hour; a null rate advances the clock and accrues nothing
    const big = paper.accruePaperFunding(h, SPYX_POOL, 0.00001, 765, T0 + 10 * 3600e3)!;
    near(big.hours, 1, 1e-9);
    assert.equal(paper.accruePaperFunding(h, SPYX_POOL, null, 765, T0 + 11 * 3600e3)!.fundingUsd, 0);
    assert.equal(paper.accruePaperFunding(h, "other", 0.1, 1, T0), null);
    const f2 = paper.fillPaperHedge(h, { pool: SPYX_POOL, symbol: PERP, ticker: "SPY", side: "Ask", quantity: 0.5, price: 770, now: T0 + 2 * 3600e3, feePct: 0.02 });
    near(f2.entryAfter, (1.5 * 760 + 0.5 * 770) / 2, 1e-9, "average entry");
    assert.equal(f2.qtyAfter, 2);
    // buy back more than the short: clipped to it, realized (entry - price) x qty, the position closes
    const f3 = paper.fillPaperHedge(h, { pool: SPYX_POOL, symbol: PERP, ticker: "SPY", side: "Bid", quantity: 5, price: 755, now: T0 + 3 * 3600e3, feePct: 0.02 });
    assert.equal(f3.quantity, 2);
    near(f3.realizedUsd, (762.5 - 755) * 2, 1e-9);
    assert.equal(f3.closed, true);
    assert.equal(h.positions.length, 0);
    assert.equal(h.closed.length, 1);
    near(h.closed[0].realizedUsd, 15, 1e-9);
    assert.equal(h.closed[0].maxQty, 2);
    assert.equal(h.fills, 3);
    near(paper.paperHedgeEquityUsd(h).realizedUsd, 15, 1e-9);
    assert.throws(() => paper.fillPaperHedge(h, { pool: SPYX_POOL, symbol: PERP, ticker: "SPY", side: "Bid", quantity: 1, price: 755, now: T0 }), /nothing to buy back/);
    const byPool = paper.paperHedgeByPool(h);
    near(byPool[SPYX_POOL].realizedUsd, 15, 1e-9);
    assert.equal(paper.normalizeHedgeBook(undefined).positions.length, 0);
    assert.equal(paper.paperHedgeFeePct({}), 0.02);
    assert.equal(paper.paperHedgeFeePct({ PAPER_HEDGE_FEE_PCT: "0.05" }), 0.05);
  });

  console.log("paper executor: the straddle's swap legs");
  const verdictOf = (d: Decision, over: Partial<Verdict> = {}): Verdict => ({ proposal: d, decision: d, allowed: true, violations: [], overrides: [], passed: [], emergency: false, ...over });
  const book = paper.emptyBook(100, 10_000, T0);
  const ctx = (snapshot: PoolSnapshot, positions: PositionSnapshot[], now: number) =>
    ({ venue: venues.raydiumVenue, pool: { venue: "raydium-clmm", address: SPYX_POOL } as never, wallet: {} as never, rawPositions: [], snapshot, positions, paper: { book, slippagePct: 0.3, now } }) as Parameters<typeof execute>[1];
  const tokenHalf = Math.floor((1125 / P) * 1e6) / 1e6;
  const straddleOpen: Decision = { action: "OPEN_POSITION", open: { side: "BOTH", amountSol: 1125, amountToken: tokenHalf, acquireToken: tokenHalf, binsBelowActive: 15, binsAboveActive: 15, strategy: "Spot" }, positionAddress: null, reasoning: "r", confidence: 0.6, headline: "h" };
  let addr = "";
  await test("OPEN BOTH with acquireToken: a paper Jupiter buy, then the deposit; the wallet ends with no SPYx, the swap row and the open row are ledgered", async () => {
    const r = await execute(verdictOf(straddleOpen), ctx(s0, [], T0));
    assert.ok(r.ok, r.notes.join("; "));
    assert.equal(r.mode, "paper");
    assert.equal(r.txs.length, 2);
    assert.match(r.txs[0].label, /^swap [\d.]+ USDC -> [\d.]+ SPYx$/);
    assert.match(r.txs[0].skipped!, /acquire leg filled at .* less 0\.1%/);
    assert.match(r.txs[1].label, /^open BOTH band bins \[\d+, \d+\]$/);
    assert.match(r.txs[1].skipped!, /with 1125 USDC \+ [\d.]+ SPYx across 31 bins/);
    addr = r.opened!.address;
    const cost = jup.paperCostToBuy(tokenHalf, P, 0.1);
    near(book.wallet.usdc, 10_000 - 1125 - cost, 1e-6, "USDC: the half plus the purchase");
    assert.equal(book.wallet.tokens[SPYX_MINT] ?? 0, 0, "the SPYx bought went straight into the band");
    near(book.swapCostSol!, (cost - tokenHalf * P) * 0.01, 1e-9, "the swap fee");
    const b = book.bands[0];
    assert.deepEqual([b.side, b.lowerBinId, b.upperBinId, b.quoteDeposit, b.tokenDeposit], ["BOTH", ACTIVE - 15, ACTIVE + 15, 1125, tokenHalf]);
    near(b.entryValueSol, (1125 + tokenHalf * P) * 0.01, 1e-9);
    assert.deepEqual(r.ledger!.map((row) => row.mech), ["swap", "open"]);
    const sw = r.ledger![0];
    near(sw.quoteDelta!, -cost, 1e-6);
    near(sw.tokenDelta, tokenHalf, 1e-9);
    assert.match(sw.note, /acquire swap USDC -> SPYx .*\(price impact ignored\)/);
    // the day's realized from the ledger counts the swap's fee, never its notional
    const realized = ledger.realizedOnDaySol(r.ledger!, "dry-run", ledger.dayOf(T0));
    assert.ok(realized < 0 && realized > -0.02, `realized ${realized} SOL is the fee and the tx fees, not 11 SOL of notional`);
  });
  await test("marked at the open snapshot: in range, both halves, value = entry; equity identity with the swap cost", () => {
    const [pos] = paper.markPool(book, s0, { now: T0 + 60e3, fees: null, solPriceUsd: SOL_USD });
    assert.equal(pos.inRange, true);
    assert.ok(pos.amountX > 0 && pos.amountY > 0, "both halves");
    near(pos.valueInSol, book.bands[0].entryValueSol, 2e-3, "value at the open mark");
    const eq = paper.bookEquitySol(book);
    const identity = (pos.valueInSol - book.bands[0].entryValueSol) + eq.tokensMarkedSol + eq.hedgeSol - book.rentLockedSol - book.rentSpentSol - book.swapCostSol!;
    near(book.txFeesSol!, 2 * paper.PAPER_TX_FEE_SOL, 1e-12, "two paper transactions");
    near(eq.equitySol - (100 + 10_000 * 0.01), identity - book.txFeesSol!, 1e-9, "identity (two paper tx fees)");
  });
  await test("CLOSE with liquidate: the SPYx that came back is sold, the book returns to USDC; no close slippage, the swap fee instead", async () => {
    const positions = paper.markPool(book, s0, { now: T0 + 120e3, fees: null, solPriceUsd: SOL_USD });
    const close: Decision = { action: "CLOSE_POSITION", open: null, positionAddress: addr, reasoning: "r", confidence: 0.6, headline: "h", liquidate: true };
    const r = await execute(verdictOf(close), ctx(s0, positions, T0 + 120e3));
    assert.ok(r.ok, r.notes.join("; "));
    assert.deepEqual(r.txs.map((t) => t.label.split(" ")[0]), ["close", "swap"]);
    assert.match(r.txs[1].skipped!, /liquidate leg filled/);
    assert.equal(book.bands.length, 0);
    assert.equal(book.wallet.tokens[SPYX_MINT], undefined, "sold back to USDC");
    assert.equal(book.closed[0].slippageSol, 0, "the swap is the sale: no close slippage");
    assert.deepEqual(r.ledger!.map((row) => row.mech), ["close", "swap"]);
    assert.ok(r.ledger![1].tokenDelta < 0 && r.ledger![1].quoteDelta! > 0);
    assert.ok(book.wallet.usdc > 9990 && book.wallet.usdc < 10_000, `USDC back ${book.wallet.usdc} less two swap fees`);
    assert.ok(book.swapCostSol! > 0.01 && book.swapCostSol! < 0.03, `swap cost ${book.swapCostSol} SOL for ~2250 USDC of swaps at 0.1%`);
  });
  await test("REBALANCE of a straddle: price above the band -> the close returns USDC, the shortfall is bought; price below -> the surplus SPYx is sold; a plain close keeps the old slippage", async () => {
    const r0 = await execute(verdictOf(straddleOpen), ctx(s0, [], T0 + 600e3));
    assert.ok(r0.ok, r0.notes.join("; "));
    const old = r0.opened!.address;
    const up = snapAt(ACTIVE + 20);
    const upPos = paper.markPool(book, up, { now: T0 + 1200e3, fees: null, solPriceUsd: SOL_USD });
    const tokenHalfUp = Math.floor((1125 / up.activePrice) * 1e6) / 1e6;
    const reb: Decision = { action: "REBALANCE", open: { side: "BOTH", amountSol: 1125, amountToken: tokenHalfUp, acquireToken: tokenHalfUp, binsBelowActive: 15, binsAboveActive: 15, strategy: "Spot" }, positionAddress: old, reasoning: "r", confidence: 0.6, headline: "h" };
    const r = await execute(verdictOf(reb), ctx(up, upPos, T0 + 1200e3));
    assert.ok(r.ok, r.notes.join("; "));
    assert.deepEqual(r.txs.map((t) => t.label.split(" ")[0]), ["close", "swap", "open"]);
    assert.match(r.txs[1].skipped!, /shortfall leg/);
    assert.equal(book.bands.length, 1);
    assert.deepEqual([book.bands[0].lowerBinId, book.bands[0].upperBinId], [ACTIVE + 5, ACTIVE + 35]);
    assert.equal(book.wallet.tokens[SPYX_MINT] ?? 0, 0);
    // now the price falls through the new band: it is all SPYx; the re-centre sells the surplus
    const down = snapAt(ACTIVE - 10);
    const downPos = paper.markPool(book, down, { now: T0 + 1800e3, fees: null, solPriceUsd: SOL_USD });
    assert.ok(downPos[0].amountX > tokenHalfUp * 1.5, "more token than a new half needs");
    const tokenHalfDown = Math.floor((1125 / down.activePrice) * 1e6) / 1e6;
    const reb2: Decision = { action: "REBALANCE", open: { side: "BOTH", amountSol: 1125, amountToken: tokenHalfDown, acquireToken: 0, binsBelowActive: 15, binsAboveActive: 15, strategy: "Spot" }, positionAddress: book.bands[0].address, reasoning: "r", confidence: 0.6, headline: "h" };
    const r2 = await execute(verdictOf(reb2), ctx(down, downPos, T0 + 1800e3));
    assert.ok(r2.ok, r2.notes.join("; "));
    assert.deepEqual(r2.txs.map((t) => t.label.split(" ")[0]), ["close", "swap", "open"]);
    assert.match(r2.txs[1].skipped!, /surplus leg/);
    assert.ok(r2.ledger![1].tokenDelta < 0, "a sale");
    near(book.wallet.tokens[SPYX_MINT] ?? 0, 0, 1e-6, "the surplus went to USDC, the half into the band");
    assert.equal(book.closed[book.closed.length - 1].slippageSol, 0, "a re-laid straddle pays the swap fee, not the close slippage");
    // a plain close (no liquidate) of the new straddle keeps the token and the old slippage charge
    const pos3 = paper.markPool(book, down, { now: T0 + 2400e3, fees: null, solPriceUsd: SOL_USD });
    const plain: Decision = { action: "CLOSE_POSITION", open: null, positionAddress: book.bands[0].address, reasoning: "r", confidence: 0.6, headline: "h" };
    const r3 = await execute(verdictOf(plain), ctx(down, pos3, T0 + 2400e3));
    assert.ok(r3.ok, r3.notes.join("; "));
    assert.equal(r3.txs.length, 1);
    assert.ok((book.wallet.tokens[SPYX_MINT] ?? 0) > 0, "the token stays in the wallet");
    assert.ok(book.closed[book.closed.length - 1].slippageSol > 0);
  });

  console.log("the USD report view");
  await test("a tie (100 SOL at $100 beside 10,000 USDC) stays a SOL book; the journal's hedge plans are tallied", () => {
    const h = paper.emptyHedgeBook();
    paper.fillPaperHedge(h, { pool: SPYX_POOL, symbol: PERP, ticker: "SPY", side: "Ask", quantity: 1.5, price: 760, now: T0, feePct: 0.02 });
    paper.markPaperHedge(h, SPYX_POOL, 765, T0);
    book.hedge = h;
    book.solPriceUsd = SOL_USD;
    const pool = { address: SPYX_POOL, label: "SPYx/USDC", tokenX: { symbol: "SPYx", decimals: 8 }, tokenY: { symbol: "USDC", decimals: 6 }, solSide: null, binStep: 10, activeBinId: ACTIVE, price: P, priceLabel: "", tokenPriceInSol: P / SOL_USD, baseFeePct: 0.1, dynamicFeePct: 0.1, bins: [] };
    const base = { agent: { id: "mr-bands", name: "Mr Bands" }, mode: "dry-run" as const, pool, wallet: { address: "w", sol: 1, token: 0, tokenSymbol: "SPYx" }, positions: [], analytics: null, llm: { source: "policy" as const, model: "desk-policy" }, allowed: true, violations: [], overrides: [], passed: [], emergency: false, headline: "" };
    const entries: JournalEntry[] = [
      { ...base, id: "1", ts: new Date(T0 + 60e3).toISOString(), cycle: 1, proposal: straddleOpen, decision: straddleOpen, execution: { mode: "paper", ok: true, txs: [{ label: "x", ok: true }], notes: [], opened: { address: "paper-1", entryValueSol: 22.5 } }, hedge: { symbol: PERP, targetShortQty: 1.5, existingShortQty: 0, side: "Ask", quantity: 1.5, reason: "inventory 1.5 vs short 0: sell 1.5 more perp", placed: true } },
      { ...base, id: "2", ts: new Date(T0 + 120e3).toISOString(), cycle: 2, proposal: straddleOpen, decision: { action: "HOLD", open: null, positionAddress: null, reasoning: "", confidence: 1, headline: "" }, execution: { mode: "none", ok: true, txs: [], notes: ["hold"] }, hedge: { symbol: PERP, targetShortQty: 1.51, existingShortQty: 1.5, side: null, quantity: 0, reason: "delta +0.0100 (7.60 USD) is below the 25 USD rebalance floor", placed: false } },
    ];
    const sum = paper.paperSummary(book, entries, T0 + 7200e3);
    assert.equal(sum.usdFirst, false, "10,000 USDC is not worth MORE than 100 SOL at $100");
    assert.equal(sum.tally.hedgeFills, 1);
    assert.deepEqual(sum.tally.hedgeHolds, { "delta n (n USD) is below the n USD rebalance floor": 1 }, "numbers and their signs fold to n");
    near(sum.equity.hedgeSol, ((760 - 765) * 1.5 - h.feesPaidUsd) / SOL_USD, 1e-9);
    near(sum.txFeesSol, 13 * paper.PAPER_TX_FEE_SOL, 1e-9, "13 paper transactions so far");
    near(sum.equity.vsStartSol, sum.realizedSol + sum.markedSol + sum.equity.hedgeSol - sum.rentLockedSol - sum.rentSpentSol - sum.swapCostSol - sum.txFeesSol, 1e-9, "identity");
    assert.equal(sum.stocks[0].ticker, "SPY");
    assert.equal(sum.stocks[0].closedBands, 4, "the liquidating close, two re-centres and the plain close");
    assert.ok(sum.stocks[0].swapCostUsd > 0);
    book.hedge = paper.emptyHedgeBook();
  });
  await test("usdFirst is decided by the start: USDC worth more than the SOL -> USD first; the start is valued at today's SOL price", () => {
    // a self-consistent book: 0.02 SOL of swap fees (2.06 USDC at $103) left the USDC, nothing else moved
    const usdBook = paper.emptyBook(2, 10_000, T0);
    usdBook.solPriceUsd = 103;
    usdBook.wallet.usdc = 10_000 - 2.06;
    usdBook.swapCostSol = 0.02;
    usdBook.hedge = paper.emptyHedgeBook();
    paper.fillPaperHedge(usdBook.hedge, { pool: SPYX_POOL, symbol: PERP, ticker: "SPY", side: "Ask", quantity: 1, price: 760, now: T0, feePct: 0 });
    paper.markPaperHedge(usdBook.hedge, SPYX_POOL, 750, T0);
    const sum = paper.paperSummary(usdBook, [], T0 + 3600e3);
    assert.equal(sum.usdFirst, true);
    near(sum.start.equityUsd!, 2 * 103 + 10_000, 1e-9, "start at today's SOL price");
    near(sum.equity.hedgeSol, 10 / 103, 1e-9, "(760 - 750) x 1 = +$10");
    near(sum.equity.usd!, (2 + (10_000 - 2.06) / 103 + 10 / 103) * 103, 1e-9);
    near(sum.equity.vsStartSol, sum.realizedSol + sum.markedSol + sum.equity.hedgeSol - sum.rentLockedSol - sum.rentSpentSol - sum.swapCostSol - sum.txFeesSol, 1e-9, "identity with hedge and swap cost");
    near(sum.equity.vsStartUsd!, sum.equity.usd! - sum.start.equityUsd!, 1e-9);
    assert.equal(sum.hedge.positions.length, 1);
    assert.equal(sum.stocks.length, 1);
    assert.equal(sum.stocks[0].ticker, "SPY");
    near(sum.stocks[0].hedgePnlUsd, 10, 1e-9);
    const text = paper.renderPaperReport(sum);
    assert.match(text, /USD book \(SOL is rent money\)/);
    assert.match(text, /start        2\.0000 SOL \+ 10000\.00 USDC = \$10,206\.00 \(99\.0874 SOL\) at today's SOL price/);
    assert.match(text, /equity now   \$10,213\.94 \(99\.1645 SOL\) = wallet \$206\.00/);
    assert.match(text, /vs start     [-+]\$[\d,.]+ \([-+][\d.]+ SOL\)/);
    assert.match(text, /identity     [-+][\d.]{8} SOL = /);
    assert.match(text, /HEDGE \(virtual Backpack perp shorts\)  notional \$750\.00 \| unrealized \+\$10\.00/);
    assert.match(text, /PER STOCK \(USD\)/);
    assert.match(text, /SPY {4}-.*hedge \+\$10\.00 \(short 1\.0000 SPY\.US_USDC_PERP\)/);
    // the SOL book: SOL first, USD second
    const solBook = paper.emptyBook(100, 0, T0);
    solBook.solPriceUsd = 100;
    const solSum = paper.paperSummary(solBook, [], T0);
    assert.equal(solSum.usdFirst, false);
    assert.match(paper.renderPaperReport(solSum), /SOL book/);
    assert.match(paper.renderPaperReport(solSum), /start        100\.0000 SOL \+ 0\.00 USDC = 100\.0000 SOL \(\$10,000\.00\)/);
    // the tally counts hedge fills and holds by reason with the numbers folded
    const tally = paper.decisionTally(
      [
        { ts: new Date(T0 + 1).toISOString(), pool: { address: "p" }, allowed: true, decision: { action: "HOLD" }, execution: { txs: [] }, llm: { source: "policy" }, hedge: { symbol: PERP, targetShortQty: 1, existingShortQty: 0, side: "Ask", quantity: 1, reason: "x", placed: true } } as never,
        { ts: new Date(T0 + 2).toISOString(), pool: { address: "p" }, allowed: true, decision: { action: "HOLD" }, execution: { txs: [] }, llm: { source: "policy" }, hedge: { symbol: PERP, targetShortQty: 1, existingShortQty: 1, side: null, quantity: 0, reason: "delta +0.0100 (7.60 USD) is below the 25 USD rebalance floor", placed: false } } as never,
        { ts: new Date(T0 + 3).toISOString(), pool: { address: "p" }, allowed: true, decision: { action: "HOLD" }, execution: { txs: [] }, llm: { source: "policy" }, hedge: { symbol: PERP, targetShortQty: 1, existingShortQty: 1, side: null, quantity: 0, reason: "delta -0.0200 (15.20 USD) is below the 25 USD rebalance floor", placed: false } } as never,
      ],
      new Date(T0).toISOString(),
    );
    assert.equal(tally.hedgeFills, 1);
    assert.deepEqual(tally.hedgeHolds, { "delta n (n USD) is below the n USD rebalance floor": 2 }, "one bucket for the floor hold, whichever way the delta points");
  });

  console.log("the hedge desk with a fake Backpack client");
  const market = { symbol: PERP, baseSymbol: "SPY.US", quoteSymbol: "USDC", marketType: "PERP", rwaMarketType: "INDEX" as const, orderBookState: "Open", fundingInterval: 3600000, visible: true, filters: { tickSize: 0.01, minQuantity: 0.01, maxQuantity: null, stepSize: 0.01 } };
  const orders: unknown[] = [];
  const fakeClient = (over: Partial<HedgeClient> = {}): HedgeClient => ({
    market: async (symbol: string) => (symbol === PERP ? market : null),
    positions: async () => [],
    canTrade: () => ({ ok: false, reason: "HEDGE_LIVE is not true" }),
    placeOrder: async (req: Parameters<HedgeClient["placeOrder"]>[0]) => {
      orders.push(req);
      return { id: "42", clientId: null, symbol: req.symbol, side: req.side, orderType: req.orderType, quantity: Number(req.quantity), price: Number(req.price), status: "New", executedQuantity: 0, reduceOnly: !!req.reduceOnly, postOnly: !!req.postOnly, raw: {} };
    },
    ...over,
  });
  await test("paper: the plan fills at the perp mid (quantity rounded down to the step), holds below the floor, buys back reduce-only to flat; funding accrues; the journal carries it all", async () => {
    const pb = paper.emptyBook(2, 10_000, T0);
    const first = await desk.runHedgeDesk({ pool: SPYX_POOL, label: "SPYx/USDC", ticker: "SPY", symbol: PERP, baseInventory: 1.466, basePrice: 760, fundingRatePerHour: 0.00001, now: T0, paper: pb, client: fakeClient() });
    assert.deepEqual([first.journal.side, first.journal.quantity, first.journal.placed, first.journal.mode, first.journal.fillPrice], ["Ask", 1.46, true, "paper", 760]);
    near(first.journal.targetShortQty, 1.466, 1e-9);
    assert.equal(first.journal.existingShortQty, 0);
    assert.equal(paper.paperShortQty(pb.hedge!, SPYX_POOL), 1.46);
    assert.match(first.lines[0], /paper SOLD 1\.46 SPY\.US_USDC_PERP at 760/);
    const again = await desk.runHedgeDesk({ pool: SPYX_POOL, label: "SPYx/USDC", ticker: "SPY", symbol: PERP, baseInventory: 1.47, basePrice: 762, fundingRatePerHour: 0.00001, now: T0 + 1800e3, paper: pb, client: fakeClient() });
    assert.equal(again.journal.side, null);
    assert.match(again.journal.reason, /below the 25 USD rebalance floor/);
    assert.equal(again.journal.placed, false);
    near(again.journal.fundingUsd!, -(1.46 * 762 * 0.00001 * 0.5), 1e-9, "funding received over 30 min");
    near(paper.paperHedgeEquityUsd(pb.hedge).unrealizedUsd, (760 - 762) * 1.46, 1e-9, "marked at the new mid");
    const flat = await desk.runHedgeDesk({ pool: SPYX_POOL, label: "SPYx/USDC", ticker: "SPY", symbol: PERP, baseInventory: 0, basePrice: 755, fundingRatePerHour: null, now: T0 + 3600e3, paper: pb, client: fakeClient() });
    assert.deepEqual([flat.journal.side, flat.journal.quantity, flat.journal.placed], ["Bid", 1.46, true]);
    assert.equal(pb.hedge!.positions.length, 0);
    near(pb.hedge!.realizedUsd, (760 - 755) * 1.46, 1e-9);
    // HEDGE_MAX_NOTIONAL_USD caps a paper hedge too; 0 means uncapped in paper
    const capped = await desk.runHedgeDesk({ pool: "p2", label: "x", ticker: "SPY", symbol: PERP, baseInventory: 10, basePrice: 760, fundingRatePerHour: null, now: T0, paper: pb, client: fakeClient(), settings: { live: false, minRebalanceUsd: 25, maxNotionalUsd: 1000 } });
    assert.equal(capped.journal.quantity, 1.31, "1000 / 760 rounded down to the step");
    assert.deepEqual(desk.paperHedgeSettings({ live: false, minRebalanceUsd: 25, maxNotionalUsd: 0 }).maxNotionalUsd, Number.POSITIVE_INFINITY);
    // no perp listed: a note, nothing filled
    const none = await desk.runHedgeDesk({ pool: "p3", label: "NKE/USDC", ticker: "NKE", symbol: null, baseInventory: 3, basePrice: 37, fundingRatePerHour: null, now: T0, paper: pb, client: fakeClient() });
    assert.equal(none.journal.symbol, null);
    assert.equal(none.journal.placed, false);
    assert.match(none.journal.reason, /no Backpack perp listed for NKE/);
    assert.equal(none.plan, null);
  });
  await test("live: dormant by default (plan journaled with the gate's reason; HEDGE_MAX_NOTIONAL_USD=0 holds); with keys + HEDGE_LIVE + DRY_RUN=false a post-only limit at the mid rounded to the tick, reduceOnly when shrinking", async () => {
    const off = await desk.runHedgeDesk({ pool: SPYX_POOL, label: "SPYx/USDC", ticker: "SPY", symbol: PERP, baseInventory: 1.466, basePrice: 760.123, fundingRatePerHour: null, now: T0, client: fakeClient() });
    assert.equal(off.journal.side, null);
    assert.match(off.journal.reason, /hedging off \(HEDGE_MAX_NOTIONAL_USD=0\)/);
    assert.equal(off.journal.mode, "plan");
    const settings = { live: true, minRebalanceUsd: 25, maxNotionalUsd: 5000 };
    const gated = await desk.runHedgeDesk({ pool: SPYX_POOL, label: "SPYx/USDC", ticker: "SPY", symbol: PERP, baseInventory: 1.466, basePrice: 760.123, fundingRatePerHour: null, now: T0, client: fakeClient(), settings });
    assert.deepEqual([gated.journal.side, gated.journal.quantity, gated.journal.placed], ["Ask", 1.46, false]);
    assert.equal(gated.journal.note, "not placed: HEDGE_LIVE is not true");
    assert.equal(orders.length, 0);
    const live = fakeClient({ canTrade: () => ({ ok: true, reason: "keys set, HEDGE_LIVE=true, DRY_RUN=false" }), positions: async () => [{ symbol: PERP, netQuantity: -0.5, entryPrice: 760, markPrice: 760, pnlUnrealized: 0, pnlRealized: 0, cumulativeFundingPayment: 0, raw: {} }] });
    const placed = await desk.runHedgeDesk({ pool: SPYX_POOL, label: "SPYx/USDC", ticker: "SPY", symbol: PERP, baseInventory: 1.466, basePrice: 760.123, fundingRatePerHour: null, now: T0, client: live, settings });
    assert.deepEqual([placed.journal.side, placed.journal.quantity, placed.journal.existingShortQty, placed.journal.placed, placed.journal.mode, placed.journal.orderId, placed.journal.fillPrice], ["Ask", 0.96, 0.5, true, "live", "42", 760.12]);
    assert.equal(orders.length, 1);
    assert.deepEqual(orders[0], { symbol: PERP, side: "Ask", orderType: "Limit", quantity: 0.96, price: 760.12, postOnly: true, reduceOnly: false, timeInForce: "GTC" });
    // shrinking: reduceOnly; another pool's target on the same symbol is netted out of the existing short
    const shrink = await desk.runHedgeDesk({ pool: SPYX_POOL, label: "SPYx/USDC", ticker: "SPY", symbol: PERP, baseInventory: 0.1, basePrice: 760, fundingRatePerHour: null, now: T0, client: live, settings });
    assert.deepEqual([shrink.journal.side, shrink.journal.quantity], ["Bid", 0.4]);
    assert.equal((orders[1] as { reduceOnly: boolean }).reduceOnly, true);
    const shared = await desk.runHedgeDesk({ pool: "p2", label: "x", ticker: "SPY", symbol: PERP, baseInventory: 1, basePrice: 760, fundingRatePerHour: null, now: T0, client: live, settings, otherPoolsShort: 0.5 });
    assert.equal(shared.journal.existingShortQty, 0, "the 0.5 short belongs to the other pool");
    assert.equal(shared.journal.quantity, 1);
    // Backpack failing to answer positions is a note, not a failed cycle; an order error too
    const noPos = await desk.runHedgeDesk({ pool: SPYX_POOL, label: "x", ticker: "SPY", symbol: PERP, baseInventory: 1, basePrice: 760, fundingRatePerHour: null, now: T0, client: fakeClient({ positions: async () => { throw new Error("positionQuery: BACKPACK_API_KEY / BACKPACK_API_SECRET not set"); } }), settings });
    assert.match(noPos.journal.note!, /Backpack positions unavailable/);
    const failed = await desk.runHedgeDesk({ pool: SPYX_POOL, label: "x", ticker: "SPY", symbol: PERP, baseInventory: 1, basePrice: 760, fundingRatePerHour: null, now: T0, client: live && fakeClient({ canTrade: () => ({ ok: true, reason: "" }), placeOrder: async () => { throw new Error("HTTP 400: insufficient margin"); } }), settings });
    assert.equal(failed.journal.placed, false);
    assert.match(failed.journal.note!, /order failed: HTTP 400/);
    assert.equal(desk.roundToTick(760.123, 0.01), 760.12);
    assert.equal(desk.roundToTick(760.126, 0.01), 760.13);
    assert.equal(desk.roundToTick(760.126, null), 760.126);
    assert.equal(hedge.roundToStep(1.466, 0.01), 1.46);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} stock tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
