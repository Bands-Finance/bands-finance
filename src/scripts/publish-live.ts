/**
 * Upload the live feed once, by hand:  DATA_DIR=data-mainnet npm run live:publish
 * Prints the public URL (the sites' VITE_LIVE_URL).
 */
import "dotenv/config";
import { config } from "../config";
import { buildLiveFeed, liveFeedOn, publishLiveFeed } from "../publish/live";

async function main() {
  if (!liveFeedOn()) throw new Error("BLOB_READ_WRITE_TOKEN is not set (or LIVE_FEED=false)");
  const feed = buildLiveFeed();
  const out = await publishLiveFeed(feed);
  console.log(`live feed: ${feed.entries.length} entries, ${feed.points.length} equity points from DATA_DIR=${config.dataDir} -> ${out.url} (${Math.round(out.bytes / 1024)} KB)`);
}
main().catch((err) => {
  console.error(`live feed failed: ${(err as Error).message}`);
  process.exit(1);
});
