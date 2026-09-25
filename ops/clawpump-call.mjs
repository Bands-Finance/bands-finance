#!/usr/bin/env node
// One deliberate call to one ClawPump MCP tool through the pinned server (ops/clawpump-mcp.sh), by hand:
//   node ops/clawpump-call.mjs <tool> '<json arguments>'
// Used for the few write actions Zach orders one at a time (a whitelist entry, a treasury transfer he has approved
// with its exact amount). Claude Code's own ClawPump tools stay denied for writes (docs/launch.md step 5); this
// script is the audited door instead: every call and reply is appended to ~/.mrbands/clawpump-audit.jsonl.
// The key never reaches this process's arguments or output (the wrapper reads it from its own files).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [tool, rawArgs] = process.argv.slice(2);
if (!tool) { console.error("usage: node ops/clawpump-call.mjs <tool> '<json arguments>'"); process.exit(2); }
let args = {};
try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { console.error("the arguments are not json"); process.exit(2); }
const audit = path.join(os.homedir(), ".mrbands", "clawpump-audit.jsonl");
fs.mkdirSync(path.dirname(audit), { recursive: true, mode: 0o700 });

const here = path.dirname(new URL(import.meta.url).pathname);
const p = spawn(path.join(here, "clawpump-mcp.sh"), [], { stdio: ["pipe", "pipe", "inherit"] });
let buf = ""; const msgs = [];
p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { msgs.push(JSON.parse(line)); } catch { /* not json */ } } });
const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");
const waitFor = (id, ms) => new Promise((resolve, reject) => { const t0 = Date.now(); const tick = () => { const m = msgs.find((x) => x.id === id); if (m) return resolve(m); if (Date.now() - t0 > ms) return reject(new Error(`no reply to ${id} in ${ms} ms`)); setTimeout(tick, 100); }; tick(); });

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "clawpump-call", version: "1" } } });
await waitFor(1, 20000);
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
let reply;
try { reply = await waitFor(2, 120000); } catch (e) { console.error(e.message); p.kill(); process.exit(1); }
const content = reply.result?.content ?? [];
const text = content.map((c) => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
const row = { at: new Date().toISOString(), tool, args, isError: !!reply.result?.isError, error: reply.error ?? null, reply: text.slice(0, 4000) };
fs.appendFileSync(audit, JSON.stringify(row) + "\n", { mode: 0o600 });
console.log(reply.error ? `error: ${JSON.stringify(reply.error)}` : text);
p.kill();
process.exit(reply.error || reply.result?.isError ? 1 : 0);
