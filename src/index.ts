/**
 * Scheduler. Each cycle: observe -> Mr Bands proposes -> guards decide -> execute -> journal.
 *   npm run once   one cycle
 *   npm start      loop every CYCLE_INTERVAL_SEC
 */
import DLMM from "@meteora-ag/dlmm";
import { Connection, PublicKey } from "@solana/web3.js";
import { config, riskLimits } from "./config";
import { decide } from "./agent/decide";
import type { Observation } from "./agent/observation";
import { evaluate } from "./risk/guards";
import { describeLimits } from "./risk/limits";
import { killSwitchActive, loadState, saveState, RiskState } from "./risk/state";
import { execute, ExecutionResult } from "./executor";
import { appendJournal, JournalEntry, readRecent } from "./journal";
import { getPoolSnapshot, getUserPositions, loadPool, PoolSnapshot, PositionSnapshot } from "./tools/dlmm";
import { fetchPoolAnalytics } from "./tools/lpagent";
import { Wallet } from "./tools/wallet";

interface App {
  connection: Connection;
  wallet: Wallet;
  dlmm: DLMM;
  cycle: number;
}

function banner(app: App): void {
  const mode = config.dryRun ? "DRY RUN (nothing is broadcast)" : "LIVE (real transactions)";
  console.log("=".repeat(72));
  console.log(`Mr Bands  |  ${mode}`);
  console.log(`pool      ${config.poolAddress}`);
  console.log(`wallet    ${app.wallet.publicKey.toBase58()}${app.wallet.ephemeral ? "  (ephemeral, no key configured)" : ""}`);
  console.log(`model     ${config.model}`);
  console.log(`interval  ${config.cycleIntervalSec}s`);
  console.log("limits");
  console.log(describeLimits(riskLimits).split("\n").map((l) => "  " + l).join("\n"));
  console.log("=".repeat(72));
}

function updateState(state: RiskState, exec: ExecutionResult, snapshot: PoolSnapshot, positions: PositionSnapshot[]): void {
  state.lastPrice = snapshot.activePrice;
  // Seed entry values for bands we are seeing for the first time so stop-loss has a baseline.
  for (const p of positions) {
    if (!(p.address in state.entryValueSol)) state.entryValueSol[p.address] = p.valueInSol;
  }
  // Forget bands that no longer exist on chain.
  const live = new Set(positions.map((p) => p.address));
  for (const addr of Object.keys(state.entryValueSol)) {
    if (!live.has(addr) && addr !== exec.opened?.address) delete state.entryValueSol[addr];
  }
  if (exec.txs.length > 0) {
    state.actionsToday += 1;
    state.lastActionAt = Date.now();
  }
  if (exec.ok && exec.opened) state.entryValueSol[exec.opened.address] = exec.opened.entryValueSol;
  if (exec.ok && exec.closed) delete state.entryValueSol[exec.closed];
  saveState(state);
}

async function runCycle(app: App): Promise<JournalEntry> {
  const ts = new Date().toISOString();
  const t0 = Date.now();
  const mode = config.dryRun ? "dry-run" : "live";

  // 1. Observe
  const snapshot = await getPoolSnapshot(app.dlmm, 10);
  const { raw, positions } = await getUserPositions(app.dlmm, app.wallet.publicKey, snapshot);
  const [sol, token, analytics] = await Promise.all([
    app.wallet.solBalance(),
    app.wallet.tokenBalance(new PublicKey(snapshot.baseToken.mint)),
    fetchPoolAnalytics(config.poolAddress, snapshot),
  ]);
  const state = loadState();
  const killSwitch = killSwitchActive();
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
    recent: readRecent(5).map((e) => ({ ts: e.ts, action: e.decision.action, allowed: e.allowed, headline: e.headline, violations: e.violations })),
  };
  console.log(
    `[cycle ${app.cycle}] ${snapshot.label} active bin ${snapshot.activeBinId} price ${snapshot.activePrice.toPrecision(6)} ${snapshot.priceLabel} | wallet ${sol.toFixed(4)} SOL, ${token.ui.toFixed(2)} ${snapshot.baseToken.symbol} | bands ${positions.length}`,
  );

  // 2. Propose
  const llm = await decide(observation);
  console.log(`[cycle ${app.cycle}] Mr Bands proposes ${llm.decision.action} (${llm.source}): "${llm.decision.headline}"`);

  // 3. Guards decide
  const verdict = evaluate(llm.decision, { now: Date.now(), snapshot, positions, walletSol: sol, walletToken: token.ui, state, killSwitch }, riskLimits);
  if (verdict.overrides.length) console.log(`[cycle ${app.cycle}] guard override: ${verdict.overrides.join("; ")}`);
  if (verdict.violations.length) console.log(`[cycle ${app.cycle}] guards BLOCKED: ${verdict.violations.join("; ")}`);

  // 4. Execute
  const execution = await execute(verdict, { dlmm: app.dlmm, wallet: app.wallet, rawPositions: raw, snapshot, positions });
  for (const t of execution.txs) {
    console.log(`[cycle ${app.cycle}] ${execution.mode} ${t.label}: ${t.signature ?? t.skipped ?? (t.ok ? "simulated ok" : `FAILED ${t.error}`)}`);
  }
  updateState(state, execution, snapshot, positions);

  // 5. Journal
  const { decision: _d, ...llmMeta } = llm;
  const entry: JournalEntry = {
    id: `${ts}-${app.cycle}`,
    ts,
    cycle: app.cycle,
    mode,
    pool: {
      address: snapshot.address,
      label: snapshot.label,
      activeBinId: snapshot.activeBinId,
      price: snapshot.activePrice,
      priceLabel: snapshot.priceLabel,
      binStep: snapshot.binStep,
      dynamicFeePct: snapshot.dynamicFeePct,
    },
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
  };
  appendJournal(entry);
  console.log(`[cycle ${app.cycle}] final ${verdict.decision.action} in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${config.dataDir}/feed.md`);
  return entry;
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
  const dlmm = await loadPool(connection, config.poolAddress);
  const app: App = { connection, wallet, dlmm, cycle: 0 };
  banner(app);

  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log("\nSIGINT: finishing the current cycle, then stopping. Press again to force quit.");
  });

  while (!stopping) {
    app.cycle += 1;
    try {
      await runCycle(app);
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
