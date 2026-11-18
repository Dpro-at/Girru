// MEM-READ-01 MR5: an agent's proposal as changes the owner accepts or discards one by one.
// Own small line diff (longest common subsequence over lines); documents here are short.

export interface Hunk {
  /** The line just before the change in the original (null at the top), to find the place again. */
  before: string | null;
  /** Lines removed and lines added. */
  old: string[];
  add: string[];
}

/** The changes from `a` to `b`, by lines. */
export function lineHunks(a: string, b: string): Hunk[] {
  const x = a.split('\n'), y = b.split('\n');
  if (x.length * y.length > 4_000_000) return a === b ? [] : [{ before: null, old: x, add: y }];
  const n = x.length, m = y.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: Hunk[] = [];
  let i = 0, j = 0, cur: Hunk | null = null;
  const flush = () => { if (cur && (cur.old.length || cur.add.length)) out.push(cur); cur = null; };
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { flush(); i++; j++; continue; }
    cur ??= { before: i > 0 ? x[i - 1] : null, old: [], add: [] };
    if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) cur.add.push(y[j++]);
    else cur.old.push(x[i++]);
  }
  flush();
  return out;
}

/** Apply one change to the current text; null when its place cannot be found any more. */
export function applyHunk(text: string, h: Hunk): string | null {
  const lines = text.split('\n');
  const fits = (k: number) => h.old.every((l, o) => lines[k + o] === l) && k + h.old.length <= lines.length;
  const places: number[] = [];
  for (let k = 0; k <= lines.length; k++) {
    if (h.before === null ? k !== 0 : lines[k - 1] !== h.before) continue;
    if (fits(k)) places.push(k);
  }
  if (!places.length && h.old.length) for (let k = 0; k <= lines.length - h.old.length; k++) if (fits(k)) places.push(k);
  if (!places.length) return null;
  const k = places[0];
  return [...lines.slice(0, k), ...h.add, ...lines.slice(k + h.old.length)].join('\n');
}

/** A short plain label for a change: "Add “SSH port: 2222”", "Remove 2 lines", "Change “Known issues”". */
export function hunkLabel(h: Hunk): string {
  const first = (l: string[]) => (l.find(s => s.trim()) ?? '').replace(/^[#>\-*\s]+|\*\*/g, '').trim();
  const q = (s: string) => `“${s.length > 48 ? s.slice(0, 47) + '…' : s}”`;
  if (!h.old.length) return `Add ${first(h.add) ? q(first(h.add)) : `${h.add.length} line${h.add.length === 1 ? '' : 's'}`}`;
  if (!h.add.length) return `Remove ${first(h.old) ? q(first(h.old)) : `${h.old.length} line${h.old.length === 1 ? '' : 's'}`}`;
  return `Change ${q(first(h.old) || first(h.add))}`;
}
