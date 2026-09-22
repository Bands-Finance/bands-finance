/**
 * npm run clawpump -- status | pairs | cost | quote | launch [--confirm]
 *
 *   status   the agent on ClawPump (public earnings; the record and its linked token when a key is set)
 *   pairs    pump.fun creation pairs and the creator-fee range (key)
 *   cost     what a self-funded launch costs today (key)
 *   quote    a payment quote for OUR token from the paying wallet: amount, pay-to, validity, and who the
 *            creator fees go to for good (key; pays nothing)
 *   launch   the whole self-funded flow: quote -> send the SOL from the paying wallet -> complete -> print
 *            the mint as TOKEN_MINT. Refused unless DRY_RUN=false AND --confirm AND the key exists AND the
 *            paying wallet is his operating wallet, pinned by TOKEN_PAYER_EXPECTED (never the desk wallet). The token
 *            is $BANDS, the Clawrena entry (docs/token.md).
 *
 * The payer is WALLET_SECRET_KEY, and for the launch that is his operating wallet's keypair, not the desk's. With
 * TOKEN_PAYER_EXPECTED set, this command checks the key against it INSTEAD of EXPECTED_WALLET; nothing else
 * does, so the desk's own check is untouched.
 *
 * PAIR_HOUSE_MINTS stays unset through 8 Oct by decision (docs/sprint.md): it would seat and market-make the
 * house token. The desk never touches $BANDS (H1, src/risk/house.ts), which reads TOKEN_MINT.
 */
import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { config } from "../config";
import { ClawPumpClient, clawpumpEnv, isSolPair, launchRefusal, payerExpectedOf, resolvePumpPair, tokenSpec, type LaunchRequest } from "../tools/clawpump";
import { Wallet } from "../tools/wallet";

const usd = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });

async function main(): Promise<void> {
  const [cmd = "status", ...rest] = process.argv.slice(2);
  const env = clawpumpEnv();
  const client = new ClawPumpClient({ baseUrl: env.baseUrl, apiKey: env.apiKey });
  const need = (what: string): string => {
    if (!env.agentId) throw new Error(`${what}: CLAWPUMP_AGENT_ID is not set`);
    return env.agentId;
  };

  if (cmd === "status") {
    const agentId = need("status");
    const e = await client.earnings(agentId);
    console.log(`ClawPump agent ${agentId}`);
    console.log(`  earnings: total ${usd(e.totalEarned)} | sent ${usd(e.totalSent)} | pending ${usd(e.totalPending)} | held ${usd(e.totalHeld)} | ${e.recentDistributions.length} recent distribution(s)`);
    if (env.apiKey) {
      const a = await client.agent(agentId);
      console.log(`  record: ${a.name || "(unnamed)"} status ${a.status ?? "?"} wallet ${a.walletAddress ?? "none"} token ${a.tokenAddress ?? "none linked yet"}${a.isPublic === null ? "" : a.isPublic ? " public" : " private"}`);
      if (a.tokenAddress) console.log(`  -> TOKEN_MINT=${a.tokenAddress}  (PAIR_HOUSE_MINTS stays unset through 8 Oct by decision)`);
    } else console.log("  (set CLAWPUMP_API_KEY to read the agent record and its linked token)");
    return;
  }
  if (cmd === "pairs") {
    const p = await client.pumpPairs();
    console.log(`pump.fun creation pairs (creator fee ${p.creatorFeeBps.min}-${p.creatorFeeBps.max} bps, default ${p.creatorFeeBps.default}; not settable on the SOL pair):`);
    for (const a of p.assets) console.log(`  ${a.symbol.padEnd(8)} ${a.mint}  ${a.name}`);
    return;
  }
  if (cmd === "cost") {
    const c = await client.selfFundedCost();
    console.log(`self-funded launch: creation fee ${c.creationFeeSol ?? "?"} SOL, standard cost ${c.standardCostSol ?? "?"} SOL, pay to ${c.payTo ?? "?"}, quote valid ${c.quoteValidForSeconds ?? "?"} s`);
    return;
  }
  if (cmd === "quote" || cmd === "launch") {
    const agentId = need(cmd);
    const token = tokenSpec();
    const connection = new Connection(config.rpcUrl, "confirmed");
    // the payer: his operating wallet's keypair, pinned by TOKEN_PAYER_EXPECTED for this command only (the desk keeps EXPECTED_WALLET)
    const payerExpected = payerExpectedOf();
    const wallet = Wallet.fromConfig(connection, payerExpected ? { address: payerExpected, name: "TOKEN_PAYER_EXPECTED" } : undefined);
    const req: LaunchRequest = { agentId, agentName: config.agentName, walletAddress: wallet.keypair.publicKey.toBase58(), token };
    // the creation pair: SOL by the decision of 22 Sep. A custom pair from ClawPump's live catalogue still quotes, but the launch refuses it
    if (!isSolPair(token.pumpPair)) {
      const catalogue = await client.pumpPairs();
      const pair = resolvePumpPair(catalogue.assets, token.pumpPair);
      if (!pair.ok) {
        console.log(`  launch pair refused: ${pair.reason}`);
        process.exitCode = 2;
        return;
      }
      req.pumpQuoteMint = pair.asset!.mint;
      req.pumpCreatorFeeBps = token.creatorFeeBps ?? catalogue.creatorFeeBps.default;
      console.log(`  paired with ${pair.asset!.symbol} (${pair.asset!.mint}), creator fee ${req.pumpCreatorFeeBps} bps; creator fees accrue in ${pair.asset!.symbol}`);
    }
    const deskWallet = config.engine.expectedWallet || null;
    const payer = req.walletAddress;
    console.log(`${token.name} (${token.symbol}) by ${config.agentName}, agent ${agentId}, pair ${isSolPair(token.pumpPair) ? "SOL" : token.pumpPair}, dev buy ${token.devBuySol} SOL, buybackBps 0`);
    console.log(`  payer ${payer}${wallet.ephemeral ? " (EPHEMERAL: no WALLET_SECRET_KEY set)" : ""}`);
    console.log(`  creator fees go to ${payer} for good`);
    if (deskWallet && payer === deskWallet) console.log(`  WARNING: ${payer} is the desk wallet (EXPECTED_WALLET). The launch will refuse it: pay from his operating wallet's keypair.`);
    if (!payerExpected) console.log("  WARNING: TOKEN_PAYER_EXPECTED is not set. The launch will refuse until it names his operating wallet's address.");
    else if (payer !== payerExpected) console.log(`  WARNING: the key derives to ${payer}, but TOKEN_PAYER_EXPECTED is ${payerExpected}. Wrong key: the launch will refuse it.`);
    if (token.devBuySol !== 0) console.log(`  WARNING: TOKEN_DEV_BUY_SOL is ${token.devBuySol}. The decision of 22 Sep is no dev buy (0): the launch will refuse it.`);
    if (!isSolPair(token.pumpPair)) console.log(`  WARNING: TOKEN_PUMP_PAIR is ${token.pumpPair}. The decision of 22 Sep is the SOL pair: the launch will refuse it.`);
    const q = await client.launchPreflight(req);
    console.log(`  quote: ${q.amountSol} SOL (${q.amountLamports} lamports) to ${q.payTo}, valid ${q.validForSeconds} s${q.creationFeeSol !== null ? `; creation fee ${q.creationFeeSol} SOL` : ""}${q.devBuySol ? `, dev buy ${q.devBuySol} SOL` : ""}${q.requestId ? ` (request ${q.requestId})` : ""}`);
    if (cmd === "quote") {
      console.log("  nothing paid, nothing minted: `npm run clawpump -- launch --confirm` with DRY_RUN=false does it");
      return;
    }
    const refusal = launchRefusal({ dryRun: config.dryRun, confirm: rest.includes("--confirm"), apiKey: env.apiKey, agentId, ephemeralWallet: wallet.ephemeral, payer, payerExpected, deskWallet, devBuySol: token.devBuySol, pumpPair: token.pumpPair });
    if (refusal) {
      console.log(`  launch refused: ${refusal}`);
      process.exitCode = 2;
      return;
    }
    const balance = await connection.getBalance(wallet.keypair.publicKey, "confirmed");
    if (balance < q.amountLamports + 5_000_000) throw new Error(`wallet holds ${balance / LAMPORTS_PER_SOL} SOL; the launch needs ${q.amountSol} SOL plus fees`);
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet.keypair.publicKey, toPubkey: new PublicKey(q.payTo), lamports: q.amountLamports }));
    const sig = await wallet.signAndSend(tx);
    console.log(`  paid: ${sig}`);
    const done = await client.launchComplete(req, sig, q.preflightToken);
    console.log(`  ${done.status}: mint ${done.mintAddress}${done.txHash ? ` (launch tx ${done.txHash})` : ""}${done.pumpUrl ? `\n  pump.fun: ${done.pumpUrl}` : ""}${done.explorerUrl ? `\n  explorer: ${done.explorerUrl}` : ""}`);
    console.log(`  creator fees go to ${payer} for good`);
    console.log(`\n  record the mint in .env (the desk's H1 guard and the talk lint read it; the desk never trades it):\n  TOKEN_MINT=${done.mintAddress}`);
    console.log("  PAIR_HOUSE_MINTS stays unset through 8 Oct by decision (docs/sprint.md): it would seat and market-make the token.");
    return;
  }
  console.log("usage: npm run clawpump -- status | pairs | cost | quote | launch [--confirm]");
  process.exitCode = 1;
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
