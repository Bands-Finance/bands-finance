/**
 * The stalls' history file (src/publish/gameHistory.ts): which board rows it reads, GeckoTerminal's answer read into
 * [time, value] pairs, and a pass on a fake network and clock: two reads per pool, paced, a 429 waited out once, a
 * fresh pool kept unread, a failed read keeping the last good one, the time budget, pools that left the board, and
 * never a throw. No network.
 *   npm run test:game-history
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BACKOFF_MS,
  BUDGET_MS,
  GAP_MS,
  historyPools,
  historyUrls,
  KEEP_MS,
  loadHistoryFile,
  pairsOf,
  REFRESH_MS,
  refreshHistory,
  writeHistoryFile,
  type HistoryFile,
} from "../publish/gameHistory";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(err);
    process.exit(1);
  }
}

const A = "5MGvNj9RNKNmzwp1LtZuQkZonEYtKJ3JuiyNQEUU2DsF";
const B = "2N1KNuLSt167P6p9P8HYcisTvTTv4vYTM8QJBbtv1xYU";
const C = "WVQ6uNtARvaSA4qzsVUrdccastXBj3rdLWVsNMxo46M";
const MINT = "XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2";
const row = (address: string, over: Record<string, unknown> = {}) => ({ address, name: "X / USDC", feePct: 0.25, feeToTvl1hPct: 0.3, ...over });
const HOT = { rows: [row(A, { baseMint: MINT }), row(B), row(C)] };
const T0 = 1_790_000_000 - (1_790_000_000 % 3600);
/** GeckoTerminal's answer: newest first, [ts, o, h, l, c, v] */
const body = (close: number, vol: number) => ({
  data: { attributes: { ohlcv_list: Array.from({ length: 60 }, (_, k) => [T0 + (59 - k) * 3600, 1, 1, 1, close + k * 1e-9, vol + k]) } },
});

/** a fake network and clock: answers by URL, records every call and the time it went */
function net(answer: (url: string, n: number) => { status: number; json?: unknown } | Error) {
  let t = Date.parse("2026-09-24T16:00:00Z");
  const calls: { url: string; at: number }[] = [];
  return {
    calls,
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    fetch: async (url: string) => {
      calls.push({ url, at: t });
      t += 300; // a read takes a moment
      const a = answer(url, calls.length);
      if (a instanceof Error) throw a;
      return new Response(a.json === undefined ? "" : JSON.stringify(a.json), { status: a.status });
    },
  };
}
const ok = (url: string) => ({ status: 200, json: url.includes("currency=usd") ? body(150, 2000) : body(0.00007, 12) });

(async () => {
  await test("historyPools: the board's usable rows in order, at most 14, each address once", () => {
    const bad = [null, { name: "x" }, row("not-an-address"), row(B, { feeToTvl1hPct: null }), row(B, { feePct: 0 }), row(B, { name: "" })];
    assert.deepEqual(historyPools({ rows: [...bad, row(A, { baseMint: MINT }), row(B, { baseMint: "../x" }), row(A)] }), [
      { address: A, baseMint: MINT },
      { address: B, baseMint: null },
    ]);
    const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const many = { rows: Array.from({ length: 30 }, (_, i) => row(`${A.slice(0, 42)}${B58[i]}`)) };
    assert.equal(historyPools(many).length, 14);
    assert.deepEqual(historyPools(null), []);
    assert.deepEqual(historyPools({ rows: "x" }), []);
  });

  await test("historyUrls: prices in the quote by the base mint, volume in USD", () => {
    const u = historyUrls(A, MINT);
    assert.equal(u.price, `https://api.geckoterminal.com/api/v2/networks/solana/pools/${A}/ohlcv/hour?aggregate=1&limit=200&token=${MINT}&currency=token`);
    assert.match(u.volume, /&currency=usd$/);
    assert.match(historyUrls(A, null).price, /&token=base&/);
  });

  await test("pairsOf: [time, close] or [time, volume], oldest first, sensible rows only, rounded", () => {
    const b = { data: { attributes: { ohlcv_list: [[T0 + 3600, 1, 1, 1, 0.000123456789, 10.456], [T0, 1, 1, 1, 2, 3], [T0 + 60, 1, 1, 1, 2, 3], [T0 + 7200, 1, 1, 1, 0, 1], [T0 + 10800, 1, 1, 1, 5, -1], "x"] } } };
    assert.deepEqual(pairsOf(b, 4, 7), [[T0, 2], [T0 + 3600, 0.0001234568], [T0 + 10800, 5]]);
    assert.deepEqual(pairsOf(b, 5, 0), [[T0, 3], [T0 + 3600, 10.46], [T0 + 7200, 1]]);
    assert.deepEqual(pairsOf(null, 4, 7), []);
  });

  await test("a pass: two reads per pool, paced GAP_MS apart, into the file", async () => {
    const n = net((u) => ok(u));
    const r = await refreshHistory({ hot: HOT, previous: null, fetch: n.fetch, now: n.now, sleep: n.sleep });
    assert.equal(r.read, 3);
    assert.equal(n.calls.length, 6);
    assert.ok(n.calls[0].url.includes(`token=${MINT}&currency=token`));
    assert.ok(n.calls[1].url.includes("currency=usd"));
    for (let i = 1; i < n.calls.length; i++) assert.ok(n.calls[i].at - n.calls[i - 1].at >= GAP_MS, "paced");
    const a = r.file.pools[A];
    assert.equal(a.price.length, 60);
    assert.equal(a.price[0][0], T0);
    assert.equal(a.volume[59][1], 2000);
    assert.equal(a.at, n.calls[1].at + 300);
    assert.equal(Object.keys(r.file.pools).length, 3);
  });

  await test("a 429 is waited out once; a second 429 or an error fails the pool, which keeps its last good read", async () => {
    const n = net((u, k) => (k === 1 ? { status: 429 } : ok(u)));
    const r = await refreshHistory({ hot: { rows: [row(A)] }, previous: null, fetch: n.fetch, now: n.now, sleep: n.sleep });
    assert.equal(r.read, 1);
    assert.equal(n.calls.length, 3);
    assert.ok(n.calls[1].at - n.calls[0].at >= BACKOFF_MS);

    const old: HistoryFile = { generatedAt: "", pools: { [A]: { at: 0, price: [[T0, 1]], volume: [[T0, 1]] } } };
    const m = net(() => ({ status: 429 }));
    old.pools[A].at = m.now() - REFRESH_MS - 1;
    const r2 = await refreshHistory({ hot: { rows: [row(A)] }, previous: old, fetch: m.fetch, now: m.now, sleep: m.sleep });
    assert.equal(r2.failed, 1);
    assert.equal(r2.file.pools[A], old.pools[A], "the last good read stays");
    const e = net(() => new Error("offline"));
    old.pools[A].at = e.now() - KEEP_MS - 1;
    const r3 = await refreshHistory({ hot: { rows: [row(A)] }, previous: old, fetch: e.fetch, now: e.now, sleep: e.sleep });
    assert.equal(r3.failed, 1);
    assert.equal(r3.file.pools[A], undefined, "too old to keep");
  });

  await test("a pool read within REFRESH_MS is kept unread; one that left the board stays KEEP_MS", async () => {
    const n = net((u) => ok(u));
    const fresh = { at: n.now() - REFRESH_MS + 60_000, price: [[T0, 1]] as [number, number][], volume: [[T0, 1]] as [number, number][] };
    const gone = { ...fresh, at: n.now() - KEEP_MS + 60_000 };
    const stale = { ...fresh, at: n.now() - KEEP_MS - 1 };
    const prev: HistoryFile = { generatedAt: "", pools: { [A]: fresh, [C]: gone, ["Gone11111111111111111111111111111111"]: stale } };
    const r = await refreshHistory({ hot: { rows: [row(A), row(B)] }, previous: prev, fetch: n.fetch, now: n.now, sleep: n.sleep });
    assert.equal(r.kept, 1);
    assert.equal(r.read, 1);
    assert.ok(n.calls.every((c) => !c.url.includes(A)), "A not read");
    assert.equal(r.file.pools[A], fresh);
    assert.equal(r.file.pools[C], gone, "off the board, still kept");
    assert.equal(Object.keys(r.file.pools).length, 3, "the stale one is dropped");
  });

  await test("the pass stops at BUDGET_MS: pools it did not reach keep what they had", async () => {
    const D = "7iqWWNjuHDqbiTTkPn8ahDMbWWtChBjmYPNZNYRUA8Ah";
    const n = net((u) => {
      n.advance(25_000); // a slow network (a real read gives up at 10 s)
      return ok(u);
    });
    const rows = [A, B, C, D].map((a) => row(a));
    const prev: HistoryFile = { generatedAt: "", pools: { [D]: { at: n.now() - REFRESH_MS - 1, price: [[T0, 1]], volume: [[T0, 1]] } } };
    const t0 = n.now();
    const r = await refreshHistory({ hot: { rows }, previous: prev, fetch: n.fetch, now: n.now, sleep: n.sleep });
    assert.equal(r.read, 3);
    assert.equal(r.skipped, 1);
    assert.ok(n.now() - t0 < BUDGET_MS + 60_000, "a pool begun before the budget may finish, no more");
    assert.equal(r.file.pools[D], prev.pools[D], "the one it did not reach keeps its last read");
  });

  await test("never throws: a bad board or garbage answers leave an empty or unchanged file", async () => {
    const n = net(() => ({ status: 200, json: { nonsense: true } }));
    const r = await refreshHistory({ hot: "junk", previous: null, fetch: n.fetch, now: n.now, sleep: n.sleep });
    assert.deepEqual(r.file.pools, {});
    const g = await refreshHistory({ hot: HOT, previous: null, fetch: n.fetch, now: n.now, sleep: n.sleep });
    assert.equal(g.failed, 3);
    assert.deepEqual(g.file.pools, {});
  });

  await test("the file round-trips on disk, and a missing or broken one reads as null", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-"));
    const f = path.join(dir, "public", "history.json");
    assert.equal(loadHistoryFile(f), null);
    const h: HistoryFile = { generatedAt: "2026-09-24T16:00:00.000Z", pools: { [A]: { at: 1, price: [[T0, 1]], volume: [[T0, 2]] } } };
    writeHistoryFile(f, h);
    assert.deepEqual(loadHistoryFile(f), h);
    fs.writeFileSync(f, "{broken");
    assert.equal(loadHistoryFile(f), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log(`\ngame history: ${passed} passed`);
})();
