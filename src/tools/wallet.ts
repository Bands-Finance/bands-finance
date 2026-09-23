import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SendTransactionError,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { config } from "../config";

/** A legacy transaction (Meteora's SDK) or a versioned one with lookup tables (Raydium's SDK). */
export type AnyTransaction = Transaction | VersionedTransaction;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Minimal base58 decoder so we don't need another dependency for one call. */
export function base58Decode(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) throw new Error(`invalid base58 character: ${ch}`);
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

/** Minimal base58 encoder: a transaction's signature is known before it is sent. */
export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

/** What the chain says of a signature a confirmation lost: landed clean, landed and failed, or not found. */
export type SignatureOutcome = { landed: true } | { landed: false; err: unknown } | null;

/** A transaction that landed and failed on chain: its fee is spent and nothing else happened, so it is never checked again. */
export class TransactionFailedError extends Error {
  constructor(readonly signature: string, readonly err: unknown) {
    super(`transaction ${signature} failed: ${JSON.stringify(err)}`);
    this.name = "TransactionFailedError";
  }
}

export function loadKeypair(secret: string): Keypair {
  const s = secret.trim();
  if (s.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s) as number[]));
  }
  return Keypair.fromSecretKey(base58Decode(s));
}

export interface TokenBalance {
  mint: string;
  amount: bigint;
  decimals: number;
  ui: number;
}

export interface SimulationReport {
  ok: boolean;
  err: unknown;
  unitsConsumed?: number;
  logsTail: string[];
}

/**
 * The hot wallet. This is the single choke point for broadcasting transactions:
 * `signAndSend` refuses to run while DRY_RUN is on, regardless of what any
 * upstream code decided. Defense in depth on top of the risk guards.
 */
export class Wallet {
  /** how a lost confirmation is looked up (signatureOutcome): attempts, and the wait between them */
  lostConfirmationCheck: { attempts: number; waitMs: number } = { attempts: 3, waitMs: 2000 };

  constructor(
    readonly connection: Connection,
    readonly keypair: Keypair,
    /** true when no WALLET_SECRET_KEY was configured and a throwaway key was generated */
    readonly ephemeral: boolean,
  ) {}

  /**
   * Load the configured key, or a throwaway one. Signer assertion (port of Meridian's
   * assertSignerIsHouseWallet): when EXPECTED_WALLET is set and the loaded key derives to a
   * different pubkey, live mode refuses to start and dry-run warns. A key rotated without
   * updating EXPECTED_WALLET would otherwise sign from one wallet while the journal and the
   * lock file explain another.
   *
   * `pin` swaps the address checked, for ONE caller only: the token launch (src/scripts/clawpump.ts) pays from
   * the treasury keypair and pins it with TOKEN_PAYER_EXPECTED instead. The desk never passes it, so its own
   * EXPECTED_WALLET check is exactly as strict as before.
   */
  static fromConfig(connection: Connection, pin: { address: string; name: string } = { address: config.engine.expectedWallet, name: "EXPECTED_WALLET" }): Wallet {
    const wallet = config.walletSecretKey
      ? new Wallet(connection, loadKeypair(config.walletSecretKey), false)
      : new Wallet(connection, Keypair.generate(), true);
    const expected = pin.address;
    if (expected && wallet.publicKey.toBase58() !== expected) {
      const msg = `${wallet.ephemeral ? "the ephemeral wallet" : "WALLET_SECRET_KEY"} derives to ${wallet.publicKey.toBase58()}, but ${pin.name} is ${expected}`;
      if (!config.dryRun) throw new Error(`${msg}. Refusing to start live: a key rotation must update ${pin.name} in the same change.`);
      console.warn(`[wallet] warning: ${msg} (dry-run continues)`);
    }
    return wallet;
  }

  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  async solBalance(): Promise<number> {
    const lamports = await this.connection.getBalance(this.publicKey, "confirmed");
    return lamports / LAMPORTS_PER_SOL;
  }

  /** The wallet's USDC (config USDC_MINT): the quote balance for USDC-quoted pools. */
  async usdcBalance(): Promise<TokenBalance> {
    return this.tokenBalance(new PublicKey(config.usdcMint));
  }

  async tokenBalance(mint: PublicKey): Promise<TokenBalance> {
    const res = await this.connection.getParsedTokenAccountsByOwner(this.publicKey, { mint });
    let amount = 0n;
    let decimals = 0;
    for (const { account } of res.value) {
      const info = account.data.parsed?.info;
      const ta = info?.tokenAmount;
      if (!ta) continue;
      amount += BigInt(ta.amount as string);
      decimals = Number(ta.decimals);
    }
    return { mint: mint.toBase58(), amount, decimals, ui: Number(amount) / 10 ** decimals };
  }

  /**
   * What a confirmed transaction did to this wallet's SOL, from the transaction's own pre/post
   * balances (the fee payer is account 0): the exact basis for a ledger row. Null when the RPC
   * has not indexed it after a few tries; the caller falls back to a before/after balance read.
   */
  async txCashDelta(signature: string): Promise<{ walletDeltaSol: number; txFeeSol: number } | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const tx = await this.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const meta = tx?.meta;
      if (meta && meta.preBalances.length > 0 && meta.postBalances.length > 0) {
        return {
          walletDeltaSol: (meta.postBalances[0] - meta.preBalances[0]) / LAMPORTS_PER_SOL,
          txFeeSol: -meta.fee / LAMPORTS_PER_SOL,
        };
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return null;
  }

  /**
   * What a confirmed transaction did to this wallet's balance of one SPL token (UI units,
   * positive into the wallet), from the transaction's own pre/post token balances: the exact
   * quote leg of a ledger row in a USDC-quoted pool. Null when the RPC has not indexed it, or
   * when the transaction carries no token-balance meta; the caller falls back to a balance
   * read before and after, and past that marks the row.
   */
  async txTokenDelta(signature: string, mint: string): Promise<number | null> {
    const owner = this.publicKey.toBase58();
    for (let attempt = 0; attempt < 4; attempt++) {
      const tx = await this.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const meta = tx?.meta;
      if (meta) {
        const sum = (rows: typeof meta.preTokenBalances) =>
          (rows ?? [])
            .filter((b) => b.mint === mint && b.owner === owner)
            .reduce((acc, b) => acc + (b.uiTokenAmount.uiAmount ?? Number(b.uiTokenAmount.uiAmountString ?? 0)), 0);
        const pre = meta.preTokenBalances ?? [];
        const post = meta.postTokenBalances ?? [];
        if (pre.length === 0 && post.length === 0) return null;
        return sum(post) - sum(pre);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return null;
  }

  /**
   * Simulate without broadcasting. Used in DRY_RUN. A versioned transaction is simulated as built
   * (its lookup tables resolved by the RPC) with signature checks off and a fresh blockhash, so a
   * transaction built for an unfunded wallet still reports its logs and compute.
   */
  async simulate(tx: AnyTransaction, extraSigners: Keypair[] = []): Promise<SimulationReport> {
    if (tx instanceof VersionedTransaction) {
      const res = await this.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
      return {
        ok: res.value.err === null,
        err: res.value.err,
        unitsConsumed: res.value.unitsConsumed,
        logsTail: (res.value.logs ?? []).slice(-8),
      };
    }
    if (!tx.recentBlockhash) {
      const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
    }
    if (!tx.feePayer) tx.feePayer = this.publicKey;
    const res = await this.connection.simulateTransaction(tx, [this.keypair, ...extraSigners]);
    return {
      ok: res.value.err === null,
      err: res.value.err,
      unitsConsumed: res.value.unitsConsumed,
      logsTail: (res.value.logs ?? []).slice(-8),
    };
  }

  /**
   * What the chain says of a signature, asked with searchTransactionHistory: confirmed or finalized is an answer
   * (landed, or landed and failed); nothing, or only "processed", is asked again `attempts` times `waitMs` apart,
   * then null. The status may trail the transaction by a slot or two, so one miss is not an answer.
   */
  async signatureOutcome(signature: string, o: { attempts?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<SignatureOutcome> {
    const attempts = Math.max(1, o.attempts ?? this.lostConfirmationCheck.attempts);
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
        const st = res?.value?.[0];
        if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return st.err ? { landed: false, err: st.err } : { landed: true };
      } catch {
        /* the status read failed: asked again */
      }
      if (i < attempts - 1) await sleep(o.waitMs ?? this.lostConfirmationCheck.waitMs);
    }
    return null;
  }

  /**
   * Broadcast. Throws while DRY_RUN is on or when no real key is configured. Every transaction gets a fresh
   * blockhash and is signed here by the wallet and every extra signer (a builder's own signature would not
   * survive the new blockhash), sent raw and confirmed against that blockhash's height.
   *
   * THE SIGNATURE IS KNOWN BEFORE THE SEND. A confirmation can fail for a transaction that landed: web3.js
   * reads the status once, then waits on a websocket notification, and a lost notification or a dropped socket
   * ends in "block height exceeded" for a transaction the chain already holds. Treated as never sent, a stop's
   * close left its tokens unmanaged and its ledger row unwritten. So on any failure but an RPC refusal (the
   * preflight: never sent) or an on-chain error, the signature is looked up with searchTransactionHistory; a
   * transaction that landed clean is returned as sent and ledgered like any other. `notes` hears about it.
   */
  async signAndSend(tx: AnyTransaction, extraSigners: Keypair[] = [], notes?: string[]): Promise<string> {
    if (config.dryRun) {
      throw new Error("DRY_RUN=true: wallet refuses to broadcast transactions");
    }
    if (this.ephemeral) {
      throw new Error("No WALLET_SECRET_KEY configured: cannot broadcast");
    }
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    let signature: string;
    let raw: Uint8Array;
    if (tx instanceof VersionedTransaction) {
      tx.message.recentBlockhash = blockhash;
      tx.sign([this.keypair, ...extraSigners]);
      signature = base58Encode(tx.signatures[0]);
      raw = tx.serialize();
    } else {
      // what sendAndConfirmTransaction did, in the open: a fresh blockhash, the wallet pays, every signer signs
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      if (!tx.feePayer) tx.feePayer = this.publicKey;
      tx.sign(this.keypair, ...extraSigners);
      signature = base58Encode(tx.signature!);
      raw = tx.serialize();
    }
    try {
      await this.connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed" });
      const conf = await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (conf.value.err) throw new TransactionFailedError(signature, conf.value.err);
      return signature;
    } catch (err) {
      if (err instanceof TransactionFailedError || err instanceof SendTransactionError) throw err;
      const outcome = await this.signatureOutcome(signature);
      if (outcome?.landed) {
        notes?.push(`${signature.slice(0, 12)}: the confirmation failed (${(err as Error).message.slice(0, 120)}) but the signature shows it landed; booked as sent`);
        return signature;
      }
      if (outcome && !outcome.landed) throw new TransactionFailedError(signature, outcome.err);
      throw err;
    }
  }
}
