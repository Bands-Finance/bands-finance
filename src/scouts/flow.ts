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
import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { BorshCoder } from "@coral-xyz/anchor";
import { IDL, LBCLMM_PROGRAM_IDS } from "@meteora-ag/dlmm";

export const FLOW_FILE = "flow.json";
export const FLOW_EVENTS_FILE = "flow-events.jsonl";
export const WINDOWS_MIN = [1, 5, 15, 60, 240] as const;
export type WindowKey = "1m" | "5m" | "15m" | "60m" | "240m";
/** the longest window: what the scout keeps in memory */
export const LONGEST_WINDOW_MS = 240 * 60_000;

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
  /** the lowest and highest bin the window's swaps touched (start or end): the price's measured travel, in bins */
  binLow: number | null;
  binHigh: number | null;
}

export interface FlowPool extends PoolMeta {
  asOf: number;
  lastSwapAt: number | null;
  /** the last swap's price, quote per base */
  lastPrice: number | null;
  /** the bin the last swap ended in: the pool's price as a bin, five seconds fresh (the desk's fast watch reads it) */
  lastBinId?: number | null;
  windows: Record<WindowKey, WindowStats>;
  /** epoch ms the scout's reading of this pool covers from (its backfill start); null until the backfill is done */
  watchedSince: number | null;
  /**
   * LP fees a day at the last four hours' pace, over the time actually covered (null under an hour of
   * coverage). One 1.5%-fee swap in a thin pool put MRVL/SOL's hour pace from 0.08% to 1.95%/day on
   * the seat (2026-09-17); four hours dilute a print to what it is.
   */
  feesPerDayQuote240m: number | null;
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

const emptyWindow = (): WindowStats => ({ swaps: 0, buys: 0, sells: 0, volumeQuote: 0, feesQuote: 0, ours: { swaps: 0, volumeQuote: 0, feesQuote: 0 }, largest: null, binLow: null, binHigh: null });

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
    const lo = Math.min(s.startBinId, s.endBinId);
    const hi = Math.max(s.startBinId, s.endBinId);
    if (w.binLow === null || lo < w.binLow) w.binLow = lo;
    if (w.binHigh === null || hi > w.binHigh) w.binHigh = hi;
  }
  return w;
}

/** PURE. The pool's flow file entry from its recent swaps; `watchedSince` is when the scout's reading starts (null while backfilling). */
export function flowPoolOf(pool: PoolMeta, swaps: readonly FlowSwap[], now: number, watchedSince: number | null = null): FlowPool {
  const windows = {
    "1m": windowStats(swaps, now, 60_000, pool.band),
    "5m": windowStats(swaps, now, 5 * 60_000, pool.band),
    "15m": windowStats(swaps, now, 15 * 60_000, pool.band),
    "60m": windowStats(swaps, now, 60 * 60_000, pool.band),
    "240m": windowStats(swaps, now, LONGEST_WINDOW_MS, pool.band),
  };
  const last = swaps.reduce<FlowSwap | null>((a, s) => (s.ts <= now && (!a || s.ts > a.ts) ? s : a), null);
  const coveredMs = watchedSince === null ? null : Math.max(0, Math.min(LONGEST_WINDOW_MS, now - watchedSince));
  return {
    ...pool,
    asOf: now,
    lastSwapAt: last?.ts ?? null,
    lastPrice: last?.price ?? null,
    lastBinId: last?.endBinId ?? null,
    windows,
    watchedSince,
    feesPerDayQuote240m: coveredMs !== null && coveredMs >= 60 * 60_000 ? (windows["240m"].feesQuote / coveredMs) * 86_400_000 : null,
    feesPerDayQuote60m: windows["60m"].swaps >= 3 ? windows["60m"].feesQuote * 24 : null,
    feesPerDayQuote15m: windows["15m"].swaps >= 3 ? windows["15m"].feesQuote * 96 : null,
  };
}

/** PURE. Keep only the swaps still inside the longest window (plus a minute of slack). */
export const trimSwaps = (swaps: readonly FlowSwap[], now: number): FlowSwap[] => swaps.filter((s) => now - s.ts <= LONGEST_WINDOW_MS + 60_000);

/** One log line per pool, only worth printing when the last poll saw a swap. */
export function flowLine(p: FlowPool, sinceMs: number, now: number): string {
  const q = p.quoteSymbol;
  const f = (n: number, d = q === "SOL" ? 3 : 1) => n.toFixed(d);
  void sinceMs;
  const w15 = p.windows["15m"];
  const w60 = p.windows["60m"];
  const w240 = p.windows["240m"];
  const ours = p.band ? ` (${f(w15.ours.feesQuote)} through our bins)` : "";
  const covered = p.watchedSince === null ? "" : `, ${Math.round(Math.min(LONGEST_WINDOW_MS, now - p.watchedSince) / 60_000)} min covered`;
  return `[flow] ${p.label}: 15m ${w15.swaps} swaps, ${f(w15.volumeQuote)} ${q}, fees ${f(w15.feesQuote)} ${q}${ours} | 60m ${w60.swaps} swaps, ${f(w60.volumeQuote)} ${q}, fees ${f(w60.feesQuote)} ${q}${p.feesPerDayQuote60m !== null ? ` (${f(p.feesPerDayQuote60m)} ${q}/day pace)` : ""} | 4h ${w240.swaps} swaps, fees ${f(w240.feesQuote)} ${q}${p.feesPerDayQuote240m !== null ? ` (${f(p.feesPerDayQuote240m)} ${q}/day pace${covered})` : covered}${w15.largest ? ` | largest ${w15.largest.dir} ${f(w15.largest.volumeQuote)} ${q}` : ""}`;
}

/* ---------- reading the desk's view of its pools ---------- */

/** PURE. The pools to watch from the desk's latest journal entries (DATA_DIR/latest.json): every worked pool, with our band when there is one. */
export function poolsFromLatest(latest: unknown): PoolMeta[] {
  const entries = Array.isArray(latest) ? latest : latest && typeof latest === "object" ? Object.values(latest as Record<string, unknown>) : [];
  const out = new Map<string, PoolMeta>();
  const seenTs = new Map<string, number>();
  for (const e of entries as Array<Record<string, any>>) {
    const p = e?.pool;
    if (!p?.address || !p.tokenX || !p.tokenY) continue;
    // the newest entry per pool decides (the file may hold several cycles, in either order)
    const ts = typeof e.ts === "string" ? Date.parse(e.ts) : 0;
    if ((seenTs.get(p.address) ?? -1) > ts) continue;
    seenTs.set(p.address, ts);
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

/* ---------- what the desk reads ---------- */

/** The slice of a pool's flow the desk and the journal carry: fresh, small, in quote units. */
export interface FlowContext {
  asOf: number;
  quoteSymbol: string;
  swaps15m: number;
  volume15mQuote: number;
  fees15mQuote: number;
  /** fees in the bins our band covers (the whole bins' fees, not yet our share of them) */
  ours15mQuote: number;
  swaps60m: number;
  volume60mQuote: number;
  fees60mQuote: number;
  ours60mQuote: number;
  swaps240m: number;
  fees240mQuote: number;
  /** minutes the scout's reading covers, up to 240; null while it backfills */
  coveredMin: number | null;
  /** the four-hour pace over the covered time (null under an hour of coverage): the ranking's basis */
  feesPerDayQuote240m: number | null;
  /** how many bins the price travelled (highest minus lowest bin the swaps touched) in the last hour and four hours; null with no swaps */
  range60mBins: number | null;
  range240mBins: number | null;
  feesPerDayQuote60m: number | null;
  feesPerDayQuote15m: number | null;
  lastPrice: number | null;
  lastSwapAt: number | null;
  largest15m: { volumeQuote: number; dir: "buy" | "sell" } | null;
}

/** A pool's file entry as the desk's context. Pure. */
export function flowContextOf(p: FlowPool): FlowContext {
  const w15 = p.windows["15m"];
  const w60 = p.windows["60m"];
  return {
    asOf: p.asOf,
    quoteSymbol: p.quoteSymbol,
    swaps15m: w15.swaps,
    volume15mQuote: w15.volumeQuote,
    fees15mQuote: w15.feesQuote,
    ours15mQuote: w15.ours.feesQuote,
    swaps60m: w60.swaps,
    volume60mQuote: w60.volumeQuote,
    fees60mQuote: w60.feesQuote,
    ours60mQuote: w60.ours.feesQuote,
    swaps240m: p.windows["240m"]?.swaps ?? 0,
    fees240mQuote: p.windows["240m"]?.feesQuote ?? 0,
    coveredMin: p.watchedSince === null || p.watchedSince === undefined ? null : Math.round(Math.max(0, Math.min(LONGEST_WINDOW_MS, p.asOf - p.watchedSince)) / 60_000),
    feesPerDayQuote240m: p.feesPerDayQuote240m ?? null,
    range60mBins: w60.binLow !== null && w60.binLow !== undefined && w60.binHigh !== null && w60.binHigh !== undefined ? w60.binHigh - w60.binLow : null,
    range240mBins: (() => {
      const w = p.windows["240m"];
      return w && w.binLow !== null && w.binLow !== undefined && w.binHigh !== null && w.binHigh !== undefined ? w.binHigh - w.binLow : null;
    })(),
    feesPerDayQuote60m: p.feesPerDayQuote60m,
    feesPerDayQuote15m: p.feesPerDayQuote15m,
    lastPrice: p.lastPrice,
    lastSwapAt: p.lastSwapAt,
    largest15m: w15.largest ? { volumeQuote: w15.largest.volumeQuote, dir: w15.largest.dir } : null,
  };
}

export const FLOW_MAX_AGE_MS = 3 * 60_000;

/** PURE. The file's pools by address, only when the file is fresh (the scout may be down; stale flow is worse than none). */
export function flowByPool(file: FlowFile | null, now: number, maxAgeMs = FLOW_MAX_AGE_MS): Map<string, FlowContext> {
  const out = new Map<string, FlowContext>();
  if (!file || !Array.isArray(file.pools)) return out;
  const at = Date.parse(file.generatedAt);
  if (!Number.isFinite(at) || now - at > maxAgeMs) return out;
  for (const p of file.pools) out.set(p.address, flowContextOf(p));
  return out;
}

/** DATA_DIR/flow.json, or null when it is missing or unreadable. */
export function readFlowFile(dataDir: string): FlowFile | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, FLOW_FILE), "utf8")) as FlowFile;
  } catch {
    return null;
  }
}

/** One line for the cycle log. */
export function flowContextLine(f: FlowContext): string {
  const q = f.quoteSymbol;
  const d = q === "SOL" ? 3 : 1;
  const age = Math.round((Date.now() - f.asOf) / 1000);
  return `flow (${age}s old): 15m ${f.swaps15m} swaps, ${f.volume15mQuote.toFixed(d)} ${q}, fees ${f.fees15mQuote.toFixed(d + 1)} (${f.ours15mQuote.toFixed(d + 1)} in our bins) | 60m ${f.swaps60m} swaps, fees ${f.fees60mQuote.toFixed(d + 1)} ${q}${f.feesPerDayQuote60m !== null ? `, ${f.feesPerDayQuote60m.toFixed(d)} ${q}/day pace` : ", under 3 swaps"}${f.largest15m ? ` | largest ${f.largest15m.dir} ${f.largest15m.volumeQuote.toFixed(d)} ${q}` : ""}`;
}
