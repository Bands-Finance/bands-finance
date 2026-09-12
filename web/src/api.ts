import type { JournalEntry, RiskLimits, ScreenResult } from "./types";

declare global {
  interface Window {
    __BANDS_DATA__?: { entries: JournalEntry[]; limits?: RiskLimits; screen?: ScreenResult | null; demo?: boolean };
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

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export async function loadJournal(limit = 600): Promise<JournalEntry[]> {
  if (window.__BANDS_DATA__?.entries) return window.__BANDS_DATA__.entries;
  const candidates = journalSource ? [journalSource] : [env.VITE_JOURNAL_URL, `${base}/api/journal?limit=${limit}`, `${base}/journal.json`].filter((u): u is string => Boolean(u));
  let lastErr: Error | null = null;
  for (const url of candidates) {
    try {
      const json = (await fetchJson(url)) as { entries?: JournalEntry[] } | JournalEntry[];
      const entries = Array.isArray(json) ? json : json.entries;
      if (!Array.isArray(entries)) throw new Error(`${url}: no entries`);
      journalSource = url;
      return entries;
    } catch (err) {
      lastErr = err as Error;
    }
  }
  throw lastErr ?? new Error("journal unavailable");
}

export async function loadLimits(): Promise<RiskLimits | null> {
  if (window.__BANDS_DATA__?.limits) return window.__BANDS_DATA__.limits;
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
