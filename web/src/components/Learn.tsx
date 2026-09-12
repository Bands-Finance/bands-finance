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
  /** The closing card spans the full row: title on the left, body on the right. */
  wide?: boolean;
}

// The concept layer for newcomers: five plain-language ideas, no finance
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
        <T t="SOL is Solana's own coin. It pays for transactions and is the money side of the pools Mr Bands works.">SOL</T> that anyone can swap against. Whoever puts money in the pot earns a cut of every trade. That is the whole business. Not guessing where the price goes; being there when trades happen.
      </>
    ),
  },
  {
    n: "02",
    title: "He picks where to stand.",
    body: (
      <>
        Most pools pay too little for the risk. Every 15 minutes Mr Bands reads all 157,000 pools on the chain, keeps the 1,500 that actually traded today, and ranks them by fees earned per dollar of{" "}
        <T t="Liquidity is the money sitting in a pool, ready to be traded against.">liquidity</T>, marked down for being{" "}
        <T t="Thin: under about $20k of money in the pool. A few trades can move it a long way.">thin</T>,{" "}
        <T t="Brand new: under 24 hours old. No track record, and most new pools die within the day.">brand new</T>,{" "}
        <T t="Wild: the price swung hard in the last day, which is when a narrow band gets left behind.">wild</T>, or{" "}
        <T t="One-sided: almost all the money sits on one side of the price, so trades in one direction find nothing to trade against.">one-sided</T>. He works at most three at a time.
      </>
    ),
  },
  {
    n: "03",
    title: "He stands in a narrow band.",
    body: (
      <>
        On{" "}
        <T t="Meteora is an exchange on Solana. DLMM is its pool design: the money sits in small price steps called bins instead of being spread across every price.">Meteora DLMM</T>, price is cut into small steps called bins. Instead of spreading money across every price, Mr Bands stacks it in a band of 10 to 30 bins right around today's price. Narrow means more fees per trade. It also means the price can walk out of the band, and then he earns nothing until it comes back or he moves.
      </>
    ),
  },
  {
    n: "04",
    title: "Most of the time he does nothing.",
    body: (
      <>
        Every 5 minutes he looks at the pool, his bands and his wallet, and writes one decision: open a band, close one, claim fees, move one, or hold. Hold is the default. Moving costs{" "}
        <T t="Rent: a small SOL deposit Solana holds while a band's account exists. It comes back when the band is closed; the transaction fees around it do not.">rent</T> and{" "}
        <T t="Slippage: the gap between the price you expected and the price you actually got, because your own trade moved it.">slippage</T>, so churn loses money.
      </>
    ),
  },
  {
    n: "05",
    title: "The guards have the last word.",
    wide: true,
    body: (
      <>
        Mr Bands is an AI. Around him sits plain code that cannot be argued with: a cap per band, a cap on total money out, a{" "}
        <T t="Gas reserve: SOL kept back in the wallet so there is always enough to pay for transactions.">gas reserve</T>, a{" "}
        <T t="Stop-loss: a line below what went in. When a band's value falls through it, the guards close the band, whatever he proposed.">stop-loss</T> that forces a band closed at 15% down, a daily action cap, a{" "}
        <T t="Cooldown: a minimum wait between one action and the next.">cooldown</T>. When his proposal breaks a rule it is vetoed and he holds. When a band is bleeding, the guards close it whether he likes it or not. Both are printed in the journal.
      </>
    ),
  },
];

/**
 * "Learn" — the plain-language explainer for people who came to understand
 * Mr Bands, not to read a table. Five ideas, then two doors: the ranked pools
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
          Five ideas. No finance background needed. If you can follow "a shop that earns a cut of every sale that walks past it," you're already there.
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
