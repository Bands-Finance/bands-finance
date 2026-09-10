/**
 * Milestone 1: read-only. Connect to the RPC, load the DLMM pool, print the active bin and price.
 *   npm run read-pool
 */
import { Connection } from "@solana/web3.js";
import { config } from "../config";
import { getPoolSnapshot, getUserPositions, loadPool } from "../tools/dlmm";
import { Wallet } from "../tools/wallet";

async function main(): Promise<void> {
  console.log(`RPC   ${config.rpcUrl}`);
  console.log(`pool  ${config.poolAddress}`);
  const connection = new Connection(config.rpcUrl, "confirmed");
  const t0 = Date.now();
  const dlmm = await loadPool(connection, config.poolAddress);
  const s = await getPoolSnapshot(dlmm, 5);
  console.log(`loaded in ${Date.now() - t0}ms\n`);

  console.log(`pair        ${s.label}`);
  console.log(`token X     ${s.tokenX.symbol}  ${s.tokenX.mint}  (${s.tokenX.decimals} dec)  reserve ${s.tokenX.reserve.toFixed(2)}`);
  console.log(`token Y     ${s.tokenY.symbol}  ${s.tokenY.mint}  (${s.tokenY.decimals} dec)  reserve ${s.tokenY.reserve.toFixed(4)}`);
  console.log(`bin step    ${s.binStep} bps`);
  console.log(`active bin  ${s.activeBinId}`);
  console.log(`price       ${s.activePrice.toPrecision(8)} ${s.priceLabel}`);
  console.log(`fees        base ${s.baseFeePct.toFixed(3)}%  dynamic ${s.dynamicFeePct.toFixed(3)}%  max ${s.maxFeePct.toFixed(2)}%`);
  console.log("");
  console.log("bins around active   binId        price          X            Y");
  for (const b of s.bins) {
    console.log(
      `${b.isActive ? "  >" : "   "} ${String(b.binId).padStart(18)}  ${b.price.toPrecision(8).padStart(14)}  ${b.xAmount.toFixed(2).padStart(12)}  ${b.yAmount.toFixed(4).padStart(12)}${b.isActive ? "   <- active" : ""}`,
    );
  }

  const wallet = Wallet.fromConfig(connection);
  if (!wallet.ephemeral) {
    console.log(`\nwallet      ${wallet.publicKey.toBase58()}  ${(await wallet.solBalance()).toFixed(4)} SOL`);
    const { positions } = await getUserPositions(dlmm, wallet.publicKey, s);
    console.log(`positions   ${positions.length}`);
    for (const p of positions) {
      console.log(`  ${p.address}  bins [${p.lowerBinId}, ${p.upperBinId}]  ${p.inRange ? "in range" : "out of range"}  value ${p.valueInSol.toFixed(4)} SOL`);
    }
  } else {
    console.log("\nwallet      none configured (set WALLET_SECRET_KEY to see positions)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
