/**
 * Backfill DATA_DIR/equity.jsonl from the journal, for a run that began before the desk wrote equity
 * points (2026-09-16). One point per cycle, the desk's arithmetic: wallet SOL at the cycle's first
 * entry, the USDC leg at the SOL price, every band marked with its unclaimed fees, wallet tokens at
 * mark. Two things the live points have that a backfill cannot: the hedge desk (unknown after the
 * fact, written as 0) and refundable rent (not counted by either). Claimed fees come from the ledger
 * up to each cycle's time. Cycle numbers restart when the desk does, so a cycle is a run of
 * consecutive entries with the same number.
 *
 * A paper run (DATA_DIR/paper-book.json) sets the frame: every entry from the book's start is a paper
 * point whatever the journal called it (the first two hours of the first run were written as
 * "dry-run"), the book's start capital is the first point, and a top-up the book folded into its
 * start (startSol above the first entry's wallet) is added to the points before it so the run reads
 * as one line from one start, the way the book itself reports it.
 * Refuses to overwrite an existing file unless --force.
 *   DATA_DIR=data-live npx tsx src/scripts/backfill-equity.ts [--force]
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { readLedgerRows } from "../engine/ledger";
import type { EquityPoint, JournalEntry } from "../journal";

const dir = path.resolve(process.cwd(), config.dataDir);
const journal = path.join(dir, "decisions.jsonl");
const out = path.join(dir, "equity.jsonl");
const force = process.argv.includes("--force");

if (fs.existsSync(out) && !force) {
  console.error(`${path.relative(process.cwd(), out)} exists; pass --force to rewrite it`);
  process.exit(2);
}
const entries = fs
  .readFileSync(journal, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as JournalEntry);
const rows = readLedgerRows().filter((r) => (r.mech === "collect" || r.mech === "close") && typeof r.feeSol === "number");
const bookFile = path.join(dir, "paper-book.json");
const book = fs.existsSync(bookFile) ? (JSON.parse(fs.readFileSync(bookFile, "utf8")) as { startedAt: string; startSol: number; startUsdc: number }) : null;
const paperFrom = book ? new Date(book.startedAt).getTime() : Infinity;

// Consecutive entries with the same cycle number are one cycle; a gap over three minutes or a pool
// written twice starts another (the number restarts at 1 with the desk: web/src/derive.ts cyclesOf).
const CYCLE_GAP_MS = 3 * 60_000;
const cycles: JournalEntry[][] = [];
let seen = new Set<string>();
let lastT = 0;
for (const e of entries) {
  const t = new Date(e.ts).getTime();
  const last = cycles[cycles.length - 1];
  if (last && last[0].cycle === e.cycle && t - lastT <= CYCLE_GAP_MS && !seen.has(e.pool.address)) last.push(e);
  else {
    cycles.push([e]);
    seen = new Set();
  }
  seen.add(e.pool.address);
  lastT = t;
}

const quoteLeg = (e: JournalEntry): { sol: number; usdc: number } | null => {
  const w = e.wallet as JournalEntry["wallet"] & { quote?: number; quoteSymbol?: string };
  const q = e.pool as JournalEntry["pool"] & { quotePriceInSol?: number };
  if (typeof w.quote !== "number" || !w.quoteSymbol || w.quoteSymbol === "SOL") return null;
  return { sol: w.quote * (typeof q.quotePriceInSol === "number" && q.quotePriceInSol > 0 ? q.quotePriceInSol : 0), usdc: w.quote };
};

const executedExit = (e: JournalEntry) => e.allowed && e.execution.ok && e.execution.txs.length > 0 && (e.decision.action === "CLOSE_POSITION" || e.decision.action === "REBALANCE" || e.decision.action === "CLAIM_FEES");

// A top-up the book folded into its start: the wallet's SOL rising by about the deficit from one
// entry to the next with no exit executed at the earlier one (a close's SOL lands after its entry,
// so a close followed by a jump is explained; a HOLD followed by +50 is a deposit). Points before it
// are short by that much. Nothing is added when no such jump is found.
const firstPaper = cycles.find((c) => new Date(c[0].ts).getTime() >= paperFrom);
const deficit = book && firstPaper ? book.startSol - firstPaper[0].wallet.sol : 0;
let topUpAt: number | null = null;
if (deficit > 0.5) {
  for (let i = 1; i < entries.length; i++) {
    const t = new Date(entries[i].ts).getTime();
    if (t < paperFrom) continue;
    const jump = entries[i].wallet.sol - entries[i - 1].wallet.sol;
    if (jump >= deficit - 0.5 && jump <= deficit + 0.5 && !executedExit(entries[i - 1])) {
      topUpAt = t;
      break;
    }
  }
  console.log(`paper book starts with ${book!.startSol} SOL, the journal's first paper entry holds ${firstPaper![0].wallet.sol.toFixed(2)}: ${topUpAt !== null ? `a ${deficit.toFixed(2)} SOL top-up at ${new Date(topUpAt).toISOString()}, added to the points before it` : `no top-up found, the ${deficit.toFixed(2)} SOL difference is left as is`}`);
}
const shortBy = (t: number): number => (topUpAt !== null && t >= paperFrom && t < topUpAt ? deficit : 0);

const points: EquityPoint[] = [];
let fi = 0;
let feesClaimedSol = 0;
for (const c of cycles) {
  const first = c[0];
  const t = new Date(c[c.length - 1].ts).getTime();
  while (fi < rows.length && rows[fi].ts <= t) feesClaimedSol += rows[fi++].feeSol ?? 0;
  const tokens = new Map<string, number>();
  let bandsSol = 0;
  let bands = 0;
  let quote: { sol: number; usdc: number } | null = null;
  for (const e of c) {
    const base = e.pool.solSide === "X" ? e.pool.tokenY.symbol : e.pool.tokenX.symbol;
    tokens.set(base, e.wallet.token * e.pool.tokenPriceInSol);
    bandsSol += e.positions.reduce((s, p) => s + p.valueInSol, 0);
    bands += e.positions.length;
    if (!quote) quote = quoteLeg(e);
  }
  const tokensSol = [...tokens.values()].reduce((s, v) => s + v, 0);
  const paper = t >= paperFrom;
  const walletSol = first.wallet.sol + shortBy(t);
  const equitySol = walletSol + (quote?.sol ?? 0) + bandsSol + tokensSol;
  if (!Number.isFinite(equitySol)) continue;
  points.push({
    t,
    cycle: first.cycle,
    agent: first.agent?.id ?? "mr-bands",
    mode: paper ? "paper" : first.mode,
    equitySol,
    walletSol,
    quoteSol: quote?.sol ?? 0,
    quoteUsdc: quote?.usdc ?? 0,
    bandsSol,
    tokensSol,
    hedgeSol: 0,
    bands,
    pools: c.length,
    feesClaimedSol,
    solPriceUsd: null,
  });
}
// the book's own start, as the first point: its capital at the first SOL price the journal saw
if (book && points.some((p) => p.mode === "paper")) {
  const firstQuoted = entries.find((e) => (e.wallet as { quoteSymbol?: string }).quoteSymbol === "USDC" && typeof (e.pool as { quotePriceInSol?: number }).quotePriceInSol === "number");
  const usdcSol = firstQuoted ? (firstQuoted.pool as { quotePriceInSol?: number }).quotePriceInSol! : 0;
  const t0 = new Date(book.startedAt).getTime();
  const p0: EquityPoint = { t: t0, cycle: 0, agent: points[0].agent, mode: "paper", equitySol: book.startSol + book.startUsdc * usdcSol, walletSol: book.startSol, quoteSol: book.startUsdc * usdcSol, quoteUsdc: book.startUsdc, bandsSol: 0, tokensSol: 0, hedgeSol: 0, bands: 0, pools: 0, feesClaimedSol: 0, solPriceUsd: usdcSol > 0 ? 1 / usdcSol : null };
  const i = points.findIndex((p) => p.t >= t0);
  points.splice(i < 0 ? points.length : i, 0, p0);
}
fs.writeFileSync(out, points.map((p) => JSON.stringify(p)).join("\n") + (points.length ? "\n" : ""));
const first = points[0];
const last = points[points.length - 1];
console.log(`wrote ${points.length} points to ${path.relative(process.cwd(), out)}: ${first ? `${new Date(first.t).toISOString()} ${first.equitySol.toFixed(2)} SOL` : "none"} -> ${last ? `${new Date(last.t).toISOString()} ${last.equitySol.toFixed(2)} SOL, ${last.feesClaimedSol.toFixed(3)} SOL claimed` : ""}`);
