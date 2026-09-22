/**
 * Print the paper book: start, wallet, open and closed bands, fees, rent, equity vs start, and
 * the decision tally from the journal. Offline; reads DATA_DIR/paper-book.json and the journal.
 *   DATA_DIR=data-paper npm run paper:report
 *   npm run paper:report -- --json   the summary as JSON
 */
import { config } from "../config";
import { readLedgerRows } from "../engine/ledger";
import { readRecent } from "../journal";
import { loadPaperBook, paperBookFile, paperSummary, renderPaperReport } from "../paper";

function main(): void {
  const book = loadPaperBook();
  if (!book) {
    console.log(`no paper book at ${paperBookFile()} (DATA_DIR=${config.dataDir}). Start one with: PAPER_SOL=100 DATA_DIR=${config.dataDir} npm run once`);
    process.exit(1);
  }
  const summary = paperSummary(book, readRecent(5000), Date.now(), readLedgerRows());
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(renderPaperReport(summary));
}

main();
