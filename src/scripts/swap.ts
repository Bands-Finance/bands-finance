/**
 * A hand swap from the desk wallet through the desk's own Jupiter path (src/tools/jupiter.ts, src/tools/wallet.ts):
 *   DRY_RUN=false npx tsx src/scripts/swap.ts --from SOL --to USDC --amount 0.6 [--live] [--max-impact 1]
 * Without --live it quotes and simulates only. Zach, 25 Sep 2026: 0.6 SOL to USDC so the live desk can seat the
 * USDC-quoted pools (CARDS/USDC, CATE/USDC) that clear its floors. H1 (src/risk/house.ts) refuses any leg on the
 * house mint inside quote()/buildSwap(), so this can never touch $BANDS. Prints the route, the impact and the
 * signature; the key is never printed.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../config";
import { JupiterClient } from "../tools/jupiter";
import { Wallet } from "../tools/wallet";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const args = Object.fromEntries(process.argv.slice(2).reduce<[string, string][]>((acc, a, i, all) => { if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]); return acc; }, []));
const mints: Record<string, { mint: string; decimals: number }> = { SOL: { mint: SOL_MINT, decimals: 9 }, USDC: { mint: config.usdcMint, decimals: 6 } };
const from = mints[(args.from ?? "SOL").toUpperCase()];
const to = mints[(args.to ?? "USDC").toUpperCase()];
const amount = Number(args.amount ?? 0);
const live = args.live === "true";
const maxImpact = Number(args["max-impact"] ?? 1);
if (!from || !to || !(amount > 0)) { console.error("usage: swap.ts --from SOL --to USDC --amount 0.6 [--live]"); process.exit(2); }

async function main(): Promise<void> {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const wallet = Wallet.fromConfig(connection);
  const client = new JupiterClient();
  const before = await wallet.solBalance();
  console.log(`wallet ${wallet.publicKey.toBase58().slice(0, 8)}… ${before.toFixed(4)} SOL | ${live ? "LIVE: the swap will be sent" : "simulation only"}`);
  const raw = BigInt(Math.round(amount * 10 ** from.decimals));
  const q = await client.quote({ inputMint: from.mint, outputMint: to.mint, amount: raw });
  const inUi = Number(q.inAmount) / 10 ** from.decimals;
  const outUi = Number(q.outAmount) / 10 ** to.decimals;
  const minOut = Number(q.otherAmountThreshold) / 10 ** to.decimals;
  console.log(`quote: ${inUi} ${args.from ?? "SOL"} -> ${outUi.toFixed(4)} ${args.to ?? "USDC"} (min ${minOut.toFixed(4)}), impact ${q.priceImpactPct}%, slippage ${q.slippageBps} bps, route ${q.routeLabels.join(" > ") || "?"}`);
  if (q.priceImpactPct > maxImpact) { console.error(`impact ${q.priceImpactPct}% is over the ${maxImpact}% cap: not sent`); process.exit(3); }
  const built = await client.buildSwap(q, wallet.publicKey);
  if (!live) {
    const sim = await wallet.simulate(built.tx, []);
    console.log(`simulation: ${JSON.stringify(sim).slice(0, 300)}`);
    process.exit(0);
  }
  const sig = await wallet.signAndSend(built.tx);
  console.log(`sent: ${sig}`);
  const outcome = await wallet.signatureOutcome(sig, { attempts: 20, waitMs: 3000 });
  console.log(`outcome: ${JSON.stringify(outcome).slice(0, 200)}`);
  const after = await wallet.solBalance();
  const usdc = await wallet.usdcBalance();
  console.log(`wallet now ${after.toFixed(4)} SOL, ${JSON.stringify(usdc).slice(0, 80)} USDC`);
}

main().catch((err) => { console.error((err as Error).message); process.exit(1); });
