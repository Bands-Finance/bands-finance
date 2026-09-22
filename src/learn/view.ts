/**
 * WHAT HE LEARNED, AS ONE SHAPE. The single view four surfaces render, so they can never disagree:
 * his observation (src/agent/observation.ts), GET /api/status (src/server.ts), the site's
 * web/public/learned.json (src/scripts/snapshot.ts) and the `bands_lessons` MCP tool
 * (src/platform/mcp/server.ts).
 *
 * This file holds TYPES ONLY, plus one empty constructor. Nothing here reads a file, decides
 * anything or imports anything: it is the contract between the learner that writes
 * DATA_DIR/learning.jsonl and the surfaces that read it back. The learner (src/learn) owns the
 * numbers; the surfaces own the words.
 *
 * The rule the shape is built around: a factor is NEVER printed without its sample. Every
 * LearnedFactor carries `n`, `minSample` and `underSample`, and a renderer that prints `factor`
 * prints them too. Under the sample the shipped `defaultFactor` stands and the surface says so.
 */

/** Which book the number was learned on. A reader refuses a file whose mode is not its own desk's. */
export type LearnMode = "paper" | "live" | "dry-run";

/** The knobs learning is allowed to touch. Nothing else is nameable, which is the point. */
export type LearnKnob = "calibration" | "pool-penalty";

/** The realised-against-forecast record a lane's calibration rests on. */
export interface LearnedRatio {
  /** median realised / forecast; 0.40 means his forecast came in at 0.40 of what happened */
  median: number;
  /** how many closed seats carried both a forecast and a realised yield */
  n: number;
  /** of those, how many the forecast was too high on */
  tooHigh: number;
}

/**
 * One knob in force. `factor` is a multiplier <= `defaultFactor` and never above it: the clamp lives
 * in the learner, and every surface states the bound rather than trusting it.
 */
export interface LearnedFactor {
  knob: LearnKnob;
  /** "memecoin", "stock", or a pool address for a pool penalty */
  lane: string;
  /** printable name of the lane or pool */
  label: string;
  /** the multiplier in force this cycle */
  factor: number;
  /** what ships in code, and what stands while the sample is short */
  defaultFactor: number;
  /** how many lessons voted for it */
  n: number;
  /** the minimum sample before it may move at all */
  minSample: number;
  /** true when n < minSample: the shipped default stands */
  underSample: boolean;
  /** when the evidence behind it was read, ms since epoch */
  asOf: number | null;
  /** when it last moved, ms since epoch; null when it never has */
  lastMovedAt: number | null;
  /** the evidence sentence for the move in force, printed verbatim by every surface */
  why: string | null;
  /** this knob's freeze, whether from LEARN_FROZEN or its own switch */
  frozen: boolean;
  /** the evidence, when the knob rests on a forecast record */
  ratio: LearnedRatio | null;
}

/** One row of DATA_DIR/learning.jsonl: nothing changes without one. */
export interface LearnedChange {
  at: number;
  mode: LearnMode;
  knob: LearnKnob;
  /** the lane or the pool the knob belongs to */
  lane: string;
  label?: string;
  from: number;
  to: number;
  /** the evidence sentence, printed verbatim */
  why: string;
  n: number;
  windowH: number;
}

/** One closed seat, as the desk shows it back to him. Money is SOL; drift is decomposed, not learned from. */
export interface LearnedSeat {
  at: number;
  pool: string;
  label: string;
  minutes: number;
  bins: number;
  /** how much of the price the band covered, percent */
  coverPct: number | null;
  inRangePct: number | null;
  /** "idle", "through-band", "rotated", "stop", "close" */
  endReason: string;
  feesSol: number;
  /** the book's net for the seat, drift and all */
  netSol: number;
  /** the net with the quote's own move taken out; null when the lesson carries no decomposition */
  netExDriftSol: number | null;
  /** what the seat was forecast to yield when it opened, percent a day */
  predictedYieldPct: number | null;
  /** what it actually yielded, percent a day */
  realizedYieldPctPerDay: number | null;
}

/** Every freeze in force. A freeze costs no evidence: lessons are still written while one is on. */
export interface LearnedFreeze {
  /** LEARN_FROZEN: all learning */
  all: boolean;
  /** LEARN_FROZEN_CALIBRATION */
  calibration: boolean;
  /** LEARN_FROZEN_POOLS */
  pools: boolean;
}

/**
 * What he has learned, whole. Built by the learner or read back off learning.jsonl; rendered by
 * every surface without further arithmetic, so two surfaces cannot round the same number differently.
 */
export interface LearnedView {
  /** the book these numbers were learned on; "paper" is said wherever it applies */
  mode: LearnMode;
  generatedAt: number;
  frozen: LearnedFreeze;
  /** false until OPENHERMIT_TOKEN lands: these knobs are his rulebook's, not his model's */
  modelOn: boolean;
  /** the knobs in force, newest evidence first */
  factors: LearnedFactor[];
  /** the changes journalled, newest first */
  changes: LearnedChange[];
  /** how the book's seats ended, and the forecast record behind the calibration */
  lessons: { total: number; byEndReason: Record<string, number>; ratio: LearnedRatio | null };
  /**
   * What this desk REFUSED to read because it was learned on another book: rows per mode, and the
   * count of journalled changes turned away. Never silent: a surface that shows a small sample says
   * here why it is small, so a misconfigured DATA_DIR reads as a misconfiguration, not as no evidence.
   */
  refused: { lessons: Record<string, number>; changes: number };
  /** the pool this view was built for, when it was built for one (his observation) */
  pool: { address: string; label: string } | null;
  /** that pool's last closed seats, newest first; empty on a book-wide view */
  seats: LearnedSeat[];
  /** what learning may never touch, named in plain words on every public surface */
  neverTouched: readonly string[];
}

/**
 * The limits learning may never raise or loosen. Human-set, and the same sentence everywhere: the
 * site, the API, the MCP tool and his own observation all print this list rather than paraphrase it.
 */
export const NEVER_TOUCHED: readonly string[] = [
  "MAX_POSITION_SOL",
  "MAX_TOTAL_EXPOSURE_SOL",
  "the stop-loss",
  "the daily caps",
  "the kill switch",
  "the circuit and portfolio breakers",
  "H1",
];

/** An empty view: no evidence, nothing learned, everything defaulted. Safe to render. */
export function emptyLearnedView(mode: LearnMode, generatedAt = Date.now()): LearnedView {
  return {
    mode,
    generatedAt,
    frozen: { all: false, calibration: false, pools: false },
    modelOn: false,
    factors: [],
    changes: [],
    lessons: { total: 0, byEndReason: {}, ratio: null },
    refused: { lessons: {}, changes: 0 },
    pool: null,
    seats: [],
    neverTouched: NEVER_TOUCHED,
  };
}
