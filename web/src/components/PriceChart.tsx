import { useMemo, useState } from "react";
import type { SeriesPoint } from "../derive";
import { ticks } from "../derive";
import { ACTION_LABEL, clock, dayClock, fmtPrice } from "../format";
import type { Action, JournalPool } from "../types";
import { useWidth } from "./useSize";

const H = 300;
const M = { top: 16, right: 76, bottom: 28, left: 70 };

/** Marker glyph by action: shape carries identity, gold carries "Mr Bands acted". */
export function Glyph({ action, kind, x, y, size = 6 }: { action: Action; kind: "executed" | "blocked" | "override"; x: number; y: number; size?: number }) {
  const s = size;
  const fill = kind === "override" ? "var(--crit)" : kind === "blocked" ? "none" : "var(--accent)";
  const stroke = kind === "blocked" ? "var(--muted)" : "var(--surface)";
  const common = { fill, stroke, strokeWidth: kind === "blocked" ? 1.5 : 2, strokeLinejoin: "round" as const };
  if (kind === "blocked") return <circle cx={x} cy={y} r={s} {...common} />;
  switch (action) {
    case "OPEN_POSITION":
      return <path d={`M${x} ${y - s} L${x + s} ${y + s} L${x - s} ${y + s} Z`} {...common} />;
    case "CLOSE_POSITION":
      return <path d={`M${x} ${y + s} L${x + s} ${y - s} L${x - s} ${y - s} Z`} {...common} />;
    case "CLAIM_FEES":
      return <path d={`M${x} ${y - s} L${x + s} ${y} L${x} ${y + s} L${x - s} ${y} Z`} {...common} />;
    case "REBALANCE":
      return <rect x={x - s + 1} y={y - s + 1} width={2 * s - 2} height={2 * s - 2} {...common} />;
    default:
      return <circle cx={x} cy={y} r={s} {...common} />;
  }
}

export function PriceChart({ points, pool }: { points: SeriesPoint[]; pool: JournalPool }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  const W = Math.max(320, width || 640);
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;

  const model = useMemo(() => {
    if (points.length === 0) return null;
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    const dt = points.length > 1 ? (t1 - t0) / (points.length - 1) : 60_000;
    const ys: number[] = [];
    for (const p of points) {
      ys.push(p.price);
      for (const b of p.bands) ys.push(b.lower, b.upper);
    }
    let lo = Math.min(...ys);
    let hi_ = Math.max(...ys);
    const pad = (hi_ - lo || lo * 0.02) * 0.08;
    lo -= pad;
    hi_ += pad;
    const x = (t: number) => M.left + (t1 > t0 ? ((t - t0) / (t1 - t0)) * innerW : innerW / 2);
    const y = (v: number) => M.top + (1 - (v - lo) / (hi_ - lo)) * innerH;
    // Run-length group band shading by position address + range so each band is one rect.
    const rects: { x0: number; x1: number; y0: number; y1: number; key: string }[] = [];
    const open = new Map<string, { start: number; lower: number; upper: number }>();
    points.forEach((p, i) => {
      const seen = new Set<string>();
      for (const b of p.bands) {
        seen.add(b.address);
        const cur = open.get(b.address);
        if (!cur || cur.lower !== b.lower || cur.upper !== b.upper) {
          if (cur) rects.push({ x0: x(cur.start), x1: x(p.t), y0: y(cur.upper), y1: y(cur.lower), key: `${b.address}-${cur.start}` });
          open.set(b.address, { start: p.t, lower: b.lower, upper: b.upper });
        }
      }
      for (const [addr, cur] of [...open.entries()]) {
        if (!seen.has(addr)) {
          rects.push({ x0: x(cur.start), x1: x(p.t), y0: y(cur.upper), y1: y(cur.lower), key: `${addr}-${cur.start}` });
          open.delete(addr);
        }
      }
      if (i === points.length - 1) {
        for (const [addr, cur] of open) rects.push({ x0: x(cur.start), x1: x(p.t + dt), y0: y(cur.upper), y1: y(cur.lower), key: `${addr}-${cur.start}` });
      }
    });
    const path = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.price).toFixed(1)}`).join(" ");
    const yTicks = ticks(lo, hi_, 4);
    const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(innerW / 110))));
    const xTicks = points.filter((_, i) => i % every === 0);
    return { x, y, rects, path, yTicks, xTicks, lo, hi: hi_ };
  }, [points, innerW, innerH]);

  if (!model) return null;
  const { x, y, rects, path, yTicks, xTicks } = model;
  const last = points[points.length - 1];
  const hp = hi !== null ? points[hi] : null;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bd = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(x(p.t) - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHi(best);
  };

  const ttLeft = hp ? Math.min(Math.max(x(hp.t) / W, 0), 1) : 0;
  const flip = ttLeft > 0.6;

  return (
    <section className="panel area-chart" aria-label="Price and bands">
      <div className="panel-head">
        <h2 className="panel-title">Price and Mr Bands' bands</h2>
        <div className="panel-meta">
          {pool.priceLabel} · active bin {last.bin}
        </div>
      </div>
      <div className="chart-wrap" ref={ref}>
        <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} width={W} height={H} onPointerMove={onMove} onPointerLeave={() => setHi(null)} role="img" aria-label="Price over time with Mr Bands' band ranges shaded">
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={1} />
              <text x={M.left - 8} y={y(v) + 4} textAnchor="end">{fmtPrice(v)}</text>
            </g>
          ))}
          {xTicks.map((p) => (
            <text key={p.t} x={x(p.t)} y={H - 8} textAnchor="middle">{clock(p.t)}</text>
          ))}
          {rects.map((r) => (
            <g key={r.key}>
              <rect x={r.x0} y={r.y0} width={Math.max(1, r.x1 - r.x0)} height={Math.max(1, r.y1 - r.y0)} fill="var(--accent)" fillOpacity={0.14} />
              <line x1={r.x0} x2={r.x1} y1={r.y0} y2={r.y0} stroke="var(--accent)" strokeOpacity={0.45} strokeWidth={1} />
              <line x1={r.x0} x2={r.x1} y1={r.y1} y2={r.y1} stroke="var(--accent)" strokeOpacity={0.45} strokeWidth={1} />
            </g>
          ))}
          <path d={path} fill="none" stroke="var(--ink)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {points.map((p, i) => p.marker && <Glyph key={i} action={p.marker.action} kind={p.marker.kind} x={x(p.t)} y={y(p.price)} />)}
          <circle cx={x(last.t)} cy={y(last.price)} r={4} fill="var(--ink)" stroke="var(--surface)" strokeWidth={2} />
          <text x={x(last.t) + 10} y={y(last.price) + 4} fill="var(--ink)" style={{ fill: "var(--ink)" }}>{fmtPrice(last.price)}</text>
          {hp && (
            <g>
              <line x1={x(hp.t)} x2={x(hp.t)} y1={M.top} y2={H - M.bottom} stroke="var(--line-2)" strokeWidth={1} />
              <circle cx={x(hp.t)} cy={y(hp.price)} r={5} fill="none" stroke="var(--ink)" strokeWidth={1.5} />
            </g>
          )}
        </svg>
        {hp && (
          <div className="tooltip" style={{ top: 12, left: flip ? undefined : `calc(${ttLeft * 100}% + 14px)`, right: flip ? `calc(${(1 - ttLeft) * 100}% + 14px)` : undefined }}>
            <div className="tt-time">{dayClock(hp.t)} · cycle {hp.entry.cycle}</div>
            <div className="tt-row"><span>price</span><b>{fmtPrice(hp.price)}</b></div>
            <div className="tt-row"><span>active bin</span><b>{hp.bin}</b></div>
            <div className="tt-row"><span>equity</span><b>{hp.equity.toFixed(4)} SOL</b></div>
            <div className="tt-row"><span>bands</span><b>{hp.bands.length ? hp.bands.map((b) => `${fmtPrice(b.lower)}–${fmtPrice(b.upper)}`).join(", ") : "none"}</b></div>
            {hp.marker && (
              <div className="tt-row"><span>{hp.marker.kind === "blocked" ? "blocked" : hp.marker.kind === "override" ? "guard override" : "executed"}</span><b>{ACTION_LABEL[hp.marker.action]}</b></div>
            )}
            <div className="tt-head">“{hp.entry.headline}”</div>
          </div>
        )}
      </div>
      <div className="legend" aria-label="Legend">
        <span><svg viewBox="0 0 14 14"><line x1="0" y1="7" x2="14" y2="7" stroke="var(--ink)" strokeWidth="2" /></svg>price</span>
        <span><svg viewBox="0 0 14 14"><rect x="0" y="3" width="14" height="8" fill="var(--accent)" fillOpacity="0.14" stroke="var(--accent)" strokeOpacity="0.45" /></svg>Mr Bands' band</span>
        <span><svg viewBox="0 0 14 14"><Glyph action="OPEN_POSITION" kind="executed" x={7} y={7} size={5} /></svg>open</span>
        <span><svg viewBox="0 0 14 14"><Glyph action="CLOSE_POSITION" kind="executed" x={7} y={7} size={5} /></svg>close</span>
        <span><svg viewBox="0 0 14 14"><Glyph action="CLAIM_FEES" kind="executed" x={7} y={7} size={5} /></svg>claim</span>
        <span><svg viewBox="0 0 14 14"><Glyph action="REBALANCE" kind="executed" x={7} y={7} size={5} /></svg>rebalance</span>
        <span><svg viewBox="0 0 14 14"><Glyph action="HOLD" kind="blocked" x={7} y={7} size={5} /></svg>blocked by guards</span>
        <span><svg viewBox="0 0 14 14"><Glyph action="CLOSE_POSITION" kind="override" x={7} y={7} size={5} /></svg>guard override</span>
      </div>
    </section>
  );
}
