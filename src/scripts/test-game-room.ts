/**
 * The Bands Exchange room (game-server/src/core.ts), on fakes: no Cloudflare, no network, a hand-wound clock and a
 * seeded random. Joining and generated names, the room cap and the keyless-hello bucket, move rate limits / disc clamp /
 * the speed budget, batched moves, the emote and phrase allow-lists, and the server-streamed round: a band laid only on
 * board pools, ticks sent in order as the server clock reaches them, a practice close settling at the last tick sent
 * (a simulate() replay, never the client's claim), a staked round committed at the lay (its stake, rake and hold fixed
 * there; a close, a leave or the expiry all settle it at the hold), practice recording nothing, one round at a time,
 * and never a seed on the wire. Rounds on a pool's real history: a hidden stretch replayed, named only with the score,
 * the simulated fallback, and the expected value of a staked round over every stretch. Then the best-per-name top 20,
 * the stack (accounts written once and only when changed), malformed input, the board and history sources and origins.
 *   npm run test:game-room
 */
import assert from "node:assert/strict";
import {
  BOARD_POOLS,
  BOARD_ROWS,
  BOARD_RETRY_MS,
  BOARD_TTL_MS,
  boardSource,
  BUDGET_CAP_M,
  dayOf,
  IP_WINDOW_MS,
  MIN_LIVE_HOURS,
  NEW_ACCOUNTS_PER_IP,
  clampToDisc,
  cleanBoard,
  CLOSE_FULL,
  CLOSE_NO_ACCOUNT,
  CLOSE_NO_HELLO,
  CLOSE_ELSEWHERE,
  INSERT_TRIES,
  KEYLESS_HELLO_BURST,
  KEYLESS_HELLO_RATE,
  memoryAccounts,
  PAY_GAP_MS,
  NOTE_EVERY_MS,
  NOTE_MIN,
  NOTE_SPOTS,
  NOTE_SPREAD,
  NOTES_ON_GROUND,
  ERROR_GAP_MS,
  HELLO_TIMEOUT_MS,
  LAY_GAP_MS,
  SOCIAL_GAP_MS,
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
  SPAWN_ARC,
  SPAWN_INNER,
  SPAWN_RADIUS,
  wrapAngle,
} from "../../game-server/src/core";
import type { Account, AccountStore, RoomDeps } from "../../game-server/src/core";
import {
  BAND,
  DESK_SPOT,
  EMOTES,
  HOLDS,
  JOBS,
  MAX_SPEED,
  MAX_STAKE,
  MIN_STAKE,
  MOVE_HZ,
  NOTE_REACH,
  NOTES_PER_DAY,
  PHRASES,
  RAKE_PCT,
  ROOM_CAP,
  ROUND_TICK_MS,
  ROUNDS_PER_DAY,
  START_STACK,
  STRAPS,
  WAGE,
  WORLD_RADIUS,
} from "../../web/src/game/protocol";
import type { S2C, ScoreRow } from "../../web/src/game/protocol";
import { FEES_CAP_PCT, hourlySeries, MARKET_HOURS, marketWindow, simulate, TICKS } from "../../web/src/game/lpGame";
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
/** the stall's cut of a stake, as the room takes it */
const rakeOf = (stake: number) => Math.ceil((stake * RAKE_PCT) / 100);
/** a store that counts its writes (put), for the tests that assert nothing was written */
function countingAccounts() {
  const store = memoryAccounts();
  const counted = { ...store, puts: 0, inserts: 0 };
  counted.put = (a: Account, keyHash?: string) => {
    counted.puts++;
    if (keyHash) counted.inserts++;
    store.put(a, keyHash);
  };
  return counted;
}

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
  opts: {
    pools?: PoolParams[];
    board?: () => Promise<PoolParams[]>;
    history?: (pool: PoolParams) => Promise<unknown>;
    leaderboard?: unknown;
    seed?: number;
    accounts?: AccountStore;
    notes?: boolean;
  } = {},
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
  const joined: { id: string; account: string }[] = [];
  const deps: RoomDeps = {
    send: (id, msg) => push(id, msg),
    broadcast: (msg, exceptId) => {
      for (const id of core.ids()) if (id !== exceptId) push(id, msg);
    },
    now: () => t,
    random: seeded(opts.seed ?? 7),
    board: opts.board ?? (async () => opts.pools ?? POOLS),
    ...(opts.history ? { history: opts.history } : {}),
    ...(opts.accounts ? { accounts: opts.accounts } : {}),
    notes: opts.notes ?? false,
    saveBoard: (rows) => saved.push(rows),
    close: (id, code, reason) => closed.push({ id, code, reason }),
    joined: (id, account) => joined.push({ id, account }),
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
    /** read and empty one inbox, leaving out the account updates ("me": the stack tests read them with takeAll) */
    take(id: string): S2C[] {
      const box = inbox.get(id) ?? [];
      inbox.set(id, []);
      return box.filter((m) => m.t !== "me");
    },
    /** read and empty one inbox, everything */
    takeAll(id: string): S2C[] {
      const box = inbox.get(id) ?? [];
      inbox.set(id, []);
      return box;
    },
    clear() {
      inbox.clear();
    },
    all: () => [...inbox.values()].flat(),
    send: (id: string, msg: unknown) => core.message(id, typeof msg === "string" ? msg : JSON.stringify(msg)),
    /** open a socket and say hello, a second after the last (the pace the keyless-hello bucket allows for good) */
    async join(hello: Record<string, unknown> = { strap: 0 }): Promise<string> {
      w.advance(1000);
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
    /** walk in legal steps (a sprint at MOVE_HZ: 0.75 m a move) to (x, z) */
    async walk(id: string, x: number, z: number) {
      const stride = (MAX_SPEED / MOVE_HZ) * 0.95;
      for (let i = 0; i < 400; i++) {
        const p = w.pos(id);
        const d = Math.hypot(x - p.x, z - p.z);
        if (d < 0.01) return;
        const k = Math.min(1, stride / d);
        w.advance(1000 / MOVE_HZ);
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
    /**
     * lay (with a stake and a hold when given), let ticks 1..k go out in one late heartbeat, close: the scored message.
     * A practice round settles at k (or at TICKS by itself); a staked one at its hold, whatever k
     */
    async playTo(id: string, k: number, band: Choice = CHOICE, stake = 0, hold: number = TICKS) {
      const { laid, view } = await w.lay(id, CARDS.label, stake > 0 ? { ...band, stake, hold } : band);
      const end = stake > 0 ? hold : TICKS;
      const sent = Math.min(k, end);
      w.advance(k * ROUND_TICK_MS);
      core.tick();
      const heard = w.take(id);
      assert.deepEqual(ofType(heard, "tick").map((m) => m.i), Array.from({ length: sent }, (_, j) => j + 1));
      // at the end the round settles on that heartbeat; before it, the close settles it
      const scored = ofType(sent >= end ? heard : await w.close(id, laid.roundId), "scored");
      assert.equal(scored.length, 1, "scored");
      assert.equal(scored[0].at, stake > 0 ? hold : sent, "settled where it should");
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

  /* ---------- a pool's history, for the rounds that replay real hours (and the stakes that ride them) ---------- */
  const HR = 3600;
  const T0 = Date.parse("2026-09-16T00:00:00Z") / 1000;
  /** a pool's last 100 hours as GeckoTerminal sends them (newest first): a wavy price, a volume that cycles */
  const CANDLES = Array.from({ length: 100 }, (_, k) => {
    const c = 2 * (1 + 0.03 * Math.sin(k / 4) + 0.002 * k);
    return [T0 + k * HR, c, c, c, c, 1500 * (k % 7)];
  }).reverse();
  const LIVE = { ...CARDS, liquidityUsd: 250_000, feeRate: 0.002 };
  const sig7 = (v: number) => Number(v.toPrecision(7));

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
    // arrivals come in south of the fountain facing it, clear of the stalls, benches and stacks
    for (let seed = 1; seed <= 40; seed++) {
      const v = world({ seed });
      const p = v.pos(await v.join());
      const r = Math.hypot(p.x, p.z);
      assert.ok(r >= SPAWN_INNER - 0.01 && r <= SPAWN_RADIUS + 0.01, `r ${r}`);
      assert.ok(Math.abs(Math.atan2(p.x, p.z)) <= SPAWN_ARC + 0.01, `south: ${p.x}, ${p.z}`);
      assert.ok(Math.abs(wrapAngle(p.ry - Math.atan2(-p.x, -p.z))) < 0.01, "facing the centre");
      for (const [bx, bz] of [[-11, 12], [11, 13], [-13.5, 4.5], [-12.8, 5.8], [13.5, 6.5]]) assert.ok(Math.hypot(p.x - bx, p.z - bz) > 2.5, "clear of benches and stacks");
    }
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

  await test("a jump past the distance budget is refused and the player snapped back; a step within it lands", async () => {
    const w = world();
    const a = await w.join();
    const b = await w.join();
    w.clear();
    const start = w.pos(a);
    w.advance(100); // the budget is full (BUDGET_CAP_M = 5.5 m): 7 m is a jump however long the idle
    await w.send(a, { t: "move", x: start.x + 7, z: start.z, ry: 1, moving: true });
    assert.deepEqual(w.pos(a), start, "position kept");
    assert.deepEqual(ofType(w.take(a), "moves")[0].m, [[a, start.x, start.z, start.ry, 0]], "snapped back");
    w.core.tick();
    assert.equal(w.all().length, 0, "the refused move never went out");
    await w.send(a, { t: "move", x: start.x + 1.5, z: start.z, ry: 1, moving: true });
    assert.ok(Math.abs(w.pos(a).x - (start.x + 1.5)) < 0.011, "a legal step still lands");
    // a long idle does not buy a teleport: the budget never holds more than its cap
    w.advance(60_000);
    const here = w.pos(a);
    await w.send(a, { t: "move", x: here.x - 30, z: here.z, ry: 0, moving: true });
    assert.deepEqual(w.pos(a), here);
    await w.send(a, { t: "move", x: here.x - BUDGET_CAP_M - 0.1, z: here.z, ry: 0, moving: true });
    assert.deepEqual(w.pos(a), here, "a step just past the cap is a jump too");
    // a sprint at MOVE_HZ lands: MAX_SPEED metres in a second, a move at a time
    for (let i = 1; i <= MOVE_HZ; i++) {
      w.advance(1000 / MOVE_HZ);
      await w.send(a, { t: "move", x: here.x - (MAX_SPEED * i) / MOVE_HZ, z: here.z, ry: 0, moving: true });
    }
    assert.ok(Math.abs(w.pos(a).x - (here.x - MAX_SPEED)) < 0.011, "a sprint within MAX_SPEED lands");
    assert.equal(ofType(w.take(a), "moves").length, 2, "a snap-back for each jump, none for the sprint");
    void b;
  });

  await test("the speed budget: 2 s of 12 Hz moves cover at most MAX_SPEED * 2 + BUDGET_CAP_M metres, however they are sized", async () => {
    assert.equal(BUDGET_CAP_M, MAX_SPEED * 0.5 + 1);
    const w = world();
    const a = await w.join();
    w.clear();
    const start = w.pos(a);
    // a greedy client that knows the rule: each move asks for what the budget allows (a centimetre under, since the
    // position it reads back is rounded), and every sixth one for double
    let budget = BUDGET_CAP_M;
    let refused = 0;
    for (let i = 1; i <= 2 * MOVE_HZ; i++) {
      w.advance(1000 / MOVE_HZ);
      budget = Math.min(BUDGET_CAP_M, budget + MAX_SPEED / MOVE_HZ);
      const x = w.pos(a).x;
      const step = i % 6 === 0 ? budget * 2 : budget - 0.02;
      await w.send(a, { t: "move", x: x - step, z: start.z, ry: 0, moving: true });
      if (Math.abs(w.pos(a).x - (x - step)) < 0.011) budget -= step + 0.01;
      else refused++;
    }
    const covered = start.x - w.pos(a).x;
    assert.ok(covered <= MAX_SPEED * 2 + BUDGET_CAP_M + 1e-6, `covered ${covered} m in 2 s`);
    assert.ok(covered > MAX_SPEED * 2 * 0.8, `a sprint still moves: ${covered} m`);
    assert.equal(refused, 4, "the oversize moves were refused");
    assert.equal(ofType(w.take(a), "moves").length, refused, "each with a snap-back");
    // the old per-move slack let 12 Hz moves of 1.75 m through: 21 m/s
    const before = w.pos(a).x;
    for (let i = 0; i < MOVE_HZ; i++) {
      w.advance(1000 / MOVE_HZ);
      await w.send(a, { t: "move", x: w.pos(a).x - 1.75, z: start.z, ry: 0, moving: true });
    }
    assert.ok(before - w.pos(a).x < MAX_SPEED + BUDGET_CAP_M, `1.75 m a move for a second covered ${before - w.pos(a).x} m`);
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
    assert.deepEqual(w.take(a).filter((m) => m.t === "emote" || m.t === "say"), [], "no echo to the sender");
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
        else assert.ok(m.t === "board" || m.t === "me", `unexpected ${m.t}`);
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
    assert.equal(scored[0].m.at, TICKS);
    assert.deepEqual(w.take(b), [], "nobody else hears of it: a practice round goes on no board");
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

  await test("a practice close settles at the last tick already sent: simulate() with that closeAt; a claimed score or closeAt is ignored; no ticks after", async () => {
    const w = world();
    const a = await w.join();
    w.take(a);
    const { laid, view, start } = await w.lay(a);
    while ((w.core.roundOf(a)?.sent ?? 0) < 10) w.run(ROOM_TICK_MS);
    assert.equal(w.core.roundOf(a)?.sent, 10);
    w.take(a);
    w.advance(start + 11 * ROUND_TICK_MS - w.now); // tick 11 is due, but no heartbeat has sent it
    const out = await w.close(a, laid.roundId, { pct: 999, closeAt: 40, scorePct: 999 });
    assert.deepEqual(out.map((m) => m.t), ["scored"], "settled at once, tick 11 never sent, no board (practice)");
    const scored = ofType(out, "scored")[0];
    assert.equal(scored.roundId, laid.roundId);
    assert.equal(scored.at, 10);
    assert.equal(scored.pct, simulate(CARDS, view.seed, { ...CHOICE, closeAt: 10 }).scorePct, "the replay at tick 10");
    assert.notEqual(scored.pct, 999);
    assert.equal(scored.rank, null);
    assert.deepEqual(w.core.leaderboard(), [], "a practice round is not recorded");
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
    assert.deepEqual(out.map((m) => m.t), ["tick", "scored"]);
    assert.equal(ofType(out, "tick")[0].i, 1);
    assert.equal(ofType(out, "scored")[0].at, 1);
    assert.equal(ofType(out, "scored")[0].pct, simulate(CARDS, view.seed, { ...CHOICE, closeAt: 1 }).scorePct);
    w.assertNoSeed();
  });

  await test("a staked round settles at its hold and not before: a close skips to the end (the ticks left arrive at once, scored.at = hold)", async () => {
    const w = world();
    const a = await w.join();
    w.take(a);
    for (const hold of HOLDS) {
      const { laid, view } = await w.lay(a, CARDS.label, { ...CHOICE, stake: MIN_STAKE, hold });
      assert.equal(laid.hold, hold);
      assert.equal(laid.stake, MIN_STAKE);
      assert.equal(laid.rake, rakeOf(MIN_STAKE));
      assert.equal(view.hold, hold);
      // the heartbeat: ticks up to the hold, then the settle on the hold's own heartbeat, never before
      const seen: number[] = [];
      let scored: Of<"scored"> | null = null;
      while (!scored && seen.length < TICKS + 1) {
        w.run(ROOM_TICK_MS);
        for (const m of w.take(a)) {
          if (m.t === "tick") seen.push(m.i);
          else if (m.t === "scored") scored = m;
        }
        if (seen.length < hold) assert.equal(scored, null, `hold ${hold}: not settled at hour ${seen.length}`);
      }
      assert.deepEqual(seen, Array.from({ length: hold }, (_, j) => j + 1), `hold ${hold}: ticks 1..hold only`);
      assert.equal(scored!.at, hold);
      assert.equal(scored!.pct, simulate(CARDS, view.seed, { ...CHOICE, closeAt: hold }).scorePct);
      w.run(TICKS * ROUND_TICK_MS);
      assert.equal(w.take(a).length, 0, "nothing after the hold");
    }
    // a close: the rest of the ticks at once, then the score at the hold (a claimed closeAt is not read)
    const { laid, view } = await w.lay(a, CARDS.label, { ...CHOICE, stake: 200, hold: 24 });
    w.run(5 * ROUND_TICK_MS);
    assert.deepEqual(ofType(w.take(a), "tick").map((m) => m.i), [1, 2, 3, 4, 5]);
    const out = await w.close(a, laid.roundId, { closeAt: 5 });
    assert.deepEqual(ofType(out, "tick").map((m) => m.i), Array.from({ length: 19 }, (_, j) => j + 6), "ticks 6..24 at once");
    const [scored] = ofType(out, "scored");
    assert.equal(scored.at, 24);
    assert.equal(scored.pct, simulate(CARDS, view.seed, { ...CHOICE, closeAt: 24 }).scorePct, "scored at the hold, not the close");
    assert.equal(scored.stake, 200);
    const at24 = simulate(CARDS, view.seed, { ...CHOICE, closeAt: 24 });
    assert.equal(scored.back, Math.round((200 * (100 + at24.valuePct[24] + at24.feesPct[24] - at24.holdPct[24])) / 100));
    assert.equal(w.core.roundOf(a), null);
    // a hold off the list, or on a practice round, is refused / ignored
    w.advance(ERROR_GAP_MS + LAY_GAP_MS);
    for (const hold of [6, 47, 0, "24", null]) {
      await w.send(a, { t: "lay", pool: CARDS.label, ...CHOICE, stake: MIN_STAKE, hold });
      assert.deepEqual(ofType(w.take(a), "error").map((e) => e.why), ["bad choice"], `hold ${String(hold)}`);
      assert.equal(w.core.roundOf(a), null);
      w.advance(ERROR_GAP_MS + LAY_GAP_MS);
    }
    const practice = await w.lay(a, CARDS.label, { ...CHOICE, hold: 12 });
    assert.equal(practice.laid.hold, undefined);
    assert.equal(practice.view.hold, TICKS, "practice rides to TICKS, whatever hold it sent");
    w.run(13 * ROUND_TICK_MS);
    assert.ok(w.core.roundOf(a), "still open past hour 12");
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

  await test("leaving settles a staked round at its hold: the score recorded, the stake's worth there paid back; a lay in flight dropped", async () => {
    const store = memoryAccounts();
    const w = world({ accounts: store });
    const [a, b] = [await w.join(), await w.join()];
    w.clear();
    const { view } = await w.lay(a, CARDS.label, { ...CHOICE, stake: 500, hold: 24 });
    w.run(5 * ROUND_TICK_MS);
    w.core.leave(a);
    w.run(TICKS * ROUND_TICK_MS + 1000);
    const heard = w.take(b);
    assert.deepEqual(heard.map((m) => m.t), ["stack", "stacks", "stack", "stacks", "board", "leave"], "the stake out, the stake back (each moving the stacks board), the score, the leave");
    const res = simulate(CARDS, view.seed, { ...CHOICE, closeAt: 24 });
    const name = w.core.leaderboard()[0].name;
    assert.equal(w.core.leaderboard()[0].pct, res.scorePct, "scored at the hold, not at hour 5");
    const back = Math.round((500 * (100 + res.valuePct[24] + res.feesPct[24] - res.holdPct[24])) / 100);
    const acct = store.all().find((x) => x.name === name)!;
    assert.equal(acct.stack, START_STACK - 500 - rakeOf(500) + back);
    assert.equal(acct.staked, 0);
    assert.equal(ofType(heard, "stack").at(-1)!.stack, acct.stack);
    // a practice round left open settles quietly and records nothing
    const learner = await w.join();
    w.clear();
    await w.lay(learner, CARDS.label);
    w.run(5 * ROUND_TICK_MS);
    const rows = w.core.leaderboard();
    w.core.leave(learner);
    assert.deepEqual(w.take(b).map((m) => m.t), ["leave"]);
    assert.deepEqual(w.core.leaderboard(), rows);

    let release: (p: PoolParams[]) => void = () => {};
    const v = world({ board: () => new Promise<PoolParams[]>((r) => (release = r)) });
    const c = await v.join();
    v.take(c);
    v.advance(1000);
    const pending = v.send(c, { t: "lay", pool: CARDS.label, ...CHOICE, stake: 300 });
    v.core.leave(c);
    release(POOLS);
    await pending;
    assert.equal(ofType(v.inbox(c), "laid").length, 0, "no round for a player who left");
    assert.equal(v.core.connections, 0);
  });

  await test("a round whose heartbeat stalls past TICKS * ROUND_TICK_MS + 30 s settles: a staked one at its hold, practice at the last hour sent", async () => {
    const w = world();
    const a = await w.join();
    w.take(a);
    const { laid, view } = await w.lay(a, CARDS.label, { ...CHOICE, stake: 400, hold: 12 });
    w.advance(ROUND_TTL_MS - 500);
    assert.deepEqual(await w.close(a, "r-made-up"), [{ t: "error", why: "no such round" }], "an error just before");
    w.advance(501); // the heartbeat stalled all this while
    w.core.tick();
    const heard = w.take(a);
    assert.deepEqual(ofType(heard, "tick").map((m) => m.i), Array.from({ length: 12 }, (_, j) => j + 1), "the hours up to the hold, at once");
    const [scored] = ofType(heard, "scored");
    const res = simulate(CARDS, view.seed, { ...CHOICE, closeAt: 12 });
    assert.equal(scored.at, 12);
    assert.equal(scored.pct, res.scorePct);
    assert.equal(scored.stake, 400);
    assert.equal(scored.back, Math.round((400 * (100 + res.valuePct[12] + res.feesPct[12] - res.holdPct[12])) / 100));
    assert.equal(w.core.roundOf(a), null);
    assert.equal(w.core.meOf(a)!.staked, 0, "the stake is never stranded");
    assert.equal(w.core.meOf(a)!.stack, START_STACK - 400 - rakeOf(400) + scored.back!);
    w.advance(ERROR_GAP_MS);
    assert.deepEqual(await w.close(a, laid.roundId), [{ t: "error", why: "no such round" }]);
    const again = await w.lay(a);
    assert.ok(again.laid.roundId !== laid.roundId, "free to lay again");
    w.advance(ROUND_TTL_MS + 1);
    w.core.tick();
    const [practice] = ofType(w.take(a), "scored");
    assert.equal(practice.at, 1, "practice: the last hour sent (tick 1)");
    assert.equal(practice.pct, simulate(CARDS, again.view.seed, { ...CHOICE, closeAt: 1 }).scorePct);
  });

  // ---------------------------------------------------------------- the leaderboard

  await test("leaderboard: each name's best staked round, top 20 best first, rank of the score on the board (or null)", async () => {
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
    const holds = [12, 24, TICKS, 24];
    const closes = [3, 17, TICKS, 30];
    for (let round = 0; round < 3; round++) {
      for (const [n, id] of players.entries()) {
        const band = bands[(round + n) % bands.length];
        const hold = holds[(round * 5 + n) % holds.length];
        const k = closes[(round * 7 + n) % closes.length];
        const { scored, view } = await w.playTo(id, k, band, MIN_STAKE, hold);
        const pct = simulate(CARDS, view.seed, { ...band, closeAt: hold }).scorePct;
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
    const first = await w.lay(a, CARDS.label, { ...CHOICE, stake: MIN_STAKE, hold: 12 });
    const out = (await w.close(a, first.laid.roundId)).filter((m) => m.t !== "stack" && m.t !== "stacks");
    assert.deepEqual(out.map((m) => m.t), [...Array.from({ length: 12 }, () => "tick"), "scored", "board"], "the hours to the hold, scored, then the board");
    const boards = ofType(w.take(b), "board");
    assert.equal(boards.length, 1, "the first score changes the board");
    assert.equal(boards[0].rows[0].pct, ofType(out, "scored")[0].pct);
    assert.equal(w.saved.length, 1);
    let worse = false;
    let better = false;
    for (let i = 0; i < ROUNDS_PER_DAY - 1 && !(worse && better); i++) {
      const top = w.core.leaderboard()[0].pct;
      const { scored } = await w.playTo(a, 1 + ((i * 5) % 12), CHOICE, MIN_STAKE, 12);
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

  await test("restore after a restart: back in the room by account, without a broadcast, first move trusted, a lost round's stake refunded", async () => {
    const store = memoryAccounts();
    const before = world({ accounts: store });
    const a = await before.join({ strap: 4 });
    await before.lay(a, CARDS.label, { ...CHOICE, stake: 600 });
    const acct = store.all()[0];
    assert.equal(acct.staked, 600, "the stake is on the account while the round runs");
    // the object restarts: a new core on the same store, the socket still open (its own seed: ids come from the random)
    const w = world({ accounts: store, seed: 99 });
    const b = await w.join();
    w.clear();
    assert.equal(w.core.restore("zz0001", acct.id), true);
    assert.equal(w.all().length, 0, "no join broadcast");
    assert.equal(w.pos("zz0001").name, acct.name);
    assert.equal(w.pos("zz0001").strap, 4);
    assert.equal(w.core.meOf("zz0001")!.stack, START_STACK - rakeOf(600), "the lost round's stake came back; the rake did not");
    assert.equal(w.core.meOf("zz0001")!.staked, 0);
    assert.equal(w.core.restore("zz0003", acct.id), false, "one session per account: a second socket naming it is refused");
    assert.equal(w.core.player("zz0003"), null);
    assert.equal(w.core.restore("zz0001", acct.id), true, "the one already back stays");
    w.advance(100);
    await w.send("zz0001", { t: "move", x: 30, z: -10, ry: 0, moving: true });
    assert.deepEqual([w.pos("zz0001").x, w.pos("zz0001").z], [30, -10]);
    w.advance(100);
    await w.send("zz0001", { t: "move", x: -30, z: -10, ry: 0, moving: true });
    assert.equal(w.pos("zz0001").x, 30, "only the first move is trusted");
    assert.equal(w.core.restore("zz0002", "a-made-up-account"), false, "an unknown account is not restored (the host closes the socket)");
    assert.equal(w.core.player("zz0002"), null);
    void b;
  });

  // ---------------------------------------------------------------- the stack

  await test("accounts: a new visitor gets a key and a $1,000 stack; the key opens the same account again; a bad key starts afresh", async () => {
    const store = memoryAccounts();
    const w = world({ accounts: store });
    const a = await w.join({ strap: 2 });
    const [wel] = ofType(w.take(a), "welcome");
    assert.ok(wel.key && /^[A-Za-z0-9_-]{32}$/.test(wel.key), "a key for the browser to keep");
    assert.equal(wel.me.stack, START_STACK);
    assert.equal(wel.me.day, "2026-09-24");
    assert.deepEqual(wel.me.jobs.map((j) => j.id), JOBS.map((j) => j.id));
    assert.equal(wel.players.find((p) => p.id === a)!.stack, START_STACK, "stacks ride on the players");
    assert.equal(store.all().length, 1);
    assert.ok(!JSON.stringify(store.all()).includes(wel.key!), "the key itself is not stored");
    w.core.leave(a);
    // back later, with the key: the same name and stack, no new key
    const b = await w.join({ strap: 5, key: wel.key });
    const [back] = ofType(w.take(b), "welcome");
    assert.equal(back.name, wel.name);
    assert.equal(back.key, undefined);
    assert.equal(w.pos(b).strap, 5, "the strap is the one picked today");
    assert.equal(store.all().length, 1);
    for (const key of ["short", "x".repeat(80), "not base64url!".padEnd(30, "!"), "A".repeat(32)]) {
      const c = await w.join({ key });
      const [fresh] = ofType(w.take(c), "welcome");
      assert.ok(fresh.key && fresh.name !== wel.name, `${key.slice(0, 12)}: a new account`);
    }
  });

  await test("one session per account: the older tab is told 'elsewhere' and closed, its round settled", async () => {
    const w = world();
    const a = await w.join();
    const key = ofType(w.take(a), "welcome")[0].key!;
    await w.lay(a, CARDS.label, { ...CHOICE, stake: 200 });
    w.run(3 * ROUND_TICK_MS);
    const b = await w.join({ key });
    assert.ok(w.inbox(a).some((m) => m.t === "elsewhere"));
    assert.deepEqual(w.closed.at(-1), { id: a, code: CLOSE_ELSEWHERE, reason: "elsewhere" });
    assert.equal(w.core.player(a), null);
    const [wel] = ofType(w.take(b), "welcome");
    assert.equal(wel.me.staked, 0, "the round was settled, not stranded");
    assert.notEqual(wel.me.stack, START_STACK - 200, "the stake's worth came back");
  });

  await test("stakes: MIN_STAKE..MAX_STAKE whole dollars with the rake in the stack; taken at the lay, paid back at the hold as value + fees", async () => {
    const w = world();
    const a = await w.join();
    w.take(a);
    assert.equal(MAX_STAKE, BAND);
    assert.equal(rakeOf(MIN_STAKE), 2);
    assert.equal(rakeOf(150), 3, "the rake rounds up");
    for (const stake of [MIN_STAKE - 1, MAX_STAKE + 1, 150.5, -100, "500", null, START_STACK]) {
      w.advance(ERROR_GAP_MS + LAY_GAP_MS);
      await w.send(a, { t: "lay", pool: CARDS.label, ...CHOICE, stake });
      assert.deepEqual(ofType(w.take(a), "error").map((e) => e.why), ["bad stake"], `stake ${String(stake)}`);
    }
    assert.equal(w.core.roundOf(a), null);
    const { laid, view } = await w.lay(a, CARDS.label, { ...CHOICE, stake: 400 });
    assert.equal(view.stake, 400);
    assert.equal(view.rake, 8);
    assert.equal(view.hold, TICKS, "no hold sent: the whole round");
    assert.deepEqual([laid.stake, laid.rake, laid.hold], [400, 8, TICKS]);
    assert.equal(w.core.meOf(a)!.stack, START_STACK - 408, "the stake and the rake, taken at the lay");
    assert.equal(w.core.meOf(a)!.staked, 400, "only the stake is in play");
    assert.equal(w.core.meOf(a)!.rounds, 1);
    w.advance(7 * ROUND_TICK_MS);
    w.core.tick();
    w.take(a);
    const [scored] = ofType(await w.close(a, laid.roundId), "scored");
    const res = simulate(CARDS, view.seed, { ...CHOICE, closeAt: TICKS });
    const back = Math.round((400 * (100 + res.valuePct[TICKS] + res.feesPct[TICKS] - res.holdPct[TICKS])) / 100);
    assert.equal(scored.at, TICKS, "a close on a staked round skips to its hold");
    assert.equal(scored.stake, 400);
    assert.equal(scored.back, back);
    assert.equal(w.core.meOf(a)!.stack, START_STACK - 408 + back);
    assert.equal(w.core.meOf(a)!.staked, 0);
    // a practice round leaves the stack alone and is not counted
    const before = w.core.meOf(a)!.stack;
    await w.playTo(a, TICKS);
    assert.equal(w.core.meOf(a)!.stack, before);
    assert.equal(w.core.meOf(a)!.rounds, 1);
  });

  await test("stake + rake must fit the stack; a stake past MAX_STAKE is refused even when the stack holds it", async () => {
    const w = world();
    const a = await w.join();
    w.take(a);
    // $1,000 in hand: all of it is one band, but a band's rake ($20) does not fit; $980 does (rake 20, exactly the stack)
    w.advance(ERROR_GAP_MS + LAY_GAP_MS);
    await w.send(a, { t: "lay", pool: CARDS.label, ...CHOICE, stake: 1000 });
    assert.deepEqual(ofType(w.take(a), "error").map((e) => e.why), ["bad stake"]);
    const { laid, view } = await w.lay(a, CARDS.label, { ...CHOICE, stake: 980, hold: 12 });
    assert.equal(view.rake, 20);
    assert.equal(w.core.meOf(a)!.stack, 0);
    await w.close(a, laid.roundId);
    // paid up to more than a band: a band stakes, a dollar more does not
    await w.walk(a, DESK_SPOT.x, DESK_SPOT.z);
    await w.send(a, { t: "pay" });
    w.take(a);
    let stack = w.core.meOf(a)!.stack;
    while (stack < MAX_STAKE + 1 + rakeOf(MAX_STAKE + 1)) {
      w.advance(24 * 3_600_000);
      await w.send(a, { t: "pay" });
      w.take(a);
      stack = w.core.meOf(a)!.stack;
    }
    w.advance(ERROR_GAP_MS + LAY_GAP_MS);
    await w.send(a, { t: "lay", pool: CARDS.label, ...CHOICE, stake: MAX_STAKE + 1, hold: 12 });
    assert.deepEqual(ofType(w.take(a), "error").map((e) => e.why), ["bad stake"], "over MAX_STAKE");
    assert.equal(w.core.roundOf(a), null);
    const band = await w.lay(a, CARDS.label, { ...CHOICE, stake: MAX_STAKE, hold: 12 });
    assert.equal(band.view.stake, MAX_STAKE);
    assert.equal(w.core.meOf(a)!.stack, stack - MAX_STAKE - rakeOf(MAX_STAKE));
  });

  await test("the rake is taken at the lay and never returned: a break-even round leaves the stack a rake short", async () => {
    // a flat stretch with a dollar of volume an hour (live enough to deal, fees too small to show): the position is
    // worth exactly what was staked at every hour, and holding the same
    const flat = Array.from({ length: 60 }, (_, k) => [T0 + k * HR, 2, 2, 2, 2, 1]).reverse();
    const store = countingAccounts();
    const w = world({ pools: [LIVE], history: async () => flat, accounts: store });
    const a = await w.join();
    w.take(a);
    const { laid, view } = await w.lay(a, LIVE.label, { ...CHOICE, stake: 500, hold: 12 });
    assert.equal(laid.real, true);
    assert.equal(w.core.meOf(a)!.stack, START_STACK - 510);
    const [scored] = ofType(await w.close(a, laid.roundId), "scored");
    assert.equal(scored.back, 500, "worth 100% of the stake: the stake comes back");
    assert.equal(scored.pct, 0);
    assert.equal(w.core.meOf(a)!.stack, START_STACK - rakeOf(500), "the rake stays with the stall");
    assert.equal(store.byId(w.joined[0].account)!.stack, START_STACK - 10, "and so it is stored");
    // a restart between the lay and the settle refunds the stake, not the rake
    await w.lay(a, LIVE.label, { ...CHOICE, stake: 300, hold: 12 });
    const v = world({ accounts: store, pools: [LIVE], history: async () => flat, seed: 3 });
    assert.equal(v.core.restore("s1", w.joined[0].account), true);
    assert.equal(v.core.meOf("s1")!.stack, START_STACK - 10 - 6);
    void view;
  });

  await test("ROUNDS_PER_DAY staked rounds a day, practice unlimited; a new UTC day starts the count again", async () => {
    const w = world();
    const a = await w.join();
    w.take(a);
    for (let i = 0; i < ROUNDS_PER_DAY; i++) {
      const { laid } = await w.lay(a, CARDS.label, { widthBins: 120, offsetBins: 0, stake: MIN_STAKE, hold: 12 });
      w.advance(ROUND_TICK_MS);
      w.core.tick();
      await w.close(a, laid.roundId);
      if (w.core.meOf(a)!.stack < MIN_STAKE + rakeOf(MIN_STAKE)) break;
    }
    assert.equal(w.core.meOf(a)!.rounds, ROUNDS_PER_DAY);
    w.advance(ERROR_GAP_MS + LAY_GAP_MS);
    await w.send(a, { t: "lay", pool: CARDS.label, ...CHOICE, stake: MIN_STAKE });
    assert.deepEqual(ofType(w.take(a), "error").map((e) => e.why), ["no rounds left"]);
    await w.lay(a, CARDS.label, CHOICE); // practice still plays
    w.run(TICKS * ROUND_TICK_MS + ROOM_TICK_MS);
    w.take(a);
    w.advance(24 * 3_600_000);
    const { view } = await w.lay(a, CARDS.label, { ...CHOICE, stake: MIN_STAKE });
    assert.equal(view.stake, MIN_STAKE, "a new day, new rounds");
    assert.equal(w.core.meOf(a)!.rounds, 1);
  });

  await test("Mr Bands pays at his desk: the wage once a day and each finished job once; not from across the plaza", async () => {
    const w = world();
    const a = await w.join();
    const b = await w.join();
    w.take(a);
    w.advance(ERROR_GAP_MS);
    await w.send(a, { t: "pay" });
    assert.deepEqual(ofType(w.take(a), "error").map((e) => e.why), ["not at the desk"]);
    // the wave job: b stands near
    await w.walk(b, DESK_SPOT.x + 2, DESK_SPOT.z);
    await w.walk(a, DESK_SPOT.x, DESK_SPOT.z);
    w.advance(SOCIAL_GAP_MS);
    await w.send(a, { t: "emote", e: "wave" });
    assert.equal(w.core.meOf(a)!.jobs.find((j) => j.id === "wave")!.have, 1);
    await w.send(a, { t: "pay" });
    const [paid] = ofType(w.take(a), "paid");
    const wave = JOBS.find((j) => j.id === "wave")!.reward;
    assert.equal(paid.amount, WAGE + wave);
    assert.equal(w.core.meOf(a)!.stack, START_STACK + WAGE + wave);
    w.advance(PAY_GAP_MS);
    await w.send(a, { t: "pay" });
    assert.equal(ofType(w.take(a), "paid")[0].amount, 0, "nothing twice");
    w.advance(24 * 3_600_000);
    await w.send(a, { t: "pay" });
    assert.equal(ofType(w.take(a), "paid")[0].amount, WAGE, "a new day, a new wage (the jobs start again)");
    assert.equal(w.core.meOf(a)!.jobs.find((j) => j.id === "wave")!.have, 0);
  });

  await test("jobs: a wave with nobody near does not count; a staked round's hours in range and a round ahead of holding do; a practice round moves nothing", async () => {
    const w = world();
    const a = await w.join();
    w.take(a);
    await w.send(a, { t: "emote", e: "wave" });
    assert.equal(w.core.meOf(a)!.jobs.find((j) => j.id === "wave")!.have, 0, "nobody near");
    // practice first: however it went, the jobs stay at 0
    for (let i = 0; i < 3; i++) await w.playTo(a, TICKS, { widthBins: 120, offsetBins: 0 });
    assert.deepEqual(w.core.meOf(a)!.jobs.map((j) => j.have), [0, 0, 0, 0], "practice moves no job");
    let me = w.core.meOf(a)!;
    for (let i = 0; i < 6 && !me.jobs.every((j) => j.id === "notes" || j.id === "wave" || j.have > 0); i++) {
      const { scored, view } = await w.playTo(a, TICKS, { widthBins: 120, offsetBins: 0 }, MIN_STAKE, TICKS);
      const res = simulate(CARDS, view.seed, { widthBins: 120, offsetBins: 0 });
      const hours = res.inRange.slice(1).filter(Boolean).length;
      const before = me;
      me = w.core.meOf(a)!;
      assert.equal(me.jobs.find((j) => j.id === "range")!.have, Math.max(before.jobs.find((j) => j.id === "range")!.have, Math.min(24, hours)));
      assert.equal(me.jobs.find((j) => j.id === "beat")!.have, scored.pct > 0 || before.jobs.find((j) => j.id === "beat")!.have ? 1 : 0);
    }
    assert.ok(me.jobs.find((j) => j.id === "range")!.have > 0, "a wide band on CARDS keeps some hours in range");
  });

  await test("loose notes: dropped on the heartbeat on open ground, NOTES_ON_GROUND at most; picked only within reach; NOTES_PER_DAY a day", async () => {
    const w = world({ notes: true });
    const a = await w.join();
    const b = await w.join();
    w.clear();
    for (let i = 0; i < 12; i++) {
      w.advance(NOTE_EVERY_MS);
      w.core.tick();
    }
    const ground = w.core.notesOnGround();
    assert.equal(ground.length, NOTES_ON_GROUND);
    for (const n of ground) {
      assert.ok(NOTE_SPOTS.some(([x, z]) => Math.hypot(n.x - x, n.z - z) <= Math.SQRT2 + 1e-9), "on an open spot");
      assert.ok(n.v >= NOTE_MIN && n.v <= NOTE_MIN + NOTE_SPREAD);
    }
    assert.equal(ofType(w.take(b), "notes").length, NOTES_ON_GROUND, "everyone sees them drop");
    const n = ground[0];
    await w.send(a, { t: "pick", note: n.id });
    assert.equal(w.core.notesOnGround().length, NOTES_ON_GROUND, "too far: still there");
    await w.walk(a, n.x + NOTE_REACH * 0.7, n.z);
    await w.send(a, { t: "pick", note: n.id });
    assert.equal(w.core.meOf(a)!.stack, START_STACK + n.v);
    assert.equal(w.core.meOf(a)!.notes, 1);
    assert.equal(w.core.meOf(a)!.jobs.find((j) => j.id === "notes")!.have, 1);
    assert.deepEqual(ofType(w.take(b), "picked"), [{ t: "picked", id: a, note: n.id, v: n.v }]);
    await w.send(a, { t: "pick", note: n.id });
    assert.equal(w.core.meOf(a)!.notes, 1, "gone is gone");
    for (const [x, z] of NOTE_SPOTS) {
      assert.ok(Math.hypot(x, z) < WORLD_RADIUS - 3, "inside the rope");
      assert.ok(Math.hypot(x, z) > 6, "clear of the fountain");
    }
    assert.ok(NOTE_SPOTS.length >= 20, `${NOTE_SPOTS.length} spots`);
    void NOTES_PER_DAY;
  });

  await test("the biggest stacks: biggest first, told to the room when the top changes", async () => {
    const store = memoryAccounts();
    const w = world({ accounts: store });
    const a = await w.join();
    const b = await w.join();
    w.clear();
    await w.walk(a, DESK_SPOT.x, DESK_SPOT.z);
    await w.send(a, { t: "pay" });
    const heard = w.take(b);
    const rows = ofType(heard, "stacks").at(-1)!.rows;
    assert.equal(rows[0].name, w.pos(a).name);
    assert.equal(rows[0].stack, START_STACK + WAGE);
    assert.equal(rows[1].stack, START_STACK);
    assert.deepEqual(w.core.stacks(), rows);
    assert.deepEqual(ofType(heard, "stack"), [{ t: "stack", id: a, stack: START_STACK + WAGE }], "the room sees the new stack (name tags)");
    assert.equal(w.core.player(a)!.stack, START_STACK + WAGE);
    assert.equal(BAND, 1000);
  });

  await test("a practice round records nothing: no board row, no job, no write; a staked one writes the lay and the settle", async () => {
    const store = countingAccounts();
    const w = world({ accounts: store });
    const a = await w.join();
    w.take(a);
    assert.equal(store.puts, 1, "the hello: one insert");
    const me = w.core.meOf(a)!;
    for (let i = 0; i < 4; i++) {
      const { scored } = await w.playTo(a, 1 + i * 9, { widthBins: 120, offsetBins: 0 });
      assert.equal(scored.rank, null);
    }
    assert.equal(store.puts, 1, "four practice rounds: nothing written");
    assert.deepEqual(w.core.leaderboard(), []);
    assert.deepEqual(w.core.meOf(a), me, "the account is as it was");
    assert.equal(w.saved.length, 0, "no board to persist");
    const { scored } = await w.playTo(a, 3, { widthBins: 120, offsetBins: 0 }, MIN_STAKE, 12);
    assert.equal(store.puts, 3, "a staked round: the lay and the settle");
    assert.equal(scored.rank, 1);
    assert.equal(w.core.leaderboard().length, 1);
    // a new day rolls the counts in memory at the lay; a practice round still writes nothing (a roll is re-derived
    // from the clock whenever the row is next loaded, so an unwritten one loses nothing)
    w.advance(24 * 3_600_000);
    await w.playTo(a, 2);
    assert.equal(store.puts, 3);
    assert.equal(w.core.meOf(a)!.day, "2026-09-25");
    assert.equal(store.byId(w.joined[0].account)!.day, "2026-09-24", "the row is as it was");
    await w.playTo(a, 2, CHOICE, MIN_STAKE, 12);
    assert.equal(store.puts, 5, "the next staked round writes it");
    assert.equal(store.byId(w.joined[0].account)!.day, "2026-09-25");
  });

  await test("pay: one per PAY_GAP_MS, and a pay that collects nothing writes nothing and sends no account", async () => {
    const store = countingAccounts();
    const w = world({ accounts: store });
    const a = await w.join();
    await w.walk(a, DESK_SPOT.x, DESK_SPOT.z);
    w.takeAll(a);
    const puts = store.puts;
    await w.send(a, { t: "pay" });
    let heard = w.takeAll(a);
    assert.equal(ofType(heard, "paid")[0].amount, WAGE);
    assert.equal(ofType(heard, "me").length, 1);
    assert.equal(store.puts, puts + 1, "the wage: one write");
    // inside the gap: dropped (told slow), nothing else
    await w.send(a, { t: "pay" });
    heard = w.takeAll(a);
    assert.deepEqual(heard.map((m) => m.t), ["slow"]);
    // after it: a paid 0, no write, no me
    for (let i = 0; i < 5; i++) {
      w.advance(PAY_GAP_MS);
      await w.send(a, { t: "pay" });
      heard = w.takeAll(a);
      assert.deepEqual(heard, [{ t: "paid", amount: 0 }], `pay ${i}`);
    }
    assert.equal(store.puts, puts + 1, "nothing to collect, nothing written");
    // the gap applies before the desk check too
    w.advance(PAY_GAP_MS);
    await w.walk(a, 0, 20);
    await w.send(a, { t: "pay" });
    assert.deepEqual(w.takeAll(a).map((m) => m.t), ["error"]);
    await w.send(a, { t: "pay" });
    assert.deepEqual(w.takeAll(a).map((m) => m.t), ["slow"]);
    assert.equal(store.puts, puts + 1);
  });

  await test("keyless hellos draw from one bucket for the room: past the burst they are answered full and closed; a known key is not metered", async () => {
    const w = world();
    const first = await w.join();
    const key = ofType(w.take(first), "welcome")[0].key!;
    w.core.leave(first);
    w.clear();
    w.advance(KEYLESS_HELLO_BURST * 1000); // full again
    const ids: string[] = [];
    for (let i = 0; i < KEYLESS_HELLO_BURST + 3; i++) {
      const id = w.core.open()!;
      await w.send(id, { t: "hello", strap: 0 });
      ids.push(id);
    }
    assert.equal(w.core.size, KEYLESS_HELLO_BURST, "the burst got in");
    for (const id of ids.slice(KEYLESS_HELLO_BURST)) {
      assert.deepEqual(w.inbox(id), [{ t: "full" }]);
      assert.ok(w.closed.some((c) => c.id === id && c.code === CLOSE_FULL));
    }
    // the bucket refills at KEYLESS_HELLO_RATE a second
    w.advance(1000 / KEYLESS_HELLO_RATE);
    const next = w.core.open()!;
    await w.send(next, { t: "hello", strap: 0 });
    assert.equal(ofType(w.inbox(next), "welcome").length, 1, "one more a second later");
    const again = w.core.open()!;
    await w.send(again, { t: "hello", strap: 0 });
    assert.deepEqual(w.inbox(again), [{ t: "full" }], "and only one");
    // a known key opens its account regardless
    const back = w.core.open()!;
    await w.send(back, { t: "hello", strap: 0, key });
    assert.equal(ofType(w.inbox(back), "welcome").length, 1, "a returning visitor is let in");
    // an unknown but well-formed key is a new account, so it is metered too
    const unknown = w.core.open()!;
    await w.send(unknown, { t: "hello", strap: 0, key: "B".repeat(32) });
    assert.deepEqual(w.inbox(unknown), [{ t: "full" }]);
    assert.equal(w.core.size, KEYLESS_HELLO_BURST + 2);
  });

  await test("at ROOM_CAP a hello with a key still opens its own account (the old seat is freed first); keyless or unknown keys are told full", async () => {
    const store = countingAccounts();
    const w = world({ accounts: store });
    const ids: string[] = [];
    for (let i = 0; i < ROOM_CAP; i++) ids.push(await w.join());
    const key = ofType(w.inbox(ids[0]), "welcome")[0].key!;
    w.clear();
    const puts = store.puts;
    const tab = w.core.open()!;
    w.advance(1000);
    await w.send(tab, { t: "hello", strap: 3, key });
    assert.equal(ofType(w.inbox(tab), "welcome").length, 1, "in from the new tab");
    assert.ok(w.inbox(ids[0]).some((m) => m.t === "elsewhere"), "the old tab is out");
    assert.equal(w.core.size, ROOM_CAP);
    assert.equal(w.core.player(ids[0]), null);
    const keyless = w.core.open()!;
    w.advance(1000);
    await w.send(keyless, { t: "hello", strap: 0 });
    assert.deepEqual(w.inbox(keyless), [{ t: "full" }]);
    const unknown = w.core.open()!;
    w.advance(1000);
    await w.send(unknown, { t: "hello", strap: 0, key: "C".repeat(32) });
    assert.deepEqual(w.inbox(unknown), [{ t: "full" }]);
    assert.equal(store.inserts, ROOM_CAP, "no row for anyone turned away");
    assert.equal(store.puts, puts + 1, "the returning account: one update");
    assert.equal(w.core.size, ROOM_CAP);
  });

  await test("a new account is one insert, after the checks: a socket gone while its key was hashed leaves no row; an insert that throws is retried with a fresh name, then given up", async () => {
    const store = countingAccounts();
    let release: (v: string) => void = () => {};
    let slow = false;
    const v = world({ accounts: store, seed: 2 });
    const a = await v.join({ strap: 4 });
    const [wel] = ofType(v.take(a), "welcome");
    assert.equal(store.puts, 1);
    assert.equal(store.inserts, 1, "one write, an insert");
    const row = store.byId(v.joined[0].account)!;
    assert.equal(row.strap, 4, "with the strap");
    assert.equal(row.seen, v.now, "and seen");
    assert.equal(row.name, wel.name);

    // gone while the key was looked up: the hello's hash is awaited, the socket leaves, the hash resolves (a core of
    // its own, for the slow hashKey)
    const core2 = new RoomCore(
      {
        send: () => {},
        broadcast: () => {},
        now: () => v.now,
        random: seeded(4),
        board: async () => POOLS,
        accounts: store,
        hashKey: (k) => (slow ? new Promise<string>((r) => (release = r)) : Promise.resolve(`plain:${k}`)),
        notes: false,
      },
      [],
    );
    slow = true;
    const gone = core2.open()!;
    const pending = core2.message(gone, JSON.stringify({ t: "hello", strap: 0 }));
    await new Promise((r) => setImmediate(r));
    core2.leave(gone);
    release("hash-of-a-key-nobody-holds");
    await pending;
    assert.equal(store.inserts, 1, "no row for a socket that left mid-hello");
    assert.equal(core2.size, 0);

    // an insert that throws (a name taken meanwhile): tried again with another name
    let fails = 0;
    const tried: string[] = [];
    const flaky = countingAccounts();
    const realPut = flaky.put;
    flaky.put = (acct: Account, keyHash?: string) => {
      if (keyHash) tried.push(acct.name);
      if (keyHash && fails > 0) {
        fails--;
        throw new Error("UNIQUE constraint failed: accounts.name");
      }
      realPut(acct, keyHash);
    };
    const f = world({ accounts: flaky });
    fails = INSERT_TRIES - 1;
    const b = await f.join();
    const [welB] = ofType(f.take(b), "welcome");
    assert.ok(welB, "in, on the last try");
    assert.equal(tried.length, INSERT_TRIES);
    assert.equal(new Set(tried).size, INSERT_TRIES, "a fresh name each try");
    assert.equal(welB.name, tried.at(-1), "the one that took");
    assert.equal(flaky.inserts, 1);
    fails = INSERT_TRIES;
    tried.length = 0;
    const c = await f.join();
    assert.equal(f.inbox(c).length, 0, "nothing said");
    assert.equal(tried.length, INSERT_TRIES);
    assert.deepEqual(f.closed.at(-1), { id: c, code: CLOSE_NO_ACCOUNT, reason: "no account" });
    assert.equal(f.core.size, 1);
    assert.equal(flaky.inserts, 1);
  });

  await test("lay by address on a board with a repeated label deals that pool, not the first with the name", async () => {
    const twins = parseBoard({
      rows: [
        hotRow(0, { address: "Crack1111111111111111111111111111111111111", name: "CRACKER / SOL", feePct: 0.2, feeToTvl1hPct: 0.5891, priceChange1hPct: 1 }),
        hotRow(1, { name: "ZAMA / USDC" }),
        hotRow(2, { address: "Crack2222222222222222222222222222222222222", name: "CRACKER / SOL", feePct: 1, feeToTvl1hPct: 0.5675, priceChange1hPct: 15 }),
      ],
    });
    assert.equal(twins.length, 3);
    assert.equal(twins[0].label, twins[2].label);
    assert.notDeepEqual(twins[0], twins[2]);
    const w = world({ pools: twins });
    const [a, b] = [await w.join(), await w.join()];
    w.clear();
    const second = await w.lay(a, twins[2].address);
    assert.deepEqual(second.laid.pool, twins[2], "the second CRACKER, by address");
    assert.equal(second.laid.pool.binStepBps, 100);
    const first = await w.lay(b, twins[0].address);
    assert.deepEqual(first.laid.pool, twins[0]);
    await w.close(a, second.laid.roundId);
    const byLabel = await w.lay(a, "CRACKER / SOL");
    assert.deepEqual(byLabel.laid.pool, twins[0], "a label is the first with that name");
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

  await test("expected value: a band pays the stake plus its result against holding, so a known rise pays nothing, fees pay at most the cap, and nothing compounds", async () => {
    // the room's own pipeline over every dealable stretch: what settle() pays for a $1,000 band at the full hold
    const stake = MAX_STAKE;
    const rake = rakeOf(stake);
    const payout = (r: SimResult, at: number) => Math.max(0, Math.round((stake * (100 + r.valuePct[at] + r.feesPct[at] - r.holdPct[at])) / 100));
    const over = (candles: unknown[], pool: PoolParams, widthBins: number, offsetBins: number) => {
      const series = hourlySeries(candles);
      const backs: number[] = [];
      for (let s = 0; s + MARKET_HOURS <= series.length; s++) {
        const m = marketWindow(series, s, pool)!;
        const r = simulate(pool, 0, { widthBins, offsetBins, closeAt: TICKS }, m);
        assert.ok(r.feesPct[TICKS] <= FEES_CAP_PCT + 1e-9);
        backs.push(payout(r, TICKS));
      }
      return { n: backs.length, max: Math.max(...backs), mean: backs.reduce((x, y) => x + y, 0) / backs.length };
    };
    // a pool that rose 15x over its history, as the board's pools do (they are on it because they surged), with
    // hardly any volume: the raw worth of an all-token band below the price was a long on the rise (measured 24 Sep:
    // a mean 169% of the stake); against holding it can only lose to holding, so no stretch pays more than the stake
    const rising = Array.from({ length: 100 }, (_, k) => {
      const c = 0.01 * Math.exp(k * 0.0275) * (1 + 0.03 * Math.sin(k / 2));
      return [T0 + k * HR, c, c, c, c, 40];
    }).reverse();
    for (const [widthBins, offsetBins] of [[120, 60], [120, 0], [120, -60], [40, 20], [12, 0]] as const) {
      const r = over(rising, LIVE, widthBins, offsetBins);
      assert.equal(r.n, 52);
      assert.ok(r.max <= stake + 1, `${widthBins}/${offsetBins}: a known rise pays nothing: max ${r.max}`);
      // (an all-quote band above the rise sits out of range and matches holding exactly: the stake back, less the rake)
      assert.ok(r.mean <= stake, `${widthBins}/${offsetBins}: mean ${r.mean} (at best the stake back, and the rake gone)`);
    }
    // the wavy fixture (fees a few cents, price wobbling): about the stake back, less the rake
    const wavy = over(CANDLES, LIVE, 120, 0);
    assert.equal(wavy.n, 52);
    assert.ok(wavy.max <= stake + 2, `max ${wavy.max}`);
    assert.ok(wavy.mean <= stake, `mean ${wavy.mean}`);
    // a pool whose every hour pays the fee clamp (5% of its liquidity), price wobbling 2% either way: the fees cap
    // binds on every stretch, and that cap is the most a round can add. Linear: a band a round, never the stack
    const hot = Array.from({ length: 100 }, (_, k) => {
      const c = 2 * (1 + 0.02 * Math.sin(k / 3));
      return [T0 + k * HR, c, c, c, c, 1e9];
    }).reverse();
    for (const widthBins of [120, 20, 3]) {
      const h = over(hot, LIVE, widthBins, 0);
      assert.equal(h.n, 52);
      assert.ok(h.max <= stake * (1 + FEES_CAP_PCT / 100) + 1e-6, `width ${widthBins}: max ${h.max}`);
      assert.ok(h.mean > stake * 1.2, `width ${widthBins}: the cap, not less, is what binds (${h.mean})`);
    }
    // and the room pays exactly that: a dealt round's back is the formula at its hold, the rake gone
    const w = world({ pools: [LIVE], history: async () => hot, seed: 21 });
    const a = await w.join();
    w.take(a);
    const { laid, view } = await w.lay(a, LIVE.label, { widthBins: 120, offsetBins: 0, stake: 500, hold: 48 });
    const [scored] = ofType(await w.close(a, laid.roundId), "scored");
    const series = hourlySeries(hot);
    const m = marketWindow(series, (view.from! - HR - series[0].ts) / HR, LIVE)!;
    const r = simulate(LIVE, view.seed, { widthBins: 120, offsetBins: 0, closeAt: 48 }, m);
    assert.equal(r.feesPct[48], FEES_CAP_PCT);
    assert.equal(scored.back, Math.round((500 * (100 + r.valuePct[48] + r.feesPct[48] - r.holdPct[48])) / 100));
    assert.ok(scored.back! <= 500 * 1.3);
    assert.equal(w.core.meOf(a)!.stack, START_STACK - 500 - rakeOf(500) + scored.back!);
  });

  await test("a dealt stretch needs MIN_LIVE_HOURS hours with volume: a thin, gap-filled history plays simulated", async () => {
    // 16 real hours, a 12-hour silence filled flat, 16 more, a silence, 16 more: 100 hours of which 48 are live, and no
    // 48-hour stretch holds 36 live ones
    const thin: unknown[] = [];
    for (let k = 0; k < 100; k++) if (k % 28 < 16) thin.push([T0 + k * HR, 1, 1, 1, 1 + k * 0.001, 500]);
    const series = hourlySeries(thin.slice().reverse());
    assert.equal(series.length, 100, "gap-filled to a run");
    const w = world({ pools: [LIVE], history: async () => thin.slice().reverse() });
    const a = await w.join();
    w.take(a);
    w.advance(LAY_GAP_MS);
    await w.send(a, { t: "lay", pool: LIVE.label, ...CHOICE, stake: MIN_STAKE, hold: 12 });
    assert.deepEqual(ofType(w.take(a), "error").map((e) => e.why), ["practice only"], "no stretch live enough: no stake");
    w.advance(ERROR_GAP_MS);
    const { laid, view } = await w.lay(a, LIVE.label, CHOICE);
    assert.equal(laid.real, false, "practice plays the simulated path");
    assert.equal(view.from, null);
    // the same history with the silences traded through: real
    const full = Array.from({ length: 100 }, (_, k) => [T0 + k * HR, 1, 1, 1, 1 + k * 0.001, 500]).reverse();
    const v = world({ pools: [LIVE], history: async () => full });
    const b = await v.join();
    v.take(b);
    assert.equal((await v.lay(b, LIVE.label, { ...CHOICE, stake: MIN_STAKE, hold: 12 })).laid.real, true);
    assert.ok(MIN_LIVE_HOURS >= 24 && MIN_LIVE_HOURS <= TICKS);
  });

  await test("money rides on real hours only: a stake on a pool with no history is refused 'practice only'; practice plays; a room with no history service still stakes", async () => {
    const w = world({ pools: [LIVE], history: async () => null });
    const a = await w.join();
    w.take(a);
    w.advance(LAY_GAP_MS);
    await w.send(a, { t: "lay", pool: LIVE.label, ...CHOICE, stake: MIN_STAKE, hold: 12 });
    assert.deepEqual(w.take(a).map((m) => m.t), ["error"]);
    assert.equal(w.core.roundOf(a), null);
    assert.equal(w.core.meOf(a)!.stack, START_STACK, "nothing taken");
    assert.equal(w.core.meOf(a)!.rounds, 0, "nothing counted");
    w.advance(ERROR_GAP_MS);
    const { laid } = await w.lay(a, LIVE.label, CHOICE);
    assert.equal(laid.real, false, "practice on the simulated path is fine");
    // the same on a history that is there but too short or too quiet: refused too
    const v = world({ pools: [LIVE], history: async () => CANDLES.slice(0, 30) });
    const b = await v.join();
    v.take(b);
    v.advance(LAY_GAP_MS);
    await v.send(b, { t: "lay", pool: LIVE.label, ...CHOICE, stake: MIN_STAKE, hold: 12 });
    assert.deepEqual(ofType(v.take(b), "error").map((e) => e.why), ["practice only"]);
    // no history service at all (this harness's default): stakes ride the seeded simulation, as every staked test above does
    const u = world();
    const c = await u.join();
    u.take(c);
    assert.equal((await u.lay(c, CARDS.label, { ...CHOICE, stake: MIN_STAKE, hold: 12 })).view.stake, MIN_STAKE);
  });

  await test("new accounts per address: NEW_ACCOUNTS_PER_IP an hour, then full; a known key is not counted; another address is not", async () => {
    const w = world({ notes: false });
    const keys: string[] = [];
    for (let i = 0; i < NEW_ACCOUNTS_PER_IP; i++) {
      const id = w.core.open("203.0.113.7")!;
      w.advance(1000);
      await w.send(id, { t: "hello", strap: 0 });
      const [wel] = ofType(w.take(id), "welcome");
      assert.ok(wel, `account ${i + 1} opens`);
      keys.push(wel.key!);
      w.core.leave(id);
    }
    const sixth = w.core.open("203.0.113.7")!;
    w.advance(1000);
    await w.send(sixth, { t: "hello", strap: 0 });
    assert.deepEqual(w.take(sixth).map((m) => m.t), ["full"], "the sixth from that address is turned away");
    assert.equal(w.core.player(sixth), null);
    // a known key from the same address still opens its account
    const back = w.core.open("203.0.113.7")!;
    w.advance(1000);
    await w.send(back, { t: "hello", strap: 0, key: keys[0] });
    assert.equal(ofType(w.take(back), "welcome").length, 1);
    w.core.leave(back);
    // an unknown key from the same address counts like no key
    const unknown = w.core.open("203.0.113.7")!;
    w.advance(1000);
    await w.send(unknown, { t: "hello", strap: 0, key: "B".repeat(32) });
    assert.deepEqual(w.take(unknown).map((m) => m.t), ["full"]);
    // another address, and the same address an hour on
    const other = w.core.open("198.51.100.2")!;
    w.advance(1000);
    await w.send(other, { t: "hello", strap: 0 });
    assert.equal(ofType(w.take(other), "welcome").length, 1);
    // spread across the hour it is still five: the window is fixed from the first, not a refilling bucket
    w.advance(IP_WINDOW_MS / 2);
    const mid = w.core.open("203.0.113.7")!;
    await w.send(mid, { t: "hello", strap: 0 });
    assert.deepEqual(w.take(mid).map((m) => m.t), ["full"], "half an hour on, still none");
    w.advance(IP_WINDOW_MS / 2 + 1000);
    const later = w.core.open("203.0.113.7")!;
    await w.send(later, { t: "hello", strap: 0 });
    assert.equal(ofType(w.take(later), "welcome").length, 1, "an hour on, the allowance is back");
    // a socket with no address (a host that passes none) is not limited by it
    for (let i = 0; i < NEW_ACCOUNTS_PER_IP + 2; i++) {
      const id = w.core.open()!;
      w.advance(1000);
      await w.send(id, { t: "hello", strap: 0 });
      assert.equal(ofType(w.take(id), "welcome").length, 1);
      w.core.leave(id);
    }
  });

  await test("a pick of a note that is gone answers { notes, gone } so the walker stops asking; a lay on a new day sends the fresh account first", async () => {
    const w = world();
    const a = await w.join();
    w.take(a);
    await w.send(a, { t: "pick", note: "n0000000" });
    assert.deepEqual(w.take(a), [{ t: "notes", add: [], gone: ["n0000000"] }]);
    await w.send(a, { t: "pick", note: "x".repeat(40) });
    assert.deepEqual(w.take(a), [], "an id that could never be a note gets no answer");
    // a practice round laid after midnight: the page hears the new day at the lay (a practice settle says nothing)
    await w.playTo(a, 3, CHOICE, MIN_STAKE, 12);
    assert.equal(w.core.meOf(a)!.rounds, 1);
    w.advance(24 * 3_600_000);
    w.takeAll(a);
    w.advance(1000);
    await w.send(a, { t: "lay", pool: CARDS.label, ...CHOICE });
    const heard = w.takeAll(a);
    assert.deepEqual(heard.map((m) => m.t), ["me", "laid"], "the fresh account, then the band");
    const me = ofType(heard, "me");
    assert.equal(me[0].me.rounds, 0, "a new day");
    assert.equal(me[0].me.day, dayOf(w.now));
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
