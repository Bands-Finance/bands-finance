/**
 * The paper report: the book priced at its last marks, the decision tally from the journal, and
 * a plain-text rendering for `npm run paper:report` and GET /api/paper. Offline: it reads the
 * book file and the journal, never the chain.
 *
 * Currency: the book is kept in SOL. When it started with USDC and its SOL is only rent money
 * (startUsdc worth more than startSol at the last SOL price) the report is USD-FIRST: equity,
 * P&L and every line print in USD with SOL second, and the start is valued at the CURRENT SOL
 * price so SOL's own move never reads as strategy P&L. The SOL identity line is kept either way.
 *
 * The stock book (src/paper/hedge.ts): the hedge section lists the virtual perp shorts and the
 * PER STOCK table folds, per ticker, band P&L (open marks + closed realized + claimed fees),
 * swap costs, hedge P&L (unrealized + realized - fees), funding, and the net.
 *
 * MADE PAIRS (the pair lanes, src/venues/pair.ts): every pool the paper desk created, with its age,
 * the routing model's share at the last mark, the fees its bands earned, the rent the pool cost and
 * the net of bands, rent and swaps. A STOCK pair (src/screener/pairStock.ts) also shows its ticker,
 * its reference pool and the state of its hedge (the virtual perp short, or "unhedged").
 */
import type { JournalEntry } from "../journal";
import { tickerOfXstock } from "../tools/backpack";
import { bookEquitySol } from "./mark";
import { paperHedgeByPool, paperHedgeEquityUsd } from "./hedge";
import type { PaperBook } from "./book";
import type { LedgerRow } from "../engine/ledger";
import { USDC_MINT } from "../tools/dlmm";

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
  /** hedge plans journaled: orders filled (paper) or placed (live), and holds by reason */
  hedgeFills: number;
  hedgeHolds: Record<string, number>;
}

/** Count what the journal did since the book started. Entries in any order. */
export function decisionTally(entries: readonly JournalEntry[], sinceIso: string): DecisionTally {
  const since = Date.parse(sinceIso);
  const t: DecisionTally = { entries: 0, holds: 0, opens: 0, closes: 0, rebalances: 0, claims: 0, vetoes: 0, overrides: 0, directives: {}, sources: {}, pools: 0, firstTs: null, lastTs: null, hedgeFills: 0, hedgeHolds: {} };
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
    const h = e.hedge;
    if (h) {
      if (h.placed) t.hedgeFills += 1;
      else {
        // fold the reason to its head so "delta +0.0100 (7.60 USD) is below the 25 USD rebalance floor" counts as one bucket
        const key = h.reason.replace(/[-+]?\d[\d.,]*/g, "n").slice(0, 60);
        t.hedgeHolds[key] = (t.hedgeHolds[key] ?? 0) + 1;
      }
    }
  }
  t.pools = pools.size;
  return t;
}

export interface PaperStockLine {
  ticker: string;
  /** the base symbols folded into this line ("SPYx") */
  symbols: string[];
  pools: string[];
  openBands: number;
  closedBands: number;
  /** open marks + closed realized + claimed fees, USD */
  bandPnlUsd: number;
  /** fees earned by those bands (claimed, realized on close, unclaimed at mark), USD */
  bandFeesUsd: number;
  /** swap fees on the acquire/liquidate legs, USD */
  swapCostUsd: number;
  /** contracts short right now */
  shortQty: number;
  perpSymbol: string | null;
  /** unrealized + realized - fees, USD */
  hedgePnlUsd: number;
  /** funding paid (negative = received), USD */
  fundingUsd: number;
  /** bandPnl - swapCost + hedgePnl - funding */
  netUsd: number;
}

/** One pool the paper desk made for a pump.fun token, folded from its bands. */
export interface PaperPairLine {
  address: string;
  label: string;
  symbol: string;
  /** a STOCK pair: the ticker; null on pump.fun pairs */
  ticker: string | null;
  /** the reference pool the lane priced from ("raydium-clmm/USDC 6truu3"), when known */
  reference: string | null;
  /** a STOCK pair's hedge state: the virtual short on the perp, or unhedged; null on pump.fun pairs */
  hedge: { symbol: string; shortQty: number; netUsd: number } | "unhedged" | null;
  /** a house token's pool (PAIR_HOUSE_MINTS) */
  house: boolean;
  /** the last mark had no reference to model from: routed reads n/a */
  refUnknown: boolean;
  quote: string;
  binStep: number;
  feeBps: number;
  ageHours: number;
  openBands: number;
  closedBands: number;
  /** the routing model at the last mark: after and before the split with competing depth */
  routedShare: number | null;
  routedShareGross: number | null;
  feesPerDayUsd: number | null;
  lastPrice: number | null;
  /** the reference row has gone cold: marking at the last price seen */
  stale: boolean;
  /** fees the pool's bands earned: claimed, realized on close, unclaimed at mark, SOL */
  feesEarnedSol: number;
  /** creation rent, never refunded, SOL */
  rentSol: number;
  /** swap fees on the token half's acquire and liquidate legs, SOL */
  swapCostSol: number;
  /** open marks + closed realized + claimed fees, SOL */
  bandPnlSol: number;
  /** bandPnl - rent - swap cost */
  netSol: number;
}

export interface PaperSummary {
  startedAt: string;
  ageHours: number;
  solPriceUsd: number | null;
  /** the report prints USD first: the book started with USDC and its SOL is rent money */
  usdFirst: boolean;
  start: { sol: number; usdc: number; equitySol: number; equityUsd: number | null };
  wallet: { sol: number; usdc: number; tokens: { mint: string; symbol: string; units: number; priceInSol: number; valueSol: number }[] };
  bands: {
    address: string;
    pool: string;
    label: string;
    quoteSymbol: string;
    side: string;
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
  swapCostSol: number;
  /** marked network fees on paper transactions */
  txFeesSol: number;
  realizedSol: number;
  /** marked bands + marked wallet tokens */
  markedSol: number;
  markedBandsSol: number;
  markedTokensSol: number;
  hedge: {
    positions: { pool: string; label: string; symbol: string; ticker: string; qty: number; entryPrice: number; markPrice: number; unrealizedUsd: number; realizedUsd: number; fundingPaidUsd: number; feesPaidUsd: number; netUsd: number }[];
    unrealizedUsd: number;
    realizedUsd: number;
    fundingPaidUsd: number;
    feesPaidUsd: number;
    netUsd: number;
    netSol: number;
    notionalUsd: number;
    fills: number;
  };
  stocks: PaperStockLine[];
  /** the pools the paper desk made (the pair lane) */
  pairs: PaperPairLine[];
  equity: {
    sol: number;
    usd: number | null;
    vsStartSol: number;
    vsStartPct: number;
    vsStartUsd: number | null;
    bandsSol: number;
    tokensSol: number;
    usdcSol: number;
    hedgeSol: number;
    /**
     * The SOL/USD move on the USDC side: every USDC flow since the start, re-priced at today's SOL price, less the
     * SOL it was booked at when it happened (realized counts it at the old price, equity at today's). Null without
     * the ledger. It is not trading: it is SOL's own move against the dollar.
     */
    valuationSol: number | null;
    /** what the named terms still leave unexplained (small; the identity prints it so it always closes) */
    otherSol: number;
  };
  tally: DecisionTally;
}

/** The stock ticker a paper band's base symbol refers to: "SPYx" -> "SPY", a Backpack-issued "NKE" -> "NKE". */
export const tickerOfSymbol = (symbol: string): string => tickerOfXstock(symbol) ?? symbol.replace(/\.US$/, "");

export function paperSummary(book: PaperBook, entries: readonly JournalEntry[], now = Date.now(), ledger?: readonly Pick<LedgerRow, "ts" | "quoteMint" | "quoteDelta" | "solDelta">[]): PaperSummary {
  const eq = bookEquitySol(book);
  const solPrice = book.solPriceUsd && book.solPriceUsd > 0 ? book.solPriceUsd : null;
  const usdcInSol = solPrice ? 1 / solPrice : 0;
  const startEquity = book.startSol + book.startUsdc * usdcInSol;
  const toUsd = (sol: number): number | null => (solPrice ? sol * solPrice : null);
  const usdFirst = solPrice !== null && book.startUsdc > book.startSol * solPrice;
  const realizedSol = book.closed.reduce((t, c) => t + c.realizedSol, 0) + book.feesClaimedSol;
  const markedBandsSol = book.bands.reduce((t, b) => t + ((b.lastMark?.valueInSol ?? b.entryValueSol) - b.entryValueSol), 0);
  const markedSol = markedBandsSol + eq.tokensMarkedSol;
  const swapCostSol = book.swapCostSol ?? 0;
  const hedgeEq = paperHedgeEquityUsd(book.hedge);
  const hedgeByPool = paperHedgeByPool(book.hedge);
  const labelOf = (pool: string) => book.bands.find((b) => b.pool === pool)?.label ?? book.closed.find((c) => c.pool === pool)?.label ?? pool.slice(0, 8);

  // per stock: bands by base symbol -> ticker, the hedge by pool -> ticker, swap costs by mint
  const usd = (sol: number) => (solPrice ? sol * solPrice : 0);
  const stocks = new Map<string, PaperStockLine>();
  const line = (ticker: string): PaperStockLine => {
    let l = stocks.get(ticker);
    if (!l) {
      l = { ticker, symbols: [], pools: [], openBands: 0, closedBands: 0, bandPnlUsd: 0, bandFeesUsd: 0, swapCostUsd: 0, shortQty: 0, perpSymbol: null, hedgePnlUsd: 0, fundingUsd: 0, netUsd: 0 };
      stocks.set(ticker, l);
    }
    return l;
  };
  const poolTicker = new Map<string, string>();
  const mintTicker = new Map<string, string>();
  for (const b of book.bands) {
    const l = line(tickerOfSymbol(b.tokenSymbol));
    if (!l.symbols.includes(b.tokenSymbol)) l.symbols.push(b.tokenSymbol);
    if (!l.pools.includes(b.pool)) l.pools.push(b.pool);
    poolTicker.set(b.pool, l.ticker);
    mintTicker.set(b.tokenMint, l.ticker);
    l.openBands += 1;
    l.bandPnlUsd += usd((b.lastMark?.valueInSol ?? b.entryValueSol) - b.entryValueSol);
    l.bandFeesUsd += usd(b.lastMark?.feeSol ?? 0);
  }
  for (const c of book.closed) {
    const sym = book.bands.find((b) => b.pool === c.pool)?.tokenSymbol ?? c.label.split("/")[0];
    const l = line(tickerOfSymbol(sym));
    if (!l.pools.includes(c.pool)) l.pools.push(c.pool);
    poolTicker.set(c.pool, l.ticker);
    l.closedBands += 1;
    l.bandPnlUsd += usd(c.realizedSol);
    l.bandFeesUsd += usd(c.feeSol);
  }
  for (const [pool, sol] of Object.entries(book.feesClaimedByPool ?? {})) {
    const t = poolTicker.get(pool);
    if (!t) continue;
    line(t).bandPnlUsd += usd(sol);
    line(t).bandFeesUsd += usd(sol);
  }
  for (const [mint, sol] of Object.entries(book.swapCostByMint ?? {})) {
    const t = mintTicker.get(mint) ?? (book.tokenMarks[mint] ? tickerOfSymbol(book.tokenMarks[mint].symbol) : null);
    if (!t) continue;
    line(t).swapCostUsd += usd(sol);
  }
  for (const [pool, h] of Object.entries(hedgeByPool)) {
    const l = line(poolTicker.get(pool) ?? h.ticker);
    if (!l.pools.includes(pool)) l.pools.push(pool);
    l.perpSymbol = h.symbol;
    l.shortQty += h.qty;
    l.hedgePnlUsd += h.unrealizedUsd + h.realizedUsd - h.feesPaidUsd;
    l.fundingUsd += h.fundingPaidUsd;
  }
  for (const l of stocks.values()) l.netUsd = l.bandPnlUsd - l.swapCostUsd + l.hedgePnlUsd - l.fundingUsd;

  // made pairs: the pool's bands, its rent and the swaps on its token
  const pairs: PaperPairLine[] = Object.entries(book.pairPools ?? {}).map(([address, p]) => {
    const open = book.bands.filter((b) => b.pool === address);
    const closedHere = book.closed.filter((c) => c.pool === address);
    const feesEarnedSol = open.reduce((t, b) => t + (b.lastMark?.feeSol ?? 0), 0) + closedHere.reduce((t, c) => t + c.feeSol, 0) + (book.feesClaimedByPool?.[address] ?? 0);
    const bandPnlSol = open.reduce((t, b) => t + ((b.lastMark?.valueInSol ?? b.entryValueSol) - b.entryValueSol), 0) + closedHere.reduce((t, c) => t + c.realizedSol, 0) + (book.feesClaimedByPool?.[address] ?? 0);
    const swapCostSol = book.swapCostByMint?.[p.mint] ?? 0;
    const h = hedgeByPool[address];
    return {
      address,
      label: `${p.symbol}/${p.quote}`,
      symbol: p.symbol,
      ticker: p.stock?.ticker ?? null,
      reference: p.refPool ? `${p.refVenue ?? "?"} ${p.refPool.slice(0, 6)}` : (p.refVenue ?? null),
      hedge: p.stock ? (h && (h.qty > 0 || h.realizedUsd !== 0 || h.feesPaidUsd !== 0) ? { symbol: h.symbol, shortQty: h.qty, netUsd: h.netUsd } : "unhedged") : null,
      house: !!p.house,
      refUnknown: p.lastRefKnown === false,
      quote: p.quote,
      binStep: p.binStep,
      feeBps: p.feeBps,
      ageHours: Math.max(0, (now - p.createdAt) / 3600e3),
      openBands: open.length,
      closedBands: closedHere.length,
      routedShare: p.lastRoutedShare ?? null,
      routedShareGross: p.lastRoutedShareGross ?? null,
      feesPerDayUsd: p.lastFeesPerDayUsd ?? null,
      lastPrice: p.lastPrice ?? null,
      stale: p.lastRefStale ?? false,
      feesEarnedSol,
      rentSol: p.rentSol,
      swapCostSol,
      bandPnlSol,
      netSol: bandPnlSol - p.rentSol - swapCostSol,
    };
  });

  const startUsd = usdFirst ? book.startSol * solPrice! + book.startUsdc : toUsd(startEquity);
  const explainedSol = realizedSol + markedSol + eq.hedgeSol - book.rentLockedSol - book.rentSpentSol - swapCostSol - (book.txFeesSol ?? 0);
  const bookStart = Date.parse(book.startedAt);
  const valuationSol =
    ledger && solPrice
      ? ledger.filter((r) => r.ts >= bookStart && r.quoteMint === USDC_MINT).reduce((t, r) => t + (r.quoteDelta ?? 0) / solPrice - r.solDelta, 0)
      : null;
  return {
    startedAt: book.startedAt,
    ageHours: Math.max(0, (now - Date.parse(book.startedAt)) / 3600e3),
    solPriceUsd: book.solPriceUsd,
    usdFirst,
    start: { sol: book.startSol, usdc: book.startUsdc, equitySol: startEquity, equityUsd: startUsd },
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
        side: b.side,
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
    swapCostSol,
    txFeesSol: book.txFeesSol ?? 0,
    realizedSol,
    markedSol,
    markedBandsSol,
    markedTokensSol: eq.tokensMarkedSol,
    hedge: {
      positions: Object.entries(hedgeByPool).map(([pool, h]) => ({ pool, label: labelOf(pool), ...h })),
      unrealizedUsd: hedgeEq.unrealizedUsd,
      realizedUsd: hedgeEq.realizedUsd,
      fundingPaidUsd: hedgeEq.fundingPaidUsd,
      feesPaidUsd: hedgeEq.feesPaidUsd,
      netUsd: hedgeEq.netUsd,
      netSol: eq.hedgeSol,
      notionalUsd: hedgeEq.notionalUsd,
      fills: book.hedge?.fills ?? 0,
    },
    stocks: [...stocks.values()].sort((a, b) => b.netUsd - a.netUsd),
    pairs: pairs.sort((a, b) => b.netSol - a.netSol),
    equity: {
      sol: eq.equitySol,
      usd: toUsd(eq.equitySol),
      vsStartSol: eq.equitySol - startEquity,
      vsStartPct: startEquity > 0 ? (eq.equitySol / startEquity - 1) * 100 : 0,
      vsStartUsd: toUsd(eq.equitySol - startEquity),
      bandsSol: eq.bandsSol,
      tokensSol: eq.tokensSol,
      usdcSol: eq.usdcSol,
      hedgeSol: eq.hedgeSol,
      valuationSol,
      otherSol: eq.equitySol - startEquity - explainedSol - (valuationSol ?? 0),
    },
    tally: decisionTally(entries, book.startedAt),
  };
}

const solFmt = (n: number, d = 4) => `${n.toFixed(d)} SOL`;
const signed = (n: number, d = 4) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}`;
const usdFmt = (n: number | null, d = 2) => (n === null ? "n/a" : `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d })}`);
const usdSigned = (n: number | null, d = 2) => (n === null ? "n/a" : `${n >= 0 ? "+" : "-"}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d })}`);
const hrs = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`);
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

export function renderPaperReport(s: PaperSummary): string {
  const out: string[] = [];
  const px = s.solPriceUsd;
  const uf = s.usdFirst && px !== null;
  /** a SOL figure in the book's currency first */
  const money = (sol: number, d = 4) => (uf ? `${usdFmt(sol * px!)} (${solFmt(sol, d)})` : `${solFmt(sol, d)}${px ? ` (${usdFmt(sol * px)})` : ""}`);
  const moneySigned = (sol: number, d = 4) => (uf ? `${usdSigned(sol * px!)} (${signed(sol, d)} SOL)` : `${signed(sol, d)} SOL${px ? ` (${usdSigned(sol * px)})` : ""}`);
  out.push("=".repeat(96));
  out.push(`PAPER BOOK  started ${s.startedAt} (${hrs(s.ageHours)} ago)  |  SOL ${px ? usdFmt(px) : "n/a"}  |  ${uf ? "USD book (SOL is rent money)" : "SOL book"}  |  nothing broadcast`);
  out.push("=".repeat(96));
  out.push(`start        ${solFmt(s.start.sol)} + ${s.start.usdc.toFixed(2)} USDC = ${money(s.start.equitySol)}${uf ? " at today's SOL price" : ""}`);
  const tokens = s.wallet.tokens.length ? s.wallet.tokens.map((t) => `${t.units.toFixed(4)} ${t.symbol} (${money(t.valueSol)})`).join(", ") : "no tokens";
  out.push(`wallet now   ${solFmt(s.wallet.sol)} + ${s.wallet.usdc.toFixed(2)} USDC + ${tokens}`);
  out.push(`equity now   ${money(s.equity.sol)} = wallet ${money(s.wallet.sol)} + USDC ${money(s.equity.usdcSol)} + tokens ${money(s.equity.tokensSol)} + bands ${money(s.equity.bandsSol)} (incl. ${money(s.feesUnclaimedSol, 6)} unclaimed fees) + hedge ${moneySigned(s.equity.hedgeSol)}`);
  out.push(`vs start     ${moneySigned(s.equity.vsStartSol)} (${signed(s.equity.vsStartPct, 2)}%)  = realized ${moneySigned(s.realizedSol)} + marked ${moneySigned(s.markedSol)} (bands ${moneySigned(s.markedBandsSol)}, wallet tokens ${moneySigned(s.markedTokensSol)}) + hedge ${moneySigned(s.equity.hedgeSol)} - rent locked ${money(s.rentLockedSol)} - rent spent ${money(s.rentSpentSol)} - swap cost ${money(s.swapCostSol, 6)} - tx fees ${money(s.txFeesSol, 6)}${s.equity.valuationSol !== null ? ` + SOL/USD valuation ${moneySigned(s.equity.valuationSol)}` : ""} + other ${moneySigned(s.equity.otherSol)}`);
  out.push(`identity     ${signed(s.equity.vsStartSol, 6)} SOL = ${signed(s.realizedSol, 6)} + ${signed(s.markedSol, 6)} + ${signed(s.equity.hedgeSol, 6)} - ${s.rentLockedSol.toFixed(6)} - ${s.rentSpentSol.toFixed(6)} - ${s.swapCostSol.toFixed(6)} - ${s.txFeesSol.toFixed(6)} + ${signed(s.equity.valuationSol ?? 0, 6)} + ${signed(s.equity.otherSol, 6)} (SOL: realized + marked + hedge - rent locked - rent spent - swap cost - tx fees + SOL/USD valuation${s.equity.valuationSol === null ? " (no ledger: 0)" : ""} + other)`);
  out.push(`fees         claimed ${money(s.feesClaimedSol, 6)} | realized incl. closes ${money(s.feesRealizedSol, 6)} | unclaimed ${money(s.feesUnclaimedSol, 6)} | close slippage ${money(s.slippagePaidSol, 6)} | swap fees ${money(s.swapCostSol, 6)}`);
  out.push(`rent         ${money(s.rentLockedSol)} locked in ${s.bands.length} band(s), refunded on close | ${money(s.rentSpentSol)} spent on bin arrays (CLMM: tick arrays and protocol positions), not refunded`);
  out.push("");
  out.push(`OPEN BANDS (${s.bands.length})`);
  if (!s.bands.length) out.push("  none");
  for (const b of s.bands) {
    const where = b.inRange === null ? "unmarked" : b.inRange ? "IN RANGE" : `OUT ${Math.abs(b.binsFromRange ?? 0)} bins ${(b.binsFromRange ?? 0) < 0 ? "below" : "above"}`;
    out.push(`  ${pad(b.address, 20)} ${pad(b.label, 14)} ${pad(b.side === "BOTH" ? "straddle" : b.side === "SOL_ONLY" ? "quote-only" : "token-only", 10)} bins [${b.range[0]}, ${b.range[1]}] active ${b.activeBinId ?? "?"}  ${pad(where, 18)} value ${money(b.valueSol)}  fees ${money(b.feeSol, 6)}  P&L ${moneySigned(b.pnlSol)} (${signed(b.pnlPct, 2)}%) vs entry ${money(b.entryValueSol)}  age ${hrs(b.ageHours)}`);
  }
  out.push("");
  out.push(`CLOSED BANDS (${s.closed.length})`);
  if (!s.closed.length) out.push("  none");
  for (const c of s.closed) {
    out.push(`  ${pad(c.address, 20)} ${pad(c.label, 14)} realized ${moneySigned(c.realizedSol)} (${signed(c.realizedPct, 2)}%)  fees ${money(c.feeSol, 6)}  held ${hrs(c.holdHours)}  ${c.emergency ? "ENGINE/GUARD: " : ""}${c.reason}`);
  }
  out.push("");
  out.push(`MADE PAIRS (${s.pairs.length})  pools the desk created (pump.fun tokens: the pair lane; tokenized stocks in SOL: the stock pair lane); routed = the model's share of the reference flow at the last mark (net after competing depth | gross before it)`);
  if (!s.pairs.length) out.push("  none");
  for (const p of s.pairs) {
    const routed = p.refUnknown ? "n/a (no reference yet)" : p.routedShare === null ? "n/a" : `${(p.routedShare * 100).toFixed(1)}%${p.routedShareGross !== null ? ` | ${(p.routedShareGross * 100).toFixed(1)}%` : ""}`;
    const hedge = p.hedge === "unhedged" ? "unhedged" : p.hedge ? (p.hedge.shortQty > 0 ? `hedged short ${p.hedge.shortQty.toFixed(4)} ${p.hedge.symbol} (${usdSigned(p.hedge.netUsd)})` : `hedge flat (${usdSigned(p.hedge.netUsd)})`) : "no hedge";
    const stock = p.ticker ? `${p.ticker} stock, ref ${p.reference ?? "n/a"}, ${hedge}  ` : p.house ? "HOUSE TOKEN  " : "";
    out.push(`  ${pad(p.address, 20)} ${pad(p.label, 14)} ${stock}${(p.binStep / 100).toFixed(2)}%/bin fee ${(p.feeBps / 100).toFixed(2)}%  age ${hrs(p.ageHours)}  ${p.openBands} open/${p.closedBands} closed  routed ${routed}${p.feesPerDayUsd !== null && !p.refUnknown ? ` (${usdFmt(p.feesPerDayUsd)}/day)` : ""}${p.stale && !p.house ? "  REFERENCE GONE" : ""}  fees ${money(p.feesEarnedSol, 6)}  rent ${money(p.rentSol, 6)}  swaps ${money(p.swapCostSol, 6)}  P&L ${moneySigned(p.netSol, 6)}`);
  }
  out.push("");
  const h = s.hedge;
  out.push(`HEDGE (virtual Backpack perp shorts)  notional ${usdFmt(h.notionalUsd)} | unrealized ${usdSigned(h.unrealizedUsd)} | realized ${usdSigned(h.realizedUsd)} | funding paid ${usdSigned(h.fundingPaidUsd)} | fees ${usdFmt(h.feesPaidUsd)} | net ${usdSigned(h.netUsd)} (${signed(h.netSol, 6)} SOL) | ${h.fills} fill(s)`);
  if (!h.positions.length) out.push("  none");
  for (const p of h.positions) {
    out.push(`  ${pad(p.label, 14)} ${pad(p.symbol, 20)} short ${p.qty.toFixed(4)} @ ${p.entryPrice.toFixed(2)}  mark ${p.markPrice.toFixed(2)}  unrealized ${usdSigned(p.unrealizedUsd)}  realized ${usdSigned(p.realizedUsd)}  funding ${usdSigned(p.fundingPaidUsd)}  fees ${usdFmt(p.feesPaidUsd)}  net ${usdSigned(p.netUsd)}`);
  }
  out.push("");
  out.push("PER STOCK (USD)  band P&L = open marks + closed realized + claimed fees | hedge P&L = unrealized + realized - fees | net = bands - swaps + hedge - funding");
  if (!s.stocks.length) out.push("  none");
  for (const l of s.stocks) {
    out.push(`  ${pad(l.ticker, 6)} ${pad(l.symbols.join("+") || "-", 8)} ${l.openBands} open/${l.closedBands} closed  bands ${usdSigned(l.bandPnlUsd)} (fees ${usdFmt(l.bandFeesUsd)})  swaps ${usdFmt(l.swapCostUsd)}  hedge ${usdSigned(l.hedgePnlUsd)} (short ${l.shortQty.toFixed(4)}${l.perpSymbol ? ` ${l.perpSymbol}` : ", no perp"})  funding ${usdSigned(l.fundingUsd)}  net ${usdSigned(l.netUsd)}`);
  }
  out.push("");
  const t = s.tally;
  const directives = Object.entries(t.directives).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  const sources = Object.entries(t.sources).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  out.push(`DECISIONS since start: ${t.entries} across ${t.pools} pool(s)${t.firstTs ? ` (${t.firstTs} to ${t.lastTs})` : ""}`);
  out.push(`  opens ${t.opens} | rebalances ${t.rebalances} | closes ${t.closes} | claims ${t.claims} | holds ${t.holds} | guard vetoes ${t.vetoes} | guard overrides ${t.overrides} | engine directives ${directives}`);
  out.push(`  proposed by: ${sources}`);
  const holds = Object.entries(t.hedgeHolds).sort((a, b) => b[1] - a[1]);
  out.push(`  hedge: ${t.hedgeFills} fill(s)/order(s)${holds.length ? `; holds: ${holds.map(([k, v]) => `${v}x "${k}"`).join(", ")}` : ""}`);
  out.push("=".repeat(96));
  return out.join("\n");
}
