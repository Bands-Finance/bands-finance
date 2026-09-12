/**
 * x402, receiving side, on Solana. Ports Meridian's agent/src/payments/PaymentGate.ts:
 * requirements() (the 402 body), paymentMessage() with its no-newline-in-resource
 * invariant, the verify() mode switch, verifyOnChain/settleOnChain, the replay set folded
 * from x402-used.jsonl plus a synchronous in-flight reservation, burn(), settleStranded()
 * and MAX_AGE_SECONDS = 900. What changed is the chain: an EVM Transfer log to a treasury
 * address becomes an SPL Token Transfer / TransferChecked into the treasury's USDC
 * associated token account, the payer of record is the OWNER of the source token account
 * (read from meta.preTokenBalances), and the proof is an ed25519 signature over the
 * authorization message instead of a secp256k1 personal_sign.
 *
 * Verification modes, from X402_TREASURY (owner pubkey) and X402_VERIFY:
 *   neither set           stub: accept anything, log loudly. Local dev only.
 *   treasury, no verify   refuse every priced call. A treasury declares intent to collect
 *                         real money; pairing that with no verification would give the
 *                         product away while the revenue ledger records income that never
 *                         arrived. Fail closed.
 *   X402_VERIFY=self      verify on chain through the injected connection. No facilitator
 *                         exists for this rail, so the chain itself is the source of truth.
 *
 * The connection is injected as the minimal `VerifyConnection` interface so verification
 * can be exercised against a fake transaction with no network (src/scripts/test-rails.ts).
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  decodeTransferCheckedInstruction,
  decodeTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import { appendLedger, ledgerView } from "../../lib/ledger";
import { base58Decode } from "../../tools/wallet";
import { decodeSignature, isAddress } from "../accounts";

/** CAIP-2 id of Solana mainnet-beta; the only network this gate quotes or accepts. */
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
/** USDC on Solana mainnet, 6 decimals. The only settlement asset; nothing here converts. */
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const USDC_DECIMALS = 6;
/** A payment older than this is not fresh proof (settleStranded ignores it on purpose). */
export const MAX_AGE_SECONDS = 15 * 60;

export interface X402Requirements {
  x402Version: 1;
  accepts: Array<{
    scheme: "exact";
    network: string;
    /** SPL mint the payment must settle in (USDC). */
    asset: string;
    /** raw token units (USDC has 6 decimals), as a decimal string */
    maxAmountRequired: string;
    resource: string;
    /** the treasury's USDC associated token account, where the transfer must land */
    payTo: string;
    description: string;
  }>;
  /** How to build the X-PAYMENT header, so the proof requirement is discoverable from the challenge itself. */
  proof: {
    header: string;
    format: string;
    signMessage: string;
    note: string;
  };
}

export type GateMode = "stub" | "refuse" | "self";

export type VerifyResult =
  | { ok: true; signature?: string; payer?: string; stub?: boolean }
  | { ok: false; error: string };

/** The slice of a fetched transaction the gate reads. A web3.js VersionedTransactionResponse satisfies it. */
export interface PaymentTxResponse {
  blockTime?: number | null;
  meta: {
    err: unknown;
    preTokenBalances?: Array<{ accountIndex: number; mint: string; owner?: string }> | null;
    innerInstructions?: Array<{ index: number; instructions: Array<{ programIdIndex: number; accounts: number[]; data: string }> }> | null;
    loadedAddresses?: { writable: PublicKey[]; readonly: PublicKey[] } | null;
  } | null;
  transaction: {
    message: {
      staticAccountKeys: PublicKey[];
      compiledInstructions: Array<{ programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }>;
    };
  };
}

/** The one RPC call verification needs. `Connection` satisfies it; tests inject a fake. */
export interface VerifyConnection {
  getTransaction(
    signature: string,
    config: { maxSupportedTransactionVersion: number; commitment: "confirmed" },
  ): Promise<PaymentTxResponse | null>;
}

/** USD -> raw USDC units. USDC's unit is the dollar, so this is the only conversion the gate has. */
export function rawUnits(amountUsd: number): bigint {
  if (!Number.isFinite(amountUsd) || amountUsd < 0) throw new Error(`bad amount ${amountUsd}`);
  return BigInt(Math.round(amountUsd * 10 ** USDC_DECIMALS));
}

export function displayAmount(amountUsd: number): string {
  return `$${amountUsd.toFixed(4)}`;
}

/** The treasury's USDC associated token account for an owner pubkey. */
export function treasuryAtaFor(owner: string): string {
  return getAssociatedTokenAddressSync(USDC_MINT, new PublicKey(owner), true).toBase58();
}

/** A base58 transaction signature: 64 bytes. Case-sensitive; never lowercase a Solana signature. */
export function isTxSignature(s: unknown): s is string {
  if (typeof s !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(s)) return false;
  try {
    return base58Decode(s).length === 64;
  } catch {
    return false;
  }
}

/**
 * The exact message a payer signs to prove the payment is THEIRS.
 *
 * Binds the specific transfer (tx signature), the specific tool it pays for (resource)
 * and this deployment (cluster + treasury token account), so a signature cannot be lifted
 * to a different call, a different tool or a different operator. Deliberately does NOT
 * include the price: the transfer carries the value and the gate checks it covers the
 * cost; a price change between the 402 and the retry must not invalidate an honest payment.
 */
export function paymentMessage(params: { signature: string; resource: string; treasury: string }): string {
  // The message is newline-delimited, so a resource containing a newline could forge a
  // later line. Every resource today is a tool name from the price table, which is why
  // this throws instead of escaping: it is an assertion that the invariant still holds,
  // and it fails loudly the day someone builds a resource from user input.
  if (/[\r\n]/.test(params.resource)) throw new Error("payment resource must not contain a line break");
  return [
    "bands.finance x402 payment authorization",
    "Cluster: mainnet-beta",
    `Treasury: ${params.treasury}`,
    `Resource: ${params.resource}`,
    `Tx: ${params.signature}`,
  ].join("\n");
}

export interface PaymentGateOptions {
  /** X402_TREASURY: the treasury OWNER pubkey. The USDC associated token account is derived from it. */
  treasury?: string;
  /** X402_VERIFY: "" (unset) or "self". */
  verify?: string;
  connection: () => VerifyConnection;
  /** epoch ms; injectable for tests */
  now?: () => number;
}

interface TokenTransfer {
  sourceIndex: number;
  source: PublicKey;
  destination: PublicKey;
  authority: PublicKey;
  amount: bigint;
}

function usedSignatures(rows: unknown[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows as Array<Record<string, unknown>>) if (typeof r.signature === "string") out.add(r.signature);
  return out;
}

export class PaymentGate {
  readonly mode: GateMode;
  /** "" when no treasury is configured */
  readonly treasuryOwner: string;
  /** the treasury's USDC associated token account, "" when no treasury is configured */
  readonly treasuryAta: string;
  private readonly connection: () => VerifyConnection;
  private readonly now: () => number;
  // Replay ledger: every accepted payment signature is burned into x402-used.jsonl so one
  // transfer can never pay for two tool calls, across restarts. Folded from the file
  // (ledgers are the truth) and re-folded whenever the file changes.
  private readonly used = ledgerView<Set<string>>("x402-used.jsonl", usedSignatures);
  // Signatures currently being verified. The used-set is only written at the END of
  // verification, after several awaits, so without this a payer could fire N concurrent
  // requests with the same X-PAYMENT header and have all N pass the used-check before any
  // of them burns. Reserving synchronously (no await between the check and the add) makes
  // verification one-at-a-time per signature.
  private readonly reserving = new Set<string>();

  /**
   * ROTATING THE TREASURY STRANDS IN-FLIGHT PAYMENTS. The treasury token account is bound
   * into the message a payer signs, and both verify() and settleStranded() look for a
   * transfer to whatever it is NOW. Build a grace window before rotating, not after
   * somebody pays into the old account.
   */
  constructor(opts: PaymentGateOptions) {
    const treasury = (opts.treasury ?? "").trim();
    const verify = (opts.verify ?? "").trim();
    if (treasury && !isAddress(treasury)) throw new Error(`X402_TREASURY is not a valid Solana pubkey: ${JSON.stringify(treasury)}`);
    if (verify && verify !== "self") throw new Error(`X402_VERIFY must be unset or "self", got ${JSON.stringify(verify)}`);
    if (verify === "self" && !treasury) throw new Error("X402_VERIFY=self requires X402_TREASURY");
    this.treasuryOwner = treasury;
    this.treasuryAta = treasury ? treasuryAtaFor(treasury) : "";
    this.mode = verify === "self" ? "self" : treasury ? "refuse" : "stub";
    this.connection = opts.connection;
    this.now = opts.now ?? Date.now;
  }

  static fromEnv(connection: () => VerifyConnection): PaymentGate {
    return new PaymentGate({ treasury: process.env.X402_TREASURY, verify: process.env.X402_VERIFY, connection });
  }

  /** The 402 challenge for `resource` priced at `amountUsd`. */
  requirements(amountUsd: number, resource: string): X402Requirements {
    const payTo = this.treasuryAta || "unconfigured";
    return {
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: SOLANA_MAINNET_CAIP2,
          asset: USDC_MINT.toBase58(),
          maxAmountRequired: String(rawUnits(amountUsd)),
          resource,
          payTo,
          description: `bands.finance ${resource} - ${displayAmount(amountUsd)}`,
        },
      ],
      proof: {
        header: "X-PAYMENT",
        format: 'base64(JSON) or raw JSON: { "signature": "<tx signature>", "proofSignature": "<base64 or base58 ed25519 signature over signMessage>" }',
        signMessage: paymentMessage({ signature: "<your payment tx signature>", resource, treasury: payTo }),
        note:
          "Sign the message above with the wallet that SENT the USDC (the owner of the source token account). A tx signature alone is not proof of payment: " +
          "transfers to the treasury are public, so anyone watching the chain could otherwise present someone else's payment as their own.",
      },
    };
  }

  private burn(signature: string, resource: string, amountUsd: number): void {
    appendLedger("x402-used.jsonl", { signature, resource, amountUsd, at: this.now() });
    this.used.reset();
  }

  async verify(paymentHeader: string, amountUsd: number, resource: string): Promise<VerifyResult> {
    if (this.mode === "refuse") {
      console.error(
        `[PaymentGate] REFUSING ${resource}: X402_TREASURY is configured but X402_VERIFY is not, ` +
          `so payments cannot be verified. Set X402_VERIFY=self for on-chain verification.`,
      );
      return { ok: false, error: "payment verification is not configured on this deployment" };
    }
    if (this.mode === "stub") {
      console.log(
        `[PaymentGate:stub] accepting ${displayAmount(amountUsd)} for ${resource} ` +
          `(no X402_VERIFY AND no X402_TREASURY: local dev only, proof not verified)`,
      );
      return { ok: true, stub: true };
    }
    return this.verifyOnChain(paymentHeader, amountUsd, resource);
  }

  /**
   * Header: base64(JSON) or raw JSON with { signature, proofSignature }. The tx signature is
   * public the moment the payment lands, so alone it is a BEARER token; proofSignature
   * proves the caller controls the wallet whose USDC actually moved.
   */
  private async verifyOnChain(header: string, amountUsd: number, resource: string): Promise<VerifyResult> {
    let signature: unknown;
    let proofSignature: unknown;
    try {
      const raw = header.trim().startsWith("{") ? header : Buffer.from(header, "base64").toString("utf8");
      const parsed = JSON.parse(raw) as { signature?: unknown; proofSignature?: unknown };
      signature = parsed.signature;
      proofSignature = parsed.proofSignature;
    } catch {
      return { ok: false, error: "X-PAYMENT must be JSON (optionally base64) with signature and proofSignature fields" };
    }
    if (!isTxSignature(signature)) return { ok: false, error: "invalid signature: expected the base58 signature of your USDC payment transaction" };
    if (typeof proofSignature !== "string" || !decodeSignature(proofSignature)) {
      return {
        ok: false,
        error: "missing proofSignature: sign the payment authorization message from the 402 challenge with the wallet that sent the USDC",
      };
    }
    if (this.used.get().has(signature)) return { ok: false, error: "payment tx already used" };

    // Hold this signature for the duration of the on-chain checks. Nothing may await
    // between the used-check above and this add, or the race reopens.
    if (this.reserving.has(signature)) return { ok: false, error: "this payment is already being verified" };
    this.reserving.add(signature);
    try {
      return await this.settleOnChain(signature, proofSignature, amountUsd, resource);
    } finally {
      // Released either way: on success the signature is now in the used set, so the next
      // attempt fails as already-used rather than racing again.
      this.reserving.delete(signature);
    }
  }

  private async fetchPayment(signature: string): Promise<{ ok: true; tx: PaymentTxResponse } | { ok: false; error: string }> {
    let tx: PaymentTxResponse | null;
    try {
      tx = await this.connection().getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    } catch {
      return { ok: false, error: "could not fetch the payment tx from the RPC; try again shortly" };
    }
    if (!tx) return { ok: false, error: "payment tx not found on Solana mainnet (is it confirmed?)" };
    if (!tx.meta || tx.meta.err !== null) return { ok: false, error: "payment tx failed on chain" };
    return { ok: true, tx };
  }

  /**
   * Sum the USDC that reached the treasury token account in this tx, walking outer and
   * inner instructions of the Token and Token-2022 programs, and remember WHO sent it: the
   * owner of each source token account per meta.preTokenBalances, which is the wallet whose
   * balance moved and therefore who must sign. When the RPC returns no balance row for a
   * source (it always should), the transfer's authority is used instead.
   *
   * Only transfers whose destination IS the treasury's USDC associated token account count.
   * An associated token account is per mint, so a transfer of any other token cannot land
   * there; that is what stops a worthless token paying for a USDC-priced tool.
   */
  private treasuryTransfers(tx: PaymentTxResponse): { paid: bigint; payers: Set<string> } {
    const treasury = new PublicKey(this.treasuryAta);
    const keys = accountKeys(tx);
    const payers = new Set<string>();
    let paid = 0n;
    for (const t of tokenTransfers(tx, keys)) {
      if (!t.destination.equals(treasury)) continue;
      paid += t.amount;
      const row = (tx.meta?.preTokenBalances ?? []).find((b) => b.accountIndex === t.sourceIndex);
      payers.add(row?.owner ?? t.authority.toBase58());
    }
    return { paid, payers };
  }

  /** The awaiting half of on-chain verification, run under the signature reservation. */
  private async settleOnChain(signature: string, proofSignature: string, amountUsd: number, resource: string): Promise<VerifyResult> {
    const fetched = await this.fetchPayment(signature);
    if (!fetched.ok) return fetched;
    const tx = fetched.tx;
    if (typeof tx.blockTime !== "number") return { ok: false, error: "payment tx has no block time yet; retry once it is confirmed" };
    const age = Math.floor(this.now() / 1000) - tx.blockTime;
    if (age > MAX_AGE_SECONDS) return { ok: false, error: `payment tx too old (${age}s > ${MAX_AGE_SECONDS}s)` };

    const required = rawUnits(amountUsd);
    const { paid, payers } = this.treasuryTransfers(tx);
    if (payers.size === 0) return { ok: false, error: `no USDC transfer to ${this.treasuryAta} in that tx` };
    if (paid < required) return { ok: false, error: `insufficient payment: ${paid} USDC-units < ${required} required` };

    // The proof must verify against one of the wallets that actually paid.
    const message = new TextEncoder().encode(paymentMessage({ signature, resource, treasury: this.treasuryAta }));
    const sig = decodeSignature(proofSignature)!;
    let signer: string | null = null;
    for (const payer of payers) {
      try {
        if (nacl.sign.detached.verify(message, sig, new PublicKey(payer).toBytes())) {
          signer = payer;
          break;
        }
      } catch {
        /* not a valid pubkey or signature for this candidate; try the next */
      }
    }
    if (!signer) {
      return {
        ok: false,
        error: `signature does not match the wallet that sent this payment (expected a signature over the authorization message from ${[...payers].join(" or ")})`,
      };
    }

    this.burn(signature, resource, amountUsd);
    console.log(`[PaymentGate:self] verified ${displayAmount(amountUsd)} for ${resource} from ${signer.slice(0, 8)}… via ${signature.slice(0, 8)}…`);
    return { ok: true, signature, payer: signer };
  }

  /**
   * Settle a payment that landed on chain but never reached us: the x402 flow is two calls
   * with a real transfer between them, so a dropped connection after the transfer leaves
   * the money moved and the call unanswered. Runs every on-chain check verify() does EXCEPT
   * the proof signature (the caller is an authenticated operator and the payer is read from
   * the transfer, not supplied) and deliberately ignores MAX_AGE_SECONDS: a stuck payment is
   * old precisely because it got stuck. Refuses when more than one wallet paid, because then
   * it cannot say whose payment this is. The burn makes it single-use like any settlement.
   */
  async settleStranded(
    signature: string,
    amountUsd: number,
    resource: string,
  ): Promise<{ ok: true; payer: string; signature: string } | { ok: false; error: string }> {
    if (this.mode !== "self") return { ok: false, error: "on-chain verification is not configured on this deployment" };
    if (!isTxSignature(signature)) return { ok: false, error: "invalid signature" };
    if (this.used.get().has(signature)) return { ok: false, error: "payment tx already used" };
    const fetched = await this.fetchPayment(signature);
    if (!fetched.ok) return fetched;
    const required = rawUnits(amountUsd);
    const { paid, payers } = this.treasuryTransfers(fetched.tx);
    if (payers.size === 0) return { ok: false, error: `no USDC transfer to ${this.treasuryAta} in that tx` };
    if (paid < required) return { ok: false, error: `insufficient payment: ${paid} USDC-units < ${required} required` };
    if (payers.size > 1) return { ok: false, error: `ambiguous payer: ${[...payers].join(", ")}` };
    const payer = [...payers][0];
    this.burn(signature, resource, amountUsd);
    console.log(`[PaymentGate] settled STRANDED ${displayAmount(amountUsd)} for ${resource} from ${payer} via ${signature}`);
    return { ok: true, payer, signature };
  }
}

/** Static keys followed by the address-table loads, in the order instruction indexes use. */
function accountKeys(tx: PaymentTxResponse): PublicKey[] {
  const loaded = tx.meta?.loadedAddresses;
  return [...tx.transaction.message.staticAccountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
}

/** Every SPL Token / Token-2022 Transfer or TransferChecked in the tx, outer and inner. Anything else is skipped. */
function tokenTransfers(tx: PaymentTxResponse, keys: PublicKey[]): TokenTransfer[] {
  const compiled: Array<{ programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }> = [
    ...tx.transaction.message.compiledInstructions,
  ];
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions) {
      try {
        compiled.push({ programIdIndex: ix.programIdIndex, accountKeyIndexes: ix.accounts, data: base58Decode(ix.data) });
      } catch {
        /* undecodable inner instruction data: not a transfer we can count */
      }
    }
  }
  const out: TokenTransfer[] = [];
  for (const ix of compiled) {
    const programId = keys[ix.programIdIndex];
    if (!programId || (!programId.equals(TOKEN_PROGRAM_ID) && !programId.equals(TOKEN_2022_PROGRAM_ID))) continue;
    if (ix.accountKeyIndexes.some((i) => i >= keys.length)) continue;
    const tag = ix.data[0];
    if (tag !== 3 && tag !== 12) continue; // TokenInstruction.Transfer = 3, TransferChecked = 12
    const tix = new TransactionInstruction({
      programId,
      keys: ix.accountKeyIndexes.map((i) => ({ pubkey: keys[i], isSigner: false, isWritable: false })),
      data: Buffer.from(ix.data),
    });
    try {
      if (tag === 3) {
        const d = decodeTransferInstruction(tix, programId);
        out.push({
          sourceIndex: ix.accountKeyIndexes[0],
          source: d.keys.source.pubkey,
          destination: d.keys.destination.pubkey,
          authority: d.keys.owner.pubkey,
          amount: d.data.amount,
        });
      } else {
        const d = decodeTransferCheckedInstruction(tix, programId);
        out.push({
          sourceIndex: ix.accountKeyIndexes[0],
          source: d.keys.source.pubkey,
          destination: d.keys.destination.pubkey,
          authority: d.keys.owner.pubkey,
          amount: d.data.amount,
        });
      }
    } catch {
      /* malformed for its tag: not a transfer */
    }
  }
  return out;
}
