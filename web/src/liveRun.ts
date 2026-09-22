import { actionsOf, recordOf, statusOf, type ActionRow, type AgentRecord, type Status } from "./model";
import type { EquityHistoryPoint, JournalEntry } from "./types";

/**
 * THE LIVE RUN, frozen. The desk traded its own wallet on Solana from 17 to 19 September 2026 and was
 * then stopped and emptied; the live desk is halted until it is funded again. The live feed (api.ts) is
 * a window the next live desk overwrites and the page discards once the snapshot is newer, so the
 * run's transactions, the one thing a reader can check for himself, had fallen off the page.
 * src/scripts/freeze-live-run.ts writes the run once to /live-run.json (the executed moves with their
 * transactions, and the equity history), and this module reads it: the same record and the same
 * ledger rows as the rest of the page (model.ts recordOf, actionsOf), so nothing here is counted
 * differently from any other book the page shows. While no book is open (statusOf "none") this run
 * is his whole record, and the empty chapters point at it (runDays).
 */
export interface LiveRunFile {
  frozenAt: string;
  source: string;
  mode: "live";
  agent: { id: string; name: string };
  wallet: string;
  /** the run's first and last decision, holds included */
  firstTs: string;
  lastTs: string;
  decisions: number;
  holds: number;
  failed: number;
  /** the book's best and worst marks over the run, measured from every equity point before thinning */
  peakEquitySol: number;
  lowEquitySol: number;
  /** the executed moves, newest first, trimmed to what the model reads */
  entries: JournalEntry[];
  /** the equity history, thinned: every day's first and last mark are kept */
  points: EquityHistoryPoint[];
  /**
   * The run as it ended in cash, from data-mainnet/ledger.jsonl (npm run record, docs/sprint.md "One
   * headline number"): the last mark still had a band open, and the hand close a few minutes later is
   * the book's true end, all SOL. When present, the page states these and not the last mark.
   */
  settled?: { ts: string; equitySol: number; feesSol: number; feesInTokensSol: number; source: string };
}

export interface LiveRun {
  wallet: string;
  agentName: string;
  firstTs: number;
  lastTs: number;
  hours: number;
  startEquity: number;
  endEquity: number;
  change: number;
  changePct: number;
  peakEquity: number;
  lowEquity: number;
  /** fees realised to the wallet over the run, SOL, each valued at its own mark (the ledger's when settled) */
  feesClaimed: number;
  /** of feesClaimed, what came as tokens valued at the claim's mark; null when the file does not say */
  feesInTokens: number | null;
  /** true when endEquity is the ledger's all-cash end and not the last mark */
  settled: boolean;
  /** the equity series' last mark, which the chart ends on */
  lastMarkEquity: number;
  /** every executed move, claims included, as the ledger lists them */
  moves: number;
  opens: number;
  relays: number;
  closes: number;
  claims: number;
  transactions: number;
  /** pool labels, newest first */
  pools: string[];
  decisions: number;
  holds: number;
  failed: number;
  /** the ledger rows, newest first */
  rows: ActionRow[];
  record: AgentRecord;
  status: Status;
  frozenAt: number;
}

const isFile = (j: unknown): j is LiveRunFile => {
  const f = j as Partial<LiveRunFile> | null;
  return !!f && f.mode === "live" && typeof f.wallet === "string" && typeof f.firstTs === "string" && typeof f.lastTs === "string" && Array.isArray(f.entries) && Array.isArray(f.points);
};

/** PURE. The run's record from the frozen file; null when the file holds no move. */
export function liveRunOf(file: LiveRunFile): LiveRun | null {
  const entries = file.entries;
  const record = recordOf(entries, file.points);
  if (!record || entries.length === 0) return null;
  const rows = actionsOf(entries, entries.length);
  const count = (a: ActionRow["action"]) => rows.filter((r) => r.action === a).length;
  const firstTs = Date.parse(file.firstTs);
  const lastTs = Date.parse(file.lastTs);
  const settled = file.settled && typeof file.settled.equitySol === "number" && typeof file.settled.feesSol === "number" ? file.settled : null;
  const endEquity = settled ? settled.equitySol : record.equityNow;
  const change = endEquity - record.startEquity;
  const pools: string[] = [];
  for (const e of entries) if (!pools.includes(e.pool.label)) pools.push(e.pool.label);
  return {
    wallet: file.wallet,
    agentName: file.agent?.name ?? "Mr Bands",
    firstTs,
    lastTs,
    hours: (lastTs - firstTs) / 3600e3,
    startEquity: record.startEquity,
    endEquity,
    change,
    changePct: settled ? (record.startEquity > 0 ? (change / record.startEquity) * 100 : 0) : record.netPct,
    peakEquity: typeof file.peakEquitySol === "number" ? file.peakEquitySol : Math.max(record.startEquity, record.equityNow),
    lowEquity: typeof file.lowEquitySol === "number" ? file.lowEquitySol : Math.min(record.startEquity, record.equityNow),
    feesClaimed: settled ? settled.feesSol : record.feesRealized,
    feesInTokens: settled && typeof settled.feesInTokensSol === "number" ? settled.feesInTokensSol : null,
    settled: !!settled,
    lastMarkEquity: record.equityNow,
    moves: rows.length,
    opens: count("OPEN_POSITION"),
    relays: count("REBALANCE"),
    closes: count("CLOSE_POSITION"),
    claims: count("CLAIM_FEES"),
    transactions: entries.reduce((n, e) => n + e.execution.txs.filter((t) => t.signature).length, 0),
    pools,
    decisions: typeof file.decisions === "number" ? file.decisions : entries.length,
    holds: typeof file.holds === "number" ? file.holds : 0,
    failed: typeof file.failed === "number" ? file.failed : 0,
    rows,
    record,
    // the status the ledger component asks for: a live run, as of its last decision
    status: statusOf(entries, lastTs, false),
    frozenAt: Date.parse(file.frozenAt) || lastTs,
  };
}

/* ---------- the run's dates, the way a person says them (UTC, as the journal's days are) ---------- */

const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "17 September" */
export const dayOf = (t: number) => `${new Date(t).getUTCDate()} ${MONTH[new Date(t).getUTCMonth()]}`;
/** "17–19 September", or "30 September – 2 October" across a month */
export function spanWords(a: number, b: number): string {
  const da = new Date(a);
  const db = new Date(b);
  if (da.getUTCMonth() === db.getUTCMonth()) return da.getUTCDate() === db.getUTCDate() ? dayOf(a) : `${da.getUTCDate()}–${db.getUTCDate()} ${MONTH[da.getUTCMonth()]}`;
  return `${dayOf(a)} – ${dayOf(b)}`;
}
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "17 to 19 Sep", or "30 Sep to 2 Oct" across a month: the run's days in a sentence (UTC) */
export function runDays(a: number, b: number): string {
  const da = new Date(a);
  const db = new Date(b);
  const d = (x: Date) => `${x.getUTCDate()} ${MON[x.getUTCMonth()]}`;
  if (da.getUTCMonth() !== db.getUTCMonth()) return `${d(da)} to ${d(db)}`;
  return da.getUTCDate() === db.getUTCDate() ? d(da) : `${da.getUTCDate()} to ${d(db)}`;
}

/** "39 hours" under two days, "3 days" past it: the run's length the way a person says it */
export function lengthWords(hours: number): string {
  if (hours < 48) {
    const h = Math.max(1, Math.round(hours));
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round(hours / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/** The file is a record, not a feed: fetched once, kept for the life of the page. Null when the host has none. */
let pending: Promise<LiveRun | null> | null = null;
export function loadLiveRun(url = "/live-run.json"): Promise<LiveRun | null> {
  if (!pending) {
    pending = fetch(url, { headers: { accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null))
      .then((j) => (isFile(j) ? liveRunOf(j) : null))
      .catch(() => null);
  }
  return pending;
}
