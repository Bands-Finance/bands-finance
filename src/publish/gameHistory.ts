/**
 * THE STALLS' HISTORY (bands.finance Play): web/public/history.json, the hourly history of the pools the Exchange's
 * stalls deal from, written at each site publish so the room server (game-server/, a Cloudflare Worker) can replay
 * real hours. The Worker cannot read GeckoTerminal itself: GeckoTerminal answers Cloudflare's shared addresses with
 * 429 from the first call (24 Sep). This machine reads it instead, a read every GAP_MS, and the
 * file rides out with the site.
 *
 *   { generatedAt, pools: { [address]: { at, price: [[unix s, close in the quote]...], volume: [[unix s, USD]...] } } }
 *
 * Each pool is two reads (prices in the quote, volume in USD: the quote-priced read counts volume in the quote). A pool
 * read within REFRESH_MS is kept as it is; a failed read keeps the last good one for KEEP_MS. Pools that left the board
 * stay KEEP_MS too, since the room reads its board and this file at different moments. The whole pass stops at
 * BUDGET_MS, leaving what it did not reach as it was (the board's first pools come first, so the stalls fill first,
 * and the next publish, half an hour on, carries on). It never throws: a publish must not fail on a game.
 */
import fs from "node:fs";
import path from "node:path";

/** the pools taken from hot.json: the room deals from its first 12 usable rows; a margin for a board that moved */
export const HISTORY_POOLS = 14;
/** a pool read this recently is not read again (candles are hourly) */
export const REFRESH_MS = 55 * 60_000;
/** a pool's last good read is kept this long when a read fails or it leaves the board */
export const KEEP_MS = 6 * 3_600_000;
/** the gap between reads (GeckoTerminal's keyless limit; at 2.2 s it answered 429 within a pass, 24 Sep) */
export const GAP_MS = 4_000;
/** after a 429, wait this long and try once more */
export const BACKOFF_MS = 15_000;
/** the whole pass stops here (the publish runs beside the desk, never in its way; about 7 pools a pass) */
export const BUDGET_MS = 150_000;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface PoolHistory {
  /** when it was read, ms */
  at: number;
  price: [number, number][];
  volume: [number, number][];
}
export interface HistoryFile {
  generatedAt: string;
  pools: Record<string, PoolHistory>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** the board rows the room can deal from, in its order: an address, a name, a fee rate and a fee tier */
export function historyPools(hot: unknown, limit = HISTORY_POOLS): { address: string; baseMint: string | null }[] {
  const rows = (hot as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) return [];
  const out: { address: string; baseMint: string | null }[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (out.length >= limit) break;
    if (!r || typeof r !== "object") continue;
    const address = typeof r.address === "string" ? r.address.trim() : "";
    if (!BASE58.test(address) || typeof r.name !== "string" || !r.name.trim()) continue;
    if (!finite(r.feeToTvl1hPct) || !finite(r.feePct) || r.feePct <= 0) continue;
    const mint = typeof r.baseMint === "string" && BASE58.test(r.baseMint.trim()) ? r.baseMint.trim() : null;
    if (!out.some((p) => p.address === address)) out.push({ address, baseMint: mint });
  }
  return out;
}

export const historyUrls = (address: string, baseMint: string | null) => {
  const at = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${address}/ohlcv/hour?aggregate=1&limit=200&token=${baseMint ?? "base"}`;
  return { price: `${at}&currency=token`, volume: `${at}&currency=usd` };
};

/** GeckoTerminal's answer -> [unix s, column] pairs (column 4 = close, 5 = volume), oldest first, sensible rows only */
export function pairsOf(body: unknown, column: 4 | 5, sig: number): [number, number][] {
  const list = (body as { data?: { attributes?: { ohlcv_list?: unknown } } } | null)?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  const out: [number, number][] = [];
  for (const c of list) {
    if (!Array.isArray(c) || !Number.isInteger(c[0]) || c[0] % 3600 !== 0 || !finite(c[column])) continue;
    const v = c[column] as number;
    if (column === 4 ? v <= 0 : v < 0) continue;
    out.push([c[0], column === 4 ? Number(v.toPrecision(sig)) : Math.round(v * 100) / 100]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** read the pools' histories into the file, keeping what is fresh and what could not be read; never throws */
export async function refreshHistory(o: {
  hot: unknown;
  previous: HistoryFile | null;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}): Promise<{ file: HistoryFile; read: number; kept: number; failed: number; skipped: number }> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const doFetch: FetchLike = o.fetch ?? ((u, init) => fetch(u, init));
  const start = now();
  const prev = o.previous?.pools ?? {};
  const pools: Record<string, PoolHistory> = {};
  let read = 0;
  let kept = 0;
  let failed = 0;
  let skipped = 0;
  let calls = 0;

  const get = async (url: string): Promise<unknown | null> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (calls++ > 0) await sleep(GAP_MS);
      try {
        const res = await doFetch(url, { headers: { accept: "application/json", "user-agent": "bands-exchange-history/1" }, signal: AbortSignal.timeout(10_000) });
        if (res.status === 429 && attempt === 0) {
          await sleep(BACKOFF_MS);
          continue;
        }
        return res.ok ? await res.json() : null;
      } catch {
        return null;
      }
    }
    return null;
  };

  for (const p of historyPools(o.hot)) {
    const old = prev[p.address];
    if (old && now() - old.at < REFRESH_MS) {
      pools[p.address] = old;
      kept++;
      continue;
    }
    if (now() - start > BUDGET_MS) {
      if (old && now() - old.at < KEEP_MS) pools[p.address] = old;
      skipped++;
      continue;
    }
    const urls = historyUrls(p.address, p.baseMint);
    const priceBody = await get(urls.price);
    const volumeBody = priceBody ? await get(urls.volume) : null;
    const price = pairsOf(priceBody, 4, 7);
    const volume = pairsOf(volumeBody, 5, 0);
    if (price.length && volume.length) {
      pools[p.address] = { at: now(), price, volume };
      read++;
    } else {
      failed++;
      if (old && now() - old.at < KEEP_MS) pools[p.address] = old;
    }
  }
  // pools that left the board: kept a while, for a room whose board is older than this file
  for (const [address, h] of Object.entries(prev)) if (!pools[address] && now() - h.at < KEEP_MS) pools[address] = h;
  o.log?.(`history: ${read} read, ${kept} fresh kept, ${failed} failed, ${skipped} past the budget; ${Object.keys(pools).length} pools in the file`);
  return { file: { generatedAt: new Date(now()).toISOString(), pools }, read, kept, failed, skipped };
}

/** the file on disk, or null */
export function loadHistoryFile(file: string): HistoryFile | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as HistoryFile;
    return j && typeof j === "object" && j.pools && typeof j.pools === "object" ? j : null;
  } catch {
    return null;
  }
}

export function writeHistoryFile(file: string, h: HistoryFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(h));
  fs.renameSync(tmp, file);
}
