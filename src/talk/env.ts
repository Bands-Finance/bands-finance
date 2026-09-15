/**
 * The talking layer's knobs (docs/mr-bands-agent.md placeholders), read straight from an env object so
 * tests pin their own. Empty strings read as unset (dotenv writes `KEY=` as "").
 *
 *   OPERATOR_HANDLE          {{OPERATOR_HANDLE}}: the operator's X handle. REQUIRED to post and to apply any
 *                            living-layer change; no default. Stored without "@", lowercased.
 *   X_HANDLE                 {{X_HANDLE}}: Mr Bands' own X handle. REQUIRED to post; no default.
 *   TALK_VENUES              {{VENUES}}: how posts name the venues (default: the TRADABLE_VENUES labels,
 *                            "meteora dlmm" on the desk's plist)
 *   STRAP_EDGE_PCT           {{EDGE_THRESHOLD}} (default 15), see the note below
 *   STRAP_STACKED_HOURS      a claim or fee milestone this recent makes the strap "stacked" (default 6)
 *   STRAP_STACKED_EVENTS     which events count: "milestone" (default) or "compound,milestone". The desk claims
 *                            fees but does not reinvest them into the band, so a claim is not a compound;
 *                            counting claims would read "stacked" most of the day, a faked state (spec 3)
 *   TALK_FEE_MILESTONE_SOL   realized fees crossing a multiple of this is a milestone (default 1)
 *   TALK_CHOP_RANGE_PCT      a held pool whose price stayed inside this % range over the window is chop (default 2)
 *   TALK_CHOP_WINDOW_HOURS   the chop window (default 6)
 *   TALK_HOUSE_SYMBOLS       the house token's symbols for the disclosure lint (default "bands")
 *   PAIR_HOUSE_MINTS         the house token's mints (the desk's own key, read here for the lint; default none)
 *   POSTS_PER_DAY            {{POSTS_PER_DAY}} original posts per UTC day (default 8)
 *   REPLIES_PER_HOUR         {{REPLIES_PER_HOUR}} replies per rolling hour (default 10)
 *   MAX_REPLIES_PER_ACCOUNT  {{MAX_REPLIES_PER_ACCOUNT}} replies to one account per UTC day (default 3)
 *   MAX_BIT_USES_PER_WEEK    {{MAX_BIT_USES_PER_WEEK}} uses of one bit in a trailing 7 days (default 3)
 *   TALK_STATE_PATH          {{STATE_PATH}}: personality.json, x-rate.json, x-posts.jsonl, x-drafts.jsonl (default DATA_DIR)
 *   DATA_DIR                 where the journal, paper book and ledger are read (default "data")
 *   CYCLE_INTERVAL_SEC       the loop's cycle; data older than 3 cycles is stale (default 300)
 *   X_LIVE                   only the literal "true" lets anything reach X
 *   X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET
 *                            OAuth 1.0a user context for POST /2/tweets. Never logged: TalkEnv only says
 *                            which are missing; the values are read by xCredentials() inside src/talk/x.ts.
 */
import path from "node:path";
import { tradableVenues } from "../venues/env";

/**
 * STRAP_EDGE_PCT is read as a percent of the band's WIDTH, measured from either edge, not a percent of
 * price. The desk's bands are about 1% of price wide (a 5-bin straddle at 20 bps a bin), so "within 15%
 * of price of an edge" would be true of every band all the time and the strap would read yellow forever.
 * 15 means: yellow once price sits in the outer 15% of the band on either side.
 */
export const DEFAULT_STRAP_EDGE_PCT = 15;
export const DEFAULT_STRAP_STACKED_HOURS = 6;
export const DEFAULT_POSTS_PER_DAY = 8;
export const DEFAULT_REPLIES_PER_HOUR = 10;
export const DEFAULT_MAX_REPLIES_PER_ACCOUNT = 3;
export const DEFAULT_MAX_BIT_USES_PER_WEEK = 3;
export const DEFAULT_FEE_MILESTONE_SOL = 1;
export const DEFAULT_CHOP_RANGE_PCT = 2;
export const DEFAULT_CHOP_WINDOW_HOURS = 6;
export const DEFAULT_HOUSE_SYMBOLS: readonly string[] = ["bands"];
export const DEFAULT_CYCLE_INTERVAL_SEC = 300;

export const X_CREDENTIAL_KEYS = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"] as const;

const VENUE_LABELS: Record<string, string> = { "meteora-dlmm": "meteora dlmm", "raydium-clmm": "raydium clmm", "orca-whirlpool": "orca whirlpools" };

export interface TalkEnv {
  operatorHandle: string | null;
  xHandle: string | null;
  venues: string;
  strapEdgePct: number;
  strapStackedHours: number;
  stackedEvents: { compound: boolean; milestone: boolean };
  feeMilestoneSol: number;
  chopRangePct: number;
  chopWindowHours: number;
  houseSymbols: string[];
  houseMints: string[];
  postsPerDay: number;
  repliesPerHour: number;
  maxRepliesPerAccount: number;
  maxBitUsesPerWeek: number;
  /** absolute */
  statePath: string;
  /** absolute */
  dataDir: string;
  cycleIntervalSec: number;
  xLive: boolean;
  /** names of the X credentials that are unset (never their values) */
  missingXCredentials: string[];
  /** a handle that was set but is not a valid X handle, and similar */
  problems: string[];
}

const val = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const v = env[key];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
};

const num = (env: NodeJS.ProcessEnv, key: string, d: number, min = 0): number => {
  const v = val(env, key);
  if (v === undefined) return d;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : d;
};

/** "@Some_Handle" -> "some_handle"; null when unset or not a valid X handle. */
export function normalizeHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const h = raw.trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9_]{1,15}$/.test(h) ? h : null;
}

function handleOf(env: NodeJS.ProcessEnv, key: string, problems: string[]): string | null {
  const raw = val(env, key);
  if (raw === undefined) return null;
  const h = normalizeHandle(raw);
  if (!h) problems.push(`${key} is set but is not a valid X handle (1-15 letters, digits or _)`);
  return h;
}

const list = (raw: string | undefined): string[] => [...new Set((raw ?? "").split(",").map((s) => s.trim()).filter(Boolean))];

export function talkEnv(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): TalkEnv {
  const problems: string[] = [];
  let venues = val(env, "TALK_VENUES");
  if (!venues) {
    try {
      venues = tradableVenues(env).map((v) => VENUE_LABELS[v] ?? v.replace(/-/g, " ")).join(", ") || "meteora dlmm";
    } catch (err) {
      problems.push((err as Error).message);
      venues = "meteora dlmm";
    }
  }
  const events = (val(env, "STRAP_STACKED_EVENTS") ?? "milestone").toLowerCase();
  const dataDir = path.resolve(cwd, val(env, "DATA_DIR") ?? "data");
  return {
    operatorHandle: handleOf(env, "OPERATOR_HANDLE", problems),
    xHandle: handleOf(env, "X_HANDLE", problems),
    venues: venues.toLowerCase(),
    strapEdgePct: Math.min(50, num(env, "STRAP_EDGE_PCT", DEFAULT_STRAP_EDGE_PCT)),
    strapStackedHours: num(env, "STRAP_STACKED_HOURS", DEFAULT_STRAP_STACKED_HOURS),
    stackedEvents: { compound: events.includes("compound"), milestone: events.includes("milestone") },
    feeMilestoneSol: num(env, "TALK_FEE_MILESTONE_SOL", DEFAULT_FEE_MILESTONE_SOL, 1e-9),
    chopRangePct: num(env, "TALK_CHOP_RANGE_PCT", DEFAULT_CHOP_RANGE_PCT),
    chopWindowHours: num(env, "TALK_CHOP_WINDOW_HOURS", DEFAULT_CHOP_WINDOW_HOURS, 1e-9),
    houseSymbols: val(env, "TALK_HOUSE_SYMBOLS") === undefined ? [...DEFAULT_HOUSE_SYMBOLS] : list(env.TALK_HOUSE_SYMBOLS).map((s) => s.replace(/^\$/, "").toLowerCase()),
    houseMints: list(env.PAIR_HOUSE_MINTS),
    postsPerDay: Math.floor(num(env, "POSTS_PER_DAY", DEFAULT_POSTS_PER_DAY)),
    repliesPerHour: Math.floor(num(env, "REPLIES_PER_HOUR", DEFAULT_REPLIES_PER_HOUR)),
    maxRepliesPerAccount: Math.floor(num(env, "MAX_REPLIES_PER_ACCOUNT", DEFAULT_MAX_REPLIES_PER_ACCOUNT)),
    maxBitUsesPerWeek: Math.floor(num(env, "MAX_BIT_USES_PER_WEEK", DEFAULT_MAX_BIT_USES_PER_WEEK)),
    statePath: path.resolve(cwd, val(env, "TALK_STATE_PATH") ?? val(env, "DATA_DIR") ?? "data"),
    dataDir,
    cycleIntervalSec: num(env, "CYCLE_INTERVAL_SEC", DEFAULT_CYCLE_INTERVAL_SEC, 1),
    xLive: env.X_LIVE === "true",
    missingXCredentials: X_CREDENTIAL_KEYS.filter((k) => val(env, k) === undefined),
    problems,
  };
}

/** The lint context every outgoing text is checked with. */
export function lintContextOf(t: TalkEnv): { operatorHandle: string | null; houseSymbols: string[]; houseMints: string[] } {
  return { operatorHandle: t.operatorHandle, houseSymbols: t.houseSymbols, houseMints: t.houseMints };
}
