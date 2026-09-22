/**
 * His one-off announcements (src/talk/announce.ts). No network: every X call goes to a fake fetch; writes only
 * in a temp dir.
 *   npx tsx src/scripts/test-announce.ts
 * Covers: each kind composed from facts passes the lint and its mention allowlist; the entry must tag
 * @clawpumptech and nobody else may be tagged; no token talk before TOKEN_MINT; the token post needs a usable
 * mint (not the copycat's) and names the copycat as not his; the lint's link allowlist takes mrbands.finance and
 * nothing that only looks like it; dormant runs only draft and record nothing; live runs check whose keys they
 * are, post a thread, record it, refuse a second time, resume a thread cut short and refuse on a bad state file;
 * follow is an instruction and never an X call.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mr-bands-announce-"));
process.env.DATA_DIR = tmp;
process.env.DRY_RUN = "true";
process.env.WALLET_SECRET_KEY = "";
for (const k of ["X_LIVE", "X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET", "OPERATOR_HANDLE", "X_HANDLE", "TALK_STATE_PATH", "TOKEN_MINT", "PAIR_HOUSE_MINTS"]) delete process.env[k];

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
}

const MINT = "BANDSm1ntXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXpump";
const COPY = "JAARLUawF9DTauc9pHUyYpga8mDU3172cY7NzLfhpJ6m";
const NOW = Date.parse("2026-09-25T15:00:00.000Z");
let dirN = 0;
const freshDir = () => {
  const d = path.join(tmp, `s${++dirN}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** A fake X: /2/users/me answers `me`; POST /2/tweets answers ids 100, 101, ... unless `failPost` says otherwise. */
function fakeX(me: string, failPost: (n: number) => boolean = () => false) {
  const calls: Call[] = [];
  let n = 0;
  const fetch = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: String(init.method), url, body });
    if (url.endsWith("/2/users/me")) return new Response(JSON.stringify({ data: { id: "42", username: me } }), { status: 200 });
    if (url.endsWith("/2/tweets") && init.method === "POST") {
      const i = n++;
      if (failPost(i)) return new Response(JSON.stringify({ title: "Service Unavailable" }), { status: 503 });
      return new Response(JSON.stringify({ data: { id: String(100 + i) } }), { status: 201 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch, posts: () => calls.filter((c) => c.url.endsWith("/2/tweets")) };
}

async function main(): Promise<void> {
  const a = await import("../talk/announce.js");
  const { lintText } = await import("../talk/lint.js");
  const { readDrafts, readPosts, postTweet } = await import("../talk/x.js");
  const CTX = { operatorHandle: "zach", houseSymbols: ["bands"], houseMints: [MINT] };
  const CTX_NO_MINT = { operatorHandle: "zach", houseSymbols: ["bands"], houseMints: [] };
  const paperFacts = (tokenMint: string | null = null) => ({ source: "paper" as const, openBands: 5, tokenMint, tokenProblem: null });
  const liveEnv = (statePath: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    X_LIVE: "true",
    X_API_KEY: "k",
    X_API_SECRET: "s",
    X_ACCESS_TOKEN: "t",
    X_ACCESS_SECRET: "ts",
    OPERATOR_HANDLE: "zach",
    X_HANDLE: "mrbands",
    TALK_STATE_PATH: statePath,
    DATA_DIR: statePath,
    ...extra,
  });
  const data = { source: "paper" as const, book: null };

  console.log("compose");
  await test("intro: passes, says paper, links the site, tags nobody, no token", () => {
    const c = a.composeAnnouncement("intro", paperFacts(), CTX_NO_MINT);
    assert.ok(c.ok, JSON.stringify(c));
    assert.equal(c.parts.length, 1);
    const t = c.parts[0];
    for (const w of ["ai agent", "meteora", "screener", "tokenized stocks one part", "paper", "5 bands open", "real-money run", "guard veto", "https://mrbands.finance"]) assert.ok(t.includes(w), `intro lacks "${w}": ${t}`);
    assert.deepEqual(a.mentionsIn(t), []);
    assert.ok(!/\$|token/.test(t.replace("tokenized", "")), t);
    assert.ok(lintText(t, CTX_NO_MINT).ok);
  });
  await test("intro and entry refuse a desk that is not paper", () => {
    for (const k of ["intro", "entry"] as const) {
      const c = a.composeAnnouncement(k, { ...paperFacts(), source: "live" }, CTX);
      assert.ok(!c.ok && /paper/.test(c.reason));
    }
  });
  await test("entry without a mint: tags exactly @clawpumptech, never the template, no token", () => {
    const c = a.composeAnnouncement("entry", paperFacts(), CTX_NO_MINT);
    assert.ok(c.ok, JSON.stringify(c));
    assert.equal(c.parts.length, 1);
    assert.deepEqual(a.mentionsIn(c.parts[0]), ["clawpumptech"]);
    for (const w of ["ansemhack clawrena", "meteora", "paper", "https://mrbands.finance"]) assert.ok(c.parts[0].includes(w), w);
    assert.ok(!/\$|claw\b|powered by/i.test(c.parts[0]), c.parts[0]);
  });
  await test("entry with a mint: names it by mint, says others are not his, the disclosure as part 2", () => {
    const c = a.composeAnnouncement("entry", paperFacts(MINT), CTX);
    assert.ok(c.ok, JSON.stringify(c));
    assert.equal(c.parts.length, 2);
    assert.ok(c.parts[0].includes(`mint ${MINT}`) && /is not mine/.test(c.parts[0]));
    assert.equal(c.parts[1], a.disclosureFor(MINT));
    assert.deepEqual(a.mentionsIn(c.parts.join(" ")), ["clawpumptech"]);
  });
  await test("token: only with a mint; the copycat by its mint as not his; the disclosure; no price talk", () => {
    const none = a.composeAnnouncement("token", paperFacts(), CTX_NO_MINT);
    assert.ok(!none.ok && /TOKEN_MINT is not set/.test(none.reason));
    const c = a.composeAnnouncement("token", paperFacts(MINT), CTX);
    assert.ok(c.ok, JSON.stringify(c));
    assert.ok(c.parts[0].includes(MINT) && c.parts[0].includes(`${COPY} is not mine`));
    assert.equal(c.parts[1], a.disclosureFor(MINT));
    for (const p of c.parts) assert.ok(!/\b(price|chart|buy|sell|holders|volume|apy)\b|%|\$\d/.test(p), p);
    assert.deepEqual(a.mentionsIn(c.parts.join(" ")), []);
  });
  await test("the disclosure line passes the lint with a 44-character mint", () => {
    assert.ok(lintText(a.disclosureFor(MINT), CTX).ok);
  });
  await test("TOKEN_MINT: the copycat's, several, or not base58 refuse every kind", () => {
    assert.match(a.tokenMintOf({ TOKEN_MINT: COPY }).problem ?? "", /copycat/);
    assert.match(a.tokenMintOf({ TOKEN_MINT: `${MINT},${MINT}x` }).problem ?? "", /more than one/);
    assert.match(a.tokenMintOf({ TOKEN_MINT: "not-a-mint" }).problem ?? "", /base58/);
    assert.deepEqual(a.tokenMintOf({ TOKEN_MINT: ` ${MINT} ` }), { mint: MINT, problem: null });
    const f = a.factsOf(data, { TOKEN_MINT: COPY });
    for (const k of ["intro", "entry", "token"] as const) assert.ok(!a.composeAnnouncement(k, f, CTX).ok);
  });
  await test("unknown kinds refuse; follow composes nothing", () => {
    assert.ok(!a.composeAnnouncement("promo" as never, paperFacts(), CTX).ok);
    const f = a.composeAnnouncement("follow", paperFacts(), CTX);
    assert.ok(!f.ok && /by hand/.test(f.reason));
  });

  console.log("the mention exception is narrow");
  await test("only the entry may tag, only @clawpumptech, and the entry must", () => {
    assert.deepEqual(a.ALLOWED_MENTIONS, { intro: [], entry: ["clawpumptech"], token: [] });
    const ok = "i'm entering the ansemhack clawrena, hosted by @clawpumptech";
    assert.deepEqual(a.checkParts("entry", [ok], false, CTX), []);
    assert.ok(a.checkParts("entry", [`${ok} with @someone`], false, CTX).some((v) => v.rule === "mention" && v.detail.includes("@someone")));
    assert.ok(a.checkParts("entry", ["i'm entering the ansemhack clawrena"], false, CTX).some((v) => v.detail.includes("must tag @clawpumptech")));
    assert.ok(a.checkParts("intro", [ok], false, CTX).some((v) => v.rule === "mention"));
    assert.ok(a.checkParts("token", [ok], true, CTX).some((v) => v.rule === "mention"));
  });
  await test("the lint itself is unchanged for mentions: two pass, three fail anywhere", () => {
    assert.ok(lintText("hi @a and @b", CTX).ok);
    assert.ok(lintText("hi @a @b @c", CTX).violations.some((v) => v.rule === "tag-spam"));
  });
  await test("no token talk before TOKEN_MINT, even with a disclosure", () => {
    assert.ok(a.checkParts("intro", ["my own token is $bands"], false, CTX_NO_MINT).some((v) => v.rule === "house-token-early"));
  });
  await test("the link allowlist takes mrbands.finance and nothing that only looks like it", () => {
    assert.ok(lintText("see https://mrbands.finance", CTX).ok);
    assert.ok(lintText("see https://app.mrbands.finance/x", CTX).ok);
    for (const bad of ["https://mrbands.finance.evil.io", "https://evilmrbands.finance", "https://mrbands-finance.com"]) {
      assert.ok(lintText(`see ${bad}`, CTX).violations.some((v) => v.rule === "link"), bad);
    }
  });

  console.log("posting");
  await test("dormant: every part drafted, nothing recorded, no X call, a second run drafts again", async () => {
    const dir = freshDir();
    const x = fakeX("mrbands");
    const env = { ...liveEnv(dir), X_LIVE: "", TOKEN_MINT: MINT };
    for (let i = 0; i < 2; i++) {
      const r = await a.announce("entry", { data, env, fetch: x.fetch, now: NOW });
      assert.equal(r.status, "drafted", JSON.stringify(r));
    }
    assert.equal(x.calls.length, 0);
    assert.equal(readDrafts(dir).filter((d) => d.type === "announce").length, 4);
    assert.ok(!fs.existsSync(path.join(dir, a.ANNOUNCEMENTS_FILE)));
  });
  await test("live: keys for another account refuse before any post", async () => {
    const dir = freshDir();
    const x = fakeX("zach");
    const r = await a.announce("intro", { data, env: liveEnv(dir), fetch: x.fetch, now: NOW });
    assert.equal(r.status, "refused");
    assert.match((r as { reason: string }).reason, /@zach, not X_HANDLE @mrbands/);
    assert.equal(x.posts().length, 0);
  });
  await test("live: posts the thread in order, records it, refuses a second time", async () => {
    const dir = freshDir();
    const x = fakeX("MrBands");
    const env = liveEnv(dir, { TOKEN_MINT: MINT });
    const r = await a.announce("token", { data, env, fetch: x.fetch, now: NOW });
    assert.deepEqual(r, { status: "posted", kind: "token", ids: ["100", "101"] });
    const posts = x.posts();
    assert.equal(posts.length, 2);
    assert.equal((posts[0].body as { reply?: unknown }).reply, undefined);
    assert.deepEqual((posts[1].body as { reply: unknown }).reply, { in_reply_to_tweet_id: "100" });
    assert.equal((posts[1].body as { text: string }).text, a.disclosureFor(MINT));
    const st = a.readAnnouncements(dir);
    assert.deepEqual(st.posted.token?.ids, ["100", "101"]);
    assert.equal(st.posted.token?.done, true);
    assert.deepEqual(readPosts(dir).map((p) => [p.id, p.type, p.replyTo]), [["100", "announce", null], ["101", "announce", "100"]]);
    const again = await a.announce("token", { data, env, fetch: x.fetch, now: NOW + 60e3 });
    assert.equal(again.status, "refused");
    assert.match((again as { reason: string }).reason, /already posted/);
    assert.equal(x.calls.length, 3, "the second run makes no X call");
  });
  await test("live: a thread cut short is recorded as far as it went and resumes at the next part", async () => {
    const dir = freshDir();
    const env = liveEnv(dir, { TOKEN_MINT: MINT });
    const first = fakeX("mrbands", (n) => n === 1);
    const r1 = await a.announce("entry", { data, env, fetch: first.fetch, now: NOW });
    assert.equal(r1.status, "refused");
    assert.match((r1 as { reason: string }).reason, /resumes at part 2/);
    const cut = a.readAnnouncements(dir).posted.entry;
    assert.deepEqual([cut?.ids, cut?.done, cut?.texts.length], [["100"], false, 1]);
    assert.ok(cut?.texts[0].includes("@clawpumptech"));
    const second = fakeX("mrbands");
    const r2 = await a.announce("entry", { data, env, fetch: second.fetch, now: NOW + 60e3 });
    assert.equal(r2.status, "posted");
    assert.equal(second.posts().length, 1);
    assert.deepEqual((second.posts()[0].body as { reply: unknown }).reply, { in_reply_to_tweet_id: "100" });
    assert.equal(a.readAnnouncements(dir).posted.entry?.done, true);
  });
  await test("live: an unreadable announcements file refuses without any X call", async () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, a.ANNOUNCEMENTS_FILE), "{ torn");
    const x = fakeX("mrbands");
    const r = await a.announce("intro", { data, env: liveEnv(dir), fetch: x.fetch, now: NOW });
    assert.equal(r.status, "refused");
    assert.equal(x.calls.length, 0);
    fs.writeFileSync(path.join(dir, a.ANNOUNCEMENTS_FILE), JSON.stringify({ version: 1, posted: { intro: { ids: "100" } } }));
    assert.equal((await a.announce("intro", { data, env: liveEnv(dir), fetch: x.fetch, now: NOW })).status, "refused");
    assert.equal(x.calls.length, 0);
  });
  await test("live: a kind that fails its checks posts nothing", async () => {
    const dir = freshDir();
    const x = fakeX("mrbands");
    const r = await a.announce("token", { data, env: liveEnv(dir), fetch: x.fetch, now: NOW });
    assert.equal(r.status, "refused");
    assert.equal(x.calls.length, 0);
  });
  await test("follow: a printed instruction, never an X call, even live", async () => {
    const dir = freshDir();
    const x = fakeX("mrbands");
    const r = await a.announce("follow", { data, env: liveEnv(dir), fetch: x.fetch, now: NOW });
    assert.equal(r.status, "instruction");
    assert.match((r as { text: string }).text, /@clawpumptech by hand/);
    assert.equal(x.calls.length, 0);
  });
  await test("postTweet: a thread id that is not an x post id is drafted, not sent", async () => {
    const dir = freshDir();
    const x = fakeX("mrbands");
    const r = await postTweet("strap check: green (paper)", { type: "announce", inThreadOf: "abc" }, { env: liveEnv(dir), fetch: x.fetch, now: NOW });
    assert.ok(!r.posted && /thread/.test(r.reason));
    assert.equal(x.calls.length, 0);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
