import { z } from "zod";

export const ActionSchema = z.enum(["HOLD", "OPEN_POSITION", "CLOSE_POSITION", "CLAIM_FEES", "REBALANCE"]);
export type Action = z.infer<typeof ActionSchema>;

export const OpenParamsSchema = z.object({
  side: z
    .enum(["SOL_ONLY", "TOKEN_ONLY", "BOTH"])
    .describe("SOL_ONLY: SOL at/below the active bin. TOKEN_ONLY: token at/above it. BOTH: straddle."),
  amountSol: z.number().describe("SOL to deposit. 0 for TOKEN_ONLY."),
  amountToken: z.number().describe("Base token to deposit in UI units. 0 for SOL_ONLY."),
  binsBelowActive: z.number().describe("Integer >= 0. Must be 0 for TOKEN_ONLY."),
  binsAboveActive: z.number().describe("Integer >= 0. Must be 0 for SOL_ONLY."),
  strategy: z.enum(["Spot", "Curve", "BidAsk"]).describe("Spot: uniform. Curve: concentrated near active. BidAsk: heavier at the edges."),
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
});
export type Decision = z.infer<typeof DecisionSchema>;

export function holdDecision(reasoning: string, headline = "Bands stay in the pocket."): Decision {
  return { action: "HOLD", open: null, positionAddress: null, reasoning, confidence: 1, headline };
}
