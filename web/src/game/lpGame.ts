/**
 * LAY A BAND (bands.finance Play, 24 Sep): the mini-game's whole model, one pure module.
 *
 * A visitor walks to a live pool stall and lays a band of price bins with a play deposit worth 100. Price then moves
 * for TICKS ticks (one tick = one hour). While price is inside the band the band earns fees; when price leaves it the
 * band is left holding all of one side. The round is scored against simply holding what was deposited.
 * A teaching game, not advice.
 *
 * The hours are real where they can be: a Market is a hidden 48-hour stretch of the pool's own hourly history (its
 * prices, and the fees its real volume paid each hour). A pool too new for that plays a simulated path instead.
 *
 * A round's fees are capped at FEES_CAP_PCT of the deposit (24 Sep, after the review): fees are a pure gain on top of
 * the position's value, so without a cap a wide band on a hot pool paid back more than it staked on every stretch it
 * could be dealt, and a stack compounded. With it a round can still be a good one, but never a sure one.
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
  /** the pool's liquidity in USD now: the denominator for a real hour's fees */
  liquidityUsd?: number;
  /** the share of volume the pool keeps as fees (0.01 = 1%) */
  feeRate?: number;
  /** the base token's mint, so its history is read as the base priced in the quote */
  baseMint?: string;
}

/** a stretch of the pool's own history for a round to replay, in place of a simulated path */
export interface Market {
  /** the price at the close of each hour, relative to the first: TICKS+1 values, path[0] = 1 */
  path: number[];
  /** the fees the pool paid in hour t (1..TICKS), percent of its liquidity; index 0 is 0 */
  feePct: number[];
  /** unix seconds at path[0] (the stretch runs TICKS hours from here) */
  from: number;
}

/** one hour of a pool's history, oldest first */
export interface Hour {
  /** unix seconds at the start of the hour */
  ts: number;
  close: number;
  volUsd: number;
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
/** a round's fees stop accruing at this percent of the deposit (real or simulated hours alike) */
export const FEES_CAP_PCT = 30;

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
/** a fee share outside this is not a fee tier (bad data): the row's feePct is used instead */
const FEE_RATE_MAX = 0.1;
/** hourlySeries fills at most this many silent hours in a row; a longer silence starts the series again after it */
const GAP_FILL_MAX = 12;
/** the history a round can use is this many hours at most (GeckoTerminal's 200 candles, and a little over) */
const SERIES_MAX = 240;

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
 * to a running total that is never compounded and stops at FEES_CAP_PCT: once the round has earned that much, later
 * in-range ticks add nothing. Tick 0 earns nothing.
 *
 * With a market (a real stretch of the pool's history), its path replaces the simulated one and hour t's fees are its
 * own: DEPOSIT * market.feePct[t]/100 * concentration, under the same cap. The seed then plays no part.
 *
 * Closing: after closedAt the books are shut, so feesPct, valuePct and holdPct stay at their closedAt values to the end
 * of the arrays (path and inRange carry on: they are the market's, not the player's). scorePct is
 * valuePct + feesPct - holdPct at closedAt, rounded to 2 decimals.
 */
export function simulate(pool: PoolParams, seed: number, choice: Choice, market?: Market | null): SimResult {
  const why = validateChoice(choice);
  if (why) throw new Error(`lpGame: bad choice: ${why}`);
  if (market) {
    assertPool(pool);
    const bad = marketProblem(market);
    if (bad) throw new Error(`lpGame: bad market: ${bad}`);
  }
  const path = market ? market.path.slice() : pricePath(pool, seed); // checks the pool

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
  const feeAt = (t: number): number => DEPOSIT * ((market ? market.feePct[t] : pool.feePctPerHour) / 100) * concentration;

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
    if (t >= 1 && inRange[t]) fees = Math.min(fees + feeAt(t), FEES_CAP_PCT);
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
 *   liquidityUsd  = liquidityUsd, when a number > 0
 *   feeRate       = fees1hUsd / vol1hUsd when both are > 0 and the share is at most 10% (a dynamic fee, as it ran),
 *                   else feePct / 100
 *   baseMint      = baseMint, when a string
 */
/**
 * The Pools Board's heading: the tick it shows, never a cadence. The page re-reads /hot.json every two minutes but
 * the file changes only when the desk deploys (AUTO_DEPLOY_MIN_MINUTES, 30), so "EVERY TWO MINUTES" stood over a
 * board 34 minutes old whose top row dealt twice the fee rate the desk was reading (25 Sep 2026). `asOf` is the
 * file's generatedAt, an ISO stamp in UTC; without one the board says only where its rows came from.
 */
export function boardHeading(asOf: unknown): string {
  const m = typeof asOf === "string" ? /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/.exec(asOf) : null;
  return m ? `HOT NOW · AS OF ${m[1]}:${m[2]} UTC` : "HOT NOW · THE DESK'S LAST READ";
}

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
  const out: PoolParams = {
    label,
    address,
    feePctPerHour: clamp(feeToTvl, 0, HOT_FEE_MAX),
    volPctPerHour: Math.min(Math.max(move1h, move5m * Math.sqrt(12), HOT_VOL_MIN), HOT_VOL_MAX),
    binStepBps: clamp(Math.round(feeTier * 100), HOT_STEP_MIN, HOT_STEP_MAX),
  };
  const liq = finite(r.liquidityUsd);
  if (liq !== null && liq > 0) out.liquidityUsd = liq;
  const fees = finite(r.fees1hUsd);
  const vol = finite(r.vol1hUsd);
  const share = fees !== null && vol !== null && fees > 0 && vol > 0 ? fees / vol : null;
  out.feeRate = share !== null && share <= FEE_RATE_MAX ? share : feeTier / 100;
  if (typeof r.baseMint === "string" && r.baseMint.trim()) out.baseMint = r.baseMint.trim();
  return out;
}

// ---------------------------------------------------------------- the pool's own history

/** GeckoTerminal candles -> [unix s on the hour, close, volume] for each well-formed row (close > 0, volume >= 0) */
function candleRows(candles: unknown): [number, number, number][] {
  if (!Array.isArray(candles)) return [];
  const out: [number, number, number][] = [];
  for (const c of candles) {
    if (!Array.isArray(c) || c.length < 6) continue;
    const [ts, , , , close, vol] = c as unknown[];
    if (!isInt(ts) || ts % 3600 !== 0 || finite(close) === null || (close as number) <= 0 || finite(vol) === null || (vol as number) < 0) continue;
    out.push([ts, close as number, vol as number]);
  }
  return out;
}

/**
 * GeckoTerminal hourly candles ([unix s, open, high, low, close, volume], newest first as it sends them, any order
 * accepted) -> one Hour per hour, oldest first. The closes come from `candles`; the volume from `volumeUsd` when given
 * (the same hours read in USD: candles priced in the quote count their volume in the quote, SOL for a SOL pair), else
 * from `candles`. An hour with no trades has no candle: up to GAP_FILL_MAX of them in a row are filled with the last
 * close and no volume; after a longer silence the series starts again. Rows that are not six finite numbers with a
 * close > 0 and a volume >= 0 on the hour are skipped. At most SERIES_MAX hours, the newest.
 */
export function hourlySeries(candles: unknown, volumeUsd?: unknown): Hour[] {
  const vol = volumeUsd === undefined ? null : new Map(candleRows(volumeUsd).map(([ts, , v]) => [ts, v]));
  const byTs = new Map<number, Hour>();
  for (const [ts, close, v] of candleRows(candles)) byTs.set(ts, { ts, close, volUsd: vol ? (vol.get(ts) ?? 0) : v });
  const hours = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  let out: Hour[] = [];
  for (const h of hours) {
    const prev = out[out.length - 1];
    if (prev) {
      const gap = (h.ts - prev.ts) / 3600 - 1;
      if (gap > GAP_FILL_MAX) out = [];
      else for (let k = 1; k <= gap; k++) out.push({ ts: prev.ts + k * 3600, close: prev.close, volUsd: 0 });
    }
    out.push(h);
  }
  return out.slice(-SERIES_MAX);
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Where a pool's hourly history is read: GeckoTerminal's public API, the last 200 hours, twice. `price` has the base
 * priced in the quote (by the base's mint when the board gives it, so a pair the API lists the other way round still
 * reads right); `volume` is the same hours in USD, for the volume (the quote-priced read counts it in the quote).
 * null for an address that is not a Solana address.
 */
export function historyUrls(pool: PoolParams): { price: string; volume: string } | null {
  if (typeof pool?.address !== "string" || !BASE58.test(pool.address)) return null;
  const token = pool.baseMint && BASE58.test(pool.baseMint) ? pool.baseMint : "base";
  const at = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool.address}/ohlcv/hour?aggregate=1&limit=200&token=${token}`;
  return { price: `${at}&currency=token`, volume: `${at}&currency=usd` };
}

/** a pool's history as read: candles priced in the quote, and the same hours in USD for their volume */
export interface History {
  price: unknown[];
  volume: unknown[];
}

/** a History (or bare candles, their own volume) -> its hours */
export function seriesOf(h: unknown): Hour[] {
  if (Array.isArray(h)) return hourlySeries(h);
  const r = h as Partial<History> | null;
  return r && Array.isArray(r.price) && Array.isArray(r.volume) ? hourlySeries(r.price, r.volume) : [];
}

/** that API's answer -> its candles (hourlySeries' input), or null */
export function candlesOf(body: unknown): unknown[] | null {
  const list = (body as { data?: { attributes?: { ohlcv_list?: unknown } } } | null)?.data?.attributes?.ohlcv_list;
  return Array.isArray(list) ? list : null;
}

/** how many hours a Market needs: TICKS of them after the one it starts on */
export const MARKET_HOURS = TICKS + 1;

/**
 * The stretch of a series starting at hour `start` as a Market, or null (too short, no liquidity or fee share to
 * price the fees by). path[t] = close[start+t] / close[start]; feePct[t] = volUsd[start+t] * feeRate / liquidityUsd
 * * 100, clamped to [0, 5]: the pool's real fees that hour over its liquidity now.
 */
export function marketWindow(series: Hour[], start: number, pool: PoolParams): Market | null {
  const liq = pool.liquidityUsd;
  const rate = pool.feeRate;
  if (!isInt(start) || start < 0 || start + MARKET_HOURS > series.length) return null;
  if (!liq || !(liq > 0) || rate === undefined || !(rate >= 0)) return null;
  const p0 = series[start].close;
  const path: number[] = [];
  const feePct: number[] = [];
  for (let t = 0; t <= TICKS; t++) {
    const h = series[start + t];
    path.push(t === 0 ? 1 : h.close / p0);
    feePct.push(t === 0 ? 0 : clamp(((h.volUsd * rate) / liq) * 100, 0, HOT_FEE_MAX));
  }
  const m: Market = { path, feePct, from: series[start].ts + 3600 };
  return marketProblem(m) ? null : m;
}

function marketProblem(m: Market): string | null {
  if (typeof m !== "object" || m === null) return "market missing";
  if (!Array.isArray(m.path) || m.path.length !== TICKS + 1) return `path must hold ${TICKS + 1} prices`;
  if (!Array.isArray(m.feePct) || m.feePct.length !== TICKS + 1) return `feePct must hold ${TICKS + 1} values`;
  if (m.path[0] !== 1) return "path must start at 1";
  for (const p of m.path) if (finite(p) === null || p <= 0) return "prices must be numbers > 0";
  for (const f of m.feePct) if (finite(f) === null || f < 0) return "fees must be numbers >= 0";
  return null;
}
