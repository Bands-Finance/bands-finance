/**
 * Hot metrics and the heat score, 0..100. Pure. Fee yield over the last hour is the engine
 * (log-scaled like src/screener/score.ts, 100%/day saturates); liquidity, age and the last hour's
 * price behaviour are the brakes. Flags say why. A pool whose fee rate nobody reported is ordered
 * by turnover through a nominal 0.25% fee and flagged "fee-unknown" so the tape shows it as such.
 */

const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
const round = (n: number | null, d = 4): number | null => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);

export interface HotInputs {
  vol1hUsd: number | null;
  vol5mUsd: number | null;
  vol24hUsd: number | null;
  liquidityUsd: number | null;
  /** the fee traders pay, in percent; null when unknown */
  feePct: number | null;
  buys1h: number | null;
  sells1h: number | null;
  buys5m: number | null;
  sells5m: number | null;
  priceChange5mPct: number | null;
  priceChange1hPct: number | null;
  priceChange24hPct: number | null;
  ageHours: number | null;
}

export interface HotMetrics extends HotInputs {
  fees1hUsd: number | null;
  feeToTvl1hPct: number | null;
  feeToTvlDailyPct: number | null;
  turnover1h: number | null;
  acceleration: number | null;
  sellShare1h: number | null;
  sellShare5m: number | null;
}

const share = (buys: number | null, sells: number | null): number | null => {
  if (buys === null && sells === null) return null;
  const b = buys ?? 0;
  const s = sells ?? 0;
  return b + s > 0 ? s / (b + s) : null;
};

export function hotMetrics(i: HotInputs): HotMetrics {
  const liq = i.liquidityUsd !== null && i.liquidityUsd > 0 ? i.liquidityUsd : null;
  const fees1hUsd = i.vol1hUsd !== null && i.feePct !== null ? i.vol1hUsd * (i.feePct / 100) : null;
  const feeToTvl1hPct = fees1hUsd !== null && liq !== null ? (fees1hUsd / liq) * 100 : null;
  return {
    ...i,
    fees1hUsd: round(fees1hUsd, 2),
    feeToTvl1hPct: round(feeToTvl1hPct),
    feeToTvlDailyPct: round(feeToTvl1hPct !== null ? feeToTvl1hPct * 24 : null),
    turnover1h: round(i.vol1hUsd !== null && liq !== null ? i.vol1hUsd / liq : null),
    acceleration: round(i.vol1hUsd !== null && i.vol24hUsd !== null && i.vol24hUsd > 0 ? (i.vol1hUsd * 24) / i.vol24hUsd : null, 3),
    sellShare1h: round(share(i.buys1h, i.sells1h)),
    sellShare5m: round(share(i.buys5m, i.sells5m)),
  };
}

export interface HeatOpts {
  minLiquidityUsd: number;
  minAgeHours: number;
}

export interface Heat {
  heat: number;
  flags: string[];
  /** true when the pool must not appear at all (thin, or no last-hour figure) */
  excluded: boolean;
}

/** Nominal fee used only to order pools whose real fee nobody reported. */
export const NOMINAL_FEE_PCT = 0.25;
/** "fading": the last 5 minutes carried under this share of the hour's average 5-minute slice ... */
export const FADING_SHARE = 0.15;
/** ... while the hour itself was at least this busy. */
export const FADING_MIN_VOL1H = 10_000;

export function heatOf(m: HotMetrics, o: HeatOpts): Heat {
  const flags: string[] = [];
  const liq = m.liquidityUsd ?? 0;
  if (liq < o.minLiquidityUsd) return { heat: 0, flags: ["thin"], excluded: true };
  if (m.vol1hUsd === null) return { heat: 0, flags: ["no-1h-data"], excluded: true };

  // The engine: daily fee/TVL pace on a log scale, 5%/day ~ 0.39, 30% ~ 0.74, 100% and above = 1.
  let daily = m.feeToTvlDailyPct;
  let sFee: number;
  if (daily === null) {
    daily = (m.turnover1h ?? 0) * 24 * NOMINAL_FEE_PCT;
    sFee = 0.6 * clamp(Math.log10(1 + Math.max(daily, 0)) / Math.log10(101));
    flags.push("fee-unknown");
  } else {
    sFee = clamp(Math.log10(1 + Math.max(daily, 0)) / Math.log10(101));
  }
  // Liquidity: the floor scores 0, 25x the floor ($500k at the default) scores 1. A brake, never a gate.
  const sLiq = clamp(Math.log10(Math.max(liq, 1) / o.minLiquidityUsd) / Math.log10(25));

  let brake = 1;
  if (m.ageHours === null) brake *= 0.9;
  else if (m.ageHours < o.minAgeHours) {
    brake *= 0.7;
    flags.push("new");
  }
  const move1h = m.priceChange1hPct;
  if (m.sellShare1h !== null && m.sellShare1h > 0.65 && move1h !== null && move1h < 0) {
    brake *= 0.4;
    flags.push("dumping");
  }
  if (move1h !== null && Math.abs(move1h) > 15) {
    brake *= 0.5;
    flags.push("wild");
  }
  if (m.vol1hUsd >= FADING_MIN_VOL1H && m.vol5mUsd !== null && m.vol5mUsd < (m.vol1hUsd / 12) * FADING_SHARE) {
    brake *= 0.6;
    flags.push("fading");
  }

  const heat = 100 * sFee * (0.6 + 0.4 * sLiq) * brake;
  return { heat: Math.round(heat * 10) / 10, flags, excluded: false };
}
