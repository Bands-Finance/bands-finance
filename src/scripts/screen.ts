/**
 * Run the screener once and print the board.
 *   npm run screen
 */
import { Connection } from "@solana/web3.js";
import { config } from "../config";
import { runScreen } from "../screener";

const usd = (n: number | null) => (n === null ? "n/a" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`);
const pct = (n: number | null, d = 1) => (n === null ? "n/a" : `${n.toFixed(d)}%`);

async function main(): Promise<void> {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const t0 = Date.now();
  const r = await runScreen(connection);
  console.log(`\nSOL $${r.solPriceUsd?.toFixed(2) ?? "n/a"} · ${r.rankedPools} pools ranked in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  console.log("rank  score  pool                      step  fee    fee/TVL   liquidity   vol 24h    fees 24h   24h chg  age     flags");
  for (const p of r.pools.slice(0, 25)) {
    console.log(
      `${String(p.rank).padStart(4)}  ${p.score.toFixed(1).padStart(5)}  ${p.name.slice(0, 24).padEnd(24)}  ${String(p.binStep).padStart(4)}  ${pct(p.baseFeePct, 2).padStart(5)}  ${pct(p.feeToTvl24hPct, 2).padStart(8)}  ${usd(p.tvlUsd).padStart(10)}  ${usd(p.volume24hUsd).padStart(9)}  ${usd(p.fees24hUsd).padStart(9)}${p.feesSource === "onchain" ? "*" : " "} ${pct(p.priceChange24hPct).padStart(7)}  ${p.ageHours === null ? "n/a".padStart(6) : (p.ageHours < 48 ? `${p.ageHours.toFixed(0)}h` : `${(p.ageHours / 24).toFixed(0)}d`).padStart(6)}  ${p.flags.join(",")}`,
    );
  }
  console.log("\n* fees measured from on-chain protocol fee deltas");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
