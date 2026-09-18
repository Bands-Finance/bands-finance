/**
 * One place that turns journal entries into what the page says.
 * Every component reads from here so the words and the numbers cannot disagree.
 */
import { bookCycle, completeCycles, cycleEquity, cyclesOf, equityOf, feesInSol, POSITION_RENT_SOL } from "./derive";
import type { Action, Decision, EquityHistoryPoint, FlowContext, JournalEntry, Position, StockTag } from "./types";

/* ---------- words ---------- */

export const ACTION_WORDS: Record<Action, string> = {
  HOLD: "hold",
  OPEN_POSITION: "open a band",
  CLOSE_POSITION: "close a band",
  CLAIM_FEES: "claim fees",
  REBALANCE: "move a band",
};
export const ACTION_PAST: Record<Action, string> = {
  HOLD: "held",
  OPEN_POSITION: "opened a band",
  CLOSE_POSITION: "closed a band",
  CLAIM_FEES: "claimed fees",
  REBALANCE: "moved a band",
};
export const SIDE_WORDS: Record<string, string> = {
  SOL_ONLY: "SOL just under the price",
  TOKEN_ONLY: "token just over the price",
  BOTH: "both sides of the price",
};
/** Optional quote fields newer journals carry; older entries are SOL-quoted. */
interface QuoteFields {
  quoteSymbol?: "SOL" | "USDC";
  quoteSide?: "X" | "Y";
  quotePriceInSol?: number;
  tokenPriceInQuote?: number;
}
export interface QuoteView {
  symbol: "SOL" | "USDC";
  side: "X" | "Y";
  priceInSol: number;
  tokenPriceInQuote: number;
}
/** The quote token of a journal pool: SOL for every old entry, USDC for stock pools and the like. */
export function quoteOf(pool: JournalEntry["pool"]): QuoteView {
  const q = pool as JournalEntry["pool"] & QuoteFields;
  const priceInSol = typeof q.quotePriceInSol === "number" && q.quotePriceInSol > 0 ? q.quotePriceInSol : 1;
  return {
    symbol: q.quoteSymbol ?? "SOL",
    side: q.quoteSide ?? pool.solSide ?? "Y",
    priceInSol,
    tokenPriceInQuote: typeof q.tokenPriceInQuote === "number" ? q.tokenPriceInQuote : pool.tokenPriceInSol / priceInSol,
  };
}
/** Side words with the pool's own quote token named ("USDC just under the price" in a USDC pool). */
export function sideWords(side: string, quote: QuoteView): string {
  const w = SIDE_WORDS[side] ?? side;
  return quote.symbol === "SOL" ? w : w.replace(/^SOL\b/, quote.symbol);
}
export const GLOSS = {
  band: "A band is a slice of price Mr Bands puts SOL into. Every trade that crosses it pays him a fee.",
  inRange: "In range means the current price is inside the band, so it is earning right now.",
  bin: "Pools on Meteora cut price into small steps called bins. A band is a run of bins.",
  dryRun: "Dry run: he decides exactly as he would live, the wallet builds and simulates the transaction, and nothing is broadcast.",
  paper: "Paper trading: real pools, real prices, a pretend wallet. Every band, fee and hedge below is marked against the live market, and no transaction is ever sent.",
  demo: "Demo data: a seeded five-hour example of how he decides, not a real run.",
  guards: "Plain code around the AI: caps, a stop-loss, a cooldown. It can veto him or pull him out, and it prints why.",
};

/* ---------- verdicts ---------- */

export type Verdict = "placed" | "simulated" | "failed" | "blocked" | "override" | "hold";

export function verdictOf(e: JournalEntry): Verdict {
  if (e.emergency) return "override";
  if (!e.allowed) return "blocked";
  if (e.execution.txs.some((t) => !t.ok)) return "failed";
  if (e.execution.txs.length > 0) return e.execution.mode === "live" ? "placed" : "simulated";
  return "hold";
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  placed: "SENT ON-CHAIN",
  simulated: "SIMULATED · not broadcast",
  failed: "FAILED",
  blocked: "VETOED BY THE GUARDS",
  override: "GUARDS OVERRODE HIM",
  hold: "HOLD",
};

const isSolY = (e: JournalEntry) => e.pool.solSide !== "X";

/* ---------- desk blocks (the terminal) ---------- */

export interface DeskTx {
  label: string;
  text: string;
  href: string | null;
}

export interface DeskBlock {
  key: string;
  first: JournalEntry;
  last: JournalEntry;
  /** how many consecutive identical reads folded into this block */
  count: number;
  pool: string;
  verdict: Verdict;
  action: Action;
  /** what he saw, one line each */
  saw: string[];
  /** what he proposed, when it differs from what happened */
  proposed: string | null;
  /** what the guards said */
  guards: string | null;
  /** the decision in words */
  decision: string;
  why: string;
  headline: string;
  txs: DeskTx[];
  fallbackNote: string | null;
}

const fmtPrice = (n: number) => (n >= 1 ? n.toPrecision(5) : n.toPrecision(4));
const fmtSol = (n: number, d = 4) => `${n.toFixed(d)} SOL`;
const usd = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`);

function intentOf(e: JournalEntry, d: JournalEntry["decision"]): string {
  const o = d.open;
  if ((d.action === "OPEN_POSITION" || d.action === "REBALANCE") && o) {
    const width = o.binsBelowActive + o.binsAboveActive + 1;
    const pct = (width * e.pool.binStep) / 100;
    const q = quoteOf(e.pool);
    const amount = o.amountSol > 0 ? (q.symbol === "SOL" ? fmtSol(o.amountSol, 2) : `${o.amountSol.toFixed(2)} ${q.symbol}`) : `${o.amountToken} ${e.wallet.tokenSymbol}`;
    return `${amount} as ${sideWords(o.side, q)}, ${width} bins wide (about ${pct.toFixed(1)}% of price)`;
  }
  if (d.action === "CLOSE_POSITION" || d.action === "CLAIM_FEES") {
    return d.positionAddress ? `band ${d.positionAddress.slice(0, 4)}…${d.positionAddress.slice(-4)}` : "every band";
  }
  return "";
}

function sawLines(e: JournalEntry): string[] {
  const p = e.pool;
  const lines: string[] = [];
  lines.push(`price ${fmtPrice(p.price)} ${p.priceLabel} · fee now ${p.dynamicFeePct.toFixed(2)}% · ${p.label} on Meteora`);
  if (e.analytics && (e.analytics.volume24hUsd !== null || e.analytics.tvlUsd !== null)) {
    const a = e.analytics;
    lines.push(`24h volume ${usd(a.volume24hUsd)} against ${usd(a.tvlUsd)} in the pool${a.feeToTvl24hPct !== null ? ` · fees ${a.feeToTvl24hPct.toFixed(2)}% of liquidity a day` : ""}${a.priceChange24hPct !== null ? ` · price ${a.priceChange24hPct >= 0 ? "+" : ""}${a.priceChange24hPct.toFixed(1)}% today` : ""}`);
  }
  if (e.screen) lines.push(`screener rank #${e.screen.rank} of ${e.screen.rankedPools} · score ${e.screen.score}`);
  if (e.positions.length === 0) {
    lines.push(`no band open · wallet ${fmtSol(e.wallet.sol, 3)} + ${e.wallet.token.toFixed(0)} ${e.wallet.tokenSymbol}`);
  } else {
    for (const pos of e.positions) {
      const state = pos.inRange ? "in range, earning" : `out of range by ${Math.abs(pos.binsFromRange)} bins (price ${pos.binsFromRange < 0 ? "below" : "above"} it), earning nothing`;
      lines.push(`band ${fmtPrice(pos.lowerPrice)}–${fmtPrice(pos.upperPrice)} · ${state} · worth ${fmtSol(pos.valueInSol)} · fees waiting ${fmtSol(feesInSol(pos, e))}`);
    }
  }
  return lines;
}

function txsOf(e: JournalEntry): DeskTx[] {
  return e.execution.txs.map((t) => ({
    label: t.label,
    text: t.signature ? "view transaction" : t.skipped ? "built, not simulated (no wallet key)" : t.ok ? `simulated ok${t.unitsConsumed ? `, ${Math.round(t.unitsConsumed / 1000)}k compute units` : ""}` : `failed: ${t.error}`,
    href: t.signature ? `https://solscan.io/tx/${t.signature}` : null,
  }));
}

function blockOf(e: JournalEntry): DeskBlock {
  const verdict = verdictOf(e);
  const d = e.decision;
  const intent = intentOf(e, d);
  const decision = d.action === "HOLD" ? "hold" : `${ACTION_WORDS[d.action]}${intent ? `: ${intent}` : ""}`;
  const proposedDiffers = e.proposal.action !== d.action || e.proposal.headline !== d.headline;
  const pIntent = intentOf(e, e.proposal);
  // Holds fold on state, not wording: same pool, same bands in the same in-range picture.
  const stateKey = e.positions.map((p) => `${p.address.slice(0, 6)}:${p.inRange ? "in" : "out"}`).join(",");
  return {
    key: verdict === "hold" ? `${e.pool.address}|hold|${stateKey}` : `${e.pool.address}|${d.action}|${verdict}|${d.reasoning}`,
    first: e,
    last: e,
    count: 1,
    pool: e.pool.label,
    verdict,
    action: d.action,
    saw: sawLines(e),
    proposed: proposedDiffers ? `${ACTION_WORDS[e.proposal.action]}${pIntent ? `: ${pIntent}` : ""}: “${e.proposal.headline}”` : null,
    guards:
      verdict === "blocked"
        ? `vetoed: ${e.violations.join("; ")}`
        : verdict === "override"
          ? `override: ${e.overrides.join("; ")}`
          : e.passed.length
            ? `passed ${e.passed.length} checks (${e.passed.join(", ")})`
            : null,
    decision,
    why: d.reasoning,
    headline: d.headline,
    txs: txsOf(e),
    fallbackNote:
      e.llm.source === "fallback"
        ? e.llm.note ?? "the model did not answer; he held"
        : e.llm.source === "policy"
          ? e.llm.note ?? "the desk policy decided: no model was asked"
          : null,
  };
}

/** Oldest first, like a terminal. Consecutive identical reads fold into one block with a count. */
export function deskBlocks(newestFirst: JournalEntry[], limit = 200): DeskBlock[] {
  const chrono = [...newestFirst].slice(0, limit).reverse();
  const out: DeskBlock[] = [];
  for (const e of chrono) {
    const b = blockOf(e);
    const prev = out[out.length - 1];
    if (prev && prev.key === b.key && b.verdict === "hold") {
      prev.count += 1;
      prev.last = e;
      prev.saw = b.saw;
      prev.why = b.why;
      prev.headline = b.headline;
    } else {
      out.push(b);
    }
  }
  return out;
}

/* ---------- the book (open bands) ---------- */

export interface BandCard {
  poolLabel: string;
  poolAddress: string;
  address: string;
  inRange: boolean;
  binsFromRange: number;
  lowerPrice: number;
  upperPrice: number;
  activePrice: number;
  priceLabel: string;
  lowerBinId: number;
  upperBinId: number;
  widthBins: number;
  widthPct: number;
  /** how far price can fall / rise before it leaves the band, percent; negative when already outside */
  roomDownPct: number;
  roomUpPct: number;
  putIn: number | null;
  marketMove: number | null;
  /** fees on the band: what is still unclaimed inside it plus every claim made from it in the journal window, SOL */
  fees: number;
  /** the part of fees already claimed to the wallet from this band, SOL */
  feesClaimed: number;
  worthNow: number;
  pacePerDay: number | null;
  openedAt: number | null;
  holds: string;
  side: string;
  strategy: string | null;
  openTx: string | null;
  /** the tokenized stock behind the pool, when the journal entry carries it */
  stock: StockTag | null;
}

/** A pool the desk made (the pair lane), as of its newest journal entry. */
export interface MadePair {
  poolLabel: string;
  poolAddress: string;
  /** the real Meteora pool address, once derived */
  lbPair: string | null;
  exists: boolean;
  ours: boolean;
  feeBps: number;
  binStep: number;
  routedShare: number;
  routedShareGross: number;
  competingDepthUsd: number;
  refVenue: string | null;
  refLiquidityUsd: number | null;
  rentSol: number;
  seatCapSol: number;
  bands: number;
  inRange: boolean;
  activePrice: number;
  priceLabel: string;
  headline: string;
  action: Action;
  ts: string;
  /** when the desk first wrote an entry for this pool */
  since: string;
  /** bands opened and closed in this pool over the journal */
  opens: number;
  closes: number;
  /** successful CLAIM_FEES decisions on this pool over the journal */
  claims: number;
  /** fees sitting in its bands, earned and not yet claimed, SOL */
  feesWaitingSol: number;
}

/**
 * Every pool the desk MADE, newest decision first. The lane seats many candidates it never makes
 * (the policy passes on most of them); a pool counts here only once the journal shows it created
 * (the pair block says it exists or is ours) or a band opened in it.
 */
export function madePairsOf(newestFirst: JournalEntry[]): MadePair[] {
  const latest = new Map<string, JournalEntry>();
  const since = new Map<string, string>();
  const claims = new Map<string, number>();
  const opens = new Map<string, number>();
  const closes = new Map<string, number>();
  const made = new Set<string>();
  for (const e of newestFirst) {
    if (!e.engine?.pair) continue;
    const a = e.pool.address;
    if (!latest.has(a)) latest.set(a, e);
    since.set(a, e.ts);
    if (e.engine.pair.exists || e.engine.pair.ours) made.add(a);
    if (e.execution.ok && e.execution.opened) {
      made.add(a);
      opens.set(a, (opens.get(a) ?? 0) + 1);
    }
    if (e.execution.ok && e.execution.closed) closes.set(a, (closes.get(a) ?? 0) + 1);
    if (e.decision.action === "CLAIM_FEES" && e.execution.ok && e.execution.txs.length > 0) claims.set(a, (claims.get(a) ?? 0) + 1);
  }
  return [...latest.values()].filter((e) => made.has(e.pool.address)).map((e) => {
    const p = e.engine!.pair!;
    return {
      poolLabel: e.pool.label,
      poolAddress: e.pool.address,
      lbPair: p.lbPair,
      exists: p.exists,
      ours: p.ours,
      feeBps: p.feeBps,
      binStep: p.binStep,
      routedShare: p.routedShare,
      routedShareGross: p.routedShareGross,
      competingDepthUsd: p.competingDepthUsd,
      refVenue: p.refVenue,
      refLiquidityUsd: p.refLiquidityUsd,
      rentSol: p.rentSol,
      seatCapSol: p.seatCapSol,
      bands: e.positions.length,
      inRange: e.positions.some((x) => x.inRange),
      activePrice: e.pool.price,
      priceLabel: e.pool.priceLabel,
      headline: e.headline || e.decision.headline,
      action: e.decision.action,
      ts: e.ts,
      since: since.get(e.pool.address) ?? e.ts,
      opens: opens.get(e.pool.address) ?? 0,
      closes: closes.get(e.pool.address) ?? 0,
      claims: claims.get(e.pool.address) ?? 0,
      feesWaitingSol: e.positions.reduce((t, x) => t + feesInSol(x, e), 0),
    };
  });
}

export interface Book {
  bands: BandCard[];
  asOf: number | null;
  lastExit: { ts: string; headline: string; action: Action } | null;
}

export function bookOf(newestFirst: JournalEntry[]): Book {
  // the newest cycle is the whole book at one moment; a pool whose band closed is absent from it
  const newest = bookCycle(newestFirst);
  const bands: BandCard[] = [];
  for (const e of newest?.entries ?? []) {
    for (const p of e.positions) {
      const opened = [...newestFirst].reverse().find((x) => x.execution.opened?.address === p.address);
      const openedAt = opened ? new Date(opened.ts).getTime() : p.lastUpdatedAt ? p.lastUpdatedAt * 1000 : null;
      // what a claim banked is what the band held unclaimed at that entry (the same reading the Record counts)
      const feesClaimed = newestFirst
        .filter((x) => x.decision.action === "CLAIM_FEES" && x.decision.positionAddress === p.address && (verdictOf(x) === "placed" || verdictOf(x) === "simulated"))
        .reduce((s, x) => s + x.positions.filter((q) => q.address === p.address).reduce((u, q) => u + feesInSol(q, x), 0), 0);
      const fees = feesInSol(p, e) + feesClaimed;
      const putIn = p.entryValueSol ?? opened?.execution.opened?.entryValueSol ?? null;
      const days = openedAt ? Math.max((new Date(e.ts).getTime() - openedAt) / 86400e3, 1 / 288) : null;
      const solY = isSolY(e);
      bands.push({
        poolLabel: e.pool.label,
        poolAddress: e.pool.address,
        address: p.address,
        inRange: p.inRange,
        binsFromRange: p.binsFromRange,
        lowerPrice: p.lowerPrice,
        upperPrice: p.upperPrice,
        activePrice: e.pool.price,
        priceLabel: e.pool.priceLabel,
        lowerBinId: p.lowerBinId,
        upperBinId: p.upperBinId,
        widthBins: p.widthBins,
        widthPct: (p.widthBins * e.pool.binStep) / 100,
        roomDownPct: (1 - p.lowerPrice / e.pool.price) * 100,
        roomUpPct: (p.upperPrice / e.pool.price - 1) * 100,
        putIn,
        // what price did to it: the band's value less the fees still inside it (claimed fees have already left), less what went in
        marketMove: putIn !== null ? p.valueInSol - feesInSol(p, e) - putIn : null,
        fees,
        feesClaimed,
        worthNow: p.valueInSol,
        pacePerDay: days ? fees / days : null,
        openedAt,
        holds: solY
          ? `${p.amountX.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${e.pool.tokenX.symbol} + ${p.amountY.toFixed(quoteOf(e.pool).symbol === "SOL" ? 4 : 2)} ${e.pool.tokenY.symbol}`
          : `${p.amountX.toFixed(quoteOf(e.pool).symbol === "SOL" ? 4 : 2)} ${e.pool.tokenX.symbol} + ${p.amountY.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${e.pool.tokenY.symbol}`,
        side: opened?.decision.open ? sideWords(opened.decision.open.side, quoteOf(e.pool)) : p.amountX > 0 && p.amountY > 0 ? SIDE_WORDS.BOTH : solY ? sideWords(p.amountY > 0 ? "SOL_ONLY" : "TOKEN_ONLY", quoteOf(e.pool)) : "",
        strategy: opened?.decision.open?.strategy ?? null,
        openTx: opened?.execution.txs.find((t) => t.signature)?.signature ?? null,
        stock: (e.pool as JournalEntry["pool"] & { stock?: StockTag | null }).stock ?? null,
      });
    }
  }
  const lastExit = newestFirst.find((e) => (e.decision.action === "CLOSE_POSITION" || e.decision.action === "REBALANCE") && e.execution.txs.length > 0 && e.execution.ok);
  return {
    bands,
    asOf: newestFirst[0] ? new Date(newestFirst[0].ts).getTime() : null,
    lastExit: lastExit ? { ts: lastExit.ts, headline: lastExit.headline, action: lastExit.decision.action } : null,
  };
}

/* ---------- the record (money over time) ---------- */

export interface FeePoint {
  t: number;
  amount: number;
  cumulative: number;
  href: string | null;
  simulated: boolean;
}

export interface DayRow {
  date: string;
  fees: number;
  open: number;
  close: number;
  moves: number;
  vetoed: number;
  overrides: number;
  holds: number;
  decisions: number;
}

export interface AgentRecord {
  startTs: number;
  startEquity: number;
  equityNow: number;
  /** the hedge desk's equity inside equityNow, SOL; null when the record has no history to read it from */
  hedge: number | null;
  /** true when start and now come from the desk's own equity history (the whole run), not the journal window */
  sinceStart: boolean;
  net: number;
  netPct: number;
  wallet: number;
  /** the stablecoin leg of the wallet (USDC), valued in SOL; null on a SOL-only desk */
  quote: { symbol: string; amount: number; inSol: number } | null;
  atWork: number;
  rent: number;
  tokens: { symbol: string; amount: number; inSol: number }[];
  feesRealized: number;
  feesUnclaimed: number;
  feePoints: FeePoint[];
  days: DayRow[];
  counts: { decisions: number; holds: number; simulated: number; placed: number; failed: number; vetoed: number; overrides: number; pools: number };
  anySimulated: boolean;
}

/**
 * The record. Two sources, the journal window always and the desk's equity history when the host has
 * it. The window (the newest 600 entries) gives the newest cycle's book, the fee claims with their
 * transactions, and the tally; but its oldest cycle is wherever 600 entries reach back, a day or so.
 * The history is one point a cycle since the run began, the desk's own marks, so with it "started
 * with" and "net" cover the whole run and the daily rows go back to day one.
 */
export function recordOf(newestFirst: JournalEntry[], history: EquityHistoryPoint[] | null = null): AgentRecord | null {
  if (newestFirst.length === 0) return null;
  const chrono = [...newestFirst].reverse();
  const cycles = cyclesOf(newestFirst);
  const newest = bookCycle(newestFirst) ?? cycles[cycles.length - 1];
  const latestByPool = new Map<string, JournalEntry>();
  for (const e of newestFirst) if (!latestByPool.has(e.pool.address)) latestByPool.set(e.pool.address, e);
  const latest = newestFirst[0];
  const agentId = latest.agent?.id ?? "mr-bands";
  const hist = (history ?? []).filter((p) => (p.agent ?? "mr-bands") === agentId && p.mode === latest.mode).sort((a, b) => a.t - b.t);
  const h0 = hist[0];
  const hN = hist[hist.length - 1];

  // Book split, from the newest cycle across pools: what he holds this moment, nothing stale
  const tokens = new Map<string, { symbol: string; amount: number; inSol: number }>();
  let atWork = 0;
  let rent = 0;
  let feesUnclaimed = 0;
  for (const e of newest.entries) {
    const base = isSolY(e) ? e.pool.tokenX.symbol : e.pool.tokenY.symbol;
    tokens.set(base, { symbol: base, amount: e.wallet.token, inSol: e.wallet.token * e.pool.tokenPriceInSol });
    for (const p of e.positions) {
      atWork += p.valueInSol;
      rent += POSITION_RENT_SOL;
      feesUnclaimed += feesInSol(p, e);
    }
  }
  const wallet = latest.wallet.sol;
  // The USDC leg, when the desk holds one: the same wallet in every entry of the cycle, so the newest
  // USDC-quoted entry has it. startEquity (equityOf) counts it; the book must too, or a USDC desk shows
  // a hole the size of its stablecoin balance.
  const quote = (() => {
    for (const e of newestFirst) {
      const w = e.wallet as JournalEntry["wallet"] & { quote?: number; quoteSymbol?: string; };
      const q = e.pool as JournalEntry["pool"] & { quotePriceInSol?: number };
      if (typeof w.quote === "number" && w.quoteSymbol && w.quoteSymbol !== "SOL") {
        return { symbol: w.quoteSymbol, amount: w.quote, inSol: w.quote * (typeof q.quotePriceInSol === "number" && q.quotePriceInSol > 0 ? q.quotePriceInSol : 0) };
      }
      if (e.cycle !== latest.cycle) break;
    }
    return null;
  })();
  // With history: start and now from the same arithmetic (the desk's marks, rent not counted, hedge
  // counted), so net is exact over the run. Without: the window's first complete cycle to its newest.
  const fromHistory = !!h0 && !!hN && hN.t >= newest.t - 3600e3;
  const complete = completeCycles(cycles);
  const first = chrono[0];
  const equityNow = fromHistory ? hN.equitySol : cycleEquity(newest);
  const startEquity = fromHistory ? h0.equitySol : complete.length ? cycleEquity(complete[0]) : equityOf(first);
  const startTs = fromHistory ? h0.t : complete.length ? complete[0].t : new Date(first.ts).getTime();

  // Fee points: each executed claim/close/move realises the fees waiting on its target bands
  const feePoints: FeePoint[] = [];
  let cumulative = 0;
  const counts = { decisions: 0, holds: 0, simulated: 0, placed: 0, failed: 0, vetoed: 0, overrides: 0, pools: latestByPool.size };
  const days = new Map<string, DayRow>();
  for (const e of chrono) {
    const v = verdictOf(e);
    counts.decisions += 1;
    if (v === "hold") counts.holds += 1;
    if (v === "simulated") counts.simulated += 1;
    if (v === "placed") counts.placed += 1;
    if (v === "failed") counts.failed += 1;
    if (v === "blocked") counts.vetoed += 1;
    if (v === "override") counts.overrides += 1;
    const date = e.ts.slice(0, 10);
    const row = days.get(date) ?? { date, fees: 0, open: NaN, close: NaN, moves: 0, vetoed: 0, overrides: 0, holds: 0, decisions: 0 };
    row.decisions += 1;
    if (v === "hold") row.holds += 1;
    if (v === "blocked") row.vetoed += 1;
    if (v === "override") row.overrides += 1;
    if (v === "placed" || v === "simulated") row.moves += 1;
    if ((v === "placed" || v === "simulated") && (e.decision.action === "CLAIM_FEES" || e.decision.action === "CLOSE_POSITION" || e.decision.action === "REBALANCE")) {
      const targets = e.decision.positionAddress ? e.positions.filter((p) => p.address === e.decision.positionAddress) : e.positions;
      const amount = targets.reduce((s, p) => s + feesInSol(p, e), 0);
      if (amount > 0) {
        cumulative += amount;
        row.fees += amount;
        feePoints.push({ t: new Date(e.ts).getTime(), amount, cumulative, href: e.execution.txs.find((t) => t.signature)?.signature ? `https://solscan.io/tx/${e.execution.txs.find((t) => t.signature)!.signature}` : null, simulated: v === "simulated" });
      }
    }
    days.set(date, row);
  }
  // The book open -> close per day: the day's first and last cycle (the window), or its first and last
  // point of the history, which reaches back to the run's first day and carries the claimed fees too.
  for (const c of complete) {
    const date = new Date(c.t).toISOString().slice(0, 10);
    const row = days.get(date);
    if (!row) continue;
    const eq = cycleEquity(c);
    if (!Number.isFinite(row.open)) row.open = eq;
    row.close = eq;
  }
  if (fromHistory) {
    const byDay = new Map<string, EquityHistoryPoint[]>();
    for (const p of hist) {
      const date = new Date(p.t).toISOString().slice(0, 10);
      byDay.set(date, [...(byDay.get(date) ?? []), p]);
    }
    let prevClaimed = h0.feesClaimedSol;
    for (const [date, pts] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const row = days.get(date) ?? { date, fees: 0, open: NaN, close: NaN, moves: 0, vetoed: 0, overrides: 0, holds: 0, decisions: 0 };
      row.open = pts[0].equitySol;
      row.close = pts[pts.length - 1].equitySol;
      row.fees = Math.max(0, pts[pts.length - 1].feesClaimedSol - prevClaimed);
      prevClaimed = pts[pts.length - 1].feesClaimedSol;
      days.set(date, row);
    }
    cumulative = Math.max(0, hN.feesClaimedSol - h0.feesClaimedSol);
  }
  for (const row of days.values()) {
    if (!Number.isFinite(row.open)) row.open = startEquity;
    if (!Number.isFinite(row.close)) row.close = row.open;
  }
  return {
    startTs,
    startEquity,
    equityNow,
    hedge: fromHistory ? hN.hedgeSol : null,
    sinceStart: fromHistory,
    net: equityNow - startEquity,
    netPct: startEquity > 0 ? ((equityNow - startEquity) / startEquity) * 100 : 0,
    wallet,
    quote,
    atWork,
    rent,
    tokens: [...tokens.values()].filter((t) => t.amount > 0),
    feesRealized: cumulative,
    feesUnclaimed,
    feePoints,
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    counts,
    anySimulated: counts.simulated > 0,
  };
}

/* ---------- status: one honest sentence ---------- */

export type Mode = "demo" | "paper" | "dry-run" | "live";

export interface Status {
  mode: Mode;
  lastTs: number | null;
  ageMs: number | null;
  /** the sentence that replaces the pills */
  sentence: string;
  short: string;
}

export function statusOf(newestFirst: JournalEntry[], now: number, demo: boolean): Status {
  const latest = newestFirst[0];
  const lastTs = latest ? new Date(latest.ts).getTime() : null;
  const ageMs = lastTs ? now - lastTs : null;
  // A paper run says so: the decisions and the marks are real, the wallet is not. A hold carries
  // execution mode "none", so look back through the newest entries for the run's kind rather than
  // flipping to "dry run" every time the newest decision is a hold.
  const paper = !demo && (latest?.mode === "paper" || newestFirst.slice(0, 40).some((e) => e.execution?.mode === "paper"));
  const mode: Mode = demo ? "demo" : paper ? "paper" : latest?.mode === "live" ? "live" : "dry-run";
  const ago = ageMs === null ? "" : ageMs < 90e3 ? "a minute ago" : ageMs < 3600e3 ? `${Math.round(ageMs / 60e3)} min ago` : ageMs < 86400e3 ? `${Math.round(ageMs / 3600e3)} h ago` : `${Math.round(ageMs / 86400e3)} d ago`;
  const span = latest && newestFirst.length ? (() => { const first = new Date(newestFirst[newestFirst.length - 1].ts).getTime(); const h = (lastTs! - first) / 3600e3; return h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`; })() : "";
  if (mode === "demo") {
    return { mode, lastTs, ageMs, short: "demo", sentence: `This is a scripted demo: ${span} of simulated decisions in ${latest?.pool.label ?? "one pool"}, written to show how Mr Bands decides. No wallet, no real money, nothing sent to Solana.` };
  }
  if (mode === "paper") {
    return { mode, lastTs, ageMs, short: "paper", sentence: `Paper trading: Mr Bands is working real pools at live prices with a pretend wallet. Bands, fees and hedges are marked against the market; nothing is sent to Solana. Last decision ${ago}.` };
  }
  if (mode === "dry-run") {
    return { mode, lastTs, ageMs, short: "dry run", sentence: `Rehearsal mode: Mr Bands is deciding on a real pool with a wallet that sends nothing. Every transaction is built and simulated, never broadcast. Last decision ${ago}.` };
  }
  return { mode, lastTs, ageMs, short: "live", sentence: `Live: Mr Bands is trading a small wallet of his own on Solana. Every action below links to its transaction. Last decision ${ago}.` };
}

/* ---------- actions: what he actually did ---------- */

export interface ActionRow {
  id: string;
  ts: string;
  action: Action;
  verdict: Verdict;
  poolLabel: string;
  poolAddress: string;
  /** his own words for it */
  headline: string;
  /** the move in numbers: what went in, what came back, what was banked */
  what: string;
  /** the move as one plain sentence: "Claimed 0.03 SOL of fees from MRVL/SOL." */
  sentence: string;
  /** the money the move realised, in SOL, when the journal carries it: fees banked, a close's result vs entry */
  resultSol: number | null;
  /** the guards forced it (a stop, a breaker) */
  forced: boolean;
  href: string | null;
}

const r4 = (n: number, d = 4) => Number(n.toFixed(d)).toString();

/**
 * Every executed move, newest first: opens, closes, moves and claims that were sent (or simulated),
 * including the ones the guards forced. Holds, vetoes and failures are not actions. The numbers come
 * from the decision (what he asked for) and the entry's own positions (what the band held when he
 * acted); nothing is read from the narrative.
 */
export function actionsOf(newestFirst: JournalEntry[], limit = 200): ActionRow[] {
  const out: ActionRow[] = [];
  for (const e of newestFirst) {
    if (out.length >= limit) break;
    const v = verdictOf(e);
    if (v !== "placed" && v !== "simulated" && v !== "override") continue;
    const a = e.decision.action;
    if (a === "HOLD") continue;
    const q = quoteOf(e.pool);
    const sym = isSolY(e) ? e.pool.tokenX.symbol : e.pool.tokenY.symbol;
    const targets = e.decision.positionAddress ? e.positions.filter((p) => p.address === e.decision.positionAddress) : e.positions;
    const fees = targets.reduce((s, p) => s + feesInSol(p, e), 0);
    const held = targets.reduce((s, p) => s + p.valueInSol, 0);
    const entry = targets.reduce((s, p) => s + (p.entryValueSol ?? NaN), 0);
    const openWords = (o: NonNullable<Decision["open"]>) => {
      const bins = o.binsBelowActive + o.binsAboveActive + (o.side === "BOTH" ? 1 : 0);
      const legs = [o.amountSol > 0 ? `${r4(o.amountSol, q.symbol === "SOL" ? 4 : 2)} ${q.symbol}` : null, o.amountToken > 0 ? `${r4(o.amountToken)} ${sym}` : null].filter(Boolean).join(" + ");
      return `${legs} across ${bins} bins, ${sideWords(o.side, q)}`;
    };
    let what = "";
    let resultSol: number | null = null;
    if (a === "OPEN_POSITION" && e.decision.open) what = openWords(e.decision.open);
    else if (a === "CLAIM_FEES") {
      what = `${r4(fees)} SOL of fees to the wallet`;
      resultSol = fees;
    } else if (a === "CLOSE_POSITION") {
      const vs = Number.isFinite(entry) && entry > 0 ? held - entry : null;
      what = `${r4(held)} SOL back${vs !== null ? `, ${vs >= 0 ? "+" : "−"}${r4(Math.abs(vs))} SOL vs entry` : ""}${fees > 0.00005 ? `, ${r4(fees)} SOL of fees with it` : ""}`;
      resultSol = vs;
    } else if (a === "REBALANCE") {
      const vs = Number.isFinite(entry) && entry > 0 ? held - entry : null;
      what = `${r4(held)} SOL out${vs !== null ? ` (${vs >= 0 ? "+" : "−"}${r4(Math.abs(vs))} vs entry)` : ""}${e.decision.open ? `, back in as ${openWords(e.decision.open)}` : ""}`;
      resultSol = vs;
    }
    const pool = e.pool.label;
    const sentence =
      a === "OPEN_POSITION"
        ? `Opened a band in ${pool}${what ? ` with ${what}` : ""}.`
        : a === "CLAIM_FEES"
          ? `Claimed ${r4(fees)} SOL of fees from ${pool}.`
          : a === "CLOSE_POSITION"
            ? `${v === "override" ? "The guards closed his band" : "Closed the band"} in ${pool}: ${what}.`
            : `Moved the band in ${pool}: ${what}.`;
    const sig = e.execution.txs.find((t) => t.signature)?.signature;
    out.push({
      id: e.id,
      ts: e.ts,
      action: a,
      verdict: v,
      poolLabel: e.pool.label,
      poolAddress: e.pool.address,
      headline: e.headline || e.decision.headline,
      what,
      sentence,
      resultSol,
      forced: v === "override",
      href: sig ? `https://solscan.io/tx/${sig}` : null,
    });
  }
  return out;
}

/* ---------- the flow: what traded in his pools in the last hour ---------- */

export interface PoolFlow {
  poolAddress: string;
  poolLabel: string;
  flow: FlowContext;
  /** one quote unit in SOL, so pools quoted in USDC add up with the SOL ones */
  quotePriceInSol: number;
}

export interface FlowTotals {
  pools: number;
  swaps60m: number;
  volume60mSol: number;
  fees60mSol: number;
  ours60mSol: number;
  swaps15m: number;
  fees15mSol: number;
  /** the newest reading among the pools, epoch ms */
  asOf: number;
}

/** The flow the desk journaled for each pool of the newest cycle; a pool without a fresh reading is absent. */
export function flowOf(newestFirst: JournalEntry[]): Map<string, PoolFlow> {
  const out = new Map<string, PoolFlow>();
  const cycle = bookCycle(newestFirst);
  for (const e of cycle?.entries ?? []) {
    const f = e.screen?.flow;
    if (!f) continue;
    const q = e.pool as JournalEntry["pool"] & { quotePriceInSol?: number };
    out.set(e.pool.address, { poolAddress: e.pool.address, poolLabel: e.pool.label, flow: f, quotePriceInSol: typeof q.quotePriceInSol === "number" && q.quotePriceInSol > 0 ? q.quotePriceInSol : 1 });
  }
  return out;
}

/** PURE. The pools' flow added up in SOL; null when no pool has a reading. */
export function flowTotalsOf(flows: Map<string, PoolFlow>): FlowTotals | null {
  if (!flows.size) return null;
  const t: FlowTotals = { pools: 0, swaps60m: 0, volume60mSol: 0, fees60mSol: 0, ours60mSol: 0, swaps15m: 0, fees15mSol: 0, asOf: 0 };
  for (const { flow: f, quotePriceInSol: px } of flows.values()) {
    t.pools += 1;
    t.swaps60m += f.swaps60m;
    t.volume60mSol += f.volume60mQuote * px;
    t.fees60mSol += f.fees60mQuote * px;
    t.ours60mSol += f.ours60mQuote * px;
    t.swaps15m += f.swaps15m;
    t.fees15mSol += f.fees15mQuote * px;
    t.asOf = Math.max(t.asOf, f.asOf);
  }
  return t;
}
