/**
 * A MONTH OF TRAINING DATA. Zach (2026-09-15), after the first paper day: "lets stick with stocks"
 * and "we can enter certain memecoin pools with a month of training data".
 *
 * So a memecoin pool is enterable only when a month of its own trading can be read back: at least
 * MEME_MIN_HISTORY_DAYS daily candles with volume, from GeckoTerminal's OHLCV for the pool. Age alone is
 * not enough: a pool can be old and dead. The same month gives the desk numbers to judge it by, which
 * the log and the reasons carry: the 30-day change, the worst drawdown from a peak, the median daily
 * range and the average daily volume.
 *
 * On the first paper day the "older" memecoins were not old. Replayed against each pool's candles:
 * EMBER 6 days, STONK 17, ZCAT 10, INDEX 3, baton 6, LOOM 21, ALLINU 5, the pump.fun pools hours. The
 * rule would have kept the desk out of every memecoin it traded that day, which lost 38.9 SOL.
 *
 * The history is read before the picker runs (src/index.ts refreshMemeHistory), a few pools a cycle,
 * cached for MEME_HISTORY_TTL_HOURS; the picker itself only reads the cache, and a pool whose history
 * has not been read yet is refused until it has. Pure except fetchPoolHistory, which takes its fetch.
 */

export interface MemeHistoryEnv {
  /** 0 turns the requirement off */
  minDays: number;
  ttlHours: number;
  /** pools read per cycle (GeckoTerminal allows about 30 calls a minute, shared with the rest of the desk) */
  lookupsPerCycle: number;
}

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function memeHistoryEnv(env: NodeJS.ProcessEnv = process.env): MemeHistoryEnv {
  return {
    minDays: Math.max(0, Math.floor(num(env.MEME_MIN_HISTORY_DAYS, 30))),
    ttlHours: Math.max(1, num(env.MEME_HISTORY_TTL_HOURS, 24)),
    lookupsPerCycle: Math.max(0, Math.floor(num(env.MEME_HISTORY_LOOKUPS, 4))),
  };
}

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
}

export interface HistoryMetrics {
  /** days with a candle that traded */
  days: number;
  /** last close over the first open of the window, percent */
  changePct: number | null;
  /** worst fall from a running peak of closes, percent (negative) */
  maxDrawdownPct: number | null;
  /** median of (high - low) / low per day, percent */
  medianDailyRangePct: number | null;
  avgDailyVolumeUsd: number | null;
}

export interface HistoryRecord {
  at: number;
  metrics: HistoryMetrics | null;
  error: string | null;
}

const n = (x: unknown): number => {
  const v = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
  return Number.isFinite(v) ? v : NaN;
};

/** PURE. GeckoTerminal's ohlcv_list ([ts, open, high, low, close, volume], newest first) as candles, oldest first. */
export function parseOhlcv(json: unknown): Candle[] {
  const list = (json as { data?: { attributes?: { ohlcv_list?: unknown } } })?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  const out: Candle[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [ts, open, high, low, close, volume] = row.map(n);
    if (![ts, open, high, low, close].every((v) => Number.isFinite(v) && v >= 0)) continue;
    out.push({ ts: ts * 1000, open, high, low, close, volumeUsd: Number.isFinite(volume) ? volume : 0 });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** PURE. The month's numbers from its candles; only days that traded count. */
export function historyMetrics(candles: readonly Candle[]): HistoryMetrics {
  const traded = candles.filter((c) => c.volumeUsd > 0 && c.close > 0 && c.open > 0);
  if (!traded.length) return { days: 0, changePct: null, maxDrawdownPct: null, medianDailyRangePct: null, avgDailyVolumeUsd: null };
  let peak = traded[0].close;
  let worst = 0;
  for (const c of traded) {
    peak = Math.max(peak, c.close);
    worst = Math.min(worst, (c.close / peak - 1) * 100);
  }
  const ranges = traded.filter((c) => c.low > 0).map((c) => ((c.high - c.low) / c.low) * 100).sort((a, b) => a - b);
  const mid = ranges.length ? (ranges.length % 2 ? ranges[(ranges.length - 1) / 2] : (ranges[ranges.length / 2 - 1] + ranges[ranges.length / 2]) / 2) : null;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    days: traded.length,
    changePct: r2((traded[traded.length - 1].close / traded[0].open - 1) * 100),
    maxDrawdownPct: r2(worst),
    medianDailyRangePct: mid === null ? null : r2(mid),
    avgDailyVolumeUsd: Math.round(traded.reduce((t, c) => t + c.volumeUsd, 0) / traded.length),
  };
}

/** The month in one phrase, for the log and the reasons. */
export const historyPhrase = (m: HistoryMetrics): string =>
  `${m.days}d of history: ${m.changePct === null ? "n/a" : `${m.changePct >= 0 ? "+" : ""}${m.changePct}%`} over the window, worst drawdown ${m.maxDrawdownPct ?? "n/a"}%, median day ${m.medianDailyRangePct ?? "n/a"}% high to low`;

/** PURE. Null when the pool has its month of data, else the reason. */
export function historyRefusal(symbol: string, rec: HistoryRecord | undefined, env: MemeHistoryEnv, now: number): string | null {
  if (env.minDays <= 0) return null;
  if (!rec) return `${symbol}: its trading history has not been read yet, and the desk wants ${env.minDays} days of it first`;
  if (rec.error && !rec.metrics) return `${symbol}: its trading history could not be read (${rec.error}), and the desk wants ${env.minDays} days of it first`;
  const m = rec.metrics!;
  if (m.days < env.minDays) return `${symbol} has ${m.days} day${m.days === 1 ? "" : "s"} of trading history, under the ${env.minDays} days the desk wants before entering a memecoin`;
  void now;
  return null;
}

/** A failed read is retried after this long (a GeckoTerminal 429 must not block a pool for a day). */
export const HISTORY_RETRY_MS = 15 * 60_000;

/** Whether a cached record is still good: a read for MEME_HISTORY_TTL_HOURS, a failed read for 15 minutes. */
export const historyFresh = (rec: HistoryRecord | undefined, env: MemeHistoryEnv, now: number): boolean =>
  !!rec && now - rec.at < (rec.metrics ? env.ttlHours * 3_600_000 : HISTORY_RETRY_MS);

export const OHLCV_URL = (pool: string, days: number): string =>
  `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/day?aggregate=1&limit=${Math.max(1, days + 1)}&currency=usd&token=base`;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** One pool's month, read and summarised. Never throws: a failure is the record's error. */
export async function fetchPoolHistory(pool: string, days: number, o: { fetch?: FetchLike; now?: number } = {}): Promise<HistoryRecord> {
  const fetchImpl: FetchLike = o.fetch ?? ((input, init) => fetch(input, init));
  const at = o.now ?? Date.now();
  try {
    const res = await fetchImpl(OHLCV_URL(pool, days), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { at, metrics: null, error: `GeckoTerminal HTTP ${res.status}` };
    return { at, metrics: historyMetrics(parseOhlcv(await res.json())), error: null };
  } catch (err) {
    return { at, metrics: null, error: (err as Error).message.slice(0, 80) };
  }
}
