import type { ReactNode } from "react";
import { Wordmark } from "../brand/Logo";
import { ago, fmtPct, fmtSigned, short } from "../format";
import { GLOSS, type AgentRecord, type Status } from "../model";
import type { AgentSummary } from "../derive";
import { PLATFORM_URL } from "../site";
import "./Dash.css";

/**
 * The dashboard's own chrome: a top bar that says who this is and what mode he is in, a strip of
 * the numbers people came for, and a footer with the disclaimer. Everything between them is the
 * same Record, Book and Desk the platform renders; nothing here computes a figure of its own.
 */

const MODE_WORD: Record<Status["mode"], string> = { live: "live on Solana", paper: "paper trading", "dry-run": "rehearsal", demo: "demo" };

export interface DashTopProps {
  status: Status;
  /** the wallet the journal was written by; linked to Solscan only when the money in it is real */
  walletAddress: string | null;
  agentName: string;
}

export function DashTop({ status, walletAddress, agentName }: DashTopProps) {
  const real = status.mode === "live";
  const when = status.lastTs ? ago(status.lastTs) : "no decision yet";
  return (
    <header className="dash-top" role="banner">
      <div className="dash-top__inner">
        <a className="dash-top__brand" href={PLATFORM_URL} title="bands.finance, the platform he runs on" target="_blank" rel="noreferrer">
          <Wordmark size={18} />
        </a>
        <span className="dash-top__name">{agentName}</span>
        <span className={`dash-top__mode dash-top__mode--${status.mode}`} title={status.sentence}>
          <span className="dash-top__dot" aria-hidden="true" />
          {MODE_WORD[status.mode]}
        </span>
        <span className="dash-top__when">last decision {when}</span>
        <span className="dash-top__spacer" />
        {walletAddress && real && (
          <a className="dash-top__wallet" href={`https://solscan.io/account/${walletAddress}`} target="_blank" rel="noreferrer" title="His wallet on Solscan: every balance and transaction, verifiable">
            wallet {short(walletAddress)} ↗
          </a>
        )}
        {walletAddress && !real && (
          <span className="dash-top__wallet dash-top__wallet--paper" title={status.sentence}>
            {status.mode === "paper" ? "paper wallet" : status.mode === "demo" ? "no wallet" : "wallet sends nothing"}
          </span>
        )}
        <a className="dash-top__link" href={`${PLATFORM_URL}/#/learn`} target="_blank" rel="noreferrer">
          how it works →
        </a>
      </div>
    </header>
  );
}

export interface DashStatsProps {
  record: AgentRecord | null;
  summary: AgentSummary | null;
  solPriceUsd: number | null;
  status: Status;
}

const solWord = (n: number, d = 2) => `${n.toFixed(d)} SOL`;
const usd = (sol: number, px: number | null): string | null => {
  if (px === null || !Number.isFinite(px) || px <= 0) return null;
  const v = sol * px;
  const a = Math.abs(v);
  return `${v < 0 ? "−" : ""}$${a >= 1000 ? Math.round(a).toLocaleString() : a.toFixed(2)}`;
};

/** The numbers people came for, in one strip; every one is the Record's or the summary's, restated. */
export function DashStats({ record, summary, solPriceUsd, status }: DashStatsProps) {
  const simulated = status.mode !== "live";
  const fees = record ? record.feesRealized + record.feesUnclaimed : null;
  const tiles: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: "up" | "down" }[] = [
    {
      label: <>net result{simulated && <span className="dash-stat__flag" title={status.mode === "paper" ? GLOSS.paper : status.mode === "demo" ? GLOSS.demo : GLOSS.dryRun}>simulated</span>}</>,
      value: record ? `${fmtSigned(record.net, 2)} SOL` : "·",
      sub: record ? `${fmtPct(record.netPct, 2)} since ${new Date(record.startTs).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : undefined,
      tone: record ? (record.net >= 0 ? "up" : "down") : undefined,
    },
    {
      label: "the book",
      value: record ? solWord(record.equityNow) : "·",
      sub: record ? (usd(record.equityNow, solPriceUsd) ?? `${solWord(record.atWork)} at work`) : undefined,
    },
    {
      label: <>fees earned</>,
      value: fees !== null ? (fees < 0.00005 ? "<0.0001 SOL" : solWord(fees, 4)) : "·",
      sub: fees !== null ? (usd(fees, solPriceUsd) ?? undefined) : undefined,
      tone: fees !== null && fees > 0 ? "up" : undefined,
    },
    {
      label: <span title={GLOSS.band}>bands open</span>,
      value: summary ? String(summary.bandsOpen) : "·",
      sub: summary ? `${summary.bandsInRange} in range, earning` : undefined,
    },
    {
      label: "decisions published",
      value: record ? record.counts.decisions.toLocaleString() : "·",
      sub: record ? `${record.counts.holds.toLocaleString()} holds, ${record.counts.pools} pools` : undefined,
    },
  ];
  return (
    <section className="dash-stats" aria-label="The numbers">
      {tiles.map((t, i) => (
        <div className={`dash-stat${t.tone ? ` dash-stat--${t.tone}` : ""}`} key={i}>
          <span className="dash-stat__label">{t.label}</span>
          <span className="dash-stat__value">{t.value}</span>
          {t.sub && <span className="dash-stat__sub">{t.sub}</span>}
        </div>
      ))}
    </section>
  );
}

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
