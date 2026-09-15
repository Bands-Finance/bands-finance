/**
 * The memecoin floor (src/screener/memeFloor.ts) and the market cap it reads (src/hot/sources.ts).
 * Pure: fixtures only.
 *   npx tsx src/scripts/test-meme.ts
 */
import assert from "node:assert/strict";
import { memeFloorEnv, memeFloorLine, memeRefusal } from "../screener/memeFloor";
import { parseDexScreener, parseGeckoPools } from "../hot/sources";
import { orient } from "../hot/index";

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

  console.log(`\n${passed} memecoin floor tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
