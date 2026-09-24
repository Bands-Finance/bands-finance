/**
 * The stall's game (bands.finance Play): lay a band on a live pool, staking part of your stack (or nothing, to
 * practise), watch the hours of price go through it, and score against just holding. A staked band is committed at
 * the lay: its width, centre, stake and hold (12, 24 or 48 hours) are fixed, the stall keeps RAKE_PCT of the stake,
 * and the band rides its full hours whatever the price does ("Skip to the end" only hurries the clock); what comes
 * back is the stake plus what the band made against just holding (its fees less its loss to holding, the measure the
 * board scores; a raw worth would be a bet on a rise the board's pools already had). A practice band may be closed at
 * any hour and records nothing. The hours are a hidden stretch of the pool's real history where it has one, named
 * when the round is scored. They come from a RoundSource (src/game/rounds.ts): the room server's stream online, the
 * local simulation offline; this panel only draws them. A round rides on the server whether or not this panel is
 * open: the page keeps it (`live`), and a panel opened on its pool takes it up where it is.
 * It teaches the trade-off his desk lives on: narrow bands take more of the fees and leave the price sooner.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { TICKS, WIDTH_MAX, WIDTH_MIN, type PoolParams } from "./lpGame";
import { usd } from "./money";
import { HOLDS, MAX_STAKE, MIN_STAKE, RAKE_PCT, ROUNDS_PER_DAY, type Me } from "./protocol";
import type { Frame, Laid, LiveRound, RoundSource, Score } from "./rounds";

export interface LpRoundProps {
  pool: PoolParams;
  source: RoundSource;
  /** true when the round is dealt and scored by the room server (a leaderboard round) */
  ranked: boolean;
  /** your account, online: the stake comes out of its stack */
  me: Me | null;
  /** the round riding on the server, if one is (on this pool: this panel takes it up; on another: no lay here) */
  live: LiveRound | null;
  onClose(): void;
}

/** the stall's cut of a stake, whole dollars rounded up (the room's own arithmetic) */
const rakeOf = (stake: number) => Math.ceil((stake * RAKE_PCT) / 100);

/** the most of `want` a stack can stake with the stall's cut on top, at most MAX_STAKE; 0 when not even the least fits */
function fits(stack: number, want: number): number {
  let s = Math.min(MAX_STAKE, Math.floor(stack), Math.floor(want));
  while (s >= MIN_STAKE && s + rakeOf(s) > stack) s -= 1;
  return s >= MIN_STAKE ? s : 0;
}

/** the stakes offered: nothing, the least, a quarter, a half, a band (or the most that fits), whole dollars, the cut on top */
function stakeChoices(me: Me | null): { label: string; v: number }[] {
  const out = [{ label: "Practice", v: 0 }];
  if (!me || me.rounds >= ROUNDS_PER_DAY) return out;
  const add = (label: string, want: number) => {
    const d = fits(me.stack, Math.max(MIN_STAKE, want));
    if (d && !out.some((o) => o.v === d)) out.push({ label, v: d });
  };
  add("The least", MIN_STAKE);
  add("A quarter", me.stack / 4);
  add("Half", me.stack / 2);
  const most = fits(me.stack, MAX_STAKE);
  add(most === MAX_STAKE ? "A band" : "The most", most);
  return out;
}

type Phase = "setup" | "laying" | "running" | "done";

const sign = (n: number, d = 2) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(d)}%`;
/** the site's month names (the locale's short form is "Sept") */
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "21 Sep, 14:00" in UTC */
const when = (unix: number) => {
  const d = new Date(unix * 1000);
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}, ${String(d.getUTCHours()).padStart(2, "0")}:00`;
};

/** the hold a staked band rides by default */
const DEFAULT_HOLD = 24;

export function LpRound({ pool, source, ranked, me, live, onClose }: LpRoundProps) {
  const [width, setWidth] = useState(16);
  const [offset, setOffset] = useState(0);
  const choices = stakeChoices(ranked ? me : null);
  // the choice by its label, not its place: the list changes with the stack, and a label that has gone means Practice
  const [pick, setPick] = useState("The least");
  const stakeIx = Math.max(0, choices.findIndex((c) => c.label === pick));
  const stake = choices[stakeIx].v;
  const [hold, setHold] = useState<number>(DEFAULT_HOLD);
  const [phase, setPhase] = useState<Phase>("setup");
  const [laid, setLaid] = useState<Laid | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [score, setScore] = useState<Score | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** a round this panel gave up on (the ticks stopped): not taken up again by this panel */
  const gaveUp = useRef<string | null>(null);
  const chart = useRef<HTMLCanvasElement>(null);

  const half = Math.floor(width / 2);
  useEffect(() => setOffset((o) => Math.max(-half, Math.min(half, o))), [half]);
  useEffect(() => () => source.stop(), [source]);

  /** a frame in order (a tick can reach the panel twice round a resume: the same hour is not added again) */
  const addFrame = (f: Frame) => setFrames((fs) => (fs.length && fs[fs.length - 1].i >= f.i ? fs : [...fs, f]));
  const onScore = (s: Score) => {
    setScore(s);
    setPhase("done");
  };

  /** the riding round is on another pool: no lay here until it settles */
  const riding = live && live.address !== pool.address ? live : null;

  // a round on this pool rides on the server that this panel is not watching (the panel was closed and opened again,
  // or the lay's answer came after the wait): take it up where it is. Layout effect: in the same task as the render,
  // so no tick lands between the frames copied here and the listening that follows
  useLayoutEffect(() => {
    if (!live || live.address !== pool.address || phase !== "setup" || laid || live.roundId === gaveUp.current) return;
    setErr(null);
    setScore(null);
    setLaid(live.laid);
    setFrames(live.frames);
    setPhase("running");
    source.resume(live.roundId, addFrame, onScore);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, pool.address, phase, laid, source]);

  async function start() {
    setErr(null);
    setLaid(null);
    setPhase("laying");
    setFrames([]);
    setScore(null);
    try {
      const l = await source.start(pool, width, offset, stake, stake ? hold : TICKS, addFrame, onScore);
      setLaid(l);
      setPhase((p) => (p === "laying" ? "running" : p));
    } catch (e) {
      setErr((e as Error).message || "Could not lay the band.");
      setPhase("setup");
    }
  }

  // a round that stops ticking is not waited on forever: the panel lets go (a stake is the server's to settle)
  useEffect(() => {
    if (phase !== "running" || !laid) return;
    const id = window.setTimeout(() => {
      gaveUp.current = laid.roundId;
      source.stop();
      setErr("The Exchange went quiet on this round. A stake comes back to your stack when it settles, within a minute. Then lay again.");
      setLaid(null);
      setFrames([]);
      setPhase("setup");
    }, laid.tickMs * 6 + 1500);
    return () => window.clearTimeout(id);
  }, [phase, laid, frames.length, source]);

  function closeNow() {
    if (phase === "running" && laid && frames.length) source.close(laid.roundId);
  }

  function playAgain() {
    setLaid(null);
    setFrames([]);
    setScore(null);
    setErr(null);
    setPhase("setup");
  }

  /** the hours the chart spans: the hold of a staked band, the whole stretch otherwise */
  const span = laid?.hold ?? TICKS;

  // the chart: the band as a strap across the hours, the price walking through it
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = c.clientWidth || 520;
    const H = c.clientHeight || 220;
    c.width = W * dpr;
    c.height = H * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    g.fillStyle = "#f9f4e9";
    g.fillRect(0, 0, W, H);
    const step = pool.binStepBps / 10000;
    const lower = laid ? laid.lower : Math.pow(1 + step, offset - width / 2);
    const upper = laid ? laid.upper : Math.pow(1 + step, offset + width / 2);
    const path = [1, ...frames.map((f) => f.p)];
    // room round the band (half its height again, each side) so you see price near its edges and leaving it
    const lnLo = Math.min(Math.log(lower), ...path.map(Math.log));
    const lnHi = Math.max(Math.log(upper), ...path.map(Math.log));
    const pad = Math.max(lnHi - lnLo, 0.004) * 0.5;
    const y = (p: number) => H - 14 - ((Math.log(p) - (lnLo - pad)) / (lnHi - lnLo + 2 * pad)) * (H - 28);
    const x = (t: number) => 12 + (t / span) * (W - 24);
    g.fillStyle = "rgba(255, 122, 26, 0.16)";
    g.fillRect(x(0), y(upper), x(span) - x(0), y(lower) - y(upper));
    g.strokeStyle = "#c9560a";
    g.lineWidth = 1;
    g.setLineDash([5, 4]);
    for (const b of [lower, upper]) {
      g.beginPath();
      g.moveTo(x(0), y(b));
      g.lineTo(x(span), y(b));
      g.stroke();
    }
    g.setLineDash([]);
    g.strokeStyle = "rgba(22,18,15,0.08)";
    for (let t = 0; t <= span; t += span / 4) {
      g.beginPath();
      g.moveTo(x(t), 8);
      g.lineTo(x(t), H - 8);
      g.stroke();
    }
    g.strokeStyle = "#16120f";
    g.lineWidth = 2;
    g.beginPath();
    path.forEach((p, t) => (t ? g.lineTo(x(t), y(p)) : g.moveTo(x(t), y(p))));
    g.stroke();
    const t = path.length - 1;
    const inBand = path[t] >= lower && path[t] <= upper;
    g.fillStyle = inBand ? "#ff7a1a" : "#b8321f";
    g.beginPath();
    g.arc(x(t), y(path[t]), 5, 0, Math.PI * 2);
    g.fill();
  }, [frames, laid, width, offset, pool.binStepBps, span]);

  const last = frames[frames.length - 1] ?? null;
  const hours = last?.i ?? 0;
  /** the hour the round settled at: the server's word when it gives one */
  const settledAt = score?.at ?? hours;
  const inRangeHours = frames.filter((f) => f.inRange).length;
  const fees = last?.feesPct ?? 0;
  const value = last ? last.valuePct - 100 : 0;
  const holdPct = last ? last.holdPct - 100 : 0;
  const net = last ? last.valuePct + last.feesPct - last.holdPct : 0;
  const back = score?.back ?? 0;
  /** what a staked round made or lost: what came back less the stake and the stall's cut */
  const made = score?.stake ? back - score.stake - (laid?.rake ?? 0) : 0;
  const staked = (laid?.stake ?? 0) > 0;

  return (
    <div className="lp">
      <div className="lp__head">
        <p className="play-eyebrow">A stall at the board · play money{ranked ? " · on the leaderboard" : ""}</p>
        <h2 className="lp__title">{pool.label}</h2>
        <p className="lp__sub">Paid {pool.feePctPerHour.toFixed(3)}% of its liquidity in fees last hour. Lay a band, and every hour price trades inside it pays you a share.</p>
      </div>

      <canvas ref={chart} className="lp__chart" aria-label={`Price over ${span} hours with your band`} />
      {laid && laid.real !== undefined && phase !== "setup" && (
        <p className="lp__src">
          {laid.real ? "48 real hours from this pool's last ten days: prices as they traded, fees on the pool's liquidity now. Which hours is revealed at the end." : "Simulated hours this time, shaped by how this pool moved in its last hour."}
        </p>
      )}

      {phase === "setup" || phase === "laying" ? (
        <div className="lp__controls">
          <label className="lp__field">
            <span>
              Band width <b>{width} bins</b>
            </span>
            <input type="range" min={WIDTH_MIN} max={WIDTH_MAX} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
            <small>Narrow takes a bigger share of the fees and leaves the price sooner.</small>
          </label>
          <label className="lp__field">
            <span>
              Centre <b>{offset === 0 ? "on the price" : `${Math.abs(offset)} bins ${offset > 0 ? "above" : "below"}`}</b>
            </span>
            <input type="range" min={-half} max={half} value={offset} onChange={(e) => setOffset(Number(e.target.value))} />
          </label>
          <div className="lp__field">
            <span>
              Stake <b>{stake ? usd(stake) : "nothing, a practice round"}</b>
              {stake ? (
                <small>
                  {" "}
                  · the stall keeps {RAKE_PCT}% ({usd(rakeOf(stake))})
                </small>
              ) : null}
            </span>
            <Radios label="Stake" options={choices.map((c) => ({ key: c.label, text: c.label, sub: c.v ? usd(c.v) : undefined }))} value={choices[stakeIx].label} onPick={setPick} />
            <small>
              {!ranked
                ? "Offline, every round is practice. Your stack is kept by the Exchange when it's online."
                : !me
                  ? "The Exchange isn't keeping stacks right now; this round is practice."
                  : me.rounds >= ROUNDS_PER_DAY
                    ? `That's all ${ROUNDS_PER_DAY} staked rounds for today. Practice is still open.`
                    : !fits(me.stack, MIN_STAKE)
                      ? `Your stack is under ${usd(MIN_STAKE + rakeOf(MIN_STAKE))}, the least stake with the stall's cut on top. Mr Bands pays a wage at his desk every day.`
                      : `Your stack: ${usd(me.stack)}. ${ROUNDS_PER_DAY - me.rounds} staked rounds left today, ${usd(MIN_STAKE)} to ${usd(MAX_STAKE)} each. What comes back is your stake plus what the band made against just holding.`}
            </small>
          </div>
          {stake > 0 && (
            <div className="lp__field">
              <span>
                Hold <b>{hold} hours</b>
              </span>
              <Radios label="Hold" options={HOLDS.map((h) => ({ key: String(h), text: `${h} hours` }))} value={String(hold)} onPick={(k) => setHold(Number(k))} />
              <small>A staked band rides its full hours, whatever the price does. Only a practice band can be closed early.</small>
            </div>
          )}
          {riding && (
            <p className="lp__riding">
              Your band on {riding.label} is still riding, hour {riding.frames[riding.frames.length - 1]?.i ?? 0} of {riding.laid.hold}.
            </p>
          )}
          <div className="lp__row">
            <button type="button" className="play-btn play-btn--ink" onClick={start} disabled={phase === "laying" || riding !== null}>
              {phase === "laying" ? "Laying…" : "Lay the band"}
            </button>
            <button type="button" className="play-btn" onClick={onClose}>
              Walk away
            </button>
          </div>
          {err && <p className="lp__err">{err}</p>}
        </div>
      ) : (
        <div className="lp__run">
          <dl className="lp__stats">
            <div>
              <dt>Hour</dt>
              <dd>
                {phase === "done" ? settledAt : hours} / {span}
              </dd>
            </div>
            <div>
              <dt>In your band</dt>
              <dd>{inRangeHours} h</dd>
            </div>
            <div>
              <dt>Fees earned</dt>
              <dd className="lp__good">{sign(fees)}</dd>
            </div>
            <div>
              <dt>Band value</dt>
              <dd>{sign(value)}</dd>
            </div>
            <div>
              <dt>Just holding</dt>
              <dd>{sign(holdPct)}</dd>
            </div>
            <div>
              <dt>You vs holding</dt>
              <dd className={net >= 0 ? "lp__good" : "lp__bad"}>{sign(net)}</dd>
            </div>
          </dl>
          {phase === "running" ? (
            <div className="lp__row">
              <button type="button" className="play-btn play-btn--ink" onClick={closeNow} disabled={!frames.length}>
                {staked ? "Skip to the end" : "Close the band now"}
              </button>
              {/* a staked band rides on the server whether the panel is open or not; a practice band closes with it */}
              <button type="button" className="play-btn" onClick={onClose}>
                {staked ? "Let it ride" : "Walk away"}
              </button>
            </div>
          ) : (
            <div className="lp__done">
              <p className="lp__verdict">
                You finished <b className={(score?.pct ?? 0) >= 0 ? "lp__good" : "lp__bad"}>{sign(score?.pct ?? net)}</b> against just holding
                {score?.rank ? <>, number {score.rank} on the board</> : null}. Price stayed in your band {inRangeHours} of {settledAt} hours.
              </p>
              {score?.stake ? (
                <p className="lp__stacked">
                  You staked {usd(score.stake)}, the stall kept {usd(laid?.rake ?? 0)}, and {usd(back)} came back to your stack:{" "}
                  <b className={made >= 0 ? "lp__good" : "lp__bad"}>
                    {made >= 0 ? "+" : "−"}
                    {usd(Math.abs(made))}
                  </b>
                  .
                </p>
              ) : null}
              {score?.from !== undefined && (
                <p className="lp__reveal">
                  Those were {pool.label}'s real hours from {when(score.from)} to {when(score.from + settledAt * 3600)} UTC.
                </p>
              )}
              <div className="lp__row">
                <button type="button" className="play-btn play-btn--ink" onClick={playAgain}>
                  Play again
                </button>
                <button type="button" className="play-btn" onClick={onClose}>
                  Walk away
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <p className="lp__fine">A game with play money. The hours replay this pool's own history when it can be read, and are simulated when it can't. Not a forecast, not advice.</p>
    </div>
  );
}

/** a row of radio buttons as the ARIA pattern promises: one tab stop, the arrows, Home and End move the choice and the focus */
function Radios({ label, options, value, onPick }: { label: string; options: { key: string; text: string; sub?: string }[]; value: string; onPick(key: string): void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = Math.max(0, options.findIndex((o) => o.key === value));
  const go = (i: number) => {
    const j = (i + options.length) % options.length;
    onPick(options[j].key);
    refs.current[j]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(options.length - 1);
    else return;
    e.preventDefault();
  };
  return (
    <div className="lp__stakes" role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {options.map((o, i) => (
        <button
          key={o.key}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={i === at}
          tabIndex={i === at ? 0 : -1}
          className={`play-btn play-btn--sm${i === at ? " is-on" : ""}`}
          onClick={() => onPick(o.key)}
        >
          {o.text}
          {o.sub ? <small> {o.sub}</small> : null}
        </button>
      ))}
    </div>
  );
}
