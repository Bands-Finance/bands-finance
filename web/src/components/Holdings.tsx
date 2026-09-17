import type { BandCard, Book as BookModel, PoolFlow, Status } from "../model";
import type { ScreenResult, StockTag } from "../types";
import { ago, duration, fmtPrice } from "../format";
import { num } from "../narrative";
import "./Holdings.css";

/**
 * What he holds, one card per band: the pool as the title, what it is paired with, the two figures
 * that matter (fees earned, worth now), the price bar, and the small facts along the bottom. The
 * numbers are the Book's (src/model.ts bookOf); this file only arranges them.
 */
export interface HoldingsProps {
  book: BookModel;
  screen: ScreenResult | null;
  status: Status;
  now: number;
  agentName: string;
  /** the flow scout's last hour per pool, when the desk journaled it */
  flows?: Map<string, PoolFlow>;
}

const ISSUER: Record<string, string> = { xstocks: "xStocks", backpack: "Backpack", ondo: "Ondo", unknown: "" };

/** "NVDAx/SOL" -> base "NVDAx", quote "SOL"; "SOL/DJT" -> base "DJT", quote "SOL" */
function split(label: string): { base: string; quote: string } {
  const [a, b] = label.split("/");
  if (!b) return { base: label, quote: "" };
  return a === "SOL" || a === "USDC" ? { base: b, quote: a } : { base: a, quote: b };
}

/** The stock behind a band: the journal's own tag when the desk wrote one, else the screen's, else the xStocks naming (NVDAx -> NVDA). */
function stockOf(screen: ScreenResult | null, b: BandCard): StockTag | null {
  if (b.stock) return b.stock;
  const fromScreen = screen?.pools.find((p) => p.address === b.poolAddress)?.stock;
  if (fromScreen) return fromScreen;
  const { base } = split(b.poolLabel);
  const m = /^([A-Z.]{1,6})x$/.exec(base);
  return m ? { ticker: m[1], issuer: "xstocks" } : null;
}

function statusOfBand(b: BandCard): { word: string; tone: "good" | "wait" | "bad" } {
  if (b.inRange) return { word: "earning now", tone: "good" };
  const n = Math.abs(b.binsFromRange);
  return { word: `out by ${n} bin${n === 1 ? "" : "s"}`, tone: n <= 2 ? "wait" : "bad" };
}

const signed = (n: number, d = 2) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(d)}`;

export function Holdings({ book, screen, status, now, agentName, flows }: HoldingsProps) {
  const bands = book.bands;
  if (bands.length === 0) {
    return (
      <p className="hold__flat">
        Flat. No band on the book this minute. {agentName} only opens one when a pool's fees are worth the rent and the risk; until
        then he sits in SOL.
        {book.lastExit ? ` Last exit ${ago(book.lastExit.ts, now)}: “${book.lastExit.headline}”.` : ""}
      </p>
    );
  }
  const asOf = book.asOf !== null ? ago(book.asOf, now) : null;
  return (
    <div className="hold">
      <p className="hold__line">
        {bands.length} band{bands.length === 1 ? "" : "s"} on the book, {bands.filter((b) => b.inRange).length} in range and earning
        {asOf ? `, as of ${asOf}` : ""}.{status.mode !== "live" ? " Marked to live pool prices; the money is pretend." : ""}
      </p>
      <div className="hold__grid">
        {bands.map((b) => {
          const { base: rawBase, quote } = split(b.poolLabel);
          const stock = stockOf(screen, b);
          // a token the desk names by mint suffix ("MRVL…46jo") reads as its ticker on the card
          const base = rawBase.includes("…") && stock ? stock.ticker : rawBase;
          const st = statusOfBand(b);
          const move = b.marketMove;
          const pos = b.upperPrice > b.lowerPrice ? Math.min(1, Math.max(0, (b.activePrice - b.lowerPrice) / (b.upperPrice - b.lowerPrice))) : 0.5;
          return (
            <article className="hold__card" key={`${b.poolAddress}|${b.address}`}>
              <header className="hold__head">
                <div className="hold__name">
                  <span className="hold__base">{base}</span>
                  <span className="hold__quote">/ {quote}</span>
                </div>
                <span className={`hold__pill hold__pill--${st.tone}`}>{st.word}</span>
              </header>
              <p className="hold__pair">
                {stock ? (
                  <>
                    Paired with <b>{stock.ticker}</b>
                    {ISSUER[stock.issuer] ? <span className="hold__issuer"> · {ISSUER[stock.issuer]}</span> : null}
                  </>
                ) : (
                  <>
                    Meteora DLMM, {b.widthBins} bins, {b.side}
                  </>
                )}
              </p>
              <div className="hold__stats">
                <div className="hold__stat">
                  <span className={`hold__big${b.fees > 0 ? " hold__big--good" : ""}`}>{b.fees < 0.00005 ? "0" : `+${num(b.fees)}`}<small> SOL</small></span>
                  <span className="hold__label">Fees earned</span>
                </div>
                <div className="hold__stat">
                  <span className="hold__big">{num(b.worthNow)}<small> SOL</small></span>
                  <span className="hold__label">
                    Worth now{move !== null ? <> · <span className={move >= 0 ? "hold__up" : "hold__down"}>{signed(move)} market</span></> : null}
                  </span>
                </div>
              </div>
              <div className="hold__bar" title={`${fmtPrice(b.lowerPrice)} to ${fmtPrice(b.upperPrice)} ${b.priceLabel}; now ${fmtPrice(b.activePrice)}`}>
                <span className="hold__bar-track" />
                <span className={`hold__bar-dot${b.inRange ? "" : " hold__bar-dot--out"}`} style={{ left: `${pos * 100}%` }} />
                <span className="hold__bar-lo">{fmtPrice(b.lowerPrice)}</span>
                <span className="hold__bar-hi">{fmtPrice(b.upperPrice)}</span>
              </div>
              {(() => {
                const pf = flows?.get(b.poolAddress);
                if (!pf) return null;
                const f = pf.flow;
                const q = f.quoteSymbol;
                const age = Math.max(0, Math.round((now - f.asOf) / 60_000));
                return (
                  <p className="hold__flow" title="Read from the chain by the flow scout: every swap in this pool, decoded from Meteora's own events">
                    <span className="hold__flow-k">Last hour</span> {f.swaps60m} swaps, {num(f.volume60mQuote)} {q} traded, {num(f.fees60mQuote)} {q} in fees
                    {f.feesPerDayQuote60m !== null ? <>, a {num(f.feesPerDayQuote60m)} {q}/day pace</> : null}
                    {f.swaps15m > 0 ? <>. <span className="hold__flow-k">Last 15 min</span> {f.swaps15m} swaps, {num(f.fees15mQuote)} {q} in fees</> : <>. Quiet in the last 15 minutes</>}
                    <span className="hold__flow-age"> · {age === 0 ? "just now" : `${age} min ago`}</span>
                  </p>
                );
              })()}
              <footer className="hold__foot">
                {b.putIn !== null && <span>Put in {num(b.putIn)} SOL</span>}
                {b.pacePerDay !== null && <span>{num(b.pacePerDay)} SOL/day</span>}
                {b.openedAt !== null && <span>Open {duration(now - b.openedAt)}</span>}
                <span>±{(b.widthPct / 2).toFixed(1)}%</span>
              </footer>
            </article>
          );
        })}
      </div>
    </div>
  );
}
