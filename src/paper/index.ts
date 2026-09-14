/**
 * Paper mode: a virtual 100 SOL book the loop trades against live prices under DRY_RUN.
 *   env.ts       PAPER_SOL / PAPER_USDC / PAPER_SLIPPAGE_PCT, and the DRY_RUN=false refusal
 *   book.ts      the book file (wallet, bands, closed, tallies) and the open/close/claim operations
 *   mark.ts      marking a band against the live pool: bin contents, fees, the PositionSnapshot
 *   executor.ts  an allowed verdict applied to the book, with the ledger rows the real executor writes
 *   report.ts    the summary, the decision tally and the printed report
 *   paperRoutes(app)   GET /api/paper -> { enabled, env, book, summary }; the integrator mounts it in src/server.ts
 */
import type { Hono } from "hono";
import { config } from "../config";
import { readRecent } from "../journal";
import { loadPaperBook } from "./book";
import { paperEnabled, paperEnv } from "./env";
import { paperSummary } from "./report";

export { assertPaperEnv, paperEnabled, paperEnv, type PaperEnv } from "./env";
export {
  bandsInPool,
  claimFees,
  closeBand,
  emptyBook,
  loadPaperBook,
  openBand,
  PAPER_BOOK_FILE,
  paperBookFile,
  paperTokenBalance,
  poolsWithBands,
  quoteBalance,
  savePaperBook,
  type BandValue,
  type PaperBand,
  type PaperBook,
  type PaperClosed,
  type PaperMark,
  type PaperWallet,
} from "./book";
export {
  accrueFees,
  activeBinQuoteShare,
  bandContents,
  bandDepthQuote,
  binNotionals,
  bookEquitySol,
  depositBins,
  feesPerDayUsd,
  markBand,
  markPool,
  MAX_MARK_GAP_SEC,
  MAX_SHARE,
  quotePerTokenAt,
  shareOfBand,
  toPaperPosition,
  UNKNOWN_SPLIT,
  valueBand,
  type FeeAccrual,
  type FeeSource,
  type MarkContext,
  type MarkedBand,
  type MarkSnapshot,
} from "./mark";
export { closeReason, executePaper, PAPER_TX_FEE_SOL, type PaperExecutionContext } from "./executor";
export { decisionTally, paperSummary, renderPaperReport, type DecisionTally, type PaperSummary } from "./report";

/** GET /api/paper: the book and its summary, or 404 with a plain reason when no book exists. */
export function paperRoutes(app: Hono): void {
  app.get("/api/paper", (c) => {
    const book = loadPaperBook();
    const enabled = paperEnabled(process.env, config.dryRun);
    if (!book) return c.json({ enabled, env: paperEnv(), error: "no paper book yet; run the loop with PAPER_SOL=100 under DRY_RUN" }, 404);
    return c.json({ enabled, env: paperEnv(), book, summary: paperSummary(book, readRecent(5000)), generatedAt: new Date().toISOString() });
  });
}
