/**
 * The launch bridge (docs/launch.md): the one way Mr Bands' gateway agent reaches ClawPump, for one act, his token
 * launch. A Streamable HTTP MCP server on 127.0.0.1:3140 that serves exactly two tools and, behind them, spawns
 * ClawPump's own stdio server (@clawpump/agents 0.1.27, pinned) and calls exactly two of its 132 tools.
 *
 *   token_launch_status   read-only: get_launch_status for his ClawPump agent, URL query strings stripped, plus
 *                         whether the spec matches, whether the launch is armed, and any launch in flight.
 *   token_launch          {confirm: true, nonce}: in order, all inside one answer clock that starts when the
 *                         request arrives,
 *                         (0) no in-flight marker (~/.mrbands/bands-launch.inflight) may exist: an earlier launch
 *                             call that never settled, in this process or one before a restart, blocks every
 *                             launch until Zach checks the dashboard and runs `launch:arm -- --clear-inflight`;
 *                         (a) the arm file (~/.mrbands/bands-launch.arm, mode 600) must exist, match the nonce in
 *                             constant time, and be unexpired;
 *                         (b) get_launch_status is read again, reconnect included, within PRECHECK_STATUS_TIMEOUT_MS
 *                             (past it: refused, the arm kept): no mint may exist, and the stored metadata must
 *                             match the pinned spec exactly (src/launch/spec.ts specProblems);
 *                         (c) the in-flight marker is written, then the arm is renamed to .used, both BEFORE the
 *                             upstream call (single use; the marker outlives a stop, a crash or a restart);
 *                         (d) launch_metaplex_genesis_token is called once with the pinned arguments and a long
 *                             upstream timeout, but the gateway is answered within RESPONSE_DEADLINE_MS of the
 *                             request's arrival: a launch still running is "submitted, outcome pending; call
 *                             token_launch_status", never "failed";
 *                         (e) on an error or an isError result, get_launch_status is read again and the answer says
 *                             whether a mint now exists (the Genesis tool reports isError even after a launch). A
 *                             thrown error (the connection closed, a timeout) is "unknown", never "error-no-mint".
 *                             The marker is removed only on a mint or a definite ClawPump refusal (nothing sent);
 *                         (f) every call appends a line to ~/.mrbands/launch-audit.jsonl (tool, time, outcome, mint).
 *
 * The names sit outside bands_*, so the talk loop's tripwire (src/talk/replyBrain.ts parseReply) voids any X-mention
 * turn that touches them. Every request must carry Host 127.0.0.1:3140, no Origin, and the bearer
 * CLAWPUMP_BRIDGE_TOKEN (constant-time). Secrets come from ~/.mrbands/clawpump.env (mode 600) and never from the
 * repo's .env: this module imports nothing that loads it.
 *
 *   npm run launch:bridge                  DRY RUN (the default): every check, the arm consumed, and the call it
 *                                          would make returned instead of made
 *   npm run launch:bridge -- --live        the real thing
 *   flags: --secrets-file <f> --arm-file <f> --audit-file <f> --install-dir <d>
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  appendAudit,
  armProblem,
  bearerMatches,
  clearInflight,
  consumeArm,
  DEFAULT_ARM_FILE,
  DEFAULT_AUDIT_FILE,
  DEFAULT_INSTALL_DIR,
  DEFAULT_SECRETS_FILE,
  inflightFileFor,
  readArm,
  readInflight,
  readSecrets,
  writeInflight,
  type AuditLine,
} from "./files";
import {
  BRIDGE_LAUNCH_TOOL,
  BRIDGE_STATUS_TOOL,
  BRIDGE_UPSTREAM_TOOLS,
  CLAWPUMP_AGENT_ID,
  CLAWPUMP_INDEX_SHA256,
  checkLaunchConfig,
  launchArguments,
  mintOf,
  redactDeep,
  redactString,
  specProblems,
  UPSTREAM_LAUNCH_TOOL,
  UPSTREAM_STATUS_TOOL,
  type LaunchConfig,
} from "./spec";
import { pinnedEntry, Upstream } from "./upstream";

export const BRIDGE_HOST = "127.0.0.1";
export const BRIDGE_PORT = 3140;
/**
 * The gateway's MCP client gives up at 60 s (the SDK default, OpenHermit's mcp-client.ts passes no timeout); the
 * bridge answers within this many ms of the request's ARRIVAL, status read and reconnect included.
 */
export const RESPONSE_DEADLINE_MS = 45_000;
/** The pre-launch status read (b), a child reconnect included, gets at most this; past it the launch is refused, the arm kept. */
export const PRECHECK_STATUS_TIMEOUT_MS = 10_000;
/** How long the bridge itself waits on ClawPump for the launch call (its apiFetch has no timeout of its own). */
export const UPSTREAM_TIMEOUT_MS = 15 * 60_000;
export const STATUS_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 64 * 1024;

export const PENDING_MESSAGE = "submitted, outcome pending; call token_launch_status";

export const BRIDGE_INSTRUCTIONS = [
  "The launch bridge for Mr Bands' own token, $BANDS, on ClawPump. Two tools and nothing else.",
  "token_launch_status reads your ClawPump agent's launch status: the stored launch metadata, the funding, and the token_mint once launched. It is the only source of truth for whether the token exists.",
  "token_launch launches it once, with the spec fixed in code, and only while your architect has armed it: it needs the nonce from the armed prompt. It can answer \"submitted, outcome pending\": then call token_launch_status and do not call token_launch again. Never announce a launch, a mint or a failure until token_launch_status shows it.",
].join("\n\n");

export interface BridgeOptions {
  /** 3140 for the CLI; tests pass 0 for a free port. The host is always 127.0.0.1. */
  port?: number;
  secretsFile?: string;
  armFile?: string;
  auditFile?: string;
  /** the pinned install (DEFAULT_INSTALL_DIR); its entry must hash to CLAWPUMP_INDEX_SHA256 */
  installDir?: string;
  /** TESTS ONLY: a stub server's entry, run unpinned */
  upstreamEntry?: string;
  /** TESTS ONLY: extra env for the stub */
  upstreamExtraEnv?: Record<string, string>;
  /** false (the default) = dry run: the upstream launch call is never made */
  live?: boolean;
  responseDeadlineMs?: number;
  upstreamTimeoutMs?: number;
  statusTimeoutMs?: number;
  precheckStatusTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface LaunchReport {
  ok: boolean;
  outcome: "refused" | "dry-run" | "pending" | "launched" | "no-mint-after-success" | "error-no-mint" | "unknown";
  message: string;
  mint: string | null;
  [k: string]: unknown;
}

export interface Bridge {
  url: string;
  port: number;
  live: boolean;
  /** when the launch in flight in this process started, or null */
  inFlightSince(): string | null;
  /** resolves when no launch is in flight (tests) */
  idle(): Promise<void>;
  close(): Promise<void>;
}

type Obj = Record<string, unknown>;

/**
 * ClawPump said no before it sent anything, so no launch can be under way: the pinned server's own pre-checks (an image
 * is needed; a token already exists), its 402/403/429 messages, and an argument validation error. Anything else,
 * a 5xx above all, may have reached the launch endpoint. PURE.
 */
export function definiteRefusal(text: string): boolean {
  return /A token image is required|already has a launched token|\b(Payment required|Rate limited|Access denied):|MCP error -32602|Invalid arguments for tool|Input validation error/i.test(text);
}

function text(data: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], ...(isError ? { isError: true } : {}) };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function refuseHttp(res: http.ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...extra });
  res.end(JSON.stringify({ error: message }));
}

export async function startBridge(opts: BridgeOptions = {}): Promise<Bridge> {
  const live = opts.live === true;
  const log = opts.log ?? ((l: string) => console.log(`[launch-bridge] ${l}`));
  const secretsFile = opts.secretsFile ?? DEFAULT_SECRETS_FILE;
  const armFile = opts.armFile ?? DEFAULT_ARM_FILE;
  const auditFile = opts.auditFile ?? DEFAULT_AUDIT_FILE;
  const deadlineMs = opts.responseDeadlineMs ?? RESPONSE_DEADLINE_MS;
  const upstreamTimeoutMs = opts.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const statusTimeoutMs = opts.statusTimeoutMs ?? STATUS_TIMEOUT_MS;
  const precheckTimeoutMs = Math.min(statusTimeoutMs, opts.precheckStatusTimeoutMs ?? PRECHECK_STATUS_TIMEOUT_MS);
  const inflightFile = inflightFileFor(armFile);

  const secrets = readSecrets(secretsFile, true);
  const cfg: LaunchConfig = checkLaunchConfig({ imageUrl: secrets.imageUrl, twitter: secrets.twitter });
  const hide = [secrets.apiKey, secrets.bridgeToken];
  const redact = (s: string) => redactString(s, hide);

  const tested = opts.upstreamEntry !== undefined;
  const upstream = new Upstream({
    entry: tested ? opts.upstreamEntry! : pinnedEntry(opts.installDir ?? DEFAULT_INSTALL_DIR),
    apiKey: secrets.apiKey,
    allowed: BRIDGE_UPSTREAM_TOOLS,
    pinnedSha256: tested ? null : CLAWPUMP_INDEX_SHA256,
    expectServer: tested ? null : undefined,
    ...(opts.upstreamExtraEnv ? { extraEnv: opts.upstreamExtraEnv } : {}),
  });
  // refuse to start against anything but the pinned server
  await upstream.connect();

  const audit = (line: AuditLine) => {
    try {
      appendAudit(auditFile, { ...line, ...(line.detail ? { detail: redact(line.detail) } : {}) });
    } catch (err) {
      log(`audit write failed: ${redact((err as Error).message)}`);
    }
  };

  // one launch at a time, in this process; the arm's rename is the cross-process claim
  let inFlight: { since: string; done: Promise<void> } | null = null;
  let last: LaunchReport | null = null;
  /** set by close(): no status read (and so no child) after it */
  let closed = false;

  type StatusRead = { ok: true; status: Obj } | { ok: false; reason: string };
  const readStatusOnce = async (timeoutMs: number): Promise<StatusRead> => {
    try {
      const r = await upstream.call(UPSTREAM_STATUS_TOOL, { agent_id: CLAWPUMP_AGENT_ID }, timeoutMs);
      if (r.isError) return { ok: false, reason: redact(r.text).slice(0, 300) };
      const parsed = JSON.parse(r.text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "get_launch_status did not return an object" };
      return { ok: true, status: parsed as Obj };
    } catch (err) {
      return { ok: false, reason: redact((err as Error).message).slice(0, 300) };
    }
  };
  /** get_launch_status, the whole of it (a child reconnect included) bounded by timeoutMs; never after close(). */
  const readStatus = async (timeoutMs = statusTimeoutMs): Promise<StatusRead> => {
    if (closed || upstream.isClosed) return { ok: false, reason: "the bridge is shutting down" };
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<StatusRead>((r) => (timer = setTimeout(() => r({ ok: false, reason: `get_launch_status gave no answer within ${timeoutMs} ms` }), timeoutMs)));
    try {
      return await Promise.race([readStatusOnce(timeoutMs), late]);
    } finally {
      clearTimeout(timer);
    }
  };

  /** Settled for good: a mint, or ClawPump refused before sending anything. Only then does the marker go. */
  const markerOff = (why: string) => {
    if (clearInflight(inflightFile)) log(`in-flight marker removed: ${why}`);
  };
  const markerKept = `The bridge refuses any other launch until your architect checks the ClawPump dashboard and clears the in-flight marker.`;

  const mode = live ? "live" : "dry-run";

  /**
   * (e): after an error or an isError result, the status decides what is said.
   *   thrown      the call never got ClawPump's answer (the connection closed, a timeout): "unknown", marker kept
   *   answered    ClawPump answered isError, not a definite refusal: "error-no-mint" if no mint shows, marker kept
   *   definite    ClawPump refused before sending anything (definiteRefusal): "error-no-mint", marker removed
   */
  const afterError = async (detail: string, kind: "thrown" | "answered" | "definite"): Promise<LaunchReport> => {
    const st = await readStatus();
    const mint = st.ok ? mintOf(st.status) : null;
    if (mint) {
      markerOff(`the status shows mint ${mint}`);
      return { ok: true, outcome: "launched", mint, message: `launched: the launch call reported an error, but the status shows mint ${mint}.`, upstream: detail };
    }
    if (kind === "definite") {
      markerOff("ClawPump refused the launch before sending it");
      return {
        ok: false,
        outcome: "error-no-mint",
        mint: null,
        message: `ClawPump refused the launch before sending it, and no mint shows. The arm is used: nothing more happens unless your architect arms it again. Say nothing public about it.`,
        upstream: detail,
      };
    }
    if (kind === "thrown") {
      return { ok: false, outcome: "unknown", mint: null, message: `the launch call ended without ClawPump's answer, so the launch may still land. Treat it as pending: call token_launch_status and say nothing until it shows a mint. ${markerKept}`, upstream: detail };
    }
    if (!st.ok) return { ok: false, outcome: "unknown", mint: null, message: `the launch call returned an error and the status could not be read (${st.reason}). Treat it as pending: call token_launch_status before saying anything. ${markerKept}`, upstream: detail };
    return {
      ok: false,
      outcome: "error-no-mint",
      mint: null,
      message: `the launch call returned an error and the status shows no mint as of ${new Date().toISOString()}; a launch can take a while to show. The arm is used. ${markerKept} Say nothing public about it.`,
      upstream: detail,
    };
  };

  /** (d)'s result, whenever it lands. */
  const settle = async (p: Promise<{ isError: boolean; text: string }>): Promise<LaunchReport> => {
    let r: { isError: boolean; text: string };
    try {
      r = await p;
    } catch (err) {
      const detail = redact((err as Error).message).slice(0, 300);
      return afterError(detail, definiteRefusal(detail) ? "definite" : "thrown");
    }
    if (r.isError) {
      const detail = redact(r.text).slice(0, 300);
      return afterError(detail, definiteRefusal(r.text) ? "definite" : "answered");
    }
    const st = await readStatus();
    const mint = st.ok ? mintOf(st.status) : null;
    if (mint) {
      markerOff(`the status shows mint ${mint}`);
      return { ok: true, outcome: "launched", mint, message: `launched: mint ${mint}. token_launch_status shows it.` };
    }
    return { ok: false, outcome: "no-mint-after-success", mint: null, message: `the launch call returned success but the status shows no mint yet. Call token_launch_status; say nothing until it shows a mint. ${markerKept}` };
  };

  const refuse = (reason: string): LaunchReport => ({ ok: false, outcome: "refused", mint: null, message: `refused: ${reason}` });

  /** t0: when the request arrived. Everything, the status read and a reconnect included, answers by t0 + deadlineMs. */
  const launch = async (nonce: string, t0: number): Promise<LaunchReport> => {
    const deadline = t0 + deadlineMs;
    if (closed) return refuse("the bridge is shutting down");
    if (inFlight) return refuse(`a launch is already in flight since ${inFlight.since}; call token_launch_status`);
    // (0) an earlier launch call that never settled, in this process or one before a restart
    const marker = readInflight(inflightFile);
    if (marker) return refuse(`a launch may still be in flight since ${marker.since}: an earlier launch call never settled. Call token_launch_status and do not call token_launch again; your architect clears this only after checking the ClawPump dashboard`);
    // (a) the arm: present, private, this nonce, unexpired
    const arm = readArm(armFile);
    if (!arm.ok) return refuse(arm.reason);
    const armBad = armProblem(arm.arm, nonce);
    if (armBad) return refuse(armBad);

    let release!: () => void;
    const done = new Promise<void>((r) => (release = r));
    inFlight = { since: new Date().toISOString(), done };
    let handedOff = false;
    try {
      // (b) the stored state, read again right now, bounded so the answer still comes inside the deadline
      const st = await readStatus(Math.max(1, Math.min(precheckTimeoutMs, deadline - Date.now())));
      if (!st.ok) return refuse(`could not read the launch status in time (${st.reason}); nothing was sent and the arm is kept: try again`);
      if (Date.now() >= deadline) return refuse("the status read used up the time to answer; nothing was sent and the arm is kept: try again");
      const problems = specProblems(st.status, cfg);
      if (problems.length) return refuse(`the launch status does not match the pinned spec: ${problems.join("; ")}`);
      // (c) the durable marker, then the arm claimed; both before anything is sent
      if (live) {
        try {
          writeInflight(inflightFile, mode);
        } catch (err) {
          return refuse(`the in-flight marker could not be written (${redact((err as Error).message).slice(0, 160)}); nothing was sent and the arm is kept`);
        }
      }
      const used = consumeArm(armFile);
      if (!used.ok) {
        if (live) clearInflight(inflightFile);
        return refuse(used.reason);
      }
      const usedBad = armProblem(used.arm, nonce);
      if (usedBad) {
        if (live) clearInflight(inflightFile);
        return refuse(`the arm changed while it was checked (${usedBad}); it is used now: re-arm`);
      }

      const args = launchArguments(cfg);
      if (!live) {
        return { ok: true, outcome: "dry-run", mint: null, message: `dry run: every check passed and the arm is used; would call ${UPSTREAM_LAUNCH_TOOL} once with these arguments`, wouldCall: UPSTREAM_LAUNCH_TOOL, arguments: args };
      }

      // (d) the one upstream call
      audit({ tool: BRIDGE_LAUNCH_TOOL, outcome: "calling", mint: null, mode, args });
      const outcome = settle(upstream.call(UPSTREAM_LAUNCH_TOOL, args, upstreamTimeoutMs));
      const PENDING = Symbol("pending");
      let timer: NodeJS.Timeout | undefined;
      const raced = await Promise.race([outcome, new Promise<typeof PENDING>((r) => (timer = setTimeout(() => r(PENDING), Math.max(0, deadline - Date.now()))))]);
      clearTimeout(timer);
      if (raced === PENDING) {
        handedOff = true;
        const pending: LaunchReport = { ok: true, outcome: "pending", mint: null, message: PENDING_MESSAGE };
        last = pending;
        void outcome
          .then((rep) => {
            last = rep;
            audit({ tool: BRIDGE_LAUNCH_TOOL, outcome: `settled after pending: ${rep.outcome}`, mint: rep.mint, mode, detail: typeof rep.upstream === "string" ? rep.upstream : undefined });
            log(`launch settled after the gateway was answered: ${rep.outcome}${rep.mint ? ` mint ${rep.mint}` : ""}`);
          })
          .finally(() => {
            inFlight = null;
            release();
          });
        return pending;
      }
      return raced;
    } finally {
      if (!handedOff) {
        inFlight = null;
        release();
      }
    }
  };

  const buildServer = (): McpServer => {
    const server = new McpServer({ name: "mrbands-launch-bridge", version: "1.0.0" }, { instructions: BRIDGE_INSTRUCTIONS });
    server.registerTool(
      BRIDGE_STATUS_TOOL,
      {
        title: "His token's launch status",
        description:
          "Read-only. Your ClawPump agent's token launch status: the stored launch metadata, the funding, and token_mint once launched; whether the stored metadata matches the spec fixed in code; whether the launch is armed (never the nonce); and a launch in flight. The only source of truth for whether the token exists.",
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async () => {
        const st = await readStatus();
        const arm = readArm(armFile);
        const armed = arm.ok && Date.parse(arm.arm.expiresAt) > Date.now();
        const marker = readInflight(inflightFile);
        const bridge = { mode, armed, ...(armed && arm.ok ? { armExpiresAt: arm.arm.expiresAt } : {}), inFlightSince: inFlight?.since ?? marker?.since ?? null, unsettledLaunchMarker: marker ? { since: marker.since } : null, lastLaunch: last };
        if (!st.ok) {
          audit({ tool: BRIDGE_STATUS_TOOL, outcome: "status unreadable", mint: null, mode, detail: st.reason });
          return text({ ok: false, error: `could not read the launch status: ${st.reason}`, bridge }, true);
        }
        const mint = mintOf(st.status);
        audit({ tool: BRIDGE_STATUS_TOOL, outcome: "read", mint, mode });
        return text({ ok: true, token_mint: mint, specMatches: specProblems(st.status, cfg).length === 0, specProblems: specProblems(st.status, cfg), status: redactDeep(st.status, hide), bridge });
      },
    );
    server.registerTool(
      BRIDGE_LAUNCH_TOOL,
      {
        title: "Launch his token, once",
        description:
          "Launches your own token, $BANDS, on ClawPump, once, with the spec fixed in code (name Mr Bands, symbol BANDS, the fixed description, first buy 0); you choose nothing but the moment. Irreversible. Works only while your architect has armed it, with the nonce from the armed prompt. It may answer \"submitted, outcome pending\": then call token_launch_status, never token_launch again. Never announce anything until token_launch_status shows the mint.",
        inputSchema: { confirm: z.literal(true), nonce: z.string().min(16).max(128) },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async ({ nonce }) => {
        const t0 = Date.now();
        let rep: LaunchReport;
        try {
          rep = await launch(nonce, t0);
        } catch (err) {
          rep = { ok: false, outcome: "unknown", mint: null, message: `the bridge hit an error (${redact((err as Error).message).slice(0, 200)}). Call token_launch_status before saying anything.` };
        }
        // a refusal changes nothing, so the last real outcome stays on show; a pending one was recorded in launch()
        if (rep.outcome !== "refused" && rep.outcome !== "pending") last = rep;
        audit({ tool: BRIDGE_LAUNCH_TOOL, outcome: rep.outcome, mint: rep.mint, mode, detail: rep.outcome === "refused" || typeof rep.upstream === "string" ? String(rep.upstream ?? rep.message) : undefined });
        log(`${BRIDGE_LAUNCH_TOOL}: ${rep.outcome}${rep.mint ? ` mint ${rep.mint}` : ""}`);
        return text(redactDeep(rep, hide), rep.outcome === "refused");
      },
    );
    return server;
  };

  const expectedHost = () => `${BRIDGE_HOST}:${(httpServer.address() as AddressInfo).port}`;

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== expectedHost()) return refuseHttp(res, 403, "wrong host");
      if (req.headers.origin !== undefined) return refuseHttp(res, 403, "browser requests are refused");
      if (!bearerMatches(req.headers.authorization, secrets.bridgeToken)) return refuseHttp(res, 401, "unauthorized");
      if ((req.url ?? "").split("?")[0] !== "/mcp") return refuseHttp(res, 404, "not found");
      if (req.method !== "POST") return refuseHttp(res, 405, "POST only (stateless)", { allow: "POST" });
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return refuseHttp(res, 400, "the body must be one JSON-RPC message");
      }
      if (Array.isArray(body)) return refuseHttp(res, 400, "batches are not accepted");
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log(`request error: ${redact((err as Error).message).slice(0, 200)}`);
      if (!res.headersSent) refuseHttp(res, 500, "internal error");
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port ?? BRIDGE_PORT, BRIDGE_HOST, () => resolve());
  });
  const port = (httpServer.address() as AddressInfo).port;
  log(`listening on ${BRIDGE_HOST}:${port} (${mode}); tools ${BRIDGE_STATUS_TOOL}, ${BRIDGE_LAUNCH_TOOL}; upstream ${[...BRIDGE_UPSTREAM_TOOLS].join(", ")} only`);

  return {
    url: `http://${BRIDGE_HOST}:${port}/mcp`,
    port,
    live,
    inFlightSince: () => inFlight?.since ?? null,
    idle: async () => {
      while (inFlight) await inFlight.done;
    },
    close: async () => {
      if (inFlight) log(`closing with a launch in flight since ${inFlight.since}: its outcome will read "unknown" and the in-flight marker stays`);
      closed = true;
      await new Promise<void>((r) => {
        httpServer.close(() => r());
        httpServer.closeAllConnections();
      });
      await upstream.close();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export function parseBridgeArgs(argv: string[]): BridgeOptions {
  const o: BridgeOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--live") o.live = true;
    else if (a === "--secrets-file") o.secretsFile = val();
    else if (a === "--arm-file") o.armFile = val();
    else if (a === "--audit-file") o.auditFile = val();
    else if (a === "--install-dir") o.installDir = val();
    else throw new Error(`unknown flag ${a}: --live, --secrets-file, --arm-file, --audit-file, --install-dir`);
  }
  return o;
}

async function main(): Promise<void> {
  const opts = parseBridgeArgs(process.argv.slice(2));
  const bridge = await startBridge(opts);
  console.log(`launch bridge up: ${bridge.url} · ${bridge.live ? "LIVE: token_launch calls ClawPump" : "DRY RUN: token_launch checks everything and calls nothing (--live for the real one)"}`);
  let asked = false;
  const stop = async () => {
    const since = bridge.inFlightSince();
    if (since && !asked) {
      asked = true;
      console.error(
        `\n!! A LAUNCH IS IN FLIGHT since ${since}. NOT stopping: stopping now would cut ClawPump off mid-launch.\n` +
          `!! The bridge exits by itself once the launch settles. A second Ctrl-C forces it; the in-flight marker then stays and\n` +
          `!! every launch is refused until you check the ClawPump dashboard and run: npm run launch:arm -- --clear-inflight\n`,
      );
      await bridge.idle();
      await bridge.close();
      process.exit(0);
    }
    if (since) console.error(`!! forced stop with a launch in flight since ${since}: the in-flight marker stays. Check the dashboard before anything else.`);
    await bridge.close();
    // let the cut-off launch write its "unknown" line to the audit
    await Promise.race([bridge.idle(), new Promise((r) => setTimeout(r, 2000))]);
    process.exit(since ? 1 : 0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`launch bridge not started: ${(err as Error).message}`);
    process.exit(1);
  });
}
