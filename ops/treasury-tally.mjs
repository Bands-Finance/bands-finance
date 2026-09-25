#!/usr/bin/env node
// The token's rewards so far: every SOL inflow into the treasury agent's wallet since the launch, read from the chain.
//   node ops/treasury-tally.mjs [--since 2026-09-25T09:50:00Z] [--wallet DwT8...] [--limit 200]
// Inflows are ClawPump's creator-fee payouts (and any funding Zach sends, which is listed but marked when it is large
// and round); outflows are listed too so the wallet's balance reconciles. Uses RPC_URL from .env (Helius), falling
// back to the public endpoint when it rate-limits. Prints a table and the totals; nothing is written or sent.
import fs from "node:fs";
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => { if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]); return acc; }, []));
const WALLET = args.wallet ?? "DwT8xTNchU67T4CJbWE89pM9qNZdjTLhTocheoSUQ2j6";
const SINCE = Date.parse(args.since ?? "2026-09-25T09:50:00Z") / 1000;
const LIMIT = Number(args.limit ?? 200);
const envRpc = (fs.existsSync(".env") ? fs.readFileSync(".env", "utf8").split("\n").find((l) => /^(RPC_URL|SOLANA_RPC_URL|HELIUS_RPC_URL)=/.test(l)) : null)?.split("=").slice(1).join("=").replace(/^"(.*)"$/, "$1");
const RPCS = [envRpc, "https://api.mainnet-beta.solana.com"].filter(Boolean);
async function rpc(method, params) {
  let last;
  for (const url of RPCS) {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (res.status === 429) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      const j = await res.json(); if (j.error) { last = j.error; break; } return j.result;
    }
  }
  throw new Error(`rpc failed: ${JSON.stringify(last)}`);
}
const sigs = await rpc("getSignaturesForAddress", [WALLET, { limit: LIMIT }]);
const rows = [];
for (const s of sigs.filter((x) => (x.blockTime ?? 0) >= SINCE).reverse()) {
  const tx = await rpc("getTransaction", [s.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]);
  if (!tx) continue;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
  const i = keys.indexOf(WALLET);
  const delta = i >= 0 ? (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9 : 0;
  const tokenMoves = (tx.meta.postTokenBalances ?? []).filter((b) => b.owner === WALLET).length + (tx.meta.preTokenBalances ?? []).filter((b) => b.owner === WALLET).length;
  const logs = (tx.meta.logMessages ?? []).join(" ");
  const kind = /InitializeVirtualPool/.test(logs) ? "launch" : delta > 0 ? (delta >= 1 && Math.abs(delta - Math.round(delta * 100) / 100) < 1e-6 && delta >= 2 ? "funding?" : "fee payout") : tokenMoves ? "token move" : "transfer out";
  rows.push({ at: new Date(s.blockTime * 1000).toISOString().slice(0, 16).replace("T", " "), delta, kind, sig: s.signature.slice(0, 12) });
  await new Promise((r) => setTimeout(r, 250));
}
let fees = 0, funding = 0, out = 0;
for (const r of rows) { if (r.kind === "fee payout") fees += r.delta; else if (r.kind === "funding?") funding += r.delta; else if (r.delta < 0) out += -r.delta; console.log(`${r.at}Z  ${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(4)} SOL  ${r.kind.padEnd(12)} ${r.sig}…`); }
const bal = (await rpc("getBalance", [WALLET])).value / 1e9;
console.log(`\nfee payouts: ${fees.toFixed(4)} SOL in ${rows.filter((r) => r.kind === "fee payout").length} payments | funding in: ${funding.toFixed(4)} | out (launch, transfers): ${out.toFixed(4)} | balance now: ${bal.toFixed(4)} SOL`);
