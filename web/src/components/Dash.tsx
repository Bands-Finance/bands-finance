import type { ReactNode } from "react";
import { Logo } from "../brand/Logo";
import { ago, short } from "../format";
import { type AgentRecord, type Status } from "../model";
import type { AgentSummary } from "../derive";
import type { Narrative } from "../narrative";
import { num } from "../narrative";
import { PLATFORM_URL } from "../site";
import { BrandFigure, BrandPortrait } from "./Brand";
import "./Dash.css";

/**
 * The dashboard's own chrome: paper, ink, one orange strap. A note at the top written from the
 * numbers, a small ledger beside it with the figures, the mode as a stamp. Headings are sentences.
 * Every figure here is the Record's or the summary's, restated; nothing is computed on this page.
 */

const MODE_WORD: Record<Status["mode"], string> = { live: "live on Solana", paper: "paper trading", "dry-run": "rehearsal", demo: "demo" };

/* ---------- the nav ---------- */

export interface DashNavProps {
  status: Status;
  agentName: string;
}

const SECTIONS: { id: string; label: string }[] = [
  { id: "made", label: "What he made" },
  { id: "holds", label: "What he holds" },
  { id: "did", label: "What he did" },
];

export function DashNav({ status, agentName }: DashNavProps) {
  return (
    <header className="dash-nav" role="banner">
      <a className="dash-nav__brand" href="#top" aria-label={`${agentName}, top of page`}>
        <Logo size={26} />
        <span className="dash-nav__name">{agentName}</span>
      </a>
      <nav className="dash-nav__links" aria-label="Sections">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`}>
            {s.label}
          </a>
        ))}
        <a href={`${PLATFORM_URL}/#/learn`} target="_blank" rel="noreferrer">
          How it works ↗
        </a>
      </nav>
      <span className={`dash-nav__mode dash-nav__mode--${status.mode}`} title={status.sentence}>
        {MODE_WORD[status.mode]}
      </span>
    </header>
  );
}

/* ---------- the note: what a person would tell you ---------- */

export interface DashNoteProps {
  narrative: Narrative;
  record: AgentRecord | null;
  summary: AgentSummary | null;
  solPriceUsd: number | null;
  status: Status;
  walletAddress: string | null;
  agentName: string;
  now: number;
}

const usd = (sol: number, px: number | null): string | null => {
  if (px === null || !Number.isFinite(px) || px <= 0) return null;
  const v = sol * px;
  return `${v < 0 ? "−" : ""}$${Math.round(Math.abs(v)).toLocaleString()}`;
};
const dateWord = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export function DashNote({ narrative, record, summary, solPriceUsd, status, walletAddress, agentName, now }: DashNoteProps) {
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
  ];
  const tone = record ? (record.net >= 0.05 ? "up" : record.net <= -0.05 ? "down" : "flat") : "flat";
  return (
    <section className="dash-note" id="top" aria-label={`${agentName}, how it's going`}>
      <div className="dash-note__text">
        <h1 className={`dash-note__headline dash-note__headline--${tone}`}>{narrative.headline}</h1>
        {narrative.story.map((s, i) => (
          <p className="dash-note__p" key={i}>
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
      <aside className="dash-side">
      <BrandPortrait agentName={agentName} />
      <div className="dash-ledger" aria-label="The figures">
        <span className={`dash-stamp dash-stamp--${status.mode}`} title={status.sentence} aria-hidden="true">
          {MODE_WORD[status.mode]}
        </span>
        <dl className="dash-ledger__rows">
          {rows.map((r) => (
            <div className="dash-ledger__row" key={r.label}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      </aside>
    </section>
  );
}

/* ---------- a section: a sentence for a heading ---------- */

export function DashSection({ id, title, sub, children }: { id: string; title?: string; sub?: string; children: ReactNode }) {
  return (
    <section className="dash-sec" id={id}>
      {title && (
        <header className="dash-sec__head">
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
  return (
    <footer className="dash-foot">
      <div className="dash-foot__row">
        <BrandFigure agentName={agentName} />
        <div className="dash-foot__text">
          <p className="dash-foot__motto">Liquidity in between.</p>
          <p className="dash-foot__legal">
            {agentName} is experimental software and trades a wallet of his own. Nothing here is advice, and nothing on this page
            can touch your money. Every move above is published as it happened, including the ones that lost.
          </p>
        </div>
      </div>
      <nav className="dash-foot__links" aria-label="Footer">
        <a href={PLATFORM_URL} target="_blank" rel="noreferrer">bands.finance</a>
        <a href={`${PLATFORM_URL}/#/learn`} target="_blank" rel="noreferrer">How it works</a>
        <a href="https://app.meteora.ag" target="_blank" rel="noreferrer">Meteora</a>
        <a href="https://github.com/louz514/bands-finance" target="_blank" rel="noreferrer">The code</a>
      </nav>
    </footer>
  );
}
