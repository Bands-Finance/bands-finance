/**
 * PRICE IMPACT FOR A PAPER SWAP, from the pool's own bins. Until 22 Sep a paper leg paid the swap fee and nothing
 * else: 0.44% on 1,927 SOL of paper legs, while his real legs of 2.5-5 SOL cost 0.59-1.03% (the 22 Sep test
 * rounds). A swap walks the snapshot's bins away from the price, one bin step at a time, taking what each bin
 * holds; past the last bin the snapshot carries it assumes more bins like the ones it saw. Only this pool's bins
 * count, the rule swapDepthWithin (src/screener/seatYield.ts) already uses: a deeper route elsewhere is a bonus,
 * not a plan, so paper errs on the side of costing a little more than a real route, never less.
 */
import type { BinRow } from "../tools/dlmm";

/** The farthest a walk goes, in bins; whatever is left fills at that bin's price. */
export const MAX_WALK_BINS = 400;

export interface ImpactInput {
  bins: readonly Pick<BinRow, "binId" | "xAmount" | "yAmount">[];
  activeBinId: number;
  /** which side of the pool is the quote (SOL or USDC) */
  quoteSide: "X" | "Y";
  binStepBps: number;
  /** the base token in quote units at the active bin */
  tokenPriceInQuote: number;
}

/**
 * PURE. The average price a swap of `amountToken` base tokens gets against the active price, as a percent against
 * the trader: a buy pays that much more per token, a sell receives that much less. 0 for a swap the active bin
 * absorbs whole.
 */
export function binWalkImpactPct(i: ImpactInput, side: "buy" | "sell", amountToken: number): number {
  if (!(amountToken > 0) || !(i.tokenPriceInQuote > 0) || !Number.isFinite(amountToken)) return 0;
  const step = Math.max(1, i.binStepBps) / 10_000;
  // the token sits above the active bin when the quote is Y; a buy walks toward the token, a sell toward the quote
  const up = side === "buy" ? i.quoteSide === "Y" : i.quoteSide === "X";
  const byId = new Map(i.bins.map((b) => [b.binId, b]));
  const ids = i.bins.map((b) => b.binId);
  const lo = ids.length ? Math.min(...ids) : i.activeBinId;
  const hi = ids.length ? Math.max(...ids) : i.activeBinId;
  const seen: number[] = [];
  let remaining = amountToken;
  let weighted = 0;
  let factor = 1;
  for (let d = 0; d <= MAX_WALK_BINS && remaining > 0; d++) {
    const id = up ? i.activeBinId + d : i.activeBinId - d;
    // a buy pushes the token's price up a step per bin, a sell pushes it down
    factor = side === "buy" ? Math.pow(1 + step, d) : Math.pow(1 + step, -d);
    let cap: number;
    const b = byId.get(id);
    if (b) {
      const tokenAmt = i.quoteSide === "Y" ? b.xAmount : b.yAmount;
      const quoteAmt = i.quoteSide === "Y" ? b.yAmount : b.xAmount;
      cap = side === "buy" ? tokenAmt : quoteAmt / (i.tokenPriceInQuote * factor);
      if (cap > 0) seen.push(cap);
    } else if (id >= lo && id <= hi) {
      cap = 0; // an empty bin inside the snapshot
    } else {
      cap = seen.length ? seen.reduce((a, c) => a + c, 0) / seen.length : 0; // past the snapshot: more bins like the ones seen
    }
    const take = Math.min(remaining, Math.max(0, cap));
    weighted += take * factor;
    remaining -= take;
  }
  if (remaining > 0) weighted += remaining * factor; // past the walk's reach: the rest at the last price
  const avg = weighted / amountToken;
  return side === "buy" ? Math.max(0, (avg - 1) * 100) : Math.max(0, (1 - avg) * 100);
}
