/**
 * Rails tests with synthetic data. No RPC, no LLM, no network: the payment gate gets a fake
 * connection whose getTransaction returns hand-built transactions, and the routes are
 * exercised through Hono's in-process app.request().
 *   npm run test:rails
 *
 * The plan/positions/collect/close RPC paths (src/platform/engineSkill.ts) are smoke-only:
 * they need a live pool. Their pure parts (access decision, input validation, verdict
 * mapping, unsigned serialization with a partial signer) are covered here.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Proposal, ProposalStatus } from "../platform/proposals.js";

// DATA_DIR must be pinned before src/config.ts loads, and static imports are hoisted above
// this line by the loader, so every module under test is loaded through import() in main().
const TEST_DIR = "data-test-rails";
process.env.DATA_DIR = TEST_DIR;
process.env.X402_TREASURY = "";
process.env.X402_VERIFY = "";
process.env.PLATFORM_OPERATOR_TOKEN = "op-test-token";
process.env.ENGINE_OPEN = "true";
process.env.ENGINE_ALLOWLIST = "";
process.env.DRY_RUN = "true";
fs.rmSync(path.resolve(process.cwd(), TEST_DIR), { recursive: true, force: true });

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${(err as Error).stack ?? (err as Error).message}`);
    process.exitCode = 1;
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes: Uint8Array): string {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const b of bytes) {
    if (b !== 0) break;
    out += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

async function main(): Promise<void> {
  const { Keypair, PublicKey, SystemProgram, Transaction } = await import("@solana/web3.js");
  const { TOKEN_2022_PROGRAM_ID, createTransferCheckedInstruction, createTransferInstruction, getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const nacl = (await import("tweetnacl")).default;
  const { Hono } = await import("hono");
  const { dataPath, readLedger } = await import("../lib/ledger.js");
  const { mintSession } = await import("../platform/accounts.js");
  const gateMod = await import("../platform/payments/PaymentGate.js");
  const { PaymentGate, MAX_AGE_SECONDS, SOLANA_MAINNET_CAIP2, USDC_MINT, paymentMessage, treasuryAtaFor, isTxSignature } = gateMod;
  type PaymentTxResponse = import("../platform/payments/PaymentGate.js").PaymentTxResponse;
  const { RevenueLedger } = await import("../platform/payments/RevenueLedger.js");
  const { X402Client, extractChallenge } = await import("../platform/payments/X402Client.js");
  const engine = await import("../platform/engineSkill.js");
  const proposals = await import("../platform/proposals.js");
  const mcp = await import("../platform/mcp/server.js");
  const rails = await import("../platform/railsRoutes.js");

  assert.ok(dataPath("x").includes(TEST_DIR), `ledgers must land in ${TEST_DIR}, got ${dataPath("x")}`);

  // ----- fixtures ---------------------------------------------------------------------
  const treasuryOwner = Keypair.generate();
  const treasuryAta = new PublicKey(treasuryAtaFor(treasuryOwner.publicKey.toBase58()));
  const payer = Keypair.generate();
  const txs = new Map<string, PaymentTxResponse>();
  const fakeConnection = { getTransaction: async (sig: string) => txs.get(sig) ?? null };
  let clock = Date.now();
  const gate = () => new PaymentGate({ treasury: treasuryOwner.publicKey.toBase58(), verify: "self", connection: () => fakeConnection, now: () => clock });

  const randomSig = () => base58Encode(nacl.randomBytes(64));
  const proofFor = (kp: InstanceType<typeof Keypair>, signature: string, resource: string) =>
    Buffer.from(nacl.sign.detached(new TextEncoder().encode(paymentMessage({ signature, resource, treasury: treasuryAta.toBase58() })), kp.secretKey)).toString("base64");
  const header = (signature: string, proofSignature: string, raw = false) => {
    const json = JSON.stringify({ signature, proofSignature });
    return raw ? json : Buffer.from(json).toString("base64");
  };

  /** A confirmed transaction carrying one USDC transfer into the treasury account. */
  function fakeTx(o: {
    from: InstanceType<typeof Keypair>;
    amount: bigint;
    checked?: boolean;
    inner?: boolean;
    token2022?: boolean;
    blockTime?: number | null;
    err?: unknown;
    ownerRow?: boolean;
    to?: InstanceType<typeof PublicKey>;
  }): PaymentTxResponse {
    const programId = o.token2022 ? TOKEN_2022_PROGRAM_ID : undefined;
    const source = getAssociatedTokenAddressSync(USDC_MINT, o.from.publicKey, false, programId);
    const to = o.to ?? treasuryAta;
    const ix =
      o.checked === false
        ? createTransferInstruction(source, to, o.from.publicKey, o.amount, [], programId)
        : createTransferCheckedInstruction(source, USDC_MINT, to, o.from.publicKey, o.amount, 6, [], programId);
    const tx = new Transaction({ feePayer: o.from.publicKey, blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }).add(ix);
    const message = tx.compileMessage();
    const keys = message.staticAccountKeys;
    const compiled = message.compiledInstructions;
    const sourceIndex = keys.findIndex((k) => k.equals(source));
    return {
      blockTime: o.blockTime === undefined ? Math.floor(clock / 1000) - 5 : o.blockTime,
      meta: {
        err: o.err ?? null,
        preTokenBalances: o.ownerRow === false ? [] : [{ accountIndex: sourceIndex, mint: USDC_MINT.toBase58(), owner: o.from.publicKey.toBase58() }],
        innerInstructions: o.inner
          ? [{ index: 0, instructions: compiled.map((ci) => ({ programIdIndex: ci.programIdIndex, accounts: ci.accountKeyIndexes, data: base58Encode(ci.data) })) }]
          : [],
        loadedAddresses: null,
      },
      transaction: { message: { staticAccountKeys: keys, compiledInstructions: o.inner ? [] : compiled } },
    };
  }
  const put = (tx: PaymentTxResponse): string => {
    const sig = randomSig();
    txs.set(sig, tx);
    return sig;
  };
  const usdc = (n: number) => BigInt(Math.round(n * 1e6));

  // ----- PaymentGate ------------------------------------------------------------------
  await test("requirements(): the exact 402 body for Solana", () => {
    const r = gate().requirements(0.01, "bands_pool_snapshot");
    assert.equal(r.x402Version, 1);
    assert.equal(r.accepts.length, 1);
    const a = r.accepts[0];
    assert.equal(a.scheme, "exact");
    assert.equal(a.network, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    assert.equal(a.asset, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    assert.equal(a.maxAmountRequired, "10000");
    assert.equal(a.resource, "bands_pool_snapshot");
    assert.equal(a.payTo, treasuryAta.toBase58());
    assert.equal(a.description, "bands.finance bands_pool_snapshot - $0.0100");
    assert.equal(r.proof.header, "X-PAYMENT");
    assert.equal(
      r.proof.signMessage,
      `bands.finance x402 payment authorization\nCluster: mainnet-beta\nTreasury: ${treasuryAta.toBase58()}\nResource: bands_pool_snapshot\nTx: <your payment tx signature>`,
    );
    assert.match(r.proof.format, /proofSignature/);
  });

  await test("paymentMessage() refuses a resource with a line break", () => {
    assert.throws(() => paymentMessage({ signature: "x", resource: "a\nb", treasury: "t" }), /line break/);
  });

  await test("isTxSignature accepts base58 of 64 bytes only", () => {
    assert.equal(isTxSignature(randomSig()), true);
    assert.equal(isTxSignature(base58Encode(nacl.randomBytes(32))), false);
    assert.equal(isTxSignature("0x" + "ab".repeat(32)), false);
    assert.equal(isTxSignature(42), false);
  });

  await test("modes: stub / refuse / self, and boot refusals", async () => {
    const stub = new PaymentGate({ connection: () => fakeConnection });
    assert.equal(stub.mode, "stub");
    assert.deepEqual(await stub.verify("anything", 0.01, "t"), { ok: true, stub: true });
    assert.equal(stub.requirements(0.02, "t").accepts[0].payTo, "unconfigured");
    const refuse = new PaymentGate({ treasury: treasuryOwner.publicKey.toBase58(), connection: () => fakeConnection });
    assert.equal(refuse.mode, "refuse");
    const r = await refuse.verify(header(randomSig(), "x"), 0.01, "t");
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /not configured/);
    assert.equal(gate().mode, "self");
    assert.throws(() => new PaymentGate({ treasury: "not-a-key", connection: () => fakeConnection }), /X402_TREASURY/);
    assert.throws(() => new PaymentGate({ verify: "self", connection: () => fakeConnection }), /requires X402_TREASURY/);
    assert.throws(() => new PaymentGate({ treasury: treasuryOwner.publicKey.toBase58(), verify: "https://x", connection: () => fakeConnection }), /X402_VERIFY/);
  });

  await test("self: a TransferChecked to the treasury with a valid proof verifies, burns and refuses replay", async () => {
    const g = gate();
    const sig = put(fakeTx({ from: payer, amount: usdc(0.01) }));
    const r = await g.verify(header(sig, proofFor(payer, sig, "bands_pool_snapshot")), 0.01, "bands_pool_snapshot");
    assert.deepEqual(r, { ok: true, signature: sig, payer: payer.publicKey.toBase58() });
    const rows = readLedger<{ signature: string; resource: string; amountUsd: number; at: number }>("x402-used.jsonl");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].signature, sig);
    assert.equal(rows[0].resource, "bands_pool_snapshot");
    assert.equal(rows[0].amountUsd, 0.01);
    const again = await g.verify(header(sig, proofFor(payer, sig, "bands_pool_snapshot")), 0.01, "bands_pool_snapshot");
    assert.deepEqual(again, { ok: false, error: "payment tx already used" });
    // a fresh gate instance folds the ledger, so the burn survives a restart
    const fresh = await gate().verify(header(sig, proofFor(payer, sig, "bands_pool_snapshot")), 0.01, "bands_pool_snapshot");
    assert.equal(fresh.ok, false);
  });

  await test("self: raw JSON header, plain Transfer, inner instruction and Token-2022 all count", async () => {
    const g = gate();
    const s1 = put(fakeTx({ from: payer, amount: usdc(0.05), checked: false }));
    assert.equal((await g.verify(header(s1, proofFor(payer, s1, "bands_pool_score"), true), 0.05, "bands_pool_score")).ok, true);
    const s2 = put(fakeTx({ from: payer, amount: usdc(0.02), inner: true }));
    assert.equal((await g.verify(header(s2, proofFor(payer, s2, "bands_screen")), 0.02, "bands_screen")).ok, true);
    const s3 = put(fakeTx({ from: payer, amount: usdc(0.02), token2022: true }));
    assert.equal((await g.verify(header(s3, proofFor(payer, s3, "bands_screen")), 0.02, "bands_screen")).ok, true);
  });

  await test("self: overpayment passes; the proof binds resource and tx", async () => {
    const g = gate();
    const sig = put(fakeTx({ from: payer, amount: usdc(1) }));
    const wrongResource = await g.verify(header(sig, proofFor(payer, sig, "bands_screen")), 0.01, "bands_pool_snapshot");
    assert.equal(wrongResource.ok, false);
    assert.match((wrongResource as { error: string }).error, /does not match the wallet/);
    const wrongTx = await g.verify(header(sig, proofFor(payer, randomSig(), "bands_pool_snapshot")), 0.01, "bands_pool_snapshot");
    assert.equal(wrongTx.ok, false);
    assert.equal((await g.verify(header(sig, proofFor(payer, sig, "bands_pool_snapshot")), 0.01, "bands_pool_snapshot")).ok, true);
  });

  await test("self: a proof from another wallet is refused (a tx signature is not a bearer token)", async () => {
    const thief = Keypair.generate();
    const sig = put(fakeTx({ from: payer, amount: usdc(0.01) }));
    const r = await gate().verify(header(sig, proofFor(thief, sig, "bands_pool_snapshot")), 0.01, "bands_pool_snapshot");
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, new RegExp(payer.publicKey.toBase58()));
  });

  await test("self: insufficient, too old, failed, missing, wrong destination, no balance row", async () => {
    const g = gate();
    const short = put(fakeTx({ from: payer, amount: usdc(0.009) }));
    assert.match((await g.verify(header(short, proofFor(payer, short, "t")), 0.01, "t") as { error: string }).error, /insufficient payment/);
    const old = put(fakeTx({ from: payer, amount: usdc(0.01), blockTime: Math.floor(clock / 1000) - MAX_AGE_SECONDS - 1 }));
    assert.match((await g.verify(header(old, proofFor(payer, old, "t")), 0.01, "t") as { error: string }).error, /too old/);
    const noTime = put(fakeTx({ from: payer, amount: usdc(0.01), blockTime: null }));
    assert.match((await g.verify(header(noTime, proofFor(payer, noTime, "t")), 0.01, "t") as { error: string }).error, /no block time/);
    const failedTx = put(fakeTx({ from: payer, amount: usdc(0.01), err: { InstructionError: [0, "Custom"] } }));
    assert.match((await g.verify(header(failedTx, proofFor(payer, failedTx, "t")), 0.01, "t") as { error: string }).error, /failed on chain/);
    const missing = randomSig();
    assert.match((await g.verify(header(missing, proofFor(payer, missing, "t")), 0.01, "t") as { error: string }).error, /not found/);
    const elsewhere = put(fakeTx({ from: payer, amount: usdc(0.01), to: getAssociatedTokenAddressSync(USDC_MINT, Keypair.generate().publicKey) }));
    assert.match((await g.verify(header(elsewhere, proofFor(payer, elsewhere, "t")), 0.01, "t") as { error: string }).error, /no USDC transfer to/);
    // no preTokenBalances row: the transfer authority stands in for the owner
    const noRow = put(fakeTx({ from: payer, amount: usdc(0.01), ownerRow: false }));
    assert.equal((await g.verify(header(noRow, proofFor(payer, noRow, "t")), 0.01, "t")).ok, true);
  });

  await test("self: malformed headers are refused before any RPC", async () => {
    const g = gate();
    assert.match((await g.verify("not json", 0.01, "t") as { error: string }).error, /X-PAYMENT must be JSON/);
    assert.match((await g.verify(header("0xdeadbeef", "x"), 0.01, "t") as { error: string }).error, /invalid signature/);
    assert.match((await g.verify(header(randomSig(), "not-a-signature"), 0.01, "t") as { error: string }).error, /missing proofSignature/);
  });

  await test("self: concurrent verifications of one signature settle exactly one call", async () => {
    const g = gate();
    const sig = put(fakeTx({ from: payer, amount: usdc(0.01) }));
    const h = header(sig, proofFor(payer, sig, "t"));
    const results = await Promise.all([g.verify(h, 0.01, "t"), g.verify(h, 0.01, "t"), g.verify(h, 0.01, "t")]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => !r.ok && /already being verified/.test((r as { error: string }).error)).length, 2);
  });

  await test("settleStranded: no proof needed, age ignored, replay and ambiguous payer refused", async () => {
    const g = gate();
    const old = put(fakeTx({ from: payer, amount: usdc(5), blockTime: Math.floor(clock / 1000) - 86_400 }));
    const r = await g.settleStranded(old, 5, "credits:starter");
    assert.deepEqual(r, { ok: true, payer: payer.publicKey.toBase58(), signature: old });
    assert.deepEqual(await g.settleStranded(old, 5, "credits:starter"), { ok: false, error: "payment tx already used" });
    // two payers in one tx: whose payment is it? refuse
    const other = Keypair.generate();
    const a = fakeTx({ from: payer, amount: usdc(3) });
    const b = fakeTx({ from: other, amount: usdc(3) });
    const merged: PaymentTxResponse = {
      blockTime: a.blockTime,
      meta: {
        err: null,
        preTokenBalances: [...(a.meta!.preTokenBalances ?? []), ...(b.meta!.preTokenBalances ?? []).map((row) => ({ ...row, accountIndex: row.accountIndex + a.transaction.message.staticAccountKeys.length }))],
        innerInstructions: [],
        loadedAddresses: null,
      },
      transaction: {
        message: {
          staticAccountKeys: [...a.transaction.message.staticAccountKeys, ...b.transaction.message.staticAccountKeys],
          compiledInstructions: [
            ...a.transaction.message.compiledInstructions,
            ...b.transaction.message.compiledInstructions.map((ci) => ({
              programIdIndex: ci.programIdIndex + a.transaction.message.staticAccountKeys.length,
              accountKeyIndexes: ci.accountKeyIndexes.map((i) => i + a.transaction.message.staticAccountKeys.length),
              data: ci.data,
            })),
          ],
        },
      },
    };
    const two = put(merged);
    const amb = await g.settleStranded(two, 5, "credits:starter");
    assert.equal(amb.ok, false);
    assert.match((amb as { error: string }).error, /ambiguous payer/);
    assert.match((await new PaymentGate({ connection: () => fakeConnection }).settleStranded(randomSig(), 1, "t") as { error: string }).error, /not configured/);
  });

  // ----- RevenueLedger ----------------------------------------------------------------
  await test("RevenueLedger: rows append to revenue.jsonl and totals fold from the file", () => {
    const a = new RevenueLedger();
    a.record("bands_screen", 0.02, "sig1");
    a.record("bands_pool_score", 0.05);
    a.record("bands_screen", 0.02, "sig2");
    assert.equal(a.totalRevenueUsd.toFixed(2), "0.09");
    assert.deepEqual(a.revenueByTool, { bands_screen: 0.04, bands_pool_score: 0.05 });
    const b = new RevenueLedger();
    assert.equal(b.totalRevenueUsd.toFixed(2), "0.09");
    const rows = readLedger<{ ts: number; tool: string; amountUsd: number; reference?: string }>("revenue.jsonl");
    assert.equal(rows.length, 3);
    assert.equal(rows[0].reference, "sig1");
    assert.equal(rows[1].reference, undefined);
    assert.equal(typeof rows[0].ts, "number");
  });

  // ----- X402Client -------------------------------------------------------------------
  await test("X402Client.settleChallenge refuses other networks, other assets and an unconfigured mode", async () => {
    const wallet = { publicKey: payer.publicKey, keypair: payer } as unknown as import("../tools/wallet.js").Wallet;
    const good = gate().requirements(0.01, "bands_pool_snapshot");
    const client = new X402Client(wallet, "self");
    await assert.rejects(client.settleChallenge({ ...good, accepts: [{ ...good.accepts[0], network: "robinhood-chain" }] }), /unsupported x402 network/);
    await assert.rejects(client.settleChallenge({ ...good, accepts: [{ ...good.accepts[0], asset: "So11111111111111111111111111111111111111112" }] }), /cannot pay/);
    await assert.rejects(client.settleChallenge({ ...good, accepts: [] }), /no payment terms/);
    await assert.rejects(new X402Client(wallet, "").settleChallenge(good), /X402_VERIFY is not configured/);
  });

  await test("extractChallenge finds the 402 body inside an MCP error message", () => {
    const req = gate().requirements(0.02, "bands_screen");
    const found = extractChallenge(`MCP error -32000: payment required ${JSON.stringify(req)} trailing text`);
    assert.equal(found?.accepts[0].maxAmountRequired, "20000");
    assert.equal(extractChallenge("nothing here"), null);
  });

  // ----- engine skill: the pure parts -------------------------------------------------
  await test("engine access fails closed; allowlist is case-sensitive; open is explicit", () => {
    const w = Keypair.generate().publicKey.toBase58();
    assert.deepEqual(engine.decideAccess([]), { ok: false, via: null, paths: [], detail: "engine access is not open yet" });
    assert.equal(engine.hasEngineAccess(w, { allowlist: "", open: "" }).ok, false);
    assert.equal(engine.hasEngineAccess(w, { allowlist: "", open: "TRUE " }).via, "open");
    const a = engine.hasEngineAccess(w, { allowlist: `${Keypair.generate().publicKey.toBase58()}, ${w}`, open: "true" });
    assert.equal(a.via, "allowlist");
    assert.deepEqual(a.paths, ["allowlist", "open"]);
    assert.equal(engine.hasEngineAccess(w, { allowlist: w.toLowerCase(), open: "" }).ok, false);
    assert.equal(engine.hasEngineAccess("0xDFF0Cf4f18dA55f931ae2A5a0770BaAD1e45D7fe", { allowlist: "", open: "true" }).ok, false);
    assert.equal(engine.parseAllowlist("junk, " + w).size, 1);
  });

  await test("parseSkillVersion reads the frontmatter and the shipped skill file has one", () => {
    assert.equal(engine.parseSkillVersion("---\nname: x\nversion: 3\n---"), "3");
    assert.equal(engine.parseSkillVersion("no frontmatter"), "unknown");
    const skill = fs.readFileSync(path.resolve(process.cwd(), "skills/bands-engine/SKILL.md"), "utf8");
    assert.equal(engine.parseSkillVersion(skill), "1");
  });

  await test("validatePlanInput: shape, integers, finiteness", () => {
    const pool = Keypair.generate().publicKey.toBase58();
    const good = engine.validatePlanInput({ pool, side: "SOL_ONLY", amountSol: 0.25, amountToken: 0, binsBelowActive: 19, binsAboveActive: 0, strategy: "Spot" });
    assert.equal(good.ok, true);
    assert.equal(engine.validatePlanInput({ pool: "nope", side: "SOL_ONLY", amountSol: 0.25, amountToken: 0, binsBelowActive: 19, binsAboveActive: 0, strategy: "Spot" }).ok, false);
    assert.equal(engine.validatePlanInput({ pool, side: "LONG", amountSol: 0.25, amountToken: 0, binsBelowActive: 19, binsAboveActive: 0, strategy: "Spot" }).ok, false);
    assert.equal(engine.validatePlanInput({ pool, side: "BOTH", amountSol: 0.1, amountToken: 1, binsBelowActive: 1.5, binsAboveActive: 0, strategy: "Spot" }).ok, false);
    assert.equal(engine.validatePlanInput({ pool, side: "BOTH", amountSol: -1, amountToken: 1, binsBelowActive: 1, binsAboveActive: 0, strategy: "Spot" }).ok, false);
    assert.equal(engine.validatePlanInput(null).ok, false);
  });

  await test("planDecision + callerGuardContext + verdictView: the guards judge a caller's band", async () => {
    const { evaluate } = await import("../risk/guards.js");
    const { riskLimits } = await import("../config.js");
    const snapshot: import("../tools/dlmm.js").PoolSnapshot = {
      address: "pool",
      label: "ANSEM/SOL",
      tokenX: { mint: "ansem", symbol: "ANSEM", decimals: 6, reserve: 5_000_000 },
      tokenY: { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9, reserve: 5000 },
      solSide: "Y",
      baseToken: { mint: "ansem", symbol: "ANSEM", decimals: 6, reserve: 5_000_000 },
      binStep: 20,
      activeBinId: 260,
      activePrice: 0.00168,
      priceLabel: "SOL per ANSEM",
      tokenPriceInSol: 0.00168,
      baseFeePct: 0.2,
      maxFeePct: 10,
      dynamicFeePct: 0.22,
      bins: [],
      liquidityBelowY: 180,
      liquidityAboveX: 100_000,
      fetchedAt: new Date().toISOString(),
    };
    const ctx = engine.callerGuardContext({ snapshot, positions: [], walletSol: 1, walletToken: 0 });
    assert.equal(ctx.state.actionsToday, 0);
    assert.equal(ctx.killSwitch, false);
    const ok = engine.verdictView(evaluate(engine.planDecision({ side: "SOL_ONLY", amountSol: 0.25, amountToken: 0, binsBelowActive: 19, binsAboveActive: 0, strategy: "Spot" }), ctx, riskLimits));
    assert.equal(ok.allowed, true);
    assert.deepEqual(ok.violations, []);
    const no = engine.verdictView(evaluate(engine.planDecision({ side: "SOL_ONLY", amountSol: 5, amountToken: 0, binsBelowActive: 19, binsAboveActive: 0, strategy: "Spot" }), ctx, riskLimits));
    assert.equal(no.allowed, false);
    assert.ok(no.violations.some((v) => /band size/.test(v)));
    assert.deepEqual(Object.keys(no).sort(), ["allowed", "emergency", "overrides", "passed", "violations"]);
  });

  await test("serializeUnsigned: fee payer set, position partially signed, caller's slot left empty", () => {
    const caller = Keypair.generate();
    const position = Keypair.generate();
    const tx = new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: caller.publicKey, newAccountPubkey: position.publicKey, lamports: 1, space: 0, programId: SystemProgram.programId }),
    );
    const b64 = engine.serializeUnsigned(tx, caller.publicKey, { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 42 }, [position]);
    const back = Transaction.from(Buffer.from(b64, "base64"));
    assert.equal(back.feePayer?.toBase58(), caller.publicKey.toBase58());
    assert.equal(back.recentBlockhash, "11111111111111111111111111111111");
    const sigs = new Map(back.signatures.map((s) => [s.publicKey.toBase58(), s.signature]));
    assert.equal(sigs.get(caller.publicKey.toBase58()), null);
    assert.ok(sigs.get(position.publicKey.toBase58()) instanceof Buffer);
    // the position's signature is real: the caller can add theirs and the tx verifies
    back.partialSign(caller);
    assert.equal(back.verifySignatures(), true);
  });

  // ----- proposals --------------------------------------------------------------------
  const pool = Keypair.generate().publicKey.toBase58();
  const openInput = { kind: "OPEN_BAND", pool, side: "SOL_ONLY", amountSol: 0.25, amountToken: 0, binsBelowActive: 19, binsAboveActive: 0, strategy: "Spot", rationale: "Fee/TVL of 1.2%/day measured on chain over 9h; SOL side only, below active." };

  await test("validateProposalInput: kinds, bounds, sanitized rationale", () => {
    const ok = proposals.validateProposalInput(openInput);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.params.kind, "OPEN_BAND");
    assert.match((proposals.validateProposalInput({ ...openInput, rationale: "too short" }) as { error: string }).error, /at least 20/);
    assert.match((proposals.validateProposalInput({ ...openInput, rationale: "x".repeat(601) }) as { error: string }).error, /600/);
    assert.match((proposals.validateProposalInput({ ...openInput, pool: "nope" }) as { error: string }).error, /pool/);
    assert.match((proposals.validateProposalInput({ ...openInput, binsBelowActive: 80 }) as { error: string }).error, /width/);
    assert.match((proposals.validateProposalInput({ ...openInput, amountSol: 0, amountToken: 0 }) as { error: string }).error, /deposit/);
    assert.match((proposals.validateProposalInput({ ...openInput, amountSol: 100 }) as { error: string }).error, /max per band/);
    assert.match((proposals.validateProposalInput({ kind: "CLOSE_BAND", pool, rationale: openInput.rationale }) as { error: string }).error, /position/);
    const close = proposals.validateProposalInput({ kind: "CLOSE_BAND", pool, position: Keypair.generate().publicKey.toBase58(), rationale: "  out of range‮ for 6h,\n no fees   " });
    assert.equal(close.ok, true);
    if (close.ok) assert.equal(close.rationale, "out of range for 6h, no fees");
    assert.match((proposals.validateProposalInput({ kind: "lp-open", pool, rationale: openInput.rationale }) as { error: string }).error, /kind/);
  });

  await test("canPropose: 2 pending + 10/day per proposer, 40 pending global", () => {
    const now = Date.now();
    const mk = (proposerId: string, status: ProposalStatus, at = now): Proposal => ({ id: Math.random().toString(36), proposerId, proposerName: "a", kind: "CLOSE_BAND", params: { pool, position: pool }, rationale: "r", at, status });
    assert.equal(proposals.canPropose([mk("a", "pending"), mk("a", "pending")], "a", now).ok, false);
    assert.equal(proposals.canPropose([mk("a", "pending"), mk("a", "rejected")], "a", now).ok, true);
    assert.equal(proposals.canPropose(Array.from({ length: 10 }, () => mk("a", "rejected")), "a", now).ok, false);
    assert.equal(proposals.canPropose(Array.from({ length: 10 }, () => mk("a", "rejected", now - 25 * 3600e3)), "a", now).ok, true);
    assert.equal(proposals.canPropose(Array.from({ length: 40 }, (_, i) => mk(`p${i}`, "pending")), "new", now).ok, false);
  });

  await test("submit / list / decide / approvedProposals / markExecuted through proposals.jsonl, latest row wins", () => {
    const me = Keypair.generate().publicKey.toBase58();
    const r1 = proposals.submitProposal({ ...openInput, proposerId: me, proposerName: "tester" });
    assert.equal(r1.ok, true);
    if (!r1.ok) return;
    assert.equal(r1.proposal.status, "pending");
    assert.equal(r1.proposal.proposerName, "tester");
    const r2 = proposals.submitProposal({ ...openInput, proposerId: me });
    assert.equal(r2.ok, true);
    assert.equal(proposals.submitProposal({ ...openInput, proposerId: me }).ok, false);
    assert.equal(proposals.listProposals(10, "pending").length >= 2, true);
    assert.equal(proposals.decideProposal("nope", "approve"), null);
    const approved = proposals.decideProposal(r1.proposal.id, "approve", "measured fees, bounded size");
    assert.equal(approved?.status, "approved");
    assert.equal(approved?.decisionNote, "measured fees, bounded size");
    assert.equal(proposals.decideProposal(r1.proposal.id, "reject"), null, "only pending proposals can be decided");
    assert.deepEqual(proposals.approvedProposals(pool).map((p) => p.id), [r1.proposal.id]);
    assert.deepEqual(proposals.approvedProposals(Keypair.generate().publicKey.toBase58()), []);
    proposals.resetProposalCache();
    assert.equal(proposals.getProposal(r1.proposal.id)?.status, "approved", "a fresh fold keeps the latest row");
    const done = proposals.markExecuted(r1.proposal.id, "journal-1");
    assert.equal(done?.status, "executed");
    assert.equal(done?.journalId, "journal-1");
    assert.deepEqual(proposals.approvedProposals(pool), []);
    assert.equal(proposals.markExecuted(r1.proposal.id, "journal-2"), null);
    const rows = readLedger<{ id: string; status: string }>("proposals.jsonl").filter((r) => r.id === r1.proposal.id);
    assert.deepEqual(rows.map((r) => r.status), ["pending", "approved", "executed"]);
  });

  await test("pending proposals expire after 24h on the next read", () => {
    const stale = proposals.submitProposal({ ...openInput, proposerId: Keypair.generate().publicKey.toBase58(), now: Date.now() - proposals.PROPOSAL_TTL_MS - 1000 });
    assert.equal(stale.ok, true);
    if (!stale.ok) return;
    assert.equal(proposals.getProposal(stale.proposal.id)?.status, "expired");
  });

  // ----- MCP policy (pure) ------------------------------------------------------------
  await test("tool prices: defaults, free when 0 or absent; operator gate fails closed", () => {
    assert.equal(mcp.toolPriceUsd("bands_pool_snapshot"), 0.01);
    assert.equal(mcp.toolPriceUsd("bands_screen"), 0.02);
    assert.equal(mcp.toolPriceUsd("bands_pool_score"), 0.05);
    assert.equal(mcp.toolPriceUsd("bands_agent_thoughts"), 0);
    assert.equal(mcp.toolPriceUsd("bands_list_pools"), 0);
    assert.equal(mcp.toolPriceUsd("unknown_tool"), 0);
    assert.equal(rails.mcpRequestAllowed({ method: "tools/list" }, undefined), true);
    assert.equal(rails.mcpRequestAllowed({ method: "tools/call", params: { name: "bands_screen" } }, undefined), true);
    assert.equal(rails.mcpRequestAllowed({ method: "tools/call", params: { name: "bands_decide_proposal" } }, undefined), false);
    assert.equal(rails.mcpRequestAllowed({ method: "tools/call", params: { name: "bands_decide_proposal" } }, "Bearer wrong"), false);
    assert.equal(rails.mcpRequestAllowed({ method: "tools/call", params: { name: "bands_decide_proposal" } }, "Bearer op-test-token"), true);
    assert.equal(rails.mcpAudience("Bearer op-test-token"), "operator");
    assert.equal(rails.mcpAudience(undefined), "public");
    const saved = process.env.PLATFORM_OPERATOR_TOKEN;
    process.env.PLATFORM_OPERATOR_TOKEN = "";
    assert.equal(mcp.operatorAuthorized("Bearer "), false);
    assert.equal(mcp.operatorAuthorized("Bearer op-test-token"), false, "no configured token = nobody is the operator");
    process.env.PLATFORM_OPERATOR_TOKEN = saved;
  });

  await test("checkPayment: free passes, priced without header is a 402, verified payment records revenue", async () => {
    const g = gate();
    const rev = new RevenueLedger();
    const before = rev.totalRevenueUsd;
    assert.equal(await rails.checkPayment(g, rev, { method: "tools/list" }, undefined), null);
    assert.equal(await rails.checkPayment(g, rev, { method: "tools/call", params: { name: "bands_limits" } }, undefined), null);
    const p = await rails.checkPayment(g, rev, { method: "tools/call", params: { name: "bands_pool_score" } }, undefined);
    assert.equal(p?.status, 402);
    assert.equal((p?.body as { accepts: Array<{ maxAmountRequired: string }> }).accepts[0].maxAmountRequired, "50000");
    const bad = await rails.checkPayment(g, rev, { method: "tools/call", params: { name: "bands_pool_score" } }, "garbage");
    assert.equal(bad?.status, 402);
    assert.match((bad?.body as { error: string }).error, /X-PAYMENT must be JSON/);
    const sig = put(fakeTx({ from: payer, amount: usdc(0.05) }));
    assert.equal(await rails.checkPayment(g, rev, { method: "tools/call", params: { name: "bands_pool_score" } }, header(sig, proofFor(payer, sig, "bands_pool_score"))), null);
    assert.equal((rev.totalRevenueUsd - before).toFixed(2), "0.05");
    assert.equal(readLedger<{ reference?: string }>("revenue.jsonl").at(-1)?.reference, sig);
    // stub mode: the call passes, nothing is recorded as revenue
    const stubBefore = rev.totalRevenueUsd;
    assert.equal(await rails.checkPayment(new PaymentGate({ connection: () => fakeConnection }), rev, { method: "tools/call", params: { name: "bands_pool_score" } }, "anything"), null);
    assert.equal(rev.totalRevenueUsd, stubBefore);
  });

  // ----- the routes, through Hono ----------------------------------------------------
  const app = new Hono();
  rails.railsRoutes(app);
  const me = Keypair.generate();
  const bearer = `Bearer ${mintSession(me.publicKey.toBase58()).token}`;
  const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const rpc = (body: unknown, extra: Record<string, string> = {}) => app.request("/mcp", { method: "POST", headers: { ...mcpHeaders, ...extra }, body: JSON.stringify(body) });
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } };

  await test("POST /mcp: initialize opens a session; tools/list is served; batches and sessionless calls are refused", async () => {
    const batch = await rpc([init]);
    assert.equal(batch.status, 400);
    assert.match(((await batch.json()) as { error: { message: string } }).error.message, /batched requests are not accepted/);
    const noSession = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(noSession.status, 400);
    const parse = await app.request("/mcp", { method: "POST", headers: mcpHeaders, body: "{not json" });
    assert.equal(parse.status, 400);
    const r = await rpc(init);
    assert.equal(r.status, 200);
    const sid = r.headers.get("mcp-session-id");
    assert.ok(sid, "initialize must mint a session id");
    const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": sid! });
    assert.equal(list.status, 200);
    const names = ((await list.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["bands_agent_thoughts", "bands_limits", "bands_list_pools", "bands_pool_score", "bands_pool_snapshot", "bands_propose_band_action", "bands_screen"]);
    assert.ok(!names.includes("bands_decide_proposal"), "the public audience is not served operator tools");
    const unknown = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { "mcp-session-id": "not-a-session" });
    assert.equal(unknown.status, 400);
  });

  await test("POST /mcp: a priced tool without X-PAYMENT is a 402 with the exact body; a free tool answers; stub payment passes", async () => {
    const sid = (await rpc(init)).headers.get("mcp-session-id")!;
    const paid = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "bands_pool_snapshot", arguments: { pool } } }, { "mcp-session-id": sid });
    assert.equal(paid.status, 402);
    const body = (await paid.json()) as { x402Version: number; accepts: Array<Record<string, string>>; proof: { header: string } };
    assert.equal(body.x402Version, 1);
    assert.equal(body.accepts[0].network, SOLANA_MAINNET_CAIP2);
    assert.equal(body.accepts[0].payTo, "unconfigured");
    assert.equal(body.accepts[0].maxAmountRequired, "10000");
    assert.equal(body.proof.header, "X-PAYMENT");
    const free = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "bands_limits", arguments: {} } }, { "mcp-session-id": sid });
    assert.equal(free.status, 200);
    const text = ((await free.json()) as { result: { content: Array<{ text: string }> } }).result.content[0].text;
    assert.ok(JSON.parse(text).limits.maxPositionSol > 0);
    // this host has no screen.json: the paywall passes in stub mode and the tool says so honestly
    const scored = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "bands_pool_score", arguments: { pool } } }, { "mcp-session-id": sid, "x-payment": "stub" });
    assert.equal(scored.status, 200);
    const out = JSON.parse(((await scored.json()) as { result: { content: Array<{ text: string }> } }).result.content[0].text);
    assert.equal(out.ok, false);
    assert.match(out.error, /no screen yet/);
    const operatorOnly = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "bands_decide_proposal", arguments: { id: "x", decision: "approve" } } }, { "mcp-session-id": sid });
    assert.equal(operatorOnly.status, 401);
  });

  await test("POST /mcp: the proposals tool writes a proposal for a claimed name; the operator audience can decide it", async () => {
    const sid = (await rpc(init)).headers.get("mcp-session-id")!;
    const args = { ...openInput, agentName: "scout-7" };
    const dry = await rpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "bands_propose_band_action", arguments: { ...args, dryRun: true } } }, { "mcp-session-id": sid });
    const dryOut = JSON.parse(((await dry.json()) as { result: { content: Array<{ text: string }> } }).result.content[0].text);
    assert.equal(dryOut.dryRun, true);
    assert.equal(dryOut.ok, true);
    const real = await rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "bands_propose_band_action", arguments: args } }, { "mcp-session-id": sid });
    const out = JSON.parse(((await real.json()) as { result: { content: Array<{ text: string }> } }).result.content[0].text);
    assert.equal(out.ok, true);
    assert.equal(out.status, "pending");
    const stored = proposals.getProposal(out.id)!;
    assert.match(stored.proposerId, /^mcp:[0-9a-f]{12}$/);
    assert.equal(stored.proposerName, "scout-7");
    const opInit = await rpc(init, { authorization: "Bearer op-test-token" });
    const opSid = opInit.headers.get("mcp-session-id")!;
    const opList = await rpc({ jsonrpc: "2.0", id: 10, method: "tools/list" }, { "mcp-session-id": opSid, authorization: "Bearer op-test-token" });
    assert.ok(((await opList.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.some((t) => t.name === "bands_decide_proposal"));
    const decided = await rpc({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "bands_decide_proposal", arguments: { id: out.id, decision: "reject", note: "not this pool" } } }, { "mcp-session-id": opSid, authorization: "Bearer op-test-token" });
    assert.equal(decided.status, 200);
    assert.equal(proposals.getProposal(out.id)?.status, "rejected");
  });

  await test("engine routes: 401 without a session, access opens with ENGINE_OPEN, skill served with its version, plan validates", async () => {
    assert.equal((await app.request("/api/engine/access")).status, 401);
    const access = await app.request("/api/engine/access", { headers: { authorization: bearer } });
    assert.equal(access.status, 200);
    assert.deepEqual(await access.json(), { ok: true, hasAccess: true, via: "open", paths: ["open"], detail: "Engine access: open to every signed-in wallet." });
    const skill = await app.request("/api/engine/skill", { headers: { authorization: bearer } });
    assert.equal(skill.status, 200);
    assert.match(skill.headers.get("content-type") ?? "", /text\/markdown/);
    assert.equal(skill.headers.get("x-bands-skill-version"), "1");
    assert.match(await skill.text(), /never holds your keys/);
    const badPlan = await app.request("/api/engine/plan", { method: "POST", headers: { authorization: bearer, "content-type": "application/json" }, body: JSON.stringify({ pool: "x" }) });
    assert.equal(badPlan.status, 400);
    const badClose = await app.request("/api/engine/close", { method: "POST", headers: { authorization: bearer, "content-type": "application/json" }, body: JSON.stringify({ pool }) });
    assert.equal(badClose.status, 400);
    process.env.ENGINE_OPEN = "false";
    const closed = await app.request("/api/engine/skill", { headers: { authorization: bearer } });
    assert.equal(closed.status, 403);
    assert.deepEqual(await closed.json(), { ok: false, error: "engine access is not open yet" });
    process.env.ENGINE_OPEN = "true";
  });

  await test("proposal routes: public board, session to propose, operator bearer to decide", async () => {
    assert.equal((await app.request("/api/proposals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(openInput) })).status, 401);
    const posted = await app.request("/api/proposals", { method: "POST", headers: { authorization: bearer, "content-type": "application/json" }, body: JSON.stringify(openInput) });
    assert.equal(posted.status, 200);
    const { proposal } = (await posted.json()) as { proposal: Proposal };
    assert.equal(proposal.proposerId, me.publicKey.toBase58());
    const board = (await (await app.request("/api/proposals?status=pending")).json()) as { ok: boolean; proposals: Proposal[] };
    assert.ok(board.proposals.some((p) => p.id === proposal.id));
    const noOp = await app.request("/api/proposals/decide", { method: "POST", headers: { authorization: bearer, "content-type": "application/json" }, body: JSON.stringify({ id: proposal.id, decision: "approve" }) });
    assert.equal(noOp.status, 401);
    const bad = await app.request("/api/proposals/decide", { method: "POST", headers: { authorization: "Bearer op-test-token", "content-type": "application/json" }, body: JSON.stringify({ id: proposal.id, decision: "maybe" }) });
    assert.equal(bad.status, 400);
    const ok = await app.request("/api/proposals/decide", { method: "POST", headers: { authorization: "Bearer op-test-token", "content-type": "application/json" }, body: JSON.stringify({ id: proposal.id, decision: "approve", note: "bounded, cited fees" }) });
    assert.equal(ok.status, 200);
    assert.ok(proposals.approvedProposals(pool).some((p) => p.id === proposal.id));
    const twice = await app.request("/api/proposals/decide", { method: "POST", headers: { authorization: "Bearer op-test-token", "content-type": "application/json" }, body: JSON.stringify({ id: proposal.id, decision: "reject" }) });
    assert.equal(twice.status, 404);
  });

  await test("GET /api/revenue and /integrate.md answer; settle needs the operator", async () => {
    const rev = (await (await app.request("/api/revenue")).json()) as { ok: boolean; x402: { mode: string; network: string }; prices: Record<string, number> };
    assert.equal(rev.ok, true);
    assert.equal(rev.x402.mode, "stub");
    assert.equal(rev.x402.network, SOLANA_MAINNET_CAIP2);
    assert.equal(rev.prices.bands_screen, 0.02);
    const doc = await app.request("http://bands.test/integrate.md");
    assert.equal(doc.status, 200);
    const md = await doc.text();
    assert.match(md, /http:\/\/bands\.test\/mcp/);
    assert.match(md, /bands_propose_band_action/);
    assert.ok(!md.includes("{{BASE}}"));
    assert.equal((await app.request("/api/revenue/settle", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
    const settle = await app.request("/api/revenue/settle", { method: "POST", headers: { authorization: "Bearer op-test-token", "content-type": "application/json" }, body: JSON.stringify({ signature: randomSig(), resource: "bands_screen" }) });
    assert.equal(settle.status, 400, "stub mode has no chain to settle against");
  });

  await test("POST /api/credits/buy: 402 with the pack's terms, then a (stub) payment credits the wallet", async () => {
    assert.equal((await app.request("/api/credits/buy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pack: "starter" }) })).status, 401);
    const unknown = await app.request("/api/credits/buy", { method: "POST", headers: { authorization: bearer, "content-type": "application/json" }, body: JSON.stringify({ pack: "mega" }) });
    assert.equal(unknown.status, 400);
    const challenge = await app.request("/api/credits/buy", { method: "POST", headers: { authorization: bearer, "content-type": "application/json" }, body: JSON.stringify({ pack: "starter" }) });
    assert.equal(challenge.status, 402);
    const terms = (await challenge.json()) as { accepts: Array<{ resource: string; maxAmountRequired: string }> };
    assert.equal(terms.accepts[0].resource, "credits:starter");
    assert.equal(terms.accepts[0].maxAmountRequired, "5000000");
    const bought = await app.request("/api/credits/buy", { method: "POST", headers: { authorization: bearer, "content-type": "application/json", "x-payment": "stub" }, body: JSON.stringify({ pack: "starter" }) });
    assert.equal(bought.status, 200);
    const out = (await bought.json()) as { ok: boolean; credits: number; balance: number; stub: boolean };
    assert.equal(out.ok, true);
    assert.equal(out.credits, 200);
    assert.ok(out.balance >= 200);
    assert.equal(out.stub, true);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed === 0) fs.rmSync(path.resolve(process.cwd(), TEST_DIR), { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
