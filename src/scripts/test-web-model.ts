/**
 * The site's money math (web/src/derive.ts, web/src/model.ts), on fixtures. The one rule under test:
 * every figure is read per CYCLE (the whole book at one moment), never from the last entry of each
 * pool ever worked. The bug of 2026-09-16: a pool closed a day earlier still listed its band in its
 * last entry, so "the book" carried a 50 SOL band that no longer existed and "started with" was one
 * pool's entry instead of the first cycle's, printing +228 SOL on a desk that was down 40.
 *   npx tsx src/scripts/test-web-model.ts
 */
import assert from "node:assert/strict";
import { actionsOf, binsOf, bookOf, deskBlocks, flowOf, flowTotalsOf, realEntries, realPoints, recordOf, statusOf, verdictOf } from "../../web/src/model";
import { bookCycle, completeCycles, cycleEquity, cycleEquitySeries, cyclesOf, equityOf, equitySeriesOf, heldAfter, LIVE_POSITION_RENT_SOL, POSITION_RENT_SOL, rentOf, summarize } from "../../web/src/derive";
import type { EquityHistoryPoint, JournalEntry, Position } from "../../web/src/types";
import { dayWord, FEE_SHOWN_MIN, feesClaimedYet, narrativeOf, noBookNarrative, num, sinceWord } from "../../web/src/narrative";
import { oneBook, trimEntries } from "../publish/live";
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

  await test("the rent a band gets back: its own figure when the journal carries it, else the chain's 0.0419 for a live band and the paper book's 0.0574 for a paper one", () => {
    // 22 Sep review M4: a real position account holds (8120 + 128) x 5080 lamports since the rent change; the site added
    // the SDK's 0.0574 to every live band, 0.0155 SOL of equity per band that no close would ever hand back
    const b = band("r1", 5);
    assert.ok(Math.abs(rentOf(b, { mode: "live" }) - 0.04189984) < 1e-12);
    assert.equal(LIVE_POSITION_RENT_SOL, 0.04189984);
    assert.ok(Math.abs(rentOf(b, { mode: "paper" }) - POSITION_RENT_SOL) < 1e-12);
    assert.ok(Math.abs(rentOf({ ...b, rentSol: 0.05 }, { mode: "live" }) - 0.05) < 1e-12, "the journal's own figure wins");
    const e = entry({ cycle: 1, min: 0, pool: "AAA", sol: 5, positions: [band("r1", 20), band("r2", 10)] });
    const live = { ...e, mode: "live" } as JournalEntry;
    assert.ok(Math.abs(equityOf(live) - equityOf(e) - 2 * (0.04189984 - 0.0574)) < 1e-9, "two live bands: 0.031 SOL less than the paper rule");
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

  await test("the book after a move, the same cycle: a closed band is off it and its money in the wallet; the band a re-lay laid is on it, in range, worth what went in; a claim's fees are in the wallet, not counted banked and waiting both; the cycle's equity holds", () => {
    // 25 Sep 2026: the entry's positions are the read BEFORE the move, so the site showed "Flat" for three minutes after the
    // first live band opened, the closed band "out by 2 bins" for five after the re-lay, and the re-lay's fees twice
    const RENT_LIVE = LIVE_POSITION_RENT_SOL;
    const open = (o: Partial<NonNullable<JournalEntry["decision"]["open"]>>) => ({ side: "SOL_ONLY", amountSol: 10, amountToken: 0, binsBelowActive: 4, binsAboveActive: 0, strategy: "Spot", ...o });
    const withExec = (e: JournalEntry, exec: Record<string, unknown>, dec: Record<string, unknown> = {}) => ({ ...e, decision: { ...e.decision, ...dec }, execution: { ...e.execution, ...exec } }) as JournalEntry;
    // what one entry's book is worth, before and after its move: the same money on the other side of it
    const worth = (e: JournalEntry) => cycleEquity({ cycle: e.cycle, t: 0, entries: [e] });
    const holds = (e: JournalEntry, why: string) => assert.ok(Math.abs(worth(heldAfter(e)) - worth(e)) < 1e-9, `${why}: ${worth(heldAfter(e))} vs ${worth(e)}`);
    // SOL-quoted AAA: cycle 1 holds a1 (20 SOL), cycle 2 closes it, cycle 3 opens a2 (10 SOL under the price), cycle 4 claims a2's fees
    const c1 = entry({ cycle: 1, min: 1, pool: "AAA", sol: 5, positions: [band("a1", 20)] });
    const c2 = entry({ cycle: 2, min: 10, pool: "AAA", sol: 5, positions: [band("a1", 20)], action: "CLOSE_POSITION", closed: "a1" });
    const c3 = withExec(entry({ cycle: 3, min: 20, pool: "AAA", sol: 5 + 20 + RENT, positions: [], action: "OPEN_POSITION" }), { opened: { address: "a2", entryValueSol: 10 } }, { open: open({}) });
    const c4 = entry({ cycle: 4, min: 30, pool: "AAA", sol: 15, positions: [band("a2", 10, { feeY: 0.05 })], action: "CLAIM_FEES" });

    // the close: off the book the same cycle, the 20 SOL and the rent back in the wallet, equity unchanged
    const atClose = [c1, c2].reverse();
    assert.deepEqual(bookOf(atClose).bands, [], "the band the entry closed is not on the book");
    const closeHeld = bookCycle(atClose)!.entries[0];
    assert.equal(closeHeld.positions.length, 0);
    assert.ok(Math.abs(closeHeld.wallet.sol - (5 + 20 + RENT)) < 1e-9, "what the band held, with its rent, is in the wallet");
    holds(c2, "the close does not change what the book is worth");
    const rc = recordOf(atClose)!;
    assert.equal(rc.atWork, 0);
    assert.equal(rc.feesUnclaimed, 0);
    assert.ok(Math.abs(rc.wallet - (5 + 20 + RENT)) < 1e-9, "the record's wallet is the wallet after the move");
    assert.equal(c2.positions.length, 1, "the entry itself still lists the band it closed: the move's own readers need it");

    // the open: the band is laid as the decision asked, in range at the price it was laid, no fees, worth what went in; the wallet paid it
    const atOpen = [c1, c2, c3].reverse();
    const a2 = bookOf(atOpen).bands.find((b) => b.address === "a2");
    assert.ok(a2, "the band the entry opened is on the book the same cycle");
    assert.deepEqual([a2!.lowerBinId, a2!.upperBinId, a2!.widthBins, a2!.inRange, a2!.binsFromRange], [96, 100, 5, true, 0], "four bins under the active bin and the active bin itself (a Meteora band includes it)");
    assert.ok(Math.abs(a2!.upperPrice - 1) < 1e-12 && Math.abs(a2!.lowerPrice - Math.pow(1.002, -4)) < 1e-12, "priced off the active bin by the bin step");
    assert.equal(a2!.putIn, 10);
    assert.equal(a2!.worthNow, 10);
    assert.equal(a2!.fees, 0);
    assert.equal(a2!.marketMove, 0);
    assert.equal(a2!.side, "SOL just under the price");
    assert.equal(a2!.openedAt, new Date(c3.ts).getTime());
    const openHeld = bookCycle(atOpen)!.entries[0];
    assert.ok(Math.abs(openHeld.wallet.sol - 15) < 1e-9, "the 10 SOL and the rent left the wallet");
    holds(c3, "equity holds across the open");
    assert.ok(Math.abs(recordOf(atOpen)!.atWork - 10) < 1e-9);
    assert.equal(summarize("mr-bands", "Mr Bands", atOpen).bandsOpen, 1);

    // the claim's own cycle: the fees are banked once, not banked and still waiting
    const atClaim = [c1, c2, c3, c4].reverse();
    const rk = recordOf(atClaim)!;
    assert.ok(Math.abs(rk.feesRealized - 0.05) < 1e-9);
    assert.equal(rk.feesUnclaimed, 0, "the claim's own cycle does not count the fees it took as still waiting");
    const a2c = bookOf(atClaim).bands.find((b) => b.address === "a2")!;
    assert.ok(Math.abs(a2c.fees - 0.05) < 1e-9, "the band card counts the claim once");
    assert.ok(Math.abs(a2c.worthNow - 9.95) < 1e-9, "the fees left the band");
    assert.ok(Math.abs(bookCycle(atClaim)!.entries[0].wallet.sol - 15.05) < 1e-9, "and landed in the wallet");
    holds(c4, "equity holds across the claim");

    // a USDC re-lay, the legs consistent (1,002 USDC at 0.01 = 10.02 SOL): the closed band's USDC comes back, the new band's USDC goes out
    const c1b = band("c1", 10.02, { amountY: 1000, feeY: 2, entryValueSol: 10 });
    const relay = withExec(
      entry({ cycle: 5, min: 40, pool: "CCC", sol: 15.05, usdc: 5000, positions: [c1b], action: "REBALANCE" }),
      { closed: "c1", opened: { address: "c2", entryValueSol: 10.02 } },
      { positionAddress: "c1", open: open({ amountSol: 1002, binsBelowActive: 9 }) },
    );
    const atRelay = [c1, c2, c3, c4, relay].reverse();
    assert.deepEqual(bookOf(atRelay).bands.map((b) => b.address).sort(), ["a2", "c2"], "the re-laid band, not the one it closed");
    const c2b = bookOf(atRelay).bands.find((b) => b.address === "c2")!;
    assert.deepEqual([c2b.lowerBinId, c2b.upperBinId, c2b.widthBins, c2b.inRange], [91, 100, 10, true]);
    assert.ok(Math.abs(c2b.putIn! - 10.02) < 1e-9);
    const relayHeld = bookCycle(atRelay)!.entries.find((e) => e.pool.address === "CCC")!;
    assert.ok(Math.abs((relayHeld.wallet as { quote: number }).quote - 5000) < 1e-9, "1,002 USDC back from the close, 1,002 into the open");
    assert.ok(Math.abs(relayHeld.wallet.sol - 15.05) < 1e-9, "rent back, rent out");
    holds(relay, "equity holds across the re-lay");
    assert.ok(Math.abs(cycleEquity(bookCycle(atRelay)!) - (worth(relay) + 9.95 + RENT)) < 1e-9, "the book: the re-laid band and AAA's carried a2, once each");
    const rr = recordOf(atRelay)!;
    assert.ok(Math.abs(rr.feesRealized - (0.05 + 0.02)) < 1e-9, "cycle 4's claim and the 2 USDC the re-lay's close realised, once each");
    assert.equal(rr.feesUnclaimed, 0, "and they are not still waiting");
    assert.ok(Math.abs(rr.quote!.amount - 5000) < 1e-9, "the record's USDC is the wallet after the move");

    // the entry's own positions are untouched: the closed band's exit value and the fees it banked are read from them
    assert.equal(summarize("mr-bands", "Mr Bands", atRelay).closed.find((c) => c.address === "c1")!.exitValueSol, 10.02);
    assert.equal(actionsOf(atRelay)[0].action, "REBALANCE");

    // a dry run sends nothing: the book is as it was, nothing is laid
    const dry = { ...c3, mode: "dry-run", execution: { ...c3.execution, mode: "dry-run" } } as JournalEntry;
    assert.equal(heldAfter(dry), dry);
    assert.deepEqual(bookOf([c1, c2, dry].reverse()).bands, []);
    // a live re-lay's card links the open, not the close it signed first
    const live = { ...relay, mode: "live", execution: { ...relay.execution, mode: "live", txs: [{ label: "close band c1 1/1", ok: true, signature: "sigClose" }, { label: "open SOL_ONLY band bins [91, 100]", ok: true, signature: "sigOpen" }] } } as JournalEntry;
    assert.equal(bookOf([c1, c2, c3, c4, live].reverse()).bands.find((b) => b.address === "c2")!.openTx, "sigOpen");
  });

  await test("the USDC leg is carried across cycles that do not journal it: a cycle worked in SOL pools alone does not mark the wallet's USDC as nothing", () => {
    // 25 Sep 2026: a SOL-quoted entry's wallet says quote SOL and nothing of the USDC; a cycle of ANTHROPIC/SOL alone read 71 USDC as 0
    const chrono = [...fixture()].reverse();
    const solOnly = [...chrono, entry({ cycle: 5, min: 40, pool: "AAA", sol: 5, positions: [band("a1", 20)] })].reverse();
    const cycles = cyclesOf(solOnly);
    assert.ok(Math.abs(cycleEquity(cycles[4]) - (5 + 20 + RENT)) < 1e-9, "read alone the cycle has no USDC leg");
    const eq = cycleEquitySeries(cycles);
    assert.ok(Math.abs(eq[4] - (5 + 50 + 20 + RENT)) < 1e-9, "carried: the 5,000 USDC of the cycle before");
    assert.ok(Math.abs(eq[3] - cycleEquity(cycles[3])) < 1e-9, "a cycle with its own leg reads its own");
    const series = equitySeriesOf(solOnly);
    assert.ok(Math.abs(series[series.length - 1].equity - (5 + 50 + 20 + 10 + 2 * RENT)) < 1e-9, "the book's point: CCC's band carried one cycle and the USDC with it");
    const r = recordOf(solOnly)!;
    assert.ok(Math.abs(r.equityNow - (5 + 50 + 20 + 10 + 2 * RENT)) < 1e-9);
    assert.equal(r.quote?.symbol, "USDC");
    assert.ok(Math.abs(r.quote!.inSol - 50) < 1e-9, "the record still names the USDC");
    // a cut oldest cycle that carried the leg still hands it on
    const cut = [entry({ cycle: 1, min: 1, pool: "BBB", sol: 5, usdc: 1000, positions: [] }), entry({ cycle: 2, min: 10, pool: "AAA", sol: 5, positions: [band("a1", 20)] }), entry({ cycle: 2, min: 11, pool: "DDD", sol: 5, positions: [] })].reverse();
    assert.equal(equitySeriesOf(cut).length, 1, "cycle 1 is cut");
    assert.ok(Math.abs(equitySeriesOf(cut)[0].equity - (5 + 10 + 20 + RENT)) < 1e-9, "1,000 USDC from the cut cycle 1");
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

  await test("recordOf with history: money moved in or out by hand (flowSol, flowUsdc) is not the desk's result: net, the percent and the day rows leave it out", () => {
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
    // 25 Sep 2026: funded with 1.4951 before the first mark, a 3.703 SOL sweep of the token's fees landed mid-run,
    // the book marks 5.1523: the site said "up 3.7 SOL today (+244.6%)" for a desk that was 0.046 down
    const history = [
      pt({ t: T0 + 1 * 60_000, cycle: 1, equitySol: 1.4951, flowSol: 1.4951 }),
      pt({ t: T0 + 2 * 60_000, cycle: 2, equitySol: 1.492, flowSol: 1.4951 }),
      pt({ t: T0 + 3 * 60_000, cycle: 3, equitySol: 5.195, flowSol: 5.1981 }),
      pt({ t: T0 + 31 * 60_000, cycle: 4, equitySol: 5.1523, flowSol: 5.1981 }),
    ];
    const r = recordOf(fixture(), history)!;
    assert.ok(Math.abs(r.flows - 3.703) < 1e-9, "the sweep after the first mark, not the funding before it");
    assert.ok(Math.abs(r.net - (5.1523 - 1.4951 - 3.703)) < 1e-9, "net is the desk's own result");
    assert.ok(Math.abs(r.netPct - ((5.1523 - 1.4951 - 3.703) / 5.1981) * 100) < 1e-9, "the percent is on what he had to work with");
    const last = r.days[r.days.length - 1];
    assert.ok(Math.abs(last.flow - 3.703) < 1e-9, "the day row carries the flow");
    assert.ok(Math.abs(last.close - last.open - last.flow - (5.1523 - 1.4951 - 3.703)) < 1e-9);
    // points from before the field read as 0; a USDC leg is valued at the mark's SOL price
    const usdc = recordOf(fixture(), [pt({ t: T0 + 60_000, cycle: 1, equitySol: 10 }), pt({ t: T0 + 31 * 60_000, cycle: 2, equitySol: 12, flowUsdc: 100, solPriceUsd: 100 })])!;
    assert.ok(Math.abs(usdc.flows - 1) < 1e-9);
    assert.ok(Math.abs(usdc.net - 1) < 1e-9);
    // a withdrawal: net stays the desk's result and the percent base does not shrink
    const out = recordOf(fixture(), [pt({ t: T0 + 60_000, cycle: 1, equitySol: 10, flowSol: 0 }), pt({ t: T0 + 31 * 60_000, cycle: 2, equitySol: 6, flowSol: -4 })])!;
    assert.ok(Math.abs(out.flows + 4) < 1e-9);
    assert.ok(Math.abs(out.net) < 1e-9);
    assert.equal(out.netPct, 0);
    // without history there is nothing to read flows from
    assert.equal(recordOf(fixture())!.flows, 0);
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

  await test("actionsOf: a one-sided Meteora band includes the active bin (49 bins for 48 under it), a CLMM's does not; both sides always did", () => {
    // 25 Sep 2026: "67.91 USDC across 48 bins" under his own "67.91 usdc across 49 bins" and a tx labelled bins [-1189, -1141]
    const chrono = [...fixture()].reverse();
    const laid = (o: Record<string, unknown>, venue?: string) => {
      const e = entry({ cycle: 6, min: 50, pool: "CCC", sol: 5, usdc: 5000, positions: [], action: "OPEN_POSITION" });
      (e.decision as { open: unknown }).open = { side: "SOL_ONLY", amountSol: 67.91, amountToken: 0, binsBelowActive: 48, binsAboveActive: 0, strategy: "Spot", ...o };
      if (venue) (e.pool as { venue: string }).venue = venue;
      return actionsOf([...chrono, e].reverse())[0].what;
    };
    assert.equal(laid({}), "67.91 USDC across 49 bins, USDC just under the price");
    assert.equal(laid({ side: "TOKEN_ONLY", amountSol: 0, amountToken: 12, binsBelowActive: 0, binsAboveActive: 3 }), "12 CCC across 4 bins, token just over the price");
    assert.equal(laid({ side: "BOTH", amountToken: 5, binsBelowActive: 10, binsAboveActive: 10 }), "67.91 USDC + 5 CCC across 21 bins, both sides of the price");
    assert.equal(laid({}, "raydium-clmm"), "67.91 USDC across 48 bins, USDC just under the price", "a CLMM's one-sided band sits strictly under the price");
    assert.equal(binsOf({ side: "SOL_ONLY", amountSol: 1, amountToken: 0, binsBelowActive: 48, binsAboveActive: 0, strategy: "Spot" }, {}), 49);
    assert.equal(binsOf({ side: "BOTH", amountSol: 1, amountToken: 1, binsBelowActive: 10, binsAboveActive: 10, strategy: "Spot" }, { venue: "orca-whirlpool" }), 21);
  });

  await test("actionsOf: a close or re-lay says the split the band card says: from the market, plus the fees, is vs entry; the fees are never added on after", () => {
    // 25 Sep 2026: "4.9801 SOL back, −0.0199 SOL vs entry, 0.0355 SOL of fees with it" read as 4.9801 + 0.0355 back and a market loss of 0.02;
    // the 0.0355 was inside both figures and the market's share was −0.0554
    const chrono = [...fixture()].reverse();
    const closed = { ...entry({ cycle: 7, min: 60, pool: "AAA", sol: 5, positions: [band("a1", 4.9801, { feeY: 0.0355, entryValueSol: 5 })], action: "CLOSE_POSITION", closed: "a1" }), emergency: true } as JournalEntry;
    const row = actionsOf([...chrono, closed].reverse())[0];
    assert.equal(row.what, "4.9801 SOL back, −0.0554 SOL from the market and +0.0355 SOL of fees, −0.0199 SOL vs entry");
    assert.equal(row.sentence, "The guards closed his band in AAA/SOL: 4.9801 SOL back, −0.0554 SOL from the market and +0.0355 SOL of fees, −0.0199 SOL vs entry.");
    assert.ok(Math.abs(row.resultSol! - -0.0199) < 1e-9, "the column is still what the move realised against entry");
    const won = entry({ cycle: 7, min: 61, pool: "AAA", sol: 5, positions: [band("a1", 5.0075, { feeY: 0.0124, entryValueSol: 5 })], action: "CLOSE_POSITION", closed: "a1" });
    assert.equal(actionsOf([...chrono, won].reverse())[0].what, "5.0075 SOL back, −0.0049 SOL from the market and +0.0124 SOL of fees, +0.0075 SOL vs entry", "a small win that was all fees says so");
    const relay = entry({ cycle: 7, min: 62, pool: "AAA", sol: 5, positions: [band("a1", 0.5674, { feeY: 0.00032, entryValueSol: 0.5671 })], action: "REBALANCE", closed: "a1" });
    (relay.decision as { open: unknown }).open = { side: "SOL_ONLY", amountSol: 0.5674, amountToken: 0, binsBelowActive: 48, binsAboveActive: 0, strategy: "Spot" };
    assert.equal(actionsOf([...chrono, relay].reverse())[0].what, "0.5674 SOL out (+0 market, +0.0003 fees, +0.0003 vs entry), back in as 0.5674 SOL across 49 bins, SOL just under the price", "the live CATE/USDC re-lay: a gain that was all fees says so");
    // no fees inside: the old shape, no fee clause; no entry value on record: what came back and how much of it was fees
    const plain = entry({ cycle: 7, min: 63, pool: "AAA", sol: 5, positions: [band("a1", 18, { entryValueSol: 20 })], action: "CLOSE_POSITION", closed: "a1" });
    assert.equal(actionsOf([...chrono, plain].reverse())[0].what, "18 SOL back, −2 SOL vs entry");
    const noEntry = entry({ cycle: 7, min: 64, pool: "AAA", sol: 5, positions: [band("a1", 18, { feeY: 0.5, entryValueSol: undefined })], action: "CLOSE_POSITION", closed: "a1" });
    assert.equal(actionsOf([...chrono, noEntry].reverse())[0].what, "18 SOL back, 0.5 SOL of it fees");
    // the live 14:59 CATE/USDC close: each figure rounded on its own printed −0.0027 + 0.002 beside −0.0006; the market share
    // is now the difference of the two printed figures, so the sentence adds up
    const cate = entry({ cycle: 7, min: 65, pool: "AAA", sol: 5, positions: [band("a1", 1.7493140884, { feeY: 0.002036363, entryValueSol: 1.7499352349 })], action: "CLOSE_POSITION", closed: "a1" });
    assert.equal(actionsOf([...chrono, cate].reverse())[0].what, "1.7493 SOL back, −0.0026 SOL from the market and +0.002 SOL of fees, −0.0006 SOL vs entry");
  });

  await test("recordOf: the wallet's USDC after a USDC-pool close is carried as it stood AFTER the close through later SOL-pool cycles", () => {
    // 25 Sep 2026: the 14:59 CATE/USDC close was followed by BP/SOL cycles, and the record printed the USDC read before the
    // close (287.82) for the wallet's leg, 209 USDC short, on the page and in the no-history equity
    const close = entry({ cycle: 1, min: 1, pool: "CCC", sol: 5, usdc: 100, positions: [band("c1", 2, { amountY: 200, quoteInPosition: 200, solInPosition: 2, feeY: 1 })], action: "CLOSE_POSITION", closed: "c1" });
    const after = heldAfter(close);
    assert.equal((after.wallet as { quote?: number }).quote, 301, "the band's 200 USDC and its 1 USDC of fees are back in the wallet");
    const solCycle = entry({ cycle: 2, min: 5, pool: "AAA", sol: 5 });
    const r = recordOf([solCycle, close])!;
    assert.ok(r.quote, "the USDC leg is carried");
    assert.equal(r.quote!.amount, 301);
    assert.ok(Math.abs(r.quote!.inSol - 3.01) < 1e-9);
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
      // a day row carries its hand flow (DayRow.flow, 0 here): the note takes it out of the day's result
      days: [
        { date: "2026-09-14", fees: 1.24, open: 246.9, close: 244.88, moves: 0, vetoed: 0, overrides: 0, holds: 0, decisions: 0, flow: 0 },
        { date: "2026-09-15", fees: 17.22, open: 245.14, close: 214.76, moves: 0, vetoed: 0, overrides: 0, holds: 0, decisions: 0, flow: 0 },
        { date: "2026-09-16", fees: 1.31, open: 214.77, close: 211.6, moves: 10, vetoed: 0, overrides: 6, holds: 374, decisions: 400, flow: 0 },
        { date: "2026-09-17", fees: 2.07, open: 211.65, close: 211.9, moves: 35, vetoed: 0, overrides: 3, holds: 172, decisions: 200, flow: 0 },
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

  await test("one rule for every fee caption: 'not earned a fee yet' only where the figures print 0, and 'unclaimed' / 'still in the bands' only while nothing has reached the wallet", () => {
    // 25 Sep 2026: the story said "He has not earned a fee yet." beside "Fees earned 0.0005 SOL", and the made chapter
    // "He has earned 0.0008 SOL, unclaimed." over its own "Claimed +0.0003 SOL": three thresholds for one fact
    const now = Date.parse("2026-09-25T14:12:00Z");
    const status = { mode: "live", lastTs: now, ageMs: 0, sentence: "s", short: "live" } as const;
    const rec = (o: Record<string, unknown>) => ({ startTs: now - 3600e3, startEquity: 5.2, equityNow: 5.15, net: -0.05, netPct: -1, atWork: 0.57, days: [], feePoints: [], ...o }) as never;
    const story = (o: Record<string, unknown>) => narrativeOf({ record: rec(o), status: status as never, agentName: "Mr Bands", now }).story;
    // 0.00035 claimed by a re-lay, 0.00014 waiting: the figure prints 0.0005, so the sentence says it, and it is not "still in the bands"
    assert.deepEqual(story({ feesRealized: 0.00035, feesUnclaimed: 0.00014, feePoints: [{ t: now, amount: 0.00035, cumulative: 0.00035, href: null, simulated: false }] }), ["He has earned 0.0005 SOL in fees since he started.", "This is his own wallet on Solana."]);
    // a claim the desk's tally carries but the window's points do not: still claimed
    assert.deepEqual(story({ feesRealized: 0.0004, feesUnclaimed: 0.0031 })[0], "He has earned 0.0035 SOL in fees since he started.");
    // nothing claimed, fees waiting: still in the bands
    assert.deepEqual(story({ feesRealized: 0, feesUnclaimed: 0.0031 })[0], "He has earned 0.0031 SOL in fees since he started, still in the bands.");
    // under what num() prints: not a fee yet, and the statement row beside it prints 0
    assert.deepEqual(story({ feesRealized: 0, feesUnclaimed: 0.00003 })[0], "He has not earned a fee yet.");
    assert.equal(num(0.00003), "0");
    assert.equal(num(FEE_SHOWN_MIN), "0.0001");
    assert.equal(feesClaimedYet({ feesRealized: 0, feePoints: [] }), false);
    assert.equal(feesClaimedYet({ feesRealized: 0.00035, feePoints: [] }), true);
    assert.equal(feesClaimedYet({ feesRealized: 0, feePoints: [{ t: 1, amount: 0.00001, cumulative: 0.00001, href: null, simulated: false }] }), true, "a claim on record is a claim, whatever its size");
    // the made chapter and the abacus use the same gate and the same words for the same count
    const dash = readFileSync(path.resolve(__dirname, "../../web/src/DashboardApp.tsx"), "utf8");
    assert.ok(dash.includes("feesClaimedYet(record)") && !dash.includes("feesRealized < 0.0005"), "the made chapter keys 'unclaimed' on whether anything was claimed, not its size");
    const chapters = readFileSync(path.resolve(__dirname, "../../web/src/stage/Chapters.tsx"), "utf8");
    assert.ok(chapters.includes('label: "Payouts"') && !chapters.includes('label: "Claims"'), "the fee-points figure is not called Claims beside a table that counts CLAIM_FEES");
    assert.ok(chapters.includes("<th>Fee claims</th>"), "the table's column says which claims it counts");
    assert.ok(chapters.includes("of fees paid out") && !chapters.includes("of claims,"), "the abacus caption counts what the figure counts");
  });

  await test("realEntries and realPoints: one book, the newest entry's mode; a rehearsal older than the live run is not a live decision; the feed and the snapshot drop it at the source (oneBook)", () => {
    // 25 Sep 2026: the 13:08 dry-run read in data-mainnet counted as a twelfth decision and a tenth hold under "Live: his own wallet"
    const live = (min: number) => ({ ...entry({ cycle: 2, min, pool: "AAA", sol: 5 }), mode: "live", execution: { mode: "none", ok: true, txs: [], notes: [] } }) as JournalEntry;
    const dry = { ...live(0), id: "dry", mode: "dry-run" } as JournalEntry;
    const book = [live(20), live(10), dry];
    assert.deepEqual(realEntries(book).map((e) => e.id), [live(20).id, live(10).id]);
    assert.deepEqual(realEntries([...book].reverse()).map((e) => e.id), [live(10).id, live(20).id], "newest by time, whichever end it sits at");
    const r = recordOf(realEntries(book))!;
    assert.deepEqual([r.counts.decisions, r.counts.holds], [2, 2]);
    assert.equal(deskBlocks(realEntries(book))[0].first.ts, live(10).ts, "the terminal's first block is the first live read");
    assert.equal(statusOf(book, Date.parse(live(20).ts) + 1000, false).mode, "live");
    assert.deepEqual(realEntries([dry]), [dry], "a rehearsal alone is still a rehearsal");
    assert.equal(statusOf([dry], Date.parse(dry.ts) + 1000, false).mode, "dry-run");
    const pts = [{ t: 1, mode: "dry-run" }, { t: 2, mode: "live" }, { t: 3, mode: "paper" }, { t: 4, mode: "live" }] as unknown as EquityHistoryPoint[];
    assert.deepEqual(realPoints(pts).map((p) => p.t), [2, 4]);
    assert.deepEqual(oneBook(book, book[0]).map((e) => e.id), [live(20).id, live(10).id]);
    assert.deepEqual(oneBook(pts, pts[pts.length - 1]).map((p) => p.t), [2, 4]);
    assert.deepEqual(oneBook([], undefined), []);
    // live wins: a rehearsal run after the live desk stopped must not become the whole book (25 Sep 2026 review)
    const lateDry = { ...live(30), id: "late-dry", mode: "dry-run" } as JournalEntry;
    const afterStop = [lateDry, live(20), live(10)];
    assert.deepEqual(realEntries(afterStop).map((e) => e.id), [live(20).id, live(10).id]);
    assert.deepEqual(oneBook(afterStop, afterStop[0]).map((e) => e.id), [live(20).id, live(10).id]);
    const lateDryPts = [{ t: 2, mode: "live" }, { t: 4, mode: "live" }, { t: 5, mode: "dry-run" }] as unknown as EquityHistoryPoint[];
    assert.deepEqual(realPoints(lateDryPts).map((p) => p.t), [2, 4]);
    assert.deepEqual(oneBook(lateDryPts, lateDryPts[lateDryPts.length - 1]).map((p) => p.t), [2, 4]);
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
