import { useEffect, useState } from "react";
import { Actions } from "../components/Actions";
import { dayOf, lengthWords, loadLiveRun, spanWords, type LiveRun } from "../liveRun";
import { Figures } from "./Chapters";
import type { Beat } from "./Journey";
import "./LiveRun.css";

/**
 * The chapter of the run he made live on Solana (src/liveRun.ts): the figures of the run, the result
 * stated as it was, and the ledger of every move with its transaction. Set in the page's one type
 * system (Chapters.tsx Figures, the engraved facts row, the Actions ledger): nothing new to look at,
 * only something new to read. The run lost money; the chapter says so, because the record is the point.
 */

/** SOL to the hundredth, the way the ledger rows print it, so start, end and the change add up on the page */
const sol = (n: number) => n.toFixed(2);
const signed = (n: number, d = 2) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(d)}`;

export function useLiveRun(): LiveRun | null {
  const [run, setRun] = useState<LiveRun | null>(null);
  useEffect(() => {
    let alive = true;
    void loadLiveRun().then((r) => alive && r && setRun(r));
    return () => {
      alive = false;
    };
  }, []);
  return run;
}

export function LiveRunBlock({ run, now }: { run: LiveRun; now: number }) {
  // what the run made and what it cost, both from the record: the change in the book is the fees he earned less what the rest took.
  // Settled, the end is the ledger's all-cash book (docs/sprint.md, "One headline number"), not the chart's last mark.
  const rest = run.change - run.feesClaimed;
  const ended = run.settled
    ? `All SOL once the last band was closed; the last mark, with a band open, was ${sol(run.lastMarkEquity)}.`
    : "At the last mark.";
  const tokens = run.feesInTokens !== null && run.feesInTokens > 0 ? `, and about ${sol(run.feesInTokens)} of it came as tokens, sold later for what they fetched` : "";
  const lost = run.change < 0;
  return (
    <>
      <Figures
        items={[
          { label: "Started with", value: <>{sol(run.startEquity)}<small> SOL</small></>, note: `${dayOf(run.firstTs)}, ${new Date(run.firstTs).toISOString().slice(11, 16)} UTC` },
          { label: "Stopped with", value: <>{sol(run.endEquity)}<small> SOL</small></>, tone: lost ? "bad" : "good", note: `${signed(run.change)} SOL, ${signed(run.changePct, 1)}%. At its best ${sol(run.peakEquity)}. ${ended}` },
          { label: "Fees earned", value: <>+{sol(run.feesClaimed)}<small> SOL</small></>, tone: "good", note: `valued when claimed, on ${run.claims} claims, ${run.closes} closes and ${run.relays} re-lays. Fees, not profit.` },
          { label: "Moves", value: run.moves.toLocaleString(), note: `${run.opens} opens, ${run.relays} re-lays, ${run.closes} closes, ${run.claims} claims` },
          { label: "Transactions", value: run.transactions.toLocaleString(), note: "each one linked below" },
          { label: "Pools", value: run.pools.length.toLocaleString(), note: run.pools.slice(0, 3).join(", ") + (run.pools.length > 3 ? " and more" : "") },
        ]}
      />
      <p className="chap__p">
        He started with {sol(run.startEquity)} SOL and stopped with {sol(run.endEquity)}, so the run {lost ? "lost" : "made"} {sol(Math.abs(run.change))} SOL. He earned {sol(run.feesClaimed)} SOL in fees over
        those {lengthWords(run.hours)}, each valued when it was claimed{tokens}. {rest < 0 ? `Price moves and the cost of moving took ${sol(Math.abs(rest))} back` : `The rest of the book gained ${sol(rest)}`}. Both are in the ledger below.
      </p>
      <p className="chap__facts engrave">
        <span>{run.decisions.toLocaleString()} decisions</span>
        <span>{run.holds.toLocaleString()} holds</span>
        {run.failed > 0 && <span>{run.failed} failed</span>}
        <a href={`https://solscan.io/account/${run.wallet}`} target="_blank" rel="noreferrer" title="his wallet on Solscan">
          Wallet {run.wallet.slice(0, 4)}…{run.wallet.slice(-4)} ↗
        </a>
      </p>
      <div className="lived">
        <Actions actions={run.rows} status={run.status} now={now} agentName={run.agentName} />
      </div>
    </>
  );
}

/** The beat, for DashboardApp's chapters: the ticker station, the words on the left, a wide column for the ledger. */
/** mode is the page's: the chapter's last sentence must be true beside the badge that shows it */
export function liveRunBeat(run: LiveRun, now: number, mode: string): Beat {
  return {
    id: "lived",
    station: "tape",
    side: "left",
    wide: true,
    eyebrow: `On Solana · ${spanWords(run.firstTs, run.lastTs)}`,
    line1: "He traded live",
    line2: `for ${lengthWords(run.hours)}.`,
    body: (
      <>
        <p>
          This was his own wallet on Solana, on real Meteora pools, from {dayOf(run.firstTs)} to {dayOf(run.lastTs)}. Then the desk was stopped and the wallet emptied.{" "}
          {mode === "live" ? "It has been funded again, and the chapters above are the new run." : "He trades on paper now, and the live desk stays stopped."}
        </p>
      </>
    ),
    content: <LiveRunBlock run={run} now={now} />,
    links: [{ href: `https://solscan.io/account/${run.wallet}`, label: "The wallet on Solscan", external: true }],
  };
}
