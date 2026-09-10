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
import type { BinRow, PoolSnapshot, PositionSnapshot } from "../tools/dlmm";
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
  tokenPriceInSol: number;
  baseFeePct: number;
  dynamicFeePct: number;
  /** bins around the active bin at observation time, for the ladder */
  bins: BinRow[];
}

export interface JournalEntry {
  id: string;
  ts: string;
  cycle: number;
  mode: "dry-run" | "live";
  agent: { id: string; name: string };
  pool: JournalPool;
  wallet: { address: string; sol: number; token: number; tokenSymbol: string };
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
}

export function toJournalPool(s: PoolSnapshot): JournalPool {
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
    out.push("");
  }
  return out.join("\n");
}
