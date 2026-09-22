/**
 * The talking layer's command line (docs/talk.md). Reads DATA_DIR's journal, paper book and ledger; writes
 * only under TALK_STATE_PATH (personality.json, x-drafts.jsonl, x-rate.json, x-posts.jsonl). Never trades.
 *
 *   npx tsx src/scripts/talk.ts strap
 *   npx tsx src/scripts/talk.ts draft <strap|rebalance|stack|chop|lesson> [lesson topic]
 *   npx tsx src/scripts/talk.ts lint "<text>"
 *   npx tsx src/scripts/talk.ts post <strap|rebalance|stack|chop|lesson> [lesson topic]
 *   npx tsx src/scripts/talk.ts proposals
 *   npx tsx src/scripts/talk.ts approve <id> --operator <handle>
 *   npx tsx src/scripts/talk.ts veto <id> --operator <handle> --reason "<reason>"
 *   npx tsx src/scripts/talk.ts use <bit-id> <landed|flopped>
 *   npx tsx src/scripts/talk.ts reflect
 *   npx tsx src/scripts/talk.ts drift
 *   npx tsx src/scripts/talk.ts announce <intro|entry|token|follow> [--preview]
 *
 * `post` goes through src/talk/x.ts: while X is dormant it prints the draft and why it was not posted.
 */
import "../config";
import { talkEnv, lintContextOf, type TalkEnv } from "../talk/env";
import { loadTalkData, stackFiguresOf, strapInputOf, type TalkData } from "../talk/data";
import { chopAppreciation, lesson, LESSON_TOPICS, rebalanceNote, stackUpdate, strapCheck, type DraftResult, type LessonTopic } from "../talk/drafts";
import { lintText } from "../talk/lint";
import { approveProposal, readPersonality, recordUse, vetoProposal } from "../talk/personality";
import { driftCheck, reflect } from "../talk/reflect";
import { strapOf, windowLabel, fmtAge } from "../talk/strap";
import { getEngagement, postTweet, readPosts } from "../talk/x";
import { runAnnounce } from "../talk/announce-cli";

const HOUR = 3600e3;
const out = (s = "") => console.log(s);

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const sol = (n: number | null | undefined, d = 4) => (typeof n === "number" && Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(d)} sol` : "n/a");

function buildDraft(kind: string, topic: string | undefined, t: TalkEnv, data: TalkData): DraftResult {
  const strap = strapOf(strapInputOf(data, t), t);
  switch (kind) {
    case "strap":
      return strapCheck(strap, { source: data.source, now: data.now, env: t });
    case "rebalance":
      return rebalanceNote(data.journal.entries, { source: data.source, now: data.now, env: t, cycleIntervalSec: t.cycleIntervalSec, journalFrom: data.journal.from });
    case "stack":
      return stackUpdate(stackFiguresOf(data, 7 * 24 * HOUR, t.cycleIntervalSec), { env: t });
    case "chop":
      return chopAppreciation(data.journal.entries, strap, { source: data.source, now: data.now, env: t, cycleIntervalSec: t.cycleIntervalSec });
    case "lesson":
      if (topic && !(LESSON_TOPICS as readonly string[]).includes(topic)) return { ok: false, type: "lesson", reason: `unknown lesson "${topic}": ${LESSON_TOPICS.join(", ")}`, violations: [] };
      return lesson(topic as LessonTopic | undefined, { now: data.now, env: t });
    default:
      return { ok: false, type: "strap", reason: `unknown draft type "${kind}": strap, rebalance, stack, chop, lesson`, violations: [] };
  }
}

function printDraft(d: DraftResult): void {
  if (d.ok) {
    out(`${d.type} draft (${d.text.length} chars), lint ok:`);
    out("");
    out(d.text);
  } else {
    out(`no ${d.type} draft: ${d.reason}`);
    for (const v of d.violations) out(`  ${v.rule}: ${v.detail}`);
  }
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  const t = talkEnv(process.env);
  for (const p of t.problems) out(`warning: ${p}`);
  const now = Date.now();

  switch (cmd) {
    case "strap": {
      const data = loadTalkData(t, now);
      const strap = strapOf(strapInputOf(data, t), t);
      out(`data      ${data.dataDir} (${data.source}), newest journal entry ${data.newestEntryAt ? `${fmtAge(now - data.newestEntryAt)} ago` : "none"}`);
      out(`strap     ${strap.state}${strap.reason ? `: ${strap.reason}` : ""}`);
      out(`detail    ${strap.detail}`);
      out(`edge      yellow inside ${strap.edgePct}% of a band's width from either edge`);
      for (const p of strap.positions) out(`  ${(p.label ?? "?").padEnd(16)} ${p.status.padEnd(12)} ${p.edgeDistancePct === null ? `${p.binsFromRange ?? "?"} bins from range` : `${p.edgeDistancePct.toFixed(1)}% of width from the nearer edge`}`);
      const f = stackFiguresOf(data, 24 * HOUR, t.cycleIntervalSec);
      out(`fees      ${windowLabel(24 * HOUR)}: realized ${sol(f.feesRealizedSol, 6)} (claims ${sol(f.claimsSol, 6)} over ${f.claims}, close fee legs ${sol(f.closeFeeLegsSol, 6)})`);
      if (f.open) out(`unrealized now: unclaimed fees ${sol(f.open.feesUnclaimedSol, 6)}, open bands marked ${sol(f.open.markedBandsSol)} (${f.open.bands} band(s))`);
      return strap.state === "unknown" ? 2 : 0;
    }
    case "draft": {
      const data = loadTalkData(t, now);
      const d = buildDraft(args[0] ?? "", args[1], t, data);
      printDraft(d);
      return d.ok ? 0 : 2;
    }
    case "lint": {
      const text = args.join(" ");
      const r = lintText(text, lintContextOf(t));
      out(r.ok ? `ok (${r.length} of 280)` : `fails (${r.length} of 280):`);
      for (const v of r.violations) out(`  ${v.rule}: ${v.detail}`);
      return r.ok ? 0 : 2;
    }
    case "post": {
      const data = loadTalkData(t, now);
      const d = buildDraft(args[0] ?? "", args[1], t, data);
      printDraft(d);
      if (!d.ok) return 2;
      const r = await postTweet(d.text, { type: d.type }, { env: process.env, now });
      out("");
      out(r.posted ? `posted: ${r.id}` : `not posted: ${r.reason}\n(the draft was appended to ${t.statePath}/x-drafts.jsonl)`);
      return r.posted ? 0 : 2;
    }
    case "proposals": {
      const p = readPersonality(t.statePath, now);
      out(`personality.json v${p.version}, updated ${p.last_updated}: ${p.running_bits.length} bit(s), ${p.opinions.length} opinion(s), ${p.relationships.length} relationship(s), ${p.lore.length} lore, ${p.nicknames.length} nickname(s)`);
      out(`pending proposals (${p.pending_proposals.length})`);
      for (const x of p.pending_proposals) {
        out(`  ${x.id}  ${x.action} ${x.target}  from ${x.source} ${x.proposed_at}`);
        out(`    payload  ${JSON.stringify(x.payload)}`);
        out(`    reason   ${x.reason}`);
        out(`    evidence ${x.evidence}`);
      }
      return 0;
    }
    case "approve":
    case "veto": {
      const id = args[0];
      const operator = flag(args, "operator");
      if (!id || !operator) {
        out(`usage: ${cmd} <id> --operator <handle>${cmd === "veto" ? ' --reason "<reason>"' : ""}`);
        return 2;
      }
      const opts = { statePath: t.statePath, env: t, now };
      const r = cmd === "approve" ? approveProposal(id, operator, opts) : vetoProposal(id, operator, flag(args, "reason") ?? "", opts);
      out(r.ok ? `${cmd === "approve" ? "applied" : "vetoed"} ${id} (${r.proposal.action} ${r.proposal.target}); personality.json is now v${r.personality.version}` : `refused: ${r.reason}`);
      return r.ok ? 0 : 2;
    }
    case "use": {
      const [bitId, outcome] = args;
      if (!bitId || (outcome !== "landed" && outcome !== "flopped")) {
        out("usage: use <bit-id> <landed|flopped>");
        return 2;
      }
      const r = recordUse(bitId, outcome === "landed", { statePath: t.statePath, env: t, now });
      out(`${r.bit.id}: used ${r.bit.times_used}, landed ${r.bit.times_landed}, flops in a row ${r.bit.flop_streak}, status ${r.bit.status}${r.rested ? ", rested for the week" : ""}${r.overused ? " (it was already rested: MAX_BIT_USES_PER_WEEK exceeded)" : ""}`);
      for (const x of r.proposed) out(`  gate proposed ${x.id}: ${x.action} ${x.target} (${x.reason})`);
      return 0;
    }
    case "reflect": {
      const data = loadTalkData(t, now);
      const since = now - 24 * HOUR;
      const posts = readPosts(t.statePath).filter((p) => Date.parse(p.at) >= since);
      const eng = posts.length ? await getEngagement(posts.map((p) => p.id), { env: process.env, now }) : { ok: true as const, metrics: [] };
      if (!eng.ok) out(`engagement not measured: ${eng.reason}`);
      const byId = new Map(eng.ok ? eng.metrics.map((m) => [m.id, m] as const) : []);
      const strap = strapOf(strapInputOf(data, t), t);
      const r = await reflect(
        {
          posts: posts.map((p) => {
            const m = byId.get(p.id);
            return { ...p, engagement: m ? { replies: m.replies, reposts: m.reposts, quotes: m.quotes, likes: m.likes, ...(m.impressions !== null ? { impressions: m.impressions } : {}) } : null };
          }),
          positions: { strap, stack: stackFiguresOf(data, 24 * HOUR, t.cycleIntervalSec), source: data.source },
          personality: readPersonality(t.statePath, now),
          period: windowLabel(24 * HOUR),
        },
        { env: t, now },
      );
      if (!r.ok) {
        out(`reflect skipped: ${r.skipped}`);
        return 0;
      }
      out(`reflected with ${r.model}`);
      for (const [k, v] of Object.entries(r.review)) out(`  ${k}: ${v}`);
      out(`proposed (${r.proposed.length})`);
      for (const x of r.proposed) out(`  ${x.id}  ${x.action} ${x.target}: ${x.reason}`);
      out(`dropped (${r.dropped.length})`);
      for (const x of r.dropped) out(`  ${x.reason}`);
      return 0;
    }
    case "drift": {
      const personality = readPersonality(t.statePath, now);
      const report = driftCheck(readPosts(t.statePath), { now, personality, ctx: lintContextOf(t) });
      out(`drift check, ${report.window}: ${report.posts} post(s), ${report.ok ? "clean" : "flags below"}`);
      out(`  hype: ${report.hype.exclamations} "!", ${report.hype.superlatives} superlatives; per post ${report.hype.firstHalfPerPost.toFixed(2)} then ${report.hype.secondHalfPerPost.toFixed(2)}${report.hype.creeping ? " (creeping)" : ""}`);
      out(`  bits: ${report.bits.map((b) => `${b.id} ${(b.share * 100).toFixed(0)}%`).join(", ") || "none"}${report.overReliance ? ` (over-reliance on ${report.overReliance.id})` : ""}`);
      out(`  em dashes: ${report.emDashPosts} post(s); flagged-account interactions: ${report.flaggedInteractions}`);
      for (const f of report.flags) out(`  ${f.postId}  ${f.rule}: ${f.detail}`);
      return report.ok ? 0 : 2;
    }
    case "announce":
      return runAnnounce(args, t, now, out);
    default:
      out("usage: talk.ts strap | draft <strap|rebalance|stack|chop|lesson> [topic] | lint \"<text>\" | post <type> [topic] | proposals | approve <id> --operator <handle> | veto <id> --operator <handle> --reason \"<r>\" | use <bit-id> <landed|flopped> | reflect | drift | announce <intro|entry|token|follow> [--preview]");
      return cmd ? 2 : 0;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`talk: ${(err as Error).message}`);
    process.exit(1);
  },
);
