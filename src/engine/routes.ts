/**
 * Engine read routes for the bands.finance API. The integrator mounts them from src/server.ts:
 *   import { engineRoutes } from "./engine/routes";  engineRoutes(app);
 *
 *   GET /api/ledger?mode=live|dry-run   { rows, summary }   the attribution ledger, one mode at a time
 *   GET /api/engine                      breaker, bench, regime (last persisted), watchdog and settings
 *
 * Read-only: nothing here writes state. Live and dry-run rows are never mixed in one response.
 */
import type { Hono } from "hono";
import { config, riskLimits } from "../config";
import { loadState } from "../risk/state";
import { benchView, circuitHalted, loadEngineState, standingDown } from "./breakers";
import { collectsOnDay, dayOf, ledgerRowsView, rowsOf, summary, type LedgerMode } from "./ledger";
import { loopStale, readLock, staleWindowMs } from "./watchdog";

function modeOf(q: string | undefined): LedgerMode {
  return q === "live" ? "live" : q === "dry-run" ? "dry-run" : config.dryRun ? "dry-run" : "live";
}

export function engineRoutes(app: Hono): void {
  app.get("/api/ledger", (c) => {
    const mode = modeOf(c.req.query("mode"));
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 500), 1), 5000);
    const all = rowsOf(ledgerRowsView.get(), mode);
    const state = loadState();
    return c.json({
      mode,
      rows: all.slice(-limit).reverse(),
      summary: summary(all, mode, state.entryValueSol),
      generatedAt: new Date().toISOString(),
    });
  });

  app.get("/api/engine", (c) => {
    const now = Date.now();
    const mode: LedgerMode = config.dryRun ? "dry-run" : "live";
    const engine = loadEngineState();
    const state = loadState();
    const lock = readLock();
    const windowMs = staleWindowMs(config.cycleIntervalSec);
    const rows = ledgerRowsView.get();
    return c.json({
      now,
      mode,
      halt: circuitHalted(engine.circuit, now)
        ? { until: engine.circuit.haltUntil, stage: engine.circuit.stage, reason: engine.circuit.reason }
        : null,
      circuit: engine.circuit,
      standDown: standingDown(engine.portfolio, now) ? { until: engine.portfolio.standDownUntil, reason: engine.portfolio.standDownReason } : null,
      portfolio: engine.portfolio,
      bench: Object.fromEntries(Object.keys(engine.stopTimes).map((pool) => [pool, benchView(engine, pool, now)])),
      stops: state.stops ?? {},
      outOfRangeSince: state.outOfRangeSince ?? {},
      collectsToday: collectsOnDay(rows, mode, dayOf(now)),
      watchdog: lock
        ? { ...lock, windowMs, stale: loopStale(lock, now, windowMs), heartbeatAgeSec: Math.round((now - lock.heartbeat) / 1000) }
        : { held: false, windowMs },
      settings: {
        ...config.engine,
        treasuryAddress: config.engine.treasuryAddress || null,
        expectedWallet: config.engine.expectedWallet || null,
        stopLossPct: riskLimits.stopLossPct,
        maxPositionSol: riskLimits.maxPositionSol,
      },
    });
  });
}
