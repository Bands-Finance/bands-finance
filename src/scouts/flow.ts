/**
 * THE FLOW SCOUT: what is trading in his pools, right now. Zach (2026-09-17): "the chain moves
 * extremely fast and if we do not increase the speed we are accumulating data we will get smoked."
 *
 * The desk sized every seat from a 24-hour average fetched from a rate-limited API. This reads the
 * swaps themselves: every transaction that touches a pool, decoded through Meteora's own program
 * events (the SDK's IDL), which carry the exact fee, the exact bins the trade crossed, and the side.
 * From those, rolling windows (1, 5, 15, 60 minutes) per pool, and, when the desk holds a band there,
 * how much of that flow crossed OUR bins. src/scripts/flow.ts is the loop that polls the chain and
 * writes DATA_DIR/flow.json every few seconds; the desk reads that file (src/index.ts) and the
 * policy prefers it to the daily mean when it is fresh.
 *
 * Everything here is pure except decodeEvents (which needs anchor's parser); the loop injects the chain.
 */
import bs58 from "bs58";
import { BorshCoder } from "@coral-xyz/anchor";
import { IDL, LBCLMM_PROGRAM_IDS } from "@meteora-ag/dlmm";

export const FLOW_FILE = "flow.json";
export const FLOW_EVENTS_FILE = "flow-events.jsonl";
export const WINDOWS_MIN = [1, 5, 15, 60] as const;
export type WindowKey = "1m" | "5m" | "15m" | "60m";

/** What the scout needs to know about a pool to read its swaps in quote units. */
export interface PoolMeta {
  address: string;
  label: string;
  /** which side is the quote (SOL or USDC): swaps are reported in quote units */
  quoteSide: "X" | "Y";
  quoteSymbol: string;
  xDecimals: number;
  yDecimals: number;
  /** the band the desk holds there, when it holds one */
  band: { lowerBinId: number; upperBinId: number } | null;
}

/** One swap, as the program reported it, in UI units of the pool's quote and base. */
export interface FlowSwap {
  sig: string;
  slot: number;
  /** epoch ms (the block time) */
  ts: number;
  pool: string;
  from: string;
  /** "buy" takes the base token out of the pool (quote in); "sell" puts it in */
  dir: "buy" | "sell";
  volumeQuote: number;
  amountBase: number;
  /** the LP fee the swap paid, in quote units (the protocol's and host's cuts excluded) */
  feeQuote: number;
  /** quote per base, from the swap's own amounts */
  price: number;
  startBinId: number;
  endBinId: number;
  feeBps: number;
  /** the share of the bins the swap crossed that lie inside our band, 0..1; 0 when we hold none */
  ourBinShare: number;
}

export interface WindowStats {
  swaps: number;
  buys: number;
  sells: number;
  volumeQuote: number;
  feesQuote: number;
  /** flow that crossed our bins, weighted by the share of crossed bins inside the band */
  ours: { swaps: number; volumeQuote: number; feesQuote: number };
  largest: { volumeQuote: number; sig: string; ts: number; dir: "buy" | "sell" } | null;
}

export interface FlowPool extends PoolMeta {
  asOf: number;
  lastSwapAt: number | null;
  /** the last swap's price, quote per base */
  lastPrice: number | null;
  windows: Record<WindowKey, WindowStats>;
  /** LP fees a day at the last hour's pace (null under 3 swaps in the hour) and the last 15 minutes' pace, quote units */
  feesPerDayQuote60m: number | null;
  feesPerDayQuote15m: number | null;
}

export interface FlowFile {
  generatedAt: string;
  pollSec: number;
  pools: FlowPool[];
}

/* ---------- decoding ---------- */

export const DLMM_PROGRAM_ID = LBCLMM_PROGRAM_IDS["mainnet-beta"];
/** anchor's event-CPI discriminator: the first 8 bytes of a self-invocation that carries an event */
const EVENT_CPI_DISCRIMINATOR = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
let coder: BorshCoder | null = null;
const eventCoder = () => (coder ??= new BorshCoder(IDL as never));

interface RawSwapEvent {
  lbPair: string;
  from: string;
  startBinId: number;
  endBinId: number;
  swapForY: boolean;
  amountIn: bigint;
  amountOut: bigint;
  /** the LP's fee, raw units of the token it was charged in */
  lpFee: bigint;
  /** the fee's token */
  feeOnX: boolean;
  /** basis points x 1e5 in the event; here plain bps */
  feeBps: number;
}

const big = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt((v as { toString(): string }).toString()));

interface DecodedEvent {
  name: string;
  data: Record<string, unknown>;
}

/** One event body through the IDL's coder; null when it is not one of the program's events. */
function decodeOne(base64: string): DecodedEvent | null {
  try {
    const ev = eventCoder().events.decode(base64) as DecodedEvent | null;
    return ev && typeof ev.name === "string" && ev.data ? ev : null;
  } catch {
    return null;
  }
}

/**
 * Meteora's swap events from a transaction's INNER instructions. The program emits events by
 * self-CPI (anchor's emit_cpi), not as "Program data:" log lines, so a log parser finds nothing;
 * each event is a call to the program whose data is the event-CPI discriminator, the event's own
 * discriminator and the borsh body. Every swap emits both `Swap` and the richer `Swap2Evt`; one
 * FlowSwap per swap comes from the richer one when it is there. Never throws.
 */
export function decodeSwapEvents(dlmmInnerData: readonly string[]): RawSwapEvent[] {
  const v2: RawSwapEvent[] = [];
  const v1: RawSwapEvent[] = [];
  for (const b58 of dlmmInnerData) {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(bs58.decode(b58));
    } catch {
      continue;
    }
    if (bytes.length <= 16 || !bytes.subarray(0, 8).equals(EVENT_CPI_DISCRIMINATOR)) continue;
    const ev = decodeOne(bytes.subarray(8).toString("base64"));
    if (!ev) continue;
    const d = ev.data;
    try {
      if (ev.name === "Swap2Evt") {
        v2.push({
          lbPair: String(d.lb_pair),
          from: String(d.from),
          startBinId: Number(d.start_bin_id),
          endBinId: Number(d.end_bin_id),
          swapForY: Boolean(d.swap_for_y),
          amountIn: big(d.amount_in),
          amountOut: big(d.amount_out),
          lpFee: big(d.mm_fee),
          feeOnX: Boolean(d.fees_on_token_x),
          feeBps: Number(big(d.fee_bps)) / 1e5,
        });
      } else if (ev.name === "Swap") {
        const swapForY = Boolean(d.swap_for_y);
        v1.push({
          lbPair: String(d.lb_pair),
          from: String(d.from),
          startBinId: Number(d.start_bin_id),
          endBinId: Number(d.end_bin_id),
          swapForY,
          amountIn: big(d.amount_in),
          amountOut: big(d.amount_out),
          lpFee: big(d.fee) - big(d.protocol_fee) - big(d.host_fee ?? 0),
          feeOnX: swapForY, // the original event charges the input token
          feeBps: Number(big(d.fee_bps)) / 1e5,
        });
      }
    } catch {
      /* a field the coder could not read: not a swap we can count */
    }
  }
  return v2.length ? v2 : v1;
}

/** The base58 data of every inner instruction addressed to the DLMM program, from a fetched transaction. */
export function dlmmInnerData(tx: { meta: { innerInstructions?: { instructions: { programIdIndex: number; data: string }[] }[] | null } | null; keyAt: (i: number) => string | null }): string[] {
  const out: string[] = [];
  for (const g of tx.meta?.innerInstructions ?? []) for (const ix of g.instructions) if (tx.keyAt(ix.programIdIndex) === DLMM_PROGRAM_ID) out.push(ix.data);
  return out;
}

/* ---------- into quote units ---------- */

const ui = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;

/** PURE. The share of the bins a swap crossed that lie inside the band, 0..1. */
export function binShare(startBinId: number, endBinId: number, band: { lowerBinId: number; upperBinId: number } | null): number {
  if (!band) return 0;
  const lo = Math.min(startBinId, endBinId);
  const hi = Math.max(startBinId, endBinId);
  const inside = Math.min(hi, band.upperBinId) - Math.max(lo, band.lowerBinId) + 1;
  return inside <= 0 ? 0 : inside / (hi - lo + 1);
}

/** PURE. A raw event as a FlowSwap in the pool's quote units; null when the event is not this pool's or is empty. */
export function swapOf(ev: RawSwapEvent, meta: { sig: string; slot: number; ts: number }, pool: PoolMeta): FlowSwap | null {
  if (ev.lbPair !== pool.address) return null;
  if (ev.amountIn === 0n || ev.amountOut === 0n) return null;
  // swapForY: X in, Y out. The quote is X or Y; the base is the other.
  const xIn = ev.swapForY;
  const amountX = ui(xIn ? ev.amountIn : ev.amountOut, pool.xDecimals);
  const amountY = ui(xIn ? ev.amountOut : ev.amountIn, pool.yDecimals);
  const quoteIsY = pool.quoteSide === "Y";
  const volumeQuote = quoteIsY ? amountY : amountX;
  const amountBase = quoteIsY ? amountX : amountY;
  if (!(volumeQuote > 0) || !(amountBase > 0)) return null;
  const price = volumeQuote / amountBase;
  // the fee was charged in X or Y: put it in quote units at the swap's own price
  const feeUi = ui(ev.lpFee, ev.feeOnX ? pool.xDecimals : pool.yDecimals);
  const feeInQuote = ev.feeOnX === !quoteIsY; // fee token is the quote token
  const feeQuote = feeInQuote ? feeUi : ev.feeOnX ? feeUi * price : feeUi / price;
  // buy = the base leaves the pool: base is X and the swap took X out (Y in), or base is Y and Y went out
  const baseIsX = quoteIsY;
  const dir: "buy" | "sell" = baseIsX ? (xIn ? "sell" : "buy") : xIn ? "buy" : "sell";
  return {
    sig: meta.sig,
    slot: meta.slot,
    ts: meta.ts,
    pool: pool.address,
    from: ev.from,
    dir,
    volumeQuote,
    amountBase,
    feeQuote: Number.isFinite(feeQuote) ? feeQuote : 0,
    price,
    startBinId: ev.startBinId,
    endBinId: ev.endBinId,
    feeBps: ev.feeBps,
    ourBinShare: binShare(ev.startBinId, ev.endBinId, pool.band),
  };
}

/* ---------- windows ---------- */

const emptyWindow = (): WindowStats => ({ swaps: 0, buys: 0, sells: 0, volumeQuote: 0, feesQuote: 0, ours: { swaps: 0, volumeQuote: 0, feesQuote: 0 }, largest: null });

/** PURE. The window's numbers from the swaps inside it (the band's share re-read from `band`, so a band opened after the swap counts from then on). */
export function windowStats(swaps: readonly FlowSwap[], now: number, windowMs: number, band: PoolMeta["band"]): WindowStats {
  const w = emptyWindow();
  const since = now - windowMs;
  for (const s of swaps) {
    if (s.ts < since || s.ts > now) continue;
    w.swaps += 1;
    if (s.dir === "buy") w.buys += 1;
    else w.sells += 1;
    w.volumeQuote += s.volumeQuote;
    w.feesQuote += s.feeQuote;
    const share = binShare(s.startBinId, s.endBinId, band);
    if (share > 0) {
      w.ours.swaps += 1;
      w.ours.volumeQuote += s.volumeQuote * share;
      w.ours.feesQuote += s.feeQuote * share;
    }
    if (!w.largest || s.volumeQuote > w.largest.volumeQuote) w.largest = { volumeQuote: s.volumeQuote, sig: s.sig, ts: s.ts, dir: s.dir };
  }
  return w;
}

/** PURE. The pool's flow file entry from its recent swaps. */
export function flowPoolOf(pool: PoolMeta, swaps: readonly FlowSwap[], now: number): FlowPool {
  const windows = {
    "1m": windowStats(swaps, now, 60_000, pool.band),
    "5m": windowStats(swaps, now, 5 * 60_000, pool.band),
    "15m": windowStats(swaps, now, 15 * 60_000, pool.band),
    "60m": windowStats(swaps, now, 60 * 60_000, pool.band),
  };
  const last = swaps.reduce<FlowSwap | null>((a, s) => (s.ts <= now && (!a || s.ts > a.ts) ? s : a), null);
  return {
    ...pool,
    asOf: now,
    lastSwapAt: last?.ts ?? null,
    lastPrice: last?.price ?? null,
    windows,
    feesPerDayQuote60m: windows["60m"].swaps >= 3 ? windows["60m"].feesQuote * 24 : null,
    feesPerDayQuote15m: windows["15m"].swaps >= 3 ? windows["15m"].feesQuote * 96 : null,
  };
}

/** PURE. Keep only the swaps still inside the longest window (plus a minute of slack). */
export const trimSwaps = (swaps: readonly FlowSwap[], now: number): FlowSwap[] => swaps.filter((s) => now - s.ts <= 61 * 60_000);

/** One log line per pool, only worth printing when the last poll saw a swap. */
export function flowLine(p: FlowPool, sinceMs: number, now: number): string {
  const q = p.quoteSymbol;
  const f = (n: number, d = q === "SOL" ? 3 : 1) => n.toFixed(d);
  void sinceMs;
  void now;
  const w15 = p.windows["15m"];
  const w60 = p.windows["60m"];
  const ours = p.band ? ` (${f(w15.ours.feesQuote)} through our bins)` : "";
  return `[flow] ${p.label}: 15m ${w15.swaps} swaps, ${f(w15.volumeQuote)} ${q}, fees ${f(w15.feesQuote)} ${q}${ours} | 60m ${w60.swaps} swaps, ${f(w60.volumeQuote)} ${q}, fees ${f(w60.feesQuote)} ${q}${p.feesPerDayQuote60m !== null ? ` (${f(p.feesPerDayQuote60m)} ${q}/day pace)` : ""}${w15.largest ? ` | largest ${w15.largest.dir} ${f(w15.largest.volumeQuote)} ${q}` : ""}`;
}

/* ---------- reading the desk's view of its pools ---------- */

/** PURE. The pools to watch from the desk's latest journal entries (DATA_DIR/latest.json): every worked pool, with our band when there is one. */
export function poolsFromLatest(latest: unknown): PoolMeta[] {
  const entries = Array.isArray(latest) ? latest : latest && typeof latest === "object" ? Object.values(latest as Record<string, unknown>) : [];
  const out = new Map<string, PoolMeta>();
  for (const e of entries as Array<Record<string, any>>) {
    const p = e?.pool;
    if (!p?.address || !p.tokenX || !p.tokenY) continue;
    const quoteSide: "X" | "Y" = p.quoteSide ?? (p.solSide === "X" ? "X" : "Y");
    const positions: Array<{ lowerBinId: number; upperBinId: number }> = Array.isArray(e.positions) ? e.positions : [];
    const band = positions.length ? { lowerBinId: Math.min(...positions.map((x) => x.lowerBinId)), upperBinId: Math.max(...positions.map((x) => x.upperBinId)) } : null;
    out.set(p.address, {
      address: p.address,
      label: p.label ?? p.address.slice(0, 8),
      quoteSide,
      quoteSymbol: p.quoteSymbol ?? (quoteSide === "X" ? p.tokenX.symbol : p.tokenY.symbol),
      xDecimals: p.tokenX.decimals,
      yDecimals: p.tokenY.decimals,
      band,
    });
  }
  return [...out.values()];
}
