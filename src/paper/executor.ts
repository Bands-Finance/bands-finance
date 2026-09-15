/**
 * The paper executor: an allowed verdict applied to the paper book instead of the chain.
 * src/executor.ts delegates here whenever the loop passes a paper context. Same contract as the
 * real executor: an ExecutionResult (mode "paper") with one tx entry per operation, `opened`,
 * `closed`, and the cash-boundary ledger rows the real executor would write (mode "dry-run",
 * basis "marked", note starting "paper"), so the breakers, the collect counter and the site read
 * a paper cycle exactly like a dry-run one. Nothing here touches the chain; the book is mutated in
 * memory and the loop saves it.
 *
 * The stock straddle's swap legs are paper Jupiter fills (src/tools/jupiter.ts paperSwap, at the
 * pool's price less SWAP_FEE_PCT): a BOTH open with `acquireToken` buys the token the wallet lacks
 * before the deposit; a CLOSE with `liquidate` sells what the band handed back; a REBALANCE of a
 * BOTH band closes, then buys the shortfall or sells the surplus (only what the band returned) so
 * both halves match, then deposits. A close that feeds a swap or a re-laid straddle charges no
 * PAPER_SLIPPAGE_PCT on its token leg (the swap fee is that cost); a plain close keeps it.
 *
 * A MADE PAIR (snapshot.pair, src/venues/pair.ts): the first open in a pool that does not exist yet
 * creates it in the book first, charging the creation rent (lb pair + reserves + oracle + the
 * seed's bin arrays, none of it refundable) as its own "rent" ledger row; the seed position then
 * pays the refundable position rent only. A pool that already exists (ours from an earlier open,
 * or someone else's on chain) pays the ordinary open cost.
 */
import type { OpenParams } from "../agent/schema";
import { LedgerRow, recordLedger } from "../engine/ledger";
import type { ExecutionResult, TxReport } from "../executor";
import type { Verdict } from "../risk/guards";
import { binPrice, clmmBandTicks, priceModelOf } from "../tools/bins";
import { PoolSnapshot, POSITION_RENT_SOL, PositionSnapshot, quoteOf } from "../tools/dlmm";
import { jupiterEnv } from "../tools/jupiter";
import type { OpenCost } from "../venues/types";
import { bandRentRefund, bandsInPool, buyToken, chargeTxFee, claimFees, closeBand, createPairPool, openBand, paperTokenBalance, sellToken, OPEN_COST_ESTIMATE_SOL, PAPER_TX_FEE_SOL, type PaperBook, type PaperSwapResult } from "./book";
import { valueBand } from "./mark";

export { PAPER_TX_FEE_SOL };
/** token amounts under this are dust: no swap leg is worth it */
export const SWAP_DUST_TOKEN = 1e-6;

export interface PaperExecutionContext {
  book: PaperBook;
  snapshot: PoolSnapshot;
  positions: PositionSnapshot[];
  slippagePct: number;
  now?: number;
  /** the venue's open cost for the proposed band (src/venues); absent = the Meteora estimate */
  openCost?: OpenCost;
  /** the paper swap fee in percent (default SWAP_FEE_PCT) */
  swapFeePct?: number;
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
  const swapFeePct = ctx.swapFeePct ?? jupiterEnv().feePct;
  const tokenDec = Math.min(s.baseToken.decimals, 8);
  const swapRow = (r: PaperSwapResult, leg: "acquire" | "liquidate" | "surplus" | "shortfall"): LedgerRow => {
    const buy = leg === "acquire" || leg === "shortfall";
    const quoteDelta = buy ? -r.amountIn : r.amountOut;
    return {
      ...baseRow(s, "swap", null, now),
      quoteDelta,
      solDelta: quoteDelta * q.priceInSol,
      tokenDelta: buy ? r.amountOut : -r.amountIn,
      rentSol: 0,
      txFeeSol: -PAPER_TX_FEE_SOL,
      basis: "marked",
      note: `paper: ${leg} swap ${buy ? `${q.symbol} -> ${s.baseToken.symbol}` : `${s.baseToken.symbol} -> ${q.symbol}`} at the pool price less ${r.feePct}% (price impact ignored)`,
    };
  };
  const swapInput = { quoteSymbol: q.symbol, tokenMint: s.baseToken.mint, tokenSymbol: s.baseToken.symbol, tokenPriceInQuote: q.tokenPriceInQuote, quotePriceInSol: q.priceInSol, feePct: swapFeePct };
  /** buy `tokenOut` base with the quote: a tx entry, a swap row, the wallet moves */
  const buy = (tokenOut: number, leg: "acquire" | "shortfall") => {
    const r = buyToken(book, { ...swapInput, tokenOut });
    chargeTxFee(book);
    push({ label: `swap ${fmt(r.amountIn, q.symbol === "SOL" ? 4 : 2)} ${q.symbol} -> ${fmt(r.amountOut, tokenDec)} ${s.baseToken.symbol}`, ok: true, skipped: `paper: ${leg} leg filled at ${fmt(q.tokenPriceInQuote, 4)} ${q.symbol} per ${s.baseToken.symbol} less ${r.feePct}% (${fmt(r.feeIn, q.symbol === "SOL" ? 6 : 4)} ${q.symbol} fee)` });
    ledger(swapRow(r, leg));
    return r;
  };
  /** sell `tokenIn` base into the quote */
  const sell = (tokenIn: number, leg: "liquidate" | "surplus") => {
    const r = sellToken(book, { ...swapInput, tokenIn });
    chargeTxFee(book);
    push({ label: `swap ${fmt(r.amountIn, tokenDec)} ${s.baseToken.symbol} -> ${fmt(r.amountOut, q.symbol === "SOL" ? 4 : 2)} ${q.symbol}`, ok: true, skipped: `paper: ${leg} leg filled at ${fmt(q.tokenPriceInQuote, 4)} ${q.symbol} per ${s.baseToken.symbol} less ${r.feePct}% (${fmt(r.feeIn, tokenDec)} ${s.baseToken.symbol} fee)` });
    ledger(swapRow(r, leg));
    return r;
  };

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
      chargeTxFee(book);
      return result;
    }

    // the base token the closing band handed the wallet (a REBALANCE of a straddle re-lays it)
    let tokensBack = 0;
    if (d.action === "CLOSE_POSITION" || d.action === "REBALANCE") {
      const band = inPool.find((b) => b.address === d.positionAddress);
      if (!band) throw new Error(`position ${d.positionAddress} not found in the paper book`);
      const value = valueBand(band, s);
      const why = closeReason(verdict);
      const rentRefund = bandRentRefund(band);
      // a close whose token leg goes straight into a swap (liquidate) or back into a straddle pays the swap fee instead of the close slippage
      const feedsSwap = (d.action === "CLOSE_POSITION" && d.liquidate === true) || (d.action === "REBALANCE" && d.open?.side === "BOTH");
      const closeSlip = feedsSwap ? 0 : slippagePct;
      const closed = closeBand(book, { address: band.address, value, slippagePct: closeSlip, now, reason: why.reason, emergency: why.emergency });
      tokensBack = (closed.tokenBack + closed.feeToken) * (1 - closeSlip / 100);
      chargeTxFee(book);
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
        tokenDelta: tokenDelta * (1 - closeSlip / 100),
        rentSol: rentRefund,
        txFeeSol: -PAPER_TX_FEE_SOL,
        basis: "marked",
        feeSol: closed.feeSol,
        entryValueSol: closed.entryValueSol,
        note: `paper: close band; ${q.symbol} side from the paper mark; ${feedsSwap ? "token leg goes to a swap: no close slippage" : `${slippagePct}% slippage on the token leg`}`,
      });
      if (d.action === "CLOSE_POSITION") {
        // liquidate: the token that came back is sold into the quote, the book returns to USDC
        if (d.liquidate === true) {
          if (tokensBack > SWAP_DUST_TOKEN) sell(Math.min(tokensBack, paperTokenBalance(book, s.baseToken.mint)), "liquidate");
          else result.notes.push("liquidate: no token came back, nothing to sell");
        }
        return result;
      }
    }

    if (d.action === "OPEN_POSITION" || d.action === "REBALANCE") {
      if (!d.open) throw new Error("open parameters missing");
      const o: OpenParams = d.open;
      const cost = ctx.openCost ?? { total: OPEN_COST_ESTIMATE_SOL, refundable: POSITION_RENT_SOL };
      // A made pair that does not exist yet is created first: its rent is the pool's, not the band's.
      let creationRent = 0;
      if (s.pair && !book.pairPools?.[s.address] && s.pair.creationRentSol > 0) {
        creationRent = Math.min(s.pair.creationRentSol, cost.total);
        const made = createPairPool(book, {
          address: s.address,
          mint: s.pair.mint,
          symbol: s.pair.symbol,
          refPool: s.pair.refPool,
          refVenue: s.pair.refVenue,
          quote: q.symbol,
          binStep: s.binStep,
          feeBps: Math.round(s.baseFeePct * 100),
          rentSol: creationRent,
          now,
        });
        chargeTxFee(book);
        push({
          label: `create pool ${s.label}`,
          ok: true,
          skipped: `paper: made ${s.address} on Meteora DLMM, bin step ${s.binStep} (${(s.binStep / 100).toFixed(2)}%/bin), base fee ${s.baseFeePct}%, fees collected in ${s.pair.collectFeeMode === "quote" ? `the ${q.symbol} only` : "both tokens"}; creation rent ${made.rentSol.toFixed(6)} SOL charged, none of it refundable; active bin ${s.activeBinId} from the ${s.pair.refVenue ?? "reference"} price ${s.activePrice.toPrecision(6)}`,
        });
        ledger({
          ...baseRow(s, "rent", null, now),
          quoteDelta: 0,
          solDelta: 0,
          tokenDelta: 0,
          rentSol: -creationRent,
          txFeeSol: -PAPER_TX_FEE_SOL,
          basis: "marked",
          note: `paper: create pair pool ${s.label} (lb pair + 2 reserves + oracle + 2 bin arrays), not refundable`,
        });
      }
      // the straddle's legs: buy the shortfall (declared as acquireToken, or whatever a re-centre needs), sell a re-centre's surplus
      if (o.side === "BOTH" && o.amountToken > 0) {
        const have = paperTokenBalance(book, s.baseToken.mint);
        const shortfall = o.amountToken - have;
        const declared = Number.isFinite(o.acquireToken ?? 0) ? Math.max(0, o.acquireToken ?? 0) : 0;
        if (shortfall > SWAP_DUST_TOKEN && (declared > 0 || d.action === "REBALANCE")) buy(Number(shortfall.toFixed(tokenDec)), d.action === "REBALANCE" ? "shortfall" : "acquire");
        else if (d.action === "REBALANCE" && -shortfall > SWAP_DUST_TOKEN && tokensBack > SWAP_DUST_TOKEN) sell(Number(Math.min(-shortfall, tokensBack).toFixed(tokenDec)), "surplus");
      }
      const { lowerBinId, upperBinId, note: geometryNote } = paperBandBins(s, o);
      const xDec = s.tokenX.decimals;
      const yDec = s.tokenY.decimals;
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
        ...(ctx.openCost || creationRent > 0 ? { rentChargedSol: cost.total - creationRent, rentRefundableSol: cost.refundable } : {}),
      });
      chargeTxFee(book);
      const b = opened.band;
      push({
        label: `open ${o.side} band bins [${lowerBinId}, ${upperBinId}]`,
        ok: true,
        skipped: `paper: opened ${b.address} with ${fmt(o.amountSol, 4)} ${q.symbol}${o.amountToken > 0 ? ` + ${fmt(o.amountToken, 4)} ${s.baseToken.symbol}` : ""} across ${upperBinId - lowerBinId + 1} bins; no slippage on a deposit, rent ${opened.rentChargedSol.toFixed(4)} SOL charged (${fmt(bandRentRefund(b), 6)} refundable); entry ${fmt(b.entryValueSol, 4)} SOL${b.strategyNote ? `; ${b.strategyNote}` : ""}${geometryNote ? `; ${geometryNote}` : ""}`,
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
        note: `paper: open ${o.side} band (a deposit, no slippage); rent charged at the open estimate (${creationRent > 0 ? "position rent; the pool's own rent is the row above" : (ctx.openCost?.note ?? "position + 2 bin arrays")})`,
      });
    }
  } catch (err) {
    result.ok = false;
    result.notes.push(`paper error: ${(err as Error).message}`);
  }
  return result;
}
