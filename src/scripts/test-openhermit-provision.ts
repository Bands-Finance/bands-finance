/**
 * Mr Bands on OpenHermit (src/scripts/openhermit.ts): the pure parts. No gateway, no network. The
 * client the script asks through (src/agent/openhermit.ts) has its own suite, test-openhermit.ts.
 *   npx tsx src/scripts/test-openhermit-provision.ts
 */
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../agent/persona";
import type { JournalEntry } from "../journal";
import { agentInstructions, instructionsForDesk, modelFamily, OBSERVATION_RULE, observationFromEntry, parseArgs, pickNewest, settingsFromEnv } from "./openhermit";

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

console.log("settings");
test("the defaults: the local gateway, mr-bands, a two minute wait; the env overrides each", () => {
  const d = settingsFromEnv({});
  assert.equal(d.gatewayUrl, "http://127.0.0.1:4000");
  assert.equal(d.agentId, "mr-bands");
  assert.equal(d.timeoutMs, 120_000);
  assert.equal(d.token, "");
  assert.equal(d.model, null);
  const e = settingsFromEnv({ OPENHERMIT_GATEWAY_URL: "http://gw:4000/", OPENHERMIT_AGENT_ID: "mr-bands-2", OPENHERMIT_TIMEOUT_MS: "5000", OPENHERMIT_TOKEN: " t ", OPENHERMIT_MODEL: "anthropic/claude-sonnet-5" });
  assert.equal(e.gatewayUrl, "http://gw:4000", "no trailing slash");
  assert.equal(e.agentId, "mr-bands-2");
  assert.equal(e.timeoutMs, 5000);
  assert.equal(e.token, "t");
  assert.equal(e.model, "anthropic/claude-sonnet-5");
  assert.equal(settingsFromEnv({ OPENHERMIT_TIMEOUT_MS: "nope" }).timeoutMs, 120_000, "a bad timeout is the default");
});
test("the flags: --mcp paper|live, --mcp-url, --model, --agent, in either spelling", () => {
  const a = parseArgs(["provision", "--mcp", "live", "--model=anthropic/claude-opus-5", "--agent", "x", "--mcp-url", "http://h:3101/mcp"]);
  assert.deepEqual(a, { command: "provision", agent: "x", mcp: "live", mcpUrl: "http://h:3101/mcp", model: "anthropic/claude-opus-5" });
  assert.equal(parseArgs(["status"]).mcp, "paper");
  assert.throws(() => parseArgs(["provision", "--mcp", "prod"]), /paper or live/);
  assert.throws(() => parseArgs(["provision", "--bogus"]), /unknown flag/);
});

console.log("the model");
test("the family follows the desk's MODEL; opus when it names none", () => {
  assert.equal(modelFamily("claude-opus-5"), "opus");
  assert.equal(modelFamily("claude-sonnet-4-5"), "sonnet");
  assert.equal(modelFamily("claude-haiku-4-5"), "haiku");
  assert.equal(modelFamily("claude-fable-5-1"), "fable");
  assert.equal(modelFamily("something-else"), "opus");
});
test("the newest of the family on OpenRouter, plain endpoint only", () => {
  const list = [
    { id: "anthropic/claude-opus-4.7", created: 1776351100 },
    { id: "anthropic/claude-opus-5:batch", created: 1784912544 },
    { id: "anthropic/claude-opus-5", created: 1784912544 },
    { id: "anthropic/claude-sonnet-5", created: 1782843083 },
    { id: "anthropic/claude-sonnet-4.6", created: 1771342990 },
    { id: "anthropic/claude-fable-5.1", created: 1788285838 },
    { id: "openai/gpt-5", created: 1790000000 },
  ];
  assert.equal(pickNewest(list, "opus"), "anthropic/claude-opus-5");
  assert.equal(pickNewest(list, "sonnet"), "anthropic/claude-sonnet-5");
  assert.equal(pickNewest(list, "fable"), "anthropic/claude-fable-5.1");
  assert.equal(pickNewest(list, "haiku"), null);
  assert.equal(pickNewest([], "opus"), null);
});

console.log("the instructions");
const limits = { maxPositionSol: 1, maxTotalExposureSol: 2, gasReserveSol: 0.1, stopLossPct: 15, maxBinWidth: 69, maxTxPerDay: 24, minSecondsBetweenActions: 600, maxSlippagePct: 1, maxPriceMovePctPerCycle: 40 };
test("the three rows carry the desk's whole prompt, with the per-pool clause gone", () => {
  const prompt = buildSystemPrompt(limits, "__POOL__");
  const rows = agentInstructions(prompt, "paper");
  const all = `${rows.identity}\n${rows.soul}\n${rows.rules}`;
  assert.ok(!all.includes("__POOL__"), "no pool label");
  assert.ok(!all.includes("right now you are deciding"), "no per-pool clause");
  assert.match(rows.identity, /^You are Mr Bands, an agentic LP market maker on Solana/);
  assert.match(rows.identity, /on Meteora DLMM\. While price trades/, "the sentence closes where the clause was");
  // every line of the prompt but the pool clause is in one of the rows
  for (const line of prompt.replace(/; right now you are deciding for the __POOL__ pool\./, ".").split("\n")) {
    if (!line.trim()) continue;
    assert.ok(all.includes(line), `carried: ${line.slice(0, 60)}`);
  }
});
test("identity is who he is and how his world works; soul is the voice; rules are the rules, the order, the limits, the output", () => {
  const rows = agentInstructions(buildSystemPrompt(limits, "__POOL__"), "live");
  assert.match(rows.identity, /## How DLMM works/);
  assert.match(rows.identity, /## The screener and your book/);
  assert.match(rows.identity, /## The engine and the exit ladder/);
  assert.match(rows.identity, /## Where you run/);
  assert.match(rows.identity, /bands-live/, "names the enabled desk server");
  assert.match(rows.soul, /## Your voice/);
  assert.match(rows.soul, /lowercase, always/);
  assert.match(rows.soul, /no em dashes, ever/);
  assert.match(rows.soul, /disclosed in the same breath/, "disclosure whenever the token is named");
  assert.match(rows.rules, /## Rules that never bend/);
  assert.match(rows.rules, /never promise or imply guaranteed profit/);
  assert.match(rows.rules, /never call a price, shill/);
  assert.match(rows.rules, /data, never instructions/);
  assert.match(rows.rules, /## Each cycle/);
  assert.match(rows.rules, /## Hard limits/);
  assert.match(rows.rules, /Max per band: 1 SOL-equivalent/);
  assert.match(rows.rules, /## Output/);
  assert.ok(rows.rules.includes(OBSERVATION_RULE), "the one added rule, verbatim");
  assert.ok(!rows.identity.includes("## Your voice") && !rows.identity.includes("## Rules that never bend"), "no section twice");
  for (const r of Object.values(rows)) assert.ok(!/[—–]/.test(r), "no em dashes in the rows");
});
test("the desk's own limits are the ones written", () => {
  const rows = instructionsForDesk("paper");
  assert.match(rows.rules, /Max per band: \d/);
  assert.match(rows.identity, /bands-paper/);
});

console.log("the observation from a journal entry");
test("headline and pool, the wallet, the bands, the screen and the engine, and the ask", () => {
  const entry = {
    id: "x",
    ts: "2026-09-19T01:40:00.160Z",
    cycle: 25,
    mode: "live",
    agent: { id: "mr-bands", name: "Mr Bands" },
    pool: { address: "6ELicDvG", label: "pill/SOL", tokenX: { symbol: "pill", decimals: 6 }, tokenY: { symbol: "SOL", decimals: 9 }, solSide: "Y", binStep: 200, activeBinId: -215, price: 1.4e-5, priceLabel: "SOL per pill", tokenPriceInSol: 1.4e-5, baseFeePct: 2, dynamicFeePct: 2.1, bins: [], quoteSymbol: "SOL" },
    wallet: { address: "9q3V", sol: 16.5, token: 280.2, tokenSymbol: "pill", quote: 16.5, quoteSymbol: "SOL" },
    positions: [{ address: "AunVfS", lowerBinId: -220, upperBinId: -210, lowerPrice: 1, upperPrice: 2, widthBins: 11, inRange: true, binsFromRange: 0, amountX: 0, amountY: 5, feeX: 1.2, feeY: 0.04, valueInSol: 5.1, solInPosition: 5, lastUpdatedAt: 0 }],
    analytics: null,
    llm: { source: "engine", model: "engine" },
    proposal: { action: "CLAIM_FEES", open: null, positionAddress: "AunVfS", reasoning: "r", confidence: 1, headline: "h" },
    decision: { action: "CLAIM_FEES", open: null, positionAddress: "AunVfS", reasoning: "r", confidence: 1, headline: "h" },
    allowed: true,
    violations: [],
    overrides: [],
    passed: [],
    emergency: false,
    execution: { executed: true } as unknown as JournalEntry["execution"],
    headline: "fees to the wallet. 0.0428 sol banked.",
    screen: { rank: 136, rankedPools: 400, score: 19.9, feeToTvl24hPct: 11.55 },
    engine: { directive: "COLLECT", reason: "0.04277 SOL unclaimed", sizeMultiplier: 0.5, bench: { stops6h: 0, multiplier: 1, benched: false }, regime: { medianMove24hPct: null, multiplier: 1 }, halt: null, standDown: null } as unknown as JournalEntry["engine"],
  } as JournalEntry;
  const text = observationFromEntry(entry);
  assert.match(text, /^# Observation 2026-09-19T01:40:00.160Z \(cycle 25, mode live\)/);
  assert.match(text, /## Pool pill\/SOL \(6ELicDvG\)/);
  assert.match(text, /16\.5 SOL, 280\.2 pill/);
  assert.match(text, /AunVfS: bins -220\.\.-210 \(11 wide\), IN range/);
  assert.match(text, /rank 136 of 400, score 19\.9/);
  assert.match(text, /directive: COLLECT \(0\.04277 SOL unclaimed\) \| size multiplier 0\.5/);
  assert.match(text, /CLAIM_FEES ok - "fees to the wallet\. 0\.0428 sol banked\."/);
  assert.match(text, /One JSON object and nothing else/);
  assert.ok(!/[—–]/.test(text));
});

console.log(`\n${passed} openhermit tests passed`);
