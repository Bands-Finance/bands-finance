/**
 * The paper hedge book: virtual Backpack perp shorts against the paper book's stock inventory,
 * so a dry run shows the straddle's NET result (band fees and marks, hedge P&L, funding).
 * Lives inside the paper book file (PaperBook.hedge); pure operations, the loop saves the book.
 *
 *   fill     the hedge plan (src/engine/hedge.ts) "fills" at the perp mid: an Ask adds to the
 *            short at a new average entry, a Bid buys back and realizes (entry - price) x qty;
 *            a maker fee of PAPER_HEDGE_FEE_PCT (default 0.02%) is charged on the notional
 *   mark     every cycle at the current perp mid: unrealized = (entry - mark) x qty
 *   funding  accrued pro rata for the hours since the last accrual from the basis row's
 *            fundingRatePerHour (Backpack: longs pay shorts when positive, so a short is PAID on a
 *            positive rate: fundingCostUsd is negative); the gap is capped at one hour per mark so
 *            a restart never accrues a day at once
 *   equity   unrealized + realized - funding paid - fees paid, in USD; the book's SOL equity adds it
 *            at the last SOL price (src/paper/mark.ts bookEquitySol)
 *
 * One position per pool: the hedge plan is computed per pool (its bands' token plus the wallet's
 * share of the mint), so two pools on the same perp keep separate virtual shorts.
 */
import { fundingCostUsd } from "../engine/hedge";

export const PAPER_HEDGE_FEE_PCT_DEFAULT = 0.02;
/** funding is accrued for at most this long per mark (a restart never accrues a day at once) */
export const MAX_FUNDING_GAP_SEC = 3600;

export function paperHedgeFeePct(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAPER_HEDGE_FEE_PCT;
  if (raw === undefined || raw.trim() === "") return PAPER_HEDGE_FEE_PCT_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : PAPER_HEDGE_FEE_PCT_DEFAULT;
}

export interface PaperHedgePosition {
  /** the pool whose inventory this short covers */
  pool: string;
  /** perp symbol ("SPY.US_USDC_PERP") */
  symbol: string;
  ticker: string;
  /** contracts short, > 0 */
  qty: number;
  /** average entry of the open short, USD */
  entryPrice: number;
  openedAt: number;
  lastMarkAt: number;
  lastMarkPrice: number;
  lastFundingAt: number;
  /** funding paid so far on this position, USD (negative = received) */
  fundingPaidUsd: number;
  /** maker fees paid on fills, USD */
  feesPaidUsd: number;
  /** P&L realized by buy-backs on this position, USD */
  realizedUsd: number;
  fills: number;
}

export interface PaperHedgeClosed {
  pool: string;
  symbol: string;
  ticker: string;
  /** the largest short the position reached */
  maxQty: number;
  entryPrice: number;
  exitPrice: number;
  openedAt: number;
  closedAt: number;
  realizedUsd: number;
  fundingPaidUsd: number;
  feesPaidUsd: number;
  fills: number;
}

export interface PaperHedgeBook {
  positions: PaperHedgePosition[];
  closed: PaperHedgeClosed[];
  /** realized P&L over every buy-back, open and closed positions alike, USD */
  realizedUsd: number;
  fundingPaidUsd: number;
  feesPaidUsd: number;
  fills: number;
  /** pool -> the largest short its position reached (for the closed rows) */
  maxQty: Record<string, number>;
}

export function emptyHedgeBook(): PaperHedgeBook {
  return { positions: [], closed: [], realizedUsd: 0, fundingPaidUsd: 0, feesPaidUsd: 0, fills: 0, maxQty: {} };
}

/** A hedge book read tolerantly (older paper books carry none). */
export function normalizeHedgeBook(raw: Partial<PaperHedgeBook> | null | undefined): PaperHedgeBook {
  const empty = emptyHedgeBook();
  if (!raw || typeof raw !== "object") return empty;
  return {
    ...empty,
    ...raw,
    positions: Array.isArray(raw.positions) ? raw.positions : [],
    closed: Array.isArray(raw.closed) ? raw.closed : [],
    maxQty: raw.maxQty ?? {},
  };
}

const r8 = (n: number) => Math.round(n * 1e8) / 1e8;

export function hedgePositionOf(h: PaperHedgeBook, pool: string): PaperHedgePosition | null {
  return h.positions.find((p) => p.pool === pool) ?? null;
}

/** Contracts short for a pool (0 when none): the plan's existingShortQty. */
export function paperShortQty(h: PaperHedgeBook, pool: string): number {
  return hedgePositionOf(h, pool)?.qty ?? 0;
}

export interface PaperHedgeFillInput {
  pool: string;
  symbol: string;
  ticker: string;
  /** Ask = sell perp (add to the short), Bid = buy perp (reduce it) */
  side: "Ask" | "Bid";
  quantity: number;
  /** the fill price: the perp mid */
  price: number;
  now: number;
  /** maker fee in percent of the notional; default PAPER_HEDGE_FEE_PCT */
  feePct?: number;
}

export interface PaperHedgeFill {
  side: "Ask" | "Bid";
  quantity: number;
  price: number;
  feeUsd: number;
  /** P&L realized by this fill (a Bid), USD */
  realizedUsd: number;
  qtyAfter: number;
  entryAfter: number;
  /** the position was closed out by this fill */
  closed: boolean;
}

/**
 * Fill a hedge order at `price`. An Ask grows the short (new average entry); a Bid shrinks it and
 * realizes (entry - price) x qty. A Bid larger than the short is clipped to it (reduceOnly).
 */
export function fillPaperHedge(h: PaperHedgeBook, i: PaperHedgeFillInput): PaperHedgeFill {
  if (!(i.quantity > 0) || !Number.isFinite(i.quantity)) throw new Error(`paper hedge fill: bad quantity ${i.quantity}`);
  if (!(i.price > 0) || !Number.isFinite(i.price)) throw new Error(`paper hedge fill: bad price ${i.price}`);
  const feePct = i.feePct ?? paperHedgeFeePct();
  let pos = hedgePositionOf(h, i.pool);
  if (!pos) {
    if (i.side === "Bid") throw new Error(`paper hedge fill: nothing to buy back for ${i.pool.slice(0, 6)}`);
    pos = { pool: i.pool, symbol: i.symbol, ticker: i.ticker, qty: 0, entryPrice: 0, openedAt: i.now, lastMarkAt: i.now, lastMarkPrice: i.price, lastFundingAt: i.now, fundingPaidUsd: 0, feesPaidUsd: 0, realizedUsd: 0, fills: 0 };
    h.positions.push(pos);
  }
  const qty = i.side === "Bid" ? Math.min(i.quantity, pos.qty) : i.quantity;
  const feeUsd = r8(qty * i.price * (feePct / 100));
  let realizedUsd = 0;
  if (i.side === "Ask") {
    const notional = pos.qty * pos.entryPrice + qty * i.price;
    pos.qty = r8(pos.qty + qty);
    pos.entryPrice = pos.qty > 0 ? notional / pos.qty : 0;
  } else {
    realizedUsd = r8((pos.entryPrice - i.price) * qty);
    pos.qty = r8(pos.qty - qty);
    pos.realizedUsd = r8(pos.realizedUsd + realizedUsd);
    h.realizedUsd = r8(h.realizedUsd + realizedUsd);
  }
  pos.feesPaidUsd = r8(pos.feesPaidUsd + feeUsd);
  pos.fills += 1;
  pos.lastMarkAt = i.now;
  pos.lastMarkPrice = i.price;
  h.feesPaidUsd = r8(h.feesPaidUsd + feeUsd);
  h.fills += 1;
  h.maxQty[i.pool] = Math.max(h.maxQty[i.pool] ?? 0, pos.qty);
  let closed = false;
  if (pos.qty <= 1e-12) {
    closed = true;
    h.closed.push({ pool: pos.pool, symbol: pos.symbol, ticker: pos.ticker, maxQty: h.maxQty[i.pool] ?? qty, entryPrice: pos.entryPrice, exitPrice: i.price, openedAt: pos.openedAt, closedAt: i.now, realizedUsd: pos.realizedUsd, fundingPaidUsd: pos.fundingPaidUsd, feesPaidUsd: pos.feesPaidUsd, fills: pos.fills });
    h.positions = h.positions.filter((p) => p !== pos);
    delete h.maxQty[i.pool];
  }
  return { side: i.side, quantity: qty, price: i.price, feeUsd, realizedUsd, qtyAfter: closed ? 0 : pos.qty, entryAfter: closed ? 0 : pos.entryPrice, closed };
}

/** Unrealized P&L of a short at a price: (entry - price) x qty. */
export function paperHedgeUnrealizedUsd(pos: Pick<PaperHedgePosition, "qty" | "entryPrice" | "lastMarkPrice">, price: number = pos.lastMarkPrice): number {
  return (pos.entryPrice - price) * pos.qty;
}

/** Mark a pool's short at the current perp mid. Returns its unrealized P&L, or null when the pool has no short. */
export function markPaperHedge(h: PaperHedgeBook, pool: string, price: number, now: number): { unrealizedUsd: number } | null {
  const pos = hedgePositionOf(h, pool);
  if (!pos) return null;
  if (price > 0 && Number.isFinite(price)) {
    pos.lastMarkPrice = price;
    pos.lastMarkAt = Math.max(pos.lastMarkAt, now);
  }
  return { unrealizedUsd: paperHedgeUnrealizedUsd(pos) };
}

export interface FundingAccrual {
  hours: number;
  notionalUsd: number;
  ratePerHour: number;
  /** what the short paid this accrual (negative = received) */
  fundingUsd: number;
}

/**
 * Accrue funding on a pool's short for the time since the last accrual (capped at one hour per
 * mark), at `ratePerHour` on qty x price. A null rate accrues nothing but still advances the clock.
 */
export function accruePaperFunding(h: PaperHedgeBook, pool: string, ratePerHour: number | null, price: number, now: number): FundingAccrual | null {
  const pos = hedgePositionOf(h, pool);
  if (!pos) return null;
  const hours = Math.min(MAX_FUNDING_GAP_SEC, Math.max(0, (now - pos.lastFundingAt) / 1000)) / 3600;
  pos.lastFundingAt = Math.max(pos.lastFundingAt, now);
  const rate = typeof ratePerHour === "number" && Number.isFinite(ratePerHour) ? ratePerHour : 0;
  const notionalUsd = pos.qty * (price > 0 ? price : pos.lastMarkPrice);
  const fundingUsd = hours > 0 && rate !== 0 ? r8(fundingCostUsd(notionalUsd, rate, hours, "short")) : 0;
  pos.fundingPaidUsd = r8(pos.fundingPaidUsd + fundingUsd);
  h.fundingPaidUsd = r8(h.fundingPaidUsd + fundingUsd);
  return { hours, notionalUsd, ratePerHour: rate, fundingUsd };
}

export interface PaperHedgeEquity {
  unrealizedUsd: number;
  realizedUsd: number;
  fundingPaidUsd: number;
  feesPaidUsd: number;
  /** unrealized + realized - funding - fees */
  netUsd: number;
  /** the open shorts' notional at their last marks */
  notionalUsd: number;
}

/** The hedge book's contribution to equity, USD. */
export function paperHedgeEquityUsd(h: PaperHedgeBook | null | undefined): PaperHedgeEquity {
  if (!h) return { unrealizedUsd: 0, realizedUsd: 0, fundingPaidUsd: 0, feesPaidUsd: 0, netUsd: 0, notionalUsd: 0 };
  let unrealizedUsd = 0;
  let notionalUsd = 0;
  for (const p of h.positions) {
    unrealizedUsd += paperHedgeUnrealizedUsd(p);
    notionalUsd += p.qty * p.lastMarkPrice;
  }
  return { unrealizedUsd, realizedUsd: h.realizedUsd, fundingPaidUsd: h.fundingPaidUsd, feesPaidUsd: h.feesPaidUsd, netUsd: unrealizedUsd + h.realizedUsd - h.fundingPaidUsd - h.feesPaidUsd, notionalUsd };
}

/** Per-pool hedge figures for the report: open position first, closed rows folded in. */
export function paperHedgeByPool(h: PaperHedgeBook | null | undefined): Record<string, { symbol: string; ticker: string; qty: number; entryPrice: number; markPrice: number; unrealizedUsd: number; realizedUsd: number; fundingPaidUsd: number; feesPaidUsd: number; netUsd: number }> {
  const out: ReturnType<typeof paperHedgeByPool> = {};
  if (!h) return out;
  for (const c of h.closed) {
    const cur = out[c.pool] ?? { symbol: c.symbol, ticker: c.ticker, qty: 0, entryPrice: 0, markPrice: c.exitPrice, unrealizedUsd: 0, realizedUsd: 0, fundingPaidUsd: 0, feesPaidUsd: 0, netUsd: 0 };
    cur.realizedUsd += c.realizedUsd;
    cur.fundingPaidUsd += c.fundingPaidUsd;
    cur.feesPaidUsd += c.feesPaidUsd;
    out[c.pool] = cur;
  }
  for (const p of h.positions) {
    const cur = out[p.pool] ?? { symbol: p.symbol, ticker: p.ticker, qty: 0, entryPrice: 0, markPrice: p.lastMarkPrice, unrealizedUsd: 0, realizedUsd: 0, fundingPaidUsd: 0, feesPaidUsd: 0, netUsd: 0 };
    cur.symbol = p.symbol;
    cur.ticker = p.ticker;
    cur.qty = p.qty;
    cur.entryPrice = p.entryPrice;
    cur.markPrice = p.lastMarkPrice;
    cur.unrealizedUsd += paperHedgeUnrealizedUsd(p);
    cur.realizedUsd += p.realizedUsd;
    cur.fundingPaidUsd += p.fundingPaidUsd;
    cur.feesPaidUsd += p.feesPaidUsd;
    out[p.pool] = cur;
  }
  for (const v of Object.values(out)) v.netUsd = v.unrealizedUsd + v.realizedUsd - v.fundingPaidUsd - v.feesPaidUsd;
  return out;
}
