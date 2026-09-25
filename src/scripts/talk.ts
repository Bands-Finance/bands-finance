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
 *   npx tsx src/scripts/talk.ts tick [--force strap|daily|lesson|stack]   the posting loop, one tick (src/talk/tick.ts); --force only previews
 *   npx tsx src/scripts/talk.ts check                                     which account the X keys sign in as (a read)
 *   npx tsx src/scripts/talk.ts announce <intro|entry|token|follow|correction|pinned> [--preview]
 *   npx tsx src/scripts/talk.ts build list                                the build ledger (seed + TALK_STATE_PATH/build.jsonl)
 *   npx tsx src/scripts/talk.ts build add '<json row>'                    append one row (src/talk/buildLedger.ts)
 *   npx tsx src/scripts/talk.ts engage                                    one pass of the engage loop (src/talk/engage.ts)
 *   npx tsx src/scripts/talk.ts engage status                             free: mode, cursor, pending, today's counts, hold
 *   npx tsx src/scripts/talk.ts engage preview <mentions.json> [--no-model]   screen, brain and vet on a saved X response;
 *                                                                         no X read and no post, ever
 *   npx tsx src/scripts/talk.ts engage resume                             clears replies-off and brain-down
 *   npx tsx src/scripts/talk.ts engage optouts                            the accounts that asked him to stop
 *
 * `post` goes through src/talk/x.ts: while X is dormant it prints the draft and why it was not posted.
 */
import { config } from "../config";
import { talkEnv, lintContextOf, type TalkEnv } from "../talk/env";
import { loadTalkData, stackFiguresOf, strapInputOf, type TalkData } from "../talk/data";
import { chopAppreciation, lesson, LESSON_TOPICS, rebalanceNote, stackUpdate, strapCheck, type DraftResult, type LessonTopic } from "../talk/drafts";
import { lintText } from "../talk/lint";
import { approveProposal, readPersonality, recordUse, vetoProposal } from "../talk/personality";
import { driftCheck, reflect } from "../talk/reflect";
import { strapOf, windowLabel, fmtAge } from "../talk/strap";
import { getEngagement, postTweet, readPosts, verifyCredentials, xCredentials, xGateProblem } from "../talk/x";
import { uploadMedia } from "../talk/media";
import { FORCE_KINDS, runTick, type ForceKind } from "../talk/tick";
import { runAnnounce } from "../talk/announce-cli";
import { appendBuildRow, readBuildLedger } from "../talk/buildLedger";
import { engageResume, engageStatus, previewMentions, readOptOuts, runEngagePass } from "../talk/engage";
import { mentionsFromResponse } from "../talk/x";
import fs from "node:fs";

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
    case "post-video": {
      // talk post-video <file.mp4> <text...>: lint, the live gate, the upload, then one original post with the video
      const [file, ...words] = args;
      const text = words.join(" ");
      if (!file || !text) { out("usage: talk post-video <file.mp4> <text>"); return 2; }
      const lint = lintText(text, lintContextOf(t));
      if (!lint.ok) { out(`fails the lint (${lint.length} of 280):`); for (const v of lint.violations) out(`  ${v.rule}: ${v.detail}`); return 2; }
      const gate = xGateProblem(t);
      if (gate) { out(`not live: ${gate}`); return 2; }
      const creds = xCredentials(process.env);
      if (!creds) { out("not live: the four X keys are not all set"); return 2; }
      const up = await uploadMedia(file, creds, { log: (l: string) => out(`  ${l}`) });
      if (!up.ok) { out(`upload failed: ${up.reason}`); return 2; }
      const r = await postTweet(text, { type: "announce", mediaIds: [up.mediaId] }, { env: process.env, now });
      out(r.posted ? `posted: ${r.id} (video ${up.mediaId} via ${up.endpoint})` : `not posted: ${r.reason}`);
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
    case "tick": {
      const force = flag(args, "force");
      if (force !== null && !(FORCE_KINDS as readonly string[]).includes(force)) {
        out(`usage: tick [--force ${FORCE_KINDS.join("|")}]`);
        return 2;
      }
      const r = await runTick({ env: process.env, paperDesk: config.dryRun, now, force: force as ForceKind | null });
      out(`${new Date(now).toISOString()} tick ${r.status}: ${r.detail}`);
      if (r.pick) out(`  ${r.pick.kind} ${r.pick.key}\n${r.pick.text.replace(/^/gm, "  | ")}`);
      if (r.moment && r.text) out(`  ${r.moment.type} ${r.moment.key}${r.source ? ` (${r.source})` : ""}\n${r.text.replace(/^/gm, "  | ")}`);
      for (const n of r.plan?.notes ?? []) if (r.status !== "idle") out(`  note: ${n}`);
      return r.status === "error" ? 1 : 0;
    }
    case "check": {
      const r = await verifyCredentials({ env: process.env, now });
      if (!r.ok) {
        out(`check failed: ${r.reason}`);
        return 2;
      }
      out(`the x keys sign in as @${r.username}`);
      out(r.matchesXHandle === null ? "X_HANDLE is not set" : r.matchesXHandle ? `matches X_HANDLE (@${t.xHandle})` : `does NOT match X_HANDLE (@${t.xHandle})`);
      out(`posting is ${t.xLive ? "LIVE (X_LIVE=true)" : "off (X_LIVE is not \"true\"): ticks only draft"}`);
      return r.matchesXHandle === false ? 2 : 0;
    }
    case "announce":
      return runAnnounce(args, t, now, out);
    case "build": {
      if (args[0] === "list") {
        const l = readBuildLedger(t.statePath);
        for (const r of l.rows) out(`${new Date(r.at).toISOString().slice(0, 10)}  ${r.public ? "public " : "private"}  ${r.kind.padEnd(7)} ${r.id}${r.promise ? ` (promise, due ${new Date(r.promise.due).toISOString().slice(0, 10)})` : ""}${r.resolves ? ` (keeps ${r.resolves})` : ""}\n    ${r.text}`);
        for (const p of l.problems) out(`problem: ${p}`);
        return l.problems.length ? 2 : 0;
      }
      if (args[0] === "add" && args[1]) {
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(args[1]) as Record<string, unknown>;
        } catch {
          out("build add: the row is not json");
          return 2;
        }
        const problem = appendBuildRow(t.statePath, raw);
        out(problem ? `not added: ${problem}` : `added to ${t.statePath}/build.jsonl`);
        return problem ? 2 : 0;
      }
      out(`usage: build list | build add '{"id":"...","at":"YYYY-MM-DD","kind":"shipped","public":true,"text":"...","source":"..."}'`);
      return 2;
    }
    case "engage": {
      const sub = args[0] ?? "";
      if (sub === "") {
        const r = await runEngagePass({ env: process.env, now });
        // under launchd stdout is engage.log, which the pass already wrote (a dormant line once an hour): print only by hand
        if (process.stdout.isTTY) out(`${new Date(now).toISOString()} engage ${r.status}: ${r.detail}`);
        return r.status === "error" ? 1 : 0;
      }
      if (sub === "status") {
        for (const line of engageStatus({ env: process.env, now })) out(line);
        return 0;
      }
      if (sub === "resume") {
        out(engageResume({ env: process.env, now }));
        return 0;
      }
      if (sub === "optouts") {
        const o = readOptOuts(t.statePath);
        out(`${o.handles.length} opt-out(s)${o.handles.length ? `: ${o.handles.map((h) => `@${h}`).join(", ")}` : ""}`);
        return 0;
      }
      if (sub === "preview" && args[1]) {
        const mentions = mentionsFromResponse(JSON.parse(fs.readFileSync(args[1], "utf8")));
        const rows = await previewMentions(mentions, { env: process.env, now, model: !args.includes("--no-model") });
        for (const r of rows) {
          out(`${r.id}  @${r.author}  ${r.outcome}`);
          if (r.text !== undefined) out(`  | ${r.text}`);
        }
        return 0;
      }
      out("usage: engage | engage status | engage preview <mentions.json> [--no-model] | engage resume | engage optouts");
      return 2;
    }
    default:
      out("usage: talk.ts strap | draft <strap|rebalance|stack|chop|lesson> [topic] | lint \"<text>\" | post <type> [topic] | proposals | approve <id> --operator <handle> | veto <id> --operator <handle> --reason \"<r>\" | use <bit-id> <landed|flopped> | reflect | drift | tick [--force strap|daily|lesson|stack] | check | announce <intro|entry|token|follow|correction|pinned> [--preview] | build list | build add '<json>' | engage [status | preview <file> [--no-model] | resume | optouts]");
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
