import { useEffect, useRef, useState } from "react";

// STALE-WHILE-REVALIDATE, the whole reason tab switches feel slow.
//
// Every data-backed tab used the same shape: useState(null), fetch on mount,
// render null until it resolved. And tabs mount conditionally, so leaving a tab
// unmounts it and returning re-runs the effect from null. Result: every click
// was a blank screen plus a fresh round trip, even to a tab you saw ten seconds
// ago.
//
// This module-level cache outlives any unmount. A hook seeds its first render
// from the cache (instant, if the tab was ever visited) and refetches in the
// background to freshen it. First visit still fetches, but it is the only visit
// that ever shows a blank, and even that gets a skeleton at the call site.
//
// Deliberately tiny: no library, no context, no invalidation graph. A Map and a
// timestamp. The existing per-hook polling intervals stay exactly as they were;
// this only changes what the FIRST render of a remounted hook has to show.

const store = new Map<string, { value: unknown; at: number }>();

export function readCache<T>(key: string): T | undefined {
  return store.get(key)?.value as T | undefined;
}

export function writeCache<T>(key: string, value: T): void {
  store.set(key, { value, at: Date.now() });
}

export interface Resource<T> {
  /** Last known value: cached instantly on a revisit, null only on a true
   *  first load that has never resolved anywhere. */
  data: T | null;
  /** True only while a first-ever load for this key is in flight, i.e. there is
   *  nothing cached to show yet. A background refresh does NOT set this, so a
   *  revisit never flips back to a loading state. */
  loading: boolean;
  /** The most recent fetch rejected AND there is nothing cached to fall back
   *  on. A failure with a cached value keeps showing the cached value. */
  error: boolean;
}

/**
 * Fetch `key` through `fetcher`, seeding from the module cache so a remount is
 * instant. Optionally re-runs every `intervalMs`. The fetcher owns its own URL
 * and parsing; this owns only the cache and the loading/error bookkeeping.
 */
export function useResource<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
  intervalMs?: number,
): Resource<T> {
  const cached = key ? readCache<T>(key) : undefined;
  const [data, setData] = useState<T | null>(cached ?? null);
  const [loading, setLoading] = useState<boolean>(cached === undefined);
  const [error, setError] = useState<boolean>(false);
  // Hold the fetcher in a ref so a caller passing an inline function does not
  // restart the interval on every render; only `key` and `intervalMs` do.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!key) {
      setLoading(false);
      return;
    }
    const seeded = readCache<T>(key);
    if (seeded !== undefined) {
      setData(seeded);
      setLoading(false);
    } else {
      setLoading(true);
    }
    let cancelled = false;
    const ac = new AbortController();
    const run = async () => {
      try {
        const v = await fetcherRef.current(ac.signal);
        if (cancelled) return;
        writeCache(key, v);
        setData(v);
        setError(false);
      } catch {
        if (cancelled) return;
        // Keep any cached value on screen; only surface error when bare.
        setError(readCache<T>(key) === undefined);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    const id = intervalMs ? window.setInterval(run, intervalMs) : undefined;
    return () => {
      cancelled = true;
      ac.abort();
      if (id) window.clearInterval(id);
    };
  }, [key, intervalMs]);

  return { data, loading, error };
}
