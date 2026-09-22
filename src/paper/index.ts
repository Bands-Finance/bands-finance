/**
 * Paper mode: a virtual 100 SOL book the loop trades against live prices under DRY_RUN.
 *   env.ts       PAPER_SOL / PAPER_USDC / PAPER_SLIPPAGE_PCT, and the DRY_RUN=false refusal
 *   book.ts      the book file (wallet, bands, closed, tallies) and the open/close/claim operations
 *   mark.ts      marking a band against the live pool: bin contents, fees, the PositionSnapshot
 *   executor.ts  an allowed verdict applied to the book, with the ledger rows the real executor writes
 *                (the straddle's swap legs are paper Jupiter fills)
 *   hedge.ts     the virtual Backpack perp shorts: fills at the perp mid, marks, funding, equity
 *   report.ts    the summary, the decision tally and the printed report (USD-first for a USDC book)
 *   paperRoutes(app)   GET /api/paper -> { enabled, env, book, summary }; the integrator mounts it in src/server.ts
 */
import type { Hono } from "hono";
import { readLedgerRows } from "../engine/ledger";
import { config } from "../config";
import { readRecent } from "../journal";
import { loadPaperBook } from "./book";
import { paperEnabled, paperEnv } from "./env";
import { paperSummary } from "./report";

export { assertPaperEnv, paperEnabled, paperEnv, type PaperEnv } from "./env";
export {
  bandsInPool,
  buyToken,
  chargeTxFee,
  sellToken,
  claimFees,
  closeBand,
  createPairPool,
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
  type PaperPairPool,
  type PaperSwapInput,
  type PaperSwapResult,
  type PaperWallet,
} from "./book";
export {
  accruePaperFunding,
  emptyHedgeBook,
  fillPaperHedge,
  hedgePositionOf,
  markPaperHedge,
  MAX_FUNDING_GAP_SEC,
  normalizeHedgeBook,
  PAPER_HEDGE_FEE_PCT_DEFAULT,
  paperHedgeByPool,
  paperHedgeEquityUsd,
  paperHedgeFeePct,
  paperHedgeUnrealizedUsd,
  paperShortQty,
  type FundingAccrual,
  type PaperHedgeBook,
  type PaperHedgeClosed,
  type PaperHedgeFill,
  type PaperHedgeFillInput,
  type PaperHedgePosition,
} from "./hedge";
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
  paperBinRows,
  MAX_MARK_GAP_SEC,
  MAX_SHARE,
  paperPoolTokenInventory,
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
export { closeReason, executePaper, PAPER_TX_FEE_SOL, SWAP_DUST_TOKEN, type PaperExecutionContext } from "./executor";
export { decisionTally, paperSummary, renderPaperReport, tickerOfSymbol, type DecisionTally, type PaperStockLine, type PaperSummary } from "./report";

/** GET /api/paper: the book and its summary, or 404 with a plain reason when no book exists. */
export function paperRoutes(app: Hono): void {
  app.get("/api/paper", (c) => {
    const book = loadPaperBook();
    const enabled = paperEnabled(process.env, config.dryRun);
    if (!book) return c.json({ enabled, env: paperEnv(), error: "no paper book yet; run the loop with PAPER_SOL=100 under DRY_RUN" }, 404);
    return c.json({ enabled, env: paperEnv(), book, summary: paperSummary(book, readRecent(5000), Date.now(), readLedgerRows()), generatedAt: new Date().toISOString() });
  });
}
export { binWalkImpactPct, MAX_WALK_BINS, type ImpactInput } from "./impact";
