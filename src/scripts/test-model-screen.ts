/**
 * The model screen and the day's model-call cap (src/agent/decide.ts screenDecision, spendModelCall), against
 * a fake OpenHermit gateway on a local port. The real gateway is never called.
 *   - a screened branch (in-range; the gated holds: gated, no-size, flagged, not-worth) never reaches the gateway,
 *     and journals source "screen"
 *   - an unscreened branch (no band and a hot pick, a band out of range) does, as before
 *   - the cap refuses the 201st call, counted on disk so a restart cannot reset it; a new UTC day starts at 0
 *   - a gateway failure still falls to the desk policy, and the call still counts
 *   - engine directives are unchanged: no model, no screen, no spend
 *   npx tsx src/scripts/test-model-screen.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Observation } from "../agent/observation";
import type { PoolSnapshot, PositionSnapshot } from "../tools/dlmm";

// Everything that reads src/config.ts is imported after the environment is pinned.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mrbands-model-screen-"));
process.env.DATA_DIR = TMP;
process.env.ANTHROPIC_API_KEY = "";
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.MODEL_CALLS_PER_DAY;
delete process.env.MODEL_ADVISES;
delete process.env.KILL_SWITCH;
process.env.DRY_RUN = "true";
process.env.WALLET_SECRET_KEY = "";
process.env.DECIDER = "openhermit";
process.env.OPENHERMIT_TOKEN = "test-admin-token";
process.env.OPENHERMIT_AGENT_ID = "mr-bands-test";
process.env.OPENHERMIT_TIMEOUT_MS = "2000";

const POOL = "6e7V9eegCHw997T72MxgwwJipZ6GJyZF8NvjkzT1rvpN";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const ANSEM = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";
const T0 = Date.parse("2026-09-21T12:00:00.000Z");

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

/** The gateway: opens any session, answers every message with `answer`; `posts` counts the questions actually asked. */
interface FakeGateway {
  url: string;
  posts: number;
  answer: (text: string) => { status: number; body?: unknown };
  close: () => Promise<void>;
}
function startGateway(): Promise<FakeGateway> {
  const gw: FakeGateway = { url: "", posts: 0, answer: () => ({ status: 500 }), close: async () => {} };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      let r: { status: number; body?: unknown };
      if (req.headers.authorization !== "Bearer test-admin-token") r = { status: 401, body: { error: { code: "unauthorized", message: "no" } } };
      else if (req.url === "/api/agents/mr-bands-test/sessions") r = { status: 200, body: { sessionId: body.sessionId, source: body.source } };
      else if (/\/messages/.test(req.url ?? "")) {
        gw.posts++;
        r = gw.answer(String(body.text ?? ""));
      } else r = { status: 404, body: { error: { code: "not_found", message: "no such route" } } };
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(r.body === undefined ? "" : JSON.stringify(r.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      gw.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      gw.close = () => new Promise((r) => server.close(() => r()));
      resolve(gw);
    });
  });
}

const HOLD = { action: "HOLD", open: null, positionAddress: null, reasoning: "Nothing worth doing.", confidence: 0.8, headline: "Holding." };
/** A HOLD stamped with the cycle the prompt asked about. */
const holdReply = (text: string) => {
  const cycle = Number((text.match(/This is cycle (\d+)/) ?? [])[1]);
  return { status: 200, body: { sessionId: "s", messageId: "m", text: JSON.stringify({ ...HOLD, cycle }), toolCalls: [] } };
};

async function main(): Promise<void> {
  const { binPriceUi } = await import("../tools/dlmm.js");
  const d = await import("../agent/decide.js");
  const { policyDecide } = await import("../agent/policy.js");
  const { riskLimits } = await import("../config.js");
  const oh = await import("../agent/openhermit.js");
  const p = (bin: number) => binPriceUi(bin, 20, 6, 9);

  function snapAt(active: number): PoolSnapshot {
    const bins = [];
    for (let b = active - 10; b <= active + 10; b++) bins.push({ binId: b, price: p(b), xAmount: b > active ? 5000 : 0, yAmount: b < active ? 9 : b === active ? 1 : 0, isActive: b === active });
    const sol = { mint: SOL_MINT, symbol: "SOL", decimals: 9, reserve: 5000 };
    const ansem = { mint: ANSEM, symbol: "ANSEM", decimals: 6, reserve: 5_000_000 };
    return {
      address: POOL, label: "ANSEM/SOL", tokenX: ansem, tokenY: sol, solSide: "Y", baseToken: ansem, binStep: 20, activeBinId: active, activePrice: p(active),
      priceLabel: "SOL per ANSEM", tokenPriceInSol: p(active), quoteSide: "Y", quoteToken: sol, quoteSymbol: "SOL", quotePriceInSol: 1, tokenPriceInQuote: p(active),
      solPriceUsd: 100, baseFeePct: 0.2, maxFeePct: 10, dynamicFeePct: 0.2, bins, liquidityBelowY: 90, liquidityAboveX: 50_000, fetchedAt: new Date(T0).toISOString(),
    };
  }
  const band = (lower: number, upper: number, active: number): PositionSnapshot => {
    const inRange = active >= lower && active <= upper;
    return {
      address: "BandAddr1111111111111111111111111111111111", lowerBinId: lower, upperBinId: upper, lowerPrice: p(lower), upperPrice: p(upper), widthBins: upper - lower + 1,
      inRange, binsFromRange: inRange ? 0 : active < lower ? active - lower : active - upper, amountX: 0, amountY: 2, feeX: 0, feeY: 0.001, valueInSol: 2, solInPosition: 2, lastUpdatedAt: T0,
    };
  };
  let cycle = 100;
  const obs = (over: Partial<Observation> = {}): Observation => ({
    ts: new Date(T0).toISOString(),
    cycle: ++cycle,
    mode: "dry-run",
    poolLabel: "ANSEM/SOL",
    snapshot: snapAt(260),
    positions: [],
    wallet: { address: "wallet", sol: 100, token: 0, tokenSymbol: "ANSEM", quote: 100, quoteSymbol: "SOL" },
    analytics: null,
    state: { actionsToday: 0, lastActionAt: null, lastPrice: null, killSwitch: false },
    recent: [],
    screen: null,
    portfolio: { activePools: ["ANSEM/SOL"], poolsWithBands: 0, maxActivePools: 3, otherExposureSol: 0 },
    engine: null,
    ...over,
  });
  const branchOf = (o: Observation) => policyDecide(o, { limits: riskLimits }).branch;
  const budgetFile = d.modelBudgetFile();
  const clearBudget = () => fs.rmSync(budgetFile, { force: true });

  const gw = await startGateway();
  process.env.OPENHERMIT_GATEWAY_URL = gw.url;
  gw.answer = holdReply;

  // the fixtures, and the branch each one lands on in the desk policy (asserted, so a policy change that moves them is seen)
  const inRange = () => obs({ positions: [band(250, 270, 260)], portfolio: { activePools: ["ANSEM/SOL"], poolsWithBands: 1, maxActivePools: 3, otherExposureSol: 0 } });
  const killed = () => obs({ state: { actionsToday: 0, lastActionAt: null, lastPrice: null, killSwitch: true } });
  const bookFull = () => obs({ portfolio: { activePools: ["ANSEM/SOL", "A", "B"], poolsWithBands: 3, maxActivePools: 3, otherExposureSol: 6 } });
  /** the board's row for this pool, as the paper tests draw it: score 30, a million a day, no flags */
  const board = (over: Record<string, unknown> = {}) => ({ rank: 5, rankedPools: 300, score: 30, feeToTvl24hPct: 2.3, volume24hUsd: 1_000_000, tvlUsd: 250_000, ageHours: 100, priceChange24hPct: 3, flags: [], generatedAt: new Date(T0).toISOString(), alternatives: [], hot: [], ...over }) as unknown as Observation["screen"];
  const offBoard = () => obs();
  const flaggedPool = () => obs({ screen: board({ flags: ["dumping"] }) });
  const broke = () => obs({ screen: board(), wallet: { address: "wallet", sol: 0.02, token: 0, tokenSymbol: "ANSEM", quote: 0.02, quoteSymbol: "SOL" } });
  /** no band, a pool on the board worth a seat: the policy opens (or waits on the scout); either way the model is asked */
  const noBand = () => obs({ screen: board({ feeToTvl24hPct: 40, volume24hUsd: 20_000_000 }) });
  const outOfRange = () => obs({ positions: [band(280, 300, 260)], portfolio: { activePools: ["ANSEM/SOL"], poolsWithBands: 1, maxActivePools: 3, otherExposureSol: 0 } });

  console.log("the screen");
  await test("the fixtures land where they say: in-range, gated (kill switch, book full), not-worth, flagged, no-size; the unscreened ones do not", () => {
    assert.equal(branchOf(inRange()), "in-range");
    assert.equal(branchOf(killed()), "gated");
    assert.equal(branchOf(bookFull()), "gated");
    assert.equal(branchOf(offBoard()), "not-worth");
    assert.equal(branchOf(flaggedPool()), "flagged");
    assert.equal(branchOf(broke()), "no-size");
    assert.ok(!d.SCREENED_BRANCHES.includes(branchOf(noBand())), `no band, clear to open: ${branchOf(noBand())} ${policyDecide(noBand(), { limits: riskLimits }).reason}`);
    assert.ok(!d.SCREENED_BRANCHES.includes(branchOf(outOfRange())), `out of range: ${branchOf(outOfRange())}`);
    console.log(`      (unscreened fixtures: no band -> ${branchOf(noBand())}, out of range -> ${branchOf(outOfRange())})`);
    assert.deepEqual([...d.SCREENED_BRANCHES], ["in-range", "gated", "no-size", "flagged", "not-worth"]);
  });
  for (const [name, make] of [
    ["an in-range hold", inRange],
    ["a gated hold (kill switch)", killed],
    ["a gated hold (book full)", bookFull],
    ["a gated hold (not-worth: off the board)", offBoard],
    ["a gated hold (flagged)", flaggedPool],
    ["a gated hold (no-size: no room for a seat)", broke],
  ] as const) {
    await test(`${name}: the gateway is never called; source screen, model desk-policy, the policy's own HOLD, a note naming the branch; nothing spent`, async () => {
      clearBudget();
      const before = gw.posts;
      const o = make();
      const r = await d.decide(o);
      assert.equal(gw.posts, before, "the model was asked");
      assert.equal(r.source, "screen");
      assert.equal(r.model, "desk-policy");
      assert.equal(r.decision.action, "HOLD");
      assert.deepEqual(r.decision, policyDecide(o, { limits: riskLimits }).decision, "the screen answers exactly what the policy answers");
      assert.match(r.note ?? "", new RegExp(`Screened \\((${branchOf(o)})`));
      assert.match(r.note ?? "", /The model was not asked/);
      assert.equal(r.usage, undefined);
      assert.equal(d.modelBudget(T0).used, 0, "a screened hold spends nothing");
    });
  }
  for (const [name, make] of [["no band, a pool worth a seat", noBand], ["a band out of range", outOfRange]] as const) {
    await test(`${name}: reaches the gateway as before (source llm) and spends one call`, async () => {
      clearBudget();
      const before = gw.posts;
      const r = await d.decide(make());
      assert.equal(gw.posts, before + 1);
      assert.equal(r.source, "llm");
      assert.equal(r.model, "openhermit:mr-bands-test");
      assert.equal(r.decision.action, "HOLD");
      assert.equal(d.modelBudget().used, 1);
    });
  }
  await test("a screened pool is screened on the anthropic backend too (with a key, the in-range hold never reaches the API)", async () => {
    process.env.DECIDER = "anthropic";
    process.env.ANTHROPIC_AUTH_TOKEN = "never-used";
    try {
      const r = await d.decide(inRange());
      assert.equal(r.source, "screen");
      const g = await d.decide(killed());
      assert.equal(g.source, "screen");
    } finally {
      process.env.DECIDER = "openhermit";
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });
  await test("DECIDER=policy is unchanged: the policy proposes (source policy), no screen, nothing spent", async () => {
    clearBudget();
    process.env.DECIDER = "policy";
    try {
      const r = await d.decide(inRange());
      assert.equal(r.source, "policy");
      assert.equal(d.modelBudget().used, 0);
    } finally {
      process.env.DECIDER = "openhermit";
    }
  });

  console.log("the cap");
  await test("modelCallCap: default 200; a whole number applies up to the 500 ceiling; above it is 500; garbage is the default", () => {
    assert.equal(d.modelCallCap({}), 200);
    assert.equal(d.modelCallCap({ MODEL_CALLS_PER_DAY: "50" }), 50);
    assert.equal(d.modelCallCap({ MODEL_CALLS_PER_DAY: " 0 " }), 0);
    assert.equal(d.modelCallCap({ MODEL_CALLS_PER_DAY: "500" }), 500);
    assert.equal(d.modelCallCap({ MODEL_CALLS_PER_DAY: "5000" }), 500);
    assert.equal(d.modelCallCap({ MODEL_CALLS_PER_DAY: "1e9" }), 200);
    assert.equal(d.modelCallCap({ MODEL_CALLS_PER_DAY: "-5" }), 200);
    assert.equal(d.modelCallCap({ MODEL_CALLS_PER_DAY: "lots" }), 200);
  });
  await test("200 calls reach the gateway; the 201st is refused with the note, the gateway not called, the policy proposes", async () => {
    clearBudget();
    const before = gw.posts;
    for (let i = 0; i < 200; i++) {
      const r = await d.decide(noBand());
      assert.equal(r.source, "llm", `call ${i + 1}`);
    }
    assert.equal(gw.posts, before + 200);
    assert.equal(d.modelBudget().used, 200);
    const r = await d.decide(noBand());
    assert.equal(gw.posts, before + 200, "the 201st call reached the gateway");
    assert.equal(r.source, "policy");
    assert.equal(r.model, "desk-policy");
    assert.match(r.note ?? "", /model budget spent for the day \(200\/200 calls/);
    // a screened hold still answers past the cap, as a screen
    assert.equal((await d.decide(inRange())).source, "screen");
  });
  await test("the count survives a reload: it is on disk, a fresh read (a restarted process) sees 200 and refuses; the next UTC day starts at 0", () => {
    const onDisk = JSON.parse(fs.readFileSync(budgetFile, "utf8")) as { day: string; used: number };
    assert.equal(onDisk.used, 200);
    assert.equal(onDisk.day, new Date().toISOString().slice(0, 10));
    const again = d.spendModelCall(Date.now(), {}, budgetFile);
    assert.equal(again.ok, false);
    assert.equal(again.budget.used, 200);
    // an operator cannot raise it past the ceiling, and lowering it bites at once
    assert.equal(d.spendModelCall(Date.now(), { MODEL_CALLS_PER_DAY: "150" }, budgetFile).ok, false);
    const tomorrow = Date.now() + 86_400_000;
    const next = d.spendModelCall(tomorrow, {}, budgetFile);
    assert.equal(next.ok, true);
    assert.equal(next.budget.used, 1);
    assert.equal(next.budget.day, new Date(tomorrow).toISOString().slice(0, 10));
  });
  await test("a budget file that cannot be read fails closed: no call, the day taken as spent", async () => {
    fs.writeFileSync(budgetFile, "{ torn");
    const before = gw.posts;
    const r = await d.decide(noBand());
    assert.equal(gw.posts, before);
    assert.equal(r.source, "policy");
    assert.match(r.note ?? "", /model budget spent for the day .*unreadable/);
    assert.equal(d.modelBudget().used, 200);
  });
  await test("MODEL_CALLS_PER_DAY=0: the model is never asked", async () => {
    clearBudget();
    process.env.MODEL_CALLS_PER_DAY = "0";
    try {
      const before = gw.posts;
      const r = await d.decide(noBand());
      assert.equal(gw.posts, before);
      assert.match(r.note ?? "", /model budget spent for the day \(0\/0/);
    } finally {
      delete process.env.MODEL_CALLS_PER_DAY;
    }
  });

  console.log("failures and directives");
  await test("a gateway failure still falls to the desk policy as today, and the call counts", async () => {
    clearBudget();
    gw.answer = () => ({ status: 500, body: { error: { code: "internal", message: "boom" } } });
    try {
      const r = await d.decide(noBand());
      assert.equal(r.source, "policy");
      assert.equal(r.model, "desk-policy");
      assert.match(r.note ?? "", /OpenHermit/);
      assert.match(r.note ?? "", /openhermit:mr-bands-test was asked/);
      assert.equal(d.modelBudget().used, 1);
      // the model's reply is not a decision: the policy again
      gw.answer = () => ({ status: 200, body: { sessionId: "s", messageId: "m", text: "I'd hold.", toolCalls: [] } });
      const junk = await d.decide(noBand());
      assert.equal(junk.source, "policy");
      assert.match(junk.note ?? "", /not a decision/);
    } finally {
      gw.answer = holdReply;
      oh.forgetSessions();
    }
  });
  await test("an OPEN from the model still walks the desk policy's advice (the screen never skips it)", async () => {
    clearBudget();
    gw.answer = (text) => {
      const c = Number((text.match(/This is cycle (\d+)/) ?? [])[1]);
      const open = { side: "SOL_ONLY", amountSol: 5, amountToken: 0, binsBelowActive: 8, binsAboveActive: 0, strategy: "Spot" };
      return { status: 200, body: { sessionId: "s", messageId: "m", text: JSON.stringify({ ...HOLD, action: "OPEN_POSITION", open, headline: "In.", cycle: c }), toolCalls: [] } };
    };
    try {
      const o = noBand();
      const r = await d.decide(o);
      assert.equal(r.source, "llm");
      assert.ok(r.note && /desk policy/.test(r.note), `the advice ran: ${r.note}`);
    } finally {
      gw.answer = holdReply;
    }
  });
  await test("engine directives are unchanged: source engine, model engine, no screen and no spend", () => {
    clearBudget();
    const before = gw.posts;
    const close = { action: "CLOSE_POSITION" as const, open: null, positionAddress: "BandAddr1111111111111111111111111111111111", reasoning: "Stop.", confidence: 1, headline: "Stop." };
    const r = d.engineDecideResult(close, "STOP: down 12%");
    assert.deepEqual(r, { decision: close, source: "engine", model: "engine", note: "STOP: down 12%" });
    assert.equal(gw.posts, before);
    assert.equal(d.modelBudget().used, 0);
  });

  await gw.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
