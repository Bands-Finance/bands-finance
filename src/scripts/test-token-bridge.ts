/**
 * The launch bridge (src/launch/bridge.ts) and what it is built from (spec.ts, files.ts, upstream.ts, arm.ts, check.ts),
 * against a FAKE ClawPump (src/scripts/fixtures/fake-clawpump.mjs, a stub stdio MCP server). No network, no real key,
 * no gateway: every file lives in a temp dir, and the "key" is a made-up cpk_ string the tests grep for.
 *   npx tsx src/scripts/test-token-bridge.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { armUnlessInflight, GATEWAY_LAUNCH_TOOL, GATEWAY_STATUS_TOOL, launchPrompt, parseArmArgs } from "../launch/arm";
import { definiteRefusal, PENDING_MESSAGE, parseBridgeArgs, startBridge, type Bridge, type BridgeOptions } from "../launch/bridge";
import { CHECK_CALLS, readiness } from "../launch/check";
import { armProblem, assertPrivateFile, bearerMatches, clearInflight, constantTimeEqual, consumeArm, inflightFileFor, parseEnvFile, readArm, readInflight, readSecrets, writeArm, writeInflight } from "../launch/files";
import {
  BRIDGE_LAUNCH_TOOL,
  BRIDGE_STATUS_TOOL,
  CLAWPUMP_AGENT_ID,
  CLAWPUMP_AGENT_WALLET,
  checkLaunchConfig,
  launchArguments,
  mintOf,
  READONLY_UPSTREAM_TOOLS,
  redactDeep,
  redactString,
  specProblems,
  TOKEN_DESCRIPTION,
  UPSTREAM_LAUNCH_TOOL,
} from "../launch/spec";
import { childEnv, toolProblems, Upstream } from "../launch/upstream";
import { parseReply } from "../talk/replyBrain";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.error(err);
    process.exit(1);
  }
}

const ROOT = path.join(__dirname, "..", "..");
const FAKE = path.join(__dirname, "fixtures", "fake-clawpump.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "launch-bridge-test-"));
fs.chmodSync(TMP, 0o700);
const FAKE_KEY = "cpk_TESTONLY_" + "k".repeat(35);
const FAKE_TOKEN = "b".repeat(64);
const MINT = "BANDSmintTESTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SIGNED = "https://iumz.supabase.co/storage/v1/object/sign/agent-avatars/a/b.jpg?token=eyJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJ4In0.c2lnbmF0dXJl";

/** The stored state as it must be at launch: the spec, empty links, a funded wallet, no mint. */
function goodStatus(): Record<string, unknown> {
  return {
    agent: { id: CLAWPUMP_AGENT_ID, name: "Mr Bands", wallet_address: CLAWPUMP_AGENT_WALLET, token_mint: null, avatar_url: "u/a.jpg" },
    metadata: { name: "Mr Bands", symbol: "BANDS", description: TOKEN_DESCRIPTION, imageUrl: SIGNED, website: "", twitter: "https://x.com/MrBandsSol", telegram: null },
    funding: { recommended: "self_funded", gasless_available: false, gasless_launches_affordable: 0, self_funded_cost_sol: 0.00751, agent_wallet_balance_sol: 0.1, can_self_fund: true },
  };
}
/** As read from ClawPump on 22 Sep (read-only): symbol MB, his X bio as the description, a wallet at 0. */
function observedStatus(): Record<string, unknown> {
  const s = goodStatus();
  (s.metadata as Record<string, unknown>).symbol = "MB";
  (s.metadata as Record<string, unknown>).description = "Autonomous AI market maker on Solana. I provide liquidity on Meteora and learn from every trade. Now building my own platform.";
  s.funding = { recommended: "blocked", gasless_available: false, gasless_launches_affordable: 0, self_funded_cost_sol: 0.00751, agent_wallet_balance_sol: 0, can_self_fund: false };
  return s;
}
const statusView = (s: Record<string, unknown>) => ({ ...s, already_launched: !!(s.agent as { token_mint?: string }).token_mint, token_mint: (s.agent as { token_mint?: string }).token_mint ?? null });

let caseNo = 0;
interface Case {
  dir: string;
  secrets: string;
  arm: string;
  audit: string;
  state: string;
  calls: string;
  inflight: string;
  /** merges top-level fields (statusDelayMs, launch) into the fake's state file */
  patchState(patch: Record<string, unknown>): void;
  starts(): number;
  setState(status: Record<string, unknown>, launch?: Record<string, unknown>): void;
  callLog(): Array<{ tool?: string; args?: Record<string, unknown>; event?: string; envKeys?: string[]; argv?: string[]; apiKeyLength?: number }>;
  upstreamCalls(tool: string): number;
}
function newCase(status = goodStatus(), launch: Record<string, unknown> = { mode: "ok", mint: MINT }): Case {
  const dir = path.join(TMP, `c${++caseNo}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  const c: Case = {
    dir,
    secrets: path.join(dir, "clawpump.env"),
    arm: path.join(dir, "bands-launch.arm"),
    audit: path.join(dir, "launch-audit.jsonl"),
    state: path.join(dir, "state.json"),
    calls: path.join(dir, "calls.jsonl"),
    inflight: path.join(dir, "bands-launch.inflight"),
    patchState(patch) {
      fs.writeFileSync(c.state, JSON.stringify({ ...JSON.parse(fs.readFileSync(c.state, "utf8")), ...patch }));
    },
    starts() {
      return c.callLog().filter((l) => l.event === "start").length;
    },
    setState(s, l = launch) {
      fs.writeFileSync(c.state, JSON.stringify({ status: s, agent: { id: CLAWPUMP_AGENT_ID, status: "stopped", is_public: true, accepting_bids: true }, automations: [], runs: [], launch: l }));
    },
    callLog() {
      if (!fs.existsSync(c.calls)) return [];
      return fs.readFileSync(c.calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    upstreamCalls(tool) {
      return c.callLog().filter((l) => l.tool === tool).length;
    },
  };
  fs.writeFileSync(c.secrets, `# test\nCLAWPUMP_API_KEY=${FAKE_KEY}\nCLAWPUMP_BRIDGE_TOKEN="${FAKE_TOKEN}"\n`, { mode: 0o600 });
  c.setState(status, launch);
  return c;
}
function bridgeOpts(c: Case, extra: Partial<BridgeOptions> = {}): BridgeOptions {
  return {
    port: 0,
    secretsFile: c.secrets,
    armFile: c.arm,
    auditFile: c.audit,
    upstreamEntry: FAKE,
    upstreamExtraEnv: { FAKE_CP_STATE: c.state, FAKE_CP_CALLS: c.calls },
    log: () => undefined,
    ...extra,
  };
}

async function connect(url: string, token = FAKE_TOKEN): Promise<Client> {
  const client = new Client({ name: "test-gateway", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
async function callJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const r = await client.callTool({ name, arguments: args });
  const t = (r.content as { type: string; text: string }[])[0]?.text ?? "";
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(t) as Record<string, unknown>;
  } catch {
    body = { raw: t };
  }
  return { isError: r.isError === true, body };
}
/** A raw POST, to test what the HTTP layer refuses before MCP sees anything. */
function rawPost(port: number, headers: Record<string, string>, body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', p = "/mcp"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function withBridge(c: Case, extra: Partial<BridgeOptions>, fn: (b: Bridge, client: Client) => Promise<void>): Promise<void> {
  const b = await startBridge(bridgeOpts(c, extra));
  const client = await connect(b.url);
  try {
    await fn(b, client);
  } finally {
    await client.close().catch(() => undefined);
    await b.idle();
    await b.close();
  }
}
const armFor = (c: Case, minutes = 10) => writeArm(c.arm, minutes);
const noSecretIn = (text: string, where: string) => {
  assert.ok(!text.includes(FAKE_KEY), `${where} carries the API key`);
  assert.ok(!text.includes(FAKE_TOKEN), `${where} carries the bridge token`);
  assert.ok(!/cpk_[A-Za-z0-9]/.test(text), `${where} carries a cpk_ string`);
};

async function main(): Promise<void> {
  console.log("the spec, pinned in code");
  await test("TOKEN_DESCRIPTION is ops/live.env's, byte for byte, and names no site", () => {
    const env = parseEnvFile(fs.readFileSync(path.join(ROOT, "ops", "live.env"), "utf8"));
    assert.equal(TOKEN_DESCRIPTION, env.TOKEN_DESCRIPTION);
    assert.ok(!/bands\.finance|https?:/i.test(TOKEN_DESCRIPTION));
  });
  await test("the upstream arguments: agent, symbol BANDS, the description, first buy 0; no image, no twitter by default; fixed key order", () => {
    assert.deepEqual(Object.entries(launchArguments({})), [
      ["agent_id", CLAWPUMP_AGENT_ID],
      ["confirm_launch", true],
      ["symbol", "BANDS"],
      ["description", TOKEN_DESCRIPTION],
      ["first_buy_amount_sol", 0],
    ]);
    const withBoth = launchArguments({ imageUrl: "https://i.example.org/bands.png", twitter: "MrBandsSol" });
    assert.equal(withBoth.image_url, "https://i.example.org/bands.png");
    assert.equal(withBoth.twitter, "MrBandsSol");
  });
  await test("the config refuses an image on the site's domain, a non-https or signed image, and a twitter that is not his bare handle", () => {
    assert.throws(() => checkLaunchConfig({ imageUrl: "https://mrbands.finance/token-bands.png" }), /site's domain/);
    assert.throws(() => checkLaunchConfig({ imageUrl: "https://cdn.bands.finance/x.png" }), /site's domain/);
    assert.throws(() => checkLaunchConfig({ imageUrl: "https://img.example.org/x.png?ref=mrbands.finance" }), /site's domain/);
    assert.throws(() => checkLaunchConfig({ imageUrl: "http://img.example.org/x.png" }), /https/);
    assert.throws(() => checkLaunchConfig({ imageUrl: "https://img.example.org/x.png?token=abc" }), /query/);
    assert.throws(() => checkLaunchConfig({ imageUrl: "not a url" }), /not a URL/);
    assert.throws(() => checkLaunchConfig({ twitter: "https://x.com/MrBandsSol" }), /handle/);
    assert.throws(() => checkLaunchConfig({ twitter: "someoneelse" }), /handle/);
    assert.deepEqual(checkLaunchConfig({ imageUrl: "", twitter: "" }), {});
  });
  await test("specProblems: the state read on 22 Sep is refused for its symbol, description and empty wallet; the fixed state passes", () => {
    const p = specProblems(statusView(observedStatus()));
    assert.ok(p.some((x) => /stored symbol is "MB"/.test(x)), p.join("\n"));
    assert.ok(p.some((x) => /description is not TOKEN_DESCRIPTION/.test(x)));
    assert.ok(p.some((x) => /cannot pay/.test(x)));
    assert.equal(p.length, 3, p.join("\n"));
    assert.deepEqual(specProblems(statusView(goodStatus())), []);
  });
  await test("specProblems refuses a mint, a wrong name, a website, a telegram, the site anywhere, a foreign twitter, the wrong agent, no image", () => {
    const mutate = (f: (s: Record<string, any>) => void) => {
      const s = goodStatus() as Record<string, any>;
      f(s);
      return specProblems(statusView(s)).join("\n");
    };
    assert.match(mutate((s) => (s.agent.token_mint = MINT)), /already launched/);
    assert.match(mutate((s) => (s.metadata.name = "Mr. Bands")), /stored name/);
    assert.match(mutate((s) => (s.metadata.website = "https://example.org")), /stored website is filled in/);
    assert.match(mutate((s) => (s.metadata.telegram = "t.me/x")), /stored telegram is filled in/);
    assert.match(mutate((s) => (s.metadata.discord_url = "https://discord.gg/x")), /discord_url is filled in/);
    assert.match(mutate((s) => (s.metadata.imageUrl = "https://mrbands.finance/token-bands.png")), /site's domain/);
    assert.match(mutate((s) => (s.metadata.imageUrl = "https://cdn.example.org/a.png?src=bands.finance")), /site's domain/);
    assert.match(mutate((s) => (s.metadata.twitter = "https://x.com/somebody")), /stored twitter/);
    assert.match(mutate((s) => (s.agent.wallet_address = "9xOtherWallet")), /wrong ClawPump agent/);
    assert.match(mutate((s) => {
      s.metadata.imageUrl = "";
      s.agent.avatar_url = "";
    }), /no image/);
    assert.match(mutate((s) => (s.funding.agent_wallet_balance_sol = 0.001)), /holds 0.001 SOL/);
    assert.match(mutate((s) => delete s.metadata), /no launch metadata/);
    assert.equal(mintOf({ token_mint: MINT }), MINT);
    assert.equal(mintOf({ agent: { token_mint: MINT } }), MINT);
    assert.equal(mintOf({ token_mint: null }), null);
  });
  await test("redaction: a cpk_ key, a JWT, a signed URL's query, a secret-named field and an email never come out", () => {
    const r = redactString(`key ${FAKE_KEY} jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_part img ${SIGNED} mail a.b@example.org`, [FAKE_TOKEN]);
    noSecretIn(r, "redactString");
    assert.ok(!r.includes("?token=") && !r.includes("eyJ"), r);
    assert.ok(r.includes("https://iumz.supabase.co/storage/v1/object/sign/agent-avatars/a/b.jpg"));
    assert.ok(r.includes("<email @example.org>"));
    const d = JSON.stringify(redactDeep({ api_key: FAKE_KEY, nested: { authorization: `Bearer ${FAKE_TOKEN}`, token_mint: MINT, note: `has ${FAKE_TOKEN}` } }, [FAKE_TOKEN]));
    noSecretIn(d, "redactDeep");
    assert.ok(d.includes(MINT), "the mint is public and stays");
  });

  console.log("files: secrets, bearer, arm");
  await test("the secrets file: mode 600 or refused; no symlink; both names needed; the token long and not the key; names only in errors", () => {
    const c = newCase();
    const s = readSecrets(c.secrets);
    assert.equal(s.apiKey, FAKE_KEY);
    assert.equal(s.bridgeToken, FAKE_TOKEN);
    fs.chmodSync(c.secrets, 0o644);
    assert.throws(() => readSecrets(c.secrets), /mode 644: it must be 600/);
    fs.chmodSync(c.secrets, 0o640);
    assert.throws(() => readSecrets(c.secrets), /must be 600/);
    fs.chmodSync(c.secrets, 0o600);
    const link = path.join(c.dir, "link.env");
    fs.symlinkSync(c.secrets, link);
    assert.throws(() => readSecrets(link), /symlink/);
    const write = (text: string) => {
      const f = path.join(c.dir, `s${Math.random().toString(36).slice(2)}.env`);
      fs.writeFileSync(f, text, { mode: 0o600 });
      return f;
    };
    assert.throws(() => readSecrets(write(`CLAWPUMP_BRIDGE_TOKEN=${FAKE_TOKEN}\n`)), /no CLAWPUMP_API_KEY/);
    assert.throws(() => readSecrets(write(`CLAWPUMP_API_KEY=${FAKE_KEY}\n`)), /no CLAWPUMP_BRIDGE_TOKEN/);
    assert.equal(readSecrets(write(`CLAWPUMP_API_KEY=${FAKE_KEY}\n`), false).bridgeToken, "");
    assert.throws(() => readSecrets(write(`CLAWPUMP_API_KEY=${FAKE_KEY}\nCLAWPUMP_BRIDGE_TOKEN=short\n`)), /at least 32/);
    assert.throws(() => readSecrets(write(`CLAWPUMP_API_KEY=${FAKE_KEY}\nCLAWPUMP_BRIDGE_TOKEN=${FAKE_KEY}\n`)), /API key/);
    try {
      readSecrets(write(`CLAWPUMP_API_KEY=nope_${FAKE_KEY}\nCLAWPUMP_BRIDGE_TOKEN=${FAKE_TOKEN}\n`));
      assert.fail("a non-cpk key passed");
    } catch (err) {
      noSecretIn((err as Error).message, "the error");
      assert.match((err as Error).message, /not a cpk_ key \(length \d+\)/);
    }
    const open = path.join(c.dir, "open");
    fs.mkdirSync(open, { mode: 0o777 });
    fs.chmodSync(open, 0o777);
    const inOpen = path.join(open, "clawpump.env");
    fs.writeFileSync(inOpen, `CLAWPUMP_API_KEY=${FAKE_KEY}\n`, { mode: 0o600 });
    assert.throws(() => assertPrivateFile(inOpen), /writable by others/);
  });
  await test("the bearer: exact, constant-time, 'Bearer ' required; nothing matches an empty token", () => {
    assert.ok(bearerMatches(`Bearer ${FAKE_TOKEN}`, FAKE_TOKEN));
    assert.ok(bearerMatches(`bearer ${FAKE_TOKEN}`, FAKE_TOKEN));
    assert.ok(!bearerMatches(FAKE_TOKEN, FAKE_TOKEN), "no scheme");
    assert.ok(!bearerMatches(`Bearer ${FAKE_TOKEN}x`, FAKE_TOKEN));
    assert.ok(!bearerMatches(`Bearer ${FAKE_TOKEN.slice(1)}`, FAKE_TOKEN));
    assert.ok(!bearerMatches(`Bearer `, ""));
    assert.ok(!bearerMatches(undefined, FAKE_TOKEN));
    assert.ok(!bearerMatches([`Bearer ${FAKE_TOKEN}`] as unknown as string, FAKE_TOKEN));
    assert.ok(constantTimeEqual("abc", "abc") && !constantTimeEqual("abc", "abd") && !constantTimeEqual("abc", "abcd"));
  });
  await test("the arm: mode 600, a fresh 32-character nonce, 1 to 60 minutes; checked for nonce and time; consumed once", () => {
    const c = newCase();
    const now = Date.parse("2026-09-25T15:00:00Z");
    const a = writeArm(c.arm, 20, now);
    assert.equal(fs.statSync(c.arm).mode & 0o777, 0o600);
    assert.equal(a.nonce.length, 32);
    assert.notEqual(writeArm(path.join(c.dir, "other.arm"), 20, now).nonce, a.nonce);
    assert.equal(a.expiresAt, "2026-09-25T15:20:00.000Z");
    assert.throws(() => writeArm(c.arm, 0), /1 to 60/);
    assert.throws(() => writeArm(c.arm, 61), /1 to 60/);
    const r = readArm(c.arm);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(armProblem(r.arm, a.nonce, now), null);
    assert.match(armProblem(r.arm, "x".repeat(32), now) ?? "", /nonce does not match/);
    assert.match(armProblem(r.arm, a.nonce, now + 21 * 60_000) ?? "", /expired/);
    const used = consumeArm(c.arm);
    assert.ok(used.ok && used.usedPath === `${c.arm}.used`);
    assert.ok(!fs.existsSync(c.arm));
    const again = consumeArm(c.arm);
    assert.ok(!again.ok && /already used/.test(again.reason));
    assert.match((readArm(c.arm) as { reason: string }).reason, /not armed/);
    fs.writeFileSync(c.arm, JSON.stringify({ nonce: a.nonce, expiresAt: a.expiresAt }), { mode: 0o644 });
    fs.chmodSync(c.arm, 0o644);
    assert.match((readArm(c.arm) as { reason: string }).reason, /must be 600/);
    fs.chmodSync(c.arm, 0o600);
    fs.writeFileSync(c.arm, "{}");
    assert.match((readArm(c.arm) as { reason: string }).reason, /malformed/);
  });
  await test("the armed prompt carries the nonce and the gateway tool names, leaves the decision to him, and posts nothing", () => {
    const p = launchPrompt("N".repeat(32), "2026-09-25T15:20:00.000Z");
    assert.ok(p.includes("N".repeat(32)));
    assert.ok(p.includes(GATEWAY_LAUNCH_TOOL) && p.includes(GATEWAY_STATUS_TOOL));
    assert.equal(GATEWAY_LAUNCH_TOOL, "mcp__clawpump-launch__token_launch");
    assert.match(p, /your call/);
    assert.match(p, /never call the launch again/);
    assert.match(p, /Post nothing/);
    assert.deepEqual(parseArmArgs(["--minutes", "5"]).minutes, 5);
    assert.throws(() => parseArmArgs(["--nonce", "x"]), /unknown flag/);
  });
  await test("the tool names sit outside bands_*: an X-mention turn that touches either is voided by the talk loop's tripwire", () => {
    for (const tool of [GATEWAY_LAUNCH_TOOL, GATEWAY_STATUS_TOOL]) {
      const r = parseReply(`{"mention":"1","reply":"launched"}`, "1", [{ tool }]);
      assert.equal(r.kind, "skip");
      assert.match((r as { why: string }).why, /outside bands_\*/);
    }
    assert.ok(!/^bands_/.test(BRIDGE_LAUNCH_TOOL) && !/^bands_/.test(BRIDGE_STATUS_TOOL));
  });

  console.log("upstream: the child and its allowlist");
  await test("the child's env is the key, HOME and a minimal PATH; a test extra may not set a CLAWPUMP_ name", () => {
    const e = childEnv(FAKE_KEY, { FAKE_CP_STATE: "/x" });
    assert.deepEqual(Object.keys(e).sort(), ["CLAWPUMP_API_KEY", "FAKE_CP_STATE", "HOME", "PATH"]);
    assert.throws(() => childEnv(FAKE_KEY, { CLAWPUMP_API_URL: "http://evil" }), /may not set CLAWPUMP_API_URL/);
  });
  await test("toolProblems: a missing tool, a changed launch schema, a status tool not annotated read-only", () => {
    const launch = { name: UPSTREAM_LAUNCH_TOOL, inputSchema: { properties: Object.fromEntries(["agent_id", "confirm_launch", "symbol", "description", "image_url", "twitter", "first_buy_amount_sol"].map((k) => [k, {}])) } };
    const status = { name: "get_launch_status", annotations: { readOnlyHint: true, destructiveHint: false } };
    const need = new Set(["get_launch_status", UPSTREAM_LAUNCH_TOOL]);
    assert.deepEqual(toolProblems([launch, status], need), []);
    assert.match(toolProblems([status], need).join(), /offers no launch_metaplex_genesis_token/);
    assert.match(toolProblems([{ ...launch, inputSchema: { properties: { ...launch.inputSchema.properties, name: {} } } }, status], need).join(), /not the pinned/);
    assert.match(toolProblems([launch, { name: "get_launch_status", annotations: { readOnlyHint: false } }], need).join(), /not annotated read-only/);
  });
  await test("a name off the allowlist throws before the child hears of it, and the child starts with no key in its argv", async () => {
    const c = newCase();
    const up = new Upstream({ entry: FAKE, apiKey: FAKE_KEY, allowed: READONLY_UPSTREAM_TOOLS, pinnedSha256: null, expectServer: null, extraEnv: { FAKE_CP_STATE: c.state, FAKE_CP_CALLS: c.calls } });
    try {
      await assert.rejects(up.call("wallet_transfer", {}, 5000), /not on this client's allowlist/);
      await assert.rejects(up.call(UPSTREAM_LAUNCH_TOOL, launchArguments({}), 5000), /not on this client's allowlist/);
      const r = await up.call("list_automations", { agent_id: CLAWPUMP_AGENT_ID }, 5000);
      assert.equal(r.isError, false);
    } finally {
      await up.close();
    }
    const start = c.callLog().find((l) => l.event === "start")!;
    // macOS adds __CF_USER_TEXT_ENCODING to every process; nothing else may appear
    assert.deepEqual(start.envKeys!.filter((k) => k !== "__CF_USER_TEXT_ENCODING"), ["CLAWPUMP_API_KEY", "FAKE_CP_CALLS", "FAKE_CP_STATE", "HOME", "PATH"]);
    assert.equal(start.apiKeyLength, FAKE_KEY.length);
    noSecretIn(JSON.stringify(start.argv), "the child's argv");
    assert.equal(c.upstreamCalls("wallet_transfer"), 0);
    assert.equal(c.upstreamCalls(UPSTREAM_LAUNCH_TOOL), 0);
  });
  await test("the pinned client refuses an entry that does not hash to the pin", async () => {
    const up = new Upstream({ entry: FAKE, apiKey: FAKE_KEY, allowed: READONLY_UPSTREAM_TOOLS, pinnedSha256: "0".repeat(64) });
    await assert.rejects(up.connect(), /does not hash to the pinned @clawpump\/agents 0\.1\.27/);
  });
  await test("the read-only check: the six calls, all on the read-only allowlist, all for his agent; its readiness names what is wrong", () => {
    assert.deepEqual(CHECK_CALLS.map(([n]) => n).sort(), [...READONLY_UPSTREAM_TOOLS].sort());
    for (const [, a] of CHECK_CALLS) if ("agent_id" in a) assert.equal(a.agent_id, CLAWPUMP_AGENT_ID);
    const lines = readiness({ get_launch_status: statusView(observedStatus()), list_automations: [], get_agent: { status: "stopped", is_public: true, accepting_bids: true } }).join("\n");
    assert.match(lines, /no token_mint yet/);
    assert.match(lines, /does NOT match/);
    assert.match(lines, /no automations/);
    assert.match(lines, /accepting_bids true: turn both off/);
    assert.match(readiness({ get_launch_status: statusView(goodStatus()), list_automations: [{ id: "a" }], get_agent: {} }).join("\n"), /1 AUTOMATION/);
  });

  console.log("the bridge over HTTP");
  await test("it refuses to start on a secrets file looser than 600, and against a server that is not the pinned one", async () => {
    const c = newCase();
    fs.chmodSync(c.secrets, 0o644);
    await assert.rejects(startBridge(bridgeOpts(c)), /must be 600/);
    fs.chmodSync(c.secrets, 0o600);
    for (const variant of ["changed-schema", "no-launch-tool", "status-not-readonly"]) {
      await assert.rejects(startBridge(bridgeOpts(c, { upstreamExtraEnv: { FAKE_CP_STATE: c.state, FAKE_CP_CALLS: c.calls, FAKE_CP_VARIANT: variant } })), /not the pinned one/, variant);
    }
    await assert.rejects(startBridge(bridgeOpts(c, { upstreamEntry: undefined, installDir: path.join(c.dir, "nowhere") })), /no @clawpump\/agents install/);
  });
  await test("Host, Origin and bearer: a foreign Host or any Origin is 403, no or a wrong bearer is 401, only POST /mcp", async () => {
    const c = newCase();
    const b = await startBridge(bridgeOpts(c));
    try {
      const host = `127.0.0.1:${b.port}`;
      const auth = `Bearer ${FAKE_TOKEN}`;
      assert.equal(await rawPost(b.port, { host: `localhost:${b.port}`, authorization: auth }), 403);
      assert.equal(await rawPost(b.port, { host: "evil.example:3140", authorization: auth }), 403);
      assert.equal(await rawPost(b.port, { host, authorization: auth, origin: "https://evil.example" }), 403);
      assert.equal(await rawPost(b.port, { host }), 401);
      assert.equal(await rawPost(b.port, { host, authorization: `Bearer ${"c".repeat(64)}` }), 401);
      assert.equal(await rawPost(b.port, { host, authorization: FAKE_TOKEN }), 401);
      assert.equal(await rawPost(b.port, { host, authorization: auth }, undefined, "/other"), 404);
      assert.equal(await rawPost(b.port, { host, authorization: auth }, "[]"), 400);
      assert.equal(await rawPost(b.port, { host, authorization: auth }, "not json"), 400);
      await assert.rejects(connect(b.url, "d".repeat(64)));
    } finally {
      await b.close();
    }
  });
  await test("it lists exactly token_launch_status and token_launch; the status is redacted and says whether the spec matches", async () => {
    const c = newCase(observedStatus());
    await withBridge(c, {}, async (_b, client) => {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(names, [BRIDGE_LAUNCH_TOOL, BRIDGE_STATUS_TOOL]);
      const s = await callJson(client, BRIDGE_STATUS_TOOL);
      assert.equal(s.isError, false);
      assert.equal(s.body.specMatches, false);
      assert.equal(s.body.token_mint, null);
      assert.deepEqual((s.body.bridge as { armed: boolean }).armed, false);
      const text = JSON.stringify(s.body);
      assert.ok(!text.includes("?token=") && !text.includes("eyJ"), "the signed URL's query is stripped");
      noSecretIn(text, "the status answer");
      await assert.rejects(client.callTool({ name: "wallet_transfer", arguments: {} }).then((r) => (r.isError ? Promise.reject(new Error("isError")) : r)));
    });
    assert.equal(c.upstreamCalls(UPSTREAM_LAUNCH_TOOL), 0);
  });
  await test("token_launch input: confirm must be true and a nonce is required", async () => {
    const c = newCase();
    const arm = armFor(c);
    await withBridge(c, {}, async (_b, client) => {
      for (const args of [{ confirm: true }, { confirm: false, nonce: arm.nonce }, { nonce: arm.nonce }, { confirm: true, nonce: "short" }]) {
        const r = await client.callTool({ name: BRIDGE_LAUNCH_TOOL, arguments: args });
        assert.equal(r.isError, true, JSON.stringify(args));
      }
    });
    assert.ok(fs.existsSync(c.arm), "a malformed call leaves the arm alone");
    assert.equal(c.upstreamCalls(UPSTREAM_LAUNCH_TOOL), 0);
  });
  await test("refusals before the arm is touched: no arm, a wrong nonce, an expired arm, an arm file looser than 600", async () => {
    const c = newCase();
    await withBridge(c, { live: true }, async (_b, client) => {
      let r = await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: "n".repeat(32) });
      assert.equal(r.isError, true);
      assert.match(String(r.body.message), /not armed/);

      const arm = armFor(c);
      r = await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: "n".repeat(32) });
      assert.match(String(r.body.message), /nonce does not match/);
      assert.ok(fs.existsSync(c.arm), "a wrong nonce does not burn the arm");

      fs.writeFileSync(c.arm, JSON.stringify({ nonce: arm.nonce, expiresAt: new Date(Date.now() - 1000).toISOString() }));
      r = await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: arm.nonce });
      assert.match(String(r.body.message), /expired/);

      fs.writeFileSync(c.arm, JSON.stringify({ nonce: arm.nonce, expiresAt: new Date(Date.now() + 600_000).toISOString() }));
      fs.chmodSync(c.arm, 0o644);
      r = await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: arm.nonce });
      assert.match(String(r.body.message), /must be 600/);
    });
    assert.equal(c.upstreamCalls(UPSTREAM_LAUNCH_TOOL), 0);
    assert.equal(c.upstreamCalls("get_launch_status"), 0, "no status read before the arm checks out");
  });
  await test("refusals after the status read, arm kept: the stored metadata off spec (MB), a website, a mint already there", async () => {
    for (const [name, status, re] of [
      ["as observed on 22 Sep", observedStatus(), /stored symbol is "MB"/],
      ["website filled", (() => {
        const s = goodStatus() as Record<string, any>;
        s.metadata.website = "https://mrbands.finance";
        return s;
      })(), /website is filled in/],
      ["mint exists", (() => {
        const s = goodStatus() as Record<string, any>;
        s.agent.token_mint = MINT;
        return s;
      })(), /already launched/],
    ] as const) {
      const c = newCase(status as Record<string, unknown>);
      const arm = armFor(c);
      await withBridge(c, { live: true }, async (_b, client) => {
        const r = await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: arm.nonce });
        assert.equal(r.isError, true, name);
        assert.equal(r.body.outcome, "refused", name);
        assert.match(String(r.body.message), re, name);
      });
      assert.ok(fs.existsSync(c.arm) && !fs.existsSync(`${c.arm}.used`), `${name}: a refusal on the status keeps the arm`);
      assert.equal(c.upstreamCalls(UPSTREAM_LAUNCH_TOOL), 0, name);
      assert.equal(c.upstreamCalls("get_launch_status"), 1, name);
    }
  });
  await test("dry run (the default): every check, the arm consumed, the call it would make returned, no launch sent", async () => {
    const c = newCase();
    const arm = armFor(c);
    await withBridge(c, {}, async (b, client) => {
      assert.equal(b.live, false);
      const r = await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: arm.nonce });
      assert.equal(r.isError, false);
      assert.equal(r.body.outcome, "dry-run");
      assert.equal(r.body.wouldCall, UPSTREAM_LAUNCH_TOOL);
      assert.deepEqual(r.body.arguments, launchArguments({}));
      const again = await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: arm.nonce });
      assert.match(String(again.body.message), /not armed/);
    });
    assert.ok(!fs.existsSync(c.arm) && fs.existsSync(`${c.arm}.used`));
    assert.ok(!fs.existsSync(c.inflight), "a dry run writes no in-flight marker");
    assert.equal(c.upstreamCalls(UPSTREAM_LAUNCH_TOOL), 0);
  });
  await test("live: one launch call with the pinned arguments byte for byte; the arm is .used before it; the mint reported; single use", async () => {
    const c = newCase();
    const arm = armFor(c);
    await withBridge(c, { live: true }, async (_b, client) => {
      const r = await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: arm.nonce });
      assert.equal(r.isError, false, JSON.stringify(r.body));
      assert.equal(r.body.outcome, "launched");
      assert.equal(r.body.mint, MINT);
      const again = await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: arm.nonce });
      assert.equal(again.body.outcome, "refused");
      // re-armed, the bridge still refuses: the status now shows the mint
      const arm2 = armFor(c);
      const third = await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: arm2.nonce });
      assert.match(String(third.body.message), /already launched/);
      const s = await callJson(client, BRIDGE_STATUS_TOOL);
      assert.equal(s.body.token_mint, MINT);
    });
    const launches = c.callLog().filter((l) => l.tool === UPSTREAM_LAUNCH_TOOL);
    assert.equal(launches.length, 1);
    assert.equal(JSON.stringify(launches[0].args), JSON.stringify(launchArguments({})));
    const tools = new Set(c.callLog().filter((l) => l.tool).map((l) => l.tool));
    assert.deepEqual([...tools].sort(), ["get_launch_status", UPSTREAM_LAUNCH_TOOL].sort(), "nothing else of ClawPump's is ever called");
    const audit = fs.readFileSync(c.audit, "utf8");
    noSecretIn(audit, "the audit");
    assert.equal(fs.statSync(c.audit).mode & 0o777, 0o600);
    const rows = audit.trim().split("\n").map((l) => JSON.parse(l) as { tool: string; outcome: string; mint: string | null; at: string });
    assert.ok(rows.every((x) => x.at && x.tool && x.outcome !== undefined && "mint" in x));
    assert.ok(rows.some((x) => x.outcome === "calling"));
    assert.ok(rows.some((x) => x.outcome === "launched" && x.mint === MINT));
    assert.ok(!/authorization|bearer/i.test(audit));
  });
  await test("the image and twitter the config sets are sent, and a config on the site's domain stops the bridge from starting", async () => {
    const c = newCase();
    fs.appendFileSync(c.secrets, "LAUNCH_IMAGE_URL=https://img.example.org/bands.png\nLAUNCH_TWITTER=MrBandsSol\n");
    const arm = armFor(c);
    await withBridge(c, { live: true }, async (_b, client) => {
      const r = await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: arm.nonce });
      assert.equal(r.body.outcome, "launched");
    });
    const sent = c.callLog().find((l) => l.tool === UPSTREAM_LAUNCH_TOOL)!.args!;
    assert.equal(sent.image_url, "https://img.example.org/bands.png");
    assert.equal(sent.twitter, "MrBandsSol");
    const d = newCase();
    fs.appendFileSync(d.secrets, "LAUNCH_IMAGE_URL=https://mrbands.finance/token-bands.png\n");
    await assert.rejects(startBridge(bridgeOpts(d)), /site's domain/);
  });
  await test("isError after the launch went through (the Genesis tool does that): the status is re-read and the mint reported as launched", async () => {
    const c = newCase(goodStatus(), { mode: "isError-with-mint", mint: MINT });
    const arm = armFor(c);
    await withBridge(c, { live: true }, async (_b, client) => {
      const r = await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: arm.nonce });
      assert.equal(r.isError, false);
      assert.equal(r.body.outcome, "launched");
      assert.equal(r.body.mint, MINT);
      assert.match(String(r.body.message), /reported an error, but the status shows mint/);
    });
    assert.equal(c.upstreamCalls(UPSTREAM_LAUNCH_TOOL), 1);
  });
  await test("isError and no mint (a 502): 'error-no-mint', never retried, the arm spent, the in-flight marker KEPT, a fresh arm refused", async () => {
    const c = newCase(goodStatus(), { mode: "isError-no-mint", mint: MINT });
    const arm = armFor(c);
    await withBridge(c, { live: true }, async (_b, client) => {
      const r = await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: arm.nonce });
      assert.equal(r.body.outcome, "error-no-mint");
      assert.equal(r.body.mint, null);
      assert.match(String(r.body.message), /clears the in-flight marker/);
      assert.ok(fs.existsSync(c.inflight), "a 502 may have reached the launch endpoint: the marker stays");
      // a fresh arm written behind the CLI's back is still refused by the bridge, before any status read
      const reads = c.upstreamCalls("get_launch_status");
      const arm2 = writeArm(c.arm, 10);
      const again = await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: arm2.nonce });
      assert.equal(again.body.outcome, "refused");
      assert.match(String(again.body.message), /may still be in flight/);
      assert.ok(fs.existsSync(c.arm), "the refusal keeps the fresh arm");
      assert.equal(c.upstreamCalls("get_launch_status"), reads);
      const s = await callJson(client, BRIDGE_STATUS_TOOL);
      assert.ok((s.body.bridge as { unsettledLaunchMarker: unknown }).unsettledLaunchMarker, "the status shows the marker");
    });
    assert.equal(c.upstreamCalls(UPSTREAM_LAUNCH_TOOL), 1);
    assert.ok(fs.existsSync(`${c.arm}.used`) || fs.existsSync(c.arm));
    // the CLI will not arm on top of it; --clear-inflight (after the dashboard) lets it
    assert.throws(() => armUnlessInflight(c.arm, 10), /never settled.*clear-inflight/s);
    assert.ok(clearInflight(c.inflight));
    assert.ok(armUnlessInflight(c.arm, 10).nonce.length === 32);
  });
  await test("a definite ClawPump refusal (no image): 'error-no-mint' and the marker removed, since nothing was sent", async () => {
    const c = newCase(goodStatus(), { mode: "refused-image", mint: MINT });
    const arm = armFor(c);
    await withBridge(c, { live: true }, async (_b, client) => {
      const r = await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: arm.nonce });
      assert.equal(r.body.outcome, "error-no-mint");
      assert.match(String(r.body.message), /refused the launch before sending it/);
    });
    assert.ok(!fs.existsSync(c.inflight));
    assert.equal(c.upstreamCalls(UPSTREAM_LAUNCH_TOOL), 1);
  });
  await test("definiteRefusal: ClawPump's pre-send refusals and validation errors only; a 5xx, a closed connection and a timeout are not", () => {
    for (const t of [
      '{"error": "A token image is required before launching a Metaplex Genesis token."}',
      '{"error": "This agent already has a launched token."}',
      "Payment required: Insufficient credits. Check your balance",
      "Rate limited: Too many requests.",
      "Access denied: nope.",
      "MCP error -32602: Input validation error: Invalid arguments for tool launch_metaplex_genesis_token",
    ])
      assert.ok(definiteRefusal(t), t);
    for (const t of ['{"error": "Server error (502): The ClawPump backend is experiencing issues. Try again shortly."}', "MCP error -32000: Connection closed", "MCP error -32001: Request timed out", "Network error: socket hang up", '{"error": "Token launch completed, but Metaplex Genesis status is pending."}'])
      assert.ok(!definiteRefusal(t), t);
  });
  await test("the child dies mid-launch: 'unknown' (never 'error-no-mint'), treated as pending, the marker kept", async () => {
    const c = newCase(goodStatus(), { mode: "crash", mint: MINT });
    const arm = armFor(c);
    await withBridge(c, { live: true }, async (_b, client) => {
      const r = await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: arm.nonce });
      assert.equal(r.body.outcome, "unknown", JSON.stringify(r.body));
      assert.match(String(r.body.message), /may still land/);
    });
    assert.equal(c.upstreamCalls(UPSTREAM_LAUNCH_TOOL), 1);
    assert.ok(fs.existsSync(c.inflight));
  });
  await test("a stop while the launch is pending, then a restart and a fresh arm: 'unknown', no child after close, and NO second launch", async () => {
    const c = newCase(goodStatus(), { mode: "ok", mint: MINT, delayMs: 4000 });
    const arm = armFor(c);
    const b1 = await startBridge(bridgeOpts(c, { live: true, responseDeadlineMs: 500 }));
    const cl1 = await connect(b1.url);
    const r1 = await callJson(cl1, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: arm.nonce });
    assert.equal(r1.body.outcome, "pending");
    assert.ok(b1.inFlightSince());
    await cl1.close();
    await b1.close();
    await b1.idle();
    assert.equal(c.starts(), 1, "settling after close spawned no new ClawPump child");
    assert.ok(fs.existsSync(c.inflight), "the marker outlives the bridge");
    const audit1 = fs.readFileSync(c.audit, "utf8");
    assert.match(audit1, /settled after pending: unknown/);
    assert.ok(!/error-no-mint/.test(audit1), audit1);

    const arm2 = writeArm(c.arm, 10);
    await withBridge(c, { live: true, responseDeadlineMs: 500 }, async (_b, client) => {
      const r2 = await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: arm2.nonce });
      assert.equal(r2.body.outcome, "refused");
      assert.match(String(r2.body.message), /may still be in flight/);
    });
    assert.equal(c.upstreamCalls(UPSTREAM_LAUNCH_TOOL), 1, "one launch call, ever");
    assert.ok(fs.existsSync(c.arm), "the fresh arm is not consumed");
  });
  await test("a slow status read: the answer clock starts at arrival; a status read past its cap is refused inside the deadline, arm kept, nothing sent", async () => {
    const c = newCase();
    c.patchState({ statusDelayMs: 1500 });
    const arm = armFor(c);
    await withBridge(c, { live: true, responseDeadlineMs: 2000, precheckStatusTimeoutMs: 800 }, async (_b, client) => {
      const t0 = Date.now();
      const r = await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: arm.nonce });
      const took = Date.now() - t0;
      assert.ok(took < 2000, `answered in ${took} ms`);
      assert.equal(r.body.outcome, "refused");
      assert.match(String(r.body.message), /in time.*arm is kept/);
    });
    assert.ok(fs.existsSync(c.arm) && !fs.existsSync(`${c.arm}.used`));
    assert.ok(!fs.existsSync(c.inflight));
    assert.equal(c.upstreamCalls(UPSTREAM_LAUNCH_TOOL), 0);
  });
  await test("a slow status read and a slow launch: 'pending' within the deadline measured from arrival, not after the status read", async () => {
    const c = newCase(goodStatus(), { mode: "ok", mint: MINT, delayMs: 6000 });
    c.patchState({ statusDelayMs: 1500 });
    const arm = armFor(c);
    await withBridge(c, { live: true, responseDeadlineMs: 2000, precheckStatusTimeoutMs: 1800 }, async (b, client) => {
      const t0 = Date.now();
      const r = await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: arm.nonce });
      const took = Date.now() - t0;
      assert.equal(r.body.outcome, "pending", JSON.stringify(r.body));
      assert.ok(took < 2300, `answered in ${took} ms, past the 2000 ms deadline`);
      await b.idle();
      const after = await callJson(client, BRIDGE_STATUS_TOOL);
      assert.equal(after.body.token_mint, MINT);
    });
    assert.equal(c.upstreamCalls(UPSTREAM_LAUNCH_TOOL), 1);
    assert.ok(!fs.existsSync(c.inflight), "a mint removes the marker");
  });
  await test("the marker file: next to the arm, mode 600, exclusive; unreadable counts as in flight", () => {
    const c = newCase();
    assert.equal(inflightFileFor(c.arm), c.inflight);
    assert.equal(inflightFileFor("/x/y"), "/x/y.inflight");
    assert.equal(readInflight(c.inflight), null);
    writeInflight(c.inflight, "live");
    assert.equal(fs.statSync(c.inflight).mode & 0o777, 0o600);
    assert.throws(() => writeInflight(c.inflight, "live"), /EEXIST/);
    fs.writeFileSync(c.inflight, "not json");
    assert.match(readInflight(c.inflight)!.since, /malformed/);
    assert.ok(clearInflight(c.inflight) && !clearInflight(c.inflight));
    assert.equal(parseArmArgs(["--clear-inflight"]).clearInflight, true);
    assert.throws(() => parseArmArgs(["--clear-inflight", "--disarm"]), /separate steps/);
  });
  await test("a slow launch: the gateway is answered 'submitted, outcome pending' inside the deadline, never 'failed'; the outcome lands in the status and the audit", async () => {
    const c = newCase(goodStatus(), { mode: "ok", mint: MINT, delayMs: 1500 });
    const arm = armFor(c);
    await withBridge(c, { live: true, responseDeadlineMs: 300 }, async (b, client) => {
      const t0 = Date.now();
      const r = await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: arm.nonce });
      assert.ok(Date.now() - t0 < 1400, "answered before the launch finished");
      assert.equal(r.isError, false);
      assert.equal(r.body.outcome, "pending");
      assert.equal(r.body.message, PENDING_MESSAGE);
      assert.ok(!/fail/i.test(JSON.stringify(r.body)));
      const during = await callJson(client, BRIDGE_STATUS_TOOL);
      assert.ok((during.body.bridge as { inFlightSince: string | null }).inFlightSince, "the status shows the launch in flight");
      const second = await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: arm.nonce });
      assert.match(String(second.body.message), /already in flight/);
      await b.idle();
      const after = await callJson(client, BRIDGE_STATUS_TOOL);
      assert.equal(after.body.token_mint, MINT);
      assert.equal((after.body.bridge as { lastLaunch: { outcome: string } }).lastLaunch.outcome, "launched");
    });
    assert.equal(c.upstreamCalls(UPSTREAM_LAUNCH_TOOL), 1);
    assert.match(fs.readFileSync(c.audit, "utf8"), /settled after pending: launched/);
    assert.ok(!fs.existsSync(c.inflight), "the mint removed the marker");
  });
  await test("the whole run's files, answers and logs carry no key and no bridge token", async () => {
    const logs: string[] = [];
    const c = newCase(goodStatus(), { mode: "isError-no-mint", mint: MINT });
    const arm = armFor(c);
    await withBridge(c, { live: true, log: (l) => logs.push(l) }, async (_b, client) => {
      await callJson(client, BRIDGE_STATUS_TOOL);
      await callJson(client, BRIDGE_LAUNCH_TOOL, { confirm: true, nonce: arm.nonce });
    });
    noSecretIn(logs.join("\n"), "the bridge log");
    noSecretIn(fs.readFileSync(c.audit, "utf8"), "the audit");
    assert.ok(!fs.readFileSync(c.audit, "utf8").includes(arm.nonce), "the audit never holds the nonce");
  });
  await test("the CLI flags: dry run unless --live; unknown flags refused", () => {
    assert.equal(parseBridgeArgs([]).live, undefined);
    assert.equal(parseBridgeArgs(["--live"]).live, true);
    assert.throws(() => parseBridgeArgs(["--port", "1"]), /unknown flag/);
    assert.throws(() => parseBridgeArgs(["--secrets-file"]), /needs a value/);
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} token-bridge tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
