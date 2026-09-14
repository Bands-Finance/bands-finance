/**
 * The chain, driven: a price that walks across bins, and the real policy, guards, engine and paper
 * executor deciding every step. The unit tests prove each piece in isolation; this proves they work
 * together, and in particular that a band which falls out of range is actually re-centred.
 *
 * No network, no LLM, no files: a synthetic pool, a deterministic random walk, the real modules.
 *   npm run test:sim
 */
process.env.POLICY_MIN_SEAT_YIELD_PCT = "0";
process.env.POLICY_MAX_PAYBACK_HOURS = "0";
process.env.POLICY_MIN_VOLUME_24H_USD = "0";

import assert from "node:assert/strict";
import { policyDecide } from "../agent/policy";
import type { Observation } from "../agent/observation";
import { evaluate, NO_ENGINE, type GuardContext } from "../risk/guards";
import type { RiskLimits } from "../risk/limits";
import { emptyState, type RiskState } from "../risk/state";
import { antiChurn, moveAfterSec, outOfRangeSec, rollStop, trackOutOfRange } from "../engine/exit";
import { emptyBook, poolsWithBands, type PaperBook } from "../paper/book";
import { executePaper } from "../paper/executor";
import { bookEquitySol, markPool } from "../paper/mark";
import { binPriceUi, type PoolSnapshot } from "../tools/dlmm";

let n = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    n++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}\n     ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

const POOL = "SimPooL1111111111111111111111111111111111111";
const TOKEN = "SimToken111111111111111111111111111111111111";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const BIN_STEP = 20;
const SOL_USD = 100;
const price = (bin: number) => binPriceUi(bin, BIN_STEP, 6, 9);

const limits: RiskLimits = {
  maxPositionSol: 22.5,
  maxTotalExposureSol: 90,
  gasReserveSol: 1,
  stopLossPct: 15,
  maxBinWidth: 69,
  maxTxPerDay: 1000,
  minSecondsBetweenActions: 0,
  maxSlippagePct: 1,
  maxPriceMovePctPerCycle: 100,
};

/** A pool deep enough that our seat is a real share of a bin but never the whole of it. */
function snapAt(active: number, now: number): PoolSnapshot {
  const bins = [];
  for (let b = active - 12; b <= active + 12; b++) {
    bins.push({ binId: b, price: price(b), xAmount: b > active ? 4000 : b === active ? 2000 : 0, yAmount: b < active ? 7 : b === active ? 3.5 : 0, isActive: b === active });
  }
  return {
    address: POOL,
    label: "SIM/SOL",
    tokenX: { mint: TOKEN, symbol: "SIM", decimals: 6, reserve: 5_000_000 },
    tokenY: { mint: SOL_MINT, symbol: "SOL", decimals: 9, reserve: 5000 },
    solSide: "Y",
    baseToken: { mint: TOKEN, symbol: "SIM", decimals: 6, reserve: 5_000_000 },
    binStep: BIN_STEP,
    activeBinId: active,
    activePrice: price(active),
    priceLabel: "SOL per SIM",
    tokenPriceInSol: price(active),
    quoteSide: "Y",
    quoteToken: { mint: SOL_MINT, symbol: "SOL", decimals: 9, reserve: 5000 },
    quoteSymbol: "SOL",
    quotePriceInSol: 1,
    tokenPriceInQuote: price(active),
    solPriceUsd: SOL_USD,
    baseFeePct: 0.2,
    maxFeePct: 10,
    dynamicFeePct: 0.2,
    bins,
    liquidityBelowY: 84,
    liquidityAboveX: 48_000,
    fetchedAt: new Date(now).toISOString(),
  };
}

function observation(s: PoolSnapshot, book: PaperBook, positions: ReturnType<typeof markPool>, state: RiskState, now: number, moveSec: number, recentMovePct: number): Observation {
  return {
    ts: new Date(now).toISOString(),
    cycle: 1,
    mode: "dry-run",
    poolLabel: s.label,
    snapshot: s,
    positions,
    wallet: { address: "sim", sol: book.wallet.sol, token: book.wallet.tokens[TOKEN] ?? 0, tokenSymbol: "SIM", quote: book.wallet.sol, quoteSymbol: "SOL" },
    analytics: null,
    state: { actionsToday: state.actionsToday, lastActionAt: state.lastActionAt, lastMoveAt: state.lastMoveByPool?.[POOL] ?? null, lastPrice: state.lastPrice, killSwitch: false },
    recent: [],
    screen: {
      rank: 1,
      rankedPools: 400,
      score: 40,
      feeToTvl24hPct: 2,
      volume24hUsd: 5_000_000,
      tvlUsd: 400_000,
      ageHours: 900,
      priceChange24hPct: 1,
      flags: [],
      recentMovePct,
      generatedAt: new Date(now).toISOString(),
      alternatives: [],
    },
    portfolio: { activePools: [s.label], poolsWithBands: positions.length > 0 ? 1 : 0, maxActivePools: 4, otherExposureSol: 0 },
    engine: {
      halt: null,
      standDown: null,
      bench: { stops6h: 0, multiplier: 1, benched: false, reason: null },
      regime: { medianMove24hPct: 0, multiplier: 1, reason: null },
      sizeMultiplier: 1,
      effectiveMaxPositionSol: limits.maxPositionSol,
      stops: state.stops ?? {},
      outOfRangeSec: Object.fromEntries(positions.map((p) => [p.address, outOfRangeSec(state.outOfRangeSince, p.address, now)])),
      minOutOfRangeSec: moveSec,
      knife: null,
      collectsToday: 0,
      collectMaxPerDay: 30,
    },
  };
}

/** One full cycle: mark, decide, judge, execute. Returns what the desk did. */
function cycle(book: PaperBook, s: PoolSnapshot, state: RiskState, now: number, moveSec: number, recentMovePct: number): { action: string; allowed: boolean; reason: string; violations: string[] } {
  const positions = markPool(book, s, { now, fees: { fees24hUsd: 8000, volume24hUsd: 5_000_000 }, solPriceUsd: SOL_USD });
  trackOutOfRange(state, positions, now);
  for (const p of positions) if (!(p.address in (state.entryValueSol ?? {}))) state.entryValueSol[p.address] = p.valueInSol;
  const o = observation(s, book, positions, state, now, moveSec, recentMovePct);
  const { decision, reason } = policyDecide(o, { limits, now, openCostSol: 0.0085, openCostRefundableSol: 0.006675 });
  const ctx: GuardContext = {
    now,
    snapshot: s,
    positions,
    walletSol: book.wallet.sol,
    walletToken: book.wallet.tokens[TOKEN] ?? 0,
    walletQuote: book.wallet.sol,
    state,
    killSwitch: false,
    otherExposureSol: 0,
    poolsWithBands: 0,
    maxActivePools: 4,
    engine: { ...NO_ENGINE, outOfRangeSince: state.outOfRangeSince ?? {}, stops: state.stops ?? {}, outOfRangeSec: moveSec },
    source: "llm",
    openCostSol: 0.0085,
  };
  const verdict = evaluate(decision, ctx, limits);
  const exec = executePaper(verdict, { book, snapshot: s, positions, slippagePct: 0.3, now, openCost: { total: 0.0085, refundable: 0.006675 } });
  if (exec.txs.length > 0) {
    state.actionsToday += 1;
    state.lastActionAt = now;
    if (exec.opened || exec.closed) (state.lastMoveByPool ??= {})[POOL] = now;
  }
  if (exec.ok && exec.opened) {
    state.entryValueSol[exec.opened.address] = exec.opened.entryValueSol;
    (state.stops ??= {})[exec.opened.address] = rollStop(limits, () => 0.5);
  }
  if (exec.ok && exec.closed) delete state.entryValueSol[exec.closed];
  return { action: verdict.decision.action, allowed: verdict.allowed, reason, violations: verdict.violations };
}

/** A deterministic walk: no Math.random, so a failure here is reproducible. */
function walk(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

test("a price that walks across bins gets the band re-centred, repeatedly, and the book stays consistent", () => {
  const book = emptyBook(100, 0);
  const state: RiskState = emptyState();
  const rnd = walk(42);
  let active = 1000;
  let now = 1_700_000_000_000;
  const CYCLE_MS = 120_000;
  const counts: Record<string, number> = {};
  const bandLives: number[] = [];
  let openedAt = 0;
  let maxOutOfRangeSec = 0;

  for (let i = 0; i < 120; i++) {
    const s = snapAt(active, now);
    // the move threshold the loop would compute: cheap venue, a pool paying real fees
    const moveSec = moveAfterSec(0.0085 * SOL_USD * 0.21, 8000 * 0.05, 60);
    const r = cycle(book, s, state, now, moveSec, 1.2);
    counts[r.action] = (counts[r.action] ?? 0) + 1;
    if (r.action === "OPEN_POSITION") openedAt = now;
    if (r.action === "REBALANCE") {
      if (openedAt) bandLives.push((now - openedAt) / 60000);
      openedAt = now;
    }
    // every band is either in range or waiting out its threshold, never abandoned
    for (const b of book.bands) {
      const sec = outOfRangeSec(state.outOfRangeSince, b.address, now);
      maxOutOfRangeSec = Math.max(maxOutOfRangeSec, sec);
    }
    // the wallet never goes negative and the book's identity holds every step
    assert.ok(book.wallet.sol >= 0, `cycle ${i}: wallet went negative (${book.wallet.sol})`);
    const eq = bookEquitySol(book).equitySol;
    assert.ok(Number.isFinite(eq) && eq > 0, `cycle ${i}: equity is ${eq}`);

    // walk the price: mostly one bin, sometimes three
    const step = rnd() < 0.15 ? 3 : 1;
    active += rnd() < 0.5 ? -step : step;
    now += CYCLE_MS;
  }

  assert.ok((counts.REBALANCE ?? 0) >= 3, `expected the band to be re-centred repeatedly, got ${counts.REBALANCE ?? 0} rebalance(s) in 120 cycles: ${JSON.stringify(counts)}`);
  assert.ok((counts.OPEN_POSITION ?? 0) >= 1, "the desk opened a band");
  assert.equal(poolsWithBands(book).length, 1, "the desk ends holding exactly one band in the pool");
  assert.ok(maxOutOfRangeSec <= 3600, `a band sat out of range for ${Math.round(maxOutOfRangeSec / 60)} min without being moved`);
  assert.ok(book.slippagePaidSol >= 0 && book.rentSpentSol > 0, "moves cost rent");
  // The book is denominated in SOL: an exit must not leave the capital stranded in the base token.
  const strandedTokenSol = (book.wallet.tokens[TOKEN] ?? 0) * price(active);
  assert.ok(strandedTokenSol < 1, `the desk ended holding ${strandedTokenSol.toFixed(2)} SOL of ${"SIM"} in the wallet: a close must sell it back`);
  const avgLife = bandLives.reduce((a, b) => a + b, 0) / Math.max(1, bandLives.length);
  console.log(`     ${counts.REBALANCE ?? 0} rebalances, ${counts.OPEN_POSITION ?? 0} opens, ${counts.HOLD ?? 0} holds over 120 cycles (4h of 2-minute ticks)`);
  console.log(`     a band lived ${avgLife.toFixed(1)} min on average before the price walked out of it; longest wait out of range ${Math.round(maxOutOfRangeSec / 60)} min`);
  console.log(`     fees claimed ${book.feesClaimedSol.toFixed(6)} SOL, rent spent ${book.rentSpentSol.toFixed(4)} SOL, equity ${bookEquitySol(book).equitySol.toFixed(4)} SOL`);
});

test("a band that never leaves its range is never moved: no churn when the price sits still", () => {
  const book = emptyBook(100, 0);
  const state: RiskState = emptyState();
  let now = 1_700_000_000_000;
  const counts: Record<string, number> = {};
  for (let i = 0; i < 40; i++) {
    const r = cycle(book, snapAt(1000, now), state, now, 60, 1.2);
    counts[r.action] = (counts[r.action] ?? 0) + 1;
    now += 120_000;
  }
  assert.equal(counts.REBALANCE ?? 0, 0, "a still price must not produce a single move");
  assert.equal(counts.OPEN_POSITION ?? 0, 1, "one open, then holds");
  assert.ok((counts.HOLD ?? 0) >= 35, `expected holds, got ${JSON.stringify(counts)}`);
});

test("the move threshold is what gates it: a slow threshold holds the band, a fast one moves it", () => {
  const run = (moveSec: number) => {
    const book = emptyBook(100, 0);
    const state: RiskState = emptyState();
    let now = 1_700_000_000_000;
    let rebalances = 0;
    let active = 1000;
    for (let i = 0; i < 30; i++) {
      const r = cycle(book, snapAt(active, now), state, now, moveSec, 1.2);
      if (r.action === "REBALANCE") rebalances += 1;
      if (i === 0) active += 8; // straight out of the band on the second cycle, and it stays out
      now += 120_000;
    }
    return rebalances;
  };
  const fast = run(60);
  const slow = run(3600);
  assert.ok(fast >= 1, `a 60s threshold should re-centre an out-of-range band within 30 cycles, got ${fast}`);
  assert.equal(slow, 0, `a 60 minute threshold should hold it for the hour, got ${slow}`);
});

console.log(`\n${n} simulation tests passed`);
