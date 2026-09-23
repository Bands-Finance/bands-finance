/**
 * Paper-mode and desk-policy tests. Pure: no RPC, no LLM, no writes outside a temp dir.
 *   npm run test:paper
 * Covers: env gating, the book's open/mark/close/claim math by hand on a 10-bin Spot band (a 4-bin
 * fall converts the right slices at the right bin prices and a recovery converts them back), fee
 * accrual only in range, the equity identity, the paper executor and execute()'s delegation, the
 * guards on paper positions, every policy branch on synthetic observations, decide() without a key,
 * the report, the file round-trip and GET /api/paper.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Observation } from "../agent/observation";
import type { Decision } from "../agent/schema";
import type { JournalEntry } from "../journal";
import type { PaperBook } from "../paper/book";
import type { RiskLimits } from "../risk/limits";
import type { Verdict } from "../risk/guards";
import type { RiskState } from "../risk/state";
import type { PoolSnapshot, PositionSnapshot } from "../tools/dlmm";

// Everything that reads src/config.ts is imported after the environment is pinned.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mr-bands-paper-"));
process.env.DATA_DIR = tmp;
process.env.ANTHROPIC_API_KEY = "";
delete process.env.ANTHROPIC_AUTH_TOKEN;
process.env.DRY_RUN = "true";
process.env.WALLET_SECRET_KEY = "";
process.env.MAX_POSITION_SOL = "22.5";
process.env.MAX_TOTAL_EXPOSURE_SOL = "90";
process.env.GAS_RESERVE_SOL = "1";
process.env.STOP_LOSS_PCT = "15";
process.env.MAX_BIN_WIDTH = "69";
process.env.MAX_TX_PER_DAY = "24";
process.env.MIN_SECONDS_BETWEEN_ACTIONS = "600";
process.env.MAX_PRICE_MOVE_PCT_PER_CYCLE = "40";
process.env.POLICY_COVER_PCT = "5";
process.env.POLICY_MIN_SCORE = "20";
process.env.PAPER_SOL = "";

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
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what} expected ${b}, got ${a}`);
};

const limits: RiskLimits = { maxPositionSol: 22.5, maxTotalExposureSol: 90, gasReserveSol: 1, stopLossPct: 15, maxBinWidth: 69, maxTxPerDay: 24, minSecondsBetweenActions: 600, maxSlippagePct: 1, maxPriceMovePctPerCycle: 40 };
const POOL = "6e7V9eegCHw997T72MxgwwJipZ6GJyZF8NvjkzT1rvpN";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ANSEM = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";
const T0 = Date.parse("2026-09-14T12:00:00.000Z");

async function main(): Promise<void> {
  const dlmm = await import("../tools/dlmm.js");
  const paper = await import("../paper/index.js");
  const { execute } = await import("../executor.js");
  const { evaluate } = await import("../risk/guards.js");
  const { emptyState } = await import("../risk/state.js");
  const policy = await import("../agent/policy.js");
  const { decide } = await import("../agent/decide.js");
  const { Hono } = await import("hono");
  const { binPriceUi } = dlmm;
  const p = (bin: number) => binPriceUi(bin, 20, 6, 9);

  /** ANSEM/SOL: X = ANSEM (6 dec), Y = SOL (9 dec), 20 bps. 9 SOL in each bin below active, 5000 ANSEM in each above. */
  function snapAt(active: number, over: Partial<PoolSnapshot> = {}, activeMix: { y: number; x: number } = { y: 1, x: 0 }): PoolSnapshot {
    const bins = [];
    for (let b = active - 10; b <= active + 10; b++) {
      bins.push({ binId: b, price: p(b), xAmount: b > active ? 5000 : b === active ? activeMix.x : 0, yAmount: b < active ? 9 : b === active ? activeMix.y : 0, isActive: b === active });
    }
    return {
      address: POOL,
      label: "ANSEM/SOL",
      tokenX: { mint: ANSEM, symbol: "ANSEM", decimals: 6, reserve: 5_000_000 },
      tokenY: { mint: SOL_MINT, symbol: "SOL", decimals: 9, reserve: 5000 },
      solSide: "Y",
      baseToken: { mint: ANSEM, symbol: "ANSEM", decimals: 6, reserve: 5_000_000 },
      binStep: 20,
      activeBinId: active,
      activePrice: p(active),
      priceLabel: "SOL per ANSEM",
      tokenPriceInSol: p(active),
      quoteSide: "Y",
      quoteToken: { mint: SOL_MINT, symbol: "SOL", decimals: 9, reserve: 5000 },
      quoteSymbol: "SOL",
      quotePriceInSol: 1,
      tokenPriceInQuote: p(active),
      solPriceUsd: 100,
      baseFeePct: 0.2,
      maxFeePct: 10,
      dynamicFeePct: 0.2,
      bins,
      liquidityBelowY: 90,
      liquidityAboveX: 50_000,
      fetchedAt: new Date(T0).toISOString(),
      ...over,
    };
  }

  const verdictOf = (decision: Decision, over: Partial<Verdict> = {}): Verdict => ({ proposal: decision, decision, allowed: true, violations: [], overrides: [], passed: [], emergency: false, ...over });
  const openDecision = (amountSol: number, binsBelowActive: number, strategy: "Spot" | "Curve" | "BidAsk" = "Spot"): Decision => ({
    action: "OPEN_POSITION",
    open: { side: "SOL_ONLY", amountSol, amountToken: 0, binsBelowActive, binsAboveActive: 0, strategy },
    positionAddress: null,
    reasoning: "test",
    confidence: 1,
    headline: "test open",
  });
  const closeDecision = (address: string, reasoning = "test", headline = "test close"): Decision => ({ action: "CLOSE_POSITION", open: null, positionAddress: address, reasoning, confidence: 1, headline });

  console.log("paper env");
  await test("paperEnv defaults, PAPER_SOL enables under dry-run only, DRY_RUN=false is refused", () => {
    assert.deepEqual(paper.paperEnv({}), { sol: 0, usdc: 0, slippagePct: 0.3 });
    assert.deepEqual(paper.paperEnv({ PAPER_SOL: "100", PAPER_USDC: "500", PAPER_SLIPPAGE_PCT: "0.5" }), { sol: 100, usdc: 500, slippagePct: 0.5 });
    assert.deepEqual(paper.paperEnv({ PAPER_SOL: "junk", PAPER_SLIPPAGE_PCT: "-1" }), { sol: 0, usdc: 0, slippagePct: 0 });
    assert.equal(paper.paperEnabled({ PAPER_SOL: "100" }, true), true);
    assert.equal(paper.paperEnabled({ PAPER_SOL: "100" }, false), false);
    assert.equal(paper.paperEnabled({}, true), false);
    assert.throws(() => paper.assertPaperEnv(false, { PAPER_SOL: "100" }), /PAPER_SOL=100 with DRY_RUN=false.*Refusing to start/);
    paper.assertPaperEnv(true, { PAPER_SOL: "100" });
    paper.assertPaperEnv(false, {});
    paper.assertPaperEnv(false, { PAPER_SOL: "0" });
  });

  console.log("paper book: a 10-bin Spot band, by hand");
  const book = paper.emptyBook(100, 0, T0);
  const s260 = snapAt(260);
  let bandAddr = "";
  await test("open: wallet pays the deposit + the open rent estimate, no slippage (a deposit is not a swap); the band holds the deposit", () => {
    assert.equal(book.wallet.sol, 100);
    const r = paper.openBand(book, {
      pool: POOL, label: "ANSEM/SOL", quoteSymbol: "SOL", quoteSide: "Y", quoteMint: SOL_MINT, tokenMint: ANSEM, tokenSymbol: "ANSEM", xDecimals: 6, yDecimals: 9, binStep: 20,
      activeBinId: 260, activePrice: p(260), tokenPriceInQuote: p(260), quotePriceInSol: 1, lowerBinId: 251, upperBinId: 260, lowerPrice: p(251), upperPrice: p(260),
      side: "SOL_ONLY", strategy: "Spot", amountQuote: 1, amountToken: 0, slippagePct: 0.3, now: T0,
    });
    bandAddr = r.band.address;
    assert.equal(bandAddr, `paper-${POOL.slice(0, 6)}-1`);
    near(book.wallet.sol, 100 - 1 - dlmm.OPEN_COST_ESTIMATE_SOL, 1e-9, "wallet sol");
    near(book.rentLockedSol, dlmm.POSITION_RENT_SOL, 1e-9, "rent locked");
    near(book.rentSpentSol, 2 * dlmm.BIN_ARRAY_RENT_SOL, 1e-9, "rent spent");
    near(book.slippagePaidSol, 0, 1e-12, "no slippage on a deposit");
    near(r.band.entryValueSol, 1, 1e-9, "entry = the deposit at the open mark");
    assert.equal(r.band.quoteDeposit, 1);
    assert.equal(r.band.openedBinId, 260);
    assert.deepEqual([r.band.lowerBinId, r.band.upperBinId], [251, 260]);
    assert.equal(paper.poolsWithBands(book)[0], POOL);
    assert.throws(() => paper.openBand(book, { pool: POOL, label: "x", quoteSymbol: "SOL", quoteSide: "Y", quoteMint: SOL_MINT, tokenMint: ANSEM, tokenSymbol: "ANSEM", xDecimals: 6, yDecimals: 9, binStep: 20, activeBinId: 260, activePrice: p(260), tokenPriceInQuote: p(260), quotePriceInSol: 1, lowerBinId: 251, upperBinId: 260, lowerPrice: p(251), upperPrice: p(260), side: "SOL_ONLY", strategy: "Spot", amountQuote: 1000, amountToken: 0, slippagePct: 0.3, now: T0 }), /paper wallet holds/);
    assert.equal(book.bands.length, 1);
  });
  const band = () => book.bands[0];
  await test("mark at open: every slice is quote, in range, value = the deposit", () => {
    const [pos] = paper.markPool(book, s260, { now: T0, fees: null, solPriceUsd: 100 });
    near(pos.amountY, 1, 1e-9, "amountY");
    near(pos.amountX, 0, 1e-9, "amountX");
    assert.equal(pos.inRange, true);
    assert.equal(pos.binsFromRange, 0);
    near(pos.valueInSol, 1, 1e-9, "value");
    near(pos.quoteInPosition!, 1, 1e-9, "quoteInPosition");
    near(pos.solInPosition, 1, 1e-9, "solInPosition");
    assert.equal(pos.entryValueSol, band().entryValueSol);
    assert.equal(pos.widthBins, 10);
    assert.equal(pos.address, bandAddr);
    assert.equal(book.tokenMarks[ANSEM].priceInSol, p(260));
    assert.equal(book.solPriceUsd, 100);
  });
  await test("price falls 4 bins: bins 257..260 hold 0.1 SOL worth of ANSEM each at their own bin price; 251..256 stay SOL", () => {
    const s256 = snapAt(256);
    const [pos] = paper.markPool(book, s256, { now: T0, fees: null, solPriceUsd: 100 });
    let expectX = 0;
    for (let b = 257; b <= 260; b++) expectX += 0.1 / p(b);
    near(pos.amountX, expectX, 1e-9, "amountX");
    near(pos.amountY, 0.6, 1e-9, "amountY: 5 bins below + the active bin (pure SOL in the pool's mix)");
    assert.equal(pos.inRange, true);
    near(pos.valueInSol, 0.6 + expectX * p(256), 1e-9, "value at the current price");
    assert.ok(pos.valueInSol < 1, "the ANSEM bought above the current price marks below the deposit");
    const dd = (1 - pos.valueInSol / band().entryValueSol) * 100;
    assert.ok(dd > 0 && dd < 2, `drawdown ${dd.toFixed(3)}% is the buy-the-dip mark plus the slippage`);
  });
  await test("the active bin splits by the pool's own mix: 50/50 in value gives half a slice each way", () => {
    const s256 = snapAt(256, {}, { y: 1, x: 1 / p(256) });
    near(paper.activeBinQuoteShare(s256, "Y"), 0.5, 1e-9, "split");
    const { amountQuote, amountToken } = paper.bandContents(band(), s256);
    let expectX = 0.05 / p(256);
    for (let b = 257; b <= 260; b++) expectX += 0.1 / p(b);
    near(amountQuote, 0.55, 1e-9, "quote");
    near(amountToken, expectX, 1e-9, "token");
    assert.equal(paper.activeBinQuoteShare(snapAt(256, { bins: [] }), "Y"), paper.UNKNOWN_SPLIT);
  });
  await test("price recovers to 260: every slice converts back at its bin price, the deposit returns exactly", () => {
    const [pos] = paper.markPool(book, s260, { now: T0, fees: null, solPriceUsd: 100 });
    near(pos.amountY, 1, 1e-9, "amountY");
    near(pos.amountX, 0, 1e-9, "amountX");
    near(pos.valueInSol, 1, 1e-9, "value");
  });
  await test("price above the band (262): idle in SOL, out of range by +2, no fees", () => {
    const [pos] = paper.markPool(book, snapAt(262), { now: T0 + 600e3, fees: { fees24hUsd: 8640, volume24hUsd: null }, solPriceUsd: 100 });
    near(pos.amountY, 1, 1e-9);
    assert.equal(pos.inRange, false);
    assert.equal(pos.binsFromRange, 2);
    assert.equal(pos.feeY, 0);
    assert.equal(pos.feeX, 0);
    assert.equal(band().lastMarkAt, T0 + 600e3);
  });
  await test("price below the band (250): every slice is ANSEM, out of range by -1, value marks at the current price", () => {
    const [pos] = paper.markPool(book, snapAt(250), { now: T0 + 600e3, fees: null, solPriceUsd: 100 });
    let expectX = 0;
    for (let b = 251; b <= 260; b++) expectX += 0.1 / p(b);
    near(pos.amountX, expectX, 1e-9);
    near(pos.amountY, 0, 1e-9);
    assert.equal(pos.inRange, false);
    assert.equal(pos.binsFromRange, -1);
    near(pos.valueInSol, expectX * p(250), 1e-9);
    // the loop's own consistency rule (seed-demo --check) on inRange / binsFromRange
    const active = 250;
    const inRange = active >= pos.lowerBinId && active <= pos.upperBinId;
    assert.equal(pos.inRange, inRange);
    assert.equal(pos.binsFromRange, inRange ? 0 : active < pos.lowerBinId ? active - pos.lowerBinId : active - pos.upperBinId);
  });
  await test("fees accrue only in range: 10 min at $8,640/day, 1.1% of a 90 SOL band, halved, at $100/SOL, half SOL half ANSEM", () => {
    const now = T0 + 1200e3; // the last mark was at T0 + 600e3
    const s = snapAt(260);
    const acc = paper.accrueFees(band(), s, { now, fees: { fees24hUsd: 8640, volume24hUsd: null }, solPriceUsd: 100 }, "SOL");
    near(acc.dtSec, 600, 1e-9, "dt");
    near(acc.depthQuote, 90, 1e-9, "depth: 9 SOL/bin x 10 bins");
    near(acc.shareOfBand, 1 / 91, 1e-9, "share");
    near(acc.feesPerDayUsd, 8640, 1e-9);
    const feeUsd = 8640 * (1 / 91) * 0.5 * (600 / 86400);
    near(acc.feeQuoteTotal, feeUsd / 100, 1e-9, "fee in SOL");
    near(acc.feeQuote, feeUsd / 200, 1e-9, "half in SOL");
    near(acc.feeToken, feeUsd / 200 / p(260), 1e-9, "half in ANSEM at the current price");
    const [pos] = paper.markPool(book, s, { now, fees: { fees24hUsd: 8640, volume24hUsd: null }, solPriceUsd: 100 });
    near(pos.feeY, feeUsd / 200, 1e-9);
    near(pos.feeX, feeUsd / 200 / p(260), 1e-9);
    near(pos.valueInSol, 1 + feeUsd / 100, 1e-9, "value includes the fees");
    near(pos.quoteInPosition!, 1 + feeUsd / 200, 1e-9);
    // out of range: nothing more accrues, whatever the time
    const before = { q: band().feeQuote, t: band().feeToken };
    paper.markPool(book, snapAt(262), { now: now + 600e3, fees: { fees24hUsd: 8640, volume24hUsd: null }, solPriceUsd: 100 });
    assert.equal(band().feeQuote, before.q);
    assert.equal(band().feeToken, before.t);
    // the volume fallback, the mark-gap cap and the 50% share cap
    const vol = paper.accrueFees({ ...band(), lastMarkAt: now - 3 * 86400e3 }, s, { now, fees: { fees24hUsd: null, volume24hUsd: 1_000_000 }, solPriceUsd: 100 }, "SOL");
    near(vol.feesPerDayUsd, 2000, 1e-9, "volume x dynamic fee");
    near(vol.dtSec, paper.MAX_MARK_GAP_SEC, 1e-9, "dt capped");
    assert.equal(paper.feesPerDayUsd(null, 0.2), 0);
    assert.equal(paper.feesPerDayUsd({ fees24hUsd: null, volume24hUsd: null }, 0.2), 0);
    near(paper.shareOfBand(1000, 90), 0.5, 1e-9, "capped at 50%");
    near(paper.shareOfBand(1, 0), 0.5, 1e-9, "empty band: capped");
    assert.equal(paper.shareOfBand(0, 90), 0);
    const noPrice = paper.accrueFees(band(), s, { now: now + 1200e3, fees: { fees24hUsd: 8640, volume24hUsd: null }, solPriceUsd: null }, "SOL");
    assert.equal(noPrice.feeQuote, 0);
    assert.match(noPrice.note!, /no SOL price/);
    const usdc = paper.accrueFees(band(), s, { now: now + 1200e3, fees: { fees24hUsd: 8640, volume24hUsd: null }, solPriceUsd: null }, "USDC");
    assert.ok(usdc.feeQuote > 0, "a USDC quote needs no SOL price");
  });
  await test("fees from the flow scout: our share of what traded through our own bins; the day figure only as a fallback, capped at 3x the scout's pool pace", () => {
    const now = T0 + 1200e3;
    const s = snapAt(260);
    const b = band();
    const flow = { asOf: now - 60e3, coveredMin: 120, ours15mQuote: 0.09, feesPerDayQuote240m: 5, band: { lowerBinId: b.lowerBinId, upperBinId: b.upperBinId } };
    const acc = paper.accrueFees(b, s, { now, fees: { fees24hUsd: 8640, volume24hUsd: null }, solPriceUsd: 100, flow }, "SOL");
    assert.equal(acc.basis, "flow");
    near(acc.feeQuoteTotal, (0.09 / 900) * acc.shareOfBand * acc.dtSec, 1e-12, "our share of the fees in our bins, no halving, no day figure");
    // the volume died: nothing traded through our bins, so nothing accrues, whatever the day figure says
    const dead = paper.accrueFees(b, s, { now, fees: { fees24hUsd: 8640, volume24hUsd: null }, solPriceUsd: 100, flow: { ...flow, ours15mQuote: 0 } }, "SOL");
    assert.equal(dead.basis, "flow");
    assert.equal(dead.feeQuoteTotal, 0);
    // a reading of another band, a stale one, one under 15 minutes of coverage, or none about a band: the day figure stands
    for (const f of [{ ...flow, band: { lowerBinId: b.lowerBinId - 1, upperBinId: b.upperBinId } }, { ...flow, asOf: now - 11 * 60e3 }, { ...flow, coveredMin: 10 }, { ...flow, band: null }]) {
      assert.equal(paper.accrueFees(b, s, { now, fees: { fees24hUsd: 8640, volume24hUsd: null }, solPriceUsd: 100, flow: f }, "SOL").basis, "24h");
    }
    // the fallback's day figure is capped at 3x the scout's pace for the whole pool: 5 SOL a day at $100 is $500, so $1,500, not $8,640
    const capped = paper.accrueFees(b, s, { now, fees: { fees24hUsd: 8640, volume24hUsd: null }, solPriceUsd: 100, flow: { ...flow, band: null } }, "SOL");
    near(capped.feesPerDayUsd, 1500, 1e-9);
    // out of range with a reading: nothing
    assert.equal(paper.accrueFees(b, snapAt(262), { now, fees: null, solPriceUsd: 100, flow }, "SOL").feeQuoteTotal, 0);
  });
  await test("price impact: a paper swap walks the pool's bins away from the price and pays their average (0 inside the active bin)", () => {
    // quote Y (SOL), bin step 100 bps: 10 tokens in the active bin and each bin above, 5 SOL in the active bin and each bin below
    const bins = Array.from({ length: 11 }, (_, k) => k - 5).map((d) => ({ binId: 100 + d, xAmount: d >= 0 ? 10 : 0, yAmount: d <= 0 ? 5 : 0 }));
    const i = { bins, activeBinId: 100, quoteSide: "Y" as const, binStepBps: 100, tokenPriceInQuote: 1 };
    near(paper.binWalkImpactPct(i, "buy", 10), 0, 1e-12, "the active bin absorbs it whole");
    // 20 tokens: 10 at 1.00, 10 at 1.01 -> average 1.005, so 0.5% against the buyer
    near(paper.binWalkImpactPct(i, "buy", 20), 0.5, 1e-9, "two bins");
    // a sale of 10 tokens: 5 at 1.00 (the active bin's 5 SOL), then 5 SOL at 1/1.01 -> 4.95 tokens, then 0.05 at 1/1.01^2
    const sold = paper.binWalkImpactPct(i, "sell", 10);
    assert.ok(sold > 0.4 && sold < 0.6, `a sale walks down: ${sold}`);
    // past the snapshot the walk assumes bins like the ones it saw, so a big buy keeps paying more, never less
    assert.ok(paper.binWalkImpactPct(i, "buy", 200) > paper.binWalkImpactPct(i, "buy", 60));
    // quote X: the token sits below the active bin, so a buy walks down
    const ix = { bins: bins.map((b) => ({ binId: 200 - (b.binId - 100), xAmount: b.yAmount, yAmount: b.xAmount })), activeBinId: 200, quoteSide: "X" as const, binStepBps: 100, tokenPriceInQuote: 1 };
    near(paper.binWalkImpactPct(ix, "buy", 20), 0.5, 1e-9, "mirror image when the quote is X");
    // the swap pays it: a buy with 2% impact spends 2% more quote for the same tokens, and tallies it as swap cost
    const b1 = paper.emptyBook(100, 0, T0);
    const plain = paper.buyToken(paper.emptyBook(100, 0, T0), { quoteSymbol: "SOL", tokenMint: ANSEM, tokenSymbol: "ANSEM", tokenPriceInQuote: 0.5, quotePriceInSol: 1, feePct: 0.1, tokenOut: 10 });
    const hit = paper.buyToken(b1, { quoteSymbol: "SOL", tokenMint: ANSEM, tokenSymbol: "ANSEM", tokenPriceInQuote: 0.5, quotePriceInSol: 1, feePct: 0.1, tokenOut: 10, impactPct: 2 });
    near(hit.amountIn, plain.amountIn * 1.02, 1e-9);
    near(hit.impactSol, 10 * 0.5 * 0.02, 1e-9);
    near(b1.swapCostSol ?? 0, hit.feeSol + hit.impactSol, 1e-9);
    // a sale with 3% impact receives 3% less than the same sale without it
    const holder = paper.emptyBook(100, 0, T0);
    paper.buyToken(holder, { quoteSymbol: "SOL", tokenMint: ANSEM, tokenSymbol: "ANSEM", tokenPriceInQuote: 0.5, quotePriceInSol: 1, feePct: 0, tokenOut: 10 });
    const sPlain = paper.sellToken(holder, { quoteSymbol: "SOL", tokenMint: ANSEM, tokenSymbol: "ANSEM", tokenPriceInQuote: 0.5, quotePriceInSol: 1, feePct: 0.1, tokenIn: 10 });
    const sHit = paper.sellToken(b1, { quoteSymbol: "SOL", tokenMint: ANSEM, tokenSymbol: "ANSEM", tokenPriceInQuote: 0.5, quotePriceInSol: 1, feePct: 0.1, tokenIn: 10, impactPct: 3 });
    near(sHit.amountOut, sPlain.amountOut * 0.97, 1e-9);
    assert.ok(sHit.impactSol > 0);
  });
  await test("the report names the SOL/USD move: USDC flows since the start re-priced at today's SOL price, and the identity closes", () => {
    const usd = paper.emptyBook(1, 1000, T0);
    usd.solPriceUsd = 125;
    const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const ledger = [
      { ts: T0 - 60e3, quoteMint: USDC, quoteDelta: 500, solDelta: 5 }, // before the book started: not counted
      { ts: T0 + 60e3, quoteMint: USDC, quoteDelta: 100, solDelta: 1 }, // 100 USDC booked at 1 SOL ($100 SOL), worth 0.8 SOL at $125
      { ts: T0 + 120e3, quoteMint: "So11111111111111111111111111111111111111112", quoteDelta: 2, solDelta: 2 }, // a SOL flow: no SOL/USD move
    ];
    const sum = paper.paperSummary(usd, [], T0 + 3600e3, ledger);
    near(sum.equity.valuationSol ?? NaN, 100 / 125 - 1, 1e-12, "re-priced at today's SOL price");
    const explained = sum.realizedSol + sum.markedSol + sum.equity.hedgeSol - sum.rentLockedSol - sum.rentSpentSol - sum.swapCostSol - sum.txFeesSol;
    near(sum.equity.vsStartSol, explained + (sum.equity.valuationSol ?? 0) + sum.equity.otherSol, 1e-12, "the identity closes");
    assert.equal(paper.paperSummary(usd, [], T0 + 3600e3).equity.valuationSol, null, "no ledger: no valuation term");
    assert.match(paper.renderPaperReport(sum), /SOL\/USD valuation/);
  });
  await test("claim: the accrued fees move to the wallet, the band's fees zero, feesClaimedSol tallies", () => {
    paper.markPool(book, s260, { now: T0 + 1800e3, fees: null, solPriceUsd: 100 });
    const b = band();
    const feeQuote = b.feeQuote;
    const feeToken = b.feeToken;
    assert.ok(feeQuote > 0 && feeToken > 0);
    const solBefore = book.wallet.sol;
    const r = paper.claimFees(book, b.address, { tokenPriceInQuote: p(260), quotePriceInSol: 1 }, T0 + 1800e3)!;
    near(r.feeSol, feeQuote + feeToken * p(260), 1e-12);
    near(book.wallet.sol, solBefore + feeQuote, 1e-9); // the wallet keeps 9 decimals (lamports)
    near(book.wallet.tokens[ANSEM], feeToken, 1e-9);
    assert.equal(b.feeQuote, 0);
    assert.equal(b.feeToken, 0);
    near(book.feesClaimedSol, r.feeSol, 1e-9);
    near(book.feesRealizedSol, r.feeSol, 1e-9);
    assert.equal(paper.claimFees(book, b.address, { tokenPriceInQuote: p(260), quotePriceInSol: 1 }, T0 + 1800e3), null, "nothing left to claim");
  });
  await test("equity identity while open: equity - start = realized + marked - rent locked - rent spent", () => {
    const [pos] = paper.markPool(book, snapAt(256), { now: T0 + 1800e3, fees: null, solPriceUsd: 100 });
    const eq = paper.bookEquitySol(book);
    const realized = book.feesClaimedSol;
    const marked = pos.valueInSol - band().entryValueSol;
    // the claimed ANSEM arrived at the bin-260 mark and is now priced at bin 256: that is the wallet's own marked line
    assert.ok(eq.tokensMarkedSol < 0, "claimed ANSEM marks down with the price");
    near(eq.tokensBasisSol, book.tokenBasisSol[ANSEM], 1e-12);
    near(eq.equitySol - book.startSol, realized + marked + eq.tokensMarkedSol - book.rentLockedSol - book.rentSpentSol, 1e-9, "identity");
    near(eq.bandsSol, pos.valueInSol, 1e-12);
  });
  await test("close at 256: SOL back + ANSEM less 0.3% + rent refund; realized P&L vs the all-in entry; the identity still holds", () => {
    const s256 = snapAt(256);
    const b = band();
    const v = paper.valueBand(b, s256);
    const solBefore = book.wallet.sol;
    const tokBefore = book.wallet.tokens[ANSEM] ?? 0;
    const closed = paper.closeBand(book, { address: b.address, value: v, slippagePct: 0.3, now: T0 + 2400e3, reason: "test close", emergency: false });
    near(book.wallet.sol, solBefore + v.amountQuote + v.feeQuote + dlmm.POSITION_RENT_SOL, 1e-9, "sol back + rent");
    near(book.wallet.tokens[ANSEM], tokBefore + (v.amountToken + v.feeToken) * 0.997, 1e-9, "token back less slippage");
    near(book.rentLockedSol, 0, 1e-12, "rent unlocked");
    const proceeds = v.amountQuote + v.feeQuote + (v.amountToken + v.feeToken) * 0.997 * p(256);
    near(closed.proceedsSol, proceeds, 1e-12);
    near(closed.realizedSol, proceeds - 1, 1e-12, "realized vs the entry (the deposit at the open mark)");
    near(closed.slippageSol, (v.amountToken + v.feeToken) * 0.003 * p(256), 1e-12);
    near(closed.holdSec, 2400, 1e-9);
    assert.equal(closed.reason, "test close");
    assert.equal(book.bands.length, 0);
    assert.equal(book.closed.length, 1);
    const eq = paper.bookEquitySol(book);
    const realized = closed.realizedSol + book.feesClaimedSol;
    near(eq.equitySol - book.startSol, realized + eq.tokensMarkedSol - book.rentLockedSol - book.rentSpentSol, 1e-9, "identity after close");
    // basis: the claimed ANSEM at its bin-260 mark plus the ANSEM that came back at bin 256
    near(book.tokenBasisSol[ANSEM], tokBefore * p(260) + (v.amountToken + v.feeToken) * 0.997 * p(256), 1e-6, "basis of the wallet's ANSEM");
    assert.throws(() => paper.closeBand(book, { address: "nope", value: v, slippagePct: 0.3, now: T0, reason: "", emergency: false }), /not found/);
  });
  await test("a quote-X pool flips the sides: the quote sits above the active bin and a rise through the band buys token", () => {
    const b2 = paper.emptyBook(1, 1000, T0); // 1 SOL for rent, 1000 USDC to lay
    const r = paper.openBand(b2, {
      pool: "pool2", label: "USDC/TOK", quoteSymbol: "USDC", quoteSide: "X", quoteMint: USDC_MINT, tokenMint: "tok", tokenSymbol: "TOK", xDecimals: 6, yDecimals: 6, binStep: 20,
      activeBinId: 100, activePrice: binPriceUi(100, 20, 6, 6), tokenPriceInQuote: 1 / binPriceUi(100, 20, 6, 6), quotePriceInSol: 0.01, lowerBinId: 100, upperBinId: 104, lowerPrice: 0, upperPrice: 0,
      side: "SOL_ONLY", strategy: "Spot", amountQuote: 50, amountToken: 0, slippagePct: 0, now: T0,
    });
    assert.deepEqual(paper.depositBins(r.band), { quoteBins: [100, 101, 102, 103, 104], tokenBins: [100] });
    const snap = (active: number): Parameters<typeof paper.bandContents>[1] => ({
      activeBinId: active, activePrice: binPriceUi(active, 20, 6, 6), binStep: 20, bins: [{ binId: active, price: binPriceUi(active, 20, 6, 6), xAmount: 1, yAmount: 0, isActive: true }],
      liquidityBelowY: 0, liquidityAboveX: 100, dynamicFeePct: 0.2, solSide: null, tokenPriceInSol: 0.01 / binPriceUi(active, 20, 6, 6), quoteSide: "X", quotePriceInSol: 0.01, tokenPriceInQuote: 1 / binPriceUi(active, 20, 6, 6),
      tokenX: { decimals: 6 }, tokenY: { decimals: 6 },
    });
    near(paper.bandContents(r.band, snap(100)).amountQuote, 50, 1e-9, "all quote at open (active bin pure X)");
    const up = paper.bandContents(r.band, snap(103));
    near(up.amountQuote, 20, 1e-9, "bins 103 (pure X mix) and 104 still quote");
    let expectTok = 0;
    for (let b = 100; b <= 102; b++) expectTok += 10 * binPriceUi(b, 20, 6, 6); // 10 USDC per bin converted at the bin's Y-per-X price
    near(up.amountToken, expectTok, 1e-9, "bins below active hold token");
    near(paper.bandContents(r.band, snap(100)).amountQuote, 50, 1e-9, "back down: quote again");
  });

  console.log("paper executor and execute() delegation");
  const book2 = paper.emptyBook(100, 0, T0);
  const ctx = (snapshot: PoolSnapshot, positions: PositionSnapshot[], now: number) =>
    ({ venue: {} as never, pool: {} as never, wallet: {} as never, rawPositions: [], snapshot, positions, paper: { book: book2, slippagePct: 0.3, now } }) as Parameters<typeof execute>[1];
  let addr2 = "";
  await test("execute() with a paper context: an allowed OPEN lands in the book, mode paper, ledger row dry-run/marked/paper", async () => {
    const r = await execute(verdictOf(openDecision(1, 9)), ctx(s260, [], T0));
    assert.equal(r.mode, "paper");
    assert.equal(r.ok, true);
    assert.equal(r.txs.length, 1);
    assert.equal(r.txs[0].label, "open SOL_ONLY band bins [251, 260]");
    assert.match(r.txs[0].skipped!, /^paper: opened paper-6e7V9e-1 with 1 SOL across 10 bins/);
    assert.equal(r.opened!.address, "paper-6e7V9e-1");
    near(r.opened!.entryValueSol, 1, 1e-9);
    addr2 = r.opened!.address;
    const row = r.ledger![0];
    assert.equal(row.mode, "dry-run");
    assert.equal(row.basis, "marked");
    assert.equal(row.mech, "open");
    assert.match(row.note, /^paper/);
    near(row.quoteDelta!, -1, 1e-12);
    near(row.solDelta, -1, 1e-12);
    near(row.rentSol, -dlmm.OPEN_COST_ESTIMATE_SOL, 1e-12);
    assert.equal(row.position, addr2);
    near(book2.wallet.sol, 100 - 1 - dlmm.OPEN_COST_ESTIMATE_SOL - paper.PAPER_TX_FEE_SOL, 1e-9);
    assert.ok(fs.existsSync(path.join(tmp, "ledger.jsonl")), "the ledger file was written under DATA_DIR");
  });
  await test("HOLD and blocked verdicts never reach the book (mode none)", async () => {
    const hold: Decision = { action: "HOLD", open: null, positionAddress: null, reasoning: "", confidence: 1, headline: "" };
    assert.equal((await execute(verdictOf(hold), ctx(s260, [], T0))).mode, "none");
    assert.equal((await execute(verdictOf(openDecision(1, 9), { allowed: false, violations: ["x"] }), ctx(s260, [], T0))).mode, "none");
    assert.equal(book2.bands.length, 1);
  });
  await test("Curve strategy is laid as Spot with a note", async () => {
    const r = await execute(verdictOf(openDecision(0.5, 4, "Curve")), ctx(s260, [], T0));
    assert.match(r.txs[0].skipped!, /Curve laid as Spot/);
    assert.equal(book2.bands[1].strategy, "Curve");
    const closed = await execute(verdictOf(closeDecision(book2.bands[1].address)), ctx(s260, paper.markPool(book2, s260, { now: T0, fees: null, solPriceUsd: 100 }), T0));
    assert.equal(closed.closed, "paper-6e7V9e-2");
    assert.equal(book2.bands.length, 1);
  });
  await test("CLAIM_FEES: nothing to claim is a note; with fees it is a collect row", async () => {
    const positions = paper.markPool(book2, s260, { now: T0, fees: null, solPriceUsd: 100 });
    const claim: Decision = { action: "CLAIM_FEES", open: null, positionAddress: null, reasoning: "", confidence: 1, headline: "" };
    const none = await execute(verdictOf(claim), ctx(s260, positions, T0));
    assert.equal(none.txs.length, 0);
    assert.deepEqual(none.notes, ["nothing to claim"]);
    const marked = paper.markPool(book2, s260, { now: T0 + 3600e3, fees: { fees24hUsd: 10_000, volume24hUsd: null }, solPriceUsd: 100 });
    assert.ok(marked[0].feeY > 0);
    const r = await execute(verdictOf({ ...claim, positionAddress: addr2 }), ctx(s260, marked, T0 + 3600e3));
    assert.equal(r.txs.length, 1);
    assert.match(r.txs[0].skipped!, /^paper: claimed/);
    assert.equal(r.ledger![0].mech, "collect");
    assert.equal(r.ledger![0].position, addr2);
    near(r.ledger![0].feeSol!, book2.feesClaimedSol, 1e-9); // the tally keeps 9 decimals
    assert.equal(book2.bands[0].feeQuote, 0);
    assert.equal(book2.bands[0].feeToken, 0);
  });
  await test("CLOSE with an engine STOP reasoning records the emergency reason; the close row carries the entry", async () => {
    const s250 = snapAt(250);
    const positions = paper.markPool(book2, s250, { now: T0 + 7200e3, fees: null, solPriceUsd: 100 });
    const stop = closeDecision(addr2, "Engine directive STOP: stop: paper- is 16.0% below entry (10 -> 0.8400 SOL), stop 13.20%. The stop is the exit; it is not negotiated.", "Stop hit.");
    const v = verdictOf(stop, { emergency: true });
    assert.deepEqual(paper.closeReason(v), { reason: "STOP: stop: paper- is 16.0% below entry (10 -> 0.8400 SOL), stop 13.20%", emergency: true });
    assert.deepEqual(paper.closeReason(verdictOf(stop, { emergency: true, overrides: ["stop-loss: x"] })), { reason: "stop-loss: x", emergency: true });
    assert.deepEqual(paper.closeReason(verdictOf(stop)), { reason: "Stop hit.", emergency: false });
    const r = await execute(v, ctx(s250, positions, T0 + 7200e3));
    assert.equal(r.closed, addr2);
    assert.equal(r.mode, "paper");
    const row = r.ledger![0];
    assert.equal(row.mech, "close");
    near(row.entryValueSol!, 1, 1e-9);
    near(row.rentSol, dlmm.POSITION_RENT_SOL, 1e-12);
    assert.equal(book2.closed[1].emergency, true);
    assert.match(book2.closed[1].reason, /^STOP: /);
    assert.ok(book2.closed[1].realizedSol < 0, "closing under the band realizes the mark-down");
    assert.equal(book2.bands.length, 0);
  });
  await test("REBALANCE: closes the band and opens the fresh one in one execution", async () => {
    const r0 = await execute(verdictOf(openDecision(2, 9)), ctx(s260, [], T0 + 9000e3));
    const old = r0.opened!.address;
    const s262 = snapAt(262);
    const positions = paper.markPool(book2, s262, { now: T0 + 9600e3, fees: null, solPriceUsd: 100 });
    const reb: Decision = { action: "REBALANCE", open: { side: "SOL_ONLY", amountSol: 2, amountToken: 0, binsBelowActive: 9, binsAboveActive: 0, strategy: "Spot" }, positionAddress: old, reasoning: "", confidence: 1, headline: "" };
    const r = await execute(verdictOf(reb), ctx(s262, positions, T0 + 9600e3));
    assert.equal(r.closed, old);
    assert.equal(r.txs.length, 2);
    assert.equal(r.ledger!.length, 2);
    assert.deepEqual([book2.bands[0].lowerBinId, book2.bands[0].upperBinId], [253, 262]);
    assert.notEqual(r.opened!.address, old);
  });
  await test("a close of an unknown paper band fails cleanly", async () => {
    const r = await execute(verdictOf(closeDecision("paper-nope-9")), ctx(s260, [], T0));
    assert.equal(r.ok, false);
    assert.match(r.notes[0], /not found in the paper book/);
  });

  console.log("the ask exit in paper");
  await test("a bid band run through is closed into a TOKEN_ONLY ask band in one execution: no sale, no close slippage, the token laid from the active bin up; marked up it sells out and the close books SOL", async () => {
    const { askExitOf, askExitEnv } = await import("../engine/askExit.js");
    const b4 = paper.emptyBook(100, 0, T0);
    const c4 = (snapshot: PoolSnapshot, positions: PositionSnapshot[], now: number) =>
      ({ venue: {} as never, pool: {} as never, wallet: {} as never, rawPositions: [], snapshot, positions, paper: { book: b4, slippagePct: 0.3, now }, walletToken: paper.paperTokenBalance(b4, ANSEM) }) as Parameters<typeof execute>[1];
    // 10 SOL under bin 260; the price falls to 245: all ANSEM
    await execute(verdictOf(openDecision(10, 9)), c4(s260, [], T0));
    const run = snapAt(245);
    const [bid] = paper.markPool(b4, run, { now: T0 + 600e3, fees: null, solPriceUsd: 100 });
    assert.ok(bid.amountX > 0 && bid.amountY === 0, "the bid band holds token");
    const close = closeDecision(bid.address, "Through the band.", "9 bins through the band and 700s out. Off the table.");
    const asked = askExitOf({ ...close, liquidate: true }, { snapshot: run, positions: [bid], walletToken: 0, askBands: {}, env: askExitEnv({ EXIT_ASK: "true" }), maxBinWidth: 69 })!;
    assert.equal(asked.action, "REBALANCE");
    assert.equal(asked.open!.side, "TOKEN_ONLY");
    assert.equal(asked.open!.binsAboveActive, 15);
    near(asked.open!.amountToken, Math.floor((bid.amountX + bid.feeX) * 1e6) / 1e6, 1e-9, "the band's token incl. base fees");
    const r = await execute(verdictOf(asked), c4(run, [bid], T0 + 600e3));
    assert.equal(r.ok, true, r.notes.join("; "));
    assert.deepEqual(r.txs.map((t) => t.label.split(" ")[0]), ["close", "open"], "no swap leg");
    assert.deepEqual(r.ledger!.map((x) => x.mech), ["close", "open"]);
    assert.match(r.ledger![0].note, /into an ask band: no close slippage/);
    assert.equal(b4.closed[b4.closed.length - 1].slippageSol, 0);
    const ask = b4.bands[0];
    assert.equal(ask.side, "TOKEN_ONLY");
    assert.deepEqual([ask.lowerBinId, ask.upperBinId], [245, 260]);
    assert.ok(paper.paperTokenBalance(b4, ANSEM) < 1e-3, "the wallet's ANSEM went into the ask");
    near(r.opened!.entryValueSol, asked.open!.amountToken * p(245), 1e-6, "the ask's own entry is the mark it was laid at");
    // the price bounces over the ask: every bin sold, the band holds SOL above the bid's cost
    const [sold] = paper.markPool(b4, snapAt(262), { now: T0 + 1200e3, fees: null, solPriceUsd: 100 });
    assert.ok(sold.amountX === 0 && sold.amountY > 0, `sold out: ${sold.amountX} ANSEM, ${sold.amountY} SOL`);
    assert.ok(sold.amountY > r.opened!.entryValueSol, "sold on the way up, over the mark it was laid at");
    const done = await execute(verdictOf({ ...closeDecision(ask.address), liquidate: true }), c4(snapAt(262), [sold], T0 + 1200e3));
    assert.equal(done.ok, true);
    assert.equal(done.txs.length, 1, "a sold-out ask closes without a swap: nothing to sell");
    assert.ok(b4.wallet.sol > 100 - 0.5, `the SOL is back: ${b4.wallet.sol}`);
  });
  console.log("guards on paper positions");
  await test("the guards read a marked paper band like a chain one: close-target passes, the stop fires from the book's entry", () => {
    const b3 = paper.emptyBook(100, 0, T0);
    paper.openBand(b3, { pool: POOL, label: "ANSEM/SOL", quoteSymbol: "SOL", quoteSide: "Y", quoteMint: SOL_MINT, tokenMint: ANSEM, tokenSymbol: "ANSEM", xDecimals: 6, yDecimals: 9, binStep: 20, activeBinId: 260, activePrice: p(260), tokenPriceInQuote: p(260), quotePriceInSol: 1, lowerBinId: 251, upperBinId: 260, lowerPrice: p(251), upperPrice: p(260), side: "SOL_ONLY", strategy: "Spot", amountQuote: 10, amountToken: 0, slippagePct: 0.3, now: T0 });
    const s = snapAt(255);
    const positions = paper.markPool(b3, s, { now: T0, fees: null, solPriceUsd: 100 });
    const state: RiskState = { ...emptyState(), entryValueSol: { [positions[0].address]: positions[0].entryValueSol! } };
    const base = { now: T0, snapshot: s, positions, walletSol: b3.wallet.sol, walletToken: 0, walletQuote: b3.wallet.sol, state, killSwitch: false, otherExposureSol: 0, poolsWithBands: 0, maxActivePools: 4 };
    const v = evaluate(closeDecision(positions[0].address), { ...base, source: "engine" }, limits);
    assert.equal(v.allowed, true);
    assert.ok(v.passed.includes("close-target"));
    // a crash 100 bins down: the mark is far under the entry, the guards force the close
    const crash = snapAt(160);
    const hurt = paper.markPool(b3, crash, { now: T0, fees: null, solPriceUsd: 100 });
    const hold: Decision = { action: "HOLD", open: null, positionAddress: null, reasoning: "", confidence: 1, headline: "" };
    const forced = evaluate(hold, { ...base, snapshot: crash, positions: hurt }, limits);
    assert.equal(forced.decision.action, "CLOSE_POSITION");
    assert.ok(forced.overrides[0].startsWith("stop-loss"));
  });

  console.log("desk policy");
  const obs = (over: Partial<Observation> = {}, snapshot: PoolSnapshot = s260): Observation => ({
    ts: new Date(T0).toISOString(),
    cycle: 1,
    mode: "dry-run",
    poolLabel: snapshot.label,
    snapshot,
    positions: [],
    wallet: { address: "wallet", sol: 100, token: 0, tokenSymbol: snapshot.baseToken.symbol, quote: 100, quoteSymbol: "SOL" },
    analytics: null,
    state: { actionsToday: 0, lastActionAt: null, lastPrice: null, killSwitch: false },
    recent: [],
    screen: { rank: 5, rankedPools: 300, score: 30, feeToTvl24hPct: 2.3, volume24hUsd: 1_000_000, tvlUsd: 250_000, ageHours: 100, priceChange24hPct: 3, flags: [], generatedAt: new Date(T0).toISOString(), alternatives: [], hot: [] },
    portfolio: { activePools: ["ANSEM/SOL"], poolsWithBands: 0, maxActivePools: 4, otherExposureSol: 0 },
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
    },
    ...over,
  });
  const hotRow = (over: Partial<NonNullable<NonNullable<Observation["screen"]>["hot"]>[number]> = {}) => ({ name: "ANSEM / SOL", venue: "meteora-dlmm", tradable: true, thisPool: true, liquidityUsd: 1_400_000, vol1hUsd: 100_000, feeToTvlDailyPct: 8, acceleration: 2, priceChange1hPct: 1.5, heat: 40, flags: [], surge: true, ...over });
  const voice = (d: Decision) => {
    assert.ok(d.headline.length <= 90, `headline ${d.headline.length} chars: ${d.headline}`);
    assert.ok(!d.headline.includes("—") && !d.reasoning.includes("—"), "no em dashes");
    assert.ok(d.reasoning.split(/[.!?]\s/).length >= 2, "at least two sentences");
    assert.match(d.reasoning, /\d/, "numbers in the reasoning");
  };
  const x = { limits };
  await test("binsForCover: 5% at 20 bps is 24 bins, bounded to [1, maxBinWidth - 1] (one bin is the floor: only the active bin earns)", () => {
    assert.equal(policy.binsForCover(20, 5, 69), 24);
    assert.equal(policy.binsForCover(100, 5, 69), 5);
    assert.equal(policy.binsForCover(200, 5, 69), 2);
    // a step so wide that the cover is under one bin still gets one: a band is never zero bins
    assert.equal(policy.binsForCover(4000, 0.5, 69), 1);
    assert.equal(policy.binsForCover(1, 5, 69), 68);
    assert.equal(policy.binsForCover(5, 5, 10), 9);
    near(policy.coveragePct(20, 24), 4.91, 1e-3);
    assert.deepEqual(policy.policyEnv({}), { feeShare: { memecoin: 0.5, stock: 0.5, other: 0.5 }, feeShareN: { memecoin: 0, stock: 0, other: 0 }, feeShareWhy: {}, coverPct: 5, stockCoverPct: 1.5,
    stockGrowMinAgeMin: 15,
    stockGrowMinPct: 50,
    maxSwapImpactPct: 1.5,
    maxTravelPct: 0,
    requireFlow: false,
    minFlowCoverMin: 60,
    idleRelaySec: 0,
    maxSideSharePct: 50,
    sizeRefTravelPct: 0,
    sizeMinMultiple: 0.33, minSeatPct: 5, minSeatYieldPct: 0.4, minVolume24hUsd: 250000, maxPaybackHours: 24, minScore: 20, book: "all", volMultiple: 1, minCoverPct: 0.15, maxCoverPct: 4, stockMinCoverPct: 1, stockRecentreMaxPaybackHours: 4, stockRecentreMaxWaitSec: 7200 });
    assert.deepEqual(policy.policyEnv({ POLICY_COVER_PCT: "8", STOCK_COVER_PCT: "2", POLICY_MIN_SEAT_PCT: "2", POLICY_MIN_SCORE: "10", BOOK: "stocks" }), { feeShare: { memecoin: 0.5, stock: 0.5, other: 0.5 }, feeShareN: { memecoin: 0, stock: 0, other: 0 }, feeShareWhy: {}, coverPct: 8, stockCoverPct: 2, minSeatPct: 2, minSeatYieldPct: 0.4, minVolume24hUsd: 250000, maxPaybackHours: 24, minScore: 10, book: "stocks", volMultiple: 1, minCoverPct: 0.15, maxCoverPct: 4, stockMinCoverPct: 1, stockRecentreMaxPaybackHours: 4, stockRecentreMaxWaitSec: 7200, stockGrowMinPct: 50, stockGrowMinAgeMin: 15, maxSwapImpactPct: 1.5, maxTravelPct: 0, requireFlow: false, minFlowCoverMin: 60, idleRelaySec: 0, maxSideSharePct: 50, sizeRefTravelPct: 0, sizeMinMultiple: 0.33 });
    const tuned = policy.policyEnv({ STOCK_MIN_COVER_PCT: "0.5", STOCK_RECENTRE_MAX_PAYBACK_HOURS: "0", STOCK_RECENTRE_MAX_WAIT_MIN: "30" });
    assert.deepEqual([tuned.stockMinCoverPct, tuned.stockRecentreMaxPaybackHours, tuned.stockRecentreMaxWaitSec], [0.5, 0, 1800]);
  });
  await test("band width follows the pool's own movement, floored and capped", () => {
    // the measured travel wins over the hot list's net move: a pool that went up 3% and came back reads as 3%, not 0%
    const measured = policy.coverPctFor({ screen: { recentMovePct: 3 } as never }, policy.policyEnv({}), 5, { priceChange1hPct: 0 });
    assert.equal(measured.coverPct, 3);
    assert.match(measured.from, /1x: the price travelled 3% in the last hour/);
    const calm = policy.coverPctFor({ screen: null }, policy.policyEnv({}), 5, { priceChange1hPct: 0.2 });
    assert.equal(calm.coverPct, 0.2, "a pool that moved 0.2% in an hour gets a 0.2% band each way");
    assert.match(calm.from, /1x: the price travelled 0.2% in the last hour/);
    const tiny = policy.coverPctFor({ screen: null }, policy.policyEnv({}), 5, { priceChange1hPct: 0.01 });
    assert.equal(tiny.coverPct, 0.15, "the floor holds");
    assert.match(tiny.from, /the floor/);
    const wild = policy.coverPctFor({ screen: null }, policy.policyEnv({}), 5, { priceChange1hPct: -25 });
    assert.equal(wild.coverPct, 4, "the cap holds, and the sign of the move does not matter");
    assert.match(wild.from, /the cap/);
    const unknown = policy.coverPctFor({ screen: null }, policy.policyEnv({}), 5, { priceChange1hPct: null });
    assert.equal(unknown.coverPct, 5, "no recent move: the configured cover stands");
    assert.equal(policy.coverPctFor({ screen: null }, policy.policyEnv({ POLICY_VOL_MULTIPLE: "0" }), 5, { priceChange1hPct: 3 }).coverPct, 5, "multiple 0 turns it off");
  });

  await test("the seat must earn: a pool that pays too little per day, or takes too long to pay back its rent, is held", () => {
    const rich = { ...obs(), screen: { ...obs().screen!, tvlUsd: 1_000_000, feeToTvl24hPct: 2 } } as typeof obs extends never ? never : ReturnType<typeof obs>;
    const poorPool = { ...obs(), screen: { ...obs().screen!, tvlUsd: 1_000_000, feeToTvl24hPct: 0.01 } } as typeof rich;
    const yieldOn = { ...x, openCostSol: 0.2004, openCostRefundableSol: 0.0574 };
    // A pool paying 2% of its liquidity a day clears the floor; one paying 0.01% does not.
    assert.equal(policy.policyDecide(rich, yieldOn).branch, "open");
    const poor = policy.policyDecide(poorPool, yieldOn);
    assert.equal(poor.branch, "not-worth");
    assert.match(poor.reason, /seat yield .* under the .*% floor/);
    // The same pool with the floor off is refused by the payback test instead: the rent outlives the fees.
    const noFloor = { ...poorPool };
    process.env.POLICY_MIN_SEAT_YIELD_PCT = "0";
    const payback = policy.policyDecide(noFloor, yieldOn);
    process.env.POLICY_MIN_SEAT_YIELD_PCT = "";
    assert.equal(payback.branch, "not-worth");
    assert.match(payback.reason, /payback .*h over the .*h limit/);
  });

  await test("no band, score above the floor: OPEN a 24-bin SOL-only Spot band sized at the max band", () => {
    const r = policy.policyDecide(obs(), x);
    assert.equal(r.branch, "open");
    const d = r.decision;
    assert.equal(d.action, "OPEN_POSITION");
    assert.deepEqual(d.open, { side: "SOL_ONLY", amountSol: 22.5, amountToken: 0, binsBelowActive: 24, binsAboveActive: 0, strategy: "Spot" });
    assert.match(d.reasoning, /score 30/);
    assert.match(d.reasoning, /active bin 260/i);
    assert.match(d.reasoning, /25-bin SOL-only Spot band from the active bin down \(24 bins under it\) covers 4.91% of price/);
    assert.match(d.reasoning, /bound by max band 22.5 SOL/);
    assert.match(d.headline, /^SOL under the bid in ANSEM\/SOL\. 22.5 SOL across 25 bins\.$/);
    voice(d);
    // and the guards let it through with the 100 SOL limits
    const v = evaluate(d, { now: T0, snapshot: s260, positions: [], walletSol: 100, walletToken: 0, walletQuote: 100, state: emptyState(), killSwitch: false, otherExposureSol: 0, poolsWithBands: 0, maxActivePools: 4 }, limits);
    assert.deepEqual(v.violations, []);
  });
  await test("a hot pick off the board opens on the extras' hot row; an on-board hot row is read from the observation", () => {
    const off = policy.policyDecide(obs({ screen: null }), { ...x, hot: [{ address: POOL, priceChange1hPct: 2, flags: [], heat: 35, surge: true }] });
    assert.equal(off.branch, "open");
    assert.match(off.decision.reasoning, /hot pick \(heat 35, surge\)/);
    const on = policy.policyDecide(obs({ screen: { ...obs().screen!, score: 5, hot: [hotRow()] } }), x);
    assert.equal(on.branch, "open");
    assert.match(on.decision.reasoning, /heat 40, surge, screen score 5/);
  });
  await test("not worth: low score and not hot -> HOLD with the reason; off the screen entirely -> HOLD", () => {
    const r = policy.policyDecide(obs({ screen: { ...obs().screen!, score: 15 } }), x);
    assert.equal(r.branch, "not-worth");
    assert.equal(r.decision.action, "HOLD");
    assert.match(r.reason, /score 15 is not above 20/);
    assert.equal(r.decision.headline, "Nothing worth a band here. Holding.");
    voice(r.decision);
    assert.equal(policy.policyDecide(obs({ screen: null }), x).branch, "not-worth");
  });
  await test("flags thin/new/dumping/wild hold; the 1h move outside +/-15% holds", () => {
    const thin = policy.policyDecide(obs({ screen: { ...obs().screen!, flags: ["thin", "hot"] } }), x);
    assert.equal(thin.branch, "flagged");
    assert.equal(thin.decision.headline, "Flagged thin. Not touching it.");
    const wild = policy.policyDecide(obs({ screen: { ...obs().screen!, hot: [hotRow({ flags: ["wild"] })] } }), x);
    assert.equal(wild.branch, "flagged");
    const moved = policy.policyDecide(obs({ screen: { ...obs().screen!, hot: [hotRow({ priceChange1hPct: -22 })] } }), x);
    assert.equal(moved.branch, "moved");
    assert.match(moved.decision.reasoning, /moved -22.0%/);
    assert.equal(moved.decision.headline, "Moved -22% in an hour. Not chasing it.");
    voice(moved.decision);
    assert.equal(policy.policyDecide(obs({ screen: { ...obs().screen!, hot: [hotRow({ priceChange1hPct: 14.9 })] } }), x).branch, "open");
    // IDLE VOLUME (Zach, 18 Sep): a token in flight is not seated whatever it pays this hour; the desk waits for it to settle
    const flight = policy.policyDecide(obs({ screen: { ...obs().screen!, hot: [hotRow({ priceChange1hPct: 14.9 })] } }), { ...x, env: { maxTravelPct: 10 } });
    assert.equal(flight.branch, "lively");
    assert.match(flight.decision.reasoning, /travelled 14\.9% in the last hour, over the 10% the desk sits out/);
    assert.equal(flight.decision.headline, "In flight: 15% an hour. Waiting for idle volume.");
    voice(flight.decision);
    assert.equal(policy.policyDecide(obs({ screen: { ...obs().screen!, hot: [hotRow({ priceChange1hPct: 9 })] } }), { ...x, env: { maxTravelPct: 10 } }).branch, "open", "under the line: seated");
  });
  await test("sizing: the wallet, the depth (share <= 50%), the exposure room and the gas reserve each bound the size", () => {
    const shallow = policy.policyDecide(obs({}, snapAt(260, { liquidityBelowY: 4 })), x); // 0.4 SOL/bin x 25 bins = 10 SOL of depth
    assert.equal(shallow.decision.open!.amountSol, 10);
    assert.match(shallow.decision.reasoning, /bound by half the band's depth \(10 SOL\); our share of the band 50%/);
    // POLICY_MAX_SIDE_SHARE_PCT: a quarter of the band with ours in it is a third of what the others hold
    const quarter = policy.policyDecide(obs({}, snapAt(260, { liquidityBelowY: 12 })), { ...x, env: { maxSideSharePct: 25 } }); // 30 SOL of depth
    near(quarter.decision.open!.amountSol, 10, 1e-9);
    assert.match(quarter.decision.reasoning, /bound by 25% of the band's depth with ours in it \(30 SOL of others' there\); our share of the band 25%/);
    near(policy.depthCapQuote(10, 50), 10, 1e-12);
    near(policy.depthCapQuote(10, 25), 10 / 3, 1e-12);
    // POLICY_SIZE_REF_TRAVEL_PCT: a pool travelling 27% an hour against a 15% reference seats 0.56 of the max band; never under the floor
    near(policy.travelSizeMultiple(27, 15, 0.33), 15 / 27, 1e-12);
    assert.equal(policy.travelSizeMultiple(10, 15, 0.33), 1);
    assert.equal(policy.travelSizeMultiple(90, 15, 0.33), 0.33);
    assert.equal(policy.travelSizeMultiple(null, 15, 0.33), 1);
    assert.equal(policy.travelSizeMultiple(90, 0, 0.33), 1, "0 turns it off");
    const wild = policy.policyDecide(obs({ screen: { ...obs().screen!, recentMovePct: 14 } }), { ...x, env: { sizeRefTravelPct: 7, maxCoverPct: 25 } });
    near(wild.decision.open!.amountSol, Math.floor((limits.maxPositionSol * 0.5) * 1e4) / 1e4, 1e-9);
    assert.match(wild.decision.reasoning, /bound by 14% of hourly travel against the 7% reference: 0\.5 of the max band/);
    const poor = policy.policyDecide(obs({ wallet: { address: "w", sol: 10, token: 0, tokenSymbol: "ANSEM", quote: 10, quoteSymbol: "SOL" } }), x);
    // 10 SOL, 1 SOL reserve, rent for this seat and for the 3 seats still to open (4 pools, none held)
    near(poor.decision.open!.amountSol, Math.floor((10 - 1 - dlmm.OPEN_COST_ESTIMATE_SOL - 3 * dlmm.OPEN_COST_ESTIMATE_SOL) * 1e4) / 1e4, 1e-9);
    assert.match(poor.decision.reasoning, /bound by SOL after rent, the 1 SOL gas reserve and 0\.601 SOL of rent kept for 3 more seat\(s\)/);
    const room = policy.policyDecide(obs({ portfolio: { activePools: [], poolsWithBands: 3, maxActivePools: 4, otherExposureSol: 85 } }), x);
    near(room.decision.open!.amountSol, 5, 1e-9);
    assert.match(room.decision.reasoning, /bound by exposure room 5 SOL/);
    const half = policy.policyDecide(obs({ engine: { ...obs().engine!, sizeMultiplier: 0.5, effectiveMaxPositionSol: 11.25 } }), x);
    assert.equal(half.decision.open!.amountSol, 11.25);
    const tiny = policy.policyDecide(obs({ wallet: { address: "w", sol: 1.25, token: 0, tokenSymbol: "ANSEM", quote: 1.25, quoteSymbol: "SOL" } }), x);
    assert.equal(tiny.branch, "no-size");
    assert.match(tiny.reason, /under the minimum seat/);
  });
  await test("a USDC pool sizes in USDC, converts at the SOL price, and needs SOL for rent", () => {
    const usdcSnap = snapAt(260, {
      label: "NVDAx/USDC",
      tokenY: { mint: USDC_MINT, symbol: "USDC", decimals: 6, reserve: 1e6 },
      quoteToken: { mint: USDC_MINT, symbol: "USDC", decimals: 6, reserve: 1e6 },
      quoteSymbol: "USDC",
      solSide: null,
      quotePriceInSol: 0.01,
      tokenPriceInSol: p(260) * 0.01,
      liquidityBelowY: 9000,
    });
    const o = obs({ wallet: { address: "w", sol: 5, token: 0, tokenSymbol: "ANSEM", quote: 5000, quoteSymbol: "USDC" } }, usdcSnap);
    const r = policy.policyDecide(o, x);
    assert.equal(r.branch, "open");
    // max band 22.5 SOL = 2250 USDC; 95% of 5000 = 4750; depth 900 USDC/bin x 25 = 22500 -> the max band binds
    assert.equal(r.decision.open!.amountSol, 2250);
    assert.match(r.decision.headline, /USDC under the bid in NVDAx\/USDC\. 2250 USDC across 25 bins\./);
    const broke = policy.policyDecide(obs({ wallet: { address: "w", sol: 1.1, token: 0, tokenSymbol: "ANSEM", quote: 5000, quoteSymbol: "USDC" } }, usdcSnap), x);
    assert.equal(broke.branch, "no-size");
    assert.match(broke.reason, /gas reserve/);
  });
  await test("gates: kill switch, halt, stand-down, bench, regime off, knife, basis, cooldown, daily cap, price move, pool cap -> HOLD with the reason", () => {
    const e = obs().engine!;
    const cases: [Partial<Observation>, RegExp][] = [
      [{ state: { ...obs().state, killSwitch: true } }, /kill switch/],
      [{ engine: { ...e, halt: { until: T0 + 3600e3, stage: 1, reason: "r" } } }, /circuit breaker halt for 60 more min/],
      [{ engine: { ...e, standDown: { until: T0 + 7200e3, reason: "r" } } }, /stand-down for 120 more min/],
      [{ engine: { ...e, bench: { stops6h: 3, multiplier: 0, benched: true, reason: "benched: 3 stops" } } }, /benched: 3 stops/],
      [{ engine: { ...e, sizeMultiplier: 0, regime: { medianMove24hPct: -20, multiplier: 0, reason: "regime: opens off" } } }, /regime: opens off/],
      [{ engine: { ...e, knife: "knife: -25.0% in 30 min" } }, /knife/],
      [{ engine: { ...e, basis: { session: "closed", minutesToOpen: 400, basisPct: 3, perpSymbol: "NVDA", perpMid: 1, widthMultiplier: 2, reason: "basis: market closed" } } }, /basis: market closed/],
      [{ state: { ...obs().state, lastActionAt: T0 - 100e3, lastMoveAt: T0 - 100e3 } }, /cooldown: 100s since the last band move in this pool, minimum 600s/],
      [{ state: { ...obs().state, actionsToday: 24 } }, /daily action cap reached \(24\/24\)/],
      [{ state: { ...obs().state, lastPrice: p(260) / 2 } }, /price moved 100.0% since the last cycle/],
      [{ portfolio: { activePools: [], poolsWithBands: 4, maxActivePools: 4, otherExposureSol: 80 } }, /pool cap 4\/4/],
    ];
    for (const [over, re] of cases) {
      const r = policy.policyDecide(obs(over), x);
      assert.equal(r.decision.action, "HOLD", `${re}`);
      assert.equal(r.branch, "gated");
      assert.match(r.reason, re);
      voice(r.decision);
    }
  });
  const paperPos = (active: number, over: Partial<PositionSnapshot> = {}): { pos: PositionSnapshot; snap: PoolSnapshot } => {
    const b = paper.emptyBook(100, 0, T0);
    paper.openBand(b, { pool: POOL, label: "ANSEM/SOL", quoteSymbol: "SOL", quoteSide: "Y", quoteMint: SOL_MINT, tokenMint: ANSEM, tokenSymbol: "ANSEM", xDecimals: 6, yDecimals: 9, binStep: 20, activeBinId: 260, activePrice: p(260), tokenPriceInQuote: p(260), quotePriceInSol: 1, lowerBinId: 236, upperBinId: 260, lowerPrice: p(236), upperPrice: p(260), side: "SOL_ONLY", strategy: "Spot", amountQuote: 20, amountToken: 0, slippagePct: 0.3, now: T0 - 3600e3 });
    const snap = snapAt(active);
    const [pos] = paper.markPool(b, snap, { now: T0, fees: null, solPriceUsd: 100 });
    return { pos: { ...pos, ...over }, snap };
  };
  await test("band in range: HOLD", () => {
    const { pos, snap } = paperPos(250);
    const r = policy.policyDecide(obs({ positions: [pos] }, snap), x);
    assert.equal(r.branch, "in-range");
    assert.equal(r.decision.action, "HOLD");
    assert.equal(r.decision.headline, "In range. Fees ticking. Nothing to do.");
    assert.match(r.decision.reasoning, /covers bins \[236, 260\] and the active bin 250/);
    voice(r.decision);
  });
  await test("price through the band: HOLD under the engine minimum, CLOSE past it when not hot", () => {
    const { pos, snap } = paperPos(230);
    const e = obs().engine!;
    const wait = policy.policyDecide(obs({ positions: [pos], engine: { ...e, outOfRangeSec: { [pos.address]: 100 } } }, snap), x);
    assert.equal(wait.branch, "churn-wait");
    assert.equal(wait.decision.action, "HOLD");
    assert.match(wait.decision.reasoning, /6 bins below band paper- \[236, 260\]/);
    assert.match(wait.decision.reasoning, /Out of range 100s against the engine minimum 600s/);
    const close = policy.policyDecide(obs({ positions: [pos], engine: { ...e, outOfRangeSec: { [pos.address]: 700 } } }, snap), x);
    assert.equal(close.branch, "close");
    assert.equal(close.decision.action, "CLOSE_POSITION");
    assert.equal(close.decision.positionAddress, pos.address);
    assert.match(close.decision.reasoning, /for 700s, past the 600s minimum/);
    assert.match(close.decision.reasoning, /The pool is not on the hot list; closing/);
    assert.equal(close.decision.headline, "6 bins through the band and 700s out. Off the table.");
    voice(close.decision);
  });
  await test("a band already down half its stop leaves without the out-of-range wait and without a hot pool's extra cycle, as the guards already allow", () => {
    const e = obs().engine!;
    const shallow = paperPos(230); // about 3.5% down: the wait stands
    assert.equal(policy.policyDecide(obs({ positions: [shallow.pos], engine: { ...e, outOfRangeSec: { [shallow.pos.address]: 100 } } }, shallow.snap), x).branch, "churn-wait");
    const deepPos = paperPos(200); // 48 bins under the band's middle at 0.2% a bin: about 9% down against a 15% stop
    const dd = (1 - deepPos.pos.valueInSol / deepPos.pos.entryValueSol!) * 100;
    assert.ok(dd >= 7.5 && dd < 15, `drawdown ${dd}`);
    const early = policy.policyDecide(obs({ positions: [deepPos.pos], engine: { ...e, outOfRangeSec: { [deepPos.pos.address]: 100 } } }, deepPos.snap), x);
    assert.equal(early.branch, "close", early.reason);
    assert.equal(early.decision.action, "CLOSE_POSITION");
    assert.match(early.decision.reasoning, /under the 600s minimum but \d+(\.\d)?% down, past half its 15% stop: not churn/);
    assert.match(early.reason, /% down \(half the stop\), not hot$/);
    voice(early.decision);
    // a rolled stop is the one halved
    assert.equal(policy.policyDecide(obs({ positions: [deepPos.pos], engine: { ...e, stops: { [deepPos.pos.address]: 25 }, outOfRangeSec: { [deepPos.pos.address]: 100 } } }, deepPos.snap), { ...x, limits: { ...limits, stopLossPct: 30 } }).branch, "churn-wait", "9% is not half of a 25% stop");
    // on a hot pool it gets no extra cycle that deep
    const hotDeep = policy.policyDecide(obs({ positions: [deepPos.pos], engine: { ...e, outOfRangeSec: { [deepPos.pos.address]: 700 } }, screen: { ...obs().screen!, hot: [hotRow()] } }, deepPos.snap), x);
    assert.equal(hotDeep.branch, "close");
    assert.match(hotDeep.decision.reasoning, /a band this far down gets no extra cycle/);
  });

  await test("price through the band on a hot pool: HOLD one more cycle, then CLOSE on the next (the cycle is spent by the state's stamp, never by a journal headline)", async () => {
    const { pos, snap } = paperPos(230);
    const e = obs().engine!;
    const hotObs = obs({ positions: [pos], engine: { ...e, outOfRangeSec: { [pos.address]: 700 } }, screen: { ...obs().screen!, hot: [hotRow()] } }, snap);
    const first = policy.policyDecide(hotObs, x);
    assert.equal(first.branch, "hot-hold");
    assert.equal(first.decision.headline, policy.HOT_HOLD_HEADLINE);
    assert.match(first.decision.reasoning, /heat 40, 1h \+1.5%/);
    // the journal as runPool writes it: the headline in his voice. The policy used to compare that to the constant,
    // which never matched after 15 Sep, and a hot pool got its "one more cycle" every cycle (ALLINU/SOL, twice running)
    const { voiceLine } = await import("../agent/voice.js");
    const journalled = { ts: "", action: "HOLD", allowed: true, headline: voiceLine(first.decision.headline), violations: [] };
    assert.notEqual(journalled.headline, policy.HOT_HOLD_HEADLINE, "the journal rewrites the headline");
    // the next cycle, 300 s on: the loop stamped RiskState.hotHeldAt when the policy answered hot-hold
    const next = { ...hotObs, ts: new Date(T0 + 300e3).toISOString(), recent: [journalled], state: { ...hotObs.state, hotHeldAt: { [pos.address]: T0 } }, engine: { ...e, outOfRangeSec: { [pos.address]: 1000 } } };
    const second = policy.policyDecide(next, x);
    assert.equal(second.branch, "close");
    assert.equal(second.decision.action, "CLOSE_POSITION");
    assert.match(second.decision.reasoning, /still hot but already had its extra cycle/);
    // the journal alone (no stamp) is what the desk read before: it held again, and again
    assert.equal(policy.policyDecide({ ...next, state: hotObs.state }, x).branch, "hot-hold", "the old reading: another extra cycle");
    // a stamp from an earlier spell out of range (the band came back in range since) does not spend this spell's cycle
    assert.equal(policy.policyDecide({ ...next, state: { ...hotObs.state, hotHeldAt: { [pos.address]: T0 - 3600e3 } } }, x).branch, "hot-hold");
    // the state carries it: loadState keeps it, forgetBand drops it with the band
    const { forgetBand } = await import("../engine/exit.js");
    const st: RiskState = { ...emptyState(), entryValueSol: { [pos.address]: 20 }, hotHeldAt: { [pos.address]: T0 } };
    forgetBand(st, pos.address);
    assert.deepEqual(st.hotHeldAt, {});
  });

  await test("the pool's own hot row reaches the policy whatever its flags: dumping or wild holds, the 1h move holds, and a flagged row is no hot pick and buys no extra cycle", async () => {
    const { hotContextFor, hotPicks, hotPicksWithOwn } = await import("../hot/index.js");
    const OTHER = "OtherPooL11111111111111111111111111111111111";
    const row = (over: Record<string, unknown> = {}) => ({ address: POOL, name: "ANSEM / SOL", venue: "meteora-dlmm", quoteSymbol: "SOL", baseMint: ANSEM, baseSymbol: "ANSEM", liquidityUsd: 1_400_000, vol1hUsd: 400_000, vol24hUsd: 2_000_000, feeToTvlDailyPct: 80, acceleration: 3, priceChange1hPct: -20, sellShare1h: 0.8, ageHours: 2000, heat: 30, flags: ["dumping", "wild"], surge: true, ...over });
    const other = row({ address: OTHER, name: "OTHER / SOL", priceChange1hPct: 2, flags: [], heat: 50 });
    const file = (rows: unknown[]) => ({ generatedAt: new Date(T0).toISOString(), tickMs: 0, sources: { trending: 0, dexscreener: 0, onchainReads: 0, errors: [] }, rows }) as never;
    const hot = file([row(), other]);
    // the pick rule is unchanged: a pool flagged dumping and wild is not picked
    assert.deepEqual(hotPicks(hot, { tradable: () => true, max: 8 }).map((r) => r.address), [OTHER]);
    const ctx = hotContextFor(hot, POOL, () => true, { tradable: () => true, max: 8 });
    const own = ctx.find((h) => h.thisPool)!;
    assert.equal(own.pick, false);
    assert.deepEqual(own.flags, ["dumping", "wild"]);
    assert.equal(ctx.find((h) => !h.thisPool)!.pick, true);
    // a board pool scoring 30 with that row holds as flagged; the loop's old list never carried the row, and it opened
    const r = policy.policyDecide(obs({ screen: { ...obs().screen!, hot: ctx } }), x);
    assert.equal(r.branch, "flagged");
    assert.match(r.reason, /flagged dumping, wild/);
    assert.match(r.decision.reasoning, /the hot watch reads heat 30, 1h move -20\.0% \[dumping, wild\], off the tradable list/);
    voice(r.decision);
    assert.equal(policy.policyDecide(obs({ screen: { ...obs().screen!, hot: ctx.filter((h) => h.pick) } }), x).branch, "open", "without its own row the same pool opened");
    // off the board the policy's extras carry it the same way
    assert.equal(policy.policyDecide(obs({ screen: null }), { ...x, hot: hotPicksWithOwn(hot, POOL, { tradable: () => true, max: 8 }) }).branch, "flagged");
    // the last hour's move: an unflagged row under the hot list's liquidity floor (so not a pick) that moved 22%
    const moved = policy.policyDecide(obs({ screen: { ...obs().screen!, hot: hotContextFor(file([row({ flags: [], priceChange1hPct: -22, liquidityUsd: 1_000 }), other]), POOL, () => true, { tradable: () => true, max: 8 }) } }), x);
    assert.equal(moved.branch, "moved");
    assert.match(moved.reason, /1h move -22\.0% outside \+\/-15%/);
    // a row that is not a pick is no hot pick: a score under the floor is not rescued by it
    const unpicked = hotContextFor(file([row({ flags: ["fading"], priceChange1hPct: 1, liquidityUsd: 1_000 })]), POOL, () => true, { tradable: () => true, max: 8 });
    assert.equal(policy.policyDecide(obs({ screen: { ...obs().screen!, score: 5, hot: unpicked } }), x).branch, "not-worth");
    // and a band the price went through, in a pool the hot watch flags dumping, gets no extra cycle: it is not on the list
    const { pos, snap } = paperPos(230);
    const through = policy.policyDecide(obs({ positions: [pos], engine: { ...obs().engine!, outOfRangeSec: { [pos.address]: 700 } }, screen: { ...obs().screen!, hot: ctx } }, snap), x);
    assert.equal(through.branch, "close");
    assert.match(through.decision.reasoning, /The pool is not on the hot list; closing/);
  });
  await test("a tradable pick behind eight Raydium and Orca rows is still a hot pick: the own row's pick is the tradable list's, and the policy reads either list", async () => {
    const { hotContextFor, hotPicks, hotPicksWithOwn } = await import("../hot/index.js");
    const { formatObservation } = await import("../agent/observation.js");
    const row = (address: string, venue: string, heat: number) => ({ address, name: `${venue} pool`, venue, quoteSymbol: "SOL", baseMint: address, baseSymbol: "X", liquidityUsd: 500_000, vol1hUsd: 200_000, vol24hUsd: 2_000_000, feeToTvlDailyPct: 10, acceleration: 2, priceChange1hPct: 2, sellShare1h: 0.5, ageHours: 500, heat, flags: [], surge: true });
    const others = Array.from({ length: 8 }, (_, i) => row(`Ray${i}PooL1111111111111111111111111111111111`, i % 2 ? "raydium-clmm" : "orca-whirlpool", 60 - i));
    const hot = { generatedAt: new Date(T0).toISOString(), tickMs: 0, sources: { trending: 0, dexscreener: 0, onchainReads: 0, errors: [] }, rows: [...others, row(POOL, "meteora-dlmm", 40)] } as never;
    // the desk trades meteora-dlmm only: its tradable list picks this pool, the every-venue top 8 does not hold it
    const tradable = { tradable: (r: { venue: string }) => r.venue === "meteora-dlmm", max: 8 };
    assert.deepEqual(hotPicks(hot, tradable).map((r) => r.address), [POOL]);
    assert.ok(!hotPicks(hot, { tradable: () => true, max: 8 }).some((r) => r.address === POOL));
    const ctx = hotContextFor(hot, POOL, (v) => v === "meteora-dlmm", tradable);
    assert.equal(ctx.length, 9, "the every-venue top 8 and this pool's own row");
    assert.equal(ctx.find((h) => h.thisPool)!.pick, true, "a pick of the tradable list");
    const xs = { ...x, hot: hotPicksWithOwn(hot, POOL, tradable) };
    assert.doesNotMatch(formatObservation(obs({ screen: { ...obs().screen!, hot: ctx } })), /THIS POOL: .*not on the tradable list/);
    // a band the price went through, 700 s out: the hot pick's one more cycle
    const { pos, snap } = paperPos(230);
    const through = policy.policyDecide(obs({ positions: [pos], engine: { ...obs().engine!, outOfRangeSec: { [pos.address]: 700 } }, screen: { ...obs().screen!, hot: ctx } }, snap), xs);
    assert.equal(through.branch, "hot-hold", through.reason);
    // no band and a score of 15, under the floor of 20: it opens as a hot pick
    const fresh = policy.policyDecide(obs({ screen: { ...obs().screen!, score: 15, hot: ctx } }), xs);
    assert.equal(fresh.branch, "open", fresh.reason);
    assert.equal(fresh.decision.action, "OPEN_POSITION");
    // the list as a300bf9 built it (the own row off the every-venue top 8, pick false): the extras still carry the
    // pick, and on the list is what either says; without them the pool is refused, as a flagged row is
    const stale = ctx.map((h) => (h.thisPool ? { ...h, pick: false } : h));
    assert.equal(policy.policyDecide(obs({ screen: { ...obs().screen!, score: 15, hot: stale } }), xs).branch, "open");
    assert.equal(policy.policyDecide(obs({ screen: { ...obs().screen!, score: 15, hot: stale } }), x).branch, "not-worth");
    assert.equal(policy.policyDecide(obs({ positions: [pos], engine: { ...obs().engine!, outOfRangeSec: { [pos.address]: 700 } }, screen: { ...obs().screen!, hot: stale } }, snap), xs).branch, "hot-hold");
  });
  await test("policy: an ask band holds while working, closes at once when sold out, waits under the price then follows it down, and is pulled under the kill switch", async () => {
    const { askExitEnv, askBandRecord } = await import("../engine/askExit.js");
    const aenv = askExitEnv({ EXIT_ASK: "true", EXIT_ASK_RELAY_SEC: "180" });
    const b5 = paper.emptyBook(100, 0, T0);
    paper.openBand(b5, { pool: POOL, label: "ANSEM/SOL", quoteSymbol: "SOL", quoteSide: "Y", quoteMint: SOL_MINT, tokenMint: ANSEM, tokenSymbol: "ANSEM", xDecimals: 6, yDecimals: 9, binStep: 20, activeBinId: 245, activePrice: p(245), tokenPriceInQuote: p(245), quotePriceInSol: 1, lowerBinId: 245, upperBinId: 260, lowerPrice: p(245), upperPrice: p(260), side: "TOKEN_ONLY", strategy: "Spot", amountQuote: 0, amountToken: 0, slippagePct: 0.3, now: T0 - 600e3 });
    const at = (active: number) => {
      const snap = snapAt(active);
      const [pos] = paper.markPool(b5, snap, { now: T0, fees: null, solPriceUsd: 100 });
      return { pos, snap };
    };
    const working = at(252);
    const record = askBandRecord(undefined, { pool: POOL, from: "paper-bid", tokens: working.pos.amountX + working.pos.amountY / p(252), markSol: 12, now: T0 - 600e3 });
    const ax = { ...x, askExit: { bands: { [working.pos.address]: record }, env: aenv } };
    const e = obs().engine!;
    const inRange = policy.policyDecide(obs({ positions: [working.pos] }, working.snap), ax);
    assert.equal(inRange.branch, "ask-working");
    assert.equal(inRange.decision.action, "HOLD");
    assert.match(inRange.decision.reasoning, /being bought out bin by bin/);
    const soldOut = at(263);
    const sold = policy.policyDecide(obs({ positions: [soldOut.pos], engine: { ...e, outOfRangeSec: { [soldOut.pos.address]: 5 } } }, soldOut.snap), ax);
    assert.equal(sold.branch, "ask-sold");
    assert.equal(sold.decision.action, "CLOSE_POSITION");
    assert.equal(sold.decision.positionAddress, soldOut.pos.address);
    assert.match(sold.decision.headline, /^Sold out through the ask\./);
    const under = at(240);
    const wait = policy.policyDecide(obs({ positions: [under.pos], engine: { ...e, outOfRangeSec: { [under.pos.address]: 100 } } }, under.snap), ax);
    assert.equal(wait.branch, "ask-wait");
    assert.equal(wait.decision.action, "HOLD");
    assert.match(wait.decision.reasoning, /follows the price after 180s/);
    const relay = policy.policyDecide(obs({ positions: [under.pos], wallet: { ...obs().wallet, token: 3 }, engine: { ...e, outOfRangeSec: { [under.pos.address]: 200 } } }, under.snap), ax);
    assert.equal(relay.branch, "ask-relay");
    assert.equal(relay.decision.action, "REBALANCE");
    assert.equal(relay.decision.exitAsk, true);
    assert.equal(relay.decision.open!.side, "TOKEN_ONLY");
    assert.deepEqual([relay.decision.open!.binsBelowActive, relay.decision.open!.binsAboveActive], [0, 15]);
    near(relay.decision.open!.amountToken, Math.floor((under.pos.amountX + under.pos.feeX + 3) * 1e6) / 1e6, 1e-9, "the band's token, its base fees and the wallet's");
    assert.match(relay.decision.headline, /Following it down\.$/);
    const killed = policy.policyDecide(obs({ positions: [under.pos], state: { ...obs().state, killSwitch: true }, engine: { ...e, outOfRangeSec: { [under.pos.address]: 200 } } }, under.snap), ax);
    assert.equal(killed.branch, "ask-pulled");
    assert.equal(killed.decision.action, "CLOSE_POSITION");
    assert.equal(killed.decision.liquidate, true);
    // without a record the same band is judged as any other
    assert.equal(policy.policyDecide(obs({ positions: [working.pos] }, working.snap), x).branch, "in-range");
    for (const d of [inRange, sold, wait, relay, killed]) voice(d.decision);
  });
  await test("policy: with the ask exit on, a band the price fell through waits the ask's re-lay wait (not the paid-move minimum) and skips the hot-pool grace cycle before its close", async () => {
    const { askExitEnv } = await import("../engine/askExit.js");
    const ax = { ...x, askExit: { bands: {}, env: askExitEnv({ EXIT_ASK: "true", EXIT_ASK_RELAY_SEC: "180" }) } };
    const { pos, snap } = paperPos(230);
    const e = obs().engine!;
    const wait = policy.policyDecide(obs({ positions: [pos], engine: { ...e, minOutOfRangeSec: 2400, outOfRangeSec: { [pos.address]: 100 } } }, snap), ax);
    assert.equal(wait.branch, "churn-wait");
    assert.match(wait.reason, /100s < 180s minimum/);
    assert.match(wait.decision.reasoning, /the 180s the ask exit waits before laying the token at the price/);
    const close = policy.policyDecide(obs({ positions: [pos], engine: { ...e, minOutOfRangeSec: 2400, outOfRangeSec: { [pos.address]: 200 } }, screen: { ...obs().screen!, hot: [hotRow()] } }, snap), ax);
    assert.equal(close.branch, "close", "no hot-hold cycle: the ask at the price catches the bounce");
    assert.equal(close.decision.action, "CLOSE_POSITION");
    assert.match(close.decision.reasoning, /past the 180s minimum.*The token comes off this band\./);
    // off: the paid-move minimum and the hot-pool grace stand
    const off = policy.policyDecide(obs({ positions: [pos], engine: { ...e, minOutOfRangeSec: 2400, outOfRangeSec: { [pos.address]: 200 } } }, snap), x);
    assert.equal(off.branch, "churn-wait");
    voice(wait.decision);
    voice(close.decision);
  });
  await test("adviseWithPolicy: the model may not end an ask chain with a sale while the policy has it working; a model close of a sold-out ask stands", async () => {
    const { adviseWithPolicy } = await import("../agent/decide.js");
    const modelClose: Decision = { action: "CLOSE_POSITION", open: null, positionAddress: "ask1", liquidate: true, reasoning: "Get out.", confidence: 0.6, headline: "Out." };
    const relay: Decision = { action: "REBALANCE", open: { side: "TOKEN_ONLY", amountSol: 0, amountToken: 10, binsBelowActive: 0, binsAboveActive: 15, strategy: "Spot" }, positionAddress: "ask1", exitAsk: true, reasoning: "Following it down.", confidence: 0.7, headline: "Following it down." };
    const kept = adviseWithPolicy(modelClose, { decision: relay, reason: "ask band re-laid", branch: "ask-relay" });
    assert.equal(kept.decision.action, "REBALANCE");
    assert.equal(kept.decision.exitAsk, true);
    assert.match(kept.note!, /model CLOSE of an ask band replaced/);
    const sold = adviseWithPolicy(modelClose, { decision: { ...modelClose, headline: "Sold out through the ask." }, reason: "sold", branch: "ask-sold" });
    assert.equal(sold.decision.headline, "Out.", "the model's own close stands when the policy closes too");
    // a model REBALANCE takes the policy's ask re-lay, exitAsk included
    const modelIn: Decision = { ...relay, exitAsk: undefined, reasoning: "Re-lay it." };
    assert.equal(adviseWithPolicy(modelIn, { decision: relay, reason: "ask band re-laid", branch: "ask-relay" }).decision.exitAsk, true);
  });

  await test("the scout's travel sets the width: the larger of the hour and half the four hours; the tuner's multiple applies to pools that are not stocks; entry waits for an hour of coverage", () => {
    const flow = { asOf: Date.now(), quoteSymbol: "SOL", swaps15m: 5, volume15mQuote: 1, fees15mQuote: 0.01, ours15mQuote: 0, swaps60m: 10, volume60mQuote: 4, fees60mQuote: 0.04, ours60mQuote: 0, swaps240m: 40, fees240mQuote: 0.2, coveredMin: 240, feesPerDayQuote240m: 1.2, range60mBins: 6, range240mBins: 13, feesPerDayQuote60m: 0.96, feesPerDayQuote15m: 0.96, lastPrice: null, lastSwapAt: null, largest15m: null };
    const wide = { ...policy.policyEnv({}), maxCoverPct: 25 };
    // GP/SOL on 2026-09-17: 6 bins in the hour, 13 in four -> 6.5 bins of 1% = 6.68% of price
    const gp = policy.coverPctFor({ screen: { flow } as never, snapshot: { binStep: 100 } }, wide, 5, { priceChange1hPct: null });
    assert.ok(Math.abs(gp.coverPct - (Math.pow(1.01, 6.5) - 1) * 100) < 1e-9, `cover ${gp.coverPct}`);
    assert.match(gp.from, /1x: the price travelled 6\.68% \(6 bins in the last hour's swaps, 13 in four hours\)/);
    const busyHour = policy.coverPctFor({ screen: { flow: { ...flow, range60mBins: 24 } } as never, snapshot: { binStep: 100 } }, wide, 5, { priceChange1hPct: null });
    assert.ok(Math.abs(busyHour.coverPct - 25) < 1e-9, "24 bins of 1% is 26.97%: the 25% cap");
    const tuned = policy.coverPctFor({ screen: { flow } as never, snapshot: { binStep: 100 } }, { ...wide, tunedVolMultiple: 1.25 }, 5, { priceChange1hPct: null });
    assert.ok(Math.abs(tuned.coverPct - (Math.pow(1.01, 6.5) - 1) * 100 * 1.25) < 1e-9, "a memecoin pool takes the tuner's multiple");
    const stock = policy.coverPctFor({ screen: { flow, stock: { ticker: "NVDA", issuer: "xstocks" } } as never, snapshot: { binStep: 100 } }, { ...wide, tunedVolMultiple: 1.25 }, 5, { priceChange1hPct: null });
    assert.ok(Math.abs(stock.coverPct - (Math.pow(1.01, 6.5) - 1) * 100) < 1e-9, "a stock pool keeps the configured multiple");
    const measuredWins = policy.coverPctFor({ screen: { flow, recentMovePct: 12 } as never, snapshot: { binStep: 100 } }, wide, 5, { priceChange1hPct: null });
    assert.equal(measuredWins.coverPct, 12, "the loop's own samples count when they saw more travel");
    const floor = policy.coverPctFor({ screen: { flow: { ...flow, range60mBins: 0, range240mBins: 1 } } as never, snapshot: { binStep: 100 } }, { ...wide, minCoverPct: 3 }, 5, { priceChange1hPct: null });
    assert.equal(floor.coverPct, 3, "a quiet hour still lays POLICY_MIN_COVER_PCT");
    // the entry gate: no reading, a short reading, an hour of it; a pick off the board carries its reading on the observation
    const gated = { ...x, env: { requireFlow: true, minSeatYieldPct: 0, minScore: 0 } };
    const none = policy.policyDecide(obs({}), gated);
    assert.equal(none.branch, "flow-wait");
    assert.match(none.reason, /has not read the pool yet/);
    const short = policy.policyDecide(obs({ screen: { ...obs().screen!, flow: { ...flow, coveredMin: 18 } } }), gated);
    assert.equal(short.branch, "flow-wait");
    assert.match(short.reason, /covers 18 min < 60/);
    assert.equal(short.decision.headline, "18 min of the scout's reading, 60 wanted. Waiting.");
    assert.notEqual(policy.policyDecide(obs({ screen: { ...obs().screen!, flow } }), gated).branch, "flow-wait");
    assert.notEqual(policy.policyDecide(obs({ screen: null, flow }), gated).branch, "flow-wait", "off the board: the reading rides on the observation");
  });
  await test("price above the band (idle quote): HOLD under 3x the minimum, REBALANCE past it, CLOSE when a fresh band is gated", () => {
    const { pos, snap } = paperPos(263);
    const e = obs().engine!;
    // POLICY_IDLE_RELAY_SEC: an all-quote band follows the price after two cycles, not 3x the minimum
    const quick = { ...x, env: { idleRelaySec: 600 } };
    const soon = policy.policyDecide(obs({ positions: [pos], engine: { ...e, outOfRangeSec: { [pos.address]: 500 } } }, snap), quick);
    assert.equal(soon.branch, "idle-wait");
    assert.match(soon.decision.reasoning, /Idle 500s of the 600s \(an all-quote band follows the price without a swap, POLICY_IDLE_RELAY_SEC\)/);
    const relaid = policy.policyDecide(obs({ positions: [pos], wallet: { address: "w", sol: 50, token: 0, tokenSymbol: "ANSEM", quote: 50, quoteSymbol: "SOL" }, engine: { ...e, outOfRangeSec: { [pos.address]: 700 } } }, snap), quick);
    assert.equal(relaid.branch, "rebalance", relaid.reason);
    const wait = policy.policyDecide(obs({ positions: [pos], engine: { ...e, outOfRangeSec: { [pos.address]: 1000 } } }, snap), x);
    assert.equal(wait.branch, "idle-wait");
    assert.match(wait.decision.reasoning, /3 bins above band .* Idle 1000s of the 1800s/);
    assert.equal(wait.decision.headline, "Price ran off the top. Idle 1000s, waiting.");
    const reb = policy.policyDecide(obs({ positions: [pos], wallet: { address: "w", sol: 50, token: 0, tokenSymbol: "ANSEM", quote: 50, quoteSymbol: "SOL" }, engine: { ...e, outOfRangeSec: { [pos.address]: 2000 } } }, snap), x);
    assert.equal(reb.branch, "rebalance");
    assert.equal(reb.decision.action, "REBALANCE");
    assert.equal(reb.decision.positionAddress, pos.address);
    assert.deepEqual(reb.decision.open, { side: "SOL_ONLY", amountSol: 22.5, amountToken: 0, binsBelowActive: 24, binsAboveActive: 0, strategy: "Spot" });
    assert.match(reb.decision.reasoning, /Re-laying 22.5 SOL \(22.5 SOL\) as a 25-bin SOL-only band from bin 263 down \(24 bins under it\)/);
    voice(reb.decision);
    // the guards accept it: the closing band's SOL counts toward the deposit
    const state: RiskState = { ...emptyState(), entryValueSol: { [pos.address]: pos.entryValueSol! } };
    const v = evaluate(reb.decision, { now: T0, snapshot: snap, positions: [pos], walletSol: 50, walletToken: 0, walletQuote: 50, state, killSwitch: false, otherExposureSol: 0, poolsWithBands: 0, maxActivePools: 4, engine: { haltedUntil: null, standDownUntil: null, sizeMultiplier: 1, benched: false, benchReason: null, regimeReason: null, knife: null, outOfRangeSince: { [pos.address]: T0 - 2000e3 }, stops: {}, outOfRangeSec: 600 } }, limits);
    assert.deepEqual(v.violations, []);
    const gated = policy.policyDecide(obs({ positions: [pos], engine: { ...e, knife: "knife: -30.0% in 30 min", outOfRangeSec: { [pos.address]: 2000 } } }, snap), x);
    assert.equal(gated.branch, "close");
    assert.equal(gated.decision.action, "CLOSE_POSITION");
    assert.match(gated.decision.reasoning, /A fresh band is off \(knife: -30.0% in 30 min\)/);
  });
  await test("an idle re-lay is a fresh open: it passes the entry rules a pool with no band would, or the band comes off; the scout's wait holds it", async () => {
    const { pos, snap } = paperPos(263);
    const e = obs().engine!;
    const idle = (over: Partial<Observation> = {}): Observation => obs({ positions: [pos], wallet: { address: "w", sol: 50, token: 0, tokenSymbol: "ANSEM", quote: 50, quoteSymbol: "SOL" }, engine: { ...e, outOfRangeSec: { [pos.address]: 2000 } }, ...over }, snap);
    assert.equal(policy.policyDecide(idle(), x).branch, "rebalance", "a pool the rules would open is re-laid");
    // CARDS/SOL in the pump (the scenario harness, 22 Sep): every one of these re-laid a full seat
    const cases: [Partial<Observation>, string, RegExp][] = [
      [{ screen: { ...obs().screen!, score: 8.7 } }, "not-worth", /score 8\.7 is not above 20/],
      [{ screen: { ...obs().screen!, hot: [hotRow({ flags: ["wild", "dumping"], pick: false })] } }, "flagged", /flagged wild, dumping/],
      [{ screen: { ...obs().screen!, volume24hUsd: 50_000 } }, "not-worth", /24h volume \$50000 under the \$250000 floor/],
      [{ screen: { ...obs().screen!, hot: [hotRow({ priceChange1hPct: 40 })] } }, "moved", /1h move \+40\.0% outside \+\/-15%/],
      [{ screen: { ...obs().screen!, tvlUsd: 1_000_000, feeToTvl24hPct: 0.01 } }, "not-worth", /seat yield .* under the 0\.4% floor/],
    ];
    for (const [over, branch, re] of cases) {
      const r = policy.policyDecide(idle(over), x);
      assert.equal(r.decision.action, "CLOSE_POSITION", `${branch}: ${r.branch} ${r.reason}`);
      assert.equal(r.branch, "close");
      assert.equal(r.decision.positionAddress, pos.address);
      assert.equal(r.decision.liquidate, true);
      assert.match(r.reason, new RegExp(`re-lay refused by the entry rules \\(${branch}\\)`));
      assert.match(r.reason, re);
      assert.match(r.decision.reasoning, /A re-lay is a fresh open, and the entry rules refuse one here/);
      voice(r.decision);
      // the same pool with no band is refused by the very same rule
      const fresh = policy.policyDecide(obs({ ...over }), x);
      assert.equal(fresh.branch, branch, `no band: ${fresh.reason}`);
    }
    // a wait is not a verdict: the band stays as it is until the scout has read the pool long enough
    const flow = { asOf: Date.now(), quoteSymbol: "SOL", swaps15m: 5, volume15mQuote: 1, fees15mQuote: 0.01, ours15mQuote: 0, swaps60m: 10, volume60mQuote: 4, fees60mQuote: 0.04, ours60mQuote: 0, swaps240m: 40, fees240mQuote: 0.2, coveredMin: 18, feesPerDayQuote240m: 1.2, range60mBins: 6, range240mBins: 13, feesPerDayQuote60m: 0.96, feesPerDayQuote15m: 0.96, lastPrice: null, lastSwapAt: null, largest15m: null };
    const waiting = policy.policyDecide(idle({ screen: { ...obs().screen!, flow } }), { ...x, env: { requireFlow: true } });
    assert.equal(waiting.decision.action, "HOLD");
    assert.equal(waiting.branch, "flow-wait");
    assert.match(waiting.reason, /re-lay waits: the scout's reading covers 18 min < 60/);
    // the model's re-lay meets the same refusal: the desk policy's entry rules bind it (adviseWithPolicy)
    const { adviseWithPolicy } = await import("../agent/decide.js");
    const modelRelay: Decision = { action: "REBALANCE", open: { side: "SOL_ONLY", amountSol: 22.5, amountToken: 0, binsBelowActive: 24, binsAboveActive: 0, strategy: "Spot" }, positionAddress: pos.address, reasoning: "Follow it up.", confidence: 0.6, headline: "Re-lay." };
    const advised = adviseWithPolicy(modelRelay, policy.policyDecide(idle(cases[0][0]), x));
    assert.equal(advised.decision.action, "HOLD");
    assert.match(advised.note!, /refused by the desk policy's entry rules/);
  });

  await test("a re-lay takes our own liquidity off the depth only where the snapshot holds it: none on paper, the observed bins' share on a chain read", async () => {
    // an idle band over [236, 260] worth 20 SOL, the price at 263: the snapshot reads the ten bins under it (253..262), 8 of them the band's
    const { pos, snap } = paperPos(263);
    const shallow = { ...snap, liquidityBelowY: 10 }; // 1 SOL a bin under the price as observed
    const e = obs().engine!;
    const relay = (ownInSnapshot?: boolean) =>
      policy.policyDecide(obs({ positions: [pos], wallet: { address: "w", sol: 50, token: 0, tokenSymbol: "ANSEM", quote: 50, quoteSymbol: "SOL" }, engine: { ...e, outOfRangeSec: { [pos.address]: 2000 } } }, shallow), { ...x, ...(ownInSnapshot === undefined ? {} : { ownInSnapshot }) });
    // paper: the snapshot never held the band, so the depth is the observed 1 SOL a bin x 25 bins and the max band binds
    const onPaper = relay(false);
    assert.equal(onPaper.branch, "rebalance", onPaper.reason);
    assert.equal(onPaper.decision.open!.amountSol, 22.5);
    // a chain read holds it: 0.8 SOL a bin in 8 of the 10 observed bins comes out, 0.36 SOL a bin of others' x 25 = 9 SOL
    // (the whole 20 SOL band used to come off a 25 SOL estimate: a 5 SOL re-lay, and on paper the same)
    const onChain = relay();
    assert.equal(onChain.branch, "rebalance", onChain.reason);
    near(onChain.decision.open!.amountSol, 9, 1e-4, "chain read");
    assert.match(onChain.decision.reasoning, /bound by half the band's depth \((9|8\.99\d*) SOL\)/);
    // the pure part: only the observed bins count, split by the side of the price they sit on
    const q = dlmm.quoteOf(snap);
    assert.deepEqual(policy.ownObservedLiquidity(snap, { lowerBinId: 300, upperBinId: 320, valueInSol: 20 }, q), { quote: 0, token: 0 }, "a band off the observed bins holds none of them");
    const straddle = policy.ownObservedLiquidity(snapAt(260), { lowerBinId: 255, upperBinId: 265, valueInSol: 11 }, dlmm.quoteOf(snapAt(260)));
    near(straddle.quote, 5, 1e-9, "five quote-side bins at 1 SOL");
    near(straddle.token, 5 / p(260), 1e-6, "five token-side bins at 1 SOL, in token");
    // the loop says so on every ask of the policy, the model's advice and the screen included (src/agent/decide.ts)
    const { policyExtrasOf } = await import("../agent/decide.js");
    assert.equal(policyExtrasOf({ ownInSnapshot: false }).ownInSnapshot, false);
    assert.equal(policyExtrasOf({}).ownInSnapshot, undefined, "unsaid: a chain read");
  });

  await test("the crash's own travel widens the band, not the seat: the depth cap reads the width of the travel before the last cycle's move", () => {
    const withTravel = (recentMovePct: number, priorMovePct: number | null, liquidityBelowY: number) =>
      policy.policyDecide(obs({ screen: { ...obs().screen!, recentMovePct, priorMovePct } }, snapAt(260, { liquidityBelowY })), x);
    // a calm pool (0.2% an hour at 0.2% a bin) lays one bin under the price: 2 SOL of depth, no seat
    assert.equal(withTravel(0.2, 0.2, 10).branch, "no-size");
    // the cycle a 4% drop widens its band to 21 bins, the depth across them made it a 21 SOL seat; it is sized on the calm travel
    const crash = withTravel(4, 0.2, 10);
    assert.equal(crash.branch, "no-size", crash.reason);
    assert.match(crash.reason, /bound by half the depth of the 2 bins the pool's travel before its last 3\.8% move would lay \(2 SOL of others' there; the move widens the band, not the seat\)/);
    // a pool that has travelled 4% an hour all along keeps its seat: nothing of it is the last move's
    const steady = withTravel(4, 4, 10);
    assert.equal(steady.branch, "open");
    assert.equal(steady.decision.open!.amountSol, 21);
    assert.equal(steady.decision.open!.binsBelowActive, 20);
    // deep enough for a seat on the calm width: the band keeps the full 21 bins, the seat is the calm width's depth
    const deep = withTravel(4, 0.2, 90);
    assert.equal(deep.branch, "open");
    assert.equal(deep.decision.open!.binsBelowActive, 20, "the band is as wide as the travel");
    assert.equal(deep.decision.open!.amountSol, 18, "9 SOL a bin x 2 bins, not the max band");
    // unknown prior travel (too few samples): nothing to take out
    assert.equal(withTravel(4, null, 10).decision.open!.amountSol, 21);
  });
  await test("a crash in two steps under the per-cycle knife is one move: the loop takes the run through the bid band out whole, and the seat stays the calm hour's", async () => {
    const exit = await import("../engine/exit.js");
    const withTravel = (recentMovePct: number, priorMovePct: number | null) => policy.policyDecide(obs({ screen: { ...obs().screen!, recentMovePct, priorMovePct } }, snapAt(260, { liquidityBelowY: 10 })), x);
    // the reviewer's staircase (x0.955 every five minutes after a calm hour), sampled once a cycle as the loop does: at
    // x0.912 neither step passed the 5% per-cycle knife, the 20% in 30 minutes or the 10% in four hours
    const at = (prices: number[]) => prices.map((price, i) => ({ ts: T0 - (prices.length - 1 - i) * 300e3, price }));
    const stair = at([1, 1.002, 1, 1.002, 1, 1.002, 1, 1.002, 1, 0.955, 0.912]);
    assert.equal(exit.knivesReason(stair, T0, { knifePct: 20, cycleKnifePct: 5, cycleMs: 300e3, slowKnifePct: 10, slowKnifeMs: 240 * 60e3 }), null);
    const recent = exit.rangeOverWindowPct(stair, T0)!;
    // only the last cycle's sample out: the first step's 4.5% reaches the 4% cover cap and the max seat opens halfway down
    const oneStep = withTravel(recent, exit.priorRangeOverWindowPct(stair, T0));
    assert.equal(oneStep.branch, "open");
    assert.equal(oneStep.decision.open!.amountSol, 21);
    // the run out whole (src/index.ts priorMoveOf, the pool quoted in Y: a fall runs through its band): the band keeps its width, the seat is the calm hour's, under the minimum
    const way = exit.bidRunWay(dlmm.quoteOf(snapAt(260)).side);
    assert.equal(way, "down");
    const run = withTravel(recent, exit.priorRangeOverWindowPct(stair, T0, undefined, way));
    assert.equal(run.branch, "no-size", run.reason);
    assert.match(run.reason, /before its last 9\.\d% move would lay/);
    // a pool that chopped 4% an hour before the same fall keeps its seat: that travel is the pool's, not the fall's
    const chop = at([1, 1.04, 1, 1.04, 1, 1.04, 1, 1.04, 1, 0.955, 0.912]);
    assert.equal(withTravel(exit.rangeOverWindowPct(chop, T0)!, exit.priorRangeOverWindowPct(chop, T0, undefined, way)).decision.open!.amountSol, 21);
  });

  await test("decide() without a key uses the policy: source policy, model desk-policy, a note", async () => {
    // pin the decider: this test is about the no-key path, and a developer's .env (DECIDER=openhermit on the
    // paper desk since 22 Sep) must not change what it tests
    const savedDecider = process.env.DECIDER;
    delete process.env.DECIDER;
    try {
    const r = await decide(obs());
    assert.equal(r.source, "policy");
    assert.equal(r.model, "desk-policy");
    assert.match(r.note!, /^No ANTHROPIC_API_KEY configured\. Desk policy \(open\): open 22.5 SOL across 25 bins/);
    assert.equal(r.decision.action, "OPEN_POSITION");
    const off = await decide(obs({ screen: null }), { hot: [{ address: POOL, priceChange1hPct: 2, flags: [], heat: 35, surge: true }] });
    assert.equal(off.decision.action, "OPEN_POSITION");
    } finally {
      if (savedDecider === undefined) delete process.env.DECIDER;
      else process.env.DECIDER = savedDecider;
    }
  });
  await test("policy on a LIVE book: without POLICY_LIVE an open becomes a hold that says why; POLICY_LIVE=true lets it through; closes are never withheld", async () => {
    const { policyDecideResult } = await import("../agent/decide.js");
    const live = policyDecideResult(obs(), "No ANTHROPIC_API_KEY configured.", {}, false, {});
    assert.equal(live.source, "policy");
    assert.equal(live.model, "desk-policy");
    assert.equal(live.decision.action, "HOLD");
    assert.match(live.decision.reasoning, /would open here .* but this book is live and POLICY_LIVE is not set: without the model, only the engine's exits run/);
    assert.match(live.note!, /withheld on a live book without POLICY_LIVE/);
    const allowed = policyDecideResult(obs(), "No ANTHROPIC_API_KEY configured.", {}, false, { POLICY_LIVE: "true" });
    assert.equal(allowed.decision.action, "OPEN_POSITION");
    const paper = policyDecideResult(obs(), "No ANTHROPIC_API_KEY configured.", {}, true, {});
    assert.equal(paper.decision.action, "OPEN_POSITION", "a dry run or paper book is never withheld");
    assert.equal(policyDecideResult(obs(), "x", {}, false, { POLICY_LIVE: "yes" }).decision.action, "HOLD", "only the literal true");
  });

  console.log("report, file round-trip, route");
  await test("paperSummary + renderPaperReport: equity vs start, the identity, the decision tally", () => {
    const entries: JournalEntry[] = [];
    const entry = (over: Partial<JournalEntry>): JournalEntry =>
      ({
        id: "x", ts: new Date(T0 + 60e3).toISOString(), cycle: 1, mode: "dry-run", agent: { id: "mr-bands", name: "Mr Bands" },
        pool: { address: POOL, label: "ANSEM/SOL", tokenX: { symbol: "ANSEM", decimals: 6 }, tokenY: { symbol: "SOL", decimals: 9 }, solSide: "Y", binStep: 20, activeBinId: 260, price: p(260), priceLabel: "", tokenPriceInSol: p(260), baseFeePct: 0.2, dynamicFeePct: 0.2, bins: [] },
        wallet: { address: "w", sol: 1, token: 0, tokenSymbol: "ANSEM" }, positions: [], analytics: null, llm: { source: "policy", model: "desk-policy" },
        proposal: openDecision(1, 9), decision: openDecision(1, 9), allowed: true, violations: [], overrides: [], passed: [], emergency: false,
        execution: { mode: "paper", ok: true, txs: [{ label: "x", ok: true }], notes: [], opened: { address: "paper-1", entryValueSol: 1 } }, headline: "", engine: { directive: null, reason: null, sizeMultiplier: 1, bench: { stops6h: 0, multiplier: 1, benched: false }, regime: { medianMove24hPct: 0, multiplier: 1 }, halt: null, standDown: null, stops: {}, collectsToday: 0 },
        ...over,
      }) as JournalEntry;
    const hold: Decision = { action: "HOLD", open: null, positionAddress: null, reasoning: "", confidence: 1, headline: "" };
    entries.push(entry({}));
    entries.push(entry({ decision: hold, execution: { mode: "none", ok: true, txs: [], notes: ["hold"] } }));
    entries.push(entry({ decision: hold, allowed: false, violations: ["cooldown"], execution: { mode: "none", ok: true, txs: [], notes: [] } }));
    entries.push(entry({ decision: closeDecision("paper-1"), llm: { source: "engine", model: "engine" }, execution: { mode: "paper", ok: true, txs: [{ label: "c", ok: true }], notes: [], closed: "paper-1" }, engine: { ...entry({}).engine!, directive: "STOP" } }));
    entries.push(entry({ ts: new Date(T0 - 3600e3).toISOString() })); // before the book started: not counted
    const summary = paper.paperSummary(book, entries, T0 + 7200e3);
    assert.deepEqual({ ...summary.tally, firstTs: null, lastTs: null }, { entries: 4, holds: 1, opens: 1, closes: 1, rebalances: 0, claims: 0, vetoes: 1, overrides: 0, directives: { STOP: 1 }, sources: { policy: 3, engine: 1 }, pools: 1, firstTs: null, lastTs: null, hedgeFills: 0, hedgeHolds: {} });
    near(summary.equity.vsStartSol, summary.realizedSol + summary.markedSol + summary.equity.hedgeSol - summary.rentLockedSol - summary.rentSpentSol - summary.swapCostSol - summary.txFeesSol, 1e-9, "identity in the summary");
    assert.equal(summary.closed.length, 1);
    assert.equal(summary.bands.length, 0);
    near(summary.equity.usd!, summary.equity.sol * 100, 1e-9);
    near(summary.ageHours, 2, 1e-9);
    const text = paper.renderPaperReport(summary);
    assert.match(text, /PAPER BOOK  started 2026-09-14T12:00:00.000Z/);
    assert.match(text, /start        100.0000 SOL \+ 0.00 USDC = 100.0000 SOL \(\$10,000.00\)/);
    assert.match(text, /OPEN BANDS \(0\)\n  none/);
    assert.match(text, /CLOSED BANDS \(1\)\n  paper-6e7V9e-1\s+ANSEM\/SOL\s+realized -0.0032 SOL \(-\$0.32\) \(-0.32%\)/);
    assert.match(text, /SOL book/);
    assert.match(text, /opens 1 \| rebalances 0 \| closes 1 \| claims 0 \| holds 1 \| guard vetoes 1 \| guard overrides 0 \| engine directives STOP 1/);
    assert.match(text, /proposed by: policy 3, engine 1/);
  });
  await test("the book survives the file round-trip and loadPaperBook tolerates a missing or torn file", () => {
    const file = path.join(tmp, "round-trip.json");
    paper.savePaperBook(book2, file);
    assert.deepEqual(paper.loadPaperBook(file), book2);
    assert.equal(paper.loadPaperBook(path.join(tmp, "missing.json")), null);
    fs.writeFileSync(path.join(tmp, "torn.json"), "{\"wallet\": ");
    assert.equal(paper.loadPaperBook(path.join(tmp, "torn.json")), null);
    fs.writeFileSync(path.join(tmp, "old.json"), JSON.stringify({ startedAt: "2026-01-01T00:00:00.000Z", startSol: 5, startUsdc: 0, wallet: { sol: 5 }, bands: [] }));
    const old = paper.loadPaperBook(path.join(tmp, "old.json"))!;
    assert.deepEqual(old.wallet, { sol: 5, usdc: 0, tokens: {} });
    assert.deepEqual(old.closed, []);
    assert.equal(old.feesClaimedSol, 0);
  });
  await test("GET /api/paper: 404 without a book, the book + summary with one", async () => {
    const app = new Hono();
    paper.paperRoutes(app);
    const none = await app.request("/api/paper");
    assert.equal(none.status, 404);
    assert.match(((await none.json()) as { error: string }).error, /no paper book yet/);
    paper.savePaperBook(book2);
    assert.ok(fs.existsSync(path.join(tmp, "paper-book.json")));
    const res = await app.request("/api/paper");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { enabled: boolean; book: PaperBook; summary: { equity: { sol: number } } };
    assert.equal(body.enabled, false, "PAPER_SOL is unset in this test");
    assert.equal(body.book.startSol, 100);
    near(body.summary.equity.sol, paper.bookEquitySol(book2).equitySol, 1e-9);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} paper tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
