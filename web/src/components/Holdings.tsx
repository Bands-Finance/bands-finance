import type { BandCard, Book as BookModel, PoolFlow, Status } from "../model";
import type { ScreenResult, StockTag } from "../types";
import { ago, duration, fmtPrice } from "../format";
import { num } from "../narrative";
import { Rosette } from "../brand/Engrave";
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
          // THE STRAP RULER: a ruler of bins from a little under the band to a little over it, the band as a paper
          // strap across its own bins, and a needle where the price is. Bins rise with the price.
          const outBy = Math.abs(b.binsFromRange);
          const pad = Math.max(2, Math.round(b.widthBins * 0.3), b.inRange ? 0 : Math.min(outBy + 1, b.widthBins * 2));
          const span = b.widthBins + 2 * pad;
          const strapLeft = (pad / span) * 100;
          const strapWidth = (b.widthBins / span) * 100;
          const needleBins = b.inRange ? pad + pos * Math.max(0, b.widthBins - 1) + 0.5 : b.binsFromRange < 0 ? pad - Math.min(outBy, pad - 0.5) + 0.5 : pad + b.widthBins + Math.min(outBy, pad - 0.5) - 0.5;
          const needle = Math.min(99, Math.max(1, (needleBins / span) * 100));
          const offScale = !b.inRange && outBy > pad - 0.5;
          return (
            <article className={`bandnote${b.inRange ? " bandnote--live" : ""}`} key={`${b.poolAddress}|${b.address}`}>
              <Rosette className="bandnote__rosette" size={260} lobes={18} rings={7} />
              <header className="bandnote__head">
                <div className="bandnote__name">
                  <span className="bandnote__base">{base}</span>
                  <span className="bandnote__quote engrave">/ {quote}</span>
                </div>
                <span className={`bandnote__state engrave bandnote__state--${st.tone}`}>{st.word}</span>
              </header>
              <p className="bandnote__pair engrave">
                {stock ? (
                  <>
                    Paired with {stock.ticker}
                    {ISSUER[stock.issuer] ? ` · ${ISSUER[stock.issuer]}` : ""}
                  </>
                ) : (
                  <>
                    Meteora DLMM · {b.widthBins} bins · {b.side}
                  </>
                )}
              </p>

              <div className="strapline" title={`${fmtPrice(b.lowerPrice)} to ${fmtPrice(b.upperPrice)} ${b.priceLabel}; now ${fmtPrice(b.activePrice)}`}>
                <div className="strapline__ruler" style={{ backgroundSize: `${100 / span}% 100%` }} aria-hidden="true" />
                <div className="strapline__strap" style={{ left: `${strapLeft}%`, width: `${strapWidth}%` }}>
                  <span className="engrave">{b.putIn !== null ? `${num(b.putIn)} SOL` : `${b.widthBins} bins`}</span>
                </div>
                <div className={`strapline__needle${b.inRange ? "" : " strapline__needle--out"}`} style={{ left: `${needle}%` }}>
                  <span className="strapline__price">{offScale ? `${outBy} bins ${b.binsFromRange < 0 ? "under" : "over"}` : fmtPrice(b.activePrice)}</span>
                </div>
                <span className="strapline__lo">{fmtPrice(b.lowerPrice)}</span>
                <span className="strapline__hi">{fmtPrice(b.upperPrice)}</span>
              </div>

              <div className="bandnote__figs">
                <div className="bandnote__fig">
                  <span className="bandnote__label engrave">Fees earned</span>
                  <span className={`bandnote__big${b.fees > 0 ? " bandnote__big--good" : ""}`}>{b.fees < 0.00005 ? "0" : `+${num(b.fees)}`}<small> SOL</small></span>
                </div>
                <div className="bandnote__fig">
                  <span className="bandnote__label engrave">Worth now</span>
                  <span className="bandnote__big">{num(b.worthNow)}<small> SOL</small></span>
                  {move !== null && <span className={`bandnote__move ${move >= 0 ? "hold__up" : "hold__down"}`}>{signed(move)} from the market</span>}
                </div>
              </div>
              {(() => {
                const pf = flows?.get(b.poolAddress);
                if (!pf) return null;
                const f = pf.flow;
                const q = f.quoteSymbol;
                const age = Math.max(0, Math.round((now - f.asOf) / 60_000));
                return (
                  <p className="bandnote__flow" title="Read from the chain by the flow scout, from the pool's own account">
                    In the last hour the pool paid {num(f.fees60mQuote)} {q} in fees
                    {f.feesPerDayQuote60m !== null ? <>, a pace of {num(f.feesPerDayQuote60m)} {q} a day</> : null}
                    {f.fees15mQuote > 0 ? <>; {num(f.fees15mQuote)} {q} of it in the last fifteen minutes</> : <>; quiet in the last fifteen minutes</>}
                    <span className="bandnote__age"> · read {age === 0 ? "just now" : `${age} min ago`}</span>
                  </p>
                );
              })()}
              <footer className="bandnote__foot engrave">
                {b.openedAt !== null && <span>Open {duration(now - b.openedAt)}</span>}
                <span>±{(b.widthPct / 2).toFixed(1)}%</span>
                <a href={`https://solscan.io/account/${b.address}`} target="_blank" rel="noreferrer" title="the position on Solscan">
                  No. {b.address.slice(0, 4)}…{b.address.slice(-4)}
                </a>
              </footer>
            </article>
          );
        })}
      </div>
    </div>
  );
}
