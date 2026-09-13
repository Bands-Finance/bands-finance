/**
 * Backpack Exchange (https://docs.backpack.exchange/) for bands.finance.
 *
 * Backpack is the Solana-native exchange with 24/7 perpetual futures on US stocks
 * (NVDA.US_USDC_PERP, TSLA.US_USDC_PERP, SPY.US_USDC_PERP, AAPL.US_USDC_PERP, ...), spot books for
 * a few tokenized stocks (MU.US_USDC, SPCX.US_USDC, ...), 1,148 securities tradable by RFQ during
 * US sessions, and on-chain Solana deposits/withdrawals. Mr Bands provides liquidity on-chain in
 * xStock pools (NVDAx/USDC ...): this client is the reference feed that prices those pools against
 * the perp (src/basis) and, dormant, the hedge desk (src/engine/hedge.ts).
 *
 * Public (no keys): markets, securities, tickers/ticker, depth, fundingRates, klines.
 *   Requests are paced >= 250 ms apart, 429/5xx retried with backoff, 10 s timeout. A missing
 *   symbol returns null and never throws. markets/securities are cached 1h in memory.
 *
 * Signed (dormant until BACKPACK_API_KEY and BACKPACK_API_SECRET are set; base64 ed25519 keys as
 * the docs describe): balances, positions, openOrders, placeOrder, cancelOrder.
 *   Confirmed against https://docs.backpack.exchange/ ("Authentication"):
 *     headers   X-API-Key (base64 public key), X-Signature (base64 ed25519 signature),
 *               X-Timestamp (unix ms), X-Window (ms; default 5000, max 60000)
 *     message   "The key/values of the request body or query parameters should be ordered
 *               alphabetically and then turned into query string format. Append the header values
 *               for the timestamp and receive window ... in the format &timestamp=<timestamp>&window=<window>.
 *               The correct instruction type should be prefixed to the signing string."
 *               -> instruction=<name>&<k=v sorted alphabetically>&timestamp=<ms>&window=<ms>
 *     example   instruction=orderCancel&orderId=28&symbol=BTC_USDT&timestamp=1614550000000&window=5000
 *   Instructions used here (name -> method path):
 *     balanceQuery   GET    /api/v1/balances
 *     positionQuery  GET    /api/v1/positions
 *     orderQueryAll  GET    /api/v1/orders
 *     orderExecute   POST   /api/v1/order
 *     orderCancel    DELETE /api/v1/order
 *   placeOrder/cancelOrder refuse unless HEDGE_LIVE=true AND DRY_RUN is the literal "false".
 */
import nacl from "tweetnacl";
import { config } from "../config";

export const BACKPACK_API_URL = "https://api.backpack.exchange";

// ---- types --------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
export type Params = Record<string, string | number | boolean | undefined | null>;
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface BackpackMarket {
  symbol: string;
  /** "NVDA.US" for a stock market, "SOL" for a crypto one */
  baseSymbol: string;
  quoteSymbol: string;
  /** SPOT | PERP | IPERP | DATED | PREDICTION | RFQ */
  marketType: string;
  rwaMarketType: "STOCK" | "INDEX" | null;
  /** Open | PostOnly | Closed | ... */
  orderBookState: string;
  /** funding interval in ms (3600000 = hourly); null for spot */
  fundingInterval: number | null;
  visible: boolean;
  filters: { tickSize: number | null; minQuantity: number | null; maxQuantity: number | null; stepSize: number | null };
}

export interface BackpackSecuritySession {
  /** US_EQUITIES_PRE_MARKET | US_EQUITIES_REGULAR | US_EQUITIES_POST_MARKET | US_EQUITIES_OVERNIGHT */
  name: string;
  minQuantity: number | null;
  maxQuantity: number | null;
  stepSize: number | null;
}

export interface BackpackSecurity {
  /** "AAPL.US" */
  asset: string;
  cusip: string;
  name: string;
  sessions: BackpackSecuritySession[];
}

export interface BackpackTicker {
  symbol: string;
  lastPrice: number | null;
  firstPrice: number | null;
  high: number | null;
  low: number | null;
  priceChange: number | null;
  /** a fraction (-0.019 = -1.9%) as Backpack reports it */
  priceChangePercent: number | null;
  volume: number | null;
  quoteVolume: number | null;
  trades: number | null;
}

export interface BackpackDepth {
  symbol: string;
  /** [price, quantity] */
  bids: [number, number][];
  asks: [number, number][];
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  /** top-of-book spread in percent of mid */
  spreadPct: number | null;
  timestamp: number | null;
}

export interface BackpackFundingRate {
  symbol: string;
  /** per funding interval, as a fraction (-0.00000801 = -0.000801%) */
  fundingRate: number;
  intervalEndTimestamp: string;
}

export interface BackpackKline {
  start: string;
  end: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  quoteVolume: number | null;
  trades: number | null;
}

export interface BackpackBalance {
  available: number;
  locked: number;
  staked: number;
}

export interface BackpackPosition {
  symbol: string;
  /** negative = short */
  netQuantity: number;
  entryPrice: number | null;
  markPrice: number | null;
  pnlUnrealized: number | null;
  pnlRealized: number | null;
  cumulativeFundingPayment: number | null;
  raw: Obj;
}

export interface BackpackOrder {
  id: string;
  clientId: number | null;
  symbol: string;
  side: "Bid" | "Ask";
  orderType: string;
  quantity: number | null;
  price: number | null;
  status: string;
  executedQuantity: number | null;
  reduceOnly: boolean;
  postOnly: boolean;
  raw: Obj;
}

export interface PlaceOrderRequest {
  symbol: string;
  /** Backpack's side names: Bid = buy, Ask = sell */
  side: "Bid" | "Ask";
  orderType: "Limit" | "Market";
  quantity: number | string;
  price?: number | string;
  postOnly?: boolean;
  reduceOnly?: boolean;
  timeInForce?: "GTC" | "IOC" | "FOK";
  clientId?: number;
}

export interface CancelOrderRequest {
  symbol: string;
  orderId?: string;
  clientId?: number;
}

export class BackpackError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: string | null) {
    super(message);
    this.name = "BackpackError";
  }
}

/** Thrown when a trading call is attempted while the client is dormant (no keys, HEDGE_LIVE off, or dry-run). */
export class BackpackRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackpackRefusedError";
  }
}

// ---- parsing ------------------------------------------------------------------------------------

const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseMarket(m: Obj): BackpackMarket {
  const f = obj(m.filters);
  const q = obj(f.quantity);
  const p = obj(f.price);
  const rwa = m.rwaMarketType === "STOCK" || m.rwaMarketType === "INDEX" ? m.rwaMarketType : null;
  return {
    symbol: str(m.symbol),
    baseSymbol: str(m.baseSymbol),
    quoteSymbol: str(m.quoteSymbol),
    marketType: str(m.marketType),
    rwaMarketType: rwa,
    orderBookState: str(m.orderBookState),
    fundingInterval: num(m.fundingInterval),
    visible: m.visible !== false,
    filters: { tickSize: num(p.tickSize), minQuantity: num(q.minQuantity), maxQuantity: num(q.maxQuantity), stepSize: num(q.stepSize) },
  };
}

function parseSecurity(s: Obj): BackpackSecurity {
  return {
    asset: str(s.asset),
    cusip: str(s.cusip),
    name: str(s.name),
    sessions: (Array.isArray(s.sessions) ? s.sessions : []).map((x) => {
      const o = obj(x);
      return { name: str(o.name), minQuantity: num(o.minQuantity), maxQuantity: num(o.maxQuantity), stepSize: num(o.stepSize) };
    }),
  };
}

function parseTicker(t: Obj): BackpackTicker {
  return {
    symbol: str(t.symbol),
    lastPrice: num(t.lastPrice),
    firstPrice: num(t.firstPrice),
    high: num(t.high),
    low: num(t.low),
    priceChange: num(t.priceChange),
    priceChangePercent: num(t.priceChangePercent),
    volume: num(t.volume),
    quoteVolume: num(t.quoteVolume),
    trades: num(t.trades),
  };
}

function parseLevels(v: unknown): [number, number][] {
  if (!Array.isArray(v)) return [];
  const out: [number, number][] = [];
  for (const lvl of v) {
    if (!Array.isArray(lvl)) continue;
    const p = num(lvl[0]);
    const q = num(lvl[1]);
    if (p !== null && q !== null && p > 0) out.push([p, q]);
  }
  return out;
}

/** Depth with the top of book derived from the levels (Backpack sends bids ascending, so the best bid is the max, not the first). */
export function parseDepth(symbol: string, d: Record<string, unknown>): BackpackDepth {
  const bids = parseLevels(d.bids);
  const asks = parseLevels(d.asks);
  const bestBid = bids.length ? Math.max(...bids.map(([p]) => p)) : null;
  const bestAsk = asks.length ? Math.min(...asks.map(([p]) => p)) : null;
  // 12 significant digits: enough for any tick, and it strips float noise ((214.94 + 214.97) / 2 = 214.95499999999998)
  const mid = bestBid !== null && bestAsk !== null ? Number(((bestBid + bestAsk) / 2).toPrecision(12)) : null;
  const spreadPct = mid && bestBid !== null && bestAsk !== null ? ((bestAsk - bestBid) / mid) * 100 : null;
  return { symbol, bids, asks, bestBid, bestAsk, mid, spreadPct, timestamp: num(d.timestamp) };
}

function parseFunding(f: Obj): BackpackFundingRate | null {
  const rate = num(f.fundingRate);
  if (rate === null) return null;
  return { symbol: str(f.symbol), fundingRate: rate, intervalEndTimestamp: str(f.intervalEndTimestamp) };
}

function parseKline(k: Obj): BackpackKline {
  return {
    start: str(k.start),
    end: str(k.end),
    open: num(k.open),
    high: num(k.high),
    low: num(k.low),
    close: num(k.close),
    volume: num(k.volume),
    quoteVolume: num(k.quoteVolume),
    trades: num(k.trades),
  };
}

function parsePosition(p: Obj): BackpackPosition {
  return {
    symbol: str(p.symbol),
    netQuantity: num(p.netQuantity) ?? 0,
    entryPrice: num(p.entryPrice),
    markPrice: num(p.markPrice),
    pnlUnrealized: num(p.pnlUnrealized),
    pnlRealized: num(p.pnlRealized),
    cumulativeFundingPayment: num(p.cumulativeFundingPayment),
    raw: p,
  };
}

function parseOrder(o: Obj): BackpackOrder {
  return {
    id: str(o.id),
    clientId: num(o.clientId),
    symbol: str(o.symbol),
    side: o.side === "Ask" ? "Ask" : "Bid",
    orderType: str(o.orderType),
    quantity: num(o.quantity),
    price: num(o.price),
    status: str(o.status),
    executedQuantity: num(o.executedQuantity),
    reduceOnly: o.reduceOnly === true,
    postOnly: o.postOnly === true,
    raw: o,
  };
}

/** A decimal string without exponent notation (Backpack wants quantities and prices as strings). */
export function decimalString(v: number | string): string {
  if (typeof v === "string") return v.trim();
  if (!Number.isFinite(v)) throw new Error(`not a finite number: ${v}`);
  let s = String(v);
  if (/e/i.test(s)) s = v.toFixed(12).replace(/\.?0+$/, "");
  return s;
}

// ---- symbol mapping -------------------------------------------------------------------------------

/** "NVDAx" -> "NVDA"; null when the symbol is not an xStock (trailing lowercase x on an upper-case ticker). */
export function tickerOfXstock(symbol: string | null | undefined): string | null {
  const m = /^([A-Z][A-Z.]{0,5})x$/.exec((symbol ?? "").trim());
  return m ? m[1] : null;
}

/** "NVDA" -> "NVDA.US_USDC_PERP" (the symbol whether or not it is listed; see perpForStock). */
export function perpSymbolOf(ticker: string): string {
  return `${ticker.trim().toUpperCase()}.US_USDC_PERP`;
}

/** "MU" -> "MU.US_USDC" */
export function spotSymbolOf(ticker: string): string {
  return `${ticker.trim().toUpperCase()}.US_USDC`;
}

/** "NVDA" -> "NVDA.US" (the securities asset id) */
export function securityAssetOf(ticker: string): string {
  return `${ticker.trim().toUpperCase()}.US`;
}

/** The listed perp market for a stock ticker, or null when Backpack has none (PLTR today). */
export function perpForStock(ticker: string, markets: BackpackMarket[]): BackpackMarket | null {
  const symbol = perpSymbolOf(ticker);
  return markets.find((m) => m.symbol === symbol && m.marketType === "PERP") ?? null;
}

/** The listed spot market for a tokenized stock (MU.US_USDC ...), or null. */
export function spotForStock(ticker: string, markets: BackpackMarket[]): BackpackMarket | null {
  const symbol = spotSymbolOf(ticker);
  return markets.find((m) => m.symbol === symbol && m.marketType === "SPOT") ?? null;
}

/**
 * The perp that references a pool's base token: an xStock ("NVDAx") maps to the .US perp, anything
 * else ("SOL") to `${BASE}_USDC_PERP`. Null when Backpack lists no such perp.
 */
export function perpForBase(baseSymbol: string, markets: BackpackMarket[]): BackpackMarket | null {
  const ticker = tickerOfXstock(baseSymbol);
  if (ticker) return perpForStock(ticker, markets);
  const symbol = `${baseSymbol.trim().toUpperCase()}_USDC_PERP`;
  return markets.find((m) => m.symbol === symbol && m.marketType === "PERP") ?? null;
}

/** What Backpack's securities list says about a ticker (RFQ sessions + quantity limits), or null. */
export function securityFor(ticker: string, securities: BackpackSecurity[]): BackpackSecurity | null {
  const asset = securityAssetOf(ticker);
  return securities.find((s) => s.asset === asset) ?? null;
}

// ---- signing ------------------------------------------------------------------------------------

export interface BackpackSigner {
  /** base64 ed25519 public key = the X-API-Key header */
  publicKeyB64: string;
  /** 64-byte tweetnacl secret key (seed || public key) */
  secretKey: Uint8Array;
}

/**
 * Build a signer from the base64 key pair Backpack issues. The secret is the 32-byte ed25519 seed
 * (a 64-byte seed||pub secret key is accepted too). The derived public key must equal the API key.
 */
export function signerFromKeys(apiKey: string, apiSecret: string): BackpackSigner {
  const secret = new Uint8Array(Buffer.from(apiSecret.trim(), "base64"));
  let pair: ReturnType<typeof nacl.sign.keyPair>;
  if (secret.length === 32) pair = nacl.sign.keyPair.fromSeed(secret);
  else if (secret.length === 64) pair = nacl.sign.keyPair.fromSecretKey(secret);
  else throw new Error(`BACKPACK_API_SECRET must be a base64 32-byte ed25519 seed (got ${secret.length} bytes)`);
  const publicKeyB64 = Buffer.from(pair.publicKey).toString("base64");
  if (publicKeyB64 !== apiKey.trim()) throw new Error("BACKPACK_API_KEY does not match the public key derived from BACKPACK_API_SECRET");
  return { publicKeyB64, secretKey: pair.secretKey };
}

/**
 * The signing string per the docs: instruction=<name>&<params sorted alphabetically>&timestamp=<ms>&window=<ms>.
 * Params with undefined/null values are dropped; values are stringified as sent (booleans "true"/"false").
 */
export function signingString(instruction: string, params: Params, timestamp: number, window: number): string {
  const sorted = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`);
  return [`instruction=${instruction}`, ...sorted, `timestamp=${timestamp}`, `window=${window}`].join("&");
}

/** ed25519 detached signature of the message, base64. */
export function signMessage(message: string, secretKey: Uint8Array): string {
  return Buffer.from(nacl.sign.detached(new Uint8Array(Buffer.from(message, "utf8")), secretKey)).toString("base64");
}

export function verifySignature(message: string, signatureB64: string, publicKeyB64: string): boolean {
  try {
    return nacl.sign.detached.verify(
      new Uint8Array(Buffer.from(message, "utf8")),
      new Uint8Array(Buffer.from(signatureB64, "base64")),
      new Uint8Array(Buffer.from(publicKeyB64, "base64")),
    );
  } catch {
    return false;
  }
}

/** The four auth headers for one request. */
export function signedHeaders(signer: BackpackSigner, instruction: string, params: Params, timestamp: number, window: number): Record<string, string> {
  return {
    "X-API-Key": signer.publicKeyB64,
    "X-Signature": signMessage(signingString(instruction, params, timestamp, window), signer.secretKey),
    "X-Timestamp": String(timestamp),
    "X-Window": String(window),
  };
}

// ---- client -------------------------------------------------------------------------------------

export interface BackpackClientOptions {
  baseUrl?: string;
  apiKey?: string;
  apiSecret?: string;
  /** injectable for tests (no network) */
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** minimum gap between request starts; default 250 ms */
  minGapMs?: number;
  /** per-request timeout; default 10 s */
  timeoutMs?: number;
  /** retries on 429/5xx/network errors; default 3 */
  maxRetries?: number;
  /** markets/securities cache; default 1h */
  cacheTtlMs?: number;
  /** X-Window in ms; default 5000 */
  window?: number;
  /** trading guards; default env HEDGE_LIVE === "true" and config.dryRun */
  hedgeLive?: boolean;
  dryRun?: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class BackpackClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minGapMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly cacheTtlMs: number;
  private readonly window: number;
  private readonly signer: BackpackSigner | null;
  private readonly hedgeLive: boolean;
  private readonly dryRun: boolean;

  private chain: Promise<void> = Promise.resolve();
  private lastStart = Number.NEGATIVE_INFINITY;
  private marketsCache: { at: number; value: BackpackMarket[] } | null = null;
  private securitiesCache: { at: number; value: BackpackSecurity[] } | null = null;

  constructor(opts: BackpackClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? BACKPACK_API_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? defaultSleep;
    this.minGapMs = opts.minGapMs ?? 250;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.cacheTtlMs = opts.cacheTtlMs ?? 3_600_000;
    this.window = opts.window ?? 5000;
    const apiKey = (opts.apiKey ?? process.env.BACKPACK_API_KEY ?? "").trim();
    const apiSecret = (opts.apiSecret ?? process.env.BACKPACK_API_SECRET ?? "").trim();
    this.signer = apiKey && apiSecret ? signerFromKeys(apiKey, apiSecret) : null;
    this.hedgeLive = opts.hedgeLive ?? (process.env.HEDGE_LIVE ?? "").trim().toLowerCase() === "true";
    this.dryRun = opts.dryRun ?? config.dryRun;
  }

  /** keys are loaded (read-only signed calls work) */
  get configured(): boolean {
    return this.signer !== null;
  }

  /** the API key in use (base64 public key), or null */
  get apiKey(): string | null {
    return this.signer?.publicKeyB64 ?? null;
  }

  /** Why an order would be refused right now; ok only with keys + HEDGE_LIVE=true + DRY_RUN=false. */
  canTrade(): { ok: boolean; reason: string } {
    if (!this.signer) return { ok: false, reason: "BACKPACK_API_KEY / BACKPACK_API_SECRET not set" };
    if (!this.hedgeLive) return { ok: false, reason: "HEDGE_LIVE is not true" };
    if (this.dryRun) return { ok: false, reason: 'DRY_RUN is not the literal "false"' };
    return { ok: true, reason: "keys set, HEDGE_LIVE=true, DRY_RUN=false" };
  }

  // -- transport --

  /** Serialise request starts so they are >= minGapMs apart. */
  private pace(): Promise<void> {
    const run = this.chain.then(async () => {
      const wait = this.lastStart + this.minGapMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now();
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async backoff(attempt: number, retryAfter: string | null): Promise<void> {
    const ra = num(retryAfter);
    const ms = ra !== null && ra > 0 ? Math.min(ra * 1000, 10_000) : Math.min(500 * 2 ** attempt, 10_000);
    await this.sleep(ms);
  }

  private async request<T>(method: string, path: string, opts: { query?: Params; body?: Params; instruction?: string } = {}): Promise<{ status: number; data: T | null }> {
    const url = new URL(path, this.baseUrl + "/");
    const query: Params = {};
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === null) continue;
      query[k] = v;
      url.searchParams.set(k, String(v));
    }
    const body: Params | undefined = opts.body
      ? Object.fromEntries(Object.entries(opts.body).filter(([, v]) => v !== undefined && v !== null))
      : undefined;
    if (opts.instruction && !this.signer) throw new BackpackRefusedError(`${opts.instruction}: BACKPACK_API_KEY / BACKPACK_API_SECRET not set`);

    let attempt = 0;
    for (;;) {
      await this.pace();
      const headers: Record<string, string> = { accept: "application/json" };
      if (body) headers["content-type"] = "application/json";
      if (opts.instruction && this.signer) {
        Object.assign(headers, signedHeaders(this.signer, opts.instruction, { ...query, ...(body ?? {}) }, this.now(), this.window));
      }
      let res: Response;
      try {
        res = await this.fetchImpl(url.toString(), {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt < this.maxRetries) {
          await this.backoff(attempt++, null);
          continue;
        }
        throw new BackpackError(`${method} ${path}: ${(err as Error).message}`, 0, null);
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt < this.maxRetries) {
          await this.backoff(attempt++, res.headers.get("retry-after"));
          continue;
        }
        throw new BackpackError(`${method} ${path} -> HTTP ${res.status}`, res.status, await res.text().catch(() => null));
      }
      if (res.status === 204) return { status: 204, data: null };
      const text = await res.text();
      if (!res.ok) throw new BackpackError(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`, res.status, text);
      return { status: res.status, data: text ? (JSON.parse(text) as T) : null };
    }
  }

  /** null for the ways Backpack says "no such symbol": 204, 400 (Invalid market symbol), 404. */
  private async optional<T>(method: string, path: string, query: Params): Promise<T | null> {
    try {
      const { data } = await this.request<T>(method, path, { query });
      return data;
    } catch (err) {
      if (err instanceof BackpackError && (err.status === 400 || err.status === 404)) return null;
      throw err;
    }
  }

  // -- public market data --

  async markets(): Promise<BackpackMarket[]> {
    const t = this.now();
    if (this.marketsCache && t - this.marketsCache.at < this.cacheTtlMs) return this.marketsCache.value;
    const { data } = await this.request<unknown[]>("GET", "/api/v1/markets");
    const value = (Array.isArray(data) ? data : []).map((m) => parseMarket(obj(m)));
    this.marketsCache = { at: t, value };
    return value;
  }

  /** one market from the cached list; null when not listed */
  async market(symbol: string): Promise<BackpackMarket | null> {
    return (await this.markets()).find((m) => m.symbol === symbol) ?? null;
  }

  async perpForStock(ticker: string): Promise<BackpackMarket | null> {
    return perpForStock(ticker, await this.markets());
  }

  async spotForStock(ticker: string): Promise<BackpackMarket | null> {
    return spotForStock(ticker, await this.markets());
  }

  async perpForBase(baseSymbol: string): Promise<BackpackMarket | null> {
    return perpForBase(baseSymbol, await this.markets());
  }

  async securities(): Promise<BackpackSecurity[]> {
    const t = this.now();
    if (this.securitiesCache && t - this.securitiesCache.at < this.cacheTtlMs) return this.securitiesCache.value;
    const { data } = await this.request<unknown[]>("GET", "/api/v1/securities");
    const value = (Array.isArray(data) ? data : []).map((s) => parseSecurity(obj(s)));
    this.securitiesCache = { at: t, value };
    return value;
  }

  async security(ticker: string): Promise<BackpackSecurity | null> {
    return securityFor(ticker, await this.securities());
  }

  async tickers(): Promise<BackpackTicker[]> {
    const { data } = await this.request<unknown[]>("GET", "/api/v1/tickers");
    return (Array.isArray(data) ? data : []).map((t) => parseTicker(obj(t)));
  }

  async ticker(symbol: string): Promise<BackpackTicker | null> {
    const data = await this.optional<Obj>("GET", "/api/v1/ticker", { symbol });
    return data && typeof data === "object" ? parseTicker(obj(data)) : null;
  }

  /** The book; use `mid` for the perp reference and `spreadPct` for the top-of-book spread. */
  async depth(symbol: string, limit?: number): Promise<BackpackDepth | null> {
    const data = await this.optional<Obj>("GET", "/api/v1/depth", { symbol, limit });
    return data && typeof data === "object" ? parseDepth(symbol, obj(data)) : null;
  }

  /** Most recent first. Empty for a symbol that never funded; null for an unknown symbol. */
  async fundingRates(symbol: string, limit = 1): Promise<BackpackFundingRate[] | null> {
    const data = await this.optional<unknown[]>("GET", "/api/v1/fundingRates", { symbol, limit });
    if (data === null) return null;
    return (Array.isArray(data) ? data : []).map((f) => parseFunding(obj(f))).filter((f): f is BackpackFundingRate => f !== null);
  }

  /** startTime/endTime in unix SECONDS (as Backpack expects); interval "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | ... */
  async klines(symbol: string, interval: string, startTime: number, endTime?: number): Promise<BackpackKline[] | null> {
    const data = await this.optional<unknown[]>("GET", "/api/v1/klines", { symbol, interval, startTime: Math.floor(startTime), endTime: endTime === undefined ? undefined : Math.floor(endTime) });
    if (data === null) return null;
    return (Array.isArray(data) ? data : []).map((k) => parseKline(obj(k)));
  }

  // -- signed, read-only --

  /** GET /api/v1/balances (balanceQuery): { USDC: {available, locked, staked}, ... } */
  async balances(): Promise<Record<string, BackpackBalance>> {
    const { data } = await this.request<Obj>("GET", "/api/v1/balances", { instruction: "balanceQuery" });
    const out: Record<string, BackpackBalance> = {};
    for (const [asset, v] of Object.entries(obj(data))) {
      const b = obj(v);
      out[asset] = { available: num(b.available) ?? 0, locked: num(b.locked) ?? 0, staked: num(b.staked) ?? 0 };
    }
    return out;
  }

  /** GET /api/v1/positions (positionQuery) */
  async positions(): Promise<BackpackPosition[]> {
    const { data } = await this.request<unknown[]>("GET", "/api/v1/positions", { instruction: "positionQuery" });
    return (Array.isArray(data) ? data : []).map((p) => parsePosition(obj(p)));
  }

  /** GET /api/v1/orders (orderQueryAll), optionally for one symbol */
  async openOrders(symbol?: string): Promise<BackpackOrder[]> {
    const { data } = await this.request<unknown[]>("GET", "/api/v1/orders", { instruction: "orderQueryAll", query: { symbol } });
    return (Array.isArray(data) ? data : []).map((o) => parseOrder(obj(o)));
  }

  // -- signed, trading (dormant) --

  private assertTrading(what: string): void {
    const v = this.canTrade();
    if (!v.ok) throw new BackpackRefusedError(`${what} refused: ${v.reason}`);
  }

  /** POST /api/v1/order (orderExecute). Refuses unless canTrade(). */
  async placeOrder(req: PlaceOrderRequest): Promise<BackpackOrder> {
    this.assertTrading(`placeOrder ${req.side} ${req.quantity} ${req.symbol}`);
    const quantity = decimalString(req.quantity);
    if (!(Number(quantity) > 0)) throw new Error(`placeOrder: quantity must be > 0 (got ${req.quantity})`);
    if (req.orderType === "Limit" && (req.price === undefined || !(Number(req.price) > 0))) throw new Error("placeOrder: a Limit order needs a price");
    const body: Params = {
      symbol: req.symbol,
      side: req.side,
      orderType: req.orderType,
      quantity,
      price: req.orderType === "Limit" && req.price !== undefined ? decimalString(req.price) : undefined,
      postOnly: req.postOnly,
      reduceOnly: req.reduceOnly,
      timeInForce: req.timeInForce,
      clientId: req.clientId,
    };
    const { data } = await this.request<Obj>("POST", "/api/v1/order", { instruction: "orderExecute", body });
    return parseOrder(obj(data));
  }

  /** DELETE /api/v1/order (orderCancel). Refuses unless canTrade(). */
  async cancelOrder(req: CancelOrderRequest): Promise<BackpackOrder> {
    this.assertTrading(`cancelOrder ${req.orderId ?? req.clientId ?? "?"} ${req.symbol}`);
    if (!req.orderId && req.clientId === undefined) throw new Error("cancelOrder: orderId or clientId required");
    const { data } = await this.request<Obj>("DELETE", "/api/v1/order", {
      instruction: "orderCancel",
      body: { symbol: req.symbol, orderId: req.orderId, clientId: req.clientId },
    });
    return parseOrder(obj(data));
  }
}

let shared: BackpackClient | null = null;

/** The process-wide client (env keys if any). Lazy so a misconfigured key pair fails where it is used, not at import. */
export function backpack(): BackpackClient {
  if (!shared) shared = new BackpackClient();
  return shared;
}
