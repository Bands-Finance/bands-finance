/**
 * Mr Bands' voice for the one line he says in public (docs/mr-bands-agent.md, section 2): lowercase,
 * always; no em dashes, ever; short. Applied at the journal's edge (src/index.ts) to every headline,
 * whoever wrote it (the model, the desk policy, an engine directive, a proposal), so the public record
 * never depends on each author remembering the rules.
 *
 * Kept as written: anything that looks like an on-chain address or an id with case in it (base58 is
 * case-sensitive, and a lowercased prefix points at a different account). Tickers are not addresses:
 * NVDAx reads nvdax, the way the voice samples write sol.
 */

export const HEADLINE_MAX = 90;

/** A word that must keep its case: it mixes digits with upper-case letters (5MGvNj, pair-Xs7Zd), or is a full base58 address. */
const caseSensitive = (word: string): boolean => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(word) || (/\d/.test(word) && /[A-Z]/.test(word) && /[a-z]/.test(word));

/** PURE. The line in Mr Bands' voice: dashes out, lowercase except addresses, whitespace collapsed, clipped to `max` on a word. */
export function voiceLine(s: string, max = HEADLINE_MAX): string {
  let out = (s ?? "")
    // an en dash between numbers is a range: keep it as a hyphen
    .replace(/(\d)\s*–\s*(\d)/g, "$1-$2")
    // every other em or en dash becomes a comma pause
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
  out = out
    .split(" ")
    .map((w) => (caseSensitive(w.replace(/[.,:;!?()"']/g, "")) ? w : w.toLowerCase()))
    .join(" ");
  out = out.replace(/,\s*,/g, ",").replace(/^,\s*/, "");
  if (out.length <= max) return out;
  const cut = out.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:\s]+$/, "");
}
