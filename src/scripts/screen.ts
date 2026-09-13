/**
 * Run the screener once and print the board: one ranking across Meteora DLMM, Raydium CLMM and
 * Orca Whirlpools, then the tokenized-stock pools on their own.
 *   npm run screen
 */
import { Connection } from "@solana/web3.js";
import { config } from "../config";
import { ISSUER_LABEL, runScreen, VENUE_LABEL, verifiedStock } from "../screener";
import type { ScreenedPool } from "../screener";

const usd = (n: number | null) => (n === null ? "n/a" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`);
const pct = (n: number | null, d = 1) => (n === null ? "n/a" : `${n.toFixed(d)}%`);
const age = (h: number | null) => (h === null ? "n/a" : h < 48 ? `${h.toFixed(0)}h` : `${(h / 24).toFixed(0)}d`);
const feeMark = (p: ScreenedPool) => (p.feesSource === "onchain" ? "*" : p.feesSource === "api" ? "°" : " ");
const shownFlags = (p: ScreenedPool) => p.flags.filter((f) => f !== "onchain-fees").join(",");

function row(p: ScreenedPool): string {
  return [
    String(p.rank).padStart(4),
    p.score.toFixed(1).padStart(5),
    p.name.slice(0, 22).padEnd(22),
    VENUE_LABEL[p.venue].padEnd(7),
    String(p.stepBps).padStart(4),
    pct(p.baseFeePct, 2).padStart(5),
    pct(p.feeToTvl24hPct, 2).padStart(8),
    usd(p.tvlUsd).padStart(10),
    usd(p.volume24hUsd).padStart(9),
    `${usd(p.fees24hUsd).padStart(9)}${feeMark(p)}`,
    pct(p.priceChange24hPct).padStart(7),
    age(p.ageHours).padStart(6),
    shownFlags(p),
  ].join("  ");
}

async function main(): Promise<void> {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const t0 = Date.now();
  const r = await runScreen(connection);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nSOL $${r.solPriceUsd?.toFixed(2) ?? "n/a"} · ${r.rankedPools} pools ranked across ${r.venues.length} venues in ${secs}s`);
  console.log(r.venues.map((v) => `${VENUE_LABEL[v.venue]}: ${v.scanned} scanned, ${v.live} live, ${v.ranked} ranked`).join(" · "));
  console.log(`tokenized stocks on the board: ${r.stocks}\n`);

  const head = "rank  score  pool                    venue    step  fee    fee/TVL   liquidity   vol 24h    fees 24h   24h chg  age     flags";
  console.log(head);
  for (const p of r.pools.slice(0, 25)) console.log(row(p));

  const stocks = r.pools.filter((p) => verifiedStock(p.stock));
  const lookalikes = r.pools.filter((p) => p.stock && !verifiedStock(p.stock));
  console.log(`\nSTOCKS · ${stocks.length} pools whose base is a tokenized stock from a known issuer`);
  if (stocks.length) {
    console.log("rank  score  pool                    venue    ticker  issuer     liquidity   vol 24h    fees 24h   fee/TVL   24h chg  flags");
    for (const p of stocks) {
      console.log(
        [
          String(p.rank).padStart(4),
          p.score.toFixed(1).padStart(5),
          p.name.slice(0, 22).padEnd(22),
          VENUE_LABEL[p.venue].padEnd(7),
          p.stock!.ticker.padEnd(6),
          ISSUER_LABEL[p.stock!.issuer].padEnd(9),
          usd(p.tvlUsd).padStart(10),
          usd(p.volume24hUsd).padStart(9),
          `${usd(p.fees24hUsd).padStart(9)}${feeMark(p)}`,
          pct(p.feeToTvl24hPct, 2).padStart(8),
          pct(p.priceChange24hPct).padStart(7),
          shownFlags(p),
        ].join("  "),
      );
    }
  }
  if (lookalikes.length) console.log(`(${lookalikes.length} pool${lookalikes.length === 1 ? "" : "s"} carry a stock-shaped symbol on a mint no known issuer owns; not counted: ${lookalikes.map((p) => p.name).join(", ")})`);
  console.log("\n* fees measured from on-chain protocol fee deltas · ° fees reported by the venue's API · unmarked: volume × base fee");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
