// Document memory in the page (KNOW-INDEX-01, board K1): plain words for a
// file that can't be read, the PDF upload helper, and the status line of a
// project row. The wire rules live in doc-index-contract.js.
import { READ_PDF_PATH } from './doc-index-contract.js';
import type { DocProject } from './doc-index-contract.js';

/** 10 MB of PDF at most (Agent › Files and chat attachments). */
export const PDF_BYTES = 10 * 1024 * 1024;

/** The reason codes of a file that can't be read, in plain words (codes never show). */
export const PDF_UNREADABLE: Record<string, string> = {
  no_text: 'A scanned picture: there is no text in it.',
  encrypted: 'Locked with a password.',
  fonts: 'Its letters can’t be known from its fonts.',
  damaged: 'Damaged, or not a real PDF.',
  not_pdf: 'Damaged, or not a real PDF.',
  encoding: 'Not in a text format Girru can read.',
  binary: 'Not in a text format Girru can read.',
  too_large: 'Too large (over 20 MB).',
  unreadable: 'It can’t be read.',
};

/** A picked or dropped file as base64 (no data: prefix). */
export async function pdfBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

type Requester = { request: (r: never) => Promise<{ status: number; body: unknown }> };
/** A chat attachment: the PDF's text with its pages marked, or why it can't be read. */
export async function readPdf(client: Requester, file: Blob): Promise<{ text: string } | { reason: string }> {
  try {
    const r = await client.request({ method: 'POST', path: READ_PDF_PATH, body: { data: await pdfBase64(file) } } as never);
    if (r.status !== 200) return { reason: 'unreadable' };
    return r.body as { text: string } | { reason: string };
  } catch { return { reason: 'unreadable' }; }
}

/** One quiet line under a project: Up to date · Reading… · Not read. */
export function statusLine(p: DocProject, now = Date.now()): string {
  if (!p.hasFolder) return 'No folder on this computer';
  const s = p.source;
  if (!s || !s.enabled) return 'Not read';
  if (s.state === 'running' || s.state === 'pending') return s.files ? `Reading… ${s.files} files so far` : 'Reading…';
  if (s.state === 'error') return 'Could not be read this time · tries again soon';
  const ago = s.scannedAt ? Math.max(0, Math.round((now - Date.parse(s.scannedAt)) / 60000)) : null;
  const when = ago === null ? '' : ago < 1 ? ' · read just now' : ago < 60 ? ` · read ${ago} min ago` : ago < 1440 ? ` · read ${Math.round(ago / 60)} h ago` : ` · read ${Math.round(ago / 1440)} d ago`;
  return `Up to date · ${s.files} ${s.files === 1 ? 'file' : 'files'}${when}`;
}

/** A citation as the chip and the details say it: "spec.pdf · p. 2" or "guide.md › Setup". */
export function citeLabel(c: { file: string; page: number | null; heading: string | null }, short = true): string {
  const name = short ? c.file.split('/').pop() ?? c.file : c.file;
  if (c.page !== null) return short ? `${name} · p. ${c.page}` : `${name} · page ${c.page}`;
  const h = c.heading?.split(' › ').pop();
  return h ? `${name} › ${h}` : name;
}
