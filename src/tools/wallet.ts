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

  static fromConfig(connection: Connection): Wallet {
    if (config.walletSecretKey) {
      return new Wallet(connection, loadKeypair(config.walletSecretKey), false);
    }
    return new Wallet(connection, Keypair.generate(), true);
  }

  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  async solBalance(): Promise<number> {
    const lamports = await this.connection.getBalance(this.publicKey, "confirmed");
    return lamports / LAMPORTS_PER_SOL;
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
