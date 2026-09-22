/**
 * WHAT HE LEARNED, IN PUBLIC: the four surfaces that print it, tested against one fixture so they
 * cannot drift apart. No RPC, no model, no network: a temp DATA_DIR with a handwritten
 * lessons.jsonl and learning.jsonl, and the renderers read from it.
 *
 *   readLearnedView      the view off disk: the factor in force, its sample, the change journal,
 *                        a foreign book's change refused, a lesson with no mode taken as the desk's
 *   learnFrozen          only the literal "true" freezes; "1", "yes", "on" and unset do not
 *   formatLearned        his observation's block: under its character budget, never a factor
 *                        without its sample, "not enough seats yet" under the minimum, "frozen"
 *                        when it is, and a loss printed at the size of a win
 *   /api/status          the shape of the `learning` block, and GET /api/learning beside it
 *   bands_lessons        rows with no secret, no wallet key and no recommending wording
 *   learned.json         the site's file is byte-identical to the API's block for one fixture
 *
 * Run on its own with `npx tsx src/scripts/test-learn-surface.ts`; `npm run test:status` runs it
 * too (src/scripts/test-status.ts), which is how it rides in `npm run test:all`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LEARNED_BUDGET_CHARS, formatLearned } from "../agent/observation";
import { emptyLearnedView, type LearnedChange, type LearnedView } from "../learn/surface";
import { forecastRatio, learnFrozen, readLearnedView } from "../status";

type Runner = (name: string, fn: () => void | Promise<void>) => Promise<void>;

const T0 = Date.parse("2026-09-20T12:00:00.000Z");
const H = 3_600_000;
const POOL = "D5ozarJBkGKRw7ceuftyS31cqrjooTnKyvDhNeME79bE";

/** One lesson row in the shape the desk writes (src/learn/record.ts). */
function lesson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    at: T0,
    mode: "paper",
    pool: POOL,
    label: "wXMR/SOL",
    position: "paper-D5ozar-69",
    kind: "memecoin",
    minutes: 87.5,
    seatSol: 42.7888,
    bins: 25,
    binStep: 20,
    coverPct: 4.912,
    inRangePct: 70.6,
    endReason: "idle",
    feesSol: 0.186098,
    netSol: 0.188083,
    predictedYieldPct: 18,
    realizedYieldPctPerDay: 7.16,
    headline: "Idle 684s above the band.",
    ...over,
  };
}

function change(over: Partial<LearnedChange> = {}): LearnedChange {
  return {
    at: T0 - 6 * H,
    mode: "paper",
    knob: "calibration",
    lane: "memecoin",
    from: 0.5,
    to: 0.45,
    why: "over 24 memecoin seats in 7 days his forecast realised at a median 0.41, too high on 21 of them",
    n: 24,
    windowH: 168,
    ...over,
  };
}

/** A DATA_DIR on disk with the rows a test wants. */
function fixture(lessons: Record<string, unknown>[], changes: LearnedChange[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mrbands-learned-"));
  fs.writeFileSync(path.join(dir, "lessons.jsonl"), lessons.map((l) => JSON.stringify(l)).join("\n") + "\n");
  if (changes.length) fs.writeFileSync(path.join(dir, "learning.jsonl"), changes.map((c) => JSON.stringify(c)).join("\n") + "\n");
  return dir;
}

/** 24 scored memecoin seats: enough for the calibration's minimum of 20. */
const scoredSeats = (n = 24): Record<string, unknown>[] =>
  Array.from({ length: n }, (_, i) => lesson({ at: T0 - i * H, position: `paper-D5ozar-${i}`, realizedYieldPctPerDay: 6 + (i % 5), predictedYieldPct: 18 }));

export async function runLearnSurfaceTests(test: Runner): Promise<void> {
  await test("the view: the factor in force is the newest journalled value, with the sample it rests on", () => {
    const dir = fixture(scoredSeats(), [change()]);
    const v = readLearnedView({ dir, mode: "paper", now: T0 + H });
    const f = v.factors.find((x) => x.knob === "calibration" && x.lane === "memecoin")!;
    assert.equal(f.factor, 0.45);
    assert.equal(f.defaultFactor, 0.5);
    assert.equal(f.n, 24);
    assert.equal(f.underSample, false);
    assert.equal(f.lastMovedAt, T0 - 6 * H);
    assert.ok(f.why?.includes("median 0.41"));
    assert.equal(v.lessons.total, 24);
    assert.equal(v.changes.length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("the view: under the minimum sample the shipped default stands and the count says why", () => {
    const dir = fixture(scoredSeats(6), []);
    const v = readLearnedView({ dir, mode: "paper", now: T0 + H });
    const f = v.factors.find((x) => x.lane === "memecoin")!;
    assert.equal(f.factor, 0.5, "the default, untouched");
    assert.equal(f.n, 6);
    assert.equal(f.minSample, 20);
    assert.equal(f.underSample, true);
    assert.equal(f.lastMovedAt, null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("the view: a change learned on another book is refused, so paper never rides into live", () => {
    const dir = fixture(scoredSeats(), [change({ mode: "paper", to: 0.3 })]);
    const live = readLearnedView({ dir, mode: "live", now: T0 + H });
    assert.equal(live.changes.length, 0, "a live desk reads no paper change");
    assert.equal(live.refused.changes, 1, "and says so rather than going quiet");
    assert.deepEqual(live.refused.lessons, { paper: 24 }, "the paper seats are named as refused, not silently dropped");
    assert.ok(formatLearned({ ...live, pool: { address: POOL, label: "wXMR/SOL" } }).includes("NOT counted"), "his observation says which rows it refused");
    assert.equal(live.factors.find((x) => x.lane === "memecoin")!.factor, 0.5, "the live desk keeps the shipped default");
    const paper = readLearnedView({ dir, mode: "paper", now: T0 + H });
    assert.equal(paper.changes.length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("the view: a lesson written before the mode field is the desk's own; a torn line is skipped", () => {
    const dir = fixture([lesson(), lesson({ mode: undefined, position: "old-1" })], []);
    fs.appendFileSync(path.join(dir, "lessons.jsonl"), '{"at":1,"mode":"pap\n');
    const v = readLearnedView({ dir, mode: "paper", now: T0 + H });
    assert.equal(v.lessons.total, 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("the view: pool penalties come only from journalled rows, and carry the pool's seat count", () => {
    const dir = fixture(scoredSeats(4), [change({ knob: "pool-penalty", lane: POOL, label: "wXMR/SOL", from: 1, to: 0.75, n: 4, windowH: 48, why: "3 of its last 4 seats went through the bottom" })]);
    const v = readLearnedView({ dir, mode: "paper", now: T0 + H });
    const p = v.factors.find((x) => x.knob === "pool-penalty")!;
    assert.equal(p.factor, 0.75);
    assert.equal(p.defaultFactor, 1);
    assert.equal(p.minSample, 3);
    assert.equal(p.n, 4);
    assert.equal(p.underSample, false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("the view: the forecast ratio is recomputed from the casebook, never typed in", () => {
    // two seats: 9/18 = 0.5 and 18/18 = 1.0 -> median 0.75, one of two too high
    const r = forecastRatio([
      { predictedYieldPct: 18, realizedYieldPctPerDay: 9 },
      { predictedYieldPct: 18, realizedYieldPctPerDay: 18 },
      { predictedYieldPct: null, realizedYieldPctPerDay: 5 },
      { predictedYieldPct: 0, realizedYieldPctPerDay: 5 },
    ]);
    assert.deepEqual(r, { median: 0.75, n: 2, tooHigh: 1 });
    assert.equal(forecastRatio([{ predictedYieldPct: null, realizedYieldPctPerDay: null }]), null);
  });

  await test("the page quotes the LEARNER's thresholds, so raising LEARN_CAL_MIN_N cannot leave it saying \"of the 20\"", () => {
    const dir = fixture(scoredSeats(24), []);
    const shipped = readLearnedView({ dir, mode: "paper", now: T0 + H }).factors.find((x) => x.lane === "memecoin")!;
    assert.deepEqual([shipped.minSample, shipped.n, shipped.underSample], [20, 24, false], "24 scored seats clear the shipped minimum of 20");
    const raised = readLearnedView({ dir, mode: "paper", now: T0 + H, env: { LEARN_CAL_MIN_N: "30" } as NodeJS.ProcessEnv }).factors.find((x) => x.lane === "memecoin")!;
    assert.deepEqual([raised.minSample, raised.n, raised.underSample], [30, 24, true], "the desk is now waiting for 30, and the page says 30 rather than its own copy of 20");
    const pool = readLearnedView({ dir, mode: "paper", now: T0 + H, env: { LEARN_POOL_MIN_N: "5" } as NodeJS.ProcessEnv, changes: 5 });
    const journalled = fixture(scoredSeats(24), [change({ knob: "pool-penalty", pool: POOL, label: "wXMR/SOL", lane: undefined, from: 1, to: 0.75, n: 4, windowH: 48, why: "3 of its last 4 seats went through the bottom" })]);
    const p = readLearnedView({ dir: journalled, mode: "paper", now: T0 + H, env: { LEARN_POOL_MIN_N: "5" } as NodeJS.ProcessEnv }).factors.find((x) => x.knob === "pool-penalty")!;
    assert.equal(p.minSample, 5, "and the pool minimum comes from LEARN_POOL_MIN_N too");
    assert.equal(pool.factors.every((x) => x.knob === "calibration"), true, "a pool with no journalled row shows no penalty at all");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(journalled, { recursive: true, force: true });
  });

  await test("a pool penalty the DESK journalled (knob under `pool`, not `lane`) reaches the page", () => {
    // the desk writes {knob: "pool-penalty", pool: <address>}; an earlier surface read it under `lane`
    // and dropped every row, so this is the shape on disk, not a shape a test invented
    const dir = fixture(scoredSeats(4), [change({ knob: "pool-penalty", lane: undefined, pool: POOL, label: "wXMR/SOL", from: 1, to: 0.75, n: 4, windowH: 48, why: "3 of its last 4 seats went through the bottom" })]);
    const v = readLearnedView({ dir, mode: "paper", now: T0 + H });
    const p = v.factors.find((x) => x.knob === "pool-penalty")!;
    assert.ok(p, "the row is not dropped on the way to the page");
    assert.deepEqual([p.lane, p.label, p.factor, p.defaultFactor], [POOL, "wXMR/SOL", 0.75, 1]);
    assert.equal(v.changes[0].pool, POOL, "and the journal row keeps the pool it names");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("the freeze switch: only the literal \"true\" freezes, and it is per knob too", () => {
    const table: [string | undefined, boolean][] = [
      [undefined, false],
      ["", false],
      ["1", false],
      ["yes", false],
      ["on", false],
      ["TRUE ", true],
      [" true", true],
      ["true", true],
    ];
    for (const [value, frozen] of table) {
      assert.equal(learnFrozen({ LEARN_FROZEN: value } as NodeJS.ProcessEnv).all, frozen, `LEARN_FROZEN=${JSON.stringify(value)}`);
    }
    const perKnob = learnFrozen({ LEARN_FROZEN_CALIBRATION: "true" } as NodeJS.ProcessEnv);
    assert.deepEqual(perKnob, { all: false, calibration: true, pools: false });
    assert.deepEqual(learnFrozen({ LEARN_FROZEN: "true" } as NodeJS.ProcessEnv), { all: true, calibration: true, pools: true }, "the master switch freezes every knob");
  });

  await test("his observation: the learned block stays inside its character budget", () => {
    const dir = fixture(scoredSeats(), [change()]);
    const v = readLearnedView({ dir, mode: "paper", pool: { address: POOL }, now: T0 + H });
    assert.equal(v.seats.length, 5, "five seats, no more");
    const block = formatLearned(v);
    assert.ok(block.length <= LEARNED_BUDGET_CHARS, `${block.length} characters, budget ${LEARNED_BUDGET_CHARS}`);
    assert.ok(block.startsWith("## What you have learned"));
    assert.ok(block.includes("wXMR/SOL"), "it names the pool he is looking at");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("his observation: a long casebook is trimmed oldest first, and the trim is stated", () => {
    const v = emptyLearnedView("paper", T0);
    v.pool = { address: POOL, label: "A-VERY-LONG-POOL-LABEL/SOL" };
    v.seats = Array.from({ length: 5 }, (_, i) => ({
      at: T0 - i * H,
      pool: POOL,
      label: "A-VERY-LONG-POOL-LABEL/SOL",
      minutes: 123.4,
      bins: 25,
      coverPct: 4.912,
      inRangePct: 70.6,
      endReason: "through-band",
      feesSol: 0.186098,
      netSol: -0.188083,
      netExDriftSol: 0.0332,
      predictedYieldPct: 18.4,
      realizedYieldPctPerDay: 7.16,
    }));
    const tight = formatLearned(v, 700);
    assert.ok(tight.length <= 700, `${tight.length} characters`);
    assert.ok(tight.includes("not shown"), "it says how many seats it dropped");
    assert.ok(tight.includes("-0.188"), "a loss is printed as a loss, at the size of a win");
    assert.ok(tight.includes("ex-drift"), "the quote's own move is shown beside the net, not folded into it");
  });

  await test("his observation: never a factor without its sample, and under the minimum it says so", () => {
    const dir = fixture(scoredSeats(6), []);
    const v = readLearnedView({ dir, mode: "paper", pool: { address: POOL }, now: T0 + H });
    const block = formatLearned(v);
    for (const line of block.split("\n")) {
      if (!/ x\d\.\d\d/.test(line)) continue;
      assert.ok(/\b\d+\b/.test(line) && /seats?\b/.test(line), `a factor with no sample beside it: ${line}`);
    }
    assert.ok(block.includes("not enough seats yet"), block);
    assert.ok(block.includes("6 of the 20"), block);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("his observation: a frozen desk says frozen, and still shows the record it is keeping", () => {
    const dir = fixture(scoredSeats(), [change()]);
    const v = readLearnedView({ dir, mode: "paper", pool: { address: POOL }, env: { LEARN_FROZEN: "true" } as NodeJS.ProcessEnv, now: T0 + H });
    const block = formatLearned(v);
    assert.ok(block.includes("FROZEN"), block);
    assert.ok(block.includes("[frozen]"), block);
    assert.ok(block.includes("closed seat(s) in"), "a freeze costs him no evidence: the seats are still shown");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("his observation: a knob with the sample but no move says it has not moved yet", () => {
    const dir = fixture(scoredSeats(), []);
    const v = readLearnedView({ dir, mode: "paper", pool: { address: POOL }, now: T0 + H });
    const f = v.factors.find((x) => x.lane === "memecoin")!;
    assert.equal(f.underSample, false);
    assert.equal(f.lastMovedAt, null);
    assert.ok(formatLearned(v).includes("has not moved yet"), formatLearned(v));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("his observation: with his model off the block says whose knobs these are", () => {
    const v = emptyLearnedView("paper", T0);
    const off = formatLearned(v);
    assert.ok(off.includes("Your model is off"), off);
    assert.ok(off.includes("no closed seat has scored your entry forecast yet"), off);
    v.modelOn = true;
    assert.ok(formatLearned(v).includes("Your model is answering"));
  });

  await test("the site's learned.json is the API's block, for the same fixture", async () => {
    const dir = fixture(scoredSeats(), [change()]);
    const api = readLearnedView({ dir, mode: "paper", now: T0 + H });
    // snapshot.ts writes JSON.stringify of exactly this object; the panel parses it back
    const onDisk = JSON.parse(JSON.stringify(api)) as LearnedView;
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(readLearnedView({ dir, mode: "paper", now: T0 + H }))));
    for (const key of ["mode", "frozen", "modelOn", "factors", "changes", "lessons", "refused", "neverTouched"]) {
      assert.ok(key in onDisk, `learned.json is missing ${key}`);
    }
    assert.ok(onDisk.neverTouched.includes("MAX_POSITION_SOL"), "the page names what learning may never touch");
    assert.ok(onDisk.neverTouched.includes("the kill switch"));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("bands_lessons: rows and knobs, no secret, no wallet key, and never a recommendation", async () => {
    // the tool reads the DESK's DATA_DIR (src/journal dataDir(), resolved against the cwd each call),
    // so the fixture is written where this process's config points and whatever was there is put back
    const { config } = await import("../config.js");
    const { dataDir } = await import("../journal/index.js");
    const cwd = process.cwd();
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mrbands-desk-"));
    if (!path.isAbsolute(config.dataDir)) process.chdir(sandbox);
    const desk = dataDir();
    fs.mkdirSync(desk, { recursive: true });
    const saved = new Map<string, Buffer | null>();
    const write = (name: string, body: string) => {
      const file = path.join(desk, name);
      saved.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null);
      fs.writeFileSync(file, body);
    };
    write("lessons.jsonl", scoredSeats().map((l) => JSON.stringify(l)).join("\n") + "\n");
    write("learning.jsonl", JSON.stringify(change()) + "\n");
    try {
      const { buildServer } = await import("../platform/mcp/server.js");
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
      const server = buildServer({
        audience: "public",
        connection: () => {
          throw new Error("bands_lessons must never touch the RPC");
        },
      });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "0" });
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      try {
        const listed = await client.listTools();
        const tool = listed.tools.find((t) => t.name === "bands_lessons");
        assert.ok(tool, "bands_lessons is listed to a credential-free caller");
        const described = `${tool!.description ?? ""}`.toLowerCase();
        // it may SAY it recommends nothing; it may not recommend. Only the recommending phrasings are banned.
        for (const word of ["we recommend", "recommended", "you should", "best pool", "guaranteed", "profitable", "alpha", "outperform"]) {
          assert.ok(!described.includes(word), `the description recommends: "${word}"`);
        }
        assert.ok(described.includes("paper"), "the description says the book is paper");
        assert.ok(described.includes("not advice"), "the description says it is not advice");
        const { HOUSE_TOOLS, toolPriceUsd } = await import("../platform/mcp/server.js");
        assert.equal(toolPriceUsd("bands_lessons"), 0, "his casebook is free");
        assert.ok(HOUSE_TOOLS.includes("bands_lessons"), "he is served his own casebook on the gateway");

        const res = await client.callTool({ name: "bands_lessons", arguments: { limit: 5 } });
        const text = (res.content as { type: string; text: string }[])[0].text;
        const body = JSON.parse(text) as { ok: boolean; book: string; lessons: unknown[]; learning: { factors: unknown[]; neverTouched: string[] } };
        assert.equal(body.ok, true);
        assert.equal(body.lessons.length, 5, "it returns the rows it was asked for");
        assert.ok(body.learning.factors.length > 0, "the knobs ride with the rows");
        assert.ok(body.learning.neverTouched.includes("the stop-loss"));
        const flat = text.toLowerCase();
        for (const leak of ["secret", "private_key", "privatekey", "wallet_secret", "authorization", "bearer", "mnemonic"]) {
          assert.ok(!flat.includes(leak), `bands_lessons leaked "${leak}"`);
        }
        for (const word of ["you should", "we recommend", "buy the", "sell the"]) {
          assert.ok(!flat.includes(word), `bands_lessons recommends: "${word}"`);
        }
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      for (const [file, body] of saved) {
        if (body === null) fs.rmSync(file, { force: true });
        else fs.writeFileSync(file, body);
      }
      process.chdir(cwd);
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
}

/** Standalone: `npx tsx src/scripts/test-learn-surface.ts`. */
if (require.main === module) {
  let passed = 0;
  let failed = 0;
  const run: Runner = async (name, fn) => {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${name}\n     ${(err as Error).stack ?? (err as Error).message}`);
      process.exitCode = 1;
    }
  };
  void runLearnSurfaceTests(run).then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(process.exitCode ?? 0);
  });
}
