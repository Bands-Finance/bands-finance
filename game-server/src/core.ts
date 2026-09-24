/**
 * THE EXCHANGE ROOM AS PLAIN LOGIC (bands.finance Play). One RoomCore holds everyone in the town. It knows nothing
 * of Cloudflare: the Durable Object (room.ts) hands it sockets as ids, the tests (src/scripts/test-game-room.ts) hand
 * it fakes. Every rule of the wire contract (web/src/game/protocol.ts) is enforced here:
 *
 *   - names are made here from two curated word lists and two digits; nothing a visitor sends ever becomes text
 *     another visitor reads (emotes and phrases are allow-listed ids, errors are fixed server strings)
 *   - positions are rate limited, pulled back onto the town's walkable ground (town.ts, the one shape the client
 *     collides with; the rope is crossed only at a street's mouth) and checked against MAX_SPEED; a rejected move
 *     is answered with a correction: a { t: "moves" } carrying the player's OWN id, sent only to them. Batched moves
 *     never carry the recipient's own entry, so an own-id entry always means "snap back to this".
 *   - the coins (24 Sep, the simple town): COIN_ZONES of town.ts says how many lie on the plaza, the ring, each
 *     street, the ring road and each quarter, and a mint mark at each street's end and each quarter's landmark; each
 *     zone refills one of its own every COIN_EVERY_MS (a mark every MARK_EVERY_MS) while anyone is in. A coin's worth is drawn here from its zone's range and kept here: the ground
 *     is told a coin and its kind, a pick is told what it was worth. A pick puts the coin in the account's pockets
 *     (coins, coinCash); a "cashin" at Mr Bands' desk moves the cash into the stack. COINS_PER_DAY a day (UTC).
 *     Once an hour, on the room's clock and nothing else, the Mint spills SPILL_COINS along one street over
 *     SPILL_MS, then a mark at its end; nothing of it is persisted (a restart just skips one).
 *   - a round is played here: the player lays a band on a pool from the server's own copy of the live board, the
 *     server deals a seed it never sends, runs simulate() once and streams the result one tick at a time as its
 *     clock reaches each tick (tick()). The score is simulate() re-run with the hour it settled at, so the browser
 *     never holds the seed or a tick ahead of time. The stalls are practice only: a stake sent with a lay is refused,
 *     no round touches a stack, and every settled round goes on the Best rounds board (each name's best).
 *   - the hours are real where they can be: the room reads the pool's hourly history (historySource) and deals a
 *     random 48-hour stretch of it (a Market) with MIN_LIVE_HOURS of volume, named to the player only once the round
 *     is scored. A pool too new for that, or a history that can't be read, plays the seeded simulation as before.
 *   - the stack: a visitor's account (name, strap, stack, pockets, kit, the doors found) is kept in an AccountStore,
 *     opened again by a key only their browser holds (its hash is what is stored). The store is written only when
 *     something changed: a keyless hello is one insert, a cash-in of nothing none.
 *   - the town's doors: a visitor standing within DOOR_REACH_M of a door may enter it (the first time is remembered
 *     in the account's `found`) and is answered what the interior shows: a shop's STOCK (bought for the stack, worn at
 *     once and told to everyone), the tower's hour (the room's own UTC hour), the Coffee House's last TALK_ROWS
 *     phrases said in the plaza (room-level).
 */
import {
  cleanKit,
  COINS_PER_DAY,
  DEFAULT_KIT,
  DESK_SPOT,
  DOOR_REACH_M,
  isEmote,
  isItem,
  isPhrase,
  owns,
  PLACE_IDS,
  shopOf,
  STOCK,
  TALK_ROWS,
  wear,
  MAX_SPEED,
  MOVE_HZ,
  NOTE_REACH,
  ROOM_CAP,
  ROUND_TICK_MS,
  START_STACK,
  STRAPS,
  TICK_HZ,
  WORLD_RADIUS,
} from "../../web/src/game/protocol";
import type { ItemId, Kit, Me, Note, PhraseId, PlayerState, S2C, ScoreRow, StackRow, TalkRow } from "../../web/src/game/protocol";
import { COIN_ZONES, coinSpot, crossesRope, nearestWalkable, PLACES, STREET_NAMES } from "../../web/src/game/town";
import type { CoinZone } from "../../web/src/game/town";
import { MARKET_HOURS, marketWindow, poolParamsFromHot, seriesOf, simulate, TICKS, validateChoice } from "../../web/src/game/lpGame";
import type { History, Market, PoolParams, SimResult } from "../../web/src/game/lpGame";

// ---------------------------------------------------------------- limits

/** a message longer than this is dropped unread */
export const MAX_MESSAGE_CHARS = 2048;
/** every message a socket sends draws from this bucket (a flood guard over all types) */
export const MSG_RATE = 30;
export const MSG_BURST = 60;
/** moves: MOVE_HZ a second, with this much burst for network bunching */
export const MOVE_BURST = 5;
/** a player told { t: "slow" } is not told again for this long */
export const SLOW_NOTICE_MS = 5_000;
/** emotes and phrases together: one a second */
export const SOCIAL_GAP_MS = 1_000;
/** lays: one a second */
export const LAY_GAP_MS = 1_000;
/** { t: "error" } replies: one per this long (a round's expiry notice is always sent) */
export const ERROR_GAP_MS = 2_000;
/** doors (enter, climb, buy, and the desk's cashin): one per this long; a door answered is a write at most, never a fetch */
export const DOOR_GAP_MS = 300;
/** hellos with no (or no known) key open a new account each: the room lets this many through a second, this many at once */
export const KEYLESS_HELLO_RATE = 1;
export const KEYLESS_HELLO_BURST = 10;
/** a new account's insert is tried with this many fresh names before the socket is given up on */
export const INSERT_TRIES = 3;
/** a round still open this long after it was laid is dropped, whatever state it is in */
export const ROUND_TTL_MS = TICKS * ROUND_TICK_MS + 30_000;
/** the leaderboard: each name's best, this many rows */
export const BOARD_ROWS = 20;
/** the pools a band can be laid on: the first this many parsable rows of hot.json */
export const BOARD_POOLS = 12;
export const BOARD_TTL_MS = 2 * 60_000;
/** after a failed board fetch, wait this long before trying again */
export const BOARD_RETRY_MS = 15_000;
/** a pool's hourly history is read again after this long (a new hour has closed) */
export const HISTORY_TTL_MS = 20 * 60_000;
/** after a failed history read, that pool plays simulated for this long before it is tried again */
export const HISTORY_RETRY_MS = 2 * 60_000;
/** histories kept at once (the board has BOARD_POOLS pools; the board changes) */
export const HISTORY_KEEP = 32;
/** a socket that has not said hello by now is closed */
export const HELLO_TIMEOUT_MS = 10_000;
/** open sockets (joined or not) beyond this are turned away at the door */
export const MAX_CONNECTIONS = ROOM_CAP + 20;
/** the speed check refills a player's distance budget for at most this many seconds between two moves */
export const MAX_STEP_SECONDS = 2;
/**
 * the most distance a player can have in hand: a quarter second of sprint plus a metre of slack. Each move refills
 * the budget at MAX_SPEED for the time since the last one (a per-move slack let a 12 Hz client walk at 21 m/s)
 */
export const BUDGET_CAP_M = MAX_SPEED * 0.5 + 1;
/** a dealt stretch of real history must have this many of its 48 hours with volume (the rest may be gap-filled flat) */
export const MIN_LIVE_HOURS = 36;
/** new accounts one address may open, per hour (a keyless or unknown-key hello); beyond it, "full" */
export const NEW_ACCOUNTS_PER_IP = 5;
export const IP_WINDOW_MS = 3_600_000;
/** a clamp that moves the player more than this sends them a correction */
export const CORRECTION_M = 0.5;
/**
 * visitors arrive south of the fountain, between these radii and within SPAWN_ARC of due south, facing the centre: the
 * first view is the fountain, the Pools Board and the Exchange behind it, and they stand clear of the stalls (north),
 * the benches and the stacks (more than 40 degrees round), where a camera behind them would be crowded in
 */
export const SPAWN_INNER = 11;
export const SPAWN_RADIUS = 16;
export const SPAWN_ARC = Math.PI / 6;
/** the room's heartbeat (batched moves, round ticks, the coins), ms */
export const ROOM_TICK_MS = Math.round(1000 / TICK_HZ);

/** WebSocket close codes the room uses (4000-4999 are the application's) */
export const CLOSE_FULL = 4001;
export const CLOSE_NO_HELLO = 4002;
/** the account was opened in another tab */
export const CLOSE_ELSEWHERE = 4003;
/** a new account could not be stored (the client reconnects and tries again) */
export const CLOSE_NO_ACCOUNT = 4004;

/** the biggest stacks board, this many rows */
export const STACK_ROWS = 20;
/** coins on the ground at once when every zone is full */
export const COINS_ON_GROUND = COIN_ZONES.reduce((n, z) => n + z.count, 0);
/** a zone short of its count drops one more of its own this long after its last, while anyone is in the room */
export const COIN_EVERY_MS = 20_000;
/** a mint mark taken is replaced after this long */
export const MARK_EVERY_MS = 5 * 60_000;
export const HOUR_MS = 3_600_000;
/** the Mint spill: this many coins along one street over this long (one every SPILL_MS / SPILL_COINS), then a mark at its end */
export const SPILL_COINS = 30;
export const SPILL_MS = 3 * 60_000;
/** spilled coins lie this close together (a trail; the zones' own keep COIN_GAP_M) */
export const SPILL_GAP_M = 2;
/**
 * a spill starts on the first heartbeat of a new hour, and only if that heartbeat comes within this long of the
 * hour: a room woken later (it hibernates when empty) skips that hour's spill rather than spilling at ten past
 */
export const SPILL_GRACE_MS = 60_000;
/** an account key: what the browser keeps (base64url) */
export const KEY_RE = /^[A-Za-z0-9_-]{24,64}$/;

// ---------------------------------------------------------------- accounts

export interface Account {
  id: string;
  name: string;
  strap: number;
  stack: number;
  /** coins in the pockets, and what they are worth (dollars): known here, told at the desk */
  coins: number;
  coinCash: number;
  /** the UTC day coinsToday is for */
  day: string;
  coinsToday: number;
  created: number;
  seen: number;
  kit: Kit;
  /** the doors reached so far (PLACES ids; the four ends among them) */
  found: string[];
}

/** where accounts live: the Durable Object's SQLite in production, a Map in tests */
export interface AccountStore {
  byKeyHash(hash: string): Account | null;
  byId(id: string): Account | null;
  /** insert (a new account comes with its key's hash) or update */
  put(a: Account, keyHash?: string): void;
  nameTaken(name: string): boolean;
  /** the biggest stacks, biggest first (ties: the older account first) */
  topStacks(n: number): StackRow[];
}

/** accounts in memory (tests, and a room with no store) */
export function memoryAccounts(): AccountStore & { all(): Account[] } {
  const byId = new Map<string, Account>();
  const byHash = new Map<string, string>();
  return {
    byKeyHash: (h) => {
      const id = byHash.get(h);
      const a = id ? byId.get(id) : undefined;
      return a ? structuredClone(a) : null;
    },
    byId: (id) => {
      const a = byId.get(id);
      return a ? structuredClone(a) : null;
    },
    put: (a, keyHash) => {
      byId.set(a.id, structuredClone(a));
      if (keyHash) byHash.set(keyHash, a.id);
    },
    nameTaken: (name) => [...byId.values()].some((a) => a.name === name),
    topStacks: (n) =>
      [...byId.values()]
        .sort((a, b) => b.stack - a.stack || a.created - b.created)
        .slice(0, n)
        .map((a) => ({ name: a.name, stack: a.stack })),
    all: () => [...byId.values()].map((a) => structuredClone(a)),
  };
}

/** "2026-09-24" for a time in ms */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** a new day: the day's coin count starts again (true when it rolled) */
export function rollDay(a: Account, now: number): boolean {
  const day = dayOf(now);
  if (a.day === day) return false;
  a.day = day;
  a.coinsToday = 0;
  return true;
}

/**
 * a stored account with anything missing or malformed put right, and nothing else kept: a row from before the coins
 * (its jobs, errands, wage and rank) comes out as this shape with empty pockets, its stack, kit and doors as they were.
 * A stake such a row still had out on a round a restart lost goes back to the stack, as its next hello used to do.
 */
export function cleanAccount(a: Account): Account {
  const o = a as unknown as Record<string, unknown>;
  const whole = (v: unknown, cap = Infinity): number | null => (isNum(v) ? Math.max(0, Math.min(cap, Math.floor(v))) : null);
  const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 40) : []);
  return {
    id: a.id,
    name: a.name,
    strap: whole(o.strap, STRAPS.length - 1) ?? 0,
    // (`staked`: a stake a round had out when the stalls still took them, 24 Sep; folded back once. Remove when no row can hold it.)
    stack: (whole(o.stack) ?? START_STACK) + (whole(o.staked) ?? 0),
    coins: whole(o.coins) ?? 0,
    coinCash: whole(o.coinCash) ?? 0,
    day: typeof o.day === "string" ? o.day : "",
    coinsToday: whole(o.coinsToday, COINS_PER_DAY) ?? 0,
    created: whole(o.created) ?? 0,
    seen: whole(o.seen) ?? 0,
    kit: cleanKit(o.kit),
    found: [...new Set(ids(o.found))],
  };
}

export function meOf(a: Account): Me {
  return {
    stack: a.stack,
    coins: a.coins,
    day: a.day,
    coinsToday: a.coinsToday,
    kit: { ...a.kit },
    found: [...a.found],
  };
}

/** the UTC hour the tower shows, 0..23 */
export const hourOf = (ms: number): number => new Date(ms).getUTCHours();

/** a door the room knows: a PLACES entry, or the plaza's own desk (its wider reach) */
export function doorOf(id: string): { x: number; z: number; r: number } | null {
  if (id === PLACE_IDS.desk) return { x: DESK_SPOT.x, z: DESK_SPOT.z, r: DESK_SPOT.r };
  const pl = PLACES.find((q) => q.id === id);
  return pl ? { x: pl.x, z: pl.z, r: DOOR_REACH_M } : null;
}

/** stored talk rows -> a clean list (bad rows dropped, newest last, TALK_ROWS long) */
export function cleanTalk(rows: unknown): { name: string; phrase: PhraseId; at: number }[] {
  if (!Array.isArray(rows)) return [];
  const out: { name: string; phrase: PhraseId; at: number }[] = [];
  for (const r of rows) {
    if (!isRecord(r) || !isRoomName(r.name) || !isPhrase(r.phrase) || !isNum(r.at)) continue;
    out.push({ name: r.name, phrase: r.phrase, at: r.at });
  }
  return out.slice(-TALK_ROWS);
}

// ---------------------------------------------------------------- names

/** curated, harmless words only; a name is ADJECTIVE NOUN NN and nothing a visitor typed */
export const NAME_ADJECTIVES = [
  "Amber", "Bold", "Brass", "Bright", "Brisk", "Calm", "Clever", "Cobalt", "Copper", "Crimson",
  "Dapper", "Eager", "Emerald", "Gentle", "Golden", "Grand", "Honest", "Ivory", "Jade", "Jolly",
  "Keen", "Lucky", "Merry", "Misty", "Nimble", "Noble", "Patient", "Plucky", "Quiet", "Rapid",
  "Royal", "Russet", "Scarlet", "Silver", "Steady", "Sunny", "Swift", "Tidy", "Velvet", "Witty",
] as const;
export const NAME_NOUNS = [
  "Badger", "Beaver", "Bison", "Crane", "Dolphin", "Falcon", "Finch", "Fox", "Gazelle", "Hare",
  "Heron", "Ibis", "Kestrel", "Koala", "Lark", "Lynx", "Magpie", "Marten", "Moose", "Orca",
  "Osprey", "Otter", "Owl", "Panda", "Pelican", "Penguin", "Plover", "Puffin", "Quail", "Raven",
  "Robin", "Seal", "Sparrow", "Stag", "Swan", "Tortoise", "Walrus", "Wren", "Yak", "Zebra",
] as const;
const NAME_RE = /^[A-Z][a-z]+ [A-Z][a-z]+ [1-9][0-9]$/;
export const isRoomName = (v: unknown): v is string =>
  typeof v === "string" &&
  NAME_RE.test(v) &&
  (NAME_ADJECTIVES as readonly string[]).includes(v.split(" ")[0]) &&
  (NAME_NOUNS as readonly string[]).includes(v.split(" ")[1]);

// ---------------------------------------------------------------- the seams

export interface RoomDeps {
  /** deliver one message to one joined (or joining) socket */
  send(id: string, msg: S2C): void;
  /** deliver one message to every joined player, except one */
  broadcast(msg: S2C, exceptId?: string): void;
  /** ms since the epoch */
  now(): number;
  /** uniform in [0, 1) */
  random(): number;
  /** the pools a band may be laid on, in the board's order (see boardSource) */
  board(): Promise<PoolParams[]>;
  /** the pool's hourly history (a History, or bare candles), or null; see historySource. Without it every round is simulated */
  history?(pool: PoolParams): Promise<unknown>;
  /** the top rows changed; persist them */
  saveBoard?(rows: ScoreRow[]): void;
  /** the Coffee House's talk changed; persist it (name, phrase, when in ms) */
  saveTalk?(rows: { name: string; phrase: PhraseId; at: number }[]): void;
  /** close a socket (full room, no hello) */
  close?(id: string, code: number, reason: string): void;
  /** a player joined; the host may remember (socket id, account id) to restore them after a restart */
  joined?(id: string, accountId: string): void;
  /** where accounts are kept; a room without one keeps them in memory */
  accounts?: AccountStore;
  /** an account key -> what is stored for it (a SHA-256 in production) */
  hashKey?(key: string): Promise<string>;
  /** drop coins about the town, and the hourly spill (default true) */
  coins?: boolean;
}

interface Bucket {
  tokens: number;
  at: number;
}

/** an open round: everything here stays on the server */
interface Round {
  roundId: string;
  pool: PoolParams;
  seed: number;
  widthBins: number;
  offsetBins: number;
  /** the real stretch of history the round replays, or null for a simulated one */
  market: Market | null;
  /** simulate() for the whole round (no closeAt): the ticks are read from it */
  sim: SimResult;
  /** when it was laid; tick i is due at start + i * ROUND_TICK_MS */
  start: number;
  /** the last tick sent, 0 before the first */
  sent: number;
}

/** a round as the server sees it (tests, logs); never sent to a client */
export interface RoundView {
  roundId: string;
  pool: PoolParams;
  seed: number;
  /** when its stretch of history began (unix seconds), or null for a simulated round */
  from: number | null;
  widthBins: number;
  offsetBins: number;
  start: number;
  sent: number;
}

/** a coin on the ground as the room holds it: the wire's Note, its worth, and the zone that counts it ("spill": none) */
export interface Coin extends Note {
  v: number;
  zone: string;
}

/** the Mint spill in progress: the street, when it ends, how many coins are down, when the next is due */
interface Spill {
  street: number;
  until: number;
  dropped: number;
  nextAt: number;
}

interface Player {
  id: string;
  name: string;
  strap: number;
  x: number;
  z: number;
  ry: number;
  moving: boolean;
  /** distance in hand for the speed check, metres, and when it was last refilled */
  budget: number;
  budgetAt: number;
  /** restored after a restart: the first move is taken as the position */
  trustNext: boolean;
  /** moved since the last tick */
  dirty: boolean;
  moves: Bucket;
  slowAt: number;
  socialAt: number;
  layAt: number;
  doorAt: number;
  errorAt: number;
  /** the open round, if any (one at a time) */
  round: Round | null;
  /** the account behind the player: its stack and pockets */
  acct: Account;
  /** a lay is waiting on the board or a history */
  laying: boolean;
}

interface Conn {
  id: string;
  openedAt: number;
  msgs: Bucket;
  player: Player | null;
  /** a hello is being answered (the key is being looked up) */
  greeting?: boolean;
  /** the client's address, as the host saw it (for the new-accounts limit); "" when unknown */
  ip: string;
}

// ---------------------------------------------------------------- small pure helpers

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const sig7 = (v: number) => Number(v.toPrecision(7));
/** validateChoice, never throwing */
const safeValidate = (c: unknown): string | null => {
  try {
    return validateChoice(c);
  } catch {
    return "invalid";
  }
};
/** a coin as the ground is told it: no worth */
const noteOf = (c: Coin): Note => ({ id: c.id, x: c.x, z: c.z, kind: c.kind });

/** refill, then take one token; false when the bucket is dry */
export function takeToken(b: Bucket, now: number, perSecond: number, burst: number): boolean {
  const dt = Math.max(0, now - b.at) / 1000;
  b.tokens = Math.min(burst, b.tokens + dt * perSecond);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** radians into [-PI, PI) */
export function wrapAngle(a: number): number {
  const t = Math.PI * 2;
  return ((((a + Math.PI) % t) + t) % t) - Math.PI;
}

/** is this Origin header one of the comma-separated allowed origins? (exact match, no wildcards) */
export function originAllowed(origin: string | null | undefined, allowed: string): boolean {
  if (!origin) return false;
  const want = origin.trim().replace(/\/$/, "").toLowerCase();
  return allowed
    .split(",")
    .map((o) => o.trim().replace(/\/$/, "").toLowerCase())
    .some((o) => o.length > 0 && o === want);
}

/** hot.json ({ rows: [...] }) -> the first BOARD_POOLS rows poolParamsFromHot accepts, in the file's order */
export function parseBoard(file: unknown, limit = BOARD_POOLS): PoolParams[] {
  const rows = isRecord(file) && Array.isArray(file.rows) ? file.rows : [];
  const out: PoolParams[] = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    let p: PoolParams | null = null;
    try {
      p = poolParamsFromHot(row);
    } catch {
      p = null;
    }
    if (p) out.push(p);
  }
  return out;
}

/**
 * The room's own copy of the live board: fetched through load(), cached ttlMs, one fetch in flight at a time.
 * A failed or empty fetch keeps serving the last good copy and is not retried for BOARD_RETRY_MS.
 */
export function boardSource(opts: {
  load: () => Promise<unknown>;
  now: () => number;
  ttlMs?: number;
  retryMs?: number;
  limit?: number;
}): () => Promise<PoolParams[]> {
  const ttl = opts.ttlMs ?? BOARD_TTL_MS;
  const retry = opts.retryMs ?? BOARD_RETRY_MS;
  let good: { at: number; pools: PoolParams[] } | null = null;
  let failedAt = -Infinity;
  let inflight: Promise<PoolParams[]> | null = null;
  return () => {
    const now = opts.now();
    if (good && now - good.at < ttl) return Promise.resolve(good.pools);
    if (now - failedAt < retry) return Promise.resolve(good?.pools ?? []);
    if (!inflight) {
      inflight = Promise.resolve()
        .then(opts.load)
        .then((file) => {
          const pools = parseBoard(file, opts.limit ?? BOARD_POOLS);
          if (!pools.length) throw new Error("board: no usable rows");
          good = { at: opts.now(), pools };
          return pools;
        })
        .catch(() => {
          failedAt = opts.now();
          return good?.pools ?? [];
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };
}

/**
 * One pool's entry in the desk's history.json ({ pools: { [address]: { price: [[s, close]], volume: [[s, usd]] } } },
 * src/publish/gameHistory.ts) as a History (candles, the shape hourlySeries reads), or null when it isn't there.
 */
export function historyFromFile(file: unknown, address: string): History | null {
  const pools = isRecord(file) && isRecord(file.pools) ? file.pools : null;
  const h = pools && Object.prototype.hasOwnProperty.call(pools, address) ? pools[address] : null;
  if (!isRecord(h) || !Array.isArray(h.price) || !Array.isArray(h.volume)) return null;
  const pairs = (rows: unknown[]) => rows.filter((r): r is [number, number] => Array.isArray(r) && r.length === 2 && isNum(r[0]) && isNum(r[1]));
  const price = pairs(h.price).map(([t, c]) => [t, c, c, c, c, 0]);
  const volume = pairs(h.volume).map(([t, v]) => [t, 1, 1, 1, 1, v]);
  return price.length && volume.length ? { price, volume } : null;
}

/**
 * The pools' hourly histories, each read through load() and kept ttlMs, one read in flight per pool. A failed or
 * empty read answers null (the round plays simulated) and that pool is not read again for retryMs. At most keep
 * pools are held; the oldest read goes first.
 */
export function historySource(opts: {
  load: (pool: PoolParams) => Promise<unknown>;
  now: () => number;
  ttlMs?: number;
  retryMs?: number;
  keep?: number;
}): (pool: PoolParams) => Promise<unknown> {
  const ttl = opts.ttlMs ?? HISTORY_TTL_MS;
  const retry = opts.retryMs ?? HISTORY_RETRY_MS;
  const keep = opts.keep ?? HISTORY_KEEP;
  type Held = { at: number; data: unknown; inflight: Promise<unknown> | null };
  const held = new Map<string, Held>();
  return (pool) => {
    const now = opts.now();
    const key = pool.address;
    const h = held.get(key);
    if (h?.inflight) return h.inflight;
    if (h && now - h.at < (h.data === null ? retry : ttl)) return Promise.resolve(h.data);
    const entry: Held = { at: h?.at ?? now, data: h ? h.data : null, inflight: null };
    entry.inflight = opts
      .load(pool)
      .then((d) => (seriesOf(d).length ? d : null))
      .catch(() => null)
      .then((d) => {
        entry.at = opts.now();
        entry.data = d;
        entry.inflight = null;
        return d;
      });
    held.delete(key);
    held.set(key, entry);
    while (held.size > keep) held.delete(held.keys().next().value as string);
    return entry.inflight;
  };
}

const byScore = (a: ScoreRow, b: ScoreRow) => b.pct - a.pct || a.at - b.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** stored leaderboard rows -> a clean top list (bad rows dropped, one row per name, sorted, BOARD_ROWS long) */
export function cleanBoard(rows: unknown): ScoreRow[] {
  if (!Array.isArray(rows)) return [];
  const best = new Map<string, ScoreRow>();
  for (const r of rows) {
    if (!isRecord(r)) continue;
    const { name, pool, pct, at } = r;
    if (typeof name !== "string" || name.length > 40 || typeof pool !== "string" || pool.length > 80) continue;
    if (!isNum(pct) || !isNum(at)) continue;
    const row: ScoreRow = { name, pool, pct: r2(pct), at };
    const had = best.get(name);
    if (!had || byScore(row, had) < 0) best.set(name, row);
  }
  return [...best.values()].sort(byScore).slice(0, BOARD_ROWS);
}

// ---------------------------------------------------------------- the room

export class RoomCore {
  private readonly conns = new Map<string, Conn>();
  private top: ScoreRow[] = [];
  private seq = 0;
  private readonly store: AccountStore;
  private readonly hashKey: (key: string) => Promise<string>;
  private stacksTop: StackRow[] = [];
  /** the coins on the ground, by id */
  private readonly coins = new Map<string, Coin>();
  /** when each zone (by id) may drop its next coin */
  private readonly zoneAt = new Map<string, number>();
  private spill: Spill | null = null;
  /** the hour (since the epoch) the room last saw on its clock: a spill starts when a new one is seen */
  private spillHour: number;
  /** hellos that open a new account draw from this (one bucket for the room: the door, not the visitor, is what is guarded) */
  private readonly keyless: Bucket;
  /** new accounts opened per client address, this hour */
  private readonly ipAccounts = new Map<string, { count: number; since: number }>();
  /** the last TALK_ROWS phrases said in the plaza, oldest first (what the Coffee House repeats) */
  private talkRows: { name: string; phrase: PhraseId; at: number }[] = [];

  constructor(
    private readonly deps: RoomDeps,
    leaderboard?: unknown,
    talk?: unknown,
  ) {
    if (leaderboard !== undefined) this.loadBoard(leaderboard);
    if (talk !== undefined) this.loadTalk(talk);
    this.store = deps.accounts ?? memoryAccounts();
    this.hashKey = deps.hashKey ?? (async (k) => `plain:${k}`);
    this.stacksTop = this.store.topStacks(STACK_ROWS);
    this.keyless = { tokens: KEYLESS_HELLO_BURST, at: deps.now() };
    this.spillHour = Math.floor(deps.now() / HOUR_MS);
  }

  /** the biggest stacks, biggest first */
  stacks(): StackRow[] {
    return this.stacksTop.map((r) => ({ ...r }));
  }

  /** the coins on the ground as the room holds them, worth included (tests, logs); the wire gets noteOf() */
  coinsOnGround(): Coin[] {
    return [...this.coins.values()].map((c) => ({ ...c }));
  }

  /** the spill in progress: its street and end, or null (tests, logs) */
  spillNow(): { street: number; until: number } | null {
    return this.spill ? { street: this.spill.street, until: this.spill.until } : null;
  }

  /** a joined player's account as they see it (tests, logs) */
  meOf(id: string): Me | null {
    const p = this.conns.get(id)?.player;
    return p ? meOf(p.acct) : null;
  }

  /** replace the leaderboard with stored rows (cleaned) */
  loadBoard(rows: unknown): void {
    this.top = cleanBoard(rows);
  }

  /** replace the Coffee House's talk with stored rows (cleaned) */
  loadTalk(rows: unknown): void {
    this.talkRows = cleanTalk(rows);
  }

  /** the talk of the town as the Coffee House shows it: newest first, minutes ago */
  talk(): TalkRow[] {
    const now = this.deps.now();
    return [...this.talkRows].reverse().map((r) => ({ name: r.name, phrase: r.phrase, ago: Math.max(0, Math.floor((now - r.at) / 60_000)) }));
  }

  /** the leaderboard, best first */
  leaderboard(): ScoreRow[] {
    return this.top.map((r) => ({ ...r }));
  }

  /** joined players */
  get size(): number {
    let n = 0;
    for (const c of this.conns.values()) if (c.player) n++;
    return n;
  }

  /** open sockets, joined or not; the host ticks while this is above zero */
  get connections(): number {
    return this.conns.size;
  }

  /** the ids of joined players */
  ids(): string[] {
    const out: string[] = [];
    for (const c of this.conns.values()) if (c.player) out.push(c.id);
    return out;
  }

  /** a joined player's public state */
  player(id: string): PlayerState | null {
    const p = this.conns.get(id)?.player;
    return p ? this.stateOf(p) : null;
  }

  /** a socket opened (ip: the client's address, for the new-accounts limit): its id, or null when the door is shut */
  open(ip = ""): string | null {
    if (this.conns.size >= MAX_CONNECTIONS) return null;
    let id = this.randomId(6);
    while (this.conns.has(id)) id = this.randomId(6);
    const now = this.deps.now();
    this.conns.set(id, { id, openedAt: now, msgs: { tokens: MSG_BURST, at: now }, player: null, ip: typeof ip === "string" ? ip.slice(0, 64) : "" });
    return id;
  }

  /** one more new account for this address, if it has any of its hourly allowance left */
  private newAccountAllowed(ip: string, now: number): boolean {
    if (!ip) return true;
    // forget addresses whose window has passed (on the way past, so the map never grows without bound)
    if (this.ipAccounts.size > 256) for (const [k, v] of this.ipAccounts) if (now - v.since > IP_WINDOW_MS) this.ipAccounts.delete(k);
    // a fixed window from the address's first new account, not a refilling bucket: five in the hour, then none
    let w = this.ipAccounts.get(ip);
    if (!w || now - w.since > IP_WINDOW_MS) {
      w = { count: 0, since: now };
      this.ipAccounts.set(ip, w);
    }
    if (w.count >= NEW_ACCOUNTS_PER_IP) return false;
    w.count++;
    return true;
  }

  /**
   * Put a player back after the host restarted with their socket still open (Durable Object hibernation). No
   * broadcast: everyone else already knows them. Their first move is taken as their position. One session per
   * account holds here too: a second socket naming an account already in the room is refused (the host closes it).
   */
  restore(id: string, accountId: string): boolean {
    if (this.conns.has(id)) return true;
    const found = typeof accountId === "string" ? this.store.byId(accountId) : null;
    if (!found) return false;
    for (const c of this.conns.values()) if (c.player?.acct.id === found.id) return false;
    const acct = cleanAccount(found);
    const now = this.deps.now();
    rollDay(acct, now);
    this.store.put(acct);
    const conn: Conn = { id, openedAt: now, msgs: { tokens: MSG_BURST, at: now }, player: null, ip: "" };
    conn.player = this.newPlayer(id, acct, now);
    conn.player.trustNext = true;
    this.conns.set(id, conn);
    return true;
  }

  /** one raw frame from a socket; anything malformed is ignored */
  async message(id: string, data: unknown): Promise<void> {
    const conn = this.conns.get(id);
    if (!conn) return;
    if (typeof data !== "string" || data.length > MAX_MESSAGE_CHARS) return;
    const now = this.deps.now();
    if (!takeToken(conn.msgs, now, MSG_RATE, MSG_BURST)) {
      if (conn.player) this.slow(conn.player, now);
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(msg) || typeof msg.t !== "string") return;
    const p = conn.player;
    if (!p) {
      if (msg.t === "hello") await this.hello(conn, msg, now);
      return;
    }
    switch (msg.t) {
      case "move":
        return this.move(p, msg, now);
      case "emote":
        if (isEmote(msg.e)) this.social(p, { t: "emote", id: p.id, e: msg.e }, now);
        return;
      case "say":
        if (isPhrase(msg.p)) this.social(p, { t: "say", id: p.id, p: msg.p }, now);
        return;
      case "lay":
        return this.lay(p, msg, now);
      case "close":
        return this.close(p, msg, now);
      case "pick":
        return this.pick(p, msg, now);
      case "cashin":
        return this.cashin(p, now);
      case "enter":
        return this.enter(p, msg, now);
      case "climb":
        return this.climb(p, now);
      case "buy":
        return this.buy(p, msg, now);
      default:
        return;
    }
  }

  /** a player's open round as the server holds it, seed included: for tests and logs, never for the wire */
  roundOf(id: string): RoundView | null {
    const r = this.conns.get(id)?.player?.round;
    if (!r) return null;
    const { roundId, pool, seed, widthBins, offsetBins, start, sent } = r;
    return { roundId, pool: { ...pool }, seed, from: r.market?.from ?? null, widthBins, offsetBins, start, sent };
  }

  /** a socket closed; an open round settles quietly at the last hour sent */
  leave(id: string): void {
    const conn = this.conns.get(id);
    if (!conn) return;
    const p = conn.player;
    if (p?.round) this.settle(p, p.round, this.endOf(p.round), this.deps.now(), true);
    this.conns.delete(id);
    if (p) this.deps.broadcast({ t: "leave", id });
  }

  /** TICK_HZ: close sockets that never said hello, advance every open round, drop the coins due, flush the moves batch */
  tick(): void {
    const now = this.deps.now();
    for (const c of this.conns.values()) {
      if (!c.player && now - c.openedAt > HELLO_TIMEOUT_MS) {
        this.conns.delete(c.id);
        this.deps.close?.(c.id, CLOSE_NO_HELLO, "no hello");
      }
    }
    const players: Player[] = [];
    for (const c of this.conns.values()) if (c.player) players.push(c.player);
    for (const p of players) if (p.round) this.advance(p, p.round, now);
    if (this.deps.coins !== false && players.length) {
      this.refill(now);
      this.spillTick(now);
    }
    const movers = players.filter((p) => p.dirty);
    if (!movers.length) return;
    const all = movers.map((p) => this.entryOf(p));
    for (const p of movers) p.dirty = false;
    const batch: S2C = { t: "moves", m: all };
    for (const p of players) {
      if (all.some((e) => e[0] === p.id)) {
        const others = all.filter((e) => e[0] !== p.id);
        if (others.length) this.deps.send(p.id, { t: "moves", m: others });
      } else {
        this.deps.send(p.id, batch);
      }
    }
  }

  // ---------------------------------------------------------------- handlers

  /**
   * A hello opens an account: the one its key names, or a new one. A keyless hello is turned away at the cap and
   * metered by the keyless bucket before any work is done, since each one is an insert; a keyed hello may be a player
   * already inside coming back from a new tab, so its cap check waits until their old seat is freed. A new account is
   * written once, after the checks, with its strap and seen set: a socket that leaves while its key is hashed, or is
   * turned away as full, leaves no row.
   */
  private async hello(conn: Conn, msg: Record<string, unknown>, now: number): Promise<void> {
    if (conn.greeting) return;
    const key = typeof msg.key === "string" && KEY_RE.test(msg.key) ? msg.key : null;
    if (!key && (this.size >= ROOM_CAP || !takeToken(this.keyless, now, KEYLESS_HELLO_RATE, KEYLESS_HELLO_BURST) || !this.newAccountAllowed(conn.ip, now))) {
      this.turnAway(conn);
      return;
    }
    conn.greeting = true;
    let found: Account | null = null;
    try {
      if (key) found = this.store.byKeyHash(await this.hashKey(key));
    } catch {
      found = null;
    }
    let newKey: string | null = null;
    let hash: string | undefined;
    let acct: Account;
    if (found) {
      acct = cleanAccount(found);
    } else {
      // an unknown key opens a new account like no key does, and draws from the same buckets
      if (key && (!takeToken(this.keyless, now, KEYLESS_HELLO_RATE, KEYLESS_HELLO_BURST) || !this.newAccountAllowed(conn.ip, now))) {
        conn.greeting = false;
        this.turnAway(conn);
        return;
      }
      newKey = this.randomKey();
      try {
        hash = await this.hashKey(newKey);
      } catch {
        conn.greeting = false;
        return;
      }
      acct = {
        id: `a${this.randomId(15)}`,
        name: this.makeName(),
        strap: 0,
        stack: START_STACK,
        coins: 0,
        coinCash: 0,
        day: dayOf(now),
        coinsToday: 0,
        created: now,
        seen: now,
        kit: { ...DEFAULT_KIT },
        found: [],
      };
    }
    conn.greeting = false;
    if (this.conns.get(conn.id) !== conn) return; // gone while the key was looked up
    // one session per account: an older one (another tab) is closed, its round settled
    for (const other of [...this.conns.values()]) {
      if (other !== conn && other.player?.acct.id === acct.id) {
        this.deps.send(other.id, { t: "elsewhere" });
        this.leave(other.id);
        this.deps.close?.(other.id, CLOSE_ELSEWHERE, "elsewhere");
        const fresh = this.store.byId(acct.id);
        if (fresh) acct = cleanAccount(fresh);
      }
    }
    if (this.size >= ROOM_CAP) {
      this.turnAway(conn);
      return;
    }
    rollDay(acct, now);
    acct.strap = this.clampStrap(msg.strap);
    acct.seen = now;
    if (!this.insert(acct, hash)) {
      this.conns.delete(conn.id);
      this.deps.close?.(conn.id, CLOSE_NO_ACCOUNT, "no account");
      return;
    }
    const p = this.newPlayer(conn.id, acct, now);
    conn.player = p;
    const players: PlayerState[] = [];
    for (const c of this.conns.values()) if (c.player) players.push(this.stateOf(c.player));
    this.refreshStacks();
    this.deps.send(p.id, {
      t: "welcome",
      you: p.id,
      name: p.name,
      players,
      board: this.leaderboard(),
      me: meOf(acct),
      notes: [...this.coins.values()].map(noteOf),
      stacks: this.stacks(),
      ...(newKey ? { key: newKey } : {}),
      ...(this.spill ? { spill: { street: this.spill.street, until: this.spill.until } } : {}),
    });
    this.deps.broadcast({ t: "join", p: this.stateOf(p) }, p.id);
    this.deps.joined?.(p.id, acct.id);
  }

  private move(p: Player, msg: Record<string, unknown>, now: number): void {
    const { x, z, ry } = msg;
    if (!isNum(x) || !isNum(z) || !isNum(ry)) return;
    if (!takeToken(p.moves, now, MOVE_HZ, MOVE_BURST)) {
      this.slow(p, now);
      return;
    }
    const [cx, cz] = nearestWalkable(x, z);
    // the speed check: a running distance budget, refilled at MAX_SPEED for the time since the last move (a refused
    // move still spends the time), capped so an idle spell never buys a jump
    const seconds = Math.min(MAX_STEP_SECONDS, Math.max(0, now - p.budgetAt) / 1000);
    p.budget = Math.min(BUDGET_CAP_M, p.budget + MAX_SPEED * seconds);
    p.budgetAt = now;
    // the rope: out of the plaza or back in only through a mouth. The band round the rope keeps a walker off its
    // line, but a budget of BUDGET_CAP_M would jump it in one move; a step whose ends straddle it is refused
    if (crossesRope(p.x, p.z, cx, cz)) {
      this.correct(p);
      return;
    }
    if (p.trustNext) {
      p.budget = BUDGET_CAP_M;
    } else {
      const step = Math.hypot(cx - p.x, cz - p.z);
      if (step > p.budget) {
        this.correct(p);
        return;
      }
      p.budget -= step;
    }
    p.trustNext = false;
    p.x = cx;
    p.z = cz;
    p.ry = wrapAngle(ry);
    p.moving = msg.moving === true;
    p.dirty = true;
    if (Math.hypot(cx - x, cz - z) > CORRECTION_M) this.correct(p);
  }

  private social(p: Player, out: S2C, now: number): void {
    if (now - p.socialAt < SOCIAL_GAP_MS) {
      this.slow(p, now);
      return;
    }
    p.socialAt = now;
    // to everyone else: the sender's page shows its own bubble when it sends
    this.deps.broadcast(out, p.id);
    if (out.t === "say") {
      this.talkRows.push({ name: p.name, phrase: out.p, at: now });
      if (this.talkRows.length > TALK_ROWS) this.talkRows.splice(0, this.talkRows.length - TALK_ROWS);
      this.deps.saveTalk?.(this.talkRows.map((r) => ({ ...r })));
    }
  }

  // ---------------------------------------------------------------- the coins

  /** pick up a coin: it must be there, and you within NOTE_REACH of it, with coins left today. Into the pockets, not the stack */
  private pick(p: Player, msg: Record<string, unknown>, now: number): void {
    const id = typeof msg.note === "string" ? msg.note : "";
    const coin = this.coins.get(id);
    if (!coin) {
      // gone (someone else's, or lost in a restart): tell the asker, whose walker would otherwise ask again and again
      if (id && id.length <= 16) this.deps.send(p.id, { t: "notes", add: [], gone: [id] });
      return;
    }
    const a = p.acct;
    rollDay(a, now);
    if (a.coinsToday >= COINS_PER_DAY) {
      this.error(p, "notes done", now);
      return;
    }
    if (Math.hypot(coin.x - p.x, coin.z - p.z) > NOTE_REACH) return;
    this.coins.delete(id);
    a.coins += 1;
    a.coinCash += coin.v;
    a.coinsToday += 1;
    this.store.put(a);
    this.deps.broadcast({ t: "picked", id: p.id, note: id, v: coin.v });
    this.deps.send(p.id, { t: "me", me: meOf(a) });
  }

  /**
   * cash the pockets in at Mr Bands' desk (DESK_SPOT's reach; "not there" elsewhere): the coins' worth goes into the
   * stack and the pockets empty. Nothing carried: cashed 0 and 0, nothing written
   */
  private cashin(p: Player, now: number): void {
    if (!this.doorTurn(p, now)) return;
    if (Math.hypot(p.x - DESK_SPOT.x, p.z - DESK_SPOT.z) > DESK_SPOT.r) {
      this.error(p, "not there", now);
      return;
    }
    const a = p.acct;
    if (!a.coins) {
      this.deps.send(p.id, { t: "cashed", coins: 0, cash: 0 });
      return;
    }
    const coins = a.coins;
    const cash = a.coinCash;
    a.stack += cash;
    a.coins = 0;
    a.coinCash = 0;
    rollDay(a, now);
    this.store.put(a);
    this.deps.send(p.id, { t: "cashed", coins, cash });
    this.deps.send(p.id, { t: "me", me: meOf(a) });
    this.stackChanged(p);
  }

  /**
   * every zone short of its count drops one more of its own once COIN_EVERY_MS (MARK_EVERY_MS for a mark) has passed
   * since it was last full or last dropped one: a coin taken comes back that long after, never at once, and an empty
   * room fills a coin a zone at each pace
   */
  private refill(now: number): void {
    for (const zone of COIN_ZONES) {
      const every = zone.kind === "mark" ? MARK_EVERY_MS : COIN_EVERY_MS;
      let down = 0;
      for (const c of this.coins.values()) if (c.zone === zone.id) down++;
      if (down >= zone.count) {
        this.zoneAt.set(zone.id, now + every);
        continue;
      }
      if (now < (this.zoneAt.get(zone.id) ?? -Infinity)) continue;
      this.zoneAt.set(zone.id, now + every);
      this.drop(zone, zone.id);
    }
  }

  /**
   * the Mint spill: on the first heartbeat of a new hour (within SPILL_GRACE_MS of it) one street is drawn and told
   * to everyone; then a coin of the street's range every SPILL_MS / SPILL_COINS until SPILL_COINS are down, and a mark
   * at the end. Nothing here is written anywhere; nothing a client sends reaches it
   */
  private spillTick(now: number): void {
    const hour = Math.floor(now / HOUR_MS);
    if (hour > this.spillHour) {
      this.spillHour = hour;
      if (now - hour * HOUR_MS <= SPILL_GRACE_MS) {
        const street = Math.floor(this.deps.random() * STREET_NAMES.length) % STREET_NAMES.length;
        this.spill = { street, until: now + SPILL_MS, dropped: 0, nextAt: now };
        this.deps.broadcast({ t: "spill", street, until: this.spill.until });
      }
    }
    const s = this.spill;
    if (!s) return;
    // a spill left half-dropped by an empty room (the heartbeat stops with the last visitor) is over when its time is,
    // never resumed as a burst on the next join
    if (now > s.until + SPILL_MS / SPILL_COINS) {
      this.spill = null;
      return;
    }
    if (now < s.nextAt) return;
    const street = STREET_NAMES[s.street];
    if (s.dropped < SPILL_COINS) {
      this.drop(COIN_ZONES.find((z) => z.ground === street && z.kind === "coin")!, "spill", SPILL_GAP_M);
      s.dropped++;
      s.nextAt = now + SPILL_MS / SPILL_COINS;
      return;
    }
    this.drop(COIN_ZONES.find((z) => z.ground === street && z.kind === "mark")!, "spill", SPILL_GAP_M);
    this.spill = null;
  }

  /** one coin of the zone on the ground, worth a whole number of its range, counted under `tag`; everyone sees it land */
  private drop(zone: CoinZone, tag: string, gap?: number): void {
    const spot = coinSpot(zone, this.deps.random, [...this.coins.values()], gap);
    if (!spot) return;
    const span = zone.max - zone.min + 1;
    const coin: Coin = { id: `n${this.randomId(7)}`, x: spot[0], z: spot[1], kind: zone.kind, v: zone.min + (Math.floor(this.deps.random() * span) % span), zone: tag };
    this.coins.set(coin.id, coin);
    this.deps.broadcast({ t: "notes", add: [noteOf(coin)], gone: [] });
  }

  // ---------------------------------------------------------------- the town's doors

  /** the door named, when the player stands at it (its own reach for the desk); "not there" otherwise, null then */
  private atDoor(p: Player, id: string, now: number): { x: number; z: number; r: number } | null {
    const door = doorOf(id);
    if (!door || Math.hypot(p.x - door.x, p.z - door.z) > door.r) {
      this.error(p, "not there", now);
      return null;
    }
    return door;
  }

  /** doors: one message per DOOR_GAP_MS (false, and "slow", when it is too soon) */
  private doorTurn(p: Player, now: number): boolean {
    if (now - p.doorAt < DOOR_GAP_MS) {
      this.slow(p, now);
      return false;
    }
    p.doorAt = now;
    return true;
  }

  /** what a door's interior shows beyond its id */
  private placeExtras(id: string, now: number): Partial<Extract<S2C, { t: "place" }>> {
    if (id.startsWith("coffee")) return { talk: this.talk() };
    if (id === PLACE_IDS.clockTower) return { hour: hourOf(now) };
    return {};
  }

  private stockFor(a: Account, shop: string): { item: ItemId; price: number; owned: boolean }[] {
    return STOCK.filter((s) => s.shop === shop).map((s) => ({ item: s.item, price: s.price, owned: owns(a.kit, s.item) }));
  }

  /**
   * enter a door: the position is checked, the discovery recorded the first time (the account written then, and
   * only then) and the interior answered
   */
  private enter(p: Player, msg: Record<string, unknown>, now: number): void {
    const id = typeof msg.place === "string" && msg.place.length <= 40 ? msg.place : "";
    if (!id || !this.doorTurn(p, now)) return;
    if (!this.atDoor(p, id, now)) return;
    const a = p.acct;
    const found = id !== PLACE_IDS.desk && !a.found.includes(id);
    if (found) {
      a.found.push(id);
      this.store.put(a);
      this.deps.send(p.id, { t: "found", place: id });
    }
    const shop = shopOf(id);
    this.deps.send(p.id, { t: "place", id, ...this.placeExtras(id, now), ...(shop ? { stock: this.stockFor(a, shop) } : {}) });
    if (found) this.deps.send(p.id, { t: "me", me: meOf(a) });
  }

  /** climb the tower: the hour it shows is the room's own; nothing is written */
  private climb(p: Player, now: number): void {
    if (!this.doorTurn(p, now)) return;
    if (!this.atDoor(p, PLACE_IDS.clockTower, now)) return;
    this.deps.send(p.id, { t: "place", id: PLACE_IDS.clockTower, hour: hourOf(now) });
  }

  /** buy one of STOCK at a door of its shop: one of each, from the stack; worn at once and told to everyone */
  private buy(p: Player, msg: Record<string, unknown>, now: number): void {
    if (!isItem(msg.item)) return;
    if (!this.doorTurn(p, now)) return;
    const row = STOCK.find((s) => s.item === msg.item)!;
    const here = PLACES.find((q) => shopOf(q.id) === row.shop && Math.hypot(p.x - q.x, p.z - q.z) <= DOOR_REACH_M);
    if (!here) {
      this.error(p, "not there", now);
      return;
    }
    const a = p.acct;
    if (owns(a.kit, row.item)) {
      this.error(p, "have one", now);
      return;
    }
    if (a.stack < row.price) {
      this.error(p, "no stack", now);
      return;
    }
    a.stack -= row.price;
    a.kit = wear(a.kit, row.item);
    this.store.put(a);
    this.deps.send(p.id, { t: "bought", item: row.item });
    this.deps.send(p.id, { t: "me", me: meOf(a) });
    this.deps.broadcast({ t: "kit", id: p.id, kit: { ...a.kit } });
    this.stackChanged(p);
  }

  /** tell the room the player's stack moved, and the stacks board if its top changed */
  private stackChanged(p: Player): void {
    this.deps.broadcast({ t: "stack", id: p.id, stack: p.acct.stack });
    this.refreshStacks(true);
  }

  private refreshStacks(announce = false): void {
    const next = this.store.topStacks(STACK_ROWS);
    if (JSON.stringify(next) === JSON.stringify(this.stacksTop)) return;
    this.stacksTop = next;
    if (announce) this.deps.broadcast({ t: "stacks", rows: this.stacks() });
  }

  // ---------------------------------------------------------------- the stalls

  /** lay a band: validate, find the pool on the server's board, deal a seed, run the round, say "laid"; practice only */
  private async lay(p: Player, msg: Record<string, unknown>, now: number): Promise<void> {
    const want = typeof msg.pool === "string" ? msg.pool.trim() : "";
    if (!want || want.length > 128) return;
    if (now - p.layAt < LAY_GAP_MS) {
      this.slow(p, now);
      return;
    }
    p.layAt = now;
    if (p.round || p.laying) {
      this.error(p, "round in play", now);
      return;
    }
    // the band only: a closeAt (or anything else) sent with it is not read
    const band = { widthBins: msg.widthBins, offsetBins: msg.offsetBins };
    if (safeValidate(band) !== null) {
      this.error(p, "bad choice", now);
      return;
    }
    const widthBins = band.widthBins as number;
    const offsetBins = band.offsetBins as number;
    // nothing rides on a stall: a stake asked for is refused, whatever the stack holds
    if (isNum(msg.stake) && msg.stake > 0) {
      this.error(p, "practice only", now);
      return;
    }
    p.laying = true;
    let pools: PoolParams[];
    try {
      pools = await this.deps.board();
    } catch {
      pools = [];
    } finally {
      p.laying = false;
    }
    if (this.conns.get(p.id)?.player !== p || p.round) return; // left while the board loaded
    const at = this.deps.now();
    const label = want.toLowerCase();
    const found = pools.find((q) => q.address === want) ?? pools.find((q) => q.label.toLowerCase() === label);
    if (!found) {
      this.error(p, pools.length ? "unknown pool" : "board unavailable", at);
      return;
    }
    const pool = { ...found };
    let market: Market | null = null;
    if (this.deps.history) {
      p.laying = true;
      try {
        market = this.marketFrom(pool, await this.deps.history(pool));
      } catch {
        market = null;
      } finally {
        p.laying = false;
      }
      if (this.conns.get(p.id)?.player !== p || p.round) return; // left while the history loaded
    }
    const start = this.deps.now();
    const seed = this.seed();
    let sim: SimResult;
    try {
      sim = simulate(pool, seed, { widthBins, offsetBins }, market);
    } catch {
      this.error(p, "bad choice", start);
      return;
    }
    const round: Round = { roundId: this.roundId(), pool, seed, widthBins, offsetBins, market, sim, start, sent: 0 };
    p.round = round;
    this.deps.send(p.id, {
      t: "laid",
      roundId: round.roundId,
      pool: { ...pool },
      lower: sim.lower,
      upper: sim.upper,
      tickMs: ROUND_TICK_MS,
      real: market !== null,
    });
  }

  /**
   * A random stretch of the pool's history long enough for a round, or null (too short, unreadable, unpriceable, or
   * too quiet). A stretch must have MIN_LIVE_HOURS of its hours with volume: hourlySeries fills a silent hour with the
   * last close and no volume, so a thin history would deal flat stretches that teach nothing, and stretches that all
   * hold its one move, which anyone reading the history could tell apart.
   */
  private marketFrom(pool: PoolParams, history: unknown): Market | null {
    const series = seriesOf(history);
    if (series.length < MARKET_HOURS) return null;
    const starts: number[] = [];
    for (let s = 0; s + MARKET_HOURS <= series.length; s++) {
      let live = 0;
      for (let t = 1; t <= TICKS; t++) if (series[s + t].volUsd > 0) live++;
      if (live >= MIN_LIVE_HOURS) starts.push(s);
    }
    if (!starts.length) return null;
    const start = starts[Math.min(starts.length - 1, Math.floor(this.deps.random() * starts.length))];
    return marketWindow(series, start, pool);
  }

  /** settle at the last tick already sent (tick 1, sent now, if none had gone out) */
  private close(p: Player, msg: Record<string, unknown>, now: number): void {
    const { roundId } = msg;
    if (typeof roundId !== "string" || roundId.length > 64) return;
    const r = p.round;
    if (!r || r.roundId !== roundId) {
      this.error(p, "no such round", now);
      return;
    }
    const at = this.endOf(r);
    this.sendTicks(p, r, at);
    this.settle(p, r, at, now);
  }

  /** the hour a round cut short settles at: the last hour sent (tick 1 at the least) */
  private endOf(r: Round): number {
    return Math.max(1, r.sent);
  }

  /** the heartbeat's work on one round: expire it, or send the ticks now due and settle at the end */
  private advance(p: Player, r: Round, now: number): void {
    if (now - r.start > ROUND_TTL_MS) {
      // (the ticks stalled): settle now, where a close would
      const at = this.endOf(r);
      this.sendTicks(p, r, at);
      this.settle(p, r, at, now);
      return;
    }
    const due = Math.min(TICKS, Math.floor((now - r.start) / ROUND_TICK_MS));
    if (due > r.sent) this.sendTicks(p, r, due);
    if (r.sent >= TICKS) this.settle(p, r, TICKS, now);
  }

  private sendTicks(p: Player, r: Round, upTo: number): void {
    for (let i = r.sent + 1; i <= upTo; i++) {
      this.deps.send(p.id, {
        t: "tick",
        roundId: r.roundId,
        i,
        p: sig7(r.sim.path[i]),
        feesPct: r4(r.sim.feesPct[i]),
        valuePct: r4(r.sim.valuePct[i]),
        holdPct: r4(r.sim.holdPct[i]),
        inRange: r.sim.inRange[i],
      });
    }
    r.sent = Math.max(r.sent, upTo);
  }

  /**
   * Score the round at hour `at`: simulate() re-run with that closeAt, "scored" to the player, and the result on the
   * Best rounds board ("board" to the room if the top changed). No stack moves and no account is written: the stalls
   * are practice. quiet: the player has gone, so nothing is sent to them.
   */
  private settle(p: Player, r: Round, at: number, now: number, quiet = false): void {
    p.round = null;
    let res: SimResult;
    try {
      res = simulate(r.pool, r.seed, { widthBins: r.widthBins, offsetBins: r.offsetBins, closeAt: at }, r.market);
    } catch {
      // cannot happen for a round that was dealt; scored as nothing rather than not at all
      res = { ...r.sim, closedAt: at, scorePct: 0 };
    }
    const pct = isNum(res.scorePct) ? r2(res.scorePct) : 0;
    const { rank, changed } = this.record({ name: p.name, pool: r.pool.label, pct, at: now });
    if (!quiet) {
      this.deps.send(p.id, r.market ? { t: "scored", roundId: r.roundId, pct, at, rank, from: r.market.from } : { t: "scored", roundId: r.roundId, pct, at, rank });
    }
    if (changed) {
      this.deps.broadcast({ t: "board", rows: this.leaderboard() });
      this.deps.saveBoard?.(this.leaderboard());
    }
  }

  // ---------------------------------------------------------------- the leaderboard

  /** keep each name's best, top BOARD_ROWS: the row's rank if it is on the board now (else null), and whether the top changed */
  private record(row: ScoreRow): { rank: number | null; changed: boolean } {
    const before = JSON.stringify(this.top);
    const had = this.top.findIndex((r) => r.name === row.name);
    if (had >= 0) {
      if (this.top[had].pct >= row.pct) return { rank: null, changed: false };
      this.top.splice(had, 1);
    }
    const next = [...this.top, row].sort(byScore).slice(0, BOARD_ROWS);
    this.top = next;
    const rank = next.indexOf(row);
    return { rank: rank >= 0 ? rank + 1 : null, changed: JSON.stringify(next) !== before };
  }

  // ---------------------------------------------------------------- bits

  private slow(p: Player, now: number): void {
    if (now - p.slowAt < SLOW_NOTICE_MS) return;
    p.slowAt = now;
    this.deps.send(p.id, { t: "slow" });
  }

  /** errors are fixed server strings, never anything the client sent */
  private error(
    p: Player,
    why: "unknown pool" | "board unavailable" | "round in play" | "no such round" | "bad choice" | "practice only" | "notes done" | "not there" | "no stack" | "have one",
    now: number,
  ): void {
    if (now - p.errorAt < ERROR_GAP_MS) return;
    p.errorAt = now;
    this.deps.send(p.id, { t: "error", why });
  }

  /** tell a player where the server has them (a rejected jump, or a pull back onto walkable ground) */
  private correct(p: Player): void {
    this.deps.send(p.id, { t: "moves", m: [this.entryOf(p)] });
  }

  /** the door is shut to this socket: say so and close it */
  private turnAway(conn: Conn): void {
    this.deps.send(conn.id, { t: "full" });
    this.conns.delete(conn.id);
    this.deps.close?.(conn.id, CLOSE_FULL, "full");
  }

  /**
   * write an account: an update for one the store holds, an insert (with its key's hash) for a new one. An insert
   * that throws (the name or the hash collided with a row written meanwhile) is tried again with a fresh name, a few
   * times; false when none took, so the caller gives the socket up rather than the room
   */
  private insert(acct: Account, hash: string | undefined): boolean {
    if (!hash) {
      this.store.put(acct);
      return true;
    }
    for (let i = 0; i < INSERT_TRIES; i++) {
      try {
        this.store.put(acct, hash);
        return true;
      } catch {
        acct.name = this.makeName();
      }
    }
    return false;
  }

  private newPlayer(id: string, acct: Account, now: number): Player {
    const a = (this.deps.random() * 2 - 1) * SPAWN_ARC;
    const d = SPAWN_INNER + this.deps.random() * (SPAWN_RADIUS - SPAWN_INNER);
    const x = r2(Math.sin(a) * d);
    const z = r2(Math.cos(a) * d);
    return {
      id,
      name: acct.name,
      strap: acct.strap,
      acct,
      x,
      z,
      ry: r3(Math.atan2(-x, -z)),
      moving: false,
      budget: BUDGET_CAP_M,
      budgetAt: now,
      trustNext: false,
      dirty: false,
      moves: { tokens: MOVE_BURST, at: now },
      slowAt: -Infinity,
      socialAt: -Infinity,
      layAt: -Infinity,
      doorAt: -Infinity,
      errorAt: -Infinity,
      round: null,
      laying: false,
    };
  }

  private clampStrap(v: unknown): number {
    if (!isNum(v)) return 0;
    return Math.min(STRAPS.length - 1, Math.max(0, Math.floor(v)));
  }

  /** ADJECTIVE NOUN NN, not held by any account, anyone in the room or anyone on the board (when a free one turns up) */
  private makeName(): string {
    const taken = new Set<string>(this.top.map((r) => r.name));
    for (const c of this.conns.values()) if (c.player) taken.add(c.player.name);
    let name = "";
    for (let i = 0; i < 48; i++) {
      const adj = NAME_ADJECTIVES[Math.floor(this.deps.random() * NAME_ADJECTIVES.length) % NAME_ADJECTIVES.length];
      const noun = NAME_NOUNS[Math.floor(this.deps.random() * NAME_NOUNS.length) % NAME_NOUNS.length];
      const nn = 10 + (Math.floor(this.deps.random() * 90) % 90);
      name = `${adj} ${noun} ${nn}`;
      if (!taken.has(name) && !this.store.nameTaken(name)) break;
    }
    return name;
  }

  /** an account key: 32 characters of base64url from the room's random */
  private randomKey(): string {
    const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let s = "";
    for (let i = 0; i < 32; i++) s += abc[Math.floor(this.deps.random() * 64) % 64];
    return s;
  }

  private stateOf(p: Player): PlayerState {
    return { id: p.id, name: p.name, strap: p.strap, x: r2(p.x), z: r2(p.z), ry: r3(p.ry), moving: p.moving, stack: p.acct.stack, kit: { ...p.acct.kit } };
  }

  private entryOf(p: Player): [string, number, number, number, 0 | 1] {
    return [p.id, r2(p.x), r2(p.z), r3(p.ry), p.moving ? 1 : 0];
  }

  private randomId(n: number): string {
    const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
    let s = "";
    for (let i = 0; i < n; i++) s += abc[Math.floor(this.deps.random() * abc.length) % abc.length];
    return s;
  }

  private roundId(): string {
    this.seq++;
    return `r${this.seq.toString(36)}${this.randomId(8)}`;
  }

  private seed(): number {
    return Math.floor(this.deps.random() * 4294967296) >>> 0;
  }
}
