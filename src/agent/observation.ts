import { quoteOf, type PoolSnapshot, type PositionSnapshot } from "../tools/dlmm";
import type { PoolAnalytics } from "../tools/lpagent";

export interface ScreenContext {
  rank: number;
  rankedPools: number;
  score: number;
  feeToTvl24hPct: number | null;
  volume24hUsd: number | null;
  tvlUsd: number | null;
  ageHours: number | null;
  priceChange24hPct: number | null;
  flags: string[];
  /** the operator put this token on the watchlist: their judgement stands in for the screener's score */
  watchlisted?: boolean;
  /**
   * The LAUNCH LANE admitted this pool (src/screener/launch.ts): too new for the board, the score or
   * a hand-written list, but already carrying real two-sided flow. Present and ok means the desk may
   * take it under harsher terms (a capped seat, a tighter stop, a maximum hold, a volume-fade exit);
   * null or absent means the ordinary rules apply.
   */
  launch?: { ok: true; ageHours: number; turnover: number } | null;
  /** how far the price travelled in the last hour, high to low, in percent: what the band must survive */
  recentMovePct?: number | null;
  generatedAt: string;
  /** the screen's stock tag when the base is a tokenized stock (the stock book's pools) */
  stock?: { ticker: string; issuer: string } | null;
  alternatives: { name: string; score: number; feeToTvl24hPct: number | null; tvlUsd: number | null }[];
  /** the fast watch's surges (src/hot): what printed fees in the last hour, across every venue */
  hot?: {
    name: string;
    venue: string;
    tradable: boolean;
    thisPool: boolean;
    liquidityUsd: number | null;
    vol1hUsd: number | null;
    feeToTvlDailyPct: number | null;
    acceleration: number | null;
    priceChange1hPct: number | null;
    heat: number;
    flags: string[];
    surge: boolean;
  }[];
}

export interface PortfolioContext {
  activePools: string[];
  poolsWithBands: number;
  maxActivePools: number;
  otherExposureSol: number;
}

export interface JournalGlimpse {
  ts: string;
  action: string;
  allowed: boolean;
  headline: string;
  violations: string[];
}

/** What the engine (src/engine) has decided about this pool this cycle, as the LLM should see it. */
export interface EngineObservation {
  halt: { until: number; stage: number | null; reason: string | null } | null;
  standDown: { until: number; reason: string | null } | null;
  bench: { stops6h: number; multiplier: number; benched: boolean; reason: string | null };
  regime: { medianMove24hPct: number | null; multiplier: number; reason: string | null };
  sizeMultiplier: number;
  effectiveMaxPositionSol: number;
  /** position -> stop percent for this band */
  stops: Record<string, number>;
  /** position -> seconds out of range so far */
  outOfRangeSec: Record<string, number>;
  minOutOfRangeSec: number;
  knife: string | null;
  collectsToday: number;
  collectMaxPerDay: number;
  /** stock pools only: the US session clock and the gap between the pool and Backpack's perp */
  basis?: {
    session: "closed" | "pre" | "regular" | "after";
    minutesToOpen: number;
    basisPct: number | null;
    perpSymbol: string | null;
    perpMid: number | null;
    widthMultiplier: number;
    reason: string | null;
  };
}

/** Everything Mr Bands gets to see for one decision. */
export interface Observation {
  ts: string;
  cycle: number;
  mode: "dry-run" | "live";
  poolLabel: string;
  snapshot: PoolSnapshot;
  positions: PositionSnapshot[];
  /** quote / quoteSymbol: the wallet's balance of the pool's quote token (absent or = sol for a SOL pool) */
  wallet: { address: string; sol: number; token: number; tokenSymbol: string; quote?: number; quoteSymbol?: string };
  analytics: PoolAnalytics | null;
  state: { actionsToday: number; lastActionAt: number | null; lastMoveAt?: number | null; lastPrice: number | null; killSwitch: boolean };
  recent: JournalGlimpse[];
  screen: ScreenContext | null;
  portfolio: PortfolioContext;
  engine: EngineObservation | null;
}

const r = (n: number | null | undefined, digits = 4) =>
  n === null || n === undefined || !Number.isFinite(n) ? "n/a" : Number(n.toFixed(digits)).toString();
const usdShort = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? "n/a" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`;
const sig = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? "n/a" : n.toPrecision(6);

export function formatObservation(o: Observation): string {
  const s = o.snapshot;
  const q = quoteOf(s);
  const quoteIsSol = q.symbol === "SOL";
  /** a SOL-equivalent figure with its quote figure beside it in a USDC pool; the plain SOL figure in a SOL pool */
  const solAndQuote = (sol: number, digits = 4) => (quoteIsSol ? `${r(sol, digits)} SOL` : `${r(sol, digits)} SOL (${r(sol / q.priceInSol, 2)} ${q.symbol})`);
  const lines: string[] = [];
  lines.push(`# Observation ${o.ts} (cycle ${o.cycle}, mode ${o.mode})`);
  lines.push("");
  lines.push(`## Pool ${s.label} (${s.address})`);
  lines.push(`- token X: ${s.tokenX.symbol} (${s.tokenX.decimals} dec), reserve ${r(s.tokenX.reserve, 2)}`);
  lines.push(`- token Y: ${s.tokenY.symbol} (${s.tokenY.decimals} dec), reserve ${r(s.tokenY.reserve, 2)}`);
  lines.push(`- SOL is token ${s.solSide ?? "neither"}; base token is ${s.baseToken.symbol}`);
  lines.push(
    `- QUOTE token is ${q.symbol} (token ${q.side}): in this pool SOL_ONLY means ${q.symbol}-only and amountSol is an amount of ${q.symbol}. ` +
      `A ${q.symbol}-only band sits ${q.side === "Y" ? "at/below" : "at/above"} the active bin; a ${s.baseToken.symbol}-only band ${q.side === "Y" ? "at/above" : "at/below"} it.`,
  );
  if (!quoteIsSol) {
    lines.push(`- SOL price: ${s.solPriceUsd ? `$${r(s.solPriceUsd, 2)}` : "n/a"} -> 1 ${q.symbol} = ${r(q.priceInSol, 6)} SOL; ${s.baseToken.symbol} = ${sig(q.tokenPriceInQuote)} ${q.symbol} = ${sig(s.tokenPriceInSol)} SOL`);
  } else if (s.solPriceUsd) {
    lines.push(`- SOL price: $${r(s.solPriceUsd, 2)}`);
  }
  lines.push(`- venue: ${s.venue ?? "meteora-dlmm"}${s.priceModel === "clmm" ? " (CLMM: one bin = one tick-spacing step; a single-sided band sits strictly to one side of the price, so it excludes the active bin)" : ""}`);
  lines.push(`- bin step: ${s.binStep} bps | active bin: ${s.activeBinId} | price: ${sig(s.activePrice)} ${s.priceLabel}`);
  lines.push(`- fees: base ${r(s.baseFeePct, 3)}% | dynamic now ${r(s.dynamicFeePct, 3)}% | max ${r(s.maxFeePct, 2)}%`);
  lines.push(`- observed depth: ${r(s.liquidityBelowY, 3)} ${s.tokenY.symbol} below active, ${r(s.liquidityAboveX, 2)} ${s.tokenX.symbol} above`);
  if (o.state.lastPrice) {
    const move = (s.activePrice / o.state.lastPrice - 1) * 100;
    lines.push(`- price change since last cycle: ${move >= 0 ? "+" : ""}${r(move, 2)}%`);
  }
  lines.push("");
  lines.push("## Bins around active (binId | price | X | Y)");
  for (const b of s.bins) {
    lines.push(`${b.isActive ? ">" : " "} ${b.binId} | ${sig(b.price)} | ${r(b.xAmount, 2)} | ${r(b.yAmount, 4)}${b.isActive ? "  <- ACTIVE" : ""}`);
  }
  lines.push("");
  lines.push("## External analytics");
  if (o.analytics) {
    const a = o.analytics;
    lines.push(`- source: ${a.source} (${a.note})`);
    lines.push(`- price USD: ${sig(a.priceUsd)} | 24h change: ${r(a.priceChange24hPct, 2)}%`);
    lines.push(`- 24h volume: $${r(a.volume24hUsd, 0)} | TVL: $${r(a.tvlUsd, 0)} | est. 24h fees: $${r(a.fees24hUsd, 0)} | fee/TVL 24h: ${r(a.feeToTvl24hPct, 3)}%`);
    lines.push(`- 24h txns: ${a.txns24h ?? "n/a"}`);
  } else {
    lines.push("- unavailable this cycle");
  }
  lines.push("");
  lines.push(`## Wallet ${o.wallet.address}`);
  const walletQuote = o.wallet.quote ?? (quoteIsSol ? o.wallet.sol : undefined);
  lines.push(
    `- ${r(o.wallet.sol, 4)} SOL${quoteIsSol ? " (the quote; rent and fees come out of it too)" : " (rent and fees only)"}` +
      (quoteIsSol ? "" : ` | ${r(walletQuote, 2)} ${q.symbol} (the quote: what a SOL_ONLY band deposits here${walletQuote !== undefined ? `, = ${r(walletQuote * q.priceInSol, 4)} SOL` : ""})`) +
      ` | ${r(o.wallet.token, 2)} ${o.wallet.tokenSymbol}`,
  );
  lines.push("");
  lines.push(`## Open bands (${o.positions.length})`);
  if (o.positions.length === 0) lines.push("- none");
  for (const p of o.positions) {
    lines.push(
      `- ${p.address}: bins [${p.lowerBinId}, ${p.upperBinId}] (${p.widthBins} wide) price [${sig(p.lowerPrice)}, ${sig(p.upperPrice)}] ` +
        `${p.inRange ? "IN RANGE" : `OUT OF RANGE by ${Math.abs(p.binsFromRange)} bins (${p.binsFromRange < 0 ? "price below band" : "price above band"})`} | ` +
        `holds ${r(p.amountX, 2)} ${s.tokenX.symbol} + ${r(p.amountY, 4)} ${s.tokenY.symbol} | unclaimed fees ${r(p.feeX, 2)} ${s.tokenX.symbol} + ${r(p.feeY, 5)} ${s.tokenY.symbol} | value ${solAndQuote(p.valueInSol)}`,
    );
  }
  lines.push("");
  lines.push("## Risk bookkeeping");
  lines.push(`- actions today: ${o.state.actionsToday}`);
  lines.push(`- last action: ${o.state.lastActionAt ? `${Math.round((Date.now() - o.state.lastActionAt) / 60000)} min ago` : "never"}; last band move in THIS pool: ${o.state.lastMoveAt ? `${Math.round((Date.now() - o.state.lastMoveAt) / 60000)} min ago (the cooldown is per pool)` : "never"}`);
  lines.push(`- kill switch: ${o.state.killSwitch ? "ACTIVE (no new exposure)" : "off"}`);
  if (o.screen?.launch?.ok) {
    lines.push(
      `- LAUNCH LANE: this pool is ${r(o.screen.launch.ageHours, 1)}h old and turning over ${r(o.screen.launch.turnover, 1)}x its liquidity a day. It is admitted by rule, not by score or watchlist. ` +
        `A launch seat is capped, stopped tighter, held for a limited time and closed when the volume fades: size it small and do not argue with the exit.`,
    );
  }
  lines.push("");
  if (o.screen?.hot?.length) {
    lines.push("## Hot right now (fees in the last hour, from the fast watch)");
    lines.push("Daily pace = what a dollar in the pool earned in the last hour, times 24. Acceleration = last hour versus the 24h rate.");
    for (const h of o.screen.hot) {
      lines.push(
        `- ${h.thisPool ? "THIS POOL: " : ""}${h.name} on ${h.venue}${h.tradable ? "" : " (not tradable yet)"}: liquidity ${usdShort(h.liquidityUsd)}, vol 1h ${usdShort(h.vol1hUsd)}, daily pace ${r(h.feeToTvlDailyPct, 2)}%, acceleration ${r(h.acceleration, 1)}x, 1h move ${r(h.priceChange1hPct, 1)}%, heat ${r(h.heat, 0)}${h.surge ? ", SURGE" : ""}${h.flags.length ? ` [${h.flags.join(", ")}]` : ""}`,
      );
    }
    lines.push("");
  }
  lines.push("## Engine");
  const e = o.engine;
  if (!e) {
    lines.push("- no engine view this cycle");
  } else {
    const mins = (ms: number) => Math.max(0, Math.round((ms - Date.now()) / 60000));
    lines.push(`- circuit breaker: ${e.halt ? `HALTED (stage ${e.halt.stage ?? "?"}), opens blocked for ${mins(e.halt.until)} more min: ${e.halt.reason ?? ""}` : "clear"}`);
    lines.push(`- portfolio breaker: ${e.standDown ? `STANDING DOWN for ${mins(e.standDown.until)} more min, every band is being closed: ${e.standDown.reason ?? ""}` : "clear"}`);
    lines.push(`- bench: ${e.bench.benched ? "BENCHED, no opens in this pool" : e.bench.stops6h === 0 ? "clear" : `${e.bench.stops6h} stop(s) in 6h, size x${e.bench.multiplier}`}`);
    lines.push(`- board regime: median 24h move ${e.regime.medianMove24hPct === null ? "n/a" : `${r(e.regime.medianMove24hPct, 2)}%`}, size x${e.regime.multiplier}${e.regime.multiplier === 0 ? " (opens off)" : ""}`);
    lines.push(`- size multiplier in force: x${e.sizeMultiplier} -> max band ${solAndQuote(e.effectiveMaxPositionSol)}`);
    lines.push(`- knife: ${e.knife ?? "clear"}`);
    lines.push(`- fee claims today: ${e.collectsToday}/${e.collectMaxPerDay} (the engine claims on its own schedule)`);
    lines.push(`- minimum out-of-range time before you may REBALANCE/CLOSE an out-of-range band: ${e.minOutOfRangeSec}s`);
    if (e.basis) {
      const b = e.basis;
      lines.push(`- tokenized stock: US market ${b.session}${b.session === "closed" || b.session === "pre" ? ` (${b.minutesToOpen} min to the open)` : ""}; use x${b.widthMultiplier} the band width you would use in regular hours`);
      lines.push(`- basis vs Backpack ${b.perpSymbol ?? "(no perp listed)"}: ${b.basisPct === null ? "n/a" : `${b.basisPct >= 0 ? "+" : ""}${r(b.basisPct, 2)}% (pool above the perp means arbitrage flow will sell into a bid band)`}${b.perpMid !== null ? `, perp mid ${b.perpMid}` : ""}`);
      if (b.reason) lines.push(`- basis rule: ${b.reason} (opens are refused this cycle)`);
    }
    for (const p of o.positions) {
      const stop = e.stops[p.address];
      const oor = e.outOfRangeSec[p.address] ?? 0;
      lines.push(`- band ${p.address.slice(0, 6)}: stop ${stop === undefined ? "n/a" : `-${r(stop, 2)}%`} (the engine closes it there) | out of range ${p.inRange ? "0s" : `${Math.round(oor)}s`}${!p.inRange && oor < e.minOutOfRangeSec ? " (below the minimum: moving it now is churn)" : ""}`);
    }
  }
  lines.push("");
  lines.push("## Your recent decisions (newest first)");
  if (o.recent.length === 0) lines.push("- none yet");
  for (const g of o.recent) {
    lines.push(`- ${g.ts} ${g.action} ${g.allowed ? "ok" : `BLOCKED: ${g.violations.join("; ")}`} - "${g.headline}"`);
  }
  return lines.join("\n");
}
