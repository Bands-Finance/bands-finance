/**
 * On-chain universe: every DLMM LbPair on Solana, narrowed to live SOL/USDC-quoted pools,
 * with reserves fetched so liquidity is measured from chain rather than reported.
 */
import DLMM, { getBaseFee, getVariableFee, LbPairAccount } from "@meteora-ag/dlmm";
import { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import { binPriceUi } from "../tools/dlmm";
import type { OnchainPool } from "./types";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const QUOTES: Record<string, { symbol: "SOL" | "USDC"; decimals: number }> = {
  [SOL_MINT]: { symbol: "SOL", decimals: 9 },
  [USDC_MINT]: { symbol: "USDC", decimals: 6 },
};

export interface ScanOptions {
  /** only pools that traded within this many hours */
  activeHours: number;
  /** cap on pools whose reserves are fetched, most recently traded first */
  maxLive: number;
  /** minimum liquidity in quote units (SOL for SOL pools; USDC pools use x100) */
  minTvlSol: number;
  log?: (s: string) => void;
}

export interface ScanOutput {
  pools: OnchainPool[];
  scanned: number;
  live: number;
  scanMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bnNum = (v: unknown): number => Number((v as { toString(): string }).toString());
const feePct = (bn: { toString(): string }) => (Number(bn.toString()) / 1e9) * 100;

/** getMultipleAccounts in sequential chunks with pacing and backoff, so a public RPC survives it. */
async function pacedGetMultipleAccounts(
  connection: Connection,
  keys: PublicKey[],
  { chunk = 100, pauseMs = 250, log = (_: string) => {} }: { chunk?: number; pauseMs?: number; log?: (s: string) => void } = {},
): Promise<(AccountInfo<Buffer> | null)[]> {
  const out: (AccountInfo<Buffer> | null)[] = [];
  for (let i = 0; i < keys.length; i += chunk) {
    const batch = keys.slice(i, i + chunk);
    let delay = 1000;
    for (let attempt = 0; ; attempt++) {
      try {
        out.push(...(await connection.getMultipleAccountsInfo(batch, "confirmed")));
        break;
      } catch (err) {
        if (attempt >= 6) throw err;
        log(`[scan] rpc backoff ${delay}ms after: ${(err as Error).message.slice(0, 80)}`);
        await sleep(delay);
        delay *= 2;
      }
    }
    if (i + chunk < keys.length) await sleep(pauseMs);
  }
  return out;
}

function tokenAmount(data: Buffer | null | undefined): bigint | null {
  if (!data || data.length < 72) return null;
  return data.readBigUInt64LE(64);
}
function mintDecimals(data: Buffer | null | undefined): number | null {
  if (!data || data.length < 45) return null;
  return data[44];
}

export async function scanOnchain(connection: Connection, opts: ScanOptions): Promise<ScanOutput> {
  const t0 = Date.now();
  const log = opts.log ?? (() => {});
  const pairs: LbPairAccount[] = await DLMM.getLbPairs(connection);
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - opts.activeHours * 3600;

  const live = pairs
    .filter((p) => QUOTES[p.account.tokenYMint.toBase58()] && p.account.status === 0)
    .map((p) => ({ p, last: bnNum(p.account.vParameters.lastUpdateTimestamp) }))
    .filter((x) => x.last >= cutoff)
    .sort((a, b) => b.last - a.last)
    .slice(0, opts.maxLive);
  log(`[scan] ${pairs.length} pools on chain, ${live.length} live SOL/USDC pools to price (${Date.now() - t0}ms)`);

  const keys: PublicKey[] = [];
  for (const { p } of live) keys.push(p.account.reserveX, p.account.reserveY, p.account.tokenXMint);
  const infos = keys.length ? await pacedGetMultipleAccounts(connection, keys, { log }) : [];

  const pools: OnchainPool[] = [];
  live.forEach(({ p, last }, i) => {
    const a = p.account;
    const quote = QUOTES[a.tokenYMint.toBase58()];
    const rx = tokenAmount(infos[i * 3]?.data);
    const ry = tokenAmount(infos[i * 3 + 1]?.data);
    const dec = mintDecimals(infos[i * 3 + 2]?.data);
    if (rx === null || ry === null || dec === null) return;
    const price = binPriceUi(a.activeId, a.binStep, dec, quote.decimals);
    const reserveBase = Number(rx) / 10 ** dec;
    const reserveQuote = Number(ry) / 10 ** quote.decimals;
    const tvlQuote = reserveQuote + reserveBase * price;
    const minTvl = quote.symbol === "SOL" ? opts.minTvlSol : opts.minTvlSol * 100;
    if (!(tvlQuote >= minTvl)) return;
    pools.push({
      address: p.publicKey.toBase58(),
      baseMint: a.tokenXMint.toBase58(),
      quoteMint: a.tokenYMint.toBase58(),
      quoteSymbol: quote.symbol,
      baseDecimals: dec,
      quoteDecimals: quote.decimals,
      binStep: a.binStep,
      baseFeePct: feePct(getBaseFee(a.binStep, a.parameters)),
      dynamicFeePct: feePct(getVariableFee(a.binStep, a.parameters, a.vParameters)),
      activeBinId: a.activeId,
      price,
      reserveBase,
      reserveQuote,
      tvlQuote,
      quoteShare: tvlQuote > 0 ? reserveQuote / tvlQuote : 0,
      lastTradeAt: last > 0 ? last * 1000 : null,
      volatilityAccumulator: a.vParameters.volatilityAccumulator,
      maxVolatilityAccumulator: a.parameters.maxVolatilityAccumulator,
      protocolFeeBase: a.protocolFee.amountX.toString(),
      protocolFeeQuote: a.protocolFee.amountY.toString(),
      protocolSharePct: a.parameters.protocolShare / 100,
    });
  });
  pools.sort((x, y) => y.tvlQuote - x.tvlQuote);
  return { pools, scanned: pairs.length, live: live.length, scanMs: Date.now() - t0 };
}
