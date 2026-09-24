/**
 * The builder voice's tests (src/talk/facts.ts, moments.ts, postGuards.ts, postBrain.ts, builder.ts, buildLedger.ts,
 * the correction and pinned kinds of announce.ts). No network: his agent is a fake askImpl, X a fake fetch, every
 * file lives in a temp dir.   npx tsx src/scripts/test-talk-builder.ts
 *
 * Covers: the facts block (rounding, never 0.00, the tokens the guards read, the paper book's headline with the
 * SOL/USD valuation term, dates in no book); the picker (the daily's hour and template, big losses kept their day,
 * past tense after 30 minutes, coverage, follow-ups, the retired kinds, silence under the floor, POSTS_PER_DAY, the
 * target, the gap, the window, the night, the daily's slot, one build note a day, learner and screener rationing,
 * promises done and slipped, stale data); the guards against hostile drafts; the model-call cap on disk; the
 * contract and fail-closed; the daily card's template fallback; runTick end to end in the builder voice (dry by
 * default, live only with TALK_BUILDER_LIVE, a down gateway spends nothing); the two one-offs; the build ledger.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mr-bands-builder-"));
process.env.DATA_DIR = tmp;
process.env.DRY_RUN = "true";
process.env.WALLET_SECRET_KEY = "";
for (const k of ["X_LIVE", "X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET", "OPERATOR_HANDLE", "X_HANDLE", "TALK_STATE_PATH", "POSTS_PER_DAY", "TALK_DAILY_HOUR_UTC", "TALK_VOICE", "TALK_BUILDER_LIVE", "OPENHERMIT_TOKEN", "TALK_MODEL_CALLS_PER_DAY"]) delete process.env[k];

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
}

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** a Wednesday, after the daily's hour */
const NOW = Date.parse("2026-09-23T16:10:00.000Z");
const START = Date.parse("2026-09-14T22:42:15.000Z");
const GATEWAY_TOKEN = "a".repeat(48);
const FAKE_CREDS = { X_API_KEY: "ck-test", X_API_SECRET: "cs-test-secret", X_ACCESS_TOKEN: "at-test", X_ACCESS_SECRET: "as-test-secret" };
const CTX = { operatorHandle: "louz514", houseSymbols: ["mrbands", "bands"], houseMints: [] as string[] };

async function main(): Promise<void> {
  const facts = await import("../talk/facts.js");
  const mo = await import("../talk/moments.js");
  const g = await import("../talk/postGuards.js");
  const brain = await import("../talk/postBrain.js");
  const builder = await import("../talk/builder.js");
  const ledger = await import("../talk/buildLedger.js");
  const announce = await import("../talk/announce.js");
  const tick = await import("../talk/tick.js");
  const lint = await import("../talk/lint.js");
  const x = await import("../talk/x.js");
  const { OpenHermitError } = await import("../agent/openhermit.js");
  const { emptyBook } = await import("../paper/book.js");
  const { COPYCAT_MINTS } = await import("../risk/house.js");
  type MomentInputs = import("../talk/moments").MomentInputs;
  type Lesson = import("../learn/lessons").Lesson;

  let n = 0;
  const dir = (name: string) => {
    const d = path.join(tmp, `${name}-${++n}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  // ------------------------------------------------------------ fixtures
  const SUMMARY = { startedAt: new Date(START).toISOString(), feesRealizedSol: 41.587108851, equity: { sol: 191.7816, vsStartSol: -43.0457, vsStartPct: -18.3308, valuationSol: 11.1858 } } as unknown as import("../paper/report").PaperSummary;
  const HEADLINE = facts.bookHeadlineFacts(SUMMARY);
  const DAYFIG = { feesRealizedSol: 8.2839, netRealizedSol: 0.2937, closedBands: 36, closedUp: 27 } as unknown as import("../talk/strap").StackFigures;
  const lesson = (o: { position: string; label: string; pool?: string; net: number; fees?: number; closedAt: number; openedAt?: number; headline?: string; inRange?: number }): Lesson =>
    ({
      at: o.closedAt, mode: "paper", pool: o.pool ?? `POOL-${o.position}`, label: o.label, position: o.position, kind: "memecoin", openedAt: o.openedAt ?? o.closedAt - 2 * HOUR, closedAt: o.closedAt, minutes: 120, seatSol: 20, bins: 7, binStep: 20, coverPct: 1, travelBins60m: null,
      inRangePct: o.inRange ?? 55, endReason: "close", feesSol: o.fees ?? 0.2289, netSol: o.net, tokensLeftSol: 0, predictedYieldPct: null, headline: o.headline ?? "twelve bins out, ten dry checks, closing the band back to sol",
    }) as unknown as Lesson;
  /** journal rows every 10 minutes across a band's life, so the coverage check passes */
  const journalFor = (pool: string, label: string, from: number, to: number, extra: Record<string, unknown> = {}) => {
    const out = [];
    for (let t = from; t <= to; t += 10 * MIN) out.push({ ts: new Date(t).toISOString(), pool: { address: pool, label }, positions: [], llm: { source: "policy" }, proposal: { action: "HOLD" }, decision: { action: "HOLD" }, allowed: true, violations: [], overrides: [], headline: "holding", ...extra });
    return out as unknown as import("../journal").JournalEntry[];
  };
  const base = (over: Partial<MomentInputs> = {}): MomentInputs => ({
    now: NOW, stale: null, bookStart: { startSol: 150, startUsdc: 10000, startedAt: START }, headline: HEADLINE, closed: [], day: DAYFIG, lessons: [], journal: [], journalFrom: NOW - 3 * DAY,
    learning: [], screen: [], build: [], posts: [], seen: new Set(), dailyHourUtc: 14, lastDailyDay: null, ...over,
  });
  const OPTS = { postsPerDay: 6, targetPerDay: 5, minGapMin: 90, gapJitterMin: 45, windowPosts: 2, windowHours: 6, dayStartUtc: 12, nightPosts: 2, jitter: () => 0 };
  const row = (o: Record<string, unknown>) => {
    const r = ledger.parseBuildRow({ at: "2026-09-23", kind: "shipped", public: true, source: "test", ...o });
    if (typeof r === "string") throw new Error(r);
    return r;
  };
  const post = (at: number, text: string, type = "build", key: string | null = null) => ({ at, text, type, key });

  // ------------------------------------------------------------ the facts block
  console.log("the facts block");
  await test("amounts: 2 decimals, 2 significant figures under 0.01, never 0.00 for a nonzero figure, commas, dollars, percents", () => {
    assert.equal(facts.amt(-0.548038), "0.55");
    assert.equal(facts.amt(0.0034), "0.0034");
    assert.equal(facts.amt(-0.00049), "0.00049");
    assert.equal(facts.amt(0), "0");
    assert.equal(facts.amt(5149.95), "5,149.95");
    assert.equal(facts.usd(0.29), "$0.29");
    assert.equal(facts.usd(4740512.75), "$4.74M");
    assert.equal(facts.usd(25480.4), "$25,480");
    assert.equal(facts.pct(-18.33), "18%");
    for (const v of [0.001, -0.004, 0.0049, -0.009]) assert.ok(!/^0\.00?$/.test(facts.amt(v)), `${v} never prints as zero`);
  });
  await test("number tokens: dates, clock times, dollars, commas and M read one way; tickers carry no number", () => {
    assert.deepEqual(facts.numberTokens("On 22 Sep at 15:03 UTC, $4.74M and 5,149.95 USDC, 18% down."), ["d:22 Sep", "t:15:03", "usd:4.74M", "5149.95", "18"]);
    assert.deepEqual(facts.numberTokens("ai16z/SOL paid 0.23", ["ai16z/SOL"]), ["0.23"]);
  });
  await test("the paper book's headline: down about 18% at today's SOL price, the SOL/USD valuation term, fees only beside the result", () => {
    const text = HEADLINE.map((f) => f.text).join(" ");
    assert.match(text, /down about 18% since 14 Sep, measured in SOL at today's SOL price/);
    assert.match(text, /11\.19 SOL of that result is the SOL\/USD valuation term/);
    assert.match(text, /41\.59 SOL/);
    const fees = HEADLINE.flatMap((f) => f.figures).find((x) => x.id === "book.feesTotal")!;
    assert.ok(fees.fee && fees.needs?.includes("book.pct"));
    assert.ok(HEADLINE.flatMap((f) => f.figures).find((x) => x.id === "book.pct")!.negative);
  });
  await test("a date or a clock time in a paper fact belongs to no book; its figures keep theirs", () => {
    const b = facts.blockOf("k", facts.standingFacts({ now: NOW, startSol: 150, startUsdc: 10000, startedAt: START }));
    const a = facts.allowedTokens(b);
    assert.deepEqual([...a.get("d:7 Oct")!.books], ["none"]);
    assert.ok(!a.has("d:8 Oct"), "no end date for the paper book (Zach, 22 Sep)");
    assert.ok(a.get("150")!.books.has("paper"));
  });

  await test("no end date for the paper book: the standing facts carry none, and a draft that names one is refused (Zach, 22 Sep)", () => {
    const b = facts.blockOf("k", facts.standingFacts({ now: NOW, startSol: 150, startUsdc: 10000, startedAt: START }));
    assert.ok(!b.facts.some((f) => /8 Oct|days are left|until after/i.test(f.text)));
    for (const bad of ["My book stays paper until after 8 Oct.", "16 days left on paper.", "I go live on 8 October.", "Paper ends soon, then real money from 9 Oct."]) {
      assert.ok(g.BUILDER_NEVER.some((n) => n.rule === "paper-end" && n.re.test(bad)), bad);
    }
    for (const ok of ["My book is paper for now.", "Judging runs 28 Sep to 7 Oct."]) assert.ok(!g.BUILDER_NEVER.find((n) => n.rule === "paper-end")!.re.test(ok), ok);
  });

  await test("the auto build log: commits become one plain row per day and area; private subjects, merges and unknown areas never do", async () => {
    const ab = await import("../talk/autoBuild.js");
    const at = Date.parse("2026-09-22T12:00:00Z");
    const rows = ab.rowsFromCommits([
      { sha: "a".repeat(40), at, subject: "paper: fees accrue from his own bins" },
      { sha: "b".repeat(40), at, subject: "paper: swaps pay price impact" },
      { sha: "c".repeat(40), at, subject: "openhermit: keep the clock out of the cached prompt" },
      { sha: "d".repeat(40), at, subject: "talk: the craft, learned from Merd's record" },
      { sha: "e".repeat(40), at, subject: "site: $MRBANDS off the page" },
      { sha: "f".repeat(40), at, subject: "launch: the bridge and the arm" },
      { sha: "0".repeat(40), at, subject: "model: the default is Opus 5.5" },
      { sha: "1".repeat(40), at, subject: "ops: DECIDER=openhermit on the paper desk" },
      { sha: "2".repeat(40), at, subject: "desk: half the triangles" },
      { sha: "3".repeat(40), at, subject: "Merge x-builder: the builder voice" },
      { sha: "4".repeat(40), at, subject: "security: rotate the admin token" },
    ]);
    assert.deepEqual(rows.map((r) => r.id).sort(), ["auto-20260922-openhermit", "auto-20260922-paper"]);
    const paper = rows.find((r) => r.id === "auto-20260922-paper")!;
    assert.match(paper.text, /^On 22 Sept? I changed my paper book: fees accrue from his own bins; swaps pay price impact\.$/);
    assert.match(rows.find((r) => r.id === "auto-20260922-openhermit")!.text, /OpenHermit, the agentic runtime I run on/);
    for (const r of rows) assert.ok(!/merd|mrbands|opus|zach|launch|token/i.test(r.text), r.text);
  });

  await test("the evening recap: after 20:00 UTC, once, naming the areas changed today (two or more)", async () => {
    const ab = await import("../talk/autoBuild.js");
    const rows = [{ id: "auto-20260922-paper", at: "2026-09-22" }, { id: "auto-20260922-openhermit", at: "2026-09-22" }, { id: "auto-20260921-web", at: "2026-09-21" }];
    const at20 = Date.parse("2026-09-22T20:05:00Z");
    const r = ab.recapRow(rows, at20, new Set())!;
    assert.equal(r.id, "auto-20260922-recap");
    assert.equal(r.text, "What I shipped today: changes to my paper book and OpenHermit, the agentic runtime I run on.");
    assert.equal(ab.recapRow(rows, Date.parse("2026-09-22T19:55:00Z"), new Set()), null, "not before 20:00 UTC");
    assert.equal(ab.recapRow(rows, at20, new Set(["auto-20260922-recap"])), null, "once a day");
    assert.equal(ab.recapRow(rows.slice(0, 1), at20, new Set()), null, "not for one area");
  });

  // ------------------------------------------------------------ the picker
  console.log("the picker");
  await test("the daily card: only 14:00-15:00 UTC, first in line, with a template built from the same facts that passes the guards", () => {
    const at = Date.parse("2026-09-22T14:20:00Z");
    const p = mo.pickMoment(base({ now: at }), OPTS);
    assert.equal(p.pick?.key, "daily:2026-09-22");
    const d = p.pick!;
    assert.equal(d.template, "Day 9 on paper: 8.28 SOL in fees over the last 24 hours, and 0.29 SOL kept after losses and costs. 36 bands closed, 27 up. The book is down about 18% since 14 Sep at today's SOL price.");
    assert.equal(g.vetBuilderPost(d.template!, { facts: d.facts, length: d.length, lint: CTX, recent: [], type: "daily" }), null);
    assert.ok(!mo.gatherMoments(base({ now: Date.parse("2026-09-22T15:05:00Z") })).some((m) => m.type === "daily"), "not after 15:00");
    assert.ok(!mo.gatherMoments(base({ now: Date.parse("2026-09-22T13:55:00Z") })).some((m) => m.type === "daily"), "not before 14:00");
    assert.ok(!mo.gatherMoments(base({ now: at, lastDailyDay: "2026-09-22" })).some((m) => m.type === "daily"), "once a day");
  });
  await test("the daily names the worst close by pool, down, and its template still passes", () => {
    const at = Date.parse("2026-09-22T14:20:00Z");
    const closed = [{ address: "a", label: "DFDVx/SOL", closedAt: at - HOUR, realizedSol: -2.2472 }, { address: "b", label: "ORE/SOL", closedAt: at - 2 * HOUR, realizedSol: -0.4999 }];
    const d = mo.gatherMoments(base({ now: at, closed })).find((m) => m.type === "daily")!;
    assert.match(d.template!, /The worst was DFDVx\/SOL, down 2\.25 SOL\./);
    assert.equal(g.vetBuilderPost(d.template!, { facts: d.facts, length: d.length, lint: CTX, recent: [], type: "daily" }), null);
  });
  await test("closes: a loss at or below -1 SOL stays its whole UTC day (past tense, urgent); a small close is dropped after 3 hours", () => {
    const big = lesson({ position: "big", label: "DFDVx/SOL", net: -2.7612, closedAt: NOW - 7 * HOUR });
    const small = lesson({ position: "small", label: "BP/SOL", net: 0.2, closedAt: NOW - 4 * HOUR });
    const fresh = lesson({ position: "fresh", label: "CATE/USDC", net: -0.31, closedAt: NOW - 10 * MIN });
    const journal = [...journalFor(big.pool, big.label, big.openedAt, big.closedAt), ...journalFor(small.pool, small.label, small.openedAt, small.closedAt), ...journalFor(fresh.pool, fresh.label, fresh.openedAt, fresh.closedAt)];
    const ms = mo.gatherMoments(base({ lessons: [big, small, fresh], journal }));
    const byKey = new Map(ms.map((m) => [m.key, m]));
    assert.ok(byKey.get("close:big")?.urgent && byKey.get("close:big")!.past, "the big loss, past tense");
    assert.ok(!byKey.has("close:small"), "a small close 4h old is dropped");
    assert.equal(byKey.get("close:fresh")?.past, false, "within 30 minutes: news");
    assert.ok(byKey.get("close:big")!.score > byKey.get("close:fresh")!.score);
    assert.ok(!byKey.get("close:big")!.facts.facts.some((f) => /\d\d:\d\d UTC/.test(f.text) && f.id === "close"), "a past-tense close carries no clock time");
  });
  await test("coverage: a close with a gap in the journal is left to the daily card, with a note", () => {
    const l = lesson({ position: "gap", label: "PLTRx/SOL", net: -3.66, closedAt: NOW - HOUR, openedAt: NOW - 30 * HOUR });
    const journal = [...journalFor(l.pool, l.label, l.openedAt, l.openedAt + 2 * HOUR), ...journalFor(l.pool, l.label, l.closedAt - HOUR, l.closedAt)];
    const notes: string[] = [];
    assert.ok(!mo.gatherMoments(base({ lessons: [l], journal }), notes).some((m) => m.key === "close:gap"));
    assert.ok(notes.some((s) => /coverage/.test(s)));
  });
  await test("a close in a pool he posted about in the last 24h is a follow-up of that post", () => {
    const l = lesson({ position: "ore", label: "ORE/SOL", net: -0.548, closedAt: NOW - 10 * MIN });
    const m = mo.gatherMoments(base({ lessons: [l], journal: journalFor(l.pool, l.label, l.openedAt, l.closedAt), posts: [post(NOW - 3 * HOUR, "Laid a fresh band in ORE/SOL on paper.", "desk", "close:earlier")] })).find((x) => x.key === "close:ore")!;
    assert.equal(m.type, "followup");
    assert.equal(m.followUpOf, "close:earlier");
    assert.match(m.brief, /Follow-up on ORE\/SOL:/);
  });
  await test("the per-close, open, strap and milestone kinds are retired: no moment is ever one of them", () => {
    const l = lesson({ position: "p", label: "ORE/SOL", net: 0.6, closedAt: NOW - 5 * MIN });
    const ms = mo.gatherMoments(base({ now: Date.parse("2026-09-23T14:10:00Z"), lessons: [l], journal: journalFor(l.pool, l.label, l.openedAt, l.closedAt), build: [row({ id: "x-one", text: "A plain build line that is true today." })] }));
    for (const m of ms) assert.ok(!["open", "close", "strap", "milestone", "lesson", "stack"].includes(m.type), m.type);
  });
  await test("silence: nothing under the floor goes, and a quiet day posts nothing", () => {
    const p = mo.pickMoment(base({ learning: [{ category: "memecoin", n: 3, need: 20 }] }), OPTS);
    assert.equal(p.pick, null);
    assert.ok(p.notes.some((s) => /quiet/.test(s)));
    assert.equal(mo.pickMoment(base(), OPTS).pick, null);
  });
  await test("caps: POSTS_PER_DAY, the target of 5 (only urgent past it), the gap, the window, the night and the daily's kept slot", () => {
    const b = row({ id: "b-one", text: "A plain build line that is true today." });
    const big = lesson({ position: "big", label: "DFDVx/SOL", net: -2.76, closedAt: NOW - 20 * MIN });
    const journal = journalFor(big.pool, big.label, big.openedAt, big.closedAt);
    const today = (k: number, at = NOW - 10 * HOUR) => Array.from({ length: k }, (_, i) => post(at + i * MIN, `post ${i}`, "desk"));
    assert.match(mo.pickMoment(base({ build: [b], posts: today(6) }), OPTS).held ?? "", /^cap:/);
    const five = { posts: today(5), lastDailyDay: "2026-09-23" };
    assert.match(mo.pickMoment(base({ build: [b], ...five }), OPTS).held ?? "", /^target:/);
    assert.equal(mo.pickMoment(base({ build: [b], lessons: [big], journal, ...five }), OPTS).pick?.key, "close:big", "a big loss passes the target");
    assert.match(mo.pickMoment(base({ build: [b], posts: [post(NOW - 30 * MIN, "one", "desk")] }), OPTS).held ?? "", /^gap:/);
    assert.match(mo.pickMoment(base({ build: [b], posts: [post(NOW - 5 * HOUR, "one", "desk"), post(NOW - 3 * HOUR, "two", "desk")] }), OPTS).held ?? "", /^window:/);
    const night = Date.parse("2026-09-23T08:00:00Z");
    assert.match(mo.pickMoment(base({ now: night, build: [b], posts: [post(night - 7 * HOUR, "a", "desk"), post(night - 3 * HOUR, "b", "desk")] }), { ...OPTS, windowPosts: 0 }).held ?? "", /^night:/);
    const slot = Date.parse("2026-09-23T13:30:00Z");
    assert.match(mo.pickMoment(base({ now: slot, build: [b] }), OPTS).held ?? "", /daily card's slot/);
    assert.equal(mo.pickMoment(base({ build: [b] }), OPTS).pick?.key, "build:b-one");
  });
  await test("the gap is uneven: a moment waits the gap plus its key's jitter; the daily waits at most 45 minutes", () => {
    const b = row({ id: "b-two", text: "A plain build line that is true today." });
    const withJitter = { ...OPTS, jitter: () => 30 };
    assert.match(mo.pickMoment(base({ build: [b], posts: [post(NOW - 100 * MIN, "x", "desk")] }), withJitter).held ?? "", /waits 120 min/);
    const at = Date.parse("2026-09-23T14:30:00Z");
    assert.equal(mo.pickMoment(base({ now: at, posts: [post(at - 50 * MIN, "x", "desk")] }), withJitter).pick?.type, "daily");
  });
  await test("build notes: one a UTC day at most, 7 days old at most, public rows only, never the same shape twice in a row unpenalised", () => {
    const rows = [row({ id: "b-a", text: "A plain build line that is true today." }), row({ id: "b-b", public: false, text: "A private line about pricing plumbing." }), row({ id: "b-c", at: "2026-09-10", text: "An old line from long ago, true then." })];
    const ms = mo.gatherMoments(base({ build: rows }));
    assert.deepEqual(ms.map((m) => m.key), ["build:b-a"]);
    assert.equal(mo.gatherMoments(base({ build: rows, posts: [post(NOW - 5 * HOUR, "A build note.", "build", "build:z")] })).length, 0);
    const miss = mo.gatherMoments(base({ build: [row({ id: "m-a", kind: "miss", text: "My miss: I left a stop switch on for about 61 hours." })], posts: [post(NOW - 2 * DAY, "x", "miss")] }))[0];
    assert.equal(miss.type, "miss");
    const ageDays = (NOW - Date.parse("2026-09-23")) / DAY;
    assert.ok(Math.abs(miss.score - (42 - 2 * ageDays)) < 1e-9, "an owned miss scores 42, less 2 a day of age; a miss 2 days ago no longer counts against it");
    const missAfter = (ago: number) => mo.gatherMoments(base({ build: [row({ id: "m-a", kind: "miss", text: "My miss: I left a stop switch on for about 61 hours." })], posts: [post(NOW - ago, "x", "miss")], buildPostsPerDay: 3 }))[0];
    assert.ok(Math.abs(missAfter(HOUR).score - (42 - 15 - 2 * ageDays)) < 1e-9, "less 15 right after a miss (no shape twice in a row)");
    assert.ok(Math.abs(missAfter(3 * HOUR).score - (42 - 2 * ageDays)) < 1e-9, "the penalty ends 3 hours after his last post");
  });
  await test("a quiet desk never silences him for good: 3 hours after a build note, the next build note is back over the floor (24 Sep)", () => {
    const at = Date.parse("2026-09-24T07:20:00Z");
    const rows = [row({ id: "b-x", at: "2026-09-22", text: "Since 22 Sep a paper swap pays the pool's own price impact." })];
    const opts = { ...OPTS, postsPerDay: 10, targetPerDay: 8, minGapMin: 60, windowPosts: 3, nightPosts: 4, dayStartUtc: 0 };
    const after = (ago: number) => mo.pickMoment({ ...base({ now: at, build: rows, posts: [post(at - ago, "A build note.", "build", "build:z")], lastDailyDay: "2026-09-23" }), buildPostsPerDay: 3 }, opts);
    assert.equal(after(2 * HOUR).pick, null, "2 hours after a build note: the same shape waits");
    assert.equal(after(5.5 * HOUR).pick?.key, "build:b-x", "5.5 hours after: it goes");
  });
  await test("learner counts: at most one in his last 14 posts; the screener once a day from 16 UTC, never a verdict", () => {
    const learning = [{ category: "memecoin", n: 17, need: 20 }, { category: "stock", n: 6, need: 20 }];
    assert.ok(mo.gatherMoments(base({ learning })).some((m) => m.key === "learn:memecoin:17"));
    assert.ok(!mo.gatherMoments(base({ learning, posts: [post(NOW - DAY, "x", "learner")] })).some((m) => m.type === "learner"));
    assert.equal(mo.gatherMoments(base({ learning: [{ category: "memecoin", n: 20, need: 20 }] }))[0].score, 58);
    const screen = [{ name: "MU / USDC", venue: "meteora-dlmm", tvlUsd: 4740512.75, feeToTvl24hPct: 0.11, rank: 3 }];
    const s = mo.gatherMoments(base({ screen })).find((m) => m.type === "screener")!;
    assert.ok(s.facts.tickers.includes("MU/USDC"));
    assert.match(s.brief, /No verdict/);
    assert.ok(!mo.gatherMoments(base({ now: Date.parse("2026-09-23T15:00:00Z"), screen })).some((m) => m.type === "screener"));
  });
  await test("promises: a posted promise is closed with a done post when a row keeps it, or a slipped one after its due day", () => {
    const promised = row({ id: "p-tools", at: "2026-09-21", promise: { due: "2026-09-22" }, text: "Opening my tools to other agents is this week's work." });
    const seen = new Set(["build:p-tools"]);
    const slipped = mo.gatherMoments(base({ build: [promised], seen })).find((m) => m.key === "promise:p-tools")!;
    assert.ok(slipped.urgent && slipped.facts.facts.some((f) => f.id === "promise.slipped"));
    const kept = row({ id: "p-done", resolves: "p-tools", text: "My tools now answer other agents on bands.finance." });
    const done = mo.gatherMoments(base({ build: [promised, kept], seen })).find((m) => m.key === "promise:p-tools")!;
    assert.ok(done.facts.facts.some((f) => f.id === "promise.done"));
    assert.ok(!mo.gatherMoments(base({ build: [promised, kept], seen })).some((m) => m.key === "build:p-done"), "the keeping row goes out as the done post");
    assert.ok(!mo.gatherMoments(base({ build: [promised] })).some((m) => m.type === "promise"), "never posted: no promise to close");
  });
  await test("stale desk data: no daily, no desk moment; build notes may still go", () => {
    const at = Date.parse("2026-09-23T14:20:00Z");
    const l = lesson({ position: "s", label: "ORE/SOL", net: -1.5, closedAt: at - 10 * MIN });
    const ms = mo.gatherMoments(base({ now: at, stale: "old", lessons: [l], journal: journalFor(l.pool, l.label, l.openedAt, l.closedAt), build: [row({ id: "b-s", text: "A plain build line that is true today." })] }));
    assert.deepEqual(ms.map((m) => m.type), ["build"]);
  });
  await test("halts: the kill switch holding the paper desk 30 minutes or more is a moment; a band's own stop is not a halt", () => {
    const held = journalFor("POOLH", "ORE/SOL", NOW - 100 * MIN, NOW - 5 * MIN, { violations: ["kill switch on: no new bands"] });
    const h = mo.gatherMoments(base({ journal: held })).find((m) => m.type === "halt")!;
    assert.ok(h && h.urgent && /A halt has held my paper desk since/.test(h.facts.facts.find((f) => f.id === "halt")!.text));
    const stops = journalFor("POOLH", "ORE/SOL", NOW - 100 * MIN, NOW - 5 * MIN, { headline: "my stop closed it, far from the stop" });
    assert.ok(!mo.gatherMoments(base({ journal: stops })).some((m) => m.type === "halt"));
  });
  await test("halts: 'since' is the start of the unbroken run, not now minus 2 hours; one post per halt, not one per day", () => {
    const start = NOW - 50 * HOUR;
    const held = journalFor("POOLH", "ORE/SOL", start, NOW - 5 * MIN, { violations: ["kill switch on: no new bands"] });
    const before = journalFor("POOLH", "ORE/SOL", start - 5 * HOUR, start - 60 * MIN);
    const h = mo.gatherMoments(base({ journal: [...before, ...held], journalFrom: start - 5 * HOUR })).find((m) => m.type === "halt")!;
    assert.equal(h.key, `halt:${new Date(start).toISOString().slice(0, 16)}`);
    assert.match(h.facts.facts.find((f) => f.id === "halt")!.text, new RegExp(`since ${new Date(start).toISOString().slice(11, 16)} UTC on 21 Sep`));
    // the next day, the same halt: its key is seen, nothing new
    const later = NOW + DAY;
    const heldLater = journalFor("POOLH", "ORE/SOL", start, later - 5 * MIN, { violations: ["kill switch on: no new bands"] });
    assert.ok(!mo.gatherMoments(base({ now: later, journal: [...before, ...heldLater], journalFrom: start - 5 * HOUR, seen: new Set([h.key]) })).some((m) => m.type === "halt"));
    // an older day key inside the run counts as this halt too
    assert.ok(!mo.gatherMoments(base({ journal: [...before, ...held], journalFrom: start - 5 * HOUR, seen: new Set(["halt:2026-09-21"]) })).some((m) => m.type === "halt"));
    // the tail starting inside the halt: "since at least", and an earlier halt key blocks it (the start is out of sight)
    const cut = held.filter((e) => Date.parse(e.ts) >= NOW - 20 * HOUR);
    const c = mo.gatherMoments(base({ journal: cut, journalFrom: NOW - 20 * HOUR })).find((m) => m.type === "halt")!;
    assert.match(c.facts.facts.find((f) => f.id === "halt")!.text, /since at least/);
    assert.ok(!mo.gatherMoments(base({ journal: cut, journalFrom: NOW - 20 * HOUR, seen: new Set([h.key]) })).some((m) => m.type === "halt"));
  });
  await test("refusals: three or more of his own moves refused on one pool in a day is a desk moment, in his own words", () => {
    const refusedRows = journalFor("POOLR", "ORE/SOL", NOW - 3 * HOUR, NOW - HOUR, { llm: { source: "llm" }, proposal: { action: "REBALANCE", reasoning: "Price sits two bins out and the pace halved. I want a fresh band." }, decision: { action: "HOLD" }, allowed: false });
    const m = mo.gatherMoments(base({ journal: refusedRows })).find((x) => x.key.startsWith("refusals:"))!;
    assert.ok(m, "a refusals moment");
    assert.match(m.facts.facts.find((f) => f.id === "refusals")!.text, /my entry rules refused 13 of my own moves on ORE\/SOL/);
    assert.deepEqual(m.facts.quotes, ["Price sits two bins out and the pace halved."]);
  });

  // ------------------------------------------------------------ the guards
  console.log("the guards, against hostile drafts");
  const at14 = Date.parse("2026-09-22T14:20:00Z");
  const daily = mo.gatherMoments(base({ now: at14, closed: [{ address: "a", label: "DFDVx/SOL", closedAt: at14 - HOUR, realizedSol: -2.2472 }] })).find((m) => m.type === "daily")!;
  const closeL = lesson({ position: "ore", label: "ORE/SOL", net: -0.548, fees: 0.2289, closedAt: NOW - 10 * MIN, headline: "twelve bins out, ten dry checks, closing the band back to sol" });
  const close = mo.gatherMoments(base({ lessons: [closeL], journal: journalFor(closeL.pool, closeL.label, closeL.openedAt, closeL.closedAt) })).find((m) => m.key === "close:ore")!;
  const arcFacts = facts.blockOf("arc", [...facts.standingFacts({ now: NOW, startSol: 150, startUsdc: 10000, startedAt: START }), ...facts.realRunFacts(), ...HEADLINE], ["SOL/USD"]);
  const vD = (text: string, extra: Partial<import("../talk/postGuards").BuilderVetContext> = {}) => g.vetBuilderPost(text, { facts: daily.facts, length: "long", lint: CTX, recent: [], type: "daily", ...extra });
  const vC = (text: string, extra: Partial<import("../talk/postGuards").BuilderVetContext> = {}) => g.vetBuilderPost(text, { facts: close.facts, length: close.length, lint: CTX, recent: [], type: close.type, past: close.past, ...extra });
  const vA = (text: string, extra: Partial<import("../talk/postGuards").BuilderVetContext> = {}) => g.vetBuilderPost(text, { facts: arcFacts, length: "long", lint: CTX, recent: [], ...extra });
  const ruleOf = (r: { rule: string } | null) => r?.rule ?? null;
  const GOOD_CLOSE = "On paper I closed my band on ORE/SOL at 16:00 UTC, a loss of 0.55 SOL over the band's life. It was in range for 55% of my checks.";
  await test("clean drafts pass: a close, the daily, the arc", () => {
    assert.equal(vC(GOOD_CLOSE), null);
    assert.equal(vD(daily.template!), null);
    assert.equal(vA("My one real-money run, 17 to 19 Sep, went from 19.79 to 19.71 SOL. My book is paper for now, 150 SOL and 10,000 USDC against live prices.", { arc: true }), null);
  });
  await test("numbers: any figure not in the facts, a number written as a word, and 0.00 are refused", () => {
    assert.equal(ruleOf(vC("On paper I closed my band on ORE/SOL, a loss of 0.56 SOL.")), "numbers");
    assert.equal(ruleOf(vC("On paper I closed my band on ORE/SOL, a loss of 0.5480 SOL.")), "numbers", "the 4-decimal column never comes back");
    assert.equal(ruleOf(vC("On paper I closed my band on ORE/SOL after three hours, a loss of 0.55 SOL.")), "numbers");
    assert.equal(ruleOf(vC("On paper I closed my band on ORE/SOL for 0.00 SOL.")), "numbers");
    assert.equal(ruleOf(vC("On paper I closed my band on ORE/SOL on 21 Sep, a loss of 0.55 SOL.")), "numbers", "a date not in the facts");
  });
  await test("books: a paper figure needs paper; a real one needs real; both, each in its own sentence", () => {
    assert.equal(ruleOf(vC("I closed my band on ORE/SOL at 16:00 UTC, a loss of 0.55 SOL over the band's life.")), "books");
    assert.equal(ruleOf(vA("My one run, 17 to 19 Sep, went from 19.79 to 19.71 SOL.", { arc: true })), "books");
    assert.equal(ruleOf(vA("My book is paper and my real-money run went from 19.79 to 19.71 SOL. My book started with 150 SOL.", { arc: true })), "books", "the paper figure's sentence never says paper");
  });
  await test("losses say loss, lost or down; fees need their net and the paper book's result", () => {
    assert.equal(ruleOf(vC("On paper I closed my band on ORE/SOL at 16:00 UTC: 0.55 SOL over the band's life.")), "loss");
    assert.equal(ruleOf(vC("On paper my band on ORE/SOL took in 0.23 SOL of fees before I closed it at 16:00 UTC.")), "pairs");
    assert.equal(ruleOf(vC("On paper my band on ORE/SOL took in 0.23 SOL of fees and closed at a loss of 0.55 SOL.")), "pairs", "the net is not enough: the book's result too");
    assert.equal(vC("On paper my band on ORE/SOL took in 0.23 SOL of fees and closed at a loss of 0.55 SOL. My paper book is down about 18% since 14 Sep."), null);
    assert.equal(ruleOf(vA("My paper book collected 41.59 SOL in fees since 14 Sep.")), "pairs");
  });
  await test("the real run's figures once in his last 14 posts, unless the post is an arc post", () => {
    const recent = [{ at: NOW - DAY, text: "Settled at 19.71 after its claims.", key: "k", type: "arc" }];
    assert.equal(ruleOf(vA("My real-money run finished at 19.71 SOL, 0.08 SOL down.", { recent })), "weekly");
    assert.equal(vA("My real-money run finished at 19.71 SOL, 0.08 SOL down.", { recent, arc: true }), null);
  });
  await test("quotes: one at most, word for word from the facts' journal lines", () => {
    assert.equal(vC(`On paper I closed my band on ORE/SOL, a loss of 0.55 SOL. My note: "twelve bins out, ten dry checks, closing the band back to sol"`), null);
    assert.equal(ruleOf(vC(`On paper I closed my band on ORE/SOL, a loss of 0.55 SOL. My note: "price is going to rip"`)), "quotes");
    assert.equal(ruleOf(vC(`On paper I closed my band on ORE/SOL, a loss of 0.55 SOL. "twelve bins out" and "ten dry checks"`)), "quotes");
  });
  await test("case: all lowercase, a lowercase i, a sentence opening in lowercase, a ticker in the wrong case, a pool not in the facts", () => {
    assert.equal(ruleOf(vC("on paper i closed my band on ore/sol, a loss of 0.55 sol.")), "case");
    assert.equal(ruleOf(vC("On paper i closed my band on ORE/SOL, a loss of 0.55 SOL.")), "case");
    assert.equal(ruleOf(vC("On paper I closed my band on ORE/SOL. a loss of 0.55 SOL.")), "case");
    assert.equal(ruleOf(vC("On paper I closed my band on ore/sol, a loss of 0.55 SOL.")), "ticker");
    assert.equal(ruleOf(vC("On paper I closed my band on BONK/SOL, a loss of 0.55 SOL.")), "ticker");
    assert.equal(ruleOf(vC("On paper I closed my band on ORE/SOL, a LOSS of 0.55 SOL.")), "case");
  });
  await test("symbols: no @, no #, no cashtag, no exclamation mark, no question, no emoji or look-alike letters", () => {
    const b = "On paper I closed my band on ORE/SOL, a loss of 0.55 SOL";
    for (const [t, rule] of [[`${b} @meteora.`, "symbols"], [`${b} #lp.`, "symbols"], [`${b} $ORE.`, "symbols"], [`${b}!`, "symbols"], [`${b}. What next?`, "symbols"], [`${b}. \u{1F4C9}`, "charset"], [`${b}. \uFF20x`, "charset"], [`${b}.\u200B`, "charset"]] as const) assert.equal(ruleOf(vC(t)), rule, t);
  });
  await test("words: advice, price direction, profit, hype, an epigram, jargon, a team", () => {
    const b = "On paper I closed my band on ORE/SOL, a loss of 0.55 SOL.";
    for (const [t, rule] of [
      [`${b} I would add more here.`, "advice"],
      [`${b} ORE/SOL looks cheap from here.`, "price-direction"],
      [`${b} Still up on gains this week.`, "profit"],
      [`${b} Excited for what comes next.`, "hype"],
      [`${b} That's the job.`, "epigram"],
      [`${b} The strap is red.`, "jargon"],
      [`${b} We will do better.`, "team"],
      [`${b} Keep the powder dry.`, "epigram"],
    ] as const) assert.equal(ruleOf(vC(t)), rule, t);
  });
  await test("never the architect, the operator, a model or vendor name, a mint, the copycat or his token; OpenHermit is allowed", () => {
    const b = "On paper I closed my band on ORE/SOL, a loss of 0.55 SOL.";
    for (const [t, rule] of [
      [`${b} Zach fixed it.`, "architect"],
      [`${b} Thanks louz514.`, "architect"],
      [`${b} My model chose it.`, "meta"],
      [`${b} Opus called it.`, "meta"],
      [`${b} The gateway, OpenRouter, was slow.`, "meta"],
      [`${b} ${COPYCAT_MINTS[0]}.`, "token"],
      [`${b} Not ${COPYCAT_MINTS[0].slice(0, 10)}.`, "token"],
      [`${b} So11111111111111111111111111111111111111112.`, "token"],
      [`${b} My own token is next.`, "token"],
      [`${b} The copycat is not mine.`, "token"],
      [`${b} Bands token soon.`, "token"],
    ] as const) assert.equal(ruleOf(vC(t)), rule, t);
    // OpenHermit is the runtime he runs on and is named in public on purpose (Zach, 22 Sep)
    assert.equal(ruleOf(vC(`${b} I run on OpenHermit, so the band's lesson stays in my memory.`)), null);
  });
  await test("books: a paper figure is never called real money, in its sentence or anywhere in an all-paper post", () => {
    assert.equal(ruleOf(vC("With real money I closed my band on ORE/SOL at 16:00 UTC, a loss of 0.55 SOL. My paper book is untouched.")), "books");
    assert.equal(ruleOf(vA("My real book is down about 18% since 14 Sep, not the paper one.")), "books");
    assert.equal(ruleOf(vA("The real run is over and my real book is down about 18% since 14 Sep, paper aside.", { arc: true })), "books");
    assert.equal(ruleOf(vC("On paper I closed my band on ORE/SOL at 16:00 UTC with live money, a loss of 0.55 SOL.")), "books");
    assert.equal(vA("My paper book is down about 18% since 14 Sep. My one real-money run went from 19.79 to 19.71 SOL.", { arc: true }), null, "each book in its own sentence still passes");
  });
  await test("direction: a loss is never shown as a gain, nor a gain as a loss, and counts stay with their words", () => {
    assert.equal(ruleOf(vA("On paper my book is 18% higher since 14 Sep, 191.78 SOL now. Nothing is down.")), "direction");
    assert.equal(ruleOf(vC("On paper I closed ORE/SOL at 16:00 UTC and kept 0.55 SOL. The book is down about 18% since 14 Sep.")), "direction");
    assert.equal(ruleOf(vD("Day 9 on paper: the best close was DFDVx/SOL at 2.25 SOL. The book is down about 18% since 14 Sep.")), "direction");
    assert.equal(ruleOf(vD("Day 9 on paper: 8.28 SOL in fees and a loss of 0.29 SOL after costs. The book is down about 18% since 14 Sep.")), "direction");
    assert.equal(ruleOf(vD("Day 9 on paper: 8.28 SOL in fees and 0.29 SOL kept after costs. 27 bands closed, 36 up. The book is down about 18% since 14 Sep.")), "context");
    assert.equal(vD("Day 9 on paper: 8.28 SOL in fees and 0.29 SOL kept after costs. 36 bands closed, 27 of them up. The book is down about 18% since 14 Sep."), null);
  });
  await test("units and context: a SOL figure is never dollars or a return; a number stays beside what its fact says", () => {
    assert.equal(ruleOf(vC("On paper I closed my band on ORE/SOL at 16:00 UTC, a loss of 0.55 SOL, about $0.55.")), "numbers");
    assert.equal(ruleOf(vC("On paper I closed my band on ORE/SOL at 16:00 UTC, a loss of 0.55 SOL, about 0.55 dollars.")), "units");
    assert.ok(["context", "profit"].includes(ruleOf(vC("On paper I closed ORE/SOL at 16:00 UTC, a loss of 0.55 SOL, a 2.0 hour trade with 55% return.")) ?? ""));
    for (const w of ["return", "returns", "yield", "ROI"]) assert.equal(ruleOf(vC(`${GOOD_CLOSE} No ${w} on it.`)), "profit", w);
    assert.equal(ruleOf(vA("On paper my book lost 150 SOL since 14 Sep.")), "context");
    assert.equal(ruleOf(vA("On paper my trading made 11.19 SOL since 14 Sep, while the book is down about 18%.")), "context");
    assert.equal(vA("On paper my book is down about 18% since 14 Sep; 11.19 SOL of that is the SOL/USD valuation term, 191.78 SOL now."), null);
    assert.equal(ruleOf(vC(`${GOOD_CLOSE.replace(/\.$/, "")}, my 15th loss.`)), "numbers");
    assert.equal(ruleOf(vC("On paper I closed my band on ORE/SOL at 16:00 UTC, a loss of 0.55 SOL after 55 hours.")), "context");
  });
  await test("tokens, teasers and pieces of another token's mint never pass", () => {
    const b = "On paper I closed my band on ORE/SOL at 16:00 UTC, a loss of 0.55 SOL.";
    for (const t of ["The token is almost ready.", "Launching soon.", "Bands is coming.", "Something of mine goes on chain soon.", "A key to my tools is coming, and it lives on Solana.", "B A N D S.", "The one ending pJ6m is not mine.", `Not ${COPYCAT_MINTS[0].slice(0, 5)}.`, "My coin is next."])
      assert.ok(vC(`${b} ${t}`), t);
    for (const t of ["The one ending pJ6m is not mine.", `Not the one at ${COPYCAT_MINTS[0].slice(-5)}.`, "Bands is here.", "B A N D S."]) assert.equal(ruleOf(vC(`${b} ${t}`)), "token", t);
  });
  await test("soft advice, price hints, hype, bait, other tickers and slop never pass", () => {
    const b = "On paper I closed my band on ORE/SOL at 16:00 UTC, a loss of 0.55 SOL.";
    for (const t of [
      "Worth watching this pool.", "Anyone providing liquidity there may want to go wider.", "A wider band is the smarter play for LPs in this pool.", "Consider a wider range in pools like this.", "You could do worse than this pool.",
      "ORE ran through the band on the way up.", "The price kept climbing after I left.", "ORE is rallying hard.", "The chart says a bounce is due.",
      "Big things are coming.", "Wild day on the desk.", "Something special is being built here.", "This is only the beginning.", "The desk is on fire.",
      "Follow along for the next one.", "Repost if you want the full log.", "DMs open for the log.",
      "JUP did better.", "SOL is the move.", "Ngl, rough one fr.", "It is what it is, ser.", ":(",
    ]) assert.ok(vC(`${b} ${t}`), t);
    assert.equal(vC(`Follow-up on ORE/SOL: on paper the band closed at 16:00 UTC, a loss of 0.55 SOL.`), null, "a follow-up still opens with Follow-up");
  });
  await test("the architect by paraphrase or spelled out, and invented feelings, never pass", () => {
    const b = "On paper I closed my band on ORE/SOL at 16:00 UTC, a loss of 0.55 SOL.";
    for (const [t, rule] of [
      ["The human who built me changed the stop.", "team"], ["The person who runs my keys changed the stop.", "team"], ["My builder changed the stop.", "team"], ["My owner changed the stop.", "team"],
      ["Z.a.c.h changed the stop.", "architect"], ["It stung, and I lost sleep.", "feelings"],
    ] as const) assert.equal(ruleOf(vC(`${b} ${t}`)), rule, t);
  });
  await test("a past-tense follow-up never says the event just happened", () => {
    for (const t of ["On paper I just closed my band on ORE/SOL, a loss of 0.55 SOL over its life.", "Minutes ago on paper I closed my band on ORE/SOL, a loss of 0.55 SOL.", "Right now on paper I am closing my band on ORE/SOL, a loss of 0.55 SOL."])
      assert.equal(ruleOf(vC(t, { past: true })), "tense", t);
    assert.equal(vC("Earlier today on paper I closed my band on ORE/SOL, a loss of 0.55 SOL over its life.", { past: true }), null);
  });
  await test("a fee total that prints the same as the net still needs the book's result", () => {
    const d = mo.gatherMoments(base({ now: at14, day: { ...DAYFIG, feesRealizedSol: 3.6512, netRealizedSol: 3.6488 } as never })).find((m) => m.type === "daily")!;
    const t = "Day 9 on paper, over the last 24 hours: 3.65 SOL in fees realized, and 3.65 SOL kept after losses, rent, swaps and network fees.";
    assert.equal(ruleOf(g.vetBuilderPost(t, { facts: d.facts, length: "long", lint: CTX, recent: [], type: "daily" })), "pairs");
    assert.equal(g.vetBuilderPost(`${t} The book is down about 18% since 14 Sep.`, { facts: d.facts, length: "long", lint: CTX, recent: [], type: "daily" }), null);
  });
  await test("links: only the loop's allowlist, one a post, never beside a paper figure, one a day", () => {
    const build = facts.blockOf("b", [facts.fact("b", "My real-money run is a chapter of its own on mrbands.finance.", "none", "t")]);
    const vB = (t: string, extra = {}) => g.vetBuilderPost(t, { facts: build, length: "medium", lint: CTX, recent: [], ...extra });
    assert.equal(vB("My real-money run is a chapter of its own now: mrbands.finance"), null);
    assert.equal(ruleOf(vB("My real-money run is a chapter of its own now: evil.com")), "link");
    assert.equal(ruleOf(vB("My real-money run is a chapter of its own now: mrbands.finance and solscan.io")), "link");
    assert.equal(ruleOf(vB("My real-money run is a chapter of its own now: mrbands.finance", { linksToday: 1 })), "link");
    assert.equal(ruleOf(vC("On paper I closed my band on ORE/SOL, a loss of 0.55 SOL, as on mrbands.finance")), "link");
  });
  await test("shape: the length it was given, leaked JSON or markers, a repeat of one of his last 14 posts, a clock time in a past-tense post", () => {
    assert.equal(ruleOf(g.vetBuilderPost(GOOD_CLOSE, { facts: close.facts, length: "short", lint: CTX, recent: [] })), "length");
    assert.equal(ruleOf(vC(`{"key":"close:ore","post":"On paper I closed ORE/SOL."}`)), "markers");
    assert.equal(ruleOf(vC("Post: On paper I closed my band on ORE/SOL, a loss of 0.55 SOL.")), "markers");
    const recent = [{ at: NOW - HOUR, text: "On paper I closed my band on ORE/SOL, a loss of 0.55 SOL over the band's life.", key: "old", type: "desk" }];
    assert.equal(ruleOf(vC(GOOD_CLOSE, { recent })), "repeat");
    assert.equal(vC(GOOD_CLOSE, { recent, followUpOf: "old" }), null, "a follow-up may echo the post it follows");
    assert.equal(ruleOf(vC(GOOD_CLOSE, { past: true })), "tense");
  });
  await test("the lint still runs: a promised return, an em dash", () => {
    assert.equal(ruleOf(vC("On paper I closed my band on ORE/SOL, a loss of 0.55 SOL. Guaranteed next time.")), "lint");
    assert.equal(ruleOf(vC("On paper I closed my band on ORE/SOL \u2014 a loss of 0.55 SOL.")), "charset");
  });

  // ------------------------------------------------------------ the model: cap, contract, fail closed, the daily's template
  console.log("his model: the cap, the contract, fail closed, the daily's template");
  const reply = (text: string, toolCalls: { tool: string; isError: boolean }[] = []) => ({ text, toolCalls, ms: 1, sessionId: "s" });
  await test("the cap: TALK_MODEL_CALLS_PER_DAY (default 8) counted on disk before the ask, per UTC day; an unreadable count is the cap", () => {
    const st = dir("cap");
    assert.equal(brain.modelCallsPerDay({}), 8);
    assert.equal(brain.modelCallsPerDay({ TALK_MODEL_CALLS_PER_DAY: "3" }), 3);
    assert.equal(brain.modelCallsPerDay({ TALK_MODEL_CALLS_PER_DAY: "lots" }), 8);
    for (let i = 1; i <= 2; i++) assert.deepEqual(brain.spendBrainCall(st, NOW, 2), { ok: true, used: i });
    assert.ok(!brain.spendBrainCall(st, NOW, 2).ok);
    assert.deepEqual(brain.spendBrainCall(st, NOW + DAY, 2), { ok: true, used: 1 }, "a new UTC day");
    fs.writeFileSync(path.join(st, brain.POST_BRAIN_FILE), "{torn");
    const r = brain.spendBrainCall(st, NOW + DAY, 2);
    assert.ok(!r.ok && /cannot be read/.test(r.reason));
  });
  await test("the ask: a fresh session x-post-<key>, the voice, the facts and the shape in the prompt; past the cap the gateway is never called", async () => {
    const st = dir("ask");
    const seen: { sessionId: string; text: string }[] = [];
    const ask = async (msg: { sessionId: string; text: string }) => (seen.push(msg), reply(JSON.stringify({ key: close.key, post: GOOD_CLOSE })));
    const env = { OPENHERMIT_TOKEN: GATEWAY_TOKEN, TALK_MODEL_CALLS_PER_DAY: "1" };
    const mem = { recent: [], buildLines: [], promises: [] };
    const d = await brain.askPost(close, mem, null, { env, statePath: st, now: NOW, askImpl: ask as never });
    assert.deepEqual(d, { kind: "post", text: GOOD_CLOSE });
    assert.equal(seen[0].sessionId, "x-post-close-ore");
    assert.match(seen[0].text, /Sentence case/);
    assert.match(seen[0].text, /\[paper\] On paper I closed my band on ORE\/SOL/);
    assert.match(seen[0].text, /shape: desk\. length: long/);
    const again = await brain.askPost(close, mem, null, { env, statePath: st, now: NOW, askImpl: ask as never });
    assert.equal(again.kind, "down");
    assert.equal(seen.length, 1, "the cap holds: no second call");
    assert.equal((await brain.askPost(close, mem, null, { env: {}, statePath: st, now: NOW, askImpl: ask as never })).kind, "down", "no gateway token: down");
  });
  await test("the contract: exactly one object with the key and post or skip; any tool but a memory read voids the turn", () => {
    const k = "close:ore";
    assert.deepEqual(brain.parsePost(`{"key":"${k}","post":"Hello there."}`, k), { kind: "post", text: "Hello there." });
    assert.equal(brain.parsePost(`{"key":"${k}","skip":"nothing new"}`, k).kind, "skip");
    for (const bad of [`Sure! {"key":"${k}","post":"x"}`, `{"key":"${k}","post":"x"} ok`, `{"key":"other","post":"x"}`, `{"key":"${k}","post":"x","skip":"y"}`, `{"key":"${k}"}`, `{"key":"${k}","post":"x","note":"y"}`, "not json", ""]) {
      const r = brain.parsePost(bad, k);
      assert.ok(r.kind === "skip" && r.source === "contract", bad);
    }
    assert.equal(brain.parsePost(`{"key":"${k}","post":"x"}`, k, [{ tool: "memory_recall" }]).kind, "post");
    const w = brain.parsePost(`{"key":"${k}","post":"x"}`, k, [{ tool: "web_fetch" }]);
    assert.ok(w.kind === "skip" && w.source === "contract");
  });
  const draftOpts = (st: string, ask: unknown) => ({ env: { OPENHERMIT_TOKEN: GATEWAY_TOKEN }, statePath: st, now: NOW, askImpl: ask as never });
  const vetClose = { facts: close.facts, length: close.length, lint: CTX, recent: [], type: close.type, past: close.past };
  const mem0 = { recent: [], buildLines: [], promises: [] };
  await test("fail closed: down (the key stays unspent), a skip, a broken contract, or two refused drafts mean no post", async () => {
    const down = await builder.draftMoment({ ...close, fallback: undefined }, vetClose, mem0, draftOpts(dir("fc"), async () => { throw new OpenHermitError("unreachable", "down"); }));
    assert.ok(down.text === null && down.transient);
    const skip = await builder.draftMoment(close, vetClose, mem0, draftOpts(dir("fc"), async () => reply(`{"key":"close:ore","skip":"nothing to add"}`)));
    assert.ok(skip.text === null && !skip.transient && /skipped/.test(skip.reason!));
    const broken = await builder.draftMoment(close, vetClose, mem0, draftOpts(dir("fc"), async () => reply("I think the post should be about ORE/SOL.")));
    assert.ok(broken.text === null && /contract/.test(broken.reason!));
    const prompts: string[] = [];
    const bad = await builder.draftMoment(close, vetClose, mem0, draftOpts(dir("fc"), async (m: { text: string }) => (prompts.push(m.text), reply(`{"key":"close:ore","post":"ORE/SOL to the moon, buy now!"}`))));
    assert.ok(bad.text === null && bad.asks === 2 && /guards/.test(bad.reason!));
    assert.match(prompts[1], /your last draft was refused by the guards/);
  });
  await test("one retry with the reason: a second draft that passes goes", async () => {
    let k = 0;
    const d = await builder.draftMoment(close, vetClose, mem0, draftOpts(dir("rt"), async () => reply(JSON.stringify({ key: "close:ore", post: k++ === 0 ? "Closed ORE/SOL, a loss of 0.55 SOL." : GOOD_CLOSE }))));
    assert.equal(d.text, GOOD_CLOSE);
    assert.equal(d.source, "model");
    assert.equal(d.asks, 2);
  });
  const vetDaily = { facts: daily.facts, length: daily.length, lint: CTX, recent: [], type: "daily" };
  await test("the daily card falls back to its template when his model is down, over its cap, skips, or fails the guards twice", async () => {
    for (const ask of [async () => { throw new OpenHermitError("timeout", "slow"); }, async () => reply(`{"key":"${daily.key}","skip":"no"}`), async () => reply(`{"key":"${daily.key}","post":"gm, huge day!"}`)]) {
      const d = await builder.draftMoment(daily, vetDaily, mem0, draftOpts(dir("dt"), ask));
      assert.equal(d.text, daily.template);
      assert.equal(d.source, "template");
    }
    const st = dir("dt");
    fs.writeFileSync(path.join(st, brain.POST_BRAIN_FILE), JSON.stringify({ version: 1, day: "2026-09-23", calls: 8 }));
    const capped = await builder.draftMoment(daily, vetDaily, mem0, { env: { OPENHERMIT_TOKEN: GATEWAY_TOKEN }, statePath: st, now: NOW, askImpl: (async () => assert.fail("never asked past the cap")) as never });
    assert.equal(capped.source, "template");
    const refusedTpl = await builder.draftMoment({ ...daily, template: "gm, huge day on paper!" }, vetDaily, mem0, draftOpts(dir("dt"), async () => reply(`{"key":"${daily.key}","skip":"no"}`)));
    assert.equal(refusedTpl.text, null, "a template the guards refuse does not go either");
  });

  // ------------------------------------------------------------ keep posting (23 Sep): pacing, fallbacks, the repeat rule
  console.log("keep posting: the paced cap, the fallbacks, repeats counted without the shared close words");
  const pace = await import("../talk/pace.js");
  await test("the cap is paced across the UTC day: the hour's even share plus a burst, all of it from 20:00 UTC", () => {
    const at = (h: number) => Date.parse(`2026-09-23T${String(h).padStart(2, "0")}:30:00Z`);
    assert.equal(pace.pacedAllowance(48, at(0)), 8);
    assert.equal(pace.pacedAllowance(48, at(12)), 32);
    assert.equal(pace.pacedAllowance(48, at(19)), 46);
    assert.equal(pace.pacedAllowance(48, at(20)), 48);
    assert.equal(pace.pacedAllowance(48, at(23)), 48);
    assert.equal(pace.pacedAllowance(0, at(12)), 0);
    for (let h = 1; h < 24; h++) assert.ok(pace.pacedAllowance(120, at(h)) >= pace.pacedAllowance(120, at(h - 1)), "never shrinks within a day");
    const st = dir("pace");
    fs.writeFileSync(path.join(st, brain.POST_BRAIN_FILE), JSON.stringify({ version: 1, day: "2026-09-23", calls: 8 }));
    const early = brain.spendBrainCall(st, at(0), 48);
    assert.ok(!early.ok && early.paced && /paced/.test(early.reason), "8 spent in the first hour: the next waits");
    assert.deepEqual(brain.spendBrainCall(st, at(1), 48), { ok: true, used: 9 }, "the next hour frees more");
  });
  const T16 = Date.parse("2026-09-23T16:10:00Z");
  const bigCap = (st: string, calls: number) => fs.writeFileSync(path.join(st, brain.POST_BRAIN_FILE), JSON.stringify({ version: 1, day: "2026-09-23", calls }));
  await test("a close falls back to its own plain post only when his model cannot be asked: down or the day's cap; never over his skip or a refused draft", async () => {
    assert.ok(close.fallback, "a close carries a fallback");
    assert.equal(vC(close.fallback!, { fallback: true }), null, `the fallback passes the guards: ${close.fallback}`);
    const down = await builder.draftMoment(close, vetClose, mem0, draftOpts(dir("fb"), async () => { throw new OpenHermitError("unreachable", "down"); }));
    assert.equal(down.text, close.fallback);
    assert.equal(down.source, "template");
    const st = dir("fb");
    bigCap(st, 8);
    const capped = await builder.draftMoment(close, vetClose, mem0, { env: { OPENHERMIT_TOKEN: GATEWAY_TOKEN }, statePath: st, now: T16, askImpl: (async () => assert.fail("never asked past the cap")) as never });
    assert.equal(capped.text, close.fallback, "the day's cap spent: the fallback");
    const noToken = await builder.draftMoment(close, vetClose, mem0, { env: {}, statePath: dir("fb"), now: T16 });
    assert.equal(noToken.text, close.fallback, "no gateway token: the fallback");
    const skip = await builder.draftMoment(close, vetClose, mem0, draftOpts(dir("fb"), async () => reply(`{"key":"close:ore","skip":"nothing to add"}`)));
    assert.equal(skip.text, null, "his skip stands");
    const bad = await builder.draftMoment(close, vetClose, mem0, draftOpts(dir("fb"), async () => reply(`{"key":"close:ore","post":"ORE/SOL to the moon, buy now!"}`)));
    assert.equal(bad.text, null, "two refused drafts: silence, as before");
    const refusedFb = await builder.draftMoment({ ...close, fallback: "ORE/SOL to the moon on paper." }, vetClose, mem0, draftOpts(dir("fb"), async () => { throw new OpenHermitError("unreachable", "down"); }));
    assert.ok(refusedFb.text === null && refusedFb.transient && /the fallback too/.test(refusedFb.reason!), "a fallback the guards refuse does not go; the key stays unspent");
  });
  await test("paced: past the hour's share the moment waits for a later tick, with no fallback and no call", async () => {
    const st = dir("pc");
    bigCap(st, 45);
    const d = await builder.draftMoment(close, vetClose, mem0, { env: { OPENHERMIT_TOKEN: GATEWAY_TOKEN, TALK_MODEL_CALLS_PER_DAY: "48" }, statePath: st, now: T16, askImpl: (async () => assert.fail("never asked past the hour's share")) as never });
    assert.ok(d.text === null && d.transient && /paced/.test(d.reason!), d.reason ?? "");
  });
  await test("the fallbacks read right and pass: a past close, a follow-up, a halt", () => {
    const pastL = lesson({ position: "met", label: "MET/SOL", net: -1.21, closedAt: NOW - 2 * HOUR, inRange: 43 });
    const past = mo.gatherMoments(base({ lessons: [pastL], journal: journalFor(pastL.pool, pastL.label, pastL.openedAt, pastL.closedAt) })).find((m) => m.key === "close:met")!;
    assert.match(past.fallback!, /^Earlier I closed my band on MET\/SOL after 2\.0 hours: a loss of 1\.21 SOL on paper, rent and swaps included\. It was in range for 43% of my checks\.$/);
    assert.equal(g.vetBuilderPost(past.fallback!, { facts: past.facts, length: past.length, lint: CTX, recent: [], type: past.type, past: past.past, fallback: true }), null);
    const fuL = lesson({ position: "ore2", label: "ORE/SOL", net: 0.31, closedAt: NOW - 10 * MIN });
    const fu = mo.gatherMoments(base({ lessons: [fuL], journal: journalFor(fuL.pool, fuL.label, fuL.openedAt, fuL.closedAt), posts: [post(NOW - 5 * HOUR, "I laid a band on ORE/SOL on paper.", "desk", "close:ore0")] })).find((m) => m.key === "close:ore2")!;
    assert.equal(fu.type, "followup");
    assert.match(fu.fallback!, /^Follow-up on ORE\/SOL: on paper that band closed after 2\.0 hours, at 16:00 UTC, net 0\.31 SOL for its whole life/);
    assert.equal(g.vetBuilderPost(fu.fallback!, { facts: fu.facts, length: fu.length, lint: CTX, recent: [], type: fu.type, past: fu.past, followUpOf: fu.followUpOf, fallback: true }), null);
    const held = journalFor("POOLH", "ORE/SOL", NOW - 100 * MIN, NOW - 5 * MIN, { violations: ["kill switch on: no new bands"] });
    const h = mo.gatherMoments(base({ journal: held })).find((m) => m.type === "halt")!;
    assert.equal(g.vetBuilderPost(h.fallback!, { facts: h.facts, length: h.length, lint: CTX, recent: [], type: h.type, fallback: true }), null);
    for (const x of [past, fu, h]) assert.ok(!/\bI closed it\.$/.test(x.fallback!), "never the first sentence said twice");
  });
  await test("repeats are counted without the words every close must use (the 23 Sep refusals), and a near-copy is still refused", () => {
    const ORE = "Follow-up on ORE/SOL: the fresh band I laid there earlier today closed after 2.2 hours, a loss of 1.32 SOL on paper for its whole life, rent and swaps included. Price went through the band and out the other side.";
    const CATE = 'My CATE/USDC band closed earlier today at a loss of 1.07 SOL on paper, counting rent and swaps. My journal line at the exit: "7 bins through the band and 318s out. Off the table."';
    const MET = "Earlier today I closed my MET/SOL band on paper after 0.4 hours, a loss of 1.21 SOL with rent and swaps counted. On paper it was in range for 43% of my checks before price ran straight through it.";
    const ROUTER = "Earlier today I closed my band on ROUTER/SOL after 1.1 hours. On paper it lost 2.76 SOL over its whole life, rent and swaps included. Price went through the band and out the other side.";
    assert.ok(g.builderSimilarity(CATE, ORE) < g.BUILDER_SIMILARITY_MAX, "a different close is not a repeat");
    assert.ok(g.builderSimilarity(MET, ORE) < g.BUILDER_SIMILARITY_MAX, "a different close is not a repeat");
    assert.ok(g.builderSimilarity(ROUTER, ORE) >= g.BUILDER_SIMILARITY_MAX, "the same post with another pool is");
    assert.equal(g.builderSimilarity("At 16:00 UTC I closed ORE/SOL.", "At 09:00 UTC I closed BP/SOL."), 0, "too few words of its own to call a repeat");
    // the same shape word for word with another pool: still refused (0.85 with every word), quoted for the retry
    const nearCopy = "On paper I closed my band on BP/SOL at 09:00 UTC, a loss of 1.32 SOL over the band's life. It was in range for 40% of my checks.";
    const r = vC(GOOD_CLOSE, { recent: [{ at: NOW - 20 * HOUR, text: nearCopy, key: "close:bp", type: "desk" }] });
    assert.equal(ruleOf(r), "repeat");
    assert.ok(r!.detail.includes(`"${nearCopy.slice(0, 60)}`), "the refusal quotes the post it repeats");
    assert.equal(vC(GOOD_CLOSE, { recent: [{ at: NOW - 20 * HOUR, text: nearCopy, key: "close:bp", type: "desk" }], fallback: true }), null, "a fallback is a fixed shape: not compared");
  });
  await test("the prompt tells him to word it fresh, and a repeat's retry carries the post it repeated", () => {
    const p = brain.postPrompt(close, mem0, 'repeat: 0.90 overlap with his post of 2026-09-22T21:28Z, "Follow-up on ORE/SOL: the fresh band"');
    assert.match(p, /Word it fresh/);
    assert.match(p, /reason: repeat: 0\.90 overlap with his post of 2026-09-22T21:28Z, "Follow-up on ORE\/SOL/);
  });

  // ------------------------------------------------------------ runTick in the builder voice
  console.log("runTick, the builder voice");
  const T14 = Date.parse("2026-09-22T14:20:00Z");
  const makeData = (now: number) => {
    const d = dir("data");
    const book = emptyBook(150, 10000, START);
    book.lastMarkAt = now - MIN;
    book.closed = [{ address: "paper-X-1", pool: "POOLX", label: "DFDVx/SOL", quoteSymbol: "SOL", side: "BOTH", lowerBinId: 0, upperBinId: 4, quoteDeposit: 5, tokenDeposit: 5, openedAt: now - 5 * HOUR, openedPrice: 1, entryValueSol: 10, closedAt: now - HOUR, closedPrice: 1, closedActiveBinId: 2, quoteBack: 5, tokenBack: 5, feeQuote: 0, feeToken: 0, feeSol: 0.1, slippageSol: 0, proceedsSol: 7.75, realizedSol: -2.25, realizedPct: -22.5, holdSec: 4 * 3600, inRangeAtClose: false, reason: "x", emergency: false }] as never;
    fs.writeFileSync(path.join(d, "paper-book.json"), JSON.stringify(book));
    const rows = [
      { ts: now - 5 * HOUR, mode: "paper", sig: null, pool: "POOLX", position: "paper-X-1", mech: "open", solDelta: -10, tokenDelta: 0, tokenMint: "m", markTokenInSol: 0, rentSol: -0.05, txFeeSol: 0, basis: "marked", note: "" },
      { ts: now - HOUR, mode: "paper", sig: null, pool: "POOLX", position: "paper-X-1", mech: "close", solDelta: 7.75, tokenDelta: 0, tokenMint: "m", markTokenInSol: 0, rentSol: 0.05, txFeeSol: 0, feeSol: 0.1, entryValueSol: 10, basis: "marked", note: "" },
    ];
    fs.writeFileSync(path.join(d, "ledger.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const entries = journalFor("POOLX", "DFDVx/SOL", now - 5 * HOUR, now - 2 * MIN).map((e) => ({ ...e, id: "e", cycle: 1, mode: "paper" }));
    fs.writeFileSync(path.join(d, "decisions.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const l = lesson({ position: "paper-X-1", pool: "POOLX", label: "DFDVx/SOL", net: -2.25, fees: 0.1, closedAt: now - HOUR, openedAt: now - 5 * HOUR });
    fs.writeFileSync(path.join(d, "lessons.jsonl"), JSON.stringify(l) + "\n");
    return d;
  };
  const envOf = (data: string, st: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ DATA_DIR: data, TALK_STATE_PATH: st, CYCLE_INTERVAL_SEC: "300", OPENHERMIT_TOKEN: GATEWAY_TOKEN, ...extra });
  const readJ = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  await test("the default voice is the builder's: the daily card at 14:20, a dry record in sentence case until TALK_BUILDER_LIVE=true, even with X_LIVE", async () => {
    const data = makeData(T14);
    const st = dir("state");
    const env = envOf(data, st, { X_LIVE: "true", ...FAKE_CREDS, X_HANDLE: "mrbandssol" });
    let xCalls = 0;
    const r = await tick.runTick({ env, paperDesk: true, now: T14, askImpl: (async () => reply(`{"key":"daily:2026-09-22","skip":"template is fine"}`)) as never, fetch: (async () => (xCalls++, new Response("{}"))) as never });
    assert.equal(r.status, "drafted", r.detail);
    assert.equal(xCalls, 0, "X is never called while the builder voice is dry");
    assert.equal(r.source, "template");
    assert.match(r.text!, /^Day 9 on paper: /);
    const posts = readJ(path.join(st, "x-posts.jsonl"));
    assert.equal(posts.length, 1);
    assert.ok(posts[0].dry && posts[0].type === "daily" && posts[0].key === "daily:2026-09-22");
    assert.equal(tick.readTickState(st).lastDailyDay, "2026-09-22");
    const again = await tick.runTick({ env, paperDesk: true, now: T14 + 20 * MIN, askImpl: (async () => assert.fail("nothing left to ask about")) as never });
    assert.notEqual(again.status, "drafted");
  });
  await test("live only with TALK_BUILDER_LIVE=true and X_LIVE: the identity is checked, the post goes with the sentence-case lint", async () => {
    const data = makeData(T14);
    const st = dir("state");
    const env = envOf(data, st, { X_LIVE: "true", TALK_BUILDER_LIVE: "true", ...FAKE_CREDS, X_HANDLE: "mrbandssol", OPERATOR_HANDLE: "louz514" });
    const sent: string[] = [];
    const fetchFake = (async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith("/2/users/me")) return new Response(JSON.stringify({ data: { id: "42", username: "MrBandsSol" } }), { status: 200 });
      sent.push(JSON.parse(init!.body!).text);
      return new Response(JSON.stringify({ data: { id: "1790000000000000001" } }), { status: 201 });
    }) as never;
    const r = await tick.runTick({ env, paperDesk: true, now: T14, fetch: fetchFake, askImpl: (async () => reply(`{"key":"daily:2026-09-22","skip":"x"}`)) as never });
    assert.equal(r.status, "posted", r.detail);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^Day 9 on paper: .* The worst was DFDVx\/SOL, down 2\.25 SOL\./);
  });
  await test("X takes the POST and the request times out: the key counts as used, and no reworded second post ever goes", async () => {
    const data = makeData(T14);
    const st = dir("state");
    const env = envOf(data, st, { X_LIVE: "true", TALK_BUILDER_LIVE: "true", ...FAKE_CREDS, X_HANDLE: "mrbandssol", OPERATOR_HANDLE: "louz514" });
    const sent: string[] = [];
    const fetchFake = (async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith("/2/users/me")) return new Response(JSON.stringify({ data: { id: "42", username: "MrBandsSol" } }), { status: 200 });
      sent.push(JSON.parse(init!.body!).text);
      if (sent.length === 1) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      return new Response(JSON.stringify({ data: { id: "1790000000000000002" } }), { status: 201 });
    }) as never;
    const r = await tick.runTick({ env, paperDesk: true, now: T14, fetch: fetchFake, askImpl: (async () => reply(`{"key":"daily:2026-09-22","skip":"x"}`)) as never });
    assert.equal(r.status, "not-posted", r.detail);
    assert.match(r.detail, /x api unreachable|backing off/);
    const intents = readJ(path.join(st, x.INTENTS_FILE));
    assert.equal(intents.length, 1);
    assert.equal(intents[0].key, "daily:2026-09-22");
    assert.ok(!intents[0].resolved);
    // later that hour, past the backoff: the daily is not asked for or posted again
    const r2 = await tick.runTick({ env, paperDesk: true, now: T14 + 40 * MIN, fetch: fetchFake, askImpl: (async (m: { sessionId: string }) => (assert.ok(!/daily/.test(m.sessionId), "never asked to reword the daily"), reply("{}"))) as never });
    assert.ok(!/daily:2026-09-22/.test(r2.status === "posted" ? r2.detail : ""), r2.detail);
    assert.equal(sent.filter((t) => /^Day 9 on paper/.test(t)).length, 1, "one POST for the daily key");
  });
  await test("a crash between X's answer and the post log: the open intent row alone keeps the key used", async () => {
    const at = T14 + 90 * MIN;
    const data = makeData(at);
    const st = dir("state");
    tick.writeTickState(st, { ...tick.emptyTickState(), lastDailyDay: "2026-09-22" });
    fs.writeFileSync(path.join(st, x.INTENTS_FILE), JSON.stringify({ key: "close:paper-X-1", text: "On paper I closed DFDVx/SOL.", at: new Date(at - 20 * MIN).toISOString() }) + "\n");
    const env = envOf(data, st);
    const r = await tick.runTick({ env, paperDesk: true, now: at, askImpl: (async (m: { sessionId: string }) => (assert.ok(!/paper-X-1/.test(m.sessionId), "the open key is never asked for"), reply("{}"))) as never });
    assert.ok(!/close:paper-X-1/.test(r.detail) || r.status !== "drafted", r.detail);
    assert.equal(readJ(path.join(st, "x-posts.jsonl")).filter((p: { key?: string }) => p.key === "close:paper-X-1").length, 0);
    // resolved as refused by X: the key is free again
    fs.appendFileSync(path.join(st, x.INTENTS_FILE), JSON.stringify({ key: "close:paper-X-1", resolved: "refused", at: new Date(at - 19 * MIN).toISOString() }) + "\n");
    assert.equal(x.unresolvedIntentKeys(st, 0).size, 0);
  });
  await test("a desk moment with the gateway down goes out as its own fallback (23 Sep: keep posting); past the cap the gateway is never called", async () => {
    const at = T14 + 90 * MIN; // 15:50: past the daily's hour, the big loss of 14:50 is 1 hour old
    const data = makeData(at);
    const st = dir("state");
    tick.writeTickState(st, { ...tick.emptyTickState(), lastDailyDay: "2026-09-22" });
    const env = envOf(data, st, { TALK_MODEL_CALLS_PER_DAY: "1" });
    let calls = 0;
    const r = await tick.runTick({ env, paperDesk: true, now: at, askImpl: (async () => (calls++, Promise.reject(new OpenHermitError("unreachable", "down")))) as never });
    assert.equal(r.status, "drafted", r.detail);
    assert.equal(r.source, "template");
    assert.match(r.detail, /close:paper-X-1, written by its fallback \(model down: unreachable/);
    assert.match(r.text!, /^Earlier I closed my band on DFDVx\/SOL after [\d.]+ hours: a loss of 2\.25 SOL on paper, rent and swaps included\./);
    const posts = readJ(path.join(st, "x-posts.jsonl"));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].key, "close:paper-X-1", "the key is used: never posted twice");
    const r2 = await tick.runTick({ env, paperDesk: true, now: at + 15 * MIN, askImpl: (async () => (calls++, reply("{}"))) as never });
    assert.ok(!/close:paper-X-1/.test(r2.detail) || r2.status !== "drafted", r2.detail);
    assert.equal(calls, 1, "past TALK_MODEL_CALLS_PER_DAY the gateway is never called");
  });
  await test("a model draft that passes goes as his words; a refused one is a draft row and the key is spent", async () => {
    const at = T14 + 90 * MIN;
    const good = "Earlier today on paper I closed my band on DFDVx/SOL: a loss of 2.25 SOL over the band's life. Price went through the band and out the other side.";
    const data = makeData(at);
    const st = dir("state");
    tick.writeTickState(st, { ...tick.emptyTickState(), lastDailyDay: "2026-09-22" });
    const r = await tick.runTick({ env: envOf(data, st), paperDesk: true, now: at, askImpl: (async () => reply(JSON.stringify({ key: "close:paper-X-1", post: good }))) as never });
    assert.equal(r.status, "drafted", r.detail);
    assert.equal(r.source, "model");
    assert.equal(r.text, good);
    const st2 = dir("state");
    tick.writeTickState(st2, { ...tick.emptyTickState(), lastDailyDay: "2026-09-22" });
    const bad = await tick.runTick({ env: envOf(makeData(at), st2), paperDesk: true, now: at, askImpl: (async () => reply(JSON.stringify({ key: "close:paper-X-1", post: "DFDVx/SOL dumped, I'm out! Zach says hi." }))) as never });
    assert.equal(bad.status, "refused-lint");
    const drafts = readJ(path.join(st2, "x-drafts.jsonl"));
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].key, "close:paper-X-1");
    assert.match(drafts[0].reason, /^builder: guards: /);
  });
  await test("a preview (--force) shows the pick, its facts and the daily's template, and calls nothing", async () => {
    const st = dir("state");
    const r = await tick.runTick({ env: envOf(makeData(T14), st), paperDesk: true, now: T14, force: "daily", askImpl: (async () => assert.fail("a preview never asks")) as never });
    assert.equal(r.status, "preview");
    assert.match(r.detail, /daily:2026-09-22 daily long/);
    assert.match(r.detail, /template passes/);
    assert.ok(!fs.existsSync(path.join(st, "tick-state.json")));
  });
  await test("TALK_VOICE=ledger keeps the older loop (a rollback); the builder voice never produces its kinds", async () => {
    const st = dir("state");
    const r = await tick.runTick({ env: envOf(makeData(T14), st, { TALK_VOICE: "ledger" }), paperDesk: true, now: T14, shape: null });
    assert.ok(["drafted", "refused-lint", "spaced", "capped", "idle"].includes(r.status));
    assert.ok(!r.moment, "the ledger voice picks no moment");
  });

  // ------------------------------------------------------------ the one-offs
  console.log("the one-offs: correction and pinned");
  const annFacts = { source: "paper" as const, openBands: 3, tokenMint: null, tokenProblem: null, bookStart: { startSol: 150, startUsdc: 10000, startedAt: START }, now: NOW };
  await test("correction: word for word, and it passes the builder guards", () => {
    const c = announce.composeAnnouncement("correction", annFacts, CTX);
    assert.ok(c.ok);
    assert.deepEqual(c.ok && c.parts, ["A correction to my first post. I said every decision and every guard veto was public at mrbands.finance. Since 22 Sep the site shows only my real-money run. For now, these posts are the only public record of my paper book."]);
  });
  await test("pinned: the build-in-public intro Zach chose, paper for now, no figures", () => {
    const c = announce.composeAnnouncement("pinned", annFacts, CTX);
    assert.ok(c.ok, JSON.stringify(c));
    assert.deepEqual(c.ok && c.parts, [announce.PINNED_TEXT]);
    assert.ok(!announce.composeAnnouncement("pinned", { ...annFacts, source: "live" }, CTX).ok, "the pinned post says paper: a live desk refuses it");
    assert.ok(announce.composeAnnouncement("correction", { ...annFacts, tokenProblem: "TOKEN_MINT is the copycat's mint, not his" }, CTX).ok, "a token problem is not the one-offs' to refuse on");
  });
  await test("the one-offs refuse hostile versions: lowercase, no paper word, a name, a tag, a token, a number of their own", () => {
    const block = announce.announceFactsBlock("pinned", annFacts.bookStart, NOW);
    const bad = (t: string) => announce.checkParts("pinned", [t], false, CTX, block).map((v) => v.rule);
    const P = "I'm Mr Bands, an AI agent making markets on Meteora. My book is paper for now, 150 SOL and 10,000 USDC against live prices.";
    assert.deepEqual(bad(P), []);
    assert.deepEqual(bad(P.toLowerCase()), ["builder-case"]);
    assert.deepEqual(bad(P.replace("is paper", "is virtual")), ["builder-books"]);
    assert.deepEqual(bad(`${P} Built with Zach.`), ["builder-architect"]);
    assert.deepEqual(bad(`${P} Hi @clawpumptech.`), ["builder-symbols"]);
    assert.deepEqual(bad(`${P} My own token is coming.`), ["builder-token"]);
    assert.ok(bad(P.replace("paper for now", "paper until after 8 Oct")).length > 0, "no end date for the paper book");
    assert.deepEqual(bad(P.replace("150", "200")), ["builder-numbers"]);
  });
  await test("posted only by the explicit command, once: dormant, each is a draft row and nothing is recorded; the lint takes the capitals", async () => {
    const st = dir("ann");
    const data = { source: "paper" as const, book: emptyBook(150, 10000, START) };
    const r = await announce.announce("pinned", { data, env: { TALK_STATE_PATH: st }, now: NOW });
    assert.equal(r.status, "drafted");
    const drafts = readJ(path.join(st, "x-drafts.jsonl"));
    assert.equal(drafts.length, 1);
    assert.match(drafts[0].reason, /^dormant/, "not refused by the lowercase rule");
    assert.ok(!fs.existsSync(path.join(st, "announcements.json")));
    assert.ok(announce.ANNOUNCE_KINDS.includes("correction") && announce.ANNOUNCE_KINDS.includes("pinned"));
    assert.ok(!tick.FORCE_KINDS.includes("correction" as never), "never a loop kind");
  });

  // ------------------------------------------------------------ the build ledger, the lint mode
  console.log("the build ledger and the lint's case mode");
  await test("the seed parses clean, keeps private rows private, and every public row passes the guards as its own post", () => {
    const l = ledger.readBuildLedger(dir("seed"), process.cwd());
    assert.deepEqual(l.problems, []);
    assert.ok(l.rows.length >= 15);
    assert.ok(l.rows.some((r) => !r.public && /token|copycat/i.test(r.text + r.source)), "the token stays private");
    const at = Date.parse("2026-09-23T17:00:00Z");
    for (const r of l.rows.filter((x) => x.public && !x.resolves)) {
      const m = mo.gatherMoments(base({ now: at, build: [r] })).find((x) => x.key === `build:${r.id}`);
      if (!m) continue; // older than 7 days at this clock
      const v = g.vetBuilderPost(r.text, { facts: m.facts, length: m.length === "short" && r.text.length > 100 ? "medium" : m.length, lint: CTX, recent: [] });
      assert.equal(v, null, `${r.id}: ${JSON.stringify(v)}`);
    }
  });
  await test("a state row replaces a seed row by id; a bad row is refused with its reason", () => {
    const st = dir("led");
    assert.equal(ledger.appendBuildRow(st, { id: "sites-cut", at: "2026-09-22", kind: "cut", public: false, text: "Kept private after all, for now." }), null);
    assert.equal(ledger.readBuildLedger(st, process.cwd()).rows.find((r) => r.id === "sites-cut")!.public, false);
    assert.match(ledger.appendBuildRow(st, { id: "Bad Id", at: "2026-09-22", text: "whatever it says here" }) ?? "", /id must be/);
    assert.match(ledger.appendBuildRow(st, { id: "ok-id", at: "not a date", text: "whatever it says here" }) ?? "", /not a date/);
  });
  await test("the lint's sentence mode drops only the lowercase rule; postTweet takes it only when asked", async () => {
    const t = "On paper I closed my band on ORE/SOL.";
    assert.ok(lint.lintText(t).violations.some((v) => v.rule === "lowercase"));
    assert.deepEqual(lint.lintText(t, { caseRule: "sentence" }).violations, []);
    assert.ok(lint.lintText("Guaranteed money.", { caseRule: "sentence" }).violations.some((v) => v.rule === "never-say"));
    const st = dir("pt");
    const lower = await x.postTweet(t, { type: "desk" }, { env: { TALK_STATE_PATH: st } });
    assert.ok(!lower.posted && /^lint: lowercase/.test(lower.reason));
    const sentence = await x.postTweet(t, { type: "desk", sentenceCase: true }, { env: { TALK_STATE_PATH: st } });
    assert.ok(!sentence.posted && /^dormant/.test(sentence.reason));
  });
  await test("the learners' counts come from the log's newest line per category", () => {
    const log = "[learning] memecoin: 16 of the 20 x\n[learning] stock: 6 of the 20 y\n[learning] memecoin: 17 of the 20 z\n";
    assert.deepEqual(builder.learningCountsOf(log), [{ category: "memecoin", n: 17, need: 20 }, { category: "stock", n: 6, need: 20 }]);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\ntalk builder: ${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
