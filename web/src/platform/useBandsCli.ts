/**
 * The client half of the bands CLI. Ports Meridian's frontend/src/hooks/useMeridianCli.ts.
 *
 * It owns the transcript, the command history and the completion vocabulary, and it deliberately does
 * NOT own chat. A line without a leading slash is handed back to the caller so it can go through the
 * streaming send in useMyAgent, which already carries the credit debit, the guards and the
 * token-by-token render. Duplicating that here would be a second, quieter way to talk to an agent.
 */
import { useCallback, useRef, useState } from "react";
import type { AgentSettings } from "../types";
import { apiJson } from "./apiBase";

export type CliLineKind = "input" | "command" | "output" | "error" | "agent" | "system";

export interface CliLine {
  kind: CliLineKind;
  text: string;
  /** Set on the line currently streaming, so the UI can show a cursor. */
  streaming?: boolean;
  /** One-tap next steps from the router, attached to the line they belong to. */
  suggest?: string[];
  ts: number;
}

/** Completion vocabulary. Mirrors src/platform/cli.ts. */
export const CLI_COMMANDS = ["help", "whoami", "settings", "credits", "packs", "explore", "clear", "name", "risk", "style", "focus", "goal", "voice", "reset", "status", "pnl", "last", "pools", "guards"] as const;

const ARG_VALUES: Record<string, string[]> = {
  risk: ["conservative", "balanced", "aggressive"],
  style: ["concise", "balanced", "deep"],
  focus: ["market-making", "yield", "directional", "research"],
  reset: ["name", "goal", "voice", "risk", "style", "focus"],
};

interface CliResponse {
  ok?: boolean;
  lines?: string[];
  effect?: string;
  suggest?: string[];
  text?: string;
  settings?: AgentSettings;
}

export function useBandsCli(token: string | null, onSettings?: (s: AgentSettings) => void) {
  const [lines, setLines] = useState<CliLine[]>([]);
  const [busy, setBusy] = useState(false);
  const history = useRef<string[]>([]);
  const historyAt = useRef<number>(-1);

  const print = useCallback((incoming: Array<Omit<CliLine, "ts"> & { ts?: number }>) => {
    const now = Date.now();
    setLines((prev) => {
      // Nothing already on screen is still streaming once something new is printed.
      const settled = prev.some((l) => l.streaming) ? prev.map((l) => (l.streaming ? { ...l, streaming: false } : l)) : prev;
      return [...settled, ...incoming.map((l) => ({ ...l, ts: l.ts ?? now }))];
    });
  }, []);

  /** Rewrite the trailing line in place: how a streaming reply lands in the transcript. */
  const updateLast = useCallback((patch: Partial<CliLine>) => {
    setLines((prev) => {
      if (!prev.length) return prev;
      const next = prev.slice();
      next[next.length - 1] = { ...next[next.length - 1], ...patch };
      return next;
    });
  }, []);

  /** Run one line. Returns the text to send to the agent when the line was a message rather than a command. */
  const run = useCallback(
    async (raw: string): Promise<{ chat?: string }> => {
      const line = raw.trim();
      if (!line) return {};
      if (history.current[history.current.length - 1] !== line) history.current.push(line);
      historyAt.current = -1;

      if (!line.startsWith("/")) {
        print([{ kind: "input", text: line }]);
        return { chat: line };
      }
      print([{ kind: "command", text: line }]);
      if (!token) {
        print([{ kind: "error", text: "sign in to run commands." }]);
        return {};
      }
      setBusy(true);
      try {
        const res = await apiJson<CliResponse>("/api/cli", { body: { line }, token });
        const data = res.json;
        if (!data) {
          print([{ kind: "error", text: `could not reach the desk (HTTP ${res.status}). try again.` }]);
          return {};
        }
        if (data.effect === "clear") {
          setLines([]);
          return {};
        }
        if (data.effect === "chat" && typeof data.text === "string") return { chat: data.text };
        if (data.effect === "settings" && data.ok && data.settings) onSettings?.(data.settings);
        const kind: CliLineKind = data.ok === false ? "error" : "output";
        const out: string[] = Array.isArray(data.lines) ? data.lines : [];
        const suggest = Array.isArray(data.suggest) && data.suggest.length ? data.suggest.map(String) : undefined;
        const printed: Array<Omit<CliLine, "ts">> = out.length ? out.map((t) => ({ kind, text: t })) : [{ kind, text: data.ok === false ? "that did not work." : "done." }];
        if (suggest) printed[printed.length - 1] = { ...printed[printed.length - 1], suggest };
        print(printed);
        return {};
      } catch {
        print([{ kind: "error", text: "could not reach the desk. try again." }]);
        return {};
      } finally {
        setBusy(false);
      }
    },
    [token, print, onSettings],
  );

  /** Up/down through history. Returns the line to put in the input, or null. */
  const recall = useCallback((direction: -1 | 1): string | null => {
    const h = history.current;
    if (!h.length) return null;
    if (historyAt.current === -1) {
      if (direction === 1) return null;
      historyAt.current = h.length - 1;
      return h[historyAt.current];
    }
    const next = historyAt.current + direction;
    if (next < 0) return h[0];
    if (next >= h.length) {
      historyAt.current = -1;
      return "";
    }
    historyAt.current = next;
    return h[next];
  }, []);

  /** Tab completion: the command, then that command's own values. */
  const complete = useCallback((input: string): { value: string; options: string[] } => {
    if (!input.startsWith("/")) return { value: input, options: [] };
    const parts = input.slice(1).split(/\s+/);
    if (parts.length <= 1) {
      const stem = (parts[0] ?? "").toLowerCase();
      const hits = CLI_COMMANDS.filter((c) => c.startsWith(stem));
      if (hits.length === 1) return { value: `/${hits[0]} `, options: [] };
      return { value: input, options: [...hits] };
    }
    const vals = ARG_VALUES[parts[0].toLowerCase()];
    if (!vals) return { value: input, options: [] };
    const stem = (parts[parts.length - 1] ?? "").toLowerCase();
    const hits = vals.filter((v) => v.startsWith(stem));
    if (hits.length === 1) {
      parts[parts.length - 1] = hits[0];
      return { value: `/${parts.join(" ")}`, options: [] };
    }
    return { value: input, options: hits };
  }, []);

  return { lines, print, updateLast, run, recall, complete, busy, setLines };
}
