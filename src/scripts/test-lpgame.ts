/**
 * Lay-a-band tests (web/src/game/lpGame.ts, the Play mini-game the room server replays to score the board):
 * the seeded rng against reference mulberry32, determinism, the sigma clamp, the band's bounds, fees only on in-range
 * ticks, narrow vs wide on a flat path, value flat above the band and tracking the token below it, hold math, the
 * score at closeAt, validateChoice, poolParamsFromHot on real and bad rows, a pool's real history (hourlySeries,
 * marketWindow, simulate replaying a Market, historyUrls, seriesOf, candlesOf), and a scan of the source for anything impure.
 * Pure math, no network.
 *   npm run test:lpgame
 *
 * The module lives in web/, outside the root tsconfig's rootDir, so it is loaded at run time instead of imported
 * statically (a static import fails `npm run typecheck` with TS6059). LpGame below mirrors its API, and the first test
 * holds the module's export list and shapes to that mirror.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const MODULE = path.join(__dirname, "../../web/src/game/lpGame.ts");

/** web/src/game/lpGame.ts's API, mirrored */
interface PoolParams {
  label: string;
  address: string;
  feePctPerHour: number;
  volPctPerHour: number;
  binStepBps: number;
  liquidityUsd?: number;
  feeRate?: number;
  baseMint?: string;
}
interface Market {
  path: number[];
  feePct: number[];
  from: number;
}
interface Hour {
  ts: number;
  close: number;
  volUsd: number;
}
interface Choice {
  widthBins: number;
  offsetBins: number;
  closeAt?: number;
}
interface SimResult {
  path: number[];
  lower: number;
  upper: number;
  inRange: boolean[];
  feesPct: number[];
  valuePct: number[];
  holdPct: number[];
  closedAt: number;
  scorePct: number;
}
interface LpGame {
  TICKS: number;
  WIDTH_MIN: number;
  WIDTH_MAX: number;
  rng(seed: number): () => number;
  pricePath(pool: PoolParams, seed: number): number[];
  validateChoice(c: unknown): string | null;
  simulate(pool: PoolParams, seed: number, choice: Choice, market?: Market | null): SimResult;
  poolParamsFromHot(row: unknown): PoolParams | null;
  MARKET_HOURS: number;
  hourlySeries(candles: unknown, volumeUsd?: unknown): Hour[];
  seriesOf(history: unknown): Hour[];
  marketWindow(series: Hour[], start: number, pool: PoolParams): Market | null;
  historyUrls(pool: PoolParams): { price: string; volume: string } | null;
  candlesOf(body: unknown): unknown[] | null;
}

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err);
    process.exit(1);
  }
}
const near = (a: number, b: number, tol = 1e-9, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), msg ?? `expected ${b}, got ${a}`);

/** a real hot.json row (CARDS / USDC, 2026-09-24), trimmed to the fields that matter plus a few that do not */
const CARDS_ROW = {
  address: "2N1KNuLSt167P6p9P8HYcisTvTTv4vYTM8QJBbtv1xYU",
  name: "CARDS / USDC",
  venue: "meteora-dlmm",
  feePct: 0.2,
  feeToTvl1hPct: 0.696,
  priceChange5mPct: -0.4,
  priceChange1hPct: 2.43,
  priceChange24hPct: -11.65,
  heat: 54.5,
};

/** the canonical mulberry32, written out independently */
function mulberry32Ref(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const lp = (await import(MODULE)) as LpGame;
  const { pricePath, poolParamsFromHot, rng, simulate, TICKS, validateChoice, WIDTH_MAX, WIDTH_MIN } = lp;
  const { MARKET_HOURS, hourlySeries, seriesOf, marketWindow, historyUrls, candlesOf } = lp;

  const CARDS = poolParamsFromHot(CARDS_ROW)!;
  const pool = (over: Partial<PoolParams> = {}): PoolParams => ({ ...CARDS, ...over });
  /** the tiniest vol clamps to sigma 0.003: a nearly flat hour-by-hour path */
  const FLAT = pool({ volPctPerHour: 0.0001, binStepBps: 100, feePctPerHour: 0.5 });
  /** the wildest vol clamps to sigma 0.08 */
  const WILD = pool({ volPctPerHour: 15, binStepBps: 20, feePctPerHour: 0.5 });

  /** the first seed in 1..2000 whose round satisfies pred */
  const findSeed = (p: PoolParams, choice: Choice, pred: (r: SimResult) => boolean): number => {
    for (let seed = 1; seed <= 2000; seed++) if (pred(simulate(p, seed, choice))) return seed;
    throw new Error("no seed in 1..2000 fits");
  };

  test("the module exports exactly the agreed API", () => {
    const names = Object.keys(lp).filter((k) => k !== "default" && k !== "__esModule");
    assert.deepEqual(names.sort(), [
      "MARKET_HOURS", "TICKS", "WIDTH_MAX", "WIDTH_MIN", "candlesOf", "historyUrls", "hourlySeries", "marketWindow",
      "poolParamsFromHot", "pricePath", "rng", "seriesOf", "simulate", "validateChoice",
    ]);
    assert.equal(MARKET_HOURS, 49);
    assert.equal(TICKS, 48);
    assert.equal(WIDTH_MIN, 3);
    assert.equal(WIDTH_MAX, 120);
    const arity: [unknown, number][] = [
      [rng, 1],
      [pricePath, 2],
      [validateChoice, 1],
      [simulate, 4],
      [poolParamsFromHot, 1],
      [hourlySeries, 2],
      [seriesOf, 1],
      [marketWindow, 3],
      [historyUrls, 1],
      [candlesOf, 1],
    ];
    for (const [fn, n] of arity) {
      assert.equal(typeof fn, "function");
      assert.equal((fn as (...a: unknown[]) => unknown).length, n);
    }
    const r = simulate(CARDS, 1, { widthBins: 20, offsetBins: 0 });
    assert.deepEqual(Object.keys(r).sort(), ["closedAt", "feesPct", "holdPct", "inRange", "lower", "path", "scorePct", "upper", "valuePct"]);
    assert.deepEqual(Object.keys(CARDS).sort(), ["address", "binStepBps", "feePctPerHour", "feeRate", "label", "volPctPerHour"]);
  });

  test("rng is mulberry32: matches the reference draw for draw and stays in [0, 1)", () => {
    for (const seed of [0, 1, 42, 123456789, 0x7fffffff, 2 ** 32 - 1, -7]) {
      const a = rng(seed);
      const b = mulberry32Ref(seed);
      for (let i = 0; i < 500; i++) {
        const x = a();
        assert.equal(x, b(), `seed ${seed} draw ${i}`);
        assert.ok(x >= 0 && x < 1);
      }
    }
    // two generators with the same seed do not share state
    const g1 = rng(9);
    const g2 = rng(9);
    g1();
    g1();
    assert.equal(g2(), mulberry32Ref(9)());
  });

  test("determinism: the same seed gives an identical path and result; different seeds differ", () => {
    const choice: Choice = { widthBins: 20, offsetBins: 2, closeAt: 30 };
    assert.deepEqual(pricePath(CARDS, 777), pricePath(CARDS, 777));
    assert.deepEqual(simulate(CARDS, 777, choice), simulate(CARDS, 777, choice));
    assert.equal(simulate(CARDS, 777, choice).scorePct, simulate(CARDS, 777, { ...choice }).scorePct);
    const paths = [1, 2, 3, 777, 778].map((s) => JSON.stringify(pricePath(CARDS, s)));
    assert.equal(new Set(paths).size, paths.length, "five seeds, five different paths");
    // the path depends on the pool only through its vol
    assert.deepEqual(pricePath(pool({ feePctPerHour: 3, binStepBps: 80, label: "X", address: "Y" }), 5), pricePath(CARDS, 5));
  });

  test("path shape: TICKS+1 prices, path[0] = 1, all positive and finite", () => {
    for (const p of [FLAT, CARDS, WILD]) {
      const path = pricePath(p, 31337);
      assert.equal(path.length, TICKS + 1);
      assert.equal(path[0], 1);
      for (const x of path) assert.ok(Number.isFinite(x) && x > 0);
    }
  });

  test("sigma clamps to [0.003, 0.08]: vol 0 walks like 0.3, vol 1000 like 8, and the step sizes fit", () => {
    assert.deepEqual(pricePath(pool({ volPctPerHour: 0 }), 11), pricePath(pool({ volPctPerHour: 0.3 }), 11));
    assert.deepEqual(pricePath(pool({ volPctPerHour: 1000 }), 11), pricePath(pool({ volPctPerHour: 8 }), 11));
    // the log steps are sigma * z - sigma^2/2 for the rng's own normals: rebuild them from the reference generator
    const sigma = 2.43 / 100;
    const r = mulberry32Ref(4242);
    const path = pricePath(CARDS, 4242);
    for (let t = 1; t <= TICKS; t++) {
      const u1 = 1 - r();
      const u2 = r();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      near(path[t], path[t - 1] * Math.exp(sigma * z - (sigma * sigma) / 2), 1e-12, `tick ${t}`);
    }
    // and over many seeds the per-tick log return has roughly that sd around a mean of -sigma^2/2
    let n = 0;
    let sum = 0;
    let ss = 0;
    for (let s = 1; s <= 200; s++) {
      const pp = pricePath(CARDS, s);
      for (let t = 1; t <= TICKS; t++) {
        const lr = Math.log(pp[t] / pp[t - 1]);
        sum += lr;
        ss += lr * lr;
        n++;
      }
    }
    const mean = sum / n;
    near(Math.sqrt(ss / n - mean * mean), sigma, 0.05);
    assert.ok(Math.abs(mean + (sigma * sigma) / 2) < 3 * (sigma / Math.sqrt(n)), `mean log step ${mean}`);
  });

  test("the path is a martingale: at sigma 0.08 the mean final price over 2000 seeds is about 1", () => {
    const N = 2000;
    let sum = 0;
    let logSum = 0;
    for (let s = 1; s <= N; s++) {
      const end = pricePath(WILD, s)[TICKS];
      sum += end;
      logSum += Math.log(end);
    }
    const mean = sum / N;
    // one standard error here is about 0.013, so 5% is a loose bound; the old uncorrected walk averaged about 1.17
    assert.ok(Math.abs(mean - 1) < 0.05, `mean final price ${mean}`);
    // the median sits below 1 instead: mean log price ~ -TICKS * sigma^2 / 2 = -0.1536 (one standard error ~0.012)
    assert.ok(Math.abs(logSum / N + TICKS * 0.0032) < 0.05, `mean final log price ${logSum / N}`);
  });

  test("the band's bounds: (1+s)^(offset -/+ width/2) around p0 = 1", () => {
    const r = simulate(pool({ binStepBps: 20 }), 1, { widthBins: 10, offsetBins: 0 });
    near(r.lower, 1.002 ** -5);
    near(r.upper, 1.002 ** 5);
    near(r.lower * r.upper, 1, 1e-12, "a centred band is symmetric in log price");
    const up = simulate(pool({ binStepBps: 20 }), 1, { widthBins: 11, offsetBins: 3 });
    near(up.lower, 1.002 ** (3 - 5.5));
    near(up.upper, 1.002 ** (3 + 5.5));
    const above = simulate(CARDS, 1, { widthBins: 10, offsetBins: 5 });
    near(above.lower, 1, 1e-12);
    assert.equal(above.inRange[0], true, "p0 on the edge counts as inside");
  });

  test("fees accrue only on in-range ticks, a fixed amount each, never at tick 0", () => {
    const choice: Choice = { widthBins: 8, offsetBins: 0 };
    const seed = findSeed(WILD, choice, (r) => r.inRange.slice(1).includes(true) && r.inRange.slice(1).includes(false));
    const r = simulate(WILD, seed, choice);
    const perTick = 100 * (0.5 / 100) * 5; // concentration 40/8 = 5
    assert.equal(r.feesPct[0], 0);
    let inTicks = 0;
    for (let t = 1; t <= TICKS; t++) {
      const inside = r.path[t] >= r.lower && r.path[t] <= r.upper;
      assert.equal(r.inRange[t], inside, `inRange at ${t}`);
      near(r.feesPct[t] - r.feesPct[t - 1], inside ? perTick : 0, 1e-9, `fee step at ${t}`);
      if (inside) inTicks++;
    }
    near(r.feesPct[TICKS], inTicks * perTick);
    assert.ok(inTicks > 0 && inTicks < TICKS);
  });

  test("concentration is 40 / width, capped at 6: 3 bins earn 6x, 40 bins 1x, 120 bins 1/3x", () => {
    // flat path, a wide bin step: every band holds all TICKS ticks on these seeds
    const cases: [number, number][] = [
      [3, 6],
      [40, 1],
      [120, 1 / 3],
    ];
    for (const [w, conc] of cases) {
      const r = simulate(pool({ volPctPerHour: 0, binStepBps: 100, feePctPerHour: 0.4 }), 3, { widthBins: w, offsetBins: 0 });
      assert.ok(r.inRange.every(Boolean), `width ${w} stays in range on this seed`);
      near(r.feesPct[TICKS], TICKS * 0.4 * conc, 1e-9, `width ${w}`);
    }
  });

  test("on a flat path a narrow band earns more fees than a wide one", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const narrow = simulate(FLAT, seed, { widthBins: 12, offsetBins: 0 });
      const wide = simulate(FLAT, seed, { widthBins: 120, offsetBins: 0 });
      assert.ok(narrow.feesPct[TICKS] > wide.feesPct[TICKS], `seed ${seed}: ${narrow.feesPct[TICKS]} vs ${wide.feesPct[TICKS]}`);
    }
  });

  test("price above the band: value is flat (all quote); below it: value tracks the token", () => {
    const choice: Choice = { widthBins: 10, offsetBins: 0 };
    const seed = findSeed(WILD, choice, (r) => r.path.some((p) => p > r.upper * 1.05) && r.path.some((p) => p < r.lower * 0.95));
    const r = simulate(WILD, seed, choice);
    const sa = Math.sqrt(r.lower);
    const sb = Math.sqrt(r.upper);
    const L = 100 / (1 - 1 / sb + (1 - sa));
    const allQuote = L * (sb - sa);
    const tokenPerP = L * (1 / sa - 1 / sb);
    let above = 0;
    let below = 0;
    for (let t = 0; t <= TICKS; t++) {
      const p = r.path[t];
      if (p > r.upper) {
        near(r.valuePct[t], allQuote, 1e-12, `flat above at ${t}`);
        above++;
      } else if (p < r.lower) {
        near(r.valuePct[t] / p, tokenPerP, 1e-12, `tracks the token below at ${t}`);
        below++;
      }
    }
    assert.ok(above > 0 && below > 0);
    // exits are worse than holding: all quote above undershoots the hold, and all token below does too
    for (let t = 0; t <= TICKS; t++) assert.ok(r.valuePct[t] <= r.holdPct[t] + 1e-9, `no gain over holding at ${t}`);
  });

  test("hold math: a centred band starts 50/50, an edge on p0 starts all token or all quote", () => {
    const centred = simulate(CARDS, 21, { widthBins: 30, offsetBins: 0 });
    near(centred.valuePct[0], 100);
    near(centred.holdPct[0], 100);
    for (let t = 0; t <= TICKS; t++) near(centred.holdPct[t], 50 * centred.path[t] + 50, 1e-9, `50/50 hold at ${t}`);

    // band entirely above p0 (lower = 1): all token, so holding tracks price one for one
    const allToken = simulate(CARDS, 21, { widthBins: 30, offsetBins: 15 });
    for (let t = 0; t <= TICKS; t++) near(allToken.holdPct[t], 100 * allToken.path[t], 1e-9, `all-token hold at ${t}`);

    // band entirely below p0 (upper = 1): all quote, so holding is flat at 100
    const allQuote = simulate(CARDS, 21, { widthBins: 30, offsetBins: -15 });
    for (let t = 0; t <= TICKS; t++) near(allQuote.holdPct[t], 100, 1e-9, `all-quote hold at ${t}`);

    // an off-centre band: the hold is the p0 amounts, token0 * P + quote0
    const off = simulate(CARDS, 21, { widthBins: 30, offsetBins: 6 });
    const sa = Math.sqrt(off.lower);
    const sb = Math.sqrt(off.upper);
    const L = 100 / (1 - 1 / sb + (1 - sa));
    for (let t = 0; t <= TICKS; t++) near(off.holdPct[t], L * (1 - 1 / sb) * off.path[t] + L * (1 - sa), 1e-9);
  });

  test("the score: value + fees - hold at closeAt, two decimals; the books stay shut after it", () => {
    for (const closeAt of [1, 7, 24, TICKS]) {
      const r = simulate(CARDS, 99, { widthBins: 16, offsetBins: -2, closeAt });
      assert.equal(r.closedAt, closeAt);
      const raw = r.valuePct[closeAt] + r.feesPct[closeAt] - r.holdPct[closeAt];
      assert.equal(r.scorePct, Math.round(raw * 100) / 100 || 0);
      assert.equal(r.scorePct, Number(r.scorePct.toFixed(2)), "two decimals");
      assert.equal(r.path.length, TICKS + 1);
      for (const arr of [r.inRange, r.feesPct, r.valuePct, r.holdPct]) assert.equal(arr.length, TICKS + 1);
      for (let t = closeAt + 1; t <= TICKS; t++) {
        assert.equal(r.feesPct[t], r.feesPct[closeAt]);
        assert.equal(r.valuePct[t], r.valuePct[closeAt]);
        assert.equal(r.holdPct[t], r.holdPct[closeAt]);
      }
      // before the close, the arrays match a full-length round
      const full = simulate(CARDS, 99, { widthBins: 16, offsetBins: -2 });
      assert.deepEqual(r.path, full.path);
      assert.deepEqual(r.inRange, full.inRange);
      assert.deepEqual(r.valuePct.slice(0, closeAt + 1), full.valuePct.slice(0, closeAt + 1));
      assert.deepEqual(r.feesPct.slice(0, closeAt + 1), full.feesPct.slice(0, closeAt + 1));
    }
    assert.equal(simulate(CARDS, 99, { widthBins: 16, offsetBins: -2 }).closedAt, TICKS);
    // closing early and late on the same path score differently somewhere
    const scores = new Set([6, 18, 30, 48].map((c) => simulate(WILD, 5, { widthBins: 10, offsetBins: 0, closeAt: c }).scorePct));
    assert.ok(scores.size > 1);
    // a score is never -0
    for (let s = 1; s <= 100; s++) assert.ok(!Object.is(simulate(FLAT, s, { widthBins: 120, offsetBins: 0, closeAt: 1 }).scorePct, -0));
  });

  test("simulate leaves its inputs alone and throws on a bad choice or pool", () => {
    const choice = { widthBins: 12, offsetBins: 1, closeAt: 10 };
    const p = pool();
    const before = JSON.stringify([choice, p]);
    simulate(p, 3, choice);
    assert.equal(JSON.stringify([choice, p]), before);
    assert.throws(() => simulate(CARDS, 1, { widthBins: 2, offsetBins: 0 }), /widthBins/);
    assert.throws(() => simulate(CARDS, 1, { widthBins: 10, offsetBins: 6 }), /offsetBins/);
    assert.throws(() => simulate(pool({ binStepBps: 0 }), 1, { widthBins: 10, offsetBins: 0 }), /binStepBps/);
    assert.throws(() => simulate(pool({ feePctPerHour: NaN }), 1, { widthBins: 10, offsetBins: 0 }), /feePctPerHour/);
    assert.throws(() => pricePath(pool({ volPctPerHour: Infinity }), 1), /volPctPerHour/);
  });

  test("validateChoice accepts playable choices", () => {
    const good: unknown[] = [
      { widthBins: WIDTH_MIN, offsetBins: 0 },
      { widthBins: WIDTH_MAX, offsetBins: 60 },
      { widthBins: WIDTH_MAX, offsetBins: -60 },
      { widthBins: 3, offsetBins: -1 },
      { widthBins: 3, offsetBins: 1 },
      { widthBins: 20, offsetBins: 10, closeAt: 1 },
      { widthBins: 20, offsetBins: 0, closeAt: TICKS },
      { widthBins: 20, offsetBins: 0, closeAt: undefined },
      { widthBins: 20, offsetBins: 0, extra: "ignored", name: "<script>" },
      JSON.parse('{"widthBins":40,"offsetBins":-3,"closeAt":12}'),
    ];
    for (const c of good) assert.equal(validateChoice(c), null, JSON.stringify(c));
  });

  test("validateChoice rejects bad widths, offsets, closeAt and types", () => {
    const bad: [unknown, RegExp][] = [
      [null, /object/],
      [undefined, /object/],
      ["20,0", /object/],
      [42, /object/],
      [[20, 0], /object/],
      [{}, /widthBins/],
      [{ widthBins: 2, offsetBins: 0 }, /widthBins/],
      [{ widthBins: 121, offsetBins: 0 }, /widthBins/],
      [{ widthBins: 10.5, offsetBins: 0 }, /widthBins/],
      [{ widthBins: "20", offsetBins: 0 }, /widthBins/],
      [{ widthBins: NaN, offsetBins: 0 }, /widthBins/],
      [{ widthBins: Infinity, offsetBins: 0 }, /widthBins/],
      [{ widthBins: 20 }, /offsetBins/],
      [{ widthBins: 20, offsetBins: 11 }, /offsetBins/],
      [{ widthBins: 20, offsetBins: -11 }, /offsetBins/],
      [{ widthBins: 3, offsetBins: 2 }, /offsetBins/],
      [{ widthBins: 20, offsetBins: 0.5 }, /offsetBins/],
      [{ widthBins: 20, offsetBins: "0" }, /offsetBins/],
      [{ widthBins: 20, offsetBins: null }, /offsetBins/],
      [{ widthBins: 20, offsetBins: 0, closeAt: 0 }, /closeAt/],
      [{ widthBins: 20, offsetBins: 0, closeAt: TICKS + 1 }, /closeAt/],
      [{ widthBins: 20, offsetBins: 0, closeAt: 2.5 }, /closeAt/],
      [{ widthBins: 20, offsetBins: 0, closeAt: "12" }, /closeAt/],
      [{ widthBins: 20, offsetBins: 0, closeAt: null }, /closeAt/],
      [{ widthBins: 20, offsetBins: 0, closeAt: NaN }, /closeAt/],
    ];
    for (const [c, why] of bad) {
      const got = validateChoice(c);
      assert.ok(got !== null && why.test(got), `${String(JSON.stringify(c))} -> ${got}`);
      assert.ok(got.length < 80, "a short reason");
    }
  });

  test("poolParamsFromHot on a real row: fee per hour, vol from the bigger move, fee tier as bin step", () => {
    assert.deepEqual(poolParamsFromHot(CARDS_ROW), {
      label: "CARDS / USDC",
      address: "2N1KNuLSt167P6p9P8HYcisTvTTv4vYTM8QJBbtv1xYU",
      feePctPerHour: 0.696,
      volPctPerHour: 2.43, // |2.43| beats |-0.4| * sqrt(12) = 1.39
      binStepBps: 20,
      feeRate: 0.002, // no volume or fees on the row: the fee tier
    });
    // the 5-minute move, scaled to an hour, wins when it is bigger (SILV / SOL, same day)
    const silv = poolParamsFromHot({ address: "S1", name: "SILV / SOL", feePct: 1, feeToTvl1hPct: 0.2119, priceChange1hPct: 3.51, priceChange5mPct: 2.87 })!;
    near(silv.volPctPerHour, 2.87 * Math.sqrt(12));
    assert.equal(silv.binStepBps, 100);
    // price changes missing (null in hot.json): the 0.5 floor
    const quiet = poolParamsFromHot({ address: "X1", name: "xHYPE / USDC", feePct: 2, feeToTvl1hPct: 0.1763, priceChange1hPct: null, priceChange5mPct: null })!;
    assert.equal(quiet.volPctPerHour, 0.5);
    assert.equal(quiet.binStepBps, 100, "a 2% tier caps at 100 bps");
    // odd fee tiers round, tiny ones floor at 10 bps
    assert.equal(poolParamsFromHot({ ...CARDS_ROW, feePct: 0.6118066999999999 })!.binStepBps, 61);
    assert.equal(poolParamsFromHot({ ...CARDS_ROW, feePct: 0.01 })!.binStepBps, 10);
    // clamps: fee per hour to [0, 5], vol to 15
    assert.equal(poolParamsFromHot({ ...CARDS_ROW, feeToTvl1hPct: 40 })!.feePctPerHour, 5);
    assert.equal(poolParamsFromHot({ ...CARDS_ROW, feeToTvl1hPct: -1 })!.feePctPerHour, 0);
    assert.equal(poolParamsFromHot({ ...CARDS_ROW, priceChange1hPct: -80 })!.volPctPerHour, 15);
    // and it plays
    const r = simulate(poolParamsFromHot(CARDS_ROW)!, 1, { widthBins: 20, offsetBins: 0 });
    assert.ok(Number.isFinite(r.scorePct));
  });

  test("poolParamsFromHot returns null for unusable rows", () => {
    const bad: unknown[] = [
      null,
      undefined,
      "CARDS / USDC",
      7,
      [CARDS_ROW],
      {},
      { ...CARDS_ROW, address: undefined },
      { ...CARDS_ROW, address: "" },
      { ...CARDS_ROW, address: 12 },
      { ...CARDS_ROW, name: undefined },
      { ...CARDS_ROW, name: "  " },
      { ...CARDS_ROW, feeToTvl1hPct: undefined },
      { ...CARDS_ROW, feeToTvl1hPct: null },
      { ...CARDS_ROW, feeToTvl1hPct: NaN },
      { ...CARDS_ROW, feeToTvl1hPct: Infinity },
      { ...CARDS_ROW, feeToTvl1hPct: "0.696" },
      { ...CARDS_ROW, feePct: undefined },
      { ...CARDS_ROW, feePct: null },
      { ...CARDS_ROW, feePct: 0 },
      { ...CARDS_ROW, feePct: -0.2 },
      { ...CARDS_ROW, feePct: "0.2" },
    ];
    for (const row of bad) assert.equal(poolParamsFromHot(row), null, String(JSON.stringify(row)));
  });

  // ---------------------------------------------------------------- the pool's real history

  const H = 3600;
  const T0 = 1_790_000_000 - (1_790_000_000 % H);
  /** GeckoTerminal-shaped candles, newest first: [ts, o, h, l, c, v] for each (hour offset, close, volume) */
  const candles = (rows: [number, number, number][]) => rows.map(([k, c, v]) => [T0 + k * H, c, c, c, c, v]).reverse();
  const LIQ = pool({ liquidityUsd: 200_000, feeRate: 0.01 });

  test("hourlySeries: oldest first, silent hours filled with the last close, a long silence restarts it, bad rows skipped", () => {
    const s = hourlySeries(candles([[0, 10, 100], [1, 11, 50], [4, 12, 70], [5, 13, 0]]));
    assert.deepEqual(s.map((h) => [h.ts - T0, h.close, h.volUsd]), [
      [0, 10, 100], [H, 11, 50], [2 * H, 11, 0], [3 * H, 11, 0], [4 * H, 12, 70], [5 * H, 13, 0],
    ]);
    // 13 silent hours is past the 12 filled: the series starts again after the silence
    const r = hourlySeries(candles([[0, 10, 1], [1, 10, 1], [15, 20, 5], [16, 21, 6]]));
    assert.deepEqual(r.map((h) => h.ts - T0), [15 * H, 16 * H]);
    // junk: not arrays, short, off the hour, a zero or negative close, a negative volume, strings; a duplicate hour once
    const junk = [null, 7, [T0], [T0 + 60, 1, 1, 1, 1, 1], [T0, 1, 1, 1, 0, 1], [T0, 1, 1, 1, -2, 1], [T0, 1, 1, 1, 5, -1], [String(T0), 1, 1, 1, 5, 1]];
    assert.deepEqual(hourlySeries([...junk, [T0, 1, 1, 1, 5, 2], [T0, 1, 1, 1, 6, 3]]).map((h) => [h.close, h.volUsd]), [[6, 3]]);
    assert.deepEqual(hourlySeries(null), []);
    assert.deepEqual(hourlySeries({ ohlcv_list: [] }), []);
    // at most 240 hours, the newest
    const long = hourlySeries(candles(Array.from({ length: 300 }, (_, k) => [k, 1 + k, 1] as [number, number, number])));
    assert.equal(long.length, 240);
    assert.equal(long[0].ts, T0 + 60 * H);
  });

  test("hourlySeries with a USD read: closes from the quote-priced candles, each hour's volume from the USD ones", () => {
    // a SOL pair: priced in SOL, its volume counted in SOL; the USD read has the same hours in dollars
    const inSol = candles([[0, 0.00007, 12], [1, 0.000071, 15], [3, 0.000072, 9]]);
    const inUsd = candles([[0, 0.0081, 1400], [1, 0.0082, 1750], [3, 0.0083, 1050], [9, 1, 1]]);
    const s = hourlySeries(inSol, inUsd);
    assert.deepEqual(s.map((h) => [h.ts - T0, h.close, h.volUsd]), [
      [0, 0.00007, 1400], [H, 0.000071, 1750], [2 * H, 0.000071, 0], [3 * H, 0.000072, 1050],
    ]);
    // an hour the USD read lacks has no volume
    assert.equal(hourlySeries(inSol, candles([[0, 1, 5]]))[1].volUsd, 0);
    // seriesOf: a History, or bare candles (their own volume); anything else is no hours
    assert.deepEqual(seriesOf({ price: inSol, volume: inUsd }), s);
    assert.deepEqual(seriesOf(inSol), hourlySeries(inSol));
    for (const bad of [null, {}, { price: inSol }, { price: "x", volume: inUsd }]) assert.deepEqual(seriesOf(bad), []);
  });

  test("marketWindow: prices over the first close, each hour's fees from its volume over liquidity, clamped", () => {
    const rows = Array.from({ length: 60 }, (_, k) => [k, 100 + k, k * 1000] as [number, number, number]);
    const series = hourlySeries(candles(rows));
    const m = marketWindow(series, 5, LIQ)!;
    assert.equal(m.path.length, TICKS + 1);
    assert.equal(m.feePct.length, TICKS + 1);
    assert.equal(m.path[0], 1);
    near(m.path[10], 115 / 105);
    assert.equal(m.feePct[0], 0);
    near(m.feePct[3], ((8000 * 0.01) / 200_000) * 100); // hour 5+3: $8k volume, 1% fee, $200k liquidity
    assert.equal(m.from, T0 + 5 * H + H, "the stretch starts at its first hour's close");
    // the last start that fits, and one past it
    assert.ok(marketWindow(series, 60 - MARKET_HOURS, LIQ));
    assert.equal(marketWindow(series, 60 - MARKET_HOURS + 1, LIQ), null);
    assert.equal(marketWindow(series, -1, LIQ), null);
    assert.equal(marketWindow(series, 1.5, LIQ), null);
    // no liquidity or fee share to price the fees by: no market
    assert.equal(marketWindow(series, 0, pool({ liquidityUsd: undefined, feeRate: 0.01 })), null);
    assert.equal(marketWindow(series, 0, pool({ liquidityUsd: 0, feeRate: 0.01 })), null);
    assert.equal(marketWindow(series, 0, pool({ liquidityUsd: 1e5, feeRate: undefined })), null);
    // a wild hour clamps at 5% of liquidity
    const wild = hourlySeries(candles(Array.from({ length: 49 }, (_, k) => [k, 1, 1e9] as [number, number, number])));
    assert.equal(marketWindow(wild, 0, LIQ)!.feePct[1], 5);
  });

  test("simulate replays a market: its path, its hours' own fees, and the seed plays no part", () => {
    const up = Array.from({ length: TICKS + 1 }, (_, t) => 1.001 ** t);
    const fee = Array.from({ length: TICKS + 1 }, (_, t) => (t === 0 ? 0 : t % 2 ? 0.2 : 0.05));
    const m = { path: up, feePct: fee, from: T0 };
    const a = simulate(CARDS, 1, { widthBins: 120, offsetBins: 0 }, m);
    const b = simulate(CARDS, 999, { widthBins: 120, offsetBins: 0 }, m);
    assert.deepEqual(a, b);
    assert.deepEqual(a.path, up);
    // a 120-bin band at 20 bps holds a 4.9% climb: every hour in range, each paying its own fee at concentration 40/120
    assert.ok(a.inRange.every(Boolean));
    near(a.feesPct[TICKS], fee.reduce((x, y) => x + y, 0) * (40 / 120));
    near(a.feesPct[2] - a.feesPct[1], 0.05 * (40 / 120));
    // closing early still scores on the market
    const c = simulate(CARDS, 1, { widthBins: 120, offsetBins: 0, closeAt: 10 }, m);
    near(c.scorePct, Math.round((c.valuePct[10] + c.feesPct[10] - c.holdPct[10]) * 100) / 100, 1e-12);
    // null is the simulated path
    assert.deepEqual(simulate(CARDS, 5, { widthBins: 20, offsetBins: 0 }, null), simulate(CARDS, 5, { widthBins: 20, offsetBins: 0 }));
    // a malformed market is refused
    for (const bad of [
      { ...m, path: up.slice(1) },
      { ...m, feePct: fee.slice(1) },
      { ...m, path: up.map((p, t) => (t === 0 ? 1.1 : p)) },
      { ...m, path: up.map((p, t) => (t === 3 ? 0 : p)) },
      { ...m, feePct: fee.map((f, t) => (t === 3 ? -1 : f)) },
      { ...m, feePct: fee.map((f, t) => (t === 3 ? NaN : f)) },
    ]) assert.throws(() => simulate(CARDS, 1, { widthBins: 20, offsetBins: 0 }, bad), /bad market/);
  });

  test("poolParamsFromHot: liquidity, the fee share as it ran, and the base mint", () => {
    const row = { ...CARDS_ROW, liquidityUsd: 323824.38, fees1hUsd: 1000, vol1hUsd: 94117.6, baseMint: "XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2" };
    const p = poolParamsFromHot(row)!;
    assert.equal(p.liquidityUsd, 323824.38);
    near(p.feeRate!, 1000 / 94117.6);
    assert.equal(p.baseMint, "XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2");
    // no volume, no fees, or a share over 10%: the fee tier
    assert.equal(poolParamsFromHot({ ...row, vol1hUsd: 0 })!.feeRate, 0.002);
    assert.equal(poolParamsFromHot({ ...row, fees1hUsd: null })!.feeRate, 0.002);
    assert.equal(poolParamsFromHot({ ...row, fees1hUsd: 50_000 })!.feeRate, 0.002);
    // no liquidity or a bad one: left out
    assert.equal(poolParamsFromHot({ ...row, liquidityUsd: 0 })!.liquidityUsd, undefined);
    assert.equal(poolParamsFromHot({ ...row, liquidityUsd: "lots" })!.liquidityUsd, undefined);
  });

  test("historyUrls: GeckoTerminal's hourly candles, priced by the base mint in the quote and in USD; candlesOf reads them", () => {
    const addr = "5MGvNj9RNKNmzwp1LtZuQkZonEYtKJ3JuiyNQEUU2DsF";
    const mint = "XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2";
    const at = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${addr}/ohlcv/hour?aggregate=1&limit=200&token=${mint}`;
    assert.deepEqual(historyUrls(pool({ address: addr, baseMint: mint })), { price: `${at}&currency=token`, volume: `${at}&currency=usd` });
    assert.match(historyUrls(pool({ address: addr }))!.price, /&token=base&/);
    assert.match(historyUrls(pool({ address: addr, baseMint: "../x" }))!.volume, /&token=base&/);
    for (const address of ["", "S1", "../../admin", `${addr}/../x`, "0OIl".repeat(10)]) assert.equal(historyUrls(pool({ address })), null, address);
    const list = [[T0, 1, 1, 1, 1, 1]];
    assert.deepEqual(candlesOf({ data: { attributes: { ohlcv_list: list } } }), list);
    for (const b of [null, {}, { data: null }, { data: { attributes: { ohlcv_list: "x" } } }]) assert.equal(candlesOf(b), null);
  });

  test("the module is pure: no Math.random, no Date, no imports, no host globals", () => {
    const src = fs.readFileSync(MODULE, "utf8");
    assert.ok(src.length > 1000, "read the real source");
    assert.doesNotMatch(src, /Math\s*\.\s*random/);
    assert.doesNotMatch(src, /\bDate\b/);
    assert.doesNotMatch(src, /^\s*import\s/m);
    assert.doesNotMatch(src, /\brequire\s*\(/);
    assert.doesNotMatch(src, /\b(process|globalThis|window|document|self|performance|crypto|localStorage|Buffer)\b/);
    assert.doesNotMatch(src, /^(let|var)\s/m, "no module-level mutable state");
  });

  console.log(`\nlpgame: ${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
