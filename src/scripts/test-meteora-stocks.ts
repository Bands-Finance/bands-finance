/**
 * Meteora's tokenized stocks (src/screener/meteoraStocks.ts) and the stock tags they feed.
 * Pure: a saved answer from Meteora's pool discovery API (category rwa, 2026-09-15); no network.
 *   npx tsx src/scripts/test-meteora-stocks.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mr-bands-meteora-stocks-"));
process.env.DATA_DIR = tmp;

import {
  fetchMeteoraStockPools,
  issuerOfTags,
  meteoraStockCandidates,
  meteoraStockEnv,
  parseMeteoraPools,
  saveStockMints,
  stockMintMap,
  stockTagFromMap,
  tickerOf,
} from "../screener/meteoraStocks";
import { stockOf, verifiedStock } from "../screener/stocks";
import { stockBookPools } from "../venues/stocks";
import type { ScreenedPool } from "../screener/types";

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

const ANSWER = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "meteora-rwa-pools.json"), "utf8"));
const pools = parseMeteoraPools(ANSWER);
const by = (name: string) => pools.filter((p) => `${p.symbol}-${p.quoteSymbol}` === name || p.address === name);

async function main(): Promise<void> {
  console.log("meteora stocks / tags");
  await test("issuerOfTags and tickerOf: Meteora's tags decide the issuer; pre-IPO synthetics are unknown; commodities are not stocks", () => {
    assert.equal(issuerOfTags(["token-2022", "verified", "stocks", "rwa", "backpack"]), "backpack");
    assert.equal(issuerOfTags(["verified", "stocks", "xstocks", "equities"]), "xstocks");
    assert.equal(issuerOfTags(["stocks", "ondo"]), "ondo");
    assert.equal(issuerOfTags(["stocks", "prestocks", "pre-ipo"]), "unknown");
    assert.equal(issuerOfTags(["rwa", "tessera"]), "unknown");
    assert.equal(issuerOfTags(["rwa", "commodities"]), null);
    assert.equal(issuerOfTags(["verified"]), null);
    assert.equal(tickerOf("NVDAx", "xstocks"), "NVDA");
    assert.equal(tickerOf("MRNAon", "ondo"), "MRNA");
    assert.equal(tickerOf("SKHY", "backpack"), "SKHY");
  });

  await test("parseMeteoraPools on the real answer: stock pools kept with Meteora's numbers, the commodity dropped", () => {
    assert.equal(ANSWER.data.length, 13);
    assert.equal(pools.length, 12, "XAUt0 (gold) is not a stock");
    const skhy = by("SKHY-USDC")[0];
    assert.equal(skhy.issuer, "backpack");
    assert.equal(skhy.ticker, "SKHY");
    assert.equal(skhy.poolType, "dlmm");
    assert.equal(skhy.binStep, 80);
    assert.equal(skhy.feePct, 0.1);
    assert.ok(skhy.tvlUsd! > 2_000_000 && skhy.volume24hUsd! > 2_500_000 && skhy.fees24hUsd! > 2_000);
    assert.ok(Math.abs(skhy.feeToTvl24hPct! - (skhy.fees24hUsd! / skhy.tvlUsd!) * 100) < 0.01, "fee_tvl_ratio is fees over TVL in percent");
    assert.equal(by("MCDx-SOL")[0].ticker, "MCD");
    assert.equal(by("MCDx-SOL")[0].issuer, "xstocks");
    assert.equal(pools.find((p) => p.symbol === "MRNAon")!.issuer, "ondo");
    assert.equal(pools.find((p) => p.symbol === "ANTHROPIC")!.issuer, "unknown");
    assert.equal(pools.find((p) => p.symbol === "tOpenAI")!.issuer, "unknown");
    assert.equal(pools.find((p) => p.poolType === "damm_v2")!.issuer, "unknown", "the DAMM v2 row is a pre-IPO synthetic");
    assert.equal(pools.find((p) => p.symbol === "CRCLx")!.quoteSymbol, "MSTRx", "a stock quoted in another stock keeps its quote's symbol");
  });

  console.log("meteora stocks / the lane");
  const env = meteoraStockEnv({});
  await test("meteoraStockEnv: xStocks, Backpack and Ondo by default; $20k of depth; three pools; a 15-minute refresh; METEORA_STOCKS=false closes it", () => {
    assert.deepEqual(env, { on: true, issuers: ["xstocks", "backpack", "ondo"], minTvlUsd: 20_000, maxPools: 3, refreshMin: 15 });
    assert.equal(meteoraStockEnv({ METEORA_STOCKS: "false" }).on, false);
    assert.deepEqual(meteoraStockEnv({ METEORA_STOCK_ISSUERS: "backpack, prestocks" }).issuers, ["backpack"], "pre-IPO issuers are never allowed");
  });

  await test("meteoraStockCandidates: DLMM, SOL or USDC, an allowed issuer, the floors, the best pool per ticker by fee/TVL, best first", () => {
    const all = meteoraStockCandidates(pools, env, { minVolume24hUsd: 250_000, quoteOk: () => true });
    const names = all.map((p) => `${p.symbol}-${p.quoteSymbol}`);
    assert.ok(!names.some((n) => /ANTHROPIC|tOpenAI|NEURALINK|MRNAon|CRCLx/.test(n)), `no pre-IPO, no pool under the floors, no stock-quoted pool: ${names}`);
    assert.equal(new Set(all.map((p) => p.ticker)).size, all.length, "one pool per ticker");
    for (let i = 1; i < all.length; i++) assert.ok((all[i - 1].feeToTvl24hPct ?? 0) >= (all[i].feeToTvl24hPct ?? 0), "best fee/TVL first");
    const bros = all.find((p) => p.ticker === "BROS")!;
    assert.equal(bros.quoteSymbol, "USDC", "BROS-USDC ($21k deep, 4.3% of its depth in fees a day) beats BROS-SOL (1.6%) for the ticker");
    const thinFloor = meteoraStockCandidates(pools, { ...env, minTvlUsd: 50_000 }, { minVolume24hUsd: 250_000, quoteOk: () => true });
    assert.equal(thinFloor.find((p) => p.ticker === "BROS")!.quoteSymbol, "SOL", "with a $50k depth floor the thin USDC pool is out and BROS-SOL takes the ticker");
    assert.ok(all.some((p) => p.ticker === "SKHY") && all.some((p) => p.ticker === "MU"));
    const solOnly = meteoraStockCandidates(pools, env, { minVolume24hUsd: 250_000, quoteOk: (q) => q === "SOL" });
    assert.ok(solOnly.every((p) => p.quoteSymbol === "SOL"));
    assert.deepEqual(meteoraStockCandidates(pools, { ...env, on: false }, { minVolume24hUsd: 0, quoteOk: () => true }), []);
  });

  console.log("meteora stocks / the tags everywhere else");
  await test("the stock mints file: a Backpack token the on-chain scan names only by symbol is a stock; pre-IPO is tagged but not verified; the stock book never seats it", () => {
    const map = stockMintMap(pools);
    const skhy = by("SKHY-USDC")[0];
    const anth = pools.find((p) => p.symbol === "ANTHROPIC")!;
    assert.deepEqual(stockTagFromMap(map, skhy.mint), { ticker: "SKHY", issuer: "backpack" });
    assert.equal(stockOf(skhy.mint, "SKHY"), null, "before the file exists, our own detector cannot tell SKHY is a stock");
    saveStockMints(tmp, map);
    assert.deepEqual(stockOf(skhy.mint, "SKHY"), { ticker: "SKHY", issuer: "backpack" }, "after it, it can");
    assert.deepEqual(stockOf(anth.mint, "ANTHROPIC"), { ticker: "ANTHROPIC", issuer: "unknown" });
    assert.equal(verifiedStock(stockOf(anth.mint, "ANTHROPIC")), false);
    const row = (over: Partial<ScreenedPool>): ScreenedPool => ({ address: "a", venue: "meteora-dlmm", quoteSymbol: "USDC", tvlUsd: 3_000_000, flags: [], feeToTvl24hPct: 1, stock: null, ...over }) as ScreenedPool;
    const book = stockBookPools([row({ address: "skhy", stock: { ticker: "SKHY", issuer: "backpack" } }), row({ address: "anth", stock: { ticker: "ANTHROPIC", issuer: "unknown" } })], true, 0, { TRADABLE_VENUES: "meteora-dlmm" });
    assert.deepEqual(book.map((p) => p.address), ["skhy"]);
  });

  await test("fetchMeteoraStockPools: the RWA category busiest first, paged by after_key, stops when there is no more or volume falls under the floor", async () => {
    const urls: string[] = [];
    const page = (rows: unknown[], hasMore: boolean, after: string | null) => new Response(JSON.stringify({ data: rows, has_more: hasMore, after_key: after }), { status: 200 });
    const [a, b, c] = [ANSWER.data.slice(0, 5), ANSWER.data.slice(5, 9), ANSWER.data.slice(9)];
    let i = 0;
    const got = await fetchMeteoraStockPools({ pageSize: 5, sleep: async () => {}, fetch: async (u) => { urls.push(String(u)); i++; return i === 1 ? page(a, true, "k1") : i === 2 ? page(b, true, "k2") : page(c, false, null); } });
    assert.equal(urls.length, 3);
    const first = new URL(urls[0]);
    assert.equal(first.origin + first.pathname, "https://pool-discovery-api.datapi.meteora.ag/pools");
    assert.equal(first.searchParams.get("category"), "rwa");
    assert.equal(first.searchParams.get("sort_by"), "volume_24h:desc");
    assert.equal(new URL(urls[1]).searchParams.get("after_key"), "k1");
    assert.equal(got.length, 12);
    let j = 0;
    const early = await fetchMeteoraStockPools({ pageSize: 5, sleep: async () => {}, stopBelowVolumeUsd: 1_000_000, fetch: async () => { j++; return page(a, true, "k1"); } });
    assert.equal(j, 1, "the first page already dips under $1M a day: no second call");
    assert.ok(early.length > 0);
    await assert.rejects(fetchMeteoraStockPools({ fetch: async () => new Response("no", { status: 503 }) }), /HTTP 503/);
  });

  console.log(`\n${passed} meteora stock tests passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
