/** Helpers shared by the venue adapters: quote selection, tick math, symbol cleanup, paced JSON GETs. */
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export interface QuotePick {
  /** which side of the venue's A/B pair is the quote */
  side: "A" | "B";
  symbol: "SOL" | "USDC";
  decimals: number;
}

/** The quote is the USDC side when there is one, else the SOL side; a pool with neither is not ours. */
export function pickQuote(mintA: string, mintB: string): QuotePick | null {
  if (mintB === USDC_MINT) return { side: "B", symbol: "USDC", decimals: 6 };
  if (mintA === USDC_MINT) return { side: "A", symbol: "USDC", decimals: 6 };
  if (mintB === SOL_MINT) return { side: "B", symbol: "SOL", decimals: 9 };
  if (mintA === SOL_MINT) return { side: "A", symbol: "SOL", decimals: 9 };
  return null;
}

/**
 * The tick a concentrated pool sits at for a given UI price of B per A: ticks index the raw price
 * (B lamports per A lamport) in steps of one basis point.
 */
export function tickFromPrice(priceBPerA: number, decimalsA: number, decimalsB: number): number {
  if (!(priceBPerA > 0)) return 0;
  const raw = priceBPerA * 10 ** (decimalsB - decimalsA);
  return Math.floor(Math.log(raw) / Math.log(1.0001));
}

/** Venue APIs spell wrapped SOL as WSOL; the board says SOL. */
export const cleanSymbol = (s: unknown, fallbackMint: string): string => {
  const t = typeof s === "string" ? s.trim() : "";
  if (!t) return `${fallbackMint.slice(0, 4)}…${fallbackMint.slice(-4)}`;
  return t === "WSOL" ? "SOL" : t;
};

export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET JSON with a timeout and exponential backoff on 429 / 5xx / network errors. */
export async function getJson(
  url: string,
  { fetchImpl = fetch, attempts = 5, backoffMs = 1500, log = (_: string) => {}, label = "api" }: { fetchImpl?: typeof fetch; attempts?: number; backoffMs?: number; log?: (s: string) => void; label?: string } = {},
): Promise<unknown> {
  let delay = backoffMs;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} (not retried)`);
      return await res.json();
    } catch (err) {
      const msg = (err as Error).message;
      if (attempt >= attempts || msg.includes("not retried")) throw err;
      log(`[${label}] backoff ${delay}ms after: ${msg.slice(0, 80)}`);
      await sleep(delay);
      delay = Math.min(delay * 2, 20000);
    }
  }
}
