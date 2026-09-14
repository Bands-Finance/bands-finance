import { useEffect, useState } from "react";
import { ACTION_PAST, GLOSS, type BandCard, type Book as BookModel, type Status } from "../model";
import { ago, duration, fmtPrice, fmtSigned, short } from "../format";
import "./LivePositions.css";

/**
 * The Book: every band on the book this second, from the newest cycle in the
 * journal. Ported from Meridian's LivePositions; the RPC cross-checks, the
 * proof endpoint and the record-status hook are gone. Flat is shown as plainly
 * as a band: pretending otherwise is how track records go quiet.
 */
export interface BookProps {
  book: BookModel;
  status: Status;
  agentName: string;
}

const PULSE: Record<Status["mode"], { word: string; cls: string; gloss: string | undefined }> = {
  live: { word: "live", cls: "", gloss: undefined },
  "dry-run": { word: "rehearsal", cls: "livepos__pulse--rehearsal", gloss: GLOSS.dryRun },
  paper: { word: "paper", cls: "livepos__pulse--rehearsal", gloss: GLOSS.paper },
  demo: { word: "demo", cls: "livepos__pulse--demo", gloss: GLOSS.demo },
};

const solFmt = (n: number, d = 4) => `${n.toFixed(d)} SOL`;
const signedSol = (n: number, d = 4) => `${fmtSigned(n, d)} SOL`;
/** Fees start life as dust; show the ticking, never a flat 0.0000. */
const feeSol = (n: number) => (n <= 0 ? "0 SOL" : n < 0.00005 ? "<0.0001 SOL" : solFmt(n));
const plusFee = (n: number) => (n >= 0.00005 ? `+${solFmt(n)}` : feeSol(n));
const pct1 = (v: number) => (Math.abs(v) < 0.05 ? "<0.1" : Math.abs(v).toFixed(1));
const shapeWord = (s: string) => s.toLowerCase().replace(/_/g, "-");

/** A clock that re-renders twice a minute, so "open 12 min" and "as of" tick. */
function useMinuteTick(): number {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  return Date.now();
}

export function Book({ book, status, agentName }: BookProps) {
  const now = useMinuteTick();
  const pulse = PULSE[status.mode];
  const bands = book.bands;
  const waiting = bands.reduce((s, b) => s + b.fees, 0);

  return (
    <section className="livepos" aria-label={`Bands ${agentName} holds right now`}>
      <div className="livepos__head">
        <h2 className="livepos__title">Bands on the book, right now</h2>
        <span className={`livepos__pulse ${pulse.cls}`} title={pulse.gloss}>{pulse.word}</span>
        {book.asOf !== null && <span className="livepos__asof">as of {ago(book.asOf, now)}</span>}
      </div>
      <p className="livepos__gloss">
        // every band {agentName} holds this second, from the newest cycle in the journal · a ‘<span className="term" title={GLOSS.band}>band</span>’ is a slice of
        price he has put SOL into · ‘<span className="term" title={GLOSS.inRange}>in range</span>’ means the current price is inside it, so every trade pays
        him · ‘out by 3 <span className="term" title={GLOSS.bin}>bins</span>’ means the price walked out and it earns nothing until it comes back or he
        moves it
      </p>

      {bands.length === 0 ? (
        <p className="livepos__flat">
          Flat. No band on the book this minute. {agentName} only opens a band when a pool's fees are worth the rent and the risk;
          when they aren't, he sits in SOL and waits.
          {book.lastExit ? ` Last exit: ${ACTION_PAST[book.lastExit.action]} ${ago(book.lastExit.ts, now)}, “${book.lastExit.headline}”.` : ""}
          {" "}Flat is a decision, and you are seeing it unedited.
        </p>
      ) : (
        <div className="livepos__grid">
          {bands.map((b) => (
            <BandStrip key={`${b.poolAddress}|${b.address}`} b={b} now={now} />
          ))}
        </div>
      )}

      {bands.length > 0 && (
        <p className="livepos__foot">
          Each band holds SOL (or the token) in a slice of price, earning the pool's fee on every trade through it while the dot
          stays inside the bar. Below the band, his SOL is slowly swapped into the token as the price falls; above it, the token
          is swapped back to SOL as the price rises. The ledger separates the two forces on the money: what the token's price did
          to what he holds, and what fees earned back. Fees only go up; the market line breathes.
        </p>
      )}
      {bands.length > 0 && waiting > 0 && (
        <p className="livepos__foot">
          <strong>{feeSol(waiting)}</strong> of fees is sitting inside these bands, earned trade by trade and not yet claimed.
          Claiming is one of his decisions; the journal shows when he makes it.
        </p>
      )}
      <p className="livepos__foot">{status.sentence}</p>
    </section>
  );
}

/**
 * One band, one strip: identity, ledger, range. Left to right: what it is,
 * what it is worth and why, where the price sits in the band.
 */
function BandStrip({ b, now }: { b: BandCard; now: number }) {
  // Which side the price walked out on. The journal's bin count is the
  // authority; the price comparison only breaks a tie at the very edge.
  const below = !b.inRange && (b.binsFromRange < 0 || (b.binsFromRange === 0 && b.activePrice < b.lowerPrice));
  const above = !b.inRange && !below;
  const gap = Math.abs(b.binsFromRange);
  const badge = b.inRange
    ? "earning now"
    : gap === 0
      ? "waiting · price just outside"
      : `waiting · price ${gap} bin${gap === 1 ? "" : "s"} ${below ? "below" : "above"}`;

  const width = b.upperPrice - b.lowerPrice;
  const raw = width > 0 ? ((b.activePrice - b.lowerPrice) / width) * 100 : 50;
  const dotPct = below ? 2 : above ? 98 : Math.min(98, Math.max(2, raw));
  const caption = b.inRange
    ? `price can fall ${pct1(b.roomDownPct)}% or rise ${pct1(b.roomUpPct)}% before fees stop`
    : below
      ? `price is ${pct1(b.roomDownPct)}% below the band`
      : `price is ${pct1(b.roomUpPct)}% above the band`;

  const meta = [
    `${b.widthBins} bins wide, about ${b.widthPct.toFixed(1)}% of price`,
    ...(b.side ? [b.side] : []),
    ...(b.strategy ? [`${shapeWord(b.strategy)} shape`] : []),
    `open ${b.openedAt !== null ? duration(Math.max(0, now - b.openedAt)) : "n/a"}`,
  ].join(" · ");

  const mm = b.marketMove;
  const mmCls = mm === null ? "" : mm < 0 ? "livepos__led--down" : "livepos__led--up";

  return (
    <div className="livepos__card livepos__strip">
      <div className="livepos__cell">
        <div className="livepos__row">
          <span className="livepos__sym">
            {b.poolLabel} · band <span title={b.address}>{short(b.address)}</span>
          </span>
          <span className={`livepos__badge ${b.inRange ? "livepos__badge--up" : "livepos__badge--dim"}`}>{badge}</span>
        </div>
        <span className="livepos__meta">{meta}</span>
        <span className="livepos__meta">
          holds {b.holds} · bins {b.lowerBinId}–{b.upperBinId}
        </span>
        <span className="livepos__links">
          <a href={`https://app.meteora.ag/dlmm/${b.poolAddress}`} target="_blank" rel="noreferrer">pool on Meteora ↗</a>
          <a href={`https://solscan.io/account/${b.address}`} target="_blank" rel="noreferrer">band on Solscan ↗</a>
          {b.openTx && (
            <a href={`https://solscan.io/tx/${b.openTx}`} target="_blank" rel="noreferrer">opened in tx ↗</a>
          )}
        </span>
      </div>

      <div className="livepos__cell">
        {/* The ledger: the two forces on the money, separated. Fees are the
            strategy and only go up; the market line is what the token's own
            price did to what he holds. Collapsing them into one number makes
            a working fee engine read as a losing strategy on any red day. */}
        <dl className="livepos__ledger">
          <div>
            <dt>put in</dt>
            <dd>{b.putIn === null ? "n/a" : solFmt(b.putIn)}</dd>
          </div>
          <div>
            <dt>market move</dt>
            <dd className={mmCls}>{mm === null ? "n/a" : signedSol(mm)}</dd>
          </div>
          <div>
            <dt>fees earned</dt>
            <dd className="livepos__led--up">
              {plusFee(b.fees)}
              {b.pacePerDay !== null && b.pacePerDay > 0 && <span className="livepos__led-pace">{feeSol(b.pacePerDay)}/day pace</span>}
            </dd>
          </div>
          <div className="livepos__led-total">
            <dt>worth now</dt>
            <dd>
              {solFmt(b.worthNow)}
              {mm !== null && (
                <span className="livepos__led-net">
                  {" "}(<span className={mmCls}>{signedSol(mm)} market</span>
                  {" · "}
                  <span className="livepos__led--up">{plusFee(b.fees)} fees</span>)
                </span>
              )}
            </dd>
          </div>
        </dl>
      </div>

      <div
        className="livepos__cell livepos__cell--range"
        role="group"
        aria-label={`Band from ${fmtPrice(b.lowerPrice)} to ${fmtPrice(b.upperPrice)} ${b.priceLabel}, price now ${fmtPrice(b.activePrice)}`}
      >
        <div className="livepos__rangebar" aria-hidden="true">
          {below && <span className="livepos__rangearrow livepos__rangearrow--left">←</span>}
          <span className={`livepos__rangedot${b.inRange ? "" : " livepos__rangedot--out"}`} style={{ left: `${dotPct}%` }} />
          {above && <span className="livepos__rangearrow livepos__rangearrow--right">→</span>}
        </div>
        <span className="livepos__rangeends" aria-hidden="true">
          <span>{fmtPrice(b.lowerPrice)}</span>
          <span>now {fmtPrice(b.activePrice)} {b.priceLabel}</span>
          <span>{fmtPrice(b.upperPrice)}</span>
        </span>
        <span className="livepos__rangecap">{caption}</span>
      </div>
    </div>
  );
}
