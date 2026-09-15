/**
 * The paper book: a virtual wallet and virtual bands, persisted in DATA_DIR/paper-book.json.
 * Nothing here reads the chain. The loop marks the bands against the live pool every cycle
 * (src/paper/mark.ts) and the paper executor (src/paper/executor.ts) opens, closes and claims
 * through the operations below, which move value between the wallet and the bands:
 *
 *   open   wallet -= deposit and the open rent estimate (a deposit is not a swap: no slippage); rentLockedSol += the refundable part
 *   close  wallet += quote + token (less slippage on the token leg) + fees + the rent refund; a PaperClosed row is appended
 *   claim  wallet += the band's accrued fees; feesClaimedSol tallies them
 *   buy / sell  a paper Jupiter leg (src/tools/jupiter.ts paperSwap): quote <-> base token at the pool's price less the
 *          swap fee; swapCostSol tallies the fee (the stock straddle's acquire and liquidate legs)
 *   create a made pair (src/venues/pair.ts): the wallet pays the pool's creation rent, none of it refundable
 *          (rentSpentSol); the pool is recorded in pairPools so a later open there pays the seed's rent only
 *
 * Every SOL figure is SOL-equivalent at the mark passed in; a USDC pool's quote converts at
 * quotePriceInSol. The entry value of a band is the deposit at the open mark, and the wallet's
 * base tokens carry a SOL cost basis from the mark they arrived at (tokenBasisSol), so that
 *   equity now - equity at start = realized + marked bands + marked wallet tokens + hedge - rentLockedSol - rentSpentSol - swapCostSol - txFeesSol
 * holds exactly (rentSpentSol is the non-refundable bin-array rent; hedge is the virtual perp book's
 * net P&L, src/paper/hedge.ts, in SOL at the last SOL price; txFeesSol the marked network fees).
 */
import fs from "node:fs";
import path from "node:path";
import { dataPath } from "../lib/ledger";
import type { PriceModel } from "../tools/bins";
import type { StockTag } from "../screener/types";
import { BIN_ARRAY_RENT_SOL, OPEN_COST_ESTIMATE_SOL, POSITION_RENT_SOL, type QuoteSymbol } from "../tools/dlmm";
import { paperCostToBuy, paperSwap } from "../tools/jupiter";
import { emptyHedgeBook, normalizeHedgeBook, type PaperHedgeBook } from "./hedge";

export const PAPER_BOOK_FILE = "paper-book.json";

export type PaperSide = "SOL_ONLY" | "TOKEN_ONLY" | "BOTH";
export type PaperStrategy = "Spot" | "Curve" | "BidAsk";

/** The last valuation of a band (written by the mark so the offline report can price the book). */
export interface PaperMark {
  at: number;
  activeBinId: number;
  /** pool price, Y per X */
  price: number;
  tokenPriceInQuote: number;
  quotePriceInSol: number;
  /** quote + token at price + fees, in SOL-equivalent */
  valueInSol: number;
  /** quote side incl. quote fees, quote units */
  quoteInPosition: number;
  amountQuote: number;
  amountToken: number;
  feeSol: number;
  inRange: boolean;
  binsFromRange: number;
}

export interface PaperBand {
  /** "paper-<pool6>-<n>" */
  address: string;
  pool: string;
  label: string;
  quoteSymbol: QuoteSymbol;
  quoteSide: "X" | "Y";
  quoteMint: string;
  tokenMint: string;
  tokenSymbol: string;
  xDecimals: number;
  yDecimals: number;
  lowerBinId: number;
  upperBinId: number;
  lowerPrice: number;
  upperPrice: number;
  binStep: number;
  /** the pool's price model (src/tools/bins.ts); absent on bands opened before venues: Meteora */
  priceModel?: PriceModel;
  /** the rent the wallet gets back on close; absent on bands opened before venues: the Meteora position rent */
  rentRefundableSol?: number;
  strategy: PaperStrategy;
  /** Curve/BidAsk are laid as Spot; the note says so */
  strategyNote: string | null;
  side: PaperSide;
  /** quote units laid into the band (after slippage, what the band holds) */
  quoteDeposit: number;
  /** base token units laid into the band */
  tokenDeposit: number;
  openedAt: number;
  /** the active bin at open: the quote sits on its quote side, the token on the other */
  openedBinId: number;
  openedPrice: number;
  /** all-in entry in SOL: deposit at the open mark plus the slippage paid on it */
  entryValueSol: number;
  /** the per-band stop, when the engine has rolled one (src/engine/exit.ts); the loop owns it */
  stopPct?: number;
  /** accrued, unclaimed fees */
  feeQuote: number;
  feeToken: number;
  lastMarkAt: number;
  lastActiveBinId: number;
  lastMark?: PaperMark;
}

export interface PaperClosed {
  address: string;
  pool: string;
  label: string;
  quoteSymbol: QuoteSymbol;
  side: PaperSide;
  lowerBinId: number;
  upperBinId: number;
  quoteDeposit: number;
  tokenDeposit: number;
  openedAt: number;
  openedPrice: number;
  entryValueSol: number;
  closedAt: number;
  closedPrice: number;
  closedActiveBinId: number;
  /** what came back before slippage */
  quoteBack: number;
  tokenBack: number;
  feeQuote: number;
  feeToken: number;
  /** SOL-equivalent of the fee leg at the close mark */
  feeSol: number;
  /** slippage charged on the token leg, SOL-equivalent */
  slippageSol: number;
  /** quote + token (after slippage) + fees, SOL-equivalent, excluding the rent refund */
  proceedsSol: number;
  /** proceedsSol - entryValueSol */
  realizedSol: number;
  realizedPct: number;
  holdSec: number;
  inRangeAtClose: boolean;
  reason: string;
  emergency: boolean;
}

/** A pool the paper desk made for a pump.fun token or a tokenized stock (the pair lanes). The virtual address is pair-<mint>. */
export interface PaperPairPool {
  mint: string;
  symbol: string;
  /** a STOCK pair (src/screener/pairStock.ts): the ticker and issuer; absent on pump.fun pairs */
  stock?: StockTag | null;
  /** a HOUSE token's pool (PAIR_HOUSE_MINTS): always seated, no launch-style exits */
  house?: boolean;
  refPool: string | null;
  refVenue: string | null;
  quote: QuoteSymbol;
  binStep: number;
  feeBps: number;
  createdAt: number;
  /** creation rent charged to the wallet, SOL, never refunded */
  rentSol: number;
  /** what the last mark saw of the routing model and the reference price */
  lastRoutedShare?: number;
  lastRoutedShareGross?: number;
  lastFeesPerDayUsd?: number;
  lastPrice?: number;
  lastMarkAt?: number;
  lastRefStale?: boolean;
  /** false when the last mark had no reference row to model from (a house token before its first pool) */
  lastRefKnown?: boolean;
}

export interface PaperWallet {
  sol: number;
  usdc: number;
  /** base tokens held, by mint, UI units */
  tokens: Record<string, number>;
}

export interface PaperBook {
  version: 1;
  startedAt: string;
  startSol: number;
  startUsdc: number;
  /** band counter for addresses */
  seq: number;
  wallet: PaperWallet;
  bands: PaperBand[];
  closed: PaperClosed[];
  /** fees moved to the wallet by CLAIM_FEES, SOL-equivalent */
  feesClaimedSol: number;
  /** claims plus the fee legs of closes, SOL-equivalent (the ledger's definition) */
  feesRealizedSol: number;
  /** refundable position rent sitting in open bands */
  rentLockedSol: number;
  /** non-refundable bin-array rent paid so far */
  rentSpentSol: number;
  /** slippage charged so far (opens and closes), SOL-equivalent */
  slippagePaidSol: number;
  /** the last mark of every base token seen, by mint: prices the wallet's tokens offline */
  tokenMarks: Record<string, { symbol: string; priceInSol: number; at: number }>;
  /** SOL cost basis of the wallet's tokens by mint: the mark they came back at (close, claim); scaled down when they leave */
  tokenBasisSol: Record<string, number>;
  /** the SOL price at the last mark, for the USD view */
  solPriceUsd: number | null;
  lastMarkAt: number | null;
  /** fees paid on paper swaps (the straddle's acquire and liquidate legs), SOL-equivalent; absent on older books: 0 */
  swapCostSol?: number;
  /** the same by base mint, for the per-stock report */
  swapCostByMint?: Record<string, number>;
  /** fees moved to the wallet by CLAIM_FEES, by pool, SOL-equivalent (the per-stock report) */
  feesClaimedByPool?: Record<string, number>;
  /** the virtual perp hedge book (src/paper/hedge.ts); absent on older books: empty */
  hedge?: PaperHedgeBook;
  /** marked network fees charged on paper transactions (PAPER_TX_FEE_SOL each), SOL; absent on older books: 0 */
  txFeesSol?: number;
  /** pools the paper desk made (the pair lane), by their pair-<mint> address; absent on older books: none */
  pairPools?: Record<string, PaperPairPool>;
}

/** marked network fee per paper transaction, as the real dry-run rows carry */
export const PAPER_TX_FEE_SOL = 0.000005;

/** Charge one paper transaction's network fee to the wallet and tally it (the equity identity subtracts the tally). */
export function chargeTxFee(book: PaperBook, feeSol: number = PAPER_TX_FEE_SOL): void {
  book.wallet.sol = r9(book.wallet.sol - feeSol);
  book.txFeesSol = r9((book.txFeesSol ?? 0) + feeSol);
}

export function emptyBook(startSol: number, startUsdc: number, now = Date.now()): PaperBook {
  return {
    version: 1,
    startedAt: new Date(now).toISOString(),
    startSol,
    startUsdc,
    seq: 0,
    wallet: { sol: startSol, usdc: startUsdc, tokens: {} },
    bands: [],
    closed: [],
    feesClaimedSol: 0,
    feesRealizedSol: 0,
    rentLockedSol: 0,
    rentSpentSol: 0,
    slippagePaidSol: 0,
    tokenMarks: {},
    tokenBasisSol: {},
    solPriceUsd: null,
    lastMarkAt: null,
    swapCostSol: 0,
    swapCostByMint: {},
    feesClaimedByPool: {},
    hedge: emptyHedgeBook(),
    txFeesSol: 0,
    pairPools: {},
  };
}

export const paperBookFile = (): string => dataPath(PAPER_BOOK_FILE);

/** The book on disk, or null when there is none (or it is unreadable). Missing tallies read as 0. */
export function loadPaperBook(file: string = paperBookFile()): PaperBook | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PaperBook>;
    if (!raw || typeof raw !== "object" || !raw.wallet || !Array.isArray(raw.bands)) return null;
    const empty = emptyBook(raw.startSol ?? 0, raw.startUsdc ?? 0);
    return {
      ...empty,
      ...raw,
      version: 1,
      wallet: { sol: raw.wallet.sol ?? 0, usdc: raw.wallet.usdc ?? 0, tokens: raw.wallet.tokens ?? {} },
      bands: raw.bands,
      closed: Array.isArray(raw.closed) ? raw.closed : [],
      tokenMarks: raw.tokenMarks ?? {},
      tokenBasisSol: raw.tokenBasisSol ?? {},
      swapCostSol: typeof raw.swapCostSol === "number" && Number.isFinite(raw.swapCostSol) ? raw.swapCostSol : 0,
      swapCostByMint: raw.swapCostByMint ?? {},
      feesClaimedByPool: raw.feesClaimedByPool ?? {},
      hedge: normalizeHedgeBook(raw.hedge),
      txFeesSol: typeof raw.txFeesSol === "number" && Number.isFinite(raw.txFeesSol) ? raw.txFeesSol : 0,
      pairPools: raw.pairPools ?? {},
    };
  } catch {
    return null;
  }
}

/** Written temp + rename: a kill mid-write leaves the previous book intact instead of torn JSON and a silently fresh start. */
export function savePaperBook(book: PaperBook, file: string = paperBookFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(book, null, 2));
  fs.renameSync(tmp, file);
}

export const bandsInPool = (book: PaperBook, pool: string): PaperBand[] => book.bands.filter((b) => b.pool === pool);

/** Pools that hold a paper band, in the order they were opened. */
export function poolsWithBands(book: PaperBook): string[] {
  return [...new Set(book.bands.map((b) => b.pool))];
}

export function paperTokenBalance(book: PaperBook, mint: string): number {
  return book.wallet.tokens[mint] ?? 0;
}

const r9 = (n: number) => Math.round(n * 1e9) / 1e9;

/** The wallet's balance of a quote token. */
export function quoteBalance(book: PaperBook, quoteSymbol: QuoteSymbol): number {
  return quoteSymbol === "SOL" ? book.wallet.sol : book.wallet.usdc;
}

function creditQuote(book: PaperBook, quoteSymbol: QuoteSymbol, amount: number): void {
  if (quoteSymbol === "SOL") book.wallet.sol = r9(book.wallet.sol + amount);
  else book.wallet.usdc = r9(book.wallet.usdc + amount);
}

/** Move base tokens in or out of the wallet; arrivals add their SOL value to the basis, departures scale it down pro rata. */
function creditToken(book: PaperBook, mint: string, amount: number, priceInSol: number): void {
  const before = book.wallet.tokens[mint] ?? 0;
  const basis = book.tokenBasisSol[mint] ?? 0;
  const next = r9(before + amount);
  const nextBasis = amount >= 0 ? basis + amount * priceInSol : before > 0 ? basis * Math.max(0, 1 - Math.min(1, -amount / before)) : 0;
  if (Math.abs(next) < 1e-12) {
    delete book.wallet.tokens[mint];
    delete book.tokenBasisSol[mint];
  } else {
    book.wallet.tokens[mint] = next;
    book.tokenBasisSol[mint] = r9(nextBasis);
  }
}

export interface CreatePairPoolInput {
  /** the virtual address: pair-<mint> */
  address: string;
  mint: string;
  symbol: string;
  stock?: StockTag | null;
  house?: boolean;
  refPool: string | null;
  refVenue: string | null;
  quote: QuoteSymbol;
  binStep: number;
  feeBps: number;
  /** creation rent, SOL, none of it refundable */
  rentSol: number;
  now: number;
}

/**
 * Make a pair pool in the paper book: the wallet pays the creation rent (lb pair + reserves + oracle,
 * and the seed's bin arrays when the caller folds them in), none of it refundable, and the pool is
 * recorded so the report can show what it earned against what it cost. Throws when the wallet cannot
 * pay or the pool already exists.
 */
export function createPairPool(book: PaperBook, i: CreatePairPoolInput): PaperPairPool {
  if (book.pairPools?.[i.address]) throw new Error(`paper pair pool ${i.address} already exists`);
  if (!(i.rentSol >= 0) || !Number.isFinite(i.rentSol)) throw new Error(`paper pair pool: bad rent ${i.rentSol}`);
  if (book.wallet.sol < i.rentSol) throw new Error(`paper wallet holds ${book.wallet.sol.toFixed(4)} SOL, needs ${i.rentSol.toFixed(4)} to create the pool`);
  book.wallet.sol = r9(book.wallet.sol - i.rentSol);
  book.rentSpentSol = r9(book.rentSpentSol + i.rentSol);
  const pool: PaperPairPool = { mint: i.mint, symbol: i.symbol, ...(i.stock ? { stock: i.stock } : {}), ...(i.house ? { house: true } : {}), refPool: i.refPool, refVenue: i.refVenue, quote: i.quote, binStep: i.binStep, feeBps: i.feeBps, createdAt: i.now, rentSol: i.rentSol };
  (book.pairPools ??= {})[i.address] = pool;
  return pool;
}

export interface OpenBandInput {
  pool: string;
  label: string;
  quoteSymbol: QuoteSymbol;
  quoteSide: "X" | "Y";
  quoteMint: string;
  tokenMint: string;
  tokenSymbol: string;
  xDecimals: number;
  yDecimals: number;
  binStep: number;
  activeBinId: number;
  activePrice: number;
  /** base token in quote units and one quote token in SOL, at open */
  tokenPriceInQuote: number;
  quotePriceInSol: number;
  lowerBinId: number;
  upperBinId: number;
  lowerPrice: number;
  upperPrice: number;
  side: PaperSide;
  strategy: PaperStrategy;
  /** the decision's deposits: quote units and base token units */
  amountQuote: number;
  amountToken: number;
  slippagePct: number;
  now: number;
  /** the pool's price model (default Meteora) */
  priceModel?: PriceModel;
  /** the venue's open cost: charged now, and the part refunded on close (default: the Meteora estimate and position rent) */
  rentChargedSol?: number;
  rentRefundableSol?: number;
}

export interface OpenBandResult {
  band: PaperBand;
  /** slippage charged, in quote units and SOL-equivalent */
  slippageQuote: number;
  slippageToken: number;
  slippageSol: number;
  rentChargedSol: number;
}

/**
 * Open a band: the wallet pays the deposit, the slippage on it and the open rent estimate
 * (position rent, refundable, plus two bin arrays, not). The band holds the full deposit; its
 * entry value is the deposit plus the slippage, in SOL. Throws when the wallet cannot pay.
 */
export function openBand(book: PaperBook, i: OpenBandInput): OpenBandResult {
  // A DLMM/CLMM deposit is not a swap: the tokens are laid into bins, nothing is traded, so there is no
  // slippage on the way in (the SDK's slippage parameter only guards against the active bin moving before
  // the transaction lands). The cost of opening is rent plus the network fee. Slippage is charged on the
  // token leg at close, where the desk would sell inventory. `slippagePct` is kept in the input for that.
  const slippageQuote = 0;
  const slippageToken = 0;
  const quoteCost = i.amountQuote + slippageQuote;
  const tokenCost = i.amountToken + slippageToken;
  const rentChargedSol = i.rentChargedSol ?? OPEN_COST_ESTIMATE_SOL;
  const rentRefundableSol = Math.min(rentChargedSol, i.rentRefundableSol ?? POSITION_RENT_SOL);
  const solCost = rentChargedSol + (i.quoteSymbol === "SOL" ? quoteCost : 0);
  if (book.wallet.sol < solCost) throw new Error(`paper wallet holds ${book.wallet.sol.toFixed(4)} SOL, needs ${solCost.toFixed(4)} (deposit, slippage and rent)`);
  if (i.quoteSymbol === "USDC" && book.wallet.usdc < quoteCost) throw new Error(`paper wallet holds ${book.wallet.usdc.toFixed(2)} USDC, needs ${quoteCost.toFixed(2)}`);
  // One raw unit of tolerance (review C7): the shortfall a paper swap brings in is rounded to the token's
  // decimals and the wallet is kept at 9, so a residue a few raw units short of the leg must not throw
  // after the swap fee was paid. The band takes what the wallet holds, and that is what it records.
  const tokenDec = i.quoteSide === "Y" ? i.xDecimals : i.yDecimals;
  const tokenTol = Math.max(1e-9, 10 ** -Math.min(tokenDec, 9));
  const tokenHeld = paperTokenBalance(book, i.tokenMint);
  if (tokenCost > 0 && tokenHeld + tokenTol < tokenCost) throw new Error(`paper wallet holds ${tokenHeld} ${i.tokenSymbol}, needs ${tokenCost}`);
  const tokenTaken = tokenCost > 0 ? Math.min(tokenCost, tokenHeld) : 0;

  creditQuote(book, i.quoteSymbol, -quoteCost);
  if (tokenTaken > 0) creditToken(book, i.tokenMint, -tokenTaken, i.tokenPriceInQuote * i.quotePriceInSol);
  book.wallet.sol = r9(book.wallet.sol - rentChargedSol);
  book.rentLockedSol = r9(book.rentLockedSol + rentRefundableSol);
  book.rentSpentSol = r9(book.rentSpentSol + (rentChargedSol - rentRefundableSol));
  const slippageSol = (slippageQuote + slippageToken * i.tokenPriceInQuote) * i.quotePriceInSol;
  book.slippagePaidSol = r9(book.slippagePaidSol + slippageSol);
  book.seq += 1;

  const strategyNote = i.strategy === "Spot" ? null : `${i.strategy} laid as Spot: the paper book spreads the deposit evenly across the bins`;
  const band: PaperBand = {
    address: `paper-${i.pool.slice(0, 6)}-${book.seq}`,
    pool: i.pool,
    label: i.label,
    quoteSymbol: i.quoteSymbol,
    quoteSide: i.quoteSide,
    quoteMint: i.quoteMint,
    tokenMint: i.tokenMint,
    tokenSymbol: i.tokenSymbol,
    xDecimals: i.xDecimals,
    yDecimals: i.yDecimals,
    lowerBinId: i.lowerBinId,
    upperBinId: i.upperBinId,
    lowerPrice: i.lowerPrice,
    upperPrice: i.upperPrice,
    binStep: i.binStep,
    ...(i.priceModel ? { priceModel: i.priceModel } : {}),
    ...(i.rentRefundableSol !== undefined ? { rentRefundableSol } : {}),
    strategy: i.strategy,
    strategyNote,
    side: i.side,
    quoteDeposit: i.amountQuote,
    tokenDeposit: tokenTaken,
    openedAt: i.now,
    openedBinId: i.activeBinId,
    openedPrice: i.activePrice,
    entryValueSol: (i.amountQuote + tokenTaken * i.tokenPriceInQuote) * i.quotePriceInSol + slippageSol,
    feeQuote: 0,
    feeToken: 0,
    lastMarkAt: i.now,
    lastActiveBinId: i.activeBinId,
  };
  book.bands.push(band);
  return { band, slippageQuote, slippageToken, slippageSol, rentChargedSol };
}

/** A band's current contents as the mark computed them (src/paper/mark.ts valueBand). */
export interface BandValue {
  amountQuote: number;
  amountToken: number;
  feeQuote: number;
  feeToken: number;
  tokenPriceInQuote: number;
  quotePriceInSol: number;
  activeBinId: number;
  price: number;
  inRange: boolean;
}

export interface CloseBandInput {
  address: string;
  value: BandValue;
  slippagePct: number;
  now: number;
  reason: string;
  emergency: boolean;
}

/**
 * Close a band: the wallet gets the quote back, the token less slippage, the fees and the
 * position rent; the band moves to `closed` with its realized P&L against the all-in entry.
 */
export function closeBand(book: PaperBook, i: CloseBandInput): PaperClosed {
  const idx = book.bands.findIndex((b) => b.address === i.address);
  if (idx < 0) throw new Error(`paper band ${i.address} not found`);
  const b = book.bands[idx];
  const v = i.value;
  const slip = i.slippagePct / 100;
  const tokenGross = v.amountToken + v.feeToken;
  const tokenNet = tokenGross * (1 - slip);
  const slippageSol = tokenGross * slip * v.tokenPriceInQuote * v.quotePriceInSol;
  const feeSol = (v.feeQuote + v.feeToken * v.tokenPriceInQuote) * v.quotePriceInSol;
  const proceedsSol = (v.amountQuote + v.feeQuote + tokenNet * v.tokenPriceInQuote) * v.quotePriceInSol;

  creditQuote(book, b.quoteSymbol, v.amountQuote + v.feeQuote);
  if (tokenNet > 0) creditToken(book, b.tokenMint, tokenNet, v.tokenPriceInQuote * v.quotePriceInSol);
  const rentRefund = bandRentRefund(b);
  book.wallet.sol = r9(book.wallet.sol + rentRefund);
  book.rentLockedSol = r9(Math.max(0, book.rentLockedSol - rentRefund));
  book.slippagePaidSol = r9(book.slippagePaidSol + slippageSol);
  book.feesRealizedSol = r9(book.feesRealizedSol + feeSol);

  const closed: PaperClosed = {
    address: b.address,
    pool: b.pool,
    label: b.label,
    quoteSymbol: b.quoteSymbol,
    side: b.side,
    lowerBinId: b.lowerBinId,
    upperBinId: b.upperBinId,
    quoteDeposit: b.quoteDeposit,
    tokenDeposit: b.tokenDeposit,
    openedAt: b.openedAt,
    openedPrice: b.openedPrice,
    entryValueSol: b.entryValueSol,
    closedAt: i.now,
    closedPrice: v.price,
    closedActiveBinId: v.activeBinId,
    quoteBack: v.amountQuote,
    tokenBack: v.amountToken,
    feeQuote: v.feeQuote,
    feeToken: v.feeToken,
    feeSol,
    slippageSol,
    proceedsSol,
    realizedSol: proceedsSol - b.entryValueSol,
    realizedPct: b.entryValueSol > 0 ? (proceedsSol / b.entryValueSol - 1) * 100 : 0,
    holdSec: Math.max(0, (i.now - b.openedAt) / 1000),
    inRangeAtClose: v.inRange,
    reason: i.reason,
    emergency: i.emergency,
  };
  book.bands.splice(idx, 1);
  book.closed.push(closed);
  return closed;
}

export interface ClaimResult {
  address: string;
  feeQuote: number;
  feeToken: number;
  feeSol: number;
}

/** Move a band's accrued fees to the wallet. Returns null when there was nothing to claim. */
export function claimFees(book: PaperBook, address: string, mark: Pick<BandValue, "tokenPriceInQuote" | "quotePriceInSol">, now: number): ClaimResult | null {
  const b = book.bands.find((x) => x.address === address);
  if (!b) throw new Error(`paper band ${address} not found`);
  if (b.feeQuote <= 0 && b.feeToken <= 0) return null;
  const feeQuote = b.feeQuote;
  const feeToken = b.feeToken;
  const feeSol = (feeQuote + feeToken * mark.tokenPriceInQuote) * mark.quotePriceInSol;
  creditQuote(book, b.quoteSymbol, feeQuote);
  if (feeToken > 0) creditToken(book, b.tokenMint, feeToken, mark.tokenPriceInQuote * mark.quotePriceInSol);
  b.feeQuote = 0;
  b.feeToken = 0;
  b.lastMarkAt = Math.max(b.lastMarkAt, now);
  book.feesClaimedSol = r9(book.feesClaimedSol + feeSol);
  book.feesRealizedSol = r9(book.feesRealizedSol + feeSol);
  (book.feesClaimedByPool ??= {})[b.pool] = r9((book.feesClaimedByPool[b.pool] ?? 0) + feeSol);
  return { address, feeQuote, feeToken, feeSol };
}

export interface PaperSwapInput {
  quoteSymbol: QuoteSymbol;
  tokenMint: string;
  tokenSymbol: string;
  /** base token in quote units and one quote token in SOL, at the swap */
  tokenPriceInQuote: number;
  quotePriceInSol: number;
  /** the swap fee in percent of the input (default SWAP_FEE_PCT) */
  feePct?: number;
}

export interface PaperSwapResult {
  /** input units spent (quote for a buy, token for a sell) */
  amountIn: number;
  /** output units received (token for a buy, quote for a sell) */
  amountOut: number;
  /** the fee in input units, and SOL-equivalent */
  feeIn: number;
  feeSol: number;
  feePct: number;
}

/**
 * A paper Jupiter leg: BUY `tokenOut` base tokens with the quote at the pool's price (the wallet
 * pays the token's value plus the fee; the token arrives at the mark). Throws when the quote is short.
 */
export function buyToken(book: PaperBook, i: PaperSwapInput & { tokenOut: number }): PaperSwapResult {
  if (!(i.tokenOut > 0) || !Number.isFinite(i.tokenOut)) throw new Error(`paper buy: bad amount ${i.tokenOut}`);
  const feePct = i.feePct ?? paperSwap(1, 1).feePct;
  const amountIn = paperCostToBuy(i.tokenOut, i.tokenPriceInQuote, feePct);
  const fill = paperSwap(amountIn, 1 / i.tokenPriceInQuote, feePct);
  const have = quoteBalance(book, i.quoteSymbol);
  if (have < amountIn) throw new Error(`paper wallet holds ${have.toFixed(i.quoteSymbol === "SOL" ? 4 : 2)} ${i.quoteSymbol}, needs ${amountIn.toFixed(i.quoteSymbol === "SOL" ? 4 : 2)} to buy ${i.tokenOut} ${i.tokenSymbol}`);
  creditQuote(book, i.quoteSymbol, -amountIn);
  creditToken(book, i.tokenMint, fill.amountOut, i.tokenPriceInQuote * i.quotePriceInSol);
  const feeSol = fill.feeIn * i.quotePriceInSol;
  tallySwapCost(book, i.tokenMint, feeSol);
  return { amountIn, amountOut: fill.amountOut, feeIn: fill.feeIn, feeSol, feePct: fill.feePct };
}

/** A paper Jupiter leg: SELL `tokenIn` base tokens into the quote at the pool's price less the fee. Throws when the wallet holds less. */
export function sellToken(book: PaperBook, i: PaperSwapInput & { tokenIn: number }): PaperSwapResult {
  if (!(i.tokenIn > 0) || !Number.isFinite(i.tokenIn)) throw new Error(`paper sell: bad amount ${i.tokenIn}`);
  const have = paperTokenBalance(book, i.tokenMint);
  if (have + 1e-9 < i.tokenIn) throw new Error(`paper wallet holds ${have} ${i.tokenSymbol}, cannot sell ${i.tokenIn}`);
  const fill = paperSwap(i.tokenIn, i.tokenPriceInQuote, i.feePct);
  creditToken(book, i.tokenMint, -Math.min(have, i.tokenIn), i.tokenPriceInQuote * i.quotePriceInSol);
  creditQuote(book, i.quoteSymbol, fill.amountOut);
  const feeSol = fill.feeIn * i.tokenPriceInQuote * i.quotePriceInSol;
  tallySwapCost(book, i.tokenMint, feeSol);
  return { amountIn: i.tokenIn, amountOut: fill.amountOut, feeIn: fill.feeIn, feeSol, feePct: fill.feePct };
}

function tallySwapCost(book: PaperBook, mint: string, feeSol: number): void {
  book.swapCostSol = r9((book.swapCostSol ?? 0) + feeSol);
  (book.swapCostByMint ??= {})[mint] = r9((book.swapCostByMint[mint] ?? 0) + feeSol);
}

/** The rent a band hands back on close: what it recorded at open, else the Meteora position rent. */
export const bandRentRefund = (b: Pick<PaperBand, "rentRefundableSol">): number => (typeof b.rentRefundableSol === "number" && b.rentRefundableSol >= 0 ? b.rentRefundableSol : POSITION_RENT_SOL);

/** The non-refundable part of one Meteora open, for reports. */
export const OPEN_RENT_SPENT_SOL = OPEN_COST_ESTIMATE_SOL - POSITION_RENT_SOL;
export { BIN_ARRAY_RENT_SOL, OPEN_COST_ESTIMATE_SOL, POSITION_RENT_SOL };
