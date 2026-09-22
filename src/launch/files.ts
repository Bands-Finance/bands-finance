/**
 * The launch bridge's own files, all under ~/.mrbands and all mode 600 (docs/launch.md):
 *
 *   clawpump.env        CLAWPUMP_API_KEY (the cpk_ key) and CLAWPUMP_BRIDGE_TOKEN (the gateway's bearer), plus the
 *                       optional LAUNCH_IMAGE_URL and LAUNCH_TWITTER. Read by the bridge only. NEVER the repo's .env:
 *                       every desk process and the platform server load that one into process.env.
 *   bands-launch.arm    {nonce, expiresAt}, written by `npm run launch:arm`. The launch needs it, its nonce, and an
 *                       unexpired time; it is renamed to bands-launch.arm.used before the upstream call (single use).
 *   bands-launch.inflight  {since, pid, mode}, written by the bridge just before it sends the launch call and removed
 *                       only when it sees a mint or a definite ClawPump refusal. While it exists the bridge refuses
 *                       every launch, across restarts; only `npm run launch:arm -- --clear-inflight`, after a look at the
 *                       ClawPump dashboard, removes it.
 *   launch-audit.jsonl  one line per bridge tool call: tool, time, outcome, mint. Never a header, a key or a token.
 *
 * Nothing here reads process.env for a secret, and nothing here prints one.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MRBANDS_DIR = path.join(os.homedir(), ".mrbands");
export const DEFAULT_SECRETS_FILE = path.join(MRBANDS_DIR, "clawpump.env");
export const DEFAULT_ARM_FILE = path.join(MRBANDS_DIR, "bands-launch.arm");
export const DEFAULT_AUDIT_FILE = path.join(MRBANDS_DIR, "launch-audit.jsonl");
/** Where `npm ci` puts the pinned ClawPump server (ops/clawpump-agents holds its package.json and lockfile). */
export const DEFAULT_INSTALL_DIR = path.join(MRBANDS_DIR, "clawpump-agents");
/** The longest an arm may last. */
export const MAX_ARM_MINUTES = 60;

const modeOf = (st: fs.Stats) => (st.mode & 0o777).toString(8).padStart(3, "0");

/**
 * Throws unless `file` is a regular file (not a symlink) owned by this user with no group or other bits, in a
 * directory nobody else can write to. The message names the fix and never the contents.
 */
export function assertPrivateFile(file: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    throw new Error(`${file} does not exist`);
  }
  if (st.isSymbolicLink()) throw new Error(`${file} is a symlink: use the file itself`);
  if (!st.isFile()) throw new Error(`${file} is not a regular file`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${file} is mode ${modeOf(st)}: it must be 600 (chmod 600 ${file})`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${file} is not owned by this user`);
  const dir = fs.statSync(path.dirname(file));
  if ((dir.mode & 0o022) !== 0) throw new Error(`${path.dirname(file)} is writable by others (mode ${modeOf(dir)}): chmod 700 it`);
}

/** KEY=VALUE lines; blank lines and # comments skipped; an optional `export ` and one pair of matching quotes removed. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export interface LaunchSecrets {
  apiKey: string;
  /** "" when not asked for */
  bridgeToken: string;
  imageUrl?: string;
  twitter?: string;
}

/**
 * The secrets file, checked (mode 600, owned, not a symlink) and parsed. `needBridgeToken` false is for the read-only
 * check, which never serves the gateway. Throws with the key NAMES only.
 */
export function readSecrets(file: string, needBridgeToken = true): LaunchSecrets {
  assertPrivateFile(file);
  const env = parseEnvFile(fs.readFileSync(file, "utf8"));
  const apiKey = env.CLAWPUMP_API_KEY ?? "";
  if (!apiKey) throw new Error(`${file} has no CLAWPUMP_API_KEY`);
  if (!/^cpk_[A-Za-z0-9_-]{8,}$/.test(apiKey)) throw new Error(`${file}: CLAWPUMP_API_KEY is not a cpk_ key (length ${apiKey.length})`);
  const bridgeToken = env.CLAWPUMP_BRIDGE_TOKEN ?? "";
  if (needBridgeToken) {
    if (!bridgeToken) throw new Error(`${file} has no CLAWPUMP_BRIDGE_TOKEN (openssl rand -hex 32)`);
    if (bridgeToken.length < 32 || !/^[A-Za-z0-9_-]+$/.test(bridgeToken)) throw new Error(`${file}: CLAWPUMP_BRIDGE_TOKEN must be at least 32 characters of [A-Za-z0-9_-] (openssl rand -hex 32); it is ${bridgeToken.length}`);
    if (bridgeToken === apiKey) throw new Error(`${file}: CLAWPUMP_BRIDGE_TOKEN is the API key; generate its own`);
  }
  return {
    apiKey,
    bridgeToken: needBridgeToken ? bridgeToken : "",
    ...(env.LAUNCH_IMAGE_URL ? { imageUrl: env.LAUNCH_IMAGE_URL } : {}),
    ...(env.LAUNCH_TWITTER ? { twitter: env.LAUNCH_TWITTER } : {}),
  };
}

/** Constant-time string equality: both sides hashed first, so neither the length nor a prefix leaks. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

/** `Authorization: Bearer <token>` against the expected token, in constant time. An empty expected token matches nobody. */
export function bearerMatches(authorization: string | string[] | undefined, token: string): boolean {
  if (!token || typeof authorization !== "string") return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization.trim());
  return constantTimeEqual(m ? m[1] : "", token) && !!m;
}

// ---------------------------------------------------------------------------------------------
// the arm
// ---------------------------------------------------------------------------------------------

export interface Arm {
  nonce: string;
  expiresAt: string;
  createdAt?: string;
}

/** Writes a fresh arm (mode 600, atomically, replacing any earlier one) and returns it. The caller prints the nonce once. */
export function writeArm(file: string, minutes: number, now = Date.now()): Arm {
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_ARM_MINUTES) throw new Error(`the arm lasts 1 to ${MAX_ARM_MINUTES} minutes, not ${minutes}`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const arm: Arm = { nonce: crypto.randomBytes(24).toString("base64url"), expiresAt: new Date(now + minutes * 60_000).toISOString(), createdAt: new Date(now).toISOString() };
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(arm) + "\n", { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
  return arm;
}

export type ArmRead = { ok: true; arm: Arm } | { ok: false; reason: string };

/** The arm, checked for mode and shape (not for the nonce or the time: see armProblem). */
export function readArm(file: string): ArmRead {
  if (!fs.existsSync(file)) return { ok: false, reason: "the launch is not armed (no arm file)" };
  try {
    assertPrivateFile(file);
  } catch (err) {
    return { ok: false, reason: `the arm file is refused: ${(err as Error).message}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ok: false, reason: "the arm file is not JSON" };
  }
  const a = raw as Partial<Arm> | null;
  if (!a || typeof a.nonce !== "string" || a.nonce.length < 16 || typeof a.expiresAt !== "string" || !Number.isFinite(Date.parse(a.expiresAt))) {
    return { ok: false, reason: "the arm file is malformed: it needs {nonce, expiresAt}" };
  }
  return { ok: true, arm: { nonce: a.nonce, expiresAt: a.expiresAt, ...(typeof a.createdAt === "string" ? { createdAt: a.createdAt } : {}) } };
}

/** Why this arm does not open the launch for this nonce, or null when it does. The nonce is compared in constant time. */
export function armProblem(arm: Arm, nonce: string, now = Date.now()): string | null {
  if (!constantTimeEqual(arm.nonce, nonce)) return "the nonce does not match the armed one";
  if (Date.parse(arm.expiresAt) <= now) return `the arm expired at ${arm.expiresAt}`;
  return null;
}

/**
 * Claims the arm: renames it to <file>.used (atomic; a second caller finds nothing to rename) and returns what was
 * claimed, read back from the .used file so what is checked is what was consumed.
 */
export function consumeArm(file: string): ArmRead & { usedPath?: string } {
  const used = `${file}.used`;
  try {
    fs.renameSync(file, used);
  } catch {
    return { ok: false, reason: "the arm was already used or removed" };
  }
  const r = readArm(used);
  return r.ok ? { ...r, usedPath: used } : r;
}

// ---------------------------------------------------------------------------------------------
// the in-flight marker
// ---------------------------------------------------------------------------------------------

/** The marker that sits next to an arm file: bands-launch.arm -> bands-launch.inflight. */
export function inflightFileFor(armFile: string): string {
  return armFile.endsWith(".arm") ? `${armFile.slice(0, -".arm".length)}.inflight` : `${armFile}.inflight`;
}
export const DEFAULT_INFLIGHT_FILE = inflightFileFor(DEFAULT_ARM_FILE);

export interface Inflight {
  since: string;
  pid?: number;
  mode?: string;
}

/**
 * Writes the marker (mode 600, exclusive: it fails when one is already there). Throws with the reason; the caller
 * then sends nothing.
 */
export function writeInflight(file: string, mode: string, now = Date.now()): Inflight {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const m: Inflight = { since: new Date(now).toISOString(), pid: process.pid, mode };
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(m) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return m;
}

/** The marker, or null when there is none. Anything unreadable there still counts as a launch in flight. */
export function readInflight(file: string): Inflight | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { since: "unknown (the marker is unreadable)" };
  }
  try {
    const m = JSON.parse(text) as Partial<Inflight>;
    return { since: typeof m.since === "string" ? m.since : "unknown", ...(typeof m.pid === "number" ? { pid: m.pid } : {}), ...(typeof m.mode === "string" ? { mode: m.mode } : {}) };
  } catch {
    return { since: "unknown (the marker is malformed)" };
  }
}

/** Removes the marker, if any. True when there was one. */
export function clearInflight(file: string): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Removes the arm, if any. True when there was one. */
export function disarm(file: string): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// the audit
// ---------------------------------------------------------------------------------------------

export interface AuditLine {
  tool: string;
  outcome: string;
  mint: string | null;
  mode?: "dry-run" | "live";
  detail?: string;
  /** the upstream call's arguments: the pinned spec, public by design */
  args?: Record<string, unknown>;
}

/** Appends one line (mode 600 on creation). The caller has redacted `detail`; nothing else here can hold a secret. */
export function appendAudit(file: string, line: AuditLine, now = Date.now()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const row = { at: new Date(now).toISOString(), tool: line.tool, outcome: line.outcome, mint: line.mint, ...(line.mode ? { mode: line.mode } : {}), ...(line.detail ? { detail: line.detail.slice(0, 500) } : {}), ...(line.args ? { args: line.args } : {}) };
  fs.appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
}
