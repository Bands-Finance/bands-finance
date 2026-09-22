import { Component, Fragment, useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { GLOSS, type AgentRecord, type DayRow, type FeePoint, type Status } from "../model";
import { ago, clock, dayClock, fmtSigned } from "../format";
import { runDays, type LiveRun } from "../liveRun";
import "./ProfitTracker.css";

/**
 * The Record: the money, from the journal alone. Ported from Meridian's
 * ProfitTracker; every chain, explorer and price-feed read is gone. The
 * integrator hands in an AgentRecord (src/model.ts) and a SOL price for the
 * USD shadow, and this file only says it in words and pixels. Units are SOL;
 * dollars appear in parentheses when the price is known and never otherwise.
 */
export interface RecordProps {
  /** null while the journal is still loading: the skeleton shows */
  record: AgentRecord | null;
  solPriceUsd: number | null;
  status: Status;
  agentName: string;
  /** the dashboard: the chart and the daily board only; the page's first screen already said the number */
  compact?: boolean;
  /** his real-money run (liveRun.ts): with no book open the Record states it, settled, in place of a book */
  run?: LiveRun | null;
}

/* ---------- money words ---------- */

const solFmt = (n: number, d = 4) => `${n.toFixed(d)} SOL`;
const signedSol = (n: number, d = 4) => `${fmtSigned(n, d)} SOL`;
/** Fees start life as dust; show the ticking, never a flat 0.0000. */
const feeSol = (n: number) => (n <= 0 ? "0 SOL" : n < 0.00005 ? "<0.0001 SOL" : solFmt(n));
const plusFee = (n: number) => (n >= 0.00005 ? `+${solFmt(n)}` : feeSol(n));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** " (≈ $1.22)" when the SOL price is known, nothing when it is not. Never a guess. */
function usdShadow(sol: number, px: number | null): string {
  if (px === null || !Number.isFinite(px) || px <= 0) return "";
  const v = sol * px;
  const a = Math.abs(v);
  const body = a >= 1000 ? `$${Math.round(a).toLocaleString()}` : a < 0.005 ? (a === 0 ? "$0.00" : "<$0.01") : `$${a.toFixed(2)}`;
  return ` (≈ ${v <= -0.005 ? "−" : ""}${body})`;
}

function fmtAmount(n: number): string {
  const a = Math.abs(n);
  if (a >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (a >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return n.toPrecision(3);
}

function startDate(ts: number): string {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "long", day: "numeric" } : { month: "long", day: "numeric", year: "numeric" });
}

/** One dead sub-section must not take the headline with it. */
class SectionBoundary extends Component<{ children: ReactNode }, { dead: boolean }> {
  state = { dead: false };
  static getDerivedStateFromError() { return { dead: true }; }
  render() { return this.state.dead ? null : this.props.children; }
}

export function Record({ record, solPriceUsd, status, agentName, compact = false, run = null }: RecordProps) {
  if (!record && status.mode === "none") {
    // no book open: the Record is his real-money run, settled, the same figures as its chapter on mrbands.finance
    return (
      <section className="pnl" aria-label={`The record of ${agentName}`}>
        <div className="pnl__num">
          <span className="pnl__label">{run ? `His real-money run, ${runDays(run.firstTs, run.lastTs)}` : "No book open right now"}</span>
          {run && (
            <>
              <span className={`pnl__value ${run.change >= 0 ? "pnl__value--up" : "pnl__value--down"}`}>{signedSol(run.change, 2)}</span>
              <span className="pnl__sub">
                Started with {solFmt(run.startEquity, 2)}, stopped with {solFmt(run.endEquity, 2)}{run.settled ? ", all cash" : ""}. {solFmt(run.feesClaimed, 2)} of fees claimed.
              </span>
              <span className="pnl__links">
                <span>
                  {plural(run.moves, "move")} · {plural(run.claims, "claim")} · {plural(run.transactions, "transaction")} ·{" "}
                  <a href={`https://solscan.io/account/${run.wallet}`} target="_blank" rel="noreferrer">the wallet on Solscan ↗</a>
                </span>
              </span>
            </>
          )}
          {!run && <span className="pnl__sub">No band is open and no money is at work.</span>}
        </div>
      </section>
    );
  }
  if (!record) {
    return (
      <section className="pnl" aria-label={`The record of ${agentName}, loading`}>
        <div className="pnl__skeleton">
          <div className="pnl__skeleton-bar pnl__skeleton-bar--wide" />
          <div className="pnl__skeleton-bar" />
          <div className="pnl__skeleton-chart" />
          <span className="pnl__chart-label">reading the journal…</span>
        </div>
      </section>
    );
  }

  const up = record.net >= 0;
  const simulated = status.mode !== "live";
  const simGloss = status.mode === "demo" ? GLOSS.demo : GLOSS.dryRun;
  const tokensHeld = record.tokens.map((t) => `${fmtAmount(t.amount)} ${t.symbol} (${solFmt(t.inSol)})`).join(", ");

  const c = record.counts;
  const tally: ReactNode[] = [`${plural(c.decisions, "decision")} on record`, plural(c.holds, "hold")];
  if (c.placed) tally.push(`${c.placed} sent on-chain`);
  if (c.simulated) tally.push(`${c.simulated} simulated`);
  if (c.failed) tally.push(`${c.failed} failed`);
  if (c.vetoed) tally.push(<>{c.vetoed} vetoed by the <span className="term" title={GLOSS.guards}>guards</span></>);
  if (c.overrides) tally.push(plural(c.overrides, "guard override"));
  tally.push(plural(c.pools, "pool"));

  if (compact) {
    return (
      <section className="pnl pnl--compact" aria-label={`The record of ${agentName}`}>
        <SectionBoundary>
          <EarningsChart points={record.feePoints} feesUnclaimed={record.feesUnclaimed} solPriceUsd={solPriceUsd} agentName={agentName} />
        </SectionBoundary>
        <SectionBoundary>
          {record.days.length > 0 && <ConsistencyBoard days={record.days} feesRealized={record.feesRealized} solPriceUsd={solPriceUsd} />}
        </SectionBoundary>
      </section>
    );
  }
  return (
    <section className="pnl" aria-label={`The record of ${agentName}`}>
      <div className="pnl__num">
        <span className="pnl__label">
          Net result, wallet and bands
          {simulated && <> · <span className="term" title={simGloss}>simulated</span></>}
        </span>
        <span className={`pnl__value ${up ? "pnl__value--up" : "pnl__value--down"}`}>
          {signedSol(record.net)}
          {solPriceUsd !== null && <span className="pnl__value-usd">{usdShadow(record.net, solPriceUsd).trim()}</span>}
        </span>
        <span className="pnl__sub">
          Started with {solFmt(record.startEquity)} on {startDate(record.startTs)}. The book is {solFmt(record.equityNow)}
          {usdShadow(record.equityNow, solPriceUsd)}. {solFmt(record.wallet)}{record.quote ? ` and ${fmtAmount(record.quote.amount)} ${record.quote.symbol} (${solFmt(record.quote.inSol)})` : ""} in the wallet, {solFmt(record.atWork)} at work in{" "}
          <span className="term" title={GLOSS.band}>bands</span>
          {record.tokens.length ? `, ${tokensHeld} from closed bands` : ""}
          {record.hedge !== null && Math.abs(record.hedge) >= 0.00005 ? `, the hedge desk at ${signedSol(record.hedge)}` : ""}.
        </span>
        <details className="pnl__how">
          <summary>How this is computed</summary>
          <p>
            ‘At work’ is SOL in bands at the pool's price.{" "}
            {record.sinceStart ? `${solFmt(record.rent)} of rent comes back when bands close and is not counted.` : `The book includes ${solFmt(record.rent)} of rent that comes back when bands close.`}
          </p>
          {record.anySimulated && (
            <p>In a dry run nothing is sent; these fees are what he would have earned.</p>
          )}
        </details>
        <span className="pnl__links">
          <span>
            {tally.map((t, i) => (
              <Fragment key={i}>
                {i > 0 ? " · " : ""}
                {t}
              </Fragment>
            ))}
          </span>
        </span>
      </div>
      <SectionBoundary>
        <EarningsChart points={record.feePoints} feesUnclaimed={record.feesUnclaimed} solPriceUsd={solPriceUsd} agentName={agentName} />
      </SectionBoundary>
      <SectionBoundary>
        {record.days.length > 0 && <ConsistencyBoard days={record.days} feesRealized={record.feesRealized} solPriceUsd={solPriceUsd} />}
      </SectionBoundary>
    </section>
  );
}

/* ---------- the earnings chart ---------- */

/**
 * A monotone cubic (Fritsch-Carlson) through the claim points. Chosen over a
 * Catmull-Rom or bezier smoothing because it cannot overshoot: between two
 * claims the curve never rises above the later one, so the chart never shows
 * fees that had not been claimed yet.
 */
function monotonePath(points: Array<[number, number]>): string {
  const n = points.length;
  if (n === 0) return "";
  if (n === 1) return `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const dx: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) { dx.push(xs[i + 1] - xs[i]); m.push(dx[i] === 0 ? 0 : (ys[i + 1] - ys[i]) / dx[i]); }
  const tg: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) tg.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  tg.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { tg[i] = 0; tg[i + 1] = 0; continue; }
    const a = tg[i] / m[i], b = tg[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const tau = 3 / Math.sqrt(s); tg[i] = tau * a * m[i]; tg[i + 1] = tau * b * m[i]; }
  }
  let d = `M${xs[0].toFixed(1)},${ys[0].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const hh = dx[i];
    d += ` C${(xs[i] + hh / 3).toFixed(1)},${(ys[i] + (tg[i] * hh) / 3).toFixed(1)} ${(xs[i + 1] - hh / 3).toFixed(1)},${(ys[i + 1] - (tg[i + 1] * hh) / 3).toFixed(1)} ${xs[i + 1].toFixed(1)},${ys[i + 1].toFixed(1)}`;
  }
  return d;
}

/** Tween a number toward its target so totals ROLL when fees land instead
 *  of teleporting. Small, 600ms, and honest: it always settles on the truth. */
function useCountUp(target: number): number {
  const [shown, setShown] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    const from = fromRef.current;
    if (from === target) return;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 600);
      const eased = 1 - (1 - k) * (1 - k);
      setShown(from + (target - from) * eased);
      if (k < 1) raf = requestAnimationFrame(step);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return shown;
}

/** A clock that re-renders twice a minute, so "last claim 3 min ago" ticks. */
function useMinuteTick(): number {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  return Date.now();
}

/** A clean step for the SOL guides: 1, 2 or 5 times a power of ten. */
function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
}
const decimalsFor = (step: number) => Math.min(6, Math.max(0, -Math.floor(Math.log10(step))));
const chartSol = (v: number) => (v >= 1 ? v.toFixed(3) : v.toFixed(4));

/**
 * Cumulative fees claimed, one dot per claim, from the journal's own fee
 * points. The honest shape is a ratchet: it steps up when a claim lands and
 * holds flat in between. Layers kept deliberately few: the ratchet, its
 * claims, a live tip, a hover crosshair.
 */
function EarningsChart({ points, feesUnclaimed, solPriceUsd, agentName }: { points: FeePoint[]; feesUnclaimed: number; solPriceUsd: number | null; agentName: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(680);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  // Default view starts where the money starts: the active era, found
  // structurally as the first point after the longest quiet gap. Only offered
  // once there are enough claims for a quiet stretch to mean something.
  const [showAll, setShowAll] = useState(false);
  const tick = useMinuteTick();
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => {
      for (const e of es) setW(Math.max(320, Math.floor(e.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const total = points.length ? points[points.length - 1].cumulative : 0;
  const shownTotal = useCountUp(total);

  if (points.length === 0) {
    return (
      <div className="pnl__chart" ref={wrapRef}>
        <div className="pnl__chart-head">
          <span className="pnl__chart-eyebrow">Fees claimed · cumulative SOL</span>
          <span className="pnl__chart-substat">nothing claimed yet</span>
        </div>
        <span className="pnl__chart-label">
          No fees claimed yet.
          {feesUnclaimed > 0 ? ` ${feeSol(feesUnclaimed)} is waiting inside open bands.` : ""}
        </span>
      </div>
    );
  }

  let eraStart = 0;
  let widestGap = 0;
  for (let i = 1; i < points.length; i++) {
    const gap = points[i].t - points[i - 1].t;
    if (gap > widestGap) { widestGap = gap; eraStart = i; }
  }
  const eraAvailable = points.length >= 8 && eraStart >= 2 && eraStart <= points.length - 2;
  const from = showAll || !eraAvailable ? 0 : eraStart;
  const view = points.slice(from);
  const lo = from === 0 ? 0 : points[from - 1].cumulative;

  const h = 200, padT = 26, padB = 26, padL = 10;
  const padR = w < 480 ? 92 : 104; // the tip label's reserved lane: "+0.0123 SOL" must not clip on phones
  const nowMs = tick;
  const t0 = view[0].t;
  const span = Math.max(nowMs - t0, 3600e3);
  const x = (t: number) => padL + ((t - t0) / span) * (w - padL - padR);
  const viewTop = total;
  const y = (v: number) => {
    const range = Math.max(viewTop * 1.06 - lo, 1e-9);
    return h - padB - ((v - lo) / range) * (h - padT - padB);
  };

  const edgeX = w - padR;
  const startY = y(lo);
  const prevY = y(total);
  const anchors: Array<[number, number]> = [[x(view[0].t), startY], ...view.map((p): [number, number] => [x(p.t), y(p.cumulative)]), [edgeX, prevY]];
  const line = monotonePath(anchors);
  const area = `${line} L${edgeX.toFixed(1)},${h - padB} L${x(view[0].t).toFixed(1)},${h - padB} Z`;

  // SOL guides on a clean step, skipped where they would sit on the tip label.
  const step = niceStep((viewTop - lo) / 3);
  const guides: number[] = [];
  if (step > 0) {
    for (let k = Math.ceil(lo / step); k * step < viewTop && guides.length < 5; k++) {
      const v = k * step;
      if (v > lo && Math.abs(y(v) - prevY) > 12) guides.push(v);
    }
  }
  const guideDecimals = step > 0 ? decimalsFor(step) : 4;
  const dayMs = 86400e3, hourMs = 3600e3;
  const shadeX = Math.max(x(view[0].t), x(nowMs - dayMs));

  const before24 = [...points].reverse().find((p) => p.t < nowMs - dayMs);
  const last24 = total - (before24 ? before24.cumulative : 0);
  const claims24 = points.filter((p) => p.t >= nowMs - dayMs).length;

  const dayLabel = (t: number) => new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
  // Axis ticks follow the span (hours for a run under two days, days after)
  // and the width: one label per ~70px, so a phone gets three and a desktop eight.
  const maxTicks = Math.max(2, Math.floor((w - padL - padR) / 70));
  const ticks: { t: number; label: string }[] = [];
  if (span < 2 * dayMs) {
    const stepH = Math.max(1, Math.ceil(span / hourMs / maxTicks));
    const first = new Date(t0); first.setMinutes(0, 0, 0);
    for (let t = first.getTime() + stepH * hourMs; t < nowMs - stepH * hourMs * 0.3; t += stepH * hourMs) {
      if (t >= t0) ticks.push({ t, label: clock(t) });
    }
  } else {
    const stepDays = Math.max(1, Math.ceil(span / dayMs / maxTicks));
    const midnight0 = new Date(t0); midnight0.setHours(0, 0, 0, 0);
    for (let t = midnight0.getTime() + dayMs; t < nowMs - stepDays * dayMs * 0.3; t += stepDays * dayMs) {
      if (t >= t0) ticks.push({ t, label: dayLabel(t) });
    }
  }

  // Claim dots earn their pixels: radius follows the money (sqrt scale against
  // the biggest claim so a large claim does not erase a small one), hover
  // magnifies, click opens the transaction itself when the journal holds it.
  const maxAmount = Math.max(1e-12, ...points.map((p) => p.amount));
  const rFor = (amount: number) => 2 + 5.5 * Math.sqrt(Math.max(amount, 0) / maxAmount);
  const onMove = (ev: ReactMouseEvent<SVGSVGElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const mx = ((ev.clientX - rect.left) / rect.width) * w;
    let bi = 0;
    for (let i = 1; i < view.length; i++) if (Math.abs(x(view[i].t) - mx) < Math.abs(x(view[bi].t) - mx)) bi = i;
    setHover({ i: bi, x: x(view[bi].t), y: y(view[bi].cumulative) });
  };
  const kindOf = (p: FeePoint) => (p.simulated ? "simulated claim" : "claim");
  const openTx = (href: string | null) => {
    if (href) window.open(href, "_blank", "noopener");
  };
  const hovered = hover ? view[hover.i] : null;
  const last = points[points.length - 1];
  const anySim = points.some((p) => p.simulated);

  return (
    <div className="pnl__chart" ref={wrapRef}>
      <div className="pnl__chart-head">
        <span className="pnl__chart-eyebrow">Fees claimed · cumulative SOL · {from === 0 ? `since ${dayLabel(points[0].t)}` : "the active era"}</span>
        <span className="pnl__chart-stat">
          {hovered
            ? `+${chartSol(hovered.amount)} SOL ${kindOf(hovered)} · ${dayClock(hovered.t)}${hovered.href ? " · click to verify" : ""}`
            : `+${chartSol(shownTotal)} SOL${usdShadow(shownTotal, solPriceUsd)}`}
        </span>
        <span className="pnl__chart-substat">
          {plural(points.length, "claim")} since the first band ·{" "}
          <span className="pnl__chart-live">last claim {ago(last.t, tick)}</span>
        </span>
        {eraAvailable && (
          <button className="pnl__chart-toggle" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "zoom to the action" : "full history"}
          </button>
        )}
      </div>
      <svg
        width={w}
        height={h}
        className="pnl__bigchart pnl__bigchart--clickable"
        role="img"
        aria-label={`cumulative fees ${agentName} has claimed; every dot is one claim`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onClick={() => hovered && openTx(hovered.href)}
      >
        <defs>
          <linearGradient id={`pnlArea${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="pnl__ink-stop" stopOpacity="0.28" />
            <stop offset="60%" className="pnl__ink-stop" stopOpacity="0.06" />
            <stop offset="100%" className="pnl__ink-stop" stopOpacity="0" />
          </linearGradient>
          <filter id={`pnlGlow${uid}`} x="-10%" y="-40%" width="120%" height="180%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>

        <line x1={padL} y1={h - padB} x2={w - padR + 36} y2={h - padB} stroke="currentColor" opacity="0.14" />
        {ticks.map((tk, i) => (
          <g key={i}>
            <line x1={x(tk.t)} y1={h - padB} x2={x(tk.t)} y2={h - padB + 4} stroke="currentColor" opacity="0.22" />
            <text x={x(tk.t)} y={h - 8} textAnchor="middle" className="pnl__axis">{tk.label}</text>
          </g>
        ))}
        <text x={w - padR + 36} y={h - 8} textAnchor="end" className="pnl__axis">now</text>

        {guides.map((v) => (
          <g key={v}>
            <line x1={padL} y1={y(v)} x2={edgeX} y2={y(v)} stroke="currentColor" opacity="0.06" />
            <text x={w - padR + 36} y={y(v) + 3} textAnchor="end" className="pnl__axis">{`${v.toFixed(guideDecimals)} SOL`}</text>
          </g>
        ))}
        {shadeX < edgeX && <rect x={shadeX} y={padT} width={edgeX - shadeX} height={h - padT - padB} className="pnl__ink-fill" opacity="0.04" />}

        <path d={area} fill={`url(#pnlArea${uid})`} className="pnl__area-in" />
        <path d={line} fill="none" strokeWidth="7" opacity="0.28" filter={`url(#pnlGlow${uid})`} className="pnl__ink-stroke pnl__area-in" />
        <path d={line} fill="none" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" pathLength={1} className="pnl__ink-stroke pnl__line-in" />

        {view.map((p, i) => (
          <circle
            key={i}
            cx={x(p.t)}
            cy={y(p.cumulative)}
            r={hover?.i === i ? rFor(p.amount) + 1 : Math.max(1.6, rFor(p.amount) * 0.55)}
            className={`pnl__dot-in pnl__ink-fill${p.simulated ? " pnl__dot--sim" : ""}${hover?.i === i ? " pnl__dot--hover" : ""}`}
            style={{ animationDelay: `${Math.min(i, 40) * 28}ms`, cursor: p.href ? "pointer" : "default" }}
            onClick={(ev) => { ev.stopPropagation(); openTx(p.href); }}
          >
            <title>{`+${chartSol(p.amount)} SOL ${kindOf(p)} · ${dayClock(p.t)}${p.href ? " · click for the transaction" : ""}`}</title>
          </circle>
        ))}

        <g className="pnl__ping--latest">
          <circle cx={edgeX} cy={prevY} r="4" className="pnl__ink-fill" />
        </g>
        <circle className="pnl__radar pnl__ink-stroke" cx={edgeX} cy={prevY} r="4" fill="none" strokeWidth="1.5" />
        <text x={edgeX + 8} y={prevY + 4} textAnchor="start" className="pnl__ping-label">
          {`+${chartSol(total)} SOL`}
        </text>

        {hover && (
          <g pointerEvents="none">
            <line x1={hover.x} y1={padT} x2={hover.x} y2={h - padB} strokeWidth="1" opacity="0.3" className="pnl__ink-stroke" />
          </g>
        )}
      </svg>
      <span className="pnl__chart-label pnl__chart-label--why">
        every dot is one claim, sized by amount · click a dot for its transaction{anySim ? " · simulated claims are drawn hollow" : ""}
      </span>
      <span className="pnl__chart-label">
        last 24h: {plural(claims24, "claim")}, {plusFee(last24)}
        {feesUnclaimed > 0 ? ` · ${feeSol(feesUnclaimed)} waiting inside open bands` : ""}
      </span>
    </div>
  );
}

/* ---------- the daily record ---------- */

/**
 * The consistency board: one row per day the journal has seen. The honest
 * pitch in one table: fees are income and only go up, the book breathes, and
 * red is printed as plainly as green.
 */
function ConsistencyBoard({ days, feesRealized, solPriceUsd }: { days: DayRow[]; feesRealized: number; solPriceUsd: number | null }) {
  const dayLabel = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString([], { month: "short", day: "numeric" });
  const shown = days.slice(-14);
  const best = days.reduce((a, d) => (d.fees > a.fees ? d : a), days[0]);
  const worst = days.reduce((a, d) => (d.close - d.open < a.close - a.open ? d : a), days[0]);
  const worstMove = worst.close - worst.open;
  return (
    <div className="pnl__board">
      <div className="pnl__chart-head">
        <span className="pnl__chart-eyebrow">The daily record</span>
        <span className="pnl__chart-substat">
          {plural(days.length, "day")} on record · {feeSol(feesRealized)}{usdShadow(feesRealized, solPriceUsd)} fees · best day {dayLabel(best.date)}{" "}
          {plusFee(best.fees)} · worst day {dayLabel(worst.date)}{" "}
          <span className={worstMove < 0 ? "pnl__board-down" : "pnl__board-up"}>{signedSol(worstMove)}</span> on the book
        </span>
      </div>
      <div className="pnl__board-scroll">
        <table className="pnl__board-table">
          <thead>
            <tr>
              <th>day</th>
              <th>fees earned (SOL)</th>
              <th>book open → close (SOL)</th>
              <th>moves</th>
              <th>vetoed</th>
              <th>overrides</th>
              <th>holds</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((d) => {
              const delta = d.close - d.open;
              return (
                <tr key={d.date}>
                  <td>{dayLabel(d.date)}</td>
                  <td className={d.fees > 0 ? "pnl__board-fees" : "pnl__board-dim"}>{d.fees > 0 ? plusFee(d.fees) : "0"}</td>
                  <td>
                    {d.open.toFixed(4)} → {d.close.toFixed(4)}{" "}
                    <span className={delta < 0 ? "pnl__board-down" : delta > 0 ? "pnl__board-up" : "pnl__board-dim"}>({fmtSigned(delta)})</span>
                  </td>
                  <td>{d.moves}</td>
                  <td>{d.vetoed}</td>
                  <td>{d.overrides}</td>
                  <td>{d.holds}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <span className="pnl__chart-label pnl__chart-label--why">
        days roll at midnight UTC.
      </span>
    </div>
  );
}
