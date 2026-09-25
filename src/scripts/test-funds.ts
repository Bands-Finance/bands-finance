import assert from "node:assert/strict";
import { fundsOf, knobOf, seatableAfterClose, type FundsInput } from "../desk/funds";
import { weakSeatRotation, type HeldSeat, type RankedSeat } from "../screener/seatYield";

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    process.exitCode = 1;
    console.log(`  FAIL  ${name}\n${(err as Error).message}`);
  }
}

// the live book on 25 Sep 2026: a 3.5 SOL band, 0.8 SOL gas, the 5% minimum seat of a 3.5 SOL book, one seat
const base: FundsInput = { sol: 1, usdc: 0, solPriceUsd: 119.7, gasReserveSol: 0.8, maxPositionSol: 3.5, minSeatSol: 0.175, positionRentSol: 0.0574, maxActivePools: 1, minSharePct: 50, dropUnderSol: 0.5 };
const q = (o: Partial<FundsInput>) => [...fundsOf({ ...base, ...o }).quotes].sort();

console.log("funds");
test("the 15:05 wallet (1.04 SOL, 497 USDC): SOL clears the minimum by a hair and is dropped; new seats go to USDC", () => {
  const f = fundsOf({ ...base, sol: 1.0419, usdc: 497.37 });
  assert.deepEqual([...f.quotes], ["USDC"]);
  assert.ok(Math.abs(f.seatSol.SOL - (1.0419 - 0.8 - 0.0574)) < 1e-9);
  assert.match(f.dropped ?? "", /new seats go to USDC pools/);
});
test("the morning wallet (4.55 SOL, 3.6 USDC): USDC is under the minimum, SOL alone, nothing dropped", () => {
  const f = fundsOf({ ...base, sol: 4.55, usdc: 3.6 });
  assert.deepEqual([...f.quotes], ["SOL"]);
  assert.equal(f.dropped, null);
});
test("both quotes able to fill a band stay", () => {
  assert.deepEqual(q({ sol: 5, usdc: 600 }), ["SOL", "USDC"]);
});
test("a small side is dropped only when it is under half the other's seat AND under 0.5 SOL", () => {
  // USDC seat 0.4 SOL against 2.0426: under half and under 0.5, dropped
  assert.deepEqual(q({ sol: 2.9, usdc: 0.4 * 119.7 }), ["SOL"]);
  // USDC seat 0.9 SOL: under half of 2.0426, but a real band, kept
  assert.deepEqual(q({ sol: 2.9, usdc: 0.9 * 119.7 }), ["SOL", "USDC"]);
  // USDC seat 1.2 SOL: over half, kept
  assert.deepEqual(q({ sol: 2.9, usdc: 1.2 * 119.7 }), ["SOL", "USDC"]);
});
test("a small side that still seats a real band is kept: 2.4 SOL + 497 USDC (a 1.54 SOL seat against 3.5) funds both", () => {
  // 25 Sep 15:28: the only USDC pools past the gates paid under 1%/day measured; dropping a 1.5 SOL SOL seat would hand
  // the one seat to them every cycle, or to nothing
  const f = fundsOf({ ...base, sol: 2.4, usdc: 497.59, solPriceUsd: 120.7 });
  assert.deepEqual([...f.quotes].sort(), ["SOL", "USDC"]);
  assert.equal(f.dropped, null);
  assert.deepEqual(q({ sol: 0.8 + 0.0574 + 0.49, usdc: 497.59, solPriceUsd: 120.7 }), ["USDC"]);
  assert.deepEqual(q({ sol: 0.8 + 0.0574 + 0.51, usdc: 497.59, solPriceUsd: 120.7 }), ["SOL", "USDC"]);
});
test("under the x0.5 board regime the band is 1.75: the share test compares the quotes at that band", () => {
  // 1.3 SOL + 497 USDC: SOL seat 0.4426. Against the raw 3.5 band it is 13% and under 0.5: dropped. Against 1.75 it is 25%: still dropped
  assert.deepEqual(q({ sol: 1.3, usdc: 497, regimeMultiplier: 0.5 }), ["USDC"]);
  // with the floor off, the regime decides: 0.4426 of 1.75 is 25%, under 50%, dropped; of a 0.8 band (x0.23) it is 55%, kept
  assert.deepEqual(q({ sol: 1.3, usdc: 497, dropUnderSol: 99, regimeMultiplier: 0.5 }), ["USDC"]);
  assert.deepEqual(q({ sol: 1.3, usdc: 497, dropUnderSol: 99, maxPositionSol: 0.8 }), ["SOL", "USDC"]);
  // the 15:05 wallet's 0.185 SOL seat is dropped at the halved band too
  assert.deepEqual(q({ sol: 1.0419, usdc: 497.37, regimeMultiplier: 0.5 }), ["USDC"]);
});
test("opens off (regime x0) keeps the raw max band: the cycle opens resume must not take the 0.185 SOL seat", () => {
  assert.deepEqual(q({ sol: 1.0419, usdc: 497.37, regimeMultiplier: 0 }), ["USDC"]);
  assert.deepEqual(q({ sol: 1.0419, usdc: 497.37, regimeMultiplier: 1 }), ["USDC"]);
});
test("POLICY_QUOTE_MIN_SHARE_PCT=0 turns the rule off: the old minimum-seat test alone", () => {
  assert.deepEqual(q({ sol: 1.0419, usdc: 497.37, minSharePct: 0 }), ["SOL", "USDC"]);
});
test("knobs: unset or a blank `KEY=` line keeps the default; only an explicit 0 turns the rule off; junk or negative keeps the default", () => {
  for (const v of [undefined, "", " ", "abc", "-5"]) assert.equal(knobOf(v, 50), 50, JSON.stringify(v));
  assert.equal(knobOf("0", 50), 0);
  assert.equal(knobOf(" 30 ", 50), 30);
  assert.equal(knobOf("", 0.5), 0.5);
  // the 25 Sep wallet with a blank line in ops/live.env: SOL is still dropped
  assert.deepEqual(q({ sol: 1.0419, usdc: 497.37, minSharePct: knobOf("", 50), dropUnderSol: knobOf("", 0.5) }), ["USDC"]);
});
test("no SOL price: USDC cannot be valued; USDC needs the rent above the gas reserve", () => {
  assert.deepEqual(q({ sol: 1.0419, usdc: 497.37, solPriceUsd: null }), ["SOL"]);
  assert.deepEqual(q({ sol: 0.85, usdc: 497.37 }), []);
  assert.deepEqual(q({ sol: 0.86, usdc: 497.37 }), ["USDC"]);
});
test("a rotation's target is judged on the wallet the close returns to: a USDC band's money coming home drops SOL", () => {
  // 1.2 SOL + 10 USDC beside a 190 USDC band: the cycle-start wallet funds SOL alone (a 0.34 SOL seat), so the ranking sees SOL pools
  const wallet = { ...base, sol: 1.2, usdc: 10 };
  assert.deepEqual([...fundsOf(wallet).quotes], ["SOL"]);
  // the close brings the 190 USDC and the 0.0419 SOL rent home: SOL's 0.38 seat is now the small side and is dropped
  assert.deepEqual([...fundsOf({ ...wallet, sol: 1.2419, usdc: 200 }).quotes], ["USDC"]);
  const env = { minYieldPct: 2.5, rotateFactor: 3, memeRotateFactor: 1.5, minAgeMin: 60, reentryMin: 60 };
  const now = Date.parse("2026-09-25T15:00:00Z");
  const held: HeldSeat[] = [{ address: "held", label: "X/USDC", yieldPctPerDay: 8, openedAt: now - 2 * 3_600_000, pinned: false, capSol: 3.5, heldSol: 190 / 119.7, feeSource: "flow-4h" } as HeldSeat];
  const cand = (address: string, quoteSymbol: string, yieldPctPerDay: number): RankedSeat => ({ address, label: address, mint: address, yieldPctPerDay, sharePct: 5, feesPerDayQuote: 1, quoteSymbol, feeSource: "flow-4h", capSol: 3.5 }) as RankedSeat;
  const worth = [cand("Y/SOL", "SOL", 14)];
  assert.ok(weakSeatRotation(held, worth, env as never, now), "the cycle-start ranking would rotate X/USDC out for Y/SOL");
  const band = { quote: "USDC" as const, valueInQuote: 190, rentRefundSol: 0.0419 };
  const { seatable, after } = seatableAfterClose(worth, wallet, band);
  assert.deepEqual([...after], ["USDC"]);
  assert.deepEqual(seatable, []);
  // no target the wallet can seat after the close: the band stays
  assert.equal(seatable.length ? weakSeatRotation(held, seatable, env as never, now) : null, null);
  // a USDC candidate that clears the bar is still a rotation, and it is the seat the rotation is for
  const both = seatableAfterClose([cand("Y/SOL", "SOL", 14), cand("Z/USDC", "USDC", 13)], wallet, band);
  assert.deepEqual(both.seatable.map((c) => c.address), ["Z/USDC"]);
  assert.equal(weakSeatRotation(held, both.seatable, env as never, now)?.pool, "held");
  // a SOL-rich wallet (4.55 SOL + 3.6 USDC beside a 68 USDC band) keeps SOL after the close: nothing changes
  assert.deepEqual(seatableAfterClose(worth, { ...base, sol: 4.5545, usdc: 3.58 }, { quote: "USDC", valueInQuote: 68, rentRefundSol: 0.0419 }).seatable.map((c) => c.address), ["Y/SOL"]);
});
test("an empty wallet funds nothing", () => {
  assert.deepEqual(q({ sol: 0, usdc: 0 }), []);
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
