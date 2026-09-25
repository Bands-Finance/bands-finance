#!/usr/bin/env node
// Sweep the treasury agent's SOL above a gas margin to the desk's trading wallet, through the audited ClawPump door.
//   node ops/treasury-sweep.mjs [--keep 0.05] [--min 0.02] [--dry]
// Runs only when invoked (by hand, or by a launchd job Zach has asked for). The destination is fixed in code to the
// one whitelisted address; the amount is what is above --keep, and nothing moves under --min. Every run appends a
// line to ~/.mrbands/treasury-sweep.jsonl; the transfer itself is logged by ops/clawpump-call.mjs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => { if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]); return acc; }, []));
const AGENT = "c77a9f8e-d1da-45e9-adb0-e5e668dad04d";
const FROM = "DwT8xTNchU67T4CJbWE89pM9qNZdjTLhTocheoSUQ2j6";
const TO = "9q3VKDrHBusoxsWEBwkzNmRe51AV5kGEMA2Yic5EPkVW";
const KEEP = Number(args.keep ?? 0.05);
const MIN = Number(args.min ?? 0.02);
const log = path.join(os.homedir(), ".mrbands", "treasury-sweep.jsonl");
fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
const note = (row) => fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n", { mode: 0o600 });
const res = await fetch("https://api.mainnet-beta.solana.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [FROM] }) });
const balance = (await res.json()).result.value / 1e9;
const amount = Math.floor((balance - KEEP) * 1e4) / 1e4;
if (amount < MIN) { console.log(`treasury ${balance.toFixed(4)} SOL: nothing above the ${KEEP} SOL margin worth moving (min ${MIN})`); note({ balance, moved: 0, reason: "under min" }); process.exit(0); }
console.log(`treasury ${balance.toFixed(4)} SOL -> move ${amount} SOL to ${TO.slice(0, 8)}…, keep ${KEEP}`);
if (args.dry === "true") { note({ balance, moved: 0, reason: "dry run", amount }); console.log("dry run: nothing sent"); process.exit(0); }
const here = path.dirname(new URL(import.meta.url).pathname);
const out = execFileSync("node", [path.join(here, "clawpump-call.mjs"), "wallet_transfer", JSON.stringify({ agent_id: AGENT, to: TO, amount, token: "SOL", confirm_transfer: true })], { encoding: "utf8" });
const m = /"txHash":\s*"([^"]+)"/.exec(out);
note({ balance, moved: amount, tx: m?.[1] ?? null, ok: !!m });
console.log(m ? `sent ${amount} SOL, tx ${m[1]}` : `no tx hash in the reply:\n${out.slice(0, 500)}`);
process.exit(m ? 0 : 1);
