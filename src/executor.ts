/**
 * Turns an allowed verdict into transactions. In DRY_RUN the transactions are built
 * and simulated (when a real wallet is configured) but never broadcast.
 *
 * After every successful operation the executor writes cash-boundary rows to the attribution
 * ledger (src/engine/ledger.ts): open = -deposit -rent, close = +amounts +fees +rent refund,
 * collect = +fees, skim = -amount. Live rows are exact when the wallet's SOL delta and fee come
 * from the confirmed transaction (or a balance read before and after the broadcast), marked when
 * they had to come from the position snapshot. Dry-run rows are written too, tagged "dry-run".
 * The treasury skim runs in its own failure domain (executeSkim): a failed skim never blocks trading.
 */
import DLMM, { LbPosition } from "@meteora-ag/dlmm";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { config, riskLimits } from "./config";
import type { OpenParams } from "./agent/schema";
import type { SkimPlan } from "./engine/collect";
import { LedgerRow, recordLedger } from "./engine/ledger";
import type { Verdict } from "./risk/guards";
import {
  buildClaimFeesTxs,
  buildClosePositionTxs,
  buildOpenPositionTx,
  OpenPlan,
  PoolSnapshot,
  POSITION_RENT_SOL,
  PositionSnapshot,
  STRATEGY_BY_NAME,
  toRawBN,
} from "./tools/dlmm";
import type { Wallet } from "./tools/wallet";

export interface TxReport {
  label: string;
  ok: boolean;
  signature?: string;
  error?: string;
  unitsConsumed?: number;
  logsTail?: string[];
  skipped?: string;
}

export interface ExecutionResult {
  mode: "none" | "dry-run" | "live";
  ok: boolean;
  txs: TxReport[];
  opened?: { address: string; entryValueSol: number };
  closed?: string;
  notes: string[];
  /** attribution rows written for this execution (src/engine/ledger.ts) */
  ledger?: LedgerRow[];
}

export interface ExecutionContext {
  dlmm: DLMM;
  wallet: Wallet;
  rawPositions: LbPosition[];
  snapshot: PoolSnapshot;
  positions: PositionSnapshot[];
}

export function toOpenPlan(o: OpenParams, s: PoolSnapshot): OpenPlan {
  const solIsX = s.solSide === "X";
  return {
    minBinId: s.activeBinId - o.binsBelowActive,
    maxBinId: s.activeBinId + o.binsAboveActive,
    amountX: toRawBN(solIsX ? o.amountSol : o.amountToken, s.tokenX.decimals),
    amountY: toRawBN(solIsX ? o.amountToken : o.amountSol, s.tokenY.decimals),
    strategyType: STRATEGY_BY_NAME[o.strategy],
    slippagePct: riskLimits.maxSlippagePct,
  };
}

/** What one broadcast did to the wallet's SOL, when it could be measured. */
interface Cash {
  walletDeltaSol: number;
  txFeeSol: number;
}

interface TxOutcome {
  ok: boolean;
  signature: string | null;
  /** chain-measured; null in dry-run or when neither the tx meta nor a balance pair was readable */
  cash: Cash | null;
}

/** marked network fee for a dry-run row: one signature */
const MARKED_TX_FEE_SOL = 0.000005;

async function runTx(wallet: Wallet, label: string, tx: Transaction, signers: Keypair[], txs: TxReport[]): Promise<TxOutcome> {
  if (config.dryRun) {
    if (wallet.ephemeral) {
      txs.push({ label, ok: true, skipped: "dry-run with ephemeral wallet: built, not simulated" });
      return { ok: true, signature: null, cash: null };
    }
    try {
      const sim = await wallet.simulate(tx, signers);
      txs.push({
        label,
        ok: sim.ok,
        error: sim.ok ? undefined : JSON.stringify(sim.err),
        unitsConsumed: sim.unitsConsumed,
        logsTail: sim.logsTail,
      });
      return { ok: sim.ok, signature: null, cash: null };
    } catch (err) {
      txs.push({ label, ok: false, error: (err as Error).message });
      return { ok: false, signature: null, cash: null };
    }
  }
  let before: number | null = null;
  try {
    before = await wallet.solBalance();
  } catch {
    before = null;
  }
  try {
    const signature = await wallet.signAndSend(tx, signers);
    txs.push({ label, ok: true, signature });
    let cash: Cash | null = null;
    try {
      cash = await wallet.txCashDelta(signature);
      if (!cash && before !== null) {
        const after = await wallet.solBalance();
        // a balance pair cannot separate the fee; count one signature's worth and keep the total exact
        cash = { walletDeltaSol: after - before, txFeeSol: -MARKED_TX_FEE_SOL * Math.max(1, signers.length + 1) };
      }
    } catch {
      cash = null;
    }
    return { ok: true, signature, cash };
  } catch (err) {
    txs.push({ label, ok: false, error: (err as Error).message });
    return { ok: false, signature: null, cash: null };
  }
}

/** Sum the cash of several broadcasts; exact only when every one of them was measured. */
function sumCash(outcomes: TxOutcome[]): Cash | null {
  if (outcomes.length === 0 || outcomes.some((o) => !o.cash)) return null;
  return outcomes.reduce((acc, o) => ({ walletDeltaSol: acc.walletDeltaSol + o.cash!.walletDeltaSol, txFeeSol: acc.txFeeSol + o.cash!.txFeeSol }), { walletDeltaSol: 0, txFeeSol: 0 });
}

const lastSig = (outcomes: TxOutcome[]): string | null => outcomes.map((o) => o.signature).filter((s): s is string => !!s).pop() ?? null;

/** Fee leg of a position in base token units and in SOL-equivalent at the snapshot's mark. */
function feeLegs(p: PositionSnapshot, s: PoolSnapshot): { feeToken: number; feeSolSide: number; feeSol: number } {
  const solIsX = s.solSide === "X";
  const feeToken = solIsX ? p.feeY : p.feeX;
  const feeSolSide = solIsX ? p.feeX : p.feeY;
  return { feeToken, feeSolSide, feeSol: feeSolSide + feeToken * s.tokenPriceInSol };
}

function baseRow(ctx: ExecutionContext, mech: LedgerRow["mech"], sig: string | null, position: string | null): Omit<LedgerRow, "solDelta" | "tokenDelta" | "rentSol" | "txFeeSol" | "basis" | "note"> {
  return {
    ts: Date.now(),
    mode: config.dryRun ? "dry-run" : "live",
    sig,
    pool: ctx.snapshot.address,
    position,
    mech,
    tokenMint: ctx.snapshot.baseToken.mint,
    markTokenInSol: ctx.snapshot.tokenPriceInSol,
  };
}

function openRow(ctx: ExecutionContext, o: OpenParams, position: string, outcomes: TxOutcome[]): LedgerRow {
  const cash = sumCash(outcomes);
  const solDelta = -o.amountSol;
  const row: LedgerRow = cash
    ? {
        ...baseRow(ctx, "open", lastSig(outcomes), position),
        solDelta,
        tokenDelta: -o.amountToken,
        // whatever the wallet paid beyond the deposit and the fee is rent (position + any fresh bin arrays)
        rentSol: cash.walletDeltaSol - cash.txFeeSol - solDelta,
        txFeeSol: cash.txFeeSol,
        basis: "exact",
        note: `open ${o.side} band, ${outcomes.length} tx`,
      }
    : {
        ...baseRow(ctx, "open", lastSig(outcomes), position),
        solDelta,
        tokenDelta: -o.amountToken,
        rentSol: -POSITION_RENT_SOL,
        txFeeSol: -MARKED_TX_FEE_SOL * 2,
        basis: "marked",
        note: `open ${o.side} band; rent marked at the position rent (bin-array rent unknown)`,
      };
  return row;
}

function closeRow(ctx: ExecutionContext, p: PositionSnapshot, outcomes: TxOutcome[]): LedgerRow {
  const s = ctx.snapshot;
  const cash = sumCash(outcomes);
  const solIsX = s.solSide === "X";
  const { feeToken, feeSol } = feeLegs(p, s);
  const tokenDelta = (solIsX ? p.amountY : p.amountX) + feeToken;
  const rentSol = POSITION_RENT_SOL;
  const common = { ...baseRow(ctx, "close", lastSig(outcomes), p.address), tokenDelta, feeSol, entryValueSol: p.entryValueSol };
  return cash
    ? { ...common, solDelta: cash.walletDeltaSol - cash.txFeeSol - rentSol, rentSol, txFeeSol: cash.txFeeSol, basis: "exact", note: `close band, ${outcomes.length} tx` }
    : { ...common, solDelta: p.solInPosition, rentSol, txFeeSol: -MARKED_TX_FEE_SOL * Math.max(1, outcomes.length), basis: "marked", note: "close band; SOL side taken from the position snapshot" };
}

function collectRow(ctx: ExecutionContext, targets: PositionSnapshot[], outcomes: TxOutcome[]): LedgerRow {
  const s = ctx.snapshot;
  const cash = sumCash(outcomes);
  let tokenDelta = 0;
  let solSide = 0;
  let feeSol = 0;
  for (const p of targets) {
    const f = feeLegs(p, s);
    tokenDelta += f.feeToken;
    solSide += f.feeSolSide;
    feeSol += f.feeSol;
  }
  const position = targets.length === 1 ? targets[0].address : null;
  const common = { ...baseRow(ctx, "collect", lastSig(outcomes), position), tokenDelta, rentSol: 0, feeSol };
  return cash
    ? { ...common, solDelta: cash.walletDeltaSol - cash.txFeeSol, txFeeSol: cash.txFeeSol, basis: "exact", note: `claim fees on ${targets.length} band(s), ${outcomes.length} tx` }
    : { ...common, solDelta: solSide, txFeeSol: -MARKED_TX_FEE_SOL * Math.max(1, outcomes.length), basis: "marked", note: `claim fees on ${targets.length} band(s); SOL side taken from the position snapshot` };
}

export async function execute(verdict: Verdict, ctx: ExecutionContext): Promise<ExecutionResult> {
  const d = verdict.decision;
  if (!verdict.allowed) return { mode: "none", ok: true, txs: [], notes: ["blocked by guards"] };
  if (d.action === "HOLD") return { mode: "none", ok: true, txs: [], notes: ["hold"] };

  const result: ExecutionResult = { mode: config.dryRun ? "dry-run" : "live", ok: true, txs: [], notes: [], ledger: [] };
  const owner = ctx.wallet.publicKey;
  const findRaw = (addr: string | null) => ctx.rawPositions.find((p) => p.publicKey.toBase58() === addr);
  const findSnap = (addr: string | null) => ctx.positions.find((p) => p.address === addr);
  const ledger = (row: LedgerRow) => {
    recordLedger(row);
    result.ledger!.push(row);
  };

  try {
    if (d.action === "CLAIM_FEES") {
      const target = d.positionAddress ? findRaw(d.positionAddress) : undefined;
      const targets = target ? [target] : ctx.rawPositions;
      const built = await buildClaimFeesTxs(ctx.dlmm, owner, targets);
      if (built.length === 0) result.notes.push("nothing to claim");
      const outcomes: TxOutcome[] = [];
      for (const [i, tx] of built.entries()) {
        const out = await runTx(ctx.wallet, `claim fees ${i + 1}/${built.length}`, tx, [], result.txs);
        outcomes.push(out);
        if (!out.ok) {
          result.ok = false;
          break;
        }
      }
      if (result.ok && built.length > 0) {
        const snaps = targets.map((t) => findSnap(t.publicKey.toBase58())).filter((p): p is PositionSnapshot => !!p);
        ledger(collectRow(ctx, snaps, outcomes));
      }
      return result;
    }

    if (d.action === "CLOSE_POSITION" || d.action === "REBALANCE") {
      const raw = findRaw(d.positionAddress);
      if (!raw) throw new Error(`position ${d.positionAddress} not found`);
      const built = await buildClosePositionTxs(ctx.dlmm, owner, raw);
      const outcomes: TxOutcome[] = [];
      for (const [i, tx] of built.entries()) {
        const out = await runTx(ctx.wallet, `close band ${d.positionAddress!.slice(0, 6)} ${i + 1}/${built.length}`, tx, [], result.txs);
        outcomes.push(out);
        if (!out.ok) {
          result.ok = false;
          break;
        }
      }
      if (!result.ok) return result;
      result.closed = d.positionAddress!;
      const snap = findSnap(d.positionAddress);
      if (snap) ledger(closeRow(ctx, snap, outcomes));
      if (d.action === "CLOSE_POSITION") return result;
    }

    if (d.action === "OPEN_POSITION" || d.action === "REBALANCE") {
      if (!d.open) throw new Error("open parameters missing");
      const plan = toOpenPlan(d.open, ctx.snapshot);
      const { tx, positionKeypair } = await buildOpenPositionTx(ctx.dlmm, owner, plan);
      const out = await runTx(
        ctx.wallet,
        `open ${d.open.side} band bins [${plan.minBinId}, ${plan.maxBinId}]`,
        tx,
        [positionKeypair],
        result.txs,
      );
      result.ok = result.ok && out.ok;
      if (out.ok) {
        const address = positionKeypair.publicKey.toBase58();
        result.opened = {
          address,
          entryValueSol: d.open.amountSol + d.open.amountToken * ctx.snapshot.tokenPriceInSol,
        };
        ledger(openRow(ctx, d.open, address, [out]));
      }
    }
  } catch (err) {
    result.ok = false;
    result.notes.push(`build error: ${(err as Error).message}`);
  }
  return result;
}

/**
 * The treasury skim: a plain SystemProgram transfer, ledgered as mech "skim". Its own failure
 * domain: every error is caught and reported in the result, never thrown into the trading loop.
 */
export async function executeSkim(wallet: Wallet, plan: SkimPlan, pool = "wallet"): Promise<ExecutionResult> {
  const result: ExecutionResult = { mode: config.dryRun ? "dry-run" : "live", ok: true, txs: [], notes: [plan.reason], ledger: [] };
  try {
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(plan.treasury), lamports: plan.lamports }),
    );
    const out = await runTx(wallet, `skim ${plan.amountSol.toFixed(6)} SOL to treasury`, tx, [], result.txs);
    result.ok = out.ok;
    if (out.ok) {
      const row: LedgerRow = {
        ts: Date.now(),
        mode: config.dryRun ? "dry-run" : "live",
        sig: out.signature,
        pool,
        position: null,
        mech: "skim",
        solDelta: out.cash ? out.cash.walletDeltaSol - out.cash.txFeeSol : -plan.amountSol,
        tokenDelta: 0,
        tokenMint: "",
        markTokenInSol: 0,
        rentSol: 0,
        txFeeSol: out.cash ? out.cash.txFeeSol : -MARKED_TX_FEE_SOL,
        basis: out.cash ? "exact" : "marked",
        note: `${plan.reason}; fee gain base ${plan.gainSol.toFixed(6)} SOL`,
      };
      recordLedger(row);
      result.ledger!.push(row);
    }
  } catch (err) {
    result.ok = false;
    result.notes.push(`skim error: ${(err as Error).message}`);
  }
  return result;
}
