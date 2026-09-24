/**
 * THE EXCHANGE, BROWSER SIDE (bands.finance Play): one WebSocket to the room server (game-server/), speaking
 * protocol.ts. The page assigns the on* callbacks it cares about, calls connect(strap), and from then on:
 *   - sendMove() every frame if it likes: moves go out at most MOVE_HZ a second (the latest wins), and an unchanged
 *     position is not sent again
 *   - emote() / say() take only the allow-listed ids and return false when nothing was sent (offline, or inside the
 *     server's one-a-second limit); the server passes them to everyone else, not back to the sender, so the page
 *     shows its own bubble itself (when the call returned true)
 *   - a round is played on the server: lay(pool, widthBins, offsetBins) -> onLaid (the band's bounds and the pace),
 *     then onTick for ticks 1..TICKS as the server's clock reaches each (every laid.tickMs). closeRound(roundId)
 *     settles at the last tick already sent; reaching TICKS settles by itself. Either way onScored(roundId, pct,
 *     rank) follows. The seed and future ticks never reach the browser, so there is no score to send, and nothing
 *     to compute ahead. One round at a time; a lay while one is open is refused (onError "round in play")
 *   - onMoves carries other players only. When the server refuses this visitor's move (a jump faster than MAX_SPEED)
 *     or pulls it back onto the plaza's disc, it says where the walker really is: onCorrect(x, z, ry), put it there
 *   - the stack: the room keeps an account for this browser, opened again by the key it sends with the first welcome
 *     (kept in localStorage). onMe carries the account's own changes, onStack everyone's stacks (name tags), onNotes
 *     and onPicked the loose notes, onPaid Mr Bands' pay, onStacks the biggest-stacks board. pick() and pay() ask.
 * A dropped connection is retried with exponential backoff (to 30 s); a reconnect is a new socket id, the same
 * account. A full room is not retried, nor a socket closed because the account was opened in another tab. With no URL (VITE_GAME_WS_URL unset) the
 * status is "offline", nothing is sent, and the game plays single-player, dealing its rounds locally.
 */
import { isEmote, isPhrase, MOVE_HZ } from "./protocol";
import type { C2S, EmoteId, Me, Note, PhraseId, PlayerState, S2C, ScoreRow, StackRow } from "./protocol";

export type NetStatus = "offline" | "connecting" | "online" | "full" | "closed" | "elsewhere";
export type ScoredMsg = Extract<S2C, { t: "scored" }>;

/** where this browser keeps its account key */
const KEY_STORE = "bands:play:key";
const readKey = (): string | undefined => {
  try {
    const k = localStorage.getItem(KEY_STORE) ?? "";
    return /^[A-Za-z0-9_-]{24,64}$/.test(k) ? k : undefined;
  } catch {
    return undefined;
  }
};
const keepKey = (k: string) => {
  try {
    localStorage.setItem(KEY_STORE, k);
  } catch {
    /* a private window: the stack lasts the session */
  }
};
/** the close code the room uses when the account was opened in another tab */
const CLOSE_ELSEWHERE = 4003;
export type WelcomeMsg = Extract<S2C, { t: "welcome" }>;
/** { roundId, pool, lower, upper, tickMs } */
export type LaidMsg = Extract<S2C, { t: "laid" }>;
/** { roundId, i, p, feesPct, valuePct, holdPct, inRange }: tick i of the server's round */
export type TickMsg = Extract<S2C, { t: "tick" }>;
/** [id, x, z, ry, moving 0|1] */
export type MoveEntry = Extract<S2C, { t: "moves" }>["m"][number];

/** the room's WebSocket URL from the build (VITE_GAME_WS_URL, e.g. wss://bands-exchange.<subdomain>.workers.dev/ws) */
/** the room server bands.finance talks to (game-server/, deployed 24 Sep); its ALLOWED_ORIGINS admit bands.finance only */
export const PRODUCTION_GAME_WS_URL = "wss://bands-exchange.bands-exchange.workers.dev/ws";

export function gameWsUrl(): string | null {
  const env = import.meta.env as Record<string, string | undefined>;
  const raw = (env.VITE_GAME_WS_URL ?? "").trim();
  if (/^wss?:\/\/\S+$/i.test(raw)) return raw;
  // bands.finance itself knows its room, whatever env the build ran in (the desk's auto-deploy may predate the setting)
  if (typeof location !== "undefined" && /^(www\.)?bands\.finance$/i.test(location.hostname)) return PRODUCTION_GAME_WS_URL;
  return null;
}

/** a hair over 1000 / MOVE_HZ, so timer jitter never outruns the server's bucket */
const MOVE_GAP_MS = Math.ceil(1000 / MOVE_HZ);
/** the server allows one emote-or-phrase a second; hold the button back rather than be dropped */
const SOCIAL_GAP_MS = 1000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export class ExchangeNet {
  onWelcome: (welcome: WelcomeMsg) => void = () => {};
  onJoin: (player: PlayerState) => void = () => {};
  onLeave: (id: string) => void = () => {};
  /** other players' positions, batched */
  onMoves: (moves: MoveEntry[]) => void = () => {};
  /** the server's word on where this visitor's own walker is (after a refused or clamped move) */
  onCorrect: (x: number, z: number, ry: number) => void = () => {};
  onEmote: (id: string, emote: EmoteId) => void = () => {};
  onSay: (id: string, phrase: PhraseId) => void = () => {};
  /** the band is down and the round has started on the server */
  onLaid: (laid: LaidMsg) => void = () => {};
  /** one tick of the open round, in order, as the server's clock reaches it */
  onTick: (tick: TickMsg) => void = () => {};
  /** rank: where this score sits on the leaderboard (or null); from: a real round's first hour; stake/back: the stack's part */
  onScored: (scored: ScoredMsg) => void = () => {};
  /** this visitor's account changed (stack, jobs, the day's counts) */
  onMe: (me: Me) => void = () => {};
  /** someone's stack changed */
  onStack: (id: string, stack: number) => void = () => {};
  onNotes: (add: Note[], gone: string[]) => void = () => {};
  /** someone (maybe this visitor) picked up a note worth v */
  onPicked: (id: string, note: string, v: number) => void = () => {};
  /** Mr Bands paid this visitor (0: nothing to collect) */
  onPaid: (amount: number) => void = () => {};
  onStacks: (rows: StackRow[]) => void = () => {};
  onBoard: (rows: ScoreRow[]) => void = () => {};
  onStatus: (status: NetStatus) => void = () => {};
  /** the server is dropping this visitor's messages (sending too fast) */
  onSlow: () => void = () => {};
  /** a request was refused: "unknown pool", "board unavailable", "round in play", "no such round", "bad choice",
   *  "bad stake", "no rounds left", "not at the desk", "notes done" */
  onError: (why: string) => void = () => {};

  status: NetStatus;
  /** this visitor's id and name in the room, once welcomed */
  you: string | null = null;
  name: string | null = null;

  private readonly url: string | null;
  private ws: WebSocket | null = null;
  private strap = 0;
  /** connect() was called and close() was not */
  private wanted = false;
  /** the room said it was full on this socket */
  private full = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private moveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingMove: Extract<C2S, { t: "move" }> | null = null;
  private lastMove: Extract<C2S, { t: "move" }> | null = null;
  private lastMoveAt = -Infinity;
  private lastSocialAt = -Infinity;

  constructor(url: string | null) {
    this.url = url && /^wss?:\/\//i.test(url) ? url : null;
    this.status = this.url ? "closed" : "offline";
  }

  /** join the room wearing this strap colour (an index into STRAPS; the server clamps it) */
  connect(strap: number): void {
    this.strap = Number.isFinite(strap) ? Math.floor(strap) : 0;
    if (!this.url) {
      this.status = "offline";
      this.onStatus("offline");
      return;
    }
    this.wanted = true;
    this.attempt = 0;
    this.open();
  }

  /** where this visitor's walker is; throttled to MOVE_HZ, the latest call wins */
  sendMove(x: number, z: number, ry: number, moving: boolean): void {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(ry)) return;
    this.pendingMove = { t: "move", x: r2(x), z: r2(z), ry: r3(ry), moving: moving === true };
    if (this.moveTimer !== null) return;
    const wait = this.lastMoveAt + MOVE_GAP_MS - Date.now();
    if (wait <= 0) this.flushMove();
    else
      this.moveTimer = setTimeout(() => {
        this.moveTimer = null;
        this.flushMove();
      }, wait);
  }

  /** false when not sent (offline, not an emote, or inside the one-a-second limit) */
  emote(e: EmoteId): boolean {
    if (!isEmote(e) || !this.socialReady()) return false;
    return this.send({ t: "emote", e });
  }

  say(p: PhraseId): boolean {
    if (!isPhrase(p) || !this.socialReady()) return false;
    return this.send({ t: "say", p });
  }

  /** lay a band on a live pool, by its label ("CARDS / USDC") or address, staking dollars from the stack (0: practice) */
  lay(pool: string, widthBins: number, offsetBins: number, stake = 0): boolean {
    if (typeof pool !== "string" || !pool.trim()) return false;
    if (!Number.isFinite(widthBins) || !Number.isFinite(offsetBins)) return false;
    const s = Number.isInteger(stake) && stake > 0 ? stake : 0;
    return this.send({ t: "lay", pool: pool.trim(), widthBins, offsetBins, ...(s ? { stake: s } : {}) });
  }

  /** pick up a loose note (the room checks you are near it); the answer is onPicked */
  pick(note: string): boolean {
    if (typeof note !== "string" || !note) return false;
    return this.send({ t: "pick", note });
  }

  /** collect Mr Bands' pay, standing at his desk; the answer is onPaid */
  pay(): boolean {
    return this.send({ t: "pay" });
  }

  /** settle the open round now (at the last tick the server has sent); the answer is onScored */
  closeRound(roundId: string): boolean {
    if (typeof roundId !== "string" || !roundId) return false;
    return this.send({ t: "close", roundId });
  }

  /** leave for good (no reconnect) */
  close(): void {
    this.wanted = false;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    this.you = null;
    this.name = null;
    if (ws) {
      try {
        ws.close(1000, "bye");
      } catch {
        /* already closed */
      }
    }
    this.setStatus(this.url ? "closed" : "offline");
  }

  // ---------------------------------------------------------------- the socket

  private open(): void {
    this.clearTimers();
    if (!this.url || !this.wanted) return;
    const old = this.ws;
    this.ws = null;
    if (old) {
      try {
        old.close(1000, "reconnect");
      } catch {
        /* gone */
      }
    }
    this.full = false;
    this.you = null;
    this.name = null;
    this.lastMove = null;
    this.pendingMove = null;
    this.lastMoveAt = -Infinity;
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      const key = readKey();
      if (this.ws === ws) this.send({ t: "hello", strap: this.strap, ...(key ? { key } : {}) }, true);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws === ws && typeof ev.data === "string") this.receive(ev.data);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.you = null;
      this.name = null;
      if (ev.code === CLOSE_ELSEWHERE || this.status === "elsewhere") {
        this.wanted = false;
        this.setStatus("elsewhere");
      } else if (this.full) {
        this.wanted = false;
        this.setStatus("full");
      } else if (this.wanted) this.retry();
      else this.setStatus("closed");
    };
  }

  private retry(): void {
    if (!this.wanted || this.retryTimer !== null) return;
    const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
    const delay = Math.round(cap / 2 + Math.random() * (cap / 2)); // half fixed, half jitter
    this.attempt = Math.min(this.attempt + 1, 16);
    this.setStatus("connecting");
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private receive(text: string): void {
    let msg: S2C;
    try {
      msg = JSON.parse(text) as S2C;
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null || typeof (msg as { t?: unknown }).t !== "string") return;
    switch (msg.t) {
      case "welcome":
        this.you = msg.you;
        this.name = msg.name;
        this.attempt = 0;
        if (typeof msg.key === "string") keepKey(msg.key);
        this.onWelcome(msg);
        this.setStatus("online");
        return;
      case "join":
        this.onJoin(msg.p);
        return;
      case "leave":
        this.onLeave(msg.id);
        return;
      case "moves": {
        if (!Array.isArray(msg.m)) return;
        const others: MoveEntry[] = [];
        for (const e of msg.m) {
          if (!Array.isArray(e)) continue;
          if (e[0] === this.you) this.onCorrect(e[1], e[2], e[3]);
          else others.push(e);
        }
        if (others.length) this.onMoves(others);
        return;
      }
      case "emote":
        if (isEmote(msg.e)) this.onEmote(msg.id, msg.e);
        return;
      case "say":
        if (isPhrase(msg.p)) this.onSay(msg.id, msg.p);
        return;
      case "laid":
        this.onLaid(msg);
        return;
      case "tick":
        this.onTick(msg);
        return;
      case "scored":
        this.onScored(msg);
        return;
      case "me":
        if (msg.me && typeof msg.me === "object") this.onMe(msg.me);
        return;
      case "stack":
        if (typeof msg.stack === "number") this.onStack(msg.id, msg.stack);
        return;
      case "notes":
        this.onNotes(Array.isArray(msg.add) ? msg.add : [], Array.isArray(msg.gone) ? msg.gone : []);
        return;
      case "picked":
        this.onPicked(msg.id, msg.note, msg.v);
        return;
      case "paid":
        this.onPaid(typeof msg.amount === "number" ? msg.amount : 0);
        return;
      case "stacks":
        if (Array.isArray(msg.rows)) this.onStacks(msg.rows);
        return;
      case "elsewhere":
        this.wanted = false;
        this.clearTimers();
        this.setStatus("elsewhere");
        return;
      case "board":
        if (Array.isArray(msg.rows)) this.onBoard(msg.rows);
        return;
      case "full":
        this.full = true;
        this.wanted = false;
        this.clearTimers();
        this.setStatus("full");
        try {
          this.ws?.close(1000, "full");
        } catch {
          /* closing already */
        }
        return;
      case "slow":
        this.onSlow();
        return;
      case "error":
        this.onError(typeof msg.why === "string" ? msg.why : "error");
        return;
    }
  }

  /** send when welcomed (or the hello itself); false when there is no open socket */
  private send(msg: C2S, beforeWelcome = false): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    if (!beforeWelcome && this.status !== "online") return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private flushMove(): void {
    const m = this.pendingMove;
    this.pendingMove = null;
    if (!m || this.status !== "online") return;
    const last = this.lastMove;
    if (last && last.x === m.x && last.z === m.z && last.ry === m.ry && last.moving === m.moving) return;
    if (this.send(m)) {
      this.lastMove = m;
      this.lastMoveAt = Date.now();
    }
  }

  private socialReady(): boolean {
    const now = Date.now();
    if (this.status !== "online" || now - this.lastSocialAt < SOCIAL_GAP_MS) return false;
    this.lastSocialAt = now;
    return true;
  }

  private clearTimers(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.moveTimer !== null) clearTimeout(this.moveTimer);
    this.retryTimer = null;
    this.moveTimer = null;
  }

  private setStatus(status: NetStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
  }
}
