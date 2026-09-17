/**
 * The flow scout's pure parts, against two of the desk's own live transactions (2026-09-17, saved
 * as fixtures with their DLMM inner instructions): the NVDAx acquire (2.5125 SOL in, 1.1495 NVDAx
 * out, LP fee 4536703 lamports) and the surplus sale (0.0834 NVDAx in, 0.1815 SOL out, fee in NVDAx).
 *   npx tsx src/scripts/test-flow.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { binShare, decodeSwapEvents, flowPoolOf, poolsFromLatest, swapOf, trimSwaps, windowStats, type FlowSwap, type PoolMeta } from "../scouts/flow";

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

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "meteora-swap-events.json"), "utf8")) as { sig: string; slot: number; blockTime: number; innerDlmm: { data: string }[] }[];
const NVDAX_SOL: PoolMeta = { address: "FCn5zw4gAcfRpQgst5ThFuzBGXbbJ6RocVErgC4vJ9j1", label: "NVDAx/SOL", quoteSide: "Y", quoteSymbol: "SOL", xDecimals: 8, yDecimals: 9, band: { lowerBinId: 1531, upperBinId: 1553 } };

async function main() {
  console.log("decoding");
  await test("decodeSwapEvents: one swap per transaction from the inner event CPI, the richer Swap2Evt preferred, with the LP fee and the fee's token", () => {
    const [buy, sell] = fixture.map((t) => decodeSwapEvents(t.innerDlmm.map((i) => i.data)));
    assert.equal(buy.length, 1, "Swap and Swap2Evt describe the same swap: one event");
    assert.equal(sell.length, 1);
    assert.equal(buy[0].lbPair, NVDAX_SOL.address);
    assert.equal(buy[0].swapForY, false, "SOL (Y) in, NVDAx (X) out");
    assert.equal(buy[0].amountIn, 2512498429n);
    assert.equal(buy[0].amountOut, 114954465n);
    assert.equal(buy[0].lpFee, 4536703n, "mm_fee, not the whole fee");
    assert.equal(buy[0].feeOnX, false, "the fee was charged in SOL");
    near(buy[0].feeBps, 20.08, 1e-9);
    assert.deepEqual([buy[0].startBinId, buy[0].endBinId], [1542, 1543]);
    assert.equal(sell[0].swapForY, true);
    assert.equal(sell[0].feeOnX, true, "the fee was charged in NVDAx");
    assert.equal(sell[0].lpFee, 15006n);
    assert.deepEqual(decodeSwapEvents(["notbase58!!"]), [], "garbage is not a swap");
    assert.deepEqual(decodeSwapEvents(["3Bxs4h24hBtQy9rw"]), [], "a short instruction is not an event");
  });

  await test("swapOf: quote units, the fee in quote at the swap's own price, buy/sell by which way the base went, and the share of crossed bins inside our band", () => {
    const [buyEv] = decodeSwapEvents(fixture[0].innerDlmm.map((i) => i.data));
    const [sellEv] = decodeSwapEvents(fixture[1].innerDlmm.map((i) => i.data));
    const buy = swapOf(buyEv, { sig: fixture[0].sig, slot: fixture[0].slot, ts: fixture[0].blockTime * 1000 }, NVDAX_SOL)!;
    near(buy.volumeQuote, 2.512498429, 1e-12);
    near(buy.amountBase, 1.14954465, 1e-12);
    near(buy.feeQuote, 0.004536703, 1e-12, "the fee was in SOL already");
    near(buy.price, 2.512498429 / 1.14954465, 1e-9);
    assert.equal(buy.dir, "buy", "NVDAx left the pool");
    assert.equal(buy.ourBinShare, 1, "bins 1542-1543 sit inside our band");
    const sell = swapOf(sellEv, { sig: fixture[1].sig, slot: fixture[1].slot, ts: fixture[1].blockTime * 1000 }, NVDAX_SOL)!;
    assert.equal(sell.dir, "sell");
    near(sell.volumeQuote, 0.181544563, 1e-12);
    near(sell.feeQuote, 0.00015006 * sell.price, 1e-9, "a fee in NVDAx, valued at the swap's price");
    assert.equal(swapOf(buyEv, { sig: "x", slot: 1, ts: 0 }, { ...NVDAX_SOL, address: "other" }), null, "another pool's event is not ours");
    assert.equal(swapOf(buyEv, { sig: "x", slot: 1, ts: 0 }, { ...NVDAX_SOL, band: null })!.ourBinShare, 0, "no band, no share");
    // the quote on the X side: the same event read from the other side
    const flipped = swapOf(buyEv, { sig: "x", slot: 1, ts: 0 }, { ...NVDAX_SOL, quoteSide: "X", quoteSymbol: "NVDAx" })!;
    near(flipped.volumeQuote, 1.14954465, 1e-12);
    assert.equal(flipped.dir, "sell", "with the base on the Y side, SOL went into the pool");
  });

  console.log("bins and windows");
  await test("binShare: the fraction of a swap's crossed bins inside the band", () => {
    const band = { lowerBinId: 100, upperBinId: 110 };
    assert.equal(binShare(105, 105, band), 1);
    assert.equal(binShare(95, 104, band), 0.5, "10 bins crossed, 5 inside");
    assert.equal(binShare(104, 95, band), 0.5, "direction does not matter");
    assert.equal(binShare(111, 120, band), 0);
    assert.equal(binShare(105, 105, null), 0);
  });

  await test("windowStats and flowPoolOf: rolling windows, our share, the largest print, and the fee pace with at least three swaps", () => {
    const T = Date.parse("2026-09-17T12:00:00Z");
    const s = (min: number, vol: number, fee: number, dir: "buy" | "sell", bins: [number, number]): FlowSwap => ({
      sig: `s${min}`, slot: 1, ts: T - min * 60_000, pool: NVDAX_SOL.address, from: "f", dir, volumeQuote: vol, amountBase: vol / 2, feeQuote: fee, price: 2, startBinId: bins[0], endBinId: bins[1], feeBps: 20, ourBinShare: 0,
    });
    const swaps = [s(0.5, 10, 0.02, "buy", [1540, 1541]), s(3, 4, 0.008, "sell", [1500, 1520]), s(12, 30, 0.06, "buy", [1525, 1534]), s(40, 1, 0.002, "sell", [1543, 1543]), s(70, 100, 0.2, "buy", [1540, 1541])];
    const w15 = windowStats(swaps, T, 15 * 60_000, NVDAX_SOL.band);
    assert.equal(w15.swaps, 3);
    assert.deepEqual([w15.buys, w15.sells], [2, 1]);
    near(w15.volumeQuote, 44, 1e-12);
    near(w15.feesQuote, 0.088, 1e-12);
    near(w15.ours.feesQuote, 0.02 + 0.06 * 0.4, 1e-12, "the 12-minute swap crossed 10 bins, 4 inside the band");
    assert.equal(w15.ours.swaps, 2);
    assert.equal(w15.largest!.volumeQuote, 30);
    const p = flowPoolOf(NVDAX_SOL, swaps, T);
    assert.equal(p.windows["1m"].swaps, 1);
    assert.equal(p.windows["60m"].swaps, 4, "the 70-minute swap is outside the hour");
    near(p.feesPerDayQuote60m!, (0.02 + 0.008 + 0.06 + 0.002) * 24, 1e-12);
    near(p.feesPerDayQuote15m!, 0.088 * 96, 1e-12);
    assert.equal(p.lastSwapAt, T - 30_000);
    assert.equal(flowPoolOf(NVDAX_SOL, swaps.slice(3), T).feesPerDayQuote60m, null, "under three swaps: no pace");
    assert.equal(trimSwaps(swaps, T).length, 4);
  });

  console.log("the desk's pools");
  await test("poolsFromLatest: every worked pool from latest.json, the quote side, decimals, and our band from the positions", () => {
    const latest = {
      "0": { pool: { address: "A", label: "NVDAx/SOL", tokenX: { symbol: "NVDAx", decimals: 8 }, tokenY: { symbol: "SOL", decimals: 9 }, solSide: "Y", quoteSide: "Y", quoteSymbol: "SOL" }, positions: [{ lowerBinId: 1536, upperBinId: 1550 }] },
      "1": { pool: { address: "B", label: "AMD/USDC", tokenX: { symbol: "AMD", decimals: 6 }, tokenY: { symbol: "USDC", decimals: 6 }, solSide: null, quoteSide: "Y", quoteSymbol: "USDC" }, positions: [] },
      "2": { pool: { address: "C", label: "SOL/DJT", tokenX: { symbol: "SOL", decimals: 9 }, tokenY: { symbol: "DJT", decimals: 6 }, solSide: "X" }, positions: [] },
    };
    const pools = poolsFromLatest(latest);
    assert.equal(pools.length, 3);
    const c = pools.find((p) => p.address === "C")!;
    assert.deepEqual([c.quoteSide, c.quoteSymbol, c.band], ["X", "SOL", null], "an older entry without the quote fields: the SOL side is the quote");
    const a = pools.find((p) => p.address === "A")!;
    assert.deepEqual(a.band, { lowerBinId: 1536, upperBinId: 1550 });
    assert.deepEqual([a.quoteSide, a.quoteSymbol, a.xDecimals, a.yDecimals], ["Y", "SOL", 8, 9]);
    assert.equal(pools.find((p) => p.address === "B")!.band, null);
    assert.deepEqual(poolsFromLatest(null), []);
  });

  console.log(`\n${passed} flow scout tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
