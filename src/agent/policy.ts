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
 */
import type { HotRow } from "../hot/types";
import { bandDepthQuote, shareOfBand } from "../paper/mark";
import type { RiskLimits } from "../risk/limits";
import { OPEN_COST_ESTIMATE_SOL, quoteOf, type PositionSnapshot, type QuoteView } from "../tools/dlmm";
import type { Observation } from "./observation";
import { holdDecision, type Decision, type OpenParams } from "./schema";

export interface PolicyEnv {
  /** how far past the active bin a fresh band reaches, in percent of price */
  coverPct: number;
  /** a pool off the hot list needs a screen score above this to get a band */
  minScore: number;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function policyEnv(env: NodeJS.ProcessEnv = process.env): PolicyEnv {
  return { coverPct: Math.max(0.1, num(env.POLICY_COVER_PCT, 5)), minScore: num(env.POLICY_MIN_SCORE, 20) };
}

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
}

export type PolicyBranch = "in-range" | "close" | "hot-hold" | "rebalance" | "idle-wait" | "churn-wait" | "gated" | "open" | "not-worth" | "flagged" | "moved" | "no-size";

export interface PolicyResult {
  decision: Decision;
  /** one line: why */
  reason: string;
  branch: PolicyBranch;
}

/** Bins that cover coverPct of price at this bin step, inside [3, maxBinWidth - 1]. */
export function binsForCover(binStep: number, coverPct: number, maxBinWidth: number): number {
  const raw = Math.round(Math.log(1 + coverPct / 100) / Math.log(1 + binStep / 10_000));
  return Math.min(Math.max(3, raw), Math.max(1, maxBinWidth - 1));
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
  coverage: number;
  depthQuote: number;
  sharePct: number;
  /** which cap bound the size */
  boundBy: string;
  caps: string;
  none: string | null;
}

/** Size a fresh quote-only band: min(effective max, 95% of the wallet's quote, half the depth, exposure room), rounded down to the quote's decimals. */
function sizeBand(o: Observation, x: PolicyExtras, q: QuoteView, env: PolicyEnv, closing: PositionSnapshot | null): Sizing {
  const s = o.snapshot;
  const limits = x.limits;
  const quoteIsSol = q.symbol === "SOL";
  const bins = binsForCover(s.binStep, env.coverPct, limits.maxBinWidth);
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
  if (quoteIsSol) {
    const solRoom = o.wallet.sol + (closing?.solInPosition ?? 0) - limits.gasReserveSol - OPEN_COST_ESTIMATE_SOL;
    caps.push({ name: `SOL after rent and the ${limits.gasReserveSol} SOL gas reserve`, quote: solRoom });
  }
  let none: string | null = null;
  if (!quoteIsSol && o.wallet.sol - OPEN_COST_ESTIMATE_SOL < limits.gasReserveSol) none = `wallet holds ${r(o.wallet.sol)} SOL: rent ~${OPEN_COST_ESTIMATE_SOL.toFixed(3)} would breach the ${limits.gasReserveSol} SOL gas reserve`;
  const bound = caps.reduce((a, b) => (b.quote < a.quote ? b : a));
  const decimals = quoteIsSol ? 4 : 2;
  const amountQuote = Math.max(0, Math.floor(bound.quote * 10 ** decimals) / 10 ** decimals);
  const amountSol = amountQuote * q.priceInSol;
  if (!none && amountSol < MIN_BAND_SOL) none = `size ${r(amountSol)} SOL (bound by ${bound.name}) is under the ${MIN_BAND_SOL} SOL floor`;
  const sharePct = shareOfBand(amountQuote, depthQuote) * 100;
  return { amountQuote, amountSol, bins, coverage: coveragePct(s.binStep, bins), depthQuote, sharePct, boundBy: bound.name, caps: caps.map((c) => c.name).join(", "), none };
}

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
          reasoning: `Price is ${dist} bins ${where} band ${addr} ${range} (${priceLine}) for ${oor}s, past the ${minSec}s minimum. The quote turned into token: the band ${bandClause(o, band, q)}. ${hot.onList ? "The pool is still hot but already had its extra cycle" : "The pool is not on the hot list"}; closing.`,
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
    if (oor < waitSec) {
      return hold(
        `Price is ${dist} bins ${where} band ${addr} ${range} (${priceLine}); the band ${bandClause(o, band, q)} and earns nothing there. Idle ${oor}s of the ${waitSec}s (${IDLE_MULTIPLE}x the ${minSec}s minimum) the policy waits before re-laying it.`,
        `Price ran off the top. Idle ${oor}s, waiting.`,
        "idle-wait",
        `band ${addr} idle ${oor}s < ${waitSec}s`,
      );
    }
    const gate = openGate(o, limits, now);
    const sz = gate ? null : sizeBand(o, x, q, env, band);
    if (gate || !sz || sz.none) {
      const why = gate ?? sz!.none!;
      return {
        decision: {
          action: "CLOSE_POSITION",
          open: null,
          positionAddress: band.address,
          reasoning: `Price is ${dist} bins ${where} band ${addr} ${range} (${priceLine}) for ${oor}s; the band ${bandClause(o, band, q)} and earns nothing there. A fresh band is off (${why}), so the idle quote comes back to the wallet.`,
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
        reasoning: `Price is ${dist} bins ${where} band ${addr} ${range} (${priceLine}) for ${oor}s, past ${waitSec}s; the band ${bandClause(o, band, q)} and earns nothing there. Re-laying ${r(sz.amountQuote, q.symbol === "SOL" ? 4 : 2)} ${q.symbol} (${r(sz.amountSol)} SOL) as a ${sz.bins + 1}-bin ${q.symbol}-only band from bin ${s.activeBinId} ${quoteBelow ? "down" : "up"} (${sz.bins} bins ${quoteBelow ? "under" : "over"} it), covering ${r(sz.coverage, 2)}% of price; size bound by ${sz.boundBy}, our share of the band ${r(sz.sharePct, 1)}%.`,
        confidence: 0.65,
        headline: clip(`Idle ${oor}s above the band. Re-laying ${r(sz.amountQuote, 2)} ${q.symbol} across ${sz.bins + 1} bins under bin ${s.activeBinId}.`),
      },
      reason: `band ${addr} idle ${oor}s: re-lay ${r(sz.amountQuote, 2)} ${q.symbol} across ${sz.bins + 1} bins`,
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
  const isHotPick = hot.onList;
  const score = o.screen?.score ?? null;
  const scoreOk = score !== null && score > env.minScore;
  if (!isHotPick && !scoreOk) {
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
  const sz = sizeBand(o, x, q, env, null);
  if (sz.none) {
    return hold(`No band in ${o.poolLabel} (${priceLine}); ${poolClause(o, hot)}. No size: ${sz.none}.`, "No size for a band here. Holding.", "no-size", sz.none);
  }
  const worth = isHotPick ? `hot pick (heat ${hot.heat === null ? "n/a" : r(hot.heat, 0)}${hot.surge ? ", surge" : ""}${score !== null ? `, screen score ${r(score, 1)}` : ""})` : `screen score ${r(score!, 1)} above ${env.minScore}`;
  return {
    decision: {
      action: "OPEN_POSITION",
      open: openParams(q, sz),
      positionAddress: null,
      reasoning: `${o.poolLabel}: ${worth}; ${poolClause(o, hot)}. ${priceLine[0].toUpperCase() + priceLine.slice(1)}; a ${sz.bins + 1}-bin ${q.symbol}-only Spot band from the active bin ${quoteBelow ? "down" : "up"} (${sz.bins} bins ${quoteBelow ? "under" : "over"} it) covers ${r(sz.coverage, 2)}% of price against ${r(sz.depthQuote, 2)} ${q.symbol} of depth on that side. Size ${r(sz.amountQuote, q.symbol === "SOL" ? 4 : 2)} ${q.symbol} (${r(sz.amountSol)} SOL), bound by ${sz.boundBy}; our share of the band ${r(sz.sharePct, 1)}%.`,
      confidence: isHotPick ? 0.6 : 0.55,
      headline: clip(`${q.symbol} ${quoteBelow ? "under the bid" : "over the ask"} in ${o.poolLabel}. ${r(sz.amountQuote, 2)} ${q.symbol} across ${sz.bins + 1} bins.`),
    },
    reason: `open ${r(sz.amountQuote, 2)} ${q.symbol} across ${sz.bins + 1} bins (${worth})`,
    branch: "open",
  };
}
