/**
 * The watchlist: which tokens the desk may put money into, curated by hand.
 *
 * The screener finds pools and the policy judges them, but neither knows what the operator is
 * willing to hold. This file is that judgement, in DATA_DIR/watchlist.json, edited with
 * `npm run watchlist` or by hand. In "allow" mode the desk may only OPEN a band in a pool whose
 * base token is on the list; in "off" mode the list only denies. Pools already holding a band are
 * always managed and always exitable: a watchlist never traps money.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import type { ScreenedPool } from "./types";

export const WATCHLIST_FILE = "watchlist.json";

export interface WatchToken {
  /** the base token's symbol as the screener spells it, e.g. "SPYx" */
  symbol: string;
  /** the mint, when known: a symbol can be squatted, a mint cannot */
  mint?: string;
  note?: string;
  addedAt: string;
}

export interface Watchlist {
  /** "allow": only listed tokens may be entered. "off": the list only denies. */
  mode: "allow" | "off";
  tokens: WatchToken[];
  /** symbols or mints the desk must never enter, whatever the mode */
  deny: string[];
  /** pool addresses the desk must never enter */
  denyPools: string[];
  updatedAt: string;
}

export const emptyWatchlist = (): Watchlist => ({ mode: "off", tokens: [], deny: [], denyPools: [], updatedAt: new Date().toISOString() });

export const watchlistPath = (dir: string = config.dataDir) => path.resolve(process.cwd(), dir, WATCHLIST_FILE);

export function loadWatchlist(file: string = watchlistPath()): Watchlist {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Watchlist>;
    return {
      mode: raw.mode === "allow" ? "allow" : "off",
      tokens: Array.isArray(raw.tokens) ? raw.tokens.filter((t): t is WatchToken => !!t && typeof t.symbol === "string") : [],
      deny: Array.isArray(raw.deny) ? raw.deny.filter((d): d is string => typeof d === "string") : [],
      denyPools: Array.isArray(raw.denyPools) ? raw.denyPools.filter((d): d is string => typeof d === "string") : [],
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    };
  } catch {
    return emptyWatchlist();
  }
}

export function saveWatchlist(w: Watchlist, file: string = watchlistPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...w, updatedAt: new Date().toISOString() }, null, 2));
}

const norm = (s: string) => s.trim().toLowerCase();

/** PURE. Why this pool may not be entered, or null when it may. Case-insensitive on symbols; exact on mints. */
export function watchlistRefusal(pool: Pick<ScreenedPool, "address" | "baseSymbol" | "baseMint" | "name">, w: Watchlist): string | null {
  if (w.denyPools.some((p) => p === pool.address)) return `pool ${pool.address.slice(0, 6)} is on the watchlist's denied pools`;
  const sym = norm(pool.baseSymbol ?? "");
  const mint = pool.baseMint ?? "";
  for (const d of w.deny) {
    if (norm(d) === sym || d === mint) return `${pool.baseSymbol} is denied on the watchlist`;
  }
  if (w.mode !== "allow") return null;
  const listed = w.tokens.some((t) => (t.mint ? t.mint === mint : false) || norm(t.symbol) === sym);
  if (!listed) return `${pool.baseSymbol || pool.name} is not on the watchlist (mode allow: ${w.tokens.length} token(s) listed)`;
  return null;
}

/**
 * PURE. Why this pool is DENIED outright, ignoring allow mode: a deny entry on the token, or the
 * pool on denyPools. Null when nothing denies it.
 *
 * This is what the launch lane checks (src/index.ts). A launch pool is admitted by RULE, not by
 * name: a hand-written allow list cannot contain a token that did not exist yesterday, so an
 * allow-list miss must not block it. An explicit deny is a different thing entirely -- the operator
 * saying "not this one" -- and it still wins.
 */
export function watchlistDenial(pool: Pick<ScreenedPool, "address" | "baseSymbol" | "baseMint" | "name">, w: Watchlist): string | null {
  return watchlistRefusal(pool, { ...w, mode: "off" });
}

/** PURE. The entry for a token, by symbol or mint. */
export function watchEntry(w: Watchlist, key: string): WatchToken | null {
  return w.tokens.find((t) => norm(t.symbol) === norm(key) || t.mint === key) ?? null;
}

/** PURE. Add a token; adding one that is already there updates its mint and note rather than duplicating. */
export function addToken(w: Watchlist, t: { symbol: string; mint?: string; note?: string }): Watchlist {
  const tokens = w.tokens.filter((x) => norm(x.symbol) !== norm(t.symbol) && (!t.mint || x.mint !== t.mint));
  tokens.push({ symbol: t.symbol.trim(), ...(t.mint ? { mint: t.mint } : {}), ...(t.note ? { note: t.note } : {}), addedAt: new Date().toISOString() });
  return { ...w, tokens, deny: w.deny.filter((d) => norm(d) !== norm(t.symbol) && d !== t.mint) };
}

/** PURE. Remove a token from the list (it does not deny it; use denyToken for that). */
export function removeToken(w: Watchlist, key: string): Watchlist {
  return { ...w, tokens: w.tokens.filter((t) => norm(t.symbol) !== norm(key) && t.mint !== key) };
}

/** PURE. Deny a token outright, whatever the mode. */
export function denyToken(w: Watchlist, key: string): Watchlist {
  const deny = w.deny.some((d) => norm(d) === norm(key) || d === key) ? w.deny : [...w.deny, key.trim()];
  return { ...w, deny, tokens: w.tokens.filter((t) => norm(t.symbol) !== norm(key) && t.mint !== key) };
}
