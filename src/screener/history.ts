/**
 * Rolling 24h of per-pool on-chain samples (protocol fee counters, active bin) so fees and
 * realised bin range come from chain deltas rather than reported volume.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import type { OnchainPool } from "./types";

interface Sample {
  t: number;
  fb: string;
  fq: string;
  bin: number;
  price: number;
}
type History = Record<string, Sample[]>;

const FILE = () => path.resolve(process.cwd(), config.dataDir, "screen-history.json");
const WINDOW_MS = 24 * 3600e3;

export function loadHistory(): History {
  try {
    return JSON.parse(fs.readFileSync(FILE(), "utf8")) as History;
  } catch {
    return {};
  }
}

export function recordSamples(h: History, pools: OnchainPool[], now = Date.now()): void {
  const keep = new Set(pools.map((p) => p.address));
  for (const k of Object.keys(h)) if (!keep.has(k)) delete h[k];
  for (const p of pools) {
    const arr = (h[p.address] ??= []);
    arr.push({ t: now, fb: p.protocolFeeBase, fq: p.protocolFeeQuote, bin: p.activeBinId, price: p.price });
    while (arr.length && arr[0].t < now - WINDOW_MS) arr.shift();
  }
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(h));
}

export interface OnchainWindow {
  hours: number;
  /** total swap fees over the window in quote units, from protocol fee deltas / protocol share */
  feesQuote: number;
  binRangePct: number;
}

/** Sum positive deltas so a protocol fee withdrawal (counter reset) does not show as negative fees. */
export function windowStats(h: History, p: OnchainPool): OnchainWindow | null {
  const arr = h[p.address];
  if (!arr || arr.length < 2 || p.protocolSharePct <= 0) return null;
  let dBase = 0n;
  let dQuote = 0n;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    lo = Math.min(lo, arr[i].bin);
    hi = Math.max(hi, arr[i].bin);
    if (i === 0) continue;
    const db = BigInt(arr[i].fb) - BigInt(arr[i - 1].fb);
    const dq = BigInt(arr[i].fq) - BigInt(arr[i - 1].fq);
    if (db > 0n) dBase += db;
    if (dq > 0n) dQuote += dq;
  }
  const hours = (arr[arr.length - 1].t - arr[0].t) / 3600e3;
  if (hours <= 0) return null;
  const protocolQuote = Number(dQuote) / 10 ** p.quoteDecimals + (Number(dBase) / 10 ** p.baseDecimals) * p.price;
  return { hours, feesQuote: protocolQuote / (p.protocolSharePct / 100), binRangePct: (hi - lo) * (p.binStep / 100) };
}
