/**
 * Pure verdicts for the engine: does the Backpack reference allow an open, and how wide should
 * the band be for the session. Nothing here touches the network or disk; the integrator wires
 * basisVerdict into the open guards and sessionWidthMultiplier into the band-width step.
 *
 * Thresholds (env, read at call time so tests can set them):
 *   BASIS_MAX_PCT      default 1.0   refuse opens when |poolPrice / perpMid - 1| exceeds this many percent:
 *                                    the on-chain price is off fair value and will be arbitraged through the band
 *   BASIS_PRE_OPEN_MIN default 30    refuse opens this many minutes before the 09:30 ET open; the first 15
 *                                    minutes after the open are always refused (the opening auction reprices)
 */
import { sessionClock, type SessionClock, type UsEquitySession } from "./session";

export interface BasisThresholds {
  maxPct: number;
  preOpenMin: number;
  postOpenMin: number;
}

export const BASIS_DEFAULTS: Readonly<BasisThresholds> = { maxPct: 1.0, preOpenMin: 30, postOpenMin: 15 };

function envNum(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function basisThresholds(env: NodeJS.ProcessEnv = process.env): BasisThresholds {
  return {
    maxPct: envNum(env, "BASIS_MAX_PCT", BASIS_DEFAULTS.maxPct),
    preOpenMin: envNum(env, "BASIS_PRE_OPEN_MIN", BASIS_DEFAULTS.preOpenMin),
    postOpenMin: BASIS_DEFAULTS.postOpenMin,
  };
}

export interface BasisVerdict {
  ok: boolean;
  reason: string;
}

/**
 * May a band be opened in a stock pool given its basis and the session?
 *   basisPct  poolPrice / perpMid - 1, in percent; null when Backpack has no perp for the stock (allowed: no reference)
 *   session   a SessionClock (preferred), or the session label with `now` supplying the clock
 */
export function basisVerdict(
  basisPct: number | null | undefined,
  session: UsEquitySession | SessionClock,
  now: Date = new Date(),
  t: BasisThresholds = basisThresholds(),
): BasisVerdict {
  const clock: SessionClock = typeof session === "string" ? { ...sessionClock(now), session } : session;
  if (basisPct !== null && basisPct !== undefined && Number.isFinite(basisPct) && Math.abs(basisPct) > t.maxPct) {
    const dir = basisPct > 0 ? "above" : "below";
    return {
      ok: false,
      reason: `basis ${basisPct.toFixed(2)}% ${dir} the Backpack perp exceeds ${t.maxPct}%: the on-chain price is off fair value and would be arbitraged through the band`,
    };
  }
  if (clock.session !== "regular" && clock.minutesToOpen <= t.preOpenMin) {
    return { ok: false, reason: `NYSE opens in ${clock.minutesToOpen} min (< ${t.preOpenMin}): the open reprices the stock, no new bands until it settles` };
  }
  if (clock.session === "regular" && clock.minutesSinceOpen !== null && clock.minutesSinceOpen < t.postOpenMin) {
    return { ok: false, reason: `NYSE opened ${clock.minutesSinceOpen} min ago (< ${t.postOpenMin}): the opening auction is still repricing` };
  }
  const basisNote = basisPct === null || basisPct === undefined || !Number.isFinite(basisPct) ? "no Backpack reference for this pool" : `basis ${basisPct.toFixed(2)}% within ${t.maxPct}%`;
  return { ok: true, reason: `${basisNote}; session ${clock.session}` };
}

/**
 * Band width multiplier by session: regular 1, pre/after 1.5, closed 2. Bands widen when the
 * reference market is shut (as Meridian widened for the weekend): the perp keeps trading but the
 * stock cannot, so the next print can gap.
 */
export function sessionWidthMultiplier(session: UsEquitySession | SessionClock): number {
  const s = typeof session === "string" ? session : session.session;
  switch (s) {
    case "regular":
      return 1;
    case "pre":
    case "after":
      return 1.5;
    default:
      return 2;
  }
}
