/**
 * The real-money path, offline: the 22 Sep review's money findings (M1-M9), each against the code that runs live.
 *   npm run test:money-path
 * DRY_RUN=false with a throwaway key and a FAKE chain: every RPC the wallet and the executor make is answered here,
 * a "send" is recorded and never leaves the process, a position account's lamports are scripted, and Jupiter's fetch
 * is replaced by one that refuses (a test that reached Jupiter would fail loudly). No network, no funds.
 * Covers: Token-2022 transfer fees read off the mint, booked from the transaction and charged in paper, and a scaled-UI
 * mint (the xStocks) booked and sold in its raw units, not the RPC's multiplied uiAmount (M1); the
 * compute-unit price on Meteora transactions, urgent on an emergency close, capped (M2); a landed transaction whose
 * confirmation was lost is found by its signature (M3); the close books the rent the account held, not 0.0574 (M4;
 * the site's side is in test-web-model); a straddle re-lay does not buy on one stale read (M5);
 * a rehearsal books nothing on the live state (M6); a blind held pool still counts against the limits (M7); the live
 * memecoin floor is 30 days (M8); the board prices a Meteora pool at base + variable (M9).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  Transaction,
  TransactionExpiredBlockheightExceededError,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import { ExtensionType, TransferFeeConfigLayout, TRANSFER_FEE_CONFIG_SIZE, type Mint } from "@solana/spl-token";
import type { Decision } from "../agent/schema";
import type { Verdict } from "../risk/guards";
import type { RiskState } from "../risk/state";
import type { PoolSnapshot, PositionSnapshot } from "../tools/dlmm";
import type { TransferFee } from "../tools/transferFee";

// Everything that reads src/config.ts is imported after the environment is pinned: a live process with a throwaway key.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mr-bands-money-"));
process.env.DATA_DIR = tmp;
process.env.DRY_RUN = "false";
process.env.WALLET_SECRET_KEY = JSON.stringify([...Keypair.generate().secretKey]);
process.env.EXPECTED_WALLET = "";
process.env.PAPER_SOL = "";
process.env.ANTHROPIC_API_KEY = "";
for (const k of ["TRADABLE_VENUES", "LIVE_VENUES", "PRIORITY_FEE_MICROLAMPORTS", "PRIORITY_FEE_MIN_MICROLAMPORTS", "PRIORITY_FEE_URGENT_MULTIPLE", "PRIORITY_FEE_MAX_LAMPORTS", "SWAP_IMPACT_SWEEP_PCT", "SWAP_IMPACT_EXIT_PCT"]) delete process.env[k];

// Jupiter is never reached on these paths; if it is, the test says so. A test that means to sell sets `jupiter` and answers it.
const jupCalls: string[] = [];
let jupiterStub: ((url: URL, body: Record<string, unknown> | null) => unknown) | null = null;
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  jupCalls.push(String(input));
  if (!jupiterStub) throw new Error("offline: no network in the money-path tests");
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
  return new Response(JSON.stringify(jupiterStub(new URL(String(input)), body)), { status: 200 });
}) as typeof fetch;

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}
const near = (a: number, b: number, eps = 1e-9, msg?: string) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? "near"}: ${a} vs ${b}`);

const SOL_MINT = "So11111111111111111111111111111111111111112";
const LB_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const LB_PAIR = Keypair.generate().publicKey;
const MEME = Keypair.generate().publicKey.toBase58();
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const FEE_LAMPORTS = 5000;

type Outcome = "ok" | "lost-landed" | "lost-not-landed" | "preflight" | "onchain-err";
interface Effect {
  /** SOL into (+) or out of (-) the wallet, before the network fee */
  sol?: number;
  /** UI token deltas by mint */
  tokens?: Record<string, number>;
}
interface Sent {
  signature: string;
  tx: Transaction | VersionedTransaction;
  outcome: Outcome;
  landed: boolean;
  pre: { lamports: number; tokens: Map<string, number> };
  post: { lamports: number; tokens: Map<string, number> };
}

/** The chain, as far as the wallet and the executor ask it anything. Sends are recorded, never forwarded. */
class FakeChain {
  lamports: number;
  tokens = new Map<string, number>();
  decimals = new Map<string, number>([[MEME, 6]]);
  accountLamports = new Map<string, number>();
  failBalance = new Set<string>();
  outcomes: Outcome[] = [];
  effects: (Effect | null)[] = [];
  sends: Sent[] = [];
  noTokenMeta = false;
  /** a ScaledUiAmount mint (the xStocks): the RPC reports the transaction's token balances with uiAmount = raw x this, amount raw */
  uiMultiplier = new Map<string, number>();
  /** after each landed send, this many token-balance reads still return the balance from before it */
  staleReadsAfterSend = 0;
  private staleLeft = 0;
  private staleTokens = new Map<string, number>();
  tokenReads = 0;
  prioFees: number[] = [];
  prioAsked: string[][] = [];
  statusAsked: { signature: string; searchTransactionHistory: boolean }[] = [];
  constructor(private readonly owner: PublicKey, sol: number) {
    this.lamports = Math.round(sol * 1e9);
  }
  get connection(): Connection {
    return this as unknown as Connection;
  }
  async getLatestBlockhash() {
    return { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 };
  }
  async getBalance(key: PublicKey) {
    const k = key.toBase58();
    if (k === this.owner.toBase58()) return this.lamports;
    if (this.failBalance.has(k)) throw new Error("429 Too Many Requests");
    return this.accountLamports.get(k) ?? 0;
  }
  async getParsedTokenAccountsByOwner(_owner: PublicKey, filter: { mint: PublicKey }) {
    this.tokenReads++;
    const mint = filter.mint.toBase58();
    let ui = this.tokens.get(mint) ?? 0;
    if (this.staleLeft > 0) {
      this.staleLeft--;
      ui = this.staleTokens.get(mint) ?? 0;
    }
    const dec = this.decimals.get(mint) ?? 6;
    return { value: ui > 0 ? [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(Math.round(ui * 10 ** dec)), decimals: dec } } } } } }] : [] };
  }
  async getRecentPrioritizationFees(cfg?: { lockedWritableAccounts?: PublicKey[] }) {
    this.prioAsked.push((cfg?.lockedWritableAccounts ?? []).map((k) => k.toBase58()));
    return this.prioFees.map((f, i) => ({ slot: i, prioritizationFee: f }));
  }
  async sendRawTransaction(raw: Uint8Array) {
    const { base58Encode } = await import("../tools/wallet.js");
    // Jupiter's swaps are versioned, the venue's legacy
    let tx: Transaction | VersionedTransaction;
    try {
      tx = Transaction.from(Buffer.from(raw));
    } catch {
      tx = VersionedTransaction.deserialize(raw);
    }
    const signature = base58Encode(tx instanceof Transaction ? tx.signature! : tx.signatures[0]);
    let outcome = this.outcomes.shift() ?? "ok";
    const effect = this.effects.shift() ?? null;
    // as on chain: a transfer of more than the wallet holds fails its simulation
    if (effect && Object.entries(effect.tokens ?? {}).some(([mint, d]) => (this.tokens.get(mint) ?? 0) + d < -1e-9)) outcome = "preflight";
    if (outcome === "preflight") throw new SendTransactionError({ action: "send", signature, transactionMessage: "Transaction simulation failed: Error processing Instruction 0", logs: [] });
    const landed = outcome === "ok" || outcome === "lost-landed" || outcome === "onchain-err";
    const pre = { lamports: this.lamports, tokens: new Map(this.tokens) };
    if (landed) {
      this.lamports -= FEE_LAMPORTS * tx.signatures.length;
      if (outcome !== "onchain-err" && effect) {
        this.lamports += Math.round((effect.sol ?? 0) * 1e9);
        for (const [mint, d] of Object.entries(effect.tokens ?? {})) this.tokens.set(mint, (this.tokens.get(mint) ?? 0) + d);
      }
      this.staleLeft = this.staleReadsAfterSend;
      this.staleTokens = pre.tokens;
    }
    this.sends.push({ signature, tx, outcome, landed, pre, post: { lamports: this.lamports, tokens: new Map(this.tokens) } });
    return signature;
  }
  async confirmTransaction(strategy: { signature: string }) {
    const s = this.sends.find((x) => x.signature === strategy.signature);
    if (!s) throw new Error(`confirm: unknown signature ${strategy.signature}`);
    if (s.outcome === "lost-landed" || s.outcome === "lost-not-landed") throw new TransactionExpiredBlockheightExceededError(s.signature);
    if (s.outcome === "onchain-err") return { context: { slot: 1 }, value: { err: { InstructionError: [0, { Custom: 6004 }] } } };
    return { context: { slot: 1 }, value: { err: null } };
  }
  async getSignatureStatuses(sigs: string[], opts?: { searchTransactionHistory?: boolean }) {
    this.statusAsked.push({ signature: sigs[0], searchTransactionHistory: opts?.searchTransactionHistory === true });
    const s = this.sends.find((x) => x.signature === sigs[0]);
    if (!s || !s.landed) return { context: { slot: 1 }, value: [null] };
    return { context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, confirmationStatus: "confirmed", err: s.outcome === "onchain-err" ? { InstructionError: [0, { Custom: 6004 }] } : null }] };
  }
  async getTransaction(signature: string) {
    const s = this.sends.find((x) => x.signature === signature);
    if (!s || !s.landed) return null;
    const owner = this.owner.toBase58();
    const row = (mint: string, ui: number, i: number) => {
      const dec = this.decimals.get(mint) ?? 6;
      const shown = ui * (this.uiMultiplier.get(mint) ?? 1);
      return { accountIndex: 1 + i, mint, owner, uiTokenAmount: { amount: String(Math.round(ui * 10 ** dec)), decimals: dec, uiAmount: shown, uiAmountString: String(shown) } };
    };
    const rows = (m: Map<string, number>) => (this.noTokenMeta ? [] : [...m.entries()].map(([mint, ui], i) => row(mint, ui, i)));
    return { slot: 1, meta: { fee: FEE_LAMPORTS * s.tx.signatures.length, err: null, preBalances: [s.pre.lamports], postBalances: [s.post.lamports], preTokenBalances: rows(s.pre.tokens), postTokenBalances: rows(s.post.tokens) } };
  }
}

/** A Meteora-shaped instruction touching the lb pair (writable) and signed by the owner (and a fresh position key on an open). */
const lbIx = (owner: PublicKey, signers: PublicKey[] = []) =>
  new TransactionInstruction({ programId: LB_PROGRAM, keys: [{ pubkey: LB_PAIR, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: true }, ...signers.map((k) => ({ pubkey: k, isSigner: true, isWritable: true }))], data: Buffer.from([7]) });
const lbTx = (owner: PublicKey, signers: PublicKey[] = []) => {
  const tx = new Transaction().add(lbIx(owner, signers));
  tx.feePayer = owner;
  return tx;
};

/** The compute-unit price a sent legacy transaction carries, or null. */
const priceOf = (tx: Transaction | VersionedTransaction): number | null => {
  if (tx instanceof VersionedTransaction) return null;
  const ix = tx.instructions.find((i) => i.programId.equals(ComputeBudgetProgram.programId) && i.data[0] === 3);
  return ix ? Number(ix.data.readBigUInt64LE(1)) : null;
};

const POOL = Keypair.generate().publicKey.toBase58();

function snap(fee: TransferFee | null = null, over: Partial<PoolSnapshot> = {}): PoolSnapshot {
  const token = { mint: MEME, symbol: "MEME", decimals: 6, reserve: 1e9, ...(fee ? { transferFee: fee } : {}) };
  const sol = { mint: SOL_MINT, symbol: "SOL", decimals: 9, reserve: 1000 };
  return {
    address: POOL, label: "MEME/SOL", tokenX: token, tokenY: sol, solSide: "Y", baseToken: token, binStep: 100, activeBinId: 0, activePrice: 0.0001, priceLabel: "SOL per MEME",
    tokenPriceInSol: 0.0001, quoteSide: "Y", quoteToken: sol, quoteSymbol: "SOL", quotePriceInSol: 1, tokenPriceInQuote: 0.0001, baseFeePct: 1, maxFeePct: 5, dynamicFeePct: 1,
    bins: [], liquidityBelowY: 100, liquidityAboveX: 1e6, fetchedAt: new Date().toISOString(), priceModel: "meteora-dlmm", venue: "meteora-dlmm",
    dlmm: { initializedBinArrays: [-2, -1, 0, 1, 2], readBinArrays: [-2, -1, 0, 1, 2] },
    ...over,
  };
}

function pos(o: { tokens?: number; sol?: number; feeToken?: number; feeSol?: number; entry?: number } = {}): PositionSnapshot {
  const tokens = o.tokens ?? 0, sol = o.sol ?? 0, feeToken = o.feeToken ?? 0, feeSol = o.feeSol ?? 0;
  return {
    address: Keypair.generate().publicKey.toBase58(), lowerBinId: -10, upperBinId: 0, lowerPrice: 0.00009, upperPrice: 0.0001, widthBins: 11, inRange: true, binsFromRange: 0,
    amountX: tokens, amountY: sol, feeX: feeToken, feeY: feeSol, valueInSol: sol + feeSol + (tokens + feeToken) * 0.0001, solInPosition: sol + feeSol, quoteInPosition: sol + feeSol,
    lastUpdatedAt: 0, entryValueSol: o.entry,
  };
}

const verdictOf = (d: Decision, emergency = false): Verdict => ({ proposal: d, decision: d, allowed: true, violations: [], overrides: [], passed: [], emergency });
const closeOf = (p: PositionSnapshot, over: Partial<Decision> = {}): Decision => ({ action: "CLOSE_POSITION", open: null, positionAddress: p.address, reasoning: "r", confidence: 0.8, headline: "h", ...over });

/** A Token-2022 mint with a TransferFeeConfig, as spl-token unpacks one: the TLV after the account type. */
function feeMint(olderBps: number, newerBps: number, maxRaw: bigint, decimals = 6): Pick<Mint, "tlvData" | "decimals"> {
  const data = Buffer.alloc(TRANSFER_FEE_CONFIG_SIZE);
  TransferFeeConfigLayout.encode(
    {
      transferFeeConfigAuthority: PublicKey.default,
      withdrawWithheldAuthority: PublicKey.default,
      withheldAmount: 0n,
      olderTransferFee: { epoch: 0n, maximumFee: maxRaw, transferFeeBasisPoints: olderBps },
      newerTransferFee: { epoch: 900n, maximumFee: maxRaw, transferFeeBasisPoints: newerBps },
    },
    data,
  );
  const head = Buffer.alloc(4);
  head.writeUInt16LE(ExtensionType.TransferFeeConfig, 0);
  head.writeUInt16LE(TRANSFER_FEE_CONFIG_SIZE, 2);
  return { tlvData: Buffer.concat([head, data]), decimals };
}

async function main(): Promise<void> {
  const { execute } = await import("../executor.js");
  const { Wallet, TransactionFailedError, base58Encode } = await import("../tools/wallet.js");
  const { meteoraVenue } = await import("../venues/meteora.js");
  const tf = await import("../tools/transferFee.js");
  const prio = await import("../tools/priorityFee.js");
  const { POSITION_RENT_NOW_SOL, POSITION_RENT_SOL } = await import("../tools/dlmm.js");
  const { realizedOnDaySol, dayOf } = await import("../engine/ledger.js");
  const paper = await import("../paper/index.js");
  const { executePaper } = await import("../paper/executor.js");
  const { paperSummary } = await import("../paper/report.js");
  const { bookExecution } = await import("../engine/bookkeeping.js");
  const { blindExposure } = await import("../engine/marks.js");
  const { meteoraBoardFees } = await import("../screener/scan.js");
  const { boardFee } = await import("../hot/index.js");
  const { config } = await import("../config.js");

  const keypair = Keypair.generate();
  const owner = keypair.publicKey;
  const world = (sol = 20) => {
    const chain = new FakeChain(owner, sol);
    const wallet = new Wallet(chain.connection, keypair, false);
    wallet.lostConfirmationCheck = { attempts: 3, waitMs: 1 };
    return { chain, wallet };
  };
  const venue = {
    ...meteoraVenue,
    async buildOpen(_pool: unknown, o: PublicKey, plan: { side?: string }) {
      const kp = Keypair.generate();
      return { tx: lbTx(o, [kp.publicKey]), signers: [kp], label: `open ${plan.side ?? "BOTH"}`, positionAddress: kp.publicKey.toBase58() };
    },
    async buildClose(_pool: unknown, o: PublicKey) {
      return [{ tx: lbTx(o), signers: [], label: "close band" }];
    },
    async buildClaim(_pool: unknown, o: PublicKey) {
      return [{ tx: lbTx(o), signers: [], label: "claim fees" }];
    },
  } as unknown as typeof meteoraVenue;
  const ctxOf = (w: InstanceType<typeof Wallet>, s: PoolSnapshot, positions: PositionSnapshot[], over: Record<string, unknown> = {}) =>
    ({ venue, pool: { venue: "meteora-dlmm", address: POOL }, wallet: w, rawPositions: positions.map((p) => ({ publicKey: new PublicKey(p.address) })), snapshot: s, positions, walletToken: 0, ...over }) as Parameters<typeof execute>[1];
  const THREE_PCT: TransferFee = { bps: 300, maxUi: null };

  /* ---------- M1: Token-2022 transfer fees ---------- */
  console.log("M1: transfer-fee mints");
  await test("transferFeeOfMint: a mint's TransferFeeConfig read from its TLV, the larger of older and newer, the cap in UI units; a plain mint has none", () => {
    assert.deepEqual(tf.transferFeeOfMint(feeMint(300, 300, 2n ** 64n - 1n)), { bps: 300, maxUi: null }, "u64::MAX is no cap");
    assert.deepEqual(tf.transferFeeOfMint(feeMint(100, 250, 5_000_000n)), { bps: 250, maxUi: 5 }, "a rise scheduled for a later epoch is priced now");
    assert.equal(tf.transferFeeOfMint(feeMint(0, 0, 0n)), null, "a config charging 0 is no fee");
    assert.equal(tf.transferFeeOfMint({ tlvData: Buffer.alloc(0), decimals: 6 }), null, "no extensions: no fee");
    near(tf.transferFeeCharged(48_923.17, THREE_PCT), 1467.6951, 1e-6);
    near(tf.afterTransferFee(48_923.17, THREE_PCT), 47_455.4749, 1e-6, "the 18 Sep TACZ ask, to the unit");
    near(tf.transferFeeCharged(10_000, { bps: 300, maxUi: 5 }), 5, 1e-12, "the cap binds");
    near(tf.transferFeeShare(THREE_PCT, 2), 0.0591, 1e-12, "3% twice: out of the pool, into the sale");
    assert.equal(tf.transferFeeCharged(100, null), 0);
  });

  await test("transferFeeFor: read once per mint, remembered for the process", () => {
    tf.resetTransferFeeCache();
    const m = Keypair.generate().publicKey.toBase58();
    assert.deepEqual(tf.transferFeeFor(m, feeMint(300, 300, 2n ** 64n - 1n)), THREE_PCT);
    assert.deepEqual(tf.transferFeeFor(m, { tlvData: Buffer.alloc(0), decimals: 6 }), THREE_PCT, "the second sighting is not re-read");
    assert.equal(tf.transferFeeFor(Keypair.generate().publicKey.toBase58(), null), null);
  });

  await test("live claim on a 3% mint: the token leg is what the transaction says arrived (970 of 1,000), and without token meta the snapshot less the fee", async () => {
    const { chain, wallet } = world();
    const p = pos({ tokens: 0, sol: 1, feeToken: 1000, feeSol: 0.01, entry: 1 });
    chain.effects.push({ sol: 0.01, tokens: { [MEME]: 970 } });
    const r = await execute(verdictOf({ action: "CLAIM_FEES", open: null, positionAddress: p.address, reasoning: "r", confidence: 1, headline: "h" }), ctxOf(wallet, snap(THREE_PCT), [p]));
    assert.equal(r.ok, true, r.notes.join("; "));
    const row = r.ledger!.find((x) => x.mech === "collect")!;
    assert.equal(row.basis, "exact");
    near(row.tokenDelta, 970, 1e-9, "not the snapshot's 1,000");
    near(row.solDelta, 0.01, 1e-12);
    near(row.feeSol!, 0.01 + 970 * 0.0001, 1e-12, "the fee leg as it arrived");
    assert.match(row.note, /token leg from the transaction/);
    chain.noTokenMeta = true;
    chain.effects.push({ sol: 0.01, tokens: { [MEME]: 970 } });
    const r2 = await execute(verdictOf({ action: "CLAIM_FEES", open: null, positionAddress: p.address, reasoning: "r", confidence: 1, headline: "h" }), ctxOf(wallet, snap(THREE_PCT), [p]));
    const row2 = r2.ledger!.find((x) => x.mech === "collect")!;
    near(row2.tokenDelta, 970, 1e-9, "the snapshot's 1,000 less 3%");
    assert.match(row2.note, /less the 3% transfer fee/);
  });

  await test("live close on a 3% mint: the ledger books the 48,597 that landed, not 50,100, so the day's realized P&L (the breaker's input) sees the fee", async () => {
    const { chain, wallet } = world();
    const p = pos({ tokens: 50_000, sol: 0.5, feeToken: 100, feeSol: 0.001, entry: 5.5 });
    chain.accountLamports.set(p.address, 41_899_840);
    chain.effects.push({ sol: 0.501 + 0.04189984, tokens: { [MEME]: 48_597 } });
    const r = await execute(verdictOf(closeOf(p)), ctxOf(wallet, snap(THREE_PCT), [p]));
    assert.equal(r.closed, p.address);
    const row = r.ledger!.find((x) => x.mech === "close")!;
    near(row.tokenDelta, 48_597, 1e-6);
    const realized = realizedOnDaySol([row], "live", dayOf(row.ts));
    near(realized, 0.501 + 48_597 * 0.0001 - 0.000005 - 5.5, 1e-6, "the fee is a loss the breaker counts");
    const unfeed = 0.501 + 50_100 * 0.0001 - 0.000005 - 5.5;
    assert.ok(realized < unfeed - 0.15, `the 3% is 0.15 SOL here: ${realized} vs ${unfeed}`);
  });

  await test("paper charges it too: a purchase and a close arrive 3% short, a deposit and a sale reach the pool 3% short, a claim arrives short; the equity identity holds", () => {
    const book = paper.emptyBook(100, 0, 1_000);
    // deep bins all round: the legs pay the fee, no impact
    const s = snap(THREE_PCT, { bins: Array.from({ length: 61 }, (_, i) => ({ binId: i - 30, price: 0.0001, xAmount: 1e12, yAmount: 1e12, isActive: i === 30 })) });
    const px = { book, snapshot: s, slippagePct: 0, swapFeePct: 1 };
    const openD: Decision = { action: "OPEN_POSITION", open: { side: "BOTH", amountSol: 1, amountToken: 10_000, acquireToken: 10_000, binsBelowActive: 5, binsAboveActive: 5, strategy: "Spot" }, positionAddress: null, reasoning: "r", confidence: 1, headline: "h" };
    const o = executePaper(verdictOf(openD), { ...px, positions: [], now: 2_000 });
    assert.equal(o.ok, true, o.notes.join("; "));
    near(o.ledger!.find((r) => r.mech === "swap")!.tokenDelta, 9_700, 1e-6, "the purchase lands 3% short");
    near(o.ledger!.find((r) => r.mech === "open")!.tokenDelta, -9_700, 1e-6, "the deposit takes what the wallet holds");
    assert.ok(o.notes.some((n) => /transfer fee took its cut/.test(n)), o.notes.join("; "));
    const band = book.bands[0];
    near(band.tokenDeposit, 9_700 * 0.97, 1e-6, "and the pool receives 3% less of it");
    near(band.entryValueSol, 1 + 9_700 * 0.0001, 1e-9, "the entry is what the wallet paid: the fee shows in the mark at once");
    band.feeToken = 1_000;
    const positions = paper.markPool(book, s, { now: 3_000, fees: null, solPriceUsd: 150, flow: null });
    assert.equal(positions[0].rentSol, POSITION_RENT_SOL, "a paper band tells the site the rent it will get back");
    const c = executePaper(verdictOf({ action: "CLAIM_FEES", open: null, positionAddress: band.address, reasoning: "r", confidence: 1, headline: "h" }), { ...px, positions, now: 4_000 });
    near(c.ledger![0].tokenDelta, 970, 1e-9, "the claim arrives less 3%");
    near(paper.paperTokenBalance(book, MEME), 970, 1e-9);
    const positions2 = paper.markPool(book, s, { now: 5_000, fees: null, solPriceUsd: 150, flow: null });
    const x = executePaper(verdictOf(closeOf(positions2[0], { liquidate: true })), { ...px, positions: positions2, now: 6_000 });
    assert.equal(x.ok, true, x.notes.join("; "));
    const closed = book.closed[0];
    const gross = closed.tokenBack + closed.feeToken;
    near(closed.transferFeeToken!, gross * 0.03, 1e-6);
    near(x.ledger!.find((r) => r.mech === "close")!.tokenDelta, gross * 0.97, 1e-6, "the close arrives less 3%");
    const sale = x.ledger!.find((r) => r.mech === "swap")!;
    near(sale.tokenDelta, -gross * 0.97, 1e-6, "what came back is sold");
    near(sale.quoteDelta!, gross * 0.97 * 0.97 * 0.99 * 0.0001, 1e-9, "the pool receives 3% less of the sale, then its 1% fee");
    assert.ok((book.transferFeeSol ?? 0) > 0.1, `transfer fees tallied: ${book.transferFeeSol}`);
    const sum = paperSummary(book, [], 7_000);
    assert.equal(sum.transferFeeSol, book.transferFeeSol);
    near(sum.equity.vsStartSol, sum.realizedSol + sum.markedSol + sum.equity.hedgeSol - sum.rentLockedSol - sum.rentSpentSol - sum.swapCostSol - sum.txFeesSol, 1e-9, "the identity, fees and all");
  });

  await test("the policy prices it: a 3% mint's seat earns less (half its fees pay twice) and costs its token round trip, so it pays back later; the ask exit stays a sale", async () => {
    const policy = await import("../agent/policy.js");
    const { askExitOf, askExitEnv } = await import("../engine/askExit.js");
    const pe = policy.policyEnv({} as NodeJS.ProcessEnv);
    const extras = { limits: { maxPositionSol: 10, maxTotalExposureSol: 15, gasReserveSol: 1.5, stopLossPct: 15, maxBinWidth: 69, maxTxPerDay: 120, minSecondsBetweenActions: 60, maxSlippagePct: 1, maxPriceMovePctPerCycle: 30 }, now: 1, openCostSol: 0.06, openCostRefundableSol: 0.05 } as never;
    const obs = (fee: TransferFee | null) =>
      ({ snapshot: { ...snap(fee), solPriceUsd: 150 }, positions: [], screen: { rank: 1, rankedPools: 400, score: 55, feeToTvl24hPct: 40, volume24hUsd: 3_000_000, tvlUsd: 400_000, ageHours: 5000, priceChange24hPct: 1, flags: [], generatedAt: "", alternatives: [], hot: [] } }) as never;
    const plain = policy.seatEarnings(obs(null), extras, 10, 10, false, pe)!;
    const fee = policy.seatEarnings(obs(THREE_PCT), extras, 10, 10, false, pe)!;
    assert.equal(plain.transferFeeUsd, 0);
    near(fee.feesPerDayUsd, plain.feesPerDayUsd * (1 - 0.0591 / 2), 1e-9, "the token half of the fees pays 3% twice");
    near(fee.transferFeeUsd, 10 * 150 * 0.0591, 1e-9, "the seat's token round trip: out of the pool, into the sale");
    near(fee.costUsd, plain.costUsd + fee.transferFeeUsd, 1e-9);
    assert.ok(fee.paybackHours! > plain.paybackHours!, `${fee.paybackHours} vs ${plain.paybackHours}`);
    const straddle = policy.seatEarnings(obs(THREE_PCT), extras, 10, 10, true, pe)!;
    near(straddle.transferFeeUsd, 5 * 150 * (1 - 0.97 ** 4), 1e-9, "a straddle's token half moves four times");
    const p = pos({ tokens: 50_000, sol: 0, entry: 6 });
    const on = askExitEnv({ EXIT_ASK: "true" });
    const d = closeOf(p, { liquidate: true });
    assert.ok(askExitOf(d, { snapshot: snap(null), positions: [p], walletToken: 0, askBands: {}, env: on, maxBinWidth: 69 }), "a plain mint is laid as an ask");
    assert.equal(askExitOf(d, { snapshot: snap(THREE_PCT), positions: [p], walletToken: 0, askBands: {}, env: on, maxBinWidth: 69 }), null, "a fee mint is sold: every ask pays the fee in and out");
  });

  await test("a scaled-UI mint (NVDAx, x1.0017): claim, close and swap rows book the raw units that moved, not the RPC's multiplied uiAmount, and a liquidating close sells exactly the 20 that arrived, in a SOL pool and a USDC pool", async () => {
    const MULT = 1.001701196801074;
    const NVDAX = Keypair.generate().publicKey.toBase58();
    const USDC = config.usdcMint;
    const stock = { mint: NVDAX, symbol: "NVDAx", decimals: 8, reserve: 1e4 };
    const usdc = { mint: USDC, symbol: "USDC", decimals: 6, reserve: 1e6 };
    const pools = {
      SOL: snap(null, { label: "NVDAx/SOL", tokenX: stock, baseToken: stock, activePrice: 1.2, priceLabel: "SOL per NVDAx", tokenPriceInSol: 1.2, tokenPriceInQuote: 1.2 }),
      USDC: snap(null, { label: "NVDAx/USDC", tokenX: stock, tokenY: usdc, baseToken: stock, solSide: null, quoteSide: "Y", quoteToken: usdc, quoteSymbol: "USDC", quotePriceInSol: 1 / 150, activePrice: 180, priceLabel: "USDC per NVDAx", tokenPriceInSol: 1.2, tokenPriceInQuote: 180 }),
    };
    const stockWorld = () => {
      const w = world();
      w.chain.decimals.set(NVDAX, 8);
      w.chain.uiMultiplier.set(NVDAX, MULT);
      return w;
    };
    const uiShown = async (chain: FakeChain, sig: string) => (await chain.getTransaction(sig))!.meta.postTokenBalances.find((b) => b.mint === NVDAX)!.uiTokenAmount.uiAmount;

    // a claim of 1 NVDAx books 1
    const c = stockWorld();
    const pc = pos({ sol: 1, feeToken: 1, entry: 1 });
    c.chain.effects.push({ sol: 0, tokens: { [NVDAX]: 1 } });
    const claim = await execute(verdictOf({ action: "CLAIM_FEES", open: null, positionAddress: pc.address, reasoning: "r", confidence: 1, headline: "h" }), ctxOf(c.wallet, pools.SOL, [pc]));
    near(await uiShown(c.chain, c.chain.sends[0].signature), MULT, 1e-12, "the RPC shows the multiplied figure");
    near(claim.ledger!.find((x) => x.mech === "collect")!.tokenDelta, 1, 1e-12, "the claim books what arrived");

    for (const [quote, s] of Object.entries(pools)) {
      const { chain, wallet } = stockWorld();
      const quoteDec = quote === "SOL" ? 9 : 6;
      const quoteMint = quote === "SOL" ? SOL_MINT : USDC;
      const sold: bigint[] = [];
      // Jupiter: the quote at the pool's price, and a swap the chain applies (or refuses at preflight when it sells more than is held)
      jupiterStub = (url, body) => {
        if (url.pathname.endsWith("/quote")) {
          const inAmount = url.searchParams.get("amount")!;
          const out = Math.round((Number(inAmount) / 1e8) * s.tokenPriceInQuote! * 10 ** quoteDec);
          return { inputMint: NVDAX, outputMint: quoteMint, inAmount, outAmount: String(out), otherAmountThreshold: String(out), swapMode: "ExactIn", slippageBps: 50, priceImpactPct: "0.0001", routePlan: [{ swapInfo: { label: "Meteora DLMM" } }] };
        }
        const q = body!.quoteResponse as { inAmount: string; outAmount: string };
        sold.push(BigInt(q.inAmount));
        const inUi = Number(q.inAmount) / 1e8;
        const outUi = Number(q.outAmount) / 10 ** quoteDec;
        chain.effects.push(quote === "SOL" ? { sol: outUi, tokens: { [NVDAX]: -inUi } } : { tokens: { [NVDAX]: -inUi, [USDC]: outUi } });
        const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: BLOCKHASH, instructions: [lbIx(owner)] }).compileToV0Message();
        return { swapTransaction: Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64"), lastValidBlockHeight: 1000 };
      };
      try {
        // a stop's close of a band holding 20 NVDAx, liquidated
        const p = pos({ tokens: 20, entry: 24 });
        chain.accountLamports.set(p.address, 41_899_840);
        chain.effects.push({ sol: 0.04189984, tokens: { [NVDAX]: 20 } });
        const r = await execute(verdictOf(closeOf(p, { liquidate: true }), true), ctxOf(wallet, s, [p]));
        assert.equal(r.ok, true, `${quote}: ${r.notes.join("; ")}`);
        assert.equal(r.closed, p.address);
        near(await uiShown(chain, chain.sends[0].signature), 20 * MULT, 1e-9, `${quote}: the RPC shows 20.034`);
        near(r.ledger!.find((x) => x.mech === "close")!.tokenDelta, 20, 1e-12, `${quote}: the close books the 20 that arrived`);
        assert.deepEqual(sold, [2_000_000_000n], `${quote}: one sale of exactly 20 NVDAx, not 20.034 (which fails its preflight)`);
        near(r.ledger!.find((x) => x.mech === "swap")!.tokenDelta, -20, 1e-12, `${quote}: the swap books the 20 it sold`);
        near(chain.tokens.get(NVDAX)!, 0, 1e-12, `${quote}: nothing of the stop's token stays in the wallet`);
        assert.equal(r.residue, undefined);
        assert.ok(!r.notes.some((n) => /stays in the wallet/.test(n)), r.notes.join("; "));
      } finally {
        jupiterStub = null;
      }
    }
  });

  /* ---------- M2: the priority fee ---------- */
  console.log("M2: the priority fee");
  await test("priorityFeeEnv / chooseComputeUnitPrice: the network's reading over the floor, the urgent multiple, the cap per transaction, a fixed price when set", () => {
    const env = prio.priorityFeeEnv({});
    assert.deepEqual(env, { fixedMicroLamports: 0, minMicroLamports: 10_000, urgentMultiple: 4, maxLamports: 1_000_000 });
    assert.equal(prio.chooseComputeUnitPrice(null, 200_000, false, env), 10_000, "no reading: the floor, never nothing");
    assert.equal(prio.chooseComputeUnitPrice(60_000, 200_000, false, env), 60_000);
    assert.equal(prio.chooseComputeUnitPrice(60_000, 200_000, true, env), 240_000, "an emergency close pays 4x");
    assert.equal(prio.chooseComputeUnitPrice(9_000_000, 200_000, true, env), 5_000_000, "capped: 0.001 SOL at 200k units");
    assert.equal(prio.chooseComputeUnitPrice(60_000, 200_000, false, prio.priorityFeeEnv({ PRIORITY_FEE_MICROLAMPORTS: "25000" })), 25_000, "a fixed price wins");
    assert.equal(prio.percentile([0, 0, 10_000, 50_000, 60_000, 80_000], 75), 60_000);
  });

  await test("applyPriorityFee: a legacy transaction gets one price instruction; one that has a price, and a versioned one, are left as they came", async () => {
    const { chain } = world();
    chain.prioFees = [1_000, 2_000];
    const tx = lbTx(owner);
    const limit = ComputeBudgetProgram.setComputeUnitLimit({ units: 170_000 });
    tx.instructions.unshift(limit);
    assert.equal(prio.computeUnitLimitOf(tx), 170_000, "the SDK's own limit is read");
    const a = await prio.applyPriorityFee(tx, chain.connection, false);
    assert.equal(a!.microLamports, 10_000, "a quiet network: the floor");
    assert.equal(a!.source, "floor");
    assert.equal(priceOf(tx), 10_000);
    assert.deepEqual(chain.prioAsked[0], [LB_PAIR.toBase58()], "asked about the pool's writable accounts, not the fee payer");
    assert.equal(await prio.applyPriorityFee(tx, chain.connection, true), null, "a second price would fail on chain: left alone");
    assert.equal(tx.instructions.filter((i) => i.programId.equals(ComputeBudgetProgram.programId) && i.data[0] === 3).length, 1);
    const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: BLOCKHASH, instructions: [lbIx(owner)] }).compileToV0Message();
    assert.equal(await prio.applyPriorityFee(new VersionedTransaction(msg), chain.connection, true), null, "Jupiter's and Raydium's are theirs");
  });

  await test("the executor: an emergency close is sent at the urgent price, a claim at the ordinary one, and the report says so", async () => {
    const { chain, wallet } = world();
    chain.prioFees = [0, 0, 10_000, 50_000, 60_000, 80_000];
    const p = pos({ sol: 1, entry: 1 });
    chain.accountLamports.set(p.address, 41_899_840);
    chain.effects.push({ sol: 0.001 }, { sol: 1 + 0.04189984 });
    const claim = await execute(verdictOf({ action: "CLAIM_FEES", open: null, positionAddress: p.address, reasoning: "r", confidence: 1, headline: "h" }), ctxOf(wallet, snap(), [p]));
    assert.equal(priceOf(chain.sends[0].tx), 60_000, "p75 of the network's reading");
    assert.equal(claim.txs[0].priorityMicroLamports, 60_000);
    const stop = await execute(verdictOf(closeOf(p), true), ctxOf(wallet, snap(), [p]));
    assert.equal(stop.ok, true);
    assert.equal(priceOf(chain.sends[1].tx), 240_000, "the stop pays 4x to land in a crash");
  });

  /* ---------- M3: a lost confirmation ---------- */
  console.log("M3: a transaction that landed but whose confirmation was lost");
  const transfer = () => new Transaction().add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  await test("signAndSend: the confirmation throws 'block height exceeded' for a transaction the chain holds: found by its signature, returned as sent, and a note says so", async () => {
    const { chain, wallet } = world();
    chain.outcomes.push("lost-landed");
    const tx = transfer();
    const notes: string[] = [];
    const sig = await wallet.signAndSend(tx, [], notes);
    assert.equal(sig, base58Encode(tx.signature!), "the signature was known before the send");
    assert.deepEqual(chain.statusAsked, [{ signature: sig, searchTransactionHistory: true }]);
    assert.match(notes[0], /the signature shows it landed; booked as sent/);
  });

  await test("signAndSend: not landed stays a failure (after asking a few times); a preflight refusal and an on-chain error are never looked up", async () => {
    const { chain, wallet } = world();
    chain.outcomes.push("lost-not-landed", "preflight", "onchain-err");
    await assert.rejects(wallet.signAndSend(transfer()), TransactionExpiredBlockheightExceededError);
    assert.equal(chain.statusAsked.length, 3, "three reads before giving up");
    await assert.rejects(wallet.signAndSend(transfer()), SendTransactionError);
    await assert.rejects(wallet.signAndSend(transfer()), TransactionFailedError);
    assert.equal(chain.statusAsked.length, 3, "neither was looked up");
  });

  await test("the executor: a stop's close whose confirmation was lost is a close (the band is forgotten, the row is written from the chain), not a failed send", async () => {
    const { chain, wallet } = world();
    const p = pos({ sol: 2, entry: 2.4 });
    chain.accountLamports.set(p.address, 41_899_840);
    chain.outcomes.push("lost-landed");
    chain.effects.push({ sol: 2 + 0.04189984 });
    const r = await execute(verdictOf(closeOf(p), true), ctxOf(wallet, snap(), [p]));
    assert.equal(r.ok, true, r.notes.join("; "));
    assert.equal(r.closed, p.address);
    const row = r.ledger!.find((x) => x.mech === "close")!;
    assert.equal(row.basis, "exact");
    near(row.solDelta, 2, 1e-9);
    assert.ok(r.notes.some((n) => /booked as sent/.test(n)), r.notes.join("; "));
  });

  /* ---------- M4: the rent a close refunds ---------- */
  console.log("M4: the close's rent refund");
  await test("a live SOL-pool close books the lamports its position account held (0.0419), and the quote leg is the band's SOL to the lamport", async () => {
    const { chain, wallet } = world();
    const p = pos({ sol: 2.317810388, entry: 2.317810388 });
    chain.accountLamports.set(p.address, 41_899_840);
    chain.effects.push({ sol: 2.317810388 + 0.04189984 });
    const r = await execute(verdictOf(closeOf(p)), ctxOf(wallet, snap(), [p]));
    const row = r.ledger!.find((x) => x.mech === "close")!;
    near(row.rentSol, 0.04189984, 1e-12, "not the 0.0574 estimate");
    near(row.solDelta, 2.317810388, 1e-9, "no phantom 0.0155 moved out of the quote leg");
    assert.match(row.note, /rent refund read off the position account/);
    near(realizedOnDaySol([row], "live", dayOf(row.ts)), -0.000005, 1e-9, "a flat band closes flat but for the network fee: no phantom loss for the breaker");
  });

  await test("the account cannot be read: the refund is today's rate for a Meteora position (8248 bytes x 5080), never the old-rate 0.0574", async () => {
    const { chain, wallet } = world();
    const p = pos({ sol: 1, entry: 1 });
    chain.failBalance.add(p.address);
    chain.effects.push({ sol: 1 + 0.04189984 });
    const r = await execute(verdictOf(closeOf(p)), ctxOf(wallet, snap(), [p]));
    const row = r.ledger!.find((x) => x.mech === "close")!;
    near(POSITION_RENT_NOW_SOL, 0.04189984, 1e-12);
    near(row.rentSol, POSITION_RENT_NOW_SOL, 1e-12);
    assert.notEqual(row.rentSol, POSITION_RENT_SOL);
    near(row.solDelta, 1, 1e-9);
    assert.match(row.note, /today's rate/);
  });

  /* ---------- M5: the straddle re-lay does not trust one early read ---------- */
  console.log("M5: the straddle re-lay");
  await test("a re-lay whose wallet reads still show the balance from before the close: no purchase of the token the close just handed back, the deposit takes it", async () => {
    const { chain, wallet } = world();
    const p = pos({ tokens: 100, sol: 1, entry: 1.01 });
    chain.accountLamports.set(p.address, 41_899_840);
    chain.staleReadsAfterSend = 2;
    chain.effects.push({ sol: 1 + 0.04189984, tokens: { [MEME]: 100 } }, { sol: -(1 + 0.04189984), tokens: { [MEME]: -100 } });
    const d: Decision = { action: "REBALANCE", open: { side: "BOTH", amountSol: 1, amountToken: 100, acquireToken: 0, binsBelowActive: 5, binsAboveActive: 5, strategy: "Spot" }, positionAddress: p.address, reasoning: "r", confidence: 1, headline: "h" };
    const before = jupCalls.length;
    const r = await execute(verdictOf(d), ctxOf(wallet, snap(), [p]));
    assert.equal(jupCalls.length, before, "no swap was even quoted");
    assert.equal(r.ok, true, r.notes.join("; "));
    assert.equal(r.closed, p.address);
    assert.ok(r.opened, "the re-lay deposited");
    assert.equal(r.ledger!.filter((x) => x.mech === "swap").length, 0);
    const open = r.ledger!.find((x) => x.mech === "open")!;
    near(open.tokenDelta, -100, 1e-9, "the whole token half, from what the close returned");
    assert.ok(chain.tokenReads >= 3, "the stale reads were waited out, not trusted");
  });

  /* ---------- M6: a rehearsal books nothing ---------- */
  console.log("M6: the rehearsal and the live bookkeeping");
  const freshState = (): RiskState => ({ day: "2026-09-22", actionsToday: 0, lastActionAt: null, lastPrice: null, entryValueSol: { real1: 5.9035 }, stops: { real1: 12.3 }, outOfRangeSince: { real1: 1 }, feesPendingSince: {}, priceHistory: {} });
  const dryExec = (mode: "dry-run" | "live") => ({ mode, ok: true, txs: [{ label: "close", ok: true }, { label: "open", ok: true }], notes: [], closed: "real1", opened: { address: "phantom", entryValueSol: 10 } });
  await test("bookExecution: a dry-run close and open leave the real band's entry, stop and clock alone and write no phantom; a live one does both", () => {
    const s = snap();
    const st = freshState();
    const chainBand = { ...pos({ sol: 1 }), address: "onchain2", valueInSol: 1 } as PositionSnapshot;
    bookExecution(st, dryExec("dry-run") as never, [chainBand], s, null, null, 1_000, () => 0.5);
    assert.equal(st.entryValueSol.real1, 5.9035, "the live band keeps its entry");
    assert.equal(st.stops!.real1, 12.3, "and its stop");
    assert.equal(st.outOfRangeSince!.real1, 1);
    assert.equal("phantom" in st.entryValueSol, false, "no phantom entry: working capital is not doubled");
    assert.equal(st.actionsToday, 0);
    assert.equal(st.lastMoveByPool, undefined, "no cooldown on the live pool");
    assert.equal(st.seatSince, undefined);
    assert.equal(st.entryValueSol.onchain2, 1, "a band the chain shows is still recorded");
    assert.equal(st.lastPrice, s.activePrice);
    const live = freshState();
    bookExecution(live, dryExec("live") as never, [], s, null, null, 1_000, () => 0.5);
    assert.equal("real1" in live.entryValueSol, false, "live: the closed band is forgotten");
    assert.equal(live.entryValueSol.phantom, 10);
    assert.equal(live.actionsToday, 1);
  });

  /* ---------- M7: a blind held pool ---------- */
  console.log("M7: a held pool that cannot be read");
  await test("blindExposure: a held pool not observed still counts its seat and its bands at the last mark (no haircut), else the entry; an ask-only pool is exposure, not a seat", () => {
    const marks = { pltr: { pool: "P", valueSol: 22.59, at: 1 }, ask1: { pool: "A", valueSol: 3, at: 1 } };
    const b = blindExposure({ held: ["P", "A", "Q", "SEEN"], observed: ["SEEN"], marks, entryValueSol: { pltr: 26.25, ask1: 3.2, q1: 4, other: 9 }, metaPool: { q1: "Q", other: "SEEN" }, askBands: { ask1: {} } });
    assert.deepEqual(b.pools, ["P", "A", "Q"]);
    near(b.exposureSol, 22.59 + 3 + 4, 1e-12, "last marks, and the entry where there is no mark; the observed pool's band is not counted twice");
    assert.equal(b.seats, 2, "P and Q hold seats; A holds only an ask band");
    const none = blindExposure({ held: ["X"], observed: [], marks: {}, entryValueSol: {}, metaPool: {} });
    assert.equal(none.seats, 1, "a held pool whose bands nothing attributes is still a seat");
    assert.equal(blindExposure({ held: ["SEEN"], observed: ["SEEN"], marks, entryValueSol: {}, metaPool: {} }).pools.length, 0);
  });

  /* ---------- M8: the live memecoin floor ---------- */
  console.log("M8: the live desk's memecoin floor");
  await test("ops/live.env: memecoins at least 30 days old with 30 days of candles, one line each", () => {
    const lines = fs.readFileSync(path.resolve(__dirname, "../../ops/live.env"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    const values = (k: string) => lines.filter((l) => l.startsWith(`${k}=`)).map((l) => l.slice(k.length + 1));
    assert.deepEqual(values("MEME_MIN_AGE_HOURS"), ["720"]);
    assert.deepEqual(values("MEME_MIN_HISTORY_DAYS"), ["30"]);
  });

  /* ---------- M9: the board's fee ---------- */
  console.log("M9: the board prices a Meteora pool at base + variable");
  await test("meteoraBoardFees: dynamicFeePct is base + variable (1.0075% on a 1% pool that moved), and boardFee reads it; a stale variable-only row reads at the base, never a sliver", () => {
    const sParams = { baseFactor: 10_000, baseFeePowerFactor: 0, variableFeeControl: 7_500 } as never;
    const vParams = { volatilityAccumulator: 10_000 } as never;
    const f = meteoraBoardFees(100, sParams, vParams);
    near(f.baseFeePct, 1, 1e-12);
    near(f.dynamicFeePct, 1.0075, 1e-12, "the fee a trader pays now");
    near(boardFee(f), 1.0075, 1e-12);
    near(meteoraBoardFees(100, sParams, { volatilityAccumulator: 0 } as never).dynamicFeePct, 1, 1e-12, "quiet: the base");
    near(boardFee({ baseFeePct: 1, dynamicFeePct: 0.0075 }), 1, 1e-12, "a board written before the fix");
    near(boardFee({ baseFeePct: 2, dynamicFeePct: 2.0103 }), 2.0103, 1e-12, "Orca's adaptive fee, as before");
  });

  console.log(`\n${passed} money-path tests passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
