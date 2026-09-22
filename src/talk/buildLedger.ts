/**
 * The build ledger (docs/talk.md, "The build ledger"): what he built, cut, fixed or got wrong, one plain line per
 * row, written for someone outside ("now true for someone outside"), never raw git. The builder voice's BUILD,
 * OWNED-MISS and PROMISE moments read it (src/talk/moments.ts); nothing else does.
 *
 *   ops/build.seed.jsonl         the seed: this week's real build history (git log since 17 Sep), in plain words,
 *                                checked against the commits and docs it cites; shipped with the code
 *   TALK_STATE_PATH/build.jsonl  rows Zach or a session append (`talk.ts build add`); a row here with a seed row's
 *                                id replaces it (to correct a line or flip `public`)
 *
 * A row:
 *   { "id": "stop-per-desk", "at": "2026-09-21", "kind": "miss", "public": true, "text": "...", "source": "git 8dbea27" }
 *   id        unique, [a-z0-9-]; the post key is build:<id>
 *   at        the day it became true (YYYY-MM-DD or ISO); a row older than 7 days is never a new post
 *   kind      shipped | cut | fix | rule | cost | miss | arc
 *   public    false keeps it out of every post (security, credentials, pricing, env, the token): the default
 *   text      one or two sentences, first person, sentence case; its numbers are the only numbers a post about it
 *             may print (they enter the facts block with `book`)
 *   book      the book its figures belong to: none (the default), paper or real
 *   promise   { "due": "YYYY-MM-DD" }: once posted, a promise the picker must close with a done or a slipped post
 *   resolves  the id of a promised row this row keeps (the "done" post)
 *
 * Reading never throws: a torn or malformed row is skipped and named in `problems`.
 */
import fs from "node:fs";
import path from "node:path";
import type { Book } from "./facts";

export const BUILD_FILE = "build.jsonl";
export const BUILD_SEED_FILE = path.join("ops", "build.seed.jsonl");
export const BUILD_KINDS = ["shipped", "cut", "fix", "rule", "cost", "miss", "arc"] as const;
export type BuildKind = (typeof BUILD_KINDS)[number];

export interface BuildRow {
  id: string;
  /** epoch ms of `at` */
  at: number;
  kind: BuildKind;
  public: boolean;
  text: string;
  book: Book;
  source: string;
  promise: { due: number } | null;
  resolves: string | null;
}

export interface BuildLedger {
  rows: BuildRow[];
  problems: string[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;

/** One row from JSON, or why not. */
export function parseBuildRow(raw: unknown): BuildRow | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "not an object";
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !ID_RE.test(o.id)) return "id must be 2-48 characters of a-z, 0-9 and -";
  const at = typeof o.at === "string" ? Date.parse(o.at) : NaN;
  if (!Number.isFinite(at)) return `${o.id}: at is not a date`;
  const kind = (typeof o.kind === "string" ? o.kind : "shipped") as BuildKind;
  if (!(BUILD_KINDS as readonly string[]).includes(kind)) return `${o.id}: kind must be ${BUILD_KINDS.join(", ")}`;
  if (typeof o.text !== "string" || o.text.trim().length < 10 || o.text.length > 400) return `${o.id}: text must be 10-400 characters`;
  const book = (o.book ?? "none") as Book;
  if (!["none", "paper", "real"].includes(book)) return `${o.id}: book must be none, paper or real`;
  let promise: BuildRow["promise"] = null;
  if (o.promise !== undefined && o.promise !== null) {
    const due = typeof (o.promise as { due?: unknown }).due === "string" ? Date.parse((o.promise as { due: string }).due) : NaN;
    if (!Number.isFinite(due)) return `${o.id}: promise.due is not a date`;
    promise = { due };
  }
  if (o.resolves !== undefined && o.resolves !== null && (typeof o.resolves !== "string" || !ID_RE.test(o.resolves))) return `${o.id}: resolves must be a row id`;
  return { id: o.id, at, kind, public: o.public === true, text: o.text.trim(), book, source: typeof o.source === "string" ? o.source : "", promise, resolves: typeof o.resolves === "string" ? o.resolves : null };
}

function readRows(file: string, label: string, problems: string[]): BuildRow[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`${label}: ${(err as Error).message.slice(0, 80)}`);
    return [];
  }
  const rows: BuildRow[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      problems.push(`${label} line ${i + 1}: not json`);
      return;
    }
    const r = parseBuildRow(raw);
    if (typeof r === "string") problems.push(`${label} line ${i + 1}: ${r}`);
    else rows.push(r);
  });
  return rows;
}

/** The seed, then the state file's rows (a later row with the same id replaces the earlier), oldest first. */
export function readBuildLedger(statePath: string, repoRoot: string = process.cwd()): BuildLedger {
  const problems: string[] = [];
  const byId = new Map<string, BuildRow>();
  for (const r of readRows(path.join(repoRoot, BUILD_SEED_FILE), BUILD_SEED_FILE, problems)) byId.set(r.id, r);
  for (const r of readRows(path.join(statePath, BUILD_FILE), BUILD_FILE, problems)) byId.set(r.id, r);
  return { rows: [...byId.values()].sort((a, b) => a.at - b.at), problems };
}

/** Append one row to TALK_STATE_PATH/build.jsonl after checking it. Returns the problem, or null. */
export function appendBuildRow(statePath: string, raw: Record<string, unknown>): string | null {
  const r = parseBuildRow(raw);
  if (typeof r === "string") return r;
  fs.mkdirSync(statePath, { recursive: true });
  fs.appendFileSync(path.join(statePath, BUILD_FILE), JSON.stringify(raw) + "\n");
  return null;
}
