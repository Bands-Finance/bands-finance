import { useState, type CSSProperties, type ReactNode } from "react";
import { useReveal } from "../hooks/useReveal";
import { loadJournal, loadLimits, loadScreen } from "../api";
import { ago } from "../format";
import { NO_BOOK, realEntries } from "../model";
import type { JournalEntry, RiskLimits, ScreenResult } from "../types";
import "./TryIt.css";

const ri = (n: number) => ({ "--ri": n }) as CSSProperties;

/** What a read returns. Each tool reads one of the three files the whole site is built from. */
type Result = { kind: "screen"; screen: ScreenResult } | { kind: "journal"; entries: JournalEntry[] } | { kind: "limits"; limits: RiskLimits };

interface Tool {
  id: string;
  label: string;
  /** the source printed in the terminal line: what you would call yourself */
  source: string;
  run: () => Promise<Result | null>;
}

/** Newest entry per pool, newest first, at most `n` of them. */
function latestPerPool(entries: JournalEntry[], n: number): JournalEntry[] {
  const seen = new Set<string>();
  const out: JournalEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.pool.address)) continue;
    seen.add(e.pool.address);
    out.push(e);
    if (out.length === n) break;
  }
  return out;
}

const TOOLS: Tool[] = [
  {
    id: "screen",
    label: "Rank every pool",
    source: "/api/screen",
    run: async () => {
      const screen = await loadScreen();
      return screen ? { kind: "screen", screen } : null;
    },
  },
  {
    id: "journal",
    label: "Where Mr Bands is standing",
    source: "/api/journal?limit=3",
    run: async () => {
      // his real-money book only (model.ts realEntries); an empty one is an answer, not a failure
      return { kind: "journal", entries: latestPerPool(realEntries(await loadJournal(3)), 3) };
    },
  },
  {
    id: "limits",
    label: "The rules he can't break",
    source: "/api/limits",
    run: async () => {
      const limits = await loadLimits();
      return limits ? { kind: "limits", limits } : null;
    },
  },
];

function summaryOf(r: Result): string {
  switch (r.kind) {
    case "screen":
      return `${r.screen.rankedPools} pools ranked from ${r.screen.scannedPools.toLocaleString()} scanned · ${ago(r.screen.generatedAt)}`;
    case "journal":
      if (r.entries.length === 0) return `${NO_BOOK.short} · the journal is empty`;
      return `${r.entries.length} pool${r.entries.length === 1 ? "" : "s"} in the journal · newest decision ${ago(r.entries[0].ts)}`;
    case "limits":
      return `${Object.keys(r.limits).length} rules`;
  }
}

function bandsWord(e: JournalEntry): string {
  const n = e.positions.length;
  if (n === 0) return "no band open";
  const inRange = e.positions.filter((p) => p.inRange).length;
  const bands = `${n} band${n === 1 ? "" : "s"}`;
  if (n === 1) return `${bands} · ${inRange ? "in range, earning" : "out of range, earning nothing"}`;
  return `${bands} · ${inRange} in range`;
}

function renderResult(r: Result): ReactNode {
  switch (r.kind) {
    case "screen":
      return r.screen.pools.slice(0, 6).map((p) => (
        <div className="tryit__row" key={p.address}>
          <span className="tryit__sym">#{p.rank}</span>
          <span className="tryit__sym tryit__sym--wide">{p.name}</span>
          <span className="tryit__val" title="Mr Bands' score, 0 to 100">score {p.score.toFixed(0)}</span>
          <span className="tryit__val" title="fees earned in 24h as a share of the money in the pool">{p.feeToTvl24hPct === null ? "n/a" : `${p.feeToTvl24hPct.toFixed(2)}%/day`}</span>
          <span className="tryit__seg">{p.flags.filter((f) => f !== "onchain-fees").join(" · ") || "no flags"}</span>
        </div>
      ));
    case "journal":
      return r.entries.map((e) => {
        const earning = e.positions.some((p) => p.inRange);
        return (
          <div key={e.id}>
            <div className="tryit__row">
              <span className="tryit__sym tryit__sym--wide">{e.pool.label}</span>
              <span className={`tryit__chg ${e.positions.length === 0 ? "" : earning ? "up" : "down"}`}>{bandsWord(e)}</span>
              <span className="tryit__seg">{ago(e.ts)}</span>
            </div>
            <p className="tryit__cmd">“{e.headline}”</p>
          </div>
        );
      });
    case "limits": {
      const l = r.limits;
      const rows: [string, string][] = [
        ["the most he can put in one band", `${l.maxPositionSol} SOL`],
        ["the most he can have out across every band", `${l.maxTotalExposureSol} SOL`],
        ["kept in the wallet for fees and rent", `${l.gasReserveSol} SOL`],
        ["a band this far below what went in is closed", `−${l.stopLossPct}%`],
        ["a band can be at most this wide", `${l.maxBinWidth} bins`],
        ["actions per day, at most", `${l.maxTxPerDay}`],
        ["and at least this long apart", `${Math.round(l.minSecondsBetweenActions / 60)} min`],
        ["a fill worse than this is refused", `${l.maxSlippagePct}% slippage`],
        ["no new band after a jump this big in one cycle", `> ${l.maxPriceMovePctPerCycle}%`],
      ];
      return rows.map(([sentence, value]) => (
        <div className="tryit__row" key={sentence}>
          <span className="tryit__sym tryit__sym--wide">{sentence}</span>
          <span className="tryit__val">{value}</span>
        </div>
      ));
    }
  }
}

type State = { status: "idle" } | { status: "loading"; tool: Tool } | { status: "done"; tool: Tool; result: Result } | { status: "error"; tool: Tool };

/**
 * A no-wallet, no-cost way to touch the real thing: the visitor triggers a
 * read of one of the three files Mr Bands works from and watches the answer
 * come back. Honest: these are the same reads the rest of the site makes.
 */
export function TryIt() {
  const ref = useReveal<HTMLElement>();
  const [state, setState] = useState<State>({ status: "idle" });

  async function run(tool: Tool) {
    setState({ status: "loading", tool });
    try {
      const result = await tool.run();
      setState(result ? { status: "done", tool, result } : { status: "error", tool });
    } catch {
      setState({ status: "error", tool });
    }
  }

  const active = "tool" in state ? state.tool : null;

  return (
    <section className="tryit reveal" id="try" ref={ref} aria-label="Try it">
      <div className="tryit__head r-item" style={ri(0)}>
        <span className="eyebrow tryit__eyebrow">Try it · nothing to connect</span>
        <h2 className="tryit__title">Read the board yourself.</h2>
        <p className="tryit__sub">A real read of the files Mr Bands works from.</p>
      </div>

      <div className="tryit__panel r-item" style={ri(1)}>
        <div className="tryit__tools">
          {TOOLS.map((t) => (
            <button key={t.id} type="button" className={`tryit__tool${active?.id === t.id ? " is-active" : ""}`} onClick={() => void run(t)} disabled={state.status === "loading"}>
              {t.label}
              <span className="tryit__price">free read</span>
            </button>
          ))}
        </div>

        <div className="tryit__term" aria-live="polite">
          {state.status === "idle" && <p className="tryit__idle">← pick one to run a real read</p>}
          {state.status !== "idle" && active && (
            <>
              <p className="tryit__cmd">
                <span className="tryit__prompt">guest@bands.finance</span> reads <span className="tryit__toolname">{active.source}</span>
              </p>
              {state.status === "loading" && <p className="tryit__pending">→ reading…</p>}
              {state.status === "error" && <p className="tryit__pending">→ nothing answered. Try another</p>}
              {state.status === "done" && (
                <>
                  <p className="tryit__ok">→ 200 · {summaryOf(state.result)}</p>
                  <div className="tryit__out">{renderResult(state.result)}</div>
                </>
              )}
            </>
          )}
        </div>
      </div>

      <p className="tryit__fine r-item" style={ri(2)}>
        <strong>Every number here comes from three files</strong>:{" "}
        <a className="tryit__402" href="/screen.json">screen.json</a>, <a className="tryit__402" href="/journal.json">journal.json</a> and <a className="tryit__402" href="/limits.json">limits.json</a>.
      </p>
    </section>
  );
}
