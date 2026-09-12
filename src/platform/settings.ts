/**
 * Per-wallet settings for a user's personal Mr Bands. Ports Meridian's agent/src/deploy/agentSettings.ts.
 * An extensible settings OBJECT stored append-only in agent-settings.jsonl, latest row wins per wallet.
 * Everything here is prompt-level: the agent is an advisor, so a preference only exists if it changes
 * how the agent reasons or talks. Enums are validated against fixed sets; the free-text fields (name,
 * goal, voice) are sanitized so nothing a user types can smuggle instructions into the persona.
 *
 * Differences from Meridian: wallets are base58 Solana addresses and case-sensitive (never lowercased),
 * and there is no joinSwarm (bands.finance has no agent-to-agent feed).
 *
 * Ledger row: { address, settings, at }
 */
import { appendLedger, ledgerView } from "../lib/ledger";

const FILE = "agent-settings.jsonl";
const MAX_NAME = 32;
const MAX_GOAL = 280;
const MAX_VOICE = 200;

export const RISK_LEVELS = ["conservative", "balanced", "aggressive"] as const;
export const STYLES = ["concise", "balanced", "deep"] as const;
export const FOCUS_AREAS = ["market-making", "yield", "directional", "research"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type Style = (typeof STYLES)[number];
export type FocusArea = (typeof FOCUS_AREAS)[number];

export interface AgentSettings {
  name?: string;
  riskAppetite?: RiskLevel;
  focus?: FocusArea[];
  style?: Style;
  goal?: string;
  /**
   * How the agent should SOUND. `style` is length; this is character: dry and skeptical, warm and
   * patient, blunt. Free text because a fixed list of personalities is exactly the thing people want
   * to escape, and capped short because a paragraph here is really an instruction in disguise.
   */
  voice?: string;
}

/** Single short line, no control chars, capped. Shared by every free-text field so none of them can
 *  inject newlines/instructions into the persona prompt. */
export function cleanText(raw: unknown, cap: number): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, cap);
  return cleaned.length ? cleaned : null;
}

/**
 * A display name, held to a stricter standard than the other free text: markup and prompt-fence
 * characters come out, because a name is the one field that could end up in a prompt other than
 * its owner's, and 32 characters of instruction shaped like a name is the thing to prevent.
 */
export function sanitizeName(raw: unknown): string | null {
  const cleaned = cleanText(raw, MAX_NAME);
  if (cleaned === null) return null;
  const stripped = cleaned
    .replace(/[<>{}[\]\\`|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length ? stripped : null;
}

/**
 * Validate a partial settings patch from an untrusted request. Returns the cleaned patch (only the
 * fields present and valid), or an error string. A present-but-invalid field is rejected rather than
 * silently dropped, so the UI gets honest feedback. An empty name, goal or voice clears that field.
 */
export function sanitizeSettings(patch: unknown): { settings: Partial<AgentSettings> } | { error: string } {
  if (!patch || typeof patch !== "object") return { error: "invalid settings" };
  const p = patch as Record<string, unknown>;
  const out: Partial<AgentSettings> = {};

  if ("name" in p) {
    if (p.name === "" || p.name == null) out.name = "";
    else {
      const name = sanitizeName(p.name);
      if (!name) return { error: "name must be 1 to 32 usable characters" };
      out.name = name;
    }
  }
  if ("riskAppetite" in p) {
    if (!RISK_LEVELS.includes(p.riskAppetite as RiskLevel)) return { error: `riskAppetite must be one of: ${RISK_LEVELS.join(", ")}` };
    out.riskAppetite = p.riskAppetite as RiskLevel;
  }
  if ("style" in p) {
    if (!STYLES.includes(p.style as Style)) return { error: `style must be one of: ${STYLES.join(", ")}` };
    out.style = p.style as Style;
  }
  if ("focus" in p) {
    if (!Array.isArray(p.focus) || p.focus.some((f) => !FOCUS_AREAS.includes(f as FocusArea)))
      return { error: `focus must be a subset of: ${FOCUS_AREAS.join(", ")}` };
    out.focus = [...new Set(p.focus as FocusArea[])];
  }
  if ("goal" in p) {
    out.goal = p.goal === "" || p.goal == null ? "" : (cleanText(p.goal, MAX_GOAL) ?? "");
  }
  if ("voice" in p) {
    out.voice = p.voice === "" || p.voice == null ? "" : (cleanText(p.voice, MAX_VOICE) ?? "");
  }

  if (Object.keys(out).length === 0) return { error: "no valid settings provided" };
  return { settings: out };
}

/** Latest settings per wallet, folded from the append-only file in one pass and cached on its stat. */
const settingsView = ledgerView<Map<string, AgentSettings>>(FILE, (rows) => {
  const out = new Map<string, AgentSettings>();
  for (const r of rows as Array<{ address?: unknown; settings?: unknown }>) {
    const a = typeof r.address === "string" ? r.address : "";
    if (a && r.settings && typeof r.settings === "object") out.set(a, r.settings as AgentSettings);
  }
  return out;
});

/** Drop the parsed view (tests, and anything that rewrites the file). */
export function resetSettingsCache(): void {
  settingsView.reset();
}

/** This wallet's current settings (latest write wins), or {} if none. Always a copy. */
export function getAgentSettings(address: string): AgentSettings {
  const found = settingsView.get().get(address);
  return found ? { ...found } : {};
}

/** Merge a validated patch into this wallet's settings and persist (append-only). Cleared
 *  free-text fields ("") drop the key rather than persisting an empty string. */
export function updateAgentSettings(address: string, patch: Partial<AgentSettings>): AgentSettings {
  const merged: AgentSettings = { ...getAgentSettings(address), ...patch };
  if (merged.name === "") delete merged.name;
  if (merged.goal === "") delete merged.goal;
  if (merged.voice === "") delete merged.voice;
  appendLedger(FILE, { address, settings: merged, at: Date.now() });
  settingsView.reset();
  return merged;
}

/** Validate then persist, in one call, so every write path uses the same validator. */
export function setAgentSettings(address: string, patch: unknown): { settings: AgentSettings } | { error: string } {
  const res = sanitizeSettings(patch);
  if ("error" in res) return res;
  return { settings: updateAgentSettings(address, res.settings) };
}
