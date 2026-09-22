/**
 * The flow scout's loop: poll the chain for every transaction that touched the desk's pools, decode
 * Meteora's swap events out of them, keep an hour of swaps per pool, and write DATA_DIR/flow.json
 * every FLOW_POLL_SEC seconds (5) for the desk to read. Also appends every swap to
 * DATA_DIR/flow-events.jsonl for replay.
 *
 *   npm run flow                       (DATA_DIR from the env; the live service sources ops/live.env)
 *   FLOW_POOLS=addr,addr npm run flow  (extra pools beyond the ones the desk works)
 *
 * The pools come from DATA_DIR/latest.json (the desk's newest entry per pool, re-read every 30s),
 * so a new band is watched from the desk's next cycle, and our band's bins come with it. Starts by
 * backfilling the last hour of signatures per pool. One process, no wallet, nothing sent.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import { config } from "../config";
import { decodeSwapEvents, dlmmInnerData, FLOW_EVENTS_FILE, FLOW_FILE, flowLine, flowPoolOf, poolsFromLatest, swapOf, trimSwaps, type FlowFile, type FlowSwap, type PoolMeta } from "../scouts/flow";
import { decodeLbPair, flowPoolFromSamples, sampleOf, trimSamples, type AccountPoolMeta, type AccountSample } from "../scouts/accountFlow";

const num = (v: string | undefined, d: number): number => {
  const n = Number(v ?? "");
  return Number.isFinite(n) && n > 0 ? n : d;
};
const POLL_MS = num(process.env.FLOW_POLL_SEC, 5) * 1000;
/** FLOW_BACKFILL_MIN: how far back the first pass on a pool reads (240 = the longest window, so the 4h pace is there at once) */
const BACKFILL_MS = Math.max(1, num(process.env.FLOW_BACKFILL_MIN, 240)) * 60_000;
const RELIST_MS = 30_000;
const dataDir = path.resolve(process.cwd(), config.dataDir);
const connection = new Connection(config.rpcUrl, "confirmed");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

interface Watch {
  meta: PoolMeta;
  swaps: FlowSwap[];
  /** the newest signature seen; the next poll asks for what came after it */
  newestSig: string | null;
  backfilled: boolean;
  /** when the reading starts (the backfill's start), once the backfill is done */
  watchedSince: number | null;
}

const watches = new Map<string, Watch>();

/**
 * A pool that exists on the chain. The PAPER book works virtual pools too (the pair lanes' own
 * pools, whose addresses read "pair-..."), and one of those in the list made getMultipleAccountsInfo
 * throw "Non-base58 character" for the whole batch, so the paper scout read nothing at all. They are
 * dropped here rather than in the desk: a scout reads the chain, and a virtual pool is not on it.
 */
const onChain = (p: PoolMeta): boolean => {
  try {
    void new PublicKey(p.address);
    return true;
  } catch {
    return false;
  }
};

function readLatest(): PoolMeta[] {
  try {
    const latest = JSON.parse(fs.readFileSync(path.join(dataDir, "latest.json"), "utf8"));
    return poolsFromLatest(latest).filter(onChain);
  } catch {
    return [];
  }
}

/** The candidates the desk ranked this cycle (DATA_DIR/flow-watch.json): watched so the next ranking has their last hour. */
function readWatch(): PoolMeta[] {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, "flow-watch.json"), "utf8")) as { pools?: PoolMeta[] };
    return Array.isArray(j.pools) ? j.pools.filter((p) => p && typeof p.address === "string").filter(onChain) : [];
  } catch {
    return [];
  }
}

function relist(): void {
  const wanted = new Map<string, PoolMeta>();
  for (const p of readWatch()) wanted.set(p.address, { ...p, band: null });
  for (const p of readLatest()) wanted.set(p.address, p);
  for (const a of (process.env.FLOW_POOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!wanted.has(a)) wanted.set(a, { address: a, label: a.slice(0, 8), quoteSide: "Y", quoteSymbol: "SOL", xDecimals: 6, yDecimals: 9, band: null });
  }
  for (const [addr, meta] of wanted) {
    const w = watches.get(addr);
    if (w) w.meta = meta; // the band may have changed
    else {
      watches.set(addr, { meta, swaps: [], newestSig: null, backfilled: false, watchedSince: null });
      console.log(`[flow ${stamp()}] watching ${meta.label} (${addr.slice(0, 8)})${meta.band ? `, our band bins [${meta.band.lowerBinId}, ${meta.band.upperBinId}]` : ""}`);
    }
  }
  for (const addr of [...watches.keys()]) if (!wanted.has(addr)) {
    console.log(`[flow ${stamp()}] no longer watching ${watches.get(addr)!.meta.label}`);
    watches.delete(addr);
  }
}

const keyAtOf = (tx: VersionedTransactionResponse) => {
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined });
  return (i: number) => keys.get(i)?.toBase58() ?? null;
};

/** The swaps in one transaction for one pool. */
function swapsIn(tx: VersionedTransactionResponse, sig: string, pool: PoolMeta): FlowSwap[] {
  if (!tx.meta || tx.meta.err) return [];
  const events = decodeSwapEvents(dlmmInnerData({ meta: tx.meta, keyAt: keyAtOf(tx) }));
  const ts = (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000;
  const out: FlowSwap[] = [];
  for (const ev of events) {
    const s = swapOf(ev, { sig, slot: tx.slot, ts }, pool);
    if (s) out.push(s);
  }
  return out;
}

/** Each transaction on its own (the batched call rejects versioned transactions), a few at a time. */
async function fetchTxs(sigs: string[]): Promise<Map<string, VersionedTransactionResponse>> {
  const out = new Map<string, VersionedTransactionResponse>();
  const CONCURRENCY = 4;
  for (let i = 0; i < sigs.length; i += CONCURRENCY) {
    const chunk = sigs.slice(i, i + CONCURRENCY);
    const txs = await Promise.all(chunk.map((sig) => connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null)));
    txs.forEach((tx, k) => {
      if (tx) out.set(chunk[k], tx);
    });
  }
  return out;
}

/** New signatures for a pool since the newest one seen (or the last hour on the first pass), oldest first. */
async function newSignatures(w: Watch): Promise<string[]> {
  const pool = new PublicKey(w.meta.address);
  const sinceSec = Math.floor((Date.now() - BACKFILL_MS) / 1000);
  if (!w.backfilled && w.watchedSince === null) w.watchedSince = sinceSec * 1000;
  const collected: { signature: string; blockTime?: number | null; err: unknown }[] = [];
  let before: string | undefined;
  // the first pass pages until it reaches the backfill start (a busy pool has thousands of signatures
  // in four hours, most of them bots' failed tries); later passes only need what came after newestSig
  const maxPages = w.backfilled ? 10 : 80;
  let reached = false;
  for (let page = 0; page < maxPages; page++) {
    const batch = await connection.getSignaturesForAddress(pool, { limit: 100, before, until: w.newestSig ?? undefined }, "confirmed");
    if (!batch.length) {
      reached = true;
      break;
    }
    let stop = false;
    for (const s of batch) {
      if (!w.backfilled && s.blockTime !== null && s.blockTime !== undefined && s.blockTime < sinceSec) {
        stop = true;
        break;
      }
      collected.push(s);
    }
    if (stop || batch.length < 100 || w.newestSig) {
      reached = true;
      break;
    }
    before = batch[batch.length - 1].signature;
  }
  // the coverage the file claims is what the backfill actually reached: with the page cap hit, the
  // oldest signature collected (the file said 245 min covered for an hour of swaps, 2026-09-17)
  if (!w.backfilled && !reached) {
    const oldest = collected.reduce<number | null>((t, s) => (typeof s.blockTime === "number" && (t === null || s.blockTime < t) ? s.blockTime : t), null);
    if (oldest !== null) {
      w.watchedSince = oldest * 1000;
      console.log(`[flow ${stamp()}] ${w.meta.label}: backfill stopped at ${collected.length} signatures over ${maxPages} pages; coverage from ${new Date(oldest * 1000).toISOString().slice(11, 19)}`);
    }
  }
  return collected
    .filter((s) => !s.err)
    .map((s) => s.signature)
    .reverse();
}

let appendFail = 0;
function appendEvents(swaps: FlowSwap[]): void {
  if (!swaps.length) return;
  try {
    fs.appendFileSync(path.join(dataDir, FLOW_EVENTS_FILE), swaps.map((s) => JSON.stringify(s)).join("\n") + "\n");
  } catch (err) {
    if (appendFail++ % 50 === 0) console.error(`[flow] could not append events: ${(err as Error).message}`);
  }
}

function writeFile(now: number): void {
  const file: FlowFile = { generatedAt: new Date(now).toISOString(), pollSec: POLL_MS / 1000, pools: [...watches.values()].map((w) => flowPoolOf(w.meta, w.swaps, now, w.backfilled ? w.watchedSince : null)) };
  const target = path.join(dataDir, FLOW_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file));
  fs.renameSync(tmp, target);
}

async function poll(): Promise<void> {
  const now = Date.now();
  for (const w of watches.values()) {
    try {
      const sigs = await newSignatures(w);
      if (sigs.length) {
        const txs = await fetchTxs(sigs);
        const fresh: FlowSwap[] = [];
        for (const sig of sigs) {
          const tx = txs.get(sig);
          if (tx) fresh.push(...swapsIn(tx, sig, w.meta));
        }
        w.newestSig = sigs[sigs.length - 1];
        if (fresh.length) {
          w.swaps = trimSwaps([...w.swaps, ...fresh], now);
          appendEvents(fresh);
          const p = flowPoolOf(w.meta, w.swaps, now, w.backfilled ? w.watchedSince : null);
          const q = w.meta.quoteSymbol;
          const vol = fresh.reduce((t, s) => t + s.volumeQuote, 0);
          const fee = fresh.reduce((t, s) => t + s.feeQuote, 0);
          const ours = fresh.reduce((t, s) => t + s.feeQuote * s.ourBinShare, 0);
          console.log(`[flow ${stamp()}] ${w.meta.label}: ${fresh.length} swap${fresh.length === 1 ? "" : "s"} (${w.backfilled ? "new" : "backfill"}), ${vol.toFixed(q === "SOL" ? 3 : 1)} ${q}, fees ${fee.toFixed(q === "SOL" ? 4 : 2)} ${q}${w.meta.band ? `, ${ours.toFixed(q === "SOL" ? 4 : 2)} through our bins` : ""}`);
          if (w.backfilled) console.log(flowLine(p, POLL_MS, now));
        }
      }
      if (!w.backfilled) {
        w.backfilled = true;
        console.log(flowLine(flowPoolOf(w.meta, w.swaps, now, w.watchedSince), BACKFILL_MS, now));
      }
    } catch (err) {
      console.error(`[flow ${stamp()}] ${w.meta.label}: ${(err as Error).message.slice(0, 160)}`);
    }
  }
  writeFile(now);
}

/* =====================================================================================================
 * ACCOUNTS MODE (the default, FLOW_MODE=accounts): one getMultipleAccounts call per poll reads every
 * watched pool's own account (src/scouts/accountFlow.ts). Watched: the desk's pools and picks (latest.json,
 * flow-watch.json), FLOW_POOLS, and a standing list of the board's best (DATA_DIR/screen.json, top
 * FLOW_BOARD_TOP by fee on depth over FLOW_BOARD_MIN_VOL_USD), so a candidate has hours of history before
 * the picker wants it. Samples are seeded from the screener's own half-hourly history of the same counters
 * (DATA_DIR/screen-history.json) and kept across restarts in DATA_DIR/flow-samples.json.
 * FLOW_MODE=tx runs the first scout (every transaction decoded) unchanged.
 * ===================================================================================================== */
const SAMPLES_FILE = "flow-samples.json";
const BOARD_TOP = Math.floor(num(process.env.FLOW_BOARD_TOP, 40));
const BOARD_MIN_VOL_USD = num(process.env.FLOW_BOARD_MIN_VOL_USD, 100_000);
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

interface AccountWatch {
  /** what is known before the first decode: the desk's meta, or a board row's (then the quote side waits for the account) */
  meta: PoolMeta;
  quoteSideKnown: boolean;
  quoteMint: string | null;
  full: AccountPoolMeta | null;
  samples: AccountSample[];
  seeded: boolean;
}
const accountWatches = new Map<string, AccountWatch>();
let rpcCalls = 0;

interface BoardRow { address: string; name: string; venue?: string; quoteSymbol: string; quoteMint?: string; baseDecimals: number; quoteDecimals: number; feeToTvl24hPct: number | null; volume24hUsd: number | null; flags?: string[] }
function readBoard(): { meta: PoolMeta; quoteMint: string | null }[] {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, "screen.json"), "utf8")) as { pools?: BoardRow[] };
    return (j.pools ?? [])
      .filter((p) => String(p.venue ?? "meteora-dlmm").includes("meteora") && (p.quoteSymbol === "SOL" || p.quoteSymbol === "USDC") && (p.volume24hUsd ?? 0) >= BOARD_MIN_VOL_USD && !(p.flags ?? []).includes("thin"))
      .sort((a, b) => (b.feeToTvl24hPct ?? -1) - (a.feeToTvl24hPct ?? -1))
      .slice(0, BOARD_TOP)
      .map((p) => ({
        // the quote side and which decimals are X's and Y's wait for the account (token_x_mint / token_y_mint)
        meta: { address: p.address, label: p.name.replace(/\s*\/\s*/, "/"), quoteSide: "Y" as const, quoteSymbol: p.quoteSymbol, xDecimals: p.baseDecimals, yDecimals: p.quoteDecimals, band: null },
        quoteMint: p.quoteMint ?? (p.quoteSymbol === "SOL" ? SOL_MINT : USDC_MINT),
      }));
  } catch {
    return [];
  }
}

function relistAccounts(): void {
  const wanted = new Map<string, { meta: PoolMeta; quoteSideKnown: boolean; quoteMint: string | null }>();
  for (const b of readBoard()) wanted.set(b.meta.address, { meta: b.meta, quoteSideKnown: false, quoteMint: b.quoteMint });
  for (const p of readWatch()) wanted.set(p.address, { meta: { ...p, band: null }, quoteSideKnown: true, quoteMint: null });
  for (const p of readLatest()) wanted.set(p.address, { meta: p, quoteSideKnown: true, quoteMint: null });
  for (const a of (process.env.FLOW_POOLS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    if (!wanted.has(a)) wanted.set(a, { meta: { address: a, label: a.slice(0, 8), quoteSide: "Y", quoteSymbol: "SOL", xDecimals: 6, yDecimals: 9, band: null }, quoteSideKnown: false, quoteMint: SOL_MINT });
  }
  for (const [addr, w] of wanted) {
    const have = accountWatches.get(addr);
    if (have) {
      // the desk's meta wins over a board row's (it knows the quote side and our band); the samples stay
      if (w.quoteSideKnown || !have.quoteSideKnown) {
        const changedSide = have.full && w.quoteSideKnown && have.full.quoteSide !== w.meta.quoteSide;
        have.meta = w.quoteSideKnown ? w.meta : { ...have.meta, band: have.meta.band };
        have.quoteSideKnown = have.quoteSideKnown || w.quoteSideKnown;
        if (have.full) have.full = { ...have.full, ...(w.quoteSideKnown ? w.meta : {}), band: w.quoteSideKnown ? w.meta.band : have.full.band };
        if (changedSide) have.samples = []; // the counters were read on the wrong sides: start over
      }
    } else {
      accountWatches.set(addr, { meta: w.meta, quoteSideKnown: w.quoteSideKnown, quoteMint: w.quoteMint, full: null, samples: [], seeded: false });
    }
  }
  // a pool nobody wants any more keeps its samples for ten minutes (the picker's candidates come and go)
  for (const [addr, w] of accountWatches) {
    if (wanted.has(addr)) continue;
    const last = w.samples.length ? w.samples[w.samples.length - 1].ts : 0;
    if (Date.now() - last > 10 * 60_000) accountWatches.delete(addr);
  }
}

/** The screener's half-hourly history of the same counters (raw units, base and quote): a coarse first four hours. */
function seedFromScreenHistory(w: AccountWatch, full: AccountPoolMeta, now: number): void {
  if (w.seeded) return;
  w.seeded = true;
  try {
    const h = JSON.parse(fs.readFileSync(path.join(dataDir, "screen-history.json"), "utf8")) as Record<string, { t: number; fb: string; fq: string; bin: number }[]>;
    const rows = (h[full.address] ?? []).filter((r) => now - r.t <= 4 * 3_600_000 + 60_000 && now - r.t > 0);
    const seeds = rows.map((r) => {
      // the screener stores the account's amount_x as "fb" and amount_y as "fq" whichever side the quote is on
      return { ts: r.t, activeId: r.bin, feeX: Number(r.fb) / Math.pow(10, full.xDecimals), feeY: Number(r.fq) / Math.pow(10, full.yDecimals) };
    });
    if (seeds.length && !w.samples.length) w.samples = seeds.sort((a, b) => a.ts - b.ts);
  } catch {
    /* no history: coverage starts now */
  }
}

function loadSamples(now: number): void {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, SAMPLES_FILE), "utf8")) as { pools?: Record<string, { side: "X" | "Y"; samples: AccountSample[] }> };
    for (const [addr, rec] of Object.entries(j.pools ?? {})) {
      const w = accountWatches.get(addr);
      if (!w || !Array.isArray(rec.samples)) continue;
      // a board row's quote side is only a guess until the account is read: keep saved samples only when the side was recorded
      w.samples = trimSamples(rec.samples.filter((x) => x && typeof x.ts === "number"), now);
      if (w.samples.length) w.seeded = true;
      (w as AccountWatch & { savedSide?: "X" | "Y" }).savedSide = rec.side;
    }
  } catch {
    /* first run */
  }
}

function saveSamples(now: number): void {
  try {
    const pools: Record<string, { side: "X" | "Y"; samples: AccountSample[] }> = {};
    for (const [addr, w] of accountWatches) if (w.full && w.samples.length) pools[addr] = { side: w.full.quoteSide, samples: trimSamples(w.samples, now, 0, 30_000) };
    const target = path.join(dataDir, SAMPLES_FILE);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date(now).toISOString(), pools }));
    fs.renameSync(tmp, target);
  } catch (err) {
    console.error(`[flow ${stamp()}] could not save samples: ${(err as Error).message.slice(0, 120)}`);
  }
}

async function pollAccounts(): Promise<void> {
  const now = Date.now();
  const list = [...accountWatches.values()];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    let infos: (import("@solana/web3.js").AccountInfo<Buffer> | null)[];
    try {
      rpcCalls++;
      infos = await connection.getMultipleAccountsInfo(chunk.map((w) => new PublicKey(w.meta.address)), "confirmed");
    } catch (err) {
      console.error(`[flow ${stamp()}] accounts read failed: ${(err as Error).message.slice(0, 140)}`);
      continue;
    }
    infos.forEach((info, k) => {
      const w = chunk[k];
      if (!info) return;
      try {
        const d = decodeLbPair(info.data as Buffer);
        if (!w.full) {
          // settle the sides: the desk's meta says which side is the quote; a board row's is read off the mints
          let meta = w.meta;
          if (!w.quoteSideKnown && w.quoteMint) {
            const quoteIsX = d.tokenXMint === w.quoteMint;
            // a board row listed base then quote decimals: put them on the sides the account says
            meta = quoteIsX ? { ...meta, quoteSide: "X", xDecimals: w.meta.yDecimals, yDecimals: w.meta.xDecimals } : { ...meta, quoteSide: "Y" };
          }
          w.full = { ...meta, binStep: d.binStep, protocolSharePct: d.protocolSharePct, baseFeePct: d.baseFeePct };
          const saved = (w as AccountWatch & { savedSide?: "X" | "Y" }).savedSide;
          if (saved && saved !== w.full.quoteSide) w.samples = [];
          seedFromScreenHistory(w, w.full, now);
          console.log(`[flow ${stamp()}] sampling ${w.full.label} (${w.full.address.slice(0, 8)}): ${w.full.binStep / 100}%/bin, base fee ${w.full.baseFeePct ?? "?"}%, protocol share ${w.full.protocolSharePct}%, quote on ${w.full.quoteSide}${w.samples.length ? `, ${w.samples.length} earlier samples from ${new Date(w.samples[0].ts).toISOString().slice(11, 16)}Z` : ""}${w.full.band ? `, our band [${w.full.band.lowerBinId}, ${w.full.band.upperBinId}]` : ""}`);
        } else {
          w.full = { ...w.full, band: w.meta.band, binStep: d.binStep, protocolSharePct: d.protocolSharePct, baseFeePct: d.baseFeePct };
        }
        const s = sampleOf(d, now, w.full.xDecimals, w.full.yDecimals);
        const last = w.samples.length ? w.samples[w.samples.length - 1] : null;
        // a sample when something moved, or every 30 s so the clock of the windows keeps running
        if (!last || s.activeId !== last.activeId || s.feeX !== last.feeX || s.feeY !== last.feeY || now - last.ts >= 30_000) w.samples.push(s);
      } catch (err) {
        if (!w.full) console.error(`[flow ${stamp()}] ${w.meta.label}: ${(err as Error).message.slice(0, 120)}`);
      }
    });
  }
  const pools = list.filter((w) => w.full).map((w) => flowPoolFromSamples(w.full!, w.samples, now));
  const file: FlowFile = { generatedAt: new Date(now).toISOString(), pollSec: POLL_MS / 1000, pools };
  const target = path.join(dataDir, FLOW_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file));
  fs.renameSync(tmp, target);
}

async function mainAccounts(): Promise<void> {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log(`[flow] account scout up: DATA_DIR=${config.dataDir}, poll ${POLL_MS / 1000}s, board top ${BOARD_TOP}, rpc ${/helius/.test(config.rpcUrl) ? "helius" : "other"}`);
  relistAccounts();
  loadSamples(Date.now());
  let lastRelist = Date.now();
  let lastSave = Date.now();
  let lastLine = Date.now();
  for (;;) {
    const t0 = Date.now();
    if (t0 - lastRelist >= RELIST_MS) {
      relistAccounts();
      lastRelist = t0;
    }
    await pollAccounts();
    const now = Date.now();
    for (const w of accountWatches.values()) if (w.samples.length > 400) w.samples = trimSamples(w.samples, now);
    if (now - lastSave >= 5 * 60_000) {
      saveSamples(now);
      lastSave = now;
    }
    if (now - lastLine >= 60_000) {
      lastLine = now;
      const all = [...accountWatches.values()].filter((w) => w.full);
      const traded = all.filter((w) => w.samples.length > 1 && now - (flowPoolFromSamples(w.full!, w.samples, now).lastSwapAt ?? 0) <= 60_000).length;
      console.log(`[flow ${stamp()}] ${all.length} pools sampled, ${traded} traded in the last minute, ${rpcCalls} account reads since the start`);
      for (const w of all) if (w.full!.band) console.log(flowLine(flowPoolFromSamples(w.full!, w.samples, now), POLL_MS, now));
    }
    await sleep(Math.max(500, POLL_MS - (Date.now() - t0)));
  }
}

async function main(): Promise<void> {
  if ((process.env.FLOW_MODE ?? "accounts").trim().toLowerCase() !== "tx") return mainAccounts();
  fs.mkdirSync(dataDir, { recursive: true });
  console.log(`[flow] scout up: DATA_DIR=${config.dataDir}, poll ${POLL_MS / 1000}s, rpc ${/helius/.test(config.rpcUrl) ? "helius" : "other"}`);
  relist();
  let lastRelist = Date.now();
  for (;;) {
    if (Date.now() - lastRelist >= RELIST_MS) {
      relist();
      lastRelist = Date.now();
    }
    const t0 = Date.now();
    await poll();
    await sleep(Math.max(500, POLL_MS - (Date.now() - t0)));
  }
}

main().catch((err) => {
  console.error("[flow] fatal:", err);
  process.exit(1);
});
