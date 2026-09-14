/**
 * The LAUNCH LANE: the one rule on the desk that admits a CATEGORY instead of a name.
 *
 * Everything else the desk added refuses a brand-new pool on purpose: the screener flags it `new`,
 * the hot watch brakes it under HOT_MIN_AGE_HOURS, hotPicks drops anything flagged `new`, the
 * watchlist in allow mode cannot list a token that did not exist yesterday, and POLICY_MIN_SCORE
 * is a judgement about pools with a history. That is the right default. It also means the desk
 * watched WET print $2.5M of volume in its first two hours and entered nothing.
 *
 * So: one lane, with its own harsher terms, that admits the SHAPE of a launch rather than a name.
 * A pool gets in only when it is new AND already carrying real, two-sided, still-running flow:
 *
 *   age            >= LAUNCH_MIN_AGE_MIN (30 min: nothing in its first half hour) and
 *                  <= LAUNCH_MAX_AGE_HOURS (48h: after that it is just a pool, judged like any other)
 *   quote          SOL or USDC (the only quotes the book can seat)
 *   liquidity      >= LAUNCH_MIN_LIQUIDITY_USD (25k: a band needs a bin with money in it)
 *   24h volume     >= LAUNCH_MIN_VOLUME_24H_USD (500k: fees come from volume)
 *   turnover       >= LAUNCH_MIN_TURNOVER (3x: the pool must trade its own book several times over)
 *   1h volume      >= LAUNCH_MIN_VOLUME_1H_USD (50k: the 24h figure must still be happening NOW)
 *   not dumping    sellShare1h < 0.66 OR the last hour is better than -10%
 *   not flagged    `dumping` from the hot watch
 *
 * Every refusal names the number that failed, because a lane nobody can audit is a lane nobody
 * should trust. LAUNCH_LANE set to anything but "true" turns the whole thing off.
 *
 * The harsher terms a launch seat carries (size cap, tighter stop, maximum hold, volume-fade exit)
 * live with the code that enforces them: src/agent/policy.ts (size), src/index.ts (the rolled stop),
 * src/engine/directives.ts (the EXPIRE directive). This file is pure: no disk, no network, no clock.
 */

export interface LaunchEnv {
  /** LAUNCH_LANE: anything but "true" turns the whole lane off */
  on: boolean;
  /** LAUNCH_MAX_AGE_HOURS: past this the pool is not a launch any more, it is just a pool */
  maxAgeHours: number;
  /** LAUNCH_MIN_AGE_MIN: nothing in its first half hour, whatever it prints */
  minAgeMin: number;
  /** LAUNCH_MIN_LIQUIDITY_USD */
  minLiquidityUsd: number;
  /** LAUNCH_MIN_VOLUME_24H_USD */
  minVolume24hUsd: number;
  /** LAUNCH_MIN_TURNOVER: 24h volume / liquidity */
  minTurnover: number;
  /** LAUNCH_MIN_VOLUME_1H_USD: the last hour must still be trading */
  minVolume1hUsd: number;
  /** LAUNCH_MAX_SEATS: launch pools the picker may seat at once */
  maxSeats: number;
  /** LAUNCH_SEAT_PCT: a launch seat is capped at this percent of MAX_TOTAL_EXPOSURE_SOL */
  seatPct: number;
  /** LAUNCH_STOP_PCT: the per-band stop for a launch band, in place of STOP_LOSS_PCT */
  stopPct: number;
  /** LAUNCH_MAX_HOLD_MIN: a launch band older than this is closed by the EXPIRE directive */
  maxHoldMin: number;
  /** LAUNCH_FADE_VOLUME_1H_USD: a pool whose last hour falls under this has stopped paying */
  fadeVolume1hUsd: number;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function launchEnv(env: NodeJS.ProcessEnv = process.env): LaunchEnv {
  return {
    // Default ON, but only the literal "true" (or an unset key) keeps it on: a typo closes the lane.
    on: env.LAUNCH_LANE === undefined || env.LAUNCH_LANE.trim() === "" || env.LAUNCH_LANE.trim().toLowerCase() === "true",
    maxAgeHours: Math.max(0, num(env.LAUNCH_MAX_AGE_HOURS, 48)),
    minAgeMin: Math.max(0, num(env.LAUNCH_MIN_AGE_MIN, 30)),
    minLiquidityUsd: Math.max(0, num(env.LAUNCH_MIN_LIQUIDITY_USD, 15_000)),
    minVolume24hUsd: Math.max(0, num(env.LAUNCH_MIN_VOLUME_24H_USD, 400_000)),
    minTurnover: Math.max(0, num(env.LAUNCH_MIN_TURNOVER, 3)),
    minVolume1hUsd: Math.max(0, num(env.LAUNCH_MIN_VOLUME_1H_USD, 50_000)),
    maxSeats: Math.max(0, Math.floor(num(env.LAUNCH_MAX_SEATS, 1))),
    seatPct: Math.max(0, num(env.LAUNCH_SEAT_PCT, 10)),
    stopPct: Math.max(0, num(env.LAUNCH_STOP_PCT, 8)),
    maxHoldMin: Math.max(0, num(env.LAUNCH_MAX_HOLD_MIN, 240)),
    fadeVolume1hUsd: Math.max(0, num(env.LAUNCH_FADE_VOLUME_1H_USD, 20_000)),
  };
}

/** What the lane needs to know about a pool. The hot watch's row carries every field (src/hot/types.ts). */
export interface LaunchRow {
  /** hours since the pool was created; null is a refusal, not a pass */
  ageHours: number | null;
  liquidityUsd: number | null;
  vol24hUsd: number | null;
  vol1hUsd: number | null;
  /** 24h volume / liquidity when the caller already computed it; derived from the two when absent */
  turnover24h?: number | null;
  quoteSymbol: string;
  /** share of the last hour's trades that were sells, 0..1 */
  sellShare1h?: number | null;
  priceChange1hPct?: number | null;
  flags?: string[];
}

export type LaunchVerdict = { ok: true; ageHours: number; turnover: number } | { ok: false; reason: string };

/** The lane's dumping rule, named once so the policy and the tests agree: two-thirds sells INTO a fall. */
export const LAUNCH_MAX_SELL_SHARE_1H = 0.66;
export const LAUNCH_MAX_FALL_1H_PCT = -10;

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const h = (n: number) => `${n < 1 ? `${Math.round(n * 60)} min` : `${n.toFixed(1)}h`}`;

/**
 * PURE. Whether the launch lane admits this pool, or the number that stopped it.
 * Checked in the order a trader would check them: is it a launch at all, can we even quote it,
 * is there a book, is there flow, is the flow still happening, is it being dumped.
 */
export function launchVerdict(row: LaunchRow, env: LaunchEnv): LaunchVerdict {
  if (!env.on) return { ok: false, reason: "the launch lane is off (LAUNCH_LANE is not true)" };

  const age = row.ageHours;
  if (age === null || !Number.isFinite(age)) return { ok: false, reason: "age unknown: the launch lane needs to know how old the pool is" };
  if (age > env.maxAgeHours) return { ok: false, reason: `age ${h(age)} is past the ${env.maxAgeHours}h launch window: judge it as an ordinary pool` };
  if (age * 60 < env.minAgeMin) return { ok: false, reason: `age ${h(age)} is inside the first ${env.minAgeMin} min: nothing in its first half hour` };

  if (row.quoteSymbol !== "SOL" && row.quoteSymbol !== "USDC") return { ok: false, reason: `quoted in ${row.quoteSymbol}, and the book seats SOL and USDC only` };

  const liq = row.liquidityUsd;
  if (liq === null || !Number.isFinite(liq)) return { ok: false, reason: "liquidity unknown: the launch lane will not size a band against a number nobody reported" };
  if (liq < env.minLiquidityUsd) return { ok: false, reason: `liquidity ${usd(liq)} is under the ${usd(env.minLiquidityUsd)} launch floor` };

  const v24 = row.vol24hUsd;
  if (v24 === null || !Number.isFinite(v24)) return { ok: false, reason: "24h volume unknown: fees come from volume, and nobody reported any" };
  if (v24 < env.minVolume24hUsd) return { ok: false, reason: `24h volume ${usd(v24)} is under the ${usd(env.minVolume24hUsd)} launch floor` };

  const turnover = typeof row.turnover24h === "number" && Number.isFinite(row.turnover24h) ? row.turnover24h : v24 / liq;
  if (turnover < env.minTurnover) {
    return { ok: false, reason: `turnover ${turnover.toFixed(1)}x (${usd(v24)} traded on ${usd(liq)} of liquidity) is under the ${env.minTurnover}x launch floor` };
  }

  const v1 = row.vol1hUsd;
  if (v1 === null || !Number.isFinite(v1)) return { ok: false, reason: "last hour's volume unknown: the launch lane will not trade a 24h number on its own" };
  if (v1 < env.minVolume1hUsd) return { ok: false, reason: `the last hour traded ${usd(v1)}, under the ${usd(env.minVolume1hUsd)} launch floor: the 24h figure has already happened` };

  const sells = row.sellShare1h;
  const move = row.priceChange1hPct;
  const dumping = typeof sells === "number" && sells >= LAUNCH_MAX_SELL_SHARE_1H && !(typeof move === "number" && move > LAUNCH_MAX_FALL_1H_PCT);
  if (dumping) {
    return {
      ok: false,
      reason: `${(sells! * 100).toFixed(0)}% of the last hour's trades were sells (limit ${(LAUNCH_MAX_SELL_SHARE_1H * 100).toFixed(0)}%) and the hour is ${move === null || move === undefined ? "unpriced" : `${move.toFixed(1)}%`}, not above ${LAUNCH_MAX_FALL_1H_PCT}%: it is being dumped`,
    };
  }
  if ((row.flags ?? []).includes("dumping")) return { ok: false, reason: "the hot watch flags it `dumping`" };

  return { ok: true, ageHours: age, turnover: Math.round(turnover * 100) / 100 };
}

/** The SOL a launch seat may hold: LAUNCH_SEAT_PCT of the book's total exposure limit. */
export const launchSeatSol = (maxTotalExposureSol: number, env: LaunchEnv): number => Math.max(0, (maxTotalExposureSol * env.seatPct) / 100);

/* ---------- seating: which launch pools the picker takes, and how many ---------- */

/** A hot row as the picker hands it to the lane. Everything LaunchRow needs, plus who the pool is. */
export interface LaunchCandidate extends LaunchRow {
  address: string;
  baseMint: string;
  baseSymbol: string;
  name: string;
  venue: string;
  /** the hot watch's heat: the order the picker tries them in, best first */
  heat?: number;
}

export interface LaunchSeatOptions {
  env: LaunchEnv;
  /** seats left in the book before MAX_ACTIVE_POOLS is reached */
  freeSeats: number;
  /** launch pools the desk already holds a band in: they count against LAUNCH_MAX_SEATS */
  seatsTaken?: number;
  /** the loop's venue rule */
  tradable: (venue: string) => boolean;
  /** the loop's funded-quote rule: which of SOL / USDC the wallet can actually seat */
  quoteOk: (quoteSymbol: string) => boolean;
  /**
   * An explicit watchlist DENY on this token or pool. A launch pool is admitted by rule, not by
   * name, so an allow-list MISS must never be reported here: only a deny wins (src/screener/watchlist.ts
   * watchlistDenial).
   */
  denied?: (row: LaunchCandidate) => string | null;
  /** pools the picker has already seated this cycle */
  hasPool?: (address: string) => boolean;
  /** base mints already holding a seat: one seat per token, as everywhere else in the picker */
  hasToken?: (baseMint: string) => boolean;
}

export interface LaunchSeat {
  row: LaunchCandidate;
  verdict: Extract<LaunchVerdict, { ok: true }>;
}

/**
 * PURE. The launch pools to seat, best heat first, at most LAUNCH_MAX_SEATS (counting the ones
 * already held) and never more than the book has room for. This is the whole seating rule; the
 * picker in src/index.ts only supplies the rows and the callbacks.
 */
export function launchSeats(rows: readonly LaunchCandidate[], o: LaunchSeatOptions): LaunchSeat[] {
  const out: LaunchSeat[] = [];
  if (!o.env.on) return out;
  let seats = Math.max(0, o.seatsTaken ?? 0);
  let free = Math.max(0, o.freeSeats);
  const takenTokens = new Set<string>();
  const ordered = [...rows].sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0) || (b.vol1hUsd ?? 0) - (a.vol1hUsd ?? 0));
  for (const row of ordered) {
    if (seats >= o.env.maxSeats || free <= 0) break;
    if (o.hasPool?.(row.address)) continue;
    if (row.baseMint && (takenTokens.has(row.baseMint) || o.hasToken?.(row.baseMint))) continue;
    if (!o.tradable(row.venue)) continue;
    if (!o.quoteOk(row.quoteSymbol)) continue;
    if (o.denied?.(row)) continue;
    const verdict = launchVerdict(row, o.env);
    if (!verdict.ok) continue;
    out.push({ row, verdict });
    if (row.baseMint) takenTokens.add(row.baseMint);
    seats++;
    free--;
  }
  return out;
}

/* ---------- the exit side: when a launch band has run out of road ---------- */

/** What a launch band recorded at open. Its presence in state.launchBands is what MAKES it a launch band. */
export interface LaunchBand {
  /** the pool the band sits in */
  pool: string;
  /** epoch ms the band was opened */
  openedAt: number;
  /** the pool's 1h volume in USD at that moment; null when nobody reported one */
  vol1hUsd: number | null;
}

export interface LaunchExpiry {
  position: string;
  reason: string;
}

/**
 * PURE. Why a launch band must come off now, or null. Two reasons, both harsher than anything the
 * desk applies to an ordinary band:
 *   age   the band is older than LAUNCH_MAX_HOLD_MIN. A launch trade is a trade on a moment, and
 *         the moment is over whether or not the band is in range.
 *   fade  the pool's last hour has fallen under LAUNCH_FADE_VOLUME_1H_USD, or under a third of what
 *         it was when the band opened. The fees stopped; the token risk did not.
 * The oldest qualifying band goes first, one per pool per cycle, like every other directive.
 */
export function launchExpiry(
  positions: readonly { address: string }[],
  bands: Record<string, LaunchBand> | undefined,
  pool: string,
  now: number,
  env: LaunchEnv,
  vol1hUsd: number | null,
): LaunchExpiry | null {
  if (!bands) return null;
  let worst: { position: string; reason: string; ageMin: number } | null = null;
  for (const p of positions) {
    const band = bands[p.address];
    if (!band || band.pool !== pool) continue;
    const ageMin = (now - band.openedAt) / 60_000;
    let reason: string | null = null;
    if (env.maxHoldMin > 0 && ageMin >= env.maxHoldMin) {
      reason = `launch band ${p.address.slice(0, 6)} has been open ${Math.round(ageMin)} min, past the ${env.maxHoldMin} min maximum hold for a launch seat`;
    } else if (vol1hUsd !== null && Number.isFinite(vol1hUsd)) {
      const opened = band.vol1hUsd;
      if (env.fadeVolume1hUsd > 0 && vol1hUsd < env.fadeVolume1hUsd) {
        reason = `launch band ${p.address.slice(0, 6)}: the pool's last hour traded ${usd(vol1hUsd)}, under the ${usd(env.fadeVolume1hUsd)} fade floor`;
      } else if (opened !== null && opened > 0 && vol1hUsd < opened / 3) {
        reason = `launch band ${p.address.slice(0, 6)}: the pool's last hour traded ${usd(vol1hUsd)}, under a third of the ${usd(opened)} it traded when the band opened`;
      }
    }
    if (reason && (!worst || ageMin > worst.ageMin)) worst = { position: p.address, reason, ageMin };
  }
  return worst ? { position: worst.position, reason: worst.reason } : null;
}
