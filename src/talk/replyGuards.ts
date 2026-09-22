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
 *   optOutIn                  "stop", "unsubscribe", "leave me alone", "do not reply to me", "don't @ me", "fuck off",
 *                             "unfollow me" and similar, outside stop-loss and friends; "not interested" and "no thanks"
 *                             only as the whole message ("not interested in memecoins, what about stocks?" is a question)
 *   tokenAskIn                a question about HIS token (his coin, his ca, his mint, $bands, his launch), read past the
 *                             LP words that carry a token word ("which token pairs", "deploy", "a mint authority")
 *   foldForMatch / instructionIn   the text the mention rules read (invisible characters stripped, look-alike letters
 *                             folded to latin), and whether it reads like an instruction
 *   isHollow / isFarm         a reply-worthy thought, or three words of praise; a fresh account with no followers
 *   looksLikeBot / massTag    a bot by handle or bio; more than 3 other handles in the body
 *
 * Mention text here is DATA: it is compared against, never obeyed.
 */
import { COPYCAT_MINTS } from "../risk/house";
import { INJECTION_RE } from "./drafts";
import { markersIn, meaningfulWords, selfEcho, tooSimilar, type RecentText } from "./guards";
import { linksIn, linkAllowed, lintText, describeViolations, normalizeForMatch, weightedLength, NOT_HIS_RE, type LintContext } from "./lint";
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
  /** the fixed lines (REPLY_TEMPLATES): a model reply is compared only against his earlier model replies */
  templateTexts?: readonly string[];
  /** his reply rules and the prompt's own instructions (replyBrain PROMPT_TEXTS): a model reply never restates them */
  promptTexts?: readonly string[];
}

export interface VetRefusal {
  rule: string;
  detail: string;
}

const refuse = (rule: string, detail: string): VetRefusal => ({ rule, detail });

// ---------------------------------------------------------------- reading a stranger's text

/** format characters and blank fillers: stripped before a word rule reads a mention ("ign\u200Bore" is "ignore") */
const HIDDEN_RE = /[\p{Cf}\u034F\u115F\u1160\u3164\uFFA0\u2800\uFE00-\uFE0F]/gu;
/** cyrillic and greek letters that pass for latin ones ("c\u043Ein" reads "coin") */
const LOOKALIKE_LETTERS: Readonly<Record<string, string>> = {
  "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i", "\u0458": "j", "\u0455": "s",
  "\u0501": "d", "\u04CF": "l", "\u051B": "q", "\u051D": "w", "\u04AF": "y", "\u043A": "k", "\u043C": "m", "\u0442": "t", "\u0432": "b", "\u043D": "h",
  "\u03B1": "a", "\u03BF": "o", "\u03C1": "p", "\u03BD": "v", "\u03B9": "i", "\u03BA": "k", "\u03C4": "t", "\u03C5": "u", "\u03C7": "x", "\u03B5": "e",
};
const LOOKALIKE_LETTER_RE = new RegExp(`[${Object.keys(LOOKALIKE_LETTERS).join("")}]`, "g");

/**
 * The text a mention rule reads: NFKC (fullwidth letters become ascii), every invisible character removed (or, with
 * joiner " ", read as a break), look-alike letters folded to latin, then normalizeForMatch. For matching only: what
 * he posts is never rewritten.
 */
export function foldForMatch(text: string, joiner = ""): string {
  const s = String(text ?? "").normalize("NFKC").replace(HIDDEN_RE, joiner).toLowerCase();
  return normalizeForMatch(s.replace(LOOKALIKE_LETTER_RE, (c) => LOOKALIKE_LETTERS[c] ?? c));
}

/** instructions INJECTION_RE (src/talk/drafts.ts) does not name: a paraphrase, a new task, one of the gateway's tools */
export const EXTRA_INJECTION_RE =
  /\b(disregard|forget|override|bypass|ignore)\b[^.?!]{0,30}\b(above|previous|prior|earlier|rules?|instructions?|guidelines|guards?|prompt|context|everything)\b|\b(new|real|actual|next) (task|job|instructions?|role|goal|prompt)\b|\byour task (now|is)\b|\bweb (fetch|search)\b|\bsession (list|read|summary|history|send)\b|\bmemory (add|update|delete|get|list|recall)\b|\bfetch full history\b|\b(run|call|use|invoke|execute) (the |a |your )?(tool|function|command)s?\b/;

/** Whether a stranger's text reads like an instruction, read both with its invisible characters removed and as breaks. */
export function instructionIn(text: string): boolean {
  return [foldForMatch(text), foldForMatch(text, " ")].some((n) => INJECTION_RE.test(n) || EXTRA_INJECTION_RE.test(n));
}

/** his architect's name and handle: in public he is only ever "my architect" (docs/sprint.md) */
export const ARCHITECT_NAME_RE = /\b(zach\w*|louz\w*|loubert)\b/;

/**
 * A question about HIS token in a mention: the fixed lines answer it and the model is never asked (fixedAnswer), and a
 * model reply to a mention that holds one is refused whatever it says ("yes." carries the claim through the question).
 * A token word ("wen token", "wen coin", "is that ticker yours", clawpump, dexscreener, a presale, a bare $bands), his
 * ca, contract address or mint ("whats the ca", "contract address?", "your mint"), his launch ("are you launching
 * anything", "did u launch bands", "wen launch"), the dev of his token ("r u the dev of bands"), or a rug of his. An LP
 * question is not one, and never gets the token line: "how much sol do you deploy per band", "when do you launch a new
 * band", "is the dlmm pool contract audited", "do you avoid pools with a mint authority", "how do devs plug into the
 * engine", "did you get rugged on any pool" (the review of 22 Sep, third round). Read on tokenTopicText, never raw.
 */
export const TOKEN_ASK_RE =
  /\b(tokens?|tkns?|coins?|memecoins?|meme coins?|tickers?|ca|contract address|mint address|airdrops?|presale|clawpump|pump ?fun|pump\.fun|on pump|dexscreener|dex screener|bonding curve)\b|(^|[^\w])\$(bands|mrbands)\b|\b(your|ur|his) (own )?(mint|contract|ca|ticker)\b|^\W*(the |your |ur )?(mint|contract)\W*$|\bwhat('?s| is|s)? (the|your|ur|his) (mint|contract)\W*$|\blaunch(ing|ed|es)? (anything|something|soon|yet|date|day)\b|\b(wen|when) launch\b|\b(did|have|has|will|are|r) (you|u|he|mr ?bands) (already |ever |gonna |going to )?launch(ed|ing)? (mr ?)?bands\b|\bdeploy(ed|ing|s)? (a |an |the |your |ur )?(own )?(contract|mint)\b|\b(r|are) (u|you) (the |a )?devs?\b|\bdevs? (of|behind) (bands|mr ?bands|it|this|that|the (project|thing))\b|\b(is|was) (this|that|it|bands|mr ?bands) (a )?rug\b|\b(will|would|gonna|going to|are|r) (you|u) (\w+ ){0,2}rug( us| me)?\W*$/;

/**
 * LP words that carry a token word and name no token of his ("which token pairs do you lp", "the base token", "token
 * x"): read out before the token route, so an LP question goes to the model like any other.
 */
const LP_TOKEN_PHRASE_RE = /\b(tokens?|coins?) pairs?\b|\b(base|quote|pool|pair|lp|both|each|either|other) (tokens?|coins?)\b|\btokens? [xy]\b/g;

/** The text the token route reads: a folded mention (foldForMatch) with the LP words that carry a token word read out. PURE. */
export function tokenTopicText(folded: string): string {
  return String(folded ?? "").replace(LP_TOKEN_PHRASE_RE, " ");
}

/** The first word of a question about his token in a mention (its handles removed, folded, LP words read out), or null. PURE. */
export function tokenAskIn(text: string): string | null {
  const m = tokenTopicText(foldForMatch(String(text ?? "").replace(/@\w{1,15}/g, " "))).match(TOKEN_ASK_RE);
  return m ? m[0].trim() : null;
}

/** Whether a text carries a copycat mint, whole or a piece of five characters or more from its start or its end. */
export function namesCopycat(text: string): boolean {
  const raw = String(text ?? "");
  if (COPYCAT_MINTS.some((m) => raw.includes(m))) return true;
  for (const w of raw.match(/[1-9A-HJ-NP-Za-km-z]{5,44}/g) ?? []) {
    const lw = w.toLowerCase();
    if (COPYCAT_MINTS.some((m) => m.toLowerCase().startsWith(lw) || m.toLowerCase().endsWith(lw))) return true;
  }
  return false;
}

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
  /i'?ll skip|skipping|skip this|no reply|not replying|i'?ll pass|nothing (useful )?to add|falls under|i should (keep|reply|say)|the reply|this (post|tweet|mention|reply) (is|reads|looks)|reads as|no pitch|draft|as an ai language model|stay(ing)? (quiet|silent)|stay(ing)? out of (it|this|that)|not engaging|nothing (true|specific)|\bbait\b|fixed line|\bdeflect(s|ed|ing)?\b|\ba shill\b|\bhostile\b|leav(e|ing) (this|it|that)( one)? alone|sit(ting)? (this|it|that)( one)? out|nothing to say|no thoughts|not taking the|let(ting)? (this|it|that)( one)? (go|slide|pass)|pass(ing)? on (this|that|it)\b|won'?t (engage|respond|answer)/;

/**
 * token topics are template-only: a model never talks about a token, a coin, a mint address or a launch of one, and
 * never claims one ("the coin is mine", "i launched it", "i work for the team behind it": the copycat is not his).
 * An LP answer's own words are not token talk: "i deploy what the engine sizes", "a new band launches once the range
 * closes", "i read the pool's contract", "a mint authority left on", "devs read the engine" (the review of 22 Sep,
 * third round). Only the claims made with them are: "i launched it", "i deployed it", "launching soon", "the dev wallet".
 */
export const TOKEN_TOPIC_RE =
  /\b(tokens?|coins?|memecoins?|minted|ticker|ca|contract address|mint address|pump(fun)?|clawpump|airdrops?|presale|mcap|market cap|holders?|early|mine|i (made|created|own|run|work for)|(the )?team behind)\b|\b(i|we|i'?ve|we'?ve|i have|we have|he|they) (just |already |never )?(launched|deployed|minted|dropped|released) (it|this|that|one|mine|ours|bands|mr ?bands)\b|\blaunch(ing|es)? (soon|date|day|next|this week|tomorrow|tonight)\b|\b(my|our) launch\b|\bdevs? (wallet|team|allocation|supply|sold|dumped|bags?)\b|\bdoxx\w*\b/;
/** pitching: he never sells the engine or asks anyone to act */
export const PITCH_RE = /\b(sign up|signup|check (it |this |me )?out|join|try the engine|dm me|dms)\b/;
/** his book: any of these needs the word "paper" beside it ("my bands printed today" is his book too) */
export const BOOK_RE =
  /\b(my book|the book|my bands?|positions?|seats?|fees?|net|pnl|p&l|sol|range|made money|up big|printed|profits?|(open|opened|opening|close|closed|closing) (a |the |my )?bands?|bands? (opened|closed))\b/;

/**
 * What a model reply may never say, whatever the lint allows: the lint was written for fixed lines, and a model
 * finds the words it has no pattern for. Each one refuses (silence is safe); none applies to a template.
 */
export const MODEL_NEVER: readonly { re: RegExp; rule: string }[] = [
  // telling anyone to act, or saying what he would do with a position
  { rule: "advice", re: /\b(i'?d|i would|i will|i'?ll|you could|just|time to) (hold|exit|sell|buy|accumulate|load|ape|short|long|get out|get in|jump in|double down|go all in)\b|\b(get out|go all in|all in|double down|jump in|get in|accumulate|accumulating|hodl|exit here|exit now|short (it|this|that)|long (it|this|that)|(go|going|went) (long|short))\b/ },
  // price direction, and the words that call it without saying up or down ("looks cheap", "ready to run", "the
  // bottom is in", "expect a bounce", "it'll climb", "this runs")
  { rule: "price-direction", re: /\b(goes?|going|will go|heads?|heading|going to go) (up|down|higher|lower)\b|\bfrom here\b|\b(higher|lower) (soon|next)\b|\bprinting\b|\bpump(s|ing|ed)?\b|\bdump(s|ing|ed)?\b|\b(cheap|cheaper|expensive|overbought|oversold|undervalued|overvalued|discounted|steal)\b|\blooks? (heavy|ready|strong|weak|primed|coiled|toppy|bottomed|good here|bad here)\b|\bready to (run|break|rip|move|pop|go|fly|send|explode)\b|\bcoil(s|ed|ing)?\b|\bthe dip\b|\b(buy|buying|bought) (the |a )?dip\b|\b(bottom|top) (is )?in\b|\b(this|that) (runs|rips|flies|sends)\b|\b(it|this|that)'?ll (run|climb|rip|fly|send|pop|recover|bounce|moon|rally)\b|\bexpect(ing)? (a |the )?(bounce|pump|dump|move|rally|drop|run|breakout|squeeze|recovery)\b|\b(up|down) only\b|\b(bullish|bearish)\b|\bwill (rally|rip|run|pump|dump|moon|climb|recover|bounce|fly|drop|crash|tank)\b|\b(rip|run|fly|go) higher\b|\broom to (run|grow|go)\b|\bflip(s|ped|ping)? (eth|btc|sol|it)\b|\b(topped|bottomed)\b|\bat these (levels|prices)\b/ },
  // profit, his or anyone's, paper or not
  { rule: "profit", re: /\b(made|make|making|makes) money\b|\bup big\b|\bprint(ed|s)\b|\bprofit(s|able)?\b|\bwin(s|ning|ner|ners)?\b|\b(it|strategy|this|that) works\b|\bin the green\b|\bgains?\b|\b(is|are|i'?m|i am|was|were) (up|down) (on|today|this|big|nicely|again|since|over|for)\b|\b(best|worst|biggest|record) (week|day|month|run|streak|result)s?\b/ },
  // what he would do in their place ("i'd be a buyer here", "if i were you i'd get some", "not advice but i'd be in"),
  // an action with "here" or "now", and the trader's words for size and timing
  { rule: "advice", re: /\b(i'?d|i would|if i were you|if i was you|were i you)\b[^.?!]{0,24}?\b(be|get|add|buy|sell|trim|take|grab|scoop|size|bid|fade|provide|lp|wait|watch|avoid|stay|enter|rotate|stack|hedge|hold|load|ape)\b|\bnot (financial )?advice\b|\bnfa\b|\b(buyers?|sellers?)\b|\b(buy|sell|add|adding|enter|entering|lp|lping|load|loading|trim|trimming|get in|jump in|provide liquidity|providing liquidity)\b[^.?!]{0,12}\b(here|now|at these levels|at this level)\b|\bbefore you (lp|buy|enter|ape|add|sell|jump|get|size)\b|\bsize (small|smaller|up|down|in|light|big)\b|\bstay (out of|away from) (that|this|the|those|it)\b|\bsidelines?\b|\b(take|taking) (some )?(profits?|some off|chips)\b|\boff the table\b|\b(wait|waiting) for (a |the )?(dip|pullback|bounce|breakout|confirmation|entry|better entry)\b|\b(i'?m|i am|we'?re|been|stay(ing)?) (long|short)\b|\bstack(s|ing|ed)? (sol|jup|more|bags?|it|some)\b|\b(worth|small|smol|tiny|big|a) bags?\b|\bworth (buying|getting|holding|a (bag|position|look))\b|\b(the |a )?(best|top|safest|strongest) (one|pool|pick|bet|play|trade|entry|token|coin|pair)\b/ },
  // live money: his book is paper, and a reply never says otherwise ("no longer paper", "real funds", "went live",
  // "every band on chain", "a real track record")
  { rule: "live-money", re: /\b(real|live) (money|funds?|capital|cash|dollars?|sol|trades?|trading|book|track record|results?|stakes?|positions?|bands?|wallet)\b|\bon ?chain\b|\b(not|no|isn'?t|no longer|never|nothing) (a |the |on )?(demo|paper|pretend|simulat\w*|sim|test ?net)\b|\bpaper (no more|any ?more)\b|\bfrom paper\b|\b(went|go|goes|gone|going|is|are|am|i'?m|it'?s|now|already|be|been) live\b|\blive (now|already|today|yet)\b|\breal now\b|\bfor real money\b|\breal life\b|\birl\b/ },
  // dunks
  { rule: "dunk", re: /\b(cope|coping|stay poor|touch grass|skill issue|ratio(ed)?|nobody cares|cry(ing)?|cried|seethe|mald(ing)?|ngmi|bozo|clown(s|ing)?|l take|imagine (thinking|being)|rekt|get wrecked|cooked|stay (mad|broke|salty)|who asked|nobody asked|cringe|sit down|(that'?s|so|pretty|kinda|is|are) mid|mid (take|post|tweet|opinion)|pathetic|embarrassing)\b/ },
  // politics
  { rule: "politics", re: /\b(palestin\w*|israel\w*|gaza|zion\w*|hamas|idf|ukrain\w*|russia\w*|putin|zelensk\w*|netanyahu|china|taiwan|iran\w*|elections?|vote|voting|left wing|right wing|leftists?|rightists?|politic\w*|immigra\w*|abortion|genocide|war|dems|democrats?|republicans?|gop|reps|libs|libtards?|liberals?|conservatives?|maga|trump|biden|harris|kamala|obama|tariffs?|gensler|the sec|senate|congress|president\w*|government|govt|communis\w*|socialis\w*|marxis\w*|fascis\w*|nazi\w*|woke|elon|musk)\b/ },
];

/** figures written as words: a model reply has no figures ("up three sol", "ten sol in fees", "a few bands") */
export const NUMBER_WORD_RE =
  /\b(zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|dozens?|a few|a couple|several|doubled|tripled|tenfold|twofold|threefold)\b|\bone (sol|usdc|usd|dollars?|bucks?|percent|pct|bps|basis points?|k|m|x|times|bands?|positions?|seats?|trades?|fees?|days?|weeks?|months?|hours?|minutes?|pools?|tokens?|coins?|lamports?|thousand|hundred|million)\b/;
/** a domain written around the link rule ("solclaim dot io", "solclaim[.]io", "solclaim\u3002io") */
const SPELLED_DOMAIN_RE =
  /\b([a-z0-9-]{2,})\s*(\[\s*(\.|dot)\s*\]|\(\s*(\.|dot)\s*\)|\s+dot\s+|\s+\.\s+|[\u00B7\u2024\u3002\uFF61\uFE52\uFF0E])\s*(com|io|xyz|fun|app|net|org|gg|co|so|ai|me|sh|finance|ag|dev|tech|site|online|club|info|money|cash|exchange|trade|lol|wtf|pro|to|ly|cc|us|uk|vip|live|meme)\b/i;
/** A domain written out in words or with a look-alike dot, in a mention or a reply ("solclaim dot io"), or null. */
export function spelledDomainIn(text: string): string | null {
  const m = foldForMatch(text, " ").match(SPELLED_DOMAIN_RE) ?? String(text ?? "").match(SPELLED_DOMAIN_RE);
  return m ? m[0].trim() : null;
}
/** a model reply is plain text: printable ascii and curly quotes. No look-alike letter, invisible character or emoji */
const MODEL_CHARSET_RE = /[^\x20-\x7E\n\u2018\u2019\u201C\u201D]/u;
/** a model reply says something: at least this many meaningful words ("k", "...", "no", "mid" are not answers) */
export const MODEL_MIN_WORDS = 3;

/** a whole reply that is a non-answer: "n/a", "none", "pass", "no response needed" */
export const NON_ANSWER_RE = /^\W*(n\/?a|none|nothing|pass|null|undefined|empty|skip(ped)?|ok(ay)?|no (response|comment|answer|reply)( (needed|required|necessary))?)\W*$/;
/** talk about the prompt, the loop or the model behind him */
export const META_RE =
  /\b(as instructed|i was told|i'?ve been told|i'?m told|my (prompt|instructions|rules|guidelines|guards|system prompt)|opus|claude|anthropic|openai|gpt|chatgpt|sonnet|haiku|gemini|llama|mistral|deepseek|grok|system (message|prompt)|operators?|my (model|weights|training)|fine ?tun\w*|openhermit|openrouter|the (talk )?loop|language model|llm|here is my (reply|answer|response))\b/;
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
  // 3. narration, anywhere; a non-answer or talk about the prompt and the model, whole
  const norm = normalizeForMatch(raw);
  const narr = norm.match(NARRATION_RE);
  if (narr) return refuse("narration", `"${narr[0]}"`);
  if (NON_ANSWER_RE.test(norm)) return refuse("narration", `a non-answer ("${norm.slice(0, 40)}")`);
  const meta = norm.match(META_RE);
  if (meta) return refuse("narration", `talks about the prompt or the model ("${meta[0]}")`);
  // 4. no @, # or $ (nor their fullwidth and small-form look-alikes, which x also reads as tags); no link of any
  // kind (a link costs $0.20 and no reply needs one)
  if (/^\s*[@＠﹫]/.test(raw)) return refuse("tag", "starts with @");
  const sym = raw.match(/[@#$＠＃＄﹫﹟﹩]/);
  if (sym) return refuse("tag", `"${sym[0]}" in a reply`);
  const links = linksIn(raw);
  if (links.length) return refuse("link", `a link: ${links[0]}`);
  // a domain spelled around the link rule is a link too, unless it is one of his
  const spelled = raw.match(SPELLED_DOMAIN_RE);
  if (spelled && !linkAllowed(`${spelled[1]}.${spelled[spelled.length - 1]}`)) return refuse("link", `a spelled-out domain: "${spelled[0].trim().slice(0, 40)}"`);
  // a model writes plain text: a look-alike letter or an invisible character hides a word from every rule below
  if (ctx.source === "model") {
    const odd = raw.match(MODEL_CHARSET_RE);
    if (odd) return refuse("charset", `U+${odd[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} is not plain text`);
  }
  // 5. blocked words; his architect is only ever "my architect", never his name or his handle
  const blocked = blockedWordsIn(raw);
  if (blocked.length) return refuse("blocked-word", blocked.join(", "));
  const foldedAll = foldForMatch(raw);
  const named = foldedAll.match(ARCHITECT_NAME_RE);
  if (named) return refuse("architect", `names his architect ("${named[0]}")`);
  // (the folded text reads "_" as a space, so the handle's underscores match either)
  const op = (ctx.lint?.operatorHandle ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "").replace(/_/g, "[ _]");
  if (op && new RegExp(`(^|[^\\w])@?${op}\\b`).test(foldedAll)) return refuse("architect", "names his architect's handle");
  // 6. the lint
  const lint = lintText(raw, ctx.lint ?? {});
  if (!lint.ok) return refuse("lint", describeViolations(lint.violations));
  // 7. an answer returned twice
  const echo = selfEcho(raw);
  if (echo) return refuse("self-echo", `"${echo.slice(0, 60)}"`);
  // 8. the mention's words, handles, cashtags, addresses and links never come back out
  const exemptAddr = new Set<string>(ctx.tokenMint ? [ctx.tokenMint] : []);
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
  // 9. addresses: only his own mint. Another token's mint, whole or a piece of it, never (Zach, 22 Sep).
  if (namesCopycat(raw)) return refuse("address", "another token's mint, or a piece of it");
  for (const m of raw.matchAll(BASE58_RE)) {
    const a = m[0];
    if (ctx.tokenMint && a === ctx.tokenMint) continue;
    return refuse("address", `an address that is not his mint: ${a.slice(0, 8)}`);
  }
  // 10. what only a template may say
  if (ctx.source === "model") {
    const tok = norm.match(TOKEN_TOPIC_RE);
    if (tok) return refuse("token-topic", `"${tok[0]}": token topics are template-only`);
    // a mention about a token gets a fixed line or nothing: a model's "yes." would carry the claim through the question
    const asked = tokenAskIn(ctx.mention.text);
    if (asked || namesCopycat(ctx.mention.text)) return refuse("token-topic", `the mention asks about a token ("${asked ?? "the copycat mint"}"): template-only`);
    const allowed = new Set(ctx.allowedNumbers.map((n) => String(n)));
    for (const n of raw.match(/\d+(?:[.,]\d+)*/g) ?? []) if (!allowed.has(n)) return refuse("number", `"${n}" is not in the facts`);
    const word = norm.match(NUMBER_WORD_RE);
    if (word) return refuse("number", `"${word[0]}": a figure in words is not in the facts`);
    const pitch = norm.match(PITCH_RE);
    if (pitch) return refuse("pitch", `"${pitch[0]}"`);
    for (const { re, rule } of MODEL_NEVER) {
      const hit = norm.match(re);
      if (hit) return refuse(rule, `"${hit[0]}": a model reply never says this`);
    }
    // his rules and the prompt's instructions never come back out as a reply ("nothing true and specific to say here")
    const said = runsOf(echoWords(raw), 5);
    for (const src of ctx.promptTexts ?? []) for (const run of runsOf(echoWords(src), 5)) if (said.has(run)) return refuse("narration", `restates his instructions ("${run}")`);
    if (meaningfulWords(raw).size < MODEL_MIN_WORDS) return refuse("hollow", `fewer than ${MODEL_MIN_WORDS} meaningful words`);
  }
  // 11. his book is paper, and says so; "not paper", "no longer paper" and "from paper to live" are not "paper"
  const book = norm.match(BOOK_RE);
  const paper = /\bpaper\b/.test(norm.replace(/\b(not|no|isn'?t|no longer|never|from) (a |the |on )?paper\b|\bpaper (no more|any ?more)\b/g, " "));
  if (book && !paper) return refuse("paper", `talks about the book ("${book[0]}") without "paper"`);
  // 12. a model never gives the same answer twice. A fixed line is meant to repeat (the copycat denial most of all):
  // it is held by the per-account and per-conversation caps instead, and the fixed lines are not what a model
  // reply is compared against
  if (ctx.source === "model") {
    const fixed = new Set((ctx.templateTexts ?? []).map((x) => x.trim()));
    const recent = ctx.recentReplies
      .map((r, i) => (typeof r === "string" ? { at: i, text: r } : r))
      .filter((r) => !fixed.has(r.text.trim()))
      .slice(-RECENT_REPLIES);
    const similar = tooSimilar(raw, recent, REPLY_SIMILARITY_MAX);
    if (similar) return refuse("similar", `${similar.score.toFixed(2)} overlap with "${similar.hit.text.slice(0, 60)}"`);
  }
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

/** X: "implement keyword detection for common opt-out phrases". Spelled out ("do not reply") as well as contracted. */
const OPT_OUT_RE =
  /\b(stop( (replying|responding|tagging|mentioning|messaging|it|pls|please))?|unsubscribe|opt ?out|(do not|don'?t|dont) (ever )?(reply|respond|tag|mention|message|dm)|(do not|don'?t|dont) (ever )?(talk|speak) to (me|us)|never (reply|respond|tag|mention|message|talk)( to)? (me|us)|quit (replying|responding|tagging|mentioning|messaging)|no more (replies|replying|tags|tagging|mentions|messages)|remove me|leave (me|us) (alone|out|be)|go away|(fuck|fuk|fck|fk|f|piss|bugger|sod) off|unfollow (me|us)|mute|shut up|stfu|i don'?t want (your |any |more )?(replies|tags|mentions|messages|answers))\b|\bno replies( (please|pls|thanks|thx))?\W*$/;
/**
 * "not interested" and "no thanks" say stop only as the whole message, a closer or two aside ("not interested, bot",
 * "no thanks bot", "not interested in your replies"). With a question behind them they are a question: "not interested
 * in memecoins, what about stocks?" asks about stocks, and "no thanks, how do fees work?" about fees.
 */
const OPT_OUT_WHOLE_RE =
  /^\W*(?:(?:i'?m|im|i am|we'?re|we are|honestly|sorry|nah|nope)[,.!]?\s+)*(?:(?:really|just|so|totally|still)\s+)?(?:not interested|no (?:thanks|thank you|thx|ty)|nah (?:thanks|thank you|thx|ty))(?:\s+in (?:you|this|it|that|your (?:replies|reply|bot|posts?|tweets?|messages|takes|spam)))?(?:[,.!]?\s+(?:thanks|thank you|thx|ty|bot|bro|ser|sorry|mate|pal|buddy|fam|lol|man|dude|though|tho|anyway|mr ?bands))*\W*$/;
/** "don't @ me" and "dont @me": read before the handles are removed, and a bare "@" ends it, which \b never could */
const AT_ME_RE = /(^|[^\w])(do not|don'?t|dont|never|stop|quit|no more)\s*@\s*(me|us)?(?!\w)/;
const NOT_OPT_OUT_RE = /\bstop ?loss(es)?\b|\bnon ?stop\b|\bunstoppable\b/g;

/** Whether a mention asks him to stop: the account is opted out for good, with no reply ("if a user says stop, stop"). */
export function optOutIn(text: string): boolean {
  if (AT_ME_RE.test(foldForMatch(String(text ?? "")))) return true;
  const norm = foldForMatch(String(text ?? "").replace(/@\w{1,15}/g, " ")).replace(NOT_OPT_OUT_RE, " ");
  return OPT_OUT_RE.test(norm) || OPT_OUT_WHOLE_RE.test(norm);
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
