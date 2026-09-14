/**
 * The desk policy: a deterministic proposer that stands in for the LLM when no Anthropic key is
 * configured or the call fails (src/agent/decide.ts). Same contract as the model: one Decision
 * from one Observation, and the guards still decide. Every figure in its reasoning comes from
 * the observation; nothing is invented.
 *
 *   band open, in range                      HOLD
 *   band open, price through it (token now)  CLOSE once out of range >= the engine minimum,
 *                                            unless the pool is still on the hot list (HOLD one more cycle)
 *   band open, price above it (idle quote)   REBALANCE to a fresh quote-only band under the price
 *                                            once idle >= 3x the minimum
 *   no band                                  OPEN a quote-only Spot band under the active bin covering
 *                                            POLICY_COVER_PCT of price (default 5%), sized at
 *                                            min(effective max band, 95% of the wallet's quote, half the
 *                                            band's depth), only for a hot pick or a screen score above
 *                                            POLICY_MIN_SCORE (default 20), with the last hour inside
 *                                            +/-15% and no thin/new/dumping/wild flag; else HOLD, with why
 *
 * The engine's gates (halt, stand-down, bench, regime, knife, basis, cooldown, daily cap, pool cap)
 * are checked first so the policy holds with the reason instead of proposing into a veto.
 *
 * Stock pools (src/basis; the screen's stock tag or a basis row) are worked as STRADDLES, not as
 * quote-only bids: Zach's 10,000 USDC paper run left three of four one-sided bands idle under the
 * price for a whole session. A stock band is BOTH, centred on the active bin, half quote and half
 * stock token, so it earns on every tick in either direction; the token leg is hedged short on
 * Backpack's perp (src/engine/hedgeDesk.ts) so the fees are earned delta-neutral.
 *   width    binsBelow = binsAbove = the bins covering STOCK_COVER_PCT of price (default 1.5%) x the
 *            US session's width multiplier (regular 1, pre/after 1.5, closed 2), each side capped so
 *            the whole band fits MAX_BIN_WIDTH
 *   seat     S quote units = min(effective max band, what the wallet can fund (the quote half plus
 *            the purchase of the token half it does not hold, at MAX_SLIPPAGE_PCT), both sides'
 *            depth (share <= 50%), exposure room); amountSol = S/2, amountToken = S/2 / price,
 *            acquireToken = the token half less what the wallet (and a closing band) already holds
 *   in range HOLD; out of range for the engine minimum: REBALANCE to a fresh straddle around the
 *            new price when the gates allow (the executor buys the shortfall or sells the surplus
 *            after the close), else CLOSE with liquidate: true so the book returns to USDC
 * Opens are refused when the basis verdict says so (openGate). On the stock book (BOOK=stocks) a
 * tokenized-stock pool is worth a band without a hot row or a score.
 * Venues: the open cost comes from the venue (extras.openCostSol; Meteora's estimate by default).
 * On a CLMM pool a quote-only band rests one bin under the price by construction, so one bin of
 * distance on the quote side is "resting", not idle (non-stock pools).
 */
import { sessionClock } from "../basis/session";
import { sessionWidthMultiplier } from "../basis/verdict";
import type { HotRow } from "../hot/types";
import { bandDepthQuote, shareOfBand } from "../paper/mark";
import type { RiskLimits } from "../risk/limits";
import { OPEN_COST_ESTIMATE_SOL, POSITION_RENT_SOL, quoteOf, type PositionSnapshot, type QuoteView } from "../tools/dlmm";
import { jupiterEnv } from "../tools/jupiter";
import { bookEnv, type Book } from "../venues/env";
import type { Observation } from "./observation";
import { holdDecision, type Decision, type OpenParams } from "./schema";

export interface PolicyEnv {
  /** how far past the active bin a fresh band reaches, in percent of price */
  coverPct: number;
  /** stock straddles: how far EACH side of the active bin reaches, in percent of price (STOCK_COVER_PCT) */
  stockCoverPct: number;
  /** a seat whose estimated fees are under this much per day is not worth opening (POLICY_MIN_SEAT_YIELD_PCT) */
  minSeatYieldPct: number;
  /** a pool trading less than this in 24h is not a market to make (POLICY_MIN_VOLUME_24H_USD) */
  minVolume24hUsd: number;
  /** band half-width as a multiple of the pool's last-hour move; 0 uses the configured cover (POLICY_VOL_MULTIPLE) */
  volMultiple: number;
  /** the tightest and widest the volatility-derived band may be, in percent of price each way */
  minCoverPct: number;
  maxCoverPct: number;
  /** the one-time cost of a seat (rent that never comes back plus the swap round trip) must be earned back inside this many hours (POLICY_MAX_PAYBACK_HOURS) */
  maxPaybackHours: number;
  /** a seat under this share of the book's max exposure is not worth its rent and attention (POLICY_MIN_SEAT_PCT) */
  minSeatPct: number;
  /** a pool off the hot list needs a screen score above this to get a band */
  minScore: number;
  /** "stocks": tokenized-stock pools are worth a band on their own (BOOK) */
  book: Book;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function policyEnv(env: NodeJS.ProcessEnv = process.env): PolicyEnv {
  return {
    coverPct: Math.max(0.1, num(env.POLICY_COVER_PCT, 5)),
    stockCoverPct: Math.max(0.05, num(env.STOCK_COVER_PCT, STOCK_COVER_PCT_DEFAULT)),
    minSeatPct: Math.max(0, num(env.POLICY_MIN_SEAT_PCT, 5)),
    minSeatYieldPct: Math.max(0, num(env.POLICY_MIN_SEAT_YIELD_PCT, 0.4)),
    minVolume24hUsd: Math.max(0, num(env.POLICY_MIN_VOLUME_24H_USD, 250_000)),
    volMultiple: Math.max(0, num(env.POLICY_VOL_MULTIPLE, 1)),
    minCoverPct: Math.max(0.01, num(env.POLICY_MIN_COVER_PCT, 0.15)),
    maxCoverPct: Math.max(0.02, num(env.POLICY_MAX_COVER_PCT, 4)),
    maxPaybackHours: Math.max(0, num(env.POLICY_MAX_PAYBACK_HOURS, 24)),
    minScore: num(env.POLICY_MIN_SCORE, 20),
    book: bookEnv(env),
  };
}

export const STOCK_COVER_PCT_DEFAULT = 1.5;

export const POLICY_MAX_1H_MOVE_PCT = 15;
export const POLICY_BLOCK_FLAGS = ["thin", "new", "dumping", "wild"];
/** a band smaller than this in SOL is not worth its rent */
export const MIN_BAND_SOL = 0.1;
export const WALLET_SHARE = 0.95;
/** the headline of the one-cycle hold on a hot pool under its band: the next cycle reads it back and closes */
export const HOT_HOLD_HEADLINE = "Under the band but the tape is hot. One more cycle.";
export const IDLE_MULTIPLE = 3;

export type PolicyHot = Pick<HotRow, "address" | "priceChange1hPct" | "flags" | "heat" | "surge">;

export interface PolicyExtras {
  limits: RiskLimits;
  env?: Partial<PolicyEnv>;
  /** epoch ms; defaults to the observation's timestamp */
  now?: number;
  /** the fast watch's tradable picks, for pools whose screen context is missing (off the board) */
  hot?: PolicyHot[];
  /** the venue's up-front cost of an open in SOL (rent); defaults to the Meteora estimate */
  openCostSol?: number;
  /** the refundable part of the open cost (venue rent that comes back on close) */
  openCostRefundableSol?: number;
}

export type PolicyBranch = "in-range" | "resting" | "close" | "hot-hold" | "rebalance" | "idle-wait" | "churn-wait" | "gated" | "open" | "not-worth" | "flagged" | "moved" | "no-size";

export interface PolicyResult {
  decision: Decision;
  /** one line: why */
  reason: string;
  branch: PolicyBranch;
}

/** Bins that cover coverPct of price at this bin step (x the width multiplier), inside [3, maxBinWidth - 1]. */
export function binsForCover(binStep: number, coverPct: number, maxBinWidth: number, widthMultiplier = 1): number {
  const mult = Number.isFinite(widthMultiplier) && widthMultiplier > 0 ? widthMultiplier : 1;
  const raw = Math.round((Math.log(1 + coverPct / 100) / Math.log(1 + binStep / 10_000)) * mult);
  // One bin is the floor, not three: fees accrue only to the bin the price is in, so every extra bin
  // is money standing idle. A wide band is a choice about staying in range, never a free one.
  return Math.min(Math.max(1, raw), Math.max(1, maxBinWidth - 1));
}

/** Whether the pool is a tokenized stock: the screen's stock tag, or a basis row (only stock pools carry one). */
export const isStockPool = (o: Pick<Observation, "screen" | "engine">): boolean => !!o.screen?.stock || !!o.engine?.basis;

/** Bins on EACH side of a stock straddle: coverPct of price x the width multiplier, capped so 2 x bins + 1 fits maxBinWidth, at least 1. */
export function stockBinsPerSide(binStep: number, coverPct: number, maxBinWidth: number, widthMultiplier = 1): number {
  const perSideCap = Math.max(1, Math.floor((maxBinWidth - 1) / 2));
  return Math.max(1, Math.min(binsForCover(binStep, coverPct, maxBinWidth, widthMultiplier), perSideCap));
}

/** The band-width multiplier for this pool: the US session's (src/basis) for a stock pool, 1 otherwise. */
/**
 * How wide the band should be, in percent of price each way: a multiple of what the pool actually
 * moved in the last hour, floored and capped. A stock that drifts 0.3% an hour gets a band a few bins
 * wide, where our money is a real share of the bin that earns; a memecoin swinging 20% gets a wide one,
 * because a tight band there is out of range before the transaction confirms. With no recent move to
 * read (a fresh screen, a quiet pool) the configured cover stands.
 */
export function coverPctFor(o: Pick<Observation, "screen">, env: PolicyEnv, base: number, hot: { priceChange1hPct: number | null }): { coverPct: number; from: string } {
  // The measured travel of the price in the last hour, then the hot list's 1h change: the first is the
  // range the band must survive, the second is only the net move, so it understates a pool that went
  // up and came back. Either beats a fixed percentage.
  const measured = o.screen?.recentMovePct;
  const move = typeof measured === "number" && Number.isFinite(measured) ? measured : hot.priceChange1hPct;
  if (env.volMultiple <= 0 || move === null || !Number.isFinite(move)) return { coverPct: base, from: `${r(base, 2)}% each way (configured)` };
  const raw = Math.abs(move) * env.volMultiple;
  const coverPct = Math.min(env.maxCoverPct, Math.max(env.minCoverPct, raw));
  const why =
    raw < env.minCoverPct
      ? `${r(coverPct, 2)}% each way (the floor: the price travelled ${r(Math.abs(move), 2)}% in the last hour)`
      : raw > env.maxCoverPct
        ? `${r(coverPct, 2)}% each way (the cap: the price travelled ${r(Math.abs(move), 2)}% in the last hour)`
        : `${r(coverPct, 2)}% each way (${env.volMultiple}x the ${r(Math.abs(move), 2)}% the price travelled in the last hour)`;
  return { coverPct, from: why };
}

export function widthMultiplierFor(o: Pick<Observation, "screen" | "engine">, now: number): number {
  if (!isStockPool(o)) return 1;
  const fromLoop = o.engine?.basis?.widthMultiplier;
  if (typeof fromLoop === "number" && Number.isFinite(fromLoop) && fromLoop > 0) return fromLoop;
  return sessionWidthMultiplier(sessionClock(new Date(now)));
}

export const coveragePct = (binStep: number, bins: number): number => (Math.pow(1 + binStep / 10_000, bins) - 1) * 100;

const r = (n: number, d = 4) => Number(n.toFixed(d)).toString();
const pct = (n: number, d = 1) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
const usd0 = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? "n/a" : `$${Math.round(n).toLocaleString("en-US")}`);
const clip = (s: string, n = 90) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + ".");

interface HotView {
  onList: boolean;
  priceChange1hPct: number | null;
  flags: string[];
  heat: number | null;
  surge: boolean;
}

/** This pool on the hot list: the observation's own list first, then the extras. */
function hotView(o: Observation, x: PolicyExtras): HotView {
  const mine = o.screen?.hot?.find((h) => h.thisPool);
  if (mine) return { onList: true, priceChange1hPct: mine.priceChange1hPct, flags: mine.flags, heat: mine.heat, surge: mine.surge };
  const row = x.hot?.find((h) => h.address === o.snapshot.address);
  if (row) return { onList: true, priceChange1hPct: row.priceChange1hPct, flags: row.flags, heat: row.heat, surge: row.surge };
  return { onList: false, priceChange1hPct: null, flags: [], heat: null, surge: false };
}

const hold = (reasoning: string, headline: string, branch: PolicyBranch, reason: string, confidence = 0.7): PolicyResult => ({
  decision: { ...holdDecision(reasoning, clip(headline)), confidence },
  reason,
  branch,
});

/** The engine's open gates, in the order the guards would report them. Null when opens are clear. */
function openGate(o: Observation, limits: RiskLimits, now: number): string | null {
  const e = o.engine;
  const mins = (ms: number) => Math.max(0, Math.round((ms - now) / 60000));
  if (o.state.killSwitch) return "kill switch active: no new exposure";
  if (e?.halt) return `circuit breaker halt for ${mins(e.halt.until)} more min`;
  if (e?.standDown) return `portfolio breaker stand-down for ${mins(e.standDown.until)} more min`;
  if (e?.bench.benched) return e.bench.reason ?? "benched after repeated stops";
  if (e && e.sizeMultiplier <= 0) return e.regime.reason ?? "regime: opens off";
  if (e?.knife) return e.knife;
  if (e?.basis?.reason) return e.basis.reason;
  if (o.state.actionsToday >= limits.maxTxPerDay) return `daily action cap reached (${o.state.actionsToday}/${limits.maxTxPerDay})`;
  if (o.state.lastMoveAt !== null && o.state.lastMoveAt !== undefined) {
    const since = (now - o.state.lastMoveAt) / 1000;
    if (since < limits.minSecondsBetweenActions) return `cooldown: ${Math.round(since)}s since the last band move in this pool, minimum ${limits.minSecondsBetweenActions}s`;
  }
  if (o.state.lastPrice && o.snapshot.activePrice > 0) {
    const move = Math.abs(o.snapshot.activePrice / o.state.lastPrice - 1) * 100;
    if (move > limits.maxPriceMovePctPerCycle) return `price moved ${move.toFixed(1)}% since the last cycle (limit ${limits.maxPriceMovePctPerCycle}%)`;
  }
  return null;
}

interface Sizing {
  amountQuote: number;
  amountSol: number;
  bins: number;
  /** the session width multiplier applied to the bins (1 outside stock pools) */
  widthMultiplier: number;
  coverage: number;
  /** why the band is this wide, in words */
  widthFrom: string;
  depthQuote: number;
  sharePct: number;
  /** which cap bound the size */
  boundBy: string;
  caps: string;
  none: string | null;
}

/** Size a fresh quote-only band: min(effective max, 95% of the wallet's quote, half the depth, exposure room), rounded down to the quote's decimals. */
function sizeBand(o: Observation, x: PolicyExtras, q: QuoteView, env: PolicyEnv, closing: PositionSnapshot | null, now: number): Sizing {
  const s = o.snapshot;
  const limits = x.limits;
  const quoteIsSol = q.symbol === "SOL";
  const openCost = typeof x.openCostSol === "number" && Number.isFinite(x.openCostSol) && x.openCostSol >= 0 ? x.openCostSol : OPEN_COST_ESTIMATE_SOL;
  const widthMultiplier = widthMultiplierFor(o, now);
  const cover = coverPctFor(o, env, env.coverPct, hotView(o, x));
  const bins = binsForCover(s.binStep, cover.coverPct, limits.maxBinWidth, widthMultiplier);
  const quoteBelow = q.side === "Y";
  const lowerBinId = quoteBelow ? s.activeBinId - bins : s.activeBinId;
  const upperBinId = quoteBelow ? s.activeBinId : s.activeBinId + bins;
  const depthQuote = bandDepthQuote({ quoteSide: q.side, lowerBinId, upperBinId }, s);
  const closingQuote = closing ? (closing.quoteInPosition ?? closing.solInPosition / q.priceInSol) : 0;
  const closingSol = closing ? closing.valueInSol : 0;
  const walletQuote = (o.wallet.quote ?? (quoteIsSol ? o.wallet.sol : 0)) + closingQuote;
  const effectiveMaxSol = Math.min(limits.maxPositionSol, o.engine?.effectiveMaxPositionSol ?? limits.maxPositionSol);
  const thisPoolExposure = o.positions.reduce((t, p) => t + p.valueInSol, 0);
  const roomSol = limits.maxTotalExposureSol - o.portfolio.otherExposureSol - thisPoolExposure + closingSol;
  const caps: { name: string; quote: number }[] = [
    { name: `max band ${r(effectiveMaxSol)} SOL`, quote: effectiveMaxSol / q.priceInSol },
    { name: `95% of the wallet's ${r(walletQuote, quoteIsSol ? 4 : 2)} ${q.symbol}`, quote: walletQuote * WALLET_SHARE },
    { name: `half the band's depth (${r(depthQuote, 2)} ${q.symbol})`, quote: depthQuote },
    { name: `exposure room ${r(roomSol)} SOL`, quote: roomSol / q.priceInSol },
  ];
  // Rent for the seats still to be opened stays in SOL: a SOL-quoted band must not eat the rent of the others.
  const otherSeats = Math.max(0, o.portfolio.maxActivePools - o.portfolio.poolsWithBands - 1);
  const rentBudget = openCost * otherSeats;
  if (quoteIsSol) {
    const solRoom = o.wallet.sol + (closing?.solInPosition ?? 0) - limits.gasReserveSol - openCost - rentBudget;
    caps.push({ name: `SOL after rent, the ${limits.gasReserveSol} SOL gas reserve and ${r(rentBudget, 3)} SOL of rent kept for ${otherSeats} more seat(s)`, quote: solRoom });
  }
  let none: string | null = null;
  if (!quoteIsSol && o.wallet.sol - openCost < limits.gasReserveSol) none = `wallet holds ${r(o.wallet.sol)} SOL: rent ~${openCost.toFixed(3)} would breach the ${limits.gasReserveSol} SOL gas reserve`;
  const bound = caps.reduce((a, b) => (b.quote < a.quote ? b : a));
  const decimals = quoteIsSol ? 4 : 2;
  const amountQuote = Math.max(0, Math.floor(bound.quote * 10 ** decimals) / 10 ** decimals);
  const amountSol = amountQuote * q.priceInSol;
  // A seat has a minimum: rent and attention are not free, and a $100 band on a $10,000 book is neither.
  const minSeatSol = Math.max(MIN_BAND_SOL, (limits.maxTotalExposureSol * env.minSeatPct) / 100);
  if (!none && amountSol < minSeatSol) none = `size ${r(amountSol)} SOL (bound by ${bound.name}) is under the minimum seat ${r(minSeatSol)} SOL (${env.minSeatPct}% of the ${limits.maxTotalExposureSol} SOL book)`;
  const sharePct = shareOfBand(amountQuote, depthQuote) * 100;
  return { amountQuote, amountSol, bins, widthMultiplier, coverage: coveragePct(s.binStep, bins), widthFrom: cover.from, depthQuote, sharePct, boundBy: bound.name, caps: caps.map((c) => c.name).join(", "), none };
}

/** What a seat of this size in this pool is worth, and what it costs to take. */
export interface SeatEarnings {
  seatUsd: number;
  poolFeesPerDayUsd: number;
  sharePct: number;
  feesPerDayUsd: number;
  yieldPctPerDay: number;
  /** rent that never comes back, plus the swap round trip on a straddle's token half */
  costUsd: number;
  paybackHours: number | null;
}

/**
 * The same arithmetic the paper book marks fees with: the pool's own 24h fees, times our share of
 * the band, halved because a band earns only while price is inside it. Null when the screen did not
 * price the pool (no TVL or no fee figure) or the SOL price is unknown: an unknown is not a refusal.
 */
export function seatEarnings(o: Observation, x: PolicyExtras, seatSol: number, sharePct: number, straddle: boolean): SeatEarnings | null {
  const solPriceUsd = o.snapshot.solPriceUsd ?? null;
  const tvlUsd = o.screen?.tvlUsd ?? null;
  const feeToTvl = o.screen?.feeToTvl24hPct ?? null;
  if (!solPriceUsd || !tvlUsd || feeToTvl === null || !Number.isFinite(feeToTvl) || seatSol <= 0) return null;
  const poolFeesPerDayUsd = (tvlUsd * feeToTvl) / 100;
  const feesPerDayUsd = poolFeesPerDayUsd * (Math.min(sharePct, 50) / 100) * 0.5;
  const seatUsd = seatSol * solPriceUsd;
  const yieldPctPerDay = (feesPerDayUsd / seatUsd) * 100;
  // Rent: only the part that does not come back on close is a cost. The refundable share differs by
  // venue (a CLMM position is cheap, a DLMM position pays for bin arrays), so read it from the plan
  // when the venue gave us one and fall back to Meteora's position rent.
  const openCost = typeof x.openCostSol === "number" && x.openCostSol >= 0 ? x.openCostSol : OPEN_COST_ESTIMATE_SOL;
  const refundable = typeof x.openCostRefundableSol === "number" && x.openCostRefundableSol >= 0 ? x.openCostRefundableSol : Math.min(openCost, POSITION_RENT_SOL);
  const rentUsd = Math.max(0, openCost - refundable) * solPriceUsd;
  // A straddle buys its token half and sells it back: two swaps on half the seat.
  const swapUsd = straddle ? (seatUsd / 2) * (jupiterEnv().feePct / 100) * 2 : 0;
  const costUsd = rentUsd + swapUsd;
  const paybackHours = feesPerDayUsd > 0 ? costUsd / (feesPerDayUsd / 24) : null;
  return { seatUsd, poolFeesPerDayUsd, sharePct, feesPerDayUsd, yieldPctPerDay, costUsd, paybackHours };
}

interface StraddleSizing {
  /** the whole seat in quote units (both halves) and in SOL */
  seatQuote: number;
  seatSol: number;
  amountQuote: number;
  amountToken: number;
  /** the token the swap must bring in before the deposit */
  acquireToken: number;
  /** the token a re-centre would sell back (a closing band returned more than the new half needs) */
  surplusToken: number;
  /** bins on each side of the active bin */
  bins: number;
  widthMultiplier: number;
  /** percent of price covered on each side */
  coverage: number;
  /** why the band is this wide, in words */
  widthFrom: string;
  /** both sides' depth in quote units */
  depthQuote: number;
  sharePct: number;
  boundBy: string;
  none: string | null;
}

/**
 * Size a stock straddle: half quote, half token at the active price. The wallet cap solves
 *   S/2 + max(0, S/2 - held x p) x (1 + slip) <= Q   (the quote half plus the purchase of the missing token half)
 * for S, Q being the fundable quote (95% of the wallet's, plus a closing band's); the other caps are
 * the effective max band, both sides' depth (share <= 50%) and the exposure room. Rounded down to the
 * quote's decimals and the token's (at most 6).
 */
function sizeStraddle(o: Observation, x: PolicyExtras, q: QuoteView, env: PolicyEnv, closing: PositionSnapshot | null, now: number): StraddleSizing {
  const s = o.snapshot;
  const limits = x.limits;
  const quoteIsSol = q.symbol === "SOL";
  const p = q.tokenPriceInQuote;
  const slip = limits.maxSlippagePct / 100;
  const openCost = typeof x.openCostSol === "number" && Number.isFinite(x.openCostSol) && x.openCostSol >= 0 ? x.openCostSol : OPEN_COST_ESTIMATE_SOL;
  const widthMultiplier = widthMultiplierFor(o, now);
  const cover = coverPctFor(o, env, env.stockCoverPct, hotView(o, x));
  const bins = stockBinsPerSide(s.binStep, cover.coverPct, limits.maxBinWidth, widthMultiplier);
  // depth on both sides, scaled from the observed bins to the band's reach, in quote units
  const quoteBelow = q.side === "Y";
  const a = s.activeBinId;
  const observedQuote = s.bins.filter((b) => (quoteBelow ? b.binId < a : b.binId > a)).length || 1;
  const observedToken = s.bins.filter((b) => (quoteBelow ? b.binId > a : b.binId < a)).length || 1;
  const quoteSideLiq = quoteBelow ? s.liquidityBelowY : s.liquidityAboveX;
  const tokenSideLiq = quoteBelow ? s.liquidityAboveX : s.liquidityBelowY;
  const depthQuote = (quoteSideLiq / observedQuote) * bins + (tokenSideLiq / observedToken) * bins * p;
  // what the wallet (and a closing band) can put up
  const closingQuote = closing ? (closing.quoteInPosition ?? closing.solInPosition / q.priceInSol) : 0;
  const closingToken = closing ? (q.side === "X" ? closing.amountY + closing.feeY : closing.amountX + closing.feeX) : 0;
  const closingSol = closing ? closing.valueInSol : 0;
  const walletQuote = (o.wallet.quote ?? (quoteIsSol ? o.wallet.sol : 0)) + closingQuote;
  const heldToken = o.wallet.token + closingToken;
  const otherSeats = Math.max(0, o.portfolio.maxActivePools - o.portfolio.poolsWithBands - 1);
  const rentBudget = openCost * otherSeats;
  let fundable = walletQuote * WALLET_SHARE;
  if (quoteIsSol) fundable = Math.min(fundable, o.wallet.sol + (closing?.solInPosition ?? 0) - limits.gasReserveSol - openCost - rentBudget);
  const heldValue = heldToken * p;
  const walletCap = fundable >= heldValue ? (2 * (fundable + heldValue * (1 + slip))) / (2 + slip) : 2 * fundable;
  const effectiveMaxSol = Math.min(limits.maxPositionSol, o.engine?.effectiveMaxPositionSol ?? limits.maxPositionSol);
  const thisPoolExposure = o.positions.reduce((t, pp) => t + pp.valueInSol, 0);
  const roomSol = limits.maxTotalExposureSol - o.portfolio.otherExposureSol - thisPoolExposure + closingSol;
  const caps: { name: string; quote: number }[] = [
    { name: `max band ${r(effectiveMaxSol)} SOL`, quote: effectiveMaxSol / q.priceInSol },
    { name: `the wallet's ${r(walletQuote, quoteIsSol ? 4 : 2)} ${q.symbol} and ${r(heldToken, 4)} ${s.baseToken.symbol} (95%, the token half bought at ${limits.maxSlippagePct}% slippage${quoteIsSol ? `, after rent, the ${limits.gasReserveSol} SOL gas reserve and ${r(rentBudget, 3)} SOL of rent kept for ${otherSeats} more seat(s)` : ""})`, quote: Math.max(0, walletCap) },
    { name: `half the band's depth on both sides (${r(depthQuote, 2)} ${q.symbol})`, quote: depthQuote },
    { name: `exposure room ${r(roomSol)} SOL`, quote: roomSol / q.priceInSol },
  ];
  let none: string | null = null;
  if (!quoteIsSol && o.wallet.sol - openCost < limits.gasReserveSol) none = `wallet holds ${r(o.wallet.sol)} SOL: rent ~${openCost.toFixed(3)} would breach the ${limits.gasReserveSol} SOL gas reserve`;
  if (!(p > 0)) none = "no price for the base token";
  const bound = caps.reduce((acc, c) => (c.quote < acc.quote ? c : acc));
  const qDec = quoteIsSol ? 4 : 2;
  const tDec = Math.min(s.baseToken.decimals, 6);
  const seatQuote = Math.max(0, Math.floor(bound.quote * 10 ** qDec) / 10 ** qDec);
  const amountQuote = Math.floor((seatQuote / 2) * 10 ** qDec) / 10 ** qDec;
  const amountToken = p > 0 ? Math.floor((seatQuote / 2 / p) * 10 ** tDec) / 10 ** tDec : 0;
  const shortfall = amountToken - heldToken;
  const acquireToken = shortfall > 0 ? Math.min(amountToken, Math.ceil(shortfall * 10 ** tDec) / 10 ** tDec) : 0;
  const surplusToken = shortfall < 0 ? Math.min(-shortfall, closingToken) : 0;
  const seatSol = seatQuote * q.priceInSol;
  const minSeatSol = Math.max(MIN_BAND_SOL, (limits.maxTotalExposureSol * env.minSeatPct) / 100);
  if (!none && seatSol < minSeatSol) none = `size ${r(seatSol)} SOL (bound by ${bound.name}) is under the minimum seat ${r(minSeatSol)} SOL (${env.minSeatPct}% of the ${limits.maxTotalExposureSol} SOL book)`;
  if (!none && (amountQuote <= 0 || amountToken <= 0)) none = `a straddle needs both halves: ${r(amountQuote, qDec)} ${q.symbol} + ${r(amountToken, tDec)} ${s.baseToken.symbol}`;
  const sharePct = shareOfBand(seatQuote, depthQuote) * 100;
  return { seatQuote, seatSol, amountQuote, amountToken, acquireToken, surplusToken, bins, widthMultiplier, widthFrom: cover.from,
    coverage: coveragePct(s.binStep, bins), depthQuote, sharePct, boundBy: bound.name, none };
}

function straddleParams(sz: StraddleSizing): OpenParams {
  return { side: "BOTH", amountSol: sz.amountQuote, amountToken: sz.amountToken, binsBelowActive: sz.bins, binsAboveActive: sz.bins, strategy: "Spot", acquireToken: sz.acquireToken };
}

/** "x2 for the closed US session" when a stock pool's band was widened, else nothing. */
const straddleWidthClause = (sz: StraddleSizing, o: Observation): string => (sz.widthMultiplier !== 1 ? ` (x${sz.widthMultiplier} for the ${o.engine?.basis?.session ?? "current"} US session)` : "");

/** "buying 1.51 SPYx (wallet holds 0)" / "selling 0.2 SPYx of the 1.7 coming back" / "the wallet already holds the token half" */
function legClause(sz: StraddleSizing, o: Observation, closing: PositionSnapshot | null, q: QuoteView): string {
  const sym = o.snapshot.baseToken.symbol;
  const tDec = Math.min(o.snapshot.baseToken.decimals, 6);
  const closingToken = closing ? (q.side === "X" ? closing.amountY + closing.feeY : closing.amountX + closing.feeX) : 0;
  if (sz.acquireToken > 0) return `buying ${r(sz.acquireToken, tDec)} ${sym} first (the wallet holds ${r(o.wallet.token, tDec)}${closing ? `, the closing band returns ${r(closingToken, tDec)}` : ""})`;
  if (sz.surplusToken > 0) return `selling ${r(sz.surplusToken, tDec)} ${sym} of the ${r(closingToken, tDec)} the closing band returns`;
  return `the wallet already holds the ${sym} half`;
}

const perpClause = (o: Observation): string => (o.engine?.basis?.perpSymbol ? `The ${o.snapshot.baseToken.symbol} half is hedged short on Backpack ${o.engine.basis.perpSymbol}.` : `No Backpack perp is listed for ${o.snapshot.baseToken.symbol}: the token half runs unhedged.`);

/** Bins a quote-only band spans: the active bin plus `bins` past it on Meteora; `bins` strictly past it on a CLMM (src/tools/bins.ts). */
const bandBins = (o: Pick<Observation, "snapshot">, bins: number): number => (o.snapshot.priceModel === "clmm" ? bins : bins + 1);
/** where the band starts: the active bin on Meteora, the bin next to it on a CLMM */
const laidFrom = (o: Pick<Observation, "snapshot">, quoteBelow: boolean): string => (o.snapshot.priceModel === "clmm" ? `the bin ${quoteBelow ? "under" : "over"} the active bin` : "the active bin");

/** "x2 for the closed US session" when a stock pool's band was widened, else nothing. */
const widthClause = (sz: Sizing, o: Observation): string => (sz.widthMultiplier !== 1 ? ` (x${sz.widthMultiplier} for the ${o.engine?.basis?.session ?? "current"} US session)` : "");

function openParams(q: QuoteView, sz: Sizing): OpenParams {
  const quoteBelow = q.side === "Y";
  return { side: "SOL_ONLY", amountSol: sz.amountQuote, amountToken: 0, binsBelowActive: quoteBelow ? sz.bins : 0, binsAboveActive: quoteBelow ? 0 : sz.bins, strategy: "Spot" };
}

/** What the screen and the hot list say about the pool, as one clause of numbers. */
function poolClause(o: Observation, hot: HotView): string {
  const parts: string[] = [];
  if (o.screen) parts.push(`screen #${o.screen.rank} of ${o.screen.rankedPools}, score ${r(o.screen.score, 1)}, fee/TVL 24h ${o.screen.feeToTvl24hPct === null ? "n/a" : `${r(o.screen.feeToTvl24hPct, 2)}%`}, TVL ${usd0(o.screen.tvlUsd)}, 24h vol ${usd0(o.screen.volume24hUsd)}`);
  if (hot.onList) parts.push(`hot list heat ${hot.heat === null ? "n/a" : r(hot.heat, 0)}${hot.surge ? " (surge)" : ""}, 1h move ${hot.priceChange1hPct === null ? "n/a" : pct(hot.priceChange1hPct)}`);
  return parts.length ? parts.join("; ") : "not on the screen or the hot list";
}

function bandClause(o: Observation, p: PositionSnapshot, q: QuoteView): string {
  const s = o.snapshot;
  const quoteIsX = q.side === "X";
  const amountQuote = quoteIsX ? p.amountX : p.amountY;
  const amountToken = quoteIsX ? p.amountY : p.amountX;
  const feeQuote = quoteIsX ? p.feeX : p.feeY;
  const feeToken = quoteIsX ? p.feeY : p.feeX;
  const feeSol = (feeQuote + feeToken * q.tokenPriceInQuote) * q.priceInSol;
  const entry = p.entryValueSol;
  const pnl = entry && entry > 0 ? ` (${pct((p.valueInSol / entry - 1) * 100, 2)} vs entry ${r(entry)} SOL)` : "";
  return `holds ${r(amountQuote, 4)} ${q.symbol} + ${r(amountToken, 4)} ${s.baseToken.symbol}, fees ${r(feeSol, 6)} SOL unclaimed, value ${r(p.valueInSol)} SOL${pnl}`;
}

export function policyDecide(o: Observation, x: PolicyExtras): PolicyResult {
  const env: PolicyEnv = { ...policyEnv(), ...x.env };
  const parsed = Date.parse(o.ts);
  const now = x.now ?? (Number.isFinite(parsed) ? parsed : Date.now());
  const s = o.snapshot;
  const q = quoteOf(s);
  const quoteBelow = q.side === "Y";
  const hot = hotView(o, x);
  const limits = x.limits;
  const priceLine = `active bin ${s.activeBinId} at ${s.activePrice.toPrecision(6)} ${s.priceLabel}`;
  const flaggedBy = (flags: string[]) => flags.filter((f) => POLICY_BLOCK_FLAGS.includes(f));

  // ---- a band is open in this pool -------------------------------------------------------------
  const band = [...o.positions].sort((a, b) => b.valueInSol - a.valueInSol)[0];
  if (band && isStockPool(o)) return stockBandDecide(o, x, env, q, band, now);
  if (band) {
    const addr = band.address.slice(0, 6);
    const range = `[${band.lowerBinId}, ${band.upperBinId}]`;
    const minSec = o.engine?.minOutOfRangeSec ?? 600;
    const oor = Math.round(o.engine?.outOfRangeSec?.[band.address] ?? 0);
    if (band.inRange) {
      return hold(
        `Band ${addr} covers bins ${range} and the ${priceLine} sits inside it. It ${bandClause(o, band, q)}. In range is where the fees are; nothing to move.`,
        "In range. Fees ticking. Nothing to do.",
        "in-range",
        `band ${addr} in range at bin ${s.activeBinId}`,
      );
    }
    const dist = Math.abs(band.binsFromRange);
    const bandIsToken = quoteBelow ? band.binsFromRange < 0 : band.binsFromRange > 0;
    if (bandIsToken) {
      const where = quoteBelow ? "below" : "above";
      if (oor < minSec) {
        return hold(
          `Price is ${dist} bins ${where} band ${addr} ${range} (${priceLine}) and the band ${bandClause(o, band, q)}. Out of range ${oor}s against the engine minimum ${minSec}s: moving it now is churn.`,
          `${dist} bins through the band, ${oor}s out. Not long enough. Holding.`,
          "churn-wait",
          `band ${addr} through, ${oor}s < ${minSec}s minimum`,
        );
      }
      const heldOnce = o.recent[0]?.action === "HOLD" && o.recent[0]?.headline === HOT_HOLD_HEADLINE;
      if (hot.onList && !heldOnce) {
        return hold(
          `Price is ${dist} bins ${where} band ${addr} ${range} (${priceLine}) for ${oor}s, past the ${minSec}s minimum; the band ${bandClause(o, band, q)}. The pool is still on the hot list (heat ${hot.heat === null ? "n/a" : r(hot.heat, 0)}, 1h ${hot.priceChange1hPct === null ? "n/a" : pct(hot.priceChange1hPct)}), so it gets one more cycle to come back.`,
          HOT_HOLD_HEADLINE,
          "hot-hold",
          `band ${addr} through but the pool is hot: one more cycle`,
        );
      }
      return {
        decision: {
          action: "CLOSE_POSITION",
          open: null,
          positionAddress: band.address,
          // The book is denominated in the quote. Token left in the wallet after an exit is not a
          // position anyone chose, and it is capital the desk cannot lay into the next band.
          liquidate: true,
          reasoning: `Price is ${dist} bins ${where} band ${addr} ${range} (${priceLine}) for ${oor}s, past the ${minSec}s minimum. The quote turned into token: the band ${bandClause(o, band, q)}. ${hot.onList ? "The pool is still hot but already had its extra cycle" : "The pool is not on the hot list"}; closing and selling the token back to ${q.symbol}.`,
          confidence: 0.75,
          headline: clip(`${dist} bins through the band and ${oor}s out. Off the table.`),
        },
        reason: `band ${addr} through for ${oor}s${hot.onList ? ", extra cycle spent" : ", not hot"}`,
        branch: "close",
      };
    }
    // idle in quote: the price ran off the quote side
    const where = quoteBelow ? "above" : "below";
    const waitSec = IDLE_MULTIPLE * minSec;
    if (s.priceModel === "clmm" && dist <= 1) {
      return hold(
        `Band ${addr} covers bins ${range} and the ${priceLine} sits one bin ${where} it. On a CLMM a ${q.symbol}-only band rests one bin ${quoteBelow ? "under" : "over"} the price by construction (the active bin is never part of a single-sided range); it ${bandClause(o, band, q)}. Fees start the moment the price crosses into it.`,
        `Resting one bin ${quoteBelow ? "under" : "over"} the price. Waiting for the tape.`,
        "resting",
        `band ${addr} resting one bin ${where} the price (CLMM)`,
      );
    }
    if (oor < waitSec) {
      return hold(
        `Price is ${dist} bins ${where} band ${addr} ${range} (${priceLine}); the band ${bandClause(o, band, q)} and earns nothing there. Idle ${oor}s of the ${waitSec}s (${IDLE_MULTIPLE}x the ${minSec}s minimum) the policy waits before re-laying it.`,
        `Price ran off the top. Idle ${oor}s, waiting.`,
        "idle-wait",
        `band ${addr} idle ${oor}s < ${waitSec}s`,
      );
    }
    const gate = openGate(o, limits, now);
    const sz = gate ? null : sizeBand(o, x, q, env, band, now);
    if (gate || !sz || sz.none) {
      const why = gate ?? sz!.none!;
      return {
        decision: {
          action: "CLOSE_POSITION",
          open: null,
          positionAddress: band.address,
          liquidate: true,
          reasoning: `Price is ${dist} bins ${where} band ${addr} ${range} (${priceLine}) for ${oor}s; the band ${bandClause(o, band, q)} and earns nothing there. A fresh band is off (${why}), so the capital comes back to the wallet as ${q.symbol}.`,
          confidence: 0.7,
          headline: clip(`Idle ${oor}s above the band, no fresh band allowed. Pulling it.`),
        },
        reason: `band ${addr} idle ${oor}s; re-lay refused: ${why}`,
        branch: "close",
      };
    }
    return {
      decision: {
        action: "REBALANCE",
        open: openParams(q, sz),
        positionAddress: band.address,
        reasoning: `Price is ${dist} bins ${where} band ${addr} ${range} (${priceLine}) for ${oor}s, past ${waitSec}s; the band ${bandClause(o, band, q)} and earns nothing there. Re-laying ${r(sz.amountQuote, q.symbol === "SOL" ? 4 : 2)} ${q.symbol} (${r(sz.amountSol)} SOL) as a ${bandBins(o, sz.bins)}-bin ${q.symbol}-only band from ${o.snapshot.priceModel === "clmm" ? `the bin ${quoteBelow ? "under" : "over"} bin ${s.activeBinId}` : `bin ${s.activeBinId}`} ${quoteBelow ? "down" : "up"} (${sz.bins} bins ${quoteBelow ? "under" : "over"} it), covering ${r(sz.coverage, 2)}% of price${widthClause(sz, o)}; size bound by ${sz.boundBy}, our share of the band ${r(sz.sharePct, 1)}%.`,
        confidence: 0.65,
        headline: clip(`Idle ${oor}s above the band. Re-laying ${r(sz.amountQuote, 2)} ${q.symbol} across ${bandBins(o, sz.bins)} bins under bin ${s.activeBinId}.`),
      },
      reason: `band ${addr} idle ${oor}s: re-lay ${r(sz.amountQuote, 2)} ${q.symbol} across ${bandBins(o, sz.bins)} bins`,
      branch: "rebalance",
    };
  }

  // ---- no band: is this pool worth one? --------------------------------------------------------
  const gate = openGate(o, limits, now);
  if (gate) {
    return hold(`No band in ${o.poolLabel} (${priceLine}). Opens are gated this cycle: ${gate}. ${poolClause(o, hot)}.`, `Engine says no opens here. ${gate.split(":")[0]}.`, "gated", gate);
  }
  if (o.portfolio.poolsWithBands >= o.portfolio.maxActivePools) {
    return hold(
      `No band in ${o.poolLabel} (${priceLine}) and the book already works ${o.portfolio.poolsWithBands} of ${o.portfolio.maxActivePools} pools with ${r(o.portfolio.otherExposureSol)} SOL out. ${poolClause(o, hot)}.`,
      `Book is full at ${o.portfolio.poolsWithBands} pools. Holding.`,
      "gated",
      `pool cap ${o.portfolio.poolsWithBands}/${o.portfolio.maxActivePools}`,
    );
  }
  const flags = [...new Set([...flaggedBy(o.screen?.flags ?? []), ...flaggedBy(hot.flags)])];
  if (flags.length) {
    return hold(`No band in ${o.poolLabel} (${priceLine}). The pool is flagged ${flags.join(", ")}; ${poolClause(o, hot)}. Not a market to make.`, `Flagged ${flags.join(", ")}. Not touching it.`, "flagged", `flagged ${flags.join(", ")}`);
  }
  // Volume is what pays the fees: a pool that barely trades cannot pay a seat, whatever its yield looks like.
  const vol24h = o.screen?.volume24hUsd ?? null;
  if (env.minVolume24hUsd > 0 && vol24h !== null && vol24h < env.minVolume24hUsd) {
    return hold(
      `No band in ${o.poolLabel} (${priceLine}). The pool traded $${r(vol24h, 0)} in 24h, under the $${r(env.minVolume24hUsd, 0)} the policy will make a market in: fees come from volume, and there is not enough here to pay a seat. ${poolClause(o, hot)}.`,
      clip(`Only $${r(vol24h / 1000, 0)}k traded here in a day. Passing.`),
      "not-worth",
      `24h volume $${r(vol24h, 0)} under the $${r(env.minVolume24hUsd, 0)} floor`,
    );
  }
  // Size the seat once, here: the earnings test below needs to know how big it would be.
  const straddleHere = isStockPool(o);
  const szPreview = straddleHere ? sizeStraddle(o, x, q, env, null, now) : sizeBand(o, x, q, env, null, now);
  const isHotPick = hot.onList;
  const score = o.screen?.score ?? null;
  const scoreOk = score !== null && score > env.minScore;
  // The stock book: a tokenized-stock pool is the book's purpose; the guards and the basis still gate it.
  const stockBook = env.book === "stocks" && isStockPool(o);
  // The operator's watchlist is a judgement about the token; the score is a judgement about the unknown.
  // A listed token does not need a score, but every other gate (volume, yield, payback, flags, the
  // guards, the basis and session rules) still applies to it.
  const listed = o.screen?.watchlisted === true;
  if (!isHotPick && !scoreOk && !stockBook && !listed) {
    const why = score === null ? `not on the screen and not on the hot list` : `score ${r(score, 1)} is not above ${env.minScore} and the pool is not on the hot list`;
    return hold(`No band in ${o.poolLabel} (${priceLine}): ${why}. ${poolClause(o, hot)}.`, "Nothing worth a band here. Holding.", "not-worth", why);
  }
  if (hot.priceChange1hPct !== null && Math.abs(hot.priceChange1hPct) > POLICY_MAX_1H_MOVE_PCT) {
    return hold(
      `No band in ${o.poolLabel} (${priceLine}). The last hour moved ${pct(hot.priceChange1hPct)}, outside the +/-${POLICY_MAX_1H_MOVE_PCT}% the policy will lay a band into. ${poolClause(o, hot)}.`,
      `Moved ${pct(hot.priceChange1hPct, 0)} in an hour. Not chasing it.`,
      "moved",
      `1h move ${pct(hot.priceChange1hPct)} outside +/-${POLICY_MAX_1H_MOVE_PCT}%`,
    );
  }
  // Is the seat worth taking? What it earns, against what it costs.
  const seatSolPreview = straddleHere ? (szPreview as StraddleSizing).seatSol : (szPreview as Sizing).amountSol;
  const earn = szPreview.none ? null : seatEarnings(o, x, seatSolPreview, szPreview.sharePct, straddleHere);
  if (earn && env.minSeatYieldPct > 0 && earn.yieldPctPerDay < env.minSeatYieldPct) {
    return hold(
      `No band in ${o.poolLabel} (${priceLine}). The seat would earn about $${r(earn.feesPerDayUsd, 2)} a day on $${r(earn.seatUsd, 0)}, ${r(earn.yieldPctPerDay, 2)}% a day, under the ${env.minSeatYieldPct}% floor: the pool pays $${r(earn.poolFeesPerDayUsd, 0)} a day and our share of the band would be ${r(earn.sharePct, 1)}%. ${poolClause(o, hot)}.`,
      clip(`${r(earn.yieldPctPerDay, 2)}% a day here. Not worth the rent.`),
      "not-worth",
      `seat yield ${r(earn.yieldPctPerDay, 2)}%/day under the ${env.minSeatYieldPct}% floor`,
    );
  }
  if (earn && env.maxPaybackHours > 0 && earn.paybackHours !== null && earn.paybackHours > env.maxPaybackHours) {
    return hold(
      `No band in ${o.poolLabel} (${priceLine}). Opening costs about $${r(earn.costUsd, 2)} in rent that does not come back and swap fees, and the seat earns about $${r(earn.feesPerDayUsd, 2)} a day, so it pays that back in ${r(earn.paybackHours, 1)}h, past the ${env.maxPaybackHours}h the policy will wait. ${poolClause(o, hot)}.`,
      clip(`${r(earn.paybackHours, 0)}h to earn the rent back. Passing.`),
      "not-worth",
      `payback ${r(earn.paybackHours, 1)}h over the ${env.maxPaybackHours}h limit`,
    );
  }
  const worth = listed && !isHotPick && !scoreOk
    ? `on the watchlist${score !== null ? `, screen score ${r(score, 1)}` : ""}`
    : isHotPick
    ? `hot pick (heat ${hot.heat === null ? "n/a" : r(hot.heat, 0)}${hot.surge ? ", surge" : ""}${score !== null ? `, screen score ${r(score, 1)}` : ""})`
    : scoreOk
      ? `screen score ${r(score!, 1)} above ${env.minScore}`
      : `stock book: ${o.screen?.stock ? `${o.screen.stock.ticker} (${o.screen.stock.issuer})` : "tokenized stock"}${score !== null ? `, screen score ${r(score, 1)}` : ""}`;
  // A stock pool gets a straddle, whatever made it worth a band.
  if (isStockPool(o)) {
    const sz = szPreview as StraddleSizing;
    if (sz.none) {
      return hold(`No band in ${o.poolLabel} (${priceLine}); ${poolClause(o, hot)}. No size for a straddle: ${sz.none}.`, "No size for a straddle here. Holding.", "no-size", sz.none);
    }
    const tDec = Math.min(s.baseToken.decimals, 6);
    const width = 2 * sz.bins + 1;
    return {
      decision: {
        action: "OPEN_POSITION",
        open: straddleParams(sz),
        positionAddress: null,
        reasoning: `${o.poolLabel}: ${worth}; ${poolClause(o, hot)}. ${priceLine[0].toUpperCase() + priceLine.slice(1)}; a ${width}-bin Spot straddle from bin ${s.activeBinId - sz.bins} to ${s.activeBinId + sz.bins} (${sz.bins} bins each side, ${r(sz.coverage, 2)}% of price each way${straddleWidthClause(sz, o)}) against ${r(sz.depthQuote, 2)} ${q.symbol} of depth on both sides. Seat ${r(sz.seatQuote, q.symbol === "SOL" ? 4 : 2)} ${q.symbol} (${r(sz.seatSol)} SOL): ${r(sz.amountQuote, q.symbol === "SOL" ? 4 : 2)} ${q.symbol} + ${r(sz.amountToken, tDec)} ${s.baseToken.symbol}, ${legClause(sz, o, null, q)}; bound by ${sz.boundBy}; our share of the band ${r(sz.sharePct, 1)}%. ${perpClause(o)}`,
        confidence: isHotPick ? 0.6 : 0.55,
        headline: clip(`Straddling ${o.poolLabel}: ${r(sz.amountQuote, 2)} ${q.symbol} + ${r(sz.amountToken, 4)} ${s.baseToken.symbol} across ${width} bins. Hedged.`),
      },
      reason: `straddle ${r(sz.amountQuote, 2)} ${q.symbol} + ${r(sz.amountToken, tDec)} ${s.baseToken.symbol} across ${width} bins${sz.acquireToken > 0 ? `, buying ${r(sz.acquireToken, tDec)}` : ""} (${worth})`,
      branch: "open",
    };
  }
  const sz = szPreview as Sizing;
  if (sz.none) {
    return hold(`No band in ${o.poolLabel} (${priceLine}); ${poolClause(o, hot)}. No size: ${sz.none}.`, "No size for a band here. Holding.", "no-size", sz.none);
  }
  return {
    decision: {
      action: "OPEN_POSITION",
      open: openParams(q, sz),
      positionAddress: null,
      reasoning: `${o.poolLabel}: ${worth}; ${poolClause(o, hot)}. ${priceLine[0].toUpperCase() + priceLine.slice(1)}; a ${bandBins(o, sz.bins)}-bin ${q.symbol}-only Spot band from ${laidFrom(o, quoteBelow)} ${quoteBelow ? "down" : "up"} (${sz.bins} bins ${quoteBelow ? "under" : "over"} it) covers ${r(sz.coverage, 2)}% of price${widthClause(sz, o)} against ${r(sz.depthQuote, 2)} ${q.symbol} of depth on that side. Size ${r(sz.amountQuote, q.symbol === "SOL" ? 4 : 2)} ${q.symbol} (${r(sz.amountSol)} SOL), bound by ${sz.boundBy}; our share of the band ${r(sz.sharePct, 1)}%.`,
      confidence: isHotPick ? 0.6 : 0.55,
      headline: clip(`${q.symbol} ${quoteBelow ? "under the bid" : "over the ask"} in ${o.poolLabel}. ${r(sz.amountQuote, 2)} ${q.symbol} across ${bandBins(o, sz.bins)} bins.`),
    },
    reason: `open ${r(sz.amountQuote, 2)} ${q.symbol} across ${bandBins(o, sz.bins)} bins (${worth})`,
    branch: "open",
  };
}

/**
 * A stock pool with a band open: HOLD in range; out of range under the engine minimum is churn;
 * past it, REBALANCE to a fresh straddle around the new price when the gates allow, else CLOSE
 * with liquidate so the book returns to the quote.
 */
function stockBandDecide(o: Observation, x: PolicyExtras, env: PolicyEnv, q: QuoteView, band: PositionSnapshot, now: number): PolicyResult {
  const s = o.snapshot;
  const limits = x.limits;
  const addr = band.address.slice(0, 6);
  const range = `[${band.lowerBinId}, ${band.upperBinId}]`;
  const priceLine = `active bin ${s.activeBinId} at ${s.activePrice.toPrecision(6)} ${s.priceLabel}`;
  const minSec = o.engine?.minOutOfRangeSec ?? 600;
  const oor = Math.round(o.engine?.outOfRangeSec?.[band.address] ?? 0);
  const sym = s.baseToken.symbol;
  const tDec = Math.min(s.baseToken.decimals, 6);
  if (band.inRange) {
    return hold(
      `Straddle ${addr} covers bins ${range} and the ${priceLine} sits inside it. It ${bandClause(o, band, q)}. In range is where the fees are, in both directions; the ${sym} half is the hedge desk's to cover. Nothing to move.`,
      "In range. Fees ticking both ways. Nothing to do.",
      "in-range",
      `straddle ${addr} in range at bin ${s.activeBinId}`,
    );
  }
  const dist = Math.abs(band.binsFromRange);
  const where = band.binsFromRange < 0 ? "below" : "above";
  if (oor < minSec) {
    return hold(
      `Price is ${dist} bins ${where} straddle ${addr} ${range} (${priceLine}) and the band ${bandClause(o, band, q)}. Out of range ${oor}s against the engine minimum ${minSec}s: re-centring now is churn.`,
      `${dist} bins ${where} the straddle, ${oor}s out. Not long enough. Holding.`,
      "churn-wait",
      `straddle ${addr} ${where} the price, ${oor}s < ${minSec}s minimum`,
    );
  }
  const gate = openGate(o, limits, now);
  const sz = gate ? null : sizeStraddle(o, x, q, env, band, now);
  if (gate || !sz || sz.none) {
    const why = gate ?? sz!.none!;
    return {
      decision: {
        action: "CLOSE_POSITION",
        open: null,
        positionAddress: band.address,
        liquidate: true,
        reasoning: `Price is ${dist} bins ${where} straddle ${addr} ${range} (${priceLine}) for ${oor}s, past the ${minSec}s minimum; the band ${bandClause(o, band, q)} and earns nothing there. A fresh straddle is off (${why}), so the band comes off and its ${sym} is sold back to ${q.symbol}.`,
        confidence: 0.7,
        headline: clip(`${dist} bins ${where} the straddle for ${oor}s, no re-centre allowed. Off, back to ${q.symbol}.`),
      },
      reason: `straddle ${addr} ${where} the price for ${oor}s; re-centre refused: ${why}`,
      branch: "close",
    };
  }
  const width = 2 * sz.bins + 1;
  return {
    decision: {
      action: "REBALANCE",
      open: straddleParams(sz),
      positionAddress: band.address,
      reasoning: `Price is ${dist} bins ${where} straddle ${addr} ${range} (${priceLine}) for ${oor}s, past the ${minSec}s minimum; the band ${bandClause(o, band, q)} and earns nothing there. Re-centring: close it, then lay ${r(sz.amountQuote, q.symbol === "SOL" ? 4 : 2)} ${q.symbol} + ${r(sz.amountToken, tDec)} ${sym} as a ${width}-bin straddle from bin ${s.activeBinId - sz.bins} to ${s.activeBinId + sz.bins} (${r(sz.coverage, 2)}% of price each way${straddleWidthClause(sz, o)}), ${legClause(sz, o, band, q)}; size bound by ${sz.boundBy}, our share of the band ${r(sz.sharePct, 1)}%. ${perpClause(o)}`,
      confidence: 0.65,
      headline: clip(`${dist} bins ${where} the straddle for ${oor}s. Re-centring ${r(sz.amountQuote, 2)} ${q.symbol} + ${r(sz.amountToken, 4)} ${sym} on bin ${s.activeBinId}.`),
    },
    reason: `straddle ${addr} ${where} the price for ${oor}s: re-centre ${r(sz.amountQuote, 2)} ${q.symbol} + ${r(sz.amountToken, tDec)} ${sym} across ${width} bins${sz.acquireToken > 0 ? `, buying ${r(sz.acquireToken, tDec)}` : sz.surplusToken > 0 ? `, selling ${r(sz.surplusToken, tDec)}` : ""}`,
    branch: "rebalance",
  };
}
