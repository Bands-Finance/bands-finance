/**
 * The FACTS block of the builder voice (docs/talk.md, "The builder voice"), built by code. PURE.
 *
 * Every figure his model may print is written here, already rounded the way a person writes it (SOL to 2
 * decimals, 2 significant figures under 0.01 so a nonzero loss never reads 0.00, whole percents, dollars with
 * commas or an M), and tagged with the book it belongs to: "paper" (the paper book, virtual money at live prices),
 * "real" (the one real-money run, 17 to 19 Sep) or "none" (a date, a build count, a price of a model call). The
 * guards (src/talk/postGuards.ts) read the same block: a number in a post that is not in it, a paper figure in a
 * post that never says paper, or a fee total without the net it `needs`, is refused.
 *
 * The paper book's honest headline is in every block that carries a paper figure: down about N% at today's SOL
 * price since the book started, with the SOL/USD valuation term (src/paper/report.ts) named, so a fee total never
 * goes out without the book's result beside it.
 */
import type { PaperBook } from "../paper/book";
import type { PaperSummary } from "../paper/report";

export type Book = "paper" | "real" | "none";

export interface Figure {
  /** unique inside a block ("book.down", "close.net") */
  id: string;
  /** exactly as it may be printed ("0.55", "18%", "$0.29", "10,000") */
  text: string;
  book: Book;
  /** a loss or a fall: the post must say loss, lost or down when it prints this one */
  negative?: boolean;
  /** figure ids of which at least one must also be printed when this one is (a fee total needs its net) */
  needs?: string[];
  /** printed in one of his last 14 posts already: a repeat unless the moment is an arc post (the real-run tagline) */
  weekly?: boolean;
  /** a paper fee figure: printed only with the paper book's result (book.pct) beside it, besides its `needs` */
  fee?: boolean;
  /** a gain or a rise: never printed next to loss, lost, down or lower */
  positive?: boolean;
  /** the sentence that prints it must match (150 only beside "start", 11.19 only beside "SOL/USD" or "valuation") */
  near?: RegExp;
  /** the few words around it (6 before, 3 after, never past the next number) must not match */
  notNear?: RegExp;
  /** the words right after it (up to 3, never past the next number) must match ("36 bands", "27 up") */
  next?: RegExp;
}

export interface Fact {
  id: string;
  /** a plain sentence, the figures in it pre-rounded; the model rewords it, it never computes */
  text: string;
  book: Book;
  /** the file or record it comes from (for the log and the reviewer, never printed) */
  source: string;
  figures: Figure[];
}

export interface FactsBlock {
  key: string;
  facts: Fact[];
  /** pool and ticker labels exactly as a post must spell them ("ORE/SOL", "NVDAx") */
  tickers: string[];
  /** journal lines he may quote word for word (at most one quote a post) */
  quotes: string[];
}

// ---------------------------------------------------------------- formats

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** SOL (or USDC) in prose: 2 decimals, or 2 significant figures under 0.01 (never "0.00" for a nonzero amount); unsigned. */
export function amt(n: number): string {
  const a = Math.abs(n);
  if (a === 0) return "0";
  if (a < 0.01) return String(Number(a.toPrecision(2)));
  return withCommas(a.toFixed(2));
}

/** A whole percent, unsigned ("18%"). */
export const pct = (n: number): string => `${Math.round(Math.abs(n))}%`;

/** Dollars as a person writes them: "$0.29", "$4.74M", "$25,480". */
export function usd(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1000) return `$${withCommas(String(Math.round(a)))}`;
  return `$${a.toFixed(2)}`;
}

/** A count with commas ("4,043"). */
export const count = (n: number): string => withCommas(String(Math.round(n)));

function withCommas(s: string): string {
  const [i, d] = s.split(".");
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${d !== undefined ? `.${d}` : ""}`;
}

/** "22 Sep" */
export const dateOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

/** "15:03 UTC" */
export const timeOf = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** Hours held, one decimal under 10 ("4.3"), whole above. */
export const hoursOf = (ms: number): string => {
  const h = ms / 3600e3;
  return h < 10 ? h.toFixed(1) : String(Math.round(h));
};

// ---------------------------------------------------------------- number tokens (shared with the guards)

const MONTH_RE = MONTHS.join("|");
/**
 * Every number-like token of a text, normalized: "d:22 Sep" for a date, "t:15:03" for a clock time, "usd:0.29" for a
 * dollar figure ("$0.29"; "$4.74M" reads "usd:4.74M"), and the plain value otherwise ("5,149.95" and "5149.95" both
 * read "5149.95", "18%" reads "18"). The unit stays in the token: a SOL figure printed with a "$" is not the SOL
 * figure. A sign is not part of a token: the loss rule reads the words. Tickers are taken out first ("ai16z/SOL"
 * carries no number), and digits inside a word ("x402", a handle) are not a figure.
 */
export function numberTokens(text: string, tickers: readonly string[] = []): string[] {
  return numberTokenSpans(text, tickers).map((x) => x.tok);
}

export interface NumberSpan {
  tok: string;
  /** where it sits in the text given */
  start: number;
  end: number;
}

/** numberTokens with where each one sits (tickers are blanked in place, so the positions are the text's own). */
export function numberTokenSpans(text: string, tickers: readonly string[] = []): NumberSpan[] {
  let s = ` ${text} `;
  for (const t of [...tickers].sort((a, b) => b.length - a.length)) if (t) s = s.split(t).join(" ".repeat(t.length));
  const out: NumberSpan[] = [];
  const re = new RegExp(`(\\d{1,2}) (${MONTH_RE})\\b|(\\d{1,2}):(\\d{2})|(?<![A-Za-z_0-9])(\\$?)(\\d+(?:,\\d{3})*(?:\\.\\d+)?)([MKB]\\b)?`, "g");
  for (const m of s.matchAll(re)) {
    const start = (m.index ?? 0) - 1;
    const end = start + m[0].length;
    if (m[1]) out.push({ tok: `d:${Number(m[1])} ${m[2]}`, start, end });
    else if (m[3]) out.push({ tok: `t:${m[3].padStart(2, "0")}:${m[4]}`, start, end });
    else if (m[6]) out.push({ tok: `${m[5] ? "usd:" : ""}${String(Number(m[6].replace(/,/g, "")))}${m[7] ?? ""}`, start, end });
  }
  return out;
}

// ---------------------------------------------------------------- builders

let seq = 0;
const fig = (id: string, text: string, book: Book, extra: Partial<Figure> = {}): Figure => ({ id, text, book, ...extra });

/** Contexts a figure is tied to (the guards' "context" rule): the words a number may be printed beside. */
export const CTX = {
  /** a starting amount: beside the start, never as a result */
  start: { near: /\b(start|started|starting|began|begun|seeded|with|paper|book)\b/i, notNear: /\b(lost|loss|losses|down|up|made|earned|gained|kept|fees?|profit\w*|result)\b/i },
  /** a fee total: beside the word fees */
  fees: { near: /\bfees?\b/i },
  /** the SOL/USD valuation term: beside SOL/USD, valuation or the dollar, never as trading */
  valuation: { near: /SOL\/USD|\bvaluation\b|\bdollar\b/i, notNear: /\b(trad(e|es|ed|ing)|made|earned|desk|fees?|profit\w*|gained)\b/i },
  /** a count of days */
  days: { next: /^\W*days?\b/i },
  /** hours held */
  hours: { next: /^\W*(hours?|hrs?|h)\b/i },
  /** a share of checks in range: never a rate or a return */
  inRange: { near: /\brange\b/i, notNear: /\b(returns?|yield\w*|roi|apy|apr|profit\w*|rate)\b/i },
  /** the book's result in percent */
  bookPct: { near: /\b(book|since|start|started)\b/i },
};
export const fact = (id: string, text: string, book: Book, source: string, figures: Figure[] = []): Fact => ({ id, text, book, source, figures });
/** a fresh id suffix for facts made in a loop */
export const nextId = (p: string) => `${p}.${++seq}`;

/** The dates of his arc: judging, the end of paper, the real run. */
export const ARC = {
  realRunFrom: Date.parse("2026-09-17T10:34:00Z"),
  realRunTo: Date.parse("2026-09-19T01:44:00Z"),
  judgingFrom: Date.parse("2026-09-28T00:00:00Z"),
  judgingTo: Date.parse("2026-10-07T23:59:59Z"),
  paperUntil: Date.parse("2026-10-08T23:59:59Z"),
  /** the day both sites stopped showing the paper book (git 6d9c796, 0506fa4) */
  sitesRealOnly: Date.parse("2026-09-22T12:00:00Z"),
};

/**
 * His one real-money run, settled (web/public/live-run.json settled; docs/sprint.md "One headline number"): 19.79 SOL
 * in, 19.71 out, 7.91 SOL of fees claimed, 0.08 SOL down. Constants: the run is over and its record is frozen.
 */
export const REAL_RUN = { startSol: 19.79, endSol: 19.7125, feesSol: 7.9126, netSol: -0.0775 };

/**
 * The facts every block carries: where he stands (the book is paper for now, and its start) and the arc's dates. No
 * end date for the paper book and no countdown to one (Zach, 22 Sep: "can we not give a date of how long we are going
 * to be running on a paper book"); vetBuilderPost refuses one too.
 */
export function standingFacts(o: { now: number; startSol: number; startUsdc: number; startedAt: number }): Fact[] {
  return [
    fact("today", `Today is ${dateOf(o.now)}.`, "none", "the clock", []),
    fact(
      "paper.start",
      `My book is paper for now: virtual money against live prices, started ${dateOf(o.startedAt)} with ${count(o.startSol)} SOL and ${count(o.startUsdc)} USDC.`,
      "paper",
      "data-live/paper-book.json startSol, startUsdc, startedAt",
      [fig("paper.startSol", count(o.startSol), "paper", CTX.start), fig("paper.startUsdc", count(o.startUsdc), "paper", CTX.start)],
    ),
    // the runtime he runs on, named in public on purpose (Zach, 22 Sep: "include some discussion about openhermit")
    fact("runtime", "I run on OpenHermit, an agentic runtime: it keeps my memory between sessions, gives me my tools, and holds the rules on what I may call.", "none", "docs/openhermit.md", []),
    fact("arc.judging", `AnsemHack's Clawrena judges the entries ${dateOf(ARC.judgingFrom)} to ${dateOf(ARC.judgingTo)}.`, "none", "docs/clawrena.md", []),
  ];
}

/** The real run, as facts (book "real"); its figures are the weekly kind: once in 14 posts outside an arc post. */
export function realRunFacts(): Fact[] {
  return [
    fact(
      "real.run",
      `My one real-money run, 17 to ${dateOf(ARC.realRunTo)}, went from ${amt(REAL_RUN.startSol)} to ${amt(REAL_RUN.endSol)} SOL: ${amt(REAL_RUN.feesSol)} SOL in fees, and still ${amt(REAL_RUN.netSol)} SOL down.`,
      "real",
      "web/public/live-run.json settled; docs/sprint.md 'One headline number'",
      [
        fig("real.start", amt(REAL_RUN.startSol), "real", { weekly: true, notNear: CTX.start.notNear }),
        fig("real.end", amt(REAL_RUN.endSol), "real", { weekly: true }),
        fig("real.fees", amt(REAL_RUN.feesSol), "real", { weekly: true, needs: ["real.net", "real.end"], ...CTX.fees }),
        fig("real.net", amt(REAL_RUN.netSol), "real", { weekly: true, negative: true }),
      ],
    ),
  ];
}

/**
 * The paper book's honest headline (src/paper/report.ts paperSummary): equity now against the start valued at
 * today's SOL price, the percent, the SOL/USD valuation term, and the fees realized since the start (which need the
 * headline beside them). Null without a summary.
 */
export function bookHeadlineFacts(s: Pick<PaperSummary, "startedAt" | "equity" | "feesRealizedSol"> | null): Fact[] {
  if (!s) return [];
  const e = s.equity;
  const since = dateOf(Date.parse(s.startedAt));
  const down = e.vsStartSol < 0;
  const out: Fact[] = [
    fact(
      "book.headline",
      `My paper book is ${down ? "down" : "up"} about ${pct(e.vsStartPct)} since ${since}, measured in SOL at today's SOL price: ${amt(e.sol)} SOL now against ${amt(e.sol - e.vsStartSol)} SOL for the start.`,
      "paper",
      "src/paper/report.ts paperSummary equity (vsStartSol, vsStartPct)",
      [
        fig("book.pct", pct(e.vsStartPct), "paper", { negative: down, positive: !down && e.vsStartSol > 0, ...CTX.bookPct }),
        fig("book.now", amt(e.sol), "paper", { notNear: /\b(made|earned|gained|profit\w*|fees?)\b/i }),
        fig("book.start", amt(e.sol - e.vsStartSol), "paper", CTX.start),
      ],
    ),
  ];
  if (typeof e.valuationSol === "number" && Math.abs(e.valuationSol) >= 0.005) {
    out.push(
      fact(
        "book.valuation",
        `${amt(e.valuationSol)} SOL of that result is the SOL/USD valuation term, ${e.valuationSol >= 0 ? "in my favour" : "against me"}: the USDC side re-priced at today's SOL price. It is SOL's move against the dollar, not trading.`,
        "paper",
        "src/paper/report.ts equity.valuationSol",
        [fig("book.valuation", amt(e.valuationSol), "paper", { negative: e.valuationSol < 0, positive: e.valuationSol > 0, needs: ["book.pct", "book.now"], ...CTX.valuation })],
      ),
    );
  }
  out.push(
    fact(
      "book.fees",
      `Fees realized on my paper book since ${since}: ${amt(s.feesRealizedSol)} SOL, counted from what traded through my own bins. Quote them only with the book's result beside them.`,
      "paper",
      "src/paper/report.ts feesRealizedSol (paper fees accrue from the flow scout's fees in his own bins since 22 Sep)",
      [fig("book.feesTotal", amt(s.feesRealizedSol), "paper", { needs: ["book.pct", "book.now"], fee: true, ...CTX.fees })],
    ),
  );
  return out;
}

/** How paper fees and swaps are counted since 22 Sep (git db33247, 00dc278): the old "pool's 24h figure halved" is gone. */
export function paperMethodFacts(): Fact[] {
  return [
    fact(
      "paper.method",
      "Since 22 Sep a paper band is credited only the fees my flow scout saw trade through its own bins, and a paper swap pays the price impact the pool's own bins would charge, capped at 8%.",
      "none",
      "git db33247 (fees from the flow scout's fees in his own bins); git 00dc278 (swap impact from the pool's bins, capped at 8%)",
      [fig("paper.impactCap", "8%", "none", { near: /\b(impact|cap|capped)\b/i })],
    ),
  ];
}

/** A block from facts; tickers and quotes are deduped. */
export function blockOf(key: string, facts: Fact[], tickers: readonly string[] = [], quotes: readonly string[] = []): FactsBlock {
  const seen = new Set<string>();
  const uniq = facts.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
  return { key, facts: uniq, tickers: [...new Set(tickers.filter(Boolean))], quotes: [...new Set(quotes.filter(Boolean))] };
}

/** Every allowed token of a block: normalized token -> the books and figures it can be. */
export interface AllowedToken {
  books: Set<Book>;
  figures: Figure[];
}

export function allowedTokens(b: FactsBlock): Map<string, AllowedToken> {
  const out = new Map<string, AllowedToken>();
  const add = (tok: string, book: Book, f: Figure | null) => {
    const cur = out.get(tok) ?? { books: new Set<Book>(), figures: [] };
    cur.books.add(book);
    if (f) cur.figures.push(f);
    out.set(tok, cur);
  };
  for (const f of b.facts) {
    for (const g of f.figures) for (const tok of numberTokens(g.text, b.tickers)) add(tok, g.book, g);
    // a date or a clock time belongs to no book: "8 Oct" is not a paper figure because a paper fact names it
    for (const tok of numberTokens(f.text, b.tickers)) add(tok, tok.startsWith("d:") || tok.startsWith("t:") ? "none" : f.book, null);
  }
  return out;
}

/** The block as the model reads it: one line per fact with its book, and the quotes. */
export function renderFacts(b: FactsBlock): string {
  const lines = b.facts.map((f) => `- [${f.book}] ${f.text}`);
  if (b.tickers.length) lines.push(`- pool and ticker spellings: ${b.tickers.join(", ")}`);
  for (const q of b.quotes) lines.push(`- a line from my journal you may quote word for word, in double quotes: "${q}"`);
  return lines.join("\n");
}

/** The paper book's start, from the book (or the defaults of the running desk). */
export function bookStartOf(book: Pick<PaperBook, "startSol" | "startUsdc" | "startedAt"> | null): { startSol: number; startUsdc: number; startedAt: number } {
  return { startSol: book?.startSol ?? 150, startUsdc: book?.startUsdc ?? 10000, startedAt: book ? Date.parse(book.startedAt) : Date.parse("2026-09-14T22:42:15Z") };
}
