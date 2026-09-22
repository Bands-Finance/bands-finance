import type { CSSProperties, ReactNode } from "react";
import { useReveal } from "../hooks/useReveal";
import "./Learn.css";

const ri = (n: number) => ({ "--ri": n }) as CSSProperties;

/** A glossed term: dotted underline, the plain-words definition on hover or focus. */
const T = ({ t, children }: { t: string; children: ReactNode }) => (
  <span className="term" title={t} tabIndex={0}>
    {children}
  </span>
);

interface Idea {
  n: string;
  title: string;
  body: ReactNode;
  /** A wide card spans the full row: title on the left, body on the right (the cost of it, and the guards that close). */
  wide?: boolean;
}

// The concept layer for newcomers: six plain-language ideas, no finance
// background required. It teaches the business before the site asks you to
// read a journal or a ranked table.
const IDEAS: Idea[] = [
  {
    n: "01",
    title: "Pools pay people to wait.",
    body: (
      <>
        Every token on Solana trades in a{" "}
        <T t="A pool: a pot of two tokens anyone can trade against.">pool</T>: a pot of the token and{" "}
        <T t="SOL: Solana's own coin, the money side of most pools.">SOL</T> that anyone can swap against. Whoever fills the pot earns a cut of every trade.
      </>
    ),
  },
  {
    n: "02",
    title: "He picks where to stand.",
    body: (
      <>
        Every half hour he ranks every pool on the chain by fees earned per dollar of{" "}
        <T t="Liquidity is the money sitting in a pool, ready to be traded against.">liquidity</T>, marked down for being{" "}
        <T t="Thin: under about $20k in the pool.">thin</T>,{" "}
        <T t="New: under 24 hours old.">new</T>,{" "}
        <T t="Wild: the price swung hard in the last day.">wild</T>, or{" "}
        <T t="One-sided: almost all the money sits on one side of the price.">one-sided</T>. He works a few at a time, and tokenized stocks are one part of his book.
      </>
    ),
  },
  {
    n: "03",
    title: "He stands in a narrow band.",
    body: (
      <>
        On{" "}
        <T t="Meteora is an exchange on Solana; DLMM is its pool design.">Meteora DLMM</T>, price is cut into small steps called bins. He stacks his money in a band of bins around the price: a bigger share of each trade, and nothing while the price is outside it.
      </>
    ),
  },
  {
    n: "04",
    title: "Most of the time he does nothing.",
    body: (
      <>
        Every 5 minutes he proposes one move: open, close, claim fees, move, or hold. Hold is the default, because moving costs{" "}
        <T t="Rent: a SOL deposit Solana holds while a band exists.">rent</T> and{" "}
        <T t="Slippage: the gap between the price expected and the price got.">slippage</T>.
      </>
    ),
  },
  {
    n: "05",
    title: "Fees are not profit.",
    wide: true,
    body: (
      <>
        A band the price falls through ends up holding the token that fell, and that gap against just holding is{" "}
        <T t="Impermanent loss: what a band gives up against simply holding.">impermanent loss</T>. On his real-money run, 17 to 19 Sep, he claimed 7.91 SOL of fees and the book still went from 19.79 to 19.71 SOL.
      </>
    ),
  },
  {
    n: "06",
    title: "The guards have the last word.",
    wide: true,
    body: (
      <>
        He proposes; plain code decides: a cap per band, a cap on money out, a{" "}
        <T t="Gas reserve: SOL kept back for transaction fees.">gas reserve</T>, a{" "}
        <T t="Stop-loss: a band that falls too far below what went in is closed.">stop-loss</T>, a daily action cap, a{" "}
        <T t="Cooldown: a minimum wait between actions.">cooldown</T>. A proposal that breaks a rule is vetoed, a bleeding band is closed, and both are printed in the journal.
      </>
    ),
  },
];

/**
 * "Learn": the plain-language explainer for people who came to understand
 * Mr Bands, not to read a table. Six ideas, then two doors: the ranked pools
 * and the journal where the ideas play out.
 */
export function Learn() {
  const ref = useReveal<HTMLElement>();
  return (
    <section className="learn reveal" id="learn" ref={ref} aria-label="How it works">
      <div className="learn__head r-item" style={ri(0)}>
        <span className="learn__flag">Start here</span>
        <span className="eyebrow learn__eyebrow">How it works</span>
        <h1 className="learn__title">How he earns fees.</h1>
        <p className="learn__sub">
          Six ideas, in plain words.
        </p>
      </div>

      <div className="learn__grid">
        {IDEAS.map((idea, i) => (
          <article className={`learn__card r-item${idea.wide ? " learn__card--wide" : ""}`} style={ri(i + 1)} key={idea.n}>
            <span className="learn__n">{idea.n}</span>
            <h3 className="learn__card-title">{idea.title}</h3>
            <p className="learn__body">{idea.body}</p>
          </article>
        ))}
      </div>

      <div className="learn__foot r-item" style={ri(IDEAS.length + 1)}>
        <a href="#/pools">See every pool ranked →</a>
        <span className="learn__dot">·</span>
        <a href="#/">Watch it in the journal →</a>
      </div>
    </section>
  );
}
