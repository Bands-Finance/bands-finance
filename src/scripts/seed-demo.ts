/**
 * Seed a realistic demo journal so the dashboard has something to show before the agent
 * has run for hours. Five hours of 5-minute cycles in the ANSEM/SOL pool, dry-run mode.
 *   npm run seed-demo            refuses if data/decisions.jsonl exists
 *   npm run seed-demo -- --force overwrites
 */
import fs from "node:fs";
import path from "node:path";
import { appendJournal, dataDir, JournalEntry, JournalPool, renderDerivedFiles } from "../journal";
import { binPriceUi, BinRow, PositionSnapshot } from "../tools/dlmm";
import type { Decision } from "../agent/schema";
import type { ExecutionResult } from "../executor";

const POOL = "6e7V9eegCHw997T72MxgwwJipZ6GJyZF8NvjkzT1rvpN";
const WALLET = "BNDSdemo1111111111111111111111111111111111111";
const BIN_STEP = 20;
const X_DEC = 6;
const Y_DEC = 9;
const CYCLE_MS = 5 * 60 * 1000;
const price = (bin: number) => binPriceUi(bin, BIN_STEP, X_DEC, Y_DEC);

// Active bin path: quiet drift, a leg down that pushes the first band out of range,
// a rebound, then a sharp sell-off that trips the stop-loss on the second band.
const PATH = [
  262, 262, 261, 262, 263, 262, 261, 260, 260, 259, 260, 261, 260, 259, 258, 258, 257, 256, 256, 255,
  254, 253, 251, 250, 248, 246, 245, 243, 241, 239, 238, 239, 240, 241, 241, 240, 239, 239, 238, 236,
  230, 221, 208, 192, 172, 138, 141, 144, 146, 147, 146, 148, 150, 151, 150, 152, 153, 152, 154, 155,
];

interface Band {
  address: string;
  lower: number;
  upper: number;
  sol: number; // SOL deposited
  entryTs: number;
  feesSol: number;
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

const hold = (reasoning: string, headline: string, confidence = 0.8): Decision => ({
  action: "HOLD",
  open: null,
  positionAddress: null,
  reasoning,
  confidence,
  headline,
});

interface Step {
  decision: Decision;
  violations?: string[];
  overrides?: string[];
  emergency?: boolean;
  apply?: (active: number, ts: number) => void;
}

function openBand(addr: string, sol: number, below: number, active: number, ts: number) {
  bands.push({ address: addr, lower: active - below, upper: active, sol, entryTs: ts, feesSol: 0 });
  wallet.sol -= sol + 0.0574;
}
function closeBand(addr: string, active: number) {
  const i = bands.findIndex((b) => b.address === addr);
  if (i < 0) return;
  const snap = bandSnapshot(bands[i], active);
  wallet.sol += snap.amountY + snap.feeY + 0.0574;
  wallet.token += snap.amountX + snap.feeX;
  feesRealized += bands[i].feesSol;
  bands.splice(i, 1);
}

const P1 = "7bandA1xQm9vKZr4TgH2sLp8eWc3nYd6uFj5kRt1oMz2";
const P2 = "9bandB2yRn8wLAs5UhJ3tMq7fXd4oZe7vGk6lSu2pNa3";
const P3 = "4bandC3zSo7xMBt6ViK4uNr8gYe5pAf8wHl7mTv3qOb4";

const script: Record<number, Step> = {
  1: { decision: hold("First look. Active bin 262 at 0.001736 SOL, $5.1M daily volume, fee/TVL 24h near 0.7%. Two-sided depth is balanced. I want one more print before committing.", "New pool, new me. Watching the tape first.", 0.7) },
  2: { decision: hold("Price flat at bin 262 over two cycles, dynamic fee 0.25%, no directional flow. Conditions are right for a bid band next cycle if nothing changes.", "Flat tape, fat fees. Warming up the bands.", 0.75) },
  3: {
    decision: {
      action: "OPEN_POSITION",
      open: { side: "SOL_ONLY", amountSol: 0.25, amountToken: 0, binsBelowActive: 19, binsAboveActive: 0, strategy: "Spot" },
      positionAddress: null,
      reasoning: "Volume $5.1M against $1.47M TVL gives roughly 0.7% fee/TVL a day. A 20-bin SOL band from bin 243 to 262 covers a 3.9% drop, catches the bid-side flow, and stays inside the 0.5 SOL cap. Half the max, as a first band.",
      confidence: 0.82,
      headline: "Twenty bands under the bid. Let them come to me.",
    },
    apply: (active, ts) => openBand(P1, 0.25, 19, active, ts),
  },
  12: {
    decision: hold("Blocked by risk guards: band size 0.6000 SOL > max 0.5", "Guards said no. Holding."),
    violations: ["band size 0.6000 SOL > max 0.5"],
  },
  20: {
    decision: {
      action: "CLAIM_FEES",
      open: null,
      positionAddress: P1,
      reasoning: "Unclaimed fees on the first band are 0.0017 SOL, about 0.7% of the band, after 85 minutes in range. That clears the gas cost many times over. Claiming now locks it in before the drift below continues.",
      confidence: 0.85,
      headline: "First stack claimed. 0.7% in eighty-five minutes.",
    },
    apply: () => {
      const b = bands.find((x) => x.address === P1);
      if (b) {
        wallet.sol += b.feesSol;
        feesRealized += b.feesSol;
        b.feesSol = 0;
      }
    },
  },
  30: {
    decision: {
      action: "REBALANCE",
      open: { side: "SOL_ONLY", amountSol: 0.3, amountToken: 0, binsBelowActive: 19, binsAboveActive: 0, strategy: "Spot" },
      positionAddress: P1,
      reasoning: "Active bin 238 is 5 bins under the band's floor at 243. The band is fully converted to ANSEM and earning nothing. Volume is still $4.8M and the fee/TVL ratio is intact, so the pool is worth being in. Close, and re-lay 0.3 SOL from bin 219 to 238.",
      confidence: 0.78,
      headline: "Price walked out the bottom. Moving the bands down to meet it.",
    },
    apply: (active, ts) => {
      closeBand(P1, active);
      openBand(P2, 0.3, 19, active, ts);
    },
  },
  46: {
    decision: {
      action: "CLOSE_POSITION",
      open: null,
      positionAddress: P2,
      reasoning: "Stop-loss triggered by risk guards at -16.3% (limit -15%). Model proposal (HOLD) overridden.",
      confidence: 1,
      headline: "Stop-loss hit. Bands off the table.",
    },
    overrides: ["stop-loss: 9bandB is 16.3% below entry (0.3000 -> 0.2511 SOL); forcing CLOSE"],
    emergency: true,
    apply: (active) => closeBand(P2, active),
  },
  58: {
    decision: {
      action: "OPEN_POSITION",
      open: { side: "SOL_ONLY", amountSol: 0.15, amountToken: 0, binsBelowActive: 14, binsAboveActive: 0, strategy: "Spot" },
      positionAddress: null,
      reasoning: "Price has held between bins 146 and 154 for two hours and buys are back to parity with sells. Volume is still above $4M. A small 15-bin SOL band under bin 153 puts 0.15 SOL to work with a short leash: the stop-loss sits 15% below and the daily cap has room.",
      confidence: 0.66,
      headline: "Bounce held two hours. Small band, short leash.",
    },
    apply: (active, ts) => openBand(P3, 0.15, 14, active, ts),
  },
  55: {
    decision: hold("The sell-off from bin 238 to 138 has stalled and price has crept back to 150. 24h change is about -30% and sells still outnumber buys two to one. I hold ANSEM from the closed band and about 0.45 SOL. Not laying a band into a downtrend with one-sided flow.", "Dust hasn't settled. Sitting on my hands.", 0.7),
  },
};

const holdLines: [string, string][] = [
  ["Band is in range, fees ticking. Nothing to do but let it work.", "In range. Collecting."],
  ["Price is drifting inside the band; unclaimed fees are still small relative to gas. No action.", "Fees stacking. Not worth the gas yet."],
  ["Active bin moved one step. Band covers it. The right move is no move.", "One bin. Bands hold."],
  ["Depth on both sides is steady and dynamic fee is unchanged. Holding.", "Quiet tape. Quiet bands."],
];

const flatLines: [string, string][] = [
  ["No band open. Tape is unchanged from last cycle; nothing worth paying rent for.", "Nothing to do. Nothing done."],
  ["Flat, holding SOL and the ANSEM left from the closed band. Sells still lead buys; no band into that.", "Sellers still in charge. Bands stay pocketed."],
  ["One bin of movement since last cycle. Depth is thin on the bid side; a band here would be alone.", "Thin bids. Not standing there alone."],
  ["Watching for buys to catch up with sells before laying anything down. Not yet.", "Waiting on the buyers."],
];

function main(): void {
  const file = path.join(dataDir(), "decisions.jsonl");
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

  PATH.forEach((active, i) => {
    const cycle = i + 1;
    const ts = start + i * CYCLE_MS;
    // Accrue fees on in-range bands: about 0.7%/day of band size, scaled by dynamic fee.
    for (const b of bands) {
      if (active >= b.lower && active <= b.upper) b.feesSol += b.sol * 0.0004;
    }
    const positionsBefore = bands.map((b) => bandSnapshot(b, active));
    const step = script[cycle] ?? { decision: (() => { const [r, h] = (bands.length ? holdLines : flatLines)[cycle % holdLines.length]; return hold(r, h); })() };
    const decision = step.decision;
    const proposal: Decision = step.violations
      ? { ...decision, action: "OPEN_POSITION", open: { side: "SOL_ONLY", amountSol: 0.6, amountToken: 0, binsBelowActive: 25, binsAboveActive: 0, strategy: "Spot" }, reasoning: "Fees are strong and price is stable; a second, larger band from bin 235 to 260 would double the fee capture.", headline: "Doubling down under the bid." }
      : step.emergency
        ? hold("Band two is fully converted after the sell-off; price is 82 bins below its floor. Waiting for a bounce before rebalancing.", "Holding through the dip.")
        : decision;

    const executed = !step.violations && decision.action !== "HOLD";
    const txs: ExecutionResult["txs"] = [];
    if (executed) {
      if (decision.action === "CLOSE_POSITION" || decision.action === "REBALANCE") txs.push({ label: `close band ${decision.positionAddress!.slice(0, 6)} 1/1`, ok: true, unitsConsumed: 184_320, logsTail: [] });
      if (decision.action === "OPEN_POSITION" || decision.action === "REBALANCE") txs.push({ label: `open SOL_ONLY band bins [${active - 19}, ${active}]`, ok: true, unitsConsumed: 296_114, logsTail: [] });
      if (decision.action === "CLAIM_FEES") txs.push({ label: "claim fees 1/1", ok: true, unitsConsumed: 61_402, logsTail: [] });
      lastActionAt = ts;
      actionsToday += 1;
    }
    const walletBefore = { ...wallet };
    step.apply?.(active, ts);
    const entry: JournalEntry = {
      id: `demo-${cycle}`,
      ts: new Date(ts).toISOString(),
      cycle,
      mode: "dry-run",
      agent: { id: "mr-bands", name: "Mr Bands" },
      pool: pool(active),
      wallet: { address: WALLET, sol: walletBefore.sol, token: walletBefore.token, tokenSymbol: "ANSEM" },
      positions: positionsBefore,
      analytics: {
        source: "geckoterminal",
        priceUsd: price(active) * 101,
        volume24hUsd: 5_150_000 - Math.abs(250 - active) * 12_000,
        tvlUsd: 1_470_000,
        fees24hUsd: (5_150_000 - Math.abs(250 - active) * 12_000) * 0.002,
        feeToTvl24hPct: ((5_150_000 - Math.abs(250 - active) * 12_000) * 0.002 * 100) / 1_470_000,
        priceChange24hPct: (price(active) / price(262) - 1) * 100 - 7,
        txns24h: 10_462,
        note: "fees24h estimated as volume x base fee",
      },
      llm: { source: "llm", model: "claude-opus-5", usage: { inputTokens: 3120, outputTokens: 210, cacheReadTokens: 2400, cacheWriteTokens: 0 } },
      proposal,
      decision,
      allowed: !step.violations,
      violations: step.violations ?? [],
      overrides: step.overrides ?? [],
      passed: ["stop-loss", "kill-switch"],
      emergency: step.emergency ?? false,
      execution: executed ? { mode: "dry-run", ok: true, txs, notes: [], ...(decision.action === "CLOSE_POSITION" || decision.action === "REBALANCE" ? { closed: decision.positionAddress! } : {}), ...(decision.action === "OPEN_POSITION" || decision.action === "REBALANCE" ? { opened: { address: decision.action === "REBALANCE" ? P2 : cycle > 50 ? P3 : P1, entryValueSol: decision.open!.amountSol } } : {}) } : { mode: "none", ok: true, txs: [], notes: [step.violations ? "blocked by guards" : "hold"] },
      headline: decision.headline,
    };
    appendJournal(entry, { renderDerived: false });
  });
  renderDerivedFiles();
  fs.writeFileSync(path.join(dataDir(), "state.json"), JSON.stringify({ day: new Date().toISOString().slice(0, 10), actionsToday, lastActionAt, lastPrice: price(PATH[PATH.length - 1]), entryValueSol: {} }, null, 2));
  console.log(`seeded ${PATH.length} demo entries -> ${file} (fees realized ${feesRealized.toFixed(4)} SOL, wallet ${wallet.sol.toFixed(4)} SOL + ${wallet.token.toFixed(0)} ANSEM)`);
}

main();
