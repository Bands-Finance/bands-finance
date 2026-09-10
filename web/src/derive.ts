import type { Action, JournalEntry, Position } from "./types";

export function feesInSol(p: Position, e: JournalEntry): number {
  return e.pool.solSide === "X" ? p.feeX + (e.pool.price > 0 ? p.feeY / e.pool.price : 0) : p.feeY + p.feeX * e.pool.price;
}

/** Refundable rent per position account (SDK POSITION_FEE). Leaves the wallet on open, returns on close. */
export const POSITION_RENT_SOL = 0.0574;

export function equityOf(e: JournalEntry): number {
  return e.wallet.sol + e.wallet.token * e.pool.tokenPriceInSol + e.positions.reduce((s, p) => s + p.valueInSol + POSITION_RENT_SOL, 0);
}

export type MarkerKind = "executed" | "blocked" | "override";

export interface SeriesPoint {
  t: number;
  price: number;
  bin: number;
  equity: number;
  bands: { address: string; lower: number; upper: number }[];
  marker: { kind: MarkerKind; action: Action } | null;
  entry: JournalEntry;
}

export interface ClosedBand {
  address: string;
  ts: string;
  entryValueSol: number | null;
  exitValueSol: number;
  pnlSol: number | null;
  action: Action;
}

export interface AgentSummary {
  id: string;
  name: string;
  closed: ClosedBand[];
  wins: number;
  realizedPnlSol: number;
  /** newest first */
  entries: JournalEntry[];
  /** oldest first */
  series: SeriesPoint[];
  latest: JournalEntry;
  first: JournalEntry;
  equitySol: number;
  pnlSol: number;
  pnlPct: number;
  feesRealizedSol: number;
  feesUnclaimedSol: number;
  bandsOpen: number;
  bandsInRange: number;
  decisions: number;
  executed: number;
  blocked: number;
  overrides: number;
  holds: number;
  spanMs: number;
}

const executedAction = (e: JournalEntry) => e.allowed && e.execution.txs.length > 0 && e.execution.ok;

export function toSeries(newestFirst: JournalEntry[]): SeriesPoint[] {
  return [...newestFirst].reverse().map((e) => ({
    t: new Date(e.ts).getTime(),
    price: e.pool.price,
    bin: e.pool.activeBinId,
    equity: equityOf(e),
    bands: e.positions.map((p) => ({ address: p.address, lower: p.lowerPrice, upper: p.upperPrice })),
    marker: e.emergency
      ? { kind: "override", action: e.decision.action }
      : !e.allowed
        ? { kind: "blocked", action: e.proposal.action }
        : executedAction(e)
          ? { kind: "executed", action: e.decision.action }
          : null,
    entry: e,
  }));
}

export function summarize(id: string, name: string, newestFirst: JournalEntry[]): AgentSummary {
  const latest = newestFirst[0];
  const first = newestFirst[newestFirst.length - 1];
  const series = toSeries(newestFirst);
  const equitySol = equityOf(latest);
  const startEquity = equityOf(first);
  let feesRealizedSol = 0;
  for (const e of newestFirst) {
    if (!executedAction(e)) continue;
    const a = e.decision.action;
    if (a !== "CLAIM_FEES" && a !== "CLOSE_POSITION" && a !== "REBALANCE") continue;
    const targets = e.decision.positionAddress ? e.positions.filter((p) => p.address === e.decision.positionAddress) : e.positions;
    feesRealizedSol += targets.reduce((s, p) => s + feesInSol(p, e), 0);
  }
  const feesUnclaimedSol = latest.positions.reduce((s, p) => s + feesInSol(p, latest), 0);
  const closed: ClosedBand[] = [];
  const claimedByBand = new Map<string, number>();
  for (const e of [...newestFirst].reverse()) {
    if (!executedAction(e)) continue;
    if (e.decision.action === "CLAIM_FEES") {
      const targets = e.decision.positionAddress ? e.positions.filter((p) => p.address === e.decision.positionAddress) : e.positions;
      for (const p of targets) claimedByBand.set(p.address, (claimedByBand.get(p.address) ?? 0) + feesInSol(p, e));
      continue;
    }
    if (e.decision.action !== "CLOSE_POSITION" && e.decision.action !== "REBALANCE") continue;
    const p = e.positions.find((x) => x.address === e.decision.positionAddress);
    if (!p) continue;
    const entry = p.entryValueSol ?? null;
    const exit = p.valueInSol + (claimedByBand.get(p.address) ?? 0);
    closed.push({ address: p.address, ts: e.ts, entryValueSol: entry, exitValueSol: exit, pnlSol: entry === null ? null : exit - entry, action: e.decision.action });
  }
  return {
    id,
    name,
    closed,
    wins: closed.filter((c) => (c.pnlSol ?? 0) > 0).length,
    realizedPnlSol: closed.reduce((s, c) => s + (c.pnlSol ?? 0), 0),
    entries: newestFirst,
    series,
    latest,
    first,
    equitySol,
    pnlSol: equitySol - startEquity,
    pnlPct: startEquity > 0 ? ((equitySol - startEquity) / startEquity) * 100 : 0,
    feesRealizedSol,
    feesUnclaimedSol,
    bandsOpen: latest.positions.length,
    bandsInRange: latest.positions.filter((p) => p.inRange).length,
    decisions: newestFirst.length,
    executed: newestFirst.filter(executedAction).length,
    blocked: newestFirst.filter((e) => !e.allowed).length,
    overrides: newestFirst.filter((e) => e.emergency).length,
    holds: newestFirst.filter((e) => e.decision.action === "HOLD").length,
    spanMs: new Date(latest.ts).getTime() - new Date(first.ts).getTime(),
  };
}

export function groupAgents(entries: JournalEntry[]): AgentSummary[] {
  const byId = new Map<string, { name: string; entries: JournalEntry[] }>();
  for (const e of entries) {
    const id = e.agent?.id ?? "mr-bands";
    const name = e.agent?.name ?? "Mr Bands";
    const g = byId.get(id) ?? { name, entries: [] };
    g.entries.push(e);
    byId.set(id, g);
  }
  return [...byId.entries()].map(([id, g]) => summarize(id, g.name, g.entries));
}

/** Nice tick values for a linear scale. */
export function ticks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

export type RangeKey = "6h" | "24h" | "7d" | "all";
export const RANGE_MS: Record<RangeKey, number> = { "6h": 6 * 3600e3, "24h": 24 * 3600e3, "7d": 7 * 86400e3, all: Infinity };
export const RANGE_LABEL: Record<RangeKey, string> = { "6h": "last 6 hours", "24h": "last 24 hours", "7d": "last 7 days", all: "all time" };

/** Entries within the range (newest first). Falls back to everything if the range is empty. */
export function inRange(entries: JournalEntry[], key: RangeKey, now: number): JournalEntry[] {
  const ms = RANGE_MS[key];
  if (!Number.isFinite(ms)) return entries;
  const kept = entries.filter((e) => now - new Date(e.ts).getTime() <= ms);
  return kept.length ? kept : entries;
}
