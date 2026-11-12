/**
 * More text file types (MEM-READ-01 MR8). Own code, no packages: .docx, .xlsx and
 * .pptx and OpenDocument (.odt .ods .odp) are zip folders of XML, opened with
 * node:zlib and a small reader here; .csv, .rtf, .html, .json and .yaml are text.
 * Text only, by decision: no pictures, no OCR, no old .doc/.xls/.ppt.
 *
 * Each reader gives sections (a page, a sheet, a slide) with a label to cite, and
 * one plain line on how it was read ("3 sheets", "18 slides with notes"). A file
 * it cannot read says why. Never follows anything outside the file; sizes are capped.
 */

import { inflateRawSync } from 'node:zlib';

export type OfficeKind = 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'odp' | 'csv' | 'rtf' | 'html' | 'json' | 'yaml';
export const OFFICE_EXT: Record<string, OfficeKind> = {
  '.docx': 'docx', '.xlsx': 'xlsx', '.pptx': 'pptx', '.odt': 'odt', '.ods': 'ods', '.odp': 'odp',
  '.csv': 'csv', '.rtf': 'rtf', '.html': 'html', '.htm': 'html', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
};
/** Kinds Girru knows but does not read, with the plain reason. */
export const NOT_READ_EXT: Record<string, string> = {
  '.doc': 'old Word format; save it as .docx', '.xls': 'old Excel format; save it as .xlsx', '.ppt': 'old PowerPoint format; save it as .pptx',
  '.zip': 'archives are skipped', '.rar': 'archives are skipped', '.7z': 'archives are skipped', '.tar': 'archives are skipped', '.gz': 'archives are skipped',
};

export const MAX_ROWS = 5000;
export const CSV_ROWS = 200;
const MAX_ENTRY = 30 * 1024 * 1024; // one XML part, unpacked
const MAX_UNPACKED = 60 * 1024 * 1024; // all parts of one file together (a zip bomb stops here)
const MAX_SLIDES = 500;
const MAX_ROW_CHARS = 4000;
const MAX_TEXT = 2_000_000;

export interface Section { label: string; text: string }
export type OfficeResult = { ok: true; sections: Section[]; info: string; count: number } | { ok: false; reason: string };

// ---------------------------------------------------------------- zip (central directory, stored or deflated entries)

export function zipEntries(buf: Buffer): Map<string, () => Buffer> {
  const out = new Map<string, () => Buffer>();
  // End of central directory: the last 22..65557 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw Error('not_zip');
  const count = buf.readUInt16LE(eocd + 10), size = buf.readUInt32LE(eocd + 12), offset = buf.readUInt32LE(eocd + 16);
  if (offset + size > buf.length || count > 20000) throw Error('not_zip');
  let unpacked = 0; // one running budget for every part of this file
  let p = offset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw Error('not_zip');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + elen + clen;
    if (flags & 1) throw Error('encrypted');
    if (name.endsWith('/') || name.includes('..') || name.startsWith('/')) continue;
    out.set(name, () => {
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw Error('not_zip');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      if (usize > MAX_ENTRY || start + csize > buf.length) throw Error('too_big');
      const raw = buf.subarray(start, start + csize);
      const room = Math.min(MAX_ENTRY, MAX_UNPACKED - unpacked);
      if (room <= 0) throw Error('too_big');
      let out: Buffer;
      if (method === 0) out = Buffer.from(raw);
      else if (method === 8) { try { out = inflateRawSync(raw, { maxOutputLength: room }); } catch (e) { throw Error((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'too_big' : 'not_zip'); } }
      else throw Error('unsupported');
      unpacked += out.length;
      if (unpacked > MAX_UNPACKED) throw Error('too_big');
      return out;
    });
  }
  return out;
}

// ---------------------------------------------------------------- a small XML reader (text and a few structure tags)

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    return ENT[e.toLowerCase()] ?? m;
  });
}

/**
 * Walk tags in order: (name, attrs, selfClosing) for opening tags, ('/name') for closing, and text runs.
 * Linear: each step finds the next '<' and its end with indexOf, so a hostile file cannot make it slow;
 * an unterminated construct is the end of the input.
 */
function* xmlTokens(xml: string): Generator<{ tag: string; attrs: string; self: boolean } | { text: string }> {
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) { yield { text: unescapeXml(xml.slice(i)) }; return; }
    if (lt > i) yield { text: unescapeXml(xml.slice(i, lt)) };
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt + 4); if (e < 0) return; i = e + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) { const e = xml.indexOf(']]>', lt + 9); if (e < 0) return; yield { text: xml.slice(lt + 9, e) }; i = e + 3; continue; }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) { const e = xml.indexOf('>', lt + 2); if (e < 0) return; i = e + 1; continue; }
    const gt = xml.indexOf('>', lt + 1);
    if (gt < 0) return;
    const inner = xml.slice(lt + 1, gt);
    const close = inner.startsWith('/');
    const body = close ? inner.slice(1) : inner;
    let k = 0; while (k < body.length && /[\w:.-]/.test(body[k])) k++;
    const name = body.slice(0, k);
    if (name && /^[A-Za-z_]/.test(name)) {
      const rest = body.slice(k);
      const self = !close && rest.endsWith('/');
      yield { tag: (close ? '/' : '') + name, attrs: self ? rest.slice(0, -1) : rest, self };
    }
    i = gt + 1;
  }
}
const attr = (attrs: string, name: string) => { const m = new RegExp(`(?:^|\\s)${name.replace(/[:.]/g, '\\$&')}="([^"]*)"`).exec(attrs); return m ? unescapeXml(m[1]) : null; };

// ---------------------------------------------------------------- formats

/** Relationship id -> part path for one part's .rels (targets are relative to that part's folder). */
function relations(z: Map<string, () => Buffer>, partPath: string): Map<string, { target: string; type: string }> {
  const dir = partPath.includes('/') ? partPath.slice(0, partPath.lastIndexOf('/')) : '';
  const relsPath = `${dir ? `${dir}/` : ''}_rels/${partPath.slice(dir ? dir.length + 1 : 0)}.rels`;
  const out = new Map<string, { target: string; type: string }>();
  const rels = z.get(relsPath); if (!rels) return out;
  for (const t of xmlTokens(rels().toString('utf8'))) {
    if (!('tag' in t) || t.tag !== 'Relationship' || attr(t.attrs, 'TargetMode') === 'External') continue;
    const id = attr(t.attrs, 'Id'), to = attr(t.attrs, 'Target');
    if (!id || !to) continue;
    // Resolve "../x", "./x" and "/x" against the part's folder, never outside the package.
    const parts = (to.startsWith('/') ? to.slice(1) : `${dir ? `${dir}/` : ''}${to}`).split('/');
    const norm: string[] = []; for (const p of parts) { if (p === '..') norm.pop(); else if (p && p !== '.') norm.push(p); }
    out.set(id, { target: norm.join('/'), type: (attr(t.attrs, 'Type') ?? '').split('/').at(-1) ?? '' });
  }
  return out;
}

/** The text of one WordprocessingML part: paragraphs, headings as "#", lists as "-", tables as rows with " | ". */
function wordLines(xml: string, count?: { tables: number }): string[] {
  const lines: string[] = []; let line = '', heading = 0, list = false, inCell = 0, row: string[] = [], cell = '', inText = false, inDel = false;
  for (const t of xmlTokens(xml)) {
    if ('text' in t) { if (!inText || inDel) continue; if (inCell) cell += t.text; else line += t.text; continue; }
    const n = t.tag;
    if (n === 'w:t' || n === 'w:delText') { inText = !t.self && n === 'w:t'; continue; }
    if (n === '/w:t' || n === '/w:delText') { inText = false; continue; }
    if (n === 'w:del') inDel = !t.self; else if (n === '/w:del') inDel = false; // deleted tracked changes are not the text
    else if (n === 'w:pStyle') { const v = attr(t.attrs, 'w:val') ?? ''; const h = /^(?:Heading|berschrift|Titre|Title)(\d?)/i.exec(v); if (h) heading = Number(h[1] || 1); if (/List/i.test(v)) list = true; }
    else if (n === 'w:numPr') list = true;
    else if (n === 'w:tab') { if (inCell) cell += ' '; else line += '\t'; }
    else if (n === 'w:br' || n === 'w:cr') { if (inCell) cell += ' '; else line += '\n'; }
    else if (n === 'w:noBreakHyphen') { if (inCell) cell += '-'; else line += '-'; }
    else if (n === 'w:tbl') { if (count) count.tables++; }
    else if (n === 'w:tc') { if (!inCell) cell = ''; inCell++; }
    else if (n === '/w:tc') { inCell = Math.max(0, inCell - 1); if (!inCell) row.push(cell.replace(/\s+/g, ' ').trim()); }
    else if (n === '/w:tr' && !inCell) { if (row.some(Boolean)) lines.push(row.join(' | ').slice(0, MAX_ROW_CHARS)); row = []; }
    else if (n === '/w:p' && !inCell) { const s = line.trim(); if (s) lines.push(heading ? `${'#'.repeat(Math.min(heading, 4))} ${s}` : list ? `- ${s}` : s); line = ''; heading = 0; list = false; }
    else if (n === '/w:p' && inCell) cell += ' ';
  }
  return lines;
}

/** Word: the body, then footnotes and endnotes, and the headers/footers once each (they repeat on every page). */
function docx(z: Map<string, () => Buffer>): OfficeResult {
  const main = [...relations(z, '').values()].find(r => r.type === 'officeDocument')?.target ?? 'word/document.xml';
  const part = z.get(main) ?? z.get('word/document.xml'); if (!part) return { ok: false, reason: 'no document text' };
  const count = { tables: 0 };
  const sections: Section[] = [];
  const body = wordLines(part().toString('utf8'), count);
  if (body.length) sections.push({ label: 'document', text: body.join('\n') });
  const rels = [...relations(z, main).values()];
  const notes: string[] = [];
  for (const kind of ['footnotes', 'endnotes']) for (const r of rels.filter(x => x.type === kind)) notes.push(...wordLines(z.get(r.target)?.().toString('utf8') ?? '').filter(l => !/^\d+$/.test(l)));
  if (notes.length) sections.push({ label: 'notes', text: `## Notes\n${notes.join('\n')}` });
  const hf = new Set<string>();
  for (const r of rels.filter(x => x.type === 'header' || x.type === 'footer')) for (const l of wordLines(z.get(r.target)?.().toString('utf8') ?? '')) if (!/^(?:page\s*)?\d+(?:\s*(?:of|\/)\s*\d+)?$/i.test(l)) hf.add(l);
  if (hf.size) sections.push({ label: 'headers and footers', text: `## Headers and footers\n${[...hf].join('\n')}` });
  if (!sections.length) return { ok: false, reason: 'no text in it' };
  const pages = Number(/<Pages>(\d+)<\/Pages>/.exec(z.get('docProps/app.xml')?.().toString('utf8') ?? '')?.[1] ?? 0);
  const tables = count.tables;
  return { ok: true, sections, count: pages || 1, info: [pages ? `${pages} ${pages === 1 ? 'page' : 'pages'}` : null, tables ? `${tables} ${tables === 1 ? 'table' : 'tables'}` : null, notes.length ? 'notes' : null].filter(Boolean).join(', ') || 'text' };
}

/** Excel serial day -> ISO date (1900 system; the 1904 system when the workbook says so). */
function excelDate(serial: number, d1904: boolean): string {
  if (!Number.isFinite(serial)) return String(serial);
  const ms = Math.round((serial + (d1904 ? 1462 : 0) - 25569) * 86400000);
  const d = new Date(ms); if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return serial % 1 ? iso.slice(0, 16).replace('T', ' ') : iso.slice(0, 10);
}
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const BUILTIN_PERCENT = new Set([9, 10]);

/**
 * Excel: each tab in the workbook's own order (not the file names), followed through the relationships;
 * chart sheets have no cells and are left out; hidden tabs are marked. Cells: shared and inline strings
 * (rich text runs joined), formula strings, booleans, errors, numbers; dates and percentages as the sheet shows them.
 */
function xlsx(z: Map<string, () => Buffer>): OfficeResult {
  const book = [...relations(z, '').values()].find(r => r.type === 'officeDocument')?.target ?? 'xl/workbook.xml';
  const shared: string[] = [];
  const rels = relations(z, book);
  const ssPath = [...rels.values()].find(r => r.type === 'sharedStrings')?.target ?? 'xl/sharedStrings.xml';
  const ss = z.get(ssPath);
  if (ss) { let cur = '', inSi = false, inT = false, inRPh = false; for (const t of xmlTokens(ss().toString('utf8'))) { if ('text' in t) { if (inSi && inT && !inRPh && cur.length < MAX_ROW_CHARS) cur += t.text; } else if (t.tag === 'si') { inSi = true; cur = ''; } else if (t.tag === '/si') { inSi = false; shared.push(cur); } else if (t.tag === 't') inT = !t.self; else if (t.tag === '/t') inT = false; else if (t.tag === 'rPh') inRPh = true; else if (t.tag === '/rPh') inRPh = false; } }
  // Styles: which cell style is a date or a percentage.
  const stylesPath = [...rels.values()].find(r => r.type === 'styles')?.target ?? 'xl/styles.xml';
  const custom = new Map<number, string>(); const xfFmt: number[] = []; let inXfs = false;
  for (const t of xmlTokens(z.get(stylesPath)?.().toString('utf8') ?? '')) {
    if (!('tag' in t)) continue;
    if (t.tag === 'numFmt') custom.set(Number(attr(t.attrs, 'numFmtId')), attr(t.attrs, 'formatCode') ?? '');
    else if (t.tag === 'cellXfs') inXfs = !t.self; else if (t.tag === '/cellXfs') inXfs = false;
    else if (t.tag === 'xf' && inXfs) xfFmt.push(Number(attr(t.attrs, 'numFmtId') ?? 0));
  }
  const kindOfStyle = (s: number): 'date' | 'percent' | null => {
    const id = xfFmt[s]; if (id === undefined) return null;
    if (BUILTIN_DATE.has(id)) return 'date'; if (BUILTIN_PERCENT.has(id)) return 'percent';
    const code = (custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    if (/%/.test(code)) return 'percent';
    return /[dmyhs]/i.test(code) && !/^[#0.,\s]*$/.test(code) ? 'date' : null;
  };
  const bookXml = z.get(book)?.().toString('utf8') ?? '';
  const d1904 = /<workbookPr\b[^>]*date1904="(?:1|true)"/.test(bookXml.slice(0, 20000));
  const tabs = [...xmlTokens(bookXml)].filter((t): t is { tag: string; attrs: string; self: boolean } => 'tag' in t && t.tag === 'sheet');
  const sections: Section[] = []; let limited = false, charts = 0, hidden = 0;
  for (const [i, tab] of tabs.slice(0, 50).entries()) {
    const name = attr(tab.attrs, 'name') ?? `Sheet ${i + 1}`;
    const rel = rels.get(attr(tab.attrs, 'r:id') ?? '');
    if (rel?.type === 'chartsheet' || rel?.target.includes('chartsheets/')) { charts++; continue; }
    const part = z.get(rel?.target ?? `xl/worksheets/sheet${i + 1}.xml`); if (!part) continue;
    const isHidden = (attr(tab.attrs, 'state') ?? 'visible') !== 'visible'; if (isHidden) hidden++;
    const rows: string[] = []; let row: string[] = [], val = '', type = '', style = -1, inV = false, inIs = false, inT = false, col = 0;
    const colOf = (ref: string | null) => { const m = /^([A-Z]+)/.exec(ref ?? ''); if (!m) return -1; let n = 0; for (const ch of m[1]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
    for (const t of xmlTokens(part().toString('utf8'))) {
      if ('text' in t) { if (inV || (inIs && inT)) val += t.text; continue; }
      if (t.tag === 'c') {
        type = attr(t.attrs, 't') ?? 'n'; style = Number(attr(t.attrs, 's') ?? -1); val = '';
        const at = colOf(attr(t.attrs, 'r'));
        while (at > col && row.length < at && row.length < 200) { row.push(''); col++; } // empty cells between keep the columns in place
        if (t.self) { row.push(''); col++; }
      }
      else if (t.tag === 'v') inV = !t.self; else if (t.tag === '/v') inV = false;
      else if (t.tag === 'is') inIs = true; else if (t.tag === '/is') inIs = false;
      else if (t.tag === 't') inT = !t.self; else if (t.tag === '/t') inT = false;
      else if (t.tag === '/c') {
        const raw = val.trim(); let shown = raw;
        if (type === 's') shown = (shared[Number(raw)] ?? '').slice(0, MAX_ROW_CHARS);
        else if (type === 'b') shown = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
        else if (type === 'n' && raw) { const k = style >= 0 ? kindOfStyle(style) : null; const num = Number(raw); if (k === 'date') shown = excelDate(num, d1904); else if (k === 'percent' && Number.isFinite(num)) shown = `${+(num * 100).toFixed(4)}%`; }
        if (row.join('').length < MAX_ROW_CHARS) row.push(shown.slice(0, MAX_ROW_CHARS)); col++;
      }
      else if (t.tag === 'row') { row = []; col = 0; }
      else if (t.tag === '/row') { while (row.length && !row.at(-1)) row.pop(); if (row.some(Boolean)) { if (rows.length >= MAX_ROWS) { limited = true; break; } rows.push(row.join(' | ').slice(0, MAX_ROW_CHARS)); } row = []; col = 0; }
    }
    if (rows.length) sections.push({ label: `sheet ${name}`, text: `## ${name}${isHidden ? ' (hidden)' : ''}\n${rows.join('\n')}` });
  }
  if (!sections.length) return { ok: false, reason: charts ? 'only charts, no cells' : 'no cells with text' };
  return { ok: true, sections, count: sections.length, info: `${sections.length} ${sections.length === 1 ? 'sheet' : 'sheets'}${hidden ? `, ${hidden} hidden` : ''}${limited ? `, first ${MAX_ROWS} rows each` : ''}` };
}

/** PowerPoint: slides in the presentation's own order (not the file numbers), each with its notes found through the slide's relationships. */
function pptx(z: Map<string, () => Buffer>): OfficeResult {
  const textOf = (b: Buffer) => { const paras: string[] = []; let cur = '', inT = false; for (const t of xmlTokens(b.toString('utf8'))) { if ('text' in t) { if (inT) cur += t.text; } else if (t.tag === 'a:t') inT = !t.self; else if (t.tag === '/a:t') inT = false; else if (t.tag === '/a:p') { if (cur.trim()) paras.push(cur.trim()); cur = ''; } else if (t.tag === 'a:br') cur += ' '; } return paras; };
  const pres = [...relations(z, '').values()].find(r => r.type === 'officeDocument')?.target ?? 'ppt/presentation.xml';
  const presRels = relations(z, pres);
  let slides = [...xmlTokens(z.get(pres)?.().toString('utf8') ?? '')].filter((t): t is { tag: string; attrs: string; self: boolean } => 'tag' in t && t.tag === 'p:sldId')
    .map(t => presRels.get(attr(t.attrs, 'r:id') ?? '')?.target).filter((x): x is string => !!x && z.has(x));
  if (!slides.length) { const num = (s: string) => Number(/(\d+)\.xml$/.exec(s)?.[1] ?? 0); slides = [...z.keys()].filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => num(a) - num(b)); }
  slides = slides.slice(0, MAX_SLIDES);
  let notes = 0; const sections: Section[] = [];
  for (const [i, s] of slides.entries()) {
    const n = i + 1, body = textOf(z.get(s)!());
    const notePath = [...relations(z, s).values()].find(r => r.type === 'notesSlide')?.target ?? `ppt/notesSlides/notesSlide${/(\d+)\.xml$/.exec(s)?.[1] ?? 0}.xml`;
    const note = notePath ? z.get(notePath) : undefined;
    const noteText = note ? textOf(note()).filter((p) => !/^\d+$/.test(p)) : [];
    if (noteText.length) notes++;
    if (body.length || noteText.length) sections.push({ label: `slide ${n}`, text: `## Slide ${n}\n${body.join('\n')}${noteText.length ? `\nNotes: ${noteText.join(' ')}` : ''}` });
  }
  if (!sections.length) return { ok: false, reason: 'no text on the slides' };
  return { ok: true, sections, count: slides.length, info: `${slides.length} ${slides.length === 1 ? 'slide' : 'slides'}${notes ? ' with notes' : ''}` };
}

/** OpenDocument (.odt .ods .odp): content.xml paragraphs, table rows (repeated cells and rows counted), pages. */
function openDocument(z: Map<string, () => Buffer>, kind: 'odt' | 'ods' | 'odp'): OfficeResult {
  const part = z.get('content.xml'); if (!part) return { ok: false, reason: 'no content in it' };
  const sections: Section[] = []; let lines: string[] = [], line = '', cell = '', row: string[] = [], depthP = 0, inCell = false, label = '', heading = 0, repeatCell = 1, repeatRow = 1, hiddenSheets = 0;
  const flush = () => { if (lines.length) sections.push({ label: label || (kind === 'odt' ? 'document' : 'part'), text: (label ? `## ${label.replace(/^\w+ /, '')}\n` : '') + lines.join('\n') }); lines = []; };
  // Each cell is cut first and a row stops growing at MAX_ROW_CHARS, so a repeated cell cannot blow up.
  let rowChars = 0;
  const pushCell = (v: string) => { const c = v.slice(0, MAX_ROW_CHARS); for (let k = 0; k < Math.min(repeatCell, 200) && row.length < 200 && rowChars < MAX_ROW_CHARS; k++) { row.push(c); rowChars += c.length + 3; } };
  for (const t of xmlTokens(part().toString('utf8'))) {
    if ('text' in t) { if (depthP) { if (inCell) cell += t.text; else line += t.text; } continue; }
    const n = t.tag;
    if (n === 'table:table' && kind === 'ods') { flush(); const name = attr(t.attrs, 'table:name') ?? String(sections.length + 1); label = `sheet ${name}`; if (attr(t.attrs, 'table:display') === 'false') hiddenSheets++; }
    else if (n === 'draw:page' && kind === 'odp') { flush(); label = `slide ${sections.length + 1}`; }
    else if ((n === 'text:p' || n === 'text:h') && !t.self) { depthP++; if (n === 'text:h') heading = Number(attr(t.attrs, 'text:outline-level') ?? 1); }
    else if (n === '/text:p' || n === '/text:h') { depthP = Math.max(0, depthP - 1); if (!inCell) { const s = line.trim(); if (s) lines.push(heading ? `${'#'.repeat(Math.min(heading, 4))} ${s}` : s); line = ''; heading = 0; } else cell += ' '; }
    else if (n === 'text:tab' || n === 'text:line-break') { if (inCell) cell += ' '; else line += ' '; }
    else if (n === 'text:s') { const c = Math.min(Number(attr(t.attrs, 'text:c') ?? 1) || 1, 20); if (inCell) cell += ' '.repeat(c); else line += ' '.repeat(c); }
    else if (n === 'table:table-row') { row = []; rowChars = 0; repeatRow = Math.max(1, Number(attr(t.attrs, 'table:number-rows-repeated') ?? 1) || 1); }
    else if (n === 'table:table-cell' || n === 'table:covered-table-cell') { repeatCell = Math.max(1, Number(attr(t.attrs, 'table:number-columns-repeated') ?? 1) || 1); if (t.self) pushCell(''); else { inCell = true; cell = ''; } }
    else if (n === '/table:table-cell' || n === '/table:covered-table-cell') { inCell = false; pushCell(cell.replace(/\s+/g, ' ').trim()); }
    else if (n === '/table:table-row') { while (row.length && !row.at(-1)) row.pop(); if (row.some(Boolean)) { const line1 = row.join(' | ').slice(0, MAX_ROW_CHARS); for (let k = 0; k < Math.min(repeatRow, 50) && lines.length < MAX_ROWS; k++) lines.push(line1); } row = []; rowChars = 0; }
  }
  flush();
  if (!sections.length) return { ok: false, reason: 'no text in it' };
  const word = kind === 'ods' ? 'sheet' : kind === 'odp' ? 'slide' : 'part';
  return { ok: true, sections, count: sections.length, info: kind === 'odt' ? 'text' : `${sections.length} ${word}${sections.length === 1 ? '' : 's'}${hiddenSheets ? `, ${hiddenSheets} hidden` : ''}` };
}

/** CSV: the columns and the first CSV_ROWS rows (quoted fields understood). */
function csv(text: string): OfficeResult {
  const rows: string[][] = []; let field = '', row: string[] = [], q = false;
  const sep = (text.split('\n', 1)[0].match(/;/g)?.length ?? 0) > (text.split('\n', 1)[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  for (let i = 0; i < text.length && rows.length <= CSV_ROWS; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c; continue; }
    if (c === '"') q = true; else if (c === sep) { row.push(field.trim()); field = ''; } else if (c === '\n') { row.push(field.trim()); rows.push(row); row = []; field = ''; } else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field.trim()); rows.push(row); }
  const lines = rows.filter((r) => r.some(Boolean)).slice(0, CSV_ROWS + 1).map((r) => r.join(' | '));
  if (!lines.length) return { ok: false, reason: 'empty' };
  return { ok: true, sections: [{ label: 'table', text: lines.join('\n') }], count: lines.length - 1, info: lines.length - 1 >= CSV_ROWS ? `columns and the first ${CSV_ROWS} rows` : `${lines.length - 1} rows` };
}

/** RTF: text with control words and groups removed (\par as a new line, \uN as the character). */
export function rtfText(src: string): string {
  let out = '', depth = 0; const skip: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{') { depth++; if (/^\{\\\*|^\{\\(?:fonttbl|colortbl|stylesheet|info|pict|header|footer)\b/.test(src.slice(i, i + 12))) skip.push(depth); continue; }
    if (c === '}') { if (skip.at(-1) === depth) skip.pop(); depth--; continue; }
    if (c === '\\') {
      const m = /^\\(?:([a-z]+)(-?\d+)? ?|'([0-9a-f]{2})|(.))/i.exec(src.slice(i, i + 40));
      if (!m) continue;
      i += m[0].length - 1;
      if (skip.length) continue;
      if (m[1] === 'par' || m[1] === 'line') out += '\n'; else if (m[1] === 'tab') out += '\t';
      else if (m[1] === 'u' && m[2]) { out += String.fromCharCode(Number(m[2]) < 0 ? Number(m[2]) + 65536 : Number(m[2])); if (src[i + 1] === '?') i++; }
      else if (m[3]) out += String.fromCharCode(parseInt(m[3], 16));
      else if (m[4] && '{}\\'.includes(m[4])) out += m[4];
      continue;
    }
    if (!skip.length && c !== '\r' && c !== '\n') out += c;
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** HTML: visible text; headings as "#", list items as "-"; scripts and styles dropped. */
/** Drop script/style/noscript/template blocks and comments with indexOf (linear, also on unterminated input). */
function stripBlocks(src: string): string {
  const lower = src.toLowerCase(); let out = '', i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { out += src.slice(i); break; }
    out += src.slice(i, lt);
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); if (e < 0) break; i = e + 3; out += ' '; continue; }
    const m = /^<(script|style|noscript|template)\b/.exec(lower.slice(lt, lt + 12));
    if (m) { const e = lower.indexOf(`</${m[1]}`, lt + 1); if (e < 0) break; const gt = lower.indexOf('>', e); i = gt < 0 ? src.length : gt + 1; out += ' '; continue; }
    out += '<'; i = lt + 1;
  }
  return out;
}

export function htmlText(src: string): string {
  // The linear tokenizer, not regular expressions over the whole input.
  let out = '';
  const BREAK = new Set(['br', '/p', '/div', '/h1', '/h2', '/h3', '/h4', '/h5', '/h6', '/li', '/tr', '/table', '/section', '/article']);
  for (const t of xmlTokens(stripBlocks(src))) {
    if ('text' in t) { out += t.text; continue; }
    const tag = t.tag.toLowerCase();
    const h = /^h([1-4])$/.exec(tag);
    if (h) out += `\n${'#'.repeat(Number(h[1]))} `;
    else if (tag === 'li') out += '\n- ';
    else if (tag === '/td' || tag === '/th') out += ' | ';
    else if (BREAK.has(tag)) out += '\n';
  }
  return out.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
}

/** Read one file's bytes of a known office/text kind. */
export function officeText(kind: OfficeKind, data: Buffer): OfficeResult {
  try {
    if (kind === 'docx' || kind === 'xlsx' || kind === 'pptx' || kind === 'odt' || kind === 'ods' || kind === 'odp') {
      const z = zipEntries(data);
      const r = kind === 'docx' ? docx(z) : kind === 'xlsx' ? xlsx(z) : kind === 'pptx' ? pptx(z) : openDocument(z, kind);
      if (r.ok) { let used = 0; for (const s of r.sections) { if (used + s.text.length > MAX_TEXT) s.text = s.text.slice(0, Math.max(0, MAX_TEXT - used)); used += s.text.length; } r.sections = r.sections.filter((s) => s.text); }
      return r;
    }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^﻿/, ''); } catch { text = kind === 'rtf' ? data.toString('latin1') : ''; if (!text) return { ok: false, reason: 'not UTF-8 text' }; }
    if (text.includes('\u0000')) return { ok: false, reason: 'not a text file' };
    if (kind === 'csv') return csv(text);
    const plain = kind === 'rtf' ? rtfText(text) : kind === 'html' ? htmlText(text) : text;
    if (!plain.trim()) return { ok: false, reason: 'no text in it' };
    return { ok: true, sections: [{ label: kind, text: plain.slice(0, MAX_TEXT) }], count: 1, info: kind === 'json' || kind === 'yaml' ? 'as text' : 'text' };
  } catch (e) {
    const code = e instanceof Error ? e.message : '';
    return { ok: false, reason: code === 'encrypted' ? 'protected with a password' : code === 'too_big' ? 'too big' : code === 'not_zip' ? 'damaged or not really this format' : 'could not be read' };
  }
}
