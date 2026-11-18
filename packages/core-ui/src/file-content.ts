/** Read-only kinds supported by the chat's existing file pane. */
export function fileKind(path: string) {
  return /\.(docx|xlsx|pptx)$/i.test(path) ? 'office' : /\.(md|markdown|mdx)$/i.test(path) ? 'md' : /\.html?$/i.test(path) ? 'html' : /\.pdf$/i.test(path) ? 'pdf'
    : /\.(png|jpe?g|gif|webp|svg)$/i.test(path) ? 'image' : /\.(mp4|webm)$/i.test(path) ? 'video'
    : /\.(mp3|wav|m4a)$/i.test(path) ? 'audio' : /\.json$/i.test(path) ? 'json' : /\.csv$/i.test(path) ? 'csv' : 'text';
}
export const mediaKind = (path: string) => ['image', 'video', 'audio'].includes(fileKind(path));
export const pointerChild = (pointer: string, key: string) => `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;

/** RFC-style quoted cells; strings stay strings, including formulas and leading zeroes. */
export function csvRows(text: string, maxRows = 1000, maxCols = 200): { rows: string[][]; truncated: boolean; error?: string } {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, closed = false;
  const push = () => { row.push(cell); cell = ''; closed = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += c;
    } else if (c === '"' && !cell && !closed) quoted = true;
    else if (c === ',' || c === '\n' || c === '\r') {
      push();
      if (row.length > maxCols) return { rows, truncated: true };
      if (c !== ',') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        rows.push(row); row = [];
        if (rows.length >= maxRows) return { rows, truncated: i < text.length - 1 };
      }
    } else if (closed || c === '"') return { rows: [], truncated: false, error: 'This CSV has an invalid quoted cell. Open Source to read it.' };
    else cell += c;
  }
  if (quoted) return { rows: [], truncated: false, error: 'This CSV has an unfinished quoted cell. Open Source to read it.' };
  if (cell || row.length || closed) { push(); if (row.length > maxCols) return { rows, truncated: true }; rows.push(row); }
  return { rows, truncated: false };
}
