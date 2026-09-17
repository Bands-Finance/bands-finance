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
 * The launch lane (src/screener/launch.ts): everything above refuses a brand-new pool on purpose,
 * so one lane admits the CATEGORY instead. A pool too young for the board, the score and the
 * watchlist is seated when it clears the lane's own harsher floors (age, liquidity, 24h and 1h
 * volume, turnover, not being dumped), at most LAUNCH_MAX_SEATS at a time and only after every
 * other kind of pick has had its chance. It pays for the exemption with a capped seat, a tighter
 * rolled stop, a maximum hold and a volume-fade exit (the engine's EXPIRE directive).
 *
 * The pair lane (src/screener/pair.ts, src/venues/pair.ts): for a pump.fun token that clears the
 * lane's criteria on its PumpSwap reference pool, the desk makes a Meteora DLMM pool of its own and
 * seats a two-sided band in it, worked under the key pair-<mint> through the pair venue (a synthetic
 * snapshot priced from the reference row until the pool exists; the real pool once it does). It is
 * picked LAST, after the launch lane, one pool at a time, and its band carries the launch lane's
 * exits with the pair's stop and hold.
 *
 * The STOCK PAIR lane (src/screener/pairStock.ts): the focus. For each tokenized stock the lane admits
 * on the board (the ticker's deepest pool as the reference, its volume summed over its pools) the desk
 * makes a STOCKx/SOL pool on Meteora DLMM through the same pair venue (key pair-<mint>), priced from
 * the Backpack perp mid, and seats a two-sided straddle in it, hedged on Backpack where a perp is
 * listed. It is picked RIGHT AFTER held and pinned pools, before every ordinary lane, up to
 * PAIR_STOCK_MAX_POOLS with PAIR_STOCK_RESERVE_SEATS kept from ordinary picks. Its exits are the
 * ordinary stop, the cost-based re-centre and the stock policy's own closes, plus one guard: the
 * reference off the board for PAIR_STOCK_REF_GONE_CYCLES cycles closes and liquidates.
 *
 * The stock book: a stock pool's band is a straddle (src/agent/policy.ts) whose token half the hedge
 * desk (src/engine/hedgeDesk.ts) carries short on Backpack's perp after every execution; the perp
 * mids of the symbols in play are refreshed once per cycle, and an engine close in a stock pool
 * liquidates the token back to the quote. In paper mode the hedge is virtual (src/paper/hedge.ts).
 */
import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { config, riskLimits } from "./config";
import { decide, engineDecideResult, proposalDecideResult } from "./agent/decide";
import type { Decision } from "./agent/schema";
import { policyEnv } from "./agent/policy";
import { POSITION_RENT_SOL } from "./tools/dlmm";
import { approvedProposals, markExecuted, Proposal } from "./platform/proposals";
import type { EngineObservation, Observation, ScreenContext } from "./agent/observation";
import { evaluate, EngineGuardContext } from "./risk/guards";
import { describeLimits } from "./risk/limits";
import { killSwitchActive, loadState, saveState, RiskState, todayUtc } from "./risk/state";
import { execute, executeSkim, ExecutionResult, toOpenPlan } from "./executor";
import { appendEquity, appendJournal, JournalEngine, JournalEntry, readRecent, toJournalPool } from "./journal";
import { loadScreen, runScreen, tradableVenue } from "./screener";
import { loadWatchlist, watchlistDenial, watchlistRefusal } from "./screener/watchlist";
import { launchEnv, launchSeats, launchVerdict, type LaunchCandidate, type LaunchEnv } from "./screener/launch";
import { choosePinnedPool, pinnedPoolAt, pinnedTickers, PINNED_REFRESH_MS, refreshPinnedStocks, type PinnedStocks } from "./screener/pinnedStock";
import { flowByPool, flowContextLine, readFlowFile, type FlowContext, type PoolMeta as FlowPoolMeta } from "./scouts/flow";
import { consolidation, rankSeats, seatFaded, seatLine, seatRankingEnv, seatYield, sittingOut, swapDepthWithin, weakSeatRotation, type HeldSeat, type RankedSeat, type SeatRotation } from "./screener/seatYield";
import { pinRotateMinAgeMin, pinSeatAction, rotationCandidate, type RotationBand } from "./engine/rotation";
import { memeFloorEnv, memeFloorLine, memeRefusal, type MemeCandidate } from "./screener/memeFloor";
import { fetchPoolHistory, historyFresh, historyPhrase, historyRefusal, memeHistoryEnv, type HistoryRecord } from "./screener/memeHistory";
import { fetchMeteoraStockPools, meteoraStockCandidates, meteoraStockEnv, saveStockMints, stockMintMap, stockTagFromMap, type MeteoraStockPool } from "./screener/meteoraStocks";
import { verifiedStock } from "./screener/stocks";
import { dataPath } from "./lib/ledger";
import { voiceLine } from "./agent/voice";
import { jupiterEnv as swapEnv, meteoraOnlyRoutes } from "./tools/jupiter";
import { chooseFeeBps, competitionFor, isPairAddress, pairCandidatesOf, pairEnv, pairHouseSeats, pairHouseSeatSol, pairLaunchEnv, pairMintOf, pairModel, pairPoolAddress, pairSeats, pairSeatSol, pairVerdict, type PairSeatOptions } from "./screener/pair";
import { createPairVenue, hotRowForPool, isPairPool as isPairVenuePool } from "./venues/pair";
import { pairStockCandidateFor, pairStockCandidatesOf, pairStockEnv, pairStockReserve, pairStockSeats, pairStockSeatSol, chooseStockFeeBps, stockPairModel, type PairStockCandidate } from "./screener/pairStock";
import { MIN_BAND_SOL, stockBinsPerSide } from "./agent/policy";
import { loadHotFileCached } from "./hot/store";
import type { ScreenResult } from "./screener/types";
import { KNOWN_TOKENS, PoolSnapshot, PositionSnapshot, quoteOf, QuotePriceUnknownError, setSolPriceUsd, UnsupportedQuoteError } from "./tools/dlmm";
import { bookEnv, isTradableVenue, liveVenues, loadVenuePool, poolsWithPositions, stockBookPools, stockMinLiquidityUsd, tradableVenues, type Venue, type VenueId, type VenuePool } from "./venues";
import { fetchPoolAnalytics } from "./tools/lpagent";
import { Wallet } from "./tools/wallet";
import { startServer } from "./server";
import { basisForPool, basisForTicker, basisVerdict, refreshBasis, sessionClock, sessionWidthMultiplier, type BasisRow } from "./basis";
import { hotPicks, HotRow, launchRowOf, loadHot, runHotTick, startHotWatch } from "./hot";
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
import { forgetBand, knifeReason, moveAfterSec, outOfRangeSec, rangeOverWindowPct, recordPrice, rollStop, trackOutOfRange } from "./engine/exit";
import { collectsOnDay, dayOf, readLedgerRows, realizedOnDaySol, rowsOf, workingSol } from "./engine/ledger";
import { acquireLock, heartbeat, releaseLock, startWatchdog } from "./engine/watchdog";
import { assertPaperEnv, bandsInPool, emptyBook, loadPaperBook, markPool, paperBinRows, paperEnabled, paperEnv, paperHedgeEquityUsd, paperPoolTokenInventory, paperTokenBalance, poolsWithBands, savePaperBook, type PaperBook, type PaperEnv } from "./paper";
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
  /** money moved this pass (an open or a close ran): the other pools' exposure was read before it, so no seat grows on it */
  /** exposure each pool added (opened) or freed (closed) so far this pass, SOL: the pools decided after it see the true book, not the cycle-start read */
  exposureDelta: Map<string, number>;
  /** the pools the scout is asked to watch this cycle (held, picked, ranked), written once after observation */
  flowWatch: Map<string, FlowPoolMeta>;
  /** consecutive cycles a held seat's own measured yield read under the fade line */
  fadeStreak: Map<string, number>;
  movedThisCycle: boolean;
  /** base mints whose wallet balance has been attributed to a pool's hedge this cycle */
  mintAttributed: Set<string>;
  /** the pair lane's venue: our own pools for pump.fun tokens, keyed pair-<mint> (src/venues/pair.ts) */
  pairVenue: ReturnType<typeof createPairVenue>;
  /** the Meteora pools of the stocks the agent is paired with (PAIR_STOCK_PINNED_TICKERS), and when they were read */
  pinned: PinnedStocks | null;
  /** the flow scout's fresh readings by pool address, re-read each cycle; empty when the scout is off or stale */
  flow: Map<string, FlowContext>;
  /** the Meteora stock candidates ranked by what OUR seat would earn (src/screener/seatYield.ts), this cycle */
  seatRanking: { ranked: RankedSeat[]; held: HeldSeat[]; at: number } | null;
  /** a weak held seat the ranking wants to give up this cycle (one per cycle), for the ROTATE directive */
  seatRotation: SeatRotation | null;
  pinnedAt: number;
  /** the band the picker named this cycle to make room for a pin (src/engine/rotation.ts); null when none */
  rotateOut: { pool: string; label: string; reason: string } | null;
  /** a month of each memecoin pool's trading, read from GeckoTerminal (src/screener/memeHistory.ts), by pool address */
  memeHistory: Map<string, HistoryRecord>;
  /** Meteora's tokenized-stock pools (the RWA category, src/screener/meteoraStocks.ts) and when they were read */
  meteoraStocks: { at: number; pools: MeteoraStockPool[] } | null;
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
  {
    const se = pairStockEnv();
    console.log(
      `stocks/SOL ${se.on ? `stock pair lane ON (the focus): make our own STOCKx/SOL pool on Meteora for ${se.tickers ? se.tickers.join(", ") : "every xStock on the board"} whose reference holds >= $${se.minRefLiquidityUsd.toLocaleString("en-US")} and whose pools trade >= $${se.minVolume24hUsd.toLocaleString("en-US")} a day; ${se.binStep / 100}%/bin, fee ${se.feeBpsFixed ? `${se.feeBps / 100}%` : `chosen per pool from ${se.feeMenuBps.map((f) => `${f / 100}%`).join("/")}`}, fees in ${se.collectFeeMode === "both" ? "both tokens" : "SOL only"}, seat ${se.seatPct}% of the book as a hedged straddle, max ${se.maxPools} pool(s), ${se.reserveSeats} seat(s) reserved; picked right after held and pinned pools; closes when the reference is off the board ${se.refGoneCycles} cycles` : "stock pair lane off"}`,
    );
    const pe = pairEnv();
    console.log(`pairs     ${pe.on ? `pair lane ON: make our own Meteora pool for a pump.fun token that clears it (ref liquidity >= $${pe.minRefLiquidityUsd.toLocaleString("en-US")}, 24h >= $${pe.minVolume24hUsd.toLocaleString("en-US")}, 1h >= $${pe.minVolume1hUsd.toLocaleString("en-US")}, turnover >= ${pe.minTurnover}x); ${pe.quote} quote, ${pe.binStep / 100}%/bin, fee ${pe.feeBpsFixed ? `${pe.feeBps / 100}%` : `chosen per pool from ${pe.feeMenuBps.map((f) => `${f / 100}%`).join("/")}`}, seat ${pe.seatPct}% of the book, ${pe.binsEachSide} bins each side, max ${pe.maxPools} pool(s); creation ${app.paper ? "PAPER (virtual pool)" : config.dryRun ? "built + simulated, not sent" : pe.live ? "LIVE" : "built + simulated (PAIR_LIVE is not true)"}` : "pair lane off"}`);
  }
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
  // the platform, then the dashboard site when its Vercel link exists (dash/README.md)
  const dash = fs.existsSync(path.join(process.cwd(), "dash", ".vercel", "project.json"));
  console.log(`[deploy] pushing snapshot to Vercel${dash ? " (platform + dashboard)" : ""}`);
  exec(dash ? "npm run web:deploy && npm run dash:deploy" : "npm run web:deploy", { cwd: process.cwd() }, (err, stdout, stderr) => {
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
/**
 * The hot watch's tradable rows: a tradable venue, quoted in SOL (or USDC when priced), best heat first.
 *
 * `withLaunch` keeps rows the launch lane admits even though they are flagged `new`. It is ON for
 * the list the desk READS (the observation and the policy's extras, so a launch pool's 1h move and
 * heat are visible where the decision is made) and OFF for the surge pass of the picker, which must
 * not seat a launch pool through the ordinary door and skip LAUNCH_MAX_SEATS.
 */
function hotRows(app: App, max = config.maxActivePools, withLaunch = false): HotRow[] {
  const usdcOk = typeof app.screen?.solPriceUsd === "number" && app.screen.solPriceUsd > 0;
  return hotPicks(loadHot(), {
    tradable: (r) => isTradableVenue(r.venue) && (r.quoteSymbol === "SOL" || (r.quoteSymbol === "USDC" && usdcOk)),
    max,
    launch: withLaunch ? launchEnv() : null,
  });
}

/** The fast watch's row for one pool, when it has one. */
const hotRowOf = (address: string): HotRow | undefined => loadHot()?.rows.find((r) => r.address === address);

/**
 * The launch lane's verdict on a pool, read from the fast watch's row. The hot watch is the only
 * source that knows a pool this young: the screener's board is up to 15 minutes old and ranks on a
 * 24h history a two-hour-old pool does not have. Null when the lane is off, the watch has no row for
 * the pool, or the row does not clear the lane.
 */
function launchOf(row: HotRow | undefined, env: LaunchEnv = launchEnv()): { ok: true; ageHours: number; turnover: number } | null {
  if (!env.on || !row) return null;
  const v = launchVerdict(launchRowOf(row), env);
  return v.ok ? v : null;
}

/** Every hot row as the launch lane's seating rule wants it. */
const launchCandidates = (): LaunchCandidate[] =>
  (loadHot()?.rows ?? []).map((r) => ({ ...launchRowOf(r), address: r.address, baseMint: r.baseMint, baseSymbol: r.baseSymbol, name: r.name, venue: r.venue, heat: r.heat }));

/**
 * Which quotes the wallet can seat at the policy's minimum: SOL above the gas reserve and the rent budget,
 * USDC at the SOL price. A pre-filter only: rent is counted at a position's (the least any Meteora open
 * pays; bin arrays around a busy pool's price already exist), and the policy checks the pool's real open
 * cost against the gas reserve before it proposes anything.
 */
function fundableQuotes(app: App, sol: number, usdc: number): Set<"SOL" | "USDC"> {
  const minSeatSol = Math.max(0.05, (riskLimits.maxTotalExposureSol * policyEnv().minSeatPct) / 100);
  const rentBudget = POSITION_RENT_SOL * config.maxActivePools;
  const solPrice = solPriceOf(app);
  const out = new Set<"SOL" | "USDC">();
  if (sol - riskLimits.gasReserveSol - rentBudget >= minSeatSol) out.add("SOL");
  if (solPrice !== null && usdc / solPrice >= minSeatSol && sol - POSITION_RENT_SOL >= riskLimits.gasReserveSol) out.add("USDC");
  return out;
}

/** The stock pair lane's candidates: the board grouped by ticker, with the hot watch's last-hour volume where it has one. */
function stockCandidatesOf(app: App): PairStockCandidate[] {
  return pairStockCandidatesOf(app.screen?.pools ?? [], loadHot()?.rows ?? []);
}

/** The straddle's bins per side at a stock pair's bin step: a band already open sets its own; else STOCK_COVER_PCT x the US session's width. */
function stockPairBinsPerSide(app: App, binStep: number, address: string): number {
  const open = app.paper ? bandsInPool(app.paper, address) : [];
  const widest = open.reduce((w, b) => Math.max(w, Math.floor((b.upperBinId - b.lowerBinId) / 2)), 0);
  if (widest > 0) return widest;
  return stockBinsPerSide(binStep, policyEnv().stockCoverPct, riskLimits.maxBinWidth, sessionWidthMultiplier(sessionClock()));
}

/** A pair key of the STOCK lane: the loaded spec says so, else the paper book or the state's record, else the board carries the mint as a stock. */
function isStockPairKey(app: App, address: string): boolean {
  if (!isPairAddress(address)) return false;
  const loaded = app.pools.get(address)?.pool;
  if (loaded && isPairVenuePool(loaded)) return !!loaded.pair.stock;
  if (app.paper?.pairPools?.[address]?.stock) return true;
  if (loadState().pairPools?.[address]?.stock) return true;
  const mint = pairMintOf(address);
  return !!mint && pairStockCandidateFor(stockCandidatesOf(app), mint) !== null;
}

/** The Backpack perp mid for a ticker in USD: this cycle's refresh, else basis.json's; null when none is listed. */
function perpMidForTicker(app: App, ticker: string): number | null {
  const row = basisForTicker(ticker);
  if (!row?.perpSymbol) return null;
  return app.perpMarks.get(row.perpSymbol)?.mid ?? row.perpMid ?? null;
}

/** The basis row a pool reads: its own (a board pool), else its ticker's (a stock pair of ours is never on the board). */
function basisRowFor(address: string, snapshot?: PoolSnapshot | null, pinnedTicker?: string | null): BasisRow | null {
  const own = basisForPool(address);
  if (own) return own;
  const ticker = snapshot?.pair?.stock?.ticker ?? pinnedTicker ?? null;
  return ticker ? basisForTicker(ticker) : null;
}

/** The Meteora stock pool at an address, when the RWA category carries it. */
function meteoraStockAt(app: App, address: string): MeteoraStockPool | null {
  return app.meteoraStocks?.pools.find((p) => p.address === address) ?? null;
}

/**
 * Read Meteora's tokenized-stock pools (the RWA category) every METEORA_STOCK_REFRESH_MIN: write the stock
 * tags to DATA_DIR/stock-mints.json for the screener and the basis feed, and tag the board in memory now,
 * so a Backpack, xStocks or Ondo token is never judged as a memecoin. A failed read keeps the last answer.
 */
async function refreshMeteoraStocks(app: App): Promise<void> {
  const env = meteoraStockEnv();
  if (!env.on) return;
  if (app.meteoraStocks && Date.now() - app.meteoraStocks.at < env.refreshMin * 60_000) return;
  try {
    const pools = await fetchMeteoraStockPools({ maxPages: 13 });
    const map = stockMintMap(pools);
    saveStockMints(dataPath("."), map);
    app.meteoraStocks = { at: Date.now(), pools };
    let tagged = 0;
    for (const p of app.screen?.pools ?? []) {
      if (p.stock && p.stock.issuer !== "unknown") continue;
      const t = stockTagFromMap(map, p.baseMint);
      if (t) {
        p.stock = t;
        tagged++;
      }
    }
    const dl = pools.filter((p) => p.poolType === "dlmm" && p.issuer !== "unknown");
    console.log(`[cycle ${app.cycle}] meteora stocks: ${pools.length} stock pools (${dl.length} DLMM from known issuers, ${Object.keys(map).length} stock mints); ${tagged} board pool(s) newly tagged as stocks`);
  } catch (err) {
    console.error(`[cycle ${app.cycle}] meteora stocks: read failed, keeping the last answer: ${(err as Error).message}`);
  }
}

/** Discover the pinned stocks' Meteora pools: on start and every PINNED_REFRESH_MS; a failed refresh keeps the last answer. */
async function refreshPinned(app: App): Promise<void> {
  const tickers = pinnedTickers();
  if (!tickers.length) return;
  if (app.pinned && Date.now() - app.pinnedAt < PINNED_REFRESH_MS) return;
  try {
    app.pinned = await refreshPinnedStocks({
      tickers,
      mintOf: (ticker) => (app.screen?.pools ?? []).find((p) => p.stock?.ticker === ticker && p.stock.issuer === "xstocks")?.baseMint ?? null,
      readAccounts: async (addresses) => (await app.connection.getMultipleAccountsInfo(addresses.map((a) => new PublicKey(a)))).map((a) => (a ? a.data : null)),
    });
    app.pinnedAt = Date.now();
    for (const t of app.pinned.tickers) {
      console.log(`[cycle ${app.cycle}] pinned ${t.ticker}: ${t.pools.length ? t.pools.map((p) => `${p.symbol}/${p.quoteSymbol} ${p.address.slice(0, 6)} $${Math.round(p.liquidityUsd ?? 0).toLocaleString("en-US")} deep, $${Math.round(p.volume24hUsd ?? 0).toLocaleString("en-US")}/24h${p.feeToTvl24hPct !== null ? `, ${p.feeToTvl24hPct.toFixed(2)}%/day` : ""}`).join(" | ") : (t.note ?? "no Meteora pools")}`);
    }
  } catch (err) {
    console.error(`[cycle ${app.cycle}] pinned stocks: discovery failed, keeping the last answer: ${(err as Error).message}`);
  }
}

/** The book's bands as the rotation picker needs them: venue, age, value, fee pace, and whether they are pinned or the house pool. */
function rotationBands(app: App, held: string[]): RotationBand[] {
  const houseMints = pairEnv().houseMints;
  const venueOf = (pool: string): string | null =>
    app.screen?.pools.find((p) => p.address === pool)?.venue ?? app.pools.get(pool)?.venue.id ?? (isPairAddress(pool) || pinnedPoolAt(app.pinned, pool) ? "meteora-dlmm" : null);
  const flags = (pool: string) => ({
    pinned: pinnedTickerOf(app, pool) !== null || (isPairAddress(pool) && pinnedTickers().includes(app.paper?.pairPools?.[pool]?.stock?.ticker ?? loadState().pairPools?.[pool]?.stock?.ticker ?? "")),
    house: !!app.paper?.pairPools?.[pool]?.house || houseMints.includes(pairMintOf(pool) ?? ""),
  });
  if (app.paper) {
    const byPool = new Map<string, RotationBand>();
    const now = Date.now();
    for (const b of app.paper.bands) {
      if (!held.includes(b.pool)) continue;
      const value = b.lastMark?.valueInSol ?? b.entryValueSol;
      const ageDays = Math.max((now - b.openedAt) / 86_400_000, 1 / 288);
      const perDay = (b.lastMark?.feeSol ?? 0) / ageDays + (app.paper.feesClaimedByPool?.[b.pool] ?? 0) / ageDays;
      const prev = byPool.get(b.pool);
      byPool.set(b.pool, {
        pool: b.pool,
        label: b.label,
        venue: venueOf(b.pool),
        openedAt: prev?.openedAt !== undefined && prev.openedAt !== null ? Math.min(prev.openedAt, b.openedAt) : b.openedAt,
        valueSol: (prev?.valueSol ?? 0) + value,
        feesPerDaySol: (prev?.feesPerDaySol ?? 0) + perDay,
        ...flags(b.pool),
      });
    }
    return [...byPool.values()];
  }
  return held.map((pool) => ({ pool, label: pool.slice(0, 6), venue: venueOf(pool), openedAt: null, valueSol: 0, feesPerDaySol: null, ...flags(pool) }));
}

/**
 * Read a month of trading for the memecoin pools the picker could seat (src/screener/memeHistory.ts):
 * tradable, quoted in a fundable quote, trading enough, not a stock, past the memecoin floor, and not
 * read in the last MEME_HISTORY_TTL_HOURS. Best by fee yield first, a few a cycle, paced for GeckoTerminal.
 */
async function refreshMemeHistory(app: App, funds: Set<"SOL" | "USDC">): Promise<void> {
  const hist = memeHistoryEnv();
  if (hist.minDays <= 0 || hist.lookupsPerCycle <= 0) return;
  const meme = memeFloorEnv();
  const minVolume = Number(process.env.POLICY_MIN_VOLUME_24H_USD ?? 250_000);
  const now = Date.now();
  const quoteOk = (q: string) => (q === "SOL" && funds.has("SOL")) || (q === "USDC" && funds.has("USDC"));
  const wanted = new Map<string, { symbol: string; yieldPct: number }>();
  for (const p of app.screen?.pools ?? []) {
    if (p.stock || !tradableVenue(p) || !quoteOk(p.quoteSymbol) || (p.volume24hUsd ?? 0) < minVolume) continue;
    if (memeRefusal({ symbol: p.baseSymbol, marketCapUsd: p.mcapUsd ?? p.fdvUsd ?? null, ageHours: p.ageHours }, meme)) continue;
    wanted.set(p.address, { symbol: p.baseSymbol, yieldPct: p.feeToTvl24hPct ?? 0 });
  }
  for (const r of loadHotFileCached()?.rows ?? []) {
    if (r.stock || !isTradableVenue(r.venue) || !quoteOk(r.quoteSymbol) || (r.vol24hUsd ?? 0) < minVolume) continue;
    if (memeRefusal({ symbol: r.baseSymbol, marketCapUsd: r.marketCapUsd, ageHours: r.ageHours }, meme)) continue;
    if (!wanted.has(r.address)) wanted.set(r.address, { symbol: r.baseSymbol, yieldPct: r.feeToTvlDailyPct ?? 0 });
  }
  const due = [...wanted.entries()].filter(([a]) => !historyFresh(app.memeHistory.get(a), hist, now)).sort((a, b) => b[1].yieldPct - a[1].yieldPct).slice(0, hist.lookupsPerCycle);
  for (const [i, [address, w]] of due.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2500));
    const rec = await fetchPoolHistory(address, hist.minDays, { connection: app.connection, address: new PublicKey(address), minTxPerDay: hist.minTxPerDay, maxPages: hist.maxPages });
    app.memeHistory.set(address, rec);
    console.log(`[cycle ${app.cycle}] memecoin history ${w.symbol} (${address.slice(0, 6)}): ${rec.metrics ? historyPhrase(rec.metrics) : `unreadable (${rec.error})`}${rec.metrics && rec.metrics.days < hist.minDays ? `; under the ${hist.minDays} days the desk wants` : ""}`);
  }
}

/**
 * SEAT YIELD RANKING (src/screener/seatYield.ts): what a seat of our size would earn a day in each
 * Meteora stock candidate, from the bins around its price and the pool's fee flow (the scout's last
 * hour when it has one, else the day's figure). The lane seats by this, not by fee-on-TVL; a held
 * seat under the floor makes way for a candidate that clearly beats it. The candidates also go to
 * the scout (DATA_DIR/flow-watch.json) so the next ranking has their last hour too.
 */
async function rankMeteoraSeats(app: App, withPositions: string[], funds: Set<"SOL" | "USDC">): Promise<void> {
  app.seatRanking = null;
  app.seatRotation = null;
  const mEnv = meteoraStockEnv();
  const rEnv = seatRankingEnv();
  if (!mEnv.on || !app.meteoraStocks) return;
  const solPriceUsd = solPriceOf(app);
  const quoteOk = (q: string) => (q === "SOL" && funds.has("SOL")) || (q === "USDC" && funds.has("USDC"));
  const pEnv = policyEnv();
  const cover = Math.max(pEnv.stockCoverPct, pEnv.stockMinCoverPct);
  const candidates = meteoraStockCandidates(app.meteoraStocks.pools, mEnv, { minVolume24hUsd: pEnv.minVolume24hUsd, quoteOk }).slice(0, rEnv.rankTop);
  const heldLane = withPositions.filter((a) => meteoraStockAt(app, a) || pinnedPoolAt(app.pinned, a));
  const addresses = [...new Set([...candidates.map((c) => c.address), ...heldLane])];
  const state = loadState();
  const now = Date.now();
  const ranked: RankedSeat[] = [];
  const held: HeldSeat[] = [];
  const watch: FlowPoolMeta[] = [];
  for (const address of addresses) {
    const met = meteoraStockAt(app, address);
    try {
      const { venue, pool } = await getVenuePool(app, address);
      const snapshot = await venue.snapshot(pool, 10, { solPriceUsd });
      const q = quoteOf(snapshot);
      const flow = app.flow.get(address) ?? null;
      let poolFeesPerDayQuote: number | null = null;
      let feeSource: RankedSeat["feeSource"] = "24h";
      // a pool the scout reads ranks on what the scout saw, a quiet hour included (two swaps in an hour
      // is a quiet pool, not a reason to fall back to the venue's day figure: MRVL/SOL read 160%/day that way)
      // a pool the scout is still backfilling (no coverage yet) reads as unread: a partial hour is not a pace
      if (flow && flow.feesPerDayQuote240m !== null) {
        poolFeesPerDayQuote = flow.feesPerDayQuote240m;
        feeSource = "flow-4h";
      } else if (flow && flow.coveredMin !== null) {
        poolFeesPerDayQuote = flow.feesPerDayQuote60m ?? flow.fees60mQuote * 24;
        feeSource = "flow-60m";
      } else if (met?.fees24hUsd !== null && met?.fees24hUsd !== undefined && solPriceUsd) {
        poolFeesPerDayQuote = met.fees24hUsd / (q.priceInSol * solPriceUsd);
      }
      if (poolFeesPerDayQuote === null) continue;
      const bins = stockBinsPerSide(snapshot.binStep, cover, riskLimits.maxBinWidth, 1);
      const seatQuote = riskLimits.maxPositionSol / q.priceInSol;
      const y = seatYield({ seatQuote, binsEachSide: bins, activeBinId: snapshot.activeBinId, bins: snapshot.bins, quoteSide: q.side, tokenPriceInQuote: q.tokenPriceInQuote, poolFeesPerDayQuote });
      const label = snapshot.label;
      // the seat the policy could lay there: the max band, half the band's depth (its cap on somebody else's
      // pool), or twice the token liquidity a swap reaches inside POLICY_MAX_SWAP_IMPACT_PCT
      const impactCapQuote = pEnv.maxSwapImpactPct > 0 ? 2 * swapDepthWithin(snapshot.bins, snapshot.activeBinId, q.side, q.tokenPriceInQuote, snapshot.binStep, pEnv.maxSwapImpactPct) : Infinity;
      const capSol = Math.max(0, Math.min(riskLimits.maxPositionSol, (y.bandDepthQuote / 2) * q.priceInSol, impactCapQuote * q.priceInSol));
      watch.push({ address, label, quoteSide: q.side, quoteSymbol: q.symbol, xDecimals: snapshot.tokenX.decimals, yDecimals: snapshot.tokenY.decimals, band: null });
      if (withPositions.includes(address)) {
        held.push({ address, label, yieldPctPerDay: y.yieldPctPerDay, openedAt: state.lastMoveByPool?.[address] ?? null, pinned: pinnedTickerOf(app, address, snapshot) !== null, capSol, heldSol: null, feeSource });
      }
      if (met) ranked.push({ address, label, mint: met.mint, yieldPctPerDay: y.yieldPctPerDay, sharePct: y.sharePct, feesPerDayQuote: y.feesPerDayQuote, quoteSymbol: q.symbol, feeSource, capSol });
    } catch (err) {
      console.log(`[cycle ${app.cycle}] seat yield: ${met?.symbol ?? address.slice(0, 6)} unreadable (${(err as Error).message.slice(0, 80)})`);
    }
  }
  // a pool the ranking gave up sits out METEORA_STOCK_REENTRY_MIN: MRVL/SOL was closed at 0.08%/day and
  // wanted back four minutes later at 1.95% on two swaps (2026-09-17)
  const satOut = (a: string) => !withPositions.includes(a) && sittingOut(state.rotatedOutAt?.[a], rEnv, now);
  // while the scout runs, a candidate it has not read yet is watched, not seated: the venue's day figure
  // put MRVL/SOL at 139%/day on the seat during a scout backfill and the picker took it (2026-09-17)
  const unreadCandidate = (r: RankedSeat) => r.feeSource === "24h" && app.flow.size > 0 && !withPositions.includes(r.address);
  const worth = rankSeats(ranked.filter((r) => !satOut(r.address) && !unreadCandidate(r)), rEnv);
  app.seatRanking = { ranked: worth, held, at: now };
  if (ranked.length) {
    const all = [...ranked].sort((a, b) => b.yieldPctPerDay - a.yieldPctPerDay);
    console.log(`[cycle ${app.cycle}] seat yield (${riskLimits.maxPositionSol} SOL seat, floor ${rEnv.minYieldPct}%/day): ${all.map((r) => `${seatLine(r)}${withPositions.includes(r.address) ? " [held]" : ""}${r.yieldPctPerDay < rEnv.minYieldPct ? " [under the floor]" : ""}${satOut(r.address) ? ` [sat out, given up ${Math.round((now - (state.rotatedOutAt?.[r.address] ?? now)) / 60_000)} min ago]` : ""}${unreadCandidate(r) ? " [unread by the scout: watched, not seated]" : ""}`).join(" | ")}`);
  }
  // no seat is judged on the venue's day figure: while the scout has not read a held pool (it is
  // backfilling, or just restarted), nothing rotates and nothing consolidates
  const unread = held.filter((h) => h.feeSource === "24h");
  if (unread.length) {
    console.log(`[cycle ${app.cycle}] seat yield: the scout has not read ${unread.map((h) => h.label).join(", ")} yet; no rotation this cycle`);
    app.seatRanking = { ranked: worth, held: [], at: now };
    for (const w of watch) app.flowWatch.set(w.address, w);
    return;
  }
  const rot = weakSeatRotation(held, worth, rEnv, now);
  if (rot) {
    app.seatRotation = rot;
    console.log(`[cycle ${app.cycle}] seat yield: rotating out ${rot.label} (${rot.pool.slice(0, 6)}): ${rot.reason}`);
  }
  for (const w of watch) app.flowWatch.set(w.address, w);
}

/** The candidates go to the scout (DATA_DIR/flow-watch.json), so the next ranking has their reading too. */
function writeFlowWatch(watch: FlowPoolMeta[], now: number): void {
  try {
    const file = path.join(path.resolve(process.cwd(), config.dataDir), "flow-watch.json");
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ generatedAt: new Date(now).toISOString(), pools: watch }));
    fs.renameSync(tmp, file);
  } catch {
    /* the scout does without */
  }
}

/** The pinned ticker a pool belongs to: a pinned Meteora pool, or our own stock pair for a pinned ticker. */
function pinnedTickerOf(app: App, address: string, snapshot?: PoolSnapshot | null): string | null {
  const pool = pinnedPoolAt(app.pinned, address);
  if (pool) return pool.ticker;
  const t = snapshot?.pair?.stock?.ticker;
  return t && pinnedTickers().includes(t) ? t : null;
}

/** The seat the stock model sizes for, in SOL: the lane's cap or the max band, whichever binds first. */
const stockSeatSol = (): number => Math.min(pairStockSeatSol(riskLimits.maxTotalExposureSol, pairStockEnv()), riskLimits.maxPositionSol);

function pickPools(app: App, withPositions: string[], funds: Set<"SOL" | "USDC">): string[] {
  const set = new Set<string>([...config.pinnedPools, ...withPositions]);
  // One seat per base token. Two pools of the same token move together, so a second seat is
  // concentration, not diversification. Pools already holding a band keep their token's slot.
  const byAddress = new Map((app.screen?.pools ?? []).map((p) => [p.address, p] as const));
  const takenTokens = new Set<string>();
  for (const a of set) {
    // a made pair's key names its mint, and a pinned Meteora pool (off the board) carries its own: the token's seat is taken
    const t = byAddress.get(a)?.baseMint ?? pairMintOf(a) ?? pinnedPoolAt(app.pinned, a)?.mint ?? meteoraStockAt(app, a)?.mint;
    if (t) takenTokens.add(t);
  }
  const take = (address: string, baseMint: string | undefined): boolean => {
    if (baseMint && takenTokens.has(baseMint)) return false;
    set.add(address);
    if (baseMint) takenTokens.add(baseMint);
    return true;
  };
  // The pair lane keeps one seat of the book for itself while it holds no pool: a pump.fun token
  // that clears the lane must not find the book full of ordinary picks (there is no rotation yet).
  // Held and pinned pools are never evicted for it; the reserve only stops new ordinary seats.
  const penv = pairEnv();
  const laneBands = loadState().launchBands ?? {};
  const pairsHeld = new Set(Object.values(laneBands).map((b) => b.pool).filter(isPairAddress));
  const reserve = penv.on && penv.reserveSeat && pairsHeld.size < penv.maxPools ? 1 : 0;
  // The stock pair lane keeps PAIR_STOCK_RESERVE_SEATS while it holds fewer stock pools than that.
  const senv = pairStockEnv();
  const stockPairsHeld = withPositions.filter((a) => isStockPairKey(app, a));
  const stockReserve = pairStockReserve(senv, stockPairsHeld.length);
  const ordinaryCap = Math.max(set.size, config.maxActivePools - reserve - stockReserve);
  // The operator's list decides what the desk may put money into; the screener only finds it.
  // Pinned pools and pools already holding a band are added above, so a band can always be managed out.
  const watch = loadWatchlist();
  // The memecoin floor (src/screener/memeFloor.ts): not on launch, and a market cap worth making a market
  // in. Checked only on a token the lane would otherwise seat, so the log names what it actually kept out.
  const meme = memeFloorEnv();
  const memeRefused: string[] = [];
  const hist = memeHistoryEnv();
  // the floor, then the strict rule: a memecoin pool needs a month of its own trading on record
  const memeOk = (c: MemeCandidate, address: string): boolean => {
    const why = memeRefusal(c, meme) ?? (c.stock || c.house ? null : historyRefusal(c.symbol, app.memeHistory.get(address), hist, Date.now(), c.ageHours ?? null));
    if (why && !memeRefused.includes(why)) memeRefused.push(why);
    return why === null;
  };
  const hotMeme = (address: string): Pick<MemeCandidate, "marketCapUsd" | "ageHours" | "stock"> => {
    const r = loadHotFileCached()?.rows.find((x) => x.address === address);
    return { marketCapUsd: r?.marketCapUsd ?? null, ageHours: r?.ageHours ?? null, stock: r?.stock ?? null };
  };
  const minVolume = Number(process.env.POLICY_MIN_VOLUME_24H_USD ?? 250_000);
  const usdcOk = typeof app.screen?.solPriceUsd === "number" && app.screen.solPriceUsd > 0 && funds.has("USDC");
  const quoteOk = (q: string) => (q === "SOL" && funds.has("SOL")) || (q === "USDC" && usdcOk);
  if (funds.size === 0) console.log(`[cycle ${app.cycle}] the wallet cannot fund a seat at the minimum in SOL or USDC; only held and pinned pools are worked`);

  // THE HOUSE TOKEN (PAIR_HOUSE_MINTS): our own launch's pool, right after held and pinned pools, always,
  // whatever the hot watch says about it; only a watchlist DENY keeps it out. Never counted against PAIR_MAX_POOLS.
  if (penv.houseMints.length && set.size < config.maxActivePools) {
    const rows = pairCandidatesOf(loadHotFileCached()?.rows ?? [], penv.houseMints);
    for (const seat of pairHouseSeats(rows, {
      env: penv,
      freeSeats: config.maxActivePools - set.size,
      quoteOk,
      denied: (row) => watchlistDenial({ address: row.address, baseSymbol: row.baseSymbol, baseMint: row.baseMint, name: row.name }, watch),
      hasPool: (address) => set.has(address),
      hasToken: (mint) => takenTokens.has(mint),
    })) {
      if (!take(seat.address, seat.row.baseMint)) continue;
      console.log(
        `[cycle ${app.cycle}] pair lane: house token ${seat.row.baseSymbol} (${seat.row.baseMint.slice(0, 6)}): ${seat.verdict.note ?? "always seated"}; making ${seat.row.baseSymbol}/${penv.quote}` +
          `${seat.row.address ? ` from its ${seat.row.venue} pool ${seat.row.address.slice(0, 6)} ($${Math.round(seat.row.liquidityUsd ?? 0).toLocaleString("en-US")} liquidity, $${Math.round(seat.row.vol24hUsd ?? 0).toLocaleString("en-US")} in 24h)` : " with no reference pool yet (the model reads n/a until one exists)"}; ` +
          `seat ${pairHouseSeatSol(riskLimits.maxTotalExposureSol, penv).toFixed(4)} SOL, ${penv.binStep / 100}%/bin; the ordinary ${riskLimits.stopLossPct}% stop, no maximum hold, no fade exit`,
      );
    }
  }

  // THE STOCKS THE AGENT IS PAIRED WITH (PAIR_STOCK_PINNED_TICKERS), Meteora only: the ticker's existing
  // Meteora DLMM pool the wallet can fund, best by fee/TVL, supplemented with our liquidity. A ticker
  // Meteora has no such pool for falls through to the stock pair lane below, which makes our own.
  app.rotateOut = app.seatRotation; // a weak seat the yield ranking gives up this cycle, else null
  // THE OPERATOR'S EXIT LIST (ROTATE_OUT_POOLS, comma-separated pool addresses): a held band on the list
  // comes off through the ROTATE directive (closed and liquidated through the guards), one per cycle.
  // Zach (2026-09-17): "lets just enter memecoin style pools", with two stock seats to move out of.
  const exitList = (process.env.ROTATE_OUT_POOLS ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  const exiting = exitList.find((a) => withPositions.includes(a));
  if (exiting && !app.rotateOut) {
    app.rotateOut = { pool: exiting, label: app.screen?.pools.find((p) => p.address === exiting)?.name ?? exiting.slice(0, 6), reason: "on the operator's exit list (ROTATE_OUT_POOLS): the book moves on" };
    console.log(`[cycle ${app.cycle}] exit list: rotating out ${app.rotateOut.label} (${exiting.slice(0, 6)})`);
  }
  for (const ticker of pinnedTickers()) {
    const entry = app.pinned?.tickers.find((t) => t.ticker === ticker);
    // already seated in one of its Meteora pools: nothing to find
    if ([...set].some((a) => pinnedPoolAt(app.pinned, a)?.ticker === ticker)) continue;
    const pool = choosePinnedPool(entry, (q) => quoteOk(q));
    if (!pool) {
      console.log(`[cycle ${app.cycle}] pinned ${ticker}: ${entry?.note ?? (entry ? "no Meteora pool the wallet can fund" : "not discovered yet")}; ${pairStockEnv().on ? `the stock pair lane makes our own ${ticker}x/SOL pool` : "the stock pair lane is off, so it waits"}`);
      continue;
    }
    // held already: this pool, or another pool of the same token (one seat per token)
    const tokenHeld = takenTokens.has(pool.mint) || [...set].some((a) => pinnedPoolAt(app.pinned, a)?.ticker === ticker);
    const action = pinSeatAction({ poolHeld: set.has(pool.address), tokenHeld, bookFull: set.size >= config.maxActivePools });
    if (action === "held") continue;
    if (watchlistDenial({ address: pool.address, baseSymbol: pool.symbol, baseMint: pool.mint, name: `${pool.symbol} / ${pool.quoteSymbol}` }, watch)) continue;
    if (action === "rotate") {
      // the book is full and there is no general rotation: one band makes room for the pin, one per cycle
      if (!app.rotateOut) {
        const pick = rotationCandidate(rotationBands(app, [...set]), { now: Date.now(), tradable: (v) => isTradableVenue(v), minAgeMin: pinRotateMinAgeMin(), forTicker: ticker });
        app.rotateOut = pick;
        console.log(`[cycle ${app.cycle}] pinned ${ticker}: the book is full (${set.size}/${config.maxActivePools}); ${pick ? `rotating out ${pick.label} (${pick.pool.slice(0, 6)}): ${pick.reason}` : "nothing may rotate out (every band is pinned, the house pool, or under the minimum age)"}`);
      }
      continue;
    }
    if (!take(pool.address, pool.mint)) continue;
    console.log(
      `[cycle ${app.cycle}] pinned ${ticker}: supplementing Meteora DLMM ${pool.symbol}/${pool.quoteSymbol} (${pool.address.slice(0, 6)}), ` +
        `${pool.binStep !== null ? `${pool.binStep / 100}%/bin, ` : ""}${pool.baseFeePct !== null ? `${pool.baseFeePct}% fee, ` : ""}$${Math.round(pool.liquidityUsd ?? 0).toLocaleString("en-US")} deep, $${Math.round(pool.volume24hUsd ?? 0).toLocaleString("en-US")} in 24h` +
        `${pool.feeToTvl24hPct !== null ? ` (${pool.feeToTvl24hPct.toFixed(2)}% of its depth in fees a day)` : ""}; worked as a straddle, floors waived by the pin`,
    );
  }

  // METEORA'S TOKENIZED STOCKS (src/screener/meteoraStocks.ts): the busiest real Meteora DLMM stock pools,
  // best fee/TVL first, one per ticker, up to METEORA_STOCK_MAX_POOLS counting the ones held. The volume
  // floor is the policy's own, so the picker never seats a pool the policy would pass on for volume.
  const mEnv = meteoraStockEnv();
  if (mEnv.on && app.meteoraStocks) {
    let room = mEnv.maxPools - [...set].filter((a) => meteoraStockAt(app, a)).length;
    // by what our seat would earn (rankMeteoraSeats), best first, only those over the floor; the
    // fee-on-TVL order stands in when nothing could be ranked this cycle
    const byYield = app.seatRanking ? app.seatRanking.ranked.map((r) => meteoraStockAt(app, r.address)).filter((p): p is MeteoraStockPool => !!p) : null;
    const lane = byYield && (byYield.length || app.seatRanking?.ranked) ? byYield : meteoraStockCandidates(app.meteoraStocks.pools, mEnv, { minVolume24hUsd: policyEnv().minVolume24hUsd, quoteOk });
    for (const p of lane) {
      if (room <= 0 || set.size >= config.maxActivePools) break;
      if (set.has(p.address) || takenTokens.has(p.mint)) continue;
      if (watchlistDenial({ address: p.address, baseSymbol: p.symbol, baseMint: p.mint, name: `${p.symbol} / ${p.quoteSymbol}` }, watch)) continue;
      if (!take(p.address, p.mint)) continue;
      room--;
      console.log(
        `[cycle ${app.cycle}] meteora stocks: ${p.symbol}/${p.quoteSymbol} (${p.ticker}, ${p.issuer}, ${p.address.slice(0, 6)}), ${p.binStep !== null ? `${p.binStep / 100}%/bin, ` : ""}${p.feePct ?? "?"}% fee, ` +
          `$${Math.round(p.tvlUsd ?? 0).toLocaleString("en-US")} deep, $${Math.round(p.volume24hUsd ?? 0).toLocaleString("en-US")} in 24h, ${(p.feeToTvl24hPct ?? 0).toFixed(2)}% of its depth in fees a day`,
      );
    }
  }

  // The STOCK PAIR lane, FIRST after held and pinned pools (it is the focus): for each tokenized stock
  // the lane admits, a STOCKx/SOL pool of OUR OWN (key pair-<mint>), best by the stock routing model
  // first, up to PAIR_STOCK_MAX_POOLS counting the ones held, one per ticker. Other pools never refuse
  // it; the existing SOL-quoted ones only split the routed flow with us as competing depth.
  if (senv.on && set.size < config.maxActivePools) {
    const px = solPriceOf(app);
    const seatUsd = px ? stockSeatSol() * px : 0;
    const seats = pairStockSeats(stockCandidatesOf(app), {
      env: senv,
      freeSeats: config.maxActivePools - set.size,
      poolsTaken: stockPairsHeld.length,
      quoteOk: () => quoteOk("SOL"),
      denied: (c) => watchlistDenial({ address: c.reference.address, baseSymbol: c.symbol, baseMint: c.mint, name: c.name }, watch),
      hasPool: (address) => set.has(address),
      hasToken: (mint) => takenTokens.has(mint),
      // best first by the model at this seat with the fee it would pick; a ticker the model routes nothing to is skipped
      worth: (c) => {
        if (!(seatUsd > 0)) return c.vol24hUsd ?? 0;
        const ref = { liquidityUsd: c.refLiquidityUsd, vol24hUsd: c.vol24hUsd, vol1hUsd: c.vol1hUsd, refFeePct: c.refFeePct, refQuoteIsSol: c.refQuoteIsSol };
        const bins = stockPairBinsPerSide(app, senv.binStep, pairPoolAddress(c.mint));
        return stockPairModel(ref, senv, seatUsd, bins, c.competingDepthUsd, { feeBps: chooseStockFeeBps(ref, senv, seatUsd, bins) }).feesPerDayUsd;
      },
    });
    if (seats.length === 0 && !quoteOk("SOL")) {
      const clears = stockCandidatesOf(app).filter((c) => pairStockSeats([c], { env: senv, freeSeats: 1, quoteOk: () => true }).length > 0);
      if (clears.length) console.log(`[cycle ${app.cycle}] stock pair lane: ${clears.map((c) => c.ticker).join(", ")} clear${clears.length === 1 ? "s" : ""} the lane, but the wallet cannot fund a SOL seat at the minimum`);
    }
    for (const seat of seats) {
      if (!take(seat.address, seat.candidate.mint)) continue;
      const c = seat.candidate;
      const v = seat.verdict;
      console.log(
        `[cycle ${app.cycle}] stock pair lane: making ${c.symbol}/SOL for ${c.ticker} (${c.issuer}); reference ${c.reference.venue} ${c.symbol}/${c.reference.quoteSymbol} (${c.reference.address.slice(0, 6)}) with $${Math.round(v.refLiquidityUsd).toLocaleString("en-US")} of liquidity at ${v.refFeePct}% fee, ` +
          `$${Math.round(v.vol24hUsd).toLocaleString("en-US")} traded in 24h across ${c.pools.length} pool(s)${c.vol1hUsd !== null ? `, $${Math.round(c.vol1hUsd).toLocaleString("en-US")} in the last hour` : ""}` +
          `${v.competingDepthUsd > 0 ? `, $${Math.round(v.competingDepthUsd).toLocaleString("en-US")} of competing SOL-quoted depth in ${v.competitors.length} pool(s)` : ""}; ` +
          `seat ${stockSeatSol().toFixed(4)} SOL as a straddle, ${senv.binStep / 100}%/bin, fee ${senv.feeBpsFixed ? `${senv.feeBps / 100}%` : `the best of ${senv.feeMenuBps.map((f) => `${f / 100}%`).join("/")} by the model`}${seat.worthUsdPerDay !== null ? `, about $${seat.worthUsdPerDay.toFixed(2)}/day by the model` : ""}; the ordinary ${riskLimits.stopLossPct}% stop, no maximum hold`,
      );
    }
  }
  // The stock book: tokenized stocks first, by fee/TVL, then the rest of the picker.
  if (bookEnv() === "stocks") {
    for (const p of stockBookPools(app.screen?.pools ?? [], usdcOk)) {
      if (set.size >= ordinaryCap) break;
      if (quoteOk(p.quoteSymbol) && watchlistRefusal(p, watch) === null) take(p.address, p.baseMint);
    }
  }
  // Surges first: what the fast watch found in the last hour, already filtered for liquidity, age and dumping.
  for (const r of hotRows(app)) {
    if (set.size >= ordinaryCap) break;
    const row = { address: r.address, baseSymbol: r.baseSymbol, baseMint: r.baseMint, name: r.name };
    if (r.stock && !verifiedStock(r.stock)) continue;
    if (quoteOk(r.quoteSymbol) && watchlistRefusal(row, watch) === null && (r.vol24hUsd ?? 0) >= minVolume && !takenTokens.has(r.baseMint) && memeOk({ symbol: r.baseSymbol, marketCapUsd: r.marketCapUsd, ageHours: r.ageHours, stock: r.stock }, r.address)) take(r.address, r.baseMint);
  }
  const candidates = (app.screen?.pools ?? []).filter(
    (p) =>
      tradableVenue(p) &&
      quoteOk(p.quoteSymbol) &&
      watchlistRefusal(p, watch) === null &&
      (p.volume24hUsd ?? 0) >= minVolume &&
      p.score >= Math.max(1e-9, policyEnv().minScore) &&
      !p.flags.includes("thin") &&
      !p.flags.includes("no-24h-data"),
  );
  // Rank what is left by the money: fees earned per dollar of liquidity in the last 24h, which is what
  // a seat here is paid. The score still decides who qualifies (it brakes thin, new, wild and one-sided
  // pools), at the POLICY's floor: a pick the policy refuses on score wastes the seat for the cycle
  // (pill/SOL and EMBER/SOL, score 4.7 and 5.6 against a floor of 20, were picked and refused three
  // cycles running on 2026-09-17); this decides the order among those that qualify.
  const byYield = [...candidates].sort((a, b) => (b.feeToTvl24hPct ?? -1) - (a.feeToTvl24hPct ?? -1) || b.score - a.score);
  for (const p of byYield) {
    if (set.size >= ordinaryCap) break;
    if (takenTokens.has(p.baseMint) || set.has(p.address)) continue;
    if (p.stock && !verifiedStock(p.stock)) continue;
    if (!memeOk({ symbol: p.baseSymbol, marketCapUsd: p.mcapUsd ?? p.fdvUsd ?? null, ageHours: p.ageHours, stock: p.stock }, p.address)) continue;
    take(p.address, p.baseMint);
  }

  // The launch lane, LAST: every ordinary pick has had its chance at the book first. A pool here is
  // admitted by rule rather than by name, so the watchlist's ALLOW mode cannot block it (nobody can
  // list a token that did not exist yesterday) but an explicit DENY still wins.
  const lenv = launchEnv();
  if (lenv.on && set.size < ordinaryCap) {
    const held = laneBands;
    const heldPools = new Set(Object.values(held).map((b) => b.pool).filter((p) => !isPairAddress(p)));
    const launchOpts = {
      env: lenv,
      freeSeats: ordinaryCap - set.size,
      seatsTaken: heldPools.size,
      tradable: (v: string) => isTradableVenue(v),
      quoteOk,
      denied: (row: LaunchCandidate) => watchlistDenial(row, watch),
      hasPool: (address: string) => set.has(address),
      hasToken: (mint: string) => takenTokens.has(mint),
    };
    let launchRows = launchCandidates();
    let seats = launchSeats(launchRows, launchOpts);
    for (let pass = 0; pass < 8; pass++) {
      const kept = seats.filter((s) => memeOk({ symbol: s.row.baseSymbol, ...hotMeme(s.row.address) }, s.row.address));
      if (kept.length === seats.length) break;
      const drop = new Set(seats.filter((s) => !kept.includes(s)).map((s) => s.row.address));
      launchRows = launchRows.filter((r) => !drop.has(r.address));
      seats = launchSeats(launchRows, launchOpts);
    }
    for (const seat of seats) {
      if (!take(seat.row.address, seat.row.baseMint)) continue;
      console.log(
        `[cycle ${app.cycle}] launch lane: seating ${seat.row.name} (${seat.row.venue}), ${seat.verdict.ageHours.toFixed(1)}h old, ` +
          `$${Math.round(seat.row.liquidityUsd ?? 0).toLocaleString("en-US")} liquidity, $${Math.round(seat.row.vol24hUsd ?? 0).toLocaleString("en-US")} in 24h ` +
          `(turnover ${seat.verdict.turnover.toFixed(1)}x), $${Math.round(seat.row.vol1hUsd ?? 0).toLocaleString("en-US")} in the last hour; ` +
          `capped at ${((riskLimits.maxTotalExposureSol * lenv.seatPct) / 100).toFixed(4)} SOL, stop ${lenv.stopPct}%, max hold ${lenv.maxHoldMin} min`,
      );
    }
  }

  // The pair lane, LAST of all: a pump.fun token that clears the lane on its PumpSwap reference pool
  // gets a pool of OUR OWN (key pair-<mint>), one at a time, after every other lane has had its chance.
  // Other pools never refuse it; they only feed the routing model as competing depth.
  if (penv.on && set.size < config.maxActivePools) {
    const hot = loadHotFileCached();
    const rows = hot?.rows ?? [];
    const screenRows = (app.screen?.pools ?? []).map((p) => ({ address: p.address, venue: p.venue, baseMint: p.baseMint, quoteSymbol: p.quoteSymbol, liquidityUsd: p.tvlUsd }));
    let pairRows = pairCandidatesOf(rows, penv.houseMints).filter((r) => !penv.houseMints.includes(r.baseMint));
    const pairOpts: PairSeatOptions = {
      env: penv,
      freeSeats: config.maxActivePools - set.size,
      poolsTaken: pairsHeld.size,
      quoteOk,
      denied: (row) => watchlistDenial({ address: row.address, baseSymbol: row.baseSymbol, baseMint: row.baseMint, name: row.name }, watch),
      hasPool: (address) => set.has(address),
      hasToken: (mint) => takenTokens.has(mint),
      competition: (mint) => competitionFor(mint, [...rows, ...screenRows], pairPoolAddress(mint)),
      // best first by the routing model at this seat, with the fee it would pick; a token the model
      // routes nothing to does not take the lane's only seat
      worth: (row) => {
        const px = solPriceOf(app);
        const seatUsd = px ? Math.min(pairSeatSol(riskLimits.maxTotalExposureSol, penv), riskLimits.maxPositionSol) * px : 0;
        if (!(seatUsd > 0)) return row.vol1hUsd ?? 0;
        const ref = { liquidityUsd: row.liquidityUsd, vol24hUsd: row.vol24hUsd, vol1hUsd: row.vol1hUsd };
        const comp = competitionFor(row.baseMint, [...rows, ...screenRows], pairPoolAddress(row.baseMint));
        return pairModel(ref, { ...penv, feeBps: chooseFeeBps(ref, penv, seatUsd) }, seatUsd, comp?.depthUsd ?? 0).feesPerDayUsd;
      },
    };
    let seats = pairSeats(pairRows, pairOpts);
    for (let pass = 0; pass < 8; pass++) {
      const kept = seats.filter((s) => memeOk({ symbol: s.row.baseSymbol, ...hotMeme(s.row.address) }, s.row.address));
      if (kept.length === seats.length) break;
      const drop = new Set(seats.filter((s) => !kept.includes(s)).map((s) => s.row.baseMint));
      pairRows = pairRows.filter((r) => !drop.has(r.baseMint));
      seats = pairSeats(pairRows, pairOpts);
    }
    if (seats.length === 0 && !quoteOk(penv.quote)) {
      const clears = pairCandidatesOf(rows).filter((r) => r.baseMint && pairVerdict(r, penv, competitionFor(r.baseMint, [...rows, ...screenRows], pairPoolAddress(r.baseMint))).ok);
      if (clears.length) {
        console.log(`[cycle ${app.cycle}] pair lane: ${[...new Set(clears.map((r) => r.baseSymbol))].join(", ")} clear${clears.length === 1 ? "s" : ""} the lane, but the wallet cannot fund a ${penv.quote} seat at the minimum (free some ${penv.quote}, or set PAIR_QUOTE to the other quote)`);
      }
    }
    for (const seat of seats) {
      if (!take(seat.address, seat.row.baseMint)) continue;
      const v = seat.verdict;
      console.log(
        `[cycle ${app.cycle}] pair lane: making ${seat.row.baseSymbol}/${penv.quote} for ${seat.row.name} on ${seat.row.venue} (${seat.row.address.slice(0, 6)}), ${v.ageHours.toFixed(1)}h old, ` +
          `$${Math.round(v.refLiquidityUsd).toLocaleString("en-US")} reference liquidity, $${Math.round(seat.row.vol24hUsd ?? 0).toLocaleString("en-US")} in 24h (turnover ${v.turnover.toFixed(1)}x), ` +
          `$${Math.round(seat.row.vol1hUsd ?? 0).toLocaleString("en-US")} in the last hour${v.competingDepthUsd > 0 ? `, $${Math.round(v.competingDepthUsd).toLocaleString("en-US")} of competing concentrated depth in ${v.competitors.length} pool(s)` : ""}; ` +
          `seat ${pairSeatSol(riskLimits.maxTotalExposureSol, penv).toFixed(4)} SOL, ${penv.binStep / 100}%/bin, fee ${penv.feeBpsFixed ? `${penv.feeBps / 100}%` : `the best of ${penv.feeMenuBps.map((f) => `${f / 100}%`).join("/")} by the model`}, stop ${penv.stopPct}%, max hold ${penv.maxHoldMin} min`,
      );
    }
  }
  const floorLine = memeFloorLine(memeRefused, meme);
  if (floorLine) console.log(`[cycle ${app.cycle}] ${floorLine}`);
  return [...set];
}

/** The venue and pool handle for an address, loaded once: the screen's venue when the pool is on the board, else the account owner. */
async function getVenuePool(app: App, address: string): Promise<{ venue: Venue; pool: VenuePool }> {
  let vp = app.pools.get(address);
  if (!vp) {
    if (isPairAddress(address)) {
      // a made pair: the pair venue, which derives the real pool and finds it on chain when it exists
      vp = { venue: app.pairVenue, pool: await app.pairVenue.loadPool(app.connection, address) };
    } else {
      const hint: VenueId | undefined = app.screen?.pools.find((p) => p.address === address)?.venue;
      vp = await loadVenuePool(app.connection, address, hint);
    }
    app.pools.set(address, vp);
  }
  return vp;
}

/** The fast watch's hot list as the observation shows it: every venue, launch rows included. */
const hotContext = (address: string): NonNullable<ScreenContext["hot"]> =>
  hotPicks(loadHot(), { tradable: () => true, max: 8, launch: launchEnv() }).map((r) => ({
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
  }));

/**
 * The context for a LAUNCH pool the screener's board does not carry: a pool a couple of hours old is
 * usually too young to rank, so the fast watch's row is the only numbers there are. rank 0 means
 * "off the board"; the score stays 0 because nothing has scored it, and the launch verdict is what
 * admits it. feeToTvl24hPct is null, so the policy's yield and payback tests abstain rather than
 * refuse -- an unknown is not a refusal, as everywhere else on the desk.
 */
function launchContext(app: App, address: string, row: HotRow, launch: { ok: true; ageHours: number; turnover: number }, s: ScreenResult, state?: RiskState): ScreenContext {
  return {
    rank: 0,
    rankedPools: s.rankedPools,
    score: 0,
    feeToTvl24hPct: null,
    volume24hUsd: row.vol24hUsd,
    tvlUsd: row.liquidityUsd,
    ageHours: row.ageHours,
    priceChange24hPct: row.priceChange24hPct,
    flags: row.flags,
    watchlisted: false,
    launch,
    recentMovePct: rangeOverWindowPct(state?.priceHistory?.[address], Date.now()),
    generatedAt: s.generatedAt,
    stock: null,
    alternatives: [],
    hot: hotContext(address),
  };
}

/**
 * The context for a PAIR pool: our own pool for a pump.fun token, off every board. The reference
 * PumpSwap row's figures stand in for the pool's, and `pair` says the lane admitted it and on what.
 * A pool holding a band stays a pair pool whether or not the reference still clears the lane: the
 * exits are the engine's, and the policy must keep managing the band.
 */
function pairContext(app: App, address: string, snapshot: PoolSnapshot, s: ScreenResult, state?: RiskState): ScreenContext {
  const info = snapshot.pair;
  if (info?.stock) {
    // a STOCK pair: the reference is a board row; the context is a stock pool's (the straddle path) AND a pair's (our own pool)
    const c = pairStockCandidateFor(stockCandidatesOf(app), info.mint);
    const ref = c?.reference;
    const turnover = c && c.vol24hUsd !== null && c.refLiquidityUsd ? Math.round((c.vol24hUsd / c.refLiquidityUsd) * 100) / 100 : 0;
    return {
      rank: 0,
      rankedPools: s.rankedPools,
      score: 0,
      feeToTvl24hPct: null,
      volume24hUsd: info.refVol24hUsd ?? c?.vol24hUsd ?? null,
      tvlUsd: info.refLiquidityUsd ?? c?.refLiquidityUsd ?? null,
      ageHours: ref?.ageHours ?? info.refAgeHours ?? null,
      priceChange24hPct: ref?.priceChange24hPct ?? null,
      flags: [],
      watchlisted: false,
      launch: null,
      pair: { ok: true, ageHours: ref?.ageHours ?? info.refAgeHours ?? 0, turnover },
      recentMovePct: rangeOverWindowPct(state?.priceHistory?.[address], Date.now()),
      generatedAt: s.generatedAt,
      stock: { ticker: info.stock.ticker, issuer: info.stock.issuer },
      // our own pool for a stock the agent is paired with: the pin waives the floors
      pinned: pinnedTickers().includes(info.stock.ticker) ? { ok: true, ticker: info.stock.ticker } : null,
      alternatives: [],
      hot: hotContext(address),
    };
  }
  const row = hotRowForPool(loadHotFileCached(), address);
  const verdict = row ? pairVerdict(pairCandidatesOf([row])[0] ?? { ...row, origin: row.origin }, pairEnv(), null) : null;
  const ageHours = verdict?.ok ? verdict.ageHours : (info?.refAgeHours ?? row?.ageHours ?? 0);
  const turnover = verdict?.ok ? verdict.turnover : row && row.vol24hUsd !== null && row.liquidityUsd ? Math.round((row.vol24hUsd / row.liquidityUsd) * 100) / 100 : 0;
  return {
    rank: 0,
    rankedPools: s.rankedPools,
    score: 0,
    feeToTvl24hPct: null,
    volume24hUsd: info?.refVol24hUsd ?? row?.vol24hUsd ?? null,
    tvlUsd: info?.refLiquidityUsd ?? row?.liquidityUsd ?? null,
    ageHours,
    priceChange24hPct: row?.priceChange24hPct ?? null,
    flags: row?.flags ?? [],
    watchlisted: false,
    launch: null,
    pair: { ok: true, ageHours, turnover },
    recentMovePct: rangeOverWindowPct(state?.priceHistory?.[address], Date.now()),
    generatedAt: s.generatedAt,
    stock: null,
    alternatives: [],
    hot: hotContext(address),
  };
}

function screenContext(app: App, address: string, state?: RiskState, snapshot?: PoolSnapshot): ScreenContext | null {
  const s = app.screen;
  if (!s) return null;
  if (snapshot?.pair) return pairContext(app, address, snapshot, s, state);
  const launch = launchOf(hotRowOf(address));
  const p = s.pools.find((x) => x.address === address);
  const pin = pinnedPoolAt(app.pinned, address);
  const met = meteoraStockAt(app, address);
  if (!p && !pin && met) {
    // a Meteora stock pool the board does not carry: Meteora's own numbers
    return {
      rank: 0,
      rankedPools: s.rankedPools,
      score: 0,
      feeToTvl24hPct: met.feeToTvl24hPct,
      volume24hUsd: met.volume24hUsd,
      tvlUsd: met.tvlUsd,
      ageHours: met.createdAt ? (Date.now() - met.createdAt) / 3_600_000 : null,
      priceChange24hPct: null,
      flags: [],
      watchlisted: false,
      launch: null,
      recentMovePct: rangeOverWindowPct(state?.priceHistory?.[address], Date.now()),
      generatedAt: new Date(app.meteoraStocks!.at).toISOString(),
      stock: { ticker: met.ticker, issuer: met.issuer },
      pinned: null,
      alternatives: [],
      hot: hotContext(address),
    };
  }
  if (!p && pin) {
    // a Meteora pool of a stock the agent is paired with, too thin for the board: its own numbers, the pin
    return {
      rank: 0,
      rankedPools: s.rankedPools,
      score: 0,
      feeToTvl24hPct: pin.feeToTvl24hPct,
      volume24hUsd: pin.volume24hUsd,
      tvlUsd: pin.liquidityUsd,
      ageHours: null,
      priceChange24hPct: null,
      flags: [],
      watchlisted: false,
      launch: null,
      recentMovePct: rangeOverWindowPct(state?.priceHistory?.[address], Date.now()),
      generatedAt: app.pinned!.generatedAt,
      stock: { ticker: pin.ticker, issuer: "xstocks" },
      pinned: { ok: true, ticker: pin.ticker },
      alternatives: [],
      hot: hotContext(address),
    };
  }
  if (!p) return launch ? launchContext(app, address, hotRowOf(address)!, launch, s, state) : null;
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
    watchlisted: watchlistRefusal(p, loadWatchlist()) === null && loadWatchlist().mode === "allow",
    launch,
    // Measured from our own samples first (the loop records the active price every cycle), then the
    // screener's walk over its sample window. Either is the pool's real movement; the 24h figure is not.
    recentMovePct: rangeOverWindowPct(state?.priceHistory?.[address], Date.now()) ?? p.binRangePct ?? null,
    generatedAt: s.generatedAt,
    stock: p.stock ? { ticker: p.stock.ticker, issuer: p.stock.issuer } : null,
    pinned: pin ? { ok: true, ticker: pin.ticker } : null,
    alternatives: s.pools
      .filter((x) => x.address !== address && tradableVenue(x) && (x.quoteSymbol === "SOL" || (x.quoteSymbol === "USDC" && solPriceOf(app) !== null)))
      .slice(0, 5)
      .map((x) => ({ name: x.name, score: x.score, feeToTvl24hPct: x.feeToTvl24hPct, tvlUsd: x.tvlUsd })),
    hot: hotContext(address),
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
  const pinned = pinnedPoolAt(app.pinned, address);
  if (pinned) return { fees24hUsd: pinned.fees24hUsd, volume24hUsd: pinned.volume24hUsd };
  const met = meteoraStockAt(app, address);
  if (met) return { fees24hUsd: met.fees24hUsd, volume24hUsd: met.volume24hUsd };
  const hot = loadHot()?.rows.find((r) => r.address === address);
  if (hot) return { fees24hUsd: null, volume24hUsd: hot.vol24hUsd };
  return null;
}

/**
 * `launch` marks a band opened through the launch lane: its stop is rolled tighter (LAUNCH_STOP_PCT
 * in place of STOP_LOSS_PCT, same jitter, same place on disk) and its opening mark is recorded in
 * state.launchBands, which is what the EXPIRE directive reads for the maximum hold and the
 * volume-fade exit, and what the picker counts against LAUNCH_MAX_SEATS.
 */
function updateState(state: RiskState, exec: ExecutionResult, positions: PositionSnapshot[], snapshot: PoolSnapshot, launch?: { env: LaunchEnv; vol1hUsd: number | null } | null): void {
  state.lastPrice = snapshot.activePrice;
  for (const p of positions) {
    if (!(p.address in state.entryValueSol)) state.entryValueSol[p.address] = p.entryValueSol ?? p.valueInSol;
  }
  if (exec.txs.length > 0) {
    state.actionsToday += 1;
    state.lastActionAt = Date.now();
    // Band moves start this pool's cooldown; a fee claim does not.
    // a move that landed, and a move that was SENT and failed: both start the per-pool cooldown, so a
    // failing open is not re-sent every cycle until the daily cap (fees are paid either way)
    if (exec.opened || exec.closed || exec.txs.some((t) => !t.ok)) (state.lastMoveByPool ??= {})[snapshot.address] = Date.now();
  }
  if (exec.ok && exec.opened) {
    state.entryValueSol[exec.opened.address] = exec.opened.entryValueSol;
    (state.stops ??= {})[exec.opened.address] = rollStop(riskLimits, Math.random, launch ? launch.env.stopPct : null);
    if (launch) (state.launchBands ??= {})[exec.opened.address] = { pool: snapshot.address, openedAt: Date.now(), vol1hUsd: launch.vol1hUsd };
  }
  if (exec.ok && exec.closed) forgetBand(state, exec.closed);
  // a made pair's pool landed on chain: remember it is ours, and which real address the alias stands for
  if (exec.created && snapshot.pair) {
    (state.pairPools ??= {})[exec.created.pool] = {
      lbPair: exec.created.lbPair,
      mint: snapshot.pair.mint,
      symbol: snapshot.pair.symbol,
      ...(snapshot.pair.stock ? { stock: snapshot.pair.stock } : {}),
      quote: snapshot.pair.quote,
      binStep: snapshot.binStep,
      feeBps: Math.round(snapshot.baseFeePct * 100),
      createdAt: Date.now(),
      rentSol: exec.created.rentSol,
      refPool: snapshot.pair.refPool,
      refVenue: snapshot.pair.refVenue,
      sig: exec.created.sig,
    };
  }
  saveState(state);
}

/** What the journal calls this run: a paper book says so, a dry run says so, and only DRY_RUN=false says live. */
const journalMode = (app: App): JournalEntry["mode"] => (app.paper ? "paper" : config.dryRun ? "dry-run" : "live");

/** The out-of-range wait when the cost-based threshold has nothing to work with (src/engine/exit.ts moveAfterSec). */
const OUT_OF_RANGE_FALLBACK_SEC = 600;

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
  // The other pools' bands as observed at the start of the cycle, plus what the pools decided before
  // this one opened or closed since (app.exposureDelta): with one band allowed the whole stake, two
  // opens in a pass sized from the cycle-start read would each take it.
  const movedSol = [...app.exposureDelta].filter(([a]) => a !== o.address).reduce((t, [, d]) => t + d, 0);
  const portfolio = {
    activePools: all.map((x) => x.snapshot.label),
    poolsWithBands: others.filter((x) => x.positions.length > 0).length,
    maxActivePools: config.maxActivePools,
    otherExposureSol: Math.max(0, others.reduce((s, x) => s + x.positions.reduce((t, p) => t + p.valueInSol, 0), 0) + movedSol),
  };
  const screen = screenContext(app, o.address, state, snapshot);
  // the flow scout's last hour for this pool, when its file is fresh (src/scouts/flow.ts)
  // the scout's reading, once it covers the pool (a backfill in progress is not a reading)
  const flow = app.flow.get(o.address) ?? null;
  if (screen && flow && flow.coveredMin !== null) screen.flow = flow;
  if (flow) console.log(`[cycle ${app.cycle} ${snapshot.label}] ${flowContextLine(flow)}${flow.coveredMin === null ? " (backfilling: not a reading yet)" : ""}`);
  const isPair = !!snapshot.pair;

  // The engine's view of this pool: breakers, bench, regime, knife, collects.
  // The launch lane's view of this pool: its settings and what the last hour is trading right now.
  // Present whenever the lane is on, because the EXPIRE directive must be able to close a launch
  // band even in a cycle where the pool no longer clears the lane -- that IS the fade exit.
  // A pair pool carries the launch lane's exits with the pair's stop and hold; its "last hour" is the
  // reference pool's, and a reference row that has gone cold reads as 0 so the fade exit fires.
  // A STOCK pair carries none of the launch lane's exits (no maximum hold, no volume-fade EXPIRE): the
  // ordinary stop, the cost-based re-centre, the stock policy's closes and the reference-gone guard apply.
  // A HOUSE token's pool (PAIR_HOUSE_MINTS) carries none of them either: it is our own token and the pool stays up.
  const isStockPair = isPair && !!snapshot.pair!.stock;
  const isHousePair = isPair && !!snapshot.pair!.house;
  const noLaneExits = isStockPair || isHousePair;
  const lenv = launchEnv();
  const laneEnv = isPair && !noLaneExits ? pairLaunchEnv(pairEnv(), lenv) : lenv;
  const laneVol1h = isPair ? (snapshot.pair!.stale ? 0 : snapshot.pair!.refVol1hUsd) : (hotRowOf(o.address)?.vol1hUsd ?? null);
  const launchWatch = laneEnv.on && !noLaneExits ? { env: laneEnv, vol1hUsd: laneVol1h } : null;
  const senv = pairStockEnv();
  const pairStockWatch = isStockPair ? { ticker: snapshot.pair!.stock!.ticker, refGoneCycles: snapshot.pair!.refGoneCycles ?? 0, maxCycles: senv.refGoneCycles } : undefined;
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
  // A stock pair of ours reads its ticker's row, and its basis is OUR pool's price against the perp
  // (near zero when the synthetic price is the perp itself; real when the pool exists on chain).
  const pinnedTicker = pinnedTickerOf(app, o.address, snapshot);
  const basisRow = basisRowFor(o.address, snapshot, pinnedTicker ?? meteoraStockAt(app, o.address)?.ticker ?? (screen?.stock && screen.stock.issuer !== "unknown" ? screen.stock.ticker : null));
  const clock = sessionClock();
  const perpMidNow = basisRow ? ((basisRow.perpSymbol ? app.perpMarks.get(basisRow.perpSymbol)?.mid : undefined) ?? basisRow.perpMid ?? null) : null;
  const ownPriceUsd = quoteIsSol ? snapshot.tokenPriceInSol * (solPriceOf(app) ?? 0) : quoteOf(snapshot).tokenPriceInQuote;
  // our own pool's price against the perp for a pair of ours or a pinned Meteora pool (their basis row belongs to another pool)
  const ownBasis = isPair || (!!basisRow && basisRow.pool !== o.address);
  const basisPctNow = ownBasis ? (perpMidNow && perpMidNow > 0 && ownPriceUsd > 0 ? (ownPriceUsd / perpMidNow - 1) * 100 : null) : (basisRow?.basisPct ?? null);
  const basisCheck = basisRow ? basisVerdict(basisPctNow, clock) : null;
  const basisObs: EngineObservation["basis"] = basisRow
    ? {
        session: clock.session,
        minutesToOpen: clock.minutesToOpen,
        basisPct: basisPctNow,
        perpSymbol: basisRow.perpSymbol ?? null,
        perpMid: perpMidNow,
        widthMultiplier: sessionWidthMultiplier(clock),
        reason: basisCheck && !basisCheck.ok ? basisCheck.reason : null,
      }
    : undefined;
  // How long a band here should sit out of range before moving it pays for itself: the venue's
  // unrecoverable rent plus the swap fees, against what the band earns when it is in range.
  // (a made pair's fees per day are the routing model's: the pool has no board row)
  const poolFeesPerDayUsd = isPair
    ? (snapshot.pair!.feesPerDayUsd > 0 ? snapshot.pair!.feesPerDayUsd : null)
    : screen?.tvlUsd && screen?.feeToTvl24hPct !== null && screen?.feeToTvl24hPct !== undefined
      ? (screen.tvlUsd * screen.feeToTvl24hPct) / 100
      : null;
  // Our share of the quote side of the observed bins, both in QUOTE units (a band's valueInSol
  // converts at the quote's SOL price; liquidityBelowY/AboveX are already in the quote token).
  // Live bins already contain our own liquidity; paper bands are virtual and are not in them.
  const qv = quoteOf(snapshot);
  const heldQuote = positions.reduce((t, p) => t + p.valueInSol, 0) / Math.max(1e-12, qv.priceInSol);
  const sideDepthQuote = qv.side === "Y" ? snapshot.liquidityBelowY : snapshot.liquidityAboveX;
  const shareDenom = app.paper ? heldQuote + sideDepthQuote : Math.max(sideDepthQuote, heldQuote);
  const heldShare = isPair && snapshot.pair!.ourShare !== null ? (positions.length > 0 ? snapshot.pair!.ourShare : 0) : positions.length > 0 && snapshot.bins.length > 0 && shareDenom > 0 ? Math.min(0.5, heldQuote / shareDenom) : 0;
  const bandFeesPerDayUsd = poolFeesPerDayUsd !== null && heldShare > 0 ? poolFeesPerDayUsd * heldShare * 0.5 : null;
  const cost = o.venue.openCostSol(snapshot);
  const px = solPriceOf(app);
  const moveCostUsd = px ? Math.max(0, cost.total - cost.refundable) * px : 0;
  // The cost-based threshold needs both the move's cost and the band's earning rate; without either
  // (a pool off the board, no SOL price) it falls back to a fixed wait rather than the bare floor,
  // so a choppy pool cannot churn a paid re-lay every two minutes on missing data.
  const moveSec = bandFeesPerDayUsd !== null && moveCostUsd > 0 ? Math.round(moveAfterSec(moveCostUsd, bandFeesPerDayUsd, cfg.outOfRangeSec)) : Math.max(cfg.outOfRangeSec, OUT_OF_RANGE_FALLBACK_SEC);
  const engineObs: EngineObservation = {
    halt: view.haltedUntil !== null ? { until: view.haltedUntil, stage: view.haltStage, reason: view.haltReason } : null,
    standDown: view.standDownUntil !== null ? { until: view.standDownUntil, reason: view.standDownReason } : null,
    bench: view.bench,
    regime: { medianMove24hPct: view.regime.medianMove24hPct, multiplier: view.regime.multiplier, reason: view.regime.reason },
    sizeMultiplier: view.sizeMultiplier,
    effectiveMaxPositionSol: riskLimits.maxPositionSol * view.sizeMultiplier,
    stops,
    outOfRangeSec: oorSec,
    minOutOfRangeSec: moveSec,
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
  const directive = engineDirective({ now, snapshot, positions, state, engine: app.engine, cfg, limits: riskLimits, collectsToday, launch: launchWatch ?? undefined, pairStock: pairStockWatch, rotate: app.rotateOut?.pool === o.address ? { reason: app.rotateOut.reason } : null });
  // Then an approved outside proposal, oldest first: "agents propose, the operator decides, the desk
  // executes through its own guards". Otherwise Mr Bands proposes.
  const proposal = directive ? null : (approvedProposals(o.address)[0] ?? null);
  // An engine close in a stock pool or a pair pool liquidates: the book returns to the quote (the hedge comes off with it; the token is never kept).
  const directiveDecision = directive && (basisRow || isPair || directive.kind === "ROTATE") && directive.decision.action === "CLOSE_POSITION" ? { ...directive.decision, liquidate: true } : directive?.decision;
  let llm = directive
    ? engineDecideResult(directiveDecision!, `${directive.kind}: ${directive.reason}`)
    : proposal
      ? proposalDecideResult(proposalDecision(proposal), `proposal ${proposal.id} by ${proposal.proposerName} (${proposal.proposerId})`)
      : await decide(observation, { hot: hotRows(app, 8, true), openCostSol: openCostDefault, grow: { allowed: !app.movedThisCycle } });
  // Every close sells the token back to the quote, whoever proposed it (the model, a proposal, the
  // guards, a directive): the book is quote-denominated, and a token left in the wallet is capital
  // nothing can size a band from. This is the mechanism the 7f5b49b fix belonged in.
  if (llm.decision.action === "CLOSE_POSITION" && llm.decision.liquidate !== true) llm = { ...llm, decision: { ...llm.decision, liquidate: true } };
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
    outOfRangeSec: moveSec,
    basisReason: basisObs?.reason ?? null,
  };
  // Cost the proposed plan for the guards. A plan the venue cannot even cost (a NaN amount, a
  // single-sided CLMM band with no bins on its side) is not a crash for the whole pool cycle: the
  // guards see the default cost and refuse the plan on its shape.
  let openCostSol = openCostDefault;
  let planFault: string | null = null;
  if (llm.decision.open) {
    try {
      openCostSol = o.venue.openCostSol(snapshot, toOpenPlan(llm.decision.open, snapshot)).total;
    } catch (err) {
      planFault = `the venue could not cost this plan: ${(err as Error).message}`;
      console.log(`${tag} ${planFault}`);
    }
  }
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
    // on Meteora-only routes (SWAP_DEXES) a paper swap pays at least the pool's own base fee, not a deep route's
    paper: paper ? { book: paper, slippagePct: app.paperEnv.slippagePct, now, ...(meteoraOnlyRoutes(swapEnv().dexes) ? { swapFeePct: Math.max(swapEnv().feePct, snapshot.baseFeePct) } : {}) } : undefined,
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
  if (execution.ok && (execution.opened || execution.closed)) {
    app.movedThisCycle = true;
    if (directive?.kind === "ROTATE" && execution.closed) state.rotatedOutAt = { ...(state.rotatedOutAt ?? {}), [o.address]: now };
    const closedSol = execution.closed ? (positions.find((p) => p.address === execution.closed)?.valueInSol ?? 0) : 0;
    app.exposureDelta.set(o.address, (app.exposureDelta.get(o.address) ?? 0) + (execution.opened?.entryValueSol ?? 0) - closedSol);
  }
  updateState(state, execution, positions, snapshot, (screen?.launch?.ok || screen?.pair?.ok) && !noLaneExits ? { env: laneEnv, vol1hUsd: launchWatch?.vol1hUsd ?? null } : null);

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
    ...(screen?.launch?.ok
      ? { launch: { ageHours: screen.launch.ageHours, turnover: screen.launch.turnover, seatCapSol: (riskLimits.maxTotalExposureSol * lenv.seatPct) / 100, stopPct: lenv.stopPct, maxHoldMin: lenv.maxHoldMin } }
      : {}),
    ...(snapshot.pair
      ? {
          pair: {
            refPool: snapshot.pair.refPool,
            refVenue: snapshot.pair.refVenue,
            refLiquidityUsd: snapshot.pair.refLiquidityUsd,
            routedShare: snapshot.pair.routedShare,
            routedShareGross: snapshot.pair.routedShareGross,
            competingDepthUsd: snapshot.pair.competingDepthUsd,
            feeBps: Math.round(snapshot.baseFeePct * 100),
            binStep: snapshot.binStep,
            rentSol: snapshot.pair.creationRentSol,
            lbPair: snapshot.pair.lbPair,
            exists: snapshot.pair.exists,
            ours: snapshot.pair.ours,
            seatCapSol: isStockPair ? pairStockSeatSol(riskLimits.maxTotalExposureSol, senv) : isHousePair ? pairHouseSeatSol(riskLimits.maxTotalExposureSol, pairEnv()) : pairSeatSol(riskLimits.maxTotalExposureSol, pairEnv()),
            stopPct: noLaneExits ? riskLimits.stopLossPct : laneEnv.stopPct,
            maxHoldMin: noLaneExits ? 0 : laneEnv.maxHoldMin,
            ...(isHousePair ? { house: true } : {}),
            ...(isStockPair
              ? { stock: snapshot.pair.stock ?? null, priceSource: snapshot.pair.priceSource ?? null, refGoneCycles: snapshot.pair.refGoneCycles ?? 0, feesPerDayUsd: snapshot.pair.feesPerDayUsd }
              : {}),
          },
        }
      : {}),
  };

  const { decision: _d, ...llmMeta } = llm;
  const entry: JournalEntry = {
    id: `${ts}-${app.cycle}-${o.address.slice(0, 6)}`,
    ts,
    cycle: app.cycle,
    // the journal says paper when the book is paper; the ledger keeps its own two-valued mode
    mode: journalMode(app),
    agent: { id: config.agentId, name: config.agentName },
    pool: { ...toJournalPool(snapshot), stock: observation.screen?.stock ?? snapshot.pair?.stock ?? null },
    wallet: observation.wallet,
    positions,
    analytics,
    llm: llmMeta,
    // every public line in Mr Bands' voice (docs/mr-bands-agent.md section 2), whoever wrote it
    proposal: { ...verdict.proposal, headline: voiceLine(verdict.proposal.headline) },
    decision: { ...verdict.decision, headline: voiceLine(verdict.decision.headline) },
    allowed: verdict.allowed,
    violations: verdict.violations,
    overrides: verdict.overrides,
    passed: verdict.passed,
    emergency: verdict.emergency,
    execution,
    headline: voiceLine(verdict.decision.headline),
    screen: screen ? { rank: screen.rank, rankedPools: screen.rankedPools, score: screen.score, feeToTvl24hPct: screen.feeToTvl24hPct, flow: screen.flow ?? null } : null,
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
function markBook(app: App, observed: Observed[], entries: JournalEntry[], solAtStart: number, usdcAtStartSol: number, hedgeSol = 0, usdcAtStart = 0): void {
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
  // The same figure, one line a cycle, for the site's "since the start" numbers (src/journal EquityPoint).
  if (Number.isFinite(equity)) {
    const bandsSol = observed.reduce((s, o) => s + o.positions.reduce((t, p) => t + p.valueInSol, 0), 0);
    // fees realised to the wallet: claims plus the fee leg of every close, from the ledger in both
    // modes (the paper book's feesClaimedSol counts claims only; the backfill and this must agree)
    const feesClaimedSol = rowsOf(rows, mode).reduce((s, r) => s + ((r.mech === "collect" || r.mech === "close") && typeof r.feeSol === "number" ? r.feeSol : 0), 0);
    try {
      appendEquity({
        t: now,
        cycle: app.cycle,
        agent: entries[0]?.agent?.id ?? "mr-bands",
        mode: app.paper ? "paper" : mode,
        equitySol: equity,
        walletSol: solAtStart,
        quoteSol: usdcAtStartSol,
        quoteUsdc: usdcAtStart,
        bandsSol,
        tokensSol,
        hedgeSol,
        bands: openBands.length,
        pools: observed.length,
        feesClaimedSol,
        solPriceUsd: solPriceOf(app),
      });
    } catch (err) {
      console.error(`[cycle ${app.cycle}] equity point not written: ${(err as Error).message}`);
    }
  }
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
    let sym = basisForPool(address)?.perpSymbol;
    const pinnedPool = pinnedPoolAt(app.pinned, address);
    if (!sym && pinnedPool) sym = basisForTicker(pinnedPool.ticker)?.perpSymbol ?? undefined;
    const metPool = meteoraStockAt(app, address);
    if (!sym && metPool) sym = basisForTicker(metPool.ticker)?.perpSymbol ?? undefined;
    if (!sym && isStockPairKey(app, address)) {
      const mint = pairMintOf(address);
      const c = mint ? pairStockCandidateFor(stockCandidatesOf(app), mint) : null;
      const ticker = c?.ticker ?? app.paper?.pairPools?.[address]?.stock?.ticker ?? loadState().pairPools?.[address]?.stock?.ticker;
      sym = ticker ? (basisForTicker(ticker)?.perpSymbol ?? undefined) : undefined;
    }
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
    // a pool the desk created for a pair is found by its real address: the loop works it under its pair-<mint> key
    const alias = new Map(Object.entries(loadState().pairPools ?? {}).map(([key, rec]) => [rec.lbPair, key] as const));
    withPositions = [...new Set(withPositions.map((a) => alias.get(a) ?? a))];
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
  await refreshMeteoraStocks(app);
  // the flow scout's file, when it is running and fresh: the desk's fastest view of its pools
  app.flow = flowByPool(readFlowFile(path.resolve(process.cwd(), config.dataDir)), Date.now());
  if (app.flow.size) console.log(`[cycle ${app.cycle}] flow scout: ${app.flow.size} pool(s) read from the chain in the last ${Math.round(3)} min`);
  await refreshPinned(app);
  await refreshMemeHistory(app, funds);
  await rankMeteoraSeats(app, withPositions, funds);
  const pools = pickPools(app, withPositions, funds);
  if (pools.length === 0) {
    console.log(`[cycle ${app.cycle}] nothing to work: no pinned pools, no bands held, no screen picks`);
    return;
  }
  console.log(`[cycle ${app.cycle}] working ${pools.length} pools (${withPositions.length} with bands)`);
  app.hedgedThisCycle.clear();
  app.mintAttributed.clear();
  app.movedThisCycle = false;
  app.exposureDelta.clear();
  app.flowWatch.clear();
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

  // Pools holding a band are decided first: closes free capital for opens later in the pass. Among
  // them the best seat by yield goes first, so the room a closed seat left grows the seat that earns most.
  const heldYield = new Map((app.seatRanking?.held ?? []).map((h) => [h.address, h.yieldPctPerDay] as const));
  observed.sort((a, b) => b.positions.length - a.positions.length || (heldYield.get(b.address) ?? -1) - (heldYield.get(a.address) ?? -1));
  // Every pool worked this cycle goes to the scout (held, picked, or ranked): the next cycle decides on
  // its measured flow. Written once, after observation, so the picks are read before they are seated.
  for (const o of observed) {
    try {
      const q = quoteOf(o.snapshot);
      const band = o.positions.length ? { lowerBinId: Math.min(...o.positions.map((p) => p.lowerBinId)), upperBinId: Math.max(...o.positions.map((p) => p.upperBinId)) } : null;
      app.flowWatch.set(o.address, { address: o.address, label: o.snapshot.label, quoteSide: q.side, quoteSymbol: q.symbol, xDecimals: o.snapshot.tokenX.decimals, yDecimals: o.snapshot.tokenY.decimals, band });
    } catch {
      /* a pool the quote view cannot price is not watched */
    }
  }
  writeFlowWatch([...app.flowWatch.values()], now);
  // FADE (src/screener/seatYield.ts): a held seat is judged on its own pool's measured flow. Its yield
  // (the scout's four-hour fee pace x our share of the band's bins / the seat) under half the floor for
  // three cycles running, on a band old enough, and it comes off: the flow it was seated for is gone.
  if (!app.rotateOut) {
    const pEnvNow = policyEnv();
    const rEnvNow = seatRankingEnv();
    const fadeFactor = Math.max(0, Number(process.env.SEAT_FADE_FACTOR ?? "0.5") || 0.5);
    const fadeCycles = Math.max(1, Math.floor(Number(process.env.SEAT_FADE_CYCLES ?? "3") || 3));
    for (const o of observed) {
      if (!o.positions.length) continue;
      const flow = app.flow.get(o.address);
      if (!flow || flow.coveredMin === null || flow.feesPerDayQuote240m === null) continue;
      try {
        const q = quoteOf(o.snapshot);
        const seatSol = o.positions.reduce((t, p) => t + p.valueInSol, 0);
        const lower = Math.min(...o.positions.map((p) => p.lowerBinId));
        const upper = Math.max(...o.positions.map((p) => p.upperBinId));
        const y = seatYield({ seatQuote: seatSol / q.priceInSol, binsEachSide: Math.max(0, Math.floor((upper - lower) / 2)), activeBinId: o.snapshot.activeBinId, bins: o.snapshot.bins, quoteSide: q.side, tokenPriceInQuote: q.tokenPriceInQuote, poolFeesPerDayQuote: flow.feesPerDayQuote240m });
        const line = fadeFactor * pEnvNow.minSeatYieldPct;
        const streak = y.yieldPctPerDay < line ? (app.fadeStreak.get(o.address) ?? 0) + 1 : 0;
        app.fadeStreak.set(o.address, streak);
        const openedAt = state.lastMoveByPool?.[o.address] ?? null;
        const ageOk = openedAt === null || now - openedAt >= rEnvNow.minAgeMin * 60_000;
        console.log(`[cycle ${app.cycle} ${o.snapshot.label}] seat check: ${y.yieldPctPerDay.toFixed(2)}%/day on the ${seatSol.toFixed(2)} SOL seat from the pool's last ${flow.coveredMin} min (${flow.feesPerDayQuote240m.toFixed(3)} ${q.symbol}/day pool pace x ${y.sharePct.toFixed(1)}% of the band's bins)${streak ? `; under the fade line ${line.toFixed(2)}% for ${streak} cycle(s)` : ""}`);
        if (seatFaded({ yieldPctPerDay: y.yieldPctPerDay, floorPct: pEnvNow.minSeatYieldPct, fadeFactor, streak, cyclesNeeded: fadeCycles, ageOk })) {
          app.rotateOut = { pool: o.address, label: o.snapshot.label, reason: `its own flow faded: the seat reads ${y.yieldPctPerDay.toFixed(2)}%/day from the pool's last ${flow.coveredMin} min, under ${line.toFixed(2)}% for ${streak} cycles` };
          console.log(`[cycle ${app.cycle}] seat check: rotating out ${o.snapshot.label} (${o.address.slice(0, 6)}): ${app.rotateOut.reason}`);
          break;
        }
      } catch {
        /* unpriced: no judgement */
      }
    }
  }
  // CONSOLIDATION (src/screener/seatYield.ts): now that the seats' sizes are read, a weak seat makes
  // way for the best held one when that one could hold more; the policy's grow rule moves the money next cycle.
  if (!app.rotateOut && app.seatRanking) {
    const sized = app.seatRanking.held.map((h) => ({ ...h, heldSol: observed.find((o) => o.address === h.address)?.positions.reduce((t, p) => t + p.valueInSol, 0) ?? null }));
    const minGrowSol = Math.max(MIN_BAND_SOL, (riskLimits.maxTotalExposureSol * policyEnv().minSeatPct) / 100);
    const c = consolidation(sized, seatRankingEnv(), now, minGrowSol);
    if (c) {
      app.rotateOut = c;
      console.log(`[cycle ${app.cycle}] seat yield: rotating out ${c.label} (${c.pool.slice(0, 6)}): ${c.reason}`);
    }
  }
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
      markBook(app, observed, entries, solAtStart, solPriceUsd ? usdcAtStart / solPriceUsd : 0, hedgeSol, usdcAtStart);
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
  let appRef: App | null = null;
  const pairVenue = createPairVenue({
    paper: () => appRef?.paper ?? paper,
    created: () => loadState().pairPools ?? {},
    // the seat the model sizes for: the pair's cap or the max band, whichever binds first
    seatSol: () => Math.min(pairSeatSol(riskLimits.maxTotalExposureSol, pairEnv()), riskLimits.maxPositionSol),
    solPriceUsd: () => (appRef ? solPriceOf(appRef) : null),
    screenRows: () => (appRef?.screen?.pools ?? []).map((p) => ({ address: p.address, venue: p.venue, baseMint: p.baseMint, quoteSymbol: p.quoteSymbol, liquidityUsd: p.tvlUsd, priceUsd: p.priceUsd })),
    ourBins: (address, activeBinId, binsEachSide, spec) => {
      const book = appRef?.paper ?? paper;
      return book ? paperBinRows(book, address, activeBinId, binsEachSide, { binStep: spec.binStep, xDecimals: spec.decimals, yDecimals: spec.quoteDecimals }) : null;
    },
    // the STOCK pair lane: the board's candidate for a mint, the perp mid for its ticker, the seat and the straddle's width
    stockRef: (mint) => (appRef ? pairStockCandidateFor(stockCandidatesOf(appRef), mint) : null),
    perpMidUsd: (ticker) => (appRef ? perpMidForTicker(appRef, ticker) : null),
    stockSeatSol,
    stockBinsPerSide: (binStep, address) => (appRef ? stockPairBinsPerSide(appRef, binStep, address) : stockBinsPerSide(binStep, policyEnv().stockCoverPct, riskLimits.maxBinWidth, sessionWidthMultiplier(sessionClock()))),
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
    movedThisCycle: false,
    exposureDelta: new Map(),
    flowWatch: new Map(),
    fadeStreak: new Map(),
    mintAttributed: new Set(),
    pairVenue,
    pinned: null,
    flow: new Map(),
    seatRanking: null,
    seatRotation: null,
    pinnedAt: 0,
    rotateOut: null,
    memeHistory: new Map(),
    meteoraStocks: null,
  };
  appRef = app;
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
