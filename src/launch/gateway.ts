/**
 * The gateway side of his token launch (docs/launch.md), for Zach to run: it gives the launch bridge to the mr-bands
 * agent and to no other agent on the shared gateway, and takes it away again. Over the gateway's HTTP API with the
 * admin bearer (OPENHERMIT_TOKEN), the way src/scripts/openhermit.ts does.
 *
 *   npm run launch:gateway -- plan                       read-only: conflicts, what provision would write, the state now
 *   npm run launch:gateway -- provision [--approval]     the secret, the policy rows, the server row, enable for mr-bands
 *   npm run launch:gateway -- readback                   read-only: what the gateway holds (header NAMES only)
 *   npm run launch:gateway -- teardown                   disable for mr-bands, delete the row, the secret, the rows
 *   npm run launch:gateway -- schedules                  read-only: mr-bands' schedules
 *   npm run launch:gateway -- pause-schedules            pause every active one (ids kept in ~/.mrbands/paused-schedules.json)
 *   npm run launch:gateway -- resume-schedules           resume exactly those
 *   npm run launch:gateway -- schedule-launch            the one-shot owner turn: a "once" schedule a minute out whose
 *                                                        prompt (launchPrompt) carries the armed nonce, read from the
 *                                                        arm file, so the nonce is in no argv and no shell history
 *   flags: --secrets-file <f> (~/.mrbands/clawpump.env) --skip-bridge-check --paused-file <f> --arm-file <f>
 *
 * What provision writes, in this order, after reading mr-bands' policies and refusing on any conflicting row:
 *   1. the agent secret CLAWPUMP_BRIDGE_TOKEN on mr-bands (passThrough false), its value read from the secrets file,
 *      never from argv;
 *   2. policy rows on mr-bands: a server-level mcp allow for role owner (role-less desk and X-mention turns, and
 *      guests, never see the server); an exact allow for the owner on each of the two tools (so no prefix row can
 *      supply one), plus a require_approval for the owner on token_launch with --approval; a deny for everyone on
 *      mcp_enable and mcp_disable (his own mcp_enable would connect the raw row without its secret);
 *   3. the server row clawpump-launch at http://127.0.0.1:3140/mcp with the header
 *      Authorization: Bearer ${{CLAWPUMP_BRIDGE_TOKEN}}, the placeholder, never the token: the gateway expands it from
 *      mr-bands' own secrets at connect, so any other agent that enabled the row would send the literal and get a 401;
 *   4. enable with body {agentId: "mr-bands"}, asserted: never without an agentId (the gateway defaults that to every
 *      agent) and never "*". The enable reloads his MCP connections, bands-paper's included: run it between desk cycles.
 * Then a read-back through GET /api/agents/mr-bands/mcp-servers (header names only) and a wildcard probe.
 *
 * It never GETs an /api/admin route (GET /api/admin/mcp-servers returns header values) and never prints a secret.
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GATEWAY_LAUNCH_TOOL, GATEWAY_STATUS_TOOL, LAUNCH_SERVER_ID, launchPrompt } from "./arm";
import { DEFAULT_ARM_FILE, DEFAULT_SECRETS_FILE, MRBANDS_DIR, readArm, readSecrets } from "./files";
import { BRIDGE_LAUNCH_TOOL, BRIDGE_STATUS_TOOL } from "./spec";

export { GATEWAY_LAUNCH_TOOL, GATEWAY_STATUS_TOOL, LAUNCH_SERVER_ID };

/** The only agent this script ever touches. */
export const LAUNCH_AGENT = "mr-bands";
export const SECRET_NAME = "CLAWPUMP_BRIDGE_TOKEN";
export const BRIDGE_URL = "http://127.0.0.1:3140/mcp";
export const AUTH_PLACEHOLDER = `Bearer \${{${SECRET_NAME}}}`;
/**
 * An agent id no agent has. With the admin bearer, GET /api/agents/<it>/mcp-servers lists exactly the servers
 * assigned to "*" (the store lists an agent's own assignments and the wildcard's), so it answers "is clawpump-launch
 * on every agent?" without reading an admin route.
 */
export const WILDCARD_PROBE = "zz-launch-wildcard-probe";
export const DEFAULT_PAUSED_FILE = path.join(MRBANDS_DIR, "paused-schedules.json");

export interface GatewayLike {
  get<T>(route: string): Promise<T>;
  post<T>(route: string, body?: unknown): Promise<T>;
  put<T>(route: string, body: unknown): Promise<T>;
  delete<T>(route: string): Promise<T>;
}

export class GatewayHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The gateway over fetch with the admin bearer. Error messages carry the route and the status, never a header. */
export function httpGateway(base: string, token: string): GatewayLike {
  const call = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base.replace(/\/+$/, "")}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const e = parsed as { error?: { message?: string } | string } | null;
      const msg = typeof e?.error === "string" ? e.error : e?.error?.message ?? res.statusText;
      throw new GatewayHttpError(res.status, `${method} ${route} -> ${res.status}: ${String(msg).slice(0, 200)}`);
    }
    return parsed as T;
  };
  return { get: (r) => call("GET", r), post: (r, b = {}) => call("POST", r, b), put: (r, b) => call("PUT", r, b), delete: (r) => call("DELETE", r) };
}

/**
 * The gateway as this script may use it: no GET on an /api/admin route; an MCP enable or disable only with
 * {agentId: "mr-bands"}; a server row only with the placeholder header; and no body that carries one of `secrets`
 * except the one secret PUT. Anything else throws before the request.
 */
export function guarded(gw: GatewayLike, secrets: readonly string[] = []): GatewayLike {
  const leaks = (route: string, body: unknown) => {
    if (route === `/api/agents/${LAUNCH_AGENT}/secrets/${SECRET_NAME}`) return;
    const s = JSON.stringify(body ?? null);
    for (const sec of secrets) if (sec && s.includes(sec)) throw new Error(`refused: a request to ${route} would carry a secret`);
  };
  return {
    get: (r) => {
      if (r.startsWith("/api/admin")) throw new Error(`refused: GET ${r} is an admin read (it can return header values); this script never makes one`);
      return gw.get(r);
    },
    post: (r, b = {}) => {
      leaks(r, b);
      if (/^\/api\/admin\/mcp-servers\/[^/]+\/(enable|disable)$/.test(r)) assertAgentBody(b);
      if (/^\/api\/agents\/[^/]+\/mcp-servers\//.test(r)) throw new Error(`refused: ${r}: enable and disable go through the admin route with {agentId}`);
      if (r === "/api/admin/mcp-servers") assertServerRow(b);
      if (r.startsWith("/api/agents/") && !r.startsWith(`/api/agents/${LAUNCH_AGENT}/`)) throw new Error(`refused: ${r} is not mr-bands`);
      return gw.post(r, b);
    },
    put: (r, b) => {
      leaks(r, b);
      if (r.startsWith("/api/agents/") && !r.startsWith(`/api/agents/${LAUNCH_AGENT}/`)) throw new Error(`refused: ${r} is not mr-bands`);
      return gw.put(r, b);
    },
    delete: (r) => {
      if (r.startsWith("/api/agents/") && !r.startsWith(`/api/agents/${LAUNCH_AGENT}/`)) throw new Error(`refused: ${r} is not mr-bands`);
      if (r.startsWith("/api/admin/mcp-servers/") && r !== `/api/admin/mcp-servers/${LAUNCH_SERVER_ID}`) throw new Error(`refused: this script deletes only the ${LAUNCH_SERVER_ID} row`);
      return gw.delete(r);
    },
  };
}

/** The enable/disable body: mr-bands, asserted. */
export function enableBody(): { agentId: string } {
  const body = { agentId: LAUNCH_AGENT };
  assertAgentBody(body);
  return body;
}

export function assertAgentBody(body: unknown): void {
  const id = (body as { agentId?: unknown } | null)?.agentId;
  if (typeof id !== "string" || id === "*" || id !== LAUNCH_AGENT) throw new Error(`refused: an MCP enable/disable must name agentId "${LAUNCH_AGENT}" (without one the gateway assigns every agent)`);
}

export interface ServerRow {
  id: string;
  name: string;
  description: string;
  url: string;
  headers: Record<string, string>;
  metadata: Record<string, unknown>;
}

/** The server row: the bridge's URL and the placeholder header. PURE. */
export function serverRow(): ServerRow {
  const row: ServerRow = {
    id: LAUNCH_SERVER_ID,
    name: "ClawPump launch (Mr Bands)",
    description: `The launch bridge on 127.0.0.1:3140 for Mr Bands' own token: ${BRIDGE_STATUS_TOOL} (read-only) and ${BRIDGE_LAUNCH_TOOL} (once, armed by his architect, spec fixed in code). Its bearer is mr-bands' own secret ${SECRET_NAME}: another agent enabling this row gets a 401.`,
    url: BRIDGE_URL,
    headers: { Authorization: AUTH_PLACEHOLDER },
    metadata: { owner: LAUNCH_AGENT, audience: "launch" },
  };
  assertServerRow(row);
  return row;
}

export function assertServerRow(body: unknown): void {
  const b = body as Partial<ServerRow> | null;
  if (!b || b.id !== LAUNCH_SERVER_ID || b.url !== BRIDGE_URL) throw new Error(`refused: this script registers only ${LAUNCH_SERVER_ID} at ${BRIDGE_URL}`);
  const h = b.headers ?? {};
  if (Object.keys(h).length !== 1 || h.Authorization !== AUTH_PLACEHOLDER) throw new Error(`refused: the ${LAUNCH_SERVER_ID} row's only header is Authorization: ${AUTH_PLACEHOLDER} (the placeholder, never a token)`);
}

export interface Grant {
  type: string;
  value?: string;
}
export interface PolicyRowOut {
  resourceType: "tool" | "mcp";
  resourceKey: string;
  effect: "allow" | "deny" | "require_approval";
  grants: Grant[];
  scope: Record<string, never>;
}
export interface PolicySeen {
  resourceType?: string;
  resourceKey?: string;
  effect?: string;
  grants?: unknown[];
}

const OWNER: Grant[] = [{ type: "role", value: "owner" }];

/** The rows provision writes on mr-bands. Grant "any" only ever on a deny. PURE. */
export function desiredPolicyRows(approval: boolean): PolicyRowOut[] {
  const rows: PolicyRowOut[] = [
    { resourceType: "mcp", resourceKey: LAUNCH_SERVER_ID, effect: "allow", grants: OWNER, scope: {} },
    { resourceType: "tool", resourceKey: GATEWAY_STATUS_TOOL, effect: "allow", grants: OWNER, scope: {} },
    { resourceType: "tool", resourceKey: GATEWAY_LAUNCH_TOOL, effect: "allow", grants: OWNER, scope: {} },
    ...(approval ? [{ resourceType: "tool" as const, resourceKey: GATEWAY_LAUNCH_TOOL, effect: "require_approval" as const, grants: OWNER, scope: {} }] : []),
    { resourceType: "tool", resourceKey: "mcp_enable", effect: "deny", grants: [{ type: "any" }], scope: {} },
    { resourceType: "tool", resourceKey: "mcp_disable", effect: "deny", grants: [{ type: "any" }], scope: {} },
  ];
  for (const r of rows) if (r.effect !== "deny" && r.grants.some((g) => g.type === "any")) throw new Error(`refused: ${r.resourceKey} would be granted to any caller`);
  return rows;
}

const grantsKey = (g: unknown[] | undefined) =>
  JSON.stringify(
    (g ?? [])
      .map((x) => {
        const o = (x ?? {}) as Grant;
        return { type: o.type, ...(o.value !== undefined ? { value: o.value } : {}) };
      })
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
const grantsText = (g: unknown[] | undefined) => (g ?? []).map((x) => ((x as Grant).value ? `${(x as Grant).type}:${(x as Grant).value}` : (x as Grant).type)).join("|") || "none";

export function sameRow(a: PolicySeen, b: PolicySeen): boolean {
  return a.resourceType === b.resourceType && a.resourceKey === b.resourceKey && (a.effect ?? "allow") === (b.effect ?? "allow") && grantsKey(a.grants) === grantsKey(b.grants);
}

/** Our own keys: the two tools and the server. */
const OUR_TOOLS = [GATEWAY_STATUS_TOOL, GATEWAY_LAUNCH_TOOL];
const isOurs = (r: PolicySeen) => (r.resourceType === "tool" && OUR_TOOLS.includes(r.resourceKey ?? "")) || (r.resourceType === "mcp" && r.resourceKey === LAUNCH_SERVER_ID);

/**
 * Existing rows that would change what the launch rows mean; empty = safe to write. A wildcard tool row whose prefix
 * covers a launch tool (a prefix row counts for every effect the exact rows leave out: an allow for "any" there would
 * reach role-less turns, a deny would hide the tool from the owner too); an mcp row on "*" or a prefix of the server
 * id; and a row on our own keys that this script does not write (an allow for "any", an approval nobody chose). PURE.
 */
export function policyConflicts(existing: readonly PolicySeen[], desired: readonly PolicyRowOut[]): string[] {
  const c: string[] = [];
  for (const r of existing) {
    const key = r.resourceKey ?? "";
    const desc = `${r.resourceType} row ${key} (${r.effect ?? "allow"}, ${grantsText(r.grants)})`;
    const prefix = key.endsWith("*") ? key.slice(0, -1) : null;
    if (r.resourceType === "tool" && prefix !== null && OUR_TOOLS.some((t) => t.startsWith(prefix))) c.push(`${desc} is a wildcard that also covers the launch tools: narrow or delete it first`);
    if (r.resourceType === "mcp" && prefix !== null && LAUNCH_SERVER_ID.startsWith(prefix)) c.push(`${desc} is a wildcard that also covers ${LAUNCH_SERVER_ID}: narrow or delete it first`);
    if (isOurs(r) && !desired.some((d) => sameRow(d, r))) c.push(`${desc} is not a row this script writes${r.effect === "require_approval" ? " (run with --approval to keep it)" : ""}: delete it first`);
  }
  return c;
}

interface AgentMcpRow {
  id: string;
  url?: string;
  headerKeys?: string[];
}

export interface Readback {
  enabled: boolean;
  url: string | null;
  headerKeys: string[];
  /** assigned to "*": every agent on the gateway */
  wildcard: boolean;
  secretSet: boolean;
  secretPassThrough: boolean | null;
  policies: PolicySeen[];
}

/** What the gateway holds for the launch, from routes that never return a header value or a secret. */
export async function readback(gw: GatewayLike): Promise<Readback> {
  const a = LAUNCH_AGENT;
  const servers = (await gw.get<AgentMcpRow[]>(`/api/agents/${a}/mcp-servers`)) ?? [];
  const mine = servers.find((s) => s.id === LAUNCH_SERVER_ID);
  const probe = (await gw.get<AgentMcpRow[]>(`/api/agents/${WILDCARD_PROBE}/mcp-servers`)) ?? [];
  const secrets = (await gw.get<Record<string, { passThrough?: boolean }>>(`/api/agents/${a}/secrets`)) ?? {};
  const policies = ((await gw.get<PolicySeen[]>(`/api/agents/${a}/policies`)) ?? []).filter((r) => isOurs(r) || (r.resourceType === "tool" && (r.resourceKey === "mcp_enable" || r.resourceKey === "mcp_disable")));
  return {
    enabled: !!mine,
    url: mine?.url ?? null,
    headerKeys: mine?.headerKeys ?? [],
    wildcard: probe.some((s) => s.id === LAUNCH_SERVER_ID),
    secretSet: Object.prototype.hasOwnProperty.call(secrets, SECRET_NAME),
    secretPassThrough: secrets[SECRET_NAME] ? secrets[SECRET_NAME].passThrough === true : null,
    policies,
  };
}

export function describeReadback(r: Readback): string[] {
  return [
    `${LAUNCH_SERVER_ID} on ${LAUNCH_AGENT}: ${r.enabled ? `enabled, url ${r.url}, header names [${r.headerKeys.join(", ")}]` : "not enabled"}`,
    `assigned to every agent ("*"): ${r.wildcard ? "YES: disable it for * now (hermit mcp disable clawpump-launch --all)" : "no"}`,
    `agent secret ${SECRET_NAME}: ${r.secretSet ? `set, passThrough ${r.secretPassThrough}` : "not set"}`,
    ...r.policies.map((p) => `policy ${p.resourceType} ${p.resourceKey} ${p.effect ?? "allow"} ${grantsText(p.grants)}`),
  ];
}

export interface ProvisionOptions {
  bridgeToken: string;
  approval: boolean;
  log: (line: string) => void;
}

/** See the header. Throws (having written nothing) on a conflict, and throws after the writes if the read-back is wrong. */
export async function provision(raw: GatewayLike, o: ProvisionOptions): Promise<Readback> {
  const gw = guarded(raw, [o.bridgeToken]);
  const a = LAUNCH_AGENT;
  const desired = desiredPolicyRows(o.approval);
  const existing = (await gw.get<PolicySeen[]>(`/api/agents/${a}/policies`)) ?? [];
  const conflicts = policyConflicts(existing, desired);
  if (conflicts.length) throw new Error(`refused, nothing written. Conflicting policy rows on ${a}:\n  - ${conflicts.join("\n  - ")}`);

  await gw.put(`/api/agents/${a}/secrets/${SECRET_NAME}`, { value: o.bridgeToken, passThrough: false });
  o.log(`secret ${SECRET_NAME} set on ${a} (length ${o.bridgeToken.length}, passThrough false)`);
  for (const row of desired) {
    if (existing.some((r) => sameRow(r, row))) {
      o.log(`policy ${row.resourceType} ${row.resourceKey} ${row.effect} ${grantsText(row.grants)}: already there`);
      continue;
    }
    await gw.post(`/api/agents/${a}/policies`, row);
    o.log(`policy ${row.resourceType} ${row.resourceKey} ${row.effect} ${grantsText(row.grants)}: written`);
  }
  await gw.post("/api/admin/mcp-servers", serverRow());
  o.log(`server row ${LAUNCH_SERVER_ID} -> ${BRIDGE_URL}, header Authorization (the ${SECRET_NAME} placeholder)`);
  await gw.post(`/api/admin/mcp-servers/${LAUNCH_SERVER_ID}/enable`, enableBody());
  o.log(`enabled for ${a} only`);

  const rb = await readback(gw);
  const wrong: string[] = [];
  if (!rb.enabled) wrong.push(`${LAUNCH_SERVER_ID} is not enabled on ${a}`);
  if (rb.url !== BRIDGE_URL) wrong.push(`its url reads ${rb.url}`);
  if (rb.headerKeys.join(",") !== "Authorization") wrong.push(`its header names are [${rb.headerKeys.join(", ")}]`);
  if (rb.wildcard) wrong.push(`${LAUNCH_SERVER_ID} is assigned to every agent ("*")`);
  if (!rb.secretSet) wrong.push(`${SECRET_NAME} is not set`);
  if (rb.secretPassThrough !== false) wrong.push(`${SECRET_NAME} passes through to the sandbox`);
  for (const row of desired) if (!rb.policies.some((p) => sameRow(p, row))) wrong.push(`policy ${row.resourceType} ${row.resourceKey} ${row.effect} is missing`);
  if (wrong.length) throw new Error(`read-back is wrong: ${wrong.join("; ")}. Run teardown and look before trying again.`);
  return rb;
}

/** Disable for mr-bands, delete the row (and with it every assignment), the secret and the launch policy rows. The mcp_enable/mcp_disable denies stay. */
export async function teardown(raw: GatewayLike, log: (line: string) => void): Promise<Readback> {
  const gw = guarded(raw);
  const a = LAUNCH_AGENT;
  const tolerate404 = async (what: string, p: Promise<unknown>) => {
    try {
      await p;
      log(what);
    } catch (err) {
      if (err instanceof GatewayHttpError && err.status === 404) log(`${what}: was not there`);
      else throw err;
    }
  };
  await tolerate404(`disabled ${LAUNCH_SERVER_ID} for ${a}`, gw.post(`/api/admin/mcp-servers/${LAUNCH_SERVER_ID}/disable`, enableBody()));
  await tolerate404(`deleted the ${LAUNCH_SERVER_ID} row (and every assignment of it)`, gw.delete(`/api/admin/mcp-servers/${LAUNCH_SERVER_ID}`));
  await tolerate404(`deleted the secret ${SECRET_NAME} on ${a}`, gw.delete(`/api/agents/${a}/secrets/${SECRET_NAME}`));
  const rows = ((await gw.get<PolicySeen[]>(`/api/agents/${a}/policies`)) ?? []).filter(isOurs);
  for (const r of rows) {
    await tolerate404(`deleted policy ${r.resourceType} ${r.resourceKey} ${r.effect ?? "allow"}`, gw.delete(`/api/agents/${a}/policies/${r.resourceType}/${encodeURIComponent(r.resourceKey ?? "")}?effect=${encodeURIComponent(r.effect ?? "allow")}`));
  }
  const rb = await readback(gw);
  if (rb.enabled || rb.wildcard || rb.secretSet || rb.policies.some(isOurs)) throw new Error(`teardown left something behind: ${describeReadback(rb).join("; ")}`);
  return rb;
}

// ---------------------------------------------------------------------------------------------
// schedules: paused before arming, so no owner turn but the one-shot launch turn runs in the window
// ---------------------------------------------------------------------------------------------

export interface ScheduleSeen {
  scheduleId: string;
  type?: string;
  status?: string;
  cronExpression?: string;
  runAt?: string;
  prompt?: string;
  createdBy?: string;
}

export async function listSchedules(gw: GatewayLike): Promise<ScheduleSeen[]> {
  return (await guarded(gw).get<ScheduleSeen[]>(`/api/agents/${LAUNCH_AGENT}/schedules`)) ?? [];
}

export function describeSchedule(s: ScheduleSeen): string {
  const when = s.cronExpression ? `cron ${s.cronExpression}` : s.runAt ? `once at ${s.runAt}` : "";
  const prompt = (s.prompt ?? "").replace(/\s+/g, " ");
  return `${s.scheduleId} ${s.type ?? "?"} ${s.status ?? "?"} ${when} "${prompt.slice(0, 40)}${prompt.length > 40 ? "..." : ""}"`;
}

/** Pauses every active schedule on mr-bands and adds the ids to `file` (mode 600) so resume puts back exactly those. */
export async function pauseSchedules(raw: GatewayLike, file: string, log: (line: string) => void): Promise<string[]> {
  const gw = guarded(raw);
  const active = (await listSchedules(gw)).filter((s) => s.status === "active");
  const prior = readPaused(file);
  const paused: string[] = [];
  for (const s of active) {
    await gw.put(`/api/agents/${LAUNCH_AGENT}/schedules/${encodeURIComponent(s.scheduleId)}`, { status: "paused" });
    paused.push(s.scheduleId);
    log(`paused ${describeSchedule(s)}`);
  }
  const ids = [...new Set([...prior, ...paused])];
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ agent: LAUNCH_AGENT, ids }, null, 2) + "\n", { mode: 0o600 });
  if (!active.length) log("no active schedule on mr-bands");
  return paused;
}

function readPaused(file: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { ids?: unknown };
    return Array.isArray(raw.ids) ? raw.ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Resumes the schedules pause-schedules paused, and removes the file. */
export async function resumeSchedules(raw: GatewayLike, file: string, log: (line: string) => void): Promise<string[]> {
  const gw = guarded(raw);
  const ids = readPaused(file);
  for (const id of ids) {
    await gw.put(`/api/agents/${LAUNCH_AGENT}/schedules/${encodeURIComponent(id)}`, { status: "active" });
    log(`resumed ${id}`);
  }
  if (!ids.length) log(`nothing to resume (no ids in ${file})`);
  fs.rmSync(file, { force: true });
  return ids;
}

/**
 * The one-shot owner turn (docs/launch.md, "The launch turn"): a "once" schedule on mr-bands, created with the admin
 * bearer, so it runs as his owner (the gateway's earliest owner). Its prompt is launchPrompt with the armed nonce,
 * read from the arm file here. Refuses unless the arm is readable and has at least five minutes left, and unless
 * every other schedule on mr-bands is paused (no other owner turn runs in the window). Never prints the nonce.
 */
export async function scheduleLaunch(raw: GatewayLike, armFile: string, log: (line: string) => void, now = Date.now()): Promise<string> {
  const gw = guarded(raw);
  const arm = readArm(armFile);
  if (!arm.ok) throw new Error(`not scheduled: ${arm.reason} (npm run launch:arm first)`);
  if (Date.parse(arm.arm.expiresAt) - now < 5 * 60_000) throw new Error(`not scheduled: the arm expires at ${arm.arm.expiresAt}, under five minutes from now; re-arm`);
  const active = (await listSchedules(gw)).filter((x) => x.status === "active");
  if (active.length) throw new Error(`not scheduled: ${active.length} schedule(s) on ${LAUNCH_AGENT} still active (npm run launch:gateway -- pause-schedules): ${active.map(describeSchedule).join("; ")}`);
  const runAt = new Date(now + 60_000).toISOString();
  const id = `bands-launch-${now}`;
  await gw.post(`/api/agents/${LAUNCH_AGENT}/schedules`, { id, type: "once", runAt, prompt: launchPrompt(arm.arm.nonce, arm.arm.expiresAt) });
  log(`one-shot owner schedule ${id} on ${LAUNCH_AGENT} at ${runAt} (arm expires ${arm.arm.expiresAt}); its prompt carries the nonce, which is not printed`);
  return id;
}

/** The bridge, asked with its own bearer: it must serve exactly the two launch tools. */
export async function checkBridge(url: string, token: string): Promise<string[]> {
  const client = new Client({ name: "launch-provision-check", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    const want = [BRIDGE_LAUNCH_TOOL, BRIDGE_STATUS_TOOL].sort();
    if (names.join(",") !== want.join(",")) throw new Error(`the bridge at ${url} serves [${names.join(", ")}], not exactly [${want.join(", ")}]`);
    return names;
  } finally {
    await client.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export const GATEWAY_COMMANDS = ["plan", "provision", "readback", "teardown", "schedules", "pause-schedules", "resume-schedules", "schedule-launch"] as const;
export type GatewayCommand = (typeof GATEWAY_COMMANDS)[number];

export interface GatewayArgs {
  command: GatewayCommand;
  approval: boolean;
  secretsFile: string;
  skipBridgeCheck: boolean;
  pausedFile: string;
  armFile: string;
}

export function parseGatewayArgs(argv: string[]): GatewayArgs {
  const [command, ...rest] = argv;
  if (!(GATEWAY_COMMANDS as readonly string[]).includes(command ?? "")) throw new Error(`usage: npm run launch:gateway -- ${GATEWAY_COMMANDS.join("|")} [--approval] [--secrets-file f] [--skip-bridge-check] [--paused-file f] [--arm-file f]`);
  const o: GatewayArgs = { command: command as GatewayCommand, approval: false, secretsFile: DEFAULT_SECRETS_FILE, skipBridgeCheck: false, pausedFile: DEFAULT_PAUSED_FILE, armFile: DEFAULT_ARM_FILE };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--approval") o.approval = true;
    else if (a === "--skip-bridge-check") o.skipBridgeCheck = true;
    else if (a === "--secrets-file") o.secretsFile = rest[++i] ?? "";
    else if (a === "--paused-file") o.pausedFile = rest[++i] ?? "";
    else if (a === "--arm-file") o.armFile = rest[++i] ?? "";
    else throw new Error(`unknown flag ${a}`);
  }
  if (!o.secretsFile || !o.pausedFile || !o.armFile) throw new Error("a file flag needs a path");
  return o;
}

export async function runGateway(args: GatewayArgs, gw: GatewayLike, log: (line: string) => void, bridgeUrl = BRIDGE_URL): Promise<void> {
  switch (args.command) {
    case "plan": {
      const existing = (await guarded(gw).get<PolicySeen[]>(`/api/agents/${LAUNCH_AGENT}/policies`)) ?? [];
      const desired = desiredPolicyRows(args.approval);
      const conflicts = policyConflicts(existing, desired);
      log(conflicts.length ? `CONFLICTS (provision would refuse):\n  - ${conflicts.join("\n  - ")}` : "no conflicting policy rows");
      log(`provision would write: secret ${SECRET_NAME} on ${LAUNCH_AGENT}; ${desired.map((r) => `${r.resourceType} ${r.resourceKey} ${r.effect} ${grantsText(r.grants)}`).join("; ")}; server row ${LAUNCH_SERVER_ID} ${BRIDGE_URL} with header Authorization (placeholder); enable {agentId: "${LAUNCH_AGENT}"}`);
      for (const l of describeReadback(await readback(guarded(gw)))) log(`now: ${l}`);
      return;
    }
    case "provision": {
      const secrets = readSecrets(args.secretsFile, true);
      if (!args.skipBridgeCheck) log(`bridge serves: ${(await checkBridge(bridgeUrl, secrets.bridgeToken)).join(", ")}`);
      const rb = await provision(gw, { bridgeToken: secrets.bridgeToken, approval: args.approval, log });
      for (const l of describeReadback(rb)) log(`read-back: ${l}`);
      return;
    }
    case "readback":
      for (const l of describeReadback(await readback(guarded(gw)))) log(l);
      return;
    case "teardown":
      for (const l of describeReadback(await teardown(gw, log))) log(`after: ${l}`);
      return;
    case "schedules": {
      const all = await listSchedules(gw);
      if (!all.length) log("no schedules on mr-bands");
      for (const s of all) log(describeSchedule(s));
      return;
    }
    case "pause-schedules":
      await pauseSchedules(gw, args.pausedFile, log);
      return;
    case "resume-schedules":
      await resumeSchedules(gw, args.pausedFile, log);
      return;
    case "schedule-launch":
      await scheduleLaunch(gw, args.armFile, log);
      return;
  }
}

async function main(): Promise<void> {
  const args = parseGatewayArgs(process.argv.slice(2));
  // the admin token lives in the repo .env (OPENHERMIT_TOKEN), as for npm run openhermit; nothing ClawPump is read from it
  (await import("dotenv")).config({ quiet: true });
  const base = (process.env.OPENHERMIT_GATEWAY_URL ?? "").trim() || "http://127.0.0.1:4000";
  const token = (process.env.OPENHERMIT_TOKEN ?? "").trim();
  if (!token) throw new Error("OPENHERMIT_TOKEN (the gateway's admin token) is not set");
  await runGateway(args, httpGateway(base, token), (l) => console.log(l));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`launch:gateway: ${(err as Error).message}`);
    process.exit(1);
  });
}
