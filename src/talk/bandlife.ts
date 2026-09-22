/**
 * A close post's numbers over the band's WHOLE life, not only the close leg: the open, every fee claim made while
 * the band was open, the close, rent and network fees, and its share of the pool's swaps (the same accounting as
 * its lesson, src/learn/lessons.ts seatNetSol). A band's lessons.jsonl row wins when there is one, so the close post
 * and the lesson post about the same band never say two different numbers. With neither a lesson nor the band's own
 * ledger rows, the close keeps its close-leg figures and says so (`closeLegOnly`).
 */
import type { LedgerRow } from "../engine/ledger";
import { seatNetSol, type Lesson } from "../learn/lessons";

export interface BandLife {
  netSol: number;
  feesSol: number;
  /** the figures are the close leg only: no lesson and no ledger rows of this band to add to it */
  closeLegOnly: boolean;
  from: "lesson" | "ledger" | "close-leg";
}

/** Swap rows inside the seat's life window, as lessons.ts takes them. */
const SWAP_BEFORE_MS = 120_000;
const SWAP_AFTER_MS = 180_000;

/**
 * PURE. The net and fees of one closed band. `rows` are this book's ledger rows (already filtered to its source),
 * `lessons` this book's lessons. `closeLeg` is what the close alone said, used only when nothing else is known.
 */
export function bandLifeOf(i: { position: string; pool: string; openedAt: number | null; closedAt: number; rows: readonly LedgerRow[]; lessons: readonly Pick<Lesson, "position" | "netSol" | "feesSol">[]; closeLeg: { netSol: number; feesSol: number | null } }): BandLife {
  const lesson = i.lessons.find((l) => l.position === i.position);
  if (lesson) return { netSol: lesson.netSol, feesSol: lesson.feesSol, closeLegOnly: false, from: "lesson" };
  const own = i.rows.filter((r) => r.position === i.position);
  const hasOpen = own.some((r) => r.mech === "open");
  const hasClose = own.some((r) => r.mech === "close");
  if (!hasOpen || !hasClose) return { netSol: i.closeLeg.netSol, feesSol: i.closeLeg.feesSol ?? 0, closeLegOnly: true, from: "close-leg" };
  const openedAt = i.openedAt ?? Math.min(...own.map((r) => r.ts));
  const poolSwaps = i.rows.filter((r) => r.mech === "swap" && (r.position === i.position || (r.pool === i.pool && r.ts >= openedAt - SWAP_BEFORE_MS && r.ts <= i.closedAt + SWAP_AFTER_MS)));
  const { netSol } = seatNetSol(own, poolSwaps, i.position);
  const feesSol = own.reduce((t, r) => t + (r.mech === "collect" ? (r.feeSol ?? Math.max(0, r.solDelta)) : r.mech === "close" ? (r.feeSol ?? 0) : 0), 0);
  return { netSol, feesSol, closeLegOnly: false, from: "ledger" };
}
