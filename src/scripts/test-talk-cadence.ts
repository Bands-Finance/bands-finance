/**
 * The posting loop's cadence tests (src/talk/guards.ts and what src/talk/tick.ts does with it), each pinned to the
 * Merd incident it comes from. No network: X is a fake fetch; every file lives in a temp dir.
 *   npx tsx src/scripts/test-talk-cadence.ts
 * Covers: the per-key jitter (a waiting strap's wait the same on every tick), the daily's rank over a fresh close
 * from its hour, the day's event slots (a 5th event waits while a losing close goes, a 3rd open waits, a 3rd event
 * in one pool waits, a red>green>red strap flip posts twice), the lesson's kept slot, the repeat guards (an open in
 * another pool, a same-pool re-open, a strap with a different band out and two lessons a day apart all go; the
 * word overlap filters the milestone only; a lesson restating a milestone figure is filtered, one sharing a fee
 * figure with another seat's close is not), draft markers and self-echo in the vet, the backoff after three 402s
 * (60 min, then 120, a posted result resets, no draft row per held tick, X's detail in the reason), the milestone
 * gate at 40 SOL given milestoneN 3 with today's partial day never its best day, the lesson template's length
 * fallback, the craft hook (a text over 280 falls back to the template; the daily is never refused on length), the
 * loop log's new fields, the facts the craft hook gets (a STOP cycle's proposal is the engine's, not his), and the
 * plist's comments.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LedgerRow } from "../engine/ledger";
import type { Lesson } from "../learn/lessons";
import type { BandEvent, CraftFacts, LoopLog, TickFacts, TickState } from "../talk/tick";
import type { StrapResult } from "../talk/strap";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mr-bands-cadence-"));
process.env.DATA_DIR = tmp;
process.env.DRY_RUN = "true";
process.env.WALLET_SECRET_KEY = "";
for (const k of ["X_LIVE", "X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET", "OPERATOR_HANDLE", "X_HANDLE", "TALK_STATE_PATH", "POSTS_PER_DAY", "TALK_DAILY_HOUR_UTC", "TALK_RETRY_BACKOFF_MIN"]) delete process.env[k];

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
const at = (iso: string) => Date.parse(iso);
const FAKE_CREDS = { X_API_KEY: "ck-test", X_API_SECRET: "cs-test-secret", X_ACCESS_TOKEN: "at-test", X_ACCESS_SECRET: "as-test-secret" };

async function main(): Promise<void> {
  const tick = await import("../talk/tick.js");
  const guards = await import("../talk/guards.js");
  const craft = await import("../talk/craft.js");
  const x = await import("../talk/x.js");
  const { talkEnv } = await import("../talk/env.js");
  const { stackFigures } = await import("../talk/strap.js");
  const { emptyBook } = await import("../paper/book.js");
  const { loadTalkData } = await import("../talk/data.js");

  let n = 0;
  const dir = (name: string) => {
    const d = path.join(tmp, `${name}-${++n}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const readJ = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const vetEnv = { operatorHandle: null, houseSymbols: ["bands"], houseMints: [] };
  const vet = (text: string) => tick.vetOutgoing(text, { paper: true, env: vetEnv });

  // ------------------------------------------------------------ synthetic facts for the pure plan
  const env = talkEnv({ DATA_DIR: tmp, TALK_STATE_PATH: tmp, CYCLE_INTERVAL_SEC: "300" });
  const strapOf = (state: StrapResult["state"], total = 2, out = "nvdax/sol"): StrapResult => ({ state, total, inRange: state === "red" ? total - 1 : total, nearEdge: 0, outOfRange: state === "red" ? 1 : 0, positions: state === "red" ? [{ label: out, status: "out_above", edgeDistancePct: null, binsFromRange: 3, inRange: false } as never] : [], stackedEvent: null, detail: "", reason: null, edgePct: 15, dataAt: null });
  const factsAt = (now: number, extra: Partial<TickFacts> = {}): TickFacts => {
    const fig = (ms: number) => stackFigures({ rows: [], source: "paper", since: now - ms, until: now });
    return { now, source: "paper", paper: true, staleReason: null, events: [], strap: strapOf("green"), milestone: null, daily: { figures: fig(DAY), opened: 0, bookSol: 150, openBands: 2 }, stack7d: fig(7 * DAY), lessons: [], env, dayN: 9, recent: [], days: [], closes: {}, ...extra };
  };
  const close = (key: string, pool: string, when: number, netSol: number, label = "nvdax/sol"): BandEvent => ({ kind: "close", key: `close:${key}`, at: when, pool, label, netSol, feesSol: 0.0198, holdSec: 3.7 * 3600, outsideAtClose: false, relaidKey: null });
  const open = (key: string, pool: string, when: number, seatSol = 0.5, label = "nvdax/sol"): BandEvent => ({ kind: "open", key: `open:${key}`, at: when, pool, label, side: "BOTH", binsBelow: 20, binsAbove: 20, seatSol });
  const lessonOf = (position: string, closedAt: number, netSol: number, feesSol: number, extra: Partial<Lesson> = {}): Lesson => ({ at: closedAt, mode: "paper", pool: "P", label: "GMEx/SOL", position, kind: "stock", openedAt: closedAt - 4 * HOUR, closedAt, minutes: 240, seatSol: 10, bins: 5, binStep: 20, coverPct: 1, travelBins60m: null, inRangePct: 100, endReason: "idle", feesSol, netSol, tokensLeftSol: 0, predictedYieldPct: null, realizedYieldPctPerDay: 1, headline: "x", ...extra } as Lesson);
  const state = (extra: Partial<TickState> = {}): TickState => ({ ...tick.emptyTickState(), lastStrap: "green", lastDailyDay: "2026-09-22", lastLessonDay: "2026-09-22", milestoneN: 3, ...extra });
  const logOf = (extra: Partial<LoopLog> = {}): LoopLog => ({ seen: new Set(), postsToday: 0, times: [], todayEntries: [], todayByType: {}, recentTexts: [], ...extra });
  const OPTS = { postsPerDay: 6, dailyHourUtc: 14, minGapMin: 0, gapJitterMin: 0, windowPosts: 0, nightPosts: 0 };
  /** a Tuesday, 13:00 UTC: before the daily hour */
  const T13 = at("2026-09-22T13:00:00Z");

  // ------------------------------------------------------------ jitter
  console.log("jitter");
  await test("jitterMin: deterministic per key, within 0..45, spread over the range, 0 when off", () => {
    const a = guards.jitterMin("close:paper-A-1", 45);
    assert.equal(a, guards.jitterMin("close:paper-A-1", 45));
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const j = guards.jitterMin(`open:paper-X-${i}`, 45);
      assert.ok(Number.isInteger(j) && j >= 0 && j <= 45, String(j));
      seen.add(j);
    }
    assert.ok(seen.size > 30, `spread: ${seen.size} distinct values`);
    assert.equal(guards.jitterMin("close:paper-A-1", 0), 0);
  });
  await test("the gap is per candidate: an event waits 90 plus its jitter while the daily goes at the plain 90", () => {
    const now = at("2026-09-22T14:03:00Z");
    const last = now - 95 * MIN;
    // a close key whose jitter is over 10 min: 90 + jitter > the 95 min since the last post
    let key = "paper-A-1";
    let i = 0;
    while (guards.jitterMin(`close:${key}`, 45) <= 10) key = `paper-A-${++i}`;
    const f = factsAt(now, { events: [close(key, "P", now - 20 * MIN, 0.0915)] });
    const p = tick.planTick(f, state({ lastDailyDay: null }), logOf({ postsToday: 1, times: [last] }), { ...OPTS, minGapMin: 90, gapJitterMin: 45 });
    assert.equal(p.pick?.kind, "daily", p.notes.join("; "));
    assert.ok(p.notes.some((x) => /^gap: close close:paper-A-\d+ waits (9\d|1[0-3]\d) min/.test(x)), p.notes.join("; "));
    // with the daily gone, the close alone is spaced, and the reason names the jitter
    const q = tick.planTick(f, state(), logOf({ postsToday: 1, times: [last] }), { ...OPTS, minGapMin: 90, gapJitterMin: 45 });
    assert.equal(q.spaced, true);
    assert.match(q.notes[q.notes.length - 1], /TALK_MIN_GAP_MIN is 90 plus \d+ min of jitter for the close/);
    // a time-boxed kind never carries jitter: the lesson goes at exactly 90
    const l = factsAt(at("2026-09-22T18:00:00Z"), { lessons: [lessonOf("L1", at("2026-09-22T16:00:00Z"), 0.15, 0.2)] });
    const r = tick.planTick(l, state({ lastLessonDay: null }), logOf({ postsToday: 1, times: [l.now - 90 * MIN] }), { ...OPTS, minGapMin: 90, gapJitterMin: 45 });
    assert.equal(r.pick?.kind, "lesson");
  });

  await test("a waiting strap's wait does not change between ticks: its jitter is seeded on the time the change was first seen, not on the key's tick slot", () => {
    // a green>red change first seen 90 min after the last post, held by its jitter; find a first-seen time whose jitter is over 30 min
    let t0 = at("2026-09-22T13:00:00Z");
    while (guards.jitterMin(`strap:green>red:${t0}`, 45) <= 30) t0 += 15 * MIN;
    const last = t0 - 90 * MIN;
    const waits: number[] = [];
    let st = state({ lastStrap: "green", lastStrapPostAt: null });
    for (let k = 0; k < 3; k++) {
      const now = t0 + k * 15 * MIN;
      const p = tick.planTick(factsAt(now, { strap: strapOf("red") }), st, logOf({ postsToday: 1, times: [last] }), { ...OPTS, minGapMin: 90, gapJitterMin: 45 });
      assert.equal(p.spaced, true, `tick ${k}: ${p.notes.join("; ")}`);
      const m = p.notes[p.notes.length - 1].match(/plus (\d+) min of jitter for the strap/);
      assert.ok(m, p.notes.join("; "));
      waits.push(Number(m![1]));
      st = p.nextState;
      assert.equal(st.strapChangedAt, t0, "the change keeps the time it was first seen");
    }
    assert.equal(new Set(waits).size, 1, `the wait re-rolled: ${waits.join(", ")}`);
    assert.equal(waits[0], guards.jitterMin(`strap:green>red:${t0}`, 45));
    // and it goes on the first tick past 90 plus that jitter, not before
    const due = t0 + Math.ceil(waits[0] / 15) * 15 * MIN;
    const before = tick.planTick(factsAt(due - 15 * MIN, { strap: strapOf("red") }), st, logOf({ postsToday: 1, times: [last] }), { ...OPTS, minGapMin: 90, gapJitterMin: 45 });
    assert.equal(before.pick, null);
    const goes = tick.planTick(factsAt(due, { strap: strapOf("red") }), before.nextState, logOf({ postsToday: 1, times: [last] }), { ...OPTS, minGapMin: 90, gapJitterMin: 45 });
    assert.equal(goes.pick?.kind, "strap", goes.notes.join("; "));
  });

  // ------------------------------------------------------------ the daily's rank
  console.log("the daily's rank");
  await test("a daily at 14:03 outranks a fresh close; at 13:55 the close goes; the lesson keeps its rank", () => {
    const now = at("2026-09-22T14:03:00Z");
    const f = factsAt(now, { events: [close("A-1", "P", now - 8 * MIN, 0.0915)] });
    const p = tick.planTick(f, state({ lastDailyDay: null }), logOf(), OPTS);
    assert.equal(p.pick?.kind, "daily");
    assert.deepEqual(p.candidates.map((c) => c.kind), ["daily", "close"]);
    const before = at("2026-09-22T13:55:00Z");
    const q = tick.planTick(factsAt(before, { events: [close("A-1", "P", before - 8 * MIN, 0.0915)] }), state({ lastDailyDay: null }), logOf(), OPTS);
    assert.equal(q.pick?.kind, "close");
    // the daily gone, a close at 17:59 outranks the lesson at 18:00
    const late = at("2026-09-22T18:00:00Z");
    const r = tick.planTick(factsAt(late, { events: [close("A-2", "P", late - MIN, 0.01)], lessons: [lessonOf("L1", late - 3 * HOUR, 0.15, 0.2)] }), state({ lastLessonDay: null }), logOf(), OPTS);
    assert.deepEqual(r.candidates.map((c) => c.kind), ["close", "lesson"]);
  });

  await test("the daily numbers pass the rolling window (2 posts in the last 6h hold everything else), never the gap", () => {
    const now = at("2026-09-22T14:00:00Z");
    const f = factsAt(now, { events: [close("A-1", "P", now - 8 * MIN, 0.0915)] });
    const two = [now - 3 * HOUR, now - 95 * MIN];
    const p = tick.planTick(f, state({ lastDailyDay: null }), logOf({ postsToday: 2, times: two }), { ...OPTS, minGapMin: 90, windowPosts: 2, windowHours: 6 });
    assert.equal(p.pick?.kind, "daily", p.notes.join("; "));
    assert.ok(p.notes.some((x) => /^window: close close:A-1 waits, 2 posts in the last 6h; the daily numbers pass/.test(x)), p.notes.join("; "));
    const held = tick.planTick(f, state(), logOf({ postsToday: 2, times: two }), { ...OPTS, minGapMin: 90, windowPosts: 2, windowHours: 6 });
    assert.equal(held.spaced, true, "without the daily the window holds the close");
    const gap = tick.planTick(f, state({ lastDailyDay: null }), logOf({ postsToday: 2, times: [now - 3 * HOUR, now - 30 * MIN] }), { ...OPTS, minGapMin: 90, windowPosts: 2, windowHours: 6 });
    assert.equal(gap.spaced, true, "the gap still holds the daily");
  });

  // ------------------------------------------------------------ the day's event slots
  console.log("the day's event slots");
  const fourEvents = () => ({ todayEntries: [{ key: "close:E1", type: "close" }, { key: "open:E2", type: "open" }, { key: "strap:x", type: "strap" }, { key: "milestone:paper:30", type: "milestone" }], postsToday: 4 });
  await test("eventCaps: a 5th event of the day waits while a losing close goes; it never passes POSTS_PER_DAY", () => {
    const f = factsAt(T13, { events: [open("N1", "Q", T13 - 10 * MIN), close("L1", "R", T13 - 5 * MIN, -0.0412)] });
    const p = tick.planTick(f, state(), logOf(fourEvents()), OPTS);
    assert.equal(p.pick?.key, "close:L1", p.notes.join("; "));
    assert.ok(p.pick?.loss);
    assert.ok(p.notes.some((x) => /^open: 4 event posts today, TALK_EVENT_POSTS_PER_DAY is 4; open:N1 waits/.test(x)), p.notes.join("; "));
    // a winning close waits like any event
    const w = tick.planTick(factsAt(T13, { events: [close("W1", "R", T13 - 5 * MIN, 0.0412)] }), state(), logOf(fourEvents()), OPTS);
    assert.equal(w.pick, null);
    assert.equal(w.capped, true);
    // the loss still counts against POSTS_PER_DAY and the daily's kept slot
    const full = tick.planTick(f, state(), logOf({ ...fourEvents(), postsToday: 6 }), OPTS);
    assert.equal(full.pick, null);
    assert.match(full.notes[full.notes.length - 1], /^cap: 6 posts today/);
    const kept = tick.planTick(f, state({ lastDailyDay: null }), logOf({ ...fourEvents(), postsToday: 5 }), OPTS);
    assert.equal(kept.pick, null);
    assert.match(kept.notes[kept.notes.length - 1], /kept for the daily numbers/);
    // 0 turns the cap off
    assert.equal(tick.planTick(w.candidates.length ? factsAt(T13, { events: [close("W1", "R", T13 - 5 * MIN, 0.0412)] }) : f, state(), logOf(fourEvents()), { ...OPTS, eventPostsPerDay: 0 }).pick?.key, "close:W1");
  });
  await test("a 3rd open of the day waits, inside the event cap; a close still goes", () => {
    const log = logOf({ todayEntries: [{ key: "open:E1", type: "open" }, { key: "open:E2", type: "open" }], postsToday: 2 });
    const f = factsAt(T13, { events: [open("N3", "Q", T13 - 10 * MIN)] });
    const p = tick.planTick(f, state(), log, OPTS);
    assert.equal(p.pick, null);
    assert.ok(p.notes.some((x) => /^open: 2 opens posted today, TALK_OPEN_POSTS_PER_DAY is 2; open:N3 waits/.test(x)), p.notes.join("; "));
    const q = tick.planTick(factsAt(T13, { events: [open("N3", "Q", T13 - 10 * MIN), close("C1", "R", T13 - 5 * MIN, 0.01)] }), state(), log, OPTS);
    assert.equal(q.pick?.key, "close:C1");
    assert.equal(tick.planTick(f, state(), log, { ...OPTS, openPostsPerDay: 0 }).pick?.key, "open:N3", "0 turns it off");
  });
  await test("a 3rd event about one pool waits (the pool resolved from the events by key); another pool goes; a loss in that pool goes", () => {
    const events = [open("P1", "POOLP", T13 - 6 * HOUR), close("P1", "POOLP", T13 - 3 * HOUR, 0.01), open("P2", "POOLP", T13 - 10 * MIN), open("Q1", "POOLQ", T13 - 9 * MIN)];
    const log = logOf({ todayEntries: [{ key: "open:P1", type: "open" }, { key: "close:P1", type: "close" }], postsToday: 2 });
    const p = tick.planTick(factsAt(T13, { events }), state(), log, OPTS);
    assert.equal(p.pick?.key, "open:Q1", p.notes.join("; "));
    assert.ok(p.notes.some((x) => /^open: 2 event posts about POOLP today, the limit per pool is 2; open:P2 waits/.test(x)), p.notes.join("; "));
    const loss = tick.planTick(factsAt(T13, { events: [...events, close("P2", "POOLP", T13 - 5 * MIN, -0.02)] }), state(), log, OPTS);
    assert.equal(loss.pick?.key, "close:P2");
  });
  await test("a strap flip red > green > red inside a day posts twice, not three times; the third is one story already told", () => {
    let st = state({ lastStrap: "red", lastStrapPostAt: null });
    const times: number[] = [];
    const today: { key: string; type: string }[] = [];
    const picks: string[] = [];
    const flips: Record<number, StrapResult["state"]> = { 0: "green", 4: "red", 8: "green" };
    let strap = strapOf("red");
    for (let h = 0; h < 12; h += 0.25) {
      const now = T13 - 13 * HOUR + h * HOUR;
      if (flips[h]) strap = strapOf(flips[h]);
      const p = tick.planTick(factsAt(now, { strap }), st, logOf({ postsToday: times.length, times: [...times], todayEntries: [...today] }), { ...OPTS, minGapMin: 0 });
      st = p.nextState;
      if (p.pick) {
        picks.push(`${h}h ${p.pick.kind}`);
        times.push(now);
        today.push({ key: p.pick.key, type: p.pick.type });
      }
    }
    assert.deepEqual(picks, ["0h strap", "4h strap"], picks.join(", "));
    assert.equal(st.lastStrap, "green", "the memory moved on: the third flip is not re-proposed every tick");
    assert.equal(st.strapChangedAt, null);
    // a change that waits behind a close keeps the time it was first seen, and the craft facts say how long ago
    const seen: CraftFacts[] = [];
    const t0 = T13;
    const held = tick.planTick(factsAt(t0, { strap: strapOf("red"), events: [close("C1", "P", t0 - MIN, 0.01)] }), state({ lastStrap: "green" }), logOf(), { ...OPTS, shape: (k, facts) => (seen.push(facts), null) });
    assert.equal(held.pick?.kind, "close");
    assert.equal(held.nextState.lastStrap, "green", "the change waits");
    assert.equal(held.nextState.strapChangedAt, t0);
    const later = tick.planTick(factsAt(t0 + 30 * MIN, { strap: strapOf("red") }), held.nextState, logOf({ times: [t0], postsToday: 1, todayEntries: [{ key: "close:C1", type: "close" }] }), { ...OPTS, shape: (k, facts) => (seen.push(facts), null) });
    assert.equal(later.pick?.kind, "strap");
    assert.equal(seen.find((s) => s.strap && s.now === t0 + 30 * MIN)?.strap?.sinceMs, 30 * MIN);
    assert.equal(later.nextState.strapChangedAt, null);
  });
  await test("the lesson keeps a slot when 4 events went: at 18 UTC the fresh close waits and the lesson goes", () => {
    const now = at("2026-09-22T18:00:00Z");
    const f = factsAt(now, { events: [close("C9", "P", now - 5 * MIN, 0.02)], lessons: [lessonOf("L1", now - 3 * HOUR, 0.15, 0.2)] });
    const p = tick.planTick(f, state({ lastLessonDay: null }), logOf(fourEvents()), OPTS);
    assert.equal(p.pick?.kind, "lesson", p.notes.join("; "));
  });

  // ------------------------------------------------------------ repeats
  console.log("repeats");
  await test("similarity: meaningful words over the smaller set; tooSimilar at 0.85 catches a template repeat and not a different post", () => {
    const a = tick.openText(open("A", "P", T13, 0.5), "paper");
    const b = tick.openText(open("B", "P", T13, 0.75), "paper");
    assert.ok(guards.similarity(a, b) >= 0.85, String(guards.similarity(a, b)));
    const c = tick.closeText(close("C", "P", T13, 0.0915), "paper");
    assert.ok(guards.similarity(a, c) < 0.85, String(guards.similarity(a, c)));
    assert.equal(guards.similarity("", a), 0);
    assert.equal(guards.tooSimilar(c, [{ at: T13, text: a }]), null);
    assert.equal(guards.tooSimilar(b, [{ at: T13, text: a }])?.hit.text, a);
  });
  await test("the word overlap never filters an open, a strap or a lesson: an open in another pool, a same-pool re-open, a strap with a different band out and a green after a red all go after a same-shape post; the milestone is the one kind it filters", () => {
    const SHAPED = { ...OPTS, shape: craft.shapePost };
    const textOf = (f: TickFacts, st: TickState = state()) => tick.planTick(f, st, logOf(), SHAPED).pick!.text;
    // an open of the same shape yesterday in pool P: today's open in pool Q goes, and so does a new seat in P itself
    const earlier = textOf(factsAt(T13 - DAY, { events: [open("A-old", "P", T13 - DAY - 10 * MIN, 0.5, "nvdax/usdc")] }));
    const recentTexts = [{ at: T13 - DAY, text: earlier, key: "open:A-old", type: "open" }];
    const q = tick.planTick(factsAt(T13, { events: [open("Q-1", "Q", T13 - 10 * MIN, 0.75, "pltrx/sol")] }), state(), logOf({ recentTexts }), SHAPED);
    assert.equal(q.pick?.key, "open:Q-1", q.notes.join("; "));
    assert.ok(guards.similarity(earlier, q.pick!.text) >= 0.75, `the two opens share most of their words by construction: ${guards.similarity(earlier, q.pick!.text).toFixed(2)}`);
    const again = tick.planTick(factsAt(T13, { events: [open("A-new", "P", T13 - 10 * MIN, 0.75, "nvdax/usdc")] }), state(), logOf({ recentTexts }), SHAPED);
    assert.equal(again.pick?.key, "open:A-new", "a new seat in the same pool is a new fact");
    assert.ok(guards.similarity(earlier, again.pick!.text) >= 0.85, `the same pool again: ${guards.similarity(earlier, again.pick!.text).toFixed(2)} overlap, and it still goes`);
    assert.ok(!q.notes.concat(again.notes).some((x) => /^repeat/.test(x)), q.notes.concat(again.notes).join("; "));
    // two opens in different pools the same day: both eligible, the second goes once the first went
    const two = factsAt(T13, { events: [open("Q-1", "Q", T13 - 10 * MIN, 0.75, "pltrx/sol"), open("R-1", "R", T13 - 8 * MIN, 0.5, "gmex/sol")] });
    const first = tick.planTick(two, state(), logOf(), SHAPED);
    assert.deepEqual(first.candidates.map((c) => c.key), ["open:Q-1", "open:R-1"]);
    const second = tick.planTick({ ...two, now: T13 + 2 * HOUR, events: two.events.map((e) => ({ ...e, at: e.at + 2 * HOUR })) }, first.nextState, logOf({ recentTexts: [{ at: T13, text: first.pick!.text, key: "open:Q-1", type: "open" }], todayEntries: [{ key: "open:Q-1", type: "open" }], postsToday: 1, seen: new Set(["open:Q-1"]) }), SHAPED);
    assert.equal(second.pick?.key, "open:R-1", second.notes.join("; "));
    // a red strap with a different band out, a day after a red strap: goes; a green after a red goes though a green went 3 days ago
    const redOld = textOf(factsAt(T13 - DAY, { strap: strapOf("red", 4, "gmex/sol") }), state({ lastStrap: "green" }));
    const red = tick.planTick(factsAt(T13, { strap: strapOf("red", 4, "mu/usdc") }), state({ lastStrap: "green" }), logOf({ recentTexts: [{ at: T13 - DAY, text: redOld, key: "strap:green>red:1", type: "strap" }] }), SHAPED);
    assert.equal(red.pick?.kind, "strap", red.notes.join("; "));
    assert.ok(guards.similarity(redOld, red.pick!.text) >= 0.75, `the two reds share most of their words by construction: ${guards.similarity(redOld, red.pick!.text).toFixed(2)}`);
    const greenOld = textOf(factsAt(T13 - 3 * DAY, { strap: strapOf("green", 4) }), state({ lastStrap: "red" }));
    const green = tick.planTick(factsAt(T13, { strap: strapOf("green", 4) }), state({ lastStrap: "red" }), logOf({ recentTexts: [{ at: T13 - 3 * DAY, text: greenOld, key: "strap:red>green:1", type: "strap" }] }), SHAPED);
    assert.equal(green.pick?.kind, "strap", green.notes.join("; "));
    assert.equal(guards.similarity(greenOld, green.pick!.text), 1, "the same state three days apart is the same text");
    assert.equal(green.nextState.lastStrap, "green");
    // a loss is always said
    const lossText = tick.closeText(close("L-old", "P", T13 - DAY, -0.0412), "paper");
    const l = tick.planTick(factsAt(T13, { events: [close("L-new", "P", T13 - 10 * MIN, -0.0412)] }), state(), logOf({ recentTexts: [{ at: T13 - DAY, text: lossText, key: "close:L-old", type: "close" }] }), OPTS);
    assert.equal(l.pick?.key, "close:L-new");
    // the milestone keeps the guard: a milestone reworded from a non-milestone post of the week is a note with its key unspent
    const m = factsAt(T13, { milestone: { n: 4, step: 10, firstAt: T13 - 12 * HOUR, netSol: 0.9534 } });
    const text = tick.planTick(m, state(), logOf(), OPTS).pick!.text;
    const filtered = tick.planTick(m, state(), logOf({ recentTexts: [{ at: T13 - 2 * DAY, text, key: "strap:x", type: "strap" }] }), OPTS);
    assert.equal(filtered.pick, null);
    assert.ok(filtered.notes.some((x) => /^repeat: milestone milestone:paper:40 has 1\.00 overlap with the strap of 20 sep; the key stays unspent/.test(x)), filtered.notes.join("; "));
    assert.equal(filtered.nextState.milestoneN, 3, "the gate did not move");
  });
  await test("two losing lessons a day apart in different pools both go (the same three-part shape, different seats); a lesson with the same fee figure as another seat's close goes; one restating the milestone's net is filtered", () => {
    const SHAPED = { ...OPTS, shape: craft.shapePost };
    const y = at("2026-09-21T18:00:00Z");
    const now = y + DAY;
    const ctx = { proposed: null, decided: "CLOSE_POSITION", directive: "STOP", source: "engine", binsOut: 14 };
    // 21 sep is a monday: its daily and stack have gone, so the lesson is the pick
    const first = tick.planTick(factsAt(y, { lessons: [lessonOf("N1", y - 3 * HOUR, -0.0412, 0.0087, { label: "NVDAx/USDC", endReason: "stop", minutes: 312, inRangePct: 80 })], closes: { N1: ctx } }), state({ lastLessonDay: null, lastDailyDay: "2026-09-21", lastStackDay: "2026-09-21" }), logOf(), SHAPED);
    assert.equal(first.pick?.key, "lesson:N1", first.notes.join("; "));
    const second = tick.planTick(factsAt(now, { lessons: [lessonOf("M1", now - 3 * HOUR, -0.0203, 0.0121, { label: "MU/USDC", endReason: "stop", minutes: 198, inRangePct: 75 })], closes: { M1: ctx } }), state({ lastLessonDay: null }), logOf({ recentTexts: [{ at: y, text: first.pick!.text, key: "lesson:N1", type: "lesson" }] }), SHAPED);
    assert.equal(second.pick?.key, "lesson:M1", second.notes.join("; "));
    assert.ok(guards.similarity(first.pick!.text, second.pick!.text) >= 0.75, `the two lessons share most of their words by construction: ${guards.similarity(first.pick!.text, second.pick!.text).toFixed(2)}`);
    // seat B closed today with fees 0.0100 and its close was posted; seat D's lesson also carries 0.0100: a coincidence, not a repeat
    const bClose = { at: now - 5 * HOUR, text: tick.closeText({ ...close("B1", "PB", now - 5 * HOUR, 0.05, "pltrx/sol"), feesSol: 0.01 }, "paper"), key: "close:B1", type: "close" };
    const d = tick.planTick(factsAt(now, { lessons: [lessonOf("D1", now - 3 * HOUR, -0.2, 0.01, { label: "SKHY/USDC", endReason: "stop" })] }), state({ lastLessonDay: null }), logOf({ recentTexts: [bClose] }), SHAPED);
    assert.equal(d.pick?.key, "lesson:D1", d.notes.join("; "));
    assert.match(d.pick!.text, /fees 0\.0100 sol/);
    // the milestone's net restated by a lesson is still the repeat it was
    const milestone = { at: now - 2 * HOUR, text: tick.paperize(tick.milestoneText({ n: 3, step: 10, firstAt: now - 12 * HOUR, netSol: -0.2 }, "paper"), true), key: "milestone:paper:30", type: "milestone" };
    const r = tick.planTick(factsAt(now, { lessons: [lessonOf("D1", now - 3 * HOUR, -0.2, 0.01, { label: "SKHY/USDC", endReason: "stop" })] }), state({ lastLessonDay: null }), logOf({ recentTexts: [milestone] }), SHAPED);
    assert.equal(r.pick, null);
    assert.ok(r.notes.some((x) => /^repeat: lesson lesson:D1 restates 0\.2000 from the milestone of 22 sep/.test(x)), r.notes.join("; "));
  });
  await test("repeatedStat: the same 4-decimal figure; a lesson restating the milestone figure is filtered and the next unseen seat goes; its own close is not a repeat", () => {
    assert.deepEqual([...guards.statTokens("net +0.9534 sol, fees 1.0710 sol, 5 bands, 0.0000, 12.5%")], ["0.9534", "1.0710"]);
    const milestone = { at: T13 - 2 * HOUR, text: "realized fees on the paper book passed 30 sol since 14 sep.\nfees are not profit: net realized over the same stretch is +0.9534 sol, losses, rent and swaps included.", key: "milestone:paper:30", type: "milestone" };
    assert.equal(guards.repeatedStat("net +0.9534 sol", [milestone])?.stat, "0.9534");
    assert.equal(guards.repeatedStat("net +0.9535 sol", [milestone]), null);
    const now = at("2026-09-22T18:00:00Z");
    const f = factsAt(now, { lessons: [lessonOf("L-big", now - 3 * HOUR, 0.9534, 1.071), lessonOf("L-next", now - 2 * HOUR, 0.15, 0.2)] });
    const p = tick.planTick(f, state({ lastLessonDay: null }), logOf({ recentTexts: [milestone] }), OPTS);
    assert.equal(p.pick?.key, "lesson:L-next", p.notes.join("; "));
    assert.ok(p.notes.some((x) => /^repeat: lesson lesson:L-big restates 0\.9534 from the milestone of 22 sep/.test(x)), p.notes.join("; "));
    const own = { at: now - 3 * HOUR, text: tick.closeText(close("L-big", "P", now - 3 * HOUR, 0.9534), "paper"), key: "close:L-big", type: "close" };
    const q = tick.planTick(f, state({ lastLessonDay: null }), logOf({ recentTexts: [own] }), OPTS);
    assert.equal(q.pick?.key, "lesson:L-big", "the close and the lesson agree by design");
    // the milestone itself is not filtered by a daily that carries the same net (a young book's window equals its whole run)
    const m = factsAt(T13, { milestone: { n: 4, step: 10, firstAt: T13 - 12 * HOUR, netSol: 0.9534 } });
    const daily = { at: T13 - HOUR, text: "daily numbers, last 24h, paper book:\nnet realized +0.9534 sol after losses, rent, swaps and network fees", key: "daily:2026-09-22", type: "daily" };
    assert.equal(tick.planTick(m, state(), logOf({ recentTexts: [daily] }), OPTS).pick?.kind, "milestone");
    // nor by the previous milestone in the same form: the 40 sol step goes a day after the 30 sol step
    const thirty = { at: T13 - DAY, text: tick.paperize(tick.milestoneText({ n: 3, step: 10, firstAt: T13 - 12 * HOUR, netSol: 0.5 }, "paper"), true), key: "milestone:paper:30", type: "milestone" };
    assert.ok(guards.similarity(thirty.text, tick.milestoneText({ n: 4, step: 10, firstAt: T13 - 12 * HOUR, netSol: 0.9534 }, "paper")) >= 0.85, "the templates overlap");
    assert.equal(tick.planTick(m, state(), logOf({ recentTexts: [thirty] }), OPTS).pick?.key, "milestone:paper:40");
  });

  // ------------------------------------------------------------ markers and echo
  console.log("markers and echo");
  await test("vetOutgoing refuses draft markers (**, reasoning:, draft:, post:, note:, a skip line) and a sentence said twice", () => {
    const rules = (t: string) => vet(t).map((v) => v.rule);
    assert.ok(rules("**closed my band** on nvdax/sol. paper book.").includes("loop-markers"));
    assert.ok(rules("reasoning: the band closed.\nclosed my band on nvdax/sol. paper book.").includes("loop-markers"));
    assert.ok(rules("Draft: closed my band on nvdax/sol. paper book.").includes("loop-markers"));
    assert.ok(rules("post: closed my band on nvdax/sol. paper book.").includes("loop-markers"));
    assert.ok(rules("closed my band on nvdax/sol. paper book.\nnote: fees not profit").includes("loop-markers"));
    assert.ok(rules("skip\nclosed my band on nvdax/sol. paper book.").includes("loop-markers"));
    assert.ok(rules("(skip: nothing to say). paper book.").includes("loop-markers"));
    assert.ok(rules("closed my band on nvdax/sol after 3.7h. closed my band on nvdax/sol after 3.7h. paper book.").includes("self-echo"));
    assert.ok(rules("closed my band on nvdax/sol.\nclosed my band on nvdax/sol.\npaper book.").includes("self-echo"));
    assert.deepEqual(rules("closed my band on nvdax/sol after 3.7h.\nnet +0.0915 sol. fees 0.0198 sol counted in it.\npaper book."), []);
    assert.deepEqual(rules("net 0.0000 sol. paper book. net 0.0000 sol."), [], "short fragments may recur");
    assert.equal(guards.markersIn("the post: closed"), null, "a label only at the start of a line");
    assert.equal(guards.selfEcho("fees 0.1000 sol. fees 0.1000 sol."), null, "a key of 12 characters or fewer may recur");
  });

  // ------------------------------------------------------------ backoff
  console.log("backoff");
  await test("backoff (pure): the 3rd transient refusal holds 60 min, then 120, 240, 360 capped; posted or dormant resets; a final refusal leaves it", () => {
    let s = { transientFails: 0, backoffUntil: null as number | null };
    const step = (r: "posted" | "dormant" | "transient" | "other") => {
      const b = guards.backoff(s, r, T13, 60);
      s = { transientFails: b.transientFails, backoffUntil: b.backoffUntil };
      return b.heldMin;
    };
    assert.equal(step("transient"), 0);
    assert.equal(step("transient"), 0);
    assert.equal(step("transient"), 60);
    assert.equal(s.backoffUntil, T13 + 60 * MIN);
    assert.equal(step("transient"), 120);
    assert.equal(step("transient"), 240);
    assert.equal(step("transient"), 360);
    assert.equal(step("transient"), 360);
    assert.equal(step("other"), 0);
    assert.equal(s.transientFails, 7);
    assert.equal(step("posted"), 0);
    assert.deepEqual(s, { transientFails: 0, backoffUntil: null });
    step("transient");
    assert.equal(step("dormant"), 0);
    assert.equal(s.transientFails, 0);
    assert.equal(guards.backoff({ transientFails: 5, backoffUntil: null }, "transient", T13, 0).heldMin, 0, "0 turns the hold off");
    assert.equal(guards.backingOff({ backoffUntil: T13 + 1 }, T13), true);
    assert.equal(guards.backingOff({ backoffUntil: T13 }, T13), false);
    assert.equal(guards.backingOff({}, T13), false);
  });

  // a small paper desk for the runner: one open band, one closed band, a fresh mark
  const band = (i: { address: string; pool: string; label: string; openedAt: number; markAt: number }) => ({
    address: i.address, pool: i.pool, label: i.label, quoteSymbol: "SOL" as const, quoteSide: "Y" as const, quoteMint: "So11111111111111111111111111111111111111112", tokenMint: `${i.pool}-mint`, tokenSymbol: "t",
    xDecimals: 8, yDecimals: 9, lowerBinId: 0, upperBinId: 4, lowerPrice: 1.0, upperPrice: 1.01, binStep: 20, strategy: "Spot" as const, strategyNote: null, side: "BOTH" as const,
    quoteDeposit: 5, tokenDeposit: 5, openedAt: i.openedAt, openedBinId: 2, openedPrice: 1.005, entryValueSol: 10, feeQuote: 0, feeToken: 0, lastMarkAt: i.markAt, lastActiveBinId: 2,
    lastMark: { at: i.markAt, activeBinId: 2, price: 1.005, tokenPriceInQuote: 1.005, quotePriceInSol: 1, valueInSol: 10.1, quoteInPosition: 5, amountQuote: 5, amountToken: 5, feeSol: 0.01, inRange: true, binsFromRange: 0 },
  });
  const closedBand = (i: { address: string; pool: string; label: string; openedAt: number; closedAt: number; realized: number; fee: number }) => ({
    address: i.address, pool: i.pool, label: i.label, quoteSymbol: "SOL" as const, side: "BOTH" as const, lowerBinId: 0, upperBinId: 4, quoteDeposit: 5, tokenDeposit: 5, openedAt: i.openedAt, openedPrice: 1,
    entryValueSol: 10, closedAt: i.closedAt, closedPrice: 1, closedActiveBinId: 2, quoteBack: 5, tokenBack: 5, feeQuote: 0, feeToken: 0, feeSol: i.fee, slippageSol: 0, proceedsSol: 10 + i.realized,
    realizedSol: i.realized, realizedPct: i.realized * 10, holdSec: (i.closedAt - i.openedAt) / 1000, inRangeAtClose: true, reason: "close", emergency: false,
  });
  const row = (ts: number, mech: LedgerRow["mech"], o: Partial<LedgerRow>): LedgerRow => ({ ts, mode: "dry-run", sig: null, pool: "POOLA", position: null, mech, solDelta: 0, tokenDelta: 0, tokenMint: "m", markTokenInSol: 0.002, rentSol: 0, txFeeSol: -0.000005, basis: "marked", note: `paper: ${mech}`, ...o });
  const makeData = (now: number) => {
    const d = dir("data");
    const book = emptyBook(150, 0, now - 3 * DAY);
    const markAt = now - MIN;
    book.bands = [band({ address: "paper-A-3", pool: "POOLA", label: "NVDAx/SOL", openedAt: now - 30 * HOUR, markAt })];
    book.closed = [closedBand({ address: "paper-X-1", pool: "POOLX", label: "GMEx/SOL", openedAt: now - 9 * HOUR, closedAt: now - 30 * MIN, realized: -0.0412, fee: 0.0087 })];
    book.lastMarkAt = markAt;
    fs.writeFileSync(path.join(d, "paper-book.json"), JSON.stringify(book));
    const rows: LedgerRow[] = [
      row(now - 3 * DAY + HOUR, "open", { position: "paper-old", solDelta: -10, rentSol: -0.05 }),
      row(now - 2 * DAY, "close", { position: "paper-old", solDelta: 10.3, feeSol: 0.3, entryValueSol: 10, rentSol: 0.05 }),
      row(now - 30 * HOUR, "open", { position: "paper-A-3", solDelta: -10, rentSol: -0.05 }),
      row(now - 9 * HOUR, "open", { pool: "POOLX", position: "paper-X-1", solDelta: -10, rentSol: -0.05 }),
      row(now - 30 * MIN, "close", { pool: "POOLX", position: "paper-X-1", solDelta: 9.9588, feeSol: 0.0087, entryValueSol: 10, rentSol: 0.05 }),
    ];
    fs.writeFileSync(path.join(d, "ledger.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const entry = (ts: number, extra: object) => ({ id: `e${ts}`, ts: new Date(ts).toISOString(), cycle: 1, mode: "paper", pool: { address: "POOLX", label: "GMEx/SOL", price: 1.005 }, positions: [], llm: { source: "policy", model: "desk-policy", note: "Desk policy (hold): nothing to do." }, proposal: { action: "HOLD" }, decision: { action: "HOLD" }, allowed: true, execution: { mode: "none", ok: true }, ...extra });
    // a STOP cycle as src/index.ts writes it: the model is not called, the proposal is the engine's own CLOSE_POSITION with llm.source "engine"
    const closing = entry(now - 30 * MIN, { positions: [{ address: "paper-X-1", inRange: false, binsFromRange: 14 }], llm: { source: "engine", model: "engine", note: "STOP: 14 bins out" }, proposal: { action: "CLOSE_POSITION" }, decision: { action: "CLOSE_POSITION" }, engine: { directive: "STOP" }, execution: { mode: "paper", ok: true, closed: "paper-X-1" } });
    fs.writeFileSync(path.join(d, "decisions.jsonl"), [JSON.stringify(closing), JSON.stringify(entry(markAt, {}))].join("\n") + "\n");
    fs.writeFileSync(path.join(d, "lessons.jsonl"), JSON.stringify(lessonOf("paper-X-1", now - 30 * MIN, -0.0412, 0.0087, { label: "GMEx/SOL", endReason: "stop", tokensLeftSol: 0.0123, inRangePct: 62 })) + "\n");
    return d;
  };
  const NO_SPACING = { TALK_MIN_GAP_MIN: "0", TALK_GAP_JITTER_MIN: "0", TALK_WINDOW_POSTS: "0", TALK_NIGHT_POSTS: "0" };
  const envOf = (dataDir: string, statePath: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ DATA_DIR: dataDir, TALK_STATE_PATH: statePath, CYCLE_INTERVAL_SEC: "300", ...NO_SPACING, ...extra });
  const LIVE = { X_LIVE: "true", ...FAKE_CREDS, OPERATOR_HANDLE: "zach", X_HANDLE: "mrbands" };
  const ME = new Response(JSON.stringify({ data: { id: "42", username: "mrbands" } }), { status: 200 });

  await test("3 consecutive 402s back off 60 min: no X call and no draft row on a held tick; the 4th holds 120; a posted result resets; X's detail is in the reason", async () => {
    const T15 = at("2026-09-22T15:00:00Z");
    const data = makeData(T15);
    const st = dir("state");
    let status = 402;
    let posts = 0;
    const fetchFake = (async (url: string) => {
      if (url.endsWith("/2/users/me")) return ME.clone();
      posts++;
      return new Response(JSON.stringify(status === 201 ? { data: { id: "1790000000000000001" } } : { title: "Payment Required", detail: "credits depleted, top up at developer.x.com", status }), { status });
    }) as unknown as typeof fetch;
    const env = envOf(data, st, LIVE);
    // the desk keeps marking the book through the hours this test simulates (a mark older than 3 cycles is stale)
    const remark = (now: number) => {
      const file = path.join(data, "paper-book.json");
      const book = JSON.parse(fs.readFileSync(file, "utf8"));
      book.lastMarkAt = now - MIN;
      for (const b of book.bands) (b.lastMarkAt = now - MIN), (b.lastMark.at = now - MIN);
      fs.writeFileSync(file, JSON.stringify(book));
    };
    const run = (offsetMin: number) => (remark(T15 + offsetMin * MIN), tick.runTick({ voice: "ledger", env, paperDesk: true, now: T15 + offsetMin * MIN, fetch: fetchFake, shape: null }));
    const r1 = await run(0);
    assert.equal(r1.status, "not-posted");
    assert.match(r1.detail, /^x api 402: Payment Required; credits depleted, top up at developer\.x\.com \(will retry\)$/);
    assert.equal(tick.readTickState(st).transientFails, 1);
    const r2 = await run(1);
    assert.equal(r2.status, "not-posted");
    assert.equal(tick.readTickState(st).transientFails, 2);
    const r3 = await run(2);
    assert.equal(r3.status, "not-posted");
    assert.equal(r3.detail, "x: 3 transient failures in a row (x api 402: Payment Required; credits depleted, top up at developer.x.com), backing off 60 min");
    const s3 = tick.readTickState(st);
    assert.equal(s3.transientFails, 3);
    assert.equal(s3.backoffUntil, T15 + 62 * MIN);
    assert.equal(posts, 3);
    const drafts = readJ(path.join(st, "x-drafts.jsonl"));
    assert.equal(drafts.length, 3);
    assert.ok(drafts.every((d) => d.retry === true && /^x api 402/.test(d.reason)));
    // held: nothing fetched, no draft row, the key still unspent, the gates untouched
    const r4 = await run(17);
    assert.equal(r4.status, "backoff");
    assert.match(r4.detail, /^x: backing off until 16:02 utc after 3 transient failures in a row; nothing sent this tick$/);
    assert.equal(posts, 3);
    assert.equal(readJ(path.join(st, "x-drafts.jsonl")).length, 3);
    assert.equal(tick.loopLogOf(st, T15 + 17 * MIN).seen.size, 0);
    assert.equal(tick.readTickState(st).lastDailyDay, null);
    assert.equal((await run(61)).status, "backoff", "one minute short");
    // the hold over: one call, a 4th failure, 120 min this time
    const r5 = await run(63);
    assert.equal(r5.status, "not-posted");
    assert.match(r5.detail, /backing off 120 min$/);
    assert.equal(posts, 4);
    assert.equal(tick.readTickState(st).backoffUntil, T15 + (63 + 120) * MIN);
    // X back: the post goes and the counter clears
    status = 201;
    const r6 = await run(63 + 121);
    assert.equal(r6.status, "posted", r6.detail);
    assert.equal(r6.pick?.kind, "daily");
    const s6 = tick.readTickState(st);
    assert.equal(s6.transientFails, 0);
    assert.equal(s6.backoffUntil, null);
    // a preview still runs during a hold
    status = 402;
    for (let i = 0; i < 3; i++) await run(200 + i);
    assert.equal((await run(204)).status, "backoff");
    assert.equal((await tick.runTick({ voice: "ledger", env, paperDesk: true, now: T15 + 204 * MIN, fetch: fetchFake, shape: null, force: "daily" })).status, "preview");
    // TALK_RETRY_BACKOFF_MIN=0 turns the hold off
    const st2 = dir("state");
    const env2 = envOf(data, st2, { ...LIVE, TALK_RETRY_BACKOFF_MIN: "0" });
    remark(T15);
    for (let i = 0; i < 4; i++) assert.equal((await tick.runTick({ voice: "ledger", env: env2, paperDesk: true, now: T15 + i * MIN, fetch: fetchFake, shape: null })).status, "not-posted");
    assert.equal(tick.readTickState(st2).backoffUntil, null);
  });
  await test("x.ts keeps X's detail beside the title in a refusal reason, sliced, and never the request", async () => {
    assert.equal(x.describeXError({ title: "Payment Required", detail: "credits depleted" }), ": Payment Required; credits depleted");
    assert.equal(x.describeXError({ title: "Unauthorized" }), ": Unauthorized");
    assert.equal(x.describeXError({ detail: "x".repeat(300) }), `: ${"x".repeat(200)}`);
    assert.equal(x.describeXError({}), "");
    assert.equal(x.describeXError(null), "");
    const fetchFake = (async () => new Response(JSON.stringify({ title: "Unauthorized", detail: "token revoked" }), { status: 401 })) as typeof fetch;
    const r = await x.verifyCredentials({ env: FAKE_CREDS, fetch: fetchFake });
    assert.deepEqual(r, { ok: false, reason: "x api 401: Unauthorized; token revoked" });
    assert.equal(x.retryableReason("x api 402: Payment Required; credits depleted"), true);
    for (const v of Object.values(FAKE_CREDS)) assert.ok(!JSON.stringify(r).includes(v));
  });

  // ------------------------------------------------------------ the milestone gate and the lesson fallback
  console.log("milestone and lesson");
  await test("the milestone gate starts at 40 sol given milestoneN 3: n 3 posts nothing, n 4 posts the 40 sol step with its best and last day", () => {
    const facts: Partial<CraftFacts>[] = [];
    const shape = (kind: string, f: CraftFacts) => (facts.push(f), null);
    const days = [{ day: "2026-09-20", feesSol: 0.5, netSol: 0.4, closed: 2 }, { day: "2026-09-21", feesSol: 1.2, netSol: 0.9, closed: 3 }, { day: "2026-09-22", feesSol: 0.1, netSol: 0.05, closed: 1 }];
    const at3 = factsAt(T13, { milestone: { n: 3, step: 10, firstAt: T13 - 8 * DAY, netSol: 1.35 }, days });
    assert.equal(tick.planTick(at3, state({ milestoneN: 3 }), logOf(), { ...OPTS, shape }).pick, null);
    const at4 = factsAt(T13, { milestone: { n: 4, step: 10, firstAt: T13 - 8 * DAY, netSol: 1.35 }, days });
    const p = tick.planTick(at4, state({ milestoneN: 3 }), logOf(), { ...OPTS, shape });
    assert.equal(p.pick?.key, "milestone:paper:40");
    assert.match(p.pick!.text, /passed 40 sol/);
    assert.equal(p.nextState.milestoneN, 4);
    assert.equal(facts[0].milestone?.bestDay?.day, "2026-09-21");
    assert.equal(facts[0].milestone?.lastDay?.day, "2026-09-21", "the most recent complete day");
    // a milestone that fires early in a strong day: today's partial day is neither the best day nor the most recent one
    const strong = factsAt(T13, { milestone: { n: 4, step: 10, firstAt: T13 - 8 * DAY, netSol: 1.35 }, days: [...days.slice(0, 2), { day: "2026-09-22", feesSol: 9.9, netSol: 5, closed: 3 }] });
    const q = tick.planTick(strong, state({ milestoneN: 3 }), logOf(), { ...OPTS, shape });
    assert.equal(q.pick?.key, "milestone:paper:40");
    assert.equal(facts[facts.length - 1].milestone?.bestDay?.day, "2026-09-21");
    assert.equal(facts[facts.length - 1].milestone?.lastDay?.day, "2026-09-21");
    const onlyToday = factsAt(T13, { milestone: { n: 4, step: 10, firstAt: T13 - HOUR, netSol: 1.35 }, days: [{ day: "2026-09-22", feesSol: 9.9, netSol: 5, closed: 3 }] });
    tick.planTick(onlyToday, state({ milestoneN: 3 }), logOf(), { ...OPTS, shape });
    assert.equal(facts[facts.length - 1].milestone?.bestDay, null, "no completed day: no days line");
    assert.equal(facts[facts.length - 1].milestone?.lastDay, null);
    // before TALK_DAY_START_UTC the milestone waits
    assert.equal(tick.planTick({ ...at4, now: at("2026-09-22T11:00:00Z") }, state({ milestoneN: 3 }), logOf(), OPTS).pick, null);
  });
  await test("the lesson template fits 280 on a loss with fees and unsold tokens: the tokens-left clause goes first, never the loss", () => {
    const l = lessonOf("L", T13 - HOUR, -0.5678, 0.1234, { label: "abcdefghijkl/mnopqrstuvwx", minutes: 12.3 * 60, inRangePct: 62, endReason: "through-band", tokensLeftSol: 0.0123 });
    const text = tick.lessonFromSeat(l, "paper");
    assert.ok(tick.loopLength(text) <= 280, `${tick.loopLength(text)}: ${text}`);
    assert.ok(!/still in tokens/.test(text));
    assert.match(text, /net -0\.5678 sol\./);
    assert.match(text, /fees came in and the seat still lost\. fees are not profit\./);
    assert.deepEqual(vet(text), []);
    // the same seat with a short label still runs 288 with the through-band ending; a stop ending fits, and the clause stays
    assert.ok(!/still in tokens/.test(tick.lessonFromSeat({ ...l, label: "gmex/sol" }, "paper")));
    const short = tick.lessonFromSeat({ ...l, label: "gmex/sol", endReason: "stop" }, "paper");
    assert.match(short, /0\.0123 sol of that still in tokens, not sold\./, "kept when it fits");
    assert.ok(tick.loopLength(short) <= 280);
    // through the plan: the day's lesson is not lost
    const p = tick.planTick(factsAt(at("2026-09-22T18:00:00Z"), { lessons: [l] }), state({ lastLessonDay: null }), logOf(), OPTS);
    assert.equal(p.pick?.kind, "lesson");
    assert.deepEqual(vet(p.pick!.text), []);
  });

  // ------------------------------------------------------------ the craft hook
  console.log("the craft hook");
  await test("shapePost: the hook's text is used (paperized, vetted), null keeps the template, a throwing hook is a note and the template goes; the facts carry the extras", () => {
    const seen: CraftFacts[] = [];
    const now = at("2026-09-22T18:00:00Z");
    const f = factsAt(now, {
      events: [close("A-1", "P", now - 10 * MIN, -0.0412)],
      lessons: [lessonOf("A-1", now - 10 * MIN, -0.0412, 0.0087)],
      closes: { "A-1": { proposed: "HOLD", decided: "CLOSE_POSITION", directive: "STOP", source: "llm", binsOut: 14 } },
      recent: [{ day: "2026-09-21", feesSol: 0.0412, netSol: 0.03, closed: 2 }],
      dayN: 9,
    });
    const shape = (kind: string, facts: CraftFacts) => {
      seen.push(facts);
      if (kind === "close") return `nvdax/sol, closed 17:50 utc after 3.7h.\nnet ${facts.event!.netSol! < 0 ? "-0.0412 sol, a loss" : "up"}. price sat ${facts.event!.binsOut} bins above the band. i had proposed ${facts.event!.proposed!.toLowerCase()}; the stop closed it.`;
      if (kind === "lesson") throw new Error("boom");
      return null;
    };
    const p = tick.planTick(f, state({ lastLessonDay: null }), logOf(), { ...OPTS, shape });
    assert.equal(p.pick?.kind, "close");
    assert.equal(p.pick!.text, "nvdax/sol, closed 17:50 utc after 3.7h.\nnet -0.0412 sol, a loss. price sat 14 bins above the band. i had proposed hold; the stop closed it.\n(paper)");
    assert.deepEqual(vet(p.pick!.text), []);
    const lesson = p.candidates.find((c) => c.kind === "lesson")!;
    assert.match(lesson.text, /^what one closed seat taught me/, "the template after a throw");
    assert.ok(p.notes.some((x) => /^craft: lesson lesson:A-1 fell back to the template \(boom\)/.test(x)), p.notes.join("; "));
    const c = seen.find((s) => s.event?.kind === "close")!;
    assert.equal(c.seed, "close:A-1");
    assert.equal(c.event?.openBands, 2);
    assert.deepEqual(c.recent, f.recent);
    assert.equal(c.paper, true);
    assert.equal(c.event?.directive, "STOP");
    assert.equal(c.event?.binsOut, 14);
    const l = seen.find((s) => s.lesson)!;
    assert.equal(l.seed, "lesson:A-1");
    assert.equal(l.lesson?.proposed, "HOLD");
    assert.equal(l.lesson?.directive, "STOP");
    const d = tick.planTick(f, state({ lastDailyDay: null }), logOf(), { ...OPTS, shape: (k, facts) => (seen.push(facts), null) });
    assert.equal(d.pick?.kind, "daily");
    const dailyFacts = seen.find((s) => s.daily)!;
    assert.equal(dailyFacts.daily?.dayN, 9);
    assert.deepEqual(dailyFacts.daily?.recent, f.recent);
    // no hook: the template
    const t = tick.planTick(f, state(), logOf(), OPTS);
    assert.match(t.pick!.text, /^closed my band on nvdax\/sol/);
    // a hook's text over 280 (with the paper line counted) is a note and the template goes: a refused text would spend the key
    const long = tick.planTick(f, state({ lastDailyDay: null }), logOf(), { ...OPTS, shape: (k) => (k === "daily" ? `day 9: ${"fees 0.0087 sol, ".repeat(18)}nothing else.` : null) });
    assert.equal(long.pick?.kind, "daily");
    assert.match(long.pick!.text, /^daily numbers, last 24h, paper book:/);
    assert.ok(long.notes.some((x) => /^craft: daily daily:2026-09-22 ran \d+ characters, over 280; the template goes/.test(x)), long.notes.join("; "));
    // a hook's text still goes through the vet in the runner: a marker is refused, not posted
  });
  await test("the daily is never refused on length: the craft's odd-parity card on an extreme day with a yesterday row goes through planTick and the runner under 280", async () => {
    // 23 sep is odd; the week before ends yesterday; today is the thinnest day of it, so both parts of the comparison want in
    const now = at("2026-09-23T14:00:00Z");
    const recent = [16, 17, 18, 19, 20, 21, 22].map((d, i) => ({ day: `2026-09-${d}`, feesSol: [0.21, 0.33, 0.12, 0.5, 0.09, 0.7, 0.0412][i], netSol: 0.01, closed: 2 }));
    const fig = stackFigures({ rows: [], source: "paper", since: now - DAY, until: now });
    const f = factsAt(now, { recent, dayN: 9, daily: { figures: { ...fig, feesRealizedSol: 0.0087, netRealizedSol: -0.0301, closedBands: 3, closedUp: 2, closedDown: 1, worstCloseSol: -0.0412 }, opened: 2, bookSol: 312.3456, openBands: 4 } });
    const p = tick.planTick(f, state({ lastDailyDay: null }), logOf(), { ...OPTS, shape: craft.shapePost });
    assert.equal(p.pick?.kind, "daily", p.notes.join("; "));
    assert.ok(tick.loopLength(p.pick!.text) <= 280, `${tick.loopLength(p.pick!.text)}: ${p.pick!.text}`);
    assert.deepEqual(vet(p.pick!.text), []);
    assert.match(p.pick!.text, /^day 9, paper book, net -0\.0301 sol on the day\./);
    assert.match(p.pick!.text, /book marked at 312\.3456 sol, 4 bands open/);
    assert.ok(!p.notes.some((x) => /^craft/.test(x)), "the craft's own fit did it, not the fallback");
    // the runner on the same odd day, with the real craft: drafted, not refused-lint
    const data = makeData(now);
    const r = await tick.runTick({ voice: "ledger", env: envOf(data, dir("state")), paperDesk: true, now });
    assert.equal(r.status, "drafted", r.detail);
    assert.equal(r.pick?.kind, "daily");
    assert.ok(tick.loopLength(r.pick!.text) <= 280);
    assert.match(r.pick!.text, /after \d\.\d{4} yesterday|thinner|fatter|day 4/);
  });
  await test("the runner passes the hook through to the plan and vets its text (a marker is refused, never posted)", async () => {
    const T15 = at("2026-09-22T15:00:00Z");
    const data = makeData(T15);
    const st = dir("state");
    let calls = 0;
    const fetchFake = (async () => (calls++, new Response("{}", { status: 500 }))) as typeof fetch;
    const shape = () => "**daily** numbers. paper book.";
    const r = await tick.runTick({ voice: "ledger", env: envOf(data, st, LIVE), paperDesk: true, now: T15, fetch: fetchFake, shape });
    assert.equal(r.status, "refused-lint");
    assert.ok(r.violations!.some((v) => v.rule === "loop-markers"));
    assert.equal(calls, 0);
    const ok = await tick.runTick({ voice: "ledger", env: envOf(data, dir("state")), paperDesk: true, now: T15, shape: () => "day 9, paper book: fees 0.0087 sol today." });
    assert.equal(ok.status, "drafted");
    assert.equal(ok.pick?.text, "day 9, paper book: fees 0.0087 sol today.");
  });

  // ------------------------------------------------------------ the loop log and the facts
  console.log("the log and the facts");
  await test("loopLogOf: today's entries by key and type (dry records included), recent texts without retried or lint-refused drafts", () => {
    const st = dir("state");
    const rows = [
      { id: "1", text: "closed a. paper book.", type: "close", at: new Date(T13 - HOUR).toISOString(), replyTo: null, replyToHandle: null, key: "close:a" },
      { id: "draft:open:b", text: "opened b. paper book.", type: "open", at: new Date(T13 - 2 * HOUR).toISOString(), replyTo: null, replyToHandle: null, key: "open:b", dry: true },
      { id: "3", text: "yesterday. paper book.", type: "strap", at: new Date(T13 - DAY).toISOString(), replyTo: null, replyToHandle: null, key: "strap:y" },
      { id: "4", text: "old. paper book.", type: "close", at: new Date(T13 - 8 * DAY).toISOString(), replyTo: null, replyToHandle: null, key: "close:old" },
    ];
    fs.writeFileSync(path.join(st, "x-posts.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const drafts = [
      { at: new Date(T13 - 3 * HOUR).toISOString(), type: "open", text: "retried. paper book.", reason: "x api 402: Payment Required", key: "open:c", retry: true },
      { at: new Date(T13 - 3 * HOUR).toISOString(), type: "close", text: "buy. paper book.", reason: "lint: price-call", key: "close:d" },
      { at: new Date(T13 - 3 * HOUR).toISOString(), type: "milestone", text: "dormant. paper book.", reason: 'dormant: X_LIVE is not "true"', key: "milestone:paper:10" },
    ];
    fs.writeFileSync(path.join(st, "x-drafts.jsonl"), drafts.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const log = tick.loopLogOf(st, T13);
    assert.equal(log.postsToday, 2);
    assert.deepEqual(log.todayEntries, [{ key: "close:a", type: "close" }, { key: "open:b", type: "open" }]);
    assert.deepEqual(log.todayByType, { close: 1, open: 1 });
    assert.deepEqual(log.recentTexts!.map((r) => r.key).sort(), ["close:a", "milestone:paper:10", "open:b", "strap:y"]);
    assert.deepEqual([...log.seen].sort(), ["close:a", "close:d", "milestone:paper:10", "open:b", "strap:y"]);
  });
  await test("factsOf: day N from the first row, the last 7 days' figures, and the closing cycle's proposal, decision, directive and bins", () => {
    const T15 = at("2026-09-22T15:00:00Z");
    const d = makeData(T15);
    const t = talkEnv(envOf(d, dir("s")));
    const f = tick.factsOf(loadTalkData(t, T15), t, [], { paperDesk: true, milestoneSol: 10 });
    assert.equal(f.dayN, 4, "first row 3 days ago: day 4");
    assert.deepEqual(f.recent.map((r) => r.day), ["2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22"]);
    assert.equal(f.recent[3].closed, 1);
    assert.ok(Math.abs(f.recent[1].feesSol - 0.3) < 1e-9);
    assert.deepEqual(f.closes["paper-X-1"], { proposed: null, decided: "CLOSE_POSITION", directive: "STOP", source: "engine", binsOut: 14 }, "a STOP cycle: the engine's own proposal is not his");
    // a desk-policy close keeps its proposal, with the source the craft words it by
    const policy = { id: "p", ts: new Date(T15).toISOString(), cycle: 2, mode: "paper", pool: { address: "POOLY", label: "MU/USDC", price: 1 }, positions: [{ address: "paper-Y-1", inRange: true, binsFromRange: 0 }], llm: { source: "policy", model: "desk-policy" }, proposal: { action: "CLOSE_POSITION" }, decision: { action: "CLOSE_POSITION" }, allowed: true, execution: { mode: "paper", ok: true, closed: "paper-Y-1" } } as never;
    assert.deepEqual(tick.closeContextsOf([policy])["paper-Y-1"], { proposed: "CLOSE_POSITION", decided: "CLOSE_POSITION", directive: null, source: "policy", binsOut: 0 });
    // the craft, fed that context, never says he proposed the engine's close
    const shaped = craft.shapePost("close", { source: "paper", paper: true, now: T15, seed: "close:paper-X-1", event: { ...f.events.find((e) => e.key === "close:paper-X-1")!, ...f.closes["paper-X-1"], openBands: 1 } })!;
    assert.match(shaped, /^the stop closed it\.$/m);
    assert.ok(!/proposed/.test(shaped), shaped);
    assert.equal(tick.dayNumberOf(at("2026-09-14T22:42:15Z"), at("2026-09-22T14:00:00Z")), 9);
    assert.deepEqual(tick.closeContextsOf([]), {});
    assert.deepEqual(tick.dayFiguresOf([], "paper", T15 - DAY, T15), []);
  });

  // ------------------------------------------------------------ the plist
  console.log("the plist");
  await test("ops/com.bands.mrbands.talk.plist documents the new knobs in comments and adds no env value; X_LIVE stays out", () => {
    const p = fs.readFileSync(path.resolve(process.cwd(), "ops/com.bands.mrbands.talk.plist"), "utf8");
    for (const k of ["TALK_GAP_JITTER_MIN", "TALK_EVENT_POSTS_PER_DAY", "TALK_OPEN_POSTS_PER_DAY", "TALK_RETRY_BACKOFF_MIN"]) assert.ok(p.includes(k), k);
    const body = p.replace(/<!--[\s\S]*?-->/g, "");
    for (const k of ["TALK_GAP_JITTER_MIN", "TALK_EVENT_POSTS_PER_DAY", "TALK_OPEN_POSTS_PER_DAY", "TALK_RETRY_BACKOFF_MIN", "X_LIVE"]) assert.ok(!body.includes(k), `${k} is a comment, not a value`);
    assert.ok(!/[—–]/.test(p), "no em or en dash");
    const src = fs.readFileSync(path.resolve(process.cwd(), "src/talk/guards.ts"), "utf8") + fs.readFileSync(path.resolve(process.cwd(), "src/talk/tick.ts"), "utf8");
    assert.ok(!/[—–]/.test(src), "no em or en dash in the code");
    assert.ok(!/replyToMention|screenMention|getEngagement|in_reply_to|mentions/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")), "still no replies anywhere in the loop");
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
