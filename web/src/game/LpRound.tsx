/**
 * The stall's game (bands.finance Play): lay a band on a live pool with play money, watch 48 hours of price go
 * through it, close it when you like, and score against just holding. The hours are a hidden stretch of the pool's
 * real history where it has one, named when the round is scored. The hours come from a RoundSource
 * (src/game/rounds.ts): the room server's stream online, the local simulation offline; this panel only draws them.
 * It teaches the trade-off his desk lives on: narrow bands take more of the fees and leave the price sooner.
 */
import { useEffect, useRef, useState } from "react";
import { TICKS, WIDTH_MAX, WIDTH_MIN, type PoolParams } from "./lpGame";
import type { Frame, Laid, RoundSource, Score } from "./rounds";

export interface LpRoundProps {
  pool: PoolParams;
  source: RoundSource;
  /** true when the round is dealt and scored by the room server (a leaderboard round) */
  ranked: boolean;
  onClose(): void;
}

type Phase = "setup" | "laying" | "running" | "done";

const sign = (n: number, d = 2) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(d)}%`;
/** "21 Sep, 14:00" in UTC */
const when = (unix: number) => {
  const d = new Date(unix * 1000);
  const mon = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return `${d.getUTCDate()} ${mon}, ${String(d.getUTCHours()).padStart(2, "0")}:00`;
};

export function LpRound({ pool, source, ranked, onClose }: LpRoundProps) {
  const [width, setWidth] = useState(16);
  const [offset, setOffset] = useState(0);
  const [phase, setPhase] = useState<Phase>("setup");
  const [laid, setLaid] = useState<Laid | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [score, setScore] = useState<Score | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const chart = useRef<HTMLCanvasElement>(null);

  const half = Math.floor(width / 2);
  useEffect(() => setOffset((o) => Math.max(-half, Math.min(half, o))), [half]);
  useEffect(() => () => source.stop(), [source]);

  async function start() {
    setErr(null);
    setPhase("laying");
    setFrames([]);
    setScore(null);
    try {
      const l = await source.start(
        pool,
        width,
        offset,
        (f) => setFrames((fs) => [...fs, f]),
        (s) => {
          setScore(s);
          setPhase("done");
        },
      );
      setLaid(l);
      setPhase((p) => (p === "laying" ? "running" : p));
    } catch (e) {
      setErr((e as Error).message || "Could not lay the band.");
      setPhase("setup");
    }
  }

  // a round that stops ticking (the room restarted mid-round) is given up, not waited on forever
  useEffect(() => {
    if (phase !== "running" || !laid) return;
    const id = window.setTimeout(() => {
      source.stop();
      setErr("The Exchange lost this round. Lay the band again.");
      setPhase("setup");
    }, laid.tickMs * 6 + 1500);
    return () => window.clearTimeout(id);
  }, [phase, laid, frames.length, source]);

  function closeNow() {
    if (phase === "running" && laid && frames.length) source.close(laid.roundId);
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
    for (let t = 0; t <= TICKS; t += 12) {
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
  const inRangeHours = frames.filter((f) => f.inRange).length;
  const fees = last?.feesPct ?? 0;
  const value = last ? last.valuePct - 100 : 0;
  const hold = last ? last.holdPct - 100 : 0;
  const net = last ? last.valuePct + last.feesPct - last.holdPct : 0;

  return (
    <div className="lp">
      <div className="lp__head">
        <p className="play-eyebrow">A stall at the board · play money{ranked ? " · on the leaderboard" : ""}</p>
        <h2 className="lp__title">{pool.label}</h2>
        <p className="lp__sub">Paid {pool.feePctPerHour.toFixed(3)}% of its liquidity in fees last hour. Lay a band, and every hour price trades inside it pays you a share.</p>
      </div>

      <canvas ref={chart} className="lp__chart" aria-label="Price over 48 hours with your band" />
      {laid && laid.real !== undefined && phase !== "setup" && (
        <p className="lp__src">
          {laid.real ? "48 real hours from this pool's last eight days, prices and fees as they traded. Which hours is revealed at the end." : "Simulated hours: this pool hasn't traded long enough for two days of history."}
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
                {hours} / {TICKS}
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
              <dd>{sign(hold)}</dd>
            </div>
            <div>
              <dt>You vs holding</dt>
              <dd className={net >= 0 ? "lp__good" : "lp__bad"}>{sign(net)}</dd>
            </div>
          </dl>
          {phase === "running" ? (
            <button type="button" className="play-btn play-btn--ink" onClick={closeNow} disabled={!frames.length}>
              Close the band now
            </button>
          ) : (
            <div className="lp__done">
              <p className="lp__verdict">
                You finished <b className={(score?.pct ?? 0) >= 0 ? "lp__good" : "lp__bad"}>{sign(score?.pct ?? net)}</b> against just holding
                {score?.rank ? <>, number {score.rank} on the board</> : null}. Price stayed in your band {inRangeHours} of {hours} hours.
              </p>
              {score?.from !== undefined && (
                <p className="lp__reveal">
                  Those were {pool.label}'s real hours from {when(score.from)} to {when(score.from + TICKS * 3600)} UTC.
                </p>
              )}
              <div className="lp__row">
                <button type="button" className="play-btn play-btn--ink" onClick={() => setPhase("setup")}>
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
      <p className="lp__fine">A game with play money. The hours replay this pool's own history where it has two days of it, and are simulated where it doesn't. Not a forecast, not advice.</p>
    </div>
  );
}
