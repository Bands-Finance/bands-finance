/**
 * The posting loop's tests (src/talk/tick.ts, src/talk/lock.ts, the loop's additions to src/talk/x.ts).
 * No network: X is a fake fetch; every file lives in a temp dir.   npx tsx src/scripts/test-tick.ts
 * Covers: label sanitizing ("$SCAM @someone" never tags or cashtags), the loop's vet (symbols, the link allowlist,
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
/** a Tuesday, after the default daily hour (14 UTC) */
const NOW = Date.parse("2026-09-22T15:00:00.000Z");
const FAKE_CREDS = { X_API_KEY: "ck-test", X_API_SECRET: "cs-test-secret", X_ACCESS_TOKEN: "at-test", X_ACCESS_SECRET: "as-test-secret" };

async function main(): Promise<void> {
  const tick = await import("../talk/tick.js");
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
      closed({ address: "paper-B-1", pool: "POOLB", label: f.scamLabel ?? "$SCAM @someone/SOL", openedAt: now - 5 * HOUR, closedAt: now - 20 * MIN, realized: -0.5, fee: 0.1, inRange: false }),
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
    const lesson = { at: now - 20 * MIN, mode: "paper", pool: "POOLB", label: f.scamLabel ?? "$SCAM @someone/SOL", position: "paper-B-1", kind: "memecoin", openedAt: now - 5 * HOUR, closedAt: now - 20 * MIN, minutes: 280, seatSol: 10, bins: 5, binStep: 20, coverPct: 1, travelBins60m: null, inRangePct: 62, endReason: "through-band", feesSol: 0.1, netSol: -0.5, tokensLeftSol: 0, predictedYieldPct: null, realizedYieldPctPerDay: 1, headline: "x" };
    fs.writeFileSync(path.join(d, "lessons.jsonl"), JSON.stringify(lesson) + "\n");
    return d;
  };
  const envOf = (dataDir: string, statePath: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ DATA_DIR: dataDir, TALK_STATE_PATH: statePath, CYCLE_INTERVAL_SEC: "300", ...extra });
  const seedState = (statePath: string, s: Partial<import("../talk/tick").TickState>) => tick.writeTickState(statePath, { ...tick.emptyTickState(), ...s });
  const readJ = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

  // ------------------------------------------------------------ labels and the vet
  console.log("labels and the vet");
  await test("sanitizeLabel: no @, # or $, only plain symbols, lowercase", () => {
    assert.equal(tick.sanitizeLabel("$SCAM @someone/SOL"), "scam/sol");
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
  await test("priority: close, close, strap change, milestone, daily numbers, lesson; then the cap of 6 holds; every draft passes the lint and says paper", async () => {
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
    assert.deepEqual(seen.map((s) => s.split(":")[0]), ["close", "close", "strap", "milestone", "daily", "lesson"]);
    assert.equal(seen[0], "close:close:paper-A-2", "the older close first");
    assert.equal(seen[1], "close:close:paper-B-1");
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
    assert.match(loss, /closed my band on scam\/sol after 4\.7h\.\nnet -0\.5000 sol, a loss\. fees 0\.1000 sol counted in it\./);
    assert.match(loss, /price was outside the band when it closed\./);
    const recentre = posts.find((p) => p.key === "close:paper-A-2")!.text as string;
    assert.match(recentre, /net \+0\.2000 sol\. fees 0\.3000 sol counted in it\.\nlaid a fresh band in the same pool\./);
    const daily = posts.find((p) => p.type === "daily")!.text as string;
    assert.match(daily, /^daily numbers, last 24h, paper book:/);
    assert.match(daily, /moves: 3 opened, 2 closed, 1 up and 1 down, worst -0\.5000 sol/);
    const lessonPost = posts.find((p) => p.type === "lesson")!.text as string;
    assert.match(lessonPost, /scam\/sol, 4\.7h in the seat, in range 62% of checks/);
    assert.match(lessonPost, /fees came in and the seat still lost\. fees are not profit\./);
    const ms = posts.find((p) => p.type === "milestone")!.text as string;
    assert.match(ms, /realized fees on the paper book passed 10 sol since 22 sep\./);
    // a 7th candidate would be over the cap of 6: force one
    const r8 = await tick.runTick({ env, paperDesk: true, now: NOW + 7 * MIN, force: "daily" });
    assert.equal(r8.status, "capped");
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
  const opts = { postsPerDay: 6, dailyHourUtc: 14 };
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
    const fetchFake = (async () => {
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
    const fetchFake = (async (url: string, init: RequestInit) => {
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
    assert.equal(posts[0].key, "close:paper-A-2");
    assert.equal(x.readRate(st).posts.length, 1);
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
