/**
 * A real ceiling on what chat can spend in a day. Ports Meridian's agent/src/spendGuards.ts.
 *
 * The per-wallet rate limit and the global concurrency cap (chatLimits.ts) multiply rather than
 * bound: N messages per wallet per minute times however many wallets sign up is a slope, not a
 * number. This is the flat backstop underneath them. The defaults sit far above normal use on
 * purpose, so a trip means something is wrong, and CHAT_MAX_TURNS_PER_DAY=0 closes chat entirely,
 * which is the kill switch that does not require a deploy.
 *
 * COUNTED FROM THE LEDGER, never from a process counter: a counter resets on deploy, and a crash
 * loop would hand the box a fresh allowance on every restart, which is precisely the failure a
 * spend ceiling exists to stop. Metered in its OWN file (turns.jsonl), not in credits.jsonl, so the
 * ceiling stays armed while charging is switched off: model spend happens whether or not the user
 * pays for it. A failed or refunded turn still counts here; it cost the same tokens.
 *
 * Ledger row (one per turn that reached the model, written by myAgent.ts after the call):
 *   { wallet, ts, ok, model, inputTokens, outputTokens }      ts = epoch ms
 *
 * The parsed rows are cached on the file's stat (ledgerView); the trailing-24h window is counted at
 * query time, so a tripped ceiling rolls off with the clock even when nothing new is written.
 */
import { appendLedger, ledgerView } from "../lib/ledger";
import { platformEnv } from "./config";

export const TURNS_FILE = "turns.jsonl";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TurnRow {
  wallet: string;
  ts: number;
  ok: boolean;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface SpendWindow {
  /** metered turns in the window, all wallets */
  total: number;
  /** metered turns in the window, per wallet (case-sensitive base58) */
  byWallet: Map<string, number>;
}

/** The two fields of a turn row the fold needs; declared locally so the dependency runs one way. */
interface LedgerRow {
  wallet?: unknown;
  ts?: unknown;
  at?: unknown;
}

function rowTime(row: LedgerRow): number | null {
  const raw = row.ts ?? row.at;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * Pure fold: how many turns each wallet has taken since `since`. Rows with a missing or malformed
 * timestamp are ignored: a row we cannot place in time cannot be placed in the window either.
 */
export function foldSpend(rows: LedgerRow[], since: number): SpendWindow {
  const byWallet = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const t = rowTime(row);
    if (t === null || t < since) continue;
    if (typeof row.wallet !== "string" || !row.wallet) continue;
    byWallet.set(row.wallet, (byWallet.get(row.wallet) ?? 0) + 1);
    total += 1;
  }
  return { total, byWallet };
}

/** Parsed once per file change; the window is folded from this at query time. */
const turnsView = ledgerView<LedgerRow[]>(TURNS_FILE, (rows) => rows as LedgerRow[]);

/** The trailing-24h view, folded from the ledger. */
export function spendWindow(now = Date.now()): SpendWindow {
  return foldSpend(turnsView.get(), now - DAY_MS);
}

/**
 * Record one metered turn. Called for EVERY turn that reached the model, charged or not, successful
 * or not. Never throws: a meter that can fail the request it is metering would turn a disk hiccup
 * into an outage, and the ceiling exists to prevent outages.
 */
export function recordTurn(row: Omit<TurnRow, "ts"> & { ts?: number }): void {
  try {
    appendLedger(TURNS_FILE, { ...row, ts: row.ts ?? Date.now() });
  } catch {
    /* a dropped row only means the window under-counts, which is the safe direction for the caller */
  }
  turnsView.reset();
}

/** Drop the cached parse. For tests, and for anything that rewrites the ledger. */
export function resetSpendWindow(): void {
  turnsView.reset();
}

export interface CeilingBreach {
  status: number;
  code: string;
  error: string;
}

/**
 * Pure ceiling check against an already-folded window. The global ceiling is a 503 because the
 * service, not the caller, is the thing that is unavailable; the per-wallet one is a 429 because
 * that caller really has had their share. Both trip when the count has REACHED the max, so a max
 * of N allows exactly N turns in the window and refuses the N+1th; a max of 0 refuses everything.
 */
export function ceilingBreach(view: SpendWindow, wallet: string, limits: { globalMax: number; walletMax: number }): CeilingBreach | null {
  if (view.total >= limits.globalMax) {
    return {
      status: 503,
      code: "chat_daily_cap",
      error: "bands.finance has hit its daily limit on advisor conversations. chat is paused until it resets; nothing you did caused this.",
    };
  }
  const mine = view.byWallet.get(wallet) ?? 0;
  if (mine >= limits.walletMax) {
    return {
      status: 429,
      code: "wallet_daily_cap",
      error: `you've used ${limits.walletMax} advisor messages in the last 24 hours, which is today's limit for one wallet. it frees up as those roll off.`,
    };
  }
  return null;
}

let lastGlobalLog = 0;

/** Live ceiling check for a chat route. Returns the response to send, or null to proceed. */
export function chatSpendBlocked(wallet: string): CeilingBreach | null {
  const env = platformEnv();
  const limits = { globalMax: env.chatMaxTurnsPerDay, walletMax: env.chatMaxTurnsPerWalletPerDay };
  const view = spendWindow();
  const breach = ceilingBreach(view, wallet, limits);
  if (breach?.code === "chat_daily_cap") {
    const now = Date.now();
    if (now - lastGlobalLog > 60_000) {
      lastGlobalLog = now;
      console.error(`[spend] GLOBAL CHAT CEILING HIT: ${view.total} turns in the last 24h, max ${limits.globalMax}. Chat is refusing every wallet until this rolls off or CHAT_MAX_TURNS_PER_DAY is raised.`);
    }
  }
  return breach;
}

/** Ops snapshot: where today's chat spend sits against both ceilings. */
export function chatSpendStatus(): { turns24h: number; maxPerDay: number; maxPerWalletPerDay: number; wallets24h: number } {
  const env = platformEnv();
  const view = spendWindow();
  return { turns24h: view.total, maxPerDay: env.chatMaxTurnsPerDay, maxPerWalletPerDay: env.chatMaxTurnsPerWalletPerDay, wallets24h: view.byWallet.size };
}
