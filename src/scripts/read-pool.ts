/**
 * Read a pool through its venue adapter (Meteora DLMM or Raydium CLMM): active bin, price, quote,
 * fees, the bins around the price, and the configured wallet's positions. Read-only.
 *   npm run read-pool -- <pool address> [--bins N] [--positions] [--build-open <quote amount> --bins-below N]
 *   --positions     read positions even for the ephemeral wallet (expect none)
 *   --build-open    build (never send) a quote-only band of that many quote tokens, N bins under the
 *                   price, for the configured or ephemeral wallet: prints the instruction count, the
 *                   signers, the serialized size and the venue's open-cost estimate
 */
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { config, riskLimits } from "../config";
import { toOpenPlan } from "../executor";
import { loadScreen } from "../screener";
import { KNOWN_TOKENS, quoteOf } from "../tools/dlmm";
import { Wallet } from "../tools/wallet";
import { loadVenuePool, RENT_LAMPORTS_PER_BYTE, rentSol } from "../venues";

const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

async function main(): Promise<void> {
  const address = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : config.pinnedPools[0];
  if (!address) {
    console.error("usage: npm run read-pool -- <pool address> [--bins N] [--positions] [--build-open <quote> --bins-below N]   (or set POOL_ADDRESS)");
    process.exit(1);
  }
  const binsEachSide = Number(arg("bins", "5"));
  console.log(`RPC   ${config.rpcUrl}`);
  console.log(`pool  ${address}`);
  const connection = new Connection(config.rpcUrl, "confirmed");
  const screen = loadScreen();
  // Symbols come from the screen's enrichment; the chain only knows mints.
  for (const p of screen?.pools ?? []) if (p.baseSymbol && !p.baseSymbol.includes("\u2026")) KNOWN_TOKENS[p.baseMint] = p.baseSymbol;
  const row = screen?.pools.find((p) => p.address === address);
  const t0 = Date.now();
  const { venue, pool } = await loadVenuePool(connection, address, row?.venue);
  const s = await venue.snapshot(pool, binsEachSide, { solPriceUsd: screen?.solPriceUsd ?? null });
  const q = quoteOf(s);
  console.log(`loaded in ${Date.now() - t0}ms via ${venue.id}${row ? ` (screen #${row.rank} ${row.name}${row.stock ? `, stock ${row.stock.ticker}/${row.stock.issuer}` : ""})` : ""}\n`);

  console.log(`pair        ${s.label}`);
  console.log(`token X     ${s.tokenX.symbol}  ${s.tokenX.mint}  (${s.tokenX.decimals} dec)  reserve ${s.tokenX.reserve.toFixed(2)}`);
  console.log(`token Y     ${s.tokenY.symbol}  ${s.tokenY.mint}  (${s.tokenY.decimals} dec)  reserve ${s.tokenY.reserve.toFixed(4)}`);
  console.log(`model       ${s.priceModel ?? "meteora-dlmm"}${s.clmm ? ` (tick ${s.clmm.tickCurrent}, spacing ${s.clmm.tickSpacing}, liquidity ${s.clmm.liquidity}, tick arrays on chain at ${s.clmm.initializedTickArrays.join(" ")})` : ""}`);
  console.log(`bin step    ${s.binStep} bps`);
  console.log(`active bin  ${s.activeBinId}`);
  console.log(`price       ${s.activePrice.toPrecision(8)} ${s.priceLabel}`);
  console.log(`quote       ${q.symbol} (token ${q.side}); 1 ${q.symbol} = ${q.priceInSol.toFixed(6)} SOL; ${s.baseToken.symbol} = ${q.tokenPriceInQuote.toPrecision(6)} ${q.symbol} = ${s.tokenPriceInSol.toPrecision(6)} SOL${s.solPriceUsd ? ` (SOL $${s.solPriceUsd.toFixed(2)})` : ""}`);
  console.log(`fees        base ${s.baseFeePct.toFixed(3)}%  dynamic ${s.dynamicFeePct.toFixed(3)}%  max ${s.maxFeePct.toFixed(2)}%${s.hasDynamicFee !== undefined ? `  hasDynamicFee ${s.hasDynamicFee}` : ""}`);
  console.log(`depth       ${s.liquidityBelowY.toFixed(4)} ${s.tokenY.symbol} below active, ${s.liquidityAboveX.toFixed(4)} ${s.tokenX.symbol} above (observed bins)`);
  console.log("");
  console.log("bins around active   binId        price          X            Y");
  for (const b of s.bins) {
    console.log(
      `${b.isActive ? "  >" : "   "} ${String(b.binId).padStart(18)}  ${b.price.toPrecision(8).padStart(14)}  ${b.xAmount.toFixed(2).padStart(12)}  ${b.yAmount.toFixed(4).padStart(12)}${b.isActive ? "   <- active" : ""}`,
    );
  }

  const wallet = Wallet.fromConfig(connection);
  console.log(`\nwallet      ${wallet.publicKey.toBase58()}${wallet.ephemeral ? "  (ephemeral, no key configured)" : `  ${(await wallet.solBalance()).toFixed(4)} SOL`}`);
  if (!wallet.ephemeral || flag("positions")) {
    const { positions } = await venue.positions(pool, wallet.publicKey, s);
    console.log(`positions   ${positions.length}`);
    for (const p of positions) {
      console.log(`  ${p.address}  bins [${p.lowerBinId}, ${p.upperBinId}]  ${p.inRange ? "in range" : `out of range (${p.binsFromRange} bins)`}  ${p.amountX.toFixed(4)} ${s.tokenX.symbol} + ${p.amountY.toFixed(4)} ${s.tokenY.symbol}, fees ${p.feeX.toFixed(6)} / ${p.feeY.toFixed(6)}  value ${p.valueInSol.toFixed(4)} SOL`);
    }
  } else {
    console.log("positions   (set WALLET_SECRET_KEY, or pass --positions to read them for the ephemeral wallet)");
  }

  if (flag("build-open")) {
    const amountQuote = Number(arg("build-open", "0"));
    const binsBelow = Number(arg("bins-below", "20"));
    const quoteBelow = q.side === "Y";
    const open = { side: "SOL_ONLY" as const, amountSol: amountQuote, amountToken: 0, binsBelowActive: quoteBelow ? binsBelow : 0, binsAboveActive: quoteBelow ? 0 : binsBelow, strategy: "Spot" as const };
    const plan = toOpenPlan(open, s);
    const cost = venue.openCostSol(s, plan);
    console.log(`\nbuild-open  ${amountQuote} ${q.symbol} quote-only, ${binsBelow} bins ${quoteBelow ? "under" : "over"} the price (plan bins [${plan.minBinId}, ${plan.maxBinId}], slippage ${riskLimits.maxSlippagePct}%), NOT sent`);
    const t1 = Date.now();
    const built = await venue.buildOpen(pool, wallet.publicKey, plan, s);
    const tx = built.tx;
    const versioned = tx instanceof VersionedTransaction;
    let size: string;
    try {
      size = `${versioned ? tx.serialize().length : tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length} bytes`;
    } catch (err) {
      size = `n/a (${(err as Error).message.slice(0, 60)})`;
    }
    console.log(`  built in ${Date.now() - t1}ms: ${built.label}`);
    console.log(`  transaction   ${versioned ? `versioned v0, ${tx.message.compiledInstructions.length} instructions, ${tx.message.addressTableLookups.length} lookup table(s), ${tx.message.staticAccountKeys.length} static keys` : `legacy, ${tx.instructions.length} instructions`}, ${size}`);
    console.log(`  signers       wallet ${wallet.publicKey.toBase58()} + ${built.signers.map((k) => k.publicKey.toBase58()).join(", ") || "none"}`);
    console.log(`  position      ${built.positionAddress ?? "n/a"}`);
    console.log(`  open cost     ${cost.total.toFixed(6)} SOL total, ${cost.refundable.toFixed(6)} refundable${cost.note ? ` (${cost.note})` : ""}`);
    for (const n of built.notes ?? []) console.log(`  note          ${n}`);
    if (s.priceModel === "clmm") {
      const onChain = await connection.getMinimumBalanceForRentExemption(10240);
      console.log(`  rent check    chain says a 10240-byte tick array needs ${(onChain / 1e9).toFixed(6)} SOL; the estimate uses ${rentSol(10240).toFixed(6)} (${RENT_LAMPORTS_PER_BYTE} lamports/byte)${Math.abs(onChain / 1e9 - rentSol(10240)) < 1e-9 ? " -> matches" : " -> MISMATCH, update RENT_LAMPORTS_PER_BYTE"}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
