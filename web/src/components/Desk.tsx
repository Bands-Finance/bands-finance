import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { JournalEntry, RiskLimits, ScreenResult } from "../types";
import { ACTION_WORDS, bookOf, deskBlocks, GLOSS, VERDICT_LABEL, type DeskBlock, type Status, type Verdict } from "../model";
import { clock, fmtPrice, fmtSol } from "../format";
import { useReveal } from "../hooks/useReveal";
import "./AgentTerminal.css";

/**
 * The desk: Mr Bands' decision journal rendered as a live terminal, ported from
 * Meridian's AgentTerminal. Every block is one real journal entry (or a run of
 * identical holds folded into one), oldest first like a scrollback. A read-only
 * guest console at the bottom answers a handful of commands from props alone —
 * no network, nothing the visitor types leaves the page.
 */

export interface DeskProps {
  /** newest first, one agent */
  entries: JournalEntry[];
  status: Status;
  limits: RiskLimits | null;
  screen: ScreenResult | null;
  agentName: string;
  id?: string;
}

const MAX_BLOCKS = 60;
const STALE_MS = 15 * 60e3;
const CONSOLE_KEEP = 20;

const GLYPH: Record<Verdict, string> = { placed: "✓", simulated: "◐", failed: "✕", blocked: "⊘", override: "⚠", hold: "○" };

type Dot = "live" | "paper" | "rehearsal" | "demo" | "standby";

/** The status light in the chrome: what the reader can expect from the feed right now. */
function dotOf(status: Status): Dot {
  if (status.mode === "demo") return "demo";
  if (status.ageMs === null || status.ageMs > STALE_MS) return "standby";
  return status.mode === "live" ? "live" : status.mode === "paper" ? "paper" : "rehearsal";
}

function timeOf(ts: string): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}

/**
 * Cheap identity for a newest-first journal slice. The page polls and hands
 * us a fresh array every tick even when nothing changed; the journal is
 * append-only, so length plus the two end ids is enough to tell a real change
 * from a re-fetch. Same idea as Meridian's dedupe-by-payload: identical data
 * must not re-run the autoscroll and yank the reader out of the scrollback.
 */
function sigOf(entries: JournalEntry[]): string {
  return `${entries.length}|${entries[0]?.id ?? ""}|${entries[entries.length - 1]?.id ?? ""}`;
}

/** A glossed word. The definition rides on the title; global.css draws the dotted underline. */
function Gloss({ term, children }: { term: keyof typeof GLOSS; children: ReactNode }) {
  return (
    <span className="term" title={GLOSS[term]} tabIndex={0}>
      {children}
    </span>
  );
}

function Line({ dim, className, children }: { dim?: boolean; className?: string; children: ReactNode }) {
  return (
    <p className={`term__line${dim ? " term__line--dim" : ""}${className ? ` ${className}` : ""}`}>
      <span className="term__caret">›</span> {children}
    </p>
  );
}

/* ---------- the guest console: every answer comes from props ---------- */

interface ConsoleEntry {
  cmd: string;
  lines: string[];
}

const START_LINES = [
  "1. He reads the pool: price, the bins around it, his wallet, his open bands.",
  "2. He writes one decision: open, close, claim fees, move, or hold.",
  "3. The guards check it in plain code.",
  "4. If they say yes, the wallet builds, simulates and (when live) sends the transaction.",
  "5. All of it lands in this journal. Type 'guards', 'bands', 'pools', 'last' or 'help'.",
];

const HELP_LINES = [
  "start   · walk through one decision cycle",
  "guards  · the hard limits around him, in numbers",
  "bands   · every band he has open right now",
  "pools   · the top five pools on his screen",
  "last    · his newest decision, and why",
  "help    · this list",
];

function guardLines(limits: RiskLimits | null): string[] {
  if (!limits) return ["limits not loaded right now. the guards still run in code on his side; this page just cannot show the numbers."];
  return [
    "the guards are plain code, not a prompt. they can veto him or pull him out:",
    `no single band bigger than ${limits.maxPositionSol} SOL`,
    `no more than ${limits.maxTotalExposureSol} SOL out in bands at once`,
    `${limits.gasReserveSol} SOL always kept back in the wallet for gas`,
    `stop-loss: a band down ${limits.stopLossPct}% is closed, whatever he says`,
    `no band wider than ${limits.maxBinWidth} bins`,
    `at most ${limits.maxTxPerDay} actions a day`,
    `at least ${Math.round(limits.minSecondsBetweenActions / 60)} minutes between actions`,
    `a deposit is abandoned past ${limits.maxSlippagePct}% slippage`,
    `he may not open if price moved more than ${limits.maxPriceMovePctPerCycle}% in one cycle`,
  ];
}

function bandLines(entries: JournalEntry[]): string[] {
  const book = bookOf(entries);
  if (book.bands.length === 0) {
    const out = ["flat · no band on the book right now"];
    if (book.lastExit) out.push(`last exit: “${book.lastExit.headline}”`);
    return out;
  }
  return book.bands.map((b) => {
    const state = b.inRange ? "in range, earning" : `out of range by ${Math.abs(b.binsFromRange)} bins`;
    return `${b.poolLabel} · ${fmtPrice(b.lowerPrice)}–${fmtPrice(b.upperPrice)} ${b.priceLabel} · ${state} · worth ${fmtSol(b.worthNow)} · fees waiting ${fmtSol(b.fees)}`;
  });
}

function poolLines(screen: ScreenResult | null): string[] {
  if (!screen || screen.pools.length === 0) return ["no screen loaded"];
  const top = [...screen.pools].sort((a, b) => a.rank - b.rank).slice(0, 5);
  return [
    `top of his screen · ${screen.rankedPools} pools ranked:`,
    ...top.map((p) => `#${p.rank} ${p.name} · score ${p.score.toFixed(0)} · ${p.feeToTvl24hPct === null ? "fees n/a" : `fees ${p.feeToTvl24hPct.toFixed(2)}% of liquidity a day`}`),
  ];
}

function lastLines(blocks: DeskBlock[]): string[] {
  const b = blocks[blocks.length - 1];
  if (!b) return ["nothing in the journal yet"];
  // A plain hold already says "hold" in its label; repeating it as the decision reads as a stutter.
  const what = b.verdict === "hold" && b.action === "HOLD" ? "" : ` · ${b.decision}`;
  return [`[${timeOf(b.last.ts)}] ${b.pool} · ${GLYPH[b.verdict]} ${VERDICT_LABEL[b.verdict]}${what}`, `why: ${b.why}`, `“${b.headline}”`];
}

interface ConsoleContext {
  entries: JournalEntry[];
  limits: RiskLimits | null;
  screen: ScreenResult | null;
  blocks: DeskBlock[];
}

function runCommand(cmd: string, ctx: ConsoleContext): string[] {
  switch (cmd.toLowerCase()) {
    case "start":
      return START_LINES;
    case "help":
      return HELP_LINES;
    case "guards":
      return guardLines(ctx.limits);
    case "bands":
      return bandLines(ctx.entries);
    case "pools":
      return poolLines(ctx.screen);
    case "last":
      return lastLines(ctx.blocks);
    default:
      return ["unknown command. type 'help'"];
  }
}

/* ---------- the component ---------- */

function DeskInner({ entries, status, limits, screen, agentName, id }: DeskProps) {
  const reveal = useReveal<HTMLElement>();
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<ConsoleEntry[]>([]);
  /** commands the reader typed, oldest first, for up/down recall */
  const typed = useRef<string[]>([]);
  /** index into `typed` while recalling; -1 means a fresh prompt */
  const recall = useRef(-1);

  // A re-fetch with identical content must not produce a new `blocks` array:
  // the autoscroll below keys on it.
  const sig = sigOf(entries);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = useMemo(() => entries, [sig]);
  const blocks = useMemo(() => deskBlocks(stable, stable.length).slice(-MAX_BLOCKS), [stable]);

  const agentId = stable[0]?.agent?.id ?? "mr-bands";
  const dot = dotOf(status);
  const demo = status.mode === "demo";

  // Autoscroll like a real terminal: follow the tail only when the reader is
  // already AT the tail. Yanking someone out of the scrollback on every feed
  // update is the single most lag-feeling thing a live view can do.
  const snappedOnce = useRef(false);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    if (!snappedOnce.current || nearBottom) {
      el.scrollTop = el.scrollHeight;
      if (blocks.length > 0) snappedOnce.current = true;
    }
  }, [blocks]);
  // The reader's own command always snaps: they just acted at the prompt.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && history.length) el.scrollTop = el.scrollHeight;
  }, [history]);

  function submit() {
    const cmd = input.trim();
    if (!cmd) return;
    setInput("");
    typed.current = [...typed.current.slice(-(CONSOLE_KEEP - 1)), cmd];
    recall.current = -1;
    const lines = runCommand(cmd, { entries: stable, limits, screen, blocks });
    setHistory((h) => [...h.slice(-(CONSOLE_KEEP - 1)), { cmd, lines }]);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    const list = typed.current;
    if (e.key === "ArrowUp") {
      if (!list.length) return;
      e.preventDefault();
      recall.current = recall.current === -1 ? list.length - 1 : Math.max(0, recall.current - 1);
      setInput(list[recall.current]);
    } else if (e.key === "ArrowDown") {
      if (recall.current === -1) return;
      e.preventDefault();
      recall.current = recall.current + 1 >= list.length ? -1 : recall.current + 1;
      setInput(recall.current === -1 ? "" : list[recall.current]);
    }
  }

  return (
    <section id={id ?? "desk"} className="app__desk reveal" ref={reveal} aria-label={`${agentName} at work`}>
      <div className="app__desk-head">
        <h2 className="app__desk-title">Watch {agentName} work</h2>
        <p className="app__desk-sub">
          His journal, {demo ? <Gloss term="demo">a scripted demo</Gloss> : status.mode === "paper" ? <Gloss term="paper">paper traded</Gloss> : "live"}. Every line below is a real decision he wrote, with the numbers he was looking at when he wrote it. He proposes; the{" "}
          <Gloss term="guards">guards</Gloss> decide; the wallet does only what the guards allow. Type <code>start</code> in the console to walk through one cycle.
        </p>
      </div>

      <div className="term term--desk r-item" style={{ "--ri": 1 } as CSSProperties}>
        <div className="term__chrome">
          <span className="term__dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="term__title">{agentId} · decision journal · Meteora DLMM, Solana</span>
          <span className={`term__status term__status--${dot}`}>
            <span className="term__status-dot" />
            {dot}
          </span>
        </div>

        <div className="term__body" ref={bodyRef}>
          <p className="term__boot">
            {agentId} v0.1 · strategy: concentrated-liquidity <Gloss term="band">bands</Gloss> · venue: Meteora DLMM (Solana) · decides every 5 min per pool · screens every pool every 30 min · mode:{" "}
            {status.mode === "dry-run" ? <Gloss term="dryRun">{status.short}</Gloss> : status.mode === "paper" ? <Gloss term="paper">{status.short}</Gloss> : demo ? <Gloss term="demo">{status.short}</Gloss> : status.short}
          </p>

          {blocks.length === 0 && (
            <p className="term__line term__line--dim">
              // quiet right now · {agentName} speaks every 5 minutes, once per pool he works · most cycles are a hold, and a hold is a decision too
            </p>
          )}

          {blocks.map((b) => {
            const head = ACTION_WORDS[b.action];
            const detail = b.decision.startsWith(head) ? b.decision.slice(head.length) : b.decision;
            const showDecision = b.verdict !== "hold" || b.action !== "HOLD";
            return (
              <div className="term__block" key={b.first.id}>
                <p className="term__prompt">
                  <span className="term__time">[{timeOf(b.first.ts)}]</span> <span className="term__user">{agentId}</span>
                  <span className="term__path">:~/{b.pool}</span>$ <span className="term__cmd">evaluate --cycle {b.first.cycle}</span>
                </p>
                {b.saw.map((s, i) => (
                  <Line key={i}>{s}</Line>
                ))}
                {b.proposed && <Line>he proposed: {b.proposed}</Line>}
                {b.guards && <Line>guards: {b.guards}</Line>}
                <p className={`term__decision term__decision--${b.verdict}`}>
                  {GLYPH[b.verdict]} {VERDICT_LABEL[b.verdict]}
                  {showDecision && (
                    <>
                      {" · "}
                      <span className="term__pair">{head}</span>
                      {detail}
                    </>
                  )}
                  <span className="term__why"> · why: {b.why}</span>
                </p>
                <p className="term__quote">“{b.headline}”</p>
                {b.txs.map((t, i) => (
                  <Line key={`tx${i}`}>
                    {t.label}:{" "}
                    {t.href ? (
                      <a className="term__tx" href={t.href} target="_blank" rel="noreferrer">
                        {t.text} ↗
                      </a>
                    ) : (
                      t.text
                    )}
                  </Line>
                ))}
                {b.count > 1 && (
                  <Line className="term__fold">
                    same read, {b.count} cycles running, {clock(b.first.ts)} → {clock(b.last.ts)}
                  </Line>
                )}
                {b.fallbackNote && <Line dim>note: {b.fallbackNote}</Line>}
              </div>
            );
          })}

          {history.map((h, i) => (
            <div className="term__block" key={`console-${i}`}>
              <p className="term__prompt">
                <span className="term__user term__user--guest">guest@bands</span>
                <span className="term__path">:~</span>$ <span className="term__cmd">{h.cmd}</span>
              </p>
              {h.lines.map((l, j) => (
                <Line key={j}>{l}</Line>
              ))}
            </div>
          ))}

          <p className="term__hint">// read-only console. new here? type 'start'. 'help' lists every command.</p>
          <form
            className="term__input-row"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            onClick={() => inputRef.current?.focus()}
          >
            <span className="term__user term__user--guest">guest@bands</span>
            <span className="term__path">:~</span>$&nbsp;
            <input
              ref={inputRef}
              className="term__input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              placeholder="start"
              maxLength={64}
              spellCheck={false}
              autoComplete="off"
              aria-label={`${agentName} console command`}
            />
          </form>
        </div>
      </div>
    </section>
  );
}

const sameLimits = (a: RiskLimits | null, b: RiskLimits | null) => a === b || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b));

/**
 * The page re-renders on a clock and re-fetches every 20s; neither should
 * touch the desk unless something the desk shows actually changed. Only the
 * status fields the chrome reads are compared, so `ageMs` ticking by itself
 * does nothing until it crosses the stale line.
 */
function sameProps(a: DeskProps, b: DeskProps): boolean {
  return (
    a.id === b.id &&
    a.agentName === b.agentName &&
    a.status.mode === b.status.mode &&
    a.status.short === b.status.short &&
    dotOf(a.status) === dotOf(b.status) &&
    sigOf(a.entries) === sigOf(b.entries) &&
    sameLimits(a.limits, b.limits) &&
    (a.screen?.generatedAt ?? null) === (b.screen?.generatedAt ?? null) &&
    (a.screen?.pools.length ?? 0) === (b.screen?.pools.length ?? 0)
  );
}

export const Desk = memo(DeskInner, sameProps);
