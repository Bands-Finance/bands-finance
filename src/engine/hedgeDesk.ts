/**
 * The hedge desk: wires the pure hedge policy (src/engine/hedge.ts hedgePlan) into the loop after
 * every stock-pool execution, so the straddle's token half is carried delta-neutral.
 *
 *   inventory  the stock token in the wallet (attributed once per mint per cycle) + this pool's
 *              bands, marked (the loop computes it: src/index.ts)
 *   symbol     the basis row's perp (Backpack lists NVDA.US_USDC_PERP, SPY.US_USDC_PERP ...; none
 *              for some tickers, then the plan holds with a note and the token half runs unhedged)
 *   price      the perp mid refreshed this cycle, else the basis row's, else the pool price in USD
 *   existing   paper: the virtual short for this pool; live: Backpack's net short on the symbol
 *              (less what other pools on the same symbol already target this cycle); else 0
 *
 * What becomes of the plan:
 *   paper      the order "fills" at the perp mid in the paper hedge book (src/paper/hedge.ts): a
 *              maker fee, then the position is marked and funding accrued every cycle; in paper
 *              mode hedging is ON by default (HEDGE_MAX_NOTIONAL_USD > 0 caps it, 0 = uncapped)
 *   live       keys set + HEDGE_LIVE=true + DRY_RUN=false: a post-only limit at the perp mid rounded
 *              to the tick, reduceOnly when shrinking (the client refuses anything less)
 *   plan       otherwise journaled only, with the reason nothing was placed
 *
 * Every outcome is a JournalHedge on the cycle's journal entry. Never throws: a Backpack error is a
 * note on the plan, never a failed cycle.
 */
import type { JournalHedge } from "../journal";
import { accruePaperFunding, fillPaperHedge, markPaperHedge, normalizeHedgeBook, paperShortQty, type PaperBook } from "../paper";
import type { BackpackClient, BackpackMarket } from "../tools/backpack";
import { hedgePlan, hedgeSettings, shortQtyOf, stepDecimals, type HedgePlan, type HedgeSettings } from "./hedge";

/** The slice of the Backpack client the desk uses (a test hands in a fake). */
export type HedgeClient = Pick<BackpackClient, "market" | "positions" | "placeOrder" | "canTrade">;

export interface HedgeDeskInput {
  pool: string;
  label: string;
  ticker: string | null;
  /** the perp symbol (from the basis row); null when Backpack lists none */
  symbol: string | null;
  /** base tokens to hedge: the wallet's + this pool's bands, token units (1 token = 1 contract) */
  baseInventory: number;
  /** USD per token; null when no price is known */
  basePrice: number | null;
  fundingRatePerHour: number | null;
  now: number;
  /** paper mode: the book whose hedge book takes the fill */
  paper?: PaperBook | null;
  client?: HedgeClient | null;
  settings?: HedgeSettings;
  /** live: contracts other pools on the same symbol already target this cycle (they share one Backpack position) */
  otherPoolsShort?: number;
  /** paper maker fee in percent of the notional (default PAPER_HEDGE_FEE_PCT) */
  paperFeePct?: number;
}

export interface HedgeDeskOutcome {
  journal: JournalHedge;
  plan: HedgePlan | null;
  /** one-line log lines for the loop */
  lines: string[];
}

/** Round a price to the market's tick (nearest), with float noise removed. */
export function roundToTick(price: number, tick: number | null | undefined): number {
  const t = Number(tick);
  if (!(t > 0) || !Number.isFinite(t)) return price;
  return Number((Math.round(price / t) * t).toFixed(stepDecimals(t)));
}

/** Paper mode hedges by default: a zero cap means uncapped there, not off. */
export function paperHedgeSettings(s: HedgeSettings): HedgeSettings {
  return { ...s, maxNotionalUsd: s.maxNotionalUsd > 0 ? s.maxNotionalUsd : Number.POSITIVE_INFINITY };
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export async function runHedgeDesk(i: HedgeDeskInput): Promise<HedgeDeskOutcome> {
  const lines: string[] = [];
  const paper = i.paper ?? null;
  const mode: JournalHedge["mode"] = paper ? "paper" : "plan";
  const inventory = Number.isFinite(i.baseInventory) && i.baseInventory > 0 ? i.baseInventory : 0;
  const base: JournalHedge = { symbol: i.symbol, targetShortQty: r6(inventory), existingShortQty: 0, side: null, quantity: 0, reason: "", placed: false, basePrice: i.basePrice, mode, fillPrice: null, orderId: null, fundingUsd: null, note: null };

  if (!i.symbol) {
    const reason = `no Backpack perp listed for ${i.ticker ?? i.label}: the token half runs unhedged`;
    lines.push(`hedge: ${reason} (inventory ${inventory.toFixed(4)})`);
    return { journal: { ...base, reason }, plan: null, lines };
  }

  // the market's filters (step, min, tick); tolerated when Backpack does not answer
  let market: BackpackMarket | null = null;
  try {
    market = (await i.client?.market(i.symbol)) ?? null;
  } catch (err) {
    lines.push(`hedge: markets unavailable (${(err as Error).message}); quantities unrounded`);
  }

  // what is short already
  let existing = 0;
  let existingNote: string | null = null;
  if (paper) {
    paper.hedge = normalizeHedgeBook(paper.hedge);
    existing = paperShortQty(paper.hedge, i.pool);
  } else if (i.client) {
    try {
      existing = Math.max(0, shortQtyOf(await i.client.positions(), i.symbol) - (i.otherPoolsShort ?? 0));
    } catch (err) {
      existingNote = `Backpack positions unavailable (${(err as Error).message.slice(0, 120)}): existing short taken as 0`;
    }
  }

  const settings = i.settings ?? hedgeSettings();
  const plan = hedgePlan({ pool: i.pool, symbol: i.symbol, baseInventory: inventory, basePrice: i.basePrice ?? 0, existingShortQty: existing, market }, paper ? paperHedgeSettings(settings) : settings);
  const journal: JournalHedge = { ...base, targetShortQty: r6(plan.targetShortQty), existingShortQty: r6(plan.existingShortQty), side: plan.side, quantity: plan.quantity, reason: plan.reason, note: existingNote };

  if (paper) {
    const price = i.basePrice ?? 0;
    if (plan.side && plan.quantity > 0 && price > 0) {
      const fill = fillPaperHedge(paper.hedge!, { pool: i.pool, symbol: i.symbol, ticker: i.ticker ?? i.symbol.split(".")[0], side: plan.side, quantity: plan.quantity, price, now: i.now, feePct: i.paperFeePct });
      journal.placed = true;
      journal.fillPrice = fill.price;
      lines.push(`hedge: paper ${plan.side === "Ask" ? "SOLD" : "BOUGHT BACK"} ${fill.quantity} ${i.symbol} at ${fill.price} (fee $${fill.feeUsd.toFixed(4)}${fill.realizedUsd ? `, realized ${fill.realizedUsd >= 0 ? "+" : ""}$${fill.realizedUsd.toFixed(4)}` : ""}); short now ${fill.qtyAfter}${fill.closed ? " (closed)" : ""}`);
    } else {
      lines.push(`hedge: paper hold: ${plan.reason}`);
    }
    if (price > 0) markPaperHedge(paper.hedge!, i.pool, price, i.now);
    const funding = accruePaperFunding(paper.hedge!, i.pool, i.fundingRatePerHour, price, i.now);
    if (funding && funding.hours > 0 && funding.ratePerHour !== 0) {
      journal.fundingUsd = funding.fundingUsd;
      lines.push(`hedge: funding ${funding.fundingUsd >= 0 ? "paid" : "received"} $${Math.abs(funding.fundingUsd).toFixed(4)} over ${(funding.hours * 60).toFixed(1)} min at ${(funding.ratePerHour * 100).toFixed(5)}%/h on $${funding.notionalUsd.toFixed(2)}`);
    }
    return { journal, plan, lines };
  }

  if (!plan.side || plan.quantity <= 0) {
    lines.push(`hedge: hold: ${plan.reason}`);
    return { journal, plan, lines };
  }
  // notes stack: what could not be read stays beside why nothing was placed
  const note = (why: string) => (journal.note = [journal.note, why].filter(Boolean).join("; "));
  if (!i.client) {
    note("no Backpack client: plan journaled only");
    lines.push(`hedge: plan ${plan.side} ${plan.quantity} ${i.symbol} (${plan.reason}); ${journal.note}`);
    return { journal, plan, lines };
  }
  const gate = i.client.canTrade();
  if (!gate.ok) {
    note(`not placed: ${gate.reason}`);
    lines.push(`hedge: plan ${plan.side} ${plan.quantity} ${i.symbol} (${plan.reason}); ${journal.note}`);
    return { journal, plan, lines };
  }
  const price = roundToTick(i.basePrice ?? 0, market?.filters.tickSize ?? null);
  try {
    const order = await i.client.placeOrder({ symbol: i.symbol, side: plan.side, orderType: "Limit", quantity: plan.quantity, price, postOnly: true, reduceOnly: plan.reduceOnly, timeInForce: "GTC" });
    journal.placed = true;
    journal.mode = "live";
    journal.fillPrice = price;
    journal.orderId = order.id || null;
    lines.push(`hedge: LIVE ${plan.side} ${plan.quantity} ${i.symbol} post-only at ${price}${plan.reduceOnly ? " reduceOnly" : ""}: order ${order.id || "?"} ${order.status}`);
  } catch (err) {
    note(`order failed: ${(err as Error).message.slice(0, 160)}`);
    lines.push(`hedge: ${journal.note}`);
  }
  return { journal, plan, lines };
}
