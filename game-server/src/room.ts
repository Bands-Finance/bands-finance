/**
 * THE ROOM (a Durable Object): the one plaza everyone walks in. All the rules live in RoomCore (core.ts); this class
 * only wires Cloudflare to it:
 *   - sockets are accepted with the hibernation API (ctx.acceptWebSocket) and known to the core by a short id, kept
 *     in the socket's attachment (with the name and strap once they join) so a restarted object can find them again
 *   - webSocketMessage / webSocketClose / webSocketError feed core.message / core.leave
 *   - a setInterval at TICK_HZ runs core.tick() (the batched moves, and the ticks of every round in play) while any
 *     socket is open, and stops when the room empties, so an empty room can hibernate and costs nothing
 *   - the leaderboard is kept in the object's storage under "board", the Coffee House's talk under "talk"; both are
 *     loaded before the first event
 *   - accounts (the stacks) live in the object's SQLite (sqlAccounts), found by the SHA-256 of their key
 *   - pools' hourly histories come from the desk's history.json (HISTORY_URL) and are held in memory by historySource
 */
import { DurableObject } from "cloudflare:workers";
import type { S2C } from "../../web/src/game/protocol";
import { boardSource, CLOSE_FULL, historyFromFile, historySource, ROOM_TICK_MS, RoomCore, type Account, type AccountStore } from "./core";

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  /** the live board the room deals rounds from (hot.json) */
  BOARD_URL: string;
  /** the stall pools' hourly history (history.json, written by the desk) */
  HISTORY_URL: string;
  /** comma-separated origins allowed to open /ws */
  ALLOWED_ORIGINS: string;
}

/** what a socket's attachment holds */
interface Tag {
  id: string;
  /** the account, once they have joined */
  account?: string;
}

/**
 * the accounts table: the whole account as JSON, with the columns it is looked up and ranked by. Names are unique
 * (the board and the stacks are keyed by them): an insert whose name was taken meanwhile throws, and the core tries
 * again with another. A table that already holds a duplicate keeps its plain name index rather than failing to open.
 */
function sqlAccounts(sql: SqlStorage): AccountStore {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, key_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL, stack INTEGER NOT NULL, created INTEGER NOT NULL, data TEXT NOT NULL)",
  );
  sql.exec("CREATE INDEX IF NOT EXISTS accounts_stack ON accounts (stack DESC, created ASC)");
  try {
    sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS accounts_name_unique ON accounts (name)");
    sql.exec("DROP INDEX IF EXISTS accounts_name");
  } catch {
    sql.exec("CREATE INDEX IF NOT EXISTS accounts_name ON accounts (name)");
  }
  const one = (q: string, v: string): Account | null => {
    const row = sql.exec(q, v).toArray()[0];
    if (!row) return null;
    try {
      return JSON.parse(String(row.data)) as Account;
    } catch {
      return null;
    }
  };
  return {
    byKeyHash: (h) => one("SELECT data FROM accounts WHERE key_hash = ?", h),
    byId: (id) => one("SELECT data FROM accounts WHERE id = ?", id),
    put: (a, keyHash) => {
      if (keyHash) sql.exec("INSERT INTO accounts (id, key_hash, name, stack, created, data) VALUES (?, ?, ?, ?, ?, ?)", a.id, keyHash, a.name, a.stack, a.created, JSON.stringify(a));
      else sql.exec("UPDATE accounts SET name = ?, stack = ?, data = ? WHERE id = ?", a.name, a.stack, JSON.stringify(a), a.id);
    },
    nameTaken: (name) => sql.exec("SELECT 1 FROM accounts WHERE name = ? LIMIT 1", name).toArray().length > 0,
    topStacks: (n) =>
      sql
        .exec("SELECT name, stack FROM accounts ORDER BY stack DESC, created ASC LIMIT ?", n)
        .toArray()
        .map((r) => ({ name: String(r.name), stack: Number(r.stack) })),
  };
}

/** an account key -> the hex SHA-256 kept for it */
async function sha256(key: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const BOARD_KEY = "board";
const TALK_KEY = "talk";

/** uniform [0, 1) from the platform's CSPRNG (seeds, ids and names come from here) */
const cryptoRandom = (): number => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;

/**
 * The desk's history.json (the stall pools' hourly history), held HISTORY_FILE_TTL_MS, one read in flight. The room
 * can't read GeckoTerminal itself: it answers Cloudflare's shared addresses with 429.
 */
const HISTORY_FILE_TTL_MS = 5 * 60_000;
function historyFile(url: string): () => Promise<unknown> {
  let held: { at: number; data: unknown } | null = null;
  let inflight: Promise<unknown> | null = null;
  return () => {
    if (held && Date.now() - held.at < HISTORY_FILE_TTL_MS) return Promise.resolve(held.data);
    if (inflight) return inflight;
    inflight = fetch(url, { headers: { accept: "application/json", "user-agent": "bands-exchange/1" }, signal: AbortSignal.timeout(6_000) })
      .then((res) => (res.ok ? res.json() : held?.data ?? null))
      .catch(() => held?.data ?? null)
      .then((data) => {
        held = { at: Date.now(), data };
        inflight = null;
        return data;
      });
    return inflight;
  };
}

async function fetchBoard(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "bands-exchange/1" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`board ${res.status}`);
  return res.json();
}

export class Room extends DurableObject<Env> {
  private readonly core: RoomCore;
  private readonly sockets = new Map<string, WebSocket>();
  private readonly idOfSocket = new WeakMap<WebSocket, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** broadcasts and batches hand the same object to many sockets: serialise it once */
  private lastMsg: S2C | null = null;
  private lastText = "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const board = boardSource({ load: () => fetchBoard(env.BOARD_URL), now: () => Date.now() });
    const file = historyFile(env.HISTORY_URL);
    const history = historySource({ load: async (pool) => historyFromFile(await file(), pool.address), now: () => Date.now() });
    this.core = new RoomCore({
      send: (id, msg) => this.sendText(id, this.textOf(msg)),
      broadcast: (msg, exceptId) => {
        const text = this.textOf(msg);
        for (const id of this.core.ids()) if (id !== exceptId) this.sendText(id, text);
      },
      now: () => Date.now(),
      random: cryptoRandom,
      board,
      history,
      accounts: sqlAccounts(ctx.storage.sql),
      hashKey: sha256,
      saveBoard: (rows) => {
        this.ctx.storage.put(BOARD_KEY, rows).catch(() => {});
      },
      saveTalk: (rows) => {
        this.ctx.storage.put(TALK_KEY, rows).catch(() => {});
      },
      close: (id, code, reason) => {
        const ws = this.sockets.get(id);
        this.sockets.delete(id);
        try {
          // the socket no longer names the account: a restart that still finds it must not restore a second session
          ws?.serializeAttachment({ id } satisfies Tag);
          ws?.close(code, reason);
        } catch {
          /* already closing */
        }
      },
      joined: (id, account) => {
        const ws = this.sockets.get(id);
        try {
          ws?.serializeAttachment({ id, account } satisfies Tag);
        } catch {
          /* closed under us */
        }
      },
    });

    ctx.blockConcurrencyWhile(async () => {
      const [board, talk] = await Promise.all([this.ctx.storage.get(BOARD_KEY), this.ctx.storage.get(TALK_KEY)]);
      this.core.loadBoard(board);
      this.core.loadTalk(talk);
    });

    // Woken from hibernation: the sockets survived, the memory did not. Joined players are put back and sent their
    // account (a round the restart lost had its stake refunded); a socket that had not said hello yet, or names an
    // account already put back, is closed (its client reconnects).
    for (const ws of ctx.getWebSockets()) {
      const tag = ws.deserializeAttachment() as Tag | null;
      if (!tag?.id || typeof tag.account !== "string" || !this.core.restore(tag.id, tag.account)) {
        try {
          ws.close(1012, "restart");
        } catch {
          /* gone */
        }
        continue;
      }
      this.sockets.set(tag.id, ws);
      this.idOfSocket.set(ws, tag.id);
      const me = this.core.meOf(tag.id);
      if (me) this.sendText(tag.id, JSON.stringify({ t: "me", me } satisfies S2C));
    }
    this.ensureTimer();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("not found", { status: 404 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const id = this.core.open(request.headers.get("CF-Connecting-IP") ?? "");
    if (!id) {
      // the door is shut: say so and close, without keeping the socket
      server.accept();
      server.send(JSON.stringify({ t: "full" } satisfies S2C));
      server.close(CLOSE_FULL, "full");
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id } satisfies Tag);
    this.sockets.set(id, server);
    this.idOfSocket.set(server, id);
    this.ensureTimer();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const id = this.idOf(ws);
    if (!id) return;
    await this.core.message(id, message);
    this.ensureTimer();
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.drop(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.drop(ws);
  }

  // ---------------------------------------------------------------- plumbing

  private idOf(ws: WebSocket): string | null {
    const known = this.idOfSocket.get(ws);
    if (known) return known;
    const tag = ws.deserializeAttachment() as Tag | null;
    return tag?.id ?? null;
  }

  private drop(ws: WebSocket): void {
    const id = this.idOf(ws);
    if (!id) return;
    if (this.sockets.get(id) === ws) this.sockets.delete(id);
    this.core.leave(id);
    if (this.core.connections === 0) this.stopTimer();
  }

  private textOf(msg: S2C): string {
    if (msg !== this.lastMsg) {
      this.lastMsg = msg;
      this.lastText = JSON.stringify(msg);
    }
    return this.lastText;
  }

  private sendText(id: string, text: string): void {
    const ws = this.sockets.get(id);
    if (!ws) return;
    try {
      ws.send(text);
    } catch {
      /* closing; webSocketClose will tidy up */
    }
  }

  private ensureTimer(): void {
    if (this.timer || this.core.connections === 0) return;
    this.timer = setInterval(() => {
      this.core.tick();
      if (this.core.connections === 0) this.stopTimer();
    }, ROOM_TICK_MS);
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
