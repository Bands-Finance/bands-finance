import fs from "node:fs";
import path from "node:path";
import { config } from "../config";

/** One price sample for the knife check (src/engine/exit.ts). */
export interface PriceSample {
  ts: number;
  price: number;
}

/** Persisted risk bookkeeping. Lives in DATA_DIR/state.json. */
export interface RiskState {
  /** UTC date (YYYY-MM-DD) the counters belong to */
  day: string;
  actionsToday: number;
  /** epoch ms of the last executed action */
  lastActionAt: number | null;
  /** active price seen on the previous cycle */
  lastPrice: number | null;
  /** position address -> value in SOL at entry (or when first observed) */
  entryValueSol: Record<string, number>;
  // The engine's per-band bookkeeping (src/engine). Optional in the type so a caller may build a
  // bare state; loadState() always fills them, and every reader treats a missing map as empty.
  /** position address -> the per-band stop percent rolled at open (src/engine/exit.ts rollStop) */
  stops?: Record<string, number>;
  /** position address -> epoch ms the band was first seen out of range; absent while in range */
  outOfRangeSince?: Record<string, number>;
  /** position address -> epoch ms unclaimed fees first exceeded the collect floor; absent below it */
  feesPendingSince?: Record<string, number>;
  /** pool address -> active-price samples, trimmed to the trailing 6h (knife check) */
  priceHistory?: Record<string, PriceSample[]>;
  /** pool address -> epoch ms of the last band move (open, close, rebalance) there; the cooldown is per pool */
  lastMoveByPool?: Record<string, number>;
}

const STATE_FILE = () => path.resolve(process.cwd(), config.dataDir, "state.json");

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function emptyState(day = todayUtc()): RiskState {
  return {
    day,
    actionsToday: 0,
    lastActionAt: null,
    lastPrice: null,
    entryValueSol: {},
    stops: {},
    outOfRangeSince: {},
    feesPendingSince: {},
    priceHistory: {},
    lastMoveByPool: {},
  };
}

export function loadState(): RiskState {
  const empty = emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")) as Partial<RiskState>;
    const s: RiskState = {
      ...empty,
      ...parsed,
      entryValueSol: parsed.entryValueSol ?? {},
      stops: parsed.stops ?? {},
      outOfRangeSince: parsed.outOfRangeSince ?? {},
      feesPendingSince: parsed.feesPendingSince ?? {},
      priceHistory: parsed.priceHistory ?? {},
      lastMoveByPool: parsed.lastMoveByPool ?? {},
    };
    if (s.day !== todayUtc()) {
      s.day = todayUtc();
      s.actionsToday = 0;
    }
    return s;
  } catch {
    return empty;
  }
}

export function saveState(s: RiskState): void {
  const file = STATE_FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
}

/** A file named STOP in the project root (or KILL_SWITCH=true) blocks all new exposure. */
export function killSwitchActive(): boolean {
  return fs.existsSync(path.resolve(process.cwd(), "STOP")) || process.env.KILL_SWITCH === "true";
}
