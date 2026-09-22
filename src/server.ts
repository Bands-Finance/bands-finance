/**
 * bands.finance API + static site.
 *   GET /api/health                             up, mode, and the last completed iteration
 *   GET /api/status                             his state at a glance: mode, kill switch, breakers, decider, the hour's decisions, what he learned
 *   GET /api/journal?limit=500&agent=mr-bands   entries, newest first
 *   GET /api/limits                             the hard risk limits in force
 *   GET /api/learning                           the knobs he has tuned, their evidence and the change journal
 *   GET /api/ledger?mode=live|dry-run           cash-boundary attribution rows + summary
 *   GET /api/engine                             breakers, bench, regime, watchdog
 *   GET /api/basis                              stock pools vs Backpack perps
 *   GET /api/hot                                pools surging in the last hour
 *   POST /api/account/challenge|link             wallet sign-in (src/platform/accounts.ts)
 *   /api/my-agent/*, /api/cli                     your own Mr Bands (src/platform/routes.ts)
 *   GET /api/feed.md                            the markdown feed
 *   /                                           web/dist (built dashboard), SPA fallback
 *
 * Standalone: `npm run serve`. Or set SERVE_PORT and `npm start` co-hosts it with the agent loop.
 */
import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { paperEnabled } from "./paper/env";
import { config, riskLimits } from "./config";
import { dataDir, readEquity, readRecent } from "./journal";
import { loadScreen } from "./screener";
import { setSolPriceUsd } from "./tools/dlmm";
import { engineRoutes } from "./engine/routes";
import { basisRoutes } from "./basis";
import { hotRoutes } from "./hot";
import { paperRoutes } from "./paper";
import { platformRoutes } from "./platform/routes";
import { deciderOf } from "./agent/decide";
import { openHermitAvailable } from "./agent/openhermit";
import { loadEngineState } from "./engine/breakers";
import { readLock } from "./engine/watchdog";
import { describeHalt, killSwitchSources } from "./risk/state";
import { decisionSources, readLearnedView, snapshot } from "./status";
import type { LearnedView } from "./learn/view";
import { railsRoutes } from "./platform/railsRoutes";

const modeOf = (): "paper" | "dry-run" | "live" => (paperEnabled(process.env, config.dryRun) ? "paper" : config.dryRun ? "dry-run" : "live");

/** The last completed iteration: the desk's own registry when it serves in-process, else the engine lock. */
function lastIterationAt(): number | null {
  return snapshot().lastIterationAt ?? readLock()?.lastIterationAt ?? null;
}

/**
 * What he has learned, as the API serves it: the same view the site and the MCP tool print, read
 * back off DATA_DIR/learning.jsonl (src/status.ts readLearnedView). The desk's own book is the only
 * mode accepted, so a paper-learned number never appears under a live desk's status.
 */
export function learningReport(now = Date.now()): LearnedView {
  return readLearnedView({ dir: dataDir(), mode: modeOf(), modelOn: openHermitAvailable() && deciderOf() === "openhermit", now });
}

/**
 * GET /api/status. Read-only, and on the loopback with the rest of the desk (SERVE_HOST). It names
 * whether an OpenHermit token is set and never what it is: no secret leaves through here. The
 * `learning` block is read-only too: it reports what the learner journalled and changes nothing.
 */
export function statusReport(now = Date.now()): Record<string, unknown> {
  const engine = loadEngineState();
  // the same sources killSwitchActive() halts on: the root STOP, this desk's DATA_DIR/STOP, KILL_SWITCH=true
  const halts = killSwitchSources();
  const hour = decisionSources(path.join(dataDir(), "decisions.jsonl"), now - 3_600_000);
  const snap = snapshot();
  return {
    now,
    mode: modeOf(),
    killSwitch: halts.length > 0,
    killSwitchSources: halts,
    killSwitchSource: halts.length ? describeHalt(halts) : null,
    circuit: {
      haltUntil: engine.circuit.haltUntil > 0 ? engine.circuit.haltUntil : null,
      halted: engine.circuit.haltUntil > now,
      stage: engine.circuit.stage,
      reason: engine.circuit.reason,
    },
    portfolio: {
      standDownUntil: engine.portfolio.standDownUntil > 0 ? engine.portfolio.standDownUntil : null,
      standingDown: engine.portfolio.standDownUntil > now,
      reason: engine.portfolio.standDownReason,
    },
    decider: deciderOf(),
    openhermitTokenPresent: openHermitAvailable(),
    decisionsLastHour: hour,
    learning: learningReport(now),
    ...snap,
    // the registry is empty in a server started alone: then the lock answers
    lastIterationAt: lastIterationAt(),
  };
}

export function buildApp(): Hono {
  const app = new Hono();
  // Platform routes snapshot pools for callers; USDC-quoted pools need the SOL price to be valued.
  setSolPriceUsd(loadScreen()?.solPriceUsd ?? null);
  // Wallet sessions send Authorization; x402 payers send X-Payment. Both must be allowed
  // or the first real payment is stranded (Meridian lost $5 this way).
  const corsPolicy = cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Payment", "Mcp-Session-Id"],
    exposeHeaders: ["Mcp-Session-Id", "X-Bands-Skill-Version"],
  });
  app.use("/api/*", corsPolicy);
  app.use("/mcp", corsPolicy);
  app.use("/integrate.md", corsPolicy);

  // The platform: security headers + rate buckets on /api/*, wallet sign-in, "your own Mr Bands"
  // (src/platform/routes.ts). Registered first so its middleware covers every route below.
  platformRoutes(app);
  // The rails: the MCP server at POST /mcp (the agent's hands on OpenHermit, and anyone's over x402),
  // the engine skill, proposals, revenue and credits (src/platform/railsRoutes.ts). Registered right
  // after the platform so its middleware covers them and no page fallback below can shadow /mcp.
  railsRoutes(app);

  app.get("/api/health", (c) => c.json({ ok: true, now: new Date().toISOString(), mode: modeOf(), lastIterationAt: lastIterationAt() }));

  app.get("/api/status", (c) => c.json(statusReport()));

  app.get("/api/journal", (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 500), 1), 5000);
    const agent = c.req.query("agent");
    let entries = readRecent(limit);
    if (agent) entries = entries.filter((e) => (e.agent?.id ?? "mr-bands") === agent);
    return c.json({ entries, generatedAt: new Date().toISOString() });
  });

  app.get("/api/equity", (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20_000), 1), 100_000);
    return c.json({ points: readEquity(limit), generatedAt: new Date().toISOString() });
  });

  app.get("/api/limits", (c) => c.json(riskLimits));

  // What he learned, on its own: the same block /api/status carries, for a caller that wants only this.
  app.get("/api/learning", (c) => c.json(learningReport()));

  app.get("/api/screen", (c) => {
    const screen = loadScreen();
    return screen ? c.json(screen) : c.json({ error: "no screen yet; run `npm run screen`" }, 404);
  });

  // The engine: cash-boundary ledger and breaker state (src/engine/routes.ts).
  engineRoutes(app);
  // Stock pools vs Backpack's perps: basis, session clock, funding (src/basis).
  basisRoutes(app);
  // The fast watch: pools surging in the last hour (src/hot).
  hotRoutes(app);
  // The paper book (virtual wallet + bands) when PAPER_SOL is set (src/paper).
  paperRoutes(app);

  app.get("/api/feed.md", (c) => {
    try {
      return c.text(fs.readFileSync(path.join(dataDir(), "feed.md"), "utf8"));
    } catch {
      return c.text("no journal yet\n", 404);
    }
  });

  const webRoot = "./web/dist";
  app.use("/*", serveStatic({ root: webRoot }));
  app.get("*", (c) => {
    const index = path.resolve(process.cwd(), webRoot, "index.html");
    if (fs.existsSync(index)) return c.html(fs.readFileSync(index, "utf8"));
    return c.text("Dashboard not built. Run `npm run web:build`, then reload. API is live at /api/journal.\n", 200);
  });
  return app;
}

export function startServer(port: number): void {
  const app = buildApp();
  const hostname = config.serveHost;
  serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(`bands.finance server listening on http://${hostname}:${info.port}${hostname === "127.0.0.1" ? "" : " (ALL INTERFACES: the rails are reachable from the network)"}`);
  });
}

if (require.main === module) {
  startServer(config.servePort > 0 ? config.servePort : 3000);
}
