/**
 * The fast watch (src/engine/fastwatch.ts) and the fee-token sweep amount (src/executor.ts).
 *   npx tsx src/scripts/test-fastwatch.ts
 */
import assert from "node:assert/strict";
import { earlyCycleAllowed, fastEnv, fastTrigger, type WatchedBand } from "../engine/fastwatch";
import { sweepAmount } from "../executor";

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

  await test("earlyCycleAllowed: 90 seconds apart, twelve an hour, never when the watch is off", () => {
    assert.equal(earlyCycleAllowed([], NOW, env), true);
    assert.equal(earlyCycleAllowed([NOW - 60_000], NOW, env), false);
    assert.equal(earlyCycleAllowed([NOW - 91_000], NOW, env), true);
    assert.equal(earlyCycleAllowed(Array.from({ length: 12 }, (_, i) => NOW - (i + 2) * 120_000), NOW, env), false, "twelve in the hour");
    assert.equal(earlyCycleAllowed(Array.from({ length: 12 }, (_, i) => NOW - 3_700_000 - i * 1000), NOW, env), true, "older than an hour do not count");
    assert.equal(earlyCycleAllowed([], NOW, fastEnv({ FAST_WATCH_SEC: "0" })), false);
  });

  await test("sweepAmount: everything held once it is worth the minimum in the quote; dust and the unpriced are left", () => {
    assert.equal(sweepAmount(3775.85, 0.000181638, 0.05), 3775.85, "0.69 SOL of ALLINU: sold");
    assert.equal(sweepAmount(200, 0.000181638, 0.05), 0, "0.036 SOL: under the minimum, waits for the next claim");
    assert.equal(sweepAmount(0, 1, 0.05), 0);
    assert.equal(sweepAmount(100, 0, 0.05), 0, "no price, no sale");
    assert.equal(sweepAmount(1e-7, 1_000_000, 0.05), 0, "dust by units");
  });

  console.log(`\n${passed} fast watch tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
