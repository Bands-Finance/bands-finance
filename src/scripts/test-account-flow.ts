/**
 * The account-delta scout (src/scouts/accountFlow.ts): the pool account's decode, and the windows from samples.
 *   npx tsx src/scripts/test-account-flow.ts
 * The fixture is ALLINU/SOL's LbPair account as Helius returned it on 2026-09-17 (904 bytes).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { basePriceInQuote, decodeLbPair, flowPoolFromSamples, priceOfBin, sampleOf, trimSamples, windowFromSamples, type AccountPoolMeta, type AccountSample } from "../scouts/accountFlow";
import { flowContextOf } from "../scouts/flow";

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

const T = Date.parse("2026-09-17T18:00:00Z");
// a pool like baton/SOL: SOL on Y, 1% bins, 6 and 9 decimals, the protocol takes 10% of every fee, base fee 1%
const meta: AccountPoolMeta = { address: "POOL", label: "baton/SOL", quoteSide: "Y", quoteSymbol: "SOL", xDecimals: 6, yDecimals: 9, band: { lowerBinId: -337, upperBinId: -333 }, binStep: 100, protocolSharePct: 10, baseFeePct: 1 };
const s = (min: number, activeId: number, feeX: number, feeY: number): AccountSample => ({ ts: T - min * 60_000, activeId, feeX, feeY });

async function main() {
  await test("decodeLbPair: the SDK's IDL reads the active bin, the bin step, the mints, the fee counters and the protocol's share off the account", () => {
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "lbpair-account.json"), "utf8")) as { address: string; dataBase64: string };
    const d = decodeLbPair(Buffer.from(fx.dataBase64, "base64"));
    assert.equal(d.binStep, 50);
    assert.ok(Number.isInteger(d.activeId) && d.activeId < 0, `active bin ${d.activeId}`);
    assert.equal(d.protocolSharePct, 10);
    near(d.baseFeePct!, 0.5, 1e-12, "10000 x 50 / 1e6");
    assert.ok(d.protocolFeeX > 0n && d.protocolFeeY > 0n);
    assert.equal(d.tokenYMint, "So11111111111111111111111111111111111111112");
    assert.throws(() => decodeLbPair(Buffer.alloc(64)), /not an LbPair/);
    const sample = sampleOf(d, T, 6, 9);
    near(sample.feeY, Number(d.protocolFeeY) / 1e9, 1e-12);
  });

  await test("prices: Y per X at a bin, and the base in quote units on either side", () => {
    near(priceOfBin(0, 100, 6, 6), 1, 1e-12);
    near(priceOfBin(-333, 100, 6, 9), Math.pow(1.01, -333) * 1e-3, 1e-12);
    near(basePriceInQuote(meta, -333), priceOfBin(-333, 100, 6, 9), 1e-15);
    near(basePriceInQuote({ ...meta, quoteSide: "X" }, -333), 1 / priceOfBin(-333, 100, 6, 9), 1e-9);
  });

  await test("windowFromSamples: the counters' growth over the protocol's share is the fee; the LP keeps the rest; a withdrawal is skipped; our bins, the travel, the sides", () => {
    const px = basePriceInQuote(meta, -334);
    const samples = [
      s(50, -330, 100, 1.0),
      s(40, -334, 100, 1.001), // 0.001 SOL to the protocol: a 0.01 SOL fee on a buy, 0.009 to LPs, inside our band
      s(30, -334, 100 + 0.002 / px, 1.001), // 0.002 SOL worth of baton to the protocol: a sell, 0.018 to LPs, inside our band
      s(20, -340, 100 + 0.002 / px, 1.002), // below our band: 0.009 more to LPs, not ours
      s(10, -340, 5, 0.1), // the protocol withdrew: nothing to read here
      s(5, -339, 5, 0.1005), // 0.0005 to the protocol: 0.0045 to LPs
    ];
    const w = windowFromSamples(meta, samples, T, 60 * 60_000);
    assert.equal(w.swaps, 4, "four intervals in which a counter grew");
    assert.deepEqual([w.buys, w.sells], [3, 1]);
    near(w.feesQuote, 0.009 + 0.018 + 0.009 + 0.0045, 1e-9, "LP fees");
    near(w.ours.feesQuote, 0.009 * (2 / 5) + 0.018 + 0.009 * (4 / 7), 1e-9, "the share of the bins each interval walked that lie inside our band: 2 of 5, all, 4 of 7, none");
    assert.equal(w.ours.swaps, 3);
    near(w.volumeQuote, (0.01 + 0.02 + 0.01 + 0.005) / 0.01, 1e-9, "the fee over the 1% base fee");
    assert.deepEqual([w.binLow, w.binHigh], [-340, -330]);
    assert.equal(w.largest!.dir, "sell");
    const w15 = windowFromSamples(meta, samples, T, 15 * 60_000);
    assert.equal(w15.swaps, 1, "the withdrawal's interval is inside the window and reads nothing");
    near(w15.feesQuote, 0.0045, 1e-9);
    assert.equal(windowFromSamples({ ...meta, protocolSharePct: 0 }, samples, T, 60 * 60_000).swaps, 0, "no protocol share, nothing to read from the counters");
  });

  await test("flowPoolFromSamples: the same file entry the desk reads: coverage from the first sample, the four-hour pace over the covered time, the active bin as the last bin", () => {
    const samples = [s(90, -330, 100, 1.0), s(61, -331, 100, 1.002), s(30, -333, 100, 1.004), s(2, -335, 100, 1.006)];
    const p = flowPoolFromSamples(meta, samples, T);
    assert.equal(p.watchedSince, T - 90 * 60_000);
    assert.equal(p.lastBinId, -335);
    assert.equal(p.lastSwapAt, T - 2 * 60_000);
    near(p.lastPrice!, basePriceInQuote(meta, -335), 1e-15);
    near(p.windows["240m"].feesQuote, 3 * 0.018, 1e-9);
    near(p.feesPerDayQuote240m!, (3 * 0.018) / 90 * 1440, 1e-9, "three fees over ninety covered minutes, a day");
    assert.equal(p.feesPerDayQuote60m, null, "two moving polls in the hour: under three");
    const f = flowContextOf(p);
    assert.deepEqual([f.coveredMin, f.range240mBins, f.range60mBins, f.swaps240m], [90, 5, 4, 3], "the hour's travel starts from where the price stood when the hour opened (-331)");
    const young = flowPoolFromSamples(meta, samples.slice(2), T);
    assert.equal(young.feesPerDayQuote240m, null, "half an hour covered: no four-hour pace yet");
    assert.equal(flowPoolFromSamples(meta, [], T).lastBinId, null);
  });

  await test("trimSamples: everything for twenty minutes, one per thirty seconds before that, nothing past four hours and a minute", () => {
    const dense: AccountSample[] = [];
    for (let sec = 0; sec <= 3600; sec += 5) dense.push({ ts: T - 3600_000 + sec * 1000, activeId: -333, feeX: 0, feeY: sec });
    const kept = trimSamples([...dense, { ts: T - 5 * 3_600_000, activeId: 0, feeX: 0, feeY: 0 }], T);
    const recent = kept.filter((x) => T - x.ts <= 20 * 60_000).length;
    const older = kept.filter((x) => T - x.ts > 20 * 60_000).length;
    assert.equal(recent, 241, "twenty minutes of five-second samples");
    assert.ok(older >= 79 && older <= 81, `forty minutes at one per thirty seconds: ${older}`);
    assert.equal(kept[kept.length - 1].feeY, 3600, "the newest sample is kept as it is");
    assert.ok(kept.every((x) => T - x.ts <= 4 * 3_600_000 + 60_000));
  });

  console.log(`\n${passed} account scout tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
