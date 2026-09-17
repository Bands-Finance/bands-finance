import type { CSSProperties, ReactNode } from "react";
import { Wordmark } from "../brand/Logo";
import { useReveal } from "../hooks/useReveal";
import { ago, fmtPct, short } from "../format";
import { GLOSS, type AgentRecord, type Status } from "../model";
import type { AgentSummary } from "../derive";
import { PLATFORM_URL } from "../site";
import "./Dash.css";

/**
 * The dashboard's own chrome. One rule, borrowed from the pages that feel clean: one thing per
 * screen. The first screen is a single number at poster scale (the net result since the run began)
 * with everything else in one dim mono line under it; every label on the page is the same tiny mono
 * uppercase; the atmosphere (grain, a vignette, a faint grid) does the rest. Every figure here is
 * the Record's or the summary's, restated; nothing is computed on this page.
 */

const MODE_WORD: Record<Status["mode"], string> = { live: "live on Solana", paper: "paper trading", "dry-run": "rehearsal", demo: "demo" };
const ri = (n: number) => ({ "--ri": n }) as CSSProperties;

/* ---------- atmosphere: fixed layers behind everything ---------- */

export function DashAtmosphere() {
  return (
    <div className="dash-atmo" aria-hidden="true">
      <div className="dash-atmo__grid" />
      <div className="dash-atmo__glow" />
      <div className="dash-atmo__vignette" />
      <div className="dash-atmo__grain" />
    </div>
  );
}

/* ---------- the nav: tiny mono, one highlighted item ---------- */

export interface DashNavProps {
  status: Status;
  agentName: string;
}

const SECTIONS: { id: string; label: string }[] = [
  { id: "record", label: "record" },
  { id: "bands", label: "bands" },
  { id: "desk", label: "desk" },
  { id: "guards", label: "guards" },
];

export function DashNav({ status, agentName }: DashNavProps) {
  return (
    <header className="dash-nav" role="banner">
      <a className="dash-nav__brand" href="#top" aria-label={`${agentName}, top of page`}>
        <Wordmark size={15} />
        <span className="dash-nav__name">{agentName}</span>
      </a>
      <nav className="dash-nav__links" aria-label="Sections">
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`}>
            {s.label}
          </a>
        ))}
        <a href={`${PLATFORM_URL}/#/learn`} target="_blank" rel="noreferrer">
          how it works ↗
        </a>
      </nav>
      <span className={`dash-nav__mode dash-nav__mode--${status.mode}`} title={status.sentence}>
        <span className="dash-nav__dot" aria-hidden="true" />
        {MODE_WORD[status.mode]}
      </span>
    </header>
  );
}

/* ---------- the first screen: one number ---------- */

export interface DashHeroProps {
  record: AgentRecord | null;
  summary: AgentSummary | null;
  solPriceUsd: number | null;
  status: Status;
  /** the wallet the journal was written by; linked to Solscan only when the money in it is real */
  walletAddress: string | null;
  agentName: string;
}

const sol = (n: number, d = 2) => `${n.toFixed(d)} SOL`;
const usd = (v: number, px: number | null): string | null => {
  if (px === null || !Number.isFinite(px) || px <= 0) return null;
  const a = Math.abs(v * px);
  return `${v * px < 0 ? "−" : ""}$${a >= 1000 ? Math.round(a).toLocaleString() : a.toFixed(2)}`;
};
const since = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export function DashHero({ record, summary, solPriceUsd, status, walletAddress, agentName }: DashHeroProps) {
  const ref = useReveal<HTMLElement>(0.05);
  const live = status.mode === "live";
  const simGloss = status.mode === "paper" ? GLOSS.paper : status.mode === "demo" ? GLOSS.demo : GLOSS.dryRun;
  const net = record?.net ?? null;
  const tone = net === null ? "" : net >= 0 ? " dash-hero--up" : " dash-hero--down";
  const fees = record ? record.feesRealized + record.feesUnclaimed : null;
  const line: { label: string; value: string; title?: string }[] = [
    { label: "the book", value: record ? sol(record.equityNow) : "·", title: "wallet, USDC and bands, marked to live pool prices" },
    { label: "fees earned", value: fees !== null ? (fees < 0.00005 ? "<0.0001 SOL" : sol(fees, 4)) : "·" },
    { label: "bands", value: summary ? `${summary.bandsOpen} open · ${summary.bandsInRange} in range` : "·", title: GLOSS.band },
    { label: "decisions", value: record ? `${record.counts.decisions.toLocaleString()} · ${record.counts.holds.toLocaleString()} holds` : "·" },
    { label: "pools", value: record ? String(record.counts.pools) : "·" },
  ];
  const when = status.lastTs ? `last decision ${ago(status.lastTs)}` : "no decision yet";

  return (
    <section className={`dash-hero reveal${tone}`} id="top" ref={ref} aria-label={`${agentName}, the number`}>
      <span className="dash-kicker r-item" style={ri(0)}>
        <span className="dash-kicker__rule" aria-hidden="true" />
        {MODE_WORD[status.mode]} · {when}
      </span>

      <div className="dash-hero__num r-item" style={ri(1)}>
        <span className="dash-hero__label">
          net result{record ? ` since ${since(record.startTs)}` : ""}
          {!live && (
            <span className="dash-hero__flag" title={simGloss}>
              simulated
            </span>
          )}
        </span>
        <span className="dash-hero__value" aria-live="polite">
          {net === null ? "·" : `${net >= 0 ? "+" : "−"}${Math.abs(net).toFixed(2)}`}
          <span className="dash-hero__unit">SOL</span>
        </span>
        <span className="dash-hero__sub">
          {record ? (
            <>
              <span className="dash-hero__pct">{fmtPct(record.netPct, 1)}</span>
              {usd(record.net, solPriceUsd) ? <> · ≈ {usd(record.net, solPriceUsd)}</> : null}
              {" · started with "}
              {sol(record.startEquity)}
            </>
          ) : (
            "reading the journal"
          )}
        </span>
      </div>

      <p className="dash-hero__sentence r-item" style={ri(2)}>
        {status.sentence}
        {walletAddress && live && (
          <>
            {" "}
            <a href={`https://solscan.io/account/${walletAddress}`} target="_blank" rel="noreferrer" title="His wallet on Solscan: every balance and transaction, verifiable">
              wallet {short(walletAddress)} ↗
            </a>
          </>
        )}
      </p>

      <dl className="dash-hero__line r-item" style={ri(3)}>
        {line.map((it) => (
          <div className="dash-hero__item" key={it.label} title={it.title}>
            <dt>{it.label}</dt>
            <dd>{it.value}</dd>
          </div>
        ))}
      </dl>

      <a className="dash-hero__cta r-item" style={ri(4)} href="#record">
        the record ↓
      </a>
    </section>
  );
}

/* ---------- a section wrapper: anchor, kicker, reveal ---------- */

export function DashSection({ id, kicker, children }: { id: string; kicker: string; children: ReactNode }) {
  const ref = useReveal<HTMLElement>(0.08);
  return (
    <section className="dash-sec reveal" id={id} ref={ref}>
      <span className="dash-kicker dash-sec__kicker">
        <span className="dash-kicker__rule" aria-hidden="true" />
        {kicker}
      </span>
      <div className="dash-sec__body r-item">{children}</div>
    </section>
  );
}

/* ---------- footer ---------- */

export function DashFooter({ agentName }: { agentName: string }) {
  return (
    <footer className="dash-foot">
      <p className="dash-foot__legal">
        {agentName} is experimental software: an autonomous liquidity agent on Meteora DLMM, Solana. Nothing here is
        financial or investment advice. He trades a small wallet of his own; this page never asks for yours and nothing
        on it can move your money. Providing liquidity can lose money: a band the price walks through ends up holding
        the token that fell, and fees may not cover it. Every decision above is published as written, including the
        ones that lost.
      </p>
      <nav className="dash-foot__links" aria-label="Footer">
        <a href={PLATFORM_URL} target="_blank" rel="noreferrer">bands.finance</a>
        <a href={`${PLATFORM_URL}/#/learn`} target="_blank" rel="noreferrer">how it works</a>
        <a href="https://app.meteora.ag" target="_blank" rel="noreferrer">Meteora</a>
        <a href="https://github.com/louz514/bands-finance" target="_blank" rel="noreferrer">code</a>
      </nav>
    </footer>
  );
}
