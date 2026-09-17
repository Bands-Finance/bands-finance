import { useEffect, useMemo } from "react";
import { isDemoJournal } from "./api";
import { groupAgents } from "./derive";
import { actionsOf, bookOf, madePairsOf, recordOf, statusOf } from "./model";
import { useJournalFeed } from "./hooks/useJournalFeed";
import { useScrollFx } from "./hooks/useScrollFx";
import { DashAtmosphere, DashFooter, DashHero, DashNav, DashSection } from "./components/Dash";
import { Record } from "./components/Record";
import { Book } from "./components/Book";
import { MadePairs } from "./components/MadePairs";
import { Actions } from "./components/Actions";

/**
 * The dashboard site: just Mr Bands at work. The same journal, the same model (src/model.ts) and the
 * same Record, Book and Desk as the platform, with the platform's navigation, hero, screener and
 * account pages left out. A landing page of actions and results, nothing else: the number first, then
 * the fee curve and the daily record, the open bands (and the pools he made, when he made any), and
 * every move he executed, one line each.
 */
export default function DashboardApp() {
  useScrollFx();
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

  // The sections mount once the journal has loaded, so a deep link (#record, #desk) has nothing to
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
    const net = record ? `${record.net >= 0 ? "+" : "−"}${Math.abs(record.net).toFixed(2)} SOL` : null;
    document.title = `${agentName}${net ? ` · ${net}` : ""} · ${status.short}`;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute("content", `${agentName} makes markets on Solana and publishes every decision. This page is his desk: the money, the open bands and the feed, as it happens.`);
  }, [agentName, record, status.short]);

  return (
    <div className="dash">
      <DashAtmosphere />
      <DashNav status={status} agentName={agentName} />
      <DashHero record={record} summary={selected} solPriceUsd={solPriceUsd} status={status} walletAddress={walletAddress} agentName={agentName} />
      <main className="dash__main">
        {error && !entries && (
          <div className="error">
            Could not load the journal: <code>{error}</code>.
          </div>
        )}
        {entries && (
          <>
            <DashSection id="results" kicker="results">
              <Record record={record} solPriceUsd={solPriceUsd} status={status} agentName={agentName} compact />
            </DashSection>
            <DashSection id="bands" kicker="on the book">
              <Book book={book} status={status} agentName={agentName} compact />
              {madePairs.length > 0 && <MadePairs pairs={madePairs} status={status} agentName={agentName} />}
            </DashSection>
            <DashSection id="actions" kicker="actions">
              <Actions actions={actions} status={status} now={now} agentName={agentName} />
            </DashSection>
          </>
        )}
      </main>
      <DashFooter agentName={agentName} />
    </div>
  );
}
