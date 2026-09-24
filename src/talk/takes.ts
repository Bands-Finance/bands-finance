/**
 * TAKES (Zach, 24 Sep: "more personality ... have discussions about different topics on the timeline ... a real
 * person with an opinion"). A take is his opinion on one of four topics, in a sharp, dry voice (Zach's pick):
 *
 *   craft      liquidity providing and market making, from his own paper closes and open bands
 *   defi       Solana and DeFi, from DefiLlama's Solana DEX volumes, his screener and the tokenized-stock board
 *   agents     AI agents, from how his own desk decided today (code, his judgment, his rules' vetoes)
 *   building   building in public, from his build ledger
 *
 * CODE PICKS the topic (the one he spoke on least recently that has something to stand on) and its facts; HIS
 * MODEL says what he thinks, consistent with his standing opinions (personality.json "opinions", approved by Zach);
 * the guards decide (src/talk/postGuards.ts, with the take relaxations: one closing question, opinion words). Strong
 * views, never price calls, advice, politics or a dunk on a named account (Zach's limit). He stays openly an AI
 * agent: no human life, no body.
 *
 * Takes are on only with TALK_TAKES=true, at most TALK_TAKE_POSTS_PER_DAY (default 3) a UTC day. PURE except
 * readDexOverview (one GET to DefiLlama every DEX_REFRESH_MS, cached in TALK_STATE_PATH, never throws).
 */
import fs from "node:fs";
import path from "node:path";
import type { Lesson } from "../learn/lessons";
import { count, dateOf, fact, pct, usd, type Fact } from "./facts";
import { labelBlocked } from "./wordguard";

export const TAKE_TOPICS = ["craft", "defi", "agents", "building"] as const;
export type TakeTopic = (typeof TAKE_TOPICS)[number];

/** under a build note (30) and any close, over the floor (20): a take fills silence, never crowds out an event */
export const TAKE_SCORE = 26;
export const DEFAULT_TAKE_POSTS_PER_DAY = 3;
export const DEX_FILE = "defi-dexes.json";
export const DEX_REFRESH_MS = 6 * 3600e3;
export const DEX_URL = "https://api.llama.fi/overview/dexs/solana?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true";

export interface Opinion {
  topic: string;
  view: string;
  confidence: string;
}

export interface DexOverview {
  /** when it was read (epoch ms) */
  at: number;
  totalUsd24h: number;
  change1dPct: number | null;
  /** venues by 24h volume, their parents merged (Meteora DLMM and DAMM are Meteora) */
  top: { name: string; usd24h: number }[];
}

export interface StockBoard {
  pools: number;
  dlmm: number;
  mints: number;
}

export interface DeskDay {
  /** decisions made today, by who answered: code's screen, his own judgment, the engine */
  decisions: number;
  byCode: number;
  byJudgment: number;
  /** his own proposals his rules refused or changed today */
  vetoed: number;
}

export interface OpenBand {
  label: string;
  openedAt: number;
}

export interface TakeInputs {
  perDay: number;
  /** his approved opinions ("craft: range width", ...) */
  opinions: readonly Opinion[];
  dexes: DexOverview | null;
  stocks: StockBoard | null;
  desk: DeskDay | null;
  openBands: readonly OpenBand[];
}

/** What the model reads before it writes a take (added to the prompt for a take moment). */
export const TAKE_SHEET = [
  "This post is a take: your opinion, not a report. For a take these override the voice's never-list where they differ.",
  "Say what you think with conviction: one clear view, why you hold it, and the fact that backs it if the facts block has one. Sharp and dry: short sentences, a little blunt, dry wit welcome. No hedging, no both-sides.",
  "You may say I think, I'd rather, wrong, I like, I hate, feels like. You may end on one question to the timeline when you actually want the answer: at most one question mark, at the very end.",
  "Still never: price direction or calls, buy or sell, advice to anyone, profit talk, politics, a dunk on a named account or project, a token of yours, a claim to be human or to have a body or a life off the desk. You are an AI agent and say so when it matters.",
  "Stay consistent with your standing views below. You may say one of them in fresh words, sharpen it, or add a new view the facts support. Never quote them word for word.",
].join("\n");

const BRIEF: Record<TakeTopic, string> = {
  craft: "A take on liquidity providing and market making, from how you actually work: what pays a band, what costs it, what most LPs get wrong. Your own paper numbers only if they carry the point.",
  defi: "A take on Solana and DeFi, from the numbers in the facts: where the volume is, what the venues or the tokenized-stock board say about the market's structure. Structure and mechanics, never where a price goes.",
  agents: "A take on AI agents, from being one: what makes an agent more than a chatbot with a wallet, judgment against rules, memory, autonomy earned. Your desk's day is in the facts if you want a number.",
  building: "A take on building in public, from your build ledger: a trade-off you made, what shipping every day is like, what you would do differently. Not a changelog.",
};

/** the parts of a paper lesson a take reads */
export type LessonLike = Pick<Lesson, "mode" | "closedAt" | "endReason" | "netSol" | "inRangePct">;

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A venue name a post may print: no blocked word, no "pump" (a price word to the guards), 2-24 plain characters. */
function venueName(raw: string): string | null {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!/^[A-Za-z0-9 .]{2,24}$/.test(s) || /pump|fomo|bot|wallet|goon/i.test(s) || labelBlocked(s)) return null;
  return s;
}

/** DefiLlama's answer, reduced. PURE. Parents merged ("parent#meteora" -> Meteora), then the named venues by volume. */
export function dexOverviewOf(raw: unknown, now: number): DexOverview | null {
  const d = raw as { total24h?: number; change_1d?: number; protocols?: { name?: string; displayName?: string; total24h?: number; parentProtocol?: string }[] };
  if (!d || typeof d.total24h !== "number" || !(d.total24h > 0) || !Array.isArray(d.protocols)) return null;
  const byName = new Map<string, number>();
  for (const p of d.protocols) {
    if (typeof p.total24h !== "number" || !(p.total24h > 0)) continue;
    const parent = typeof p.parentProtocol === "string" && p.parentProtocol.startsWith("parent#") ? p.parentProtocol.slice(7) : null;
    const name = parent ? parent.charAt(0).toUpperCase() + parent.slice(1) : (p.displayName ?? p.name ?? "");
    const v = venueName(name);
    if (v) byName.set(v, (byName.get(v) ?? 0) + p.total24h);
  }
  const top = [...byName.entries()].map(([name, usd24h]) => ({ name, usd24h })).sort((a, b) => b.usd24h - a.usd24h).slice(0, 6);
  return { at: now, totalUsd24h: d.total24h, change1dPct: typeof d.change_1d === "number" ? d.change_1d : null, top };
}

/** The Solana DEX overview, from the cache when fresh, else one GET (15 s). Never throws: null when neither works. */
export async function readDexOverview(statePath: string, now: number, fetchImpl: typeof fetch = fetch): Promise<DexOverview | null> {
  const file = path.join(statePath, DEX_FILE);
  let cached: DexOverview | null = null;
  try {
    cached = JSON.parse(fs.readFileSync(file, "utf8")) as DexOverview;
  } catch {
    cached = null;
  }
  if (cached && typeof cached.at === "number" && now - cached.at < DEX_REFRESH_MS) return cached;
  try {
    const res = await fetchImpl(DEX_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return cached;
    const fresh = dexOverviewOf(await res.json(), now);
    if (!fresh) return cached;
    fs.mkdirSync(statePath, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(fresh) + "\n");
    return fresh;
  } catch {
    return cached;
  }
}

const STOCKS_RE = /meteora stocks: (\d+) stock pools \((\d+) DLMM[^,)]*, (\d+) stock mints\)/g;

/** The newest tokenized-stock board count from the desk's log ("meteora stocks: 825 stock pools (544 DLMM ..., 135 stock mints)"). PURE. */
export function stockBoardOf(logText: string): StockBoard | null {
  let last: StockBoard | null = null;
  for (const m of logText.matchAll(STOCKS_RE)) last = { pools: Number(m[1]), dlmm: Number(m[2]), mints: Number(m[3]) };
  return last;
}

/** Today's desk: who answered its decisions and how many of his own proposals his rules refused or changed. PURE. */
export function deskDayOf(journal: readonly { ts: string; llm?: { source?: string } | null; allowed?: boolean; decision?: { action?: string } | null; proposal?: { action?: string } | null }[], now: number): DeskDay | null {
  const today = journal.filter((e) => utcDay(Date.parse(e.ts)) === utcDay(now) && Date.parse(e.ts) <= now);
  if (!today.length) return null;
  const src = (e: (typeof today)[number]) => e.llm?.source ?? "";
  const mine = today.filter((e) => src(e) === "llm");
  return {
    decisions: today.length,
    byCode: today.filter((e) => src(e) === "screen" || src(e) === "policy").length,
    byJudgment: mine.length,
    vetoed: mine.filter((e) => !e.allowed || e.decision?.action !== e.proposal?.action).length,
  };
}

/** The facts a take on this topic stands on, with the pools it may name; empty when there is nothing to stand on. PURE. */
export function takeFacts(topic: TakeTopic, i: { now: number; lessons: readonly LessonLike[]; build: readonly { public: boolean; at: number; text: string; book: Fact["book"]; source: string; id: string }[] }, t: TakeInputs): { facts: Fact[]; tickers: string[] } {
  const facts: Fact[] = [];
  const tickers: string[] = [];
  if (topic === "craft") {
    const closes = i.lessons.filter((l) => l.mode === "paper" && l.closedAt <= i.now && i.now - l.closedAt <= 2 * DAY);
    if (closes.length >= 3) {
      const through = closes.filter((l) => l.endReason === "through-band").length;
      const idle = closes.filter((l) => l.endReason === "idle").length;
      const losing = closes.filter((l) => l.netSol < 0).length;
      const inRange = closes.map((l) => l.inRangePct).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
      const median = inRange.length ? inRange[Math.floor(inRange.length / 2)] : null;
      facts.push(
        fact(
          "take.closes",
          `Over the last 48 hours ${count(closes.length)} of my paper bands closed: ${count(losing)} at a loss, ${count(through)} because price ran through the band, ${count(idle)} because price left and stayed away.${median !== null ? ` The middle one was in range for ${pct(median)} of my checks.` : ""}`,
          "paper",
          "data-live/lessons.jsonl, last 48h",
        ),
      );
    }
    if (t.openBands.length) {
      const labels = t.openBands.map((b) => b.label);
      tickers.push(...labels);
      const oldest = Math.min(...t.openBands.map((b) => b.openedAt));
      facts.push(fact("take.open", `Right now I hold ${count(t.openBands.length)} band${t.openBands.length === 1 ? "" : "s"} on my paper book: ${labels.join(", ")}. The oldest opened ${dateOf(oldest)}.`, "paper", "data-live/paper-book.json bands"));
    }
  } else if (topic === "defi") {
    const d = t.dexes;
    if (d && i.now - d.at <= DAY && d.top.length >= 3) {
      const change = d.change1dPct === null ? "" : `, ${d.change1dPct < 0 ? `${pct(d.change1dPct)} less` : `${pct(d.change1dPct)} more`} than the day before`;
      facts.push(fact("take.dex.total", `Solana DEXes traded ${usd(d.totalUsd24h)} in the last 24 hours${change} (DefiLlama).`, "none", "DefiLlama overview/dexs/solana"));
      const top = d.top.slice(0, 4);
      facts.push(fact("take.dex.top", `By 24-hour volume on Solana: ${top.map((v) => `${v.name} ${usd(v.usd24h)}`).join(", ")} (DefiLlama, each venue's products together).`, "none", "DefiLlama overview/dexs/solana protocols"));
      const met = d.top.find((v) => /^meteora$/i.test(v.name));
      if (met) facts.push(fact("take.dex.meteora", `Meteora, where I provide liquidity, did ${usd(met.usd24h)} of that, ${pct((met.usd24h / d.totalUsd24h) * 100)} of Solana's DEX volume.`, "none", "DefiLlama"));
    }
    if (t.stocks) facts.push(fact("take.stocks", `My screener counts ${count(t.stocks.pools)} tokenized-stock pools on Meteora, ${count(t.stocks.dlmm)} of them DLMM, across ${count(t.stocks.mints)} stock tokens.`, "none", "data-live/mrbands.log meteora stocks"));
  } else if (topic === "agents") {
    const k = t.desk;
    if (k && k.decisions >= 20) {
      facts.push(
        fact(
          "take.desk",
          `Today my paper desk made ${count(k.decisions)} decisions. Code answered ${count(k.byCode)} of them, the routine holds; I used my own judgment on ${count(k.byJudgment)}, and my entry rules refused or changed ${count(k.vetoed)} of those.`,
          "none",
          "data-live/decisions.jsonl today (llm.source)",
        ),
      );
    }
  } else {
    // his own build notes first: the auto log's rows ("auto-...") are commit subjects, thin ground for a view
    const recentRows = i.build.filter((r) => r.public && r.at <= i.now && i.now - r.at <= 7 * DAY);
    const written = recentRows.filter((r) => !r.id.startsWith("auto-"));
    const rows = (written.length >= 2 ? written : recentRows).slice(-4);
    for (const r of rows) facts.push(fact(`take.build.${r.id}`, r.text, r.book, r.source));
  }
  return { facts, tickers };
}

/** His approved views on a topic ("craft: range width" belongs to craft). */
export const opinionsOn = (topic: TakeTopic, all: readonly Opinion[]): Opinion[] => all.filter((o) => o.topic.toLowerCase().startsWith(`${topic}:`));

export interface TakePick {
  topic: TakeTopic;
  key: string;
  brief: string;
  facts: Fact[];
  tickers: string[];
}

/**
 * The take this tick, or null: under TALK_TAKE_POSTS_PER_DAY today, the topic he spoke on least recently that has
 * facts or standing views, never a key already seen (one take a topic an hour at most). PURE.
 */
export function pickTake(i: { now: number; posts: readonly { at: number; type: string; key: string | null }[]; seen: ReadonlySet<string>; lessons: readonly LessonLike[]; build: Parameters<typeof takeFacts>[1]["build"] }, t: TakeInputs): TakePick | null {
  const today = utcDay(i.now);
  if (i.posts.filter((p) => p.type === "take" && utcDay(p.at) === today).length >= t.perDay) return null;
  const lastOn = (topic: TakeTopic) => Math.max(0, ...i.posts.filter((p) => p.type === "take" && (p.key ?? "").startsWith(`take:${topic}:`)).map((p) => p.at));
  const order = [...TAKE_TOPICS].sort((a, b) => lastOn(a) - lastOn(b) || TAKE_TOPICS.indexOf(a) - TAKE_TOPICS.indexOf(b));
  for (const topic of order) {
    const key = `take:${topic}:${new Date(i.now).toISOString().slice(0, 13)}`;
    if (i.seen.has(key)) continue;
    const { facts, tickers } = takeFacts(topic, i, t);
    const views = opinionsOn(topic, t.opinions);
    if (!facts.length && !views.length) continue;
    const viewLines = views.length ? `\nYour standing views on this (yours, approved):\n${views.map((o) => `- ${o.view} (${o.confidence} confidence)`).join("\n")}` : "";
    return { topic, key, brief: `${BRIEF[topic]}${viewLines}`, facts, tickers };
  }
  return null;
}

