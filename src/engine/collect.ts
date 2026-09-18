/**
 * Collect and skim policies, pure. Ports of the auto-collect in Meridian's agent/src/lpGuard.ts
 * (maybeCollect: sweep owed fees once they clear a threshold) and the float-target treasury skim
 * in agent/src/treasurySkim.ts (once the signer holds more than its float needs, the excess goes
 * to the treasury; here 75% of realized fee gain since the last skim row, never the float).
 *
 *   collectDirective(...)  which band to claim, or null
 *   skimPlan(...)          how much SOL to send to the treasury, or null
 *
 * Both are dormant by default: the collect directive only fires above the thresholds and under
 * the daily cap, and the skim needs ENGINE_SKIM=true plus a valid TREASURY_ADDRESS. Execution
 * lives in the executor, in its own failure domain: a failed skim never blocks trading.
 */
import { PublicKey } from "@solana/web3.js";
import type { EngineConfig } from "../config";
import type { RiskState } from "../risk/state";
import { quoteMath, type PoolSnapshot, type PositionSnapshot } from "../tools/dlmm";
import { feeGainSinceLastSkim, LedgerMode, LedgerRow } from "./ledger";

export const COLLECT_PENDING_MS = 2 * 60 * 60 * 1000;
export const SKIM_SHARE = 0.75;
/** below this a skim is dust that costs more attention than it moves */
export const SKIM_MIN_SOL = 0.001;

/** The snapshot fields the collect policy reads: the SOL fields, plus the quote fields when the snapshot has them. */
export type CollectSnapshot = Pick<PoolSnapshot, "solSide" | "tokenPriceInSol"> & Partial<Pick<PoolSnapshot, "quoteSide" | "quotePriceInSol" | "tokenPriceInQuote">>;

/** Unclaimed fees on a band in quote units (SOL or USDC), at the pool's current mark. */
export function unclaimedFeesQuote(p: Pick<PositionSnapshot, "feeX" | "feeY">, s: CollectSnapshot): number {
  const q = quoteMath(s);
  return q.side === "X" ? p.feeX + p.feeY * q.tokenPriceInQuote : p.feeY + p.feeX * q.tokenPriceInQuote;
}

/** Unclaimed fees on a band in SOL-equivalent, at the pool's current mark (a USDC pool converts at quotePriceInSol). */
export function unclaimedFeesSol(p: Pick<PositionSnapshot, "feeX" | "feeY">, s: CollectSnapshot): number {
  return unclaimedFeesQuote(p, s) * quoteMath(s).priceInSol;
}

/** Keep state.feesPendingSince honest: set when fees first exceed the floor, cleared once they are below it (claimed). */
export function trackFeesPending(
  state: Pick<RiskState, "feesPendingSince">,
  positions: readonly PositionSnapshot[],
  snapshot: CollectSnapshot,
  now: number,
  floorSol: number,
): void {
  const pending = (state.feesPendingSince ??= {});
  for (const p of positions) {
    const fees = unclaimedFeesSol(p, snapshot);
    if (fees > floorSol) {
      if (!(p.address in pending)) pending[p.address] = now;
    } else {
      delete pending[p.address];
    }
  }
}

/** A claim landed: the "pending above the floor" clock starts again at the next read that finds fees. */
export function clearFeesPending(state: Pick<RiskState, "feesPendingSince">, claimed: readonly string[]): void {
  if (!state.feesPendingSince) return;
  for (const a of claimed) delete state.feesPendingSince[a];
}

export interface CollectPlan {
  positionAddress: string;
  feesSol: number;
  reason: string;
}

/**
 * CLAIM_FEES when a band's unclaimed fees reach collectMinSol, or when fees above collectFloorSol
 * have been pending for 2h; capped at collectMaxPerDay claims per UTC day (collectsToday comes
 * from the ledger), no cap when that is 0. Picks the band with the most fees among those that qualify.
 */
export function collectDirective(
  positions: readonly PositionSnapshot[],
  snapshot: CollectSnapshot,
  state: Pick<RiskState, "feesPendingSince">,
  now: number,
  cfg: Pick<EngineConfig, "collectMinSol" | "collectFloorSol" | "collectMaxPerDay">,
  collectsToday: number,
): CollectPlan | null {
  if (cfg.collectMaxPerDay > 0 && collectsToday >= cfg.collectMaxPerDay) return null;
  let best: CollectPlan | null = null;
  for (const p of positions) {
    const fees = unclaimedFeesSol(p, snapshot);
    let reason: string | null = null;
    if (fees >= cfg.collectMinSol) {
      reason = `collect: ${fees.toFixed(5)} SOL unclaimed on ${p.address.slice(0, 6)} >= ${cfg.collectMinSol} SOL`;
    } else if (fees > cfg.collectFloorSol) {
      const since = state.feesPendingSince?.[p.address];
      if (typeof since === "number" && now - since >= COLLECT_PENDING_MS) {
        reason = `collect: ${fees.toFixed(5)} SOL on ${p.address.slice(0, 6)} pending ${Math.round((now - since) / 60000)} min (>= ${Math.round(COLLECT_PENDING_MS / 60000)} min above ${cfg.collectFloorSol} SOL)`;
      }
    }
    if (reason && (!best || fees > best.feesSol)) best = { positionAddress: p.address, feesSol: fees, reason };
  }
  return best;
}

export function isPubkey(s: string): boolean {
  if (!s || s.length < 32 || s.length > 44) return false;
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

export interface SkimPlan {
  treasury: string;
  amountSol: number;
  lamports: number;
  gainSol: number;
  reason: string;
}

/**
 * 75% of the SOL-equivalent fee gain since the last skim row, only while the skim is on, the
 * treasury is a valid pubkey, and the wallet would still hold floatTargetSol + gasReserveSol after
 * sending it. Null (no skim) otherwise. Wallet SOL is measured after the pool loop.
 */
export function skimPlan(
  walletSol: number,
  rows: readonly LedgerRow[],
  mode: LedgerMode,
  cfg: Pick<EngineConfig, "skim" | "treasuryAddress" | "floatTargetSol">,
  gasReserveSol: number,
): SkimPlan | null {
  if (!cfg.skim) return null;
  if (!isPubkey(cfg.treasuryAddress)) return null;
  const { gainSol } = feeGainSinceLastSkim(rows, mode);
  if (gainSol <= 0) return null;
  const keep = cfg.floatTargetSol + gasReserveSol;
  const excess = walletSol - keep;
  if (excess <= 0) return null;
  const amountSol = Math.min(Math.round(gainSol * SKIM_SHARE * 1e9) / 1e9, Math.round(excess * 1e9) / 1e9);
  if (amountSol < SKIM_MIN_SOL) return null;
  return {
    treasury: cfg.treasuryAddress,
    amountSol,
    lamports: Math.round(amountSol * 1e9),
    gainSol,
    reason: `skim: ${amountSol.toFixed(6)} SOL (${Math.round(SKIM_SHARE * 100)}% of ${gainSol.toFixed(6)} SOL fees since the last skim) to ${cfg.treasuryAddress.slice(0, 6)}, wallet keeps >= ${keep.toFixed(3)} SOL`,
  };
}
