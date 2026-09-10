/**
 * The guards. Pure functions: proposal + context + limits -> verdict.
 * No RPC, no LLM, no side effects. Everything here runs before a transaction is built.
 *
 * Two kinds of outcomes:
 *   - violations: the proposal is rejected and replaced with HOLD
 *   - overrides:  the guards replace the proposal with something safer (stop-loss close)
 */
import { Decision, holdDecision } from "../agent/schema";
import { OPEN_COST_ESTIMATE_SOL, PoolSnapshot, PositionSnapshot } from "../tools/dlmm";
import type { RiskLimits } from "./limits";
import type { RiskState } from "./state";

export interface GuardContext {
  now: number;
  snapshot: PoolSnapshot;
  positions: PositionSnapshot[];
  walletSol: number;
  walletToken: number;
  state: RiskState;
  killSwitch: boolean;
  /** SOL-equivalent value of bands in OTHER pools */
  otherExposureSol: number;
  /** pools (excluding this one) that currently hold a band */
  poolsWithBands: number;
  maxActivePools: number;
}

export interface Verdict {
  /** what the LLM proposed */
  proposal: Decision;
  /** what will actually be executed (HOLD when blocked) */
  decision: Decision;
  allowed: boolean;
  violations: string[];
  overrides: string[];
  /** checks that passed, for the journal */
  passed: string[];
  /** true when the final decision came from a guard, not the LLM */
  emergency: boolean;
}

const isOpening = (d: Decision) => d.action === "OPEN_POSITION" || d.action === "REBALANCE";
const isClosing = (d: Decision) => d.action === "CLOSE_POSITION" || d.action === "REBALANCE";
const isInt = (n: number) => Number.isInteger(n);

export function evaluate(proposal: Decision, ctx: GuardContext, limits: RiskLimits): Verdict {
  const violations: string[] = [];
  const overrides: string[] = [];
  const passed: string[] = [];
  let decision: Decision = proposal;
  let emergency = false;

  // 1. Stop-loss override. Guards can force a close regardless of what the model wants.
  for (const p of ctx.positions) {
    const entry = ctx.state.entryValueSol[p.address];
    if (!entry || entry <= 0) continue;
    const drawdownPct = (1 - p.valueInSol / entry) * 100;
    if (drawdownPct >= limits.stopLossPct) {
      overrides.push(
        `stop-loss: ${p.address.slice(0, 6)} is ${drawdownPct.toFixed(1)}% below entry (${entry.toFixed(4)} -> ${p.valueInSol.toFixed(4)} SOL); forcing CLOSE`,
      );
      decision = {
        action: "CLOSE_POSITION",
        open: null,
        positionAddress: p.address,
        reasoning: `Stop-loss triggered by risk guards at -${drawdownPct.toFixed(1)}% (limit -${limits.stopLossPct}%). Model proposal (${proposal.action}) overridden.`,
        confidence: 1,
        headline: "Stop-loss hit. Bands off the table.",
      };
      emergency = true;
      break;
    }
  }
  if (!emergency) passed.push("stop-loss");

  // 2. Kill switch: no new exposure.
  if (ctx.killSwitch && isOpening(decision)) {
    violations.push("kill switch active (STOP file or KILL_SWITCH=true): opening bands is blocked");
  } else {
    passed.push("kill-switch");
  }

  // 3. Price sanity: a huge move since last cycle means bad data or a crash. Don't add exposure into it.
  if (ctx.state.lastPrice && ctx.snapshot.activePrice > 0 && isOpening(decision)) {
    const movePct = Math.abs(ctx.snapshot.activePrice / ctx.state.lastPrice - 1) * 100;
    if (movePct > limits.maxPriceMovePctPerCycle) {
      violations.push(`price moved ${movePct.toFixed(1)}% since last cycle (limit ${limits.maxPriceMovePctPerCycle}%)`);
    } else {
      passed.push(`price-move ${movePct.toFixed(2)}%`);
    }
  }

  // 4. Rate limits for anything that costs a transaction. Emergencies skip the cooldown.
  if (decision.action !== "HOLD" && !emergency) {
    if (ctx.state.actionsToday >= limits.maxTxPerDay) {
      violations.push(`daily action cap reached (${ctx.state.actionsToday}/${limits.maxTxPerDay})`);
    } else {
      passed.push(`daily-cap ${ctx.state.actionsToday}/${limits.maxTxPerDay}`);
    }
    if (ctx.state.lastActionAt !== null) {
      const since = (ctx.now - ctx.state.lastActionAt) / 1000;
      if (since < limits.minSecondsBetweenActions) {
        violations.push(`cooldown: ${Math.round(since)}s since last action (min ${limits.minSecondsBetweenActions}s)`);
      } else {
        passed.push("cooldown");
      }
    }
  }

  // 5. Closing / claiming must target a real position.
  let closing: PositionSnapshot | undefined;
  if (isClosing(decision)) {
    closing = ctx.positions.find((p) => p.address === decision.positionAddress);
    if (!closing) {
      violations.push(`positionAddress ${decision.positionAddress ?? "null"} is not one of ours`);
    } else {
      passed.push("close-target");
    }
  }
  if (decision.action === "CLAIM_FEES") {
    if (ctx.positions.length === 0) {
      violations.push("nothing to claim: no open positions");
    } else if (decision.positionAddress && !ctx.positions.some((p) => p.address === decision.positionAddress)) {
      violations.push(`positionAddress ${decision.positionAddress} is not one of ours`);
    } else {
      passed.push("claim-target");
    }
  }

  // 6. Opening: size, exposure, gas, geometry.
  if (isOpening(decision)) {
    const o = decision.open;
    if (!o) {
      violations.push("OPEN/REBALANCE without `open` parameters");
    } else {
      const s = ctx.snapshot;
      const solIsX = s.solSide === "X";
      const sizeSol = o.amountSol + o.amountToken * s.tokenPriceInSol;
      const currentExposure = ctx.positions.reduce((sum, p) => sum + p.valueInSol, 0);
      const exposureAfter = ctx.otherExposureSol + currentExposure - (closing?.valueInSol ?? 0) + sizeSol;
      const walletSolAfterClose = ctx.walletSol + (closing?.solInPosition ?? 0);
      const walletSolAfter = walletSolAfterClose - o.amountSol - OPEN_COST_ESTIMATE_SOL;
      const width = o.binsBelowActive + o.binsAboveActive + 1;

      if (!(o.amountSol >= 0) || !(o.amountToken >= 0) || sizeSol <= 0) violations.push("deposit amounts must be positive");
      if (sizeSol > limits.maxPositionSol) violations.push(`band size ${sizeSol.toFixed(4)} SOL > max ${limits.maxPositionSol}`);
      if (exposureAfter > limits.maxTotalExposureSol) violations.push(`total exposure would be ${exposureAfter.toFixed(4)} SOL > max ${limits.maxTotalExposureSol}`);
      if (walletSolAfter < limits.gasReserveSol) {
        violations.push(
          `wallet would hold ${walletSolAfter.toFixed(4)} SOL after deposit + ~${OPEN_COST_ESTIMATE_SOL.toFixed(3)} rent, below gas reserve ${limits.gasReserveSol}`,
        );
      }
      if (o.amountToken > ctx.walletToken + (closing ? closing.amountX + closing.amountY : 0)) {
        violations.push(`not enough ${s.baseToken.symbol}: want ${o.amountToken}, have ${ctx.walletToken}`);
      }
      if (!isInt(o.binsBelowActive) || !isInt(o.binsAboveActive) || o.binsBelowActive < 0 || o.binsAboveActive < 0) {
        violations.push("bin counts must be non-negative integers");
      }
      if (width > limits.maxBinWidth) violations.push(`band width ${width} bins > max ${limits.maxBinWidth}`);
      if (ctx.positions.length === 0 && !closing && ctx.poolsWithBands >= ctx.maxActivePools) {
        violations.push(`already working ${ctx.poolsWithBands} pools (max ${ctx.maxActivePools})`);
      }

      // Geometry: SOL sits below active when SOL is Y, above when SOL is X. Token is the opposite.
      const solBelow = !solIsX;
      if (o.side === "SOL_ONLY") {
        if (o.amountToken !== 0) violations.push("SOL_ONLY band must not deposit token");
        if (o.amountSol <= 0) violations.push("SOL_ONLY band needs amountSol > 0");
        if (solBelow ? o.binsAboveActive !== 0 : o.binsBelowActive !== 0) {
          violations.push(`SOL_ONLY band must sit ${solBelow ? "at/below" : "at/above"} the active bin`);
        }
      } else if (o.side === "TOKEN_ONLY") {
        if (o.amountSol !== 0) violations.push("TOKEN_ONLY band must not deposit SOL");
        if (o.amountToken <= 0) violations.push("TOKEN_ONLY band needs amountToken > 0");
        if (solBelow ? o.binsBelowActive !== 0 : o.binsAboveActive !== 0) {
          violations.push(`TOKEN_ONLY band must sit ${solBelow ? "at/above" : "at/below"} the active bin`);
        }
      }
      if (violations.length === 0) passed.push(`open size ${sizeSol.toFixed(4)} SOL, width ${width}, exposure after ${exposureAfter.toFixed(4)}`);
    }
  }

  const allowed = violations.length === 0;
  return {
    proposal,
    decision: allowed ? decision : holdDecision(`Blocked by risk guards: ${violations.join("; ")}`, "Guards said no. Holding."),
    allowed,
    violations,
    overrides,
    passed,
    emergency,
  };
}
