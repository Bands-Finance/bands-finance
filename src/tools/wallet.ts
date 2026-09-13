import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { config } from "../config";

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
   */
  static fromConfig(connection: Connection): Wallet {
    const wallet = config.walletSecretKey
      ? new Wallet(connection, loadKeypair(config.walletSecretKey), false)
      : new Wallet(connection, Keypair.generate(), true);
    const expected = config.engine.expectedWallet;
    if (expected && wallet.publicKey.toBase58() !== expected) {
      const msg = `${wallet.ephemeral ? "the ephemeral wallet" : "WALLET_SECRET_KEY"} derives to ${wallet.publicKey.toBase58()}, but EXPECTED_WALLET is ${expected}`;
      if (!config.dryRun) throw new Error(`${msg}. Refusing to start live: a key rotation must update EXPECTED_WALLET in the same change.`);
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

  /** Simulate a legacy transaction without broadcasting. Used in DRY_RUN. */
  async simulate(tx: Transaction, extraSigners: Keypair[] = []): Promise<SimulationReport> {
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

  /** Broadcast. Throws while DRY_RUN is on or when no real key is configured. */
  async signAndSend(tx: Transaction, extraSigners: Keypair[] = []): Promise<string> {
    if (config.dryRun) {
      throw new Error("DRY_RUN=true: wallet refuses to broadcast transactions");
    }
    if (this.ephemeral) {
      throw new Error("No WALLET_SECRET_KEY configured: cannot broadcast");
    }
    return sendAndConfirmTransaction(this.connection, tx, [this.keypair, ...extraSigners], {
      commitment: "confirmed",
      skipPreflight: false,
    });
  }
}
