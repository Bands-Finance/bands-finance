/**
 * The posting loop's tests (src/talk/tick.ts, src/talk/lock.ts, the loop's additions to src/talk/x.ts).
 * No network: X is a fake fetch; every file lives in a temp dir.   npx tsx src/scripts/test-tick.ts
 * Covers: label sanitizing ("$PEPE @someone" never tags or cashtags), the loop's vet (symbols, the link allowlist,
 * paper said, the lint), the priority order over a run of ticks, the 7-day dedupe and the re-centre a close covers,
 * the daily cap (6 by default), strap posts only on a change and with a cooldown, the milestone seed, the daily
 * hour, the Monday stack, a lint failure logged and never posted, the stop file, stale data, the tick lock and the
 * rate lock (two ticks never double-post), posting through a fake X with X_LIVE=true, the credential check
 * (a GET that X_LIVE does not gate, no secret printed), no replies anywhere in the loop, and the launchd plist.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LedgerRow } from "../engine/ledger";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mr-bands-tick-"));
process.env.DATA_DIR = tmp;
process.env.DRY_RUN = "true";
process.env.WALLET_SECRET_KEY = "";
for (const k of ["X_LIVE", "X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET", "OPERATOR_HANDLE", "X_HANDLE", "TALK_STATE_PATH", "POSTS_PER_DAY", "TALK_DAILY_HOUR_UTC"]) delete process.env[k];

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
const DAYMS = 24 * HOUR;
/** a Tuesday, after the default daily hour (14 UTC) */
const NOW = Date.parse("2026-09-22T15:00:00.000Z");
const FAKE_CREDS = { X_API_KEY: "ck-test", X_API_SECRET: "cs-test-secret", X_ACCESS_TOKEN: "at-test", X_ACCESS_SECRET: "as-test-secret" };

async function main(): Promise<void> {
  const tickModule = await import("../talk/tick.js");
  // the loop's tests read the templates in tick.ts: the craft hook (src/talk/craft.ts, its own tests) is pinned off
  const tick = { ...tickModule, runTick: (o: Parameters<typeof tickModule.runTick>[0]) => tickModule.runTick({ shape: null, ...o }) };
  const lock = await import("../talk/lock.js");
  const x = await import("../talk/x.js");
  const lint = await import("../talk/lint.js");
  const { emptyBook } = await import("../paper/book.js");

  let n = 0;
  const dir = (name: string) => {
    const d = path.join(tmp, `${name}-${++n}`);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  // ------------------------------------------------------------ fixture: a paper desk with a re-centre, a loss and a lesson
  const band = (i: { address: string; pool: string; label: string; openedAt: number; markAt: number }) => ({
    address: i.address, pool: i.pool, label: i.label, quoteSymbol: "SOL" as const, quoteSide: "Y" as const, quoteMint: "So11111111111111111111111111111111111111112", tokenMint: `${i.pool}-mint`, tokenSymbol: "t",
    xDecimals: 8, yDecimals: 9, lowerBinId: 0, upperBinId: 4, lowerPrice: 1.0, upperPrice: 1.01, binStep: 20, strategy: "Spot" as const, strategyNote: null, side: "BOTH" as const,
    quoteDeposit: 5, tokenDeposit: 5, openedAt: i.openedAt, openedBinId: 2, openedPrice: 1.005, entryValueSol: 10, feeQuote: 0, feeToken: 0, lastMarkAt: i.markAt, lastActiveBinId: 2,
    lastMark: { at: i.markAt, activeBinId: 2, price: 1.005, tokenPriceInQuote: 1.005, quotePriceInSol: 1, valueInSol: 10.1, quoteInPosition: 5, amountQuote: 5, amountToken: 5, feeSol: 0.01, inRange: true, binsFromRange: 0 },
  });
  const closed = (i: { address: string; pool: string; label: string; openedAt: number; closedAt: number; realized: number; fee: number; inRange: boolean }) => ({
    address: i.address, pool: i.pool, label: i.label, quoteSymbol: "SOL" as const, side: "BOTH" as const, lowerBinId: 0, upperBinId: 4, quoteDeposit: 5, tokenDeposit: 5, openedAt: i.openedAt, openedPrice: 1,
    entryValueSol: 10, closedAt: i.closedAt, closedPrice: 1, closedActiveBinId: 2, quoteBack: 5, tokenBack: 5, feeQuote: 0, feeToken: 0, feeSol: i.fee, slippageSol: 0, proceedsSol: 10 + i.realized,
    realizedSol: i.realized, realizedPct: i.realized * 10, holdSec: (i.closedAt - i.openedAt) / 1000, inRangeAtClose: i.inRange, reason: "Pump @someone $SCAM now", emergency: false,
  });
  const row = (ts: number, mech: LedgerRow["mech"], o: Partial<LedgerRow>): LedgerRow => ({ ts, mode: "dry-run", sig: null, pool: "POOLA", position: null, mech, solDelta: 0, tokenDelta: 0, tokenMint: "m", markTokenInSol: 0.002, rentSol: 0, txFeeSol: -0.000005, basis: "marked", note: `paper: ${mech}`, ...o });

  interface Fixture {
    now?: number;
    markAgo?: number;
    scamLabel?: string;
    closedLabel?: string;
  }
  const makeData = (f: Fixture = {}) => {
    const now = f.now ?? NOW;
    const d = dir("data");
    const book = emptyBook(150, 0, now - 40 * HOUR);
    const markAt = now - (f.markAgo ?? MIN);
    book.bands = [band({ address: "paper-A-3", pool: "POOLA", label: "NVDAx/SOL", openedAt: now - 30 * MIN, markAt })];
    book.closed = [
      closed({ address: "paper-B-1", pool: "POOLB", label: f.scamLabel ?? "$PEPE @someone/SOL", openedAt: now - 5 * HOUR, closedAt: now - 20 * MIN, realized: -0.5, fee: 0.1, inRange: false }),
      closed({ address: "paper-A-2", pool: "POOLA", label: f.closedLabel ?? "NVDAx/SOL", openedAt: now - 9 * HOUR, closedAt: now - 30 * MIN, realized: 0.2, fee: 0.3, inRange: true }),
    ];
    book.lastMarkAt = markAt;
    fs.writeFileSync(path.join(d, "paper-book.json"), JSON.stringify(book));
    const rows: LedgerRow[] = [
      row(now - 9 * HOUR, "open", { position: "paper-A-2", solDelta: -10, rentSol: -0.05 }),
      row(now - 5 * HOUR, "open", { pool: "POOLB", position: "paper-B-1", solDelta: -10, rentSol: -0.05 }),
      row(now - 3 * HOUR, "collect", { position: "paper-A-2", solDelta: 12, feeSol: 12 }),
      row(now - 30 * MIN, "close", { position: "paper-A-2", solDelta: 10.2, feeSol: 0.3, entryValueSol: 10, rentSol: 0.05 }),
      row(now - 30 * MIN, "open", { position: "paper-A-3", solDelta: -10, rentSol: -0.05 }),
      row(now - 20 * MIN, "close", { pool: "POOLB", position: "paper-B-1", solDelta: 9.5, feeSol: 0.1, entryValueSol: 10, rentSol: 0.05 }),
    ];
    fs.writeFileSync(path.join(d, "ledger.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const entry = { id: "e1", ts: new Date(markAt).toISOString(), cycle: 1, mode: "paper", pool: { address: "POOLA", label: "NVDAx/SOL", price: 1.005 }, positions: [], decision: { action: "HOLD" }, allowed: true, execution: { mode: "none", ok: true } };
    fs.writeFileSync(path.join(d, "decisions.jsonl"), JSON.stringify(entry) + "\n");
    const lesson = { at: now - 20 * MIN, mode: "paper", pool: "POOLB", label: f.scamLabel ?? "$PEPE @someone/SOL", position: "paper-B-1", kind: "memecoin", openedAt: now - 5 * HOUR, closedAt: now - 20 * MIN, minutes: 280, seatSol: 10, bins: 5, binStep: 20, coverPct: 1, travelBins60m: null, inRangePct: 62, endReason: "through-band", feesSol: 0.1, netSol: -0.5, tokensLeftSol: 0, predictedYieldPct: null, realizedYieldPctPerDay: 1, headline: "x" };
    fs.writeFileSync(path.join(d, "lessons.jsonl"), JSON.stringify(lesson) + "\n");
    return d;
  };
  /** the spacing rules off (they have their own tests below), so a run of ticks shows the priority order */
  const NO_SPACING = { TALK_MIN_GAP_MIN: "0", TALK_WINDOW_POSTS: "0", TALK_NIGHT_POSTS: "0", TALK_LESSON_HOUR_UTC: "0" };
  const envOf = (dataDir: string, statePath: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ DATA_DIR: dataDir, TALK_STATE_PATH: statePath, CYCLE_INTERVAL_SEC: "300", ...NO_SPACING, ...extra });
  const seedState = (statePath: string, s: Partial<import("../talk/tick").TickState>) => tick.writeTickState(statePath, { ...tick.emptyTickState(), ...s });
  const ME = (username: string) => new Response(JSON.stringify({ data: { id: "42", username } }), { status: 200 });
  const readJ = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

  // ------------------------------------------------------------ labels and the vet
  console.log("labels and the vet");
  await test("sanitizeLabel: no @, # or $, only plain symbols, lowercase", () => {
    assert.equal(tick.sanitizeLabel("$PEPE @someone/SOL"), "pepe/sol");
    assert.equal(tick.sanitizeLabel("$SCAM @someone/SOL"), "a pool", "a scam word in a label reads a pool");
    assert.equal(tick.sanitizeLabel("NVDAx/SOL"), "nvdax/sol");
    assert.equal(tick.sanitizeLabel("#pump/usdc"), "usdc");
    assert.equal(tick.sanitizeLabel("pump.fun/SOL"), "pumpfun/sol");
    assert.equal(tick.sanitizeLabel("＠evil/ＳＯＬ"), "sol");
    assert.equal(tick.sanitizeLabel("@@@/###"), "a pool");
    assert.equal(tick.sanitizeLabel(null), "a pool");
    for (const s of ["$A @b #c/d", "x‮@y/z", "https://evil.com/sol"]) assert.ok(!/[@#$:.]/.test(tick.sanitizeLabel(s)), s);
  });
  await test("vetOutgoing: @, # or $, links off the loop's allowlist, a paper post without paper, and the lint all fail", () => {
    const env = { operatorHandle: null, houseSymbols: ["bands"], houseMints: [] };
    const rules = (t: string, paper = true) => tick.vetOutgoing(t, { paper, env }).map((v) => v.rule);
    assert.deepEqual(rules("closed my band on nvdax/sol. paper book."), []);
    assert.ok(rules("closed my band. paper @someone").includes("loop-symbols"));
    assert.ok(rules("closed my band. paper $scam").includes("loop-symbols"));
    assert.ok(rules("closed my band. paper #lp").includes("loop-symbols"));
    assert.ok(rules("paper book. evil.com/x").includes("loop-link"));
    assert.ok(rules("paper book. https://meteora.ag/x").includes("loop-link"), "only app.meteora.ag");
    assert.deepEqual(rules("paper book. mrbands.finance"), []);
    assert.deepEqual(rules("paper book. https://app.meteora.ag/dlmm/abc"), []);
    assert.deepEqual(rules("paper book. https://solscan.io/tx/abc"), []);
    assert.ok(rules("closed my band on nvdax/sol.").includes("loop-paper"));
    assert.deepEqual(rules("closed my band on nvdax/sol.", false), []);
    assert.ok(rules("paper book. 40% apy on this").includes("return-promise"));
    assert.ok(rules("paper book. buy/sol closed").includes("price-call"));
  });
  await test("the lint allows mrbands.finance (added to its allowlist)", () => {
    assert.ok(lint.linkAllowed("mrbands.finance"));
    assert.ok(lint.linkAllowed("https://mrbands.finance/record"));
    assert.ok(!lint.linkAllowed("mrbands.finance.evil.com"));
  });
  await test("paperize adds (paper) only when the desk is paper and the text does not say it", () => {
    assert.equal(tick.paperize("closed my band.", true), "closed my band.\n(paper)");
    assert.equal(tick.paperize("closed my band.\npaper book.", true), "closed my band.\npaper book.");
    assert.equal(tick.paperize("closed my band.", false), "closed my band.");
  });

  // ------------------------------------------------------------ a run of ticks
  console.log("a run of ticks");
  await test("priority: the daily numbers (past their hour), close, close, strap change, milestone, lesson; then the cap of 6 holds; every draft passes the lint and says paper", async () => {
    const data = makeData();
    const st = dir("state");
    seedState(st, { lastStrap: "red", milestoneN: 0 });
    const env = envOf(data, st);
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await tick.runTick({ env, paperDesk: true, now: NOW + i * MIN });
      assert.equal(r.status, "drafted", `tick ${i} ${r.status}: ${r.detail} after ${seen.join(" ")}`);
      seen.push(`${r.pick!.kind}:${r.pick!.key}`);
      assert.match(r.pick!.text, /\bpaper\b/);
      assert.deepEqual(tick.vetOutgoing(r.pick!.text, { paper: true, env: { operatorHandle: null, houseSymbols: ["bands"], houseMints: [] } }), []);
      assert.ok(!/[@#$]/.test(r.pick!.text));
    }
    // the daily outranks the event kinds from TALK_DAILY_HOUR_UTC until it has gone (NOW is 15:00 UTC)
    assert.deepEqual(seen.map((s) => s.split(":")[0]), ["daily", "close", "close", "strap", "milestone", "lesson"]);
    assert.equal(seen[1], "close:close:paper-A-2", "the older close first");
    assert.equal(seen[2], "close:close:paper-B-1");
    const r7 = await tick.runTick({ env, paperDesk: true, now: NOW + 6 * MIN });
    assert.equal(r7.status, "idle", "the re-laid open is covered by its close; the stale open is old news");
    const posts = readJ(path.join(st, "x-posts.jsonl"));
    assert.equal(posts.length, 6);
    assert.ok(posts.every((p) => p.dry === true && p.id.startsWith("draft:") && p.key));
    assert.equal(x.readPosts(st).length, 0, "dry records are not posts");
    const drafts = readJ(path.join(st, "x-drafts.jsonl"));
    assert.equal(drafts.length, 6);
    assert.ok(drafts.every((d) => d.key && /^dormant/.test(d.reason)));
    const loss = posts.find((p) => p.key === "close:paper-B-1")!.text as string;
    assert.match(loss, /closed my band on pepe\/sol after 4\.7h\.\nnet -0\.5000 sol, a loss\. fees 0\.1000 sol counted in it\./);
    assert.match(loss, /price was outside the band when it closed\./);
    const recentre = posts.find((p) => p.key === "close:paper-A-2")!.text as string;
    // paper-A-2 has no lesson row: its whole life from the ledger (open -10, a 12 SOL claim while open, close 10.2, rent back)
    assert.match(recentre, /net \+12\.2000 sol\. fees 12\.3000 sol counted in it\.\nlaid a fresh band in the same pool\./);
    const daily = posts.find((p) => p.type === "daily")!.text as string;
    assert.match(daily, /^daily numbers, last 24h, paper book:/);
    assert.match(daily, /moves: 3 opened, 2 closed, 1 up and 1 down, worst -0\.5000 sol/);
    const lessonPost = posts.find((p) => p.type === "lesson")!.text as string;
    assert.match(lessonPost, /pepe\/sol, 4\.7h in the seat, in range 62% of checks/);
    assert.match(lessonPost, /fees came in and the seat still lost\. fees are not profit\./);
    const ms = posts.find((p) => p.type === "milestone")!.text as string;
    assert.match(ms, /realized fees on the paper book passed 10 sol since 22 sep\./);
    // a 7th candidate would be over the cap of 6: a forced one is only a preview, and says the cap holds
    const r8 = await tick.runTick({ env, paperDesk: true, now: NOW + 7 * MIN, force: "daily" });
    assert.equal(r8.status, "preview");
    assert.match(r8.detail, /cap: 6 posts today/);
    assert.equal(readJ(path.join(st, "x-posts.jsonl")).length, 6);
  });
  await test("POSTS_PER_DAY overrides the loop's 6; the day resets at 00:00 UTC", async () => {
    const data = makeData();
    const st = dir("state");
    const env = envOf(data, st, { POSTS_PER_DAY: "1" });
    assert.equal((await tick.runTick({ env, paperDesk: true, now: NOW })).status, "drafted");
    assert.equal((await tick.runTick({ env, paperDesk: true, now: NOW + MIN })).status, "capped");
    const log = tick.loopLogOf(st, Date.parse("2026-09-23T00:05:00Z"));
    assert.equal(log.postsToday, 0);
    assert.equal(log.seen.size, 1);
  });
  await test("dedupe: a key posted or drafted in the last 7 days is never used again, even after the tick state is lost", async () => {
    const data = makeData();
    const st = dir("state");
    const env = envOf(data, st);
    const a = await tick.runTick({ env, paperDesk: true, now: NOW });
    fs.rmSync(path.join(st, "tick-state.json"));
    const b = await tick.runTick({ env, paperDesk: true, now: NOW + MIN });
    assert.notEqual(a.pick!.key, b.pick!.key);
    const log = tick.loopLogOf(st, NOW + 8 * 24 * HOUR);
    assert.equal(log.seen.size, 0, "keys age out after 7 days");
  });
  await test("the first tick seeds the strap and the milestone without posting about history", async () => {
    const data = makeData();
    const st = dir("state");
    const env = envOf(data, st);
    for (let i = 0; i < 4; i++) await tick.runTick({ env, paperDesk: true, now: NOW + i * MIN });
    const kinds = readJ(path.join(st, "x-posts.jsonl")).map((p) => p.type);
    assert.ok(!kinds.includes("strap") && !kinds.includes("milestone"), kinds.join(","));
    const s = tick.readTickState(st);
    assert.ok(s.lastStrap && s.lastStrap !== "unknown");
    assert.equal(s.milestoneN, 1);
  });

  // ------------------------------------------------------------ the plan, pure
  console.log("the plan");
  const { talkEnv } = await import("../talk/env.js");
  const { loadTalkData } = await import("../talk/data.js");
  const factsAt = (now: number, extra: Record<string, string> = {}) => {
    const d = makeData({ now });
    const t = talkEnv(envOf(d, dir("s"), extra));
    return tick.factsOf(loadTalkData(t, now), t, [], { paperDesk: true, milestoneSol: 10 });
  };
  const noLog = { seen: new Set<string>(), postsToday: 0 };
  const opts = { postsPerDay: 6, dailyHourUtc: 14, minGapMin: 0, windowPosts: 0, nightPosts: 0, lessonHourUtc: 0 };
  await test("strap: a post only on a change, and not twice inside the cooldown", () => {
    const f = factsAt(NOW);
    const drop = { ...f, events: [], milestone: null, lessons: [] };
    const base = { ...tick.emptyTickState(), lastDailyDay: "2026-09-22", lastLessonDay: "2026-09-22" };
    assert.equal(tick.planTick(drop, { ...base, lastStrap: f.strap.state }, noLog, opts).pick, null);
    assert.equal(tick.planTick(drop, { ...base, lastStrap: null }, noLog, opts).pick, null);
    const changed = tick.planTick(drop, { ...base, lastStrap: "red" }, noLog, opts);
    assert.equal(changed.pick?.kind, "strap");
    assert.equal(changed.nextState.lastStrapPostAt, NOW);
    const cooled = tick.planTick(drop, { ...base, lastStrap: "red", lastStrapPostAt: NOW - HOUR }, noLog, opts);
    assert.equal(cooled.pick, null);
    assert.equal(cooled.nextState.lastStrap, f.strap.state);
  });
  await test("the daily numbers wait for TALK_DAILY_HOUR_UTC and go once a UTC day", () => {
    const early = Date.parse("2026-09-22T13:59:00Z");
    const f = { ...factsAt(early), events: [], milestone: null, lessons: [] };
    const s = { ...tick.emptyTickState(), lastStrap: f.strap.state };
    assert.equal(tick.planTick(f, s, noLog, opts).pick, null);
    const g = { ...factsAt(NOW), events: [], milestone: null, lessons: [] };
    const p = tick.planTick(g, { ...s, lastStrap: g.strap.state }, noLog, opts);
    assert.equal(p.pick?.kind, "daily");
    assert.equal(p.nextState.lastDailyDay, "2026-09-22");
    assert.equal(tick.planTick(g, p.nextState, noLog, opts).pick, null);
  });
  await test("the weekly stack goes on UTC Mondays only, once", () => {
    const monday = Date.parse("2026-09-21T15:00:00Z");
    const f = { ...factsAt(monday), events: [], milestone: null, lessons: [] };
    const s = { ...tick.emptyTickState(), lastStrap: f.strap.state, lastDailyDay: "2026-09-21" };
    const p = tick.planTick(f, s, noLog, opts);
    assert.equal(p.pick?.kind, "stack");
    assert.match(p.pick!.text, /^stack update, last 7d \(paper\):/);
    assert.equal(tick.planTick(f, p.nextState, noLog, opts).pick, null);
    const g = { ...factsAt(NOW), events: [], milestone: null, lessons: [] };
    assert.equal(tick.planTick(g, { ...s, lastStrap: g.strap.state, lastDailyDay: "2026-09-22" }, noLog, opts).pick, null, "not on a tuesday");
  });
  await test("a lesson at most once a UTC day, from a seat closed in the last 24h", () => {
    const f = factsAt(NOW);
    const lesson = { at: NOW - HOUR, mode: "paper", pool: "P", label: "GMEx/SOL", position: "paper-L-1", kind: "stock", openedAt: NOW - 5 * HOUR, closedAt: NOW - HOUR, minutes: 240, seatSol: 10, bins: 5, binStep: 20, coverPct: 1, travelBins60m: null, inRangePct: 100, endReason: "idle", feesSol: 0.2, netSol: 0.15, predictedYieldPct: null, realizedYieldPctPerDay: 1, headline: "x" } as const;
    const g = { ...f, events: [], milestone: null, lessons: [lesson as never] };
    const s = { ...tick.emptyTickState(), lastStrap: f.strap.state, lastDailyDay: "2026-09-22" };
    const p = tick.planTick(g, s, noLog, opts);
    assert.equal(p.pick?.kind, "lesson");
    assert.match(p.pick!.text, /gmex\/sol, 4\.0h in the seat, in range 100% of checks\.\nfees 0\.2000 sol, net \+0\.1500 sol\.\nprice left the band and stayed away/);
    assert.equal(tick.planTick(g, p.nextState, noLog, opts).pick, null);
    const old = { ...g, lessons: [{ ...lesson, closedAt: NOW - 30 * HOUR } as never] };
    assert.equal(tick.planTick(old, s, noLog, opts).pick, null);
  });
  await test("a dry-run book (not paper-tagged by its template) still says paper while the desk is paper", () => {
    const f = factsAt(NOW);
    const e = f.events.find((x) => x.kind === "close")!;
    const g = { ...f, source: "dry-run" as const, events: [e], milestone: null, lessons: [] };
    const p = tick.planTick(g, { ...tick.emptyTickState(), lastStrap: f.strap.state, lastDailyDay: "2026-09-22", lastLessonDay: "2026-09-22" }, noLog, opts);
    assert.match(p.pick!.text, /dry run, nothing broadcast\.\n\(paper\)$/);
  });
  await test("stale data: nothing about positions, and the strap memory is not touched", () => {
    const f = { ...factsAt(NOW), staleReason: "old" };
    const p = tick.planTick(f, { ...tick.emptyTickState(), lastStrap: "red" }, noLog, opts);
    assert.equal(p.pick, null);
    assert.equal(p.stale, "old");
    assert.equal(p.nextState.lastStrap, "red");
  });

  // ------------------------------------------------------------ safety in the runner
  console.log("safety");
  await test("a draft that fails the lint is logged with the reason and never posted, and not retried", async () => {
    const data = makeData({ closedLabel: "BUY/SOL" });
    const st = dir("state");
    let calls = 0;
    const fetchFake = (async () => {
      calls++;
      return new Response(JSON.stringify({ data: { id: "1" } }), { status: 201 });
    }) as typeof fetch;
    const env = envOf(data, st, { X_LIVE: "true", ...FAKE_CREDS, OPERATOR_HANDLE: "zach", X_HANDLE: "mrbands" });
    seedState(st, { lastDailyDay: "2026-09-22" }); // the daily has gone: the close is first
    const r = await tick.runTick({ env, paperDesk: true, now: NOW, fetch: fetchFake });
    assert.equal(r.status, "refused-lint");
    assert.ok(r.violations!.some((v) => v.rule === "price-call"));
    assert.equal(calls, 0);
    const d = readJ(path.join(st, "x-drafts.jsonl"));
    assert.equal(d.length, 1);
    assert.match(d[0].reason, /^lint: price-call/);
    assert.equal(d[0].key, "close:paper-A-2");
    assert.equal(readJ(path.join(st, "x-posts.jsonl")).length, 0);
    const r2 = await tick.runTick({ env, paperDesk: true, now: NOW + MIN, fetch: fetchFake });
    assert.notEqual(r2.pick?.key, "close:paper-A-2");
  });
  await test("TALK_STOP halts the tick before anything is read or written", async () => {
    const data = makeData();
    const st = dir("state");
    fs.writeFileSync(path.join(st, "TALK_STOP"), "");
    const r = await tick.runTick({ env: envOf(data, st), paperDesk: true, now: NOW });
    assert.equal(r.status, "stopped");
    assert.deepEqual(fs.readdirSync(st), ["TALK_STOP"]);
  });
  await test("stale data (the book's last mark older than 3 cycles) posts nothing", async () => {
    const data = makeData({ markAgo: 16 * MIN });
    const st = dir("state");
    const r = await tick.runTick({ env: envOf(data, st), paperDesk: true, now: NOW });
    assert.equal(r.status, "stale");
    assert.equal(readJ(path.join(st, "x-posts.jsonl")).length + readJ(path.join(st, "x-drafts.jsonl")).length, 0);
  });
  await test("an unreadable tick state posts nothing", async () => {
    const data = makeData();
    const st = dir("state");
    fs.writeFileSync(path.join(st, "tick-state.json"), "{not json");
    assert.equal((await tick.runTick({ env: envOf(data, st), paperDesk: true, now: NOW })).status, "error");
    assert.equal(readJ(path.join(st, "x-posts.jsonl")).length, 0);
  });
  await test("the lock: held by a live process it is busy; a dead owner's lock is taken over; release frees it", () => {
    const f = path.join(dir("lock"), "a.lock");
    const r1 = lock.acquireLock(f)!;
    assert.ok(r1);
    assert.equal(lock.acquireLock(f), null);
    r1();
    const r2 = lock.acquireLock(f)!;
    assert.ok(r2);
    r2();
    fs.writeFileSync(f, JSON.stringify({ pid: 999999, at: Date.now(), token: "x" }));
    const r3 = lock.acquireLock(f, { alive: () => false });
    assert.ok(r3, "a dead owner's lock is taken over");
    r3!();
    fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now() - 11 * MIN, token: "x" }));
    assert.ok(lock.acquireLock(f), "an old lock is taken over");
  });
  await test("two ticks at once never double-post (the tick lock); a held rate lock refuses the post", async () => {
    const data = makeData();
    const st = dir("state");
    let calls = 0;
    const fetchFake = (async (url: string) => {
      if (url.endsWith("/2/users/me")) return ME("mrbands");
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ data: { id: String(1000 + calls) } }), { status: 201 });
    }) as typeof fetch;
    const env = envOf(data, st, { X_LIVE: "true", ...FAKE_CREDS, OPERATOR_HANDLE: "zach", X_HANDLE: "mrbands" });
    const [a, b] = await Promise.all([tick.runTick({ env, paperDesk: true, now: NOW, fetch: fetchFake }), tick.runTick({ env, paperDesk: true, now: NOW, fetch: fetchFake })]);
    assert.deepEqual([a.status, b.status].sort(), ["busy", "posted"]);
    assert.equal(calls, 1);
    const release = lock.acquireLock(path.join(st, x.RATE_LOCK_FILE))!;
    const r = await x.postTweet("strap check: green. paper book.", { type: "strap" }, { env, now: NOW, fetch: fetchFake });
    release();
    assert.equal(r.posted, false);
    assert.match((r as { reason: string }).reason, /another post holds x-rate\.lock/);
    assert.equal(calls, 1);
  });
  await test("with X_LIVE=true a tick posts through x.ts (a fake X): no reply field, the key and the rate recorded", async () => {
    const data = makeData();
    const st = dir("state");
    const bodies: { url: string; method: string; body: unknown }[] = [];
    let meCalls = 0;
    const fetchFake = (async (url: string, init: RequestInit) => {
      if (url.endsWith("/2/users/me")) return meCalls++, ME("mrbands");
      bodies.push({ url, method: String(init.method), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ data: { id: "1790000000000000001" } }), { status: 201 });
    }) as unknown as typeof fetch;
    const env = envOf(data, st, { X_LIVE: "true", ...FAKE_CREDS, OPERATOR_HANDLE: "zach", X_HANDLE: "mrbands" });
    const r = await tick.runTick({ env, paperDesk: true, now: NOW, fetch: fetchFake });
    assert.equal(r.status, "posted");
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].url, "https://api.x.com/2/tweets");
    assert.equal(bodies[0].method, "POST");
    assert.deepEqual(Object.keys(bodies[0].body as object), ["text"]);
    const posts = x.readPosts(st);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].key, "daily:2026-09-22", "past 14 UTC the daily goes first");
    assert.equal(x.readRate(st).posts.length, 1);
    assert.equal(meCalls, 1, "the token's account is checked before the first live post");
  });
  await test("with X_LIVE anything but the literal true nothing is fetched: the tick drafts", async () => {
    const data = makeData();
    const st = dir("state");
    let calls = 0;
    const fetchFake = (async () => {
      calls++;
      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    const r = await tick.runTick({ env: envOf(data, st, { ...FAKE_CREDS, OPERATOR_HANDLE: "zach", X_HANDLE: "mrbands", X_LIVE: "1" }), paperDesk: true, now: NOW, fetch: fetchFake });
    assert.equal(r.status, "drafted");
    assert.equal(calls, 0);
  });
  await test("no replies and no mentions anywhere in the loop", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), "src/talk/tick.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/replyToMention|screenMention|getEngagement|in_reply_to|mentions/.test(src));
    assert.ok(!/replyTo:\s*\{/.test(src));
  });

  // ------------------------------------------------------------ talk check
  console.log("talk check");
  await test("verifyCredentials: a GET to /2/users/me, not gated by X_LIVE, reports the handle and never a key", async () => {
    const seenReq: { url: string; method: string; auth: string }[] = [];
    const fetchFake = (async (url: string, init: RequestInit) => {
      seenReq.push({ url, method: String(init.method), auth: String((init.headers as Record<string, string>).authorization) });
      return new Response(JSON.stringify({ data: { id: "1", username: "MrBands", name: "Mr Bands" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await x.verifyCredentials({ env: { ...FAKE_CREDS, X_HANDLE: "@mrbands" }, fetch: fetchFake, now: NOW });
    assert.deepEqual(r, { ok: true, username: "mrbands", matchesXHandle: true });
    assert.equal(seenReq[0].url, "https://api.x.com/2/users/me");
    assert.equal(seenReq[0].method, "GET");
    assert.ok(!seenReq[0].auth.includes("cs-test-secret") && !seenReq[0].auth.includes("as-test-secret"), "secrets only sign, never travel");
    const other = await x.verifyCredentials({ env: { ...FAKE_CREDS, X_HANDLE: "someoneelse" }, fetch: fetchFake });
    assert.equal(other.ok && other.matchesXHandle, false);
    const missing = await x.verifyCredentials({ env: { X_API_KEY: "ck-test" }, fetch: fetchFake });
    assert.equal(missing.ok, false);
    assert.match((missing as { reason: string }).reason, /missing X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET/);
    const denied = await x.verifyCredentials({ env: FAKE_CREDS, fetch: (async () => new Response(JSON.stringify({ title: "Unauthorized" }), { status: 401 })) as typeof fetch });
    assert.deepEqual(denied, { ok: false, reason: "x api 401: Unauthorized" });
    for (const v of Object.values(FAKE_CREDS)) assert.ok(!JSON.stringify([r, other, missing, denied]).includes(v));
  });

  // ------------------------------------------------------------ the review fixes
  console.log("review fixes");
  const LIVE = (extra: Record<string, string> = {}) => ({ X_LIVE: "true", ...FAKE_CREDS, OPERATOR_HANDLE: "zach", X_HANDLE: "mrbands", ...extra });
  const vetEnv = { operatorHandle: null, houseSymbols: ["bands"], houseMints: [] };
  await test("1. a slur, hate, sexual or scam word in a label never reaches a post: the label reads a pool, and the vet refuses the word anywhere", () => {
    const bad = ["NIGGA/SOL", "N1GGA/SOL", "niiiigga/sol", "FAGGOT/SOL", "HITLER/SOL", "KILL/SOL", "PORN/SOL", "SCAM/SOL", "RUG/SOL", "SOL/RUGPULL", "kkk/sol", "SEXY/SOL", "$RETARD/SOL", "fuckcoin/sol"];
    for (const l of bad) assert.equal(tick.sanitizeLabel(l), "a pool", l);
    for (const [raw, want] of [["NVDAx/SOL", "nvdax/sol"], ["allinu/SOL", "allinu/sol"], ["HUHCAT/SOL", "huhcat/sol"], ["zcat/sol", "zcat/sol"], ["STONK/SOL", "stonk/sol"], ["BONK/SOL", "bonk/sol"], ["WIF/SOL", "wif/sol"], ["JUP/USDC", "jup/usdc"], ["SPYx/SOL", "spyx/sol"]]) assert.equal(tick.sanitizeLabel(raw), want, raw);
    for (const l of bad) {
      const e = { kind: "open" as const, key: "open:x", at: NOW, pool: "P", label: tick.sanitizeLabel(l), side: "BOTH" as const, binsBelow: 3, binsAbove: 3, seatSol: 1 };
      const text = tick.openText(e, "paper");
      assert.match(text, /^opened a straddle on a pool, 3 bins each side of price/);
      assert.deepEqual(tick.vetOutgoing(text, { paper: true, env: vetEnv }), [], text);
    }
    for (const w of ["nigga", "faggot", "hitler", "porn", "scam", "rug", "kill"]) {
      const v = tick.vetOutgoing(`opened a straddle on ${w}/sol. paper book.`, { paper: true, env: vetEnv });
      assert.ok(v.some((x) => x.rule === "loop-words"), w);
    }
    assert.deepEqual(tick.vetOutgoing("price went through the band and out the other side. skill, not luck. paper book.", { paper: true, env: vetEnv }), [], "whole words only in a post");
  });
  await test("2. a close says the band's whole life: claims made while it was open count, and it matches its lesson", async () => {
    const f = factsAt(NOW);
    const a2 = f.events.find((e) => e.key === "close:paper-A-2")!;
    assert.ok(Math.abs(a2.netSol! - 12.199985) < 1e-9, `claims while open count: ${a2.netSol}`);
    assert.ok(Math.abs(a2.feesSol! - 12.3) < 1e-9);
    assert.equal(a2.closeLegOnly, false);
    const { bandLifeOf } = await import("../talk/bandlife.js");
    const rows = [row(NOW - 3 * HOUR, "open", { position: "p1", solDelta: -1 }), row(NOW - 2 * HOUR, "collect", { position: "p1", solDelta: 0.4279, feeSol: 0.4279 }), row(NOW - HOUR, "close", { position: "p1", solDelta: 1.1284 - 0.4279, feeSol: 0 })];
    const withLesson = bandLifeOf({ position: "p1", pool: "POOLA", openedAt: null, closedAt: NOW - HOUR, rows, lessons: [{ position: "p1", netSol: 0.0286, feesSol: 0.4279 }], closeLeg: { netSol: 0.1284, feesSol: 0 } });
    assert.deepEqual(withLesson, { netSol: 0.0286, feesSol: 0.4279, closeLegOnly: false, from: "lesson" }, "the lesson row wins: the two posts never disagree");
    const fromLedger = bandLifeOf({ position: "p1", pool: "POOLA", openedAt: null, closedAt: NOW - HOUR, rows, lessons: [], closeLeg: { netSol: 0.1284, feesSol: 0 } });
    assert.equal(fromLedger.from, "ledger");
    assert.ok(fromLedger.feesSol > 0.4278, "the claim before the close is in the fees");
    const bare = bandLifeOf({ position: "p2", pool: "POOLA", openedAt: null, closedAt: NOW, rows, lessons: [], closeLeg: { netSol: 0.1284, feesSol: 0.03 } });
    assert.equal(bare.closeLegOnly, true);
    const text = tick.closeText({ kind: "close", key: "close:p2", at: NOW, pool: "P", label: "nvdax/sol", netSol: 0.1284, feesSol: 0.03, closeLegOnly: true }, "paper");
    assert.match(text, /the close leg alone: \+0\.1284 sol\. fees 0\.0300 sol in that leg\./);
    assert.ok(!/\bnet\b/.test(text), "a close-leg figure is never called the net");
    assert.deepEqual(tick.vetOutgoing(text, { paper: true, env: vetEnv }), []);
  });
  await test("3. TALK_STOP stops every path: postTweet and announce send nothing even with X_LIVE=true", async () => {
    const st = dir("state");
    fs.writeFileSync(path.join(st, "TALK_STOP"), "");
    let calls = 0;
    const fetchFake = (async (url: string) => (calls++, url.endsWith("/2/users/me") ? ME("mrbands") : new Response(JSON.stringify({ data: { id: "1" } }), { status: 201 }))) as unknown as typeof fetch;
    const env = { TALK_STATE_PATH: st, ...LIVE() };
    const r = await x.postTweet("strap check: green. paper book.", { type: "strap", key: "k1" }, { env, now: NOW, fetch: fetchFake });
    assert.equal(r.posted, false);
    assert.match((r as { reason: string }).reason, /^stopped: TALK_STOP/);
    const an = await import("../talk/announce.js");
    const a = await an.announce("intro", { data: { source: "paper", book: null }, env, fetch: fetchFake, now: NOW });
    assert.equal(a.status, "refused");
    assert.match((a as { reason: string }).reason, /^stopped: TALK_STOP/);
    assert.equal(calls, 0, "not even the identity check");
    const d = readJ(path.join(st, "x-drafts.jsonl"));
    assert.equal(d[0].retry, true, "a stopped post is not used up: it can go after the stop is lifted");
  });
  await test("4. a busy day is spread out: 90 min apart, 2 per 6h, 2 before 12 UTC, the daily goes, the lesson waits for 18 UTC", () => {
    const base = factsAt(NOW);
    const day0 = Date.parse("2026-09-22T00:00:00Z");
    const events: import("../talk/tick").BandEvent[] = [];
    for (let m = 5; m < 24 * 60; m += 30) events.push({ kind: "close", key: `close:busy-${m}`, at: day0 + m * MIN, pool: `P${m}`, label: "nvdax/sol", netSol: 0.01, feesSol: 0.02, holdSec: 3600, outsideAtClose: false, relaidKey: null });
    const lesson = { at: day0 + 60 * MIN, mode: "paper", pool: "P", label: "GMEx/SOL", position: "busy-L", kind: "stock", openedAt: day0, closedAt: day0 + 60 * MIN, minutes: 60, seatSol: 10, bins: 5, binStep: 20, coverPct: 1, travelBins60m: null, inRangePct: 100, endReason: "idle", feesSol: 0.2, netSol: 0.15, predictedYieldPct: null, realizedYieldPctPerDay: 1, headline: "x" };
    let st: import("../talk/tick").TickState = { ...tick.emptyTickState(), lastStrap: base.strap.state, milestoneN: 0 };
    const seen = new Set<string>();
    const times: number[] = [];
    const picks: { at: number; kind: string }[] = [];
    for (let t = day0; t < day0 + 24 * HOUR; t += 15 * MIN) {
      const f = { ...base, now: t, events, lessons: [lesson as never], milestone: { n: 1, step: 10, firstAt: day0 - DAYMS, netSol: 1 } };
      const postsToday = times.filter((at) => new Date(at).toISOString().slice(0, 10) === "2026-09-22").length;
      const p = tick.planTick(f, st, { seen, postsToday, times: [...times] }, { postsPerDay: 6, dailyHourUtc: 14 });
      st = p.nextState;
      if (p.pick) {
        seen.add(p.pick.key);
        times.push(t);
        picks.push({ at: t, kind: p.pick.kind });
      }
    }
    const hrs = picks.map((p) => `${new Date(p.at).toISOString().slice(11, 16)} ${p.kind}`).join(", ");
    assert.equal(picks.length, 6, hrs);
    for (let i = 1; i < picks.length; i++) assert.ok(picks[i].at - picks[i - 1].at >= 90 * MIN, `gap: ${hrs}`);
    // the daily numbers pass the rolling window (the fixed card at the fixed clock); everything else keeps to 2 per 6h
    for (const p of picks.filter((q) => q.kind !== "daily")) assert.ok(picks.filter((q) => q.kind !== "daily" && q.at <= p.at && p.at - q.at < 6 * HOUR).length <= 2, `2 per 6h: ${hrs}`);
    assert.ok(picks.filter((p) => new Date(p.at).getUTCHours() < 12).length <= 2, `night: ${hrs}`);
    assert.ok(picks.some((p) => p.kind === "daily"), `the daily goes: ${hrs}`);
    assert.ok(picks.filter((p) => new Date(p.at).getUTCHours() >= 12).length >= 4, `most in the US day: ${hrs}`);
    assert.ok(!picks.some((p) => p.kind === "milestone" && new Date(p.at).getUTCHours() < 12), `milestone in the US day: ${hrs}`);
    assert.ok(!picks.some((p) => p.kind === "lesson" && new Date(p.at).getUTCHours() < 18), `lesson from 18 UTC: ${hrs}`);
  });
  await test("4b. with the default spacing a second tick 10 minutes after a post waits (status spaced)", async () => {
    const data = makeData();
    const st = dir("state");
    const env = { ...envOf(data, st), TALK_MIN_GAP_MIN: "90", TALK_WINDOW_POSTS: "2" };
    assert.equal((await tick.runTick({ env, paperDesk: true, now: NOW })).status, "drafted");
    const r = await tick.runTick({ env, paperDesk: true, now: NOW + 10 * MIN });
    assert.equal(r.status, "spaced");
    assert.match(r.detail, /TALK_MIN_GAP_MIN is 90/);
  });
  await test("5. the loop checks whose account the token is for: another account is refused, nothing posted, nothing used; confirmed once per token", async () => {
    const data = makeData();
    const st = dir("state");
    let who = "zach";
    let me = 0;
    let posts = 0;
    const fetchFake = (async (url: string) => {
      if (url.endsWith("/2/users/me")) return me++, ME(who);
      posts++;
      return new Response(JSON.stringify({ data: { id: String(1790000000000000000 + posts) } }), { status: 201 });
    }) as unknown as typeof fetch;
    const env = envOf(data, st, LIVE());
    const r = await tick.runTick({ env, paperDesk: true, now: NOW, fetch: fetchFake });
    assert.equal(r.status, "not-posted");
    assert.match(r.detail, /the access token is for @zach, not X_HANDLE @mrbands/);
    assert.equal(posts, 0);
    const d = readJ(path.join(st, "x-drafts.jsonl"));
    assert.equal(d.length, 1);
    assert.equal(d[0].key, undefined, "no key: the close is not used up");
    assert.equal(tick.loopLogOf(st, NOW).seen.size, 0);
    assert.equal(tick.readTickState(st).confirmedHandle, null);
    who = "MrBands";
    const ok = await tick.runTick({ env, paperDesk: true, now: NOW + MIN, fetch: fetchFake });
    assert.equal(ok.status, "posted");
    assert.equal(ok.pick!.key, r.pick!.key, "the same close goes once the token is right");
    const s = tick.readTickState(st);
    assert.equal(s.confirmedHandle, "mrbands");
    assert.ok(s.confirmedTokenHash && !JSON.stringify(s).includes(FAKE_CREDS.X_ACCESS_TOKEN), "a hash, never the token");
    await tick.runTick({ env, paperDesk: true, now: NOW + 2 * MIN, fetch: fetchFake });
    assert.equal(me, 2, "cached for the same token");
    who = "zach";
    const newToken = await tick.runTick({ env: { ...env, X_ACCESS_TOKEN: "at-other" }, paperDesk: true, now: NOW + 3 * MIN, fetch: fetchFake });
    assert.equal(me, 3, "a new token is checked again");
    assert.equal(newToken.status, "not-posted");
  });
  await test("6. a transient X failure (503) is retried: the key stays unused and the gates stay put; a 403 is not retried", async () => {
    const data = makeData();
    const st = dir("state");
    let status = 503;
    const fetchFake = (async (url: string) => (url.endsWith("/2/users/me") ? ME("mrbands") : new Response(JSON.stringify(status === 201 ? { data: { id: "1790000000000000009" } } : { title: "Service Unavailable" }), { status }))) as unknown as typeof fetch;
    const env = envOf(data, st, LIVE());
    seedState(st, { lastStrap: "green" });
    const before = tick.readTickState(st);
    const r = await tick.runTick({ env, paperDesk: true, now: NOW, fetch: fetchFake });
    assert.equal(r.status, "not-posted");
    assert.match(r.detail, /x api 503.*will retry/);
    assert.equal(readJ(path.join(st, "x-drafts.jsonl"))[0].retry, true);
    assert.ok(!tick.loopLogOf(st, NOW).seen.has(r.pick!.key));
    const after = tick.readTickState(st);
    assert.deepEqual({ ...after, lastTickAt: null, confirmedHandle: null, confirmedTokenHash: null, transientFails: 0 }, { ...before, lastTickAt: null, confirmedHandle: null, confirmedTokenHash: null, transientFails: 0 });
    assert.equal(after.transientFails, 1, "the backoff counter (src/talk/guards.ts) counts the 503");
    status = 201;
    const again = await tick.runTick({ env, paperDesk: true, now: NOW + MIN, fetch: fetchFake });
    assert.equal(again.status, "posted");
    assert.equal(again.pick!.key, r.pick!.key);
    status = 403;
    const denied = await tick.runTick({ env, paperDesk: true, now: NOW + 2 * MIN, fetch: fetchFake });
    assert.equal(denied.status, "not-posted");
    assert.ok(tick.loopLogOf(st, NOW + 2 * MIN).seen.has(denied.pick!.key), "a 403 is not transient: used");
    assert.equal(x.retryableReason("x api 429: Too Many Requests"), true);
    assert.equal(x.retryableReason("x api 402: Payment Required"), true);
    assert.equal(x.retryableReason("rate: another post holds x-rate.lock; not posting"), true);
    assert.equal(x.retryableReason("lint: price-call"), false);
    assert.equal(x.retryableReason("dormant: X_LIVE is not \"true\""), false);
  });
  await test("7. tick --force is a preview: nothing written, recorded or fetched, even with X_LIVE=true", async () => {
    const data = makeData();
    const st = dir("state");
    let calls = 0;
    const fetchFake = (async () => (calls++, ME("mrbands"))) as unknown as typeof fetch;
    for (const force of tick.FORCE_KINDS) {
      const r = await tick.runTick({ env: envOf(data, st, LIVE()), paperDesk: true, now: Date.parse("2026-09-21T15:00:00Z") + 0 * MIN, fetch: fetchFake, force });
      assert.equal(r.status, "preview", `${force}: ${r.detail}`);
    }
    const d = await tick.runTick({ env: envOf(data, st), paperDesk: true, now: NOW, force: "daily" });
    assert.equal(d.pick?.kind, "daily");
    assert.match(d.detail, /preview only/);
    assert.equal(calls, 0);
    assert.deepEqual(fs.readdirSync(st), [], "no state, no draft, no record");
  });
  await test("8. the daily numbers carry no link unless TALK_DAILY_LINK=true (a post with a URL costs 13x on X pay-per-use)", async () => {
    const g = { ...factsAt(NOW), events: [], milestone: null, lessons: [] };
    const s = { ...tick.emptyTickState(), lastStrap: g.strap.state };
    const plain = tick.planTick(g, s, noLog, opts).pick!;
    assert.equal(plain.kind, "daily");
    assert.ok(!/mrbands\.finance|https?:/.test(plain.text), plain.text);
    const linked = tick.planTick(g, s, noLog, { ...opts, dailyLink: true }).pick!;
    assert.match(linked.text, /mrbands\.finance/);
    const data = makeData();
    const st = dir("state");
    seedState(st, { lastStrap: "green", milestoneN: 99, lastLessonDay: "2026-09-22" });
    const env = envOf(data, st);
    let r = await tick.runTick({ env, paperDesk: true, now: NOW });
    while (r.pick && r.pick.kind !== "daily") r = await tick.runTick({ env, paperDesk: true, now: NOW + MIN });
    assert.equal(r.pick?.kind, "daily");
    assert.ok(!/mrbands\.finance/.test(r.pick!.text));
  });

  // ------------------------------------------------------------ the launchd plist
  console.log("the plist");
  await test("ops/com.bands.mrbands.talk.plist: every 900 s, at load, no KeepAlive, the tick, data-live and data-talk, and no X_LIVE", () => {
    const p = fs.readFileSync(path.resolve(process.cwd(), "ops/com.bands.mrbands.talk.plist"), "utf8");
    const body = p.replace(/<!--[\s\S]*?-->/g, "");
    assert.match(body, /<key>StartInterval<\/key>\s*<integer>900<\/integer>/);
    assert.match(body, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.ok(!/KeepAlive/.test(body));
    assert.match(body, /<string>src\/scripts\/talk\.ts<\/string>\s*<string>tick<\/string>/);
    assert.match(body, /<key>DATA_DIR<\/key>\s*<string>data-live<\/string>/);
    assert.match(body, /<key>TALK_STATE_PATH<\/key>\s*<string>data-talk<\/string>/);
    assert.ok(!/X_LIVE/.test(body), "X_LIVE stays off until Zach sets it");
    assert.ok(!/X_API|X_ACCESS/.test(body), "no keys in the plist");
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
