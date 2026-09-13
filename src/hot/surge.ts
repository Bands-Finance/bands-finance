/**
 * Surge detection. Pure: takes this tick's rows (best heat first) and the trailing tape.
 *   A. the pool's daily fee/TVL pace crosses HOT_SURGE_DAILY_PCT with acceleration >= 2
 *      (crossing = its latest tape row inside the window sat below the line, or it has none), or
 *   B. the pool enters the top 10 by heat for the first time in the trailing 6 hours
 *      (top-10 sets are rebuilt per tick from the tape's heat column).
 * A surge fires once; the row's `surge` flag then stays on for SURGE_STICKY_MS so the site shows it.
 */
import type { HotHistoryRow } from "./types";

export const SURGE_WINDOW_MS = 6 * 3600e3;
export const SURGE_STICKY_MS = 30 * 60e3;
export const SURGE_TOP_N = 10;
export const SURGE_MIN_ACCELERATION = 2;

export interface SurgeCandidate {
  address: string;
  feeToTvlDailyPct: number | null;
  acceleration: number | null;
}

export interface SurgeOpts {
  surgeDailyPct: number;
  now: number;
  windowMs?: number;
}

/** Addresses that sat in a top-10 by heat on any tick of the tape (rows grouped by ts). */
export function topTenSeen(history: HotHistoryRow[], topN = SURGE_TOP_N): Set<string> {
  const byTick = new Map<number, HotHistoryRow[]>();
  for (const r of history) {
    const arr = byTick.get(r.ts);
    if (arr) arr.push(r);
    else byTick.set(r.ts, [r]);
  }
  const seen = new Set<string>();
  for (const rows of byTick.values()) {
    rows.sort((a, b) => b.heat - a.heat);
    for (const r of rows.slice(0, topN)) seen.add(r.address);
  }
  return seen;
}

/** The latest tape row per address. */
export function latestByAddress(history: HotHistoryRow[]): Map<string, HotHistoryRow> {
  const out = new Map<string, HotHistoryRow>();
  for (const r of history) {
    const prev = out.get(r.address);
    if (!prev || r.ts > prev.ts) out.set(r.address, r);
  }
  return out;
}

export interface SurgeVerdict {
  address: string;
  /** which rule fired */
  rule: "yield" | "top10";
}

/**
 * Which of this tick's rows are surging. `rows` must already be in heat order (best first);
 * `history` is the trailing tape, rows older than the window are ignored.
 */
export function detectSurges(rows: SurgeCandidate[], history: HotHistoryRow[], o: SurgeOpts): SurgeVerdict[] {
  const windowMs = o.windowMs ?? SURGE_WINDOW_MS;
  const recent = history.filter((r) => r.ts >= o.now - windowMs && r.ts < o.now);
  const latest = latestByAddress(recent);
  const wasTopTen = topTenSeen(recent);
  const out: SurgeVerdict[] = [];
  rows.forEach((r, i) => {
    const daily = r.feeToTvlDailyPct;
    const accel = r.acceleration;
    if (daily !== null && accel !== null && daily >= o.surgeDailyPct && accel >= SURGE_MIN_ACCELERATION) {
      const prev = latest.get(r.address);
      const prevDaily = prev && prev.feeToTvl1hPct !== null ? prev.feeToTvl1hPct * 24 : null;
      if (prevDaily === null || prevDaily < o.surgeDailyPct) {
        out.push({ address: r.address, rule: "yield" });
        return;
      }
    }
    if (i < SURGE_TOP_N && !wasTopTen.has(r.address)) out.push({ address: r.address, rule: "top10" });
  });
  return out;
}
