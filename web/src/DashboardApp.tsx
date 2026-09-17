import { useEffect, useMemo, useRef } from "react";
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
import { Journey, type Beat } from "./stage/Journey";
import type { StageData } from "./stage/DeskStage";
import { useMotion } from "./motion";
import "lenis/dist/lenis.css";

/** The desk shows the band the price is inside first: that is where the crossing can be seen. */
const byInRangeThenWorth = (a: { inRange: boolean; worthNow: number }, b: { inRange: boolean; worthNow: number }) => Number(b.inRange) - Number(a.inRange) || b.worthNow - a.worthNow;

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

  // THE DESK's live data: one tray per open band (the two largest), the cursor where the price is, a coin a tenth of a SOL of fees
  const feesAll = record ? record.feesRealized + record.feesUnclaimed : 0;
  const stageData = useMemo<StageData>(() => {
    const bands = [...book.bands]
      .filter((b) => b.upperPrice > b.lowerPrice && b.activePrice > 0 && b.widthBins > 0)
      .sort(byInRangeThenWorth)
      .slice(0, 2)
      .map((b) => ({ label: b.poolLabel, lowerPrice: b.lowerPrice, upperPrice: b.upperPrice, activePrice: b.activePrice, bins: b.widthBins }));
    return { bands, feesSol: feesAll };
  }, [book, feesAll]);

  // THE JOURNEY's words. Every figure is the Record's or the book's; an empty book says so.
  const beats = useMemo<Beat[]>(() => {
    const m = narrative.headline.match(/^(.*?\bis (?:up|down|about flat))\s+(.*)$/);
    const words = narrative.headline.split(" ");
    const [h1, h2] = m ? [m[1], m[2]] : [words.slice(0, Math.ceil(words.length / 2)).join(" "), words.slice(Math.ceil(words.length / 2)).join(" ")];
    const first = [...book.bands].sort(byInRangeThenWorth)[0] ?? null;
    const crossed = first ? first.activePrice < first.upperPrice : false;
    const bins = book.bands.reduce((n, b) => n + b.widthBins, 0);
    const nBands = book.bands.length;
    const moved = actions.filter((a) => a.action === "REBALANCE").length;
    const px = (n: number) => (n >= 1 ? n.toFixed(2) : n.toPrecision(4));
    const where = first ? (first.activePrice > first.upperPrice ? "The price is above his band, so every bin still holds SOL." : first.activePrice < first.lowerPrice ? "The price is below his band, so every bin now holds the token." : "The price is inside his band.") : "";
    return [
      {
        id: "hero", side: "left", frame: { x: -0.02, y: 0.1 }, frameTall: { x: 0, y: -0.36 }, eyebrow: new Date(now).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }),
        line1: h1, line2: h2,
        body: <>{narrative.story.slice(0, 2).map((s, i) => <p key={i}>{s}</p>)}</>,
        links: [{ href: "#lays", label: "See how he works" }, ...(walletAddress ? [{ href: `https://solscan.io/account/${walletAddress}`, label: "His wallet", external: true }] : [])],
      },
      {
        id: "lays", side: "left", frame: { x: 0.2, y: 0.08 }, eyebrow: "I · The band", line1: "He lays SOL", line2: "under the price.",
        body: nBands ? <><p>A band is a row of price bins. In each bin under the market he leaves SOL, offered to anyone who wants to sell him the token there.</p><p>Each strapped bundle on the desk is one bin of his SOL.</p></> : <><p>A band is a row of price bins with his SOL laid in them. He holds none right now.</p><p>His SOL is stacked by the hat until a pool is worth it.</p></>,
        figure: record ? (nBands ? { value: `${num(record.atWork)} SOL`, label: `at work in ${nBands} band${nBands === 1 ? "" : "s"}, ${bins} bins in all` } : { value: `${num(record.equityNow)} SOL`, label: "waiting in his wallet" }) : null,
      },
      {
        id: "cross", side: "right", frame: { x: -0.2, y: 0.04 }, eyebrow: "II · The crossing", line1: "Traders cross his band.", line2: "He gets paid.",
        body: <><p>When the price falls into a bin, his SOL there buys the token. When it climbs back out, he sells it again. {crossed ? "The dark slabs are bins the price has already crossed." : "The brass cursor is the price. It stands above his band, so no bin has been crossed yet."}</p><p>Every crossing pays him the pool's fee.</p></>,
        figure: first ? { value: px(first.activePrice), label: `${first.poolLabel} now. His band runs from ${px(first.lowerPrice)} to ${px(first.upperPrice)}. ${where}` } : null,
      },
      {
        id: "fees", side: "left", eyebrow: "III · The dish", line1: "Fees fall", line2: "into the dish.",
        body: <><p>One coin for every tenth of a SOL traders have paid him. Claimed fees go back to his wallet as SOL.</p>{flowTotals && flowTotals.fees60mSol > 0 && <p>In the last hour his pools paid {num(flowTotals.fees60mSol)} SOL to everyone making a market there.</p>}</>,
        figure: record ? { value: `${num(feesAll)} SOL`, label: "in fees since he started" } : null,
      },
      {
        id: "relay", side: "right", frame: { x: -0.2, y: 0.02 }, eyebrow: "IV · The re-lay", line1: "Price walks away.", line2: "He lays it again.",
        body: <><p>A band the price has left earns nothing. He waits for a quiet minute, then lays it under the price again.</p><p>Moving costs a little, so he counts that too, and he writes down what each band taught him.</p></>,
        figure: { value: `${moved}`, label: `band${moved === 1 ? "" : "s"} moved so far, each one in the ledger below` },
      },
      {
        id: "record", side: "left", eyebrow: "V · The record", line1: "Every move", line2: "is on the record.",
        body: <><p>This page is printed from his journal and nothing else. Each line below links to its transaction on Solana.</p></>,
        figure: record ? { value: record.counts.decisions.toLocaleString(), label: "decisions, every one published" } : null,
        links: [{ href: "#statement", label: "Read the statement" }],
      },
    ];
  }, [narrative, book, record, actions, flowTotals, feesAll, walletAddress, now]);

  // SMOOTH SCROLL: only smoothing, never steering; off with reduced motion or the footer's switch, and never on touch
  const motion = useMotion();
  useEffect(() => {
    document.documentElement.dataset.motion = motion ? "on" : "off";
    if (!motion) return;
    let lenis: { destroy(): void } | null = null;
    let gone = false;
    import("lenis").then(({ default: Lenis }) => {
      if (gone) return;
      lenis = new Lenis({ lerp: 0.09, smoothWheel: true, syncTouch: false, autoRaf: true, anchors: true });
    });
    return () => {
      gone = true;
      lenis?.destroy();
    };
  }, [motion]);
  const sheetRef = useRef<HTMLDivElement>(null);

  // The sections mount once the journal has loaded, so a deep link (#made, #did) has nothing to
  // scroll to on first paint: honour it when the content appears.
  const loaded = entries !== null;
  useEffect(() => {
    if (!loaded) return;
    const hash = window.location.hash;
    if (!hash || hash === "#top" || hash === "#hero") return;
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
      <Journey beats={beats} data={stageData} sheetRef={sheetRef} />
      <div className="sheet" id="statement" ref={sheetRef}>
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
    </div>
  );
}
