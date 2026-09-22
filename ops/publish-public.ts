/**
 * THE PUBLIC COPY (Zach, 22 Sep: "lets make the bands finance github public", as a clean copy). This repo stays
 * private; this script publishes a scrubbed snapshot of main to a separate public repo in the organization, one commit
 * authored by Mr Bands per publish:
 *
 *   npx tsx ops/publish-public.ts            build the snapshot, check it, and print what would change (no push)
 *   npx tsx ops/publish-public.ts --push     the same, then commit and push it to the public repo
 *
 * What goes out: the tracked files of main, minus PRIVATE_PATHS (all of docs/ and ops/, fixtures holding other
 * people's posts, the site's data snapshots). Every text file is scrubbed (SCRUB): the architect's name, handles and
 * emails, the other project, the copycat's mint, this Mac's paths. Then it fails closed: any FORBIDDEN term left,
 * or any gitleaks finding, and nothing is pushed. This file lives in ops/, so its word list never goes public.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(__dirname, "..");
const PUBLIC_REPO = process.env.PUBLIC_REPO ?? "Bands-Finance/mr-bands";
const AUTHOR = "Mr Bands <bands@mrbands.finance>";
const COPYCAT = "JAARLUawF9DTauc9pHUyYpga8mDU3172cY7NzLfhpJ6m";
const COPYCAT_PLACEHOLDER = "CopycatMint111111111111111111111111111111111";

/** paths (prefixes) that never go out */
const PRIVATE_PATHS = ["docs/", "ops/", "src/scripts/fixtures/x-mentions-response.json", ".claude/"];
/** site data snapshots (the sites fetch these live; the copy needs none of them) */
const PRIVATE_FILE_RE = /^web\/public\/(journal|screen|hot|live-run|learned|status|feed|flow|equity|record|lessons)[^/]*\.(json|md|jsonl)$/;

/** replacements, in order (longest first where they overlap) */
const SCRUB: [RegExp, string][] = [
  [/\/Users\/zach\/Bands\.Finance\/mr-bands/g, "."],
  [/\/Users\/zach\/[^\s"'`)]*/g, "<path>"],
  [/\/Users\/zach/g, "~"],
  [/[\w.+-]+@gmail\.com/g, "<email>"],
  [/Zach Loubert/g, "the architect"],
  [/zachary/gi, "alexander"],
  [/@?ZachL_93/g, "@architect_x"],
  [/Zach's/g, "the architect's"],
  [/\bZach\b/g, "the architect"],
  [/\bzach\b/gi, "architect"],
  [/loubert/gi, "alexson"],
  [/louznft[\w-]*/gi, "operator"],
  [/@?louz514/gi, "operator"],
  [/\blouz\w*/gi, "alexq"],
  // the catch-all: inside a guard's own pattern (/\bzach|.../) there is no word boundary to match on
  [/zach/gi, "architect"],
  [/Meridian's/g, "an earlier project's"],
  [/Meridian(?=[A-Z])/g, "Earlier"],
  [/\bMeridian\b/g, "an earlier project"],
  [/meridian402\.xyz/g, "example.com"],
  [/meridian/gi, "horizon"],
  [/\bMERD\b/g, "EARLIER"],
  [/\bMerd's/g, "an earlier agent's"],
  [/\bMerd\b/g, "an earlier agent"],
  [/\bmerd\b/g, "earlier-agent"],
  [new RegExp(COPYCAT, "g"), COPYCAT_PLACEHOLDER],
  [/JAARLU[\w.…]*/g, "CopycatMint1"],
];

/** nothing matching these may remain in the copy */
const FORBIDDEN: RegExp[] = [/zach/i, /loubert/i, /louz/i, /meridian/i, /\bmerd\b/i, /JAARLU/, /\/Users\//, /@gmail\.com/i, /sk-or-v1-/, /\bcpk_(?!test|TESTONLY)[A-Za-z0-9_-]{20,}/i, /BEGIN [A-Z ]*PRIVATE KEY/];

const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|css|html|txt|yml|yaml|toml|sh|svg|jsonl|example|gitignore|dockerignore)$|^(Dockerfile|\.gitignore|\.dockerignore|\.env\.example|\.env\.platform\.example)$/;

function sh(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

function main(): void {
  const push = process.argv.includes("--push");
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "mrbands-public-"));
  const tree = path.join(stage, "tree");
  fs.mkdirSync(tree);
  // the tracked files of main, exactly
  const files = sh("git", ["ls-tree", "-r", "--name-only", "main"], REPO).split("\n").filter(Boolean);
  const kept = files.filter((f) => !PRIVATE_PATHS.some((p) => f === p || f.startsWith(p)) && !PRIVATE_FILE_RE.test(f));
  for (const f of kept) {
    const buf = execFileSync("git", ["show", `main:${f}`], { cwd: REPO, maxBuffer: 256 * 1024 * 1024 });
    const dest = path.join(tree, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (TEXT_EXT.test(path.basename(f)) || TEXT_EXT.test(f)) {
      let s = buf.toString("utf8");
      for (const [re, to] of SCRUB) s = s.replace(re, to);
      fs.writeFileSync(dest, s);
    } else fs.writeFileSync(dest, buf);
  }
  // fail closed: any forbidden term in any file, or in a file name
  const leaks: string[] = [];
  for (const f of kept) {
    if (FORBIDDEN.some((re) => re.test(f))) leaks.push(`file name: ${f}`);
    const p = path.join(tree, f);
    if (!(TEXT_EXT.test(path.basename(f)) || TEXT_EXT.test(f))) continue;
    const s = fs.readFileSync(p, "utf8");
    for (const re of FORBIDDEN) {
      const m = re.exec(s);
      if (m) leaks.push(`${f}: ${re} near "${s.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\s+/g, " ")}"`);
    }
  }
  let gitleaks = "";
  try {
    sh("gitleaks", ["dir", tree, "--no-banner", "--redact", "--exit-code", "3"], stage);
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    if (e.status === 3) gitleaks = `${e.stdout ?? ""}${e.stderr ?? ""}`.split("\n").filter((l) => /leaks found|Finding|File/.test(l)).join("\n");
    else gitleaks = `gitleaks could not run: ${e.stderr ?? err}`;
  }
  console.log(`public copy: ${kept.length} of ${files.length} tracked files, staged at ${tree}`);
  console.log(`left out: ${files.length - kept.length} files (docs/, ops/, other people's posts, the site's data snapshots)`);
  if (leaks.length) {
    console.log(`REFUSED: ${leaks.length} private term(s) left:\n  ${leaks.slice(0, 40).join("\n  ")}`);
    process.exit(1);
  }
  if (gitleaks) {
    console.log(`REFUSED: gitleaks:\n${gitleaks}`);
    process.exit(1);
  }
  console.log("checks: no private term left, gitleaks clean");
  if (!push) {
    console.log("dry run: nothing pushed (add --push)");
    return;
  }
  // the public repo: clone (or start it), replace its tree with the snapshot, commit as Mr Bands, push
  const pub = path.join(stage, "public");
  try {
    sh("gh", ["repo", "clone", PUBLIC_REPO, pub, "--", "--depth", "1"], stage);
  } catch {
    fs.mkdirSync(pub);
    sh("git", ["init", "-b", "main"], pub);
    sh("git", ["remote", "add", "origin", `https://github.com/${PUBLIC_REPO}.git`], pub);
  }
  for (const name of fs.readdirSync(pub)) if (name !== ".git") fs.rmSync(path.join(pub, name), { recursive: true, force: true });
  fs.cpSync(tree, pub, { recursive: true });
  sh("git", ["add", "-A"], pub);
  const changed = sh("git", ["status", "--porcelain"], pub).trim();
  if (!changed) {
    console.log("the public copy is already up to date");
    return;
  }
  const head = sh("git", ["rev-parse", "--short", "main"], REPO).trim();
  sh("git", ["-c", "user.name=Mr Bands", "-c", "user.email=bands@mrbands.finance", "commit", "-q", "--author", AUTHOR, "-m", `Snapshot of Mr Bands at ${head}\n\nPublished from the working repo, scrubbed and checked.`], pub);
  sh("git", ["push", "-q", "origin", "HEAD:main"], pub);
  console.log(`pushed the public copy to github.com/${PUBLIC_REPO}`);
}

main();
