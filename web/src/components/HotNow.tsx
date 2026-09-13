/**
 * "Hot right now": the hot watch's top ten as cards. Each card is one pool: what a dollar in it
 * earned in the last hour, the daily pace that implies, how much faster the hour ran than the day,
 * and the brakes (flags, SURGE). Loads /api/hot itself and refreshes on the watch's own cadence,
 * or takes a `hot` prop. Renders nothing until there is a tick. The integrator mounts it in App.tsx.
 */
import { useEffect, useState } from "react";
import { loadHot } from "../api";
import { ago, fmtUsd } from "../format";
import { useReveal } from "../hooks/useReveal";
import type { HotFile, HotRow } from "../types";
import "./HotNow.css";

const TOP = 10;

/** Venue names for the tag; anything else shows the source's id verbatim. */
const VENUE_TAG: Record<string, string> = {
  "meteora-dlmm": "Meteora",
  "meteora-damm-v2": "Meteora DAMM",
  "raydium-clmm": "Raydium",
  "raydium-cpmm": "Raydium CPMM",
  raydium: "Raydium AMM",
  "orca-whirlpool": "Orca",
  pumpswap: "PumpSwap",
};
const venueTag = (v: string) => VENUE_TAG[v] ?? v;
const venueClass = (v: string) => (v === "meteora-dlmm" ? "meteora" : v.startsWith("raydium") ? "raydium" : v === "orca-whirlpool" ? "orca" : "other");

/** What each hot flag means, in plain words. */
export const HOT_FLAG_GLOSS: Record<string, string> = {
  new: "new: the pool is under 12 hours old, so the hour's numbers have little behind them; kept off the tradable list",
  dumping: "dumping: most of the hour's trades were sells and the price fell",
  wild: "wild: the price moved more than 15% in the last hour",
  fading: "fading: the last five minutes were near silent after a busy hour",
  "fee-unknown": "fee unknown: nobody reported this pool's fee, so it is ordered by turnover alone",
};

const pct = (n: number | null, d = 2) => (n === null ? "n/a" : `${n.toFixed(d)}%`);
const signed = (n: number | null, d = 1) => (n === null ? "n/a" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(d)}%`);
const mult = (n: number | null) => (n === null ? "n/a" : `${n.toFixed(1)}×`);

function poolUrl(r: HotRow): string {
  switch (r.venue) {
    case "meteora-dlmm":
      return `https://app.meteora.ag/dlmm/${r.address}`;
    case "raydium-clmm":
      return `https://raydium.io/clmm/create-position/?pool_id=${r.address}`;
    case "orca-whirlpool":
      return `https://www.orca.so/pools/${r.address}`;
    default:
      return `https://dexscreener.com/solana/${r.address}`;
  }
}

export interface HotNowProps {
  /** a loaded tick; when absent the strip loads /api/hot itself */
  hot?: HotFile | null;
  /** seconds between refreshes when self-loading (default 120, the watch's own cadence) */
  refreshSec?: number;
  now?: number;
}

export function HotNow({ hot: given, refreshSec = 120, now }: HotNowProps) {
  const ref = useReveal<HTMLElement>();
  const [loaded, setLoaded] = useState<HotFile | null>(null);
  const selfLoad = given === undefined;

  useEffect(() => {
    if (!selfLoad) return;
    let alive = true;
    const pull = async () => {
      const h = await loadHot();
      if (alive && h) setLoaded(h);
    };
    void pull();
    const id = window.setInterval(() => void pull(), Math.max(15, refreshSec) * 1000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [selfLoad, refreshSec]);

  const hot = selfLoad ? loaded : given;
  if (!hot || hot.rows.length === 0) return null;
  const rows = hot.rows.slice(0, TOP);
  const surges = hot.rows.filter((r) => r.surge).length;
  const at = now ?? Date.now();

  return (
    <section className="hot reveal" id="hot" ref={ref} aria-label="Hot right now">
      <div className="hot__head r-item">
        <div>
          <span className="eyebrow">Hot right now · every 2 minutes · last tick {ago(hot.generatedAt, at)}</span>
          <h2 className="hot__title">Where the fees are this hour.</h2>
        </div>
        <p className="hot__sub">
          The screener ranks a day; this watches the hour. Volume from the last five and sixty minutes, fee yield per dollar of liquidity, the pools running ahead of their own daily pace.
          {surges > 0 && (
            <>
              {" "}
              <b>{surges} surge{surges === 1 ? "" : "s"}</b> on the tape.
            </>
          )}
        </p>
      </div>

      <ol className="hot__grid r-item">
        {rows.map((r, i) => {
          const daily = r.feeToTvlDailyPct;
          const move = r.priceChange1hPct;
          return (
            <li className={`hot__card${r.surge ? " hot__card--surge" : ""}`} key={`${r.venue}:${r.address}`}>
              <div className="hot__card-top">
                <span className="hot__rank">{i + 1}</span>
                <a className="hot__name" href={poolUrl(r)} target="_blank" rel="noreferrer" title={r.address}>
                  {r.name}
                </a>
                <span className={`hot__venue hot__venue--${venueClass(r.venue)}`}>{venueTag(r.venue)}</span>
                {r.surge && (
                  <span className="hot__surge" title={r.surgeAt ? `surge fired ${ago(r.surgeAt, at)}` : "surge"}>
                    SURGE
                  </span>
                )}
              </div>

              <div className="hot__yield">
                <span className="hot__yield-value" title="fee yield last hour: what a dollar in the pool earned in the last 60 minutes">
                  {r.feeToTvl1hPct === null ? <span className="hot__na">fee n/a</span> : pct(r.feeToTvl1hPct, 3)}
                </span>
                <span className="hot__yield-label">
                  {r.feeToTvl1hPct === null ? (
                    <>
                      turnover <b>{mult(r.turnover1h)}</b> of the pool this hour
                    </>
                  ) : (
                    <>
                      last hour · <b>{pct(daily, 1)}</b> a day at this pace
                    </>
                  )}
                </span>
              </div>

              <dl className="hot__stats">
                <div>
                  <dt>Liquidity</dt>
                  <dd>{fmtUsd(r.liquidityUsd)}</dd>
                </div>
                <div>
                  <dt>Vol 1h</dt>
                  <dd>{fmtUsd(r.vol1hUsd)}</dd>
                </div>
                <div title="acceleration: the last hour against the day's hourly pace; 1× is steady">
                  <dt>Accel</dt>
                  <dd className={r.acceleration !== null && r.acceleration >= 2 ? "pos" : ""}>{mult(r.acceleration)}</dd>
                </div>
                <div title="fee traders pay in this pool">
                  <dt>Fee</dt>
                  <dd>{r.feePct === null ? "n/a" : pct(r.feePct, 2)}</dd>
                </div>
                <div title="share of the hour's trades that were sells">
                  <dt>Sells 1h</dt>
                  <dd>{r.sellShare1h === null ? "n/a" : `${Math.round(r.sellShare1h * 100)}%`}</dd>
                </div>
                <div title="price move over the last hour">
                  <dt>1h</dt>
                  <dd className={move === null ? "" : move >= 0 ? "pos" : "neg"}>{signed(move)}</dd>
                </div>
              </dl>

              {r.flags.length > 0 && (
                <div className="hot__flags">
                  {r.flags.map((f) => (
                    <span className={`hot__flag hot__flag--${f}`} key={f} title={HOT_FLAG_GLOSS[f] ?? f}>
                      {f}
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <p className="hot__gloss r-item">
        <b>Fee yield last hour</b>: what a dollar in the pool earned in the last 60 minutes; the <b>daily pace</b> is that times 24. <b>Accel</b> is the hour against the day's hourly pace. Flags: <b>new</b> = under 12 hours old, kept off the tradable list · <b>dumping</b> = mostly sells and a falling price · <b>wild</b> = more than 15% moved in the hour · <b>fading</b> = the last five minutes went quiet · <b>fee-unknown</b> = ordered by turnover, nobody reported the fee. <b>SURGE</b> = the daily pace crossed 5% with the hour running at twice the day, or the pool broke into the top ten for the first time in six hours.
      </p>
    </section>
  );
}
