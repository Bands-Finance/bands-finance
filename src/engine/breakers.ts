/**
 * The breakers: pure state machines over DATA_DIR/engine-state.json. Ports of
 *   - the bench ladder and board regime gauge in Meridian's agent/src/memeGuard.ts
 *     (stopsInWindow / entrySizeMultiplier / boardRegimeMultiplier),
 *   - the daily-loss circuit breaker with its halt stages in memeGuard.ts (noteBookMark),
 *   - the whole-book portfolio breaker in agent/src/portfolioBreaker.ts (portfolioVerdict).
 *
 * Every verdict function is pure: (state, mark, now) -> next state + verdict. The loop feeds
 * marks only on good reads (a failed observation never becomes a phantom crater), persists the
 * returned state, and the guards read the result. A missing state file is the empty state; all
 * timestamps are epoch ms. Halts and stand-downs block opens only: exits never consult them.
 * The operator clears a stand-down or a halt with `tsx src/scripts/engine.ts`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataPath } from "../lib/ledger";

export const ENGINE_STATE_FILE = "engine-state.json";

export const BENCH_WINDOW_MS = 6 * 60 * 60 * 1000;
export const STAGE1_HALT_MS = 4 * 60 * 60 * 1000;
export const STAGE2_HALT_MS = 6 * 60 * 60 * 1000;
export const STAND_DOWN_MS = 12 * 60 * 60 * 1000;
export const LOSS_PCT = 15;
export const CIRCUIT_CONFIRM_MARKS = 2;
export const PORTFOLIO_CONFIRM_MARKS = 3;

export interface CircuitState {
  /** UTC day the trip counter belongs to */
  day: string;
  /** trips today: the second trip in a day is stage 2 */
  trips: number;
  /** consecutive marks past the limit */
  streak: number;
  haltUntil: number;
  stage: 0 | 1 | 2;
  reason: string | null;
  /** the day's high-water of working SOL: the limit scales with it */
  workingHwmSol: number;
  /** loss level at the last trip; only NEW loss beyond it can trip again (Meridian's re-arm) */
  armedAtLossSol: number;
  lastLossSol: number;
  lastLimitSol: number;
  lastMarkAt: number | null;
}

export interface PortfolioState {
  day: string;
  /** the day's high-water equity, seeded at the first mark of the day (the day-open equity) */
  hwmSol: number;
  streak: number;
  standDownUntil: number;
  standDownReason: string | null;
  lastEquitySol: number;
  lastDrawdownSol: number;
  lastLimitSol: number;
  lastMarkAt: number | null;
}

export interface EngineState {
  version: 1;
  /** pool -> epoch ms of stop-loss closes; the bench ladder reads the trailing 6h */
  stopTimes: Record<string, number[]>;
  circuit: CircuitState;
  portfolio: PortfolioState;
}

export function emptyEngineState(): EngineState {
  return {
    version: 1,
    stopTimes: {},
    circuit: { day: "", trips: 0, streak: 0, haltUntil: 0, stage: 0, reason: null, workingHwmSol: 0, armedAtLossSol: 0, lastLossSol: 0, lastLimitSol: 0, lastMarkAt: null },
    portfolio: { day: "", hwmSol: 0, streak: 0, standDownUntil: 0, standDownReason: null, lastEquitySol: 0, lastDrawdownSol: 0, lastLimitSol: 0, lastMarkAt: null },
  };
}

export function loadEngineState(file = dataPath(ENGINE_STATE_FILE)): EngineState {
  const empty = emptyEngineState();
  try {
    if (!existsSync(file)) return empty;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<EngineState>;
    return {
      version: 1,
      stopTimes: parsed.stopTimes ?? {},
      circuit: { ...empty.circuit, ...(parsed.circuit ?? {}) },
      portfolio: { ...empty.portfolio, ...(parsed.portfolio ?? {}) },
    };
  } catch {
    return empty;
  }
}

export function saveEngineState(s: EngineState, file = dataPath(ENGINE_STATE_FILE)): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(s, null, 2));
}

// ---- (a) bench ladder ---------------------------------------------------------------------

/** Stops that still count against a pool: those inside the rolling window. */
export function stopsInWindow(times: readonly number[] | undefined, now: number, windowMs = BENCH_WINDOW_MS): number {
  if (!times) return 0;
  return times.filter((t) => now - t < windowMs && t <= now).length;
}

/** 1 / 0.5 / 0.25 / benched (0) at three stops. */
export function benchMultiplier(stops: number): number {
  return stops >= 3 ? 0 : Math.max(0.25, Math.pow(0.5, stops));
}

export interface BenchView {
  stops6h: number;
  multiplier: number;
  benched: boolean;
  reason: string | null;
}

export function benchView(state: Pick<EngineState, "stopTimes">, pool: string, now: number): BenchView {
  const stops6h = stopsInWindow(state.stopTimes[pool], now, BENCH_WINDOW_MS);
  const multiplier = benchMultiplier(stops6h);
  const benched = multiplier === 0;
  const reason =
    stops6h === 0
      ? null
      : benched
        ? `benched: ${stops6h} stop-loss closes in the last 6h (the oldest ages out on its own)`
        : `${stops6h} stop-loss close${stops6h === 1 ? "" : "s"} in the last 6h: size x${multiplier}`;
  return { stops6h, multiplier, benched, reason };
}

/** Record a stop-loss close for the bench ladder; keeps only what the window can read. */
export function recordStop(state: Pick<EngineState, "stopTimes">, pool: string, now: number): void {
  const times = (state.stopTimes[pool] ?? []).filter((t) => now - t < BENCH_WINDOW_MS);
  times.push(now);
  state.stopTimes[pool] = times.slice(-12);
}

// ---- (b) board regime -------------------------------------------------------------------------

export interface RegimeView {
  medianMove24hPct: number | null;
  multiplier: number;
  reason: string | null;
  pools: number;
}

/** Median 24h move across the pools worked: >= -5% full size, -5..-15% half, below -15% opens off. */
export function regimeView(moves24hPct: readonly (number | null)[]): RegimeView {
  const valid = moves24hPct.filter((m): m is number => typeof m === "number" && Number.isFinite(m));
  if (valid.length === 0) return { medianMove24hPct: null, multiplier: 1, reason: null, pools: 0 };
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const m = Math.round(median * 100) / 100;
  if (median >= -5) return { medianMove24hPct: m, multiplier: 1, reason: null, pools: valid.length };
  if (median > -15) return { medianMove24hPct: m, multiplier: 0.5, reason: `regime: board median ${m.toFixed(1)}% over 24h across ${valid.length} pools: size x0.5`, pools: valid.length };
  return { medianMove24hPct: m, multiplier: 0, reason: `regime: board median ${m.toFixed(1)}% over 24h across ${valid.length} pools: opens off`, pools: valid.length };
}

// ---- (c) circuit breaker ----------------------------------------------------------------------

/** The day's loss limit for a given working size: a floor when small, proportional at size. */
export function circuitLimitSol(workingSol: number, floorSol: number, pct = LOSS_PCT): number {
  return Math.max(floorSol, (pct / 100) * Math.max(0, workingSol));
}

/** Sum of each open band's shortfall against entry (<= 0). Bands above water contribute nothing. */
export function markedDrawdownSol(bands: readonly { valueInSol: number; entryValueSol?: number }[]): number {
  let dd = 0;
  for (const b of bands) {
    if (!b.entryValueSol || b.entryValueSol <= 0) continue;
    dd += Math.min(0, b.valueInSol - b.entryValueSol);
  }
  return dd;
}

/** Today's loss: realized SOL (from the ledger) netted with the marked drawdown of open bands, floored at 0. */
export function circuitLossSol(realizedTodaySol: number, markedDrawdown: number): number {
  return Math.max(0, -(realizedTodaySol + Math.min(0, markedDrawdown)));
}

export interface CircuitVerdict {
  next: CircuitState;
  tripped: boolean;
  stage: 0 | 1 | 2;
  lossSol: number;
  limitSol: number;
  reason: string | null;
}

/**
 * Fold one mark. Trip on `confirmMarks` consecutive marks with new loss (beyond the level the
 * breaker re-armed at) at or past the limit: stage 1 halts opens 4h; a second trip in the same
 * UTC day is stage 2, 6h. Halted: nothing to judge until the halt lifts.
 */
export function circuitVerdict(
  state: CircuitState,
  lossSol: number,
  workingSol: number,
  day: string,
  now: number,
  cfg: { floorSol: number; pct?: number; confirmMarks?: number; stage1Ms?: number; stage2Ms?: number },
): CircuitVerdict {
  const s: CircuitState = { ...state, lastMarkAt: now };
  if (s.day !== day) {
    s.day = day;
    s.trips = 0;
    s.streak = 0;
    s.workingHwmSol = 0;
    s.armedAtLossSol = 0;
  }
  s.workingHwmSol = Math.max(s.workingHwmSol, Number.isFinite(workingSol) ? workingSol : 0);
  const limitSol = circuitLimitSol(s.workingHwmSol, cfg.floorSol, cfg.pct);
  s.lastLossSol = lossSol;
  s.lastLimitSol = limitSol;
  if (now < s.haltUntil) {
    s.streak = 0;
    return { next: s, tripped: false, stage: s.stage, lossSol, limitSol, reason: s.reason };
  }
  if (s.stage !== 0 && now >= s.haltUntil) {
    s.stage = 0; // the halt lifted; the reason stays readable until the next trip
  }
  const newLoss = lossSol - s.armedAtLossSol;
  if (newLoss < limitSol) {
    s.streak = 0;
    return { next: s, tripped: false, stage: 0, lossSol, limitSol, reason: null };
  }
  s.streak += 1;
  if (s.streak < (cfg.confirmMarks ?? CIRCUIT_CONFIRM_MARKS)) return { next: s, tripped: false, stage: 0, lossSol, limitSol, reason: null };
  const stage: 1 | 2 = s.trips >= 1 ? 2 : 1;
  const haltMs = stage === 1 ? (cfg.stage1Ms ?? STAGE1_HALT_MS) : (cfg.stage2Ms ?? STAGE2_HALT_MS);
  s.trips += 1;
  s.streak = 0;
  s.stage = stage;
  s.haltUntil = now + haltMs;
  s.armedAtLossSol = lossSol; // re-arm: a further full limit of NEW loss re-trips
  s.reason = `circuit breaker stage ${stage}: today's loss ${lossSol.toFixed(4)} SOL >= limit ${limitSol.toFixed(4)} SOL (max(floor ${cfg.floorSol}, ${cfg.pct ?? LOSS_PCT}% of ${s.workingHwmSol.toFixed(4)} working)); opens halted ${Math.round(haltMs / 3600e3)}h, exits keep running`;
  return { next: s, tripped: true, stage, lossSol, limitSol, reason: s.reason };
}

export function circuitHalted(state: Pick<CircuitState, "haltUntil">, now: number): boolean {
  return now < state.haltUntil;
}

export function clearHalt(state: EngineState): { cleared: boolean; wasHaltedUntil: number } {
  const was = state.circuit.haltUntil;
  state.circuit.haltUntil = 0;
  state.circuit.stage = 0;
  state.circuit.streak = 0;
  state.circuit.reason = null;
  return { cleared: was > 0, wasHaltedUntil: was };
}

// ---- (d) portfolio breaker --------------------------------------------------------------------

export function portfolioLimitSol(hwmSol: number, floorSol: number, pct = LOSS_PCT): number {
  return Math.max(floorSol, (pct / 100) * Math.max(0, hwmSol));
}

export interface PortfolioVerdict {
  next: PortfolioState;
  fire: boolean;
  drawdownSol: number;
  limitSol: number;
  reason: string | null;
}

/**
 * Fold one whole-book equity mark (wallet SOL + bands marked + unclaimed fees). The day's
 * high-water seeds at the first mark of the UTC day and ratchets on up-marks; a drawdown at or
 * past the limit on `confirmMarks` consecutive marks fires: FLATTEN and stand down 12h, re-armed
 * at the surviving level. Standing down, the marks keep the high-water honest and judge nothing.
 */
export function portfolioVerdict(
  state: PortfolioState,
  equitySol: number,
  day: string,
  now: number,
  cfg: { floorSol: number; pct?: number; confirmMarks?: number; standDownMs?: number },
): PortfolioVerdict {
  const s: PortfolioState = { ...state, lastMarkAt: now, lastEquitySol: equitySol };
  if (now < s.standDownUntil) {
    if (s.day !== day || equitySol > s.hwmSol) {
      s.day = day;
      s.hwmSol = equitySol;
    }
    s.streak = 0;
    s.lastDrawdownSol = 0;
    return { next: s, fire: false, drawdownSol: 0, limitSol: portfolioLimitSol(s.hwmSol, cfg.floorSol, cfg.pct), reason: s.standDownReason };
  }
  if (s.day !== day) {
    s.day = day;
    s.hwmSol = equitySol;
    s.streak = 0;
  }
  if (equitySol >= s.hwmSol) {
    s.hwmSol = equitySol;
    s.streak = 0;
    s.lastDrawdownSol = 0;
    s.lastLimitSol = portfolioLimitSol(s.hwmSol, cfg.floorSol, cfg.pct); // the limit in force from this high
    return { next: s, fire: false, drawdownSol: 0, limitSol: s.lastLimitSol, reason: null };
  }
  const limitSol = portfolioLimitSol(s.hwmSol, cfg.floorSol, cfg.pct);
  s.lastLimitSol = limitSol;
  const drawdownSol = s.hwmSol - equitySol;
  s.lastDrawdownSol = drawdownSol;
  if (drawdownSol < limitSol) {
    s.streak = 0;
    return { next: s, fire: false, drawdownSol, limitSol, reason: null };
  }
  s.streak += 1;
  if (s.streak < (cfg.confirmMarks ?? PORTFOLIO_CONFIRM_MARKS)) return { next: s, fire: false, drawdownSol, limitSol, reason: null };
  const standDownMs = cfg.standDownMs ?? STAND_DOWN_MS;
  s.standDownUntil = now + standDownMs;
  s.standDownReason = `portfolio breaker: equity ${equitySol.toFixed(4)} SOL is ${drawdownSol.toFixed(4)} SOL below the day's high ${s.hwmSol.toFixed(4)} (limit ${limitSol.toFixed(4)}) on ${s.streak} consecutive marks; flattening every band, standing down ${Math.round(standDownMs / 3600e3)}h pending operator clear`;
  s.hwmSol = equitySol; // re-arm from the surviving level
  s.streak = 0;
  return { next: s, fire: true, drawdownSol, limitSol, reason: s.standDownReason };
}

export function standingDown(state: Pick<PortfolioState, "standDownUntil">, now: number): boolean {
  return now < state.standDownUntil;
}

export function clearStandDown(state: EngineState): { cleared: boolean; wasStoodDownUntil: number } {
  const was = state.portfolio.standDownUntil;
  state.portfolio.standDownUntil = 0;
  state.portfolio.standDownReason = null;
  state.portfolio.streak = 0;
  state.portfolio.day = ""; // the next mark re-seeds the high-water at the current book
  return { cleared: was > 0, wasStoodDownUntil: was };
}

// ---- the view the guards, the observation and the journal read ---------------------------------

export interface EngineView {
  haltedUntil: number | null;
  haltStage: 1 | 2 | null;
  haltReason: string | null;
  standDownUntil: number | null;
  standDownReason: string | null;
  bench: BenchView;
  regime: RegimeView;
  /** bench x regime */
  sizeMultiplier: number;
  knife: string | null;
  collectsToday: number;
}

export function engineView(
  state: EngineState,
  pool: string,
  regime: RegimeView,
  knife: string | null,
  collectsToday: number,
  now: number,
): EngineView {
  const bench = benchView(state, pool, now);
  const halted = circuitHalted(state.circuit, now);
  const down = standingDown(state.portfolio, now);
  return {
    haltedUntil: halted ? state.circuit.haltUntil : null,
    haltStage: halted && state.circuit.stage !== 0 ? state.circuit.stage : null,
    haltReason: halted ? state.circuit.reason : null,
    standDownUntil: down ? state.portfolio.standDownUntil : null,
    standDownReason: down ? state.portfolio.standDownReason : null,
    bench,
    regime,
    sizeMultiplier: bench.multiplier * regime.multiplier,
    knife,
    collectsToday,
  };
}
