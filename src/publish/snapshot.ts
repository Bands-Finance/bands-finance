/**
 * THE SITE SNAPSHOT (npm run web:snapshot, src/scripts/snapshot.ts): what web/public carries for a static
 * host. The sites show only his REAL-MONEY record (Zach, 22 Sep: "can we clean all the paper trading data
 * from the website please"), so which book lands in journal.json and equity.json is a knob, SNAPSHOT_BOOK:
 *
 *   none   journal.json {entries: []} and equity.json {points: []}: no book is open on the sites. The
 *          default whenever DATA_DIR is a paper book (PAPER_SOL under DRY_RUN), so the paper desk that
 *          redeploys every 30 minutes can never ship its trades.
 *   real   the real-money book: decisions.jsonl and equity.jsonl from REAL_DATA_DIR (default data-mainnet).
 *          The default for any desk that is not a paper book.
 *   paper  the old behaviour: DATA_DIR's own journal and equity, whatever book it is. Only by hand.
 *
 * limits.json is always written: the real desk's limits (ops/live.env over this process's) under none and
 * real, this process's own under paper. learned.json is ALWAYS the real seats (LEARNED_DATA_DIR, default
 * data-mainnet) read as the live book, never the paper book's lessons or knobs. screen.json and hot.json are
 * market data and are written as before.
 */
import fs from "node:fs";
import path from "node:path";
import { riskLimits as processLimits } from "../config";
import type { RiskLimits } from "../risk/limits";
import { readEquity, readRecent, tailLines, type EquityPoint, type JournalEntry } from "../journal";
import { paperEnabled } from "../paper/env";
import { readLearnedView } from "../status";
import type { LearnedView } from "../learn/surface";

export type SnapshotBook = "none" | "real" | "paper";
export const SNAPSHOT_BOOKS: readonly SnapshotBook[] = ["none", "real", "paper"];

/** PURE. The book to snapshot: SNAPSHOT_BOOK when it names one, else none on a paper book and real otherwise. */
export function snapshotBook(env: NodeJS.ProcessEnv, dryRun: boolean): SnapshotBook {
  const raw = (env.SNAPSHOT_BOOK ?? "").trim().toLowerCase();
  if (raw) {
    if (!(SNAPSHOT_BOOKS as readonly string[]).includes(raw)) throw new Error(`SNAPSHOT_BOOK=${raw}: must be one of ${SNAPSHOT_BOOKS.join(", ")}`);
    return raw as SnapshotBook;
  }
  return paperEnabled(env, dryRun) ? "none" : "real";
}

/** PURE. KEY=VALUE lines of an env file (comments and blanks skipped, surrounding quotes dropped). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

const LIMIT_KEYS: Record<keyof RiskLimits, string> = {
  maxPositionSol: "MAX_POSITION_SOL",
  maxTotalExposureSol: "MAX_TOTAL_EXPOSURE_SOL",
  gasReserveSol: "GAS_RESERVE_SOL",
  stopLossPct: "STOP_LOSS_PCT",
  maxBinWidth: "MAX_BIN_WIDTH",
  maxTxPerDay: "MAX_TX_PER_DAY",
  minSecondsBetweenActions: "MIN_SECONDS_BETWEEN_ACTIONS",
  maxSlippagePct: "MAX_SLIPPAGE_PCT",
  maxPriceMovePctPerCycle: "MAX_PRICE_MOVE_PCT_PER_CYCLE",
};

/** PURE. The limits an env file sets, over `base` for any it leaves out. */
export function limitsFrom(envFile: Record<string, string>, base: RiskLimits): RiskLimits {
  const out = { ...base };
  for (const [field, key] of Object.entries(LIMIT_KEYS) as [keyof RiskLimits, string][]) {
    const n = Number(envFile[key]);
    if (envFile[key] !== undefined && envFile[key] !== "" && Number.isFinite(n)) out[field] = n;
  }
  return out;
}

function readJsonlFile<T>(file: string, limit: number): T[] {
  const out: T[] = [];
  for (const line of tailLines(file, limit)) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // a torn write: skip it rather than lose the window
    }
  }
  return out;
}

export interface SnapshotOptions {
  /** where the files go (web/public) */
  out: string;
  book: SnapshotBook;
  /** the real-money book's DATA_DIR (default data-mainnet) */
  realDir: string;
  /** where the real seats live for learned.json (default data-mainnet) */
  learnedDir: string;
  /** the real desk's env file, for its limits and its learning switches (default ops/live.env) */
  liveEnvFile: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  /** market data, written as is when present */
  screen?: unknown;
  hot?: unknown;
}

export interface SnapshotResult {
  book: SnapshotBook;
  entries: number;
  points: number;
  newest: string | null;
  limits: RiskLimits;
  learned: LearnedView;
  wrote: string[];
}

export function writeSnapshot(o: SnapshotOptions): SnapshotResult {
  const env = o.env ?? process.env;
  const generatedAt = new Date(o.now ?? Date.now()).toISOString();
  fs.mkdirSync(o.out, { recursive: true });
  const wrote: string[] = [];
  const put = (name: string, body: string): void => {
    fs.writeFileSync(path.join(o.out, name), body);
    wrote.push(name);
  };
  let liveEnv: Record<string, string> = {};
  try {
    liveEnv = parseEnvFile(fs.readFileSync(o.liveEnvFile, "utf8"));
  } catch {
    // no live env file: this process's limits stand
  }

  // THE BOOK. journal.json is newest first (readRecent), equity.json oldest first (readEquity).
  let entries: JournalEntry[] = [];
  let points: EquityPoint[] = [];
  if (o.book === "paper") {
    entries = readRecent(600);
    points = readEquity(20_000);
  } else if (o.book === "real") {
    entries = readJsonlFile<JournalEntry>(path.join(o.realDir, "decisions.jsonl"), 600).reverse();
    points = readJsonlFile<EquityPoint>(path.join(o.realDir, "equity.jsonl"), 20_000);
  }
  put("journal.json", JSON.stringify({ entries, generatedAt }));
  put("equity.json", JSON.stringify({ points, generatedAt }));
  const limits = o.book === "paper" ? processLimits : limitsFrom(liveEnv, processLimits);
  put("limits.json", JSON.stringify(limits, null, 2));

  // Market data, not his trades.
  if (o.screen) put("screen.json", JSON.stringify(o.screen));
  if (o.hot) put("hot.json", JSON.stringify(o.hot));

  // What he learned: the real seats, read as the live book, under the real desk's own learning switches.
  // The SAME builder as /api/status (src/status.ts readLearnedView), so the panel and the API agree on a dir.
  const learned = readLearnedView({ dir: o.learnedDir, mode: "live", modelOn: false, env: { ...env, ...liveEnv }, now: o.now });
  put("learned.json", JSON.stringify(learned));

  const newest = entries[0] as { mode?: string; ts?: string } | undefined;
  return { book: o.book, entries: entries.length, points: points.length, newest: newest ? `${newest.mode} ${newest.ts}` : null, limits, learned, wrote };
}
