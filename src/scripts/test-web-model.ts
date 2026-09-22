/**
 * The site's money math (web/src/derive.ts, web/src/model.ts), on fixtures. The one rule under test:
 * every figure is read per CYCLE (the whole book at one moment), never from the last entry of each
 * pool ever worked. The bug of 2026-09-16: a pool closed a day earlier still listed its band in its
 * last entry, so "the book" carried a 50 SOL band that no longer existed and "started with" was one
 * pool's entry instead of the first cycle's, printing +228 SOL on a desk that was down 40.
 *   npx tsx src/scripts/test-web-model.ts
 */
import assert from "node:assert/strict";
import { actionsOf, bookOf, deskBlocks, flowOf, flowTotalsOf, realEntries, realPoints, recordOf, statusOf, verdictOf } from "../../web/src/model";
import { bookCycle, completeCycles, cycleEquity, cyclesOf, equitySeriesOf, summarize } from "../../web/src/derive";
import type { EquityHistoryPoint, JournalEntry, Position } from "../../web/src/types";
import { dayWord, narrativeOf, noBookNarrative, num, sinceWord } from "../../web/src/narrative";
import { trimEntries } from "../publish/live";
import { liveRunOf, runDays, type LiveRunFile } from "../../web/src/liveRun";
import { readFileSync } from "node:fs";
import path from "node:path";

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

const T0 = Date.parse("2026-09-16T00:00:00Z");
const RENT = 0.0574;

function band(address: string, valueInSol: number, o: Partial<Position> = {}): Position {
  return {
    address,
    lowerBinId: 90,
    upperBinId: 110,
    lowerPrice: 0.9,
    upperPrice: 1.1,
    widthBins: 21,
    inRange: true,
    binsFromRange: 0,
    amountX: 0,
    amountY: valueInSol,
    feeX: 0,
    feeY: 0,
    valueInSol,
    solInPosition: valueInSol,
    quoteInPosition: valueInSol,
    lastUpdatedAt: 0,
    entryValueSol: valueInSol,
    ...o,
  } as Position;
}

interface EntryOpts {
  cycle: number;
  /** minutes after T0 */
  min: number;
  pool: string;
  sol: number;
  usdc?: number;
  positions?: Position[];
  action?: JournalEntry["decision"]["action"];
  closed?: string;
  executed?: boolean;
}

function entry(o: EntryOpts): JournalEntry {
  const usdcQuoted = o.usdc !== undefined;
  const action = o.action ?? "HOLD";
  const executed = o.executed ?? action !== "HOLD";
  const decision = { action, open: null, positionAddress: o.positions?.[0]?.address ?? null, reasoning: "r", confidence: 0.7, headline: "h" };
  return {
    id: `${o.cycle}-${o.pool}-${o.min}`,
    ts: new Date(T0 + o.min * 60_000).toISOString(),
    cycle: o.cycle,
    mode: "paper",
    agent: { id: "mr-bands", name: "Mr Bands" },
    pool: {
      address: o.pool,
      label: `${o.pool}/${usdcQuoted ? "USDC" : "SOL"}`,
      tokenX: { symbol: o.pool, decimals: 6 },
      tokenY: { symbol: usdcQuoted ? "USDC" : "SOL", decimals: usdcQuoted ? 6 : 9 },
      solSide: usdcQuoted ? null : "Y",
      binStep: 20,
      activeBinId: 100,
      price: usdcQuoted ? 100 : 1,
      priceLabel: "quote per token",
      tokenPriceInSol: 1,
      baseFeePct: 0.2,
      dynamicFeePct: 0.2,
      bins: [],
      quoteSymbol: usdcQuoted ? "USDC" : "SOL",
      quoteSide: "Y",
      quotePriceInSol: usdcQuoted ? 0.01 : 1,
      tokenPriceInQuote: usdcQuoted ? 100 : 1,
      venue: "meteora-dlmm",
    },
    wallet: { address: "wallet1", sol: o.sol, token: 0, tokenSymbol: o.pool, ...(usdcQuoted ? { quote: o.usdc, quoteSymbol: "USDC" } : { quote: o.sol, quoteSymbol: "SOL" }) } as JournalEntry["wallet"],
    positions: o.positions ?? [],
    analytics: null,
    llm: { source: "policy", model: "desk-policy" },
    proposal: decision,
    decision,
    allowed: true,
    violations: [],
    overrides: [],
    passed: [],
    emergency: false,
    execution: { mode: "paper", ok: true, txs: executed ? [{ label: "x", ok: true, skipped: "paper" }] : [], notes: [], ledger: [], ...(o.closed ? { closed: o.closed } : {}) } as unknown as JournalEntry["execution"],
    headline: "h",
  } as unknown as JournalEntry;
}

/**
 * Three pools, four cycles. AAA holds a 20 SOL band throughout; BBB (USDC-quoted) holds a 50 SOL band
 * and CLOSES it in cycle 2 (its last entry, the close, still lists the band); CCC opens a 10 SOL band
 * in cycle 3. The wallet: 5 SOL and 1,000 USDC (10 SOL at 0.01) until BBB's close returns 50 SOL of
 * USDC in cycle 3. Cycle 1 is cut in the window: only its last entry (BBB) is present.
 */
function fixture(): JournalEntry[] {
  const a = (cycle: number, min: number) => entry({ cycle, min, pool: "AAA", sol: 5, positions: [band("a1", 20)] });
  const chrono: JournalEntry[] = [
    // cycle 1, partial: AAA's entry fell off the window
    entry({ cycle: 1, min: 1, pool: "BBB", sol: 5, usdc: 1000, positions: [band("b1", 50)] }),
    // cycle 2: BBB closes its band (the entry still lists it, pre-close)
    a(2, 10),
    entry({ cycle: 2, min: 11, pool: "BBB", sol: 5, usdc: 1000, positions: [band("b1", 50)], action: "CLOSE_POSITION", closed: "b1" }),
    // cycle 3: BBB is gone; the wallet holds its 50 SOL as USDC; CCC opens
    a(3, 20),
    entry({ cycle: 3, min: 21, pool: "CCC", sol: 5, usdc: 6000, positions: [], action: "OPEN_POSITION" }),
    // cycle 4: CCC's band is on the book
    a(4, 30),
    entry({ cycle: 4, min: 31, pool: "CCC", sol: 5, usdc: 5000, positions: [band("c1", 10)] }),
  ];
  return [...chrono].reverse();
}

async function main() {
  console.log("cycles");
  await test("cyclesOf groups the journal by cycle, oldest first; completeCycles drops a cut oldest cycle and never the newest", () => {
    const cycles = cyclesOf(fixture());
    assert.deepEqual(cycles.map((c) => [c.cycle, c.entries.length]), [[1, 1], [2, 2], [3, 2], [4, 2]]);
    const complete = completeCycles(cycles);
    assert.deepEqual(complete.map((c) => c.cycle), [2, 3, 4], "cycle 1 has fewer entries than cycle 2: cut by the window");
    assert.deepEqual(completeCycles(cycles.slice(1)).map((c) => c.cycle), [2, 3, 4], "a full oldest cycle stays");
    assert.deepEqual(completeCycles([cycles[3]]).map((c) => c.cycle), [4], "one cycle is kept");
  });

  await test("cyclesOf: a restarted desk's cycle 1 is not merged with the last run's cycle 1; a pool written twice, or a three-minute gap, starts a new cycle", () => {
    const chrono = [...fixture()].reverse();
    // the desk restarts: cycle 1 again, an hour later, AAA and CCC
    const restarted = [...chrono, entry({ cycle: 1, min: 90, pool: "AAA", sol: 5, positions: [band("a1", 20)] }), entry({ cycle: 1, min: 91, pool: "CCC", sol: 5, usdc: 5000, positions: [band("c1", 10)] })].reverse();
    const cycles = cyclesOf(restarted);
    assert.deepEqual(cycles.map((c) => [c.cycle, c.entries.length]), [[1, 1], [2, 2], [3, 2], [4, 2], [1, 2]]);
    assert.deepEqual(bookOf(restarted).bands.map((b) => b.address).sort(), ["a1", "c1"], "the new run's cycle 1 is the book, alone");
    // the same cycle number, same pool, 10 minutes apart: two cycles
    const gap = [entry({ cycle: 7, min: 0, pool: "AAA", sol: 5, positions: [band("a1", 20)] }), entry({ cycle: 7, min: 10, pool: "AAA", sol: 5, positions: [band("a1", 20)] })].reverse();
    assert.equal(cyclesOf(gap).length, 2);
    assert.ok(Math.abs(recordOf(gap)!.equityNow - (5 + 20 + RENT)) < 1e-9, "one band, not two");
  });

  await test("cycleEquity: wallet SOL + the USDC leg at the SOL price + every band with its rent, once", () => {
    const cycles = cyclesOf(fixture());
    // cycle 2: 5 SOL + 1,000 USDC (10 SOL) + AAA 20 + BBB 50 + 2 x rent
    assert.ok(Math.abs(cycleEquity(cycles[1]) - (5 + 10 + 20 + 50 + 2 * RENT)) < 1e-9, `cycle 2 ${cycleEquity(cycles[1])}`);
    // cycle 4: 5 SOL + 5,000 USDC (50 SOL) + AAA 20 + CCC 10 + 2 x rent; BBB's closed band is gone
    assert.ok(Math.abs(cycleEquity(cycles[3]) - (5 + 50 + 20 + 10 + 2 * RENT)) < 1e-9, `cycle 4 ${cycleEquity(cycles[3])}`);
    const series = equitySeriesOf(fixture());
    assert.equal(series.length, 3, "the cut cycle is not a point");
    assert.ok(Math.abs(series[0].equity - cycleEquity(cycles[1])) < 1e-9);
  });

  console.log("the book and the record");
  await test("bookOf: the bands of the newest cycle only; a pool whose band closed a cycle ago is not on the book", () => {
    const book = bookOf(fixture());
    assert.deepEqual(book.bands.map((b) => b.address).sort(), ["a1", "c1"]);
    assert.ok(book.bands.every((b) => b.address !== "b1"), "BBB's closed band must not linger from its last entry");
  });

  await test("bookOf: a band's fees earned are what is still inside it plus every claim made from it; a claim does not reset them, and the market move ignores claimed fees", () => {
    const chrono = [...fixture()].reverse();
    // cycle 5: a1 holds 0.05 SOL unclaimed and the desk claims it; cycle 6: a1 has 0.02 SOL of new fees inside
    const claim = entry({ cycle: 5, min: 40, pool: "AAA", sol: 5, positions: [band("a1", 20, { feeY: 0.05 })], action: "CLAIM_FEES" });
    const after = entry({ cycle: 6, min: 50, pool: "AAA", sol: 5.05, positions: [band("a1", 19.97, { feeY: 0.02, entryValueSol: 20 })] });
    const a1 = bookOf([...chrono, claim, after].reverse()).bands.find((b) => b.address === "a1")!;
    assert.ok(Math.abs(a1.feesClaimed - 0.05) < 1e-9, "the claim counts");
    assert.ok(Math.abs(a1.fees - 0.07) < 1e-9, "claimed plus unclaimed");
    assert.ok(Math.abs(a1.marketMove! - (19.97 - 0.02 - 20)) < 1e-9, "value less the fees still inside, less what went in");
  });

  await test("bookCycle: a pool the desk did not write this cycle keeps its band for one cycle unless its last entry closed it", () => {
    const chrono = [...fixture()].reverse();
    // cycle 5 writes CCC only: AAA's read failed. AAA's cycle-4 entry still holds a1 and did not close: carried.
    const skipped = [...chrono, entry({ cycle: 5, min: 40, pool: "CCC", sol: 5, usdc: 5000, positions: [band("c1", 10)] })].reverse();
    assert.deepEqual(bookCycle(skipped)!.entries.map((e) => e.pool.address).sort(), ["AAA", "CCC"]);
    assert.deepEqual(bookOf(skipped).bands.map((b) => b.address).sort(), ["a1", "c1"]);
    assert.ok(Math.abs(recordOf(skipped)!.equityNow - (5 + 50 + 20 + 10 + 2 * RENT)) < 1e-9, "the carried band counts in the book's equity");
    // two cycles without AAA: the carry is one cycle only
    const twice = [...[...skipped].reverse(), entry({ cycle: 6, min: 50, pool: "CCC", sol: 5, usdc: 5000, positions: [band("c1", 10)] })].reverse();
    assert.deepEqual(bookCycle(twice)!.entries.map((e) => e.pool.address), ["CCC"]);
    // BBB closed in cycle 2 and is absent from cycle 3: never carried
    assert.deepEqual(bookCycle(chrono.slice(0, 5).reverse())!.entries.map((e) => e.pool.address).sort(), ["AAA", "CCC"]);
  });

  await test("summarize: bands open / in range count the newest cycle's bands", () => {
    const s = summarize("mr-bands", "Mr Bands", fixture());
    assert.equal(s.bandsOpen, 2);
    assert.equal(s.bandsInRange, 2);
  });

  await test("recordOf without history: started with the first complete cycle, the book is the newest cycle, net is their difference", () => {
    const r = recordOf(fixture())!;
    const cycles = cyclesOf(fixture());
    assert.equal(r.sinceStart, false);
    assert.equal(r.hedge, null);
    assert.equal(r.startTs, cycles[1].t, "cycle 2, the first complete one");
    assert.ok(Math.abs(r.startEquity - cycleEquity(cycles[1])) < 1e-9);
    assert.ok(Math.abs(r.equityNow - cycleEquity(cycles[3])) < 1e-9);
    assert.ok(Math.abs(r.net - (cycleEquity(cycles[3]) - cycleEquity(cycles[1]))) < 1e-9);
    assert.ok(Math.abs(r.atWork - 30) < 1e-9, "AAA 20 + CCC 10 at work; not BBB's 50");
    assert.ok(Math.abs(r.rent - 2 * RENT) < 1e-9);
    assert.equal(r.quote?.symbol, "USDC");
    assert.ok(Math.abs(r.quote!.inSol - 50) < 1e-9, "5,000 USDC at 0.01 SOL");
    assert.equal(r.counts.pools, 3, "three pools were worked in the window");
    assert.equal(r.days.length, 1);
    assert.ok(Math.abs(r.days[0].open - r.startEquity) < 1e-9);
    assert.ok(Math.abs(r.days[0].close - r.equityNow) < 1e-9);
  });

  await test("recordOf with history: start, now, net, hedge and the daily rows come from the desk's own points, mode-matched; fees since the start from the claimed tally", () => {
    const pt = (o: Partial<EquityHistoryPoint>): EquityHistoryPoint => ({
      t: T0,
      cycle: 1,
      agent: "mr-bands",
      mode: "paper",
      equitySol: 100,
      walletSol: 5,
      quoteSol: 10,
      quoteUsdc: 1000,
      bandsSol: 85,
      tokensSol: 0,
      hedgeSol: 0,
      bands: 2,
      pools: 2,
      feesClaimedSol: 0,
      solPriceUsd: 100,
      ...o,
    });
    const day1 = T0 - 36 * 3600e3; // two days before
    const history = [
      pt({ t: day1, cycle: 1, equitySol: 250, feesClaimedSol: 0 }),
      pt({ t: day1 + 3600e3, cycle: 2, equitySol: 240, feesClaimedSol: 1 }),
      pt({ t: T0 - 12 * 3600e3, cycle: 40, equitySol: 230, feesClaimedSol: 3 }),
      pt({ t: T0 + 31 * 60_000, cycle: 4, equitySol: 84.9, hedgeSol: -0.8, feesClaimedSol: 4.5 }),
      // a live point must not leak into a paper record
      pt({ t: T0 + 32 * 60_000, cycle: 4, mode: "live", equitySol: 1 }),
    ];
    const r = recordOf(fixture(), history)!;
    assert.equal(r.sinceStart, true);
    assert.equal(r.startTs, day1);
    assert.equal(r.startEquity, 250);
    assert.equal(r.equityNow, 84.9);
    assert.ok(Math.abs(r.net - (84.9 - 250)) < 1e-9);
    assert.equal(r.hedge, -0.8);
    assert.equal(r.feesRealized, 4.5, "claimed since the first point");
    assert.deepEqual(r.days.map((d) => d.date), [new Date(day1).toISOString().slice(0, 10), "2026-09-15", "2026-09-16"].filter((v, i, a) => a.indexOf(v) === i));
    const d0 = r.days[0];
    assert.equal(d0.open, 250);
    assert.equal(d0.close, 240);
    assert.equal(d0.fees, 1);
    // a fee claim is counted as a claim, not as a band move (18 Sep: 49 claims read as "57 moves" on the site)
    const withClaim = recordOf([entry({ cycle: 9, min: 200, pool: "AAA", sol: 5, positions: [band("a1", 20, { feeY: 0.05 })], action: "CLAIM_FEES" }), ...fixture()], history)!;
    const lastDay = withClaim.days[withClaim.days.length - 1];
    assert.equal(lastDay.claims, 1, "the claim is a claim");
    assert.equal(lastDay.moves, r.days[r.days.length - 1].moves, "and not a move");
    const last = r.days[r.days.length - 1];
    assert.equal(last.close, 84.9);
    assert.ok(Math.abs(last.fees - 1.5) < 1e-9, "4.5 claimed by the end of the day, 3 by the end of the day before");
    assert.ok(Math.abs(r.atWork - 30) < 1e-9, "the book split is still the newest cycle's");
    // stale history (its last point long before the newest cycle) is not trusted for "now"
    const stale = recordOf(fixture(), history.slice(0, 3))!;
    assert.equal(stale.sinceStart, false);
  });

  console.log("actions");
  await test("actionsOf: executed moves only, newest first, with the numbers from the decision and the band; holds and vetoes are not actions", () => {
    const chrono = [...fixture()].reverse();
    const claim = entry({ cycle: 5, min: 40, pool: "AAA", sol: 5, positions: [band("a1", 20, { feeY: 0.05 })], action: "CLAIM_FEES" });
    const vetoed = { ...entry({ cycle: 5, min: 41, pool: "CCC", sol: 5, usdc: 5000, positions: [band("c1", 10)], action: "CLOSE_POSITION" }), allowed: false, execution: { mode: "paper", ok: true, txs: [], notes: [] } } as unknown as JournalEntry;
    const opened = entry({ cycle: 6, min: 50, pool: "CCC", sol: 5, usdc: 5000, positions: [], action: "OPEN_POSITION" });
    (opened.decision as { open: unknown }).open = { side: "BOTH", amountSol: 500, amountToken: 5, binsBelowActive: 10, binsAboveActive: 10, strategy: "Spot" };
    const forced = { ...entry({ cycle: 7, min: 60, pool: "AAA", sol: 5, positions: [band("a1", 18, { entryValueSol: 20 })], action: "CLOSE_POSITION", closed: "a1" }), emergency: true } as JournalEntry;
    const rows = actionsOf([...chrono, claim, vetoed, opened, forced].reverse());
    assert.deepEqual(rows.map((r) => [r.action, r.poolLabel]), [
      ["CLOSE_POSITION", "AAA/SOL"],
      ["OPEN_POSITION", "CCC/USDC"],
      ["CLAIM_FEES", "AAA/SOL"],
      ["OPEN_POSITION", "CCC/USDC"],
      ["CLOSE_POSITION", "BBB/USDC"],
    ], "newest first; the vetoed close and every hold are absent");
    assert.equal(rows[0].forced, true);
    assert.equal(rows[0].what, "18 SOL back, −2 SOL vs entry");
    assert.equal(rows[0].sentence, "The guards closed his band in AAA/SOL: 18 SOL back, −2 SOL vs entry.");
    assert.equal(rows[1].sentence, "Opened a band in CCC/USDC with 500 USDC + 5 CCC across 21 bins, both sides of the price.");
    assert.equal(rows[2].sentence, "Claimed 0.05 SOL of fees from AAA/SOL.");
    assert.equal(rows[4].sentence, "Closed the band in BBB/USDC: 50 SOL back, +0 SOL vs entry.");
    assert.equal(rows[0].resultSol, -2);
    assert.equal(rows[1].what, "500 USDC + 5 CCC across 21 bins, both sides of the price");
    assert.equal(rows[2].what, "0.05 SOL of fees to the wallet");
    assert.equal(rows[2].resultSol, 0.05);
    assert.equal(rows[4].what, "50 SOL back, +0 SOL vs entry");
    assert.equal(rows[0].href, null, "no signature in paper");
    assert.equal(actionsOf(fixture(), 1).length, 1);
  });

  console.log("the note");
  await test("num, dayWord, sinceWord: numbers and days the way a person says them", () => {
    assert.deepEqual([num(35.01), num(246.9), num(6.42), num(0.4321), num(-12.04), num(10.0)], ["35", "247", "6.4", "0.43", "12", "10"]);
    const now = Date.parse("2026-09-17T03:00:00Z"); // a Thursday, UTC
    assert.equal(dayWord("2026-09-17", now), "today");
    assert.equal(dayWord("2026-09-16", now), "yesterday");
    assert.equal(dayWord("2026-09-15", now), "Tuesday");
    assert.equal(dayWord("2026-09-14", now), "Monday");
    assert.equal(dayWord("2026-09-11", now), "Friday");
    assert.equal(dayWord("2026-09-10", now), "Sep 10");
    assert.equal(sinceWord(Date.parse("2026-09-14T22:42:00Z"), now), "since Monday");
    assert.equal(sinceWord(now - 3600e3, now), "today");
  });

  await test("flowOf and flowTotalsOf: the newest cycle's journaled flow per pool, added up in SOL across quotes", () => {
    const chrono = [...fixture()].reverse();
    const flow = (over: Partial<import("../../web/src/types").FlowContext>) => ({ asOf: T0 + 31 * 60_000, quoteSymbol: "SOL", swaps15m: 2, volume15mQuote: 4, fees15mQuote: 0.01, ours15mQuote: 0.01, swaps60m: 10, volume60mQuote: 20, fees60mQuote: 0.05, ours60mQuote: 0.04, feesPerDayQuote60m: 1.2, feesPerDayQuote15m: 0.96, lastPrice: 1, lastSwapAt: T0, largest15m: null, ...over });
    const a = chrono[chrono.length - 2]; // cycle 4, AAA (SOL-quoted)
    const c = chrono[chrono.length - 1]; // cycle 4, CCC (USDC-quoted, 0.01 SOL per USDC)
    (a as { screen?: unknown }).screen = { rank: 1, rankedPools: 1, score: 1, feeToTvl24hPct: null, flow: flow({}) };
    (c as { screen?: unknown }).screen = { rank: 1, rankedPools: 1, score: 1, feeToTvl24hPct: null, flow: flow({ quoteSymbol: "USDC", volume60mQuote: 5000, fees60mQuote: 12, ours60mQuote: 6, swaps60m: 30, asOf: T0 + 32 * 60_000 }) };
    const flows = flowOf([...chrono].reverse());
    assert.deepEqual([...flows.keys()].sort(), ["AAA", "CCC"]);
    assert.equal(flows.get("CCC")!.quotePriceInSol, 0.01);
    const t = flowTotalsOf(flows)!;
    assert.equal(t.pools, 2);
    assert.equal(t.swaps60m, 40);
    assert.ok(Math.abs(t.volume60mSol - (20 + 50)) < 1e-9, "5,000 USDC is 50 SOL");
    assert.ok(Math.abs(t.fees60mSol - (0.05 + 0.12)) < 1e-9);
    assert.ok(Math.abs(t.ours60mSol - (0.04 + 0.06)) < 1e-9);
    assert.equal(t.asOf, T0 + 32 * 60_000);
    assert.equal(flowTotalsOf(new Map()), null);
    assert.equal(flowOf(fixture()).size, 0, "no journaled flow: nothing");

    // the live feed trims bins and flow off every entry but a pool's newest: the book and the flow totals read the same
    const full = [...chrono].reverse() as (JournalEntry & { screen?: unknown })[];
    const trimmed = trimEntries(full) as typeof full;
    assert.equal(trimmed.length, full.length);
    assert.deepEqual([...flowOf(trimmed).keys()].sort(), ["AAA", "CCC"], "the newest entries keep their flow");
    assert.deepEqual(flowTotalsOf(flowOf(trimmed)), t, "the totals are unchanged");
    assert.deepEqual(bookOf(trimmed).bands.map((b) => b.address), bookOf(full).bands.map((b) => b.address), "the book is unchanged");
    const older = trimmed.filter((e, i) => trimmed.findIndex((x) => x.pool.address === e.pool.address) !== i);
    assert.ok(older.length > 0 && older.every((e) => !("bins" in e.pool) && !(e.screen && typeof e.screen === "object" && "flow" in (e.screen as object))), "older entries carry neither bins nor flow");
    assert.ok(trimmed.filter((e, i) => trimmed.findIndex((x) => x.pool.address === e.pool.address) === i).every((e) => "bins" in e.pool), "each pool's newest entry keeps its bins");
    assert.notEqual(full[full.length - 1], trimmed[trimmed.length - 1], "the input is not mutated: a trimmed entry is a copy");
    assert.ok("bins" in full[full.length - 1].pool, "the original still has its bins");
  });

  await test("narrativeOf: a headline and a short honest story from the record; the worst day named, today reported, the mode said plainly", () => {
    const now = Date.parse("2026-09-17T03:00:00Z");
    const status = { mode: "dry-run", lastTs: now, ageMs: 0, sentence: "s", short: "dry run" } as const;
    const rec = {
      startTs: Date.parse("2026-09-14T22:42:00Z"),
      startEquity: 246.9,
      equityNow: 211.9,
      net: -35.0,
      netPct: -14.2,
      feesRealized: 21.85,
      feesUnclaimed: 0.82,
      days: [
        { date: "2026-09-14", fees: 1.24, open: 246.9, close: 244.88, moves: 0, vetoed: 0, overrides: 0, holds: 0, decisions: 0 },
        { date: "2026-09-15", fees: 17.22, open: 245.14, close: 214.76, moves: 0, vetoed: 0, overrides: 0, holds: 0, decisions: 0 },
        { date: "2026-09-16", fees: 1.31, open: 214.77, close: 211.6, moves: 10, vetoed: 0, overrides: 6, holds: 374, decisions: 400 },
        { date: "2026-09-17", fees: 2.07, open: 211.65, close: 211.9, moves: 35, vetoed: 0, overrides: 3, holds: 172, decisions: 200 },
      ],
    } as unknown as Parameters<typeof narrativeOf>[0]["record"];
    const n = narrativeOf({ record: rec, status: status as never, agentName: "Mr Bands", now });
    assert.equal(n.headline, "Mr Bands is down 35 SOL since Monday.");
    assert.deepEqual(n.story, [
      "He has earned 22.7 SOL in fees over 2 days.",
      "Tuesday cost 30.4 SOL: 17.2 earned in fees, 47.6 lost to the price.",
      "Today he banked 2.1 SOL of fees and the book is up 0.25.",
      "This is a rehearsal: real pools, a wallet that sends nothing.",
    ]);
    const flat = narrativeOf({ record: { ...(rec as object), net: 0.01 } as never, status: status as never, agentName: "Mr Bands", now });
    assert.equal(flat.headline, "Mr Bands is about flat since Monday.");
    // live, an hour in: what is at work, fees still in the bands, and the last hour's flow
    const liveRec = { ...(rec as object), startTs: now - 3600e3, startEquity: 19.79, equityNow: 19.6, net: -0.19, feesRealized: 0, feesUnclaimed: 0.0031, atWork: 14.94, days: [] } as never;
    const live = narrativeOf({ record: liveRec, status: { ...status, mode: "live" } as never, agentName: "Mr Bands", now, bandsOpen: 3, atWorkSol: 14.94, flow: { pools: 3, swaps60m: 91, volume60mSol: 84.2, fees60mSol: 0.152, ours60mSol: 0.152, swaps15m: 19, fees15mSol: 0.021, asOf: now } });
    assert.equal(live.headline, "Mr Bands is down 0.19 SOL today.");
    assert.deepEqual(live.story, [
      "He has 14.9 SOL at work in 3 bands.",
      "He has earned 0.0031 SOL in fees since he started, still in the bands.",
      "In the last hour his 3 pools paid 0.15 SOL in fees to their market makers.",
      "This is his own wallet on Solana.",
    ]);
    assert.deepEqual([num(0.0031), num(0.15), num(0.0001)], ["0.0031", "0.15", "0.0001"]);
    const none = narrativeOf({ record: null, status: { ...status, mode: "live" } as never, agentName: "Mr Bands", now });
    assert.equal(none.headline, "Reading the journal.");
    assert.deepEqual(none.story, [], "while the journal loads the story says nothing about the money");
    // no book open (the snapshot's empty journal): the headline says so and the story points at the real-money run
    const idle = { mode: "none", lastTs: null, ageMs: null, sentence: "No book open right now.", short: "no book open" } as const;
    const empty = narrativeOf({ record: null, status: idle, agentName: "Mr Bands", now, runDays: "17 to 19 Sep" });
    assert.deepEqual(empty, { headline: "No book open right now.", story: ["His real-money run, 17 to 19 Sep, is below."] });
    assert.deepEqual(noBookNarrative(null).story, ["He has no money at work right now."]);
    assert.equal(narrativeOf({ record: null, status: idle, agentName: "Mr Bands", now, loading: true }).headline, "Reading the journal.");
  });

  await test("no book open: an empty journal, or one of practice entries only, is status none and never 'paper'; the feed drops practice rows", () => {
    const now = T0 + 3600e3;
    const s = statusOf([], now, false);
    assert.equal(s.mode, "none");
    assert.equal(s.short, "no book open");
    assert.equal(s.sentence, "No book open right now.");
    const practice = [entry({ cycle: 1, min: 1, pool: "AAA", sol: 5 })];
    assert.equal(statusOf(practice, now, false).mode, "none", "a practice journal is not his book");
    assert.deepEqual(realEntries(practice), []);
    const real = { ...practice[0], mode: "live", execution: { ...practice[0].execution, mode: "live" } } as JournalEntry;
    assert.deepEqual(realEntries([...practice, real]), [real]);
    assert.equal(statusOf([real], now, false).mode, "live");
    assert.equal(statusOf(practice, now, true).mode, "demo", "a demo keeps its entries");
    const pts = [{ t: 1, mode: "paper" }, { t: 2, mode: "live" }] as unknown as EquityHistoryPoint[];
    assert.deepEqual(realPoints(pts).map((p) => p.t), [2]);
    for (const st of [s, statusOf(practice, now, false)]) assert.ok(!/paper/i.test(`${st.short} ${st.sentence}`), "no status word says paper");
    assert.equal(runDays(Date.parse("2026-09-17T10:00:00Z"), Date.parse("2026-09-19T01:44:00Z")), "17 to 19 Sep");
    assert.equal(runDays(Date.parse("2026-09-30T10:00:00Z"), Date.parse("2026-10-02T01:44:00Z")), "30 Sep to 2 Oct");
  });

  await test("liveRunOf on the shipped live-run.json: the one headline number (docs/sprint.md), not the last mark, and every executed move", () => {
    const file = JSON.parse(readFileSync(new URL("../../web/public/live-run.json", import.meta.url), "utf8")) as LiveRunFile;
    const run = liveRunOf(file)!;
    assert.ok(run.settled, "the file carries the ledger's all-cash end");
    assert.equal(run.startEquity.toFixed(2), "19.79");
    assert.equal(run.endEquity.toFixed(2), "19.71");
    assert.equal(run.change.toFixed(2), "-0.08");
    assert.equal(run.lastMarkEquity.toFixed(2), "19.68");
    assert.equal(run.feesClaimed.toFixed(2), "7.91");
    assert.equal(run.feesInTokens?.toFixed(2), "3.27");
    assert.equal(run.claims, 111);
    assert.equal(run.moves, 205);
    assert.equal(run.transactions, 293);
    assert.equal(run.failed, 4);
    assert.equal(run.peakEquity.toFixed(2), "23.50");
    assert.equal(run.lowEquity.toFixed(2), "19.29");
    // the GP/SOL claim of 18 Sep 00:58Z landed and its sweep leg did not: a claim on the ledger, not a failed move
    const gp = file.entries.find((e) => e.id === "2026-09-18T00:58:36.503Z-12-64JeeF")!;
    assert.equal(verdictOf(gp), "placed");
    assert.equal(verdictOf({ ...gp, execution: { ...gp.execution, ok: false } }), "failed", "a move the desk reports not ok is failed, signed legs or not");
    // without the settled block the page falls back to the last mark, and says so
    const { settled: _s, ...marks } = file;
    const m = liveRunOf(marks as LiveRunFile)!;
    assert.equal(m.settled, false);
    assert.equal(m.endEquity.toFixed(2), "19.68");
    assert.equal(m.feesInTokens, null);
  });

  await test("a screened hold says the model was not asked", () => {
    const e = entry({ cycle: 9, min: 1, pool: "AAA", sol: 5, positions: [band("a1", 20)] });
    const screened = { ...e, llm: { source: "screen", model: "desk-policy" } } as unknown as JournalEntry;
    const noted = { ...e, llm: { source: "screen", model: "desk-policy", note: "Screened (in-range). The model was not asked." } } as unknown as JournalEntry;
    assert.equal(deskBlocks([screened])[0]!.fallbackNote, "screened by the desk policy: the model was not asked");
    assert.equal(deskBlocks([noted])[0]!.fallbackNote, "Screened (in-range). The model was not asked.");
  });

  await test("no other token's mint and no Meridian mention on the site or in the platform chat (Zach, 22 Sep)", () => {
    const { COPYCAT_MINTS } = require("../risk/house") as typeof import("../risk/house");
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const root = path.resolve(__dirname, "../..");
    const files: string[] = [path.join(root, "src/platform/myAgent.ts"), path.join(root, "web/index.html")];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const f = path.join(dir, name);
        if (statSync(f).isDirectory()) walk(f);
        else if (/\.(tsx?|jsx?|html|json|md|txt|css)$/.test(name)) files.push(f);
      }
    };
    for (const d of ["web/src", "web/public", "web/scripts"]) walk(path.join(root, d));
    for (const f of files) {
      let text = "";
      try { text = readFileSync(f, "utf8"); } catch { continue; }
      // Zach, 22 Sep: the site never mentions Meridian (CSS class names are not shown to visitors)
      if (!/\.css$/.test(f)) assert.ok(!/meridian402|sister desk|["'`>]\s*Meridian\b/.test(text), `${path.relative(root, f)} mentions Meridian`);
      for (const m of COPYCAT_MINTS) {
        assert.ok(!text.includes(m), `${path.relative(root, f)} names another token's mint`);
        assert.ok(!text.replace(/<wbr\s*\/>/g, "").includes(m), `${path.relative(root, f)} names another token's mint (split by <wbr>)`);
      }
    }
  });

  await test("the prompts the models actually receive carry no other token's mint, nor a piece of it", async () => {
    const { COPYCAT_MINTS } = await import("../risk/house");
    const { buildSystemPrompt } = await import("../agent/persona");
    const { personaFor } = await import("../platform/myAgent");
    const { riskLimits } = await import("../config");
    const prompts = {
      desk: buildSystemPrompt(riskLimits, "ORE/SOL"),
      chat: personaFor("So11111111111111111111111111111111111111112", {} as never),
    };
    for (const [name, p] of Object.entries(prompts)) {
      for (const m of COPYCAT_MINTS) {
        assert.ok(!p.includes(m), `${name} prompt names another token's mint`);
        assert.ok(!p.includes(m.slice(0, 5)) && !p.includes(m.slice(-5)), `${name} prompt carries a piece of another token's mint`);
      }
      assert.ok(!/copycat/i.test(p), `${name} prompt still talks about the copycat`);
    }
  });

  await test("the chat's stream, its stored reply and the journal the sites read drop another token's mint, even split across chunks", async () => {
    const { COPYCAT_MINTS, copycatStreamFilter, redactCopycat, redactCopycatDeep } = await import("../risk/house");
    const { sanitizeChunk, sanitizeReply } = await import("../platform/myAgent");
    const m = COPYCAT_MINTS[0]!;
    const reply = `that one is not mine: ${m}. nor ${m.slice(0, 6)}... or ...${m.slice(-4)}. i will name mine when it launches.`;
    const f = copycatStreamFilter();
    let streamed = "";
    for (let i = 0; i < reply.length; i += 7) streamed += f.push(reply.slice(i, i + 7));
    streamed += f.flush();
    for (const out of [streamed, sanitizeReply(reply), sanitizeChunk(reply), redactCopycat(reply)]) {
      assert.ok(!out.includes(m.slice(0, 4)) && !out.includes(m.slice(-4)), out);
      assert.match(out, /i will name mine when it launches\./);
    }
    // ordinary words and other addresses stay
    assert.equal(redactCopycat("in the bands on ORE/SOL, pool So11111111111111111111111111111111111111112"), "in the bands on ORE/SOL, pool So11111111111111111111111111111111111111112");
    const e = entry({ cycle: 3, min: 1, pool: "AAA", sol: 5, positions: [] });
    const dirty = { ...e, headline: `closed, not ${m}` } as JournalEntry;
    const [clean] = redactCopycatDeep([dirty]);
    assert.equal(clean!.headline, "closed, not ");
    assert.ok(!JSON.stringify(redactCopycatDeep(trimEntries([dirty]))).includes(m.slice(0, 6)));
  });

  console.log(`\n${passed} web model tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
