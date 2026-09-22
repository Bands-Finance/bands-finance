/**
 * The bands.finance MCP server: the screener, pool data and Mr Bands' reasoning exposed as
 * tools an agent connects to, priced per call over x402. Ports Meridian's
 * agent/src/mcp/server.ts (buildServer, McpAudience, the json() result helper, the
 * proposals door) and the PRICE_*_USD map from agent/src/config.ts L84-94.
 *
 * The paywall is NOT here. src/platform/railsRoutes.ts peeks at every tools/call before the
 * request reaches the transport and answers 402 for a priced tool without a valid
 * X-PAYMENT; a tool priced 0 is free, and the approval-key (operator) and house bearers pass
 * the paywall (the house's own agent does not pay itself). The audience split is a payload
 * reduction, not a gate: an approval-key-only tool is refused by the bearer check in
 * railsRoutes whatever list the caller was served.
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

/** Tools only the approval-key (operator) bearer may call. Enforced in railsRoutes, listed here so both agree. */
export const OPERATOR_ONLY_TOOLS: ReadonlySet<string> = new Set(["bands_decide_proposal"]);

/** The read tools, and all a house session is served: no proposing, no deciding. */
export const HOUSE_TOOLS: readonly string[] = ["bands_list_pools", "bands_limits", "bands_agent_thoughts", "bands_pool_snapshot", "bands_screen", "bands_pool_score"];

/** Constant-time match of an `Authorization: Bearer <x>` header against a token. An empty token matches nobody. */
function bearerMatches(authorization: string | undefined | null, token: string): boolean {
  if (!token || !authorization) return false;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Constant-time bearer match against PLATFORM_OPERATOR_TOKEN. Unset token = nobody is the operator. */
export function operatorAuthorized(authorization: string | undefined | null): boolean {
  return bearerMatches(authorization, process.env.PLATFORM_OPERATOR_TOKEN ?? "");
}

let sameTokenLogged = false;

/**
 * The house token as the desk will honour it: PLATFORM_HOUSE_TOKEN, or "" when it is unset or
 * is the operator token. The split only means something if the two differ: a house token that
 * is also the operator token would hand whoever holds it the power to decide proposals, so it is
 * not treated as house at all (said once in the log, not on every call).
 */
export function houseToken(): string {
  const house = process.env.PLATFORM_HOUSE_TOKEN?.trim() ?? "";
  if (!house) return "";
  if (house === (process.env.PLATFORM_OPERATOR_TOKEN?.trim() ?? "")) {
    if (!sameTokenLogged) {
      sameTokenLogged = true;
      console.error("[bands-mcp] PLATFORM_HOUSE_TOKEN is the operator token, so it is not treated as the house bearer. Generate its own: openssl rand -hex 32");
    }
    return "";
  }
  return house;
}

/** Constant-time bearer match against the house token. Unset, or the same as the operator's = nobody is the house. */
export function houseAuthorized(authorization: string | undefined | null): boolean {
  return bearerMatches(authorization, houseToken());
}

/**
 * Who the tool list is rendered for. "public" omits the tools a credential-free caller can
 * never call. "house" is Mr Bands himself on the gateway: the read tools (HOUSE_TOOLS), free
 * of the paywall, and nothing else; he reasons about a pool with them, and approval is the
 * desk's own code, never a model's. "operator" is the complete surface: every read tool, the
 * proposals door and the decision tool, for Zach with the operator token. Sessions hold
 * whichever server they were built with, and session ids are random UUIDs, so an audience
 * cannot be swapped mid-session.
 */
export type McpAudience = "public" | "house" | "operator";

export interface BuildServerOptions {
  audience?: McpAudience;
  /** stable id for proposals from this session; the tool falls back to a hash of the claimed name */
  proposerId?: string;
  /** lazily built; only the priced live tools touch the RPC */
  connection: () => Connection;
}

/**
 * What an agent reads first, at initialize. Only what is true of the code as it runs today
 * (docs/sprint.md "How we say what he does"): he proposes, the guards decide; his book is
 * paper; the public platform is not open and x402 is not taking real payments yet.
 */
export const SERVER_INSTRUCTIONS = [
  "Mr Bands is the founder of bands.finance and the agent behind this server. He makes markets on Meteora DLMM: he lays bands of liquidity around the price, across the pools his screener ranks, and earns the pool's fees on the trades that cross them, with limits in code and every decision public.",
  "Tokenized stocks are one part of his book, not all of it: xStocks (NVDAx, PLTRx, GMEx) and Backpack-issued stocks (MU, SKHY, SPCX), where he lays two-sided bands (half the quote, half the stock) and hedges the stock half short on Backpack's stock perps where one is listed. Up to 3 of the paper book's 6 seats go to stocks; the rest go to the pools his screener ranks best.",
  "He proposes, the guards decide. Each cycle he reads each pool and proposes a move, and code guards decide whether it runs. Today his proposals come from his own rulebook (the desk policy); his model on the OpenHermit gateway takes over as it is switched on.",
  "His book today is paper: real pools and live prices, pretend money. Fees are not profit, and nothing here is a return or a recommendation.",
  "What exists now: this server runs on his own host; the public platform at bands.finance is not open yet; tool prices are listed but the x402 gate is not taking real payments yet (GET /api/revenue reports x402.mode). Full guide: GET /integrate.md on this host.",
].join("\n\n");

/** How the listed per-call price is worded in a tool description: listed, not yet charged. */
const priced = (tool: string): string => `Listed at $${toolPriceUsd(tool).toFixed(2)} a call over x402; the gate is not taking real payments on his host yet.`;

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function buildServer(opts: BuildServerOptions): McpServer {
  const server = new McpServer({ name: "bands-finance", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });
  const audience = opts.audience ?? "public";
  const privileged = audience === "operator";

  server.registerTool(
    "bands_list_pools",
    {
      title: "Top screened DLMM pools",
      description:
        `The top 50 of Mr Bands' last screen of every Meteora DLMM pool on Solana: name, address, score (0-100), flags and fee/TVL. Free. bands_screen (listed at $${toolPriceUsd("bands_screen").toFixed(2)}) returns the full ranked board with every measured column.`,
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
      description: "The limits Mr Bands' guards enforce in code (per-band size, exposure, gas reserve, stop-loss, width, pacing). He proposes, these guards decide: the same limits judge his own moves, engine-skill plans and approved proposals. Free.",
      inputSchema: {},
    },
    async () => json({ ok: true, limits: riskLimits, maxActivePools: config.maxActivePools, described: describeLimits(riskLimits) }),
  );

  server.registerTool(
    "bands_agent_thoughts",
    {
      title: "Mr Bands' recent decisions and reasoning",
      description: "The latest journal entries from his paper book (real pools, live prices, pretend money): headline, reasoning, the move he proposed and the guards' verdict. Today his proposals come from his own rulebook (the desk policy), not a model. Same feed the site shows.",
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
      description: `A live read of one DLMM pool from the chain: tokens, active bin and price, fees, the bins around the active bin with their liquidity. ${priced("bands_pool_snapshot")}`,
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
      description: `Every pool from Mr Bands' last screen with every measured column: TVL, volume, fees (on-chain-measured where history allows, else estimated), fee/TVL, turnover, age, score and flags. ${priced("bands_screen")}`,
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
      description: `Score, flags, fee source (measured on chain or estimated from volume), fee/TVL, turnover and the numbers behind them for one screened pool. ${priced("bands_pool_score")}`,
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

  // The house is served the read tools and stops here: no proposing, no deciding.
  if (audience === "house") return server;

  // The proposals door: any agent may argue for one bounded action on Mr Bands' book. Free
  // and unprivileged by design, because the tool grants no authority: the proposal sits on
  // the public board until it is approved or rejected with the approval key (or by the desk's
  // fixed rules), and execution runs the desk's own policy and guards. Without a bearer the identity is only a
  // CLAIMED name ("mcp:n:"), which the desk's own approval rules never accept (src/platform/autoDecide.ts): those
  // wait for the approval key.
  server.registerTool(
    "bands_propose_band_action",
    {
      title: "Propose a band action to Mr Bands",
      description:
        "Argue for one bounded action on Mr Bands' book, which is paper today (real pools, live prices, pretend money): OPEN_BAND (pool, side, amountSol, amountToken, binsBelowActive, binsAboveActive, strategy) or CLOSE_BAND (pool, position). Your rationale is published verbatim. A proposal is approved or rejected by hand with the desk's approval key (PLATFORM_OPERATOR_TOKEN), or, for a small SOL-only open from a signed-in wallet or an allowlisted bearer caller, by the desk's fixed rules; no model approves anything. An approved proposal then runs through his own policy and the risk guards, which decide what executes. Nothing you submit here moves funds on its own. Pass dryRun: true to validate without publishing. Full guide: GET /integrate.md on this host.",
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
      const proposerId = opts.proposerId ?? mcpProposerId("name", agentName.toLowerCase());
      const input = { proposerId, proposerName: agentName, kind, pool, side, amountSol, amountToken, binsBelowActive, binsAboveActive, strategy, position, rationale };
      if (dryRun === true) return json({ dryRun: true, ...previewProposal(input) });
      const result = submitProposal(input);
      if (!result.ok) return json({ ok: false, error: result.error });
      return json({ ok: true, id: result.proposal.id, status: "pending", note: "Pending: it is approved or rejected with the approval key or by the desk's fixed rules, then his policy and guards decide what runs. Watch GET /api/proposals on this host for the verdict." });
    },
  );

  if (privileged) {
    server.registerTool(
      "bands_decide_proposal",
      {
        title: "Approval key: approve or reject a proposal",
        description: "Needs the approval key (PLATFORM_OPERATOR_TOKEN bearer). Approve or reject a pending proposal; approval queues it for the loop, which asks his policy and runs it through the guards before anything executes.",
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
