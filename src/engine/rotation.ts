/**
 * ROTATION FOR A PIN: when a stock the agent is paired with (PAIR_STOCK_PINNED_TICKERS) cannot be
 * seated because every seat of MAX_ACTIVE_POOLS holds a band, the desk closes ONE band to make room.
 * The engine's ROTATE directive (src/engine/directives.ts) does the closing, one pool per cycle; the
 * pin takes the seat on the next cycle, through the guards like any open.
 *
 * Who goes, in order:
 *   1. never a pinned pool, never the house token's pool, never a band younger than
 *      PIN_ROTATE_MIN_AGE_MIN (60): a fresh band has not had its chance to earn its rent back;
 *   2. a band on a venue off TRADABLE_VENUES first (the pairing is Meteora only), largest first;
 *   3. otherwise the slowest earner: fees a day over what the band is worth; a band whose pace is
 *      unknown goes after every known one, oldest first (live, where pace is not tracked per band).
 *
 * PURE: the loop supplies the bands as it knows them.
 */

export interface RotationBand {
  pool: string;
  label: string;
  /** the pool's venue when known (the board, the loaded pool, a pair key), else null */
  venue: string | null;
  openedAt: number | null;
  valueSol: number;
  /** fees a day in SOL from the band's own marks; null when not tracked */
  feesPerDaySol: number | null;
  pinned: boolean;
  house: boolean;
}

export interface RotationPick {
  pool: string;
  label: string;
  reason: string;
}

export const PIN_ROTATE_MIN_AGE_MIN_DEFAULT = 60;

export function pinRotateMinAgeMin(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.PIN_ROTATE_MIN_AGE_MIN ?? "").trim();
  const n = raw === "" ? PIN_ROTATE_MIN_AGE_MIN_DEFAULT : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : PIN_ROTATE_MIN_AGE_MIN_DEFAULT;
}

/**
 * PURE. What the picker does for a pin this cycle. "held" when the ticker already has its seat: the chosen
 * pool, or any other pool of the same token (NVDAx/SOL held while NVDAx/USDC ranks first). Without that,
 * a full book rotated a band out for a pin that could never take the freed seat (its token was taken),
 * other lanes refilled it, and the desk closed a healthy band every cycle (paper, 2026-09-16).
 */
export function pinSeatAction(o: { poolHeld: boolean; tokenHeld: boolean; bookFull: boolean }): "held" | "rotate" | "take" {
  if (o.poolHeld || o.tokenHeld) return "held";
  return o.bookFull ? "rotate" : "take";
}

const pacePct = (b: RotationBand): number | null => (b.feesPerDaySol !== null && b.valueSol > 0 ? (b.feesPerDaySol / b.valueSol) * 100 : null);

/** PURE. The band to close for a pin, or null when nothing may go. */
export function rotationCandidate(bands: readonly RotationBand[], o: { now: number; tradable: (venue: string) => boolean; minAgeMin: number; forTicker: string }): RotationPick | null {
  const eligible = bands.filter((b) => !b.pinned && !b.house && (b.openedAt === null || o.now - b.openedAt >= o.minAgeMin * 60_000));
  if (!eligible.length) return null;
  const offVenue = eligible.filter((b) => b.venue !== null && !o.tradable(b.venue)).sort((a, b) => b.valueSol - a.valueSol);
  if (offVenue.length) {
    const b = offVenue[0];
    return { pool: b.pool, label: b.label, reason: `making room for pinned ${o.forTicker}: ${b.label} is on ${b.venue}, off TRADABLE_VENUES, and the pairing is Meteora only` };
  }
  const ranked = [...eligible].sort((a, b) => {
    const pa = pacePct(a);
    const pb = pacePct(b);
    if (pa === null && pb === null) return (a.openedAt ?? 0) - (b.openedAt ?? 0);
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pa - pb;
  });
  const b = ranked[0];
  const pace = pacePct(b);
  return {
    pool: b.pool,
    label: b.label,
    reason: `making room for pinned ${o.forTicker}: ${b.label} is the slowest earner in the book${pace !== null ? ` (${pace.toFixed(2)}% of its value in fees a day)` : " (its pace is not tracked; the oldest band goes)"}`,
  };
}
