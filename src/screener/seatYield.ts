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
  const theirsPerBinQuote = covered.length ? covered.reduce((t, b) => t + binQuote(b, i.quoteSide, i.tokenPriceInQuote), 0) / covered.length : 0;
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
  };
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
  /** where the pool's fee figure came from */
  feeSource: "flow-60m" | "24h";
}

export interface HeldSeat {
  address: string;
  label: string;
  /** the seat's expected yield at its actual band, percent a day */
  yieldPctPerDay: number;
  openedAt: number | null;
  pinned: boolean;
}

export interface SeatRankingEnv {
  /** a candidate under this yield is not worth a seat (METEORA_STOCK_MIN_SEAT_YIELD_PCT) */
  minYieldPct: number;
  /** a held seat under the floor makes way when a candidate beats it by this factor (METEORA_STOCK_ROTATE_FACTOR) */
  rotateFactor: number;
  /** a band younger than this is not rotated (PIN_ROTATE_MIN_AGE_MIN) */
  minAgeMin: number;
}

export interface SeatRotation {
  pool: string;
  label: string;
  reason: string;
}

/** PURE. Candidates worth a seat, best first. */
export function rankSeats(candidates: readonly RankedSeat[], env: SeatRankingEnv): RankedSeat[] {
  return [...candidates].filter((c) => c.yieldPctPerDay >= env.minYieldPct).sort((a, b) => b.yieldPctPerDay - a.yieldPctPerDay);
}

/**
 * PURE. The held seat to give up, if any: the weakest, older than the minimum, not pinned, when the
 * best candidate not already held beats it by the factor (against the floor when the seat is under
 * it). Zach (2026-09-17): "I want to really focus on entering the highest earning pool", so a seat
 * that earns is still given up when something earns clearly more. One per cycle.
 */
export function weakSeatRotation(held: readonly HeldSeat[], ranked: readonly RankedSeat[], env: SeatRankingEnv, now: number): SeatRotation | null {
  const heldAddrs = new Set(held.map((h) => h.address));
  const best = ranked.find((c) => !heldAddrs.has(c.address));
  if (!best) return null;
  const eligible = held.filter((h) => !h.pinned && (h.openedAt === null || now - h.openedAt >= env.minAgeMin * 60_000));
  if (!eligible.length) return null;
  const weakest = eligible.reduce((w, h) => (h.yieldPctPerDay < w.yieldPctPerDay ? h : w));
  const bar = Math.max(env.minYieldPct, weakest.yieldPctPerDay) * env.rotateFactor;
  if (best.yieldPctPerDay < bar) return null;
  const under = weakest.yieldPctPerDay < env.minYieldPct;
  return {
    pool: weakest.address,
    label: weakest.label,
    reason: `${weakest.label} earns about ${weakest.yieldPctPerDay.toFixed(2)}% a day on its seat${under ? `, under the ${env.minYieldPct}% floor` : ""}, while ${best.label} would earn about ${best.yieldPctPerDay.toFixed(2)}% (${best.sharePct.toFixed(1)}% of its bins, ${best.feeSource === "flow-60m" ? "the last hour's fees" : "the day's fees"}), ${(best.yieldPctPerDay / Math.max(weakest.yieldPctPerDay, 1e-9)).toFixed(1)}x as much`,
  };
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function seatRankingEnv(env: NodeJS.ProcessEnv = process.env): SeatRankingEnv & { rankTop: number } {
  return {
    minYieldPct: Math.max(0, num(env.METEORA_STOCK_MIN_SEAT_YIELD_PCT, 1)),
    rotateFactor: Math.max(1, num(env.METEORA_STOCK_ROTATE_FACTOR, 2)),
    minAgeMin: Math.max(0, num(env.PIN_ROTATE_MIN_AGE_MIN, 60)),
    rankTop: Math.max(1, Math.floor(num(env.METEORA_STOCK_RANK_TOP, 8))),
  };
}

/** One line per pool for the log. */
export const seatLine = (r: RankedSeat): string =>
  `${r.label}: ${r.yieldPctPerDay.toFixed(2)}%/day on the seat (${r.sharePct.toFixed(1)}% of its bins, ${r.feesPerDayQuote.toFixed(r.quoteSymbol === "SOL" ? 3 : 1)} ${r.quoteSymbol}/day, ${r.feeSource === "flow-60m" ? "last hour" : "24h"})`;
