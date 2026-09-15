/**
 * The PAIR LANE: the desk makes its own Meteora pool for a pump.fun token.
 *
 *   admission   every rule of pairVerdict with its exact string; other pools never refuse, they only
 *               feed the routing model; a DENY still wins; one pool at a time (src/screener/pair.ts)
 *   the model   routedShare: monotonic in our depth and their fee, decreasing in our fee, 0 when we
 *               cannot fill anything, the worked example, the split with competing depth
 *   geometry    the active bin from the reference price round-trips through binPrice
 *   paper       create -> mark at a moved reference price -> accrue -> EXPIRE on the fade -> liquidate,
 *               through the real paper functions, with the equity identity holding (src/paper, src/venues/pair.ts)
 *   live        the create transaction's parameters derived offline: the address from the pair alone,
 *               the base factor, the program's constraints, the broadcast gate (no RPC anywhere here)
 *   policy      the pair seat's shape and headline; a band in our own pool
 *   house       PAIR_HOUSE_MINTS: our own token is always seated (no reference needed), a DENY still wins,
 *               it takes no PAIR_MAX_POOLS slot and carries no launch-style exit
 *
 * Fixture: GeckoTerminal's top PumpSwap pools, captured 2026-09-14 (the NIKE/SOL row). No network,
 * no disk outside a temp dir, no clock.
 *   npm run test:pair
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Everything that reads src/config.ts is imported after the environment is pinned.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mr-bands-pair-"));
process.env.DATA_DIR = tmp;
process.env.ANTHROPIC_API_KEY = "";
delete process.env.ANTHROPIC_AUTH_TOKEN;
process.env.DRY_RUN = "true";
process.env.WALLET_SECRET_KEY = "";
process.env.MAX_POSITION_SOL = "60";
process.env.MAX_TOTAL_EXPOSURE_SOL = "100";
process.env.GAS_RESERVE_SOL = "1";
process.env.STOP_LOSS_PCT = "15";
process.env.MAX_BIN_WIDTH = "69";
process.env.MAX_TX_PER_DAY = "24";
process.env.MIN_SECONDS_BETWEEN_ACTIONS = "600";
process.env.MAX_PRICE_MOVE_PCT_PER_CYCLE = "40";
process.env.PAPER_SOL = "";
process.env.PAIR_LIVE = "";
process.env.LIVE_VENUES = "";
process.env.TRADABLE_VENUES = "";
process.env.POLICY_MAX_PAYBACK_HOURS = "24";
process.env.POLICY_MIN_SEAT_PCT = "5";

import type { Observation } from "../agent/observation";
import type { Decision } from "../agent/schema";
import type { HotFile, HotRow } from "../hot/types";
import type { RiskLimits } from "../risk/limits";
import type { Verdict } from "../risk/guards";
import type { PoolSnapshot, PositionSnapshot } from "../tools/dlmm";
import type { PairCandidate, PairEnv, PairRow } from "../screener/pair";
// The SDK and web3 read no config: static imports (a dynamic import would resolve the SDK's ESM source entry).
import * as sdk from "@meteora-ag/dlmm";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

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

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** NIKE on PumpSwap, 2026-09-14 20:52Z: $344k of liquidity, $48M in 24h, $12.4M in the last hour, an hour old */
const NIKE = "FHDQkQtKVhjRMMTDDNfSyQq5tg5ADbQ1zmEv1k88V9pd";
const NIKE_POOL = "DEjtpp7WwmPV3pUYtcRbkdSgtdc1o9XdzURFKhQJHCKW";
const NIKE_PRICE = 0.0000002912454749;
const NOW = Date.parse("2026-09-14T21:00:00Z");
const M = 60_000;

const limits: RiskLimits = { maxPositionSol: 60, maxTotalExposureSol: 100, gasReserveSol: 1, stopLossPct: 15, maxBinWidth: 69, maxTxPerDay: 24, minSecondsBetweenActions: 600, maxSlippagePct: 1, maxPriceMovePctPerCycle: 40 };

/** A reference row that passes everything, so each test can break exactly one thing. */
const good = (over: Partial<PairRow> = {}): PairRow => ({
  address: NIKE_POOL,
  baseMint: NIKE,
  baseSymbol: "NIKE",
  name: "NIKE / SOL",
  venue: "pumpswap",
  quoteSymbol: "SOL",
  origin: "pump.fun",
  ageHours: 1.1,
  liquidityUsd: 343_799,
  vol24hUsd: 48_129_456,
  vol1hUsd: 12_394_850,
  sellShare1h: 0.5,
  priceChange1hPct: 7,
  flags: ["new"],
  priceNative: NIKE_PRICE,
  priceUsd: 0.00003,
  ...over,
});

const hotRowOf = (over: Partial<HotRow> = {}): HotRow => ({
  address: NIKE_POOL, name: "NIKE / SOL", venue: "pumpswap", baseMint: NIKE, baseSymbol: "NIKE", quoteMint: SOL, quoteSymbol: "SOL",
  priceUsd: 0.00003, marketCapUsd: 30_000_000, priceNative: NIKE_PRICE, origin: "pump.fun", onBoard: false, screenRank: null, stock: null,
  vol1hUsd: 12_394_850, vol5mUsd: 900_000, vol24hUsd: 48_129_456, liquidityUsd: 343_799, feePct: null, feeSource: null,
  fees1hUsd: null, feeToTvl1hPct: null, feeToTvlDailyPct: null, turnover1h: 36, acceleration: 6.2,
  buys1h: 6365, sells1h: 6333, buys5m: 500, sells5m: 480, sellShare1h: 0.499, sellShare5m: 0.49,
  priceChange5mPct: 1, priceChange1hPct: 7, priceChange24hPct: 300, ageHours: 1.1,
  heat: 30, flags: ["new", "fee-unknown"], surge: false, surgeAt: null, firstSeenAt: "", lastSeenAt: "",
  ...over,
});
const hotFileOf = (rows: HotRow[]): HotFile => ({ generatedAt: new Date(NOW).toISOString(), tickMs: 1, sources: { trending: 0, dexscreener: 0, onchainReads: 0, pumpswap: rows.length, errors: [] }, rows });

async function main(): Promise<void> {
  const pair = await import("../screener/pair.js");
  const launch = await import("../screener/launch.js");
  const venue = await import("../venues/pair.js");
  const paper = await import("../paper/index.js");
  const { binPrice } = await import("../tools/bins.js");
  const dlmm = await import("../tools/dlmm.js");
  const { evaluate, NO_ENGINE } = await import("../risk/guards.js");
  const { emptyState } = await import("../risk/state.js");
  const { engineDirective } = await import("../engine/directives.js");
  const { emptyEngineState } = await import("../engine/breakers.js");
  const policy = await import("../agent/policy.js");
  const { formatObservation } = await import("../agent/observation.js");
  const { watchlistDenial, watchlistRefusal, addToken, denyToken, emptyWatchlist } = await import("../screener/watchlist.js");

  const env = (over: Partial<PairEnv> = {}): PairEnv => ({ ...pair.pairEnv({}), ...over });
  const refuse = (row: Partial<PairRow>, e: PairEnv = env()) => pair.pairVerdict(good(row), e) as { ok: false; reason: string };

  /* ================= 1. env ================================================================ */
  console.log("pair lane / env");
  await test("pairEnv: the documented defaults; PAIR_LANE closes the lane; quote and fee mode are validated", () => {
    assert.deepEqual(pair.pairEnv({}), {
      on: true, minAgeMin: 30, maxAgeHours: 48, minRefLiquidityUsd: 30_000, minVolume24hUsd: 1_000_000, minVolume1hUsd: 100_000, minTurnover: 5,
      maxPools: 1, reserveSeat: true, quote: "SOL", binStep: 100, feeBps: 50, feeBpsFixed: false, feeMenuBps: [25, 50, 100], collectFeeMode: "quote", seatPct: 10, binsEachSide: 2, stopPct: 10, maxHoldMin: 240,
      live: false, tradeMinUsd: 50, tradeMaxUsd: 5000, pumpswapFeePct: 0.25, houseMints: [], houseSeatPct: 10,
    });
    for (const v of ["false", "no", "0", "yes"]) assert.equal(pair.pairEnv({ PAIR_LANE: v }).on, false, `PAIR_LANE=${v}`);
    assert.equal(pair.pairEnv({ PAIR_LANE: "true" }).on, true);
    assert.equal(pair.pairEnv({ PAIR_LANE: "" }).on, true, "empty is unset");
    assert.equal(pair.pairEnv({ PAIR_QUOTE: "usdc" }).quote, "USDC");
    assert.equal(pair.pairEnv({ PAIR_QUOTE: "PTN" }).quote, "SOL", "an unknown quote falls back to SOL");
    assert.equal(pair.pairEnv({ PAIR_COLLECT_FEE_MODE: "both" }).collectFeeMode, "both");
    assert.equal(pair.pairEnv({ PAIR_COLLECT_FEE_MODE: "junk" }).collectFeeMode, "quote");
    assert.equal(pair.pairEnv({ PAIR_BIN_STEP: "900" }).binStep, 400, "the program's ceiling");
    assert.equal(pair.pairEnv({ PAIR_MAX_POOLS: "2.9" }).maxPools, 2);
    assert.equal(pair.pairEnv({ PAIR_LIVE: "TRUE" }).live, true);
    assert.equal(pair.pairEnv({ PAIR_LIVE: "yes" }).live, false, "only the literal true");
    assert.match(refuse({}, env({ on: false })).reason, /^the pair lane is off \(PAIR_LANE is not true\)$/);
  });

  /* ================= 2. admission ========================================================== */
  console.log("\npair lane / admission");
  await test("the NIKE reference row is admitted on the fixture's numbers, and the verdict carries them", () => {
    const v = pair.pairVerdict(good(), env());
    assert.ok(v.ok, JSON.stringify(v));
    assert.equal(v.ageHours, 1.1);
    assert.equal(v.turnover, 139.99);
    assert.equal(v.refLiquidityUsd, 343_799);
    assert.equal(v.competingDepthUsd, 0);
    assert.deepEqual(v.competitors, []);
  });
  await test("origin and venue: pump.fun tokens on PumpSwap only, quoted in SOL or USDC", () => {
    assert.match(refuse({ origin: null }).reason, /^not a pump\.fun token: the pair lane makes markets in graduated pump\.fun tokens only$/);
    assert.match(refuse({ venue: "raydium" }).reason, /^the reference pool is on raydium, not PumpSwap: the lane wants the token graduated and trading on pump\.fun's AMM$/);
    assert.match(refuse({ venue: "pump-fun" }).reason, /on pump-fun, not PumpSwap/, "the bonding curve is not graduation");
    assert.match(refuse({ quoteSymbol: "PTN" }).reason, /^the reference pool is quoted in PTN, and the pair lane prices its pool from a SOL or USDC reference$/);
    assert.ok(pair.pairVerdict(good({ quoteSymbol: "USDC" }), env()).ok);
    assert.match(refuse({ origin: null, venue: "raydium" }).reason, /^not a pump\.fun token/, "origin is judged first");
  });
  await test("age: nothing in the first half hour, nothing past the window, nothing unaged", () => {
    assert.match(refuse({ ageHours: 0.4 }).reason, /^age 24 min is inside the first 30 min: nothing in its first half hour$/);
    assert.match(refuse({ ageHours: 60 }).reason, /^age 60\.0h is past the 48h pair window: the launch is over$/);
    assert.match(refuse({ ageHours: null }).reason, /^age unknown: the pair lane needs to know how old the reference pool is$/);
    assert.ok(pair.pairVerdict(good({ ageHours: 0.5 }), env()).ok, "exactly 30 minutes is in");
    assert.ok(pair.pairVerdict(good({ ageHours: 48 }), env()).ok, "exactly 48h is in");
  });
  await test("reference liquidity, 24h volume, last-hour volume, turnover: each floor names the number that failed", () => {
    assert.match(refuse({ liquidityUsd: 12_400 }).reason, /^reference liquidity \$12,400 is under the \$30,000 pair floor$/);
    assert.match(refuse({ liquidityUsd: null }).reason, /^reference liquidity unknown: the pair lane will not price a pool against a number nobody reported$/);
    assert.ok(pair.pairVerdict(good({ liquidityUsd: 30_000 }), env()).ok, "exactly the floor is in");
    assert.match(refuse({ vol24hUsd: 900_000 }).reason, /^24h volume \$900,000 is under the \$1,000,000 pair floor$/);
    assert.match(refuse({ vol24hUsd: null }).reason, /^24h volume unknown: fees come from volume, and nobody reported any$/);
    assert.match(refuse({ vol1hUsd: 99_000 }).reason, /^the last hour traded \$99,000, under the \$100,000 pair floor: the 24h figure has already happened$/);
    assert.match(refuse({ vol1hUsd: null }).reason, /^last hour's volume unknown: the pair lane will not trade a 24h number on its own$/);
    assert.match(refuse({ liquidityUsd: 300_000, vol24hUsd: 1_200_000 }).reason, /^turnover 4\.0x \(\$1,200,000 traded on \$300,000 of liquidity\) is under the 5x pair floor$/);
    assert.ok(pair.pairVerdict(good({ liquidityUsd: 240_000, vol24hUsd: 1_200_000 }), env()).ok, "exactly 5x is in");
    const supplied = pair.pairVerdict(good({ liquidityUsd: 300_000, vol24hUsd: 1_200_000, turnover24h: 9 }), env());
    assert.ok(supplied.ok && supplied.turnover === 9, "a supplied turnover is believed over the division");
    assert.match(refuse({ liquidityUsd: 12_400, vol24hUsd: 1 }).reason, /^reference liquidity/, "liquidity is judged before volume");
  });
  await test("dumping: the launch lane's rule, word for word, and the hot watch's own flag", () => {
    assert.match(refuse({ sellShare1h: 0.71, priceChange1hPct: -22 }).reason, /^71% of the last hour's trades were sells \(limit 66%\) and the hour is -22\.0%, not above -10%: it is being dumped$/);
    assert.ok(pair.pairVerdict(good({ sellShare1h: 0.71, priceChange1hPct: 40 }), env()).ok, "selling into a rally is two-sided flow");
    assert.match(refuse({ flags: ["new", "dumping"] }).reason, /^the hot watch flags it `dumping`$/);
    assert.equal(launch.dumpingReason(0.71, -22), refuse({ sellShare1h: 0.71, priceChange1hPct: -22 }).reason, "one rule, shared with the launch lane");
  });
  await test("a reference price is needed to open at", () => {
    assert.match(refuse({ priceNative: null }).reason, /^reference price unknown: nothing to open the pool at$/);
    assert.match(refuse({ priceNative: 0 }).reason, /^reference price unknown/);
  });
  await test("other pools never refuse: competing concentrated depth rides along in the verdict for the model", () => {
    const rows = [
      { address: "m1", venue: "meteora-dlmm", baseMint: NIKE, quoteSymbol: "SOL", liquidityUsd: 40_000 },
      { address: "r1", venue: "raydium-clmm", baseMint: NIKE, quoteSymbol: "USDC", liquidityUsd: 60_000 },
      { address: NIKE_POOL, venue: "pumpswap", baseMint: NIKE, quoteSymbol: "SOL", liquidityUsd: 343_799 }, // the reference: constant product, not concentrated
      { address: "p2", venue: "meteora-dlmm", baseMint: NIKE, quoteSymbol: "PTN", liquidityUsd: 900_000 }, // a quote the book cannot seat
      { address: "o1", venue: "meteora-dlmm", baseMint: "other", quoteSymbol: "SOL", liquidityUsd: 1e6 }, // another token
      { address: "pair-" + NIKE, venue: "meteora-dlmm", baseMint: NIKE, quoteSymbol: "SOL", liquidityUsd: 5_000 }, // ourselves
      { address: "d1", venue: "meteora-dlmm", baseMint: NIKE, quoteSymbol: "SOL", liquidityUsd: null },
    ];
    const c = pair.competitionFor(NIKE, rows, "pair-" + NIKE);
    assert.equal(c.depthUsd, 100_000);
    assert.deepEqual(c.pools.map((p) => p.address), ["r1", "m1"], "concentrated SOL/USDC pools for the mint, deepest first, never ourselves");
    const v = pair.pairVerdict(good(), env(), c);
    assert.ok(v.ok, "an adequate SOL pool elsewhere is not a refusal: we supplement liquidity ourselves");
    assert.equal(v.competingDepthUsd, 100_000);
    assert.equal(v.competitors.length, 2);
  });

  /* ================= 3. seating ============================================================ */
  console.log("\npair lane / seating");
  const cand = (over: Partial<PairCandidate> = {}): PairCandidate => ({ ...good(), heat: 30, ...over });
  const seatOpts = (over: Partial<Parameters<typeof pair.pairSeats>[1]> = {}) => ({ env: env(), freeSeats: 3, quoteOk: (q: string) => q === "SOL", ...over });
  await test("pairSeats: one pool at a time, the busiest last hour first, the seat keyed pair-<mint>", () => {
    const rows = [cand({ address: "a", baseMint: "mA", vol1hUsd: 200_000 }), cand({ address: "b", baseMint: "mB", vol1hUsd: 900_000 }), cand({ address: "c", baseMint: "mC", vol1hUsd: 500_000 })];
    const one = pair.pairSeats(rows, seatOpts());
    assert.deepEqual(one.map((s) => s.address), ["pair-mB"], "PAIR_MAX_POOLS=1: the busiest");
    assert.equal(one[0].row.address, "b");
    assert.ok(one[0].verdict.ok);
    assert.deepEqual(pair.pairSeats(rows, seatOpts({ env: env({ maxPools: 3 }) })).map((s) => s.address), ["pair-mB", "pair-mC", "pair-mA"]);
    assert.deepEqual(pair.pairSeats(rows, seatOpts({ poolsTaken: 1 })), [], "a pool of ours already holding a band takes the one seat");
    assert.deepEqual(pair.pairSeats(rows, seatOpts({ env: env({ maxPools: 3 }), freeSeats: 1 })).map((s) => s.address), ["pair-mB"], "MAX_ACTIVE_POOLS still binds");
    assert.deepEqual(pair.pairSeats(rows, seatOpts({ freeSeats: 0 })), []);
    assert.deepEqual(pair.pairSeats(rows, seatOpts({ env: env({ on: false }) })), [], "the lane off seats nothing");
    assert.deepEqual(pair.pairSeats(rows, seatOpts({ quoteOk: () => false })), [], "the wallet cannot fund the pair's quote");
    assert.deepEqual(pair.pairSeats(rows, seatOpts({ hasPool: (a) => a === "pair-mB" })).map((s) => s.address), ["pair-mC"], "a pool already picked is skipped");
    assert.deepEqual(pair.pairSeats(rows, seatOpts({ hasPool: (a) => a === "b" })).map((s) => s.address), ["pair-mC"], "so is one whose reference pool was picked");
    assert.deepEqual(pair.pairSeats(rows, seatOpts({ hasToken: (m) => m === "mB" })).map((s) => s.address), ["pair-mC"], "one seat per token");
    assert.deepEqual(pair.pairSeats([cand({ ageHours: 100 }), cand({ address: "z", baseMint: "mZ", vol1hUsd: 200_000 })], seatOpts()).map((s) => s.address), ["pair-mZ"], "a row that fails the lane is not seated however busy");
  });
  await test("the watchlist: an ALLOW-list miss cannot block a pair, an explicit DENY still does", () => {
    const row = cand();
    const pool = { address: row.address, baseSymbol: row.baseSymbol, baseMint: row.baseMint, name: row.name };
    const allow = addToken({ ...emptyWatchlist(), mode: "allow" }, { symbol: "SPYx" });
    assert.match(watchlistRefusal(pool, allow)!, /not on the watchlist/);
    assert.equal(watchlistDenial(pool, allow), null);
    assert.equal(pair.pairSeats([row], seatOpts({ denied: (r) => watchlistDenial({ address: r.address, baseSymbol: r.baseSymbol, baseMint: r.baseMint, name: r.name }, allow) })).length, 1);
    for (const w of [denyToken(allow, "NIKE"), denyToken(allow, NIKE), { ...allow, denyPools: [NIKE_POOL] }]) {
      assert.deepEqual(pair.pairSeats([row], seatOpts({ denied: (r) => watchlistDenial({ address: r.address, baseSymbol: r.baseSymbol, baseMint: r.baseMint, name: r.name }, w) })), [], "a deny wins");
    }
  });
  await test("pairCandidatesOf: the pump.fun rows of a hot file, with the reference figures the verdict reads", () => {
    const rows = pair.pairCandidatesOf([hotRowOf(), hotRowOf({ address: "x", baseMint: "m", origin: null, venue: "meteora-dlmm" })]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].baseMint, NIKE);
    assert.equal(rows[0].priceNative, NIKE_PRICE);
    near(rows[0].turnover24h, 48_129_456 / 343_799, 1e-9);
    assert.ok(pair.pairVerdict(rows[0], env()).ok);
  });
  await test("pairLaunchEnv: the launch lane's terms with the pair's stop, hold and seat; the fade floor stays", () => {
    const l = launch.launchEnv({});
    const e = pair.pairLaunchEnv(env(), l);
    assert.equal(e.on, true);
    assert.equal(e.stopPct, 10);
    assert.equal(e.maxHoldMin, 240);
    assert.equal(e.seatPct, 10);
    assert.equal(e.fadeVolume1hUsd, 20_000);
    assert.equal(pair.pairLaunchEnv(env({ stopPct: 6, maxHoldMin: 90 }), { ...l, on: false }).on, true, "on even when the launch lane is off");
    assert.equal(pair.pairSeatSol(100, env()), 10);
    assert.equal(pair.pairSeatSol(1, env({ seatPct: 25 })), 0.25);
    assert.equal(pair.pairPoolAddress("mint"), "pair-mint");
    assert.equal(pair.pairMintOf("pair-mint"), "mint");
    assert.equal(pair.pairMintOf("mint"), null);
    assert.equal(pair.isPairAddress("pair-"), true);
  });

  /* ================= 4. the routing model ================================================== */
  console.log("\npair lane / the routing model");
  const model = (over: Partial<Parameters<typeof pair.routedShare>[0]> = {}) => ({
    ourFeePct: 1, ourDepthPerBinUsd: 350, binStepBps: 100, theirFeePct: 0.25, theirLiquidityUsd: 50_000, tradeMinUsd: 50, tradeMaxUsd: 5000, ourBins: 5, ...over,
  });
  await test("the worked example: D=$500, L=$50,000, B=$350: ours 1% + ~0.7% beats theirs 0.25% + 2%", () => {
    near(pair.ourCostPct(500, model()), 1 + 0.5 * (500 / 350), 1e-9, "ours");
    near(pair.theirCostPct(500, model()), 2.25, 1e-9, "theirs");
    assert.ok(pair.ourCostPct(500, model())! < pair.theirCostPct(500, model()));
    // beyond our five bins we cannot fill: D > 5 x 350
    assert.equal(pair.ourCostPct(1751, model()), null);
    near(pair.ourCostPct(1750, model()), 1 + 0.5 * 5, 1e-9);
    // ours < theirs once 1 + D/700 < 0.25 + 0.004 D, i.e. D > $291.7; and nothing over 5 x $350 = $1,750 can fill.
    assert.ok(pair.ourCostPct(291, model())! > pair.theirCostPct(291, model()), "under $292 their 0.25% fee wins");
    assert.ok(pair.ourCostPct(293, model())! < pair.theirCostPct(293, model()), "over $292 our depth wins");
    // value-weighted over a log-uniform [50, 5000]: the value between two sizes is proportional to their difference
    const share = pair.routedShare(model());
    near(share, (1750 - 291.7) / (5000 - 50), 0.01, "the share of value in ($292, $1,750]");
  });
  await test("monotonic in our depth, in their fee; decreasing in our fee; 0 when we cannot fill anything", () => {
    let prev = -1;
    for (const b of [50, 100, 200, 350, 700, 1400, 5000]) {
      const s = pair.routedShare(model({ ourDepthPerBinUsd: b }));
      assert.ok(s >= prev, `depth ${b}: ${s} < ${prev}`);
      prev = s;
    }
    // deep enough for every trade in the range, but the smallest ones (under ~$192) still prefer their 0.25% fee
    near(pair.routedShare(model({ ourDepthPerBinUsd: 5000 })), (5000 - 192.3) / 4950, 0.01, "all but the tiny trades");
    assert.equal(pair.routedShare(model({ ourDepthPerBinUsd: 5000, ourFeePct: 0.25 })), 1, "at their fee and deep enough: everything");
    prev = -1;
    for (const f of [0, 0.1, 0.25, 0.5, 1, 2]) {
      const s = pair.routedShare(model({ theirFeePct: f }));
      assert.ok(s >= prev, `their fee ${f}: ${s} < ${prev}`);
      prev = s;
    }
    prev = 2;
    for (const f of [0.1, 0.5, 1, 2, 5]) {
      const s = pair.routedShare(model({ ourFeePct: f }));
      assert.ok(s <= prev, `our fee ${f}: ${s} > ${prev}`);
      prev = s;
    }
    assert.equal(pair.routedShare(model({ ourDepthPerBinUsd: 1 })), 0, "five bins of $1 cannot fill a $50 trade");
    assert.equal(pair.routedShare(model({ ourDepthPerBinUsd: 0 })), 0);
    assert.equal(pair.routedShare(model({ ourBins: 0 })), 0);
    assert.equal(pair.routedShare(model({ ourFeePct: 5 })), 0, "a 5% fee is never the cheaper route against 0.25% + 2D/L on $5k trades");
  });
  await test("competing concentrated depth splits the routed flow by depth; gross and net are both reported", () => {
    const b = pair.routedShareBreakdown(model());
    assert.equal(b.ourDepthUsd, 3500, "5 bins x $350 x both sides");
    assert.equal(b.net, b.gross, "no competitors: nothing to share");
    const c = pair.routedShareBreakdown(model({ competingConcentratedDepthUsd: 3500 }));
    assert.equal(c.gross, b.gross);
    near(c.net, b.gross / 2, 1e-9, "equal depth: half");
    const d = pair.routedShareBreakdown(model({ competingConcentratedDepthUsd: 31_500 }));
    near(d.net, b.gross / 10, 1e-9, "nine times our depth: a tenth");
    assert.equal(pair.routedShare(model({ competingConcentratedDepthUsd: 31_500 })), d.net);
  });
  await test("pairSeats with `worth`: the model's best candidate is seated first, and one the model routes nothing to is skipped rather than given the only seat", () => {
    const mk = (symbol: string, vol1hUsd: number): PairCandidate => ({
      address: `ref-${symbol}`, name: `${symbol} / SOL`, venue: "pumpswap", baseMint: `${symbol}mint`, baseSymbol: symbol, quoteSymbol: "SOL", origin: "pump.fun",
      ageHours: 4, liquidityUsd: 300_000, vol24hUsd: 50_000_000, vol1hUsd, sellShare1h: 0.5, priceChange1hPct: 3, flags: [], priceNative: 0.001, heat: 50,
    });
    const rows = [mk("LOUD", 16_000_000), mk("QUIET", 13_000_000)];
    const base = { env: env(), freeSeats: 1, quoteOk: () => true };
    assert.deepEqual(pair.pairSeats(rows, base).map((s) => s.row.baseSymbol), ["LOUD"], "without a model, the last hour's volume orders");
    const worth = (r: PairCandidate) => (r.baseSymbol === "QUIET" ? 50_000 : 0);
    assert.deepEqual(pair.pairSeats(rows, { ...base, worth }).map((s) => s.row.baseSymbol), ["QUIET"], "the model's pick takes the seat; the one it routes nothing to is skipped");
    assert.deepEqual(pair.pairSeats(rows, { ...base, worth: () => 0 }), [], "nothing worth seating, nothing seated");
  });
  await test("the synthetic snapshot models at the pool's own fee: a pool the lane priced at 25 bps is not judged at the env's 50", async () => {
    const REF = { address: NIKE_POOL, name: "NIKE / SOL", venue: "pumpswap", baseMint: NIKE, baseSymbol: "NIKE", quoteMint: SOL, quoteSymbol: "SOL", origin: "pump.fun",
      ageHours: 4.7, liquidityUsd: 304_802, vol24hUsd: 60_660_376, vol1hUsd: 13_161_294, priceNative: 0.000000356, priceUsd: 0.0000364711, sellShare1h: 0.5, priceChange1hPct: 3, flags: [], heat: 60 };
    const venue = await import("../venues/pair.js");
    const pv = venue.createPairVenue({
      env: () => env(), // PAIR_FEE_BPS unset: the lane chooses
      hot: () => ({ generatedAt: new Date().toISOString(), rows: [REF] }) as never,
      paper: () => null,
      created: () => ({}),
      seatSol: () => 35,
      solPriceUsd: () => 102.5,
      screenRows: () => [],
      accountExists: async () => false,
      mintDecimals: async () => 6,
      ourBins: () => null,
    });
    const pool = await pv.loadPool({} as never, "pair-" + NIKE);
    assert.equal((pool as { pair: { feeBps: number } }).pair.feeBps, 25, "the lane chose PumpSwap's fee for this seat");
    const s = await pv.snapshot(pool, 10, { solPriceUsd: 102.5 });
    assert.equal(s.baseFeePct, 0.25);
    assert.ok(s.pair!.routedShare > 0.3, `the model at the pool's own fee routes a third of the flow, got ${s.pair!.routedShare}`);
  });
  await test("chooseFeeBps: a deep reference next to a small seat wants PumpSwap's own fee, a thin one lets a bigger seat charge more; a fixed PAIR_FEE_BPS is honoured", () => {
    assert.deepEqual(pair.feeMenu(undefined), [25, 50, 100]);
    assert.deepEqual(pair.feeMenu(" 100, 25 ,25, 0, 2000, x "), [25, 100]);
    const nike = { liquidityUsd: 294_117, vol24hUsd: 59_384_404, vol1hUsd: 13_205_642 };
    assert.equal(pair.chooseFeeBps(nike, env(), 3_605), 25, "$3.6k against a $294k pool: only PumpSwap's fee wins any flow");
    assert.equal(pair.pairModel(nike, env(), 3_605).routedShare, 0, "at the 50 bps default that seat routes nothing");
    assert.ok(pair.pairModel(nike, env({ feeBps: 25 }), 3_605).routedShare > 0.3);
    const thin = { liquidityUsd: 30_000, vol24hUsd: 1_000_000, vol1hUsd: 100_000 };
    assert.equal(pair.chooseFeeBps(thin, env(), 10_000), 100, "$10k against a $30k pool: the walk is cheap, charge the most");
    assert.equal(pair.chooseFeeBps(nike, env({ feeBps: 50, feeBpsFixed: true }), 3_605), 50, "a fixed fee is used as set");
    assert.equal(pair.chooseFeeBps(nike, env(), 0), env().feeBps, "no seat, the default");
    assert.equal(pair.chooseFeeBps({ liquidityUsd: null, vol24hUsd: null, vol1hUsd: null }, env(), 3_605), env().feeBps, "no reference, the default");
  });
  await test("fees per day: min(vol24h, vol1h x 24) x share x fee; pairModel puts the seat through it", () => {
    near(pair.pairFeesPerDayUsd(48_000_000, 1_000_000, 0.5, 1), 24_000_000 * 0.5 * 0.01, 1e-9, "the last hour's pace is lower");
    near(pair.pairFeesPerDayUsd(1_000_000, 100_000, 0.5, 1), 1_000_000 * 0.5 * 0.01, 1e-9, "the 24h figure is lower");
    assert.equal(pair.pairFeesPerDayUsd(null, null, 0.5, 1), 0);
    assert.equal(pair.pairFeesPerDayUsd(1_000_000, null, 0, 1), 0);
    const wide = env({ feeBps: 100, binsEachSide: 5 }); // the worked example's geometry: 1% fee, five 1% bins a side
    const m = pair.pairModel({ liquidityUsd: 50_000, vol24hUsd: 2_000_000, vol1hUsd: 100_000 }, wide, 3500);
    assert.equal(m.ourDepthPerBinUsd, 350, "$3,500 seat: $1,750 a side over 5 bins");
    assert.equal(m.ourDepthUsd, 3500);
    near(m.routedShare, pair.routedShare(model()), 1e-9);
    near(m.feesPerDayUsd, 2_000_000 * m.routedShare * 0.01, 1e-9);
    near(m.routedVolume24hUsd, 2_000_000 * m.routedShare, 1e-9);
    const mc = pair.pairModel({ liquidityUsd: 50_000, vol24hUsd: 2_000_000, vol1hUsd: 100_000 }, wide, 3500, 3500);
    near(mc.routedShare, m.routedShare / 2, 1e-9);
    assert.equal(mc.routedShareGross, m.routedShareGross);
    assert.equal(pair.pairModel({ liquidityUsd: 50_000, vol24hUsd: 2_000_000, vol1hUsd: 100_000 }, wide, 0).routedShare, 0, "no seat, no share");
    // the shipped defaults (0.5% fee, two 1% bins a side) beat the wide geometry on the same seat: the range is the lever, not the fee
    const tight = pair.pairModel({ liquidityUsd: 50_000, vol24hUsd: 2_000_000, vol1hUsd: 100_000 }, env(), 3500);
    assert.equal(tight.ourDepthPerBinUsd, 875);
    assert.ok(tight.routedShare > m.routedShare, `tight ${tight.routedShare} vs wide ${m.routedShare}`);
  });

  /* ================= 5. geometry =========================================================== */
  console.log("\npair lane / geometry");
  await test("activeIdFromPrice round-trips binPrice at 1%/bin for a 6-decimal token quoted in SOL, and rounds to the nearest bin", () => {
    const geo = { binStep: 100, tokenX: { decimals: 6 }, tokenY: { decimals: 9 } };
    for (const id of [-2200, -1500, -1000, -100, 0, 100, 1523]) assert.equal(pair.activeIdFromPrice(binPrice(geo, id), 100, 6, 9), id, `bin ${id}`);
    const id = pair.activeIdFromPrice(NIKE_PRICE, 100, 6, 9);
    const below = binPrice(geo, id - 1);
    const above = binPrice(geo, id + 1);
    assert.ok(NIKE_PRICE > Math.sqrt(below * binPrice(geo, id)) && NIKE_PRICE < Math.sqrt(above * binPrice(geo, id)), "the nearest bin in log space");
    assert.equal(pair.activeIdFromPrice(binPrice({ binStep: 20, tokenX: { decimals: 6 }, tokenY: { decimals: 6 } }, 777), 20, 6, 6), 777, "USDC quote, 20 bps");
    assert.throws(() => pair.activeIdFromPrice(0, 100, 6, 9), /bad price/);
  });

  /* ================= 6. the live builder, offline ========================================== */
  console.log("\npair lane / the live builder (no RPC)");
  await test("rent: the SDK's own figures, and the desk's totals", () => {
    assert.equal(venue.PAIR_SDK_RENT.POOL_FEE, sdk.POOL_FEE);
    assert.equal(venue.PAIR_SDK_RENT.TOKEN_ACCOUNT_FEE, sdk.TOKEN_ACCOUNT_FEE);
    assert.equal(venue.PAIR_SDK_RENT.BIN_ARRAY_FEE, sdk.BIN_ARRAY_FEE);
    assert.equal(venue.PAIR_SDK_RENT.POSITION_FEE, sdk.POSITION_FEE);
    near(venue.PAIR_LB_PAIR_RENT_SOL, 0.00718272, 1e-12);
    near(venue.PAIR_RESERVE_RENT_SOL, 0.00203928, 1e-12);
    near(venue.PAIR_ORACLE_RENT_SOL, 0.0011136, 1e-12);
    near(venue.PAIR_POOL_ACCOUNTS_RENT_SOL, 0.01237488, 1e-12);
    near(venue.PAIR_CREATION_RENT_SOL, 0.15524976, 1e-12, "lb pair + 2 reserves + oracle + 2 bin arrays");
    near(venue.PAIR_OPEN_COST_SOL, 0.21264976, 1e-12, "plus the position rent (the desk's 0.0574; the SDK says 0.05740608), which comes back");
    near(venue.PAIR_OPEN_COST_SOL - venue.PAIR_CREATION_RENT_SOL, dlmm.POSITION_RENT_SOL, 1e-12);
  });
  await test("pairCreateParams: the address from the pair alone, the base factor, timestamp activation, no alpha vault, quote-only fees", () => {
    const p = venue.pairCreateParams({ tokenMint: NIKE, quoteMint: SOL, binStep: 100, feeBps: 100, activeId: -1500, collectFeeMode: "quote" });
    assert.equal(p.tokenX.toBase58(), NIKE, "the token is X");
    assert.equal(p.tokenY.toBase58(), SOL, "the quote is Y: the program's quote check is on Y");
    assert.equal(p.programId.toBase58(), sdk.LBCLMM_PROGRAM_IDS["mainnet-beta"]);
    const [expected] = sdk.deriveCustomizablePermissionlessLbPair(new PublicKey(NIKE), new PublicKey(SOL), p.programId);
    assert.equal(p.lbPair.toBase58(), expected.toBase58(), "the SDK's derivation");
    assert.equal(venue.pairLbPairAddress(NIKE, SOL), expected.toBase58());
    assert.equal(sdk.deriveReserve(p.tokenX, p.lbPair, p.programId)[0].toBase58(), p.reserveX.toBase58());
    assert.equal(sdk.deriveOracle(p.lbPair, p.programId)[0].toBase58(), p.oracle.toBase58());
    assert.equal(p.baseFactor, 10_000, "100 bps x 10000 / 100");
    assert.equal(p.baseFeePowerFactor, 0);
    assert.equal(p.activationType, sdk.ActivationType.Timestamp);
    assert.equal(p.activationPoint, null, "live at once");
    assert.equal(p.hasAlphaVault, false);
    assert.equal(p.creatorPoolOnOffControl, false);
    assert.equal(p.collectFeeMode, sdk.CollectFeeMode.OnlyY, "fees in the quote only");
    assert.equal(venue.pairCreateParams({ tokenMint: NIKE, quoteMint: SOL, binStep: 100, feeBps: 100, activeId: 0, collectFeeMode: "both" }).collectFeeMode, sdk.CollectFeeMode.InputOnly);
    // the pool address does not depend on the bin step or the fee: there can be only ONE customizable pool per pair
    const other = venue.pairCreateParams({ tokenMint: NIKE, quoteMint: SOL, binStep: 25, feeBps: 30, activeId: 0, collectFeeMode: "both" });
    assert.equal(other.lbPair.toBase58(), p.lbPair.toBase58());
    assert.equal(other.baseFactor, 12_000, "30 bps x 10000 / 25");
    const usdc = venue.pairCreateParams({ tokenMint: NIKE, quoteMint: USDC, binStep: 100, feeBps: 100, activeId: 0, collectFeeMode: "quote" });
    assert.notEqual(usdc.lbPair.toBase58(), p.lbPair.toBase58(), "a different quote is a different pair");
  });
  await test("the program's constraints are refused in words: the quote allowlist, bin step and fee bounds, an unrepresentable fee", () => {
    const base = { tokenMint: NIKE, quoteMint: SOL, binStep: 100, feeBps: 100, activeId: 0, collectFeeMode: "quote" as const };
    assert.throws(() => venue.pairCreateParams({ ...base, quoteMint: "PTNzAfFAB4LvoUQEUUGrFMyUoRLExMYjH6CcfyQfsVP" }), /quote PTNzAf is not allowed: the program's customizable permissionless pairs must be quoted in SOL or USDC/);
    assert.throws(() => venue.pairCreateParams({ ...base, tokenMint: SOL }), /the same mint/);
    assert.throws(() => venue.pairCreateParams({ ...base, binStep: 0 }), /bin step 0 is outside the program's \[1, 400\]/);
    assert.throws(() => venue.pairCreateParams({ ...base, binStep: 401 }), /outside the program's/);
    assert.throws(() => venue.pairCreateParams({ ...base, feeBps: 0 }), /fee 0 bps is outside/);
    assert.throws(() => venue.pairCreateParams({ ...base, feeBps: 1001 }), /10% max/);
    assert.throws(() => venue.pairCreateParams({ ...base, binStep: 3, feeBps: 1 }), /cannot be represented/);
    assert.throws(() => venue.pairCreateParams({ ...base, activeId: 1.5 }), /not an integer/);
  });
  await test("the broadcast gate: dry-run never sends, PAIR_LIVE and LIVE_VENUES both have to say yes", () => {
    assert.equal(venue.pairBroadcastRefusal(env({ live: false }), true), null, "dry-run: nothing is sent anyway");
    assert.match(venue.pairBroadcastRefusal(env({ live: false }), false)!, /^PAIR_LIVE is not true: the create transaction is built and simulated, not sent$/);
    assert.match(venue.pairBroadcastRefusal(env({ live: true }), false, { LIVE_VENUES: "none" })!, /^meteora-dlmm is not in LIVE_VENUES/);
    assert.match(venue.pairBroadcastRefusal(env({ live: true }), false, { LIVE_VENUES: "raydium-clmm" })!, /not in LIVE_VENUES/);
    assert.equal(venue.pairBroadcastRefusal(env({ live: true }), false, { LIVE_VENUES: "meteora-dlmm" }), null);
    assert.equal(venue.pairBroadcastRefusal(env({ live: true }), false, {}), null, "the default LIVE_VENUES is Meteora");
  });
  await test("reference rows: the deepest PumpSwap pool of the mint; hotRowForPool maps a pair key to it", () => {
    const hot = hotFileOf([hotRowOf({ address: "shallow", liquidityUsd: 1000 }), hotRowOf(), hotRowOf({ address: "other", baseMint: "m2", baseSymbol: "OTHER" })]);
    assert.equal(venue.referenceRowFor(hot, NIKE)!.address, NIKE_POOL);
    assert.equal(venue.referenceRowFor(hot, "nope"), null);
    assert.equal(venue.referenceRowFor(null, NIKE), null);
    assert.equal(venue.hotRowForPool(hot, "pair-" + NIKE)!.address, NIKE_POOL);
    assert.equal(venue.hotRowForPool(hot, "other")!.baseSymbol, "OTHER");
    assert.equal(venue.hotRowForPool(hot, "pair-nope"), undefined);
    const noPump = hotFileOf([hotRowOf({ venue: "meteora-dlmm", origin: "pump.fun" })]);
    assert.equal(venue.referenceRowFor(noPump, NIKE)!.venue, "meteora-dlmm", "with no PumpSwap row, any pump.fun row for the mint");
  });

  /* ================= 7. the paper path, end to end ========================================== */
  // A thinner reference than the NIKE fixture, and a bigger seat: against $344k of constant-product
  // depth a $1,000 seat at a 1% fee is never the cheaper route (the model says so, honestly), so the
  // walk-through uses a $40k reference and a 50 SOL ($5,000) seat: $500 per 1% bin.
  console.log("\npair lane / paper");
  venue.clearPairCaches();
  // the walk pins the worked example's geometry (1% fee, five 1% bins a side) so its figures read straight off the model
  const penv = env({ seatPct: 50, feeBps: 100, feeBpsFixed: true, binsEachSide: 5 });
  const REF = { liquidityUsd: 40_000, vol24hUsd: 2_000_000, vol1hUsd: 150_000 };
  const refRow = (over: Partial<HotRow> = {}): HotRow => hotRowOf({ ...REF, ...over });
  const book = paper.emptyBook(100, 0, NOW);
  let hot: HotFile | null = hotFileOf([refRow()]);
  let clock = NOW;
  const fakeConnection = { getAccountInfo: async () => null } as never;
  const pv = venue.createPairVenue({
    paper: () => book,
    created: () => ({}),
    seatSol: () => 50,
    solPriceUsd: () => 100,
    screenRows: () => [],
    ourBins: (address, activeBinId, binsEachSide, spec) => paper.paperBinRows(book, address, activeBinId, binsEachSide, { binStep: spec.binStep, xDecimals: spec.decimals, yDecimals: spec.quoteDecimals }),
    env: () => penv,
    hot: () => hot,
    accountExists: async () => false,
    mintDecimals: async () => 6,
    now: () => clock,
  });
  const KEY = "pair-" + NIKE;
  const snap = (bins = 10) => pv.snapshot(pool, bins, { solPriceUsd: 100 });
  const pool = await pv.loadPool(fakeConnection, KEY);

  /** the loop's observation for the pair pool, as src/index.ts builds it */
  const observe = (s: PoolSnapshot, positions: PositionSnapshot[], walletToken = 0, oor: Record<string, number> = {}): Observation => ({
    ts: new Date(clock).toISOString(), cycle: 1, mode: "dry-run", poolLabel: s.label, snapshot: s, positions,
    wallet: { address: "w", sol: book.wallet.sol, token: walletToken, tokenSymbol: "NIKE", quote: book.wallet.sol, quoteSymbol: "SOL" },
    analytics: null,
    state: { actionsToday: 0, lastActionAt: null, lastMoveAt: null, lastPrice: null, killSwitch: false },
    recent: [],
    screen: {
      rank: 0, rankedPools: 400, score: 0, feeToTvl24hPct: null, volume24hUsd: s.pair!.refVol24hUsd, tvlUsd: s.pair!.refLiquidityUsd, ageHours: 1.1, priceChange24hPct: 300,
      flags: ["new", "fee-unknown"], watchlisted: false, launch: null, pair: { ok: true, ageHours: 1.1, turnover: 50 }, recentMovePct: null,
      generatedAt: new Date(clock).toISOString(), stock: null, alternatives: [], hot: [],
    },
    portfolio: { activePools: [s.label], poolsWithBands: 0, maxActivePools: 3, otherExposureSol: 0 },
    engine: {
      halt: null, standDown: null, bench: { stops6h: 0, multiplier: 1, benched: false, reason: null }, regime: { medianMove24hPct: 0, multiplier: 1, reason: null },
      sizeMultiplier: 1, effectiveMaxPositionSol: 60, stops: {}, outOfRangeSec: oor, minOutOfRangeSec: 120, knife: null, collectsToday: 0, collectMaxPerDay: 30,
    },
  });
  const verdictOf = (decision: Decision, over: Partial<Verdict> = {}): Verdict => ({ proposal: decision, decision, allowed: true, violations: [], overrides: [], passed: [], emergency: false, ...over });
  /** the report's identity, against the book's START: equity - start = realized + marked + hedge - rent locked - rent spent - swap cost - tx fees */
  const identity = (b: typeof book, start: number = b.startSol) => {
    const eq = paper.bookEquitySol(b);
    const realized = b.closed.reduce((t, c) => t + c.realizedSol, 0) + b.feesClaimedSol;
    const marked = b.bands.reduce((t, x) => t + ((x.lastMark?.valueInSol ?? x.entryValueSol) - x.entryValueSol), 0) + eq.tokensMarkedSol;
    return { lhs: eq.equitySol - start, rhs: realized + marked + eq.hedgeSol - b.rentLockedSol - b.rentSpentSol - (b.swapCostSol ?? 0) - (b.txFeesSol ?? 0) };
  };

  let s0: PoolSnapshot;
  await test("loadPool + a synthetic snapshot: the reference price, the active bin, our bin step and fee, the model, the creation rent", async () => {
    assert.equal(pool.pair.mint, NIKE);
    assert.equal(pool.pair.symbol, "NIKE");
    assert.equal(pool.pair.decimals, 6);
    assert.equal(pool.pair.quote, "SOL");
    assert.equal(pool.pair.lbPair, venue.pairLbPairAddress(NIKE, SOL));
    assert.equal(pool.dlmm, null);
    assert.ok(venue.isPairPool(pool));
    s0 = await snap();
    assert.equal(s0.address, KEY);
    assert.equal(s0.label, "NIKE/SOL");
    assert.equal(s0.binStep, 100);
    assert.equal(s0.baseFeePct, 1, "this walk's PAIR_FEE_BPS");
    assert.equal(s0.tokenX.mint, NIKE, "the token is X");
    assert.equal(s0.tokenY.mint, SOL, "the quote is Y");
    assert.equal(s0.quoteSymbol, "SOL");
    assert.equal(s0.activeBinId, pair.activeIdFromPrice(NIKE_PRICE, 100, 6, 9));
    near(s0.activePrice, NIKE_PRICE, 0.005, "the active bin's price is within half a bin of the reference");
    assert.equal(s0.bins.length, 21);
    assert.ok(s0.bins.every((b) => b.xAmount === 0 && b.yAmount === 0), "nobody is in the pool yet");
    const p = s0.pair!;
    assert.equal(p.exists, false);
    assert.equal(p.ours, false);
    assert.equal(p.synthetic, true);
    assert.equal(p.stale, false);
    assert.equal(p.refPool, NIKE_POOL);
    assert.equal(p.refVenue, "pumpswap");
    assert.equal(p.refLiquidityUsd, 40_000);
    assert.equal(p.seatUsd, 5000, "50 SOL at $100");
    // $500 per bin: ours 1 + D/1000 beats theirs 0.25 + D/200 above $187.5, fillable to $2,500
    near(p.routedShare, (2500 - 187.5) / 4950, 0.01, `share ${p.routedShare}`);
    assert.equal(p.routedShareGross, p.routedShare, "no competing depth");
    near(p.feesPerDayUsd, Math.min(REF.vol24hUsd, REF.vol1hUsd * 24) * p.routedShare * 0.01, 1e-9);
    assert.equal(p.ourShare, 1);
    assert.equal(p.collectFeeMode, "quote");
    near(p.creationRentSol, venue.PAIR_CREATION_RENT_SOL, 1e-12);
    const cost = pv.openCostSol(s0);
    near(cost.total, venue.PAIR_OPEN_COST_SOL, 1e-12);
    near(cost.refundable, dlmm.POSITION_RENT_SOL, 1e-12);
    assert.deepEqual(await pv.positions(pool, new PublicKey(SOL), s0), { raw: [], positions: [] });
    await assert.rejects(() => pv.buildOpen(pool, new PublicKey(SOL), { minBinId: 0, maxBinId: 1, amountX: new BN(0), amountY: new BN(0), strategyType: 0, slippagePct: 1 }, s0), /does not exist yet/);
  });

  let opened: Decision;
  await test("the policy makes the pair: a two-sided seat, half SOL half NIKE bought first, capped at 10% of the book, the headline in Mr Bands' voice", () => {
    const o = observe(s0, []);
    assert.ok(policy.isPairPool(o));
    const r = policy.policyDecide(o, { limits, now: clock, openCostSol: pv.openCostSol(s0).total, pair: penv, launch: launch.launchEnv({}) });
    assert.equal(r.decision.action, "OPEN_POSITION", r.reason);
    assert.equal(r.branch, "open");
    const open = r.decision.open!;
    assert.equal(open.side, "BOTH");
    assert.equal(open.binsBelowActive, 5);
    assert.equal(open.binsAboveActive, 5);
    assert.equal(open.amountSol, 25, "half of the 50 SOL seat");
    near(open.amountToken, 25 / s0.activePrice, 1e-6, "the other half in NIKE at the active price");
    assert.equal(open.acquireToken, open.amountToken, "the wallet holds none: the whole half is bought");
    assert.equal(r.decision.headline, "Made the pair: NIKE/SOL on Meteora, 1% bins, 25 SOL each side. Ours alone.");
    assert.match(r.decision.reasoning, /pair lane: NIKE graduated 1\.1h ago/);
    assert.match(r.decision.reasoning, /a Meteora DLMM pool of our own at 1% per bin and 1% fee, fees collected in SOL only/);
    assert.match(r.decision.reasoning, /buying [\d.]+ NIKE first/);
    assert.match(r.decision.reasoning, /Routing model: \$500 per 1% bin makes our pool the cheaper route for 4[\d.]+% of the reference flow by value: about \$[\d,]+ a day at our 1% fee, all of it ours while nobody else is in the pool\./);
    assert.match(r.decision.reasoning, /Pool rent 0\.1552 SOL never comes back\. Pair lane: capped at 50 SOL \(50% of the 100 SOL book\); stop rolled at 10% instead of 15%, closed after 240 min or when the reference pool's last hour falls under \$20,000; every close sells the NIKE back to SOL\./);
    assert.match(formatObservation(o), /PAIR LANE: this is OUR OWN pool for NIKE \(not created yet: the first OPEN creates it, paying 0\.1552 SOL of rent that never comes back\)/);
    opened = r.decision;
    // the guards let it through: the quote covers the SOL half and the purchase, the SOL covers the rent
    const v = evaluate(opened, { now: clock, snapshot: s0, positions: [], walletSol: book.wallet.sol, walletToken: 0, walletQuote: book.wallet.sol, state: emptyState("2026-09-14"), killSwitch: false, otherExposureSol: 0, poolsWithBands: 0, maxActivePools: 3, engine: NO_ENGINE, source: "llm", openCostSol: pv.openCostSol(s0).total }, limits);
    assert.deepEqual(v.violations, []);
    assert.ok(v.allowed);
  });
  await test("the policy passes when the model routes nothing to a pool this size, naming the payback", () => {
    const tiny = { ...s0, pair: { ...s0.pair!, feesPerDayUsd: 0, routedShare: 0, routedShareGross: 0 } };
    const r = policy.policyDecide(observe(tiny, []), { limits, now: clock, openCostSol: pv.openCostSol(s0).total, pair: penv, launch: launch.launchEnv({}) });
    assert.equal(r.decision.action, "HOLD");
    assert.equal(r.branch, "not-worth");
    assert.match(r.reason, /sends none of the reference flow/);
    const slow = { ...s0, pair: { ...s0.pair!, feesPerDayUsd: 2 } };
    const r2 = policy.policyDecide(observe(slow, []), { limits, now: clock, openCostSol: pv.openCostSol(s0).total, pair: penv, launch: launch.launchEnv({}) });
    assert.equal(r2.branch, "not-worth");
    assert.match(r2.reason, /payback [\d.]+h over the 24h limit/);
  });

  let bandAddr: string;
  await test("create -> open in the paper book: the pool is made, its rent charged as unrecoverable, the NIKE half bought, the band laid; the identity holds", async () => {
    const r = paper.executePaper(verdictOf(opened), { book, snapshot: s0, positions: [], slippagePct: 0.3, now: clock, openCost: pv.openCostSol(s0) });
    assert.ok(r.ok, r.notes.join("; "));
    assert.equal(r.mode, "paper");
    assert.deepEqual(r.txs.map((t) => t.label.split(" ")[0]), ["create", "swap", "open"], "create the pool, buy the token half, seed the band");
    assert.match(r.txs[0].skipped!, /paper: made pair-.* on Meteora DLMM, bin step 100 \(1\.00%\/bin\), base fee 1%, fees collected in the SOL only; creation rent 0\.155250 SOL charged, none of it refundable/);
    assert.deepEqual(r.ledger!.map((l) => l.mech), ["rent", "swap", "open"]);
    near(r.ledger![0].rentSol, -venue.PAIR_CREATION_RENT_SOL, 1e-12);
    near(r.ledger![2].rentSol, -dlmm.POSITION_RENT_SOL, 1e-9, "the seed pays the position rent only");
    const made = book.pairPools![KEY];
    assert.ok(made, "recorded in the book");
    assert.equal(made.mint, NIKE);
    assert.equal(made.refPool, NIKE_POOL);
    assert.equal(made.binStep, 100);
    assert.equal(made.feeBps, 100);
    near(made.rentSol, venue.PAIR_CREATION_RENT_SOL, 1e-12);
    near(book.rentSpentSol, venue.PAIR_CREATION_RENT_SOL, 1e-9, "the creation rent is the book's unrecoverable rent");
    near(book.rentLockedSol, dlmm.POSITION_RENT_SOL, 1e-9);
    assert.equal(book.bands.length, 1);
    bandAddr = book.bands[0].address;
    assert.equal(book.bands[0].side, "BOTH");
    assert.equal(book.bands[0].quoteDeposit, 25);
    near(book.bands[0].tokenDeposit, opened.open!.amountToken, 1e-9);
    assert.ok((book.wallet.tokens[NIKE] ?? 0) < 1e-3, "the bought half went into the band");
    const id = identity(book);
    near(id.lhs, id.rhs, 1e-9, "equity identity after the open");
    // the second time the pool costs the seed's rent only
    const s1 = await snap();
    assert.equal(s1.pair!.exists, true);
    assert.equal(s1.pair!.ours, true);
    assert.equal(s1.pair!.creationRentSol, 0);
    near(pv.openCostSol(s1).total, dlmm.OPEN_COST_ESTIMATE_SOL, 1e-12);
    assert.ok(s1.bins.some((b) => b.yAmount > 0) && s1.bins.some((b) => b.xAmount > 0), "the synthetic bins show our own deposits");
  });
  await test("mark at open: in range, the deposit's value; then the reference moves +2% and 10 minutes pass: fees accrue in SOL only at the model's rate, 100% share", async () => {
    const p0 = paper.markPool(book, await snap(), { now: clock, fees: null, solPriceUsd: 100 });
    assert.equal(p0.length, 1);
    assert.ok(p0[0].inRange);
    near(p0[0].valueInSol, 50, 0.01, "25 SOL + the NIKE half at the active price");
    assert.equal(book.bands[0].feeQuote, 0);
    hot = hotFileOf([refRow({ priceNative: NIKE_PRICE * 1.02 })]);
    clock += 10 * M;
    const s2 = await snap();
    assert.equal(s2.activeBinId, s0.activeBinId + 2, "2% is two 1% bins");
    const p2 = paper.markPool(book, s2, { now: clock, fees: null, solPriceUsd: 100 });
    assert.ok(p2[0].inRange, "two bins up is inside five bins each side");
    const fees = s2.pair!.feesPerDayUsd * 1 * 0.5 * (600 / 86400);
    near(book.bands[0].feeQuote, fees / 100, 1e-9, "fees per day x share 1 x the in-range factor x dt, in SOL at $100");
    assert.equal(book.bands[0].feeToken, 0, "collected in the quote only");
    assert.ok(book.pairPools![KEY].lastRoutedShare! > 0);
    assert.equal(book.pairPools![KEY].lastRefStale, false);
    const id = identity(book);
    near(id.lhs, id.rhs, 1e-9, "identity after the mark");
    // the policy holds an in-range band in our own pool
    const r = policy.policyDecide(observe(s2, p2), { limits, now: clock, pair: penv });
    assert.equal(r.decision.action, "HOLD");
    assert.equal(r.decision.headline, "In range in our own pool. Every fee is ours. Nothing to do.");
  });
  await test("the reference row goes cold: the pool marks at the last price, the EXPIRE directive fires on the fade and liquidates", async () => {
    hot = hotFileOf([]);
    clock += 2 * M;
    const s3 = await snap();
    assert.equal(s3.pair!.stale, true);
    assert.equal(s3.activeBinId, s0.activeBinId + 2, "the last price seen");
    assert.equal(s3.pair!.feesPerDayUsd, 0, "nothing accrues on a price nobody is trading");
    const p3 = paper.markPool(book, s3, { now: clock, fees: null, solPriceUsd: 100 });
    const state = emptyState("2026-09-14");
    state.entryValueSol = { [bandAddr]: book.bands[0].entryValueSol };
    state.launchBands = { [bandAddr]: { pool: KEY, openedAt: NOW, vol1hUsd: REF.vol1hUsd } };
    const laneEnv = pair.pairLaunchEnv(penv, launch.launchEnv({}));
    const cfg = { outOfRangeSec: 120, knifePct: 20, circuitFloorSol: 0.05, portfolioFloorSol: 0.15, collectMinSol: 0.005, collectFloorSol: 0.001, collectMaxPerDay: 30, skim: false, floatTargetSol: 1, treasuryAddress: "", expectedWallet: "" };
    const d = engineDirective({ now: clock, snapshot: s3, positions: p3, state, engine: emptyEngineState(), cfg, limits, collectsToday: 0, launch: { env: laneEnv, vol1hUsd: s3.pair!.stale ? 0 : s3.pair!.refVol1hUsd } });
    assert.ok(d, "a directive");
    assert.equal(d!.kind, "EXPIRE");
    assert.equal(d!.decision.liquidate, true);
    assert.match(d!.reason, /the pool's last hour traded \$0, under the \$20,000 fade floor/);
    // with the reference still there and the band past PAIR_MAX_HOLD_MIN, the hold expires it too
    const d2 = engineDirective({ now: NOW + 241 * M, snapshot: s3, positions: p3, state, engine: emptyEngineState(), cfg, limits, collectsToday: 0, launch: { env: laneEnv, vol1hUsd: 12_000_000 } });
    assert.match(d2!.reason, /past the 240 min maximum hold/);
    const r = paper.executePaper(verdictOf(d!.decision, { emergency: true }), { book, snapshot: s3, positions: p3, slippagePct: 0.3, now: clock, openCost: pv.openCostSol(s3) });
    assert.ok(r.ok, r.notes.join("; "));
    assert.deepEqual(r.txs.map((t) => t.label.split(" ")[0]), ["close", "swap"], "the band comes off and the NIKE is sold back");
    assert.equal(book.bands.length, 0);
    assert.equal(book.closed.length, 1);
    assert.equal(book.closed[0].emergency, true);
    assert.match(book.closed[0].reason, /^EXPIRE: /);
    assert.equal(book.wallet.tokens[NIKE], undefined, "no NIKE left in the wallet");
    near(book.rentLockedSol, 0, 1e-9, "the position rent came back");
    near(book.rentSpentSol, venue.PAIR_CREATION_RENT_SOL, 1e-9, "the pool's rent did not");
    const id = identity(book);
    near(id.lhs, id.rhs, 1e-9, "identity after the liquidation");
    assert.ok(book.pairPools![KEY], "the pool stays on the books: a pool cannot be deleted");
  });
  await test("the paper report: a MADE PAIRS line with age, routed share, fees earned, rent paid and P&L", () => {
    const sum = paper.paperSummary(book, [], clock);
    assert.equal(sum.pairs.length, 1);
    const line = sum.pairs[0];
    assert.equal(line.address, KEY);
    assert.equal(line.label, "NIKE/SOL");
    assert.equal(line.openBands, 0);
    assert.equal(line.closedBands, 1);
    near(line.ageHours, 12 / 60, 1e-9);
    assert.equal(line.routedShare, 0, "the last mark saw a cold reference");
    assert.equal(line.stale, true);
    assert.ok(line.feesEarnedSol > 0);
    near(line.rentSol, venue.PAIR_CREATION_RENT_SOL, 1e-12);
    assert.ok(line.swapCostSol > 0, "the buy and the sell");
    near(line.netSol, line.bandPnlSol - line.rentSol - line.swapCostSol, 1e-12);
    const text = paper.renderPaperReport(sum);
    assert.match(text, /MADE PAIRS \(1\)/);
    assert.match(text, new RegExp(`  pair-${NIKE} NIKE/SOL {7}1\\.00%/bin fee 1\\.00%  age 12 min  0 open/1 closed  routed 0\\.0% \\| 0\\.0% \\(\\$0\\.00/day\\)  REFERENCE GONE  fees 0\\.3233\\d\\d SOL`));
    // the book survives the file round-trip with its pools
    const file = path.join(tmp, "paper-book.json");
    paper.savePaperBook(book, file);
    assert.ok(!fs.existsSync(`${file}.${process.pid}.tmp`), "written temp + rename");
    const back = paper.loadPaperBook(file)!;
    assert.deepEqual(back.pairPools, book.pairPools);
    assert.deepEqual(paper.loadPaperBook(path.join(tmp, "nope.json")), null);
  });
  await test("a pair band that runs out of range: churn-wait under the minimum, then a re-centre; a cold reference closes instead", async () => {
    hot = hotFileOf([refRow()]);
    const s = await snap();
    const r0 = paper.executePaper(verdictOf(opened), { book, snapshot: s, positions: [], slippagePct: 0.3, now: clock, openCost: pv.openCostSol(s) });
    assert.ok(r0.ok, r0.notes.join("; "));
    assert.deepEqual(r0.txs.map((t) => t.label.split(" ")[0]), ["swap", "open"], "the pool exists: no second creation");
    const band = book.bands[0];
    hot = hotFileOf([refRow({ priceNative: NIKE_PRICE * 1.09 })]);
    const s9 = await snap();
    const p9 = paper.markPool(book, s9, { now: clock, fees: null, solPriceUsd: 100 });
    assert.ok(!p9[0].inRange, "9% is nine bins: outside five");
    const wait = policy.policyDecide(observe(s9, p9, 0, { [band.address]: 30 }), { limits, now: clock, pair: penv });
    assert.equal(wait.branch, "churn-wait");
    const re = policy.policyDecide(observe(s9, p9, 0, { [band.address]: 600 }), { limits, now: clock, openCostSol: pv.openCostSol(s9).total, pair: penv });
    assert.equal(re.decision.action, "REBALANCE", re.reason);
    assert.equal(re.decision.open!.side, "BOTH");
    assert.equal(re.decision.positionAddress, band.address);
    assert.match(re.decision.reasoning, /in our own NIKE\/SOL pool/);
    hot = hotFileOf([]);
    const sCold = await snap();
    const pCold = paper.markPool(book, sCold, { now: clock, fees: null, solPriceUsd: 100 });
    const close = policy.policyDecide(observe(sCold, pCold, 0, { [band.address]: 600 }), { limits, now: clock, openCostSol: pv.openCostSol(sCold).total, pair: penv });
    assert.equal(close.decision.action, "CLOSE_POSITION");
    assert.equal(close.decision.liquidate, true);
    assert.match(close.reason, /the reference row has gone cold/);
  });

  /* ================= 8. the house token ==================================================== */
  console.log("\npair lane / the house token");
  const HOUSE = Keypair.generate().publicKey.toBase58();
  const henv = env({ houseMints: [HOUSE] });
  const houseRow = (over: Partial<PairCandidate> = {}): PairCandidate => ({
    ...good(), address: "curve", baseMint: HOUSE, baseSymbol: "CLAW", name: "CLAW / SOL", venue: "pump-fun", origin: null,
    ageHours: 0.1, liquidityUsd: 900, vol24hUsd: 40, vol1hUsd: 5, sellShare1h: 0.9, priceChange1hPct: -40, flags: ["new", "dumping"], priceNative: 0.00000001, heat: 0, ...over,
  });
  await test("PAIR_HOUSE_MINTS / PAIR_HOUSE_SEAT_PCT: parsed, defaulted; a house mint clears every floor and says so; the lane off still seats nothing", () => {
    assert.deepEqual(pair.pairEnv({ PAIR_HOUSE_MINTS: " a, b ,a" }).houseMints, ["a", "b"]);
    assert.deepEqual(pair.pairEnv({}).houseMints, []);
    assert.equal(pair.pairEnv({}).houseSeatPct, 10);
    assert.equal(pair.pairEnv({ PAIR_HOUSE_SEAT_PCT: "25" }).houseSeatPct, 25);
    assert.equal(pair.pairHouseSeatSol(100, env({ houseSeatPct: 25 })), 25);
    assert.ok(pair.isHouseMint(HOUSE, henv) && !pair.isHouseMint(NIKE, henv) && !pair.isHouseMint(null, henv));
    const v = pair.pairVerdict(houseRow(), henv);
    assert.ok(v.ok, "a house mint on the bonding curve, an hour old, dumping, with $900 of liquidity: admitted");
    assert.equal(v.house, true);
    assert.equal(v.note, "house token: always seated");
    assert.equal(v.refLiquidityUsd, 900);
    const bare = pair.pairVerdict(pair.houseCandidateOf(HOUSE, henv), henv);
    assert.ok(bare.ok && bare.house && bare.refLiquidityUsd === 0 && bare.ageHours === 0, "no row at all: still admitted");
    assert.ok(!pair.pairVerdict(houseRow(), env()).ok, "the same row without the house list is refused");
    assert.match((pair.pairVerdict(houseRow(), env({ houseMints: [HOUSE], on: false })) as { reason: string }).reason, /the pair lane is off/);
  });
  await test("pairSeats: the house token is seated first, with or without a row, never counted against PAIR_MAX_POOLS; a DENY still wins", () => {
    const rows = [cand({ address: "a", baseMint: "mA", vol1hUsd: 900_000 })];
    const opts = seatOpts({ env: henv, freeSeats: 3 });
    assert.deepEqual(pair.pairSeats(rows, opts).map((s) => [s.address, !!s.house]), [["pair-" + HOUSE, true], ["pair-mA", false]], "the house seat first, then the ordinary pick");
    assert.deepEqual(pair.pairSeats(rows, seatOpts({ env: henv, freeSeats: 3, poolsTaken: 1 })).map((s) => s.address), ["pair-" + HOUSE], "PAIR_MAX_POOLS is full: the house token is seated anyway, the ordinary pick is not");
    assert.deepEqual(pair.pairSeats([...rows, houseRow()], seatOpts({ env: henv, freeSeats: 3, poolsTaken: 1 })).map((s) => s.row.address), ["curve"], "with a row for the mint, that row is the seat's reference");
    assert.deepEqual(pair.pairSeats(rows, seatOpts({ env: henv, freeSeats: 1 })).map((s) => s.address), ["pair-" + HOUSE], "the book's room still binds: one seat, the house takes it");
    assert.deepEqual(pair.pairSeats(rows, seatOpts({ env: henv, freeSeats: 3, hasPool: (a) => a === "pair-" + HOUSE })).map((s) => s.address), ["pair-mA"], "already picked: not seated twice");
    assert.deepEqual(pair.pairSeats(rows, seatOpts({ env: henv, freeSeats: 3, hasToken: (m) => m === HOUSE })).map((s) => s.address), ["pair-mA"], "one seat per token");
    const w = denyToken(emptyWatchlist(), HOUSE);
    const denied = (r: PairCandidate) => watchlistDenial({ address: r.address, baseSymbol: r.baseSymbol, baseMint: r.baseMint, name: r.name }, w);
    assert.deepEqual(pair.pairSeats(rows, seatOpts({ env: henv, freeSeats: 3, denied })).map((s) => s.address), ["pair-mA"], "a DENY on the mint wins");
    assert.deepEqual(pair.pairHouseSeats(rows, { env: henv, freeSeats: 3, quoteOk: () => true, denied }), []);
    assert.deepEqual(pair.pairHouseSeats(rows, { env: henv, freeSeats: 3, quoteOk: () => false }), [], "the wallet cannot fund the quote");
    assert.equal(pair.pairCandidatesOf([hotRowOf({ address: "curve", baseMint: HOUSE, venue: "pump-fun", origin: null })], [HOUSE]).length, 1, "a house row is a candidate whatever its venue");
    assert.equal(pair.pairCandidatesOf([hotRowOf({ address: "curve", baseMint: HOUSE, venue: "pump-fun", origin: null })]).length, 0);
  });
  await test("the venue: a house pool prices from any row (the bonding curve), then from the board, then throws; the model reads n/a without a reference; the policy opens, re-centres and never expires it", async () => {
    venue.clearPairCaches();
    const hbook = paper.emptyBook(100, 0, NOW);
    let hhot: HotFile | null = hotFileOf([hotRowOf({ address: "curve", baseMint: HOUSE, baseSymbol: "CLAW", name: "CLAW / SOL", venue: "pump-fun", origin: null, liquidityUsd: 900, vol24hUsd: 40, vol1hUsd: 5, priceNative: 0.00000002 })]);
    let hboard: { address: string; venue: string; baseMint: string; quoteSymbol: string; liquidityUsd: number | null; priceUsd?: number | null }[] = [];
    const hv = venue.createPairVenue({
      paper: () => hbook, created: () => ({}), seatSol: () => 10, solPriceUsd: () => 100, screenRows: () => hboard,
      ourBins: (address, activeBinId, binsEachSide, spec) => paper.paperBinRows(hbook, address, activeBinId, binsEachSide, { binStep: spec.binStep, xDecimals: spec.decimals, yDecimals: spec.quoteDecimals }),
      env: () => henv, hot: () => hhot, accountExists: async () => false, mintDecimals: async () => 6, now: () => clock,
    });
    const HKEY = "pair-" + HOUSE;
    const hpool = await hv.loadPool(fakeConnection, HKEY);
    assert.equal(hpool.pair.house, true);
    assert.equal(hpool.pair.symbol, "CLAW");
    const h0 = await hv.snapshot(hpool, 10, { solPriceUsd: 100 });
    assert.equal(h0.pair!.house, true);
    assert.equal(h0.pair!.refKnown, true, "the bonding-curve row is the reference");
    assert.equal(h0.pair!.refVenue, "pump-fun");
    assert.equal(h0.pair!.stale, false);
    near(h0.activePrice, 0.00000002, 0.005);
    // the policy makes the pool: no payback test for a house token, the seat is PAIR_HOUSE_SEAT_PCT
    const ho = (snap: PoolSnapshot, positions: PositionSnapshot[], oor: Record<string, number> = {}): Observation => ({
      ...observe(snap, positions, 0, oor),
      wallet: { address: "w", sol: hbook.wallet.sol, token: 0, tokenSymbol: "CLAW", quote: hbook.wallet.sol, quoteSymbol: "SOL" },
      screen: { ...observe(snap, positions).screen!, pair: { ok: true, ageHours: 0, turnover: 0 } },
    });
    const r0 = policy.policyDecide(ho(h0, []), { limits, now: clock, openCostSol: hv.openCostSol(h0).total, pair: henv, launch: launch.launchEnv({}) });
    assert.equal(r0.decision.action, "OPEN_POSITION", r0.reason);
    assert.equal(r0.decision.open!.amountSol, 5, "half of the 10% house seat on a 100 SOL book");
    assert.match(r0.decision.reasoning, /house token: CLAW is our own launch, always seated/);
    assert.match(r0.decision.reasoning, /House token: always seated, capped at 10 SOL \(10% of the 100 SOL book\); the ordinary 15% stop, no maximum hold, no volume-fade exit/);
    const made = paper.executePaper(verdictOf(r0.decision), { book: hbook, snapshot: h0, positions: [], slippagePct: 0.3, now: clock, openCost: hv.openCostSol(h0) });
    assert.ok(made.ok, made.notes.join("; "));
    assert.equal(hbook.pairPools![HKEY].house, true);
    // the row disappears: the pool prices at the last price, the model reads n/a, nothing accrues, and the policy does not close
    hhot = hotFileOf([]);
    clock += 10 * M;
    const h1 = await hv.snapshot(hpool, 10, { solPriceUsd: 100 });
    assert.equal(h1.pair!.stale, true);
    assert.equal(h1.pair!.refKnown, false);
    assert.equal(h1.pair!.feesPerDayUsd, 0);
    const hp1 = paper.markPool(hbook, h1, { now: clock, fees: null, solPriceUsd: 100 });
    assert.equal(hbook.bands[0].feeQuote, 0, "nothing accrues without a reference");
    assert.equal(hbook.pairPools![HKEY].lastRefKnown, false);
    const hold = policy.policyDecide(ho(h1, hp1), { limits, now: clock, pair: henv });
    assert.equal(hold.decision.action, "HOLD");
    assert.match(hold.decision.reasoning, /No reference row right now; a house pool stays up/);
    const ro = policy.policyDecide(ho({ ...h1, pair: { ...h1.pair!, exists: true, ours: true, creationRentSol: 0 } }, []), { limits, now: clock, openCostSol: dlmm.OPEN_COST_ESTIMATE_SOL, pair: henv, launch: launch.launchEnv({}) });
    assert.equal(ro.decision.action, "OPEN_POSITION", "no reference at all: the seat is still taken (share n/a)");
    assert.match(ro.decision.reasoning, /no reference pool for the mint yet, so the share is n\/a/);
    // no launch-style exit: without a launch context the engine has nothing to expire, whatever the age or the fade
    const state = emptyState("2026-09-14");
    state.entryValueSol = { [hbook.bands[0].address]: hbook.bands[0].entryValueSol };
    const cfg = { outOfRangeSec: 120, knifePct: 20, circuitFloorSol: 0.05, portfolioFloorSol: 0.15, collectMinSol: 0.005, collectFloorSol: 0.001, collectMaxPerDay: 30, skim: false, floatTargetSol: 1, treasuryAddress: "", expectedWallet: "" };
    assert.equal(engineDirective({ now: NOW + 999 * M, snapshot: h1, positions: hp1, state, engine: emptyEngineState(), cfg, limits, collectsToday: 0 }), null, "no EXPIRE for a house pool");
    // out of range with the reference gone: a house pool re-centres instead of closing
    const far = { ...h1, activeBinId: h1.activeBinId + 9, activePrice: h1.activePrice * 1.09, tokenPriceInQuote: h1.activePrice * 1.09, tokenPriceInSol: h1.activePrice * 1.09 };
    const hpFar = paper.markPool(hbook, far, { now: clock, fees: null, solPriceUsd: 100 });
    const re = policy.policyDecide(ho(far, hpFar, { [hbook.bands[0].address]: 700 }), { limits, now: clock, openCostSol: dlmm.OPEN_COST_ESTIMATE_SOL, pair: henv });
    assert.equal(re.decision.action, "REBALANCE", re.reason);
    // the report says HOUSE TOKEN and routed n/a
    const text = paper.renderPaperReport(paper.paperSummary(hbook, [], clock));
    assert.match(text, /HOUSE TOKEN  1\.00%\/bin fee 1\.00%.*routed n\/a \(no reference yet\)/);
    assert.doesNotMatch(text, /REFERENCE GONE/, "a house pool is never 'gone'");
    // a fresh venue with no row and nothing remembered: the board's price is the last resort, then nothing
    venue.clearPairCaches();
    hboard = [{ address: "board", venue: "meteora-dlmm", baseMint: HOUSE, quoteSymbol: "SOL", liquidityUsd: 100, priceUsd: 0.003 }];
    const hv2 = venue.createPairVenue({ paper: () => hbook, created: () => ({}), seatSol: () => 10, solPriceUsd: () => 100, screenRows: () => hboard, env: () => henv, hot: () => hhot, accountExists: async () => false, mintDecimals: async () => 6, now: () => clock });
    const hp2 = await hv2.loadPool(fakeConnection, HKEY);
    const h2 = await hv2.snapshot(hp2, 10, { solPriceUsd: 100 });
    near(h2.activePrice, 0.00003, 0.005, "the board's $0.003 at $100 per SOL");
    assert.equal(h2.pair!.refKnown, false);
    venue.clearPairCaches();
    hboard = [];
    const hv3 = venue.createPairVenue({ paper: () => hbook, created: () => ({}), seatSol: () => 10, solPriceUsd: () => 100, screenRows: () => hboard, env: () => henv, hot: () => hhot, accountExists: async () => false, mintDecimals: async () => 6, now: () => clock });
    const hp3 = await hv3.loadPool(fakeConnection, HKEY);
    await assert.rejects(() => hv3.snapshot(hp3, 10, { solPriceUsd: 100 }), /a house token still needs a price to open at/);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} pair-lane tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
