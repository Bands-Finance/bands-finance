/**
 * Jupiter swaps through the free lite API (https://lite-api.jup.ag/swap/v1, no key), for the two
 * swap legs a stock straddle needs: the ACQUIRE leg (buy the token half with the quote before a
 * BOTH deposit) and the LIQUIDATE leg (sell the token a closing band hands back, so the book
 * returns to USDC). Nothing here signs or sends: `quote()` prices a route and `buildSwap()` returns
 * the VersionedTransaction Jupiter assembled for the wallet; src/executor.ts simulates it in dry-run
 * and broadcasts it through src/tools/wallet.ts live, exactly like a venue transaction.
 *
 *   GET  {JUPITER_API_URL}/quote?inputMint=&outputMint=&amount=&slippageBps=[&swapMode=ExactOut]
 *   POST {JUPITER_API_URL}/swap  { quoteResponse, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }
 *        -> { swapTransaction: base64 VersionedTransaction, lastValidBlockHeight, ... }
 *
 * Requests are paced >= 600 ms apart (the lite tier is rate limited), 429/5xx/network errors are
 * retried with backoff (retry-after honoured), 10 s timeout. A route that does not exist is a
 * JupiterError with the API's own message ("No routes found"); ExactOut is not routed for every
 * pair (SPYx has none), so the executor sizes the acquire leg ExactIn.
 *
 * Paper mode never calls Jupiter: paperSwap() fills at the pool's own price less SWAP_FEE_PCT
 * (default 0.1%, the route's fee) and IGNORES price impact: a paper fill assumes the route is deep
 * enough that the desk's size does not move it, which holds for the sizes the stock book trades
 * against $1M+ pools but overstates the fill on a thin one.
 *
 * Env: JUPITER_API_URL (default the lite endpoint), SWAP_SLIPPAGE_BPS (default 50), SWAP_FEE_PCT
 * (paper fills, default 0.1). Read at call time so tests pin their own.
 */
import { PublicKey, VersionedTransaction } from "@solana/web3.js";

export const JUPITER_API_URL_DEFAULT = "https://lite-api.jup.ag/swap/v1";
export const SWAP_SLIPPAGE_BPS_DEFAULT = 50;
export const SWAP_FEE_PCT_DEFAULT = 0.1;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JupiterEnv {
  apiUrl: string;
  slippageBps: number;
  /** paper fills: the fee charged on the input, in percent */
  feePct: number;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function jupiterEnv(env: NodeJS.ProcessEnv = process.env): JupiterEnv {
  const url = (env.JUPITER_API_URL ?? "").trim();
  return {
    apiUrl: (url || JUPITER_API_URL_DEFAULT).replace(/\/$/, ""),
    slippageBps: Math.max(0, Math.floor(num(env.SWAP_SLIPPAGE_BPS, SWAP_SLIPPAGE_BPS_DEFAULT))),
    feePct: Math.max(0, num(env.SWAP_FEE_PCT, SWAP_FEE_PCT_DEFAULT)),
  };
}

export class JupiterError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: string | null) {
    super(message);
    this.name = "JupiterError";
  }
}

export interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  /** raw units (lamports / base units) of the input for ExactIn, of the output for ExactOut */
  amount: bigint | number | string;
  slippageBps?: number;
  swapMode?: "ExactIn" | "ExactOut";
}

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  /** the worst amount the swap accepts: min out for ExactIn, max in for ExactOut */
  otherAmountThreshold: bigint;
  swapMode: "ExactIn" | "ExactOut";
  slippageBps: number;
  /** percent, as Jupiter reports it (0 when the route is deep) */
  priceImpactPct: number;
  /** the venues on the route, in order ("Quantum", "Raydium CLMM", ...) */
  routeLabels: string[];
  /** the quote as returned: what /swap wants back verbatim */
  raw: Record<string, unknown>;
}

export interface SwapBuild {
  tx: VersionedTransaction;
  lastValidBlockHeight: number | null;
  /** lamports Jupiter set as the priority fee, when it says */
  prioritizationFeeLamports: number | null;
  raw: Record<string, unknown>;
}

export interface JupiterClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** minimum gap between request starts; default 600 ms */
  minGapMs?: number;
  /** per-request timeout; default 10 s */
  timeoutMs?: number;
  /** retries on 429/5xx/network errors; default 3 */
  maxRetries?: number;
  /** default SWAP_SLIPPAGE_BPS */
  slippageBps?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const big = (v: unknown): bigint => {
  try {
    return BigInt(String(v ?? "0"));
  } catch {
    return 0n;
  }
};

/** UI amount -> raw units as a bigint, without float precision loss (toFixed at the token's decimals, floored). */
export function toRawUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`bad amount ${amount}`);
  const [whole, frac = ""] = amount.toFixed(decimals).split(".");
  return BigInt(`${whole}${frac.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, ""));
}

/** raw units -> UI amount */
export const fromRawUnits = (raw: bigint | number | string, decimals: number): number => Number(raw) / 10 ** decimals;

export class JupiterClient {
  readonly baseUrl: string;
  readonly slippageBps: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minGapMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private chain: Promise<void> = Promise.resolve();
  private lastStart = Number.NEGATIVE_INFINITY;

  constructor(opts: JupiterClientOptions = {}) {
    const env = jupiterEnv();
    this.baseUrl = (opts.baseUrl ?? env.apiUrl).replace(/\/$/, "");
    this.slippageBps = opts.slippageBps ?? env.slippageBps;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? defaultSleep;
    this.minGapMs = opts.minGapMs ?? 600;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 3;
  }

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
    const ra = Number(retryAfter);
    const ms = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : Math.min(500 * 2 ** attempt, 10_000);
    await this.sleep(ms);
  }

  private async request<T>(method: "GET" | "POST", path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    let attempt = 0;
    for (;;) {
      await this.pace();
      let res: Response;
      try {
        res = await this.fetchImpl(url.toString(), {
          method,
          headers: { accept: "application/json", ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt < this.maxRetries) {
          await this.backoff(attempt++, null);
          continue;
        }
        throw new JupiterError(`${method} ${path}: ${(err as Error).message}`, 0, null);
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt < this.maxRetries) {
          await this.backoff(attempt++, res.headers.get("retry-after"));
          continue;
        }
        throw new JupiterError(`${method} ${path} -> HTTP ${res.status}`, res.status, await res.text().catch(() => null));
      }
      const text = await res.text();
      if (!res.ok) {
        let detail = text.slice(0, 200);
        try {
          const parsed = obj(JSON.parse(text));
          if (typeof parsed.error === "string") detail = `${parsed.error}${parsed.errorCode ? ` (${parsed.errorCode})` : ""}`;
        } catch {
          /* not JSON */
        }
        throw new JupiterError(`${method} ${path} -> HTTP ${res.status}: ${detail}`, res.status, text);
      }
      return (text ? JSON.parse(text) : null) as T;
    }
  }

  /** Price a route. Throws JupiterError when Jupiter finds none. */
  async quote(req: QuoteRequest): Promise<JupiterQuote> {
    const amount = BigInt(req.amount);
    if (amount <= 0n) throw new Error(`quote: amount must be > 0 (got ${req.amount})`);
    const slippageBps = req.slippageBps ?? this.slippageBps;
    const raw = obj(
      await this.request<unknown>("GET", "/quote", {
        query: { inputMint: req.inputMint, outputMint: req.outputMint, amount: amount.toString(), slippageBps, swapMode: req.swapMode === "ExactOut" ? "ExactOut" : undefined },
      }),
    );
    if (typeof raw.error === "string") throw new JupiterError(`quote: ${raw.error}`, 400, JSON.stringify(raw));
    const plan = Array.isArray(raw.routePlan) ? raw.routePlan : [];
    return {
      inputMint: String(raw.inputMint ?? req.inputMint),
      outputMint: String(raw.outputMint ?? req.outputMint),
      inAmount: big(raw.inAmount),
      outAmount: big(raw.outAmount),
      otherAmountThreshold: big(raw.otherAmountThreshold),
      swapMode: raw.swapMode === "ExactOut" ? "ExactOut" : "ExactIn",
      slippageBps: Number(raw.slippageBps ?? slippageBps) || slippageBps,
      // Jupiter reports the impact as a FRACTION ("0.0031" = 0.31%); we carry a percent
      priceImpactPct: (Number(raw.priceImpactPct ?? 0) || 0) * 100,
      routeLabels: plan.map((leg) => String(obj(obj(leg).swapInfo).label ?? "?")),
      raw,
    };
  }

  /** The swap transaction for a quote, for `userPublicKey` to sign. Not signed, not sent. */
  async buildSwap(quote: JupiterQuote, userPublicKey: string | PublicKey, opts: { wrapAndUnwrapSol?: boolean; dynamicComputeUnitLimit?: boolean } = {}): Promise<SwapBuild> {
    const user = typeof userPublicKey === "string" ? userPublicKey : userPublicKey.toBase58();
    const raw = obj(
      await this.request<unknown>("POST", "/swap", {
        body: { quoteResponse: quote.raw, userPublicKey: user, wrapAndUnwrapSol: opts.wrapAndUnwrapSol ?? true, dynamicComputeUnitLimit: opts.dynamicComputeUnitLimit ?? true },
      }),
    );
    if (typeof raw.error === "string") throw new JupiterError(`swap: ${raw.error}`, 400, JSON.stringify(raw));
    const b64 = raw.swapTransaction;
    if (typeof b64 !== "string" || !b64) throw new JupiterError("swap: no swapTransaction in the response", 0, JSON.stringify(raw).slice(0, 200));
    const tx = VersionedTransaction.deserialize(new Uint8Array(Buffer.from(b64, "base64")));
    const lvbh = Number(raw.lastValidBlockHeight);
    const fee = Number(raw.prioritizationFeeLamports);
    return { tx, lastValidBlockHeight: Number.isFinite(lvbh) ? lvbh : null, prioritizationFeeLamports: Number.isFinite(fee) ? fee : null, raw };
  }
}

let shared: JupiterClient | null = null;

/** The process-wide client (env settings). */
export function jupiter(): JupiterClient {
  if (!shared) shared = new JupiterClient();
  return shared;
}

export interface PaperFill {
  /** what comes out, in the output token's units */
  amountOut: number;
  /** the fee, in the INPUT token's units */
  feeIn: number;
  /** the fee as a share of the input, percent */
  feePct: number;
}

/**
 * A paper fill: `amountIn` of the input token at `rate` output-per-input (1 / tokenPriceInQuote to
 * BUY the token with quote, tokenPriceInQuote to SELL it), less `feePct` of the input. Price impact
 * is ignored (see the header). Pure.
 */
export function paperSwap(amountIn: number, rate: number, feePct: number = jupiterEnv().feePct): PaperFill {
  if (!(amountIn >= 0) || !Number.isFinite(amountIn)) throw new Error(`paperSwap: bad amountIn ${amountIn}`);
  if (!(rate > 0) || !Number.isFinite(rate)) throw new Error(`paperSwap: bad rate ${rate}`);
  const f = Math.min(Math.max(feePct, 0), 100) / 100;
  const feeIn = amountIn * f;
  return { amountOut: (amountIn - feeIn) * rate, feeIn, feePct: f * 100 };
}

/** The quote needed to receive `tokenOut` tokens at `tokenPriceInQuote` after a `feePct` fee on the input (paperSwap's inverse). */
export function paperCostToBuy(tokenOut: number, tokenPriceInQuote: number, feePct: number = jupiterEnv().feePct): number {
  const f = Math.min(Math.max(feePct, 0), 100) / 100;
  if (f >= 1) throw new Error("paperCostToBuy: fee of 100% or more");
  return (tokenOut * tokenPriceInQuote) / (1 - f);
}
