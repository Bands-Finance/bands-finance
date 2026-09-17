import { useEffect, useMemo } from "react";
import { isDemoJournal } from "./api";
import { groupAgents } from "./derive";
import { actionsOf, bookOf, flowOf, flowTotalsOf, recordOf, statusOf } from "./model";
import { narrativeOf } from "./narrative";
import { useJournalFeed } from "./hooks/useJournalFeed";
import { DashFooter, DashNav, DashNote, DashSection, TickerTape } from "./components/Dash";
import { Panorama, type PanoramaStop } from "./components/Panorama";
import { EngraveDefs } from "./brand/Engrave";
import { ago } from "./format";
import { num } from "./narrative";
import { Record } from "./components/Record";
import { Holdings } from "./components/Holdings";
import { Actions } from "./components/Actions";
import { BrandPlates } from "./components/Brand";

/**
 * The agent's own site: a landing page of actions and results, nothing else. A note written from
 * the numbers, the figures beside it, then what he made (the fee curve and every day on the book),
 * what he holds (the open bands, each a card), and what he did (every
 * move, one sentence each). The same journal and the same model as bands.finance.
 */
export default function DashboardApp() {
  const { entries, screen, equity, error, now, embedded, stamp } = useJournalFeed();

  const agents = useMemo(() => (entries ? groupAgents(entries) : []), [entries]);
  const selected = agents[0] ?? null;
  const agentEntries = selected?.entries ?? [];
  const demo = embedded || (entries ? isDemoJournal(entries) : false);
  const status = useMemo(() => statusOf(agentEntries, now, demo), [agentEntries, now, demo]);
  const record = useMemo(() => recordOf(agentEntries, equity), [agentEntries, equity]);
  const book = useMemo(() => bookOf(agentEntries), [agentEntries]);
  const actions = useMemo(() => actionsOf(agentEntries), [agentEntries]);
  const flows = useMemo(() => flowOf(agentEntries), [agentEntries]);
  const flowTotals = useMemo(() => flowTotalsOf(flows), [flows]);
  const agentName = selected?.name ?? "Mr Bands";
  const walletAddress = agentEntries[0]?.wallet.address ?? null;
  const solPriceUsd = screen?.solPriceUsd ?? null;
  const narrative = useMemo(
    () => narrativeOf({ record, status, agentName, now, flow: flowTotals, bandsOpen: selected?.bandsOpen ?? 0, atWorkSol: record?.atWork }),
    [record, status, agentName, now, flowTotals, selected],
  );

  // THE PANORAMA's wall labels: twelve panels, one live figure each, all of them the Record's or the summary's
  const stops = useMemo<PanoramaStop[]>(() => {
    if (!record) return [];
    const signed = (n: number, d = 2) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(d)}`;
    const fees = record.feesRealized + record.feesUnclaimed;
    const c = record.counts;
    const pools = [...new Set(book.bands.map((b) => b.poolLabel))];
    return [
      { file: "01-capital", title: "Capital", figure: `${num(record.equityNow)} SOL`, label: "the book, all of it his own", motto: "Builds opportunity." },
      { file: "02-liquidity", title: "Liquidity", figure: `${num(record.atWork)} SOL`, label: "at work in bands this minute", motto: "Connects markets." },
      { file: "03-mr-bands", title: agentName, figure: `${signed(record.net)} SOL`, label: "since he started", motto: "Tradition meets progress." },
      { file: "04-markets", title: "Markets", figure: `${selected?.bandsOpen ?? 0} open`, label: `${selected?.bandsInRange ?? 0} in range and earning`, motto: "Ideas find value." },
      { file: "05-partnership", title: "Partnership", figure: pools.length ? pools.slice(0, 2).join(" · ") : "Flat", label: pools.length ? "the pools he is making a market in" : "sitting in SOL until a pool is worth it", motto: "Better people, stronger markets." },
      { file: "06-time", title: "Time", figure: status.lastTs ? ago(status.lastTs, now) : "not yet", label: "his last decision", motto: "Patience pays dividends." },
      { file: "07-opportunity", title: "Opportunity", figure: `${num(fees)} SOL`, label: "fees earned", motto: "Find it in the in between." },
      { file: "08-global-reach", title: "Global reach", figure: `${c.pools}`, label: `pool${c.pools === 1 ? "" : "s"} worked so far`, motto: "Same principles, a wider world." },
      { file: "09-discipline", title: "Discipline", figure: c.decisions ? `${Math.round((c.holds / c.decisions) * 100)}%` : "·", label: "of his decisions were to hold", motto: "A calm mind compounds everything." },
      { file: "10-technology", title: "Technology", figure: c.decisions.toLocaleString(), label: "decisions, every one published", motto: "Tools for a better tomorrow." },
      { file: "11-tradition", title: "Tradition", figure: `${num(record.startEquity)} SOL`, label: `what he started with, ${new Date(record.startTs).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`, motto: "Built on principles." },
      { file: "12-the-future", title: "The future", figure: `${signed(record.netPct, 1)}%`, label: "on the book since the start", motto: "More opportunity ahead." },
    ];
  }, [record, book, selected, status.lastTs, now, agentName]);

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
      <EngraveDefs />
      <DashNav status={status} agentName={agentName} />
      <TickerTape actions={actions} agentName={agentName} />
      <DashNote narrative={narrative} record={record} summary={selected} solPriceUsd={solPriceUsd} status={status} walletAddress={walletAddress} agentName={agentName} now={now} stamp={stamp} />
      <main>
        <div className="dash__main">
          {error && !entries && (
            <div className="error">
              Could not load the journal: <code>{error}</code>.
            </div>
          )}
          {entries && (
            <>
              <DashSection id="made" plate="Plate I" title="What he made" sub="The fees he claimed, and every day on the book since he started.">
                <Record record={record} solPriceUsd={solPriceUsd} status={status} agentName={agentName} compact />
              </DashSection>
              <DashSection id="holds" plate="Plate II" title="What he holds right now">
                <Holdings book={book} screen={screen} status={status} now={now} agentName={agentName} flows={flows} />
              </DashSection>
            </>
          )}
        </div>
        {entries && stops.length > 0 && <Panorama stops={stops} eyebrow="Interlude · scroll to walk it" title="The desk, in twelve figures" />}
        <div className="dash__main">
          {entries && (
            <>
              <DashSection id="did" plate="Plate III" title="What he did" sub="Every move he made, newest first. Holds are not moves.">
                <Actions actions={actions} status={status} now={now} agentName={agentName} />
              </DashSection>
              <DashSection id="house" plate="Plate IV" title="The house" sub="What he stands for, in ten plates.">
                <BrandPlates />
              </DashSection>
            </>
          )}
        </div>
      </main>
      <DashFooter agentName={agentName} />
    </div>
  );
}
