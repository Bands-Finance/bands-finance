/**
 * One place that turns journal entries into what the page says.
 * Every component reads from here so the words and the numbers cannot disagree.
 */
import { equityOf, feesInSol, POSITION_RENT_SOL } from "./derive";
import type { Action, JournalEntry, Position } from "./types";

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
export const GLOSS = {
  band: "A band is a slice of price Mr Bands puts SOL into. Every trade that crosses it pays him a fee.",
  inRange: "In range means the current price is inside the band, so it is earning right now.",
  bin: "Pools on Meteora cut price into small steps called bins. A band is a run of bins.",
  dryRun: "Dry run: he decides exactly as he would live, the wallet builds and simulates the transaction, and nothing is broadcast.",
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
    const amount = o.amountSol > 0 ? fmtSol(o.amountSol, 2) : `${o.amountToken} ${e.wallet.tokenSymbol}`;
    return `${amount} as ${SIDE_WORDS[o.side] ?? o.side}, ${width} bins wide (about ${pct.toFixed(1)}% of price)`;
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
    proposed: proposedDiffers ? `${ACTION_WORDS[e.proposal.action]}${pIntent ? `: ${pIntent}` : ""} — “${e.proposal.headline}”` : null,
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
    fallbackNote: e.llm.source === "fallback" ? e.llm.note ?? "the model did not answer; he held" : null,
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
  fees: number;
  worthNow: number;
  pacePerDay: number | null;
  openedAt: number | null;
  holds: string;
  side: string;
  strategy: string | null;
  openTx: string | null;
}

export interface Book {
  bands: BandCard[];
  asOf: number | null;
  lastExit: { ts: string; headline: string; action: Action } | null;
}

export function bookOf(newestFirst: JournalEntry[]): Book {
  const latestByPool = new Map<string, JournalEntry>();
  for (const e of newestFirst) if (!latestByPool.has(e.pool.address)) latestByPool.set(e.pool.address, e);
  const bands: BandCard[] = [];
  for (const e of latestByPool.values()) {
    for (const p of e.positions) {
      const opened = [...newestFirst].reverse().find((x) => x.execution.opened?.address === p.address);
      const openedAt = opened ? new Date(opened.ts).getTime() : p.lastUpdatedAt ? p.lastUpdatedAt * 1000 : null;
      const fees = feesInSol(p, e);
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
        marketMove: putIn !== null ? p.valueInSol - fees - putIn : null,
        fees,
        worthNow: p.valueInSol,
        pacePerDay: days ? fees / days : null,
        openedAt,
        holds: solY ? `${p.amountX.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${e.pool.tokenX.symbol} + ${p.amountY.toFixed(4)} SOL` : `${p.amountX.toFixed(4)} SOL + ${p.amountY.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${e.pool.tokenY.symbol}`,
        side: opened?.decision.open ? SIDE_WORDS[opened.decision.open.side] ?? opened.decision.open.side : p.amountX > 0 && p.amountY > 0 ? SIDE_WORDS.BOTH : solY ? (p.amountY > 0 ? SIDE_WORDS.SOL_ONLY : SIDE_WORDS.TOKEN_ONLY) : "",
        strategy: opened?.decision.open?.strategy ?? null,
        openTx: opened?.execution.txs.find((t) => t.signature)?.signature ?? null,
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
  net: number;
  netPct: number;
  wallet: number;
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

export function recordOf(newestFirst: JournalEntry[]): AgentRecord | null {
  if (newestFirst.length === 0) return null;
  const chrono = [...newestFirst].reverse();
  const latestByPool = new Map<string, JournalEntry>();
  for (const e of newestFirst) if (!latestByPool.has(e.pool.address)) latestByPool.set(e.pool.address, e);
  const latest = newestFirst[0];

  // Book split, from the newest cycle across pools
  const tokens = new Map<string, { symbol: string; amount: number; inSol: number }>();
  let atWork = 0;
  let rent = 0;
  let feesUnclaimed = 0;
  for (const e of latestByPool.values()) {
    const base = isSolY(e) ? e.pool.tokenX.symbol : e.pool.tokenY.symbol;
    tokens.set(base, { symbol: base, amount: e.wallet.token, inSol: e.wallet.token * e.pool.tokenPriceInSol });
    for (const p of e.positions) {
      atWork += p.valueInSol;
      rent += POSITION_RENT_SOL;
      feesUnclaimed += feesInSol(p, e);
    }
  }
  const wallet = latest.wallet.sol;
  const equityNow = wallet + [...tokens.values()].reduce((s, t) => s + t.inSol, 0) + atWork + rent;
  const first = chrono[0];
  const startEquity = equityOf(first);

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
    const row = days.get(date) ?? { date, fees: 0, open: equityOf(e), close: equityOf(e), moves: 0, vetoed: 0, overrides: 0, holds: 0, decisions: 0 };
    row.close = equityOf(e);
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
  return {
    startTs: new Date(first.ts).getTime(),
    startEquity,
    equityNow,
    net: equityNow - startEquity,
    netPct: startEquity > 0 ? ((equityNow - startEquity) / startEquity) * 100 : 0,
    wallet,
    atWork,
    rent,
    tokens: [...tokens.values()].filter((t) => t.amount > 0),
    feesRealized: cumulative,
    feesUnclaimed,
    feePoints,
    days: [...days.values()],
    counts,
    anySimulated: counts.simulated > 0,
  };
}

/* ---------- status: one honest sentence ---------- */

export type Mode = "demo" | "dry-run" | "live";

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
  const mode: Mode = demo ? "demo" : latest?.mode === "live" ? "live" : "dry-run";
  const ago = ageMs === null ? "" : ageMs < 90e3 ? "a minute ago" : ageMs < 3600e3 ? `${Math.round(ageMs / 60e3)} min ago` : ageMs < 86400e3 ? `${Math.round(ageMs / 3600e3)} h ago` : `${Math.round(ageMs / 86400e3)} d ago`;
  const span = latest && newestFirst.length ? (() => { const first = new Date(newestFirst[newestFirst.length - 1].ts).getTime(); const h = (lastTs! - first) / 3600e3; return h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`; })() : "";
  if (mode === "demo") {
    return { mode, lastTs, ageMs, short: "demo", sentence: `This is a scripted demo: ${span} of simulated decisions in ${latest?.pool.label ?? "one pool"}, written to show how Mr Bands decides. No wallet, no real money, nothing sent to Solana.` };
  }
  if (mode === "dry-run") {
    return { mode, lastTs, ageMs, short: "dry run", sentence: `Rehearsal mode: Mr Bands is deciding on a real pool with a wallet that sends nothing. Every transaction is built and simulated, never broadcast. Last decision ${ago}.` };
  }
  return { mode, lastTs, ageMs, short: "live", sentence: `Live: Mr Bands is trading a small wallet of his own on Solana. Every action below links to its transaction. Last decision ${ago}.` };
}
