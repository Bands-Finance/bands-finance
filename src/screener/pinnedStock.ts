/**
 * PINNED STOCKS: the tokenized stocks the agent is paired with (PAIR_STOCK_PINNED_TICKERS). The
 * AnsemHack Clawrena entry is paired with NVDA (docs/clawrena.md), and Zach's rule for it is
 * Meteora only: "we dont want to use any other pools except meteora pools for this".
 *
 * So for a pinned ticker the desk works METEORA DLMM pools and nothing else:
 *   1. the ticker's existing Meteora DLMM pools quoted in SOL or USDC, found through DexScreener's
 *      token-pairs endpoint (dexId "meteora", label "DLMM"), with their real 24h volume and depth;
 *      the bin step and base fee are read from the pool account itself;
 *   2. the best of those the wallet can fund, by fee/TVL, is pinned into the book and worked as a
 *      stock straddle (hedged on Backpack where a perp exists), its floors waived: the pin is the
 *      operator's judgement, the guards, the stop and the basis check still apply;
 *   3. when Meteora has no such pool, the stock pair lane makes one of our own (floors waived too).
 * Swaps for the token half route through Meteora DLMM only when SWAP_DEXES says so (src/tools/jupiter.ts).
 *
 * On 2026-09-15 NVDAx had two: NVDAx/SOL (FCn5zw4g, bin step 20, 0.2%, $4.1k deep, $26.7k a day)
 * and NVDAx/USDC (F4inHs4R, bin step 25, 0.25%, $20.7k deep, $12.5k a day).
 *
 * Pure except refreshPinnedStocks, which takes its fetch and account reader as arguments.
 */
import { parseStockTickers } from "./pairStock";

export const METEORA_DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
export const SOL_MINT_ADDRESS = "So11111111111111111111111111111111111111112";
export const USDC_MINT_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const DEXSCREENER_TOKEN_PAIRS = "https://api.dexscreener.com/token-pairs/v1/solana";
/** how long a discovery is good for before the loop asks again */
export const PINNED_REFRESH_MS = 10 * 60_000;

/** The LbPair account (Meteora DLMM): 904 bytes; bin step at 80 (u16), base factor at 8 (u16), base fee power factor at 38 (u8). */
export const LB_PAIR_SIZE = 904;
const OFF_BASE_FACTOR = 8;
const OFF_BASE_FEE_POWER = 38;
const OFF_BIN_STEP = 80;

export interface PinnedPool {
  address: string;
  ticker: string;
  mint: string;
  /** the token's symbol as DexScreener names it ("NVDAx") */
  symbol: string;
  quoteSymbol: "SOL" | "USDC";
  quoteMint: string;
  binStep: number | null;
  baseFeePct: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  volume1hUsd: number | null;
  /** quote per token */
  priceNative: number | null;
  priceUsd: number | null;
  /** volume x base fee; null until the account read supplies the fee */
  fees24hUsd: number | null;
  feeToTvl24hPct: number | null;
}

export interface PinnedTicker {
  ticker: string;
  mint: string | null;
  /** Meteora DLMM pools for the mint quoted in SOL or USDC, best by fee/TVL first */
  pools: PinnedPool[];
  /** why the list is empty, when it is */
  note: string | null;
}

export interface PinnedStocks {
  generatedAt: string;
  tickers: PinnedTicker[];
}

/** PAIR_STOCK_PINNED_TICKERS: "NVDA" or "nvdax, TSLA" -> ["NVDA", "TSLA"]; unset -> []. */
export const pinnedTickers = (env: NodeJS.ProcessEnv = process.env): string[] => parseStockTickers(env.PAIR_STOCK_PINNED_TICKERS) ?? [];

const numOrNull = (x: unknown): number | null => {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * PURE. The Meteora DLMM pools in a DexScreener token-pairs answer where the mint is the BASE and the
 * quote is SOL or USDC. Every other venue, every pool quoting in the mint, every other quote is dropped:
 * those are not pools this lane may use.
 */
export function meteoraPoolsFromDexScreener(ticker: string, mint: string, answer: unknown, usdcMint: string = USDC_MINT_ADDRESS): PinnedPool[] {
  const rows = Array.isArray(answer) ? answer : Array.isArray((answer as { pairs?: unknown })?.pairs) ? (answer as { pairs: unknown[] }).pairs : [];
  const out: PinnedPool[] = [];
  const seen = new Set<string>();
  for (const r of rows as Record<string, any>[]) {
    if (r?.chainId && r.chainId !== "solana") continue;
    if (r?.dexId !== "meteora") continue;
    const labels: string[] = Array.isArray(r.labels) ? r.labels : [];
    if (!labels.includes("DLMM")) continue;
    if (r.baseToken?.address !== mint) continue;
    const quoteMint: string = r.quoteToken?.address ?? "";
    const quoteSymbol = quoteMint === SOL_MINT_ADDRESS ? "SOL" : quoteMint === usdcMint ? "USDC" : null;
    if (!quoteSymbol) continue;
    const address: string = r.pairAddress ?? "";
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push({
      address,
      ticker,
      mint,
      symbol: r.baseToken?.symbol ?? ticker,
      quoteSymbol,
      quoteMint,
      binStep: null,
      baseFeePct: null,
      liquidityUsd: numOrNull(r.liquidity?.usd),
      volume24hUsd: numOrNull(r.volume?.h24),
      volume1hUsd: numOrNull(r.volume?.h1),
      priceNative: numOrNull(r.priceNative),
      priceUsd: numOrNull(r.priceUsd),
      fees24hUsd: null,
      feeToTvl24hPct: null,
    });
  }
  return out;
}

/** PURE. Bin step and base fee from a Meteora LbPair account; null when the bytes are not one. */
export function lbPairFee(data: Uint8Array | null | undefined): { binStep: number; baseFeePct: number } | null {
  if (!data || data.length !== LB_PAIR_SIZE) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const binStep = view.getUint16(OFF_BIN_STEP, true);
  const baseFactor = view.getUint16(OFF_BASE_FACTOR, true);
  const power = view.getUint8(OFF_BASE_FEE_POWER);
  if (!(binStep > 0) || !(baseFactor > 0)) return null;
  // base fee = base factor x bin step x 10 x 10^power over FEE_PRECISION (1e9), as a percent
  const baseFeePct = (baseFactor * binStep * 10 ** power) / 1e6;
  return { binStep, baseFeePct: Math.round(baseFeePct * 1e6) / 1e6 };
}

/** PURE. The pool with its fee filled in: fees a day and fee/TVL from the real volume and depth. */
export function withFee(p: PinnedPool, fee: { binStep: number; baseFeePct: number } | null): PinnedPool {
  if (!fee) return p;
  const fees24hUsd = p.volume24hUsd !== null ? (p.volume24hUsd * fee.baseFeePct) / 100 : null;
  const feeToTvl24hPct = fees24hUsd !== null && p.liquidityUsd !== null && p.liquidityUsd > 0 ? (fees24hUsd / p.liquidityUsd) * 100 : null;
  return { ...p, binStep: fee.binStep, baseFeePct: fee.baseFeePct, fees24hUsd, feeToTvl24hPct };
}

/** PURE. Best first: fee/TVL (what a seat of a given size earns), then depth. Unknown yields last. */
export const rankPinnedPools = (pools: readonly PinnedPool[]): PinnedPool[] =>
  [...pools].sort((a, b) => (b.feeToTvl24hPct ?? -1) - (a.feeToTvl24hPct ?? -1) || (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1));

/** PURE. The pool to pin for a ticker: the best the wallet can fund, or null when Meteora has none it can. */
export function choosePinnedPool(t: PinnedTicker | undefined, quoteOk: (q: "SOL" | "USDC") => boolean): PinnedPool | null {
  if (!t) return null;
  return rankPinnedPools(t.pools).find((p) => quoteOk(p.quoteSymbol)) ?? null;
}

/** PURE. The pinned pool at an address, across every pinned ticker. */
export function pinnedPoolAt(file: PinnedStocks | null | undefined, address: string): PinnedPool | null {
  for (const t of file?.tickers ?? []) for (const p of t.pools) if (p.address === address) return p;
  return null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Discover each pinned ticker's Meteora DLMM pools: one DexScreener call per mint, one account read
 * for all the pools found. A failure for one ticker is recorded in its note and never throws; the
 * loop keeps the previous answer when a whole refresh fails.
 */
export async function refreshPinnedStocks(o: {
  tickers: readonly string[];
  mintOf: (ticker: string) => string | null;
  readAccounts: (addresses: string[]) => Promise<(Uint8Array | null)[]>;
  fetch?: FetchLike;
  now?: number;
  usdcMint?: string;
}): Promise<PinnedStocks> {
  const fetchImpl: FetchLike = o.fetch ?? ((input, init) => fetch(input, init));
  const tickers: PinnedTicker[] = [];
  for (const ticker of o.tickers) {
    const mint = o.mintOf(ticker);
    if (!mint) {
      tickers.push({ ticker, mint: null, pools: [], note: `no mint known for ${ticker}: the screen board carries no ${ticker} pool to read it from` });
      continue;
    }
    try {
      const res = await fetchImpl(`${DEXSCREENER_TOKEN_PAIRS}/${mint}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
      const pools = meteoraPoolsFromDexScreener(ticker, mint, await res.json(), o.usdcMint);
      tickers.push({ ticker, mint, pools, note: pools.length ? null : `Meteora has no DLMM pool for ${ticker} quoted in SOL or USDC` });
    } catch (err) {
      tickers.push({ ticker, mint, pools: [], note: `discovery failed: ${(err as Error).message}` });
    }
  }
  const all = tickers.flatMap((t) => t.pools);
  if (all.length) {
    let accounts: (Uint8Array | null)[] = [];
    try {
      accounts = await o.readAccounts(all.map((p) => p.address));
    } catch {
      accounts = [];
    }
    const fees = new Map(all.map((p, i) => [p.address, lbPairFee(accounts[i])] as const));
    for (const t of tickers) t.pools = rankPinnedPools(t.pools.map((p) => withFee(p, fees.get(p.address) ?? null)));
  }
  return { generatedAt: new Date(o.now ?? Date.now()).toISOString(), tickers };
}
