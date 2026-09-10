import type { PoolSnapshot, PositionSnapshot } from "../tools/dlmm";
import type { PoolAnalytics } from "../tools/lpagent";

export interface JournalGlimpse {
  ts: string;
  action: string;
  allowed: boolean;
  headline: string;
  violations: string[];
}

/** Everything Mr Bands gets to see for one decision. */
export interface Observation {
  ts: string;
  cycle: number;
  mode: "dry-run" | "live";
  poolLabel: string;
  snapshot: PoolSnapshot;
  positions: PositionSnapshot[];
  wallet: { address: string; sol: number; token: number; tokenSymbol: string };
  analytics: PoolAnalytics | null;
  state: { actionsToday: number; lastActionAt: number | null; lastPrice: number | null; killSwitch: boolean };
  recent: JournalGlimpse[];
}

const r = (n: number | null | undefined, digits = 4) =>
  n === null || n === undefined || !Number.isFinite(n) ? "n/a" : Number(n.toFixed(digits)).toString();
const sig = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? "n/a" : n.toPrecision(6);

export function formatObservation(o: Observation): string {
  const s = o.snapshot;
  const lines: string[] = [];
  lines.push(`# Observation ${o.ts} (cycle ${o.cycle}, mode ${o.mode})`);
  lines.push("");
  lines.push(`## Pool ${s.label} (${s.address})`);
  lines.push(`- token X: ${s.tokenX.symbol} (${s.tokenX.decimals} dec), reserve ${r(s.tokenX.reserve, 2)}`);
  lines.push(`- token Y: ${s.tokenY.symbol} (${s.tokenY.decimals} dec), reserve ${r(s.tokenY.reserve, 2)}`);
  lines.push(`- SOL is token ${s.solSide ?? "neither"}; base token is ${s.baseToken.symbol}`);
  lines.push(`- bin step: ${s.binStep} bps | active bin: ${s.activeBinId} | price: ${sig(s.activePrice)} ${s.priceLabel}`);
  lines.push(`- fees: base ${r(s.baseFeePct, 3)}% | dynamic now ${r(s.dynamicFeePct, 3)}% | max ${r(s.maxFeePct, 2)}%`);
  lines.push(`- observed depth: ${r(s.liquidityBelowY, 3)} ${s.tokenY.symbol} below active, ${r(s.liquidityAboveX, 2)} ${s.tokenX.symbol} above`);
  if (o.state.lastPrice) {
    const move = (s.activePrice / o.state.lastPrice - 1) * 100;
    lines.push(`- price change since last cycle: ${move >= 0 ? "+" : ""}${r(move, 2)}%`);
  }
  lines.push("");
  lines.push("## Bins around active (binId | price | X | Y)");
  for (const b of s.bins) {
    lines.push(`${b.isActive ? ">" : " "} ${b.binId} | ${sig(b.price)} | ${r(b.xAmount, 2)} | ${r(b.yAmount, 4)}${b.isActive ? "  <- ACTIVE" : ""}`);
  }
  lines.push("");
  lines.push("## External analytics");
  if (o.analytics) {
    const a = o.analytics;
    lines.push(`- source: ${a.source} (${a.note})`);
    lines.push(`- price USD: ${sig(a.priceUsd)} | 24h change: ${r(a.priceChange24hPct, 2)}%`);
    lines.push(`- 24h volume: $${r(a.volume24hUsd, 0)} | TVL: $${r(a.tvlUsd, 0)} | est. 24h fees: $${r(a.fees24hUsd, 0)} | fee/TVL 24h: ${r(a.feeToTvl24hPct, 3)}%`);
    lines.push(`- 24h txns: ${a.txns24h ?? "n/a"}`);
  } else {
    lines.push("- unavailable this cycle");
  }
  lines.push("");
  lines.push(`## Wallet ${o.wallet.address}`);
  lines.push(`- ${r(o.wallet.sol, 4)} SOL | ${r(o.wallet.token, 2)} ${o.wallet.tokenSymbol}`);
  lines.push("");
  lines.push(`## Open bands (${o.positions.length})`);
  if (o.positions.length === 0) lines.push("- none");
  for (const p of o.positions) {
    lines.push(
      `- ${p.address}: bins [${p.lowerBinId}, ${p.upperBinId}] (${p.widthBins} wide) price [${sig(p.lowerPrice)}, ${sig(p.upperPrice)}] ` +
        `${p.inRange ? "IN RANGE" : `OUT OF RANGE by ${Math.abs(p.binsFromRange)} bins (${p.binsFromRange < 0 ? "price below band" : "price above band"})`} | ` +
        `holds ${r(p.amountX, 2)} ${s.tokenX.symbol} + ${r(p.amountY, 4)} ${s.tokenY.symbol} | unclaimed fees ${r(p.feeX, 2)} ${s.tokenX.symbol} + ${r(p.feeY, 5)} ${s.tokenY.symbol} | value ${r(p.valueInSol, 4)} SOL`,
    );
  }
  lines.push("");
  lines.push("## Risk bookkeeping");
  lines.push(`- actions today: ${o.state.actionsToday}`);
  lines.push(`- last action: ${o.state.lastActionAt ? `${Math.round((Date.now() - o.state.lastActionAt) / 60000)} min ago` : "never"}`);
  lines.push(`- kill switch: ${o.state.killSwitch ? "ACTIVE (no new exposure)" : "off"}`);
  lines.push("");
  lines.push("## Your recent decisions (newest first)");
  if (o.recent.length === 0) lines.push("- none yet");
  for (const g of o.recent) {
    lines.push(`- ${g.ts} ${g.action} ${g.allowed ? "ok" : `BLOCKED: ${g.violations.join("; ")}`} - "${g.headline}"`);
  }
  return lines.join("\n");
}
