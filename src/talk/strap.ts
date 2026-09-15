/**
 * Strap state and the stack's numbers, from LIVE data only (docs/mr-bands-agent.md sections 3 and 5).
 * PURE: every function takes the data it reads (src/talk/data.ts loads it from DATA_DIR).
 *
 *   strapOf        green / yellow / red / stacked / flat, or unknown when the data is missing or stale
 *   stackFigures   realized fees, closed bands (wins and losses), rent, swaps, network fees, red days and
 *                  the unrealized marks for a window, from the ledger rows (src/engine/ledger.ts)
 *   stackedEventOf the newest fee claim ("compound") or fee milestone in the ledger
 *   windowLabel    "last 24h", "last 7d": every recap says which window it covers
 *
 * Precedence: unknown > flat > red > stacked > yellow > green. "stacked" hides yellow only in the
 * state name; nearEdge still counts the bands at an edge.
 */
import type { LedgerRow } from "../engine/ledger";
import { DEFAULT_STRAP_EDGE_PCT, DEFAULT_STRAP_STACKED_HOURS, type TalkEnv } from "./env";

export type StrapState = "green" | "yellow" | "red" | "stacked" | "flat" | "unknown";

export interface StrapPositionInput {
  inRange: boolean;
  /** the band's lowest and highest bin prices, in the same unit as activePrice */
  lowerPrice: number;
  upperPrice: number;
  activePrice: number;
  /** "nvdax/sol" */
  label?: string;
  /** 0 in range; negative below the band, positive above */
  binsFromRange?: number;
}

export interface StackedEvent {
  kind: "compound" | "milestone";
  /** epoch ms */
  at: number;
  detail: string;
}

export interface StrapInput {
  positions: StrapPositionInput[];
  stackedEvent: StackedEvent | null;
  now: number;
  /** epoch ms of the newest journal entry; null when there is none */
  dataAt: number | null;
  /** a reason the loader already knows the data cannot be trusted (an unmarked band, a stale book) */
  staleReason?: string | null;
}

export type StrapPositionStatus = "in" | "near_top" | "near_bottom" | "out_above" | "out_below" | "out";

export interface StrapPositionView {
  label: string | null;
  status: StrapPositionStatus;
  /** distance to the nearer edge as a percent of the band's width (0 at an edge); null out of range */
  edgeDistancePct: number | null;
  binsFromRange: number | null;
}

export interface StrapResult {
  state: StrapState;
  total: number;
  inRange: number;
  nearEdge: number;
  outOfRange: number;
  positions: StrapPositionView[];
  stackedEvent: StackedEvent | null;
  /** plain-words summary for the CLI */
  detail: string;
  /** why the state is unknown */
  reason: string | null;
  edgePct: number;
  dataAt: number | null;
}

type StrapEnv = Pick<TalkEnv, "strapEdgePct" | "strapStackedHours" | "cycleIntervalSec">;

const HOUR = 3600e3;
const DAY = 24 * HOUR;

/** Data older than this many cycles is stale. */
export const STALE_CYCLES = 3;

export const fmtAge = (ms: number): string => (ms < HOUR ? `${Math.max(0, Math.round(ms / 60e3))} min` : ms < 2 * DAY ? `${(ms / HOUR).toFixed(1)} h` : `${(ms / DAY).toFixed(1)} d`);

/** 24h -> "last 24h", 7d -> "last 7d", 6h -> "last 6h", 90 min -> "last 90m". */
export function windowLabel(ms: number): string {
  if (ms >= DAY && ms % DAY === 0 && ms !== DAY) return `last ${ms / DAY}d`;
  if (ms >= HOUR && ms % HOUR === 0) return `last ${ms / HOUR}h`;
  return `last ${Math.max(1, Math.round(ms / 60e3))}m`;
}

function unknown(reason: string, input: StrapInput, edgePct: number): StrapResult {
  return { state: "unknown", total: input.positions.length, inRange: 0, nearEdge: 0, outOfRange: 0, positions: [], stackedEvent: null, detail: `unknown: ${reason}`, reason, edgePct, dataAt: input.dataAt };
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** One band's place in its range. Returns null when the numbers cannot be trusted. */
export function positionView(p: StrapPositionInput, edgePct: number): StrapPositionView | null {
  if (typeof p.inRange !== "boolean" || !finite(p.lowerPrice) || !finite(p.upperPrice) || !finite(p.activePrice)) return null;
  if (p.lowerPrice <= 0 || p.upperPrice < p.lowerPrice || p.activePrice <= 0) return null;
  const label = p.label ?? null;
  const bins = finite(p.binsFromRange) ? p.binsFromRange : null;
  if (!p.inRange) {
    const above = bins !== null ? bins > 0 : p.activePrice > p.upperPrice;
    const below = bins !== null ? bins < 0 : p.activePrice < p.lowerPrice;
    return { label, status: above ? "out_above" : below ? "out_below" : "out", edgeDistancePct: null, binsFromRange: bins };
  }
  const width = p.upperPrice - p.lowerPrice;
  // a one-bin band has no width between its bin prices: it sits at its edge by construction
  if (width <= 0) return { label, status: p.activePrice >= p.upperPrice ? "near_top" : "near_bottom", edgeDistancePct: 0, binsFromRange: bins };
  const fromBottom = Math.max(0, Math.min(100, ((p.activePrice - p.lowerPrice) / width) * 100));
  const fromTop = Math.max(0, Math.min(100, ((p.upperPrice - p.activePrice) / width) * 100));
  const nearest = Math.min(fromBottom, fromTop);
  const status: StrapPositionStatus = nearest < edgePct ? (fromTop <= fromBottom ? "near_top" : "near_bottom") : "in";
  return { label, status, edgeDistancePct: nearest, binsFromRange: bins };
}

export function strapOf(input: StrapInput, env: StrapEnv): StrapResult {
  const edgePct = finite(env.strapEdgePct) ? env.strapEdgePct : DEFAULT_STRAP_EDGE_PCT;
  const stackedHours = finite(env.strapStackedHours) ? env.strapStackedHours : DEFAULT_STRAP_STACKED_HOURS;
  if (input.dataAt === null || !finite(input.dataAt)) return unknown("no journal entries to read positions from", input, edgePct);
  const staleMs = STALE_CYCLES * env.cycleIntervalSec * 1000;
  const age = input.now - input.dataAt;
  if (age > staleMs) return unknown(`the newest journal entry is ${fmtAge(age)} old, more than ${STALE_CYCLES} cycles (${fmtAge(staleMs)})`, input, edgePct);
  if (input.staleReason) return unknown(input.staleReason, input, edgePct);

  const views: StrapPositionView[] = [];
  for (const [i, p] of input.positions.entries()) {
    const view = positionView(p, edgePct);
    if (!view) return unknown(`position ${p.label ?? i + 1} has missing or inconsistent range data`, input, edgePct);
    views.push(view);
  }
  const outOfRange = views.filter((v) => v.status.startsWith("out")).length;
  const nearEdge = views.filter((v) => v.status === "near_top" || v.status === "near_bottom").length;
  const inRange = views.length - outOfRange;
  const ev = input.stackedEvent;
  const stackedRecent = !!ev && finite(ev.at) && ev.at <= input.now && input.now - ev.at <= stackedHours * HOUR;

  let state: StrapState;
  if (views.length === 0) state = "flat";
  else if (outOfRange > 0) state = "red";
  else if (stackedRecent) state = "stacked";
  else if (nearEdge > 0) state = "yellow";
  else state = "green";

  const parts = [`${views.length} band(s)`, `${inRange} in range`, `${nearEdge} within ${edgePct}% of the band width from an edge`, `${outOfRange} out of range`];
  if (stackedRecent && ev) parts.push(`${ev.kind} ${fmtAge(input.now - ev.at)} ago: ${ev.detail}`);
  return { state, total: views.length, inRange, nearEdge, outOfRange, positions: views, stackedEvent: stackedRecent ? ev : null, detail: `${state}: ${parts.join(", ")}`, reason: null, edgePct, dataAt: input.dataAt };
}

// ---------------------------------------------------------------- the stack's numbers

/** Where the numbers come from. Paper rows are dry-run rows the paper executor wrote ("paper: ..."). */
export type TalkSource = "paper" | "live" | "dry-run";

export function rowsForSource(rows: readonly LedgerRow[], source: TalkSource): LedgerRow[] {
  if (source === "live") return rows.filter((r) => r.mode === "live");
  const paper = (r: LedgerRow) => typeof r.note === "string" && r.note.startsWith("paper");
  return rows.filter((r) => r.mode === "dry-run" && (source === "paper" ? paper(r) : !paper(r)));
}

/** What an open book is marked at right now: unrealized, never added to realized. */
export interface OpenMarks {
  feesUnclaimedSol: number;
  markedBandsSol: number;
  bands: number;
  asOf: number | null;
}

export interface StackFigures {
  source: TalkSource;
  window: string;
  since: number;
  until: number;
  /** claims + the fee legs of closes */
  feesRealizedSol: number;
  claimsSol: number;
  claims: number;
  closeFeeLegsSol: number;
  closedBands: number;
  closedUp: number;
  closedDown: number;
  /** closed bands' proceeds (incl. their fee legs) - entry value */
  closedNetSol: number;
  /** the worst closed band's result, when any closed */
  worstCloseSol: number | null;
  /** rent paid (negative) net of refunds */
  rentSol: number;
  /** swap legs' cost at their marks (negative) */
  swapSol: number;
  /** network fees (negative) */
  txFeesSol: number;
  /** claims + closed net + rent + swaps + network fees */
  netRealizedSol: number;
  /** UTC days in the window with ledger rows, and how many of them netted below zero */
  days: number;
  redDays: number;
  firstRowAt: number | null;
  lastRowAt: number | null;
  open: OpenMarks | null;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/** One row's realized contribution: the same fold for the window and for each day. */
function rowRealized(r: LedgerRow): number {
  const back = r.solDelta + r.tokenDelta * (r.markTokenInSol || 0);
  const rent = r.rentSol || 0;
  const fee = r.txFeeSol || 0;
  if (r.mech === "collect") return (r.feeSol ?? back) + rent + fee;
  if (r.mech === "close") return back - (r.entryValueSol ?? back) + rent + fee;
  if (r.mech === "swap") return back + rent + fee;
  // open (the deposit is not realized), rent, skim, txfee: only rent and the network fee
  return rent + fee;
}

export function stackFigures(i: { rows: readonly LedgerRow[]; source: TalkSource; since: number; until: number; open?: OpenMarks | null }): StackFigures {
  const rows = rowsForSource(i.rows, i.source).filter((r) => r.ts >= i.since && r.ts <= i.until);
  const f: StackFigures = {
    source: i.source,
    window: windowLabel(i.until - i.since),
    since: i.since,
    until: i.until,
    feesRealizedSol: 0,
    claimsSol: 0,
    claims: 0,
    closeFeeLegsSol: 0,
    closedBands: 0,
    closedUp: 0,
    closedDown: 0,
    closedNetSol: 0,
    worstCloseSol: null,
    rentSol: 0,
    swapSol: 0,
    txFeesSol: 0,
    netRealizedSol: 0,
    days: 0,
    redDays: 0,
    firstRowAt: rows.length ? Math.min(...rows.map((r) => r.ts)) : null,
    lastRowAt: rows.length ? Math.max(...rows.map((r) => r.ts)) : null,
    open: i.open ?? null,
  };
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const back = r.solDelta + r.tokenDelta * (r.markTokenInSol || 0);
    if (r.mech === "collect") {
      f.claims += 1;
      f.claimsSol += r.feeSol ?? back;
    } else if (r.mech === "close") {
      const net = back - (r.entryValueSol ?? back);
      f.closedBands += 1;
      f.closeFeeLegsSol += r.feeSol ?? 0;
      f.closedNetSol += net;
      if (net >= 0) f.closedUp += 1;
      else f.closedDown += 1;
      f.worstCloseSol = f.worstCloseSol === null ? net : Math.min(f.worstCloseSol, net);
    } else if (r.mech === "swap") {
      f.swapSol += back;
    }
    f.rentSol += r.rentSol || 0;
    f.txFeesSol += r.txFeeSol || 0;
    const d = dayOf(r.ts);
    byDay.set(d, (byDay.get(d) ?? 0) + rowRealized(r));
  }
  f.feesRealizedSol = r6(f.claimsSol + f.closeFeeLegsSol);
  f.claimsSol = r6(f.claimsSol);
  f.closeFeeLegsSol = r6(f.closeFeeLegsSol);
  f.closedNetSol = r6(f.closedNetSol);
  f.worstCloseSol = f.worstCloseSol === null ? null : r6(f.worstCloseSol);
  f.rentSol = r6(f.rentSol);
  f.swapSol = r6(f.swapSol);
  f.txFeesSol = r6(f.txFeesSol);
  f.netRealizedSol = r6(f.claimsSol + f.closedNetSol + f.rentSol + f.swapSol + f.txFeesSol);
  f.days = byDay.size;
  f.redDays = [...byDay.values()].filter((v) => v < -1e-9).length;
  return f;
}

/** The newest fee claim and the newest crossing of a multiple of the milestone, whichever is later. */
export function stackedEventOf(rows: readonly LedgerRow[], source: TalkSource, env: Pick<TalkEnv, "feeMilestoneSol" | "stackedEvents">): StackedEvent | null {
  const mine = rowsForSource(rows, source).slice().sort((a, b) => a.ts - b.ts);
  let compound: StackedEvent | null = null;
  let milestone: StackedEvent | null = null;
  let cum = 0;
  const step = env.feeMilestoneSol > 0 ? env.feeMilestoneSol : 1;
  for (const r of mine) {
    if (r.mech !== "collect" && r.mech !== "close") continue;
    const fee = r.feeSol ?? 0;
    if (r.mech === "collect" && fee > 0) compound = { kind: "compound", at: r.ts, detail: `claimed ${fee.toFixed(4)} sol in fees into the stack` };
    const before = Math.floor(cum / step + 1e-9);
    cum += fee;
    const after = Math.floor(cum / step + 1e-9);
    if (after > before && after > 0) milestone = { kind: "milestone", at: r.ts, detail: `realized fees passed ${r6(after * step)} sol` };
  }
  const candidates = [env.stackedEvents.compound ? compound : null, env.stackedEvents.milestone ? milestone : null].filter((e): e is StackedEvent => !!e);
  return candidates.sort((a, b) => b.at - a.at)[0] ?? null;
}
