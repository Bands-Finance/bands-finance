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
 * The treasury skim runs in its own failure domain (executeSkim): a failed skim never blocks trading.
 *
 * Paper mode: when the loop passes `ctx.paper` (PAPER_SOL > 0 under DRY_RUN), execute() hands the
 * verdict to src/paper/executor.ts, which applies it to the virtual book and returns mode "paper"
 * with the same ledger rows; nothing below it runs and the chain is never touched.
 *
 * Venues (src/venues): the context carries the venue and its pool handle; every transaction is built
 * by the venue (Meteora legacy transactions, Raydium versioned ones) and signed and sent by the
 * wallet. A venue that is tradable but not in LIVE_VENUES is refused before anything is built when
 * DRY_RUN=false: it trades in paper and dry-run only until the operator turns it on.
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
import { OpenPlan, PoolSnapshot, POSITION_RENT_SOL, PositionSnapshot, quoteOf, QuoteView, SOL_MINT, STRATEGY_BY_NAME, toRawBN } from "./tools/dlmm";
import { fromRawUnits, jupiter, toRawUnits, type JupiterQuote } from "./tools/jupiter";
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
}

export interface ExecutionResult {
  /** "paper": applied to the paper book (src/paper), nothing built or broadcast */
  mode: "none" | "dry-run" | "live" | "paper";
  ok: boolean;
  txs: TxReport[];
  opened?: { address: string; entryValueSol: number };
  closed?: string;
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
}

interface TxOutcome {
  ok: boolean;
  signature: string | null;
  /** chain-measured; null in dry-run or when neither the tx meta nor a balance pair was readable */
  cash: Cash | null;
}

/** marked network fee for a dry-run row: one signature */
const MARKED_TX_FEE_SOL = 0.000005;

/**
 * Build/simulate/broadcast one transaction. `quoteMint` is the pool's quote mint: for a non-SOL
 * quote the wallet's balance of it is measured around the broadcast so the row's quote leg is exact.
 */
async function runTx(wallet: Wallet, label: string, tx: AnyTransaction, signers: Keypair[], txs: TxReport[], quoteMint: string = SOL_MINT): Promise<TxOutcome> {
  if (config.dryRun) {
    if (wallet.ephemeral) {
      txs.push({ label, ok: true, skipped: "dry-run with ephemeral wallet: built, not simulated" });
      return { ok: true, signature: null, cash: null };
    }
    try {
      const sim = await wallet.simulate(tx, signers);
      txs.push({
        label,
        ok: sim.ok,
        error: sim.ok ? undefined : JSON.stringify(sim.err),
        unitsConsumed: sim.unitsConsumed,
        logsTail: sim.logsTail,
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
    const signature = await wallet.signAndSend(tx, signers);
    txs.push({ label, ok: true, signature });
    let cash: Cash | null = null;
    try {
      const sol = await wallet.txCashDelta(signature);
      let solLeg: Omit<Cash, "quoteDelta"> | null = sol;
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
        cash = { ...solLeg, quoteDelta };
      }
    } catch {
      cash = null;
    }
    return { ok: true, signature, cash };
  } catch (err) {
    txs.push({ label, ok: false, error: (err as Error).message });
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
  return outcomes.reduce<Cash>(
    (acc, o) => ({
      walletDeltaSol: acc.walletDeltaSol + o.cash!.walletDeltaSol,
      txFeeSol: acc.txFeeSol + o.cash!.txFeeSol,
      quoteDelta: measureQuote ? (acc.quoteDelta ?? 0) + o.cash!.quoteDelta! : null,
    }),
    { walletDeltaSol: 0, txFeeSol: 0, quoteDelta: measureQuote ? 0 : null },
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
      tokenDelta: -o.amountToken,
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

function closeRow(ctx: ExecutionContext, p: PositionSnapshot, outcomes: TxOutcome[]): LedgerRow {
  const s = ctx.snapshot;
  const q = quoteOf(s);
  const cash = sumCash(outcomes, q);
  const { feeToken, feeSol } = feeLegs(p, s);
  const tokenDelta = (q.side === "X" ? p.amountY : p.amountX) + feeToken;
  const rentSol = refundableRent(ctx);
  const common = { ...baseRow(ctx, "close", lastSig(outcomes), p.address), tokenDelta, feeSol, entryValueSol: p.entryValueSol };
  if (cash) {
    // SOL pool: the SOL that came back beyond the rent refund is the quote leg. USDC pool: the SOL
    // that came back IS the rent refund (measured) and the quote leg is the USDC delta.
    const quoteDelta = q.symbol === "SOL" ? cash.walletDeltaSol - cash.txFeeSol - rentSol : cash.quoteDelta!;
    const rent = q.symbol === "SOL" ? rentSol : cash.walletDeltaSol - cash.txFeeSol;
    return { ...common, ...quoteLeg(quoteDelta, q), rentSol: rent, txFeeSol: cash.txFeeSol, basis: "exact", note: `close band, ${outcomes.length} tx` };
  }
  return {
    ...common,
    ...quoteLeg(quoteInPosition(p, q), q),
    rentSol,
    txFeeSol: -MARKED_TX_FEE_SOL * Math.max(1, outcomes.length),
    basis: "marked",
    note: `close band; ${q.symbol} side taken from the position snapshot`,
  };
}

function collectRow(ctx: ExecutionContext, targets: PositionSnapshot[], outcomes: TxOutcome[]): LedgerRow {
  const s = ctx.snapshot;
  const q = quoteOf(s);
  const cash = sumCash(outcomes, q);
  let tokenDelta = 0;
  let quoteSide = 0;
  let feeSol = 0;
  for (const p of targets) {
    const f = feeLegs(p, s);
    tokenDelta += f.feeToken;
    quoteSide += f.feeQuoteSide;
    feeSol += f.feeSol;
  }
  const position = targets.length === 1 ? targets[0].address : null;
  const common = { ...baseRow(ctx, "collect", lastSig(outcomes), position), tokenDelta, rentSol: 0, feeSol };
  if (cash) {
    const quoteDelta = q.symbol === "SOL" ? cash.walletDeltaSol - cash.txFeeSol : cash.quoteDelta!;
    return { ...common, ...quoteLeg(quoteDelta, q), txFeeSol: cash.txFeeSol, basis: "exact", note: `claim fees on ${targets.length} band(s), ${outcomes.length} tx` };
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
const floorTo = (n: number, d: number) => Math.floor(n * 10 ** d) / 10 ** d;

type SwapLeg = "acquire" | "liquidate" | "shortfall" | "surplus";

interface SwapLegOutcome {
  ok: boolean;
  /** base token units the wallet gained (+) or gave (-), from the quote (the fill may differ inside the slippage) */
  tokenDelta: number;
  quote: JupiterQuote | null;
}

/**
 * One Jupiter leg: BUY `tokenUi` of the base with the quote (acquire / shortfall: ExactIn sized at the
 * pool price plus the slippage allowance, since ExactOut is not routed for every pair) or SELL
 * `tokenUi` into the quote (liquidate / surplus). Built, then run like a venue transaction.
 */
async function runSwapLeg(ctx: ExecutionContext, leg: SwapLeg, tokenUi: number, result: ExecutionResult, ledger: (row: LedgerRow) => void): Promise<SwapLegOutcome> {
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
    const built = await client.buildSwap(jq, ctx.wallet.publicKey);
    const label = `swap ${fmtUnits(inUi, buy ? quoteDec : tokenDec)} ${buy ? q.symbol : base} -> ~${fmtUnits(outUi, buy ? tokenDec : quoteDec)} ${buy ? base : q.symbol} (${leg} leg, Jupiter via ${route}, impact ${jq.priceImpactPct}%)`;
    const out = await runTx(ctx.wallet, label, built.tx, [], result.txs, q.token.mint);
    if (!out.ok) return { ok: false, tokenDelta: 0, quote: jq };
    const tokenDelta = buy ? outUi : -inUi;
    const cash = out.cash;
    const measured = !!cash && (q.symbol === "SOL" || cash.quoteDelta !== null);
    const quoteDelta = measured ? (q.symbol === "SOL" ? cash!.walletDeltaSol - cash!.txFeeSol : cash!.quoteDelta!) : buy ? -inUi : outUi;
    ledger({
      ...baseRow(ctx, "swap", out.signature, null),
      ...quoteLeg(quoteDelta, q),
      tokenDelta,
      rentSol: 0,
      txFeeSol: measured ? cash!.txFeeSol : -MARKED_TX_FEE_SOL,
      basis: measured ? "exact" : "marked",
      note: `${leg} leg: Jupiter ${buy ? `${q.symbol} -> ${base}` : `${base} -> ${q.symbol}`} via ${route}, impact ${jq.priceImpactPct}%, slippage ${jq.slippageBps} bps; token leg from the quote`,
    });
    return { ok: true, tokenDelta, quote: jq };
  } catch (err) {
    result.txs.push({ label: `swap (${leg} leg)`, ok: false, error: (err as Error).message });
    return { ok: false, tokenDelta: 0, quote: null };
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
    await runTx(ctx.wallet, built.label, built.tx, built.signers, result.txs, quoteMint);
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
  const out = await runTx(ctx.wallet, built.label, built.tx, built.signers, result.txs, quoteMint);
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
        const out = await runTx(ctx.wallet, b.label, b.tx, b.signers, result.txs, quoteMint);
        outcomes.push(out);
        if (!out.ok) {
          result.ok = false;
          break;
        }
      }
      if (result.ok && built.length > 0) ledger(collectRow(ctx, snaps, outcomes));
      return result;
    }

    // the base token a closing band handed the wallet: what a liquidate sells, what a re-laid straddle re-uses
    let tokensBack = 0;
    const tokenDec = ctx.snapshot.baseToken.decimals;
    if (d.action === "CLOSE_POSITION" || d.action === "REBALANCE") {
      const raw = findRaw(d.positionAddress);
      if (raw === undefined) throw new Error(`position ${d.positionAddress} not found`);
      const built = await ctx.venue.buildClose(ctx.pool, owner, raw, ctx.snapshot);
      const outcomes: TxOutcome[] = [];
      for (const b of built) {
        const out = await runTx(ctx.wallet, b.label, b.tx, b.signers, result.txs, quoteMint);
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
        ledger(closeRow(ctx, snap, outcomes));
        // live: what actually arrived; dry-run: the snapshot's token leg
        const held = await readWalletToken(ctx);
        tokensBack = held !== null && held - (ctx.walletToken ?? 0) > 0 ? held - (ctx.walletToken ?? 0) : tokenInPosition(snap, ctx.snapshot);
      }
      if (d.action === "CLOSE_POSITION") {
        if (d.liquidate === true) {
          if (tokensBack > SWAP_DUST_TOKEN) {
            const leg = await runSwapLeg(ctx, "liquidate", floorTo(tokensBack, tokenDec), result, ledger);
            result.ok = result.ok && leg.ok;
            if (!leg.ok) result.notes.push(`liquidate: the swap failed; ${fmtUnits(tokensBack, tokenDec)} ${ctx.snapshot.baseToken.symbol} stays in the wallet`);
          } else {
            result.notes.push("liquidate: no token came back, nothing to sell");
          }
        }
        return result;
      }
    }

    if (d.action === "OPEN_POSITION" || d.action === "REBALANCE") {
      if (!d.open) throw new Error("open parameters missing");
      let o: OpenParams = d.open;
      // A made pair whose pool is not on chain yet: create it first (src/venues/pair.ts). Anything short
      // of a landed creation (dry-run, the PAIR_LIVE gate, a failure) is journaled and ends the cycle here.
      if (isPairPool(ctx.pool) && !ctx.pool.dlmm) {
        const made = await createPairFirst(ctx, o, result, ledger, quoteMint);
        if (!made) return result;
      }
      // the straddle's legs: buy the shortfall (declared as acquireToken, or whatever a re-centre needs), sell a re-centre's surplus
      if (o.side === "BOTH" && o.amountToken > 0) {
        const before = ctx.walletToken ?? 0;
        const read = await readWalletToken(ctx);
        const held = read !== null ? read : before + tokensBack;
        const shortfall = o.amountToken - held;
        const declared = Number.isFinite(o.acquireToken ?? 0) ? Math.max(0, o.acquireToken ?? 0) : 0;
        if (shortfall > SWAP_DUST_TOKEN && (declared > 0 || d.action === "REBALANCE")) {
          const leg = await runSwapLeg(ctx, d.action === "REBALANCE" ? "shortfall" : "acquire", Number(shortfall.toFixed(Math.min(tokenDec, 8))), result, ledger);
          if (!leg.ok) {
            result.ok = false;
            result.notes.push(`the ${d.action === "REBALANCE" ? "shortfall" : "acquire"} leg failed: no deposit`);
            return result;
          }
        } else if (d.action === "REBALANCE" && -shortfall > SWAP_DUST_TOKEN && tokensBack > SWAP_DUST_TOKEN) {
          const leg = await runSwapLeg(ctx, "surplus", floorTo(Math.min(-shortfall, tokensBack), tokenDec), result, ledger);
          if (!leg.ok) {
            result.ok = false;
            result.notes.push("the surplus leg failed: no deposit");
            return result;
          }
        }
        // live: the fill decides the token leg; the deposit takes what the wallet holds, never more
        const after = await readWalletToken(ctx);
        if (after !== null && after + 1e-9 < o.amountToken) {
          const clamped = floorTo(after, Math.min(tokenDec, 8));
          result.notes.push(`token leg clamped to the wallet's ${fmtUnits(after, tokenDec)} ${ctx.snapshot.baseToken.symbol} (planned ${o.amountToken})`);
          o = { ...o, amountToken: clamped };
        }
      }
      const plan = toOpenPlan(o, ctx.snapshot);
      const built = await ctx.venue.buildOpen(ctx.pool, owner, plan, ctx.snapshot);
      if (built.notes?.length) result.notes.push(...built.notes);
      const out = await runTx(ctx.wallet, built.label, built.tx, built.signers, result.txs, quoteMint);
      result.ok = result.ok && out.ok;
      if (out.ok) {
        const address = built.positionAddress ?? built.signers[0]?.publicKey.toBase58();
        if (!address) throw new Error("the venue returned no position address for the open");
        result.opened = { address, entryValueSol: entryValueOf(o, ctx.snapshot) };
        ledger(openRow(ctx, o, address, [out]));
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
