/**
 * bands.finance Play: the Bands Exchange (24 Sep, Zach: "a game where users can walk around on the bands.finance
 * platform"). The engraved town (src/game/World.ts): the plaza with the live board and his notes as its signs, Mr
 * Bands at his desk, the Guard House, a stall game per top pool (src/game/LpRound.tsx), and the streets out to their
 * ends with a door on every named front (src/game/places.tsx, the map in src/game/TownMap.tsx). Online, you see the
 * other visitors (src/game/net.ts, the room server in game-server/): names the server gives, emotes and preset
 * phrases only, scores the server recomputes. With no server configured (VITE_GAME_WS_URL unset) it is the same
 * world, alone.
 *
 * The game (24 Sep, Zach: "a simple game of exploring the town, finding coins, and going to Mr Bands and converting
 * the coins to cash"): walk the town, pick up coins by walking over them, bring them back to Mr Bands' desk and cash
 * them in, and the stack grows in bands and cash. The HUD says three things: who you are, how many coins you carry,
 * and your stack. The four stalls stay as teaching games with nothing staked. Play money throughout.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExchangeWorld, type BoardRow, type Spot } from "./World";
import { LpRound } from "./LpRound";
import { poolParamsFromHot, type PoolParams } from "./lpGame";
import { COINS_PER_DAY, EMOTES, PHRASES, STOCK, STRAPS, type EmoteId, type Me, type PhraseId, type ScoreRow, type StackRow } from "./protocol";
import { ExchangeNet, gameWsUrl, type PlaceMsg } from "./net";
import { bandsAndCash, bandsWord, usd } from "./money";
import { isLayRefusal, newRoutes, offlineSource, onlineSource, type Frame } from "./rounds";
import { Interior, placeName, type BuildNote } from "./places";
import { MiniMap, TownMap, type MapCoin, type MapPose } from "./TownMap";
import { PLACES, STREET_NAMES } from "./town";
import "./PlayPage.css";

type Panel = { kind: "desk" } | { kind: "guards" } | { kind: "notes" } | { kind: "stall"; pool: PoolParams } | { kind: "board" } | { kind: "place"; id: string } | { kind: "map" } | null;
type NetStatus = "offline" | "connecting" | "online" | "full" | "closed" | "elsewhere";

/** the room's refusals, in words */
const ERROR_TEXT: Record<string, string> = {
  "not there": "Walk up to it first.",
  "notes done": "That's all the coins you can gather today.",
  "no stack": "Your stack won't cover it.",
  "have one": "You have one already.",
};
/** the tower's top, for the climb's view: above the clock, looking over the town, and for how long */
const TOWER_VIEW_HEIGHT = 34;
const TOWER_VIEW_MS = 6000;

interface HotRow {
  name?: string;
  venue?: string;
  feeToTvl1hPct?: number;
}
interface Limits {
  maxPositionSol?: number;
  maxTotalExposureSol?: number;
  stopLossPct?: number;
  maxBinWidth?: number;
  maxTxPerDay?: number;
  maxSlippagePct?: number;
}

const EMOTE_TEXT: Record<EmoteId, string> = { wave: "waves", "tip-hat": "tips a hat", cheer: "cheers", shrug: "shrugs" };
const EMOTE_LABEL: Record<EmoteId, string> = { wave: "Wave", "tip-hat": "Tip hat", cheer: "Cheer", shrug: "Shrug" };

/** a place's name inside a sentence: "the Hatter", "Cigars" */
const theName = (id: string) => placeName(id).replace(/^The /, "the ");
/** no doors found yet: one array, so the map's redraw timer is not reset by every render */
const NONE_FOUND: string[] = [];
/** "Twelve coins", "One coin", "34 coins": a count the way he would say it */
const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen", "Twenty"];
const coinsSaid = (n: number) => `${WORDS[n] ?? n} coin${n === 1 ? "" : "s"}`;

/** what he says at his desk, by what you carry and what you just cashed in */
function deskLine(me: Me | null, cashed: { coins: number; cash: number } | null): string {
  if (cashed && cashed.coins > 0) return `${usd(cashed.cash)}. Strapped into your stack. Off you go.`;
  const n = me?.coins ?? 0;
  if (n <= 0) return "Nothing in your pockets. The town is full of coins; go and look.";
  return `${coinsSaid(n)}. Let's see what they're worth.`;
}

const STRAP_KEY = "bands:play:strap";
const readStrap = (): number => {
  try {
    const v = Number(localStorage.getItem(STRAP_KEY));
    return Number.isInteger(v) && v >= 0 && v < STRAPS.length ? v : 0;
  } catch {
    return 0;
  }
};

export default function PlayPage() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const world = useRef<ExchangeWorld | null>(null);
  const net = useRef<ExchangeNet | null>(null);
  /** where the server's round messages go: the open panel's source registers here */
  const routes = useRef(newRoutes());
  const names = useRef(new Map<string, string>());
  /** the world was made once: it calls the page's current handler through this */
  const openRef = useRef<(s: Spot) => void>(() => undefined);
  /** the panel as the world's handlers see it (they are bound once) */
  const panelRef = useRef<Panel>(null);
  const meRef = useRef<Me | null>(null);
  /** the coin last asked for, for a "notes done" answer */
  const lastAsked = useRef<string | null>(null);
  /** a cash-in answered, waiting for the account that follows it, so the toast says the stack it made */
  const pendingCash = useRef<number | null>(null);
  const panelEl = useRef<HTMLDivElement>(null);

  const [entered, setEntered] = useState(false);
  const [strap, setStrap] = useState(readStrap);
  const [near, setNear] = useState<Spot | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [status, setStatus] = useState<NetStatus>(gameWsUrl() ? "connecting" : "offline");
  const [myName, setMyName] = useState("You");
  const [others, setOthers] = useState(0);
  const [leaders, setLeaders] = useState<ScoreRow[]>([]);
  const [pools, setPools] = useState<PoolParams[]>([]);
  const [notes, setNotes] = useState<BuildNote[]>([]);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [phrasesOpen, setPhrasesOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [me, setMeState] = useState<Me | null>(null);
  const [stacks, setStacks] = useState<StackRow[]>([]);
  const [boardTab, setBoardTab] = useState<"stacks" | "rounds">("stacks");
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef(0);
  /** the room's answer for the open interior (the tower's hour, a shop's stock, the talk) */
  const [placeInfo, setPlaceInfo] = useState<PlaceMsg | null>(null);
  /** the desk's last cash-in, for its reveal (cleared when the desk opens again) */
  const [cashed, setCashed] = useState<{ coins: number; cash: number } | null>(null);
  /** the street the Mint spilled on, while its three minutes run */
  const [spill, setSpill] = useState<{ street: number; until: number } | null>(null);
  /** where the walker is, for the map (the world writes it every frame; no render follows) */
  const pose = useRef<MapPose>({ x: 0, z: 20, ry: 0 });
  /** the coins on the ground, by the wire's id, for the mini-map (kept from the room's word, as the world's are) */
  const ground = useRef<Map<string, MapCoin>>(new Map());
  const [boardRows, setBoardRows] = useState<BoardRow[]>([]);
  const notify = useCallback((text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);
  const touch = useMemo(() => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches, []);
  panelRef.current = panel;
  meRef.current = me;

  // the world
  useEffect(() => {
    if (!canvas.current) return;
    const w = new ExchangeWorld(canvas.current, {
      onNear: (s) => setNear(s),
      onMove: (x, z, ry, moving) => {
        pose.current = { x, z, ry };
        net.current?.sendMove(x, z, ry, moving);
      },
      onInteract: (s) => openRef.current(s),
      onNote: (id) => {
        // today's coins gathered: the room would only say so, and its one error a moment is better kept for a lay
        const m = meRef.current;
        if (m && m.coinsToday >= COINS_PER_DAY) return;
        lastAsked.current = id;
        net.current?.pick(id);
      },
    });
    world.current = w;
    // #/play?debug: the world and the mini-map's coins on window, for tracing (nothing else changes)
    if (window.location.hash.includes("debug")) {
      const dbg = window as unknown as { __world: ExchangeWorld; __coins: Map<string, MapCoin> };
      dbg.__world = w;
      dbg.__coins = ground.current;
    }
    w.loadDesk()
      .catch(() => undefined)
      .finally(() => setLoading(false));
    return () => {
      w.dispose();
      world.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the live data: the board's pools for the stalls (read again every two minutes, as the room reads it, so a stall
  // never offers a pool the room has dropped), his notes, his rules
  useEffect(() => {
    let live = true;
    let seen = "";
    const readBoard = () =>
      fetch("/hot.json", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { rows?: unknown[] } | null) => {
          if (!live || !Array.isArray(j?.rows)) return;
          const rows = j!.rows as HotRow[];
          const params: PoolParams[] = [];
          const board: BoardRow[] = [];
          for (const r of rows) {
            const p = poolParamsFromHot(r);
            if (!p) continue;
            params.push(p);
            board.push({ label: p.label, feePct: p.feePctPerHour, venue: (r.venue ?? "").replace(/-.*$/, "") || "pool" });
            if (params.length >= 8) break;
          }
          const sig = JSON.stringify(board);
          if (sig === seen) return;
          seen = sig;
          setPools(params);
          setBoardRows(board);
          world.current?.setBoard(board);
        })
        .catch(() => undefined);
    readBoard();
    const boardTimer = window.setInterval(readBoard, 2 * 60_000);
    fetch("/build.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { notes?: BuildNote[] } | null) => {
        if (!live || !Array.isArray(j?.notes)) return;
        setNotes(j!.notes);
        world.current?.setNotes(j!.notes.map((n) => n.text));
      })
      .catch(() => undefined);
    fetch("/limits.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: Limits | null) => live && j && setLimits(j))
      .catch(() => undefined);
    return () => {
      live = false;
      window.clearInterval(boardTimer);
    };
  }, []);

  // the room: others, emotes, phrases, coins, rounds and the boards
  const connect = useCallback(
    (strapIx: number) => {
      const url = gameWsUrl();
      const n = new ExchangeNet(url);
      net.current = n;
      n.onStatus = (s) => setStatus(s);
      n.onWelcome = (m) => {
        // a spill under way when you arrive: the toast is past, but the ring and the signpost are not
        setSpill(m.spill ?? null);
        setMyName(m.name);
        world.current?.setMe(m.name, strapIx);
        // a welcome is the whole room again (a reconnect missed who left and what was picked meanwhile): start clean
        world.current?.resetRoom();
        names.current.clear();
        // start where the room put you (it spreads arrivals round the centre), so the first step is not a jump
        const mine = m.players.find((p) => p.id === m.you);
        if (mine) {
          world.current?.setMyPosition(mine.x, mine.z, mine.ry, true);
          // the maps show where the room put you before the first step (the world says a pose only as you walk)
          pose.current = { x: mine.x, z: mine.z, ry: mine.ry };
        }
        for (const p of m.players) {
          if (p.id === m.you) continue;
          names.current.set(p.id, p.name);
          world.current?.addRemote(p.id, p.name, p.strap, p.x, p.z, p.ry, p.stack, p.kit);
        }
        if (m.me?.kit) world.current?.setKit("me", m.me.kit);
        setOthers(m.players.filter((p) => p.id !== m.you).length);
        setLeaders(m.board);
        if (m.me) setMeState(m.me);
        if (Array.isArray(m.stacks)) setStacks(m.stacks);
        const notes = Array.isArray(m.notes) ? m.notes : [];
        world.current?.setLooseNotes(notes);
        ground.current.clear();
        for (const c of notes) ground.current.set(c.id, { x: c.x, z: c.z });
      };
      n.onJoin = (p) => {
        names.current.set(p.id, p.name);
        world.current?.addRemote(p.id, p.name, p.strap, p.x, p.z, p.ry, p.stack, p.kit);
        setOthers(names.current.size);
      };
      n.onMe = (m) => {
        setMeState(m);
        // the account after a cash-in: the toast says what went in and what the stack is now
        const cash = pendingCash.current;
        if (cash !== null) {
          pendingCash.current = null;
          notify(`+${usd(cash)} · ${bandsAndCash(m.stack)}`);
        }
      };
      n.onCashed = (coins, cash) => {
        setCashed({ coins, cash });
        if (coins > 0) pendingCash.current = cash;
      };
      n.onKit = (id, kit) => world.current?.setKit(id === n.you ? "me" : id, kit);
      n.onPlace = (m) => setPlaceInfo(m);
      n.onFound = (place) => notify(`You found ${theName(place)}.`);
      n.onBought = (item) => notify(`${(STOCK.find((s) => s.item === item)?.label ?? item).replace(/^./, (c) => c.toUpperCase())}, yours. It's on you now.`);
      n.onStack = (id, stack) => world.current?.setStack(id, stack);
      n.onStacks = (rows) => setStacks(rows);
      n.onNotes = (add, gone) => {
        for (const note of add) {
          world.current?.addLooseNote(note);
          ground.current.set(note.id, { x: note.x, z: note.z });
        }
        for (const id of gone) {
          world.current?.removeLooseNote(id);
          ground.current.delete(id);
        }
      };
      n.onPicked = (id, note, v) => {
        world.current?.removeLooseNote(note);
        ground.current.delete(note);
        world.current?.bubble(id === n.you ? "me" : id, `+${usd(v)}`);
      };
      n.onSpill = (street, until) => {
        if (street < 0 || street >= STREET_NAMES.length) return;
        setSpill({ street, until });
        notify(`The Mint spilled on the ${STREET_NAMES[street]} street. Three minutes.`);
      };
      n.onError = (why) => {
        if (isLayRefusal(why) && routes.current.refused) routes.current.refused(why);
        else if (ERROR_TEXT[why]) notify(ERROR_TEXT[why]);
        // the coin under your feet is not yours today: stop asking for it
        if (why === "notes done" && lastAsked.current) world.current?.muteNote(lastAsked.current);
      };
      n.onLeave = (id) => {
        names.current.delete(id);
        world.current?.removeRemote(id);
        setOthers(names.current.size);
      };
      n.onMoves = (moves) => {
        for (const [id, x, z, ry, moving] of moves) world.current?.moveRemote(id, x, z, ry, moving === 1);
      };
      n.onEmote = (id, e) => {
        world.current?.gesture(id, e);
        world.current?.bubble(id, `*${EMOTE_TEXT[e]}*`);
      };
      n.onSay = (id, p) => world.current?.bubble(id, p);
      n.onLaid = (m) => {
        const resolve = routes.current.laid.get(m.pool.address);
        routes.current.laid.delete(m.pool.address);
        // a round nobody is waiting for (its panel closed while the room answered) is closed at once
        if (!resolve) {
          n.closeRound(m.roundId);
          return;
        }
        resolve({ roundId: m.roundId, lower: m.lower, upper: m.upper, tickMs: m.tickMs, real: typeof m.real === "boolean" ? m.real : undefined });
      };
      n.onTick = (m) => {
        const f: Frame = { i: m.i, p: m.p, feesPct: m.feesPct, valuePct: m.valuePct, holdPct: m.holdPct, inRange: m.inRange };
        routes.current.frames.get(m.roundId)?.(f);
      };
      n.onScored = (m) => {
        routes.current.scores.get(m.roundId)?.({
          pct: m.pct,
          rank: m.rank ?? null,
          at: typeof m.at === "number" && Number.isFinite(m.at) ? m.at : undefined,
          from: typeof m.from === "number" && Number.isFinite(m.from) ? m.from : undefined,
        });
      };
      n.onCorrect = (x, z, ry) => world.current?.setMyPosition(x, z, ry);
      n.onBoard = (rows) => setLeaders(rows);
      n.connect(strapIx);
    },
    [notify],
  );

  useEffect(() => () => net.current?.close(), []);

  // a panel open: it takes the keys (focus, Escape) and the world stops reading them
  useEffect(() => {
    world.current?.setInputEnabled(!panel);
    if (panel) panelEl.current?.focus();
  }, [panel]);

  // M: the map, open or shut (over the plaza, or over the map itself; never over another panel)
  useEffect(() => {
    if (!entered) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "m" && e.key !== "M") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const p = panelRef.current;
      if (p && p.kind !== "map") return;
      e.preventDefault();
      setPanel(p ? null : { kind: "map" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entered]);

  // the Mint's spill: its signpost stands at the street's mouth until the spill's time is up
  useEffect(() => {
    world.current?.setSpill(spill ? spill.street : null);
    if (!spill) return;
    const timer = window.setTimeout(() => setSpill(null), Math.max(0, spill.until - Date.now()));
    return () => window.clearTimeout(timer);
  }, [spill]);

  function enter() {
    try {
      localStorage.setItem(STRAP_KEY, String(strap));
    } catch {
      /* private window */
    }
    world.current?.setMe("You", strap);
    setEntered(true);
    connect(strap);
    canvas.current?.focus();
  }

  openRef.current = openSpot;
  function openSpot(s: Spot) {
    if (panelRef.current) return;
    if (s.kind === "desk") {
      setCashed(null);
      setPanel({ kind: "desk" });
    } else if (s.kind === "guards") setPanel({ kind: "guards" });
    else if (s.kind === "notes") setPanel({ kind: "notes" });
    else if (s.kind === "place") {
      const id = s.place?.id ?? s.id;
      if (!PLACES.some((p) => p.id === id)) return;
      setPlaceInfo(null);
      setPanel({ kind: "place", id });
      net.current?.enter(id);
    } else if (s.kind === "stall") {
      // by the stall's place on the board, not the label on its sign: two rows can share a label
      const pool = s.stall !== undefined ? pools[s.stall] : undefined;
      if (pool) setPanel({ kind: "stall", pool });
    }
  }

  const closePanel = () => setPanel(null);

  const online = status === "online";

  /** a stall round: dealt, streamed and scored by the room when online (a Best rounds board round), local when not */
  const source = useMemo(() => (online && net.current ? onlineSource(net.current, routes.current) : offlineSource()), [online]);

  function emote(e: EmoteId) {
    world.current?.gesture("me", e);
    world.current?.bubble("me", `*${EMOTE_TEXT[e]}*`);
    net.current?.emote(e);
  }
  function say(p: PhraseId) {
    world.current?.bubble("me", p);
    net.current?.say(p);
    setPhrasesOpen(false);
  }
  /** the tower's climb: the camera goes up over the town for a moment, and the room says the hour the clock shows */
  function climb(id: string) {
    const tower = PLACES.find((p) => p.id === id);
    if (tower) world.current?.viewFrom(tower.x, TOWER_VIEW_HEIGHT, tower.z, TOWER_VIEW_MS);
    net.current?.climb();
  }

  /** the word after your name: who else is here, or why you are alone */
  const company = online ? `${others + 1} here` : status === "connecting" ? "connecting…" : status === "elsewhere" ? "open in another tab" : status === "full" ? "the plaza is full · alone" : "alone";
  const coins = me?.coins ?? 0;

  return (
    <main className="play" aria-label="The Bands Exchange">
      <canvas ref={canvas} className="play__canvas" tabIndex={0} aria-label="The town. Move with W A S D or the arrow keys, drag to look around, E to use." />

      {!entered && (
        <div className="play__gate">
          <div className="play-card play__intro">
            <p className="play-eyebrow">bands.finance · play</p>
            <h1 className="play__title">The Bands Exchange</h1>
            <p className="play__lede">Explore the town, find coins, and bring them to Mr Bands to turn into cash. Stack the bands. Play money only.</p>
            <div className="play__straps" role="radiogroup" aria-label="Your hat strap">
              <span>Your hat strap</span>
              {STRAPS.map((c, i) => (
                <button key={c} type="button" role="radio" aria-checked={strap === i} aria-label={`Strap colour ${i + 1}`} className={`play__strap${strap === i ? " is-on" : ""}`} style={{ background: c }} onClick={() => setStrap(i)} />
              ))}
            </div>
            <ul className="play__keys">
              {touch ? (
                <>
                  <li>Left thumb: walk</li>
                  <li>Right thumb: look around</li>
                  <li>Tap the button that appears to use a door or a stall</li>
                </>
              ) : (
                <>
                  <li>
                    <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> walk, <kbd>Shift</kbd> run
                  </li>
                  <li>
                    <kbd>E</kbd> use a door or a stall
                  </li>
                  <li>
                    <kbd>M</kbd> the map
                  </li>
                </>
              )}
            </ul>
            <button type="button" className="play-btn play-btn--ink" onClick={enter} disabled={loading}>
              {loading ? "Setting up the town…" : "Enter the town"}
            </button>
          </div>
        </div>
      )}

      {entered && (
        <>
          <div className="play__hud play__hud--tl">
            <span className="play__me">
              {myName}
              <small>{company}</small>
            </span>
            {online && me && (
              <>
                <span className="play__coins" role="status">
                  <Coin />
                  {coins} coin{coins === 1 ? "" : "s"}
                </span>
                <span className="play__stack" title={usd(me.stack)}>
                  {bandsAndCash(me.stack)}
                </span>
              </>
            )}
          </div>
          {toast && (
            <div className="play__toast" role="status">
              {toast}
            </div>
          )}
          <div className="play__hud play__hud--tr">
            <MiniMap pose={pose} coins={ground} found={me?.found ?? NONE_FOUND} spill={spill ? spill.street : null} onOpen={() => setPanel((p) => p ?? { kind: "map" })} />
            <button type="button" className="play-btn play-btn--sm" onClick={() => setPanel({ kind: "board" })}>
              Leaderboard
            </button>
          </div>

          {near && !panel && (
            <div className="play__prompt">
              {touch ? (
                <button type="button" className="play-btn play-btn--ink" onClick={() => world.current?.interact()}>
                  {near.prompt}
                </button>
              ) : (
                <span>
                  <kbd>E</kbd> {near.prompt}
                </span>
              )}
            </div>
          )}

          <div className="play__hud play__hud--bl">
            {EMOTES.map((e) => (
              <button key={e} type="button" className="play-btn play-btn--sm" onClick={() => emote(e)}>
                {EMOTE_LABEL[e]}
              </button>
            ))}
            <div className="play__phrases">
              <button type="button" className="play-btn play-btn--sm" aria-expanded={phrasesOpen} onClick={() => setPhrasesOpen((o) => !o)}>
                Say…
              </button>
              {phrasesOpen && (
                <ul className="play-card play__phrase-list">
                  {PHRASES.map((p) => (
                    <li key={p}>
                      <button type="button" onClick={() => say(p)}>
                        {p}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {touch && <Joystick onMove={(x, y) => world.current?.setJoystick(x, y)} />}
        </>
      )}

      {panel && (
        <div className="play__panel-wrap" role="dialog" aria-modal="true" onClick={(e) => e.target === e.currentTarget && closePanel()} onKeyDown={(e) => e.key === "Escape" && closePanel()}>
          <div ref={panelEl} className="play-card play__panel" tabIndex={-1}>
            <button type="button" className="play__x" aria-label="Close" onClick={closePanel}>
              ×
            </button>
            {panel.kind === "desk" && (
              <div className="play__desk">
                <img src="/art/brand/portrait-cigar.webp" alt="Mr Bands" width={96} height={96} />
                <div>
                  <p className="play-eyebrow">Mr Bands, at his desk</p>
                  <p className="play__line">{deskLine(online ? me : null, cashed)}</p>
                  {cashed && cashed.coins > 0 && me && (
                    <p className="play__reveal" role="status">
                      +{usd(cashed.cash)} · {bandsAndCash(me.stack)}
                    </p>
                  )}
                  <div className="lp__row">
                    {!(cashed && cashed.coins > 0) && (
                      <button type="button" className="play-btn play-btn--ink" disabled={!online || coins <= 0} onClick={() => net.current?.cashin()}>
                        Cash in {coins} coin{coins === 1 ? "" : "s"}
                      </button>
                    )}
                    <button type="button" className="play-btn" onClick={closePanel}>
                      Walk on
                    </button>
                  </div>
                </div>
              </div>
            )}
            {panel.kind === "guards" && (
              <div>
                <p className="play-eyebrow">The Guard House</p>
                <h2 className="lp__title">The rules he can't break.</h2>
                <p className="lp__sub">His model proposes. These decide, in code, every time.</p>
                <ul className="play__rules">
                  {limits?.maxPositionSol != null && <li><b>{limits.maxPositionSol} SOL</b> the most in one band</li>}
                  {limits?.maxTotalExposureSol != null && <li><b>{limits.maxTotalExposureSol} SOL</b> the most out at once</li>}
                  {limits?.stopLossPct != null && <li><b>−{limits.stopLossPct}%</b> and a band is closed, no vote</li>}
                  {limits?.maxBinWidth != null && <li><b>{limits.maxBinWidth} bins</b> the widest band he may lay</li>}
                  {limits?.maxSlippagePct != null && <li><b>{limits.maxSlippagePct}%</b> worse fill than this is refused</li>}
                  {limits?.maxTxPerDay != null && <li><b>{limits.maxTxPerDay}</b> actions a day at most</li>}
                  <li><b>A file named STOP</b> halts every new band the moment it exists</li>
                </ul>
              </div>
            )}
            {panel.kind === "notes" && (
              <div>
                <p className="play-eyebrow">The Notice Board</p>
                <h2 className="lp__title">What he built lately.</h2>
                <ul className="play__notes">
                  {notes.slice(0, 5).map((n) => (
                    <li key={n.id}>
                      <p>{n.text}</p>
                      <a href={`https://x.com/i/status/${n.id}`} target="_blank" rel="noreferrer">
                        on X ↗
                      </a>
                    </li>
                  ))}
                  {!notes.length && <li>Nothing pinned yet.</li>}
                </ul>
              </div>
            )}
            {panel.kind === "board" && (
              <div>
                <p className="play-eyebrow">The leaderboard</p>
                <div className="play__tabs" role="tablist">
                  <button type="button" role="tab" aria-selected={boardTab === "stacks"} className={boardTab === "stacks" ? "is-on" : ""} onClick={() => setBoardTab("stacks")}>
                    Biggest stacks
                  </button>
                  <button type="button" role="tab" aria-selected={boardTab === "rounds"} className={boardTab === "rounds" ? "is-on" : ""} onClick={() => setBoardTab("rounds")}>
                    Best rounds
                  </button>
                </div>
                {boardTab === "stacks" ? (
                  <>
                    <h2 className="lp__title">Who's stacked the most.</h2>
                    {online ? (
                      <ol className="play__leaders">
                        {stacks.map((r, i) => (
                          <li key={`${r.name}-${i}`} className={r.name === myName ? "is-me" : ""}>
                            <span className="play__rank">{i + 1}</span>
                            <span className="play__who">{r.name}</span>
                            <span className="play__pool">{bandsWord(r.stack) ?? ""}</span>
                            <b>{usd(r.stack)}</b>
                          </li>
                        ))}
                        {!stacks.length && <li className="play__empty">Nobody has stacked yet.</li>}
                      </ol>
                    ) : (
                      <p className="lp__sub">Stacks are kept when the Exchange is online.</p>
                    )}
                  </>
                ) : (
                  <h2 className="lp__title">Best bands against holding.</h2>
                )}
                {boardTab === "rounds" && online ? (
                  <ol className="play__leaders">
                    {leaders.map((r, i) => (
                      <li key={`${r.name}-${i}`}>
                        <span className="play__rank">{i + 1}</span>
                        <span className="play__who">{r.name}</span>
                        <span className="play__pool">{r.pool}</span>
                        <b className={r.pct >= 0 ? "lp__good" : "lp__bad"}>
                          {r.pct >= 0 ? "+" : "−"}
                          {Math.abs(r.pct).toFixed(2)}%
                        </b>
                      </li>
                    ))}
                    {!leaders.length && <li className="play__empty">No scores yet. Be the first at a stall.</li>}
                  </ol>
                ) : boardTab === "rounds" ? (
                  <p className="lp__sub">Scores go on the board when the Exchange is online.</p>
                ) : null}
              </div>
            )}
            {panel.kind === "stall" && <LpRound key={panel.pool.address} pool={panel.pool} source={source} ranked={online} onClose={closePanel} />}
            {panel.kind === "map" && <TownMap pose={pose} found={me?.found ?? NONE_FOUND} spill={spill ? spill.street : null} />}
            {panel.kind === "place" && (
              <Interior
                key={panel.id}
                place={PLACES.find((p) => p.id === panel.id)!}
                info={placeInfo?.id === panel.id ? placeInfo : null}
                online={online}
                me={online ? me : null}
                myName={myName}
                stacks={stacks}
                board={boardRows}
                notes={notes}
                onBuy={(item) => net.current?.buy(item)}
                onClimb={() => climb(panel.id)}
                onClose={closePanel}
              />
            )}
          </div>
        </div>
      )}
    </main>
  );
}

/** a coin, in ink: two rings and the stamped B, the way the ones on the ground are cut */
function Coin() {
  return (
    <svg className="play__coin" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10" cy="10" r="6.2" fill="none" stroke="currentColor" strokeWidth="0.7" />
      <text x="10" y="13.4" textAnchor="middle" fontSize="9.5" fontWeight="700" fill="currentColor">
        B
      </text>
    </svg>
  );
}

/** a thumb stick for phones: drag inside the ring, the knob follows, the world walks */
function Joystick({ onMove }: { onMove(x: number, y: number): void }) {
  const ring = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const active = useRef<number | null>(null);
  const R = 48;
  const move = (e: React.PointerEvent) => {
    if (active.current !== e.pointerId || !ring.current) return;
    const b = ring.current.getBoundingClientRect();
    let x = e.clientX - (b.left + b.width / 2);
    let y = e.clientY - (b.top + b.height / 2);
    const d = Math.hypot(x, y);
    if (d > R) {
      x = (x / d) * R;
      y = (y / d) * R;
    }
    setKnob({ x, y });
    onMove(x / R, y / R);
  };
  const end = (e: React.PointerEvent) => {
    if (active.current !== e.pointerId) return;
    active.current = null;
    setKnob({ x: 0, y: 0 });
    onMove(0, 0);
  };
  return (
    <div
      ref={ring}
      className="play__stick"
      onPointerDown={(e) => {
        active.current = e.pointerId;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        move(e);
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <div className="play__knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
    </div>
  );
}
