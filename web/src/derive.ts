import type { Action, JournalEntry, Position } from "./types";

/** Optional quote fields newer journals carry; older entries are SOL-quoted (quote = SOL, price 1). */
function quoteMath(e: JournalEntry): { side: "X" | "Y"; priceInSol: number } {
  const q = e.pool as JournalEntry["pool"] & { quoteSide?: "X" | "Y"; quotePriceInSol?: number };
  return { side: q.quoteSide ?? e.pool.solSide ?? "Y", priceInSol: typeof q.quotePriceInSol === "number" && q.quotePriceInSol > 0 ? q.quotePriceInSol : 1 };
}

/** Unclaimed fees on a band in SOL: quote leg plus base leg at the pool price, converted at the quote's SOL price. */
export function feesInSol(p: Position, e: JournalEntry): number {
  const q = quoteMath(e);
  const inQuote = q.side === "X" ? p.feeX + (e.pool.price > 0 ? p.feeY / e.pool.price : 0) : p.feeY + p.feeX * e.pool.price;
  return inQuote * q.priceInSol;
}

/** Refundable rent per position account (SDK POSITION_FEE): what a paper band is charged and handed back. Leaves the wallet on open, returns on close. */
export const POSITION_RENT_SOL = 0.0574;
/** What a real position account holds since the rent change: (8120 + 128) bytes x 5080 lamports, what the chain refunds on close. */
export const LIVE_POSITION_RENT_SOL = 0.04189984;

/** The rent a band gets back on close: the band's own figure when the journal carries it, else what its book charged (the chain's for a live band). */
export function rentOf(p: Position, e: Pick<JournalEntry, "mode">): number {
  if (typeof p.rentSol === "number" && Number.isFinite(p.rentSol) && p.rentSol >= 0) return p.rentSol;
  return e.mode === "live" ? LIVE_POSITION_RENT_SOL : POSITION_RENT_SOL;
}

export function equityOf(e: JournalEntry): number {
  const w = e.wallet as JournalEntry["wallet"] & { quote?: number; quoteSymbol?: string };
  const q = quoteMath(e);
  const quoteSol = typeof w.quote === "number" && w.quoteSymbol && w.quoteSymbol !== "SOL" ? w.quote * q.priceInSol : 0;
  return e.wallet.sol + quoteSol + e.wallet.token * e.pool.tokenPriceInSol + e.positions.reduce((s, p) => s + p.valueInSol + rentOf(p, e), 0);
}

export type MarkerKind = "executed" | "blocked" | "override";

export interface SeriesPoint {
  t: number;
  price: number;
  bin: number;
  equity: number;
  bands: { address: string; lower: number; upper: number }[];
  marker: { kind: MarkerKind; action: Action } | null;
  entry: JournalEntry;
}

export interface ClosedBand {
  address: string;
  ts: string;
  entryValueSol: number | null;
  exitValueSol: number;
  pnlSol: number | null;
  action: Action;
}

export interface PoolView {
  address: string;
  label: string;
  /** newest first */
  entries: JournalEntry[];
  /** oldest first */
  series: SeriesPoint[];
  latest: JournalEntry;
}

export interface EquityPoint {
  t: number;
  equity: number;
}

export interface AgentSummary {
  id: string;
  name: string;
  pools: PoolView[];
  equitySeries: EquityPoint[];
  closed: ClosedBand[];
  wins: number;
  realizedPnlSol: number;
  /** newest first */
  entries: JournalEntry[];
  /** oldest first */
  series: SeriesPoint[];
  latest: JournalEntry;
  first: JournalEntry;
  equitySol: number;
  pnlSol: number;
  pnlPct: number;
  feesRealizedSol: number;
  feesUnclaimedSol: number;
  bandsOpen: number;
  bandsInRange: number;
  decisions: number;
  executed: number;
  blocked: number;
  overrides: number;
  holds: number;
  spanMs: number;
}

const executedAction = (e: JournalEntry) => e.allowed && e.execution.txs.length > 0 && e.execution.ok;

export function toSeries(newestFirst: JournalEntry[]): SeriesPoint[] {
  return [...newestFirst].reverse().map((e) => ({
    t: new Date(e.ts).getTime(),
    price: e.pool.price,
    bin: e.pool.activeBinId,
    equity: equityOf(e),
    bands: e.positions.map((p) => ({ address: p.address, lower: p.lowerPrice, upper: p.upperPrice })),
    marker: e.emergency
      ? { kind: "override", action: e.decision.action }
      : !e.allowed
        ? { kind: "blocked", action: e.proposal.action }
        : executedAction(e)
          ? { kind: "executed", action: e.decision.action }
          : null,
    entry: e,
  }));
}

/** The wallet's non-SOL quote (USDC) in SOL, when the entry carries one; the same wallet across every pool of a cycle. */
function quoteLegSol(e: JournalEntry): number | null {
  const w = e.wallet as JournalEntry["wallet"] & { quote?: number; quoteSymbol?: string };
  if (typeof w.quote !== "number" || !w.quoteSymbol || w.quoteSymbol === "SOL") return null;
  return w.quote * quoteMath(e).priceInSol;
}

/** One loop iteration: every entry the desk wrote in that cycle, oldest first. */
export interface Cycle {
  cycle: number;
  t: number;
  /** oldest first */
  entries: JournalEntry[];
}

/**
 * The journal grouped by cycle, oldest cycle first. The desk writes one entry per pool it works in a
 * cycle, so a cycle is the whole book at one moment: what it holds is exactly what it holds, and a
 * pool it stopped working (its band closed) is simply absent. That is the unit every money figure is
 * read from; "the latest entry per pool" is not, because a closed pool's last entry still lists the
 * band it was closing (the desk found a day-old band worth 50 SOL that way, 2026-09-16).
 */
export function cyclesOf(newestFirst: JournalEntry[]): Cycle[] {
  // Consecutive entries in time with the same cycle number are one cycle. The number alone is not
  // enough: it restarts at 1 with the desk, so two runs' "cycle 1" would merge into one book with
  // every band twice (a backfill found a 26-pool cycle worth 875 SOL that way, 2026-09-16). A gap of
  // more than CYCLE_GAP_MS between entries, or a pool written twice, starts a new cycle.
  const chrono = [...newestFirst].sort((a, b) => a.ts.localeCompare(b.ts));
  const out: Cycle[] = [];
  let cur: Cycle | null = null;
  let seen = new Set<string>();
  let lastT = 0;
  for (const e of chrono) {
    const t = new Date(e.ts).getTime();
    if (!cur || e.cycle !== cur.cycle || t - lastT > CYCLE_GAP_MS || seen.has(e.pool.address)) {
      cur = { cycle: e.cycle, t, entries: [] };
      out.push(cur);
      seen = new Set();
    }
    cur.entries.push(e);
    seen.add(e.pool.address);
    lastT = t;
  }
  return out;
}

/** Entries of one cycle are seconds apart; cycles are minutes apart. */
export const CYCLE_GAP_MS = 3 * 60_000;

/**
 * The cycles a window can be trusted for. A journal window is the newest N entries, so its oldest
 * cycle is usually cut mid-way: when it has fewer entries than the cycle after it, it is dropped.
 * The newest cycle is kept: the desk publishes its snapshot after the cycle completes.
 */
export function completeCycles(cycles: Cycle[]): Cycle[] {
  if (cycles.length >= 2 && cycles[0].entries.length < cycles[1].entries.length) return cycles.slice(1);
  return cycles;
}

/** An entry that closed its band for good: an executed CLOSE (a rebalance closes and reopens, so the pool goes on). */
const closedOut = (e: JournalEntry): boolean => e.decision.action === "CLOSE_POSITION" && e.allowed && e.execution.ok && e.execution.txs.length > 0;

type Wallet = JournalEntry["wallet"] & { quote?: number; quoteSymbol?: string };

/** A move the book itself made: the live desk's signed transactions or the paper book's. A dry run sends nothing, so its book is as it was. */
const bookMoved = (e: JournalEntry): boolean => e.execution.mode === "live" || e.execution.mode === "paper";

/**
 * The band an open laid, as the next cycle will read it: the decision's bins round the active bin (a Meteora band
 * includes it on every side, src/executor.ts toOpenPlan; a CLMM's one-sided band sits strictly beside it, src/tools/bins.ts),
 * priced off the active bin by the bin step, in range at the price it was laid, no fees yet, worth what went in. The
 * rent is the open's ledger row when the entry carries one, else the book's rule (rentOf).
 */
function laidBand(e: JournalEntry, o: NonNullable<JournalEntry["decision"]["open"]>, opened: NonNullable<JournalEntry["execution"]["opened"]>): Position {
  const p = e.pool;
  const q = quoteMath(e);
  const a = p.activeBinId;
  let lowerBinId = a - o.binsBelowActive;
  let upperBinId = a + o.binsAboveActive;
  const clmm = p.venue === "raydium-clmm" || p.venue === "orca-whirlpool";
  if (clmm && o.side !== "BOTH") {
    const belowOnly = o.side === "SOL_ONLY" ? q.side === "Y" : q.side === "X";
    if (belowOnly) upperBinId = a - 1;
    else lowerBinId = a + 1;
  }
  const priceAt = (bin: number) => p.price * Math.pow(1 + p.binStep / 10_000, bin - a);
  const inRange = lowerBinId <= a && a <= upperBinId;
  const quoteIsX = q.side === "X";
  const ledger = (e.execution as { ledger?: { mech?: string; position?: string; rentSol?: number }[] }).ledger;
  const rent = ledger?.find((r) => r.mech === "open" && r.position === opened.address && typeof r.rentSol === "number")?.rentSol;
  return {
    address: opened.address,
    lowerBinId,
    upperBinId,
    lowerPrice: priceAt(lowerBinId),
    upperPrice: priceAt(upperBinId),
    widthBins: upperBinId - lowerBinId + 1,
    inRange,
    binsFromRange: inRange ? 0 : a < lowerBinId ? a - lowerBinId : a - upperBinId,
    amountX: quoteIsX ? o.amountSol : o.amountToken,
    amountY: quoteIsX ? o.amountToken : o.amountSol,
    feeX: 0,
    feeY: 0,
    valueInSol: opened.entryValueSol,
    solInPosition: o.amountSol * q.priceInSol,
    lastUpdatedAt: Math.floor(Date.parse(e.ts) / 1000),
    entryValueSol: opened.entryValueSol,
    ...(typeof rent === "number" ? { rentSol: Math.abs(rent) } : {}),
  };
}

/**
 * An entry as the book stood AFTER its move. The desk journals a cycle's positions and wallet as it read them
 * before it acted (src/index.ts: `positions` and `wallet` are the observation, `execution` what followed), so
 * the entry that closed a band still lists it, the one that opened a band does not, and a claim's fees are
 * still inside the band. Read as is, the site said "Flat" for three minutes after the first live band opened,
 * showed the closed band "out by 2 bins" for five after the re-lay, and counted the re-lay's fees twice, banked
 * and still waiting (25 Sep 2026). Here the closed band is taken out and what it held goes to the wallet, the
 * opened band is laid as the decision asked (laidBand) and what went in leaves the wallet, and a claim's fees
 * move from the band to the wallet: the same money on the other side of the move, so the cycle's equity holds.
 * The entry's own `positions` stay what they were for readers of the move itself (a close's exit value, the
 * fees a claim banked: summarize, recordOf's fee points, actionsOf read the raw entry).
 */
export function heldAfter(e: JournalEntry): JournalEntry {
  if (!bookMoved(e)) return e;
  const x = e.execution;
  const q = quoteMath(e);
  const w: Wallet = { ...(e.wallet as Wallet) };
  const quoteIsSol = !w.quoteSymbol || w.quoteSymbol === "SOL";
  // a quote-unit amount lands in the wallet's quote leg: SOL itself, or the USDC leg; a SOL-quoted wallet mirrors its sol in `quote`
  const quoteAdd = (units: number) => {
    if (quoteIsSol) w.sol += units;
    if (typeof w.quote === "number") w.quote += units;
  };
  const quoteLeg = (p: Position) => (q.side === "Y" ? p.amountY + p.feeY : p.amountX + p.feeX);
  const baseLeg = (p: Position) => (q.side === "Y" ? p.amountX + p.feeX : p.amountY + p.feeY);
  let positions = e.positions;
  let moved = false;
  const closed = x.closed ? positions.find((p) => p.address === x.closed) : undefined;
  if (closed) {
    positions = positions.filter((p) => p !== closed);
    quoteAdd(quoteLeg(closed));
    w.token += baseLeg(closed);
    w.sol += rentOf(closed, e);
    moved = true;
  }
  if (e.decision.action === "CLAIM_FEES" && x.ok && x.txs.some((t) => t.ok)) {
    const target = e.decision.positionAddress;
    const after: Position[] = [];
    for (const p of positions) {
      if ((target && p.address !== target) || (p.feeX === 0 && p.feeY === 0)) {
        after.push(p);
        continue;
      }
      quoteAdd(q.side === "Y" ? p.feeY : p.feeX);
      w.token += q.side === "Y" ? p.feeX : p.feeY;
      moved = true;
      after.push({ ...p, feeX: 0, feeY: 0, valueInSol: Math.max(0, p.valueInSol - feesInSol(p, e)) });
    }
    positions = after;
  }
  const o = e.decision.open;
  const opened = x.opened;
  if (opened && o && !positions.some((p) => p.address === opened.address)) {
    const laid = laidBand(e, o, opened);
    positions = [...positions, laid];
    // a straddle buys part of its token leg with the quote first (acquireToken): that part never sat in the wallet
    const bought = Math.max(0, o.acquireToken ?? 0);
    const tokenPriceInQuote = typeof e.pool.tokenPriceInQuote === "number" ? e.pool.tokenPriceInQuote : e.pool.tokenPriceInSol / q.priceInSol;
    quoteAdd(-(o.amountSol + bought * tokenPriceInQuote));
    w.token -= Math.max(0, o.amountToken - bought);
    w.sol -= rentOf(laid, e);
    moved = true;
  }
  return moved ? { ...e, wallet: w, positions } : e;
}

/**
 * The newest cycle as the book: its entries, plus, for a pool the desk worked in the cycle before but
 * did not write this cycle (a read that failed, a pool skipped), that pool's previous entry when it
 * still held a band and did not close it. One cycle of carry only: a band the desk cannot see for
 * longer than that is dropped until it reads it again. Without the carry a single failed RPC read
 * knocked a 9 SOL band off the site for five minutes. Every entry is read as the book stood after its
 * move (heldAfter), so a band closed this cycle is off the book and one opened this cycle is on it.
 */
export function bookCycle(newestFirst: JournalEntry[]): Cycle | null {
  const cycles = cyclesOf(newestFirst);
  const newest = cycles[cycles.length - 1];
  if (!newest) return null;
  const held = { ...newest, entries: newest.entries.map(heldAfter) };
  const prev = cycles[cycles.length - 2];
  if (!prev) return held;
  const seen = new Set(newest.entries.map((e) => e.pool.address));
  const carried = prev.entries.filter((e) => !seen.has(e.pool.address) && !closedOut(e)).map(heldAfter).filter((e) => e.positions.length > 0);
  return carried.length ? { ...held, entries: [...held.entries, ...carried] } : held;
}

/** The wallet's USDC leg as one of the cycle's entries journals it, in SOL; null when none of them is USDC-quoted. */
export function cycleQuoteLegSol(c: Cycle): number | null {
  for (const e of c.entries) {
    const v = quoteLegSol(e);
    if (v !== null) return v;
  }
  return null;
}

/**
 * What the book was worth at one cycle: wallet SOL, the USDC leg, tokens held, and the bands with their rent
 * (equityOf's arithmetic). A SOL-quoted entry journals the wallet's SOL and token and nothing of its USDC (the
 * desk reads the wallet for the pool's own quote), so a cycle worked in SOL pools alone says nothing about the
 * USDC: the caller passes the leg the last USDC-quoted cycle carried (cycleEquitySeries), or the book drops it.
 */
export function cycleEquity(c: Cycle, carriedQuoteSol: number | null = null): number {
  const first = c.entries[0];
  const tokens = new Map<string, number>();
  let bands = 0;
  for (const e of c.entries) {
    const base = e.pool.solSide === "X" ? e.pool.tokenY.symbol : e.pool.tokenX.symbol;
    tokens.set(base, e.wallet.token * e.pool.tokenPriceInSol);
    bands += e.positions.reduce((s, p) => s + p.valueInSol + rentOf(p, e), 0);
  }
  return first.wallet.sol + (cycleQuoteLegSol(c) ?? carriedQuoteSol ?? 0) + [...tokens.values()].reduce((s, v) => s + v, 0) + bands;
}

/**
 * cycleEquity per cycle, oldest first, the USDC leg carried across the cycles that do not journal it. On 25 Sep
 * 2026 a cycle worked in ANTHROPIC/SOL alone marked a wallet holding 71 USDC as if it held none: 0.6 SOL of a 5
 * SOL book. `book` stands in for the newest cycle (bookCycle's carried entries).
 */
export function cycleEquitySeries(cycles: Cycle[], book: Cycle | null = null): number[] {
  let quoteSol: number | null = null;
  return cycles.map((c, i) => {
    const cyc = i === cycles.length - 1 && book ? book : c;
    // the leg a later SOL-quoted cycle carries is the one this cycle left AFTER its moves (a close hands its USDC back)
    const own = cycleQuoteLegSol({ ...cyc, entries: cyc.entries.map(heldAfter) });
    if (own !== null) quoteSol = own;
    return cycleEquity(cyc, quoteSol);
  });
}

/** Equity per loop iteration across every pool the agent observed in it. */
export function equitySeriesOf(newestFirst: JournalEntry[]): EquityPoint[] {
  const all = cyclesOf(newestFirst);
  const cycles = completeCycles(all);
  const book = bookCycle(newestFirst);
  // the USDC leg is carried from the cut oldest cycle too, when that is where it was last journaled
  const equity = cycleEquitySeries(all, book).slice(all.length - cycles.length);
  return cycles.map((c, i) => ({ t: c.t, equity: equity[i] }));
}

export function summarize(id: string, name: string, newestFirst: JournalEntry[]): AgentSummary {
  const latest = newestFirst[0];
  const first = newestFirst[newestFirst.length - 1];
  const byPool = new Map<string, JournalEntry[]>();
  for (const e of newestFirst) byPool.set(e.pool.address, [...(byPool.get(e.pool.address) ?? []), e]);
  const pools: PoolView[] = [...byPool.entries()]
    .map(([address, es]) => ({ address, label: es[0].pool.label, entries: es, series: toSeries(es), latest: es[0] }))
    .sort((a, b) => b.latest.positions.length - a.latest.positions.length || b.latest.ts.localeCompare(a.latest.ts));
  const series = pools[0]?.series ?? [];
  const equitySeries = equitySeriesOf(newestFirst);
  const equitySol = equitySeries[equitySeries.length - 1]?.equity ?? equityOf(latest);
  const startEquity = equitySeries[0]?.equity ?? equityOf(first);
  // the bands on the book: the newest cycle's, not the last entry of every pool ever worked
  const latestPositions = (bookCycle(newestFirst)?.entries ?? []).flatMap((e) => e.positions.map((pos) => ({ pos, e })));
  let feesRealizedSol = 0;
  for (const e of newestFirst) {
    if (!executedAction(e)) continue;
    const a = e.decision.action;
    if (a !== "CLAIM_FEES" && a !== "CLOSE_POSITION" && a !== "REBALANCE") continue;
    const targets = e.decision.positionAddress ? e.positions.filter((p) => p.address === e.decision.positionAddress) : e.positions;
    feesRealizedSol += targets.reduce((s, p) => s + feesInSol(p, e), 0);
  }
  const feesUnclaimedSol = latestPositions.reduce((s, { pos, e }) => s + feesInSol(pos, e), 0);
  const closed: ClosedBand[] = [];
  const claimedByBand = new Map<string, number>();
  for (const e of [...newestFirst].reverse()) {
    if (!executedAction(e)) continue;
    if (e.decision.action === "CLAIM_FEES") {
      const targets = e.decision.positionAddress ? e.positions.filter((p) => p.address === e.decision.positionAddress) : e.positions;
      for (const p of targets) claimedByBand.set(p.address, (claimedByBand.get(p.address) ?? 0) + feesInSol(p, e));
      continue;
    }
    if (e.decision.action !== "CLOSE_POSITION" && e.decision.action !== "REBALANCE") continue;
    const p = e.positions.find((x) => x.address === e.decision.positionAddress);
    if (!p) continue;
    const entry = p.entryValueSol ?? null;
    const exit = p.valueInSol + (claimedByBand.get(p.address) ?? 0);
    closed.push({ address: p.address, ts: e.ts, entryValueSol: entry, exitValueSol: exit, pnlSol: entry === null ? null : exit - entry, action: e.decision.action });
  }
  return {
    id,
    name,
    pools,
    equitySeries,
    closed,
    wins: closed.filter((c) => (c.pnlSol ?? 0) > 0).length,
    realizedPnlSol: closed.reduce((s, c) => s + (c.pnlSol ?? 0), 0),
    entries: newestFirst,
    series,
    latest,
    first,
    equitySol,
    pnlSol: equitySol - startEquity,
    pnlPct: startEquity > 0 ? ((equitySol - startEquity) / startEquity) * 100 : 0,
    feesRealizedSol,
    feesUnclaimedSol,
    bandsOpen: latestPositions.length,
    bandsInRange: latestPositions.filter(({ pos }) => pos.inRange).length,
    decisions: newestFirst.length,
    executed: newestFirst.filter(executedAction).length,
    blocked: newestFirst.filter((e) => !e.allowed).length,
    overrides: newestFirst.filter((e) => e.emergency).length,
    holds: newestFirst.filter((e) => e.decision.action === "HOLD").length,
    spanMs: new Date(latest.ts).getTime() - new Date(first.ts).getTime(),
  };
}

export function groupAgents(entries: JournalEntry[]): AgentSummary[] {
  const byId = new Map<string, { name: string; entries: JournalEntry[] }>();
  for (const e of entries) {
    const id = e.agent?.id ?? "mr-bands";
    const name = e.agent?.name ?? "Mr Bands";
    const g = byId.get(id) ?? { name, entries: [] };
    g.entries.push(e);
    byId.set(id, g);
  }
  return [...byId.entries()].map(([id, g]) => summarize(id, g.name, g.entries));
}

/** Nice tick values for a linear scale. */
export function ticks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

export type RangeKey = "6h" | "24h" | "7d" | "all";
export const RANGE_MS: Record<RangeKey, number> = { "6h": 6 * 3600e3, "24h": 24 * 3600e3, "7d": 7 * 86400e3, all: Infinity };
export const RANGE_LABEL: Record<RangeKey, string> = { "6h": "last 6 hours", "24h": "last 24 hours", "7d": "last 7 days", all: "all time" };

/** Entries within the range (newest first). Falls back to everything if the range is empty. */
export function inRange(entries: JournalEntry[], key: RangeKey, now: number): JournalEntry[] {
  const ms = RANGE_MS[key];
  if (!Number.isFinite(ms)) return entries;
  const kept = entries.filter((e) => now - new Date(e.ts).getTime() <= ms);
  return kept.length ? kept : entries;
}
