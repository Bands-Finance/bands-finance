/**
 * THE AUTO BUILD LOG (Zach, 22 Sep: "increase his presence more and more regarding building in public"). Every commit
 * on the branch the desk runs becomes build-ledger material without anyone writing a row: commits are grouped by UTC
 * day and area into one row each ("auto-<yyyymmdd>-<area>"), appended to TALK_STATE_PATH/build.jsonl, and the builder
 * voice's BUILD moments (src/talk/moments.ts) pick them up like any other row; his model words the post.
 *
 * Private by construction: an area that is private (the launch, keys, config, the token) or a subject that names
 * anything private (security, secrets, keys, the token, a mint, pricing, the copycat, a person) never becomes a row.
 * Merges are skipped (their branches' commits carry the work). The cursor (the newest commit read) lives in
 * TALK_STATE_PATH/build-auto.json, so each commit is read once. Never throws: git missing or a torn file is a note.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BUILD_FILE } from "./buildLedger";

export const AUTO_STATE_FILE = "build-auto.json";
/** the most subjects one row carries; the rest are counted */
export const MAX_SUBJECTS = 3;

/** what each code area means to someone outside; an area missing here is private ("desk" is: it names both his trading desk and the site's 3D desk) */
export const AREA_WORDS: Record<string, string> = {
  talk: "how I post on X",
  paper: "my paper book",
  "paper report": "my paper book's report",
  site: "my site",
  web: "my site",
  agent: "how I make decisions",
  model: "my model setup",
  engine: "my exits and breakers",
  risk: "my guards",
  screener: "my pool screener",
  hot: "my hot-pool watch",
  flow: "my flow scout",
  scouts: "my flow scout",
  learn: "what I learn from my trades",
  learning: "what I learn from my trades",
  openhermit: "OpenHermit, the agentic runtime I run on",
  platform: "my platform",
  snapshot: "what my site shows",
  publish: "what my site shows",
};

/** a subject naming any of these never becomes a row */
export const PRIVATE_RE =
  /token|mint|clawpump|launch|\bkey|secret|credential|password|security|rotat|copycat|zach|louz|meridian|\bmerd|pricing|x402|wallet|bridge|\barm\b|\.env|env var|admin|opus|claude|anthropic|openrouter|gemini|sonnet|haiku|\$[a-z]|\b[a-z][a-z0-9_]{3,}=/i;

export interface CommitLine {
  sha: string;
  /** epoch ms, the commit date */
  at: number;
  subject: string;
}

export interface AutoRow {
  id: string;
  at: string;
  kind: "shipped";
  public: true;
  text: string;
  source: string;
}

/** "talk: the builder voice" -> { area: "talk", what: "the builder voice" }; no area prefix -> null. PURE. */
export function splitSubject(subject: string): { area: string; what: string } | null {
  const m = /^([a-z][a-z0-9 +-]{1,24}):\s+(.+)$/i.exec(subject.trim());
  if (!m) return null;
  const area = m[1].toLowerCase().split("+")[0].trim();
  return { area, what: m[2].trim() };
}

/**
 * PURE. Commits into rows: one per UTC day and public area, its text a plain line an outsider can read ("On 22 Sep
 * I changed how I post on X: ...; ...; and 2 more changes."). Private areas, private subjects and merges are dropped.
 */
export function rowsFromCommits(commits: readonly CommitLine[]): AutoRow[] {
  const groups = new Map<string, { day: string; area: string; whats: string[]; shas: string[] }>();
  for (const c of commits) {
    if (/^merge\b/i.test(c.subject) || PRIVATE_RE.test(c.subject)) continue;
    const s = splitSubject(c.subject);
    if (!s || !AREA_WORDS[s.area]) continue;
    const day = new Date(c.at).toISOString().slice(0, 10);
    const key = `${day}|${s.area}`;
    const g = groups.get(key) ?? { day, area: s.area, whats: [], shas: [] };
    g.whats.push(s.what.replace(/\s+/g, " ").replace(/[.;]+$/, ""));
    g.shas.push(c.sha.slice(0, 7));
    groups.set(key, g);
  }
  const out: AutoRow[] = [];
  for (const g of groups.values()) {
    const shown = g.whats.slice(0, MAX_SUBJECTS);
    const more = g.whats.length - shown.length;
    const date = new Date(`${g.day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
    let text = `On ${date} I changed ${AREA_WORDS[g.area]}: ${shown.join("; ")}${more > 0 ? `; and ${more} more change${more === 1 ? "" : "s"}` : ""}.`;
    if (text.length > 400) text = `${text.slice(0, 396).replace(/[;,:\s]+\S*$/, "")}...`;
    out.push({ id: `auto-${g.day.replace(/-/g, "")}-${g.area.replace(/[^a-z0-9]+/g, "-")}`.slice(0, 48), at: g.day, kind: "shipped", public: true, text, source: `git ${g.shas.join(", ")}` });
  }
  return out;
}

/** The commits after `since` (exclusive) on HEAD, oldest first, merges excluded; [] when git is not there. */
export function readCommits(cwd: string, since: string | null, maxCount = 200, ownOnly = false): CommitLine[] {
  try {
    const range = since ? [`${since}..HEAD`] : ["--since=7 days ago", "HEAD"];
    let author: string[] = [];
    if (ownOnly) {
      const email = execFileSync("git", ["config", "user.email"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (!email) return [];
      author = [`--author=${email}`];
    }
    const out = execFileSync("git", ["log", "--no-merges", "--reverse", `--max-count=${maxCount}`, ...author, "--pretty=%H%x09%cI%x09%s", ...range], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, iso, ...rest] = l.split("\t");
        return { sha, at: Date.parse(iso), subject: rest.join("\t") };
      })
      .filter((c) => c.sha && Number.isFinite(c.at));
  } catch {
    return [];
  }
}

/**
 * Read the commits since the cursor and append the new rows to TALK_STATE_PATH/build.jsonl (a row whose id is already
 * there is left alone). Returns what it did, for the tick's log. Never throws.
 */
export function syncAutoBuild(o: { cwd: string; statePath: string; runtimeRepo?: string | null }): { added: string[]; note: string | null } {
  try {
    const stateFile = path.join(o.statePath, AUTO_STATE_FILE);
    let state: { lastCommit?: string; lastRuntimeCommit?: string } = {};
    try {
      state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as typeof state;
    } catch {
      state = {};
    }
    const commits = readCommits(o.cwd, state.lastCommit ?? null);
    // his own work on the runtime he runs on (TALK_RUNTIME_REPO): only this machine's author, never upstream's history
    const runtime = o.runtimeRepo ? readCommits(o.runtimeRepo, state.lastRuntimeCommit ?? null, 200, true) : [];
    const runtimeAsArea = runtime.map((c) => ({ ...c, subject: `openhermit: ${c.subject.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "")}` }));
    if (!commits.length && !runtime.length) return { added: [], note: null };
    const buildFile = path.join(o.statePath, BUILD_FILE);
    let existing = "";
    try {
      existing = fs.readFileSync(buildFile, "utf8");
    } catch {
      existing = "";
    }
    const have = new Set(
      existing
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return (JSON.parse(l) as { id?: string }).id ?? "";
          } catch {
            return "";
          }
        }),
    );
    const rows = rowsFromCommits([...commits, ...runtimeAsArea]).filter((r) => !have.has(r.id));
    fs.mkdirSync(o.statePath, { recursive: true });
    if (rows.length) fs.appendFileSync(buildFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const next = {
      lastCommit: commits.length ? commits[commits.length - 1].sha : state.lastCommit,
      lastRuntimeCommit: runtime.length ? runtime[runtime.length - 1].sha : state.lastRuntimeCommit,
      at: new Date().toISOString(),
    };
    fs.writeFileSync(stateFile, JSON.stringify(next) + "\n");
    return { added: rows.map((r) => r.id), note: null };
  } catch (err) {
    return { added: [], note: `auto build log: ${(err as Error).message}` };
  }
}
