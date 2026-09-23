/**
 * Token-2022 TRANSFER FEES. A mint with a TransferFeeConfig keeps a cut of every transfer: the pool
 * paying a close or a claim into the wallet, the wallet paying a deposit or a sale into the pool.
 * On 17-18 Sep seven memecoins the desk made markets in charged 300 bps (ALLINU 100): every close and
 * every claim arrived exactly 3% short, a sale paid it again, the ledger booked the snapshot amount, and
 * 2.6 SOL of a 19.8 SOL book went to the mints in 39 hours without one line of the desk pricing it.
 *
 * The config is read from the mint the venue already loaded (Meteora's DLMM.create reads both mints,
 * extensions included), once per mint per process: no extra RPC. The fee is taken as the larger of the
 * older and newer configs, so a fee scheduled to rise next epoch is priced now (the desk reads no epoch).
 * Pure apart from the cache.
 */
import { getTransferFeeConfig, type Mint } from "@solana/spl-token";

export interface TransferFee {
  /** basis points of every transfer the mint keeps */
  bps: number;
  /** the most one transfer can be charged, UI units; null when the cap is effectively none */
  maxUi: number | null;
}

const cache = new Map<string, TransferFee | null>();

/** PURE. The fee a mint's TransferFeeConfig charges, or null when it has none (or charges 0). */
export function transferFeeOfMint(mint: Pick<Mint, "tlvData" | "decimals">): TransferFee | null {
  let cfg: ReturnType<typeof getTransferFeeConfig>;
  try {
    cfg = getTransferFeeConfig(mint as Mint);
  } catch {
    return null;
  }
  if (!cfg) return null;
  const older = cfg.olderTransferFee;
  const newer = cfg.newerTransferFee;
  const pick = Number(newer.transferFeeBasisPoints) >= Number(older.transferFeeBasisPoints) ? newer : older;
  const bps = Number(pick.transferFeeBasisPoints);
  if (!(bps > 0)) return null;
  const maxRaw = pick.maximumFee;
  // u64::MAX (and anything past 2^53) is "no cap" in practice
  const maxUi = maxRaw > 0n && maxRaw < 2n ** 53n ? Number(maxRaw) / 10 ** mint.decimals : null;
  return { bps, maxUi };
}

/** The fee of a mint by address, read once from the loaded mint and remembered for the process. */
export function transferFeeFor(address: string, mint: Pick<Mint, "tlvData" | "decimals"> | null | undefined): TransferFee | null {
  if (cache.has(address)) return cache.get(address)!;
  if (!mint) return null;
  const fee = transferFeeOfMint(mint);
  cache.set(address, fee);
  return fee;
}

/** PURE. What one transfer of `amountUi` pays the mint, UI units (0 without a fee). */
export function transferFeeCharged(amountUi: number, fee: TransferFee | null | undefined): number {
  if (!fee || !(fee.bps > 0) || !(amountUi > 0)) return 0;
  const cut = (amountUi * fee.bps) / 10_000;
  return fee.maxUi !== null && fee.maxUi >= 0 ? Math.min(cut, fee.maxUi) : cut;
}

/** PURE. What the recipient of one transfer of `amountUi` actually gets. */
export const afterTransferFee = (amountUi: number, fee: TransferFee | null | undefined): number => amountUi - transferFeeCharged(amountUi, fee);

/** PURE. The share of value lost on `hops` transfers in a row (a claim and its sale are two), 0..1, ignoring the cap. */
export function transferFeeShare(fee: TransferFee | null | undefined, hops: number): number {
  if (!fee || !(fee.bps > 0) || !(hops > 0)) return 0;
  return 1 - Math.pow(1 - Math.min(10_000, fee.bps) / 10_000, hops);
}

/** Tests only. */
export function resetTransferFeeCache(): void {
  cache.clear();
}
