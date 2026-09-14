/**
 * The LAUNCH LANE and sibling-pool discovery: the two halves of "the desk saw WET and did nothing".
 *
 *   detection  a token that trends in a pool we cannot quote gets its OTHER pools looked up
 *              (src/hot: siblingTargets, usableSiblings, fetchTokenPools, runHotTick)
 *   entry      a pool too new for the board, the score and the watchlist is admitted by rule
 *              (src/screener/launch.ts), seated under a cap, stopped tighter, and expired
 *
 * Fixture: GeckoTerminal GET /networks/solana/tokens/H1q6vF9X.../pools, captured live 2026-09-14,
 * two hours after WET launched. It is the real shape and the real numbers, trimmed to the attributes
 * the parser reads. No network, no disk outside a temp dir, no clock.
 *   npm run test:launch
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hotPicks,
  launchRowOf,
  parseTokenPools,
  runHotTick,
  siblingTargets,
  TOKEN_POOLS_URL,
  TRENDING_URL,
  usableSiblings,
  type HotFile,
  SIBLING_FAIL_TTL_MS,
  type HotRow,
  type PoolSample,
  type SiblingCacheEntry,
} from "../hot";
import { fetchTokenPools } from "../hot/sources";
import {
  launchEnv,
  launchExpiry,
  launchSeats,
  launchSeatSol,
  launchVerdict,
  type LaunchCandidate,
  type LaunchEnv,
  type LaunchRow,
} from "../screener/launch";
import { watchlistDenial, watchlistRefusal, addToken, denyToken, emptyWatchlist, type Watchlist } from "../screener/watchlist";
import { engineDirective } from "../engine/directives";
import { bandStopPct, forgetBand, rollStop } from "../engine/exit";
import { policyDecide } from "../agent/policy";
import type { Observation } from "../agent/observation";
import type { RiskLimits } from "../risk/limits";
import { emptyState, type RiskState } from "../risk/state";
import type { EngineConfig } from "../config";
import { emptyEngineState } from "../engine/breakers";
import type { PoolSnapshot, PositionSnapshot } from "../tools/dlmm";

let n = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      n++;
      console.log(`  ok  ${name}`);
    })
    .catch((err) => {
      console.error(`FAIL  ${name}`);
      console.error(err);
      process.exit(1);
    });
}

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WET = "H1q6vF9X2ewo7XxqJ2qb2uTdwkjDLAWF1Y3SefRAUTGZ";
const WET_PTN = "8dAEnVvvbHPoh5fAGrGcMqH75r5wwN1qbHn2FRRcJzqQ";
const WET_SOL = "5io9sGtFUQFkhjp1hqQH5Yo6G1qLVVdttg33KjGbJVxR";
const WET_SOL_2 = "8uqobZuBAnuXN2USMuhytZ3zB3J95MihifRtX7Z7EYyh";
const WET_SOL_3 = "AzhLeALXyXpgeoyamm7tjufEoCuwc2HYQs5f8yh5kXHa";
const WET_USDC = "HtCKq4Zvbr3HBnTVF6GJD5CydnJWmeUVFV4PgPQ6VrMV";
/** 2026-09-14T22:30Z: about 2.4h after the first WET pool opened at 20:06Z. */
const NOW = Date.parse("2026-09-14T22:30:00Z");
const M = 60_000;
const H = 3600_000;
const tradableVenue = (v: string) => v === "meteora-dlmm" || v === "raydium-clmm";

/* ---------- the fixture: a real GeckoTerminal token-pools response ---------- */
const WET_POOLS = {"data":[{"id":"solana_8dAEnVvvbHPoh5fAGrGcMqH75r5wwN1qbHn2FRRcJzqQ","type":"pool","attributes":{"base_token_price_usd":"0.0008733922036","quote_token_price_usd":"13.6115018935993254290284247697155731309644389529470655992803276","address":"8dAEnVvvbHPoh5fAGrGcMqH75r5wwN1qbHn2FRRcJzqQ","name":"WET / PTN","pool_created_at":"2026-09-14T20:06:08Z","price_change_percentage":{"m5":"-34.87","h1":"-53.01","h24":"755.3"},"transactions":{"m5":{"buys":124,"sells":59,"buyers":71,"sellers":53},"h1":{"buys":2905,"sells":1823,"buyers":1185,"sellers":1044}},"volume_usd":{"m5":"37248.4947569975","h1":"676460.736176459","h24":"2960730.3083559"},"reserve_in_usd":"89612.6227"},"relationships":{"base_token":{"data":{"id":"solana_H1q6vF9X2ewo7XxqJ2qb2uTdwkjDLAWF1Y3SefRAUTGZ","type":"token"}},"quote_token":{"data":{"id":"solana_PTNzAfFAB4LvoUQEUUGrFMyUoRLExMYjH6CcfyQfsVP","type":"token"}},"dex":{"data":{"id":"raydium","type":"dex"}}}},{"id":"solana_5io9sGtFUQFkhjp1hqQH5Yo6G1qLVVdttg33KjGbJVxR","type":"pool","attributes":{"base_token_price_usd":"0.001024751921","quote_token_price_usd":"103.11174441693005240612250787203333167732529086","address":"5io9sGtFUQFkhjp1hqQH5Yo6G1qLVVdttg33KjGbJVxR","name":"WET / SOL","pool_created_at":"2026-09-14T20:32:49Z","price_change_percentage":{"m5":"-23.31","h1":"-46.7","h24":"346.36"},"transactions":{"m5":{"buys":18,"sells":15,"buyers":16,"sellers":14},"h1":{"buys":855,"sells":894,"buyers":521,"sellers":588}},"volume_usd":{"m5":"3461.5394148263","h1":"180804.339144312","h24":"478979.947487606"},"reserve_in_usd":"15465.5271"},"relationships":{"base_token":{"data":{"id":"solana_H1q6vF9X2ewo7XxqJ2qb2uTdwkjDLAWF1Y3SefRAUTGZ","type":"token"}},"quote_token":{"data":{"id":"solana_So11111111111111111111111111111111111111112","type":"token"}},"dex":{"data":{"id":"meteora","type":"dex"}}}},{"id":"solana_8uqobZuBAnuXN2USMuhytZ3zB3J95MihifRtX7Z7EYyh","type":"pool","attributes":{"base_token_price_usd":"0.0009431131385","quote_token_price_usd":"103.048760595927669898014334986340197713206574228","address":"8uqobZuBAnuXN2USMuhytZ3zB3J95MihifRtX7Z7EYyh","name":"WET / SOL","pool_created_at":"2026-09-14T20:44:01Z","price_change_percentage":{"m5":"-21.39","h1":"-53.29","h24":"34.54"},"transactions":{"m5":{"buys":20,"sells":14,"buyers":16,"sellers":12},"h1":{"buys":368,"sells":363,"buyers":233,"sellers":234}},"volume_usd":{"m5":"1629.3897769891","h1":"50879.6309284343","h24":"203146.579474283"},"reserve_in_usd":"3602.9409"},"relationships":{"base_token":{"data":{"id":"solana_H1q6vF9X2ewo7XxqJ2qb2uTdwkjDLAWF1Y3SefRAUTGZ","type":"token"}},"quote_token":{"data":{"id":"solana_So11111111111111111111111111111111111111112","type":"token"}},"dex":{"data":{"id":"meteora","type":"dex"}}}},{"id":"solana_AzhLeALXyXpgeoyamm7tjufEoCuwc2HYQs5f8yh5kXHa","type":"pool","attributes":{"base_token_price_usd":"0.0009389762073","quote_token_price_usd":"103.048662658791022860868814219322823829010612554","address":"AzhLeALXyXpgeoyamm7tjufEoCuwc2HYQs5f8yh5kXHa","name":"WET / SOL","pool_created_at":"2026-09-14T20:40:43Z","price_change_percentage":{"m5":"-22.25","h1":"-54.85","h24":"114.23"},"transactions":{"m5":{"buys":5,"sells":14,"buyers":4,"sellers":12},"h1":{"buys":217,"sells":182,"buyers":142,"sellers":109}},"volume_usd":{"m5":"592.0726364435","h1":"23256.418704727","h24":"91598.6321623081"},"reserve_in_usd":"1858.371"},"relationships":{"base_token":{"data":{"id":"solana_H1q6vF9X2ewo7XxqJ2qb2uTdwkjDLAWF1Y3SefRAUTGZ","type":"token"}},"quote_token":{"data":{"id":"solana_So11111111111111111111111111111111111111112","type":"token"}},"dex":{"data":{"id":"meteora","type":"dex"}}}},{"id":"solana_HtCKq4Zvbr3HBnTVF6GJD5CydnJWmeUVFV4PgPQ6VrMV","type":"pool","attributes":{"base_token_price_usd":"0.0007879529639","quote_token_price_usd":"1.000000000000003565227027051161","address":"HtCKq4Zvbr3HBnTVF6GJD5CydnJWmeUVFV4PgPQ6VrMV","name":"WET / USDC","pool_created_at":"2026-09-14T21:36:06Z","price_change_percentage":{"m5":"-28.14","h1":"-56.16","h24":"-64.87"},"transactions":{"m5":{"buys":5,"sells":5,"buyers":5,"sellers":4},"h1":{"buys":35,"sells":26,"buyers":28,"sellers":20}},"volume_usd":{"m5":"792.3156374704","h1":"1801.5550311718","h24":"2074.6619666657"},"reserve_in_usd":"3397.5692"},"relationships":{"base_token":{"data":{"id":"solana_H1q6vF9X2ewo7XxqJ2qb2uTdwkjDLAWF1Y3SefRAUTGZ","type":"token"}},"quote_token":{"data":{"id":"solana_EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","type":"token"}},"dex":{"data":{"id":"raydium-clmm","type":"dex"}}}},{"id":"solana_67dojhKw7QJxD5He5BwGhroszfKask6uzuP9HDbNAKhP","type":"pool","attributes":{"base_token_price_usd":"0.001264112587","quote_token_price_usd":"103.219502905631479762602227825696361550728126113","address":"67dojhKw7QJxD5He5BwGhroszfKask6uzuP9HDbNAKhP","name":"WET / SOL","pool_created_at":"2026-09-14T20:34:52Z","price_change_percentage":{"m5":"0","h1":"0","h24":"508.65"},"transactions":{"m5":{"buys":0,"sells":0,"buyers":0,"sellers":0},"h1":{"buys":0,"sells":0,"buyers":0,"sellers":0}},"volume_usd":{"m5":"0.0","h1":"0.0","h24":"15.3004796099"},"reserve_in_usd":"69.0941"},"relationships":{"base_token":{"data":{"id":"solana_H1q6vF9X2ewo7XxqJ2qb2uTdwkjDLAWF1Y3SefRAUTGZ","type":"token"}},"quote_token":{"data":{"id":"solana_So11111111111111111111111111111111111111112","type":"token"}},"dex":{"data":{"id":"meteora-damm-v2","type":"dex"}}}},{"id":"solana_YenMA1sYRmgx5E1fEsRcs1gXWyyxvygjw75u61M8NCk","type":"pool","attributes":{"base_token_price_usd":"0.00004046237034","quote_token_price_usd":"0.001028373554971780817413990785472281987928935062088362234963161026","address":"YenMA1sYRmgx5E1fEsRcs1gXWyyxvygjw75u61M8NCk","name":"LMEOW / WET","pool_created_at":"2026-09-14T20:57:51Z","price_change_percentage":{"m5":"0.06","h1":"-41.58","h24":"-7.12"},"transactions":{"m5":{"buys":0,"sells":2,"buyers":0,"sellers":2},"h1":{"buys":22,"sells":24,"buyers":17,"sellers":15}},"volume_usd":{"m5":"1.5515825458","h1":"13.3762531918","h24":"21.7272213004"},"reserve_in_usd":"21.8734"},"relationships":{"base_token":{"data":{"id":"solana_6eKhUqSm6RjvA6vbk9gEXBGnMRGfyPWUJmg2VQVWpump","type":"token"}},"quote_token":{"data":{"id":"solana_H1q6vF9X2ewo7XxqJ2qb2uTdwkjDLAWF1Y3SefRAUTGZ","type":"token"}},"dex":{"data":{"id":"meteora-damm-v2","type":"dex"}}}}]}
;

const env = (over: Partial<LaunchEnv> = {}): LaunchEnv => ({ ...launchEnv({}), ...over });

/* ================= 1. detection: sibling pools ================================================ */

async function detection(): Promise<void> {
  console.log("launch lane / detection");

  await test("parseTokenPools reads the real token-pools response: 7 pools, trending's own shape", () => {
    const rows = parseTokenPools(WET_POOLS);
    assert.equal(rows.length, 7);
    for (const r of rows) assert.equal(r.source, "siblings", "a sibling row is labelled, then treated like any other");
    const ptn = rows.find((r) => r.address === WET_PTN)!;
    assert.equal(ptn.name, "WET / PTN");
    assert.equal(ptn.venue, "raydium");
    assert.equal(ptn.baseMint, WET);
    assert.equal(ptn.quoteSymbol, "PTN", "the quote the book cannot seat");
    assert.equal(ptn.vol24hUsd, 2_960_730.3083559);
    assert.equal(ptn.vol1hUsd, 676_460.736176459);
    assert.equal(ptn.liquidityUsd, 89_612.6227);
    assert.equal(ptn.createdAt, Date.parse("2026-09-14T20:06:08Z"));
    const sol = rows.find((r) => r.address === WET_SOL)!;
    assert.equal(sol.venue, "meteora-dlmm", "GeckoTerminal says `meteora`, we say meteora-dlmm");
    assert.equal(sol.quoteMint, SOL);
    assert.equal(sol.quoteSymbol, "SOL");
    assert.equal(sol.liquidityUsd, 15_465.5271);
    assert.equal(sol.vol24hUsd, 478_979.947487606);
    assert.equal(rows.find((r) => r.address === WET_USDC)!.venue, "raydium-clmm");
  });

  await test("usableSiblings keeps what the loop could actually quote, biggest first, capped", () => {
    const rows = parseTokenPools(WET_POOLS);
    const usable = usableSiblings(rows, WET, tradableVenue);
    assert.deepEqual(usable.map((r) => r.address), [WET_SOL, WET_SOL_2, WET_SOL_3, WET_USDC], "SOL and USDC quotes on tradable venues, 24h volume first");
    assert.ok(!usable.some((r) => r.address === WET_PTN), "the PTN-quoted pool is dropped: the book seats SOL and USDC");
    assert.ok(!usable.some((r) => r.venue === "meteora-damm-v2"), "an untradable venue is dropped, and so is LMEOW/WET (WET is the quote there)");
    assert.equal(usableSiblings(rows, WET, tradableVenue, 2).length, 2, "the per-token cap");
    assert.equal(usableSiblings(rows, WET, () => false).length, 0, "no tradable venue, no siblings");
  });

  await test("siblingTargets: only tokens we cannot already quote, over the volume floor, most promising first, capped", () => {
    const sample = (over: Partial<PoolSample>): PoolSample => ({
      source: "trending", address: "a", name: null, venue: "pumpswap", baseMint: "mintA", quoteMint: SOL, baseSymbol: "A", quoteSymbol: "SOL",
      priceUsd: null, quotePriceUsd: null, liquidityUsd: 50_000, vol5mUsd: null, vol1hUsd: null, vol24hUsd: 1_000_000,
      buys5m: null, sells5m: null, buys1h: null, sells1h: null, priceChange5mPct: null, priceChange1hPct: null, priceChange24hPct: null, createdAt: null, ...over,
    });
    const rows = [
      sample({ address: "p1", baseMint: "big", baseSymbol: "BIG", vol24hUsd: 9_000_000 }),            // untradable venue
      sample({ address: "p2", baseMint: "mid", baseSymbol: "MID", vol24hUsd: 2_000_000, venue: "raydium", quoteMint: "ptn", quoteSymbol: "PTN" }), // untradable quote
      sample({ address: "p3", baseMint: "small", baseSymbol: "SML", vol24hUsd: 100_000 }),             // under the floor
      sample({ address: "p4", baseMint: "ok", baseSymbol: "OK", vol24hUsd: 8_000_000, venue: "meteora-dlmm" }), // we can already quote it
      sample({ address: "p5", baseMint: SOL, baseSymbol: "SOL", vol24hUsd: 80_000_000 }),              // the quote token itself
    ];
    const t = siblingTargets(rows, { minVol24hUsd: 500_000, max: 6, tradable: tradableVenue });
    assert.deepEqual(t.map((x) => x.mint), ["big", "mid"], "the two untradable, above-the-floor tokens, biggest first");
    assert.equal(t[0].symbol, "BIG");
    assert.equal(t[0].from, "p1", "the row that flagged it, for the log line");
    assert.deepEqual(siblingTargets(rows, { minVol24hUsd: 500_000, max: 1, tradable: tradableVenue }).map((x) => x.mint), ["big"], "the budget takes the most promising first");
    assert.deepEqual(siblingTargets(rows, { minVol24hUsd: 500_000, max: 6, tradable: tradableVenue, cached: (m) => m === "big" }).map((x) => x.mint), ["mid"], "a cached token is not refetched");
    assert.deepEqual(siblingTargets(rows, { minVol24hUsd: 10_000_000, max: 6, tradable: tradableVenue }), [], "nothing clears a floor that high");
    // a token with BOTH a tradable and an untradable pool on the feed needs no lookup at all
    const both = [...rows, sample({ address: "p6", baseMint: "big", baseSymbol: "BIG", venue: "meteora-dlmm", vol24hUsd: 20_000 })];
    assert.deepEqual(siblingTargets(both, { minVol24hUsd: 500_000, max: 6, tradable: tradableVenue }).map((x) => x.mint), ["mid"]);
  });

  await test("fetchTokenPools: one call per mint, paced, a 429 backs off, a failure is named and never thrown", async () => {
    const calls: string[] = [];
    const waits: number[] = [];
    let first429 = true;
    const fetchImpl = (async (input: string) => {
      calls.push(input);
      if (input.includes("BAD")) return new Response("nope", { status: 500 });
      if (first429 && input.includes(WET)) {
        first429 = false;
        return new Response("{}", { status: 429 });
      }
      return new Response(JSON.stringify(WET_POOLS), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const r = await fetchTokenPools([WET, "BAD"], { fetchImpl, sleep: async (ms) => void waits.push(ms) });
    assert.equal(calls[0], TOKEN_POOLS_URL(WET));
    assert.equal(calls[1], TOKEN_POOLS_URL(WET), "the 429 is retried on the same URL");
    assert.equal(calls[2], TOKEN_POOLS_URL("BAD"));
    assert.deepEqual(waits, [20_000, 2200], "the 429 backoff, then the pace between mints");
    assert.equal(r.calls, 3, "WET twice (429 then the retry) and BAD once: a 500 is not retried, only a 429 is");
    assert.equal(r.byMint.get(WET)!.length, 7);
    assert.equal(r.byMint.has("BAD"), false);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /sibling pools BAD: HTTP 500/);
  });

  await test("runHotTick: WET trends in a pool we cannot quote, and the tick surfaces the WET/SOL pools it can", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bands-launch-"));
    // trending carries ONLY the PTN-quoted pool: exactly Zach's complaint.
    const trending = { data: (WET_POOLS as { data: unknown[] }).data.filter((d) => (d as { attributes: { address: string } }).attributes.address === WET_PTN) };
    const dexPairs = (addrs: string[]) => ({
      pairs: parseTokenPools(WET_POOLS)
        .filter((r) => addrs.includes(r.address))
        .map((r) => ({
          chainId: "solana", dexId: r.venue === "meteora-dlmm" ? "meteora" : "raydium", pairAddress: r.address, labels: r.venue === "meteora-dlmm" ? ["DLMM"] : ["CLMM"],
          baseToken: { address: r.baseMint, symbol: r.baseSymbol }, quoteToken: { address: r.quoteMint, symbol: r.quoteSymbol },
          volume: { h24: r.vol24hUsd, h1: r.vol1hUsd, m5: r.vol5mUsd }, txns: { m5: { buys: r.buys5m, sells: r.sells5m }, h1: { buys: r.buys1h, sells: r.sells1h } },
          priceChange: { m5: r.priceChange5mPct, h1: r.priceChange1hPct, h24: r.priceChange24hPct },
          liquidity: { usd: r.liquidityUsd }, pairCreatedAt: r.createdAt,
        })),
    });
    const calls: string[] = [];
    const fetchImpl = (async (input: string) => {
      calls.push(input);
      const u = new URL(input);
      const body = u.host === "api.dexscreener.com" ? dexPairs(u.pathname.split("/").pop()!.split(",")) : u.pathname.includes("/tokens/") ? WET_POOLS : trending;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const siblingCache = new Map<string, SiblingCacheEntry>();
    const tick = async (now: number, siblingLookups: number, siblingTtlMin = 30, cache = siblingCache, impl = fetchImpl): Promise<HotFile> =>
      runHotTick({
        dataDir: dir, screen: null, held: [], now, durations: ["1h"], fetchImpl: impl, sleep: async () => {},
        readFee: async () => null, feeCache: new Map(), siblingCache: cache, tradableVenue,
        env: { minLiquidityUsd: 1000, minAgeHours: 12, siblingLookups, siblingMinVol24hUsd: 500_000, siblingTtlMin, onchainReads: 0 },
        log: () => {},
      });

    // (a) lookups off: only the pool we cannot trade, which is what the desk saw on the day.
    const before = await tick(NOW, 0);
    assert.deepEqual(before.rows.map((r) => r.address), [WET_PTN]);
    assert.equal(before.sources.siblingLookups, 0);
    assert.equal(before.sources.siblingRows, 0);

    // (b) lookups on: the WET/SOL pools join the same pipeline and come out as ordinary rows.
    calls.length = 0;
    const after = await tick(NOW + M, 6);
    assert.ok(calls.includes(TOKEN_POOLS_URL(WET)), "the token's other pools were asked for");
    assert.equal(after.sources.siblingLookups, 1, "one token, one call");
    assert.equal(after.sources.siblingRows, 4, "the four SOL/USDC-quoted WET pools on tradable venues reached the board");
    const addrs = after.rows.map((r) => r.address);
    assert.ok(addrs.includes(WET_SOL), "the $15k / $479k WET/SOL pool on Meteora, which the desk could have quoted");
    assert.ok(addrs.includes(WET_SOL_2));
    const sol = after.rows.find((r) => r.address === WET_SOL)!;
    assert.equal(sol.venue, "meteora-dlmm");
    assert.equal(sol.quoteSymbol, "SOL");
    assert.ok(sol.flags.includes("new"), "it is new, and the hot watch still says so");
    assert.ok((sol.vol1hUsd ?? 0) > 100_000, "with the last hour's real volume on it");
    assert.equal(after.sources.errors.length, 0);

    // (c) the TTL: the next tick inside the window reuses the cached list and makes no lookup call.
    calls.length = 0;
    const cached = await tick(NOW + 2 * M, 6);
    assert.equal(cached.sources.siblingLookups, 0, "cached inside HOT_SIBLING_TTL_MIN");
    assert.ok(!calls.some((c) => c.includes("/tokens/")), "and no call goes out");
    assert.ok(cached.rows.some((r) => r.address === WET_SOL), "the rows are still there");

    // (d) at the TTL exactly it is still fresh (strictly older is stale); past it, one fresh lookup.
    calls.length = 0;
    assert.equal((await tick(NOW + 31 * M, 6)).sources.siblingLookups, 0, "fetched at NOW+1m, still fresh 30 min later");
    const stale = await tick(NOW + 32 * M, 6);
    assert.equal(stale.sources.siblingLookups, 1, "past the TTL, one fresh lookup");

    // (e) HOT_SIBLING_TTL_MIN=0 means "do not reuse the list next tick", NOT "throw away the list we
    //     just paid for": the rows the lookup bought must still reach THIS tick's board.
    const noCache = new Map<string, SiblingCacheEntry>();
    calls.length = 0;
    const ttl0 = await tick(NOW + 40 * M, 6, 0, noCache);
    assert.equal(ttl0.sources.siblingLookups, 1);
    assert.equal(ttl0.sources.siblingRows, 4, "the freshly fetched list is used on the tick that fetched it");
    assert.ok(ttl0.rows.some((r) => r.address === WET_SOL));
    assert.equal(noCache.size, 1, "and it survives this tick's eviction sweep");
    calls.length = 0;
    const ttl0Again = await tick(NOW + 41 * M, 6, 0, noCache);
    assert.equal(ttl0Again.sources.siblingLookups, 1, "the NEXT tick refetches: TTL 0 is no cache across ticks");
    assert.equal(ttl0Again.sources.siblingRows, 4);

    // (f) a failed lookup is cached NEGATIVELY, so one broken mint cannot eat the budget every tick.
    const failCache = new Map<string, SiblingCacheEntry>();
    const tokenCalls: string[] = [];
    const flaky = (async (input: string) => {
      const u = new URL(input);
      if (u.pathname.includes("/tokens/")) {
        tokenCalls.push(input);
        return new Response("boom", { status: 500 });
      }
      return new Response(JSON.stringify(u.host === "api.dexscreener.com" ? dexPairs(u.pathname.split("/").pop()!.split(",")) : trending), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const f1 = await tick(NOW, 6, 30, failCache, flaky);
    assert.equal(f1.sources.siblingLookups, 1, "one call, which failed");
    assert.equal(f1.sources.errors.length, 1);
    assert.equal(failCache.get(WET)!.ok, false, "the failure is remembered");
    assert.deepEqual(failCache.get(WET)!.samples, []);
    const f2 = await tick(NOW + 60_000, 6, 30, failCache, flaky);
    assert.equal(f2.sources.siblingLookups, 0, "the next tick does not spend a call on it again");
    assert.equal(tokenCalls.length, 1, "and no HTTP call goes out for it");
    assert.equal(f2.sources.errors.length, 0, "a remembered failure is not re-reported every tick");
    const f3 = await tick(NOW + SIBLING_FAIL_TTL_MS + 1000, 6, 30, failCache, flaky);
    assert.equal(f3.sources.siblingLookups, 1, "past SIBLING_FAIL_TTL_MS it tries again");
    assert.equal(tokenCalls.length, 2);
    // the negative TTL is its own clock: a long HOT_SIBLING_TTL_MIN does not extend it
    const f4 = await tick(NOW + SIBLING_FAIL_TTL_MS + 2000, 6, 600, failCache, flaky);
    assert.equal(f4.sources.siblingLookups, 0, "and inside it, still no call");

    // (g) a failing lookup is named in sources.errors and the tick still produces its rows.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "bands-launch-"));
    const broken = (async (input: string) => {
      if (input.includes("/tokens/")) throw new Error("ECONNRESET");
      const u = new URL(input);
      return new Response(JSON.stringify(u.host === "api.dexscreener.com" ? dexPairs(u.pathname.split("/").pop()!.split(",")) : trending), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const failed = await runHotTick({
      dataDir: dir2, screen: null, held: [], now: NOW, durations: ["1h"], fetchImpl: broken, sleep: async () => {},
      readFee: async () => null, feeCache: new Map(), siblingCache: new Map(), tradableVenue,
      env: { minLiquidityUsd: 1000, siblingLookups: 6, onchainReads: 0 }, log: () => {},
    });
    assert.equal(failed.rows.length, 1, "the trending row still lands");
    assert.equal(failed.sources.errors.length, 1);
    assert.match(failed.sources.errors[0], /sibling pools H1q6vF: ECONNRESET/);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  });
}

/* ================= 2. entry: the admission rules =============================================== */

/** A row that passes everything, so each test can break exactly one thing. */
const good = (over: Partial<LaunchRow> = {}): LaunchRow => ({
  ageHours: 2.4,
  liquidityUsd: 31_638,
  vol24hUsd: 2_500_000,
  vol1hUsd: 1_160_000,
  quoteSymbol: "SOL",
  sellShare1h: 0.48,
  priceChange1hPct: 12,
  flags: ["new", "wild", "fee-unknown"],
  ...over,
});

async function admission(): Promise<void> {
  console.log("\nlaunch lane / admission");

  await test("launchEnv: the documented defaults, and LAUNCH_LANE closes the whole lane", () => {
    const d = launchEnv({});
    assert.deepEqual(d, {
      on: true, maxAgeHours: 48, minAgeMin: 30, minLiquidityUsd: 15_000, minVolume24hUsd: 400_000, minTurnover: 3,
      minVolume1hUsd: 50_000, maxSeats: 1, seatPct: 10, stopPct: 8, maxHoldMin: 240, fadeVolume1hUsd: 20_000,
    });
    assert.equal(launchEnv({ LAUNCH_LANE: "true" }).on, true);
    assert.equal(launchEnv({ LAUNCH_LANE: "" }).on, true, "an empty value is an unset value");
    for (const v of ["false", "no", "0", "TRUE ", "yes"]) assert.equal(launchEnv({ LAUNCH_LANE: v }).on, v === "TRUE ", `LAUNCH_LANE=${v}`);
    assert.equal(launchEnv({ LAUNCH_MIN_LIQUIDITY_USD: "15000", LAUNCH_MIN_VOLUME_24H_USD: "400000" }).minLiquidityUsd, 15_000);
    assert.equal(launchEnv({ LAUNCH_MAX_SEATS: "2.7" }).maxSeats, 2, "seats are whole");
    assert.equal(launchEnv({ LAUNCH_STOP_PCT: "junk" }).stopPct, 8, "junk falls back");
    assert.equal(launchVerdict(good(), env({ on: false })).ok, false);
    assert.match((launchVerdict(good(), env({ on: false })) as { reason: string }).reason, /launch lane is off/);
  });

  await test("launchVerdict admits WET/SOL on the numbers Zach quoted, and reports the turnover", () => {
    const v = launchVerdict(good(), env({ minLiquidityUsd: 25_000, minVolume24hUsd: 500_000 }));
    assert.ok(v.ok, `expected an admission, got ${JSON.stringify(v)}`);
    assert.equal(v.ageHours, 2.4);
    assert.equal(v.turnover, 79.02, "2.5M traded on 31,638 of liquidity");
    // being new and wild is the whole point: neither flag refuses here
    assert.ok(launchVerdict(good({ flags: ["new", "wild", "fading", "fee-unknown"] }), env()).ok);
  });

  await test("age: nothing in its first half hour, nothing past the 48h window, nothing unaged", () => {
    const refuse = (row: Partial<LaunchRow>) => launchVerdict(good(row), env()) as { ok: false; reason: string };
    assert.match(refuse({ ageHours: 0.4 }).reason, /^age 24 min is inside the first 30 min: nothing in its first half hour$/);
    assert.match(refuse({ ageHours: 0 }).reason, /inside the first 30 min/);
    assert.match(refuse({ ageHours: 60 }).reason, /^age 60\.0h is past the 48h launch window/);
    assert.match(refuse({ ageHours: null }).reason, /^age unknown/);
    assert.ok(launchVerdict(good({ ageHours: 0.5 }), env()).ok, "exactly 30 minutes is in");
    assert.ok(launchVerdict(good({ ageHours: 48 }), env()).ok, "exactly 48h is in");
    assert.match(refuse({ ageHours: 0.4, liquidityUsd: 10 }).reason, /age/, "age is judged before liquidity");
  });

  await test("quote: SOL or USDC only -- the WET/PTN pool is refused by name of its quote", () => {
    const v = launchVerdict(good({ quoteSymbol: "PTN" }), env()) as { ok: false; reason: string };
    assert.match(v.reason, /^quoted in PTN, and the book seats SOL and USDC only$/);
    assert.ok(launchVerdict(good({ quoteSymbol: "USDC" }), env()).ok);
  });

  await test("liquidity: the floor names the number that failed", () => {
    const v = launchVerdict(good({ liquidityUsd: 12_400 }), env()) as { ok: false; reason: string };
    assert.match(v.reason, /^liquidity \$12,400 is under the \$15,000 launch floor$/);
    assert.match((launchVerdict(good({ liquidityUsd: null }), env()) as { reason: string }).reason, /^liquidity unknown/);
    assert.ok(launchVerdict(good({ liquidityUsd: 15_000 }), env()).ok, "exactly the floor is in");
    assert.ok(!launchVerdict(good({ liquidityUsd: 20_000 }), env({ minLiquidityUsd: 25_000 })).ok, "the floor is a knob");
    // the live WET/SOL pool at 22:45Z: $17,408 liquidity, $489,359 in 24h, $141,926 in the last hour
    assert.ok(launchVerdict(good({ liquidityUsd: 17_408, vol24hUsd: 489_359, vol1hUsd: 141_926 }), env()).ok, "the pool that motivated the lane is admitted at the defaults");
  });

  await test("24h volume: the floor names the number that failed", () => {
    const v = launchVerdict(good({ vol24hUsd: 315_000, vol1hUsd: 180_804 }), env()) as { ok: false; reason: string };
    assert.match(v.reason, /^24h volume \$315,000 is under the \$400,000 launch floor$/);
    assert.match((launchVerdict(good({ vol24hUsd: null }), env()) as { reason: string }).reason, /^24h volume unknown/);
    // what a single WET/SOL pool actually printed at the time Zach quoted it clears the default floor
    assert.ok(launchVerdict(good({ vol24hUsd: 415_000, vol1hUsd: 180_804 }), env()).ok);
    assert.ok(!launchVerdict(good({ vol24hUsd: 415_000, vol1hUsd: 180_804 }), env({ minVolume24hUsd: 500_000 })).ok, "the floor is a knob");
  });

  await test("turnover: 24h volume over liquidity, computed or supplied, names both numbers", () => {
    const v = launchVerdict(good({ liquidityUsd: 400_000, vol24hUsd: 600_000 }), env()) as { ok: false; reason: string };
    assert.match(v.reason, /^turnover 1\.5x \(\$600,000 traded on \$400,000 of liquidity\) is under the 3x launch floor$/);
    assert.ok(launchVerdict(good({ liquidityUsd: 200_000, vol24hUsd: 600_000 }), env()).ok, "exactly 3x is in");
    // a caller that already knows the turnover is believed over the division
    const supplied = launchVerdict(good({ liquidityUsd: 400_000, vol24hUsd: 600_000, turnover24h: 9 }), env());
    assert.ok(supplied.ok);
    assert.equal(supplied.turnover, 9);
  });

  await test("1h volume: the 24h figure must still be happening now", () => {
    const v = launchVerdict(good({ vol1hUsd: 12_000 }), env()) as { ok: false; reason: string };
    assert.match(v.reason, /^the last hour traded \$12,000, under the \$50,000 launch floor: the 24h figure has already happened$/);
    assert.match((launchVerdict(good({ vol1hUsd: null }), env()) as { reason: string }).reason, /^last hour's volume unknown/);
    assert.ok(launchVerdict(good({ vol1hUsd: 50_000 }), env()).ok);
  });

  await test("dumping: two thirds sells INTO a fall, or the hot watch's own flag", () => {
    const v = launchVerdict(good({ sellShare1h: 0.71, priceChange1hPct: -22 }), env()) as { ok: false; reason: string };
    assert.match(v.reason, /^71% of the last hour's trades were sells \(limit 66%\) and the hour is -22\.0%, not above -10%: it is being dumped$/);
    assert.ok(launchVerdict(good({ sellShare1h: 0.71, priceChange1hPct: 40 }), env()).ok, "heavy selling into a rally is two-sided flow, not a dump");
    assert.ok(launchVerdict(good({ sellShare1h: 0.6, priceChange1hPct: -40 }), env()).ok, "a fall on balanced flow is volatility, which the lane pays for elsewhere");
    assert.match((launchVerdict(good({ sellShare1h: 0.9, priceChange1hPct: null }), env()) as { reason: string }).reason, /the hour is unpriced/);
    assert.match((launchVerdict(good({ flags: ["new", "dumping"] }), env()) as { reason: string }).reason, /^the hot watch flags it `dumping`$/);
  });

  await test("launchSeatSol: a launch seat is a tenth of the book, and the percentage is a knob", () => {
    assert.equal(launchSeatSol(90, env()), 9);
    assert.equal(launchSeatSol(1, env()), 0.1);
    assert.equal(launchSeatSol(90, env({ seatPct: 25 })), 22.5);
    assert.equal(launchSeatSol(90, env({ seatPct: 0 })), 0);
  });
}

/* ================= 3. seating: the cap, and the deny that still wins ============================ */

const candidate = (over: Partial<LaunchCandidate> = {}): LaunchCandidate => ({
  ...good(),
  address: "poolA",
  baseMint: "mintA",
  baseSymbol: "WET",
  name: "WET / SOL",
  venue: "meteora-dlmm",
  heat: 50,
  ...over,
});

const seatOpts = (over: Partial<Parameters<typeof launchSeats>[1]> = {}) => ({
  env: env(),
  freeSeats: 3,
  tradable: tradableVenue,
  quoteOk: (q: string) => q === "SOL" || q === "USDC",
  ...over,
});

async function seating(): Promise<void> {
  console.log("\nlaunch lane / seating");

  await test("pickPools seats at most LAUNCH_MAX_SEATS launch pools, best heat first", () => {
    const rows = [
      candidate({ address: "p1", baseMint: "m1", heat: 20 }),
      candidate({ address: "p2", baseMint: "m2", heat: 90 }),
      candidate({ address: "p3", baseMint: "m3", heat: 55 }),
    ];
    assert.deepEqual(launchSeats(rows, seatOpts()).map((s) => s.row.address), ["p2"], "one seat by default, the hottest");
    assert.deepEqual(launchSeats(rows, seatOpts({ env: env({ maxSeats: 2 }) })).map((s) => s.row.address), ["p2", "p3"]);
    assert.deepEqual(launchSeats(rows, seatOpts({ env: env({ maxSeats: 9 }) })).map((s) => s.row.address), ["p2", "p3", "p1"], "never more than the rows");
    assert.deepEqual(launchSeats(rows, seatOpts({ env: env({ maxSeats: 3 }), freeSeats: 1 })).map((s) => s.row.address), ["p2"], "MAX_ACTIVE_POOLS still binds");
    assert.deepEqual(launchSeats(rows, seatOpts({ env: env({ maxSeats: 2 }), seatsTaken: 2 })), [], "launch bands already held count against the cap");
    assert.deepEqual(launchSeats(rows, seatOpts({ env: env({ maxSeats: 0 }) })), [], "LAUNCH_MAX_SEATS=0 seats nothing");
    assert.deepEqual(launchSeats(rows, seatOpts({ env: env({ on: false, maxSeats: 3 }) })), [], "the lane off seats nothing");
    assert.deepEqual(launchSeats(rows, seatOpts({ freeSeats: 0 })), []);
  });

  await test("seating honours the loop's venue, quote, one-per-token and already-seated rules", () => {
    const rows = [
      candidate({ address: "p1", baseMint: "m1", heat: 90, venue: "pumpswap" }),
      candidate({ address: "p2", baseMint: "m2", heat: 80, quoteSymbol: "PTN" }),
      candidate({ address: "p3", baseMint: "m3", heat: 70 }),
      candidate({ address: "p4", baseMint: "m3", heat: 60 }),
    ];
    assert.deepEqual(launchSeats(rows, seatOpts({ env: env({ maxSeats: 4 }) })).map((s) => s.row.address), ["p3"], "untradable venue, unseatable quote, and one seat per token");
    assert.deepEqual(launchSeats(rows, seatOpts({ env: env({ maxSeats: 4 }), hasPool: (a) => a === "p3" })).map((s) => s.row.address), ["p4"], "a pool already picked is skipped, its token is not");
    assert.deepEqual(launchSeats(rows, seatOpts({ env: env({ maxSeats: 4 }), hasToken: (m) => m === "m3" })), [], "a token already holding a seat blocks its other pools");
    assert.deepEqual(launchSeats(rows, seatOpts({ env: env({ maxSeats: 4 }), quoteOk: (q) => q === "USDC" })), [], "the wallet cannot fund a SOL seat");
  });

  await test("the watchlist: an ALLOW-list miss cannot block a launch pool, an explicit DENY still does", () => {
    const pool = { address: "poolA", baseSymbol: "WET", baseMint: "mintA", name: "WET / SOL" };
    // allow mode with a hand-written list: the ordinary picker refuses a token nobody could have listed
    const allow: Watchlist = addToken({ ...emptyWatchlist(), mode: "allow" }, { symbol: "SPYx" });
    assert.match(watchlistRefusal(pool, allow)!, /not on the watchlist/, "the ordinary rule refuses it");
    assert.equal(watchlistDenial(pool, allow), null, "the launch lane's rule does not: it admits by rule, not by name");
    assert.deepEqual(launchSeats([candidate()], seatOpts({ denied: (r) => watchlistDenial(r, allow) })).map((s) => s.row.address), ["poolA"]);
    // an explicit deny on the symbol, on the mint, or on the pool beats the lane every time
    for (const w of [denyToken(allow, "WET"), denyToken(allow, "mintA"), { ...allow, denyPools: ["poolA"] }]) {
      assert.ok(watchlistDenial(pool, w), "denied");
      assert.deepEqual(launchSeats([candidate()], seatOpts({ denied: (r) => watchlistDenial(r, w) })), [], "a deny wins");
    }
    // and a deny in "off" mode, where the list only denies
    const off = denyToken(emptyWatchlist(), "WET");
    assert.deepEqual(launchSeats([candidate()], seatOpts({ denied: (r) => watchlistDenial(r, off) })), []);
  });

  await test("a row that fails the lane is not seated however hot it is", () => {
    const rows = [candidate({ address: "hot-but-old", heat: 99, ageHours: 100 }), candidate({ address: "ok", baseMint: "m2", heat: 1 })];
    assert.deepEqual(launchSeats(rows, seatOpts({ env: env({ maxSeats: 2 }) })).map((s) => s.row.address), ["ok"]);
  });
}

/* ================= 4. hotPicks ================================================================= */

const hotRow = (over: Partial<HotRow> = {}): HotRow => ({
  address: "poolA", name: "WET / SOL", venue: "meteora-dlmm", baseMint: "mintA", baseSymbol: "WET", quoteMint: SOL, quoteSymbol: "SOL",
  onBoard: false, screenRank: null, stock: null,
  vol1hUsd: 1_160_000, vol5mUsd: 90_000, vol24hUsd: 2_500_000, liquidityUsd: 31_638, feePct: 2, feeSource: "onchain",
  fees1hUsd: 23_200, feeToTvl1hPct: 73, feeToTvlDailyPct: 1760, turnover1h: 36, acceleration: 11,
  buys1h: 520, sells1h: 480, buys5m: 40, sells5m: 30, sellShare1h: 0.48, sellShare5m: 0.43,
  priceChange5mPct: 2, priceChange1hPct: 12, priceChange24hPct: 300, ageHours: 2.4,
  heat: 60, flags: ["new"], surge: true, surgeAt: null, firstSeenAt: "", lastSeenAt: "",
  ...over,
});

async function picks(): Promise<void> {
  console.log("\nlaunch lane / hotPicks");

  await test("hotPicks: `new` drops a row as before, and stops dropping it when the lane admits it", () => {
    const file = (rows: HotRow[]): HotFile => ({ generatedAt: "", tickMs: 1, sources: { trending: 0, dexscreener: 0, onchainReads: 0, errors: [] }, rows });
    const launchy = hotRow();
    const ordinaryNew = hotRow({ address: "thin-new", vol24hUsd: 90_000, vol1hUsd: 900, liquidityUsd: 400_000, heat: 30 });
    const plain = hotRow({ address: "plain", flags: [], heat: 10, ageHours: 400 });
    const hot = file([launchy, ordinaryNew, plain]);
    const o = { tradable: (r: HotRow) => tradableVenue(r.venue), max: 5, minLiquidityUsd: 20_000 };
    assert.deepEqual(hotPicks(hot, o).map((r) => r.address), ["plain"], "without the lane, both `new` rows are dropped");
    assert.deepEqual(hotPicks(hot, { ...o, launch: env() }).map((r) => r.address), ["poolA", "plain"], "the lane admits the launch row, not the other one");
    assert.deepEqual(hotPicks(hot, { ...o, launch: env({ on: false }) }).map((r) => r.address), ["plain"], "the lane off changes nothing");
    assert.deepEqual(hotPicks(hot, { ...o, launch: null }).map((r) => r.address), ["plain"]);
  });

  await test("hotPicks: the lane exempts `new`, never `dumping` or `wild`, and never the liquidity floor", () => {
    const file = (rows: HotRow[]): HotFile => ({ generatedAt: "", tickMs: 1, sources: { trending: 0, dexscreener: 0, onchainReads: 0, errors: [] }, rows });
    const o = { tradable: (r: HotRow) => tradableVenue(r.venue), max: 5, minLiquidityUsd: 20_000, launch: env() };
    assert.deepEqual(hotPicks(file([hotRow({ flags: ["new", "wild"] })]), o), [], "`wild` still drops it");
    assert.deepEqual(hotPicks(file([hotRow({ flags: ["new", "dumping"] })]), o), [], "`dumping` still drops it");
    assert.deepEqual(hotPicks(file([hotRow({ liquidityUsd: 19_000 })]), o), [], "the liquidity floor still binds");
    assert.deepEqual(hotPicks(file([hotRow({ venue: "pumpswap" })]), o), [], "the venue rule still binds");
    assert.deepEqual(hotPicks(file([hotRow({ heat: 0 })]), o), [], "no heat, no pick");
  });

  await test("launchRowOf: a hot row carries every figure the lane reads, turnover included", () => {
    const r = launchRowOf(hotRow());
    assert.equal(r.ageHours, 2.4);
    assert.equal(r.quoteSymbol, "SOL");
    assert.equal(r.vol1hUsd, 1_160_000);
    assert.ok(Math.abs(r.turnover24h! - 2_500_000 / 31_638) < 1e-9);
    assert.equal(launchRowOf(hotRow({ liquidityUsd: null })).turnover24h, null);
    assert.ok(launchVerdict(r, env()).ok);
  });
}

/* ================= 5. the harsher terms: the stop, and the EXPIRE directive ==================== */

const limits: RiskLimits = {
  maxPositionSol: 0.5, maxTotalExposureSol: 1, gasReserveSol: 0.1, stopLossPct: 15, maxBinWidth: 69,
  maxTxPerDay: 24, minSecondsBetweenActions: 600, maxSlippagePct: 1, maxPriceMovePctPerCycle: 40,
};

const cfg: EngineConfig = {
  outOfRangeSec: 120, knifePct: 20, circuitFloorSol: 0.05, portfolioFloorSol: 0.15,
  collectMinSol: 0.005, collectFloorSol: 0.001, collectMaxPerDay: 30, skim: false, floatTargetSol: 1,
  treasuryAddress: "", expectedWallet: "",
};

const snapshot: PoolSnapshot = {
  address: "poolA", label: "WET/SOL",
  tokenX: { mint: "mintA", symbol: "WET", decimals: 6, reserve: 1_000_000 },
  tokenY: { mint: SOL, symbol: "SOL", decimals: 9, reserve: 150 },
  solSide: "Y", baseToken: { mint: "mintA", symbol: "WET", decimals: 6, reserve: 1_000_000 },
  binStep: 100, activeBinId: 500, activePrice: 0.00002, priceLabel: "SOL per WET",
  tokenPriceInSol: 0.00002, baseFeePct: 2, maxFeePct: 10, dynamicFeePct: 2,
  bins: [], liquidityBelowY: 80, liquidityAboveX: 500_000, fetchedAt: "",
};

const position = (over: Partial<PositionSnapshot> = {}): PositionSnapshot => ({
  address: "pos1", lowerBinId: 495, upperBinId: 500, lowerPrice: 0.000019, upperPrice: 0.00002, widthBins: 6,
  inRange: true, binsFromRange: 0, amountX: 0, amountY: 0.09, feeX: 0, feeY: 0.0001, valueInSol: 0.0901,
  solInPosition: 0.0901, lastUpdatedAt: 0, ...over,
});

const dctx = (over: Record<string, unknown> = {}) => ({
  now: NOW, snapshot, positions: [position()] as PositionSnapshot[], state: emptyState("2026-09-14"),
  engine: emptyEngineState(), cfg, limits, collectsToday: 0, ...over,
}) as Parameters<typeof engineDirective>[0];

/** A state holding one launch band opened `agoMin` ago with `vol1h` on the tape then. */
function launchState(agoMin: number, vol1h: number | null): RiskState {
  const s = emptyState("2026-09-14");
  s.entryValueSol = { pos1: 0.09 };
  s.launchBands = { pos1: { pool: "poolA", openedAt: NOW - agoMin * M, vol1hUsd: vol1h } };
  return s;
}

async function terms(): Promise<void> {
  console.log("\nlaunch lane / harsher terms");

  await test("the tighter stop: rolled with the same jitter, persisted the same way, never looser", () => {
    // the desk's stop, unchanged
    assert.equal(rollStop(limits, () => 0), 12);
    assert.equal(rollStop(limits, () => 1), 15);
    assert.equal(rollStop(limits, () => 0.5), 13.5);
    // the launch stop: the same [0.8, 1.0] jitter around 8 instead of 15
    assert.equal(rollStop(limits, () => 0, 8), 6.4);
    assert.equal(rollStop(limits, () => 1, 8), 8);
    assert.equal(rollStop(limits, () => 0.5, 8), 7.2);
    // it can only tighten
    assert.equal(rollStop(limits, () => 1, 40), 15, "an override above the limit is capped at the limit");
    assert.equal(rollStop(limits, () => 1, 0), 15, "0 and junk fall back to the configured stop");
    assert.equal(rollStop(limits, () => 1, null), 15);
    assert.equal(rollStop(limits, () => 1, NaN), 15);
    // and the guards and the STOP directive read it exactly as they read any other band's stop
    const stops = { pos1: rollStop(limits, () => 0.5, 8) };
    assert.equal(bandStopPct(stops, "pos1", limits), 7.2);
    const d = engineDirective(dctx({ positions: [position({ valueInSol: 0.0833 })], state: { ...launchState(10, 100_000), stops } }))!;
    assert.equal(d.kind, "STOP", "-7.4% is inside a 15% stop but past a 7.2% one");
    assert.match(d.reason, /stop 7\.20%/);
  });

  await test("EXPIRE on age: a launch band past its maximum hold comes off and liquidates", () => {
    const launch = { env: env(), vol1hUsd: 800_000 };
    assert.equal(engineDirective(dctx({ state: launchState(239, 1_000_000), launch })), null, "inside the 240 min hold");
    const d = engineDirective(dctx({ state: launchState(241, 1_000_000), launch }))!;
    assert.equal(d.kind, "EXPIRE");
    assert.equal(d.decision.action, "CLOSE_POSITION");
    assert.equal(d.decision.positionAddress, "pos1");
    assert.equal(d.decision.liquidate, true, "the book comes back to the quote, not to a token nobody chose");
    assert.match(d.reason, /^launch band pos1 has been open 241 min, past the 240 min maximum hold for a launch seat$/);
    assert.match(d.decision.reasoning, /Engine directive EXPIRE/);
    // the oldest band goes first, one per pool per cycle
    const two = launchState(241, 1_000_000);
    two.launchBands!.pos2 = { pool: "poolA", openedAt: NOW - 600 * M, vol1hUsd: 1_000_000 };
    const worst = engineDirective(dctx({ positions: [position(), position({ address: "pos2" })], state: two, launch }))!;
    assert.equal(worst.decision.positionAddress, "pos2");
    // a band in ANOTHER pool is not this pool's business
    const elsewhere = launchState(241, 1_000_000);
    elsewhere.launchBands!.pos1.pool = "poolB";
    assert.equal(engineDirective(dctx({ state: elsewhere, launch })), null);
    // an ordinary band never expires: no mark, no directive
    assert.equal(engineDirective(dctx({ state: emptyState("2026-09-14"), launch })), null);
    assert.equal(engineDirective(dctx({ state: launchState(999, 1_000_000), launch: { env: env({ on: false }), vol1hUsd: 0 } })), null, "the lane off, no EXPIRE");
    assert.equal(engineDirective(dctx({ state: launchState(999, 1_000_000) })), null, "no launch context, no EXPIRE");
  });

  await test("EXPIRE on a volume fade: under the floor, or under a third of what opened it", () => {
    const e = env();
    // (a) the absolute floor
    let d = engineDirective(dctx({ state: launchState(30, 1_000_000), launch: { env: e, vol1hUsd: 19_000 } }))!;
    assert.equal(d.kind, "EXPIRE");
    assert.match(d.reason, /^launch band pos1: the pool's last hour traded \$19,000, under the \$20,000 fade floor$/);
    // (b) a third of the opening hour, even while well above the floor
    d = engineDirective(dctx({ state: launchState(30, 1_200_000), launch: { env: e, vol1hUsd: 380_000 } }))!;
    assert.equal(d.kind, "EXPIRE");
    assert.match(d.reason, /^launch band pos1: the pool's last hour traded \$380,000, under a third of the \$1,200,000 it traded when the band opened$/);
    assert.equal(d.decision.liquidate, true);
    // (c) still trading: nothing fires
    assert.equal(engineDirective(dctx({ state: launchState(30, 1_200_000), launch: { env: e, vol1hUsd: 401_000 } })), null);
    // (d) the volume is unknown this cycle: the fade cannot be judged, and an unknown is not an exit
    assert.equal(engineDirective(dctx({ state: launchState(30, 1_200_000), launch: { env: e, vol1hUsd: null } })), null);
    // (e) the opening volume was unknown: the floor still applies, the ratio cannot
    assert.equal(engineDirective(dctx({ state: launchState(30, null), launch: { env: e, vol1hUsd: 500_000 } })), null);
    assert.equal(engineDirective(dctx({ state: launchState(30, null), launch: { env: e, vol1hUsd: 5_000 } }))!.kind, "EXPIRE");
    // (f) the fade floor is a knob, and 0 turns that half of the rule off
    assert.equal(engineDirective(dctx({ state: launchState(30, 1_000_000), launch: { env: env({ fadeVolume1hUsd: 0 }), vol1hUsd: 19_000 } }))!.kind, "EXPIRE", "still under a third of the opening hour");
    assert.equal(engineDirective(dctx({ state: launchState(30, null), launch: { env: env({ fadeVolume1hUsd: 0 }), vol1hUsd: 1 } })), null);
  });

  await test("EXPIRE sits below FLATTEN and STOP and above COLLECT", () => {
    const launch = { env: env(), vol1hUsd: 1_000 };
    const state = launchState(999, 1_000_000);
    // COLLECT would fire on these fees; EXPIRE outranks it
    const rich = position({ feeY: 0.01 });
    assert.equal(engineDirective(dctx({ positions: [rich], state, launch }))!.kind, "EXPIRE");
    assert.equal(engineDirective(dctx({ positions: [rich], state: emptyState("2026-09-14"), launch }))!.kind, "COLLECT");
    // a stop beats an expiry: the stop is the exit, and it is not negotiated
    const stopped = { ...state, entryValueSol: { pos1: 0.2 } };
    assert.equal(engineDirective(dctx({ positions: [position({ valueInSol: 0.1 })], state: stopped, launch }))!.kind, "STOP");
    // and a stand-down beats everything
    const eng = emptyEngineState();
    eng.portfolio.standDownUntil = NOW + H;
    assert.equal(engineDirective(dctx({ state, launch, engine: eng }))!.kind, "FLATTEN");
  });

  await test("launchExpiry and forgetBand: the mark is the band's, and it goes when the band goes", () => {
    const state = launchState(10, 1_000_000);
    assert.equal(launchExpiry([position()], state.launchBands, "poolA", NOW, env(), 900_000), null);
    assert.ok(launchExpiry([position()], state.launchBands, "poolA", NOW, env(), 1_000)!.reason);
    assert.equal(launchExpiry([position()], undefined, "poolA", NOW, env(), 1_000), null, "no marks, no expiry");
    assert.equal(launchExpiry([], state.launchBands, "poolA", NOW, env(), 1_000), null, "no band, no expiry");
    forgetBand(state, "pos1");
    assert.deepEqual(state.launchBands, {}, "a closed band takes its launch mark with it");
    assert.equal(launchExpiry([position()], state.launchBands, "poolA", NOW, env(), 1_000), null);
  });
}

/* ================= 6. the policy: what a launch seat looks like ================================ */

function observation(over: { launch?: { ok: true; ageHours: number; turnover: number } | null; flags?: string[]; score?: number; move1h?: number } = {}): Observation {
  return {
    ts: new Date(NOW).toISOString(), cycle: 1, mode: "dry-run", poolLabel: "WET/SOL", snapshot, positions: [],
    wallet: { address: "w", sol: 1, token: 0, tokenSymbol: "WET", quote: 1, quoteSymbol: "SOL" },
    analytics: null,
    state: { actionsToday: 0, lastActionAt: null, lastMoveAt: null, lastPrice: null, killSwitch: false },
    recent: [],
    screen: {
      rank: 0, rankedPools: 400, score: over.score ?? 0, feeToTvl24hPct: null, volume24hUsd: 2_500_000, tvlUsd: 31_638,
      ageHours: 2.4, priceChange24hPct: 300, flags: over.flags ?? ["new", "wild"], watchlisted: false,
      launch: over.launch === undefined ? { ok: true as const, ageHours: 2.4, turnover: 79 } : over.launch,
      recentMovePct: 6, generatedAt: new Date(NOW).toISOString(), stock: null, alternatives: [],
      hot: [{ name: "WET / SOL", venue: "meteora-dlmm", tradable: true, thisPool: true, liquidityUsd: 31_638, vol1hUsd: 1_160_000, feeToTvlDailyPct: 1760, acceleration: 11, priceChange1hPct: over.move1h ?? 12, heat: 60, flags: over.flags ?? ["new", "wild"], surge: true }],
    },
    portfolio: { activePools: ["WET/SOL"], poolsWithBands: 0, maxActivePools: 3, otherExposureSol: 0 },
    engine: {
      halt: null, standDown: null, bench: { stops6h: 0, multiplier: 1, benched: false, reason: null },
      regime: { medianMove24hPct: 0, multiplier: 1, reason: null }, sizeMultiplier: 1, effectiveMaxPositionSol: 0.5,
      stops: {}, outOfRangeSec: {}, minOutOfRangeSec: 120, knife: null, collectsToday: 0, collectMaxPerDay: 30,
    },
  };
}

async function policy(): Promise<void> {
  console.log("\nlaunch lane / the policy");

  await test("without the lane, the policy refuses a launch pool -- flagged, unscored, and moving", () => {
    const r = policyDecide(observation({ launch: null }), { limits, now: NOW, openCostSol: 0.0085 });
    assert.equal(r.decision.action, "HOLD");
    assert.match(r.reason, /flagged new, wild/);
  });

  await test("with the lane, the policy opens a capped quote-only band and says what it gave up", () => {
    const r = policyDecide(observation(), { limits, now: NOW, openCostSol: 0.0085, launch: env() });
    assert.equal(r.decision.action, "OPEN_POSITION", r.reason);
    assert.equal(r.branch, "open");
    assert.equal(r.decision.open!.side, "SOL_ONLY", "a launch band is quote-only: the straddle is a stock instrument");
    assert.equal(r.decision.open!.amountToken, 0);
    // the seat is capped at LAUNCH_SEAT_PCT of the book, on top of every other cap
    const cap = launchSeatSol(limits.maxTotalExposureSol, env());
    assert.equal(cap, 0.1);
    assert.ok(r.decision.open!.amountSol <= cap + 1e-9, `seat ${r.decision.open!.amountSol} SOL over the ${cap} SOL cap`);
    assert.match(r.decision.reasoning, /Launch lane: capped at 0\.1 SOL \(10% of the 1 SOL book\)/);
    assert.match(r.decision.reasoning, /stop rolled at 8% instead of 15%, closed after 240 min or when the last hour falls under \$20,000/);
    assert.match(r.decision.reasoning, /launch lane: 2\.4h old, turning over 79x its liquidity a day/);
    // a bigger book gets a bigger launch seat, still a tenth of it and still the binding cap
    const big = { ...limits, maxTotalExposureSol: 20, maxPositionSol: 10 };
    const o2 = observation();
    o2.wallet.sol = 30;
    o2.wallet.quote = 30;
    o2.engine!.effectiveMaxPositionSol = 10;
    const r2 = policyDecide(o2, { limits: big, now: NOW, openCostSol: 0.0085, launch: env() });
    assert.equal(r2.decision.action, "OPEN_POSITION", r2.reason);
    assert.match(r2.decision.reasoning, /Launch lane: capped at 2 SOL \(10% of the 20 SOL book\)/);
    assert.match(r2.decision.reasoning, /bound by launch lane cap 2 SOL/, "and it is what bound the size");
    assert.ok(r2.decision.open!.amountSol <= 2 + 1e-9);
  });

  await test("the lane exempts `new` and `wild` and the score and the 1h move, never `thin` or `dumping`", () => {
    const x = { limits, now: NOW, openCostSol: 0.0085, launch: env() };
    assert.equal(policyDecide(observation({ move1h: 45 }), x).decision.action, "OPEN_POSITION", "a 45% hour is what a launch looks like");
    assert.equal(policyDecide(observation({ flags: ["new", "wild", "fading", "fee-unknown"] }), x).decision.action, "OPEN_POSITION");
    const dumping = policyDecide(observation({ flags: ["new", "dumping"] }), x);
    assert.equal(dumping.decision.action, "HOLD");
    assert.match(dumping.reason, /flagged dumping/);
    const thin = policyDecide(observation({ flags: ["new", "thin"] }), x);
    assert.equal(thin.decision.action, "HOLD");
    assert.match(thin.reason, /flagged thin/);
    // and the lane off puts every ordinary rule back
    assert.equal(policyDecide(observation({ launch: null, move1h: 45 }), x).decision.action, "HOLD");
  });
}

async function main(): Promise<void> {
  await detection();
  await admission();
  await seating();
  await picks();
  await terms();
  await policy();
  console.log(`\n${n} launch-lane tests passed`);
}

main();
