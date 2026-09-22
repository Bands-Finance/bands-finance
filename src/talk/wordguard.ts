/**
 * Words that never go out under his name when they come from on-chain data (pool and token labels a screener
 * ranked, memecoin symbols included): slurs, hate words, sexual words, violence, and scam words. The posting loop
 * (src/talk/tick.ts) checks every label with labelBlocked before it prints one (a blocked label reads "a pool"),
 * and checks the whole outgoing text with blockedWordsIn as a last net. The list is deliberately blunt: a false hit
 * only turns a symbol into "a pool"; a miss puts a slur on his account.
 *
 * Matching runs on a folded form: NFKC, lowercase, common leetspeak (0>o, 1>i, 3>e, 4>a, 5>s, 7>t, 8>b, @>a, $>s),
 * letters only. An entry with no doubled letter is matched against that form with repeats squeezed ("niiigga" reads
 * "niga", so such stems are written squeezed); an entry with a doubled letter ("kkk", "boob") against it unsqueezed.
 */

/** Blocked wherever they appear inside a label or a word (stems, squeezed: no doubled letters). */
export const BLOCKED_STEMS: readonly string[] = [
  "niga", "niger", "nigr", "fagot", "fagit", "retard", "hitler", "nazi", "kike", "trany", "chink", "wetback", "beaner",
  "porn", "pedo", "rapist", "cunt", "whore", "slut", "hentai", "onlyfans", "kkk", "sieg", "genocide", "holocaust",
  "rugpul", "scam", "fuck", "motherf", "shit", "pusy", "dildo", "blowjob", "nude", "milf", "jihad", "terror",
];

/** Blocked as a whole word, or as a label side that starts or ends with them (too short to match anywhere). */
export const BLOCKED_WORDS: readonly string[] = [
  "fag", "fags", "rape", "raped", "kill", "killer", "murder", "sex", "sexy", "cum", "cock", "dick", "tits", "boob", "boobs",
  "anal", "xxx", "nsfw", "jew", "jews", "isis", "heil", "spic", "gook", "coon", "dyke", "rug", "rugged", "ponzi", "bomb",
];

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", $: "s" };

/** NFKC, lowercase, leetspeak folded, anything but a-z dropped. */
export function foldWord(raw: string): string {
  return String(raw ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[0134578@$]/g, (c) => LEET[c] ?? c)
    .replace(/[^a-z]/g, "");
}

const squeeze = (w: string) => w.replace(/(.)\1+/g, "$1");
const doubled = (w: string) => /(.)\1/.test(w);

/** The first blocked stem or word in one token (a word, or one side of a pool label), or null. */
export function blockedIn(token: string, o: { edges: boolean }): string | null {
  const raw = foldWord(token);
  if (!raw) return null;
  const sq = squeeze(raw);
  const formFor = (entry: string) => (doubled(entry) ? raw : sq);
  for (const s of BLOCKED_STEMS) if (formFor(s).includes(s)) return s;
  for (const b of BLOCKED_WORDS) {
    const w = formFor(b);
    if (w === b) return b;
    if (o.edges && b.length >= 3 && (w.startsWith(b) || w.endsWith(b))) return b;
  }
  return null;
}

/** Why a pool or token label must not be printed, or null. Each side of "a/b" is checked, edges included. */
export function labelBlocked(label: string | null | undefined): string | null {
  for (const side of String(label ?? "").split("/")) {
    const hit = blockedIn(side, { edges: true });
    if (hit) return hit;
  }
  return null;
}

/** The blocked words in a whole outgoing text (each word checked alone: stems anywhere inside it, short words whole). */
export function blockedWordsIn(text: string): string[] {
  const hits = new Set<string>();
  for (const token of String(text ?? "").split(/[\s/.,:;!?()"'\-]+/)) {
    const hit = blockedIn(token, { edges: false });
    if (hit) hits.add(hit);
  }
  return [...hits];
}
