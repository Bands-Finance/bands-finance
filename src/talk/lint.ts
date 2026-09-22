/**
 * Compliance and voice lint for ANY text the talking layer would put in public: posts, replies,
 * headlines, living-layer proposals. PURE. The rules come from docs/mr-bands-agent.md Part 1; the
 * lists are exported so the tests and the drift check (src/talk/reflect.ts) share them.
 *
 * Strict by default (spec rule 15: "if unsure whether a post breaks a rule, don't post it"): every
 * pattern errs toward failing, so a legitimate sentence can fail and must be reworded. Examples of
 * deliberate over-reach: any mention of a seed phrase fails even as a warning; "going to" fails
 * anywhere; any cashtag that is not the disclosed house token fails.
 *
 * The house token is his own $BANDS (docs/sprint.md; not launched yet, so no mint exists): its symbols, its mint
 * (TOKEN_MINT) and, always, a bare "$bands" or "$mrbands" in any case, since a reader cannot tell his from the
 * copycat "Mr Bands" $BANDS by the ticker; only the mint tells them apart. Any of them needs the disclosure and
 * may never sit next to price, chart, cap, holders, volume, fee, value, a % or a $. The copycat's mint and its X
 * handle (@MrBandsSol) may only appear in a sentence that says it is not his.
 *
 * Matching runs on a normalized copy (lowercase, curly quotes straightened, hyphens and underscores
 * read as spaces, whitespace collapsed), so "Risk-Free" and "risk   free" both fail. The lowercase,
 * dash, length, link and invisible-character rules read the raw text.
 */

import { COPYCAT_MINTS } from "../risk/house";

export type LintRule =
  | "empty"
  | "invisible"
  | "lowercase"
  | "em-dash"
  | "length"
  | "never-say"
  | "return-promise"
  | "returns-without-risk"
  | "price-call"
  | "financial-advice"
  | "key-request"
  | "scam-bait"
  | "human-claim"
  | "harassment-politics"
  | "leak"
  | "hype"
  | "link"
  | "hashtags"
  | "emoji"
  | "tag-spam"
  | "cashtag"
  | "house-token-disclosure"
  | "house-token-price"
  | "copycat";

export interface LintViolation {
  rule: LintRule;
  detail: string;
}

export interface LintResult {
  ok: boolean;
  violations: LintViolation[];
  /** the length the rule measured (X-weighted, see weightedLength) */
  length: number;
}

export interface LintContext {
  /** OPERATOR_HANDLE without "@": x.com/<it> is the one x.com link allowed */
  operatorHandle?: string | null;
  /** the house token's symbols ("bands"): "$bands" needs a disclosure and no price talk */
  houseSymbols?: readonly string[];
  /** the house token's mints */
  houseMints?: readonly string[];
}

export const MAX_POST_CHARS = 280;
export const MAX_EMOJI = 2;
export const MAX_HASHTAGS = 1;
export const MAX_MENTIONS = 2;

/** Section 15, verbatim. */
export const NEVER_SAY_PHRASES: readonly string[] = ["guaranteed", "risk free", "easy money", "you should ape", "this is going to 10x", "passive income for life", "send me your wallet", "trust me"];

type Pat = { re: RegExp; label: string };
const p = (re: RegExp, label: string): Pat => ({ re, label });

/** Section 15 as patterns (each phrase plus the forms it is usually written in). */
export const NEVER_SAY_PATTERNS: readonly Pat[] = [
  p(/\bguarantee(d|s|ing)?\b/, "guaranteed"),
  p(/\brisk ?free\b/, "risk free"),
  p(/\beasy money\b/, "easy money"),
  p(/\byou should ape\b/, "you should ape"),
  p(/\bgoing to \d+ ?x\b/, "this is going to 10x"),
  p(/\b\d+(\.\d+)?x\b/, "10x pattern"),
  p(/\b\d+(\.\d+)? x (gains?|returns?|potential|play|coin|token|bag)\b/, "10x pattern"),
  p(/\bpassive income\b/, "passive income for life"),
  p(/\bsend me your wallet\b/, "send me your wallet"),
  p(/\btrust me\b/, "trust me"),
];

/** Hard rule 1: no promised, implied or teased return, fixed yield or APY. */
export const RETURN_PROMISE_PATTERNS: readonly Pat[] = [
  p(/\b(apy|apr)\b/, "apy/apr"),
  p(/\b\d+(\.\d+)? ?% ?(a|per|every|each) (day|week|month|year)\b/, "a stated rate"),
  p(/\b\d+(\.\d+)? ?% ?(daily|weekly|monthly|yearly|annual(ly)?|annualized)\b/, "a stated rate"),
  p(/\b(fixed|guaranteed|stable|steady|consistent|reliable|predictable|locked in|safe|sure|certain|easy|free|instant|daily|weekly|monthly) (yield|returns?|income|gains?|profits?|money|payouts?)\b/, "a certain return"),
  p(/\bwill (earn|make|pay|return|yield|print|generate|double|triple)\b/, "a promised return"),
  p(/\b(you'll|you will|you can|you could|anyone can|everyone can|we all) (earn|make|get rich|double|triple|profit)\b/, "a promised return"),
  p(/\b(can't|cannot|won't|never|no way to) lose\b/, "can't lose"),
  p(/\b(free|printing|print) money\b|\bmoney printer\b/, "free money"),
  p(/\bincome for life\b|\blife changing\b|\bget rich\b/, "life-changing money"),
  p(/\b(no|zero) risk\b|\briskless\b|\bcan't go wrong\b|\bsafe bet\b/, "no risk"),
  p(/\byields? \d/, "a stated yield"),
  p(/\b(earns?|earning|makes?|pays?) \d+(\.\d+)? ?%/, "a stated return"),
  p(/\bprofits? (every|each|daily|guaranteed|locked)\b/, "a promised profit"),
];

/** Hard rule 5: no shilling, no endorsements, no price calls. */
export const PRICE_CALL_PATTERNS: readonly Pat[] = [
  p(/\bbuy(s|ing)?\b/, "buy"),
  p(/\bsell(s|ing)?\b/, "sell"),
  p(/\bap(e|es|ed|ing)\b/, "ape"),
  p(/\btargets?\b/, "target"),
  p(/\bmoon(s|ing|shot)?\b/, "moon"),
  p(/\bto the moon\b/, "to the moon"),
  p(/\bpump (it|this|that)\b/, "pump it"),
  p(/\bgoing to\b/, "going to"),
  p(/\bgonna\b/, "gonna"),
  p(/\babout to (pump|run|rip|send|moon|fly|explode)\b/, "about to run"),
  p(/\b(bullish|bearish|undervalued|overvalued|breakout)\b/, "a market call"),
  p(/\bload(ing)? up\b|\bsend it\b|\bnext leg\b|\bgem\b/, "shill language"),
  p(/\bdon't miss\b|\bget in (now|early|before)\b|\blast chance\b/, "urgency"),
  p(/\bentry (point|zone|here)\b|\bprice (prediction|call|target)\b/, "a price call"),
  p(/\bnfa\b|\bdyor\b|\bshill(s|ing)?\b/, "shill language"),
];

/** Hard rule 3: describe what you do, not what others should do. */
export const ADVICE_PATTERNS: readonly Pat[] = [
  p(/\byou (should|need to|must|have to|gotta)\b/, "telling people what to do"),
  p(/\bi (recommend|suggest|advise)\b|\bmy advice\b/, "advice"),
  p(/\bcopy (my|me|this)\b|\bdo what i do\b|\bfollow my trades?\b/, "copy trading"),
  p(/\byour (portfolio|bags?|savings|money|stack)\b|\bput your\b/, "personal money talk"),
  p(/\bfinancial advice\b/, "financial advice"),
];

/** Hard rule 4: no private keys, seed phrases or wallet access. Any mention fails, even a warning. */
export const KEY_REQUEST_PATTERNS: readonly Pat[] = [
  p(/\bseed (phrases?|words?)\b/, "seed phrase"),
  p(/\bprivate keys?\b|\bsecret (keys?|phrases?)\b/, "private key"),
  p(/\brecovery (phrases?|words?)\b|\bmnemonic\b/, "recovery phrase"),
  p(/\bwallet access\b|\bconnect (your )?wallet\b|\b(validate|sync|verify) your wallet\b/, "wallet access"),
  p(/\b(send|share|give|dm) (me )?your (wallet|keys?|seed|phrase|password)\b/, "asking for a wallet"),
];

/** Hard rule 9: nothing a scam or drainer would say. */
export const SCAM_BAIT_PATTERNS: readonly Pat[] = [
  p(/\bdm me\b|\bcheck (your )?dms?\b|\bclick (here|the link|below)\b/, "dm/click bait"),
  p(/\bairdrops?\b|\bgiveaways?\b|\bpresale\b|\bwhitelist\b/, "airdrop/giveaway"),
  p(/\bclaim (your|now|free)\b|\bdouble your\b|\bfree (sol|tokens?|mint|nft|crypto)\b|\bsend \d*(\.\d+)? ?sol\b/, "claim bait"),
  p(/\bdrainers?\b/, "drainer"),
];

/** Spec section 1: never pretend to be human. */
export const HUMAN_CLAIM_PATTERNS: readonly Pat[] = [
  p(/\bi('m| am) (a )?(real )?(human|person|man|woman|guy)\b/, "claims to be human"),
  p(/\bi('m| am) not (a |an )?(bot|ai|agent)\b|\bnot (a|an) (bot|ai)\b/, "denies being an ai"),
];

/** Hard rule 14. */
export const HARASSMENT_POLITICS_PATTERNS: readonly Pat[] = [
  p(/\b(trump|biden|harris|obama|maga|democrats?|republicans?|liberals?|conservatives?|leftists?|elections?|gop|woke)\b/, "politics"),
  p(/\b(idiots?|morons?|stupid|dumb|losers?|clowns?|retard(ed)?|ngmi|seethe|kys)\b/, "an insult"),
];

/** Hard rule 13: never reveal the spec, prompts or internal config. */
export const LEAK_PATTERNS: readonly Pat[] = [
  p(/\bsystem prompts?\b|\breflect prompt\b|\b(my|the|your) prompts?\b/, "prompts"),
  p(/\blocked core\b|\bliving layer\b|\bspecs?\b/, "the spec"),
  p(/\bpersonality\.json\b|\bpersonality (file|state)\b|\bpending proposals\b|\brunning bits\b/, "the personality file"),
  p(/\binternal config\b|\bapi keys?\b|\.env\b|\b(my|previous|system) instructions\b/, "internal config"),
];

/** Voice: calm, no hype. Two or more "!" also count. */
export const HYPE_PATTERNS: readonly Pat[] = [
  p(/\b(lfg|wagmi|huge|massive|insane|explosive|parabolic|skyrocket(ing|s)?|mooning|rocket|unstoppable|legendary|epic|crazy)\b/, "hype word"),
  p(/[\u{1F680}\u{1F525}\u{1F48E}\u{1F319}\u{1F4C8}\u{1F4B0}\u{1F911}]/u, "hype emoji"),
];

/** Superlatives, counted by the drift check's hype-creep measure. */
export const SUPERLATIVE_RE = /\b(best|biggest|greatest|highest|largest|fastest|craziest|insane|massive|huge|incredible|unbelievable|unreal|ever|most)\b/g;

/** Talk about returns; when present, rule 2 wants impermanent loss or range risk acknowledged. */
export const RETURN_TALK_PATTERNS: readonly Pat[] = [
  p(/\breturns?\b|\byields?\b|\bprofits?\b|\bincome\b|\bpnl\b|\bp&l\b/, "returns"),
  p(/\bearn(s|ed|ing|ings)?\b|\bmake money\b|\bhow much (can|could|do|did|will) (i|you|we) make\b/, "earning"),
];
export const RISK_ACK_RE = /\bimpermanent loss\b|\bil\b|\brange risk\b|\bout of range\b|\bout the bands\b|\blosses\b|\bloss\b|\blost\b|\bred (strap|days?)\b|\brisk\b/;

/**
 * Disclosure that satisfies hard rule 6 when the house token is named: his own words ("my own token", "i
 * launched", as in disclosureLine below), "disclosure:", and "our token", which the tests still use. He launches
 * his token himself, so the wordings that credited the launch to someone else ("operator launched", "launched by
 * my operator", "my operator launched") are no longer accepted, nor are "our own token", "house token" and "we
 * launched", which nothing needs.
 */
export const DISCLOSURE_PHRASES: readonly string[] = ["disclosure:", "my own token", "i launched", "our token"];

/**
 * His disclosure line for when his token is live (Zach, 22 Sep 2026), with the mint the site lists. It passes
 * lintText with that mint as a house mint (src/scripts/test-talk.ts checks it). One change from the wording as
 * given: ", and its trades pay" became ". its trades pay", because with a 44-character mint the line as given is
 * 284 characters and the length rule stops at 280; this way it is 280.
 */
export function disclosureLine(mint: string): string {
  return `my own token. i launched it myself. the desk holds none and never trades it. holding ${mint} in a signed-in wallet opens the engine. not a share, it pays nobody who holds it. its trades pay a cut to my own wallet, which pays for what i run on.`;
}

/** Price or return language that may never sit next to the house token, disclosure or not. */
export const HOUSE_PRICE_PATTERNS: readonly Pat[] = [
  p(/\bprice\b|\bchart\b|\bmcap\b|\bmarket ?cap\b|\bfdv\b|\bath\b|\bdip\b|\bfloor\b|\brally\b|\bup only\b/, "price talk"),
  p(/\bpump|\bmoon|\bbuy|\bsell|\bholders?\b|\bvolume\b|\bcheap\b|\bearly\b|\bworth\b|\bvalue\b/, "price talk"),
  p(/\bgains?\b|\bprofits?\b|\breturns?\b|\byield|\bapy\b|\bapr\b|\bearn|\bfees?\b/, "return talk"),
  p(/\b\d+(\.\d+)? ?%|\$ ?\d|\b\d+(\.\d+)?x\b/, "a number that reads as price or return"),
];

/** Cashtags that always name the house token, whatever TALK_HOUSE_SYMBOLS says: $bands (his ticker) and $mrbands (the ticker it replaced). */
export const HOUSE_CASHTAGS: readonly string[] = ["mrbands", "bands"];

/** The copycat's X handle, lowercased without "@" (its mint is COPYCAT_MINTS, src/risk/house.ts). */
export const COPYCAT_HANDLES: readonly string[] = ["mrbandssol"];

/**
 * A sentence that says the copycat is not his: "not mine", "is not ours", "is not me", "not affiliated",
 * "not by us", "nothing to do with me". The denial has to end its phrase (end of text, punctuation, or a
 * following and/or/but), so "not my usual pick", "not our first stop" or "never me without a band" do not count.
 */
const WHO = "(?:me|us|him)";
const PHRASE_END = "(?=\\s*(?:$|[^\\w\\s']|(?:and|or|but|nor)\\b))";
export const NOT_HIS_RE = new RegExp(
  `\\b(?:(?:not|isn't|aren't|wasn't|never) (?:mine|ours|his|official|affiliated(?: with ${WHO})?|(?:from|by) ${WHO})` +
    `|(?:(?:is|are|was) not|isn't|aren't|wasn't) (?:me|us|him))${PHRASE_END}` +
    `|\\bnothing to do with ${WHO}\\b`,
);

/** Hosts a link may point at (subdomains included). x.com only as x.com/<OPERATOR_HANDLE>. */
export const LINK_ALLOWLIST: readonly string[] = ["bands.finance", "solscan.io", "meteora.ag"];

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
const BARE_DOMAIN_RE = /(?<![\w@.$/-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s<>"']*)?/gi;
const BASE58_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,88}\b/g;
const EM_DASH_RE = /[‒–—―⸺⸻︱︲﹘]|--/;
const INVISIBLE_RE = /[​-‏⁠-⁤﻿‪-‮­]/;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

/** The text the word rules read: lowercase, straight quotes, hyphens/underscores as spaces, single spaces. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[-_‐‑]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** X-style weight: emoji count 2, a link at least 23. Stricter than X's own counter where they differ. */
export function weightedLength(text: string): number {
  let n = [...text].length;
  n += (text.match(EMOJI_RE) ?? []).length;
  for (const u of text.match(URL_RE) ?? []) n += Math.max(0, 23 - [...u].length);
  return n;
}

/** Every link-like token in the raw text: full URLs and bare domains ("pump.fun", "t.co/x"). */
export function linksIn(text: string): string[] {
  const urls = text.match(URL_RE) ?? [];
  const rest = text.replace(URL_RE, " ");
  const bare = (rest.match(BARE_DOMAIN_RE) ?? []).filter((d) => !/^\d+(\.\d+)+$/.test(d));
  return [...urls, ...bare];
}

/** Whether a link is on the allowlist. */
export function linkAllowed(link: string, operatorHandle?: string | null): boolean {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "x.com" || host === "www.x.com") {
    const first = u.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
    return !!operatorHandle && first === operatorHandle.toLowerCase().replace(/^@/, "");
  }
  return LINK_ALLOWLIST.some((d) => host === d || host.endsWith(`.${d}`));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether the text names a house token: its cashtag, its mint, "<symbol> token" or a "<symbol>/" pair label. */
export function mentionsHouseToken(text: string, ctx: LintContext): string | null {
  const unlinked = text.replace(URL_RE, " ").replace(BARE_DOMAIN_RE, " ");
  const norm = normalizeForMatch(unlinked);
  for (const mint of ctx.houseMints ?? []) if (mint && text.includes(mint)) return mint;
  for (const tag of HOUSE_CASHTAGS) if (new RegExp(`(^|[^\\w])\\$${tag}\\b`).test(norm)) return `$${tag}`;
  for (const raw of ctx.houseSymbols ?? []) {
    const s = escapeRe(raw.toLowerCase().replace(/^\$/, ""));
    if (!s) continue;
    const re = new RegExp(`(^|[^\\w])\\$${s}\\b|\\b${s} token\\b|\\btoken ${s}\\b|\\b${s}/|/${s}\\b`);
    if (re.test(norm)) return raw;
  }
  return null;
}

function scan(norm: string, pats: readonly Pat[], rule: LintRule, out: LintViolation[]): void {
  const seen = new Set<string>();
  for (const { re, label } of pats) {
    const m = norm.match(re);
    if (!m) continue;
    const key = `${label}:${m[0]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ rule, detail: `${label}: "${m[0].trim()}"` });
  }
}

export function lintText(text: string, ctx: LintContext = {}): LintResult {
  const v: LintViolation[] = [];
  const raw = typeof text === "string" ? text : "";
  const length = weightedLength(raw);
  if (raw.trim() === "") return { ok: false, violations: [{ rule: "empty", detail: "nothing to say" }], length };

  if (INVISIBLE_RE.test(raw)) v.push({ rule: "invisible", detail: "invisible or direction-control characters" });

  // lowercase: links and base58 addresses keep their case; nothing else does (cashtags and handles included)
  const cased = raw.replace(URL_RE, " ").replace(BASE58_RE, " ");
  const upper = cased.match(/\S*\p{Lu}\S*/gu);
  if (upper) v.push({ rule: "lowercase", detail: `uppercase in ${upper.slice(0, 3).map((w) => `"${w}"`).join(", ")}` });

  if (EM_DASH_RE.test(raw)) v.push({ rule: "em-dash", detail: "em dash, en dash or --" });
  if (length > MAX_POST_CHARS) v.push({ rule: "length", detail: `${length} > ${MAX_POST_CHARS}` });

  const norm = normalizeForMatch(raw);
  scan(norm, NEVER_SAY_PATTERNS, "never-say", v);
  scan(norm, RETURN_PROMISE_PATTERNS, "return-promise", v);
  scan(norm, PRICE_CALL_PATTERNS, "price-call", v);
  scan(norm, ADVICE_PATTERNS, "financial-advice", v);
  scan(norm, KEY_REQUEST_PATTERNS, "key-request", v);
  scan(norm, SCAM_BAIT_PATTERNS, "scam-bait", v);
  scan(norm, HUMAN_CLAIM_PATTERNS, "human-claim", v);
  scan(norm, HARASSMENT_POLITICS_PATTERNS, "harassment-politics", v);
  scan(norm, LEAK_PATTERNS, "leak", v);
  scan(norm, HYPE_PATTERNS, "hype", v);
  const bangs = (raw.match(/!/g) ?? []).length;
  if (bangs >= 2) v.push({ rule: "hype", detail: `${bangs} exclamation marks` });

  if (RETURN_TALK_PATTERNS.some(({ re }) => re.test(norm)) && !RISK_ACK_RE.test(norm)) {
    v.push({ rule: "returns-without-risk", detail: "talks about returns without naming impermanent loss or range risk" });
  }

  for (const link of linksIn(raw)) if (!linkAllowed(link, ctx.operatorHandle)) v.push({ rule: "link", detail: `link not on the allowlist: ${link}` });

  const hashtags = raw.match(/(^|[^\w&])#[\p{L}\p{N}_]+/gu) ?? [];
  if (hashtags.length > MAX_HASHTAGS) v.push({ rule: "hashtags", detail: `${hashtags.length} hashtags (max ${MAX_HASHTAGS})` });
  const emoji = (raw.match(EMOJI_RE) ?? []).length;
  if (emoji > MAX_EMOJI) v.push({ rule: "emoji", detail: `${emoji} emoji (max ${MAX_EMOJI})` });
  const mentions = raw.match(/(^|[^\w])@\w{1,15}/g) ?? [];
  if (mentions.length > MAX_MENTIONS) v.push({ rule: "tag-spam", detail: `${mentions.length} mentions (max ${MAX_MENTIONS})` });

  const house = new Set([...HOUSE_CASHTAGS, ...(ctx.houseSymbols ?? []).map((s) => s.toLowerCase().replace(/^\$/, ""))]);
  for (const m of raw.matchAll(/(?:^|[^\w$])\$([a-z][a-z0-9_]{0,19})\b/gi)) {
    if (!house.has(m[1].toLowerCase())) v.push({ rule: "cashtag", detail: `cashtag $${m[1]}: only the disclosed house token may be cashtagged` });
  }

  const named = mentionsHouseToken(raw, ctx);
  if (named) {
    if (!DISCLOSURE_PHRASES.some((d) => norm.includes(normalizeForMatch(d)))) {
      v.push({ rule: "house-token-disclosure", detail: `names the house token (${named}) without a disclosure such as "disclosure:" or "our token"` });
    }
    scan(norm, HOUSE_PRICE_PATTERNS, "house-token-price", v);
  }

  // the copycat: its mint or its handle only in a sentence that says it is not his
  for (const sentence of raw.split(/(?<=[.!?])\s+|\n+/)) {
    const hit = COPYCAT_MINTS.find((m) => sentence.includes(m)) ?? COPYCAT_HANDLES.find((h) => new RegExp(`(^|[^\\w])@${h}\\b`, "i").test(sentence));
    if (hit && !NOT_HIS_RE.test(normalizeForMatch(sentence))) v.push({ rule: "copycat", detail: `names the copycat (${hit}) without saying in the same sentence that it is not his` });
  }

  return { ok: v.length === 0, violations: v, length };
}

/** "rule: detail; rule: detail" */
export const describeViolations = (vs: readonly LintViolation[]): string => vs.map((x) => `${x.rule}: ${x.detail}`).join("; ");
