/**
 * Meteora DLMM as a venue: a thin wrapper over src/tools/dlmm.ts. Nothing here changes what the
 * desk did before venues existed; the labels, the rent constants and the transactions are the same.
 */
import DLMM, { type LbPosition } from "@meteora-ag/dlmm";
import type { Connection, PublicKey } from "@solana/web3.js";
import {
  buildClaimFeesTxs,
  buildClosePositionTxs,
  buildOpenPositionTx,
  getPoolSnapshot,
  getUserPositions,
  binArrayIndexOf,
  BIN_ARRAY_RENT_SOL,
  loadPool,
  OPEN_COST_ESTIMATE_SOL,
  POSITION_RENT_SOL,
  type OpenPlan,
  type PoolSnapshot,
} from "../tools/dlmm";
import type { BuiltTx, OpenCost, Venue, VenuePool } from "./types";

export interface MeteoraPool extends VenuePool {
  venue: "meteora-dlmm";
  dlmm: DLMM;
}

const asMeteora = (pool: VenuePool): MeteoraPool => {
  if (pool.venue !== "meteora-dlmm" || !("dlmm" in pool)) throw new Error(`${pool.address} is not a Meteora pool handle`);
  return pool as MeteoraPool;
};

/**
 * PURE. What opening a band costs on Meteora: the position's rent (refunded on close) plus rent for every
 * bin array the band touches that does not exist yet (0.0715 SOL each, never refunded). A busy stock pool
 * already has its arrays around the price, so a band there pays position rent only; paper used to charge
 * two fresh arrays on every open, 0.14 SOL a band, which a desk re-centring hourly could not earn back.
 *
 * Without a plan the band is assumed to cover the active bin's array. Without the snapshot's bin array
 * state (an old snapshot, a failed read) the old two-array estimate stands.
 */
export function meteoraOpenCost(snapshot?: Pick<PoolSnapshot, "activeBinId" | "dlmm"> | null, plan?: Pick<OpenPlan, "minBinId" | "maxBinId"> | null): OpenCost {
  const refundable = POSITION_RENT_SOL;
  const state = snapshot?.dlmm;
  if (!snapshot || !state) return { total: OPEN_COST_ESTIMATE_SOL, refundable, note: "position + 2 bin arrays (bin arrays not read)" };
  const lo = binArrayIndexOf(plan ? Math.min(plan.minBinId, plan.maxBinId) : snapshot.activeBinId);
  const hi = binArrayIndexOf(plan ? Math.max(plan.minBinId, plan.maxBinId) : snapshot.activeBinId);
  const fresh: number[] = [];
  for (let i = lo; i <= hi; i++) if (!state.initializedBinArrays.includes(i)) fresh.push(i);
  const total = refundable + fresh.length * BIN_ARRAY_RENT_SOL;
  const unread = fresh.filter((i) => !state.readBinArrays.includes(i)).length;
  const note = fresh.length
    ? `position + ${fresh.length} bin array(s) to create at ${fresh.join(", ")}${unread ? ` (${unread} not read, assumed fresh)` : ""} (${BIN_ARRAY_RENT_SOL} SOL each, not refunded)`
    : "bin arrays exist; position rent only (refunded on close)";
  return { total, refundable, note };
}

export const meteoraVenue: Venue = {
  id: "meteora-dlmm",

  async loadPool(connection: Connection, address: string): Promise<MeteoraPool> {
    return { venue: "meteora-dlmm", address, dlmm: await loadPool(connection, address) };
  },

  async snapshot(pool, binsEachSide, opts): Promise<PoolSnapshot> {
    return getPoolSnapshot(asMeteora(pool).dlmm, binsEachSide, { solPriceUsd: opts.solPriceUsd });
  },

  async positions(pool, owner, snapshot) {
    return getUserPositions(asMeteora(pool).dlmm, owner, snapshot);
  },

  async buildOpen(pool, owner, plan: OpenPlan): Promise<BuiltTx> {
    const { tx, positionKeypair } = await buildOpenPositionTx(asMeteora(pool).dlmm, owner, plan);
    return {
      tx,
      signers: [positionKeypair],
      label: `open ${plan.side ?? "BOTH"} band bins [${plan.minBinId}, ${plan.maxBinId}]`,
      positionAddress: positionKeypair.publicKey.toBase58(),
    };
  },

  async buildClose(pool, owner, raw): Promise<BuiltTx[]> {
    const position = raw as LbPosition;
    const txs = await buildClosePositionTxs(asMeteora(pool).dlmm, owner, position);
    const addr = position.publicKey.toBase58();
    return txs.map((tx, i) => ({ tx, signers: [], label: `close band ${addr.slice(0, 6)} ${i + 1}/${txs.length}` }));
  },

  async buildClaim(pool, owner, raws): Promise<BuiltTx[]> {
    const txs = await buildClaimFeesTxs(asMeteora(pool).dlmm, owner, raws as LbPosition[]);
    return txs.map((tx, i) => ({ tx, signers: [], label: `claim fees ${i + 1}/${txs.length}` }));
  },

  openCostSol(snapshot, plan): OpenCost {
    return meteoraOpenCost(snapshot, plan);
  },

  async closeRefundSol(connection: Connection, raw: unknown): Promise<number | null> {
    // closing a DLMM position closes its account and hands every lamport in it to the owner: those lamports ARE the refund
    const key = (raw as LbPosition | undefined)?.publicKey;
    if (!key) return null;
    try {
      const lamports = await connection.getBalance(key, "confirmed");
      return Number.isFinite(lamports) && lamports > 0 ? lamports / 1e9 : null;
    } catch {
      return null;
    }
  },

  async poolsWithPositions(connection: Connection, owner: PublicKey): Promise<string[]> {
    const held = await DLMM.getAllLbPairPositionsByUser(connection, owner);
    return [...held.entries()].filter(([, info]) => info.lbPairPositionsData.length > 0).map(([addr]) => addr);
  },
};
