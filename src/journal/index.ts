/**
 * Append-only decision journal. Every cycle writes one entry:
 *   data/decisions.jsonl  - full record, one JSON object per line (the source of truth for bands.finance)
 *   data/latest.json      - last 100 entries, newest first
 *   data/feed.md          - human-readable feed, newest first
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import type { Decision } from "../agent/schema";
import type { DecideResult } from "../agent/decide";
import type { ExecutionResult } from "../executor";
import { quoteOf, SOL_MINT, type BinRow, type PoolSnapshot, type PositionSnapshot, type QuoteSymbol } from "../tools/dlmm";
import type { PoolAnalytics } from "../tools/lpagent";

export interface JournalPool {
  address: string;
  label: string;
  tokenX: { symbol: string; decimals: number };
  tokenY: { symbol: string; decimals: number };
  solSide: "X" | "Y" | null;
  binStep: number;
  activeBinId: number;
  /** Y per X */
  price: number;
  priceLabel: string;
  /** base token in SOL (for a USDC pool: tokenPriceInQuote x quotePriceInSol) */
  tokenPriceInSol: number;
  baseFeePct: number;
  dynamicFeePct: number;
  /** bins around the active bin at observation time, for the ladder */
  bins: BinRow[];
  // ---- quote fields, absent on entries written before USDC pools; readers default through journalQuote() (quoteSymbol "SOL")
  quoteSymbol?: QuoteSymbol;
  quoteMint?: string;
  /** which side of the pair is the quote (SOL or USDC); old entries: solSide */
  quoteSide?: "X" | "Y";
  /** one quote token in SOL (1 for SOL pools) */
  quotePriceInSol?: number;
  /** base token in the quote token, UI units */
  tokenPriceInQuote?: number;
}

/** The quote of a journal pool with the defaults an old entry needs: SOL, at 1 SOL per SOL. */
export function journalQuote(pool: Pick<JournalPool, "solSide" | "tokenPriceInSol" | "quoteSymbol" | "quoteMint" | "quoteSide" | "quotePriceInSol" | "tokenPriceInQuote">): {
  quoteSymbol: QuoteSymbol;
  quoteMint: string;
  quoteSide: "X" | "Y";
  quotePriceInSol: number;
  tokenPriceInQuote: number;
} {
  const quotePriceInSol = typeof pool.quotePriceInSol === "number" && pool.quotePriceInSol > 0 ? pool.quotePriceInSol : 1;
  return {
    quoteSymbol: pool.quoteSymbol ?? "SOL",
    quoteMint: pool.quoteMint ?? SOL_MINT,
    quoteSide: pool.quoteSide ?? pool.solSide ?? "Y",
    quotePriceInSol,
    tokenPriceInQuote: typeof pool.tokenPriceInQuote === "number" ? pool.tokenPriceInQuote : pool.tokenPriceInSol / quotePriceInSol,
  };
}

export interface JournalEntry {
  id: string;
  ts: string;
  cycle: number;
  mode: "dry-run" | "live";
  agent: { id: string; name: string };
  pool: JournalPool;
  /** quote / quoteSymbol: the wallet's balance of the pool's quote token; absent on old entries (SOL pools: = sol) */
  wallet: { address: string; sol: number; token: number; tokenSymbol: string; quote?: number; quoteSymbol?: string };
  positions: PositionSnapshot[];
  analytics: PoolAnalytics | null;
  llm: Omit<DecideResult, "decision">;
  proposal: Decision;
  decision: Decision;
  allowed: boolean;
  violations: string[];
  overrides: string[];
  passed: string[];
  emergency: boolean;
  execution: ExecutionResult;
  headline: string;
  screen?: { rank: number; rankedPools: number; score: number; feeToTvl24hPct: number | null } | null;
  /** the engine's view for this pool this cycle (src/engine); absent in entries written before it existed */
  engine?: JournalEngine;
}

export interface JournalEngine {
  directive: string | null;
  reason: string | null;
  sizeMultiplier: number;
  bench: { stops6h: number; multiplier: number; benched: boolean };
  regime: { medianMove24hPct: number | null; multiplier: number };
  halt: { until: number; stage: number } | null;
  standDown: { until: number; reason: string | null } | null;
  /** per-band stop percent for the bands open in this pool */
  stops: Record<string, number>;
  collectsToday: number;
  /** stock pools: the US session, the basis to Backpack's perp, and the rule that applied */
  basis?: { session: string; minutesToOpen: number; basisPct: number | null; perpSymbol: string | null; widthMultiplier: number; reason: string | null };
}

export function toJournalPool(s: PoolSnapshot): JournalPool {
  const q = quoteOf(s);
  return {
    address: s.address,
    label: s.label,
    tokenX: { symbol: s.tokenX.symbol, decimals: s.tokenX.decimals },
    tokenY: { symbol: s.tokenY.symbol, decimals: s.tokenY.decimals },
    solSide: s.solSide,
    binStep: s.binStep,
    activeBinId: s.activeBinId,
    price: s.activePrice,
    priceLabel: s.priceLabel,
    tokenPriceInSol: s.tokenPriceInSol,
    baseFeePct: s.baseFeePct,
    dynamicFeePct: s.dynamicFeePct,
    bins: s.bins,
    quoteSymbol: q.symbol,
    quoteMint: q.token.mint,
    quoteSide: q.side,
    quotePriceInSol: q.priceInSol,
    tokenPriceInQuote: q.tokenPriceInQuote,
  };
}

export const dataDir = () => path.resolve(process.cwd(), config.dataDir);
const JSONL = () => path.join(dataDir(), "decisions.jsonl");

/** Newest first. */
export function readRecent(limit = 100): JournalEntry[] {
  try {
    const lines = fs.readFileSync(JSONL(), "utf8").trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => JSON.parse(l) as JournalEntry)
      .reverse();
  } catch {
    return [];
  }
}

export function appendJournal(entry: JournalEntry, { renderDerived = true } = {}): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.appendFileSync(JSONL(), JSON.stringify(entry) + "\n");
  if (renderDerived) renderDerivedFiles();
}

export function renderDerivedFiles(): void {
  const recent = readRecent(100);
  fs.writeFileSync(path.join(dataDir(), "latest.json"), JSON.stringify(recent, null, 2));
  fs.writeFileSync(path.join(dataDir(), "feed.md"), renderFeed(recent.slice(0, 30)));
}

function solscan(sig: string): string {
  return `https://solscan.io/tx/${sig}`;
}

export function renderFeed(entries: JournalEntry[]): string {
  const out: string[] = [];
  const head = entries[0];
  out.push(`# ${head?.agent?.name ?? "Mr Bands"} decision journal`);
  out.push("");
  if (head) {
    out.push(`Pool: ${head.pool.label} (${head.pool.address}) · Mode: ${head.mode.toUpperCase()} · Updated: ${head.ts}`);
    out.push("");
  }
  for (const e of entries) {
    const status = e.emergency ? "GUARD OVERRIDE" : e.allowed ? "allowed" : "BLOCKED";
    out.push(`## ${e.ts} · ${e.decision.action} · ${status}`);
    out.push("");
    out.push(`> "${e.headline}"`);
    out.push("");
    out.push(`Price ${e.pool.price.toPrecision(6)} ${e.pool.priceLabel} · active bin ${e.pool.activeBinId} · dynamic fee ${e.pool.dynamicFeePct.toFixed(3)}% · bands open: ${e.positions.length}`);
    out.push("");
    out.push(`**Reasoning.** ${e.decision.reasoning}`);
    if (e.proposal.action !== e.decision.action) {
      out.push("");
      out.push(`**Proposed.** ${e.proposal.action}: ${e.proposal.reasoning}`);
    }
    if (e.violations.length) out.push(`\n**Guards rejected:** ${e.violations.join("; ")}`);
    if (e.overrides.length) out.push(`\n**Guards overrode:** ${e.overrides.join("; ")}`);
    if (e.execution.txs.length) {
      out.push("");
      out.push(`**Execution (${e.execution.mode}):**`);
      for (const t of e.execution.txs) {
        const detail = t.signature ? `[${t.signature.slice(0, 12)}…](${solscan(t.signature)})` : t.skipped ?? (t.ok ? `simulated ok, ${t.unitsConsumed ?? "?"} CU` : `failed: ${t.error}`);
        out.push(`- ${t.label}: ${detail}`);
      }
    }
    if (e.llm.source === "fallback") out.push(`\n_LLM fallback: ${e.llm.note}_`);
    if (e.llm.source === "engine") out.push(`\n_Engine directive: ${e.llm.note}_`);
    out.push("");
  }
  return out.join("\n");
}
