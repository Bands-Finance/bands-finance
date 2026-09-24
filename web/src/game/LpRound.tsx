/**
 * The stall's game (bands.finance Play): a teaching game with play money. Lay a band on a live pool, watch the hours
 * of price go through it, and see what the band earns against just holding. Nothing is staked: the stalls teach the
 * trade-off his desk lives on (narrow bands take more of the fees and leave the price sooner), and a round dealt by
 * the room goes on the Best rounds board. The hours are a hidden stretch of the pool's real history where it has
 * one, named when the round is scored. They come from a RoundSource (src/game/rounds.ts): the room server's stream
 * online, the local simulation offline; this panel only draws them, and closes its round when you walk away.
 */
import { useEffect, useRef, useState } from "react";
import { TICKS, WIDTH_MAX, WIDTH_MIN, type PoolParams } from "./lpGame";
import type { Frame, Laid, RoundSource, Score } from "./rounds";

export interface LpRoundProps {
  pool: PoolParams;
  source: RoundSource;
  /** true when the round is dealt and scored by the room server (a Best rounds board round) */
  ranked: boolean;
  onClose(): void;
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

export function LpRound({ pool, source, ranked, onClose }: LpRoundProps) {
  const [width, setWidth] = useState(16);
  const [offset, setOffset] = useState(0);
  const [phase, setPhase] = useState<Phase>("setup");
  const [laid, setLaid] = useState<Laid | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [score, setScore] = useState<Score | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** the round riding right now, for the panel's leaving: closed, so nothing rides on without a watcher */
  const running = useRef<string | null>(null);
  const chart = useRef<HTMLCanvasElement>(null);

  const half = Math.floor(width / 2);
  useEffect(() => setOffset((o) => Math.max(-half, Math.min(half, o))), [half]);
  useEffect(
    () => () => {
      source.stop();
      if (running.current) source.close(running.current);
    },
    [source],
  );
  running.current = phase === "running" && laid ? laid.roundId : null;

  const addFrame = (f: Frame) => setFrames((fs) => (fs.length && fs[fs.length - 1].i >= f.i ? fs : [...fs, f]));
  const onScore = (s: Score) => {
    setScore(s);
    setPhase("done");
  };

  async function start() {
    setErr(null);
    setLaid(null);
    setPhase("laying");
    setFrames([]);
    setScore(null);
    try {
      const l = await source.start(pool, width, offset, addFrame, onScore);
      setLaid(l);
      setPhase((p) => (p === "laying" ? "running" : p));
    } catch (e) {
      setErr((e as Error).message || "Could not lay the band.");
      setPhase("setup");
    }
  }

  // a round that stops ticking is not waited on forever: the panel lets go
  useEffect(() => {
    if (phase !== "running" || !laid) return;
    const id = window.setTimeout(() => {
      source.stop();
      setErr("The Exchange went quiet on this round. Lay again.");
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
    const x = (t: number) => 12 + (t / TICKS) * (W - 24);
    g.fillStyle = "rgba(255, 122, 26, 0.16)";
    g.fillRect(x(0), y(upper), x(TICKS) - x(0), y(lower) - y(upper));
    g.strokeStyle = "#c9560a";
    g.lineWidth = 1;
    g.setLineDash([5, 4]);
    for (const b of [lower, upper]) {
      g.beginPath();
      g.moveTo(x(0), y(b));
      g.lineTo(x(TICKS), y(b));
      g.stroke();
    }
    g.setLineDash([]);
    g.strokeStyle = "rgba(22,18,15,0.08)";
    for (let t = 0; t <= TICKS; t += TICKS / 4) {
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
  }, [frames, laid, width, offset, pool.binStepBps]);

  const last = frames[frames.length - 1] ?? null;
  const hours = last?.i ?? 0;
  /** the hour the round settled at: the server's word when it gives one */
  const settledAt = score?.at ?? hours;
  const inRangeHours = frames.filter((f) => f.inRange).length;
  const fees = last?.feesPct ?? 0;
  const value = last ? last.valuePct - 100 : 0;
  const holdPct = last ? last.holdPct - 100 : 0;
  const net = last ? last.valuePct + last.feesPct - last.holdPct : 0;

  return (
    <div className="lp">
      <div className="lp__head">
        <p className="play-eyebrow">A stall at the board · play money{ranked ? " · on the board" : ""}</p>
        <h2 className="lp__title">{pool.label}</h2>
        <p className="lp__sub">A teaching game with play money on this pool's real hours: lay a band, watch the price go through it, see what a band earns against just holding. Not advice.</p>
      </div>

      <canvas ref={chart} className="lp__chart" aria-label={`Price over ${TICKS} hours with your band`} />
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
          <div className="lp__row">
            <button type="button" className="play-btn play-btn--ink" onClick={start} disabled={phase === "laying"}>
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
                {phase === "done" ? settledAt : hours} / {TICKS}
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
                Close the band now
              </button>
              <button type="button" className="play-btn" onClick={onClose}>
                Walk away
              </button>
            </div>
          ) : (
            <div className="lp__done">
              <p className="lp__verdict">
                You finished <b className={(score?.pct ?? 0) >= 0 ? "lp__good" : "lp__bad"}>{sign(score?.pct ?? net)}</b> against just holding
                {score?.rank ? <>, number {score.rank} on the board</> : null}. Price stayed in your band {inRangeHours} of {settledAt} hours.
              </p>
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
      <p className="lp__fine">Play money. The hours replay this pool's own history when it can be read, and are simulated when it can't. Not a forecast, not advice.</p>
    </div>
  );
}
