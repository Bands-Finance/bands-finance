/**
 * The paper executor: an allowed verdict applied to the paper book instead of the chain.
 * src/executor.ts delegates here whenever the loop passes a paper context. Same contract as the
 * real executor: an ExecutionResult (mode "paper") with one tx entry per operation, `opened`,
 * `closed`, and the cash-boundary ledger rows the real executor would write (mode "dry-run",
 * basis "marked", note starting "paper"), so the breakers, the collect counter and the site read
 * a paper cycle exactly like a dry-run one. Nothing here touches the chain; the book is mutated in
 * memory and the loop saves it.
 */
import type { OpenParams } from "../agent/schema";
import { LedgerRow, recordLedger } from "../engine/ledger";
import type { ExecutionResult, TxReport } from "../executor";
import type { Verdict } from "../risk/guards";
import { binPrice, clmmBandTicks, priceModelOf } from "../tools/bins";
import { PoolSnapshot, POSITION_RENT_SOL, PositionSnapshot, quoteOf } from "../tools/dlmm";
import type { OpenCost } from "../venues/types";
import { bandRentRefund, bandsInPool, claimFees, closeBand, openBand, OPEN_COST_ESTIMATE_SOL, type PaperBook } from "./book";
import { valueBand } from "./mark";

/** marked network fee per paper transaction, as the real dry-run rows carry */
export const PAPER_TX_FEE_SOL = 0.000005;

export interface PaperExecutionContext {
  book: PaperBook;
  snapshot: PoolSnapshot;
  positions: PositionSnapshot[];
  slippagePct: number;
  now?: number;
  /** the venue's open cost for the proposed band (src/venues); absent = the Meteora estimate */
  openCost?: OpenCost;
}

/** Where a paper band lands: a CLMM single-sided band excludes the active bin (src/tools/bins.ts), a Meteora band includes it. */
export function paperBandBins(s: Pick<PoolSnapshot, "activeBinId" | "priceModel" | "binStep" | "quoteSide" | "solSide">, o: Pick<OpenParams, "side" | "binsBelowActive" | "binsAboveActive">): { lowerBinId: number; upperBinId: number; note: string | null } {
  if (priceModelOf(s) === "clmm") {
    const quoteSide: "X" | "Y" = s.quoteSide ?? (s.solSide === "X" ? "X" : "Y");
    const g = clmmBandTicks(s.activeBinId, s.binStep, o.binsBelowActive, o.binsAboveActive, o.side, quoteSide);
    return { lowerBinId: g.lowerBinId, upperBinId: g.upperBinId, note: g.note };
  }
  return { lowerBinId: s.activeBinId - o.binsBelowActive, upperBinId: s.activeBinId + o.binsAboveActive, note: null };
}

const fmt = (n: number, d = 4) => Number(n.toFixed(d)).toString();

/** Why a close happened, for the closed row: the guard override or the directive when it was an emergency, else the headline. */
export function closeReason(v: Verdict): { reason: string; emergency: boolean } {
  if (v.emergency) {
    const over = v.overrides.find((o) => o.startsWith("stop-loss"));
    if (over) return { reason: over, emergency: true };
    const m = /^Engine directive (\w+): (.*?)(?:\.\s|$)/.exec(v.decision.reasoning);
    if (m) return { reason: `${m[1]}: ${m[2]}`, emergency: true };
    return { reason: v.decision.headline, emergency: true };
  }
  return { reason: v.decision.headline, emergency: false };
}

type RowBase = Omit<LedgerRow, "solDelta" | "quoteDelta" | "tokenDelta" | "rentSol" | "txFeeSol" | "basis" | "note">;

function baseRow(s: PoolSnapshot, mech: LedgerRow["mech"], position: string | null, now: number): RowBase {
  const q = quoteOf(s);
  return {
    ts: now,
    mode: "dry-run",
    sig: null,
    pool: s.address,
    position,
    mech,
    tokenMint: s.baseToken.mint,
    markTokenInSol: s.tokenPriceInSol,
    quoteMint: q.token.mint,
    markQuoteInSol: q.priceInSol,
  };
}

/** Apply an allowed, non-HOLD verdict to the book. The caller has already screened HOLD and blocked verdicts. */
export function executePaper(verdict: Verdict, ctx: PaperExecutionContext): ExecutionResult {
  const d = verdict.decision;
  const { book, snapshot: s, slippagePct } = ctx;
  const now = ctx.now ?? Date.now();
  const q = quoteOf(s);
  const result: ExecutionResult = { mode: "paper", ok: true, txs: [], notes: [], ledger: [] };
  const push = (t: TxReport) => result.txs.push(t);
  const ledger = (row: LedgerRow) => {
    recordLedger(row);
    result.ledger!.push(row);
  };
  const inPool = bandsInPool(book, s.address);

  try {
    if (d.action === "CLAIM_FEES") {
      const targets = d.positionAddress ? inPool.filter((b) => b.address === d.positionAddress) : inPool;
      if (!targets.length) throw new Error(`position ${d.positionAddress ?? "(any)"} not found in the paper book`);
      let feeQuote = 0;
      let feeToken = 0;
      let feeSol = 0;
      let claimed = 0;
      for (const b of targets) {
        const r = claimFees(book, b.address, { tokenPriceInQuote: q.tokenPriceInQuote, quotePriceInSol: q.priceInSol }, now);
        if (!r) continue;
        claimed += 1;
        feeQuote += r.feeQuote;
        feeToken += r.feeToken;
        feeSol += r.feeSol;
        push({ label: `claim fees ${b.address.slice(0, 13)}`, ok: true, skipped: `paper: claimed ${fmt(r.feeQuote, 6)} ${q.symbol} + ${fmt(r.feeToken, 4)} ${s.baseToken.symbol} (${fmt(r.feeSol, 6)} SOL) to the virtual wallet` });
      }
      if (claimed === 0) {
        result.notes.push("nothing to claim");
        return result;
      }
      ledger({
        ...baseRow(s, "collect", targets.length === 1 ? targets[0].address : null, now),
        quoteDelta: feeQuote,
        solDelta: feeQuote * q.priceInSol,
        tokenDelta: feeToken,
        rentSol: 0,
        txFeeSol: -PAPER_TX_FEE_SOL,
        basis: "marked",
        feeSol,
        note: `paper: claim fees on ${claimed} band(s); ${q.symbol} side from the paper mark`,
      });
      book.wallet.sol -= PAPER_TX_FEE_SOL;
      return result;
    }

    if (d.action === "CLOSE_POSITION" || d.action === "REBALANCE") {
      const band = inPool.find((b) => b.address === d.positionAddress);
      if (!band) throw new Error(`position ${d.positionAddress} not found in the paper book`);
      const value = valueBand(band, s);
      const why = closeReason(verdict);
      const rentRefund = bandRentRefund(band);
      const closed = closeBand(book, { address: band.address, value, slippagePct, now, reason: why.reason, emergency: why.emergency });
      book.wallet.sol -= PAPER_TX_FEE_SOL;
      push({
        label: `close band ${band.address.slice(0, 13)}`,
        ok: true,
        skipped: `paper: closed ${closed.inRangeAtClose ? "in range" : "out of range"} at bin ${s.activeBinId}; back ${fmt(closed.quoteBack, 4)} ${q.symbol} + ${fmt(closed.tokenBack, 4)} ${s.baseToken.symbol} + fees ${fmt(closed.feeSol, 6)} SOL, rent ${rentRefund} SOL refunded; realized ${closed.realizedSol >= 0 ? "+" : ""}${fmt(closed.realizedSol, 4)} SOL (${closed.realizedPct >= 0 ? "+" : ""}${closed.realizedPct.toFixed(2)}%) vs entry ${fmt(closed.entryValueSol, 4)}`,
      });
      result.closed = band.address;
      const tokenDelta = closed.tokenBack + closed.feeToken;
      ledger({
        ...baseRow(s, "close", band.address, now),
        quoteDelta: closed.quoteBack + closed.feeQuote,
        solDelta: (closed.quoteBack + closed.feeQuote) * q.priceInSol,
        tokenDelta: tokenDelta * (1 - slippagePct / 100),
        rentSol: rentRefund,
        txFeeSol: -PAPER_TX_FEE_SOL,
        basis: "marked",
        feeSol: closed.feeSol,
        entryValueSol: closed.entryValueSol,
        note: `paper: close band; ${q.symbol} side from the paper mark; ${slippagePct}% slippage on the token leg`,
      });
      if (d.action === "CLOSE_POSITION") return result;
    }

    if (d.action === "OPEN_POSITION" || d.action === "REBALANCE") {
      if (!d.open) throw new Error("open parameters missing");
      const o: OpenParams = d.open;
      const { lowerBinId, upperBinId, note: geometryNote } = paperBandBins(s, o);
      const xDec = s.tokenX.decimals;
      const yDec = s.tokenY.decimals;
      const cost = ctx.openCost ?? { total: OPEN_COST_ESTIMATE_SOL, refundable: POSITION_RENT_SOL };
      const opened = openBand(book, {
        pool: s.address,
        label: s.label,
        quoteSymbol: q.symbol,
        quoteSide: q.side,
        quoteMint: q.token.mint,
        tokenMint: s.baseToken.mint,
        tokenSymbol: s.baseToken.symbol,
        xDecimals: xDec,
        yDecimals: yDec,
        binStep: s.binStep,
        activeBinId: s.activeBinId,
        activePrice: s.activePrice,
        tokenPriceInQuote: q.tokenPriceInQuote,
        quotePriceInSol: q.priceInSol,
        lowerBinId,
        upperBinId,
        lowerPrice: binPrice(s, lowerBinId),
        upperPrice: binPrice(s, upperBinId),
        side: o.side,
        strategy: o.strategy,
        amountQuote: o.amountSol,
        amountToken: o.amountToken,
        slippagePct,
        now,
        ...(priceModelOf(s) === "clmm" ? { priceModel: "clmm" as const } : {}),
        ...(ctx.openCost ? { rentChargedSol: cost.total, rentRefundableSol: cost.refundable } : {}),
      });
      book.wallet.sol -= PAPER_TX_FEE_SOL;
      const b = opened.band;
      push({
        label: `open ${o.side} band bins [${lowerBinId}, ${upperBinId}]`,
        ok: true,
        skipped: `paper: opened ${b.address} with ${fmt(o.amountSol, 4)} ${q.symbol}${o.amountToken > 0 ? ` + ${fmt(o.amountToken, 4)} ${s.baseToken.symbol}` : ""} across ${upperBinId - lowerBinId + 1} bins; slippage ${fmt(opened.slippageSol, 6)} SOL, rent ${opened.rentChargedSol.toFixed(4)} SOL charged (${fmt(bandRentRefund(b), 6)} refundable); entry ${fmt(b.entryValueSol, 4)} SOL${b.strategyNote ? `; ${b.strategyNote}` : ""}${geometryNote ? `; ${geometryNote}` : ""}`,
      });
      result.opened = { address: b.address, entryValueSol: b.entryValueSol };
      if (geometryNote) result.notes.push(geometryNote);
      ledger({
        ...baseRow(s, "open", b.address, now),
        quoteDelta: -(o.amountSol + opened.slippageQuote),
        solDelta: -(o.amountSol + opened.slippageQuote) * q.priceInSol,
        tokenDelta: -(o.amountToken + opened.slippageToken),
        rentSol: -opened.rentChargedSol,
        txFeeSol: -PAPER_TX_FEE_SOL,
        basis: "marked",
        note: `paper: open ${o.side} band incl. ${slippagePct}% slippage; rent charged at the open estimate (${ctx.openCost?.note ?? "position + 2 bin arrays"})`,
      });
    }
  } catch (err) {
    result.ok = false;
    result.notes.push(`paper error: ${(err as Error).message}`);
  }
  return result;
}
