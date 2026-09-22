// A FAKE ClawPump MCP server over stdio, for src/scripts/test-token-bridge.ts only. It offers the tools the bridge and
// the read-only check may call, with @clawpump/agents 0.1.27's names, input shapes and annotations, plus three of the
// real server's write tools, which nothing may ever call (the tests assert it). No network: everything comes from and
// goes to two files the test names in the env.
//
//   FAKE_CP_STATE    JSON {status, agent, automations, runs, launch: {mode, delayMs, mint}, statusDelayMs}; read on
//                    every call, and written when a launch lands a mint; statusDelayMs slows get_launch_status
//                    launch.mode: ok | isError-with-mint | isError-no-mint | refused-image | crash
//   FAKE_CP_CALLS    JSONL: one {event:"start", envKeys, argv} line, then one {tool, args} line per call
//   FAKE_CP_VARIANT  changed-schema | no-launch-tool | status-not-readonly: a server that is not the pinned one
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const STATE = process.env.FAKE_CP_STATE;
const CALLS = process.env.FAKE_CP_CALLS;
const VARIANT = process.env.FAKE_CP_VARIANT ?? "";

const readState = () => JSON.parse(fs.readFileSync(STATE, "utf8"));
const writeState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
const record = (line) => fs.appendFileSync(CALLS, JSON.stringify(line) + "\n");
const json = (data, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], ...(isError ? { isError: true } : {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

record({ event: "start", envKeys: Object.keys(process.env).sort(), argv: process.argv.slice(1), apiKeyLength: (process.env.CLAWPUMP_API_KEY ?? "").length });

const statusOf = (s) => ({
  agent: s.status.agent,
  metadata: s.status.metadata,
  funding: s.status.funding,
  recovery: s.status.recovery ?? null,
  already_launched: !!s.status.agent.token_mint,
  token_mint: s.status.agent.token_mint ?? null,
});

const RO = { readOnlyHint: true, idempotentHint: true, openWorldHint: false, destructiveHint: false };
const WRITE = { destructiveHint: true, openWorldHint: true, readOnlyHint: false };

const server = new McpServer({ name: "clawpump-agents", version: "0.1.27" });

server.tool("get_launch_status", "fake", { agent_id: z.string().optional() }, VARIANT === "status-not-readonly" ? WRITE : RO, async (args) => {
  record({ tool: "get_launch_status", args });
  const delay = readState().statusDelayMs;
  if (delay) await sleep(delay);
  return json(statusOf(readState()));
});
server.tool("get_agent", "fake", { agent_id: z.string().optional() }, RO, async (args) => {
  record({ tool: "get_agent", args });
  return json(readState().agent ?? {});
});
server.tool("list_automations", "fake", { agent_id: z.string().optional() }, RO, async (args) => {
  record({ tool: "list_automations", args });
  return json(readState().automations ?? []);
});
server.tool("list_agent_runs", "fake", { agent_id: z.string().optional(), status: z.string().optional(), limit: z.number().optional() }, RO, async (args) => {
  record({ tool: "list_agent_runs", args });
  return json(readState().runs ?? []);
});
server.tool("get_wallet_summaries", "fake", {}, RO, async (args) => {
  record({ tool: "get_wallet_summaries", args });
  return json([]);
});
server.tool("get_whitelist", "fake", { agent_id: z.string().optional() }, RO, async (args) => {
  record({ tool: "get_whitelist", args });
  return json([]);
});

const launchShape = {
  agent_id: z.string().optional(),
  confirm_launch: z.literal(true),
  symbol: z.string().min(1).max(10),
  description: z.string().min(20).max(500),
  image_url: z.string().url().optional(),
  twitter: z.string().optional(),
  ...(VARIANT === "changed-schema" ? { name: z.string().optional() } : { first_buy_amount_sol: z.number().min(0).max(85).optional() }),
};

if (VARIANT !== "no-launch-tool") {
  server.tool("launch_metaplex_genesis_token", "fake", launchShape, WRITE, async (args) => {
    record({ tool: "launch_metaplex_genesis_token", args });
    const s = readState();
    if (s.status.agent.token_mint) return json({ error: "This agent already has a launched token.", already_launched: true, token_mint: s.status.agent.token_mint }, true);
    const l = s.launch ?? { mode: "ok" };
    if (l.mode === "refused-image") return json({ error: "A token image is required before launching a Metaplex Genesis token.", agent: s.status.agent }, true);
    if (l.delayMs) await sleep(l.delayMs);
    if (l.mode === "crash") process.exit(3);
    const land = () => {
      const now = readState();
      now.status.agent.token_mint = l.mint;
      writeState(now);
    };
    if (l.mode === "ok") {
      land();
      return json({ status: "launched", mint: l.mint, metaplexGenesis: { status: "launched" } });
    }
    if (l.mode === "isError-with-mint") {
      land();
      return json({ error: "Token launch completed, but Metaplex Genesis status is pending.", status: "launched", metaplexGenesis: { status: "pending" } }, true);
    }
    return json({ error: "Server error (502): The ClawPump backend is experiencing issues. Try again shortly." }, true);
  });
}

for (const name of ["launch_token_gasless", "wallet_transfer", "swap_execute"]) {
  server.tool(name, "fake write tool: never to be called", { agent_id: z.string().optional() }, WRITE, async (args) => {
    record({ tool: name, args });
    return json({ error: "a write tool was called" }, true);
  });
}

await server.connect(new StdioServerTransport());
