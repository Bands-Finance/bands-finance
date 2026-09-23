/**
 * The cash-boundary attribution ledger. Port of Meridian's agent/src/attribution.ts.
 * File: DATA_DIR/ledger.jsonl, one row per money-moving operation, written by the executor
 * after each successful transaction (and in dry-run too, tagged mode "dry-run").
 *
 * The model is CASH-BOUNDARY FLOW: a row records what crossed the wallet boundary, positive
 * INTO the wallet. Token inventory is counted when it leaves (open) and when it returns (close);
 * it is never re-valued per row, so over a closed cycle the SOL columns sum to exact realized
 * flow with no marks and no basis guesses. Rows carry the mark that was in force so anything
 * that needs a valuation (inventory, the fee leg of a close) is stated at that mark and labelled
 * "marked". Exact and marked figures live in separate fields and are never added together:
 * summing the two is how Meridian's meme sleeve once read as a five-figure loss.
 *
 * Basis: a live row is "exact" when its SOL columns come from chain (the transaction's
 * pre/post balances, or a wallet balance read before and after the broadcast); it is "marked"
 * when they were taken from the position snapshot. Dry-run rows are always marked. The exactness
 * claim covers the SOL columns only. tokenDelta is what crossed the boundary too: live, the
 * transaction's own token balances of the base mint; failing that, the position snapshot's figure
 * less the mint's Token-2022 transfer fee (src/tools/transferFee.ts), since a fee mint keeps a cut of
 * every close and claim and the snapshot figure booked tokens that never arrived (22 Sep review).
 *
 * Quotes: a row also carries the quote leg in the quote token's own units (quoteMint, quoteDelta,
 * markQuoteInSol). For a SOL pool quoteDelta = solDelta and markQuoteInSol = 1. For a USDC pool
 * quoteDelta is the USDC that crossed the boundary and solDelta = quoteDelta x markQuoteInSol, so
 * every fold below stays in SOL without a special case; a live USDC row is "exact" when quoteDelta
 * came from the wallet's USDC balance delta, never from the SOL balance. Rows written before the
 * quote fields existed lack them; quoteOfRow() reads them with the SOL defaults.
 *
 * Every write is best-effort: attribution must never break a trading path.
 */
import { appendLedger, ledgerView, readLedger } from "../lib/ledger";
import { SOL_MINT } from "../tools/dlmm";

export const LEDGER_FILE = "ledger.jsonl";

export type LedgerMode = "live" | "dry-run";
/** "swap": a Jupiter leg of the stock straddle (acquire the token half before a BOTH deposit, or liquidate the token a close hands back) */
export type LedgerMech = "open" | "close" | "collect" | "skim" | "rent" | "txfee" | "swap";
export type LedgerBasis = "exact" | "marked";

export interface LedgerRow {
  /** epoch ms */
  ts: number;
  mode: LedgerMode;
  /** transaction signature (the last one when an operation took several); null in dry-run */
  sig: string | null;
  pool: string;
  position: string | null;
  mech: LedgerMech;
  /** SOL that crossed the wallet boundary, positive into the wallet; excludes rent and network fee */
  solDelta: number;
  /** base token units that crossed the boundary, same sign convention */
  tokenDelta: number;
  tokenMint: string;
  /** base token price in SOL at the time of the row: the mark for any valuation of this row */
  markTokenInSol: number;
  /** refundable position/bin-array rent: negative when paid, positive when refunded */
  rentSol: number;
  /** network fee, <= 0 */
  txFeeSol: number;
  basis: LedgerBasis;
  note: string;
  /** SOL-equivalent of the fee leg at markTokenInSol (the whole row for a collect; the fee part of a close) */
  feeSol?: number;
  /** close rows: the band's SOL value at entry, so realized P&L per band folds from the ledger alone */
  entryValueSol?: number;
  /** the pool's quote mint (SOL or USDC); absent on rows written before USDC pools (then SOL) */
  quoteMint?: string;
  /** quote-token units that crossed the wallet boundary, positive into the wallet; = solDelta for SOL pools */
  quoteDelta?: number;
  /** one quote token in SOL at the time of the row (1 for SOL pools): solDelta = quoteDelta x this */
  markQuoteInSol?: number;
}

/** The quote leg of a row with the SOL defaults for rows written before the quote fields existed. */
export function quoteOfRow(r: Pick<LedgerRow, "solDelta" | "quoteMint" | "quoteDelta" | "markQuoteInSol">): { quoteMint: string; quoteDelta: number; markQuoteInSol: number } {
  const markQuoteInSol = typeof r.markQuoteInSol === "number" && r.markQuoteInSol > 0 ? r.markQuoteInSol : 1;
  return {
    quoteMint: r.quoteMint ?? SOL_MINT,
    quoteDelta: typeof r.quoteDelta === "number" ? r.quoteDelta : r.solDelta / markQuoteInSol,
    markQuoteInSol,
  };
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Write one row. Best-effort: a failed write is logged and never thrown. */
export function recordLedger(row: LedgerRow): void {
  try {
    appendLedger(LEDGER_FILE, row);
  } catch (err) {
    console.error(`[ledger] row dropped (${row.mech} ${row.pool.slice(0, 6)}): ${(err as Error).message.slice(0, 120)}`);
  }
}

export function isLedgerRow(x: unknown): x is LedgerRow {
  const r = x as Partial<LedgerRow> | null;
  return (
    !!r &&
    typeof r.ts === "number" &&
    (r.mode === "live" || r.mode === "dry-run") &&
    typeof r.mech === "string" &&
    typeof r.solDelta === "number" &&
    typeof r.tokenDelta === "number" &&
    typeof r.rentSol === "number" &&
    typeof r.txFeeSol === "number"
  );
}

/** Every well-formed row, oldest first. Missing file = []. */
export function readLedgerRows(): LedgerRow[] {
  return readLedger<unknown>(LEDGER_FILE).filter(isLedgerRow);
}

export const dayOf = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

/** Rows of one mode only. Live and dry-run rows are never folded together. */
export function rowsOf(rows: readonly LedgerRow[], mode: LedgerMode): LedgerRow[] {
  return rows.filter((r) => r.mode === mode);
}

/** SOL-equivalent fees realized: collect rows plus the fee legs of close rows, each at its own mark. */
export function feesRealizedSol(rows: readonly LedgerRow[], mode: LedgerMode): number {
  let sum = 0;
  for (const r of rowsOf(rows, mode)) {
    if (r.mech === "collect" || r.mech === "close") sum += r.feeSol ?? 0;
  }
  return r6(sum);
}

/** Net SOL that crossed the boundary over EXACT rows only: solDelta + rent + fees. No marks. */
export function netCashSol(rows: readonly LedgerRow[], mode: LedgerMode): number {
  let sum = 0;
  for (const r of rowsOf(rows, mode)) {
    if (r.basis !== "exact") continue;
    sum += r.solDelta + r.rentSol + r.txFeeSol;
  }
  return r6(sum);
}

export interface InventoryLine {
  mint: string;
  /** net base token units held outside the wallet's SOL (positive = the wallet holds them) */
  units: number;
  /** the latest mark seen for this mint */
  markTokenInSol: number;
  /** units x mark: a marked figure, never added to exact cash */
  markedSol: number;
}

/** Token inventory by mint, valued at the latest mark. Reported as "marked". */
export function inventory(rows: readonly LedgerRow[], mode: LedgerMode): InventoryLine[] {
  const by = new Map<string, { units: number; mark: number; at: number }>();
  for (const r of rowsOf(rows, mode)) {
    if (!r.tokenMint) continue;
    const cur = by.get(r.tokenMint) ?? { units: 0, mark: 0, at: -1 };
    cur.units += r.tokenDelta;
    if (r.ts >= cur.at && r.markTokenInSol > 0) {
      cur.mark = r.markTokenInSol;
      cur.at = r.ts;
    }
    by.set(r.tokenMint, cur);
  }
  return [...by.entries()]
    .map(([mint, v]) => ({ mint, units: r6(v.units), markTokenInSol: v.mark, markedSol: r6(v.units * v.mark) }))
    .filter((l) => Math.abs(l.units) > 1e-9);
}

export interface DailyClose {
  day: string;
  /** SOL-equivalent fees collected that day (collect rows + close fee legs) */
  collectedSol: number;
  /** exact SOL flow that day (exact rows only) */
  netCashSol: number;
  collects: number;
  rows: number;
}

/** The daily close: what was collected per UTC day. Meridian's rule: the day closes on cash collected. */
export function dailyClose(rows: readonly LedgerRow[], mode: LedgerMode): Record<string, DailyClose> {
  const out: Record<string, DailyClose> = {};
  for (const r of rowsOf(rows, mode)) {
    const day = dayOf(r.ts);
    const d = (out[day] ??= { day, collectedSol: 0, netCashSol: 0, collects: 0, rows: 0 });
    d.rows += 1;
    if (r.mech === "collect" || r.mech === "close") d.collectedSol += r.feeSol ?? 0;
    if (r.mech === "collect") d.collects += 1;
    if (r.basis === "exact") d.netCashSol += r.solDelta + r.rentSol + r.txFeeSol;
  }
  for (const d of Object.values(out)) {
    d.collectedSol = r6(d.collectedSol);
    d.netCashSol = r6(d.netCashSol);
  }
  return out;
}

/** Open bands at entry, from risk state. */
export function workingSol(entryValueSol: Record<string, number>): number {
  return r6(Object.values(entryValueSol).reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0));
}

/** Fee claims recorded on a UTC day. */
export function collectsOnDay(rows: readonly LedgerRow[], mode: LedgerMode, day: string): number {
  return rowsOf(rows, mode).filter((r) => r.mech === "collect" && dayOf(r.ts) === day).length;
}

/**
 * Realized SOL on a UTC day, marked where a token leg is involved: collect rows count in full,
 * a close row counts (cash + tokens at the row's mark + fee) minus the band's entry value, a swap
 * row counts its two legs at the row's mark (the quote that left against the token that arrived,
 * or the reverse: the route's fee and impact, never the notional), and every other row contributes
 * its network fee and rent. Used by the circuit breaker.
 */
export function realizedOnDaySol(rows: readonly LedgerRow[], mode: LedgerMode, day: string): number {
  let sum = 0;
  for (const r of rowsOf(rows, mode)) {
    if (dayOf(r.ts) !== day) continue;
    const back = r.solDelta + r.tokenDelta * r.markTokenInSol;
    if (r.mech === "collect") sum += back + r.txFeeSol;
    else if (r.mech === "swap") sum += back + r.txFeeSol;
    else if (r.mech === "close") sum += back + r.txFeeSol - (r.entryValueSol ?? back);
    else if (r.mech === "open") sum += r.txFeeSol;
    else if (r.mech === "skim") sum += r.txFeeSol;
    else sum += r.solDelta + r.rentSol + r.txFeeSol;
  }
  return r6(sum);
}

/** SOL-equivalent fees realized since the most recent skim row (the skim base). */
export function feeGainSinceLastSkim(rows: readonly LedgerRow[], mode: LedgerMode): { gainSol: number; lastSkimAt: number | null } {
  const mine = rowsOf(rows, mode);
  let lastSkimAt: number | null = null;
  for (const r of mine) if (r.mech === "skim") lastSkimAt = r.ts;
  let gain = 0;
  for (const r of mine) {
    if (lastSkimAt !== null && r.ts <= lastSkimAt) continue;
    if (r.mech === "collect" || r.mech === "close") gain += r.feeSol ?? 0;
  }
  return { gainSol: r6(gain), lastSkimAt };
}

export interface LedgerSummary {
  mode: LedgerMode;
  rows: number;
  /** chain-measured SOL flow only */
  exact: { rows: number; netCashSol: number };
  /** valued at the latest marks; kept apart from exact and never added to it */
  marked: { rows: number; inventory: InventoryLine[]; inventorySol: number };
  feesRealizedSol: number;
  dailyClose: Record<string, DailyClose>;
  workingSol: number;
  lastRowAt: number | null;
}

/** The summary keeps exact and marked in separate fields; nothing here adds one to the other. */
export function summary(rows: readonly LedgerRow[], mode: LedgerMode, entryValueSol: Record<string, number> = {}): LedgerSummary {
  const mine = rowsOf(rows, mode);
  const inv = inventory(mine, mode);
  return {
    mode,
    rows: mine.length,
    exact: { rows: mine.filter((r) => r.basis === "exact").length, netCashSol: netCashSol(mine, mode) },
    marked: { rows: mine.filter((r) => r.basis === "marked").length, inventory: inv, inventorySol: r6(inv.reduce((s, l) => s + l.markedSol, 0)) },
    feesRealizedSol: feesRealizedSol(mine, mode),
    dailyClose: dailyClose(mine, mode),
    workingSol: workingSol(entryValueSol),
    lastRowAt: mine.length ? mine[mine.length - 1].ts : null,
  };
}

/** A cached view of every well-formed row, rebuilt only when the file changes. */
export const ledgerRowsView = ledgerView<LedgerRow[]>(LEDGER_FILE, (rows) => rows.filter(isLedgerRow));
