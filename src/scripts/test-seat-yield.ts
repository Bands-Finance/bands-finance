/**
 * The seat-yield model (src/screener/seatYield.ts), on the first live hour's numbers (2026-09-17):
 * MCDx/SOL 21 SOL a bin at 0.15%, NVDAx/SOL 12.7 a bin at 0.2%, MRVL/SOL 10 a bin at 1.5%.
 *   npx tsx src/scripts/test-seat-yield.ts
 */
import assert from "node:assert/strict";
import { binQuote, consolidation, rankSeats, seatRankingEnv, seatYield, sittingOut, weakSeatRotation, type HeldSeat, type RankedSeat } from "../screener/seatYield";

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
const near = (a: number, b: number, tol = 1e-9, what = "") => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what} expected ${b}, got ${a}`);

/** bins around active 100 with `perBin` SOL of liquidity each (Y side below, X side above at price p) */
const flat = (perBin: number, p: number, n = 10) => {
  const out = [];
  for (let id = 100 - n; id <= 100 + n; id++) out.push(id <= 100 ? { binId: id, xAmount: 0, yAmount: perBin } : { binId: id, xAmount: perBin / p, yAmount: 0 });
  return out;
};

async function main() {
  console.log("the seat's share and yield");
  await test("seatYield: 5 SOL over 31 bins in a pool holding 21 SOL a bin is a 0.76% share; the same seat over 5 bins in a 10 SOL/bin pool is 9%", () => {
    const mcd = seatYield({ seatQuote: 5, binsEachSide: 15, activeBinId: 100, bins: flat(21.6, 2.6), quoteSide: "Y", tokenPriceInQuote: 2.6, poolFeesPerDayQuote: 6 });
    near(mcd.oursPerBinQuote, 5 / 31, 1e-12);
    near(mcd.theirsPerBinQuote, 21.6, 1e-9);
    near(mcd.bandDepthQuote, 21.6 * 31, 1e-9, "the band's 31 bins hold 670 SOL: the policy would cap the seat at half of it");
    near(mcd.sharePct, (5 / 31 / (21.6 + 5 / 31)) * 100, 1e-9);
    assert.ok(mcd.sharePct > 0.7 && mcd.sharePct < 0.8, `MCDx share ${mcd.sharePct}`);
    near(mcd.feesPerDayQuote, 6 * mcd.sharePct / 100, 1e-9);
    assert.ok(mcd.yieldPctPerDay < 1, `MCDx yield ${mcd.yieldPctPerDay}%/day: not worth a 5 SOL seat`);
    const mrvl = seatYield({ seatQuote: 5, binsEachSide: 2, activeBinId: 100, bins: flat(10, 2.35), quoteSide: "Y", tokenPriceInQuote: 2.35, poolFeesPerDayQuote: 67 });
    near(mrvl.sharePct, (1 / 11) * 100, 1e-9, "1 SOL a bin against 10");
    assert.ok(mrvl.yieldPctPerDay > 100, `MRVL at its day's fees: ${mrvl.yieldPctPerDay}%/day`);
    const quiet = seatYield({ ...{ seatQuote: 5, binsEachSide: 2, activeBinId: 100, bins: flat(10, 2.35), quoteSide: "Y", tokenPriceInQuote: 2.35 }, poolFeesPerDayQuote: 0.89 });
    near(quiet.yieldPctPerDay, (0.89 * (1 / 11)) / 5 * 100, 1e-9, "at the last hour's pace instead");
    // the active bin's own reading is kept separately
    const bins = flat(10, 2.35);
    bins.find((b) => b.binId === 100)!.yAmount = 30;
    const lumpy = seatYield({ seatQuote: 5, binsEachSide: 2, activeBinId: 100, bins, quoteSide: "Y", tokenPriceInQuote: 2.35, poolFeesPerDayQuote: 1 });
    near(lumpy.activeBinQuote, 30, 1e-9);
    near(lumpy.theirsPerBinQuote, (30 + 4 * 10) / 5, 1e-9, "the mean over the band's five bins");
    assert.equal(seatYield({ seatQuote: 0, binsEachSide: 2, activeBinId: 100, bins, quoteSide: "Y", tokenPriceInQuote: 2.35, poolFeesPerDayQuote: 1 }).sharePct, 0);
    near(binQuote({ xAmount: 2, yAmount: 3 }, "X", 4), 2 + 12, 1e-12, "quote on the X side: Y priced into X");
  });

  console.log("ranking and rotation");
  await test("rankSeats: candidates under the floor drop out; the rest best first", () => {
    const c = (label: string, y: number): RankedSeat => ({ address: label, label, mint: `m-${label}`, yieldPctPerDay: y, sharePct: 5, feesPerDayQuote: 0.1, quoteSymbol: "SOL", feeSource: "24h", capSol: 15 });
    const ranked = rankSeats([c("MCDx", 0.8), c("MRVL", 60), c("NVDAx", 1.2), c("BROS", 3)], { minYieldPct: 1, rotateFactor: 2, minAgeMin: 60, reentryMin: 60 });
    assert.deepEqual(ranked.map((r) => r.label), ["MRVL", "BROS", "NVDAx"]);
  });

  await test("weakSeatRotation: the weakest held seat makes way for a candidate that beats it by the factor, floor or not; pins, young bands and near-misses stay", () => {
    const now = Date.parse("2026-09-17T13:00:00Z");
    const env = { minYieldPct: 1, rotateFactor: 2, minAgeMin: 60, reentryMin: 60 };
    const c = (label: string, y: number, feeSource: RankedSeat["feeSource"] = "flow-60m"): RankedSeat => ({ address: label, label, mint: `m-${label}`, yieldPctPerDay: y, sharePct: 9, feesPerDayQuote: 0.5, quoteSymbol: "SOL", feeSource, capSol: 15 });
    const h = (label: string, y: number, ageMin: number, pinned = false, heldSol: number | null = null, capSol = 15): HeldSeat => ({ address: label, label, yieldPctPerDay: y, openedAt: now - ageMin * 60_000, pinned, capSol, heldSol, feeSource: "flow-4h" });
    const held = [h("MCDx", 0.4, 90), h("NVDAx", 0.9, 90, true), h("MRVL", 20, 90)];
    const ranked = rankSeats([c("BROS", 3), c("MRVL", 20)], env);
    const rot = weakSeatRotation(held, ranked, env, now)!;
    assert.equal(rot.pool, "MCDx", "the weakest unpinned seat under the floor");
    assert.match(rot.reason, /MCDx earns about 0\.40% a day on its seat, under the 1% floor, while BROS would earn about 3\.00% \(9\.0% of its bins, the last hour's fees\), 7\.5x as much/);
    assert.equal(weakSeatRotation([h("MCDx", 0.4, 30)], ranked, env, now), null, "thirty minutes old: too young");
    assert.equal(weakSeatRotation([h("NVDAx", 0.4, 90, true)], ranked, env, now), null, "a pin never rotates");
    assert.equal(weakSeatRotation([h("MCDx", 0.4, 90)], rankSeats([c("BROS", 1.5)], env), env, now), null, "1.5% does not beat 2 x the floor");
    assert.equal(weakSeatRotation([h("MCDx", 1.2, 90)], rankSeats([c("BROS", 3)], env), env, now)?.pool, "MCDx", "a seat over the floor still makes way for one 2x better");
    assert.equal(weakSeatRotation([h("MCDx", 2, 90)], rankSeats([c("BROS", 3)], env), env, now), null, "3% is not 2 x 2%: it stays");
    const focus = weakSeatRotation([h("MRVL", 1.9, 90), h("NVDAx", 1.1, 90)], rankSeats([c("DKNG", 51)], env), env, now)!;
    assert.equal(focus.pool, "NVDAx", "the weakest seat goes first, one per cycle");
    assert.match(focus.reason, /46\.4x as much/);
    assert.equal(weakSeatRotation(held, rankSeats([c("MRVL", 20)], env), env, now), null, "the only candidate is already held");
    assert.equal(weakSeatRotation([h("MCDx", 0.4, 90)], rankSeats([c("DKNG", 51, "24h")], env), env, now), null, "the venue's day figure alone (DKNG read 51% that way, 1.7% by the scout) rotates nothing");
    assert.equal(weakSeatRotation([h("MCDx", 0.4, 90)], rankSeats([c("DKNG", 51, "24h"), c("BROS", 3)], env), env, now)?.label, "MCDx", "the best candidate the scout has read decides");
    assert.match(weakSeatRotation([h("MCDx", 0.4, 90)], rankSeats([c("BROS", 3, "flow-4h")], env), env, now)!.reason, /the last four hours' fees/);
    assert.equal(sittingOut(now - 30 * 60_000, env, now), true, "given up half an hour ago: sits out");
    assert.equal(sittingOut(now - 61 * 60_000, env, now), false);
    assert.equal(sittingOut(undefined, env, now), false);
    // CONSOLIDATION: the best held seat could hold more, a weaker seat funds it
    const dk = h("DKNG", 30, 90, false, 10, 15);
    const con = consolidation([h("MRVL", 1.9, 90, false, 5), dk, h("NVDAx", 1.1, 90, false, 5)], env, now, 0.75)!;
    assert.equal(con.pool, "NVDAx", "the weakest first");
    assert.match(con.reason, /NVDAx earns about 1\.10% a day on its seat while DKNG, already held, earns about 30\.00% and could hold 5\.0 SOL more \(10\.0 of 15\.0 SOL\); the money goes there/);
    assert.equal(consolidation([h("MRVL", 1.9, 90, false, 5), h("DKNG", 30, 90, false, 14.5, 15)], env, now, 0.75), null, "half a SOL of room is not worth a re-lay");
    assert.equal(consolidation([h("MRVL", 1.9, 90, false, 5), h("DKNG", 30, 90, false, 5, 5)], env, now, 0.75), null, "the best seat is at its depth cap");
    assert.equal(consolidation([h("MRVL", 16, 90, false, 5), dk], env, now, 0.75), null, "16% is not under 30/2");
    assert.equal(consolidation([h("MRVL", 1.9, 30, false, 5), dk], env, now, 0.75), null, "too young");
    assert.equal(consolidation([h("NVDAx", 1.9, 90, true, 5), dk], env, now, 0.75), null, "pinned");
    assert.equal(consolidation([h("MRVL", 0.9, 90, false, 5), h("DKNG", 0.4, 90, false, 5, 15)], env, now, 0.75), null, "a best seat under the floor grows nothing");
    assert.equal(consolidation([h("MRVL", 1.9, 90, false, null), dk], env, now, 0.75), null, "a seat not yet observed is not judged");
    const e = seatRankingEnv({});
    assert.deepEqual([e.minYieldPct, e.rotateFactor, e.minAgeMin, e.rankTop, e.reentryMin], [1, 2, 60, 8, 60]);
    assert.equal(seatRankingEnv({ METEORA_STOCK_MIN_SEAT_YIELD_PCT: "2.5", METEORA_STOCK_RANK_TOP: "5" }).minYieldPct, 2.5);
  });

  console.log(`\n${passed} seat yield tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
