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
import { liveRunBeat, useLiveRun } from "./stage/LiveRun";
import { useMotion } from "./motion";
import { PLATFORM_URL, TOKEN_URL, X_URL } from "./site";
import "lenis/dist/lenis.css";

/** The desk shows the band the price is inside first: that is where the crossing can be seen. */
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
const roman = (k: number) => ROMAN[k] ?? String(k + 1);

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
  // the live desk's finished run on Solana, frozen in web/public/live-run.json: a chapter of its own after the record
  const liveRun = useLiveRun();

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

  // the newest entry the page holds: when it is no newer than the frozen run's end, the live ledger IS that run
  const newestTs = useMemo(() => agentEntries.reduce((m, e) => Math.max(m, Date.parse(e.ts) || 0), 0), [agentEntries]);
  const didIsTheRun = !!liveRun && status.mode === "live" && newestTs <= liveRun.lastTs;

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
    const live = status.mode === "live";
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
            // the time is one unbreakable word, so a phone never orphans "PM" on its own line
            eyebrow: `What he holds · ${i + 1} of ${nBands}${asOf ? ` · as\u00a0of\u00a0${asOf.replace(/ /g, "\u00a0")}` : ""}`,
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
            figure: record ? { value: `${num(record.equityNow)} SOL`, label: status.mode === "paper" ? "waiting in his paper wallet" : "waiting in his wallet" } : null,
          } satisfies Beat,
        ];

    const chapters: Beat[] = [
      {
        // wide: the picture sits low and a little right so the front tray's bundles stay under the words' last line and the
        // man stands clear of the headline; tall: only a small lift, so his hat is under the nav and his shoes, not his waist,
        // meet the words (the trays he stands over are the next chapter's, and the words' mist may take them)
        id: "hero", station: "hero", side: "left", frame: { x: 0.06, y: 0.28 }, frameTall: { x: 0.03, y: -0.12 },
        // the first line says what he is before any number does
        eyebrow: `${new Date(now).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })} · A market-making agent on Meteora, Solana`,
        line1: h1, line2: h2,
        // the story's first sentence, then the one that says what kind of run this is (paper or live; always the story's
        // last sentence, narrative.ts), so a stranger learns whether the money is real in the first window. Two paragraphs,
        // not three: the words' column must end above the desk's foreground on a wide window and above the man on a phone,
        // and the fee figure the second sentence carried is the holds, dish and made chapters' own.
        body: <>{[narrative.story[0], ...(narrative.story.length > 1 ? [narrative.story[narrative.story.length - 1]] : [])].map((s, i) => <p key={i}>{s}</p>)}</>,
        // the wallet is proof only when the desk is live; a paper run's proof is the code
        links: [{ href: "#lays", label: "See how he works" }, live && walletAddress ? { href: `https://solscan.io/account/${walletAddress}`, label: "His wallet", external: true } : { href: "https://github.com/louz514/bands-finance", label: "The code", external: true }],
      },
      {
        id: "lays", station: "rows", side: "left", frame: { x: 0.2, y: 0.08 }, eyebrow: "The band", line1: "He lays SOL", line2: "under the price.",
        body: nBands ? <><p>A band is a row of price bins. In each bin under the market he leaves SOL, offered to anyone who wants to sell him the token there. Tokenized stocks are one part of his book: there he lays both sides and hedges the stock half short where a perp is listed.</p><p>Each strapped bundle on the desk is one bin of his SOL.</p></> : <><p>A band is a row of price bins with his SOL laid in them. Tokenized stocks are one part of his book: there he lays both sides and hedges the stock half short where a perp is listed. He holds none right now.</p><p>His SOL is stacked by the hat until a pool is worth it.</p></>,
        figure: record ? (nBands ? { value: `${num(record.atWork)} SOL`, label: `at work in ${nBands} band${nBands === 1 ? "" : "s"}, ${bins} bins in all` } : { value: `${num(record.equityNow)} SOL`, label: status.mode === "paper" ? "waiting in his paper wallet" : "waiting in his wallet" }) : null,
      },
      // the sheets come straight after the band they describe: lay, hold, cross, paid. It also keeps the camera on the
      // tray side of the desk (rows -> row0 -> row1) before the long walk round to the cursor and the dish.
      ...holding,
      {
        id: "cross", station: "cursor", side: "right", frame: { x: -0.2, y: 0.04 }, eyebrow: "The crossing", line1: "Traders cross his band.", line2: "He gets paid.",
        // with no band there is no tray, no cursor and no slab on the desk, so the words must not point at them
        body: first
          ? <><p>When the price falls into a bin, his SOL there buys the token. When it climbs back out, he sells it again. {crossed ? "The dark slabs are bins the price has already crossed." : "The brass cursor is the price. It stands above his band, so no bin has been crossed yet."}</p><p>Every crossing pays him the pool's fee.</p></>
          : <><p>He holds no band this minute, so there is nothing for the price to cross. When he lays one, a brass cursor on the tray marks the price, and the bins it has crossed go dark.</p><p>Every crossing pays him the pool's fee.</p></>,
        figure: first ? { value: px(first.activePrice), label: `${first.poolLabel} now. His band runs from ${px(first.lowerPrice)} to ${px(first.upperPrice)}. ${where}` } : null,
      },
      {
        id: "fees", station: "dish", side: "left", eyebrow: "The dish", line1: "Fees fall", line2: "into the dish.",
        body: <><p>One coin for every tenth of a SOL traders have paid him. Claimed fees go back to his wallet as SOL.</p>{flowTotals && flowTotals.fees60mSol > 0 && <p>In the last hour his pools paid {num(flowTotals.fees60mSol)} SOL to everyone making a market there.</p>}</>,
        figure: record ? { value: `${num(feesAll)} SOL`, label: "in fees since he started" } : null,
      },
      ...(record && chart
        ? [{
            // "paid" only once something has been claimed; until then the fees are earned and still in the bands, and the
            // headline says so rather than sit over a "Claimed +0"
            id: "made", station: "chart", side: "left", wide: true, eyebrow: status.mode === "paper" ? "What he made on paper" : "What he made", line1: "He has earned", line2: record.feesRealized < 0.0005 ? `${num(feesAll)} SOL, unclaimed.` : `${num(feesAll)} SOL in fees.`,
            content: <MadeBlock record={record} solPriceUsd={solPriceUsd} now={now} chart={chart} />,
          } satisfies Beat]
        : []),
      {
        id: "relay", station: "plan", side: "right", frame: { x: -0.2, y: 0.02 }, eyebrow: "The re-lay", line1: "Price walks away.", line2: "He lays it again.",
        body: <><p>A band the price has left earns nothing. He waits for a quiet minute, then lays it under the price again.</p><p>Moving costs a little, so he counts that too, and he writes down what each band taught him.</p></>,
        // no ledger is promised below when there is none yet to show
        figure: moved === 0 ? { value: "0", label: "bands moved yet; a band moves only once the price has walked out of it" } : { value: `${moved}`, label: `band${moved === 1 ? "" : "s"} moved so far, each one in the ledger below` },
      },
      {
        id: "record", station: "ledger", side: "left", wide: true, eyebrow: "The record", line1: "Every move", line2: "is on the record.",
        // only a live book is on Solana; a paper book says what it is (the same gate the note uses, components/Dash.tsx)
        body: <><p>This page is printed from his journal and nothing else. {live && walletAddress ? "The wallet is his own, and anyone can read it on Solana." : status.mode === "paper" ? "This is paper trading: real Meteora pools at live prices, a pretend wallet." : ""}</p></>,
        content: <StatementList rows={statementRows({ record, summary: selected, solPriceUsd, status, now, stamp })} />,
        links: live && walletAddress ? [{ href: `https://solscan.io/account/${walletAddress}`, label: "His wallet on Solscan", external: true }] : undefined,
      },
      // what the live desk did on Solana, when there is a frozen run to show
      ...(liveRun ? [liveRunBeat(liveRun, now, status.mode)] : []),
      // a ledger with nothing in it is not a chapter: with no executed move the page goes from the record to the close;
      // and while the live feed still holds the frozen run and nothing newer, the ledger would print that run twice
      ...(actions.length && !didIsTheRun
        ? [{
            id: "did", station: "tape", side: "left", wide: true, eyebrow: status.mode === "paper" ? "What he did on paper" : "What he did", line1: "Each move,", line2: "newest first.",
            body: <><p>One sentence a move, with the money it realised{live ? " and its transaction" : ""}. Holds are not moves.</p></>,
            content: <Actions actions={actions} status={status} now={now} agentName={agentName} />,
          } satisfies Beat]
        : []),
      {
        // the ask, at the cigar hand (a station the desk already carries). Only what is true today: his tools are built and
        // served over MCP on his own host, the public door at bands.finance is not open yet, and no call is paid for (the x402
        // gate is not taking real payments). The token is announced for the Clawrena and not minted, so it is "coming", never
        // "trading"; whenever it is named so is its owner, and the copycat $BANDS is named as not his (docs/sprint.md;
        // docs/mr-bands-agent.md, hard rule 6). The ClawPump and X links print only once those pages exist (site.ts).
        id: "hire", station: "hands", side: "left", frame: { x: 0.04, y: 0.06 }, frameTall: { x: 0.04, y: 0.12 }, eyebrow: "For other agents", line1: "His tools,", line2: "soon for yours.",
        body: <><p>What he works with is built as tools other agents can call: his screener, his pool reads and the guards that judge a band. Today they are served over MCP on his own machine. The public door at bands.finance is coming for the AnsemHack Clawrena, and nothing is sold until it opens.</p><p>His token, $BANDS, is coming to ClawPump for the Clawrena, and no mint exists yet. It will be his own token, not a share of anything. It will pay holders nothing; its creator fees will go to his own operating wallet, to pay for what he runs on. The desk holds none and never trades it, a rule in code, and he does not call its price. A "Mr Bands" $BANDS already trading on pump.fun (mint JAARLU...pJ6m) is a copycat and not his: his will be the mint this page links to once it launches.</p></>,
        links: [
          { href: `${PLATFORM_URL}/#/learn`, label: "His tools", external: true },
          ...(TOKEN_URL ? [{ href: TOKEN_URL, label: "$BANDS on ClawPump", external: true }] : []),
          ...(X_URL ? [{ href: X_URL, label: "Follow him on X", external: true }] : []),
          { href: "https://github.com/louz514/bands-finance", label: "The code", external: true },
        ],
      },
      {
        id: "house", station: "him", side: "right", travel: 3.2, frameTall: { x: 0, y: -0.14 }, eyebrow: "The house", line1: "Liquidity", line2: "in between.",
        // the wallet is proof only when the desk is live: the same gate as the hero and the record
        content: <ClosingBlock agentName={agentName} walletAddress={live && walletAddress ? walletAddress : null} />,
      },
    ];
    // THE NUMERALS: every chapter between the hero and the house carries one, in the order it appears, sheets included,
    // so the count never skips. A chapter added later (the live run, after "The record") is numbered by its place.
    let k = 0;
    return chapters.map((b) => (b.id === "hero" || b.id === "house" ? b : { ...b, eyebrow: `${roman(k++)} · ${b.eyebrow}` }));
  }, [narrative, bands, book, record, actions, flows, flowTotals, feesAll, chart, walletAddress, solPriceUsd, selected, status, stamp, agentName, now, liveRun, didIsTheRun]);

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
      <DashNav status={status} agentName={agentName} hasMoves={actions.length > 0 && !didIsTheRun} hasLived={!!liveRun} />
      {error && !entries && (
        <div className="error dash__error">
          Could not load the journal: <code>{error}</code>.
        </div>
      )}
      <Journey beats={beats} data={stageData} heroFoot={<TickerTape actions={actions} agentName={agentName} />} />
    </div>
  );
}
