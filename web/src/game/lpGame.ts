/**
 * LAY A BAND (bands.finance Play, 24 Sep): the mini-game's whole model, one pure module.
 *
 * A visitor walks to a live pool stall and lays a band of price bins with a play deposit worth 100. Price then moves
 * for TICKS ticks (one tick = one simulated hour). While price is inside the band the band earns fees; when price
 * leaves it the band is left holding all of one side. The round is scored against simply holding what was deposited.
 * A teaching game, not advice.
 *
 * Pure and deterministic by construction: the only randomness is the seeded rng below, there is no clock, no global
 * state and no import. The room server (a Cloudflare Worker) replays simulate() from the round's seed and the
 * player's choices to score the board, so the same inputs must give the same numbers in a browser and in a Worker.
 * (Math.exp/log/cos/pow are specified as implementation-approximated; V8 in Chrome and in Workers agree, other
 * engines can differ in the last bit, which the two-decimal score absorbs. The server's replay is the one that counts.)
 *
 * Units: every *Pct series is in quote units of a deposit worth 100 at p0 = 1, so it reads as a percent of the deposit.
 */

export interface PoolParams {
  /** "CARDS / USDC" */
  label: string;
  address: string;
  /** fees the pool pays per hour, percent of its TVL (a hot.json row's feeToTvl1hPct) */
  feePctPerHour: number;
  /** a typical one-hour price move, percent; drives the path's per-tick sigma */
  volPctPerHour: number;
  /** the width of one price bin, basis points */
  binStepBps: number;
}

export interface Choice {
  /** how many bins the band spans */
  widthBins: number;
  /** where the band's centre sits, in bins from the starting price (+ above, - below) */
  offsetBins: number;
  /** the tick the player closed at; omitted means the band rode all TICKS ticks */
  closeAt?: number;
}

/** ticks in a round; one tick is one simulated hour */
export const TICKS = 48;
export const WIDTH_MIN = 3;
export const WIDTH_MAX = 120;

export interface SimResult {
  /** price per tick, TICKS+1 values, path[0] = 1 */
  path: number[];
  /** the band's price bounds, relative to p0 = 1 */
  lower: number;
  upper: number;
  /** per tick 0..TICKS: price inside [lower, upper] (bounds inclusive); index 0 is p0 */
  inRange: boolean[];
  /** cumulative fees earned, percent of the deposit, per tick (index 0 is 0) */
  feesPct: number[];
  /** position value excluding fees, percent of the deposit, per tick (index 0 is 100) */
  valuePct: number[];
  /** value of just holding the starting token/quote amounts, percent of the deposit, per tick (index 0 is 100) */
  holdPct: number[];
  /** the tick the player closed (choice.closeAt ?? TICKS) */
  closedAt: number;
  /** (valuePct + feesPct - holdPct) at closedAt, rounded to 2 decimals */
  scorePct: number;
}

/** the play deposit in quote units at p0 = 1; with 100, a quote amount reads directly as a percent of the deposit */
const DEPOSIT = 100;
/** per-tick sigma of log price is volPctPerHour / 100, held inside these bounds so no pool is dead flat or absurd */
const SIGMA_MIN = 0.003;
const SIGMA_MAX = 0.08;
/** fee concentration = CONC_REF / widthBins, clamped: a 40-bin band earns the pool's rate, narrower earns more */
const CONC_REF = 40;
const CONC_MIN = 0.25;
const CONC_MAX = 6;
/** poolParamsFromHot's bounds */
const HOT_FEE_MAX = 5;
const HOT_VOL_MIN = 0.5;
const HOT_VOL_MAX = 15;
const HOT_STEP_MIN = 10;
const HOT_STEP_MAX = 100;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** two decimals, and never -0 (so a score serialises and compares plainly) */
const round2 = (x: number): number => {
  const r = Math.round(x * 100) / 100;
  return r === 0 ? 0 : r;
};

// ---------------------------------------------------------------- randomness

/** mulberry32: a seeded uniform generator on [0, 1). The seed is taken as a 32-bit integer (ToInt32). */
export function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** one standard normal by Box-Muller, from two uniforms (the paired sine draw is discarded, for simplicity) */
function normal(next: () => number): number {
  const u1 = 1 - next(); // (0, 1], so the log is finite
  const u2 = next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function poolProblem(pool: PoolParams): string | null {
  if (typeof pool !== "object" || pool === null) return "pool missing";
  if (finite(pool.feePctPerHour) === null || pool.feePctPerHour < 0) return "feePctPerHour must be a number >= 0";
  if (finite(pool.volPctPerHour) === null || pool.volPctPerHour < 0) return "volPctPerHour must be a number >= 0";
  if (finite(pool.binStepBps) === null || pool.binStepBps <= 0) return "binStepBps must be a number > 0";
  return null;
}

function assertPool(pool: PoolParams): void {
  const why = poolProblem(pool);
  if (why) throw new Error(`lpGame: bad pool: ${why}`);
}

// ---------------------------------------------------------------- the price path

/**
 * The round's price path: p0 = 1, then each tick p *= exp(sigma * z - sigma^2 / 2), z a standard normal from the
 * seeded rng, sigma = clamp(volPctPerHour / 100, SIGMA_MIN, SIGMA_MAX). The -sigma^2/2 makes the path a martingale:
 * E[exp(sigma * z)] = exp(sigma^2 / 2), so without it the expected price would climb every tick (about +17% over a
 * round at sigma 0.08) and a volatile pool would carry a built-in upward bias. With it the expected price stays at 1
 * (the median drifts down instead, by exp(-TICKS * sigma^2 / 2): about -14% over a round at sigma 0.08, nil at 0.003).
 * The same (pool, seed) always gives the same path; only volPctPerHour matters to it.
 */
export function pricePath(pool: PoolParams, seed: number): number[] {
  assertPool(pool);
  const sigma = clamp(pool.volPctPerHour / 100, SIGMA_MIN, SIGMA_MAX);
  const drift = -(sigma * sigma) / 2;
  const next = rng(seed);
  const path = [1];
  let p = 1;
  for (let t = 1; t <= TICKS; t++) {
    p *= Math.exp(sigma * normal(next) + drift);
    path.push(p);
  }
  return path;
}

// ---------------------------------------------------------------- the player's choice

/**
 * null when the choice is playable, else a short reason. widthBins: a whole number in [WIDTH_MIN, WIDTH_MAX];
 * offsetBins: a whole number with |offsetBins| <= widthBins / 2 (so the band always touches the starting price);
 * closeAt: omitted, or a whole number in [1, TICKS]. Extra keys are ignored.
 */
export function validateChoice(c: unknown): string | null {
  if (typeof c !== "object" || c === null || Array.isArray(c)) return "choice must be an object";
  const { widthBins, offsetBins, closeAt } = c as Record<string, unknown>;
  if (!isInt(widthBins) || widthBins < WIDTH_MIN || widthBins > WIDTH_MAX) {
    return `widthBins must be a whole number from ${WIDTH_MIN} to ${WIDTH_MAX}`;
  }
  if (!isInt(offsetBins) || Math.abs(offsetBins) > widthBins / 2) {
    return "offsetBins must be a whole number within half the width";
  }
  if (closeAt !== undefined && (!isInt(closeAt) || closeAt < 1 || closeAt > TICKS)) {
    return `closeAt must be a whole number from 1 to ${TICKS}`;
  }
  return null;
}

// ---------------------------------------------------------------- the round

/**
 * Play one round. Throws on an invalid choice or pool (the server checks validateChoice first and answers with it).
 *
 * The band: s = binStepBps / 10000, lower = (1+s)^(offsetBins - widthBins/2), upper = (1+s)^(offsetBins + widthBins/2).
 *
 * The position: concentrated liquidity on [lower, upper] (the Uniswap v3 formulas, with sa = sqrt(lower),
 * sb = sqrt(upper) and sp = sqrt(P) clamped into [sa, sb]):
 *   token  x(P) = L * (1/sp - 1/sb)      quote  y(P) = L * (sp - sa)      value(P) = x(P) * P + y(P)
 * L is sized so value(1) = DEPOSIT. Below the band it is all token (value tracks price), above it all quote (value is
 * flat). A band whose edge sits exactly on p0 starts all token (lower = 1) or all quote (upper = 1).
 * Hold = x0 * P + y0, the token and quote amounts at p0 kept untouched.
 *
 * Fees: each tick t in 1..TICKS whose price is inside [lower, upper] (inclusive) adds
 *   DEPOSIT * feePctPerHour/100 * concentration,  concentration = clamp(CONC_REF / widthBins, CONC_MIN, CONC_MAX)
 * to a running total that is never compounded. Tick 0 earns nothing.
 *
 * Closing: after closedAt the books are shut, so feesPct, valuePct and holdPct stay at their closedAt values to the end
 * of the arrays (path and inRange carry on: they are the market's, not the player's). scorePct is
 * valuePct + feesPct - holdPct at closedAt, rounded to 2 decimals.
 */
export function simulate(pool: PoolParams, seed: number, choice: Choice): SimResult {
  const why = validateChoice(choice);
  if (why) throw new Error(`lpGame: bad choice: ${why}`);
  const path = pricePath(pool, seed); // checks the pool

  const { widthBins, offsetBins } = choice;
  const closedAt = choice.closeAt ?? TICKS;

  const step = 1 + pool.binStepBps / 10000;
  const lower = step ** (offsetBins - widthBins / 2);
  const upper = step ** (offsetBins + widthBins / 2);
  const sa = Math.sqrt(lower);
  const sb = Math.sqrt(upper);

  // amounts per unit of liquidity at p0 = 1, then L sized so the deposit is worth DEPOSIT
  const sp0 = clamp(1, sa, sb);
  const L = DEPOSIT / (1 / sp0 - 1 / sb + (sp0 - sa));
  const token0 = L * (1 / sp0 - 1 / sb);
  const quote0 = L * (sp0 - sa);
  const valueAt = (P: number): number => {
    const sp = clamp(Math.sqrt(P), sa, sb);
    return L * (1 / sp - 1 / sb) * P + L * (sp - sa);
  };

  const concentration = clamp(CONC_REF / widthBins, CONC_MIN, CONC_MAX);
  const feePerTick = DEPOSIT * (pool.feePctPerHour / 100) * concentration;

  const inRange: boolean[] = [];
  const feesPct: number[] = [];
  const valuePct: number[] = [];
  const holdPct: number[] = [];
  let fees = 0;
  for (let t = 0; t <= TICKS; t++) {
    const P = path[t];
    inRange.push(P >= lower && P <= upper);
    if (t > closedAt) {
      feesPct.push(feesPct[t - 1]);
      valuePct.push(valuePct[t - 1]);
      holdPct.push(holdPct[t - 1]);
      continue;
    }
    if (t >= 1 && inRange[t]) fees += feePerTick;
    feesPct.push(fees);
    valuePct.push(valueAt(P));
    holdPct.push(token0 * P + quote0);
  }

  const scorePct = round2(valuePct[closedAt] + feesPct[closedAt] - holdPct[closedAt]);
  return { path, lower, upper, inRange, feesPct, valuePct, holdPct, closedAt, scorePct };
}

// ---------------------------------------------------------------- live pools

/**
 * One row of web/public/hot.json -> the pool's game parameters, or null for a row the game cannot use (not an object,
 * no address or name, feeToTvl1hPct or feePct missing / not finite, or a fee tier <= 0).
 *   feePctPerHour = feeToTvl1hPct, clamped to [0, 5]
 *   volPctPerHour = max(|priceChange1hPct|, |priceChange5mPct| * sqrt(12), 0.5), capped at 15
 *                   (a missing or non-finite price change counts as 0, so a row with neither plays at the 0.5 floor)
 *   binStepBps    = round(feePct * 100), clamped to [10, 100] (fee tier 0.2% -> 20 bps)
 */
export function poolParamsFromHot(row: unknown): PoolParams | null {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  const address = typeof r.address === "string" ? r.address : "";
  const label = typeof r.name === "string" ? r.name : "";
  if (!address.trim() || !label.trim()) return null;
  const feeToTvl = finite(r.feeToTvl1hPct);
  const feeTier = finite(r.feePct);
  if (feeToTvl === null || feeTier === null || feeTier <= 0) return null;
  const move1h = Math.abs(finite(r.priceChange1hPct) ?? 0);
  const move5m = Math.abs(finite(r.priceChange5mPct) ?? 0);
  return {
    label,
    address,
    feePctPerHour: clamp(feeToTvl, 0, HOT_FEE_MAX),
    volPctPerHour: Math.min(Math.max(move1h, move5m * Math.sqrt(12), HOT_VOL_MIN), HOT_VOL_MAX),
    binStepBps: clamp(Math.round(feeTier * 100), HOT_STEP_MIN, HOT_STEP_MAX),
  };
}
