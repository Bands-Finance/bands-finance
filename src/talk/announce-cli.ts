/**
 * `talk.ts announce <intro|entry|token|follow> [--preview]` (src/talk/announce.ts). Kept out of talk.ts so the
 * command line gains one case. --preview composes and checks only: nothing is written, not even a draft.
 */
import { composeAnnouncement, announce, factsOf, followInstruction, type AnnounceKind, type AnnounceViolation } from "./announce";
import { loadTalkData } from "./data";
import { lintContextOf, type TalkEnv } from "./env";
import { weightedLength } from "./lint";

const printViolations = (out: (s?: string) => void, vs: readonly AnnounceViolation[] | undefined) => {
  for (const v of vs ?? []) out(`  ${v.rule}: ${v.detail}`);
};

export async function runAnnounce(args: string[], t: TalkEnv, now: number, out: (s?: string) => void): Promise<number> {
  const kind = args[0] ?? "";
  const data = loadTalkData(t, now);
  if (args.includes("--preview")) {
    if (kind === "follow") {
      out(followInstruction());
      return 0;
    }
    const c = composeAnnouncement(kind as AnnounceKind, factsOf(data, process.env), lintContextOf(t));
    if (!c.ok) {
      out(`no ${kind} announcement: ${c.reason}`);
      printViolations(out, c.violations);
      return 2;
    }
    c.parts.forEach((p, i) => {
      out(`${c.kind}${c.parts.length > 1 ? ` part ${i + 1} of ${c.parts.length}` : ""} (${weightedLength(p)} of 280), checks ok:`);
      out("");
      out(p);
      out("");
    });
    return 0;
  }
  const r = await announce(kind, { data, env: process.env, now });
  switch (r.status) {
    case "posted":
      out(`posted ${r.kind}: ${r.ids.join(", ")}`);
      return 0;
    case "instruction":
      out(r.text);
      return 0;
    case "drafted":
      r.parts.forEach((p, i) => {
        out(`${r.kind}${r.parts.length > 1 ? ` part ${i + 1} of ${r.parts.length}` : ""}:`);
        out("");
        out(p);
        out("");
      });
      out(`not posted: ${r.reason}\n(the draft was appended to ${t.statePath}/x-drafts.jsonl; nothing is recorded as announced)`);
      return 2;
    case "refused":
      out(`not posted: ${r.reason}`);
      printViolations(out, r.violations);
      return 2;
  }
}
