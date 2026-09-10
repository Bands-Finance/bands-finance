import { useState } from "react";
import type { JournalEntry } from "../types";
import { fmtInt, fmtPrice } from "../format";

export function BinLadder({ entry }: { entry: JournalEntry }) {
  const { pool, positions } = entry;
  const [hover, setHover] = useState<number | null>(null);
  const rows = [...pool.bins].sort((a, b) => b.binId - a.binId);
  const solIsY = pool.solSide !== "X";
  const depthSol = (b: (typeof rows)[number]) => (solIsY ? b.yAmount + b.xAmount * pool.price : b.xAmount + (pool.price > 0 ? b.yAmount / pool.price : 0));
  const max = Math.max(1e-9, ...rows.map(depthSol));
  const inBand = (bin: number) => positions.some((p) => bin >= p.lowerBinId && bin <= p.upperBinId);
  const hovered = rows.find((r) => r.binId === hover);
  const top = rows[0]?.binId ?? 0;
  const bottom = rows[rows.length - 1]?.binId ?? 0;
  const offscreen = positions
    .filter((p) => p.upperBinId < bottom || p.lowerBinId > top)
    .map((p) => (p.lowerBinId > top ? `band [${p.lowerBinId}, ${p.upperBinId}] is ${p.lowerBinId - top} bins above this window` : `band [${p.lowerBinId}, ${p.upperBinId}] is ${bottom - p.upperBinId} bins below this window`));

  return (
    <section className="panel area-ladder" aria-label="Bin ladder">
      <div className="panel-head">
        <h2 className="panel-title">The ladder</h2>
        <div className="panel-meta">
          {pool.label} · {pool.binStep} bps bins
        </div>
      </div>
      <div className="ladder-rows" onMouseLeave={() => setHover(null)}>
        <div className="lcap">
          <span>asks · {pool.solSide === "X" ? pool.tokenY.symbol : pool.tokenX.symbol}</span>
          <span>depth in SOL</span>
        </div>
        {rows.map((b) => {
          const w = Math.max(1.5, (depthSol(b) / max) * 100);
          const cls = ["lrow", b.isActive ? "active" : "", inBand(b.binId) ? "in-band" : ""].join(" ");
          return (
            <div key={b.binId} className={cls} onMouseEnter={() => setHover(b.binId)} tabIndex={0} onFocus={() => setHover(b.binId)}>
              <span className="lbin">{b.binId}</span>
              <span className="lprice">{fmtPrice(b.price)}</span>
              <span className="lbar-track">
                <span className="lbar" style={{ width: `${w}%` }} />
                {b.isActive && <span className="lactive-tag">active</span>}
              </span>
            </div>
          );
        })}
        <div className="lcap">
          <span>bids · {pool.solSide === "X" ? pool.tokenX.symbol : pool.tokenY.symbol}</span>
          <span />
        </div>
      </div>
      <div className="ladder-foot">
        {hovered ? (
          <>
            <span className="k">bin {hovered.binId}</span> {fmtPrice(hovered.price)} {pool.priceLabel} · {fmtInt(hovered.xAmount)} {pool.tokenX.symbol} + {hovered.yAmount.toFixed(3)} {pool.tokenY.symbol}
            {inBand(hovered.binId) && <> · <span className="ladder-note">in Mr Bands' band</span></>}
          </>
        ) : offscreen.length ? (
          <span className="ladder-note">{offscreen.join("; ")}</span>
        ) : positions.length ? (
          <>
            <span className="k">gold rows</span> are Mr Bands' band. Hover a bin for depth.
          </>
        ) : (
          <>
            <span className="k">no band on the ladder.</span> Hover a bin for depth.
          </>
        )}
      </div>
    </section>
  );
}
