/**
 * The craft's tests (src/talk/craft.ts).   npx tsx src/scripts/test-talk-craft.ts
 * Every shape for every kind over synthetic facts passes vetOutgoing; every event post carries a figure and fits
 * 280 (no floor: a short factual post is not designed out); the loss-with-fees-and-tokens lesson fits 280; the
 * odd-parity daily on an extreme day with a yesterday row fits 280 (the comparison goes first, the book line
 * second, the figures never); every figure in the text is in the facts and the key figures of the facts are in the
 * text; "paper" is on every post; the openers rotate; no fixed line repeats across two kinds; the red daily states
 * the loss first; the zero-move daily is one line; a losing close names the mechanism and the rule only when the
 * journal gave them, and never claims a proposal on a directive cycle (the journal's proposal is the engine's own
 * then); a desk-policy close is his own rule's; the milestone carries its no-claim; no link; none of Merd's
 * sentences; null for facts it does not shape.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mr-bands-craft-"));
process.env.DATA_DIR = tmp;
process.env.DRY_RUN = "true";
process.env.WALLET_SECRET_KEY = "";
for (const k of ["X_LIVE", "X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET", "OPERATOR_HANDLE", "X_HANDLE", "TALK_STATE_PATH"]) delete process.env[k];

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
}

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** a Tuesday (an even UTC date) */
const NOW = Date.parse("2026-09-22T14:07:00.000Z");
const ODD_NOW = Date.parse("2026-09-23T14:07:00.000Z");

async function main(): Promise<void> {
  const craft = await import("../talk/craft.js");
  const { shapePost, BANNED_PHRASES, signedSol, sol4, safeLabel } = craft;
  type CraftFacts = import("../talk/craft.js").CraftFacts;
  type DayFigure = import("../talk/craft.js").DayFigure;
  const { vetOutgoing } = await import("../talk/tick.js");
  const { weightedLength, linksIn, MAX_POST_CHARS } = await import("../talk/lint.js");

  const env = { operatorHandle: "louz514", houseSymbols: ["mrbands", "bands"], houseMints: [] as string[] };
  const vet = (text: string, paper = true) => vetOutgoing(text, { paper, env });
  const base = { source: "paper" as const, paper: true, now: NOW };
  const numbersIn = (text: string) => (text.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => n.replace(/^0+(?=\d)/, ""));
  const norm = (n: string) => n.replace(/^[+-]/, "").replace(/^0+(?=\d)/, "");

  // ------------------------------------------------------------ fixtures
  const recent: DayFigure[] = [
    { day: "2026-09-15", feesSol: 0.21, netSol: 0.05, closed: 2 },
    { day: "2026-09-16", feesSol: 0.33, netSol: -0.1, closed: 3 },
    { day: "2026-09-17", feesSol: 0.12, netSol: 0.02, closed: 1 },
    { day: "2026-09-18", feesSol: 0.5, netSol: 0.4, closed: 4 },
    { day: "2026-09-19", feesSol: 0.09, netSol: -0.02, closed: 2 },
    { day: "2026-09-20", feesSol: 0.7, netSol: 0.3, closed: 5 },
    { day: "2026-09-21", feesSol: 0.0412, netSol: 0.01, closed: 2 },
  ];
  /** the same week shifted a day, so 22 sep is yesterday for ODD_NOW: both parts of the comparison render on the odd shape */
  const recentY: DayFigure[] = recent.map((d) => ({ ...d, day: `2026-09-${Number(d.day.slice(-2)) + 1}` }));
  const lossClose = (seed: string, extra: Partial<NonNullable<CraftFacts["event"]>> = {}): CraftFacts => ({
    ...base,
    seed,
    recent,
    event: { kind: "close", key: seed, at: NOW, pool: "P", label: "nvdax/usdc", netSol: -0.0412, feesSol: 0.0087, holdSec: 5.2 * 3600, outsideAtClose: true, binsOut: 14, proposed: null, directive: "STOP", source: "engine", openBands: 4, ...extra },
  });
  const winClose = (seed: string): CraftFacts => ({ ...base, seed, recent, event: { kind: "close", key: seed, at: NOW, pool: "P", label: "pltrx/sol", netSol: 0.9534, feesSol: 1.071, holdSec: 538 * 60, outsideAtClose: false, openBands: 5 } });
  const open = (seed: string, extra: Partial<NonNullable<CraftFacts["event"]>> = {}): CraftFacts => ({ ...base, seed, event: { kind: "open", key: seed, at: NOW, pool: "P", label: "nvdax/usdc", side: "BOTH", binsBelow: 6, binsAbove: 6, seatSol: 10.8059, openBands: 5, ...extra } });
  const pos = (label: string, status: "in" | "near_top" | "near_bottom" | "out_above" | "out_below", edge: number | null, bins: number | null) => ({ label, status, edgeDistancePct: edge, binsFromRange: bins });
  const strapBase = { edgePct: 15, dataAt: NOW, detail: "", reason: null, stackedEvent: null, nearEdge: 0, outOfRange: 0 };
  const four = [pos("mu/usdc", "in", 40, 0), pos("nvdax/usdc", "in", 30, 0), pos("gmex/sol", "in", 45, 0), pos("spcx/usdc", "in", 20, 0)];
  const straps: Record<string, CraftFacts> = {
    green: { ...base, seed: "strap:red>green:1", strap: { ...strapBase, state: "green", total: 4, inRange: 4, positions: four, sinceMs: 2 * HOUR } },
    yellow: { ...base, seed: "strap:green>yellow:2", strap: { ...strapBase, state: "yellow", total: 4, inRange: 4, nearEdge: 1, positions: [pos("nvdax/usdc", "near_top", 8, 0), ...four.slice(0, 3)], sinceMs: 90 * MIN } },
    red: { ...base, seed: "strap:green>red:3", strap: { ...strapBase, state: "red", total: 4, inRange: 3, outOfRange: 1, positions: [pos("gmex/sol", "out_above", null, 10), ...four.slice(0, 3)], sinceMs: 50 * MIN } },
    flat: { ...base, seed: "strap:red>flat:4", strap: { ...strapBase, state: "flat", total: 0, inRange: 0, positions: [], sinceMs: 3 * HOUR } },
    stacked: { ...base, seed: "strap:green>stacked:5", strap: { ...strapBase, state: "stacked", total: 4, inRange: 4, positions: four, stackedEvent: { kind: "milestone", at: NOW - 2 * HOUR, detail: "realized fees passed 31 sol" }, sinceMs: 2 * HOUR } },
  };
  const milestone: CraftFacts = { ...base, seed: "milestone:paper:40", milestone: { n: 4, step: 10, firstAt: Date.parse("2026-09-14T22:42:00Z"), netSol: 12.3456, bestDay: { day: "2026-09-18", feesSol: 4.1234, netSol: 2, closed: 4 }, lastDay: { day: "2026-09-21", feesSol: 0.0412, netSol: 0.01, closed: 2 } } };
  const seat = { at: NOW, mode: "paper", pool: "P", label: "SKHY/USDC", position: "paper-x", kind: "stock" as const, openedAt: NOW - 219 * MIN, closedAt: NOW, minutes: 219, seatSol: 41.38, bins: 5, binStep: 80, coverPct: 1.6, travelBins60m: null, inRangePct: 95.1, endReason: "stop" as const, feesSol: 0.019793, netSol: -0.091526, tokensLeftSol: 0.0063, predictedYieldPct: null, realizedYieldPctPerDay: 0.31, headline: "x" };
  const lesson = (seed: string, extra: Partial<NonNullable<CraftFacts["lesson"]>> = {}): CraftFacts => ({ ...base, seed, lesson: { ...seat, proposed: null, directive: "STOP", source: "engine", ...extra } });
  const figures = (o: Partial<import("../talk/strap.js").StackFigures> = {}) => ({ source: "paper" as const, window: "last 24h", since: NOW - DAY, until: NOW, feesRealizedSol: 0.0087, claimsSol: 0, claims: 0, closeFeeLegsSol: 0, closedBands: 3, closedUp: 2, closedDown: 1, closedNetSol: 0.1, worstCloseSol: -0.0412, rentSol: -0.001, swapSol: -0.01, txFeesSol: -0.0001, netRealizedSol: -0.0301, days: 1, redDays: 1, firstRowAt: NOW, lastRowAt: NOW, open: null, ...o });
  const daily = (o: { now?: number; fig?: Partial<import("../talk/strap.js").StackFigures>; opened?: number; dayN?: number | null; recent?: DayFigure[]; source?: "paper" | "dry-run" } = {}): CraftFacts => ({ ...base, source: o.source ?? "paper", now: o.now ?? NOW, seed: `daily:${new Date(o.now ?? NOW).toISOString().slice(0, 10)}`, daily: { figures: figures({ ...(o.source ? { source: o.source } : {}), ...o.fig }), opened: o.opened ?? 2, bookSol: 312.3456, openBands: 4, dayN: o.dayN === undefined ? 8 : o.dayN, recent: o.recent ?? recent } });
  const stack: CraftFacts = { ...base, seed: "stack:2026-09-21", stack: { ...figures({ window: "last 7d", days: 7, redDays: 2, closedBands: 21, closedUp: 15, closedDown: 6, feesRealizedSol: 3.2, netRealizedSol: 1.5, closedNetSol: 1.6 }), open: { feesUnclaimedSol: 0.12, markedBandsSol: 0.3, bands: 5, asOf: NOW } } };

  const must = (kind: Parameters<typeof shapePost>[0], f: CraftFacts): string => {
    const t = shapePost(kind, f);
    assert.ok(t, `${kind} shaped nothing for ${f.seed}`);
    return t;
  };
  const everything: [Parameters<typeof shapePost>[0], CraftFacts][] = [
    ["close", lossClose("close:a")],
    ["close", lossClose("close:b")],
    ["close", lossClose("close:c")],
    ["close", winClose("close:d")],
    ["close", lossClose("close:leg", { closeLegOnly: true, relaidKey: "open:x" })],
    ["open", open("open:a")],
    ["open", open("open:b", { side: "SOL_ONLY", binsBelow: 20, binsAbove: 0, seatSol: 0.5, label: "ansem/sol" })],
    ["open", open("open:c", { side: "TOKEN_ONLY", binsBelow: 0, binsAbove: 12, seatSol: null, label: "gmex/sol" })],
    ...Object.values(straps).map((f): [Parameters<typeof shapePost>[0], CraftFacts] => ["strap", f]),
    ["milestone", milestone],
    ["lesson", lesson("lesson:a")],
    ["lesson", lesson("lesson:b", { endReason: "through-band", netSol: 0.3045, feesSol: 0.148315, tokensLeftSol: 4.190039, minutes: 437.9, inRangePct: 100, proposed: null, directive: null })],
    ["daily", daily()],
    ["daily", daily({ now: ODD_NOW })],
    ["daily", daily({ fig: { netRealizedSol: 0.42, feesRealizedSol: 0.9 } })],
    ["daily", daily({ now: ODD_NOW, fig: { netRealizedSol: 0.42, feesRealizedSol: 0.9 } })],
    ["daily", daily({ fig: { netRealizedSol: 0, feesRealizedSol: 0, closedBands: 0, closedUp: 0, closedDown: 0, worstCloseSol: null }, opened: 0 })],
    ["daily", daily({ dayN: null })],
    ["daily", daily({ now: ODD_NOW, recent: recentY })],
    ["daily", daily({ now: ODD_NOW, recent: recentY, fig: { netRealizedSol: 0.42, feesRealizedSol: 0.9 } })],
    ["daily", daily({ now: ODD_NOW, recent: recentY, source: "dry-run" })],
    ["stack", stack],
  ];

  // ------------------------------------------------------------ the vet, the length, paper, no link
  test("every shape for every kind passes vetOutgoing on a paper desk, says paper, carries no link", () => {
    for (const [kind, f] of everything) {
      const t = must(kind, f);
      const v = vet(t);
      assert.deepEqual(v, [], `${kind} ${f.seed}: ${JSON.stringify(v)}\n${t}`);
      assert.match(t, /\bpaper\b/, `${kind} ${f.seed} does not say paper`);
      assert.deepEqual(linksIn(t), [], `${kind} ${f.seed} carries a link`);
      assert.ok(!/[‒–—―]|--/.test(t), `${kind} ${f.seed} has a dash`);
      assert.equal(t, t.toLowerCase(), `${kind} ${f.seed} is not lowercase`);
      assert.ok(weightedLength(t) <= MAX_POST_CHARS, `${kind} ${f.seed} is ${weightedLength(t)} chars`);
    }
  });

  test("every event post (close, open, strap, milestone) carries a figure and fits 280; there is no floor (a number is what held Merd's reach, not length)", () => {
    for (const [kind, f] of everything) {
      if (!["close", "open", "strap", "milestone"].includes(kind)) continue;
      const t = must(kind, f);
      const n = weightedLength(t);
      assert.ok(n <= MAX_POST_CHARS, `${kind} ${f.seed} is ${n} chars:\n${t}`);
      assert.match(t, /\d/, `${kind} ${f.seed} carries no figure:\n${t}`);
    }
    // the shortest shape, the flat strap, is a fact with a number in it and well under the limit
    assert.ok(weightedLength(must("strap", straps.flat)) < 140);
  });

  test("event posts are two to four lines plus the paper line; the daily and the stack are ledger cards", () => {
    for (const [kind, f] of everything) {
      const t = must(kind, f);
      const lines = t.split("\n").filter((l) => l !== "paper book.");
      if (["close", "open", "strap", "milestone", "lesson"].includes(kind)) assert.ok(lines.length >= 1 && lines.length <= 5, `${kind} ${f.seed}: ${lines.length} lines`);
      else assert.ok(lines.length >= 1 && lines.length <= 6, `${kind} ${f.seed}: ${lines.length} lines`);
    }
  });

  // ------------------------------------------------------------ numbers
  test("every number in a post is in its facts (or arithmetic on them), and the key figures of the facts are in the post", () => {
    const check = (kind: Parameters<typeof shapePost>[0], f: CraftFacts, allowed: string[], key: string[]) => {
      const t = must(kind, f);
      const ok = new Set(allowed.map(norm));
      for (const n of numbersIn(t)) assert.ok(ok.has(n), `${kind} ${f.seed}: "${n}" is not in the facts\n${t}`);
      for (const k of key) assert.ok(t.includes(k), `${kind} ${f.seed}: key figure ${k} missing\n${t}`);
    };
    const clockParts = (ms: number) => [String(new Date(ms).getUTCHours()), String(new Date(ms).getUTCMinutes())];
    const held = (sec: number) => (sec < 3600 ? String(Math.max(1, Math.round(sec / 60))) : (sec / 3600).toFixed(1));
    const dayOf = (d: string) => String(new Date(d).getUTCDate());
    const recentNums = [String(recent.length), ...recent.map((d) => sol4(d.feesSol)), ...recent.map((d) => dayOf(d.day))];
    for (const f of [lossClose("close:a"), lossClose("close:b"), lossClose("close:c"), winClose("close:d")]) {
      const e = f.event!;
      check("close", f, [signedSol(e.netSol!), sol4(e.feesSol!), held(e.holdSec!), ...clockParts(e.at), String(Math.abs(e.binsOut ?? 0)), String(e.openBands), ...recentNums], [signedSol(e.netSol!), sol4(e.feesSol!), `${held(e.holdSec!)}h`]);
    }
    for (const f of [open("open:a"), open("open:b", { side: "SOL_ONLY", binsBelow: 20, binsAbove: 0, seatSol: 0.5, label: "ansem/sol" })]) {
      const e = f.event!;
      check("open", f, [sol4(e.seatSol!), String(e.binsBelow), String(e.binsAbove), String(e.openBands), ...clockParts(e.at)], [sol4(e.seatSol!), String(e.binsBelow)]);
    }
    for (const f of Object.values(straps)) {
      const s = f.strap!;
      check("strap", f, [String(s.total), String(s.inRange), String(s.nearEdge), String(s.outOfRange), held(s.sinceMs! / 1000), "10", "31", "2"], s.state === "flat" ? [] : [`${s.inRange} of ${s.total}`]);
    }
    {
      const m = milestone.milestone!;
      check("milestone", milestone, ["40", "10", dayOf("2026-09-14"), dayOf("2026-09-22"), sol4(m.bestDay!.feesSol), sol4(m.lastDay!.feesSol), dayOf(m.bestDay!.day), signedSol(m.netSol)], ["40", signedSol(m.netSol), sol4(m.bestDay!.feesSol), sol4(m.lastDay!.feesSol), "nothing about the next 10"]);
    }
    for (const f of [lesson("lesson:a"), lesson("lesson:b"), lesson("lesson:c")]) {
      const l = f.lesson!;
      check("lesson", f, [sol4(l.feesSol), signedSol(l.netSol), sol4(l.tokensLeftSol!), held(l.minutes * 60), String(Math.round(l.inRangePct!)), dayOf("2026-09-22")], [sol4(l.feesSol), signedSol(l.netSol), sol4(l.tokensLeftSol!), `${held(l.minutes * 60)}h`, `${Math.round(l.inRangePct!)}%`]);
    }
    for (const f of [daily(), daily({ now: ODD_NOW }), daily({ fig: { netRealizedSol: 0.42, feesRealizedSol: 0.9 } }), daily({ fig: { netRealizedSol: 0, feesRealizedSol: 0, closedBands: 0, closedUp: 0, closedDown: 0, worstCloseSol: null }, opened: 0 })]) {
      const d = f.daily!;
      const g = d.figures;
      const allowed = [String(d.dayN), "24", sol4(g.feesRealizedSol), signedSol(g.netRealizedSol), String(d.opened), String(g.closedBands), String(g.closedUp), String(g.closedDown), ...(g.worstCloseSol !== null ? [signedSol(g.worstCloseSol)] : []), sol4(d.bookSol!), String(d.openBands), ...recentNums];
      check("daily", f, allowed, [`day ${d.dayN}`, sol4(g.feesRealizedSol), signedSol(g.netRealizedSol), sol4(d.bookSol!), `${d.openBands} bands open`]);
    }
    {
      const s = stack.stack!;
      check("stack", stack, ["7", sol4(s.feesRealizedSol), String(s.closedBands), String(s.closedUp), String(s.closedDown), signedSol(s.closedNetSol), signedSol(s.worstCloseSol!), signedSol(s.rentSol), signedSol(s.swapSol), signedSol(s.txFeesSol), signedSol(s.netRealizedSol), String(s.redDays), String(s.days), signedSol(s.open!.markedBandsSol), sol4(s.open!.feesUnclaimedSol)], [sol4(s.feesRealizedSol), signedSol(s.netRealizedSol), `red days ${s.redDays} of ${s.days}`, `${s.closedUp} up, ${s.closedDown} down`]);
    }
  });

  test("figures are 4-decimal sol, signed on net, never -0.0000, never a rate, a return or a usd figure; the lesson's in-range share is a count of checks, and the persona says so", () => {
    const persona = fs.readFileSync(path.resolve(process.cwd(), "src/agent/persona.ts"), "utf8");
    assert.ok(!persona.includes("a percent on a band"), "the persona line contradicted the lesson's in-range share");
    assert.ok(persona.includes("a count of checks, not a rate"));
    assert.equal(signedSol(-0.00001), "0.0000");
    assert.equal(sol4(-0.00001), "0.0000");
    assert.equal(signedSol(0.0915), "+0.0915");
    for (const [kind, f] of everything) {
      const t = must(kind, f);
      assert.ok(!/\$|usd\b|apy|apr|per day|a day\b|on pace/.test(t), `${kind} ${f.seed} states a rate or a usd figure\n${t}`);
      if (kind !== "lesson") assert.ok(!/%/.test(t), `${kind} ${f.seed} carries a percent\n${t}`);
      assert.ok(!/-0\.0000/.test(t), `${kind} ${f.seed} prints -0.0000`);
      assert.ok(!/\bnew high\b/.test(t), `${kind} ${f.seed} says a new high`);
    }
    // never "+" on fees as a headline
    for (const f of [daily(), daily({ now: ODD_NOW }), daily({ fig: { netRealizedSol: 0.42, feesRealizedSol: 0.9 } })]) assert.ok(!/fees(?: realized)? \+/.test(must("daily", f)), "a signed fee figure");
  });

  // ------------------------------------------------------------ openers and repetition
  test("three openers per kind rotate by the seed: over many seeds each of the three appears, and one seed always gives the same text", () => {
    const openersOf = (kind: Parameters<typeof shapePost>[0], mk: (seed: string) => CraftFacts) => new Set(Array.from({ length: 30 }, (_, i) => must(kind, mk(`${kind}:seed-${i}`)).split("\n")[0].replace(/, paper book\.$/, ".")));
    assert.equal(openersOf("close", lossClose).size, 3, "three close openers");
    assert.equal(openersOf("open", (s) => open(s)).size, 3, "three open openers");
    assert.equal(openersOf("lesson", (s) => lesson(s)).size, 3, "three lesson openers");
    assert.equal(must("close", lossClose("close:same")), must("close", lossClose("close:same")));
    const all = Array.from({ length: 30 }, (_, i) => must("close", lossClose(`close:seed-${i}`)));
    assert.ok(all.some((t) => t.startsWith("closed my band on")) && all.some((t) => t.startsWith("nvdax/usdc, closed")) && all.some((t) => t.startsWith("5.2h in nvdax/usdc")));
  });

  test("'paper' rotates by seed parity between the first line and the last line, and is on every post about the book", () => {
    const firsts = new Set<boolean>();
    for (let i = 0; i < 20; i++) {
      const t = must("close", lossClose(`close:parity-${i}`));
      const lines = t.split("\n");
      const onFirst = /\bpaper book\b/.test(lines[0]);
      const onLast = lines[lines.length - 1] === "paper book." || /\bpaper book\b/.test(lines[lines.length - 1]);
      assert.ok(onFirst || onLast, `paper is neither first nor last:\n${t}`);
      firsts.add(onFirst && !onLast);
    }
    assert.equal(firsts.size, 2, "both placements occur");
    // a live book, not paper: no tag at all
    const live = shapePost("close", { ...lossClose("close:live"), source: "live", paper: false })!;
    assert.ok(!/\bpaper\b/.test(live));
    assert.deepEqual(vet(live, false), []);
  });

  test("no fixed line repeats across two kinds", () => {
    const fixed = new Map<string, string>();
    for (const [kind, f] of everything) {
      for (const raw of must(kind, f).split("\n")) {
        const line = raw.replace(/\d+(\.\d+)?/g, "N").replace(/, paper book\.$/, ".");
        if (line === "paper book." || line === "N bands still open on the paper book." || line === "N bands open on the paper book.") continue;
        const prev = fixed.get(line);
        assert.ok(!prev || prev === kind, `"${line}" is in both ${prev} and ${kind}`);
        fixed.set(line, kind);
      }
    }
  });

  test("none of Merd's sentences, no slogan and no closing epigram", () => {
    for (const [kind, f] of everything) {
      const t = must(kind, f);
      for (const p of BANNED_PHRASES) assert.ok(!t.includes(p), `${kind} ${f.seed} says "${p}"`);
      assert.ok(!/i propose, the guards decide|still stacking|fees are not profit|no drama|eyes on it|no panic|that's where i eat/.test(t), `${kind} ${f.seed} ends on a slogan\n${t}`);
    }
    assert.ok(BANNED_PHRASES.includes("a new high") && BANNED_PHRASES.includes("fees only go up") && BANNED_PHRASES.includes("the rule cut it"));
  });

  // ------------------------------------------------------------ the close
  test("a close carries its utc clock time, the net with a sign and the fees counted in it; a loss is said as a loss", () => {
    const t = must("close", lossClose("close:a"));
    assert.match(t, /14:07 utc/);
    assert.match(t, /net -0\.0412 sol, a loss/);
    assert.match(t, /fees 0\.0087 sol counted in it/);
    const w = must("close", winClose("close:d"));
    assert.match(w, /net \+0\.9534 sol/);
    assert.ok(!/a loss/.test(w));
    // where price was is a fact either way: inside when the book says in range, bins out when it knows them, else outside
    assert.match(w, /price was still inside the band at the close\./);
    assert.match(must("close", lossClose("close:a", { binsOut: null })), /price was outside the band at the close\./);
    assert.ok(!/price (was|sat)/.test(must("close", lossClose("close:a", { binsOut: null, outsideAtClose: null }))));
  });

  test("a losing close names the mechanism (bins out) and what the rule did, only from the journal; absent means omitted, never invented", () => {
    const full = must("close", lossClose("close:a"));
    assert.match(full, /price sat 14 bins above the band at the close\./);
    assert.match(full, /^the stop closed it\.$/m);
    assert.ok(!/proposed/.test(full), full);
    const noJournal = must("close", lossClose("close:a", { proposed: null, directive: null, source: null, binsOut: null }));
    assert.ok(!/proposed|stop closed|the rule/.test(noJournal), noJournal);
    assert.match(noJournal, /price was outside the band at the close\./);
    const below = must("close", lossClose("close:a", { binsOut: -3 }));
    assert.match(below, /3 bins below the band/);
    // a win does not get the rule line even when the journal has one
    const win = must("close", { ...winClose("close:d"), event: { ...winClose("close:d").event!, proposed: "CLOSE_POSITION", directive: "STOP", source: "engine" } });
    assert.ok(!/proposed|stop closed/.test(win));
    // the journal's words are data: sanitized to plain lowercase letters, and a directive word the journal never writes is no closer
    const odd = must("close", lossClose("close:a", { proposed: "HOLD @someone #x", directive: "STOP $BANDS", source: "llm" }));
    assert.deepEqual(vet(odd), []);
    assert.ok(!/closed it|@|#|\$/.test(odd), odd);
    assert.match(must("close", lossClose("close:a", { proposed: "HOLD @someone #x", directive: "STOP", source: "llm" })), /i had proposed to hold someone x; the stop closed it\./);
  });

  test("the mechanism line never claims a proposal he did not make: the desk's STOP cycle (the engine's own CLOSE_POSITION, llm.source engine) says only what the rule did; a policy close is his own rule's; COLLECT never closes a band", () => {
    // the entry the desk writes on a STOP cycle, before closeContextsOf nulls the proposal, and after
    for (const proposed of ["CLOSE_POSITION", null]) {
      const t = must("close", lossClose("close:engine", { proposed, directive: "STOP", source: "engine" }));
      assert.match(t, /^the stop closed it\.$/m);
      assert.ok(!/proposed|my own rule|myself/.test(t), t);
    }
    for (const [directive, line] of [["FLATTEN", "the flatten closed it."], ["EXPIRE", "its time ran out and the clock closed it."], ["ROTATE", "the rotation closed it for a pool ranked higher."]]) {
      const t = must("close", lossClose("close:engine", { proposed: "CLOSE_POSITION", directive, source: "engine" }));
      assert.ok(t.split("\n").includes(line), `${directive}: ${t}`);
    }
    // the desk policy's close, no directive: his own rule, said so
    const policy = must("close", lossClose("close:policy", { proposed: "CLOSE_POSITION", directive: null, source: "policy" }));
    assert.match(policy, /^my own rule proposed the close; the guards allowed it\.$/m);
    const recentre = must("close", lossClose("close:policy", { proposed: "REBALANCE", directive: null, source: "policy" }));
    assert.match(recentre, /^my own rule proposed the re-centre; the guards allowed it\.$/m);
    // the model's own close
    const mine = must("close", lossClose("close:llm", { proposed: "CLOSE_POSITION", directive: null, source: "llm" }));
    assert.match(mine, /^i proposed the close myself; the guards allowed it\.$/m);
    // a directive that does not close a band is never the closer; the proposal line still stands on its own
    const collect = must("close", lossClose("close:collect", { proposed: "CLOSE_POSITION", directive: "COLLECT", source: "policy" }));
    assert.ok(!/collect/.test(collect), collect);
    assert.match(collect, /my own rule proposed the close; the guards allowed it\./);
    // an approved outside proposal is not his: no line
    const outside = must("close", lossClose("close:outside", { proposed: "CLOSE_POSITION", directive: null, source: "proposal" }));
    assert.ok(!/proposed|the guards/.test(outside), outside);
    // a HOLD of his overridden by a stop cannot come from the desk's journal (a directive replaces the call), but the line is grammatical
    const hold = must("close", lossClose("close:hold", { proposed: "HOLD", directive: "STOP", source: "llm" }));
    assert.match(hold, /^i had proposed to hold; the stop closed it\.$/m);
    assert.deepEqual(vet(policy).concat(vet(mine), vet(collect), vet(hold)), []);
  });

  test("the close's comparison is only to his own days on the same book, in sol, and only when it stands out", () => {
    const win = must("close", winClose("close:d"));
    assert.match(win, /more than any whole day of the last 7 netted\./);
    const ordinary = must("close", { ...winClose("close:d"), event: { ...winClose("close:d").event!, netSol: 0.05 } });
    assert.ok(!/any whole day/.test(ordinary));
    // a loss with the bins line and the rule line has its four lines already; one without them has room for it
    const worst = must("close", lossClose("close:a", { netSol: -0.5, binsOut: null, outsideAtClose: false, proposed: null, directive: null }));
    assert.match(worst, /worse than any whole day of the last 7\./);
    assert.ok(!/any whole day/.test(must("close", lossClose("close:a", { netSol: -0.5 }))), "four lines, then the fact-bearing lines stop");
    const noDays = must("close", { ...winClose("close:d"), recent: [] });
    assert.ok(!/any whole day/.test(noDays));
    // today's own row is never a comparison day
    const onlyToday = must("close", { ...winClose("close:d"), recent: [{ day: "2026-09-22", feesSol: 9, netSol: 9, closed: 1 }, { day: "2026-09-21", feesSol: 0.01, netSol: 0.01, closed: 1 }] });
    assert.ok(!/any whole day/.test(onlyToday));
  });

  // ------------------------------------------------------------ the open
  test("an open ends on a fact (bands open on the paper book), never on the old closing line", () => {
    const t = must("open", open("open:a"));
    assert.ok(t.endsWith("5 bands open on the paper book."), t);
    assert.match(t, /6 bins each side of price/);
    assert.match(t, /half usdc, half nvdax/);
    const one = must("open", open("open:b", { side: "SOL_ONLY", binsBelow: 20, binsAbove: 0, seatSol: 0.5, label: "ansem/sol" }));
    assert.match(one, /20 bins down from price/);
    assert.match(one, /sol only, below price/);
    const none = must("open", open("open:n", { openBands: null }));
    assert.ok(none.includes("paper"));
  });

  // ------------------------------------------------------------ the strap
  test("a strap post carries a number: bands in range of total, hours since the change, bins out for red", () => {
    assert.match(must("strap", straps.green), /4 of 4 bands in the bands/);
    assert.match(must("strap", straps.green), /last change 2\.0h ago/);
    assert.match(must("strap", straps.yellow), /1 of 4 bands near an edge, nvdax\/usdc closest to the top/);
    assert.match(must("strap", straps.red), /gmex\/sol out the bands, price 10 bins above my range/);
    assert.match(must("strap", straps.red), /3 of 4 still in the bands/);
    assert.match(must("strap", straps.flat), /^strap check: flat\. no bands open on the paper book/);
    assert.match(must("strap", straps.stacked), /realized fees passed 31 sol/);
    assert.equal(shapePost("strap", { ...base, seed: "s", strap: { ...strapBase, state: "unknown", total: 0, inRange: 0, positions: [], reason: "x" } }), null, "an unknown strap shapes nothing");
  });

  // ------------------------------------------------------------ the milestone
  test("the milestone is level, window, best day, most recent day, the net over the stretch and an explicit no-claim, without the slogan", () => {
    const t = must("milestone", milestone);
    assert.match(t, /^realized fees on the paper book passed 40 sol, 14 sep to 22 sep\./m);
    assert.match(t, /best day 4\.1234 sol on 18 sep, most recent day 0\.0412 sol\./);
    assert.match(t, /net over the same stretch \+12\.3456 sol, losses, rent and swaps counted\./);
    assert.match(t, /nothing about the next 10\.$/);
    assert.ok(!/fees are not profit/.test(t));
    const bare = must("milestone", { ...milestone, milestone: { ...milestone.milestone!, bestDay: null, lastDay: null } });
    assert.ok(!/best day|most recent/.test(bare));
    assert.deepEqual(vet(bare), []);
  });

  // ------------------------------------------------------------ the lesson
  test("the lesson is three parts with no fixed takeaway; the loss-with-fees-and-tokens seat fits 280 and keeps its tokens line", () => {
    const t = must("lesson", lesson("lesson:a"));
    assert.ok(weightedLength(t) <= MAX_POST_CHARS);
    assert.match(t, /3\.6h/);
    assert.match(t, /in range 95% of checks/);
    assert.match(t, /fees 0\.0198 sol, net -0\.0915 sol, a loss, after rent and swaps\./);
    assert.match(t, /0\.0063 sol of that still in tokens, not sold\./);
    assert.match(t, /^the stop pulled the seat\.$/m);
    assert.ok(!/proposed|proposal/.test(t), t);
    assert.ok(!/fees are not profit|logged like the wins|not every seat is|taught me/.test(t), t);
    // the lesson's rule line in every form: grammatical, and never the close's line for the same seat
    assert.match(must("lesson", lesson("lesson:hold", { proposed: "HOLD", directive: "STOP", source: "llm" })), /^the stop pulled the seat, over my proposal to hold\.$/m);
    assert.match(must("lesson", lesson("lesson:policy", { proposed: "CLOSE_POSITION", directive: null, source: "policy", endReason: "idle" })), /^the close came from my own rule, and the guards let it through\.$/m);
    assert.match(must("lesson", lesson("lesson:llm", { proposed: "REBALANCE", directive: null, source: "llm", endReason: "through-band" })), /^the re-centre was my own proposal, and the guards let it through\.$/m);
    assert.match(must("lesson", lesson("lesson:rotate", { proposed: "CLOSE_POSITION", directive: "ROTATE", source: "engine", endReason: "rotated" })), /^the rotation moved the seat to a pool ranked higher\.$/m);
    for (const seed of ["lesson:a", "lesson:policy"]) {
      const l = must("lesson", lesson(seed, seed === "lesson:policy" ? { proposed: "CLOSE_POSITION", directive: null, source: "policy" } : {}));
      const c = must("close", lossClose(seed.replace("lesson", "close"), seed === "lesson:policy" ? { proposed: "CLOSE_POSITION", directive: null, source: "policy" } : {}));
      for (const line of l.split("\n")) if (line !== "paper book.") assert.ok(!c.split("\n").includes(line), `the close and the lesson share "${line}"`);
    }
    // the tokens line goes first when the post runs long, never the money or the rule
    const long = must("lesson", lesson("lesson:long", { label: "averyveryverylongtoken/anotherlongone", tokensLeftSol: 123456.1234, minutes: 99999 }));
    assert.ok(weightedLength(long) <= MAX_POST_CHARS);
    assert.match(long, /fees 0\.0198 sol, net -0\.0915 sol/);
    // no journal words: the end reason is the actor
    const tb = must("lesson", lesson("lesson:b", { endReason: "through-band", proposed: null, directive: null }));
    assert.match(tb, /price went through the band and out the other side\./);
    const idle = must("lesson", lesson("lesson:c", { endReason: "idle", proposed: null, directive: null, tokensLeftSol: 0 }));
    assert.match(idle, /price left the band and stayed away/);
    assert.ok(!/still in tokens/.test(idle));
  });

  // ------------------------------------------------------------ the daily
  test("the daily is a fixed card with day N, two orderings by utc-day parity, and the comparison to his own days", () => {
    const even = must("daily", daily({ fig: { netRealizedSol: 0.42, feesRealizedSol: 0.9 } }));
    const odd = must("daily", daily({ now: ODD_NOW, fig: { netRealizedSol: 0.42, feesRealizedSol: 0.9 } }));
    assert.match(even, /^day 8, paper book, last 24h: fees 0\.9000 sol, fatter than any of the last 7 days, after 0\.0412 yesterday; net \+0\.4200 sol after losses, rent, swaps and network fees\.$/m);
    assert.equal(even.split("\n").length, 3, even);
    assert.match(odd, /^day 8, paper book, last 24h:$/m);
    // the odd fixture is 23 sep and recent ends 21 sep: no yesterday row, so no yesterday clause (never invented)
    assert.match(odd, /^fees realized 0\.9000 sol, fatter than any of the last 7 days$/m);
    assert.match(odd, /^net realized \+0\.4200 sol after losses, rent, swaps and network fees$/m);
    assert.equal(odd.split("\n").length, 5, odd);
    assert.match(even, /fatter than any of the last 7 days, after 0\.0412 yesterday/);
    const middle = must("daily", daily({ fig: { netRealizedSol: 0.42, feesRealizedSol: 0.3 } }));
    assert.ok(!/thinner|fatter/.test(middle) && /after 0\.0412 yesterday/.test(middle), middle);
    const noDay = must("daily", daily({ dayN: null }));
    assert.match(noDay, /^daily numbers, paper book/);
  });

  test("the odd daily on an extreme day with a yesterday row fits 280: the comparison goes first, the book line second, the figures never", () => {
    for (const [name, f] of [
      ["red thin", daily({ now: ODD_NOW, recent: recentY })],
      ["green fat", daily({ now: ODD_NOW, recent: recentY, fig: { netRealizedSol: 0.42, feesRealizedSol: 0.9 } })],
      ["red thin, dry run", daily({ now: ODD_NOW, recent: recentY, source: "dry-run" })],
    ] as const) {
      const t = must("daily", f);
      const n = weightedLength(t);
      assert.ok(n <= MAX_POST_CHARS, `${name}: ${n} chars\n${t}`);
      assert.deepEqual(vet(t), [], name);
      // the figures, the moves and the book line stay; the comparison is what went
      assert.match(t, /fees realized 0\.(0087|9000) sol/);
      assert.match(t, /net realized [+-]0\.\d{4} sol after losses, rent, swaps and network fees/);
      assert.match(t, /moves: 2 opened, 3 closed, 2 up and 1 down, worst -0\.0412 sol/);
      assert.match(t, /book marked at 312\.3456 sol, 4 bands open/);
      assert.ok(!/thinner|fatter|yesterday/.test(t), `${name} kept the comparison over 280:\n${t}`);
    }
    // a day in the middle of the week keeps its shorter clause, since it fits
    const middle = must("daily", daily({ now: ODD_NOW, recent: recentY, fig: { netRealizedSol: 0.42, feesRealizedSol: 0.3 } }));
    assert.ok(weightedLength(middle) <= MAX_POST_CHARS);
    assert.match(middle, /fees realized 0\.3000 sol, after 0\.0412 yesterday$/m);
    // and the even shape, dense by design, keeps both parts
    const even = must("daily", daily({ now: ODD_NOW + DAY, recent: recentY.map((d) => ({ ...d, day: `2026-09-${Number(d.day.slice(-2)) + 1}` })) }));
    assert.match(even, /thinner than any of the last 7 days, after 0\.0412 yesterday/);
    assert.ok(weightedLength(even) <= MAX_POST_CHARS);
  });

  test("a red daily states the loss first, in the same card", () => {
    for (const now of [NOW, ODD_NOW]) {
      const t = must("daily", daily({ now }));
      assert.match(t, /^day 8, paper book, net -0\.0301 sol on the day\./, t);
      assert.match(t, now === NOW ? /fees(?: realized)? 0\.0087 sol, thinner than any of the last 7 days, after 0\.0412 yesterday/ : /fees(?: realized)? 0\.0087 sol, thinner than any of the last 7 days$/m);
      assert.match(t, /2 opened, 3 closed, 2 up and 1 down, worst -0\.0412 sol/);
      assert.match(t, /book marked at 312\.3456 sol, 4 bands open/);
    }
  });

  test("a zero-move day is one line, still with paper book and the comparison", () => {
    const t = must("daily", daily({ fig: { netRealizedSol: 0, feesRealizedSol: 0, closedBands: 0, closedUp: 0, closedDown: 0, worstCloseSol: null }, opened: 0 }));
    assert.equal(t.split("\n").length, 1);
    assert.match(t, /^day 8, paper book: 0\.0000 sol in fees, thinner than any of the last 7 days, after 0\.0412 yesterday, nothing opened or closed, book marked at 312\.3456 sol, 4 bands open\.$/);
    const red = must("daily", daily({ fig: { netRealizedSol: -0.0002, feesRealizedSol: 0, closedBands: 0, closedUp: 0, closedDown: 0, worstCloseSol: null }, opened: 0 }));
    assert.match(red, /^day 8, paper book, net -0\.0002 sol on the day: 0\.0000 sol in fees/);
  });

  // ------------------------------------------------------------ the stack
  test("the stack is the ledger card without 'still stacking'; the open marks go first when it runs long", () => {
    const t = must("stack", stack);
    assert.match(t, /^the stack, last 7d, paper book:$/m);
    assert.match(t, /red days 2 of 7$/m);
    assert.match(t, /not realized$/m);
    assert.ok(!/stacking/.test(t));
    assert.equal(shapePost("stack", { ...stack, stack: { ...stack.stack!, days: 0 } }), null);
  });

  // ------------------------------------------------------------ null and safety
  test("null for a kind without its facts, for facts it does not shape, and never a throw", () => {
    assert.equal(shapePost("close", { ...base, seed: "x" }), null);
    assert.equal(shapePost("close", open("open:a")), null);
    assert.equal(shapePost("open", lossClose("close:a")), null);
    assert.equal(shapePost("daily", { ...base, seed: "x" }), null);
    assert.equal(shapePost("lesson", { ...base, seed: "x" }), null);
    assert.equal(shapePost("milestone", { ...base, seed: "x", milestone: { n: 0, step: 10, firstAt: NOW, netSol: 0, bestDay: null, lastDay: null } }), null);
    assert.equal(shapePost("nope" as never, { ...base, seed: "x" }), null);
    assert.equal(shapePost("daily", { ...base, seed: "x", daily: null as never }), null);
  });

  test("labels are cleaned as tick.ts cleans them: no @, # or $, a blocked word reads a pool", () => {
    assert.equal(safeLabel("$PEPE @someone/SOL"), "pepe/sol");
    assert.equal(safeLabel("$SCAM/SOL"), "a pool");
    const t = must("close", lossClose("close:dirty", { label: "$PEPE @someone/SOL" }));
    assert.match(t, /pepe\/sol/);
    assert.deepEqual(vet(t), []);
    // a hashtag word is dropped whole, as tick.ts drops it: "#RUG @x/SOL" leaves "sol"
    const l = must("lesson", lesson("lesson:dirty", { label: "#RUG @x/SOL" }));
    assert.match(l, /closed: sol,/);
    assert.ok(!/rug|@|#/.test(l));
    assert.deepEqual(vet(l), []);
    const scam = must("lesson", lesson("lesson:scam", { label: "$SCAM/SOL" }));
    assert.match(scam, /a pool/);
    assert.deepEqual(vet(scam), []);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
