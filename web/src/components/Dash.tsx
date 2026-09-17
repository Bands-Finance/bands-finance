import type { ReactNode } from "react";
import { Logo } from "../brand/Logo";
import { GuillocheRule, Rosette, VignetteRing } from "../brand/Engrave";
import { ago, clock, short } from "../format";
import { type ActionRow, type AgentRecord, type Status } from "../model";
import type { AgentSummary } from "../derive";
import type { Narrative } from "../narrative";
import type { DataStamp } from "../api";
import { num } from "../narrative";
import { PLATFORM_URL } from "../site";
import { BrandFigure } from "./Brand";
import { Marquee } from "./Marquee";
import { motionSystemReduced, setMotionPaused, useMotion } from "../motion";
import "./Dash.css";

/**
 * The dashboard's chrome, printed like a banknote: Mr Bands' live statement of account. The masthead is
 * a note (a generated guilloche frame, the portrait in an oval vignette, the book's value as the
 * denomination over a rosette, microtext along the foot); the figures are a statement with dotted
 * leaders and a stamp; a ticker tape of his last moves runs under the nav; sections open with a braided
 * rule and a plate number. Every figure is the Record's or the summary's, restated; nothing is computed here.
 */

const MODE_WORD: Record<Status["mode"], string> = { live: "live on Solana", paper: "paper trading", "dry-run": "rehearsal", demo: "demo" };

/* ---------- the nav ---------- */

export interface DashNavProps {
  status: Status;
  agentName: string;
}

const SECTIONS: { id: string; label: string }[] = [
  { id: "lays", label: "How he works" },
  { id: "made", label: "What he made" },
  { id: "holds", label: "What he holds" },
  { id: "did", label: "What he did" },
];

export function DashNav({ status, agentName }: DashNavProps) {
  return (
    <header className="dash-nav dash-nav--float" role="banner">
      <div className="dash-nav__bar">
      <a className="dash-nav__brand" href="#top" aria-label={`${agentName}, top of page`}>
        <Logo size={26} />
        <span className="dash-nav__name engrave">{agentName}</span>
      </a>
      <nav className="dash-nav__links engrave" aria-label="Sections">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`}>
            {s.label}
          </a>
        ))}
        <a href={`${PLATFORM_URL}/#/learn`} target="_blank" rel="noreferrer">
          How it works ↗
        </a>
      </nav>
      <span className={`dash-nav__mode engrave dash-nav__mode--${status.mode}`} title={status.sentence}>
        <i aria-hidden="true" /> {MODE_WORD[status.mode]}
      </span>
      </div>
    </header>
  );
}

/* ---------- the ticker tape: his last moves, always drifting, hurried by the reader's scroll ---------- */

const VERB: Record<string, string> = { OPEN_POSITION: "Opened", CLOSE_POSITION: "Closed", REBALANCE: "Moved", CLAIM_FEES: "Claimed" };

export function TickerTape({ actions, agentName }: { actions: ActionRow[]; agentName: string }) {
  const rows = actions.slice(0, 16);
  if (rows.length === 0) return null;
  return (
    <div className="tape" aria-label={`${agentName}'s latest moves`}>
      <Marquee speed={32} scrollBoost={4} label="Latest moves">
        {rows.map((a) => (
          <span className="tape__item engrave" key={a.id}>
            <span className="tape__time">{clock(a.ts)}</span>
            <span className="tape__verb">{VERB[a.action] ?? a.action}</span>
            <span className="tape__pool">{a.poolLabel}</span>
            {a.resultSol !== null && <span className={`tape__sol${a.resultSol >= 0 ? " tape__sol--up" : " tape__sol--down"}`}>{`${a.resultSol >= 0 ? "+" : "−"}${Math.abs(a.resultSol).toFixed(2)} SOL`}</span>}
            <span className="tape__sep" aria-hidden="true">◆</span>
          </span>
        ))}
      </Marquee>
    </div>
  );
}

/* ---------- the note: the masthead ---------- */

export interface DashNoteProps {
  narrative: Narrative;
  record: AgentRecord | null;
  summary: AgentSummary | null;
  solPriceUsd: number | null;
  status: Status;
  walletAddress: string | null;
  agentName: string;
  now: number;
  /** where the page's data came from and when that source was written */
  stamp?: DataStamp;
}

/** "live, written 40 sec ago" / "a snapshot from 17 min ago": the page says how fresh it is. */
const stampWord = (stamp: DataStamp | undefined, now: number): string | null => {
  if (!stamp || stamp.source === "embedded") return null;
  const age = stamp.generatedAt ? ago(stamp.generatedAt, now) : null;
  if (stamp.source === "live") return age ? `live, written ${age}` : "live";
  if (stamp.source === "api") return age ? `the desk's own server, ${age}` : "the desk's own server";
  return age ? `a snapshot from ${age}` : "a snapshot";
};

const usd = (sol: number, px: number | null): string | null => {
  if (px === null || !Number.isFinite(px) || px <= 0) return null;
  const v = sol * px;
  return `${v < 0 ? "−" : ""}$${Math.round(Math.abs(v)).toLocaleString()}`;
};
const dateWord = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const longDate = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
const MICRO = "EVERY MOVE PUBLISHED AS IT HAPPENED · INCLUDING THE ONES THAT LOST · LIQUIDITY IN BETWEEN · ";

export function DashNote({ narrative, record, summary, solPriceUsd, status, walletAddress, agentName, now, stamp }: DashNoteProps) {
  const live = status.mode === "live";
  const fees = record ? record.feesRealized + record.feesUnclaimed : null;
  const rows: { label: string; value: ReactNode }[] = [
    { label: "The book", value: record ? <>{num(record.equityNow)} SOL{usd(record.equityNow, solPriceUsd) ? <span className="dash-ledger__aside"> ≈ {usd(record.equityNow, solPriceUsd)}</span> : null}</> : "·" },
    { label: "At work", value: record ? `${num(record.atWork)} SOL` : "·" },
    { label: "Fees earned", value: fees !== null ? `${num(fees)} SOL` : "·" },
    { label: "Started with", value: record ? `${num(record.startEquity)} SOL, ${dateWord(record.startTs)}` : "·" },
    { label: "Bands", value: summary ? `${summary.bandsOpen} open, ${summary.bandsInRange} in range` : "·" },
    { label: "Decisions", value: record ? `${record.counts.decisions.toLocaleString()}, ${record.counts.holds.toLocaleString()} of them holds` : "·" },
    { label: "Last decision", value: status.lastTs ? ago(status.lastTs, now) : "none yet" },
    ...(stampWord(stamp, now) ? [{ label: "This page", value: stampWord(stamp, now)! }] : []),
  ];
  const tone = record ? (record.net >= 0.05 ? "up" : record.net <= -0.05 ? "down" : "flat") : "flat";
  return (
    <section className="banknote" id="top" aria-label={`${agentName}, how it's going`}>
      <div className="banknote__frame">
        <GuillocheRule className="banknote__braid banknote__braid--top" height={16} />
        <div className="banknote__topline engrave">
          <span>{agentName}</span>
          <span className="banknote__topmid">Market maker on Solana</span>
          <span>
            {walletAddress ? (
              <a href={`https://solscan.io/account/${walletAddress}`} target="_blank" rel="noreferrer" title="his wallet on Solscan">
                No. {short(walletAddress)}
              </a>
            ) : (
              longDate(now)
            )}
          </span>
        </div>
        <div className="banknote__body">
          <div className="vignette" aria-hidden="true">
            <Rosette className="vignette__rosette" size={300} lobes={16} rings={8} />
            <img className="vignette__img" src="/art/brand/portrait-cigar.webp" alt="" width="900" height="900" />
            <VignetteRing />
          </div>
          <div className="banknote__text">
            <p className="banknote__date engrave">{longDate(now)}</p>
            <h2 className={`banknote__headline banknote__headline--${tone}`}>His statement of account.</h2>
            {narrative.story.map((s, i) => (
              <p className="banknote__p" key={i}>
                {s}
                {i === narrative.story.length - 1 && walletAddress && live && (
                  <>
                    {" "}
                    <a href={`https://solscan.io/account/${walletAddress}`} target="_blank" rel="noreferrer">
                      His wallet is {short(walletAddress)}.
                    </a>
                  </>
                )}
              </p>
            ))}
          </div>
          <aside className="dash-ledger" aria-label="The statement">
            <span className={`dash-stamp dash-stamp--${status.mode}`} title={status.sentence} aria-hidden="true">
              {MODE_WORD[status.mode]}
            </span>
            <p className="dash-ledger__title engrave">Statement</p>
            <dl className="dash-ledger__rows">
              {rows.map((r) => (
                <div className="dash-ledger__row" key={r.label}>
                  <dt>{r.label}</dt>
                  <dd>{r.value}</dd>
                </div>
              ))}
            </dl>
          </aside>
        </div>
        {record && (
          <div className="banknote__denom" aria-hidden="true">
            <Rosette className="banknote__denom-rosette" size={150} lobes={12} rings={6} />
            <span className="banknote__denom-num">{record.equityNow.toFixed(1)}</span>
            <span className="banknote__denom-unit engrave">SOL</span>
          </div>
        )}
        <p className="banknote__micro" aria-hidden="true">
          {MICRO.repeat(8)}
        </p>
        <GuillocheRule className="banknote__braid banknote__braid--foot" height={16} />
      </div>
    </section>
  );
}

/* ---------- a section: a braided rule, a plate number, a sentence for a heading ---------- */

export function DashSection({ id, title, sub, plate, children }: { id: string; title?: string; sub?: string; plate?: string; children: ReactNode }) {
  return (
    <section className="dash-sec" id={id}>
      <GuillocheRule className="dash-sec__braid" height={12} />
      {title && (
        <header className="dash-sec__head">
          {plate && <p className="dash-sec__plate engrave">{plate}</p>}
          <h2 className="dash-sec__title">{title}</h2>
          {sub && <p className="dash-sec__sub">{sub}</p>}
        </header>
      )}
      <div className="dash-sec__body">{children}</div>
    </section>
  );
}

/* ---------- footer ---------- */

export function DashFooter({ agentName }: { agentName: string }) {
  const motion = useMotion();
  const system = motionSystemReduced();
  return (
    <footer className="dash-foot">
      <GuillocheRule className="dash-foot__braid" height={14} />
      <div className="dash-foot__row">
        <BrandFigure agentName={agentName} />
        <div className="dash-foot__text">
          <p className="dash-foot__motto engrave">Liquidity in between</p>
          <p className="dash-foot__legal">
            {agentName} is experimental software and trades a wallet of his own. Nothing here is advice, and nothing on this page
            can touch your money. Every move above is published as it happened, including the ones that lost.
          </p>
          <nav className="dash-foot__links engrave" aria-label="Footer">
            <a href={PLATFORM_URL} target="_blank" rel="noreferrer">bands.finance</a>
            <a href={`${PLATFORM_URL}/#/learn`} target="_blank" rel="noreferrer">How it works</a>
            <a href="https://app.meteora.ag" target="_blank" rel="noreferrer">Meteora</a>
            <a href="https://github.com/louz514/bands-finance" target="_blank" rel="noreferrer">The code</a>
          </nav>
          <button type="button" className="dash-foot__motion engrave" aria-pressed={!motion} disabled={system} onClick={() => setMotionPaused(motion)}>
            {system ? "Reduced motion" : motion ? "Pause motion" : "Resume motion"} <span aria-hidden="true">{motion ? "Ⅱ" : "▷"}</span>
          </button>
        </div>
      </div>
    </footer>
  );
}
