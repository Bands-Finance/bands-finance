/**
 * PURE. Which quotes the wallet can seat a NEW band in: SOL above the gas reserve and the rent budget, USDC at the SOL
 * price. A pre-filter only: rent is counted at a position's (the least any Meteora open pays), and the policy checks the
 * pool's real open cost against the gas reserve before it proposes anything.
 *
 * THE LOPSIDED WALLET. Clearing the minimum seat is not enough when the other quote holds the book. On 25 Sep 2026 the
 * wallet held 1.04 SOL and 497 USDC (about 4.15 SOL) with one seat allowed: SOL cleared the 0.175 SOL minimum by a hair
 * (0.185 after the 0.8 gas reserve and rent), the picker took BP/SOL on its heat, laid 0.19 SOL there and left the USDC
 * idle, and the band's rent and exit swap cost more than it earned (net -0.0043 SOL in 17 minutes). A quote is dropped
 * for new seats when BOTH hold: its seat is under `minSharePct` of the other quote's (each capped at the band the policy
 * would lay this regime), and it is under `dropUnderSol` in absolute terms. A side that still seats a real band is kept,
 * so the desk never sits flat on the big side's thin board while the small side could work (25 Sep review: a 1.5 SOL
 * seat is worth its rent; a 0.19 SOL one is not). A held band is worked whatever its quote.
 */
export type Quote = "SOL" | "USDC";

export interface FundsInput {
  sol: number;
  usdc: number;
  /** USD per SOL; null when the screen has none (then USDC cannot be valued and is not fundable) */
  solPriceUsd: number | null;
  gasReserveSol: number;
  maxPositionSol: number;
  /**
   * the board regime's size multiple (src/engine/breakers.ts regimeView: 1, 0.5, or 0 for opens off). The policy lays at
   * most maxPositionSol x this, so the lopsided test compares the quotes at that band. At 0 no band is laid and the cycle
   * opens resume may lay a full one, so the raw max band stands. Omitted = 1.
   */
  regimeMultiplier?: number;
  minSeatSol: number;
  positionRentSol: number;
  maxActivePools: number;
  /** a quote whose seat is under this share of the best quote's seat may be dropped; 0 = off (POLICY_QUOTE_MIN_SHARE_PCT) */
  minSharePct: number;
  /** ...and only while that seat is also under this many SOL (POLICY_QUOTE_DROP_UNDER_SOL) */
  dropUnderSol: number;
}

export interface Funds {
  quotes: Set<Quote>;
  /** the seat each quote could fund, SOL, before the max-band cap */
  seatSol: Record<Quote, number>;
  /** a sentence for the log when a quote cleared the minimum and was dropped as the lopsided side; else null */
  dropped: string | null;
}

export function fundsOf(o: FundsInput): Funds {
  const rentBudget = o.positionRentSol * o.maxActivePools;
  const solSeat = Math.max(0, o.sol - o.gasReserveSol - rentBudget);
  const usdcSeat = o.solPriceUsd !== null && o.solPriceUsd > 0 ? Math.max(0, o.usdc / o.solPriceUsd) : 0;
  const quotes = new Set<Quote>();
  if (solSeat >= o.minSeatSol) quotes.add("SOL");
  // a USDC open still pays its rent in SOL, above the gas reserve
  if (usdcSeat >= o.minSeatSol && o.sol - o.positionRentSol >= o.gasReserveSol) quotes.add("USDC");
  const seatSol: Record<Quote, number> = { SOL: solSeat, USDC: usdcSeat };
  let dropped: string | null = null;
  if (quotes.size === 2 && o.minSharePct > 0) {
    const m = o.regimeMultiplier;
    const maxBandSol = o.maxPositionSol * (typeof m === "number" && m > 0 && m < 1 ? m : 1);
    const capped = (q: Quote) => Math.min(seatSol[q], maxBandSol);
    const best: Quote = capped("SOL") >= capped("USDC") ? "SOL" : "USDC";
    const other: Quote = best === "SOL" ? "USDC" : "SOL";
    if (capped(other) < (o.minSharePct / 100) * capped(best) && capped(other) < o.dropUnderSol) {
      quotes.delete(other);
      dropped =
        `the wallet can seat ${capped(best).toFixed(3)} SOL in ${best} but only ${capped(other).toFixed(3)} SOL in ${other} ` +
        `(under ${o.minSharePct}% of it and under ${o.dropUnderSol} SOL): new seats go to ${best} pools`;
    }
  }
  return { quotes, seatSol, dropped };
}

/**
 * PURE. The candidates a rotation may seat: those in a quote the wallet the close returns to can fund. fundsOf is not
 * monotone: the band's money comes home in its own quote (a ROTATE liquidates the token into it) and can make the other
 * quote the lopsided side, so a target ranked on the cycle-start wallet would be refused at seatFor a cycle later, after
 * the band it beat was closed, and the seat would go to a pool nothing compared.
 */
export function seatableAfterClose<T extends { quoteSymbol: string }>(
  candidates: readonly T[],
  wallet: FundsInput,
  band: { quote: Quote; valueInQuote: number; rentRefundSol: number },
): { seatable: T[]; after: Set<Quote> } {
  const sol = wallet.sol + band.rentRefundSol + (band.quote === "SOL" ? band.valueInQuote : 0);
  const after = fundsOf({ ...wallet, sol, usdc: wallet.usdc + (band.quote === "USDC" ? band.valueInQuote : 0) }).quotes;
  return { seatable: candidates.filter((c) => after.has(c.quoteSymbol as Quote)), after };
}

/**
 * A number knob as the desk reads it: unset or blank means the default (a `KEY=` line in ops/live.env is sourced as "",
 * and a blank means the default everywhere else: config.ts, policy.ts num()); junk or negative means the default too.
 */
export function knobOf(v: string | undefined, d: number): number {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}
