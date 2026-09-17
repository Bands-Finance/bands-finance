/**
 * The memecoin floor (src/screener/memeFloor.ts) and the market cap it reads (src/hot/sources.ts).
 * Pure: fixtures only.
 *   npx tsx src/scripts/test-meme.ts
 */
import assert from "node:assert/strict";
import { memeFloorEnv, memeFloorLine, memeRefusal } from "../screener/memeFloor";
import { parseDexScreener, parseGeckoPools } from "../hot/sources";
import { orient } from "../hot/index";
import { fetchPoolHistory, historyFresh, historyFromSignatures, historyMetrics, historyPhrase, historyRefusal, memeHistoryEnv, OHLCV_URL, parseOhlcv } from "../screener/memeHistory";

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

const SOL = "So11111111111111111111111111111111111111112";

async function main(): Promise<void> {
  console.log("memecoin floor");
  const env = memeFloorEnv({});

  await test("memeFloorEnv: $1M market cap and 24h by default; 0 turns a floor off; a ceiling only when set", () => {
    assert.deepEqual(env, { minMarketCapUsd: 1_000_000, maxMarketCapUsd: null, minAgeHours: 24 });
    assert.deepEqual(memeFloorEnv({ MEME_MIN_MARKET_CAP_USD: "0", MEME_MIN_AGE_HOURS: "0", MEME_MAX_MARKET_CAP_USD: "50000000" }), { minMarketCapUsd: 0, maxMarketCapUsd: 50_000_000, minAgeHours: 0 });
    assert.equal(memeFloorEnv({ MEME_MAX_MARKET_CAP_USD: "junk" }).maxMarketCapUsd, null);
    assert.equal(memeFloorEnv({ MEME_MIN_AGE_HOURS: "-5" }).minAgeHours, 0);
  });

  await test("today's book, replayed: GOOGL at 8.6h and CAT at 0.8h are refused as launches; DJT at $166k under the cap floor; baton at 118h and $11.7M passes (the floor is not a trend filter)", () => {
    assert.equal(memeRefusal({ symbol: "GOOGL", marketCapUsd: 20_824_115, ageHours: 8.6 }, env), "GOOGL is 8.6h old, under the 24h memecoin floor: not on launch");
    assert.equal(memeRefusal({ symbol: "CAT", marketCapUsd: 532_531, ageHours: 0.8 }, env), "CAT is 0.8h old, under the 24h memecoin floor: not on launch", "age is checked first");
    assert.equal(memeRefusal({ symbol: "DJT", marketCapUsd: 165_581, ageHours: 121.6 }, env), "DJT is at $165,581 market cap, under the $1.0M memecoin floor");
    assert.equal(memeRefusal({ symbol: "baton", marketCapUsd: 11_744_325, ageHours: 118.5 }, env), null);
    assert.equal(memeRefusal({ symbol: "ZCAT", marketCapUsd: 121_273_935, ageHours: 214.4 }, env), null);
  });

  await test("what cannot be checked is refused while its floor is on; stocks and the house token are never judged; a ceiling when set", () => {
    assert.match(memeRefusal({ symbol: "X", marketCapUsd: 5_000_000, ageHours: null }, env)!, /^X: age unknown/);
    assert.match(memeRefusal({ symbol: "X", marketCapUsd: null, ageHours: 100 }, env)!, /^X: market cap unknown/);
    assert.equal(memeRefusal({ symbol: "X", marketCapUsd: null, ageHours: null }, { minMarketCapUsd: 0, maxMarketCapUsd: null, minAgeHours: 0 }), null, "both floors off: nothing to check");
    assert.equal(memeRefusal({ symbol: "NVDAx", marketCapUsd: null, ageHours: null, stock: { ticker: "NVDA", issuer: "xstocks" } }, env), null);
    assert.equal(memeRefusal({ symbol: "BANDS", marketCapUsd: 20_000, ageHours: 0.1, house: true }, env), null);
    const capped = { ...env, maxMarketCapUsd: 50_000_000 };
    assert.equal(memeRefusal({ symbol: "STONK", marketCapUsd: 160_460_060, ageHours: 820 }, capped), "STONK is at $160M market cap, over the $50M memecoin ceiling");
    assert.equal(memeRefusal({ symbol: "baton", marketCapUsd: 11_744_325, ageHours: 118 }, capped), null);
  });

  await test("memeFloorLine: the rule and what it kept out, at most four named", () => {
    assert.equal(memeFloorLine([], env), null);
    const line = memeFloorLine(["a", "b", "c", "d", "e", "f"], env)!;
    assert.equal(line, "memecoin floor (>= 24h old, >= $1.0M market cap) kept out 6: a; b; c; d; and 2 more");
  });

  console.log("market cap on the fast watch's rows");
  await test("GeckoTerminal: market_cap_usd, else fdv_usd; DexScreener: marketCap, else fdv; a sample oriented to the other token loses it", () => {
    const gecko = (attrs: Record<string, unknown>) => ({
      data: [{ attributes: { address: "pool1", name: "GOOGL / SOL", base_token_price_usd: "0.02", quote_token_price_usd: "100", reserve_in_usd: "270000", volume_usd: {}, transactions: {}, price_change_percentage: {}, pool_created_at: "2026-09-15T06:00:00Z", ...attrs }, relationships: { base_token: { data: { id: "solana_GOOGLmint" } }, quote_token: { data: { id: `solana_${SOL}` } }, dex: { data: { id: "pumpswap" } } } }],
    });
    assert.equal(parseGeckoPools(gecko({ market_cap_usd: "20824115", fdv_usd: "21000000" }), "trending")[0].marketCapUsd, 20_824_115);
    assert.equal(parseGeckoPools(gecko({ market_cap_usd: null, fdv_usd: "21000000" }), "trending")[0].marketCapUsd, 21_000_000, "fdv when the market cap is unreported");
    assert.equal(parseGeckoPools(gecko({}), "trending")[0].marketCapUsd, null);
    const dex = (p: Record<string, unknown>) => ({ pairs: [{ chainId: "solana", dexId: "meteora", labels: ["DLMM"], pairAddress: "pool2", baseToken: { address: "BATONmint", symbol: "baton" }, quoteToken: { address: SOL, symbol: "SOL" }, priceUsd: "0.0117", liquidity: { usd: 500000 }, volume: {}, txns: {}, priceChange: {}, ...p }] });
    assert.equal(parseDexScreener(dex({ marketCap: 11_744_325, fdv: 11_800_000 }))[0].marketCapUsd, 11_744_325);
    assert.equal(parseDexScreener(dex({ fdv: 11_800_000 }))[0].marketCapUsd, 11_800_000);
    const sample = parseDexScreener(dex({ marketCap: 11_744_325 }))[0];
    assert.equal(orient(sample, "BATONmint").marketCapUsd, 11_744_325, "our token is the base: kept");
    const flipped = { ...sample, baseMint: SOL, quoteMint: "BATONmint" };
    assert.equal(orient(flipped, "BATONmint").marketCapUsd, null, "the source sized SOL, not our token");
  });

  console.log("a month of training data");
  const DAY = 86_400;
  const T0 = 1_789_000_000;
  /** GeckoTerminal's shape: [ts, open, high, low, close, volume], newest first */
  const ohlcv = (days: number, f: (i: number) => [number, number, number, number, number]) => ({
    data: { attributes: { ohlcv_list: Array.from({ length: days }, (_, i) => [T0 + i * DAY, ...f(i)]).reverse() } },
  });
  await test("memeHistoryEnv: 30 days by default, 0 turns the rule off, a 24h cache, a few pools a cycle", () => {
    assert.deepEqual(memeHistoryEnv({}), { minTxPerDay: 50, maxPages: 12, minDays: 30, ttlHours: 24, lookupsPerCycle: 4 });
    assert.equal(memeHistoryEnv({ MEME_MIN_HISTORY_DAYS: "0" }).minDays, 0);
    assert.equal(memeHistoryEnv({ MEME_HISTORY_TTL_HOURS: "0" }).ttlHours, 1, "never an unbounded refetch loop");
  });
  await test("parseOhlcv and historyMetrics: oldest first, only days that traded count, the window's change, the worst drawdown from a peak, the median day", () => {
    // up 1% a day for 20 days, then down 3% a day for 10, and 5 dead days with no volume
    const series = ohlcv(35, (i) => {
      if (i < 5) return [1, 1, 1, 1, 0];
      const k = i - 5;
      const close = k < 20 ? 1.01 ** (k + 1) : 1.01 ** 20 * 0.97 ** (k - 19);
      const open = k < 20 ? 1.01 ** k : 1.01 ** 20 * 0.97 ** (k - 20);
      return [open, Math.max(open, close) * 1.02, Math.min(open, close) * 0.98, close, 50_000];
    });
    const candles = parseOhlcv(series);
    assert.equal(candles.length, 35);
    assert.ok(candles[0].ts < candles[34].ts, "oldest first");
    const m = historyMetrics(candles);
    assert.equal(m.days, 30, "the five days with no volume do not count");
    assert.ok(Math.abs(m.changePct! - ((1.01 ** 20) * (0.97 ** 10) - 1) * 100) < 0.05, `window change ${m.changePct}`);
    assert.ok(Math.abs(m.maxDrawdownPct! - ((0.97 ** 10) - 1) * 100) < 0.05, `drawdown ${m.maxDrawdownPct}`);
    assert.ok(m.medianDailyRangePct! > 4 && m.medianDailyRangePct! < 6, `median day ${m.medianDailyRangePct}`);
    assert.equal(m.avgDailyVolumeUsd, 50_000);
    assert.match(historyPhrase(m), /^30d of history: -\d/);
    assert.deepEqual(parseOhlcv({}), []);
    assert.equal(historyMetrics([]).days, 0);
  });
  await test("historyRefusal is strict: not read yet, unreadable, or under 30 days refuses; 30 days passes; off passes", () => {
    const env30 = memeHistoryEnv({});
    const now = T0 * 1000;
    const rec = (days: number) => ({ at: now, metrics: historyMetrics(parseOhlcv(ohlcv(days, () => [1, 1.1, 0.9, 1, 10_000]))), error: null });
    assert.equal(historyRefusal("ZCAT", undefined, env30, now), "ZCAT: its trading history has not been read yet, and the desk wants 30 days of it first");
    assert.equal(historyRefusal("ZCAT", rec(10), env30, now), "ZCAT has 10 days of trading history, under the 30 days the desk wants before entering a memecoin");
    assert.equal(historyRefusal("baton", rec(6), env30, now), "baton has 6 days of trading history, under the 30 days the desk wants before entering a memecoin");
    assert.match(historyRefusal("X", { at: now, metrics: null, error: "GeckoTerminal HTTP 429" }, env30, now)!, /could not be read \(GeckoTerminal HTTP 429\)/);
    assert.equal(historyRefusal("STONK", rec(30), env30, now), null);
    assert.equal(historyRefusal("X", undefined, memeHistoryEnv({ MEME_MIN_HISTORY_DAYS: "0" }), now), null);
    assert.equal(historyFresh(rec(30), env30, now + 23 * 3600e3), true);
    assert.equal(historyFresh(rec(30), env30, now + 25 * 3600e3), false);
    const failed = { at: now, metrics: null, error: "GeckoTerminal HTTP 429" };
    assert.equal(historyFresh(failed, env30, now + 10 * 60e3), true, "a failed read waits 15 minutes");
    assert.equal(historyFresh(failed, env30, now + 16 * 60e3), false, "then it is read again, not blocked for a day");
  });
  await test("historyFromSignatures and the Helius read: consecutive traded UTC days back from yesterday, the first-seen time when the read reached the start; pages until the window or the history ends; a failure is a record", async () => {
    const now = Date.parse("2026-09-17T13:00:00Z");
    const day = 86_400_000;
    const at = (daysAgo: number, hour: number) => Math.floor((now - daysAgo * day - (13 - hour) * 3_600_000) / 1000);
    const sigs = [
      ...Array.from({ length: 60 }, (_, i) => ({ blockTime: at(0, 9) + i, err: null })), // today: not a full day, never counted
      ...Array.from({ length: 80 }, (_, i) => ({ blockTime: at(1, 15) + i, err: null })), // yesterday 80
      ...Array.from({ length: 20 }, (_, i) => ({ blockTime: at(1, 16) + i, err: { x: 1 } })), // failed tries do not count
      ...Array.from({ length: 55 }, (_, i) => ({ blockTime: at(2, 12) + i, err: null })), // two days ago 55
      ...Array.from({ length: 10 }, (_, i) => ({ blockTime: at(3, 12) + i, err: null })), // three days ago 10: quiet
      ...Array.from({ length: 90 }, (_, i) => ({ blockTime: at(4, 12) + i, err: null })), // four days ago 90, after a quiet day
    ];
    const m = historyFromSignatures(sigs, now, 3, 50, false);
    assert.deepEqual(m.txPerDay, [80, 55, 10]);
    assert.equal(m.days, 2, "yesterday and the day before traded; the quiet day stops the run");
    assert.equal(m.firstSeenAt, null, "the read did not reach the start");
    const reached = historyFromSignatures(sigs, now, 3, 50, true);
    assert.equal(reached.firstSeenAt, at(4, 12) * 1000);
    assert.match(historyPhrase(m), /^2d of on-chain history \(80 \/ 55 \/ 10 tx a day, yesterday first\)$/);
    assert.equal(historyFromSignatures(sigs, now, 3, 10, false).days, 3);
    assert.equal(historyFromSignatures([], now, 3, 50, true).days, 0);
    // a capped read on a busy pool: a thousand signatures in four minutes, 900 of them good
    const busy = Array.from({ length: 1000 }, (_, i) => ({ blockTime: Math.floor(now / 1000) - Math.floor(i * 0.24), err: i % 10 === 0 ? { x: 1 } : null }));
    const bm = historyFromSignatures(busy, now, 3, 50, false);
    assert.deepEqual([bm.days, bm.txPerDay], [0, [0, 0, 0]], "nothing of yesterday was reached");
    assert.ok(bm.coveredHours! >= 0.06 && bm.coveredHours! <= 0.07, `covered ${bm.coveredHours}h`);
    assert.ok(bm.ratePerDay! > 300_000, `pace ${bm.ratePerDay} a day`);
    assert.match(historyPhrase(bm), /^0d of on-chain history read \(the read covered 4 min at [\d,]+ tx a day\)$/);
    const envH = memeHistoryEnv({ MEME_MIN_HISTORY_DAYS: "3" });
    assert.equal(historyRefusal("ALLINU", { at: now, metrics: bm, error: null }, envH, now, 5.7 * 24), null, "busy and 5.7 days old: admitted on its pace");
    assert.match(historyRefusal("PAID", { at: now, metrics: bm, error: null }, envH, now, 39)!, /PAID is 1\.6 days old, under the 3 days/);
    assert.match(historyRefusal("X", { at: now, metrics: bm, error: null }, envH, now, null)!, /X is of unknown age/);
    const quiet = historyFromSignatures(busy.slice(0, 20).map((s) => ({ ...s, blockTime: s.blockTime - 3600 * 2 })), now, 3, 50, false);
    assert.match(historyRefusal("Q", { at: now, metrics: { ...quiet, ratePerDay: 20 }, error: null }, envH, now, 200)!, /Q trades at 20 tx a day on chain, under the 50/);
    // the read: pages of 1,000 newest first until a signature is older than the window, or the history ends
    const pages: number[] = [];
    const mk = (n: number, fromSec: number) => Array.from({ length: n }, (_, i) => ({ signature: `s${fromSec}-${i}`, blockTime: fromSec - i * 30, err: null }));
    const connection = {
      async getSignaturesForAddress(_a: unknown, opts: { limit: number; before?: string }) {
        pages.push(opts.limit);
        if (!opts.before) return mk(1000, Math.floor(now / 1000)); // 1000 x 30s = 8.3h of the newest
        if (pages.length === 2) return mk(1000, Math.floor(now / 1000) - 30_000);
        return mk(1000, Math.floor((now - 5 * day) / 1000)); // older than the window: stops here
      },
    };
    const rec = await fetchPoolHistory("POOL1", 3, { connection, now, minTxPerDay: 50, maxPages: 40 });
    assert.equal(rec.error, null);
    assert.equal(pages.length, 3);
    assert.ok(rec.metrics!.txPerDay!.length === 3);
    const short = { async getSignaturesForAddress() { return mk(12, Math.floor(now / 1000)); } };
    const young = await fetchPoolHistory("POOL2", 3, { connection: short, now, minTxPerDay: 50 });
    assert.equal(young.metrics!.days, 0);
    assert.ok(young.metrics!.firstSeenAt !== null, "twelve signatures in all: the history ended, so the pool's age is known");
    const broken = { async getSignaturesForAddress(): Promise<never> { throw new Error("429 Too Many Requests"); } };
    const failed = await fetchPoolHistory("POOL3", 3, { connection: broken, now });
    assert.equal(failed.metrics, null);
    assert.match(failed.error!, /^helius: 429/);
  });

  await test("fetchPoolHistory (legacy candles, tests only): one GeckoTerminal OHLCV call for the pool, a month plus a day; a failure is a record, never a throw", async () => {
    const urls: string[] = [];
    const ok = await fetchPoolHistory("POOL1", 30, { fetch: async (u) => { urls.push(String(u)); return new Response(JSON.stringify(ohlcv(31, () => [1, 1.1, 0.9, 1, 10_000])), { status: 200 }); }, now: 5 });
    assert.equal(urls[0], OHLCV_URL("POOL1", 30));
    assert.match(urls[0], /\/pools\/POOL1\/ohlcv\/day\?aggregate=1&limit=31&currency=usd&token=base$/);
    assert.equal(ok.metrics!.days, 31);
    assert.equal(ok.at, 5);
    const limited = await fetchPoolHistory("POOL1", 30, { fetch: async () => new Response("slow down", { status: 429 }) });
    assert.equal(limited.metrics, null);
    assert.equal(limited.error, "GeckoTerminal HTTP 429");
    const broken = await fetchPoolHistory("POOL1", 30, { fetch: async () => { throw new Error("socket hang up"); } });
    assert.equal(broken.error, "socket hang up");
  });

  console.log(`\n${passed} memecoin floor tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
