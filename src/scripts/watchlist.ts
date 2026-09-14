/**
 * The desk's menu and the operator's list.
 *
 *   npm run watchlist                      the board's best pools by volume, with what is on the list
 *   npm run watchlist -- add SPYx          let the desk enter SPYx pools (mint recorded from the board)
 *   npm run watchlist -- remove SPYx       take it off the list
 *   npm run watchlist -- deny baton        never enter it, whatever the mode
 *   npm run watchlist -- on | off          "on" = only listed tokens may be entered
 *   npm run watchlist -- list              just the list
 *   flags: --min-vol 1000000  --rows 25  --quote SOL|USDC  --stocks
 *
 * Reads DATA_DIR/screen.json, writes DATA_DIR/watchlist.json. Nothing here touches money.
 */
import { config } from "../config";
import { loadScreen, tradableVenue } from "../screener";
import type { ScreenedPool } from "../screener/types";
import { addToken, denyToken, loadWatchlist, removeToken, saveWatchlist, watchEntry, watchlistRefusal, type Watchlist } from "../screener/watchlist";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name: string) => args.includes(`--${name}`);
const cmd = (args[0] && !args[0].startsWith("--") ? args[0] : "board").toLowerCase();
const target = args[1] && !args[1].startsWith("--") ? args[1] : "";

const usd = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? "n/a" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${n.toFixed(0)}`;
const pct = (n: number | null | undefined, d = 2) => (n === null || n === undefined || !Number.isFinite(n) ? "n/a" : `${n.toFixed(d)}%`);
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const rpad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s);
const ageLabel = (h: number | null | undefined) => (h === null || h === undefined ? "n/a" : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);

function printList(w: Watchlist): void {
  console.log(`\nWATCHLIST  mode ${w.mode === "allow" ? "ALLOW (only these tokens may be entered)" : "off (the list only denies)"}  ·  ${config.dataDir}/watchlist.json`);
  if (w.tokens.length === 0) console.log("  (no tokens listed)");
  for (const t of w.tokens) console.log(`  + ${pad(t.symbol, 12)} ${t.mint ? t.mint.slice(0, 8) + "…" : "".padEnd(9)}  added ${t.addedAt.slice(0, 16).replace("T", " ")}${t.note ? `  ${t.note}` : ""}`);
  if (w.deny.length) console.log(`  denied: ${w.deny.join(", ")}`);
  if (w.denyPools.length) console.log(`  denied pools: ${w.denyPools.map((p) => p.slice(0, 6)).join(", ")}`);
}

function board(w: Watchlist): void {
  const screen = loadScreen();
  if (!screen) {
    console.log("No screen yet: run `npm run screen` first.");
    return;
  }
  const minVol = Number(flag("min-vol", process.env.POLICY_MIN_VOLUME_24H_USD ?? "250000"));
  const rows = Number(flag("rows", "20"));
  const quote = flag("quote", "");
  const pools = screen.pools.filter(
    (p) =>
      tradableVenue(p) &&
      (p.volume24hUsd ?? 0) >= minVol &&
      (!quote || p.quoteSymbol === quote.toUpperCase()) &&
      (!has("stocks") || !!p.stock),
  );
  pools.sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
  const ageDays = (p: ScreenedPool) => (p.ageHours ?? 0) / 24;
  console.log(`\nTHE BOARD BY VOLUME  ·  screen ${screen.generatedAt.slice(0, 16).replace("T", " ")}  ·  ${pools.length} of ${screen.rankedPools} pools trade over ${usd(minVol)} a day on a venue the desk can use`);
  console.log(`  ${pad("", 3)} ${pad("pool", 18)} ${pad("venue", 9)} ${rpad("vol 24h", 9)} ${rpad("TVL", 9)} ${rpad("turn", 6)} ${rpad("fee/TVL", 8)} ${rpad("24h", 7)} ${rpad("age", 5)} ${rpad("score", 6)}  flags`);
  for (const p of pools.slice(0, rows)) {
    const on = watchlistRefusal(p, w) === null;
    const turn = (p.volume24hUsd ?? 0) / Math.max(p.tvlUsd ?? 1, 1);
    const venue = p.venue === "raydium-clmm" ? "Raydium" : p.venue === "orca-whirlpool" ? "Orca" : "Meteora";
    console.log(
      `  ${on ? " ✓ " : "   "} ${pad(p.name, 18)} ${pad(venue, 9)} ${rpad(usd(p.volume24hUsd), 9)} ${rpad(usd(p.tvlUsd), 9)} ${rpad(`${turn.toFixed(1)}x`, 6)} ${rpad(pct(p.feeToTvl24hPct), 8)} ${rpad(pct(p.priceChange24hPct, 1), 7)} ${rpad(ageLabel(p.ageHours), 5)} ${rpad(p.score.toFixed(1), 6)}  ${p.stock ? `${p.stock.ticker} · ` : ""}${p.flags.join(",") || "-"}`,
    );
  }
  console.log(`\n  ✓ = the desk may enter it today. Add one with: npm run watchlist -- add <symbol>`);
  console.log(`  turn = how many times the pool's money changed hands in a day. fee/TVL = what a dollar in the pool earned.`);
  printList(w);
}

function main(): void {
  let w = loadWatchlist();
  const screen = loadScreen();
  const findMint = (sym: string) => screen?.pools.find((p) => (p.baseSymbol ?? "").toLowerCase() === sym.toLowerCase())?.baseMint;

  switch (cmd) {
    case "board":
      board(w);
      return;
    case "list":
      printList(w);
      return;
    case "add": {
      if (!target) return console.log("which token? npm run watchlist -- add SPYx");
      const mint = findMint(target);
      w = addToken(w, { symbol: target, ...(mint ? { mint } : {}), ...(flag("note", "") ? { note: flag("note", "") } : {}) });
      saveWatchlist(w);
      console.log(`added ${target}${mint ? ` (${mint})` : " (no mint on the board yet: matched by symbol until it appears)"}`);
      printList(w);
      return;
    }
    case "remove": {
      if (!target) return console.log("which token? npm run watchlist -- remove SPYx");
      if (!watchEntry(w, target)) console.log(`${target} was not on the list`);
      w = removeToken(w, target);
      saveWatchlist(w);
      printList(w);
      return;
    }
    case "deny": {
      if (!target) return console.log("which token? npm run watchlist -- deny baton");
      w = denyToken(w, target);
      saveWatchlist(w);
      console.log(`${target} will never be entered`);
      printList(w);
      return;
    }
    case "on":
      w = { ...w, mode: "allow" };
      saveWatchlist(w);
      console.log(`allow mode ON: the desk may only open bands in the ${w.tokens.length} listed token(s). Open bands are still managed and can still be closed.`);
      printList(w);
      return;
    case "off":
      w = { ...w, mode: "off" };
      saveWatchlist(w);
      console.log("allow mode OFF: the desk may enter anything that passes the screener, the guards and the denies.");
      printList(w);
      return;
    default:
      console.log(`unknown command "${cmd}". Try: board | list | add <t> | remove <t> | deny <t> | on | off`);
  }
}

main();
