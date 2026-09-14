/**
 * bands.finance API + static site.
 *   GET /api/health
 *   GET /api/journal?limit=500&agent=mr-bands   entries, newest first
 *   GET /api/limits                             the hard risk limits in force
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
import { dataDir, readRecent } from "./journal";
import { loadScreen } from "./screener";
import { setSolPriceUsd } from "./tools/dlmm";
import { engineRoutes } from "./engine/routes";
import { basisRoutes } from "./basis";
import { hotRoutes } from "./hot";
import { paperRoutes } from "./paper";
import { platformRoutes } from "./platform/routes";

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

  app.get("/api/health", (c) => c.json({ ok: true, now: new Date().toISOString(), mode: paperEnabled(process.env, config.dryRun) ? "paper" : config.dryRun ? "dry-run" : "live" }));

  app.get("/api/journal", (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 500), 1), 5000);
    const agent = c.req.query("agent");
    let entries = readRecent(limit);
    if (agent) entries = entries.filter((e) => (e.agent?.id ?? "mr-bands") === agent);
    return c.json({ entries, generatedAt: new Date().toISOString() });
  });

  app.get("/api/limits", (c) => c.json(riskLimits));

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
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`bands.finance server listening on http://localhost:${info.port}`);
  });
}

if (require.main === module) {
  startServer(config.servePort > 0 ? config.servePort : 3000);
}
