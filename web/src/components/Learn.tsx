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
        <T t="A pool is a pot of two tokens that anyone can trade against. The people who fill the pot are paid a cut of every trade.">pool</T>: a pot of the token and{" "}
        <T t="SOL is Solana's own coin. It pays for transactions and is the money side of most pools Mr Bands works; some are paired with USDC, a dollar token, instead.">SOL</T> that anyone can swap against. Whoever puts money in the pot earns a cut of every trade. That is the whole business. Not guessing where the price goes; being there when trades happen.
      </>
    ),
  },
  {
    n: "02",
    title: "He picks where to stand.",
    body: (
      <>
        Most pools pay too little for the risk. Every half hour Mr Bands reads every pool on the chain, well over 150,000 of them, keeps up to 1,500 of the busiest from the last day, and ranks them by fees earned per dollar of{" "}
        <T t="Liquidity is the money sitting in a pool, ready to be traded against.">liquidity</T>, marked down for being{" "}
        <T t="Thin: under about $20k of money in the pool. A few trades can move it a long way.">thin</T>,{" "}
        <T t="Brand new: under 24 hours old. No track record, and most new pools die within the day.">brand new</T>,{" "}
        <T t="Wild: the price swung hard in the last day, which is when a narrow band gets left behind.">wild</T>, or{" "}
        <T t="One-sided: almost all the money sits on one side of the price, so trades in one direction find nothing to trade against.">one-sided</T>. He works only a few at a time: the guards cap how many. Tokenized stocks are one part of his book, not all of it: up to 3 of his 6 paper seats go to stocks such as NVDAx, PLTRx or MU, where he lays both sides of the price and hedges the stock half short on Backpack's stock perps where one is listed. The rest go to the pools he ranks best.
      </>
    ),
  },
  {
    n: "03",
    title: "He stands in a narrow band.",
    body: (
      <>
        On{" "}
        <T t="Meteora is an exchange on Solana. DLMM is its pool design: the money sits in small price steps called bins instead of being spread across every price.">Meteora DLMM</T>, price is cut into small steps called bins. Instead of spreading money across every price, Mr Bands stacks it in a band right around today's price, from a few bins to a few dozen wide, sized to how far the price has been moving and never wider than the guards allow. Narrow means a bigger share of each trade. It also means the price can walk out of the band, and then he earns nothing until it comes back or he moves.
      </>
    ),
  },
  {
    n: "04",
    title: "Most of the time he does nothing.",
    body: (
      <>
        Every 5 minutes he looks at the pool, his bands and his wallet, and proposes one move: open a band, close one, claim fees, move one, or hold. Today his proposals come from his own rulebook; his model takes over as it is switched on. Hold is the default. Moving costs{" "}
        <T t="Rent: a small SOL deposit Solana holds while a band's account exists. It comes back when the band is closed; the transaction fees around it do not.">rent</T> and{" "}
        <T t="Slippage: the gap between the price you expected and the price you actually got, because your own trade moved it.">slippage</T>, so churn loses money.
      </>
    ),
  },
  {
    n: "05",
    title: "Fees are not profit.",
    wide: true,
    body: (
      <>
        A band is not a savings account. When the price falls through a band of SOL, every bin it crosses swaps that SOL for the token, so the band ends up holding the token that is falling. When the price climbs through a band of the token, it sells the token on the way up and misses the rise. Either way the band is worth less than the same money left sitting in the wallet. That gap is{" "}
        <T t="Impermanent loss: what a band gives up against simply holding. It can shrink if the price comes back; once the band is closed, it is permanent.">impermanent loss</T>. The fees can be smaller than it, and on his own real-money run they were: he claimed 7.91 SOL of fees (3.27 of it paid in tokens, valued when claimed) and the book still went from 19.79 to 19.71 SOL. And a band the price has left earns nothing at all until the price comes back or he moves it.
      </>
    ),
  },
  {
    n: "06",
    title: "The guards have the last word.",
    wide: true,
    body: (
      <>
        Mr Bands proposes; the guards decide. Around him sits plain code that cannot be argued with: a cap per band, a cap on total money out, a{" "}
        <T t="Gas reserve: SOL kept back in the wallet so there is always enough to pay for transactions.">gas reserve</T>, a{" "}
        <T t="Stop-loss: a line below what went in. When a band's value, fees aside, falls through it, the guards close the band, whatever he proposed.">stop-loss</T> that forces a band closed once it is down past its line (drawn at random a little under 15% for each band, and tighter for some, so nobody can aim at it; the price can gap past the line between checks, and once it did: one band closed 15.4% down), a daily action cap, a{" "}
        <T t="Cooldown: a minimum wait between one action and the next.">cooldown</T>. When his proposal breaks a rule it is vetoed and he holds. When a band is bleeding, the guards close it whether he likes it or not. Both are printed in the journal.
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
        <span className="learn__flag">New here? Start with this</span>
        <span className="eyebrow learn__eyebrow">How it works · the 2-minute version</span>
        <h1 className="learn__title">How an agent earns fees by standing in the right place.</h1>
        <p className="learn__sub">
          Six ideas. No finance background needed. If you can follow "a shop that earns a cut of every sale that walks past it," you're already there.
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
        <a href="#/">Watch it happen in the journal →</a>
      </div>
    </section>
  );
}
