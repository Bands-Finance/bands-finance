import { useMemo, useState } from "react";
import type { EquityPoint } from "../derive";
import { clock, fmtSigned, fmtPct } from "../format";
import { useWidth } from "./useSize";

const H = 96;
const M = { top: 10, right: 76, bottom: 6, left: 14 };

export function EquitySpark({ points }: { points: EquityPoint[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hi, setHi] = useState<number | null>(null);
  const W = Math.max(320, width || 640);
  const innerW = W - M.left - M.right;
  const innerH = H - M.top - M.bottom;
  const model = useMemo(() => {
    if (!points.length) return null;
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    const vs = points.map((p) => p.equity);
    let lo = Math.min(...vs);
    let hi_ = Math.max(...vs);
    const pad = (hi_ - lo || lo * 0.01) * 0.15;
    lo -= pad;
    hi_ += pad;
    const x = (t: number) => M.left + (t1 > t0 ? ((t - t0) / (t1 - t0)) * innerW : innerW / 2);
    const y = (v: number) => M.top + (1 - (v - lo) / (hi_ - lo)) * innerH;
    const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.equity).toFixed(1)}`).join(" ");
    const area = `${line} L${x(t1).toFixed(1)} ${(H - M.bottom).toFixed(1)} L${x(t0).toFixed(1)} ${(H - M.bottom).toFixed(1)} Z`;
    return { x, y, line, area, start: points[0].equity };
  }, [points, innerW, innerH]);
  if (!model) return null;
  const { x, y, line, area, start } = model;
  const last = points[points.length - 1];
  const hp = hi !== null ? points[hi] : null;
  const delta = last.equity - start;
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
  return (
    <section className="panel area-spark" aria-label="Equity">
      <div className="panel-head">
        <h2 className="panel-title">Equity in SOL</h2>
        <div className="panel-meta">
          {fmtSigned(delta)} SOL ({fmtPct(start > 0 ? (delta / start) * 100 : 0, 2)}) since cycle 1
        </div>
      </div>
      <div className="chart-wrap" ref={ref}>
        <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} width={W} height={H} onPointerMove={onMove} onPointerLeave={() => setHi(null)} role="img" aria-label="Equity over time">
          <line x1={M.left} x2={W - M.right} y1={y(start)} y2={y(start)} stroke="var(--line-2)" strokeWidth={1} />
          <path d={area} fill="var(--accent)" fillOpacity={0.1} />
          <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={x(last.t)} cy={y(last.equity)} r={4} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
          <text x={x(last.t) + 10} y={y(last.equity) + 4} style={{ fill: "var(--ink)" }}>{last.equity.toFixed(4)}</text>
          {hp && (
            <g>
              <line x1={x(hp.t)} x2={x(hp.t)} y1={M.top} y2={H - M.bottom} stroke="var(--line-2)" strokeWidth={1} />
              <circle cx={x(hp.t)} cy={y(hp.equity)} r={5} fill="none" stroke="var(--ink)" strokeWidth={1.5} />
            </g>
          )}
        </svg>
        {hp && (
          <div className="tooltip" style={{ top: 4, left: x(hp.t) / W > 0.6 ? undefined : `calc(${(x(hp.t) / W) * 100}% + 14px)`, right: x(hp.t) / W > 0.6 ? `calc(${(1 - x(hp.t) / W) * 100}% + 14px)` : undefined, minWidth: 140 }}>
            <div className="tt-time">{clock(hp.t)}</div>
            <div className="tt-row"><span>equity</span><b>{hp.equity.toFixed(4)} SOL</b></div>
          </div>
        )}
      </div>
    </section>
  );
}
