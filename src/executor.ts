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
 */
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { config, riskLimits } from "./config";
import type { OpenParams } from "./agent/schema";
import type { SkimPlan } from "./engine/collect";
import { LedgerRow, recordLedger } from "./engine/ledger";
import type { Verdict } from "./risk/guards";
import { OpenPlan, PoolSnapshot, POSITION_RENT_SOL, PositionSnapshot, quoteOf, QuoteView, SOL_MINT, STRATEGY_BY_NAME, toRawBN } from "./tools/dlmm";
import type { AnyTransaction, Wallet } from "./tools/wallet";
import { executePaper, type PaperExecutionContext } from "./paper/executor";
import { isLiveVenue, liveVenues } from "./venues/env";
import type { OpenCost, Venue, VenuePool } from "./venues/types";

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
}

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
      if (snap) ledger(closeRow(ctx, snap, outcomes));
      if (d.action === "CLOSE_POSITION") return result;
    }

    if (d.action === "OPEN_POSITION" || d.action === "REBALANCE") {
      if (!d.open) throw new Error("open parameters missing");
      const plan = toOpenPlan(d.open, ctx.snapshot);
      const built = await ctx.venue.buildOpen(ctx.pool, owner, plan, ctx.snapshot);
      if (built.notes?.length) result.notes.push(...built.notes);
      const out = await runTx(ctx.wallet, built.label, built.tx, built.signers, result.txs, quoteMint);
      result.ok = result.ok && out.ok;
      if (out.ok) {
        const address = built.positionAddress ?? built.signers[0]?.publicKey.toBase58();
        if (!address) throw new Error("the venue returned no position address for the open");
        result.opened = { address, entryValueSol: entryValueOf(d.open, ctx.snapshot) };
        ledger(openRow(ctx, d.open, address, [out]));
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
