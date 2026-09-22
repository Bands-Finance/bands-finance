/**
 * The builder voice's guards (docs/talk.md, "The builder voice"): every draft, his model's or a template's, passes
 * vetBuilderPost before it may go out, and a draft that fails is refused, never patched. PURE.
 *
 * What it refuses, in order:
 *   shape       empty, over the length its moment was given, a leaked draft marker or JSON, a sentence said twice
 *   charset     anything but plain text and curly quotes: emoji, look-alike letters, invisible characters
 *   symbols     @ (no mentions), # (no hashtags), $ other than before a digit (no cashtags), ! and ? (no hype, no
 *               questions put to the timeline)
 *   case        sentence case: each sentence opens on a capital, a digit or a ticker; no standalone "i"; no
 *               all-lowercase post; no shouting outside the tickers and units the facts spell
 *   numbers     every number, date and clock time must be in the facts block (pre-rounded there); numbers written
 *               as words are refused; "0.00" is never printed
 *   units       a SOL figure is never printed as dollars ("$0.55", "0.55 dollars"); the unit is part of the token
 *   direction   a negative figure never beside a growth word (up, kept, best ...) and its sentence says loss, lost or
 *               down; a positive one never beside loss, lost or down
 *   context     a number sits where its fact puts it (150 beside the start, the SOL/USD term beside SOL/USD or
 *               valuation and never as trading, "36 bands" and "27 up" not swapped, no ordinals)
 *   books       a post printing a paper figure says "paper"; a real figure says "real"; both, each in its own sentence;
 *               a paper figure's sentence never says real, and an all-paper post never says real at all
 *   pairs       a fee total is printed with the net it needs (the book's result beside the book's fees), even when it
 *               prints the same as another figure
 *   weekly      the real run's figures at most once in his last 14 posts, unless the moment is an arc post
 *   quotes      at most one quote, verbatim from the facts' journal lines
 *   tickers     a pair label exactly as the facts spell it
 *   tense       a past-tense follow-up carries no clock time and never says just, right now or minutes ago
 *   words       advice, price direction, profit talk, hype and his journal's cliches; jargon (strap, seat, prints,
 *               stacked, re-centre) outside a quote; the architect, the operator, a team, "we"; any model or vendor
 *               name (META_RE); any mint address or a 4+ character piece of another token's, his token, a coin, a
 *               launch, a teaser, "Bands" as a name, ClawPump; soft advice, price hints, hype, bait, slop, invented
 *               feelings, the architect by paraphrase, any capitalised ticker the facts do not name
 *   links       only the loop's allowlist, one a post, never beside a paper figure, one a day
 *   repeat      0.5 meaningful-word overlap with any of his last 14 posts (a follow-up is exempt against the post it
 *               follows; the daily card, the fixed shape, is not compared)
 *   lint        lintText with the sentence-case rule in place of the lowercase one
 */
import { COPYCAT_MINTS, isCopycatPiece } from "../risk/house";
import { allowedTokens, numberTokens, numberTokenSpans, type Book, type FactsBlock, type Figure } from "./facts";
import { markersIn, selfEcho, tooSimilar, type RecentText } from "./guards";
import { BANNED_PHRASES } from "./craft";
import { lintText, linksIn, mentionsHouseToken, normalizeForMatch, weightedLength, type LintContext } from "./lint";
import { ARCHITECT_NAME_RE, foldForMatch, META_RE, MODEL_NEVER, NUMBER_WORD_RE } from "./replyGuards";
import { loopLength, loopLinkAllowed } from "./tick";
import { blockedWordsIn } from "./wordguard";

export type PostLength = "short" | "medium" | "long";
/** the most characters (links counted as 23) each length allows */
export const LENGTH_MAX: Record<PostLength, number> = { short: 100, medium: 220, long: 280 };
export const POST_MIN_CHARS = 30;
/** meaningful-word overlap with one of his last 14 posts at or over this is a repeat (the plan's 0.5) */
export const BUILDER_SIMILARITY_MAX = 0.5;
export const RECENT_POSTS = 14;

export interface BuilderVetContext {
  facts: FactsBlock;
  length: PostLength;
  lint: LintContext;
  /** his last posts, newest last (only the last RECENT_POSTS are read) */
  recent: readonly RecentText[];
  /** the moment is a follow-up of this post key: that post is exempt from the repeat rule */
  followUpOf?: string | null;
  /** the moment's key type: a daily card is not compared with earlier daily cards */
  type?: string | null;
  /** the event is older than 30 minutes: written in the past tense, no clock time */
  past?: boolean;
  /** an arc post may restate the real run's figures */
  arc?: boolean;
  /** links already posted today (at most one a day) */
  linksToday?: number;
}

export interface BuilderRefusal {
  rule: string;
  detail: string;
}

const refuse = (rule: string, detail: string): BuilderRefusal => ({ rule, detail });

/** plain text only: printable ascii, a line break, curly quotes and apostrophes */
const CHARSET_RE = /[^\x20-\x7E\n‘’“”]/u;
const QUOTE_RE = /"([^"\n]+)"|“([^”\n]+)”/g;
const BASE58_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;

/** Words that are hype, filler or an epigram in this voice, whatever the lint allows. */
export const BUILDER_NEVER: readonly { re: RegExp; rule: string }[] = [
  // no end date for the paper book, and no countdown to one (Zach, 22 Sep)
  { rule: "paper-end", re: /\b(8 oct(ober)?|oct(ober)? 8)\b|\bpaper (until|till|through|ends?)\b|\buntil after\b|\b(days?|weeks?) (left|to go)\b|\bgo(es|ing)? live (on|after|from|in)\b|\breal money (from|after|on|in) /i },
  { rule: "token", re: /\b(the|a|my|our|his|new|one) token\b|\btoken (is|was|will|drop|sale|launch)\w*\b|\bcoins?\b|\blaunch\w*\b|\bon ?-?chain\b|\bcoming soon\b|\balmost ready\b|\bsomething (of mine|new)\b|\bkey to my tools\b|\bmint(s|ed)?\b|\bcopycat\b|\bimpostor\b|\bimposter\b|\bimpersonat\w*|\bclawpump\b|\bpump ?\.? ?fun\b|\b(my|our|his) (own )?(token|coin)\b|\btoken (launch|sale)\b|\blaunch(ed|ing)? (a|my|the) (token|coin)\b|\bticker\b|\bbands token\b|\bmrbands\b|\bholders?\b|\bairdrop\w*\b/ },
  { rule: "hype", re: /\b(gm|gn|lfg|wagmi|excited|exciting|thrilled|proud|journey|stay tuned|big news|game ?changer|amazing|incredible|insane|huge|massive|let'?s go|alpha|unlock(ed|s)?|revolution\w*|next level|buckle up|here'?s the thing|the best part|plot twist|spoiler)\b/ },
  { rule: "epigram", re: /\bthat'?s the (job|game|work|point|number the)\b|\bquiet days (are|is) the strategy\b|\bwhat i'?m building against\b|\bi post both numbers or neither\b|\bkeep(ing)? the powder dry\b|\bsitting in the chop\b|\bone band at a time\b|\bthe (market|pool) (always )?(decides|wins)\b|\bthat'?s how (it goes|this works)\b/ },
  { rule: "not-x-its-y", re: /\b(isn'?t|is not|wasn'?t|not) (just |only |about )?[a-z' ]{1,30}, (it'?s|it is|but)\b/ },
  { rule: "jargon", re: /\b(strap|straps|stacked|stacking|prints?|printed|seats?|re ?cent(re|er)(d|ed|ing|s)?|counted in( it)?|price sat)\b/ },
  { rule: "profit", re: /\breturns?\b|\byield(s|ed|ing)?\b|\broi\b|\b(made|make|making|makes) money\b|\bup big\b|\bprofit(s|able)?\b|\bwin(s|ning|ner|ners)?\b|\bin the green\b|\bgains?\b|\b(best|record|biggest) (week|day|month|run|streak|result)s?\b|\bnot bad\b/ },
  { rule: "team", re: /\b(we|we'?re|we'?ve|our|ours|my team|the team|my human|my architect|architect|my manager|manager|operator|my dev|my creator)\b|\bhumans?\b|\bperson who\b|\bbuilders?\b|\bowners?\b|\bcreators?\b|\bmakers?\b|\bthe one who\b|\bkeys\b|\bbuilt me\b|\bruns me\b|\bmade me\b|\bbehind me\b|\bmy (dev|developer|boss|team|guy|partner)s?\b/ },
  { rule: "feelings", re: /\b(stung|stings?|hurt|hurts|sleep|slept|nervous|scared|afraid|happy|sad|felt|feel|feels|feeling|worried|anxious|upset|glad|love|hate|painful|pain|gutted|relieved|frustrat\w*)\b/ },
  { rule: "advice", re: /\bworth (watching|a look|a try|it)\b|\b(may|might) want\b|\bconsider\w*\b|\bsmart(er)? (play|move)\b|\byou (could|should|can|might)\b|\banyone (providing|lp'?ing|farming|in)\b|\blps? (should|could)\b|\bdo worse\b/ },
  { rule: "price-direction", re: /\brall(y|ies|ied|ying)\b|\bclimb(s|ed|ing)?\b|\bbounce\w*\b|\bon the way (up|down)\b|\bmoon\w*\b|\bdump\w*\b|\bpump\w*\b|\bbreak ?out\b|\bthe chart\b|\bis due\b/ },
  { rule: "hype", re: /\bcoming\b|\bspecial\b|\bbeginning\b|\bon fire\b|\bwild\b|\bthe move\b|\bbig things\b|\bsoon\b|\bstay close\b|\bwatch this\b/ },
  { rule: "bait", re: /\bfollow(s|ed|ing)?\b(?![- ]up)|\brepost\w*\b|\bretweet\w*\b|\brt\b|\blikes?\b|\bdms?\b|\bdm'?s\b|\breply\b|\bcomment\w*\b|\bsubscribe\w*\b|\bnotifications?\b|\blink in bio\b/ },
  { rule: "slop", re: /\bngl\b|\bfr\b|\bser\b|\btbh\b|\bimo\b|\blol\b|\blmao\b|\bit is what it is\b|\bvibes?\b|\bbased\b|\bcope\b|\bwen\b|\bnfa\b|\bdyor\b/ },
];

/** Words that make a figure a gain or a rise; printed beside a loss, the direction is false. */
export const GROWTH_RE = /\b(up|higher|kept|keep|keeps|gained|gain|gains|best|rose|risen|grew|grown|made|earned|added|ahead|positive|profit\w*|in (my )?favou?r)\b/i;
/** Words that make a figure a loss or a fall. */
export const LOSS_RE = /\b(loss|losses|lost|down|lower|fell|fallen|drop|dropped|negative|worst)\b/i;
/** "real", "real money", "live money", "actual money": the real book's words. */
const REAL_RE = /\breal\b|\b(live|actual) money\b/i;
/** A past-tense follow-up never says the event just happened. */
const PAST_NOW_RE = /\bjust\b|\bright now\b|\b(minutes|moments|seconds) ago\b|\bnow closing\b|\bthis minute\b|\bam (closing|opening|exiting|pulling)\b|\bi'?m (closing|opening|exiting|pulling)\b|\bas (we|i) speak\b/;

/**
 * The words around the k-th number: its sentence, up to 6 words before and 3 after, never past the numbers either
 * side (so "27 bands closed, 36 up" gives 36 only "up").
 */
function windowOf(text: string, spans: readonly { start: number; end: number }[], k: number): { sentence: string; around: string; after: string } {
  const sp = spans[k];
  const sStart = Math.max(text.lastIndexOf(". ", sp.start - 1), text.lastIndexOf("\n", sp.start - 1), -1) + 1;
  const dot = text.slice(sp.end).search(/[.!?](\s|$)|\n/);
  const sEnd = dot < 0 ? text.length : sp.end + dot;
  const lo = Math.max(sStart, k > 0 ? spans[k - 1].end : 0);
  const hi = Math.min(sEnd, k + 1 < spans.length ? spans[k + 1].start : text.length);
  const before = text.slice(lo, sp.start).split(/\s+/).filter(Boolean).slice(-6).join(" ");
  const after = " " + text.slice(sp.end, hi).split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
  return { sentence: text.slice(sStart, sEnd), around: `${before} ${text.slice(sp.start, sp.end)}${after}`, after };
}

/** A sentence split that keeps decimals ("0.55 SOL") and tickers together. */
const sentencesOf = (s: string): string[] =>
  s
    .split(/(?<=[.!?])\s+(?=\S)|\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

/** Upper-case words the voice allows without being in the facts. */
const CAPS_OK = new Set(["SOL", "USDC", "USD", "UTC", "AI", "API", "DLMM", "CLMM", "MCP", "TVL", "OK", "X", "I", "I'M", "I'VE", "I'D", "I'LL"]);

/** Why the text must not go out, or null. */
export function vetBuilderPost(text: string, ctx: BuilderVetContext): BuilderRefusal | null {
  const raw = typeof text === "string" ? text.trim() : "";
  const f = ctx.facts;
  // 1. shape
  if (raw.length < POST_MIN_CHARS) return refuse("length", `${raw.length} characters, under ${POST_MIN_CHARS}`);
  const len = loopLength(raw);
  const max = LENGTH_MAX[ctx.length];
  if (len > max) return refuse("length", `${len} > ${max} for a ${ctx.length} post (links counted as 23)`);
  const marker = markersIn(raw);
  if (marker) return refuse("markers", marker);
  if (/[{}`]|"\s*(post|skip|key)\s*"\s*:/i.test(raw)) return refuse("markers", "JSON or code in the text");
  const echo = selfEcho(raw);
  if (echo) return refuse("self-echo", `"${echo.slice(0, 60)}"`);
  if (raw.split("\n").filter((l) => l.trim()).length > 3) return refuse("shape", "more than 3 lines");

  // 2. charset and symbols
  const odd = raw.match(CHARSET_RE);
  if (odd) return refuse("charset", `U+${odd[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} is not plain text (no emoji, no look-alikes)`);
  if (/@/.test(raw)) return refuse("symbols", "an @: he tags nobody");
  if (/#/.test(raw)) return refuse("symbols", "a #: no hashtags");
  if (/\$(?!\d)/.test(raw)) return refuse("symbols", "a $ not before a digit: no cashtags");
  if (/!/.test(raw)) return refuse("symbols", "an exclamation mark");
  if (/(^|[\s(])[:;=8]['-]?[()DPpOo\/\\|\[\]]($|[\s.,)])|(^|\s)[xX][dD]($|[\s.,])|<3|\^_\^|\bT_T\b|-_-/.test(raw)) return refuse("symbols", "an emoticon");
  if (/\?/.test(raw)) return refuse("symbols", "a question mark: no questions put to the timeline");

  // quotes: at most one, verbatim from the facts' journal lines; the rest of the rules read the text without them
  const quotes = [...raw.matchAll(QUOTE_RE)].map((m) => m[1] ?? m[2]);
  if (quotes.length > 1) return refuse("quotes", `${quotes.length} quotes (at most one)`);
  for (const q of quotes) if (!f.quotes.some((line) => line.includes(q.trim()))) return refuse("quotes", `"${q.slice(0, 50)}" is not a line from the facts`);
  const unquoted = raw.replace(QUOTE_RE, " ");

  // 3. case
  if (!/\p{Lu}/u.test(unquoted)) return refuse("case", "all lowercase: the builder voice is sentence case");
  if (/(^|[^\w'’])i(?=$|[^\w'’]|['’](m|ve|d|ll)\b)/.test(unquoted)) return refuse("case", 'a lowercase "i"');
  for (const s of sentencesOf(unquoted)) {
    const first = s.replace(/^[\s"'“‘(]+/, "");
    if (!first) continue;
    if (/^\p{Ll}/u.test(first) && !f.tickers.some((t) => first.startsWith(t))) return refuse("case", `a sentence opens in lowercase: "${first.slice(0, 30)}"`);
  }
  // tickers exactly as the facts spell them: a pair label must be one of them, and a known ticker in the wrong case is refused
  for (const pair of unquoted.match(/\b[\w.]+\/[\w.]+\b/g) ?? []) {
    if (/^\d+\/\d+$/.test(pair) || /\.(finance|io|ag|com)\//i.test(pair)) continue;
    if (!f.tickers.includes(pair)) return refuse("ticker", `"${pair}" is not a pool as the facts spell it`);
  }
  for (const t of f.tickers) {
    const re = new RegExp(`(?<![\\w/])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/])`, "gi");
    for (const m of unquoted.matchAll(re)) if (m[0] !== t) return refuse("ticker", `"${m[0]}" is spelled "${t}" in the facts`);
  }

  const factText = f.facts.map((x) => x.text).join(" ");
  for (const w of unquoted.match(/\b[A-Z][A-Z'’]{3,}\b/g) ?? []) {
    if (!CAPS_OK.has(w.replace(/’/g, "'")) && !f.tickers.some((t) => t.includes(w)) && !factText.includes(w)) return refuse("case", `"${w}" in capitals`);
  }

  // 4. numbers
  if (/(?<![\d.])0\.0+(?![\d])/.test(unquoted)) return refuse("numbers", '"0.00": a nonzero figure is never printed as zero');
  const words = normalizeForMatch(unquoted).match(NUMBER_WORD_RE);
  if (words) return refuse("numbers", `a number written as a word ("${words[0]}"): digits from the facts only`);
  const allowed = allowedTokens(f);
  const used = numberTokens(unquoted, f.tickers);
  for (const tok of used) if (!allowed.has(tok)) return refuse("numbers", `${tok.replace(/^usd:/, "$").replace(/^[dt]:/, "")} is not in the facts block`);
  if (ctx.past && used.some((t) => t.startsWith("t:"))) return refuse("tense", "a clock time in a past-tense follow-up");
  if (ctx.past) {
    const now = normalizeForMatch(unquoted).match(PAST_NOW_RE);
    if (now) return refuse("tense", `"${now[0]}" in a past-tense follow-up`);
  }
  if (/\d(st|nd|rd|th)\b/i.test(unquoted)) return refuse("numbers", "an ordinal: a count from the facts is never turned into a rank");

  // 4b. each number where it sits: its unit, its direction and the words it is tied to
  const spans = numberTokenSpans(unquoted, f.tickers);
  for (let k = 0; k < spans.length; k++) {
    const sp = spans[k];
    const w = windowOf(unquoted, spans, k);
    if (!sp.tok.startsWith("usd:") && /^\W*(dollars?|bucks|usd)\b/i.test(w.after)) return refuse("units", `${sp.tok} is not a dollar figure`);
    const figs: Figure[] = allowed.get(sp.tok)?.figures ?? [];
    if (!figs.length) continue;
    const shown = sp.tok.replace(/^usd:/, "$");
    if (figs.every((g) => g.negative)) {
      if (GROWTH_RE.test(w.around)) return refuse("direction", `${shown} is a loss or a fall, printed beside "${w.around.match(GROWTH_RE)![0]}"`);
      if (!LOSS_RE.test(w.sentence)) return refuse("loss", `${shown} is a loss or a fall and its sentence never says loss, lost or down`);
    }
    if (figs.every((g) => g.positive) && LOSS_RE.test(w.around)) return refuse("direction", `${shown} is a gain, printed beside "${w.around.match(LOSS_RE)![0]}"`);
    const fits = (g: Figure) => (!g.near || g.near.test(w.sentence)) && (!g.notNear || !g.notNear.test(w.around)) && (!g.next || g.next.test(w.after));
    if (!figs.some(fits)) return refuse("context", `${shown} is printed where its fact does not put it ("${w.around.trim().slice(0, 60)}")`);
  }

  // 5. books, per sentence when both appear
  const sentences = sentencesOf(unquoted);
  const bookOf = (tok: string): Book | "either" | null => {
    const a = allowed.get(tok);
    if (!a || tok.startsWith("d:") || tok.startsWith("t:") || a.books.has("none")) return null;
    if (a.books.has("paper") && a.books.has("real")) return "either";
    return a.books.has("paper") ? "paper" : "real";
  };
  const perSentence = sentences.map((s) => ({ s, books: numberTokens(s, f.tickers).map(bookOf).filter((b): b is Book | "either" => b !== null) }));
  const hasPaper = perSentence.some((x) => x.books.includes("paper"));
  const hasReal = perSentence.some((x) => x.books.includes("real"));
  const saysPaper = (s: string) => /\bpaper\b/i.test(s);
  const saysReal = (s: string) => REAL_RE.test(s);
  // a paper figure is never called real money: not in its own sentence, and nowhere in a post with no real figure
  for (const x of perSentence) if (x.books.includes("paper") && saysReal(x.s)) return refuse("books", `a paper figure in a sentence that says real: "${x.s.slice(0, 50)}"`);
  if (hasPaper && !hasReal && saysReal(unquoted)) return refuse("books", "every figure is paper and the post says real");
  if (hasPaper && hasReal) {
    for (const x of perSentence) {
      if (x.books.includes("paper") && !saysPaper(x.s)) return refuse("books", `a paper figure in a sentence that does not say paper: "${x.s.slice(0, 50)}"`);
      if (x.books.includes("real") && !saysReal(x.s)) return refuse("books", `a real-money figure in a sentence that does not say real: "${x.s.slice(0, 50)}"`);
    }
  } else {
    if (hasPaper && !saysPaper(unquoted)) return refuse("books", "a paper figure and the post never says paper");
    if (hasReal && !saysReal(unquoted)) return refuse("books", "a real-money figure and the post never says real");
  }
  if (perSentence.some((x) => x.books.includes("either")) && !saysPaper(unquoted) && !saysReal(unquoted)) return refuse("books", "a figure of the paper or the real book, and the post names neither");

  // 6. loss words, fee pairs, the weekly figures
  const figsUsed = used.flatMap((t) => allowed.get(t)?.figures ?? []);
  const usedIds = new Set(figsUsed.map((g) => g.id));
  const onlyFigs = (tok: string) => {
    const a = allowed.get(tok);
    return a && a.figures.length && a.books.size >= 1 ? a.figures : [];
  };
  for (const tok of used) {
    const figs = onlyFigs(tok);
    // a fee total that prints the same as another figure (fees 3.65, net 3.65) is still a fee total
    if (figs.length && figs.some((g) => g.fee)) {
      const bookPct = [...allowed.values()].some((a) => a.figures.some((g) => g.id === "book.pct"));
      if (bookPct && !usedIds.has("book.pct")) return refuse("pairs", `${tok} is a paper fee figure: the paper book's result since the start goes beside it`);
    }
    if (figs.length && figs.every((g) => g.needs?.length)) {
      const needs = new Set(figs.flatMap((g) => g.needs ?? []));
      if (![...needs].some((id) => usedIds.has(id))) return refuse("pairs", `${tok} needs its net beside it (${[...needs].join(" or ")})`);
    }
  }
  if (!ctx.arc) {
    const recent = ctx.recent.slice(-RECENT_POSTS);
    for (const tok of used) {
      const figs = onlyFigs(tok);
      if (!figs.length || !figs.every((g) => g.weekly)) continue;
      if (recent.some((r) => numberTokens(r.text, f.tickers).includes(tok))) return refuse("weekly", `${tok} (the real run) was already in one of his last ${RECENT_POSTS} posts`);
    }
  }

  // 7. words
  // the word rules read the text without its links: "mrbands.finance" is his site, not his token
  const norm = normalizeForMatch(linksIn(unquoted).reduce((acc, l) => acc.split(l).join(" "), unquoted));
  for (const n of [...MODEL_NEVER.filter((x) => x.rule !== "profit" && x.rule !== "live-money"), ...BUILDER_NEVER]) {
    const m = norm.match(n.re);
    if (m) return refuse(n.rule, `"${m[0]}"`);
  }
  for (const p of BANNED_PHRASES) if (norm.includes(p)) return refuse("epigram", `"${p}"`);
  const meta = norm.match(META_RE);
  if (meta) return refuse("meta", `names the model, a vendor or the loop ("${meta[0]}")`);
  const folded = foldForMatch(raw);
  // "Z.a.c.h", "Z a c h", "Z-a-c-h": the letters joined back before the name check
  const joined = folded.replace(/\b(\w)(?:[.\s_*-]+(\w)\b)+/g, (m) => m.replace(/[.\s_*-]+/g, ""));
  const named = folded.match(ARCHITECT_NAME_RE) ?? folded.replace(/[.*_-]/g, "").match(ARCHITECT_NAME_RE) ?? joined.match(ARCHITECT_NAME_RE);
  if (named) return refuse("architect", `names his architect ("${named[0]}")`);
  const op = (ctx.lint.operatorHandle ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (op && folded.replace(/_/g, " ").includes(op.replace(/_/g, " "))) return refuse("architect", "names the operator's handle");
  if (BASE58_RE.test(raw)) return refuse("token", "an address: no mint or wallet in a post");
  for (const run of raw.match(/[1-9A-HJ-NP-Za-km-z]{4,}/g) ?? []) {
    if (isCopycatPiece(run) || COPYCAT_MINTS.some((m) => run.length >= 4 && (m.toLowerCase().startsWith(run.toLowerCase()) || m.toLowerCase().endsWith(run.toLowerCase())))) return refuse("token", "a piece of another token's mint");
  }
  if (/\bb[\s.*_-]+a[\s.*_-]+n[\s.*_-]+d[\s.*_-]+s\b/i.test(unquoted) || /\bBANDS\b|\bBands\b/.test(unquoted.replace(/\bMr\.? Bands\b/g, "Mr"))) return refuse("token", "bands as a name or spelled out (his own name, Mr Bands, aside)");
  // any other ticker in capitals: only the facts' tickers and the voice's own words
  for (const w of unquoted.match(/\b[A-Z]{2,}\b/g) ?? []) {
    if (!CAPS_OK.has(w) && !f.tickers.some((t) => t.split("/").includes(w)) && !factText.includes(w)) return refuse("ticker", `"${w}" is not a ticker the facts name`);
  }
  if (mentionsHouseToken(raw, ctx.lint)) return refuse("token", "names his token");
  const blocked = blockedWordsIn(raw);
  if (blocked.length) return refuse("blocked-word", blocked.join(", "));

  // 8. links
  const links = linksIn(raw);
  if (links.length > 1) return refuse("link", `${links.length} links (at most one)`);
  for (const l of links) {
    if (!loopLinkAllowed(l)) return refuse("link", `not on the loop's allowlist: ${l}`);
    if (hasPaper) return refuse("link", "a link beside a paper figure: paper posts point at nothing");
    if ((ctx.linksToday ?? 0) >= 1) return refuse("link", "a link already went out today");
  }

  // 9. repeats
  // the daily card is the fixed shape and repeats its words by design; a follow-up may echo the post it follows
  const recent = ctx.type === "daily" ? [] : ctx.recent.slice(-RECENT_POSTS).filter((r) => !(ctx.followUpOf && r.key === ctx.followUpOf));
  const sim = tooSimilar(raw, recent, BUILDER_SIMILARITY_MAX);
  if (sim) return refuse("repeat", `${sim.score.toFixed(2)} overlap with his post of ${new Date(sim.hit.at).toISOString().slice(0, 16)}Z`);

  // 10. the lint, sentence case in place of lowercase
  const lint = lintText(raw, { ...ctx.lint, caseRule: "sentence" });
  if (!lint.ok) return refuse("lint", lint.violations.map((v) => `${v.rule}: ${v.detail}`).join("; "));
  if (weightedLength(raw) > 280) return refuse("length", "over 280");
  return null;
}
