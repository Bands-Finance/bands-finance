/**
 * THE EXCHANGE ROOM AS PLAIN LOGIC (bands.finance Play). One RoomCore holds everyone in the plaza. It knows nothing
 * of Cloudflare: the Durable Object (room.ts) hands it sockets as ids, the tests (src/scripts/test-game-room.ts) hand
 * it fakes. Every rule of the wire contract (web/src/game/protocol.ts) is enforced here:
 *
 *   - names are made here from two curated word lists and two digits; nothing a visitor sends ever becomes text
 *     another visitor reads (emotes and phrases are allow-listed ids, errors are fixed server strings)
 *   - positions are rate limited, clamped into the disc and checked against MAX_SPEED; a rejected move is answered
 *     with a correction: a { t: "moves" } carrying the player's OWN id, sent only to them. Batched moves never
 *     carry the recipient's own entry, so an own-id entry always means "snap back to this".
 *   - a round is played here: the player lays a band on a pool from the server's own copy of the live board, the
 *     server deals a seed it never sends, runs simulate() once and streams the result one tick at a time as its
 *     clock reaches each tick (tick()). The score is simulate() re-run with the hour it settled at, so the browser
 *     never holds the seed or a tick ahead of time.
 *   - a staked round is committed at the lay (24 Sep, after the review): its band, stake and hold (12, 24 or 48 hours)
 *     are fixed before the hours are dealt, the stall keeps RAKE_PCT of the stake there and then, and the round
 *     settles at its hold whatever happens after. A close skips to the end (the ticks left are sent at once), a leave
 *     or the TTL settles it at the hold quietly, a restart refunds the stake (the rake is gone). So working out the
 *     hours from the ticks (the real ones are public data) changes nothing about what a staked round pays. A practice
 *     round (stake 0) may still be closed at any hour, and records nothing: no board row, no job, no write.
 *   - the stack: a visitor's account (name, strap, stack, today's jobs) is kept in an AccountStore, opened again by a
 *     key only their browser holds (its hash is what is stored). A staked round takes the stake and the rake from the
 *     stack at the lay and pays back the position's worth at its hold (value + fees, from the same simulate() the
 *     score comes from). Mr Bands pays a daily wage and daily jobs at his desk, and loose notes turn up about the
 *     plaza. The store is written only when something changed: a keyless hello is one insert, a paid 0 none.
 *   - the hours are real where they can be: the room reads the pool's hourly history (historySource) and deals a
 *     random 48-hour stretch of it (a Market), named to the player only once the round is scored. A pool too new for
 *     that, or a history that can't be read, plays the seeded simulation as before.
 *   - the town (24 Sep): a move is pulled back to the nearest walkable ground (town.ts, the one shape the client
 *     collides with). A visitor standing within DOOR_REACH_M of a door may enter it: the first time pays FOUND_PAY
 *     and is remembered in the account's `found`; an errand whose next step is that door moves on. Mr Bands' errands
 *     (ERRANDS, then a daily run of DAILY_PLACES doors the room draws) are taken at his desk or at Bands & Co.; a
 *     finished errand's reward waits in `owed` and is collected with the wage. The tower's hour is the room's own UTC
 *     hour, shown at the climb and checked at the answer. Shops sell STOCK for the stack; what is bought is worn at
 *     once and told to everyone. The Coffee House repeats the last TALK_ROWS phrases said in the plaza (room-level).
 */
import {
  cleanKit,
  DAILY,
  DAILY_PLACES,
  DEFAULT_KIT,
  DESK_SPOT,
  DOOR_REACH_M,
  END_IDS,
  ERRANDS,
  FOUND_PAY,
  GUARD_SPOT,
  HOLDS,
  isEmote,
  isItem,
  isPhrase,
  JOBS,
  owns,
  PLACE_IDS,
  shopOf,
  STOCK,
  TALK_ROWS,
  titleOf,
  wear,
  MAX_SPEED,
  MAX_STAKE,
  MIN_STAKE,
  MOVE_HZ,
  NOTE_REACH,
  NOTES_PER_DAY,
  RAKE_PCT,
  ROOM_CAP,
  ROUND_TICK_MS,
  ROUNDS_PER_DAY,
  START_STACK,
  STRAPS,
  TICK_HZ,
  WAGE,
  WORLD_RADIUS,
} from "../../web/src/game/protocol";
import type { Errand, ErrandId, ItemId, JobId, Kit, Me, Note, PhraseId, PlayerState, S2C, ScoreRow, StackRow, TalkRow } from "../../web/src/game/protocol";
import { crossesRope, nearestWalkable, PLACES } from "../../web/src/game/town";
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
/** pays: one per this long (a pay that collects nothing writes nothing, but it still costs a message) */
export const PAY_GAP_MS = 2_000;
/** { t: "error" } replies: one per this long (a round's expiry notice is always sent) */
export const ERROR_GAP_MS = 2_000;
/** doors (enter, climb, answer, buy, errand): one per this long; a door answered is a write at most, never a fetch */
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
/** the room's heartbeat (batched moves, round ticks), ms */
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
/** loose notes on the ground at once, one more every NOTE_EVERY_MS while anyone is in */
export const NOTES_ON_GROUND = 6;
export const NOTE_EVERY_MS = 20_000;
/** a note is worth this many dollars, NOTE_MIN .. NOTE_MIN + NOTE_SPREAD */
export const NOTE_MIN = 5;
export const NOTE_SPREAD = 20;
/** a wave counts for the job when someone stands this near */
export const WAVE_NEAR_M = 6;
/** an account key: what the browser keeps (base64url) */
export const KEY_RE = /^[A-Za-z0-9_-]{24,64}$/;

/** open ground a note can land on: rings across the plaza, clear of the fountain, stalls, board and buildings */
const NOTE_KEEP_OUT: [number, number, number][] = [
  [0, 0, 6], // the fountain
  [-10.5, -9, 3.5], [-3.6, -11, 3.5], [3.6, -11, 3.5], [10.5, -9, 3.5], // the stalls
  [0, -20, 9], // the Pools Board
  [24, 2, 6], // the Guard House
  [-24, 2, 4.5], // the desk
  [-18, 20, 4], // the Notice Board
  [-11, 12, 2.2], [11, 13, 2.2], [28, 18, 2.2], // benches
  [-13.5, 4.5, 2], [-12.8, 5.8, 2], [13.5, 6.5, 2], [16, -16, 2], [-15, -15, 2], // stacks
];
export const NOTE_SPOTS: [number, number][] = (() => {
  const out: [number, number][] = [];
  for (const r of [8, 12, 16, 20, 24, 28, 33]) {
    const n = Math.round((2 * Math.PI * r) / 7);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI + r * 0.37;
      const x = Math.round(Math.sin(a) * r * 10) / 10;
      const z = Math.round(Math.cos(a) * r * 10) / 10;
      // (the rings run clear of the lamps at r 31 and the trees at r 36-38)
      if (NOTE_KEEP_OUT.some(([kx, kz, kr]) => Math.hypot(x - kx, z - kz) < kr)) continue;
      out.push([x, z]);
    }
  }
  return out;
})();

// ---------------------------------------------------------------- accounts

export interface Account {
  id: string;
  name: string;
  strap: number;
  stack: number;
  /** on an open round; refunded when a restart loses the round */
  staked: number;
  /** the UTC day the counts are for */
  day: string;
  wagePaid: boolean;
  jobs: Record<JobId, { have: number; paid: boolean }>;
  rounds: number;
  notes: number;
  created: number;
  seen: number;
  kit: Kit;
  /** the doors reached so far (PLACES ids; the four ends among them) */
  found: string[];
  /** the errand in hand */
  errand: { id: ErrandId; step: number; done: string[] } | null;
  errandsDone: ErrandId[];
  /** today's run, once taken */
  daily: { places: string[]; found: string[]; paid: boolean } | null;
  /** errand rewards waiting at the desk, dollars */
  owed: number;
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

const freshJobs = (): Account["jobs"] => Object.fromEntries(JOBS.map((j) => [j.id, { have: 0, paid: false }])) as Account["jobs"];

/** a new day: the wage, the jobs and the day's counts start again (true when it rolled) */
export function rollDay(a: Account, now: number): boolean {
  const day = dayOf(now);
  if (a.day === day) return false;
  a.day = day;
  a.wagePaid = false;
  a.jobs = freshJobs();
  a.rounds = 0;
  a.notes = 0;
  // yesterday's run is over, done or not; the chain's errand in hand carries over
  a.daily = null;
  if (a.errand?.id === "daily") a.errand = null;
  return true;
}

/** a stored account with anything missing or malformed put right (older rows, hand edits) */
export function cleanAccount(a: Account): Account {
  const jobs = freshJobs();
  for (const j of JOBS) {
    const had = a.jobs?.[j.id];
    if (had && isNum(had.have)) jobs[j.id] = { have: Math.max(0, Math.min(j.need, Math.floor(had.have))), paid: had.paid === true };
  }
  const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 40) : []);
  const errandIds = (v: unknown): ErrandId[] => ids(v).filter((x): x is ErrandId => ERRANDS.some((e) => e.id === x));
  const errand = isRecord(a.errand) && (ERRANDS.some((e) => e.id === a.errand?.id) || a.errand.id === "daily")
    ? { id: a.errand.id, step: isNum(a.errand.step) ? Math.max(0, Math.floor(a.errand.step)) : 0, done: ids(a.errand.done) }
    : null;
  const daily = isRecord(a.daily) && Array.isArray(a.daily.places) && a.daily.places.length === DAILY_PLACES
    ? { places: ids(a.daily.places), found: ids(a.daily.found), paid: a.daily.paid === true }
    : null;
  return {
    ...a,
    stack: isNum(a.stack) ? Math.max(0, Math.floor(a.stack)) : START_STACK,
    staked: isNum(a.staked) ? Math.max(0, Math.floor(a.staked)) : 0,
    wagePaid: a.wagePaid === true,
    jobs,
    rounds: isNum(a.rounds) ? a.rounds : 0,
    notes: isNum(a.notes) ? a.notes : 0,
    kit: cleanKit(a.kit),
    found: [...new Set(ids(a.found))],
    // a daily errand in hand needs its run; the run needs its errand or its pay
    errand: errand && (errand.id !== "daily" || daily) ? errand : null,
    errandsDone: [...new Set(errandIds(a.errandsDone))],
    daily,
    owed: isNum(a.owed) ? Math.max(0, Math.floor(a.owed)) : 0,
  };
}

export function meOf(a: Account): Me {
  return {
    stack: a.stack,
    staked: a.staked,
    day: a.day,
    wagePaid: a.wagePaid,
    jobs: JOBS.map((j) => ({ id: j.id, have: a.jobs[j.id].have, paid: a.jobs[j.id].paid })),
    rounds: a.rounds,
    notes: a.notes,
    kit: { ...a.kit },
    found: [...a.found],
    errand: a.errand ? { id: a.errand.id, step: a.errand.step, done: [...a.errand.done] } : null,
    errandsDone: [...a.errandsDone],
    daily: a.daily ? { places: [...a.daily.places], found: [...a.daily.found], paid: a.daily.paid } : null,
    owed: a.owed,
    title: titleOf(a.stack),
  };
}

/** the UTC hour the tower shows, 0..23 */
export const hourOf = (ms: number): number => new Date(ms).getUTCHours();

/** a door the errands and the shops can name: a PLACES entry, or the plaza's own Guard House and desk */
export function doorOf(id: string): { x: number; z: number; r: number } | null {
  if (id === PLACE_IDS.desk) return { x: DESK_SPOT.x, z: DESK_SPOT.z, r: DESK_SPOT.r };
  if (id === PLACE_IDS.guardHouse) return { x: GUARD_SPOT.x, z: GUARD_SPOT.z, r: DOOR_REACH_M };
  const pl = PLACES.find((q) => q.id === id);
  return pl ? { x: pl.x, z: pl.z, r: DOOR_REACH_M } : null;
}

/** the doors the daily run may draw from: every place but the four ends */
export const DAILY_POOL: readonly string[] = PLACES.map((q) => q.id).filter((id) => !END_IDS.includes(id));

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
  /** drop loose notes about the plaza (default true) */
  notes?: boolean;
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
  /** dollars from the stack on this round (0: practice) */
  stake: number;
  /** the stall's cut, taken with the stake at the lay (0: practice) */
  rake: number;
  /** the hour a staked round settles at, fixed at the lay (TICKS for practice, which may close at any hour) */
  hold: number;
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
  stake: number;
  rake: number;
  hold: number;
  widthBins: number;
  offsetBins: number;
  start: number;
  sent: number;
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
  payAt: number;
  doorAt: number;
  errorAt: number;
  /** the hour the tower showed at this session's last climb, or null before one */
  climbed: number | null;
  /** the open round, if any (one at a time) */
  round: Round | null;
  /** the account behind the player: its stack, today's jobs */
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

/** refill, then take one token; false when the bucket is dry */
export function takeToken(b: Bucket, now: number, perSecond: number, burst: number): boolean {
  const dt = Math.max(0, now - b.at) / 1000;
  b.tokens = Math.min(burst, b.tokens + dt * perSecond);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** a point pulled back onto the disc of WORLD_RADIUS if it lies outside (the plaza alone: spawns and notes; a move uses town.ts) */
export function clampToDisc(x: number, z: number, radius = WORLD_RADIUS): [number, number] {
  const d = Math.hypot(x, z);
  if (d <= radius) return [x, z];
  const k = radius / d;
  return [x * k, z * k];
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
  private readonly notes = new Map<string, Note>();
  private noteAt = -Infinity;
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
  }

  /** the biggest stacks, biggest first */
  stacks(): StackRow[] {
    return this.stacksTop.map((r) => ({ ...r }));
  }

  /** the notes on the ground */
  notesOnGround(): Note[] {
    return [...this.notes.values()].map((n) => ({ ...n }));
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
    this.refund(acct);
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
      case "pay":
        return this.pay(p, now);
      case "enter":
        return this.enter(p, msg, now);
      case "climb":
        return this.climb(p, now);
      case "answer":
        return this.answer(p, msg, now);
      case "buy":
        return this.buy(p, msg, now);
      case "errand":
        return this.takeErrand(p, msg, now);
      default:
        return;
    }
  }

  /** a player's open round as the server holds it, seed included: for tests and logs, never for the wire */
  roundOf(id: string): RoundView | null {
    const r = this.conns.get(id)?.player?.round;
    if (!r) return null;
    const { roundId, pool, seed, widthBins, offsetBins, start, sent, stake, rake, hold } = r;
    return { roundId, pool: { ...pool }, seed, from: r.market?.from ?? null, widthBins, offsetBins, start, sent, stake, rake, hold };
  }

  /** a socket closed; an open round settles quietly (a staked one at its hold, its worth paid to the stack) */
  leave(id: string): void {
    const conn = this.conns.get(id);
    if (!conn) return;
    const p = conn.player;
    if (p?.round) this.settle(p, p.round, this.endOf(p.round), this.deps.now(), true);
    this.conns.delete(id);
    if (p) this.deps.broadcast({ t: "leave", id });
  }

  /** TICK_HZ: close sockets that never said hello, advance every open round, flush the moves batch */
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
    if (this.deps.notes !== false && players.length && this.notes.size < NOTES_ON_GROUND && now >= this.noteAt) {
      this.noteAt = now + NOTE_EVERY_MS;
      this.dropNote();
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
        staked: 0,
        day: dayOf(now),
        wagePaid: false,
        jobs: freshJobs(),
        rounds: 0,
        notes: 0,
        created: now,
        seen: now,
        kit: { ...DEFAULT_KIT },
        found: [],
        errand: null,
        errandsDone: [],
        daily: null,
        owed: 0,
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
    this.refund(acct);
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
      notes: this.notesOnGround(),
      stacks: this.stacks(),
      ...(newKey ? { key: newKey } : {}),
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
    if (out.t === "emote" && out.e === "wave") {
      const near = [...this.conns.values()].some((c) => c.player && c.player !== p && Math.hypot(c.player.x - p.x, c.player.z - p.z) <= WAVE_NEAR_M);
      if (near) this.job(p, "wave", 1, now);
    }
  }

  /** progress on one of today's jobs (have is raised to at least `have`, capped at the job's need) */
  private job(p: Player, id: JobId, have: number, now: number): void {
    const a = p.acct;
    rollDay(a, now);
    const need = JOBS.find((j) => j.id === id)!.need;
    const next = Math.min(need, Math.max(a.jobs[id].have, have));
    if (next === a.jobs[id].have) return;
    a.jobs[id].have = next;
    this.store.put(a);
    this.deps.send(p.id, { t: "me", me: meOf(a) });
  }

  /** pick up a loose note: it must be there, and you within NOTE_REACH of it, with notes left today */
  private pick(p: Player, msg: Record<string, unknown>, now: number): void {
    const id = typeof msg.note === "string" ? msg.note : "";
    const note = this.notes.get(id);
    if (!note) {
      // gone (someone else's, or lost in a restart): tell the asker, whose walker would otherwise ask again and again
      if (id && id.length <= 16) this.deps.send(p.id, { t: "notes", add: [], gone: [id] });
      return;
    }
    const a = p.acct;
    rollDay(a, now);
    if (a.notes >= NOTES_PER_DAY) {
      this.error(p, "notes done", now);
      return;
    }
    if (Math.hypot(note.x - p.x, note.z - p.z) > NOTE_REACH) return;
    this.notes.delete(id);
    a.stack += note.v;
    a.notes += 1;
    const need = JOBS.find((j) => j.id === "notes")!.need;
    a.jobs.notes.have = Math.min(need, a.jobs.notes.have + 1);
    this.store.put(a);
    this.deps.broadcast({ t: "picked", id: p.id, note: id, v: note.v });
    this.deps.send(p.id, { t: "me", me: meOf(a) });
    this.stackChanged(p);
  }

  /** collect the wage and the finished jobs, standing at Mr Bands' desk; one pay per PAY_GAP_MS */
  private pay(p: Player, now: number): void {
    if (now - p.payAt < PAY_GAP_MS) {
      this.slow(p, now);
      return;
    }
    p.payAt = now;
    if (Math.hypot(p.x - DESK_SPOT.x, p.z - DESK_SPOT.z) > DESK_SPOT.r) {
      this.error(p, "not at the desk", now);
      return;
    }
    const a = p.acct;
    rollDay(a, now);
    let amount = 0;
    if (!a.wagePaid) {
      a.wagePaid = true;
      amount += WAGE;
    }
    for (const j of JOBS) {
      const s = a.jobs[j.id];
      if (!s.paid && s.have >= j.need) {
        s.paid = true;
        amount += j.reward;
      }
    }
    // the errands: what the chain and the day's run earned since the last visit
    amount += a.owed;
    a.owed = 0;
    // nothing to collect: nothing changed, so nothing is written or re-sent (a new day always has the wage)
    if (!amount) {
      this.deps.send(p.id, { t: "paid", amount: 0 });
      return;
    }
    a.stack += amount;
    this.store.put(a);
    this.deps.send(p.id, { t: "paid", amount });
    this.deps.send(p.id, { t: "me", me: meOf(a) });
    this.stackChanged(p);
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

  /** the errand in hand as a table row: the chain's, or the daily run with the doors the room drew */
  private errandOf(a: Account): Errand | null {
    if (!a.errand) return null;
    if (a.errand.id === "daily") return a.daily ? { ...DAILY, steps: a.daily.places } : null;
    return ERRANDS.find((e) => e.id === a.errand!.id) ?? null;
  }

  /**
   * a door reached on the errand in hand: the next step in order (or any step left, for an any-order errand) is
   * marked done, unless it is the last step and asks a task there (the task marks it). A purchase asked of someone
   * who wears the thing already is the one task done on entering: he gets his box, the player keeps theirs (the shop
   * sells one to a customer, so the errand would have no way through). true when the errand moved
   */
  private stepErrand(a: Account, place: string): boolean {
    const e = this.errandOf(a);
    const h = a.errand;
    if (!e || !h) return false;
    const last = e.steps.length - 1;
    const i = e.any ? e.steps.indexOf(place) : e.steps[h.step] === place ? h.step : -1;
    if (i < 0 || h.done.includes(place)) return false;
    if (e.task && (e.any || i === last) && !(e.task.do === "buy" && owns(a.kit, e.task.item))) return false;
    h.done.push(place);
    h.step = h.done.length;
    if (e.id === "daily" && a.daily && !a.daily.found.includes(place)) a.daily.found.push(place);
    if (h.step >= e.steps.length) this.finishErrand(a, e);
    return true;
  }

  /** the errand is done: its reward waits at the desk, the day's run's too (its row is marked, so the board says done) */
  private finishErrand(a: Account, e: Errand): void {
    a.errand = null;
    a.owed += e.reward;
    if (e.id === "daily") {
      if (a.daily) a.daily.paid = true;
      return;
    }
    if (!a.errandsDone.includes(e.id)) a.errandsDone.push(e.id);
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
   * enter a door: the position is checked, the discovery recorded and paid the first time (FOUND_PAY at once), the
   * errand moved on, and the interior answered; the account is written once, and only when any of that changed
   */
  private enter(p: Player, msg: Record<string, unknown>, now: number): void {
    const id = typeof msg.place === "string" && msg.place.length <= 40 ? msg.place : "";
    if (!id || !this.doorTurn(p, now)) return;
    if (!this.atDoor(p, id, now)) return;
    const a = p.acct;
    let changed = rollDay(a, now);
    let paid = 0;
    if (id !== PLACE_IDS.desk && id !== PLACE_IDS.guardHouse && !a.found.includes(id)) {
      a.found.push(id);
      a.stack += FOUND_PAY;
      paid = FOUND_PAY;
      changed = true;
    }
    if (this.stepErrand(a, id)) changed = true;
    if (changed) this.store.put(a);
    if (paid) this.deps.send(p.id, { t: "found", place: id, paid });
    const shop = shopOf(id);
    this.deps.send(p.id, { t: "place", id, ...this.placeExtras(id, now), ...(shop ? { stock: this.stockFor(a, shop) } : {}) });
    if (changed) this.deps.send(p.id, { t: "me", me: meOf(a) });
    if (paid) this.stackChanged(p);
  }

  /** climb the tower: the hour it shows is the room's own, kept for the errand's question; nothing is written */
  private climb(p: Player, now: number): void {
    if (!this.doorTurn(p, now)) return;
    if (!this.atDoor(p, PLACE_IDS.clockTower, now)) return;
    p.climbed = hourOf(now);
    this.deps.send(p.id, { t: "place", id: PLACE_IDS.clockTower, hour: p.climbed });
  }

  /** errand "clock": the hour, at the tower, after a climb; the hour shown at the climb, or the hour now, is right */
  private answer(p: Player, msg: Record<string, unknown>, now: number): void {
    const hour = msg.hour;
    if (!isNum(hour) || !Number.isInteger(hour) || hour < 0 || hour > 23) return;
    if (!this.doorTurn(p, now)) return;
    const a = p.acct;
    const e = this.errandOf(a);
    if (!e || e.task?.do !== "answer" || p.climbed === null) {
      this.error(p, "no errand", now);
      return;
    }
    if (!this.atDoor(p, e.steps[e.steps.length - 1], now)) return;
    if (hour !== p.climbed && hour !== hourOf(now)) {
      this.error(p, "wrong hour", now);
      return;
    }
    a.errand!.done.push(e.steps[e.steps.length - 1]);
    a.errand!.step = a.errand!.done.length;
    this.finishErrand(a, e);
    this.store.put(a);
    this.deps.send(p.id, { t: "me", me: meOf(a) });
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
    rollDay(a, now);
    a.stack -= row.price;
    a.kit = wear(a.kit, row.item);
    const e = this.errandOf(a);
    if (e?.task?.do === "buy" && e.task.item === row.item && e.steps[e.steps.length - 1] === here.id) {
      a.errand!.done.push(here.id);
      a.errand!.step = a.errand!.done.length;
      this.finishErrand(a, e);
    }
    this.store.put(a);
    this.deps.send(p.id, { t: "bought", item: row.item });
    this.deps.send(p.id, { t: "me", me: meOf(a) });
    this.deps.broadcast({ t: "kit", id: p.id, kit: { ...a.kit } });
    this.stackChanged(p);
  }

  /**
   * take an errand at the desk or at Bands & Co.: the chain's next, or once the chain is done today's run, DAILY_PLACES
   * doors drawn from every place but the ends, once a day. One in hand already is answered with the account as it is
   */
  private takeErrand(p: Player, msg: Record<string, unknown>, now: number): void {
    if (msg.take !== true) return;
    if (!this.doorTurn(p, now)) return;
    const desk = doorOf(PLACE_IDS.desk)!;
    const house = doorOf(PLACE_IDS.bandsCo);
    const atDesk = Math.hypot(p.x - desk.x, p.z - desk.z) <= desk.r;
    const atHouse = house !== null && Math.hypot(p.x - house.x, p.z - house.z) <= house.r;
    if (!atDesk && !atHouse) {
      this.error(p, "not there", now);
      return;
    }
    const a = p.acct;
    const rolled = rollDay(a, now);
    if (a.errand) {
      if (rolled) this.store.put(a);
      this.deps.send(p.id, { t: "me", me: meOf(a) });
      return;
    }
    const next = ERRANDS.find((e) => !a.errandsDone.includes(e.id));
    if (next) {
      a.errand = { id: next.id, step: 0, done: [] };
    } else {
      if (a.daily || DAILY_POOL.length < DAILY_PLACES) {
        if (rolled) this.store.put(a);
        this.error(p, "no errand", now);
        return;
      }
      const pool = [...DAILY_POOL];
      const places: string[] = [];
      while (places.length < DAILY_PLACES) places.push(pool.splice(Math.floor(this.deps.random() * pool.length) % pool.length, 1)[0]);
      a.daily = { places, found: [], paid: false };
      a.errand = { id: "daily", step: 0, done: [] };
    }
    this.store.put(a);
    this.deps.send(p.id, { t: "me", me: meOf(a) });
  }

  /** a note on open ground, clear of the others */
  private dropNote(): void {
    const free = NOTE_SPOTS.filter(([x, z]) => ![...this.notes.values()].some((n) => Math.hypot(n.x - x, n.z - z) < 4));
    if (!free.length) return;
    const [x, z] = free[Math.floor(this.deps.random() * free.length) % free.length];
    const note: Note = {
      id: `n${this.randomId(7)}`,
      x: r2(x + (this.deps.random() - 0.5) * 2),
      z: r2(z + (this.deps.random() - 0.5) * 2),
      v: NOTE_MIN + (Math.floor(this.deps.random() * (NOTE_SPREAD + 1)) % (NOTE_SPREAD + 1)),
    };
    this.notes.set(note.id, note);
    this.deps.broadcast({ t: "notes", add: [{ ...note }], gone: [] });
  }

  /** a stake left on an account by a round a restart lost goes back to the stack */
  private refund(a: Account): void {
    if (a.staked > 0) {
      a.stack += a.staked;
      a.staked = 0;
    }
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

  /** lay a band: validate, find the pool on the server's board, deal a seed, run the round, say "laid" */
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
    // the stake: none (a practice round), or MIN_STAKE..MAX_STAKE whole dollars with the rake on top of it in the stack,
    // within today's staked rounds; the hold: one of HOLDS for a staked round (TICKS when absent), TICKS for practice
    const stake = msg.stake === undefined ? 0 : msg.stake;
    if (!isNum(stake) || !Number.isInteger(stake) || stake < 0 || (stake > 0 && (stake < MIN_STAKE || stake > MAX_STAKE))) {
      this.error(p, "bad stake", now);
      return;
    }
    const rake = stake > 0 ? Math.ceil((stake * RAKE_PCT) / 100) : 0;
    if (stake + rake > p.acct.stack) {
      this.error(p, "bad stake", now);
      return;
    }
    const hold = stake > 0 ? (msg.hold === undefined ? TICKS : msg.hold) : TICKS;
    if (!isNum(hold) || !(HOLDS as readonly number[]).includes(hold)) {
      this.error(p, "bad choice", now);
      return;
    }
    // a new day at the lay: the page learns its fresh counts now (a practice settle would not write or say so)
    if (rollDay(p.acct, now)) this.deps.send(p.id, { t: "me", me: meOf(p.acct) });
    if (stake > 0 && p.acct.rounds >= ROUNDS_PER_DAY) {
      this.error(p, "no rounds left", now);
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
      // money rides on real hours only: a simulated round pays the board's one hot hour for every hour it is in
      // range, with nothing to vary it, so a stake on a hot pool with no history was a sure +30% (measured 24 Sep).
      // A room with no history service at all (tests, a dev without the file) still stakes on simulated rounds.
      if (stake > 0 && !market) {
        this.error(p, "practice only", this.deps.now());
        return;
      }
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
    if (stake + rake > p.acct.stack) {
      this.error(p, "bad stake", start);
      return;
    }
    const round: Round = { roundId: this.roundId(), pool, seed, widthBins, offsetBins, market, sim, start, sent: 0, stake, rake, hold };
    p.round = round;
    if (stake > 0) {
      // the stake and the rake leave the stack together; only the stake is in play (the rake is the stall's)
      p.acct.stack -= stake + rake;
      p.acct.staked = stake;
      p.acct.rounds += 1;
      this.store.put(p.acct);
      this.deps.send(p.id, { t: "me", me: meOf(p.acct) });
      this.stackChanged(p);
    }
    this.deps.send(p.id, {
      t: "laid",
      roundId: round.roundId,
      pool: { ...pool },
      lower: sim.lower,
      upper: sim.upper,
      tickMs: ROUND_TICK_MS,
      real: market !== null,
      ...(stake > 0 ? { stake, rake, hold } : {}),
    });
  }

  /**
   * A random stretch of the pool's history long enough for a round, or null (too short, unreadable, unpriceable, or
   * too quiet). A stretch must have MIN_LIVE_HOURS of its hours with volume: hourlySeries fills a silent hour with the
   * last close and no volume, so a thin history would deal flat stretches that pay exactly nothing (a sure loss of the
   * rake) and stretches that all hold its one move, which anyone reading the history could tell apart.
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

  /**
   * a practice round: settle at the last tick already sent (tick 1, sent now, if none had gone out). A staked round:
   * skip to the end, the ticks left to its hold sent at once and the round settled there
   */
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

  /** the hour a round cut short settles at: a staked round's hold, whatever was sent; the last hour sent for practice */
  private endOf(r: Round): number {
    return r.stake > 0 ? r.hold : Math.max(1, r.sent);
  }

  /** the heartbeat's work on one round: expire it, or send the ticks now due and settle at its hold */
  private advance(p: Player, r: Round, now: number): void {
    if (now - r.start > ROUND_TTL_MS) {
      // (the ticks stalled): settle now, where a close would, so a stake is never stranded
      const at = this.endOf(r);
      this.sendTicks(p, r, at);
      this.settle(p, r, at, now);
      return;
    }
    const due = Math.min(r.hold, Math.floor((now - r.start) / ROUND_TICK_MS));
    if (due > r.sent) this.sendTicks(p, r, due);
    if (r.sent >= r.hold) this.settle(p, r, r.hold, now);
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
   * Score the round at hour `at`: simulate() re-run with that closeAt, "scored" to the player. A staked round pays the
   * stake back as the position's worth there (value + fees, percent of the deposit; the rake stays with the stall),
   * moves the day's jobs on and goes on the Best rounds board ("board" to the room if the top changed). A practice
   * round records nothing, so the account is written only when something changed (a stake, a job, the day rolling).
   * quiet: the player has gone, so nothing is sent to them.
   */
  private settle(p: Player, r: Round, at: number, now: number, quiet = false): void {
    p.round = null;
    let res: SimResult;
    try {
      res = simulate(r.pool, r.seed, { widthBins: r.widthBins, offsetBins: r.offsetBins, closeAt: at }, r.market);
    } catch {
      // cannot happen for a round that was dealt; the stake goes back rather than vanishing
      res = { ...r.sim, closedAt: at, scorePct: 0, valuePct: r.sim.valuePct.map(() => 100), feesPct: r.sim.feesPct.map(() => 0) };
    }
    const pct = isNum(res.scorePct) ? r2(res.scorePct) : 0;
    const a = p.acct;
    const staked = r.stake > 0;
    let back = 0;
    if (staked) {
      // the stake plus what the band made against just holding (fees less the loss to holding), never the position's
      // raw worth: the board's pools just surged, and their history is a rise already known, so the raw worth was a
      // long on it (measured 24 Sep: a wide all-token band paid a mean 169% of the stake). A band's value never beats
      // holding and its fees are capped, so this is at most 1.3 x the stake.
      const made = res.valuePct[at] + res.feesPct[at] - res.holdPct[at];
      back = isNum(made) ? Math.max(0, Math.round((r.stake * (100 + made)) / 100)) : r.stake;
      a.stack += back;
      a.staked = 0;
    }
    const rolled = rollDay(a, now);
    let moved = false;
    if (staked) {
      const hoursIn = res.inRange.slice(1, at + 1).filter(Boolean).length;
      const range = JOBS.find((j) => j.id === "range")!.need;
      const next = Math.min(range, Math.max(a.jobs.range.have, hoursIn));
      if (next !== a.jobs.range.have) {
        a.jobs.range.have = next;
        moved = true;
      }
      if (pct > 0 && a.jobs.beat.have < 1) {
        a.jobs.beat.have = 1;
        moved = true;
      }
    }
    if (staked || rolled || moved) this.store.put(a);
    const { rank, changed } = staked ? this.record({ name: p.name, pool: r.pool.label, pct, at: now }) : { rank: null, changed: false };
    if (!quiet) {
      const stakeBits = staked ? { stake: r.stake, back } : {};
      this.deps.send(p.id, r.market ? { t: "scored", roundId: r.roundId, pct, at, rank, from: r.market.from, ...stakeBits } : { t: "scored", roundId: r.roundId, pct, at, rank, ...stakeBits });
      if (staked || rolled) this.deps.send(p.id, { t: "me", me: meOf(a) });
    }
    if (staked) this.stackChanged(p);
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
    why:
      | "unknown pool"
      | "board unavailable"
      | "round in play"
      | "no such round"
      | "bad choice"
      | "bad stake"
      | "no rounds left"
      | "not at the desk"
      | "notes done"
      | "practice only"
      | "not there"
      | "no stack"
      | "have one"
      | "no errand"
      | "wrong hour",
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
      payAt: -Infinity,
      doorAt: -Infinity,
      errorAt: -Infinity,
      climbed: null,
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
