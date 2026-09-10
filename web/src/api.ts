import type { JournalEntry, RiskLimits } from "./types";

declare global {
  interface Window {
    __BANDS_DATA__?: { entries: JournalEntry[]; limits?: RiskLimits; demo?: boolean };
  }
}

const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";

export const isEmbedded = () => Boolean(window.__BANDS_DATA__?.entries);

export async function loadJournal(limit = 600): Promise<JournalEntry[]> {
  if (window.__BANDS_DATA__?.entries) return window.__BANDS_DATA__.entries;
  const res = await fetch(`${base}/api/journal?limit=${limit}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`journal: HTTP ${res.status}`);
  const json = (await res.json()) as { entries: JournalEntry[] };
  return json.entries;
}

export async function loadLimits(): Promise<RiskLimits | null> {
  if (window.__BANDS_DATA__?.limits) return window.__BANDS_DATA__.limits;
  try {
    const res = await fetch(`${base}/api/limits`);
    if (!res.ok) return null;
    return (await res.json()) as RiskLimits;
  } catch {
    return null;
  }
}
