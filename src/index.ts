/**
 * Scheduler. Each iteration: refresh the screen if stale -> pick the pools to work ->
 * for each pool: observe -> Mr Bands proposes -> guards decide -> execute -> journal.
 *   npm run once   one iteration
 *   npm start      loop every CYCLE_INTERVAL_SEC
 */
import { exec } from "node:child_process";
import DLMM from "@meteora-ag/dlmm";
import { Connection, PublicKey } from "@solana/web3.js";
import { config, riskLimits } from "./config";
import { decide } from "./agent/decide";
import type { Observation, ScreenContext } from "./agent/observation";
import { evaluate } from "./risk/guards";
import { describeLimits } from "./risk/limits";
import { killSwitchActive, loadState, saveState, RiskState } from "./risk/state";
import { execute, ExecutionResult } from "./executor";
import { appendJournal, JournalEntry, readRecent, toJournalPool } from "./journal";
import { loadScreen, runScreen } from "./screener";
import type { ScreenResult } from "./screener/types";
import { getPoolSnapshot, getUserPositions, KNOWN_TOKENS, loadPool, PoolSnapshot, PositionSnapshot } from "./tools/dlmm";
import { fetchPoolAnalytics } from "./tools/lpagent";
import { Wallet } from "./tools/wallet";
import { startServer } from "./server";

interface App {
  connection: Connection;
  wallet: Wallet;
  cycle: number;
  dlmms: Map<string, DLMM>;
  screen: ScreenResult | null;
  screenAt: number;
}

interface Observed {
  address: string;
  dlmm: DLMM;
  snapshot: PoolSnapshot;
  raw: Awaited<ReturnType<typeof getUserPositions>>["raw"];
  positions: PositionSnapshot[];
}

function banner(app: App): void {
  const mode = config.dryRun ? "DRY RUN (nothing is broadcast)" : "LIVE (real transactions)";
  console.log("=".repeat(72));
  console.log(`${config.agentName}  |  ${mode}`);
  console.log(`pools     ${config.pinnedPools.length ? `pinned ${config.pinnedPools.join(", ")} + ` : ""}screener top picks, max ${config.maxActivePools} at once`);
  console.log(`wallet    ${app.wallet.publicKey.toBase58()}${app.wallet.ephemeral ? "  (ephemeral, no key configured)" : ""}`);
  console.log(`model     ${config.model}`);
  console.log(`interval  ${config.cycleIntervalSec}s cycles, screen every ${config.screen.intervalSec}s`);
  console.log("limits");
  console.log(describeLimits(riskLimits).split("\n").map((l) => "  " + l).join("\n"));
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

async function ensureScreen(app: App): Promise<void> {
  registerTokens(app.screen);
  if (app.screen && Date.now() - app.screenAt < config.screen.intervalSec * 1000) return;
  try {
    app.screen = await runScreen(app.connection, (s) => console.log(s));
    app.screenAt = Date.now();
    registerTokens(app.screen);
    if (config.autoDeploy) deploySnapshot();
  } catch (err) {
    console.error(`[screen] failed: ${(err as Error).message}`);
    if (!app.screen) {
      app.screen = loadScreen();
      if (app.screen) console.log(`[screen] using saved screen from ${app.screen.generatedAt}`);
    }
  }
}

/** Pinned pools, pools we hold bands in, then the screener's best SOL-quoted picks up to the cap. */
function pickPools(app: App, withPositions: string[]): string[] {
  const set = new Set<string>([...config.pinnedPools, ...withPositions]);
  const candidates = (app.screen?.pools ?? []).filter(
    (p) => p.quoteSymbol === "SOL" && p.score > 0 && !p.flags.includes("thin") && !p.flags.includes("no-24h-data"),
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
      .filter((x) => x.address !== address && x.quoteSymbol === "SOL")
      .slice(0, 5)
      .map((x) => ({ name: x.name, score: x.score, feeToTvl24hPct: x.feeToTvl24hPct, tvlUsd: x.tvlUsd })),
  };
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
  if (exec.ok && exec.opened) state.entryValueSol[exec.opened.address] = exec.opened.entryValueSol;
  if (exec.ok && exec.closed) delete state.entryValueSol[exec.closed];
  saveState(state);
}

async function runPool(app: App, o: Observed, all: Observed[], sol: number): Promise<JournalEntry> {
  const ts = new Date().toISOString();
  const t0 = Date.now();
  const mode = config.dryRun ? "dry-run" : "live";
  const { snapshot, positions, raw } = o;
  const tag = `[cycle ${app.cycle} ${snapshot.label}]`;

  const [token, analytics] = await Promise.all([
    app.wallet.tokenBalance(new PublicKey(snapshot.baseToken.mint)),
    fetchPoolAnalytics(o.address, snapshot),
  ]);
  const state = loadState();
  const killSwitch = killSwitchActive();
  for (const p of positions) p.entryValueSol = state.entryValueSol[p.address];
  const others = all.filter((x) => x !== o);
  const portfolio = {
    activePools: all.map((x) => x.snapshot.label),
    poolsWithBands: others.filter((x) => x.positions.length > 0).length,
    maxActivePools: config.maxActivePools,
    otherExposureSol: others.reduce((s, x) => s + x.positions.reduce((t, p) => t + p.valueInSol, 0), 0),
  };
  const screen = screenContext(app, o.address);

  const observation: Observation = {
    ts,
    cycle: app.cycle,
    mode,
    poolLabel: snapshot.label,
    snapshot,
    positions,
    wallet: { address: app.wallet.publicKey.toBase58(), sol, token: token.ui, tokenSymbol: snapshot.baseToken.symbol },
    analytics,
    state: { actionsToday: state.actionsToday, lastActionAt: state.lastActionAt, lastPrice: state.lastPrice, killSwitch },
    recent: readRecent(40)
      .filter((e) => e.pool.address === o.address)
      .slice(0, 5)
      .map((e) => ({ ts: e.ts, action: e.decision.action, allowed: e.allowed, headline: e.headline, violations: e.violations })),
    screen,
    portfolio,
  };
  console.log(
    `${tag} active bin ${snapshot.activeBinId} price ${snapshot.activePrice.toPrecision(6)} ${snapshot.priceLabel} | screen ${screen ? `#${screen.rank} score ${screen.score}` : "n/a"} | wallet ${sol.toFixed(4)} SOL, ${token.ui.toFixed(2)} ${snapshot.baseToken.symbol} | bands ${positions.length}`,
  );

  const llm = await decide(observation);
  console.log(`${tag} ${config.agentName} proposes ${llm.decision.action} (${llm.source}): "${llm.decision.headline}"`);

  const verdict = evaluate(
    llm.decision,
    { now: Date.now(), snapshot, positions, walletSol: sol, walletToken: token.ui, state, killSwitch, ...portfolio },
    riskLimits,
  );
  if (verdict.overrides.length) console.log(`${tag} guard override: ${verdict.overrides.join("; ")}`);
  if (verdict.violations.length) console.log(`${tag} guards BLOCKED: ${verdict.violations.join("; ")}`);

  const execution = await execute(verdict, { dlmm: o.dlmm, wallet: app.wallet, rawPositions: raw, snapshot, positions });
  for (const t of execution.txs) {
    console.log(`${tag} ${execution.mode} ${t.label}: ${t.signature ?? t.skipped ?? (t.ok ? "simulated ok" : `FAILED ${t.error}`)}`);
  }
  updateState(state, execution, positions, snapshot);

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
  };
  appendJournal(entry);
  console.log(`${tag} final ${verdict.decision.action} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return entry;
}

async function runIteration(app: App): Promise<void> {
  await ensureScreen(app);

  const held = await DLMM.getAllLbPairPositionsByUser(app.connection, app.wallet.publicKey);
  const withPositions = [...held.entries()].filter(([, info]) => info.lbPairPositionsData.length > 0).map(([addr]) => addr);
  const pools = pickPools(app, withPositions);
  if (pools.length === 0) {
    console.log(`[cycle ${app.cycle}] nothing to work: no pinned pools, no bands held, no screen picks`);
    return;
  }
  console.log(`[cycle ${app.cycle}] working ${pools.length} pools (${withPositions.length} with bands)`);

  const observed: Observed[] = [];
  for (const address of pools) {
    try {
      const dlmm = await getDlmm(app, address);
      const snapshot = await getPoolSnapshot(dlmm, 10);
      const { raw, positions } = await getUserPositions(dlmm, app.wallet.publicKey, snapshot);
      observed.push({ address, dlmm, snapshot, raw, positions });
    } catch (err) {
      console.error(`[cycle ${app.cycle}] could not observe ${address}: ${(err as Error).message}`);
    }
  }
  // Pools holding a band are decided first: closes free capital for opens later in the pass.
  observed.sort((a, b) => b.positions.length - a.positions.length);
  for (const o of observed) {
    try {
      const sol = await app.wallet.solBalance();
      await runPool(app, o, observed, sol);
    } catch (err) {
      console.error(`[cycle ${app.cycle} ${o.snapshot.label}] failed:`, err);
    }
  }
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
  const app: App = { connection, wallet, cycle: 0, dlmms: new Map(), screen: loadScreen(), screenAt: 0 };
  if (app.screen) app.screenAt = new Date(app.screen.generatedAt).getTime();
  banner(app);
  if (config.servePort > 0) startServer(config.servePort);

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
    if (once || stopping) break;
    await sleepInterruptible(config.cycleIntervalSec * 1000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
