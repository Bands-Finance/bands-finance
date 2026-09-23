import { quoteOf, type PoolSnapshot, type PositionSnapshot } from "../tools/dlmm";
import type { PoolAnalytics } from "../tools/lpagent";
import type { FlowContext } from "../scouts/flow";
import type { LearnedFactor, LearnedView } from "../learn/surface";

export interface ScreenContext {
  rank: number;
  rankedPools: number;
  score: number;
  feeToTvl24hPct: number | null;
  volume24hUsd: number | null;
  tvlUsd: number | null;
  ageHours: number | null;
  priceChange24hPct: number | null;
  flags: string[];
  /** the operator put this token on the watchlist: their judgement stands in for the screener's score */
  watchlisted?: boolean;
  /**
   * The LAUNCH LANE admitted this pool (src/screener/launch.ts): too new for the board, the score or
   * a hand-written list, but already carrying real two-sided flow. Present and ok means the desk may
   * take it under harsher terms (a capped seat, a tighter stop, a maximum hold, a volume-fade exit);
   * null or absent means the ordinary rules apply.
   */
  launch?: { ok: true; ageHours: number; turnover: number } | null;
  /**
   * The PAIR LANE (src/screener/pair.ts): this pool is OUR OWN pool for a pump.fun token (or the one
   * the desk seats in when the pair already exists), admitted on the reference PumpSwap pool's
   * numbers. The snapshot's `pair` carries the model; this says the lane admitted it, and on what.
   */
  pair?: { ok: true; ageHours: number; turnover: number } | null;
  /** how far the price travelled in the last hour, high to low, in percent: what the band must survive */
  recentMovePct?: number | null;
  /**
   * the same hour's travel measured from the loop's samples BEFORE this cycle's: what the pool moved before the
   * move this cycle saw. The gap to recentMovePct is the last move's own travel, which widens a band and must not
   * grow its seat (src/agent/policy.ts sizeBand). Null when there are not samples enough to say.
   */
  priorMovePct?: number | null;
  generatedAt: string;
  /** the screen's stock tag when the base is a tokenized stock (the stock book's pools) */
  stock?: { ticker: string; issuer: string } | null;
  /**
   * PINNED: the agent is paired with this stock (PAIR_STOCK_PINNED_TICKERS; the Clawrena entry is paired
   * with NVDA). The pool is a Meteora pool for the ticker, either one that already trades (the desk
   * supplements its liquidity) or our own. The volume, score, yield and payback floors and the thin flag
   * are waived; the guards, the stop, the basis check and the session rules are not.
   */
  pinned?: { ok: true; ticker: string } | null;
  /** the flow scout's last hour for this pool (src/scouts/flow.ts), when the scout is running and fresh */
  flow?: FlowContext | null;
  alternatives: { name: string; score: number; feeToTvl24hPct: number | null; tvlUsd: number | null }[];
  /** the fast watch's surges (src/hot): what printed fees in the last hour, across every venue, and this pool's own row whatever its flags */
  hot?: {
    name: string;
    venue: string;
    tradable: boolean;
    thisPool: boolean;
    /** false: this pool's own row, shown for its flags and its 1h move, which is not on the tradable hot list (flagged new, dumping or wild, or under the list's floors); absent reads as a pick */
    pick?: boolean;
    liquidityUsd: number | null;
    vol1hUsd: number | null;
    feeToTvlDailyPct: number | null;
    acceleration: number | null;
    priceChange1hPct: number | null;
    heat: number;
    flags: string[];
    surge: boolean;
  }[];
}

export interface PortfolioContext {
  activePools: string[];
  poolsWithBands: number;
  maxActivePools: number;
  otherExposureSol: number;
}

export interface JournalGlimpse {
  ts: string;
  action: string;
  allowed: boolean;
  headline: string;
  violations: string[];
}

/** What the engine (src/engine) has decided about this pool this cycle, as the LLM should see it. */
export interface EngineObservation {
  halt: { until: number; stage: number | null; reason: string | null } | null;
  standDown: { until: number; reason: string | null } | null;
  bench: { stops6h: number; multiplier: number; benched: boolean; reason: string | null };
  regime: { medianMove24hPct: number | null; multiplier: number; reason: string | null };
  sizeMultiplier: number;
  effectiveMaxPositionSol: number;
  /** position -> stop percent for this band */
  stops: Record<string, number>;
  /** position -> seconds out of range so far */
  outOfRangeSec: Record<string, number>;
  minOutOfRangeSec: number;
  knife: string | null;
  collectsToday: number;
  collectMaxPerDay: number;
  /** stock pools only: the US session clock and the gap between the pool and Backpack's perp */
  basis?: {
    session: "closed" | "pre" | "regular" | "after";
    minutesToOpen: number;
    basisPct: number | null;
    perpSymbol: string | null;
    perpMid: number | null;
    widthMultiplier: number;
    reason: string | null;
  };
}

/** Everything Mr Bands gets to see for one decision. */
export interface Observation {
  ts: string;
  cycle: number;
  mode: "dry-run" | "live";
  poolLabel: string;
  snapshot: PoolSnapshot;
  positions: PositionSnapshot[];
  /** quote / quoteSymbol: the wallet's balance of the pool's quote token (absent or = sol for a SOL pool) */
  wallet: { address: string; sol: number; token: number; tokenSymbol: string; quote?: number; quoteSymbol?: string };
  analytics: PoolAnalytics | null;
  /** hotHeldAt: position -> when the policy gave that band its one more cycle on a hot pool (RiskState.hotHeldAt) */
  state: { actionsToday: number; lastActionAt: number | null; lastMoveAt?: number | null; lastPrice: number | null; killSwitch: boolean; hotHeldAt?: Record<string, number> };
  recent: JournalGlimpse[];
  screen: ScreenContext | null;
  /** the flow scout's reading for a pool that has no screen context (a pick off the board); a board pool carries it on `screen.flow` */
  flow?: NonNullable<ScreenContext["flow"]> | null;
  portfolio: PortfolioContext;
  engine: EngineObservation | null;
  /**
   * WHAT HE HAS LEARNED (src/learn/surface.ts), built for THIS pool and populated by the desk loop.
   * Until it is set he is shown only what he proposed and whether the guards allowed it, never what
   * a seat earned, which is the whole reason nothing he does gets better. The block it renders is
   * bounded: 5 closed seats, a 7-day window, and LEARNED_BUDGET_CHARS of text.
   */
  learned?: LearnedView | null;
}

/**
 * The character budget for the '## What you have learned' block. His whole observation is about
 * 1,070 characters today, so the block is not allowed to be the observation: seats are dropped
 * oldest-first until it fits, and the line that says how many were dropped is kept.
 */
export const LEARNED_BUDGET_CHARS = 1200;

const r = (n: number | null | undefined, digits = 4) =>
  n === null || n === undefined || !Number.isFinite(n) ? "n/a" : Number(n.toFixed(digits)).toString();
const usdShort = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? "n/a" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`;
const sig = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? "n/a" : n.toPrecision(6);

/** A signed SOL figure, 3 decimals, always with its sign so a loss reads as a loss. */
const solSigned = (n: number | null | undefined, digits = 3) =>
  n === null || n === undefined || !Number.isFinite(n) ? "n/a" : `${n >= 0 ? "+" : "-"}${Math.abs(n).toFixed(digits)}`;

/**
 * '## What you have learned': the one block that shows him an OUTCOME. Everything else in the
 * observation is the present tense (what the pool looks like, what the guards say); this is what his
 * last seats in THIS pool actually did, how his forecast has scored against reality, and which knob
 * is in force with the sample behind it.
 *
 * Two rules it keeps, both tested:
 *   NEVER A FACTOR WITHOUT ITS SAMPLE. Under the minimum the shipped default stands and the line
 *   says so with the count, so he can never read a number as evidence it is not.
 *   NEVER OVER BUDGET. Seats are dropped oldest-first until the block fits LEARNED_BUDGET_CHARS,
 *   and the drop is stated rather than hidden.
 * The block also says plainly whether his model is on, because while it is off these knobs moved by
 * his rulebook and nothing here was reasoned by him.
 */
export function formatLearned(v: LearnedView, budget = LEARNED_BUDGET_CHARS): string {
  const head: string[] = ["## What you have learned"];
  head.push(
    `- book: ${v.mode}. ${v.modelOn ? "Your model is answering." : "Your model is off (no gateway token): these knobs moved by your rulebook, not by you."}` +
      `${v.frozen.all ? " Learning is FROZEN: nothing below will move until it is switched back on." : ""}`,
  );
  const refusedSeats = Object.entries(v.refused.lessons);
  if (refusedSeats.length || v.refused.changes > 0) {
    head.push(
      `- ${refusedSeats.map(([m, n]) => `${n} seat(s) from the ${m} book`).join(", ")}${v.refused.changes ? `${refusedSeats.length ? " and " : ""}${v.refused.changes} change(s) from another book` : ""} are on this file and are NOT counted below: a number learned on one book does not carry to another.`,
    );
  }
  const ratio = v.lessons.ratio;
  head.push(
    ratio
      ? `- your entry forecast has come in at a median ${ratio.median.toFixed(2)} of realised over ${ratio.n} closed seats, too high ${ratio.tooHigh} times. Read your own forecast as a ceiling.`
      : `- no closed seat has scored your entry forecast yet (${v.lessons.total} lessons on the book): your forecast is unproven, not proven right.`,
  );
  // a pool-scoped view carries this pool's lane and this pool's penalty; a book-wide one carries every lane
  for (const f of v.factors) head.push(learnedFactorLine(f));
  const seatHead = v.pool && v.seats.length > 0 ? `- your last ${v.seats.length} closed seat(s) in ${v.pool.label}, newest first:` : null;
  const seatLines = v.seats.map(
    (s) =>
      `  - ${Math.round(s.minutes)}m, ${s.bins} bins, ${s.coverPct === null ? "n/a" : `${s.coverPct.toFixed(1)}%`} cover, ${s.inRangePct === null ? "n/a" : `${Math.round(s.inRangePct)}%`} in range, ended ${s.endReason}: ` +
      `fees ${solSigned(s.feesSol)}, net ${solSigned(s.netSol)} SOL${s.netExDriftSol === null ? "" : ` (${solSigned(s.netExDriftSol)} ex-drift)`}, ` +
      `forecast ${s.predictedYieldPct === null ? "none" : `${s.predictedYieldPct.toFixed(1)}%/day`} -> realised ${s.realizedYieldPctPerDay === null ? "n/a" : `${s.realizedYieldPctPerDay.toFixed(1)}%/day`}`,
  );
  if (v.pool && v.seats.length === 0) head.push(`- no closed seat in ${v.pool.label} in the last week: you have no record here to argue from.`);

  // fit the budget by dropping the oldest seats, and say how many were dropped rather than hide it
  let shown = seatLines.length;
  const render = (n: number): string => {
    const lines = [...head];
    if (seatHead && n > 0) {
      lines.push(seatHead);
      lines.push(...seatLines.slice(0, n));
      if (n < seatLines.length) lines.push(`  - (${seatLines.length - n} older seat(s) not shown)`);
    }
    return lines.join("\n");
  };
  let out = render(shown);
  while (out.length > budget && shown > 0) out = render(--shown);
  return out;
}

/**
 * One knob, never printed without the sample it rests on, and never printed as unmoved when it has
 * moved. THE ORDER MATTERS: a knob that was journalled is what the desk is pricing at RIGHT NOW,
 * whatever its sample reads today (a window empties, a threshold is raised, the seats that bought it
 * age out). Under-sample used to win, so he could be shown "x0.50, the shipped default: not enough
 * seats yet, 0 of the 20 it needs, so it has not moved" while the desk priced every seat at 0.45 and
 * the change that made it was listed in the journal two lines below. So: moved first, with its
 * evidence and its sample stated honestly; the default only while nothing has moved.
 */
function learnedFactorLine(f: LearnedFactor): string {
  const what = f.knob === "calibration" ? `${f.lane} forecast factor` : `this pool's size penalty`;
  const state =
    f.lastMovedAt !== null
      ? `x${f.factor.toFixed(2)}, in force now on ${f.n} scored seat(s)${f.underSample ? `, which is under the ${f.minSample} a fresh move needs, so it stands where it was left` : ""} (${f.why ?? "no evidence sentence was journalled"})`
      : f.underSample
        ? `x${f.defaultFactor.toFixed(2)}, the shipped default: not enough seats yet, ${f.n} of the ${f.minSample} it needs, so it has not moved`
        : `x${f.defaultFactor.toFixed(2)}, the shipped default: ${f.n} seats say it may move, and it has not moved yet`;
  return `- ${what}: ${state}${f.frozen ? " [frozen]" : ""}. It can only ever make a seat smaller.`;
}

export function formatObservation(o: Observation): string {
  const s = o.snapshot;
  const q = quoteOf(s);
  const quoteIsSol = q.symbol === "SOL";
  /** a SOL-equivalent figure with its quote figure beside it in a USDC pool; the plain SOL figure in a SOL pool */
  const solAndQuote = (sol: number, digits = 4) => (quoteIsSol ? `${r(sol, digits)} SOL` : `${r(sol, digits)} SOL (${r(sol / q.priceInSol, 2)} ${q.symbol})`);
  const lines: string[] = [];
  lines.push(`# Observation ${o.ts} (cycle ${o.cycle}, mode ${o.mode})`);
  lines.push("");
  lines.push(`## Pool ${s.label} (${s.address})`);
  lines.push(`- token X: ${s.tokenX.symbol} (${s.tokenX.decimals} dec), reserve ${r(s.tokenX.reserve, 2)}`);
  lines.push(`- token Y: ${s.tokenY.symbol} (${s.tokenY.decimals} dec), reserve ${r(s.tokenY.reserve, 2)}`);
  lines.push(`- SOL is token ${s.solSide ?? "neither"}; base token is ${s.baseToken.symbol}`);
  lines.push(
    `- QUOTE token is ${q.symbol} (token ${q.side}): in this pool SOL_ONLY means ${q.symbol}-only and amountSol is an amount of ${q.symbol}. ` +
      `A ${q.symbol}-only band sits ${q.side === "Y" ? "at/below" : "at/above"} the active bin; a ${s.baseToken.symbol}-only band ${q.side === "Y" ? "at/above" : "at/below"} it.`,
  );
  if (!quoteIsSol) {
    lines.push(`- SOL price: ${s.solPriceUsd ? `$${r(s.solPriceUsd, 2)}` : "n/a"} -> 1 ${q.symbol} = ${r(q.priceInSol, 6)} SOL; ${s.baseToken.symbol} = ${sig(q.tokenPriceInQuote)} ${q.symbol} = ${sig(s.tokenPriceInSol)} SOL`);
  } else if (s.solPriceUsd) {
    lines.push(`- SOL price: $${r(s.solPriceUsd, 2)}`);
  }
  lines.push(`- venue: ${s.venue ?? "meteora-dlmm"}${s.priceModel === "clmm" ? " (CLMM: one bin = one tick-spacing step; a single-sided band sits strictly to one side of the price, so it excludes the active bin)" : ""}`);
  lines.push(`- bin step: ${s.binStep} bps | active bin: ${s.activeBinId} | price: ${sig(s.activePrice)} ${s.priceLabel}`);
  lines.push(`- fees: base ${r(s.baseFeePct, 3)}% | dynamic now ${r(s.dynamicFeePct, 3)}% | max ${r(s.maxFeePct, 2)}%`);
  lines.push(`- observed depth: ${r(s.liquidityBelowY, 3)} ${s.tokenY.symbol} below active, ${r(s.liquidityAboveX, 2)} ${s.tokenX.symbol} above`);
  if (o.state.lastPrice) {
    const move = (s.activePrice / o.state.lastPrice - 1) * 100;
    lines.push(`- price change since last cycle: ${move >= 0 ? "+" : ""}${r(move, 2)}%`);
  }
  lines.push("");
  lines.push("## Bins around active (binId | price | X | Y)");
  for (const b of s.bins) {
    lines.push(`${b.isActive ? ">" : " "} ${b.binId} | ${sig(b.price)} | ${r(b.xAmount, 2)} | ${r(b.yAmount, 4)}${b.isActive ? "  <- ACTIVE" : ""}`);
  }
  lines.push("");
  lines.push("## External analytics");
  if (o.analytics) {
    const a = o.analytics;
    lines.push(`- source: ${a.source} (${a.note})`);
    lines.push(`- price USD: ${sig(a.priceUsd)} | 24h change: ${r(a.priceChange24hPct, 2)}%`);
    lines.push(`- 24h volume: $${r(a.volume24hUsd, 0)} | TVL: $${r(a.tvlUsd, 0)} | est. 24h fees: $${r(a.fees24hUsd, 0)} | fee/TVL 24h: ${r(a.feeToTvl24hPct, 3)}%`);
    lines.push(`- 24h txns: ${a.txns24h ?? "n/a"}`);
  } else {
    lines.push("- unavailable this cycle");
  }
  if (o.screen?.flow ?? o.flow) {
    const f = (o.screen?.flow ?? o.flow)!;
    lines.push(`- FLOW, read from the chain by the scout (${Math.round((Date.now() - f.asOf) / 1000)}s ago): last 15 min ${f.swaps15m} swaps, ${r(f.volume15mQuote, 3)} ${f.quoteSymbol} traded, ${r(f.fees15mQuote, 4)} ${f.quoteSymbol} of LP fees (${r(f.ours15mQuote, 4)} in the bins your band covers); last hour ${f.swaps60m} swaps, ${r(f.fees60mQuote, 4)} ${f.quoteSymbol} of fees${f.feesPerDayQuote60m !== null ? `, a ${r(f.feesPerDayQuote60m, 3)} ${f.quoteSymbol}/day pace` : ""}. This beats the 24h figures above when they disagree.`);
  }
  lines.push("");
  lines.push(`## Wallet ${o.wallet.address}`);
  const walletQuote = o.wallet.quote ?? (quoteIsSol ? o.wallet.sol : undefined);
  lines.push(
    `- ${r(o.wallet.sol, 4)} SOL${quoteIsSol ? " (the quote; rent and fees come out of it too)" : " (rent and fees only)"}` +
      (quoteIsSol ? "" : ` | ${r(walletQuote, 2)} ${q.symbol} (the quote: what a SOL_ONLY band deposits here${walletQuote !== undefined ? `, = ${r(walletQuote * q.priceInSol, 4)} SOL` : ""})`) +
      ` | ${r(o.wallet.token, 2)} ${o.wallet.tokenSymbol}`,
  );
  lines.push("");
  lines.push(`## Open bands (${o.positions.length})`);
  if (o.positions.length === 0) lines.push("- none");
  for (const p of o.positions) {
    lines.push(
      `- ${p.address}: bins [${p.lowerBinId}, ${p.upperBinId}] (${p.widthBins} wide) price [${sig(p.lowerPrice)}, ${sig(p.upperPrice)}] ` +
        `${p.inRange ? "IN RANGE" : `OUT OF RANGE by ${Math.abs(p.binsFromRange)} bins (${p.binsFromRange < 0 ? "price below band" : "price above band"})`} | ` +
        `holds ${r(p.amountX, 2)} ${s.tokenX.symbol} + ${r(p.amountY, 4)} ${s.tokenY.symbol} | unclaimed fees ${r(p.feeX, 2)} ${s.tokenX.symbol} + ${r(p.feeY, 5)} ${s.tokenY.symbol} | value ${solAndQuote(p.valueInSol)}`,
    );
  }
  lines.push("");
  lines.push("## Risk bookkeeping");
  lines.push(`- actions today: ${o.state.actionsToday}`);
  lines.push(`- last action: ${o.state.lastActionAt ? `${Math.round((Date.now() - o.state.lastActionAt) / 60000)} min ago` : "never"}; last band move in THIS pool: ${o.state.lastMoveAt ? `${Math.round((Date.now() - o.state.lastMoveAt) / 60000)} min ago (the cooldown is per pool)` : "never"}`);
  lines.push(`- kill switch: ${o.state.killSwitch ? "ACTIVE (no new exposure)" : "off"}`);
  if (o.screen?.launch?.ok) {
    lines.push(
      `- LAUNCH LANE: this pool is ${r(o.screen.launch.ageHours, 1)}h old and turning over ${r(o.screen.launch.turnover, 1)}x its liquidity a day. It is admitted by rule, not by score or watchlist. ` +
        `A launch seat is capped, stopped tighter, held for a limited time and closed when the volume fades: size it small and do not argue with the exit.`,
    );
  }
  if (o.screen?.pair?.ok && s.pair) {
    const p = s.pair;
    const pctOf = (x: number) => `${(x * 100).toFixed(1)}%`;
    const state = p.exists ? (p.ours ? "created by this desk" : "an existing Meteora pool for the pair, which the desk seats in instead of creating one") : `not created yet: the first OPEN creates it, paying ${r(p.creationRentSol, 4)} SOL of rent that never comes back`;
    lines.push(
      `- PAIR LANE: this is OUR OWN pool for ${p.symbol} (${state}), ${r(s.binStep / 100, 2)}% per bin, ${r(s.baseFeePct, 2)}% fee, fees collected in ${p.collectFeeMode === "quote" ? `${p.quote} only` : "both tokens"}. ` +
        `The reference market is ${p.refVenue ?? "PumpSwap"}${p.refPool ? ` ${p.refPool.slice(0, 6)}` : ""}: ${usdShort(p.refLiquidityUsd)} of liquidity, ${usdShort(p.refVol24hUsd)} traded in 24h, ${usdShort(p.refVol1hUsd)} in the last hour, ${r(o.screen.pair.ageHours, 1)}h old, turning over ${r(o.screen.pair.turnover, 1)}x a day` +
        `${p.stale ? " (the reference row has gone cold: this price is the last one seen and the fade exit is on its way)" : ""}. ` +
        `Routing model: a ${usdShort(p.seatUsd)} seat is the cheaper route for ${pctOf(p.routedShareGross)} of that flow by value` +
        `${p.competingDepthUsd > 0 ? ` (${pctOf(p.routedShare)} after sharing with ${usdShort(p.competingDepthUsd)} of other concentrated depth)` : ""}, about ${usdShort(p.feesPerDayUsd)} a day at our fee, all of it ours while nobody else is in the pool. ` +
        `A pair seat is a two-sided band around the active bin, half ${p.quote} half ${p.symbol} (the ${p.symbol} half bought through Jupiter first); it is capped, stopped tighter, held for a limited time and closed when the reference volume fades, and every close sells the ${p.symbol} back to ${p.quote}.`,
    );
  }
  lines.push("");
  if (o.screen?.hot?.length) {
    lines.push("## Hot right now (fees in the last hour, from the fast watch)");
    lines.push("Daily pace = what a dollar in the pool earned in the last hour, times 24. Acceleration = last hour versus the 24h rate.");
    for (const h of o.screen.hot) {
      lines.push(
        `- ${h.thisPool ? "THIS POOL: " : ""}${h.name} on ${h.venue}${h.tradable ? "" : " (not tradable yet)"}${h.pick === false ? " (not on the tradable list)" : ""}: liquidity ${usdShort(h.liquidityUsd)}, vol 1h ${usdShort(h.vol1hUsd)}, daily pace ${r(h.feeToTvlDailyPct, 2)}%, acceleration ${r(h.acceleration, 1)}x, 1h move ${r(h.priceChange1hPct, 1)}%, heat ${r(h.heat, 0)}${h.surge ? ", SURGE" : ""}${h.flags.length ? ` [${h.flags.join(", ")}]` : ""}`,
      );
    }
    lines.push("");
  }
  lines.push("## Engine");
  const e = o.engine;
  if (!e) {
    lines.push("- no engine view this cycle");
  } else {
    const mins = (ms: number) => Math.max(0, Math.round((ms - Date.now()) / 60000));
    lines.push(`- circuit breaker: ${e.halt ? `HALTED (stage ${e.halt.stage ?? "?"}), opens blocked for ${mins(e.halt.until)} more min: ${e.halt.reason ?? ""}` : "clear"}`);
    lines.push(`- portfolio breaker: ${e.standDown ? `STANDING DOWN for ${mins(e.standDown.until)} more min, every band is being closed: ${e.standDown.reason ?? ""}` : "clear"}`);
    lines.push(`- bench: ${e.bench.benched ? "BENCHED, no opens in this pool" : e.bench.stops6h === 0 ? "clear" : `${e.bench.stops6h} stop(s) in 6h, size x${e.bench.multiplier}`}`);
    lines.push(`- board regime: median 24h move ${e.regime.medianMove24hPct === null ? "n/a" : `${r(e.regime.medianMove24hPct, 2)}%`}, size x${e.regime.multiplier}${e.regime.multiplier === 0 ? " (opens off)" : ""}`);
    lines.push(`- size multiplier in force: x${e.sizeMultiplier} -> max band ${solAndQuote(e.effectiveMaxPositionSol)}`);
    lines.push(`- knife: ${e.knife ?? "clear"}`);
    lines.push(`- fee claims today: ${e.collectsToday}/${e.collectMaxPerDay} (the engine claims on its own schedule)`);
    lines.push(`- minimum out-of-range time before you may REBALANCE/CLOSE an out-of-range band: ${e.minOutOfRangeSec}s`);
    if (e.basis) {
      const b = e.basis;
      lines.push(`- tokenized stock: US market ${b.session}${b.session === "closed" || b.session === "pre" ? ` (${b.minutesToOpen} min to the open)` : ""}; use x${b.widthMultiplier} the band width you would use in regular hours`);
      lines.push(`- basis vs Backpack ${b.perpSymbol ?? "(no perp listed)"}: ${b.basisPct === null ? "n/a" : `${b.basisPct >= 0 ? "+" : ""}${r(b.basisPct, 2)}% (pool above the perp means arbitrage flow will sell into a bid band)`}${b.perpMid !== null ? `, perp mid ${b.perpMid}` : ""}`);
      if (b.reason) lines.push(`- basis rule: ${b.reason} (opens are refused this cycle)`);
    }
    for (const p of o.positions) {
      const stop = e.stops[p.address];
      const oor = e.outOfRangeSec[p.address] ?? 0;
      lines.push(`- band ${p.address.slice(0, 6)}: stop ${stop === undefined ? "n/a" : `-${r(stop, 2)}%`} (the engine closes it there) | out of range ${p.inRange ? "0s" : `${Math.round(oor)}s`}${!p.inRange && oor < e.minOutOfRangeSec ? " (below the minimum: moving it now is churn)" : ""}`);
    }
  }
  lines.push("");
  if (o.learned) {
    lines.push(formatLearned(o.learned));
    lines.push("");
  }
  lines.push("## Your recent decisions (newest first)");
  if (o.recent.length === 0) lines.push("- none yet");
  for (const g of o.recent) {
    lines.push(`- ${g.ts} ${g.action} ${g.allowed ? "ok" : `BLOCKED: ${g.violations.join("; ")}`} - "${g.headline}"`);
  }
  return lines.join("\n");
}
