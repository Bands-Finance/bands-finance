/**
 * The memecoin floor (src/screener/memeFloor.ts) and the market cap it reads (src/hot/sources.ts).
 * Pure: fixtures only.
 *   npx tsx src/scripts/test-meme.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { memeFloorEnv, memeFloorLine, memeRefusal, memeVerdict, sustainedSeatNote } from "../screener/memeFloor";
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

  await test("memeFloorEnv: $1M market cap and 24h by default; 0 turns a floor off; a ceiling only when set; the sustained-heat hours come from the hot env (0 in shadow mode) and its own age floor from MEME_SUSTAINED_MIN_AGE_HOURS", () => {
    assert.deepEqual(env, { minMarketCapUsd: 1_000_000, maxMarketCapUsd: null, minAgeHours: 24, stocksOnly: false, sustainedMinHours: 12, sustainedMinAgeHours: 24 });
    assert.deepEqual(memeFloorEnv({ MEME_MIN_MARKET_CAP_USD: "0", MEME_MIN_AGE_HOURS: "0", MEME_MAX_MARKET_CAP_USD: "50000000" }), { minMarketCapUsd: 0, maxMarketCapUsd: 50_000_000, minAgeHours: 0, stocksOnly: false, sustainedMinHours: 12, sustainedMinAgeHours: 24 });
    assert.equal(memeFloorEnv({ MEME_MAX_MARKET_CAP_USD: "junk" }).maxMarketCapUsd, null);
    assert.equal(memeFloorEnv({ MEME_MIN_AGE_HOURS: "-5" }).minAgeHours, 0);
    assert.equal(memeFloorEnv({ HOT_SUSTAINED_HOURS: "0" }).sustainedMinHours, 0, "HOT_SUSTAINED_HOURS=0 turns the exemption off");
    assert.equal(memeFloorEnv({ HOT_SUSTAINED_HOURS: "8" }).sustainedMinHours, 8);
    assert.equal(memeFloorEnv({ HOT_SUSTAINED_MODE: "shadow" }).sustainedMinHours, 0, "shadow mode: the hot watch counts and logs, the floor admits nothing");
    assert.equal(memeFloorEnv({ HOT_SUSTAINED_MODE: "on" }).sustainedMinHours, 12);
    assert.equal(memeFloorEnv({ MEME_SUSTAINED_MIN_AGE_HOURS: "48" }).sustainedMinAgeHours, 48);
    assert.equal(memeFloorEnv({ MEME_SUSTAINED_MIN_AGE_HOURS: "-1" }).sustainedMinAgeHours, 0);
    assert.equal(memeFloorEnv({ MEME_SUSTAINED_MIN_AGE_HOURS: "junk" }).sustainedMinAgeHours, 24);
  });

  await test("today's book, replayed: GOOGL at 8.6h and CAT at 0.8h are refused as launches; DJT at $166k under the cap floor; baton at 118h and $11.7M passes (the floor is not a trend filter)", () => {
    assert.equal(memeRefusal({ symbol: "GOOGL", marketCapUsd: 20_824_115, ageHours: 8.6 }, env), "GOOGL is 8.6h old, under the 24h memecoin floor: not on launch");
    assert.equal(memeRefusal({ symbol: "CAT", marketCapUsd: 532_531, ageHours: 0.8 }, env), "CAT is 0.8h old, under the 24h memecoin floor: not on launch", "age is checked first");
    assert.equal(memeRefusal({ symbol: "DJT", marketCapUsd: 165_581, ageHours: 121.6 }, env), "DJT is at $165,581 market cap, under the $1.0M memecoin floor");
    assert.equal(memeRefusal({ symbol: "baton", marketCapUsd: 11_744_325, ageHours: 118.5 }, env), null);
    assert.equal(memeRefusal({ symbol: "ZCAT", marketCapUsd: 121_273_935, ageHours: 214.4 }, env), null);
    // a market cap far under what the pool itself holds of the token is not a reading (wXMR, 18 Sep): a day of volume at
    // least the floor stands in, on a token that is not collapsing, never for a ceiling
    assert.equal(memeRefusal({ symbol: "wXMR", marketCapUsd: 623, ageHours: 231, tokenSideUsd: 13_000, volume24hUsd: 1_046_717, priceChange24hPct: 2.3 }, env), null, "$623 under $13K of wXMR in the pool cannot be right; $1.05M of volume stands in");
    assert.match(memeRefusal({ symbol: "wXMR", marketCapUsd: 623, ageHours: 231, tokenSideUsd: 13_000, volume24hUsd: 380_980, priceChange24hPct: 2.3 }, env)!, /\$380,980 of daily volume is too little to stand in for the \$1\.0M floor/);
    assert.match(memeRefusal({ symbol: "RUG", marketCapUsd: 40_000, ageHours: 100, tokenSideUsd: 300_000, volume24hUsd: 1_500_000, priceChange24hPct: -99.8 }, env)!, /a token down 100% on the day cannot stand in/, "a collapse day is a high-volume day: no stand-in");
    assert.equal(memeRefusal({ symbol: "DJT", marketCapUsd: 165_581, ageHours: 121.6, tokenSideUsd: 30_000, volume24hUsd: 5_000_000, priceChange24hPct: 5 }, env), "DJT is at $165,581 market cap, under the $1.0M memecoin floor", "a cap above the pool's token side is a reading, and volume does not stand in for it");
    assert.equal(memeRefusal({ symbol: "wXMR", marketCapUsd: 623, ageHours: 231, tokenSideUsd: 2_500, volume24hUsd: 1_046_717, priceChange24hPct: 2.3 }, env), null, "a quote-heavy pool holds little wXMR, and $623 is still under it");
    assert.equal(memeRefusal({ symbol: "wXMR", marketCapUsd: 623, ageHours: 231, volume24hUsd: 1_046_717 }, env), "wXMR is at $623 market cap, under the $1.0M memecoin floor", "no split of the pool known: no stand-in");
    assert.match(memeRefusal({ symbol: "wXMR", marketCapUsd: 623, ageHours: 231, tokenSideUsd: 13_000, volume24hUsd: 1_046_717 }, { ...env, maxMarketCapUsd: 50_000_000 })!, /a ceiling cannot be judged without it/);
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

  console.log("sustained heat: the one exemption");
  const env720 = { ...env, minAgeHours: 720 };
  const cracker = { symbol: "CRACKER", marketCapUsd: 3_200_000, ageHours: 98.2 };
  await test("a pool refused on AGE is admitted on sustained heat, with the admission named; not one hour short; never when the exemption is off", () => {
    assert.equal(memeRefusal(cracker, env720), "CRACKER is 98.2h old, under the 720h memecoin floor: not on launch", "the floor on its own, and CRACKER/SOL on 24 Sep");
    assert.equal(memeRefusal({ ...cracker, sustainedHours: 12 }, env720), null, "twelve hot hours on the tape stand in");
    assert.deepEqual(memeVerdict({ ...cracker, sustainedHours: 14 }, env720), { refusal: null, sustained: "CRACKER admitted on sustained heat, 14 hot hours on the tape, though 98.2h old, under the 720h floor" });
    assert.equal(memeRefusal({ ...cracker, sustainedHours: 11 }, env720), "CRACKER is 98.2h old, under the 720h memecoin floor: not on launch", "eleven is not twelve");
    assert.equal(memeRefusal({ ...cracker, sustainedHours: null }, env720)?.startsWith("CRACKER is 98.2h old"), true);
    assert.equal(memeRefusal({ ...cracker, sustainedHours: 20 }, { ...env720, sustainedMinHours: 0 })?.startsWith("CRACKER is 98.2h old"), true, "HOT_SUSTAINED_HOURS=0: off");
    assert.equal(memeRefusal({ ...cracker, sustainedHours: 20 }, { minMarketCapUsd: 1_000_000, maxMarketCapUsd: null, minAgeHours: 720 })?.startsWith("CRACKER is 98.2h old"), true, "an env without the knob: off");
    assert.deepEqual(memeVerdict({ symbol: "ZCAT", marketCapUsd: 121_273_935, ageHours: 800, sustainedHours: 20 }, env720), { refusal: null, sustained: null }, "a token the floor admits on its own is not an admission on sustained heat: full seat");
  });
  await test("a pool refused on MARKET CAP is admitted likewise (xHYPE's $51,858), an unknown cap too but never an unknown age; a ceiling and STOCKS_ONLY never, and a ceiling is judged on the way in", () => {
    const xhype = { symbol: "xHYPE", marketCapUsd: 51_858, ageHours: 900 };
    assert.equal(memeRefusal(xhype, env720), "xHYPE is at $51,858 market cap, under the $1.0M memecoin floor");
    assert.deepEqual(memeVerdict({ ...xhype, sustainedHours: 20 }, env720), { refusal: null, sustained: "xHYPE admitted on sustained heat, 20 hot hours on the tape, though $51,858 market cap, under the $1.0M floor" });
    assert.equal(memeVerdict({ symbol: "X", marketCapUsd: 5_000_000, ageHours: null, sustainedHours: 13 }, env720).refusal, "X: age unknown, and the desk does not pick a memecoin it cannot date; 13h of sustained heat would stand in, but never for a pool the desk cannot date");
    assert.match(memeVerdict({ symbol: "X", marketCapUsd: null, ageHours: 900, sustainedHours: 13 }, env720).sustained!, /though market cap unknown$/, "twelve hours of fees are more evidence than a supply figure");
    assert.match(memeVerdict({ symbol: "wXMR", marketCapUsd: 623, ageHours: 900, tokenSideUsd: 13_000, volume24hUsd: 380_980, priceChange24hPct: 2.3, sustainedHours: 13 }, env720).sustained!, /^wXMR admitted on sustained heat, 13 hot hours on the tape, though market cap reads \$623/, "an unreadable cap the volume could not stand in for");
    const capped = { ...env720, maxMarketCapUsd: 50_000_000 };
    assert.equal(memeRefusal({ symbol: "STONK", marketCapUsd: 160_460_060, ageHours: 820, sustainedHours: 20 }, capped), "STONK is at $160M market cap, over the $50M memecoin ceiling", "too big is a different question");
    assert.match(memeRefusal({ symbol: "wXMR", marketCapUsd: 623, ageHours: 900, tokenSideUsd: 13_000, volume24hUsd: 1_046_717, sustainedHours: 20 }, capped)!, /a ceiling cannot be judged without it/);
    // a pool refused on its age has not had its cap read yet: the ceiling is still judged before the exemption seats it
    assert.equal(memeRefusal({ symbol: "STONK", marketCapUsd: 160_460_060, ageHours: 100, sustainedHours: 20 }, capped), "STONK is 100.0h old, under the 720h memecoin floor: not on launch; 20h of sustained heat would stand in, but $160M market cap, over the $50M ceiling");
    assert.equal(memeRefusal({ symbol: "X", marketCapUsd: null, ageHours: 100, sustainedHours: 20 }, capped), "X is 100.0h old, under the 720h memecoin floor: not on launch; 20h of sustained heat would stand in, but a ceiling cannot be judged without a market cap");
    assert.equal(memeRefusal({ symbol: "Y", marketCapUsd: 2_000_000, ageHours: 100, sustainedHours: 20 }, capped), null, "under the ceiling: admitted");
    assert.equal(memeRefusal({ ...cracker, sustainedHours: 20 }, { ...env720, stocksOnly: true }), "CRACKER is not a tokenized stock, and the book is stocks only (STOCKS_ONLY)");
  });
  await test("the exemption's own age floor: a KNOWN age of at least MEME_SUSTAINED_MIN_AGE_HOURS, whichever line refused; the tape starts when the watch first sees a pool", () => {
    assert.equal(memeRefusal({ ...cracker, ageHours: 20, sustainedHours: 14 }, env720), "CRACKER is 20.0h old, under the 720h memecoin floor: not on launch; 14h of sustained heat would stand in, but not at 20.0h old: a sustained-heat seat needs 24h");
    assert.equal(memeRefusal({ ...cracker, ageHours: 24, sustainedHours: 14 }, env720), null, "24h is the line");
    assert.equal(memeRefusal({ ...cracker, ageHours: 20, sustainedHours: 14 }, { ...env720, sustainedMinAgeHours: 12 }), null, "the knob moves it");
    assert.equal(memeRefusal({ ...cracker, ageHours: 20, sustainedHours: 14 }, { ...env720, sustainedMinAgeHours: 0 }), null, "0 = any known age");
    assert.match(memeRefusal({ ...cracker, ageHours: null, sustainedHours: 14 }, { ...env720, sustainedMinAgeHours: 0 })!, /never for a pool the desk cannot date$/, "but never an unknown one");
    assert.equal(memeRefusal({ ...cracker, ageHours: 20, sustainedHours: 14 }, { minMarketCapUsd: 1_000_000, maxMarketCapUsd: null, minAgeHours: 720, sustainedMinHours: 12 }), null, "an env without the knob has no extra line");
    assert.match(memeRefusal({ ...cracker, ageHours: null, sustainedHours: 14 }, { minMarketCapUsd: 1_000_000, maxMarketCapUsd: null, minAgeHours: 720, sustainedMinHours: 12 })!, /never for a pool the desk cannot date$/, "and still wants the age known");
    // the cap line under a 0 age floor: an unknown or young age is caught by the exemption's floor, not the floor's
    assert.equal(memeRefusal({ symbol: "xHYPE", marketCapUsd: 51_858, ageHours: null, sustainedHours: 20 }, { ...env, minAgeHours: 0 }), "xHYPE is at $51,858 market cap, under the $1.0M memecoin floor; 20h of sustained heat would stand in, but never for a pool the desk cannot date");
    assert.equal(memeRefusal({ symbol: "xHYPE", marketCapUsd: 51_858, ageHours: 10, sustainedHours: 20 }, { ...env, minAgeHours: 0 }), "xHYPE is at $51,858 market cap, under the $1.0M memecoin floor; 20h of sustained heat would stand in, but not at 10.0h old: a sustained-heat seat needs 24h");
    // at the defaults (both 24h) the age line is never set aside: a pool under the floor is under the exemption's floor too
    assert.equal(memeRefusal({ symbol: "GOOGL", marketCapUsd: 20_824_115, ageHours: 8.6, sustainedHours: 14 }, env), "GOOGL is 8.6h old, under the 24h memecoin floor: not on launch; 14h of sustained heat would stand in, but not at 8.6h old: a sustained-heat seat needs 24h");
  });
  await test("the hot lane's row carries its day: a row at -60% with 14 hot hours is refused as a collapse, and every site that builds a candidate from a hot row passes the field", () => {
    // the hot row as pickPools builds the candidate from it (the hot lane; hotMeme for the launch and pair lanes)
    const row = { address: "H", baseSymbol: "DUMP", marketCapUsd: 2_400_000, ageHours: 40, stock: null, priceChange24hPct: -60, sustained: true, sustainedHours: 14 };
    const c = { symbol: row.baseSymbol, marketCapUsd: row.marketCapUsd, ageHours: row.ageHours, stock: row.stock, priceChange24hPct: row.priceChange24hPct, sustainedHours: row.sustained ? row.sustainedHours : null };
    assert.equal(memeRefusal(c, env720), "DUMP is 40.0h old, under the 720h memecoin floor: not on launch; 14h of sustained heat would stand in, but a token down 60% on the day is in collapse");
    assert.equal(memeRefusal({ ...c, priceChange24hPct: undefined }, env720), null, "without the field the collapse guard cannot fire, which is why the sites below must pass it");
    const src = fs.readFileSync(path.join(process.cwd(), "src/index.ts"), "utf8");
    assert.match(src, /marketCapUsd: r\.marketCapUsd, ageHours: r\.ageHours, stock: r\.stock, priceChange24hPct: r\.priceChange24hPct, sustainedHours: sustainedHoursOf\(r\.address\)/, "the hot lane");
    assert.match(src, /stock: r\?\.stock \?\? null, priceChange24hPct: r\?\.priceChange24hPct \?\? null, sustainedHours: sustainedHoursOf\(address\)/, "hotMeme, which the launch and pair lanes read");
    assert.match(src, /marketCapUsd: r\.marketCapUsd, ageHours: r\.ageHours, priceChange24hPct: r\.priceChange24hPct, sustainedHours: sustainedHoursOf\(r\.address\)/, "the history refresh's hot-row loop");
    assert.match(src, /\$\{v\.sustained\} and the \$\{hist\.minDays\}-day history rule/, "the admission note names the history rule it set aside");
  });
  await test("sustainedSeatNote: an admission is its own note and nothing else is; the desk remembers admissions with its risk state, never guessing one after a restart", () => {
    const admitted = memeVerdict({ ...cracker, sustainedHours: 14 }, env720);
    assert.equal(sustainedSeatNote(admitted), admitted.sustained);
    const cooled = memeVerdict({ ...cracker, sustainedHours: null }, env720);
    assert.equal(sustainedSeatNote(cooled), null, "a refusal today says nothing about how a held pool was let in (ENA/USDC, 24 Sep)");
    assert.equal(sustainedSeatNote(memeVerdict({ symbol: "ZCAT", marketCapUsd: 121_273_935, ageHours: 800 }, env720)), null, "the floor admits it on its own: a full seat");
    assert.equal(sustainedSeatNote(memeVerdict({ symbol: "TSLAx", marketCapUsd: null, ageHours: null, stock: { ticker: "TSLA" } }, env720)), null, "a stock is never judged");
    // and the desk keeps its admissions on disk: read back at start, written with every save, none guessed
    const src = fs.readFileSync(path.join(process.cwd(), "src/index.ts"), "utf8");
    assert.match(src, /sustainedSeats: new Map\(Object\.entries\(loadState\(\)\.sustainedSeats \?\? \{\}\)\)/, "read back at start");
    assert.equal((src.match(/saveState\(withSeats\(state\)\)/g) ?? []).length, 3, "every save carries them");
    assert.doesNotMatch(src, /restart forgot/, "no guess after a restart");
    const st = fs.readFileSync(path.join(process.cwd(), "src/risk/state.ts"), "utf8");
    assert.match(st, /sustainedSeats: parsed\.sustainedSeats \?\? \{\}/, "loaded with the state");
  });

  await test("a token in collapse is never admitted on its heat: a collapse day is a high-fee day", () => {
    assert.equal(memeRefusal({ ...cracker, priceChange24hPct: -50, sustainedHours: 20 }, env720), "CRACKER is 98.2h old, under the 720h memecoin floor: not on launch; 20h of sustained heat would stand in, but a token down 50% on the day is in collapse");
    assert.equal(memeRefusal({ ...cracker, priceChange24hPct: -49.9, sustainedHours: 20 }, env720), null);
    assert.match(memeRefusal({ symbol: "RUG", marketCapUsd: 40_000, ageHours: 900, tokenSideUsd: 300_000, volume24hUsd: 1_500_000, priceChange24hPct: -99.8, sustainedHours: 20 }, env720)!, /is in collapse$/);
  });
  await test("memeFloorLine names what was admitted on sustained heat beside what was kept out, each note cut to what the header does not already say", () => {
    const note = memeVerdict({ ...cracker, sustainedHours: 14 }, env720).sustained!;
    assert.equal(note, "CRACKER admitted on sustained heat, 14 hot hours on the tape, though 98.2h old, under the 720h floor");
    assert.equal(memeFloorLine(["a"], env720, [note]), "memecoin floor (>= 720h old, >= $1.0M market cap) kept out 1: a; admitted on sustained heat (>= 12 hot hours on the tape): CRACKER, 14 hot hours, though 98.2h old, under the 720h floor");
    assert.equal(memeFloorLine([], env720, [`${note} and the 30-day history rule`, "xHYPE admitted on sustained heat, 20 hot hours on the tape, though $51,858 market cap, under the $1.0M floor"]), "memecoin floor (>= 720h old, >= $1.0M market cap) kept out nothing; admitted on sustained heat (>= 12 hot hours on the tape): CRACKER, 14 hot hours, though 98.2h old, under the 720h floor and the 30-day history rule; xHYPE, 20 hot hours, though $51,858 market cap, under the $1.0M floor");
    assert.equal(memeFloorLine([], env720, ["a note in another shape"]), "memecoin floor (>= 720h old, >= $1.0M market cap) kept out nothing; admitted on sustained heat (>= 12 hot hours on the tape): a note in another shape");
    assert.equal(memeFloorLine([], env720, []), null);
    assert.equal(memeFloorLine(["a"], env720, []), "memecoin floor (>= 720h old, >= $1.0M market cap) kept out 1: a", "unchanged when nothing was admitted");
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

  await test("STOCKS_ONLY: every token that is not a tokenized stock is refused, a stock passes, and only the literal true turns it on", () => {
    const only = memeFloorEnv({ STOCKS_ONLY: "true" } as NodeJS.ProcessEnv);
    assert.equal(only.stocksOnly, true);
    assert.equal(memeFloorEnv({ STOCKS_ONLY: "yes" } as NodeJS.ProcessEnv).stocksOnly, false, "a typo keeps the wider book, never a surprise");
    assert.equal(memeFloorEnv({} as NodeJS.ProcessEnv).stocksOnly, false);
    // a memecoin that clears every floor is still refused
    assert.equal(memeRefusal({ symbol: "ZCAT", marketCapUsd: 121_273_935, ageHours: 214.4 }, only), "ZCAT is not a tokenized stock, and the book is stocks only (STOCKS_ONLY)");
    // a tokenized stock passes, whatever its age or cap reads
    assert.equal(memeRefusal({ symbol: "SKHY", marketCapUsd: null, ageHours: 2, stock: "backpack" } as Parameters<typeof memeRefusal>[0], only), null);
    assert.equal(memeRefusal({ symbol: "NVDAx", marketCapUsd: 5_000, ageHours: 1, stock: "xstocks" } as Parameters<typeof memeRefusal>[0], only), null);
  });

  console.log(`\n${passed} memecoin floor tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
