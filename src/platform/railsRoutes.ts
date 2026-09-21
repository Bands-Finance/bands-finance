/**
 * The payment rails and agent-facing surfaces, mounted on the Hono app by the integrator:
 * `railsRoutes(app)` from src/server.ts. Ports from Meridian's agent/src/index.ts:
 * checkPayment (L371-399), mcpRequestAllowed (L310-318), mcpAudience (L336-338), the
 * POST /mcp session handling (L2826-2908; single JSON-RPC messages only, batches refused so
 * a batch cannot skip the gate), the engine routes (L2534-2717) and the proposals routes.
 * The MCP transport is the SDK's Web-Standard StreamableHTTP transport, which takes Hono's
 * Fetch Request directly; no Node req/res adapter is involved.
 *
 * Route table (auth · price · codes):
 *   POST /mcp                       x402 for priced tools (the operator and house bearers pass it: the house does not pay itself); operator bearer for operator-only tools · 400 batch/parse/no-session, 401, 402, 503 session cap
 *   GET|DELETE /mcp                 session id required · 400
 *   GET  /api/engine/access         session · 200 {ok,hasAccess,via,paths,detail} · 401
 *   GET  /api/engine/skill          session + access · text/markdown + X-Bands-Skill-Version · 401, 403, 503
 *   POST /api/engine/plan           session + access · 200 {ok,chainId,steps,verdict,note} or 200 {ok:false,verdict} · 400, 401, 403
 *   GET  /api/engine/positions      session + access · 200 {ok,positions} · 401, 403, 502
 *   POST /api/engine/collect|close  session + access · 200 plan · 400, 401, 403, 502
 *   GET  /api/proposals             public · 200 {ok,proposals}
 *   POST /api/proposals             session · 200 {ok,proposal} or {dryRun,...} · 400, 401
 *   POST /api/proposals/decide      operator bearer · 200 {ok,proposal} · 400, 401, 404
 *   GET  /api/revenue               public · 200 {ok,totalUsd,byTool,x402,prices}
 *   POST /api/revenue/settle        operator bearer · 200 {ok,payer,signature} · 400, 401
 *   POST /api/credits/buy           session · 402 challenge, then 200 {ok,pack,credits,balance} · 400, 401, 402
 *   GET  /integrate.md              public · text/markdown
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Connection, PublicKey } from "@solana/web3.js";
import type { Context, Hono } from "hono";
import { config } from "../config";
import { requireWallet } from "./accounts";
import { PACKS, addPurchase } from "./credits";
import { decreaseSteps, hasEngineAccess, parseSkillVersion, planOpenSteps, positionsFor, validatePlanInput } from "./engineSkill";
import { renderIntegrationDoc } from "./integrationDoc";
import { OPERATOR_ONLY_TOOLS, TOOL_PRICES_USD, buildServer, houseAuthorized, houseToken, operatorAuthorized, toolPriceUsd, type McpAudience } from "./mcp/server";
import { PaymentGate, SOLANA_MAINNET_CAIP2, USDC_MINT } from "./payments/PaymentGate";
import { RevenueLedger } from "./payments/RevenueLedger";
import { decideProposal, listProposals, mcpProposerId, previewProposal, submitProposal, type ProposalStatus } from "./proposals";

interface JsonRpcLike {
  method?: string;
  params?: { name?: string };
}

/**
 * MCP access policy, evaluated per tool call. Session plumbing (initialize, tools/list,
 * notifications, ping) and data tools are open (x402 is the paywall); operator-only tools
 * require the operator bearer. With no PLATFORM_OPERATOR_TOKEN configured nobody passes.
 */
export function mcpRequestAllowed(body: unknown, authorization: string | undefined): boolean {
  const b = body as JsonRpcLike | null;
  if (b?.method !== "tools/call") return true;
  const tool = b.params?.name ?? "";
  if (OPERATOR_ONLY_TOOLS.has(tool)) return operatorAuthorized(authorization);
  return true;
}

/** Which tool list a session is served. NOT a gate: mcpRequestAllowed still runs on every tools/call. */
export function mcpAudience(authorization: string | undefined): McpAudience {
  if (operatorAuthorized(authorization)) return "operator";
  if (houseAuthorized(authorization)) return "house";
  return "public";
}

export interface Paywall {
  status: 402;
  body: unknown;
}

/**
 * x402 gating for priced tools. MCP multiplexes every tool call through one JSON-RPC
 * endpoint, so gating happens here rather than per route: peek at tools/call requests and,
 * for a priced tool, require a verified X-PAYMENT before the request reaches the transport.
 * Free tools and every other method pass straight through. Returns the 402 to send, or
 * null when the request may proceed. A stub-mode acceptance is not recorded as revenue:
 * the ledger is the truth, and nothing arrived.
 *
 * The operator and house bearers pass the paywall outright: the house's own agent (Mr Bands
 * on OpenHermit, reasoning through this very server with the house token) must not pay
 * itself, and a payment it did send would be revenue from our own treasury to our own
 * treasury. The checks are the same constant-time match that guards operator-only tools; a
 * wrong bearer is a stranger and pays like one. Nothing else about the paywall changes.
 */
export async function checkPayment(gate: PaymentGate, revenue: RevenueLedger, body: unknown, paymentHeader: string | undefined, authorization?: string | undefined): Promise<Paywall | null> {
  const b = body as JsonRpcLike | null;
  if (b?.method !== "tools/call") return null;
  const tool = b.params?.name ?? "";
  const priceUsd = toolPriceUsd(tool);
  if (!priceUsd) return null;
  if (operatorAuthorized(authorization) || houseAuthorized(authorization)) return null;
  if (!paymentHeader) return { status: 402, body: gate.requirements(priceUsd, tool) };
  const result = await gate.verify(paymentHeader, priceUsd, tool);
  if (!result.ok) return { status: 402, body: { ok: false, error: result.error } };
  if (!result.stub) revenue.record(tool, priceUsd, result.signature);
  return null;
}

const MCP_MAX_SESSIONS = 200;
const MCP_SESSION_IDLE_MS = 30 * 60 * 1000;
const SKILL_MD_PATH = () => path.resolve(process.cwd(), "skills", "bands-engine", "SKILL.md");

function rpcError(c: Context, status: 400 | 503, code: number, message: string) {
  return c.json({ jsonrpc: "2.0", error: { code, message }, id: null }, status);
}

/** The origin this request was served from, honouring a reverse proxy's forwarded headers. */
function publicBase(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0].trim() || url.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host")?.split(",")[0].trim() || c.req.header("host") || url.host;
  return `${proto}://${host}`;
}

const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function railsRoutes(app: Hono): void {
  let conn: Connection | null = null;
  const connection = () => (conn ??= new Connection(config.rpcUrl, "confirmed"));
  // Throws on a malformed X402_TREASURY / X402_VERIFY: better to refuse to boot than to
  // quote every payer a treasury that is not ours.
  const gate = PaymentGate.fromEnv(connection);
  const revenue = new RevenueLedger();
  console.log(
    `[rails] x402 ${gate.mode}${gate.treasuryAta ? ` · payTo ${gate.treasuryAta}` : ""} · operator bearer ${process.env.PLATFORM_OPERATOR_TOKEN ? "set" : "UNSET (operator routes closed)"} · house bearer ${
      houseToken() ? "set" : process.env.PLATFORM_HOUSE_TOKEN?.trim() ? "IGNORED (same as the operator's)" : "UNSET (the gateway agent pays like anyone)"
    } · engine ${
      process.env.ENGINE_OPEN?.trim().toLowerCase() === "true" ? "open" : process.env.ENGINE_ALLOWLIST ? "allowlist" : "closed"
    }`,
  );

  // ---------------------------------------------------------------------------------
  // MCP. One transport + server per session; sessions are keyed by the id the SDK mints.
  // ---------------------------------------------------------------------------------
  const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; lastSeenAt: number }>();
  const sweepSessions = () => {
    const cutoff = Date.now() - MCP_SESSION_IDLE_MS;
    for (const [id, s] of sessions) if (s.lastSeenAt < cutoff) sessions.delete(id);
  };
  const touch = (id: string | undefined) => {
    const s = id ? sessions.get(id) : undefined;
    if (s) s.lastSeenAt = Date.now();
    return s?.transport;
  };

  app.post("/mcp", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return rpcError(c, 400, -32700, "parse error: the body must be one JSON-RPC message");
    }
    // Batches are refused because both gates below decide by reading body.method and an
    // array has none: a batched [{...tools/call...}] would sail past the operator gate AND
    // the paywall and still be dispatched element by element by the transport.
    if (Array.isArray(body)) return rpcError(c, 400, -32600, "batched requests are not accepted; send one JSON-RPC message per request");
    const auth = c.req.header("authorization");
    if (!mcpRequestAllowed(body, auth)) return c.json({ error: "this tool is operator-only; data tools need no auth, just x402 payment" }, 401);
    const paywall = await checkPayment(gate, revenue, body, c.req.header("x-payment"), auth);
    if (paywall) return c.json(paywall.body, paywall.status);

    const sessionId = c.req.header("mcp-session-id");
    let transport = touch(sessionId);
    if (!transport) {
      if (sessionId || !isInitializeRequest(body)) return rpcError(c, 400, -32000, "No valid session; send an initialize request first");
      if (sessions.size >= MCP_MAX_SESSIONS) sweepSessions();
      if (sessions.size >= MCP_MAX_SESSIONS) {
        console.error(`[bands-mcp] session cap reached (${sessions.size}/${MCP_MAX_SESSIONS}), refusing new sessions`);
        return rpcError(c, 503, -32000, "too many open MCP sessions right now, try again shortly");
      }
      // The audience is fixed here, at initialize, and logged so the desk's log shows
      // which sessions were the house's own agent and which were the public.
      const audience = mcpAudience(auth);
      const t = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessions.set(id, { transport: t, lastSeenAt: Date.now() });
          console.log(`[bands-mcp] session ${id.slice(0, 8)} opened · audience ${audience} · ${sessions.size}/${MCP_MAX_SESSIONS} open`);
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });
      t.onclose = () => {
        if (t.sessionId) sessions.delete(t.sessionId);
      };
      // A session's proposer identity is fixed at initialize: a hash of its bearer when it
      // sent one, else the tool hashes the claimed agent name per call.
      const m = auth ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null;
      await buildServer({ audience, proposerId: m ? mcpProposerId(`bearer:${m[1]}`) : undefined, connection }).connect(t);
      transport = t;
    }
    try {
      return await transport.handleRequest(c.req.raw, { parsedBody: body });
    } catch (err) {
      console.error("[bands-mcp] request error:", err);
      return c.json({ error: "internal error" }, 500);
    }
  });

  // GET (server-initiated stream) and DELETE (session teardown) reuse the session transport.
  const replay = async (c: Context) => {
    const transport = touch(c.req.header("mcp-session-id"));
    if (!transport) return c.json({ error: "unknown or missing session id" }, 400);
    return transport.handleRequest(c.req.raw);
  };
  app.get("/mcp", replay);
  app.delete("/mcp", replay);

  // ---------------------------------------------------------------------------------
  // Engine skill: advise-then-approve for any signed-in wallet with access.
  // ---------------------------------------------------------------------------------
  const engineCaller = (c: Context): { ok: true; wallet: string } | { ok: false; res: Response } => {
    const wallet = requireWallet(c.req.header("authorization"));
    if (!wallet) return { ok: false, res: c.json({ ok: false, error: "sign in with your wallet first" }, 401) };
    const access = hasEngineAccess(wallet);
    if (!access.ok) return { ok: false, res: c.json({ ok: false, error: access.detail }, 403) };
    return { ok: true, wallet };
  };

  app.get("/api/engine/access", (c) => {
    const wallet = requireWallet(c.req.header("authorization"));
    if (!wallet) return c.json({ ok: false, error: "sign in with your wallet first" }, 401);
    const a = hasEngineAccess(wallet);
    return c.json({ ok: true, hasAccess: a.ok, via: a.via, paths: a.paths, detail: a.detail });
  });

  // Read from disk on every request: the file is the single source of truth, so a change
  // reaches every agent on its next fetch. The frontmatter version is how they notice.
  app.get("/api/engine/skill", (c) => {
    const g = engineCaller(c);
    if (!g.ok) return g.res;
    let content: string;
    try {
      content = fs.readFileSync(SKILL_MD_PATH(), "utf8");
    } catch {
      return c.json({ ok: false, error: "the skill file is not deployed on this instance" }, 503);
    }
    return c.body(content, 200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "X-Bands-Skill-Version": parseSkillVersion(content),
      "Cache-Control": "no-store",
    });
  });

  app.post("/api/engine/plan", async (c) => {
    const g = engineCaller(c);
    if (!g.ok) return g.res;
    const v = validatePlanInput(await jsonBody(c));
    if (!v.ok) return c.json({ ok: false, error: v.error }, 400);
    try {
      return c.json(await planOpenSteps(connection(), new PublicKey(g.wallet), v.input));
    } catch (err) {
      // User-facing problems (not a SOL pair, pool not found) and RPC faults both land here;
      // the message is written to be shown as-is.
      return c.json({ ok: false, error: err instanceof Error ? err.message : "could not build the plan" }, 400);
    }
  });

  app.get("/api/engine/positions", async (c) => {
    const g = engineCaller(c);
    if (!g.ok) return g.res;
    try {
      return c.json({ ok: true, positions: await positionsFor(connection(), new PublicKey(g.wallet)) });
    } catch (err) {
      console.error("[engine] positions failed:", err instanceof Error ? err.message : err);
      return c.json({ ok: false, error: "could not read your positions; try again shortly" }, 502);
    }
  });

  for (const mode of ["collect", "close"] as const) {
    app.post(`/api/engine/${mode}`, async (c) => {
      const g = engineCaller(c);
      if (!g.ok) return g.res;
      const body = (await jsonBody(c)) ?? {};
      const pool = body.pool;
      const position = body.position;
      if (typeof pool !== "string" || typeof position !== "string") return c.json({ ok: false, error: "pool and position are required" }, 400);
      let poolKey: PublicKey;
      let positionKey: PublicKey;
      try {
        poolKey = new PublicKey(pool);
        positionKey = new PublicKey(position);
      } catch {
        return c.json({ ok: false, error: "pool and position must be Solana addresses" }, 400);
      }
      try {
        const out = await decreaseSteps(connection(), new PublicKey(g.wallet), poolKey.toBase58(), positionKey.toBase58(), mode);
        if ("error" in out) return c.json({ ok: false, error: out.error }, out.status);
        return c.json(out);
      } catch (err) {
        console.error(`[engine] ${mode} failed:`, err instanceof Error ? err.message : err);
        return c.json({ ok: false, error: "could not build the transaction; try again shortly" }, 502);
      }
    });
  }

  // ---------------------------------------------------------------------------------
  // Proposals: agents propose, the operator decides, the loop executes through the guards.
  // ---------------------------------------------------------------------------------
  const STATUSES: ReadonlySet<string> = new Set<ProposalStatus>(["pending", "approved", "rejected", "expired", "executed"]);
  app.get("/api/proposals", (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const status = c.req.query("status");
    return c.json({ ok: true, proposals: listProposals(limit, status && STATUSES.has(status) ? (status as ProposalStatus) : undefined) });
  });

  app.post("/api/proposals", async (c) => {
    const wallet = requireWallet(c.req.header("authorization"));
    if (!wallet) return c.json({ ok: false, error: "sign in with your wallet first" }, 401);
    const body = await jsonBody(c);
    if (!body) return c.json({ ok: false, error: "body must be a JSON object" }, 400);
    const input = {
      proposerId: wallet,
      proposerName: typeof body.agentName === "string" && body.agentName.trim() ? body.agentName : shortAddr(wallet),
      kind: body.kind,
      pool: body.pool,
      side: body.side,
      amountSol: body.amountSol,
      amountToken: body.amountToken,
      binsBelowActive: body.binsBelowActive,
      binsAboveActive: body.binsAboveActive,
      strategy: body.strategy,
      position: body.position,
      rationale: body.rationale,
    };
    if (body.dryRun === true) return c.json({ dryRun: true, ...previewProposal(input) });
    const r = submitProposal(input);
    if (!r.ok) return c.json({ ok: false, error: r.error }, 400);
    return c.json({ ok: true, proposal: r.proposal });
  });

  app.post("/api/proposals/decide", async (c) => {
    if (!operatorAuthorized(c.req.header("authorization"))) return c.json({ ok: false, error: "operator bearer required" }, 401);
    const body = (await jsonBody(c)) ?? {};
    const id = body.id;
    const decision = body.decision;
    if (typeof id !== "string" || (decision !== "approve" && decision !== "reject")) return c.json({ ok: false, error: "id and decision (approve | reject) are required" }, 400);
    const p = decideProposal(id, decision, body.note);
    if (!p) return c.json({ ok: false, error: "no pending proposal with that id" }, 404);
    return c.json({ ok: true, proposal: p });
  });

  // ---------------------------------------------------------------------------------
  // Revenue: folded from revenue.jsonl. The operator's stranded-payment path lives here.
  // ---------------------------------------------------------------------------------
  app.get("/api/revenue", (c) =>
    c.json({
      ok: true,
      totalUsd: revenue.totalRevenueUsd,
      byTool: revenue.revenueByTool,
      x402: { mode: gate.mode, network: SOLANA_MAINNET_CAIP2, asset: USDC_MINT.toBase58(), treasury: gate.treasuryOwner || null, payTo: gate.treasuryAta || null },
      prices: TOOL_PRICES_USD,
      packs: PACKS.map((p) => ({ id: p.id, usd: p.usd, credits: p.credits })),
    }),
  );

  app.post("/api/revenue/settle", async (c) => {
    if (!operatorAuthorized(c.req.header("authorization"))) return c.json({ ok: false, error: "operator bearer required" }, 401);
    const body = (await jsonBody(c)) ?? {};
    const signature = body.signature;
    const resource = body.resource;
    if (typeof signature !== "string" || typeof resource !== "string") return c.json({ ok: false, error: "signature and resource are required" }, 400);
    const pack = resource.startsWith("credits:") ? PACKS.find((p) => `credits:${p.id}` === resource) : undefined;
    const priceUsd = pack ? pack.usd : toolPriceUsd(resource);
    if (!priceUsd) return c.json({ ok: false, error: "that resource is free or unknown; nothing to settle" }, 400);
    const r = await gate.settleStranded(signature, priceUsd, resource);
    if (!r.ok) return c.json({ ok: false, error: r.error }, 400);
    revenue.record(resource, priceUsd, r.signature);
    // Credits can only go to the wallet whose USDC moved; it cannot be supplied.
    const balance = pack ? addPurchase(r.payer, pack.id, pack.credits, r.signature) : undefined;
    return c.json({ ok: true, payer: r.payer, signature: r.signature, resource, amountUsd: priceUsd, ...(pack ? { credited: pack.credits, balance } : {}) });
  });

  // ---------------------------------------------------------------------------------
  // Credits purchase over the same rail: 402 with the pack's terms, then a verified payment
  // credits the session wallet. A stub-mode acceptance credits (local dev) but records no revenue.
  // ---------------------------------------------------------------------------------
  app.post("/api/credits/buy", async (c) => {
    const wallet = requireWallet(c.req.header("authorization"));
    if (!wallet) return c.json({ ok: false, error: "sign in with your wallet first" }, 401);
    const body = (await jsonBody(c)) ?? {};
    const pack = PACKS.find((p) => p.id === body.pack);
    if (!pack) return c.json({ ok: false, error: "unknown pack", packs: PACKS.map((p) => ({ id: p.id, usd: p.usd, credits: p.credits })) }, 400);
    const resource = `credits:${pack.id}`;
    const header = c.req.header("x-payment");
    if (!header) return c.json(gate.requirements(pack.usd, resource), 402);
    const r = await gate.verify(header, pack.usd, resource);
    if (!r.ok) return c.json({ ok: false, error: r.error }, 402);
    const balance = addPurchase(wallet, pack.id, pack.credits, r.signature);
    if (!r.stub) revenue.record(resource, pack.usd, r.signature);
    return c.json({ ok: true, pack: pack.id, credits: pack.credits, balance, payer: r.payer ?? null, stub: r.stub === true });
  });

  app.get("/integrate.md", (c) => c.body(renderIntegrationDoc(publicBase(c)), 200, { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" }));
}
