/**
 * The Bands Exchange room (game-server/src/core.ts), on fakes: no Cloudflare, no network, a hand-wound clock and a
 * seeded random. Joining and generated names, the room cap, move rate limits / disc clamp / teleport check, batched
 * moves, the emote and phrase allow-lists, and the server-streamed round: a band laid only on board pools, ticks sent
 * in order as the server clock reaches them, close settling at the last tick sent (a simulate() replay, never the
 * client's claim), auto-settle at TICKS, one round at a time, forfeit on leave, expiry, and never a seed on the wire.
 * Rounds on a pool's real history: a hidden stretch replayed, named only with the score, and the simulated fallback.
 * Then the best-per-name top 20, malformed input, the board and history sources and origins.
 *   npm run test:game-room
 */
import assert from "node:assert/strict";
import {
  BOARD_POOLS,
  BOARD_ROWS,
  BOARD_RETRY_MS,
  BOARD_TTL_MS,
  boardSource,
  clampToDisc,
  cleanBoard,
  CLOSE_FULL,
  CLOSE_NO_HELLO,
  ERROR_GAP_MS,
  HELLO_TIMEOUT_MS,
  HISTORY_KEEP,
  historyFromFile,
  HISTORY_RETRY_MS,
  HISTORY_TTL_MS,
  historySource,
  isRoomName,
  MAX_CONNECTIONS,
  MOVE_BURST,
  MSG_BURST,
  NAME_ADJECTIVES,
  NAME_NOUNS,
  originAllowed,
  parseBoard,
  ROOM_TICK_MS,
  RoomCore,
  ROUND_TTL_MS,
  SLOW_NOTICE_MS,
} from "../../game-server/src/core";
import type { RoomDeps } from "../../game-server/src/core";
import { EMOTES, MAX_SPEED, MOVE_HZ, PHRASES, ROOM_CAP, ROUND_TICK_MS, STRAPS, WORLD_RADIUS } from "../../web/src/game/protocol";
import type { S2C, ScoreRow } from "../../web/src/game/protocol";
import { hourlySeries, MARKET_HOURS, marketWindow, simulate, TICKS } from "../../web/src/game/lpGame";
import type { Choice, PoolParams } from "../../web/src/game/lpGame";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(err);
    process.exit(1);
  }
}

/* ---------- fixtures: hot.json rows in the live file's shape (2026-09-24, trimmed to the fields that matter) ---------- */
const hotRow = (i: number, over: Record<string, unknown> = {}) => ({
  address: `Pool${String(i).padStart(2, "0")}AddrXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`,
  name: `TOK${i} / USDC`,
  venue: "meteora-dlmm",
  feePct: 0.2 + (i % 4) * 0.1,
  feeToTvl1hPct: 0.2 + (i % 5) * 0.15,
  priceChange5mPct: (i % 3) * 0.4 - 0.4,
  priceChange1hPct: 1 + (i % 6) * 0.9,
  ...over,
});
const HOT = {
  generatedAt: "2026-09-24T12:17:52.788Z",
  rows: [
    hotRow(0, { address: "2N1KNuLSt167P6p9P8HYcisTvTTv4vYTM8QJBbtv1xYU", name: "CARDS / USDC", feePct: 0.2, feeToTvl1hPct: 0.696 }),
    hotRow(1, { address: "WVQ6uNtARvaSA4qzsVUrdccastXBj3rdLWVsNMxo46M", name: "SILV / USDC", feePct: 0.65, feeToTvl1hPct: 0.3044 }),
    hotRow(2, { feeToTvl1hPct: null }), // unusable: no fee rate
    ...Array.from({ length: 14 }, (_, k) => hotRow(k + 3)),
  ],
};
const POOLS = parseBoard(HOT);
const CARDS = POOLS[0];

/** mulberry32, for a reproducible room */
function seeded(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Of<T extends S2C["t"]> = Extract<S2C, { t: T }>;
const ofType = <T extends S2C["t"]>(msgs: S2C[], t: T): Of<T>[] => msgs.filter((m): m is Of<T> => m.t === t);

/** a room on fakes: per-socket inboxes, a hand-wound clock */
function world(
  opts: { pools?: PoolParams[]; board?: () => Promise<PoolParams[]>; history?: (pool: PoolParams) => Promise<unknown>; leaderboard?: unknown; seed?: number } = {},
) {
  let t = Date.parse("2026-09-24T12:00:00Z");
  const inbox = new Map<string, S2C[]>();
  /** every frame that went to any socket, as it went */
  const wire: string[] = [];
  const push = (id: string, msg: S2C) => {
    const json = JSON.stringify(msg);
    wire.push(json);
    const box = inbox.get(id) ?? [];
    box.push(JSON.parse(json) as S2C); // what crosses the wire
    inbox.set(id, box);
  };
  const closed: { id: string; code: number; reason: string }[] = [];
  const saved: ScoreRow[][] = [];
  const joined: { id: string; name: string; strap: number }[] = [];
  const deps: RoomDeps = {
    send: (id, msg) => push(id, msg),
    broadcast: (msg, exceptId) => {
      for (const id of core.ids()) if (id !== exceptId) push(id, msg);
    },
    now: () => t,
    random: seeded(opts.seed ?? 7),
    board: opts.board ?? (async () => opts.pools ?? POOLS),
    ...(opts.history ? { history: opts.history } : {}),
    saveBoard: (rows) => saved.push(rows),
    close: (id, code, reason) => closed.push({ id, code, reason }),
    joined: (id, name, strap) => joined.push({ id, name, strap }),
  };
  const core = new RoomCore(deps, opts.leaderboard);
  const w = {
    core,
    closed,
    saved,
    joined,
    wire,
    get now() {
      return t;
    },
    advance(ms: number) {
      t += ms;
    },
    inbox: (id: string) => inbox.get(id) ?? [],
    /** read and empty one inbox */
    take(id: string): S2C[] {
      const box = inbox.get(id) ?? [];
      inbox.set(id, []);
      return box;
    },
    clear() {
      inbox.clear();
    },
    all: () => [...inbox.values()].flat(),
    send: (id: string, msg: unknown) => core.message(id, typeof msg === "string" ? msg : JSON.stringify(msg)),
    async join(hello: Record<string, unknown> = { strap: 0 }): Promise<string> {
      const id = core.open();
      assert.ok(id, "the door is open");
      await w.send(id, { t: "hello", ...hello });
      return id;
    },
    pos(id: string) {
      const p = core.player(id);
      assert.ok(p, `player ${id} is in the room`);
      return p;
    },
    /** walk in legal steps (8 m a second) to (x, z) */
    async walk(id: string, x: number, z: number) {
      for (let i = 0; i < 40; i++) {
        const p = w.pos(id);
        const d = Math.hypot(x - p.x, z - p.z);
        if (d < 0.01) return;
        const k = Math.min(1, 8 / d);
        w.advance(1000);
        await w.send(id, { t: "move", x: p.x + (x - p.x) * k, z: p.z + (z - p.z) * k, ry: 0, moving: true });
      }
      throw new Error("walk did not arrive");
    },
    /** the heartbeat: wind the clock ms forward in ROOM_TICK_MS steps, ticking the room at each */
    run(ms: number) {
      for (let done = 0; done < ms; done += ROOM_TICK_MS) {
        t += ROOM_TICK_MS;
        core.tick();
      }
    },
    /** lay a band (a second after the last, for the limit) and return "laid" and the server's own view of the round */
    async lay(id: string, pool: string = CARDS.label, band: object = CHOICE) {
      w.advance(1000);
      await w.send(id, { t: "lay", pool, ...band });
      const laid = ofType(w.take(id), "laid");
      assert.equal(laid.length, 1, "laid");
      const view = core.roundOf(id);
      assert.ok(view, "the server holds the round");
      seeds.push(view.seed);
      return { laid: laid[0], view, start: t };
    },
    async close(id: string, roundId: string, extra: Record<string, unknown> = {}) {
      await w.send(id, { t: "close", roundId, ...extra });
      return w.take(id);
    },
    /** lay, let ticks 1..k go out in one late heartbeat, close: the scored message */
    async playTo(id: string, k: number, band: Choice = CHOICE) {
      const { laid, view } = await w.lay(id, CARDS.label, band);
      w.advance(k * ROUND_TICK_MS);
      core.tick();
      const heard = w.take(id);
      assert.deepEqual(ofType(heard, "tick").map((m) => m.i), Array.from({ length: k }, (_, j) => j + 1));
      // at TICKS the round settles on that heartbeat; before it, the close settles it
      const scored = ofType(k >= TICKS ? heard : await w.close(id, laid.roundId), "scored");
      assert.equal(scored.length, 1, "scored");
      return { scored: scored[0], view };
    },
    /** no frame to anyone ever carried a dealt seed, or a "seed" or "path" key */
    assertNoSeed() {
      for (const json of wire) {
        assert.ok(!json.includes('"seed"') && !json.includes('"path"'), `no seed or path key: ${json}`);
        for (const seed of seeds) assert.ok(!new RegExp(`(^|[^0-9.])${seed}([^0-9.]|$)`).test(json), `seed ${seed} leaked: ${json}`);
      }
    },
  };
  const seeds: number[] = [];
  return w;
}

const CHOICE: Choice = { widthBins: 20, offsetBins: 0 };

async function main() {
  console.log("game room");

  // ---------------------------------------------------------------- joining

  await test("hello -> welcome (you, a generated name, everyone, the board) and a join to the others", async () => {
    const w = world();
    const a = await w.join({ strap: 2 });
    const welA = ofType(w.take(a), "welcome");
    assert.equal(welA.length, 1);
    assert.equal(welA[0].you, a);
    assert.ok(isRoomName(welA[0].name), `generated name, got ${welA[0].name}`);
    assert.deepEqual(welA[0].players.map((p) => p.id), [a]);
    assert.equal(welA[0].players[0].strap, 2);
    assert.deepEqual(welA[0].board, []);

    const b = await w.join({ strap: 4 });
    const welB = ofType(w.take(b), "welcome")[0];
    assert.deepEqual(welB.players.map((p) => p.id).sort(), [a, b].sort(), "the newcomer sees everyone");
    const joins = ofType(w.take(a), "join");
    assert.equal(joins.length, 1, "the room hears of the newcomer");
    assert.equal(joins[0].p.id, b);
    assert.equal(joins[0].p.name, welB.name);
    assert.equal(ofType(w.inbox(b), "join").length, 0, "the newcomer is not told of themself");
    const spawn = w.pos(b);
    assert.ok(Math.hypot(spawn.x, spawn.z) <= WORLD_RADIUS, "spawned on the disc");
    assert.deepEqual(w.joined.map((j) => j.id), [a, b], "the host is told who joined");
  });

  await test("names come only from the word lists: a name in hello is ignored, names are unique in the room", async () => {
    const w = world();
    const names = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const id = await w.join({ strap: 1, name: "<b>Mr Bands</b>", n: "Admin" });
      const name = ofType(w.take(id), "welcome")[0].name;
      assert.ok(isRoomName(name), name);
      const [adj, noun, nn] = name.split(" ");
      assert.ok((NAME_ADJECTIVES as readonly string[]).includes(adj));
      assert.ok((NAME_NOUNS as readonly string[]).includes(noun));
      assert.ok(/^[1-9][0-9]$/.test(nn), "two digits");
      assert.ok(!/Bands|Admin|</.test(name));
      names.add(name);
    }
    assert.equal(names.size, 40, "no two players share a name");
    assert.ok(!w.all().some((m) => JSON.stringify(m).includes("Admin") || JSON.stringify(m).includes("<b>")), "input never echoed");
  });

  await test("strap is clamped to 0..STRAPS.length-1 (garbage -> 0)", async () => {
    const w = world();
    const cases: [unknown, number][] = [[99, STRAPS.length - 1], [-3, 0], ["3", 0], [2.7, 2], [null, 0], [1, 1]];
    for (const [given, want] of cases) {
      const id = await w.join({ strap: given });
      assert.equal(ofType(w.take(id), "welcome")[0].players.find((p) => p.id === id)?.strap, want, `strap ${String(given)}`);
    }
  });

  await test("before hello a socket can do nothing; a second hello is ignored", async () => {
    const w = world();
    const a = await w.join();
    w.clear();
    const lurker = w.core.open()!;
    await w.send(lurker, { t: "emote", e: "wave" });
    await w.send(lurker, { t: "move", x: 1, z: 1, ry: 0, moving: true });
    await w.send(lurker, { t: "lay", pool: CARDS.label, ...CHOICE });
    assert.equal(w.all().length, 0, "nothing heard, nothing laid");
    assert.equal(w.core.size, 1);
    await w.send(a, { t: "hello", strap: 3 });
    assert.equal(w.all().length, 0, "no second welcome");
  });

  await test("ROOM_CAP: the next hello gets { t: 'full' } and its socket is closed", async () => {
    const w = world();
    for (let i = 0; i < ROOM_CAP; i++) await w.join();
    assert.equal(w.core.size, ROOM_CAP);
    w.clear();
    const late = w.core.open()!;
    await w.send(late, { t: "hello", strap: 0 });
    assert.deepEqual(w.take(late), [{ t: "full" }]);
    assert.deepEqual(w.closed, [{ id: late, code: CLOSE_FULL, reason: "full" }]);
    assert.equal(w.core.size, ROOM_CAP);
    assert.equal(w.all().length, 0, "no join went out");
  });

  await test("the door shuts past MAX_CONNECTIONS sockets, and a socket that never says hello is closed", async () => {
    const w = world();
    const ids: string[] = [];
    for (let i = 0; i < MAX_CONNECTIONS; i++) ids.push(w.core.open()!);
    assert.equal(w.core.open(), null);
    w.advance(HELLO_TIMEOUT_MS + 1);
    w.core.tick();
    assert.equal(w.closed.length, MAX_CONNECTIONS);
    assert.ok(w.closed.every((c) => c.code === CLOSE_NO_HELLO));
    assert.equal(w.core.connections, 0);
    assert.ok(w.core.open(), "open again");
  });

  // ---------------------------------------------------------------- moving

  await test("moves at MOVE_HZ pass; a flood is cut to the burst and told { t: 'slow' } at most once per 5 s", async () => {
    const w = world();
    const a = await w.join();
    w.take(a);
    // a steady client, 84 ms apart for 5 s: never slowed
    for (let i = 0; i < 60; i++) {
      w.advance(Math.ceil(1000 / MOVE_HZ));
      const p = w.pos(a);
      await w.send(a, { t: "move", x: p.x + 0.3, z: p.z, ry: 0, moving: true });
    }
    assert.equal(ofType(w.take(a), "slow").length, 0, "a well-behaved client is never slowed");

    // a flood at one instant: MOVE_BURST get through, one slow notice
    w.advance(1000);
    const start = w.pos(a).x;
    for (let i = 1; i <= 20; i++) await w.send(a, { t: "move", x: start + i * 0.1, z: w.pos(a).z, ry: 0, moving: true });
    assert.ok(Math.abs(w.pos(a).x - (start + MOVE_BURST * 0.1)) < 0.011, `moved ${MOVE_BURST} steps`);
    assert.equal(ofType(w.take(a), "slow").length, 1);
    w.advance(1000);
    for (let i = 0; i < 20; i++) await w.send(a, { t: "move", x: w.pos(a).x, z: w.pos(a).z, ry: 0, moving: false });
    assert.equal(ofType(w.take(a), "slow").length, 0, "no second notice inside 5 s");
    w.advance(SLOW_NOTICE_MS);
    for (let i = 0; i < 20; i++) await w.send(a, { t: "move", x: w.pos(a).x, z: w.pos(a).z, ry: 0, moving: false });
    assert.equal(ofType(w.take(a), "slow").length, 1, "told again after 5 s");
  });

  await test("positions are clamped into the disc; a clamp of more than 0.5 m is corrected to the player", async () => {
    const w = world();
    const a = await w.join();
    await w.walk(a, 41.5, 0);
    w.take(a);
    w.advance(500);
    await w.send(a, { t: "move", x: 42.3, z: 0, ry: 0, moving: true });
    assert.equal(w.pos(a).x, WORLD_RADIUS);
    assert.equal(ofType(w.take(a), "moves").length, 0, "a small clamp is silent");
    w.advance(500);
    await w.send(a, { t: "move", x: 42, z: 3, ry: 0, moving: true }); // outside by ~0.1 m
    w.advance(500);
    await w.send(a, { t: "move", x: 44.5, z: 0, ry: 0, moving: true }); // 2.5 m outside, a legal step
    const p = w.pos(a);
    assert.ok(Math.abs(Math.hypot(p.x, p.z) - WORLD_RADIUS) < 0.01, "on the rim");
    const fixes = ofType(w.take(a), "moves");
    assert.equal(fixes.length, 1, "told where it really is");
    assert.deepEqual(fixes[0].m, [[a, p.x, p.z, p.ry, 1]]);
    const [cx, cz] = clampToDisc(30, 40);
    assert.ok(Math.abs(cx - 25.2) < 1e-9 && Math.abs(cz - 33.6) < 1e-9);
  });

  await test("a jump faster than MAX_SPEED * elapsed + 1 m is refused and the player snapped back", async () => {
    const w = world();
    const a = await w.join();
    const b = await w.join();
    w.clear();
    const start = w.pos(a);
    w.advance(100); // 0.1 s allows 0.9 + 1 m
    await w.send(a, { t: "move", x: start.x + 5, z: start.z, ry: 1, moving: true });
    assert.deepEqual(w.pos(a), start, "position kept");
    assert.deepEqual(ofType(w.take(a), "moves")[0].m, [[a, start.x, start.z, start.ry, 0]], "snapped back");
    w.core.tick();
    assert.equal(w.all().length, 0, "the refused move never went out");
    await w.send(a, { t: "move", x: start.x + 1.5, z: start.z, ry: 1, moving: true });
    assert.ok(Math.abs(w.pos(a).x - (start.x + 1.5)) < 0.011, "a legal step still lands");
    // a long idle does not buy a teleport: at most MAX_STEP_SECONDS of travel counts
    w.advance(60_000);
    const here = w.pos(a);
    await w.send(a, { t: "move", x: here.x - 30, z: here.z, ry: 0, moving: true });
    assert.deepEqual(w.pos(a), here);
    w.advance(1000);
    await w.send(a, { t: "move", x: here.x - MAX_SPEED, z: here.z, ry: 0, moving: true });
    assert.ok(Math.abs(w.pos(a).x - (here.x - MAX_SPEED)) < 0.011, "a sprint within MAX_SPEED lands");
    void b;
  });

  await test("non-finite or missing numbers are ignored", async () => {
    const w = world();
    const a = await w.join();
    w.take(a);
    const start = w.pos(a);
    w.advance(500);
    await w.send(a, '{"t":"move","x":1e999,"z":0,"ry":0,"moving":true}');
    await w.send(a, { t: "move", x: "1", z: 0, ry: 0, moving: true });
    await w.send(a, { t: "move", x: 1, z: null, ry: 0, moving: true });
    await w.send(a, { t: "move", x: 1, z: 1, moving: true });
    assert.deepEqual(w.pos(a), start);
    assert.equal(w.take(a).length, 0);
  });

  await test("moves go out batched each tick, only for movers, never echoing a mover's own entry", async () => {
    const w = world();
    const [a, b, c] = [await w.join(), await w.join(), await w.join()];
    w.clear();
    w.advance(200);
    const pa = w.pos(a);
    const pb = w.pos(b);
    await w.send(a, { t: "move", x: pa.x + 1, z: pa.z, ry: 0.5, moving: true });
    await w.send(b, { t: "move", x: pb.x, z: pb.z + 1, ry: -0.25, moving: false });
    assert.equal(w.all().length, 0, "nothing until the tick");
    w.core.tick();
    const ea: [string, number, number, number, 0 | 1] = [a, w.pos(a).x, w.pos(a).z, 0.5, 1];
    const eb: [string, number, number, number, 0 | 1] = [b, w.pos(b).x, w.pos(b).z, -0.25, 0];
    assert.deepEqual(w.take(c), [{ t: "moves", m: [ea, eb] }], "a bystander gets both, in one message");
    assert.deepEqual(w.take(a), [{ t: "moves", m: [eb] }], "a mover gets the others only");
    assert.deepEqual(w.take(b), [{ t: "moves", m: [ea] }]);
    w.core.tick();
    assert.equal(w.all().length, 0, "no movers, no message");
    w.advance(200);
    await w.send(c, { t: "move", x: w.pos(c).x, z: w.pos(c).z + 0.5, ry: 0, moving: true });
    w.core.tick();
    assert.deepEqual(w.take(c), [], "a lone mover hears nothing of itself");
    assert.equal(ofType(w.take(a), "moves")[0].m.length, 1);
  });

  // ---------------------------------------------------------------- emotes and phrases

  await test("emote/say: only allow-listed values, to everyone but the sender, one a second per player", async () => {
    const w = world();
    const [a, b] = [await w.join(), await w.join()];
    w.clear();
    await w.send(a, { t: "emote", e: "wave", note: "<script>" });
    assert.deepEqual(w.take(b), [{ t: "emote", id: a, e: "wave" }], "only the id and the emote go out");
    assert.deepEqual(w.take(a), [], "no echo to the sender");
    await w.send(a, { t: "say", p: "Hello" });
    assert.equal(ofType(w.take(b), "say").length, 0, "inside the second: dropped (emotes and phrases share it)");
    assert.equal(ofType(w.take(a), "slow").length, 1);
    w.advance(1000);
    await w.send(a, { t: "say", p: "Hello" });
    assert.deepEqual(w.take(b), [{ t: "say", id: a, p: "Hello" }]);
    w.clear();
    for (const bad of [
      { t: "emote", e: "dab" },
      { t: "emote", e: "Wave" },
      { t: "say", p: "gm free text" },
      { t: "say", p: "hello" },
      { t: "say", p: 3 },
      { t: "say" },
    ]) {
      w.advance(1100);
      await w.send(a, bad);
    }
    assert.equal(w.all().length, 0, "nothing off the lists goes out");
    for (const e of EMOTES) {
      w.advance(1000);
      await w.send(b, { t: "emote", e });
    }
    for (const p of PHRASES) {
      w.advance(1000);
      await w.send(b, { t: "say", p });
    }
    assert.equal(w.take(a).length, EMOTES.length + PHRASES.length, "every listed one goes out");
  });

  // ---------------------------------------------------------------- rounds (played on the server)

  await test("lay: only on the board's pools (label, any case, or address); laid carries the pool, bounds and pace, no seed", async () => {
    const w = world();
    const [a, b, c] = [await w.join(), await w.join(), await w.join()];
    w.clear();
    const { laid, view } = await w.lay(a, "cards / usdc");
    assert.deepEqual(Object.keys(laid).sort(), ["lower", "pool", "real", "roundId", "t", "tickMs", "upper"]);
    assert.equal(laid.real, false, "no history to read: simulated");
    assert.deepEqual(laid.pool, CARDS);
    const sim = simulate(CARDS, view.seed, CHOICE);
    assert.equal(laid.lower, sim.lower);
    assert.equal(laid.upper, sim.upper);
    assert.equal(laid.tickMs, ROUND_TICK_MS);
    assert.equal(laid.roundId, view.roundId);
    assert.ok(Number.isInteger(view.seed) && view.seed >= 0 && view.seed < 2 ** 32, "a uint32 seed, on the server");
    assert.equal(w.inbox(b).length, 0, "nobody else hears of it");

    const byAddr = await w.lay(b, POOLS[1].address);
    assert.deepEqual(byAddr.laid.pool, POOLS[1]);
    assert.notEqual(byAddr.laid.roundId, laid.roundId);

    for (const pool of ["<img src=x> / USDC", "TOK15 / USDC", "TOK2 / USDC"]) {
      w.advance(ERROR_GAP_MS);
      await w.send(c, { t: "lay", pool, ...CHOICE });
      assert.deepEqual(w.take(c), [{ t: "error", why: "unknown pool" }], `${pool}: a fixed reason, never the input`);
    }
    w.advance(ERROR_GAP_MS);
    await w.send(c, { t: "lay", pool: 42, ...CHOICE });
    await w.send(c, { t: "lay", ...CHOICE });
    assert.equal(w.take(c).length, 0, "no pool: ignored");
    assert.equal(w.core.roundOf(c), null);
    w.assertNoSeed();
  });

  await test("lay: the band passes validateChoice (a closeAt or claim sent with it is not read); one a second; an empty board says so", async () => {
    const w = world();
    const a = await w.join();
    w.take(a);
    for (const bad of [
      { widthBins: 2, offsetBins: 0 },
      { widthBins: 20, offsetBins: 11 },
      { widthBins: 20.5, offsetBins: 0 },
      { widthBins: "20", offsetBins: 0 },
      { offsetBins: 0 },
    ]) {
      w.advance(ERROR_GAP_MS);
      await w.send(a, { t: "lay", pool: CARDS.label, ...bad });
      assert.deepEqual(w.take(a), [{ t: "error", why: "bad choice" }], JSON.stringify(bad));
    }
    assert.equal(w.core.roundOf(a), null);
    const { laid, view } = await w.lay(a, CARDS.label, { ...CHOICE, closeAt: 3, seed: 1, pct: 99 });
    assert.notEqual(view.seed, 1, "the client does not pick the seed");
    w.run(5 * ROUND_TICK_MS);
    const out = w.take(a);
    assert.deepEqual(out.map((m) => m.t), ["tick", "tick", "tick", "tick", "tick"], "rides past tick 3, unsettled");
    await w.close(a, laid.roundId);
    const next = await w.lay(a);
    await w.send(a, { t: "lay", pool: CARDS.label, ...CHOICE });
    assert.deepEqual(w.take(a), [{ t: "slow" }], "a second lay inside the second");
    assert.equal(w.core.roundOf(a)?.roundId, next.laid.roundId);

    const dry = world({ pools: [] });
    const b = await dry.join();
    dry.take(b);
    dry.advance(1000);
    await dry.send(b, { t: "lay", pool: CARDS.label, ...CHOICE });
    assert.deepEqual(dry.take(b), [{ t: "error", why: "board unavailable" }]);
  });

  await test("ticks 1..TICKS go out in order, each when the server clock reaches start + i * ROUND_TICK_MS, values from the server's simulate(); TICKS settles by itself", async () => {
    const w = world();
    const [a, b] = [await w.join(), await w.join()];
    w.clear();
    const { laid, view, start } = await w.lay(a);
    const sim = simulate(CARDS, view.seed, CHOICE);
    const seen: { m: Of<"tick">; at: number }[] = [];
    const scored: { m: Of<"scored">; at: number; after: number }[] = [];
    while (!scored.length && w.now - start < ROUND_TTL_MS) {
      w.run(ROOM_TICK_MS);
      for (const m of w.take(a)) {
        if (m.t === "tick") seen.push({ m, at: w.now });
        else if (m.t === "scored") scored.push({ m, at: w.now, after: seen.length });
        else assert.equal(m.t, "board", `unexpected ${m.t}`);
      }
    }
    assert.deepEqual(seen.map((s) => s.m.i), Array.from({ length: TICKS }, (_, j) => j + 1), "1..TICKS, in order, once each");
    for (const { m, at } of seen) {
      const due = start + m.i * ROUND_TICK_MS;
      assert.ok(at >= due, `tick ${m.i} not before its time`);
      assert.ok(at - ROOM_TICK_MS < due, `tick ${m.i} on the first heartbeat after its time`);
      assert.equal(m.roundId, laid.roundId);
      assert.ok(Math.abs(m.p - sim.path[m.i]) <= 1e-6 * sim.path[m.i], `p at ${m.i}`);
      assert.ok(Math.abs(m.feesPct - sim.feesPct[m.i]) <= 1e-4);
      assert.ok(Math.abs(m.valuePct - sim.valuePct[m.i]) <= 1e-4);
      assert.ok(Math.abs(m.holdPct - sim.holdPct[m.i]) <= 1e-4);
      assert.equal(m.inRange, sim.inRange[m.i]);
    }
    assert.equal(scored.length, 1);
    assert.equal(scored[0].after, TICKS, "scored after the last tick");
    assert.equal(scored[0].at, seen[TICKS - 1].at, "on the same heartbeat");
    assert.equal(scored[0].m.roundId, laid.roundId);
    assert.equal(scored[0].m.pct, sim.scorePct);
    assert.equal(scored[0].m.pct, simulate(CARDS, view.seed, { ...CHOICE, closeAt: TICKS }).scorePct);
    assert.equal(w.core.roundOf(a), null, "settled");
    assert.deepEqual(w.take(b).map((m) => m.t), ["board"], "nobody else gets the ticks, only the new board");
    w.run(5000);
    assert.equal(w.take(a).length, 0, "nothing after");

    // a late heartbeat sends everything now due, in order
    const late = await w.lay(a);
    w.advance(2000);
    w.core.tick();
    assert.deepEqual(ofType(w.take(a), "tick").map((m) => m.i), [1, 2, 3, 4], "2 s late: ticks 1..4 at once");
    assert.equal(w.core.roundOf(a)?.sent, 4);
    void late;
    w.assertNoSeed();
  });

  await test("close settles at the last tick already sent: simulate() with that closeAt; a claimed score or closeAt is ignored; no ticks after", async () => {
    const w = world();
    const a = await w.join();
    w.take(a);
    const { laid, view, start } = await w.lay(a);
    while ((w.core.roundOf(a)?.sent ?? 0) < 10) w.run(ROOM_TICK_MS);
    assert.equal(w.core.roundOf(a)?.sent, 10);
    w.take(a);
    w.advance(start + 11 * ROUND_TICK_MS - w.now); // tick 11 is due, but no heartbeat has sent it
    const out = await w.close(a, laid.roundId, { pct: 999, closeAt: 40, scorePct: 999 });
    assert.deepEqual(out.map((m) => m.t), ["scored", "board"], "settled at once (a first score: a new board), tick 11 never sent");
    const scored = ofType(out, "scored")[0];
    assert.equal(scored.roundId, laid.roundId);
    assert.equal(scored.pct, simulate(CARDS, view.seed, { ...CHOICE, closeAt: 10 }).scorePct, "the replay at tick 10");
    assert.notEqual(scored.pct, 999);
    assert.equal(w.core.leaderboard()[0].pct, scored.pct);
    w.run(TICKS * ROUND_TICK_MS);
    assert.equal(w.take(a).length, 0, "no ticks after the close");
    w.advance(ERROR_GAP_MS);
    assert.deepEqual(await w.close(a, laid.roundId), [{ t: "error", why: "no such round" }], "settled once");
    w.assertNoSeed();
  });

  await test("close before the first tick settles at tick 1, sending tick 1 first", async () => {
    const w = world();
    const a = await w.join();
    w.take(a);
    const { laid, view } = await w.lay(a);
    const out = await w.close(a, laid.roundId);
    assert.deepEqual(out.map((m) => m.t), ["tick", "scored", "board"]);
    assert.equal(ofType(out, "tick")[0].i, 1);
    assert.equal(ofType(out, "scored")[0].pct, simulate(CARDS, view.seed, { ...CHOICE, closeAt: 1 }).scorePct);
    w.assertNoSeed();
  });

  await test("close: only the player's own open round", async () => {
    const w = world();
    const [a, b] = [await w.join(), await w.join()];
    w.clear();
    const { laid } = await w.lay(a);
    assert.deepEqual(await w.close(b, laid.roundId), [{ t: "error", why: "no such round" }], "not B's round");
    w.advance(ERROR_GAP_MS);
    assert.deepEqual(await w.close(a, "r-made-up"), [{ t: "error", why: "no such round" }]);
    assert.ok(w.core.roundOf(a), "A's round rides on");
    await w.send(a, { t: "close" });
    await w.send(a, { t: "close", roundId: 7 });
    assert.equal(w.take(a).length, 0, "malformed: ignored");
    assert.equal(ofType(await w.close(a, laid.roundId), "scored").length, 1);
  });

  await test("one open round per player, a lay waiting on the board included", async () => {
    let release: (p: PoolParams[]) => void = () => {};
    let slow = false;
    const w = world({ board: () => (slow ? new Promise<PoolParams[]>((r) => (release = r)) : Promise.resolve(POOLS)) });
    const a = await w.join();
    w.take(a);
    const first = await w.lay(a);
    w.advance(1000);
    await w.send(a, { t: "lay", pool: POOLS[1].label, ...CHOICE });
    assert.deepEqual(w.take(a), [{ t: "error", why: "round in play" }]);
    assert.equal(w.core.roundOf(a)?.roundId, first.laid.roundId, "the first round is untouched");
    await w.close(a, first.laid.roundId);
    const second = await w.lay(a, POOLS[1].label);
    assert.deepEqual(second.laid.pool, POOLS[1], "free again once settled");
    await w.close(a, second.laid.roundId);

    slow = true;
    w.advance(1000);
    const pending = w.send(a, { t: "lay", pool: CARDS.label, ...CHOICE });
    w.advance(ERROR_GAP_MS);
    await w.send(a, { t: "lay", pool: CARDS.label, ...CHOICE });
    assert.deepEqual(w.take(a), [{ t: "error", why: "round in play" }], "a lay already waiting on the board");
    release(POOLS);
    await pending;
    assert.equal(ofType(w.take(a), "laid").length, 1);
  });

  await test("leaving forfeits the round: nothing recorded, nothing broadcast, a lay in flight dropped", async () => {
    const w = world();
    const [a, b] = [await w.join(), await w.join()];
    w.clear();
    await w.lay(a);
    w.run(5 * ROUND_TICK_MS);
    w.core.leave(a);
    w.run(TICKS * ROUND_TICK_MS + 1000);
    assert.deepEqual(w.take(b), [{ t: "leave", id: a }], "only the leave");
    assert.deepEqual(w.core.leaderboard(), []);
    assert.deepEqual(w.saved, []);

    let release: (p: PoolParams[]) => void = () => {};
    const v = world({ board: () => new Promise<PoolParams[]>((r) => (release = r)) });
    const c = await v.join();
    v.take(c);
    v.advance(1000);
    const pending = v.send(c, { t: "lay", pool: CARDS.label, ...CHOICE });
    v.core.leave(c);
    release(POOLS);
    await pending;
    assert.equal(ofType(v.inbox(c), "laid").length, 0, "no round for a player who left");
    assert.equal(v.core.connections, 0);
  });

  await test("a round still open TICKS * ROUND_TICK_MS + 30 s after it was laid is dropped: 'round expired', no ticks, no score", async () => {
    const w = world();
    const a = await w.join();
    w.take(a);
    const { laid } = await w.lay(a);
    w.advance(ROUND_TTL_MS - 500);
    assert.deepEqual(await w.close(a, "r-made-up"), [{ t: "error", why: "no such round" }], "an error just before");
    w.advance(501); // the heartbeat stalled all this while
    w.core.tick();
    assert.deepEqual(w.take(a), [{ t: "error", why: "round expired" }], "told, even inside the error limit");
    assert.equal(w.core.roundOf(a), null);
    assert.deepEqual(w.core.leaderboard(), []);
    w.advance(ERROR_GAP_MS);
    assert.deepEqual(await w.close(a, laid.roundId), [{ t: "error", why: "no such round" }]);
    const again = await w.lay(a);
    assert.ok(again.laid.roundId !== laid.roundId, "free to lay again");
  });

  // ---------------------------------------------------------------- the leaderboard

  await test("leaderboard: each name's best, top 20 best first, rank of the score on the board (or null)", async () => {
    const w = world({ seed: 11 });
    const players: string[] = [];
    for (let i = 0; i < BOARD_ROWS + 6; i++) players.push(await w.join());
    const nameOf = new Map<string, string>();
    for (const id of players) nameOf.set(id, ofType(w.take(id), "welcome")[0].name);
    w.clear();
    const best = new Map<string, number>();
    let improvements = 0;
    let setbacks = 0;
    const bands: Choice[] = [CHOICE, { widthBins: 4, offsetBins: 1 }, { widthBins: 60, offsetBins: -20 }];
    const closes = [3, 17, TICKS, 30];
    for (let round = 0; round < 3; round++) {
      for (const [n, id] of players.entries()) {
        const band = bands[(round + n) % bands.length];
        const k = closes[(round * 7 + n) % closes.length];
        const { scored, view } = await w.playTo(id, k, band);
        const pct = simulate(CARDS, view.seed, { ...band, closeAt: k }).scorePct;
        assert.equal(scored.pct, pct, "the server's replay");
        const name = nameOf.get(id)!;
        const before = best.get(name);
        if (before === undefined || pct > before) {
          best.set(name, pct);
          improvements++;
        } else setbacks++;
        // rank: where THIS score sits on the board, null when it is not there (not a new best, or below the top 20)
        const board = w.core.leaderboard();
        const row = board.findIndex((r) => r.name === name && r.at === w.now);
        assert.equal(scored.rank, row >= 0 ? row + 1 : null);
        if (row >= 0) assert.equal(board[row].pct, pct);
        if (before !== undefined && pct <= before) assert.equal(scored.rank, null, "not a new best: no rank");
      }
    }
    assert.ok(improvements > 0 && setbacks > 0, "both a new best and a worse round were seen");
    const want = [...best.entries()].map(([name, pct]) => ({ name, pct })).sort((x, y) => y.pct - x.pct);
    const board = w.core.leaderboard();
    assert.equal(board.length, BOARD_ROWS);
    assert.equal(new Set(board.map((r) => r.name)).size, BOARD_ROWS, "one row per name");
    for (let i = 1; i < board.length; i++) assert.ok(board[i - 1].pct >= board[i].pct, "best first");
    assert.deepEqual(board.map((r) => r.pct), want.slice(0, BOARD_ROWS).map((r) => r.pct), "the top 20 bests");
    for (const r of board) {
      assert.equal(r.pct, best.get(r.name), `${r.name}'s best`);
      assert.equal(r.pool, CARDS.label);
    }
    assert.deepEqual(w.saved.at(-1), board, "persisted");
    w.assertNoSeed();
  });

  await test("board broadcast only when the top 20 changes, after the player's scored; a worse round changes nothing", async () => {
    const w = world({ seed: 5 });
    const [a, b] = [await w.join(), await w.join()];
    w.clear();
    const first = await w.lay(a);
    const out = await w.close(a, first.laid.roundId);
    assert.deepEqual(out.map((m) => m.t), ["tick", "scored", "board"], "scored first, then the board");
    const boards = ofType(w.take(b), "board");
    assert.equal(boards.length, 1, "the first score changes the board");
    assert.equal(boards[0].rows[0].pct, ofType(out, "scored")[0].pct);
    assert.equal(w.saved.length, 1);
    let worse = false;
    let better = false;
    for (let i = 0; i < 24 && !(worse && better); i++) {
      const top = w.core.leaderboard()[0].pct;
      const { scored } = await w.playTo(a, 1 + ((i * 5) % TICKS));
      const heard = ofType(w.take(b), "board");
      if (scored.pct <= top) {
        worse = true;
        assert.equal(scored.rank, null);
        assert.equal(heard.length, 0, "no board message");
        assert.equal(w.core.leaderboard()[0].pct, top, "the best stands");
      } else {
        better = true;
        assert.equal(scored.rank, 1);
        assert.equal(heard.length, 1);
        assert.equal(heard[0].rows[0].pct, scored.pct);
      }
    }
    assert.ok(worse && better, "both a worse and a better round came up");
  });

  await test("a stored leaderboard is loaded clean (bad rows dropped, best per name) and shown in welcome", async () => {
    const stored = [
      { name: "Brass Heron 42", pool: "CARDS / USDC", pct: 3.25, at: 1 },
      { name: "Brass Heron 42", pool: "CARDS / USDC", pct: 1.5, at: 2 },
      { name: "Quiet Owl 17", pool: "SILV / USDC", pct: 4.1, at: 3 },
      { name: "Bad Row", pool: "X", pct: "12", at: 4 },
      { name: 7, pool: "X", pct: 1, at: 4 },
      null,
    ];
    const clean = cleanBoard(stored);
    assert.deepEqual(clean.map((r) => [r.name, r.pct]), [["Quiet Owl 17", 4.1], ["Brass Heron 42", 3.25]]);
    const w = world({ leaderboard: stored });
    const a = await w.join();
    assert.deepEqual(ofType(w.take(a), "welcome")[0].board, clean);
    assert.deepEqual(cleanBoard("junk"), []);
  });

  // ---------------------------------------------------------------- leaving and junk

  await test("leave: the others hear it; a socket that never joined leaves quietly", async () => {
    const w = world();
    const [a, b] = [await w.join(), await w.join()];
    w.clear();
    w.core.leave(a);
    assert.deepEqual(w.take(b), [{ t: "leave", id: a }]);
    assert.deepEqual(w.core.ids(), [b]);
    const lurker = w.core.open()!;
    w.core.leave(lurker);
    assert.equal(w.all().length, 0);
    w.core.leave("nobody");
    w.core.leave(b);
    assert.equal(w.core.connections, 0);
  });

  await test("malformed frames are ignored: not JSON, not an object, no type, unknown type, binary, oversize, a flood", async () => {
    const w = world();
    const [a, b] = [await w.join(), await w.join()];
    w.clear();
    const retired = ['{"t":"round","pool":"CARDS / USDC"}', '{"t":"result","roundId":"r1","choice":{"widthBins":20,"offsetBins":0}}'];
    for (const junk of ["", "{", "null", "[]", '"hi"', "42", '{"x":1}', '{"t":7}', '{"t":"shout","text":"hi"}', '{"t":"hello","strap":1}', ...retired]) {
      await w.core.message(a, junk);
    }
    await w.core.message(a, new ArrayBuffer(8));
    await w.core.message(a, JSON.stringify({ t: "emote", e: "wave", pad: "x".repeat(5000) }));
    assert.equal(w.all().length, 0, "nothing sent to anyone");
    // flood: past MSG_BURST frames at one instant, even a good one is dropped
    w.advance(5000);
    for (let i = 0; i < MSG_BURST + 5; i++) await w.core.message(a, "{}");
    await w.send(a, { t: "emote", e: "cheer" });
    assert.equal(ofType(w.inbox(b), "emote").length, 0);
    assert.equal(ofType(w.take(a), "slow").length, 1);
  });

  await test("restore after a restart: back in the room without a broadcast, first move taken as the position", async () => {
    const w = world();
    const a = await w.join();
    w.clear();
    w.core.restore("zz0001", "Quiet Owl 17", 9);
    assert.equal(w.all().length, 0, "no join broadcast");
    assert.equal(w.pos("zz0001").name, "Quiet Owl 17");
    assert.equal(w.pos("zz0001").strap, STRAPS.length - 1);
    w.advance(100);
    await w.send("zz0001", { t: "move", x: 30, z: -10, ry: 0, moving: true });
    assert.deepEqual([w.pos("zz0001").x, w.pos("zz0001").z], [30, -10]);
    w.advance(100);
    await w.send("zz0001", { t: "move", x: -30, z: -10, ry: 0, moving: true });
    assert.equal(w.pos("zz0001").x, 30, "only the first move is trusted");
    w.core.restore("zz0002", "<b>hacker</b>", 0);
    assert.ok(isRoomName(w.pos("zz0002").name), "a bad stored name is replaced");
    void a;
  });

  // ---------------------------------------------------------------- the board source and the door

  await test("boardSource: first 12 usable rows in file order, cached 2 minutes, one fetch in flight, a failure keeps the last good copy", async () => {
    assert.equal(POOLS.length, BOARD_POOLS);
    assert.deepEqual(POOLS.slice(0, 3).map((p) => p.label), ["CARDS / USDC", "SILV / USDC", "TOK3 / USDC"], "the unusable row is skipped");
    assert.equal(CARDS.address, "2N1KNuLSt167P6p9P8HYcisTvTTv4vYTM8QJBbtv1xYU");
    assert.deepEqual(parseBoard(null), []);
    assert.deepEqual(parseBoard({ rows: "no" }), []);

    let t = 0;
    let loads = 0;
    let fail = false;
    const src = boardSource({
      now: () => t,
      load: async () => {
        loads++;
        if (fail) throw new Error("down");
        return HOT;
      },
    });
    const [x, y] = await Promise.all([src(), src()]);
    assert.equal(loads, 1, "concurrent callers share one fetch");
    assert.deepEqual(x, POOLS);
    assert.equal(x, y);
    t += BOARD_TTL_MS - 1;
    await src();
    assert.equal(loads, 1, "cached");
    t += 1;
    fail = true;
    assert.deepEqual(await src(), POOLS, "a failed refresh serves the last good copy");
    assert.equal(loads, 2);
    await src();
    assert.equal(loads, 2, "no retry inside the back-off");
    t += BOARD_RETRY_MS;
    fail = false;
    await src();
    assert.equal(loads, 3, "retried after the back-off");

    const cold = boardSource({ now: () => 0, load: async () => ({ rows: [] }) });
    assert.deepEqual(await cold(), [], "an empty board is empty");
  });

  // ---------------------------------------------------------------- rounds on a pool's real history

  const HR = 3600;
  const T0 = Date.parse("2026-09-16T00:00:00Z") / 1000;
  /** a pool's last 100 hours as GeckoTerminal sends them (newest first): a wavy price, a volume that cycles */
  const CANDLES = Array.from({ length: 100 }, (_, k) => {
    const c = 2 * (1 + 0.03 * Math.sin(k / 4) + 0.002 * k);
    return [T0 + k * HR, c, c, c, c, 1500 * (k % 7)];
  }).reverse();
  const LIVE = { ...CARDS, liquidityUsd: 250_000, feeRate: 0.002 };
  const sig7 = (v: number) => Number(v.toPrecision(7));

  await test("real history: a hidden 48-hour stretch is replayed, and named only with the score", async () => {
    const reads: string[] = [];
    const w = world({ pools: [LIVE], history: async (p) => (reads.push(p.address), CANDLES) });
    const id = await w.join();
    w.take(id);
    const { laid, view } = await w.lay(id, LIVE.label);
    assert.equal(laid.real, true);
    assert.deepEqual(reads, [LIVE.address]);
    assert.ok(view.from !== null, "the server knows its stretch");
    const series = hourlySeries(CANDLES);
    const start = (view.from! - HR - series[0].ts) / HR;
    assert.ok(Number.isInteger(start) && start >= 0 && start <= series.length - MARKET_HOURS, `start ${start}`);
    const market = marketWindow(series, start, LIVE)!;
    w.run(TICKS * ROUND_TICK_MS + ROOM_TICK_MS);
    const heard = w.take(id);
    const ticks = ofType(heard, "tick");
    assert.equal(ticks.length, TICKS);
    for (const k of ticks) assert.equal(k.p, sig7(market.path[k.i]), `tick ${k.i} is the pool's own hour`);
    const [scored] = ofType(heard, "scored");
    assert.equal(scored.from, view.from, "the stretch is named with the score");
    assert.equal(scored.pct, simulate(LIVE, view.seed, { ...CHOICE, closeAt: TICKS }, market).scorePct);
    assert.equal(scored.pct, simulate(LIVE, view.seed + 1, { ...CHOICE, closeAt: TICKS }, market).scorePct, "the seed plays no part");
    // before the score nothing on the wire says which hours they were
    const before = w.wire.slice(0, w.wire.findIndex((j) => j.includes('"scored"')));
    for (const j of before) assert.ok(!j.includes('"from"') && !j.includes(String(view.from)), `stretch leaked early: ${j}`);
    w.assertNoSeed();
  });

  await test("real history: a close settles on the stretch at the last hour sent (a History: quote prices, USD volume)", async () => {
    const usd = CANDLES.map((c) => [c[0], 150, 150, 150, 150, (c[5] as number) * 150]);
    const w = world({ pools: [LIVE], history: async () => ({ price: CANDLES, volume: usd }), seed: 11 });
    const id = await w.join();
    w.take(id);
    const { laid, view } = await w.lay(id, LIVE.label);
    w.advance(9 * ROUND_TICK_MS);
    w.core.tick();
    w.take(id);
    const [scored] = ofType(await w.close(id, laid.roundId), "scored");
    const series = hourlySeries(CANDLES, usd);
    assert.equal(series[10].volUsd, (CANDLES[CANDLES.length - 11][5] as number) * 150, "the volume is the USD read's");
    const market = marketWindow(series, (view.from! - HR - series[0].ts) / HR, LIVE)!;
    assert.equal(scored.pct, simulate(LIVE, view.seed, { ...CHOICE, closeAt: 9 }, market).scorePct);
    assert.equal(scored.from, view.from);
  });

  await test("real history: a stretch is dealt at random across the history", async () => {
    const starts = new Set<number>();
    for (let seed = 1; seed <= 12; seed++) {
      const w = world({ pools: [LIVE], history: async () => CANDLES, seed });
      const id = await w.join();
      const { view } = await w.lay(id, LIVE.label);
      starts.add(view.from!);
    }
    assert.ok(starts.size >= 8, `${starts.size} different stretches in 12 rounds`);
  });

  await test("real history: none to be had (no reader, unreadable, too short, no liquidity) plays simulated", async () => {
    const cases: [string, PoolParams, ((p: PoolParams) => Promise<unknown>) | undefined][] = [
      ["no reader", LIVE, undefined],
      ["null", LIVE, async () => null],
      ["throws", LIVE, async () => Promise.reject(new Error("429"))],
      ["30 hours", LIVE, async () => CANDLES.slice(0, 30)],
      ["no liquidity", { ...CARDS }, async () => CANDLES],
    ];
    for (const [why, pool, history] of cases) {
      const w = world({ pools: [pool], history });
      const id = await w.join();
      w.take(id);
      const { laid, view } = await w.lay(id, pool.label);
      assert.equal(laid.real, false, why);
      assert.equal(view.from, null, why);
      w.run(TICKS * ROUND_TICK_MS + ROOM_TICK_MS);
      const [scored] = ofType(w.take(id), "scored");
      assert.equal(scored.pct, simulate(pool, view.seed, { ...CHOICE, closeAt: TICKS }).scorePct, why);
      assert.ok(!("from" in scored), `${why}: nothing to name`);
    }
  });

  await test("real history: a second lay while it loads is refused; leaving while it loads lays nothing", async () => {
    let release: (v: unknown) => void = () => {};
    const w = world({ pools: [LIVE], history: () => new Promise((r) => (release = r)) });
    const id = await w.join();
    w.take(id);
    w.advance(1000);
    const first = w.send(id, { t: "lay", pool: LIVE.label, ...CHOICE });
    await new Promise((r) => setImmediate(r));
    w.advance(ERROR_GAP_MS + 1000);
    await w.send(id, { t: "lay", pool: LIVE.label, ...CHOICE });
    assert.deepEqual(ofType(w.take(id), "error").map((e) => e.why), ["round in play"]);
    release(CANDLES);
    await first;
    assert.equal(ofType(w.take(id), "laid").length, 1);

    const v = world({ pools: [LIVE], history: () => new Promise((r) => (release = r)) });
    const gone = await v.join();
    v.advance(1000);
    const lay = v.send(gone, { t: "lay", pool: LIVE.label, ...CHOICE });
    await new Promise((r) => setImmediate(r));
    v.core.leave(gone);
    release(CANDLES);
    await lay;
    assert.equal(ofType(v.inbox(gone), "laid").length, 0);
    assert.equal(v.core.roundOf(gone), null);
  });

  await test("historyFromFile: the desk's history.json entry for a pool as a History that plays real hours", async () => {
    const price = CANDLES.map((c) => [c[0], c[4]]).reverse();
    const volume = CANDLES.map((c) => [c[0], (c[5] as number) * 150]).reverse();
    const FILE = { generatedAt: "2026-09-24T16:00:00Z", pools: { [LIVE.address]: { at: 1, price, volume } } };
    const h = historyFromFile(FILE, LIVE.address)!;
    const series = hourlySeries(h.price, h.volume);
    assert.equal(series.length, 100);
    assert.equal(series[5].close, CANDLES[CANDLES.length - 6][4]);
    assert.equal(series[5].volUsd, (CANDLES[CANDLES.length - 6][5] as number) * 150);
    for (const [why, file, addr] of [
      ["not in it", FILE, "Other1111111111111111111111111111111"],
      ["no file", null, LIVE.address],
      ["no pools", { generatedAt: "x" }, LIVE.address],
      ["a prototype key", FILE, "__proto__"],
      ["junk rows", { pools: { [LIVE.address]: { price: [["x", 1]], volume: [[1]] } } }, LIVE.address],
    ] as [string, unknown, string][]) assert.equal(historyFromFile(file, addr), null, why);
    const w = world({ pools: [LIVE], history: async (p) => historyFromFile(FILE, p.address) });
    const id = await w.join();
    w.take(id);
    const { laid, view } = await w.lay(id, LIVE.label);
    assert.equal(laid.real, true);
    assert.ok(view.from !== null);
  });

  await test("historySource: held a while per pool, one read in flight, a failure backs off, the oldest goes first", async () => {
    let t = 0;
    const loads: string[] = [];
    let fail = false;
    const src = historySource({
      now: () => t,
      load: async (p) => {
        loads.push(p.address);
        if (fail) throw new Error("down");
        return p.address === "empty" ? [] : CANDLES;
      },
    });
    const A = { ...LIVE, address: "A" };
    const [x, y] = await Promise.all([src(A), src(A)]);
    assert.deepEqual(loads, ["A"], "concurrent callers share one read");
    assert.equal(x, CANDLES);
    assert.equal(y, CANDLES);
    t += HISTORY_TTL_MS - 1;
    await src(A);
    assert.equal(loads.length, 1, "held");
    t += 1;
    fail = true;
    assert.equal(await src(A), null, "a failed read answers null: the round plays simulated");
    assert.equal(loads.length, 2);
    await src(A);
    assert.equal(loads.length, 2, "no retry inside the back-off");
    t += HISTORY_RETRY_MS;
    fail = false;
    assert.equal(await src(A), CANDLES, "read again after the back-off");
    assert.equal(await src({ ...LIVE, address: "empty" }), null, "an empty history is none");
    // more pools than it keeps: the oldest read is dropped and read again when asked
    for (let i = 0; i < HISTORY_KEEP; i++) await src({ ...LIVE, address: `P${i}` });
    const n = loads.length;
    await src(A);
    assert.equal(loads.length, n + 1, "A was the oldest: dropped");
    await src({ ...LIVE, address: `P${HISTORY_KEEP - 1}` });
    assert.equal(loads.length, n + 1, "a recent one is still held");
  });

  await test("originAllowed: exact origins from the list only", () => {
    const list = "https://bands.finance,http://localhost:5173, http://localhost:4312";
    assert.equal(originAllowed("https://bands.finance", list), true);
    assert.equal(originAllowed("http://localhost:4312", list), true);
    assert.equal(originAllowed("https://bands.finance/", list), true);
    assert.equal(originAllowed("https://evil.bands.finance", list), false);
    assert.equal(originAllowed("https://bands.finance.evil.com", list), false);
    assert.equal(originAllowed("http://bands.finance", list), false);
    assert.equal(originAllowed(null, list), false);
    assert.equal(originAllowed("", list), false);
    assert.equal(originAllowed("https://bands.finance", ""), false);
  });

  console.log(`\ngame room: ${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
