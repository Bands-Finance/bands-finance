/**
 * WITHDRAW EVERYTHING to one address. Zach, 2026-09-18: "close all positions and send sol to that wallet".
 *
 *   1. every position the wallet holds, on every venue: closed through the desk's own executor, with
 *      liquidate, so the token it hands back is sold into SOL (no impact cap: a withdrawal sells it all)
 *   2. every token the wallet still holds: sold to SOL through Jupiter
 *   3. every token account left empty: closed, its rent back to the wallet (wrapped SOL unwraps)
 *   4. the whole SOL balance, less the network fee, to the destination
 *
 * Simulates unless DRY_RUN=false AND --send. The desk must be stopped first (it holds the engine lock).
 *   set -a && . ./ops/live.env && set +a && DRY_RUN=true  npx tsx src/scripts/withdraw.ts
 *   set -a && . ./ops/live.env && set +a && DRY_RUN=false npx tsx src/scripts/withdraw.ts --send
 */
import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { createCloseAccountInstruction, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { execute } from "../executor";
import { readLock, pidAlive } from "../engine/watchdog";
import { fromRawUnits, jupiter } from "../tools/jupiter";
import { getSolPriceUsd, setSolPriceUsd, SOL_MINT } from "../tools/dlmm";
import { Wallet } from "../tools/wallet";
import { loadVenuePool, poolsWithPositions } from "../venues";

const DEST = "Agg4bixWVhuGHwATMeA47Dvju3dUXmiCQZE7Kn47ATnT";
const SEND = process.argv.includes("--send");

const fmt = (n: number, d = 6) => Number(n.toFixed(d)).toString();

async function main(): Promise<void> {
  // ---- the destination, checked before anything else happens
  const dest = new PublicKey(DEST);
  if (dest.toBase58() !== DEST) throw new Error(`destination does not round-trip: ${dest.toBase58()} vs ${DEST}`);
  if (!PublicKey.isOnCurve(dest.toBytes())) throw new Error(`destination ${DEST} is not a wallet address (off the ed25519 curve): refusing`);

  const live = SEND && !config.dryRun;
  if (SEND && config.dryRun) throw new Error("--send given but DRY_RUN is not false: refusing to half-send");
  console.log(`WITHDRAW ${live ? "LIVE: transactions WILL be broadcast" : "SIMULATION: nothing will be sent"}`);
  console.log(`destination ${DEST} (valid wallet address)`);

  // ---- the desk must not be running: it would fight the closes and could re-lay a band with the SOL
  const lock = readLock();
  if (lock && pidAlive(lock.pid)) throw new Error(`the desk is still running (pid ${lock.pid}): stop it first`);

  const connection = new Connection(config.rpcUrl, "confirmed");
  const wallet = Wallet.fromConfig(connection);
  if (wallet.ephemeral) throw new Error("no wallet key loaded");
  console.log(`source      ${wallet.publicKey.toBase58()}`);
  try {
    const screen = JSON.parse(fs.readFileSync(path.resolve(config.dataDir, "screen.json"), "utf8"));
    if (typeof screen?.solPriceUsd === "number") setSolPriceUsd(screen.solPriceUsd);
  } catch {
    /* SOL pools need no price */
  }
  const startSol = await wallet.solBalance();
  console.log(`wallet      ${fmt(startSol, 4)} SOL before`);

  // ---- 1. every position, closed and liquidated through the desk's executor
  const pools = await poolsWithPositions(connection, wallet.publicKey, (s) => console.log(`  ${s}`));
  console.log(`positions   in ${pools.length} pool(s)`);
  for (const { address, venue: hint } of pools) {
    const { venue, pool } = await loadVenuePool(connection, address, hint);
    const snapshot = await venue.snapshot(pool, 10, { solPriceUsd: getSolPriceUsd() });
    const { raw, positions } = await venue.positions(pool, wallet.publicKey, snapshot);
    for (const p of positions) {
      const token = (await wallet.tokenBalance(new PublicKey(snapshot.baseToken.mint))).ui;
      console.log(`  ${snapshot.label} ${p.address}: ${fmt(p.valueInSol, 4)} SOL (${fmt(p.solInPosition, 4)} SOL side, in range ${p.inRange})`);
      const decision = { action: "CLOSE_POSITION" as const, open: null, positionAddress: p.address, liquidate: true, reasoning: `Withdrawal to ${DEST}: every band closes and its token is sold.`, confidence: 1, headline: "Withdrawing the book." };
      const res = await execute(
        { proposal: decision, decision, allowed: true, violations: [], overrides: [], passed: [], emergency: true },
        { venue, pool, wallet, rawPositions: raw, snapshot, positions, walletToken: token, sweepWalletToken: { minQuote: 0 } },
      );
      for (const t of res.txs) console.log(`    ${t.label}: ${t.signature ?? t.skipped ?? (t.ok ? "simulated ok" : `FAILED ${t.error}`)}`);
      for (const n of res.notes) console.log(`    note: ${n}`);
      // the CLOSE is what must land; a sale that fails after it leaves tokens the sweep below sells anyway
      if (!res.closed) throw new Error(`closing ${p.address} did not go through: stopping before any SOL moves`);
      if (!res.ok) console.log(`    the close landed; the sale did not${live ? "" : " (expected in a simulation: the close never really landed, so the token is not in the wallet yet)"}: the sweep below sells what is left`);
    }
  }

  // ---- 2 + 3. every token left: sold if it has any, its account closed either way
  const accounts = [
    ...(await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID })).value.map((a) => ({ ...a, program: TOKEN_PROGRAM_ID })),
    ...(await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_2022_PROGRAM_ID })).value.map((a) => ({ ...a, program: TOKEN_2022_PROGRAM_ID })),
  ];
  console.log(`token accts ${accounts.length}`);
  const client = jupiter();
  for (const a of accounts) {
    const info = (a.account.data as { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number; uiAmount: number | null } } } }).parsed.info;
    const raw = BigInt(info.tokenAmount.amount);
    if (raw > 0n && info.mint !== SOL_MINT) {
      try {
        const jq = await client.quote({ inputMint: info.mint, outputMint: SOL_MINT, amount: raw });
        const out = fromRawUnits(jq.outAmount, 9);
        if (out < 0.0005) {
          console.log(`  ${info.mint.slice(0, 6)}: ${info.tokenAmount.uiAmount} worth ~${fmt(out)} SOL, not worth a swap: left, account kept`);
          continue;
        }
        const built = await client.buildSwap(jq, wallet.publicKey);
        const sig = live ? await wallet.signAndSend(built.tx) : null;
        if (!live) {
          const sim = await wallet.simulate(built.tx, []);
          console.log(`  ${info.mint.slice(0, 6)}: sell ${info.tokenAmount.uiAmount} -> ~${fmt(out)} SOL via ${jq.routeLabels.join(" > ")} (impact ${jq.priceImpactPct}%): simulated ${sim.ok ? "ok" : `FAILED ${JSON.stringify(sim.err)}`}`);
          continue;
        }
        console.log(`  ${info.mint.slice(0, 6)}: sold ${info.tokenAmount.uiAmount} -> ~${fmt(out)} SOL: ${sig}`);
      } catch (err) {
        console.log(`  ${info.mint.slice(0, 6)}: could not sell (${(err as Error).message.slice(0, 120)}): left, account kept`);
        continue;
      }
    }
    // the account is empty now (or was wrapped SOL, which closes back into SOL): close it for its rent
    const tx = new Transaction().add(createCloseAccountInstruction(a.pubkey, wallet.publicKey, wallet.publicKey, [], a.program));
    if (live) {
      try {
        const sig = await wallet.signAndSend(tx);
        console.log(`  closed ${a.pubkey.toBase58().slice(0, 6)} (${info.mint.slice(0, 6)}): ${sig}`);
      } catch (err) {
        console.log(`  could not close ${a.pubkey.toBase58().slice(0, 6)}: ${(err as Error).message.slice(0, 120)}`);
      }
    } else {
      console.log(`  would close ${a.pubkey.toBase58().slice(0, 6)} (${info.mint.slice(0, 6)}, ${raw > 0n ? "after the sale" : "empty"}) for its rent`);
    }
  }

  // ---- 4. everything left, less the fee, to the destination
  const lamports = await connection.getBalance(wallet.publicKey, "confirmed");
  const probe = new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: dest, lamports: 1 }));
  probe.feePayer = wallet.publicKey;
  probe.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const fee = (await connection.getFeeForMessage(probe.compileMessage(), "confirmed")).value ?? 5000;
  const sendLamports = lamports - fee;
  if (sendLamports <= 0) throw new Error(`nothing to send: ${lamports} lamports against a ${fee} fee`);
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: dest, lamports: sendLamports }));
  console.log(`transfer    ${fmt(sendLamports / 1e9, 9)} SOL to ${DEST} (fee ${fee} lamports)`);
  if (live) {
    const sig = await wallet.signAndSend(tx);
    console.log(`SENT        ${sig}`);
    console.log(`            https://solscan.io/tx/${sig}`);
    const after = await wallet.solBalance();
    const destBal = (await connection.getBalance(dest, "confirmed")) / 1e9;
    console.log(`wallet      ${fmt(after, 9)} SOL after | destination now holds ${fmt(destBal, 4)} SOL`);
  } else {
    const sim = await wallet.simulate(tx, []);
    console.log(`simulated   ${sim.ok ? "ok" : `FAILED ${JSON.stringify(sim.err)}`} (in a simulation the closes did not really land, so this is the pre-close balance)`);
  }
}

main().catch((err) => {
  console.error(`WITHDRAW STOPPED: ${(err as Error).message}`);
  process.exit(1);
});
