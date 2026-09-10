/**
 * Mr Bands' pool score, 0..100. Explainable on purpose: fee yield is the engine,
 * liquidity, age and volatility are the brakes. Flags say why.
 */
import type { ScreenedPool } from "./types";

const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));

export function scorePool(p: Omit<ScreenedPool, "score" | "flags" | "rank">): { score: number; flags: string[] } {
  const flags: string[] = [];
  const liq = p.tvlUsd ?? 0;
  const feeToTvl = p.feeToTvl24hPct;
  if (feeToTvl === null || p.volume24hUsd === null) {
    flags.push("no-24h-data");
    return { score: 0, flags };
  }
  // 30% fee/TVL a day scores 1.0; 3% about 0.4. Log scale so degen outliers don't swamp the board.
  const sFee = clamp(Math.log10(1 + feeToTvl) / Math.log10(31));
  // $5k liquidity scores 0, $200k and above scores 1.
  const sLiq = clamp(Math.log10(Math.max(liq, 1) / 5000) / Math.log10(40));
  const age = p.ageHours;
  const sAge = age === null ? 0.8 : age < 6 ? 0.2 : age < 24 ? 0.6 : 1;
  const move = Math.abs(p.priceChange24hPct ?? 0);
  const sVol = move > 80 ? 0.1 : move > 40 ? 0.3 : move > 15 ? 0.7 : 1;
  const sBalance = p.quoteShare < 0.03 || p.quoteShare > 0.97 ? 0.5 : 1;

  if (liq < 20_000) flags.push("thin");
  if (age !== null && age < 24) flags.push("new");
  if (move > 40) flags.push("volatile");
  if (feeToTvl > 20) flags.push("hot");
  if (sBalance < 1) flags.push("one-sided");
  if (p.feesSource === "onchain") flags.push("onchain-fees");

  const score = 100 * sFee * (0.5 + 0.5 * sLiq) * sAge * sVol * sBalance;
  return { score: Math.round(score * 10) / 10, flags };
}
