/**
 * H1: the desk keeps its hands off its own token (docs/sprint.md, "What the desk does with it: nothing").
 * PURE, apart from reading the environment the way the other guards do.
 *
 *   - The house mint is $MRBANDS: TOKEN_MINT once it is launched, plus anything on PAIR_HOUSE_MINTS (which stays
 *     unset through 8 Oct by decision, but if someone sets it, those mints are the house too).
 *   - The desk never swaps a house mint: no Jupiter leg (acquire, shortfall, liquidate, surplus, residue, sweep)
 *     whose input or output is one. The check sits in JupiterClient.quote, the one door every leg goes through.
 *   - The desk never opens a band in a pool that holds a house mint on either side (src/risk/guards.ts).
 *   - The copycat "Mr Bands" $BANDS (COPYCAT_MINTS, launched by someone else on 21 Sep) gets the same treatment:
 *     the desk never swaps it and never seats it, so nothing on-chain can read as the desk backing it.
 *
 * Jupiter filters routes by DEX label, not by pool, so a route through some other pool is not excluded here.
 * With no house pool seated and no house token held, "never swaps it" is the whole rule.
 */

/** The copycat "Mr Bands" $BANDS (X @MrBandsSol). Not ours: launched through a ClawPump agent that is not his. */
export const COPYCAT_MINTS: readonly string[] = ["JAARLUawF9DTauc9pHUyYpga8mDU3172cY7NzLfhpJ6m"];

const mintList = (raw: string | undefined): string[] => (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** The house mints: TOKEN_MINT and PAIR_HOUSE_MINTS, de-duplicated. Empty until the token exists. */
export function houseMintsOf(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set([...mintList(env.TOKEN_MINT), ...mintList(env.PAIR_HOUSE_MINTS)])];
}

/** Every mint the desk may never touch: the house mints and the copycat's. */
export interface UntouchableMints {
  house: readonly string[];
  copycat: readonly string[];
}

export function untouchableMints(env: NodeJS.ProcessEnv = process.env): UntouchableMints {
  return { house: houseMintsOf(env), copycat: COPYCAT_MINTS };
}

function whose(mint: string, m: UntouchableMints): "house" | "copycat" | null {
  if (!mint) return null;
  if (m.house.includes(mint)) return "house";
  if (m.copycat.includes(mint)) return "copycat";
  return null;
}

/** H1 on a swap leg: a violation when the input or the output is a house or copycat mint, else null. */
export function houseSwapViolation(inputMint: string, outputMint: string, m: UntouchableMints = untouchableMints()): string | null {
  for (const [side, mint] of [["input", inputMint], ["output", outputMint]] as const) {
    const who = whose(mint, m);
    if (who === "house") return `house token: the swap's ${side} is the house mint ${mint}; the desk never swaps its own token (H1)`;
    if (who === "copycat") return `copycat token: the swap's ${side} is ${mint}, the "Mr Bands" $BANDS that is not ours; the desk never touches it (H1)`;
  }
  return null;
}

/** H1 on a pool: a violation when either side of the pool is a house or copycat mint, else null. */
export function housePoolViolation(pool: { address: string; label?: string; mints: readonly string[] }, m: UntouchableMints = untouchableMints()): string | null {
  for (const mint of pool.mints) {
    const who = whose(mint, m);
    const name = pool.label ? `${pool.label} (${pool.address})` : pool.address;
    if (who === "house") return `house token: ${name} holds the house mint ${mint}; the desk never opens a band in its own token's pool (H1)`;
    if (who === "copycat") return `copycat token: ${name} holds ${mint}, the "Mr Bands" $BANDS that is not ours; the desk never seats it (H1)`;
  }
  return null;
}
