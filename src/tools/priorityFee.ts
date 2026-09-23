/**
 * THE PRIORITY FEE on the desk's own transactions. Meteora's SDK sets a compute-unit LIMIT and no
 * price, so every open, close and claim the 17-19 Sep run sent paid the base fee and nothing more
 * (247 of 247 rows); 4 of 250 expired in calm markets. Congestion comes with crashes, which is when a
 * stop or a flatten most needs to land, so every legacy transaction the executor runs gets a
 * compute-unit price before it is signed:
 *
 *   price   PRIORITY_FEE_MICROLAMPORTS when set (> 0), else the network's recent fees for the accounts
 *           the transaction writes (getRecentPrioritizationFees, the 75th percentile of the slots it
 *           reports), never under PRIORITY_FEE_MIN_MICROLAMPORTS (default 10,000)
 *   urgent  a STOP / FLATTEN close (an emergency verdict) pays PRIORITY_FEE_URGENT_MULTIPLE times that
 *           (default 4): an exit that expires in a crash costs more than any fee
 *   cap     whatever the reading, one transaction never pays more than PRIORITY_FEE_MAX_LAMPORTS of
 *           priority fee (default 1,000,000 lamports, 0.001 SOL) at its compute-unit limit
 *
 * A transaction that already carries a price (Raydium's builder, a Jupiter swap: versioned transactions
 * built elsewhere) is left exactly as it came: two prices in one transaction fail on chain. A failed
 * reading is not a reason to send without one: the floor is used.
 */
import { ComputeBudgetProgram, type Connection, type PublicKey, Transaction, type TransactionInstruction, VersionedTransaction } from "@solana/web3.js";

export interface PriorityFeeEnv {
  /** PRIORITY_FEE_MICROLAMPORTS: a fixed compute-unit price for every transaction; 0 reads the network */
  fixedMicroLamports: number;
  /** PRIORITY_FEE_MIN_MICROLAMPORTS: the floor under the network's reading */
  minMicroLamports: number;
  /** PRIORITY_FEE_URGENT_MULTIPLE: what a STOP / FLATTEN close pays over the ordinary price */
  urgentMultiple: number;
  /** PRIORITY_FEE_MAX_LAMPORTS: the most priority fee one transaction pays, lamports */
  maxLamports: number;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** PURE. The priority-fee settings from the env. */
export function priorityFeeEnv(env: NodeJS.ProcessEnv = process.env): PriorityFeeEnv {
  return {
    fixedMicroLamports: Math.max(0, Math.floor(num(env.PRIORITY_FEE_MICROLAMPORTS, 0))),
    minMicroLamports: Math.max(0, Math.floor(num(env.PRIORITY_FEE_MIN_MICROLAMPORTS, 10_000))),
    urgentMultiple: Math.max(1, num(env.PRIORITY_FEE_URGENT_MULTIPLE, 4)),
    maxLamports: Math.max(0, Math.floor(num(env.PRIORITY_FEE_MAX_LAMPORTS, 1_000_000))),
  };
}

/** The runtime's default compute budget per instruction, and the most a transaction may ask for. */
const DEFAULT_UNITS_PER_IX = 200_000;
const MAX_UNITS = 1_400_000;
const COMPUTE_BUDGET = ComputeBudgetProgram.programId.toBase58();
/** ComputeBudget instruction tags: 2 = SetComputeUnitLimit (u32), 3 = SetComputeUnitPrice (u64) */
const SET_LIMIT = 2;
const SET_PRICE = 3;

const isBudget = (ix: TransactionInstruction, tag: number): boolean => ix.programId.toBase58() === COMPUTE_BUDGET && ix.data.length > 0 && ix.data[0] === tag;

/** PURE. Whether a legacy transaction already names a compute-unit price. */
export const hasComputeUnitPrice = (tx: Transaction): boolean => tx.instructions.some((ix) => isBudget(ix, SET_PRICE));

/** PURE. The compute units a legacy transaction may burn: its SetComputeUnitLimit, else the runtime's default for its instructions. */
export function computeUnitLimitOf(tx: Transaction): number {
  const limit = tx.instructions.find((ix) => isBudget(ix, SET_LIMIT));
  if (limit && limit.data.length >= 5) return limit.data.readUInt32LE(1);
  const work = tx.instructions.filter((ix) => ix.programId.toBase58() !== COMPUTE_BUDGET).length;
  return Math.min(MAX_UNITS, Math.max(1, work) * DEFAULT_UNITS_PER_IX);
}

/** PURE. The p-th percentile (0..100) of a list of fees; 0 for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  const xs = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  const i = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return xs[i];
}

/**
 * PURE. The compute-unit price to pay: the fixed price or the network's reading over the floor, the urgent
 * multiple on an exit, then capped so that price x units stays under maxLamports.
 */
export function chooseComputeUnitPrice(reading: number | null, units: number, urgent: boolean, env: PriorityFeeEnv): number {
  const base = env.fixedMicroLamports > 0 ? env.fixedMicroLamports : Math.max(env.minMicroLamports, reading ?? 0);
  const wanted = urgent ? base * env.urgentMultiple : base;
  const capped = units > 0 ? Math.floor((env.maxLamports * 1_000_000) / units) : wanted;
  return Math.max(0, Math.floor(Math.min(wanted, capped)));
}

/** The writable accounts a legacy transaction locks (the fee payer aside): what the network's fee reading is asked about. */
function writableAccounts(tx: Transaction): PublicKey[] {
  const payer = tx.feePayer?.toBase58();
  const seen = new Map<string, PublicKey>();
  for (const ix of tx.instructions) for (const k of ix.keys) if (k.isWritable && k.pubkey.toBase58() !== payer) seen.set(k.pubkey.toBase58(), k.pubkey);
  return [...seen.values()].slice(0, 128);
}

/** The network's recent fee for the accounts: the 75th percentile of the slots reported, or null when it cannot be read. */
export async function readNetworkPrice(connection: Pick<Connection, "getRecentPrioritizationFees">, accounts: PublicKey[]): Promise<number | null> {
  try {
    const rows = await connection.getRecentPrioritizationFees(accounts.length ? { lockedWritableAccounts: accounts } : undefined);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return percentile(rows.map((r) => r.prioritizationFee), 75);
  } catch {
    return null;
  }
}

export interface PriorityApplied {
  microLamports: number;
  units: number;
  /** the most the transaction pays in priority fee, lamports (price x units) */
  lamports: number;
  urgent: boolean;
  source: "fixed" | "network" | "floor";
}

/**
 * Put a compute-unit price on a legacy transaction before it is signed. Null when it was left alone: a
 * versioned transaction (its builder owns its budget) or one that already names a price.
 */
export async function applyPriorityFee(tx: Transaction | VersionedTransaction, connection: Pick<Connection, "getRecentPrioritizationFees"> | null, urgent: boolean, env: PriorityFeeEnv = priorityFeeEnv()): Promise<PriorityApplied | null> {
  if (tx instanceof VersionedTransaction || !Array.isArray((tx as Transaction).instructions)) return null;
  if (hasComputeUnitPrice(tx)) return null;
  const units = computeUnitLimitOf(tx);
  const reading = env.fixedMicroLamports > 0 || !connection ? null : await readNetworkPrice(connection, writableAccounts(tx));
  const microLamports = chooseComputeUnitPrice(reading, units, urgent, env);
  if (!(microLamports > 0)) return null;
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  const source = env.fixedMicroLamports > 0 ? "fixed" : reading !== null && reading > env.minMicroLamports ? "network" : "floor";
  return { microLamports, units, lamports: Math.ceil((microLamports * units) / 1_000_000), urgent, source };
}
