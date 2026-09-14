/**
 * Scheduler. Each iteration: refresh the screen if stale -> pick the pools to work ->
 * for each pool: observe -> engine directive or Mr Bands proposes -> guards decide -> execute -> journal
 * -> then the breakers mark the book, the skim runs, the heartbeat lands.
 *   npm run once   one iteration
 *   npm start      loop every CYCLE_INTERVAL_SEC
 *
 * The engine (src/engine) runs before the LLM (FLATTEN / STOP / COLLECT directives) and after it
 * (ledger rows, stop roll, bench, circuit and portfolio marks, skim, watchdog). One process holds
 * the key: boot refuses when another live process holds the same wallet.
 *
 * Paper mode (PAPER_SOL > 0 under DRY_RUN, src/paper): the wallet and the bands are virtual. Bands
 * are marked against the live pool every cycle in place of the venue's position read, balances come
 * from the book, and execute() applies the verdict to the book. Screen, hot watch, basis, directives,
 * guards, engine state and journal run unchanged.
 *
 * Venues (src/venues): every pool is read, marked and traded through its venue adapter (Meteora
 * DLMM, Raydium CLMM). TRADABLE_VENUES says which venues the picker may seat; LIVE_VENUES which ones
 * the executor may broadcast on. BOOK=stocks seats tokenized-stock pools first.
 *
 * The stock book: a stock pool's band is a straddle (src/agent/policy.ts) whose token half the hedge
 * desk (src/engine/hedgeDesk.ts) carries short on Backpack's perp after every execution; the perp
 * mids of the symbols in play are refreshed once per cycle, and an engine close in a stock pool
 * liquidates the token back to the quote. In paper mode the hedge is virtual (src/paper/hedge.ts).
 */
import { exec } from "node:child_process";
import { Connection, PublicKey } from "@solana/web3.js";
import { config, riskLimits } from "./config";
import { decide, engineDecideResult, proposalDecideResult } from "./agent/decide";
import type { Decision } from "./agent/schema";
import { policyEnv } from "./agent/policy";
import { OPEN_COST_ESTIMATE_SOL } from "./tools/dlmm";
import { approvedProposals, markExecuted, Proposal } from "./platform/proposals";
import type { EngineObservation, Observation, ScreenContext } from "./agent/observation";
import { evaluate, EngineGuardContext } from "./risk/guards";
import { describeLimits } from "./risk/limits";
import { killSwitchActive, loadState, saveState, RiskState, todayUtc } from "./risk/state";
import { execute, executeSkim, ExecutionResult, toOpenPlan } from "./executor";
import { appendJournal, JournalEngine, JournalEntry, readRecent, toJournalPool } from "./journal";
import { loadScreen, runScreen, tradableVenue } from "./screener";
import { loadWatchlist, watchlistRefusal } from "./screener/watchlist";
import type { ScreenResult } from "./screener/types";
import { KNOWN_TOKENS, PoolSnapshot, PositionSnapshot, quoteOf, QuotePriceUnknownError, setSolPriceUsd, UnsupportedQuoteError } from "./tools/dlmm";
import { bookEnv, isTradableVenue, liveVenues, loadVenuePool, poolsWithPositions, stockBookPools, stockMinLiquidityUsd, tradableVenues, type Venue, type VenueId, type VenuePool } from "./venues";
import { fetchPoolAnalytics } from "./tools/lpagent";
import { Wallet } from "./tools/wallet";
import { startServer } from "./server";
import { basisForPool, basisVerdict, refreshBasis, sessionClock, sessionWidthMultiplier } from "./basis";
import { hotPicks, HotRow, loadHot, runHotTick, startHotWatch } from "./hot";
import {
  circuitLossSol,
  circuitVerdict,
  EngineState,
  engineView,
  loadEngineState,
  markedDrawdownSol,
  portfolioVerdict,
  recordStop,
  RegimeView,
  regimeView,
  saveEngineState,
} from "./engine/breakers";
import { skimPlan, trackFeesPending } from "./engine/collect";
import { engineDirective } from "./engine/directives";
import { forgetBand, knifeReason, outOfRangeSec, recordPrice, rollStop, trackOutOfRange } from "./engine/exit";
import { collectsOnDay, dayOf, readLedgerRows, realizedOnDaySol, workingSol } from "./engine/ledger";
import { acquireLock, heartbeat, releaseLock, startWatchdog } from "./engine/watchdog";
import { assertPaperEnv, emptyBook, loadPaperBook, markPool, paperEnabled, paperEnv, paperHedgeEquityUsd, paperPoolTokenInventory, paperTokenBalance, poolsWithBands, savePaperBook, type PaperBook, type PaperEnv } from "./paper";
import { backpack, tickerOfXstock } from "./tools/backpack";
import { baseInventoryOf } from "./engine/hedge";
import { runHedgeDesk } from "./engine/hedgeDesk";
import type { JournalHedge } from "./journal";

interface App {
  connection: Connection;
  wallet: Wallet;
  cycle: number;
  /** venue + pool handle per address (src/venues) */
  pools: Map<string, { venue: Venue; pool: VenuePool }>;
  screen: ScreenResult | null;
  screenAt: number;
  /** breaker state, loaded once per iteration and saved after every change */
  engine: EngineState;
  /** the board regime for this iteration */
  regime: RegimeView;
  /** the paper book when PAPER_SOL > 0 (src/paper); null otherwise */
  paper: PaperBook | null;
  paperEnv: PaperEnv;
  /** perp symbol -> the mid refreshed this cycle (the hedge desk's price and the paper hedge's mark) */
  perpMarks: Map<string, { mid: number; at: number }>;
  /** perp symbol -> contracts the pools decided so far this cycle target (live: they share one Backpack position) */
  hedgedThisCycle: Map<string, number>;
  /** base mints whose wallet balance has been attributed to a pool's hedge this cycle */
  mintAttributed: Set<string>;
}

interface Observed {
  address: string;
  venue: Venue;
  pool: VenuePool;
  snapshot: PoolSnapshot;
  /** the venue's raw positions, index-aligned with positions */
  raw: unknown[];
  positions: PositionSnapshot[];
}

const cfg = config.engine;

/** An approved proposal as the decision Mr Bands would otherwise make. Rationale is published verbatim. */
function proposalDecision(p: Proposal): Decision {
  if (p.kind === "OPEN_BAND") {
    const { pool: _pool, ...open } = p.params as Extract<Proposal["params"], { side: string }>;
    return {
      action: "OPEN_POSITION",
      open,
      positionAddress: null,
      reasoning: p.rationale,
      confidence: 0.5,
      headline: `Proposal from ${p.proposerName}: open a ${open.side.replace("_", " ").toLowerCase()} band.`,
    };
  }
  const params = p.params as Extract<Proposal["params"], { position: string }>;
  return {
    action: "CLOSE_POSITION",
    open: null,
    positionAddress: params.position,
    reasoning: p.rationale,
    confidence: 0.5,
    headline: `Proposal from ${p.proposerName}: close band ${params.position.slice(0, 6)}.`,
  };
}

function banner(app: App): void {
  const mode = app.paper ? `PAPER: virtual ${app.paper.startSol} SOL wallet${app.paper.startUsdc > 0 ? ` + ${app.paper.startUsdc} USDC` : ""}, live prices, nothing broadcast` : config.dryRun ? "DRY RUN (nothing is broadcast)" : "LIVE (real transactions)";
  console.log("=".repeat(72));
  console.log(`${config.agentName}  |  ${mode}`);
  console.log(`pools     ${config.pinnedPools.length ? `pinned ${config.pinnedPools.join(", ")} + ` : ""}screener top picks, max ${config.maxActivePools} at once`);
  console.log(`venues    tradable ${tradableVenues().join(", ") || "none"} | live ${liveVenues().filter((v) => isTradableVenue(v)).join(", ") || "none"} (a tradable venue off LIVE_VENUES trades in paper and dry-run only) | book ${bookEnv()}${bookEnv() === "stocks" ? ` (tokenized stocks first, liquidity >= $${stockMinLiquidityUsd().toLocaleString("en-US")})` : ""}`);
  console.log(`quotes    SOL and USDC (a USDC pool is valued at the screen's SOL price: ${app.screen?.solPriceUsd ? `$${app.screen.solPriceUsd.toFixed(2)}` : "none yet, USDC pools skipped until a screen lands"})`);
  console.log(`wallet    ${app.wallet.publicKey.toBase58()}${app.wallet.ephemeral ? "  (ephemeral, no key configured)" : ""}${cfg.expectedWallet ? `  expected ${cfg.expectedWallet}` : ""}`);
  if (app.paper) console.log(`paper     book ${app.paper.startedAt}: ${app.paper.wallet.sol.toFixed(4)} SOL, ${app.paper.wallet.usdc.toFixed(2)} USDC, ${app.paper.bands.length} band(s) open, ${app.paper.closed.length} closed; slippage ${app.paperEnv.slippagePct}% per open/close; report: DATA_DIR=${config.dataDir} npm run paper:report`);
  const hedgeGate = backpack().canTrade();
  console.log(`stocks    straddles (BOTH, half quote half token, STOCK_COVER_PCT=${policyEnv().stockCoverPct}% each side x session width); token half hedged short on Backpack: ${app.paper ? "PAPER (virtual fills at the perp mid, funding accrued)" : hedgeGate.ok ? "LIVE post-only orders" : `plan only (${hedgeGate.reason})`}; swaps via Jupiter (${app.paper ? "paper fills" : config.dryRun ? "built + simulated" : "broadcast"})`);
  console.log(`model     ${config.model}`);
  console.log(`interval  ${config.cycleIntervalSec}s cycles, screen every ${config.screen.intervalSec}s`);
  console.log("limits");
  console.log(describeLimits(riskLimits).split("\n").map((l) => "  " + l).join("\n"));
  console.log("engine");
  console.log(`  - per-band stop rolled in [${(riskLimits.stopLossPct * 0.8).toFixed(2)}, ${riskLimits.stopLossPct}]%; anti-churn ${cfg.outOfRangeSec}s out of range; knife ${cfg.knifePct}% / 30 min`);
  console.log(`  - circuit breaker floor ${cfg.circuitFloorSol} SOL (or 15% of working), halts 4h then 6h; portfolio breaker floor ${cfg.portfolioFloorSol} SOL (or 15%), 3 marks -> flatten + 12h stand-down`);
  console.log(`  - bench: stops in 6h -> size x0.5, x0.25, benched at 3; regime: board median 24h < -5% -> x0.5, < -15% -> opens off`);
  console.log(`  - collect at >= ${cfg.collectMinSol} SOL or ${cfg.collectFloorSol}+ SOL pending 2h, max ${cfg.collectMaxPerDay}/day`);
  console.log(`  - skim: ${cfg.skim && cfg.treasuryAddress ? `on -> ${cfg.treasuryAddress} (75% of fee gain above float ${cfg.floatTargetSol} SOL + gas reserve)` : "off"}`);
  console.log("=".repeat(72));
}

let lastDeployAt = 0;
const DEPLOY_MIN_MINUTES = Number(process.env.AUTO_DEPLOY_MIN_MINUTES ?? 30);

function deploySnapshot(): void {
  const sinceMin = (Date.now() - lastDeployAt) / 60000;
  if (lastDeployAt > 0 && sinceMin < DEPLOY_MIN_MINUTES) {
    console.log(`[deploy] skipped: ${sinceMin.toFixed(0)} min since the last push, minimum ${DEPLOY_MIN_MINUTES}`);
    return;
  }
  lastDeployAt = Date.now();
  console.log("[deploy] pushing snapshot to Vercel");
  exec("npm run web:deploy", { cwd: process.cwd() }, (err, stdout, stderr) => {
    if (err) console.error(`[deploy] failed: ${err.message}\n${stderr.slice(-400)}`);
    else console.log(`[deploy] ${stdout.trim().split("\n").slice(-2).join(" | ")}`);
  });
}

/** Symbols come from the screener.s enrichment; the on-chain snapshot only knows mints. */
function registerTokens(screen: ScreenResult | null): void {
  for (const p of screen?.pools ?? []) {
    if (p.baseSymbol && !p.baseSymbol.includes("…")) KNOWN_TOKENS[p.baseMint] = p.baseSymbol;
  }
}

/** The SOL price every USDC-quoted snapshot converts at: the screen's. Null keeps USDC pools untradable. */
const solPriceOf = (app: App): number | null => (app.screen?.solPriceUsd && app.screen.solPriceUsd > 0 ? app.screen.solPriceUsd : null);

async function ensureScreen(app: App): Promise<void> {
  registerTokens(app.screen);
  setSolPriceUsd(solPriceOf(app));
  if (app.screen && Date.now() - app.screenAt < config.screen.intervalSec * 1000) return;
  try {
    app.screen = await runScreen(app.connection, (s) => console.log(s));
    app.screenAt = Date.now();
    registerTokens(app.screen);
    // Stock pools: refresh the basis to Backpack's perps in the background; the loop reads the file.
    refreshBasis()
      .then((b) => console.log(`[basis] ${b.rows.length} stock pools priced against Backpack; US session ${b.session}`))
      .catch((err) => console.error(`[basis] failed: ${(err as Error).message}`));
    setSolPriceUsd(solPriceOf(app));
  } catch (err) {
    console.error(`[screen] failed: ${(err as Error).message}`);
    if (!app.screen) {
      app.screen = loadScreen();
      if (app.screen) console.log(`[screen] using saved screen from ${app.screen.generatedAt}`);
      setSolPriceUsd(solPriceOf(app));
    }
  }
}

/**
 * Pinned pools, pools we hold bands in, then the screener's best picks up to the cap.
 * SOL-quoted pools always qualify; USDC-quoted ones only when the screen carries a SOL price
 * (the guards' limits are in SOL, so a USDC seat needs the conversion). Every stock pool is USDC-quoted.
 */
/** The hot watch's tradable rows: a tradable venue, quoted in SOL (or USDC when priced), best heat first. */
function hotRows(app: App, max = config.maxActivePools): HotRow[] {
  const usdcOk = typeof app.screen?.solPriceUsd === "number" && app.screen.solPriceUsd > 0;
  return hotPicks(loadHot(), {
    tradable: (r) => isTradableVenue(r.venue) && (r.quoteSymbol === "SOL" || (r.quoteSymbol === "USDC" && usdcOk)),
    max,
  });
}

/** Which quotes the wallet can seat at the policy's minimum: SOL above the gas reserve and the rent budget, USDC at the SOL price. */
function fundableQuotes(app: App, sol: number, usdc: number): Set<"SOL" | "USDC"> {
  const minSeatSol = Math.max(0.05, (riskLimits.maxTotalExposureSol * policyEnv().minSeatPct) / 100);
  const rentBudget = OPEN_COST_ESTIMATE_SOL * config.maxActivePools;
  const solPrice = solPriceOf(app);
  const out = new Set<"SOL" | "USDC">();
  if (sol - riskLimits.gasReserveSol - rentBudget >= minSeatSol) out.add("SOL");
  if (solPrice !== null && usdc / solPrice >= minSeatSol && sol - OPEN_COST_ESTIMATE_SOL >= riskLimits.gasReserveSol) out.add("USDC");
  return out;
}

function pickPools(app: App, withPositions: string[], funds: Set<"SOL" | "USDC">): string[] {
  const set = new Set<string>([...config.pinnedPools, ...withPositions]);
  // The operator's list decides what the desk may put money into; the screener only finds it.
  // Pinned pools and pools already holding a band are added above, so a band can always be managed out.
  const watch = loadWatchlist();
  const minVolume = Number(process.env.POLICY_MIN_VOLUME_24H_USD ?? 250_000);
  const usdcOk = typeof app.screen?.solPriceUsd === "number" && app.screen.solPriceUsd > 0 && funds.has("USDC");
  const quoteOk = (q: string) => (q === "SOL" && funds.has("SOL")) || (q === "USDC" && usdcOk);
  if (funds.size === 0) console.log(`[cycle ${app.cycle}] the wallet cannot fund a seat at the minimum in SOL or USDC; only held and pinned pools are worked`);
  // The stock book: tokenized stocks first, by fee/TVL, then the rest of the picker.
  if (bookEnv() === "stocks") {
    for (const p of stockBookPools(app.screen?.pools ?? [], usdcOk)) {
      if (set.size >= config.maxActivePools) break;
      if (quoteOk(p.quoteSymbol) && watchlistRefusal(p, watch) === null) set.add(p.address);
    }
  }
  // Surges first: what the fast watch found in the last hour, already filtered for liquidity, age and dumping.
  for (const r of hotRows(app)) {
    if (set.size >= config.maxActivePools) break;
    const row = { address: r.address, baseSymbol: r.baseSymbol, baseMint: r.baseMint, name: r.name };
    if (quoteOk(r.quoteSymbol) && watchlistRefusal(row, watch) === null && (r.vol24hUsd ?? 0) >= minVolume) set.add(r.address);
  }
  const candidates = (app.screen?.pools ?? []).filter(
    (p) =>
      tradableVenue(p) &&
      quoteOk(p.quoteSymbol) &&
      watchlistRefusal(p, watch) === null &&
      (p.volume24hUsd ?? 0) >= minVolume &&
      p.score > 0 &&
      !p.flags.includes("thin") &&
      !p.flags.includes("no-24h-data"),
  );
  // Rank what is left by the money: fees earned per dollar of liquidity in the last 24h, which is what
  // a seat here is paid. The score still decides who qualifies (it brakes thin, new, wild and one-sided
  // pools); this decides the order among those that do.
  const byYield = [...candidates].sort((a, b) => (b.feeToTvl24hPct ?? -1) - (a.feeToTvl24hPct ?? -1) || b.score - a.score);
  for (const p of byYield) {
    if (set.size >= config.maxActivePools) break;
    set.add(p.address);
  }
  return [...set];
}

/** The venue and pool handle for an address, loaded once: the screen's venue when the pool is on the board, else the account owner. */
async function getVenuePool(app: App, address: string): Promise<{ venue: Venue; pool: VenuePool }> {
  let vp = app.pools.get(address);
  if (!vp) {
    const hint: VenueId | undefined = app.screen?.pools.find((p) => p.address === address)?.venue;
    vp = await loadVenuePool(app.connection, address, hint);
    app.pools.set(address, vp);
  }
  return vp;
}

function screenContext(app: App, address: string): ScreenContext | null {
  const s = app.screen;
  if (!s) return null;
  const p = s.pools.find((x) => x.address === address);
  if (!p) return null;
  return {
    rank: p.rank,
    rankedPools: s.rankedPools,
    score: p.score,
    feeToTvl24hPct: p.feeToTvl24hPct,
    volume24hUsd: p.volume24hUsd,
    tvlUsd: p.tvlUsd,
    ageHours: p.ageHours,
    priceChange24hPct: p.priceChange24hPct,
    flags: p.flags,
    generatedAt: s.generatedAt,
    stock: p.stock ? { ticker: p.stock.ticker, issuer: p.stock.issuer } : null,
    alternatives: s.pools
      .filter((x) => x.address !== address && tradableVenue(x) && (x.quoteSymbol === "SOL" || (x.quoteSymbol === "USDC" && solPriceOf(app) !== null)))
      .slice(0, 5)
      .map((x) => ({ name: x.name, score: x.score, feeToTvl24hPct: x.feeToTvl24hPct, tvlUsd: x.tvlUsd })),
    hot: hotPicks(loadHot(), { tradable: () => true, max: 8 }).map((r) => ({
      name: r.name,
      venue: r.venue,
      tradable: isTradableVenue(r.venue) && (r.quoteSymbol === "SOL" || r.quoteSymbol === "USDC"),
      thisPool: r.address === address,
      liquidityUsd: r.liquidityUsd,
      vol1hUsd: r.vol1hUsd,
      feeToTvlDailyPct: r.feeToTvlDailyPct,
      acceleration: r.acceleration,
      priceChange1hPct: r.priceChange1hPct,
      heat: r.heat,
      flags: r.flags,
      surge: r.surge,
    })),
  };
}

/** The 24h move of a pool for the board regime: the screen's figure, else the change over our own price history. */
function move24hPct(app: App, address: string, state: RiskState): number | null {
  const fromScreen = app.screen?.pools.find((p) => p.address === address)?.priceChange24hPct;
  if (typeof fromScreen === "number" && Number.isFinite(fromScreen)) return fromScreen;
  const h = state.priceHistory?.[address];
  if (!h || h.length < 2) return null;
  const sorted = [...h].sort((a, b) => a.ts - b.ts);
  const first = sorted[0].price;
  const last = sorted[sorted.length - 1].price;
  return first > 0 ? (last / first - 1) * 100 : null;
}

/**
 * The pool's price on the previous cycle, from its own history: the sample before the one this
 * iteration recorded. state.lastPrice is one number for the whole state, so with several pools it
 * would compare this pool against whichever pool was decided last and veto every open as a "price move".
 */
function previousPrice(state: RiskState, pool: string): number | null {
  const h = state.priceHistory?.[pool];
  if (!h || h.length < 2) return null;
  const sorted = [...h].sort((a, b) => a.ts - b.ts);
  const prev = sorted[sorted.length - 2].price;
  return prev > 0 ? prev : null;
}

/** The 24h fee figure the paper mark accrues from: the screen row, else the hot watch's 24h volume. */
function paperFeeSource(app: App, address: string): { fees24hUsd: number | null; volume24hUsd: number | null } | null {
  const row = app.screen?.pools.find((p) => p.address === address);
  if (row) return { fees24hUsd: row.fees24hUsd, volume24hUsd: row.volume24hUsd };
  const hot = loadHot()?.rows.find((r) => r.address === address);
  if (hot) return { fees24hUsd: null, volume24hUsd: hot.vol24hUsd };
  return null;
}

function updateState(state: RiskState, exec: ExecutionResult, positions: PositionSnapshot[], snapshot: PoolSnapshot): void {
  state.lastPrice = snapshot.activePrice;
  for (const p of positions) {
    if (!(p.address in state.entryValueSol)) state.entryValueSol[p.address] = p.entryValueSol ?? p.valueInSol;
  }
  if (exec.txs.length > 0) {
    state.actionsToday += 1;
    state.lastActionAt = Date.now();
    // Band moves start this pool's cooldown; a fee claim does not.
    if (exec.opened || exec.closed) (state.lastMoveByPool ??= {})[snapshot.address] = Date.now();
  }
  if (exec.ok && exec.opened) {
    state.entryValueSol[exec.opened.address] = exec.opened.entryValueSol;
    (state.stops ??= {})[exec.opened.address] = rollStop(riskLimits);
  }
  if (exec.ok && exec.closed) forgetBand(state, exec.closed);
  saveState(state);
}

async function runPool(app: App, o: Observed, all: Observed[], sol: number): Promise<JournalEntry> {
  const ts = new Date().toISOString();
  const t0 = Date.now();
  const now = t0;
  const mode = config.dryRun ? "dry-run" : "live";
  const { snapshot, positions, raw } = o;
  const tag = `[cycle ${app.cycle} ${snapshot.label}]`;
  const venueTag = o.venue.id === "meteora-dlmm" ? "" : ` ${o.venue.id}`;
  const q = quoteOf(snapshot);
  // The venue's open cost: what the policy sizes with and the guards' gas-reserve check charges.
  const openCostDefault = o.venue.openCostSol(snapshot).total;
  const quoteIsSol = q.symbol === "SOL";
  const paper = app.paper;

  // Balances: SOL always (gas), the base token, and the pool's quote token when it is not SOL.
  // Paper mode reads them from the virtual wallet instead of the chain.
  const [token, quoteBal, analytics] = await Promise.all([
    paper ? Promise.resolve({ ui: paperTokenBalance(paper, snapshot.baseToken.mint) }) : app.wallet.tokenBalance(new PublicKey(snapshot.baseToken.mint)),
    quoteIsSol ? Promise.resolve(null) : paper ? Promise.resolve({ ui: paper.wallet.usdc }) : app.wallet.tokenBalance(new PublicKey(q.token.mint)),
    fetchPoolAnalytics(o.address, snapshot),
  ]);
  const quote = quoteIsSol ? sol : (quoteBal?.ui ?? 0);
  const state = loadState();
  const killSwitch = killSwitchActive();
  // A paper band carries its entry from the book; a chain position has none until the state says.
  for (const p of positions) p.entryValueSol = state.entryValueSol[p.address] ?? p.entryValueSol;
  // The price this pool showed last cycle (not whichever pool was decided last: see previousPrice).
  const lastPrice = previousPrice(state, o.address);
  const guardState: RiskState = { ...state, lastPrice };
  trackOutOfRange(state, positions, now);
  trackFeesPending(state, positions, snapshot, now, cfg.collectFloorSol);
  const others = all.filter((x) => x !== o);
  const portfolio = {
    activePools: all.map((x) => x.snapshot.label),
    poolsWithBands: others.filter((x) => x.positions.length > 0).length,
    maxActivePools: config.maxActivePools,
    otherExposureSol: others.reduce((s, x) => s + x.positions.reduce((t, p) => t + p.valueInSol, 0), 0),
  };
  const screen = screenContext(app, o.address);

  // The engine's view of this pool: breakers, bench, regime, knife, collects.
  const ledgerRows = readLedgerRows();
  const collectsToday = collectsOnDay(ledgerRows, mode, dayOf(now));
  const knife = knifeReason(state.priceHistory?.[o.address], now, cfg.knifePct);
  const view = engineView(app.engine, o.address, app.regime, knife, collectsToday, now);
  const stateStops = state.stops ?? {};
  const stops: Record<string, number> = {};
  const oorSec: Record<string, number> = {};
  for (const p of positions) {
    if (p.address in stateStops) stops[p.address] = stateStops[p.address];
    oorSec[p.address] = outOfRangeSec(state.outOfRangeSince, p.address, now);
  }
  // Stock pools carry a basis row (src/basis): the US session clock and the gap to Backpack's perp.
  const basisRow = basisForPool(o.address);
  const clock = sessionClock();
  const basisCheck = basisRow ? basisVerdict(basisRow.basisPct ?? null, clock) : null;
  const basisObs: EngineObservation["basis"] = basisRow
    ? {
        session: clock.session,
        minutesToOpen: clock.minutesToOpen,
        basisPct: basisRow.basisPct ?? null,
        perpSymbol: basisRow.perpSymbol ?? null,
        perpMid: (basisRow.perpSymbol ? app.perpMarks.get(basisRow.perpSymbol)?.mid : undefined) ?? basisRow.perpMid ?? null,
        widthMultiplier: sessionWidthMultiplier(clock),
        reason: basisCheck && !basisCheck.ok ? basisCheck.reason : null,
      }
    : undefined;
  const engineObs: EngineObservation = {
    halt: view.haltedUntil !== null ? { until: view.haltedUntil, stage: view.haltStage, reason: view.haltReason } : null,
    standDown: view.standDownUntil !== null ? { until: view.standDownUntil, reason: view.standDownReason } : null,
    bench: view.bench,
    regime: { medianMove24hPct: view.regime.medianMove24hPct, multiplier: view.regime.multiplier, reason: view.regime.reason },
    sizeMultiplier: view.sizeMultiplier,
    effectiveMaxPositionSol: riskLimits.maxPositionSol * view.sizeMultiplier,
    stops,
    outOfRangeSec: oorSec,
    minOutOfRangeSec: cfg.outOfRangeSec,
    knife,
    collectsToday,
    collectMaxPerDay: cfg.collectMaxPerDay,
    basis: basisObs,
  };

  const observation: Observation = {
    ts,
    cycle: app.cycle,
    mode,
    poolLabel: snapshot.label,
    snapshot,
    positions,
    wallet: { address: app.wallet.publicKey.toBase58(), sol, token: token.ui, tokenSymbol: snapshot.baseToken.symbol, quote, quoteSymbol: q.symbol },
    analytics,
    state: { actionsToday: state.actionsToday, lastActionAt: state.lastActionAt, lastMoveAt: state.lastMoveByPool?.[o.address] ?? null, lastPrice, killSwitch },
    recent: readRecent(40)
      .filter((e) => e.pool.address === o.address)
      .slice(0, 5)
      .map((e) => ({ ts: e.ts, action: e.decision.action, allowed: e.allowed, headline: e.headline, violations: e.violations })),
    screen,
    portfolio,
    engine: engineObs,
  };
  console.log(
    `${tag}${venueTag} active bin ${snapshot.activeBinId} price ${snapshot.activePrice.toPrecision(6)} ${snapshot.priceLabel} | quote ${q.symbol}${quoteIsSol ? "" : ` (1 ${q.symbol} = ${q.priceInSol.toFixed(6)} SOL)`} | screen ${screen ? `#${screen.rank} score ${screen.score}` : "n/a"} | wallet ${sol.toFixed(4)} SOL, ${quoteIsSol ? "" : `${quote.toFixed(2)} ${q.symbol}, `}${token.ui.toFixed(2)} ${snapshot.baseToken.symbol} | bands ${positions.length} | size x${view.sizeMultiplier}${knife ? ` | ${knife}` : ""}`,
  );

  // The engine decides first. When it has a directive the LLM is not asked this cycle.
  const directive = engineDirective({ now, snapshot, positions, state, engine: app.engine, cfg, limits: riskLimits, collectsToday });
  // Then an approved outside proposal, oldest first: "agents propose, the operator decides, the desk
  // executes through its own guards". Otherwise Mr Bands proposes.
  const proposal = directive ? null : (approvedProposals(o.address)[0] ?? null);
  // An engine close in a stock pool liquidates: the book returns to the quote, the hedge comes off with it.
  const directiveDecision = directive && basisRow && directive.decision.action === "CLOSE_POSITION" ? { ...directive.decision, liquidate: true } : directive?.decision;
  const llm = directive
    ? engineDecideResult(directiveDecision!, `${directive.kind}: ${directive.reason}`)
    : proposal
      ? proposalDecideResult(proposalDecision(proposal), `proposal ${proposal.id} by ${proposal.proposerName} (${proposal.proposerId})`)
      : await decide(observation, { hot: hotRows(app, 8), openCostSol: openCostDefault });
  console.log(`${tag} ${directive ? `engine directive ${directive.kind}` : proposal ? `proposal ${proposal.id}` : `${config.agentName} proposes`} ${llm.decision.action} (${llm.source}): "${llm.decision.headline}"`);

  const engineCtx: EngineGuardContext = {
    haltedUntil: view.haltedUntil,
    standDownUntil: view.standDownUntil,
    sizeMultiplier: view.sizeMultiplier,
    benched: view.bench.benched,
    benchReason: view.bench.reason,
    regimeReason: view.regime.reason,
    knife,
    outOfRangeSince: state.outOfRangeSince ?? {},
    stops: stateStops,
    outOfRangeSec: cfg.outOfRangeSec,
    basisReason: basisObs?.reason ?? null,
  };
  const openCostSol = llm.decision.open ? o.venue.openCostSol(snapshot, toOpenPlan(llm.decision.open, snapshot)).total : openCostDefault;
  const verdict = evaluate(
    llm.decision,
    { now, snapshot, positions, walletSol: sol, walletToken: token.ui, walletQuote: quote, state: guardState, killSwitch, ...portfolio, engine: engineCtx, source: directive ? "engine" : "llm", openCostSol },
    riskLimits,
  );
  if (verdict.overrides.length) console.log(`${tag} guard override: ${verdict.overrides.join("; ")}`);
  if (verdict.violations.length) console.log(`${tag} guards BLOCKED: ${verdict.violations.join("; ")}`);

  const execution = await execute(verdict, {
    venue: o.venue,
    pool: o.pool,
    wallet: app.wallet,
    rawPositions: raw,
    snapshot,
    positions,
    paper: paper ? { book: paper, slippagePct: app.paperEnv.slippagePct, now } : undefined,
    walletToken: token.ui,
  });
  if (paper) savePaperBook(paper);
  for (const t of execution.txs) {
    console.log(`${tag} ${execution.mode} ${t.label}: ${t.signature ?? t.skipped ?? (t.ok ? "simulated ok" : `FAILED ${t.error}`)}`);
  }
  if (!execution.ok || execution.txs.length === 0) for (const n of execution.notes) if (n !== "hold" && n !== "blocked by guards") console.log(`${tag} ${execution.mode}: ${n}`);
  for (const row of execution.ledger ?? []) {
    const quoteLeg = quoteIsSol || typeof row.quoteDelta !== "number" ? "" : ` (${row.quoteDelta.toFixed(4)} ${q.symbol})`;
    console.log(`${tag} ledger ${row.mech} ${row.basis}: sol ${row.solDelta.toFixed(6)}${quoteLeg} rent ${row.rentSol.toFixed(6)} fee ${row.txFeeSol.toFixed(6)} token ${row.tokenDelta.toFixed(4)}`);
  }
  updateState(state, execution, positions, snapshot);

  // The hedge desk: after execution, the stock token in the wallet and in this pool's bands is carried short on the perp.
  let hedgeJournal: JournalHedge | undefined;
  if (basisRow) {
    try {
      const mint = snapshot.baseToken.mint;
      const symbol = basisRow.perpSymbol ?? null;
      const ticker = basisRow.ticker ?? screen?.stock?.ticker ?? tickerOfXstock(snapshot.baseToken.symbol);
      let bandsToken: number;
      let walletToken: number;
      if (paper) {
        bandsToken = paperPoolTokenInventory(paper, o.address);
        walletToken = paperTokenBalance(paper, mint);
      } else {
        const remaining = positions.filter((p) => p.address !== execution.closed);
        const openedToken = execution.ok && execution.opened && verdict.decision.open ? verdict.decision.open.amountToken : 0;
        bandsToken = remaining.reduce((t, p) => t + baseInventoryOf(p, snapshot), 0) + openedToken;
        walletToken = token.ui;
        if (!config.dryRun && execution.txs.length > 0) {
          try {
            walletToken = (await app.wallet.tokenBalance(new PublicKey(mint))).ui;
          } catch {
            /* keep the pre-execution read */
          }
        }
      }
      // the wallet's token counts once per mint per cycle, for the first pool decided on it
      const attribute = !app.mintAttributed.has(mint);
      app.mintAttributed.add(mint);
      const baseInventory = bandsToken + (attribute ? walletToken : 0);
      const quoteUsd = quoteIsSol ? (solPriceOf(app) ?? 0) : 1;
      const poolUsd = q.tokenPriceInQuote * quoteUsd;
      const basePrice = (symbol ? app.perpMarks.get(symbol)?.mid : undefined) ?? basisRow.perpMid ?? (poolUsd > 0 ? poolUsd : null);
      const otherPoolsShort = symbol ? (app.hedgedThisCycle.get(symbol) ?? 0) : 0;
      const outcome = await runHedgeDesk({ pool: o.address, label: snapshot.label, ticker, symbol, baseInventory, basePrice, fundingRatePerHour: basisRow.fundingRatePerHour ?? null, now, paper, client: backpack(), otherPoolsShort });
      if (symbol) app.hedgedThisCycle.set(symbol, otherPoolsShort + outcome.journal.targetShortQty);
      hedgeJournal = outcome.journal;
      for (const line of outcome.lines) console.log(`${tag} ${line}`);
      if (paper) savePaperBook(paper);
    } catch (err) {
      console.error(`${tag} hedge desk failed (trading unaffected): ${(err as Error).message}`);
    }
  }

  // A stop-loss close that went through counts against the pool on the bench ladder.
  const stoppedOut = execution.ok && !!execution.closed && (directive?.kind === "STOP" || verdict.overrides.some((v) => v.startsWith("stop-loss")));
  if (stoppedOut) {
    recordStop(app.engine, o.address, now);
    saveEngineState(app.engine);
    console.log(`${tag} bench: stop recorded, ${app.engine.stopTimes[o.address].length} in the window`);
  }

  const journalEngine: JournalEngine = {
    directive: directive?.kind ?? null,
    reason: directive?.reason ?? null,
    sizeMultiplier: view.sizeMultiplier,
    bench: { stops6h: view.bench.stops6h, multiplier: view.bench.multiplier, benched: view.bench.benched },
    regime: { medianMove24hPct: view.regime.medianMove24hPct, multiplier: view.regime.multiplier },
    halt: view.haltedUntil !== null ? { until: view.haltedUntil, stage: view.haltStage ?? 0 } : null,
    standDown: view.standDownUntil !== null ? { until: view.standDownUntil, reason: view.standDownReason } : null,
    stops,
    collectsToday,
    basis: basisObs ? { session: basisObs.session, minutesToOpen: basisObs.minutesToOpen, basisPct: basisObs.basisPct, perpSymbol: basisObs.perpSymbol, widthMultiplier: basisObs.widthMultiplier, reason: basisObs.reason } : undefined,
  };

  const { decision: _d, ...llmMeta } = llm;
  const entry: JournalEntry = {
    id: `${ts}-${app.cycle}-${o.address.slice(0, 6)}`,
    ts,
    cycle: app.cycle,
    mode,
    agent: { id: config.agentId, name: config.agentName },
    pool: toJournalPool(snapshot),
    wallet: observation.wallet,
    positions,
    analytics,
    llm: llmMeta,
    proposal: verdict.proposal,
    decision: verdict.decision,
    allowed: verdict.allowed,
    violations: verdict.violations,
    overrides: verdict.overrides,
    passed: verdict.passed,
    emergency: verdict.emergency,
    execution,
    headline: verdict.decision.headline,
    screen: screen ? { rank: screen.rank, rankedPools: screen.rankedPools, score: screen.score, feeToTvl24hPct: screen.feeToTvl24hPct } : null,
    engine: journalEngine,
    ...(hedgeJournal ? { hedge: hedgeJournal } : {}),
  };
  appendJournal(entry);
  if (proposal) {
    // The receipt is the journal entry, whether the guards let it through or refused it.
    markExecuted(proposal.id, entry.id);
    console.log(`${tag} proposal ${proposal.id} ${verdict.allowed ? "executed" : "refused by the guards"} -> journal ${entry.id}`);
  }
  console.log(`${tag} final ${verdict.decision.action} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return entry;
}

/**
 * The breakers mark the book once per iteration, only on a complete read: a pool that failed to
 * observe would read as vanished capital, and a phantom crater must never trip a breaker.
 */
function markBook(app: App, observed: Observed[], entries: JournalEntry[], solAtStart: number, usdcAtStartSol: number, hedgeSol = 0): void {
  const now = Date.now();
  const today = todayUtc();
  const mode = config.dryRun ? "dry-run" : "live";
  const state = loadState();
  const closed = new Set(entries.map((e) => e.execution.closed).filter((c): c is string => !!c));
  const openBands = observed.flatMap((o) => o.positions).filter((p) => !closed.has(p.address));
  for (const p of openBands) p.entryValueSol = state.entryValueSol[p.address];

  // Circuit breaker: today's realized loss from the ledger, netted with the marked drawdown of open bands.
  const rows = readLedgerRows();
  const loss = circuitLossSol(realizedOnDaySol(rows, mode, today), markedDrawdownSol(openBands));
  const cv = circuitVerdict(app.engine.circuit, loss, workingSol(state.entryValueSol), today, now, { floorSol: cfg.circuitFloorSol });
  app.engine.circuit = cv.next;
  if (cv.tripped) console.error(`[cycle ${app.cycle}] CIRCUIT BREAKER: ${cv.reason}`);

  // Portfolio breaker: whole-book equity in SOL (wallet SOL + wallet USDC at the SOL price + bands marked incl. unclaimed fees + wallet base tokens at mark).
  const tokensSol = entries.reduce((s, e) => s + e.wallet.token * e.pool.tokenPriceInSol, 0);
  const equity = solAtStart + usdcAtStartSol + observed.reduce((s, o) => s + o.positions.reduce((t, p) => t + p.valueInSol, 0), 0) + tokensSol + hedgeSol;
  if (Number.isFinite(equity) && equity > 0) {
    const pv = portfolioVerdict(app.engine.portfolio, equity, today, now, { floorSol: cfg.portfolioFloorSol });
    app.engine.portfolio = pv.next;
    if (pv.fire) console.error(`[cycle ${app.cycle}] PORTFOLIO BREAKER: ${pv.reason}`);
  }
  saveEngineState(app.engine);
  console.log(
    `[cycle ${app.cycle}] marks: equity ${equity.toFixed(4)} SOL (day high ${app.engine.portfolio.hwmSol.toFixed(4)})${hedgeSol !== 0 ? ` incl. hedge ${hedgeSol >= 0 ? "+" : ""}${hedgeSol.toFixed(4)}` : ""} | today's loss ${loss.toFixed(4)} / limit ${app.engine.circuit.lastLimitSol.toFixed(4)} SOL | working ${workingSol(state.entryValueSol).toFixed(4)}`,
  );
}

/** The treasury skim, after the pool loop, in its own failure domain. */
async function runSkim(app: App): Promise<void> {
  if (!cfg.skim) return;
  try {
    const mode = config.dryRun ? "dry-run" : "live";
    const walletSol = await app.wallet.solBalance();
    const plan = skimPlan(walletSol, readLedgerRows(), mode, cfg, riskLimits.gasReserveSol);
    if (!plan) return;
    const r = await executeSkim(app.wallet, plan);
    for (const t of r.txs) console.log(`[cycle ${app.cycle}] ${r.mode} ${t.label}: ${t.signature ?? t.skipped ?? (t.ok ? "simulated ok" : `FAILED ${t.error}`)}`);
    if (!r.ok) console.error(`[cycle ${app.cycle}] skim failed (trading unaffected): ${r.notes.join("; ")}`);
  } catch (err) {
    console.error(`[cycle ${app.cycle}] skim failed (trading unaffected): ${(err as Error).message}`);
  }
}

/**
 * The perp mids the hedge desk prices at, refreshed at most once per cycle: the symbols of the stock
 * pools being worked and of the paper shorts held. Public Backpack calls, paced; a failure keeps the
 * basis row's figure. The funding rate stays the basis row's (refreshed after each screen).
 */
async function refreshPerpMarks(app: App, pools: string[]): Promise<void> {
  const symbols = new Set<string>();
  for (const address of pools) {
    const sym = basisForPool(address)?.perpSymbol;
    if (sym) symbols.add(sym);
  }
  for (const p of app.paper?.hedge?.positions ?? []) symbols.add(p.symbol);
  if (symbols.size === 0) return;
  const now = Date.now();
  for (const symbol of symbols) {
    try {
      const depth = await backpack().depth(symbol, 5);
      if (depth?.mid && depth.mid > 0) app.perpMarks.set(symbol, { mid: depth.mid, at: now });
    } catch (err) {
      console.error(`[cycle ${app.cycle}] perp mid ${symbol}: ${(err as Error).message}`);
    }
  }
  const marks = [...symbols].map((sym) => `${sym} ${app.perpMarks.get(sym)?.mid ?? "n/a"}`);
  console.log(`[cycle ${app.cycle}] perp mids: ${marks.join(", ")}`);
}

async function runIteration(app: App): Promise<void> {
  await ensureScreen(app);
  app.engine = loadEngineState();

  const paper = app.paper;
  let withPositions: string[];
  if (paper) {
    withPositions = poolsWithBands(paper);
  } else {
    withPositions = (await poolsWithPositions(app.connection, app.wallet.publicKey, (s) => console.error(`[cycle ${app.cycle}] ${s}`))).map((p) => p.address);
  }
  // What the wallet can fund decides which quotes the picker may take: a USDC book must not be handed
  // SOL-quoted pools it cannot seat, and a seat must clear the policy's minimum.
  const solAtStart = paper ? paper.wallet.sol : await app.wallet.solBalance();
  // The wallet's USDC is capital too (a closed USDC band returns as USDC): it marks at the SOL price.
  let usdcAtStart = 0;
  if (paper) {
    usdcAtStart = paper.wallet.usdc;
  } else {
    try {
      usdcAtStart = (await app.wallet.usdcBalance()).ui;
    } catch (err) {
      console.error(`[cycle ${app.cycle}] could not read the wallet's USDC: ${(err as Error).message}`);
    }
  }
  const funds = fundableQuotes(app, solAtStart, usdcAtStart);
  const pools = pickPools(app, withPositions, funds);
  if (pools.length === 0) {
    console.log(`[cycle ${app.cycle}] nothing to work: no pinned pools, no bands held, no screen picks`);
    return;
  }
  console.log(`[cycle ${app.cycle}] working ${pools.length} pools (${withPositions.length} with bands)`);
  app.hedgedThisCycle.clear();
  app.mintAttributed.clear();
  await refreshPerpMarks(app, pools);

  const solPriceUsd = solPriceOf(app);
  const observed: Observed[] = [];
  for (const address of pools) {
    try {
      const { venue, pool } = await getVenuePool(app, address);
      const snapshot = await venue.snapshot(pool, 10, { solPriceUsd });
      if (paper) {
        // The paper bands of this pool, marked against the live snapshot (fees accrue here).
        const positions = markPool(paper, snapshot, { now: Date.now(), fees: paperFeeSource(app, address), solPriceUsd });
        savePaperBook(paper);
        observed.push({ address, venue, pool, snapshot, raw: [], positions });
      } else {
        const { raw, positions } = await venue.positions(pool, app.wallet.publicKey, snapshot);
        observed.push({ address, venue, pool, snapshot, raw, positions });
      }
    } catch (err) {
      // A USDC pool without a SOL price, or a pool quoted in neither, is skipped with its reason: it
      // cannot be valued in SOL, so no guard, breaker or ledger row sees it this cycle.
      if (err instanceof QuotePriceUnknownError || err instanceof UnsupportedQuoteError) console.log(`[cycle ${app.cycle}] skipping ${address}: ${err.message}`);
      else console.error(`[cycle ${app.cycle}] could not observe ${address}: ${(err as Error).message}`);
    }
  }

  // Price history for the knife check, then the board regime for this iteration.
  const now = Date.now();
  const state = loadState();
  for (const o of observed) recordPrice(state, o.address, o.snapshot.activePrice, now);
  saveState(state);
  // The board regime reads the broad tradable board (top 20 by score) plus the pools being worked,
  // not just the picks: the picks are the surges, and two dumping surges must not switch the whole book off.
  const usdcPriced = solPriceOf(app) !== null;
  const boardSample = (app.screen?.pools ?? [])
    .filter((p) => tradableVenue(p) && (p.quoteSymbol === "SOL" || (p.quoteSymbol === "USDC" && usdcPriced)) && p.score > 0)
    .slice(0, 20)
    .map((p) => p.address);
  const regimeAddrs = [...new Set([...boardSample, ...observed.map((o) => o.address)])];
  app.regime = regimeView(regimeAddrs.map((a) => move24hPct(app, a, state)));
  if (app.regime.reason) console.log(`[cycle ${app.cycle}] ${app.regime.reason}`);

  // Pools holding a band are decided first: closes free capital for opens later in the pass.
  observed.sort((a, b) => b.positions.length - a.positions.length);
  const entries: JournalEntry[] = [];
  for (const o of observed) {
    try {
      const sol = paper ? paper.wallet.sol : await app.wallet.solBalance();
      entries.push(await runPool(app, o, observed, sol));
    } catch (err) {
      console.error(`[cycle ${app.cycle} ${o.snapshot.label}] failed:`, err);
    }
  }

  // Marks need a complete, consistently valued read: every picked pool observed and decided, and
  // the wallet's USDC valued whenever it holds any (an unpriced USDC balance would swing equity).
  const usdcUnpriced = usdcAtStart > 0.01 && solPriceUsd === null;
  if (observed.length === pools.length && entries.length === observed.length && observed.length > 0 && !usdcUnpriced) {
    try {
      const hedgeSol = paper && solPriceUsd ? paperHedgeEquityUsd(paper.hedge).netUsd / solPriceUsd : 0;
      markBook(app, observed, entries, solAtStart, solPriceUsd ? usdcAtStart / solPriceUsd : 0, hedgeSol);
    } catch (err) {
      console.error(`[cycle ${app.cycle}] marks failed:`, err);
    }
  } else if (usdcUnpriced) {
    console.log(`[cycle ${app.cycle}] marks skipped: the wallet holds ${usdcAtStart.toFixed(2)} USDC and no SOL price is known to value it`);
  } else {
    console.log(`[cycle ${app.cycle}] marks skipped: ${observed.length}/${pools.length} pools observed, ${entries.length} decided`);
  }
  await runSkim(app);
  // The site shows what the desk just did: push once the cycle's decisions are on disk, throttled.
  // (Deploying right after the screen would ship a journal that stops at the previous cycle, and an
  // empty one on the very first run.)
  if (config.autoDeploy && entries.length > 0) deploySnapshot();
}

function sleepInterruptible(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      process.off("SIGINT", onSig);
      resolve();
    }, ms);
    const onSig = () => {
      clearTimeout(t);
      resolve();
    };
    process.once("SIGINT", onSig);
  });
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  // Paper mode never shares a process with a live key.
  assertPaperEnv(config.dryRun);
  const pEnv = paperEnv();
  let paper: PaperBook | null = null;
  if (paperEnabled(process.env, config.dryRun)) {
    const existing = loadPaperBook();
    paper = existing ?? emptyBook(pEnv.sol, pEnv.usdc);
    if (existing) console.log(`[paper] resuming the book started ${existing.startedAt} (${existing.startSol} SOL${existing.startSol !== pEnv.sol ? `; PAPER_SOL=${pEnv.sol} ignored, the book keeps its start` : ""})`);
    else console.log(`[paper] new book: ${pEnv.sol} SOL, ${pEnv.usdc} USDC`);
    savePaperBook(paper);
  }
  const connection = new Connection(config.rpcUrl, "confirmed");
  const wallet = Wallet.fromConfig(connection);
  acquireLock(wallet.publicKey.toBase58(), config.cycleIntervalSec);
  process.on("exit", releaseLock);
  process.once("SIGTERM", () => {
    releaseLock();
    process.exit(143);
  });
  const app: App = {
    connection,
    wallet,
    cycle: 0,
    pools: new Map(),
    screen: loadScreen(),
    screenAt: 0,
    engine: loadEngineState(),
    regime: regimeView([]),
    paper,
    paperEnv: pEnv,
    perpMarks: new Map(),
    hedgedThisCycle: new Map(),
    mintAttributed: new Set(),
  };
  if (app.screen) app.screenAt = new Date(app.screen.generatedAt).getTime();
  setSolPriceUsd(solPriceOf(app));
  banner(app);
  if (config.servePort > 0) startServer(config.servePort);
  if (!once) startWatchdog({ cycleIntervalSec: config.cycleIntervalSec, live: !config.dryRun });
  // The fast watch runs beside the loop; a single run takes one tick first so the picker has fresh surges.
  const hotWatch = once ? null : startHotWatch({ log: console.log });
  if (once) {
    try {
      const h = await runHotTick({ log: console.log });
      console.log(`[hot] ${h.rows.length} rows, ${h.rows.filter((r) => r.surge).length} surging`);
    } catch (err) {
      console.error(`[hot] tick failed: ${(err as Error).message}`);
    }
  }

  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log("\nSIGINT: finishing the current cycle, then stopping. Press again to force quit.");
  });

  while (!stopping) {
    app.cycle += 1;
    try {
      await runIteration(app);
    } catch (err) {
      console.error(`[cycle ${app.cycle}] failed:`, err);
    }
    heartbeat();
    if (once || stopping) break;
    if (config.maxCycles > 0 && app.cycle >= config.maxCycles) {
      console.log(`[loop] MAX_CYCLES=${config.maxCycles} reached; stopping cleanly`);
      break;
    }
    await sleepInterruptible(config.cycleIntervalSec * 1000);
  }
  hotWatch?.stop();
  releaseLock();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
