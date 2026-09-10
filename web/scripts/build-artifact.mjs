/**
 * Inline the Vite build into a single HTML fragment with demo data embedded,
 * suitable for publishing as a standalone preview (no API needed).
 *   node scripts/build-artifact.mjs ../data/decisions.jsonl ../data/limits.json out.html
 */
import fs from "node:fs";
import path from "node:path";

const [jsonl, limitsFile, out] = process.argv.slice(2);
const dist = path.resolve("dist");
let html = fs.readFileSync(path.join(dist, "index.html"), "utf8");

html = html.replace(/<script type="module"[^>]*src="\/?(assets\/[^"]+)"[^>]*><\/script>/g, (_, src) => `<script type="module">${fs.readFileSync(path.join(dist, src), "utf8")}</script>`);
html = html.replace(/<link rel="stylesheet"[^>]*href="\/?(assets\/[^"]+)"[^>]*>/g, (_, href) => `<style>${fs.readFileSync(path.join(dist, href), "utf8")}</style>`);
html = html.replace(/<link rel="modulepreload"[^>]*>/g, "");

const entries = fs.readFileSync(jsonl, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).reverse();
const limits = limitsFile && fs.existsSync(limitsFile) ? JSON.parse(fs.readFileSync(limitsFile, "utf8")) : null;
const data = JSON.stringify({ entries, limits, demo: true }).replace(/<\//g, "<\\/");
html = html.replace("<div id=\"root\"></div>", `<script>window.__BANDS_DATA__=${data};</script>\n<div id="root"></div>`);

// The artifact host supplies the document skeleton; keep title, fonts, styles, body content.
const head = html.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? "";
const body = html.match(/<body>([\s\S]*?)<\/body>/)?.[1] ?? html;
const keep = head
  .split("\n")
  .filter((l) => /<title>|<link rel="stylesheet"|<link rel="preconnect"|<style>|<\/style>/.test(l) || l.trim().startsWith("<style") || !/<meta|<script type="module" crossorigin src/.test(l))
  .join("\n");
fs.writeFileSync(out, `${keep}\n${body}`);
console.log(`wrote ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB, ${entries.length} entries)`);
