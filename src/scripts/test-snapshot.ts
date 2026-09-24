/**
 * The site snapshot's book knob (src/publish/snapshot.ts): the sites carry only the real-money record.
 * A paper book is never written to journal.json, equity.json or learned.json unless SNAPSHOT_BOOK=paper
 * says so by hand; the book is none unless set, and a real book ships only while it is current. Every run writes into a scratch dir, never web/public.
 *   npx tsx src/scripts/test-snapshot.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { limitsFrom, parseEnvFile, REAL_BOOK_MAX_AGE_MS, snapshotBook, writeSnapshot } from "../publish/snapshot";
import { riskLimits } from "../config";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(err);
    process.exitCode = 1;
  }
}

const T0 = Date.parse("2026-09-18T12:00:00.000Z");
const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const read = (dir: string, name: string): any => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));

/** A scratch world: a real book, a paper book's lessons, a live env file and an out dir. */
function world(): { root: string; real: string; paper: string; out: string; liveEnv: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mrbands-snapshot-"));
  const real = path.join(root, "data-mainnet");
  const paper = path.join(root, "data-live");
  const out = path.join(root, "public");
  fs.mkdirSync(real);
  fs.mkdirSync(paper);
  fs.writeFileSync(path.join(real, "decisions.jsonl"), jsonl([1, 2, 3].map((i) => ({ id: `r${i}`, ts: new Date(T0 + i * 60_000).toISOString(), cycle: i, mode: "live" }))));
  fs.writeFileSync(path.join(real, "equity.jsonl"), jsonl([1, 2].map((i) => ({ t: T0 + i * 60_000, equitySol: 19.7 + i / 100 }))));
  const seat = (mode: string, i: number) => ({ at: T0 - i * 3_600_000, mode, pool: "P", label: "X/SOL", position: `${mode}-${i}`, kind: "memecoin", minutes: 60, bins: 20, coverPct: 5, inRangePct: 80, endReason: "idle", feesSol: 0.01, netSol: 0.01, realizedYieldPctPerDay: 5 });
  fs.writeFileSync(path.join(real, "lessons.jsonl"), jsonl([0, 1, 2].map((i) => seat("live", i))));
  fs.writeFileSync(path.join(paper, "lessons.jsonl"), jsonl([0, 1, 2, 3, 4, 5, 6].map((i) => seat("paper", i))));
  const liveEnv = path.join(root, "live.env");
  fs.writeFileSync(liveEnv, "# the live desk\nDATA_DIR=data-mainnet\nMAX_POSITION_SOL=10\nMAX_TOTAL_EXPOSURE_SOL=15\nGAS_RESERVE_SOL=1.5\n");
  return { root, real, paper, out, liveEnv };
}

async function main(): Promise<void> {
  await test("SNAPSHOT_BOOK: none by default in every shell, an explicit value wins, a typo throws", () => {
    assert.equal(snapshotBook({ PAPER_SOL: "100", DRY_RUN: "true" }), "none");
    assert.equal(snapshotBook({}), "none", "a plain shell (the repo .env: DRY_RUN=true, DATA_DIR=data, no PAPER_SOL) never ships a real book");
    assert.equal(snapshotBook({ DATA_DIR: "data-mainnet", PAPER_SOL: "0" }), "none");
    assert.equal(snapshotBook({ SNAPSHOT_BOOK: "" }), "none");
    assert.equal(snapshotBook({ PAPER_SOL: "100", SNAPSHOT_BOOK: "paper" }), "paper");
    assert.equal(snapshotBook({ SNAPSHOT_BOOK: " Real " }), "real");
    assert.throws(() => snapshotBook({ SNAPSHOT_BOOK: "papr" }), /SNAPSHOT_BOOK/);
  });

  await test("the live desk's env file is the one place that sets SNAPSHOT_BOOK=real", () => {
    const live = parseEnvFile(fs.readFileSync(path.resolve(process.cwd(), "ops/live.env"), "utf8"));
    assert.equal(live.SNAPSHOT_BOOK, "real");
    assert.equal(snapshotBook(live), "real");
  });

  await test("the paper plist sets SNAPSHOT_BOOK=none", () => {
    const plist = fs.readFileSync(path.resolve(process.cwd(), "ops/com.bands.mrbands.paper.plist"), "utf8");
    assert.match(plist, /<key>SNAPSHOT_BOOK<\/key><string>none<\/string>/);
  });

  await test("build.json: his posted build notes, newest first; never a dry record, a reply, another type or one past 14 days", async () => {
    const { buildNotesFrom } = await import("../publish/snapshot.js");
    const now = Date.parse("2026-09-24T12:00:00Z");
    const row = (o: Record<string, unknown>) => JSON.stringify({ id: "2102605051181015343", at: "2026-09-23T03:44:00Z", type: "build", text: "I now make at most 60 judgment calls a day.", ...o });
    const lines = [
      row({}),
      row({ id: "2102938240500007143", at: "2026-09-24T01:48:00Z", text: "A band on paper earns only the fees that traded through its own bins." }),
      row({ id: "draft:build:x", text: "a dry record" }),
      row({ id: "2102505672881365205", type: "reply", text: "a reply" }),
      row({ id: "2102505672881365206", replyTo: "1", text: "a reply by field" }),
      row({ id: "2102733702144962593", type: "desk", text: "a close" }),
      row({ id: "2102578495159259157", type: "miss", at: "2026-09-23T01:59:00Z", text: "After my real-money run I left a stop switch on." }),
      row({ id: "2101000000000000000", at: "2026-09-01T00:00:00Z", text: "too old" }),
      "{torn",
    ].join("\n");
    const notes = buildNotesFrom(lines, now);
    assert.deepEqual(notes.map((n) => n.type + ":" + n.text.slice(0, 12)), ["build:A band on pa", "build:I now make a", "miss:After my rea"]);
    const w = world();
    const talk = path.join(w.out, "..", "talk");
    fs.mkdirSync(talk, { recursive: true });
    fs.writeFileSync(path.join(talk, "x-posts.jsonl"), lines);
    const r = writeSnapshot({ out: w.out, book: "none", realDir: w.real, learnedDir: w.real, liveEnvFile: w.liveEnv, now, talkDir: talk });
    assert.ok(r.wrote.includes("build.json"));
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.out, "build.json"), "utf8")).notes.length, 3);
  });

  await test("the live env file: its limits over the process's, comments skipped", () => {
    const env = parseEnvFile("# MAX_POSITION_SOL=99\nMAX_POSITION_SOL=10\nSTOP_LOSS_PCT='12'\nNOT A LINE\n");
    assert.deepEqual(env, { MAX_POSITION_SOL: "10", STOP_LOSS_PCT: "12" });
    const l = limitsFrom(env, riskLimits);
    assert.equal(l.maxPositionSol, 10);
    assert.equal(l.stopLossPct, 12);
    assert.equal(l.maxBinWidth, riskLimits.maxBinWidth);
  });

  await test("none: journal and equity written empty with generatedAt, limits and learned still written", () => {
    const w = world();
    const r = writeSnapshot({ out: w.out, book: "none", realDir: w.real, learnedDir: w.real, liveEnvFile: w.liveEnv, now: T0 + 86_400_000, screen: { rankedPools: 3 }, hot: { rows: [] } });
    assert.deepEqual(read(w.out, "journal.json"), { entries: [], generatedAt: new Date(T0 + 86_400_000).toISOString() });
    assert.deepEqual(read(w.out, "equity.json"), { points: [], generatedAt: new Date(T0 + 86_400_000).toISOString() });
    assert.equal(r.entries, 0);
    assert.equal(r.points, 0);
    assert.equal(read(w.out, "limits.json").maxPositionSol, 10, "the real desk's limits, not the paper desk's");
    assert.deepEqual(read(w.out, "screen.json"), { rankedPools: 3 });
    assert.deepEqual(read(w.out, "hot.json"), { rows: [] });
    assert.deepEqual(r.wrote.sort(), ["equity.json", "hot.json", "journal.json", "learned.json", "limits.json", "screen.json"]);
    fs.rmSync(w.root, { recursive: true, force: true });
  });

  await test("real: the real book's journal newest first and its equity oldest first, while it is current", () => {
    const w = world();
    const r = writeSnapshot({ out: w.out, book: "real", realDir: w.real, learnedDir: w.real, liveEnvFile: w.liveEnv, now: T0 + 3_600_000 });
    assert.equal(r.book, "real");
    assert.equal(r.staleReal, undefined);
    const j = read(w.out, "journal.json");
    assert.deepEqual(j.entries.map((e: { id: string }) => e.id), ["r3", "r2", "r1"]);
    assert.ok(j.entries.every((e: { mode: string }) => e.mode === "live"));
    assert.deepEqual(read(w.out, "equity.json").points.map((p: { t: number }) => p.t), [T0 + 60_000, T0 + 120_000]);
    assert.equal(r.newest, `live ${new Date(T0 + 180_000).toISOString()}`);
    assert.ok(!fs.existsSync(path.join(w.out, "screen.json")), "no screen given, none written");
    fs.rmSync(w.root, { recursive: true, force: true });
  });

  await test("real but finished: a book with no decision in the last 2 h ships as none (a settled run is not now)", () => {
    const w = world();
    // newest decision at T0+3m; 2 h after it is the edge, a minute past it is stale
    const edge = writeSnapshot({ out: w.out, book: "real", realDir: w.real, learnedDir: w.real, liveEnvFile: w.liveEnv, now: T0 + 180_000 + REAL_BOOK_MAX_AGE_MS });
    assert.equal(edge.book, "real");
    assert.equal(edge.entries, 3);
    const now = T0 + 180_000 + REAL_BOOK_MAX_AGE_MS + 60_000;
    const r = writeSnapshot({ out: w.out, book: "real", realDir: w.real, learnedDir: w.real, liveEnvFile: w.liveEnv, now });
    assert.equal(r.book, "none");
    assert.equal(r.staleReal, new Date(T0 + 180_000).toISOString());
    assert.equal(r.entries, 0);
    assert.equal(r.points, 0);
    assert.deepEqual(read(w.out, "journal.json"), { entries: [], generatedAt: new Date(now).toISOString() });
    assert.deepEqual(read(w.out, "equity.json"), { points: [], generatedAt: new Date(now).toISOString() });
    assert.equal(read(w.out, "limits.json").maxPositionSol, 10, "still the real desk's limits");
    fs.rmSync(w.root, { recursive: true, force: true });
  });

  await test("learned.json: the real seats as the live book, never a paper book's lessons", () => {
    const w = world();
    writeSnapshot({ out: w.out, book: "none", realDir: w.real, learnedDir: w.real, liveEnvFile: w.liveEnv, now: T0 + 3_600_000 });
    const l = read(w.out, "learned.json");
    assert.equal(l.mode, "live");
    assert.equal(l.lessons.total, 3);
    // pointed at a paper book by mistake it still reads only live seats: the paper rows are refused
    writeSnapshot({ out: w.out, book: "none", realDir: w.real, learnedDir: w.paper, liveEnvFile: w.liveEnv, now: T0 + 3_600_000 });
    const p = read(w.out, "learned.json");
    assert.equal(p.mode, "live");
    assert.equal(p.lessons.total, 0);
    assert.equal(p.refused.lessons.paper, 7);
    fs.rmSync(w.root, { recursive: true, force: true });
  });

  await test("a missing real dir and env file: empty book, the process's limits, an empty learned view", () => {
    const w = world();
    const gone = path.join(w.root, "nope");
    const r = writeSnapshot({ out: w.out, book: "real", realDir: gone, learnedDir: gone, liveEnvFile: path.join(gone, "live.env"), now: T0 });
    assert.equal(r.entries, 0);
    assert.equal(r.book, "none");
    assert.equal(r.staleReal, "empty");
    assert.deepEqual(read(w.out, "limits.json"), riskLimits);
    assert.equal(read(w.out, "learned.json").lessons.total, 0);
    fs.rmSync(w.root, { recursive: true, force: true });
  });

  console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
}

void main();
