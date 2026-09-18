/**
 * SEAT YIELD: what a seat of OUR size would earn in a pool, per SOL of our own liquidity, per day.
 * Zach (2026-09-17): "make sure we are either creating our own pool to earn maximum fees or we are
 * in a pool with high volume." The first live hour showed why fee-on-TVL is the wrong ranking: MCDx/SOL
 * had $436k of daily volume and paid the desk 0.7% of the fees that crossed its band, because 5 SOL
 * over 31 bins is 0.16 SOL a bin in a pool holding 21 SOL a bin, at a 0.15% fee. MRVL/SOL, a tenth
 * of the volume at a 1.5% fee with 10 SOL a bin, was a 10% share. The number that decides is
 *
 *   fees a day the pool pays  x  our share of the liquidity where the trades happen  /  our seat
 *
 * with the pool's fees from the flow scout's last hour when it has one (src/scouts/flow.ts), else
 * the day's figure, and the share from the bins around the price as the chain shows them. Pure.
 */

export interface SeatYieldInput {
  /** the seat in quote units (both halves of a straddle) */
  seatQuote: number;
  /** bins on each side of the active bin the band would cover */
  binsEachSide: number;
  activeBinId: number;
  /** the bins around the active one, as the snapshot reads them */
  bins: readonly { binId: number; xAmount: number; yAmount: number }[];
  quoteSide: "X" | "Y";
  /** base token in quote units */
  tokenPriceInQuote: number;
  /** the pool's LP fees a day, quote units */
  poolFeesPerDayQuote: number;
  /** a HELD seat: our own liquidity per bin already inside `bins`, quote units; it is taken out of "theirs" (absent: 0) */
  ownPerBinQuote?: number;
}

export interface SeatYield {
  /** our liquidity per bin over the liquidity per bin already there, percent */
  sharePct: number;
  /** what the seat earns a day at that share while in range, quote units */
  feesPerDayQuote: number;
  /** on the seat, percent a day */
  yieldPctPerDay: number;
  /** liquidity per bin already in the band's bins (mean), quote units */
  theirsPerBinQuote: number;
  oursPerBinQuote: number;
  activeBinQuote: number;
  /** liquidity already in the bins the band would cover, quote units (the policy's depth cap is half of it) */
  bandDepthQuote: number;
}

/** PURE. A bin's liquidity in quote units. */
export const binQuote = (b: { xAmount: number; yAmount: number }, quoteSide: "X" | "Y", tokenPriceInQuote: number): number =>
  quoteSide === "Y" ? b.yAmount + b.xAmount * tokenPriceInQuote : b.xAmount + b.yAmount * tokenPriceInQuote;

/**
 * PURE. Our share is our liquidity per bin against the mean liquidity per bin over the bins the
 * band would cover (the active bin alone is one reading; the price walks). Fees follow the share.
 */
export function seatYield(i: SeatYieldInput): SeatYield {
  const width = 2 * Math.max(0, Math.floor(i.binsEachSide)) + 1;
  const oursPerBinQuote = i.seatQuote > 0 ? i.seatQuote / width : 0;
  const inBand = i.bins.filter((b) => Math.abs(b.binId - i.activeBinId) <= i.binsEachSide);
  const covered = inBand.length ? inBand : i.bins.filter((b) => b.binId === i.activeBinId);
  const seenPerBinQuote = covered.length ? covered.reduce((t, b) => t + binQuote(b, i.quoteSide, i.tokenPriceInQuote), 0) / covered.length : 0;
  const theirsPerBinQuote = Math.max(0, seenPerBinQuote - Math.max(0, i.ownPerBinQuote ?? 0));
  const active = i.bins.find((b) => b.binId === i.activeBinId);
  const activeBinQuote = active ? binQuote(active, i.quoteSide, i.tokenPriceInQuote) : theirsPerBinQuote;
  const share = oursPerBinQuote > 0 ? oursPerBinQuote / (theirsPerBinQuote + oursPerBinQuote) : 0;
  const feesPerDayQuote = Math.max(0, i.poolFeesPerDayQuote) * share;
  return {
    sharePct: share * 100,
    feesPerDayQuote,
    yieldPctPerDay: i.seatQuote > 0 ? (feesPerDayQuote / i.seatQuote) * 100 : 0,
    theirsPerBinQuote,
    oursPerBinQuote,
    activeBinQuote,
    bandDepthQuote: theirsPerBinQuote * width,
  };
}

/**
 * PURE. The token liquidity, in quote units, within `maxImpactPct` of the price: the active bin's own
 * token side plus the bins on the token side whose price is inside the cap (one bin step per bin).
 * A buy of the seat's token half that must empty more bins than that moves the price past the cap;
 * the seat is capped at twice this so the half fits (MRVL/SOL took 3.5% of impact on a 2.5 SOL buy,
 * 2026-09-17). Only this pool's bins count: a deeper route elsewhere is a bonus, not a plan.
 */
export function swapDepthWithin(bins: readonly { binId: number; xAmount: number; yAmount: number }[], activeBinId: number, quoteSide: "X" | "Y", tokenPriceInQuote: number, binStepBps: number, maxImpactPct: number): number {
  const step = Math.max(1, binStepBps) / 10_000;
  const maxBins = Math.max(0, Math.floor(Math.log(1 + Math.max(0, maxImpactPct) / 100) / Math.log(1 + step)));
  // the token sits above the active bin when the quote is Y (bins above hold X), below when the quote is X
  const tokenAbove = quoteSide === "Y";
  let total = 0;
  for (const b of bins) {
    const d = tokenAbove ? b.binId - activeBinId : activeBinId - b.binId;
    if (d < 0 || d > maxBins) continue;
    total += (quoteSide === "Y" ? b.xAmount : b.yAmount) * tokenPriceInQuote;
  }
  return total;
}

/* ---------- ranking and rotation ---------- */

export interface RankedSeat {
  address: string;
  label: string;
  /** the token's mint, for the one-seat-per-token rule */
  mint: string;
  yieldPctPerDay: number;
  sharePct: number;
  feesPerDayQuote: number;
  quoteSymbol: string;
  /** where the pool's fee figure came from: the flow scout's own reading (its four hours, or its hour while coverage is short), or the venue's 24h figure */
  feeSource: "flow-4h" | "flow-60m" | "24h";
  /** the seat the desk could hold there, SOL: the max band or half the band's depth, whichever is less */
  capSol: number;
  /** a tokenized-stock pool (the stock lane's rotation factor applies), else a memecoin */
  stock?: boolean;
}

export interface HeldSeat {
  address: string;
  label: string;
  /** the seat's expected yield at its actual band, percent a day */
  yieldPctPerDay: number;
  openedAt: number | null;
  pinned: boolean;
  /** the seat the desk could hold there, SOL (see RankedSeat.capSol) */
  capSol: number;
  /** what the seat holds now, SOL; null before the cycle has observed it */
  heldSol: number | null;
  /** where the seat's fee figure came from; "24h" means the scout has not read the pool (yet) */
  feeSource: RankedSeat["feeSource"];
  /** a tokenized-stock pool, else a memecoin */
  stock?: boolean;
}

export interface SeatRankingEnv {
  /** a candidate under this yield is not worth a seat (METEORA_STOCK_MIN_SEAT_YIELD_PCT) */
  minYieldPct: number;
  /** a held stock seat makes way when a candidate beats it by this factor (METEORA_STOCK_ROTATE_FACTOR) */
  rotateFactor: number;
  /** the same for a memecoin seat (MEME_ROTATE_FACTOR): memecoin seats earn 50-150% a day, so three times is never reached */
  memeRotateFactor: number;
  /** a band younger than this is not rotated (PIN_ROTATE_MIN_AGE_MIN) */
  minAgeMin: number;
  /** a pool the ranking gave up sits out this long before it may be seated again (METEORA_STOCK_REENTRY_MIN) */
  reentryMin: number;
}

/** PURE. Whether a pool given up at `rotatedOutAt` is still sitting out. */
export const sittingOut = (rotatedOutAt: number | null | undefined, env: Pick<SeatRankingEnv, "reentryMin">, now: number): boolean =>
  typeof rotatedOutAt === "number" && now - rotatedOutAt < env.reentryMin * 60_000;

export interface SeatRotation {
  pool: string;
  label: string;
  reason: string;
}

/** PURE. Candidates worth a seat, best first. */
/** The factor a seat must be beaten by: the stock lane's when either side is a stock pool, else the memecoin one. */
export const rotateFactorFor = (env: Pick<SeatRankingEnv, "rotateFactor" | "memeRotateFactor">, stock: boolean | undefined): number => (stock ? env.rotateFactor : env.memeRotateFactor);

export function rankSeats(candidates: readonly RankedSeat[], env: SeatRankingEnv): RankedSeat[] {
  return [...candidates].filter((c) => c.yieldPctPerDay >= env.minYieldPct).sort((a, b) => b.yieldPctPerDay - a.yieldPctPerDay);
}

/**
 * PURE. The held seat to give up, if any: the weakest, older than the minimum, not pinned, when the
 * best candidate not already held beats it by the factor (against the floor when the seat is under
 * it). Zach (2026-09-17): "I want to really focus on entering the highest earning pool", so a seat
 * that earns is still given up when something earns clearly more. One per cycle.
 *
 * Only a candidate the flow scout has read counts: the venue's 24h figure said DKNG/SOL would pay
 * 51% a day on the seat, and the scout's first hour of it said 1.7% (2026-09-17, pre-market). A
 * candidate the scout has not read yet is on the watch list from this cycle, so the next ranking has it.
 */
export function weakSeatRotation(held: readonly HeldSeat[], ranked: readonly RankedSeat[], env: SeatRankingEnv, now: number): SeatRotation | null {
  const heldAddrs = new Set(held.map((h) => h.address));
  const best = ranked.find((c) => !heldAddrs.has(c.address) && c.feeSource !== "24h");
  if (!best) return null;
  const eligible = held.filter((h) => !h.pinned && (h.openedAt === null || now - h.openedAt >= env.minAgeMin * 60_000));
  if (!eligible.length) return null;
  const weakest = eligible.reduce((w, h) => (h.yieldPctPerDay < w.yieldPctPerDay ? h : w));
  const factor = rotateFactorFor(env, weakest.stock || best.stock);
  const bar = Math.max(env.minYieldPct, weakest.yieldPctPerDay) * factor;
  if (best.yieldPctPerDay < bar) return null;
  const under = weakest.yieldPctPerDay < env.minYieldPct;
  return {
    pool: weakest.address,
    label: weakest.label,
    reason: `${weakest.label} earns about ${weakest.yieldPctPerDay.toFixed(2)}% a day on its seat${under ? `, under the ${env.minYieldPct}% floor` : ""}, while ${best.label} would earn about ${best.yieldPctPerDay.toFixed(2)}% (${best.sharePct.toFixed(1)}% of its bins, ${feeSourceWord(best.feeSource)}), ${(best.yieldPctPerDay / Math.max(weakest.yieldPctPerDay, 1e-9)).toFixed(1)}x as much`,
  };
}

/**
 * PURE. CONSOLIDATION: when the best seat the desk holds could hold more (its cap is at least
 * minGrowSol above what it holds) and another seat earns under a factor of it, that seat is given up
 * so the money moves to the best one (the policy's grow rule re-lays it bigger next cycle). The
 * weakest first, one per cycle; pins and young bands stay; a best seat under the floor grows nothing.
 */
export function consolidation(held: readonly HeldSeat[], env: SeatRankingEnv, now: number, minGrowSol: number): SeatRotation | null {
  const known = held.filter((h) => h.heldSol !== null);
  if (known.length < 2) return null;
  const best = known.reduce((b, h) => (h.yieldPctPerDay > b.yieldPctPerDay ? h : b));
  if (best.yieldPctPerDay < env.minYieldPct) return null;
  const roomSol = best.capSol - (best.heldSol ?? 0);
  if (roomSol < minGrowSol) return null;
  const eligible = known.filter((h) => h !== best && !h.pinned && (h.openedAt === null || now - h.openedAt >= env.minAgeMin * 60_000) && h.yieldPctPerDay * rotateFactorFor(env, h.stock || best.stock) <= best.yieldPctPerDay);
  if (!eligible.length) return null;
  const weakest = eligible.reduce((w, h) => (h.yieldPctPerDay < w.yieldPctPerDay ? h : w));
  return {
    pool: weakest.address,
    label: weakest.label,
    reason: `${weakest.label} earns about ${weakest.yieldPctPerDay.toFixed(2)}% a day on its seat while ${best.label}, already held, earns about ${best.yieldPctPerDay.toFixed(2)}% and could hold ${roomSol.toFixed(1)} SOL more (${(best.heldSol ?? 0).toFixed(1)} of ${best.capSol.toFixed(1)} SOL); the money goes there`,
  };
}

/**
 * PURE. Whether a held seat's own measured flow says it has faded: its yield (the pool's fees over the
 * scout's window x our share of the band / the seat) under `fadeFactor` x the floor for `cyclesNeeded`
 * consecutive readings, on a band old enough to judge. Zach (2026-09-17): "we need to be sure we are
 * rebalancing and monitoring volume based on data accumulated on the specific token we are currently in".
 */
export function seatFaded(i: { yieldPctPerDay: number; floorPct: number; fadeFactor: number; streak: number; cyclesNeeded: number; ageOk: boolean }): boolean {
  return i.ageOk && i.floorPct > 0 && i.yieldPctPerDay < i.floorPct * i.fadeFactor && i.streak >= i.cyclesNeeded;
}

export const feeSourceWord = (f: RankedSeat["feeSource"]): string => (f === "flow-4h" ? "the last four hours' fees" : f === "flow-60m" ? "the last hour's fees" : "the day's fees");

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function seatRankingEnv(env: NodeJS.ProcessEnv = process.env): SeatRankingEnv & { rankTop: number } {
  return {
    minYieldPct: Math.max(0, num(env.METEORA_STOCK_MIN_SEAT_YIELD_PCT, 1)),
    rotateFactor: Math.max(1, num(env.METEORA_STOCK_ROTATE_FACTOR, 2)),
    memeRotateFactor: Math.max(1, num(env.MEME_ROTATE_FACTOR, 1.5)),
    minAgeMin: Math.max(0, num(env.PIN_ROTATE_MIN_AGE_MIN, 60)),
    reentryMin: Math.max(0, num(env.METEORA_STOCK_REENTRY_MIN, 60)),
    rankTop: Math.max(1, Math.floor(num(env.METEORA_STOCK_RANK_TOP, 8))),
  };
}

/** One line per pool for the log. */
export const seatLine = (r: RankedSeat): string =>
  `${r.label}: ${r.yieldPctPerDay.toFixed(2)}%/day on the seat (${r.sharePct.toFixed(1)}% of its bins, ${r.feesPerDayQuote.toFixed(r.quoteSymbol === "SOL" ? 3 : 1)} ${r.quoteSymbol}/day, ${r.feeSource === "flow-4h" ? "last 4h" : r.feeSource === "flow-60m" ? "last hour" : "24h"})`;
