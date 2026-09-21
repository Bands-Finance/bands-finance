/**
 * The OpenHermit decision backend (src/agent/openhermit.ts, the DECIDER=openhermit branch of
 * src/agent/decide.ts) against a fake gateway on a local port: the sessions and messages routes
 * as docs/transport-protocol.md describes them, scripted per case. The real gateway is never called.
 *   npx tsx src/scripts/test-openhermit.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Observation } from "../agent/observation";
import type { PoolSnapshot } from "../tools/dlmm";

// Everything that reads src/config.ts is imported after the environment is pinned.
process.env.ANTHROPIC_API_KEY = "";
delete process.env.ANTHROPIC_AUTH_TOKEN;
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

interface Seen {
  method: string;
  path: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

/** One scripted gateway: `reply` decides each request; `seen` records them. */
interface FakeGateway {
  url: string;
  seen: Seen[];
  reply: (req: Seen) => { status: number; body?: unknown; delayMs?: number };
  sessions: Set<string>;
  close: () => Promise<void>;
}

function startGateway(): Promise<FakeGateway> {
  const gw: FakeGateway = { url: "", seen: [], reply: () => ({ status: 500 }), sessions: new Set(), close: async () => {} };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const seen: Seen = { method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization, body };
      gw.seen.push(seen);
      const r = gw.reply(seen);
      const send = () => {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(r.body === undefined ? "" : JSON.stringify(r.body));
      };
      if (r.delayMs) setTimeout(send, r.delayMs);
      else send();
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

/** The routes as the transport doc gives them: open (create or reopen) and post with wait=true. Unknown session -> the gateway's 404 shape. */
const SESSIONS = "/api/agents/mr-bands-test/sessions";
const MESSAGES = `${SESSIONS}/desk%3A${POOL}/messages`;
function routes(gw: FakeGateway, answer: (req: Seen) => { status: number; body?: unknown; delayMs?: number }) {
  gw.reply = (req) => {
    if (req.auth !== "Bearer test-admin-token") return { status: 401, body: { error: { code: "unauthorized", message: "Invalid admin token." } } };
    if (req.path === SESSIONS) {
      gw.sessions.add(String(req.body.sessionId));
      return { status: 200, body: { sessionId: req.body.sessionId, source: req.body.source } };
    }
    if (req.path.startsWith(MESSAGES)) {
      if (!gw.sessions.has(`desk:${POOL}`)) return { status: 404, body: { error: { code: "not_found", message: `Session not found: desk:${POOL}` } } };
      return answer(req);
    }
    return { status: 404, body: { error: { code: "not_found", message: "no such route" } } };
  };
}
const said = (text: string) => ({ status: 200, body: { sessionId: `desk:${POOL}`, messageId: "msg-1", text, toolCalls: [] } });

async function main(): Promise<void> {
  const { binPriceUi } = await import("../tools/dlmm.js");
  const { decide, deciderOf, hasLlmCredentials } = await import("../agent/decide.js");
  const oh = await import("../agent/openhermit.js");
  const p = (bin: number) => binPriceUi(bin, 20, 6, 9);

  /** ANSEM/SOL as the paper tests draw it: X = ANSEM (6 dec), Y = SOL (9 dec), 20 bps. */
  function snapAt(active: number): PoolSnapshot {
    const bins = [];
    for (let b = active - 10; b <= active + 10; b++) bins.push({ binId: b, price: p(b), xAmount: b > active ? 5000 : 0, yAmount: b < active ? 9 : b === active ? 1 : 0, isActive: b === active });
    return {
      address: POOL,
      label: "ANSEM/SOL",
      tokenX: { mint: ANSEM, symbol: "ANSEM", decimals: 6, reserve: 5_000_000 },
      tokenY: { mint: SOL_MINT, symbol: "SOL", decimals: 9, reserve: 5000 },
      solSide: "Y",
      baseToken: { mint: ANSEM, symbol: "ANSEM", decimals: 6, reserve: 5_000_000 },
      binStep: 20,
      activeBinId: active,
      activePrice: p(active),
      priceLabel: "SOL per ANSEM",
      tokenPriceInSol: p(active),
      quoteSide: "Y",
      quoteToken: { mint: SOL_MINT, symbol: "SOL", decimals: 9, reserve: 5000 },
      quoteSymbol: "SOL",
      quotePriceInSol: 1,
      tokenPriceInQuote: p(active),
      solPriceUsd: 100,
      baseFeePct: 0.2,
      maxFeePct: 10,
      dynamicFeePct: 0.2,
      bins,
      liquidityBelowY: 90,
      liquidityAboveX: 50_000,
      fetchedAt: new Date(T0).toISOString(),
    };
  }
  const snapshot = snapAt(260);
  const observation: Observation = {
    ts: new Date(T0).toISOString(),
    cycle: 7,
    mode: "dry-run",
    poolLabel: "ANSEM/SOL",
    snapshot,
    positions: [],
    wallet: { address: "wallet", sol: 100, token: 0, tokenSymbol: "ANSEM", quote: 100, quoteSymbol: "SOL" },
    analytics: null,
    state: { actionsToday: 0, lastActionAt: null, lastPrice: null, killSwitch: false },
    recent: [],
    screen: null,
    portfolio: { activePools: ["ANSEM/SOL"], poolsWithBands: 0, maxActivePools: 3, otherExposureSol: 0 },
    engine: null,
  };
  const hold = { action: "HOLD", open: null, positionAddress: null, reasoning: "The active bin holds 1 SOL and the pool prints nothing. Nothing to do.", confidence: 0.8, headline: "Bands stay in the pocket." };

  console.log("settings and the decider switch");
  await test("openHermitSettings: defaults, trimming, a bad timeout falls back; the backend is available only with a token", () => {
    const s = oh.openHermitSettings({});
    assert.deepEqual(s, { gatewayUrl: "http://127.0.0.1:4000", agentId: "mr-bands", token: "", timeoutMs: 120_000 });
    assert.equal(oh.openHermitSettings({ OPENHERMIT_GATEWAY_URL: "http://gw:4000/ ", OPENHERMIT_TIMEOUT_MS: "junk" }).gatewayUrl, "http://gw:4000");
    assert.equal(oh.openHermitSettings({ OPENHERMIT_TIMEOUT_MS: "junk" }).timeoutMs, 120_000);
    assert.equal(oh.openHermitSettings({ OPENHERMIT_TIMEOUT_MS: "0" }).timeoutMs, 120_000);
    assert.equal(oh.openHermitAvailable({}), false);
    assert.equal(oh.openHermitAvailable({ OPENHERMIT_TOKEN: " t " }), true);
    assert.equal(oh.decisionSessionId(POOL), `desk:${POOL}`);
    assert.equal(oh.decisionSessionId(" a/b c "), "desk:a-b-c");
  });
  await test("deciderOf: DECIDER wins; unset keeps the old rule (anthropic with credentials, else policy); hasLlmCredentials follows the backend", () => {
    assert.equal(deciderOf({ DECIDER: "OpenHermit" }), "openhermit");
    assert.equal(deciderOf({ DECIDER: "policy" }), "policy");
    assert.equal(deciderOf({ DECIDER: "anthropic" }), "anthropic");
    // no ANTHROPIC_API_KEY in the pinned config, so the old default is the policy; an auth token makes it anthropic
    assert.equal(deciderOf({}), "policy");
    assert.equal(deciderOf({ DECIDER: "nonsense" }), "policy");
    assert.equal(deciderOf({ ANTHROPIC_AUTH_TOKEN: "x" }), "anthropic");
    assert.equal(hasLlmCredentials({ DECIDER: "openhermit" }), false, "no token: not available");
    assert.equal(hasLlmCredentials({ DECIDER: "openhermit", OPENHERMIT_TOKEN: "t" }), true);
    assert.equal(hasLlmCredentials({ DECIDER: "policy", ANTHROPIC_AUTH_TOKEN: "x" }), false);
    assert.equal(hasLlmCredentials({ ANTHROPIC_AUTH_TOKEN: "x" }), true);
  });

  console.log("the prompt and the parser");
  await test("decisionPrompt: the observation, then the two lines (JSON only, the fields in words, the pool's label)", () => {
    const text = oh.decisionPrompt(observation);
    assert.ok(text.includes("ANSEM/SOL"));
    const lines = text.trimEnd().split("\n");
    assert.match(lines[lines.length - 2], /^Answer with ONLY one JSON object/);
    assert.match(lines[lines.length - 2], /action \(one of HOLD, OPEN_POSITION, CLOSE_POSITION, CLAIM_FEES, REBALANCE\)/);
    assert.match(lines[lines.length - 2], /headline/);
    assert.equal(lines[lines.length - 1], "The pool's label is ANSEM/SOL.");
  });
  await test("extractDecision: bare JSON, fenced JSON in prose, braces inside strings, garbage, and JSON that is not a decision", () => {
    assert.equal(oh.extractDecision(JSON.stringify(hold)).decision?.action, "HOLD");
    const prose = `Sure. Here is my call:\n\n\`\`\`json\n${JSON.stringify({ ...hold, reasoning: "Depth {thin} on the bid: {9 SOL} a bin." }, null, 2)}\n\`\`\`\n\nLet me know.`;
    const r = oh.extractDecision(prose);
    assert.equal(r.decision?.action, "HOLD");
    assert.equal(r.decision?.reasoning, "Depth {thin} on the bid: {9 SOL} a bin.");
    assert.match(oh.extractDecision("I would hold here, nothing to add.").error ?? "", /no JSON object/);
    assert.match(oh.extractDecision("{ not json").error ?? "", /no JSON object|not JSON|no decision/);
    assert.match(oh.extractDecision(JSON.stringify({ action: "DANCE", open: null })).error ?? "", /action/);
    // a bad object first, a good one after: the good one is taken
    assert.equal(oh.extractDecision(`{"note": 1} then ${JSON.stringify(hold)}`).decision?.action, "HOLD");
  });

  const gw = await startGateway();
  process.env.OPENHERMIT_GATEWAY_URL = gw.url;
  const reset = (answer: Parameters<typeof routes>[1]) => {
    gw.seen.length = 0;
    gw.sessions.clear();
    oh.forgetSessions();
    routes(gw, answer);
  };

  console.log("decide() through the fake gateway");
  await test("a clean JSON reply: source llm, the parsed decision, model openhermit:<agent id>, usage zeros; the session was opened first, then posted with wait=true", async () => {
    reset(() => said(JSON.stringify(hold)));
    const r = await decide(observation);
    assert.equal(r.source, "llm");
    assert.equal(r.model, "openhermit:mr-bands-test");
    assert.deepEqual(r.decision, hold);
    assert.deepEqual(r.usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    assert.deepEqual(gw.seen.map((s) => s.path), [SESSIONS, `${MESSAGES}?wait=true&timeout=${(gw.seen[1].path.match(/timeout=(\d+)/) ?? [])[1]}`]);
    const open = gw.seen[0].body as { sessionId: string; source: Record<string, unknown> };
    assert.equal(open.sessionId, `desk:${POOL}`);
    assert.equal(open.source.type, "direct");
    assert.equal(open.source.interactive, false);
    const post = gw.seen[1].body as { text: string; mentioned: boolean };
    assert.ok(post.text.startsWith(oh.decisionPrompt(observation).slice(0, 40)));
    assert.match(post.text, /Answer with ONLY one JSON object/);
    assert.equal(post.mentioned, true);
    const timeout = Number((gw.seen[1].path.match(/timeout=(\d+)/) ?? [])[1]);
    assert.ok(timeout > 0 && timeout <= 2000, `the gateway is asked to wait no longer than what is left of the deadline: ${timeout}`);
  });
  await test("a second ask on the same pool skips the open (the session is remembered)", async () => {
    routes(gw, () => said(JSON.stringify(hold)));
    gw.seen.length = 0;
    const r = await decide(observation);
    assert.equal(r.source, "llm");
    assert.deepEqual(gw.seen.map((s) => s.method + " " + s.path.split("?")[0]), [`POST ${MESSAGES}`]);
  });
  await test("prose around fenced JSON: parsed", async () => {
    reset(() => said(`Right then.\n\n\`\`\`json\n${JSON.stringify({ ...hold, headline: "Pocket." })}\n\`\`\`\nThat is my call.`));
    const r = await decide(observation);
    assert.equal(r.source, "llm");
    assert.equal(r.decision.headline, "Pocket.");
  });
  await test("the model wants in: the desk policy advises (no hot row, no score -> a HOLD that says so), source stays llm", async () => {
    const open = { ...hold, action: "OPEN_POSITION", open: { side: "SOL_ONLY", amountSol: 5, amountToken: 0, binsBelowActive: 8, binsAboveActive: 0, strategy: "Spot" }, exitAsk: true };
    reset(() => said(JSON.stringify(open)));
    const r = await decide(observation);
    assert.equal(r.source, "llm");
    assert.equal(r.decision.action, "HOLD", "the entry rules said no");
    assert.match(r.note ?? "", /refused by the desk policy's entry rules/);
    assert.equal(r.decision.exitAsk, undefined, "exitAsk is never the model's");
  });
  await test("garbage: the desk policy proposes, the note names it, and the agent id is recorded as asked", async () => {
    reset(() => said("I would rather not say. The pool looks quiet."));
    const r = await decide(observation);
    assert.equal(r.source, "policy");
    assert.equal(r.model, "desk-policy");
    assert.match(r.note ?? "", /OpenHermit reply was not a decision/);
    assert.match(r.note ?? "", /openhermit:mr-bands-test was asked/);
  });
  await test("a turn that ended without text: not a decision", async () => {
    reset(() => ({ status: 200, body: { sessionId: `desk:${POOL}`, text: null, toolCalls: [], error: "model failed" } }));
    const r = await decide(observation);
    assert.equal(r.source, "policy");
    assert.match(r.note ?? "", /OpenHermit reply was not a decision \(the turn ended with an error: model failed\)/);
  });
  await test("401: the desk policy proposes and the note says to check the token", async () => {
    reset(() => said(JSON.stringify(hold)));
    process.env.OPENHERMIT_TOKEN = "wrong";
    try {
      const r = await decide(observation);
      assert.equal(r.source, "policy");
      assert.match(r.note ?? "", /OpenHermit refused the token \(401\): check OPENHERMIT_TOKEN/);
    } finally {
      process.env.OPENHERMIT_TOKEN = "test-admin-token";
    }
  });
  await test("a reply after the timeout: the desk policy proposes within the timeout, and the note says OpenHermit timed out", async () => {
    reset(() => ({ ...said(JSON.stringify(hold)), delayMs: 1500 }));
    process.env.OPENHERMIT_TIMEOUT_MS = "300";
    const t = Date.now();
    try {
      const r = await decide(observation);
      const ms = Date.now() - t;
      assert.equal(r.source, "policy");
      assert.match(r.note ?? "", /OpenHermit timed out/);
      assert.ok(ms < 1000, `answered in ${ms}ms, before the slow reply`);
    } finally {
      process.env.OPENHERMIT_TIMEOUT_MS = "2000";
    }
  });
  await test("the gateway's own 504 (it gave up waiting for the agent) reads as a timeout too", async () => {
    reset(() => ({ status: 504, body: { sessionId: `desk:${POOL}`, text: null, toolCalls: [], error: "Timeout waiting for agent response." } }));
    const r = await decide(observation);
    assert.equal(r.source, "policy");
    assert.match(r.note ?? "", /OpenHermit timed out \(Timeout waiting for agent response\)/);
  });
  await test("session 404 (the gateway restarted and forgot it): open, then post again, then success", async () => {
    reset(() => said(JSON.stringify(hold)));
    assert.equal((await decide(observation)).source, "llm");
    gw.sessions.clear(); // the restart: the desk still remembers the session, the gateway does not
    gw.seen.length = 0;
    const r = await decide(observation);
    assert.equal(r.source, "llm");
    // the fake answers by the state at the time it was asked: the first post was refused (404), the open let the second through
    assert.deepEqual(gw.seen.map((s) => s.path.split("?")[0]), [MESSAGES, SESSIONS, MESSAGES], "post (404), open, post (200)");
  });
  await test("unreachable: nothing listens on the port; the desk policy proposes with the note", async () => {
    await gw.close();
    oh.forgetSessions();
    const r = await decide(observation);
    assert.equal(r.source, "policy");
    assert.match(r.note ?? "", /OpenHermit unreachable/);
  });
  await test("no token: the policy proposes and the note names the missing var; nothing is called", async () => {
    process.env.OPENHERMIT_TOKEN = "";
    try {
      const r = await decide(observation);
      assert.equal(r.source, "policy");
      assert.match(r.note ?? "", /DECIDER=openhermit but OPENHERMIT_TOKEN is not set/);
    } finally {
      process.env.OPENHERMIT_TOKEN = "test-admin-token";
    }
  });

  console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
