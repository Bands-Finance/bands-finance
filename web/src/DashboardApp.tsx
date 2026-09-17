import { useEffect, useMemo } from "react";
import { isDemoJournal } from "./api";
import { groupAgents } from "./derive";
import { actionsOf, bookOf, madePairsOf, recordOf, statusOf } from "./model";
import { narrativeOf } from "./narrative";
import { useJournalFeed } from "./hooks/useJournalFeed";
import { DashFooter, DashNav, DashNote, DashSection } from "./components/Dash";
import { Record } from "./components/Record";
import { Holdings } from "./components/Holdings";
import { MadePairs } from "./components/MadePairs";
import { Actions } from "./components/Actions";

/**
 * The agent's own site: a landing page of actions and results, nothing else. A note written from
 * the numbers, the figures beside it, then what he made (the fee curve and every day on the book),
 * what he holds (the open bands, and the pools he made when he made any), and what he did (every
 * move, one sentence each). The same journal and the same model as bands.finance.
 */
export default function DashboardApp() {
  const { entries, screen, equity, error, now, embedded } = useJournalFeed();

  const agents = useMemo(() => (entries ? groupAgents(entries) : []), [entries]);
  const selected = agents[0] ?? null;
  const agentEntries = selected?.entries ?? [];
  const demo = embedded || (entries ? isDemoJournal(entries) : false);
  const status = useMemo(() => statusOf(agentEntries, now, demo), [agentEntries, now, demo]);
  const record = useMemo(() => recordOf(agentEntries, equity), [agentEntries, equity]);
  const book = useMemo(() => bookOf(agentEntries), [agentEntries]);
  const madePairs = useMemo(() => madePairsOf(agentEntries), [agentEntries]);
  const actions = useMemo(() => actionsOf(agentEntries), [agentEntries]);
  const agentName = selected?.name ?? "Mr Bands";
  const walletAddress = agentEntries[0]?.wallet.address ?? null;
  const solPriceUsd = screen?.solPriceUsd ?? null;
  const narrative = useMemo(() => narrativeOf({ record, status, agentName, now }), [record, status, agentName, now]);

  // The sections mount once the journal has loaded, so a deep link (#made, #did) has nothing to
  // scroll to on first paint: honour it when the content appears.
  const loaded = entries !== null;
  useEffect(() => {
    if (!loaded) return;
    const hash = window.location.hash;
    if (!hash || hash === "#top") return;
    const el = document.querySelector(hash);
    if (el) window.requestAnimationFrame(() => el.scrollIntoView({ block: "start" }));
  }, [loaded]);

  useEffect(() => {
    document.title = record ? narrative.headline.replace(/\.$/, "") : agentName;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute("content", `${agentName} makes markets on Solana and publishes every move. This page is what he made, what he holds and what he did.`);
    document.documentElement.style.colorScheme = "light";
    return () => {
      document.documentElement.style.colorScheme = "";
    };
  }, [agentName, record, narrative.headline]);

  return (
    <div className="dash">
      <DashNav status={status} agentName={agentName} />
      <DashNote narrative={narrative} record={record} summary={selected} solPriceUsd={solPriceUsd} status={status} walletAddress={walletAddress} agentName={agentName} now={now} />
      <main className="dash__main">
        {error && !entries && (
          <div className="error">
            Could not load the journal: <code>{error}</code>.
          </div>
        )}
        {entries && (
          <>
            <DashSection id="made" title="What he made" sub="The fees he claimed, and every day on the book since he started.">
              <Record record={record} solPriceUsd={solPriceUsd} status={status} agentName={agentName} compact />
            </DashSection>
            <DashSection id="holds" title="What he holds right now">
              <Holdings book={book} screen={screen} status={status} now={now} agentName={agentName} />
              {madePairs.length > 0 && <MadePairs pairs={madePairs} status={status} agentName={agentName} />}
            </DashSection>
            <DashSection id="did" title="What he did" sub="Every move he made, newest first. Holds are not moves.">
              <Actions actions={actions} status={status} now={now} agentName={agentName} />
            </DashSection>
          </>
        )}
      </main>
      <DashFooter agentName={agentName} />
    </div>
  );
}
