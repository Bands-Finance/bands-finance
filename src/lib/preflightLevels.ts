/**
 * The level each preflight row gets (src/scripts/preflight.ts), as pure functions so the choice is tested
 * (src/scripts/test-halts.ts). The rule of thumb: a dry-run desk signs nothing, so what would only matter
 * to a signature is a WARN there and a FAIL live. `npm run live` and the paper desk both run the preflight
 * on every start, and a FAIL refuses the boot: on an unattended desk a FAIL that is not about money puts
 * him in a restart loop where he watches nothing.
 */
import type { Decider } from "../agent/decide";

export type Level = "PASS" | "WARN" | "FAIL";

/**
 * The kill switch. On a live desk a halt is a refusal to boot: you meant to halt, and a restart must not
 * quietly undo that. On a dry-run desk it is a warning: the loop honours the switch by itself ("Engine
 * says no opens here"), and a gate here would stop the desk watching and journalling.
 */
export function haltLevel(halted: boolean, dryRun: boolean): Level {
  return !halted ? "PASS" : dryRun ? "WARN" : "FAIL";
}

/** EXPECTED_WALLET against the loaded key. A mismatch is a FAIL live; a paper desk signs nothing, so there it is a WARN. */
export function expectedWalletLevel(state: "match" | "mismatch" | "unset", dryRun: boolean): Level {
  if (state === "match") return "PASS";
  if (state === "unset") return "WARN";
  return dryRun ? "WARN" : "FAIL";
}

export interface ModelInput {
  decider: Decider;
  dryRun: boolean;
  /** POLICY_LIVE=true: the desk policy may open and re-centre on a live book */
  policyLive: boolean;
  agentName: string;
  model: string;
  /** decider anthropic: whether there are credentials, and the ping's outcome (absent when it was not sent) */
  anthropic?: { hasKey: boolean; ping?: { ok: true; text: string } | { ok: false; error: string } };
  /** decider openhermit: whether a token is set (never the value), and whether GET /health answered 200 in time */
  openhermit?: { tokenPresent: boolean; gatewayUrl: string; agentId: string; healthy: boolean; healthNote: string };
}

/** What a live book without a model does, by POLICY_LIVE: the reason the no-model row is a WARN or a FAIL live. */
const policyNote = (i: ModelInput): string =>
  i.dryRun ? " (fine for paper and dry runs)" : i.policyLive ? " (POLICY_LIVE=true: it trades real money)" : "; set POLICY_LIVE=true to let the policy trade, or every open holds";

/** The model row: who is asked each cycle, and whether he can be. */
export function modelRow(i: ModelInput): { name: string; level: Level; detail: string } {
  if (i.decider === "policy") {
    // Live without POLICY_LIVE every open holds (src/agent/decide.ts policyDecideResult): a desk that cannot open is not ready.
    const level: Level = i.dryRun || i.policyLive ? "PASS" : "FAIL";
    return { name: "model", level, detail: `the desk policy proposes and no model is asked${policyNote(i)}` };
  }
  if (i.decider === "openhermit") {
    const oh = i.openhermit ?? { tokenPresent: false, gatewayUrl: "?", agentId: "?", healthy: false, healthNote: "not checked" };
    if (!oh.tokenPresent) {
      return { name: "model", level: i.dryRun ? "WARN" : "FAIL", detail: `DECIDER=openhermit but OPENHERMIT_TOKEN is not set: the desk policy proposes instead${policyNote(i)}` };
    }
    // A gateway that is down is a WARN even live: the desk falls back to the policy by itself, and a FAIL here would keep
    // a live desk with open bands from booting at all, watching nothing, until the gateway came back.
    return {
      name: "model",
      level: oh.healthy ? "PASS" : "WARN",
      detail: `DECIDER=openhermit, agent ${oh.agentId} @ ${oh.gatewayUrl}, token set; health ${oh.healthNote}${oh.healthy ? "" : ": until it answers, the desk policy proposes"}`,
    };
  }
  const a = i.anthropic ?? { hasKey: false };
  if (!a.hasKey) {
    return { name: "model", level: i.dryRun || i.policyLive ? "WARN" : "FAIL", detail: `ANTHROPIC_API_KEY is empty: the desk policy proposes instead of ${i.agentName}${policyNote(i)}` };
  }
  // The ping is a paid request: it is never sent for a dry-run desk, where nothing it could catch costs money.
  if (!a.ping) return { name: "model", level: i.dryRun ? "PASS" : "WARN", detail: `${i.model}: key set; not pinged${i.dryRun ? " on a dry-run desk (the ping is paid)" : ""}` };
  if (a.ping.ok) return { name: "model", level: "PASS", detail: `${i.model} answered "${a.ping.text.slice(0, 20)}"` };
  return { name: "model", level: i.dryRun ? "WARN" : "FAIL", detail: `${i.model}: ${a.ping.error.slice(0, 100)}` };
}
