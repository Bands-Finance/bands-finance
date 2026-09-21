/**
 * THE DESK APPROVES SMALL OPENS ITSELF. With AUTO_APPROVE_PROPOSALS=true, an outside proposal
 * (src/platform/proposals.ts) no longer waits for the operator when it passes every rule below.
 * The rules are code: nothing here reads the rationale or the proposer's name, and no model is
 * asked. An approval by these rules is only the first of three gates: the loop then asks the desk
 * policy (adviseProposal, src/agent/decide.ts), which must agree or the proposal is refused, and
 * then the full guard battery (src/risk/guards.ts). Rules, then policy, then guards; nothing skips a guard.
 *
 * The loop calls autoDecide at CONSUMPTION time, inside runPool for that pool, so the checks and the
 * open happen in the same pass. One proposal per pool per cycle, the oldest pending first.
 *
 *   R0  AUTO_APPROVE_PROPOSALS is the literal "true". On a live book (DRY_RUN=false) also
 *       AUTO_APPROVE_LIVE=true and a non-empty AUTO_APPROVE_PROPOSERS.
 *   R1  OPEN_BAND only. A CLOSE_BAND always waits for the operator: the guards never block an exit,
 *       so an outside agent could otherwise force a close of a band that is earning.
 *   R2  a signed-in wallet or a bearer-derived MCP id ("mcp:b:"); a claimed name ("mcp:n:") never.
 *       With AUTO_APPROVE_PROPOSERS set, the proposer must be on it.
 *   R3  SOL_ONLY, no token, amountSol at most AUTO_MAX_SOL (default a quarter of MAX_POSITION_SOL).
 *   R4  the pool is in this cycle's picks, holds no band, and is none of the lanes that keep their
 *       own seat caps in the policy: stock, basis, pair, launch, ask, rotate-out.
 *   R5  at most AUTO_MAX_AGE_MIN (default 60) minutes old.
 *   R6  at most AUTO_MAX_PER_DAY (default 2) desk approvals per UTC day, one proposal band open at a
 *       time, and proposal bands within AUTO_MAX_EXPOSURE_PCT (default 20) of MAX_TOTAL_EXPOSURE_SOL.
 *       Counted from disk (proposals.jsonl and state.json), so a restart cannot reset it.
 *   R7  no kill switch, circuit halt or portfolio stand-down.
 */
import { config, riskLimits } from "../config";
import type { RiskLimits } from "../risk/limits";
import { killSwitchActive, loadState, type RiskState } from "../risk/state";
import { allProposals, proposerKind, type OpenBandParams, type Proposal } from "./proposals";

export interface AutoEnv {
  on: boolean;
  /** AUTO_APPROVE_LIVE=true: the rules may approve on a live book too (with an allowlist) */
  live: boolean;
  proposers: string[];
  maxSol: number;
  maxAgeMin: number;
  maxPerDay: number;
  maxExposurePct: number;
}

const num = (v: string | undefined, dflt: number): number => {
  const n = Number((v ?? "").trim());
  return (v ?? "").trim() !== "" && Number.isFinite(n) ? n : dflt;
};

/** PURE. The rules' settings. Off unless AUTO_APPROVE_PROPOSALS is the literal "true". */
export function autoEnv(env: NodeJS.ProcessEnv = process.env, limits: Pick<RiskLimits, "maxPositionSol"> = riskLimits): AutoEnv {
  return {
    on: env.AUTO_APPROVE_PROPOSALS === "true",
    live: env.AUTO_APPROVE_LIVE === "true",
    proposers: (env.AUTO_APPROVE_PROPOSERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    maxSol: Math.max(0, num(env.AUTO_MAX_SOL, 0.25 * limits.maxPositionSol)),
    maxAgeMin: Math.max(0, num(env.AUTO_MAX_AGE_MIN, 60)),
    maxPerDay: Math.max(0, Math.floor(num(env.AUTO_MAX_PER_DAY, 2))),
    maxExposurePct: Math.min(100, Math.max(0, num(env.AUTO_MAX_EXPOSURE_PCT, 20))),
  };
}

/** What the desk has already handed to proposals, read from disk. */
export interface AutoBudget {
  /** approvals by the desk's rules on this UTC day, whatever became of them */
  approvedToday: number;
  /** proposal bands open now, plus desk approvals not yet consumed */
  openBands: number;
  /** SOL at entry in proposal bands open now, plus what unconsumed desk approvals asked for */
  exposureSol: number;
}

const dayOf = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
const isDeskAuto = (p: Proposal): boolean => !!p.decidedBy?.startsWith("desk-auto:");

/**
 * PURE. The budget from the board and the state file. A proposal band is one state.proposalBands
 * names and state.entryValueSol still holds (a closed band's records go with it, src/engine/exit.ts
 * forgetBand). An approval not yet consumed counts as the band it will become.
 */
export function autoBudget(proposals: readonly Proposal[], state: Pick<RiskState, "proposalBands" | "entryValueSol">, now: number): AutoBudget {
  const today = dayOf(now);
  const approvedToday = proposals.filter((p) => isDeskAuto(p) && p.decidedAt !== undefined && dayOf(p.decidedAt) === today).length;
  const inFlight = proposals.filter((p) => isDeskAuto(p) && p.status === "approved");
  const open = Object.keys(state.proposalBands ?? {}).filter((addr) => addr in state.entryValueSol);
  return {
    approvedToday,
    openBands: open.length + inFlight.length,
    exposureSol: open.reduce((t, addr) => t + (state.entryValueSol[addr] ?? 0), 0) + inFlight.reduce((t, p) => t + ((p.params as OpenBandParams).amountSol ?? 0), 0),
  };
}

export interface AutoContext {
  now: number;
  /** config.dryRun: false is a live book */
  dryRun: boolean;
  env: AutoEnv;
  /** this cycle's picks: the pools the loop is working */
  picks: readonly string[];
  /** why this pool is not an ordinary seat (stock, basis, pair, launch, ask, rotate-out, holds a band); null when it is one */
  lane: string | null;
  /** the kill switch, a circuit halt or a portfolio stand-down, in words; null when none is on */
  halt: string | null;
  budget: AutoBudget;
  maxTotalExposureSol: number;
}

export type AutoVerdict = { approve: true; rule: string } | { approve: false; reason: string };

/** PURE. One proposal against every rule. Reads the params, the ids, the time and the kind; never the rationale or the name. */
export function autoDecideOne(p: Proposal, ctx: AutoContext): AutoVerdict {
  const leave = (reason: string): AutoVerdict => ({ approve: false, reason });
  const e = ctx.env;
  const live = !ctx.dryRun;
  // R0
  if (!e.on) return leave("AUTO_APPROVE_PROPOSALS is not on");
  if (live && !e.live) return leave("a live book and AUTO_APPROVE_LIVE is not on");
  if (live && e.proposers.length === 0) return leave("a live book needs AUTO_APPROVE_PROPOSERS");
  // R1
  if (p.kind !== "OPEN_BAND") return leave(`${p.kind} waits for the operator`);
  // R2
  const kind = proposerKind(p.proposerId);
  if (kind !== "wallet" && kind !== "mcp-bearer") return leave(`proposer ${p.proposerId.slice(0, 10)} is a claimed name, not a wallet or a bearer`);
  if (e.proposers.length > 0 && !e.proposers.includes(p.proposerId)) return leave(`proposer ${p.proposerId.slice(0, 10)} is not on AUTO_APPROVE_PROPOSERS`);
  // R3
  const o = p.params as OpenBandParams;
  if (o.side !== "SOL_ONLY" || o.amountToken !== 0) return leave("only a SOL_ONLY band with no token qualifies");
  if (!(o.amountSol > 0) || o.amountSol > e.maxSol) return leave(`amountSol ${o.amountSol} over the ${e.maxSol} AUTO_MAX_SOL`);
  // R4
  if (!ctx.picks.includes(o.pool)) return leave("the pool is not in this cycle's picks");
  if (ctx.lane) return leave(`not an ordinary seat: ${ctx.lane}`);
  // R5
  const ageMin = (ctx.now - p.at) / 60_000;
  if (ageMin > e.maxAgeMin) return leave(`${Math.round(ageMin)} min old, over AUTO_MAX_AGE_MIN ${e.maxAgeMin}`);
  // R6
  if (ctx.budget.approvedToday >= e.maxPerDay) return leave(`${ctx.budget.approvedToday} desk approvals today, AUTO_MAX_PER_DAY ${e.maxPerDay}`);
  if (ctx.budget.openBands >= 1) return leave("a proposal band is already open");
  const cap = (ctx.maxTotalExposureSol * e.maxExposurePct) / 100;
  if (ctx.budget.exposureSol + o.amountSol > cap) return leave(`proposal exposure would be ${ctx.budget.exposureSol + o.amountSol} SOL, over ${cap} (AUTO_MAX_EXPOSURE_PCT ${e.maxExposurePct})`);
  // R7
  if (ctx.halt) return leave(`halted: ${ctx.halt}`);
  return { approve: true, rule: e.proposers.length > 0 ? "allowlisted-open" : "small-open" };
}

/** PURE. The pool's pending proposals, oldest first: the first that passes every rule is approved, one per pool per cycle. */
export function autoDecide(pending: readonly Proposal[], ctx: AutoContext): { approve: { proposal: Proposal; rule: string } | null; left: { id: string; reason: string }[] } {
  const left: { id: string; reason: string }[] = [];
  for (const p of [...pending].filter((x) => x.status === "pending").sort((a, b) => a.at - b.at)) {
    const v = autoDecideOne(p, ctx);
    if (v.approve) return { approve: { proposal: p, rule: v.rule }, left };
    left.push({ id: p.id, reason: v.reason });
  }
  return { approve: null, left };
}

/**
 * PURE. The approved proposal the loop consumes this cycle, oldest first. While the kill switch, a circuit
 * halt or a stand-down is on, an OPEN is not consumed: it would be a certain refusal, so it stays approved
 * (and expires if the halt outlasts APPROVED_TTL_MS). A close is consumed: exits run under every halt.
 */
export function nextApprovedProposal(approved: readonly Proposal[], halted: boolean): Proposal | null {
  return [...approved].sort((a, b) => a.at - b.at).find((p) => !(halted && p.kind === "OPEN_BAND")) ?? null;
}

/** The auto-approval counters for a status page: the settings in force and the budget spent, read from disk. */
export function autoApprovalStatus(now = Date.now(), env: NodeJS.ProcessEnv = process.env): {
  on: boolean;
  live: boolean;
  approvedToday: number;
  maxPerDay: number;
  openBands: number;
  exposureSol: number;
  maxExposureSol: number;
  maxSol: number;
  killSwitch: boolean;
} {
  const e = autoEnv(env);
  const b = autoBudget(allProposals(now), loadState(), now);
  return {
    on: e.on && (config.dryRun || (e.live && e.proposers.length > 0)),
    live: !config.dryRun,
    approvedToday: b.approvedToday,
    maxPerDay: e.maxPerDay,
    openBands: b.openBands,
    exposureSol: Math.round(b.exposureSol * 1e4) / 1e4,
    maxExposureSol: (riskLimits.maxTotalExposureSol * e.maxExposurePct) / 100,
    maxSol: e.maxSol,
    killSwitch: killSwitchActive(),
  };
}
