/**
 * bands.finance Play: the Bands Exchange (24 Sep, Zach: "a game where users can walk around on the bands.finance
 * platform"). The engraved plaza (src/game/World.ts), the live board and his notes as its signs, Mr Bands at his desk
 * with a few lines, the Guard House, and a stall game per top pool (src/game/LpRound.tsx). Online, you see the other
 * visitors (src/game/net.ts, the room server in game-server/): names the server gives, emotes and preset phrases only,
 * scores the server recomputes. With no server configured (VITE_GAME_WS_URL unset) it is the same world, alone.
 *
 * The stack (24 Sep, Zach: "the goal is for each player to stack bands"): online, the room keeps your account. Stake
 * part of it at the stalls, pick up loose notes, collect Mr Bands' wage and jobs at his desk, and climb the biggest
 * stacks. Offline every round is practice.
 *
 * A round rides on the server whether or not its stall panel is open (a staked one settles at its hold whatever
 * happens), so the page keeps the riding round itself (`live`): its frames go on arriving after the panel closes, a
 * chip on the HUD says where it is, the stall opened again takes it up, another stall lays nothing meanwhile, and a
 * round scored with no panel open is told in a toast. A practice round is closed when you walk away from its stall.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExchangeWorld, type BoardRow, type Spot } from "./World";
import { LpRound } from "./LpRound";
import { poolParamsFromHot, TICKS, type PoolParams } from "./lpGame";
import { EMOTES, JOBS, NOTES_PER_DAY, PHRASES, STRAPS, WAGE, type EmoteId, type JobId, type Me, type PhraseId, type ScoreRow, type StackRow } from "./protocol";
import { ExchangeNet, gameWsUrl } from "./net";
import { bandsWord, usd } from "./money";
import { isLayRefusal, newRoutes, offlineSource, onlineSource, type Frame, type LiveRound } from "./rounds";
import "./PlayPage.css";

type Panel = { kind: "desk" } | { kind: "guards" } | { kind: "notes" } | { kind: "stall"; pool: PoolParams } | { kind: "board" } | null;
type NetStatus = "offline" | "connecting" | "online" | "full" | "closed" | "elsewhere";

/** Mr Bands' daily jobs, in his words */
const JOB_TEXT: Record<JobId, string> = {
  range: "Keep price inside your band for 24 hours of one round",
  beat: "Close a band ahead of just holding",
  notes: "Pick up 5 loose notes around the plaza",
  wave: "Wave at someone standing near you",
};
/** the room's other refusals, in words */
const ERROR_TEXT: Record<string, string> = {
  "not at the desk": "Walk up to Mr Bands' desk to collect.",
  "notes done": "That's all the notes you can pick up today.",
};

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

/** a riding round whose ticks stop for this long is let go (the server settles or refunds it within a minute) */
const ROUND_QUIET_MS = 60_000;
/** today, the way the server names a day ("2026-09-24") */
const utcDay = () => new Date().toISOString().slice(0, 10);
const sign = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;

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
  /** the round riding on the server: the ref for the net's handlers, the state for what is drawn */
  const liveRef = useRef<LiveRound | null>(null);
  const [live, setLiveState] = useState<LiveRound | null>(null);
  const quietTimer = useRef(0);
  /** the panel as the world's handlers see it (they are bound once) */
  const panelRef = useRef<Panel>(null);
  const meRef = useRef<Me | null>(null);
  /** the loose note last asked for, for a "notes done" answer */
  const lastAsked = useRef<string | null>(null);
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
  const [line, setLine] = useState(0);
  const [phrasesOpen, setPhrasesOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [me, setMeState] = useState<Me | null>(null);
  const [stacks, setStacks] = useState<StackRow[]>([]);
  const [boardTab, setBoardTab] = useState<"stacks" | "rounds">("stacks");
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef(0);
  const notify = useCallback((text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);
  const touch = useMemo(() => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches, []);
  panelRef.current = panel;
  meRef.current = me;

  const setLive = useCallback((l: LiveRound | null) => {
    liveRef.current = l;
    setLiveState(l);
    window.clearTimeout(quietTimer.current);
    if (l) quietTimer.current = window.setTimeout(() => setLive(null), ROUND_QUIET_MS);
  }, []);

  // the world
  useEffect(() => {
    if (!canvas.current) return;
    const w = new ExchangeWorld(canvas.current, {
      onNear: (s) => setNear(s),
      onMove: (x, z, ry, moving) => net.current?.sendMove(x, z, ry, moving),
      onInteract: (s) => openRef.current(s),
      onNote: (id) => {
        // today's notes picked: the room would only say so, and its one error a moment is better kept for a lay
        const m = meRef.current;
        if (m && m.notes >= NOTES_PER_DAY) return;
        lastAsked.current = id;
        net.current?.pick(id);
      },
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
        // a welcome is the whole room again (a reconnect missed who left and what was picked meanwhile): start clean
        world.current?.resetRoom();
        names.current.clear();
        // and any round of the old session was settled when it went; nothing rides for this one yet
        setLive(null);
        // start where the room put you (it spreads arrivals round the centre), so the first step is not a jump
        const mine = m.players.find((p) => p.id === m.you);
        if (mine) world.current?.setMyPosition(mine.x, mine.z, mine.ry, true);
        for (const p of m.players) {
          if (p.id === m.you) continue;
          names.current.set(p.id, p.name);
          world.current?.addRemote(p.id, p.name, p.strap, p.x, p.z, p.ry, p.stack);
        }
        setOthers(m.players.filter((p) => p.id !== m.you).length);
        setLeaders(m.board);
        if (m.me) setMeState(m.me);
        if (Array.isArray(m.stacks)) setStacks(m.stacks);
        world.current?.setLooseNotes(Array.isArray(m.notes) ? m.notes : []);
      };
      n.onJoin = (p) => {
        names.current.set(p.id, p.name);
        world.current?.addRemote(p.id, p.name, p.strap, p.x, p.z, p.ry, p.stack);
        setOthers(names.current.size);
      };
      n.onMe = (m) => setMeState(m);
      n.onStack = (id, stack) => world.current?.setStack(id, stack);
      n.onStacks = (rows) => setStacks(rows);
      n.onNotes = (add, gone) => {
        for (const note of add) world.current?.addLooseNote(note);
        for (const id of gone) world.current?.removeLooseNote(id);
      };
      n.onPicked = (id, note, v) => {
        world.current?.removeLooseNote(note);
        world.current?.bubble(id === n.you ? "me" : id, `+${usd(v)}`);
      };
      n.onPaid = (amount) => notify(amount > 0 ? `Mr Bands paid you ${usd(amount)}.` : "Nothing to collect yet. Finish a job and come back.");
      n.onError = (why) => {
        if (isLayRefusal(why) && routes.current.refused) routes.current.refused(why);
        else if (ERROR_TEXT[why]) notify(ERROR_TEXT[why]);
        // the note under your feet is not yours today: stop asking for it
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
        const stake = typeof m.stake === "number" && m.stake > 0 ? m.stake : 0;
        const laid = {
          roundId: m.roundId,
          lower: m.lower,
          upper: m.upper,
          tickMs: m.tickMs,
          real: typeof m.real === "boolean" ? m.real : undefined,
          stake,
          rake: stake && typeof m.rake === "number" ? m.rake : 0,
          hold: stake && typeof m.hold === "number" ? m.hold : TICKS,
        };
        const resolve = routes.current.laid.get(m.pool.address);
        routes.current.laid.delete(m.pool.address);
        // a practice round nobody is waiting for (its panel closed while the room answered) is closed at once; a
        // staked one rides on the server, so the page keeps it whether or not a panel is waiting
        if (!resolve && !stake) {
          n.closeRound(m.roundId);
          return;
        }
        setLive({ roundId: m.roundId, label: m.pool.label, address: m.pool.address, laid, frames: [] });
        resolve?.(laid);
      };
      n.onTick = (m) => {
        const f: Frame = { i: m.i, p: m.p, feesPct: m.feesPct, valuePct: m.valuePct, holdPct: m.holdPct, inRange: m.inRange };
        const l = liveRef.current;
        if (l && l.roundId === m.roundId) setLive({ ...l, frames: [...l.frames, f] });
        routes.current.frames.get(m.roundId)?.(f);
      };
      n.onScored = (m) => {
        const shown = routes.current.scores.get(m.roundId);
        shown?.({
          pct: m.pct,
          rank: m.rank ?? null,
          at: typeof m.at === "number" && Number.isFinite(m.at) ? m.at : undefined,
          from: typeof m.from === "number" && Number.isFinite(m.from) ? m.from : undefined,
          stake: m.stake,
          back: m.back,
        });
        const l = liveRef.current;
        if (l && l.roundId === m.roundId) {
          // nobody watching (the panel was closed): a stake's result is told here; a practice round was walked away from
          if (!shown && l.laid.stake > 0) {
            const back = typeof m.back === "number" ? m.back : 0;
            const made = back - l.laid.stake - l.laid.rake;
            notify(`Your band on ${l.label} came back ${usd(back)} (${made >= 0 ? "+" : "−"}${usd(Math.abs(made))}, ${sign(m.pct)} against holding).`);
          }
          setLive(null);
        }
      };
      n.onCorrect = (x, z, ry) => world.current?.setMyPosition(x, z, ry);
      n.onBoard = (rows) => setLeaders(rows);
      n.connect(strapIx);
    },
    [notify, setLive],
  );

  useEffect(
    () => () => {
      net.current?.close();
      window.clearTimeout(quietTimer.current);
    },
    [],
  );

  // a panel open: it takes the keys (focus, Escape) and the world stops reading them
  useEffect(() => {
    world.current?.setInputEnabled(!panel);
    if (panel) panelEl.current?.focus();
  }, [panel]);

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
      setLine(0);
      setPanel({ kind: "desk" });
    } else if (s.kind === "guards") setPanel({ kind: "guards" });
    else if (s.kind === "notes") setPanel({ kind: "notes" });
    else if (s.kind === "stall") {
      // by the stall's place on the board, not the label on its sign: two rows can share a label
      const pool = s.stall !== undefined ? pools[s.stall] : undefined;
      if (pool) setPanel({ kind: "stall", pool });
    }
  }

  /** the panel closes; a practice band at its stall does not ride on its own, so walking away closes it */
  function closePanel() {
    const p = panelRef.current;
    const l = liveRef.current;
    if (p?.kind === "stall" && l && l.address === p.pool.address && l.laid.stake === 0) net.current?.closeRound(l.roundId);
    setPanel(null);
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
            <p className="play__lede">
              Stack bands. Lay them at the stalls on the pools paying the most fees this hour, pick up loose notes, and collect your pay from Mr Bands at his desk. {gameWsUrl() && "Your stack is kept for this browser while its site data lasts. "}Play money only.
            </p>
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
              {status === "online"
                ? `Online · ${others + 1} here`
                : status === "connecting"
                  ? "Connecting…"
                  : status === "full"
                    ? "The plaza is full · single player. Reload to try again."
                    : status === "elsewhere"
                      ? "Open in another tab · playing there"
                      : "Single player"}
            </span>
            <span className="play__me">{myName}</span>
            {online && me && (
              <span className="play__stack" title={usd(me.stack)}>
                <b>{usd(me.stack)}</b>
                {bandsWord(me.stack) && <small>{bandsWord(me.stack)}</small>}
              </span>
            )}
            {online && live && (
              <span className="play__ride" role="status">
                Band on {live.label} · hour {live.frames[live.frames.length - 1]?.i ?? 0} of {live.laid.hold}
              </span>
            )}
          </div>
          {toast && (
            <div className="play__toast" role="status">
              {toast}
            </div>
          )}
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
                  <p className="play__line">{DESK_LINES[line]}</p>
                  {online && me && <Pay me={me} onCollect={() => net.current?.pay()} />}
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
                  <p className="lp__sub">Scores go on the board when the Exchange is online. Offline, every round is practice.</p>
                ) : null}
              </div>
            )}
            {panel.kind === "stall" && <LpRound key={panel.pool.address} pool={panel.pool} source={source} ranked={online} me={online ? me : null} live={online ? live : null} onClose={closePanel} />}
          </div>
        </div>
      )}
    </main>
  );
}

/** today's pay at the desk: the wage, each job and how far along it is, and what can be collected now */
function Pay({ me: known, onCollect }: { me: Me; onCollect(): void }) {
  // the account is as the server last said; past midnight UTC the day is fresh (the wage due, the jobs at nought)
  // and the server would say so on collecting, so the desk says so first
  const me: Me = known.day === utcDay() ? known : { ...known, wagePaid: false, jobs: known.jobs.map((j) => ({ ...j, have: 0, paid: false })) };
  const due =
    (me.wagePaid ? 0 : WAGE) +
    JOBS.reduce((t, j) => {
      const s = me.jobs.find((x) => x.id === j.id);
      return t + (s && !s.paid && s.have >= j.need ? j.reward : 0);
    }, 0);
  return (
    <div className="play__pay">
      <p className="play-eyebrow">Today's pay</p>
      <ul>
        <li className={me.wagePaid ? "is-paid" : "is-done"}>
          <span>Your daily wage</span>
          <b>{me.wagePaid ? "paid" : usd(WAGE)}</b>
        </li>
        {JOBS.map((j) => {
          const s = me.jobs.find((x) => x.id === j.id);
          const done = (s?.have ?? 0) >= j.need;
          return (
            <li key={j.id} className={s?.paid ? "is-paid" : done ? "is-done" : ""}>
              <span>
                {JOB_TEXT[j.id]}
                {!done && j.need > 1 ? (
                  <small>
                    {" "}
                    {s?.have ?? 0} of {j.need}
                  </small>
                ) : null}
              </span>
              <b>{s?.paid ? "paid" : usd(j.reward)}</b>
            </li>
          );
        })}
      </ul>
      <button type="button" className="play-btn play-btn--ink" disabled={!due} onClick={onCollect}>
        {due ? `Collect ${usd(due)}` : "Nothing to collect yet"}
      </button>
    </div>
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
