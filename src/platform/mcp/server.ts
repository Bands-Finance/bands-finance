/**
 * The bands.finance MCP server: the screener, pool data and Mr Bands' reasoning exposed as
 * tools an agent connects to, priced per call over x402. Ports Meridian's
 * agent/src/mcp/server.ts (buildServer, McpAudience, the json() result helper, the
 * proposals door) and the PRICE_*_USD map from agent/src/config.ts L84-94.
 *
 * The paywall is NOT here. src/platform/railsRoutes.ts peeks at every tools/call before the
 * request reaches the transport and answers 402 for a priced tool without a valid
 * X-PAYMENT; a tool priced 0 is free. The audience split is a payload reduction, not a
 * gate: an operator-only tool is refused by the bearer check in railsRoutes whatever list
 * the caller was served.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { timingSafeEqual } from "node:crypto";
import type { Connection } from "@solana/web3.js";
import { z } from "zod";
import { config, riskLimits } from "../../config";
import { readRecent } from "../../journal";
import { describeLimits } from "../../risk/limits";
import { loadScreen } from "../../screener";
import { getPoolSnapshot, loadPool } from "../../tools/dlmm";
import { isAddress } from "../accounts";
import { decideProposal, listProposals, mcpProposerId, previewProposal, submitProposal } from "../proposals";

const num = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`tool price must be a non-negative number, got ${JSON.stringify(raw)}`);
  return n;
};

/** Per-call prices in USD. A tool with no entry, or priced 0, is free. */
export const TOOL_PRICES_USD: Readonly<Record<string, number>> = {
  bands_pool_snapshot: num(process.env.PRICE_POOL_SNAPSHOT_USD, 0.01),
  bands_screen: num(process.env.PRICE_SCREEN_USD, 0.02),
  bands_pool_score: num(process.env.PRICE_POOL_SCORE_USD, 0.05),
  bands_agent_thoughts: num(process.env.PRICE_AGENT_THOUGHTS_USD, 0),
};

export function toolPriceUsd(tool: string): number {
  return TOOL_PRICES_USD[tool] ?? 0;
}

/** Tools only the operator bearer may call. Enforced in railsRoutes, listed here so both agree. */
export const OPERATOR_ONLY_TOOLS: ReadonlySet<string> = new Set(["bands_decide_proposal"]);

/** Constant-time bearer match against PLATFORM_OPERATOR_TOKEN. Unset token = nobody is the operator. */
export function operatorAuthorized(authorization: string | undefined | null): boolean {
  const token = process.env.PLATFORM_OPERATOR_TOKEN ?? "";
  if (!token || !authorization) return false;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Who the tool list is rendered for. "public" omits the tools a credential-free caller can
 * never call; "operator" is the complete surface. Sessions hold whichever server they were
 * built with, and session ids are random UUIDs, so an audience cannot be swapped mid-session.
 */
export type McpAudience = "public" | "operator";

export interface BuildServerOptions {
  audience?: McpAudience;
  /** stable id for proposals from this session; the tool falls back to a hash of the claimed name */
  proposerId?: string;
  /** lazily built; only the priced live tools touch the RPC */
  connection: () => Connection;
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function buildServer(opts: BuildServerOptions): McpServer {
  const server = new McpServer({ name: "bands-finance", version: "0.1.0" });
  const privileged = (opts.audience ?? "public") === "operator";

  server.registerTool(
    "bands_list_pools",
    {
      title: "Top screened DLMM pools",
      description:
        "The top 50 of Mr Bands' last screen of every Meteora DLMM pool on Solana: name, address, score (0-100), flags and fee/TVL. Free. bands_screen ($0.02) returns the full ranked board with every measured column.",
      inputSchema: {},
    },
    async () => {
      const screen = loadScreen();
      if (!screen) return json({ ok: false, error: "no screen yet on this host" });
      return json({
        ok: true,
        generatedAt: screen.generatedAt,
        rankedPools: screen.rankedPools,
        pools: screen.pools.slice(0, 50).map((p) => ({ rank: p.rank, name: p.name, address: p.address, quote: p.quoteSymbol, score: p.score, flags: p.flags, feeToTvl24hPct: p.feeToTvl24hPct })),
      });
    },
  );

  server.registerTool(
    "bands_limits",
    {
      title: "The hard risk limits",
      description: "The limits Mr Bands' guards enforce in code (per-band size, exposure, gas reserve, stop-loss, width, pacing). The same limits judge engine-skill plans and approved proposals. Free.",
      inputSchema: {},
    },
    async () => json({ ok: true, limits: riskLimits, maxActivePools: config.maxActivePools, described: describeLimits(riskLimits) }),
  );

  server.registerTool(
    "bands_agent_thoughts",
    {
      title: "Mr Bands' recent decisions and reasoning",
      description: "The latest journal entries: headline, reasoning, the proposed action and the guards' verdict. Same feed the site shows.",
      inputSchema: { limit: z.number().int().positive().max(20).optional() },
    },
    async ({ limit }) =>
      json({
        ok: true,
        entries: readRecent(limit ?? 20).map((e) => ({
          id: e.id,
          ts: e.ts,
          agent: e.agent,
          pool: { address: e.pool.address, label: e.pool.label },
          headline: e.headline,
          proposed: e.proposal.action,
          decided: e.decision.action,
          reasoning: e.decision.reasoning,
          verdict: { allowed: e.allowed, violations: e.violations, overrides: e.overrides, emergency: e.emergency },
          execution: { mode: e.execution.mode, ok: e.execution.ok },
        })),
      }),
  );

  server.registerTool(
    "bands_pool_snapshot",
    {
      title: "Live pool snapshot",
      description: "A live read of one DLMM pool from the chain: tokens, active bin and price, fees, the bins around the active bin with their liquidity. Priced per call via x402.",
      inputSchema: { pool: z.string().min(32).max(44).describe("the DLMM pool address") },
    },
    async ({ pool }) => {
      if (!isAddress(pool)) return json({ ok: false, error: "pool must be a DLMM pool address" });
      try {
        const dlmm = await loadPool(opts.connection(), pool);
        return json({ ok: true, snapshot: await getPoolSnapshot(dlmm) });
      } catch (err) {
        return json({ ok: false, error: `could not read that pool: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
  );

  server.registerTool(
    "bands_screen",
    {
      title: "The full ranked board",
      description: "Every pool from Mr Bands' last screen with every measured column: TVL, volume, fees (on-chain-measured where history allows, else estimated), fee/TVL, turnover, age, score and flags. Priced per call via x402.",
      inputSchema: {},
    },
    async () => {
      const screen = loadScreen();
      return json(screen ? { ok: true, ...screen } : { ok: false, error: "no screen yet on this host" });
    },
  );

  server.registerTool(
    "bands_pool_score",
    {
      title: "One pool's score and why",
      description: "Score, flags, fee source (measured on chain or estimated from volume), fee/TVL, turnover and the numbers behind them for one screened pool. Priced per call via x402.",
      inputSchema: { pool: z.string().min(32).max(44).describe("the DLMM pool address") },
    },
    async ({ pool }) => {
      const screen = loadScreen();
      if (!screen) return json({ ok: false, error: "no screen yet on this host" });
      const p = screen.pools.find((x) => x.address === pool);
      if (!p) return json({ ok: false, error: "that pool is not on the last screen (below the liquidity floor, not SOL/USDC-quoted, or not traded recently)" });
      return json({
        ok: true,
        generatedAt: screen.generatedAt,
        pool: {
          address: p.address,
          name: p.name,
          rank: p.rank,
          score: p.score,
          flags: p.flags,
          feesSource: p.feesSource,
          feesWindowHours: p.feesWindowHours,
          fees24hUsd: p.fees24hUsd,
          feeToTvl24hPct: p.feeToTvl24hPct,
          tvlUsd: p.tvlUsd,
          volume24hUsd: p.volume24hUsd,
          turnover24h: p.turnover24h,
          binStep: p.binStep,
          baseFeePct: p.baseFeePct,
          dynamicFeePct: p.dynamicFeePct,
          quoteShare: p.quoteShare,
          binRangePct: p.binRangePct,
          priceChange24hPct: p.priceChange24hPct,
          ageHours: p.ageHours,
        },
      });
    },
  );

  // The proposals door: any agent may argue for one bounded action on Mr Bands' book. Free
  // and unprivileged by design, because the tool grants no authority: the proposal sits on
  // the public board until the operator approves or rejects it, and execution runs the
  // desk's own guards. Identity is CLAIMED; spoofing a name buys nothing a judged argument doesn't.
  server.registerTool(
    "bands_propose_band_action",
    {
      title: "Propose a band action to the operator",
      description:
        "Argue for one bounded action on Mr Bands' live book: OPEN_BAND (pool, side, amountSol, amountToken, binsBelowActive, binsAboveActive, strategy) or CLOSE_BAND (pool, position). Your rationale is published verbatim; the human operator approves or rejects, and approval executes through the desk's own risk guards. Nothing you submit here moves funds on its own. Pass dryRun: true to validate without publishing. Full guide: GET /integrate.md on this host.",
      inputSchema: {
        kind: z.enum(["OPEN_BAND", "CLOSE_BAND"]),
        pool: z.string().min(32).max(44),
        side: z.enum(["SOL_ONLY", "TOKEN_ONLY", "BOTH"]).optional(),
        amountSol: z.number().min(0).optional(),
        amountToken: z.number().min(0).optional(),
        binsBelowActive: z.number().int().min(0).optional(),
        binsAboveActive: z.number().int().min(0).optional(),
        strategy: z.enum(["Spot", "Curve", "BidAsk"]).optional(),
        position: z.string().min(32).max(44).optional(),
        rationale: z.string().min(20).max(600),
        agentName: z.string().min(1).max(40),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ kind, pool, side, amountSol, amountToken, binsBelowActive, binsAboveActive, strategy, position, rationale, agentName, dryRun }) => {
      const proposerId = opts.proposerId ?? mcpProposerId(`name:${agentName.toLowerCase()}`);
      const input = { proposerId, proposerName: agentName, kind, pool, side, amountSol, amountToken, binsBelowActive, binsAboveActive, strategy, position, rationale };
      if (dryRun === true) return json({ dryRun: true, ...previewProposal(input) });
      const result = submitProposal(input);
      if (!result.ok) return json({ ok: false, error: result.error });
      return json({ ok: true, id: result.proposal.id, status: "pending", note: "The operator decides. Watch GET /api/proposals on this host for the verdict." });
    },
  );

  if (privileged) {
    server.registerTool(
      "bands_decide_proposal",
      {
        title: "Operator: approve or reject a proposal",
        description: "Operator-only (PLATFORM_OPERATOR_TOKEN bearer). Approve or reject a pending proposal; approval queues it for the loop, which runs it through the guards before anything executes.",
        inputSchema: { id: z.string().min(1), decision: z.enum(["approve", "reject"]), note: z.string().max(300).optional() },
      },
      async ({ id, decision, note }) => {
        const p = decideProposal(id, decision, note);
        if (!p) return json({ ok: false, error: "no pending proposal with that id", pending: listProposals(20, "pending").map((x) => x.id) });
        return json({ ok: true, proposal: p });
      },
    );
  }

  return server;
}
