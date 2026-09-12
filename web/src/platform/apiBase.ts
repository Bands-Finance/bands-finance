/**
 * Where the platform API lives, and whether it is there at all. Ports Meridian's frontend/src/apiBase.ts.
 *
 * VITE_API_URL wins; "" means same origin (the dev proxy, or the agent's own server serving web/dist).
 * On the static Vercel snapshot there is no API behind the site, and in artifact mode there is no
 * network at all, so hasApi() is true ONLY when VITE_API_URL is set or one probe of /api/health has
 * answered {ok:true}. Every platform surface checks it and says plainly when the API is not hosted.
 */
import { useEffect, useState } from "react";
import { API_BASE, isEmbedded } from "../api";

export { API_BASE };

export const apiUrl = (path: string) => `${API_BASE}${path}`;

let known: boolean | null = API_BASE ? true : null;
let inflight: Promise<boolean> | null = null;

/** True only when VITE_API_URL is set or a probe of /api/health succeeded once. */
export function hasApi(): boolean {
  return known === true;
}

/** Probe /api/health once (or again with `force`). Never throws. */
export function probeApi(force = false): Promise<boolean> {
  if (known === true && !force) return Promise.resolve(true);
  if (known === false && !force) return Promise.resolve(false);
  if (inflight) return inflight;
  if (isEmbedded()) {
    known = false;
    return Promise.resolve(false);
  }
  inflight = (async () => {
    try {
      const res = await fetch(apiUrl("/api/health"), { headers: { accept: "application/json" }, cache: "no-store" });
      if (!res.ok) return (known = false);
      const j = (await res.json()) as { ok?: unknown };
      return (known = j?.ok === true);
    } catch {
      return (known = false);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** null while the first probe runs, then the answer. Re-probes on mount when the last answer was no. */
export function useApiAvailable(): boolean | null {
  const [state, setState] = useState<boolean | null>(known);
  useEffect(() => {
    let alive = true;
    void probeApi(known === false).then((ok) => alive && setState(ok));
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

/** JSON fetch against the API with an optional session bearer. Resolves to {status, json}; never throws on a bad body. */
export async function apiJson<T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown; token?: string | null } = {}): Promise<{ status: number; ok: boolean; json: T | null }> {
  const res = await fetch(apiUrl(path), {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: { "content-type": "application/json", accept: "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as T | null;
  return { status: res.status, ok: res.ok, json };
}
