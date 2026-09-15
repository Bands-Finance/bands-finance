/**
 * ClawPump client tests. Pure: a fake fetch stands in for clawpump.tech; nothing is paid or minted.
 *   npx tsx src/scripts/test-clawpump.ts
 */
import assert from "node:assert/strict";
import { ClawPumpClient, ClawPumpError, clawpumpEnv, launchBody, launchRefusal, SOL_MINT, tokenSpec, type LaunchRequest } from "../tools/clawpump";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.error(err);
    process.exit(1);
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; init?: RequestInit };
const fake = (handler: (url: string, init?: RequestInit) => Response) => {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { f, calls };
};
const goodToken = { TOKEN_NAME: "Mr Bands", TOKEN_SYMBOL: "bands", TOKEN_DESCRIPTION: "An autonomous market maker for Meteora that publishes every decision.", TOKEN_IMAGE_URL: "https://bands.finance/logo.png", TOKEN_DEV_BUY_SOL: "0" };
const req = (): LaunchRequest => ({ agentId: "1ae4e084-8b35-4b24-943d-7ea453e400c6", agentName: "Mr Bands", walletAddress: "9q3VKDrHBusoxsWEBwkzNmRe51AV5kGEMA2Yic5EPkVW", token: tokenSpec(goodToken) });

async function main(): Promise<void> {
  console.log("env and the token spec");
  await test("clawpumpEnv: defaults, trimming, empty key reads as none", () => {
    assert.deepEqual(clawpumpEnv({}), { baseUrl: "https://clawpump.tech", agentId: null, apiKey: null });
    assert.deepEqual(clawpumpEnv({ CLAWPUMP_API_URL: "https://x.test/ ", CLAWPUMP_AGENT_ID: " abc ", CLAWPUMP_API_KEY: "" }), { baseUrl: "https://x.test", agentId: "abc", apiKey: null });
  });
  await test("tokenSpec: the launch refuses what ClawPump would refuse, before any call", () => {
    const t = tokenSpec(goodToken);
    assert.equal(t.symbol, "BANDS", "symbol is upper-cased");
    assert.equal(t.devBuySol, 0);
    assert.throws(() => tokenSpec({ ...goodToken, TOKEN_DESCRIPTION: "too short" }), /at least 20 characters/);
    assert.throws(() => tokenSpec({ ...goodToken, TOKEN_IMAGE_URL: "http://plain" }), /https URL/);
    assert.throws(() => tokenSpec({ ...goodToken, TOKEN_SYMBOL: "TOO-LONG-SYM" }), /1-10 letters or digits/);
    assert.throws(() => tokenSpec({ ...goodToken, TOKEN_DEV_BUY_SOL: "-1" }), /non-negative/);
    assert.throws(() => tokenSpec({ ...goodToken, TOKEN_NAME: "" }), /TOKEN_NAME is empty/);
  });
  await test("launchBody: the partner API's fields; the SOL pair omits pumpQuoteMint and the creator fee; the proof rides on completion", () => {
    const b = launchBody(req(), { preflight: true });
    assert.deepEqual(Object.keys(b).sort(), ["agentId", "agentName", "description", "devBuySol", "imageUrl", "name", "preflight", "symbol", "walletAddress"]);
    assert.equal(launchBody({ ...req(), pumpQuoteMint: SOL_MINT, pumpCreatorFeeBps: 250 }).pumpQuoteMint, undefined, "the SOL pair is the default and cannot carry a creator fee");
    const custom = launchBody({ ...req(), pumpQuoteMint: "PAIRmint", pumpCreatorFeeBps: 250 });
    assert.equal(custom.pumpQuoteMint, "PAIRmint");
    assert.equal(custom.pumpCreatorFeeBps, 250);
    const done = launchBody(req(), { txSignature: "5Kd", preflightToken: "tok" });
    assert.equal(done.txSignature, "5Kd");
    assert.equal(done.preflightToken, "tok");
    assert.equal(done.preflight, undefined);
  });

  console.log("the client");
  await test("earnings is public (no key needed) and parses the documented fields", async () => {
    const { f, calls } = fake(() => json(200, { totalEarned: 1.073, totalSent: 1.073, totalPending: 0, totalHeld: 0, recentDistributions: [{ x: 1 }] }));
    const c = new ClawPumpClient({ fetch: f });
    const e = await c.earnings("1ae4e084-8b35-4b24-943d-7ea453e400c6");
    assert.equal(e.totalEarned, 1.073);
    assert.equal(e.recentDistributions.length, 1);
    assert.equal(calls[0].url, "https://clawpump.tech/api/agents/1ae4e084-8b35-4b24-943d-7ea453e400c6/earnings");
    assert.equal((calls[0].init?.headers as Record<string, string>).authorization, undefined, "no bearer on a public read");
  });
  await test("keyed reads refuse without a key, and send the bearer with one", async () => {
    const { f, calls } = fake(() => json(200, { id: "a", name: "Mr Bands", status: "running", walletAddress: "w", tokenAddress: null, isPublic: true }));
    await assert.rejects(new ClawPumpClient({ fetch: f }).agent("a"), /needs CLAWPUMP_API_KEY/);
    const a = await new ClawPumpClient({ fetch: f, apiKey: "cpk_test" }).agent("a");
    assert.equal(a.tokenAddress, null);
    assert.equal(a.name, "Mr Bands");
    assert.equal((calls[0].init?.headers as Record<string, string>).authorization, "Bearer cpk_test");
  });
  await test("an error answer becomes a ClawPumpError with the status and the request id", async () => {
    const { f } = fake(() => json(402, { error: "insufficient credits", meta: { requestId: "req-1" } }));
    const c = new ClawPumpClient({ fetch: f, apiKey: "cpk_test" });
    await assert.rejects(c.pumpPairs(), (err: unknown) => err instanceof ClawPumpError && err.status === 402 && err.requestId === "req-1" && /insufficient credits/.test(err.message));
  });
  await test("launchPreflight posts the body with preflight:true and returns the payment quote; nothing else is called", async () => {
    const { f, calls } = fake(() =>
      json(200, {
        payment: { method: "sol", amountLamports: 7_510_000, amountSol: 0.00751, payTo: "49CfXAr58cCTGJnYsbm16fEsE5JRpdR8QQP8E1ZinGCq", payFrom: "9q3V", validForSeconds: 900, breakdown: { creationFeeSol: 0.00751, devBuySol: 0 } },
        retryWith: { txSignature: "<sig>", preflightToken: "pf-1" },
        meta: { requestId: "req-2" },
      }),
    );
    const c = new ClawPumpClient({ fetch: f, apiKey: "cpk_test" });
    const q = await c.launchPreflight(req());
    assert.equal(q.amountLamports, 7_510_000);
    assert.equal(q.payTo, "49CfXAr58cCTGJnYsbm16fEsE5JRpdR8QQP8E1ZinGCq");
    assert.equal(q.preflightToken, "pf-1");
    assert.equal(q.requestId, "req-2");
    assert.equal(calls.length, 1);
    const sent = JSON.parse(String(calls[0].init?.body));
    assert.equal(sent.preflight, true);
    assert.equal(sent.symbol, "BANDS");
    assert.equal(sent.agentId, "1ae4e084-8b35-4b24-943d-7ea453e400c6");
  });
  await test("launchComplete carries the proof and returns the mint; an answer without a mint throws", async () => {
    const { f, calls } = fake(() => json(200, { status: "launched", mintAddress: "MINT111", txHash: "tx1", pumpUrl: "https://pump.fun/coin/MINT111", idempotent: true, meta: { requestId: "req-3" } }));
    const c = new ClawPumpClient({ fetch: f, apiKey: "cpk_test" });
    const r = await c.launchComplete(req(), "5Kd", "pf-1");
    assert.equal(r.mintAddress, "MINT111");
    assert.equal(r.idempotent, true);
    const sent = JSON.parse(String(calls[0].init?.body));
    assert.equal(sent.txSignature, "5Kd");
    assert.equal(sent.preflightToken, "pf-1");
    const bad = fake(() => json(200, { status: "pending" }));
    await assert.rejects(new ClawPumpClient({ fetch: bad.f, apiKey: "cpk_test" }).launchComplete(req(), "5Kd", "pf-1"), /without a mint/);
  });

  console.log("the gate");
  await test("launchRefusal: every reason in order, and none when all hold", () => {
    const ok = { dryRun: false, confirm: true, apiKey: "cpk_x", agentId: "a", ephemeralWallet: false };
    assert.equal(launchRefusal(ok), null);
    assert.match(launchRefusal({ ...ok, agentId: null })!, /CLAWPUMP_AGENT_ID/);
    assert.match(launchRefusal({ ...ok, apiKey: null })!, /CLAWPUMP_API_KEY/);
    assert.match(launchRefusal({ ...ok, ephemeralWallet: true })!, /WALLET_SECRET_KEY/);
    assert.match(launchRefusal({ ...ok, dryRun: true })!, /DRY_RUN is on/);
    assert.match(launchRefusal({ ...ok, confirm: false })!, /--confirm/);
  });

  console.log(`\n${passed} clawpump tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
