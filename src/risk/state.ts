import fs from "node:fs";
import path from "node:path";
import { config } from "../config";

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
}

const STATE_FILE = () => path.resolve(process.cwd(), config.dataDir, "state.json");

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function loadState(): RiskState {
  const empty: RiskState = { day: todayUtc(), actionsToday: 0, lastActionAt: null, lastPrice: null, entryValueSol: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")) as Partial<RiskState>;
    const s: RiskState = { ...empty, ...parsed, entryValueSol: parsed.entryValueSol ?? {} };
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
