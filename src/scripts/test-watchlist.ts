/**
 * Watchlist tests: pure, no files touched outside a temp dir, no network.
 *   npm run test:watchlist
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addToken, denyToken, emptyWatchlist, loadWatchlist, removeToken, saveWatchlist, watchEntry, watchlistRefusal, type Watchlist } from "../screener/watchlist";

let n = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    n++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}\n     ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

const pool = (over: Partial<{ address: string; baseSymbol: string; baseMint: string; name: string }> = {}) => ({
  address: "poolA",
  baseSymbol: "SPYx",
  baseMint: "XsoCS1TfX1",
  name: "SPYx / USDC",
  ...over,
});

test("mode off: everything passes unless it is denied", () => {
  const w = emptyWatchlist();
  assert.equal(watchlistRefusal(pool(), w), null);
  const denied = denyToken(w, "SPYx");
  assert.match(watchlistRefusal(pool(), denied)!, /SPYx is denied/);
  // a deny is case-insensitive on the symbol and exact on the mint
  assert.match(watchlistRefusal(pool(), denyToken(w, "spyx"))!, /denied/);
  assert.match(watchlistRefusal(pool(), denyToken(w, "XsoCS1TfX1"))!, /denied/);
  assert.equal(watchlistRefusal(pool({ baseSymbol: "NVDAx", baseMint: "other" }), denied), null);
});

test("mode allow: only listed tokens pass, by symbol or by mint", () => {
  let w: Watchlist = { ...emptyWatchlist(), mode: "allow" };
  assert.match(watchlistRefusal(pool(), w)!, /not on the watchlist \(mode allow: 0 token\(s\) listed\)/);
  w = addToken(w, { symbol: "SPYx" });
  assert.equal(watchlistRefusal(pool(), w), null);
  assert.match(watchlistRefusal(pool({ baseSymbol: "baton", baseMint: "b" }), w)!, /not on the watchlist/);
  // a squatted symbol does not get in when the list pinned a mint
  let byMint: Watchlist = { ...emptyWatchlist(), mode: "allow" };
  byMint = addToken(byMint, { symbol: "SPYx", mint: "XsoCS1TfX1" });
  assert.equal(watchlistRefusal(pool(), byMint), null);
  assert.equal(watchlistRefusal(pool({ baseSymbol: "SPYx", baseMint: "XsoCS1TfX1" }), byMint), null);
});

test("denied pools are refused whatever the mode or the token", () => {
  let w = addToken({ ...emptyWatchlist(), mode: "allow" }, { symbol: "SPYx" });
  w = { ...w, denyPools: ["poolA"] };
  assert.match(watchlistRefusal(pool(), w)!, /denied pools/);
  assert.equal(watchlistRefusal(pool({ address: "poolB" }), w), null);
});

test("add is idempotent, records the mint, and clears a deny; remove takes it off without denying", () => {
  let w = denyToken(emptyWatchlist(), "SPYx");
  w = addToken(w, { symbol: "SPYx", mint: "XsoCS1TfX1", note: "the index" });
  assert.equal(w.tokens.length, 1);
  assert.equal(w.deny.length, 0, "adding a token clears its deny");
  assert.equal(watchEntry(w, "spyx")?.mint, "XsoCS1TfX1");
  assert.equal(watchEntry(w, "XsoCS1TfX1")?.note, "the index");
  w = addToken(w, { symbol: "SPYx", mint: "XsoCS1TfX1" });
  assert.equal(w.tokens.length, 1, "adding twice does not duplicate");
  w = removeToken(w, "SPYx");
  assert.equal(w.tokens.length, 0);
  assert.equal(w.deny.length, 0, "remove is not a deny");
  assert.equal(watchlistRefusal(pool(), w), null);
});

test("a file round trip keeps the list, and a missing or broken file is an empty list, never a throw", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bands-watch-"));
  const file = path.join(dir, "watchlist.json");
  assert.deepEqual(loadWatchlist(file).tokens, [], "missing file");
  let w = addToken({ ...emptyWatchlist(), mode: "allow" }, { symbol: "NVDAx", mint: "Xsc9qvGR" });
  w = denyToken(w, "baton");
  saveWatchlist(w, file);
  const back = loadWatchlist(file);
  assert.equal(back.mode, "allow");
  assert.equal(back.tokens[0].symbol, "NVDAx");
  assert.deepEqual(back.deny, ["baton"]);
  fs.writeFileSync(file, "{not json");
  assert.equal(loadWatchlist(file).mode, "off", "a broken file reads as an empty list");
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${n} watchlist tests passed`);
