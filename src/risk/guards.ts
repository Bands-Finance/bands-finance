/**
 * The guards. Pure functions: proposal + context + limits -> verdict.
 * No RPC, no LLM, no side effects. Everything here runs before a transaction is built.
 *
 * Two kinds of outcomes:
 *   - violations: the proposal is rejected and replaced with HOLD
 *   - overrides:  the guards replace the proposal with something safer (stop-loss close)
 *
 * The engine (src/engine) feeds `ctx.engine`: halts, stand-down, bench, regime, knife, per-band
 * stops and out-of-range timers. Those gate OPENS only. Exits are never blocked by cooldown,
 * daily cap, kill switch, halts or stand-down; the one check that can stop an exit is "this
 * position is not ours". A close's `liquidate` flag (sell the token that comes back, stock bands)
 * is never judged here: an exit is an exit. The LLM proposes, the guards decide: every limit lives here.
 */
import { Decision, holdDecision } from "../agent/schema";
import { antiChurn, bandStopPct, marketDrawdownPct } from "../engine/exit";
import { OPEN_COST_ESTIMATE_SOL, PoolSnapshot, PositionSnapshot, quoteOf } from "../tools/dlmm";
import { jupiterEnv } from "../tools/jupiter";
import { isTradableVenue, tradableVenues } from "../venues/env";
import type { RiskLimits } from "./limits";
import type { RiskState } from "./state";

/** What the engine knows this cycle, as the guards need it. */
export interface EngineGuardContext {
  /** circuit breaker: opens halted until this epoch ms (null when not halted) */
  haltedUntil: number | null;
  /** portfolio breaker: standing down until this epoch ms (null when not) */
  standDownUntil: number | null;
  /** bench x regime; the effective max band size is limits.maxPositionSol x this */
  sizeMultiplier: number;
  benched: boolean;
  benchReason: string | null;
  regimeReason: string | null;
  /** the knife reason for this pool, or null */
  knife: string | null;
  /** position -> epoch ms first seen out of range */
  outOfRangeSince: Record<string, number>;
  /** position -> per-band stop percent rolled at open */
  stops: Record<string, number>;
  /** a band must sit out of range this many seconds before the LLM may move it */
  outOfRangeSec: number;
  /** the shorter wait an all-quote band may be re-laid after (POLICY_IDLE_RELAY_SEC); 0 = the ordinary minimum */
  idleRelaySec?: number;
  /** stock pools: why the basis/session rules refuse opens right now (src/basis), or null */
  basisReason?: string | null;
}

export const NO_ENGINE: EngineGuardContext = {
  haltedUntil: null,
  standDownUntil: null,
  sizeMultiplier: 1,
  benched: false,
  benchReason: null,
  regimeReason: null,
  knife: null,
  outOfRangeSince: {},
  stops: {},
  outOfRangeSec: 600,
};

export interface GuardContext {
  now: number;
  snapshot: PoolSnapshot;
  positions: PositionSnapshot[];
  /** the wallet's SOL: the gas reserve is checked against this whatever the pool's quote */
  walletSol: number;
  walletToken: number;
  /** the wallet's balance of the pool's QUOTE token in UI units (USDC for a USDC pool); defaults to walletSol, which is right for a SOL pool */
  walletQuote?: number;
  state: RiskState;
  killSwitch: boolean;
  /** SOL-equivalent value of bands in OTHER pools */
  otherExposureSol: number;
  /** pools (excluding this one) that currently hold a band */
  poolsWithBands: number;
  maxActivePools: number;
  /** the engine's view (src/engine); absent means no halts, no bench, full size, no per-band stops */
  engine?: EngineGuardContext;
  /** who made the proposal: anti-churn applies to the LLM only; an engine close is an emergency */
  source?: "llm" | "engine";
  /** the venue's up-front cost of the proposed open in SOL (position rent plus whatever the band must initialise); defaults to the Meteora estimate */
  openCostSol?: number;
}

export interface Verdict {
  /** what the LLM (or the engine) proposed */
  proposal: Decision;
  /** what will actually be executed (HOLD when blocked) */
  decision: Decision;
  allowed: boolean;
  violations: string[];
  overrides: string[];
  /** checks that passed, for the journal */
  passed: string[];
  /** true when the final decision came from a guard or an engine directive, not the LLM */
  emergency: boolean;
}

const isOpening = (d: Decision) => d.action === "OPEN_POSITION" || d.action === "REBALANCE";
const isClosing = (d: Decision) => d.action === "CLOSE_POSITION" || d.action === "REBALANCE";
const isInt = (n: number) => Number.isInteger(n);
const iso = (ms: number) => new Date(ms).toISOString();

export function evaluate(proposal: Decision, ctx: GuardContext, limits: RiskLimits): Verdict {
  const violations: string[] = [];
  const overrides: string[] = [];
  const passed: string[] = [];
  let decision: Decision = proposal;
  const source = ctx.source ?? "llm";
  const engine = ctx.engine ?? NO_ENGINE;
  // An engine exit (STOP / FLATTEN) is an emergency: it skips every rate limit.
  let emergency = source === "engine" && proposal.action === "CLOSE_POSITION";

  // 1. Stop-loss override, defense in depth under the engine's STOP directive. Uses the per-band
  //    stop rolled at open when present, else the configured limit.
  const atStop = ctx.positions.filter((p) => {
    const dd = marketDrawdownPct(p, ctx.snapshot, ctx.state.entryValueSol[p.address]);
    return dd !== null && dd >= bandStopPct(engine.stops, p.address, limits);
  });
  const closingAtStop = decision.action === "CLOSE_POSITION" ? atStop.find((p) => p.address === decision.positionAddress) : undefined;
  if (closingAtStop) {
    // The proposal already closes a band at its stop (an engine STOP, or the LLM agreeing): let it through as the emergency it is.
    const dd = marketDrawdownPct(closingAtStop, ctx.snapshot, ctx.state.entryValueSol[closingAtStop.address])!;
    passed.push(`stop-loss (closing ${closingAtStop.address.slice(0, 6)} at -${dd.toFixed(1)}%)`);
    emergency = true;
  }
  for (const p of closingAtStop ? [] : atStop) {
    const entry = ctx.state.entryValueSol[p.address];
    const dd = marketDrawdownPct(p, ctx.snapshot, entry);
    if (dd === null) continue;
    const stop = bandStopPct(engine.stops, p.address, limits);
    if (dd >= stop) {
      overrides.push(
        `stop-loss: ${p.address.slice(0, 6)} is ${dd.toFixed(1)}% below entry on its market value, fees aside (${entry.toFixed(4)} -> ${p.valueInSol.toFixed(4)} SOL with fees), stop ${stop.toFixed(2)}%; forcing CLOSE`,
      );
      decision = {
        action: "CLOSE_POSITION",
        open: null,
        positionAddress: p.address,
        // a band that fell through its stop is mostly token: sell it back to the quote, never leave it in the wallet
        liquidate: true,
        reasoning: `Stop-loss triggered by risk guards at -${dd.toFixed(1)}% (stop -${stop.toFixed(2)}%, limit -${limits.stopLossPct}%). Model proposal (${proposal.action}) overridden. The token comes off with it.`,
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

  // 4. Rate limits for anything that costs a transaction. Closes and emergencies are exempt: exits are never blocked.
  //    The daily cap counts every transaction. The cooldown is PER POOL and applies to band moves (opens and
  //    rebalances) only: a fee claim never resets it, and a move in one pool never blocks another pool.
  if (decision.action !== "HOLD" && decision.action !== "CLOSE_POSITION" && !emergency) {
    if (ctx.state.actionsToday >= limits.maxTxPerDay) {
      violations.push(`daily action cap reached (${ctx.state.actionsToday}/${limits.maxTxPerDay})`);
    } else {
      passed.push(`daily-cap ${ctx.state.actionsToday}/${limits.maxTxPerDay}`);
    }
    const lastMove = ctx.state.lastMoveByPool?.[ctx.snapshot.address] ?? null;
    if (isOpening(decision) && lastMove !== null) {
      const since = (ctx.now - lastMove) / 1000;
      if (since < limits.minSecondsBetweenActions) {
        violations.push(`cooldown: ${Math.round(since)}s since the last band move in this pool (min ${limits.minSecondsBetweenActions}s)`);
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

  // 6. Anti-churn: an LLM move of a band that has not sat out of range for the minimum is blocked
  //    (unless the band is already down half its stop). Never applied to engine directives or overrides.
  if (source === "llm" && !emergency && closing) {
    const churn = antiChurn(decision, ctx.positions, { ...ctx.state, stops: engine.stops, outOfRangeSince: engine.outOfRangeSince }, limits, engine.outOfRangeSec, ctx.now, ctx.snapshot, engine.idleRelaySec ? { sec: engine.idleRelaySec, quoteSide: quoteOf(ctx.snapshot).side } : undefined);
    if (churn) violations.push(churn);
    else passed.push("anti-churn");
  }

  // 7. Engine gates on opens: halt, stand-down, bench, regime, knife.
  if (isOpening(decision)) {
    if (engine.haltedUntil !== null && ctx.now < engine.haltedUntil) {
      violations.push(`circuit breaker: opens halted until ${iso(engine.haltedUntil)}`);
    }
    if (engine.standDownUntil !== null && ctx.now < engine.standDownUntil) {
      violations.push(`stand-down: portfolio breaker is standing down until ${iso(engine.standDownUntil)} (operator clears it)`);
    }
    if (engine.benched) violations.push(engine.benchReason ?? "benched: repeated stop-loss closes in this pool");
    if (engine.sizeMultiplier <= 0 && !engine.benched) violations.push(engine.regimeReason ?? "regime: opens off");
    if (engine.knife) violations.push(engine.knife);
    if (engine.basisReason) violations.push(engine.basisReason);
    if (violations.length === 0) passed.push("engine-gates");
  }

  // 8. Opening: size, exposure, quote balance, gas, geometry.
  //    `open.amountSol` is an amount of the pool's QUOTE token (SOL in a SOL pool, USDC in a USDC
  //    pool). Sizes, exposure and caps are SOL-denominated: a quote figure converts at
  //    quotePriceInSol (1 for SOL). The deposit is checked against the quote balance; the gas
  //    reserve against the real SOL balance, which a USDC deposit spends only on rent and fees.
  //    A BOTH band with `acquireToken` (the stock straddle) also spends quote on the swap that
  //    brings the token in: acquireToken x price x (1 + maxSlippagePct), so the quote must cover
  //    the quote half AND the purchase; the token check counts what the swap brings in (and, on a
  //    REBALANCE, the base token the closing band hands back). Both legs count toward the size.
  if (isOpening(decision)) {
    // the venue gate: we manage what we hold on any venue, but we only OPEN on a tradable one
    const venueId = ctx.snapshot.venue ?? "meteora-dlmm";
    if (!isTradableVenue(venueId)) violations.push(`venue: ${venueId} is not in TRADABLE_VENUES (${tradableVenues().join(", ") || "none"}); holding what we hold there, opening nothing new`);
    const o = decision.open;
    if (!o) {
      violations.push("OPEN/REBALANCE without `open` parameters");
    } else {
      const s = ctx.snapshot;
      const q = quoteOf(s);
      const quoteIsSol = q.symbol === "SOL";
      const walletQuote = ctx.walletQuote ?? ctx.walletSol;
      const sizeQuote = o.amountSol + o.amountToken * q.tokenPriceInQuote;
      const sizeSol = sizeQuote * q.priceInSol;
      const sizeLabel = quoteIsSol ? `${sizeSol.toFixed(4)} SOL` : `${sizeSol.toFixed(4)} SOL (${sizeQuote.toFixed(2)} ${q.symbol})`;
      const currentExposure = ctx.positions.reduce((sum, p) => sum + p.valueInSol, 0);
      const exposureAfter = ctx.otherExposureSol + currentExposure - (closing?.valueInSol ?? 0) + sizeSol;
      // the token the swap must bring in before the deposit (stock straddles); the quote pays for it, with slippage
      const acquireRaw = o.acquireToken ?? 0;
      const acquire = Number.isFinite(acquireRaw) && acquireRaw > 0 ? acquireRaw : 0;
      // budget the purchase at the WIDER of the guard's slippage and the swap's own tolerance
      // (SWAP_SLIPPAGE_BPS): the executor sizes the Jupiter leg with the latter, and the wallet must
      // cover what the executor will actually spend, not what this file would like it to spend
      const swapSlipPct = Math.max(limits.maxSlippagePct, jupiterEnv().slippageBps / 100);
      const acquireQuote = acquire * q.tokenPriceInQuote * (1 + swapSlipPct / 100);
      const quoteSpend = o.amountSol + acquireQuote;
      // what a closing band (REBALANCE) hands back in quote units before it is re-laid
      const closingQuote = closing ? (closing.quoteInPosition ?? closing.solInPosition / q.priceInSol) : 0;
      // and in base token units (incl. its unclaimed base fees)
      const closingToken = closing ? (q.side === "X" ? closing.amountY + closing.feeY : closing.amountX + closing.feeX) : 0;
      const walletQuoteAfter = walletQuote + closingQuote - quoteSpend;
      // SOL: the deposit (and the purchase) only when the quote is SOL; rent + fees always
      const walletSolAfterClose = ctx.walletSol + (quoteIsSol ? (closing?.solInPosition ?? 0) : 0);
      const openCost = typeof ctx.openCostSol === "number" && Number.isFinite(ctx.openCostSol) && ctx.openCostSol >= 0 ? ctx.openCostSol : OPEN_COST_ESTIMATE_SOL;
      const walletSolAfter = walletSolAfterClose - (quoteIsSol ? quoteSpend : 0) - openCost;
      const width = o.binsBelowActive + o.binsAboveActive + 1;
      const mult = Math.min(Math.max(engine.sizeMultiplier, 0), 1);
      const effectiveMax = limits.maxPositionSol * mult;

      if (!(o.amountSol >= 0) || !(o.amountToken >= 0) || sizeSol <= 0) violations.push("deposit amounts must be positive");
      if (!(acquireRaw >= 0) || !Number.isFinite(acquireRaw)) violations.push("acquireToken must be a non-negative number");
      if (acquire > 0 && o.side !== "BOTH") violations.push("acquireToken is only for a BOTH band (the stock straddle)");
      if (acquire > o.amountToken) violations.push(`acquireToken ${acquire} exceeds the token leg ${o.amountToken}: nothing to buy beyond the deposit`);
      if (sizeSol > limits.maxPositionSol) {
        violations.push(`band size ${sizeLabel} > max ${limits.maxPositionSol}`);
      } else if (mult > 0 && mult < 1 && sizeSol > effectiveMax) {
        violations.push(`band size ${sizeLabel} > max ${effectiveMax.toFixed(4)} (${mult} x limit after bench/regime)`);
      }
      if (exposureAfter > limits.maxTotalExposureSol) violations.push(`total exposure would be ${exposureAfter.toFixed(4)} SOL > max ${limits.maxTotalExposureSol}`);
      if (walletQuoteAfter < 0) {
        const want = acquire > 0 ? `${o.amountSol} + ${acquireQuote.toFixed(quoteIsSol ? 4 : 2)} to buy ${acquire} ${s.baseToken.symbol} (incl. ${swapSlipPct}% slippage)` : `${o.amountSol}`;
        violations.push(`not enough ${q.symbol}: want ${want}, have ${walletQuote}${closing ? ` + ${closingQuote.toFixed(4)} back from the closing band` : ""}`);
      }
      if (walletSolAfter < limits.gasReserveSol) {
        violations.push(
          quoteIsSol
            ? `wallet would hold ${walletSolAfter.toFixed(4)} SOL after deposit + ~${openCost.toFixed(3)} rent, below gas reserve ${limits.gasReserveSol}`
            : `wallet would hold ${walletSolAfter.toFixed(4)} SOL after ~${openCost.toFixed(3)} rent (the ${q.symbol} deposit spends no SOL), below gas reserve ${limits.gasReserveSol}`,
        );
      }
      if (o.amountToken > ctx.walletToken + acquire + closingToken) {
        violations.push(`not enough ${s.baseToken.symbol}: want ${o.amountToken}, have ${ctx.walletToken}${acquire > 0 ? ` + ${acquire} bought` : ""}${closing ? ` + ${closingToken.toFixed(6)} back from the closing band` : ""}`);
      }
      if (!isInt(o.binsBelowActive) || !isInt(o.binsAboveActive) || o.binsBelowActive < 0 || o.binsAboveActive < 0) {
        violations.push("bin counts must be non-negative integers");
      }
      if (width > limits.maxBinWidth) violations.push(`band width ${width} bins > max ${limits.maxBinWidth}`);
      if (ctx.positions.length === 0 && !closing && ctx.poolsWithBands >= ctx.maxActivePools) {
        violations.push(`already working ${ctx.poolsWithBands} pools (max ${ctx.maxActivePools})`);
      }

      // Geometry: the quote sits below active when the quote is Y, above when the quote is X. The base is the opposite.
      // SOL_ONLY reads as "quote-only" (SOL in a SOL pool, USDC in a USDC pool); the enum value is kept.
      const quoteBelow = q.side === "Y";
      const sideName = quoteIsSol ? "SOL_ONLY" : `SOL_ONLY (${q.symbol}-only)`;
      if (o.side === "SOL_ONLY") {
        if (o.amountToken !== 0) violations.push(`${sideName} band must not deposit token`);
        if (o.amountSol <= 0) violations.push(`${sideName} band needs amountSol > 0 (${q.symbol})`);
        if (quoteBelow ? o.binsAboveActive !== 0 : o.binsBelowActive !== 0) {
          violations.push(`${sideName} band must sit ${quoteBelow ? "at/below" : "at/above"} the active bin`);
        }
        // a CLMM single-sided band cannot include the active bin, so with no bins on its side there is no band at all
        if ((quoteBelow ? o.binsBelowActive : o.binsAboveActive) < 1) violations.push(`${sideName} band needs at least one bin ${quoteBelow ? "below" : "above"} the active bin`);
      } else if (o.side === "TOKEN_ONLY") {
        if (o.amountSol !== 0) violations.push(`TOKEN_ONLY band must not deposit ${q.symbol}`);
        if (o.amountToken <= 0) violations.push("TOKEN_ONLY band needs amountToken > 0");
        if (quoteBelow ? o.binsBelowActive !== 0 : o.binsAboveActive !== 0) {
          violations.push(`TOKEN_ONLY band must sit ${quoteBelow ? "at/above" : "at/below"} the active bin`);
        }
        if ((quoteBelow ? o.binsAboveActive : o.binsBelowActive) < 1) violations.push(`TOKEN_ONLY band needs at least one bin ${quoteBelow ? "above" : "below"} the active bin`);
      } else if (o.side === "BOTH") {
        // a straddle: both tokens, at least one bin on each side of the active bin
        if (o.amountSol <= 0 || o.amountToken <= 0) violations.push(`BOTH band needs amountSol > 0 (${q.symbol}) and amountToken > 0 (${s.baseToken.symbol})`);
        if (o.binsBelowActive < 1 || o.binsAboveActive < 1) violations.push("BOTH band must straddle the active bin: binsBelowActive >= 1 and binsAboveActive >= 1");
      }
      if (violations.length === 0) passed.push(`open size ${sizeLabel}, width ${width}, exposure after ${exposureAfter.toFixed(4)}`);
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
