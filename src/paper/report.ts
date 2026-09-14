/**
 * The paper report: the book priced at its last marks, the decision tally from the journal, and
 * a plain-text rendering for `npm run paper:report` and GET /api/paper. Offline: it reads the
 * book file and the journal, never the chain.
 */
import type { JournalEntry } from "../journal";
import { bookEquitySol } from "./mark";
import type { PaperBook } from "./book";

export interface DecisionTally {
  entries: number;
  holds: number;
  opens: number;
  closes: number;
  rebalances: number;
  claims: number;
  /** guard vetoes: proposals the guards refused */
  vetoes: number;
  /** guard overrides (stop-loss) */
  overrides: number;
  /** engine directives by kind */
  directives: Record<string, number>;
  /** who proposed: llm, policy, engine, proposal, fallback */
  sources: Record<string, number>;
  /** pools decided on */
  pools: number;
  firstTs: string | null;
  lastTs: string | null;
}

/** Count what the journal did since the book started. Entries in any order. */
export function decisionTally(entries: readonly JournalEntry[], sinceIso: string): DecisionTally {
  const since = Date.parse(sinceIso);
  const t: DecisionTally = { entries: 0, holds: 0, opens: 0, closes: 0, rebalances: 0, claims: 0, vetoes: 0, overrides: 0, directives: {}, sources: {}, pools: 0, firstTs: null, lastTs: null };
  const pools = new Set<string>();
  for (const e of entries) {
    const ts = Date.parse(e.ts);
    if (Number.isFinite(since) && Number.isFinite(ts) && ts < since) continue;
    t.entries += 1;
    pools.add(e.pool.address);
    if (!t.firstTs || ts < Date.parse(t.firstTs)) t.firstTs = e.ts;
    if (!t.lastTs || ts > Date.parse(t.lastTs)) t.lastTs = e.ts;
    if (!e.allowed) t.vetoes += 1;
    if (e.overrides?.length) t.overrides += 1;
    if (e.execution?.opened && e.decision.action === "REBALANCE") t.rebalances += 1;
    else if (e.execution?.opened) t.opens += 1;
    else if (e.execution?.closed) t.closes += 1;
    else if (e.allowed && e.decision.action === "CLAIM_FEES" && e.execution?.txs?.length) t.claims += 1;
    else if (e.decision.action === "HOLD" && e.allowed) t.holds += 1; // a vetoed proposal is a HOLD too; it counts as a veto
    const d = e.engine?.directive;
    if (d) t.directives[d] = (t.directives[d] ?? 0) + 1;
    const src = e.llm?.source ?? "llm";
    t.sources[src] = (t.sources[src] ?? 0) + 1;
  }
  t.pools = pools.size;
  return t;
}

export interface PaperSummary {
  startedAt: string;
  ageHours: number;
  solPriceUsd: number | null;
  start: { sol: number; usdc: number; equitySol: number; equityUsd: number | null };
  wallet: { sol: number; usdc: number; tokens: { mint: string; symbol: string; units: number; priceInSol: number; valueSol: number }[] };
  bands: {
    address: string;
    pool: string;
    label: string;
    quoteSymbol: string;
    range: [number, number];
    priceRange: [number, number];
    inRange: boolean | null;
    binsFromRange: number | null;
    activeBinId: number | null;
    valueSol: number;
    feeSol: number;
    entryValueSol: number;
    pnlSol: number;
    pnlPct: number;
    ageHours: number;
    lastMarkAt: number;
  }[];
  closed: { address: string; label: string; realizedSol: number; realizedPct: number; feeSol: number; holdHours: number; reason: string; emergency: boolean; closedAt: number }[];
  feesClaimedSol: number;
  feesRealizedSol: number;
  feesUnclaimedSol: number;
  rentLockedSol: number;
  rentSpentSol: number;
  slippagePaidSol: number;
  realizedSol: number;
  /** marked bands + marked wallet tokens */
  markedSol: number;
  markedBandsSol: number;
  markedTokensSol: number;
  equity: { sol: number; usd: number | null; vsStartSol: number; vsStartPct: number; vsStartUsd: number | null; bandsSol: number; tokensSol: number; usdcSol: number };
  tally: DecisionTally;
}

export function paperSummary(book: PaperBook, entries: readonly JournalEntry[], now = Date.now()): PaperSummary {
  const eq = bookEquitySol(book);
  const usdcInSol = book.solPriceUsd && book.solPriceUsd > 0 ? 1 / book.solPriceUsd : 0;
  const startEquity = book.startSol + book.startUsdc * usdcInSol;
  const toUsd = (sol: number): number | null => (book.solPriceUsd && book.solPriceUsd > 0 ? sol * book.solPriceUsd : null);
  const realizedSol = book.closed.reduce((t, c) => t + c.realizedSol, 0) + book.feesClaimedSol;
  const markedBandsSol = book.bands.reduce((t, b) => t + ((b.lastMark?.valueInSol ?? b.entryValueSol) - b.entryValueSol), 0);
  const markedSol = markedBandsSol + eq.tokensMarkedSol;
  return {
    startedAt: book.startedAt,
    ageHours: Math.max(0, (now - Date.parse(book.startedAt)) / 3600e3),
    solPriceUsd: book.solPriceUsd,
    start: { sol: book.startSol, usdc: book.startUsdc, equitySol: startEquity, equityUsd: toUsd(startEquity) },
    wallet: {
      sol: book.wallet.sol,
      usdc: book.wallet.usdc,
      tokens: Object.entries(book.wallet.tokens).map(([mint, units]) => {
        const m = book.tokenMarks[mint];
        return { mint, symbol: m?.symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`, units, priceInSol: m?.priceInSol ?? 0, valueSol: units * (m?.priceInSol ?? 0) };
      }),
    },
    bands: book.bands.map((b) => {
      const v = b.lastMark?.valueInSol ?? b.entryValueSol;
      return {
        address: b.address,
        pool: b.pool,
        label: b.label,
        quoteSymbol: b.quoteSymbol,
        range: [b.lowerBinId, b.upperBinId],
        priceRange: [b.lowerPrice, b.upperPrice],
        inRange: b.lastMark?.inRange ?? null,
        binsFromRange: b.lastMark?.binsFromRange ?? null,
        activeBinId: b.lastMark?.activeBinId ?? null,
        valueSol: v,
        feeSol: b.lastMark?.feeSol ?? 0,
        entryValueSol: b.entryValueSol,
        pnlSol: v - b.entryValueSol,
        pnlPct: b.entryValueSol > 0 ? (v / b.entryValueSol - 1) * 100 : 0,
        ageHours: Math.max(0, (now - b.openedAt) / 3600e3),
        lastMarkAt: b.lastMarkAt,
      };
    }),
    closed: book.closed.map((c) => ({ address: c.address, label: c.label, realizedSol: c.realizedSol, realizedPct: c.realizedPct, feeSol: c.feeSol, holdHours: c.holdSec / 3600, reason: c.reason, emergency: c.emergency, closedAt: c.closedAt })),
    feesClaimedSol: book.feesClaimedSol,
    feesRealizedSol: book.feesRealizedSol,
    feesUnclaimedSol: eq.feesUnclaimedSol,
    rentLockedSol: book.rentLockedSol,
    rentSpentSol: book.rentSpentSol,
    slippagePaidSol: book.slippagePaidSol,
    realizedSol,
    markedSol,
    markedBandsSol,
    markedTokensSol: eq.tokensMarkedSol,
    equity: {
      sol: eq.equitySol,
      usd: toUsd(eq.equitySol),
      vsStartSol: eq.equitySol - startEquity,
      vsStartPct: startEquity > 0 ? (eq.equitySol / startEquity - 1) * 100 : 0,
      vsStartUsd: toUsd(eq.equitySol - startEquity),
      bandsSol: eq.bandsSol,
      tokensSol: eq.tokensSol,
      usdcSol: eq.usdcSol,
    },
    tally: decisionTally(entries, book.startedAt),
  };
}

const sol = (n: number, d = 4) => `${n.toFixed(d)} SOL`;
const signed = (n: number, d = 4) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}`;
const usd = (n: number | null) => (n === null ? "n/a" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`);
const hrs = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`);
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

export function renderPaperReport(s: PaperSummary): string {
  const out: string[] = [];
  out.push("=".repeat(96));
  out.push(`PAPER BOOK  started ${s.startedAt} (${hrs(s.ageHours)} ago)  |  SOL ${s.solPriceUsd ? usd(s.solPriceUsd) : "n/a"}  |  nothing broadcast`);
  out.push("=".repeat(96));
  out.push(`start        ${sol(s.start.sol)} + ${s.start.usdc.toFixed(2)} USDC = ${sol(s.start.equitySol)} (${usd(s.start.equityUsd)})`);
  const tokens = s.wallet.tokens.length ? s.wallet.tokens.map((t) => `${t.units.toFixed(4)} ${t.symbol} (${sol(t.valueSol)})`).join(", ") : "no tokens";
  out.push(`wallet now   ${sol(s.wallet.sol)} + ${s.wallet.usdc.toFixed(2)} USDC + ${tokens}`);
  out.push(`equity now   ${sol(s.equity.sol)} (${usd(s.equity.usd)}) = wallet ${sol(s.wallet.sol)} + USDC ${sol(s.equity.usdcSol)} + tokens ${sol(s.equity.tokensSol)} + bands ${sol(s.equity.bandsSol)} (incl. ${sol(s.feesUnclaimedSol, 6)} unclaimed fees)`);
  out.push(`vs start     ${signed(s.equity.vsStartSol)} SOL (${signed(s.equity.vsStartPct, 2)}%, ${s.equity.vsStartUsd === null ? "n/a" : (s.equity.vsStartUsd >= 0 ? "+" : "") + usd(s.equity.vsStartUsd)})  = realized ${signed(s.realizedSol)} + marked ${signed(s.markedSol)} (bands ${signed(s.markedBandsSol)}, wallet tokens ${signed(s.markedTokensSol)}) - rent locked ${s.rentLockedSol.toFixed(4)} - rent spent ${s.rentSpentSol.toFixed(4)}`);
  out.push(`fees         claimed ${sol(s.feesClaimedSol, 6)} | realized incl. closes ${sol(s.feesRealizedSol, 6)} | unclaimed ${sol(s.feesUnclaimedSol, 6)} | slippage paid ${sol(s.slippagePaidSol, 6)}`);
  out.push(`rent         ${sol(s.rentLockedSol)} locked in ${s.bands.length} band(s), refunded on close | ${sol(s.rentSpentSol)} spent on bin arrays (CLMM: tick arrays and protocol positions), not refunded`);
  out.push("");
  out.push(`OPEN BANDS (${s.bands.length})`);
  if (!s.bands.length) out.push("  none");
  for (const b of s.bands) {
    const where = b.inRange === null ? "unmarked" : b.inRange ? "IN RANGE" : `OUT ${Math.abs(b.binsFromRange ?? 0)} bins ${(b.binsFromRange ?? 0) < 0 ? "below" : "above"}`;
    out.push(`  ${pad(b.address, 20)} ${pad(b.label, 14)} bins [${b.range[0]}, ${b.range[1]}] active ${b.activeBinId ?? "?"}  ${pad(where, 18)} value ${sol(b.valueSol)}  fees ${sol(b.feeSol, 6)}  P&L ${signed(b.pnlSol)} SOL (${signed(b.pnlPct, 2)}%) vs entry ${b.entryValueSol.toFixed(4)}  age ${hrs(b.ageHours)}`);
  }
  out.push("");
  out.push(`CLOSED BANDS (${s.closed.length})`);
  if (!s.closed.length) out.push("  none");
  for (const c of s.closed) {
    out.push(`  ${pad(c.address, 20)} ${pad(c.label, 14)} realized ${signed(c.realizedSol)} SOL (${signed(c.realizedPct, 2)}%)  fees ${sol(c.feeSol, 6)}  held ${hrs(c.holdHours)}  ${c.emergency ? "ENGINE/GUARD: " : ""}${c.reason}`);
  }
  out.push("");
  const t = s.tally;
  const directives = Object.entries(t.directives).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  const sources = Object.entries(t.sources).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  out.push(`DECISIONS since start: ${t.entries} across ${t.pools} pool(s)${t.firstTs ? ` (${t.firstTs} to ${t.lastTs})` : ""}`);
  out.push(`  opens ${t.opens} | rebalances ${t.rebalances} | closes ${t.closes} | claims ${t.claims} | holds ${t.holds} | guard vetoes ${t.vetoes} | guard overrides ${t.overrides} | engine directives ${directives}`);
  out.push(`  proposed by: ${sources}`);
  out.push("=".repeat(96));
  return out.join("\n");
}
