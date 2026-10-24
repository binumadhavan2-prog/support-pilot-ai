/**
 * Splits a markdown document into retrieval chunks.
 *
 * - Splits on headings first, then packs paragraphs up to `maxChars`, so a chunk rarely cuts a
 *   thought in half. A single oversized paragraph is split on sentence boundaries.
 * - Prefixes every chunk with "Title > Section" so a chunk stays understandable (and matchable)
 *   out of context. A chunk saying "Click Refund" is useless without knowing which page it is on.
 * - Default 1,200 chars (~300 tokens) stays well under the 512-token limit of the e5 embedder.
 */
export interface Chunk {
  index: number;
  content: string;
  /** Rough token estimate (chars / 4); good enough for budgeting, not for billing. */
  tokenCount: number;
}

export function chunkMarkdown(
  title: string,
  markdown: string,
  { maxChars = 1200 }: { maxChars?: number } = {},
): Chunk[] {
  const sections = splitSections(markdown);
  const texts: string[] = [];

  for (const { heading, body } of sections) {
    const context = heading ? `${title} > ${heading}` : title;
    const budget = Math.max(200, maxChars - context.length - 2);
    for (const piece of packParagraphs(body, budget)) texts.push(`${context}\n\n${piece}`);
  }

  return texts.map((content, index) => ({
    index,
    content,
    tokenCount: Math.ceil(content.length / 4),
  }));
}

function splitSections(markdown: string): { heading: string | null; body: string }[] {
  const sections: { heading: string | null; lines: string[] }[] = [{ heading: null, lines: [] }];
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) sections.push({ heading: match[1], lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }
  return sections
    .map((s) => ({ heading: s.heading, body: s.lines.join("\n").trim() }))
    .filter((s) => s.body.length > 0);
}

function packParagraphs(body: string, budget: number): string[] {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => (p.length > budget ? splitLong(p, budget) : [p]));

  const out: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + 2 + paragraph.length > budget) {
      out.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Splits on sentence ends; falls back to a hard cut for text with no sentence breaks. */
function splitLong(text: string, budget: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) ?? [text];
  const out: string[] = [];
  let current = "";
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (sentence.length > budget) {
      if (current) out.push(current);
      current = "";
      for (let i = 0; i < sentence.length; i += budget) out.push(sentence.slice(i, i + budget));
    } else if (current && current.length + 1 + sentence.length > budget) {
      out.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) out.push(current);
  return out;
}
