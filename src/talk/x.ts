/**
 * The X API v2 client. Nothing reaches X unless X_LIVE=true AND all four OAuth 1.0a credentials AND OPERATOR_HANDLE
 * AND X_HANDLE are set. No dependency: requests are signed here (HMAC-SHA1, node:crypto). He posts (the loop,
 * src/talk/tick.ts) and he replies to people who summoned him (the engage loop, src/talk/engage.ts, which also needs
 * X_REPLIES=true and his brain; docs/talk.md, "Engage").
 *
 *   postTweet(text, { type, replyTo? })   POST /2/tweets. Order: lint -> reply screen -> the live gate ->
 *                                          the rate limiter -> the request. Any refusal returns
 *                                          { posted: false, reason } and appends the draft to
 *                                          TALK_STATE_PATH/x-drafts.jsonl so Zach sees what would
 *                                          have gone out. A post that went out is appended to x-posts.jsonl.
 *                                          A "reply" must carry replyTo and nothing else may (never a top-level
 *                                          post by accident); one reply per mention, checked against x-posts.jsonl
 *                                          inside the rate lock; never a reply to his own post or handle.
 *   postReply(text, { tweetId, handle })   postTweet as a reply, always with replyTo: the only way engage.ts posts.
 *                                          excludeUserIds leaves the thread's other accounts out of the reply
 *                                          (reply.exclude_reply_user_ids), so he never pings anyone who did not summon him
 *   getMentions(sinceId, { userId })       GET /2/users/{id}/mentions, one page of up to 100, oldest first, with the
 *                                          authors and referenced posts expanded; a failure is { ok: false }, never [].
 *                                          untilId bounds it from above (a gap a failed page left behind)
 *   noteUncertainReply(statePath, handle)  a reply that may have gone out (a crash after the POST): counted by the
 *                                          limiter as one, under the rate lock
 *   getEngagement(ids)                     GET /2/tweets?ids=...&tweet.fields=public_metrics, behind the same gate
 *   screenMention(mention)                 whether a mention may get a reply at all (bots, scams, flagged
 *                                          accounts, link-only text, the per-account daily cap)
 *   replyToMention(mention)                screen, pick a canned answer (src/talk/drafts.ts replyFor), post
 *   verifyCredentials()                    GET /2/users/me: the handle the keys sign in as. The one call NOT behind
 *                                          X_LIVE (a read that changes nothing; `talk.ts check`); needs the four keys
 *
 * The rate file's read, the post and the rate file's write run under TALK_STATE_PATH/x-rate.lock (src/talk/lock.ts),
 * so two processes can never both pass the limiter on the same state. The posting loop (src/talk/tick.ts) passes an
 * event `key` that lands in the post or draft record; its dry records in x-posts.jsonl carry `dry: true` and
 * readPosts leaves them out (they are not posts).
 *
 * Rate limits, persisted in TALK_STATE_PATH/x-rate.json (temp + rename): POSTS_PER_DAY original posts per UTC
 * day, REPLIES_PER_DAY replies per UTC day, REPLIES_PER_HOUR replies per rolling hour, MAX_REPLIES_PER_ACCOUNT
 * replies to one account per UTC day.
 *
 * Credentials are read only here, only from the env object passed in, and never printed: reasons name
 * the missing keys, never values, and a failed request reports the status and X's error title and detail only.
 * This module never places, signs or broadcasts a trade (spec rule 11).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_REPLIES_PER_DAY, lintContextOf, normalizeHandle, talkEnv, X_CREDENTIAL_KEYS, type TalkEnv } from "./env";
import { replyFor, type DraftType } from "./drafts";
import { describeViolations, linkAllowed, linksIn, lintText, normalizeForMatch, SCAM_BAIT_PATTERNS, KEY_REQUEST_PATTERNS, type LintViolation } from "./lint";
import { flaggedHandles, readPersonality, suspiciousHandle } from "./personality";
import { withLock } from "./lock";

export const X_API_BASE = "https://api.x.com";
export const RATE_FILE = "x-rate.json";
export const POSTS_FILE = "x-posts.jsonl";
export const DRAFTS_FILE = "x-drafts.jsonl";
/**
 * The POST intents (opts.intent): a row {key, text, at} written right before the POST, and a row {key, resolved, at}
 * once X answers. An intent never resolved (the request timed out after X took it, or the process died between X's
 * answer and x-posts.jsonl) means X may hold the post: its key counts as used (unresolvedIntentKeys).
 */
export const INTENTS_FILE = "x-intents.jsonl";

export interface XIntentRow {
  key: string;
  at: string;
  text?: string;
  resolved?: "posted" | "refused";
  id?: string;
}

/** The keys whose POST went out and never got X's answer, since `since` (ms). */
export function unresolvedIntentKeys(statePath: string, since: number): Set<string> {
  const open = new Map<string, number>();
  for (const r of readJsonl<XIntentRow>(statePath, INTENTS_FILE)) {
    if (!r || typeof r.key !== "string") continue;
    const at = Date.parse(r.at);
    if (r.resolved) open.delete(r.key);
    else if (at >= since) open.set(r.key, at);
  }
  return new Set(open.keys());
}
/** held around read-rate, post, write-rate so two processes can never both post on the same rate state */
export const RATE_LOCK_FILE = "x-rate.lock";
/** present in TALK_STATE_PATH: nothing is posted, by any path (the loop, an announcement, a manual post) */
export const TALK_STOP_FILE = "TALK_STOP";

/**
 * A refusal worth trying again later: X down or rate-limited (5xx, 429), out of pay-per-use balance (402),
 * unreachable, the rate lock busy, the limiter full, or the stop file. The posting loop does not count a
 * draft with such a reason as used (`retry: true`); a lint refusal or a dormant draft stays used.
 */
export function retryableReason(reason: string): boolean {
  return /^(stopped:|x api unreachable|x api (402|429|5\d\d)\b|rate: )/.test(reason);
}

/** the draft types, plus the posting loop's own event posts (src/talk/tick.ts) and "announce": his one-off posts (src/talk/announce.ts), each posted once */
/** the builder voice's shapes (src/talk/moments.ts), recorded as their own types */
export type BuilderPostType = "desk" | "followup" | "build" | "miss" | "learner" | "screener" | "arc" | "promise" | "halt";
export type XPostType = DraftType | BuilderPostType | "open" | "close" | "daily" | "milestone" | "announce";

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
  /** the posting loop's stable event key (src/talk/tick.ts), for its 7-day dedupe */
  key?: string;
  /** true on the loop's record of a draft that did not go out (X dormant): never a real post; readPosts skips it */
  dry?: boolean;
}

export interface XDraftRecord {
  at: string;
  type: XPostType;
  text: string;
  reason: string;
  violations?: LintViolation[];
  replyTo?: string | null;
  replyToHandle?: string | null;
  /** the posting loop's stable event key, when the loop wrote it */
  key?: string;
  /** the refusal was transient (retryableReason): the loop may try this key again */
  retry?: boolean;
}

export interface XDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: number;
  /** OAuth nonce source (tests) */
  nonce?: () => string;
}

/** a refused post; a 429 from X carries its x-rate-limit-reset as resetAt (ms), so a caller can wait for it */
export type PostResult = { posted: true; id: string } | { posted: false; reason: string; violations?: LintViolation[]; resetAt?: number };

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

/** Posts that went out. The loop's dry records (`dry: true`) are not posts and are left out. */
export const readPosts = (statePath: string) => readJsonl<XPostRecord>(statePath, POSTS_FILE).filter((p) => !p.dry);
/** Everything in x-posts.jsonl, the loop's dry records included (the loop's dedupe and daily count read this). */
export const readPostLog = (statePath: string) => readJsonl<XPostRecord>(statePath, POSTS_FILE);
export const readDrafts = (statePath: string) => readJsonl<XDraftRecord>(statePath, DRAFTS_FILE);

/** Why the rate limiter refuses this post, or null. */
export function rateProblem(s: RateState, t: Pick<TalkEnv, "postsPerDay" | "repliesPerHour" | "maxRepliesPerAccount"> & Partial<Pick<TalkEnv, "repliesPerDay">>, now: number, replyToHandle: string | null): string | null {
  if (replyToHandle === null) {
    const today = s.posts.filter((p) => utcDay(p.at) === utcDay(now)).length;
    return today >= t.postsPerDay ? `rate: ${today} original posts today, POSTS_PER_DAY is ${t.postsPerDay}` : null;
  }
  const perDay = t.repliesPerDay ?? DEFAULT_REPLIES_PER_DAY;
  const repliesToday = s.replies.filter((r) => utcDay(r.at) === utcDay(now)).length;
  if (repliesToday >= perDay) return `rate: ${repliesToday} replies today, REPLIES_PER_DAY is ${perDay}`;
  const lastHour = s.replies.filter((r) => now - r.at < 3600e3 && r.at <= now).length;
  if (lastHour >= t.repliesPerHour) return `rate: ${lastHour} replies in the last hour, REPLIES_PER_HOUR is ${t.repliesPerHour}`;
  const toAccount = s.replies.filter((r) => r.handle === replyToHandle && utcDay(r.at) === utcDay(now)).length;
  if (toAccount >= t.maxRepliesPerAccount) return `rate: ${toAccount} replies to @${replyToHandle} today, MAX_REPLIES_PER_ACCOUNT is ${t.maxRepliesPerAccount}`;
  return null;
}

/**
 * Whether x-posts.jsonl already holds a reply to this post by this author: one reply per mention, even after a
 * crash (read inside the rate lock, right before the POST). A post id has one author, so the pair is the mention.
 */
export function alreadyRepliedTo(statePath: string, tweetId: string, handle: string | null): boolean {
  return readPosts(statePath).some((p) => p.type === "reply" && p.replyTo === tweetId && (handle === null || !p.replyToHandle || p.replyToHandle === handle));
}

// ---------------------------------------------------------------- posting

export interface PostOptions {
  type: XPostType;
  /** excludeUserIds: the accounts X would add to the reply's "Replying to" list that he leaves out (never the author) */
  replyTo?: { tweetId: string; handle: string; excludeUserIds?: readonly string[] } | null;
  /**
   * The id of HIS OWN earlier post to continue as a thread (src/talk/announce.ts). Not a reply to anyone: no
   * reply screen, counted as an original post by the limiter. Self-threads are outside X's Feb 2026 limit on
   * programmatic replies, which covers replies to other authors' posts. Ignored when replyTo is set.
   */
  inThreadOf?: string | null;
  bits?: string[];
  /** the posting loop's stable event key, carried into the post or draft record */
  key?: string;
  /**
   * Write an intent row (INTENTS_FILE) before the POST and resolve it on X's answer; needs `key`. The builder voice
   * sets it: its wording changes from ask to ask, so X's duplicate refusal cannot catch a second post of one moment.
   */
  intent?: boolean;
  /**
   * The builder voice (sentence case): the lint here runs without its lowercase rule, because the caller has already
   * passed the text through vetBuilderPost (src/talk/postGuards.ts), whose sentence-case check replaces it.
   */
  sentenceCase?: boolean;
}

/** ": <title>; <detail>" from an X error body (title 80, detail 200 characters), or "" when it carries neither. */
export function describeXError(json: { title?: unknown; detail?: unknown } | null | undefined): string {
  const title = json?.title ? String(json.title).slice(0, 80) : "";
  const detail = json?.detail ? String(json.detail).replace(/\s+/g, " ").slice(0, 200) : "";
  return `${title ? `: ${title}` : ""}${detail ? `${title ? ";" : ":"} ${detail}` : ""}`;
}

export async function postTweet(text: string, opts: PostOptions, deps: XDeps = {}): Promise<PostResult> {
  const envObj = deps.env ?? process.env;
  const t = talkEnv(envObj);
  const now = deps.now ?? Date.now();
  const replyToHandle = opts.replyTo ? normalizeHandle(opts.replyTo.handle) : null;
  const draft = (reason: string, violations?: LintViolation[]): PostResult => {
    const row: XDraftRecord = { at: new Date(now).toISOString(), type: opts.type, text, reason, ...(violations?.length ? { violations } : {}), ...(opts.replyTo ? { replyTo: opts.replyTo.tweetId, replyToHandle } : {}), ...(opts.key ? { key: opts.key } : {}), ...(opts.key && retryableReason(reason) ? { retry: true } : {}) };
    try {
      appendJsonl(t.statePath, DRAFTS_FILE, row);
    } catch {
      /* the refusal stands even when the draft log cannot be written */
    }
    return { posted: false, reason, ...(violations?.length ? { violations } : {}) };
  };

  const stopped = () => fs.existsSync(path.join(t.statePath, TALK_STOP_FILE));
  if (stopped()) return draft(`stopped: ${TALK_STOP_FILE} is in ${t.statePath}; nothing is posted`);
  // a reply always names the post it answers, and only a reply may: never a top-level post by accident
  if (opts.type === "reply" && !opts.replyTo) return draft("reply: a reply without the post it answers; never a top-level post by accident");
  if (opts.replyTo && opts.type !== "reply") return draft(`reply: replyTo is set on a ${opts.type} post; only a reply may answer a post`);
  const lint = lintText(text, { ...lintContextOf(t), ...(opts.sentenceCase ? { caseRule: "sentence" as const } : {}) });
  if (!lint.ok) return draft(`lint: ${describeViolations(lint.violations)}`, lint.violations);
  if (opts.replyTo) {
    if (!replyToHandle) return draft("reply: the account handle is not a valid x handle");
    if (!/^\d{1,20}$/.test(opts.replyTo.tweetId)) return draft("reply: the post id is not an x post id");
    if (t.xHandle && replyToHandle === t.xHandle) return draft("reply: that is his own handle; he never replies to himself");
    const screen = screenAccount(replyToHandle, t);
    if (screen) return draft(`reply: ${screen}`);
    if (readPosts(t.statePath).some((p) => p.id === opts.replyTo!.tweetId)) return draft("reply: that is his own post; he never replies to himself");
  }
  const threadOf = opts.replyTo ? null : (opts.inThreadOf ?? null);
  if (threadOf !== null && !/^\d{1,20}$/.test(threadOf)) return draft("thread: the post id is not an x post id");
  const gate = xGateProblem(t);
  if (gate) return draft(gate);
  const creds = xCredentials(envObj);
  if (!creds) return draft("dormant: credentials unreadable");
  // read-rate, post, write-rate under one lock: two processes can never both pass the limiter on the same state
  const locked = await withLock(path.join(t.statePath, RATE_LOCK_FILE), () => postLocked(creds));
  return locked.locked ? locked.value : draft(`rate: another post holds ${RATE_LOCK_FILE}; not posting`);

  async function postLocked(creds: OAuthCredentials): Promise<PostResult> {
    let rate: RateState;
    try {
      rate = readRate(t.statePath);
    } catch (err) {
      return draft(`rate: ${RATE_FILE} cannot be read (${(err as Error).message.slice(0, 80)}); not posting`);
    }
    const limited = rateProblem(rate, t, now, replyToHandle);
    if (limited) return draft(limited);
    if (opts.replyTo && alreadyRepliedTo(t.statePath, opts.replyTo.tweetId, replyToHandle)) return draft(`reply: already replied to ${opts.replyTo.tweetId}`);
    if (stopped()) return draft(`stopped: ${TALK_STOP_FILE} appeared; nothing is posted`);

    const url = `${X_API_BASE}/2/tweets`;
    const inReplyTo = opts.replyTo?.tweetId ?? threadOf;
    // only when there is someone to leave out: a plain reply keeps its plain body
    const exclude = [...new Set((opts.replyTo?.excludeUserIds ?? []).filter((id) => /^\d{1,20}$/.test(id)))];
    const body = { text, ...(inReplyTo ? { reply: { in_reply_to_tweet_id: inReplyTo, ...(exclude.length ? { exclude_reply_user_ids: exclude } : {}) } } : {}) };
    const intent = opts.intent && opts.key ? opts.key : null;
    const resolve = (resolved: "posted" | "refused", id?: string) => {
      if (!intent) return;
      try {
        appendJsonl(t.statePath, INTENTS_FILE, { key: intent, resolved, at: new Date(now).toISOString(), ...(id ? { id } : {}) } satisfies XIntentRow);
      } catch {
        /* unresolved reads as used: the safe side */
      }
    };
    if (intent) {
      try {
        appendJsonl(t.statePath, INTENTS_FILE, { key: intent, text, at: new Date(now).toISOString() } satisfies XIntentRow);
      } catch (err) {
        return draft(`rate: ${INTENTS_FILE} cannot be written (${(err as Error).message.slice(0, 80)}); not posting`);
      }
    }
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
    // X's `detail` beside its title, never the request: a 402 reads "credits depleted" in one grep of the drafts
    if (!res.ok || !json.data?.id) {
      // X answered with a refusal: it holds nothing (a 5xx may have taken it, so that one stays open)
      if (!(res.status >= 500)) resolve("refused");
      const refused = draft(`x api ${res.status}${describeXError(json)}`);
      const reset = Number(res.headers?.get?.("x-rate-limit-reset") ?? NaN);
      return res.status === 429 && Number.isFinite(reset) && reset > 0 && !refused.posted ? { ...refused, resetAt: reset * 1000 } : refused;
    }
    const id = String(json.data.id);
    if (replyToHandle) rate.replies.push({ at: now, id, handle: replyToHandle });
    else rate.posts.push({ at: now, id });
    writeRate(t.statePath, rate, now);
    const record: XPostRecord = { id, text, type: opts.type, at: new Date(now).toISOString(), replyTo: inReplyTo ?? null, replyToHandle, ...(opts.bits?.length ? { bits: opts.bits } : {}), ...(opts.key ? { key: opts.key } : {}) };
    appendJsonl(t.statePath, POSTS_FILE, record);
    resolve("posted", id);
    return { posted: true, id };
  }
}

// ---------------------------------------------------------------- credential check

export type VerifyResult = { ok: true; username: string; matchesXHandle: boolean | null } | { ok: false; reason: string };

/**
 * GET /2/users/me: which account the four credentials sign in as. The ONE network call here that X_LIVE does not
 * gate: it is a read that changes nothing on X, so the operator can check the keys before turning posting on. It
 * needs only the four credentials; it never posts, and it reports the handle, never a key.
 */
export async function verifyCredentials(deps: XDeps = {}): Promise<VerifyResult> {
  const envObj = deps.env ?? process.env;
  const t = talkEnv(envObj);
  if (t.missingXCredentials.length) return { ok: false, reason: `missing ${t.missingXCredentials.join(", ")}` };
  const creds = xCredentials(envObj);
  if (!creds) return { ok: false, reason: "credentials unreadable" };
  const url = `${X_API_BASE}/2/users/me`;
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(url, { method: "GET", headers: { authorization: oauthHeader({ method: "GET", url, creds, nonce: deps.nonce?.(), timestamp: Math.floor((deps.now ?? Date.now()) / 1000) }) } });
  } catch (err) {
    return { ok: false, reason: `x api unreachable: ${(err as Error).name}` };
  }
  const json = (await res.json().catch(() => ({}))) as { data?: { username?: string }; title?: string; detail?: string };
  if (!res.ok) return { ok: false, reason: `x api ${res.status}${describeXError(json)}` };
  const username = normalizeHandle(json.data?.username ?? null);
  if (!username) return { ok: false, reason: "x api answered without a valid username" };
  return { ok: true, username, matchesXHandle: t.xHandle ? t.xHandle === username : null };
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
  // the fields below come from getMentions (GET /2/users/{id}/mentions with its expansions); all optional
  authorId?: string;
  /** DATA */
  authorName?: string;
  /** DATA: the author's bio */
  authorBio?: string;
  /** ISO-8601 */
  authorCreatedAt?: string;
  authorFollowers?: number;
  conversationId?: string;
  /** ISO-8601 */
  createdAt?: string;
  inReplyToUserId?: string;
  /** the post this one replies to */
  parentId?: string;
  /** DATA: the parent's text, when X expanded it */
  parentText?: string;
  parentAuthorId?: string;
  /** the author of the post this one quotes */
  quotedAuthorId?: string;
  /** handles named in the body, lowercased, outside the leading reply-handle prefix X adds to a reply */
  bodyHandles?: string[];
  /** the user ids of every account the post @mentions, prefix and body (entities.mentions[].id) */
  mentionUserIds?: string[];
}

/**
 * The handles a post names in its body, lowercased: the entities.mentions that start at or after the
 * display_text_range start (X puts the inherited reply prefix before it). Without those fields, the text with its
 * leading run of @handles removed.
 */
export function bodyHandlesOf(text: string, o: { displayStart?: number | null; mentions?: readonly { username?: string; start?: number }[] | null } = {}): string[] {
  const out = new Set<string>();
  if (typeof o.displayStart === "number" && Array.isArray(o.mentions)) {
    for (const m of o.mentions) {
      const h = normalizeHandle(m.username ?? null);
      if (h && typeof m.start === "number" && m.start >= o.displayStart) out.add(h);
    }
    return [...out];
  }
  const body = String(text ?? "").replace(/^(\s*@\w{1,15})+/, "");
  for (const m of body.matchAll(/(?:^|[^\w@])@(\w{1,15})\b/g)) {
    const h = normalizeHandle(m[1]);
    if (h) out.add(h);
  }
  return [...out];
}

/** The links in a mention once its @handles are removed (X wraps every link in t.co, so any link at all counts). */
export function linksInMentionBody(text: string): string[] {
  return linksIn(String(text ?? "").replace(/(^|\s)@\w{1,15}/g, " "));
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

/** A reply to one mention: postTweet with type "reply" and replyTo always set. engage.ts never calls postTweet itself. */
export function postReply(text: string, replyTo: { tweetId: string; handle: string; excludeUserIds?: readonly string[] }, deps: XDeps = {}): Promise<PostResult> {
  return postTweet(text, { type: "reply", replyTo, sentenceCase: true }, deps);
}

/**
 * A reply that may have gone out without being recorded (the engage process died after the POST and before it heard
 * back): one provisional row in x-rate.json, so REPLIES_PER_DAY, REPLIES_PER_HOUR and MAX_REPLIES_PER_ACCOUNT count
 * it. Under the rate lock, like a post. Returns false when the lock or the file could not be had (nothing written).
 */
export async function noteUncertainReply(statePath: string, handle: string, now: number, mentionId: string): Promise<boolean> {
  const h = normalizeHandle(handle);
  if (!h) return false;
  const locked = await withLock(path.join(statePath, RATE_LOCK_FILE), () => {
    try {
      const rate = readRate(statePath);
      rate.replies.push({ at: now, id: `uncertain:${mentionId}`, handle: h });
      writeRate(statePath, rate, now);
      return true;
    } catch {
      return false;
    }
  });
  return locked.locked ? locked.value : false;
}

// ---------------------------------------------------------------- reading mentions

export const MENTION_TWEET_FIELDS = "author_id,conversation_id,created_at,in_reply_to_user_id,referenced_tweets,display_text_range,entities";
export const MENTION_EXPANSIONS = "author_id,referenced_tweets.id";
export const MENTION_USER_FIELDS = "username,name,description,created_at,public_metrics,verified";

export type MentionsResult =
  | { ok: true; mentions: Mention[]; newestId: string | null; nextToken: string | null; resultCount: number; rateRemaining: number | null; rateReset: number | null }
  | { ok: false; status: number | null; reason: string; resetAt?: number };

interface XTweet {
  id: string;
  text?: string;
  author_id?: string;
  conversation_id?: string;
  created_at?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: { type?: string; id?: string }[];
  display_text_range?: [number, number];
  entities?: { mentions?: { username?: string; start?: number; id?: string }[] };
}
interface XUser {
  id: string;
  username?: string;
  name?: string;
  description?: string;
  created_at?: string;
  public_metrics?: { followers_count?: number };
}

/** oldest first by post id (ids are snowflakes: numeric order is time order) */
export const byIdAsc = (a: { id: string }, b: { id: string }): number => {
  const x = BigInt(a.id);
  const y = BigInt(b.id);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** One X mentions response turned into Mentions, oldest first. Pure; the fixture tests read a saved response through it. */
export function mentionsFromResponse(json: { data?: XTweet[]; includes?: { users?: XUser[]; tweets?: XTweet[] } } | null | undefined): Mention[] {
  const users = new Map((json?.includes?.users ?? []).map((u) => [u.id, u] as const));
  const tweets = new Map((json?.includes?.tweets ?? []).map((tw) => [tw.id, tw] as const));
  const out: Mention[] = [];
  for (const tw of json?.data ?? []) {
    if (!tw?.id || !/^\d{1,20}$/.test(tw.id)) continue;
    const u = tw.author_id ? users.get(tw.author_id) : undefined;
    const parentId = tw.referenced_tweets?.find((r) => r.type === "replied_to")?.id;
    const quotedId = tw.referenced_tweets?.find((r) => r.type === "quoted")?.id;
    const parent = parentId ? tweets.get(parentId) : undefined;
    const quoted = quotedId ? tweets.get(quotedId) : undefined;
    const text = String(tw.text ?? "");
    const m: Mention = {
      id: tw.id,
      authorHandle: u?.username ?? "",
      text,
      ...(tw.author_id ? { authorId: tw.author_id } : {}),
      ...(u?.name !== undefined ? { authorName: u.name } : {}),
      ...(u?.description !== undefined ? { authorBio: u.description } : {}),
      ...(u?.created_at ? { authorCreatedAt: u.created_at } : {}),
      ...(typeof u?.public_metrics?.followers_count === "number" ? { authorFollowers: u.public_metrics.followers_count } : {}),
      ...(tw.conversation_id ? { conversationId: tw.conversation_id } : {}),
      ...(tw.created_at ? { createdAt: tw.created_at } : {}),
      ...(tw.in_reply_to_user_id ? { inReplyToUserId: tw.in_reply_to_user_id } : {}),
      ...(parentId ? { parentId } : {}),
      ...(parent?.text !== undefined ? { parentText: parent.text } : {}),
      ...(parent?.author_id ? { parentAuthorId: parent.author_id } : {}),
      ...(quoted?.author_id ? { quotedAuthorId: quoted.author_id } : {}),
      bodyHandles: bodyHandlesOf(text, { displayStart: tw.display_text_range?.[0] ?? null, mentions: tw.entities?.mentions ?? null }),
    };
    const ids = [...new Set((tw.entities?.mentions ?? []).map((e) => String(e?.id ?? "")).filter((id) => /^\d{1,20}$/.test(id)))];
    if (ids.length) m.mentionUserIds = ids;
    out.push(m);
  }
  return out.sort(byIdAsc);
}

/**
 * GET /2/users/{userId}/mentions: one page (max_results 100) newer than `sinceId`, behind the same gate as posting.
 * A failure is { ok: false } with X's status, title and detail (a 429 carries x-rate-limit-reset as resetAt, ms);
 * it is NEVER an empty list, so a caller cannot mistake an outage for a quiet timeline and move its cursor.
 */
export async function getMentions(sinceId: string | null, o: { userId: string; paginationToken?: string | null; maxResults?: number; untilId?: string | null }, deps: XDeps = {}): Promise<MentionsResult> {
  const envObj = deps.env ?? process.env;
  const gate = xGateProblem(talkEnv(envObj));
  if (gate) return { ok: false, status: null, reason: gate };
  const creds = xCredentials(envObj);
  if (!creds) return { ok: false, status: null, reason: "dormant: credentials unreadable" };
  if (!/^\d{1,20}$/.test(o.userId)) return { ok: false, status: null, reason: "mentions: the user id is not an x user id" };
  if (sinceId !== null && !/^\d{1,20}$/.test(sinceId)) return { ok: false, status: null, reason: "mentions: since_id is not an x post id" };
  if (o.untilId && !/^\d{1,20}$/.test(o.untilId)) return { ok: false, status: null, reason: "mentions: until_id is not an x post id" };
  // X takes 5 to 100; the engage loop asks for less when its day's read budget is nearly spent
  const max = Math.min(100, Math.max(5, Math.floor(Number.isFinite(o.maxResults) ? (o.maxResults as number) : 100)));
  const q: [string, string][] = [["max_results", String(max)]];
  if (sinceId) q.push(["since_id", sinceId]);
  if (o.untilId) q.push(["until_id", o.untilId]);
  if (o.paginationToken) q.push(["pagination_token", o.paginationToken]);
  q.push(["tweet.fields", MENTION_TWEET_FIELDS], ["expansions", MENTION_EXPANSIONS], ["user.fields", MENTION_USER_FIELDS]);
  const url = `${X_API_BASE}/2/users/${o.userId}/mentions?${q.map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`).join("&")}`;
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(url, { method: "GET", headers: { authorization: oauthHeader({ method: "GET", url, creds, nonce: deps.nonce?.(), timestamp: Math.floor((deps.now ?? Date.now()) / 1000) }) } });
  } catch (err) {
    return { ok: false, status: null, reason: `x api unreachable: ${(err as Error).name}` };
  }
  const header = (k: string): number | null => {
    const v = Number(res.headers?.get?.(k) ?? NaN);
    return Number.isFinite(v) ? v : null;
  };
  const rateReset = header("x-rate-limit-reset");
  const json = (await res.json().catch(() => ({}))) as { data?: XTweet[]; includes?: { users?: XUser[]; tweets?: XTweet[] }; meta?: { newest_id?: string; next_token?: string; result_count?: number }; title?: string; detail?: string };
  if (!res.ok) return { ok: false, status: res.status, reason: `x api ${res.status}${describeXError(json)}`, ...(res.status === 429 && rateReset !== null ? { resetAt: rateReset * 1000 } : {}) };
  const mentions = mentionsFromResponse(json);
  const newestId = json.meta?.newest_id && /^\d{1,20}$/.test(json.meta.newest_id) ? json.meta.newest_id : (mentions.at(-1)?.id ?? null);
  return { ok: true, mentions, newestId, nextToken: json.meta?.next_token ?? null, resultCount: typeof json.meta?.result_count === "number" ? json.meta.result_count : mentions.length, rateRemaining: header("x-rate-limit-remaining"), rateReset: rateReset === null ? null : rateReset * 1000 };
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
