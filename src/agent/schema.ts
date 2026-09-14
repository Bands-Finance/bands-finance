import { z } from "zod";

export const ActionSchema = z.enum(["HOLD", "OPEN_POSITION", "CLOSE_POSITION", "CLAIM_FEES", "REBALANCE"]);
export type Action = z.infer<typeof ActionSchema>;

export const OpenParamsSchema = z.object({
  side: z
    .enum(["SOL_ONLY", "TOKEN_ONLY", "BOTH"])
    .describe(
      "SOL_ONLY means QUOTE-only: only the pool's quote token (SOL in a SOL-quoted pool, USDC in a USDC-quoted pool), at/below the active bin when the quote is token Y; it buys the base as price falls. TOKEN_ONLY: only the base token, on the other side of the active bin; it sells the base as price rises. BOTH: straddle the active bin with both.",
    ),
  amountSol: z.number().describe("Amount of the pool's QUOTE token to deposit, UI units: SOL in a SOL-quoted pool, USDC in a USDC-quoted pool (the observation names the quote). 0 for TOKEN_ONLY."),
  amountToken: z.number().describe("Base token to deposit in UI units. 0 for SOL_ONLY."),
  binsBelowActive: z.number().describe("Integer >= 0. Must be 0 for the side that sits above the active bin (TOKEN_ONLY when the quote is token Y)."),
  binsAboveActive: z.number().describe("Integer >= 0. Must be 0 for the side that sits below the active bin (SOL_ONLY when the quote is token Y)."),
  strategy: z.enum(["Spot", "Curve", "BidAsk"]).describe("Spot: uniform. Curve: concentrated near active. BidAsk: heavier at the edges."),
  acquireToken: z
    .number()
    .optional()
    .describe("Base token to BUY with the quote (a Jupiter swap) before depositing, for a BOTH band when the wallet does not hold it; 0 or absent otherwise. amountToken is the full token leg deposited, acquireToken the part of it the swap must bring in."),
});
export type OpenParams = z.infer<typeof OpenParamsSchema>;

/** What Mr Bands returns every cycle. The guards decide whether it happens. */
export const DecisionSchema = z.object({
  action: ActionSchema,
  open: OpenParamsSchema.nullable().describe("Required for OPEN_POSITION and REBALANCE, else null."),
  positionAddress: z.string().nullable().describe("Required for CLOSE_POSITION and REBALANCE. Null for CLAIM_FEES means all positions."),
  reasoning: z.string().describe("2-5 sentences of numeric reasoning grounded in the observation."),
  confidence: z.number().describe("0 to 1."),
  headline: z.string().describe("One line in Mr Bands' voice, max 90 chars, for the public journal."),
  liquidate: z
    .boolean()
    .optional()
    .describe("CLOSE_POSITION only: sell the base token that comes back into the quote (a Jupiter swap), for stock bands so the book returns to USDC. Default false. Ignored on other actions; a REBALANCE of a BOTH band balances its own legs."),
});
export type Decision = z.infer<typeof DecisionSchema>;

export function holdDecision(reasoning: string, headline = "Bands stay in the pocket."): Decision {
  return { action: "HOLD", open: null, positionAddress: null, reasoning, confidence: 1, headline };
}
