/**
 * Go-live preflight. Reads the environment, the chain and the data files and prints a checklist:
 * PASS / WARN / FAIL per item, and a verdict. Exit code 1 on any FAIL so `npm run live` can refuse.
 *   npm run preflight
 * Nothing here moves money. The Anthropic check sends one tiny request (a few tokens).
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import Anthropic from "@anthropic-ai/sdk";
import { config, riskLimits } from "../config";
import { LOCK_FILE, lockBlocks, pidAlive, readLock, staleWindowMs } from "../engine/watchdog";
import { loadKeypair } from "../tools/wallet";
import { policyMayTradeLive } from "../agent/decide";
import { loadScreen } from "../screener";
import { loadHot } from "../hot";
import { loadEngineState, circuitHalted, standingDown } from "../engine/breakers";
import { killSwitchActive } from "../risk/state";
import { OPEN_COST_ESTIMATE_SOL, USDC_MINT } from "../tools/dlmm";
import { paperEnabled, paperEnv } from "../paper/env";

type Level = "PASS" | "WARN" | "FAIL";
interface Check { name: string; level: Level; detail: string }
const checks: Check[] = [];
const add = (name: string, level: Level, detail: string) => checks.push({ name, level, detail });
const ageMin = (iso: string | undefined) => (iso ? (Date.now() - new Date(iso).getTime()) / 60000 : Infinity);

async function main(): Promise<void> {
  const dataDir = path.resolve(process.cwd(), config.dataDir);

  // 1. Mode and switches
  const paper = paperEnv();
  // the same predicate the loop uses (src/paper/env.ts): a paper book needs PAPER_SOL > 0 AND DRY_RUN
  const paperOn = paperEnabled(process.env, config.dryRun);
  add("mode", config.dryRun ? "WARN" : "PASS", config.dryRun ? `DRY_RUN is on: nothing is broadcast${paperOn ? "" : " (set DRY_RUN=false to go live)"}` : "DRY_RUN=false: transactions WILL be broadcast");
  if (paperOn) add("paper book", "PASS", `virtual wallet ${paper.sol} SOL + ${paper.usdc} USDC: real pools and prices, pretend money (PAPER_SOL / PAPER_USDC)`);
  else if (paper.usdc > 0 && paper.sol <= 0) add("paper book", "FAIL", `PAPER_USDC=${paper.usdc} without PAPER_SOL: the loop keys paper mode off PAPER_SOL alone, so this would ${config.dryRun ? "dry-run" : "trade LIVE"} with no paper book`);
  else if (paper.sol > 0 && !config.dryRun) add("paper book", "FAIL", `PAPER_SOL=${paper.sol} with DRY_RUN=false: the loop refuses to start (paper runs only under DRY_RUN)`);
  // The kill switch stops new bands; it does not stop the desk WATCHING. On a live desk it is still a
  // refusal to boot - you meant to halt, and a restart must not quietly undo that. On a paper or dry-run
  // desk it is a warning: the loop honours the switch by itself ("Engine says no opens here"), and a
  // gate here would mean the desk stops observing and journalling the moment launchd restarts it.
  const halted = killSwitchActive();
  const haltLevel: Level = !halted ? "PASS" : config.dryRun ? "WARN" : "FAIL";
  add("kill switch", haltLevel, halted ? `STOP file or KILL_SWITCH=true is set: no new bands${config.dryRun ? " (the desk still watches and journals)" : ""}` : "clear");
  const lockFile = path.join(dataDir, LOCK_FILE);
  const lockCheck = (wallet: string | null): void => {
    if (!fs.existsSync(lockFile)) {
      add("engine lock", "PASS", "free");
      return;
    }
    const l = readLock(lockFile);
    if (!l) {
      add("engine lock", "WARN", "unreadable lock file");
      return;
    }
    // the watchdog's own rule (src/engine/watchdog.ts): a dead pid or another wallet's lock does not block
    const blocks = lockBlocks(l, wallet ?? l.wallet, Date.now(), staleWindowMs(config.cycleIntervalSec), process.pid, pidAlive);
    add("engine lock", blocks ? "WARN" : "PASS", blocks ? `another process (pid ${l.pid}) holds this wallet; only one may run` : pidAlive(l.pid) ? `held by pid ${l.pid} for a different wallet (${l.wallet.slice(0, 6)}...)` : "stale lock (its process is gone), will be replaced");
  };

  // 2. Wallet
  let pubkey: PublicKey | null = null;
  if (!config.walletSecretKey) add("wallet key", config.dryRun ? "WARN" : "FAIL", "WALLET_SECRET_KEY is empty (dry-run uses a throwaway key)");
  else {
    try {
      pubkey = loadKeypair(config.walletSecretKey).publicKey;
      add("wallet key", "PASS", `loads; address ${pubkey.toBase58()}`);
    } catch (err) {
      add("wallet key", "FAIL", `does not parse: ${(err as Error).message}`);
    }
  }
  lockCheck(pubkey?.toBase58() ?? null);
  if (config.engine.expectedWallet) {
    const ok = pubkey?.toBase58() === config.engine.expectedWallet;
    add("EXPECTED_WALLET", ok ? "PASS" : "FAIL", ok ? "matches the loaded key" : `does not match the loaded key (${pubkey?.toBase58() ?? "none"})`);
  } else add("EXPECTED_WALLET", "WARN", "not set: pin the address so a wrong key cannot trade");

  // 3. RPC
  const connection = new Connection(config.rpcUrl, "confirmed");
  const publicRpc = /api\.mainnet-beta\.solana\.com/.test(config.rpcUrl);
  try {
    const t0 = Date.now();
    const slot = await connection.getSlot("confirmed");
    add("rpc", publicRpc ? "WARN" : "PASS", `${publicRpc ? "PUBLIC endpoint (rate-limited, 429s under load); use Helius or another dedicated RPC" : "dedicated endpoint"}; slot ${slot} in ${Date.now() - t0} ms`);
  } catch (err) {
    add("rpc", "FAIL", `unreachable: ${(err as Error).message.slice(0, 80)}`);
  }

  // 4. Balances vs limits
  let sol = 0;
  if (pubkey) {
    try {
      sol = (await connection.getBalance(pubkey, "confirmed")) / LAMPORTS_PER_SOL;
      const need = riskLimits.maxTotalExposureSol + riskLimits.gasReserveSol + config.maxActivePools * OPEN_COST_ESTIMATE_SOL;
      const level: Level = paperOn ? "PASS" : sol === 0 ? (config.dryRun ? "WARN" : "FAIL") : sol < need ? "WARN" : "PASS";
      add("SOL balance", level, `${sol.toFixed(4)} SOL${paperOn ? " on chain (the paper book spends its own virtual SOL)" : ""}; the limits assume ${need.toFixed(2)} SOL (exposure ${riskLimits.maxTotalExposureSol} + gas reserve ${riskLimits.gasReserveSol} + rent for ${config.maxActivePools} bands)`);
    } catch (err) {
      add("SOL balance", "FAIL", `could not read: ${(err as Error).message.slice(0, 80)}`);
    }
    // USDC: the stock pools the desk works are mostly USDC-quoted; without it only SOL pools can be seated
    if (!paperOn) {
      try {
        const res = await connection.getParsedTokenAccountsByOwner(pubkey, { mint: new PublicKey(USDC_MINT) }, "confirmed");
        const usdc = res.value.reduce((t, a) => t + Number(a.account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0), 0);
        add("USDC balance", usdc > 0 ? "PASS" : "WARN", `${usdc.toFixed(2)} USDC${usdc > 0 ? "" : ": USDC-quoted stock pools (AMD, SKHY, MU, NVDAx/USDC) cannot be seated without it"}`);
      } catch (err) {
        add("USDC balance", "WARN", `could not read: ${(err as Error).message.slice(0, 80)}`);
      }
    }
  }
  add("limits", riskLimits.maxPositionSol * config.maxActivePools <= riskLimits.maxTotalExposureSol + 1e-9 ? "PASS" : "WARN",
    `per band ${riskLimits.maxPositionSol} SOL x ${config.maxActivePools} pools vs total ${riskLimits.maxTotalExposureSol} SOL; stop ${riskLimits.stopLossPct}%; ${riskLimits.maxTxPerDay} actions/day, ${riskLimits.minSecondsBetweenActions}s apart`);

  // 5. The model
  if (!config.anthropicApiKey && !process.env.ANTHROPIC_AUTH_TOKEN) {
    // Without a key the deterministic desk policy (src/agent/policy.ts) proposes instead of the model.
    // That is a working desk, so it is only a failure when real money is at stake.
    // Live, the desk policy only opens and re-centres with POLICY_LIVE=true (src/agent/decide.ts); without it every open holds.
    const policyLive = policyMayTradeLive();
    add(
      "anthropic",
      config.dryRun || policyLive ? "WARN" : "FAIL",
      `ANTHROPIC_API_KEY is empty: the desk policy proposes instead of ${config.agentName}${config.dryRun ? " (fine for paper and dry runs)" : policyLive ? " (POLICY_LIVE=true: it trades real money)" : "; set a key, or POLICY_LIVE=true to let the policy trade, or every open holds"}`,
    );
  } else {
    try {
      const client = new Anthropic(config.anthropicApiKey ? { apiKey: config.anthropicApiKey } : {});
      const r = await client.messages.create({ model: config.model, max_tokens: 5, messages: [{ role: "user", content: "Reply with the single word: ready" }] });
      const text = r.content.map((c) => ("text" in c ? c.text : "")).join("").trim();
      add("anthropic", "PASS", `${config.model} answered "${text.slice(0, 20)}"`);
    } catch (err) {
      add("anthropic", "FAIL", `${config.model}: ${(err as Error).message.slice(0, 100)}`);
    }
  }

  // 6. Data feeds
  const screen = loadScreen();
  // a missing screen is not a failure: the loop screens before its first cycle (ensureScreen in src/index.ts)
  add("screen", !screen ? "WARN" : ageMin(screen.generatedAt) > 60 ? "WARN" : "PASS", screen ? `${screen.rankedPools} ranked, ${ageMin(screen.generatedAt).toFixed(0)} min old, SOL $${screen.solPriceUsd?.toFixed(2) ?? "n/a"}` : "no screen.json yet (the loop writes it before its first cycle; `npm run screen` to see the board now)");
  const hot = loadHot();
  add("hot watch", !hot ? "WARN" : ageMin(hot.generatedAt) > 15 ? "WARN" : "PASS", hot ? `${hot.rows.length} rows, ${ageMin(hot.generatedAt).toFixed(0)} min old` : "no data/hot.json yet (the loop writes it on start)");
  const basisFile = path.join(dataDir, "basis.json");
  add("basis", fs.existsSync(basisFile) ? "PASS" : "WARN", fs.existsSync(basisFile) ? "present" : "no data/basis.json yet (stock pools are refused until the loop writes it)");

  // 7. Breakers
  const engine = loadEngineState();
  const now = Date.now();
  add("circuit breaker", circuitHalted(engine.circuit, now) ? "WARN" : "PASS", circuitHalted(engine.circuit, now) ? `halted until ${new Date(engine.circuit.haltUntil).toISOString()}` : "clear");
  add("portfolio breaker", standingDown(engine.portfolio, now) ? "WARN" : "PASS", standingDown(engine.portfolio, now) ? `standing down until ${new Date(engine.portfolio.standDownUntil).toISOString()}` : "clear");

  // 8. Dormant layers
  add("hedge", process.env.HEDGE_LIVE === "true" ? "WARN" : "PASS", process.env.HEDGE_LIVE === "true" ? "HEDGE_LIVE=true: Backpack orders will be placed when keys are set" : "off (Backpack hedging dormant)");
  add("skim", config.engine.skim && config.engine.treasuryAddress ? "WARN" : "PASS", config.engine.skim && config.engine.treasuryAddress ? `on -> ${config.engine.treasuryAddress}` : "off");

  const width = Math.max(...checks.map((c) => c.name.length));
  console.log("=".repeat(96));
  console.log(`PREFLIGHT  ${config.agentName}  ${new Date().toISOString()}`);
  console.log("=".repeat(96));
  for (const c of checks) console.log(`${c.level.padEnd(4)}  ${c.name.padEnd(width)}  ${c.detail}`);
  const fails = checks.filter((c) => c.level === "FAIL").length;
  const warns = checks.filter((c) => c.level === "WARN").length;
  console.log("=".repeat(96));
  console.log(fails ? `NOT READY: ${fails} failing, ${warns} warnings` : warns ? `READY WITH ${warns} WARNING(S)` : "READY");
  if (fails) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
