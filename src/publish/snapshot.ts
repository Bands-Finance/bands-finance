/**
 * THE SITE SNAPSHOT (npm run web:snapshot, src/scripts/snapshot.ts): what web/public carries for a static
 * host. The sites show only his REAL-MONEY record (Zach, 22 Sep: "can we clean all the paper trading data
 * from the website please"), so which book lands in journal.json and equity.json is a knob, SNAPSHOT_BOOK:
 *
 *   none   journal.json {entries: []} and equity.json {points: []}: no book is open on the sites. The
 *          DEFAULT, for every shell: the paper desk that redeploys every 30 minutes and a hand-run
 *          web:deploy / dash:deploy alike, so neither can ship the paper book or a finished run as "now".
 *   real   the real-money book: decisions.jsonl and equity.jsonl from REAL_DATA_DIR (default data-mainnet).
 *          Only when set explicitly (ops/live.env sets it for the live desk), and only while that book is
 *          current: when its newest decision is older than REAL_BOOK_MAX_AGE_MS (the sites' 2 h live-feed
 *          window, web/src/api.ts) the desk is not trading and the snapshot writes none instead. The settled
 *          run of 17-19 Sep is the record chapter (web/public/live-run.json), never a current book.
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
import { COPYCAT_MINTS, quietHouseMintsOf, redactCopycatDeep } from "../risk/house";
import { readEquity, readRecent, tailLines, type EquityPoint, type JournalEntry } from "../journal";
import { readLearnedView } from "../status";
import type { LearnedView } from "../learn/surface";
import { oneBook } from "./live";

export type SnapshotBook = "none" | "real" | "paper";
export const SNAPSHOT_BOOKS: readonly SnapshotBook[] = ["none", "real", "paper"];

/** A real book whose newest decision is older than this is not being traded: the sites' live-feed window (web/src/api.ts). */
export const REAL_BOOK_MAX_AGE_MS = 2 * 3_600_000;

/** PURE. The book to snapshot: SNAPSHOT_BOOK when it names one, else none. Never real or paper by default. */
export function snapshotBook(env: NodeJS.ProcessEnv): SnapshotBook {
  const raw = (env.SNAPSHOT_BOOK ?? "").trim().toLowerCase();
  if (raw) {
    if (!(SNAPSHOT_BOOKS as readonly string[]).includes(raw)) throw new Error(`SNAPSHOT_BOOK=${raw}: must be one of ${SNAPSHOT_BOOKS.join(", ")}`);
    return raw as SnapshotBook;
  }
  return "none";
}

/**
 * PURE. Why a snapshot from a plain shell must not run while the real desk is trading, or null when it may. A shell
 * with SNAPSHOT_BOOK unset sourced neither ops/live.env (real) nor the paper plist (none): on 25 Sep 2026 two hand-run
 * `npm run dash:deploy` from such a shell shipped journal.json empty and the 14 Sep board from data/ while a CATE/USDC
 * band was open. A real book with a decision inside REAL_BOOK_MAX_AGE_MS is a desk trading now.
 */
export function plainShellRefusal(env: NodeJS.ProcessEnv, realNewestTs: number | null, now: number, realDir = "data-mainnet"): string | null {
  // only the live desk's own book may ship while it trades: none (the paper plist, which is still installed with RunAtLoad and
  // AUTO_DEPLOY) would blank it on both sites every 30 minutes, paper would replace it (25 Sep 2026 review)
  const set = (env.SNAPSHOT_BOOK ?? "").trim().toLowerCase();
  if (set === "real") return null;
  if (realNewestTs === null || !Number.isFinite(realNewestTs) || now - realNewestTs > REAL_BOOK_MAX_AGE_MS) return null;
  const ago = Math.max(0, Math.round((now - realNewestTs) / 60_000));
  const what = set
    ? `SNAPSHOT_BOOK=${set} would publish ${set === "none" ? "an empty book" : "the paper book"}`
    : `SNAPSHOT_BOOK is not set: from this shell the snapshot would publish an empty book and this shell's DATA_DIR board`;
  return `snapshot: refused. ${realDir} has a real decision ${ago} min old and ${what} over a desk that is trading. Run it as the live desk does: set -a; . ops/live.env; set +a; npm run dash:deploy.`;
}

/** The newest decision's time in a real book's journal, or null when it has none readable. */
export function realBookNewestTs(realDir: string): number | null {
  const tail = readJsonlFile<{ ts?: string }>(path.join(realDir, "decisions.jsonl"), 5);
  const times = tail.map((e) => Date.parse(e?.ts ?? "")).filter((t) => Number.isFinite(t));
  return times.length ? Math.max(...times) : null;
}

/**
 * PURE. Of several copies of a market file (screen.json, hot.json: one per DATA_DIR), the newest by generatedAt. The
 * board is market data, the same screener on every desk, so the freshest copy is the true one whichever shell asks;
 * a copy with no stamp loses to one with.
 */
export function freshest<T extends { generatedAt?: unknown }>(candidates: readonly { dir: string; file: T | null }[]): { dir: string; file: T; at: number | null } | null {
  let best: { dir: string; file: T; at: number | null } | null = null;
  for (const c of candidates) {
    if (!c.file) continue;
    const parsed = Date.parse(String(c.file.generatedAt ?? ""));
    const at = Number.isFinite(parsed) ? parsed : null;
    if (!best || (at ?? -Infinity) > (best.at ?? -Infinity)) best = { dir: c.dir, file: c.file, at };
  }
  return best;
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
  /** the talk loop's state (TALK_STATE_PATH, default data-talk): build.json is his posted build notes from its x-posts.jsonl */
  talkDir?: string;
}

/** A build note he posted on X, as bands.finance shows it ("Built lately"). */
export interface BuildNote {
  id: string;
  at: string;
  type: "build" | "miss";
  text: string;
}

export const BUILD_NOTES_MAX = 8;
export const BUILD_NOTES_DAYS = 14;

/**
 * PURE. His posted build notes, newest first: type build or miss, posted (an X id, never a dry record), no replies,
 * within BUILD_NOTES_DAYS. They are public already (his own posts); bands.finance shows them as the platform's build log.
 */
export function buildNotesFrom(xPostsJsonl: string, now: number): BuildNote[] {
  const out: BuildNote[] = [];
  for (const line of xPostsJsonl.split("\n")) {
    if (!line.trim()) continue;
    let r: { id?: unknown; at?: unknown; type?: unknown; text?: unknown; replyTo?: unknown; dry?: unknown };
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const id = String(r.id ?? "");
    const at = Date.parse(String(r.at ?? ""));
    if (!/^\d{15,}$/.test(id) || r.dry || r.replyTo || (r.type !== "build" && r.type !== "miss") || typeof r.text !== "string") continue;
    if (!Number.isFinite(at) || at > now || now - at > BUILD_NOTES_DAYS * 86_400_000) continue;
    out.push({ id, at: new Date(at).toISOString(), type: r.type, text: r.text.trim() });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, BUILD_NOTES_MAX);
}

export interface SnapshotResult {
  /** the book actually written: none when a real book was asked for but is stale */
  book: SnapshotBook;
  /** set when SNAPSHOT_BOOK=real fell back to none: the real book's newest decision time, or "empty" */
  staleReal?: string;
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
  }
  let book = o.book;
  let staleReal: string | undefined;
  if (o.book === "real") {
    // one book: a rehearsal's rows in the live desk's directory are not its record (live.ts oneBook)
    const rows = readJsonlFile<JournalEntry>(path.join(o.realDir, "decisions.jsonl"), 600).reverse();
    entries = oneBook(rows, rows[0]);
    const marks = readJsonlFile<EquityPoint>(path.join(o.realDir, "equity.jsonl"), 20_000);
    points = oneBook(marks, marks[marks.length - 1]);
    // A finished run is the record, not "now": a real book with no decision in the last 2 h ships as none.
    const newestTs = Date.parse((entries[0] as { ts?: string } | undefined)?.ts ?? "");
    if (!Number.isFinite(newestTs) || (o.now ?? Date.now()) - newestTs > REAL_BOOK_MAX_AGE_MS) {
      staleReal = Number.isFinite(newestTs) ? new Date(newestTs).toISOString() : "empty";
      entries = [];
      points = [];
      book = "none";
    }
  }
  put("journal.json", JSON.stringify({ entries: redactCopycatDeep(entries, [...COPYCAT_MINTS, ...quietHouseMintsOf()]), generatedAt }));
  put("equity.json", JSON.stringify({ points, generatedAt }));
  const limits = o.book === "paper" ? processLimits : limitsFrom(liveEnv, processLimits);
  put("limits.json", JSON.stringify(limits, null, 2));

  // Market data, not his trades.
  // the board files carry mints: the copycat's and the quiet house mint are cut out of them like the journal
  const quiet = [...COPYCAT_MINTS, ...quietHouseMintsOf()];
  if (o.screen) put("screen.json", JSON.stringify(redactCopycatDeep(o.screen, quiet)));
  if (o.hot) put("hot.json", JSON.stringify(redactCopycatDeep(o.hot, quiet)));

  // What he learned: the real seats, read as the live book, under the real desk's own learning switches.
  // The SAME builder as /api/status (src/status.ts readLearnedView), so the panel and the API agree on a dir.
  const learned = readLearnedView({ dir: o.learnedDir, mode: "live", modelOn: false, env: { ...env, ...liveEnv }, now: o.now });
  put("learned.json", JSON.stringify(learned));

  // His build notes as posted on X: the platform's build log (bands.finance, "Built lately")
  if (o.talkDir) {
    let posts = "";
    try {
      posts = fs.readFileSync(path.join(o.talkDir, "x-posts.jsonl"), "utf8");
    } catch {
      posts = "";
    }
    put("build.json", JSON.stringify({ notes: redactCopycatDeep(buildNotesFrom(posts, o.now ?? Date.now())), generatedAt }));
  }

  const newest = entries[0] as { mode?: string; ts?: string } | undefined;
  return { book, staleReal, entries: entries.length, points: points.length, newest: newest ? `${newest.mode} ${newest.ts}` : null, limits, learned, wrote };
}
