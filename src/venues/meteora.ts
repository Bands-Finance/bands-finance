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

/** Meteora's open cost is the same for every band: position rent plus two bin arrays that may need creating. */
export const meteoraOpenCost = (): OpenCost => ({ total: OPEN_COST_ESTIMATE_SOL, refundable: POSITION_RENT_SOL, note: "position + 2 bin arrays" });

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

  openCostSol(): OpenCost {
    return meteoraOpenCost();
  },

  async poolsWithPositions(connection: Connection, owner: PublicKey): Promise<string[]> {
    const held = await DLMM.getAllLbPairPositionsByUser(connection, owner);
    return [...held.entries()].filter(([, info]) => info.lbPairPositionsData.length > 0).map(([addr]) => addr);
  },
};
