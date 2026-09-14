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
    near(closed.realizedSol, proceeds - 1.003, 1e-12, "realized vs all-in entry");
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
    near(r.opened!.entryValueSol, 1.003, 1e-9);
    addr2 = r.opened!.address;
    const row = r.ledger![0];
    assert.equal(row.mode, "dry-run");
    assert.equal(row.basis, "marked");
    assert.equal(row.mech, "open");
    assert.match(row.note, /^paper/);
    near(row.quoteDelta!, -1.003, 1e-12);
    near(row.solDelta, -1.003, 1e-12);
    near(row.rentSol, -dlmm.OPEN_COST_ESTIMATE_SOL, 1e-12);
    assert.equal(row.position, addr2);
    near(book2.wallet.sol, 100 - 1.003 - dlmm.OPEN_COST_ESTIMATE_SOL - paper.PAPER_TX_FEE_SOL, 1e-9);
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
    const stop = closeDecision(addr2, "Engine directive STOP: stop: paper- is 16.0% below entry (1.0030 -> 0.8400 SOL), stop 13.20%. The stop is the exit; it is not negotiated.", "Stop hit.");
    const v = verdictOf(stop, { emergency: true });
    assert.deepEqual(paper.closeReason(v), { reason: "STOP: stop: paper- is 16.0% below entry (1.0030 -> 0.8400 SOL), stop 13.20%", emergency: true });
    assert.deepEqual(paper.closeReason(verdictOf(stop, { emergency: true, overrides: ["stop-loss: x"] })), { reason: "stop-loss: x", emergency: true });
    assert.deepEqual(paper.closeReason(verdictOf(stop)), { reason: "Stop hit.", emergency: false });
    const r = await execute(v, ctx(s250, positions, T0 + 7200e3));
    assert.equal(r.closed, addr2);
    assert.equal(r.mode, "paper");
    const row = r.ledger![0];
    assert.equal(row.mech, "close");
    near(row.entryValueSol!, 1.003, 1e-9);
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
  await test("binsForCover: 5% at 20 bps is 24 bins, bounded to [3, maxBinWidth - 1]", () => {
    assert.equal(policy.binsForCover(20, 5, 69), 24);
    assert.equal(policy.binsForCover(100, 5, 69), 5);
    assert.equal(policy.binsForCover(200, 5, 69), 3);
    assert.equal(policy.binsForCover(1, 5, 69), 68);
    assert.equal(policy.binsForCover(5, 5, 10), 9);
    near(policy.coveragePct(20, 24), 4.91, 1e-3);
    assert.deepEqual(policy.policyEnv({}), { coverPct: 5, minScore: 20, book: "all" });
    assert.deepEqual(policy.policyEnv({ POLICY_COVER_PCT: "8", POLICY_MIN_SCORE: "10", BOOK: "stocks" }), { coverPct: 8, minScore: 10, book: "stocks" });
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
  });
  await test("sizing: the wallet, the depth (share <= 50%), the exposure room and the gas reserve each bound the size", () => {
    const shallow = policy.policyDecide(obs({}, snapAt(260, { liquidityBelowY: 4 })), x); // 0.4 SOL/bin x 25 bins = 10 SOL of depth
    assert.equal(shallow.decision.open!.amountSol, 10);
    assert.match(shallow.decision.reasoning, /bound by half the band's depth \(10 SOL\); our share of the band 50%/);
    const poor = policy.policyDecide(obs({ wallet: { address: "w", sol: 10, token: 0, tokenSymbol: "ANSEM", quote: 10, quoteSymbol: "SOL" } }), x);
    near(poor.decision.open!.amountSol, Math.floor((10 - 1 - dlmm.OPEN_COST_ESTIMATE_SOL) * 1e4) / 1e4, 1e-9);
    assert.match(poor.decision.reasoning, /bound by SOL after rent and the 1 SOL gas reserve/);
    const room = policy.policyDecide(obs({ portfolio: { activePools: [], poolsWithBands: 3, maxActivePools: 4, otherExposureSol: 85 } }), x);
    near(room.decision.open!.amountSol, 5, 1e-9);
    assert.match(room.decision.reasoning, /bound by exposure room 5 SOL/);
    const half = policy.policyDecide(obs({ engine: { ...obs().engine!, sizeMultiplier: 0.5, effectiveMaxPositionSol: 11.25 } }), x);
    assert.equal(half.decision.open!.amountSol, 11.25);
    const tiny = policy.policyDecide(obs({ wallet: { address: "w", sol: 1.25, token: 0, tokenSymbol: "ANSEM", quote: 1.25, quoteSymbol: "SOL" } }), x);
    assert.equal(tiny.branch, "no-size");
    assert.match(tiny.reason, /under the 0.1 SOL floor/);
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
  await test("price through the band on a hot pool: HOLD one more cycle, then CLOSE on the next", () => {
    const { pos, snap } = paperPos(230);
    const e = obs().engine!;
    const hotObs = obs({ positions: [pos], engine: { ...e, outOfRangeSec: { [pos.address]: 700 } }, screen: { ...obs().screen!, hot: [hotRow()] } }, snap);
    const first = policy.policyDecide(hotObs, x);
    assert.equal(first.branch, "hot-hold");
    assert.equal(first.decision.headline, policy.HOT_HOLD_HEADLINE);
    assert.match(first.decision.reasoning, /heat 40, 1h \+1.5%/);
    const second = policy.policyDecide({ ...hotObs, recent: [{ ts: "", action: "HOLD", allowed: true, headline: policy.HOT_HOLD_HEADLINE, violations: [] }] }, x);
    assert.equal(second.branch, "close");
    assert.match(second.decision.reasoning, /still hot but already had its extra cycle/);
  });
  await test("price above the band (idle quote): HOLD under 3x the minimum, REBALANCE past it, CLOSE when a fresh band is gated", () => {
    const { pos, snap } = paperPos(263);
    const e = obs().engine!;
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
  await test("decide() without a key uses the policy: source policy, model desk-policy, a note", async () => {
    const r = await decide(obs());
    assert.equal(r.source, "policy");
    assert.equal(r.model, "desk-policy");
    assert.match(r.note!, /^No ANTHROPIC_API_KEY configured\. Desk policy \(open\): open 22.5 SOL across 25 bins/);
    assert.equal(r.decision.action, "OPEN_POSITION");
    const off = await decide(obs({ screen: null }), { hot: [{ address: POOL, priceChange1hPct: 2, flags: [], heat: 35, surge: true }] });
    assert.equal(off.decision.action, "OPEN_POSITION");
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
    assert.deepEqual({ ...summary.tally, firstTs: null, lastTs: null }, { entries: 4, holds: 1, opens: 1, closes: 1, rebalances: 0, claims: 0, vetoes: 1, overrides: 0, directives: { STOP: 1 }, sources: { policy: 3, engine: 1 }, pools: 1, firstTs: null, lastTs: null });
    near(summary.equity.vsStartSol, summary.realizedSol + summary.markedSol - summary.rentLockedSol - summary.rentSpentSol, 1e-9, "identity in the summary");
    assert.equal(summary.closed.length, 1);
    assert.equal(summary.bands.length, 0);
    near(summary.equity.usd!, summary.equity.sol * 100, 1e-9);
    near(summary.ageHours, 2, 1e-9);
    const text = paper.renderPaperReport(summary);
    assert.match(text, /PAPER BOOK  started 2026-09-14T12:00:00.000Z/);
    assert.match(text, /start        100.0000 SOL \+ 0.00 USDC = 100.0000 SOL \(\$10,000.00\)/);
    assert.match(text, /OPEN BANDS \(0\)\n  none/);
    assert.match(text, /CLOSED BANDS \(1\)\n  paper-6e7V9e-1\s+ANSEM\/SOL\s+realized -0.0062 SOL \(-0.62%\)/);
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
