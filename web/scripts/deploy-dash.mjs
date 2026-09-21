#!/usr/bin/env node
/**
 * Deploy the DASHBOARD site: the same web/ app built with VITE_SITE=dashboard, to its own Vercel
 * project. The project link lives in dash/.vercel/project.json (never committed): make it once with
 *   cd dash && vercel link --yes --project <project name>
 * Run from the repo root, after the snapshot:   npm run dash:deploy   (or `-- --preview` for a preview URL).
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const linkFile = path.join(root, "dash", ".vercel", "project.json");
if (!existsSync(linkFile)) {
  console.error(`deploy-dash: no project link at ${path.relative(root, linkFile)}; run: cd dash && vercel link --yes --project <name>`);
  process.exit(2);
}
const link = JSON.parse(readFileSync(linkFile, "utf8"));
if (!link.projectId || !link.orgId) {
  console.error("deploy-dash: the link file has no projectId/orgId");
  process.exit(2);
}
const preview = process.argv.includes("--preview");
// the live feed the desk uploads every cycle (src/publish/live.ts): baked in as VITE_LIVE_URL when the env names it
const liveUrl = (process.env.LIVE_FEED_URL ?? "").trim();
// the token's page and the X account are baked in the same way once they exist (site.ts reads them; the For-hire chapter links them)
const tokenUrl = (process.env.TOKEN_URL ?? "").trim();
const xUrl = (process.env.X_URL ?? "").trim();
const args = ["deploy", "--yes", "--build-env", "VITE_SITE=dashboard", ...(liveUrl ? ["--build-env", `VITE_LIVE_URL=${liveUrl}`] : []),
  ...(tokenUrl ? ["--build-env", `VITE_TOKEN_URL=${tokenUrl}`] : []), ...(xUrl ? ["--build-env", `VITE_X_URL=${xUrl}`] : []), preview ? "--target=preview" : "--prod"];
const r = spawnSync("vercel", args, {
  cwd: path.join(root, "web"),
  stdio: "inherit",
  env: { ...process.env, VERCEL_ORG_ID: link.orgId, VERCEL_PROJECT_ID: link.projectId },
});
process.exit(r.status ?? 1);
