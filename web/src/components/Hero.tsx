import { useEffect, useState, type CSSProperties } from "react";
import { useReveal } from "../hooks/useReveal";
import { GLOSS, type AgentRecord, type Status } from "../model";
import type { ScreenResult } from "../types";
import type { LiveRun } from "../liveRun";
import "./Hero.css";

const ri = (n: number) => ({ "--ri": n }) as CSSProperties;

export interface HeroProps {
  record: AgentRecord | null;
  screen: ScreenResult | null;
  status: Status;
  /** pool labels the agent is working right now; empty when he has no band open */
  workingNow: string[];
  agentName: string;
  /** his real-money run (liveRun.ts): while no book is open its settled figures stand in for the book's */
  run?: LiveRun | null;
}

/**
 * The landing hero, ported from Meridian: the product promise, two CTAs, a
 * cycling strip of the pools he is in, and a live-stats strip. Every number
 * comes in as a prop from the same model the desk below reads, so the hero
 * can never disagree with the page under it. No fetches, no WebGL.
 */
export function Hero({ record, screen, status, workingNow, agentName, run = null }: HeroProps) {
  const ref = useReveal<HTMLElement>();
  const live = status.mode === "live";
  const idle = status.mode === "none";
  const chips = workingNow.length ? [...new Set(workingNow)] : [idle ? "no book open" : "no pool yet"];
  const active = useTickerCycle(chips.length, 2600);

  const eyebrow =
    status.mode === "live"
      ? "bands.finance · live · Meteora DLMM"
      : idle
        ? "bands.finance · no book open · Meteora DLMM"
        : status.mode === "dry-run"
          ? "bands.finance · rehearsal · nothing broadcast"
          : "bands.finance · demo · nothing broadcast";

  // no book open: the book's two figures are his real-money run's, settled, and labelled as that run's
  const stats = [
    { value: screen ? screen.scannedPools.toLocaleString() : "·", label: "pools scanned" },
    idle
      ? { value: run ? run.decisions.toLocaleString() : "·", label: "decisions, real-money run" }
      : { value: record ? String(record.counts.decisions) : "·", label: "decisions published" },
    idle
      ? { value: run ? run.feesClaimed.toFixed(2) : "·", label: "SOL fees claimed, real-money run" }
      : { value: record ? (record.feesRealized + record.feesUnclaimed).toFixed(4) : "·", label: "SOL fees earned" },
  ];

  return (
    <section className="hero reveal" ref={ref}>
      <SystemTelemetry state={live ? "LIVE" : idle ? "STANDBY" : "REHEARSAL"} />

      <div className="hero__content">
        <span className="eyebrow hero__eyebrow r-item" style={ri(0)}>
          <span className="hero__eyebrow-dot" aria-hidden="true" />
          {eyebrow}
        </span>
        <h1 className="hero__title r-item" style={ri(1)}>
          {agentName} <em>makes markets on Solana</em> and shows his work.
        </h1>
        <p className="hero__lede r-item" style={ri(2)}>
          He lays <span className="term" title={GLOSS.band}>bands</span> of SOL in the best pools on Meteora DLMM and earns the fees on
          trades that cross them. He proposes, the guards decide, and every decision is published here.
        </p>

        <div className="hero__cta r-item" style={ri(3)}>
          <a className="hero__btn hero__btn--primary" href="#desk">{idle ? "See his record ↓" : "Watch him work ↓"}</a>
          <a className="hero__btn hero__btn--ghost" href="#/pools">See every pool ranked →</a>
        </div>

        <div className="hero__tickers r-item" style={ri(5)}>
          <span className="hero__tickers-label">{live ? "Working now" : idle ? "Right now" : "Rehearsing in"}</span>
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
function SystemTelemetry({ state }: { state: "LIVE" | "STANDBY" | "REHEARSAL" }) {
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
