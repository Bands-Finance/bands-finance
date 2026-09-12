/**
 * x402, paying side: the mirror of PaymentGate, so Mr Bands can buy other agents' data.
 * Ports Meridian's agent/src/payments/X402Client.ts (settleChallenge) and
 * PaidMcpClient.ts (extractChallenge, callOnce, paidToolCall) from a USDG transfer on
 * Robinhood Chain to a USDC TransferChecked on Solana mainnet.
 *
 * The house wallet is the only signer, and it goes through Wallet.signAndSend, which refuses
 * to broadcast while DRY_RUN is on or when no WALLET_SECRET_KEY is configured. With no
 * X402_VERIFY mode configured this client settles nothing: there is no stub payment, because
 * a stub header would be refused by any real gate and accepted only by a stub one.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PublicKey, Transaction } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import nacl from "tweetnacl";
import type { Wallet } from "../../tools/wallet";
import { isAddress } from "../accounts";
import { SOLANA_MAINNET_CAIP2, USDC_DECIMALS, USDC_MINT, paymentMessage, type X402Requirements } from "./PaymentGate";

export interface PaymentReceipt {
  success: boolean;
  amountUsd: number;
  payer: string;
  /** settlement tx signature */
  reference?: string;
  error?: string;
}

export class X402Client {
  constructor(
    private readonly wallet: Wallet,
    /** X402_VERIFY; "" means this client pays nothing */
    private readonly mode: string = process.env.X402_VERIFY ?? "",
  ) {}

  /** One USDC TransferChecked of `amountUsd` from the house wallet to `payTo` (a USDC token account). */
  async pay(params: { amountUsd: number; payTo: string; memo?: string }): Promise<PaymentReceipt> {
    const payer = this.wallet.publicKey.toBase58();
    if (!this.mode) return { success: false, amountUsd: params.amountUsd, payer, error: "X402_VERIFY is not configured; the house wallet pays nothing" };
    if (!isAddress(params.payTo)) return { success: false, amountUsd: params.amountUsd, payer, error: "payTo is not a valid Solana address" };
    const raw = BigInt(Math.round(params.amountUsd * 10 ** USDC_DECIMALS));
    if (raw === 0n) return { success: true, amountUsd: 0, payer };
    try {
      const destination = new PublicKey(params.payTo);
      const source = getAssociatedTokenAddressSync(USDC_MINT, this.wallet.publicKey);
      // payTo is the payee's USDC token account as quoted in the challenge. If it does not
      // exist the transfer fails and the payment is refused; nothing is created on the
      // payee's behalf, because a challenge carries the account, not its owner.
      const tx = new Transaction().add(createTransferCheckedInstruction(source, USDC_MINT, destination, this.wallet.publicKey, raw, USDC_DECIMALS));
      const signature = await this.wallet.signAndSend(tx);
      console.log(`[x402] paid $${params.amountUsd.toFixed(4)} USDC -> ${params.payTo}${params.memo ? ` (${params.memo})` : ""} tx ${signature}`);
      return { success: true, amountUsd: params.amountUsd, payer, reference: signature };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[x402] payment failed: ${error.slice(0, 160)}`);
      return { success: false, amountUsd: params.amountUsd, payer, error };
    }
  }

  /**
   * Settle a 402 challenge and return the X-PAYMENT header for the retry. Throws when the
   * challenge cannot be satisfied; callers treat that as "this call stays unpaid and
   * unanswered". Refuses any network but Solana mainnet and any asset but USDC: paying a
   * challenge quoted in something else would send USDC against a number that means
   * something else entirely.
   */
  async settleChallenge(requirements: X402Requirements): Promise<string> {
    const accept = requirements.accepts?.[0];
    if (!accept) throw new Error("402 challenge carries no payment terms");
    if (accept.network !== SOLANA_MAINNET_CAIP2) throw new Error(`unsupported x402 network: ${accept.network}`);
    if (accept.asset !== USDC_MINT.toBase58()) throw new Error(`x402 challenge is priced in ${accept.asset}, which this client cannot pay`);
    if (!/^\d+$/.test(accept.maxAmountRequired)) throw new Error("x402 challenge has a malformed maxAmountRequired");
    const amountUsd = Number(accept.maxAmountRequired) / 10 ** USDC_DECIMALS;
    const receipt = await this.pay({ amountUsd, payTo: accept.payTo, memo: `x402 ${accept.resource}` });
    if (!receipt.success || !receipt.reference) throw new Error(`x402 settlement failed: ${receipt.error ?? "no tx reference"}`);
    // Sign the authorization so the proof is ours and no one else's. Without this the tx
    // signature is a bearer token: public on chain the instant the payment lands.
    const message = paymentMessage({ signature: receipt.reference, resource: accept.resource, treasury: accept.payTo });
    const proofSignature = Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), this.wallet.keypair.secretKey)).toString("base64");
    return Buffer.from(JSON.stringify({ signature: receipt.reference, proofSignature })).toString("base64");
  }
}

export interface PaidCallResult {
  content: unknown;
  paid: boolean;
  /** settlement tx signature when a payment was made */
  paymentTx?: string;
}

/** Pull the 402 body out of an MCP error message, which embeds it as text. */
export function extractChallenge(message: string): X402Requirements | null {
  const start = message.indexOf('{"x402Version"');
  if (start < 0) return null;
  try {
    return JSON.parse(message.slice(start)) as X402Requirements;
  } catch {
    // The JSON may be embedded with trailing text; walk to the balanced close.
    let depth = 0;
    for (let i = start; i < message.length; i++) {
      if (message[i] === "{") depth++;
      if (message[i] === "}") depth--;
      if (depth === 0) {
        try {
          return JSON.parse(message.slice(start, i + 1)) as X402Requirements;
        } catch {
          return null;
        }
      }
    }
    return null;
  }
}

async function callOnce(url: string, bearer: string | undefined, tool: string, args: Record<string, unknown>, paymentHeader?: string) {
  const headers: Record<string, string> = {};
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (paymentHeader) headers["X-PAYMENT"] = paymentHeader;
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  const client = new Client({ name: "bands-paid-client", version: "0.1.0" });
  await client.connect(transport);
  try {
    return await client.callTool({ name: tool, arguments: args });
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Call `tool` on the MCP server at `url`; transparently settle a 402 challenge in USDC on
 * Solana and retry. One payment buys one call.
 */
export async function paidToolCall(opts: {
  tool: string;
  url: string;
  payer: X402Client;
  args?: Record<string, unknown>;
  bearer?: string;
}): Promise<PaidCallResult> {
  const args = opts.args ?? {};
  try {
    const result = await callOnce(opts.url, opts.bearer, opts.tool, args);
    return { content: result.content, paid: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const challenge = extractChallenge(message);
    if (!challenge) throw err; // not a payment problem: surface it
    const header = await opts.payer.settleChallenge(challenge);
    const paymentTx = (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { signature: string }).signature;
    const result = await callOnce(opts.url, opts.bearer, opts.tool, args, header);
    return { content: result.content, paid: true, paymentTx };
  }
}
