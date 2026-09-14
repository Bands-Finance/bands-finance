/**
 * Bin geometry for both price models the desk trades. Pure: no RPC, no SDK.
 *
 *   meteora-dlmm  a bin is a DLMM bin: price(binId) = (1 + binStep/1e4)^binId, binStep in bps
 *   clmm          a bin is one tick-spacing step of a concentrated pool (Raydium CLMM, Orca):
 *                 bin i spans ticks [i x spacing, (i+1) x spacing), price(binId) = 1.0001^(binId x spacing),
 *                 binStep = tickSpacing (a tick is one basis point), activeBinId = floor(tickCurrent / spacing)
 *
 * Both prices are scaled by 10^(xDecimals - yDecimals) to UI units (Y per X). The difference matters:
 * (1 + s/1e4)^i and 1.0001^(i x s) drift apart by ~0.6% at tick 20,000, so a CLMM band marked with the
 * Meteora formula would mis-price every bin.
 *
 * CLMM single-sided bands sit strictly to one side of the current tick: a range that contains the
 * current tick needs both tokens. So a quote-only band under the price covers the bins below the
 * active bin, not the active bin itself (Meteora lets the quote sit in the active bin).
 */

export type PriceModel = "meteora-dlmm" | "clmm";

/** ticks per tick array on Raydium CLMM (60 x spacing ticks per array account) */
export const TICK_ARRAY_SIZE = 60;

export interface BinPriceInput {
  binStep: number;
  priceModel?: PriceModel;
  tokenX: { decimals: number };
  tokenY: { decimals: number };
}

/** A snapshot with no priceModel is a Meteora DLMM snapshot (every snapshot written before venues). */
export function priceModelOf(s: { priceModel?: PriceModel } | null | undefined): PriceModel {
  return s?.priceModel === "clmm" ? "clmm" : "meteora-dlmm";
}

/** Price of one X in Y at a bin, UI units, under the snapshot's price model. */
export function binPrice(s: BinPriceInput, binId: number): number {
  const scale = Math.pow(10, s.tokenX.decimals - s.tokenY.decimals);
  if (priceModelOf(s) === "clmm") return Math.pow(1.0001, binId * s.binStep) * scale;
  return Math.pow(1 + s.binStep / 10_000, binId) * scale;
}

/** The bin a tick falls in. */
export function tickToBin(tick: number, spacing: number): number {
  if (!(spacing > 0) || !Number.isInteger(spacing)) throw new Error(`bad tick spacing ${spacing}`);
  return Math.floor(tick / spacing);
}

/** The tick range of a bin: [tickLower, tickUpper). */
export function binToTicks(binId: number, spacing: number): { tickLower: number; tickUpper: number } {
  return { tickLower: binId * spacing, tickUpper: (binId + 1) * spacing };
}

/** The bins a tick range covers: ticks [tickLower, tickUpper) -> bins [lowerBinId, upperBinId]. Ticks must sit on the spacing. */
export function ticksToBins(tickLower: number, tickUpper: number, spacing: number): { lowerBinId: number; upperBinId: number } {
  if (tickLower % spacing !== 0 || tickUpper % spacing !== 0) throw new Error(`ticks [${tickLower}, ${tickUpper}) are not multiples of the spacing ${spacing}`);
  if (tickUpper <= tickLower) throw new Error(`empty tick range [${tickLower}, ${tickUpper})`);
  return { lowerBinId: tickLower / spacing, upperBinId: tickUpper / spacing - 1 };
}

/** Start tick of the tick array holding a tick (Raydium: 60 ticks x spacing per array). */
export function tickArrayStart(tick: number, spacing: number): number {
  const ticksPerArray = TICK_ARRAY_SIZE * spacing;
  return Math.floor(tick / ticksPerArray) * ticksPerArray;
}

export type BandSide = "SOL_ONLY" | "TOKEN_ONLY" | "BOTH";

export interface BandGeometry {
  lowerBinId: number;
  upperBinId: number;
  tickLower: number;
  tickUpper: number;
  /** which token the band deposits when it sits on one side of the price; null for a two-sided band */
  singleSided: "X" | "Y" | null;
  note: string | null;
}

/**
 * Where a desk band lands on a CLMM pool. The desk describes a band as binsBelow/binsAbove the
 * active bin (a Meteora band includes the active bin). On a CLMM the single-sided cases exclude
 * the active bin so the deposit stays single-sided:
 *   quote is Y (below): SOL_ONLY  -> bins [a - binsBelow, a - 1]          (deposits Y only)
 *                       TOKEN_ONLY -> bins [a + 1, a + binsAbove]          (deposits X only)
 *   quote is X (above): SOL_ONLY  -> bins [a + 1, a + binsAbove]          (deposits X only)
 *                       TOKEN_ONLY -> bins [a - binsBelow, a - 1]          (deposits Y only)
 *   BOTH                          -> bins [a - binsBelow, a + binsAbove]  (both tokens)
 * tickLower = lowerBinId x spacing, tickUpper = (upperBinId + 1) x spacing.
 */
export function clmmBandTicks(activeBinId: number, spacing: number, binsBelow: number, binsAbove: number, side: BandSide, quoteSide: "X" | "Y"): BandGeometry {
  const a = activeBinId;
  let lowerBinId: number;
  let upperBinId: number;
  let singleSided: "X" | "Y" | null = null;
  let note: string | null = null;
  const quoteBelow = quoteSide === "Y";
  const belowOnly = side === "SOL_ONLY" ? quoteBelow : side === "TOKEN_ONLY" ? !quoteBelow : null;
  if (belowOnly === null) {
    lowerBinId = a - binsBelow;
    upperBinId = a + binsAbove;
  } else if (belowOnly) {
    lowerBinId = a - binsBelow;
    upperBinId = a - 1;
    singleSided = "Y";
    note = "CLMM: single-sided liquidity sits strictly under the price, so the active bin is excluded";
  } else {
    lowerBinId = a + 1;
    upperBinId = a + binsAbove;
    singleSided = "X";
    note = "CLMM: single-sided liquidity sits strictly over the price, so the active bin is excluded";
  }
  if (upperBinId < lowerBinId) throw new Error(`a single-sided CLMM band needs at least one bin ${belowOnly ? "under" : "over"} the active bin`);
  return { lowerBinId, upperBinId, tickLower: lowerBinId * spacing, tickUpper: (upperBinId + 1) * spacing, singleSided, note };
}
