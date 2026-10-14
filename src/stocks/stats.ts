/**
 * THE STOCK DESK'S CONTRACT (14 Oct 2026). Zach: "lets start steps 1 & 2": a stocks-only Mr Bands that picks its pools
 * each week by how far their fees exceed the cost of their price moves (step 1, Meteora), and that can work Raydium CLMM
 * pools in paper (step 2). Both venues feed the same weekly ranking through this one shape, so neither knows the other.
 *
 * Why this ranking: an out-of-sample test over 22 weeks (scratchpad selection study, 14 Oct) found that choosing the top
 * stock pools by their trailing week's fee-to-cost ratio was the only rule that stayed positive (+0.05%/day median,
 * +0.14% mean, 77% of weeks), where the desk's old rule (raw fee/TVL) had fat losing tails. The cost of an LP position is
 * its loss-versus-rebalancing: about sigma^2 / 2 times the dollar depth in range per unit of relative price move.
 */
import type { VenueId } from "../venues/types";
import type { StockIssuer } from "../screener/types";

/** One tokenized-stock pool as the weekly ranking reads it, whatever its venue. */
export interface StockPoolStats {
  venue: VenueId;
  address: string;
  /** "NVDAx/SOL": the stock first */
  label: string;
  baseMint: string;
  /** the underlying ticker, "NVDA" */
  ticker: string;
  issuer: StockIssuer;
  quoteSymbol: "SOL" | "USDC";
  tvlUsd: number;
  /** fees paid to liquidity providers over the trailing window, USD, after the venue's protocol share */
  lpFeesUsd: number;
  /** the window lpFeesUsd and sigmaDaily cover, days (7 for the weekly rule) */
  windowDays: number;
  /** daily volatility of the pool's own price (stock in its quote) over the window, a fraction (0.027 = 2.7%); null when unread */
  sigmaDaily: number | null;
  /**
   * the dollar depth the pool holds per unit of relative price move at the current price (its in-range liquidity), USD;
   * the cost of being an LP there is about sigma^2 / 2 x this per day. null when unread.
   */
  depthUsdPerUnit: number | null;
  /** the Token-2022 transfer fee on the stock's mint, basis points (0 = none); such pools are never seated */
  transferFeeBps: number;
  /** when these figures were read, epoch ms */
  asOf: number;
}

/** A venue's reader of the stock pools it lists. */
export interface StockPoolSource {
  venue: VenueId;
  read(now: number): Promise<StockPoolStats[]>;
}

/**
 * PURE. Fees per day over the cost of the price moves per day. Above 1 the pool paid its LPs more than its moves cost
 * them over the window. null when any input is missing or not positive.
 */
export function feeToCostRatio(s: Pick<StockPoolStats, "lpFeesUsd" | "windowDays" | "sigmaDaily" | "depthUsdPerUnit">): number | null {
  const { lpFeesUsd, windowDays, sigmaDaily, depthUsdPerUnit } = s;
  if (!(windowDays > 0) || !(lpFeesUsd >= 0) || sigmaDaily === null || depthUsdPerUnit === null) return null;
  const costPerDay = (sigmaDaily * sigmaDaily * depthUsdPerUnit) / 2;
  if (!(costPerDay > 0)) return null;
  return lpFeesUsd / windowDays / costPerDay;
}
