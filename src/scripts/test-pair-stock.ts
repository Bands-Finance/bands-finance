/**
 * The STOCK PAIR LANE: the desk makes and works its own STOCKx/SOL pools on Meteora DLMM.
 *
 *   env         the documented defaults; PAIR_STOCK_TICKERS parsing; the fee menu
 *   candidates  the board grouped by ticker: the deepest pool is the reference, the volume is the
 *               sum, the SOL-quoted concentrated pools are the competition; xStocks only
 *   admission   every refusal string; one per ticker; max pools; a DENY wins; PAIR_STOCK_TICKERS narrows
 *   the model   monotonic properties, the two-hop reference against our single hop at small sizes,
 *               competition halving the share at equal depth, a worked example pinned, chooseStockFeeBps
 *   paper       create -> the policy proposes a straddle (basis ok) -> guards -> executePaper (the token
 *               bought first) -> mark at a moved perp mid -> re-centre -> reference gone -> EXPIRE and
 *               liquidate, through the REAL functions, the equity identity holding throughout
 *   basis       basisVerdict refuses around the open; the policy holds on it
 *   hedge       the hedge desk shorts NVDA's perp in paper and leaves MSFT unhedged, the headline saying so
 *   live        the create parameters for a stock spec derived offline; the broadcast gate (no RPC anywhere)
 *
 * Fixture: today's board shape (2026-09-15): SPY with a $2.7M USDC pool and a $1.1M SOL pool, NVDA,
 * MSFT with no perp, a thin one (GLD), a low-volume one (AMZN), a low-liquidity SOL-quoted one (VIDA),
 * META (the walk's ticker: a $268k reference our seat can beat), MCD, a Backpack-issued one (DJT).
 * No network, no disk outside a temp dir, no clock.
 *   npm run test:pair-stock
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Everything that reads src/config.ts is imported after the environment is pinned.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mr-bands-pair-stock-"));
process.env.DATA_DIR = tmp;
process.env.ANTHROPIC_API_KEY = "";
delete process.env.ANTHROPIC_AUTH_TOKEN;
process.env.DRY_RUN = "true";
process.env.WALLET_SECRET_KEY = "";
process.env.MAX_POSITION_SOL = "60";
process.env.MAX_TOTAL_EXPOSURE_SOL = "100";
process.env.GAS_RESERVE_SOL = "1";
process.env.STOP_LOSS_PCT = "15";
process.env.MAX_BIN_WIDTH = "69";
process.env.MAX_TX_PER_DAY = "24";
process.env.MIN_SECONDS_BETWEEN_ACTIONS = "600";
process.env.MAX_SLIPPAGE_PCT = "1";
process.env.MAX_PRICE_MOVE_PCT_PER_CYCLE = "40";
process.env.PAPER_SOL = "";
process.env.PAIR_LIVE = "";
process.env.LIVE_VENUES = "";
process.env.TRADABLE_VENUES = "";
process.env.POLICY_MAX_PAYBACK_HOURS = "24";
process.env.POLICY_MIN_SEAT_PCT = "5";
process.env.POLICY_VOL_MULTIPLE = "1";
// the walk's geometry: 0.6% each side at 0.2%/bin = 3 bins a side (STOCK_COVER_PCT x the session's width, at OUR bin step)
process.env.STOCK_COVER_PCT = "0.6";
for (const k of Object.keys(process.env)) if (k.startsWith("PAIR_STOCK_") || k === "PAIR_HOP_FEE_PCT" || k === "PAIR_REF_DEPTH_PER_PCT") delete process.env[k];
for (const k of ["SWAP_FEE_PCT", "SWAP_SLIPPAGE_BPS", "PAPER_HEDGE_FEE_PCT", "HEDGE_LIVE", "HEDGE_MAX_NOTIONAL_USD", "HEDGE_MIN_REBALANCE_USD", "BACKPACK_API_KEY", "BACKPACK_API_SECRET", "BASIS_MAX_PCT", "BASIS_PRE_OPEN_MIN"]) delete process.env[k];

import type { Observation } from "../agent/observation";
import type { Decision } from "../agent/schema";
import type { HedgeClient } from "../engine/hedgeDesk";
import type { HotFile } from "../hot/types";
import type { RiskLimits } from "../risk/limits";
import type { Verdict } from "../risk/guards";
import type { PairStockCandidate, PairStockEnv, StockPoolRow } from "../screener/pairStock";
import type { PoolSnapshot, PositionSnapshot } from "../tools/dlmm";
import * as sdk from "@meteora-ag/dlmm";
import { PublicKey } from "@solana/web3.js";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err);
    process.exit(1);
  }
}
/** relative tolerance (against max(1, |b|)) */
const near = (a: number | null | undefined, b: number, tol = 1e-6, what = "") => {
  assert.ok(a !== null && a !== undefined && Number.isFinite(a), `${what} expected ${b}, got ${a}`);
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what} expected ${b}, got ${a}`);
};
/** absolute tolerance */
const close = (a: number | null | undefined, b: number, abs: number, what = "") => {
  assert.ok(a !== null && a !== undefined && Number.isFinite(a), `${what} expected ${b}, got ${a}`);
  assert.ok(Math.abs(a - b) <= abs, `${what} expected ${b} +/- ${abs}, got ${a}`);
};

const SOL = "So11111111111111111111111111111111111111112";
const SPY = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const NVDA = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const MSFT = "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX";
const META = "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu";
const MCD = "XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2";
const AMZN = "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg";
const GLD = "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re";
const VIDA = "XsfCC9VL4DamVGNgdJpfLXB3sBVa158Gbx8sh7NzmTk";
const DJT = "DJTu7vNotAnXstockMintButBackpackSecurities1";
const T0 = Date.parse("2026-09-14T17:30:00.000Z"); // Monday 13:30 ET: the regular US session
const M = 60_000;
const SOL_USD = 100;

const limits: RiskLimits = { maxPositionSol: 60, maxTotalExposureSol: 100, gasReserveSol: 1, stopLossPct: 15, maxBinWidth: 69, maxTxPerDay: 24, minSecondsBetweenActions: 600, maxSlippagePct: 1, maxPriceMovePctPerCycle: 40 };

const xs = (ticker: string) => ({ ticker, issuer: "xstocks" as const });
const row = (over: Partial<StockPoolRow> & Pick<StockPoolRow, "address" | "baseMint" | "baseSymbol" | "tvlUsd" | "volume24hUsd">): StockPoolRow => ({
  venue: "raydium-clmm",
  name: `${over.baseSymbol} / ${over.quoteSymbol ?? "USDC"}`,
  quoteSymbol: "USDC",
  baseDecimals: 8,
  baseFeePct: 0.25,
  stepBps: 60,
  price: over.priceUsd ?? null,
  priceUsd: null,
  ageHours: 9000,
  priceChange24hPct: 0.3,
  flags: [],
  stock: null,
  ...over,
});
// today's board shape (2026-09-15 13:40Z), the figures rounded to the dollar
const SPY_USDC = row({ address: "6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE", baseMint: SPY, baseSymbol: "SPYx", tvlUsd: 2_664_038, volume24hUsd: 4_773_285, baseFeePct: 0.1, stepBps: 10, priceUsd: 765.36, stock: xs("SPY") });
const SPY_SOL = row({ address: "SPYsoLRayd1umPoo1xxxxxxxxxxxxxxxxxxxxxxxxxxx", baseMint: SPY, baseSymbol: "SPYx", quoteSymbol: "SOL", tvlUsd: 1_101_032, volume24hUsd: 822_740, baseFeePct: 0.25, stepBps: 60, price: 7.5646, priceUsd: 760.52, stock: xs("SPY") });
const SPY_1BP = row({ address: "SPY1bpRayd1umPoo1xxxxxxxxxxxxxxxxxxxxxxxxxxx", baseMint: SPY, baseSymbol: "SPYx", tvlUsd: 267_908, volume24hUsd: 4_919_119, baseFeePct: 0.01, stepBps: 1, priceUsd: 764.88, stock: xs("SPY") });
const NVDA_USDC = row({ address: "NVDAusdcRayd1umxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", baseMint: NVDA, baseSymbol: "NVDAx", tvlUsd: 2_143_813, volume24hUsd: 1_197_237, baseFeePct: 0.1, stepBps: 10, priceUsd: 213.55, stock: xs("NVDA") });
const NVDA_SOL = row({ address: "NVDAsoLRayd1umxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", baseMint: NVDA, baseSymbol: "NVDAx", quoteSymbol: "SOL", tvlUsd: 98_574, volume24hUsd: 532_633, baseFeePct: 0.25, stepBps: 60, price: 2.1119, priceUsd: 212.33, stock: xs("NVDA") });
const NVDA_ORCA = row({ address: "NVDAorcaUsdcxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", venue: "orca-whirlpool", baseMint: NVDA, baseSymbol: "NVDAx", tvlUsd: 146_329, volume24hUsd: 615_351, baseFeePct: 0.02, stepBps: 2, priceUsd: 213.61, flags: ["adaptive-fee"], stock: xs("NVDA") });
const MSFT_USDC = row({ address: "CLu4kFM4nb67xrdN7vJnMxXXir8Z5hA4HJUzPFccXjsL", baseMint: MSFT, baseSymbol: "MSFTx", tvlUsd: 386_298, volume24hUsd: 948_554, baseFeePct: 0.25, stepBps: 60, priceUsd: 504.75, stock: xs("MSFT") });
const MSFT_USDC_2 = row({ address: "D6bRhQUcR9B7bPbbqgxpE17MjyUjBtr8hHQCcJoHrrv1", baseMint: MSFT, baseSymbol: "MSFTx", tvlUsd: 295_768, volume24hUsd: 1_257_162, baseFeePct: 0.1, stepBps: 10, priceUsd: 504.05, stock: xs("MSFT") });
const META_USDC = row({ address: "3L7KbPVaAQA4UTecaGQYsm6UCq5F3sZM9zAYkxqYt63j", baseMint: META, baseSymbol: "METAx", tvlUsd: 268_119, volume24hUsd: 605_628, baseFeePct: 0.25, stepBps: 60, priceUsd: 664.17, ageHours: 9574, priceChange24hPct: 0.47, stock: xs("META") });
const MCD_USDC = row({ address: "5MGvNj9RNKNmzwp1LtZuQkZonEYtKJ3JuiyNQEUU2DsF", baseMint: MCD, baseSymbol: "MCDx", tvlUsd: 148_620, volume24hUsd: 517_738, baseFeePct: 1, stepBps: 120, priceUsd: 261.76, stock: xs("MCD") });
const MCD_ORCA_SOL = row({ address: "9zxCtrokbSGApeqFBr1LC3BzTb3drYQj4fmH6sT7Zxym", venue: "orca-whirlpool", baseMint: MCD, baseSymbol: "MCDx", quoteSymbol: "SOL", tvlUsd: 138_164, volume24hUsd: 335_247, baseFeePct: 1, stepBps: 128, price: 2.5937, priceUsd: 260.76, flags: ["adaptive-fee"], stock: xs("MCD") });
const MCD_ORCA_USDC = row({ address: "6UaXnzFjCtn9qwcCUEex7EG4hoojSDrf6iZfjQUYaNqP", venue: "orca-whirlpool", baseMint: MCD, baseSymbol: "MCDx", tvlUsd: 65_742, volume24hUsd: 435_931, baseFeePct: 0.16, stepBps: 16, priceUsd: 262.4, flags: ["adaptive-fee"], stock: xs("MCD") });
const MCD_METEORA_SOL = row({ address: "3AoTmvEZxkRWRbT9tmrKWeD2kBaGXUrYHuHdx79zKXSe", venue: "meteora-dlmm", baseMint: MCD, baseSymbol: "MCDx", quoteSymbol: "SOL", tvlUsd: 38_245, volume24hUsd: 221_488, baseFeePct: 0.15, stepBps: 15, price: 2.609, priceUsd: 261.33, stock: xs("MCD") });
const AMZN_USDC = row({ address: "AMZNusdcRayd1umxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", baseMint: AMZN, baseSymbol: "AMZNx", tvlUsd: 307_823, volume24hUsd: 351_014, baseFeePct: 0.25, stepBps: 60, priceUsd: 252.86, stock: xs("AMZN") });
const GLD_USDC = row({ address: "GLDusdcThinRayd1umxxxxxxxxxxxxxxxxxxxxxxxxxx", baseMint: GLD, baseSymbol: "GLDx", tvlUsd: 120_000, volume24hUsd: 1_869_473, baseFeePct: 0.1, stepBps: 10, priceUsd: 392.84, flags: ["thin"], stock: xs("GLD") });
const VIDA_SOL = row({ address: "VIDAsoLRayd1umxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", baseMint: VIDA, baseSymbol: "VIDAx", quoteSymbol: "SOL", tvlUsd: 90_691, volume24hUsd: 847_685, baseFeePct: 0.25, stepBps: 60, price: 0.01926, priceUsd: 1.936, flags: ["adaptive-fee"], stock: xs("VIDA") });
const DJT_SOL = row({ address: "DJTsoLRayd1umxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", baseMint: DJT, baseSymbol: "DJT", quoteSymbol: "SOL", tvlUsd: 42_895, volume24hUsd: 1_279_838, baseFeePct: 0.2, stepBps: 10, price: 0.08706, priceUsd: 8.75, flags: ["adaptive-fee"], stock: { ticker: "DJT", issuer: "backpack" } });
const SOL_USDC = row({ address: "SOLusdcxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", baseMint: SOL, baseSymbol: "SOL", tvlUsd: 50_000_000, volume24hUsd: 300_000_000, baseFeePct: 0.01, stepBps: 1, priceUsd: 100 });
const BOARD: StockPoolRow[] = [SPY_USDC, SPY_SOL, SPY_1BP, NVDA_USDC, NVDA_SOL, NVDA_ORCA, MSFT_USDC, MSFT_USDC_2, META_USDC, MCD_USDC, MCD_ORCA_SOL, MCD_ORCA_USDC, MCD_METEORA_SOL, AMZN_USDC, GLD_USDC, VIDA_SOL, DJT_SOL, SOL_USDC];
const HOT = [
  { baseMint: NVDA, vol1hUsd: 441_793.21 },
  { baseMint: NVDA, vol1hUsd: 223_258.52 },
  { baseMint: DJT, vol1hUsd: 46_420 },
];

async function main(): Promise<void> {
  const lane = await import("../screener/pairStock.js");
  const pair = await import("../screener/pair.js");
  const venue = await import("../venues/pair.js");
  const paper = await import("../paper/index.js");
  const dlmm = await import("../tools/dlmm.js");
  const { evaluate, NO_ENGINE } = await import("../risk/guards.js");
  const { emptyState } = await import("../risk/state.js");
  const { engineDirective } = await import("../engine/directives.js");
  const { emptyEngineState } = await import("../engine/breakers.js");
  const policy = await import("../agent/policy.js");
  const { formatObservation } = await import("../agent/observation.js");
  const { basisVerdict, sessionClock } = await import("../basis/index.js");
  const desk = await import("../engine/hedgeDesk.js");
  const { watchlistDenial, denyToken, emptyWatchlist } = await import("../screener/watchlist.js");

  const env = (over: Partial<PairStockEnv> = {}): PairStockEnv => ({ ...lane.pairStockEnv({}), ...over });
  const cands = (board: readonly StockPoolRow[] = BOARD) => lane.pairStockCandidatesOf(board, HOT);
  const byTicker = (t: string, board: readonly StockPoolRow[] = BOARD): PairStockCandidate => {
    const c = cands(board).find((x) => x.ticker === t);
    assert.ok(c, `no candidate ${t}`);
    return c;
  };
  const refuse = (c: PairStockCandidate, e: PairStockEnv = env()) => lane.pairStockVerdict(c, e) as { ok: false; reason: string };

  /* ================= 1. env ================================================================ */
  console.log("stock pair lane / env");
  await test("pairStockEnv: the documented defaults; PAIR_STOCK_LANE closes the lane; tickers, the fee menu, the collect mode", () => {
    assert.deepEqual(lane.pairStockEnv({}), {
      on: true, tickers: null, minRefLiquidityUsd: 100_000, minVolume24hUsd: 500_000, maxPools: 3, reserveSeats: 2, binStep: 20, feeBps: 25, feeBpsFixed: false, feeMenuBps: [10, 25, 50],
      collectFeeMode: "both", seatPct: 15, tradeMinUsd: 100, tradeMaxUsd: 20_000, hopFeePct: 0.04, refDepthPerPct: 0.1, refGoneCycles: 3,
    });
    for (const v of ["false", "no", "0", "yes"]) assert.equal(lane.pairStockEnv({ PAIR_STOCK_LANE: v }).on, false, `PAIR_STOCK_LANE=${v}`);
    assert.equal(lane.pairStockEnv({ PAIR_STOCK_LANE: "" }).on, true, "empty is unset");
    assert.deepEqual(lane.parseStockTickers("SPY, nvdax ,MSFT,spy"), ["SPY", "NVDA", "MSFT"]);
    assert.equal(lane.parseStockTickers(" "), null);
    assert.deepEqual(lane.pairStockEnv({ PAIR_STOCK_TICKERS: "SPYx" }).tickers, ["SPY"]);
    assert.deepEqual(lane.pairStockEnv({ PAIR_STOCK_FEE_MENU: "5, 50, 5" }).feeMenuBps, [5, 50]);
    assert.equal(lane.pairStockEnv({ PAIR_STOCK_FEE_BPS: "40" }).feeBpsFixed, true);
    assert.equal(lane.pairStockEnv({ PAIR_STOCK_COLLECT_FEE_MODE: "quote" }).collectFeeMode, "quote");
    assert.equal(lane.pairStockEnv({ PAIR_STOCK_COLLECT_FEE_MODE: "junk" }).collectFeeMode, "both");
    assert.equal(lane.pairStockEnv({ PAIR_STOCK_BIN_STEP: "900" }).binStep, 400, "the program's ceiling");
    assert.equal(lane.pairStockEnv({ PAIR_STOCK_REF_GONE_CYCLES: "0" }).refGoneCycles, 1, "at least one cycle");
    assert.equal(lane.pairStockSeatSol(175, env()), 26.25);
    assert.equal(lane.refFeePctOf(null), 0.25);
    assert.equal(lane.refFeePctOf(0.1), 0.1);
    assert.equal(lane.pairStockReserve(env(), 0), 2);
    assert.equal(lane.pairStockReserve(env(), 1), 1);
    assert.equal(lane.pairStockReserve(env(), 2), 0);
    assert.equal(lane.pairStockReserve(env({ reserveSeats: 5 }), 0), 3, "never more than PAIR_STOCK_MAX_POOLS");
    assert.equal(lane.pairStockReserve(env({ on: false }), 0), 0);
  });

  /* ================= 2. candidates ========================================================= */
  console.log("\nstock pair lane / candidates");
  await test("the board grouped by ticker (xStocks only): the deepest pool is the reference, the volume is the sum, the SOL-quoted concentrated pools are the competition", () => {
    const all = cands();
    assert.deepEqual(new Set(all.map((c) => c.ticker)), new Set(["SPY", "NVDA", "MSFT", "META", "MCD", "AMZN", "GLD", "VIDA"]), "no DJT (Backpack-issued), no SOL/USDC");
    const spy = byTicker("SPY");
    assert.equal(spy.mint, SPY);
    assert.equal(spy.symbol, "SPYx");
    assert.equal(spy.issuer, "xstocks");
    assert.equal(spy.baseDecimals, 8);
    assert.equal(spy.reference.address, SPY_USDC.address, "the $2.66M USDC pool, not the $1.1M SOL pool");
    assert.equal(spy.refLiquidityUsd, 2_664_038);
    assert.equal(spy.refFeePct, 0.1);
    assert.equal(spy.refQuoteIsSol, false);
    assert.equal(spy.vol24hUsd, 4_773_285 + 822_740 + 4_919_119, "summed over the ticker's three pools");
    assert.equal(spy.vol1hUsd, null, "the hot watch has no SPY row");
    assert.deepEqual(spy.competitors.map((c) => c.address), [SPY_SOL.address], "SPY/SOL on Raydium is competition; the USDC pools are the route we replace");
    assert.equal(spy.competingDepthUsd, 1_101_032);
    assert.equal(spy.priceUsd, 765.36);
    const nvda = byTicker("NVDA");
    near(nvda.vol1hUsd, 441_793.21 + 223_258.52, 1e-9, "the hot watch's two NVDA rows");
    assert.deepEqual(nvda.competitors.map((c) => c.address), [NVDA_SOL.address], "Orca's USDC pool is not SOL-quoted competition");
    const mcd = byTicker("MCD");
    assert.equal(mcd.reference.address, MCD_USDC.address);
    assert.equal(mcd.refFeePct, 1);
    assert.deepEqual(mcd.competitors.map((c) => c.address), [MCD_ORCA_SOL.address, MCD_METEORA_SOL.address], "deepest first, the reference excluded");
    assert.equal(mcd.competingDepthUsd, 138_164 + 38_245);
    const vida = byTicker("VIDA");
    assert.equal(vida.refQuoteIsSol, true, "a SOL-quoted reference: no hop");
    assert.deepEqual(vida.competitors, [], "the reference is not its own competition");
    assert.equal(lane.pairStockCandidateFor(all, SPY)!.ticker, "SPY");
    assert.equal(lane.pairStockCandidateFor(all, "nope"), null);
    // one per ticker: a second mint under the same ticker keeps the deeper reference
    const twin = row({ address: "SPYtwinxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", baseMint: "XsTwinMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", baseSymbol: "SPYx", tvlUsd: 1, volume24hUsd: 1, priceUsd: 1, stock: xs("SPY") });
    const withTwin = cands([...BOARD, twin]).filter((c) => c.ticker === "SPY");
    assert.equal(withTwin.length, 1);
    assert.equal(withTwin[0].mint, SPY);
    assert.deepEqual(lane.pairStockCandidatesOf(BOARD, [], ["backpack"]).map((c) => c.ticker), ["DJT"], "the issuer list is what admits a mint");
  });

  /* ================= 3. admission ========================================================== */
  console.log("\nstock pair lane / admission");
  await test("SPY, NVDA, MSFT, META and MCD are admitted on the fixture's numbers, and the verdict carries them", () => {
    for (const t of ["SPY", "NVDA", "MSFT", "META", "MCD"]) {
      const v = lane.pairStockVerdict(byTicker(t), env());
      assert.ok(v.ok, `${t}: ${JSON.stringify(v)}`);
    }
    const v = lane.pairStockVerdict(byTicker("SPY"), env());
    assert.ok(v.ok);
    assert.equal(v.refLiquidityUsd, 2_664_038);
    assert.equal(v.vol24hUsd, 10_515_144);
    assert.equal(v.refFeePct, 0.1);
    assert.equal(v.competingDepthUsd, 1_101_032);
    assert.equal(v.competitors.length, 1);
  });
  await test("every refusal names the number that failed, in the launch lane's voice", () => {
    assert.match(refuse(byTicker("SPY"), env({ on: false })).reason, /^the stock pair lane is off \(PAIR_STOCK_LANE is not true\)$/);
    assert.match(refuse(byTicker("NVDA"), env({ tickers: ["SPY", "MSFT"] })).reason, /^NVDA is not in PAIR_STOCK_TICKERS \(SPY, MSFT\)$/);
    assert.ok(lane.pairStockVerdict(byTicker("SPY"), env({ tickers: ["SPY", "MSFT"] })).ok);
    assert.match(refuse(byTicker("VIDA")).reason, /^reference liquidity \$90,691 \(raydium-clmm VIDAx\/SOL\) is under the \$100,000 stock pair floor$/);
    assert.match(refuse({ ...byTicker("SPY"), refLiquidityUsd: null }).reason, /^reference liquidity unknown: the stock pair lane will not price a pool against a number nobody reported$/);
    assert.ok(lane.pairStockVerdict({ ...byTicker("SPY"), refLiquidityUsd: 100_000 }, env()).ok, "exactly the floor is in");
    assert.match(refuse(byTicker("AMZN")).reason, /^24h volume \$351,014 across 1 AMZN pool\(s\) is under the \$500,000 stock pair floor$/);
    assert.match(refuse({ ...byTicker("SPY"), vol24hUsd: null }).reason, /^24h volume unknown: fees come from volume, and nobody reported any$/);
    assert.ok(lane.pairStockVerdict({ ...byTicker("SPY"), vol24hUsd: 500_000 }, env()).ok, "exactly the floor is in");
    assert.match(refuse(byTicker("GLD")).reason, /^the reference pool is flagged thin: a band priced from it would be priced from nothing$/);
    assert.match(refuse({ ...byTicker("SPY"), reference: { ...SPY_USDC, flags: ["no-24h-data"] } }).reason, /^the reference pool is flagged no-24h-data: nothing to judge the flow by$/);
    assert.match(refuse({ ...byTicker("SPY"), priceUsd: null }).reason, /^reference price unknown: nothing to open the pool at$/);
    assert.match(refuse({ ...byTicker("VIDA"), vol24hUsd: 1 }).reason, /^reference liquidity/, "liquidity is judged before volume");
  });

  /* ================= 4. seating ============================================================ */
  console.log("\nstock pair lane / seating");
  const seatOpts = (over: Partial<Parameters<typeof lane.pairStockSeats>[1]> = {}) => ({ env: env(), freeSeats: 6, quoteOk: () => true, ...over });
  await test("pairStockSeats: the admitted tickers by volume when there is no model, at most PAIR_STOCK_MAX_POOLS, one per ticker, keyed pair-<mint>", () => {
    const seats = lane.pairStockSeats(cands(), seatOpts());
    assert.deepEqual(seats.map((s) => s.candidate.ticker), ["SPY", "NVDA", "MSFT"], "the three busiest admitted tickers; MCD and META wait");
    assert.equal(seats[0].address, "pair-" + SPY);
    assert.equal(seats[0].worthUsdPerDay, null);
    assert.ok(seats.every((s) => s.verdict.ok));
    assert.deepEqual(lane.pairStockSeats(cands(), seatOpts({ env: env({ maxPools: 5 }) })).map((s) => s.candidate.ticker), ["SPY", "NVDA", "MSFT", "MCD", "META"], "GLD, AMZN and VIDA never seat");
    assert.deepEqual(lane.pairStockSeats(cands(), seatOpts({ env: env({ maxPools: 2 }) })).map((s) => s.candidate.ticker), ["SPY", "NVDA"]);
    assert.deepEqual(lane.pairStockSeats(cands(), seatOpts({ poolsTaken: 2 })).map((s) => s.candidate.ticker), ["SPY"], "two stock pools already held: one more");
    assert.deepEqual(lane.pairStockSeats(cands(), seatOpts({ poolsTaken: 3 })), [], "the lane is full");
    assert.deepEqual(lane.pairStockSeats(cands(), seatOpts({ freeSeats: 1 })).map((s) => s.candidate.ticker), ["SPY"], "MAX_ACTIVE_POOLS still binds");
    assert.deepEqual(lane.pairStockSeats(cands(), seatOpts({ freeSeats: 0 })), []);
    assert.deepEqual(lane.pairStockSeats(cands(), seatOpts({ env: env({ on: false }) })), [], "the lane off seats nothing");
    assert.deepEqual(lane.pairStockSeats(cands(), seatOpts({ quoteOk: () => false })), [], "the wallet cannot fund a SOL seat");
    assert.deepEqual(lane.pairStockSeats(cands(), seatOpts({ hasPool: (a) => a === "pair-" + SPY })).map((s) => s.candidate.ticker), ["NVDA", "MSFT", "MCD"], "a pool already picked is skipped");
    assert.deepEqual(lane.pairStockSeats(cands(), seatOpts({ hasToken: (m) => m === NVDA })).map((s) => s.candidate.ticker), ["SPY", "MSFT", "MCD"], "one seat per token: a held NVDAx/USDC band keeps NVDA's slot");
  });
  await test("PAIR_STOCK_TICKERS narrows the lane; a watchlist DENY wins; the model's worth orders the seats and a zero is skipped", () => {
    assert.deepEqual(lane.pairStockSeats(cands(), seatOpts({ env: env({ tickers: ["MCD", "MSFT"] }) })).map((s) => s.candidate.ticker), ["MSFT", "MCD"]);
    const w = denyToken(emptyWatchlist(), "SPYx");
    const denied = (c: PairStockCandidate) => watchlistDenial({ address: c.reference.address, baseSymbol: c.symbol, baseMint: c.mint, name: c.name }, w);
    assert.deepEqual(lane.pairStockSeats(cands(), seatOpts({ denied })).map((s) => s.candidate.ticker), ["NVDA", "MSFT", "MCD"], "SPY denied by symbol");
    const w2 = { ...emptyWatchlist(), denyPools: [SPY_USDC.address] };
    assert.deepEqual(lane.pairStockSeats(cands(), seatOpts({ denied: (c) => watchlistDenial({ address: c.reference.address, baseSymbol: c.symbol, baseMint: c.mint, name: c.name }, w2) })).map((s) => s.candidate.ticker), ["NVDA", "MSFT", "MCD"], "or by its reference pool");
    const worth = (c: PairStockCandidate) => ({ MCD: 30, META: 12, SPY: 0, NVDA: 0, MSFT: 5 })[c.ticker] ?? 0;
    const seats = lane.pairStockSeats(cands(), seatOpts({ worth }));
    assert.deepEqual(seats.map((s) => s.candidate.ticker), ["MCD", "META", "MSFT"], "best by the model first; SPY and NVDA route nothing and are skipped, not seated");
    assert.equal(seats[0].worthUsdPerDay, 30);
    assert.deepEqual(lane.pairStockSeats(cands(), seatOpts({ worth: () => 0 })), [], "nothing worth seating, nothing seated");
  });

  /* ================= 5. the routing model ================================================== */
  console.log("\nstock pair lane / the routing model");
  const model = (over: Partial<Parameters<typeof lane.stockRoutedShareBreakdown>[0]> = {}) => ({
    ourFeePct: 0.1, ourDepthPerBinUsd: 500, binStepBps: 20, ourBins: 7, hopFeePct: 0.04, refFeePct: 0.1, refLiquidityUsd: 2_664_038, refDepthPerPct: 0.1, tradeMinUsd: 100, tradeMaxUsd: 20_000, ...over,
  });
  await test("the worked example: SPY's $2.66M reference at 0.1% + the 0.04% hop against $500 per 0.2% bin at 0.1%", () => {
    // theirs at $1,000: 0.04 + 0.10 + 1000 / (2,664,038 x 0.10) = 0.14375%
    close(lane.referenceCostPct(1000, model()), 0.14375, 1e-4, "theirs");
    assert.equal(lane.referenceCostPct(1000, model({ refLiquidityUsd: 0 })), Number.POSITIVE_INFINITY);
    // ours at $1,000: 0.10 + (0.2 / 2) x (1000 / 500) = 0.3%; fillable to 7 x $500
    near(lane.ourStockCostPct(1000, model()), 0.3, 1e-9, "ours");
    near(lane.ourStockCostPct(3500, model()), 0.1 + 0.1 * 7, 1e-9);
    assert.equal(lane.ourStockCostPct(3501, model()), null, "beyond our seven bins we cannot fill");
    // at $100 our single hop beats the two-hop route (0.12% vs 0.1404%) and would lose to the same reference with no hop (0.1004%)
    const ours100 = lane.ourStockCostPct(100, model())!;
    assert.ok(ours100 < lane.referenceCostPct(100, model()), "the hop is what we save at small sizes");
    assert.ok(ours100 > lane.referenceCostPct(100, model({ hopFeePct: 0 })), "against a one-hop reference the walk across our bins costs more than their impact");
    // ours < theirs while 0.1 + 0.0002 D < 0.14 + 0.00000375 D, i.e. D < $203.8: the share of value in [$100, $204) of a log-uniform [$100, $20,000]
    const b = lane.stockRoutedShareBreakdown(model());
    close(b.gross, (203.8 - 100) / (20_000 - 100), 0.0015, `gross ${b.gross}`);
    assert.equal(b.net, b.gross, "no competitors: nothing to share");
    assert.equal(b.ourDepthUsd, 7000, "7 bins x $500 x both sides");
    // MCD's $149k reference at 1%: ours wins every size we can fill (break-even $4,069 > the $3,500 we hold)
    const mcd = lane.stockRoutedShareBreakdown(model({ ourFeePct: 0.5, refFeePct: 1, refLiquidityUsd: 148_620 }));
    close(mcd.gross, (3500 - 100) / 19_900, 0.003, `MCD gross ${mcd.gross}`);
  });
  await test("monotonic: in our depth and their fees up, in our fee and their liquidity down; 0 when we cannot fill anything", () => {
    const share = (over: Parameters<typeof model>[0]) => lane.stockRoutedShareBreakdown(model(over)).gross;
    let prev = -1;
    for (const d of [100, 300, 500, 1000, 3000, 10_000]) {
      const s = share({ ourDepthPerBinUsd: d });
      assert.ok(s >= prev, `depth ${d}: ${s} < ${prev}`);
      prev = s;
    }
    prev = 2;
    for (const f of [0.05, 0.1, 0.25, 0.5, 1]) {
      const s = share({ ourFeePct: f });
      assert.ok(s <= prev, `our fee ${f}: ${s} > ${prev}`);
      prev = s;
    }
    prev = -1;
    for (const h of [0, 0.02, 0.04, 0.1, 0.3]) {
      const s = share({ hopFeePct: h });
      assert.ok(s >= prev, `hop ${h}: ${s} < ${prev}`);
      prev = s;
    }
    prev = -1;
    for (const f of [0.01, 0.1, 0.25, 1]) {
      const s = share({ refFeePct: f });
      assert.ok(s >= prev, `their fee ${f}: ${s} < ${prev}`);
      prev = s;
    }
    prev = 2;
    for (const l of [50_000, 150_000, 500_000, 2_664_038, 20_000_000]) {
      const s = share({ refLiquidityUsd: l });
      assert.ok(s <= prev, `their liquidity ${l}: ${s} > ${prev}`);
      prev = s;
    }
    assert.equal(share({ ourDepthPerBinUsd: 0 }), 0);
    assert.equal(share({ ourBins: 0 }), 0);
    assert.equal(share({ ourDepthPerBinUsd: 1 }), 0, "seven bins of $1 cannot fill a $100 trade");
    assert.equal(share({ ourFeePct: 5 }), 0, "a 5% fee never beats 0.14% plus impact on a $2.66M pool");
  });
  await test("competing SOL-quoted depth splits the routed flow by depth: equal depth halves it; gross and net are both reported", () => {
    const b = lane.stockRoutedShareBreakdown(model());
    const c = lane.stockRoutedShareBreakdown(model({ competingConcentratedDepthUsd: 7000 }));
    assert.equal(c.gross, b.gross);
    near(c.net, b.gross / 2, 1e-9, "equal depth: half");
    const d = lane.stockRoutedShareBreakdown(model({ competingConcentratedDepthUsd: 63_000 }));
    near(d.net, b.gross / 10, 1e-9, "nine times our depth: a tenth");
  });
  await test("stockPairModel: the seat over the bins, fees per day gross and net, min(vol24h, vol1h x 24), no hop on a SOL-quoted reference, the pool's own fee and bin step", () => {
    const spyRef = { liquidityUsd: 2_664_038, vol24hUsd: 10_515_144, vol1hUsd: null, refFeePct: 0.1 };
    const m = lane.stockPairModel(spyRef, env(), 7000, 7, 1_101_032, { feeBps: 10 });
    assert.equal(m.ourDepthPerBinUsd, 500, "$7,000 seat: $3,500 a side over 7 bins");
    assert.equal(m.binsPerSide, 7);
    assert.equal(m.feeBps, 10);
    assert.equal(m.binStep, 20);
    assert.equal(m.hopFeePct, 0.04);
    assert.equal(m.dailyVolumeUsd, 10_515_144);
    near(m.routedShareGross, lane.stockRoutedShareBreakdown(model()).gross, 1e-9);
    near(m.routedShare, m.routedShareGross * (7000 / (7000 + 1_101_032)), 1e-9);
    near(m.feesPerDayGrossUsd, 10_515_144 * m.routedShareGross * 0.001, 1e-9);
    near(m.feesPerDayUsd, 10_515_144 * m.routedShare * 0.001, 1e-9);
    near(m.routedVolume24hUsd, 10_515_144 * m.routedShare, 1e-9);
    close(m.ourCostAtMinPct!, 0.12, 1e-9);
    close(m.refCostAtMinPct, 0.1404, 1e-4);
    assert.equal(lane.stockPairModel({ ...spyRef, vol1hUsd: 200_000 }, env(), 7000, 7).dailyVolumeUsd, 4_800_000, "the last hour's pace is lower");
    assert.equal(lane.stockPairModel({ ...spyRef, refQuoteIsSol: true }, env(), 7000, 7).hopFeePct, 0, "a SOL-quoted reference is one hop already");
    assert.equal(lane.stockPairModel(spyRef, env(), 0, 7).routedShare, 0, "no seat, no share");
    assert.equal(lane.stockPairModel(spyRef, env(), 7000, 0).routedShare, 0, "no bins, no share");
    assert.equal(lane.stockPairModel(spyRef, env(), 7000, 7).feeBps, 25, "the env's fee unless the pool's own is given");
    assert.equal(lane.stockPairModel(spyRef, env(), 7000, 7).routedShare, 0, "at 25 bps nothing beats 0.14% + impact on $2.66M");
  });
  await test("chooseStockFeeBps: SPY wants the lowest fee (only 10 bps wins any flow), MCD's 1% reference lets us charge 50; nothing routing picks the default; a fixed fee is honoured", () => {
    const spyRef = { liquidityUsd: 2_664_038, vol24hUsd: 10_515_144, vol1hUsd: null, refFeePct: 0.1 };
    const mcdRef = { liquidityUsd: 148_620, vol24hUsd: 1_510_404, vol1hUsd: null, refFeePct: 1 };
    assert.equal(lane.chooseStockFeeBps(spyRef, env(), 5000, 3), 10, "$833 per bin against $2.66M at 0.1%: 10 bps or nothing");
    assert.equal(lane.chooseStockFeeBps(spyRef, env(), 200_000, 7), 10);
    assert.equal(lane.chooseStockFeeBps(mcdRef, env(), 5000, 3), 50, "$833 per bin against $149k at 1%: charge the most");
    assert.equal(lane.chooseStockFeeBps(spyRef, env(), 1500, 7), 25, "$107 per bin: no fee on the menu routes anything, so the default stands");
    assert.equal(lane.chooseStockFeeBps(spyRef, env({ feeBps: 40, feeBpsFixed: true }), 5000, 3), 40, "PAIR_STOCK_FEE_BPS as set");
    assert.equal(lane.chooseStockFeeBps(spyRef, env(), 0, 3), 25, "no seat, the default");
    assert.equal(lane.chooseStockFeeBps({ liquidityUsd: null, vol24hUsd: null, vol1hUsd: null, refFeePct: 0.25 }, env(), 5000, 3), 25, "no reference, the default");
  });

  /* ================= 6. the live builder, offline ========================================== */
  console.log("\nstock pair lane / the live builder (no RPC)");
  await test("pairCreateParams for a stock spec: METAx as X, SOL as Y, bin step 20, the fee's base factor, fees in both tokens, the address from the pair alone; the broadcast gate", () => {
    const p = venue.pairCreateParams({ tokenMint: META, quoteMint: SOL, binStep: 20, feeBps: 10, activeId: 2106, collectFeeMode: "both" });
    assert.equal(p.tokenX.toBase58(), META);
    assert.equal(p.tokenY.toBase58(), SOL, "the quote is Y: the program's quote check is on Y");
    assert.equal(p.binStep, 20);
    assert.equal(p.baseFactor, 5000, "10 bps x 10000 / 20");
    assert.equal(p.collectFeeMode, sdk.CollectFeeMode.InputOnly, "PAIR_STOCK_COLLECT_FEE_MODE=both");
    assert.equal(p.lbPair.toBase58(), venue.pairLbPairAddress(META, SOL));
    assert.equal(venue.pairCreateParams({ tokenMint: META, quoteMint: SOL, binStep: 100, feeBps: 50, activeId: 0, collectFeeMode: "quote" }).lbPair.toBase58(), p.lbPair.toBase58(), "one customizable pool per pair, whatever the parameters");
    assert.match(venue.pairBroadcastRefusal(pair.pairEnv({}), false)!, /^PAIR_LIVE is not true/);
    assert.equal(venue.pairBroadcastRefusal(pair.pairEnv({}), true), null, "dry-run never sends anyway");
  });

  /* ================= 7. the paper walk, through the real functions ========================= */
  console.log("\nstock pair lane / paper");
  venue.clearPairCaches();
  let board: StockPoolRow[] = [...BOARD];
  const perps: Record<string, number | null> = { SPY: 759.485, NVDA: 213.275, META: 671.88 };
  const senv = env({ seatPct: 50 }); // the walk's seat: 50 SOL = $5,000 -> $833 per 0.2% bin over 3 bins a side
  const book = paper.emptyBook(100, 0, T0);
  let clock = T0;
  const fakeConnection = { getAccountInfo: async () => null } as never;
  const liveCands = () => lane.pairStockCandidatesOf(board, HOT);
  const pv = venue.createPairVenue({
    paper: () => book,
    created: () => ({}),
    seatSol: () => 10,
    solPriceUsd: () => SOL_USD,
    screenRows: () => board.map((r) => ({ address: r.address, venue: r.venue, baseMint: r.baseMint, quoteSymbol: r.quoteSymbol, liquidityUsd: r.tvlUsd })),
    ourBins: (address, activeBinId, binsEachSide, spec) => paper.paperBinRows(book, address, activeBinId, binsEachSide, { binStep: spec.binStep, xDecimals: spec.decimals, yDecimals: spec.quoteDecimals }),
    env: () => pair.pairEnv({}),
    hot: () => ({ generatedAt: new Date(clock).toISOString(), tickMs: 1, sources: { trending: 0, dexscreener: 0, onchainReads: 0, errors: [] }, rows: [] }) as HotFile,
    stockRef: (mint) => lane.pairStockCandidateFor(liveCands(), mint),
    stockEnv: () => senv,
    perpMidUsd: (ticker) => perps[ticker] ?? null,
    stockSeatSol: () => 50,
    accountExists: async () => false,
    mintDecimals: async () => 8,
    now: () => clock,
  });
  const KEY = "pair-" + META;
  const snap = (p = pool, bins = 10) => pv.snapshot(p, bins, { solPriceUsd: SOL_USD });
  const pool = await pv.loadPool(fakeConnection, KEY);
  const perpSymbolOf = (s: PoolSnapshot) => (s.pair?.stock && perps[s.pair.stock.ticker] ? `${s.pair.stock.ticker}.US_USDC_PERP` : null);

  /** the loop's observation for a stock pair, as src/index.ts builds it: a stock pool (screen.stock, engine.basis) AND a pair (screen.pair) */
  const observe = (s: PoolSnapshot, positions: PositionSnapshot[], walletToken = 0, oor: Record<string, number> = {}, basisReason: string | null = null): Observation => ({
    ts: new Date(clock).toISOString(), cycle: 1, mode: "dry-run", poolLabel: s.label, snapshot: s, positions,
    wallet: { address: "w", sol: book.wallet.sol, token: walletToken, tokenSymbol: s.baseToken.symbol, quote: book.wallet.sol, quoteSymbol: "SOL" },
    analytics: null,
    state: { actionsToday: 0, lastActionAt: null, lastMoveAt: null, lastPrice: null, killSwitch: false },
    recent: [],
    screen: {
      rank: 0, rankedPools: 400, score: 0, feeToTvl24hPct: null, volume24hUsd: s.pair!.refVol24hUsd, tvlUsd: s.pair!.refLiquidityUsd, ageHours: 9574, priceChange24hPct: 0.47,
      flags: [], watchlisted: false, launch: null, pair: { ok: true, ageHours: 9574, turnover: 2.26 }, recentMovePct: null,
      generatedAt: new Date(clock).toISOString(), stock: s.pair!.stock ?? null, alternatives: [], hot: [],
    },
    portfolio: { activePools: [s.label], poolsWithBands: 0, maxActivePools: 3, otherExposureSol: 0 },
    engine: {
      halt: null, standDown: null, bench: { stops6h: 0, multiplier: 1, benched: false, reason: null }, regime: { medianMove24hPct: 0, multiplier: 1, reason: null },
      sizeMultiplier: 1, effectiveMaxPositionSol: 60, stops: {}, outOfRangeSec: oor, minOutOfRangeSec: 600, knife: null, collectsToday: 0, collectMaxPerDay: 30,
      basis: { session: "regular", minutesToOpen: 0, basisPct: 0, perpSymbol: perpSymbolOf(s), perpMid: s.pair?.stock ? (perps[s.pair.stock.ticker] ?? null) : null, widthMultiplier: 1, reason: basisReason },
    },
  });
  const verdictOf = (decision: Decision, over: Partial<Verdict> = {}): Verdict => ({ proposal: decision, decision, allowed: true, violations: [], overrides: [], passed: [], emergency: false, ...over });
  /** the report's identity: equity - start = realized + marked + hedge - rent locked - rent spent - swap cost - tx fees (held to 1e-8 SOL: the paper wallet rounds every leg to 1e-9) */
  const identity = (b: typeof book) => {
    const eq = paper.bookEquitySol(b);
    const realized = b.closed.reduce((t, c) => t + c.realizedSol, 0) + b.feesClaimedSol;
    const marked = b.bands.reduce((t, x) => t + ((x.lastMark?.valueInSol ?? x.entryValueSol) - x.entryValueSol), 0) + eq.tokensMarkedSol;
    return { lhs: eq.equitySol - b.startSol, rhs: realized + marked + eq.hedgeSol - b.rentLockedSol - b.rentSpentSol - (b.swapCostSol ?? 0) - (b.txFeesSol ?? 0) };
  };
  const r4 = (n: number) => Number(n.toFixed(4)).toString();

  let s0: PoolSnapshot;
  await test("loadPool + the synthetic snapshot: METAx/SOL at 0.2%/bin, the fee the model picks, fees in both tokens, priced from the Backpack perp mid in SOL, the stock model at the pool's own fee", async () => {
    assert.equal(pool.pair.mint, META);
    assert.equal(pool.pair.symbol, "METAx");
    assert.equal(pool.pair.decimals, 8);
    assert.equal(pool.pair.quote, "SOL");
    assert.equal(pool.pair.binStep, 20);
    assert.equal(pool.pair.feeBps, 10, "$833 per bin against a $268k reference at 0.25%: only 10 bps wins the flow");
    assert.equal(pool.pair.collectFeeMode, "both");
    assert.deepEqual(pool.pair.stock, { ticker: "META", issuer: "xstocks" });
    assert.equal(pool.pair.lbPair, venue.pairLbPairAddress(META, SOL));
    assert.equal(pool.dlmm, null);
    s0 = await snap();
    assert.equal(s0.address, KEY);
    assert.equal(s0.label, "METAx/SOL");
    assert.equal(s0.binStep, 20);
    assert.equal(s0.baseFeePct, 0.1);
    assert.equal(s0.tokenX.mint, META, "the stock is X");
    assert.equal(s0.tokenY.mint, SOL, "SOL is Y");
    assert.equal(s0.quoteSymbol, "SOL");
    assert.equal(s0.activeBinId, pair.activeIdFromPrice(671.88 / SOL_USD, 20, 8, 9));
    near(s0.activePrice, 671.88 / SOL_USD, 0.0011, "the perp mid in SOL, within half a 0.2% bin");
    assert.equal(s0.bins.length, 21);
    assert.ok(s0.bins.every((b) => b.xAmount === 0 && b.yAmount === 0), "nobody is in the pool yet");
    const p = s0.pair!;
    assert.deepEqual(p.stock, { ticker: "META", issuer: "xstocks" });
    assert.equal(p.priceSource, "perp");
    assert.equal(p.refGoneCycles, 0);
    assert.equal(p.exists, false);
    assert.equal(p.ours, false);
    assert.equal(p.synthetic, true);
    assert.equal(p.stale, false);
    assert.equal(p.refPool, META_USDC.address);
    assert.equal(p.refVenue, "raydium-clmm/USDC");
    assert.equal(p.refLiquidityUsd, 268_119);
    assert.equal(p.refVol24hUsd, 605_628);
    assert.equal(p.refFeePct, 0.25);
    assert.equal(p.competingDepthUsd, 0);
    assert.equal(p.modelBinsPerSide, 3, "0.6% each side at 0.2%/bin in the regular session");
    assert.equal(p.seatUsd, 5000);
    // ours 0.1 + 0.00012 D < 0.29 + D / 26,812 while D < $2,297; fillable to 3 x $833: the share of value in [$100, $2,297)
    close(p.routedShareGross, (2297 - 100) / 19_900, 0.004, `share ${p.routedShareGross}`);
    assert.equal(p.routedShare, p.routedShareGross, "no SOL-quoted competition for META");
    near(p.feesPerDayUsd, 605_628 * p.routedShare * 0.001, 1e-9);
    assert.equal(p.feesPerDayGrossUsd, p.feesPerDayUsd);
    assert.equal(p.ourShare, 1);
    assert.equal(p.collectFeeMode, "both");
    near(p.creationRentSol, venue.PAIR_CREATION_RENT_SOL, 1e-12);
    near(pv.openCostSol(s0).total, venue.PAIR_OPEN_COST_SOL, 1e-12);
    // MSFT has no perp: priced from the reference pool's USD price
    const msft = await pv.loadPool(fakeConnection, "pair-" + MSFT);
    const ms = await snap(msft);
    assert.equal(ms.pair!.priceSource, "reference");
    near(ms.activePrice, 504.75 / SOL_USD, 0.0011);
    assert.equal(msft.pair.feeBps, 10);
  });

  let opened: Decision;
  await test("the policy proposes a straddle in our own pool (basis ok): half SOL half METAx bought first, 3 bins each side, capped at the lane's seat, the headline saying Hedged.", () => {
    const o = observe(s0, []);
    assert.ok(policy.isStockPool(o) && policy.isPairPool(o) && policy.isStockPairPool(o));
    const r = policy.policyDecide(o, { limits, now: clock, openCostSol: pv.openCostSol(s0).total, pairStock: senv });
    assert.equal(r.decision.action, "OPEN_POSITION", r.reason);
    assert.equal(r.branch, "open");
    const open = r.decision.open!;
    assert.equal(open.side, "BOTH");
    assert.equal(open.binsBelowActive, 3);
    assert.equal(open.binsAboveActive, 3);
    assert.equal(open.amountSol, 25, "half of the 50 SOL seat");
    near(open.amountToken, Math.floor((25 / s0.activePrice) * 1e6) / 1e6, 1e-9, "the other half in METAx at the active price");
    assert.equal(open.acquireToken, open.amountToken, "the wallet holds none: the whole half is bought");
    assert.equal(r.decision.headline, `Made the pair: METAx/SOL on Meteora, 25 SOL + ${r4(open.amountToken)} METAx, 7 bins. Hedged.`);
    assert.match(r.decision.reasoning, /stock pair lane: META \(xstocks\) trades \$605,628 a day across its pools, the deepest on raydium-clmm\/USDC with \$268,119/);
    assert.match(r.decision.reasoning, /\(the Backpack perp mid in SOL\): a Meteora DLMM pool of our own at 0\.2% per bin and 0\.1% fee, fees collected in both tokens/);
    assert.match(r.decision.reasoning, /bound by stock pair lane seat 50 SOL \(50% of the 100 SOL book\)/);
    assert.match(r.decision.reasoning, /Stock routing model: \$833 per 0\.2% bin over 3 bins a side makes our single-hop METAx\/SOL pool the cheaper route for 1[01]\.\d% of META's flow by value against the two-hop route through raydium-clmm\/USDC 3L7KbP \(\$268,119 TVL, 0\.25% fee\): about \$\d+ a day gross, \$\d+ net, at our 0\.1% fee\./);
    assert.match(r.decision.reasoning, /The METAx half is hedged short on Backpack META\.US_USDC_PERP\./);
    assert.match(r.decision.reasoning, /Pool rent 0\.1552 SOL never comes back\. Stock pair lane: capped at 50 SOL \(50% of the 100 SOL book\); the ordinary 15% stop, no maximum hold; closed when META's reference pool is off the board for 3 cycles; every close sells the METAx back to SOL\./);
    assert.match(formatObservation(o), /PAIR LANE: this is OUR OWN pool for METAx \(not created yet/);
    opened = r.decision;
    const v = evaluate(opened, { now: clock, snapshot: s0, positions: [], walletSol: book.wallet.sol, walletToken: 0, walletQuote: book.wallet.sol, state: emptyState("2026-09-14"), killSwitch: false, otherExposureSol: 0, poolsWithBands: 0, maxActivePools: 3, engine: NO_ENGINE, source: "llm", openCostSol: pv.openCostSol(s0).total }, limits);
    assert.deepEqual(v.violations, []);
    assert.ok(v.allowed);
  });
  await test("basisVerdict refuses around the US open and off fair value; the policy holds on it; a pool the model routes nothing to is passed with the payback named", () => {
    const preOpen = sessionClock(new Date("2026-09-14T13:20:00.000Z")); // Monday 09:20 ET
    const gate = basisVerdict(0.1, preOpen);
    assert.equal(gate.ok, false);
    assert.match(gate.reason, /^NYSE opens in 10 min \(< 30\): the open reprices the stock, no new bands until it settles$/);
    const held = policy.policyDecide(observe(s0, [], 0, {}, gate.reason), { limits, now: clock, openCostSol: pv.openCostSol(s0).total, pairStock: senv });
    assert.equal(held.decision.action, "HOLD");
    assert.equal(held.branch, "gated");
    assert.match(held.reason, /NYSE opens in 10 min/);
    const off = basisVerdict(2.5, sessionClock(new Date(T0)));
    assert.match(off.reason, /basis 2\.50% above the Backpack perp exceeds 1%/);
    const justOpened = sessionClock(new Date("2026-09-14T13:40:00.000Z")); // 09:40 ET
    assert.match(basisVerdict(0, justOpened).reason, /NYSE opened 10 min ago \(< 15\)/);
    assert.ok(basisVerdict(0.3, sessionClock(new Date(T0))).ok);
    const none = { ...s0, pair: { ...s0.pair!, feesPerDayUsd: 0, feesPerDayGrossUsd: 0, routedShare: 0, routedShareGross: 0 } };
    const pass = policy.policyDecide(observe(none, []), { limits, now: clock, openCostSol: pv.openCostSol(s0).total, pairStock: senv });
    assert.equal(pass.branch, "not-worth");
    assert.match(pass.reason, /the stock routing model sends none of META's flow to a \$5,000 pool/);
    const slow = { ...s0, pair: { ...s0.pair!, feesPerDayUsd: 2, feesPerDayGrossUsd: 2 } };
    assert.match(policy.policyDecide(observe(slow, []), { limits, now: clock, openCostSol: pv.openCostSol(s0).total, pairStock: senv }).reason, /payback [\d.]+h over the 24h limit/);
  });
  await test("MSFT: no Backpack perp, so the straddle is proposed unhedged and the headline says so", async () => {
    const msft = await pv.loadPool(fakeConnection, "pair-" + MSFT);
    const ms = await snap(msft);
    const o = observe(ms, []);
    assert.equal(o.engine!.basis!.perpSymbol, null);
    const r = policy.policyDecide(o, { limits, now: clock, openCostSol: pv.openCostSol(ms).total, pairStock: senv });
    assert.equal(r.decision.action, "OPEN_POSITION", r.reason);
    assert.match(r.decision.headline, /^Made the pair: MSFTx\/SOL on Meteora, 25 SOL \+ [\d.]+ MSFTx, 7 bins\. Unhedged\.$/);
    assert.match(r.decision.reasoning, /No Backpack perp is listed for MSFTx: the token half runs unhedged\./);
    assert.match(r.decision.reasoning, /\(the reference pool's price in SOL\)/);
    assert.equal(policy.hedgeWord(o), "Unhedged.");
    assert.equal(policy.hedgeWord(observe(s0, [])), "Hedged.");
    // the ordinary straddle headline says it too (policy.ts, W1 in the review)
    const plain = { ...observe(s0, []), snapshot: { ...s0, pair: undefined }, screen: { ...observe(s0, []).screen!, pair: null, tvlUsd: 268_119, feeToTvl24hPct: null } };
    const plainMsft = { ...plain, engine: { ...plain.engine!, basis: { ...plain.engine!.basis!, perpSymbol: null } } };
    const rp = policy.policyDecide({ ...plainMsft, snapshot: { ...plainMsft.snapshot, bins: plainMsft.snapshot.bins.map((b) => ({ ...b, xAmount: 100, yAmount: 500 })), liquidityBelowY: 5000, liquidityAboveX: 1000 } }, { limits, now: clock, env: { book: "stocks" } });
    if (rp.decision.action === "OPEN_POSITION") assert.match(rp.decision.headline, /Unhedged\.$/);
    else assert.doesNotMatch(rp.decision.headline, /Hedged\./);
  });

  let bandAddr: string;
  await test("create -> open in the paper book: the pool is made for META, its rent unrecoverable, the METAx half bought FIRST, the straddle laid; the identity holds", async () => {
    const r = paper.executePaper(verdictOf(opened), { book, snapshot: s0, positions: [], slippagePct: 0.3, now: clock, openCost: pv.openCostSol(s0) });
    assert.ok(r.ok, r.notes.join("; "));
    assert.deepEqual(r.txs.map((t) => t.label.split(" ")[0]), ["create", "swap", "open"], "create the pool, buy the token half, seed the straddle");
    assert.match(r.txs[0].skipped!, /paper: made pair-.* on Meteora DLMM for META \(xstocks\), bin step 20 \(0\.20%\/bin\), base fee 0\.1%, fees collected in both tokens; creation rent 0\.155250 SOL charged, none of it refundable; active bin \d+ from the Backpack perp mid/);
    assert.match(r.txs[1].label, /^swap [\d.]+ SOL -> [\d.]+ METAx$/);
    assert.deepEqual(r.ledger!.map((l) => l.mech), ["rent", "swap", "open"]);
    near(r.ledger![0].rentSol, -venue.PAIR_CREATION_RENT_SOL, 1e-12);
    const made = book.pairPools![KEY];
    assert.ok(made);
    assert.deepEqual(made.stock, { ticker: "META", issuer: "xstocks" });
    assert.equal(made.refPool, META_USDC.address);
    assert.equal(made.refVenue, "raydium-clmm/USDC");
    assert.equal(made.binStep, 20);
    assert.equal(made.feeBps, 10);
    assert.equal(book.bands.length, 1);
    bandAddr = book.bands[0].address;
    assert.equal(book.bands[0].side, "BOTH");
    assert.equal(book.bands[0].quoteDeposit, 25);
    near(book.bands[0].tokenDeposit, opened.open!.amountToken, 1e-9);
    assert.equal(book.bands[0].lowerBinId, s0.activeBinId - 3);
    assert.equal(book.bands[0].upperBinId, s0.activeBinId + 3);
    assert.ok((book.wallet.tokens[META] ?? 0) < 1e-3, "the bought half went into the band");
    const id = identity(book);
    close(id.lhs, id.rhs, 1e-8, "equity identity after the open");
    const s1 = await snap();
    assert.equal(s1.pair!.exists, true);
    assert.equal(s1.pair!.ours, true);
    assert.equal(s1.pair!.creationRentSol, 0);
    assert.ok(s1.bins.some((b) => b.yAmount > 0) && s1.bins.some((b) => b.xAmount > 0), "the synthetic bins show our own deposits");
  });
  await test("mark at the open, then at a perp mid +0.4% ten minutes later: still in range, fees accrue at the model's rate in BOTH tokens, the hedge desk shorts the perp in paper; the identity holds", async () => {
    const p0 = paper.markPool(book, await snap(), { now: clock, fees: null, solPriceUsd: SOL_USD });
    assert.equal(p0.length, 1);
    assert.ok(p0[0].inRange);
    near(p0[0].valueInSol, 50, 0.005, "25 SOL + the METAx half at the active price");
    perps.META = 671.88 * 1.004;
    clock += 10 * M;
    const s2 = await snap();
    assert.equal(s2.activeBinId, s0.activeBinId + 2, "0.4% is two 0.2% bins");
    const p2 = paper.markPool(book, s2, { now: clock, fees: null, solPriceUsd: SOL_USD });
    assert.ok(p2[0].inRange, "two bins up is inside three bins each side");
    const feeTotalSol = (s2.pair!.feesPerDayUsd * 1 * 0.5 * (600 / 86400)) / SOL_USD;
    near(book.bands[0].feeQuote, feeTotalSol / 2, 1e-9, "half the fee in SOL");
    near(book.bands[0].feeToken, feeTotalSol / 2 / s2.tokenPriceInQuote!, 1e-9, "half in METAx: PAIR_STOCK_COLLECT_FEE_MODE=both");
    assert.ok(book.bands[0].feeQuote > 0);
    assert.equal(book.pairPools![KEY].lastRefStale, false);
    // the hedge desk carries the METAx half short on the perp
    const orders: unknown[] = [];
    const market = { symbol: "META.US_USDC_PERP", baseSymbol: "META.US", quoteSymbol: "USDC", marketType: "PERP", rwaMarketType: "STOCK" as const, orderBookState: "Open", fundingInterval: 3600000, visible: true, filters: { tickSize: 0.01, minQuantity: 0.01, maxQuantity: null, stepSize: 0.01 } };
    const client: HedgeClient = { market: async (s) => ({ ...market, symbol: s }), positions: async () => [], canTrade: () => ({ ok: false, reason: "HEDGE_LIVE is not true" }), placeOrder: async (req) => { orders.push(req); throw new Error("never in paper"); } };
    const inventory = paper.paperPoolTokenInventory(book, KEY) + paper.paperTokenBalance(book, META);
    const h = await desk.runHedgeDesk({ pool: KEY, label: "METAx/SOL", ticker: "META", symbol: "META.US_USDC_PERP", baseInventory: inventory, basePrice: perps.META!, fundingRatePerHour: 0.00000625, now: clock, paper: book, client });
    assert.equal(h.journal.side, "Ask");
    assert.equal(h.journal.placed, true);
    assert.equal(h.journal.mode, "paper");
    near(h.journal.quantity, Math.floor(inventory * 100) / 100, 1e-9, "rounded down to the step");
    assert.equal(orders.length, 0);
    assert.equal(paper.paperShortQty(book.hedge!, KEY), h.journal.quantity);
    const id = identity(book);
    close(id.lhs, id.rhs, 1e-8, "identity after the mark and the hedge");
    const r = policy.policyDecide(observe(s2, p2), { limits, now: clock, pairStock: senv });
    assert.equal(r.decision.action, "HOLD");
    assert.equal(r.decision.headline, "In range in our own pool. Fees ticking both ways. Nothing to do.");
  });
  await test("re-centre: the perp runs +1.2% (six bins, three past the band): churn-wait under the minimum, then a REBALANCE through stockBandDecide, executed as close -> shortfall swap -> open; the identity holds", async () => {
    perps.META = 671.88 * 1.012;
    clock += 12 * M;
    const s3 = await snap();
    assert.equal(s3.activeBinId, s0.activeBinId + 6);
    const p3 = paper.markPool(book, s3, { now: clock, fees: null, solPriceUsd: SOL_USD });
    assert.ok(!p3[0].inRange);
    assert.equal(p3[0].binsFromRange, 3);
    const wait = policy.policyDecide(observe(s3, p3, 0, { [bandAddr]: 30 }), { limits, now: clock, pairStock: senv });
    assert.equal(wait.branch, "churn-wait");
    const re = policy.policyDecide(observe(s3, p3, 0, { [bandAddr]: 700 }), { limits, now: clock, openCostSol: pv.openCostSol(s3).total, pairStock: senv });
    assert.equal(re.decision.action, "REBALANCE", re.reason);
    assert.equal(re.branch, "rebalance");
    assert.equal(re.decision.positionAddress, bandAddr);
    assert.equal(re.decision.open!.side, "BOTH");
    assert.equal(re.decision.open!.binsBelowActive, 3);
    assert.match(re.decision.reasoning, /straddle paper- \[\d+, \d+\] in our own METAx\/SOL pool/);
    assert.match(re.decision.reasoning, /Stock routing model:/);
    const r = paper.executePaper(verdictOf(re.decision), { book, snapshot: s3, positions: p3, slippagePct: 0.3, now: clock, openCost: pv.openCostSol(s3) });
    assert.ok(r.ok, r.notes.join("; "));
    assert.deepEqual(r.txs.map((t) => t.label.split(" ")[0]), ["close", "swap", "open"], "the band came back as SOL (the price ran up through it): buy the shortfall, then re-lay");
    assert.equal(book.bands.length, 1);
    assert.equal(book.closed.length, 1);
    assert.equal(book.bands[0].lowerBinId, s3.activeBinId - 3);
    assert.equal(book.bands[0].upperBinId, s3.activeBinId + 3);
    bandAddr = book.bands[0].address;
    const id = identity(book);
    close(id.lhs, id.rhs, 1e-8, "identity after the re-centre");
  });
  await test("the reference disappears from the board: the pool marks at the perp, then at the last price, counts the cycles, and at PAIR_STOCK_REF_GONE_CYCLES the engine EXPIREs it, liquidating; the identity holds and the pool stays on the books", async () => {
    board = BOARD.filter((r) => r.baseMint !== META);
    clock += 5 * M;
    const g1 = await snap();
    assert.equal(g1.pair!.stale, true);
    assert.equal(g1.pair!.refGoneCycles, 1);
    assert.equal(g1.pair!.priceSource, "perp", "the perp still prices it");
    assert.equal(g1.pair!.feesPerDayUsd, 0, "nothing accrues on a reference nobody reports");
    assert.equal(g1.pair!.refVol24hUsd, null);
    paper.markPool(book, g1, { now: clock, fees: null, solPriceUsd: SOL_USD });
    assert.equal(book.pairPools![KEY].lastRefStale, true);
    clock += 5 * M;
    const g2 = await snap();
    assert.equal(g2.pair!.refGoneCycles, 2);
    perps.META = null;
    clock += 5 * M;
    const g3 = await snap();
    assert.equal(g3.pair!.refGoneCycles, 3);
    assert.equal(g3.pair!.priceSource, "last", "no perp and no reference: the last price seen");
    assert.equal(g3.activeBinId, g2.activeBinId);
    const p3 = paper.markPool(book, g3, { now: clock, fees: null, solPriceUsd: SOL_USD });
    const state = emptyState("2026-09-14");
    state.entryValueSol = { [bandAddr]: book.bands[0].entryValueSol };
    const cfg = { outOfRangeSec: 120, knifePct: 20, circuitFloorSol: 0.05, portfolioFloorSol: 0.15, collectMinSol: 0.005, collectFloorSol: 0.001, collectMaxPerDay: 30, skim: false, floatTargetSol: 1, treasuryAddress: "", expectedWallet: "" };
    const base = { now: clock, snapshot: g3, positions: p3, state, engine: emptyEngineState(), cfg, limits, collectsToday: 0 };
    assert.equal(engineDirective({ ...base, pairStock: { ticker: "META", refGoneCycles: 2, maxCycles: senv.refGoneCycles } }), null, "two cycles: not yet (and no launch-lane exit exists for a stock pair)");
    const d = engineDirective({ ...base, pairStock: { ticker: "META", refGoneCycles: g3.pair!.refGoneCycles!, maxCycles: senv.refGoneCycles } });
    assert.ok(d, "a directive");
    assert.equal(d!.kind, "EXPIRE");
    assert.equal(d!.decision.liquidate, true);
    assert.equal(d!.decision.positionAddress, bandAddr);
    assert.match(d!.reason, /^stock pair: META's reference pool has been off the board for 3 cycle\(s\) \(limit 3\): nothing prices our pool, so it is marked at the last price and closed$/);
    assert.equal(d!.decision.headline, "Reference gone. Off the table.");
    const r = paper.executePaper(verdictOf(d!.decision, { emergency: true }), { book, snapshot: g3, positions: p3, slippagePct: 0.3, now: clock, openCost: pv.openCostSol(g3) });
    assert.ok(r.ok, r.notes.join("; "));
    assert.deepEqual(r.txs.map((t) => t.label.split(" ")[0]), ["close", "swap"], "the band comes off and the METAx is sold back to SOL");
    assert.equal(book.bands.length, 0);
    assert.equal(book.closed.length, 2);
    assert.equal(book.closed[1].emergency, true);
    assert.match(book.closed[1].reason, /^EXPIRE: stock pair: META's reference pool/);
    assert.equal(book.wallet.tokens[META], undefined, "no METAx left in the wallet");
    near(book.rentLockedSol, 0, 1e-9, "the position rent came back");
    near(book.rentSpentSol, venue.PAIR_CREATION_RENT_SOL + 2 * dlmm.BIN_ARRAY_RENT_SOL, 1e-9, "the pool's rent did not, nor the re-centre's two bin arrays (the ordinary Meteora open estimate)");
    // the hedge comes off with the inventory
    const client: HedgeClient = { market: async () => null, positions: async () => [], canTrade: () => ({ ok: false, reason: "HEDGE_LIVE is not true" }), placeOrder: async () => { throw new Error("never"); } };
    const flat = await desk.runHedgeDesk({ pool: KEY, label: "METAx/SOL", ticker: "META", symbol: "META.US_USDC_PERP", baseInventory: 0, basePrice: 671.88 * 1.012, fundingRatePerHour: null, now: clock, paper: book, client });
    assert.equal(flat.journal.side, "Bid");
    assert.equal(paper.paperShortQty(book.hedge!, KEY), 0);
    const id = identity(book);
    close(id.lhs, id.rhs, 1e-8, "identity after the liquidation");
    assert.ok(book.pairPools![KEY], "the pool stays on the books: a pool cannot be deleted");
    // with the reference back, the count resets
    board = [...BOARD];
    perps.META = 671.88;
    assert.equal((await snap()).pair!.refGoneCycles, 0);
  });
  await test("the paper report: a MADE PAIRS line with the ticker, the reference, the hedge state and the model's share", () => {
    const sum = paper.paperSummary(book, [], clock);
    assert.equal(sum.pairs.length, 1);
    const line = sum.pairs[0];
    assert.equal(line.address, KEY);
    assert.equal(line.label, "METAx/SOL");
    assert.equal(line.ticker, "META");
    assert.equal(line.reference, "raydium-clmm/USDC 3L7KbP");
    assert.equal(line.house, false);
    assert.equal(line.closedBands, 2);
    assert.equal(line.openBands, 0);
    assert.ok(line.hedge && line.hedge !== "unhedged" && line.hedge.symbol === "META.US_USDC_PERP" && line.hedge.shortQty === 0, "the short was bought back");
    assert.equal(line.stale, true);
    assert.ok(line.feesEarnedSol > 0);
    near(line.rentSol, venue.PAIR_CREATION_RENT_SOL, 1e-12);
    assert.ok(line.swapCostSol > 0);
    const text = paper.renderPaperReport(sum);
    assert.match(text, /MADE PAIRS \(1\)/);
    assert.match(text, new RegExp(`  pair-${META} METAx/SOL {6}META stock, ref raydium-clmm/USDC 3L7KbP, hedge flat \\([-+]\\$[\\d.,]+\\)  0\\.20%/bin fee 0\\.10%  age \\d+ min  0 open/2 closed  routed 0\\.0% \\| 0\\.0% \\(\\$0\\.00/day\\)  REFERENCE GONE`));
    const file = path.join(tmp, "paper-book.json");
    paper.savePaperBook(book, file);
    const back = paper.loadPaperBook(file)!;
    assert.deepEqual(back.pairPools, book.pairPools);
    // an unhedged stock pair reads "unhedged"
    const b2 = paper.emptyBook(10, 0, T0);
    paper.createPairPool(b2, { address: "pair-" + MSFT, mint: MSFT, symbol: "MSFTx", stock: { ticker: "MSFT", issuer: "xstocks" }, refPool: MSFT_USDC.address, refVenue: "raydium-clmm/USDC", quote: "SOL", binStep: 20, feeBps: 10, rentSol: 0.1, now: T0 });
    const t2 = paper.renderPaperReport(paper.paperSummary(b2, [], T0));
    assert.match(t2, /MSFT stock, ref raydium-clmm\/USDC CLu4kF, unhedged/);
  });

  /* ================= 8. the hedge desk: NVDA hedged, MSFT unhedged ========================= */
  console.log("\nstock pair lane / the hedge desk");
  await test("the hedge desk shorts NVDA's perp in paper and leaves MSFT unhedged, saying so", async () => {
    const hb = paper.emptyBook(100, 0, T0);
    const market = { symbol: "NVDA.US_USDC_PERP", baseSymbol: "NVDA.US", quoteSymbol: "USDC", marketType: "PERP", rwaMarketType: "STOCK" as const, orderBookState: "Open", fundingInterval: 3600000, visible: true, filters: { tickSize: 0.01, minQuantity: 0.01, maxQuantity: null, stepSize: 0.01 } };
    const client: HedgeClient = { market: async (s) => (s === market.symbol ? market : null), positions: async () => [], canTrade: () => ({ ok: false, reason: "HEDGE_LIVE is not true" }), placeOrder: async () => { throw new Error("never in paper"); } };
    const nvda = await desk.runHedgeDesk({ pool: "pair-" + NVDA, label: "NVDAx/SOL", ticker: "NVDA", symbol: "NVDA.US_USDC_PERP", baseInventory: 11.7345, basePrice: 213.275, fundingRatePerHour: 0.000043335, now: T0, paper: hb, client });
    assert.deepEqual([nvda.journal.side, nvda.journal.quantity, nvda.journal.placed, nvda.journal.mode, nvda.journal.fillPrice], ["Ask", 11.73, true, "paper", 213.275]);
    assert.match(nvda.lines[0], /paper SOLD 11\.73 NVDA\.US_USDC_PERP at 213\.275/);
    assert.equal(paper.paperShortQty(hb.hedge!, "pair-" + NVDA), 11.73);
    const msft = await desk.runHedgeDesk({ pool: "pair-" + MSFT, label: "MSFTx/SOL", ticker: "MSFT", symbol: null, baseInventory: 4.95, basePrice: 504.75, fundingRatePerHour: null, now: T0, paper: hb, client });
    assert.equal(msft.journal.symbol, null);
    assert.equal(msft.journal.placed, false);
    assert.equal(msft.plan, null);
    assert.match(msft.journal.reason, /^no Backpack perp listed for MSFT: the token half runs unhedged$/);
    assert.equal(hb.hedge!.positions.length, 1, "only NVDA is short");
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} stock pair lane tests passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
