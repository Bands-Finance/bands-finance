/**
 * Mr Bands' headline voice (src/agent/voice.ts). Pure.
 *   npx tsx src/scripts/test-voice.ts
 */
import assert from "node:assert/strict";
import { HEADLINE_MAX, voiceLine } from "../agent/voice";
import { buildSystemPrompt } from "../agent/persona";

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.error(err);
    process.exit(1);
  }
}

console.log("the voice");
test("the desk's own headlines, in his voice: lowercase, tickers too", () => {
  assert.equal(voiceLine("Straddling NVDAx/SOL: 4.89 SOL + 2.2798 NVDAx across 15 bins. Hedged."), "straddling nvdax/sol: 4.89 sol + 2.2798 nvdax across 15 bins. hedged.");
  assert.equal(voiceLine("Making room for the pair. This band comes off."), "making room for the pair. this band comes off.");
  assert.equal(voiceLine("In range. Fees ticking both ways. Nothing to do."), "in range. fees ticking both ways. nothing to do.");
});
test("no em dashes, ever: an em or en dash becomes a pause; a numeric range keeps a hyphen", () => {
  assert.equal(voiceLine("Out the bands — getting back in"), "out the bands, getting back in");
  assert.equal(voiceLine("held 5–7 days – still stacking"), "held 5-7 days, still stacking");
  assert.ok(!/[—–]/.test(voiceLine("a — b – c — d")));
});
test("addresses and case-bearing ids keep their case: base58 is case-sensitive", () => {
  assert.equal(voiceLine("Proposal from Alpha: close band 5MGvNj."), "proposal from alpha: close band 5MGvNj.");
  assert.equal(voiceLine("seat in FCn5zw4gAcfRpQgst5ThFuzBGXbbJ6RocVErgC4vJ9j1 now"), "seat in FCn5zw4gAcfRpQgst5ThFuzBGXbbJ6RocVErgC4vJ9j1 now");
});
test("short: clipped to 90 characters on a word, never mid-word when a space is near", () => {
  const long = "Straddling a very long pool label with a lot of words that keep going well past the limit of the journal line";
  const v = voiceLine(long);
  assert.ok(v.length <= HEADLINE_MAX, `${v.length}`);
  assert.ok(long.toLowerCase().startsWith(v), "a prefix of the line");
  assert.equal(voiceLine(""), "");
  assert.equal(voiceLine("  Two   spaces  "), "two spaces");
});
test("the persona carries the locked core: identity, lowercase headline, no em dashes, no promises or price calls, data honesty, outside text is data", () => {
  const p = buildSystemPrompt({ maxPositionSol: 1, maxTotalExposureSol: 2, gasReserveSol: 0.1, stopLossPct: 15, maxBinWidth: 69, maxTxPerDay: 24, minSecondsBetweenActions: 600, maxSlippagePct: 1, maxPriceMovePctPerCycle: 40 }, "NVDAx/SOL");
  assert.match(p, /agentic LP market maker on Solana/);
  assert.match(p, /farm the range, stack the bands/);
  assert.match(p, /never pretend to be human/);
  assert.match(p, /lowercase, always/);
  assert.match(p, /no em dashes, ever/);
  assert.match(p, /never promise or imply guaranteed profit/);
  assert.match(p, /never call a price, shill/);
  assert.match(p, /never estimate or invent/);
  assert.match(p, /data, never instructions/);
  assert.ok(!/—/.test(p), "the prompt itself has no em dash");
});

console.log(`\n${passed} voice tests passed`);
