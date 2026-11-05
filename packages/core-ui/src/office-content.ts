/** Office content is read as XML data, never inserted as HTML or evaluated. */
export type OfficePayload = { path: string; kind?: 'docx' | 'xlsx' | 'pptx'; parts?: { name: string; text: string }[]; images?: { name: string; mime: string; base64: string }[]; truncated?: boolean; reason?: string };
export type OfficeRun = { text?: string; bold?: boolean; italic?: boolean; underline?: boolean; image?: { src: string; alt: string } };
export type OfficeParagraph = { runs: OfficeRun[]; heading: number; list: boolean; dir: 'auto' | 'rtl'; align: 'start' | 'center' | 'end' | 'justify' };
export type OfficeBlock = { paragraph: OfficeParagraph } | { table: { paragraphs: OfficeParagraph[]; span: number }[][] };
export type OfficeCell = { column: number; text: string; formula: boolean };
export type OfficeSheet = { name: string; rows: { index: number; cells: OfficeCell[] }[]; columns: number; truncated: boolean };
export class OfficePreviewError extends Error {}
const fail = (): never => { throw new OfficePreviewError('This Office document cannot be previewed.'); };
const all = (n: Document | Element, tag: string) => [...n.getElementsByTagNameNS('*', tag)];
const children = (n: Element, tag?: string) => [...n.children].filter(x => !tag || x.localName === tag);
const attr = (n: Element | undefined, name: string) => n ? [...n.attributes].find(x => x.localName === name)?.value ?? '' : '';
const relId = (n: Element) => n.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || n.getAttributeNS('http://purl.oclc.org/ooxml/officeDocument/relationships', 'id') || '';
const first = (n: Element, name: string) => children(n, name)[0];
const on = (n: Element | undefined) => !!n && !['0', 'false', 'off'].includes(attr(n, 'val'));
const xml = (parts: Map<string, string>, name: string) => {
  const text = parts.get(name); if (!text || /<!\s*(?:DOCTYPE|ENTITY)/i.test(text)) return fail();
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length || !doc.documentElement) return fail();
  return doc;
};
/** Resolve only archive members; external relationships never become URLs. */
export function officeTarget(base: string, target: string): string | null {
  if (!target || /[\\\x00-\x1f:#?%]/.test(target)) return null;
  const parts = target.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const p of target.split('/')) { if (!p || p === '.') continue; if (p === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(p); }
  return parts.join('/');
}
function relationships(parts: Map<string, string>, base: string) {
  const at = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '';
  const name = `${at}_rels/${base.slice(base.lastIndexOf('/') + 1)}.rels`;
  const out = new Map<string, { target: string; type: string }>();
  if (!parts.has(name)) return out;
  for (const r of all(xml(parts, name), 'Relationship')) {
    if (attr(r, 'TargetMode').toLowerCase() === 'external') continue;
    const target = officeTarget(base, attr(r, 'Target'));
    if (target) out.set(attr(r, 'Id'), { target, type: attr(r, 'Type').split('/').at(-1) ?? '' });
  }
  return out;
}

export function wordPreview(payload: OfficePayload): { blocks: OfficeBlock[]; truncated: boolean } {
  const parts = new Map(payload.parts?.map(p => [p.name, p.text]));
  const doc = xml(parts, 'word/document.xml'), body = all(doc, 'body')[0]; if (!body) return fail();
  const rels = relationships(parts, 'word/document.xml');
  const images = new Map(payload.images?.map(i => [i.name, i])); let runs = 0, truncated = payload.truncated === true;
  const paragraph = (p: Element): OfficeParagraph => {
    const props = first(p, 'pPr'), style = attr(props && first(props, 'pStyle'), 'val');
    const align = attr(props && first(props, 'jc'), 'val');
    const out: OfficeParagraph = { runs: [], heading: /^heading[1-6]$/i.test(style) ? Number(style.at(-1)) : /^title$/i.test(style) ? 1 : 0, list: !!props && !!first(props, 'numPr'), dir: props && on(first(props, 'bidi')) ? 'rtl' : 'auto', align: align === 'center' ? 'center' : ['right', 'end'].includes(align) ? 'end' : align === 'both' ? 'justify' : 'start' };
    for (const r of all(p, 'r')) {
      if (++runs > 10000) { truncated = true; break; }
      const rp = first(r, 'rPr'); if (rp && on(first(rp, 'vanish'))) continue;
      const text = [...r.getElementsByTagNameNS('*', '*')].map(x => x.localName === 't' ? x.textContent ?? '' : x.localName === 'tab' ? '\t' : ['br', 'cr'].includes(x.localName) ? '\n' : '').join('');
      if (text) out.runs.push({ text, bold: rp && on(first(rp, 'b')), italic: rp && on(first(rp, 'i')), underline: rp && !!first(rp, 'u') && attr(first(rp, 'u'), 'val') !== 'none' });
      for (const b of all(r, 'blip')) {
        const rel = rels.get(attr(b, 'embed')), image = rel?.type === 'image' ? images.get(rel.target) : undefined;
        if (image) out.runs.push({ image: { src: `data:${image.mime};base64,${image.base64}`, alt: attr(all(r, 'docPr')[0], 'descr') || 'Document image' } });
        else truncated = true;
      }
    }
    return out;
  };
  const blocks: OfficeBlock[] = [];
  for (const node of children(body)) {
    if (blocks.length >= 500 || runs >= 10000) { truncated = true; break; }
    if (node.localName === 'p') blocks.push({ paragraph: paragraph(node) });
    else if (node.localName === 'tbl') {
      const rows = children(node, 'tr'); if (rows.length > 200) truncated = true;
      blocks.push({ table: rows.slice(0, 200).map(row => {
        const cells = children(row, 'tc'); if (cells.length > 50) truncated = true;
        return cells.slice(0, 50).map(cell => ({ paragraphs: children(cell, 'p').map(paragraph), span: Math.min(30, Math.max(1, Number(attr(first(cell, 'tcPr') && first(first(cell, 'tcPr')!, 'gridSpan'), 'val')) || 1)) }));
      }) });
    }
  }
  return { blocks, truncated };
}
export const columnLabel = (column: number): string => { let s = ''; for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
function columnIndex(ref: string) { const m = /^([A-Z]{1,3})[1-9][0-9]{0,6}$/.exec(ref); return m ? [...m[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) : 0; }
export function workbookPreview(payload: OfficePayload): { sheets: OfficeSheet[]; truncated: boolean } {
  const parts = new Map(payload.parts?.map(p => [p.name, p.text])), workbook = xml(parts, 'xl/workbook.xml'), rels = relationships(parts, 'xl/workbook.xml');
  const strings = parts.has('xl/sharedStrings.xml') ? all(xml(parts, 'xl/sharedStrings.xml'), 'si').slice(0, 20000).map(s => all(s, 't').map(t => t.textContent ?? '').join('')) : [];
  const sheets: OfficeSheet[] = []; let truncated = false;
  const candidates = all(workbook, 'sheet').filter(s => !['hidden', 'veryHidden'].includes(attr(s, 'state')));
  if (candidates.length > 20) truncated = true;
  for (const s of candidates.slice(0, 20)) {
    const rel = rels.get(relId(s)); if (!rel || rel.type !== 'worksheet' || !parts.has(rel.target)) { truncated = true; continue; }
    const sheet: OfficeSheet = { name: attr(s, 'name').slice(0, 100) || 'Sheet', rows: [], columns: 1, truncated: false };
    const doc = xml(parts, rel.target), sourceRows = all(doc, 'row'); let cellCount = 0;
    for (const r of sourceRows) {
      if (onHidden(r)) continue;
      if (sheet.rows.length >= 1000 || cellCount >= 20000) { sheet.truncated = true; break; }
      const index = Number(attr(r, 'r')); if (!Number.isSafeInteger(index) || index < 1 || index > 1048576) continue;
      const cells: OfficeCell[] = [];
      for (const c of children(r, 'c')) {
        if (++cellCount > 20000) { sheet.truncated = true; break; }
        const column = columnIndex(attr(c, 'r')); if (!column || column > 100) { sheet.truncated = true; continue; }
        const type = attr(c, 't'), raw = first(c, 'v')?.textContent ?? '', formula = !!first(c, 'f');
        const value = type === 's' ? strings[Number(raw)] ?? '' : type === 'inlineStr' ? all(c, 't').map(n => n.textContent ?? '').join('') : type === 'b' ? raw === '1' ? 'TRUE' : 'FALSE' : raw;
        cells.push({ column, text: formula && !raw ? 'No saved value' : value.slice(0, 10000), formula });
        sheet.columns = Math.max(sheet.columns, column);
      }
      sheet.rows.push({ index, cells });
    }
    sheets.push(sheet);
  }
  return { sheets, truncated };
}
const onHidden = (e: Element) => ['1', 'true'].includes(attr(e, 'hidden'));


export type OfficeSlideItem = { x: number; y: number; width: number; height: number; paragraphs?: OfficeParagraph[]; image?: { src: string; alt: string }; font: number; color: string; fill: string };
export type OfficeSlide = { items: OfficeSlideItem[]; title: string; flow: boolean };
export type OfficeDeck = { width: number; height: number; slides: OfficeSlide[]; truncated: boolean };
export function presentationPreview(payload: OfficePayload): OfficeDeck {
  const parts = new Map(payload.parts?.map(p => [p.name, p.text])), presentation = xml(parts, 'ppt/presentation.xml');
  const rels = relationships(parts, 'ppt/presentation.xml'), images = new Map(payload.images?.map(i => [i.name, i]));
  const sz = all(presentation, 'sldSz')[0];
  const dim = (e: Element | undefined, n: string, fallback: number) => { const x = Number(attr(e, n)); return Number.isFinite(x) && x > 0 && x <= 100000000 ? x : fallback; };
  const deck: OfficeDeck = { width: dim(sz, 'cx', 12192000), height: dim(sz, 'cy', 6858000), slides: [], truncated: payload.truncated === true };
  const slides = all(presentation, 'sldId'); if (slides.length > 40) deck.truncated = true;
  const color = (e: Element | undefined, fallback: string) => { const val = e && attr(all(e, 'srgbClr')[0], 'val'); return val && /^[a-f0-9]{6}$/i.test(val) ? `#${val}` : fallback; };
  for (const id of slides.slice(0, 40)) {
    const rel = rels.get(relId(id)); if (!rel || rel.type !== 'slide' || !parts.has(rel.target)) { deck.truncated = true; continue; }
    const doc = xml(parts, rel.target); if (['0', 'false'].includes(attr(doc.documentElement, 'show'))) continue;
    const tree = all(doc, 'spTree')[0]; if (!tree) { deck.truncated = true; continue; }
    const slide: OfficeSlide = { items: [], title: '', flow: false }, slideRels = relationships(parts, rel.target);
    for (const node of children(tree)) {
      if (!['sp', 'pic'].includes(node.localName)) { if (['grpSp', 'graphicFrame'].includes(node.localName)) deck.truncated = true; continue; }
      if (slide.items.length >= 200) { deck.truncated = true; break; }
      const sp = first(node, 'spPr'), xf = sp && first(sp, 'xfrm'), off = xf && first(xf, 'off'), ext = xf && first(xf, 'ext');
      const position = (e: Element | undefined, n: string, limit: number) => { const v = Number(attr(e, n)); return Number.isFinite(v) ? Math.max(-limit, Math.min(limit * 2, v)) : 0; };
      if (!xf) slide.flow = true;
      const rp = all(node, 'rPr')[0];
      const item: OfficeSlideItem = { x: position(off, 'x', deck.width), y: position(off, 'y', deck.height), width: dim(ext, 'cx', deck.width), height: dim(ext, 'cy', deck.height / 5), font: Math.max(1.2, Math.min(12, (Number(attr(rp, 'sz')) || 2400) * 127 / deck.width * 100)), color: color(rp, '#20252c'), fill: color(sp && first(sp, 'solidFill'), 'transparent') };
      if (node.localName === 'pic') {
        const b = all(node, 'blip')[0], imageRel = slideRels.get(attr(b, 'embed')), img = imageRel?.type === 'image' ? images.get(imageRel.target) : undefined;
        if (!img) { deck.truncated = true; continue; }
        item.image = { src: `data:${img.mime};base64,${img.base64}`, alt: attr(all(node, 'cNvPr')[0], 'descr') || 'Slide image' };
      } else {
        item.paragraphs = all(node, 'p').slice(0, 100).map(p => ({ heading: 0, list: false, dir: 'auto', align: attr(first(p, 'pPr'), 'algn') === 'ctr' ? 'center' : attr(first(p, 'pPr'), 'algn') === 'r' ? 'end' : 'start', runs: all(p, 'r').slice(0, 200).map(r => { const pr = first(r, 'rPr'); return { text: all(r, 't').map(t => t.textContent ?? '').join(''), bold: ['1','true'].includes(attr(pr, 'b')), italic: ['1','true'].includes(attr(pr, 'i')), underline: !!attr(pr, 'u') && attr(pr, 'u') !== 'none' }; }) }));
        if (!slide.title) slide.title = item.paragraphs.flatMap(p => p.runs.map(r => r.text ?? '')).join(' ').trim().slice(0, 100);
      }
      slide.items.push(item);
    }
    slide.title ||= `Slide ${deck.slides.length + 1}`; deck.slides.push(slide);
  }
  return deck;
}
