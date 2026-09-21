/**
 * The marks when a pool cannot be observed. The breakers are fed every cycle: a pool the desk
 * could not read (an RPC 429, a snapshot that failed) or could not decide (its runPool threw) does
 * not switch them off for as long as it stays picked. Its bands are CARRIED instead:
 *   - at their last mark less CARRY_HAIRCUT_PCT, never above that mark;
 *   - a band with no mark at all at its entry less its full stop (see carriedBands).
 * Both figures feed the circuit breaker's drawdown and the portfolio breaker's equity, so a blind
 * pool can only bring a breaker closer. The same rule values the wallet's USDC when the screen has
 * no SOL price: at the last price a mark used, turned against us by the haircut.
 *
 * And the count: consecutive cycles whose observation was incomplete. A cycle is incomplete when a
 * pool that holds a band could not be observed or decided, or the wallet's USDC could not be priced;
 * a pick that holds nothing has nothing to mark, so it cannot make one incomplete. At
 * MARKS_STALE_CYCLES the guards refuse new exposure ("marks stale", src/risk/guards.ts); exits
 * and claims keep running. The first complete cycle resets it. The count is kept in engine.json
 * beside the marks, so a restart does not lift the block, and handed on to /api/status (src/status.ts).
 *
 * One held pool that stays blind while the rest of the book reads fine does not block the book for
 * good. At MARKS_STALE_CYCLES running it is SET ASIDE: its bands are written down to the lower of
 * their carried mark and their entry less the full stop (the worst the desk's rules let a band hold
 * at), the pool is named on /api/status and in the log every cycle, and it no longer counts against
 * the book's read. A cycle in which nothing at all was decided sets nothing aside: that is the RPC,
 * not one pool, and the block stands.
 */
import { loadEngineState, saveEngineState, type BandMark } from "./breakers";
import { noteMarks as noteStatusMarks } from "../status";

/** Consecutive incomplete cycles after which opens are refused. */
export const MARKS_STALE_CYCLES = 3;
/** What a carried band is marked down by against its last mark, percent. */
export const CARRY_HAIRCUT_PCT = 5;

export interface CarriedBand {
  address: string;
  pool: string;
  /** what the breakers count it at, SOL */
  valueInSol: number;
  entryValueSol?: number;
  basis: "last mark" | "entry less stop" | "written down";
}

/**
 * The bands of the blind pools, as the breakers must count them. A band is carried when it was held
 * at the start of the cycle, is still on the desk's books (its entry is recorded) and belongs to a
 * blind pool, by its last mark or, failing that, by the pool its meta was opened in.
 *
 * With a last mark: that mark less the haircut. A pool that goes dark is more often than not a pool
 * that is moving (the RPC chokes on busy tokens), so the last mark is the most it can be worth, not a
 * fair value, and the haircut keeps it from reading as a flat line while it is not being watched.
 *
 * Without one (opened and blind ever since, or held from before marks were kept): its entry less its
 * FULL stop. That is the lowest value the desk's own rules let it hold a band at; below it the guards
 * would have closed it at the next read. It can be worse (a stop needs a read to fire), but nothing on
 * record says by how much, and zero would count the whole band as lost and trip the breakers on a
 * phantom. A band with neither a mark nor an entry has no value on record and is left out: the
 * equity never counted it, so leaving it out cannot raise the equity.
 */
export function carriedBands(input: {
  blindPools: Iterable<string>;
  /** position addresses held at the start of the cycle */
  held: Iterable<string>;
  marks: Record<string, BandMark>;
  entryValueSol: Record<string, number>;
  /** position -> the pool its meta was opened in (RiskState.bandMeta) */
  metaPool: Record<string, string>;
  stops: Record<string, number>;
  stopLossPct: number;
  haircutPct?: number;
  /** the pools set aside (setAsidePools): their bands at the lower of the carried mark and the entry less the full stop */
  writtenDown?: Iterable<string>;
}): CarriedBand[] {
  const blind = new Set(input.blindPools);
  const down = new Set(input.writtenDown ?? []);
  const haircut = Math.min(100, Math.max(0, input.haircutPct ?? CARRY_HAIRCUT_PCT)) / 100;
  const out: CarriedBand[] = [];
  for (const address of new Set(input.held)) {
    const entry = input.entryValueSol[address];
    if (entry === undefined) continue; // closed during the cycle: its records went with it
    const mark = input.marks[address];
    const pool = mark?.pool ?? input.metaPool[address];
    if (!pool || !blind.has(pool)) continue;
    const entryValueSol = Number.isFinite(entry) && entry > 0 ? entry : undefined;
    const stopRaw = input.stops[address] ?? input.stopLossPct;
    const stop = Math.min(100, Math.max(0, Number.isFinite(stopRaw) ? stopRaw : input.stopLossPct));
    const floor = entryValueSol ? entryValueSol * (1 - stop / 100) : undefined;
    const marked = mark && Number.isFinite(mark.valueSol) && mark.valueSol >= 0 ? mark.valueSol * (1 - haircut) : undefined;
    if (down.has(pool) && floor !== undefined && (marked === undefined || floor < marked)) {
      out.push({ address, pool, valueInSol: floor, entryValueSol, basis: "written down" });
    } else if (marked !== undefined) {
      out.push({ address, pool, valueInSol: marked, entryValueSol, basis: "last mark" });
    } else if (floor !== undefined) {
      out.push({ address, pool, valueInSol: floor, entryValueSol, basis: "entry less stop" });
    }
  }
  return out;
}

/**
 * The marks the next cycle may carry: every band of a pool decided this cycle at its value now, a
 * band opened this cycle at the value it was laid at, the other marks kept as they were (a blind
 * pool's bands keep the mark they had), and every band no longer on the books dropped.
 */
export function recordMarks(
  prev: Record<string, BandMark>,
  decided: readonly { pool: string; address: string; valueInSol: number }[],
  opened: readonly { pool: string; address: string; entryValueSol: number }[],
  open: Record<string, number>,
  now: number,
): Record<string, BandMark> {
  const next: Record<string, BandMark> = {};
  for (const [a, m] of Object.entries(prev)) if (a in open) next[a] = m;
  for (const b of decided) if (b.address in open && Number.isFinite(b.valueInSol)) next[b.address] = { pool: b.pool, valueSol: b.valueInSol, at: now };
  for (const b of opened) if (b.address in open && Number.isFinite(b.entryValueSol)) next[b.address] = { pool: b.pool, valueSol: b.entryValueSol, at: now };
  return next;
}

/**
 * A USD figure in SOL when the price is carried, turned against the book: a holding at a price
 * the haircut higher (it buys less SOL), a debt at a price the haircut lower. No price at all counts
 * as zero either way: no mark has ever priced it, so the day's high-water never counted it (the
 * paper hedge, the one debt, was always counted at zero without a price).
 */
export function carriedUsdToSol(usd: number, lastSolPriceUsd: number | null, haircutPct = CARRY_HAIRCUT_PCT): number {
  if (!Number.isFinite(usd) || usd === 0) return 0;
  if (!lastSolPriceUsd || !(lastSolPriceUsd > 0)) return 0;
  const h = Math.min(99, Math.max(0, haircutPct)) / 100;
  return usd > 0 ? usd / (lastSolPriceUsd * (1 + h)) : usd / (lastSolPriceUsd * (1 - h));
}

// ---- the count ------------------------------------------------------------------------------------

export interface MarksHealth {
  /** consecutive cycles whose observation was incomplete */
  skippedMarks: number;
  /** epoch ms of the last complete cycle; null until one */
  lastCompleteMarkAt: number | null;
  /** the cycle last noted, so a cycle that died before its marks is counted once */
  cycle: number | null;
}

export function foldMarksHealth(prev: MarksHealth, complete: boolean, now: number, cycle: number): MarksHealth {
  return complete ? { skippedMarks: 0, lastCompleteMarkAt: now, cycle } : { skippedMarks: prev.skippedMarks + 1, lastCompleteMarkAt: prev.lastCompleteMarkAt, cycle };
}

export const marksStale = (h: Pick<MarksHealth, "skippedMarks">): boolean => h.skippedMarks >= MARKS_STALE_CYCLES;

/** PURE. Cycles running each held pool has been blind: this cycle's blind held pools one more, every other pool dropped. */
export function foldBlindStreaks(prev: Record<string, number>, heldBlind: readonly string[]): Record<string, number> {
  const next: Record<string, number> = {};
  for (const pool of new Set(heldBlind)) next[pool] = (prev[pool] ?? 0) + 1;
  return next;
}

/**
 * PURE. The blind held pools set aside this cycle: blind MARKS_STALE_CYCLES running, while at least one
 * pool was decided (the desk can read, so the trouble is the pool's own). None when nothing was decided.
 */
export function setAsidePools(streaks: Record<string, number>, heldBlind: readonly string[], decidedCount: number): string[] {
  if (decidedCount <= 0) return [];
  return [...new Set(heldBlind)].filter((pool) => (streaks[pool] ?? 0) >= MARKS_STALE_CYCLES);
}

/**
 * PURE. What this cycle's read of the book amounts to. `blind` are the picks not observed and decided; only those
 * holding a band count (an unheld pick has nothing to carry). `complete` is a whole read (the equity history takes
 * only those); `counts` is what the stale count takes as one: every blind held pool set aside, and the USDC priced.
 */
export function readOfBook(input: {
  picks: readonly string[];
  decided: readonly string[];
  held: Iterable<string>;
  usdcUnpriced: boolean;
  streaks: Record<string, number>;
}): { blind: string[]; heldBlind: string[]; streaks: Record<string, number>; setAside: string[]; complete: boolean; counts: boolean } {
  const decided = new Set(input.decided);
  const held = new Set(input.held);
  const blind = input.picks.filter((a) => !decided.has(a));
  const heldBlind = blind.filter((a) => held.has(a));
  const streaks = foldBlindStreaks(input.streaks, heldBlind);
  const setAside = setAsidePools(streaks, heldBlind, decided.size);
  return {
    blind,
    heldBlind,
    streaks,
    setAside,
    complete: heldBlind.length === 0 && !input.usdcUnpriced,
    counts: heldBlind.every((a) => setAside.includes(a)) && !input.usdcUnpriced,
  };
}

let health: MarksHealth = { skippedMarks: 0, lastCompleteMarkAt: null, cycle: null };

/**
 * The loop notes each cycle once: complete (every held pool observed and decided or set aside, the USDC priced) or
 * not. /api/status sees it, with the pools set aside named.
 */
export function noteMarks(complete: boolean, now: number, cycle: number, setAside: readonly string[] = []): MarksHealth {
  health = foldMarksHealth(health, complete, now, cycle);
  noteStatusMarks({ skipped: health.skippedMarks, lastCompleteAt: health.lastCompleteMarkAt, stale: marksStale(health), setAside: [...setAside] });
  return health;
}

/** The count as the engine state file kept it, restored at boot: a restart starts as stale as the desk it replaced. */
export function restoreMarksHealth(saved: { skippedMarks?: number; lastCompleteMarkAt?: number | null }): MarksHealth {
  const skipped = typeof saved.skippedMarks === "number" && saved.skippedMarks > 0 ? Math.floor(saved.skippedMarks) : 0;
  health = { skippedMarks: skipped, lastCompleteMarkAt: typeof saved.lastCompleteMarkAt === "number" ? saved.lastCompleteMarkAt : null, cycle: null };
  noteStatusMarks({ skipped: health.skippedMarks, lastCompleteAt: health.lastCompleteMarkAt, stale: marksStale(health) });
  return health;
}

/**
 * Write the count into the engine state file as it stands on disk, touching nothing else there: the loop calls it
 * after every noteMarks, including for a cycle that threw part way, whose in-memory engine state is not to be trusted.
 */
export function persistMarksHealth(h: Pick<MarksHealth, "skippedMarks" | "lastCompleteMarkAt">, file?: string): void {
  const e = file ? loadEngineState(file) : loadEngineState();
  e.skippedMarks = h.skippedMarks;
  e.lastCompleteMarkAt = h.lastCompleteMarkAt;
  if (file) saveEngineState(e, file);
  else saveEngineState(e);
}

/** The counter as it stands: the guards read skippedMarks from it every cycle. */
export function marksHealth(): { skippedMarks: number; lastCompleteMarkAt: number | null; stale: boolean } {
  return { skippedMarks: health.skippedMarks, lastCompleteMarkAt: health.lastCompleteMarkAt, stale: marksStale(health) };
}

/** The cycle last noted (the loop counts a cycle that threw before its marks as incomplete). */
export const marksNotedCycle = (): number | null => health.cycle;

/** Tests only. */
export function resetMarksHealth(): void {
  health = { skippedMarks: 0, lastCompleteMarkAt: null, cycle: null };
}
