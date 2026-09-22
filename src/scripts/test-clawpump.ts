/**
 * ClawPump client tests. Pure: a fake fetch stands in for clawpump.tech; nothing is paid or minted.
 *   npx tsx src/scripts/test-clawpump.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import { ClawPumpClient, ClawPumpError, clawpumpEnv, isSolPair, launchBody, launchRefusal, payerExpectedOf, resolvePumpPair, SOL_MINT, tokenSpec, type LaunchRequest } from "../tools/clawpump";

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
const DESK = "9q3VKDrHBusoxsWEBwkzNmRe51AV5kGEMA2Yic5EPkVW";
const TREASURY = "TreasuryXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const req = (): LaunchRequest => ({ agentId: "00000000-0000-4000-8000-000000000001", agentName: "Mr Bands", walletAddress: "9q3VKDrHBusoxsWEBwkzNmRe51AV5kGEMA2Yic5EPkVW", token: tokenSpec(goodToken) });

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
    assert.deepEqual(Object.keys(b).sort(), ["agentId", "agentName", "buybackBps", "description", "devBuySol", "imageUrl", "name", "preflight", "symbol", "walletAddress"]);
    assert.equal(launchBody({ ...req(), pumpQuoteMint: SOL_MINT, pumpCreatorFeeBps: 250 }).pumpQuoteMint, undefined, "the SOL pair is the default and cannot carry a creator fee");
    const custom = launchBody({ ...req(), pumpQuoteMint: "PAIRmint", pumpCreatorFeeBps: 250 });
    assert.equal(custom.pumpQuoteMint, "PAIRmint");
    assert.equal(custom.pumpCreatorFeeBps, 250);
    const done = launchBody(req(), { txSignature: "5Kd", preflightToken: "tok" });
    assert.equal(done.txSignature, "5Kd");
    assert.equal(done.preflightToken, "tok");
    assert.equal(done.preflight, undefined);
  });

  await test("launchBody: buybackBps is 0 in so many words, on preflight and on completion, on any pair; nothing that could split the fee or buy after launch is sent", () => {
    for (const b of [launchBody(req(), { preflight: true }), launchBody(req(), { txSignature: "5Kd", preflightToken: "tok" }), launchBody({ ...req(), pumpQuoteMint: "PAIRmint", pumpCreatorFeeBps: 100 })]) {
      assert.equal(b.buybackBps, 0);
      assert.equal(b.devBuyAmountUsd, undefined, "no post-launch buy");
      assert.equal(b.devBuySol, 0);
    }
  });

  await test("ops/live.env: the $BANDS spec decided on 22 Sep parses (SOL pair, no dev buy, no creator fee, name Mr Bands, ticker BANDS, no website link)", () => {
    const env: Record<string, string> = {};
    for (const line of readFileSync(path.resolve(__dirname, "../../ops/live.env"), "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
    const t = tokenSpec(env);
    assert.equal(t.name, "Mr Bands");
    assert.equal(t.symbol, "BANDS");
    assert.doesNotMatch(t.description ?? env.TOKEN_DESCRIPTION ?? "", /bands\.finance|https?:\/\//i, "Zach, 22 Sep: the token is not linked to the website yet");
    assert.equal(env.TOKEN_ON_SITE, "false", "the site prints nothing about the token until this reads true");
    assert.equal(isSolPair(t.pumpPair), true);
    assert.equal(t.devBuySol, 0);
    assert.equal(t.creatorFeeBps, null);
    assert.equal(env.TOKEN_CREATOR_FEE_BPS, undefined, "a SOL pair cannot carry one");
    assert.equal(env.PAIR_HOUSE_MINTS ?? "", "", "the house lane stays off through 8 Oct");
  });

  await test("the launch pair: SOL by default; NVDA resolves to NVDAx in the catalogue by symbol, ticker or mint; an absent pair lists what is offered; the creator fee only on a custom pair", () => {
    const t = tokenSpec(goodToken);
    assert.equal(t.pumpPair, "SOL");
    assert.equal(t.creatorFeeBps, null);
    assert.equal(isSolPair("wsol"), true);
    assert.equal(isSolPair(SOL_MINT), true);
    const NVDAX = { mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", symbol: "NVDAx", name: "NVIDIA xStock", decimals: 8 };
    const USD1 = { mint: "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", symbol: "USD1", name: "World Liberty Financial USD", decimals: 6 };
    const catalogue = [USD1, NVDAX];
    for (const want of ["NVDAx", "nvdax", "NVDA", NVDAX.mint]) {
      const r = resolvePumpPair(catalogue, want);
      assert.ok(r.ok && r.asset?.mint === NVDAX.mint, `${want} -> NVDAx`);
    }
    const sol = resolvePumpPair(catalogue, "SOL");
    assert.ok(sol.ok && sol.asset === null);
    const missing = resolvePumpPair([USD1], "NVDA");
    assert.ok(!missing.ok && /"NVDA" is not a pump.fun creation pair on ClawPump today \(offered: USD1\)/.test(missing.reason));
    const nv = tokenSpec({ ...goodToken, TOKEN_PUMP_PAIR: "NVDAx", TOKEN_CREATOR_FEE_BPS: "250" });
    assert.equal(nv.pumpPair, "NVDAx");
    assert.equal(nv.creatorFeeBps, 250);
    assert.throws(() => tokenSpec({ ...goodToken, TOKEN_CREATOR_FEE_BPS: "250" }), /cannot be set on the SOL pair/);
    assert.throws(() => tokenSpec({ ...goodToken, TOKEN_PUMP_PAIR: "NVDAx", TOKEN_CREATOR_FEE_BPS: "50" }), /from 100 to 300/);
    const body = launchBody({ ...req(), token: nv, pumpQuoteMint: NVDAX.mint, pumpCreatorFeeBps: 250 });
    assert.equal(body.pumpQuoteMint, NVDAX.mint);
    assert.equal(body.pumpCreatorFeeBps, 250);
  });

  console.log("the client");
  await test("earnings is public (no key needed) and parses the documented fields", async () => {
    const { f, calls } = fake(() => json(200, { totalEarned: 1.073, totalSent: 1.073, totalPending: 0, totalHeld: 0, recentDistributions: [{ x: 1 }] }));
    const c = new ClawPumpClient({ fetch: f });
    const e = await c.earnings("00000000-0000-4000-8000-000000000001");
    assert.equal(e.totalEarned, 1.073);
    assert.equal(e.recentDistributions.length, 1);
    assert.equal(calls[0].url, "https://clawpump.tech/api/agents/00000000-0000-4000-8000-000000000001/earnings");
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
    assert.equal(sent.agentId, "00000000-0000-4000-8000-000000000001");
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
    const ok = { dryRun: false, confirm: true, apiKey: "cpk_x", agentId: "a", ephemeralWallet: false, payer: TREASURY, payerExpected: TREASURY, deskWallet: DESK, devBuySol: 0, pumpPair: "SOL" };
    assert.equal(launchRefusal(ok), null);
    assert.equal(launchRefusal({ ...ok, pumpPair: "wSOL" }), null, "wSOL is the SOL pair too");
    assert.match(launchRefusal({ ...ok, agentId: null })!, /CLAWPUMP_AGENT_ID/);
    assert.match(launchRefusal({ ...ok, apiKey: null })!, /CLAWPUMP_API_KEY/);
    assert.match(launchRefusal({ ...ok, ephemeralWallet: true })!, /WALLET_SECRET_KEY/);
    assert.match(launchRefusal({ ...ok, payer: DESK, payerExpected: DESK })!, /is the desk wallet \(EXPECTED_WALLET\): launch from his operating wallet's keypair/, "never from the desk, even if pinned to it");
    assert.match(launchRefusal({ ...ok, payerExpected: null })!, /TOKEN_PAYER_EXPECTED is not set/);
    assert.match(launchRefusal({ ...ok, payer: "Other1111" })!, /derives to Other1111, but TOKEN_PAYER_EXPECTED is .*wrong key/);
    assert.equal(launchRefusal({ ...ok, deskWallet: null }), null, "no EXPECTED_WALLET set: the pin alone decides");
    assert.match(launchRefusal({ ...ok, devBuySol: 2.5 })!, /TOKEN_DEV_BUY_SOL is 2\.5: the decision of 22 Sep is no dev buy/);
    assert.match(launchRefusal({ ...ok, devBuySol: 0.001, dryRun: true })!, /no dev buy/, "a dev buy is refused before DRY_RUN is even read");
    assert.match(launchRefusal({ ...ok, pumpPair: "NVDAx" })!, /TOKEN_PUMP_PAIR is NVDAx: the decision of 22 Sep is the SOL pair/);
    assert.match(launchRefusal({ ...ok, dryRun: true })!, /DRY_RUN is on/);
    assert.match(launchRefusal({ ...ok, confirm: false })!, /--confirm/);
  });

  await test("payerExpectedOf: TOKEN_PAYER_EXPECTED trimmed, empty reads as unset", () => {
    assert.equal(payerExpectedOf({}), null);
    assert.equal(payerExpectedOf({ TOKEN_PAYER_EXPECTED: "  " }), null);
    assert.equal(payerExpectedOf({ TOKEN_PAYER_EXPECTED: ` ${TREASURY} ` }), TREASURY);
  });

  await test("the wallet pin: live, the desk's EXPECTED_WALLET still refuses a treasury key; the launch's own pin takes it, and refuses any other", async () => {
    // a throwaway key made here, never funded; nothing is signed or sent
    const treasury = Keypair.generate();
    process.env.DRY_RUN = "false";
    process.env.WALLET_SECRET_KEY = JSON.stringify([...treasury.secretKey]);
    process.env.EXPECTED_WALLET = DESK;
    const { Wallet } = await import("../tools/wallet.js");
    const conn = new Connection("http://127.0.0.1:1");
    assert.throws(() => Wallet.fromConfig(conn), /but EXPECTED_WALLET is .*Refusing to start live/);
    const w = Wallet.fromConfig(conn, { address: treasury.publicKey.toBase58(), name: "TOKEN_PAYER_EXPECTED" });
    assert.equal(w.publicKey.toBase58(), treasury.publicKey.toBase58());
    assert.throws(() => Wallet.fromConfig(conn, { address: TREASURY, name: "TOKEN_PAYER_EXPECTED" }), /but TOKEN_PAYER_EXPECTED is .*Refusing to start live/);
  });

  console.log(`\n${passed} clawpump tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
