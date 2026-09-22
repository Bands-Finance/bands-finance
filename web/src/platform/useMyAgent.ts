/**
 * Talks to the signed-in wallet's own Mr Bands. Ports Meridian's frontend/src/hooks/useMyAgent.ts.
 * On first mount with a session bearer it ensures (idempotently) the agent and loads the prior thread,
 * then relays each message to POST /api/my-agent/stream and renders the tokens as they arrive. The
 * bearer authenticates every call; no bearer means no agent surface.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSettings, ChatTurn, CreditsInfo } from "../types";
import { apiJson, apiUrl } from "./apiBase";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
}

export type AgentState = "idle" | "provisioning" | "ready" | "thinking" | "error";

interface EnsureResponse {
  ok: boolean;
  error?: string;
  agentId?: string;
  name?: string;
  settings?: AgentSettings;
  credits?: number;
  created?: boolean;
  /** whether this host has a model behind your mr bands at all */
  configured?: boolean;
}

export function useMyAgent(token: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [state, setState] = useState<AgentState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AgentSettings>({});
  const [agentId, setAgentId] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [credits, setCredits] = useState<number | null>(null);
  const [creditsInfo, setCreditsInfo] = useState<CreditsInfo | null>(null);
  const [outOfCredits, setOutOfCredits] = useState(false);
  const provisionedFor = useRef<string | null>(null);

  const refreshCredits = useCallback(async () => {
    if (!token) return;
    const r = await apiJson<CreditsInfo & { ok: boolean }>("/api/my-agent/credits", { token }).catch(() => null);
    if (r?.ok && r.json) {
      setCreditsInfo({ balance: r.json.balance, freeMessages: r.json.freeMessages, packs: r.json.packs, enforced: r.json.enforced });
      setCredits(r.json.balance);
    }
  }, [token]);

  // Provision + load history when a session appears (once per token).
  useEffect(() => {
    if (!token) {
      setState("idle");
      setMessages([]);
      setAgentId(null);
      return;
    }
    if (provisionedFor.current === token) return;
    provisionedFor.current = token;
    let cancelled = false;
    (async () => {
      setState("provisioning");
      setError(null);
      try {
        const ensured = await apiJson<EnsureResponse>("/api/my-agent/ensure", { method: "POST", token });
        if (!ensured.json?.ok) throw new Error(ensured.json?.error ?? (ensured.status === 401 ? "your session expired; sign in again" : "could not reach your mr bands"));
        if (cancelled) return;
        setSettings(ensured.json.settings ?? {});
        setAgentId(ensured.json.agentId ?? null);
        setConfigured(ensured.json.configured ?? null);
        if (typeof ensured.json.credits === "number") setCredits(ensured.json.credits);
        const hist = await apiJson<{ turns?: ChatTurn[] }>("/api/my-agent/history", { token });
        if (cancelled) return;
        setMessages((hist.json?.turns ?? []).filter((t) => t.role === "user" || t.role === "assistant").map((t) => ({ role: t.role, content: t.content })));
        void refreshCredits();
        setState("ready");
      } catch (e) {
        if (cancelled) return;
        provisionedFor.current = null;
        setError(e instanceof Error ? e.message : "could not reach your mr bands");
        setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, refreshCredits]);

  // Update the trailing (pending) assistant bubble in place as tokens stream in.
  const setAssistant = useCallback((content: string, pending: boolean) => {
    setMessages((m) => {
      const next = [...m];
      const last = next.length - 1;
      if (last >= 0 && next[last].role === "assistant") next[last] = { role: "assistant", content, pending };
      return next;
    });
  }, []);

  const send = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed || !token || state === "thinking" || state === "provisioning") return;
      setError(null);
      setOutOfCredits(false);
      setMessages((m) => [...m, { role: "user", content: trimmed }, { role: "assistant", content: "", pending: true }]);
      setState("thinking");
      try {
        const res = await fetch(apiUrl("/api/my-agent/stream"), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ text: trimmed }),
        });
        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => null)) as { error?: string; code?: string; balance?: number } | null;
          // An empty balance is a checkout moment, not a failure: drop the pending bubble and keep
          // the user's message on screen.
          if (res.status === 402 && j?.code === "out_of_credits") {
            setMessages((m) => m.slice(0, -1));
            setCredits(j.balance ?? 0);
            setOutOfCredits(true);
            setState("ready");
            return;
          }
          throw new Error(j?.error ?? (res.status === 401 ? "your session expired; sign in again" : `your mr bands could not respond (HTTP ${res.status})`));
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let acc = "";
        let failed: string | null = null;
        // SSE: frames separated by a blank line; each carries `event:` and `data:` lines.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            let event = "message";
            let data = "";
            for (const line of frame.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            let ev: { text?: string; credits?: number; error?: string } = {};
            try {
              ev = data ? (JSON.parse(data) as typeof ev) : {};
            } catch {
              continue;
            }
            if (event === "token") {
              acc += ev.text ?? "";
              setAssistant(acc, true);
            } else if (event === "done") {
              if (typeof ev.credits === "number") setCredits(ev.credits);
            } else if (event === "error") {
              failed = ev.error || "your mr bands could not respond";
              if (typeof ev.credits === "number") setCredits(ev.credits);
            }
          }
        }
        if (failed && !acc) {
          setMessages((m) => m.slice(0, -1));
          setError(failed);
        } else {
          setAssistant(acc || "no reply came back. try again.", false);
          if (failed) setError(failed);
        }
        setState("ready");
      } catch (e) {
        setMessages((m) => m.slice(0, -1));
        setError(e instanceof Error ? e.message : "send failed");
        setState("ready");
      }
    },
    [token, state, setAssistant],
  );

  /** Update any subset of this wallet's agent settings. Returns null on success, or an error string. */
  const saveSettings = useCallback(
    async (patch: Partial<AgentSettings>): Promise<string | null> => {
      if (!token) return "not signed in.";
      try {
        const r = await apiJson<{ ok: boolean; error?: string; settings?: AgentSettings }>("/api/my-agent/settings", { body: patch, token });
        if (!r.ok || !r.json?.ok) return r.json?.error ?? "could not save.";
        setSettings(r.json.settings ?? {});
        return null;
      } catch {
        return "could not reach your mr bands.";
      }
    },
    [token],
  );

  return {
    messages,
    state,
    error,
    send,
    settings,
    setSettings,
    name: settings.name || "Mr Bands",
    agentId,
    configured,
    saveSettings,
    credits,
    creditsInfo,
    refreshCredits,
    outOfCredits,
  };
}
