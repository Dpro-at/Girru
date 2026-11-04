/**
 * Document chunks (KNOW-INDEX-01): a file's text in pieces small enough for
 * one recalled line, each with where it came from.
 *
 *   Markdown  split at headings (#, ##, …); a chunk carries its heading path
 *             ("Setup › Ports") so the answer can be cited by section
 *   PDF       split per page; a chunk carries its page number (1-based)
 *   text      split at blank lines
 *
 * Inside a section or page, paragraphs are packed up to CHUNK_CHARS; a
 * longer paragraph is cut at sentence ends (else at a space). Consecutive
 * chunks of one section share up to OVERLAP_CHARS (the end of the previous
 * one), so a fact cut in two is still found whole in one of them.
 */

export const CHUNK_CHARS = 900;
export const OVERLAP_CHARS = 160;
export const MAX_CHUNKS_PER_FILE = 1500;

export interface DocChunk { page: number | null; heading: string | null; text: string }

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Paragraphs of a block of text (blank lines), whitespace tidied. */
function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n/).map((p) => p.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()).filter(Boolean);
}

/** Cut one long paragraph at sentence ends (else at a space) into pieces of at most `max`. */
function cutLong(p: string, max: number): string[] {
  const out: string[] = [];
  let rest = p;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let at = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '), window.lastIndexOf('.\n'), window.lastIndexOf('۔ '), window.lastIndexOf('؟ '));
    if (at < max * 0.4) at = window.lastIndexOf(' ');
    if (at < max * 0.4) at = max - 1;
    out.push(rest.slice(0, at + 1).trim());
    rest = rest.slice(at + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** The tail of a chunk carried into the next one (whole words). */
function overlapOf(text: string): string {
  if (text.length <= OVERLAP_CHARS) return '';
  const tail = text.slice(-OVERLAP_CHARS);
  const sp = tail.indexOf(' ');
  return sp >= 0 ? tail.slice(sp + 1) : tail;
}

function pack(text: string, page: number | null, heading: string | null, out: DocChunk[]): void {
  let cur = '';
  const flush = () => {
    const t = cur.trim();
    if (t && out.length < MAX_CHUNKS_PER_FILE) out.push({ page, heading, text: t });
    cur = t ? overlapOf(t) : '';
  };
  for (const para of paragraphs(text).flatMap((p) => cutLong(p, CHUNK_CHARS - OVERLAP_CHARS))) {
    if (cur && cur.length + para.length + 2 > CHUNK_CHARS) flush();
    cur = cur ? `${cur}\n\n${para}` : para;
  }
  // Only an overlap left: it is already in the chunk before.
  if (cur.trim() && (out.length === 0 || out[out.length - 1].text.endsWith(cur.trim()) === false)) flush();
}

export function chunkMarkdown(text: string): DocChunk[] {
  const out: DocChunk[] = [];
  const path: string[] = [];
  let body: string[] = [];
  let fence = false;
  const heading = () => (path.filter(Boolean).length ? path.filter(Boolean).join(' › ') : null);
  const section = () => { if (body.join('').trim()) pack(body.join('\n'), null, heading(), out); body = []; };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : HEADING.exec(line);
    if (m) {
      section();
      const level = m[1].length;
      path.length = level - 1;
      path[level - 1] = m[2].replace(/[*_`]/g, '').trim().slice(0, 120);
      continue;
    }
    body.push(line);
  }
  section();
  return out;
}

export function chunkText(text: string): DocChunk[] {
  const out: DocChunk[] = [];
  pack(text.replace(/\r\n?/g, '\n'), null, null, out);
  return out;
}

export function chunkPages(pages: ReadonlyArray<{ page: number; text: string }>): DocChunk[] {
  const out: DocChunk[] = [];
  // PDF lines end where the layout wrapped them: a line break inside a paragraph is a space.
  for (const p of pages) pack(p.text.replace(/([^\n])\n(?=[^\n])/g, '$1 '), p.page, null, out);
  return out;
}
