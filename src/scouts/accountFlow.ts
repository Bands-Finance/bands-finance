/**
 * THE ACCOUNT-DELTA SCOUT. The first scout fetched every successful transaction on every watched pool:
 * at least 59,000 getTransaction calls a day on 2026-09-17, several times that on a busy pool, 263 rate-limit
 * errors in a day, and a backfill that reached an hour of the pools that mattered most. The pool's own
 * account carries what the desk ranks and sizes on:
 *   - `active_id`: the price as a bin, exactly, so the travel of the last hour is exact at the poll's resolution;
 *   - `protocol_fee.amount_x / amount_y`: counters that only grow with swap fees (until the protocol withdraws
 *     them), and `parameters.protocol_share` says what share of every fee they are. The fees the pool paid in a
 *     window are the counters' growth over the share; the LP's part is the rest of it.
 * One getMultipleAccounts call reads a hundred pools. What is lost is per-swap detail (exact counts, the
 * largest print); "swaps" here are POLLS IN WHICH THE COUNTERS MOVED, a floor on the true count, and volume
 * is the fee over the pool's base fee rate, a ceiling while the variable fee is on. A swap routed with a host
 * fee sends a fifth of the protocol's cut elsewhere, so fees read a few percent low. Pure below the decoder.
 */
import { BorshCoder } from "@coral-xyz/anchor";
import { IDL } from "@meteora-ag/dlmm";
import { binShare, LONGEST_WINDOW_MS, type FlowPool, type PoolMeta, type WindowKey, type WindowStats } from "./flow";

export interface AccountSample {
  ts: number;
  activeId: number;
  /** the protocol fee counters, UI units of token X and token Y */
  feeX: number;
  feeY: number;
}

export interface AccountPoolMeta extends PoolMeta {
  binStep: number;
  /** the protocol's share of every swap fee, percent (parameters.protocol_share / 100) */
  protocolSharePct: number;
  /** the pool's base fee, percent of the trade; null when the parameters do not give it */
  baseFeePct: number | null;
}

export interface DecodedLbPair {
  activeId: number;
  binStep: number;
  tokenXMint: string;
  tokenYMint: string;
  /** raw counters, smallest units */
  protocolFeeX: bigint;
  protocolFeeY: bigint;
  protocolSharePct: number;
  baseFeePct: number | null;
}

let coder: BorshCoder | null = null;
const accountCoder = () => (coder ??= new BorshCoder(IDL as never));

/** The pool account through the SDK's IDL. Throws when the data is not an LbPair. */
export function decodeLbPair(data: Buffer): DecodedLbPair {
  let d: Record<string, unknown> | null = null;
  for (const name of ["LbPair", "lbPair"]) {
    try {
      d = accountCoder().accounts.decode(name, data) as Record<string, unknown>;
      break;
    } catch {
      /* the IDL names it one way or the other */
    }
  }
  if (!d) throw new Error("not an LbPair account");
  const pick = <T>(...keys: string[]): T => {
    for (const k of keys) if (d![k] !== undefined) return d![k] as T;
    throw new Error(`LbPair field missing: ${keys[0]}`);
  };
  const params = pick<Record<string, unknown>>("parameters");
  const fee = pick<Record<string, { toString(): string }>>("protocol_fee", "protocolFee");
  const n = (v: unknown): number => Number(v);
  const binStep = n(pick("bin_step", "binStep"));
  const baseFactor = n(params.base_factor ?? params.baseFactor);
  const power = n(params.base_fee_power_factor ?? params.baseFeePowerFactor ?? 0);
  return {
    activeId: n(pick("active_id", "activeId")),
    binStep,
    tokenXMint: String(pick("token_x_mint", "tokenXMint")),
    tokenYMint: String(pick("token_y_mint", "tokenYMint")),
    protocolFeeX: BigInt((fee.amount_x ?? fee.amountX).toString()),
    protocolFeeY: BigInt((fee.amount_y ?? fee.amountY).toString()),
    protocolSharePct: n(params.protocol_share ?? params.protocolShare) / 100,
    baseFeePct: Number.isFinite(baseFactor) && baseFactor > 0 ? (baseFactor * binStep * Math.pow(10, Number.isFinite(power) ? power : 0)) / 1e6 : null,
  };
}

/** PURE. Token Y per token X at a bin, UI units. */
export const priceOfBin = (binId: number, binStep: number, xDecimals: number, yDecimals: number): number => Math.pow(1 + binStep / 10_000, binId) * Math.pow(10, xDecimals - yDecimals);

/** PURE. The base token in quote units at a bin: Y per X when the quote is Y, its inverse when the quote is X. */
export const basePriceInQuote = (meta: Pick<AccountPoolMeta, "quoteSide" | "binStep" | "xDecimals" | "yDecimals">, binId: number): number => {
  const p = priceOfBin(binId, meta.binStep, meta.xDecimals, meta.yDecimals);
  return meta.quoteSide === "Y" ? p : p > 0 ? 1 / p : 0;
};

/** PURE. A sample from a decoded account. */
export const sampleOf = (d: DecodedLbPair, ts: number, xDecimals: number, yDecimals: number): AccountSample => ({
  ts,
  activeId: d.activeId,
  feeX: Number(d.protocolFeeX) / Math.pow(10, xDecimals),
  feeY: Number(d.protocolFeeY) / Math.pow(10, yDecimals),
});

const emptyWindow = (): WindowStats => ({ swaps: 0, buys: 0, sells: 0, volumeQuote: 0, feesQuote: 0, ours: { swaps: 0, volumeQuote: 0, feesQuote: 0 }, largest: null, binLow: null, binHigh: null });

/**
 * PURE. A window's numbers from the samples inside it. Each pair of consecutive samples is one interval:
 * the counters' growth over the protocol's share is the fee the pool's swaps paid in it, the LP's part is
 * the rest; a counter that fell (the protocol withdrew its fees) is an interval with nothing to read.
 */
export function windowFromSamples(meta: AccountPoolMeta, samples: readonly AccountSample[], now: number, windowMs: number): WindowStats {
  const w = emptyWindow();
  const since = now - windowMs;
  const share = meta.protocolSharePct / 100;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.ts < since || s.ts > now) continue;
    const prev = i > 0 ? samples[i - 1] : null;
    // the travel starts from where the price stood when the window opened: the last sample before it
    for (const id of prev && prev.ts < since ? [prev.activeId, s.activeId] : [s.activeId]) {
      if (w.binLow === null || id < w.binLow) w.binLow = id;
      if (w.binHigh === null || id > w.binHigh) w.binHigh = id;
    }
    if (!prev || !(share > 0)) continue;
    const dX = s.feeX - prev.feeX;
    const dY = s.feeY - prev.feeY;
    if (dX < 0 || dY < 0 || (dX === 0 && dY === 0)) continue;
    const px = basePriceInQuote(meta, s.activeId);
    // the counters in quote units: the quote's own counter as it is, the base's at the bin's price
    const quoteCounter = meta.quoteSide === "Y" ? dY : dX;
    const baseCounter = meta.quoteSide === "Y" ? dX : dY;
    const protocolQuote = quoteCounter + baseCounter * px;
    const totalFee = protocolQuote / share;
    const lpFee = totalFee * (1 - share);
    const volume = meta.baseFeePct && meta.baseFeePct > 0 ? totalFee / (meta.baseFeePct / 100) : 0;
    w.swaps += 1;
    if (quoteCounter > 0) w.buys += 1; // the fee is taken from what comes in: quote in is a buy of the base
    if (baseCounter > 0) w.sells += 1;
    w.feesQuote += lpFee;
    w.volumeQuote += volume;
    // the interval's trades walked the price from the last sample's bin to this one's: our part is the share of those bins inside our band
    const ours = binShare(prev.activeId, s.activeId, meta.band);
    if (ours > 0) {
      w.ours.swaps += 1;
      w.ours.feesQuote += lpFee * ours;
      w.ours.volumeQuote += volume * ours;
    }
    if (!w.largest || volume > w.largest.volumeQuote) w.largest = { volumeQuote: volume, sig: "", ts: s.ts, dir: quoteCounter >= baseCounter * px ? "buy" : "sell" };
  }
  return w;
}

const WINDOWS: [WindowKey, number][] = [["1m", 60_000], ["5m", 5 * 60_000], ["15m", 15 * 60_000], ["60m", 60 * 60_000], ["240m", LONGEST_WINDOW_MS]];

/** PURE. The pool's flow file entry from its samples: the same shape the transaction scout wrote. */
export function flowPoolFromSamples(meta: AccountPoolMeta, samples: readonly AccountSample[], now: number): FlowPool {
  const windows = Object.fromEntries(WINDOWS.map(([k, ms]) => [k, windowFromSamples(meta, samples, now, ms)])) as Record<WindowKey, WindowStats>;
  const last = samples.length ? samples[samples.length - 1] : null;
  let lastSwapAt: number | null = null;
  for (let i = samples.length - 1; i > 0; i--) {
    if (samples[i].feeX > samples[i - 1].feeX || samples[i].feeY > samples[i - 1].feeY) {
      lastSwapAt = samples[i].ts;
      break;
    }
  }
  const watchedSince = samples.length ? samples[0].ts : null;
  const coveredMs = watchedSince === null ? null : Math.max(0, Math.min(LONGEST_WINDOW_MS, now - watchedSince));
  return {
    address: meta.address,
    label: meta.label,
    quoteSide: meta.quoteSide,
    quoteSymbol: meta.quoteSymbol,
    xDecimals: meta.xDecimals,
    yDecimals: meta.yDecimals,
    band: meta.band,
    asOf: now,
    lastSwapAt,
    lastPrice: last ? basePriceInQuote(meta, last.activeId) : null,
    lastBinId: last ? last.activeId : null,
    windows,
    watchedSince,
    feesPerDayQuote240m: coveredMs !== null && coveredMs >= 60 * 60_000 ? (windows["240m"].feesQuote / coveredMs) * 86_400_000 : null,
    feesPerDayQuote60m: windows["60m"].swaps >= 3 ? windows["60m"].feesQuote * 24 : null,
    feesPerDayQuote15m: windows["15m"].swaps >= 3 ? windows["15m"].feesQuote * 96 : null,
  };
}

/** PURE. Keep the longest window plus a minute; thin what is older than `fullMs` to one sample per `everyMs` (the last of each bucket). */
export function trimSamples(samples: readonly AccountSample[], now: number, fullMs = 20 * 60_000, everyMs = 30_000): AccountSample[] {
  const kept: AccountSample[] = [];
  let bucket = -1;
  for (const s of samples) {
    if (now - s.ts > LONGEST_WINDOW_MS + 60_000) continue;
    if (now - s.ts <= fullMs) {
      kept.push(s);
      continue;
    }
    const b = Math.floor(s.ts / everyMs);
    if (b === bucket) kept[kept.length - 1] = s;
    else {
      kept.push(s);
      bucket = b;
    }
  }
  return kept;
}
