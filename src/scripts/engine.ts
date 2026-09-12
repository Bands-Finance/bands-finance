/**
 * Operator levers for the engine (src/engine). Port of Meridian's /api/admin/clear-halt and
 * clearPortfolioStandDown: the breakers do not clear themselves, the operator does.
 *   tsx src/scripts/engine.ts status            print breaker, bench, watchdog and ledger state
 *   tsx src/scripts/engine.ts clear-standdown   lift the portfolio breaker stand-down
 *   tsx src/scripts/engine.ts clear-halt        lift a circuit-breaker halt
 */
import { config } from "../config";
import { benchView, clearHalt, clearStandDown, loadEngineState, saveEngineState } from "../engine/breakers";
import { collectsOnDay, dayOf, readLedgerRows, summary } from "../engine/ledger";
import { loopStale, readLock, staleWindowMs } from "../engine/watchdog";
import { loadState } from "../risk/state";

const iso = (ms: number) => (ms > 0 ? new Date(ms).toISOString() : "n/a");

function status(): void {
  const now = Date.now();
  const e = loadEngineState();
  const s = loadState();
  const mode = config.dryRun ? "dry-run" : "live";
  const rows = readLedgerRows();
  const c = e.circuit;
  const p = e.portfolio;
  console.log(`engine status (${mode}) at ${new Date(now).toISOString()}`);
  console.log(`circuit    ${now < c.haltUntil ? `HALTED stage ${c.stage} until ${iso(c.haltUntil)}` : "clear"} | trips today ${c.trips} | last loss ${c.lastLossSol.toFixed(4)} / limit ${c.lastLimitSol.toFixed(4)} SOL | last mark ${c.lastMarkAt ? iso(c.lastMarkAt) : "never"}`);
  if (c.reason) console.log(`           ${c.reason}`);
  console.log(`portfolio  ${now < p.standDownUntil ? `STANDING DOWN until ${iso(p.standDownUntil)}` : "clear"} | day high ${p.hwmSol.toFixed(4)} SOL | last equity ${p.lastEquitySol.toFixed(4)} | drawdown ${p.lastDrawdownSol.toFixed(4)} / limit ${p.lastLimitSol.toFixed(4)} | streak ${p.streak}`);
  if (p.standDownReason) console.log(`           ${p.standDownReason}`);
  const pools = Object.keys(e.stopTimes);
  console.log(`bench      ${pools.length === 0 ? "no stops recorded" : pools.map((pool) => `${pool.slice(0, 6)}: ${benchView(e, pool, now).reason ?? "clear"}`).join(" | ")}`);
  const stops = s.stops ?? {};
  console.log(`stops      ${Object.keys(stops).length === 0 ? "none" : Object.entries(stops).map(([k, v]) => `${k.slice(0, 6)} -${v}%`).join(", ")}`);
  console.log(`collects   ${collectsOnDay(rows, mode, dayOf(now))}/${config.engine.collectMaxPerDay} today`);
  const lock = readLock();
  const windowMs = staleWindowMs(config.cycleIntervalSec);
  console.log(`watchdog   ${lock ? `pid ${lock.pid} wallet ${lock.wallet.slice(0, 6)} heartbeat ${Math.round((now - lock.heartbeat) / 1000)}s ago${loopStale(lock, now, windowMs) ? " STALE" : ""}` : "no lock held"} (window ${Math.round(windowMs / 1000)}s)`);
  const sum = summary(rows, mode, s.entryValueSol);
  console.log(`ledger     ${sum.rows} ${mode} rows | exact net cash ${sum.exact.netCashSol.toFixed(6)} SOL (${sum.exact.rows} rows) | fees realized ${sum.feesRealizedSol.toFixed(6)} SOL | marked inventory ${sum.marked.inventorySol.toFixed(6)} SOL | working ${sum.workingSol.toFixed(4)} SOL`);
  console.log(`skim       ${config.engine.skim && config.engine.treasuryAddress ? `on -> ${config.engine.treasuryAddress}` : "off"}`);
}

function main(): void {
  const cmd = process.argv[2] ?? "status";
  if (cmd === "status") return status();
  const e = loadEngineState();
  if (cmd === "clear-standdown") {
    const r = clearStandDown(e);
    saveEngineState(e);
    console.log(r.cleared ? `stand-down cleared (was until ${iso(r.wasStoodDownUntil)}); the next mark re-seeds the day's high-water` : "no stand-down was active");
    return;
  }
  if (cmd === "clear-halt") {
    const r = clearHalt(e);
    saveEngineState(e);
    console.log(r.cleared ? `halt cleared (was until ${iso(r.wasHaltedUntil)})` : "no halt was active");
    return;
  }
  console.error(`unknown command "${cmd}": use status | clear-standdown | clear-halt`);
  process.exit(2);
}

main();
