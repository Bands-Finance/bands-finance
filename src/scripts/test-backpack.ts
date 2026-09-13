/**
 * Backpack integration tests. No network: a fake fetch is injected into the client and the
 * fixtures are the real responses captured on 2026-09-13. Also proves the ed25519 signing against
 * a known key pair (sign, then verify with tweetnacl) and that orders are refused in dry-run.
 *   npx tsx src/scripts/test-backpack.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nacl from "tweetnacl";
import { Hono } from "hono";
import {
  BackpackClient,
  BackpackError,
  BackpackRefusedError,
  decimalString,
  parseDepth,
  perpForBase,
  perpForStock,
  perpSymbolOf,
  securityFor,
  signMessage,
  signerFromKeys,
  signingString,
  spotForStock,
  spotSymbolOf,
  tickerOfXstock,
  verifySignature,
  type FetchLike,
} from "../tools/backpack";
import {
  addDays,
  basisRoutes,
  basisThresholds,
  basisVerdict,
  computeBasis,
  etWallToUtc,
  isStockPool,
  loadBasis,
  minutesToOpen,
  sessionClock,
  sessionWidthMultiplier,
  stockPoolsOf,
  stockTickerOf,
  usEquitySession,
  writeBasis,
} from "../basis";
import { baseInventoryOf, fundingCostUsd, hedgePlan, hedgeSettings, roundToStep, shortQtyOf, stepDecimals, type HedgeSettings } from "../engine/hedge";

// ---- harness -----------------------------------------------------------------------------------

type Fn = () => void | Promise<void>;
const tests: [string, Fn][] = [];
function test(name: string, fn: Fn): void {
  tests.push([name, fn]);
}

// ---- fixtures (real responses, 2026-09-13) ------------------------------------------------------

const stockFilters = { price: { tickSize: "0.01" }, quantity: { maxQuantity: null, minQuantity: "0.01", stepSize: "0.01" } };
const perp = (base: string, rwa: "STOCK" | "INDEX" | null, extra: Record<string, unknown> = {}) => ({
  symbol: `${base}_USDC_PERP`,
  baseSymbol: base,
  quoteSymbol: "USDC",
  marketType: "PERP",
  rwaMarketType: rwa,
  orderBookState: "Open",
  fundingInterval: 3600000,
  fundingRateLowerBound: "-150",
  fundingRateUpperBound: "150",
  visible: true,
  filters: stockFilters,
  ...extra,
});
const MARKETS = [
  { symbol: "SOL_USDC", baseSymbol: "SOL", quoteSymbol: "USDC", marketType: "SPOT", rwaMarketType: null, orderBookState: "Open", fundingInterval: null, visible: true, filters: stockFilters },
  perp("SOL", null),
  { symbol: "SPCX.US_USDC", baseSymbol: "SPCX.US", quoteSymbol: "USDC", marketType: "SPOT", rwaMarketType: "STOCK", orderBookState: "Open", fundingInterval: null, visible: true, filters: stockFilters },
  { symbol: "MU.US_USDC", baseSymbol: "MU.US", quoteSymbol: "USDC", marketType: "SPOT", rwaMarketType: "STOCK", orderBookState: "Open", fundingInterval: null, visible: true, filters: stockFilters },
  perp("MU.US", "STOCK", { filters: { price: { tickSize: "0.01" }, quantity: { maxQuantity: null, minQuantity: "0.001", stepSize: "0.001" } } }),
  perp("SPY.US", "INDEX"),
  perp("NVDA.US", "STOCK"),
  perp("TSLA.US", "STOCK"),
  perp("AAPL.US", "STOCK"),
  perp("AMD.US", "STOCK", { orderBookState: "PostOnly", visible: false }),
];

const TICKERS: Record<string, unknown> = {
  "NVDA.US_USDC_PERP": { firstPrice: "219.31", high: "219.48", lastPrice: "215.14", low: "215.14", priceChange: "-4.17", priceChangePercent: "-0.019014", quoteVolume: "256876.2368", symbol: "NVDA.US_USDC_PERP", trades: "555", volume: "1178" },
  SOL_USDC_PERP: { firstPrice: "102.03", high: "102.33", lastPrice: "99.75", low: "99.37", priceChange: "-2.28", priceChangePercent: "-0.022346", quoteVolume: "5978297.8361", symbol: "SOL_USDC_PERP", trades: "4840", volume: "59121.44" },
  "TSLA.US_USDC_PERP": { lastPrice: "364.89", quoteVolume: "120000", symbol: "TSLA.US_USDC_PERP", trades: "200", volume: "330" },
  "SPY.US_USDC_PERP": { lastPrice: "760.99", quoteVolume: "500000", symbol: "SPY.US_USDC_PERP", trades: "300", volume: "660" },
  "AAPL.US_USDC_PERP": { lastPrice: "331.13", quoteVolume: "90000", symbol: "AAPL.US_USDC_PERP", trades: "150", volume: "270" },
  "AMD.US_USDC_PERP": { lastPrice: "160.5", quoteVolume: "0", symbol: "AMD.US_USDC_PERP", trades: "0", volume: "0" },
};

const book = (bid: number, ask: number) => ({ asks: [[String(ask), "10"], [String(ask + 0.01), "5"]], bids: [[String(bid - 0.01), "5"], [String(bid), "10"]], lastUpdateId: "1", timestamp: 1789295343230404 });
const DEPTHS: Record<string, unknown> = {
  // real: Backpack sends bids ascending, so the best bid is the LAST bid
  "NVDA.US_USDC_PERP": {
    asks: [["214.97", "5.85"], ["214.98", "56.34"], ["214.99", "5.47"], ["215.01", "26.49"], ["215.02", "0.23"]],
    bids: [["214.89", "5.47"], ["214.91", "39.62"], ["214.92", "22.19"], ["214.93", "0.37"], ["214.94", "22.24"]],
    lastUpdateId: "2766598",
    timestamp: 1789295343230404,
  },
  "TSLA.US_USDC_PERP": book(364.88, 364.9),
  "SPY.US_USDC_PERP": book(760.98, 761.0),
  "AAPL.US_USDC_PERP": book(331.12, 331.14),
  "AMD.US_USDC_PERP": { asks: [], bids: [], lastUpdateId: "0", timestamp: 1789295343230404 },
  SOL_USDC_PERP: book(99.74, 99.76),
};

const FUNDING: Record<string, unknown[]> = {
  "NVDA.US_USDC_PERP": [
    { fundingRate: "-0.00000801", intervalEndTimestamp: "2026-09-13T11:00:00", symbol: "NVDA.US_USDC_PERP" },
    { fundingRate: "-0.00000984", intervalEndTimestamp: "2026-09-13T10:00:00", symbol: "NVDA.US_USDC_PERP" },
    { fundingRate: "0.00000004", intervalEndTimestamp: "2026-09-13T09:00:00", symbol: "NVDA.US_USDC_PERP" },
  ],
  "TSLA.US_USDC_PERP": [{ fundingRate: "0.00001", intervalEndTimestamp: "2026-09-13T11:00:00", symbol: "TSLA.US_USDC_PERP" }],
  "SPY.US_USDC_PERP": [{ fundingRate: "0.000005", intervalEndTimestamp: "2026-09-13T11:00:00", symbol: "SPY.US_USDC_PERP" }],
  "AAPL.US_USDC_PERP": [],
  "AMD.US_USDC_PERP": [],
  SOL_USDC_PERP: [{ fundingRate: "0.0000125", intervalEndTimestamp: "2026-09-13T11:00:00", symbol: "SOL_USDC_PERP" }],
};

const sessions = [
  { maxQuantity: "1000", minQuantity: "1", name: "US_EQUITIES_PRE_MARKET", stepSize: "1" },
  { maxQuantity: "10000", minQuantity: "0.01", name: "US_EQUITIES_REGULAR", stepSize: "0.00001" },
  { maxQuantity: "1000", minQuantity: "1", name: "US_EQUITIES_POST_MARKET", stepSize: "1" },
  { maxQuantity: "1000", minQuantity: "1", name: "US_EQUITIES_OVERNIGHT", stepSize: "1" },
];
const SECURITIES = [
  { asset: "AAPL.US", cusip: "037833100", name: "Apple Inc.", sessions },
  { asset: "AMZN.US", cusip: "023135106", name: "Amazon", sessions },
  { asset: "NVDA.US", cusip: "67066G104", name: "NVIDIA Corporation", sessions },
];

const KLINES = [
  { close: "215.33", end: "2026-09-13 10:00:00", high: "216.14", low: "215.33", open: "216.14", quoteVolume: "9043.7453", start: "2026-09-13 09:00:00", trades: "16", volume: "41.94" },
  { close: "215.14", end: "2026-09-13 11:00:00", high: "215.18", low: "215.14", open: "215.16", quoteVolume: "4647.6448", start: "2026-09-13 10:00:00", trades: "14", volume: "21.6" },
];

/** data/screen.json rows as the screener writes them today (address/baseMint/baseSymbol/price...) plus the shapes it may grow */
const XS = { NVDA: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", TSLA: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", AMD: "XsXcJ6GZ9kVnjqGsjBnktRcuwMBmvKWh8S93RefZ1rF", PLTR: "XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4" };
const SOL_MINT = "So11111111111111111111111111111111111111112";
const SCREEN = {
  generatedAt: "2026-09-13T10:00:00.000Z",
  solPriceUsd: 99.81032782164523,
  pools: [
    { address: "BDnKZBaPKCFmKDZxne73e2YBYCYQhZMzz4L6XaeuB8Uc", baseMint: "WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp", baseSymbol: "wXMR", quoteSymbol: "USDC", price: 532.52, name: "wXMR / USDC" },
    { address: "F4inHs4RQARpASmvLpj45QjGLdkukeGQrtQ22pimVy2a", baseMint: XS.NVDA, baseSymbol: "NVDAx", quoteSymbol: "USDC", price: 215.72, priceUsd: 215.5, tvlUsd: 16857.4, name: "NVDAx / USDC" },
    { address: "AbzmJavzxHKsSpzbcW8DRY2Jrjw2qQUeZtm6nTjvR4Qp", baseMint: XS.TSLA, baseSymbol: "TSLAx", quoteSymbol: "USDC", price: 364.73, name: "TSLAx / USDC" },
    { address: "SPYpool111111111111111111111111111111111111", stock: { ticker: "SPY.US" }, venue: "raydium-clmm", baseSymbol: "SPYx", price: 766.5 },
    { address: "AAPLpool11111111111111111111111111111111111", stock: "AAPL", symbol: "AAPLx", priceUsd: 333.04 },
    { address: "BsrTYmm5hVzgQ4wpj7XT6mgs5M4hbAqaqZBrq37Rp3PJ", baseMint: XS.PLTR, baseSymbol: "PLTRx", quoteSymbol: "USDC", price: 169.2, name: "PLTRx / USDC" },
    { address: "DsxZiQTsdJbGJojzbdAy9yK7absibgAgUnMLTdNaWr4c", baseMint: XS.AMD, baseSymbol: "AMDx", quoteSymbol: "USDC", price: 521.61 },
    { address: "5JjaEZfYzxQn3DAbAjDi8expi4b4aVnFTYDuonx15w5N", baseMint: XS.AMD, baseSymbol: "AMDx", quoteSymbol: "USDC", price: 515.4 },
    { address: "NotAnXstock11111111111111111111111111111111", baseMint: "So11111111111111111111111111111111111111112", baseSymbol: "FAKEx", price: 1 },
    { baseMint: XS.NVDA, baseSymbol: "NVDAx", price: 1 }, // no address: skipped
    { address: "off", stock: false, baseSymbol: "BONK", baseMint: "DezX", price: 1 },
    // a SOL-quoted xStock pool (Raydium): `price` is SOL per token, priceUsd is the screen's own conversion
    { address: "CKmjDiqBCRsolpool1111111111111111111111111", baseMint: XS.TSLA, baseSymbol: "TSLAx", quoteSymbol: "SOL", quoteMint: SOL_MINT, price: 3.6551503623547026, priceUsd: 364.82175590402824, stock: { ticker: "TSLA", issuer: "xstocks" }, venue: "raydium-clmm" },
  ],
};

// ---- fake transport ----------------------------------------------------------------------------

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  init: RequestInit;
}
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

function fake(routes: (url: URL, call: Call) => Reply = () => undefined) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: { ...((init.headers as Record<string, string>) ?? {}) },
      body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      init,
    };
    calls.push(call);
    const r = routes(url, call) ?? publicRoutes(url);
    const status = r.status ?? 200;
    const body = status === 204 ? null : typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? null);
    return new Response(body, { status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  };
  return { fetch: fetchImpl, calls };
}

function publicRoutes(url: URL): NonNullable<Reply> {
  const symbol = url.searchParams.get("symbol") ?? "";
  switch (url.pathname) {
    case "/api/v1/markets":
      return { body: MARKETS };
    case "/api/v1/securities":
      return { body: SECURITIES };
    case "/api/v1/tickers":
      return { body: Object.values(TICKERS) };
    case "/api/v1/ticker":
      return symbol in TICKERS ? { body: TICKERS[symbol] } : { status: 204 };
    case "/api/v1/depth":
      return symbol in DEPTHS ? { body: DEPTHS[symbol] } : { status: 400, body: { code: "INVALID_CLIENT_REQUEST", message: "Invalid market symbol" } };
    case "/api/v1/fundingRates":
      return { body: FUNDING[symbol] ?? [] };
    case "/api/v1/klines":
      return symbol in TICKERS ? { body: KLINES } : { status: 400, body: { code: "INVALID_CLIENT_REQUEST", message: "Invalid market symbol" } };
    default:
      return { status: 404, body: { code: "NOT_FOUND" } };
  }
}

/** A client on a fake clock: sleeps advance the clock instead of waiting. */
function client(routes?: (url: URL, call: Call) => Reply, opts: ConstructorParameters<typeof BackpackClient>[0] = {}) {
  const f = fake(routes);
  let t = T0;
  const sleeps: number[] = [];
  const c = new BackpackClient({
    fetch: f.fetch,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    hedgeLive: false,
    dryRun: true,
    ...opts,
  });
  return { c, calls: f.calls, sleeps, advance: (ms: number) => (t += ms) };
}

/** Sunday 2026-09-13 10:29:03Z = 06:29 ET (closed) */
const T0 = Date.UTC(2026, 8, 13, 10, 29, 3);
const et = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return etWallToUtc(date, h * 60 + m);
};

// ---- mapping -------------------------------------------------------------------------------------

test("mapping: xStock symbols, perp/spot symbols, listed lookups", () => {
  assert.equal(tickerOfXstock("NVDAx"), "NVDA");
  assert.equal(tickerOfXstock("BRK.Bx"), "BRK.B");
  assert.equal(tickerOfXstock("wXMR"), null, "lower-case prefix is not an xStock");
  assert.equal(tickerOfXstock("SOL"), null);
  assert.equal(tickerOfXstock("x"), null);
  assert.equal(tickerOfXstock(undefined), null);
  assert.equal(perpSymbolOf("nvda"), "NVDA.US_USDC_PERP");
  assert.equal(spotSymbolOf("MU"), "MU.US_USDC");
  return (async () => {
    const { c } = client();
    const list = await c.markets();
    assert.equal(list.length, MARKETS.length);
    assert.equal(perpForStock("NVDA", list)?.symbol, "NVDA.US_USDC_PERP");
    assert.equal(perpForStock("NVDA", list)?.rwaMarketType, "STOCK");
    assert.equal(perpForStock("SPY", list)?.rwaMarketType, "INDEX");
    assert.equal(perpForStock("PLTR", list), null, "not listed");
    assert.equal(perpForStock("MU", list)?.filters.stepSize, 0.001);
    assert.equal(perpForStock("NVDA", list)?.filters.stepSize, 0.01);
    assert.equal(perpForStock("NVDA", list)?.fundingInterval, 3600000);
    assert.equal(spotForStock("MU", list)?.symbol, "MU.US_USDC");
    assert.equal(spotForStock("NVDA", list), null);
    assert.equal(perpForBase("NVDAx", list)?.symbol, "NVDA.US_USDC_PERP");
    assert.equal(perpForBase("SOL", list)?.symbol, "SOL_USDC_PERP");
    assert.equal(perpForBase("wXMR", list), null);
    assert.equal(perpForBase("AMDx", list)?.orderBookState, "PostOnly");
    assert.equal((await c.market("SOL_USDC"))?.marketType, "SPOT");
    assert.equal(await c.market("NOPE"), null);
    assert.equal((await c.perpForStock("TSLA"))?.symbol, "TSLA.US_USDC_PERP");
    assert.equal((await c.spotForStock("SPCX"))?.symbol, "SPCX.US_USDC");
    assert.equal((await c.perpForBase("AAPLx"))?.symbol, "AAPL.US_USDC_PERP");
    const secs = await c.securities();
    assert.equal(secs.length, 3);
    assert.equal(securityFor("aapl", secs)?.name, "Apple Inc.");
    assert.deepEqual(
      securityFor("AAPL", secs)?.sessions.map((s) => s.name),
      ["US_EQUITIES_PRE_MARKET", "US_EQUITIES_REGULAR", "US_EQUITIES_POST_MARKET", "US_EQUITIES_OVERNIGHT"],
    );
    assert.equal(securityFor("AAPL", secs)?.sessions[1].stepSize, 0.00001);
    assert.equal(securityFor("AAPL", secs)?.sessions[0].minQuantity, 1);
    assert.equal(securityFor("PLTR", secs), null);
    assert.equal((await c.security("NVDA"))?.cusip, "67066G104");
  })();
});

// ---- public client -------------------------------------------------------------------------------

test("client: ticker/depth/funding/klines parse the real shapes; a missing symbol is null", async () => {
  const { c, calls } = client();
  const t = await c.ticker("NVDA.US_USDC_PERP");
  assert.equal(t?.lastPrice, 215.14);
  assert.equal(t?.quoteVolume, 256876.2368);
  assert.equal(t?.trades, 555);
  assert.equal(t?.priceChangePercent, -0.019014);
  assert.equal(await c.ticker("DOESNOTEXIST_USDC_PERP"), null, "HTTP 204 -> null");
  const d = await c.depth("NVDA.US_USDC_PERP");
  assert.equal(d?.bestBid, 214.94, "best bid is the max of the ascending bids");
  assert.equal(d?.bestAsk, 214.97);
  assert.equal(d?.mid, 214.955);
  assert.ok(Math.abs((d?.spreadPct ?? 0) - (0.03 / 214.955) * 100) < 1e-9);
  assert.equal(d?.bids.length, 5);
  assert.equal(await c.depth("NOPE_USDC_PERP"), null, "HTTP 400 Invalid market symbol -> null");
  const f = await c.fundingRates("NVDA.US_USDC_PERP", 3);
  assert.equal(f?.length, 3);
  assert.equal(f?.[0].fundingRate, -0.00000801);
  assert.equal(f?.[0].intervalEndTimestamp, "2026-09-13T11:00:00");
  assert.deepEqual(await c.fundingRates("NOPE_USDC_PERP"), [], "Backpack answers [] for an unknown symbol");
  const k = await c.klines("NVDA.US_USDC_PERP", "1h", 1789287978.9);
  assert.equal(k?.length, 2);
  assert.equal(k?.[1].close, 215.14);
  assert.equal(k?.[0].quoteVolume, 9043.7453);
  const kcall = calls.find((x) => x.url.pathname === "/api/v1/klines")!;
  assert.equal(kcall.url.searchParams.get("startTime"), "1789287978", "seconds, floored");
  assert.equal(kcall.url.searchParams.get("interval"), "1h");
  assert.equal(await c.klines("NOPE", "1h", 0), null);
  const all = await c.tickers();
  assert.equal(all.length, Object.keys(TICKERS).length);
  assert.equal(all.find((x) => x.symbol === "SOL_USDC_PERP")?.lastPrice, 99.75);
  for (const call of calls) {
    assert.ok(call.init.signal instanceof AbortSignal, "every request carries the timeout signal");
    assert.equal(call.headers["X-API-Key"], undefined, "public calls are unsigned");
  }
  assert.equal(parseDepth("X", { bids: [["1", "1"], ["2", "1"], ["bad", "1"]], asks: [["3", "1"]] }).bestBid, 2);
  assert.equal(parseDepth("X", { bids: [], asks: [] }).mid, null);
});

test("client: markets and securities are cached for 1h, requests are paced 250 ms apart", async () => {
  const { c, calls, sleeps, advance } = client();
  await c.markets();
  await c.markets();
  await c.securities();
  await c.securities();
  assert.equal(calls.length, 2, "one fetch each");
  advance(3_600_001);
  await c.markets();
  assert.equal(calls.length, 3, "expired after an hour");
  assert.deepEqual(sleeps, [250], "the securities fetch right after markets waited for the gap; the refetch an hour later owed none");
  // concurrent calls are serialised, never fired together
  const { c: c2, sleeps: s2, calls: calls2 } = client();
  await Promise.all([c2.ticker("SOL_USDC_PERP"), c2.ticker("NVDA.US_USDC_PERP"), c2.depth("SOL_USDC_PERP")]);
  assert.equal(calls2.length, 3);
  assert.deepEqual(s2, [250, 250]);
});

test("client: 429 and 5xx are retried with backoff, then surface; network errors retry too", async () => {
  let n = 0;
  const flaky = client((url) => {
    if (url.pathname !== "/api/v1/ticker") return undefined;
    n++;
    if (n === 1) return { status: 429, body: { code: "TOO_MANY_REQUESTS" }, headers: { "retry-after": "1" } };
    if (n === 2) return { status: 503, body: "upstream" };
    return undefined;
  });
  const t = await flaky.c.ticker("NVDA.US_USDC_PERP");
  assert.equal(t?.lastPrice, 215.14);
  assert.equal(n, 3);
  assert.deepEqual(flaky.sleeps, [1000, 1000], "retry-after 1s, then the 2^1 x 500 ms backoff; each already covers the 250 ms pacing gap");

  const dead = client(() => ({ status: 500, body: "boom" }), { maxRetries: 2 });
  await assert.rejects(dead.c.markets(), (err: unknown) => err instanceof BackpackError && err.status === 500);
  assert.equal(dead.calls.length, 3, "1 + 2 retries");

  let boom = 0;
  const netFail = fake();
  const throwing: FetchLike = async (input, init) => {
    if (boom++ < 2) throw new TypeError("fetch failed");
    return netFail.fetch(input, init);
  };
  const c3 = new BackpackClient({ fetch: throwing, now: () => T0, sleep: async () => undefined, hedgeLive: false, dryRun: true });
  assert.equal((await c3.ticker("SOL_USDC_PERP"))?.lastPrice, 99.75);
  assert.equal(boom, 3);

  const never = new BackpackClient({ fetch: async () => { throw new TypeError("fetch failed"); }, now: () => T0, sleep: async () => undefined, maxRetries: 1, hedgeLive: false, dryRun: true });
  await assert.rejects(never.ticker("SOL_USDC_PERP"), (err: unknown) => err instanceof BackpackError && err.status === 0);
  await assert.rejects(client(() => ({ status: 403, body: "forbidden" })).c.markets(), (err: unknown) => err instanceof BackpackError && err.status === 403, "other 4xx surface");
});

// ---- the NYSE clock -----------------------------------------------------------------------------

test("session: ET wall clock, DST offsets and calendar arithmetic", () => {
  assert.equal(etWallToUtc("2026-09-13", 0).toISOString(), "2026-09-13T04:00:00.000Z", "EDT is UTC-4");
  assert.equal(etWallToUtc("2026-01-15", 0).toISOString(), "2026-01-15T05:00:00.000Z", "EST is UTC-5");
  assert.equal(etWallToUtc("2026-11-02", 9 * 60 + 30).toISOString(), "2026-11-02T14:30:00.000Z", "the Monday after DST ends");
  assert.equal(addDays("2026-09-30", 1), "2026-10-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  const c = sessionClock(new Date(T0));
  assert.equal(c.etDate, "2026-09-13");
  assert.equal(c.etTime, "06:29");
  assert.equal(c.weekday, "Sun");
});

test("session: pre / regular / after / closed, weekends, holidays, early closes", () => {
  const at = (date: string, hhmm: string) => sessionClock(et(date, hhmm));
  assert.equal(at("2026-09-15", "10:00").session, "regular", "Tuesday 10:00");
  assert.equal(at("2026-09-15", "10:00").minutesSinceOpen, 30);
  assert.equal(at("2026-09-15", "10:00").minutesToClose, 360);
  assert.equal(at("2026-09-15", "10:00").minutesToOpen, 0);
  assert.equal(at("2026-09-15", "09:30").session, "regular", "open is inclusive");
  assert.equal(at("2026-09-15", "09:29").session, "pre");
  assert.equal(at("2026-09-15", "09:00").minutesToOpen, 30);
  assert.equal(at("2026-09-15", "05:00").session, "pre");
  assert.equal(at("2026-09-15", "05:00").minutesToOpen, 270);
  assert.equal(at("2026-09-15", "03:59").session, "closed");
  assert.equal(at("2026-09-15", "16:00").session, "after", "close is exclusive");
  assert.equal(at("2026-09-15", "15:59").session, "regular");
  assert.equal(at("2026-09-15", "19:59").session, "after");
  assert.equal(at("2026-09-15", "20:00").session, "closed");
  assert.equal(at("2026-09-15", "16:30").minutesToOpen, 17 * 60, "to Wednesday 09:30");
  assert.equal(at("2026-09-15", "16:30").nextOpenAt, "2026-09-16T13:30:00.000Z");
  assert.equal(at("2026-09-12", "12:00").session, "closed", "Saturday");
  assert.equal(at("2026-09-12", "12:00").tradingDay, false);
  assert.equal(at("2026-09-12", "12:00").minutesToOpen, 45.5 * 60, "Saturday noon to Monday 09:30");
  assert.equal(at("2026-09-11", "20:00").minutesToOpen, 61.5 * 60, "Friday 20:00 to Monday 09:30");
  assert.equal(at("2026-09-07", "12:00").session, "closed", "Labor Day");
  assert.equal(at("2026-09-07", "12:00").holiday, "Labor Day");
  assert.equal(at("2026-09-07", "12:00").minutesToOpen, 21.5 * 60, "to Tuesday 09:30");
  assert.equal(at("2026-07-03", "12:00").holiday?.startsWith("Independence Day"), true);
  assert.equal(at("2026-12-24", "12:59").session, "regular", "Christmas Eve early close");
  assert.equal(at("2026-12-24", "12:59").minutesToClose, 1);
  assert.equal(at("2026-12-24", "13:00").session, "after");
  assert.equal(at("2026-12-24", "16:59").session, "after", "post-market ends 17:00 on early-close days");
  assert.equal(at("2026-12-24", "17:00").session, "closed");
  assert.equal(at("2026-12-24", "20:00").minutesToOpen, 85.5 * 60, "Thu 20:00 -> Dec 25 holiday, weekend -> Mon Dec 28 09:30");
  assert.equal(at("2026-11-27", "13:30").session, "after", "day after Thanksgiving");
  assert.equal(at("2026-10-31", "12:00").minutesToOpen, 46.5 * 60, "across the DST end: Sat 12:00 EDT (16:00Z) to Mon 09:30 EST (14:30Z)");
  assert.equal(usEquitySession(et("2026-09-15", "12:00")), "regular");
  assert.equal(minutesToOpen(et("2026-09-15", "12:00")), 0);
  assert.equal(minutesToOpen(et("2026-09-15", "09:00")), 30);
});

// ---- verdicts -------------------------------------------------------------------------------------

test("verdict: basis threshold, pre-open and post-open windows, session widths, env thresholds", () => {
  const regular = sessionClock(et("2026-09-15", "11:00"));
  const justOpened = sessionClock(et("2026-09-15", "09:40"));
  const nearOpen = sessionClock(et("2026-09-15", "09:10"));
  const earlyPre = sessionClock(et("2026-09-15", "05:00"));
  const saturday = sessionClock(et("2026-09-12", "12:00"));
  const after = sessionClock(et("2026-09-15", "17:00"));
  assert.equal(basisVerdict(0.5, regular).ok, true);
  assert.equal(basisVerdict(1.0, regular).ok, true, "at the threshold is allowed");
  const rich = basisVerdict(1.5, regular);
  assert.equal(rich.ok, false);
  assert.match(rich.reason, /arbitraged through the band/);
  assert.match(rich.reason, /above/);
  assert.match(basisVerdict(-1.2, regular).reason, /below/);
  assert.equal(basisVerdict(0.2, nearOpen).ok, false, "20 min to the open");
  assert.match(basisVerdict(0.2, nearOpen).reason, /opens in 20 min/);
  assert.equal(basisVerdict(0.2, earlyPre).ok, true, "270 min to the open");
  assert.equal(basisVerdict(0.2, justOpened).ok, false, "10 min after the open");
  assert.match(basisVerdict(0.2, justOpened).reason, /opened 10 min ago/);
  assert.equal(basisVerdict(0.2, sessionClock(et("2026-09-15", "09:45"))).ok, true, "15 min after the open");
  assert.equal(basisVerdict(null, saturday).ok, true, "no perp reference: no basis objection");
  assert.match(basisVerdict(null, saturday).reason, /no Backpack reference/);
  assert.equal(basisVerdict(1.5, saturday).ok, false, "the basis rule applies whatever the session");
  assert.equal(basisVerdict(0.2, after).ok, true);
  assert.equal(basisVerdict(0.2, sessionClock(et("2026-09-15", "20:30"))).ok, true, "closed overnight, 13h to the open");
  assert.equal(basisVerdict(0.2, "closed", et("2026-09-12", "12:00")).ok, true, "string session + now");
  assert.equal(basisVerdict(0.2, "pre", et("2026-09-15", "09:10")).ok, false);
  const strict = { maxPct: 0.3, preOpenMin: 60, postOpenMin: 15 };
  assert.equal(basisVerdict(0.5, regular, undefined, strict).ok, false);
  assert.equal(basisVerdict(0.2, sessionClock(et("2026-09-15", "08:45")), undefined, strict).ok, false, "45 min < 60");
  assert.deepEqual(basisThresholds({ BASIS_MAX_PCT: "2", BASIS_PRE_OPEN_MIN: "45" } as NodeJS.ProcessEnv), { maxPct: 2, preOpenMin: 45, postOpenMin: 15 });
  assert.deepEqual(basisThresholds({ BASIS_MAX_PCT: "lots", BASIS_PRE_OPEN_MIN: "-3" } as NodeJS.ProcessEnv), { maxPct: 1, preOpenMin: 30, postOpenMin: 15 }, "garbage -> defaults");
  assert.deepEqual(basisThresholds({} as NodeJS.ProcessEnv), { maxPct: 1, preOpenMin: 30, postOpenMin: 15 });
  assert.equal(sessionWidthMultiplier("regular"), 1);
  assert.equal(sessionWidthMultiplier("pre"), 1.5);
  assert.equal(sessionWidthMultiplier("after"), 1.5);
  assert.equal(sessionWidthMultiplier("closed"), 2);
  assert.equal(sessionWidthMultiplier(saturday), 2);
  assert.equal(sessionWidthMultiplier(regular), 1);
});

// ---- the screen, read tolerantly ----------------------------------------------------------------

test("basis: stock pools are found in any screen shape and every field is optional", () => {
  const pools = stockPoolsOf(SCREEN);
  assert.deepEqual(
    pools.map((p) => [p.symbol, p.ticker, p.poolPrice, p.venue]),
    [
      ["NVDAx", "NVDA", 215.72, "meteora-dlmm"],
      ["TSLAx", "TSLA", 364.73, "meteora-dlmm"],
      ["SPYx", "SPY", 766.5, "raydium-clmm"],
      ["AAPLx", "AAPL", 333.04, "meteora-dlmm"],
      ["PLTRx", "PLTR", 169.2, "meteora-dlmm"],
      ["AMDx", "AMD", 521.61, "meteora-dlmm"],
      ["AMDx", "AMD", 515.4, "meteora-dlmm"],
      ["TSLAx", "TSLA", 3.6551503623547026 * 99.81032782164523, "raydium-clmm"],
    ],
  );
  assert.equal(pools[0].baseMint, XS.NVDA);
  assert.equal(pools[0].tvlUsd, 16857.4);
  assert.equal(pools[0].quoteSymbol, "USDC");
  assert.equal(pools[0].priceInQuote, 215.72);
  assert.equal(pools[0].issuer, null);
  const solQuoted = pools[7];
  assert.equal(solQuoted.quoteSymbol, "SOL");
  assert.equal(solQuoted.priceInQuote, 3.6551503623547026, "SOL per token as the screen reports it");
  assert.ok(Math.abs(solQuoted.poolPrice! - 364.82) < 0.01, "priced in USD through the screen's solPriceUsd");
  assert.equal(solQuoted.issuer, "xstocks");
  assert.equal(pools[2].issuer, null);
  const bare = stockPoolsOf(SCREEN.pools);
  assert.equal(bare.length, 8, "a bare array");
  assert.equal(bare[7].poolPrice, 364.82175590402824, "no solPriceUsd on a bare array: the screen's priceUsd stands in");
  assert.equal(stockPoolsOf({ rows: SCREEN.pools }).length, 8, "{rows}");
  assert.equal(stockPoolsOf([{ address: "q", stock: "NVDA", quoteMint: SOL_MINT, price: 2 }])[0].poolPrice, null, "SOL-quoted with neither solPriceUsd nor priceUsd: unknown, not 2");
  assert.equal(stockPoolsOf([{ address: "q", stock: "NVDA", quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", price: 2 }])[0].poolPrice, 2, "USDC by mint");
  assert.equal(stockPoolsOf([{ address: "q", stock: "NVDA", quoteSymbol: "USDT", price: 3, priceUsd: 9 }])[0].poolPrice, 3, "stable quote: the on-chain price beats analytics");
  assert.equal(stockPoolsOf([{ address: "q", stock: "NVDA", quoteSymbol: "JUP", price: 3, priceUsd: 9 }])[0].poolPrice, 9, "an exotic quote: only priceUsd is USD");
  assert.equal(stockPoolsOf({ generatedAt: "x" }).length, 0);
  assert.equal(stockPoolsOf(null).length, 0);
  assert.equal(stockPoolsOf("nonsense").length, 0);
  assert.equal(isStockPool({ baseSymbol: "NVDAx", baseMint: XS.NVDA }), true);
  assert.equal(isStockPool({ baseSymbol: "NVDAx", baseMint: "NotXs" }), false, "symbol alone is not enough");
  assert.equal(isStockPool({ baseSymbol: "wXMR", baseMint: "WXMRy" }), false);
  assert.equal(isStockPool({ stock: "NVDA" }), true);
  assert.equal(isStockPool({ stock: false, baseSymbol: "BONK" }), false);
  assert.equal(isStockPool({ stock: "", baseSymbol: "BONK" }), false);
  assert.equal(isStockPool({ baseToken: { mint: XS.TSLA, symbol: "TSLAx" }, symbol: "TSLAx" }), true, "snapshot-style nesting");
  assert.equal(stockTickerOf({ stock: { asset: "META.US" } }), "META");
  assert.equal(stockTickerOf({ stock: "spy.us" }), "SPY");
  assert.equal(stockTickerOf({ baseSymbol: "GOOGLx" }), "GOOGL");
  assert.equal(stockTickerOf({ baseSymbol: "SOL" }), null);
});

test("basis: rows priced against the perp mid, one quote per perp, missing perps and failures degrade to nulls", async () => {
  const { c, calls } = client();
  const basis = await computeBasis(stockPoolsOf(SCREEN), c, new Date(T0));
  assert.equal(basis.session, "closed", "Sunday morning");
  assert.equal(basis.minutesToOpen, sessionClock(new Date(T0)).minutesToOpen);
  assert.equal(basis.clock.weekday, "Sun");
  assert.equal(basis.rows.length, 8);
  const nvda = basis.rows[0];
  assert.equal(nvda.quoteSymbol, "USDC");
  assert.equal(nvda.priceInQuote, 215.72);
  assert.equal(nvda.perpSymbol, "NVDA.US_USDC_PERP");
  assert.equal(nvda.perpMid, 214.955);
  assert.equal(nvda.perpLast, 215.14);
  assert.ok(Math.abs(nvda.basisPct! - (215.72 / 214.955 - 1) * 100) < 1e-9, `basis ${nvda.basisPct}`);
  assert.ok(Math.abs(nvda.spreadPct! - (0.03 / 214.955) * 100) < 1e-9);
  assert.equal(nvda.fundingRatePerHour, -0.00000801, "hourly interval: the rate is already per hour");
  assert.ok(Math.abs(nvda.fundingAprPct! - -0.00000801 * 24 * 365 * 100) < 1e-12);
  assert.equal(nvda.perpVolume24hUsd, 256876.2368);
  assert.equal(nvda.perpOrderBookState, "Open");
  assert.equal(nvda.security?.asset, "NVDA.US");
  assert.equal(nvda.security?.sessions.length, 4);
  assert.equal(nvda.note, null);
  const tsla = basis.rows[1];
  assert.equal(tsla.perpMid, 364.89);
  assert.ok(Math.abs(tsla.basisPct! - (364.73 / 364.89 - 1) * 100) < 1e-9);
  assert.equal(basis.rows[2].venue, "raydium-clmm");
  assert.ok(Math.abs(basis.rows[2].basisPct! - (766.5 / 760.99 - 1) * 100) < 1e-9, "SPY from the {ticker: 'SPY.US'} stock field");
  const aapl = basis.rows[3];
  assert.equal(aapl.fundingRatePerHour, null, "never funded: null, not 0");
  assert.equal(aapl.fundingAprPct, null);
  assert.equal(aapl.security?.asset, "AAPL.US");
  const pltr = basis.rows[4];
  assert.equal(pltr.perpSymbol, null);
  assert.equal(pltr.perpMid, null);
  assert.equal(pltr.basisPct, null);
  assert.equal(pltr.note, "no Backpack perp for PLTR");
  const amd = basis.rows[5];
  assert.equal(amd.perpMid, 160.5, "empty book: the last trade stands in for the mid");
  assert.equal(amd.spreadPct, null);
  assert.equal(amd.note, "perp book PostOnly");
  assert.equal(basis.rows[6].perpMid, 160.5, "second AMDx pool shares the quote");
  const tslaSol = basis.rows[7];
  assert.equal(tslaSol.perpSymbol, "TSLA.US_USDC_PERP");
  assert.equal(tslaSol.perpMid, 364.89);
  assert.equal(tslaSol.quoteSymbol, "SOL");
  assert.equal(tslaSol.issuer, "xstocks");
  assert.ok(Math.abs(tslaSol.basisPct! - ((3.6551503623547026 * 99.81032782164523) / 364.89 - 1) * 100) < 1e-9, "a SOL-quoted pool is compared in USD, not SOL");
  assert.ok(Math.abs(tslaSol.basisPct!) < 0.1, `not the -99% a raw SOL price would give (${tslaSol.basisPct})`);
  assert.equal(calls.filter((x) => x.url.pathname === "/api/v1/depth" && x.url.searchParams.get("symbol") === "TSLA.US_USDC_PERP").length, 1, "the SOL and USDC TSLAx pools share one quote");
  assert.equal(calls.filter((x) => x.url.pathname === "/api/v1/depth" && x.url.searchParams.get("symbol") === "AMD.US_USDC_PERP").length, 1, "one depth per perp");
  assert.equal(calls.filter((x) => x.url.pathname === "/api/v1/markets").length, 1);
  assert.equal(calls.filter((x) => x.url.pathname === "/api/v1/depth").length, 5, "NVDA TSLA SPY AAPL AMD");

  // Backpack down: no throw, rows carry the reason
  const down = client(() => ({ status: 503, body: "maintenance" }), { maxRetries: 0 });
  const degraded = await computeBasis(stockPoolsOf(SCREEN).slice(0, 2), down.c, new Date(T0));
  assert.equal(degraded.rows.length, 2);
  assert.equal(degraded.rows[0].perpMid, null);
  assert.match(degraded.rows[0].note!, /^markets: .*503/);

  // a single flaky endpoint degrades one field, not the row
  const flaky = client((url) => (url.pathname === "/api/v1/fundingRates" ? { status: 500, body: "x" } : undefined), { maxRetries: 0 });
  const partial = await computeBasis(stockPoolsOf(SCREEN).slice(0, 1), flaky.c, new Date(T0));
  assert.equal(partial.rows[0].perpMid, 214.955);
  assert.equal(partial.rows[0].fundingRatePerHour, null);
  assert.match(partial.rows[0].note!, /^funding: /);
});

test("basis: the file round-trips and GET /api/basis serves it (404 with a reason before the first run)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bands-basis-"));
  const file = path.join(dir, "basis.json");
  try {
    assert.equal(loadBasis(file), null);
    const app = new Hono();
    basisRoutes(app, file);
    const missing = await app.request("/api/basis");
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /basis not computed yet/);
    const { c } = client();
    const basis = await computeBasis(stockPoolsOf(SCREEN), c, new Date(T0));
    writeBasis(basis, file);
    assert.equal(fs.readdirSync(dir).length, 1, "the temp file was renamed away");
    const loaded = loadBasis(file);
    assert.equal(loaded?.rows.length, 8);
    assert.equal(loaded?.generatedAt, new Date(T0).toISOString());
    const res = await app.request("/api/basis");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: unknown[]; session: string; minutesToOpen: number };
    assert.equal(body.rows.length, 8);
    assert.equal(body.session, "closed");
    assert.equal(typeof body.minutesToOpen, "number");
    fs.writeFileSync(file, "{not json");
    assert.equal(loadBasis(file), null, "a torn file reads as absent");
    assert.equal((await app.request("/api/basis")).status, 404);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- hedge policy ---------------------------------------------------------------------------------

const ON: HedgeSettings = { live: false, minRebalanceUsd: 25, maxNotionalUsd: 10_000 };
const OFF: HedgeSettings = { live: false, minRebalanceUsd: 25, maxNotionalUsd: 0 };
const nvdaPool = { address: "F4inHs4RQARpASmvLpj45QjGLdkukeGQrtQ22pimVy2a", baseSymbol: "NVDAx" };

test("hedge: dormant by default, the perp symbol comes from the pool, settings from env", () => {
  const off = hedgePlan({ pool: nvdaPool, baseInventory: 2, basePrice: 215, existingShortQty: 0 }, OFF);
  assert.equal(off.side, null);
  assert.equal(off.quantity, 0);
  assert.equal(off.symbol, "NVDA.US_USDC_PERP");
  assert.equal(off.pool, nvdaPool.address);
  assert.equal(off.targetShortQty, 2);
  assert.equal(off.deltaQty, 2);
  assert.equal(off.deltaUsd, 430);
  assert.match(off.reason, /hedging off/);
  assert.match(hedgePlan({ pool: nvdaPool, baseInventory: 0, basePrice: 215, existingShortQty: 3 }, OFF).reason, /existing short of 3 is left alone/);
  assert.deepEqual(hedgeSettings({} as NodeJS.ProcessEnv), { live: false, minRebalanceUsd: 25, maxNotionalUsd: 0 });
  assert.deepEqual(hedgeSettings({ HEDGE_LIVE: "TRUE", HEDGE_MIN_REBALANCE_USD: "10", HEDGE_MAX_NOTIONAL_USD: "500" } as NodeJS.ProcessEnv), { live: true, minRebalanceUsd: 10, maxNotionalUsd: 500 });
  assert.deepEqual(hedgeSettings({ HEDGE_LIVE: "yes", HEDGE_MAX_NOTIONAL_USD: "-1" } as NodeJS.ProcessEnv), { live: false, minRebalanceUsd: 25, maxNotionalUsd: 0 });
  const noSymbol = hedgePlan({ pool: "someaddress", baseInventory: 2, basePrice: 215, existingShortQty: 0 }, ON);
  assert.equal(noSymbol.side, null);
  assert.match(noSymbol.reason, /no perp symbol/);
  assert.equal(hedgePlan({ pool: { address: "p", baseSymbol: "SOL" }, baseInventory: 2, basePrice: 100, existingShortQty: 0 }, ON).symbol, null, "SOL pools are not stock pools");
  assert.equal(hedgePlan({ pool: "p", symbol: "SOL_USDC_PERP", baseInventory: 2, basePrice: 100, existingShortQty: 0 }, ON).side, "Ask", "an explicit symbol works");
  assert.match(hedgePlan({ pool: nvdaPool, baseInventory: 2, basePrice: 0, existingShortQty: 0 }, ON).reason, /no price/);
  assert.equal(hedgePlan({ pool: nvdaPool, baseInventory: NaN, basePrice: 215, existingShortQty: 0 }, ON).side, null);
});

test("hedge: sells into inventory, buys back reduce-only, honours the floor, the cap and the step", () => {
  const open = hedgePlan({ pool: nvdaPool, baseInventory: 2, basePrice: 215, existingShortQty: 0, stepSize: "0.01", minQuantity: "0.01" }, ON);
  assert.equal(open.side, "Ask");
  assert.equal(open.quantity, 2);
  assert.equal(open.reduceOnly, false);
  assert.equal(open.notionalAfterUsd, 430);
  assert.match(open.reason, /sell 2 more perp/);

  const grew = hedgePlan({ pool: nvdaPool, baseInventory: 3.456789, basePrice: 215, existingShortQty: 2, stepSize: 0.01 }, ON);
  assert.equal(grew.side, "Ask");
  assert.equal(grew.quantity, 1.45, "rounded down to the step");
  assert.equal(grew.notionalAfterUsd, 3.45 * 215);

  const shrank = hedgePlan({ pool: nvdaPool, baseInventory: 0.5, basePrice: 215, existingShortQty: 2, stepSize: 0.01 }, ON);
  assert.equal(shrank.side, "Bid");
  assert.equal(shrank.quantity, 1.5);
  assert.equal(shrank.reduceOnly, true);
  assert.equal(shrank.deltaQty, -1.5);
  assert.match(shrank.reason, /buy back 1.5 of the 2 short \(reduceOnly\)/);

  const flat = hedgePlan({ pool: nvdaPool, baseInventory: 0, basePrice: 215, existingShortQty: 2, stepSize: 0.01 }, ON);
  assert.equal(flat.side, "Bid");
  assert.equal(flat.quantity, 2);
  assert.equal(flat.notionalAfterUsd, 0);

  const small = hedgePlan({ pool: nvdaPool, baseInventory: 2.1, basePrice: 215, existingShortQty: 2, stepSize: 0.01 }, ON);
  assert.equal(small.side, null);
  assert.match(small.reason, /21.50 USD\) is below the 25 USD rebalance floor/);
  assert.equal(hedgePlan({ pool: nvdaPool, baseInventory: 2.1, basePrice: 215, existingShortQty: 2, minRebalanceUsd: 20 }, ON).side, "Ask", "explicit floor");
  assert.equal(hedgePlan({ pool: nvdaPool, baseInventory: 2, basePrice: 215, existingShortQty: 2 }, ON).side, null, "already neutral");

  const capped = hedgePlan({ pool: nvdaPool, baseInventory: 100, basePrice: 215, existingShortQty: 0, stepSize: 0.01 }, ON);
  assert.equal(capped.side, "Ask");
  assert.equal(capped.quantity, 46.51, "10000 / 215 floored to 0.01");
  assert.ok(capped.notionalAfterUsd <= 10_000);
  assert.match(capped.reason, /capped to 46.5116 by HEDGE_MAX_NOTIONAL_USD=10000/);
  assert.equal(capped.targetShortQty, 100, "the uncapped target is reported");

  const over = hedgePlan({ pool: nvdaPool, baseInventory: 100, basePrice: 215, existingShortQty: 60, stepSize: 0.01 }, ON);
  assert.equal(over.side, "Bid", "a short above the cap is reduced even though inventory is larger");
  assert.equal(over.reduceOnly, true);
  assert.equal(over.quantity, 13.48);
  assert.equal(hedgePlan({ pool: nvdaPool, baseInventory: 100, basePrice: 215, existingShortQty: 46.51, stepSize: 0.01 }, ON).side, null, "at the cap: hold");

  const mu = hedgePlan({ pool: { address: "m", baseSymbol: "MUx" }, baseInventory: 0.123456, basePrice: 500, existingShortQty: 0, market: { symbol: "MU.US_USDC_PERP", filters: { tickSize: 0.01, minQuantity: 0.001, maxQuantity: null, stepSize: 0.001 } } }, ON);
  assert.equal(mu.symbol, "MU.US_USDC_PERP");
  assert.equal(mu.quantity, 0.123, "the market's step");
  const dust = hedgePlan({ pool: nvdaPool, baseInventory: 0.005, basePrice: 10_000, existingShortQty: 0, stepSize: 0.01, minQuantity: 0.01 }, ON);
  assert.equal(dust.side, null, "50 USD clears the floor but rounds to 0 at step 0.01");
  assert.match(dust.reason, /rounds to 0/);
  const belowMin = hedgePlan({ pool: nvdaPool, baseInventory: 0.005, basePrice: 10_000, existingShortQty: 0, stepSize: 0.001, minQuantity: 0.01 }, ON);
  assert.equal(belowMin.side, null, "0.005 is a valid step but below minQuantity 0.01");
  const noStep = hedgePlan({ pool: nvdaPool, baseInventory: 1.23456789, basePrice: 215, existingShortQty: 0 }, ON);
  assert.equal(noStep.quantity, 1.23456789, "no step known: unrounded");
});

test("hedge: rounding, funding cost, inventory and short helpers", () => {
  assert.equal(roundToStep(1.23456, "0.01"), 1.23);
  assert.equal(roundToStep(0.3, 0.1), 0.3, "float noise: 0.3 / 0.1 is 2.9999...");
  assert.equal(roundToStep(2.9999, 1), 2, "a real shortfall is floored");
  assert.equal(roundToStep(2.9999999999, 1), 3, "within the 1e-9 float-noise tolerance");
  assert.equal(roundToStep(0.0099, 0.01), 0);
  assert.equal(roundToStep(5, null), 5);
  assert.equal(roundToStep(-1, 0.01), 0);
  assert.equal(stepDecimals(0.001), 3);
  assert.equal(stepDecimals(1), 0);
  assert.equal(stepDecimals(1e-7), 7);
  assert.equal(stepDecimals(0.00001), 5);
  // NVDA perp funds -0.00000801/h: shorts PAY when the rate is negative
  assert.ok(Math.abs(fundingCostUsd(10_000, -0.00000801, 24) - 1.9224) < 1e-9);
  assert.ok(Math.abs(fundingCostUsd(10_000, -0.00000801, 24, "long") - -1.9224) < 1e-9);
  assert.ok(Math.abs(fundingCostUsd(10_000, 0.0000125, 24 * 365, "short") - -1095) < 1e-9, "a positive rate pays the short");
  assert.equal(fundingCostUsd(0, 0.01, 10), -0);
  const pos = { amountX: 1.5, amountY: 200, feeX: 0.01, feeY: 2 };
  assert.equal(baseInventoryOf(pos, { solSide: null, quoteSide: "Y" }), 1.51, "USDC on Y: base is X incl. fees");
  assert.equal(baseInventoryOf(pos, { solSide: null, quoteSide: "X" }), 202);
  assert.equal(baseInventoryOf(pos, { solSide: "Y" }), 1.51, "legacy SOL snapshot");
  assert.equal(baseInventoryOf(pos, { solSide: "X" }), 202);
  const positions = [
    { symbol: "NVDA.US_USDC_PERP", netQuantity: -2 },
    { symbol: "SOL_USDC_PERP", netQuantity: 5 },
  ];
  assert.equal(shortQtyOf(positions, "NVDA.US_USDC_PERP"), 2);
  assert.equal(shortQtyOf(positions, "SOL_USDC_PERP"), 0, "a long is not a short");
  assert.equal(shortQtyOf(positions, "TSLA.US_USDC_PERP"), 0);
});

// ---- signing --------------------------------------------------------------------------------------

const SEED = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const KP = nacl.sign.keyPair.fromSeed(SEED);
const API_KEY = Buffer.from(KP.publicKey).toString("base64");
const API_SECRET = Buffer.from(SEED).toString("base64");

test("signing: the docs' string format, ed25519 sign + verify with tweetnacl, key pair checks", () => {
  // the example in the docs
  assert.equal(
    signingString("orderCancel", { symbol: "BTC_USDT", orderId: 28 }, 1614550000000, 5000),
    "instruction=orderCancel&orderId=28&symbol=BTC_USDT&timestamp=1614550000000&window=5000",
  );
  assert.equal(signingString("balanceQuery", {}, 1700000000000, 5000), "instruction=balanceQuery&timestamp=1700000000000&window=5000");
  assert.equal(
    signingString("orderExecute", { symbol: "NVDA.US_USDC_PERP", side: "Ask", orderType: "Limit", quantity: "1.5", price: "215.10", postOnly: true, reduceOnly: undefined, clientId: null }, 1, 5000),
    "instruction=orderExecute&orderType=Limit&postOnly=true&price=215.10&quantity=1.5&side=Ask&symbol=NVDA.US_USDC_PERP&timestamp=1&window=5000",
    "params sorted alphabetically, undefined/null dropped, booleans as true/false",
  );
  const signer = signerFromKeys(API_KEY, API_SECRET);
  assert.equal(signer.publicKeyB64, API_KEY);
  assert.equal(signer.secretKey.length, 64);
  const msg = signingString("orderCancel", { symbol: "BTC_USDT", orderId: 28 }, 1614550000000, 5000);
  const sig = signMessage(msg, signer.secretKey);
  assert.equal(Buffer.from(sig, "base64").length, 64, "a detached ed25519 signature");
  assert.equal(nacl.sign.detached.verify(new Uint8Array(Buffer.from(msg)), new Uint8Array(Buffer.from(sig, "base64")), KP.publicKey), true, "verifies with tweetnacl against the known public key");
  assert.equal(verifySignature(msg, sig, API_KEY), true);
  assert.equal(verifySignature(msg + "x", sig, API_KEY), false, "tampered message");
  assert.equal(verifySignature(msg, sig, Buffer.from(nacl.sign.keyPair().publicKey).toString("base64")), false, "wrong key");
  assert.equal(verifySignature(msg, "not base64!!", API_KEY), false);
  assert.equal(signMessage(msg, signer.secretKey), sig, "ed25519 is deterministic");
  const full = signerFromKeys(API_KEY, Buffer.from(KP.secretKey).toString("base64"));
  assert.equal(full.publicKeyB64, API_KEY, "a 64-byte secret key is accepted too");
  assert.throws(() => signerFromKeys(Buffer.from(nacl.sign.keyPair().publicKey).toString("base64"), API_SECRET), /does not match/);
  assert.throws(() => signerFromKeys(API_KEY, Buffer.from(new Uint8Array(16)).toString("base64")), /32-byte/);
  assert.throws(() => new BackpackClient({ apiKey: "AAAA", apiSecret: API_SECRET }), /does not match/, "a bad pair fails at construction");
  assert.equal(decimalString(1e-7), "0.0000001");
  assert.equal(decimalString(215.1), "215.1");
  assert.equal(decimalString(" 1.50 "), "1.50");
  assert.equal(decimalString(2), "2");
  assert.throws(() => decimalString(NaN));
});

test("signed client: dormant without keys; refuses to trade in dry-run or without HEDGE_LIVE; reads still work", async () => {
  const bare = client(undefined, { apiKey: "", apiSecret: "" });
  assert.equal(bare.c.configured, false);
  assert.equal(bare.c.apiKey, null);
  assert.equal(bare.c.canTrade().ok, false);
  assert.match(bare.c.canTrade().reason, /not set/);
  await assert.rejects(bare.c.balances(), BackpackRefusedError);
  await assert.rejects(bare.c.placeOrder({ symbol: "NVDA.US_USDC_PERP", side: "Ask", orderType: "Market", quantity: 1 }), BackpackRefusedError);
  assert.equal(bare.calls.length, 0, "nothing hit the wire");

  const order = { symbol: "NVDA.US_USDC_PERP", side: "Ask" as const, orderType: "Limit" as const, quantity: 1.5, price: 215.1, postOnly: true, reduceOnly: true };
  const dry = client(undefined, { apiKey: API_KEY, apiSecret: API_SECRET, hedgeLive: true, dryRun: true });
  assert.equal(dry.c.configured, true);
  assert.equal(dry.c.apiKey, API_KEY);
  assert.equal(dry.c.canTrade().ok, false);
  await assert.rejects(dry.c.placeOrder(order), (err: unknown) => err instanceof BackpackRefusedError && /DRY_RUN is not the literal "false"/.test(err.message));
  await assert.rejects(dry.c.cancelOrder({ symbol: "NVDA.US_USDC_PERP", orderId: "28" }), (err: unknown) => err instanceof BackpackRefusedError && /DRY_RUN/.test(err.message));
  assert.equal(dry.calls.length, 0, "refused before any request");

  const notLive = client(undefined, { apiKey: API_KEY, apiSecret: API_SECRET, hedgeLive: false, dryRun: false });
  await assert.rejects(notLive.c.placeOrder(order), (err: unknown) => err instanceof BackpackRefusedError && /HEDGE_LIVE is not true/.test(err.message));
  await assert.rejects(notLive.c.cancelOrder({ symbol: "NVDA.US_USDC_PERP", orderId: "28" }), /HEDGE_LIVE/);
  assert.equal(notLive.calls.length, 0);

  // the process default: config.dryRun from .env (anything but the literal "false" is dry-run) and HEDGE_LIVE unset
  const fromEnv = new BackpackClient({ fetch: fake().fetch, apiKey: API_KEY, apiSecret: API_SECRET });
  if (process.env.HEDGE_LIVE?.trim().toLowerCase() !== "true" || (process.env.DRY_RUN ?? "true").trim().toLowerCase() !== "false") {
    assert.equal(fromEnv.canTrade().ok, false, "dormant in this environment");
  }

  // signed READS work in dry-run: balances / positions / open orders, with verifiable headers
  const signedRoutes = (url: URL, call: Call): Reply => {
    switch (url.pathname) {
      case "/api/v1/balances":
        return { body: { USDC: { available: "1000.5", locked: "0", staked: "0" }, SOL: { available: "2", locked: "0.5", staked: "0" } } };
      case "/api/v1/positions":
        return { body: [{ symbol: "NVDA.US_USDC_PERP", netQuantity: "-2", entryPrice: "215.2", markPrice: "214.95", pnlUnrealized: "0.5", pnlRealized: "0", cumulativeFundingPayment: "-0.01", positionId: "1" }] };
      case "/api/v1/orders":
        return { body: [{ id: "28", clientId: 7, symbol: "NVDA.US_USDC_PERP", side: "Ask", orderType: "Limit", quantity: "1.5", price: "215.1", status: "New", executedQuantity: "0", reduceOnly: true, postOnly: true }] };
      case "/api/v1/order":
        return call.method === "POST"
          ? { body: { id: "29", symbol: "NVDA.US_USDC_PERP", side: "Ask", orderType: "Limit", quantity: "1.5", price: "215.1", status: "New", executedQuantity: "0", reduceOnly: true, postOnly: true } }
          : { body: { id: "28", symbol: "NVDA.US_USDC_PERP", side: "Ask", orderType: "Limit", quantity: "1.5", price: "215.1", status: "Cancelled" } };
      default:
        return undefined;
    }
  };
  const verify = (call: Call, instruction: string, params: Record<string, unknown>) => {
    assert.equal(call.headers["X-API-Key"], API_KEY);
    assert.ok(Number(call.headers["X-Timestamp"]) >= T0 && Number(call.headers["X-Timestamp"]) < T0 + 60_000, "the fake clock (pacing sleeps advance it) stamps the request");
    assert.equal(call.headers["X-Window"], "5000");
    const msg = signingString(instruction, params as Record<string, string | number | boolean>, Number(call.headers["X-Timestamp"]), Number(call.headers["X-Window"]));
    assert.equal(verifySignature(msg, call.headers["X-Signature"], API_KEY), true, `signature verifies for ${msg}`);
  };
  const ro = client(signedRoutes, { apiKey: API_KEY, apiSecret: API_SECRET, hedgeLive: true, dryRun: true });
  const balances = await ro.c.balances();
  assert.equal(balances.USDC.available, 1000.5);
  assert.equal(balances.SOL.locked, 0.5);
  verify(ro.calls[0], "balanceQuery", {});
  assert.equal(ro.calls[0].method, "GET");
  assert.equal(ro.calls[0].url.pathname, "/api/v1/balances");
  const positions = await ro.c.positions();
  assert.equal(positions[0].netQuantity, -2);
  assert.equal(positions[0].cumulativeFundingPayment, -0.01);
  assert.equal(shortQtyOf(positions, "NVDA.US_USDC_PERP"), 2);
  verify(ro.calls[1], "positionQuery", {});
  const orders = await ro.c.openOrders("NVDA.US_USDC_PERP");
  assert.equal(orders[0].id, "28");
  assert.equal(orders[0].price, 215.1);
  assert.equal(orders[0].reduceOnly, true);
  assert.equal(ro.calls[2].url.searchParams.get("symbol"), "NVDA.US_USDC_PERP");
  verify(ro.calls[2], "orderQueryAll", { symbol: "NVDA.US_USDC_PERP" });
  await ro.c.openOrders();
  verify(ro.calls[3], "orderQueryAll", {});
  assert.equal(ro.calls[3].url.search, "");

  // the only path that trades: keys + HEDGE_LIVE=true + DRY_RUN=false (still no network here)
  const live = client(signedRoutes, { apiKey: API_KEY, apiSecret: API_SECRET, hedgeLive: true, dryRun: false });
  assert.equal(live.c.canTrade().ok, true);
  const placed = await live.c.placeOrder(order);
  assert.equal(placed.id, "29");
  const post = live.calls[0];
  assert.equal(post.method, "POST");
  assert.equal(post.url.pathname, "/api/v1/order");
  assert.equal(post.headers["content-type"], "application/json");
  assert.deepEqual(post.body, { symbol: "NVDA.US_USDC_PERP", side: "Ask", orderType: "Limit", quantity: "1.5", price: "215.1", postOnly: true, reduceOnly: true }, "quantities as strings, flags as booleans");
  verify(post, "orderExecute", post.body!);
  const cancelled = await live.c.cancelOrder({ symbol: "NVDA.US_USDC_PERP", orderId: "28" });
  assert.equal(cancelled.status, "Cancelled");
  const del = live.calls[1];
  assert.equal(del.method, "DELETE");
  assert.deepEqual(del.body, { symbol: "NVDA.US_USDC_PERP", orderId: "28" });
  verify(del, "orderCancel", { symbol: "NVDA.US_USDC_PERP", orderId: "28" });
  await live.c.placeOrder({ symbol: "SOL_USDC_PERP", side: "Bid", orderType: "Market", quantity: "0.5" });
  assert.deepEqual(live.calls[2].body, { symbol: "SOL_USDC_PERP", side: "Bid", orderType: "Market", quantity: "0.5" }, "a market order carries no price");
  await assert.rejects(live.c.placeOrder({ symbol: "SOL_USDC_PERP", side: "Bid", orderType: "Limit", quantity: 1 }), /needs a price/);
  await assert.rejects(live.c.placeOrder({ symbol: "SOL_USDC_PERP", side: "Bid", orderType: "Market", quantity: 0 }), /quantity must be > 0/);
  await assert.rejects(live.c.cancelOrder({ symbol: "SOL_USDC_PERP" }), /orderId or clientId/);
  assert.equal(live.calls.length, 3);

  // a signed request re-signs on retry with a fresh timestamp
  let hits = 0;
  const retry = client((url, call) => (url.pathname === "/api/v1/balances" && hits++ === 0 ? { status: 429, body: "slow down" } : signedRoutes(url, call)), { apiKey: API_KEY, apiSecret: API_SECRET });
  await retry.c.balances();
  assert.equal(retry.calls.length, 2);
  assert.notEqual(retry.calls[0].headers["X-Timestamp"], retry.calls[1].headers["X-Timestamp"]);
  assert.notEqual(retry.calls[0].headers["X-Signature"], retry.calls[1].headers["X-Signature"]);
  assert.equal(verifySignature(signingString("balanceQuery", {}, Number(retry.calls[1].headers["X-Timestamp"]), 5000), retry.calls[1].headers["X-Signature"], API_KEY), true);
});

// ---- run ------------------------------------------------------------------------------------------

(async () => {
  let n = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      n++;
      console.log(`ok - ${name}`);
    } catch (err) {
      console.error(`FAIL - ${name}`);
      console.error(err);
      process.exit(1);
    }
  }
  console.log(`${n} backpack tests passed (no network)`);
})();
