import { useEffect, useMemo } from "react";
import { isDemoJournal } from "./api";
import { groupAgents } from "./derive";
import { actionsOf, bookOf, flowOf, flowTotalsOf, recordOf, statusOf } from "./model";
import { narrativeOf, num } from "./narrative";
import { useJournalFeed } from "./hooks/useJournalFeed";
import { DashNav, TickerTape, statementRows } from "./components/Dash";
import { EngraveDefs } from "./brand/Engrave";
import { Actions } from "./components/Actions";
import { Journey, type Beat } from "./stage/Journey";
import type { StageData } from "./stage/DeskStage";
import { BandBlock, ClosingBlock, MadeBlock, StatementList, bandLabels, bandStatus, feeChartOf, pairWords } from "./stage/Chapters";
import { useMotion } from "./motion";
import "lenis/dist/lenis.css";

/** The desk shows the band the price is inside first: that is where the crossing can be seen. */
const byInRangeThenWorth = (a: { inRange: boolean; worthNow: number }, b: { inRange: boolean; worthNow: number }) => Number(b.inRange) - Number(a.inRange) || b.worthNow - a.worthNow;

/**
 * The agent's own site, one journey from top to bottom. An engraved desk (web/3d, web/src/stage) stays
 * fixed behind the page and the reader's scroll walks a camera round it; every chapter is a stop on the
 * desk and a block of words beside it. How he works and what he has to show for it are the same chapters:
 * the rows of bundles are his open bands, the dish and the abacus are his fees, the ledger is his moves.
 * The same journal and the same model as bands.finance; every figure is the Record's, the Book's or the
 * flow scout's, and an empty book says so.
 */
export default function DashboardApp() {
  const { entries, equity, error, now, embedded, stamp, solPriceUsd } = useJournalFeed();

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
  const narrative = useMemo(
    () => narrativeOf({ record, status, agentName, now, flow: flowTotals, bandsOpen: selected?.bandsOpen ?? 0, atWorkSol: record?.atWork }),
    [record, status, agentName, now, flowTotals, selected],
  );

  // the bands in the order the desk lays them out: the first two get a tray each
  const bands = useMemo(() => [...book.bands].filter((b) => b.upperPrice > b.lowerPrice && b.activePrice > 0 && b.widthBins > 0).sort(byInRangeThenWorth), [book]);
  const feesAll = record ? record.feesRealized + record.feesUnclaimed : 0;
  // the abacus moves once an hour at most: keying it on the hour keeps the desk from being rebuilt every tick
  const hourNow = Math.floor(now / 3600e3);
  const chart = useMemo(() => (record ? feeChartOf(record.feePoints, record.startTs, (hourNow + 1) * 3600e3 - 1) : null), [record, hourNow]);

  // THE DESK's live data: a tray per open band, the cursor where the price is, a coin a tenth of a SOL of fees, the abacus
  const stageData = useMemo<StageData>(
    () => ({
      bands: bands.slice(0, 2).map((b) => ({ label: b.poolLabel, lowerPrice: b.lowerPrice, upperPrice: b.upperPrice, activePrice: b.activePrice, bins: b.widthBins })),
      feesSol: feesAll,
      chart: chart?.coins,
    }),
    [bands, feesAll, chart],
  );

  // THE CHAPTERS
  const beats = useMemo<Beat[]>(() => {
    const m = narrative.headline.match(/^(.*?\bis (?:up|down|about flat))\s+(.*)$/);
    const words = narrative.headline.split(" ");
    const [h1, h2] = m ? [m[1], m[2]] : [words.slice(0, Math.ceil(words.length / 2)).join(" "), words.slice(Math.ceil(words.length / 2)).join(" ")];
    const first = bands[0] ?? null;
    const bins = bands.reduce((n, b) => n + b.widthBins, 0);
    const nBands = bands.length;
    const moved = actions.filter((a) => a.action === "REBALANCE").length;
    const px = (n: number) => (n >= 1 ? n.toFixed(2) : n.toPrecision(4));
    const crossed = first ? first.activePrice < first.upperPrice : false;
    const where = first ? (first.activePrice > first.upperPrice ? "The price is above his band, so every bin still holds SOL." : first.activePrice < first.lowerPrice ? "The price is below his band, so every bin now holds the token." : "The price is inside his band.") : "";
    const asOf = book.asOf !== null ? new Date(book.asOf).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : null;

    const holding: Beat[] = nBands
      ? bands.map((b, i) => {
          const { base, quote } = pairWords(b.poolLabel);
          const st = bandStatus(b);
          return {
            id: i === 0 ? "holds" : `holds-${i + 1}`,
            station: i < 2 ? `row${i}` : "plan",
            side: i % 2 === 0 ? "right" : "left",
            wide: true,
            eyebrow: `What he holds · ${i + 1} of ${nBands}${asOf ? ` · as of ${asOf}` : ""}`,
            line1: quote ? `${base} / ${quote}` : base,
            line2: st.word,
            tone: st.tone,
            content: <BandBlock band={b} flow={flows.get(b.poolAddress)} now={now} />,
            labels: i < 2 ? bandLabels(i, b) : undefined,
          } satisfies Beat;
        })
      : [
          {
            id: "holds", station: "vault", side: "right", eyebrow: "What he holds", line1: "Nothing,", line2: "this minute.",
            body: <><p>No band is open. He only lays one when a pool's fees are worth the rent and the risk. Until then his SOL is stacked by the hat.</p>{book.lastExit && <p>His last exit: “{book.lastExit.headline}”</p>}</>,
            figure: record ? { value: `${num(record.equityNow)} SOL`, label: "waiting in his wallet" } : null,
          } satisfies Beat,
        ];

    return [
      {
        id: "hero", station: "hero", side: "left", frame: { x: -0.02, y: 0.1 }, frameTall: { x: 0, y: -0.36 },
        eyebrow: new Date(now).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }),
        line1: h1, line2: h2,
        body: <>{narrative.story.slice(0, 2).map((s, i) => <p key={i}>{s}</p>)}</>,
        links: [{ href: "#lays", label: "See how he works" }, ...(walletAddress ? [{ href: `https://solscan.io/account/${walletAddress}`, label: "His wallet", external: true }] : [])],
      },
      {
        id: "lays", station: "rows", side: "left", frame: { x: 0.2, y: 0.08 }, eyebrow: "I · The band", line1: "He lays SOL", line2: "under the price.",
        body: nBands ? <><p>A band is a row of price bins. In each bin under the market he leaves SOL, offered to anyone who wants to sell him the token there.</p><p>Each strapped bundle on the desk is one bin of his SOL.</p></> : <><p>A band is a row of price bins with his SOL laid in them. He holds none right now.</p><p>His SOL is stacked by the hat until a pool is worth it.</p></>,
        figure: record ? (nBands ? { value: `${num(record.atWork)} SOL`, label: `at work in ${nBands} band${nBands === 1 ? "" : "s"}, ${bins} bins in all` } : { value: `${num(record.equityNow)} SOL`, label: "waiting in his wallet" }) : null,
      },
      {
        id: "cross", station: "cursor", side: "right", frame: { x: -0.2, y: 0.04 }, eyebrow: "II · The crossing", line1: "Traders cross his band.", line2: "He gets paid.",
        body: <><p>When the price falls into a bin, his SOL there buys the token. When it climbs back out, he sells it again. {crossed ? "The dark slabs are bins the price has already crossed." : "The brass cursor is the price. It stands above his band, so no bin has been crossed yet."}</p><p>Every crossing pays him the pool's fee.</p></>,
        figure: first ? { value: px(first.activePrice), label: `${first.poolLabel} now. His band runs from ${px(first.lowerPrice)} to ${px(first.upperPrice)}. ${where}` } : null,
      },
      ...holding,
      {
        id: "fees", station: "dish", side: "left", eyebrow: "III · The dish", line1: "Fees fall", line2: "into the dish.",
        body: <><p>One coin for every tenth of a SOL traders have paid him. Claimed fees go back to his wallet as SOL.</p>{flowTotals && flowTotals.fees60mSol > 0 && <p>In the last hour his pools paid {num(flowTotals.fees60mSol)} SOL to everyone making a market there.</p>}</>,
        figure: record ? { value: `${num(feesAll)} SOL`, label: "in fees since he started" } : null,
      },
      ...(record && chart
        ? [{
            id: "made", station: "chart", side: "left", wide: true, eyebrow: "What he made", line1: "He has been paid", line2: `${num(feesAll)} SOL in fees.`,
            content: <MadeBlock record={record} solPriceUsd={solPriceUsd} now={now} chart={chart} />,
          } satisfies Beat]
        : []),
      {
        id: "relay", station: "plan", side: "right", frame: { x: -0.2, y: 0.02 }, eyebrow: "IV · The re-lay", line1: "Price walks away.", line2: "He lays it again.",
        body: <><p>A band the price has left earns nothing. He waits for a quiet minute, then lays it under the price again.</p><p>Moving costs a little, so he counts that too, and he writes down what each band taught him.</p></>,
        figure: { value: `${moved}`, label: `band${moved === 1 ? "" : "s"} moved so far, each one in the ledger below` },
      },
      {
        id: "record", station: "ledger", side: "left", wide: true, eyebrow: "V · The record", line1: "Every move", line2: "is on the record.",
        body: <><p>This page is printed from his journal and nothing else. {walletAddress ? "The wallet is his own, and anyone can read it on Solana." : ""}</p></>,
        content: <StatementList rows={statementRows({ record, summary: selected, solPriceUsd, status, now, stamp })} />,
        links: walletAddress ? [{ href: `https://solscan.io/account/${walletAddress}`, label: "His wallet on Solscan", external: true }] : undefined,
      },
      {
        id: "did", station: "tape", side: "left", wide: true, eyebrow: "What he did", line1: "Each move,", line2: "newest first.",
        body: <><p>One sentence a move, with the money it realised and its transaction. Holds are not moves.</p></>,
        content: <Actions actions={actions} status={status} now={now} agentName={agentName} />,
      },
      {
        id: "house", station: "hat", side: "right", eyebrow: "The house", line1: "Liquidity", line2: "in between.",
        content: <ClosingBlock agentName={agentName} />,
      },
    ];
  }, [narrative, bands, book, record, actions, flows, flowTotals, feesAll, chart, walletAddress, solPriceUsd, selected, status, stamp, agentName, now]);

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

  // The chapters mount once the journal has loaded, so a deep link (#made, #did) has nothing to
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
    document.documentElement.style.colorScheme = "light";
    return () => {
      document.documentElement.style.colorScheme = "";
    };
  }, [agentName, record, narrative.headline]);

  return (
    <div className="dash">
      <EngraveDefs />
      <DashNav status={status} agentName={agentName} />
      {error && !entries && (
        <div className="error dash__error">
          Could not load the journal: <code>{error}</code>.
        </div>
      )}
      <Journey beats={beats} data={stageData} heroFoot={<TickerTape actions={actions} agentName={agentName} />} />
    </div>
  );
}
