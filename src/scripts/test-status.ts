/**
 * His state, readable, and a hung paper loop that restarts itself. No RPC, no model, no Vercel: the
 * routes run through Hono's app.request(), the watchdog's decision is a pure function fed simulated
 * clocks, the deploy gets a fake exec, and the timeouts are aimed at local fakes that never answer.
 *   npm run test:status
 *
 *   GET /api/status        every field from a fake saved state, and never a secret; every halt source;
 *                          the marks counter and the desk's approvals, from where they are kept; the
 *                          `learning` block, and GET /api/learning beside it
 *   what he learned        the four public surfaces (src/scripts/test-learn-surface.ts), run here so
 *                          they ride in `npm run test:all` on a DATA_DIR that is already pinned
 *   watchdogStep           a paper desk exits after two AWAKE windows, never after a host sleep or a
 *                          DarkWake burst, and never on a live wallet
 *   createDeployer         one push at a time, each step timed out, the two steps independent
 *   timedFetch / the RPC   a hung fake is aborted
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

// Everything that reads src/config.ts is imported after the environment is pinned.
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mrbands-status-"));
const SECRET = "oh-secret-token-4f1c9a";
process.env.DATA_DIR = TEST_DIR;
process.env.DRY_RUN = "true";
process.env.WALLET_SECRET_KEY = "";
process.env.PAPER_SOL = "";
process.env.DECIDER = "openhermit";
process.env.OPENHERMIT_TOKEN = SECRET;
process.env.KILL_SWITCH = "true";
process.env.ANTHROPIC_API_KEY = "";
process.env.PLATFORM_OPERATOR_TOKEN = "op-status-test";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n     ${(err as Error).stack ?? (err as Error).message}`);
    process.exitCode = 1;
  }
}

const MIN = 60_000;
const T0 = Date.parse("2026-09-21T12:00:00.000Z");

function entry(ts: number, source: string, filler = 0): string {
  return JSON.stringify({ id: `e${ts}`, ts: new Date(ts).toISOString(), cycle: 1, llm: { source, model: "m" }, pad: "x".repeat(filler) });
}

async function main(): Promise<void> {
  // AbortSignal.timeout's timer does not hold the process open: without this a hung fake would let
  // the event loop drain and the run end silently, with exit code 0 and half the tests unrun
  setInterval(() => {}, 1000);
  const { buildApp, statusReport } = await import("../server.js");
  const status = await import("../status.js");
  const { watchdogStep, staleWindowMs, SLEEP_GAP_MS, WATCH_MS } = await import("../engine/watchdog.js");
  const { createDeployer, DEPLOY_TIMEOUT_MS } = await import("../publish/deploy.js");
  const { timedFetch, rpcConnection } = await import("../lib/timedFetch.js");

  // ---- GET /api/status -------------------------------------------------------------------------
  console.log("/api/status");
  const now = Date.now();
  fs.writeFileSync(
    path.join(TEST_DIR, "engine-state.json"),
    JSON.stringify({
      circuit: { haltUntil: now + 4 * 3_600_000, stage: 1, reason: "daily loss 0.2 SOL over 0.15" },
      portfolio: { standDownUntil: now - 3_600_000, standDownReason: "three marks under the floor" },
    }),
  );
  const lines = [
    entry(now - 3 * 3_600_000, "llm"), // outside the hour
    entry(now - 2 * 3_600_000, "policy"),
    entry(now - 50 * MIN, "llm"),
    entry(now - 40 * MIN, "policy"),
    entry(now - 30 * MIN, "llm"),
    entry(now - 20 * MIN, "llm"),
    entry(now - 10 * MIN, "engine"),
  ];
  fs.writeFileSync(path.join(TEST_DIR, "decisions.jsonl"), lines.join("\n") + "\n");
  status.resetStatus();
  status.noteIteration(now - 2 * MIN);
  status.noteScreen(true, now - 5 * MIN);
  status.noteScreen(false, now - 1 * MIN);
  status.noteDeploy(true, now - 3 * MIN);
  const app = buildApp();

  await test("status: every field, from the saved state and the registry", async () => {
    const res = await app.request("/api/status");
    assert.equal(res.status, 200);
    const j = (await res.json()) as Record<string, any>;
    for (const k of ["now", "mode", "killSwitch", "killSwitchSources", "killSwitchSource", "circuit", "portfolio", "decider", "openhermitTokenPresent", "lastIterationAt", "decisionsLastHour", "modelCallsToday", "iterations", "screen", "deploy", "marks", "autoApprove", "hostSleep"]) {
      assert.ok(k in j, `missing ${k}`);
    }
    assert.equal(j.mode, "dry-run");
    assert.equal(j.killSwitch, true);
    assert.deepEqual(j.killSwitchSources, ["env"]);
    assert.equal(j.killSwitchSource, "KILL_SWITCH=true in the environment");
    assert.equal(j.circuit.halted, true);
    assert.ok(j.circuit.haltUntil > now);
    assert.equal(j.portfolio.standingDown, false, "a stand-down in the past is over");
    assert.equal(j.portfolio.reason, "three marks under the floor");
    assert.equal(j.decider, "openhermit");
    assert.equal(j.openhermitTokenPresent, true);
    assert.equal(j.lastIterationAt, now - 2 * MIN);
    assert.equal(j.decisionsLastHour.total, 5);
    assert.deepEqual(j.decisionsLastHour.bySource, { llm: 3, policy: 1, engine: 1 });
    assert.equal(j.decisionsLastHour.llmShare, 3 / 5);
    assert.equal(j.decisionsLastHour.policyShare, 1 / 5);
    assert.equal(j.decisionsLastHour.screenShare, 0, "no screened holds in this hour");
    assert.equal(j.modelCallsToday.used, 0, "no model call spent yet today");
    assert.equal(j.modelCallsToday.cap, 200);
    assert.equal(j.modelCallsToday.day, new Date(now).toISOString().slice(0, 10));
    assert.deepEqual(j.screen, { lastAt: now - MIN, ok: false, lastOkAt: now - 5 * MIN });
    assert.deepEqual(j.deploy, { lastAt: now - 3 * MIN, ok: true });
    assert.equal(j.marks, null, "nothing in this process has noted the marks yet");
    assert.equal(j.autoApprove, null);
  });

  await test("status: the learning block sits beside the decider mix, and changes nothing", async () => {
    const j = (await (await app.request("/api/status")).json()) as Record<string, any>;
    assert.ok("learning" in j, "the status names what he has learned");
    for (const k of ["mode", "generatedAt", "frozen", "modelOn", "factors", "changes", "lessons", "refused", "neverTouched"]) {
      assert.ok(k in j.learning, `the learning block is missing ${k}`);
    }
    assert.equal(j.learning.mode, "dry-run", "it is labelled with the book it was learned on");
    assert.deepEqual(j.learning.frozen, { all: false, calibration: false, pools: false });
    assert.deepEqual(j.learning.changes, [], "nothing has been journalled on this fixture");
    assert.ok(j.learning.neverTouched.includes("MAX_POSITION_SOL"), "it names what learning may never touch");
    // a factor is never served without the sample behind it
    for (const f of j.learning.factors as Record<string, any>[]) {
      assert.equal(typeof f.n, "number");
      assert.equal(typeof f.minSample, "number");
      assert.equal(f.underSample, f.n < f.minSample);
      assert.ok(f.factor <= f.defaultFactor, "a knob may never be served above what ships in code");
    }
    const own = await app.request("/api/learning");
    assert.equal(own.status, 200);
    assert.deepEqual(Object.keys((await own.json()) as Record<string, unknown>).sort(), Object.keys(j.learning).sort(), "the route and the block are the same shape");
  });

  await test("status: the OpenHermit token is a boolean, never the value", async () => {
    const res = await app.request("/api/status");
    const text = await res.text();
    assert.ok(!text.includes(SECRET), "the token must not appear in /api/status");
    assert.ok(!text.includes("op-status-test"), "nor the operator token");
    const health = await (await app.request("/api/health")).text();
    assert.ok(!health.includes(SECRET));
  });

  await test("status: the marks and auto-approval setters show once called", () => {
    status.noteMarks({ skipped: 2, lastCompleteAt: now - MIN, stale: false });
    status.noteAutoApprove({ today: 1, total: 4 });
    const r = statusReport(now);
    assert.deepEqual(r.marks, { skipped: 2, lastCompleteAt: now - MIN, stale: false });
    assert.deepEqual(r.autoApprove, { today: 1, total: 4 });
    // a held pool set aside for staying blind is named, and only when there is one
    status.noteMarks({ skipped: 0, lastCompleteAt: now, stale: false, setAside: ["pair-Xsoq"] });
    assert.deepEqual(statusReport(now).marks, { skipped: 0, lastCompleteAt: now, stale: false, setAside: ["pair-Xsoq"] });
  });

  await test("status: a desk STOP in DATA_DIR is a halt too, named beside the environment's", () => {
    const stop = path.join(TEST_DIR, "STOP");
    fs.writeFileSync(stop, "");
    try {
      const r = statusReport(now);
      assert.equal(r.killSwitch, true);
      assert.deepEqual(r.killSwitchSources, ["desk", "env"]);
      assert.match(String(r.killSwitchSource), /STOP \(halts this desk only\) \+ KILL_SWITCH=true/);
    } finally {
      fs.rmSync(stop, { force: true });
    }
    assert.deepEqual(statusReport(now).killSwitchSources, ["env"]);
  });

  await test("status: the marks counter and the desk's approvals reach it from where they are kept", async () => {
    const { Keypair } = await import("@solana/web3.js");
    const marks = await import("../engine/marks.js");
    const proposals = await import("../platform/proposals.js");
    const auto = await import("../platform/autoDecide.js");
    marks.resetMarksHealth();
    // src/engine/marks.ts noteMarks, as the loop calls it once a cycle
    marks.noteMarks(true, now - 3 * MIN, 1);
    marks.noteMarks(false, now - 2 * MIN, 2);
    assert.deepEqual(statusReport(now).marks, { skipped: 1, lastCompleteAt: now - 3 * MIN, stale: false });
    marks.noteMarks(false, now - MIN, 3);
    marks.noteMarks(false, now, 4);
    assert.deepEqual(statusReport(now).marks, { skipped: 3, lastCompleteAt: now - 3 * MIN, stale: true });
    marks.resetMarksHealth();
    // an operator approval is not the desk's; a desk approval is, today and in the total
    const pool = Keypair.generate().publicKey.toBase58();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = proposals.submitProposal({ kind: "OPEN_BAND", pool, side: "SOL_ONLY", amountSol: 0.1, amountToken: 0, binsBelowActive: 19, binsAboveActive: 0, strategy: "Spot", rationale: "fees are running well ahead of the drift on this pool", proposerId: Keypair.generate().publicKey.toBase58() });
      if (!r.ok) throw new Error(r.error);
      ids.push(r.proposal.id);
    }
    proposals.decideProposal(ids[0], "approve", undefined, "operator", now);
    assert.deepEqual(auto.noteDeskApprovals(now), { today: 0, total: 0 });
    assert.deepEqual(statusReport(now).autoApprove, { today: 0, total: 0 }, "noted at boot, before any approval");
    proposals.decideProposal(ids[1], "approve", undefined, "desk-auto:small-open", now);
    auto.noteDeskApprovals(now);
    assert.deepEqual(statusReport(now).autoApprove, { today: 1, total: 1 });
  });

  await test("health: unchanged, plus the last completed iteration", async () => {
    const j = (await (await app.request("/api/health")).json()) as Record<string, unknown>;
    assert.equal(j.ok, true);
    assert.equal(j.mode, "dry-run");
    assert.equal(j.lastIterationAt, now - 2 * MIN);
  });

  await test("status: a server started alone reads the last iteration from the engine lock", () => {
    status.resetStatus();
    fs.writeFileSync(path.join(TEST_DIR, "engine.lock"), JSON.stringify({ pid: 1, wallet: "w", startedAt: now - 60 * MIN, heartbeat: now - 7 * MIN, lastIterationAt: now - 7 * MIN }));
    assert.equal(statusReport(now).lastIterationAt, now - 7 * MIN);
    fs.rmSync(path.join(TEST_DIR, "engine.lock"));
  });

  await test("decisions: read backwards from the end, stopping at the hour", () => {
    // 3 MB of old entries, then the hour: a small chunk makes the walk cross many chunk and line boundaries
    const file = path.join(TEST_DIR, "big.jsonl");
    const old: string[] = [];
    for (let i = 0; i < 500; i++) old.push(entry(T0 - 5 * 3_600_000 + i * 1000, "policy", 6000));
    const recent: string[] = [];
    for (let i = 0; i < 40; i++) recent.push(entry(T0 - 59 * MIN + i * MIN, i % 4 === 0 ? "policy" : "llm", 5000));
    fs.writeFileSync(file, [...old, ...recent].join("\n") + "\n");
    const r = status.decisionSources(file, T0 - 3_600_000, { chunkBytes: 4096 });
    assert.equal(r.total, 40);
    assert.equal(r.bySource.policy, 10);
    assert.equal(r.bySource.llm, 30);
    assert.equal(r.truncated, false);
    // the byte cap bounds the walk whatever the window asks for
    const capped = status.decisionSources(file, 0, { chunkBytes: 64 * 1024, maxBytes: 256 * 1024 });
    assert.equal(capped.truncated, true);
    assert.ok(capped.total < 540);
    // a missing file is no decisions, not an error
    const none = status.decisionSources(path.join(TEST_DIR, "nope.jsonl"), 0);
    assert.equal(none.total, 0);
    assert.equal(none.llmShare, null);
  });

  // ---- the watchdog ----------------------------------------------------------------------------
  console.log("watchdog");
  const windowMs = staleWindowMs(300); // 15 min
  type Clock = Parameters<typeof watchdogStep>[0];
  /** run ticks at the given wall times with a fixed beat; return every verdict and every sleep report */
  function run(times: number[], beatAt: number, live: boolean) {
    let clock: Clock = null;
    const verdicts: string[] = [];
    const slept: { ms: number; wakes: number }[] = [];
    for (const t of times) {
      const s = watchdogStep(clock, { now: t, beatAt, windowMs, live });
      clock = s.clock;
      verdicts.push(s.verdict.kind);
      if (s.slept) slept.push(s.slept);
    }
    return { verdicts, slept, clock: clock! };
  }
  const every = (from: number, to: number, step = WATCH_MS) => {
    const out: number[] = [];
    for (let t = from; t <= to; t += step) out.push(t);
    return out;
  };

  await test("watchdog: a genuine hang on paper exits after two windows of awake time, not before", () => {
    const beat = T0;
    const { verdicts } = run(every(T0 + MIN, T0 + 40 * MIN), beat, false);
    const firstExit = verdicts.indexOf("exit");
    assert.ok(firstExit > 0, "it exits");
    // the tick at T0+31min is the first with 30 min of awake time counted since the first tick at T0+1min
    assert.equal(firstExit, 30);
    assert.ok(verdicts.slice(0, 15).every((v) => v === "ok"), "quiet through the first window");
    assert.ok(verdicts.slice(15, 30).every((v) => v === "stale"), "logged through the second");
  });

  await test("watchdog: a 313 minute sleep (2026-09-17) is not a hang", () => {
    // awake 5 min after the last beat, asleep 313 min, then the loop comes back 3 min after the wake
    const before = every(T0 + MIN, T0 + 5 * MIN);
    const wake = T0 + 5 * MIN + 313 * MIN;
    const after = every(wake, wake + 3 * MIN);
    const { verdicts, slept } = run([...before, ...after], T0, false);
    assert.ok(!verdicts.includes("exit"), `no exit: ${verdicts.join(",")}`);
    assert.ok(!verdicts.includes("stale"), "not even stale: 8 awake minutes");
    assert.equal(slept.length, 1, "the sleep is reported once");
    assert.equal(Math.round(slept[0].ms / MIN), 313);
  });

  await test("watchdog: a clamshell night of DarkWakes every 15 min (2026-09-20) is not a hang", () => {
    // the lid shuts at 22:27, a DarkWake every ~15 min wakes the timer for one tick, the lid opens at 07:55
    const shut = T0 + 2 * MIN;
    const times = every(T0 + MIN, shut);
    for (let t = shut + 15 * MIN; t < shut + 568 * MIN; t += 15 * MIN + 7000) times.push(t);
    const open = shut + 568 * MIN;
    times.push(...every(open, open + 4 * MIN));
    const { verdicts, slept } = run(times, T0, false);
    assert.ok(!verdicts.includes("exit"), "no restart on any DarkWake");
    assert.ok(!verdicts.includes("stale"));
    assert.equal(slept.length, 1, "the whole night is one line");
    assert.ok(slept[0].wakes > 30, `${slept[0].wakes} wakes`);
    assert.ok(Math.round(slept[0].ms / MIN) >= 560);
  });

  await test("watchdog: a burst of DarkWakes a few minutes long each never adds up to a restart", () => {
    // a maintenance wake long enough for a few ticks: 3 awake minutes, then back to sleep, 20 times
    const times = [T0 + MIN];
    let t = T0 + MIN;
    for (let i = 0; i < 20; i++) {
      t += 15 * MIN;
      times.push(t, t + MIN, t + 2 * MIN);
      t += 2 * MIN;
    }
    const { verdicts, clock } = run(times, T0, false);
    assert.ok(!verdicts.includes("exit"), `${Math.round(clock.awakeMs / MIN)} awake min`);
    assert.ok(!verdicts.includes("stale"));
    assert.equal(Math.round(clock.awakeMs / MIN), 2, "each wake starts the count again: 40 awake minutes in all, 2 counted");
  });

  await test("watchdog: a hang that starts after a sleep still exits on awake time", () => {
    const wake = T0 + 200 * MIN;
    const { verdicts } = run([...every(T0 + MIN, T0 + 3 * MIN), ...every(wake, wake + 30 * MIN)], T0, false);
    assert.equal(verdicts[verdicts.length - 1], "exit", "3 + 30 awake minutes is past two windows");
    assert.ok(!verdicts.slice(0, -2).includes("exit"));
  });

  await test("watchdog: a new beat starts the count again", () => {
    let clock: Clock = null;
    for (const t of every(T0 + MIN, T0 + 25 * MIN)) clock = watchdogStep(clock, { now: t, beatAt: T0, windowMs, live: false }).clock;
    const s = watchdogStep(clock, { now: T0 + 26 * MIN, beatAt: T0 + 25.5 * MIN, windowMs, live: false });
    assert.equal(s.verdict.kind, "ok");
    assert.equal(s.clock.awakeMs, 0.5 * MIN);
  });

  await test("watchdog: never judges a live wallet (its own wall-clock rule stays as it was)", () => {
    const hang = run(every(T0 + MIN, T0 + 120 * MIN), T0, true);
    assert.ok(hang.verdicts.every((v) => v === "live"), "a live hang is left to the original rule");
    const wake = T0 + 400 * MIN;
    const sleep = run([T0 + MIN, ...every(wake, wake + 5 * MIN)], T0, true);
    assert.ok(sleep.verdicts.every((v) => v === "live"));
    assert.ok(SLEEP_GAP_MS > WATCH_MS);
  });

  // ---- the deploy ------------------------------------------------------------------------------
  console.log("deploy");
  type Call = { command: string; timeout: number; done: (err: Error | null) => void };
  function fakeExec() {
    const calls: Call[] = [];
    const exec = (command: string, options: { cwd: string; timeout: number }, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      calls.push({ command, timeout: options.timeout, done: (err) => cb(err, "ok", err ? "boom" : "") });
    };
    return { calls, exec };
  }
  const settle = () => new Promise((r) => setImmediate(r));

  await test("deploy: single-flight: a hung push is never joined by a second", async () => {
    const f = fakeExec();
    let t = T0;
    const logs: string[] = [];
    const d = createDeployer({ exec: f.exec, cwd: "/x", minMinutes: 30, now: () => t, log: (s) => logs.push(s), error: (s) => logs.push(s) });
    assert.equal(d.deploy(true), "started");
    assert.equal(f.calls.length, 1);
    t += 31 * MIN; // past the throttle: the old code spawned a second vercel here
    assert.equal(d.deploy(true), "busy");
    t += 60 * MIN;
    assert.equal(d.deploy(true), "busy");
    assert.equal(f.calls.length, 1, "still one process");
    assert.ok(logs.some((l) => l.includes("still running")));
    // it finishes: the dashboard step runs, then the next push may start
    f.calls[0].done(null);
    await settle();
    assert.equal(f.calls.length, 2);
    f.calls[1].done(null);
    await settle();
    assert.equal(d.running(), false);
    assert.equal(d.deploy(true), "started");
  });

  await test("deploy: every step has the ten minute timeout", async () => {
    const f = fakeExec();
    const d = createDeployer({ exec: f.exec, cwd: "/x", minMinutes: 30, now: () => T0, log: () => {}, error: () => {} });
    d.deploy(true);
    f.calls[0].done(null);
    await settle();
    assert.equal(DEPLOY_TIMEOUT_MS, 600_000);
    assert.deepEqual(f.calls.map((c) => c.timeout), [600_000, 600_000]);
  });

  await test("deploy: web and dash are two independent steps", async () => {
    const f = fakeExec();
    const done: boolean[] = [];
    const d = createDeployer({ exec: f.exec, cwd: "/x", minMinutes: 30, now: () => T0, log: () => {}, error: () => {}, onDone: (ok) => done.push(ok) });
    d.deploy(true);
    assert.equal(f.calls[0].command, "npm run web:deploy");
    assert.ok(!f.calls[0].command.includes("&&"));
    f.calls[0].done(new Error("vercel failed"));
    await settle();
    assert.equal(f.calls[1].command, "npm run dash:deploy", "the dashboard still ships after the platform fails");
    f.calls[1].done(null);
    await settle();
    assert.deepEqual(done, [false], "the push is reported failed once, when both have run");
  });

  await test("deploy: the throttle still holds between finished pushes", async () => {
    const f = fakeExec();
    let t = T0;
    const d = createDeployer({ exec: f.exec, cwd: "/x", minMinutes: 30, now: () => t, log: () => {}, error: () => {} });
    d.deploy(false);
    f.calls[0].done(null);
    await settle();
    t += 10 * MIN;
    assert.equal(d.deploy(false), "throttled");
    t += 25 * MIN;
    assert.equal(d.deploy(false), "started");
    assert.equal(f.calls.length, 2, "no dashboard step without its link");
  });

  // ---- the timeouts ----------------------------------------------------------------------------
  console.log("timeouts");
  await test("timedFetch: a fetch that never answers is aborted at the deadline", async () => {
    const hung = (_: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    const started = Date.now();
    await assert.rejects(timedFetch(80, hung)("http://x"), /timed out after/);
    assert.ok(Date.now() - started < 2000);
  });

  await test("timedFetch: a caller's own signal still aborts first", async () => {
    const hung = (_: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("caller aborted"))));
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 20);
    await assert.rejects(timedFetch(5000, hung)("http://x", { signal: ctl.signal }), /caller aborted/);
  });

  await test("the RPC: a node that accepts the request and never answers is timed out", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const server = http.createServer(() => {
      /* never answers */
    });
    server.on("connection", (s) => sockets.add(s));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const conn = rpcConnection(url, { RPC_TIMEOUT_MS: "150" } as NodeJS.ProcessEnv);
      const started = Date.now();
      await assert.rejects(conn.getSlot(), /timed out after/);
      assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
    } finally {
      for (const s of sockets) s.destroy();
      server.close();
    }
  });

  // What he learned, in public: his observation's block, the status block, learned.json and the
  // MCP casebook (src/scripts/test-learn-surface.ts). Run here so they ride in `npm run test:all`.
  console.log("\nwhat he learned, in public");
  const { runLearnSurfaceTests } = await import("./test-learn-surface.js");
  await runLearnSurfaceTests(test);

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
