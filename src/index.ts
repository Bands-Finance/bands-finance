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
 */
import { exec } from "node:child_process";
import DLMM from "@meteora-ag/dlmm";
import { Connection, PublicKey } from "@solana/web3.js";
import { config, riskLimits } from "./config";
import { decide, engineDecideResult, proposalDecideResult } from "./agent/decide";
import type { Decision } from "./agent/schema";
import { approvedProposals, markExecuted, Proposal } from "./platform/proposals";
import type { EngineObservation, Observation, ScreenContext } from "./agent/observation";
import { evaluate, EngineGuardContext } from "./risk/guards";
import { describeLimits } from "./risk/limits";
import { killSwitchActive, loadState, saveState, RiskState, todayUtc } from "./risk/state";
import { execute, executeSkim, ExecutionResult } from "./executor";
import { appendJournal, JournalEngine, JournalEntry, readRecent, toJournalPool } from "./journal";
import { loadScreen, runScreen } from "./screener";
import type { ScreenResult } from "./screener/types";
import { getPoolSnapshot, getUserPositions, KNOWN_TOKENS, loadPool, PoolSnapshot, PositionSnapshot, quoteOf, QuotePriceUnknownError, setSolPriceUsd, UnsupportedQuoteError } from "./tools/dlmm";
import { fetchPoolAnalytics } from "./tools/lpagent";
import { Wallet } from "./tools/wallet";
import { startServer } from "./server";
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

interface App {
  connection: Connection;
  wallet: Wallet;
  cycle: number;
  dlmms: Map<string, DLMM>;
  screen: ScreenResult | null;
  screenAt: number;
  /** breaker state, loaded once per iteration and saved after every change */
  engine: EngineState;
  /** the board regime for this iteration */
  regime: RegimeView;
}

interface Observed {
  address: string;
  dlmm: DLMM;
  snapshot: PoolSnapshot;
  raw: Awaited<ReturnType<typeof getUserPositions>>["raw"];
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
  const mode = config.dryRun ? "DRY RUN (nothing is broadcast)" : "LIVE (real transactions)";
  console.log("=".repeat(72));
  console.log(`${config.agentName}  |  ${mode}`);
  console.log(`pools     ${config.pinnedPools.length ? `pinned ${config.pinnedPools.join(", ")} + ` : ""}screener top picks, max ${config.maxActivePools} at once`);
  console.log(`quotes    SOL and USDC (a USDC pool is valued at the screen's SOL price: ${app.screen?.solPriceUsd ? `$${app.screen.solPriceUsd.toFixed(2)}` : "none yet, USDC pools skipped until a screen lands"})`);
  console.log(`wallet    ${app.wallet.publicKey.toBase58()}${app.wallet.ephemeral ? "  (ephemeral, no key configured)" : ""}${cfg.expectedWallet ? `  expected ${cfg.expectedWallet}` : ""}`);
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

function deploySnapshot(): void {
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
    setSolPriceUsd(solPriceOf(app));
    if (config.autoDeploy) deploySnapshot();
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
function pickPools(app: App, withPositions: string[]): string[] {
  const set = new Set<string>([...config.pinnedPools, ...withPositions]);
  const usdcOk = typeof app.screen?.solPriceUsd === "number" && app.screen.solPriceUsd > 0;
  const candidates = (app.screen?.pools ?? []).filter(
    (p) =>
      (p.quoteSymbol === "SOL" || (p.quoteSymbol === "USDC" && usdcOk)) &&
      p.score > 0 &&
      !p.flags.includes("thin") &&
      !p.flags.includes("no-24h-data"),
  );
  for (const p of candidates) {
    if (set.size >= config.maxActivePools) break;
    set.add(p.address);
  }
  return [...set];
}

async function getDlmm(app: App, address: string): Promise<DLMM> {
  let d = app.dlmms.get(address);
  if (!d) {
    d = await loadPool(app.connection, address);
    app.dlmms.set(address, d);
  }
  return d;
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
    alternatives: s.pools
      .filter((x) => x.address !== address && (x.quoteSymbol === "SOL" || (x.quoteSymbol === "USDC" && solPriceOf(app) !== null)))
      .slice(0, 5)
      .map((x) => ({ name: x.name, score: x.score, feeToTvl24hPct: x.feeToTvl24hPct, tvlUsd: x.tvlUsd })),
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

function updateState(state: RiskState, exec: ExecutionResult, positions: PositionSnapshot[], snapshot: PoolSnapshot): void {
  state.lastPrice = snapshot.activePrice;
  for (const p of positions) {
    if (!(p.address in state.entryValueSol)) state.entryValueSol[p.address] = p.valueInSol;
  }
  if (exec.txs.length > 0) {
    state.actionsToday += 1;
    state.lastActionAt = Date.now();
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
  const q = quoteOf(snapshot);
  const quoteIsSol = q.symbol === "SOL";

  // Balances: SOL always (gas), the base token, and the pool's quote token when it is not SOL.
  const [token, quoteBal, analytics] = await Promise.all([
    app.wallet.tokenBalance(new PublicKey(snapshot.baseToken.mint)),
    quoteIsSol ? Promise.resolve(null) : app.wallet.tokenBalance(new PublicKey(q.token.mint)),
    fetchPoolAnalytics(o.address, snapshot),
  ]);
  const quote = quoteIsSol ? sol : (quoteBal?.ui ?? 0);
  const state = loadState();
  const killSwitch = killSwitchActive();
  for (const p of positions) p.entryValueSol = state.entryValueSol[p.address];
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
    state: { actionsToday: state.actionsToday, lastActionAt: state.lastActionAt, lastPrice: state.lastPrice, killSwitch },
    recent: readRecent(40)
      .filter((e) => e.pool.address === o.address)
      .slice(0, 5)
      .map((e) => ({ ts: e.ts, action: e.decision.action, allowed: e.allowed, headline: e.headline, violations: e.violations })),
    screen,
    portfolio,
    engine: engineObs,
  };
  console.log(
    `${tag} active bin ${snapshot.activeBinId} price ${snapshot.activePrice.toPrecision(6)} ${snapshot.priceLabel} | quote ${q.symbol}${quoteIsSol ? "" : ` (1 ${q.symbol} = ${q.priceInSol.toFixed(6)} SOL)`} | screen ${screen ? `#${screen.rank} score ${screen.score}` : "n/a"} | wallet ${sol.toFixed(4)} SOL, ${quoteIsSol ? "" : `${quote.toFixed(2)} ${q.symbol}, `}${token.ui.toFixed(2)} ${snapshot.baseToken.symbol} | bands ${positions.length} | size x${view.sizeMultiplier}${knife ? ` | ${knife}` : ""}`,
  );

  // The engine decides first. When it has a directive the LLM is not asked this cycle.
  const directive = engineDirective({ now, snapshot, positions, state, engine: app.engine, cfg, limits: riskLimits, collectsToday });
  // Then an approved outside proposal, oldest first: "agents propose, the operator decides, the desk
  // executes through its own guards". Otherwise Mr Bands proposes.
  const proposal = directive ? null : (approvedProposals(o.address)[0] ?? null);
  const llm = directive
    ? engineDecideResult(directive.decision, `${directive.kind}: ${directive.reason}`)
    : proposal
      ? proposalDecideResult(proposalDecision(proposal), `proposal ${proposal.id} by ${proposal.proposerName} (${proposal.proposerId})`)
      : await decide(observation);
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
  };
  const verdict = evaluate(
    llm.decision,
    { now, snapshot, positions, walletSol: sol, walletToken: token.ui, walletQuote: quote, state, killSwitch, ...portfolio, engine: engineCtx, source: directive ? "engine" : "llm" },
    riskLimits,
  );
  if (verdict.overrides.length) console.log(`${tag} guard override: ${verdict.overrides.join("; ")}`);
  if (verdict.violations.length) console.log(`${tag} guards BLOCKED: ${verdict.violations.join("; ")}`);

  const execution = await execute(verdict, { dlmm: o.dlmm, wallet: app.wallet, rawPositions: raw, snapshot, positions });
  for (const t of execution.txs) {
    console.log(`${tag} ${execution.mode} ${t.label}: ${t.signature ?? t.skipped ?? (t.ok ? "simulated ok" : `FAILED ${t.error}`)}`);
  }
  for (const row of execution.ledger ?? []) {
    const quoteLeg = quoteIsSol || typeof row.quoteDelta !== "number" ? "" : ` (${row.quoteDelta.toFixed(4)} ${q.symbol})`;
    console.log(`${tag} ledger ${row.mech} ${row.basis}: sol ${row.solDelta.toFixed(6)}${quoteLeg} rent ${row.rentSol.toFixed(6)} fee ${row.txFeeSol.toFixed(6)} token ${row.tokenDelta.toFixed(4)}`);
  }
  updateState(state, execution, positions, snapshot);

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
function markBook(app: App, observed: Observed[], entries: JournalEntry[], solAtStart: number, usdcAtStartSol: number): void {
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
  const equity = solAtStart + usdcAtStartSol + observed.reduce((s, o) => s + o.positions.reduce((t, p) => t + p.valueInSol, 0), 0) + tokensSol;
  if (Number.isFinite(equity) && equity > 0) {
    const pv = portfolioVerdict(app.engine.portfolio, equity, today, now, { floorSol: cfg.portfolioFloorSol });
    app.engine.portfolio = pv.next;
    if (pv.fire) console.error(`[cycle ${app.cycle}] PORTFOLIO BREAKER: ${pv.reason}`);
  }
  saveEngineState(app.engine);
  console.log(
    `[cycle ${app.cycle}] marks: equity ${equity.toFixed(4)} SOL (day high ${app.engine.portfolio.hwmSol.toFixed(4)}) | today's loss ${loss.toFixed(4)} / limit ${app.engine.circuit.lastLimitSol.toFixed(4)} SOL | working ${workingSol(state.entryValueSol).toFixed(4)}`,
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

async function runIteration(app: App): Promise<void> {
  await ensureScreen(app);
  app.engine = loadEngineState();

  const held = await DLMM.getAllLbPairPositionsByUser(app.connection, app.wallet.publicKey);
  const withPositions = [...held.entries()].filter(([, info]) => info.lbPairPositionsData.length > 0).map(([addr]) => addr);
  const pools = pickPools(app, withPositions);
  if (pools.length === 0) {
    console.log(`[cycle ${app.cycle}] nothing to work: no pinned pools, no bands held, no screen picks`);
    return;
  }
  console.log(`[cycle ${app.cycle}] working ${pools.length} pools (${withPositions.length} with bands)`);

  const solPriceUsd = solPriceOf(app);
  const observed: Observed[] = [];
  for (const address of pools) {
    try {
      const dlmm = await getDlmm(app, address);
      const snapshot = await getPoolSnapshot(dlmm, 10, { solPriceUsd });
      const { raw, positions } = await getUserPositions(dlmm, app.wallet.publicKey, snapshot);
      observed.push({ address, dlmm, snapshot, raw, positions });
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
  app.regime = regimeView(observed.map((o) => move24hPct(app, o.address, state)));
  if (app.regime.reason) console.log(`[cycle ${app.cycle}] ${app.regime.reason}`);

  const solAtStart = await app.wallet.solBalance();
  // The wallet's USDC is capital too (a closed USDC band returns as USDC): it marks at the SOL price.
  let usdcAtStart = 0;
  try {
    usdcAtStart = (await app.wallet.usdcBalance()).ui;
  } catch (err) {
    console.error(`[cycle ${app.cycle}] could not read the wallet's USDC: ${(err as Error).message}`);
  }
  // Pools holding a band are decided first: closes free capital for opens later in the pass.
  observed.sort((a, b) => b.positions.length - a.positions.length);
  const entries: JournalEntry[] = [];
  for (const o of observed) {
    try {
      const sol = await app.wallet.solBalance();
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
      markBook(app, observed, entries, solAtStart, solPriceUsd ? usdcAtStart / solPriceUsd : 0);
    } catch (err) {
      console.error(`[cycle ${app.cycle}] marks failed:`, err);
    }
  } else if (usdcUnpriced) {
    console.log(`[cycle ${app.cycle}] marks skipped: the wallet holds ${usdcAtStart.toFixed(2)} USDC and no SOL price is known to value it`);
  } else {
    console.log(`[cycle ${app.cycle}] marks skipped: ${observed.length}/${pools.length} pools observed, ${entries.length} decided`);
  }
  await runSkim(app);
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
    dlmms: new Map(),
    screen: loadScreen(),
    screenAt: 0,
    engine: loadEngineState(),
    regime: regimeView([]),
  };
  if (app.screen) app.screenAt = new Date(app.screen.generatedAt).getTime();
  setSolPriceUsd(solPriceOf(app));
  banner(app);
  if (config.servePort > 0) startServer(config.servePort);
  if (!once) startWatchdog({ cycleIntervalSec: config.cycleIntervalSec, live: !config.dryRun });

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
    await sleepInterruptible(config.cycleIntervalSec * 1000);
  }
  releaseLock();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
