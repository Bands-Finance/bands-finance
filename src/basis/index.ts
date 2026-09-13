/**
 * Basis: every stock pool in data/screen.json priced against its Backpack perp.
 *
 *   basisPct = poolPrice / perpMid - 1     (positive: the on-chain xStock trades rich to the perp)
 *   poolPrice is in USD: a SOL-quoted pool's price is converted with the screen's solPriceUsd.
 *
 * Writes data/basis.json:
 *   { generatedAt, session, minutesToOpen, clock, thresholds,
 *     rows: [{ pool, venue, symbol, ticker, poolPrice, perpSymbol, perpMid, basisPct, spreadPct,
 *              fundingRatePerHour, fundingAprPct, perpVolume24hUsd, ... }] }
 *
 * The screen shape is being extended concurrently, so the reader treats every field as optional:
 * a pool is a stock pool when `stock` is set, or when its base symbol matches /^[A-Z.]{1,6}x$/
 * and its base mint starts with "Xs" (the xStocks convention).
 *
 * Routes: basisRoutes(app) mounts GET /api/basis (the file; 404 with a plain reason when absent).
 * Script: npx tsx src/scripts/basis.ts
 */
import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { config } from "../config";
import { BackpackClient, backpack, num, perpForBase, perpForStock, securityFor, type BackpackMarket, type BackpackSecurity } from "../tools/backpack";
import { sessionClock, type SessionClock, type UsEquitySession } from "./session";
import { basisThresholds, type BasisThresholds } from "./verdict";

export * from "./session";
export * from "./verdict";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export const dataDir = () => path.resolve(process.cwd(), config.dataDir);
export const basisFile = () => path.join(dataDir(), "basis.json");
export const screenFile = () => path.join(dataDir(), "screen.json");

// ---- the screen, read tolerantly -------------------------------------------------------------------

export interface ScreenStockPool {
  /** pool address */
  pool: string;
  venue: string;
  /** base token symbol as the screen names it ("NVDAx") */
  symbol: string;
  /** the stock ticker ("NVDA") */
  ticker: string;
  baseMint: string | null;
  quoteSymbol: string | null;
  /** on-chain price in USD per token: `price` for a USDC pool, `price` x solPriceUsd for a SOL pool, else the screen's priceUsd */
  poolPrice: number | null;
  /** on-chain price in quote units as the screen reports it (SOL per token for a SOL-quoted pool) */
  priceInQuote: number | null;
  /** who issued the stock token ("xstocks", "backpack"), when the screen says */
  issuer: string | null;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  name: string | null;
}

const XSTOCK_SYMBOL = /^[A-Z.]{1,6}x$/;

/** The stock ticker a screen row refers to: the `stock` field (string or {ticker|symbol}) or the xStock symbol. */
export function stockTickerOf(row: Obj): string | null {
  const stock = row.stock;
  if (typeof stock === "string" && stock.trim()) return stock.trim().toUpperCase().replace(/\.US$/, "");
  if (stock && typeof stock === "object") {
    const t = str(obj(stock).ticker) ?? str(obj(stock).symbol) ?? str(obj(stock).asset);
    if (t) return t.toUpperCase().replace(/\.US$/, "");
  }
  const base = str(row.baseSymbol) ?? str(row.symbol);
  if (base && XSTOCK_SYMBOL.test(base)) return base.slice(0, -1);
  return null;
}

/** A stock pool: `stock` set, or an xStock base (symbol TICKERx, mint "Xs..."). */
export function isStockPool(row: Obj): boolean {
  if (row.stock !== undefined && row.stock !== null && row.stock !== false && row.stock !== "") return true;
  const base = str(row.baseSymbol) ?? str(row.symbol);
  const mint = str(row.baseMint) ?? str(obj(row.baseToken).mint);
  return !!base && XSTOCK_SYMBOL.test(base) && !!mint && mint.startsWith("Xs");
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
const STABLE_QUOTES = new Set(["USDC", "USDT", "USD1", "PYUSD", "USDS"]);

function quoteOf(row: Obj): string | null {
  const sym = str(row.quoteSymbol) ?? str(obj(row.quoteToken).symbol);
  if (sym) return sym.toUpperCase();
  const mint = str(row.quoteMint) ?? str(obj(row.quoteToken).mint);
  if (mint === SOL_MINT) return "SOL";
  if (mint === config.usdcMint) return "USDC";
  return null;
}

function priceInQuoteOf(row: Obj): number | null {
  return num(row.price) ?? num(row.activePrice) ?? num(row.tokenPriceInQuote);
}

/**
 * The on-chain price in USD. `price` is in quote units: USD already for a stable-quoted pool, SOL for
 * a SOL-quoted one (x the screen's solPriceUsd). The screen's priceUsd is the fallback either way.
 */
export function poolPriceUsdOf(row: Obj, solPriceUsd: number | null): number | null {
  const quote = quoteOf(row);
  const inQuote = priceInQuoteOf(row);
  const usd = num(row.priceUsd);
  if (quote === "SOL") return inQuote !== null && solPriceUsd !== null && solPriceUsd > 0 ? inQuote * solPriceUsd : usd;
  if (quote && STABLE_QUOTES.has(quote)) return inQuote ?? usd;
  return usd ?? (quote === null ? inQuote : null);
}

/** The pool rows of any screen shape: an array, {pools}, {rows}, or {results}. */
export function screenRows(raw: unknown): Obj[] {
  if (Array.isArray(raw)) return raw.map(obj);
  const o = obj(raw);
  for (const key of ["pools", "rows", "results", "ranked"]) {
    if (Array.isArray(o[key])) return (o[key] as unknown[]).map(obj);
  }
  return [];
}

/** The screen's SOL price, when it carries one (needed to price SOL-quoted stock pools in USD). */
export function screenSolPriceUsd(raw: unknown): number | null {
  const n = num(obj(raw).solPriceUsd);
  return n !== null && n > 0 ? n : null;
}

export function stockPoolsOf(raw: unknown): ScreenStockPool[] {
  const out: ScreenStockPool[] = [];
  const solPriceUsd = screenSolPriceUsd(raw);
  for (const row of screenRows(raw)) {
    if (!isStockPool(row)) continue;
    const pool = str(row.address) ?? str(row.pool) ?? str(row.poolAddress);
    const ticker = stockTickerOf(row);
    if (!pool || !ticker) continue;
    out.push({
      pool,
      venue: str(row.venue) ?? str(row.dex) ?? str(row.protocol) ?? "meteora-dlmm",
      symbol: str(row.baseSymbol) ?? str(row.symbol) ?? `${ticker}x`,
      ticker,
      baseMint: str(row.baseMint) ?? str(obj(row.baseToken).mint),
      quoteSymbol: quoteOf(row),
      poolPrice: poolPriceUsdOf(row, solPriceUsd),
      priceInQuote: priceInQuoteOf(row),
      issuer: str(obj(row.stock).issuer),
      tvlUsd: num(row.tvlUsd),
      volume24hUsd: num(row.volume24hUsd),
      name: str(row.name),
    });
  }
  return out;
}

/** Parse a screen file; [] when missing or malformed (the feed must never crash the loop). */
export function loadScreenStockPools(file: string = screenFile()): ScreenStockPool[] {
  try {
    if (!fs.existsSync(file)) return [];
    return stockPoolsOf(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (err) {
    console.warn(`[basis] cannot read ${file}: ${(err as Error).message}`);
    return [];
  }
}

// ---- the basis ----------------------------------------------------------------------------------

export interface BasisRow {
  pool: string;
  venue: string;
  symbol: string;
  ticker: string;
  issuer: string | null;
  quoteSymbol: string | null;
  /** on-chain price in USD per token */
  poolPrice: number | null;
  /** on-chain price in quote units (SOL per token for a SOL-quoted pool) */
  priceInQuote: number | null;
  perpSymbol: string | null;
  perpMid: number | null;
  /** poolPrice / perpMid - 1, in percent */
  basisPct: number | null;
  /** top-of-book spread on the perp, in percent of mid */
  spreadPct: number | null;
  /** last funding rate normalised to per hour, as a fraction */
  fundingRatePerHour: number | null;
  /** fundingRatePerHour x 24 x 365, in percent */
  fundingAprPct: number | null;
  perpVolume24hUsd: number | null;
  perpLast: number | null;
  perpOrderBookState: string | null;
  /** what Backpack's securities list says: RFQ sessions + quantity limits (for the site) */
  security: BackpackSecurity | null;
  note: string | null;
}

export interface BasisFile {
  generatedAt: string;
  session: UsEquitySession;
  minutesToOpen: number;
  clock: SessionClock;
  thresholds: BasisThresholds;
  rows: BasisRow[];
}

interface PerpQuote {
  mid: number | null;
  spreadPct: number | null;
  last: number | null;
  volume24hUsd: number | null;
  fundingRatePerHour: number | null;
  error: string | null;
}

async function quotePerp(client: BackpackClient, market: BackpackMarket): Promise<PerpQuote> {
  const q: PerpQuote = { mid: null, spreadPct: null, last: null, volume24hUsd: null, fundingRatePerHour: null, error: null };
  const errors: string[] = [];
  try {
    const depth = await client.depth(market.symbol, 20);
    q.mid = depth?.mid ?? null;
    q.spreadPct = depth?.spreadPct ?? null;
  } catch (err) {
    errors.push(`depth: ${(err as Error).message}`);
  }
  try {
    const t = await client.ticker(market.symbol);
    q.last = t?.lastPrice ?? null;
    q.volume24hUsd = t?.quoteVolume ?? null;
    if (q.mid === null && q.last !== null) q.mid = q.last; // an empty book: fall back to the last trade
  } catch (err) {
    errors.push(`ticker: ${(err as Error).message}`);
  }
  try {
    const rates = await client.fundingRates(market.symbol, 1);
    const latest = rates?.[0];
    if (latest) {
      const intervalHours = market.fundingInterval && market.fundingInterval > 0 ? market.fundingInterval / 3_600_000 : 1;
      q.fundingRatePerHour = latest.fundingRate / intervalHours;
    }
  } catch (err) {
    errors.push(`funding: ${(err as Error).message}`);
  }
  q.error = errors.length ? errors.join("; ") : null;
  return q;
}

/** Price every stock pool against its Backpack perp. One quote per perp, however many pools share it. */
export async function computeBasis(pools: ScreenStockPool[], client: BackpackClient = backpack(), now: Date = new Date()): Promise<BasisFile> {
  const clock = sessionClock(now);
  const thresholds = basisThresholds();
  let markets: BackpackMarket[] = [];
  let securities: BackpackSecurity[] = [];
  let marketsError: string | null = null;
  try {
    markets = await client.markets();
  } catch (err) {
    marketsError = `markets: ${(err as Error).message}`;
    console.warn(`[basis] ${marketsError}`);
  }
  try {
    securities = await client.securities();
  } catch (err) {
    console.warn(`[basis] securities: ${(err as Error).message}`);
  }

  const quotes = new Map<string, Promise<PerpQuote>>();
  const rows: BasisRow[] = [];
  for (const p of pools) {
    const market = markets.length ? perpForStock(p.ticker, markets) ?? perpForBase(p.symbol, markets) : null;
    const row: BasisRow = {
      pool: p.pool,
      venue: p.venue,
      symbol: p.symbol,
      ticker: p.ticker,
      issuer: p.issuer,
      quoteSymbol: p.quoteSymbol,
      poolPrice: p.poolPrice,
      priceInQuote: p.priceInQuote,
      perpSymbol: market?.symbol ?? null,
      perpMid: null,
      basisPct: null,
      spreadPct: null,
      fundingRatePerHour: null,
      fundingAprPct: null,
      perpVolume24hUsd: null,
      perpLast: null,
      perpOrderBookState: market?.orderBookState ?? null,
      security: securityFor(p.ticker, securities),
      note: null,
    };
    if (!market) {
      row.note = marketsError ?? `no Backpack perp for ${p.ticker}`;
      rows.push(row);
      continue;
    }
    let pending = quotes.get(market.symbol);
    if (!pending) {
      pending = quotePerp(client, market);
      quotes.set(market.symbol, pending);
    }
    const q = await pending;
    row.perpMid = q.mid;
    row.perpLast = q.last;
    row.spreadPct = q.spreadPct;
    row.perpVolume24hUsd = q.volume24hUsd;
    row.fundingRatePerHour = q.fundingRatePerHour;
    row.fundingAprPct = q.fundingRatePerHour === null ? null : q.fundingRatePerHour * 24 * 365 * 100;
    row.basisPct = p.poolPrice !== null && q.mid !== null && q.mid > 0 ? (p.poolPrice / q.mid - 1) * 100 : null;
    row.note = q.error ?? (market.orderBookState !== "Open" ? `perp book ${market.orderBookState}` : null);
    rows.push(row);
  }

  return {
    generatedAt: now.toISOString(),
    session: clock.session,
    minutesToOpen: clock.minutesToOpen,
    clock,
    thresholds,
    rows,
  };
}

export function writeBasis(basis: BasisFile, file: string = basisFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(basis, null, 2));
  fs.renameSync(tmp, file);
}

export function loadBasis(file: string = basisFile()): BasisFile | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as BasisFile;
    return parsed && Array.isArray(parsed.rows) ? parsed : null;
  } catch {
    return null;
  }
}

/** Read the screen, quote Backpack, write data/basis.json. */
export async function refreshBasis(opts: { screen?: string; out?: string; client?: BackpackClient; now?: Date } = {}): Promise<BasisFile> {
  const pools = loadScreenStockPools(opts.screen);
  const basis = await computeBasis(pools, opts.client ?? backpack(), opts.now ?? new Date());
  writeBasis(basis, opts.out);
  return basis;
}

/** The basis row for a pool address, from the last written file. */
export function basisForPool(pool: string, basis: BasisFile | null = loadBasis()): BasisRow | null {
  return basis?.rows.find((r) => r.pool === pool) ?? null;
}

/** GET /api/basis: the file as written; 404 with a plain reason when it has not been produced. */
export function basisRoutes(app: Hono, file: string = basisFile()): void {
  app.get("/api/basis", (c) => {
    const basis = loadBasis(file);
    if (!basis) return c.text("basis not computed yet: run `npx tsx src/scripts/basis.ts`", 404);
    return c.json(basis);
  });
}
