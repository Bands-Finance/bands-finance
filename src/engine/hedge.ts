/**
 * Hedge policy: the Backpack perp order that keeps a stock-pool band delta-neutral.
 *
 * A SOL_ONLY / quote-only bid band converts USDC into stock tokens as price falls, so the base
 * inventory grows as price drops. The desk shorts the matching perp for the tokens it holds:
 *   target short qty = base inventory in the band (1 NVDAx = 1 NVDA share = 1 perp contract)
 *   delta            = target - existing short   (> 0: sell more perp, < 0: buy some back, reduceOnly)
 * Rebalance only when |delta| x price >= HEDGE_MIN_REBALANCE_USD (default 25) and never let the
 * short's notional exceed HEDGE_MAX_NOTIONAL_USD (default 0 = hedging off: no order is ever emitted).
 * Quantities are rounded DOWN to the market's stepSize and must clear its minQuantity.
 *
 * Pure: nothing here calls Backpack. The integrator feeds the plan to the signed client
 * (src/tools/backpack.ts placeOrder), which itself refuses unless HEDGE_LIVE=true and DRY_RUN=false.
 */
import type { PoolSnapshot, PositionSnapshot } from "../tools/dlmm";
import { perpSymbolOf, tickerOfXstock, type BackpackMarket } from "../tools/backpack";

export interface HedgeSettings {
  /** HEDGE_LIVE === "true" */
  live: boolean;
  /** HEDGE_MIN_REBALANCE_USD, default 25 */
  minRebalanceUsd: number;
  /** HEDGE_MAX_NOTIONAL_USD, default 0 = off */
  maxNotionalUsd: number;
}

export const HEDGE_DEFAULTS: Readonly<Omit<HedgeSettings, "live">> = { minRebalanceUsd: 25, maxNotionalUsd: 0 };

function envNum(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function hedgeSettings(env: NodeJS.ProcessEnv = process.env): HedgeSettings {
  return {
    live: (env.HEDGE_LIVE ?? "").trim().toLowerCase() === "true",
    minRebalanceUsd: envNum(env, "HEDGE_MIN_REBALANCE_USD", HEDGE_DEFAULTS.minRebalanceUsd),
    maxNotionalUsd: envNum(env, "HEDGE_MAX_NOTIONAL_USD", HEDGE_DEFAULTS.maxNotionalUsd),
  };
}

export interface HedgeInput {
  /** the pool address, or the pool/snapshot itself (its base symbol names the perp) */
  pool: string | { address?: string; baseSymbol?: string; symbol?: string; baseToken?: { symbol?: string } };
  /** the perp symbol; derived from the pool's base symbol ("NVDAx" -> "NVDA.US_USDC_PERP") when omitted */
  symbol?: string;
  /** base tokens held in the band (incl. unclaimed base fees), in token units */
  baseInventory: number;
  /** USD per base token (the perp mid, or the pool price) */
  basePrice: number;
  /** perp contracts currently short for this pool (>= 0) */
  existingShortQty: number;
  /** default HEDGE_MIN_REBALANCE_USD (25) */
  minRebalanceUsd?: number;
  /** default HEDGE_MAX_NOTIONAL_USD (0 = off) */
  maxNotionalUsd?: number;
  /** the perp market (its filters give stepSize/minQuantity); or pass them directly */
  market?: Pick<BackpackMarket, "symbol" | "filters"> | null;
  stepSize?: number | string | null;
  minQuantity?: number | string | null;
}

export interface HedgePlan {
  pool: string;
  symbol: string | null;
  /** Ask = sell perp (add to the short), Bid = buy perp (reduce the short), null = hold */
  side: "Ask" | "Bid" | null;
  /** contracts, rounded down to the step; 0 when holding */
  quantity: number;
  reduceOnly: boolean;
  reason: string;
  targetShortQty: number;
  existingShortQty: number;
  /** signed contracts: target - existing, before rounding and caps */
  deltaQty: number;
  /** |deltaQty| x price */
  deltaUsd: number;
  /** the short's notional after this order */
  notionalAfterUsd: number;
}

function poolId(pool: HedgeInput["pool"]): string {
  return typeof pool === "string" ? pool : pool.address ?? "";
}

function baseSymbolOf(pool: HedgeInput["pool"]): string | null {
  if (typeof pool === "string") return null;
  return pool.baseSymbol ?? pool.baseToken?.symbol ?? pool.symbol ?? null;
}

/** The perp symbol for a pool's base token, or null when the base is not an xStock. */
export function perpSymbolForPool(pool: HedgeInput["pool"]): string | null {
  const ticker = tickerOfXstock(baseSymbolOf(pool));
  return ticker ? perpSymbolOf(ticker) : null;
}

/** Decimal places implied by a step ("0.001" -> 3). */
export function stepDecimals(step: number): number {
  const s = String(step);
  if (/e-/i.test(s)) return Number(s.split("e-")[1]);
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
}

/** Round a quantity DOWN to the market's step, with float noise removed. */
export function roundToStep(qty: number, step: number | string | null | undefined): number {
  if (!(qty > 0)) return 0;
  const s = Number(step);
  if (!(s > 0)) return qty;
  const n = Math.floor(qty / s + 1e-9);
  return Number((n * s).toFixed(stepDecimals(s)));
}

function hold(base: Omit<HedgePlan, "side" | "quantity" | "reduceOnly" | "reason" | "notionalAfterUsd">, reason: string, price: number): HedgePlan {
  return { ...base, side: null, quantity: 0, reduceOnly: false, reason, notionalAfterUsd: base.existingShortQty * Math.max(0, price) };
}

export function hedgePlan(i: HedgeInput, settings: HedgeSettings = hedgeSettings()): HedgePlan {
  const pool = poolId(i.pool);
  const symbol = i.symbol ?? i.market?.symbol ?? perpSymbolForPool(i.pool);
  const price = Number.isFinite(i.basePrice) ? i.basePrice : 0;
  const existing = Math.max(0, Number.isFinite(i.existingShortQty) ? i.existingShortQty : 0);
  const target = Math.max(0, Number.isFinite(i.baseInventory) ? i.baseInventory : 0);
  const minUsd = i.minRebalanceUsd ?? settings.minRebalanceUsd;
  const maxUsd = i.maxNotionalUsd ?? settings.maxNotionalUsd;
  const step = i.stepSize ?? i.market?.filters.stepSize ?? null;
  const minQty = Number(i.minQuantity ?? i.market?.filters.minQuantity ?? 0) || 0;

  const base = { pool, symbol, targetShortQty: target, existingShortQty: existing, deltaQty: target - existing, deltaUsd: Math.abs(target - existing) * price };

  if (!symbol) return hold(base, "no perp symbol for this pool (base is not an xStock)", price);
  if (!(price > 0)) return hold(base, "no price for the base token", price);
  if (!(maxUsd > 0)) {
    const note = existing > 0 ? `; an existing short of ${existing} is left alone` : "";
    return hold(base, `hedging off (HEDGE_MAX_NOTIONAL_USD=0)${note}`, price);
  }

  // the cap bounds the short we may hold; reductions are always allowed (they lower risk)
  const cappedTarget = Math.min(target, maxUsd / price);
  const delta = cappedTarget - existing;
  const deltaUsd = Math.abs(delta) * price;
  if (deltaUsd < minUsd) {
    return hold(base, `delta ${delta >= 0 ? "+" : ""}${delta.toFixed(4)} (${deltaUsd.toFixed(2)} USD) is below the ${minUsd} USD rebalance floor`, price);
  }

  const reduceOnly = delta < 0;
  let quantity = roundToStep(Math.abs(delta), step);
  if (reduceOnly) quantity = Math.min(quantity, existing);
  if (!(quantity > 0) || (minQty > 0 && quantity < minQty)) {
    return hold(base, `delta ${Math.abs(delta).toFixed(6)} rounds to ${quantity} at step ${step ?? "?"} (min ${minQty || "?"}): nothing to send`, price);
  }
  const after = reduceOnly ? existing - quantity : existing + quantity;
  const capNote = cappedTarget < target ? ` (target ${target.toFixed(4)} capped to ${cappedTarget.toFixed(4)} by HEDGE_MAX_NOTIONAL_USD=${maxUsd})` : "";
  const reason = reduceOnly
    ? `inventory fell to ${target.toFixed(4)}: buy back ${quantity} of the ${existing} short (reduceOnly)${capNote}`
    : `inventory ${target.toFixed(4)} vs short ${existing}: sell ${quantity} more perp${capNote}`;
  return {
    ...base,
    side: reduceOnly ? "Bid" : "Ask",
    quantity,
    reduceOnly,
    reason,
    notionalAfterUsd: after * price,
  };
}

/**
 * Funding paid over `hours` on a perp notional, in USD (positive = the position pays).
 * Backpack's rate is what longs pay shorts per interval, so a short (the hedge, default) is paid
 * when the rate is positive: its cost is -notional x rate x hours.
 */
export function fundingCostUsd(notionalUsd: number, ratePerHour: number, hours: number, side: "short" | "long" = "short"): number {
  const paidByLong = notionalUsd * ratePerHour * hours;
  return side === "long" ? paidByLong : -paidByLong;
}

/** Base tokens in a band incl. unclaimed base fees (the quote side is whichever side the snapshot says). */
export function baseInventoryOf(position: Pick<PositionSnapshot, "amountX" | "amountY" | "feeX" | "feeY">, snapshot: Pick<PoolSnapshot, "solSide" | "quoteSide">): number {
  const quoteSide: "X" | "Y" = snapshot.quoteSide ?? (snapshot.solSide === "X" ? "X" : "Y");
  return quoteSide === "X" ? position.amountY + position.feeY : position.amountX + position.feeX;
}

/** The short held on a symbol from Backpack positions (netQuantity < 0), as a positive number. */
export function shortQtyOf(positions: { symbol: string; netQuantity: number }[], symbol: string): number {
  const p = positions.find((x) => x.symbol === symbol);
  return p && p.netQuantity < 0 ? -p.netQuantity : 0;
}
