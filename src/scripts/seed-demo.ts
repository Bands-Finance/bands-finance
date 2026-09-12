/**
 * Seed a realistic demo journal so the dashboard has something to show before the agent
 * has run for hours. Five hours of 5-minute cycles in the ANSEM/SOL pool, dry-run mode.
 *   npm run seed-demo            refuses if data/decisions.jsonl exists
 *   npm run seed-demo -- --force overwrites
 *   npm run seed-demo -- --check only re-runs the consistency check on the existing file
 *
 * Every word in a generated entry is derived from the state written into that same entry
 * (active bin, positions, wallet, analytics), never hand-typed. A consistency pass at the end
 * re-reads the file and throws if any headline, reasoning or tx label disagrees with the numbers.
 */
import fs from "node:fs";
import path from "node:path";
import { appendJournal, dataDir, JournalEntry, JournalPool, renderDerivedFiles } from "../journal";
import { binPriceUi, BinRow, PositionSnapshot } from "../tools/dlmm";
import type { PoolAnalytics } from "../tools/lpagent";
import type { Decision } from "../agent/schema";
import type { ExecutionResult } from "../executor";
import { riskLimits } from "../config";

const POOL = "6e7V9eegCHw997T72MxgwwJipZ6GJyZF8NvjkzT1rvpN";
const WALLET = "BNDSdemo1111111111111111111111111111111111111";
const BIN_STEP = 20;
const X_DEC = 6;
const Y_DEC = 9;
const CYCLE_MS = 5 * 60 * 1000;
const CYCLE_MIN = CYCLE_MS / 60_000;
const RENT_SOL = 0.0574;
/** unclaimed fees below this are "not worth the gas" in Mr Bands' book */
const CLAIM_MIN_SOL = 0.001;
const price = (bin: number) => binPriceUi(bin, BIN_STEP, X_DEC, Y_DEC);

// Active bin path: quiet drift, a leg down that pushes the first band out of range,
// a rebound, a sharp sell-off that trips the stop-loss on the second band, then a base
// that the third band is laid into and stays inside through the last print.
const PATH = [
  262, 262, 261, 262, 263, 262, 261, 260, 260, 259, 260, 261, 260, 259, 258, 258, 257, 256, 256, 255,
  254, 253, 251, 250, 248, 246, 245, 243, 241, 239, 238, 239, 240, 241, 241, 240, 239, 239, 238, 236,
  230, 221, 208, 192, 172, 138, 141, 144, 146, 147, 146, 148, 150, 151, 150, 152, 153, 152, 151, 152,
];

interface Band {
  address: string;
  lower: number;
  upper: number;
  sol: number; // SOL deposited
  entryTs: number;
  feesSol: number;
  inRangeCycles: number;
}

let wallet = { sol: 1.0, token: 0 };
const bands: Band[] = [];
let feesRealized = 0;

function bandSnapshot(b: Band, active: number): PositionSnapshot {
  const width = b.upper - b.lower + 1;
  const perBin = b.sol / width;
  let amountY = 0;
  let amountX = 0;
  for (let bin = b.lower; bin <= b.upper; bin++) {
    if (bin <= active) amountY += perBin;
    else amountX += perBin / price(bin); // converted to ANSEM when price fell through this bin
  }
  const p = price(active);
  const feeY = b.feesSol * 0.55;
  const feeX = (b.feesSol * 0.45) / p;
  const inRange = active >= b.lower && active <= b.upper;
  return {
    address: b.address,
    lowerBinId: b.lower,
    upperBinId: b.upper,
    lowerPrice: price(b.lower),
    upperPrice: price(b.upper),
    widthBins: width,
    inRange,
    binsFromRange: inRange ? 0 : active < b.lower ? active - b.lower : active - b.upper,
    amountX,
    amountY,
    feeX,
    feeY,
    valueInSol: amountY + amountX * p + b.feesSol,
    solInPosition: amountY + feeY,
    lastUpdatedAt: Math.floor(b.entryTs / 1000),
    entryValueSol: b.sol,
  };
}

function bins(active: number): BinRow[] {
  const rows: BinRow[] = [];
  for (let bin = active - 10; bin <= active + 10; bin++) {
    const depth = 28 + 4 * Math.sin(bin * 1.7);
    rows.push({
      binId: bin,
      price: price(bin),
      xAmount: bin > active ? depth * 600 : bin === active ? 16800 : 0,
      yAmount: bin < active ? depth : bin === active ? 1.4 : 0,
      isActive: bin === active,
    });
  }
  return rows;
}

function pool(active: number): JournalPool {
  return {
    address: POOL,
    label: "ANSEM/SOL",
    tokenX: { symbol: "ANSEM", decimals: X_DEC },
    tokenY: { symbol: "SOL", decimals: Y_DEC },
    solSide: "Y",
    binStep: BIN_STEP,
    activeBinId: active,
    price: price(active),
    priceLabel: "SOL per ANSEM",
    tokenPriceInSol: price(active),
    baseFeePct: 0.2,
    dynamicFeePct: 0.2 + Math.abs(active - 250) * 0.004,
    bins: bins(active),
  };
}

function analytics(active: number): PoolAnalytics {
  const volume = 5_150_000 - Math.abs(250 - active) * 12_000;
  const tvl = 1_470_000;
  const fees = volume * 0.002;
  return {
    source: "geckoterminal",
    priceUsd: price(active) * 101,
    volume24hUsd: volume,
    tvlUsd: tvl,
    fees24hUsd: fees,
    feeToTvl24hPct: (fees * 100) / tvl,
    priceChange24hPct: (price(active) / price(PATH[0]) - 1) * 100 - 7,
    txns24h: 10_462,
    note: "fees24h estimated as volume x base fee",
  };
}

// ---- formatting helpers (all text is built from numbers through these) ----
const sol4 = (n: number) => n.toFixed(4);
const pct1 = (n: number) => n.toFixed(1);
const pct2 = (n: number) => n.toFixed(2);
const signed = (n: number) => `${n >= 0 ? "+" : ""}${pct1(n)}%`;
const nBins = (n: number) => `${n} bin${n === 1 ? "" : "s"}`;
const usdM = (n: number) => `$${(n / 1e6).toFixed(1)}M`;
const feesOf = (p: PositionSnapshot, priceNow: number) => p.feeY + p.feeX * priceNow;
const entryOf = (p: PositionSnapshot) => p.entryValueSol ?? p.valueInSol;
const pnlOf = (p: PositionSnapshot) => (p.valueInSol / entryOf(p) - 1) * 100;
const bandRange = (p: PositionSnapshot) => `${p.lowerBinId}-${p.upperBinId}`;

const hold = (reasoning: string, headline: string, confidence = 0.8): Decision => ({
  action: "HOLD",
  open: null,
  positionAddress: null,
  reasoning,
  confidence,
  headline,
});

/** What the agent observes this cycle, before it acts. Everything in the text comes from here. */
interface Ctx {
  cycle: number;
  i: number;
  active: number;
  prev: number | null;
  /** bins moved since last cycle (0 on the first) */
  delta: number;
  ts: number;
  positions: PositionSnapshot[];
  /** the same bands as seen last cycle (to say "back in range" truthfully) */
  prevPositions: PositionSnapshot[];
  wallet: { sol: number; token: number };
  pool: JournalPool;
  analytics: PoolAnalytics;
  actionsToday: number;
}

interface Step {
  decision: Decision;
  /** what the model proposed when it differs from the decision (blocked or overridden) */
  proposal?: Decision;
  violations?: string[];
  overrides?: string[];
  emergency?: boolean;
  /** address of the band this step opens */
  opened?: string;
  apply?: (c: Ctx) => void;
}
type StepFn = (c: Ctx) => Step;

function openBand(addr: string, sol: number, below: number, active: number, ts: number) {
  bands.push({ address: addr, lower: active - below, upper: active, sol, entryTs: ts, feesSol: 0, inRangeCycles: 0 });
  wallet.sol -= sol + RENT_SOL;
}
function closeBand(addr: string, active: number) {
  const i = bands.findIndex((b) => b.address === addr);
  if (i < 0) return;
  const snap = bandSnapshot(bands[i], active);
  wallet.sol += snap.amountY + snap.feeY + RENT_SOL;
  wallet.token += snap.amountX + snap.feeX;
  feesRealized += bands[i].feesSol;
  bands.splice(i, 1);
}

const P1 = "7bandA1xQm9vKZr4TgH2sLp8eWc3nYd6uFj5kRt1oMz2";
const P2 = "9bandB2yRn8wLAs5UhJ3tMq7fXd4oZe7vGk6lSu2pNa3";
const P3 = "4bandC3zSo7xMBt6ViK4uNr8gYe5pAf8wHl7mTv3qOb4";

const openParams = (amountSol: number, binsBelowActive: number): NonNullable<Decision["open"]> => ({
  side: "SOL_ONLY",
  amountSol,
  amountToken: 0,
  binsBelowActive,
  binsAboveActive: 0,
  strategy: "Spot",
});

/** "Price unchanged at bin 262 since last cycle" / "Price 3 bins down to bin 251 since last cycle" */
function moveSentence(c: Ctx): string {
  if (c.prev === null) return `Active bin ${c.active}`;
  if (c.delta === 0) return `Price unchanged at bin ${c.active} since last cycle`;
  return `Price ${nBins(Math.abs(c.delta))} ${c.delta > 0 ? "up" : "down"} to bin ${c.active} since last cycle`;
}

/** Lowest active bin seen so far, and how many cycles ago it printed. */
function lowSoFar(i: number): { low: number; cyclesAgo: number } {
  const seen = PATH.slice(0, i + 1);
  const low = Math.min(...seen);
  return { low, cyclesAgo: i - seen.lastIndexOf(low) };
}

/** Longest trailing stretch of prints whose high-low spread is at most `tol` bins. */
function heldWindow(i: number, tol: number): { lo: number; hi: number; cycles: number } {
  let lo = PATH[i];
  let hi = PATH[i];
  let start = i;
  while (start > 0) {
    const v = PATH[start - 1];
    const nlo = Math.min(lo, v);
    const nhi = Math.max(hi, v);
    if (nhi - nlo > tol) break;
    lo = nlo;
    hi = nhi;
    start -= 1;
  }
  return { lo, hi, cycles: i - start + 1 };
}

// Headline variants rotate per state key so consecutive prints in the same state still read differently.
const picks = new Map<string, number>();
function pick(key: string, variants: string[]): string {
  const n = picks.get(key) ?? 0;
  picks.set(key, n + 1);
  return variants[n % variants.length];
}

/** A HOLD whose every word follows from the observed band state. */
function autoHold(c: Ctx): Decision {
  const p = c.positions[0];
  const n = Math.abs(c.delta);
  const dir = c.delta > 0 ? "up" : "down";
  const move = moveSentence(c);
  const dyn = pct2(c.pool.dynamicFeePct);

  if (!p) {
    const { low } = lowSoFar(c.i);
    const offLow = c.active - low;
    const chg = c.analytics.priceChange24hPct ?? 0;
    const tokenPart = c.wallet.token > 0 ? ` and ${c.wallet.token.toFixed(0)} ANSEM left over from closed bands` : "";
    const tail = c.delta > 0 ? "one print up is a bounce, not a base" : c.delta < 0 ? "sellers still have the tape" : "a flat print is not a base yet";
    const close = pick("flat-close", ["Nothing worth paying rent for.", "Rent is not spent on a guess.", "A base takes more than one print; waiting."]);
    const reasoning = `No band open. ${move}, ${offLow === 0 ? `sitting on the low at ${low}` : `${nBins(offLow)} off the low at ${low}`}; 24h change ${pct1(chg)}%. Wallet holds ${sol4(c.wallet.sol)} SOL${tokenPart}. Dynamic fee ${dyn}% is a volatility premium, and ${tail}. ${close}`;
    const headline =
      c.delta > 0
        ? pick("flat-up", [`Up ${nBins(n)}. Bounce or trap; not paying rent to find out.`, "Waiting on the buyers.", `Bounce to bin ${c.active}. Bands stay pocketed.`])
        : c.delta < 0
          ? pick("flat-down", [`Down ${nBins(n)}. Sellers still in charge. Bands stay pocketed.`, `Down ${nBins(n)}. Not standing in front of that.`])
          : pick("flat-flat", ["Nothing to do. Nothing done.", `Flat at bin ${c.active}. Nothing done.`]);
    return hold(reasoning, headline, 0.75);
  }

  const lo = p.lowerBinId;
  const hi = p.upperBinId;
  const fee = feesOf(p, c.pool.price);
  const feePct = (fee / entryOf(p)) * 100;
  const feeNote =
    fee >= CLAIM_MIN_SOL
      ? `${sol4(fee)} SOL unclaimed (${pct2(feePct)}% of the band); a claim is close`
      : `${sol4(fee)} SOL unclaimed (${pct2(feePct)}% of the band), not worth the gas yet`;
  const was = c.prevPositions.find((x) => x.address === p.address);

  if (p.inRange) {
    const toFloor = c.active - lo;
    const toTop = hi - c.active;
    const where =
      toFloor === 0 ? `sitting on the floor bin ${lo}` : toTop === 0 ? `sitting on the top bin ${hi}` : `${nBins(toFloor)} to the floor at ${lo}, ${nBins(toTop)} to the top at ${hi}`;

    if (was && !was.inRange) {
      const from = was.binsFromRange > 0 ? "above" : "below";
      return hold(
        `${move}, back inside the band ${bandRange(p)} after ${nBins(Math.abs(was.binsFromRange))} ${from} it last print (${where}). In range and earning again: ${feeNote}. Patience paid; no rent spent.`,
        pick("back-in", ["Back in range. Collecting.", "Price came back to the band. Fees ticking again."]),
        0.85,
      );
    }
    if (!was) {
      return hold(
        `${move}. The new band ${bandRange(p)} covers it (${where}), so it is in range from its first print: ${feeNote}. Nothing to do but let it work.`,
        "First print in range. Fees ticking.",
        0.85,
      );
    }
    if (toFloor <= 2) {
      return hold(
        `${move}. The band ${bandRange(p)} still covers it, ${toFloor === 0 ? `sitting on the floor bin ${lo}` : `${nBins(toFloor)} from the floor at ${lo}`}; in range, so still earning. ${feeNote}. Fully out means a rebalance; ${toFloor === 0 ? "on the floor" : `${nBins(toFloor)} away`} is a hold.`,
        toFloor === 0
          ? "On the floor bin. Still in range, not blinking."
          : pick("floor", [`${nBins(toFloor)} of floor left. Nerves are not a signal.`, `${nBins(toFloor)} from the floor. Still in range. Holding.`]),
        0.7,
      );
    }
    if (c.delta === 0) {
      return hold(
        `${move}, inside the band ${bandRange(p)} (${where}). In range and earning: ${feeNote}. Nothing to do but let it work.`,
        pick("in-flat", ["In range. Collecting.", "Quiet tape. Quiet bands.", `Flat at bin ${c.active}. Fees ticking.`]),
      );
    }
    if (n === 1) {
      return hold(
        `${move}, still inside the band ${bandRange(p)} (${where}). ${feeNote}. The right move is no move.`,
        pick("in-one", ["One bin. Bands hold.", `One bin ${dir}. Still in the pocket.`, `One bin ${dir}. Band covers it, fees ticking.`]),
      );
    }
    return hold(
      `${move}, still inside the band ${bandRange(p)} (${where}). ${feeNote}. Band is worth ${sol4(p.valueInSol)} SOL against ${sol4(entryOf(p))} in (${signed(pnlOf(p))}); stop-loss at -${riskLimits.stopLossPct}% has room. Not moving a band on one print.`,
      pick("in-multi", [`${nBins(n)} ${dir}. Band covers it.`, `Moved ${nBins(n)}, still inside. Holding.`, `${nBins(n)} ${dir} and still in range. Bands hold.`]),
    );
  }

  if (p.binsFromRange > 0) {
    const over = p.binsFromRange;
    const feeLine = fee > 0 ? `${sol4(fee)} SOL of earlier fees stay unclaimed and safe.` : "No fees earned yet.";
    return hold(
      `Active bin ${c.active} is ${nBins(over)} above the band's top at ${hi}. Out of range: the band sits in SOL (${sol4(p.amountY)} SOL) and earns nothing up here. ${feeLine} A ${over}-bin gap is not worth ${RENT_SOL.toFixed(2)} SOL of rent to re-lay; it comes back or I move it.`,
      pick("above", [`${nBins(over)} over the top of the band. Idle, not worried.`, `Drifted ${nBins(over)} above the band. Watching.`, `Price ${nBins(over)} above the band. Rent says wait.`]),
      0.75,
    );
  }

  const under = -p.binsFromRange;
  const pnl = pnlOf(p);
  if (under <= 3) {
    return hold(
      `Active bin ${c.active} is ${nBins(under)} under the band's floor at ${lo}. Out of range: the band is fully converted to ANSEM (${p.amountX.toFixed(0)} ANSEM, ${sol4(p.valueInSol)} SOL against ${sol4(entryOf(p))} in) and earns nothing down here. ${nBins(under)} of slip is not worth ${RENT_SOL.toFixed(2)} SOL of rent; one more print, then I rebalance if it holds.`,
      pick("below-small", [`Slipped ${nBins(under)} under the floor. Give it one print.`, `${nBins(under)} under the band. Not chasing one print.`]),
      0.7,
    );
  }
  return hold(
    `Active bin ${c.active} is ${nBins(under)} under the band's floor at ${lo}. Out of range and fully converted to ANSEM: worth ${sol4(p.valueInSol)} SOL against ${sol4(entryOf(p))} in, ${signed(pnl)}. Stop-loss at -${riskLimits.stopLossPct}% still has ${pct1(riskLimits.stopLossPct + pnl)} points of room. Rebalancing into a tape that just dropped ${nBins(n)} in one print is buying the knife; holding.`,
    pick("below-big", [
      `${nBins(under)} under the band. ${signed(pnl)}. Not chasing it.`,
      `${nBins(under)} under the floor. Stop-loss at -${riskLimits.stopLossPct}% has room.`,
      `Down ${nBins(n)} in a print. Bands stay put; the guards decide.`,
    ]),
    0.6,
  );
}

const script: Record<number, StepFn> = {
  1: (c) => ({
    decision: hold(
      `First look. Active bin ${c.active} at ${c.pool.price.toPrecision(4)} SOL, ${usdM(c.analytics.volume24hUsd!)} daily volume against ${usdM(c.analytics.tvlUsd!)} TVL, fee/TVL 24h ${pct2(c.analytics.feeToTvl24hPct!)}%. Dynamic fee ${pct2(c.pool.dynamicFeePct)}% with depth on both sides of the active bin. I want one more print before committing.`,
      "New pool, new me. Watching the tape first.",
      0.7,
    ),
  }),
  2: (c) => ({
    decision: hold(
      `${moveSentence(c)}. Dynamic fee ${pct2(c.pool.dynamicFeePct)}%, fee/TVL 24h ${pct2(c.analytics.feeToTvl24hPct!)}%, depth still on both sides of the ladder. Conditions are right for a bid band next cycle if nothing changes.`,
      "Flat tape, fat fees. Warming up the bands.",
      0.75,
    ),
  }),
  3: (c) => {
    const open = openParams(0.25, 19);
    const lo = c.active - open.binsBelowActive;
    const width = open.binsBelowActive + 1;
    const drop = (1 - price(lo) / price(c.active)) * 100;
    return {
      decision: {
        action: "OPEN_POSITION",
        open,
        positionAddress: null,
        reasoning: `Volume ${usdM(c.analytics.volume24hUsd!)} against ${usdM(c.analytics.tvlUsd!)} TVL gives ${pct2(c.analytics.feeToTvl24hPct!)}% fee/TVL a day. A ${width}-bin SOL band from bin ${lo} to ${c.active} covers a ${pct1(drop)}% drop, catches the bid-side flow, and ${open.amountSol} SOL stays inside the ${riskLimits.maxPositionSol} SOL cap. ${Math.round((open.amountSol / riskLimits.maxPositionSol) * 100)}% of the max, as a first band.`,
        confidence: 0.82,
        headline: `${width} bins under the bid. Let them come to me.`,
      },
      opened: P1,
      apply: (cc) => openBand(P1, open.amountSol, open.binsBelowActive, cc.active, cc.ts),
    };
  },
  12: (c) => {
    const p = c.positions.find((x) => x.address === P1)!;
    const open = openParams(0.6, 25);
    const violation = `band size ${open.amountSol.toFixed(4)} SOL > max ${riskLimits.maxPositionSol}`;
    const fee = feesOf(p, c.pool.price);
    const mins = Math.round((c.ts - p.lastUpdatedAt * 1000) / 60_000);
    return {
      decision: hold(`Blocked by risk guards: ${violation}`, "Guards said no. Holding."),
      proposal: {
        action: "OPEN_POSITION",
        open,
        positionAddress: null,
        reasoning: `Fees are strong and price is holding inside the band ${bandRange(p)}: ${sol4(fee)} SOL unclaimed after ${mins} minutes. A second, larger band from bin ${c.active - open.binsBelowActive} to ${c.active} with ${open.amountSol} SOL would more than double the fee capture.`,
        confidence: 0.7,
        headline: "Doubling down under the bid.",
      },
      violations: [violation],
    };
  },
  20: (c) => {
    const p = c.positions.find((x) => x.address === P1)!;
    const b = bands.find((x) => x.address === P1)!;
    const fee = feesOf(p, c.pool.price);
    const feePct = (fee / entryOf(p)) * 100;
    const mins = Math.round((c.ts - b.entryTs) / 60_000);
    const high = Math.max(...PATH.slice(0, c.i + 1));
    return {
      decision: {
        action: "CLAIM_FEES",
        open: null,
        positionAddress: P1,
        reasoning: `Unclaimed fees on the first band are ${sol4(fee)} SOL, ${pct2(feePct)}% of the ${sol4(entryOf(p))} SOL in it, after ${mins} minutes in the pool and ${b.inRangeCycles} prints in range. That clears the claim gas many times over. Price is ${nBins(c.active - p.lowerBinId)} off the floor at ${p.lowerBinId} and has drifted ${nBins(high - c.active)} down from its high at ${high}; claiming now locks the stack in before the drift continues.`,
        confidence: 0.85,
        headline: `First stack claimed. ${pct2(feePct)}% in ${mins} minutes.`,
      },
      apply: () => {
        wallet.sol += b.feesSol;
        feesRealized += b.feesSol;
        b.feesSol = 0;
      },
    };
  },
  30: (c) => {
    const p = c.positions.find((x) => x.address === P1)!;
    const open = openParams(0.3, 19);
    return {
      decision: {
        action: "REBALANCE",
        open,
        positionAddress: P1,
        reasoning: `Active bin ${c.active} is ${nBins(-p.binsFromRange)} under the band's floor at ${p.lowerBinId}. The band is fully converted to ANSEM (${p.amountX.toFixed(0)} ANSEM, ${sol4(p.valueInSol)} SOL against ${sol4(entryOf(p))} in) and earning nothing. Volume is still ${usdM(c.analytics.volume24hUsd!)} and fee/TVL ${pct2(c.analytics.feeToTvl24hPct!)}% holds, so the pool is worth being in. Close, and re-lay ${open.amountSol} SOL from bin ${c.active - open.binsBelowActive} to ${c.active}.`,
        confidence: 0.78,
        headline: "Price walked out the bottom. Moving the bands down to meet it.",
      },
      opened: P2,
      apply: (cc) => {
        closeBand(P1, cc.active);
        openBand(P2, open.amountSol, open.binsBelowActive, cc.active, cc.ts);
      },
    };
  },
  46: (c) => {
    const p = c.positions.find((x) => x.address === P2)!;
    const entry = entryOf(p);
    const dd = (1 - p.valueInSol / entry) * 100;
    if (dd < riskLimits.stopLossPct) throw new Error(`cycle 46: drawdown ${pct1(dd)}% does not trip the ${riskLimits.stopLossPct}% stop-loss; adjust PATH`);
    return {
      decision: {
        action: "CLOSE_POSITION",
        open: null,
        positionAddress: P2,
        reasoning: `Stop-loss triggered by risk guards at -${pct1(dd)}% (limit -${riskLimits.stopLossPct}%). Model proposal (HOLD) overridden.`,
        confidence: 1,
        headline: "Stop-loss hit. Bands off the table.",
      },
      proposal: hold(
        `Band two is fully converted to ANSEM after the sell-off; active bin ${c.active} is ${nBins(-p.binsFromRange)} below its floor at ${p.lowerBinId} and the band is worth ${sol4(p.valueInSol)} SOL against ${sol4(entry)} in. Waiting for a bounce before rebalancing.`,
        "Holding through the dip.",
        0.55,
      ),
      overrides: [`stop-loss: ${P2.slice(0, 6)} is ${pct1(dd)}% below entry (${sol4(entry)} -> ${sol4(p.valueInSol)} SOL); forcing CLOSE`],
      emergency: true,
      apply: (cc) => closeBand(P2, cc.active),
    };
  },
  55: (c) => {
    const { low, cyclesAgo } = lowSoFar(c.i);
    return {
      decision: hold(
        `The sell-off bottomed at bin ${low}, ${cyclesAgo} prints ago, and price has crept back to ${c.active}, ${nBins(c.active - low)} off the low but still ${pct1(c.analytics.priceChange24hPct!)}% on the day. Dynamic fee is ${pct2(c.pool.dynamicFeePct)}%: a fat volatility premium, which only pays once the tape turns two-sided. No band open; I hold ${sol4(c.wallet.sol)} SOL and ${c.wallet.token.toFixed(0)} ANSEM from the closed bands. Not laying a band into that yet.`,
        "Dust hasn't settled. Sitting on my hands.",
        0.7,
      ),
    };
  },
  58: (c) => {
    const open = openParams(0.15, 14);
    const lo = c.active - open.binsBelowActive;
    const width = open.binsBelowActive + 1;
    const held = heldWindow(c.i, 8);
    const { low } = lowSoFar(c.i);
    const heldMin = held.cycles * CYCLE_MIN;
    return {
      decision: {
        action: "OPEN_POSITION",
        open,
        positionAddress: null,
        reasoning: `Price has held between bin ${held.lo} and bin ${held.hi} for ${heldMin} minutes after bottoming at ${low}, and volume is still ${usdM(c.analytics.volume24hUsd!)}. A ${width}-bin SOL band from bin ${lo} to ${c.active} puts ${open.amountSol} SOL to work with a short leash: the stop-loss sits ${riskLimits.stopLossPct}% below entry and the daily cap has room (${c.actionsToday} of ${riskLimits.maxTxPerDay} actions used).`,
        confidence: 0.66,
        headline: `Bounce held ${heldMin} minutes. Small band, short leash.`,
      },
      opened: P3,
      apply: (cc) => openBand(P3, open.amountSol, open.binsBelowActive, cc.active, cc.ts),
    };
  },
};

function main(): void {
  const file = path.join(dataDir(), "decisions.jsonl");
  if (process.argv.includes("--check")) {
    checkConsistency(file);
    console.log("consistency: ok");
    return;
  }
  const force = process.argv.includes("--force");
  if (fs.existsSync(file) && !force) {
    console.error(`${file} exists. Use --force to overwrite.`);
    process.exit(1);
  }
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(file, "");

  const start = Date.now() - PATH.length * CYCLE_MS;
  let lastActionAt: number | null = null;
  let actionsToday = 0;
  let prevPositions: PositionSnapshot[] = [];

  PATH.forEach((active, i) => {
    const cycle = i + 1;
    const ts = start + i * CYCLE_MS;
    // Accrue fees on in-range bands: about 0.7%/day of band size, scaled by dynamic fee.
    for (const b of bands) {
      if (active >= b.lower && active <= b.upper) {
        b.feesSol += b.sol * 0.0004;
        b.inRangeCycles += 1;
      }
    }
    // The observation: positions and wallet BEFORE this cycle's action.
    const positionsBefore = bands.map((b) => bandSnapshot(b, active));
    const walletBefore = { ...wallet };
    const ctx: Ctx = {
      cycle,
      i,
      active,
      prev: i > 0 ? PATH[i - 1] : null,
      delta: i > 0 ? active - PATH[i - 1] : 0,
      ts,
      positions: positionsBefore,
      prevPositions,
      wallet: walletBefore,
      pool: pool(active),
      analytics: analytics(active),
      actionsToday,
    };
    const step: Step = script[cycle] ? script[cycle](ctx) : { decision: autoHold(ctx) };
    const decision = step.decision;
    const proposal = step.proposal ?? decision;
    for (const d of [decision, proposal]) {
      if (d.headline.length > 90) throw new Error(`cycle ${cycle}: headline over 90 chars: ${d.headline}`);
    }

    const opens = decision.action === "OPEN_POSITION" || decision.action === "REBALANCE";
    const closes = decision.action === "CLOSE_POSITION" || decision.action === "REBALANCE";
    const executed = !step.violations && decision.action !== "HOLD";
    const txs: ExecutionResult["txs"] = [];
    if (executed) {
      if (closes) txs.push({ label: `close band ${decision.positionAddress!.slice(0, 6)} 1/1`, ok: true, unitsConsumed: 184_320, logsTail: [] });
      if (opens) {
        const o = decision.open!;
        txs.push({ label: `open ${o.side} band bins [${active - o.binsBelowActive}, ${active + o.binsAboveActive}]`, ok: true, unitsConsumed: 296_114, logsTail: [] });
        if (!step.opened) throw new Error(`cycle ${cycle}: opening step without an opened address`);
      }
      if (decision.action === "CLAIM_FEES") txs.push({ label: "claim fees 1/1", ok: true, unitsConsumed: 61_402, logsTail: [] });
      lastActionAt = ts;
      actionsToday += 1;
    }
    step.apply?.(ctx);
    const entry: JournalEntry = {
      id: `demo-${cycle}`,
      ts: new Date(ts).toISOString(),
      cycle,
      mode: "dry-run",
      agent: { id: "mr-bands", name: "Mr Bands" },
      pool: ctx.pool,
      wallet: { address: WALLET, sol: walletBefore.sol, token: walletBefore.token, tokenSymbol: "ANSEM" },
      positions: positionsBefore,
      analytics: ctx.analytics,
      llm: { source: "llm", model: "claude-opus-5", usage: { inputTokens: 3120, outputTokens: 210, cacheReadTokens: 2400, cacheWriteTokens: 0 } },
      proposal,
      decision,
      allowed: !step.violations,
      violations: step.violations ?? [],
      overrides: step.overrides ?? [],
      passed: step.emergency ? ["kill-switch"] : ["stop-loss", "kill-switch"],
      emergency: step.emergency ?? false,
      execution: executed
        ? {
            mode: "dry-run",
            ok: true,
            txs,
            notes: [],
            ...(closes ? { closed: decision.positionAddress! } : {}),
            ...(opens ? { opened: { address: step.opened!, entryValueSol: decision.open!.amountSol } } : {}),
          }
        : { mode: "none", ok: true, txs: [], notes: [step.violations ? "blocked by guards" : "hold"] },
      headline: decision.headline,
    };
    appendJournal(entry, { renderDerived: false });
    prevPositions = positionsBefore;
  });
  renderDerivedFiles();
  fs.writeFileSync(path.join(dataDir(), "state.json"), JSON.stringify({ day: new Date().toISOString().slice(0, 10), actionsToday, lastActionAt, lastPrice: price(PATH[PATH.length - 1]), entryValueSol: {} }, null, 2));
  console.log(`seeded ${PATH.length} demo entries -> ${file} (fees realized ${feesRealized.toFixed(4)} SOL, wallet ${wallet.sol.toFixed(4)} SOL + ${wallet.token.toFixed(0)} ANSEM)`);
  checkConsistency(file);
  console.log("consistency: ok");
}

// ---- consistency check: the words must agree with the numbers in the same entry ----

const IN_CLAIM = /\b(in range|inside the band|fees ticking|collecting|still earning|earning again|in the pocket|band covers it|bands hold)\b/i;
const OUT_CLAIM = /\b(out of range|under the (?:band's )?floor|under the band|below the band|below its floor|over the top|above the band|earn(?:s|ing) nothing|idle)\b/i;

function allMatches(re: RegExp, text: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) out.push(m);
  return out;
}

function checkConsistency(file: string): void {
  const entries = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as JournalEntry);
  if (entries.length !== PATH.length) throw new Error(`consistency: expected ${PATH.length} entries, found ${entries.length}`);

  entries.forEach((e, idx) => {
    const fail = (msg: string): never => {
      throw new Error(`consistency: cycle ${e.cycle}: ${msg}\n  headline: ${e.headline}\n  reasoning: ${e.decision.reasoning}`);
    };
    const active = e.pool.activeBinId;
    const text = [e.headline, e.decision.reasoning, e.proposal.headline, e.proposal.reasoning].join(" \n ");
    const anyIn = e.positions.some((p) => p.inRange);
    const anyOut = e.positions.some((p) => !p.inRange);

    // positions[] must be self-consistent with the active bin
    for (const p of e.positions) {
      const inRange = active >= p.lowerBinId && active <= p.upperBinId;
      if (p.inRange !== inRange) fail(`position ${p.address.slice(0, 6)} inRange=${p.inRange} but active ${active} vs ${p.lowerBinId}-${p.upperBinId}`);
      const bfr = inRange ? 0 : active < p.lowerBinId ? active - p.lowerBinId : active - p.upperBinId;
      if (p.binsFromRange !== bfr) fail(`position ${p.address.slice(0, 6)} binsFromRange=${p.binsFromRange}, expected ${bfr}`);
    }

    // in-range / out-of-range claims
    if (IN_CLAIM.test(text) && !anyIn) fail(`claims in range (${IN_CLAIM.exec(text)![0]}) but no position is in range`);
    if (OUT_CLAIM.test(text) && e.positions.length > 0 && !anyOut) fail(`claims out of range (${OUT_CLAIM.exec(text)![0]}) but every position is in range`);

    // headline length
    for (const h of [e.headline, e.proposal.headline]) if (h.length > 90) fail(`headline over 90 chars: ${h}`);

    // active bin and price quotes
    for (const m of allMatches(/\bactive bin (\d+)\b/i, text)) if (Number(m[1]) !== active) fail(`mentions active bin ${m[1]} but activeBinId is ${active}`);
    for (const m of allMatches(/\bbin \d+ at ([\d.]+) SOL\b/, text)) if (Number(m[1]) !== Number(e.pool.price.toPrecision(4))) fail(`quotes price ${m[1]} but pool.price is ${e.pool.price.toPrecision(4)}`);

    // bin ranges mentioned must be an open band or the band this entry opens/proposes
    const allowed = e.positions.map((p) => [p.lowerBinId, p.upperBinId] as const);
    for (const d of [e.decision, e.proposal]) {
      if (!d.open) continue;
      const r = [active - d.open.binsBelowActive, active + d.open.binsAboveActive] as const;
      if (!allowed.some(([a, b]) => a === r[0] && b === r[1])) allowed.push(r);
    }
    const rangeRes = [/\bfrom bin (\d+) to (\d+)\b/, /\bband (\d+)-(\d+)\b/, /\bbins \[(\d+), (\d+)\]/];
    for (const re of rangeRes) {
      for (const m of allMatches(re, text)) {
        const lo = Number(m[1]);
        const hi = Number(m[2]);
        if (!allowed.some(([a, b]) => a === lo && b === hi)) fail(`mentions bin range ${lo}-${hi}; open/opened bands are ${allowed.map(([a, b]) => `${a}-${b}`).join(", ") || "none"}`);
      }
    }

    // floor / top / distance claims against positions[]
    for (const m of allMatches(/\bfloor (?:at|bin) (\d+)\b/i, text)) if (!e.positions.some((p) => p.lowerBinId === Number(m[1]))) fail(`mentions floor ${m[1]} but lower bins are ${e.positions.map((p) => p.lowerBinId).join(",") || "none"}`);
    for (const m of allMatches(/\btop (?:at|bin) (\d+)\b/i, text)) if (!e.positions.some((p) => p.upperBinId === Number(m[1]))) fail(`mentions top ${m[1]} but upper bins are ${e.positions.map((p) => p.upperBinId).join(",") || "none"}`);
    for (const m of allMatches(/\b(\d+) bins? (?:under|below) (?:the band's floor|its floor|the floor|the band)\b/i, text)) {
      if (!e.positions.some((p) => p.binsFromRange === -Number(m[1]))) fail(`says ${m[1]} bins under the band but binsFromRange is ${e.positions.map((p) => p.binsFromRange).join(",") || "none"}`);
    }
    for (const m of allMatches(/\b(\d+) bins? (?:above|over) (?:the band's top|the top of the band|the top|the band)\b/i, text)) {
      if (!e.positions.some((p) => p.binsFromRange === Number(m[1]))) fail(`says ${m[1]} bins above the band but binsFromRange is ${e.positions.map((p) => p.binsFromRange).join(",") || "none"}`);
    }
    for (const m of allMatches(/\b(\d+) bins? (?:to|from|off) the floor at (\d+)\b/i, text)) if (active - Number(m[2]) !== Number(m[1])) fail(`says ${m[1]} bins to the floor at ${m[2]} but active is ${active}`);
    for (const m of allMatches(/\b(\d+) bins? to the top at (\d+)\b/i, text)) if (Number(m[2]) - active !== Number(m[1])) fail(`says ${m[1]} bins to the top at ${m[2]} but active is ${active}`);
    for (const m of allMatches(/\bheld between bin (\d+) and bin (\d+)\b/i, text)) {
      const lo = Number(m[1]);
      const hi = Number(m[2]);
      if (!(lo <= active && active <= hi)) fail(`says price held between ${lo} and ${hi} but active is ${active}`);
    }

    // tx labels must match the band actually opened, and the band must exist next cycle
    for (const t of e.execution.txs) {
      const m = /open \w+ band bins \[(\d+), (\d+)\]/.exec(t.label);
      if (!m) continue;
      const lo = Number(m[1]);
      const hi = Number(m[2]);
      const o = e.decision.open;
      if (!o) fail(`tx "${t.label}" without an open decision`);
      if (lo !== active - o!.binsBelowActive || hi !== active + o!.binsAboveActive) fail(`tx "${t.label}" but decision opens ${active - o!.binsBelowActive}-${active + o!.binsAboveActive}`);
      const addr = e.execution.opened?.address;
      if (!addr) fail(`tx "${t.label}" but execution.opened is missing`);
      const next = entries[idx + 1];
      if (next) {
        const np = next.positions.find((p) => p.address === addr);
        if (!np) fail(`opened ${addr!.slice(0, 6)} but it is not in the next cycle's positions`);
        if (np!.lowerBinId !== lo || np!.upperBinId !== hi) fail(`tx "${t.label}" but the position is ${np!.lowerBinId}-${np!.upperBinId}`);
        if (np!.entryValueSol !== e.execution.opened!.entryValueSol) fail(`entryValueSol ${np!.entryValueSol} vs execution.opened ${e.execution.opened!.entryValueSol}`);
      }
    }
  });

  // the story should end with a band in range and earning
  const last = entries[entries.length - 1];
  if (!last.positions.some((p) => p.inRange && feesOf(p, last.pool.price) > 0)) throw new Error("consistency: final entry has no in-range band earning fees");
}

main();
