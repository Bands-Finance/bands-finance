import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../config";
import { fetchPoolHistory } from "../screener/memeHistory";
async function main() {
  const c = new Connection(config.rpcUrl, "confirmed");
  for (const addr of process.argv.slice(2)) {
    const pk = new PublicKey(addr);
    const t0 = Date.now();
    const page = await c.getSignaturesForAddress(pk, { limit: 1000 }, "confirmed");
    const ok = page.filter((s) => !s.err).length;
    const times = page.map((s) => s.blockTime ?? 0).filter(Boolean); if (!times.length) { console.log(`${addr.slice(0, 6)}: page1 ${page.length} sigs, no block times`); continue; }
    console.log(`${addr.slice(0, 6)}: page1 ${page.length} sigs, ${ok} ok, span ${new Date(Math.min(...times) * 1000).toISOString().slice(11, 19)}..${new Date(Math.max(...times) * 1000).toISOString().slice(11, 19)}Z (${Math.round((Date.now() - t0))}ms)`);
    const t1 = Date.now();
    const rec = await fetchPoolHistory(addr, 3, { connection: c, address: pk, minTxPerDay: 50, maxPages: 40 });
    console.log(`  history: ${JSON.stringify(rec.metrics)} err=${rec.error} (${Math.round(Date.now() - t1)}ms)`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
