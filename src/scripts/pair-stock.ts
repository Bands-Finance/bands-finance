/**
 * The stock pair lane, READ-ONLY against the data dir: which tickers it admits right now, the
 * reference it would price against, the fee the model picks, the model's share (gross | net) and
 * fees per day at the desk's seat, and whether Backpack lists a perp to hedge on. Reads screen.json,
 * basis.json and hot.json; writes nothing; no RPC, no network.
 *
 *   DATA_DIR=data-live MAX_TOTAL_EXPOSURE_SOL=175 MAX_POSITION_SOL=44 PAIR_STOCK_SEAT_PCT=15 npm run pair-stock -- --sol 103
 *
 * --sol <usd>   the SOL price to size the seat with (default: the screen's)
 * --all         print every stock on the board, refused ones included (default: refused ones too, one line each)
 */
import { policyEnv, stockBinsPerSide } from "../agent/policy";
import { basisForTicker, loadBasis, sessionClock, sessionWidthMultiplier } from "../basis";
import { config, riskLimits } from "../config";
import { loadHot } from "../hot";
import { loadScreen } from "../screener";
import { chooseStockFeeBps, pairStockCandidatesOf, pairStockEnv, pairStockSeats, pairStockSeatSol, pairStockVerdict, stockPairModel } from "../screener/pairStock";
import { usd } from "../screener/launch";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function main(): void {
  const screen = loadScreen();
  if (!screen) {
    console.error(`no screen in ${config.dataDir}: run \`npm run screen\` (or point DATA_DIR at a desk that has one)`);
    process.exit(1);
  }
  const hot = loadHot();
  const basis = loadBasis();
  const env = pairStockEnv();
  const solPrice = Number(arg("--sol")) > 0 ? Number(arg("--sol")) : (screen.solPriceUsd ?? 0);
  const seatSol = Math.min(pairStockSeatSol(riskLimits.maxTotalExposureSol, env), riskLimits.maxPositionSol);
  const seatUsd = seatSol * solPrice;
  const clock = sessionClock();
  const mult = sessionWidthMultiplier(clock);
  const bins = stockBinsPerSide(env.binStep, policyEnv().stockCoverPct, riskLimits.maxBinWidth, mult);
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

  console.log("=".repeat(120));
  console.log(`STOCK PAIR LANE, read-only  |  screen ${screen.generatedAt} (${screen.stocks} stock pools)  |  basis ${basis?.generatedAt ?? "none"}  |  hot ${hot?.generatedAt ?? "none"}`);
  console.log(`seat ${seatSol.toFixed(4)} SOL = ${usd(seatUsd)} at SOL ${usd(solPrice)} (${env.seatPct}% of ${riskLimits.maxTotalExposureSol} SOL, max band ${riskLimits.maxPositionSol}) | ${env.binStep / 100}%/bin, ${bins} bins a side (STOCK_COVER_PCT ${policyEnv().stockCoverPct}% x${mult} for the ${clock.session} US session) = ${usd(bins > 0 ? seatUsd / 2 / bins : 0)} per bin | fee menu ${env.feeMenuBps.join("/")} bps | trades $${env.tradeMinUsd}-$${env.tradeMaxUsd} | hop ${env.hopFeePct}% | ref depth ${env.refDepthPerPct} of TVL per 1%`);
  console.log(`floors: reference liquidity >= ${usd(env.minRefLiquidityUsd)}, ticker 24h volume >= ${usd(env.minVolume24hUsd)}; tickers ${env.tickers ? env.tickers.join(", ") : "every xStock"}; max ${env.maxPools} pool(s)`);
  console.log("=".repeat(120));

  const cands = pairStockCandidatesOf(screen.pools, hot?.rows ?? []);
  const rows = cands.map((c) => {
    const verdict = pairStockVerdict(c, env);
    const ref = { liquidityUsd: c.refLiquidityUsd, vol24hUsd: c.vol24hUsd, vol1hUsd: c.vol1hUsd, refFeePct: c.refFeePct, refQuoteIsSol: c.refQuoteIsSol };
    const feeBps = chooseStockFeeBps(ref, env, seatUsd, bins);
    const model = stockPairModel(ref, env, seatUsd, bins, c.competingDepthUsd, { feeBps });
    const b = basisForTicker(c.ticker, basis);
    return { c, verdict, feeBps, model, basis: b };
  });
  const admitted = rows.filter((r) => r.verdict.ok).sort((a, b) => b.model.feesPerDayUsd - a.model.feesPerDayUsd);
  const refused = rows.filter((r) => !r.verdict.ok);

  console.log(`\nADMITTED (${admitted.length}), best by the model first  |  share = the model's share of the ticker's flow by value, gross (single hop vs the two-hop route) | net (after the other SOL-quoted pools split it by depth)`);
  for (const r of admitted) {
    const c = r.c;
    const m = r.model;
    const hedge = r.basis?.perpSymbol ? `hedged on ${r.basis.perpSymbol}${r.basis.perpMid ? ` (mid ${r.basis.perpMid}${r.basis.note ? `, ${r.basis.note}` : ""})` : ""}` : "UNHEDGED (no Backpack perp)";
    console.log(
      `  ${c.ticker.padEnd(6)} ${c.symbol.padEnd(7)} ref ${c.reference.venue}/${c.reference.quoteSymbol} ${c.reference.address.slice(0, 6)} ${usd(c.refLiquidityUsd ?? 0).padStart(11)} TVL at ${c.refFeePct}%${c.refQuoteIsSol ? " (SOL-quoted: no hop)" : ""} | vol24h ${usd(c.vol24hUsd ?? 0)} over ${c.pools.length} pool(s)${c.vol1hUsd !== null ? `, 1h ${usd(c.vol1hUsd)}` : ""} | SOL-quoted competition ${usd(c.competingDepthUsd)} in ${c.competitors.length} pool(s)`,
    );
    console.log(
      `         fee ${r.feeBps} bps | share ${pct(m.routedShareGross)} | ${pct(m.routedShare)} | fees/day ${usd(m.feesPerDayGrossUsd)} gross | ${usd(m.feesPerDayUsd)} net on ${usd(m.dailyVolumeUsd)} a day | ours at $${env.tradeMinUsd}: ${m.ourCostAtMinPct === null ? "unfillable" : `${m.ourCostAtMinPct.toFixed(3)}%`} vs theirs ${m.refCostAtMinPct.toFixed(3)}% | ${hedge}${m.feesPerDayUsd <= 0 ? "  <- the model routes nothing here at this seat: the picker skips it" : ""}`,
    );
  }
  if (!admitted.length) console.log("  none");

  console.log(`\nREFUSED (${refused.length})`);
  for (const r of refused) console.log(`  ${r.c.ticker.padEnd(6)} ${(r.verdict as { reason: string }).reason}`);
  if (!refused.length) console.log("  none");

  const seats = pairStockSeats(cands, {
    env,
    freeSeats: config.maxActivePools,
    quoteOk: () => true,
    worth: (c) => rows.find((r) => r.c === c)?.model.feesPerDayUsd ?? 0,
  });
  console.log(`\nTHE PICKER WOULD SEAT (up to PAIR_STOCK_MAX_POOLS=${env.maxPools}, the model's fees/day > 0, one per ticker, a DENY not applied here): ${seats.length ? seats.map((s) => `${s.candidate.ticker} (${usd(s.worthUsdPerDay ?? 0)}/day)`).join(", ") : "nothing: no admitted ticker routes any flow to a pool this size"}`);
  console.log("=".repeat(120));
}

main();
