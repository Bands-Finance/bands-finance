/**
 * H1: the desk keeps its hands off its own token (docs/sprint.md, "What the desk does with it: nothing").
 * PURE, apart from reading the environment the way the other guards do.
 *
 *   - The house mint is $BANDS: TOKEN_MINT once the talk layer may name it, HOUSE_MINT_GUARD for the guards alone
 *     (a mint the desk must refuse while nothing about it is said: the talk layer never reads it, and the sites
 *     cut it out of what they publish), plus anything on PAIR_HOUSE_MINTS (which stays unset through 8 Oct by
 *     decision, but if someone sets it, those mints are the house too).
 *   - The desk never swaps a house mint: no Jupiter leg (acquire, shortfall, liquidate, surplus, residue, sweep)
 *     whose input or output is one. The check sits in JupiterClient.quote, the one door every leg goes through.
 *   - The desk never opens a band in a pool that holds a house mint on either side (src/risk/guards.ts).
 *   - The copycat "Mr Bands" $BANDS (COPYCAT_MINTS, launched by someone else on 21 Sep) gets the same treatment:
 *     the desk never swaps it and never seats it, so nothing on-chain can read as the desk backing it.
 *
 * Jupiter filters routes by DEX label, not by pool, so a route through some other pool is not excluded here.
 * With no house pool seated and no house token held, "never swaps it" is the whole rule.
 */

/**
 * The copycat "Mr Bands" $BANDS. Not ours: launched through a ClawPump agent that is not his. Its metadata links
 * mrbands.finance and @MrBandsSol, which are HIS OWN site and X account, borrowed to look genuine; only the mint
 * tells the two apart.
 */
export const COPYCAT_MINTS: readonly string[] = ["JAARLUawF9DTauc9pHUyYpga8mDU3172cY7NzLfhpJ6m"];

const mintList = (raw: string | undefined): string[] => (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** The house mints: TOKEN_MINT, HOUSE_MINT_GUARD and PAIR_HOUSE_MINTS, de-duplicated. Empty until one is set. */
export function houseMintsOf(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set([...mintList(env.TOKEN_MINT), ...mintList(env.HOUSE_MINT_GUARD), ...mintList(env.PAIR_HOUSE_MINTS)])];
}

/** The house mints nothing public may print: HOUSE_MINT_GUARD alone (TOKEN_MINT is the one the talk layer names). */
export function quietHouseMintsOf(env: NodeJS.ProcessEnv = process.env): string[] {
  return mintList(env.HOUSE_MINT_GUARD);
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
    // the house mint is never printed: a veto's text can reach the journal the sites publish
    if (who === "house") return `house token: the swap's ${side} is the house mint; the desk never swaps its own token (H1)`;
    if (who === "copycat") return `copycat token: the swap's ${side} is ${mint}, the "Mr Bands" $BANDS that is not his; the desk never touches it (H1)`;
  }
  return null;
}

/** H1 on a pool: a violation when either side of the pool is a house or copycat mint, else null. */
export function housePoolViolation(pool: { address: string; label?: string; mints: readonly string[] }, m: UntouchableMints = untouchableMints()): string | null {
  for (const mint of pool.mints) {
    const who = whose(mint, m);
    const name = pool.label ? `${pool.label} (${pool.address})` : pool.address;
    if (who === "house") return `house token: ${name} holds the house mint; the desk never opens a band in its own token's pool (H1)`;
    if (who === "copycat") return `copycat token: ${name} holds ${mint}, the "Mr Bands" $BANDS that is not his; the desk never seats it (H1)`;
  }
  return null;
}

// ---- no other token's mint on the websites (Zach, 22 Sep: "lets not disclose this on the website at all") ----

const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]+/g;

/**
 * True when a base58 run is a piece of a copycat mint: the whole mint, any 6+ character piece of it, or a 4+
 * character run it starts or ends with ("JAARLU...pJ6m" loses both halves).
 */
export function isCopycatPiece(run: string, mints: readonly string[] = COPYCAT_MINTS): boolean {
  if (run.length < 4) return false;
  return mints.some((m) => (run.length >= 6 && m.includes(run)) || m.startsWith(run) || m.endsWith(run));
}

/** PURE. Text with every copycat mint, or piece of one, cut out. Anything the sites or the platform chat print. */
export function redactCopycat(text: string, mints: readonly string[] = COPYCAT_MINTS): string {
  if (!text) return text;
  return text.replace(BASE58_RUN, (run) => (isCopycatPiece(run, mints) ? "" : run));
}

/** PURE. A JSON value with redactCopycat applied to every string in it (keys stay). */
export function redactCopycatDeep<T>(value: T, mints: readonly string[] = COPYCAT_MINTS): T {
  if (typeof value === "string") return redactCopycat(value, mints) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactCopycatDeep(v, mints)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactCopycatDeep(v, mints);
    return out as T;
  }
  return value;
}

/**
 * A streaming redactor for text that arrives in chunks (the platform chat's SSE): a mint split across two
 * chunks is still caught, because a trailing base58 run is held back until the next chunk (or end) shows
 * where it stops.
 */
export function copycatStreamFilter(mints: readonly string[] = COPYCAT_MINTS): { push(chunk: string): string; flush(): string } {
  let pending = "";
  return {
    push(chunk: string): string {
      const text = pending + chunk;
      const m = /[1-9A-HJ-NP-Za-km-z]+$/.exec(text);
      const cut = m ? m.index : text.length;
      pending = text.slice(cut);
      return redactCopycat(text.slice(0, cut), mints);
    },
    flush(): string {
      const out = redactCopycat(pending, mints);
      pending = "";
      return out;
    },
  };
}
