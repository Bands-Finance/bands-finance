import type { ReactNode } from "react";

/**
 * Render an agent's reply as readable blocks.
 *
 * The model writes prose, and it reaches for light markdown while doing it:
 * **emphasis**, `- ` bullets, the occasional heading. Dropped into a <pre> those
 * showed as literal asterisks and hyphens, which is the single scruffiest thing
 * about the old transcript.
 *
 * This is deliberately a SMALL subset (paragraphs, bullets, bold, inline code)
 * and it never builds HTML from model output. Everything below returns React
 * nodes from parsed segments, so there is no innerHTML anywhere and nothing the
 * agent writes can become markup. A fuller markdown renderer would be a bigger
 * surface for no benefit: this is chat, not a document.
 */

/** Split one line into plain / bold / code segments. */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // **bold** or `code`, whichever comes first, scanned left to right.
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] !== undefined) out.push(<strong key={`${keyBase}b${i}`}>{m[2]}</strong>);
    else out.push(<code key={`${keyBase}c${i}`}>{m[3]}</code>);
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length ? out : [text];
}

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

export function replyText(raw: string): ReactNode {
  const lines = raw.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let key = 0;

  const flushPara = () => {
    if (!para.length) return;
    const text = para.join(" ").trim();
    para = [];
    if (text) blocks.push(<p key={`p${key++}`}>{inline(text, `p${key}`)}</p>);
  };
  const flushList = () => {
    if (!list.length) return;
    const items = list;
    list = [];
    blocks.push(
      <ul key={`u${key++}`}>
        {items.map((it, n) => (
          <li key={n}>{inline(it, `u${key}i${n}`)}</li>
        ))}
      </ul>,
    );
  };

  for (const line of lines) {
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      flushList();
      // Rendered as emphasis rather than a real heading: these are three
      // sentences in a chat bubble, not a document outline.
      blocks.push(
        <p key={`h${key++}`} className="reply__lead">
          {inline(heading[1], `h${key}`)}
        </p>,
      );
      continue;
    }
    const item = BULLET.exec(line) ?? NUMBERED.exec(line);
    if (item) {
      flushPara();
      list.push(item[1]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();

  return blocks.length ? blocks : raw;
}
