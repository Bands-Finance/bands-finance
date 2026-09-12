/**
 * Credits: how advisor usage gets paid for. Ports Meridian's agent/src/credits.ts without the MERD
 * branch. 1 credit = 1 message, balances never expire, no subscriptions. Every balance change is an
 * append-only event in credits.jsonl and the per-wallet balance is folded from it; the file is the
 * truth and the fold is cached only on the file's stat.
 *
 * Ledger row: { wallet, kind: "grant" | "spend" | "purchase", credits, reason?, tx?, at }
 *   credits is a positive integer; spend rows are positive and subtract in the fold.
 *
 * SHIPS DORMANT: CREDITS_ENFORCED defaults to "false", so chat is free, but every turn is still
 * metered in turns.jsonl (spendGuards) and the signup grant is still written, so the ledger is real
 * and the balance is there the day charging turns on. Packs are priced in USDC; nothing here sells
 * them (that is the payment rail's job, via addPurchase).
 */
import { appendLedger, ledgerView, readLedger } from "../lib/ledger";
import { platformEnv } from "./config";

const FILE = "credits.jsonl";

export interface CreditEvent {
  /** base58 Solana address, case-sensitive */
  wallet: string;
  kind: "grant" | "spend" | "purchase";
  credits: number;
  reason?: string;
  tx?: string;
  at: number;
}

/**
 * Credit packs a wallet can buy, priced in USDC. Meridian priced these from measured cost (about
 * $0.010 per message inside a warm conversation, $0.024 on a cold start); the volume bonus tracks
 * the cost curve because longer sittings are cheaper per message with a warm cache. Same numbers
 * here until this host measures its own.
 */
export const PACKS = [
  { id: "starter", usd: 5, credits: 200 },
  { id: "plus", usd: 15, credits: 650, bonusPct: 8 },
  { id: "pro", usd: 50, credits: 2300, bonusPct: 15 },
] as const;

export interface CreditPack {
  id: string;
  usd: number;
  credits: number;
  bonusPct?: number;
}

export function packs(): CreditPack[] {
  return PACKS.map((p) => ({ ...p }));
}

/**
 * What a new wallet gets, free, before the credit system is ever mentioned. 50 rather than 20,
 * because 20 is enough to try the product and not enough to form a habit with it. Nothing stops
 * one person taking this grant repeatedly from fresh wallets; the only backstop is the global daily
 * turn ceiling, so raising this raises that exposure proportionally.
 */
export function freeCredits(): number {
  return platformEnv().creditsFreeMessages;
}

/** Whether a message is ACTUALLY being charged for. Only the literal "true"/"on" enforces. */
export function creditsEnforced(): boolean {
  return platformEnv().creditsEnforced;
}

/** One event applied to a running balance. Shared by the pure fold and the live view. */
function applyEvent(balance: number, ev: CreditEvent): number {
  const n = Math.floor(ev.credits);
  if (!Number.isFinite(n) || n <= 0) return balance;
  return ev.kind === "spend" ? Math.max(0, balance - n) : balance + n;
}

/** Pure fold from event history to balance: grants + purchases minus spends, clamped at >= 0 at
 *  every step so a malformed history can never go negative. */
export function creditsFromEvents(events: CreditEvent[]): number {
  return events.reduce(applyEvent, 0);
}

// Per-wallet balances folded from the file. A wallet PRESENT in the map at balance 0 is meaningfully
// different from one absent: presence means "has history", which decides whether the signup grant
// has already been given.
const balances = ledgerView<Map<string, number>>(FILE, (rows) => {
  const out = new Map<string, number>();
  for (const ev of rows as CreditEvent[]) {
    if (!ev || typeof ev.wallet !== "string" || !ev.wallet) continue;
    out.set(ev.wallet, applyEvent(out.get(ev.wallet) ?? 0, ev));
  }
  return out;
});

/** Drop the cached fold (tests, and anything that rewrites the file). */
export function resetCreditsCache(): void {
  balances.reset();
}

function append(wallet: string, kind: CreditEvent["kind"], credits: number, extra?: { reason?: string; tx?: string }): number {
  const ev: CreditEvent = { wallet, kind, credits, ...extra, at: Date.now() };
  appendLedger(FILE, ev);
  balances.reset();
  return balances.get().get(wallet) ?? 0;
}

/** Every event for one wallet, oldest first (for statements and tests). */
export function creditEventsOf(wallet: string): CreditEvent[] {
  if (!balances.get().has(wallet)) return [];
  return readLedger<CreditEvent>(FILE).filter((e) => e && e.wallet === wallet);
}

/**
 * Current balance, granting the signup credits first if this wallet has no event history at all.
 * The grant is lazy on purpose: one mechanism covers brand-new wallets and wallets that signed in
 * before credits existed, with no backfill script. A wallet with ANY history never gets the grant
 * again, so spending to 0 stays 0.
 */
export function balanceOf(wallet: string): number {
  const map = balances.get();
  if (!map.has(wallet)) return append(wallet, "grant", freeCredits(), { reason: "signup" });
  return map.get(wallet) ?? 0;
}

/**
 * Debit n credits if the wallet can afford it. With enforcement off no spend row is written:
 * reporting a balance is fine, but charging while the switch is off would bill users for messages
 * the product said were free. Metering the turn is NOT done here (see spendGuards.recordTurn,
 * written by the chat runtime after the call), so a wallet turned away for being broke is not
 * metered: no tokens are spent on a turn that never reaches the model.
 */
export function trySpend(wallet: string, n = 1): { ok: boolean; balance: number } {
  if (!creditsEnforced()) return { ok: true, balance: balanceOf(wallet) };
  const balance = balanceOf(wallet);
  if (balance < n) return { ok: false, balance };
  return { ok: true, balance: append(wallet, "spend", n) };
}

/**
 * Give a credit back, used when a charged turn hard-fails so a user is never charged for an error.
 * No-op when enforcement is off: there was no spend to undo, and refunding anyway would mint
 * credits out of failures.
 */
export function refundCredit(wallet: string, n = 1, reason = "refund"): number {
  if (!creditsEnforced()) return balanceOf(wallet);
  return append(wallet, "grant", n, { reason });
}

/** Record a verified pack purchase. The tx signature ties the credits to the on-chain payment, so
 *  every purchase row is independently checkable. For the payment rail to call. */
export function addPurchase(wallet: string, packId: string, credits: number, txSignature?: string): number {
  balanceOf(wallet); // a wallet's first row is always its signup grant, never a purchase
  return append(wallet, "purchase", credits, { reason: `pack:${packId}`, ...(txSignature ? { tx: txSignature } : {}) });
}

/** An operator grant (support top-up, promo). Lands in the ledger under its reason like any other row. */
export function grantCredits(wallet: string, credits: number, reason: string): number {
  balanceOf(wallet); // settle the signup grant first so an operator grant never replaces it
  return append(wallet, "grant", credits, { reason });
}
