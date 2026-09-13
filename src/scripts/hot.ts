/**
 * Run one hot-watch tick and print the top 20 as a table: what a dollar of liquidity earned in the
 * last hour, the daily pace that implies, how much faster than the day's pace the last hour ran.
 *   npm run hot
 */
import { runHotTick } from "../hot";
import type { HotRow } from "../hot";

const usd = (n: number | null) => (n === null ? "n/a" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`);
const pct = (n: number | null, d = 1) => (n === null ? "n/a" : `${n.toFixed(d)}%`);
const signed = (n: number | null, d = 1) => (n === null ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`);
const age = (h: number | null) => (h === null ? "n/a" : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(0)}h` : `${(h / 24).toFixed(0)}d`);
const mult = (n: number | null) => (n === null ? "n/a" : `${n.toFixed(1)}x`);

function row(r: HotRow, i: number): string {
  return [
    String(i + 1).padStart(4),
    r.name.slice(0, 22).padEnd(22),
    r.venue.slice(0, 15).padEnd(15),
    usd(r.liquidityUsd).padStart(9),
    usd(r.vol1hUsd).padStart(8),
    usd(r.vol24hUsd).padStart(8),
    mult(r.acceleration).padStart(6),
    (r.feePct === null ? "n/a" : pct(r.feePct, 2)).padStart(6),
    pct(r.feeToTvl1hPct, 3).padStart(8),
    pct(r.feeToTvlDailyPct).padStart(7),
    (r.sellShare1h === null ? "n/a" : `${(r.sellShare1h * 100).toFixed(0)}%`).padStart(5),
    signed(r.priceChange1hPct).padStart(7),
    age(r.ageHours).padStart(4),
    String(r.heat).padStart(5),
    [r.surge ? "SURGE" : "", ...r.flags].filter(Boolean).join(","),
  ].join("  ");
}

async function main(): Promise<void> {
  const hot = await runHotTick({ log: (s) => console.log(s) });
  const s = hot.sources;
  console.log(`\n${hot.rows.length} pools ranked · trending ${s.trending} · dexscreener ${s.dexscreener} · onchain reads ${s.onchainReads} · tick ${(hot.tickMs / 1000).toFixed(1)}s · ${hot.generatedAt}`);
  if (s.errors.length) console.log(`source errors: ${s.errors.join(" | ")}`);
  console.log();
  console.log("rank  pool                    venue            liquidity    vol 1h   vol 24h   accel   fee %  fee/TVL1h    daily  sells   1h move   age   heat  flags");
  hot.rows.slice(0, 20).forEach((r, i) => console.log(row(r, i)));
  console.log("\nfee/TVL 1h: what a dollar in the pool earned in the last 60 minutes · daily: that times 24 · accel: last hour vs the day's hourly pace · sells: share of the hour's trades that were sells");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
