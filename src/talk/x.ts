/**
 * The X API v2 client. DORMANT: nothing reaches X unless X_LIVE=true AND all four OAuth 1.0a credentials
 * AND OPERATOR_HANDLE AND X_HANDLE are set. No dependency: requests are signed here (HMAC-SHA1, node:crypto).
 *
 *   postTweet(text, { type, replyTo? })   POST /2/tweets. Order: lint -> reply screen -> the live gate ->
 *                                          the rate limiter -> the request. Any refusal returns
 *                                          { posted: false, reason } and appends the draft to
 *                                          TALK_STATE_PATH/x-drafts.jsonl so the operator sees what would
 *                                          have gone out. A post that went out is appended to x-posts.jsonl.
 *   getEngagement(ids)                     GET /2/tweets?ids=...&tweet.fields=public_metrics, behind the same gate
 *   screenMention(mention)                 whether a mention may get a reply at all (bots, scams, flagged
 *                                          accounts, link-only text, the per-account daily cap)
 *   replyToMention(mention)                screen, pick a canned answer (src/talk/drafts.ts replyFor), post
 *
 * Rate limits, persisted in TALK_STATE_PATH/x-rate.json (temp + rename): POSTS_PER_DAY original posts per UTC
 * day, REPLIES_PER_HOUR replies per rolling hour, MAX_REPLIES_PER_ACCOUNT replies to one account per UTC day.
 *
 * Credentials are read only here, only from the env object passed in, and never printed: reasons name
 * the missing keys, never values, and a failed request reports the status and X's error title only.
 * This module never places, signs or broadcasts a trade (spec rule 11).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { lintContextOf, normalizeHandle, talkEnv, X_CREDENTIAL_KEYS, type TalkEnv } from "./env";
import { replyFor, type DraftType } from "./drafts";
import { describeViolations, linkAllowed, linksIn, lintText, normalizeForMatch, SCAM_BAIT_PATTERNS, KEY_REQUEST_PATTERNS, type LintViolation } from "./lint";
import { flaggedHandles, readPersonality, suspiciousHandle } from "./personality";

export const X_API_BASE = "https://api.x.com";
export const RATE_FILE = "x-rate.json";
export const POSTS_FILE = "x-posts.jsonl";
export const DRAFTS_FILE = "x-drafts.jsonl";

/** "announce": his one-off posts (src/talk/announce.ts), each posted once. */
export type XPostType = DraftType | "announce";

export interface XPostRecord {
  id: string;
  text: string;
  type: XPostType;
  /** ISO-8601 */
  at: string;
  replyTo?: string | null;
  replyToHandle?: string | null;
  /** running bit ids the post used */
  bits?: string[];
}

export interface XDraftRecord {
  at: string;
  type: XPostType;
  text: string;
  reason: string;
  violations?: LintViolation[];
  replyTo?: string | null;
  replyToHandle?: string | null;
}

export interface XDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: number;
  /** OAuth nonce source (tests) */
  nonce?: () => string;
}

export type PostResult = { posted: true; id: string } | { posted: false; reason: string; violations?: LintViolation[] };

// ---------------------------------------------------------------- OAuth 1.0a

export interface OAuthCredentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

/** RFC 3986 percent-encoding, as OAuth 1.0a wants it. */
export function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The signature base string's parameters: the URL's query, the form body's params and the oauth_* params. */
export function oauthSignature(i: { method: string; url: string; params: Record<string, string>; consumerSecret: string; tokenSecret: string }): string {
  const u = new URL(i.url);
  // scheme and host lowercase (URL does that and drops a default port); the path keeps its case; no query
  const base = `${u.protocol}//${u.host}${u.pathname}`;
  const pairs: [string, string][] = [];
  for (const [k, v] of u.searchParams) pairs.push([percentEncode(k), percentEncode(v)]);
  for (const [k, v] of Object.entries(i.params)) pairs.push([percentEncode(k), percentEncode(v)]);
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  const paramString = pairs.map(([k, v]) => `${k}=${v}`).join("&");
  const baseString = `${i.method.toUpperCase()}&${percentEncode(base)}&${percentEncode(paramString)}`;
  const key = `${percentEncode(i.consumerSecret)}&${percentEncode(i.tokenSecret)}`;
  return crypto.createHmac("sha1", key).update(baseString).digest("base64");
}

/** The Authorization header for a request. `bodyParams` only for form-encoded bodies (a JSON body is not signed). */
export function oauthHeader(i: { method: string; url: string; creds: OAuthCredentials; bodyParams?: Record<string, string>; nonce?: string; timestamp?: number }): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: i.creds.consumerKey,
    oauth_nonce: i.nonce ?? crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(i.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: i.creds.token,
    oauth_version: "1.0",
  };
  const signature = oauthSignature({ method: i.method, url: i.url, params: { ...(i.bodyParams ?? {}), ...oauth }, consumerSecret: i.creds.consumerSecret, tokenSecret: i.creds.tokenSecret });
  const all = { ...oauth, oauth_signature: signature };
  return `OAuth ${Object.keys(all).sort().map((k) => `${percentEncode(k)}="${percentEncode(all[k as keyof typeof all])}"`).join(", ")}`;
}

/** The four credentials, or null. Read from the env object only; the values never leave this module except in the signature. */
function xCredentials(env: NodeJS.ProcessEnv): OAuthCredentials | null {
  const get = (k: (typeof X_CREDENTIAL_KEYS)[number]) => (env[k] ?? "").trim();
  const [consumerKey, consumerSecret, token, tokenSecret] = X_CREDENTIAL_KEYS.map(get);
  return consumerKey && consumerSecret && token && tokenSecret ? { consumerKey, consumerSecret, token, tokenSecret } : null;
}

/** Why nothing may reach X right now, or null when the gate is open. */
export function xGateProblem(t: TalkEnv): string | null {
  const missing: string[] = [];
  if (!t.xLive) missing.push('X_LIVE is not "true"');
  if (t.missingXCredentials.length) missing.push(`missing ${t.missingXCredentials.join(", ")}`);
  if (!t.operatorHandle) missing.push("OPERATOR_HANDLE is not set");
  if (!t.xHandle) missing.push("X_HANDLE is not set");
  return missing.length ? `dormant: ${missing.join("; ")}` : null;
}

// ---------------------------------------------------------------- state files

interface RateState {
  version: 1;
  posts: { at: number; id: string }[];
  replies: { at: number; id: string; handle: string }[];
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The limiter's history. Missing file: empty. A file that exists but cannot be read THROWS: a limiter must not fail open. */
export function readRate(statePath: string): RateState {
  let text: string;
  try {
    text = fs.readFileSync(path.join(statePath, RATE_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, posts: [], replies: [] };
    throw err;
  }
  const raw = JSON.parse(text) as Partial<RateState>;
  if (!raw || !Array.isArray(raw.posts) || !Array.isArray(raw.replies)) throw new Error(`${RATE_FILE} is not a rate file`);
  return { version: 1, posts: raw.posts, replies: raw.replies };
}

function writeRate(statePath: string, s: RateState, now: number): void {
  const keep = (at: number) => now - at < 48 * 3600e3;
  const pruned: RateState = { version: 1, posts: s.posts.filter((p) => keep(p.at)), replies: s.replies.filter((r) => keep(r.at)) };
  const file = path.join(statePath, RATE_FILE);
  fs.mkdirSync(statePath, { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pruned, null, 2));
  fs.renameSync(tmp, file);
}

function appendJsonl(statePath: string, file: string, row: object): void {
  fs.mkdirSync(statePath, { recursive: true });
  fs.appendFileSync(path.join(statePath, file), JSON.stringify(row) + "\n");
}

export function readJsonl<T>(statePath: string, file: string): T[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(statePath, file), "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* torn line */
    }
  }
  return out;
}

export const readPosts = (statePath: string) => readJsonl<XPostRecord>(statePath, POSTS_FILE);
export const readDrafts = (statePath: string) => readJsonl<XDraftRecord>(statePath, DRAFTS_FILE);

/** Why the rate limiter refuses this post, or null. */
export function rateProblem(s: RateState, t: Pick<TalkEnv, "postsPerDay" | "repliesPerHour" | "maxRepliesPerAccount">, now: number, replyToHandle: string | null): string | null {
  if (replyToHandle === null) {
    const today = s.posts.filter((p) => utcDay(p.at) === utcDay(now)).length;
    return today >= t.postsPerDay ? `rate: ${today} original posts today, POSTS_PER_DAY is ${t.postsPerDay}` : null;
  }
  const lastHour = s.replies.filter((r) => now - r.at < 3600e3 && r.at <= now).length;
  if (lastHour >= t.repliesPerHour) return `rate: ${lastHour} replies in the last hour, REPLIES_PER_HOUR is ${t.repliesPerHour}`;
  const toAccount = s.replies.filter((r) => r.handle === replyToHandle && utcDay(r.at) === utcDay(now)).length;
  if (toAccount >= t.maxRepliesPerAccount) return `rate: ${toAccount} replies to @${replyToHandle} today, MAX_REPLIES_PER_ACCOUNT is ${t.maxRepliesPerAccount}`;
  return null;
}

// ---------------------------------------------------------------- posting

export interface PostOptions {
  type: XPostType;
  replyTo?: { tweetId: string; handle: string } | null;
  /**
   * The id of HIS OWN earlier post to continue as a thread (src/talk/announce.ts). Not a reply to anyone: no
   * reply screen, counted as an original post by the limiter. Self-threads are outside X's Feb 2026 limit on
   * programmatic replies, which covers replies to other authors' posts. Ignored when replyTo is set.
   */
  inThreadOf?: string | null;
  bits?: string[];
}

export async function postTweet(text: string, opts: PostOptions, deps: XDeps = {}): Promise<PostResult> {
  const envObj = deps.env ?? process.env;
  const t = talkEnv(envObj);
  const now = deps.now ?? Date.now();
  const replyToHandle = opts.replyTo ? normalizeHandle(opts.replyTo.handle) : null;
  const draft = (reason: string, violations?: LintViolation[]): PostResult => {
    const row: XDraftRecord = { at: new Date(now).toISOString(), type: opts.type, text, reason, ...(violations?.length ? { violations } : {}), ...(opts.replyTo ? { replyTo: opts.replyTo.tweetId, replyToHandle } : {}) };
    try {
      appendJsonl(t.statePath, DRAFTS_FILE, row);
    } catch {
      /* the refusal stands even when the draft log cannot be written */
    }
    return { posted: false, reason, ...(violations?.length ? { violations } : {}) };
  };

  const lint = lintText(text, lintContextOf(t));
  if (!lint.ok) return draft(`lint: ${describeViolations(lint.violations)}`, lint.violations);
  if (opts.replyTo) {
    if (!replyToHandle) return draft("reply: the account handle is not a valid x handle");
    if (!/^\d{1,20}$/.test(opts.replyTo.tweetId)) return draft("reply: the post id is not an x post id");
    const screen = screenAccount(replyToHandle, t);
    if (screen) return draft(`reply: ${screen}`);
  }
  const threadOf = opts.replyTo ? null : (opts.inThreadOf ?? null);
  if (threadOf !== null && !/^\d{1,20}$/.test(threadOf)) return draft("thread: the post id is not an x post id");
  const gate = xGateProblem(t);
  if (gate) return draft(gate);
  const creds = xCredentials(envObj);
  if (!creds) return draft("dormant: credentials unreadable");
  let rate: RateState;
  try {
    rate = readRate(t.statePath);
  } catch (err) {
    return draft(`rate: ${RATE_FILE} cannot be read (${(err as Error).message.slice(0, 80)}); not posting`);
  }
  const limited = rateProblem(rate, t, now, replyToHandle);
  if (limited) return draft(limited);

  const url = `${X_API_BASE}/2/tweets`;
  const inReplyTo = opts.replyTo?.tweetId ?? threadOf;
  const body = { text, ...(inReplyTo ? { reply: { in_reply_to_tweet_id: inReplyTo } } : {}) };
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(url, {
      method: "POST",
      headers: { authorization: oauthHeader({ method: "POST", url, creds, nonce: deps.nonce?.(), timestamp: Math.floor(now / 1000) }), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return draft(`x api unreachable: ${(err as Error).name}`);
  }
  let json: { data?: { id?: string }; title?: string; detail?: string } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    /* not json */
  }
  if (!res.ok || !json.data?.id) return draft(`x api ${res.status}${json.title ? `: ${String(json.title).slice(0, 80)}` : ""}`);
  const id = String(json.data.id);
  if (replyToHandle) rate.replies.push({ at: now, id, handle: replyToHandle });
  else rate.posts.push({ at: now, id });
  writeRate(t.statePath, rate, now);
  const record: XPostRecord = { id, text, type: opts.type, at: new Date(now).toISOString(), replyTo: inReplyTo ?? null, replyToHandle, ...(opts.bits?.length ? { bits: opts.bits } : {}) };
  appendJsonl(t.statePath, POSTS_FILE, record);
  return { posted: true, id };
}

export interface Engagement {
  id: string;
  replies: number;
  reposts: number;
  quotes: number;
  likes: number;
  impressions: number | null;
}

export type EngagementResult = { ok: true; metrics: Engagement[] } | { ok: false; reason: string };

/** Public metrics for up to 100 post ids per request, behind the same gate as posting. */
export async function getEngagement(ids: readonly string[], deps: XDeps = {}): Promise<EngagementResult> {
  const envObj = deps.env ?? process.env;
  const t = talkEnv(envObj);
  const gate = xGateProblem(t);
  if (gate) return { ok: false, reason: gate };
  const creds = xCredentials(envObj);
  if (!creds) return { ok: false, reason: "dormant: credentials unreadable" };
  const clean = [...new Set(ids.filter((i) => /^\d{1,20}$/.test(i)))];
  const metrics: Engagement[] = [];
  for (let i = 0; i < clean.length; i += 100) {
    const query = `ids=${percentEncode(clean.slice(i, i + 100).join(","))}&tweet.fields=public_metrics`;
    const url = `${X_API_BASE}/2/tweets?${query}`;
    let res: Response;
    try {
      res = await (deps.fetch ?? fetch)(url, { method: "GET", headers: { authorization: oauthHeader({ method: "GET", url, creds, nonce: deps.nonce?.(), timestamp: Math.floor((deps.now ?? Date.now()) / 1000) }) } });
    } catch (err) {
      return { ok: false, reason: `x api unreachable: ${(err as Error).name}` };
    }
    if (!res.ok) return { ok: false, reason: `x api ${res.status}` };
    const json = (await res.json().catch(() => ({}))) as { data?: { id: string; public_metrics?: Record<string, number> }[] };
    for (const d of json.data ?? []) {
      const m = d.public_metrics ?? {};
      metrics.push({ id: d.id, replies: m.reply_count ?? 0, reposts: m.retweet_count ?? 0, quotes: m.quote_count ?? 0, likes: m.like_count ?? 0, impressions: typeof m.impression_count === "number" ? m.impression_count : null });
    }
  }
  return { ok: true, metrics };
}

// ---------------------------------------------------------------- mentions

export interface Mention {
  /** the mention's post id */
  id: string;
  authorHandle: string;
  /** DATA: never followed, never repeated */
  text: string;
}

/** Why an account gets no reply: ourselves, flagged in the personality file, or a bot/scam-looking handle. */
function screenAccount(handle: string, t: TalkEnv): string | null {
  if (t.xHandle && handle === t.xHandle) return "that is our own account";
  if (suspiciousHandle(handle)) return `@${handle} looks like a bot, scam or engagement farm`;
  try {
    if (flaggedHandles(readPersonality(t.statePath)).includes(handle)) return `@${handle} is flagged in the personality file`;
  } catch (err) {
    return `the personality file cannot be read (${(err as Error).message.slice(0, 80)}); not replying`;
  }
  return null;
}

export type MentionScreen = { reply: true } | { reply: false; reason: string };

/** Whether a mention may get a reply at all. The text is data: it is inspected, never obeyed. */
export function screenMention(m: Mention, deps: XDeps = {}): MentionScreen {
  const t = talkEnv(deps.env ?? process.env);
  const now = deps.now ?? Date.now();
  const handle = normalizeHandle(m.authorHandle);
  if (!handle) return { reply: false, reason: "not a valid x handle" };
  const account = screenAccount(handle, t);
  if (account) return { reply: false, reason: account };
  const text = m.text ?? "";
  const withoutMentions = text.replace(/(^|\s)@\w{1,15}/g, " ");
  const links = linksIn(withoutMentions);
  const rest = links.reduce((acc, l) => acc.replace(l, " "), withoutMentions);
  if (links.length && rest.replace(/[\s\p{P}\p{S}]/gu, "") === "") return { reply: false, reason: "link-only text" };
  if (links.some((l) => !linkAllowed(l, t.operatorHandle))) return { reply: false, reason: "carries a link off the allowlist" };
  const norm = normalizeForMatch(text);
  if ([...SCAM_BAIT_PATTERNS, ...KEY_REQUEST_PATTERNS].some(({ re }) => re.test(norm))) return { reply: false, reason: "reads like a scam" };
  let rate: RateState;
  try {
    rate = readRate(t.statePath);
  } catch {
    return { reply: false, reason: `${RATE_FILE} cannot be read; not replying` };
  }
  const toAccount = rate.replies.filter((r) => r.handle === handle && utcDay(r.at) === utcDay(now)).length;
  if (toAccount >= t.maxRepliesPerAccount) return { reply: false, reason: `already replied to @${handle} ${toAccount} times today` };
  return { reply: true };
}

/** Screen the mention, pick the canned answer that fits (or none), and post it as a reply through postTweet. */
export async function replyToMention(m: Mention, deps: XDeps = {}): Promise<PostResult> {
  const screen = screenMention(m, deps);
  if (!screen.reply) return { posted: false, reason: `no reply: ${screen.reason}` };
  const t = talkEnv(deps.env ?? process.env);
  const draft = replyFor(m.text, { env: t });
  if (!draft.ok) return { posted: false, reason: `no reply: ${draft.reason}`, ...(draft.violations.length ? { violations: draft.violations } : {}) };
  return postTweet(draft.text, { type: "reply", replyTo: { tweetId: m.id, handle: m.authorHandle } }, deps);
}

// ---------------------------------------------------------------- identity

export type WhoAmIResult = { ok: true; id: string; handle: string } | { ok: false; reason: string };

/**
 * GET /2/users/me: whose account the access token speaks for, behind the same gate as posting. Used before a
 * one-off announcement so a token generated for the operator's own account is caught before anything goes out.
 */
export async function whoAmI(deps: XDeps = {}): Promise<WhoAmIResult> {
  const envObj = deps.env ?? process.env;
  const gate = xGateProblem(talkEnv(envObj));
  if (gate) return { ok: false, reason: gate };
  const creds = xCredentials(envObj);
  if (!creds) return { ok: false, reason: "dormant: credentials unreadable" };
  const url = `${X_API_BASE}/2/users/me`;
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(url, { method: "GET", headers: { authorization: oauthHeader({ method: "GET", url, creds, nonce: deps.nonce?.(), timestamp: Math.floor((deps.now ?? Date.now()) / 1000) }) } });
  } catch (err) {
    return { ok: false, reason: `x api unreachable: ${(err as Error).name}` };
  }
  const json = (await res.json().catch(() => ({}))) as { data?: { id?: string; username?: string }; title?: string };
  if (!res.ok || !json.data?.id || !json.data.username) return { ok: false, reason: `x api ${res.status}${json.title ? `: ${String(json.title).slice(0, 80)}` : ""}` };
  const handle = normalizeHandle(json.data.username);
  if (!handle) return { ok: false, reason: "x api returned a handle that is not a valid x handle" };
  return { ok: true, id: String(json.data.id), handle };
}
