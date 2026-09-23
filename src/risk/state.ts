import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import type { LaunchBand } from "../screener/launch";
import type { StockTag } from "../screener/types";

/** A pool the desk CREATED on Meteora for a pump.fun token (the pair lane, src/venues/pair.ts). Keyed by the loop's pair-<mint> alias. */
export interface PairPoolRecord {
  /** the real lb pair address the SDK derived and the create transaction initialised */
  lbPair: string;
  mint: string;
  symbol: string;
  /** a STOCK pair (src/screener/pairStock.ts): the ticker and issuer; absent on pump.fun pairs */
  stock?: StockTag | null;
  quote: "SOL" | "USDC";
  binStep: number;
  feeBps: number;
  /** epoch ms the create transaction landed (or was journaled in dry-run) */
  createdAt: number;
  /** rent that never comes back, SOL (lb pair + reserves + oracle + the seed's bin arrays) */
  rentSol: number;
  refPool: string | null;
  refVenue: string | null;
  /** the create signature, or null when nothing was broadcast */
  sig: string | null;
}

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
  /**
   * epoch ms a pool's seat was given up: by the yield ranking (ROTATE), at the end of an ask chain, or on the
   * down side (a stop, a close through the band at a loss: src/engine/exit.ts downExitOf). It sits out
   * METEORA_STOCK_REENTRY_MIN, or the longer wait the learner set for it, before it may be seated again.
   */
  rotatedOutAt?: Record<string, number>;
  /**
   * position -> epoch ms of the cycle the desk policy gave a band the price went through its "one more cycle"
   * on a hot pool (src/agent/policy.ts, the hot-hold). Stamped whoever decided that cycle; the next cycle's
   * policy reads it and closes. Kept here, not in a journal headline: the headline is rewritten for his voice.
   */
  hotHeldAt?: Record<string, number>;
  /** position address -> what the desk knew when it laid the band (src/learn/lessons.ts BandMeta); the lesson is written from it at the close */
  bandMeta?: Record<string, import("../learn/lessons").BandMeta>;
  /** position address -> cycles observed and cycles in range, for the lesson's time in range */
  rangeStats?: Record<string, { cycles: number; inRange: number }>;
  /**
   * position address -> the opening mark of a LAUNCH-lane band (src/screener/launch.ts): which pool
   * it is in, when it opened and what the pool's last hour was trading then. Its PRESENCE is what
   * makes a band a launch band: it is how the EXPIRE directive knows which bands carry the lane's
   * maximum hold and volume-fade exits, and how the picker counts launch seats already taken.
   * Cleared with the rest of the band's bookkeeping in forgetBand().
   */
  launchBands?: Record<string, LaunchBand>;
  /** what exits could not sell under the impact caps, by mint: sold on later cycles (executor sellResidue) */
  residues?: Record<string, import("../executor").Residue>;
  /**
   * position address -> the ask band working a closed bid band's token off (src/engine/askExit.ts). Its
   * PRESENCE is what makes a band an ask band: not a seat, its own stop basis and clock, closed at once
   * when sold out. Cleared with the rest of the band's bookkeeping in forgetBand().
   */
  askBands?: Record<string, import("../engine/askExit").AskBand>;
  /** pool -> epoch ms the desk first took its seat there in the current tenure (a re-lay keeps it; a plain close ends it) */
  seatSince?: Record<string, number>;
  /**
   * pair-<mint> alias -> the pool the desk created for that token (src/venues/pair.ts). What a
   * restart reads to know a real Meteora pool is one of ours, and what maps its real address back
   * to the alias the loop works it under.
   */
  pairPools?: Record<string, PairPoolRecord>;
  /**
   * position address -> the outside proposal that laid it (src/platform/proposals.ts). Its PRESENCE is what makes a
   * band a proposal band: the auto-approval budget (src/platform/autoDecide.ts) counts these, so a restart cannot
   * reset it. A re-lay carries the record to the new band; forgetBand() drops it at the close.
   */
  proposalBands?: Record<string, { proposal: string; pool: string; at: number }>;
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
    rotatedOutAt: {},
    hotHeldAt: {},
    bandMeta: {},
    rangeStats: {},
    launchBands: {},
    askBands: {},
    pairPools: {},
    proposalBands: {},
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
      rotatedOutAt: parsed.rotatedOutAt ?? {},
      hotHeldAt: parsed.hotHeldAt ?? {},
      bandMeta: parsed.bandMeta ?? {},
      rangeStats: parsed.rangeStats ?? {},
      launchBands: parsed.launchBands ?? {},
      askBands: parsed.askBands ?? {},
      pairPools: parsed.pairPools ?? {},
      proposalBands: parsed.proposalBands ?? {},
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

/** Written temp + rename: a kill mid-write never leaves a torn state file behind. */
export function saveState(s: RiskState): void {
  const file = STATE_FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Where a halt comes from. "root" is a file named STOP in the project root: it halts every desk run from
 * it, paper and live alike. "desk" is a STOP file in this desk's DATA_DIR: it halts this desk only.
 * "env" is KILL_SWITCH=true in the environment (the live desk carries it in ops/live.env until the go).
 */
export type HaltSource = "root" | "desk" | "env";

export interface HaltWhere {
  /** the directory the root STOP is looked for in (the project root the desk runs from) */
  cwd?: string;
  /** the desk's data directory, relative to cwd or absolute */
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Every halt that is in force, in that order. A file only has to EXIST: its contents are never read,
 * so there is no expiry and no condition in it, and an empty file halts as surely as a long note.
 */
export function killSwitchSources(where: HaltWhere = {}): HaltSource[] {
  const cwd = where.cwd ?? process.cwd();
  const dataDir = where.dataDir ?? config.dataDir;
  const env = where.env ?? process.env;
  const out: HaltSource[] = [];
  if (fs.existsSync(path.resolve(cwd, "STOP"))) out.push("root");
  if (fs.existsSync(path.resolve(cwd, dataDir, "STOP"))) out.push("desk");
  if (env.KILL_SWITCH === "true") out.push("env");
  return out;
}

/** The root STOP, this desk's DATA_DIR/STOP, or KILL_SWITCH=true: any one blocks all new exposure. */
export function killSwitchActive(where: HaltWhere = {}): boolean {
  return killSwitchSources(where).length > 0;
}

/** The halts in force, in words for the preflight and the status line: "STOP in the repo root (every desk)", and so on. */
export function describeHalt(sources: HaltSource[], dataDir: string = config.dataDir): string {
  const words: Record<HaltSource, string> = {
    root: "STOP in the repo root (halts every desk)",
    desk: `${path.join(dataDir, "STOP")} (halts this desk only)`,
    env: "KILL_SWITCH=true in the environment",
  };
  return sources.length ? sources.map((s) => words[s]).join(" + ") : "clear";
}
