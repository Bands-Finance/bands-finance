/**
 * The Bands Exchange room (game-server/src/core.ts), on fakes: no Cloudflare, no network, a hand-wound clock and a
 * seeded random. Joining and generated names, the room cap and the keyless-hello bucket, move rate limits / the
 * town's ground / the speed budget, batched moves, the emote and phrase allow-lists, and the server-streamed round: a
 * band laid only on board pools, ticks sent in order as the server clock reaches them, a close settling at the last
 * tick sent (a simulate() replay, never the client's claim), one round at a time, never a seed on the wire, and every
 * settled round on the Best rounds board (the stalls are practice: a stake is refused, no stack moves). Rounds on a
 * pool's real history: a hidden stretch replayed, named only with the score, the simulated fallback. Then the
 * best-per-name top 20, the accounts (written once and only when changed), malformed input, the board and history
 * sources and origins. Then the town: moves pulled back onto town.ts's walkable ground, the rope a line crossed only
 * at a street's mouth, doors entered only within reach (a position 4 m off is refused), discoveries recorded once, the
 * shops' refusals and the kit told to everyone, the Coffee House's talk, the tower's hour, the street ends. Then the
 * coins (24 Sep, the simple town): every zone filled on the heartbeat at its own pace, coinSpot's ground, a pick into
 * the pockets and not the stack, the cash-in at the desk, the daily cap rolling with the UTC day, the Mint spill on
 * the hour from the clock alone, and old account rows cleaned to the new shape.
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
  cleanAccount,
  cleanTalk,
  COIN_EVERY_MS,
  COINS_ON_GROUND,
  dayOf,
  DOOR_GAP_MS,
  doorOf,
  hourOf,
  HOUR_MS,
  IP_WINDOW_MS,
  MARK_EVERY_MS,
  MIN_LIVE_HOURS,
  NEW_ACCOUNTS_PER_IP,
  cleanBoard,
  CLOSE_FULL,
  CLOSE_NO_ACCOUNT,
  CLOSE_NO_HELLO,
  CLOSE_ELSEWHERE,
  INSERT_TRIES,
  KEYLESS_HELLO_BURST,
  KEYLESS_HELLO_RATE,
  memoryAccounts,
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
  SPILL_COINS,
  SPILL_GAP_M,
  SPILL_GRACE_MS,
  SPILL_MS,
  wrapAngle,
} from "../../game-server/src/core";
import type { Account, AccountStore, Coin, RoomDeps } from "../../game-server/src/core";
import {
  BAND,
  COINS_PER_DAY,
  DEFAULT_KIT,
  DESK_SPOT,
  DOOR_REACH_M,
  EMOTES,
  MAX_SPEED,
  MOVE_HZ,
  NOTE_REACH,
  PHRASES,
  PLACE_IDS,
  ROOM_CAP,
  ROUND_TICK_MS,
  shopOf,
  START_STACK,
  STOCK,
  STRAPS,
  TALK_ROWS,
  WORLD_RADIUS,
} from "../../web/src/game/protocol";
import type { Me, S2C, ScoreRow } from "../../web/src/game/protocol";
import {
  COIN_DOOR_M,
  COIN_FIXTURE_M,
  COIN_GAP_M,
  COIN_ZONES,
  coinSpot,
  crossesRope,
  FOUNTAIN_R,
  inMouth,
  KERB_OUT,
  LANE_T,
  MARK_COIN_T,
  nearestWalkable,
  PLACES,
  PLAZA_FIXTURES,
  quarterAt,
  QUARTERS,
  RING_ROAD_HALF_M,
  RING_ROAD_IN,
  RING_ROAD_R,
  ROPE_BAND_M,
  ROUTE_GRAPH,
  routeTo,
  STREET_ANGLES,
  STREET_HALF_WIDTH_M,
  STREET_NAMES,
  toLocal,
  toWorld,
  TOWN_RADIUS,
  walkable,
} from "../../web/src/game/town";
import type { CoinZone, Quarter } from "../../web/src/game/town";
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

/** a room on fakes: per-socket inboxes, a hand-wound clock (noon UTC, 24 Sep 2026) */
function world(
  opts: {
    pools?: PoolParams[];
    board?: () => Promise<PoolParams[]>;
    history?: (pool: PoolParams) => Promise<unknown>;
    leaderboard?: unknown;
    seed?: number;
    accounts?: AccountStore;
    /** drop coins about the town (off unless a test is about them) */
    coins?: boolean;
    /** stored Coffee House talk to bring the room up on */
    talk?: unknown;
    /** the clock's start (ms), default noon */
    at?: number;
  } = {},
) {
  let t = opts.at ?? Date.parse("2026-09-24T12:00:00Z");
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
  const savedTalk: { name: string; phrase: string; at: number }[][] = [];
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
    coins: opts.coins ?? false,
    saveBoard: (rows) => saved.push(rows),
    saveTalk: (rows) => savedTalk.push(rows),
    close: (id, code, reason) => closed.push({ id, code, reason }),
    joined: (id, account) => joined.push({ id, account }),
  };
  const core = new RoomCore(deps, opts.leaderboard, opts.talk);
  const w = {
    core,
    closed,
    saved,
    savedTalk,
    joined,
    wire,
    get now() {
      return t;
    },
    advance(ms: number) {
      t += ms;
    },
    inbox: (id: string) => inbox.get(id) ?? [],
    /** read and empty one inbox, leaving out the account updates ("me": the account tests read them with takeAll) */
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
    /** lay, let ticks 1..k go out in one late heartbeat, close: the scored message (a round settles at TICKS by itself) */
    async playTo(id: string, k: number, band: Choice = CHOICE) {
      const { laid, view } = await w.lay(id, CARDS.label, band);
      const sent = Math.min(k, TICKS);
      w.advance(k * ROUND_TICK_MS);
      core.tick();
      const heard = w.take(id);
      assert.deepEqual(ofType(heard, "tick").map((m) => m.i), Array.from({ length: sent }, (_, j) => j + 1));
      // at the end the round settles on that heartbeat; before it, the close settles it
      const scored = ofType(sent >= TICKS ? heard : await w.close(id, laid.roundId), "scored");
      assert.equal(scored.length, 1, "scored");
      assert.equal(scored[0].at, sent, "settled where it should");
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

/** the wire's account: what "me" says, and only that */
const ME_KEYS = ["coins", "coinsToday", "day", "found", "kit", "stack"];

/**
 * where a coin's zone puts it: the ground it is on, by the shape town.ts walks (a street's corridor first, so a coin
 * at a ring road crossing counts as the street's; the ring road's own zone is judged by its radius instead)
 */
function groundOf(x: number, z: number): { ground: string; t: number } {
  const r = Math.hypot(x, z);
  if (r < WORLD_RADIUS) return { ground: "plaza", t: r };
  for (let i = 0; i < STREET_ANGLES.length; i++) {
    const a = STREET_ANGLES[i];
    const t = x * Math.sin(a) + z * Math.cos(a);
    const s = x * Math.cos(a) - z * Math.sin(a);
    if (t > KERB_OUT && Math.abs(s) <= STREET_HALF_WIDTH_M) return { ground: STREET_NAMES[i], t };
  }
  if (r <= KERB_OUT) return { ground: "ring", t: r };
  if (Math.abs(r - RING_ROAD_R) <= RING_ROAD_HALF_M) return { ground: "ring-road", t: r };
  const q = quarterAt(x, z);
  if (q) return { ground: q.qr.id, t: r };
  return { ground: "off", t: r };
}
/** is the coin on its zone's ground: a ring road coin anywhere on the road's band, the rest by groundOf */
const onGround = (zone: CoinZone, x: number, z: number): boolean =>
  zone.ground === "ring-road" ? Math.abs(Math.hypot(x, z) - RING_ROAD_R) <= RING_ROAD_HALF_M - 0.75 + 1e-9 : groundOf(x, z).ground === zone.ground;
/** a quarter's point in the world */
const inQuarter = (q: Quarter, p: number, qq: number): [number, number] => toWorld(q, p, qq);

/** a keeper's spot as World.ts stands them: 1.5 m along the front (facing + a quarter turn) and 0.5 m back from the door */
const KEEPERS = PLACES.map((p) => {
  const along = p.facing + Math.PI / 2;
  return { id: p.id, x: p.x + Math.sin(along) * 1.5 - Math.sin(p.facing) * 0.5, z: p.z + Math.cos(along) * 1.5 - Math.cos(p.facing) * 0.5 };
});

async function main() {
  console.log("game room");

  /* ---------- a pool's history, for the rounds that replay real hours ---------- */
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
    assert.deepEqual(welA[0].notes, [], "no coins in a room that drops none");

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
    await w.send(lurker, { t: "cashin" });
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

  await test("positions are pulled back onto the town's ground; a pull of more than 0.5 m is corrected", async () => {
    const w = town();
    const a = await w.join();
    // due east (between two streets) the ground ends at the ring's outer kerb, before the bank's front: out through
    // the east street's mouth in the rope and round the boulevard to it
    await w.goTo(a, KERB_OUT - 0.5, 0);
    w.take(a);
    w.advance(500);
    await w.send(a, { t: "move", x: KERB_OUT + 0.3, z: 0, ry: 0, moving: true });
    assert.equal(w.pos(a).x, KERB_OUT);
    assert.equal(ofType(w.take(a), "moves").length, 0, "a small pull is silent");
    w.advance(500);
    await w.send(a, { t: "move", x: KERB_OUT, z: 3, ry: 0, moving: true }); // outside by ~0.1 m
    w.advance(500);
    await w.send(a, { t: "move", x: KERB_OUT + 2.5, z: 0, ry: 0, moving: true }); // 2.5 m into the façade, a legal step
    const p = w.pos(a);
    assert.ok(Math.abs(Math.hypot(p.x, p.z) - KERB_OUT) < 0.01, "on the kerb");
    const fixes = ofType(w.take(a), "moves");
    assert.equal(fixes.length, 1, "told where it really is");
    assert.deepEqual(fixes[0].m, [[a, p.x, p.z, p.ry, 1]]);
    // the boulevard is ground right back to the rope's band
    await w.walk(a, WORLD_RADIUS + 3, 0);
    assert.ok(Math.abs(w.pos(a).x - (WORLD_RADIUS + 3)) < 0.01, "on the boulevard, 3 m past the rope");
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
    assert.deepEqual(Object.keys(laid).sort(), ["lower", "pool", "real", "roundId", "t", "tickMs", "upper"], "nothing of a stake on the wire");
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
        else assert.ok(m.t === "board", `unexpected ${m.t}`);
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
    assert.deepEqual(w.take(b).map((m) => m.t), ["board"], "the room hears of it only through the board: the round is on it");
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

  await test("a close settles at the last tick already sent: simulate() with that closeAt; a claimed score or closeAt is ignored; no ticks after", async () => {
    const w = world();
    const a = await w.join();
    w.take(a);
    const { laid, view, start } = await w.lay(a);
    while ((w.core.roundOf(a)?.sent ?? 0) < 10) w.run(ROOM_TICK_MS);
    assert.equal(w.core.roundOf(a)?.sent, 10);
    w.take(a);
    w.advance(start + 11 * ROUND_TICK_MS - w.now); // tick 11 is due, but no heartbeat has sent it
    const out = await w.close(a, laid.roundId, { pct: 999, closeAt: 40, scorePct: 999 });
    assert.deepEqual(out.map((m) => m.t), ["scored", "board"], "settled at once, tick 11 never sent, the board told");
    const scored = ofType(out, "scored")[0];
    assert.equal(scored.roundId, laid.roundId);
    assert.equal(scored.at, 10);
    assert.equal(scored.pct, simulate(CARDS, view.seed, { ...CHOICE, closeAt: 10 }).scorePct, "the replay at tick 10");
    assert.notEqual(scored.pct, 999);
    assert.equal(scored.rank, 1, "the first round of the name: its best");
    assert.deepEqual(Object.keys(scored).sort(), ["at", "pct", "rank", "roundId", "t"], "nothing of a stake");
    assert.equal(w.core.leaderboard().length, 1, "recorded");
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
    assert.equal(ofType(out, "scored")[0].at, 1);
    assert.equal(ofType(out, "scored")[0].pct, simulate(CARDS, view.seed, { ...CHOICE, closeAt: 1 }).scorePct);
    w.assertNoSeed();
  });

  await test("the stalls are practice only: a stake sent with a lay is refused 'practice only' and nothing is dealt; a hold sent is not read; no stack ever moves", async () => {
    const store = countingAccounts();
    const w = world({ accounts: store });
    const a = await w.join();
    w.take(a);
    const puts = store.puts;
    for (const stake of [100, 1000, 0.5, 1e9]) {
      w.advance(ERROR_GAP_MS + LAY_GAP_MS);
      await w.send(a, { t: "lay", pool: CARDS.label, ...CHOICE, stake, hold: 12 });
      assert.deepEqual(w.take(a), [{ t: "error", why: "practice only" }], `stake ${stake}`);
      assert.equal(w.core.roundOf(a), null, "nothing dealt");
    }
    assert.equal(w.core.meOf(a)!.stack, START_STACK, "nothing taken");
    // a hold sent with a practice round changes nothing: the round rides to TICKS unless closed
    const { laid, view } = await w.lay(a, CARDS.label, { ...CHOICE, stake: 0, hold: 12 });
    assert.ok(!("hold" in laid) && !("stake" in laid) && !("rake" in laid));
    w.run(13 * ROUND_TICK_MS);
    assert.ok(w.core.roundOf(a), "still open past hour 12");
    w.run((TICKS - 13) * ROUND_TICK_MS + ROOM_TICK_MS);
    const [scored] = ofType(w.take(a), "scored");
    assert.equal(scored.at, TICKS);
    assert.equal(scored.pct, simulate(CARDS, view.seed, { ...CHOICE, closeAt: TICKS }).scorePct);
    assert.ok(!("back" in scored) && !("stake" in scored), "nothing of money in the score");
    assert.equal(w.core.meOf(a)!.stack, START_STACK, "however it went, the stack is as it was");
    assert.equal(store.puts, puts, "a round writes nothing to the account");
    assert.equal(w.core.leaderboard()[0].pct, scored.pct, "and goes on the board");
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

  await test("leaving settles an open round quietly at the last hour sent: on the board, nothing to the stack; a lay in flight dropped", async () => {
    const store = memoryAccounts();
    const w = world({ accounts: store });
    const [a, b] = [await w.join(), await w.join()];
    w.clear();
    const { view } = await w.lay(a);
    w.run(5 * ROUND_TICK_MS);
    w.core.leave(a);
    w.run(TICKS * ROUND_TICK_MS + 1000);
    assert.deepEqual(w.take(b).map((m) => m.t), ["board", "leave"], "the score on the board, then the leave");
    const res = simulate(CARDS, view.seed, { ...CHOICE, closeAt: 5 });
    assert.equal(w.core.leaderboard()[0].pct, res.scorePct, "scored at hour 5, the last sent");
    const acct = store.all().find((x) => x.name === w.core.leaderboard()[0].name)!;
    assert.equal(acct.stack, START_STACK);

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

  await test("a round whose heartbeat stalls past TICKS * ROUND_TICK_MS + 30 s settles at the last hour sent (tick 1 if none)", async () => {
    const w = world();
    const a = await w.join();
    w.take(a);
    const { laid, view } = await w.lay(a);
    w.advance(ROUND_TTL_MS - 500);
    assert.deepEqual(await w.close(a, "r-made-up"), [{ t: "error", why: "no such round" }], "an error just before");
    w.advance(501); // the heartbeat stalled all this while
    w.core.tick();
    const heard = w.take(a);
    assert.deepEqual(ofType(heard, "tick").map((m) => m.i), [1], "tick 1, then the score");
    const [scored] = ofType(heard, "scored");
    assert.equal(scored.at, 1);
    assert.equal(scored.pct, simulate(CARDS, view.seed, { ...CHOICE, closeAt: 1 }).scorePct);
    assert.equal(w.core.roundOf(a), null);
    w.advance(ERROR_GAP_MS);
    assert.deepEqual(await w.close(a, laid.roundId), [{ t: "error", why: "no such round" }]);
    const again = await w.lay(a);
    assert.ok(again.laid.roundId !== laid.roundId, "free to lay again");
  });

  // ---------------------------------------------------------------- the leaderboard

  await test("leaderboard: each name's best round, top 20 best first, rank of the score on the board (or null)", async () => {
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
    assert.deepEqual(out.map((m) => m.t), ["tick", "scored", "board"], "tick 1, scored, then the board");
    const boards = ofType(w.take(b), "board");
    assert.equal(boards.length, 1, "the first score changes the board");
    assert.equal(boards[0].rows[0].pct, ofType(out, "scored")[0].pct);
    assert.equal(w.saved.length, 1);
    let worse = false;
    let better = false;
    for (let i = 0; i < 23 && !(worse && better); i++) {
      const top = w.core.leaderboard()[0].pct;
      const { scored } = await w.playTo(a, 1 + ((i * 5) % 12));
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

  await test("malformed frames are ignored: not JSON, not an object, no type, unknown or retired type, binary, oversize, a flood", async () => {
    const w = world();
    const [a, b] = [await w.join(), await w.join()];
    w.clear();
    // the retired messages: the old rounds, and the wage, errands and the tower's question that went with them
    const retired = [
      '{"t":"round","pool":"CARDS / USDC"}',
      '{"t":"result","roundId":"r1","choice":{"widthBins":20,"offsetBins":0}}',
      '{"t":"pay"}',
      '{"t":"errand","take":true}',
      '{"t":"answer","hour":12}',
      '{"t":"spill","street":1}',
    ];
    for (const junk of ["", "{", "null", "[]", '"hi"', "42", '{"x":1}', '{"t":7}', '{"t":"shout","text":"hi"}', '{"t":"hello","strap":1}', ...retired]) {
      await w.core.message(a, junk);
    }
    await w.core.message(a, new ArrayBuffer(8));
    await w.core.message(a, JSON.stringify({ t: "emote", e: "wave", pad: "x".repeat(5000) }));
    assert.equal(w.all().length, 0, "nothing sent to anyone");
    assert.equal(w.core.meOf(a)!.stack, START_STACK);
    // flood: past MSG_BURST frames at one instant, even a good one is dropped
    w.advance(5000);
    for (let i = 0; i < MSG_BURST + 5; i++) await w.core.message(a, "{}");
    await w.send(a, { t: "emote", e: "cheer" });
    assert.equal(ofType(w.inbox(b), "emote").length, 0);
    assert.equal(ofType(w.take(a), "slow").length, 1);
  });

  await test("restore after a restart: back in the room by account, without a broadcast, first move trusted; the round in play is gone, the pockets are not", async () => {
    const store = memoryAccounts();
    const before = town({ accounts: store, coins: true });
    const a = await before.join({ strap: 4 });
    before.core.tick();
    const coin = before.core.coinsOnGround()[0];
    await before.goTo(a, coin.x, coin.z);
    await before.send(a, { t: "pick", note: coin.id });
    await before.lay(a);
    const acct = store.all()[0];
    assert.equal(acct.coins, 1, "the pocket is written at the pick");
    assert.equal(acct.coinCash, coin.v);
    // the object restarts: a new core on the same store, the socket still open (its own seed: ids come from the random)
    const w = world({ accounts: store, seed: 99 });
    const b = await w.join();
    w.clear();
    assert.equal(w.core.restore("zz0001", acct.id), true);
    assert.equal(w.all().length, 0, "no join broadcast");
    assert.equal(w.pos("zz0001").name, acct.name);
    assert.equal(w.pos("zz0001").strap, 4);
    assert.equal(w.core.meOf("zz0001")!.stack, START_STACK, "the round in play left no mark on the stack");
    assert.equal(w.core.meOf("zz0001")!.coins, 1, "the coin picked is still in the pocket");
    assert.equal(w.core.roundOf("zz0001"), null, "the round is gone");
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

  // ---------------------------------------------------------------- the account

  await test("accounts: a new visitor gets a key, a $1,000 stack and empty pockets; the key opens the same account again; a bad key starts afresh", async () => {
    const store = memoryAccounts();
    const w = world({ accounts: store });
    const a = await w.join({ strap: 2 });
    const [wel] = ofType(w.take(a), "welcome");
    assert.ok(wel.key && /^[A-Za-z0-9_-]{32}$/.test(wel.key), "a key for the browser to keep");
    assert.deepEqual(wel.me, { stack: START_STACK, coins: 0, day: "2026-09-24", coinsToday: 0, kit: DEFAULT_KIT, found: [] } satisfies Me);
    assert.deepEqual(Object.keys(wel.me).sort(), ME_KEYS, "the account as the page sees it: the count of coins, never their cash");
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
    await w.lay(a);
    w.run(3 * ROUND_TICK_MS);
    const b = await w.join({ key });
    assert.ok(w.inbox(a).some((m) => m.t === "elsewhere"));
    assert.deepEqual(w.closed.at(-1), { id: a, code: CLOSE_ELSEWHERE, reason: "elsewhere" });
    assert.equal(w.core.player(a), null);
    const [wel] = ofType(w.take(b), "welcome");
    assert.equal(wel.me.stack, START_STACK);
    assert.equal(wel.board.length, 1, "the round was settled onto the board, not stranded");
    assert.equal(w.core.roundOf(b), null);
  });

  await test("a round writes nothing to the account and sends no 'me'; the day's count is only ever written with a pick", async () => {
    const store = countingAccounts();
    const w = world({ accounts: store });
    const a = await w.join();
    w.take(a);
    assert.equal(store.puts, 1, "the hello: one insert");
    const me = w.core.meOf(a)!;
    for (let i = 0; i < 4; i++) await w.playTo(a, 1 + i * 9, { widthBins: 120, offsetBins: 0 });
    assert.equal(store.puts, 1, "four rounds: nothing written");
    assert.deepEqual(w.core.meOf(a), me, "the account is as it was");
    assert.equal(w.core.leaderboard().length, 1, "the name's best is on the board");
    assert.equal(w.saved.length >= 1, true, "the board is persisted, not the account");
    w.advance(24 * 3_600_000);
    w.takeAll(a);
    await w.playTo(a, 2);
    assert.equal(ofType(w.takeAll(a), "me").length, 0, "a new day says nothing at a lay");
    assert.equal(store.puts, 1);
    assert.equal(store.byId(w.joined[0].account)!.day, "2026-09-24", "the row is as it was");
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
        coins: false,
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
    const { laid, view } = await w.lay(a, LIVE.label, CHOICE);
    assert.equal(laid.real, false, "no stretch live enough: the simulated path");
    assert.equal(view.from, null);
    // the same history with the silences traded through: real
    const full = Array.from({ length: 100 }, (_, k) => [T0 + k * HR, 1, 1, 1, 1 + k * 0.001, 500]).reverse();
    const v = world({ pools: [LIVE], history: async () => full });
    const b = await v.join();
    v.take(b);
    assert.equal((await v.lay(b, LIVE.label, CHOICE)).laid.real, true);
    assert.ok(MIN_LIVE_HOURS >= 24 && MIN_LIVE_HOURS <= TICKS);
  });

  await test("new accounts per address: NEW_ACCOUNTS_PER_IP an hour, then full; a known key is not counted; another address is not", async () => {
    const w = world();
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

  await test("a spill under way is told to a visitor who joins during it, and a spill the room slept through is over when its time is, not resumed", async () => {
    const w = world({ coins: true });
    const a = await w.join();
    const hour = Math.ceil(w.now / HOUR_MS) * HOUR_MS;
    w.advance(hour - w.now + 1000);
    w.core.tick();
    const [told] = ofType(w.take(a), "spill");
    assert.ok(told, "the hour struck: a spill");
    const b = await w.join();
    const [wel] = ofType(w.take(b), "welcome");
    assert.deepEqual(wel.spill, { street: told.street, until: told.until }, "the newcomer is told the spill");
    w.core.leave(a);
    w.core.leave(b);
    // the room empties for a while: no heartbeats; ten minutes on, someone comes back
    w.advance(SPILL_MS + 10 * 60_000);
    const before = w.core.coinsOnGround().filter((c) => c.zone === "spill").length;
    const c = await w.join();
    w.take(c);
    for (let i = 0; i < 20; i++) w.core.tick();
    assert.equal(w.core.coinsOnGround().filter((x) => x.zone === "spill").length, before, "no burst of the coins it never dropped");
    assert.equal(w.core.spillNow(), null, "the spill is over");
    assert.equal(ofType(w.take(c), "spill").length, 0);
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

  // ---------------------------------------------------------------- the town

  /** the town's fakes: a walker routed along the plaza and the ring to any door, and the door messages paced */
  function town(opts: Parameters<typeof world>[0] = {}) {
    const w = world(opts);
    const t = {
      ...w,
      /** the clock (a spread copies a getter's value once; the room's clock moves) */
      get now() {
        return w.now;
      },
      /** a door's position as the server holds it (PLACES, or the desk), and the ground nearest it */
      door(id: string) {
        const d = doorOf(id);
        assert.ok(d, `the door ${id} is known`);
        const [x, z] = nearestWalkable(d.x, d.z);
        return { ...d, gx: x, gz: z };
      },
      /**
       * walk to (x, z) the way the ground allows: inside the plaza round the r 33 ring (clear of the fountain, the
       * board, the lamps at 31 and the trees at 36), on the boulevard round the r 46 ring (its carriageway, off the
       * rope's band), and between the two out or in through the nearest street's mouth in the rope, radially at the
       * street's own angle. A turn round a ring is legs of at most 0.45 rad, so no chord leaves it; the last leg is
       * the straight line to the target (a door off the kerb, or up a street from the ring at its angle)
       */
      async goTo(id: string, x: number, z: number) {
        const RING = 46;
        const p = w.pos(id);
        const a0 = Math.atan2(p.x, p.z);
        const a1 = Math.atan2(x, z);
        const inside = (px: number, pz: number) => Math.hypot(px, pz) < WORLD_RADIUS;
        const legs: [number, number][] = [];
        const on = (r: number, a: number): [number, number] => [Math.sin(a) * r, Math.cos(a) * r];
        const round = (r: number, from: number, to: number) => {
          let da = wrapAngle(to - from);
          for (let a = from; Math.abs(da) > 0.01; ) {
            const step = Math.sign(da) * Math.min(Math.abs(da), 0.45);
            a += step;
            da -= step;
            legs.push(on(r, a));
          }
        };
        const mouthNear = (a: number) => [...STREET_ANGLES].sort((u, v) => Math.abs(wrapAngle(a - u)) - Math.abs(wrapAngle(a - v)))[0];
        if (inside(p.x, p.z) && inside(x, z)) {
          if (Math.hypot(p.x, p.z) < 33) legs.push(on(33, a0));
          round(33, a0, a1);
          if (Math.hypot(x, z) > 40) legs.push(on(40, a1));
        } else if (!inside(p.x, p.z) && !inside(x, z)) {
          legs.push(on(RING, a0));
          round(RING, a0, a1);
        } else if (inside(p.x, p.z)) {
          const m = mouthNear(a1);
          if (Math.hypot(p.x, p.z) < 33) legs.push(on(33, a0));
          round(33, a0, m);
          legs.push(on(40, m), on(RING, m));
          round(RING, m, a1);
        } else {
          const m = mouthNear(a0);
          legs.push(on(RING, a0));
          round(RING, a0, m);
          legs.push(on(40, m), on(33, m));
          round(33, m, a1);
        }
        legs.push([x, z]);
        for (const [lx, lz] of legs) await w.walk(id, lx, lz);
      },
      /** walk to (x, z) the way town.ts's routeTo goes: leg by leg, the room accepting every step */
      async goRoute(id: string, x: number, z: number) {
        const p = w.pos(id);
        for (const [lx, lz] of routeTo(p.x, p.z, x, z)) await w.walk(id, lx, lz);
      },
      /** stand at the door (on the ground nearest it) */
      async at(id: string, place: string) {
        const d = t.door(place);
        await t.goTo(id, d.gx, d.gz);
      },
      /** stand 4 m short of the door, toward the plaza (walkable ground on the ring or the street) */
      async near(id: string, place: string) {
        const d = t.door(place);
        const r = Math.hypot(d.x, d.z);
        const k = (r - 4) / r;
        await t.goTo(id, d.x * k, d.z * k);
      },
      /** a door message, paced past the door gap and the error gap, and everything it answered */
      async knock(id: string, msg: Record<string, unknown>) {
        w.advance(ERROR_GAP_MS);
        w.takeAll(id);
        await w.send(id, msg);
        return w.takeAll(id);
      },
      async enter(id: string, place: string) {
        return t.knock(id, { t: "enter", place });
      },
      /** walk onto a coin and pick it up: everything the room answered the picker */
      async pick(id: string, coin: Coin) {
        await t.goTo(id, coin.x, coin.z);
        w.takeAll(id);
        await w.send(id, { t: "pick", note: coin.id });
        return w.takeAll(id);
      },
      /** walk to the desk and cash in: everything the room answered */
      async cashin(id: string) {
        await t.goTo(id, DESK_SPOT.x, DESK_SPOT.z);
        return t.knock(id, { t: "cashin" });
      },
      /** the coins down in a zone (its id, or "spill") */
      inZone: (zone: string) => w.core.coinsOnGround().filter((c) => c.zone === zone),
    };
    return t;
  }

  await test("town: the ground is walkable where the brief says, and a move is pulled back onto it", async () => {
    // the plaza, the ring, a street, its end; not the fountain, not a block, not past the town's edge
    assert.equal(walkable(0, 20), true, "the plaza");
    assert.equal(walkable(0, 3), false, "the fountain");
    assert.deepEqual(nearestWalkable(0, 3).map((v) => Math.round(v * 100) / 100), [0, 4.5], "pulled out of the fountain");
    const ring = [Math.sin(1.0) * 46, Math.cos(1.0) * 46] as const;
    assert.equal(walkable(ring[0], ring[1]), true, "the ring");
    assert.deepEqual(nearestWalkable(ring[0], ring[1]), [...ring], "on the ring already");
    const [as] = STREET_ANGLES;
    const on = [Math.sin(as) * 80, Math.cos(as) * 80] as const;
    assert.equal(walkable(on[0], on[1]), true, "a street's middle");
    assert.deepEqual(nearestWalkable(on[0], on[1]), [...on]);
    // beside the street: 5 m off the centre line is pavement, 12 m is a block, and the pull-back lands on the corridor's edge
    const side = [Math.cos(as), -Math.sin(as)] as const;
    const pave = [on[0] + side[0] * 5, on[1] + side[1] * 5] as const;
    assert.equal(walkable(pave[0], pave[1]), true, "the pavement");
    const block = [on[0] + side[0] * 12, on[1] + side[1] * 12] as const;
    assert.equal(walkable(block[0], block[1]), false, "a block");
    const back = nearestWalkable(block[0], block[1]);
    assert.equal(walkable(back[0], back[1]), true);
    const perp = Math.abs((back[0] - on[0]) * side[0] + (back[1] - on[1]) * side[1]);
    assert.ok(Math.abs(perp - STREET_HALF_WIDTH_M) < 0.05, `to the corridor's edge (${perp})`);
    // between two streets (due east, the bank's front), past the ring, is façade: pulled back to the ring's outer kerb
    const wall = [60, 0] as const;
    assert.equal(walkable(wall[0], wall[1]), false);
    const kerb = nearestWalkable(wall[0], wall[1]);
    assert.ok(Math.abs(Math.hypot(kerb[0], kerb[1]) - 49.25) < 0.05, "the kerb");
    // the street ends at TOWN_RADIUS
    assert.equal(walkable(Math.sin(as) * (TOWN_RADIUS + 5), Math.cos(as) * (TOWN_RADIUS + 5)), false, "past the end");
    // the room: a legal walk out through a mouth and up the street stands; a step into a block is corrected back
    const w = town();
    const a = await w.join();
    w.take(a);
    await w.goTo(a, on[0], on[1]);
    const p = w.pos(a);
    assert.ok(Math.hypot(p.x - on[0], p.z - on[1]) < 0.05, "walked up the street");
    w.advance(1000 / MOVE_HZ);
    w.take(a);
    await w.send(a, { t: "move", x: on[0] + side[0] * 0.7, z: on[1] + side[1] * 0.7, ry: 0, moving: true });
    assert.deepEqual(w.take(a), [], "a step on the pavement is not corrected");
    await w.goTo(a, pave[0], pave[1]);
    for (let i = 0; i < 4; i++) {
      w.advance(1000 / MOVE_HZ);
      const q = w.pos(a);
      await w.send(a, { t: "move", x: q.x + side[0] * 0.7, z: q.z + side[1] * 0.7, ry: 0, moving: true });
    }
    const heard = ofType(w.take(a), "moves");
    assert.ok(heard.length >= 1, "the step into the block was corrected");
    const q = w.pos(a);
    const off = Math.abs((q.x - on[0]) * side[0] + (q.z - on[1]) * side[1]);
    assert.ok(off <= STREET_HALF_WIDTH_M + 0.01, `held at the corridor's edge (${off})`);
    // the desk and every place are doors; the Guard House is scenery now; a made-up door is not
    assert.ok(doorOf(PLACE_IDS.desk) && doorOf(PLACE_IDS.hatter));
    assert.equal(doorOf(PLACE_IDS.desk)!.r, DESK_SPOT.r, "the desk's wider reach");
    assert.equal(doorOf(PLACE_IDS.guardHouse), null);
    assert.equal(doorOf("the-moon"), null);
    for (const pl of PLACES) assert.equal(doorOf(pl.id)!.r, DOOR_REACH_M, pl.id);
  });

  await test("town: the rope is a line: a step across it off a mouth is refused, a walk out through a mouth lands", async () => {
    // the shape: the band round the rope is off the ground, its two edges are on it, and at a street's mouth it is open
    const rope = WORLD_RADIUS;
    assert.equal(walkable(0, rope), false, "the rope, at 0 rad");
    assert.equal(walkable(0, rope - ROPE_BAND_M), true, "the band's inner edge");
    assert.equal(walkable(0, rope + ROPE_BAND_M), true, "its outer edge");
    const [as] = STREET_ANGLES;
    assert.equal(inMouth(as), true);
    assert.equal(inMouth(0), false);
    assert.equal(walkable(Math.sin(as) * rope, Math.cos(as) * rope), true, "the mouth");
    const cm = (v: number) => Math.round(v * 100) / 100;
    assert.deepEqual(nearestWalkable(0, rope + 0.2).map(cm), [0, rope + ROPE_BAND_M], "pulled to the nearer side");
    assert.deepEqual(nearestWalkable(0, rope - 0.2).map(cm), [0, rope - ROPE_BAND_M]);
    assert.equal(crossesRope(0, rope - 1, 0, rope + 1), true, "over the rope at 0 rad");
    assert.equal(crossesRope(0, rope + 1, 0, rope - 1), true, "and back");
    assert.equal(crossesRope(Math.sin(as) * (rope - 1), Math.cos(as) * (rope - 1), Math.sin(as) * (rope + 1), Math.cos(as) * (rope + 1)), false, "through the mouth");
    assert.equal(crossesRope(0, rope - 2, 0, rope - 1), false, "inside, no crossing");
    // the room, at 0 rad: a step onto the band is pulled back to the plaza's side; a step over the rope, well within
    // the budget, is refused and the player told where they are
    const w = town();
    const a = await w.join();
    w.takeAll(a);
    await w.walk(a, 0, rope - 1);
    w.advance(1000 / MOVE_HZ);
    w.take(a);
    await w.send(a, { t: "move", x: 0, z: rope - 0.5, ry: 0, moving: true });
    assert.ok(Math.abs(w.pos(a).z - (rope - ROPE_BAND_M)) < 0.01, "held at the band's edge");
    assert.deepEqual(w.take(a), [], "a pull of 0.25 m is silent");
    w.advance(1000);
    await w.send(a, { t: "move", x: 0, z: rope + 1, ry: 0, moving: true });
    assert.ok(Math.abs(w.pos(a).z - (rope - ROPE_BAND_M)) < 0.01, "not moved");
    assert.equal(ofType(w.take(a), "moves").length, 1, "refused and told");
    w.advance(1000);
    await w.send(a, { t: "move", x: 0, z: rope + 0.5, ry: 0, moving: true });
    assert.ok(w.pos(a).z < rope, "a step onto the band's far half would be pulled to the far side: a crossing, refused");
    assert.equal(ofType(w.take(a), "moves").length, 1);
    // through the mouth: the same step at the street's angle lands, nothing to correct
    await w.goTo(a, Math.sin(as) * (rope - 1), Math.cos(as) * (rope - 1));
    w.advance(1000);
    w.take(a);
    await w.send(a, { t: "move", x: Math.sin(as) * (rope + 1), z: Math.cos(as) * (rope + 1), ry: 0, moving: true });
    assert.ok(Math.hypot(w.pos(a).x, w.pos(a).z) > rope, "on the boulevard");
    assert.deepEqual(w.take(a), [], "nothing to correct");
  });

  await test("town: routeTo walks the plaza, a mouth, the ring's middle and a street's centre, never over the rope", () => {
    const door = (id: string) => {
      const p = PLACES.find((q) => q.id === id)!;
      return [p.x, p.z] as const;
    };
    const desk = [DESK_SPOT.x, DESK_SPOT.z] as const;
    const [east, north, west] = STREET_ANGLES;
    const at = (a: number, r: number) => [Math.sin(a) * r, Math.cos(a) * r] as const;
    // every leg of a route is a straight walk on walkable ground that never crosses the rope but at a mouth
    const legal = (name: string, from: readonly [number, number], to: readonly [number, number]) => {
      const path = routeTo(from[0], from[1], to[0], to[1]);
      assert.ok(path.length >= 1, `${name}: a route`);
      assert.deepEqual(path[path.length - 1], nearestWalkable(to[0], to[1]), `${name}: ends at the target, on the ground`);
      // a walker stands on the ground: a door on the pavement is walked from the kerb it was pulled to
      let [px, pz] = nearestWalkable(from[0], from[1]);
      path.forEach(([qx, qz], i) => {
        assert.equal(crossesRope(px, pz, qx, qz), false, `${name}: leg ${i} crosses the rope`);
        const n = Math.max(1, Math.ceil(Math.hypot(qx - px, qz - pz) / 0.25));
        for (let k = 0; k <= n; k++) {
          const x = px + ((qx - px) * k) / n;
          const z = pz + ((qz - pz) * k) / n;
          assert.ok(walkable(x, z), `${name}: leg ${i} off the ground at (${x.toFixed(1)}, ${z.toFixed(1)}) r ${Math.hypot(x, z).toFixed(1)}`);
        }
        [px, pz] = [qx, qz];
      });
      return path;
    };
    // the plaza to a ring door: in at the east mouth, along the ring
    const toHatter = legal("desk to the hatter", desk, door("hatter"));
    assert.ok(toHatter.length >= 3 && toHatter.some(([x, z]) => Math.abs(Math.hypot(x, z) - 40.5) < 0.01 && Math.abs(Math.atan2(x, z) - east) < 0.01), "through the east mouth");
    assert.ok(Math.hypot(...toHatter[toHatter.length - 1]) <= KERB_OUT + 1e-6, "the door pulled to the kerb");
    legal("desk to the merchants' bank", desk, door("merchants-bank"));
    // the plaza to a street's end: out along the street's centre line
    const toEnd = legal("plaza centre to the north end", [0, 6], door("north-end"));
    assert.ok(toEnd.filter(([x, z]) => Math.hypot(x, z) > KERB_OUT + 5).length >= 3, "waypoints out along the street");
    // ring to ring the long way round: an arc, never a chord across the plaza
    const round = legal("hatter to the crescent's bookseller", door("hatter"), door("bookseller-crescent"));
    assert.ok(round.length >= 2 && round.slice(0, -1).every(([x, z]) => Math.abs(Math.hypot(x, z) - 46) < 0.01), `an arc along the ring's middle (${round.length} waypoints)`);
    // one street to another: in, round, out
    legal("east street to west street", at(east, 80), at(west, 80));
    // the ring to the desk: back in through a mouth
    const home = legal("ring to the desk", at(1.0, 46), desk);
    assert.ok(home.some(([x, z]) => Math.abs(Math.hypot(x, z) - 40.5) < 0.01), "in through a mouth");
    // the same ground: straight there
    assert.deepEqual(routeTo(0, 20, 10, 25), [[10, 25]], "plaza to plaza is one waypoint");
    assert.deepEqual(routeTo(...at(north, 70), ...at(north, 90)), [[...at(north, 90)]], "a street to itself is one waypoint");
    assert.deepEqual(routeTo(...at(1.0, 46), ...at(1.2, 47)), [[...at(1.2, 47)]], "ring to ring nearby is one waypoint");
    // a leg across the plaza bends round the fountain
    const across = legal("across the plaza", [-20, 0], [20, 0]);
    assert.equal(across.length, 2, "one bend round the fountain");
  });

  await test("town: the ring road, the lanes and the quarters are ground; their water and buildings are not, and a step into them is pulled back out", () => {
    const at = (a: number, r: number) => [Math.sin(a) * r, Math.cos(a) * r] as const;
    const cm = (v: number) => Math.round(v * 100) / 100;
    // the ring road: an annulus RING_ROAD_HALF_M either side of RING_ROAD_R, all the way round
    for (const a of [0.3, 1.0, 2.2, 3.1, 4.4, 5.9]) {
      assert.equal(walkable(...at(a, RING_ROAD_R)), true, `the ring road at ${a}`);
      assert.equal(walkable(...at(a, RING_ROAD_IN + 0.1)), true, "its inner edge");
      assert.equal(walkable(...at(a, RING_ROAD_R + RING_ROAD_HALF_M + 3)), false, "the blocks beyond it");
      const back = nearestWalkable(...at(a, RING_ROAD_R + RING_ROAD_HALF_M + 3));
      assert.ok(Math.abs(Math.hypot(...back) - (RING_ROAD_R + RING_ROAD_HALF_M)) < 0.01, "pulled to its outer edge");
    }
    // a lane leaves a street across the blocks' line at LANE_T; the blocks either side of it are not ground
    const [east] = STREET_ANGLES;
    const on = (t: number, s: number) => [t * Math.sin(east) + s * Math.cos(east), t * Math.cos(east) - s * Math.sin(east)] as const;
    assert.equal(walkable(...on((LANE_T[0] + LANE_T[1]) / 2, 15)), true, "the lane");
    assert.equal(walkable(...on((LANE_T[0] + LANE_T[1]) / 2, -15)), true, "the lane on the other side");
    assert.equal(walkable(...on(LANE_T[0] - 3, 15)), false, "the block before it");
    assert.equal(walkable(...on(LANE_T[1] + 3, 15)), false, "the block after it");
    const intoLane = nearestWalkable(...on(LANE_T[0] - 1, 15));
    assert.ok(Math.abs(intoLane[0] * Math.sin(east) + intoLane[1] * Math.cos(east) - LANE_T[0]) < 0.01, "pulled to the lane's edge");
    // each quarter: its gate, its waypoints and the ground about its landmark are ground; the plaza's side of it is not
    for (const q of QUARTERS) {
      for (const [p, qq] of [...q.gates, ...q.nodes]) assert.ok(walkable(...inQuarter(q, p, qq)), `${q.id}: (${p}, ${qq})`);
      assert.equal(walkable(...inQuarter(q, q.rIn - 3, 0)), false, `${q.id}: short of its ground`);
      assert.equal(quarterAt(...inQuarter(q, q.rIn + 4, 0))?.qr.id, q.id, `${q.id}: its own ground`);
      for (const o of q.obstacles) {
        const [p, qq] = o.kind === "disc" ? [o.p, o.q] : [(o.p0 + o.p1) / 2, (o.q0 + o.q1) / 2];
        const [x, z] = inQuarter(q, p, qq);
        const deck = q.decks.some((d) => p >= d.p0 && p <= d.p1 && qq >= d.q0 && qq <= d.q1);
        assert.equal(walkable(x, z), deck, `${q.id}: ${deck ? "the deck over" : "not"} the ${o.kind} at (${p}, ${qq})`);
        const [bx, bz] = nearestWalkable(x, z);
        assert.ok(walkable(bx, bz), `${q.id}: pulled out onto ground`);
        // to its nearest edge (the canal's portals sit at the blocks' line, so their nearest ground is a few metres off)
        if (!deck) assert.ok(Math.hypot(bx - x, bz - z) < (o.kind === "disc" ? o.r : Math.min(o.p1 - o.p0, o.q1 - o.q0) / 2) + 6, `${q.id}: near its edge`);
      }
    }
    // the canal: the water either side of the bridge is not ground, the bridge is, and a step off the deck lands on it
    const canal = QUARTERS.find((q) => q.id === "canal")!;
    const deck = canal.decks[0];
    assert.equal(walkable(...inQuarter(canal, (deck.p0 + deck.p1) / 2, 0)), true, "the bridge");
    assert.equal(walkable(...inQuarter(canal, (deck.p0 + deck.p1) / 2, deck.q1 + 1)), false, "the water beside it");
    const onto = nearestWalkable(...inQuarter(canal, (deck.p0 + deck.p1) / 2, deck.q1 + 1));
    assert.deepEqual(toLocal(canal, ...onto).map(cm), [(deck.p0 + deck.p1) / 2, deck.q1], "onto the deck's edge");
    // the station: the shed and the train are not ground; the platforms between them are
    const station = QUARTERS.find((q) => q.id === "station")!;
    assert.equal(walkable(...inQuarter(station, 90, -9.5)), true, "the platform");
    assert.equal(walkable(...inQuarter(station, 90, -3)), false, "the train");
    assert.equal(walkable(...inQuarter(station, 110, 0)), false, "the shed");
    assert.equal(walkable(...inQuarter(station, 110, 19)), true, "the yard beside the shed");
    // anywhere at all: the pull-back lands on ground, and leaves a point on the ground where it is
    let s = 17;
    const rng = () => ((s = (s * 1103515245 + 12345) % 2147483648), s / 2147483648);
    for (let i = 0; i < 4000; i++) {
      const x = (rng() * 2 - 1) * (TOWN_RADIUS + 10);
      const z = (rng() * 2 - 1) * (TOWN_RADIUS + 10);
      const [nx, nz] = nearestWalkable(x, z);
      assert.ok(walkable(nx, nz), `(${x.toFixed(1)}, ${z.toFixed(1)}) -> (${nx.toFixed(1)}, ${nz.toFixed(1)}) is ground`);
      if (walkable(x, z)) assert.deepEqual([nx, nz], [x, z]);
    }
  });

  await test("town: routeTo's graph links only clear walks, and reaches every quarter from the desk and the ring road round", () => {
    // every link of the graph is a straight walk on the ground
    let links = 0;
    ROUTE_GRAPH.links.forEach((ls, i) => {
      for (const j of ls) {
        if (j < i) continue;
        links++;
        const [ax, az] = ROUTE_GRAPH.pts[i];
        const [bx, bz] = ROUTE_GRAPH.pts[j];
        const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.25);
        for (let k = 0; k <= n; k++) assert.ok(walkable(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n), `link ${i}-${j} off the ground`);
      }
    });
    assert.ok(links > 150, `${links} links`);
    assert.ok(ROUTE_GRAPH.links.every((ls) => ls.length > 0), "no node is an island");
    const legal = (name: string, from: readonly [number, number], to: readonly [number, number]) => {
      const path = routeTo(from[0], from[1], to[0], to[1]);
      assert.deepEqual(path[path.length - 1], nearestWalkable(to[0], to[1]), `${name}: ends at the target`);
      let [px, pz] = nearestWalkable(from[0], from[1]);
      path.forEach(([qx, qz], i) => {
        assert.equal(crossesRope(px, pz, qx, qz), false, `${name}: leg ${i} crosses the rope`);
        const n = Math.max(1, Math.ceil(Math.hypot(qx - px, qz - pz) / 0.25));
        for (let k = 0; k <= n; k++) assert.ok(walkable(px + ((qx - px) * k) / n, pz + ((qz - pz) * k) / n), `${name}: leg ${i} off the ground near (${qx.toFixed(0)}, ${qz.toFixed(0)})`);
        [px, pz] = [qx, qz];
      });
      return path;
    };
    const desk = [DESK_SPOT.x, DESK_SPOT.z] as const;
    const at = (a: number, r: number) => [Math.sin(a) * r, Math.cos(a) * r] as const;
    for (const q of QUARTERS) {
      const gate = PLACES.find((p) => p.id === q.id)!;
      const there = legal(`desk to the ${q.id}'s gate`, desk, [gate.x, gate.z]);
      assert.ok(there.some(([x, z]) => Math.abs(Math.hypot(x, z) - 40.5) < 0.01), `${q.id}: out through a mouth`);
      // to the landmark's side: a waypoint of the quarter's own is a point on its ground
      const [nx, nz] = inQuarter(q, ...q.nodes[0]);
      legal(`desk to the ${q.id}`, desk, [nx, nz]);
      legal(`the ${q.id} back to the desk`, [nx, nz], desk);
      // in by a lane: from the street a quarter turn before it, at the lane, the walk crosses the blocks' line once
      const street = STREET_ANGLES.findIndex((s) => Math.abs(((q.a - Math.PI / 4 - s + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 1e-9);
      const from = at(STREET_ANGLES[street], (LANE_T[0] + LANE_T[1]) / 2);
      const lane = legal(`${STREET_NAMES[street]} street into the ${q.id}`, from, [nx, nz]);
      // the walk passes through the lane (a point of a leg between the street's corridor and the blocks' back line)
      let [px, pz] = from;
      let viaLane = false;
      for (const [qx, qz] of lane) {
        for (let k = 0; k <= 40; k++) {
          const x = px + ((qx - px) * k) / 40;
          const z = pz + ((qz - pz) * k) / 40;
          const sa = STREET_ANGLES[street];
          const t = x * Math.sin(sa) + z * Math.cos(sa);
          const ss = Math.abs(x * Math.cos(sa) - z * Math.sin(sa));
          if (t >= LANE_T[0] && t <= LANE_T[1] && ss > STREET_HALF_WIDTH_M + 1 && ss < 24) viaLane = true;
        }
        [px, pz] = [qx, qz];
      }
      assert.ok(viaLane, `${q.id}: by the lane, not the ring road`);
    }
    // the ring road round, and from a quarter to the next by it
    const round = legal("the ring road round", at(0.3, RING_ROAD_R), at(3.0, RING_ROAD_R + 1));
    assert.ok(round.slice(0, -1).every(([x, z]) => Math.abs(Math.hypot(x, z) - RING_ROAD_R) < 0.01), "along the road's middle");
    legal("the park to the canal's wharf", inQuarter(QUARTERS[0], 100, 26), inQuarter(QUARTERS[1], 118, 4));
    legal("the station's platform to the gazette", inQuarter(QUARTERS[3], 88, -9.5), [PLACES.find((p) => p.id === "gazette")!.x, PLACES.find((p) => p.id === "gazette")!.z]);
    // on the same ground a straight clear walk is one waypoint; not through the water
    const canal = QUARTERS[1];
    assert.deepEqual(routeTo(...inQuarter(canal, 96, 8), ...inQuarter(canal, 96, -8)), [inQuarter(canal, 96, -8)], "along the towpath: straight");
    const over = legal("across the canal", inQuarter(canal, 96, 12), inQuarter(canal, 112, 12));
    assert.ok(over.some(([x, z]) => Math.abs(toLocal(canal, x, z)[1]) <= 3), "by the bridge");
  });

  await test("town: a quarter's gate is a door on the ring road, reached by the route the town gives, found once, nothing to enter; the ring road's fronts are doors too", async () => {
    const w = town();
    const a = await w.join();
    w.takeAll(a);
    for (const q of QUARTERS) {
      const gate = PLACES.find((p) => p.id === q.id)!;
      assert.equal(gate.kind, "quarter");
      assert.ok(Math.abs(Math.hypot(gate.x, gate.z) - RING_ROAD_IN) < 0.01, `${q.id}: on the ring road's inner edge`);
    }
    const park = PLACES.find((p) => p.id === "park")!;
    await w.goRoute(a, park.x, park.z);
    const p = w.pos(a);
    assert.ok(Math.hypot(p.x - park.x, p.z - park.z) < DOOR_REACH_M, `at the park's gate (${Math.hypot(p.x - park.x, p.z - park.z).toFixed(2)} m)`);
    const heard = await w.enter(a, "park");
    assert.deepEqual(ofType(heard, "found"), [{ t: "found", place: "park" }]);
    assert.deepEqual(ofType(heard, "place"), [{ t: "place", id: "park" }], "nothing to enter: the id alone");
    assert.deepEqual(ofType(await w.enter(a, "park"), "found"), [], "found once");
    assert.deepEqual(w.core.meOf(a)!.found, ["park"]);
    // from the gate along the road to the Grand Hotel's door, a discovery like any front's
    const hotel = PLACES.find((p) => p.id === "grand-hotel")!;
    await w.goRoute(a, hotel.x, hotel.z);
    assert.deepEqual(ofType(await w.enter(a, "grand-hotel"), "found"), [{ t: "found", place: "grand-hotel" }]);
    // 4 m short of the canal's gate is not there
    const canal = PLACES.find((p) => p.id === "canal")!;
    await w.goRoute(a, canal.x, canal.z + 4);
    assert.deepEqual(ofType(await w.enter(a, "canal"), "error"), [{ t: "error", why: "not there" }]);
    assert.equal(w.core.meOf(a)!.stack, START_STACK, "a discovery pays nothing");
  });

  await test("town: a new account wears the default kit and everyone sees it", async () => {
    const w = town();
    const a = await w.join();
    const wel = ofType(w.takeAll(a), "welcome")[0];
    assert.deepEqual(wel.me.kit, DEFAULT_KIT);
    assert.deepEqual(wel.players.find((p) => p.id === a)!.kit, DEFAULT_KIT);
    assert.deepEqual(wel.me.found, []);
    const b = await w.join();
    const join = ofType(w.take(a), "join")[0];
    assert.deepEqual(join.p.kit, DEFAULT_KIT);
    assert.ok(b);
  });

  await test("town: enter at a door records the discovery once (nothing paid), and 4 m off it is 'not there'", async () => {
    const store = countingAccounts();
    const w = town({ accounts: store });
    const a = await w.join();
    w.takeAll(a);
    const puts = store.puts;
    // short of the door: refused, nothing written, nothing found
    await w.near(a, PLACE_IDS.hatter);
    const d = w.door(PLACE_IDS.hatter);
    const p = w.pos(a);
    assert.ok(Math.hypot(p.x - d.x, p.z - d.z) > DOOR_REACH_M, "standing out of reach");
    assert.deepEqual(await w.enter(a, PLACE_IDS.hatter), [{ t: "error", why: "not there" }]);
    assert.equal(store.puts, puts, "nothing written");
    // a door that does not exist, and the Guard House, which is none
    assert.deepEqual(await w.enter(a, "the-moon"), [{ t: "error", why: "not there" }]);
    assert.deepEqual(await w.enter(a, PLACE_IDS.guardHouse), [{ t: "error", why: "not there" }]);
    // at the door: found, the shop's stock; the account written once; the stack untouched
    await w.at(a, PLACE_IDS.hatter);
    const heard = await w.enter(a, PLACE_IDS.hatter);
    assert.deepEqual(heard.map((m) => m.t), ["found", "place", "me"]);
    assert.deepEqual(heard[0], { t: "found", place: PLACE_IDS.hatter });
    const place = ofType(heard, "place")[0];
    assert.equal(place.id, PLACE_IDS.hatter);
    assert.deepEqual(
      place.stock,
      STOCK.filter((s) => s.shop === "hatter").map((s) => ({ item: s.item, price: s.price, owned: false })),
    );
    const me = ofType(heard, "me")[0].me;
    assert.equal(me.stack, START_STACK, "a discovery pays nothing");
    assert.deepEqual(me.found, [PLACE_IDS.hatter]);
    assert.equal(store.puts, puts + 1, "one write");
    // again: the interior, nothing written
    const again = await w.enter(a, PLACE_IDS.hatter);
    assert.deepEqual(again.map((m) => m.t), ["place"]);
    assert.equal(store.puts, puts + 1, "a second visit writes nothing");
    // the desk is a door but not a discovery
    await w.goTo(a, DESK_SPOT.x, DESK_SPOT.z);
    assert.deepEqual(await w.enter(a, PLACE_IDS.desk), [{ t: "place", id: PLACE_IDS.desk }]);
    assert.equal(store.puts, puts + 1);
    assert.deepEqual(w.core.meOf(a)!.found, [PLACE_IDS.hatter]);
    // the door gap: two knocks inside DOOR_GAP_MS, the second dropped with "slow"
    await w.at(a, PLACE_IDS.cigars);
    await w.enter(a, PLACE_IDS.cigars);
    w.advance(DOOR_GAP_MS - 1);
    await w.send(a, { t: "enter", place: PLACE_IDS.cigars });
    assert.deepEqual(w.takeAll(a), [{ t: "slow" }]);
    // the discoveries come back with the account
    const key = ofType(w.inbox(a), "welcome")[0]?.key ?? null;
    void key;
    assert.deepEqual(store.byId(w.joined[0].account)!.found, [PLACE_IDS.hatter, PLACE_IDS.cigars]);
  });

  await test("town: the Coffee House repeats the plaza's last phrases, newest first, minutes ago", async () => {
    const w = town();
    const a = await w.join();
    const b = await w.join();
    w.takeAll(a);
    w.takeAll(b);
    for (let i = 0; i < TALK_ROWS + 2; i++) {
      w.advance(60_000);
      await w.send(i % 2 ? a : b, { t: "say", p: PHRASES[i % PHRASES.length] });
    }
    w.advance(3 * 60_000);
    assert.equal(w.core.talk().length, TALK_ROWS, "the last TALK_ROWS only");
    const nameA = w.pos(a).name;
    const nameB = w.pos(b).name;
    assert.equal(w.core.talk()[0].phrase, PHRASES[(TALK_ROWS + 1) % PHRASES.length], "newest first");
    assert.equal(w.core.talk()[0].name, nameA);
    assert.equal(w.core.talk()[1].name, nameB);
    assert.equal(w.core.talk()[0].ago, 3);
    assert.equal(w.core.talk()[TALK_ROWS - 1].ago, 3 + TALK_ROWS - 1);
    // the interior carries it; the talk was saved as it grew
    await w.at(a, PLACE_IDS.coffeeEast);
    const place = ofType(await w.enter(a, PLACE_IDS.coffeeEast), "place")[0];
    assert.deepEqual(place.talk, w.core.talk());
    assert.equal(w.savedTalk.length, TALK_ROWS + 2);
    assert.equal(w.savedTalk[w.savedTalk.length - 1].length, TALK_ROWS);
    // a room brought up on stored talk keeps it; bad rows are dropped
    const w2 = town({ talk: [...w.savedTalk[w.savedTalk.length - 1], { name: "x", phrase: "Hello", at: 1 }, { name: nameA, phrase: "typed", at: 1 }] });
    assert.equal(w2.core.talk().length, TALK_ROWS);
    assert.deepEqual(cleanTalk("nonsense"), []);
  });

  await test("town: the tower shows the room's UTC hour at the climb and inside; a climb anywhere else is 'not there'", async () => {
    const w = town();
    const a = await w.join();
    w.takeAll(a);
    assert.deepEqual(await w.knock(a, { t: "climb" }), [{ t: "error", why: "not there" }]);
    await w.near(a, PLACE_IDS.clockTower);
    assert.deepEqual(await w.knock(a, { t: "climb" }), [{ t: "error", why: "not there" }], "4 m off");
    await w.at(a, PLACE_IDS.clockTower);
    const climbed = ofType(await w.knock(a, { t: "climb" }), "place")[0];
    assert.deepEqual(climbed, { t: "place", id: PLACE_IDS.clockTower, hour: hourOf(w.now) });
    assert.equal(new Date(w.now).getUTCHours(), climbed.hour);
    const entered = ofType(await w.enter(a, PLACE_IDS.clockTower), "place")[0];
    assert.equal(entered.hour, hourOf(w.now), "the interior shows the hour too");
    w.advance(3_600_000);
    assert.equal(ofType(await w.knock(a, { t: "climb" }), "place")[0].hour, (climbed.hour + 1) % 24, "an hour on, the next hour");
    assert.deepEqual(await w.knock(a, { t: "answer", hour: climbed.hour }), [], "there is no question");
  });

  await test("town: the shops sell one of each from the stack, at the right door, and the kit goes to everyone", async () => {
    const store = countingAccounts();
    const w = town({ accounts: store });
    const a = await w.join();
    const b = await w.join();
    const key = ofType(w.takeAll(a), "welcome")[0].key!;
    w.takeAll(b);
    // not at the shop: refused; at the Cigars, a hat is still "not there"
    assert.deepEqual(await w.knock(a, { t: "buy", item: "boater" }), [{ t: "error", why: "not there" }]);
    await w.at(a, PLACE_IDS.cigars);
    assert.deepEqual(await w.knock(a, { t: "buy", item: "boater" }), [{ t: "error", why: "not there" }]);
    assert.deepEqual(await w.knock(a, { t: "buy", item: "top" }), [], "not an item: ignored");
    // 4 m off the Hatter: refused
    await w.near(a, PLACE_IDS.hatter);
    assert.deepEqual(await w.knock(a, { t: "buy", item: "boater" }), [{ t: "error", why: "not there" }]);
    // at the Hatter: a crown is more than the stack; a boater is bought from the stack, worn, and told to everyone
    await w.at(a, PLACE_IDS.hatter);
    w.takeAll(b);
    assert.deepEqual(await w.knock(a, { t: "buy", item: "crown" }), [{ t: "error", why: "no stack" }]);
    const puts = store.puts;
    const heard = await w.knock(a, { t: "buy", item: "boater" });
    assert.deepEqual(heard.filter((m) => m.t !== "stacks").map((m) => m.t), ["bought", "me", "kit", "stack"]);
    assert.deepEqual(heard[0], { t: "bought", item: "boater" });
    const me = ofType(heard, "me")[0].me;
    assert.equal(me.stack, START_STACK - 400);
    assert.deepEqual(me.kit, { ...DEFAULT_KIT, hat: "boater" });
    assert.deepEqual(ofType(heard, "kit")[0], { t: "kit", id: a, kit: { ...DEFAULT_KIT, hat: "boater" } });
    assert.deepEqual(ofType(w.takeAll(b), "kit"), [{ t: "kit", id: a, kit: { ...DEFAULT_KIT, hat: "boater" } }]);
    assert.equal(store.puts, puts + 1, "one write");
    assert.deepEqual(w.core.player(a)!.kit, { ...DEFAULT_KIT, hat: "boater" });
    // again: "have one", nothing written; the stock says so
    assert.deepEqual(await w.knock(a, { t: "buy", item: "boater" }), [{ t: "error", why: "have one" }]);
    assert.equal(store.puts, puts + 1);
    const stock = ofType(await w.enter(a, PLACE_IDS.hatter), "place")[0].stock!;
    assert.deepEqual(stock.map((s) => [s.item, s.owned]), [["boater", true], ["cap", false], ["crown", false]]);
    // a cap replaces the boater (one hat is worn); the default coat is ink, so the Tailor's ink coat is had already
    await w.knock(a, { t: "buy", item: "cap" });
    assert.equal(w.core.meOf(a)!.kit.hat, "cap");
    const tailor = PLACES.find((q) => shopOf(q.id) === "tailor")!;
    await w.at(a, tailor.id);
    assert.deepEqual(await w.knock(a, { t: "buy", item: "coat-ink" }), [{ t: "error", why: "have one" }]);
    await w.knock(a, { t: "buy", item: "coat-cloth" });
    assert.equal(w.core.meOf(a)!.kit.coat, "Cloth");
    assert.equal(w.core.meOf(a)!.stack, START_STACK - 400 - 250 - 200, "every purchase from the stack, nothing else moved it");
    // a cane is more than what is left; the other player buys one: either Glover sells it, and the other says "have one"
    const glovers = PLACES.filter((q) => shopOf(q.id) === "glover");
    assert.equal(glovers.length, 2, "a Glover on the ring and one in the Crescent");
    await w.at(a, glovers[1].id);
    assert.deepEqual(await w.knock(a, { t: "buy", item: "cane" }), [{ t: "error", why: "no stack" }]);
    await w.at(b, glovers[1].id);
    await w.knock(b, { t: "buy", item: "cane" });
    assert.equal(w.core.meOf(b)!.kit.cane, true);
    assert.equal(w.core.meOf(b)!.stack, START_STACK - 600);
    await w.at(b, glovers[0].id);
    assert.deepEqual(await w.knock(b, { t: "buy", item: "cane" }), [{ t: "error", why: "have one" }]);
    // the kit comes back with the account: a new session wears it, and the others see it in the join
    w.core.leave(a);
    w.takeAll(b);
    const c = await w.join({ strap: 0, key });
    const wel = ofType(w.takeAll(c), "welcome")[0];
    assert.deepEqual(wel.me.kit, { hat: "cap", coat: "Cloth", cane: false, glasses: false, cigar: false });
    assert.deepEqual(wel.players.find((q) => q.id === b)!.kit, { ...DEFAULT_KIT, cane: true });
    assert.deepEqual(ofType(w.takeAll(b), "join")[0].p.kit, wel.me.kit);
  });

  await test("town: the four street ends are doors at the end of the walkable street, found once each in any order", async () => {
    const w = town();
    const a = await w.join();
    w.takeAll(a);
    const order = [PLACE_IDS.westEnd, PLACE_IDS.southEnd, PLACE_IDS.southEnd, PLACE_IDS.eastEnd, PLACE_IDS.northEnd];
    for (const [i, end] of order.entries()) {
      await w.at(a, end);
      const p = w.pos(a);
      assert.ok(Math.hypot(p.x, p.z) > 100, `stood at the ${end} (r ${Math.hypot(p.x, p.z).toFixed(1)})`);
      const heard = await w.enter(a, end);
      assert.equal(ofType(heard, "found").length, i === 2 ? 0 : 1, `${end} found ${i === 2 ? "before" : "once"}`);
      assert.deepEqual(ofType(heard, "place"), [{ t: "place", id: end }], "nothing to enter: the id alone");
    }
    assert.deepEqual(w.core.meOf(a)!.found, [PLACE_IDS.westEnd, PLACE_IDS.southEnd, PLACE_IDS.eastEnd, PLACE_IDS.northEnd]);
    assert.equal(w.core.meOf(a)!.stack, START_STACK);
  });

  // ---------------------------------------------------------------- the coins

  await test("coins: COIN_ZONES is the plaza, the ring, each street and a mark at each end, the ring road, each quarter and a mark at its landmark: ~100 coins worth more the farther out", () => {
    assert.equal(COIN_ZONES.length, 2 + 2 * STREET_NAMES.length + 1 + 2 * QUARTERS.length);
    assert.equal(COINS_ON_GROUND, 6 + 10 + 4 * 8 + 4 + 12 + 4 * 6 + 4);
    const byId = new Map(COIN_ZONES.map((z) => [z.id, z]));
    assert.deepEqual(byId.get("plaza"), { id: "plaza", ground: "plaza", kind: "coin", count: 6, min: 5, max: 25 });
    assert.deepEqual(byId.get("ring"), { id: "ring", ground: "ring", kind: "coin", count: 10, min: 10, max: 40 });
    for (const s of STREET_NAMES) {
      assert.deepEqual(byId.get(s), { id: s, ground: s, kind: "coin", count: 8, min: 20, max: 80 });
      assert.deepEqual(byId.get(`${s}-mark`), { id: `${s}-mark`, ground: s, kind: "mark", count: 1, min: 100, max: 100 });
    }
    assert.deepEqual(byId.get("ring-road"), { id: "ring-road", ground: "ring-road", kind: "coin", count: 12, min: 30, max: 60 });
    for (const q of QUARTERS) {
      assert.deepEqual(byId.get(q.id), { id: q.id, ground: q.id, kind: "coin", count: 6, min: 40, max: 90 });
      assert.deepEqual(byId.get(`${q.id}-mark`), { id: `${q.id}-mark`, ground: q.id, kind: "mark", count: 1, min: 100, max: 100 });
    }
    assert.equal(COINS_PER_DAY, 150);
    // the balance the brief sets out: an active hour on the streets lands about a band; a whole day's cap is a few
    const streetMean = (20 + 80) / 2;
    assert.equal(4 * 8 * streetMean, 1600, "on the streets at once, refilling");
    assert.ok(COINS_PER_DAY * 45 < 7 * BAND, "a full day of gathering is under seven bands");
  });

  await test("coins: coinSpot lands every zone's coins on walkable ground in its zone, clear of the doors and keepers, the fountain, the furniture and the rope; 500 draws each; the gap between coins holds", () => {
    const rng = seeded(31);
    const inZone = (zone: CoinZone, x: number, z: number) => {
      const g = groundOf(x, z);
      assert.ok(onGround(zone, x, z), `${zone.id}: (${x}, ${z}) is on the ${g.ground}`);
      const q = QUARTERS.find((qq) => qq.id === zone.ground);
      if (q) {
        // on its quarter's ground: never in the water or a building, clear of every fixture; a mark about the landmark
        const [p, qq] = toLocal(q, x, z);
        for (const f of q.fixtures) assert.ok(Math.hypot(p - f.p, qq - f.q) >= f.r + COIN_FIXTURE_M - 1e-9, `${zone.id}: clear of the fixture at (${f.p}, ${f.q})`);
        const d = Math.hypot(p - q.landmark.p, qq - q.landmark.q);
        if (zone.kind === "mark") assert.ok(d >= q.landmark.r0 - 1e-6 && d <= q.landmark.r1 + 1e-6, `${zone.id}: at the landmark (${d.toFixed(1)} m)`);
        return;
      }
      if (zone.kind === "mark") assert.ok(g.t >= MARK_COIN_T[0] - 1e-9 && g.t <= MARK_COIN_T[1] + 1e-9, `${zone.id}: a mark near the end (t ${g.t.toFixed(1)})`);
      if (zone.ground === "plaza") assert.ok(g.t < WORLD_RADIUS - ROPE_BAND_M - 1, `${zone.id}: inside the rope`);
      if (zone.ground === "ring") assert.ok(g.t > WORLD_RADIUS + ROPE_BAND_M && g.t <= KERB_OUT, `${zone.id}: on the boulevard, off the rope's band`);
    };
    for (const zone of COIN_ZONES) {
      let n = 0;
      for (let i = 0; i < 500; i++) {
        const spot = coinSpot(zone, rng, []);
        assert.ok(spot, `${zone.id}: a spot on an empty ground`);
        const [x, z] = spot;
        n++;
        assert.ok(walkable(x, z), `${zone.id}: walkable (${x}, ${z})`);
        inZone(zone, x, z);
        assert.ok(Math.hypot(x, z) > FOUNTAIN_R + 2, "clear of the fountain");
        for (const p of PLACES) assert.ok(Math.hypot(x - p.x, z - p.z) >= COIN_DOOR_M, `${zone.id}: ${COIN_DOOR_M} m from the ${p.id}'s door`);
        for (const k of KEEPERS) assert.ok(Math.hypot(x - k.x, z - k.z) >= 1.5, `${zone.id}: clear of the ${k.id}'s keeper`);
        if (zone.ground === "plaza") for (const [fx, fz, fr] of PLAZA_FIXTURES) assert.ok(Math.hypot(x - fx, z - fz) >= fr, "clear of the plaza's furniture");
        assert.equal(x, Math.round(x * 100) / 100, "centimetres");
      }
      assert.equal(n, 500);
      // a zone filling up: each new coin COIN_GAP_M from the ones down (a spill's, SPILL_GAP_M); an end holds its
      // mark and a spill's
      const room = zone.kind === "mark" ? 2 : zone.count + 2;
      for (const gap of [COIN_GAP_M, SPILL_GAP_M]) {
        const down: { x: number; z: number }[] = [];
        for (let i = 0; i < room; i++) {
          const spot = coinSpot(zone, rng, down, gap);
          assert.ok(spot, `${zone.id}: room for ${room} at ${gap} m`);
          for (const c of down) assert.ok(Math.hypot(spot[0] - c.x, spot[1] - c.z) >= gap, `${zone.id}: ${gap} m apart`);
          down.push({ x: spot[0], z: spot[1] });
        }
      }
    }
    // a ground packed solid answers null rather than a spot on top of another (packed until the sampler's tries find
    // nothing five times running, so the last gap it could have found by luck is filled too)
    const plaza = COIN_ZONES[0];
    const packed: { x: number; z: number }[] = [];
    for (let i = 0, misses = 0; i < 400 && misses < 5; i++) {
      const spot = coinSpot(plaza, rng, packed, 12);
      if (!spot) {
        misses++;
        continue;
      }
      misses = 0;
      packed.push({ x: spot[0], z: spot[1] });
    }
    assert.ok(packed.length >= 3 && packed.length < 400, `packed with ${packed.length} at 12 m: then none`);
    assert.equal(coinSpot(plaza, rng, packed, 12), null);
  });

  await test("coins: every zone fills on the heartbeat, one of its own every COIN_EVERY_MS (a mark every MARK_EVERY_MS), to its count; the ground is told a coin and its kind, never its worth", async () => {
    const w = town({ coins: true });
    const a = await w.join();
    w.takeAll(a);
    w.core.tick();
    assert.equal(w.core.coinsOnGround().length, COIN_ZONES.length, "the first heartbeat: one from each zone");
    for (const zone of COIN_ZONES) assert.equal(w.inZone(zone.id).length, 1, zone.id);
    w.run(COIN_EVERY_MS - ROOM_TICK_MS);
    assert.equal(w.core.coinsOnGround().length, COIN_ZONES.length, "nothing more inside the pace");
    w.run(2 * ROOM_TICK_MS);
    const refilling = COIN_ZONES.filter((z) => z.count > 1).length;
    assert.equal(w.core.coinsOnGround().length, COIN_ZONES.length + refilling, "COIN_EVERY_MS on: one more from each zone short of its count (the marks are full)");
    w.run(Math.max(...COIN_ZONES.map((z) => z.count)) * COIN_EVERY_MS);
    const ground = w.core.coinsOnGround();
    assert.equal(ground.length, COINS_ON_GROUND, "every zone full");
    for (const zone of COIN_ZONES) {
      const mine = w.inZone(zone.id);
      assert.equal(mine.length, zone.count, zone.id);
      for (const c of mine) {
        assert.equal(c.kind, zone.kind);
        assert.ok(Number.isInteger(c.v) && c.v >= zone.min && c.v <= zone.max, `${zone.id}: worth $${c.v}`);
        assert.ok(onGround(zone, c.x, c.z), `${zone.id}: on its ground`);
        assert.ok(walkable(c.x, c.z));
      }
      assert.ok(mine.every((c) => mine.every((d) => c === d || Math.hypot(c.x - d.x, c.z - d.z) >= COIN_GAP_M)), `${zone.id}: spaced`);
    }
    // the wire: each landing told as { id, x, z, kind }, and no frame ever carried a coin's worth
    const told = ofType(w.takeAll(a), "notes");
    assert.equal(told.length, COINS_ON_GROUND, "one message per coin");
    for (const m of told) {
      assert.equal(m.add.length, 1);
      assert.deepEqual(m.gone, []);
      assert.deepEqual(Object.keys(m.add[0]).sort(), ["id", "kind", "x", "z"]);
    }
    for (const json of w.wire) assert.ok(!json.includes('"v"') && !json.includes('"zone"'), `a coin's worth on the wire: ${json}`);
    w.run(10 * COIN_EVERY_MS);
    assert.equal(w.core.coinsOnGround().length, COINS_ON_GROUND, "full stays full");
    // a newcomer is told the ground in welcome, the same way
    const b = await w.join();
    const wel = ofType(w.takeAll(b), "welcome")[0];
    assert.equal(wel.notes.length, COINS_ON_GROUND);
    assert.deepEqual(Object.keys(wel.notes[0]).sort(), ["id", "kind", "x", "z"]);
    assert.equal(wel.notes.filter((n) => n.kind === "mark").length, COIN_ZONES.filter((z) => z.kind === "mark").length, "the marks stand out: one at each street's end and each quarter's landmark");
    // a mark taken comes back after MARK_EVERY_MS, not COIN_EVERY_MS; a street's coin after COIN_EVERY_MS
    const mark = w.inZone("east-mark")[0];
    await w.pick(a, mark);
    assert.equal(w.inZone("east-mark").length, 0);
    w.run(COIN_EVERY_MS * 2);
    assert.equal(w.inZone("east-mark").length, 0, "no mark yet");
    w.run(MARK_EVERY_MS - COIN_EVERY_MS * 2 + ROOM_TICK_MS);
    assert.equal(w.inZone("east-mark").length, 1, "the mark is back");
    assert.equal(w.inZone("east-mark")[0].v, 100);
    const east = w.inZone("east")[0];
    await w.pick(a, east);
    assert.equal(w.inZone("east").length, 7);
    w.run(COIN_EVERY_MS + ROOM_TICK_MS);
    assert.equal(w.inZone("east").length, 8, "the street's coin is back");
    // an empty room drops nothing; the room is told nothing it did not ask for
    w.core.leave(a);
    w.core.leave(b);
    w.takeAll(a);
    const before = w.core.coinsOnGround().length;
    w.run(5 * COIN_EVERY_MS);
    assert.equal(w.core.coinsOnGround().length, before, "nobody in: nothing dropped");
  });

  await test("coins: a pick within reach puts the coin in the pockets, not the stack; everyone sees a bubble with its worth; 'me' says the count only; a coin gone stays gone", async () => {
    const store = countingAccounts();
    const w = town({ coins: true, accounts: store });
    const a = await w.join();
    const b = await w.join();
    w.core.tick();
    w.clear();
    const coin = w.inZone("plaza")[0];
    const puts = store.puts;
    // from afar: nothing
    await w.send(a, { t: "pick", note: coin.id });
    assert.equal(w.core.coinsOnGround().length, COIN_ZONES.length, "too far: still there");
    assert.equal(w.takeAll(a).length, 0);
    // within NOTE_REACH: into the pockets
    await w.goTo(a, coin.x + NOTE_REACH * 0.7, coin.z);
    w.takeAll(a);
    w.takeAll(b);
    await w.send(a, { t: "pick", note: coin.id });
    const heard = w.takeAll(a);
    assert.deepEqual(heard.map((m) => m.t), ["picked", "me"], "the bubble (to the picker too), then the account; no stack message");
    assert.deepEqual(heard[0], { t: "picked", id: a, note: coin.id, v: coin.v });
    const me = ofType(heard, "me")[0].me;
    assert.equal(me.stack, START_STACK, "nothing to the stack");
    assert.equal(me.coins, 1);
    assert.equal(me.coinsToday, 1);
    assert.deepEqual(Object.keys(me).sort(), ME_KEYS, "no cash in the account the page sees");
    assert.deepEqual(w.takeAll(b), [{ t: "picked", id: a, note: coin.id, v: coin.v }], "everyone sees what it was worth");
    assert.equal(store.puts, puts + 1, "one write");
    const row = store.byId(w.joined[0].account)!;
    assert.equal(row.coins, 1);
    assert.equal(row.coinCash, coin.v, "the worth is the store's");
    assert.equal(row.stack, START_STACK);
    assert.equal(w.core.player(a)!.stack, START_STACK, "the name tag's stack stands");
    // gone is gone: the same id again, or one that never was, answers { notes, gone } so the walker stops asking
    await w.send(a, { t: "pick", note: coin.id });
    assert.deepEqual(w.takeAll(a), [{ t: "notes", add: [], gone: [coin.id] }]);
    assert.equal(w.core.meOf(a)!.coins, 1);
    await w.send(a, { t: "pick", note: "n0000000" });
    assert.deepEqual(w.takeAll(a), [{ t: "notes", add: [], gone: ["n0000000"] }]);
    await w.send(a, { t: "pick", note: "x".repeat(40) });
    assert.deepEqual(w.takeAll(a), [], "an id that could never be a coin gets no answer");
    assert.equal(store.puts, puts + 1, "nothing more written");
    // a second coin: the pockets add up, and only the server knows to what
    const next = w.inZone("ring")[0];
    const heard2 = await w.pick(a, next);
    assert.equal(ofType(heard2, "me")[0].me.coins, 2);
    assert.equal(store.byId(w.joined[0].account)!.coinCash, coin.v + next.v);
    for (const json of w.wire) assert.ok(!json.includes("coinCash"), `the cash leaked: ${json}`);
  });

  await test("coins: cashin at the desk moves the pockets into the stack (cashed then me, the stack to the room); 4 m off it is 'not there'; nothing carried is 0 and 0 and no write", async () => {
    const store = countingAccounts();
    const w = town({ coins: true, accounts: store });
    const a = await w.join();
    const b = await w.join();
    w.run(COIN_EVERY_MS + ROOM_TICK_MS);
    const [c1, c2] = w.inZone("plaza");
    await w.pick(a, c1);
    await w.pick(a, c2);
    assert.equal(w.core.meOf(a)!.coins, 2);
    const puts = store.puts;
    // 4 m outside the desk's reach: refused, nothing moved, nothing written
    await w.goTo(a, DESK_SPOT.x, DESK_SPOT.z + DESK_SPOT.r + 4);
    assert.deepEqual(await w.knock(a, { t: "cashin" }), [{ t: "error", why: "not there" }]);
    assert.equal(w.core.meOf(a)!.coins, 2);
    assert.equal(store.puts, puts);
    // at the desk
    w.takeAll(b);
    const heard = await w.cashin(a);
    assert.deepEqual(heard.filter((m) => m.t !== "stacks").map((m) => m.t), ["cashed", "me", "stack"]);
    assert.deepEqual(heard[0], { t: "cashed", coins: 2, cash: c1.v + c2.v });
    const me = ofType(heard, "me")[0].me;
    assert.equal(me.stack, START_STACK + c1.v + c2.v);
    assert.equal(me.coins, 0);
    assert.equal(me.coinsToday, 2, "the day's count is not the pockets");
    assert.deepEqual(ofType(heard, "stack"), [{ t: "stack", id: a, stack: START_STACK + c1.v + c2.v }]);
    const told = w.takeAll(b);
    assert.deepEqual(ofType(told, "stack"), [{ t: "stack", id: a, stack: START_STACK + c1.v + c2.v }], "the room sees the new stack (name tags)");
    assert.equal(ofType(told, "stacks").at(-1)!.rows[0].stack, START_STACK + c1.v + c2.v, "the biggest stacks moved");
    assert.equal(store.puts, puts + 1, "one write");
    const row = store.byId(w.joined[0].account)!;
    assert.deepEqual([row.stack, row.coins, row.coinCash], [START_STACK + c1.v + c2.v, 0, 0]);
    assert.equal(w.core.player(a)!.stack, row.stack);
    // nothing carried: 0 and 0, nothing written, nobody told
    assert.deepEqual(await w.knock(a, { t: "cashin" }), [{ t: "cashed", coins: 0, cash: 0 }]);
    assert.equal(store.puts, puts + 1);
    assert.equal(w.takeAll(b).length, 0);
    // the desk's pace: two inside DOOR_GAP_MS, the second dropped with "slow"
    await w.send(a, { t: "cashin" });
    assert.deepEqual(w.takeAll(a), [{ t: "slow" }]);
    assert.equal(BAND, 1000);
  });

  await test("coins: COINS_PER_DAY a day, 'notes done' past it (the coin stays), and the count rolls with the UTC day", async () => {
    // an account a coin short of the cap, opened by its key
    const store = countingAccounts();
    const key = "K".repeat(32);
    const full: Account = {
      id: "acap",
      name: "Steady Otter 44",
      strap: 1,
      stack: 2500,
      coins: 3,
      coinCash: 90,
      day: "2026-09-24",
      coinsToday: COINS_PER_DAY - 1,
      created: 1,
      seen: 1,
      kit: { ...DEFAULT_KIT },
      found: [],
    };
    store.put(full, `plain:${key}`);
    const w = town({ coins: true, accounts: store });
    const a = await w.join({ strap: 1, key });
    assert.equal(ofType(w.takeAll(a), "welcome")[0].me.coinsToday, COINS_PER_DAY - 1);
    w.core.tick();
    const [c1, c2] = [w.inZone("plaza")[0], w.inZone("ring")[0]];
    const heard = await w.pick(a, c1);
    assert.equal(ofType(heard, "me")[0].me.coinsToday, COINS_PER_DAY, "the last of the day");
    assert.equal(w.core.meOf(a)!.coins, 4);
    const puts = store.puts;
    const refused = await w.pick(a, c2);
    assert.deepEqual(refused, [{ t: "error", why: "notes done" }]);
    assert.ok(w.core.coinsOnGround().some((c) => c.id === c2.id), "the coin stays for someone else");
    assert.equal(w.core.meOf(a)!.coins, 4);
    assert.equal(store.puts, puts, "nothing written");
    // the next UTC day: the count starts again, the pockets do not
    w.advance(24 * HOUR_MS);
    w.takeAll(a);
    await w.send(a, { t: "pick", note: c2.id });
    const me = ofType(w.takeAll(a), "me")[0].me;
    assert.equal(me.day, "2026-09-25");
    assert.equal(me.coinsToday, 1);
    assert.equal(me.coins, 5);
    assert.equal(store.byId("acap")!.coinCash, 90 + c1.v + c2.v);
    assert.equal(store.byId("acap")!.day, "2026-09-25", "the roll is written with the pick");
  });

  await test("coins: the Mint spills on the hour from the clock alone: one street, SPILL_COINS over SPILL_MS then a mark at its end, told to everyone, counting against the cap, nothing persisted; no message triggers it; a room woken past the hour skips it", async () => {
    const store = countingAccounts();
    const w = town({ coins: true, accounts: store });
    const a = await w.join();
    const b = await w.join();
    w.run(11 * COIN_EVERY_MS + 2 * ROOM_TICK_MS); // the ring road's twelfth coin lands on the heartbeat after 220 s
    assert.equal(w.core.coinsOnGround().length, COINS_ON_GROUND);
    w.clear();
    const puts = store.puts;
    const saves = w.saved.length + w.savedTalk.length;
    // up to a hair before 13:00: nothing; a message that names a spill: nothing
    const hour = Math.ceil(w.now / HOUR_MS) * HOUR_MS;
    await w.send(a, { t: "spill", street: 2, until: hour });
    w.advance(hour - w.now - ROOM_TICK_MS);
    w.core.tick();
    assert.equal(w.core.spillNow(), null, "not yet");
    assert.equal(ofType(w.all(), "spill").length, 0);
    // the first heartbeat of the hour
    w.run(ROOM_TICK_MS);
    const s = w.core.spillNow();
    assert.ok(s, "the spill is on");
    assert.ok(s!.street >= 0 && s!.street < STREET_NAMES.length && Number.isInteger(s!.street));
    assert.equal(s!.until, w.now + SPILL_MS);
    assert.deepEqual(ofType(w.takeAll(a), "spill"), [{ t: "spill", street: s!.street, until: s!.until }], "told to a");
    assert.deepEqual(ofType(w.takeAll(b), "spill"), [{ t: "spill", street: s!.street, until: s!.until }], "and to b");
    assert.equal(w.inZone("spill").length, 1, "the first coin lands at once");
    // one every SPILL_MS / SPILL_COINS, on the street, worth the street's range
    const every = SPILL_MS / SPILL_COINS;
    w.run(every * 10);
    const after10 = w.inZone("spill").length;
    assert.ok(after10 >= 10 && after10 <= 12, `ten spills in: ${after10} coins`);
    w.run(SPILL_MS - every * 10 + ROOM_TICK_MS);
    const spilled = w.inZone("spill");
    assert.equal(spilled.length, SPILL_COINS + 1, "SPILL_COINS, then the mark");
    assert.equal(w.core.spillNow(), null, "over");
    const street = STREET_NAMES[s!.street];
    const zone = COIN_ZONES.find((z) => z.id === street)!;
    for (const c of spilled) {
      assert.equal(groundOf(c.x, c.z).ground, street, "on the spill's street");
      assert.ok(walkable(c.x, c.z));
      if (c.kind === "mark") assert.equal(c.v, 100);
      else assert.ok(c.v >= zone.min && c.v <= zone.max, `worth $${c.v}`);
    }
    assert.equal(spilled.filter((c) => c.kind === "mark").length, 1, "one mark, at the end");
    assert.ok(groundOf(spilled.find((c) => c.kind === "mark")!.x, spilled.find((c) => c.kind === "mark")!.z).t >= MARK_COIN_T[0] - 1e-9);
    assert.equal(w.inZone(street).length, zone.count, "the street's own coins are not the spill's, and stay");
    assert.equal(w.core.coinsOnGround().length, COINS_ON_GROUND + SPILL_COINS + 1);
    // nothing persisted: no account written, no board or talk saved
    assert.equal(store.puts, puts);
    assert.equal(w.saved.length + w.savedTalk.length, saves);
    // a spilled coin is a coin: picked into the pockets, counted against the day
    const one = spilled.find((c) => c.kind === "coin")!;
    const me = ofType(await w.pick(a, one), "me")[0].me;
    assert.equal(me.coins, 1);
    assert.equal(me.coinsToday, 1);
    assert.equal(store.byId(w.joined[0].account)!.coinCash, one.v);
    // the next hour spills again, on a street of the clock's draw; meanwhile nothing a client sends brings one on
    w.takeAll(a);
    for (const msg of [{ t: "spill" }, { t: "spill", street: 1 }, { t: "mint" }, { t: "tick" }]) await w.send(a, msg);
    w.run(1000);
    assert.equal(w.core.spillNow(), null);
    assert.equal(ofType(w.takeAll(a), "spill").length, 0);
    w.advance(hour + HOUR_MS - w.now - ROOM_TICK_MS);
    w.run(2 * ROOM_TICK_MS);
    assert.ok(w.core.spillNow(), "the next hour's spill");
    // a room woken past the hour (it hibernated empty) skips that hour's spill: the clock alone, and only on the hour
    const late = town({ coins: true, at: Date.parse("2026-09-24T14:10:00Z") });
    const c = await late.join();
    late.run(1000);
    assert.equal(late.core.spillNow(), null, "ten past: no spill");
    late.advance(Date.parse("2026-09-24T15:00:00Z") - late.now - ROOM_TICK_MS);
    late.run(2 * ROOM_TICK_MS);
    assert.ok(late.core.spillNow(), "15:00: a spill");
    assert.ok(SPILL_GRACE_MS < 10 * 60_000);
    void c;
  });

  await test("coins: a stored account with the old shape (jobs, errands, a wage, a stake) is cleaned to the new one; bad values put right", () => {
    const old = {
      id: "a1",
      name: "Amber Badger 12",
      strap: 2,
      stack: 1500,
      staked: 300,
      day: "2026-09-23",
      wagePaid: true,
      jobs: { range: { have: 3, paid: false } },
      rounds: 4,
      notes: 7,
      created: 1,
      seen: 2,
      kit: { ...DEFAULT_KIT, hat: "boater" },
      found: ["hatter", "east-end"],
      errand: { id: "clock", step: 0, done: [] },
      errandsDone: ["hatter", "ledger"],
      daily: null,
      owed: 150,
    } as unknown as Account;
    assert.deepEqual(cleanAccount(old), {
      id: "a1",
      name: "Amber Badger 12",
      strap: 2,
      stack: 1800,
      coins: 0,
      coinCash: 0,
      day: "2026-09-23",
      coinsToday: 0,
      created: 1,
      seen: 2,
      kit: { ...DEFAULT_KIT, hat: "boater" },
      found: ["hatter", "east-end"],
    } satisfies Account, "the stack (a lost round's stake back in it), kit and doors kept; the rest gone; the pockets empty");
    const bad = cleanAccount({
      id: "a2",
      name: "Quiet Owl 17",
      strap: 9,
      stack: -5,
      coins: 2.7,
      coinCash: "40",
      coinsToday: 999,
      kit: { hat: "fez", coat: "Cloth", cane: "yes", glasses: true },
      found: ["hatter", 3, "hatter"],
    } as unknown as Account);
    assert.deepEqual(bad, {
      id: "a2",
      name: "Quiet Owl 17",
      strap: STRAPS.length - 1,
      stack: 0,
      coins: 2,
      coinCash: 0,
      day: "",
      coinsToday: COINS_PER_DAY,
      created: 0,
      seen: 0,
      kit: { hat: "top", coat: "Cloth", cane: false, glasses: true, cigar: false },
      found: ["hatter"],
    } satisfies Account);
    const fresh = cleanAccount({ id: "a3", name: "Bold Fox 21" } as unknown as Account);
    assert.equal(fresh.stack, START_STACK, "no stack: a new one");
    assert.equal(fresh.coins, 0);
    // a stored row from before the coins, opened by its key: the room writes it back in the new shape
    const store = memoryAccounts();
    const key = "O".repeat(32);
    store.put(old, `plain:${key}`);
    const w = world({ accounts: store });
    const a = w.core.open()!;
    w.advance(1000);
    void w.send(a, { t: "hello", strap: 0, key });
    return new Promise<void>((resolve) =>
      setImmediate(() => {
        const wel = ofType(w.takeAll(a), "welcome")[0];
        assert.equal(wel.me.stack, 1800);
        assert.deepEqual(Object.keys(wel.me).sort(), ME_KEYS);
        const row = store.byId("a1") as unknown as Record<string, unknown>;
        assert.deepEqual(Object.keys(row).sort(), ["coinCash", "coins", "coinsToday", "created", "day", "found", "id", "kit", "name", "seen", "stack", "strap"], "the old fields are gone from the row");
        assert.equal(row.day, dayOf(w.now), "rolled to today");
        resolve();
      }),
    );
  });

  console.log(`\ngame room: ${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
