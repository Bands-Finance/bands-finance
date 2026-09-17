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

function readLatest(): PoolMeta[] {
  try {
    const latest = JSON.parse(fs.readFileSync(path.join(dataDir, "latest.json"), "utf8"));
    return poolsFromLatest(latest);
  } catch {
    return [];
  }
}

/** The candidates the desk ranked this cycle (DATA_DIR/flow-watch.json): watched so the next ranking has their last hour. */
function readWatch(): PoolMeta[] {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, "flow-watch.json"), "utf8")) as { pools?: PoolMeta[] };
    return Array.isArray(j.pools) ? j.pools.filter((p) => p && typeof p.address === "string") : [];
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

async function main(): Promise<void> {
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
