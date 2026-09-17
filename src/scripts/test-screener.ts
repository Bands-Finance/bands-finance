/**
 * Screener tests: venue normalisation, pagination, the stock lens, the cross-venue shortlist,
 * GeckoTerminal fill rules, legacy screen.json loading. Fixtures are real API rows. No network.
 *   npm run test:screener
 */
import assert from "node:assert/strict";
import { parseDexScreenerEnrichment, type Enrichment } from "../screener/enrich";
import { fillFromGecko, normalizeScreen, partialFromVenue, shortlistUnion, tradableVenue, venueCounts, venueSolPrice } from "../screener";
import type { LegacyScreen } from "../screener";
import { scorePool } from "../screener/score";
import { parseStockMints, stockOf, verifiedStock } from "../screener/stocks";
import { isLive, pickQuote, scanVenues, tickFromPrice, venueEnv } from "../screener/venues";
import { fetchOrca, normalizeOrca, orcaPageUrl } from "../screener/venues/orca";
import { fetchRaydium, normalizeRaydium, raydiumPageUrl } from "../screener/venues/raydium";
import type { ScreenedPool, VenuePool } from "../screener/types";

let passed = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok  ${name}`);
    })
    .catch((err) => {
      console.error(`FAIL  ${name}`);
      console.error(err);
      process.exit(1);
    });
}
const near = (a: number | null, b: number, tol = 1e-6) => {
  assert.ok(a !== null, `expected ${b}, got null`);
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `expected ${b}, got ${a}`);
};

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NVDAX = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const NOW = Date.parse("2026-09-13T10:30:00Z");

/* ---------- Raydium fixtures: rows from GET /pools/info/list?poolType=concentrated (2026-09-13) ---------- */
const RAY_SOL = {
  type: "Concentrated", programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", id: "2AXXcN6oN9bBT5owwmTH53C7QHUXvhLeu718Kqt8rvY2",
  mintA: { chainId: 101, address: SOL, symbol: "WSOL", name: "Wrapped SOL", decimals: 9 },
  mintB: { chainId: 101, address: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", symbol: "RAY", name: "Raydium", decimals: 6 },
  price: 66.42067971744987, mintAmountA: 9656.620087438, mintAmountB: 1390958.672213, feeRate: 0.0005, openTime: "0", tvl: 3069177.96,
  day: { volume: 17701342.62769886, volumeQuote: 11255742.809355468, volumeFee: 8850.69764818891, apr: 105.26, feeApr: 105.26, priceMin: 58.52708905745674, priceMax: 69.48380994997886, rewardApr: [0] },
  config: { id: "HfERMT5DRA6C1TAqecrJQFpmkf3wsWTMncqnj3RDg5aw", index: 2, protocolFeeRate: 120000, tradeFeeRate: 500, tickSpacing: 10, fundFeeRate: 40000, defaultRange: 0.1 },
  burnPercent: 0.04, hasDynamicFee: false,
};
const NVDAX_USDC_RAY = {
  id: "49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6", programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", type: "Concentrated",
  price: 215.71636936481016, tvl: 2126511.15, feeRate: 0.001,
  mintA: { address: NVDAX, symbol: "NVDAx", decimals: 8, name: "NVIDIA xStock" },
  mintB: { address: USDC, symbol: "USDC", decimals: 6, name: "USD Coin" },
  mintAmountA: 5056.55939869, mintAmountB: 1035751.683125,
  day: { volume: 1410864.3761611667, volumeQuote: 1411559.1805464795, volumeFee: 1410.8845408468744, apr: 24.22, feeApr: 24.22, priceMin: 190.9090909090909, priceMax: 220.52631578947367, rewardApr: [] },
  config: { id: "DrdecJVzkaRsf1TQu1g7iFncaokikVTHqpzPjenjRySY", index: 10, protocolFeeRate: 120000, tradeFeeRate: 1000, tickSpacing: 10, fundFeeRate: 40000 },
  openTime: "0", hasDynamicFee: false, burnPercent: 0,
};
const USDC_FLWS = {
  id: "62sCoQRHneRNWeDXvDvTz7s5uTNgBZD9JE3389DVZ9if", programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", type: "Concentrated",
  price: 0.17959402304028182, tvl: 100534.22, feeRate: 0.0025,
  mintA: { address: USDC, symbol: "USDC", decimals: 6, name: "USD Coin" },
  mintB: { address: "FLWSojG1gB5VStYR3Sb4nQFRt43UBYkqih1j2CpVLqgd", symbol: "FLWS", decimals: 6, name: "1-800-FLOWERS.COM - Backpack Securities" },
  mintAmountA: 78871.90157, mintAmountB: 3890.4269,
  day: { volume: 5917660.130596737, volumeQuote: 705523.332298653, volumeFee: 263690.87108060875, apr: 95735.73, feeApr: 95735.73, priceMin: 0.0012850320576416863, priceMax: 0.3189780552914617 },
  config: { id: "E64NGkDLLCdQ2yFNPcavaKptrEgmiQaNykUuLC1Qgwyp", index: 1, protocolFeeRate: 120000, tradeFeeRate: 2500, tickSpacing: 60, fundFeeRate: 40000 },
  openTime: "0", hasDynamicFee: true, burnPercent: 0,
};
const SOL_USDC_RAY = {
  id: "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv", programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", type: "Concentrated",
  price: 99.80515386723896, tvl: 6822150.14, feeRate: 0.0004,
  mintA: { address: SOL, symbol: "WSOL", decimals: 9, name: "Wrapped SOL" },
  mintB: { address: USDC, symbol: "USDC", decimals: 6, name: "USD Coin" },
  mintAmountA: 46624.447162396, mintAmountB: 2161927.888881,
  day: { volume: 10987696.954340536, volumeQuote: 10990152.693203852, volumeFee: 4395.086123670908, apr: 23.51, feeApr: 23.51, priceMin: 97.70114942528735, priceMax: 103.09278350515464 },
  config: { id: "3h2e43PunVA5K34vwKCLHWhZF4aZpyaC9RmxvshGAQpL", index: 8, protocolFeeRate: 120000, tradeFeeRate: 400, tickSpacing: 1, fundFeeRate: 40000 },
  openTime: "1723037622", hasDynamicFee: false, burnPercent: 0.08,
};
const NVDAX_NVDGE = {
  id: "Ak7oAUqQ9jYu5YvfmDrtDC3WHi7BcN5Y4k8Bh3yk4B5e", programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", type: "Concentrated",
  price: 731506.3351069938, tvl: 87983.56, feeRate: 0.01,
  mintA: { address: NVDAX, symbol: "NVDAx", decimals: 8, name: "NVIDIA xStock" },
  mintB: { address: "Aigf5pKPyZW8nzxCrHEisE4tZMiUhFpKie8mYE7cmj6c", symbol: "NVDGE", decimals: 9, name: "NVDA Doge" },
  mintAmountA: 173.63853428, mintAmountB: 169848947.69226906,
  day: { volume: 119845.2964734026, volumeQuote: 583693794.648129, volumeFee: 1198.453617619486, apr: 497.18, feeApr: 497.18, priceMin: 465149.84777339536, priceMax: 1602875.34231352 },
  config: { id: "A1BBtTYJd4i3xU8D6Tc2FzU6ZN4oXZWXKZnCxwbHXr8x", index: 3, protocolFeeRate: 120000, tradeFeeRate: 10000, tickSpacing: 120, fundFeeRate: 40000 },
  openTime: "0", hasDynamicFee: false, burnPercent: 100,
};

/* ---------- Orca fixtures: rows from GET /v2/solana/pools?sort=volume24h:desc (2026-09-13) ---------- */
const SOL_USDC_ORCA = {
  address: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE", whirlpoolsConfig: "2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ", tickSpacing: 4, feeRate: 400, protocolFeeRate: 1300,
  liquidity: "667440555416178", sqrtPrice: "5828882629022396675", tickCurrentIndex: -23043, protocolFeeOwedA: "81872009", protocolFeeOwedB: "8717375",
  tokenMintA: SOL, tokenMintB: USDC, updatedAt: "2026-09-13T10:18:33.075662Z", hasWarning: false, poolType: "whirlpool",
  tokenA: { address: SOL, symbol: "SOL", name: "Solana", decimals: 9 },
  tokenB: { address: USDC, symbol: "USDC", name: "USD Coin", decimals: 6 },
  price: "99.84611606634625935000", tvlUsdc: "23968180.6986518033859000", yieldOverTvl: "0.00052784622677195300", tokenBalanceA: "148661133090577", tokenBalanceB: "9073665285300",
  stats: {
    "24h": { volume: "31628784.36092930", fees: "15239.3950789912740408", rewards: "0", yieldOverTvl: "0.00052790441749966000", volumeDelta: "-0.7275610629648220", feesDelta: "-0.79453592205369641105", priceDelta: "-0.022531957606873866306947744576338000" },
    "7d": { volume: "563329450.67935400", fees: "313029.41344958477817992930", rewards: "0", yieldOverTvl: "0.00940232486104157000", priceDelta: null },
  },
  feeTierIndex: 4, adaptiveFeeEnabled: false, adaptiveFee: null, tradeEnableTimestamp: "1970-01-01T00:00:00Z",
};
const NVDAX_USDC_ORCA = {
  address: "6R4r93V5fcMzc13CL2enEepDSYcr4Qx3ptZBDwudTXCo", tokenMintA: NVDAX, tokenMintB: USDC,
  tokenA: { symbol: "NVDAx", decimals: 8, name: "NVIDIA xStock" }, tokenB: { symbol: "USDC", decimals: 6, name: "USD Coin" },
  tickSpacing: 2, feeRate: 200, protocolFeeRate: 1300, price: "215.6808751314676900", tvlUsdc: "136026.0959956818753777", liquidity: "178581685863", sqrtPrice: "27091031484481205672", tickCurrentIndex: 7686,
  tokenBalanceA: "51289576524", tokenBalanceB: "25449676915", protocolFeeOwedA: "1000", protocolFeeOwedB: "2000",
  stats: {
    "24h": { volume: "1012322.86114382", fees: "255.06444148977450919980", rewards: "0", yieldOverTvl: "0.00148891295263804000", priceDelta: "-0.01854084986823436777854671788100" },
    "7d": { volume: "2711248.36011975", fees: "985.38655257478202032519", rewards: "0", yieldOverTvl: "0.00398767325736352000", priceDelta: null },
  },
  adaptiveFeeEnabled: true,
  adaptiveFee: {
    currentRate: 2, maxRate: 24781,
    constants: { filterPeriod: 30, decayPeriod: 600, reductionFactor: 5000, adaptiveFeeControlFactor: 80000, maxVolatilityAccumulator: 880000, tickGroupSize: 2, majorSwapThresholdTicks: 2 },
    variables: { lastReferenceUpdateTimestamp: "2026-09-13T10:19:10Z", lastMajorSwapTimestamp: "2026-09-13T10:18:35Z", volatilityReference: 14402, tickGroupIndexReference: 3843, volatilityAccumulator: 14402 },
  },
  hasWarning: false, tradeEnableTimestamp: "1970-01-01T00:00:00Z", updatedAt: "2026-09-13T10:19:20.987776Z",
};
const SOL_NVDAX_ORCA = {
  address: "8Vy5Rjb9vg5nLb8L1r4Di8p9py5BTkp8UJSMHG8AD2zs", tokenMintA: SOL, tokenMintB: NVDAX,
  tokenA: { symbol: "SOL", decimals: 9, name: "Solana" }, tokenB: { symbol: "NVDAx", decimals: 8, name: "NVIDIA xStock" },
  tickSpacing: 16, feeRate: 1600, protocolFeeRate: 1300, price: "0.46248033562385225590", tvlUsdc: "22199.5393636522886336", liquidity: "2245782129615", sqrtPrice: "3967037978901569091", tickCurrentIndex: -30739,
  tokenBalanceA: "141382494988", tokenBalanceB: "3722036931",
  stats: {
    "24h": { volume: "111706.741101091000", fees: "219.70010366571009265119", rewards: null, yieldOverTvl: "0.0080743336865088", priceDelta: "-0.004214951316229729923795360484240530" },
    "7d": { volume: "422844.771714616000", fees: "3452.656788606857402482002000", rewards: null, priceDelta: null },
  },
  adaptiveFeeEnabled: true, adaptiveFee: { currentRate: 0, maxRate: 100000, constants: { maxVolatilityAccumulator: 440000 }, variables: { lastMajorSwapTimestamp: "2026-09-12T19:27:50Z", volatilityAccumulator: 0 } },
  hasWarning: false, tradeEnableTimestamp: "2026-08-01T00:00:00Z", updatedAt: "2026-09-13T10:17:56.294202Z",
};
const NVDAX_GLDX_ORCA = {
  address: "4CBVEUKELS6QTV3XAVLgTks5qiqKtYKKC2b7czfX2FN4", tokenMintA: NVDAX, tokenMintB: "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re",
  tokenA: { symbol: "NVDAx", decimals: 8, name: "NVIDIA xStock" }, tokenB: { symbol: "GLDx", decimals: 8, name: "Gold xStock" },
  tickSpacing: 96, feeRate: 6500, price: "0.54620021960564112687", tvlUsdc: "894.9684980607540237", tokenBalanceA: "95815655", tokenBalanceB: "172849834",
  stats: { "24h": { volume: "514.836098092241", fees: "31.62710205761124733700", priceDelta: "-0.014659761638354410813184041888804218" } },
  adaptiveFeeEnabled: true, hasWarning: false, tradeEnableTimestamp: "1970-01-01T00:00:00Z",
};

/** A fetch double that serves canned JSON per URL, with an optional first-call status. */
function fakeFetch(routes: (url: string) => { status?: number; body: unknown } | null, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const r = routes(url);
    if (!r) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function main(): Promise<void> {
  console.log("screener tests");

  /* ---------- quote selection and tick math ---------- */
  await test("pickQuote prefers USDC over SOL and rejects pairs with neither", () => {
    assert.deepEqual(pickQuote(SOL, USDC), { side: "B", symbol: "USDC", decimals: 6 });
    assert.deepEqual(pickQuote(USDC, NVDAX), { side: "A", symbol: "USDC", decimals: 6 });
    assert.deepEqual(pickQuote(SOL, NVDAX), { side: "A", symbol: "SOL", decimals: 9 });
    assert.deepEqual(pickQuote(NVDAX, SOL), { side: "B", symbol: "SOL", decimals: 9 });
    assert.equal(pickQuote(NVDAX, "Aigf5pKPyZW8nzxCrHEisE4tZMiUhFpKie8mYE7cmj6c"), null);
  });
  await test("tickFromPrice lands on Orca's own tickCurrentIndex", () => {
    assert.equal(tickFromPrice(215.68087513146769, 8, 6), 7686);
    assert.equal(tickFromPrice(99.846116066346259, 9, 6), -23043);
    assert.equal(tickFromPrice(0, 9, 6), 0);
  });

  /* ---------- Raydium ---------- */
  await test("raydium: RAY/WSOL with SOL as mint A flips the price to SOL per RAY", () => {
    const p = normalizeRaydium(RAY_SOL, NOW)!;
    assert.ok(p);
    assert.equal(p.venue, "raydium-clmm");
    assert.equal(p.address, "2AXXcN6oN9bBT5owwmTH53C7QHUXvhLeu718Kqt8rvY2");
    assert.equal(p.quoteSymbol, "SOL");
    assert.equal(p.quoteMint, SOL);
    assert.equal(p.baseSymbol, "RAY");
    assert.equal(p.name, "RAY / SOL");
    assert.equal(p.baseDecimals, 6);
    assert.equal(p.quoteDecimals, 9);
    near(p.price, 1 / 66.42067971744987);
    near(p.reserveQuote, 9656.620087438);
    near(p.reserveBase, 1390958.672213);
    near(p.tvlQuote, 9656.620087438 + 1390958.672213 / 66.42067971744987);
    near(p.quoteShare, 9656.620087438 / (9656.620087438 + 1390958.672213 / 66.42067971744987));
    assert.equal(p.stepBps, 10);
    assert.equal(p.binStep, 10);
    near(p.baseFeePct, 0.05);
    near(p.dynamicFeePct, 0.05);
    near(p.protocolSharePct, 12);
    assert.equal(p.tvlUsd, 3069177.96);
    assert.equal(p.volume24hUsd, 17701342.62769886);
    assert.equal(p.fees24hUsd, 8850.69764818891);
    assert.equal(p.priceChange24hPct, null);
    assert.equal(p.ageHours, null);
    assert.equal(p.adaptiveFee, false);
    assert.equal(p.activeBinId, tickFromPrice(66.42067971744987, 9, 6));
  });
  await test("raydium: NVDAx/USDC keeps the price as USDC per NVDAx and carries the API's TVL, volume and fees", () => {
    const p = normalizeRaydium(NVDAX_USDC_RAY, NOW)!;
    assert.equal(p.quoteSymbol, "USDC");
    assert.equal(p.baseMint, NVDAX);
    assert.equal(p.baseSymbol, "NVDAx");
    assert.equal(p.baseName, "NVIDIA xStock");
    near(p.price, 215.71636936481016);
    near(p.tvlQuote, 1035751.683125 + 5056.55939869 * 215.71636936481016);
    assert.equal(p.tvlUsd, 2126511.15);
    assert.equal(p.volume24hUsd, 1410864.3761611667);
    assert.equal(p.fees24hUsd, 1410.8845408468744);
    near(p.baseFeePct, 0.1);
    assert.equal(p.stepBps, 10);
  });
  await test("raydium: USDC/FLWS with USDC as mint A flips price and reserves; hasDynamicFee marks it adaptive", () => {
    const p = normalizeRaydium(USDC_FLWS, NOW)!;
    assert.equal(p.quoteSymbol, "USDC");
    assert.equal(p.baseSymbol, "FLWS");
    near(p.price, 1 / 0.17959402304028182);
    near(p.reserveQuote, 78871.90157);
    near(p.reserveBase, 3890.4269);
    near(p.tvlQuote, 100534.22, 1e-3);
    assert.equal(p.adaptiveFee, true);
    assert.equal(p.stepBps, 60);
    assert.equal(p.baseName, "1-800-FLOWERS.COM - Backpack Securities");
  });
  await test("raydium: openTime gives the age; WSOL is spelled SOL", () => {
    const p = normalizeRaydium(SOL_USDC_RAY, NOW)!;
    assert.equal(p.baseSymbol, "SOL");
    assert.equal(p.name, "SOL / USDC");
    near(p.ageHours, (NOW - 1723037622 * 1000) / 3600e3);
    assert.equal(p.stepBps, 1);
  });
  await test("raydium: a pool with neither SOL nor USDC is skipped, and so is a non-CLMM row", () => {
    assert.equal(normalizeRaydium(NVDAX_NVDGE, NOW), null);
    assert.equal(normalizeRaydium({ ...RAY_SOL, type: "Standard" }, NOW), null);
    assert.equal(normalizeRaydium({ ...RAY_SOL, price: 0 }, NOW), null);
    assert.equal(normalizeRaydium(null, NOW), null);
  });
  await test("raydium: pages until hasNextPage is false or the cap, retrying a 429", async () => {
    const page = (n: number, more: boolean) => ({ success: true, data: { count: 2, hasNextPage: more, data: [{ ...RAY_SOL, id: `p${n}a` }, { ...RAY_SOL, id: `p${n}b` }] } });
    let first429 = true;
    const calls: string[] = [];
    const fetchImpl = fakeFetch((url) => {
      const n = Number(new URL(url).searchParams.get("page"));
      if (n === 1 && first429) {
        first429 = false;
        return { status: 429, body: { error: "slow down" } };
      }
      return { body: page(n, n < 3) };
    }, calls);
    const capped = await fetchRaydium({ maxPages: 2, fetchImpl, pauseMs: 0, backoffMs: 1 });
    assert.equal(capped.pages, 2);
    assert.equal(capped.rows.length, 4);
    const all = await fetchRaydium({ maxPages: 10, fetchImpl, pauseMs: 0, backoffMs: 1 });
    assert.equal(all.pages, 3);
    assert.equal(all.rows.length, 6);
    assert.ok(calls[0].startsWith(raydiumPageUrl(1)));
    assert.ok(calls.every((u) => u.includes("poolType=concentrated") && u.includes("poolSortField=volume24h")));
  });

  /* ---------- Orca ---------- */
  await test("orca: SOL/USDC parses string numbers, raw balances, fee units and the 24h move", () => {
    const p = normalizeOrca(SOL_USDC_ORCA, NOW)!;
    assert.ok(p);
    assert.equal(p.venue, "orca-whirlpool");
    assert.equal(p.address, "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE");
    assert.equal(p.quoteSymbol, "USDC");
    assert.equal(p.baseMint, SOL);
    assert.equal(p.baseSymbol, "SOL");
    assert.equal(p.name, "SOL / USDC");
    near(p.price, 99.84611606634626);
    near(p.reserveBase, 148661.133090577);
    near(p.reserveQuote, 9073665.2853);
    near(p.tvlQuote, 9073665.2853 + 148661.133090577 * 99.84611606634626);
    near(p.tvlUsd, 23968180.69865180);
    near(p.volume24hUsd, 31628784.3609293);
    near(p.fees24hUsd, 15239.395078991274);
    near(p.priceChange24hPct, -2.2531957606873866);
    near(p.baseFeePct, 0.04);
    near(p.dynamicFeePct, 0.04);
    near(p.protocolSharePct, 13);
    assert.equal(p.stepBps, 4);
    assert.equal(p.binStep, 4);
    assert.equal(p.activeBinId, -23043);
    assert.equal(p.ageHours, null, "epoch-zero tradeEnableTimestamp means unknown age");
    assert.equal(p.lastTradeAt, null);
    assert.equal(p.adaptiveFee, false);
    assert.equal(p.protocolFeeBase, "81872009");
    assert.equal(p.protocolFeeQuote, "8717375");
  });
  await test("orca: an adaptive-fee NVDAx/USDC pool reports the variable rate on top of the base", () => {
    const p = normalizeOrca(NVDAX_USDC_ORCA, NOW)!;
    assert.equal(p.adaptiveFee, true);
    near(p.baseFeePct, 0.02);
    near(p.dynamicFeePct, 0.0202);
    assert.equal(p.lastTradeAt, Date.parse("2026-09-13T10:18:35Z"));
    assert.equal(p.volatilityAccumulator, 14402);
    assert.equal(p.maxVolatilityAccumulator, 880000);
    near(p.reserveBase, 512.89576524);
    near(p.reserveQuote, 25449.676915);
    assert.equal(p.baseName, "NVIDIA xStock");
  });
  await test("orca: SOL/NVDAx with SOL as token A flips to SOL per NVDAx; tradeEnableTimestamp gives the age", () => {
    const p = normalizeOrca(SOL_NVDAX_ORCA, NOW)!;
    assert.equal(p.quoteSymbol, "SOL");
    assert.equal(p.quoteMint, SOL);
    assert.equal(p.baseMint, NVDAX);
    assert.equal(p.baseSymbol, "NVDAx");
    near(p.price, 1 / 0.46248033562385226);
    near(p.reserveQuote, 141.382494988);
    near(p.reserveBase, 37.22036931);
    near(p.tvlQuote, 141.382494988 + 37.22036931 / 0.46248033562385226);
    near(p.baseFeePct, 0.16);
    assert.equal(p.stepBps, 16);
    near(p.ageHours, (NOW - Date.parse("2026-08-01T00:00:00Z")) / 3600e3);
  });
  await test("orca: NVDAx/GLDx has no SOL or USDC side and is skipped", () => {
    assert.equal(normalizeOrca(NVDAX_GLDX_ORCA, NOW), null);
    assert.equal(normalizeOrca({ ...SOL_USDC_ORCA, price: "0" }, NOW), null);
  });
  await test("orca: follows meta.cursor.next through `next=` until it runs out or the cap", async () => {
    const calls: string[] = [];
    const fetchImpl = fakeFetch((url) => {
      const next = new URL(url).searchParams.get("next");
      if (next === null) return { body: { data: [{ ...SOL_USDC_ORCA, address: "a1" }], meta: { cursor: { previous: null, next: "cur2" } } } };
      if (next === "cur2") return { body: { data: [{ ...SOL_USDC_ORCA, address: "a2" }], meta: { cursor: { previous: "cur1", next: "cur3" } } } };
      return { body: { data: [{ ...SOL_USDC_ORCA, address: "a3" }], meta: { cursor: { previous: "cur2", next: null } } } };
    }, calls);
    const all = await fetchOrca({ maxPages: 10, fetchImpl, pauseMs: 0, backoffMs: 1 });
    assert.equal(all.pages, 3);
    assert.deepEqual(all.rows.map((r) => (r as { address: string }).address), ["a1", "a2", "a3"]);
    assert.equal(calls[0], orcaPageUrl(null));
    assert.ok(calls[1].includes("next=cur2"), "second page is asked for with next=<cursor>");
    assert.ok(!calls[1].includes("cursor=cur2"), "the API ignores ?cursor=, so it is never sent");
    const capped = await fetchOrca({ maxPages: 2, fetchImpl, pauseMs: 0, backoffMs: 1 });
    assert.equal(capped.pages, 2);
    assert.equal(capped.rows.length, 2);
  });

  /* ---------- both venues through scanVenues ---------- */
  await test("scanVenues: filters to live SOL/USDC pools above the floor, sorted by volume; a failing venue reports an error and no throw", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.startsWith("https://api-v3.raydium.io/")) return { body: { success: true, data: { count: 5, hasNextPage: false, data: [RAY_SOL, NVDAX_USDC_RAY, USDC_FLWS, SOL_USDC_RAY, NVDAX_NVDGE] } } };
      if (url.startsWith("https://api.orca.so/")) return { status: 500, body: { message: "boom" } };
      return null;
    });
    const scans = await scanVenues({ venues: ["raydium-clmm", "orca-whirlpool"], minTvlSol: 20, raydiumMaxPages: 4, orcaMaxPages: 5, fetchImpl, pauseMs: 0, backoffMs: 1 });
    assert.equal(scans.length, 2);
    const ray = scans.find((s) => s.venue === "raydium-clmm")!;
    assert.equal(ray.error, null);
    assert.equal(ray.scanned, 5);
    assert.equal(ray.live, 4, "NVDAx/NVDGE has neither quote");
    assert.deepEqual(ray.pools.map((p) => p.name), ["RAY / SOL", "SOL / USDC", "FLWS / USDC", "NVDAx / USDC"]);
    const orca = scans.find((s) => s.venue === "orca-whirlpool")!;
    assert.equal(orca.scanned, 0);
    assert.ok(orca.error && orca.error.includes("500"));
    assert.equal(orca.pools.length, 0);
  });
  await test("isLive applies the SOL floor to SOL pools and x100 to USDC pools, and needs 24h volume", () => {
    const sol = normalizeRaydium(RAY_SOL, NOW)!;
    const usdc = normalizeRaydium(NVDAX_USDC_RAY, NOW)!;
    assert.equal(isLive(sol, 20), true);
    assert.equal(isLive({ ...sol, tvlQuote: 19 }, 20), false);
    assert.equal(isLive({ ...usdc, tvlQuote: 1999 }, 20), false);
    assert.equal(isLive({ ...usdc, tvlQuote: 2000 }, 20), true);
    assert.equal(isLive({ ...usdc, volume24hUsd: 0 }, 20), false);
    assert.equal(isLive({ ...usdc, volume24hUsd: null }, 20), false);
  });
  await test("venueEnv reads page caps and the venue list from the environment with defaults", () => {
    assert.deepEqual(venueEnv({}), { venues: ["raydium-clmm", "orca-whirlpool"], raydiumMaxPages: 4, orcaMaxPages: 5 });
    assert.deepEqual(venueEnv({ SCREEN_RAYDIUM_MAX_PAGES: "2", SCREEN_ORCA_MAX_PAGES: "0", SCREEN_VENUES: "orca-whirlpool, bogus" }), { venues: ["orca-whirlpool"], raydiumMaxPages: 2, orcaMaxPages: 0 });
    assert.deepEqual(venueEnv({ SCREEN_VENUES: "none" }).venues, []);
    assert.equal(venueEnv({ SCREEN_RAYDIUM_MAX_PAGES: "lots" }).raydiumMaxPages, 4);
  });

  /* ---------- the stock lens ---------- */
  await test("stockOf: xStocks mints start with Xs and carry TICKERx symbols", () => {
    assert.deepEqual(stockOf(NVDAX, "NVDAx"), { ticker: "NVDA", issuer: "xstocks" });
    assert.deepEqual(stockOf("XsXcJ6GZ9kVnjqGsjBnktRcuwMBmvKWh8S93RefZ1rF", "AMDx"), { ticker: "AMD", issuer: "xstocks" });
    assert.deepEqual(stockOf("XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4", "PLTRx"), { ticker: "PLTR", issuer: "xstocks" });
    assert.deepEqual(stockOf("XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", "TSLAx"), { ticker: "TSLA", issuer: "xstocks" });
    assert.deepEqual(stockOf("Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re", "GLDx"), { ticker: "GLD", issuer: "xstocks" });
    assert.deepEqual(stockOf("Xs1234567890abcdefghijklmnopqrstuvwxyzABCDE", "BRK.Bx"), { ticker: "BRK.B", issuer: "xstocks" });
  });
  await test("stockOf: the symbol alone is not trusted; ordinary tokens are not stocks", () => {
    assert.deepEqual(stockOf("4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", "NVDAx"), { ticker: "NVDA", issuer: "unknown" });
    assert.equal(verifiedStock(stockOf("4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", "NVDAx")), false);
    assert.equal(verifiedStock(stockOf(NVDAX, "NVDAx")), true);
    assert.equal(stockOf(SOL, "SOL"), null);
    assert.equal(stockOf("4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", "RAY"), null);
    assert.equal(stockOf(NVDAX, "nvdax"), null, "lowercase ticker does not match");
    assert.equal(stockOf(NVDAX, "TOOLONGx"), null, "seven letters is not a ticker");
    assert.equal(stockOf("Xsc9…9qEh", "Xsc9…9qEh"), null, "a shortened mint standing in for a symbol");
  });
  await test("stockOf: STOCK_MINTS and Backpack Securities names tag Backpack-issued stocks", () => {
    const extra = parseStockMints("FLWSojG1gB5VStYR3Sb4nQFRt43UBYkqih1j2CpVLqgd:FLWS, abc , def:aapl,,");
    assert.deepEqual([...extra.entries()], [["FLWSojG1gB5VStYR3Sb4nQFRt43UBYkqih1j2CpVLqgd", "FLWS"], ["abc", null], ["def", "AAPL"]]);
    assert.deepEqual(stockOf("FLWSojG1gB5VStYR3Sb4nQFRt43UBYkqih1j2CpVLqgd", "FLWS", null, extra), { ticker: "FLWS", issuer: "backpack" });
    assert.deepEqual(stockOf("abc", "MSFTx", null, extra), { ticker: "MSFT", issuer: "backpack" });
    assert.deepEqual(stockOf("abc", "hood", null, extra), { ticker: "HOOD", issuer: "backpack" });
    assert.deepEqual(stockOf("def", "whatever", null, extra), { ticker: "AAPL", issuer: "backpack" });
    assert.deepEqual(stockOf("FLWSojG1gB5VStYR3Sb4nQFRt43UBYkqih1j2CpVLqgd", "FLWS", "1-800-FLOWERS.COM - Backpack Securities", new Map()), { ticker: "FLWS", issuer: "backpack" });
    assert.equal(stockOf("FLWSojG1gB5VStYR3Sb4nQFRt43UBYkqih1j2CpVLqgd", "FLWS", "Flowers", new Map()), null);
    assert.equal(parseStockMints(undefined).size, 0);
  });

  /* ---------- board rows from venue pools ---------- */
  await test("partialFromVenue: API fees are feesSource api; fee/TVL and turnover use the API's TVL; the stock lens runs", () => {
    const v = normalizeRaydium(NVDAX_USDC_RAY, NOW)!;
    const p = partialFromVenue(v, 1);
    assert.equal(p.venue, "raydium-clmm");
    assert.equal(p.feesSource, "api");
    assert.equal(p.tvlUsd, 2126511.15);
    near(p.feeToTvl24hPct, (1410.8845408468744 / 2126511.15) * 100);
    near(p.turnover24h, 1410864.3761611667 / 2126511.15);
    near(p.priceUsd, 215.71636936481016);
    assert.deepEqual(p.stock, { ticker: "NVDA", issuer: "xstocks" });
    assert.equal(p.mcapUsd, null);
    assert.equal(p.fdvUsd, null);
    assert.equal(p.binRangePct, null);
    assert.equal(p.feesWindowHours, null);
    assert.equal("adaptiveFee" in p, false);
    assert.equal("baseName" in p, false);
  });
  await test("partialFromVenue: a Backpack Securities name tags the stock; SOL-quoted pools price in USD via the SOL price", () => {
    const flws = partialFromVenue(normalizeRaydium(USDC_FLWS, NOW)!, 1);
    assert.deepEqual(flws.stock, { ticker: "FLWS", issuer: "backpack" });
    const ray = partialFromVenue(normalizeRaydium(RAY_SOL, NOW)!, 100);
    near(ray.priceUsd, 100 / 66.42067971744987);
    assert.equal(ray.tvlUsd, 3069177.96, "the API's TVL wins over tvlQuote x SOL price");
    const noSol = partialFromVenue(normalizeRaydium(RAY_SOL, NOW)!, null);
    assert.equal(noSol.priceUsd, null);
    assert.equal(noSol.tvlUsd, 3069177.96);
  });
  await test("partialFromVenue: fees fall back to volume x base fee when the API leaves them out", () => {
    const v = { ...normalizeOrca(SOL_USDC_ORCA, NOW)!, fees24hUsd: null };
    const p = partialFromVenue(v, 1);
    assert.equal(p.feesSource, "estimate");
    near(p.fees24hUsd, 31628784.3609293 * 0.0004);
    const none = partialFromVenue({ ...v, volume24hUsd: null }, 1);
    assert.equal(none.feesSource, null);
    assert.equal(none.fees24hUsd, null);
  });

  /* ---------- the union shortlist, GeckoTerminal fill, SOL price ---------- */
  await test("shortlistUnion sorts by volume then TVL, unknown volume last, and cuts at the cap", () => {
    const rows = [
      { id: "meteora-no-vol", volume24hUsd: null, tvlUsd: 9e9 },
      { id: "small", volume24hUsd: 10, tvlUsd: 5 },
      { id: "big", volume24hUsd: 1000, tvlUsd: 1 },
      { id: "tie-a", volume24hUsd: 100, tvlUsd: 50 },
      { id: "tie-b", volume24hUsd: 100, tvlUsd: 500 },
    ];
    assert.deepEqual(shortlistUnion(rows, 10).map((r) => r.id), ["big", "tie-b", "tie-a", "small", "meteora-no-vol"]);
    assert.deepEqual(shortlistUnion(rows, 2).map((r) => r.id), ["big", "tie-b"]);
    assert.deepEqual(shortlistUnion(rows, 0), []);
    assert.equal(rows[0].id, "meteora-no-vol", "input is not mutated");
  });
  const gecko: Enrichment = {
    name: "NVDAx / USDC", baseSymbol: "NVDAx", quoteSymbol: "USDC", baseMint: NVDAX, quoteMint: USDC,
    priceUsd: 214.9, quotePriceUsd: 1.0002, reserveUsd: 2100000, volume24hUsd: 1500000, priceChange24hPct: -1.8, txns24h: 3210, fdvUsd: 12345678, mcapUsd: 11111111,
    createdAt: NOW - 30 * 24 * 3600e3,
  };
  await test("fillFromGecko fills only what is null and never overwrites an API figure", () => {
    const p = partialFromVenue(normalizeRaydium(NVDAX_USDC_RAY, NOW)!, 1);
    fillFromGecko(p, gecko, NOW);
    assert.equal(p.tvlUsd, 2126511.15);
    assert.equal(p.volume24hUsd, 1410864.3761611667);
    assert.equal(p.fees24hUsd, 1410.8845408468744);
    near(p.priceUsd, 215.71636936481016, 1e-9);
    assert.equal(p.priceChange24hPct, -1.8, "Raydium has no 24h change, so Gecko's fills it");
    assert.equal(p.mcapUsd, 11111111);
    assert.equal(p.fdvUsd, 12345678);
    assert.equal(p.txns24h, 3210);
    near(p.ageHours, 30 * 24);
    const orca = partialFromVenue(normalizeOrca(NVDAX_USDC_ORCA, NOW)!, 1);
    fillFromGecko(orca, gecko, NOW);
    near(orca.priceChange24hPct, -1.8540849868234368, 1e-9);
    assert.equal(fillFromGecko(orca, undefined, NOW), orca);
  });
  await test("fillFromGecko: when Gecko orients the pair the other way, USD price comes from its quote and token figures are left alone", () => {
    const p = partialFromVenue({ ...normalizeRaydium(NVDAX_USDC_RAY, NOW)!, tvlUsd: null }, null);
    assert.equal(p.priceUsd, null);
    fillFromGecko(p, { ...gecko, baseMint: USDC, quoteMint: NVDAX, priceUsd: 1.0002, quotePriceUsd: 214.9 }, NOW);
    assert.equal(p.priceUsd, 214.9);
    assert.equal(p.priceChange24hPct, null);
    assert.equal(p.mcapUsd, null);
    assert.equal(p.txns24h, 3210);
  });
  await test("venueSolPrice takes the deepest SOL/USDC pool across API venues", () => {
    const pools: VenuePool[] = [normalizeRaydium(RAY_SOL, NOW)!, normalizeOrca(SOL_USDC_ORCA, NOW)!, normalizeRaydium(SOL_USDC_RAY, NOW)!, normalizeOrca(SOL_NVDAX_ORCA, NOW)!];
    near(venueSolPrice(pools), 99.84611606634626);
    assert.equal(venueSolPrice([normalizeRaydium(RAY_SOL, NOW)!]), null);
  });

  /* ---------- scoring across venues ---------- */
  const scored = (v: VenuePool, adaptiveFee = false) => {
    const p = partialFromVenue(v, 1);
    return { ...p, ...scorePool(p, { adaptiveFee }), rank: 0 } as ScreenedPool;
  };
  await test("scorePool: the same scorer runs on venue rows; adaptive pools get the adaptive-fee flag; api fees get no onchain flag", () => {
    const orca = scored(normalizeOrca(NVDAX_USDC_ORCA, NOW)!, true);
    assert.ok(orca.score > 0 && orca.score <= 100);
    assert.ok(orca.flags.includes("adaptive-fee"));
    assert.ok(!orca.flags.includes("onchain-fees"));
    assert.ok(!orca.flags.includes("no-24h-data"));
    const ray = scored(normalizeRaydium(NVDAX_USDC_RAY, NOW)!);
    assert.ok(!ray.flags.includes("adaptive-fee"));
    assert.ok(!ray.flags.includes("thin"));
    const solNvda = scored(normalizeOrca(SOL_NVDAX_ORCA, NOW)!, true);
    assert.ok(!solNvda.flags.includes("thin"), "$22k sits just above the thin line");
    const thin = scored({ ...normalizeOrca(SOL_NVDAX_ORCA, NOW)!, tvlUsd: 9000 }, true);
    assert.ok(thin.flags.includes("thin"), "a $9k pool is thin");
    const blank = scorePool({ ...partialFromVenue(normalizeRaydium(RAY_SOL, NOW)!, 1), volume24hUsd: null, feeToTvl24hPct: null });
    assert.deepEqual(blank, { score: 0, flags: ["no-24h-data"] });
  });

  /* ---------- venue counts, tradable venues, legacy screens ---------- */
  await test("venueCounts pairs each venue with what it returned, what was live and what made the board", () => {
    const board = [scored(normalizeRaydium(NVDAX_USDC_RAY, NOW)!), scored(normalizeOrca(SOL_USDC_ORCA, NOW)!), scored(normalizeOrca(NVDAX_USDC_ORCA, NOW)!)];
    board[0].venue = "raydium-clmm";
    const counts = venueCounts({ scanned: 3000, live: 900 }, [
      { venue: "raydium-clmm", scanned: 2000, live: 1500, pools: [], ms: 1, pages: 4, error: null },
      { venue: "orca-whirlpool", scanned: 1000, live: 800, pools: [], ms: 1, pages: 5, error: null },
    ], board);
    assert.deepEqual(counts, [
      { venue: "meteora-dlmm", scanned: 3000, live: 900, ranked: 0 },
      { venue: "raydium-clmm", scanned: 2000, live: 1500, ranked: 1 },
      { venue: "orca-whirlpool", scanned: 1000, live: 800, ranked: 2 },
    ]);
  });
  await test("tradableVenue: Meteora DLMM and Raydium CLMM by default (TRADABLE_VENUES), Orca not yet", () => {
    assert.equal(tradableVenue({ venue: "meteora-dlmm" }), true);
    assert.equal(tradableVenue({ venue: "raydium-clmm" }), true);
    assert.equal(tradableVenue({ venue: "orca-whirlpool" }), false);
    const before = process.env.TRADABLE_VENUES;
    process.env.TRADABLE_VENUES = "meteora-dlmm";
    assert.equal(tradableVenue({ venue: "raydium-clmm" }), false);
    if (before === undefined) delete process.env.TRADABLE_VENUES;
    else process.env.TRADABLE_VENUES = before;
  });
  await test("normalizeScreen: a screen.json from before venues loads as a Meteora-only board with the new fields filled", () => {
    // A row exactly as data/screen.json wrote it before this change.
    const legacyPool = {
      address: "BDnKZBaPKCFmKDZxne73e2YBYCYQhZMzz4L6XaeuB8Uc", baseMint: "WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp", quoteMint: USDC, quoteSymbol: "USDC" as const,
      baseDecimals: 12, quoteDecimals: 6, binStep: 80, baseFeePct: 1, dynamicFeePct: 0, activeBinId: -946, price: 532.5208596366687, reserveBase: 29.986861697085, reserveQuote: 16853.987164,
      tvlQuote: 32822.61653273759, quoteShare: 0.5134870081789388, lastTradeAt: 1789261069000, volatilityAccumulator: 0, maxVolatilityAccumulator: 150000, protocolFeeBase: "140169938206", protocolFeeQuote: "72978314", protocolSharePct: 10,
      name: "wXMR / USDC", baseSymbol: "wXMR", tvlUsd: 32822.61653273759, volume24hUsd: 851709.105528601, fees24hUsd: 8517.09105528601, feesSource: "estimate" as const, feesWindowHours: null, feeToTvl24hPct: 25.948848553225428,
      turnover24h: 25.94884855322543, priceChange24hPct: 3.631, binRangePct: 0.8, txns24h: 8797, mcapUsd: 826449.001670702, fdvUsd: 826449.001670702, ageHours: 5205.448181388889, priceUsd: 528.3194622046523, score: 72.4, flags: ["hot"], rank: 1,
    };
    const nvdaPool = { ...legacyPool, address: "MeteoraNvdaPool111111111111111111111111111", baseMint: NVDAX, baseSymbol: "NVDAx", name: "NVDAx / USDC", rank: 2 };
    const legacy: LegacyScreen = { generatedAt: "2026-09-13T01:54:53.455Z", scanMs: 12345, scannedPools: 2955, livePools: 1200, rankedPools: 2, solPriceUsd: 101.2, pools: [legacyPool, nvdaPool] };
    const s = normalizeScreen(JSON.parse(JSON.stringify(legacy)));
    assert.equal(s.pools[0].venue, "meteora-dlmm");
    assert.equal(s.pools[0].stepBps, 80);
    assert.equal(s.pools[0].binStep, 80);
    assert.equal(s.pools[0].stock, null);
    assert.deepEqual(s.pools[1].stock, { ticker: "NVDA", issuer: "xstocks" });
    assert.deepEqual(s.venues, [{ venue: "meteora-dlmm", scanned: 2955, live: 1200, ranked: 2 }]);
    assert.equal(s.stocks, 1);
    assert.equal(s.scannedPools, 2955);
    assert.equal(s.rankedPools, 2);
    // A screen written by this version passes through untouched.
    const modern = { ...s, pools: s.pools.map((p) => ({ ...p, venue: "orca-whirlpool" as const, stock: null })), venues: [{ venue: "orca-whirlpool" as const, scanned: 1, live: 1, ranked: 2 }], stocks: 0 };
    const again = normalizeScreen(modern);
    assert.equal(again.pools[1].venue, "orca-whirlpool");
    assert.equal(again.pools[1].stock, null, "an explicit null stock is kept, not recomputed");
    assert.equal(again.stocks, 0);
    assert.deepEqual(again.venues, modern.venues);
  });

    await test("parseDexScreenerEnrichment: pairs by address with volume, txns, market cap, age and the quote's USD price from the two prices", () => {
    const json = { pairs: [{ pairAddress: "POOL1", baseToken: { address: "MINT", symbol: "PAID" }, quoteToken: { address: "So111", symbol: "SOL" }, priceUsd: "0.02", priceNative: "0.0002", liquidity: { usd: 293473 }, volume: { h24: 854292 }, priceChange: { h24: -12.5 }, txns: { h24: { buys: 1200, sells: 900 } }, fdv: 21500000, marketCap: 21500000, pairCreatedAt: 1758000000000 }, { nope: true }] };
    const e = parseDexScreenerEnrichment(json).get("POOL1")!;
    assert.equal(e.name, "PAID / SOL");
    assert.deepEqual([e.baseMint, e.quoteMint], ["MINT", "So111"]);
    assert.equal(e.volume24hUsd, 854292);
    assert.equal(e.txns24h, 2100);
    assert.equal(e.mcapUsd, 21500000);
    assert.equal(e.createdAt, 1758000000000);
    assert.equal(e.priceUsd, 0.02);
    assert.ok(Math.abs(e.quotePriceUsd! - 100) < 1e-9, "0.02 USD per PAID over 0.0002 SOL per PAID = 100 USD per SOL");
    assert.equal(parseDexScreenerEnrichment({}).size, 0);
  });

console.log(`\n${passed} screener tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
