import { useEffect, useMemo } from "react";
import { isDemoJournal } from "./api";
import { groupAgents } from "./derive";
import { bookOf, madePairsOf, recordOf, statusOf } from "./model";
import { useJournalFeed } from "./hooks/useJournalFeed";
import { DashFooter, DashStats, DashTop } from "./components/Dash";
import { ModeBanner } from "./components/ModeBanner";
import { Record } from "./components/Record";
import { Book } from "./components/Book";
import { MadePairs } from "./components/MadePairs";
import { Desk } from "./components/Desk";
import { Guards } from "./components/Guards";

/**
 * The dashboard site: just Mr Bands at work. The same journal, the same model (src/model.ts) and the
 * same Record, Book and Desk as the platform, with the platform's navigation, hero, screener and
 * account pages left out. What is on this page: the numbers, the honest mode sentence, the money,
 * the open bands, the pools he made (when he made any), the desk feed, and the guards.
 */
export default function DashboardApp() {
  const { entries, screen, limits, equity, error, now, embedded } = useJournalFeed();

  const agents = useMemo(() => (entries ? groupAgents(entries) : []), [entries]);
  const selected = agents[0] ?? null;
  const agentEntries = selected?.entries ?? [];
  const demo = embedded || (entries ? isDemoJournal(entries) : false);
  const status = useMemo(() => statusOf(agentEntries, now, demo), [agentEntries, now, demo]);
  const record = useMemo(() => recordOf(agentEntries, equity), [agentEntries, equity]);
  const book = useMemo(() => bookOf(agentEntries), [agentEntries]);
  const madePairs = useMemo(() => madePairsOf(agentEntries), [agentEntries]);
  const agentName = selected?.name ?? "Mr Bands";
  const walletAddress = agentEntries[0]?.wallet.address ?? null;

  useEffect(() => {
    const net = record ? `${record.net >= 0 ? "+" : "−"}${Math.abs(record.net).toFixed(2)} SOL` : null;
    document.title = `${agentName}${net ? ` · ${net}` : ""} · ${status.short}`;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute("content", `${agentName} makes markets on Solana and publishes every decision. This page is his desk: the money, the open bands and the feed, as it happens.`);
  }, [agentName, record, status.short]);

  return (
    <div className="dash">
      <DashTop status={status} walletAddress={walletAddress} agentName={agentName} />
      <main className="dash__main">
        <DashStats record={record} summary={selected} solPriceUsd={screen?.solPriceUsd ?? null} status={status} />
        {entries && <ModeBanner status={status} />}
        {error && !entries && (
          <div className="error">
            Could not load the journal: <code>{error}</code>.
          </div>
        )}
        {entries && (
          <>
            <Record record={record} solPriceUsd={screen?.solPriceUsd ?? null} status={status} agentName={agentName} />
            <Book book={book} status={status} agentName={agentName} />
            {madePairs.length > 0 && <MadePairs pairs={madePairs} status={status} agentName={agentName} />}
            <Desk id="desk" entries={agentEntries} status={status} limits={limits} screen={screen} agentName={agentName} />
            <Guards limits={limits} record={record} />
          </>
        )}
      </main>
      <DashFooter agentName={agentName} />
    </div>
  );
}
