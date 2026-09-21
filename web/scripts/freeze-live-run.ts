/**
 * Freeze a finished LIVE run as one static file the site can read for good: web/public/live-run.json.
 *
 * The live feed (src/publish/live.ts) is a window that the next live desk overwrites, and the site
 * discards it once it is older than the paper snapshot; the run of 17-19 September 2026 (wallet 9q3V…,
 * 205 moves with their transactions on Meteora) was therefore invisible on the page. A record is not a
 * feed: this script reads the run's whole journal (decisions.jsonl) and its equity history
 * (equity.jsonl) from DATA_DIR and writes the executed moves, trimmed to what the page's model needs
 * (web/src/model.ts recordOf and actionsOf), plus every equity point, rounded. Holds, vetoes and
 * failures are counted in the header and not carried: the file must stay small on a phone.
 *
 * Lives in web/scripts, like the other tools of the site, because it reads the site's model: the desk's
 * tsconfig does not compile web/src. From the repository root:
 *   DATA_DIR=data-mainnet npx tsx web/scripts/freeze-live-run.ts
 */
import fs from "node:fs";
import path from "node:path";
import { verdictOf } from "../src/model";
import type { EquityHistoryPoint, JournalEntry } from "../src/types";

const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR ?? "data");
const out = path.resolve(process.cwd(), process.env.OUT ?? "web/public/live-run.json");

function readJsonl<T>(file: string): T[] {
  const rows: T[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // a torn write: skip the line rather than lose the run
    }
  }
  return rows;
}

/** Numbers to eight significant figures: a meme pool's price (1.4e-5 SOL) keeps its digits, a full double's seventeen go. */
const r8 = (n: number) => Number(n.toPrecision(8));
const roundDeep = <T>(v: T): T => {
  if (typeof v === "number") return (Number.isFinite(v) ? r8(v) : v) as T;
  if (Array.isArray(v)) return v.map(roundDeep) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, roundDeep(x)])) as T;
  return v;
};

/** One executed move, kept to the fields the page reads (types.ts JournalEntry, model.ts actionsOf/recordOf). */
function trim(e: JournalEntry): JournalEntry {
  // the pool without its bin ladder, its mints or its venue tag: the ledger names it, the model prices it.
  // A SOL-quoted pool's quote fields are what the model assumes when they are absent (model.ts quoteOf), so they go too.
  const { bins: _bins, quoteMint: _mint, venue: _venue, stock: _stock, ...full } = e.pool;
  const { quoteSymbol, quoteSide, quotePriceInSol, tokenPriceInQuote, ...bare } = full;
  const solQuoted = (quoteSymbol ?? "SOL") === "SOL" && (quoteSide ?? e.pool.solSide ?? "Y") === (e.pool.solSide ?? "Y") && (quotePriceInSol ?? 1) === 1;
  const pool: JournalEntry["pool"] = solQuoted ? { ...bare, bins: [] } : { ...bare, quoteSymbol, quoteSide, quotePriceInSol, tokenPriceInQuote, bins: [] };
  const w = e.wallet as JournalEntry["wallet"] & { quote?: number; quoteSymbol?: string };
  const { quote: _q, quoteSymbol: _qs, ...walletBare } = w;
  const wallet: JournalEntry["wallet"] = !w.quoteSymbol || w.quoteSymbol === "SOL" ? walletBare : w;
  const d = e.decision;
  const decision: JournalEntry["decision"] = { action: d.action, open: d.open, positionAddress: d.positionAddress, reasoning: "", confidence: d.confidence, headline: d.headline, ...(d.liquidate ? { liquidate: true } : {}), ...(d.exitAsk ? { exitAsk: true } : {}) };
  // the proposal is not read by the ledger or the record: its action and words stay, for the honesty of the file
  const proposal: JournalEntry["proposal"] = { action: e.proposal.action, open: null, positionAddress: null, reasoning: "", confidence: e.proposal.confidence, headline: e.proposal.headline };
  const positions: JournalEntry["positions"] = e.positions.map((q) => ({
    address: q.address, lowerBinId: q.lowerBinId, upperBinId: q.upperBinId, lowerPrice: q.lowerPrice, upperPrice: q.upperPrice, widthBins: q.widthBins, inRange: q.inRange, binsFromRange: q.binsFromRange,
    amountX: q.amountX, amountY: q.amountY, feeX: q.feeX, feeY: q.feeY, valueInSol: q.valueInSol, solInPosition: q.solInPosition, lastUpdatedAt: q.lastUpdatedAt,
    ...(typeof q.entryValueSol === "number" ? { entryValueSol: q.entryValueSol } : {}),
  }));
  const x = e.execution;
  const execution: JournalEntry["execution"] = {
    mode: x.mode,
    ok: x.ok,
    txs: x.txs.map((t) => ({ label: t.label, ok: t.ok, ...(t.signature ? { signature: t.signature } : {}), ...(t.error ? { error: t.error } : {}) })),
    ...(x.opened ? { opened: x.opened } : {}),
    ...(x.closed ? { closed: x.closed } : {}),
    notes: [],
  };
  return roundDeep({
    id: e.id,
    ts: e.ts,
    cycle: e.cycle,
    mode: e.mode,
    agent: e.agent,
    pool,
    wallet,
    positions,
    analytics: null,
    llm: { source: e.llm.source, model: e.llm.model },
    proposal,
    decision,
    allowed: e.allowed,
    violations: e.violations ?? [],
    overrides: e.overrides ?? [],
    passed: [],
    emergency: e.emergency,
    execution,
    headline: e.headline,
    screen: null,
  });
}

const all = readJsonl<JournalEntry>(path.join(dataDir, "decisions.jsonl")).sort((a, b) => a.ts.localeCompare(b.ts));
if (all.length === 0) {
  console.error(`freeze-live-run: no entries in ${dataDir}/decisions.jsonl`);
  process.exit(2);
}
const modes = new Set(all.map((e) => e.mode));
const wallets = new Set(all.map((e) => e.wallet.address));
if (modes.size !== 1 || !modes.has("live") || wallets.size !== 1) {
  console.error(`freeze-live-run: expected one live run on one wallet, found modes ${[...modes].join(",")} and wallets ${[...wallets].join(",")}`);
  process.exit(2);
}
// the moves, exactly as the page's ledger picks them (model.ts actionsOf): sent on-chain or forced by the guards, never a hold
const isMove = (e: JournalEntry) => e.decision.action !== "HOLD" && (verdictOf(e) === "placed" || verdictOf(e) === "override");
const moves = all.filter(isMove);
const holds = all.filter((e) => verdictOf(e) === "hold").length;
const failed = all.filter((e) => verdictOf(e) === "failed").length;
// The equity history, one mark a cycle. The page's record reads its first and last point, and each
// day's first and last (model.ts recordOf); the rest are thinned to one in three so the file stays
// small, and the run's best mark is measured here from every point before the thinning.
const allPoints = readJsonl<EquityHistoryPoint>(path.join(dataDir, "equity.jsonl")).sort((a, b) => a.t - b.t);
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const points = allPoints.filter((p, i) => i === 0 || i === allPoints.length - 1 || i % 3 === 0 || day(p.t) !== day(allPoints[i - 1].t) || day(p.t) !== day(allPoints[i + 1].t)).map(roundDeep);
const peakEquitySol = r8(Math.max(...allPoints.map((p) => p.equitySol)));
const lowEquitySol = r8(Math.min(...allPoints.map((p) => p.equitySol)));

const file = {
  frozenAt: new Date().toISOString(),
  source: `${path.basename(dataDir)}: decisions.jsonl and equity.jsonl`,
  mode: "live" as const,
  agent: all[0].agent ?? { id: "mr-bands", name: "Mr Bands" },
  wallet: all[0].wallet.address,
  firstTs: all[0].ts,
  lastTs: all[all.length - 1].ts,
  decisions: all.length,
  holds,
  failed,
  /** the book's best and worst marks over the run, from every equity point */
  peakEquitySol,
  lowEquitySol,
  /** newest first, as the journal's window and the live feed */
  entries: [...moves].reverse().map(trim),
  points,
};
fs.mkdirSync(path.dirname(out), { recursive: true });
const body = JSON.stringify(file);
fs.writeFileSync(out, body);
const txs = moves.reduce((n, e) => n + e.execution.txs.filter((t) => t.signature).length, 0);
console.log(`freeze-live-run: ${all.length} decisions from ${dataDir} (${file.firstTs} to ${file.lastTs}), ${moves.length} moves with ${txs} transactions, ${holds} holds, ${failed} failed, ${points.length} of ${allPoints.length} equity points (peak ${peakEquitySol}, low ${lowEquitySol}) -> ${path.relative(process.cwd(), out)} (${(body.length / 1024).toFixed(0)} KB)`);
