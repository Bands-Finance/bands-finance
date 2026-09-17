/**
 * Pinned stocks (src/screener/pinnedStock.ts): the Meteora pools of the stocks the agent is paired with.
 * Pure: a saved DexScreener answer for NVDAx (2026-09-15) and hand-built pool accounts; no network.
 *   npx tsx src/scripts/test-pinned.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  choosePinnedPool,
  LB_PAIR_SIZE,
  lbPairFee,
  meteoraPoolsFromDexScreener,
  pinnedPoolAt,
  pinnedTickers,
  rankPinnedPools,
  refreshPinnedStocks,
  SOL_MINT_ADDRESS,
  USDC_MINT_ADDRESS,
  withFee,
  type PinnedPool,
} from "../screener/pinnedStock";
import { pinRotateMinAgeMin, pinSeatAction, rotationCandidate, type RotationBand } from "../engine/rotation";

const T0 = Date.parse("2026-09-15T16:00:00Z");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.error(err);
    process.exit(1);
  }
}
const near = (a: number | null | undefined, b: number, tol: number, what = "") => assert.ok(typeof a === "number" && Math.abs(a - b) <= tol, `${what} ${a} vs ${b}`);

const NVDAX = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const NVDAX_SOL = "FCn5zw4gAcfRpQgst5ThFuzBGXbbJ6RocVErgC4vJ9j1";
const NVDAX_USDC = "F4inHs4RQARpASmvLpj45QjGLdkukeGQrtQ22pimVy2a";
const ANSWER = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "dexscreener-nvdax-token-pairs.json"), "utf8"));

/** A Meteora LbPair account with a bin step, base factor and base-fee power factor where the program keeps them. */
function lbPairAccount(binStep: number, baseFactor: number, power = 0): Uint8Array {
  const buf = new Uint8Array(LB_PAIR_SIZE);
  const view = new DataView(buf.buffer);
  view.setUint16(8, baseFactor, true);
  view.setUint8(38, power);
  view.setUint16(80, binStep, true);
  return buf;
}

async function main(): Promise<void> {
  console.log("pinned stocks / env and parsing");
  await test("pinnedTickers: PAIR_STOCK_PINNED_TICKERS as tickers, an xStock symbol reads as its ticker, unset is none", () => {
    assert.deepEqual(pinnedTickers({}), []);
    assert.deepEqual(pinnedTickers({ PAIR_STOCK_PINNED_TICKERS: "NVDA" }), ["NVDA"]);
    assert.deepEqual(pinnedTickers({ PAIR_STOCK_PINNED_TICKERS: " nvdax, TSLA ,NVDA" }), ["NVDA", "TSLA"]);
  });

  await test("meteoraPoolsFromDexScreener on NVDAx's real answer: only the two Meteora DLMM pools with NVDAx as the base and SOL or USDC as the quote survive", () => {
    assert.ok(ANSWER.length > 10, "the fixture carries Raydium, Orca, pump.fun and tokens quoted in NVDAx too");
    const pools = meteoraPoolsFromDexScreener("NVDA", NVDAX, ANSWER);
    assert.deepEqual(pools.map((p) => `${p.symbol}/${p.quoteSymbol}`).sort(), ["NVDAx/SOL", "NVDAx/USDC"]);
    const sol = pools.find((p) => p.quoteSymbol === "SOL")!;
    assert.equal(sol.address, NVDAX_SOL);
    assert.equal(sol.quoteMint, SOL_MINT_ADDRESS);
    assert.equal(sol.ticker, "NVDA");
    assert.equal(sol.mint, NVDAX);
    assert.ok(sol.liquidityUsd! > 1000 && sol.volume24hUsd! > 1000, "depth and volume carried");
    assert.ok(sol.priceNative! > 1 && sol.priceUsd! > 100, "price in SOL and USD");
    assert.equal(sol.binStep, null, "the fee comes from the pool account, not DexScreener");
    const usdc = pools.find((p) => p.quoteSymbol === "USDC")!;
    assert.equal(usdc.address, NVDAX_USDC);
    assert.equal(usdc.quoteMint, USDC_MINT_ADDRESS);
    // every other venue, every token quoted IN NVDAx (pump.fun's Jackcat/NVDAx, PEPE/NVDAx...), every other quote
    assert.equal(meteoraPoolsFromDexScreener("NVDA", NVDAX, ANSWER.filter((r: { dexId: string }) => r.dexId !== "meteora")).length, 0);
    assert.equal(meteoraPoolsFromDexScreener("NVDA", "SomeOtherMint", ANSWER).length, 0, "the mint must be the base");
    assert.deepEqual(meteoraPoolsFromDexScreener("NVDA", NVDAX, { pairs: ANSWER }).length, 2, "the older { pairs } wrapper reads the same");
    assert.deepEqual(meteoraPoolsFromDexScreener("NVDA", NVDAX, null), []);
  });

  await test("the pump.fun creation pair: tokens are already launched on pump.fun against NVDAx, so NVDAx is a live pump.fun quote", () => {
    const onPump = ANSWER.filter((r: { dexId: string; quoteToken: { address: string } }) => r.dexId === "pumpfun" && r.quoteToken.address === NVDAX);
    assert.ok(onPump.length > 0, "the fixture shows pump.fun tokens quoted in NVDAx");
  });

  console.log("pinned stocks / the pool account and the ranking");
  await test("lbPairFee reads the bin step and the base fee as the program computes it: base factor x bin step x 10^power / 1e6, in percent", () => {
    assert.deepEqual(lbPairFee(lbPairAccount(20, 10_000)), { binStep: 20, baseFeePct: 0.2 }, "NVDAx/SOL: bin step 20, 0.2%");
    assert.deepEqual(lbPairFee(lbPairAccount(25, 10_000)), { binStep: 25, baseFeePct: 0.25 }, "NVDAx/USDC: bin step 25, 0.25%");
    assert.deepEqual(lbPairFee(lbPairAccount(400, 12_500)), { binStep: 400, baseFeePct: 5 });
    assert.deepEqual(lbPairFee(lbPairAccount(100, 1_000, 1)), { binStep: 100, baseFeePct: 1 }, "the power factor multiplies by ten");
    assert.equal(lbPairFee(new Uint8Array(100)), null, "not a pool account");
    assert.equal(lbPairFee(lbPairAccount(0, 10_000)), null);
    assert.equal(lbPairFee(null), null);
  });

  const pool = (over: Partial<PinnedPool>): PinnedPool => ({
    address: "A", ticker: "NVDA", mint: NVDAX, symbol: "NVDAx", quoteSymbol: "SOL", quoteMint: SOL_MINT_ADDRESS, binStep: null, baseFeePct: null,
    liquidityUsd: null, volume24hUsd: null, volume1hUsd: null, priceNative: null, priceUsd: null, fees24hUsd: null, feeToTvl24hPct: null, ...over,
  });

  await test("withFee: fees a day from the real volume, fee/TVL from the real depth; rank puts the best-paying pool first", () => {
    const sol = withFee(pool({ address: NVDAX_SOL, liquidityUsd: 4_109, volume24hUsd: 26_672 }), { binStep: 20, baseFeePct: 0.2 });
    near(sol.fees24hUsd, 53.344, 1e-9, "fees");
    near(sol.feeToTvl24hPct, 1.2982, 1e-4, "fee/TVL");
    const usdc = withFee(pool({ address: NVDAX_USDC, quoteSymbol: "USDC", quoteMint: USDC_MINT_ADDRESS, liquidityUsd: 20_733, volume24hUsd: 12_474 }), { binStep: 25, baseFeePct: 0.25 });
    near(usdc.feeToTvl24hPct, 0.1504, 1e-4, "fee/TVL");
    assert.deepEqual(rankPinnedPools([usdc, sol]).map((p) => p.address), [NVDAX_SOL, NVDAX_USDC], "NVDAx/SOL pays ~1.3% of its depth a day, NVDAx/USDC ~0.15%");
    assert.equal(withFee(sol, null), sol, "no account, no change");
    const unknown = pool({ address: "U" });
    assert.equal(rankPinnedPools([unknown, usdc])[0].address, NVDAX_USDC, "an unknown yield goes last");
  });

  await test("choosePinnedPool: the best pool the wallet can fund; none when it can fund neither quote; pinnedPoolAt finds a pool across tickers", () => {
    const sol = withFee(pool({ address: NVDAX_SOL, liquidityUsd: 4_109, volume24hUsd: 26_672 }), { binStep: 20, baseFeePct: 0.2 });
    const usdc = withFee(pool({ address: NVDAX_USDC, quoteSymbol: "USDC", quoteMint: USDC_MINT_ADDRESS, liquidityUsd: 20_733, volume24hUsd: 12_474 }), { binStep: 25, baseFeePct: 0.25 });
    const t = { ticker: "NVDA", mint: NVDAX, pools: [usdc, sol], note: null };
    assert.equal(choosePinnedPool(t, () => true)?.address, NVDAX_SOL);
    assert.equal(choosePinnedPool(t, (q) => q === "USDC")?.address, NVDAX_USDC, "a USDC-only wallet takes the USDC pool");
    assert.equal(choosePinnedPool(t, () => false), null);
    assert.equal(choosePinnedPool(undefined, () => true), null);
    const file = { generatedAt: "", tickers: [t, { ticker: "TSLA", mint: "T", pools: [pool({ address: "TSLApool", ticker: "TSLA" })], note: null }] };
    assert.equal(pinnedPoolAt(file, "TSLApool")?.ticker, "TSLA");
    assert.equal(pinnedPoolAt(file, "nope"), null);
    assert.equal(pinnedPoolAt(null, NVDAX_SOL), null);
  });

  console.log("pinned stocks / the refresh");
  await test("refreshPinnedStocks: one DexScreener call per mint, one account read for every pool, fees filled and ranked; a ticker with no mint or no Meteora pool says why; a failed call is a note, never a throw", async () => {
    const calls: string[] = [];
    const reads: string[][] = [];
    const file = await refreshPinnedStocks({
      tickers: ["NVDA", "TSLA", "GHOST"],
      mintOf: (t) => ({ NVDA: NVDAX, TSLA: "TSLAmint" })[t] ?? null,
      fetch: async (url) => {
        calls.push(String(url));
        if (String(url).endsWith(NVDAX)) return new Response(JSON.stringify(ANSWER), { status: 200 });
        return new Response("rate limited", { status: 429 });
      },
      readAccounts: async (addresses) => {
        reads.push(addresses);
        return addresses.map((a) => (a === NVDAX_SOL ? lbPairAccount(20, 10_000) : a === NVDAX_USDC ? lbPairAccount(25, 10_000) : null));
      },
      now: Date.parse("2026-09-15T16:00:00Z"),
    });
    assert.equal(calls.length, 2, "no call for a ticker without a mint");
    assert.equal(reads.length, 1, "every pool's account in one read");
    assert.deepEqual(reads[0].sort(), [NVDAX_USDC, NVDAX_SOL].sort());
    assert.equal(file.generatedAt, "2026-09-15T16:00:00.000Z");
    const nvda = file.tickers.find((t) => t.ticker === "NVDA")!;
    assert.equal(nvda.pools.length, 2);
    assert.equal(nvda.pools[0].binStep !== null && nvda.pools[0].baseFeePct !== null, true, "the fee came from the account");
    assert.equal(nvda.note, null);
    const tsla = file.tickers.find((t) => t.ticker === "TSLA")!;
    assert.deepEqual(tsla.pools, []);
    assert.match(tsla.note!, /^discovery failed: DexScreener HTTP 429$/);
    const ghost = file.tickers.find((t) => t.ticker === "GHOST")!;
    assert.equal(ghost.mint, null);
    assert.match(ghost.note!, /^no mint known for GHOST/);
    // an account read that throws leaves the pools without a fee, ranked by depth, and still does not throw
    const noAccounts = await refreshPinnedStocks({ tickers: ["NVDA"], mintOf: () => NVDAX, fetch: async () => new Response(JSON.stringify(ANSWER), { status: 200 }), readAccounts: async () => { throw new Error("429"); } });
    assert.equal(noAccounts.tickers[0].pools.length, 2);
    assert.ok(noAccounts.tickers[0].pools.every((p) => p.baseFeePct === null));
    // Meteora has nothing for the mint: the note says so
    const none = await refreshPinnedStocks({ tickers: ["NVDA"], mintOf: () => NVDAX, fetch: async () => new Response("[]", { status: 200 }), readAccounts: async () => [] });
    assert.match(none.tickers[0].note!, /^Meteora has no DLMM pool for NVDA quoted in SOL or USDC$/);
  });

  console.log("pinned stocks / rotation for a pin");
  const band = (over: Partial<RotationBand>): RotationBand => ({ pool: "P", label: "P/SOL", venue: "meteora-dlmm", openedAt: T0 - 5 * 3600_000, valueSol: 20, feesPerDaySol: 0.2, pinned: false, house: false, ...over });
  const opts = { now: T0, tradable: (v: string) => v === "meteora-dlmm", minAgeMin: 60, forTicker: "NVDA" };
  await test("rotationCandidate: a band off TRADABLE_VENUES goes first (largest), else the slowest earner; never a pin, the house pool, or a band under the minimum age", () => {
    const mcd = band({ pool: "MCD", label: "MCDx/USDC", venue: "raydium-clmm", valueSol: 49.8, feesPerDaySol: 3 });
    const spcx = band({ pool: "SPCX", label: "SPCXx/SOL", valueSol: 22, feesPerDaySol: 0.05 });
    const stonk = band({ pool: "STONK", label: "STONK/SOL", valueSol: 21, feesPerDaySol: 0 });
    const pick = rotationCandidate([spcx, stonk, mcd], opts)!;
    assert.equal(pick.pool, "MCD", "off-venue first, even though it earns the most");
    assert.equal(pick.reason, "making room for pinned NVDA: MCDx/USDC is on raydium-clmm, off TRADABLE_VENUES, and the pairing is Meteora only");
    const slow = rotationCandidate([spcx, stonk], opts)!;
    assert.equal(slow.pool, "STONK", "then the slowest earner");
    assert.equal(slow.reason, "making room for pinned NVDA: STONK/SOL is the slowest earner in the book (0.00% of its value in fees a day)");
    assert.equal(rotationCandidate([band({ pinned: true }), band({ pool: "H", house: true })], opts), null, "a pin and the house pool never go");
    assert.equal(rotationCandidate([band({ openedAt: T0 - 30 * 60_000 })], opts), null, "a band under an hour old has not had its chance");
    assert.equal(rotationCandidate([band({ openedAt: T0 - 30 * 60_000 })], { ...opts, minAgeMin: 0 })?.pool, "P");
    const unknown = rotationCandidate([band({ pool: "OLD", openedAt: null, feesPerDaySol: null }), band({ pool: "NEW", openedAt: null, feesPerDaySol: null })], opts)!;
    assert.equal(unknown.pool, "OLD", "pace unknown everywhere: the first listed (oldest) goes");
    assert.match(unknown.reason, /its pace is not tracked; the oldest band goes/);
    assert.equal(rotationCandidate([band({ pool: "KNOWN", feesPerDaySol: 5 }), band({ pool: "UNKNOWN", feesPerDaySol: null })], opts)!.pool, "KNOWN", "a known pace goes before an unknown one");
    assert.equal(rotationCandidate([band({ venue: null, feesPerDaySol: 1 })], opts)!.pool, "P", "an unknown venue is not assumed off-venue");
    assert.equal(pinRotateMinAgeMin({}), 60);
    assert.equal(pinRotateMinAgeMin({ PIN_ROTATE_MIN_AGE_MIN: "15" }), 15);
    assert.equal(pinRotateMinAgeMin({ PIN_ROTATE_MIN_AGE_MIN: "-3" }), 60);
  });

  await test("pinSeatAction: a pin whose token already holds a seat (any of its pools) never rotates a band out", () => {
    assert.equal(pinSeatAction({ poolHeld: true, tokenHeld: true, bookFull: true }), "held");
    assert.equal(pinSeatAction({ poolHeld: false, tokenHeld: true, bookFull: true }), "held", "NVDAx/SOL held while NVDAx/USDC ranks first: the loop of 2026-09-16");
    assert.equal(pinSeatAction({ poolHeld: false, tokenHeld: true, bookFull: false }), "held");
    assert.equal(pinSeatAction({ poolHeld: false, tokenHeld: false, bookFull: true }), "rotate");
    assert.equal(pinSeatAction({ poolHeld: false, tokenHeld: false, bookFull: false }), "take");
  });

  console.log(`\n${passed} pinned stock tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
