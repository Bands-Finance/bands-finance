/**
 * Venue-layer tests. Pure: no RPC, no LLM, no writes outside a temp dir.
 *   npm run test:venues
 * Covers: the bin/tick mapping both ways, binPrice under both models (a CLMM band at tick 20,000
 * prices within 1e-9 of 1.0001^tick and of the SDK's own tick math), the CLMM band geometry, the
 * snapshot's bin amounts from a tick fixture, position mapping from a fixture, single-sided deposit
 * selection, open-cost estimates (pinned to the SDK's layout spans), detectVenue from owner program
 * ids with a fake connection, the tradable/live/book env parsing, the stock book, the policy on a
 * CLMM pool (stock book, session width, resting), the paper executor on a CLMM snapshot, and the
 * executor's refusal to broadcast on a non-live venue with DRY_RUN=false.
 */
// The venue tests check geometry and wiring, not economics: their fixture pools are thin enough that
// the policy's seat-yield floor would refuse them. The floor and the payback test have their own tests
// in src/scripts/test-paper.ts.
process.env.POLICY_MIN_SEAT_YIELD_PCT = "0";
process.env.POLICY_MAX_PAYBACK_HOURS = "0";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import type { Observation } from "../agent/observation";
import type { Decision } from "../agent/schema";
import type { RiskLimits } from "../risk/limits";
import type { Verdict } from "../risk/guards";
import type { PoolSnapshot } from "../tools/dlmm";

// Everything that reads src/config.ts is imported after the environment is pinned: a live process
// (DRY_RUN=false) with a throwaway key, so the executor's refusal to broadcast can be exercised.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mr-bands-venues-"));
process.env.DATA_DIR = tmp;
process.env.ANTHROPIC_API_KEY = "";
delete process.env.ANTHROPIC_AUTH_TOKEN;
process.env.DRY_RUN = "false";
process.env.WALLET_SECRET_KEY = JSON.stringify([...Keypair.generate().secretKey]);
process.env.EXPECTED_WALLET = "";
process.env.PAPER_SOL = "";
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
delete process.env.TRADABLE_VENUES;
delete process.env.LIVE_VENUES;
delete process.env.BOOK;

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
const T0 = Date.parse("2026-09-14T17:30:00.000Z"); // Monday 13:30 ET: the regular US session

async function main(): Promise<void> {
  const bins = await import("../tools/bins.js");
  const dlmm = await import("../tools/dlmm.js");
  const venues = await import("../venues/index.js");
  const raydium = await import("../venues/raydium.js");
  const sdk = await import("@raydium-io/raydium-sdk-v2");
  const { execute, broadcastRefusal, toOpenPlan } = await import("../executor.js");
  const policy = await import("../agent/policy.js");
  const paper = await import("../paper/index.js");
  const { binPrice, tickToBin, binToTicks, ticksToBins, tickArrayStart, clmmBandTicks } = bins;

  /** SPYx/USDC as the Raydium adapter reads it: X = SPYx (8 dec), Y = USDC (6 dec), spacing 10, tick 20383. */
  const SPACING = 10;
  const TICK = 20383;
  const ACTIVE = tickToBin(TICK, SPACING); // 2038
  const SQRT = sdk.TickUtil.getSqrtPriceAtTick(TICK);
  const L = new BN("22888489973583");
  const clmmPrice = (bin: number) => binPrice({ binStep: SPACING, priceModel: "clmm", tokenX: { decimals: 8 }, tokenY: { decimals: 6 } }, bin);
  function spySnapshot(over: Partial<PoolSnapshot> = {}): PoolSnapshot {
    const tokenX = { mint: SPYX_MINT, symbol: "SPYx", decimals: 8, reserve: 1099.19 };
    const tokenY = { mint: USDC_MINT, symbol: "USDC", decimals: 6, reserve: 1_579_043.63 };
    const activePrice = sdk.TickUtil.sqrtPriceX64ToPrice(SQRT, 8, 6).toNumber();
    const rows = raydium.clmmBins({ tickSpacing: SPACING, tickCurrent: TICK, sqrtPriceX64: SQRT, liquidity: L, ticks: new Map() }, clmmPrice, 8, 6, 10);
    const solPriceUsd = 100;
    return {
      address: SPYX_POOL,
      label: "SPYx/USDC",
      tokenX,
      tokenY,
      solSide: null,
      baseToken: tokenX,
      binStep: SPACING,
      activeBinId: ACTIVE,
      activePrice,
      priceLabel: "USDC per SPYx",
      tokenPriceInSol: activePrice / solPriceUsd,
      quoteSide: "Y",
      quoteToken: tokenY,
      quoteSymbol: "USDC",
      quotePriceInSol: 1 / solPriceUsd,
      tokenPriceInQuote: activePrice,
      solPriceUsd,
      baseFeePct: 0.1,
      maxFeePct: 0.1,
      dynamicFeePct: 0.1,
      hasDynamicFee: false,
      bins: rows,
      liquidityBelowY: rows.filter((b) => b.binId < ACTIVE).reduce((t, b) => t + b.yAmount, 0),
      liquidityAboveX: rows.filter((b) => b.binId > ACTIVE).reduce((t, b) => t + b.xAmount, 0),
      fetchedAt: new Date(T0).toISOString(),
      priceModel: "clmm",
      venue: "raydium-clmm",
      clmm: { tickSpacing: SPACING, tickCurrent: TICK, sqrtPriceX64: SQRT.toString(), liquidity: L.toString(), initializedTickArrays: [19200, 19800, 20400, 21000] },
      ...over,
    };
  }

  console.log("bin and tick geometry");
  await test("tickToBin / binToTicks / ticksToBins round-trip, negatives included", () => {
    assert.equal(tickToBin(20383, 10), 2038);
    assert.equal(tickToBin(20380, 10), 2038);
    assert.equal(tickToBin(20379, 10), 2037);
    assert.equal(tickToBin(-15, 10), -2);
    assert.deepEqual(binToTicks(2038, 10), { tickLower: 20380, tickUpper: 20390 });
    assert.deepEqual(ticksToBins(20180, 20380, 10), { lowerBinId: 2018, upperBinId: 2037 });
    assert.deepEqual(ticksToBins(-600, 0, 60), { lowerBinId: -10, upperBinId: -1 });
    for (const tick of [0, 1, 59, 60, -1, -61, 443630]) assert.equal(binToTicks(tickToBin(tick, 60), 60).tickLower <= tick && tick < binToTicks(tickToBin(tick, 60), 60).tickUpper, true, `tick ${tick}`);
    assert.throws(() => ticksToBins(20185, 20380, 10), /multiples of the spacing/);
    assert.throws(() => ticksToBins(20380, 20380, 10), /empty/);
    assert.throws(() => tickToBin(5, 0), /bad tick spacing/);
  });
  await test("tickArrayStart matches the SDK's tick-array start index (60 ticks x spacing per array)", () => {
    for (const [tick, spacing] of [[36010, 10], [20383, 10], [-1, 10], [-601, 10], [599, 1], [123456, 60], [-123456, 60]] as [number, number][]) {
      assert.equal(tickArrayStart(tick, spacing), sdk.TickArrayUtil.getTickArrayStartIndex(tick, spacing), `tick ${tick} spacing ${spacing}`);
    }
    assert.equal(tickArrayStart(20383, 10), 19800);
    assert.equal(raydium.SDK_SPANS.ticksPerArray, bins.TICK_ARRAY_SIZE);
  });
  await test("reward rows: the SDK's divn asserts past 2^26, so a 9-decimal reward mint (SOL) threw on every read; ours divides with BN and matches the SDK where the SDK works", () => {
    const x64 = new BN(1).shln(64);
    const perSecond = x64.muln(3); // three token-units per second, X64-scaled, before the decimals divide
    // 6 decimals: same answer as the SDK's divn
    assert.equal(raydium.safePerSecond(perSecond.muln(1_000_000), 6), Number(perSecond.muln(1_000_000).divn(10 ** 6).toString()));
    // 9 decimals: the SDK's route throws, ours answers
    assert.throws(() => perSecond.divn(10 ** 9), /Assertion failed/);
    assert.equal(raydium.safePerSecond(perSecond.mul(new BN(10).pow(new BN(9))), 9), Number(perSecond.toString()));
    assert.equal(raydium.safePerSecond(new BN(0), 9), 0);
  });
  await test("binPrice: Meteora bins price as before; CLMM bins price as 1.0001^(bin x spacing) within 1e-9 of the tick formula and of the SDK", () => {
    const meteora = { binStep: 20, tokenX: { decimals: 6 }, tokenY: { decimals: 9 } };
    for (const bin of [-100, 0, 260, 1000]) near(binPrice(meteora, bin), dlmm.binPriceUi(bin, 20, 6, 9), 1e-15, `meteora bin ${bin}`);
    near(binPrice({ ...meteora, priceModel: "meteora-dlmm" }, 260), dlmm.binPriceUi(260, 20, 6, 9), 1e-15);
    // a CLMM band at tick 20,000: bin 2000 at spacing 10, bin 1000 at spacing 20
    const expect = Math.pow(1.0001, 20000) * Math.pow(10, 8 - 6);
    near(binPrice({ binStep: 10, priceModel: "clmm", tokenX: { decimals: 8 }, tokenY: { decimals: 6 } }, 2000), expect, 1e-9, "clmm tick 20000 (spacing 10)");
    near(binPrice({ binStep: 20, priceModel: "clmm", tokenX: { decimals: 8 }, tokenY: { decimals: 6 } }, 1000), expect, 1e-9, "clmm tick 20000 (spacing 20)");
    near(binPrice({ binStep: 10, priceModel: "clmm", tokenX: { decimals: 8 }, tokenY: { decimals: 6 } }, 2000), sdk.TickUtil.tickToPrice(20000, 8, 6).toNumber(), 1e-9, "vs SDK tickToPrice");
    near(clmmPrice(ACTIVE), sdk.TickUtil.tickToPrice(TICK - 3, 8, 6).toNumber(), 1e-9, "active bin's lower tick price");
    // the drift the Meteora formula would introduce at tick 20,000: ~0.6% at a 60 bps spacing, ~0.09% at 10 bps
    const drift = (spacing: number) => Math.abs(Math.pow(1 + spacing / 1e4, 20000 / spacing) / Math.pow(1.0001, 20000) - 1);
    assert.ok(drift(60) > 0.005 && drift(60) < 0.007, `drift at 60 bps ${drift(60)}`);
    assert.ok(drift(10) > 0.0008 && drift(10) < 0.001, `drift at 10 bps ${drift(10)}`);
    assert.equal(bins.priceModelOf({}), "meteora-dlmm");
    assert.equal(bins.priceModelOf({ priceModel: "clmm" }), "clmm");
    assert.equal(bins.priceModelOf(null), "meteora-dlmm");
  });
  await test("clmmBandTicks: single-sided bands exclude the active bin, two-sided ones include it, ticks follow the bins", () => {
    const a = ACTIVE;
    const under = clmmBandTicks(a, 10, 20, 0, "SOL_ONLY", "Y");
    assert.deepEqual([under.lowerBinId, under.upperBinId, under.tickLower, under.tickUpper, under.singleSided], [a - 20, a - 1, (a - 20) * 10, a * 10, "Y"]);
    assert.match(under.note!, /active bin is excluded/);
    const over = clmmBandTicks(a, 10, 0, 10, "TOKEN_ONLY", "Y");
    assert.deepEqual([over.lowerBinId, over.upperBinId, over.tickLower, over.tickUpper, over.singleSided], [a + 1, a + 10, (a + 1) * 10, (a + 11) * 10, "X"]);
    const both = clmmBandTicks(a, 10, 5, 5, "BOTH", "Y");
    assert.deepEqual([both.lowerBinId, both.upperBinId, both.tickLower, both.tickUpper, both.singleSided, both.note], [a - 5, a + 5, (a - 5) * 10, (a + 6) * 10, null, null]);
    // quote is X (a SOL/USDC pool where SOL is token A): the quote-only band sits over the price
    const quoteX = clmmBandTicks(a, 1, 0, 30, "SOL_ONLY", "X");
    assert.deepEqual([quoteX.lowerBinId, quoteX.upperBinId, quoteX.singleSided], [a + 1, a + 30, "X"]);
    const tokenX = clmmBandTicks(a, 1, 30, 0, "TOKEN_ONLY", "X");
    assert.deepEqual([tokenX.lowerBinId, tokenX.upperBinId, tokenX.singleSided], [a - 30, a - 1, "Y"]);
    assert.throws(() => clmmBandTicks(a, 10, 0, 0, "SOL_ONLY", "Y"), /at least one bin under/);
    // every geometry round-trips through ticksToBins
    for (const g of [under, over, both, quoteX, tokenX]) assert.deepEqual(ticksToBins(g.tickLower, g.tickUpper, g === quoteX || g === tokenX ? 1 : 10), { lowerBinId: g.lowerBinId, upperBinId: g.upperBinId });
  });

  console.log("the CLMM snapshot: bins from ticks");
  await test("clmmBins: bins above hold X, below hold Y, the active bin is split at the sqrt price; amounts match the SDK's liquidity math", () => {
    const rows = raydium.clmmBins({ tickSpacing: SPACING, tickCurrent: TICK, sqrtPriceX64: SQRT, liquidity: L, ticks: new Map() }, clmmPrice, 8, 6, 3);
    assert.equal(rows.length, 7);
    assert.deepEqual(rows.map((r) => r.binId), [ACTIVE - 3, ACTIVE - 2, ACTIVE - 1, ACTIVE, ACTIVE + 1, ACTIVE + 2, ACTIVE + 3]);
    const at = (bin: number) => rows.find((r) => r.binId === bin)!;
    for (const b of [ACTIVE + 1, ACTIVE + 2, ACTIVE + 3]) {
      assert.equal(at(b).yAmount, 0);
      const expect = sdk.LiquidityMathUtil.getDeltaAmountAUnsigned(sdk.TickUtil.getSqrtPriceAtTick(b * 10), sdk.TickUtil.getSqrtPriceAtTick((b + 1) * 10), L, false);
      near(at(b).xAmount, Number(expect.toString()) / 1e8, 1e-12, `x at ${b}`);
    }
    for (const b of [ACTIVE - 1, ACTIVE - 2, ACTIVE - 3]) {
      assert.equal(at(b).xAmount, 0);
      const expect = sdk.LiquidityMathUtil.getDeltaAmountBUnsigned(sdk.TickUtil.getSqrtPriceAtTick(b * 10), sdk.TickUtil.getSqrtPriceAtTick((b + 1) * 10), L, false);
      near(at(b).yAmount, Number(expect.toString()) / 1e6, 1e-12, `y at ${b}`);
    }
    const active = at(ACTIVE);
    assert.ok(active.isActive && active.xAmount > 0 && active.yAmount > 0);
    near(active.price, clmmPrice(ACTIVE), 1e-15);
    // at ~767 USDC per SPYx each 0.1% bin of 22.9M liquidity units holds a few thousand USDC of depth
    assert.ok(at(ACTIVE - 1).yAmount > 1000 && at(ACTIVE - 1).yAmount < 100_000, `y ${at(ACTIVE - 1).yAmount}`);
    near(at(ACTIVE + 1).xAmount * clmmPrice(ACTIVE + 1), at(ACTIVE - 1).yAmount, 0.01, "one bin up and one bin down carry about the same value");
  });
  await test("clmmBins: liquidityNet at an initialised tick changes the liquidity past it (and never below zero)", () => {
    const ticks = new Map<number, { liquidityNet: BN }>([
      [(ACTIVE + 2) * 10, { liquidityNet: L.neg() }], // all liquidity ends two bins up
      [(ACTIVE - 1) * 10, { liquidityNet: L.divn(2) }], // half of it started one bin down
    ]);
    const rows = raydium.clmmBins({ tickSpacing: SPACING, tickCurrent: TICK, sqrtPriceX64: SQRT, liquidity: L, ticks }, clmmPrice, 8, 6, 3);
    const at = (bin: number) => rows.find((r) => r.binId === bin)!;
    assert.ok(at(ACTIVE + 1).xAmount > 0);
    assert.equal(at(ACTIVE + 2).xAmount, 0, "liquidity gone past the tick");
    assert.equal(at(ACTIVE + 3).xAmount, 0);
    const full = sdk.LiquidityMathUtil.getDeltaAmountBUnsigned(sdk.TickUtil.getSqrtPriceAtTick((ACTIVE - 2) * 10), sdk.TickUtil.getSqrtPriceAtTick((ACTIVE - 1) * 10), L.sub(L.divn(2)), false);
    near(at(ACTIVE - 2).yAmount, Number(full.toString()) / 1e6, 1e-12, "half the liquidity below the initialised tick");
    near(at(ACTIVE - 1).yAmount, Number(sdk.LiquidityMathUtil.getDeltaAmountBUnsigned(sdk.TickUtil.getSqrtPriceAtTick((ACTIVE - 1) * 10), sdk.TickUtil.getSqrtPriceAtTick(ACTIVE * 10), L, false).toString()) / 1e6, 1e-12);
    const drained = raydium.clmmBins({ tickSpacing: SPACING, tickCurrent: TICK, sqrtPriceX64: SQRT, liquidity: L, ticks: new Map([[(ACTIVE - 1) * 10, { liquidityNet: L.muln(3) }]]) }, clmmPrice, 8, 6, 2);
    assert.equal(drained.find((r) => r.binId === ACTIVE - 2)!.yAmount, 0, "never negative");
  });

  console.log("positions from a fixture");
  await test("toClmmPositionSnapshot: bins from ticks, amounts from liquidity, fees from the owed counters, in-range and distance", () => {
    const s = spySnapshot();
    const pos = { nftMint: new PublicKey("11111111111111111111111111111112"), tickLower: 18640, tickUpper: 20650, liquidity: new BN("2360109515"), feeGrowthInsideLastX64A: new BN(0), feeGrowthInsideLastX64B: new BN(0), tokenFeesOwedA: new BN(150_000), tokenFeesOwedB: new BN(2_500_000) };
    const pool = { tickCurrent: TICK, sqrtPriceX64: SQRT, feeGrowthGlobalX64A: new BN(0), feeGrowthGlobalX64B: new BN(0) };
    const p = raydium.toClmmPositionSnapshot(pos, pool, s, null, 1_757_869_200);
    assert.equal(p.address, pos.nftMint.toBase58());
    assert.deepEqual([p.lowerBinId, p.upperBinId, p.widthBins], [1864, 2064, 201]);
    assert.equal(p.inRange, true);
    assert.equal(p.binsFromRange, 0);
    const amounts = sdk.LiquidityMathUtil.getAmountsForLiquidity(SQRT, sdk.TickUtil.getSqrtPriceAtTick(18640), sdk.TickUtil.getSqrtPriceAtTick(20650), pos.liquidity, false);
    near(p.amountX, Number(amounts.amountA.toString()) / 1e8, 1e-12);
    near(p.amountY, Number(amounts.amountB.toString()) / 1e6, 1e-12);
    assert.ok(p.amountX > 0 && p.amountY > 0, "in range: both tokens");
    near(p.feeX, 0.0015, 1e-12);
    near(p.feeY, 2.5, 1e-12);
    near(p.lowerPrice, clmmPrice(1864), 1e-15);
    near(p.upperPrice, clmmPrice(2064), 1e-15);
    near(p.quoteInPosition!, p.amountY + p.feeY, 1e-12);
    near(p.solInPosition, (p.amountY + p.feeY) * 0.01, 1e-12);
    near(p.valueInSol, (p.amountY + p.feeY + (p.amountX + p.feeX) * s.activePrice) * 0.01, 1e-12);
    assert.equal(p.lastUpdatedAt, 1_757_869_200);
    // a band entirely under the price holds only Y and reads as "above the band"
    const below = raydium.toClmmPositionSnapshot({ ...pos, tickLower: 18000, tickUpper: 20000 }, pool, s, null);
    assert.deepEqual([below.lowerBinId, below.upperBinId, below.inRange, below.binsFromRange], [1800, 1999, false, ACTIVE - 1999]);
    assert.equal(below.amountX, 0);
    assert.ok(below.amountY > 0);
    const above = raydium.toClmmPositionSnapshot({ ...pos, tickLower: 20400, tickUpper: 20600 }, pool, s, null);
    assert.deepEqual([above.inRange, above.binsFromRange, above.amountY], [false, ACTIVE - 2040, 0]);
  });
  await test("toClmmPositionSnapshot: with tick states the fee growth since the last update is added (2^64 of growth per unit of liquidity = one raw token)", () => {
    const s = spySnapshot();
    const tick = (t: number) => ({ tick: t, liquidityNet: new BN(0), liquidityGross: new BN(1), feeGrowthOutsideX64A: new BN(0), feeGrowthOutsideX64B: new BN(0), rewardGrowthsOutsideX64: [new BN(0), new BN(0), new BN(0)], orderPhase: new BN(0), ordersAmount: new BN(0), partFilledOrdersRemaining: new BN(0), unfilledRatioX64: new BN(0) });
    const pos = { nftMint: PublicKey.default, tickLower: 20000, tickUpper: 21000, liquidity: new BN(1_000_000), feeGrowthInsideLastX64A: new BN(0), feeGrowthInsideLastX64B: new BN(0), tokenFeesOwedA: new BN(0), tokenFeesOwedB: new BN(7) };
    const q64 = new BN(1).shln(64);
    const pool = { tickCurrent: TICK, sqrtPriceX64: SQRT, feeGrowthGlobalX64A: q64, feeGrowthGlobalX64B: q64.muln(3) };
    const p = raydium.toClmmPositionSnapshot(pos, pool, s, { lower: tick(20000), upper: tick(21000) });
    near(p.feeX, 1_000_000 / 1e8, 1e-12, "1 raw A per unit of liquidity");
    near(p.feeY, (3 * 1_000_000 + 7) / 1e6, 1e-12, "3 raw B per unit plus the owed 7");
  });

  console.log("deposits and open costs");
  await test("depositFor: a band under the price deposits Y only, over it X only, across it both with slippage caps; zero amounts refuse", () => {
    const plan = { amountX: new BN(50_000_000), amountY: new BN(100_000_000), slippagePct: 1 };
    const y = raydium.depositFor({ singleSided: "Y" }, plan);
    assert.deepEqual(y.mode === "base" ? [y.base, y.baseAmount.toString(), y.otherAmountMax.toString()] : null, ["MintB", "100000000", "0"]);
    const x = raydium.depositFor({ singleSided: "X" }, plan);
    assert.deepEqual(x.mode === "base" ? [x.base, x.baseAmount.toString(), x.otherAmountMax.toString()] : null, ["MintA", "50000000", "0"]);
    const both = raydium.depositFor({ singleSided: null }, plan);
    assert.deepEqual(both.mode === "liquidity" ? [both.amountMaxA.toString(), both.amountMaxB.toString()] : null, ["50500000", "101000000"]);
    assert.throws(() => raydium.depositFor({ singleSided: "Y" }, { ...plan, amountY: new BN(0) }), /amountY is zero/);
    assert.throws(() => raydium.depositFor({ singleSided: "X" }, { ...plan, amountX: new BN(0) }), /amountX is zero/);
    assert.throws(() => raydium.depositFor({ singleSided: null }, { ...plan, amountX: new BN(0) }), /both tokens/);
    // toOpenPlan carries the side and maps the quote deposit onto the quote side
    const s = spySnapshot();
    const p = toOpenPlan({ side: "SOL_ONLY", amountSol: 100, amountToken: 0, binsBelowActive: 20, binsAboveActive: 0, strategy: "Spot" }, s);
    assert.deepEqual([p.side, p.amountY.toString(), p.amountX.toString(), p.minBinId, p.maxBinId], ["SOL_ONLY", "100000000", "0", ACTIVE - 20, ACTIVE]);
    const g = clmmBandTicks(s.activeBinId, SPACING, s.activeBinId - p.minBinId, p.maxBinId - s.activeBinId, p.side!, "Y");
    assert.deepEqual([g.tickLower, g.tickUpper], [(ACTIVE - 20) * 10, ACTIVE * 10]);
    assert.equal(raydium.depositFor(g, p).mode, "base");
  });
  await test("open cost: rent from the SDK's account sizes at the measured lamports/byte; tick arrays only when the band lands off the initialised ones; Meteora unchanged", () => {
    assert.equal(raydium.SDK_SPANS.personalPosition, raydium.CLMM_PERSONAL_POSITION_BYTES);
    assert.equal(raydium.SDK_SPANS.protocolPosition, raydium.CLMM_PROTOCOL_POSITION_BYTES);
    assert.equal(raydium.SDK_SPANS.tickArray, raydium.CLMM_TICK_ARRAY_BYTES);
    near(raydium.rentSol(281), 2_077_720 / 1e9, 1e-12, "a fresh position account on chain holds 2,077,720 lamports");
    near(raydium.rentSol(10240), 52_669_440 / 1e9, 1e-12, "getMinimumBalanceForRentExemption(10240)");
    near(raydium.CLMM_TICK_ARRAY_RENT_SOL, 0.05266944, 1e-9);
    near(raydium.CLMM_POSITION_RENT_SOL, raydium.rentSol(281) + raydium.rentSol(479) + raydium.rentSol(170), 1e-12);
    assert.ok(raydium.CLMM_POSITION_RENT_SOL > 0.006 && raydium.CLMM_POSITION_RENT_SOL < 0.007, `${raydium.CLMM_POSITION_RENT_SOL}`);
    const s = spySnapshot();
    const none = raydium.clmmOpenCost(s);
    near(none.total, raydium.CLMM_OPEN_COST_DEFAULT_SOL, 1e-12);
    near(none.refundable, raydium.CLMM_POSITION_RENT_SOL, 1e-12);
    assert.ok(none.total < 0.01, "an open on initialised ticks costs under 0.01 SOL");
    // 20 bins under the price: ticks [20180, 20380) -> arrays 19800 and 19800: initialised
    const near20 = raydium.clmmOpenCost(s, { minBinId: ACTIVE - 20, maxBinId: ACTIVE, side: "SOL_ONLY" });
    near(near20.total, raydium.CLMM_OPEN_COST_DEFAULT_SOL, 1e-12);
    assert.match(near20.note!, /initialised/);
    // 200 bins under: ticks [18380, 20380) -> arrays 18000 (fresh) and 19800
    const far = raydium.clmmOpenCost(s, { minBinId: ACTIVE - 200, maxBinId: ACTIVE, side: "SOL_ONLY" });
    near(far.total, raydium.CLMM_OPEN_COST_DEFAULT_SOL + raydium.CLMM_TICK_ARRAY_RENT_SOL, 1e-12);
    assert.match(far.note!, /1 tick array\(s\) to initialise at 18000/);
    // no tick state at all: both arrays counted
    const blind = raydium.clmmOpenCost({ ...s, clmm: undefined }, { minBinId: ACTIVE - 200, maxBinId: ACTIVE, side: "SOL_ONLY" });
    near(blind.total, raydium.CLMM_OPEN_COST_DEFAULT_SOL + 2 * raydium.CLMM_TICK_ARRAY_RENT_SOL, 1e-12);
    // a two-sided band straddling an array boundary: [20380 - 100, 20390 + 600) -> 19800 and 20400, both known
    const both = raydium.clmmOpenCost(s, { minBinId: ACTIVE - 10, maxBinId: ACTIVE + 60, side: "BOTH" });
    near(both.total, raydium.CLMM_OPEN_COST_DEFAULT_SOL, 1e-12);
    assert.deepEqual(venues.meteoraOpenCost(), { total: dlmm.OPEN_COST_ESTIMATE_SOL, refundable: dlmm.POSITION_RENT_SOL, note: "position + 2 bin arrays (bin arrays not read)" });
    assert.deepEqual(venues.venueOf("meteora-dlmm").openCostSol(s), venues.meteoraOpenCost(), "a snapshot without bin array state keeps the two-array estimate");
    near(venues.venueOf("raydium-clmm").openCostSol(s, { minBinId: ACTIVE - 200, maxBinId: ACTIVE, side: "SOL_ONLY" } as never).total, far.total, 1e-12);
  });

  await test("meteoraOpenCost: rent only for the bin arrays a band touches that do not exist; unread arrays are priced as fresh", () => {
    // active bin 100 sits in array 1 ([70, 139]); arrays 0..3 read, 0..2 exist
    const m = { activeBinId: 100, dlmm: { readBinArrays: [-1, 0, 1, 2, 3], initializedBinArrays: [0, 1, 2] } };
    const inside = venues.meteoraOpenCost(m, { minBinId: 90, maxBinId: 110 });
    near(inside.total, dlmm.POSITION_RENT_SOL, 1e-12);
    assert.equal(inside.refundable, dlmm.POSITION_RENT_SOL);
    assert.equal(inside.note, "bin arrays exist; position rent only (refunded on close)");
    near(venues.meteoraOpenCost(m).total, dlmm.POSITION_RENT_SOL, 1e-12, "no plan: the active array only");
    const across = venues.meteoraOpenCost(m, { minBinId: 60, maxBinId: 150 });
    near(across.total, dlmm.POSITION_RENT_SOL, 1e-12, "arrays 0, 1 and 2 all exist");
    const up = venues.meteoraOpenCost(m, { minBinId: 100, maxBinId: 215 });
    near(up.total, dlmm.POSITION_RENT_SOL + dlmm.BIN_ARRAY_RENT_SOL, 1e-12);
    assert.match(up.note!, /position \+ 1 bin array\(s\) to create at 3 \(0\.0715 SOL each, not refunded\)/);
    const beyond = venues.meteoraOpenCost(m, { minBinId: 100, maxBinId: 300 });
    near(beyond.total, dlmm.POSITION_RENT_SOL + 2 * dlmm.BIN_ARRAY_RENT_SOL, 1e-12, "arrays 3 (read, missing) and 4 (not read)");
    assert.match(beyond.note!, /at 3, 4 \(1 not read, assumed fresh\)/);
    const below = venues.meteoraOpenCost({ activeBinId: -5, dlmm: { readBinArrays: [-3, -2, -1, 0, 1], initializedBinArrays: [0] } }, { minBinId: -5, maxBinId: 5 });
    near(below.total, dlmm.POSITION_RENT_SOL + dlmm.BIN_ARRAY_RENT_SOL, 1e-12, "bin -5 is in array -1 (floor division)");
    assert.equal(dlmm.binArrayIndexOf(-1), -1);
    assert.equal(dlmm.binArrayIndexOf(-70), -1);
    assert.equal(dlmm.binArrayIndexOf(-71), -2);
    assert.equal(dlmm.binArrayIndexOf(69), 0);
    assert.equal(dlmm.binArrayIndexOf(70), 1);
    const s2 = { ...spySnapshot(), venue: "meteora-dlmm", activeBinId: 100, dlmm: m.dlmm } as never;
    near(venues.venueOf("meteora-dlmm").openCostSol(s2, { minBinId: 90, maxBinId: 110 } as never).total, dlmm.POSITION_RENT_SOL, 1e-12, "the venue passes the snapshot and plan through");
  });

  console.log("venue lookup and env");
  await test("detectVenue: the owner program decides, the answer is cached, a hint skips the chain, unknown programs and missing accounts throw", async () => {
    venues.clearVenueCache();
    const calls: string[] = [];
    const owners: Record<string, string | null> = {
      A: venues.METEORA_DLMM_PROGRAM,
      B: venues.RAYDIUM_CLMM_PROGRAM,
      C: venues.ORCA_WHIRLPOOL_PROGRAM,
      D: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      E: null,
    };
    const keys: Record<string, string> = {
      A: Keypair.generate().publicKey.toBase58(),
      B: Keypair.generate().publicKey.toBase58(),
      C: Keypair.generate().publicKey.toBase58(),
      D: Keypair.generate().publicKey.toBase58(),
      E: Keypair.generate().publicKey.toBase58(),
      F: Keypair.generate().publicKey.toBase58(),
    };
    const fake = {
      async getAccountInfo(pk: PublicKey) {
        const id = Object.entries(keys).find(([, k]) => k === pk.toBase58())![0];
        calls.push(id);
        const owner = owners[id];
        return owner ? ({ owner: new PublicKey(owner), data: Buffer.alloc(0), lamports: 1, executable: false } as never) : null;
      },
    } as never;
    assert.equal(await venues.detectVenue(fake, keys.A), "meteora-dlmm");
    assert.equal(await venues.detectVenue(fake, keys.B), "raydium-clmm");
    assert.equal(await venues.detectVenue(fake, keys.C), "orca-whirlpool");
    await assert.rejects(() => venues.detectVenue(fake, keys.D), /not a pool program/);
    await assert.rejects(() => venues.detectVenue(fake, keys.E), /no account/);
    assert.deepEqual(calls, ["A", "B", "C", "D", "E"]);
    assert.equal(await venues.detectVenue(fake, keys.A), "meteora-dlmm");
    assert.deepEqual(calls.length, 5, "cached: no second call");
    assert.equal(await venues.detectVenue(fake, keys.F, "raydium-clmm"), "raydium-clmm");
    assert.deepEqual(calls.length, 5, "the hint answers without the chain");
    assert.equal(venues.venueOfProgram("nope"), null);
    assert.throws(() => venues.venueOf("orca-whirlpool"), /not tradable yet/);
    assert.throws(() => venues.venueOf("bogus"), /unknown venue/);
    assert.equal(venues.venueOf("raydium-clmm").id, "raydium-clmm");
    assert.equal(venues.venueOf("meteora-dlmm").id, "meteora-dlmm");
  });
  await test("tradable/live venue env parsing: defaults, none, unknown names dropped, live requires tradable, book and fee knobs", () => {
    assert.deepEqual(venues.tradableVenues({}), ["meteora-dlmm", "raydium-clmm"]);
    assert.deepEqual(venues.liveVenues({}), ["meteora-dlmm"]);
    assert.deepEqual(venues.tradableVenues({ TRADABLE_VENUES: "none" }), []);
    assert.deepEqual(venues.tradableVenues({ TRADABLE_VENUES: " Raydium-CLMM , meteora-dlmm, raydium-clmm, " }), ["raydium-clmm", "meteora-dlmm"]);
    assert.throws(() => venues.tradableVenues({ TRADABLE_VENUES: "raydium-clmm, bogus" }), /unknown venue "bogus"/, "a typo is an error at boot, not an empty book");
    assert.throws(() => venues.liveVenues({ LIVE_VENUES: "meteora_dlmm" }), /unknown venue "meteora_dlmm"/);
    assert.deepEqual(venues.tradableVenues({ TRADABLE_VENUES: "" }), ["meteora-dlmm", "raydium-clmm"]);
    assert.equal(venues.isTradableVenue("raydium-clmm", {}), true);
    assert.equal(venues.isTradableVenue("orca-whirlpool", {}), false);
    assert.equal(venues.isTradableVenue("raydium-cpmm", {}), false);
    assert.equal(venues.isLiveVenue("meteora-dlmm", {}), true);
    assert.equal(venues.isLiveVenue("raydium-clmm", {}), false, "dormant by default");
    assert.equal(venues.isLiveVenue("raydium-clmm", { LIVE_VENUES: "meteora-dlmm,raydium-clmm" }), true);
    assert.equal(venues.isLiveVenue("raydium-clmm", { LIVE_VENUES: "raydium-clmm", TRADABLE_VENUES: "meteora-dlmm" }), false, "live needs tradable");
    assert.equal(venues.isLiveVenue("meteora-dlmm", { LIVE_VENUES: "none" }), false);
    assert.equal(venues.bookEnv({}), "all");
    assert.equal(venues.bookEnv({ BOOK: "STOCKS" }), "stocks");
    assert.equal(venues.bookEnv({ BOOK: "bonds" }), "all");
    assert.equal(venues.priorityFeeMicroLamports({}), 0);
    assert.equal(venues.priorityFeeMicroLamports({ PRIORITY_FEE_MICROLAMPORTS: "2500.7" }), 2500);
    assert.equal(venues.priorityFeeMicroLamports({ PRIORITY_FEE_MICROLAMPORTS: "-5" }), 0);
    assert.equal(venues.stockMinLiquidityUsd({}), 250_000);
    assert.equal(venues.stockMinLiquidityUsd({ STOCK_MIN_LIQUIDITY_USD: "1e6" }), 1_000_000);
  });
  await test("stockBookPools: stock rows on a tradable venue with SOL/USDC quote and enough liquidity, best fee/TVL first", () => {
    const row = (o: Record<string, unknown>) =>
      ({ address: "x", venue: "raydium-clmm", quoteSymbol: "USDC", tvlUsd: 2_000_000, feeToTvl24hPct: 0.1, flags: [], stock: { ticker: "SPY", issuer: "xstocks" }, ...o }) as never;
    const pools = [
      row({ address: "spy", feeToTvl24hPct: 0.16 }),
      row({ address: "nvda", feeToTvl24hPct: 0.04 }),
      row({ address: "tsla", feeToTvl24hPct: 0.07 }),
      row({ address: "orca", venue: "orca-whirlpool", feeToTvl24hPct: 9 }),
      row({ address: "small", tvlUsd: 100_000, feeToTvl24hPct: 9 }),
      row({ address: "notstock", stock: null, feeToTvl24hPct: 9 }),
      row({ address: "thin", flags: ["thin"], feeToTvl24hPct: 9 }),
      row({ address: "sol-quoted", quoteSymbol: "SOL", feeToTvl24hPct: 0.05 }),
      row({ address: "zec", quoteSymbol: "ZEC", feeToTvl24hPct: 9 }),
    ];
    assert.deepEqual(venues.stockBookPools(pools, true, 250_000, {}).map((p: { address: string }) => p.address), ["spy", "tsla", "sol-quoted", "nvda"]);
    assert.deepEqual(venues.stockBookPools(pools, false, 250_000, {}).map((p: { address: string }) => p.address), ["sol-quoted"], "no SOL price: USDC rows wait");
    assert.deepEqual(venues.stockBookPools(pools, true, 250_000, { TRADABLE_VENUES: "meteora-dlmm" }), []);
  });

  console.log("the policy on a CLMM stock pool");
  const hotOff = { screen: null, hot: [] };
  function obs(over: Partial<Observation> = {}, snapshot: PoolSnapshot = spySnapshot()): Observation {
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
      engine: {
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
        basis: { session: "regular", minutesToOpen: 0, basisPct: 0.69, perpSymbol: "SPY.US_USDC_PERP", perpMid: 758.4, widthMultiplier: 1, reason: null },
      },
      ...over,
    };
  }
  void hotOff;
  await test("BOOK=all: a score-4 stock pool off the hot list is not worth a band; BOOK=stocks: it is, a straddle (BOTH) centred on the active bin, sized in USDC (src/scripts/test-stock.ts has the numbers)", () => {
    const all = policy.policyDecide(obs(), { limits, env: { book: "all" }, now: T0, openCostSol: raydium.CLMM_OPEN_COST_DEFAULT_SOL });
    assert.equal(all.branch, "not-worth");
    const stocks = policy.policyDecide(obs(), { limits, env: { book: "stocks" }, now: T0, openCostSol: raydium.CLMM_OPEN_COST_DEFAULT_SOL });
    assert.equal(stocks.branch, "open", stocks.reason);
    const o = stocks.decision.open!;
    assert.equal(o.side, "BOTH");
    assert.equal(o.binsAboveActive, policy.stockBinsPerSide(10, 1.5, 69, 1));
    assert.equal(o.binsBelowActive, o.binsAboveActive);
    assert.equal(o.binsBelowActive, 15, "1.5% of price at 10 bps is 15 bins each side");
    assert.match(stocks.decision.reasoning, /stock book: SPY \(xstocks\)/);
    assert.match(stocks.decision.headline, /^Straddling SPYx\/USDC/);
    assert.ok(o.amountSol > 0 && o.amountSol <= 22.5 * 100, `sized ${o.amountSol} USDC`);
    assert.ok(o.amountToken > 0 && (o.acquireToken ?? 0) === o.amountToken, "the wallet holds no SPYx: the token half is bought");
    // the basis verdict still refuses
    const refused = policy.policyDecide(obs({ engine: { ...obs().engine!, basis: { ...obs().engine!.basis!, reason: "NYSE opens in 12 min (< 30): the open reprices the stock, no new bands until it settles" } } }), { limits, env: { book: "stocks" }, now: T0 });
    assert.equal(refused.branch, "gated");
    assert.match(refused.reason, /NYSE opens in 12 min/);
  });
  await test("the session width multiplier widens a stock pool's straddle (x2 closed, x1.5 pre/after), each side capped so the band fits the max width; non-stock pools ignore it", () => {
    const closed = policy.policyDecide(obs({ engine: { ...obs().engine!, basis: { ...obs().engine!.basis!, session: "closed", widthMultiplier: 2 } } }), { limits, env: { book: "stocks" }, now: T0 });
    assert.equal(closed.branch, "open");
    assert.equal(closed.decision.open!.binsBelowActive, 30, "15 bins x 2 each side (61 wide)");
    assert.match(closed.decision.reasoning, /x2 for the closed US session/);
    const wide: RiskLimits = { ...limits, maxBinWidth: 200 };
    const after = policy.policyDecide(obs({ engine: { ...obs().engine!, basis: { ...obs().engine!.basis!, session: "after", widthMultiplier: 1.5 } } }), { limits: wide, env: { book: "stocks" }, now: T0 });
    assert.equal(after.decision.open!.binsBelowActive, 22, "14.9 bins x 1.5, rounded once");
    assert.equal(policy.stockBinsPerSide(10, 1.5, 200, 1.5), 22);
    assert.equal(policy.stockBinsPerSide(10, 1.5, 69, 2), 30);
    assert.equal(policy.stockBinsPerSide(10, 5, 69, 2), 34, "capped at (69 - 1) / 2 per side");
    assert.equal(policy.binsForCover(10, 5, 200, 1.5), 73);
    assert.equal(policy.binsForCover(10, 5, 200, 2), 98);
    assert.equal(policy.widthMultiplierFor(obs({ engine: { ...obs().engine!, basis: undefined }, screen: null }), T0), 1, "not a stock pool");
    assert.equal(policy.widthMultiplierFor(obs({ engine: { ...obs().engine!, basis: undefined } }), T0), 1, "regular session, from the clock");
    assert.equal(policy.widthMultiplierFor(obs({ engine: { ...obs().engine!, basis: undefined } }), Date.parse("2026-09-13T17:30:00.000Z")), 2, "Sunday: closed, from the clock");
    assert.equal(policy.policyEnv({ BOOK: "stocks" }).book, "stocks");
  });
  await test("a CLMM quote-only band (non-stock pool) resting one bin under the price holds as 'resting', not idle; two bins away is idle", () => {
    const s = spySnapshot();
    // the same pool without its stock tag and basis row: a plain CLMM pool keeps the one-sided behaviour
    const plain = (over: Partial<Observation> = {}, snap: PoolSnapshot = s): Observation => obs({ ...over, screen: { ...obs().screen!, stock: null, score: 30 }, engine: { ...obs().engine!, ...(over.engine ?? {}), basis: undefined } }, snap);
    const band = (upper: number) => ({ address: "nftmint111", lowerBinId: upper - 48, upperBinId: upper, lowerPrice: clmmPrice(upper - 48), upperPrice: clmmPrice(upper), widthBins: 49, inRange: false, binsFromRange: ACTIVE - upper, amountX: 0, amountY: 2000, feeX: 0, feeY: 0, valueInSol: 20, solInPosition: 20, quoteInPosition: 2000, lastUpdatedAt: 0, entryValueSol: 20 });
    const resting = policy.policyDecide(plain({ positions: [band(ACTIVE - 1)], engine: { ...obs().engine!, outOfRangeSec: { nftmint111: 5000 } } }), { limits, env: { book: "stocks" }, now: T0 });
    assert.equal(resting.branch, "resting");
    assert.match(resting.decision.headline, /Resting one bin under the price/);
    const idle = policy.policyDecide(plain({ positions: [band(ACTIVE - 2)], engine: { ...obs().engine!, outOfRangeSec: { nftmint111: 100 } } }), { limits, env: { book: "stocks" }, now: T0 });
    assert.equal(idle.branch, "idle-wait");
    // on Meteora one bin above the band is idle as before
    const meteoraSnap = spySnapshot({ priceModel: "meteora-dlmm", venue: "meteora-dlmm", clmm: undefined });
    const m = policy.policyDecide(plain({ positions: [band(ACTIVE - 1)], engine: { ...obs().engine!, outOfRangeSec: { nftmint111: 100 } } }, meteoraSnap), { limits, env: { book: "stocks" }, now: T0 });
    assert.equal(m.branch, "idle-wait");
    // the stock pool itself: one bin out for 5000s is not a rest. The re-centre buys half the seat in the
    // stock, which the pool's fees take past STOCK_RECENTRE_MAX_PAYBACK_HOURS to earn back: it waits first
    const stock = policy.policyDecide(obs({ positions: [band(ACTIVE - 1)], engine: { ...obs().engine!, outOfRangeSec: { nftmint111: 5000 } } }), { limits, env: { book: "stocks" }, now: T0 });
    assert.equal(stock.branch, "recentre-wait");
    assert.match(stock.decision.reasoning, /re-centring costs about [\d.]+ SOL \([\d.]+ SOL of swap at [\d.]+%, [\d.]+ SOL of rent\) and the seat's fees, about [\d.]+ SOL a day, take [\d.]+h to earn it back, past the 4h limit/);
    assert.match(stock.decision.reasoning, /up to 120 minutes out of range/);
    // past the wait, or with the gate off, it re-centres
    const late = policy.policyDecide(obs({ positions: [band(ACTIVE - 1)], engine: { ...obs().engine!, outOfRangeSec: { nftmint111: 7300 } } }), { limits, env: { book: "stocks" }, now: T0 });
    assert.equal(late.branch, "rebalance");
    assert.equal(late.decision.open!.side, "BOTH");
    const off = policy.policyDecide(obs({ positions: [band(ACTIVE - 1)], engine: { ...obs().engine!, outOfRangeSec: { nftmint111: 5000 } } }), { limits, env: { book: "stocks", stockRecentreMaxPaybackHours: 0 }, now: T0 });
    assert.equal(off.branch, "rebalance");
  });

  console.log("the paper executor on a CLMM snapshot");
  await test("a paper open on a CLMM pool excludes the active bin, charges the venue's rent, marks at CLMM prices and refunds the venue's rent on close", async () => {
    const s = spySnapshot();
    const book = paper.emptyBook(100, 5000, T0);
    const open: Decision = { action: "OPEN_POSITION", open: { side: "SOL_ONLY", amountSol: 1000, amountToken: 0, binsBelowActive: 20, binsAboveActive: 0, strategy: "Spot" }, positionAddress: null, reasoning: "r", confidence: 0.6, headline: "h" };
    const verdict = (d: Decision): Verdict => ({ proposal: d, decision: d, allowed: true, violations: [], overrides: [], passed: [], emergency: false });
    const ctx = (positions: PoolSnapshot extends never ? never : Observation["positions"], now: number) => ({ venue: venues.raydiumVenue, pool: { venue: "raydium-clmm", address: SPYX_POOL } as never, wallet: {} as never, rawPositions: [], snapshot: s, positions, paper: { book, slippagePct: 0.3, now } }) as Parameters<typeof execute>[1];
    const r = await execute(verdict(open), ctx([], T0));
    assert.equal(r.mode, "paper");
    assert.ok(r.ok, r.notes.join("; "));
    const b = book.bands[0];
    assert.deepEqual([b.lowerBinId, b.upperBinId, b.priceModel], [ACTIVE - 20, ACTIVE - 1, "clmm"]);
    near(b.rentRefundableSol!, raydium.CLMM_POSITION_RENT_SOL, 1e-12);
    near(book.rentLockedSol, raydium.CLMM_POSITION_RENT_SOL, 1e-9);
    near(book.rentSpentSol, raydium.CLMM_PROTOCOL_POSITION_RENT_SOL, 1e-9);
    near(book.wallet.sol, 100 - raydium.CLMM_OPEN_COST_DEFAULT_SOL - paper.PAPER_TX_FEE_SOL, 1e-9);
    near(book.wallet.usdc, 5000 - 1000, 1e-9, "a deposit is not a swap: no slippage on the USDC");
    assert.match(r.txs[0].skipped!, /active bin is excluded/);
    near(r.ledger![0].rentSol, -raydium.CLMM_OPEN_COST_DEFAULT_SOL, 1e-12);
    near(b.lowerPrice, clmmPrice(ACTIVE - 20), 1e-15);
    near(b.upperPrice, clmmPrice(ACTIVE - 1), 1e-15);
    // marked at the open snapshot: one bin under the price, all USDC, no fees yet
    const marked = paper.markPool(book, s, { now: T0 + 60e3, fees: { fees24hUsd: 3577, volume24hUsd: null }, solPriceUsd: 100 });
    assert.equal(marked.length, 1);
    assert.deepEqual([marked[0].inRange, marked[0].binsFromRange, marked[0].amountX], [false, 1, 0]);
    near(marked[0].amountY, 1000, 1e-9, "resting quote-only band holds its USDC");
    // the price falls 10 bins into the band: the top 10 bins are now SPYx at their own CLMM prices
    const lower = spySnapshot({ activeBinId: ACTIVE - 10, activePrice: clmmPrice(ACTIVE - 10), tokenPriceInQuote: clmmPrice(ACTIVE - 10), tokenPriceInSol: clmmPrice(ACTIVE - 10) / 100, clmm: { ...s.clmm!, tickCurrent: (ACTIVE - 10) * 10 } });
    lower.bins = raydium.clmmBins({ tickSpacing: SPACING, tickCurrent: (ACTIVE - 10) * 10, sqrtPriceX64: sdk.TickUtil.getSqrtPriceAtTick((ACTIVE - 10) * 10), liquidity: L, ticks: new Map() }, clmmPrice, 8, 6, 10);
    const down = paper.markPool(book, lower, { now: T0 + 120e3, fees: null, solPriceUsd: 100 })[0];
    assert.equal(down.inRange, true);
    let expectTok = 0;
    for (let bin = ACTIVE - 9; bin <= ACTIVE - 1; bin++) expectTok += 50 / clmmPrice(bin); // 1000 USDC over 20 bins = 50 per bin, converted at each bin's CLMM price
    const split = paper.activeBinQuoteShare(lower, "Y");
    expectTok += (50 * (1 - split)) / clmmPrice(ACTIVE - 10);
    near(down.amountX, expectTok, 1e-9, "token bought bin by bin at CLMM prices");
    near(down.amountY, 50 * 10 + 50 * split, 1e-9);
    // close: the venue's refundable rent comes back, not Meteora's
    const close: Decision = { action: "CLOSE_POSITION", open: null, positionAddress: b.address, reasoning: "r", confidence: 0.6, headline: "h" };
    const solBefore = book.wallet.sol;
    const c = await execute(verdict(close), { ...ctx([down], T0 + 180e3), snapshot: lower });
    assert.ok(c.ok, c.notes.join("; "));
    near(book.wallet.sol - solBefore, raydium.CLMM_POSITION_RENT_SOL - paper.PAPER_TX_FEE_SOL, 1e-9);
    near(c.ledger![0].rentSol, raydium.CLMM_POSITION_RENT_SOL, 1e-12);
    assert.equal(book.rentLockedSol, 0);
    // a Meteora paper open still charges and refunds the Meteora constants
    const mSnap = spySnapshot({ priceModel: "meteora-dlmm", venue: "meteora-dlmm", clmm: undefined });
    const book2 = paper.emptyBook(100, 5000, T0);
    const m = await execute(verdict(open), { ...ctx([], T0), venue: venues.meteoraVenue, snapshot: mSnap, paper: { book: book2, slippagePct: 0.3, now: T0 } } as never);
    assert.ok(m.ok);
    assert.deepEqual([book2.bands[0].lowerBinId, book2.bands[0].upperBinId, book2.bands[0].priceModel, book2.bands[0].rentRefundableSol], [ACTIVE - 20, ACTIVE, undefined, dlmm.POSITION_RENT_SOL]);
    near(book2.rentSpentSol, dlmm.OPEN_COST_ESTIMATE_SOL - dlmm.POSITION_RENT_SOL, 1e-9);
    assert.match(m.ledger![0].note, /position \+ 2 bin arrays/);
  });

  console.log("position discovery");
  await test("poolsWithPositions asks every venue with an adapter and throws when any of them fails: a partial list is never returned", async () => {
    const meteoraList = venues.meteoraVenue.poolsWithPositions;
    const raydiumList = venues.raydiumVenue.poolsWithPositions;
    const prev = process.env.TRADABLE_VENUES;
    const owner = Keypair.generate().publicKey;
    const conn = {} as unknown as import("@solana/web3.js").Connection;
    try {
      venues.meteoraVenue.poolsWithPositions = async () => ["MeteoraPool111"];
      venues.raydiumVenue.poolsWithPositions = async () => ["RaydiumPool111"];
      process.env.TRADABLE_VENUES = "meteora-dlmm"; // Raydium is off the tradable list: what we hold there is still listed
      assert.deepEqual(await venues.poolsWithPositions(conn, owner), [{ address: "MeteoraPool111", venue: "meteora-dlmm" }, { address: "RaydiumPool111", venue: "raydium-clmm" }]);
      venues.raydiumVenue.poolsWithPositions = async () => { throw new Error("429 Too Many Requests"); };
      const logs: string[] = [];
      await assert.rejects(venues.poolsWithPositions(conn, owner, (s) => logs.push(s)), /could not list raydium-clmm positions \(429 Too Many Requests\); skipping the cycle rather than working a partial list/);
      assert.equal(logs.length, 1);
    } finally {
      venues.meteoraVenue.poolsWithPositions = meteoraList;
      venues.raydiumVenue.poolsWithPositions = raydiumList;
      if (prev === undefined) delete process.env.TRADABLE_VENUES;
      else process.env.TRADABLE_VENUES = prev;
    }
  });

  console.log("the executor's live gate");
  await test("broadcastRefusal: dry-run never refuses; live refuses a tradable venue off LIVE_VENUES with a clear note; LIVE_VENUES turns it on", () => {
    assert.equal(broadcastRefusal("raydium-clmm", true, {}), null);
    assert.equal(broadcastRefusal("meteora-dlmm", false, {}), null);
    const why = broadcastRefusal("raydium-clmm", false, {});
    assert.match(why!, /raydium-clmm is tradable but not live \(LIVE_VENUES=meteora-dlmm\)/);
    assert.match(why!, /paper and dry-run only/);
    assert.equal(broadcastRefusal("raydium-clmm", false, { LIVE_VENUES: "meteora-dlmm,raydium-clmm" }), null);
    assert.match(broadcastRefusal("meteora-dlmm", false, { LIVE_VENUES: "none" })!, /LIVE_VENUES=none/);
  });
  await test("execute() with DRY_RUN=false on a non-live venue: nothing is built, nothing broadcast, no ledger row, the note says why", async () => {
    let built = 0;
    const venue = { ...venues.raydiumVenue, buildOpen: async () => { built++; throw new Error("must not be called"); } } as never;
    const s = spySnapshot();
    const open: Decision = { action: "OPEN_POSITION", open: { side: "SOL_ONLY", amountSol: 100, amountToken: 0, binsBelowActive: 20, binsAboveActive: 0, strategy: "Spot" }, positionAddress: null, reasoning: "r", confidence: 0.6, headline: "h" };
    const v: Verdict = { proposal: open, decision: open, allowed: true, violations: [], overrides: [], passed: [], emergency: false };
    const wallet = { publicKey: Keypair.generate().publicKey, ephemeral: false, signAndSend: async () => { throw new Error("must not broadcast"); } } as never;
    const ledgerFile = path.join(tmp, "ledger.jsonl");
    const rows = () => (fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean).length : 0);
    const rowsBefore = rows();
    const r = await execute(v, { venue, pool: { venue: "raydium-clmm", address: SPYX_POOL }, wallet, rawPositions: [], snapshot: s, positions: [] });
    assert.deepEqual([r.mode, r.ok, r.txs.length, r.ledger?.length ?? 0, built], ["none", false, 0, 0, 0]);
    assert.match(r.notes[0], /raydium-clmm is tradable but not live/);
    assert.equal(rows(), rowsBefore, "no ledger row written");
    // a HOLD and a blocked verdict still answer as before
    const hold: Decision = { ...open, action: "HOLD", open: null };
    assert.equal((await execute({ ...v, proposal: hold, decision: hold }, { venue, pool: { venue: "raydium-clmm", address: SPYX_POOL }, wallet, rawPositions: [], snapshot: s, positions: [] })).mode, "none");
    assert.equal((await execute({ ...v, allowed: false }, { venue, pool: { venue: "raydium-clmm", address: SPYX_POOL }, wallet, rawPositions: [], snapshot: s, positions: [] })).notes[0], "blocked by guards");
  });

  console.log(`\n${passed} venue tests passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
