/**
 * Engine directives: what the engine decides BEFORE the LLM is asked. Port of the exit
 * precedence in Meridian's agent/src/memeGuard.ts (stop ladder over everything) and
 * agent/src/portfolioBreaker.ts (flatten while standing down), plus lpGuard.ts's auto-collect.
 *
 *   FLATTEN  the portfolio breaker is standing down and a band is still open: close it
 *   STOP     a band's drawdown against entry reached its per-band stop: close it
 *   EXPIRE   a LAUNCH-lane band has run out of road: past its maximum hold, or the pool's last hour
 *            has faded. A launch trade is a trade on a moment; when the moment is over the band
 *            comes off and liquidates, in profit or not. Ordinary bands never see this directive.
 *            A STOCK-pair band (src/screener/pairStock.ts) sees it for one reason only: its reference
 *            pool has been off the board for PAIR_STOCK_REF_GONE_CYCLES cycles, so nothing prices
 *            our pool; it is marked at the last price and closed, liquidating.
 *            An ASK band (src/engine/askExit.ts) sees it when its chain has been on the book for
 *            EXIT_ASK_MAX_MIN: what the asks did not sell is sold.
 *   COLLECT  the collect policy wants a claim, and the guards' rate limits would let it through
 *
 *   ROTATE   a stock the agent is paired with (PAIR_STOCK_PINNED_TICKERS) cannot be seated because the
 *            book is full: the loop names one band to make room (src/engine/rotation.ts) and it comes
 *            off here, liquidated, so the pin takes the seat next cycle.
 * Precedence FLATTEN > STOP > EXPIRE > ROTATE > COLLECT, one directive per pool per cycle. When a directive exists
 * the LLM is not called for that pool this cycle; the guards still run on it (they never block
 * an exit for anything but "this position is not ours"). Pure: no disk, no network.
 */
import type { Decision } from "../agent/schema";
import type { EngineConfig } from "../config";
import type { RiskLimits } from "../risk/limits";
import type { RiskState } from "../risk/state";
import { launchExpiry, type LaunchEnv } from "../screener/launch";
import type { PoolSnapshot, PositionSnapshot } from "../tools/dlmm";
import { askExpiry } from "./askExit";
import { standingDown, type EngineState } from "./breakers";
import { collectDirective } from "./collect";
import { bandStopPct, marketDrawdownPct, stopEntryOf } from "./exit";

export type DirectiveKind = "FLATTEN" | "STOP" | "EXPIRE" | "ROTATE" | "COLLECT";

export interface Directive {
  kind: DirectiveKind;
  decision: Decision;
  reason: string;
}

export interface DirectiveContext {
  now: number;
  snapshot: PoolSnapshot;
  positions: readonly PositionSnapshot[];
  state: RiskState;
  engine: EngineState;
  cfg: EngineConfig;
  limits: RiskLimits;
  /** fee claims already recorded today (ledger fold) */
  collectsToday: number;
  /**
   * The launch lane, for the EXPIRE directive: the lane's settings and what the pool's last hour is
   * trading right now (the hot watch's figure; null when there is none). Absent = no launch bands to
   * judge, which is the case for every pool the lane never seated.
   */
  launch?: { env: LaunchEnv; vol1hUsd: number | null };
  /**
   * The stock pair lane's one exit, for its pools only: how many consecutive cycles the reference
   * pool has been off the board, and the count at which the band comes off (PAIR_STOCK_REF_GONE_CYCLES).
   */
  pairStock?: { ticker: string; refGoneCycles: number; maxCycles: number };
  /** the loop named this pool to make room for a pin (src/engine/rotation.ts); absent for every other pool */
  rotate?: { reason: string } | null;
  /** the ask exit's maximum hold (EXIT_ASK_MAX_MIN) for the ask bands in state.askBands; absent = no hold limit */
  askExit?: { maxHoldMin: number };
}

const close = (positionAddress: string, reasoning: string, headline: string, liquidate = false): Decision => ({
  action: "CLOSE_POSITION",
  open: null,
  positionAddress,
  reasoning,
  confidence: 1,
  headline,
  ...(liquidate ? { liquidate: true } : {}),
});

/** PURE. The rotation's headline from its reason: the exit list, a faded seat, consolidation, a better seat, or a pin. */
export function rotateHeadline(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("operator's exit list")) return "Off the book by the exit list, kept by hand. This band comes off.";
  if (r.includes("its own flow faded")) return "Its flow faded. This band comes off.";
  if (r.includes("already held")) return "Consolidating into the best seat. This band comes off.";
  if (r.includes("would earn about")) return "A better seat is open. This band comes off.";
  return "Making room for the pair. This band comes off.";
}

export function engineDirective(ctx: DirectiveContext): Directive | null {
  const { now, positions, state } = ctx;

  // FLATTEN: while standing down, close every band, one per pool per cycle (largest first).
  if (standingDown(ctx.engine.portfolio, now) && positions.length > 0) {
    const target = [...positions].sort((a, b) => b.valueInSol - a.valueInSol)[0];
    const reason = ctx.engine.portfolio.standDownReason ?? "portfolio breaker stand-down";
    return {
      kind: "FLATTEN",
      reason,
      decision: close(
        target.address,
        `Engine directive FLATTEN: ${reason}. Closing ${target.address.slice(0, 6)} (${target.valueInSol.toFixed(4)} SOL); ${positions.length - 1} more band(s) follow on later cycles.`,
        "Breaker tripped. Everything comes off the table.",
      ),
    };
  }

  // STOP: the per-band stop, rolled at open, or the configured limit when none was rolled. An ask band is
  // measured against the mark the first ask of its chain was laid at (stopEntryOf), so the chain's stop bounds the chain.
  let worst: { p: PositionSnapshot; dd: number; stop: number } | null = null;
  for (const p of positions) {
    const dd = marketDrawdownPct(p, ctx.snapshot, stopEntryOf(state, p));
    if (dd === null) continue;
    const stop = bandStopPct(state.stops, p.address, ctx.limits);
    if (dd >= stop && (!worst || dd > worst.dd)) worst = { p, dd, stop };
  }
  if (worst) {
    const entry = stopEntryOf(state, worst.p) ?? 0;
    const ask = state.askBands?.[worst.p.address];
    const reason = `stop: ${ask ? "ask band " : ""}${worst.p.address.slice(0, 6)} is ${worst.dd.toFixed(1)}% below ${ask ? "the mark its chain was laid at" : "entry"} on its market value, fees aside (${entry.toFixed(4)} -> ${worst.p.valueInSol.toFixed(4)} SOL with fees), stop ${worst.stop.toFixed(2)}%`;
    return {
      kind: "STOP",
      reason,
      decision: close(
        worst.p.address,
        `Engine directive STOP: ${reason}. The stop is the exit; it is not negotiated.`,
        "Stop hit. Bands off the table.",
      ),
    };
  }

  // EXPIRE: a launch band past its maximum hold, or in a pool whose last hour has faded. It always
  // liquidates: the whole point of the lane's harsher terms is that the book comes back to the quote
  // rather than sitting in a token nobody chose to hold.
  if (ctx.launch?.env.on) {
    const expiry = launchExpiry(positions, state.launchBands, ctx.snapshot.address, now, ctx.launch.env, ctx.launch.vol1hUsd);
    if (expiry) {
      return {
        kind: "EXPIRE",
        reason: expiry.reason,
        decision: close(
          expiry.position,
          `Engine directive EXPIRE: ${expiry.reason}. A launch seat is rented for the moment, not the story; the band comes off and its token is sold back to the quote.`,
          "Launch seat is up. Off the table.",
          true,
        ),
      };
    }
  }

  // EXPIRE (ask band): the chain has been on the book for the ask exit's maximum hold. The asks had their
  // time; what they did not sell is sold the old way (liquidate, under the caps, residue for the rest).
  const askDue = askExpiry(positions, state.askBands, ctx.snapshot.address, now, ctx.askExit?.maxHoldMin ?? 0);
  if (askDue) {
    return {
      kind: "EXPIRE",
      reason: askDue.reason,
      decision: close(
        askDue.position,
        `Engine directive EXPIRE: ${askDue.reason}. The ask had its time on the book; the ${ctx.snapshot.baseToken.symbol} it still holds is sold back to the quote.`,
        "The ask had its time. Selling what is left.",
        true,
      ),
    };
  }

  // EXPIRE (stock pair): the reference pool has been off the board for the lane's limit. Nothing prices
  // our pool any more; the band is marked at the last price and comes off, liquidating.
  const ps = ctx.pairStock;
  if (ps && ps.maxCycles > 0 && ps.refGoneCycles >= ps.maxCycles && positions.length > 0) {
    const target = [...positions].sort((a, b) => b.valueInSol - a.valueInSol)[0];
    const reason = `stock pair: ${ps.ticker}'s reference pool has been off the board for ${ps.refGoneCycles} cycle(s) (limit ${ps.maxCycles}): nothing prices our pool, so it is marked at the last price and closed`;
    return {
      kind: "EXPIRE",
      reason,
      decision: close(
        target.address,
        `Engine directive EXPIRE: ${reason}. The band comes off and its ${ctx.snapshot.baseToken.symbol} is sold back to the quote.`,
        "Reference gone. Off the table.",
        true,
      ),
    };
  }

  // ROTATE: a seat is given up (a pin needs it, the yield ranking or the seat check found better, the
  // operator listed it). The largest band in the pool comes off, liquidated; the headline says which.
  if (ctx.rotate && positions.length > 0) {
    const target = [...positions].sort((a, b) => b.valueInSol - a.valueInSol)[0];
    return {
      kind: "ROTATE",
      reason: ctx.rotate.reason,
      decision: close(
        target.address,
        `Engine directive ROTATE: ${ctx.rotate.reason}. Closing ${target.address.slice(0, 6)} (${target.valueInSol.toFixed(4)} SOL) and selling its token back to the quote; the seat goes to the pin next cycle${positions.length > 1 ? `, and ${positions.length - 1} more band(s) in this pool follow` : ""}.`,
        rotateHeadline(ctx.rotate.reason),
        true,
      ),
    };
  }

  // COLLECT: only when the daily cap would let it through, so the cycle is not wasted (claims are not cooled down).
  // (an ask band's fees come with its close, which is at most a cycle away once it sold out; a claim on it would spend the
  // cycle the fast watch woke for the close, and its sweep would sell the chain's token fees through the pool)
  const rateOk = state.actionsToday < ctx.limits.maxTxPerDay;
  if (rateOk) {
    const plan = collectDirective(positions.filter((p) => !state.askBands?.[p.address]), ctx.snapshot, state, now, ctx.cfg, ctx.collectsToday);
    if (plan) {
      return {
        kind: "COLLECT",
        reason: plan.reason,
        decision: {
          action: "CLAIM_FEES",
          open: null,
          positionAddress: plan.positionAddress,
          reasoning: `Engine directive COLLECT: ${plan.reason}. Claim ${ctx.collectsToday + 1}${ctx.cfg.collectMaxPerDay > 0 ? ` of ${ctx.cfg.collectMaxPerDay}` : ""} today.`,
          confidence: 1,
          headline: `Fees to the wallet. ${plan.feesSol.toFixed(4)} SOL banked.`,
        },
      };
    }
  }
  return null;
}
