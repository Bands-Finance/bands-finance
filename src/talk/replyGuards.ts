/**
 * The reply guards, PURE: the model proposes, these decide. Every check REFUSES and none rewrites (Merd's cleanReply,
 * stripDashes and stripSelfEcho are not ported: a text that needs cleaning is a text that does not go out). The
 * engage loop (src/talk/engage.ts) runs vetReply on every reply text, template or model, before postReply; postTweet
 * then runs the lint again.
 *
 *   vetReply(text, ctx)       null, or the first rule the text breaks. Pinned to Merd's leaks (docs/talk.md, "Engage"):
 *                             "**@ponsdotfamily, SKIP**", "i should keep the reply warm but low-key", "i'll skip this
 *                             one", a "> migrating live treasuries" blockquote, a reply ending in "fucking", 23
 *                             variants of one thank-you, and a bot's "you're early, not late" coming back out
 *   classifyMention           the three kinds he answers: a reply to his post, a post that names him in its body,
 *                             a quote of his post; anything else (his handle only in an inherited reply prefix) is null
 *   optOutIn                  "stop", "unsubscribe", "leave me alone" and similar, outside stop-loss and friends
 *   isHollow / isFarm         a reply-worthy thought, or three words of praise; a fresh account with no followers
 *   looksLikeBot / massTag    a bot by handle or bio; more than 3 other handles in the body
 *
 * Mention text here is DATA: it is compared against, never obeyed.
 */
import { COPYCAT_MINTS } from "../risk/house";
import { markersIn, meaningfulWords, selfEcho, tooSimilar, type RecentText } from "./guards";
import { linksIn, lintText, describeViolations, normalizeForMatch, weightedLength, NOT_HIS_RE, type LintContext } from "./lint";
import { blockedWordsIn } from "./wordguard";
import { bodyHandlesOf, type Mention } from "./x";

/** his own X user id (@MrBandsSol) */
export const SELF_USER_ID = "2099900363679633408";
/** a model's reply stays under this (X-weighted); a template may use the whole post */
export const MODEL_REPLY_MAX = 200;
export const TEMPLATE_REPLY_MAX = 280;
/** his own replies compared against, and the overlap that refuses: 0.85 (the loop's) let Merd's 23 thank-yous through */
export const REPLY_SIMILARITY_MAX = 0.5;
export const RECENT_REPLIES = 50;

export type ReplySource = "model" | "template";
export type MentionKind = "reply-to-mine" | "named" | "quote";

export interface VetContext {
  /** the mention and its parent: DATA, for the echo rule */
  mention: { text: string; parentText?: string | null };
  source: ReplySource;
  /** his recent reply texts (the last 50) */
  recentReplies: readonly (string | RecentText)[];
  /** the numbers the facts block carries (REPLY_FACTS_NUMBERS); a model reply may hold no other */
  allowedNumbers: readonly string[];
  /** TOKEN_MINT, or null before launch */
  tokenMint: string | null;
  /** the lint's context (operator handle, house symbols and mints) */
  lint?: LintContext;
}

export interface VetRefusal {
  rule: string;
  detail: string;
}

const refuse = (rule: string, detail: string): VetRefusal => ({ rule, detail });

/** Merd's leak markers beyond guards.markersIn: each one reached his timeline or his reply log */
const EXTRA_MARKERS: readonly { re: RegExp; label: string }[] = [
  { re: /^\s*>/m, label: 'a ">" blockquote line' },
  { re: /\bdecision\s*:/i, label: 'a "decision:" label' },
  { re: /\bto @\w{1,15}\s*:/i, label: 'a "to @x:" label' },
  { re: /@\w{1,15}\s*,\s*skip\b/i, label: 'a "@x, skip" line' },
  { re: /`/, label: "a backtick or code fence" },
  { re: /[{}]/, label: "a JSON brace" },
  { re: /"\s*(reply|skip|mention)\s*"/i, label: "a JSON key" },
  { re: /\(for the @/i, label: 'a "(for the @" note' },
  { re: /say the word and i'?ll draft/i, label: '"say the word and i\'ll draft"' },
];

/** skip and planning narration, anywhere in the text (Merd's isSkip read the first 140 characters and caught 0 of 21) */
export const NARRATION_RE =
  /i'?ll skip|skipping|skip this|no reply|not replying|i'?ll pass|nothing (useful )?to add|falls under|i should (keep|reply|say)|the reply|this (post|tweet|mention|reply) (is|reads|looks)|reads as|no pitch|draft|as an ai language model/;

/** token topics are template-only: a model never talks about a token, a mint or a launch */
export const TOKEN_TOPIC_RE = /\b(tokens?|mints?|ticker|ca|contract( address)?|pump(fun)?|airdrops?|presale|mcap|market cap|holders?|early)\b/;
/** pitching: he never sells the engine or asks anyone to act */
export const PITCH_RE = /\b(sign up|signup|check (it |this |me )?out|join|try the engine|dm me|dms)\b/;
/** his book: any of these needs the word "paper" beside it */
export const BOOK_RE = /\b(my book|the book|positions?|seats?|fees?|net|pnl|p&l|sol|range|(open|opened|opening|close|closed|closing) (a |the |my )?bands?|bands? (opened|closed))\b/;
const BASE58_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const HANDLE_RE = /@(\w{1,15})/g;
const CASHTAG_RE = /\$([a-z][a-z0-9_]{0,19})\b/gi;

/** words for the echo rule: lowercase, curly quotes straightened, anything but letters and digits a break ("you're" is two words) */
const echoWords = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

function runsOf(words: readonly string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

/** The sentence around an index (for the copycat denial). */
function sentenceAt(text: string, index: number): string {
  const before = text.slice(0, index);
  const start = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("\n")) + 1;
  const rest = text.slice(index);
  const endRel = rest.search(/[.!?\n](\s|$)/);
  return text.slice(start, endRel < 0 ? text.length : index + endRel + 1);
}

/** Why a reply text must not go out, or null. Refuses; never rewrites. */
export function vetReply(text: string, ctx: VetContext): VetRefusal | null {
  const raw = typeof text === "string" ? text : "";
  // 1. shape
  if (raw.trim() === "") return refuse("empty", "nothing to say");
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  if (lines.length > 2) return refuse("lines", `${lines.length} lines (max 2)`);
  const cap = ctx.source === "model" ? MODEL_REPLY_MAX : TEMPLATE_REPLY_MAX;
  const len = weightedLength(raw);
  if (len > cap) return refuse("length", `${len} > ${cap}`);
  // 2. leak markers
  const marker = markersIn(raw);
  if (marker) return refuse("markers", marker);
  for (const { re, label } of EXTRA_MARKERS) if (re.test(raw)) return refuse("markers", label);
  // 3. narration, anywhere
  const norm = normalizeForMatch(raw);
  const narr = norm.match(NARRATION_RE);
  if (narr) return refuse("narration", `"${narr[0]}"`);
  // 4. no @, # or $; no link of any kind (a link costs $0.20 and no reply needs one)
  if (/^\s*@/.test(raw)) return refuse("tag", "starts with @");
  const sym = raw.match(/[@#$]/);
  if (sym) return refuse("tag", `"${sym[0]}" in a reply`);
  const links = linksIn(raw);
  if (links.length) return refuse("link", `a link: ${links[0]}`);
  // 5. blocked words
  const blocked = blockedWordsIn(raw);
  if (blocked.length) return refuse("blocked-word", blocked.join(", "));
  // 6. the lint
  const lint = lintText(raw, ctx.lint ?? {});
  if (!lint.ok) return refuse("lint", describeViolations(lint.violations));
  // 7. an answer returned twice
  const echo = selfEcho(raw);
  if (echo) return refuse("self-echo", `"${echo.slice(0, 60)}"`);
  // 8. the mention's words, handles, cashtags, addresses and links never come back out
  const exemptAddr = new Set<string>([...COPYCAT_MINTS, ...(ctx.tokenMint ? [ctx.tokenMint] : [])]);
  const lower = raw.toLowerCase();
  for (const src of [ctx.mention.text, ctx.mention.parentText ?? ""]) {
    if (!src) continue;
    for (const l of linksIn(src)) if (lower.includes(l.toLowerCase())) return refuse("echo", `repeats a link from the mention`);
    for (const m of src.matchAll(HANDLE_RE)) if (new RegExp(`(^|[^\\w])${m[1]}\\b`, "i").test(raw)) return refuse("echo", `repeats a handle from the mention`);
    for (const m of src.matchAll(CASHTAG_RE)) if (new RegExp(`(^|[^\\w])${m[1]}\\b`, "i").test(raw)) return refuse("echo", `repeats a cashtag from the mention`);
    for (const a of src.match(BASE58_RE) ?? []) if (!exemptAddr.has(a) && raw.includes(a)) return refuse("echo", "repeats an address from the mention");
    const theirs = runsOf(echoWords(src), 5);
    for (const run of runsOf(echoWords(raw), 5)) if (theirs.has(run)) return refuse("echo", `shares "${run}" with the mention`);
  }
  // 9. addresses: only his own mint, or the copycat's in a sentence that says it is not his
  for (const m of raw.matchAll(BASE58_RE)) {
    const a = m[0];
    if (ctx.tokenMint && a === ctx.tokenMint) continue;
    if (COPYCAT_MINTS.includes(a) && NOT_HIS_RE.test(normalizeForMatch(sentenceAt(raw, m.index ?? 0)))) continue;
    return refuse("address", `an address that is not his mint: ${a.slice(0, 8)}`);
  }
  // 10. what only a template may say
  if (ctx.source === "model") {
    const tok = norm.match(TOKEN_TOPIC_RE);
    if (tok) return refuse("token-topic", `"${tok[0]}": token topics are template-only`);
    const allowed = new Set(ctx.allowedNumbers.map((n) => String(n)));
    for (const n of raw.match(/\d+(?:[.,]\d+)*/g) ?? []) if (!allowed.has(n)) return refuse("number", `"${n}" is not in the facts`);
    const pitch = norm.match(PITCH_RE);
    if (pitch) return refuse("pitch", `"${pitch[0]}"`);
  }
  // 11. his book is paper, and says so
  const book = norm.match(BOOK_RE);
  if (book && !/\bpaper\b/.test(norm)) return refuse("paper", `talks about the book ("${book[0]}") without "paper"`);
  // 12. never the same answer twice
  const recent = ctx.recentReplies.slice(-RECENT_REPLIES).map((r, i) => (typeof r === "string" ? { at: i, text: r } : r));
  const similar = tooSimilar(raw, recent, REPLY_SIMILARITY_MAX);
  if (similar) return refuse("similar", `${similar.score.toFixed(2)} overlap with "${similar.hit.text.slice(0, 60)}"`);
  return null;
}

// ---------------------------------------------------------------- the mention

/** The kind of mention he answers, or null (himself, or his handle carried only by another conversation's reply prefix). */
export function classifyMention(m: Mention, selfId: string, selfHandle: string | null): MentionKind | null {
  if (m.authorId && m.authorId === selfId) return null;
  const self = (selfHandle ?? "").toLowerCase().replace(/^@/, "");
  if (self && m.authorHandle.toLowerCase().replace(/^@/, "") === self) return null;
  if (m.quotedAuthorId && m.quotedAuthorId === selfId) return "quote";
  if (m.inReplyToUserId && m.inReplyToUserId === selfId) return "reply-to-mine";
  const body = m.bodyHandles ?? bodyHandlesOf(m.text);
  if (self && body.includes(self)) return "named";
  return null;
}

const OPT_OUT_RE = /\b(stop( (replying|tagging|messaging|it|pls|please))?|unsubscribe|opt ?out|don'?t (reply|respond|tag|mention|@)|leave me alone|go away|mute)\b/;
const NOT_OPT_OUT_RE = /\bstop ?loss(es)?\b|\bnon ?stop\b|\bunstoppable\b/g;

/** Whether a mention asks him to stop: the account is opted out for good, with no reply ("if a user says stop, stop"). */
export function optOutIn(text: string): boolean {
  const norm = normalizeForMatch(String(text ?? "").replace(/@\w{1,15}/g, " ")).replace(NOT_OPT_OUT_RE, " ");
  return OPT_OUT_RE.test(norm);
}

/** a named topic makes a short mention a real one ("paper first?" is not hollow) */
const TOPIC_RE = /\b(liquidity|dlmm|meteora|bands?|range|fees?|impermanent|paper|seats?|pools?|lp|vetoes|veto|guards?|desk|engine|strap|bins?)\b/;

/** Three meaningful words or fewer, no question and no named topic: "this feels massive", "nice innovation", "big bags only". */
export function isHollow(text: string): boolean {
  const body = String(text ?? "").replace(/@\w{1,15}/g, " ");
  const noLinks = linksIn(body).reduce((acc, l) => acc.replace(l, " "), body);
  if (noLinks.includes("?")) return false;
  if (TOPIC_RE.test(normalizeForMatch(noLinks))) return false;
  return meaningfulWords(noLinks).size <= 3;
}

/** accounts he never answers, whatever they say: they answer every mention of him, and he would answer back */
export const BOT_DENY_HANDLES: readonly string[] = ["clawpumptech"];
const BOT_BIO_RE = /\b(bot|automated|ai agent|agent|autonomous|auto-?reply)\b/i;

/** A bot by the deny lists or by its own bio: no bot-to-bot loops. */
export function looksLikeBot(u: { handle: string; bio?: string | null }, extraDeny: readonly string[] = []): string | null {
  const h = u.handle.toLowerCase().replace(/^@/, "");
  if (BOT_DENY_HANDLES.includes(h)) return `@${h} is on the bot deny list`;
  if (extraDeny.includes(h)) return `@${h} is on ENGAGE_DENY_HANDLES`;
  if (u.bio && BOT_BIO_RE.test(u.bio)) return `@${h}'s bio reads as a bot`;
  return null;
}

export const FARM_MAX_AGE_DAYS = 30;
export const FARM_MAX_FOLLOWERS = 20;

/** A fresh account with almost no followers: its praise is skipped. Needs both fields; unknown is not a farm. */
export function isFarm(u: { createdAt?: string | null; followers?: number | null }, now: number): boolean {
  const created = u.createdAt ? Date.parse(u.createdAt) : NaN;
  if (!Number.isFinite(created) || typeof u.followers !== "number") return false;
  return now - created < FARM_MAX_AGE_DAYS * 86400e3 && u.followers < FARM_MAX_FOLLOWERS;
}

/** More than 3 other handles in the body: a tag list, not a conversation. */
export function massTag(m: Mention, selfHandle: string | null): boolean {
  const self = (selfHandle ?? "").toLowerCase();
  const body = m.bodyHandles ?? bodyHandlesOf(m.text);
  return body.filter((h) => h !== self).length > 3;
}
