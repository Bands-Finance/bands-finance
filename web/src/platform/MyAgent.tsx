import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { AgentSettings, FocusArea } from "../types";
import { useAccount } from "./AccountProvider";
import { shortAddress } from "./useBandsAccount";
import { useMyAgent } from "./useMyAgent";
import { useBandsCli, type CliLine } from "./useBandsCli";
import "../components/AgentTerminal.css";
import "./MyAgent.css";

/**
 * "Your Mr Bands": the #/me page. Ports the surface of Meridian's MeridianCli.tsx into the desk's
 * terminal vocabulary (AgentTerminal.css, the same chrome Desk.tsx uses).
 *
 * Three honest states: no API behind the site (one paragraph, nothing interactive), an API but no
 * session (connect / sign in), a session (the terminal: chat, slash commands, credits, settings).
 * Chat goes through useMyAgent's streaming send; the CLI hook only routes.
 */

const RISKS = ["conservative", "balanced", "aggressive"] as const;
const STYLES = ["concise", "balanced", "deep"] as const;
const FOCUS: FocusArea[] = ["market-making", "yield", "directional", "research"];

const NO_API_COPY =
  "The platform API is not hosted yet: it is coming with the platform. This page will then let you sign in with a Solana wallet and talk to a Mr Bands of your own; until then the site shows Mr Bands' own journal.";

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}

export function MyAgent() {
  const { api, status, address, token, error, signIn, signOut, connecting } = useAccount();
  return (
    <main className="app__tabview">
      <section className="app__desk me" aria-label="Your Mr Bands">
        <div className="app__desk-head">
          <span className="eyebrow me__eyebrow">your own mr bands · it talks, it never trades</span>
          <h2 className="app__desk-title">Your Mr Bands</h2>
          <p className="app__desk-sub">
            Sign in with a Solana wallet and talk to a Mr Bands of your own that reads the same desk Mr Bands works from: his journal, his pool screen, the guards
            around him. It talks; it never holds a key and cannot move funds, and nothing it says is financial advice. Slash commands shape it; messages ask it things.
          </p>
        </div>

        {api === null && <p className="me__note">checking for the platform API…</p>}
        {api === false && <p className="me__note me__note--plain">{NO_API_COPY}</p>}

        {api === true && (
          <>
            <div className="me__account" role="group" aria-label="Wallet">
              <span className={`me__dot me__dot--${status}`} aria-hidden="true" />
              <span className="me__state">
                {status === "guest" && "no wallet connected"}
                {status === "connected" && address && `${shortAddress(address)} connected, not signed in`}
                {status === "signing" && "check your wallet for the sign-in message"}
                {status === "signed-in" && address && `signed in as ${shortAddress(address)}`}
              </span>
              <span className="me__spacer" />
              {status === "guest" && (
                <button className="me__btn me__btn--primary" onClick={signIn} disabled={connecting}>
                  {connecting ? "connecting…" : "connect wallet"}
                </button>
              )}
              {status === "connected" && (
                <button className="me__btn me__btn--primary" onClick={signIn}>
                  sign in
                </button>
              )}
              {status === "signing" && (
                <button className="me__btn me__btn--primary" disabled>
                  signing…
                </button>
              )}
              {(status === "connected" || status === "signed-in") && (
                <button className="me__btn" onClick={signOut}>
                  {status === "signed-in" ? "sign out" : "disconnect"}
                </button>
              )}
            </div>
            {error && <p className="me__err">{error}</p>}
            {status !== "signed-in" && (
              <p className="me__note">
                The signature proves you hold the wallet. It authorizes no transaction and moves nothing; bands.finance never sees a key.
              </p>
            )}
            {status === "signed-in" && token && address && <AdvisorTerminal token={token} address={address} />}
          </>
        )}
      </section>
    </main>
  );
}

/* ---------- the terminal ---------- */

function AdvisorTerminal({ token, address }: { token: string; address: string }) {
  const agent = useMyAgent(token);
  const cli = useBandsCli(token, agent.setSettings);
  const [input, setInput] = useState("");
  const [hint, setHint] = useState<string[]>([]);
  const [drawer, setDrawer] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const greeted = useRef(false);
  const streaming = useRef(false);
  const who = shortAddress(address);

  // One greeting, once, and only when the agent is actually reachable. Prior conversation goes in
  // FIRST and in order, because it happened first.
  useEffect(() => {
    if (greeted.current || agent.state === "provisioning" || agent.state === "idle") return;
    greeted.current = true;
    if (agent.state === "error") {
      cli.print([{ kind: "error", text: agent.error ?? "could not reach your mr bands." }]);
      return;
    }
    const prior = agent.messages;
    const notConfigured = agent.configured === false;
    cli.print([
      ...prior.map((m) => ({ kind: m.role === "user" ? ("input" as const) : ("agent" as const), text: m.content })),
      notConfigured
        ? { kind: "error" as const, text: "your mr bands is not configured on this host: no model key. commands still work; messages will be refused.", suggest: ["/status", "/help"] }
        : prior.length
          ? { kind: "system" as const, text: `${agent.name} is live.`, suggest: ["/help"] }
          : {
              kind: "system" as const,
              text: `${agent.name} is live and it is yours. it reads his desk every turn and remembers this conversation.`,
              suggest: ["what is on his book today?", "/explore", "/help"],
            },
    ]);
  }, [agent.state, agent.name, agent.messages, agent.configured, agent.error, cli]);

  // Stream the reply into the line reserved for it when the message was sent.
  const last = agent.messages[agent.messages.length - 1];
  const lastText = last?.role === "assistant" ? last.content : null;
  const lastPending = last?.role === "assistant" ? last.pending === true : false;
  useEffect(() => {
    if (!streaming.current || lastText === null) return;
    const finished = !lastPending;
    cli.updateLast({ text: finished && !lastText ? "no reply came back. try again." : lastText, streaming: lastPending });
    if (finished) streaming.current = false;
  }, [lastText, lastPending, cli]);

  // A turn that failed before any text: the reserved line becomes the error.
  useEffect(() => {
    if (!streaming.current || !agent.error) return;
    cli.updateLast({ kind: "error", text: agent.error, streaming: false });
    streaming.current = false;
  }, [agent.error, cli]);

  // Follow the tail as output arrives, including mid-stream.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [cli.lines]);

  const runLine = useCallback(
    async (line: string) => {
      if (!line.trim() || cli.busy || agent.state === "thinking") return;
      setInput("");
      setHint([]);
      const { chat } = await cli.run(line);
      if (chat) {
        streaming.current = true;
        cli.print([{ kind: "agent", text: "", streaming: true }]);
        await agent.send(chat);
        streaming.current = false;
      }
    },
    [cli, agent],
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void runLine(input);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const { value, options } = cli.complete(input);
      setInput(value);
      setHint(options);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const recalled = cli.recall(e.key === "ArrowUp" ? -1 : 1);
      if (recalled !== null) {
        e.preventDefault();
        setInput(recalled);
      }
    } else if (e.key === "l" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      cli.setLines([]);
    }
  };

  const dot = agent.state === "error" ? "offline" : agent.state === "ready" ? "live" : "connecting";
  const thinking = agent.state === "thinking";
  const creditsLabel =
    agent.credits === null ? null : agent.creditsInfo?.enforced ? `${agent.credits} credit${agent.credits === 1 ? "" : "s"}` : `${agent.credits} credits · free right now`;

  return (
    <>
      <div className="me__bar">
        <span className="me__chip" title="1 credit = 1 message. Commands are free.">
          {creditsLabel ?? "credits ·"}
        </span>
        {agent.outOfCredits && <span className="me__chip me__chip--warn">out of credits; buying is not wired on this host yet</span>}
        <span className="me__spacer" />
        <button className="me__btn" onClick={() => setDrawer((v) => !v)} aria-expanded={drawer}>
          {drawer ? "close settings" : "configure"}
        </button>
      </div>
      {drawer && <SettingsDrawer settings={agent.settings} onSave={agent.saveSettings} onClose={() => setDrawer(false)} />}

      <div className="term term--me" onClick={() => inputRef.current?.focus()}>
        <div className="term__chrome">
          <span className="term__dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="term__title">
            {agent.agentId ?? `bands-u-${who}`} · {agent.name} · your mr bands
          </span>
          <span className={`term__status term__status--${dot}`}>
            <span className="term__status-dot" />
            {dot}
          </span>
        </div>

        <div className="term__body" ref={bodyRef}>
          <p className="term__boot">
            {agent.name} · keyed to {who} · reads Mr Bands' journal, screen and guards each turn · holds no key, moves nothing · messages
            {agent.creditsInfo?.enforced ? " cost 1 credit" : " are free right now"} · commands are free
          </p>

          {agent.state === "provisioning" && <p className="term__line term__line--dim">// setting up your mr bands…</p>}

          {cli.lines.map((l, i) => (
            <Line key={`${l.ts}-${i}`} line={l} who={who} isLast={i === cli.lines.length - 1} onRun={runLine} disabled={cli.busy || thinking} />
          ))}

          {hint.length > 0 && (
            <div className="me__chips">
              {hint.map((h) => (
                <button
                  key={h}
                  className="me__chip me__chip--cmd"
                  onClick={() => {
                    setInput(`/${h} `);
                    setHint([]);
                    inputRef.current?.focus();
                  }}
                >
                  /{h}
                </button>
              ))}
            </div>
          )}

          <p className="term__hint">// message, or /help. tab completes, up/down recalls.</p>
          <form className="term__input-row" onSubmit={onSubmit}>
            <span className="term__user term__user--guest">{who}@bands</span>
            <span className="term__path">:~</span>$&nbsp;
            <input
              ref={inputRef}
              className="term__input"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setHint([]);
              }}
              onKeyDown={onKey}
              placeholder={thinking ? `${agent.name} is thinking…` : "message, or /help"}
              disabled={agent.state === "provisioning" || agent.state === "error"}
              maxLength={2000}
              spellCheck={false}
              autoComplete="off"
              aria-label="Your Mr Bands' input"
            />
          </form>
        </div>
      </div>
    </>
  );
}

function Line({ line, who, isLast, onRun, disabled }: { line: CliLine; who: string; isLast: boolean; onRun: (l: string) => void; disabled: boolean }) {
  const chips = line.suggest?.length ? (
    <div className="me__chips">
      {line.suggest.map((s) => (
        <button key={s} className={`me__chip${s.startsWith("/") ? " me__chip--cmd" : ""}`} onClick={() => onRun(s)} disabled={disabled}>
          {s}
        </button>
      ))}
    </div>
  ) : null;

  if (line.kind === "input" || line.kind === "command") {
    return (
      <p className="term__prompt">
        <span className="term__time">[{timeOf(line.ts)}]</span> <span className="term__user term__user--guest">{who}@bands</span>
        <span className="term__path">:~</span>$ <span className={line.kind === "command" ? "term__cmd" : "me__said"}>{line.text}</span>
      </p>
    );
  }
  if (line.kind === "agent") {
    return (
      <div className="me__reply">
        {line.text}
        {line.streaming && isLast && <span className="term__cursor" aria-hidden="true" />}
        {chips}
      </div>
    );
  }
  return (
    <>
      <p className={`term__line${line.kind === "error" ? " me__line--err" : line.kind === "system" ? " term__line--dim" : ""}`}>
        <span className="term__caret">›</span> {line.text}
      </p>
      {chips}
    </>
  );
}

/* ---------- settings drawer ---------- */

function SettingsDrawer({ settings, onSave, onClose }: { settings: AgentSettings; onSave: (p: Partial<AgentSettings>) => Promise<string | null>; onClose: () => void }) {
  const [name, setName] = useState(settings.name ?? "");
  const [risk, setRisk] = useState<string>(settings.riskAppetite ?? "balanced");
  const [style, setStyle] = useState<string>(settings.style ?? "balanced");
  const [focus, setFocus] = useState<FocusArea[]>(settings.focus ?? []);
  const [goal, setGoal] = useState(settings.goal ?? "");
  const [voice, setVoice] = useState(settings.voice ?? "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const toggleFocus = (f: FocusArea) => setFocus((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    const patch: Partial<AgentSettings> = {
      name: name.trim(),
      riskAppetite: risk as AgentSettings["riskAppetite"],
      style: style as AgentSettings["style"],
      focus: focus.length ? focus : FOCUS,
      goal: goal.trim(),
      voice: voice.trim(),
    };
    const err = await onSave(patch);
    setSaving(false);
    setMsg(err ?? "saved. it applies from your next message.");
  };

  return (
    <form className="me__drawer" onSubmit={submit} aria-label="Advisor settings">
      <label className="me__field">
        <span>name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="Mr Bands" />
      </label>
      <label className="me__field">
        <span>risk appetite</span>
        <select value={risk} onChange={(e) => setRisk(e.target.value)}>
          {RISKS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label className="me__field">
        <span>style</span>
        <select value={style} onChange={(e) => setStyle(e.target.value)}>
          {STYLES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="me__field me__field--wide">
        <legend>focus</legend>
        <div className="me__checks">
          {FOCUS.map((f) => (
            <label key={f} className="me__check">
              <input type="checkbox" checked={focus.includes(f)} onChange={() => toggleFocus(f)} /> {f}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="me__field me__field--wide">
        <span>goal</span>
        <input value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={280} placeholder="what you want it working toward" />
      </label>
      <label className="me__field me__field--wide">
        <span>voice</span>
        <input value={voice} onChange={(e) => setVoice(e.target.value)} maxLength={200} placeholder="how it should sound: dry, warm, blunt" />
      </label>
      <div className="me__drawer-actions">
        <button className="me__btn me__btn--primary" type="submit" disabled={saving}>
          {saving ? "saving…" : "save"}
        </button>
        <button className="me__btn" type="button" onClick={onClose}>
          close
        </button>
        {msg && <span className="me__drawer-msg">{msg}</span>}
      </div>
    </form>
  );
}
