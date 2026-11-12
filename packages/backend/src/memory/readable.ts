/**
 * Memory you can read (MEM-READ-01 MR1): a short title and clean lines for a memory row.
 *
 * Title: the memory's own first heading; else the text before the first " — "
 * (an imported note's "<file-name>: " prefix dropped); else its first sentence.
 * Lines: the rest of the text with Markdown shown as plain words (no **, #,
 * backticks, link targets or list marks), joined, cut for two lines.
 * Deterministic and model-free: the same text always gives the same title, so
 * editing the heading renames the row. Hidden-key references stay as they are
 * (the client shows them as lock chips).
 */

const KEY_REF = /\[(?:SECRET:[a-z_]+:[a-z0-9]{6,32}|REDACTED:[a-z_]+)\]/g;
export const TITLE_CHARS = 90;
export const LINES_CHARS = 240;

/** "project-vps-ssh: VPS SSH access" -> "VPS SSH access" (an imported file name first). */
function dropFileName(s: string): string {
  return s.replace(/^(?:[a-z0-9]+[-_.][a-z0-9._-]*|[a-z0-9]+(?:[-_][a-z0-9]+)+)\s*:\s+/i, '');
}

/** Markdown shown as plain words, on one line. Hidden-key references are kept. */
export function plainWords(md: string): string {
  const held: string[] = [];
  let s = md.replace(KEY_REF, (m) => `\u0000${held.push(m) - 1}\u0000`);
  s = s.replace(/```[\s\S]*?(```|$)/g, (block) => block.replace(/```[a-z0-9]*\n?/gi, ' '))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, ' ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => held[Number(i)] ?? '');
}

function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const at = s.lastIndexOf(' ', max - 1);
  return `${s.slice(0, at > max * 0.6 ? at : max - 1).replace(/[\s,;:—-]+$/, '')}…`;
}

export interface Readable { title: string; lines: string }

/** The title and the clean lines of a memory text. */
export function readableMemory(content: string): Readable {
  const text = String(content ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) return { title: '', lines: '' };
  const heading = /^\s{0,3}#{1,3}\s+(.+)$/m.exec(text);
  const firstLine = text.split('\n').find((l) => l.trim()) ?? '';
  // Own heading on the first line: it is the title; the rest is the body.
  if (heading && firstLine.trim() === heading[0].trim()) {
    const body = text.slice(text.indexOf(heading[0]) + heading[0].length);
    return { title: cut(plainWords(heading[1]), TITLE_CHARS), lines: cut(plainWords(body), LINES_CHARS) };
  }
  const flat = dropFileName(text);
  const dash = flat.indexOf(' — ');
  if (dash > 0 && dash <= 120 && !flat.slice(0, dash).includes('\n')) {
    return { title: cut(plainWords(flat.slice(0, dash)), TITLE_CHARS), lines: cut(plainWords(flat.slice(dash + 3)), LINES_CHARS) };
  }
  const plain = plainWords(flat);
  const sentence = /^(.{12,}?[.!?])(\s|$)/.exec(plain);
  if (sentence && sentence[1].length <= TITLE_CHARS) return { title: sentence[1].replace(/[.]$/, ''), lines: cut(plain.slice(sentence[1].length).trim(), LINES_CHARS) };
  if (plain.length <= TITLE_CHARS) return { title: plain, lines: '' };
  return { title: cut(plain, 60), lines: cut(plain, LINES_CHARS) };
}
