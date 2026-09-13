/**
 * Paper desk: size a portfolio across the best pools and push every proposed band through the
 * real guards and the engine, in dry-run, with no wallet and no LLM.
 *   npm run paper -- --usd 10000 --pools 4
 *
 * What it does, in order: read the latest screen -> convert the budget to SOL -> scale the limits
 * to the budget (90% deployable, split across --pools bands) -> rank the qualifying SOL- and
 * USDC-quoted pools -> read each candidate pool live from chain (a USDC pool is valued at the
 * screen's SOL price) -> plan a quote-only band on the bid side of the active bin -> estimate our
 * share of the fees in that band -> run evaluate() exactly as the loop would -> print the desk.
 * Numbers are estimates from 24h data; they are not a forecast. Nothing is broadcast or written.
 */
import { Connection } from "@solana/web3.js";
import { config, riskLimits } from "../config";
import type { Decision } from "../agent/schema";
import { loadScreen } from "../screener";
import type { ScreenedPool } from "../screener/types";
import { evaluate, EngineGuardContext } from "../risk/guards";
import type { RiskLimits } from "../risk/limits";
import { emptyState } from "../risk/state";
import { benchView, circuitHalted, EngineState, loadEngineState, regimeView, RegimeView, standingDown } from "../engine/breakers";
import { BIN_ARRAY_RENT_SOL, getPoolSnapshot, loadPool, OPEN_COST_ESTIMATE_SOL, PoolSnapshot, POSITION_RENT_SOL, quoteOf, setSolPriceUsd } from "../tools/dlmm";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const USD = Number(arg("usd", "10000"));
const POOLS = Number(arg("pools", "4"));
const COVER_PCT = Number(arg("cover", "5")); // how far past the active bin the band reaches, in percent of price
const binsFor = (binStep: number) => Math.max(3, Math.min(69, Math.round(Math.log(1 + COVER_PCT / 100) / Math.log(1 + binStep / 10_000))));
const RESERVE_SHARE = 0.1;
const MAX_SHARE_PCT = 50; // Meridian's dead-pool trap: above this we would BE the pool

/** Tokenized stocks on Solana. xStocks (Backed) use a lowercase x suffix on the ticker. */
const STOCK_TICKERS = new Set("AAPL TSLA NVDA SPY QQQ GOOGL GOOG META MSFT AMZN MSTR COIN HOOD CRCL AMD PLTR NFLX GLD TQQQ AVGO LLY JPM V MA BRKB ORCL INTC UNH WMT ABT ACN AZN BAC CRM CSCO CVX DFDV GME HON IBM JNJ KO LIN MCD MDT MRK MRVL NVO NVS PEP PFE PG PM TMO XOM CMCSA DHR GS TBLL VTI APP OPEN SNOW SHOP UBER ABNB ARM ASML BABA BRK SOFI".split(" "));
export function isTokenizedStock(p: Pick<ScreenedPool, "baseSymbol" | "name">): "xstock" | "x-suffix" | null {
  const m = /^([A-Z]{1,5})x$/.exec(p.baseSymbol ?? "");
  if (!m) return null;
  return STOCK_TICKERS.has(m[1]) ? "xstock" : "x-suffix";
}

const fmtUsd = (n: number | null | undefined, d = 0) => (n === null || n === undefined || !Number.isFinite(n) ? "n/a" : `$${n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d })}`);
const fmtPct = (n: number | null | undefined, d = 2) => (n === null || n === undefined || !Number.isFinite(n) ? "n/a" : `${n.toFixed(d)}%`);
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const rpad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s);

function qualifies(p: ScreenedPool): string | null {
  if (p.score <= 0) return "score 0";
  for (const f of ["thin", "no-24h-data", "new"]) if (p.flags.includes(f)) return `flag ${f}`;
  if ((p.tvlUsd ?? 0) < 20_000) return "tvl < $20k";
  if ((p.volume24hUsd ?? 0) < 20_000) return "vol < $20k";
  if ((p.ageHours ?? 0) < 72) return "age < 72h";
  return null;
}

interface Seat {
  pool: ScreenedPool;
  snapshot: PoolSnapshot;
  /** the pool's quote token: what the band deposits */
  quoteSymbol: string;
  /** seat size in SOL-equivalent (the guards' unit) and in the quote token (the deposit) */
  seatSol: number;
  seatQuote: number;
  seatUsd: number;
  /** liquidity on the quote side of the active bin, scaled to the planned band, in quote units */
  bandDepthQuote: number;
  sharePct: number;
  feesPerDayUsd: number | null;
  feesFloorUsd: number | null;
  paybackDays: number | null;
  bins: number;
  /** true when the quote is token Y and the band sits under the active bin; false when it sits above (quote is X) */
  quoteBelow: boolean;
  coveragePct: number;
  verdict: ReturnType<typeof evaluate>;
}

interface Desk {
  solPrice: number;
  limits: RiskLimits;
  engine: EngineState;
  regime: RegimeView;
  now: number;
}

/** Plan one quote-only band in a pool and run it through the guards exactly as the loop would. */
function planSeat(desk: Desk, p: ScreenedPool, snapshot: PoolSnapshot, book: { exposureSol: number; walletUsd: number; poolsWithBands: number }): Seat {
  const { solPrice, limits, engine, regime, now } = desk;
  const q = quoteOf(snapshot);
  const quoteBelow = q.side === "Y";
  const bins = binsFor(p.binStep);
  const bench = benchView(engine, p.address, now);
  const sizeMultiplier = bench.multiplier * regime.multiplier;
  const seatSol = Math.min(limits.maxPositionSol * sizeMultiplier, Math.max(0, limits.maxTotalExposureSol - book.exposureSol));
  const seatQuote = seatSol / q.priceInSol;
  const seatUsd = seatSol * solPrice;
  // Depth on the quote side of the active bin (the bid when the quote is Y), scaled to the band we plan.
  const observedSide = snapshot.bins.filter((b) => (quoteBelow ? b.binId < snapshot.activeBinId : b.binId > snapshot.activeBinId)).length || 1;
  const bandDepthQuote = ((quoteBelow ? snapshot.liquidityBelowY : snapshot.liquidityAboveX) / observedSide) * bins;
  const sharePct = (seatQuote / (bandDepthQuote + seatQuote)) * 100;
  // Ceiling: our share of the band's liquidity times the pool's 24h fees, halved because a one-sided band
  // earns only while price sits in it. Floor: what an average LP spread across the whole pool made (fee/TVL).
  const feesPerDayUsd = p.fees24hUsd !== null ? (p.fees24hUsd * Math.min(sharePct, MAX_SHARE_PCT)) / 100 * 0.5 : null;
  const feesFloorUsd = p.feeToTvl24hPct !== null ? (seatUsd * p.feeToTvl24hPct) / 100 : null;
  const nonRefundableSol = 2 * BIN_ARRAY_RENT_SOL + 0.002;
  const paybackDays = feesPerDayUsd && feesPerDayUsd > 0 ? (nonRefundableSol * solPrice) / feesPerDayUsd : null;
  const coveragePct = (Math.pow(1 + p.binStep / 10_000, bins) - 1) * 100;
  const proposal: Decision = {
    action: "OPEN_POSITION",
    open: {
      side: "SOL_ONLY",
      amountSol: Number(seatQuote.toFixed(4)),
      amountToken: 0,
      binsBelowActive: quoteBelow ? bins : 0,
      binsAboveActive: quoteBelow ? 0 : bins,
      strategy: "Spot",
    },
    positionAddress: null,
    reasoning: `Paper seat: ${p.name} rank #${p.rank} score ${p.score}, fee/TVL ${fmtPct(p.feeToTvl24hPct)}, 24h vol ${fmtUsd(p.volume24hUsd)}. ${q.symbol}-only band ${bins} bins ${quoteBelow ? "under" : "over"} the active bin (${coveragePct.toFixed(1)}% of price).`,
    confidence: 0.6,
    headline: `Paper: ${seatQuote.toFixed(2)} ${q.symbol} ${quoteBelow ? "under the bid" : "over the ask"} in ${p.name}.`,
  };
  const engineCtx: EngineGuardContext = {
    haltedUntil: circuitHalted(engine.circuit, now) ? engine.circuit.haltUntil : null,
    standDownUntil: standingDown(engine.portfolio, now) ? engine.portfolio.standDownUntil : null,
    sizeMultiplier,
    benched: bench.benched,
    benchReason: bench.reason,
    regimeReason: regime.reason,
    knife: null,
    outOfRangeSince: {},
    stops: {},
    outOfRangeSec: config.engine.outOfRangeSec,
  };
  // The paper wallet holds the remaining budget: as SOL for a SOL pool, as USDC for a USDC pool
  // (the SOL view still pays the rent and the gas reserve, as the guards require).
  const walletSol = book.walletUsd / solPrice;
  const walletQuote = q.symbol === "SOL" ? walletSol : book.walletUsd;
  const verdict = evaluate(
    proposal,
    {
      now,
      snapshot,
      positions: [],
      walletSol,
      walletToken: 0,
      walletQuote,
      state: emptyState(),
      killSwitch: false,
      otherExposureSol: book.exposureSol,
      poolsWithBands: book.poolsWithBands,
      maxActivePools: POOLS,
      engine: engineCtx,
      source: "llm",
    },
    limits,
  );
  const viable = sharePct <= MAX_SHARE_PCT;
  if (!viable) verdict.violations.push(`we would be ${sharePct.toFixed(0)}% of the band (max ${MAX_SHARE_PCT}%): the fees are not there for our size`);
  return {
    pool: p,
    snapshot,
    quoteSymbol: q.symbol,
    seatSol,
    seatQuote,
    seatUsd,
    bandDepthQuote,
    sharePct,
    feesPerDayUsd,
    feesFloorUsd,
    paybackDays,
    coveragePct,
    bins,
    quoteBelow,
    verdict: { ...verdict, allowed: verdict.allowed && viable },
  };
}

async function main(): Promise<void> {
  const screen = loadScreen();
  if (!screen) throw new Error("no screen yet: run `npm run screen` first");
  const solPrice = screen.solPriceUsd;
  if (!solPrice) throw new Error("screen has no SOL price");
  setSolPriceUsd(solPrice);
  const capitalSol = USD / solPrice;
  const deployableSol = capitalSol * (1 - RESERVE_SHARE);
  const limits: RiskLimits = {
    ...riskLimits,
    maxTotalExposureSol: Number(deployableSol.toFixed(4)),
    maxPositionSol: Number((deployableSol / POOLS).toFixed(4)),
  };
  const ageMin = (Date.now() - new Date(screen.generatedAt).getTime()) / 60000;
  console.log("=".repeat(96));
  console.log(`PAPER DESK  ${fmtUsd(USD)} = ${capitalSol.toFixed(2)} SOL at ${fmtUsd(solPrice, 2)}/SOL  |  screen ${screen.generatedAt} (${ageMin.toFixed(0)} min old), ${screen.scannedPools.toLocaleString()} pools scanned, ${screen.rankedPools} ranked`);
  console.log(`limits for this budget: max ${limits.maxPositionSol} SOL per band (${fmtUsd(limits.maxPositionSol * solPrice)}), ${limits.maxTotalExposureSol} SOL across bands (${(100 - RESERVE_SHARE * 100).toFixed(0)}% deployable), gas reserve ${limits.gasReserveSol} SOL, stop ${limits.stopLossPct}%, width <= ${limits.maxBinWidth} bins`);
  console.log(`quotes: SOL and USDC; a USDC seat deposits USDC and is sized, capped and valued in SOL at ${fmtUsd(solPrice, 2)}/SOL (1 USDC = ${(1 / solPrice).toFixed(6)} SOL)`);
  console.log("=".repeat(96));

  // Candidates: SOL- or USDC-quoted, qualified, best score first.
  const tradable = screen.pools.filter((p) => p.quoteSymbol === "SOL" || p.quoteSymbol === "USDC");
  const skipped: string[] = [];
  const candidates = tradable.filter((p) => {
    const why = qualifies(p);
    if (why) skipped.push(`${p.name} (${why})`);
    return !why;
  });

  const engine = loadEngineState();
  const now = Date.now();
  const regime = regimeView(candidates.slice(0, POOLS * 2).map((p) => p.priceChange24hPct));
  const desk: Desk = { solPrice, limits, engine, regime, now };

  const connection = new Connection(config.rpcUrl, "confirmed");
  const readLive = async (p: ScreenedPool): Promise<PoolSnapshot> => getPoolSnapshot(await loadPool(connection, p.address), 15, { solPriceUsd: solPrice });

  const seats: Seat[] = [];
  const notes: string[] = [];
  let exposure = 0;
  let walletUsd = USD;
  for (const p of candidates) {
    const open = seats.filter((s) => s.verdict.allowed);
    if (open.length >= POOLS) break;
    // One seat per base token, across quotes: NVDAx/USDC and NVDAx/SOL move together, so a second seat is concentration, not diversification.
    if (open.some((s) => s.pool.baseMint === p.baseMint)) continue;
    let snapshot: PoolSnapshot;
    try {
      snapshot = await readLive(p);
    } catch (err) {
      notes.push(`${p.name}: could not read the pool live (${(err as Error).message.slice(0, 80)}); skipped`);
      continue;
    }
    const seat = planSeat(desk, p, snapshot, { exposureSol: exposure, walletUsd, poolsWithBands: open.length });
    seats.push(seat);
    if (seat.verdict.allowed) {
      exposure += seat.seatSol;
      walletUsd -= seat.seatUsd + OPEN_COST_ESTIMATE_SOL * solPrice;
    }
  }

  // Tokenized stocks: what the screen sees, and what the guards say about each one. Every xStock pool is
  // USDC-quoted; a qualifying one is seated above like any other pool, the rest show why the desk passes.
  const stocks = screen.pools.filter((p) => isTokenizedStock(p) === "xstock").sort((a, b) => a.rank - b.rank);
  const stockSeatUsd = (USD * (1 - RESERVE_SHARE)) / POOLS;
  console.log(`\nTOKENIZED STOCKS on the board (${stocks.length}): all USDC-quoted, now tradable through the same guards as every other seat`);
  console.log(`  ${pad("rank", 5)} ${pad("pool", 16)} ${rpad("TVL", 10)} ${rpad("vol 24h", 10)} ${rpad("fees 24h", 9)} ${rpad("fee/TVL", 8)} ${rpad("24h", 7)} ${rpad("score", 6)}  ${pad("flags", 14)}  guard verdict for a ${fmtUsd(stockSeatUsd)} USDC seat`);
  for (const p of stocks) {
    let verdict: string;
    const seated = seats.find((s) => s.pool.address === p.address);
    const why = qualifies(p);
    if (seated) {
      verdict = seated.verdict.allowed ? `OPEN ${seated.seatQuote.toFixed(0)} USDC (guards passed)` : `HOLD: ${seated.verdict.violations.join("; ")}`;
    } else if (why) {
      verdict = `not a candidate: ${why}`;
    } else {
      // Qualified but not reached before the seats filled: judge it on its own, with a fresh budget share.
      try {
        const seat = planSeat(desk, p, await readLive(p), { exposureSol: 0, walletUsd: USD, poolsWithBands: 0 });
        verdict = seat.verdict.allowed ? `OPEN ${seat.seatQuote.toFixed(0)} USDC would pass (seats were full)` : `HOLD: ${seat.verdict.violations.join("; ")}`;
      } catch (err) {
        verdict = `could not read the pool live (${(err as Error).message.slice(0, 60)})`;
      }
    }
    console.log(`  ${pad(`#${p.rank}`, 5)} ${pad(p.name, 16)} ${rpad(fmtUsd(p.tvlUsd), 10)} ${rpad(fmtUsd(p.volume24hUsd), 10)} ${rpad(fmtUsd(p.fees24hUsd), 9)} ${rpad(fmtPct(p.feeToTvl24hPct), 8)} ${rpad(fmtPct(p.priceChange24hPct, 1), 7)} ${rpad(p.score.toFixed(1), 6)}  ${pad(p.flags.join(",") || "-", 14)}  ${verdict}`);
  }
  console.log(`  at each pool's own fee/TVL a ${fmtUsd(stockSeatUsd)} seat would earn:`);
  for (const p of stocks.filter((x) => x.feeToTvl24hPct !== null && (x.tvlUsd ?? 0) > 0)) {
    const share = (stockSeatUsd / ((p.tvlUsd ?? 0) + stockSeatUsd)) * 100;
    const perDay = (stockSeatUsd * (p.feeToTvl24hPct ?? 0)) / 100;
    console.log(`    ${pad(p.name, 16)} ${rpad(fmtUsd(perDay, 0), 6)}/day  (${share.toFixed(0)}% of the pool${share > MAX_SHARE_PCT ? ": too big, we would BE the pool" : ""}${p.flags.includes("thin") ? "; thin" : ""})`);
  }

  const bySol = tradable.filter((p) => p.quoteSymbol === "SOL").length;
  const byUsdc = tradable.length - bySol;
  console.log(`\nCANDIDATES: ${tradable.length} SOL- or USDC-quoted on the board (${bySol} SOL, ${byUsdc} USDC), ${candidates.length} qualify (score > 0, not thin/new/no-data, TVL and volume >= $20k, age >= 72h)`);
  if (skipped.length) console.log(`  skipped: ${skipped.slice(0, 12).join("; ")}${skipped.length > 12 ? `; +${skipped.length - 12} more` : ""}`);
  for (const n of notes) console.log(`  ${n}`);

  console.log(`\nENGINE: regime ${regime.multiplier === 1 ? "x1 (board median 24h move " + fmtPct(regime.medianMove24hPct, 1) + ")" : regime.reason}; circuit ${circuitHalted(engine.circuit, now) ? "HALTED" : "clear"}; portfolio ${standingDown(engine.portfolio, now) ? "STANDING DOWN" : "clear"}`);

  console.log(`\nSEATS (quote-only band reaching ${COVER_PCT}% past the active bin on the quote side, Spot; one seat per base token across quotes)`);
  console.log(`  ${pad("pool", 14)} ${pad("quote", 5)} ${rpad("step", 5)} ${rpad("pool TVL", 10)} ${rpad("vol 24h", 11)} ${rpad("fees 24h", 9)} ${rpad("seat", 7)} ${rpad("deposit", 13)} ${rpad("bins", 5)} ${rpad("band depth", 12)} ${rpad("share", 6)} ${rpad("fees/day", 15)} ${rpad("dyn fee", 8)}  verdict`);
  for (const s of seats) {
    const v = s.verdict.allowed ? "OPEN (guards passed)" : `HOLD: ${s.verdict.violations.join("; ")}`;
    const range = s.feesFloorUsd !== null && s.feesPerDayUsd !== null ? `${fmtUsd(Math.min(s.feesFloorUsd, s.feesPerDayUsd), 0)}-${fmtUsd(Math.max(s.feesFloorUsd, s.feesPerDayUsd), 0)}` : fmtUsd(s.feesPerDayUsd, 0);
    const deposit = `${s.seatQuote.toFixed(s.quoteSymbol === "SOL" ? 2 : 0)} ${s.quoteSymbol}`;
    const depth = `${s.bandDepthQuote.toFixed(0)} ${s.quoteSymbol}`;
    console.log(`  ${pad(s.pool.name, 14)} ${pad(s.quoteSymbol, 5)} ${rpad(`${s.pool.binStep}`, 5)} ${rpad(fmtUsd(s.pool.tvlUsd), 10)} ${rpad(fmtUsd(s.pool.volume24hUsd), 11)} ${rpad(fmtUsd(s.pool.fees24hUsd), 9)} ${rpad(fmtUsd(s.seatUsd), 7)} ${rpad(deposit, 13)} ${rpad(`${s.bins}${s.quoteBelow ? "v" : "^"}`, 5)} ${rpad(depth, 12)} ${rpad(fmtPct(s.sharePct, 1), 6)} ${rpad(range, 15)} ${rpad(fmtPct(s.snapshot.dynamicFeePct, 3), 8)}  ${v}`);
  }
  const open = seats.filter((s) => s.verdict.allowed);
  const feesDay = open.reduce((t, s) => t + (s.feesPerDayUsd ?? 0), 0);
  const feesFloor = open.reduce((t, s) => t + (s.feesFloorUsd ?? s.feesPerDayUsd ?? 0), 0);
  const deployedUsd = open.reduce((t, s) => t + s.seatUsd, 0);
  const deployedSolQuote = open.filter((s) => s.quoteSymbol === "SOL").reduce((t, s) => t + s.seatQuote, 0);
  const deployedUsdcQuote = open.filter((s) => s.quoteSymbol === "USDC").reduce((t, s) => t + s.seatQuote, 0);
  const rentSol = open.length * OPEN_COST_ESTIMATE_SOL;
  console.log("\nPORTFOLIO");
  console.log(`  deployed        ${fmtUsd(deployedUsd)} in ${open.length} bands (${((deployedUsd / USD) * 100).toFixed(0)}% of ${fmtUsd(USD)}): ${deployedSolQuote.toFixed(2)} SOL in SOL pools + ${fmtUsd(deployedUsdcQuote)} USDC in USDC pools; ${fmtUsd(USD - deployedUsd)} stays in the wallet as reserve`);
  console.log(`  rent locked     ${rentSol.toFixed(3)} SOL (${fmtUsd(rentSol * solPrice)}) of which ${(open.length * POSITION_RENT_SOL).toFixed(3)} SOL comes back on close; rent and fees are SOL in every pool, so the wallet needs SOL beside the USDC`);
  const lo = Math.min(feesFloor, feesDay);
  const hi = Math.max(feesFloor, feesDay);
  console.log(`  fees, estimate  ${fmtUsd(lo, 0)} to ${fmtUsd(hi, 0)} a day (${fmtUsd(lo * 30, 0)} to ${fmtUsd(hi * 30, 0)} a month) IF yesterday repeats and price stays in every band; the low end is the pool's own fee/TVL, the high end our share of the band`);
  console.log(`  what breaks it  a ${COVER_PCT}% move through the band takes it out of range (fees stop, the seat now holds the base token); a ${limits.stopLossPct}% drop force-closes it. Yesterday's moves: ${open.map((s) => `${s.pool.baseSymbol} ${fmtPct(s.pool.priceChange24hPct, 0)}`).join(", ")}`);
  console.log(`  worst case      each band is force-closed by the guards at -${limits.stopLossPct}%: ${fmtUsd((deployedUsd * limits.stopLossPct) / 100)} across all ${open.length} if every pool falls through its band at once`);
  console.log(`  the LLM         not consulted: this script proposes the bands; with ANTHROPIC_API_KEY set the loop would let ${config.agentName} choose among them`);
  console.log("=".repeat(96));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
