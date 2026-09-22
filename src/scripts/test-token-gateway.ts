/**
 * The gateway side of the launch (src/launch/gateway.ts) against a FAKE OpenHermit gateway: an HTTP server on a free
 * loopback port that mimics the routes the script uses, with the real ones' semantics as read in OpenHermit-next's
 * apps/gateway/src/app.ts (an enable with no agentId assigns "*"; policy rows upsert on type/key/effect; an agent's
 * MCP list covers its own and "*" assignments and strips header values; DELETE of a server row drops its assignments).
 * It never talks to 127.0.0.1:4000. The provision run also checks a real bridge (over a fake ClawPump).
 *   npx tsx src/scripts/test-token-gateway.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { startBridge } from "../launch/bridge";
import {
  AUTH_PLACEHOLDER,
  desiredPolicyRows,
  GATEWAY_LAUNCH_TOOL,
  GATEWAY_STATUS_TOOL,
  guarded,
  httpGateway,
  LAUNCH_SERVER_ID,
  parseGatewayArgs,
  policyConflicts,
  provision,
  runGateway,
  SECRET_NAME,
  serverRow,
  teardown,
  WILDCARD_PROBE,
  type GatewayLike,
  type PolicySeen,
} from "../launch/gateway";
import { writeArm } from "../launch/files";
import { CLAWPUMP_AGENT_ID, CLAWPUMP_AGENT_WALLET, TOKEN_DESCRIPTION } from "../launch/spec";
import { scheduleLaunch } from "../launch/gateway";

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "launch-gateway-test-"));
fs.chmodSync(TMP, 0o700);
const ADMIN = "admin-" + "a".repeat(40);
const BRIDGE_TOKEN = "t".repeat(64);
const FAKE_KEY = "cpk_TESTONLY_" + "k".repeat(35);

interface Policy {
  agentId: string;
  resourceType: string;
  resourceKey: string;
  effect: string;
  grants: unknown[];
  scope: unknown;
}
interface Req {
  method: string;
  route: string;
  body: unknown;
}

/** The fake gateway's state and its request log. */
class FakeGateway {
  servers = new Map<string, { id: string; url: string; headers?: Record<string, string>; name: string; description: string; metadata?: unknown }>();
  assignments: Array<{ agentId: string; serverId: string; enabled: boolean }> = [];
  secrets = new Map<string, { value: string; passThrough: boolean }>();
  policies: Policy[] = [];
  schedules = new Map<string, { scheduleId: string; type: string; status: string; cronExpression?: string; runAt?: string; prompt: string }>();
  log: Req[] = [];
  /** misbehaviours for tests */
  enableAssignsWildcard = false;
  private http: http.Server | null = null;
  base = "";

  async start(): Promise<void> {
    this.http = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (req.headers.authorization !== `Bearer ${ADMIN}`) return send(401, { error: "unauthorized" });
        let body: unknown = undefined;
        try {
          body = data ? JSON.parse(data) : undefined;
        } catch {
          return send(400, { error: "bad json" });
        }
        const url = new URL(req.url ?? "/", "http://x");
        const route = url.pathname;
        this.log.push({ method: req.method ?? "", route: route + url.search, body });
        try {
          const out = this.handle(req.method ?? "", route, url.searchParams, body as Record<string, unknown>);
          send(out[0], out[1]);
        } catch (err) {
          send(500, { error: (err as Error).message });
        }
      });
    });
    await new Promise<void>((r) => this.http!.listen(0, "127.0.0.1", () => r()));
    this.base = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    await new Promise<void>((r) => this.http!.close(() => r()));
  }

  private handle(method: string, route: string, q: URLSearchParams, body: Record<string, unknown>): [number, unknown] {
    let m: RegExpExecArray | null;
    if (method === "GET" && route.startsWith("/api/admin/")) {
      // the real route returns header values; the test fails if the script ever reaches here
      return [200, [...this.servers.values()]];
    }
    if ((m = /^\/api\/agents\/([^/]+)\/mcp-servers$/.exec(route)) && method === "GET") {
      const agent = m[1];
      const ids = new Set(this.assignments.filter((a) => a.enabled && (a.agentId === agent || a.agentId === "*")).map((a) => a.serverId));
      return [200, [...ids].map((id) => this.servers.get(id)).filter(Boolean).map((s) => {
        const { headers, ...rest } = s!;
        return { ...rest, headerKeys: headers ? Object.keys(headers) : [] };
      })];
    }
    if ((m = /^\/api\/agents\/([^/]+)\/secrets$/.exec(route)) && method === "GET") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of this.secrets) if (k.startsWith(`${m[1]}/`)) out[k.slice(m[1].length + 1)] = { masked: "****", passThrough: v.passThrough };
      return [200, out];
    }
    if ((m = /^\/api\/agents\/([^/]+)\/secrets\/([^/]+)$/.exec(route))) {
      const key = `${m[1]}/${m[2]}`;
      if (method === "PUT") {
        if (typeof body?.value !== "string") return [400, { error: "value" }];
        this.secrets.set(key, { value: body.value, passThrough: body.passThrough === true });
        return [200, { ok: true }];
      }
      if (method === "DELETE") {
        this.secrets.delete(key);
        return [200, { ok: true }];
      }
    }
    if ((m = /^\/api\/agents\/([^/]+)\/policies$/.exec(route))) {
      const agent = m[1];
      if (method === "GET") return [200, this.policies.filter((p) => p.agentId === agent)];
      if (method === "POST") {
        const effect = typeof body.effect === "string" ? body.effect : "allow";
        const existing = this.policies.find((p) => p.agentId === agent && p.resourceType === body.resourceType && p.resourceKey === body.resourceKey && p.effect === effect);
        if (existing) existing.grants = body.grants as unknown[];
        else this.policies.push({ agentId: agent, resourceType: String(body.resourceType), resourceKey: String(body.resourceKey), effect, grants: body.grants as unknown[], scope: body.scope ?? {} });
        return [201, { ok: true }];
      }
    }
    if ((m = /^\/api\/agents\/([^/]+)\/policies\/([^/]+)\/([^/]+)$/.exec(route)) && method === "DELETE") {
      const [agent, type, key] = [m[1], m[2], decodeURIComponent(m[3])];
      const effect = q.get("effect");
      const before = this.policies.length;
      this.policies = this.policies.filter((p) => !(p.agentId === agent && p.resourceType === type && p.resourceKey === key && (!effect || p.effect === effect)));
      return before === this.policies.length ? [404, { error: "Policy not found" }] : [200, { ok: true }];
    }
    if (route === "/api/admin/mcp-servers" && method === "POST") {
      this.servers.set(String(body.id), body as never);
      return [201, { ok: true }];
    }
    if ((m = /^\/api\/admin\/mcp-servers\/([^/]+)$/.exec(route)) && method === "DELETE") {
      this.servers.delete(m[1]);
      this.assignments = this.assignments.filter((a) => a.serverId !== m![1]);
      return [200, { ok: true }];
    }
    if ((m = /^\/api\/admin\/mcp-servers\/([^/]+)\/(enable|disable)$/.exec(route)) && method === "POST") {
      const agentId = this.enableAssignsWildcard ? "*" : typeof body?.agentId === "string" ? body.agentId : "*";
      const row = this.assignments.find((a) => a.agentId === agentId && a.serverId === m![1]);
      if (m[2] === "enable") {
        if (row) row.enabled = true;
        else this.assignments.push({ agentId, serverId: m[1], enabled: true });
      } else if (row) row.enabled = false;
      return [200, { ok: true }];
    }
    if ((m = /^\/api\/agents\/([^/]+)\/schedules$/.exec(route)) && method === "GET") return [200, [...this.schedules.values()]];
    if ((m = /^\/api\/agents\/([^/]+)\/schedules$/.exec(route)) && method === "POST") {
      const s = { scheduleId: String(body.id), type: String(body.type), status: "active", runAt: String(body.runAt), prompt: String(body.prompt) };
      this.schedules.set(s.scheduleId, s);
      return [201, s];
    }
    if ((m = /^\/api\/agents\/([^/]+)\/schedules\/([^/]+)$/.exec(route)) && method === "PUT") {
      const s = this.schedules.get(decodeURIComponent(m[2]));
      if (!s) return [404, { error: "Schedule not found" }];
      if (typeof body.status === "string") s.status = body.status;
      return [200, s];
    }
    return [404, { error: `no route ${method} ${route}` }];
  }

  requestsCarrying(secret: string): Req[] {
    return this.log.filter((r) => JSON.stringify(r).includes(secret));
  }
}

const OWNER = [{ type: "role", value: "owner" }];

async function withGateway(fn: (fake: FakeGateway, gw: GatewayLike) => Promise<void>): Promise<void> {
  const fake = new FakeGateway();
  await fake.start();
  try {
    await fn(fake, httpGateway(fake.base, ADMIN));
  } finally {
    await fake.stop();
  }
}

async function main(): Promise<void> {
  console.log("the rows, pure");
  await test("the server row: the bridge on 127.0.0.1:3140, one header, the placeholder and never a token", () => {
    const r = serverRow();
    assert.equal(r.id, "clawpump-launch");
    assert.equal(r.url, "http://127.0.0.1:3140/mcp");
    assert.deepEqual(r.headers, { Authorization: "Bearer ${{CLAWPUMP_BRIDGE_TOKEN}}" });
    assert.equal(AUTH_PLACEHOLDER, "Bearer ${{CLAWPUMP_BRIDGE_TOKEN}}");
    assert.equal(r.metadata.owner, "mr-bands");
  });
  await test("the policy rows: a server-level owner allow, exact owner allows on both tools, denies for mcp_enable and mcp_disable; 'any' only on a deny", () => {
    const rows = desiredPolicyRows(false);
    const t = rows.map((r) => `${r.resourceType} ${r.resourceKey} ${r.effect} ${JSON.stringify(r.grants)}`);
    assert.deepEqual(t, [
      `mcp clawpump-launch allow ${JSON.stringify(OWNER)}`,
      `tool ${GATEWAY_STATUS_TOOL} allow ${JSON.stringify(OWNER)}`,
      `tool ${GATEWAY_LAUNCH_TOOL} allow ${JSON.stringify(OWNER)}`,
      `tool mcp_enable deny [{"type":"any"}]`,
      `tool mcp_disable deny [{"type":"any"}]`,
    ]);
    const withApproval = desiredPolicyRows(true);
    assert.ok(withApproval.some((r) => r.resourceKey === GATEWAY_LAUNCH_TOOL && r.effect === "require_approval" && JSON.stringify(r.grants) === JSON.stringify(OWNER)));
    assert.ok(withApproval.some((r) => r.resourceKey === GATEWAY_LAUNCH_TOOL && r.effect === "allow"), "an exact allow sits next to the approval row");
    for (const r of withApproval) if (r.grants.some((g) => g.type === "any")) assert.equal(r.effect, "deny");
    assert.ok(!rows.some((r) => r.resourceKey.endsWith("*")), "no wildcard row: a deny there would hide the exact allows");
  });
  await test("conflicts: a tool wildcard covering the launch tools, an mcp wildcard, our key granted to any; bands-paper's own rows are fine", () => {
    const d = desiredPolicyRows(false);
    const c = (rows: PolicySeen[]) => policyConflicts(rows, d);
    assert.deepEqual(c([{ resourceType: "tool", resourceKey: "mcp__bands-paper__*", effect: "allow", grants: [{ type: "any" }] }, { resourceType: "tool", resourceKey: "web_fetch", effect: "deny", grants: [{ type: "any" }] }]), []);
    assert.match(c([{ resourceType: "tool", resourceKey: "mcp__clawpump-launch__*", effect: "deny", grants: [{ type: "any" }] }]).join(), /wildcard that also covers the launch tools/);
    assert.match(c([{ resourceType: "tool", resourceKey: "mcp__*", effect: "allow", grants: [{ type: "any" }] }]).join(), /wildcard/);
    assert.match(c([{ resourceType: "tool", resourceKey: "*", effect: "allow", grants: [{ type: "any" }] }]).join(), /wildcard/);
    assert.match(c([{ resourceType: "mcp", resourceKey: "*", effect: "allow", grants: [{ type: "any" }] }]).join(), /covers clawpump-launch/);
    assert.match(c([{ resourceType: "tool", resourceKey: GATEWAY_LAUNCH_TOOL, effect: "allow", grants: [{ type: "any" }] }]).join(), /not a row this script writes/);
    assert.match(c([{ resourceType: "tool", resourceKey: GATEWAY_LAUNCH_TOOL, effect: "require_approval", grants: OWNER }]).join(), /--approval/);
    assert.deepEqual(policyConflicts([{ resourceType: "tool", resourceKey: GATEWAY_LAUNCH_TOOL, effect: "require_approval", grants: OWNER }], desiredPolicyRows(true)), []);
    assert.deepEqual(c(d), [], "a second provision finds its own rows and no conflict");
  });
  await test("the guard: no admin GET, no enable without agentId or for *, no row with a literal bearer, no secret in a body but the one PUT", async () => {
    const calls: string[] = [];
    const rec: GatewayLike = {
      get: async (r) => (calls.push(`GET ${r}`), [] as never),
      post: async (r) => (calls.push(`POST ${r}`), {} as never),
      put: async (r) => (calls.push(`PUT ${r}`), {} as never),
      delete: async (r) => (calls.push(`DELETE ${r}`), {} as never),
    };
    const g = guarded(rec, [BRIDGE_TOKEN]);
    assert.throws(() => g.get("/api/admin/mcp-servers"), /admin read/);
    assert.throws(() => g.get("/api/admin/mcp-servers/clawpump-launch"), /admin read/);
    assert.throws(() => g.post("/api/admin/mcp-servers/clawpump-launch/enable", {}), /must name agentId "mr-bands"/);
    assert.throws(() => g.post("/api/admin/mcp-servers/clawpump-launch/enable", { agentId: "*" }), /must name agentId/);
    assert.throws(() => g.post("/api/admin/mcp-servers/clawpump-launch/enable", { agentId: "meridian-1" }), /must name agentId/);
    assert.throws(() => g.post("/api/admin/mcp-servers/clawpump-launch/disable"), /must name agentId/);
    assert.throws(() => g.post("/api/agents/mr-bands/mcp-servers/clawpump-launch/enable", {}), /admin route with \{agentId\}/);
    assert.throws(() => g.post("/api/admin/mcp-servers", { ...serverRow(), headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` } }), /would carry a secret/);
    assert.throws(() => g.post("/api/admin/mcp-servers", { ...serverRow(), headers: { Authorization: "Bearer literal-token-xyz" } }), /placeholder/);
    assert.throws(() => g.post("/api/admin/mcp-servers", { ...serverRow(), url: "http://0.0.0.0:3140/mcp" }), /registers only/);
    assert.throws(() => g.post("/api/agents/other-agent/policies", {}), /not mr-bands/);
    assert.throws(() => g.put("/api/agents/other-agent/secrets/X", { value: "v" }), /not mr-bands/);
    assert.throws(() => g.delete("/api/admin/mcp-servers/bands-paper"), /deletes only/);
    assert.throws(() => g.put("/api/agents/mr-bands/secrets/OTHER", { value: BRIDGE_TOKEN }), /would carry a secret/);
    await g.put(`/api/agents/mr-bands/secrets/${SECRET_NAME}`, { value: BRIDGE_TOKEN });
    assert.deepEqual(calls, [`PUT /api/agents/mr-bands/secrets/${SECRET_NAME}`], "only the allowed call reached the gateway");
  });
  await test("the CLI's commands and flags", () => {
    assert.equal(parseGatewayArgs(["provision", "--approval"]).approval, true);
    assert.equal(parseGatewayArgs(["plan"]).command, "plan");
    assert.throws(() => parseGatewayArgs(["enable-all"]), /usage/);
    assert.throws(() => parseGatewayArgs(["provision", "--agent", "x"]), /unknown flag/);
  });

  console.log("against a fake gateway over HTTP");
  await test("provision: the secret from the file, the rows, the placeholder row, enable for mr-bands only; read-back clean; no admin GET", async () => {
    await withGateway(async (fake, gw) => {
      fake.policies.push({ agentId: "mr-bands", resourceType: "tool", resourceKey: "mcp__bands-paper__*", effect: "allow", grants: [{ type: "any" }], scope: {} });
      const logs: string[] = [];
      const rb = await provision(gw, { bridgeToken: BRIDGE_TOKEN, approval: false, log: (l) => logs.push(l) });
      assert.ok(rb.enabled && !rb.wildcard && rb.secretSet && rb.secretPassThrough === false);
      assert.deepEqual(rb.headerKeys, ["Authorization"]);
      assert.equal(fake.secrets.get(`mr-bands/${SECRET_NAME}`)?.value, BRIDGE_TOKEN);
      assert.equal(fake.servers.get(LAUNCH_SERVER_ID)?.headers?.Authorization, "Bearer ${{CLAWPUMP_BRIDGE_TOKEN}}");
      assert.deepEqual(fake.assignments, [{ agentId: "mr-bands", serverId: LAUNCH_SERVER_ID, enabled: true }]);
      assert.ok(!fake.log.some((r) => r.method === "GET" && r.route.startsWith("/api/admin")), "never an admin GET");
      const carrying = fake.requestsCarrying(BRIDGE_TOKEN);
      assert.deepEqual(carrying.map((r) => `${r.method} ${r.route}`), [`PUT /api/agents/mr-bands/secrets/${SECRET_NAME}`], "the token goes in one request body, the secret PUT");
      for (const l of logs) assert.ok(!l.includes(BRIDGE_TOKEN), l);
      const enable = fake.log.find((r) => r.route.endsWith("/enable"))!;
      assert.deepEqual(enable.body, { agentId: "mr-bands" });
      const mine = fake.policies.filter((p) => p.agentId === "mr-bands");
      assert.equal(mine.length, 6, "bands-paper's row plus our five");
      assert.ok(fake.log.findIndex((r) => r.route === "/api/agents/mr-bands/policies" && r.method === "GET") < fake.log.findIndex((r) => r.method === "PUT"), "policies read before anything is written");
      // a second run writes no duplicate rows
      await provision(gw, { bridgeToken: BRIDGE_TOKEN, approval: false, log: () => undefined });
      assert.equal(fake.policies.filter((p) => p.agentId === "mr-bands").length, 6);
    });
  });
  await test("provision refuses, having written nothing, on a conflicting wildcard", async () => {
    await withGateway(async (fake, gw) => {
      fake.policies.push({ agentId: "mr-bands", resourceType: "tool", resourceKey: "mcp__*", effect: "allow", grants: [{ type: "any" }], scope: {} });
      await assert.rejects(provision(gw, { bridgeToken: BRIDGE_TOKEN, approval: false, log: () => undefined }), /refused, nothing written/);
      assert.ok(!fake.log.some((r) => r.method !== "GET"), "only reads happened");
      assert.equal(fake.secrets.size, 0);
      assert.equal(fake.servers.size, 0);
    });
  });
  await test("a gateway that assigns the row to every agent anyway fails the read-back (the wildcard probe sees it)", async () => {
    await withGateway(async (fake, gw) => {
      fake.enableAssignsWildcard = true;
      await assert.rejects(provision(gw, { bridgeToken: BRIDGE_TOKEN, approval: false, log: () => undefined }), /assigned to every agent/);
      assert.ok(fake.log.some((r) => r.route === `/api/agents/${WILDCARD_PROBE}/mcp-servers`));
    });
  });
  await test("--approval: a require_approval row for the owner next to the exact allow", async () => {
    await withGateway(async (fake, gw) => {
      await provision(gw, { bridgeToken: BRIDGE_TOKEN, approval: true, log: () => undefined });
      const launchRows = fake.policies.filter((p) => p.resourceKey === GATEWAY_LAUNCH_TOOL).map((p) => p.effect).sort();
      assert.deepEqual(launchRows, ["allow", "require_approval"]);
    });
  });
  await test("teardown: disabled for mr-bands, the row and its assignments gone, the secret gone, our rows gone; the denies and others' rows stay", async () => {
    await withGateway(async (fake, gw) => {
      fake.policies.push({ agentId: "mr-bands", resourceType: "tool", resourceKey: "mcp__bands-paper__*", effect: "allow", grants: [{ type: "any" }], scope: {} });
      fake.servers.set("bands-paper", { id: "bands-paper", url: "http://127.0.0.1:3100/mcp", name: "p", description: "p" });
      fake.assignments.push({ agentId: "mr-bands", serverId: "bands-paper", enabled: true });
      await provision(gw, { bridgeToken: BRIDGE_TOKEN, approval: true, log: () => undefined });
      const logs: string[] = [];
      const rb = await teardown(gw, (l) => logs.push(l));
      assert.ok(!rb.enabled && !rb.secretSet && !rb.wildcard);
      assert.ok(!fake.servers.has(LAUNCH_SERVER_ID));
      assert.ok(fake.servers.has("bands-paper") && fake.assignments.some((a) => a.serverId === "bands-paper"), "bands-paper untouched");
      assert.ok(!fake.assignments.some((a) => a.serverId === LAUNCH_SERVER_ID));
      assert.ok(!fake.secrets.has(`mr-bands/${SECRET_NAME}`));
      const left = fake.policies.map((p) => `${p.resourceKey} ${p.effect}`).sort();
      assert.deepEqual(left, ["mcp__bands-paper__* allow", "mcp_disable deny", "mcp_enable deny"]);
      const disable = fake.log.find((r) => r.route.endsWith("/disable"))!;
      assert.deepEqual(disable.body, { agentId: "mr-bands" });
      assert.ok(!fake.log.some((r) => r.method === "GET" && r.route.startsWith("/api/admin")));
      // teardown twice is harmless
      await teardown(gw, () => undefined);
    });
  });
  await test("schedules: pause every active one on mr-bands, record the ids (mode 600), resume exactly those", async () => {
    await withGateway(async (fake, gw) => {
      fake.schedules.set("s1", { scheduleId: "s1", type: "cron", status: "active", cronExpression: "0 * * * *", prompt: "hourly look" });
      fake.schedules.set("s2", { scheduleId: "s2", type: "cron", status: "paused", cronExpression: "0 0 * * *", prompt: "was already paused" });
      fake.schedules.set("s3", { scheduleId: "s3", type: "once", status: "active", prompt: "one-off" });
      const file = path.join(TMP, "paused.json");
      const logs: string[] = [];
      await runGateway({ command: "pause-schedules", approval: false, secretsFile: "", skipBridgeCheck: true, pausedFile: file, armFile: "" }, gw, (l) => logs.push(l));
      assert.deepEqual([...fake.schedules.values()].map((s) => `${s.scheduleId} ${s.status}`), ["s1 paused", "s2 paused", "s3 paused"]);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      await runGateway({ command: "resume-schedules", approval: false, secretsFile: "", skipBridgeCheck: true, pausedFile: file, armFile: "" }, gw, (l) => logs.push(l));
      assert.deepEqual([...fake.schedules.values()].map((s) => `${s.scheduleId} ${s.status}`), ["s1 active", "s2 paused", "s3 active"], "the one paused before stays paused");
      assert.ok(!fs.existsSync(file));
    });
  });
  await test("schedule-launch: refuses without an arm, with an arm about to expire, or with a schedule still active; the nonce goes in the prompt and nowhere else", async () => {
    await withGateway(async (fake, gw) => {
      const arm = path.join(TMP, "sched.arm");
      await assert.rejects(scheduleLaunch(gw, arm, () => undefined), /not armed/);
      writeArm(arm, 3);
      await assert.rejects(scheduleLaunch(gw, arm, () => undefined), /under five minutes/);
      const a = writeArm(arm, 20);
      fake.schedules.set("s1", { scheduleId: "s1", type: "cron", status: "active", cronExpression: "0 * * * *", prompt: "hourly" });
      await assert.rejects(scheduleLaunch(gw, arm, () => undefined), /still active/);
      assert.ok(!fake.log.some((r) => r.method === "POST"));
      fake.schedules.get("s1")!.status = "paused";
      const logs: string[] = [];
      const id = await scheduleLaunch(gw, arm, (l) => logs.push(l));
      const s = fake.schedules.get(id)!;
      assert.equal(s.type, "once");
      assert.ok(s.prompt.includes(a.nonce) && s.prompt.includes(GATEWAY_LAUNCH_TOOL));
      assert.ok(Date.parse(s.runAt!) > Date.now());
      for (const l of logs) assert.ok(!l.includes(a.nonce), "the nonce is never printed");
      assert.equal(fake.requestsCarrying(a.nonce).length, 1, "the nonce goes in the one schedule body");
    });
  });
  await test("the CLI's provision: the token read from the secrets file (never argv), the bridge checked first to serve exactly two tools", async () => {
    // a real bridge over the fake ClawPump, with the same token
    const dir = fs.mkdtempSync(path.join(TMP, "bridge-"));
    fs.chmodSync(dir, 0o700);
    const secrets = path.join(dir, "clawpump.env");
    fs.writeFileSync(secrets, `CLAWPUMP_API_KEY=${FAKE_KEY}\nCLAWPUMP_BRIDGE_TOKEN=${BRIDGE_TOKEN}\n`, { mode: 0o600 });
    const state = path.join(dir, "state.json");
    fs.writeFileSync(state, JSON.stringify({ status: { agent: { id: CLAWPUMP_AGENT_ID, wallet_address: CLAWPUMP_AGENT_WALLET, token_mint: null }, metadata: { name: "Mr Bands", symbol: "BANDS", description: TOKEN_DESCRIPTION }, funding: {} } }));
    const bridge = await startBridge({ port: 0, secretsFile: secrets, armFile: path.join(dir, "arm"), auditFile: path.join(dir, "audit.jsonl"), upstreamEntry: path.join(__dirname, "fixtures", "fake-clawpump.mjs"), upstreamExtraEnv: { FAKE_CP_STATE: state, FAKE_CP_CALLS: path.join(dir, "calls.jsonl") }, log: () => undefined });
    try {
      await withGateway(async (fake, gw) => {
        const logs: string[] = [];
        await runGateway({ command: "provision", approval: false, secretsFile: secrets, skipBridgeCheck: false, pausedFile: path.join(dir, "p.json"), armFile: "" }, gw, (l) => logs.push(l), bridge.url);
        assert.ok(logs.some((l) => l === "bridge serves: token_launch, token_launch_status"), logs.join("\n"));
        assert.ok(logs.some((l) => /read-back: clawpump-launch on mr-bands: enabled/.test(l)));
        for (const l of logs) assert.ok(!l.includes(BRIDGE_TOKEN) && !l.includes(FAKE_KEY), l);
        assert.ok(!fake.requestsCarrying(FAKE_KEY).length, "the ClawPump key never reaches the gateway");
        await runGateway({ command: "plan", approval: false, secretsFile: secrets, skipBridgeCheck: true, pausedFile: path.join(dir, "p.json"), armFile: "" }, gw, (l) => logs.push(l));
        await runGateway({ command: "teardown", approval: false, secretsFile: secrets, skipBridgeCheck: true, pausedFile: path.join(dir, "p.json"), armFile: "" }, gw, (l) => logs.push(l));
        assert.ok(!fake.servers.has(LAUNCH_SERVER_ID));
      });
      // a bridge that is not up: provision stops before writing anything
      await withGateway(async (fake, gw) => {
        await assert.rejects(runGateway({ command: "provision", approval: false, secretsFile: secrets, skipBridgeCheck: false, pausedFile: path.join(dir, "p.json"), armFile: "" }, gw, () => undefined, "http://127.0.0.1:9/mcp"));
        assert.equal(fake.log.length, 0);
      });
    } finally {
      await bridge.close();
    }
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} token-gateway tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
