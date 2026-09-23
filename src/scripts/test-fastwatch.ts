/**
 * The fast watch (src/engine/fastwatch.ts) and the fee-token sweep amount (src/executor.ts).
 *   npx tsx src/scripts/test-fastwatch.ts
 */
import assert from "node:assert/strict";
import { earlyCycleAllowed, fastEnv, fastTrigger, laidBandWatch, type WatchedBand } from "../engine/fastwatch";
import { residueCapPct, sizeUnderCap, swapImpactEnv, sweepAmount } from "../executor";
import { adviseWithPolicy, modelAdvises } from "../agent/decide";
import type { Decision } from "../agent/schema";
import type { PolicyResult } from "../agent/policy";

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

const NOW = Date.parse("2026-09-17T13:27:00Z");
// baton/SOL's first band: bins [-337, -333], 1% a bin, SOL on the Y side, laid from the price down
const baton: WatchedBand = { pool: "BATON", label: "baton/SOL", position: "POS", lowerBinId: -337, upperBinId: -333, quoteSide: "Y", binStep: 100, inRange: true, stopPct: 15, drawdownPct: 0 };

async function main() {
  const env = fastEnv({});
  await test("fastEnv: every 15 s, 90 s between early cycles, 12 an hour, wake at 85% of the stop, a minute-old reading is stale", () => {
    assert.deepEqual(env, { everySec: 15, minGapSec: 90, maxPerHour: 12, stopNear: 0.85, staleSec: 60 });
    assert.equal(fastEnv({ FAST_WATCH_SEC: "0" }).everySec, 0);
  });

  await test("fastTrigger: inside the band nothing; the last swap outside a band that was in range starts the cycle; a stale or missing reading never does", () => {
    assert.equal(fastTrigger(baton, { bin: -335, asOf: NOW - 5_000 }, NOW, env), null);
    const left = fastTrigger(baton, { bin: -339, asOf: NOW - 5_000 }, NOW, env)!;
    assert.equal(left.kind, "left-band");
    assert.match(left.detail, /the last swap is at bin -339, outside band \[-337, -333\] that was in range at the last cycle/);
    assert.equal(fastTrigger(baton, { bin: -330, asOf: NOW - 5_000 }, NOW, env)!.kind, "left-band", "off the top counts too: the idle clock starts from the cycle that sees it");
    assert.equal(fastTrigger({ ...baton, inRange: false }, { bin: -339, asOf: NOW - 5_000 }, NOW, env), null, "already known to be out: the cycle has seen it");
    assert.equal(fastTrigger(baton, { bin: -339, asOf: NOW - 61_000 }, NOW, env), null, "a minute old: stale");
    assert.equal(fastTrigger(baton, { bin: null, asOf: NOW }, NOW, env), null);
    assert.equal(fastTrigger(baton, null, NOW, env), null);
  });

  await test("fastTrigger: through the band on the token side and within 85% of the stop wakes the cycle even when it already knew the band was out", () => {
    const out = { ...baton, inRange: false };
    // the fills average at the band's middle (-335); 14 bins past it at 1% a bin is 13% down: 85% of a 15% stop is 12.75%
    const near = fastTrigger(out, { bin: -349, asOf: NOW - 5_000 }, NOW, env)!;
    assert.equal(near.kind, "stop-near");
    assert.match(near.detail, /14 bins past the middle of band \[-337, -333\]: about 13\.0% down against a 15\.0% stop/);
    assert.equal(fastTrigger(out, { bin: -345, asOf: NOW - 5_000 }, NOW, env), null, "10 bins past the middle is 9.5%: not near yet");
    assert.equal(fastTrigger({ ...out, drawdownPct: 13.2 }, { bin: -340, asOf: NOW - 5_000 }, NOW, env)!.kind, "stop-near", "what the last mark already showed counts");
    assert.equal(fastTrigger(out, { bin: -320, asOf: NOW - 5_000 }, NOW, env), null, "above a bid band the seat is all SOL: no stop to fear");
    // a band whose quote is X sits from the price up: the token side is above it
    const xq: WatchedBand = { ...out, quoteSide: "X", lowerBinId: 100, upperBinId: 104 };
    assert.equal(fastTrigger(xq, { bin: 118, asOf: NOW - 5_000 }, NOW, env)!.kind, "stop-near");
    assert.equal(fastTrigger(xq, { bin: 90, asOf: NOW - 5_000 }, NOW, env), null);
  });

  await test("fastTrigger on an ask band: under it the loss compounds the last mark's drawdown with the price's move from that mark; over it the cycle is woken once to book the sale", () => {
    // an ask laid at bin -337 over the price, the chain's basis already 4% down at the last mark taken at bin -340
    const ask: WatchedBand = { ...baton, inRange: false, lowerBinId: -337, upperBinId: -323, ask: true, markBinId: -340, drawdownPct: 4, stopPct: 10 };
    assert.equal(fastTrigger(ask, { bin: -343, asOf: NOW - 5_000 }, NOW, env), null, "3 bins under the mark: 4% then 3%, about 6.9%: not near a 10% stop");
    const near = fastTrigger(ask, { bin: -345, asOf: NOW - 5_000 }, NOW, env)!;
    assert.equal(near.kind, "stop-near");
    assert.match(near.detail, /5 bins under the ask's last mark at bin -340: about 8\.7% down against the chain's 10\.0% stop/);
    assert.equal(fastTrigger(ask, { bin: -338, asOf: NOW - 5_000 }, NOW, env), null, "under the ask but over the last mark: nothing to fear, nothing to book");
    assert.equal(fastTrigger(ask, { bin: -330, asOf: NOW - 5_000 }, NOW, env), null, "inside the ask: selling bin by bin");
    const sold = fastTrigger(ask, { bin: -320, asOf: NOW - 5_000 }, NOW, env)!;
    assert.equal(sold.kind, "ask-sold");
    assert.match(sold.detail, /over ask band \[-337, -323\]: it sold out; booking the SOL now/);
    assert.equal(fastTrigger({ ...ask, markBinId: -321 }, { bin: -320, asOf: NOW - 5_000 }, NOW, env), null, "the last cycle already saw it sold: it has decided on it");
    assert.equal(fastTrigger({ ...ask, inRange: true, markBinId: -330 }, { bin: -320, asOf: NOW - 5_000 }, NOW, env)!.kind, "ask-sold", "from inside the ask to over it: the sale is booked, not just the out-of-range clock");
    // the mark's bin stands in for the laid bin when absent; without a drawdown on the book the move alone counts
    assert.equal(fastTrigger({ ...ask, markBinId: undefined, drawdownPct: 0 }, { bin: -346, asOf: NOW - 5_000 }, NOW, env)!.kind, "stop-near", "9 bins under the laid bin at 1% is 8.6%: near");
    // quote on X: the ask sits under the price, sold out when the price falls through it
    const xAsk: WatchedBand = { ...ask, quoteSide: "X", lowerBinId: 100, upperBinId: 114, markBinId: 118 };
    assert.equal(fastTrigger(xAsk, { bin: 90, asOf: NOW - 5_000 }, NOW, env)!.kind, "ask-sold");
    assert.equal(fastTrigger(xAsk, { bin: 124, asOf: NOW - 5_000 }, NOW, env)!.kind, "stop-near");
  });

  await test("earlyCycleAllowed: 90 seconds apart, twelve an hour, never when the watch is off", () => {
    assert.equal(earlyCycleAllowed([], NOW, env), true);
    assert.equal(earlyCycleAllowed([NOW - 60_000], NOW, env), false);
    assert.equal(earlyCycleAllowed([NOW - 91_000], NOW, env), true);
    assert.equal(earlyCycleAllowed(Array.from({ length: 12 }, (_, i) => NOW - (i + 2) * 120_000), NOW, env), false, "twelve in the hour");
    assert.equal(earlyCycleAllowed(Array.from({ length: 12 }, (_, i) => NOW - 3_700_000 - i * 1000), NOW, env), true, "older than an hour do not count");
    assert.equal(earlyCycleAllowed([], NOW, fastEnv({ FAST_WATCH_SEC: "0" })), false);
  });

  await test("fastTrigger idle-due: a band out on the quote side wakes the cycle once its idle wait has run out since the last cycle, and only once", () => {
    const out: WatchedBand = { ...baton, inRange: false, outSince: NOW - 130_000, idleWaitSec: 120, observedAt: NOW - 100_000 };
    const above = { bin: -330, asOf: NOW - 5_000 }; // above a Y-quoted band: idle, all SOL
    const t = fastTrigger(out, above, NOW, env)!;
    assert.equal(t.kind, "idle-due");
    assert.match(t.detail, /idle 130s above band \[-337, -333\], past the 120s wait/);
    assert.equal(fastTrigger({ ...out, outSince: NOW - 90_000 }, above, NOW, env), null, "the wait has not run out");
    assert.equal(fastTrigger({ ...out, observedAt: NOW - 5_000 }, above, NOW, env), null, "a cycle has already looked since the wait ran out: nothing owed");
    assert.equal(fastTrigger({ ...out, idleWaitSec: 0 }, above, NOW, env), null, "no idle wait configured: the scheduled cycle decides");
    assert.equal(fastTrigger(out, { bin: -340, asOf: NOW - 5_000 }, NOW, env)?.kind, undefined, "below the band is the token side: the stop-near rule, not this one");
    assert.equal(fastTrigger(out, { bin: -335, asOf: NOW - 5_000 }, NOW, env), null, "back inside the band: nothing to wake for");
  });

  await test("laidBandWatch: a band opened or re-laid this cycle is watched from the open's own geometry at once, not from the next scheduled cycle", () => {
    // TACZ on 18 Sep: re-laid over [-380, -362] at 1% a bin with a 12.46% stop, unwatched 356 s while the price went four bins through its bottom
    const tacz = laidBandWatch({ pool: "TACZ", label: "TACZ/SOL", position: "NEW", activeBinId: -362, binsBelowActive: 18, binsAboveActive: 0, quoteSide: "Y", binStep: 100, stopPct: 12.46, entrySol: 44, idleWaitSec: 0, now: NOW });
    assert.deepEqual([tacz.lowerBinId, tacz.upperBinId, tacz.inRange, tacz.drawdownPct, tacz.outSince, tacz.observedAt, tacz.ask], [-380, -362, true, 0, null, NOW, undefined]);
    // the first swap under its bottom starts the cycle (left-band), and deeper in, near the stop, it is stop-near
    assert.equal(fastTrigger(tacz, { bin: -381, asOf: NOW + 20_000 }, NOW + 25_000, env)!.kind, "left-band");
    const deep = fastTrigger(tacz, { bin: -383, asOf: NOW + 20_000 }, NOW + 25_000, env)!;
    assert.equal(deep.kind, "stop-near");
    assert.match(deep.detail, /12 bins past the middle of band \[-380, -362\]: about 11\.3% down against a 12\.5% stop/);
    assert.equal(fastTrigger(tacz, { bin: -370, asOf: NOW + 20_000 }, NOW + 25_000, env), null, "inside the band: nothing");
    // a quote-X band sits from the price up; a straddle spans both sides
    const xq = laidBandWatch({ pool: "P", label: "P", position: "N", activeBinId: 100, binsBelowActive: 0, binsAboveActive: 10, quoteSide: "X", binStep: 20, stopPct: 15, entrySol: 1, idleWaitSec: 0, now: NOW });
    assert.deepEqual([xq.lowerBinId, xq.upperBinId], [100, 110]);
    const straddle = laidBandWatch({ pool: "P", label: "P", position: "N", activeBinId: 100, binsBelowActive: 7, binsAboveActive: 7, quoteSide: "Y", binStep: 10, stopPct: 15, entrySol: 1, idleWaitSec: 0, now: NOW });
    assert.deepEqual([straddle.lowerBinId, straddle.upperBinId], [93, 107]);
    // an ask band carries the chain's basis: its drawdown is the chain's, and its loss is read from the bin it was laid at
    const ask = laidBandWatch({ pool: "A", label: "A", position: "ASK", activeBinId: -300, binsBelowActive: 0, binsAboveActive: 3, quoteSide: "Y", binStep: 100, stopPct: 10, entrySol: 9.5, askBasisSol: 10, idleWaitSec: 0, now: NOW });
    assert.equal(ask.ask, true);
    assert.equal(ask.markBinId, -300);
    assert.ok(Math.abs(ask.drawdownPct - 5) < 1e-9);
  });

  await test("sizeUnderCap: the sale is sized to what the market takes under the cap by quoting, never cut into pieces; the caps from the env; a residue's cap rises as it waits", async () => {
    // a bin ladder where impact grows a little faster than size: 13,064 GP quotes 5.78% whole (the sweep of 18 Sep)
    const ladder = (amount: number) => Promise.resolve(5.78 * Math.pow(amount / 13064, 1.15));
    const s = await sizeUnderCap(13064, 1.5, 6, ladder);
    assert.ok(s.amount > 2500 && s.amount < 3500, `about a quarter of the sale fits under 1.5%: ${s.amount}`);
    assert.ok(s.impactPct <= 1.5 && s.quotes <= 3, `${s.impactPct}% in ${s.quotes} quotes`);
    assert.deepEqual(await sizeUnderCap(13064, 1.5, 6, () => Promise.resolve(1.2)), { amount: 13064, impactPct: 1.2, quotes: 1 }, "under the cap: the whole sale, one quote");
    assert.deepEqual(await sizeUnderCap(13064, 0, 6, () => Promise.resolve(40)), { amount: 13064, impactPct: 40, quotes: 1 }, "no cap: the whole sale");
    assert.deepEqual(await sizeUnderCap(13064, 1.5, 6, () => Promise.resolve(0)), { amount: 13064, impactPct: 0, quotes: 1 }, "an unmeasured route counts as under the cap");
    const wall = await sizeUnderCap(100, 1.5, 6, () => Promise.resolve(30));
    assert.equal(wall.amount, 0, "when even the third, smaller quote is over the cap nothing is sold");
    assert.equal(wall.quotes, 3);
    assert.deepEqual(await sizeUnderCap(0, 1.5, 6, () => Promise.reject(new Error("never asked"))), { amount: 0, impactPct: 0, quotes: 0 });
    assert.deepEqual(swapImpactEnv({}), { sweepPct: 1.5, exitPct: 3, hardPct: 8, residueCycles: 4 }, "the defaults");
    assert.deepEqual(swapImpactEnv({ SWAP_IMPACT_SWEEP_PCT: "1", SWAP_IMPACT_EXIT_PCT: "2", SWAP_IMPACT_HARD_PCT: "1", SWAP_RESIDUE_CYCLES: "2" }), { sweepPct: 1, exitPct: 2, hardPct: 2, residueCycles: 2 }, "the hard cap is never under the exit cap");
    assert.deepEqual(swapImpactEnv({ SWAP_IMPACT_EXIT_PCT: "0" }), { sweepPct: 1.5, exitPct: 0, hardPct: 0, residueCycles: 4 }, "an exit cap of 0 means exits are uncapped, hard cap and all");
    assert.equal(swapImpactEnv({ SWAP_IMPACT_SWEEP_PCT: "0", SWAP_IMPACT_EXIT_PCT: "0" }), null, "both caps 0: the old single swap");
    const caps = swapImpactEnv({})!;
    assert.deepEqual([0, 3, 4, 7, 8, 20].map((c) => residueCapPct(caps, c)), [3, 3, 8, 8, 8, 8], "exit cap for four attempts, then the hard cap for as long as it takes; never any price");
    assert.equal(residueCapPct({ ...caps, exitPct: 0, hardPct: 0 }, 0), 0);
  });

  await test("sweepAmount: everything held once it is worth the minimum in the quote; dust and the unpriced are left", () => {
    assert.equal(sweepAmount(3775.85, 0.000181638, 0.05), 3775.85, "0.69 SOL of ALLINU: sold");
    assert.equal(sweepAmount(200, 0.000181638, 0.05), 0, "0.036 SOL: under the minimum, waits for the next claim");
    assert.equal(sweepAmount(0, 1, 0.05), 0);
    assert.equal(sweepAmount(100, 0, 0.05), 0, "no price, no sale");
    assert.equal(sweepAmount(1e-7, 1_000_000, 0.05), 0, "dust by units");
  });

  await test("adviseWithPolicy: the model may hold, claim and close as it likes; to put money to work it needs the policy's entry rules, and takes the policy's sizing", () => {
    const open = { side: "SOL_ONLY" as const, amountSol: 15, amountToken: 0, binsBelowActive: 3, binsAboveActive: 0, strategy: "Spot" as const };
    const model = (action: Decision["action"], over: Partial<Decision> = {}): Decision => ({ action, open: action === "OPEN_POSITION" ? open : null, positionAddress: null, reasoning: "the model's case", confidence: 0.8, headline: "model headline", ...over });
    const policyOpen: PolicyResult = { decision: { action: "OPEN_POSITION", open: { ...open, amountSol: 4.2, binsBelowActive: 20 }, positionAddress: null, reasoning: "r", confidence: 0.6, headline: "h" }, reason: "open 4.2 SOL across 21 bins", branch: "open" };
    const policyWait: PolicyResult = { decision: { action: "HOLD", open: null, positionAddress: null, reasoning: "r", confidence: 0.5, headline: "h" }, reason: "the scout's reading covers 18 min < 60 (POLICY_MIN_FLOW_COVER_MIN)", branch: "flow-wait" };
    const taken = adviseWithPolicy(model("OPEN_POSITION"), policyOpen);
    assert.equal(taken.decision.action, "OPEN_POSITION");
    assert.deepEqual([taken.decision.open!.amountSol, taken.decision.open!.binsBelowActive], [4.2, 20], "the policy's size and width, not the model's 15 SOL in 4 bins");
    assert.match(taken.decision.reasoning, /^the model's case Sized by the desk policy: open 4\.2 SOL across 21 bins\.$/);
    assert.equal(taken.decision.headline, "model headline");
    const refused = adviseWithPolicy(model("OPEN_POSITION"), policyWait);
    assert.equal(refused.decision.action, "HOLD");
    assert.equal(refused.decision.headline, "Model wanted in. The entry rules say no. Holding.");
    assert.match(refused.note!, /refused by the desk policy's entry rules \(flow-wait\): the scout's reading covers 18 min/);
    assert.equal(adviseWithPolicy(model("REBALANCE", { open, positionAddress: "POS" }), policyWait).decision.action, "HOLD");
    for (const a of ["HOLD", "CLOSE_POSITION", "CLAIM_FEES"] as const) assert.equal(adviseWithPolicy(model(a), policyWait).decision.action, a, `${a} passes as it is`);
    assert.equal(modelAdvises({}), true);
    assert.equal(modelAdvises({ MODEL_ADVISES: "false" }), false);
  });

  console.log(`\n${passed} fast watch tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
