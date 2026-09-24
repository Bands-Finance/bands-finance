/**
 * bands.finance Play: the Bands Exchange (24 Sep, Zach: "a game where users can walk around on the bands.finance
 * platform"). The engraved plaza (src/game/World.ts), the live board and his notes as its signs, Mr Bands at his desk
 * with a few lines, the Guard House, and a stall game per top pool (src/game/LpRound.tsx). Online, you see the other
 * visitors (src/game/net.ts, the room server in game-server/): names the server gives, emotes and preset phrases only,
 * scores the server recomputes. With no server configured (VITE_GAME_WS_URL unset) it is the same world, alone.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExchangeWorld, type BoardRow, type Spot } from "./World";
import { LpRound } from "./LpRound";
import { poolParamsFromHot, type PoolParams } from "./lpGame";
import { EMOTES, PHRASES, STRAPS, type EmoteId, type PhraseId, type ScoreRow } from "./protocol";
import { ExchangeNet, gameWsUrl } from "./net";
import { newRoutes, offlineSource, onlineSource } from "./rounds";
import "./PlayPage.css";

type Panel = { kind: "desk" } | { kind: "guards" } | { kind: "notes" } | { kind: "stall"; pool: PoolParams } | { kind: "board" } | null;
type NetStatus = "offline" | "connecting" | "online" | "full" | "closed";

interface HotRow {
  name?: string;
  venue?: string;
  feeToTvl1hPct?: number;
}
interface BuildNote {
  id: string;
  at: string;
  text: string;
}
interface Limits {
  maxPositionSol?: number;
  maxTotalExposureSol?: number;
  stopLossPct?: number;
  maxBinWidth?: number;
  maxTxPerDay?: number;
  maxSlippagePct?: number;
}

/** what he says at his desk: his voice, no price calls, no token, play money named as such */
const DESK_LINES = [
  "Welcome to the Exchange. I'm Mr Bands, an AI agent. I make markets on Meteora, and I'm building this place.",
  "A band is liquidity laid across a few price bins. While price trades inside it, every swap pays me a fee.",
  "When price leaves and stays away, the band earns nothing. I close it and lay it again where the price is.",
  "The stalls by the board are the pools paying the most fees this hour. Lay a band on one and see how it goes.",
  "Everything here is play money. My own book is paper for now, and every trade I make is on the record.",
];

const EMOTE_TEXT: Record<EmoteId, string> = { wave: "waves", "tip-hat": "tips a hat", cheer: "cheers", shrug: "shrugs" };
const EMOTE_LABEL: Record<EmoteId, string> = { wave: "Wave", "tip-hat": "Tip hat", cheer: "Cheer", shrug: "Shrug" };

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
  const [line, setLine] = useState(0);
  const [phrasesOpen, setPhrasesOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const touch = useMemo(() => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches, []);

  // the world
  useEffect(() => {
    if (!canvas.current) return;
    const w = new ExchangeWorld(canvas.current, {
      onNear: (s) => setNear(s),
      onMove: (x, z, ry, moving) => net.current?.sendMove(x, z, ry, moving),
      onInteract: (s) => openRef.current(s),
    });
    world.current = w;
    // #/play?debug: the world on window, for tracing (nothing else changes)
    if (window.location.hash.includes("debug")) (window as unknown as { __world: ExchangeWorld }).__world = w;
    w.loadDesk()
      .catch(() => undefined)
      .finally(() => setLoading(false));
    return () => {
      w.dispose();
      world.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the live data: the board's pools for the stalls, his notes, his rules
  useEffect(() => {
    let live = true;
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
        setPools(params);
        world.current?.setBoard(board);
      })
      .catch(() => undefined);
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
    };
  }, []);

  // the room: others, emotes, phrases, rounds and the leaderboard
  const connect = useCallback(
    (strapIx: number) => {
      const url = gameWsUrl();
      const n = new ExchangeNet(url);
      net.current = n;
      n.onStatus = (s) => setStatus(s);
      n.onWelcome = (m) => {
        setMyName(m.name);
        world.current?.setMe(m.name, strapIx);
        // start where the room put you (it spreads arrivals round the centre), so the first step is not a jump
        const mine = m.players.find((p) => p.id === m.you);
        if (mine) world.current?.setMyPosition(mine.x, mine.z, mine.ry, true);
        for (const p of m.players) {
          if (p.id === m.you) continue;
          names.current.set(p.id, p.name);
          world.current?.addRemote(p.id, p.name, p.strap, p.x, p.z, p.ry);
        }
        setOthers(m.players.filter((p) => p.id !== m.you).length);
        setLeaders(m.board);
      };
      n.onJoin = (p) => {
        names.current.set(p.id, p.name);
        world.current?.addRemote(p.id, p.name, p.strap, p.x, p.z, p.ry);
        setOthers(names.current.size);
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
        const resolve = routes.current.laid.get(m.pool.label) ?? routes.current.laid.get(m.pool.address);
        routes.current.laid.delete(m.pool.label);
        routes.current.laid.delete(m.pool.address);
        resolve?.({ roundId: m.roundId, lower: m.lower, upper: m.upper, tickMs: m.tickMs, real: typeof m.real === "boolean" ? m.real : undefined });
      };
      n.onTick = (m) => routes.current.frames.get(m.roundId)?.({ i: m.i, p: m.p, feesPct: m.feesPct, valuePct: m.valuePct, holdPct: m.holdPct, inRange: m.inRange });
      n.onScored = (roundId, pct, rank, from) => routes.current.scores.get(roundId)?.({ pct, rank, from });
      n.onCorrect = (x, z, ry) => world.current?.setMyPosition(x, z, ry);
      n.onBoard = (rows) => setLeaders(rows);
      n.connect(strapIx);
    },
    [],
  );

  useEffect(() => () => net.current?.close(), []);

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
    if (s.kind === "desk") {
      setLine(0);
      setPanel({ kind: "desk" });
    } else if (s.kind === "guards") setPanel({ kind: "guards" });
    else if (s.kind === "notes") setPanel({ kind: "notes" });
    else if (s.kind === "stall") {
      const pool = pools.find((p) => p.label === s.pool);
      if (pool) setPanel({ kind: "stall", pool });
    }
  }

  const online = status === "online";

  /** a stall round: dealt, streamed and scored by the room when online (a leaderboard round), local when not */
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

  return (
    <main className="play" aria-label="The Bands Exchange">
      <canvas ref={canvas} className="play__canvas" tabIndex={0} aria-label="The plaza. Move with W A S D or the arrow keys, drag to look around, E to use." />

      {!entered && (
        <div className="play__gate">
          <div className="play-card play__intro">
            <p className="play-eyebrow">bands.finance · play</p>
            <h1 className="play__title">The Bands Exchange</h1>
            <p className="play__lede">Walk the plaza, meet Mr Bands at his desk, and lay a band at a stall on one of the pools paying the most fees this hour. Play money only.</p>
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
                  <li>Tap the button that appears to use a stall, the desk or a sign</li>
                </>
              ) : (
                <>
                  <li>
                    <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> walk, <kbd>Shift</kbd> run
                  </li>
                  <li>Drag to look around, scroll to zoom</li>
                  <li>
                    <kbd>E</kbd> use a stall, the desk or a sign
                  </li>
                </>
              )}
            </ul>
            <button type="button" className="play-btn play-btn--ink" onClick={enter} disabled={loading}>
              {loading ? "Setting up the plaza…" : "Enter the Exchange"}
            </button>
          </div>
        </div>
      )}

      {entered && (
        <>
          <div className="play__hud play__hud--tl">
            <span className="play__where">The Bands Exchange</span>
            <span className={`play__net play__net--${status}`}>
              {status === "online" ? `Online · ${others + 1} here` : status === "connecting" ? "Connecting…" : status === "full" ? "The plaza is full · alone for now" : "Single player"}
            </span>
            <span className="play__me">{myName}</span>
          </div>
          <div className="play__hud play__hud--tr">
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
        <div className="play__panel-wrap" role="dialog" aria-modal="true" onClick={(e) => e.target === e.currentTarget && setPanel(null)}>
          <div className="play-card play__panel">
            <button type="button" className="play__x" aria-label="Close" onClick={() => setPanel(null)}>
              ×
            </button>
            {panel.kind === "desk" && (
              <div className="play__desk">
                <img src="/art/brand/portrait-cigar.webp" alt="Mr Bands" width={96} height={96} />
                <div>
                  <p className="play-eyebrow">Mr Bands, at his desk</p>
                  <p className="play__line">{DESK_LINES[line]}</p>
                  <div className="lp__row">
                    {line < DESK_LINES.length - 1 ? (
                      <button type="button" className="play-btn play-btn--ink" onClick={() => setLine((l) => l + 1)}>
                        Go on
                      </button>
                    ) : (
                      <a className="play-btn play-btn--ink" href="https://mrbands.finance" target="_blank" rel="noreferrer">
                        See him trade ↗
                      </a>
                    )}
                    <button type="button" className="play-btn" onClick={() => setPanel(null)}>
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
                <h2 className="lp__title">Best bands against holding.</h2>
                {online ? (
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
                ) : (
                  <p className="lp__sub">Scores go on the board when the Exchange is online. Your rounds still count for you.</p>
                )}
              </div>
            )}
            {panel.kind === "stall" && <LpRound pool={panel.pool} source={source} ranked={online} onClose={() => setPanel(null)} />}
          </div>
        </div>
      )}
    </main>
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
