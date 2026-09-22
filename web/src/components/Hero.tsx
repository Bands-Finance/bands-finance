import { useEffect, useState, type CSSProperties } from "react";
import { useReveal } from "../hooks/useReveal";
import { GLOSS, type AgentRecord, type Status } from "../model";
import type { ScreenResult } from "../types";
import "./Hero.css";

const ri = (n: number) => ({ "--ri": n }) as CSSProperties;

export interface HeroProps {
  record: AgentRecord | null;
  screen: ScreenResult | null;
  status: Status;
  /** pool labels the agent is working right now; empty when he has no band open */
  workingNow: string[];
  agentName: string;
}

/**
 * The landing hero, ported from Meridian: the product promise, two CTAs, a
 * cycling strip of the pools he is in, and a live-stats strip. Every number
 * comes in as a prop from the same model the desk below reads, so the hero
 * can never disagree with the page under it. No fetches, no WebGL.
 */
export function Hero({ record, screen, status, workingNow, agentName }: HeroProps) {
  const ref = useReveal<HTMLElement>();
  const live = status.mode === "live";
  const chips = workingNow.length ? [...new Set(workingNow)] : ["no pool yet"];
  const active = useTickerCycle(chips.length, 2600);

  const eyebrow =
    status.mode === "live"
      ? "bands.finance · live on Solana · Meteora DLMM"
      : status.mode === "paper"
        ? "bands.finance · paper trading real pools · nothing broadcast"
        : status.mode === "dry-run"
          ? "bands.finance · rehearsing on Solana · nothing broadcast"
          : "bands.finance · demo · nothing broadcast";

  const sim = live ? "" : status.mode === "paper" ? " (paper)" : " (simulated)";
  const stats = [
    { value: screen ? screen.scannedPools.toLocaleString() : "·", label: "pools scanned on-chain" },
    { value: record ? String(record.counts.decisions) : "·", label: "decisions published" },
    { value: record ? (record.feesRealized + record.feesUnclaimed).toFixed(4) : "·", label: `SOL fees earned${sim}` },
  ];

  return (
    <section className="hero reveal" ref={ref}>
      <SystemTelemetry live={live} />

      <div className="hero__content">
        <span className="eyebrow hero__eyebrow r-item" style={ri(0)}>
          <span className="hero__eyebrow-dot" aria-hidden="true" />
          {eyebrow}
        </span>
        <h1 className="hero__title r-item" style={ri(1)}>
          Meet {agentName}, an agent that <em>makes markets on Solana</em> and shows its work.
        </h1>
        <p className="hero__lede r-item" style={ri(2)}>
          {agentName}, the founder of bands.finance, is an agent that makes markets on Meteora DLMM, around the
          clock. Every half hour he reads every pool on the chain and ranks them, then puts small stacks of
          liquidity (his <span className="term" title={GLOSS.band}>bands</span>) right around the price in the
          best ones and earns the pool's fees on the trades that cross them. Tokenized stocks are one part of
          his book. He proposes every move, from his own rulebook today; hard-coded guards decide, and can veto
          it or pull him out. Every decision, every veto, every transaction is published here as it happens.
        </p>

        <div className="hero__cta r-item" style={ri(3)}>
          <a className="hero__btn hero__btn--primary" href="#desk">Watch him work ↓</a>
          <a className="hero__btn hero__btn--ghost" href="#/pools">See every pool ranked →</a>
        </div>

        <div className="hero__tickers r-item" style={ri(5)}>
          <span className="hero__tickers-label">{live ? "Working now" : "Rehearsing in"}</span>
          {chips.map((t, i) => (
            <span key={t} className={`hero__ticker${i === active ? " is-active" : ""}`}>{t}</span>
          ))}
        </div>

        <dl className="hero__stats r-item" style={ri(6)}>
          {stats.map((s) => (
            <div className="hero__stat" key={s.label}>
              <dt className="hero__stat-value">{s.value}</dt>
              <dd className="hero__stat-label">{s.label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/** Advances a highlighted index on an interval; static under reduced motion. */
function useTickerCycle(count: number, intervalMs: number): number {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (count < 2) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setI((n) => (n + 1) % count), intervalMs);
    return () => window.clearInterval(id);
  }, [count, intervalMs]);
  // The chip list can shrink between renders; never point past its end.
  return count > 0 ? i % count : 0;
}

/** Ambient system telemetry, mirrored corner readouts framing the hero. */
function SystemTelemetry({ live }: { live: boolean }) {
  const state = live ? "LIVE" : "REHEARSAL";
  return (
    <div className="hero__telemetry" aria-hidden="true">
      <div className="hero__telemetry-block hero__telemetry-block--left">
        <span>B://BANDS</span>
        <span>...RUNTIME v0.1</span>
        <span>/////...{state}</span>
        <span className="hero__telemetry-tag">&lt;AGENT_ONLINE&gt;</span>
      </div>
      <div className="hero__telemetry-block hero__telemetry-block--right">
        <span>A://DLMM_CORE</span>
        <span>...MARKET_MAKING</span>
        <span>/////...METEORA</span>
        <span className="hero__telemetry-tag">&lt;SIGNAL_{state}&gt;</span>
      </div>
    </div>
  );
}
