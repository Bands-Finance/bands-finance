/**
 * The bands CLI: one typed line in, lines of text out. Ports Meridian's agent/src/cli/commands.ts.
 *
 * WHY A PURE ROUTER. Every command resolves to a plain object, and nothing in this file reads the
 * network, the clock, a file, or a request. The route wires it to the wallet session; this module
 * can be unit-tested by calling it. That split matters because a command surface is a security
 * boundary: it is user text deciding which capability runs.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It never writes settings itself. Every mutation is expressed
 * as an INTENT that the caller applies through sanitizeSettings, the same validator the settings
 * route uses, because these values are interpolated into the agent's persona prompt.
 *
 * Differences from Meridian: no /swarm and no /buy (no agent feed, no payment rail here); the desk
 * commands are the ones bands.finance can answer from its live files.
 */
import { FOCUS_AREAS, RISK_LEVELS, STYLES, type AgentSettings } from "./settings";

export const DEFAULT_AGENT_NAME = "Mr Bands";

/** What a command wants done. The route applies it; this module only decides. */
export type CliEffect =
  | { kind: "none" }
  /** Apply this patch through sanitizeSettings, then report what changed. */
  | { kind: "settings"; patch: Record<string, unknown> }
  /** Answer from the live desk files (read-only). */
  | { kind: "desk"; command: DeskCommand }
  /** Send this to the user's own agent as a chat turn. */
  | { kind: "chat"; text: string }
  /** Read something the router cannot: balance, packs, settings. */
  | { kind: "read"; what: "credits" | "settings" | "packs" }
  /** Client-side only: wipe the visible transcript. */
  | { kind: "clear" };

export interface CliResult {
  /** Lines to print. Empty when the effect produces the output instead. */
  lines: string[];
  effect: CliEffect;
  /** True when the line was not understood, so the UI can style it as an error. */
  error?: boolean;
  /** One-tap next steps: literal lines to submit, commands or messages. */
  suggest?: string[];
}

const ok = (lines: string[], effect: CliEffect = { kind: "none" }, suggest?: string[]): CliResult =>
  suggest?.length ? { lines, effect, suggest } : { lines, effect };
const err = (lines: string[], suggest?: string[]): CliResult =>
  suggest?.length ? { lines, effect: { kind: "none" }, error: true, suggest } : { lines, effect: { kind: "none" }, error: true };

export const DESK_COMMANDS = ["status", "pnl", "last", "pools", "guards"] as const;
export type DeskCommand = (typeof DESK_COMMANDS)[number];
const DESK = new Set<string>(DESK_COMMANDS);

const HELP = [
  "type a message to talk to your mr bands. commands start with a slash.",
  "",
  "  /explore           a short guided tour, one thing at a time",
  "  /whoami            how your mr bands is set up right now",
  "  /status            what Mr Bands' desk is doing",
  "  /credits           your balance and what spends it",
  "",
  "  /help all          every command",
];

const HELP_ALL = [
  "every command. anything without a slash is a message to your mr bands.",
  "",
  "  shape your mr bands",
  "    /whoami            what it is set to right now",
  "    /name <name>       rename it",
  "    /risk <level>      conservative | balanced | aggressive",
  "    /style <style>     concise | balanced | deep",
  "    /focus <a,b>       market-making, yield, directional, research",
  "    /goal <text>       what you want it working toward",
  "    /voice <text>      how it should sound. dry, warm, blunt, your call",
  "    /reset <field>     clear one setting back to default",
  "",
  "  the desk (Mr Bands' journal, read only)",
  "    /status            mode, pools worked, open bands, how fresh the data is",
  "    /pnl               open bands: worth now against entry, fees waiting",
  "    /last              his newest decision, and why",
  "    /pools             the top of his screen",
  "    /guards            the hard limits around him, in numbers",
  "",
  "  session",
  "    /credits           balance, packs, whether messages are being charged",
  "    /explore           a short tour, one thing at a time",
  "    /clear             clear this transcript",
  "    /help              the short version",
];

/** The tour, ordered by what a new person actually wants to know. */
const TOUR: Array<{ title: string; lines: string[]; tryIt: string }> = [
  {
    title: "your mr bands is keyed to you",
    lines: [
      "it is keyed to your wallet, with its own memory. it remembers this",
      "conversation between visits, and nobody else's mr bands shares it.",
    ],
    tryIt: "what is on his book today?",
  },
  {
    title: "it reads his desk, not a training set",
    lines: [
      "every turn it is handed Mr Bands' newest journal entries and the top of his",
      "pool screen. you can read the same thing it does, without asking it.",
    ],
    tryIt: "/status",
  },
  {
    title: "check it rather than trust it",
    lines: [
      "every figure traces to a journal entry with a timestamp. /last shows his",
      "newest decision with the reasoning he wrote; /pnl shows open bands against entry.",
    ],
    tryIt: "/last",
  },
  {
    title: "shape how it works",
    lines: [
      "risk, style, focus, goal and voice change how it reasons and they stick.",
      "/whoami shows the current setting any time you lose track.",
    ],
    tryIt: "/style concise",
  },
  {
    title: "the market it watches",
    lines: [
      "Meteora DLMM pools on Solana, screened every 30 minutes and ranked by fee",
      "yield, braked by liquidity, age and volatility.",
    ],
    tryIt: "/pools",
  },
  {
    title: "the guards",
    lines: [
      "plain code sits between Mr Bands and the chain: caps, a stop-loss, a cooldown.",
      "it can veto him or pull him out. your mr bands cannot move funds at all.",
    ],
    tryIt: "/guards",
  },
];

const list = (xs: readonly string[]) => xs.join(" | ");

/** Route one line. `settings` is the agent's CURRENT values, never mutated here. */
export function routeCli(raw: string, settings: AgentSettings): CliResult {
  const line = (raw ?? "").trim();
  if (!line) return ok([]);

  // Not a command: it is something to say to the agent. Checked first so a message beginning with
  // a slash-like character (a fraction, a path) is not mistaken for a command.
  if (!line.startsWith("/")) return ok([], { kind: "chat", text: line });

  const [head, ...rest] = line.slice(1).split(/\s+/);
  const cmd = (head ?? "").toLowerCase();
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "":
      return err(["type /help to see what you can do."]);

    case "help":
    case "?":
      if (arg.toLowerCase() === "all") return ok(HELP_ALL);
      return ok(HELP, { kind: "none" }, ["/explore", "/whoami", "/status"]);

    case "clear":
      return ok([], { kind: "clear" });

    case "explore":
    case "tour": {
      const step = Math.max(1, Math.min(TOUR.length, parseInt(arg, 10) || 1));
      const t = TOUR[step - 1];
      const last = step >= TOUR.length;
      return ok(
        [`(${step}/${TOUR.length}) ${t.title}`, ``, ...t.lines, ...(last ? [``, `that is the tour. /help has the full list whenever you want it.`] : [])],
        { kind: "none" },
        last ? [t.tryIt] : [t.tryIt, `/explore ${step + 1}`],
      );
    }

    case "credits":
      return ok([], { kind: "read", what: "credits" });

    case "packs":
    case "buy":
      return ok([], { kind: "read", what: "packs" });

    case "whoami":
    case "settings":
      return ok([], { kind: "read", what: "settings" });

    case "name": {
      if (!arg) return err(["usage: /name <name>", `currently: ${settings.name ?? `${DEFAULT_AGENT_NAME} (default)`}`]);
      return ok([], { kind: "settings", patch: { name: arg } });
    }

    case "risk": {
      const v = arg.toLowerCase();
      if (!v) return err([`usage: /risk <${list(RISK_LEVELS)}>`, `currently: ${settings.riskAppetite ?? "balanced (default)"}`]);
      if (!RISK_LEVELS.includes(v as never)) return err([`"${arg}" is not a risk level. pick one of: ${list(RISK_LEVELS)}`]);
      return ok([], { kind: "settings", patch: { riskAppetite: v } });
    }

    case "style": {
      const v = arg.toLowerCase();
      if (!v) return err([`usage: /style <${list(STYLES)}>`, `currently: ${settings.style ?? "balanced (default)"}`]);
      if (!STYLES.includes(v as never)) return err([`"${arg}" is not a style. pick one of: ${list(STYLES)}`]);
      return ok([], { kind: "settings", patch: { style: v } });
    }

    case "focus": {
      if (!arg) {
        return err([
          `usage: /focus <${list(FOCUS_AREAS)}>  (comma separated, one or more)`,
          `currently: ${settings.focus?.length ? settings.focus.join(", ") : "all areas (default)"}`,
        ]);
      }
      const wanted = arg.toLowerCase().split(/[,\s]+/).filter(Boolean);
      const bad = wanted.filter((w) => !FOCUS_AREAS.includes(w as never));
      if (bad.length) return err([`not a focus area: ${bad.join(", ")}`, `pick from: ${list(FOCUS_AREAS)}`]);
      return ok([], { kind: "settings", patch: { focus: [...new Set(wanted)] } });
    }

    case "goal": {
      if (!arg) return err(["usage: /goal <what you want it working toward>", `currently: ${settings.goal ?? "not set"}`]);
      return ok([], { kind: "settings", patch: { goal: arg } });
    }

    case "voice": {
      if (!arg) {
        return err([
          "usage: /voice <how it should sound>",
          `currently: ${settings.voice ?? "not set"}`,
          `  eg  /voice dry and skeptical, never enthusiastic`,
          `      /voice explain like i am new to this, no jargon`,
        ]);
      }
      return ok([], { kind: "settings", patch: { voice: arg } });
    }

    case "reset": {
      const f = arg.toLowerCase();
      const fields: Record<string, Record<string, unknown>> = {
        name: { name: "" },
        goal: { goal: "" },
        voice: { voice: "" },
        risk: { riskAppetite: "balanced" },
        style: { style: "balanced" },
        focus: { focus: [...FOCUS_AREAS] },
      };
      if (!f || !(f in fields)) return err([`usage: /reset <${Object.keys(fields).join(" | ")}>`]);
      return ok([], { kind: "settings", patch: fields[f] });
    }

    default:
      if (DESK.has(cmd)) return ok([], { kind: "desk", command: cmd as DeskCommand });
      const near = suggest(cmd);
      return err(near.length ? [`"/${cmd}" is not a command. did you mean ${near[0]}?`] : [`"/${cmd}" is not a command. /help lists them.`], near.length ? near : ["/help"]);
  }
}

/** One suggestion for a near-miss, by edit distance on a small fixed vocabulary. */
function suggest(cmd: string): string[] {
  const vocab = ["help", "whoami", "name", "risk", "style", "focus", "goal", "voice", "reset", "credits", "packs", "explore", "clear", ...DESK];
  let best: string | null = null;
  let bestD = Infinity;
  for (const v of vocab) {
    const d = distance(cmd, v);
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return best && bestD <= 2 ? [`/${best}`] : [];
}

function distance(a: string, b: string): number {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return m[a.length][b.length];
}

/** Human summary of an agent's current configuration, for /whoami. */
export function describeSettings(s: AgentSettings): string[] {
  return [
    `name    ${s.name ?? `${DEFAULT_AGENT_NAME} (default)`}`,
    `risk    ${s.riskAppetite ?? "balanced (default)"}`,
    `style   ${s.style ?? "balanced (default)"}`,
    `focus   ${s.focus?.length ? s.focus.join(", ") : "all areas (default)"}`,
    `goal    ${s.goal ?? "not set"}`,
    `voice   ${s.voice ?? "not set"}`,
  ];
}
