import { useEffect, useState } from "react";
import { dataStamp, isEmbedded, loadEquity, loadJournal, loadLimits, loadLiveFeed, loadScreen, type DataStamp } from "../api";
import type { EquityHistoryPoint, JournalEntry, RiskLimits, ScreenResult } from "../types";
import { SITE } from "../site";

// the desk writes a cycle every minute and a half or so; asking more often than this only re-reads the same feed
const POLL_MS = 45_000;

export interface JournalFeed {
  entries: JournalEntry[] | null;
  screen: ScreenResult | null;
  limits: RiskLimits | null;
  /** the desk's equity per cycle since its start; null when the host has none */
  equity: EquityHistoryPoint[] | null;
  error: string | null;
  /** a clock that ticks every 30s, for "x min ago" words */
  now: number;
  embedded: boolean;
  /** where the journal on the page came from, and when that source was written */
  stamp: DataStamp;
  /** one SOL in dollars: the live feed's, else the screener's; null until either has answered */
  solPriceUsd: number | null;
}

/**
 * The journal, the limits and the screen, polled every 20 seconds (once, when the page is embedded
 * with its data). Shared by both shells (src/App.tsx, src/DashboardApp.tsx) so they read the same feed.
 */
export function useJournalFeed(): JournalFeed {
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [screen, setScreen] = useState<ScreenResult | null>(null);
  const [limits, setLimits] = useState<RiskLimits | null>(null);
  const [equity, setEquity] = useState<EquityHistoryPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [stamp, setStamp] = useState<DataStamp>(dataStamp());
  const [solPriceUsd, setSolPriceUsd] = useState<number | null>(null);
  const embedded = isEmbedded();

  useEffect(() => {
    let alive = true;
    let last = "";
    const tick = async () => {
      // the journal first: it settles which source the page is on, and the equity follows that choice
      const j = await loadJournal().catch((e: Error) => ({ error: e }));
      // the dashboard reads nothing from the screener but the SOL price, and the live feed carries that
      const [l, s0, q, live] = await Promise.all([loadLimits(), SITE === "dashboard" ? Promise.resolve(null) : loadScreen(), loadEquity(), loadLiveFeed()]);
      if (!alive) return;
      // the feed's SOL price is a cycle old at most; the bundled screen's is as old as the last rebuild
      const s = s0 && live && typeof live.solPriceUsd === "number" && dataStamp().source === "live" ? { ...s0, solPriceUsd: live.solPriceUsd } : s0;
      setStamp(dataStamp());
      if (live && typeof live.solPriceUsd === "number") setSolPriceUsd(live.solPriceUsd);
      else if (s && typeof s.solPriceUsd === "number") setSolPriceUsd(s.solPriceUsd);
      if (Array.isArray(j)) {
        const sig = j.length ? `${j.length}:${j[0].id}` : "0";
        if (sig !== last) {
          last = sig;
          setEntries(j);
        }
        setError(null);
      } else {
        setError((j as { error: Error }).error.message);
      }
      setLimits(l);
      setScreen((prev) => (s && (s.generatedAt !== prev?.generatedAt || s.solPriceUsd !== prev?.solPriceUsd) ? s : prev ?? s));
      setEquity((prev) => (q && (q.length !== prev?.length || q[q.length - 1]?.t !== prev?.[prev.length - 1]?.t) ? q : prev ?? q));
    };
    void tick();
    const id = embedded ? undefined : window.setInterval(() => void tick(), POLL_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      alive = false;
      if (id) window.clearInterval(id);
      window.clearInterval(clock);
    };
  }, [embedded]);

  return { entries, screen, limits, equity, error, now, embedded, stamp, solPriceUsd };
}
