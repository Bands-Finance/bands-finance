/**
 * The engine skill: Mr Bands' band math and guards, run for ANY wallet, returning unsigned
 * Solana transactions the caller signs. Ports Meridian's agent/src/engine/access.ts
 * (decideAccess, parseAllowlist, parseSkillVersion; fail closed) and the engine routes in
 * agent/src/index.ts (plan, positions, collect, close: the {ok, chainId, steps, note} shape).
 * The chain swap: Uniswap v4 calldata becomes a serialized legacy Transaction, and the one
 * server-side signature is the fresh position keypair's partial signature, which can move
 * nothing on its own.
 *
 * Non-custodial throughout. The server never holds a user key: every step goes out unsigned
 * (or signed only by the position keypair it just generated), and no user signature ever
 * comes in. Ownership for collect/close is read from the position account on chain.
 *
 * Access, from env, fail closed:
 *   ENGINE_ALLOWLIST   comma/space-separated wallet pubkeys (case-sensitive base58)
 *   ENGINE_OPEN=true   every signed-in wallet
 *   neither            nobody; detail "engine access is not open yet"
 */
import DLMM, { type LbPosition } from "@meteora-ag/dlmm";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import { OpenParamsSchema, type Decision, type OpenParams } from "../agent/schema";
import { config, riskLimits } from "../config";
import { toOpenPlan } from "../executor";
import { evaluate, type GuardContext, type Verdict } from "../risk/guards";
import type { RiskState } from "../risk/state";
import {
  buildClaimFeesTxs,
  buildClosePositionTxs,
  buildOpenPositionTx,
  getPoolSnapshot,
  getUserPositions,
  loadPool,
  toPositionSnapshot,
  type PoolSnapshot,
  type PositionSnapshot,
  quoteOf,
  USDC_MINT,
} from "../tools/dlmm";
import { isAddress } from "./accounts";
import { SOLANA_MAINNET_CAIP2 } from "./payments/PaymentGate";

export type AccessVia = "allowlist" | "open";

export interface AccessResult {
  ok: boolean;
  via: AccessVia | null;
  paths: AccessVia[];
  /** Human one-liner, safe to show on a public surface. */
  detail: string;
}

/** PURE: parse the operator allowlist env into a set of valid pubkeys. Case-sensitive. */
export function parseAllowlist(raw = process.env.ENGINE_ALLOWLIST ?? ""): Set<string> {
  const out = new Set<string>();
  for (const part of raw.split(/[,\s]+/)) {
    const a = part.trim();
    if (isAddress(a)) out.add(a);
  }
  return out;
}

/** PURE: given which paths qualify, choose the reported result. */
export function decideAccess(paths: AccessVia[]): AccessResult {
  if (paths.length === 0) return { ok: false, via: null, paths: [], detail: "engine access is not open yet" };
  const via: AccessVia = paths.includes("allowlist") ? "allowlist" : "open";
  const label: Record<AccessVia, string> = { allowlist: "operator-granted", open: "open to every signed-in wallet" };
  return { ok: true, via, paths, detail: `Engine access: ${label[via]}.` };
}

/** The gate. Reads env only; never signs or moves funds. Fails closed on a malformed address. */
export function hasEngineAccess(wallet: string, env: { allowlist?: string; open?: string } = { allowlist: process.env.ENGINE_ALLOWLIST, open: process.env.ENGINE_OPEN }): AccessResult {
  if (!isAddress(wallet)) return decideAccess([]);
  const paths: AccessVia[] = [];
  if (parseAllowlist(env.allowlist ?? "").has(wallet)) paths.push("allowlist");
  if ((env.open ?? "").trim().toLowerCase() === "true") paths.push("open");
  return decideAccess(paths);
}

/** PURE: the `version:` line of the skill file's YAML frontmatter; "unknown" when malformed. */
export function parseSkillVersion(content: string): string {
  return /^version:\s*(\S+)/m.exec(content)?.[1] ?? "unknown";
}

export interface PlanInput extends OpenParams {
  pool: string;
}

/** PURE: validate a plan request body. Returns the message to show as-is on failure. */
export function validatePlanInput(body: unknown): { ok: true; input: PlanInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isAddress(b.pool)) return { ok: false, error: "pool must be a DLMM pool address" };
  const parsed = OpenParamsSchema.safeParse({
    side: b.side,
    amountSol: b.amountSol,
    amountToken: b.amountToken,
    binsBelowActive: b.binsBelowActive,
    binsAboveActive: b.binsAboveActive,
    strategy: b.strategy,
  });
  if (!parsed.success) return { ok: false, error: `plan needs side, amountSol, amountToken, binsBelowActive, binsAboveActive, strategy: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  const o = parsed.data;
  if (!Number.isFinite(o.amountSol) || !Number.isFinite(o.amountToken) || o.amountSol < 0 || o.amountToken < 0) return { ok: false, error: "deposit amounts must be finite and non-negative" };
  if (!Number.isInteger(o.binsBelowActive) || !Number.isInteger(o.binsAboveActive) || o.binsBelowActive < 0 || o.binsAboveActive < 0) return { ok: false, error: "bin counts must be non-negative integers" };
  return { ok: true, input: { pool: b.pool, ...o } };
}

export interface VerdictView {
  allowed: boolean;
  passed: string[];
  violations: string[];
  overrides: string[];
  emergency: boolean;
}

/** PURE: the part of a guard verdict a caller sees. */
export function verdictView(v: Verdict): VerdictView {
  return { allowed: v.allowed, passed: v.passed, violations: v.violations, overrides: v.overrides, emergency: v.emergency };
}

/** PURE: the OPEN_POSITION decision the guards evaluate for a caller's plan. */
export function planDecision(o: OpenParams): Decision {
  return {
    action: "OPEN_POSITION",
    open: o,
    positionAddress: null,
    reasoning: "engine skill: a wallet asked the guards about this band",
    confidence: 1,
    headline: "Engine skill plan",
  };
}

/**
 * PURE: the guard context for a caller. Fresh risk state (no entry values, no actions
 * today, no last price), no kill switch, no exposure elsewhere: the guards judge THIS
 * wallet's band against the desk's limits, with the caller's own positions in this pool.
 */
export function callerGuardContext(params: { snapshot: PoolSnapshot; positions: PositionSnapshot[]; walletSol: number; walletToken: number; walletQuote?: number; now?: number }): GuardContext {
  const state: RiskState = { day: new Date().toISOString().slice(0, 10), actionsToday: 0, lastActionAt: null, lastPrice: null, entryValueSol: {} };
  return {
    now: params.now ?? Date.now(),
    snapshot: params.snapshot,
    positions: params.positions,
    walletSol: params.walletSol,
    walletToken: params.walletToken,
    // the quote balance: SOL in a SOL pool, USDC in a USDC pool (the guards convert at the SOL price)
    walletQuote: params.walletQuote ?? params.walletSol,
    state,
    killSwitch: false,
    otherExposureSol: 0,
    poolsWithBands: 0,
    maxActivePools: config.maxActivePools,
  };
}

export interface EngineStep {
  kind: "open-band" | "collect" | "close";
  description: string;
  /** base64 serialized legacy Transaction; unsigned except where `signers` says otherwise */
  tx: string;
  blockhash: string;
  lastValidBlockHeight: number;
  /** who has ALREADY signed; the caller signs the rest */
  signers: string[];
}

export interface EnginePlan {
  ok: true;
  chainId: string;
  steps: EngineStep[];
  verdict: VerdictView;
  note: string;
}

/**
 * PURE (no RPC): fee payer, blockhash, partial signatures, then serialize without requiring
 * the caller's signature. The caller's signature slot stays empty; whoever signs it last
 * broadcasts it.
 */
export function serializeUnsigned(tx: Transaction, feePayer: PublicKey, recent: { blockhash: string; lastValidBlockHeight: number }, partialSigners: Keypair[] = []): string {
  tx.feePayer = feePayer;
  tx.recentBlockhash = recent.blockhash;
  tx.lastValidBlockHeight = recent.lastValidBlockHeight;
  if (partialSigners.length) tx.partialSign(...partialSigners);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

async function tokenUiBalance(connection: Connection, owner: PublicKey, mint: string): Promise<number> {
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
  let total = 0;
  for (const { account } of accounts.value) {
    const ui = account.data.parsed?.info?.tokenAmount?.uiAmount;
    if (typeof ui === "number") total += ui;
  }
  return total;
}

/** SOL, the pool's base token, and the quote token (USDC when the pool is USDC-quoted; else the SOL figure). */
async function walletBalances(connection: Connection, owner: PublicKey, mint: string, quoteMint: string | null): Promise<{ sol: number; token: number; quote: number }> {
  const [lamports, token, usdc] = await Promise.all([
    connection.getBalance(owner, "confirmed"),
    tokenUiBalance(connection, owner, mint),
    quoteMint === USDC_MINT ? tokenUiBalance(connection, owner, USDC_MINT) : Promise.resolve(null),
  ]);
  const sol = lamports / LAMPORTS_PER_SOL;
  return { sol, token, quote: usdc ?? sol };
}

/**
 * The plan: load the pool, snapshot it, read the CALLER's positions and balances, run the
 * guards, and if they allow it build the open-position transaction for the caller to sign.
 * Smoke-only in tests (needs an RPC and a real pool).
 */
export async function planOpenSteps(connection: Connection, caller: PublicKey, input: PlanInput): Promise<EnginePlan | { ok: false; verdict: VerdictView }> {
  const dlmm = await loadPool(connection, input.pool);
  const snapshot = await getPoolSnapshot(dlmm);
  // getPoolSnapshot already refused pools quoted in neither SOL nor USDC, and USDC pools with no SOL price.
  const quote = quoteOf(snapshot);
  const [{ positions }, balances] = await Promise.all([getUserPositions(dlmm, caller, snapshot), walletBalances(connection, caller, snapshot.baseToken.mint, quote.symbol === "USDC" ? USDC_MINT : null)]);
  const { pool: _pool, ...open } = input;
  const verdict = evaluate(planDecision(open), callerGuardContext({ snapshot, positions, walletSol: balances.sol, walletToken: balances.token, walletQuote: balances.quote }), riskLimits);
  if (!verdict.allowed) return { ok: false, verdict: verdictView(verdict) };

  const plan = toOpenPlan(open, snapshot);
  const { tx, positionKeypair } = await buildOpenPositionTx(dlmm, caller, plan);
  const recent = await connection.getLatestBlockhash("confirmed");
  return {
    ok: true,
    chainId: SOLANA_MAINNET_CAIP2,
    steps: [
      {
        kind: "open-band",
        description: `Open a ${open.side} band on ${snapshot.label}, bins [${plan.minBinId}, ${plan.maxBinId}] (${open.strategy}), position ${positionKeypair.publicKey.toBase58()}`,
        tx: serializeUnsigned(tx, caller, recent, [positionKeypair]),
        blockhash: recent.blockhash,
        lastValidBlockHeight: recent.lastValidBlockHeight,
        signers: ["position (already signed)"],
      },
    ],
    verdict: verdictView(verdict),
    note: "You sign it; bands.finance never touches your funds.",
  };
}

export interface EnginePosition extends PositionSnapshot {
  pool: { address: string; label: string; activeBinId: number; activePrice: number; priceLabel: string };
  advice: string;
}

function advice(p: PositionSnapshot, s: PoolSnapshot): string {
  if (p.inRange) return "in range and earning; collect anytime";
  const quote = quoteOf(s);
  const quoteBelow = quote.side !== "X";
  const priceBelowBand = p.binsFromRange < 0;
  const holdingQuote = quoteBelow ? !priceBelowBand : priceBelowBand;
  return holdingQuote
    ? `out of range, parked in ${quote.symbol}; re-enters if price comes back, or close and reopen`
    : `out of range, holding ${s.baseToken.symbol}; wait for recovery or close`;
}

/** Every DLMM position the caller holds, valued by the same code that values the desk's book. */
export async function positionsFor(connection: Connection, caller: PublicKey): Promise<EnginePosition[]> {
  const byPool = await DLMM.getAllLbPairPositionsByUser(connection, caller);
  const out: EnginePosition[] = [];
  for (const [pool, info] of byPool) {
    if (info.lbPairPositionsData.length === 0) continue;
    const dlmm = await loadPool(connection, pool);
    const s = await getPoolSnapshot(dlmm);
    for (const raw of info.lbPairPositionsData) {
      const p = toPositionSnapshot(raw, s);
      out.push({ ...p, pool: { address: s.address, label: s.label, activeBinId: s.activeBinId, activePrice: s.activePrice, priceLabel: s.priceLabel }, advice: advice(p, s) });
    }
  }
  return out;
}

/**
 * Collect or close, as unsigned steps for a position the caller OWNS. The ownership check
 * reads the position account on chain; the transactions come from the same builders the
 * desk executes on its own book.
 */
export async function decreaseSteps(connection: Connection, caller: PublicKey, pool: string, position: string, mode: "collect" | "close"): Promise<EnginePlan | { error: string; status: 400 | 403 }> {
  const dlmm = await loadPool(connection, pool);
  let raw: LbPosition;
  try {
    raw = await dlmm.getPosition(new PublicKey(position));
  } catch {
    return { error: "that position does not exist in this pool", status: 400 };
  }
  if (!raw.positionData.owner.equals(caller)) return { error: "that position is not owned by this wallet", status: 403 };
  const s = await getPoolSnapshot(dlmm);
  const snap = toPositionSnapshot(raw, s);
  if (mode === "collect" && snap.feeX === 0 && snap.feeY === 0) return { error: "that position has no fees to collect yet", status: 400 };
  const txs = mode === "close" ? await buildClosePositionTxs(dlmm, caller, raw) : await buildClaimFeesTxs(dlmm, caller, [raw]);
  if (txs.length === 0) return { error: mode === "close" ? "nothing to close" : "nothing to collect", status: 400 };
  const recent = await connection.getLatestBlockhash("confirmed");
  const shortPos = `${position.slice(0, 6)}…`;
  return {
    ok: true,
    chainId: SOLANA_MAINNET_CAIP2,
    steps: txs.map((tx, i) => ({
      kind: mode,
      description:
        mode === "close"
          ? `Close band ${shortPos} on ${s.label} back to your wallet${txs.length > 1 ? ` (${i + 1}/${txs.length})` : ""}`
          : `Collect the fees owed on band ${shortPos} on ${s.label}${txs.length > 1 ? ` (${i + 1}/${txs.length})` : ""}`,
      tx: serializeUnsigned(tx, caller, recent),
      blockhash: recent.blockhash,
      lastValidBlockHeight: recent.lastValidBlockHeight,
      signers: [],
    })),
    verdict: { allowed: true, passed: ["owner"], violations: [], overrides: [], emergency: false },
    note:
      mode === "close"
        ? "Removes all liquidity, claims fees and closes the position account (rent refunded) to your wallet. You sign it; bands.finance never touches your funds."
        : "Sweeps the fees this band has earned to your wallet. The band stays open and keeps working.",
  };
}
