/**
 * Wallet-as-account. The wallet IS the identity: no email, no password. A user proves
 * ownership of a Solana wallet by signing a short challenge; the signature authorizes no
 * transaction and moves no funds. Ported from Meridian's accounts.ts (SIWE over viem) to
 * ed25519 over base58 public keys.
 *
 *   issueChallenge(address)             -> { message, nonce }   the exact text the wallet signs
 *   linkAccount({address, nonce, sig})  -> { ok, account }      verifies, appends accounts.jsonl
 *   mintSession(address)                -> 7-day stateless HMAC bearer
 *   verifySession(token)                -> address | null
 *   requireWallet(authorizationHeader)  -> address | null       for Hono routes
 *
 * Nonce = HMAC over `address:issuedAt` (10 min TTL), so it verifies on any replica with no
 * shared store; a best-effort in-process used-set blocks same-process replay.
 * Set BANDS_SESSION_SECRET (32+ chars) on the host; without it a random per-boot secret is
 * used and every deploy signs everyone out.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { appendLedger, ledgerView } from "../lib/ledger";

const NONCE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_SECRET = process.env.BANDS_SESSION_SECRET || randomBytes(32).toString("hex");
export const SESSION_SECRET_IS_EPHEMERAL = !process.env.BANDS_SESSION_SECRET;

export interface WalletSession {
  token: string;
  address: string;
  expiresAt: number;
}

/** Base58, on the ed25519 curve or a PDA; case-sensitive (never lowercase a Solana address). */
export function isAddress(a: unknown): a is string {
  if (typeof a !== "string" || a.length < 32 || a.length > 44) return false;
  try {
    new PublicKey(a);
    return true;
  } catch {
    return false;
  }
}

function hmac(input: string): string {
  return createHmac("sha256", SESSION_SECRET).update(input).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function mintSession(address: string): WalletSession {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(`${address}:${expiresAt}`).toString("base64url");
  return { token: `${payload}.${hmac(payload)}`, address, expiresAt };
}

export function verifySession(token: string | undefined | null): string | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), hmac(payload))) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(payload, "base64url").toString();
  } catch {
    return null;
  }
  const idx = decoded.lastIndexOf(":");
  if (idx < 0) return null;
  const addr = decoded.slice(0, idx);
  const exp = Number(decoded.slice(idx + 1));
  if (!isAddress(addr) || !Number.isFinite(exp) || Date.now() > exp) return null;
  return addr;
}

/** `Authorization: Bearer <token>` -> wallet address, or null. */
export function requireWallet(authorization: string | undefined | null): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return m ? verifySession(m[1]) : null;
}

const usedNonces = new Map<string, number>();

function signedNonce(address: string, issuedAt: number): string {
  const payload = Buffer.from(`${address}:${issuedAt}`).toString("base64url");
  return `${payload}.${hmac(`nonce:${payload}`)}`;
}

function verifyNonce(address: string, nonce: string): { ok: true } | { ok: false; error: string } {
  const dot = nonce.indexOf(".");
  if (dot <= 0) return { ok: false, error: "unknown challenge; reconnect and try again" };
  const payload = nonce.slice(0, dot);
  if (!safeEqual(nonce.slice(dot + 1), hmac(`nonce:${payload}`))) return { ok: false, error: "invalid challenge; reconnect and try again" };
  let decoded: string;
  try {
    decoded = Buffer.from(payload, "base64url").toString();
  } catch {
    return { ok: false, error: "malformed challenge" };
  }
  const idx = decoded.lastIndexOf(":");
  if (idx < 0 || decoded.slice(0, idx) !== address) return { ok: false, error: "challenge does not match this wallet" };
  const iat = Number(decoded.slice(idx + 1));
  if (!Number.isFinite(iat) || Date.now() - iat > NONCE_TTL_MS) return { ok: false, error: "challenge expired; reconnect and try again" };
  const now = Date.now();
  for (const [n, t] of usedNonces) if (now - t > NONCE_TTL_MS) usedNonces.delete(n);
  if (usedNonces.has(nonce)) return { ok: false, error: "challenge already used; reconnect and try again" };
  usedNonces.set(nonce, now);
  return { ok: true };
}

export function signInMessage(address: string, nonce: string): string {
  return (
    "Sign in to bands.finance.\n\n" +
    "This links your account to this wallet. It does not authorize any transaction or move any funds.\n\n" +
    `Wallet: ${address}\n` +
    `Nonce: ${nonce}`
  );
}

export function issueChallenge(address: string): { message: string; nonce: string } | null {
  if (!isAddress(address)) return null;
  const nonce = signedNonce(address, Date.now());
  return { message: signInMessage(address, nonce), nonce };
}

export interface AccountData {
  address: string;
  linkedAt: number;
}

const linkedAtByWallet = ledgerView<Map<string, number>>("accounts.jsonl", (rows) => {
  const out = new Map<string, number>();
  for (const r of rows as Array<Record<string, unknown>>) {
    if (typeof r.address === "string" && typeof r.linkedAt === "number") out.set(r.address, r.linkedAt);
  }
  return out;
});

export function resetAccountCache(): void {
  linkedAtByWallet.reset();
}

export function accountData(address: string): AccountData | null {
  if (!isAddress(address)) return null;
  return { address, linkedAt: linkedAtByWallet.get().get(address) ?? 0 };
}

/** Decode a signature given as base58 or base64 (wallet adapters differ). */
export function decodeSignature(sig: string): Uint8Array | null {
  const s = sig.trim();
  try {
    if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s)) {
      const bytes = base58ToBytes(s);
      if (bytes.length === 64) return bytes;
    }
  } catch {
    /* fall through to base64 */
  }
  try {
    const bytes = Uint8Array.from(Buffer.from(s, "base64"));
    if (bytes.length === 64) return bytes;
  } catch {
    /* not base64 */
  }
  return null;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58ToBytes(s: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) throw new Error("bad base58");
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
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

/** Verify an ed25519 signature over the sign-in message from `address`. Pure; no I/O. */
export function verifyWalletSignature(address: string, message: string, signature: string): boolean {
  if (!isAddress(address)) return false;
  const sig = decodeSignature(signature);
  if (!sig) return false;
  try {
    return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, new PublicKey(address).toBytes());
  } catch {
    return false;
  }
}

export function linkAccount(params: { address: string; nonce: string; signature: string }): { ok: true; account: AccountData; session: WalletSession } | { ok: false; error: string } {
  const { address, nonce, signature } = params;
  if (!isAddress(address)) return { ok: false, error: "invalid address" };
  const nonceCheck = verifyNonce(address, nonce);
  if (!nonceCheck.ok) return nonceCheck;
  if (!verifyWalletSignature(address, signInMessage(address, nonce), signature)) return { ok: false, error: "signature does not match this wallet" };
  appendLedger("accounts.jsonl", { address, linkedAt: Date.now() });
  linkedAtByWallet.reset();
  return { ok: true, account: accountData(address)!, session: mintSession(address) };
}
