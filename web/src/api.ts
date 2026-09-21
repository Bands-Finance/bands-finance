import type { EquityHistoryPoint, HotFile, JournalEntry, RiskLimits, ScreenResult } from "./types";

declare global {
  interface Window {
    __BANDS_DATA__?: { entries: JournalEntry[]; limits?: RiskLimits; screen?: ScreenResult | null; equity?: EquityHistoryPoint[]; demo?: boolean };
  }
}

const env = import.meta.env as Record<string, string | undefined>;
const base = env.VITE_API_URL?.trim().replace(/\/$/, "") ?? "";
/** Where the API lives: VITE_API_URL without its trailing slash, or "" for same-origin. */
export const API_BASE = base;

/**
 * Journal sources, in order. The first one that answers is remembered.
 *   1. VITE_JOURNAL_URL      a JSON file anywhere (a blob store the agent writes to)
 *   2. /api/journal          the agent's own server (src/server.ts)
 *   3. /journal.json         a static snapshot bundled with the site (Vercel)
 */
let journalSource: string | null = null;
let limitsSource: string | null = null;

export const isEmbedded = () => Boolean(window.__BANDS_DATA__?.entries);

async function fetchJson(url: string, cache: RequestCache = "no-store"): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" }, cache });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/**
 * THE LIVE FEED (VITE_LIVE_URL): one JSON file the desk uploads after every cycle (src/publish/live.ts):
 * the journal's newest entries, the equity history, the limits and the SOL price. It comes before every
 * other source, so the page shows the desk's last cycle, not the last rebuild. One request serves all
 * the loaders of a poll (kept for five seconds), revalidated with the CDN each time ("no-cache": a 304
 * when nothing changed). A feed that does not answer, or is more than two hours old while another
 * source is newer, falls through to the sources below.
 */
export interface LiveFeed {
  generatedAt: string;
  cycle: number | null;
  mode: string | null;
  entries: JournalEntry[];
  points: EquityHistoryPoint[];
  limits: RiskLimits;
  solPriceUsd: number | null;
}
/**
 * Where the desk uploads the feed (src/publish/live.ts, ops/live.env LIVE_FEED_URL). The blob is public
 * and holds nothing secret, and the desk's own auto-deploys do not bake VITE_LIVE_URL, so a build made
 * without it reads this one rather than nothing; VITE_LIVE_URL still wins when it is set.
 */
const DEFAULT_LIVE_URL = "https://j8hghfydpxfm7hfb.public.blob.vercel-storage.com/live.json";
const LIVE_URL = env.VITE_LIVE_URL?.trim() || DEFAULT_LIVE_URL;
let liveAt = 0;
let livePending: Promise<LiveFeed | null> | null = null;
export function loadLiveFeed(): Promise<LiveFeed | null> {
  if (!LIVE_URL || window.__BANDS_DATA__?.entries) return Promise.resolve(null);
  const now = Date.now();
  if (livePending && now - liveAt < 5_000) return livePending;
  liveAt = now;
  livePending = fetchJson(LIVE_URL, "no-cache")
    .then((j) => {
      const f = j as LiveFeed;
      return f && Array.isArray(f.entries) && typeof f.generatedAt === "string" ? f : null;
    })
    .catch(() => null);
  return livePending;
}

/** Where the data on the page came from and when it was written: for the page's "updated" word. */
export interface DataStamp {
  source: "live" | "api" | "snapshot" | "embedded";
  generatedAt: number | null;
}
let stamp: DataStamp = { source: "snapshot", generatedAt: null };
export const dataStamp = (): DataStamp => stamp;
const LIVE_MAX_AGE_MS = 2 * 3_600_000;

export async function loadJournal(limit = 600): Promise<JournalEntry[]> {
  if (window.__BANDS_DATA__?.entries) {
    stamp = { source: "embedded", generatedAt: null };
    return window.__BANDS_DATA__.entries;
  }
  const live = await loadLiveFeed();
  if (live && Date.now() - Date.parse(live.generatedAt) < LIVE_MAX_AGE_MS) {
    stamp = { source: "live", generatedAt: Date.parse(live.generatedAt) };
    return live.entries;
  }
  const candidates = journalSource ? [journalSource] : [env.VITE_JOURNAL_URL, `${base}/api/journal?limit=${limit}`, `${base}/journal.json`].filter((u): u is string => Boolean(u));
  let lastErr: Error | null = null;
  for (const url of candidates) {
    try {
      const json = (await fetchJson(url)) as { entries?: JournalEntry[]; generatedAt?: string } | JournalEntry[];
      const entries = Array.isArray(json) ? json : json.entries;
      if (!Array.isArray(entries)) throw new Error(`${url}: no entries`);
      journalSource = url;
      const at = !Array.isArray(json) && json.generatedAt ? Date.parse(json.generatedAt) : NaN;
      // a live feed that is old but still newer than this source wins (the desk may be down; the rebuilds stop with it)
      if (live && Number.isFinite(at) && Date.parse(live.generatedAt) > at) {
        stamp = { source: "live", generatedAt: Date.parse(live.generatedAt) };
        return live.entries;
      }
      stamp = { source: url.includes("/api/") ? "api" : "snapshot", generatedAt: Number.isFinite(at) ? at : null };
      return entries;
    } catch (err) {
      lastErr = err as Error;
    }
  }
  throw lastErr ?? new Error("journal unavailable");
}

export async function loadLimits(): Promise<RiskLimits | null> {
  if (window.__BANDS_DATA__?.limits) return window.__BANDS_DATA__.limits;
  const live = await loadLiveFeed();
  // a stale feed's limits are the stopped desk's: only a fresh feed speaks for the page (loadJournal's rule)
  if (live?.limits && typeof live.limits.maxPositionSol === "number" && Date.now() - Date.parse(live.generatedAt) < LIVE_MAX_AGE_MS) return live.limits;
  const candidates = limitsSource ? [limitsSource] : [env.VITE_LIMITS_URL, `${base}/api/limits`, `${base}/limits.json`].filter((u): u is string => Boolean(u));
  for (const url of candidates) {
    try {
      const json = (await fetchJson(url)) as RiskLimits;
      if (json && typeof json.maxPositionSol === "number") {
        limitsSource = url;
        return json;
      }
    } catch {
      /* try the next source */
    }
  }
  return null;
}

/**
 * The equity history: one point a cycle since the run began, the desk's own marks. Null when the
 * host has none (an older snapshot, a demo): the page then reads the money from the journal window.
 */
let equitySource: string | null = null;
export async function loadEquity(): Promise<EquityHistoryPoint[] | null> {
  if (window.__BANDS_DATA__?.entries) return window.__BANDS_DATA__.equity ?? null;
  const live = await loadLiveFeed();
  if (live && Array.isArray(live.points) && stamp.source === "live") return live.points.filter((p) => p && typeof p.t === "number" && typeof p.equitySol === "number" && Number.isFinite(p.equitySol));
  const candidates = equitySource ? [equitySource] : [env.VITE_EQUITY_URL, `${base}/api/equity`, `${base}/equity.json`].filter((u): u is string => Boolean(u));
  for (const url of candidates) {
    try {
      const json = (await fetchJson(url)) as { points?: EquityHistoryPoint[] };
      if (json && Array.isArray(json.points)) {
        equitySource = url;
        return json.points.filter((p) => p && typeof p.t === "number" && typeof p.equitySol === "number" && Number.isFinite(p.equitySol));
      }
    } catch {
      /* try the next source */
    }
  }
  return null;
}

/** True when every entry came from the demo seeder, so the page can say so. */
export const isDemoJournal = (entries: JournalEntry[]) => entries.length > 0 && entries.every((e) => e.id.startsWith("demo-"));

let screenSource: string | null = null;
export async function loadScreen(): Promise<ScreenResult | null> {
  if (window.__BANDS_DATA__?.entries) return window.__BANDS_DATA__.screen ?? null;
  const candidates = screenSource ? [screenSource] : [env.VITE_SCREEN_URL, `${base}/api/screen`, `${base}/screen.json`].filter((u): u is string => Boolean(u));
  for (const url of candidates) {
    try {
      const json = (await fetchJson(url)) as ScreenResult;
      if (json && Array.isArray(json.pools)) {
        screenSource = url;
        return json;
      }
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * The hot watch, same source order as the screen: VITE_HOT_URL, then /api/hot, then the static
 * /hot.json snapshot. Not embedded in __BANDS_DATA__: it changes every two minutes.
 */
let hotSource: string | null = null;
export async function loadHot(): Promise<HotFile | null> {
  const candidates = hotSource ? [hotSource] : [env.VITE_HOT_URL, `${base}/api/hot`, `${base}/hot.json`].filter((u): u is string => Boolean(u));
  for (const url of candidates) {
    try {
      const json = (await fetchJson(url)) as HotFile;
      if (json && Array.isArray(json.rows)) {
        hotSource = url;
        return json;
      }
    } catch {
      /* next */
    }
  }
  return null;
}
