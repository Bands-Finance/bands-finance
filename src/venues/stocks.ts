/**
 * The stock book (BOOK=stocks): which board rows the picker seats first. Tokenized-stock pools on
 * a tradable venue, SOL- or USDC-quoted (USDC only when a SOL price is known), with at least
 * STOCK_MIN_LIQUIDITY_USD of liquidity and 24h data, best fee/TVL first. Pure.
 */
import type { ScreenedPool } from "../screener/types";
import { verifiedStock } from "../screener/stocks";
import { isTradableVenue, stockMinLiquidityUsd } from "./env";

export function stockBookPools(pools: readonly ScreenedPool[], usdcOk: boolean, minLiquidityUsd: number = stockMinLiquidityUsd(), env: NodeJS.ProcessEnv = process.env): ScreenedPool[] {
  return pools
    .filter(
      (p) =>
        verifiedStock(p.stock) &&
        isTradableVenue(p.venue, env) &&
        (p.quoteSymbol === "SOL" || (p.quoteSymbol === "USDC" && usdcOk)) &&
        (p.tvlUsd ?? 0) >= minLiquidityUsd &&
        !p.flags.includes("thin") &&
        !p.flags.includes("no-24h-data"),
    )
    .sort((a, b) => (b.feeToTvl24hPct ?? -1) - (a.feeToTvl24hPct ?? -1) || (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
}
