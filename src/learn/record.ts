/**
 * THE RECORD of a real-money run, from the files alone: the fees, the book, the per-seat sum, and the
 * line-by-line reason the per-seat sum and the book disagree. src/scripts/record.ts prints it for the
 * 17-19 Sep run; docs/sprint.md ("One headline number") quotes it.
 *
 * Three numbers get confused, and each is right for what it measures:
 *   - FEES: what the pools paid, each claim and each close's fee leg valued at its own mark. Not profit.
 *   - THE BOOK: equity from the desk's own marks (equity.jsonl), start to end, with the peak. At the end
 *     the ledger gives the same book in cash, once the last band is closed and its tokens sold.
 *   - THE PER-SEAT SUM: lessons.jsonl, one net per closed seat. It is built for comparing seats, not for
 *     adding up: a seat counts the tokens it left unsold at its close's mark, the next seat is charged
 *     for depositing them at its open's mark, the seats before lessons were kept are not in it, and swap
 *     cash that sold no single seat's tokens belongs to none.
 * reconcile() walks from the per-seat sum to the ledger's cash change naming each of those terms, and
 * its residual is what is left unexplained (rounding, when the files are whole).
 *
 * Everything here is PURE: rows in, figures out.
 */
import type { LedgerRow } from "../engine/ledger";
import { seatNetSol, type Lesson } from "./lessons";

/** SOL that crossed the wallet on a row, rent and network fee included (the ledger's cash-boundary flow) */
export const flowOf = (r: Pick<LedgerRow, "solDelta" | "rentSol" | "txFeeSol">): number => r.solDelta + r.rentSol + r.txFeeSol;

/* ---------- fees ---------- */

export interface FeeTally {
  /** claim transactions (collect rows) */
  claims: number;
  /** what the claims paid, SOL, the token side valued at the claim's mark */
  claimSol: number;
  /** of claimSol, what came as SOL itself; the rest came as tokens, sold later at whatever price */
  claimCashSol: number;
  /** closes that carried a fee leg */
  closesWithFees: number;
  closeFeeSol: number;
  /** claims plus close fee legs: fees realised to the wallet (equity.jsonl feesClaimedSol computes the same) */
  totalSol: number;
}

/** PURE. Fees realised to the wallet, from live-mode ledger rows. */
export function feeTally(rows: readonly LedgerRow[]): FeeTally {
  const t: FeeTally = { claims: 0, claimSol: 0, claimCashSol: 0, closesWithFees: 0, closeFeeSol: 0, totalSol: 0 };
  for (const r of rows) {
    if (r.mech === "collect") {
      t.claims++;
      t.claimSol += r.feeSol ?? Math.max(0, r.solDelta);
      t.claimCashSol += Math.max(0, r.solDelta);
    } else if (r.mech === "close" && (r.feeSol ?? 0) > 0) {
      t.closesWithFees++;
      t.closeFeeSol += r.feeSol ?? 0;
    }
  }
  t.totalSol = t.claimSol + t.closeFeeSol;
  return t;
}

/* ---------- the book ---------- */

export interface BookPoint {
  t: number;
  equitySol: number;
  walletSol: number;
  bandsSol: number;
  tokensSol: number;
  bands: number;
  feesClaimedSol: number;
}

export interface Book {
  startAt: number;
  startSol: number;
  endAt: number;
  endSol: number;
  changeSol: number;
  peakAt: number;
  peakSol: number;
  lowAt: number;
  lowSol: number;
  /** the last mark's parts: what was still in a band and in tokens when the marks stopped */
  endBandsSol: number;
  endTokensSol: number;
  endFeesClaimedSol: number;
  /** marks with no band open and under 0.01 SOL of tokens: the book was cash, so the wallet read is the whole book */
  flat: { t: number; sol: number }[];
}

/** PURE. The book from the desk's own equity marks, oldest first or not. Null when there are none. */
export function bookOf(points: readonly BookPoint[]): Book | null {
  const p = [...points].filter((x) => Number.isFinite(x.equitySol)).sort((a, b) => a.t - b.t);
  if (p.length === 0) return null;
  const first = p[0];
  const last = p[p.length - 1];
  let peak = first;
  let low = first;
  for (const x of p) {
    if (x.equitySol > peak.equitySol) peak = x;
    if (x.equitySol < low.equitySol) low = x;
  }
  return {
    startAt: first.t,
    startSol: first.equitySol,
    endAt: last.t,
    endSol: last.equitySol,
    changeSol: last.equitySol - first.equitySol,
    peakAt: peak.t,
    peakSol: peak.equitySol,
    lowAt: low.t,
    lowSol: low.equitySol,
    endBandsSol: last.bandsSol,
    endTokensSol: last.tokensSol,
    endFeesClaimedSol: last.feesClaimedSol,
    flat: p.filter((x) => x.bands === 0 && x.bandsSol === 0 && x.tokensSol < 0.01).map((x) => ({ t: x.t, sol: x.equitySol })),
  };
}

/**
 * PURE. The ledger against the wallet: at every mark where the book was all cash and no ledger row landed
 * since the mark before, the wallet read must equal the start plus every row's cash so far. A gap there is
 * money the ledger never saw. Repeats of the same reading are dropped.
 */
export function cashChecks(points: readonly BookPoint[], rows: readonly LedgerRow[]): { t: number; walletSol: number; ledgerSol: number; gapSol: number }[] {
  const p = [...points].filter((x) => Number.isFinite(x.equitySol)).sort((a, b) => a.t - b.t);
  if (p.length === 0) return [];
  const start = p[0].equitySol;
  const out: { t: number; walletSol: number; ledgerSol: number; gapSol: number }[] = [];
  for (let i = 1; i < p.length; i++) {
    const x = p[i];
    if (!(x.bands === 0 && x.bandsSol === 0 && x.tokensSol < 0.01)) continue;
    if (rows.some((r) => r.ts > p[i - 1].t && r.ts <= x.t)) continue;
    if (out.length && Math.abs(out[out.length - 1].walletSol - x.walletSol) < 1e-9) continue;
    const ledgerSol = start + rows.filter((r) => r.ts <= x.t).reduce((t, r) => t + flowOf(r), 0);
    out.push({ t: x.t, walletSol: x.walletSol, ledgerSol, gapSol: x.walletSol - ledgerSol });
  }
  return out;
}

/* ---------- one seat, taken apart ---------- */

export interface SeatCash {
  position: string;
  /** seatNetSol, recomputed from the ledger today */
  netSol: number;
  /** the seat's own open, claims and close: cash in full */
  ownSol: number;
  /** its share of the pool's swap cash */
  swapSol: number;
  /** tokens it handed back and did not sell, at the close's mark: in netSol, but not cash */
  tokensLeftSol: number;
  /** tokens it deposited that no swap in its window bought, charged at the open's mark (<= 0) */
  unboughtSol: number;
  /** each swap row's cash counted in this seat */
  swaps: Map<LedgerRow, number>;
}

/** The swap rows lessonOf reads for a seat: its pool's, from two minutes before the open to three after the close. */
export function seatSwaps(rows: readonly LedgerRow[], seat: Pick<Lesson, "pool" | "position" | "openedAt" | "closedAt">): LedgerRow[] {
  return rows.filter((r) => r.mech === "swap" && (r.position === seat.position || (r.pool === seat.pool && r.ts >= seat.openedAt - 120_000 && r.ts <= seat.closedAt + 180_000)));
}

/**
 * PURE. A seat's net in its parts. The swap share is read off seatNetSol itself (the seat's net with the
 * swap's cash, less its net with that cash set to zero), so this can never drift from how lessons count.
 */
export function seatCashOf(rows: readonly LedgerRow[], seat: Pick<Lesson, "pool" | "position" | "openedAt" | "closedAt">): SeatCash {
  const own = rows.filter((r) => r.position === seat.position);
  const pool = seatSwaps(rows, seat);
  const { netSol, tokensLeftSol } = seatNetSol(own, pool, seat.position);
  const ownSol = own.filter((r) => r.mech !== "swap").reduce((t, r) => t + flowOf(r), 0);
  const swaps = new Map<LedgerRow, number>();
  let swapSol = 0;
  for (const r of pool) {
    if (flowOf(r) === 0) continue;
    const zero = { ...r, solDelta: 0, rentSol: 0, txFeeSol: 0 };
    const ownZ = own.map((x) => (x === r ? zero : x));
    const without = seatNetSol(ownZ, pool.map((x) => (x === r ? zero : x)), seat.position).netSol;
    const part = netSol - without;
    if (Math.abs(part) > 1e-12) {
      swaps.set(r, part);
      swapSol += part;
    }
  }
  return { position: seat.position, netSol, ownSol, swapSol, tokensLeftSol, unboughtSol: netSol - ownSol - swapSol - tokensLeftSol, swaps };
}

/* ---------- from the per-seat sum to the cash ---------- */

export interface Term {
  key: "stale" | "tokensLeft" | "unbought" | "seatsBefore" | "seatsAfter" | "swapsUnshared" | "otherRows";
  /** SOL to add to the running figure; the terms in order take the per-seat sum to the cash change */
  sol: number;
  label: string;
  /** how many seats or rows it covers */
  count: number;
}

export interface Reconciliation {
  seats: number;
  /** Σ netSol as lessons.jsonl holds it */
  seatSumSol: number;
  terms: Term[];
  /** Σ flow of every row: the wallet's cash change over the run, once everything is closed and sold */
  cashChangeSol: number;
  /** what the terms leave unexplained: the per-seat sum plus the terms, less the cash change */
  residualSol: number;
  /** positions with rows and no lesson, split at the first lesson's open; flowSol is their own cash plus their share of the swaps */
  unlessoned: { position: string; pool: string; openedAt: number; closedAt: number | null; flowSol: number; before: boolean }[];
}

/**
 * PURE. Walk from the per-seat sum to the ledger's cash change. rows: one mode's ledger rows (live);
 * lessons: that mode's lessons. Every ledger row lands in exactly one term, so when the files are whole
 * the residual is rounding only.
 */
export function reconcile(rows: readonly LedgerRow[], lessons: readonly Pick<Lesson, "pool" | "position" | "openedAt" | "closedAt" | "netSol">[]): Reconciliation {
  const seatSumSol = lessons.reduce((t, l) => t + l.netSol, 0);
  const cashChangeSol = rows.reduce((t, r) => t + flowOf(r), 0);
  const seen = new Set<string>();
  const counted = new Map<LedgerRow, number>();
  let stale = 0;
  let tokensLeft = 0;
  let unbought = 0;
  let staleN = 0;
  let leftN = 0;
  let unboughtN = 0;
  for (const l of lessons) {
    if (seen.has(l.position)) continue;
    seen.add(l.position);
    const c = seatCashOf(rows, l);
    // lessons round to the millionth; a larger gap means the lesson was written with older accounting
    if (Math.abs(l.netSol - c.netSol) > 5e-6) staleN++;
    stale += l.netSol - c.netSol;
    tokensLeft += c.tokensLeftSol;
    if (c.tokensLeftSol > 5e-7) leftN++;
    unbought += c.unboughtSol;
    if (c.unboughtSol < -5e-7) unboughtN++;
    for (const [r, part] of c.swaps) counted.set(r, (counted.get(r) ?? 0) + part);
  }
  // seats with rows and no lesson: their own cash and their share of the pool's swaps, counted as a lesson would
  const firstOpen = lessons.length ? Math.min(...lessons.map((l) => l.openedAt)) : Infinity;
  const byPos = new Map<string, LedgerRow[]>();
  for (const r of rows) if (r.position && r.mech !== "swap" && !seen.has(r.position)) byPos.set(r.position, [...(byPos.get(r.position) ?? []), r]);
  const unlessoned = [...byPos.entries()].map(([position, rs]) => {
    const openedAt = Math.min(...rs.map((r) => r.ts));
    const close = rs.find((r) => r.mech === "close");
    const c = seatCashOf(rows, { pool: rs[0].pool, position, openedAt, closedAt: close ? close.ts : Math.max(...rs.map((r) => r.ts)) });
    for (const [r, part] of c.swaps) counted.set(r, (counted.get(r) ?? 0) + part);
    return { position, pool: rs[0].pool, openedAt, closedAt: close ? close.ts : null, flowSol: c.ownSol + c.swapSol, before: openedAt < firstOpen };
  });
  const before = unlessoned.filter((u) => u.before);
  const after = unlessoned.filter((u) => !u.before);
  const swaps = rows.filter((r) => r.mech === "swap");
  const unshared = swaps.reduce((t, r) => t + flowOf(r) - (counted.get(r) ?? 0), 0);
  const unsharedN = swaps.filter((r) => Math.abs(flowOf(r) - (counted.get(r) ?? 0)) > 1e-6).length;
  const other = rows.filter((r) => r.mech !== "swap" && !r.position);
  const terms: Term[] = [
    { key: "stale", sol: -stale, count: staleN, label: "lessons written with older accounting, recomputed with today's (src/learn/lessons.ts seatNetSol)" },
    { key: "tokensLeft", sol: -tokensLeft, count: leftN, label: "tokens a seat handed back and did not sell, counted at its close's mark: value, not cash" },
    { key: "unbought", sol: -unbought, count: unboughtN, label: "tokens a seat deposited that no swap in its window bought (the last seat's leftovers), charged at its open's mark" },
    { key: "seatsBefore", sol: before.reduce((t, u) => t + u.flowSol, 0), count: before.length, label: "seats opened before lessons were kept, so never in the per-seat sum: their cash and their share of the swaps" },
    { key: "seatsAfter", sol: after.reduce((t, u) => t + u.flowSol, 0), count: after.length, label: "seats with rows and no lesson since (the band open when the desk stopped, closed by hand): the same" },
    { key: "swapsUnshared", sol: unshared, count: unsharedN, label: "swap cash no seat's share covers: tokens an earlier seat left, sold in a later seat's window beyond its own share" },
    { key: "otherRows", sol: other.reduce((t, r) => t + flowOf(r), 0), count: other.length, label: "rows that belong to no seat (rent, network fees, skims)" },
  ];
  const residualSol = seatSumSol + terms.reduce((t, x) => t + x.sol, 0) - cashChangeSol;
  return { seats: seen.size, seatSumSol, terms, cashChangeSol, residualSol, unlessoned };
}
