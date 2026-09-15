/**
 * The living layer's state file (docs/mr-bands-agent.md sections 8 and 9): TALK_STATE_PATH/personality.json.
 * Schema-validated with zod on every read and write, written temp + rename, created empty on first read.
 * A file that exists but does not validate is an error, never silently replaced: it holds operator-approved state.
 *
 * Who writes what:
 *   proposeChanges   pending_proposals only (the reflect loop's propose_state). Rejects a proposal whose
 *                    text fails lintText, that targets anything but the five collections, or that breaks a
 *                    gate rule. Never bumps the version.
 *   recordUse        a bit's use and whether it landed (the measure step): counters only, never a status.
 *                    The gate turns counters into PROPOSALS: 3+ lands on a trial bit -> promote; 3 flops in a
 *                    row -> retire. Never bumps the version.
 *   approveProposal  write_state: applies one proposal, version + 1. Only with an operator identity equal
 *   vetoProposal     to OPERATOR_HANDLE; a veto records the item as retired ("operator veto") when it
 *                    would have added something, so the reflect loop does not propose it again.
 *
 * Fields beyond the spec's schema (all optional on read): running_bits[].flop_streak and recent_uses (the
 * gate's inputs), relationships[].flagged ("scams" | "undisclosed_promotion": never an ally), lore[].origin
 * (required: lore must point at a real event, a tx signature, journal entry id or post id), pending
 * proposals' id/proposed_at/source, and a decisions log (who approved or vetoed what, when).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { normalizeHandle, type TalkEnv } from "./env";
import { describeViolations, lintText, type LintContext } from "./lint";

export const PERSONALITY_FILE = "personality.json";
export const TARGETS = ["running_bits", "opinions", "relationships", "lore", "nicknames"] as const;
export const ACTIONS = ["add", "promote", "retire", "update"] as const;
export type Target = (typeof TARGETS)[number];
export type Action = (typeof ACTIONS)[number];

/** a trial bit must land this many times before it may be promoted */
export const LANDS_TO_PROMOTE = 3;
/** this many flops in a row proposes retirement */
export const FLOPS_TO_RETIRE = 3;
const WEEK = 7 * 24 * 3600e3;

const Bit = z.object({
  id: z.string().min(1),
  text: z.string(),
  origin: z.string(),
  times_used: z.number().int().nonnegative(),
  times_landed: z.number().int().nonnegative(),
  status: z.enum(["trial", "active", "retired"]),
  flop_streak: z.number().int().nonnegative().default(0),
  recent_uses: z.array(z.string()).default([]),
});
const Opinion = z.object({ topic: z.string().min(1), view: z.string(), confidence: z.enum(["low", "medium", "high"]), formed_from: z.string().min(1) });
const Relationship = z.object({
  handle: z.string().min(1),
  type: z.enum(["regular", "ally", "friendly_rival"]),
  notes: z.string(),
  interaction_count: z.number().int().nonnegative(),
  flagged: z.enum(["scams", "undisclosed_promotion"]).nullable().default(null),
});
const Lore = z.object({ id: z.string().min(1), date: z.string(), event: z.string(), callback_phrase: z.string(), origin: z.string().min(1) });
const Nickname = z.object({ name: z.string().min(1), source: z.string(), adopted: z.boolean() });
const Retired = z.object({ id: z.string(), reason: z.enum(["flopped", "stale", "operator veto"]) });

/** What a proposal looks like when it arrives (the reflect prompt's shape). */
export const ProposalSchema = z.object({
  action: z.enum(ACTIONS),
  target: z.enum(TARGETS),
  payload: z.record(z.string(), z.unknown()),
  evidence: z.string(),
  reason: z.string(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

const Pending = ProposalSchema.extend({ id: z.string().min(1), proposed_at: z.string(), source: z.enum(["reflect", "gate", "operator"]) });
export type PendingProposal = z.infer<typeof Pending>;

const DecisionLog = z.object({ proposal_id: z.string(), decision: z.enum(["approved", "vetoed"]), operator: z.string(), at: z.string(), action: z.enum(ACTIONS), target: z.enum(TARGETS), reason: z.string().nullable().default(null) });

export const PersonalitySchema = z.object({
  version: z.number().int().positive(),
  last_updated: z.string(),
  running_bits: z.array(Bit),
  opinions: z.array(Opinion),
  relationships: z.array(Relationship),
  lore: z.array(Lore),
  nicknames: z.array(Nickname),
  retired: z.array(Retired),
  pending_proposals: z.array(Pending),
  decisions: z.array(DecisionLog).default([]),
});
export type Personality = z.infer<typeof PersonalitySchema>;
export type RunningBit = z.infer<typeof Bit>;

export interface PersonalityOpts {
  statePath: string;
  env: Pick<TalkEnv, "operatorHandle" | "maxBitUsesPerWeek" | "houseSymbols" | "houseMints">;
  now?: number;
}

export const personalityFile = (statePath: string) => path.join(statePath, PERSONALITY_FILE);

export function emptyPersonality(now = Date.now()): Personality {
  return { version: 1, last_updated: new Date(now).toISOString(), running_bits: [], opinions: [], relationships: [], lore: [], nicknames: [], retired: [], pending_proposals: [], decisions: [] };
}

function write(statePath: string, p: Personality): void {
  const valid = PersonalitySchema.parse(p);
  const file = personalityFile(statePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(valid, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** The state file; created empty on first read. Throws when the file exists but does not validate. */
export function readPersonality(statePath: string, now = Date.now()): Personality {
  const file = personalityFile(statePath);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const fresh = emptyPersonality(now);
    write(statePath, fresh);
    return fresh;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}); not replacing operator-approved state`);
  }
  const parsed = PersonalitySchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file} does not match the personality schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

const lintCtx = (env: PersonalityOpts["env"]): LintContext => ({ operatorHandle: env.operatorHandle, houseSymbols: env.houseSymbols, houseMints: env.houseMints });
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Payload fields that would be said in public; each must pass the lint. */
const SPOKEN_FIELDS = ["text", "view", "topic", "notes", "event", "callback_phrase", "name"] as const;

/** Handles that look like bots, scams, engagement farms or impersonators. */
export const SUSPICIOUS_HANDLE_PATTERNS: readonly RegExp[] = [
  /\d{6,}/,
  /(airdrop|giveaway|claim|reward|support|helpdesk|help_desk|admin|official|recover|refund|drainer|presale|whitelist|bonus|promo|dm_?me|free_?(sol|crypto|mint|nft))/,
  /(wallet|phantom|solana|meteora|jupiter|pumpfun|pump_fun|xcom|twitter)_?(fix|sync|help|support|team|service|care)/,
  /^[a-z]+_?\d{5,}$/,
  /bot$/,
];

export function suspiciousHandle(handle: string): boolean {
  const h = handle.trim().replace(/^@/, "").toLowerCase();
  return SUSPICIOUS_HANDLE_PATTERNS.some((re) => re.test(h));
}

/** Why a proposal may not stand against the locked core and the gate rules, or null. */
export function proposalProblem(pr: Proposal, p: Personality, env: PersonalityOpts["env"], atApply = false): string | null {
  const ctx = lintCtx(env);
  for (const f of SPOKEN_FIELDS) {
    const v = pr.payload[f];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") return `payload.${f} must be text`;
    const l = lintText(v, ctx);
    if (!l.ok) return `payload.${f} fails the lint (${describeViolations(l.violations)})`;
  }
  const reasonLint = lintText(pr.reason, ctx);
  if (!reasonLint.ok) return `reason fails the lint (${describeViolations(reasonLint.violations)})`;

  const id = str(pr.payload.id);
  switch (pr.target) {
    case "running_bits": {
      if (pr.action === "add") {
        if (!str(pr.payload.text)) return "a new bit needs text";
        if (!str(pr.payload.origin)) return "a new bit needs an origin (post id or event)";
        if (p.running_bits.some((b) => b.text.toLowerCase() === String(pr.payload.text).trim().toLowerCase())) return "that bit already exists";
        return null;
      }
      const bit = p.running_bits.find((b) => b.id === id);
      if (!bit) return `no running bit with id ${id ?? "(none)"}`;
      if (pr.action === "promote") {
        if (bit.status !== "trial") return `bit ${bit.id} is ${bit.status}, not trial`;
        if (bit.times_landed < LANDS_TO_PROMOTE) return `bit ${bit.id} landed ${bit.times_landed} time(s); the gate wants ${LANDS_TO_PROMOTE}+`;
        return null;
      }
      if (pr.action === "retire") return bit.status === "retired" ? `bit ${bit.id} is already retired` : null;
      if (pr.action === "update") return bit.status === "retired" ? `bit ${bit.id} is retired` : str(pr.payload.text) ? null : "an update needs text";
      return null;
    }
    case "opinions": {
      if (pr.action === "promote") return "opinions are not promoted";
      const topic = str(pr.payload.topic);
      if (!topic) return "an opinion needs a topic";
      const exists = p.opinions.some((o) => o.topic.toLowerCase() === topic.toLowerCase());
      if (pr.action === "retire" || pr.action === "update") if (!exists) return `no opinion on ${topic}`;
      if (pr.action === "add" && exists) return `an opinion on ${topic} exists; propose an update`;
      if (pr.action === "add" || pr.action === "update") {
        if (!str(pr.payload.view)) return "an opinion needs a view";
        if (!["low", "medium", "high"].includes(String(pr.payload.confidence))) return "confidence must be low, medium or high";
        if (!str(pr.payload.formed_from)) return "opinions must reference real data or events (formed_from)";
      }
      return null;
    }
    case "relationships": {
      if (pr.action === "promote") return "relationships are not promoted; propose an update";
      const handle = normalizeHandle(str(pr.payload.handle));
      if (!handle) return "a relationship needs a valid handle";
      const existing = p.relationships.find((r) => normalizeHandle(r.handle) === handle);
      if ((pr.action === "retire" || pr.action === "update") && !existing) return `no relationship with @${handle}`;
      if (pr.action === "add" && existing) return `@${handle} exists; propose an update`;
      const type = pr.payload.type ?? existing?.type;
      if ((pr.action === "add" || pr.action === "update") && !["regular", "ally", "friendly_rival"].includes(String(type))) return "type must be regular, ally or friendly_rival";
      const flagged = pr.payload.flagged ?? existing?.flagged ?? null;
      if (type === "ally" && (flagged || suspiciousHandle(handle))) return `@${handle} is flagged or looks like a scam account: never an ally`;
      return null;
    }
    case "lore": {
      if (pr.action === "promote") return "lore is not promoted";
      if (pr.action === "add" || pr.action === "update") {
        if (!str(pr.payload.origin)) return "lore must carry an origin reference (tx signature, journal entry id or post id)";
        if (!str(pr.payload.event) || !str(pr.payload.callback_phrase)) return "lore needs an event and a callback phrase";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(pr.payload.date ?? ""))) return "lore needs a date (YYYY-MM-DD)";
      }
      if (pr.action !== "add" && !p.lore.some((l) => l.id === id)) return `no lore with id ${id ?? "(none)"}`;
      return null;
    }
    case "nicknames": {
      const name = str(pr.payload.name);
      if (!name) return "a nickname needs a name";
      const existing = p.nicknames.find((n) => n.name.toLowerCase() === name.toLowerCase());
      if (pr.action === "add") return existing ? "that nickname exists" : str(pr.payload.source) ? null : "a nickname needs a source (who started it)";
      if (!existing) return `no nickname ${name}`;
      if (pr.action === "promote" && existing.adopted) return `${name} is already adopted`;
      return null;
    }
  }
  return atApply ? "unknown target" : null;
}

const sameProposal = (a: Proposal, b: Proposal) => a.action === b.action && a.target === b.target && JSON.stringify(a.payload) === JSON.stringify(b.payload);

export interface ProposeResult {
  accepted: PendingProposal[];
  rejected: { proposal: unknown; reason: string }[];
}

function addPending(p: Personality, prs: readonly unknown[], source: PendingProposal["source"], env: PersonalityOpts["env"], now: number): ProposeResult {
  const out: ProposeResult = { accepted: [], rejected: [] };
  for (const raw of prs) {
    const parsed = ProposalSchema.safeParse(raw);
    if (!parsed.success) {
      out.rejected.push({ proposal: raw, reason: `not a proposal for one of ${TARGETS.join(", ")}: ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
      continue;
    }
    const pr = parsed.data;
    const problem = proposalProblem(pr, p, env);
    if (problem) {
      out.rejected.push({ proposal: raw, reason: problem });
      continue;
    }
    if (p.pending_proposals.some((x) => sameProposal(x, pr))) {
      out.rejected.push({ proposal: raw, reason: "the same proposal is already pending" });
      continue;
    }
    const pending: PendingProposal = { ...pr, id: `prop_${crypto.randomBytes(4).toString("hex")}`, proposed_at: new Date(now).toISOString(), source };
    p.pending_proposals.push(pending);
    out.accepted.push(pending);
  }
  return out;
}

/** propose_state: write valid proposals into pending_proposals. The version does not change. */
export function proposeChanges(proposals: readonly unknown[], opts: PersonalityOpts & { source?: PendingProposal["source"] }): ProposeResult {
  const now = opts.now ?? Date.now();
  const p = readPersonality(opts.statePath, now);
  const out = addPending(p, proposals, opts.source ?? "reflect", opts.env, now);
  if (out.accepted.length) {
    p.last_updated = new Date(now).toISOString();
    write(opts.statePath, p);
  }
  return out;
}

/** Uses of a bit inside the trailing 7 days. */
export const usesThisWeek = (b: RunningBit, now: number) => b.recent_uses.filter((t) => now - Date.parse(t) < WEEK && Date.parse(t) <= now).length;

/** A bit that has used up its week (MAX_BIT_USES_PER_WEEK) rests until its oldest use in the window ages out. */
export const isRested = (b: RunningBit, now: number, maxPerWeek: number) => usesThisWeek(b, now) >= maxPerWeek;

/** Trial and active bits that may be used right now. */
export function selectableBits(p: Personality, now: number, maxPerWeek: number): RunningBit[] {
  return p.running_bits.filter((b) => b.status !== "retired" && !isRested(b, now, maxPerWeek));
}

export interface RecordUseResult {
  bit: RunningBit;
  /** the bit has now used its week and is not selectable until uses age out */
  rested: boolean;
  /** the bit was already rested when this use was recorded (the use happened anyway; say so) */
  overused: boolean;
  proposed: PendingProposal[];
}

/** The measure step for one bit. Counters only; the gate proposes, the operator applies. */
export function recordUse(bitId: string, landed: boolean, opts: PersonalityOpts): RecordUseResult {
  const now = opts.now ?? Date.now();
  const p = readPersonality(opts.statePath, now);
  const bit = p.running_bits.find((b) => b.id === bitId);
  if (!bit) throw new Error(`no running bit with id ${bitId}`);
  if (bit.status === "retired") throw new Error(`bit ${bitId} is retired; it should not have been used`);
  const overused = isRested(bit, now, opts.env.maxBitUsesPerWeek);
  bit.times_used += 1;
  if (landed) {
    bit.times_landed += 1;
    bit.flop_streak = 0;
  } else bit.flop_streak += 1;
  bit.recent_uses = [...bit.recent_uses.filter((t) => now - Date.parse(t) < WEEK), new Date(now).toISOString()];

  const gate: Proposal[] = [];
  if (bit.status === "trial" && bit.times_landed >= LANDS_TO_PROMOTE) gate.push({ action: "promote", target: "running_bits", payload: { id: bit.id }, evidence: `landed ${bit.times_landed} of ${bit.times_used} uses`, reason: `landed ${bit.times_landed} times, the gate allows trial to active` });
  if (bit.flop_streak >= FLOPS_TO_RETIRE) gate.push({ action: "retire", target: "running_bits", payload: { id: bit.id, reason: "flopped" }, evidence: `${bit.flop_streak} flops in a row`, reason: `flopped ${bit.flop_streak} times in a row` });
  const pendingFor = (action: Action) => p.pending_proposals.some((x) => x.target === "running_bits" && x.action === action && x.payload.id === bit.id);
  const fresh = gate.filter((g) => !pendingFor(g.action));
  const proposed = fresh.length ? addPending(p, fresh, "gate", opts.env, now).accepted : [];
  p.last_updated = new Date(now).toISOString();
  write(opts.statePath, p);
  return { bit, rested: isRested(bit, now, opts.env.maxBitUsesPerWeek), overused, proposed };
}

export type OperatorResult = { ok: true; personality: Personality; proposal: PendingProposal } | { ok: false; reason: string };

/** write_state needs the operator: the identity given must be OPERATOR_HANDLE. */
export function operatorProblem(operator: string | null | undefined, env: Pick<TalkEnv, "operatorHandle">): string | null {
  if (!env.operatorHandle) return "OPERATOR_HANDLE is not set: nothing in the living layer can be applied";
  const who = normalizeHandle(operator ?? "");
  if (!who) return "an operator identity is required (--operator <handle>)";
  if (who !== env.operatorHandle) return `@${who} is not the operator (OPERATOR_HANDLE)`;
  return null;
}

const nextId = (prefix: string, ids: string[]) => {
  const max = ids.map((i) => Number(i.match(new RegExp(`^${prefix}_(\\d+)$`))?.[1] ?? 0)).reduce((a, b) => Math.max(a, b), 0);
  return `${prefix}_${String(max + 1).padStart(3, "0")}`;
};

function apply(p: Personality, pr: PendingProposal): void {
  const pl = pr.payload;
  const s = (k: string) => String(pl[k] ?? "").trim();
  const retireReason = (): "flopped" | "stale" => (pl.reason === "flopped" ? "flopped" : "stale");
  switch (pr.target) {
    case "running_bits": {
      if (pr.action === "add") {
        const ids = [...p.running_bits.map((b) => b.id), ...p.retired.map((r) => r.id)];
        p.running_bits.push({ id: nextId("bit", ids), text: s("text"), origin: s("origin"), times_used: 0, times_landed: 0, status: "trial", flop_streak: 0, recent_uses: [] });
        return;
      }
      const bit = p.running_bits.find((b) => b.id === pl.id)!;
      if (pr.action === "promote") bit.status = "active";
      else if (pr.action === "update") bit.text = s("text");
      else {
        bit.status = "retired";
        p.retired.push({ id: bit.id, reason: retireReason() });
      }
      return;
    }
    case "opinions": {
      const i = p.opinions.findIndex((o) => o.topic.toLowerCase() === s("topic").toLowerCase());
      const next = { topic: s("topic"), view: s("view"), confidence: s("confidence") as "low" | "medium" | "high", formed_from: s("formed_from") };
      if (pr.action === "add") p.opinions.push(next);
      else if (pr.action === "update") p.opinions[i] = next;
      else {
        p.opinions.splice(i, 1);
        p.retired.push({ id: s("topic"), reason: retireReason() });
      }
      return;
    }
    case "relationships": {
      const handle = normalizeHandle(s("handle"))!;
      const i = p.relationships.findIndex((r) => normalizeHandle(r.handle) === handle);
      if (pr.action === "retire") {
        p.relationships.splice(i, 1);
        return;
      }
      const prev = i >= 0 ? p.relationships[i] : null;
      const flagged = pl.flagged === "scams" || pl.flagged === "undisclosed_promotion" ? pl.flagged : (prev?.flagged ?? null);
      const next = { handle: `@${handle}`, type: (pl.type ?? prev?.type) as "regular" | "ally" | "friendly_rival", notes: pl.notes !== undefined ? s("notes") : (prev?.notes ?? ""), interaction_count: typeof pl.interaction_count === "number" ? Math.max(0, Math.floor(pl.interaction_count)) : (prev?.interaction_count ?? 0), flagged };
      if (prev) p.relationships[i] = next;
      else p.relationships.push(next);
      return;
    }
    case "lore": {
      if (pr.action === "add") {
        p.lore.push({ id: nextId("lore", p.lore.map((l) => l.id)), date: s("date"), event: s("event"), callback_phrase: s("callback_phrase"), origin: s("origin") });
        return;
      }
      const i = p.lore.findIndex((l) => l.id === pl.id);
      if (pr.action === "update") p.lore[i] = { id: p.lore[i].id, date: s("date"), event: s("event"), callback_phrase: s("callback_phrase"), origin: s("origin") };
      else p.lore.splice(i, 1);
      return;
    }
    case "nicknames": {
      const i = p.nicknames.findIndex((n) => n.name.toLowerCase() === s("name").toLowerCase());
      if (pr.action === "add") p.nicknames.push({ name: s("name"), source: s("source"), adopted: pl.adopted === true });
      else if (pr.action === "promote") p.nicknames[i].adopted = true;
      else if (pr.action === "update") p.nicknames[i] = { ...p.nicknames[i], source: pl.source !== undefined ? s("source") : p.nicknames[i].source, adopted: pl.adopted === true };
      else p.nicknames.splice(i, 1);
      return;
    }
  }
}

/** write_state: apply one pending proposal, version + 1. The gate and the lint are checked again first. */
export function approveProposal(id: string, operator: string, opts: PersonalityOpts): OperatorResult {
  const who = operatorProblem(operator, opts.env);
  if (who) return { ok: false, reason: who };
  const now = opts.now ?? Date.now();
  const p = readPersonality(opts.statePath, now);
  const pr = p.pending_proposals.find((x) => x.id === id);
  if (!pr) return { ok: false, reason: `no pending proposal ${id}` };
  const problem = proposalProblem(pr, p, opts.env, true);
  if (problem) return { ok: false, reason: `cannot apply ${id}: ${problem}` };
  apply(p, pr);
  p.pending_proposals = p.pending_proposals.filter((x) => x.id !== id);
  p.decisions.push({ proposal_id: id, decision: "approved", operator: `@${opts.env.operatorHandle}`, at: new Date(now).toISOString(), action: pr.action, target: pr.target, reason: null });
  p.version += 1;
  p.last_updated = new Date(now).toISOString();
  write(opts.statePath, p);
  return { ok: true, personality: p, proposal: pr };
}

/** write_state: drop one pending proposal; an add of a bit or an opinion is remembered as retired by veto. Version + 1. */
export function vetoProposal(id: string, operator: string, reason: string, opts: PersonalityOpts): OperatorResult {
  const who = operatorProblem(operator, opts.env);
  if (who) return { ok: false, reason: who };
  if (!str(reason)) return { ok: false, reason: "a veto needs a reason" };
  const now = opts.now ?? Date.now();
  const p = readPersonality(opts.statePath, now);
  const pr = p.pending_proposals.find((x) => x.id === id);
  if (!pr) return { ok: false, reason: `no pending proposal ${id}` };
  p.pending_proposals = p.pending_proposals.filter((x) => x.id !== id);
  if (pr.action === "add" && (pr.target === "running_bits" || pr.target === "opinions")) {
    const vid = str(pr.payload.text) ?? str(pr.payload.topic) ?? id;
    p.retired.push({ id: vid, reason: "operator veto" });
  }
  p.decisions.push({ proposal_id: id, decision: "vetoed", operator: `@${opts.env.operatorHandle}`, at: new Date(now).toISOString(), action: pr.action, target: pr.target, reason: reason.trim() });
  p.version += 1;
  p.last_updated = new Date(now).toISOString();
  write(opts.statePath, p);
  return { ok: true, personality: p, proposal: pr };
}

/** Handles flagged in relationships: the drift check and the mention screen treat them as off limits. */
export function flaggedHandles(p: Personality): string[] {
  return p.relationships.filter((r) => r.flagged).map((r) => normalizeHandle(r.handle)).filter((h): h is string => !!h);
}
