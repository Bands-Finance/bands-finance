/**
 * Engine directives: what the engine decides BEFORE the LLM is asked. Port of the exit
 * precedence in Meridian's agent/src/memeGuard.ts (stop ladder over everything) and
 * agent/src/portfolioBreaker.ts (flatten while standing down), plus lpGuard.ts's auto-collect.
 *
 *   FLATTEN  the portfolio breaker is standing down and a band is still open: close it
 *   STOP     a band's drawdown against entry reached its per-band stop: close it
 *   COLLECT  the collect policy wants a claim, and the guards' rate limits would let it through
 *
 * Precedence FLATTEN > STOP > COLLECT, one directive per pool per cycle. When a directive exists
 * the LLM is not called for that pool this cycle; the guards still run on it (they never block
 * an exit for anything but "this position is not ours"). Pure: no disk, no network.
 */
import type { Decision } from "../agent/schema";
import type { EngineConfig } from "../config";
import type { RiskLimits } from "../risk/limits";
import type { RiskState } from "../risk/state";
import type { PoolSnapshot, PositionSnapshot } from "../tools/dlmm";
import { standingDown, type EngineState } from "./breakers";
import { collectDirective } from "./collect";
import { bandStopPct, drawdownPct } from "./exit";

export type DirectiveKind = "FLATTEN" | "STOP" | "COLLECT";

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
}

const close = (positionAddress: string, reasoning: string, headline: string): Decision => ({
  action: "CLOSE_POSITION",
  open: null,
  positionAddress,
  reasoning,
  confidence: 1,
  headline,
});

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

  // STOP: the per-band stop, rolled at open, or the configured limit when none was rolled.
  let worst: { p: PositionSnapshot; dd: number; stop: number } | null = null;
  for (const p of positions) {
    const dd = drawdownPct(p, state.entryValueSol[p.address] ?? p.entryValueSol);
    if (dd === null) continue;
    const stop = bandStopPct(state.stops, p.address, ctx.limits);
    if (dd >= stop && (!worst || dd > worst.dd)) worst = { p, dd, stop };
  }
  if (worst) {
    const entry = state.entryValueSol[worst.p.address] ?? worst.p.entryValueSol ?? 0;
    const reason = `stop: ${worst.p.address.slice(0, 6)} is ${worst.dd.toFixed(1)}% below entry (${entry.toFixed(4)} -> ${worst.p.valueInSol.toFixed(4)} SOL), stop ${worst.stop.toFixed(2)}%`;
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

  // COLLECT: only when the guards' rate limits would let it through, so the cycle is not wasted.
  const rateOk =
    state.actionsToday < ctx.limits.maxTxPerDay &&
    (state.lastActionAt === null || (now - state.lastActionAt) / 1000 >= ctx.limits.minSecondsBetweenActions);
  if (rateOk) {
    const plan = collectDirective(positions, ctx.snapshot, state, now, ctx.cfg, ctx.collectsToday);
    if (plan) {
      return {
        kind: "COLLECT",
        reason: plan.reason,
        decision: {
          action: "CLAIM_FEES",
          open: null,
          positionAddress: plan.positionAddress,
          reasoning: `Engine directive COLLECT: ${plan.reason}. Claim ${ctx.collectsToday + 1} of ${ctx.cfg.collectMaxPerDay} today.`,
          confidence: 1,
          headline: `Fees to the wallet. ${plan.feesSol.toFixed(4)} SOL banked.`,
        },
      };
    }
  }
  return null;
}
