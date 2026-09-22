/**
 * THE LIVE FEED. The sites used to see new data only when a whole rebuild shipped it, at most every 30
 * minutes (Zach, 2026-09-17: "make sure the data on the website is currently being pushed correctly and in
 * real time"). The desk now uploads ONE small JSON file to a public Vercel Blob store after every cycle,
 * and the sites poll it (VITE_LIVE_URL): the journal's newest entries, the equity history, the limits and
 * the SOL price, with no build in between. One upload a cycle (about 8,600 a month, inside the Pro plan's
 * included operations); the CDN may serve a copy up to a minute old. A rebuild still ships the same data
 * as the bundled fallback the sites use when the feed does not answer.
 *
 * Needs BLOB_READ_WRITE_TOKEN (in .env, never committed). LIVE_FEED=false turns it off.
 */
import { put } from "@vercel/blob";
import { riskLimits } from "../config";
import { readEquity, readRecent } from "../journal";
import { redactCopycatDeep } from "../risk/house";
import { loadScreen } from "../screener";

export const LIVE_FEED_PATH = "live.json";

export interface LiveFeed {
  generatedAt: string;
  /** the cycle that wrote it, for the sites' "updated" word */
  cycle: number | null;
  mode: string | null;
  /** newest first, as the snapshot's journal.json */
  entries: unknown[];
  /** the desk's equity per cycle since its start */
  points: unknown[];
  limits: typeof riskLimits;
  solPriceUsd: number | null;
}

/** The feed as the desk has it on disk right now. */
/**
 * PURE. The feed carries a pool's bin ladder and its flow reading only on that pool's NEWEST entry: the
 * sites read them from there (the book, the flow totals, the platform's ladder) and nowhere else, and
 * on the 300 older entries they were half the file. Entries are newest first; everything else stays.
 */
export function trimEntries(entries: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  return entries.map((raw) => {
    const e = raw as { pool?: { address?: string; bins?: unknown }; screen?: { flow?: unknown } | null };
    const address = e?.pool?.address;
    if (typeof address !== "string") return raw;
    if (!seen.has(address)) {
      seen.add(address);
      return raw;
    }
    const out: typeof e = { ...e };
    if (e.pool && "bins" in e.pool) {
      const { bins: _bins, ...pool } = e.pool;
      out.pool = pool;
    }
    if (e.screen && typeof e.screen === "object" && "flow" in e.screen) {
      const { flow: _flow, ...screen } = e.screen;
      out.screen = screen;
    }
    return out;
  });
}

export function buildLiveFeed(o: { cycle?: number | null; entriesLimit?: number } = {}): LiveFeed {
  const entries = redactCopycatDeep(trimEntries(readRecent(o.entriesLimit ?? 300)));
  const newest = entries[0] as { mode?: string } | undefined;
  return {
    generatedAt: new Date().toISOString(),
    cycle: o.cycle ?? null,
    mode: newest?.mode ?? null,
    entries,
    points: readEquity(20_000),
    limits: riskLimits,
    solPriceUsd: loadScreen()?.solPriceUsd ?? null,
  };
}

export const liveFeedOn = (env: NodeJS.ProcessEnv = process.env): boolean => !!(env.BLOB_READ_WRITE_TOKEN ?? "").trim() && (env.LIVE_FEED ?? "").trim().toLowerCase() !== "false";

/** Upload the feed. Resolves to the public URL; throws on failure (the caller logs and moves on: the desk never waits on a website). */
export async function publishLiveFeed(feed: LiveFeed, env: NodeJS.ProcessEnv = process.env): Promise<{ url: string; bytes: number }> {
  const body = JSON.stringify(feed);
  const res = await put(LIVE_FEED_PATH, body, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    contentType: "application/json",
    token: env.BLOB_READ_WRITE_TOKEN,
  });
  return { url: res.url, bytes: Buffer.byteLength(body) };
}
