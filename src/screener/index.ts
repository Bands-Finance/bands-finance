/**
 * The screener: scan every DLMM pool on chain, shortlist by liquidity, enrich, measure fees
 * from chain where history allows, score, rank, persist to data/screen.json.
 */
import fs from "node:fs";
import path from "node:path";
import { Connection } from "@solana/web3.js";
import { config } from "../config";
import { enrichPools } from "./enrich";
import { loadHistory, recordSamples, windowStats } from "./history";
import { scanOnchain } from "./scan";
import { scorePool } from "./score";
import type { ScreenedPool, ScreenResult } from "./types";

const short = (m: string) => `${m.slice(0, 4)}…${m.slice(-4)}`;
export const SCREEN_FILE = () => path.resolve(process.cwd(), config.dataDir, "screen.json");

export function loadScreen(): ScreenResult | null {
  try {
    return JSON.parse(fs.readFileSync(SCREEN_FILE(), "utf8")) as ScreenResult;
  } catch {
    return null;
  }
}

export async function runScreen(connection: Connection, log: (s: string) => void = console.log): Promise<ScreenResult> {
  const o = config.screen;
  const scan = await scanOnchain(connection, { activeHours: o.activeHours, maxLive: o.maxLive, minTvlSol: o.minTvlSol, log });
  log(`[screen] scanned ${scan.scanned} DLMM pools, ${scan.live} traded in ${o.activeHours}h, ${scan.pools.length} above the liquidity floor (${scan.scanMs}ms)`);

  const shortlist = scan.pools.slice(0, o.maxPools);
  const history = loadHistory();
  recordSamples(history, shortlist);
  const enriched = await enrichPools(shortlist.map((p) => p.address), { log });
  log(`[screen] enriched ${enriched.size}/${shortlist.length} pools`);

  const solPriceUsd = [...enriched.values()].find((e) => e.quoteSymbol === "SOL" && e.quotePriceUsd)?.quotePriceUsd ?? null;
  const quoteUsd = (q: "SOL" | "USDC") => (q === "USDC" ? 1 : solPriceUsd);

  const pools: ScreenedPool[] = shortlist.map((p) => {
    const e = enriched.get(p.address);
    const qUsd = quoteUsd(p.quoteSymbol);
    const tvlUsd = qUsd !== null ? p.tvlQuote * qUsd : e?.reserveUsd ?? null;
    const win = windowStats(history, p);
    const useOnchain = win !== null && win.hours >= 6;
    const feesEstimate = e?.volume24hUsd !== null && e?.volume24hUsd !== undefined ? e.volume24hUsd * (p.baseFeePct / 100) : null;
    const fees24hUsd = useOnchain && qUsd !== null ? (win.feesQuote * qUsd * 24) / win.hours : feesEstimate;
    const partial: Omit<ScreenedPool, "score" | "flags" | "rank"> = {
      ...p,
      name: e?.name ?? `${short(p.baseMint)} / ${p.quoteSymbol}`,
      baseSymbol: e?.baseSymbol ?? short(p.baseMint),
      tvlUsd,
      volume24hUsd: e?.volume24hUsd ?? null,
      fees24hUsd,
      feesSource: fees24hUsd === null ? null : useOnchain ? "onchain" : "estimate",
      feesWindowHours: useOnchain ? Math.round(win.hours * 10) / 10 : null,
      feeToTvl24hPct: fees24hUsd !== null && tvlUsd ? (fees24hUsd / tvlUsd) * 100 : null,
      turnover24h: e?.volume24hUsd !== null && e?.volume24hUsd !== undefined && tvlUsd ? e.volume24hUsd / tvlUsd : null,
      priceChange24hPct: e?.priceChange24hPct ?? null,
      binRangePct: win ? Math.round(win.binRangePct * 100) / 100 : null,
      txns24h: e?.txns24h ?? null,
      mcapUsd: e?.mcapUsd ?? e?.fdvUsd ?? null,
      fdvUsd: e?.fdvUsd ?? null,
      ageHours: e?.createdAt ? (Date.now() - e.createdAt) / 3600e3 : null,
      priceUsd: e?.priceUsd ?? null,
    };
    return { ...partial, ...scorePool(partial), rank: 0 };
  });
  pools.sort((a, b) => b.score - a.score || (b.feeToTvl24hPct ?? 0) - (a.feeToTvl24hPct ?? 0));
  pools.forEach((p, i) => (p.rank = i + 1));

  const result: ScreenResult = {
    generatedAt: new Date().toISOString(),
    scanMs: scan.scanMs,
    scannedPools: scan.scanned,
    livePools: scan.live,
    rankedPools: pools.length,
    solPriceUsd,
    pools,
  };
  fs.mkdirSync(path.dirname(SCREEN_FILE()), { recursive: true });
  fs.writeFileSync(SCREEN_FILE(), JSON.stringify(result));
  return result;
}
