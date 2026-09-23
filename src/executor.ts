/**
 * Turns an allowed verdict into transactions. In DRY_RUN the transactions are built
 * and simulated (when a real wallet is configured) but never broadcast.
 *
 * After every successful operation the executor writes cash-boundary rows to the attribution
 * ledger (src/engine/ledger.ts): open = -deposit -rent, close = +amounts +fees +rent refund,
 * collect = +fees, skim = -amount. Live rows are exact when the wallet's SOL delta and fee come
 * from the confirmed transaction (or a balance read before and after the broadcast), marked when
 * they had to come from the position snapshot. Dry-run rows are written too, tagged "dry-run".
 *
 * Quotes: `open.amountSol` is an amount of the pool's QUOTE token (SOL in a SOL pool, USDC in a
 * USDC pool); toOpenPlan maps it onto X/Y by the quote side. A row's quote leg (quoteDelta, in the
 * quote token's units) is what crossed the boundary; solDelta is its SOL-equivalent at the row's
 * markQuoteInSol so every fold stays in SOL. In a USDC pool the SOL balance only moves for rent
 * and fees, so an "exact" USDC row takes quoteDelta from the wallet's USDC token-balance delta
 * (the transaction's pre/post token balances, else a balance read before and after); when that
 * cannot be measured the row is "marked" from the position snapshot.
 *
 * Token leg: a row's tokenDelta is what crossed the wallet boundary. Live, it is read from the transaction's own
 * pre/post token balances of the pool's base mint; failing that, the position snapshot's figure LESS the mint's
 * Token-2022 transfer fee (src/tools/transferFee.ts). Seven memecoins of 17-18 Sep kept 3% of every close and claim,
 * and the snapshot figure booked tokens the wallet never received (the breaker could not see 1.3 SOL of one day's loss).
 *
 * The close's rent: live, a close refunds exactly the lamports its position account holds, which is the rent paid at
 * open; they are read from the chain before the close (Venue.closeRefundSol). The 0.0574 estimate is the SDK's fee at
 * the old rent rate: the chain refunds 0.0419 today, and booking the estimate moved 0.0155 SOL of every close's quote
 * leg into the rent column (a phantom loss the circuit breaker counted).
 *
 * Every legacy transaction gets a compute-unit price before it is signed (src/tools/priorityFee.ts), at the urgent
 * level for an emergency close (a STOP or a FLATTEN). A transaction whose confirmation failed is looked up by its
 * signature before it is taken as unsent (Wallet.signAndSend).
 *
 * The treasury skim runs in its own failure domain (executeSkim): a failed skim never blocks trading.
 *
 * Paper mode: when the loop passes `ctx.paper` (PAPER_SOL > 0 under DRY_RUN), execute() hands the
 * verdict to src/paper/executor.ts, which applies it to the virtual book and returns mode "paper"
 * with the same ledger rows; nothing below it runs and the chain is never touched.
 *
 * Venues (src/venues): the context carries the venue and its pool handle; every transaction is built
 * by the venue (Meteora legacy transactions, Raydium versioned ones) and signed and sent by the
 * wallet. A venue that is tradable but not in LIVE_VENUES is refused before anything is built when
 * DRY_RUN=false: it trades in paper and dry-run only until Zach turns it on.
 *
 * Swap legs (src/tools/jupiter.ts), the stock straddle's: a BOTH open with `acquireToken` buys the
 * token the wallet lacks before the deposit (ExactIn, sized at the pool price plus SWAP_SLIPPAGE_BPS;
 * live, the deposit's token leg is then clamped to what the wallet actually holds); a CLOSE with
 * `liquidate` sells the token the band handed back; a REBALANCE of a BOTH band closes, buys the
 * shortfall or sells the surplus (only what the band returned), then deposits. Each leg is one
 * Jupiter VersionedTransaction run like any other: simulated in dry-run, broadcast live, ledgered
 * as a "swap" row (quote leg exact when measured, token leg from the quote).
 *
 * A made pair (src/venues/pair.ts) whose pool does not exist yet is CREATED before the seed: the
 * venue builds the create transaction; in DRY_RUN it is simulated and the journal says "would
 * create ... and seat ..." (the seed cannot be built until the pool is on chain); with DRY_RUN=false
 * it is sent only when PAIR_LIVE=true and meteora-dlmm is in LIVE_VENUES, else built, simulated and
 * kept; when it lands the pool handle is reloaded and the ordinary open (swap, then deposit) follows.
 * The creation is ledgered as a "rent" row and reported in `created` for RiskState.pairPools.
 */
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { config, riskLimits } from "./config";
import type { OpenParams } from "./agent/schema";
import type { SkimPlan } from "./engine/collect";
import { LedgerRow, recordLedger } from "./engine/ledger";
import type { Verdict } from "./risk/guards";
import { OpenPlan, PoolSnapshot, POSITION_RENT_NOW_SOL, POSITION_RENT_SOL, PositionSnapshot, quoteOf, QuoteView, SOL_MINT, STRATEGY_BY_NAME, toRawBN } from "./tools/dlmm";
import { fromRawUnits, jupiter, toRawUnits, type JupiterQuote } from "./tools/jupiter";
import { applyPriorityFee } from "./tools/priorityFee";
import { afterTransferFee, transferFeeCharged } from "./tools/transferFee";
import type { AnyTransaction, Wallet } from "./tools/wallet";
import { executePaper, type PaperExecutionContext } from "./paper/executor";
import { isLiveVenue, liveVenues } from "./venues/env";
import { isPairPool, PAIR_CREATION_RENT_SOL, PAIR_POOL_ACCOUNTS_RENT_SOL, pairBroadcastRefusal, type PairPool } from "./venues/pair";
import type { BuiltTx, OpenCost, Venue, VenuePool } from "./venues/types";

export interface TxReport {
  label: string;
  ok: boolean;
  signature?: string;
  error?: string;
  unitsConsumed?: number;
  logsTail?: string[];
  skipped?: string;
  /** the compute-unit price the transaction was sent at (src/tools/priorityFee.ts), micro-lamports; absent when none was added */
  priorityMicroLamports?: number;
}

export interface ExecutionResult {
  /** "paper": applied to the paper book (src/paper), nothing built or broadcast */
  mode: "none" | "dry-run" | "live" | "paper";
  ok: boolean;
  txs: TxReport[];
  opened?: { address: string; entryValueSol: number };
  closed?: string;
  /** the bands whose fees a CLAIM_FEES landed for */
  claimed?: string[];
  /** what an exit could not sell under the caps: the desk comes back for it */
  residue?: Residue;
  /** a made pair's pool was created (broadcast) this execution: what RiskState.pairPools records */
  created?: { pool: string; lbPair: string; rentSol: number; sig: string | null };
  notes: string[];
  /** attribution rows written for this execution (src/engine/ledger.ts) */
  ledger?: LedgerRow[];
}

export interface ExecutionContext {
  /** the venue adapter and its pool handle (src/venues) */
  venue: Venue;
  pool: VenuePool;
  wallet: Wallet;
  /** the venue's raw positions, index-aligned with `positions` */
  rawPositions: unknown[];
  snapshot: PoolSnapshot;
  positions: PositionSnapshot[];
  /** paper mode: the book to apply the verdict to instead of the chain (src/paper/executor.ts) */
  paper?: Omit<PaperExecutionContext, "snapshot" | "positions" | "openCost">;
  /** the wallet's base-token balance before execution, UI units: the swap legs size against it (absent: 0) */
  walletToken?: number;
  /**
   * A quote-only book (memecoin bands): base tokens in the wallet are fee claims or what a failed
   * liquidation left, never inventory. With this set a claim sells them once they are worth `minQuote`
   * and a liquidation sells them with the band's. Never set for a straddle, which re-uses its token.
   */
  sweepWalletToken?: { minQuote: number };
  /**
   * Price impact the desk will pay on a sell, percent (SWAP_IMPACT_* in the env). A sale is sized to what the
   * market takes under the cap in ONE swap, by quoting; the rest waits. A sweep waits for the next claim or
   * re-lay. An exit (SOL-quoted pools only) sells what fits under exitPct, then the rest at once if a quote
   * of the whole rest costs no more than hardPct, else the rest becomes a residue the desk sells on later
   * cycles, one swap a cycle, under exitPct for residueCycles attempts and under hardPct after that
   * (residueCapPct). Absent, or a cap of 0: one swap, whatever the impact (the old behaviour).
   */
  swapImpact?: SwapImpact;
  /** the desk cycle, stamped on a residue so the residue pass leaves it alone until the next cycle */
  cycle?: number;
}

/** PURE. The base-token amount a sweep sells: everything held, once it is worth the minimum in the quote; else 0. */
export function sweepAmount(heldToken: number, tokenPriceInQuote: number, minQuote: number): number {
  if (!(heldToken > SWAP_DUST_TOKEN) || !(tokenPriceInQuote > 0)) return 0;
  return heldToken * tokenPriceInQuote >= minQuote ? heldToken : 0;
}

/** token amounts under this are dust: no swap leg is worth a transaction */
export const SWAP_DUST_TOKEN = 1e-6;

/** amountSol is the QUOTE deposit (SOL or USDC), amountToken the base: mapped onto X/Y by the quote side, not by where SOL sits. */
export function toOpenPlan(o: OpenParams, s: PoolSnapshot): OpenPlan {
  const quoteIsX = quoteOf(s).side === "X";
  return {
    minBinId: s.activeBinId - o.binsBelowActive,
    maxBinId: s.activeBinId + o.binsAboveActive,
    amountX: toRawBN(quoteIsX ? o.amountSol : o.amountToken, s.tokenX.decimals),
    amountY: toRawBN(quoteIsX ? o.amountToken : o.amountSol, s.tokenY.decimals),
    strategyType: STRATEGY_BY_NAME[o.strategy],
    slippagePct: riskLimits.maxSlippagePct,
    side: o.side,
  };
}

/**
 * Why the executor will not broadcast on a venue, or null when it may. Dry-run builds and simulates
 * on every tradable venue; a live process only broadcasts on LIVE_VENUES.
 */
export function broadcastRefusal(venueId: string, dryRun: boolean = config.dryRun, env: NodeJS.ProcessEnv = process.env): string | null {
  if (dryRun || isLiveVenue(venueId, env)) return null;
  return `venue ${venueId} is tradable but not live (LIVE_VENUES=${liveVenues(env).join(",") || "none"}): nothing built or broadcast; it trades in paper and dry-run only until LIVE_VENUES includes it`;
}

/** The venue's open cost for a decision, or undefined when the context carries no venue (tests). */
function openCostOf(ctx: ExecutionContext, open: OpenParams | null | undefined): OpenCost | undefined {
  if (typeof ctx.venue?.openCostSol !== "function") return undefined;
  return ctx.venue.openCostSol(ctx.snapshot, open ? toOpenPlan(open, ctx.snapshot) : undefined);
}

/** SOL-equivalent of a band deposit at the snapshot's marks: the entry value the risk state keeps. */
export function entryValueOf(o: OpenParams, s: PoolSnapshot): number {
  const q = quoteOf(s);
  return (o.amountSol + o.amountToken * q.tokenPriceInQuote) * q.priceInSol;
}

/** What one broadcast did to the wallet, when it could be measured. */
interface Cash {
  walletDeltaSol: number;
  txFeeSol: number;
  /** the wallet's delta of the quote token in UI units; null for a SOL pool (the SOL delta is the quote delta) or when it could not be measured */
  quoteDelta: number | null;
  /** the wallet's delta of the pool's base token in UI units, from the transaction's token balances; null when it could not be measured */
  tokenDelta: number | null;
}

interface TxOutcome {
  ok: boolean;
  signature: string | null;
  /** chain-measured; null in dry-run or when neither the tx meta nor a balance pair was readable */
  cash: Cash | null;
}

/** marked network fee for a dry-run row: one signature */
const MARKED_TX_FEE_SOL = 0.000005;

interface RunTxOptions {
  /** the pool's base mint: the wallet's delta of it is read from the transaction's token balances */
  baseMint?: string | null;
  /** an exit at its stop or a flatten: the priority fee's urgent level */
  urgent?: boolean;
  /** what the broadcast has to say beyond the report (a confirmation lost for a transaction that landed) */
  notes?: string[];
}

/**
 * Build/simulate/broadcast one transaction. `quoteMint` is the pool's quote mint: for a non-SOL
 * quote the wallet's balance of it is measured around the broadcast so the row's quote leg is exact.
 * A legacy transaction is given its compute-unit price first (src/tools/priorityFee.ts).
 */
async function runTx(wallet: Wallet, label: string, tx: AnyTransaction, signers: Keypair[], txs: TxReport[], quoteMint: string = SOL_MINT, opt: RunTxOptions = {}): Promise<TxOutcome> {
  if (config.dryRun && wallet.ephemeral) {
    txs.push({ label, ok: true, skipped: "dry-run with ephemeral wallet: built, not simulated" });
    return { ok: true, signature: null, cash: null };
  }
  let priority: { priorityMicroLamports: number } | Record<string, never> = {};
  try {
    const applied = await applyPriorityFee(tx, (wallet as Partial<Wallet>).connection ?? null, opt.urgent === true);
    if (applied) priority = { priorityMicroLamports: applied.microLamports };
  } catch {
    /* the price is an improvement, never a reason not to send */
  }
  if (config.dryRun) {
    try {
      const sim = await wallet.simulate(tx, signers);
      txs.push({
        label,
        ok: sim.ok,
        error: sim.ok ? undefined : JSON.stringify(sim.err),
        unitsConsumed: sim.unitsConsumed,
        logsTail: sim.logsTail,
        ...priority,
      });
      return { ok: sim.ok, signature: null, cash: null };
    } catch (err) {
      txs.push({ label, ok: false, error: (err as Error).message });
      return { ok: false, signature: null, cash: null };
    }
  }
  const measureQuote = quoteMint !== SOL_MINT;
  let before: number | null = null;
  let quoteBefore: number | null = null;
  try {
    before = await wallet.solBalance();
    if (measureQuote) quoteBefore = (await wallet.tokenBalance(new PublicKey(quoteMint))).ui;
  } catch {
    before = null;
    quoteBefore = null;
  }
  try {
    const signature = await wallet.signAndSend(tx, signers, opt.notes);
    txs.push({ label, ok: true, signature, ...priority });
    let cash: Cash | null = null;
    try {
      const sol = await wallet.txCashDelta(signature);
      let solLeg: Omit<Cash, "quoteDelta" | "tokenDelta"> | null = sol;
      if (!solLeg && before !== null) {
        const after = await wallet.solBalance();
        // a balance pair cannot separate the fee; count one signature's worth and keep the total exact
        solLeg = { walletDeltaSol: after - before, txFeeSol: -MARKED_TX_FEE_SOL * Math.max(1, signers.length + 1) };
      }
      if (solLeg) {
        let quoteDelta: number | null = null;
        if (measureQuote) {
          quoteDelta = await wallet.txTokenDelta(signature, quoteMint);
          if (quoteDelta === null && quoteBefore !== null) {
            const quoteAfter = (await wallet.tokenBalance(new PublicKey(quoteMint))).ui;
            quoteDelta = quoteAfter - quoteBefore;
          }
        }
        // the base token that crossed the boundary, as the transaction recorded it: a Token-2022 fee mint lands short of the snapshot
        let tokenDelta: number | null = null;
        if (opt.baseMint && opt.baseMint !== SOL_MINT && typeof wallet.txTokenDelta === "function") {
          try {
            tokenDelta = await wallet.txTokenDelta(signature, opt.baseMint);
          } catch {
            tokenDelta = null;
          }
        }
        cash = { ...solLeg, quoteDelta, tokenDelta };
      }
    } catch {
      cash = null;
    }
    return { ok: true, signature, cash };
  } catch (err) {
    txs.push({ label, ok: false, error: (err as Error).message, ...priority });
    return { ok: false, signature: null, cash: null };
  }
}

/**
 * Sum the cash of several broadcasts; exact only when every one of them was measured. For a
 * non-SOL quote the quote leg must have been measured on every broadcast too, else the operation
 * cannot claim an exact quote delta and the caller marks the row.
 */
function sumCash(outcomes: TxOutcome[], q: QuoteView): Cash | null {
  if (outcomes.length === 0 || outcomes.some((o) => !o.cash)) return null;
  const measureQuote = q.symbol !== "SOL";
  if (measureQuote && outcomes.some((o) => o.cash!.quoteDelta === null)) return null;
  // the token leg is exact only when every broadcast recorded it; otherwise the row falls back to the snapshot
  const tokenMeasured = outcomes.every((o) => typeof o.cash!.tokenDelta === "number");
  return outcomes.reduce<Cash>(
    (acc, o) => ({
      walletDeltaSol: acc.walletDeltaSol + o.cash!.walletDeltaSol,
      txFeeSol: acc.txFeeSol + o.cash!.txFeeSol,
      quoteDelta: measureQuote ? (acc.quoteDelta ?? 0) + o.cash!.quoteDelta! : null,
      tokenDelta: tokenMeasured ? (acc.tokenDelta ?? 0) + o.cash!.tokenDelta! : null,
    }),
    { walletDeltaSol: 0, txFeeSol: 0, quoteDelta: measureQuote ? 0 : null, tokenDelta: tokenMeasured ? 0 : null },
  );
}

const lastSig = (outcomes: TxOutcome[]): string | null => outcomes.map((o) => o.signature).filter((s): s is string => !!s).pop() ?? null;

/** Fee leg of a position: base token units, quote-side units, and the SOL-equivalent at the snapshot's marks. */
function feeLegs(p: PositionSnapshot, s: PoolSnapshot): { feeToken: number; feeQuoteSide: number; feeSol: number } {
  const q = quoteOf(s);
  const quoteIsX = q.side === "X";
  const feeToken = quoteIsX ? p.feeY : p.feeX;
  const feeQuoteSide = quoteIsX ? p.feeX : p.feeY;
  return { feeToken, feeQuoteSide, feeSol: (feeQuoteSide + feeToken * q.tokenPriceInQuote) * q.priceInSol };
}

/** Quote units of a position incl. quote fees (a snapshot written before the field existed is SOL-quoted). */
const quoteInPosition = (p: PositionSnapshot, q: QuoteView): number => p.quoteInPosition ?? p.solInPosition / q.priceInSol;

type RowBase = Omit<LedgerRow, "solDelta" | "quoteDelta" | "tokenDelta" | "rentSol" | "txFeeSol" | "basis" | "note">;

function baseRow(ctx: ExecutionContext, mech: LedgerRow["mech"], sig: string | null, position: string | null): RowBase {
  const q = quoteOf(ctx.snapshot);
  return {
    ts: Date.now(),
    mode: config.dryRun ? "dry-run" : "live",
    sig,
    pool: ctx.snapshot.address,
    position,
    mech,
    tokenMint: ctx.snapshot.baseToken.mint,
    markTokenInSol: ctx.snapshot.tokenPriceInSol,
    quoteMint: q.token.mint,
    markQuoteInSol: q.priceInSol,
  };
}

/** A row's quote leg and its SOL-equivalent, from the quote units. */
const quoteLeg = (quoteDelta: number, q: QuoteView): Pick<LedgerRow, "quoteDelta" | "solDelta"> => ({ quoteDelta, solDelta: quoteDelta * q.priceInSol });

/** The refundable rent of a position on this venue (the Meteora position rent by default). */
const refundableRent = (ctx: ExecutionContext): number => openCostOf(ctx, null)?.refundable ?? POSITION_RENT_SOL;

/**
 * The rent a live close's measured row books as refunded when the position account could not be read: on Meteora what an
 * account opened at today's rent rate holds (POSITION_RENT_NOW_SOL), never the old-rate estimate; elsewhere the venue's own.
 */
const measuredRefundFallback = (ctx: ExecutionContext): number => ((ctx.snapshot.priceModel ?? "meteora-dlmm") === "meteora-dlmm" ? POSITION_RENT_NOW_SOL : refundableRent(ctx));

/** The pool's base token's Token-2022 transfer fee, when it has one. */
const baseTransferFee = (s: PoolSnapshot) => s.baseToken.transferFee ?? null;

function openRow(ctx: ExecutionContext, o: OpenParams, position: string, outcomes: TxOutcome[]): LedgerRow {
  const q = quoteOf(ctx.snapshot);
  const cash = sumCash(outcomes, q);
  const base = baseRow(ctx, "open", lastSig(outcomes), position);
  if (cash) {
    const quoteDelta = q.symbol === "SOL" ? -o.amountSol : cash.quoteDelta!;
    // whatever the wallet paid in SOL beyond the SOL deposit and the fee is rent (position + any fresh bin arrays)
    const solDeposit = q.symbol === "SOL" ? quoteDelta : 0;
    return {
      ...base,
      ...quoteLeg(quoteDelta, q),
      tokenDelta: cash.tokenDelta ?? -o.amountToken,
      rentSol: cash.walletDeltaSol - cash.txFeeSol - solDeposit,
      txFeeSol: cash.txFeeSol,
      basis: "exact",
      note: `open ${o.side} band, ${outcomes.length} tx${q.symbol === "SOL" ? "" : `; ${q.symbol} leg from the wallet's token balance`}`,
    };
  }
  return {
    ...base,
    ...quoteLeg(-o.amountSol, q),
    tokenDelta: -o.amountToken,
    rentSol: -refundableRent(ctx),
    txFeeSol: -MARKED_TX_FEE_SOL * 2,
    basis: "marked",
    note: `open ${o.side} band; rent marked at the position rent (bin-array rent unknown)`,
  };
}

/**
 * The close row. `refundSol` is the rent the position account held, read from the chain before the close: exactly what
 * the close hands back. Without it a measured SOL-pool row books today's rent for a Meteora position (measuredRefundFallback)
 * and a marked row the estimate its marked open was charged, so each row's rent comes back as it went out.
 */
function closeRow(ctx: ExecutionContext, p: PositionSnapshot, outcomes: TxOutcome[], refundSol: number | null = null): LedgerRow {
  const s = ctx.snapshot;
  const q = quoteOf(s);
  const cash = sumCash(outcomes, q);
  const fee = baseTransferFee(s);
  const legs = feeLegs(p, s);
  // the token fee leg arrives less the mint's transfer fee, like the rest of the token
  const feeSol = legs.feeSol - transferFeeCharged(legs.feeToken, fee) * s.tokenPriceInSol;
  const snapToken = (q.side === "X" ? p.amountY : p.amountX) + legs.feeToken;
  const measuredToken = typeof cash?.tokenDelta === "number";
  const tokenDelta = measuredToken ? cash!.tokenDelta! : afterTransferFee(snapToken, fee);
  const tokenNote = measuredToken ? "; token leg from the transaction" : fee ? `; token leg from the snapshot less the ${fee.bps / 100}% transfer fee` : "";
  const common = { ...baseRow(ctx, "close", lastSig(outcomes), p.address), tokenDelta, feeSol, entryValueSol: p.entryValueSol };
  if (cash) {
    // SOL pool: the SOL that came back beyond the rent refund is the quote leg. USDC pool: the SOL
    // that came back IS the rent refund (measured) and the quote leg is the USDC delta.
    const rentSol = refundSol ?? measuredRefundFallback(ctx);
    const quoteDelta = q.symbol === "SOL" ? cash.walletDeltaSol - cash.txFeeSol - rentSol : cash.quoteDelta!;
    const rent = q.symbol === "SOL" ? rentSol : cash.walletDeltaSol - cash.txFeeSol;
    const rentNote = q.symbol !== "SOL" ? "" : refundSol !== null ? "; rent refund read off the position account" : `; rent refund at today's rate (the position account could not be read)`;
    return { ...common, ...quoteLeg(quoteDelta, q), rentSol: rent, txFeeSol: cash.txFeeSol, basis: "exact", note: `close band, ${outcomes.length} tx${rentNote}${tokenNote}` };
  }
  return {
    ...common,
    ...quoteLeg(quoteInPosition(p, q), q),
    rentSol: refundSol ?? refundableRent(ctx),
    txFeeSol: -MARKED_TX_FEE_SOL * Math.max(1, outcomes.length),
    basis: "marked",
    note: `close band; ${q.symbol} side taken from the position snapshot${tokenNote}`,
  };
}

function collectRow(ctx: ExecutionContext, targets: PositionSnapshot[], outcomes: TxOutcome[]): LedgerRow {
  const s = ctx.snapshot;
  const q = quoteOf(s);
  const cash = sumCash(outcomes, q);
  const fee = baseTransferFee(s);
  let snapToken = 0;
  let quoteSide = 0;
  let feeSol = 0;
  for (const p of targets) {
    const f = feeLegs(p, s);
    // each band's claim is its own transfer out of the pool: the mint keeps its cut of each
    snapToken += afterTransferFee(f.feeToken, fee);
    quoteSide += f.feeQuoteSide;
    feeSol += f.feeSol - transferFeeCharged(f.feeToken, fee) * s.tokenPriceInSol;
  }
  const measuredToken = typeof cash?.tokenDelta === "number";
  const tokenDelta = measuredToken ? cash!.tokenDelta! : snapToken;
  const position = targets.length === 1 ? targets[0].address : null;
  const common = { ...baseRow(ctx, "collect", lastSig(outcomes), position), tokenDelta, rentSol: 0, feeSol };
  if (cash) {
    const quoteDelta = q.symbol === "SOL" ? cash.walletDeltaSol - cash.txFeeSol : cash.quoteDelta!;
    // a measured claim's fee leg is the whole row as it arrived
    const arrived = measuredToken ? { feeSol: quoteDelta * q.priceInSol + tokenDelta * s.tokenPriceInSol } : {};
    return { ...common, ...arrived, ...quoteLeg(quoteDelta, q), txFeeSol: cash.txFeeSol, basis: "exact", note: `claim fees on ${targets.length} band(s), ${outcomes.length} tx${measuredToken ? "; token leg from the transaction" : fee ? `; token leg less the ${fee.bps / 100}% transfer fee` : ""}` };
  }
  return {
    ...common,
    ...quoteLeg(quoteSide, q),
    txFeeSol: -MARKED_TX_FEE_SOL * Math.max(1, outcomes.length),
    basis: "marked",
    note: `claim fees on ${targets.length} band(s); ${q.symbol} side taken from the position snapshot`,
  };
}

/** Base token units in a position incl. unclaimed base fees. */
function tokenInPosition(p: PositionSnapshot, s: PoolSnapshot): number {
  return quoteOf(s).side === "X" ? p.amountY + p.feeY : p.amountX + p.feeX;
}

/** The wallet's base-token balance from chain (live only); null when it cannot be read. */
async function readWalletToken(ctx: ExecutionContext): Promise<number | null> {
  if (config.dryRun || ctx.wallet.ephemeral || typeof ctx.wallet.tokenBalance !== "function") return null;
  try {
    return (await ctx.wallet.tokenBalance(new PublicKey(ctx.snapshot.baseToken.mint))).ui;
  } catch {
    return null;
  }
}

const fmtUnits = (n: number, d: number) => Number(n.toFixed(Math.min(d, 8))).toString();

/**
 * The wallet's base-token balance after a swap leg, once the read has caught up with the fill. A
 * balance read right after a confirmed swap can still return the old figure: on 2026-09-17 the first
 * live open read 0 NVDAx seconds after 1.15 had arrived, clamped the token leg to 0 and laid the SOL
 * half alone. Reads until the balance reaches `expectMin` or the attempts run out; returns the last
 * read (null when the wallet cannot be read at all).
 */
export async function settleWalletToken(
  read: () => Promise<number | null>,
  expectMin: number,
  o: { attempts?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<number | null> {
  const attempts = Math.max(1, o.attempts ?? 8);
  const waitMs = o.waitMs ?? 2000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: number | null = null;
  for (let i = 0; i < attempts; i++) {
    last = await read();
    if (last !== null && last + 1e-9 >= expectMin) return last;
    if (i < attempts - 1) await sleep(waitMs);
  }
  return last;
}
const floorTo = (n: number, d: number) => Math.floor(n * 10 ** d) / 10 ** d;

type SwapLeg = "acquire" | "liquidate" | "shortfall" | "surplus" | "sweep";

interface SwapLegOutcome {
  ok: boolean;
  /** base token units the wallet gained (+) or gave (-), from the quote (the fill may differ inside the slippage) */
  tokenDelta: number;
  quote: JupiterQuote | null;
  /** the quote came back above the impact allowed: nothing was sent */
  refused?: boolean;
}

export interface SwapImpact {
  sweepPct: number;
  exitPct: number;
  hardPct: number;
  /** attempts a residue waits at exitPct before the cap rises to hardPct, where it stays */
  residueCycles: number;
}

/** PURE. The sell caps from the env: null when both caps are 0 (no limit, one swap). An exit cap of 0 means exits are uncapped. */
export function swapImpactEnv(env: NodeJS.ProcessEnv): SwapImpact | null {
  const n = (k: string, d: number) => {
    const raw = (env[k] ?? "").trim();
    const v = Number(raw);
    return raw !== "" && Number.isFinite(v) ? Math.max(0, v) : d;
  };
  const sweepPct = n("SWAP_IMPACT_SWEEP_PCT", 1.5);
  const exitPct = n("SWAP_IMPACT_EXIT_PCT", 3);
  const hardPct = exitPct > 0 ? Math.max(exitPct, n("SWAP_IMPACT_HARD_PCT", 8)) : 0;
  const residueCycles = Math.max(1, Math.round(n("SWAP_RESIDUE_CYCLES", 4)));
  if (sweepPct === 0 && exitPct === 0) return null;
  return { sweepPct, exitPct, hardPct, residueCycles };
}

/** PURE. The cap a residue is sold under after `cycles` attempts: the exit cap, then the hard cap for as long as it takes (an operator decides anything past that). */
export function residueCapPct(caps: SwapImpact, cycles: number): number {
  if (caps.exitPct <= 0) return 0;
  return cycles < caps.residueCycles ? caps.exitPct : caps.hardPct;
}

/**
 * The largest amount of a sale the market takes under capPct, found by quoting: the whole sale first, then
 * scaled down by the cap's share of the quoted impact (with a margin, since impact grows faster than size on
 * a bin ladder) at most twice. Jupiter's impact is measured from the pool's CURRENT price, which is why a
 * sale is never cut into pieces sent back to back: each piece would read a small impact against a price the
 * piece before it had already moved. An impact of 0 is a route Jupiter could not measure: taken as under the cap.
 */
export async function sizeUnderCap(tokenUi: number, capPct: number, dec: number, impactOf: (amountUi: number) => Promise<number>): Promise<{ amount: number; impactPct: number; quotes: number }> {
  let amount = floorTo(tokenUi, dec);
  if (amount <= 0) return { amount: 0, impactPct: 0, quotes: 0 };
  let impact = await impactOf(amount);
  let quotes = 1;
  if (!(capPct > 0) || impact <= capPct) return { amount, impactPct: impact, quotes };
  for (let i = 0; i < 2; i++) {
    amount = floorTo((amount * capPct * 0.85) / impact, dec);
    if (amount <= 0) return { amount: 0, impactPct: impact, quotes };
    impact = await impactOf(amount);
    quotes++;
    if (impact <= capPct) return { amount, impactPct: impact, quotes };
  }
  return { amount: 0, impactPct: impact, quotes };
}

interface SwapLegOutcome {
  ok: boolean;
  /** base token units the wallet gained (+) or gave (-), from the quote (the fill may differ inside the slippage) */
  tokenDelta: number;
  quote: JupiterQuote | null;
  /** the quote came back above the impact allowed: nothing was sent */
  refused?: boolean;
}

/**
 * One Jupiter leg: BUY `tokenUi` of the base with the quote (acquire / shortfall: ExactIn sized at the
 * pool price plus the slippage allowance, since ExactOut is not routed for every pair) or SELL
 * `tokenUi` into the quote (liquidate / surplus). Built, then run like a venue transaction.
 */
async function runSwapLeg(ctx: ExecutionContext, leg: SwapLeg, tokenUi: number, result: ExecutionResult, ledger: (row: LedgerRow) => void, maxImpactPct = 0): Promise<SwapLegOutcome> {
  const s = ctx.snapshot;
  const q = quoteOf(s);
  const client = jupiter();
  const buy = leg === "acquire" || leg === "shortfall";
  const tokenDec = s.baseToken.decimals;
  const quoteDec = q.token.decimals;
  const base = s.baseToken.symbol;
  try {
    let jq: JupiterQuote;
    if (buy) {
      const quoteUi = tokenUi * q.tokenPriceInQuote * (1 + client.slippageBps / 10_000);
      jq = await client.quote({ inputMint: q.token.mint, outputMint: s.baseToken.mint, amount: toRawUnits(quoteUi, quoteDec) });
    } else {
      jq = await client.quote({ inputMint: s.baseToken.mint, outputMint: q.token.mint, amount: toRawUnits(tokenUi, tokenDec) });
    }
    const inUi = fromRawUnits(jq.inAmount, buy ? quoteDec : tokenDec);
    const outUi = fromRawUnits(jq.outAmount, buy ? tokenDec : quoteDec);
    const route = jq.routeLabels.join(" > ") || "?";
    if (maxImpactPct > 0 && jq.priceImpactPct > maxImpactPct) {
      result.notes.push(`${leg}: ${fmtUnits(inUi, buy ? quoteDec : tokenDec)} ${buy ? q.symbol : base} would move the price ${jq.priceImpactPct.toFixed(2)}% (route ${route}), over the ${maxImpactPct}% allowed: not sent`);
      return { ok: false, tokenDelta: 0, quote: jq, refused: true };
    }
    const built = await client.buildSwap(jq, ctx.wallet.publicKey);
    const label = `swap ${fmtUnits(inUi, buy ? quoteDec : tokenDec)} ${buy ? q.symbol : base} -> ~${fmtUnits(outUi, buy ? tokenDec : quoteDec)} ${buy ? base : q.symbol} (${leg} leg, Jupiter via ${route}, impact ${jq.priceImpactPct}%)`;
    const out = await runTx(ctx.wallet, label, built.tx, [], result.txs, q.token.mint, { baseMint: s.baseToken.mint, notes: result.notes });
    if (!out.ok) return { ok: false, tokenDelta: 0, quote: jq };
    const cash = out.cash;
    // the token that crossed, as the transaction recorded it; else the quote's figure (a buy of a fee mint lands its transfer fee short)
    const tokenMeasured = typeof cash?.tokenDelta === "number";
    const tokenDelta = tokenMeasured ? cash!.tokenDelta! : buy ? afterTransferFee(outUi, baseTransferFee(s)) : -inUi;
    const measured = !!cash && (q.symbol === "SOL" || cash.quoteDelta !== null);
    const quoteDelta = measured ? (q.symbol === "SOL" ? cash!.walletDeltaSol - cash!.txFeeSol : cash!.quoteDelta!) : buy ? -inUi : outUi;
    ledger({
      ...baseRow(ctx, "swap", out.signature, null),
      ...quoteLeg(quoteDelta, q),
      tokenDelta,
      rentSol: 0,
      txFeeSol: measured ? cash!.txFeeSol : -MARKED_TX_FEE_SOL,
      basis: measured ? "exact" : "marked",
      note: `${leg} leg: Jupiter ${buy ? `${q.symbol} -> ${base}` : `${base} -> ${q.symbol}`} via ${route}, impact ${jq.priceImpactPct}%, slippage ${jq.slippageBps} bps; token leg from ${tokenMeasured ? "the transaction" : "the quote"}`,
    });
    return { ok: true, tokenDelta, quote: jq };
  } catch (err) {
    result.txs.push({ label: `swap (${leg} leg)`, ok: false, error: (err as Error).message });
    return { ok: false, tokenDelta: 0, quote: null };
  }
}

export interface SellOutcome {
  /** base token units sold */
  sold: number;
  /** base token units not sold: the market would not take them under the cap, or the transaction failed */
  left: number;
  /** a transaction was sent and failed (a refusal for impact is not a failure) */
  failed: boolean;
  /** the impact the quote reported for what was sold, percent */
  impactPct: number;
}

const impactOfSale = (ctx: ExecutionContext) => async (amountUi: number): Promise<number> => {
  const s = ctx.snapshot;
  const q = quoteOf(s);
  const jq = await jupiter().quote({ inputMint: s.baseToken.mint, outputMint: q.token.mint, amount: toRawUnits(amountUi, s.baseToken.decimals) });
  return jq.priceImpactPct;
};

/**
 * SELL up to `tokenUi` of the base into the quote in ONE swap sized to what the market takes under capPct
 * (sizeUnderCap). The remainder is left where it is and reported; the caller decides what waits and what
 * comes back for. A cap of 0 sells everything in one swap, whatever the impact.
 */
async function sellUnderCap(ctx: ExecutionContext, leg: SwapLeg, tokenUi: number, capPct: number, result: ExecutionResult, ledger: (row: LedgerRow) => void): Promise<SellOutcome> {
  const dec = ctx.snapshot.baseToken.decimals;
  const symbol = ctx.snapshot.baseToken.symbol;
  const want = floorTo(tokenUi, dec);
  if (want <= 0) return { sold: 0, left: 0, failed: false, impactPct: 0 };
  let amount = want;
  let impactPct = 0;
  if (capPct > 0) {
    try {
      const sized = await sizeUnderCap(want, capPct, dec, impactOfSale(ctx));
      amount = sized.amount;
      impactPct = sized.impactPct;
      if (amount < want) result.notes.push(amount > 0 ? `${leg}: the market takes ${fmtUnits(amount, dec)} of ${fmtUnits(want, dec)} ${symbol} under ${capPct}% impact (${sized.quotes} quotes); the rest waits` : `${leg}: even a small sale of ${symbol} would move the price over ${capPct}% (${impactPct.toFixed(2)}% quoted); nothing sold, ${fmtUnits(want, dec)} waits`);
    } catch (err) {
      result.notes.push(`${leg}: could not size the sale (${(err as Error).message}); nothing sold this cycle`);
      return { sold: 0, left: want, failed: false, impactPct: 0 };
    }
  }
  if (amount <= 0) return { sold: 0, left: want, failed: false, impactPct };
  // a tolerance on the re-quote inside runSwapLeg: the sizing quote and the sending quote are seconds apart
  const out = await runSwapLeg(ctx, leg, amount, result, ledger, capPct > 0 ? capPct * 1.25 : 0);
  if (!out.ok) return { sold: 0, left: want, failed: !out.refused, impactPct: out.quote?.priceImpactPct ?? impactPct };
  const left = want - amount <= 10 ** -dec ? 0 : floorTo(want - amount, dec);
  return { sold: amount, left, failed: false, impactPct: out.quote?.priceImpactPct ?? impactPct };
}

/** What an exit could not sell: the desk comes back for it on later cycles (index.ts residues). */
export interface Residue {
  pool: string;
  /** the band it was left by, for the record */
  position: string | null;
  mint: string;
  symbol: string;
  decimals: number;
  quoteMint: string;
  amountUi: number;
  /** the pool's price at the exit, SOL a token: what the residue rows are marked against, so their impact shows in the record */
  markTokenInSol: number;
  /** epoch ms the residue was first left */
  since: number;
  /** the desk cycle that left it: the residue pass leaves it alone until the next one */
  cycle: number;
  /** attempts since, counted only when the market was actually asked (a quote came back) */
  cycles: number;
}

/**
 * Sell a residue from an earlier exit: what the wallet holds of the mint, under residueCapPct for the cycles
 * it has waited. Reads the balance first (a later sweep may have sold some), writes a swap row against the
 * pool it came from so the record stays whole, and returns what is still left.
 */
export async function sellResidue(wallet: Wallet, r: Residue, caps: SwapImpact | null, notes: string[]): Promise<{ left: number; sold: number; failed: boolean; attempted: boolean }> {
  const idle = { left: r.amountUi, sold: 0, failed: false, attempted: false };
  if (config.dryRun || wallet.ephemeral || typeof wallet.tokenBalance !== "function") return idle;
  if (r.quoteMint !== SOL_MINT) {
    notes.push(`residue ${r.symbol}: quoted in a token other than SOL; the desk does not sell it here (should not happen: exits in such pools are not capped)`);
    return idle;
  }
  let held: number;
  try {
    held = (await wallet.tokenBalance(new PublicKey(r.mint))).ui;
  } catch (err) {
    notes.push(`residue ${r.symbol}: could not read the wallet (${(err as Error).message})`);
    return idle;
  }
  const want = floorTo(Math.min(held, r.amountUi), r.decimals);
  if (want <= SWAP_DUST_TOKEN || want * r.markTokenInSol < 0.002) {
    if (want > 0) notes.push(`residue ${r.symbol}: ${fmtUnits(want, r.decimals)} left is dust (under 0.002 SOL); written off`);
    return { left: 0, sold: 0, failed: false, attempted: true };
  }
  const capPct = caps ? residueCapPct(caps, r.cycles) : 0;
  const client = jupiter();
  const impactOf = async (amountUi: number) => (await client.quote({ inputMint: r.mint, outputMint: SOL_MINT, amount: toRawUnits(amountUi, r.decimals) })).priceImpactPct;
  let amount = want;
  try {
    if (capPct > 0) {
      const sized = await sizeUnderCap(want, capPct, r.decimals, impactOf);
      amount = sized.amount;
      if (amount <= 0) {
        notes.push(`residue ${r.symbol}: ${fmtUnits(want, r.decimals)} would move the price over ${capPct}% (${sized.impactPct.toFixed(2)}% quoted); waits (attempt ${r.cycles + 1})`);
        return { left: want, sold: 0, failed: false, attempted: true };
      }
    }
    const jq = await client.quote({ inputMint: r.mint, outputMint: SOL_MINT, amount: toRawUnits(amount, r.decimals) });
    if (capPct > 0 && jq.priceImpactPct > capPct * 1.25) {
      notes.push(`residue ${r.symbol}: the sending quote came back at ${jq.priceImpactPct.toFixed(2)}%, over ${capPct}%; waits (attempt ${r.cycles + 1})`);
      return { left: want, sold: 0, failed: false, attempted: true };
    }
    const inUi = fromRawUnits(jq.inAmount, r.decimals);
    const outUi = fromRawUnits(jq.outAmount, 9);
    const route = jq.routeLabels.join(" > ") || "?";
    const built = await client.buildSwap(jq, wallet.publicKey);
    const txs: TxReport[] = [];
    const out = await runTx(wallet, `swap ${fmtUnits(inUi, r.decimals)} ${r.symbol} -> ~${fmtUnits(outUi, 9)} SOL (residue leg, Jupiter via ${route}, impact ${jq.priceImpactPct}%, cap ${capPct || "none"}%)`, built.tx, [], txs, SOL_MINT, { baseMint: r.mint, notes });
    if (!out.ok) {
      notes.push(`residue ${r.symbol}: the swap failed (${txs[0]?.error ?? "?"}); ${fmtUnits(want, r.decimals)} stays`);
      return { left: want, sold: 0, failed: true, attempted: true };
    }
    const measured = !!out.cash;
    const solDelta = measured ? out.cash!.walletDeltaSol - out.cash!.txFeeSol : outUi;
    recordLedger({
      ts: Date.now(),
      mode: config.dryRun ? "dry-run" : "live",
      sig: out.signature,
      pool: r.pool,
      position: r.position,
      mech: "swap",
      tokenMint: r.mint,
      // marked at the exit's pool price, as the exit's own swap was, so what the wait and the impact cost shows in the record
      markTokenInSol: r.markTokenInSol,
      quoteMint: SOL_MINT,
      markQuoteInSol: 1,
      quoteDelta: solDelta,
      solDelta,
      tokenDelta: typeof out.cash?.tokenDelta === "number" ? out.cash.tokenDelta : -inUi,
      rentSol: 0,
      txFeeSol: measured ? out.cash!.txFeeSol : -MARKED_TX_FEE_SOL,
      basis: measured ? "exact" : "marked",
      note: `residue leg: Jupiter ${r.symbol} -> SOL via ${route}, impact ${jq.priceImpactPct}%, slippage ${jq.slippageBps} bps, cap ${capPct || "none"}%; left by the exit at ${new Date(r.since).toISOString()}`,
    });
    const left = want - amount <= 10 ** -r.decimals ? 0 : floorTo(want - amount, r.decimals);
    notes.push(`residue ${r.symbol}: sold ${fmtUnits(amount, r.decimals)} for ~${fmtUnits(outUi, 9)} SOL at ${jq.priceImpactPct.toFixed(2)}% impact${left > 0 ? `; ${fmtUnits(left, r.decimals)} still waits` : "; done"}`);
    return { left, sold: amount, failed: false, attempted: true };
  } catch (err) {
    notes.push(`residue ${r.symbol}: ${(err as Error).message}`);
    return { left: want, sold: 0, failed: false, attempted: false };
  }
}

/**
 * A made pair whose pool is not on chain: build the create transaction and, when the gates allow,
 * send it and reload the pool so the seed can follow. Returns true only when the pool now exists.
 */
async function createPairFirst(ctx: ExecutionContext, o: OpenParams, result: ExecutionResult, ledger: (row: LedgerRow) => void, quoteMint: string): Promise<boolean> {
  const pool = ctx.pool as PairPool;
  const s = ctx.snapshot;
  const q = quoteOf(s);
  const seatSol = (o.amountSol + o.amountToken * q.tokenPriceInQuote) * q.priceInSol;
  const would = `would create ${s.label} on Meteora DLMM (${pool.pair.lbPair}, bin step ${pool.pair.binStep}, fee ${pool.pair.feeBps} bps; rent ${PAIR_CREATION_RENT_SOL.toFixed(4)} SOL, none of it refundable) and seat ${seatSol.toFixed(4)} SOL (${o.amountSol} ${q.symbol} + ${o.amountToken} ${s.baseToken.symbol})`;
  const venue = ctx.venue as Venue & { buildCreate?: (pool: PairPool, owner: PublicKey, snapshot: PoolSnapshot) => Promise<BuiltTx> };
  if (typeof venue.buildCreate !== "function") {
    result.ok = false;
    result.notes.push(`create pool: the venue cannot build a pool creation; ${would}`);
    return false;
  }
  let built: BuiltTx;
  try {
    built = await venue.buildCreate(pool, ctx.wallet.publicKey, s);
  } catch (err) {
    result.ok = false;
    result.notes.push(`create pool: ${(err as Error).message}; ${would}`);
    return false;
  }
  if (built.notes?.length) result.notes.push(...built.notes);
  if (config.dryRun) {
    // built, simulated with a real key, never sent; the seed cannot be built until the pool is on chain
    await runTx(ctx.wallet, built.label, built.tx, built.signers, result.txs, quoteMint, { notes: result.notes });
    result.notes.push(would, "dry-run: the seed position follows once the pool exists on chain");
    return false;
  }
  const refusal = pairBroadcastRefusal();
  if (refusal) {
    try {
      const sim = await ctx.wallet.simulate(built.tx, built.signers);
      result.txs.push({ label: built.label, ok: sim.ok, error: sim.ok ? undefined : JSON.stringify(sim.err), unitsConsumed: sim.unitsConsumed, logsTail: sim.logsTail, skipped: `not sent: ${refusal}` });
    } catch (err) {
      result.txs.push({ label: built.label, ok: false, error: (err as Error).message, skipped: `not sent: ${refusal}` });
    }
    result.notes.push(would, refusal);
    return false;
  }
  const out = await runTx(ctx.wallet, built.label, built.tx, built.signers, result.txs, quoteMint, { notes: result.notes });
  if (!out.ok) {
    result.ok = false;
    result.notes.push("create pool failed: no seed position this cycle");
    return false;
  }
  // the pool's own accounts are paid now; the seed's bin arrays land with the open below
  const rentSol = out.cash ? out.cash.walletDeltaSol - out.cash.txFeeSol : -PAIR_POOL_ACCOUNTS_RENT_SOL;
  ledger({
    ...baseRow(ctx, "rent", out.signature, null),
    ...quoteLeg(0, q),
    tokenDelta: 0,
    rentSol,
    txFeeSol: out.cash ? out.cash.txFeeSol : -MARKED_TX_FEE_SOL,
    basis: out.cash ? "exact" : "marked",
    note: `create pair pool ${s.label} (lb pair + 2 reserves + oracle), not refundable`,
  });
  result.created = { pool: s.address, lbPair: pool.pair.lbPair, rentSol: -rentSol, sig: out.signature };
  try {
    const reloaded = await ctx.venue.loadPool(ctx.wallet.connection, s.address);
    Object.assign(pool, reloaded);
  } catch (err) {
    result.ok = false;
    result.notes.push(`the pool was created but could not be reloaded for the seed: ${(err as Error).message}`);
    return false;
  }
  if (!pool.dlmm) {
    result.ok = false;
    result.notes.push("the pool was created but is not readable yet: the seed follows next cycle");
    return false;
  }
  return true;
}

export async function execute(verdict: Verdict, ctx: ExecutionContext): Promise<ExecutionResult> {
  const d = verdict.decision;
  if (!verdict.allowed) return { mode: "none", ok: true, txs: [], notes: ["blocked by guards"] };
  if (d.action === "HOLD") return { mode: "none", ok: true, txs: [], notes: ["hold"] };
  // Paper mode: the verdict lands in the virtual book; nothing below is built.
  if (ctx.paper) return executePaper(verdict, { ...ctx.paper, snapshot: ctx.snapshot, positions: ctx.positions, openCost: openCostOf(ctx, d.open) });

  // A venue that is not live never gets a transaction built while the process could broadcast.
  const refusal = broadcastRefusal(ctx.venue.id);
  if (refusal) return { mode: "none", ok: false, txs: [], notes: [refusal], ledger: [] };

  const result: ExecutionResult = { mode: config.dryRun ? "dry-run" : "live", ok: true, txs: [], notes: [], ledger: [] };
  const owner = ctx.wallet.publicKey;
  const quoteMint = quoteOf(ctx.snapshot).token.mint;
  const baseMint = ctx.snapshot.baseToken.mint;
  const transferFee = baseTransferFee(ctx.snapshot);
  // an exit at its stop, a flatten, any engine close: it pays the urgent priority fee, since an exit that expires in a crash costs more
  const urgent = verdict.emergency && (d.action === "CLOSE_POSITION" || d.action === "REBALANCE");
  const indexOf = (addr: string | null) => ctx.positions.findIndex((p) => p.address === addr);
  const findRaw = (addr: string | null): unknown => {
    const i = indexOf(addr);
    return i >= 0 ? ctx.rawPositions[i] : undefined;
  };
  const findSnap = (addr: string | null) => ctx.positions.find((p) => p.address === addr);
  const ledger = (row: LedgerRow) => {
    recordLedger(row);
    result.ledger!.push(row);
  };

  try {
    if (d.action === "CLAIM_FEES") {
      const target = d.positionAddress ? findRaw(d.positionAddress) : undefined;
      const targets = target ? [target] : ctx.rawPositions;
      const snaps = target ? [findSnap(d.positionAddress)].filter((p): p is PositionSnapshot => !!p) : ctx.positions;
      const built = await ctx.venue.buildClaim(ctx.pool, owner, targets, ctx.snapshot);
      if (built.length === 0) result.notes.push("nothing to claim");
      const outcomes: TxOutcome[] = [];
      for (const b of built) {
        const out = await runTx(ctx.wallet, b.label, b.tx, b.signers, result.txs, quoteMint, { baseMint, notes: result.notes });
        outcomes.push(out);
        if (!out.ok) {
          result.ok = false;
          break;
        }
      }
      if (result.ok && built.length > 0) {
        ledger(collectRow(ctx, snaps, outcomes));
        result.claimed = snaps.map((p) => p.address);
      }
      // the claim paid part of the fees in the base token: on a quote-only book that is exposure nothing
      // manages, so it is sold once it is worth a transaction (with whatever earlier claims left)
      if (result.ok && built.length > 0 && ctx.sweepWalletToken) {
        const dec = ctx.snapshot.baseToken.decimals;
        const claimed = snaps.reduce((t, p) => t + afterTransferFee(quoteOf(ctx.snapshot).side === "Y" ? p.feeX : p.feeY, transferFee), 0);
        const held = (await readWalletToken(ctx)) ?? (ctx.walletToken ?? 0) + claimed;
        const sell = sweepAmount(held, quoteOf(ctx.snapshot).tokenPriceInQuote, ctx.sweepWalletToken.minQuote);
        if (sell > 0) {
          const out = await sellUnderCap(ctx, "sweep", floorTo(sell, dec), ctx.swapImpact?.sweepPct ?? 0, result, ledger);
          if (out.left > 0) result.notes.push(`sweep: ${out.failed ? "the swap failed" : "the market would not take it under the impact allowed"}; ${fmtUnits(out.left, dec)} ${ctx.snapshot.baseToken.symbol} of claimed fees stays in the wallet for the next claim`);
        }
      }
      return result;
    }

    // the base token a closing band handed the wallet: what a liquidate sells, what a re-laid straddle re-uses
    let tokensBack = 0;
    const tokenDec = ctx.snapshot.baseToken.decimals;
    /**
     * Sell `tokens` of the base back to the quote: what fits under the exit cap now, in one swap. Then the rest is quoted as a
     * whole: sold at once if that costs no more than the hard cap, else left as a residue the desk comes back for on later
     * cycles. Only a SOL-quoted pool is capped: a residue is sold into SOL, and every book but the memecoin book is USDC-quoted
     * or a straddle. `why` names the leg in the notes (a liquidation, or the ask exit falling back to the sale).
     */
    const liquidateBack = async (tokens: number, why: string): Promise<void> => {
      if (!(tokens > SWAP_DUST_TOKEN)) {
        result.notes.push(`${why}: no token came back, nothing to sell`);
        return;
      }
      const q = quoteOf(ctx.snapshot);
      const caps = ctx.swapImpact && q.token.mint === SOL_MINT && ctx.swapImpact.exitPct > 0 ? ctx.swapImpact : null;
      const first = await sellUnderCap(ctx, "liquidate", floorTo(tokens, tokenDec), caps?.exitPct ?? 0, result, ledger);
      let left = first.left;
      let failed = first.failed;
      if (left > SWAP_DUST_TOKEN && !failed && caps) {
        const rest = await runSwapLeg(ctx, "liquidate", left, result, ledger, caps.hardPct);
        if (rest.ok) left = 0;
        else if (!rest.refused) failed = true;
      }
      result.ok = result.ok && !failed;
      if (left > SWAP_DUST_TOKEN && !caps) {
        // a pool this desk does not cap (not SOL-quoted, or exits uncapped): the old behaviour, a note and nothing more
        result.notes.push(`${why}: the swap failed; ${fmtUnits(left, tokenDec)} ${ctx.snapshot.baseToken.symbol} stays in the wallet`);
      } else if (left > SWAP_DUST_TOKEN) {
        result.residue = { pool: ctx.snapshot.address, position: d.positionAddress ?? null, mint: ctx.snapshot.baseToken.mint, symbol: ctx.snapshot.baseToken.symbol, decimals: tokenDec, quoteMint: q.token.mint, amountUi: left, markTokenInSol: ctx.snapshot.tokenPriceInSol, since: Date.now(), cycle: ctx.cycle ?? 0, cycles: 0 };
        result.notes.push(`${why}: ${failed ? "the swap failed" : "the rest would move the price over the hard cap"}; ${fmtUnits(left, tokenDec)} ${ctx.snapshot.baseToken.symbol} stays in the wallet as a residue the desk sells on later cycles (${caps ? `${caps.exitPct}% for ${caps.residueCycles} attempts, then ${caps.hardPct}%` : "any price"})`);
      }
    };

    if (d.action === "CLOSE_POSITION" || d.action === "REBALANCE") {
      const raw = findRaw(d.positionAddress);
      if (raw === undefined) throw new Error(`position ${d.positionAddress} not found`);
      const built = await ctx.venue.buildClose(ctx.pool, owner, raw, ctx.snapshot);
      // live: the lamports the position account holds, read before it is closed, are the rent the close refunds
      let refundSol: number | null = null;
      if (!config.dryRun && !ctx.wallet.ephemeral && typeof ctx.venue.closeRefundSol === "function") {
        try {
          refundSol = await ctx.venue.closeRefundSol(ctx.wallet.connection, raw);
        } catch {
          refundSol = null;
        }
      }
      const outcomes: TxOutcome[] = [];
      for (const b of built) {
        const out = await runTx(ctx.wallet, b.label, b.tx, b.signers, result.txs, quoteMint, { baseMint, urgent, notes: result.notes });
        outcomes.push(out);
        if (!out.ok) {
          result.ok = false;
          break;
        }
      }
      if (!result.ok) return result;
      result.closed = d.positionAddress!;
      const snap = findSnap(d.positionAddress);
      if (snap) {
        ledger(closeRow(ctx, snap, outcomes, refundSol));
        // what actually arrived: the transaction's own token balances first (no read can lag behind them), then a wallet read
        // that shows the arrival, then the snapshot's token leg less the mint's transfer fee (dry-run)
        const recorded = sumCash(outcomes, quoteOf(ctx.snapshot))?.tokenDelta ?? null;
        const held = recorded === null ? await readWalletToken(ctx) : null;
        tokensBack =
          recorded !== null ? Math.max(0, recorded) : held !== null && held - (ctx.walletToken ?? 0) > 0 ? held - (ctx.walletToken ?? 0) : afterTransferFee(tokenInPosition(snap, ctx.snapshot), transferFee);
      }
      if (d.action === "CLOSE_POSITION") {
        if (d.liquidate === true) {
          // on a quote-only book the wallet's own base tokens (claimed fees) go with the band's
          if (ctx.sweepWalletToken) tokensBack += Math.max(0, ctx.walletToken ?? 0);
          await liquidateBack(tokensBack, "liquidate");
        }
        return result;
      }
    }

    if (d.action === "OPEN_POSITION" || d.action === "REBALANCE") {
      if (!d.open) throw new Error("open parameters missing");
      let o: OpenParams = d.open;
      // A quote-only band being laid (or re-laid) has no use for base tokens in the wallet: on a quote-only book
      // they are fee claims, or what a close just handed back with its fees. A re-lay closes without liquidating,
      // so without this the tokens only ever left at a CLAIM, and a band that is re-laid often never claims
      // (2026-09-17: 1.2 SOL of ALLINU and GP sat in the wallet, outside every stop). Sold first, once worth the minimum.
      if (ctx.sweepWalletToken && o.side === "SOL_ONLY" && !(o.acquireToken && o.acquireToken > 0)) {
        const expected = (ctx.walletToken ?? 0) + tokensBack;
        let read = await readWalletToken(ctx);
        // a read right after the close can still show the balance from before it: given time to catch up with what the close
        // handed back, since a stale read skipped the sweep without a word and left the tokens outside every stop
        if (read !== null && tokensBack > SWAP_DUST_TOKEN && read + 1e-9 < expected * 0.97) {
          read = await settleWalletToken(() => readWalletToken(ctx), expected * 0.97);
          if (read !== null && read + 1e-9 < expected * 0.97) result.notes.push(`sweep: the wallet read ${fmtUnits(read, tokenDec)} ${ctx.snapshot.baseToken.symbol} after the close, under the ${fmtUnits(expected, tokenDec)} expected; selling what it shows, the rest waits for the next move`);
        }
        const held = read ?? expected;
        const sell = sweepAmount(held, quoteOf(ctx.snapshot).tokenPriceInQuote, ctx.sweepWalletToken.minQuote);
        if (sell > 0) {
          const out = await sellUnderCap(ctx, "sweep", floorTo(sell, tokenDec), ctx.swapImpact?.sweepPct ?? 0, result, ledger);
          if (out.left > 0) result.notes.push(`sweep: ${out.failed ? "the swap failed" : "the market would not take it under the impact allowed"}; ${fmtUnits(out.left, tokenDec)} ${ctx.snapshot.baseToken.symbol} stays in the wallet for the next move`);
        }
      }
      // A made pair whose pool is not on chain yet: create it first (src/venues/pair.ts). Anything short
      // of a landed creation (dry-run, the PAIR_LIVE gate, a failure) is journaled and ends the cycle here.
      if (isPairPool(ctx.pool) && !ctx.pool.dlmm) {
        const made = await createPairFirst(ctx, o, result, ledger, quoteMint);
        if (!made) return result;
      }
      // the straddle's legs: buy the shortfall (declared as acquireToken, or whatever a re-centre needs), sell a re-centre's surplus
      if (o.side === "BOTH" && o.amountToken > 0) {
        const before = ctx.walletToken ?? 0;
        // what the wallet holds now by the books: its balance before this execution plus what the close just handed back
        const expected = before + tokensBack;
        let read = await readWalletToken(ctx);
        // A read taken right after a close can still show the balance from before it. Sized on that, the shortfall leg bought
        // the token the close had just handed back: an unbudgeted purchase of the whole token half, under the gas reserve on
        // a small wallet. A read short of what the close returned is given time to catch up, and one that never does is not
        // trusted to buy with: the purchase is sized on what the close handed back, and the deposit below still takes only
        // what the wallet holds.
        if (read !== null && tokensBack > SWAP_DUST_TOKEN && read + 1e-9 < expected * 0.97) {
          read = await settleWalletToken(() => readWalletToken(ctx), expected * 0.97);
          if (read !== null && read + 1e-9 < expected * 0.97) result.notes.push(`the wallet read ${fmtUnits(read, tokenDec)} ${ctx.snapshot.baseToken.symbol} after the close, under the ${fmtUnits(expected, tokenDec)} it handed back: the purchase is sized on the close, not on the read`);
        }
        const held = read === null ? expected : tokensBack > SWAP_DUST_TOKEN ? Math.max(read, expected) : read;
        const shortfall = o.amountToken - held;
        const declared = Number.isFinite(o.acquireToken ?? 0) ? Math.max(0, o.acquireToken ?? 0) : 0;
        let bought = 0;
        if (shortfall > SWAP_DUST_TOKEN && (declared > 0 || d.action === "REBALANCE")) {
          const leg = await runSwapLeg(ctx, d.action === "REBALANCE" ? "shortfall" : "acquire", Number(shortfall.toFixed(Math.min(tokenDec, 8))), result, ledger);
          if (!leg.ok) {
            result.ok = false;
            result.notes.push(`the ${d.action === "REBALANCE" ? "shortfall" : "acquire"} leg failed: no deposit`);
            return result;
          }
          bought = Math.max(0, leg.tokenDelta);
        } else if (d.action === "REBALANCE" && -shortfall > SWAP_DUST_TOKEN && tokensBack > SWAP_DUST_TOKEN) {
          const leg = await runSwapLeg(ctx, "surplus", floorTo(Math.min(-shortfall, tokensBack), tokenDec), result, ledger);
          if (!leg.ok) {
            result.ok = false;
            result.notes.push("the surplus leg failed: no deposit");
            return result;
          }
        }
        // live: the fill decides the token leg; the deposit takes what the wallet holds, never more.
        // The read has to catch up with the fill first (a fill may land a little under the quote).
        const expectMin = Math.min(o.amountToken, held + bought * 0.97);
        const after = read === null ? null : await settleWalletToken(() => readWalletToken(ctx), expectMin);
        if (after !== null && after + 1e-9 < expectMin) result.notes.push(`the wallet showed ${fmtUnits(after, tokenDec)} ${ctx.snapshot.baseToken.symbol} after ${bought > 0 ? "the swap" : "the read"}, under the ${fmtUnits(expectMin, tokenDec)} expected`);
        if (after !== null && after + 1e-9 < o.amountToken) {
          const clamped = floorTo(after, Math.min(tokenDec, 8));
          result.notes.push(`token leg clamped to the wallet's ${fmtUnits(after, tokenDec)} ${ctx.snapshot.baseToken.symbol} (planned ${o.amountToken})`);
          o = { ...o, amountToken: clamped };
        }
      }
      // THE ASK EXIT (src/engine/askExit.ts): the closing band's token, and the wallet's, laid as an ask band. The
      // deposit takes what the wallet actually holds once the close has settled, never more (the decision sized it
      // from the snapshot; a live fill can land a little under); the read has to catch up with the close first.
      const askExit = d.action === "REBALANCE" && d.exitAsk === true && o.side === "TOKEN_ONLY";
      if (askExit) {
        const read = await readWalletToken(ctx);
        if (read !== null) {
          const held = await settleWalletToken(() => readWalletToken(ctx), o.amountToken * 0.995);
          if (held !== null && held + 1e-9 < o.amountToken) {
            if (held >= o.amountToken * 0.5) {
              const clamped = floorTo(held, Math.min(tokenDec, 8));
              result.notes.push(`ask exit: token leg clamped to the wallet's ${fmtUnits(held, tokenDec)} ${ctx.snapshot.baseToken.symbol} (planned ${o.amountToken})`);
              o = { ...o, amountToken: clamped };
            } else {
              // a read that shows under half of what the close just handed back has not caught up with the fill: the planned
              // amount is laid; if the wallet truly lacks it the open fails and the sale below takes over (a residue waits for the balance)
              result.notes.push(`ask exit: the wallet read shows ${fmtUnits(held, tokenDec)} ${ctx.snapshot.baseToken.symbol}, under half the ${o.amountToken} the close handed back: the read has not caught up; laying the planned amount`);
            }
          }
        }
        if (!(o.amountToken > SWAP_DUST_TOKEN)) {
          result.notes.push(`ask exit: the wallet holds no ${ctx.snapshot.baseToken.symbol} to lay after the close; nothing opened`);
          return result;
        }
      }
      const plan = toOpenPlan(o, ctx.snapshot);
      let out: TxOutcome;
      let built: BuiltTx | null = null;
      try {
        built = await ctx.venue.buildOpen(ctx.pool, owner, plan, ctx.snapshot);
        if (built.notes?.length) result.notes.push(...built.notes);
        out = await runTx(ctx.wallet, built.label, built.tx, built.signers, result.txs, quoteMint, { baseMint, notes: result.notes });
      } catch (err) {
        // the ask exit must not leave the token in the wallet outside every stop: a build error falls back to the sale below
        if (!askExit) throw err;
        result.txs.push({ label: `open ${o.side} band`, ok: false, error: (err as Error).message });
        out = { ok: false, signature: null, cash: null };
      }
      result.ok = result.ok && out.ok;
      if (out.ok) {
        const address = built?.positionAddress ?? built?.signers[0]?.publicKey.toBase58();
        if (!address) throw new Error("the venue returned no position address for the open");
        result.opened = { address, entryValueSol: entryValueOf(o, ctx.snapshot) };
        ledger(openRow(ctx, o, address, [out]));
      } else if (askExit) {
        // the close landed and the ask did not: the token is sold the old way rather than left in the wallet
        result.notes.push(`ask exit: the ask band could not be laid (${result.txs[result.txs.length - 1]?.error ?? "the open failed"}); selling the ${ctx.snapshot.baseToken.symbol} instead`);
        result.ok = true;
        await liquidateBack(o.amountToken, "ask exit fallback");
      }
    }
  } catch (err) {
    result.ok = false;
    result.notes.push(`build error: ${(err as Error).message}`);
  }
  return result;
}

/**
 * The treasury skim: a plain SystemProgram transfer, ledgered as mech "skim". Its own failure
 * domain: every error is caught and reported in the result, never thrown into the trading loop.
 */
export async function executeSkim(wallet: Wallet, plan: SkimPlan, pool = "wallet"): Promise<ExecutionResult> {
  const result: ExecutionResult = { mode: config.dryRun ? "dry-run" : "live", ok: true, txs: [], notes: [plan.reason], ledger: [] };
  try {
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(plan.treasury), lamports: plan.lamports }),
    );
    const out = await runTx(wallet, `skim ${plan.amountSol.toFixed(6)} SOL to treasury`, tx, [], result.txs);
    result.ok = out.ok;
    if (out.ok) {
      const solDelta = out.cash ? out.cash.walletDeltaSol - out.cash.txFeeSol : -plan.amountSol;
      const row: LedgerRow = {
        ts: Date.now(),
        mode: config.dryRun ? "dry-run" : "live",
        sig: out.signature,
        pool,
        position: null,
        mech: "skim",
        solDelta,
        quoteDelta: solDelta,
        quoteMint: SOL_MINT,
        markQuoteInSol: 1,
        tokenDelta: 0,
        tokenMint: "",
        markTokenInSol: 0,
        rentSol: 0,
        txFeeSol: out.cash ? out.cash.txFeeSol : -MARKED_TX_FEE_SOL,
        basis: out.cash ? "exact" : "marked",
        note: `${plan.reason}; fee gain base ${plan.gainSol.toFixed(6)} SOL`,
      };
      recordLedger(row);
      result.ledger!.push(row);
    }
  } catch (err) {
    result.ok = false;
    result.notes.push(`skim error: ${(err as Error).message}`);
  }
  return result;
}
