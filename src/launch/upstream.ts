/**
 * ClawPump's MCP server as the bridge's child process (docs/launch.md). The bridge starts it itself with node's
 * spawn: no shell, the entry file as the only argument, and an explicit env object holding the API key, HOME and a
 * minimal PATH and nothing else, so no other secret of this machine reaches it and the key is never in an argv. Its
 * stderr (it prints only its auth mode) is discarded.
 *
 * The client over it can call only the tool names it was built with (an allowlist checked before every call), and
 * refuses to connect to anything but the pinned package: the version in its package.json, the sha256 of its entry,
 * the server name and version it reports, and the launch tool's input schema. Tests pass their own stub entry and no
 * hash.
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { CLAWPUMP_INDEX_SHA256, CLAWPUMP_PACKAGE, CLAWPUMP_SERVER_NAME, CLAWPUMP_VERSION, LAUNCH_TOOL_PROPERTIES, UPSTREAM_LAUNCH_TOOL } from "./spec";

/** A stdio JSON-RPC transport over a child started with node's own spawn and exactly the env it is given. */
export class ChildStdioTransport implements Transport {
  private child: ChildProcess | null = null;
  private readonly buffer = new ReadBuffer();
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private readonly entry: string,
    private readonly env: Record<string, string>,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [this.entry], { env: this.env, stdio: ["pipe", "pipe", "ignore"], shell: false, windowsHide: true });
      let started = false;
      child.once("spawn", () => {
        started = true;
        resolve();
      });
      child.on("error", (err) => {
        if (!started) reject(err);
        this.onerror?.(err);
      });
      child.on("close", () => {
        if (this.child === child) this.child = null;
        this.onclose?.();
      });
      child.stdout!.on("data", (chunk: Buffer) => {
        this.buffer.append(chunk);
        for (;;) {
          let msg: JSONRPCMessage | null;
          try {
            msg = this.buffer.readMessage();
          } catch (err) {
            this.onerror?.(err as Error);
            continue;
          }
          if (!msg) break;
          this.onmessage?.(msg);
        }
      });
      child.stdout!.on("error", (err) => this.onerror?.(err));
      child.stdin!.on("error", (err) => this.onerror?.(err));
      this.child = child;
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (!stdin || stdin.destroyed) return reject(new Error("the ClawPump child is not running"));
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once("drain", () => resolve());
    });
  }

  async close(): Promise<void> {
    const c = this.child;
    this.child = null;
    this.buffer.clear();
    if (c && c.exitCode === null && c.signalCode === null) c.kill("SIGTERM");
  }
}

export interface UpstreamOptions {
  /** the server's entry file (dist/index.js of the pinned install, or a test stub) */
  entry: string;
  /** the cpk_ key: only ever in the child's env object */
  apiKey: string;
  /** the tool names this client may call */
  allowed: ReadonlySet<string>;
  /** sha256 the entry must hash to; null skips the check (tests' stub only) */
  pinnedSha256: string | null;
  /** extra env for a test stub; never used by the CLIs */
  extraEnv?: Record<string, string>;
  /** the server name/version the child must report at initialize; null skips it (tests) */
  expectServer?: { name: string; version: string } | null;
}

/** The pinned install's entry, checked: the package.json version, then (at connect) the entry's hash. Throws with the fix. */
export function pinnedEntry(installDir: string): string {
  const pkgDir = path.join(installDir, "node_modules", ...CLAWPUMP_PACKAGE.split("/"));
  const pkgFile = path.join(pkgDir, "package.json");
  let version = "";
  try {
    version = String((JSON.parse(fs.readFileSync(pkgFile, "utf8")) as { version?: string }).version ?? "");
  } catch {
    throw new Error(`no ${CLAWPUMP_PACKAGE} install at ${installDir}: install it from ops/clawpump-agents with npm ci --ignore-scripts (docs/launch.md)`);
  }
  if (version !== CLAWPUMP_VERSION) throw new Error(`${pkgFile} is version ${version}, not the pinned ${CLAWPUMP_VERSION}`);
  return path.join(pkgDir, "dist", "index.js");
}

export function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** The child's whole environment: the key, HOME (the package resolves its session dir from it) and a minimal PATH. */
export function childEnv(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  for (const k of Object.keys(extra)) if (/^CLAWPUMP_/.test(k)) throw new Error(`extra child env may not set ${k}`);
  return { CLAWPUMP_API_KEY: apiKey, HOME: process.env.HOME ?? "", PATH: "/usr/bin:/bin", ...extra };
}

interface ListedTool {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  inputSchema?: { properties?: Record<string, unknown> };
}

/** Why the listed tools are not the pinned package's, for the tools this client needs; empty when they are. PURE. */
export function toolProblems(tools: readonly ListedTool[], needed: ReadonlySet<string>): string[] {
  const p: string[] = [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const name of needed) {
    const t = byName.get(name);
    if (!t) {
      p.push(`the server offers no ${name}`);
      continue;
    }
    if (name === UPSTREAM_LAUNCH_TOOL) {
      const props = Object.keys(t.inputSchema?.properties ?? {}).sort();
      const want = [...LAUNCH_TOOL_PROPERTIES].sort();
      if (props.join(",") !== want.join(",")) p.push(`${name} takes ${props.join(", ")}, not the pinned ${want.join(", ")}`);
    } else if (t.annotations?.readOnlyHint !== true || t.annotations?.destructiveHint === true) {
      p.push(`${name} is not annotated read-only`);
    }
  }
  return p;
}

export interface ToolResult {
  isError: boolean;
  text: string;
}

/** A restricted, reconnecting MCP client over the ClawPump child. */
export class Upstream {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(private readonly opts: UpstreamOptions) {}

  /** Connects (once; again after the child exits) and checks the child is the pinned server. */
  async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async open(): Promise<Client> {
    const { entry, pinnedSha256 } = this.opts;
    if (pinnedSha256 !== null) {
      const got = sha256File(entry);
      if (got !== pinnedSha256) throw new Error(`${entry} does not hash to the pinned ${CLAWPUMP_PACKAGE} ${CLAWPUMP_VERSION} (sha256 ${got.slice(0, 12)}...): reinstall from ops/clawpump-agents`);
    }
    const transport = new ChildStdioTransport(entry, childEnv(this.opts.apiKey, this.opts.extraEnv));
    const client = new Client({ name: "mrbands-launch-bridge", version: "1.0.0" });
    transport.onclose = () => {
      if (this.client === client) this.client = null;
    };
    try {
      await client.connect(transport);
      const expect = this.opts.expectServer === undefined ? { name: CLAWPUMP_SERVER_NAME, version: CLAWPUMP_VERSION } : this.opts.expectServer;
      const info = client.getServerVersion();
      if (expect && (info?.name !== expect.name || info?.version !== expect.version)) throw new Error(`the child reports ${info?.name}@${info?.version}, not ${expect.name}@${expect.version}`);
      const { tools } = await client.listTools();
      const problems = toolProblems(tools as ListedTool[], this.opts.allowed);
      if (problems.length) throw new Error(`the ClawPump server is not the pinned one: ${problems.join("; ")}`);
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
    this.client = client;
    return client;
  }

  /** Calls one allowlisted tool. Anything else throws before the child hears of it. */
  async call(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolResult> {
    if (!this.opts.allowed.has(name)) throw new Error(`refused: ${name} is not on this client's allowlist`);
    const client = await this.connect();
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    const content = Array.isArray(r.content) ? (r.content as { type?: string; text?: string }[]) : [];
    return { isError: r.isError === true, text: content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n") };
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) await c.close().catch(() => undefined);
  }
}
