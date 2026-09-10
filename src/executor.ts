/**
 * Turns an allowed verdict into transactions. In DRY_RUN the transactions are built
 * and simulated (when a real wallet is configured) but never broadcast.
 */
import DLMM, { LbPosition } from "@meteora-ag/dlmm";
import { Keypair, Transaction } from "@solana/web3.js";
import { config, riskLimits } from "./config";
import type { OpenParams } from "./agent/schema";
import type { Verdict } from "./risk/guards";
import {
  buildClaimFeesTxs,
  buildClosePositionTxs,
  buildOpenPositionTx,
  OpenPlan,
  PoolSnapshot,
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

async function runTx(wallet: Wallet, label: string, tx: Transaction, signers: Keypair[], txs: TxReport[]): Promise<boolean> {
  if (config.dryRun) {
    if (wallet.ephemeral) {
      txs.push({ label, ok: true, skipped: "dry-run with ephemeral wallet: built, not simulated" });
      return true;
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
      return sim.ok;
    } catch (err) {
      txs.push({ label, ok: false, error: (err as Error).message });
      return false;
    }
  }
  try {
    const signature = await wallet.signAndSend(tx, signers);
    txs.push({ label, ok: true, signature });
    return true;
  } catch (err) {
    txs.push({ label, ok: false, error: (err as Error).message });
    return false;
  }
}

export async function execute(verdict: Verdict, ctx: ExecutionContext): Promise<ExecutionResult> {
  const d = verdict.decision;
  if (!verdict.allowed) return { mode: "none", ok: true, txs: [], notes: ["blocked by guards"] };
  if (d.action === "HOLD") return { mode: "none", ok: true, txs: [], notes: ["hold"] };

  const result: ExecutionResult = { mode: config.dryRun ? "dry-run" : "live", ok: true, txs: [], notes: [] };
  const owner = ctx.wallet.publicKey;
  const findRaw = (addr: string | null) => ctx.rawPositions.find((p) => p.publicKey.toBase58() === addr);

  try {
    if (d.action === "CLAIM_FEES") {
      const target = d.positionAddress ? findRaw(d.positionAddress) : undefined;
      const targets = target ? [target] : ctx.rawPositions;
      const built = await buildClaimFeesTxs(ctx.dlmm, owner, targets);
      if (built.length === 0) result.notes.push("nothing to claim");
      for (const [i, tx] of built.entries()) {
        if (!(await runTx(ctx.wallet, `claim fees ${i + 1}/${built.length}`, tx, [], result.txs))) {
          result.ok = false;
          break;
        }
      }
      return result;
    }

    if (d.action === "CLOSE_POSITION" || d.action === "REBALANCE") {
      const raw = findRaw(d.positionAddress);
      if (!raw) throw new Error(`position ${d.positionAddress} not found`);
      const built = await buildClosePositionTxs(ctx.dlmm, owner, raw);
      for (const [i, tx] of built.entries()) {
        if (!(await runTx(ctx.wallet, `close band ${d.positionAddress!.slice(0, 6)} ${i + 1}/${built.length}`, tx, [], result.txs))) {
          result.ok = false;
          break;
        }
      }
      if (!result.ok) return result;
      result.closed = d.positionAddress!;
      if (d.action === "CLOSE_POSITION") return result;
    }

    if (d.action === "OPEN_POSITION" || d.action === "REBALANCE") {
      if (!d.open) throw new Error("open parameters missing");
      const plan = toOpenPlan(d.open, ctx.snapshot);
      const { tx, positionKeypair } = await buildOpenPositionTx(ctx.dlmm, owner, plan);
      const ok = await runTx(
        ctx.wallet,
        `open ${d.open.side} band bins [${plan.minBinId}, ${plan.maxBinId}]`,
        tx,
        [positionKeypair],
        result.txs,
      );
      result.ok = result.ok && ok;
      if (ok) {
        result.opened = {
          address: positionKeypair.publicKey.toBase58(),
          entryValueSol: d.open.amountSol + d.open.amountToken * ctx.snapshot.tokenPriceInSol,
        };
      }
    }
  } catch (err) {
    result.ok = false;
    result.notes.push(`build error: ${(err as Error).message}`);
  }
  return result;
}
