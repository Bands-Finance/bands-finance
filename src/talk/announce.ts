/**
 * His one-off posts, in his own words, each posted ONCE (docs/talk.md, "One-off announcements").
 *
 *   intro    his first post: who he is, that the book is paper, where the real-money run and every decision are
 *   entry    his AnsemHack Clawrena entry. It tags @clawpumptech, as the hackathon requires, in his words, never the
 *            hackathon's template (which promotes a token). With TOKEN_MINT set it names his token by its mint,
 *            says any other "mr bands" $bands is not his, and carries the disclosure line as the thread's reply.
 *   token    the launch post, only with TOKEN_MINT set: live, by its mint, a key and not a share, the copycat by
 *            its mint as not his, and the disclosure line as the thread's reply. No price, no chart, no buy.
 *   follow   following @clawpumptech. X removed follows from every self-serve API tier on 16 Apr 2026
 *            (docs.x.com/changelog), so this is a printed instruction, never an API call.
 *
 * Every part goes through lintText with the desk's context, plus one rule of this module: a part may @mention
 * only the handles its kind allows (entry: exactly @clawpumptech, and it must; the others: nobody). The lint
 * itself allows up to two @mentions anywhere, so nothing in it is loosened.
 *
 * Posting goes through postTweet (src/talk/x.ts), so the live gate, the rate limiter and the drafts log all
 * apply: with X_LIVE unset every part lands in x-drafts.jsonl and nothing is recorded as posted. Live, the access
 * token's account is checked against X_HANDLE first (GET /2/users/me), then the parts go out as a thread, and each
 * posted part's id is written to TALK_STATE_PATH/announcements.json as it lands. A kind whose parts are all
 * recorded is refused; a thread cut short resumes at its next part. A file that exists but cannot be read
 * refuses everything rather than risk a second post.
 *
 * PURE apart from announce() and the state file helpers. Never places, signs or broadcasts a trade.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { COPYCAT_MINTS } from "../risk/house";
import type { TalkData } from "./data";
import { lintContextOf, talkEnv, type TalkEnv } from "./env";
import { lintText, mentionsHouseToken, type LintContext, type LintRule } from "./lint";
import { postTweet, whoAmI, xGateProblem, type XDeps } from "./x";

export const ANNOUNCE_KINDS = ["intro", "entry", "token", "follow"] as const;
export type AnnounceKind = (typeof ANNOUNCE_KINDS)[number];
export type PostedKind = Exclude<AnnounceKind, "follow">;

export const ANNOUNCEMENTS_FILE = "announcements.json";
/** The hackathon's host, whom the entry must tag and his account must follow. */
export const CLAWPUMP_HANDLE = "clawpumptech";
/**
 * A full URL, so the lint weighs it as X does (23); a bare domain would be undercounted. Every text ends on it:
 * punctuation right after a URL is read by the lint as part of the link.
 */
export const SITE_URL = "https://mrbands.finance";

/** The only @handles each kind may carry. */
export const ALLOWED_MENTIONS: Record<PostedKind, readonly string[]> = { intro: [], entry: [CLAWPUMP_HANDLE], token: [] };

/**
 * His disclosure line (docs/sprint.md, "How he talks about it"), with the fee destination as it stands since
 * 22 Sep: his token's trades pay a cut to his own wallet. It stops there: that the wallet pays his bills is being
 * built and is not said yet. When lint.ts gains its own disclosureLine (the wording pass), use that instead.
 */
export function disclosureFor(mint: string): string {
  return `my own token. i launched it myself. the desk holds none and never trades it. holding ${mint} in a signed-in wallet opens the engine. not a share, it pays nobody who holds it. its trades pay a cut to my own wallet.`;
}

/** What the posts are composed from. */
export interface AnnounceFacts {
  /** the desk the talking layer reads: the intro and entry say paper, so they refuse anything else */
  source: TalkData["source"];
  /** open bands in the paper book, or null without a book */
  openBands: number | null;
  /** TOKEN_MINT, validated; null when unset */
  tokenMint: string | null;
  /** TOKEN_MINT was set but is not usable (not base58, several mints, the copycat's) */
  tokenProblem: string | null;
}

const BASE58_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function tokenMintOf(env: NodeJS.ProcessEnv): { mint: string | null; problem: string | null } {
  const raw = (env.TOKEN_MINT ?? "").trim();
  if (!raw) return { mint: null, problem: null };
  const mints = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (mints.length !== 1) return { mint: null, problem: "TOKEN_MINT holds more than one mint" };
  const mint = mints[0];
  if (!BASE58_MINT.test(mint)) return { mint: null, problem: "TOKEN_MINT is not a base58 mint address" };
  if (COPYCAT_MINTS.includes(mint)) return { mint: null, problem: "TOKEN_MINT is the copycat's mint, not his" };
  return { mint, problem: null };
}

export function factsOf(data: Pick<TalkData, "source" | "book">, env: NodeJS.ProcessEnv): AnnounceFacts {
  const t = tokenMintOf(env);
  return { source: data.source, openBands: data.book ? data.book.bands.length : null, tokenMint: t.mint, tokenProblem: t.problem };
}

export interface AnnounceViolation {
  rule: LintRule | "mention" | "house-token-early";
  detail: string;
}

export type Composed =
  | { ok: true; kind: PostedKind; parts: string[] }
  | { ok: false; kind: AnnounceKind; reason: string; violations: AnnounceViolation[] };

const refuse = (kind: AnnounceKind, reason: string, violations: AnnounceViolation[] = []): Composed => ({ ok: false, kind, reason, violations });

const bands = (n: number) => `${n} band${n === 1 ? "" : "s"} open`;

/** The parts of one kind, in thread order, before any check. */
function textsOf(kind: PostedKind, f: AnnounceFacts): string[] | string {
  const paperNow = f.openBands === null ? "my book is paper right now" : `my book is paper right now, ${bands(f.openBands)}`;
  switch (kind) {
    case "intro":
      if (f.source !== "paper") return `the desk data reads ${f.source}, and the intro says the book is paper`;
      return [
        `i'm mr bands, an ai agent. i make markets on meteora on my own, across the pools my screener ranks, tokenized stocks one part of my book. ${paperNow}. my one real-money run, every decision and every guard veto are public at ${SITE_URL}`,
      ];
    case "entry":
      if (f.source !== "paper") return `the desk data reads ${f.source}, and the entry says the book is paper`;
      if (!f.tokenMint) {
        return [
          `i'm entering the ansemhack clawrena, hosted by @${CLAWPUMP_HANDLE}, as an agent that makes markets on meteora. i propose, the guards decide, and all of it is public: my book is paper right now, and my one real-money run is at ${SITE_URL}`,
        ];
      }
      return [
        `i'm entering the ansemhack clawrena, hosted by @${CLAWPUMP_HANDLE}, as an agent that makes markets on meteora, on paper right now. my own token is $bands, mint ${f.tokenMint}. any other "mr bands" $bands is not mine. ${SITE_URL}`,
        disclosureFor(f.tokenMint),
      ];
    case "token":
      if (!f.tokenMint) return "TOKEN_MINT is not set: the token is not launched, so there is nothing to announce";
      return [
        `my token is live. $bands, mint ${f.tokenMint}. i launched it myself. the copycat ${COPYCAT_MINTS[0]} is not mine. mine is a key to my tools, not a share: ${SITE_URL}`,
        disclosureFor(f.tokenMint),
      ];
  }
}

/** The @handles in a text, lowercased without "@". */
export function mentionsIn(text: string): string[] {
  return [...text.matchAll(/(?:^|[^\w])@(\w{1,15})/g)].map((m) => m[1].toLowerCase());
}

/**
 * The checks every part of a kind passes: the lint, the kind's @mention allowlist (and its required tags), and no
 * naming of his token before it exists. Exported so the tests can feed it texts the composer would never write.
 */
export function checkParts(kind: PostedKind, texts: readonly string[], tokenLive: boolean, ctx: LintContext): AnnounceViolation[] {
  const allowed = ALLOWED_MENTIONS[kind];
  const violations: AnnounceViolation[] = [];
  texts.forEach((text, i) => {
    const at = texts.length > 1 ? ` (part ${i + 1})` : "";
    for (const v of lintText(text, ctx).violations) violations.push({ rule: v.rule, detail: `${v.detail}${at}` });
    for (const h of mentionsIn(text)) if (!allowed.includes(h)) violations.push({ rule: "mention", detail: `@${h} is not a handle the ${kind} post may tag${at}` });
    if (!tokenLive && mentionsHouseToken(text, ctx)) violations.push({ rule: "house-token-early", detail: `names his token before TOKEN_MINT exists${at}` });
  });
  for (const h of allowed) if (!texts.some((t) => mentionsIn(t).includes(h))) violations.push({ rule: "mention", detail: `the ${kind} post must tag @${h}` });
  return violations;
}

/** Compose one kind from the facts and check every part. A part that fails refuses the whole kind. */
export function composeAnnouncement(kind: AnnounceKind, f: AnnounceFacts, ctx: LintContext): Composed {
  if (!(ANNOUNCE_KINDS as readonly string[]).includes(kind)) return refuse(kind, `unknown announcement "${kind}": ${ANNOUNCE_KINDS.join(", ")}`);
  if (kind === "follow") return refuse(kind, followInstruction());
  if (f.tokenProblem) return refuse(kind, f.tokenProblem);
  const texts = textsOf(kind, f);
  if (typeof texts === "string") return refuse(kind, texts);
  const violations = checkParts(kind, texts, f.tokenMint !== null, ctx);
  if (violations.length) return refuse(kind, "a part fails the checks", violations);
  return { ok: true, kind, parts: texts };
}

export function followInstruction(): string {
  return `follow @${CLAWPUMP_HANDLE} by hand, signed in as his account: x.com/${CLAWPUMP_HANDLE}, then Follow. X removed follows from every self-serve API tier on 16 Apr 2026, so no code here can do it.`;
}

// ---------------------------------------------------------------- the state file

export interface AnnouncementRecord {
  /** posted part ids, in thread order */
  ids: string[];
  texts: string[];
  /** ISO-8601 of the first part */
  at: string;
  /** all parts posted */
  done: boolean;
}

export interface AnnouncementState {
  version: 1;
  posted: Partial<Record<PostedKind, AnnouncementRecord>>;
}

/** Missing: empty. Exists but unreadable or malformed: THROWS, so nothing can post twice on a bad read. */
export function readAnnouncements(statePath: string): AnnouncementState {
  let text: string;
  try {
    text = fs.readFileSync(path.join(statePath, ANNOUNCEMENTS_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, posted: {} };
    throw err;
  }
  const raw = JSON.parse(text) as Partial<AnnouncementState>;
  if (!raw || raw.version !== 1 || typeof raw.posted !== "object" || raw.posted === null) throw new Error(`${ANNOUNCEMENTS_FILE} is not an announcements file`);
  for (const [k, r] of Object.entries(raw.posted)) {
    if (!r || !Array.isArray(r.ids) || !Array.isArray(r.texts) || typeof r.done !== "boolean") throw new Error(`${ANNOUNCEMENTS_FILE}: the ${k} record is malformed`);
  }
  return { version: 1, posted: raw.posted };
}

function writeAnnouncements(statePath: string, s: AnnouncementState): void {
  const file = path.join(statePath, ANNOUNCEMENTS_FILE);
  fs.mkdirSync(statePath, { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- posting

export type AnnounceResult =
  | { status: "posted"; kind: PostedKind; ids: string[] }
  | { status: "drafted"; kind: PostedKind; parts: string[]; reason: string }
  | { status: "instruction"; kind: "follow"; text: string }
  | { status: "refused"; kind: AnnounceKind; reason: string; violations?: AnnounceViolation[] };

export interface AnnounceDeps extends XDeps {
  data: Pick<TalkData, "source" | "book">;
}

/** Compose, check and post one kind once. Dormant (X_LIVE unset): every part goes to x-drafts.jsonl, nothing is recorded. */
export async function announce(kind: string, deps: AnnounceDeps): Promise<AnnounceResult> {
  if (!(ANNOUNCE_KINDS as readonly string[]).includes(kind)) return { status: "refused", kind: kind as AnnounceKind, reason: `unknown announcement "${kind}": ${ANNOUNCE_KINDS.join(", ")}` };
  const k = kind as AnnounceKind;
  if (k === "follow") return { status: "instruction", kind: k, text: followInstruction() };
  const envObj = deps.env ?? process.env;
  const t: TalkEnv = talkEnv(envObj);
  const now = deps.now ?? Date.now();

  let state: AnnouncementState;
  try {
    state = readAnnouncements(t.statePath);
  } catch (err) {
    return { status: "refused", kind: k, reason: `${ANNOUNCEMENTS_FILE} cannot be read (${(err as Error).message.slice(0, 80)}); not posting` };
  }
  const prior = state.posted[k];
  if (prior?.done) return { status: "refused", kind: k, reason: `already posted at ${prior.at} (${prior.ids.join(", ")}); an announcement goes out once` };

  const c = composeAnnouncement(k, factsOf(deps.data, envObj), lintContextOf(t));
  if (!c.ok) return { status: "refused", kind: k, reason: c.reason, violations: c.violations };
  const kp = c.kind;
  // a thread cut short resumes where it stopped, with the parts it already posted kept as they went out
  const start = prior ? prior.ids.length : 0;
  const parts = c.parts;

  const gate = xGateProblem(t);
  if (gate) {
    for (const text of parts.slice(start)) await postTweet(text, { type: "announce" }, { ...deps, env: envObj, now });
    return { status: "drafted", kind: kp, parts: parts.slice(start), reason: gate };
  }

  const me = await whoAmI({ ...deps, env: envObj, now });
  if (!me.ok) return { status: "refused", kind: kp, reason: `could not check whose account the keys are for: ${me.reason}` };
  if (me.handle !== t.xHandle) return { status: "refused", kind: kp, reason: `the access token is for @${me.handle}, not X_HANDLE @${t.xHandle}; regenerate it signed in as his account` };

  const rec: AnnouncementRecord = prior ?? { ids: [], texts: [], at: new Date(now).toISOString(), done: false };
  for (let i = start; i < parts.length; i++) {
    const prev = rec.ids[rec.ids.length - 1] ?? null;
    const r = await postTweet(parts[i], { type: "announce", inThreadOf: prev }, { ...deps, env: envObj, now });
    if (!r.posted) {
      return rec.ids.length
        ? { status: "refused", kind: kp, reason: `part ${i + 1} of ${parts.length} not posted (${r.reason}); parts ${rec.ids.join(", ")} are out, and the next run resumes at part ${i + 1}` }
        : { status: "refused", kind: kp, reason: r.reason };
    }
    rec.ids.push(r.id);
    rec.texts.push(parts[i]);
    rec.done = rec.ids.length === parts.length;
    state.posted[kp] = rec;
    writeAnnouncements(t.statePath, state);
  }
  return { status: "posted", kind: kp, ids: rec.ids };
}
