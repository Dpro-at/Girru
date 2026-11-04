/**
 * PDF text extraction (KNOW-INDEX-01). Own code, no packages: node:zlib only.
 *
 * What it reads:
 *   objects     every `N G obj … endobj` in file order (a later definition of
 *               the same number wins, as in an incremental update), plus the
 *               objects packed in object streams (/Type /ObjStm, PDF 1.5+)
 *   filters     FlateDecode (node:zlib, with PNG/TIFF predictors), LZWDecode,
 *               ASCIIHexDecode, ASCII85Decode, RunLengthDecode
 *   pages       the page tree from the catalog (/Root → /Pages → /Kids), in
 *               reading order, so page numbers are the ones a viewer shows
 *               (1-based); inherited /Resources are followed
 *   text        BT … ET with Tj, TJ, ' and ", positions (Td, TD, T*, Tm, TL)
 *               for lines and spaces, form XObjects (Do) a few levels deep
 *   fonts       ToUnicode CMaps (bfchar, bfrange, codespace widths) first;
 *               else simple fonts by their encoding: WinAnsi, MacRoman,
 *               Standard, with /Differences glyph names (the common Latin set,
 *               uniXXXX / uXXXX names)
 *
 * What it refuses, and says so (never guesses):
 *   encrypted   an /Encrypt entry in a trailer or cross-reference stream
 *   no_text     pages without any text (a scan or pictures only)
 *   fonts       too many characters whose font gives no way to know the
 *               letter (e.g. Identity-H without a ToUnicode map)
 *   damaged     no catalog or page tree, or nothing could be parsed
 *   too_large   the file or a decoded stream is over its cap
 *
 * Every limit is fixed (bytes decoded per stream, pages, objects), so a
 * crafted file cannot use unbounded memory or time.
 */

import { inflateSync, inflateRawSync, constants as zc } from 'node:zlib';

export const PDF_MAX_BYTES = 40 * 1024 * 1024;
export const PDF_MAX_PAGES = 2000;
const MAX_OBJECTS = 200_000;
const MAX_STREAM_OUT = 16 * 1024 * 1024;
const MAX_TOTAL_OUT = 96 * 1024 * 1024;
const MAX_FORM_DEPTH = 4;
/** Share of shown characters with no known letter above which the PDF is refused (fonts). */
const MAX_UNKNOWN_SHARE = 0.3;

export type PdfFailure = 'not_pdf' | 'encrypted' | 'no_text' | 'fonts' | 'damaged' | 'too_large';
export interface PdfPage { page: number; text: string }
export type PdfResult = { ok: true; pages: PdfPage[]; pageCount: number } | { ok: false; reason: PdfFailure };

/* ------------------------------------------------------------------ values */

class Name { constructor(readonly n: string) {} }
class Ref { constructor(readonly num: number, readonly gen: number) {} }
class Str { constructor(readonly b: Uint8Array) {} }
class Op { constructor(readonly op: string) {} }
type Dict = Map<string, Val>;
class Stream { constructor(readonly dict: Dict, readonly raw: Uint8Array) {} }
type Val = null | boolean | number | Name | Ref | Str | Val[] | Dict | Stream;

const isDict = (v: unknown): v is Dict => v instanceof Map;

/* ------------------------------------------------------------------- lexer */

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

class Lexer {
  pos: number;
  constructor(readonly b: Uint8Array, start = 0, readonly end = b.length) { this.pos = start; }

  skipWs(): void {
    const b = this.b;
    while (this.pos < this.end) {
      const c = b[this.pos];
      if (WS[c]) { this.pos++; continue; }
      if (c === 0x25) { // % comment to end of line
        while (this.pos < this.end && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
        continue;
      }
      break;
    }
  }

  /** The next token: a value piece, an array/dict marker, or an operator / keyword. */
  token(): Val | Op | '[' | ']' | '<<' | '>>' | undefined {
    this.skipWs();
    const b = this.b;
    if (this.pos >= this.end) return undefined;
    const c = b[this.pos];
    if (c === 0x28) return this.literal();
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) { this.pos += 2; return '<<'; }
      return this.hex();
    }
    if (c === 0x3e) {
      if (b[this.pos + 1] === 0x3e) { this.pos += 2; return '>>'; }
      this.pos++; return new Op('>');
    }
    if (c === 0x5b) { this.pos++; return '['; }
    if (c === 0x5d) { this.pos++; return ']'; }
    if (c === 0x7b || c === 0x7d) { this.pos++; return new Op(String.fromCharCode(c)); }
    if (c === 0x2f) return this.name();
    const start = this.pos;
    while (this.pos < this.end && !WS[b[this.pos]] && !DELIM[b[this.pos]]) this.pos++;
    if (this.pos === start) { this.pos++; return new Op(String.fromCharCode(c)); }
    const word = latin1(b, start, this.pos);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return Number(word);
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return new Op(word);
  }

  private name(): Name {
    const b = this.b;
    this.pos++;
    const start = this.pos;
    while (this.pos < this.end && !WS[b[this.pos]] && !DELIM[b[this.pos]]) this.pos++;
    const raw = latin1(b, start, this.pos);
    return new Name(raw.includes('#') ? raw.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : raw);
  }

  private literal(): Str {
    const b = this.b;
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.end) {
      const c = b[this.pos++];
      if (c === 0x5c) { // backslash
        const n = b[this.pos++];
        if (n === undefined) break;
        if (n >= 0x30 && n <= 0x37) {
          let v = n - 0x30;
          for (let k = 0; k < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; k++) v = v * 8 + (b[this.pos++] - 0x30);
          out.push(v & 0xff);
        } else if (n === 0x6e) out.push(10);
        else if (n === 0x72) out.push(13);
        else if (n === 0x74) out.push(9);
        else if (n === 0x62) out.push(8);
        else if (n === 0x66) out.push(12);
        else if (n === 13) { if (b[this.pos] === 10) this.pos++; } // line continuation
        else if (n === 10) { /* line continuation */ }
        else out.push(n);
        continue;
      }
      if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) break;
      out.push(c);
    }
    return new Str(Uint8Array.from(out));
  }

  private hex(): Str {
    const b = this.b;
    this.pos++;
    const out: number[] = [];
    let hi = -1;
    while (this.pos < this.end) {
      const c = b[this.pos++];
      if (c === 0x3e) break;
      const v = hexVal(c);
      if (v < 0) continue;
      if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
    }
    if (hi >= 0) out.push(hi * 16);
    return new Str(Uint8Array.from(out));
  }
}

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

function latin1(b: Uint8Array, s: number, e: number): string {
  let out = '';
  for (let i = s; i < e; i++) out += String.fromCharCode(b[i]);
  return out;
}

/* ------------------------------------------------------------------ parser */

/** Parse one value at the lexer position (refs `N G R` included). */
function parseValue(lx: Lexer, first?: ReturnType<Lexer['token']>, depth = 0): Val | Op | undefined {
  const t = first === undefined ? lx.token() : first;
  if (depth > 64) throw new Error('too deep');
  if (t === '[') {
    const arr: Val[] = [];
    for (;;) {
      const n = lx.token();
      if (n === undefined || n === ']') break;
      const v = parseValue(lx, n, depth + 1);
      if (v instanceof Op) continue;
      if (v !== undefined) arr.push(v);
    }
    return arr;
  }
  if (t === '<<') {
    const d: Dict = new Map();
    for (;;) {
      const k = lx.token();
      if (k === undefined || k === '>>') break;
      if (!(k instanceof Name)) continue;
      const v = parseValue(lx, undefined, depth + 1);
      if (v instanceof Op || v === undefined) { if (v instanceof Op && v.op === 'R') continue; break; }
      d.set(k.n, v);
    }
    return d;
  }
  if (typeof t === 'number' && Number.isInteger(t) && t >= 0) {
    // `N G R`?
    const save = lx.pos;
    const g = lx.token();
    if (typeof g === 'number' && Number.isInteger(g) && g >= 0) {
      const r = lx.token();
      if (r instanceof Op && r.op === 'R') return new Ref(t, g);
    }
    lx.pos = save;
    return t;
  }
  if (t === ']' || t === '>>') return undefined;
  return t;
}

interface Doc {
  objs: Map<number, Val>;
  trailers: Dict[];
  totalOut: number;
}

function resolve(doc: Doc, v: Val | undefined, hops = 0): Val | undefined {
  while (v instanceof Ref && hops++ < 32) v = doc.objs.get(v.num);
  return v instanceof Ref ? undefined : v;
}
const dictOf = (doc: Doc, v: Val | undefined): Dict | undefined => {
  const r = resolve(doc, v);
  if (r instanceof Stream) return r.dict;
  return isDict(r) ? r : undefined;
};
const nameOf = (doc: Doc, v: Val | undefined): string | undefined => {
  const r = resolve(doc, v);
  return r instanceof Name ? r.n : undefined;
};
const numOf = (doc: Doc, v: Val | undefined): number | undefined => {
  const r = resolve(doc, v);
  return typeof r === 'number' ? r : undefined;
};
const arrOf = (doc: Doc, v: Val | undefined): Val[] | undefined => {
  const r = resolve(doc, v);
  return Array.isArray(r) ? r : undefined;
};

const OBJ_RE = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
const ENDSTREAM = Buffer.from('endstream');

/** Read every object of the file in order; returns false when the file is no PDF. */
function readObjects(buf: Buffer, doc: Doc): void {
  const text = buf.toString('latin1');
  let pos = 0;
  const pendingObjStm: Stream[] = [];
  let nextTrailer = text.indexOf('trailer');
  for (;;) {
    if (doc.objs.size > MAX_OBJECTS) throw new PdfError('too_large');
    OBJ_RE.lastIndex = pos;
    const m = OBJ_RE.exec(text);
    // Trailers between objects (classic cross-reference tables).
    if (nextTrailer >= 0 && nextTrailer < pos) nextTrailer = text.indexOf('trailer', pos);
    const trailerAt = nextTrailer;
    if (trailerAt >= 0 && (!m || trailerAt < m.index)) {
      nextTrailer = text.indexOf('trailer', trailerAt + 7);
      const lx = new Lexer(buf, trailerAt + 7);
      const t = parseValue(lx);
      if (isDict(t)) doc.trailers.push(t);
      pos = Math.max(lx.pos, trailerAt + 7);
      continue;
    }
    if (!m) break;
    const num = Number(m[1]);
    const lx = new Lexer(buf, m.index + m[0].length);
    let value: Val | Op | undefined;
    try { value = parseValue(lx); } catch { pos = m.index + m[0].length; continue; }
    if (value instanceof Op) value = null;
    let end = lx.pos;
    if (isDict(value)) {
      const save = lx.pos;
      const kw = lx.token();
      if (kw instanceof Op && kw.op === 'stream') {
        let start = lx.pos;
        if (buf[start] === 13 && buf[start + 1] === 10) start += 2;
        else if (buf[start] === 10 || buf[start] === 13) start += 1;
        const declared = value.get('Length');
        let stop = -1;
        if (typeof declared === 'number' && declared >= 0 && start + declared <= buf.length) {
          const after = new Lexer(buf, start + declared);
          after.skipWs();
          if (buf.subarray(after.pos, after.pos + 9).equals(ENDSTREAM)) stop = start + declared;
        }
        if (stop < 0) {
          const at = buf.indexOf(ENDSTREAM, start);
          if (at < 0) { pos = start; continue; }
          stop = at;
          if (buf[stop - 1] === 10) stop--;
          if (buf[stop - 1] === 13) stop--;
        }
        const s = new Stream(value, buf.subarray(start, stop));
        doc.objs.set(num, s);
        if (value.get('Type') instanceof Name && (value.get('Type') as Name).n === 'XRef') doc.trailers.push(value);
        if (value.get('Type') instanceof Name && (value.get('Type') as Name).n === 'ObjStm') pendingObjStm.push(s);
        end = buf.indexOf(ENDSTREAM, stop) + 9;
        pos = Math.max(end, m.index + m[0].length);
        continue;
      }
      lx.pos = save;
    }
    doc.objs.set(num, value ?? null);
    pos = Math.max(end, m.index + m[0].length);
  }
  // Objects packed in object streams: only numbers not defined directly (a direct object is newer or equal).
  for (const s of pendingObjStm) {
    let data: Uint8Array;
    try { data = decodeStream(doc, s); } catch (e) { if (e instanceof PdfError) throw e; continue; }
    const n = numOf(doc, s.dict.get('N')) ?? 0;
    const first = numOf(doc, s.dict.get('First')) ?? 0;
    const lx = new Lexer(data);
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < n && i < 100_000; i++) {
      const a = lx.token(), b = lx.token();
      if (typeof a !== 'number' || typeof b !== 'number') break;
      pairs.push([a, b]);
    }
    for (const [objNum, off] of pairs) {
      if (doc.objs.has(objNum)) continue;
      const vl = new Lexer(data, first + off);
      try {
        const v = parseValue(vl);
        doc.objs.set(objNum, v instanceof Op || v === undefined ? null : v);
      } catch { /* one bad object: skip it */ }
    }
  }
}

class PdfError extends Error { constructor(readonly reason: PdfFailure) { super(reason); } }

/* ----------------------------------------------------------------- filters */

function decodeStream(doc: Doc, s: Stream): Uint8Array {
  const filters = (() => {
    const f = resolve(doc, s.dict.get('Filter'));
    if (f instanceof Name) return [f.n];
    if (Array.isArray(f)) return f.map((x) => nameOf(doc, x) ?? '');
    return [];
  })();
  const parmsRaw = resolve(doc, s.dict.get('DecodeParms') ?? s.dict.get('DP'));
  const parmsList = Array.isArray(parmsRaw) ? parmsRaw.map((p) => dictOf(doc, p)) : [dictOf(doc, parmsRaw as Val)];
  let data: Uint8Array = s.raw;
  filters.forEach((f, i) => {
    const parms = parmsList[i] ?? (filters.length === 1 ? parmsList[0] : undefined);
    switch (f) {
      case 'FlateDecode': case 'Fl': data = predictor(doc, inflate(data), parms); break;
      case 'LZWDecode': case 'LZW': data = predictor(doc, lzw(data, (numOf(doc, parms?.get('EarlyChange')) ?? 1) === 1), parms); break;
      case 'ASCIIHexDecode': case 'AHx': data = asciiHex(data); break;
      case 'ASCII85Decode': case 'A85': data = ascii85(data); break;
      case 'RunLengthDecode': case 'RL': data = runLength(data); break;
      default: throw new Error(`unsupported filter ${f}`);
    }
    if (data.length > MAX_STREAM_OUT) throw new PdfError('too_large');
  });
  doc.totalOut += data.length;
  if (doc.totalOut > MAX_TOTAL_OUT) throw new PdfError('too_large');
  return data;
}

function inflate(data: Uint8Array): Uint8Array {
  const opts = { maxOutputLength: MAX_STREAM_OUT };
  try { return inflateSync(data, opts); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new PdfError('too_large');
  }
  // A stream cut short or with a bad checksum: what can be read, read with a sync flush.
  try { return inflateSync(data, { ...opts, finishFlush: zc.Z_SYNC_FLUSH }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new PdfError('too_large');
  }
  return inflateRawSync(data, { ...opts, finishFlush: zc.Z_SYNC_FLUSH });
}

function predictor(doc: Doc, data: Uint8Array, parms: Dict | undefined): Uint8Array {
  const p = numOf(doc, parms?.get('Predictor')) ?? 1;
  if (p < 2) return data;
  const colors = numOf(doc, parms?.get('Colors')) ?? 1;
  const bpc = numOf(doc, parms?.get('BitsPerComponent')) ?? 8;
  const columns = numOf(doc, parms?.get('Columns')) ?? 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (p === 2) { // TIFF, 8-bit only
    const out = Uint8Array.from(data);
    if (bpc !== 8) return out;
    for (let r = 0; r + rowLen <= out.length; r += rowLen) for (let i = bpp; i < rowLen; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 0xff;
    return out;
  }
  const out = new Uint8Array(Math.floor(data.length / (rowLen + 1)) * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0, o = 0; r + rowLen + 1 <= data.length; r += rowLen + 1, o += rowLen) {
    const type = data[r];
    const row = data.subarray(r + 1, r + 1 + rowLen);
    const cur = new Uint8Array(rowLen);
    for (let i = 0; i < rowLen; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0, up = prev[i], ul = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (type === 1) v += left;
      else if (type === 2) v += up;
      else if (type === 3) v += (left + up) >> 1;
      else if (type === 4) {
        const pa = Math.abs(up - ul), pb = Math.abs(left - ul), pc = Math.abs(left + up - 2 * ul);
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
      }
      cur[i] = v & 0xff;
    }
    out.set(cur, o);
    prev = cur;
  }
  return out;
}

function lzw(data: Uint8Array, early: boolean): Uint8Array {
  const out: number[] = [];
  let dict: number[][] = [];
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict.push([i]); dict.push([], []); };
  reset();
  let bits = 9, buf = 0, nbits = 0, prev: number[] | null = null;
  for (let i = 0; i < data.length; i++) {
    buf = (buf << 8) | data[i]; nbits += 8;
    while (nbits >= bits) {
      const code = (buf >> (nbits - bits)) & ((1 << bits) - 1);
      nbits -= bits;
      buf &= (1 << nbits) - 1;
      if (code === 256) { reset(); bits = 9; prev = null; continue; }
      if (code === 257) return Uint8Array.from(out);
      let entry: number[];
      if (code < dict.length && dict[code].length) entry = dict[code];
      else if (prev) entry = [...prev, prev[0]];
      else return Uint8Array.from(out);
      for (const x of entry) out.push(x);
      if (out.length > MAX_STREAM_OUT) throw new PdfError('too_large');
      if (prev) dict.push([...prev, entry[0]]);
      prev = entry;
      const limit = dict.length + (early ? 1 : 0);
      if (limit >= 1 << bits && bits < 12) bits++;
    }
  }
  return Uint8Array.from(out);
}

function asciiHex(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let hi = -1;
  for (const c of data) {
    if (c === 0x3e) break;
    const v = hexVal(c);
    if (v < 0) continue;
    if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
  }
  if (hi >= 0) out.push(hi * 16);
  return Uint8Array.from(out);
}

function ascii85(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let group: number[] = [];
  let i = 0;
  if (data[0] === 0x3c && data[1] === 0x7e) i = 2;
  for (; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) break;
    if (WS[c]) continue;
    if (c === 0x7a && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    if (c < 0x21 || c > 0x75) continue;
    group.push(c - 0x21);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length > 1) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return Uint8Array.from(out);
}

function runLength(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length;) {
    const n = data[i++];
    if (n === 128) break;
    if (n < 128) { for (let k = 0; k <= n && i < data.length; k++) out.push(data[i++]); }
    else { const v = data[i++]; for (let k = 0; k < 257 - n; k++) out.push(v); }
    if (out.length > MAX_STREAM_OUT) throw new PdfError('too_large');
  }
  return Uint8Array.from(out);
}

/* ------------------------------------------------------------------- fonts */

/** WinAnsiEncoding 0x80–0x9F (the rest is Latin-1). */
const WIN_ANSI_80 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
/** MacRomanEncoding 0x80–0xFF. */
const MAC_ROMAN_80 = 'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';
/** StandardEncoding 0xA1–0xFF (positions without a glyph are empty). */
const STANDARD_A1: Record<number, string> = {
  0xa1: '¡', 0xa2: '¢', 0xa3: '£', 0xa4: '⁄', 0xa5: '¥', 0xa6: 'ƒ', 0xa7: '§', 0xa8: '¤', 0xa9: "'", 0xaa: '“', 0xab: '«', 0xac: '‹', 0xad: '›', 0xae: 'ﬁ', 0xaf: 'ﬂ',
  0xb1: '–', 0xb2: '†', 0xb3: '‡', 0xb4: '·', 0xb6: '¶', 0xb7: '•', 0xb8: '‚', 0xb9: '„', 0xba: '”', 0xbb: '»', 0xbc: '…', 0xbd: '‰', 0xbf: '¿',
  0xc1: '`', 0xc2: '´', 0xc3: 'ˆ', 0xc4: '˜', 0xc5: '¯', 0xc6: '˘', 0xc7: '˙', 0xc8: '¨', 0xca: '˚', 0xcb: '¸', 0xcd: '˝', 0xce: '˛', 0xcf: 'ˇ', 0xd0: '—',
  0xe1: 'Æ', 0xe3: 'ª', 0xe8: 'Ł', 0xe9: 'Ø', 0xea: 'Œ', 0xeb: 'º', 0xf1: 'æ', 0xf5: 'ı', 0xf8: 'ł', 0xf9: 'ø', 0xfa: 'œ', 0xfb: 'ß',
};

function baseEncoding(name: string | undefined): (string | null)[] {
  const t: (string | null)[] = new Array(256).fill(null);
  for (let c = 0x20; c < 0x7f; c++) t[c] = String.fromCharCode(c);
  if (name === 'MacRomanEncoding') {
    for (let c = 0x80; c <= 0xff; c++) t[c] = MAC_ROMAN_80[c - 0x80] ?? null;
  } else if (name === 'StandardEncoding') {
    t[0x27] = '’'; t[0x60] = '‘';
    for (const [k, v] of Object.entries(STANDARD_A1)) t[Number(k)] = v;
  } else { // WinAnsi (also the default for TrueType and unknown names)
    for (let c = 0x80; c <= 0x9f; c++) t[c] = WIN_ANSI_80[c - 0x80];
    for (let c = 0xa0; c <= 0xff; c++) t[c] = String.fromCharCode(c);
    t[0xa0] = ' '; t[0xad] = '-';
  }
  return t;
}

const GLYPHS: Record<string, string> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'", quoteright: '’', quoteleft: '‘',
  parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/', colon: ':', semicolon: ';', less: '<',
  equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`',
  braceleft: '{', bar: '|', braceright: '}', asciitilde: '~', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
  eight: '8', nine: '9', quotedblleft: '“', quotedblright: '”', quotesinglbase: '‚', quotedblbase: '„', endash: '–', emdash: '—', bullet: '•',
  ellipsis: '…', fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', Euro: '€', copyright: '©', registered: '®', trademark: '™', degree: '°',
  plusminus: '±', multiply: '×', divide: '÷', section: '§', paragraph: '¶', dagger: '†', daggerdbl: '‡', minus: '−', nbspace: ' ', sfthyphen: '-',
  germandbls: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', oslash: 'ø', Oslash: 'Ø', eth: 'ð', Eth: 'Ð', thorn: 'þ', Thorn: 'Þ', dotlessi: 'ı', lslash: 'ł',
  Lslash: 'Ł', guillemotleft: '«', guillemotright: '»', guilsinglleft: '‹', guilsinglright: '›', exclamdown: '¡', questiondown: '¿', cent: '¢',
  sterling: '£', yen: '¥', currency: '¤', brokenbar: '¦', dieresis: '¨', ordfeminine: 'ª', ordmasculine: 'º', logicalnot: '¬', macron: '¯',
  periodcentered: '·', middot: '·', mu: 'µ', onehalf: '½', onequarter: '¼', threequarters: '¾', perthousand: '‰', florin: 'ƒ', circumflex: 'ˆ', tilde: '˜',
};
const ACCENTS: Record<string, string> = {
  acute: '́', grave: '̀', circumflex: '̂', dieresis: '̈', tilde: '̃', ring: '̊', cedilla: '̧', caron: '̌',
  macron: '̄', breve: '̆', dotaccent: '̇', ogonek: '̨', hungarumlaut: '̋',
};

/** Unicode text of a glyph name, or null when it cannot be known. */
export function glyphToUnicode(name: string): string | null {
  if (GLYPHS[name] !== undefined) return GLYPHS[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  let m = /^uni((?:[0-9A-F]{4})+)$/.exec(name);
  if (m) return m[1].match(/.{4}/g)!.map((h) => String.fromCharCode(parseInt(h, 16))).join('');
  m = /^u([0-9A-F]{4,6})$/.exec(name);
  if (m) { const cp = parseInt(m[1], 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : null; }
  m = /^([A-Za-z])(acute|grave|circumflex|dieresis|tilde|ring|cedilla|caron|macron|breve|dotaccent|ogonek|hungarumlaut)$/.exec(name);
  if (m) return (m[1] + ACCENTS[m[2]]).normalize('NFC');
  const dot = name.indexOf('.');
  if (dot > 0) return glyphToUnicode(name.slice(0, dot)); // a.sc, one.oldstyle
  const us = name.indexOf('_');
  if (us > 0) { // ligature f_f_i
    const parts = name.split('_').map(glyphToUnicode);
    return parts.every((p) => p !== null) ? parts.join('') : null;
  }
  return null;
}

interface Font {
  /** Byte widths a code may have (from the CMap codespace); simple fonts: [1]. */
  widths: number[];
  /** Code (bytes as a big-endian number, keyed with its length) → text. */
  map: Map<string, string>;
  /** Simple font table, used when the map has no entry. */
  table: (string | null)[] | null;
  twoByte: boolean;
}

const codeKey = (len: number, code: number) => `${len}:${code}`;

function utf16be(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
  return s;
}
function bytesNum(b: Uint8Array): number {
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
}

/** Parse a ToUnicode CMap stream. */
function parseCMap(data: Uint8Array, font: Font): void {
  const lx = new Lexer(data);
  const stack: Array<Val | Op> = [];
  const widths = new Set<number>();
  for (;;) {
    const t = lx.token();
    if (t === undefined) break;
    if (t instanceof Op) {
      if (t.op === 'begincodespacerange') {
        for (;;) {
          const a = lx.token();
          if (a === undefined || (a instanceof Op && a.op === 'endcodespacerange')) break;
          if (a instanceof Str) widths.add(a.b.length);
          lx.token();
        }
      } else if (t.op === 'beginbfchar') {
        for (;;) {
          const a = lx.token();
          if (a === undefined || (a instanceof Op && a.op === 'endbfchar')) break;
          const b = lx.token();
          if (a instanceof Str && b instanceof Str) font.map.set(codeKey(a.b.length, bytesNum(a.b)), utf16be(b.b));
          else if (a instanceof Str && b instanceof Name) { const g = glyphToUnicode(b.n); if (g !== null) font.map.set(codeKey(a.b.length, bytesNum(a.b)), g); }
        }
      } else if (t.op === 'beginbfrange') {
        for (;;) {
          const a = lx.token();
          if (a === undefined || (a instanceof Op && a.op === 'endbfrange')) break;
          const b = lx.token();
          const c = parseValue(lx);
          if (!(a instanceof Str) || !(b instanceof Str)) continue;
          const lo = bytesNum(a.b), hi = bytesNum(b.b), len = a.b.length;
          if (hi < lo || hi - lo > 65535) continue;
          if (c instanceof Str) {
            const base = c.b;
            for (let code = lo; code <= hi; code++) {
              const out = Uint8Array.from(base);
              // The last byte counts up (carry into the byte before).
              let add = code - lo;
              for (let i = out.length - 1; i >= 0 && add > 0; i--) { const v = out[i] + add; out[i] = v & 0xff; add = v >> 8; }
              font.map.set(codeKey(len, code), utf16be(out));
            }
          } else if (Array.isArray(c)) {
            c.forEach((x, i) => { if (x instanceof Str && lo + i <= hi) font.map.set(codeKey(len, lo + i), utf16be(x.b)); });
          }
        }
      }
      stack.length = 0;
    } else stack.push(t as Val);
  }
  if (widths.size) font.widths = [...widths].sort((x, y) => y - x);
}

function loadFont(doc: Doc, ref: Val | undefined, cache: Map<Val, Font>): Font {
  const key = ref ?? null;
  const hit = key !== null ? cache.get(key) : undefined;
  if (hit) return hit;
  const d = dictOf(doc, ref) ?? new Map();
  const subtype = nameOf(doc, d.get('Subtype'));
  const twoByte = subtype === 'Type0';
  const font: Font = { widths: twoByte ? [2] : [1], map: new Map(), table: null, twoByte };
  if (!twoByte) {
    const enc = resolve(doc, d.get('Encoding'));
    let base = enc instanceof Name ? enc.n : undefined;
    let diffs: Val[] | undefined;
    if (isDict(enc)) {
      base = nameOf(doc, enc.get('BaseEncoding'));
      diffs = arrOf(doc, enc.get('Differences'));
    }
    if (!base && subtype === 'Type1') base = 'StandardEncoding';
    const table = baseEncoding(base);
    if (diffs) {
      let code = 0;
      for (const x of diffs) {
        if (typeof x === 'number') code = x;
        else if (x instanceof Name) { if (code >= 0 && code < 256) table[code] = glyphToUnicode(x.n); code++; }
      }
    }
    const bf = nameOf(doc, d.get('BaseFont')) ?? '';
    // Symbol and Dingbats fonts: their codes are not letters; only a ToUnicode map can say.
    font.table = /Symbol|Dingbats|Wingdings/i.test(bf) && !diffs ? null : table;
  }
  const tu = resolve(doc, d.get('ToUnicode'));
  if (tu instanceof Stream) {
    try { parseCMap(decodeStream(doc, tu), font); } catch (e) { if (e instanceof PdfError) throw e; }
  }
  if (key !== null) cache.set(key, font);
  return font;
}

/** Decode the bytes of one shown string: text plus how many codes had no known letter. */
function decodeShown(font: Font, b: Uint8Array): { text: string; codes: number; unknown: number } {
  let text = '', codes = 0, unknown = 0;
  for (let i = 0; i < b.length;) {
    let done = false;
    for (const w of font.widths) {
      if (i + w > b.length) continue;
      const code = bytesNum(b.subarray(i, i + w));
      const hit = font.map.get(codeKey(w, code));
      if (hit !== undefined) { text += hit; i += w; codes++; done = true; break; }
    }
    if (done) continue;
    const w = font.widths[font.widths.length - 1] ?? 1;
    if (font.twoByte || w > 1) {
      // A CID with no ToUnicode entry: unknown (never a guess from the glyph id).
      i += Math.max(w, font.twoByte ? 2 : 1); codes++; unknown++; continue;
    }
    const c = b[i++];
    codes++;
    const ch = font.table?.[c];
    if (ch === null || ch === undefined) { if (c > 0x20) unknown++; else if (c === 0x20) text += ' '; }
    else text += ch;
  }
  return { text, codes, unknown };
}

/* ------------------------------------------------------------- page text */

interface Collect { out: string[]; codes: number; unknown: number }

function pageText(doc: Doc, contents: Uint8Array[], resources: Dict | undefined, fonts: Map<Val, Font>, c: Collect, depth: number): void {
  const fontDict = dictOf(doc, resources?.get('Font'));
  const xobjects = dictOf(doc, resources?.get('XObject'));
  let font: Font | null = null;
  let size = 12, leading = 0;
  const stack: Array<{ font: Font | null; size: number; leading: number }> = [];
  // Text line position (y) and the x where the last shown text ended (rough).
  let lineY: number | null = null, curY = 0, moved = false;
  const ops: Val[] = [];
  const emit = (s: string) => {
    if (!s) return;
    if (lineY !== null && Math.abs(curY - lineY) > Math.max(1, size * 0.3)) c.out.push('\n');
    else if (moved && c.out.length && !/\s$/.test(c.out[c.out.length - 1]) && !/^\s/.test(s)) c.out.push(' ');
    lineY = curY; moved = false;
    c.out.push(s);
  };
  const show = (b: Str) => {
    if (!font) { c.codes += b.b.length; c.unknown += b.b.length; return; }
    const r = decodeShown(font, b.b);
    c.codes += r.codes; c.unknown += r.unknown;
    emit(r.text);
  };
  const n = (i: number) => (typeof ops[i] === 'number' ? (ops[i] as number) : 0);
  for (const data of contents) {
    const lx = new Lexer(data);
    for (;;) {
      let t: ReturnType<Lexer['token']>;
      try { t = lx.token(); } catch { break; }
      if (t === undefined) break;
      if (!(t instanceof Op)) {
        let v: Val | Op | undefined;
        try { v = parseValue(lx, t); } catch { break; }
        if (v !== undefined && !(v instanceof Op)) ops.push(v);
        if (ops.length > 64) ops.splice(0, ops.length - 64);
        continue;
      }
      switch (t.op) {
        case 'BI': { // inline image: skip to EI
          const at = indexOfEI(data, lx.pos);
          lx.pos = at < 0 ? data.length : at + 2;
          break;
        }
        case 'q': stack.push({ font, size, leading }); break;
        case 'Q': { const s = stack.pop(); if (s) ({ font, size, leading } = s); break; }
        case 'BT': lineY = null; curY = 0; moved = false; break;
        case 'ET': c.out.push('\n'); break;
        case 'Tf': {
          const nm = ops[ops.length - 2];
          size = Math.abs(n(ops.length - 1)) || size;
          font = nm instanceof Name ? loadFont(doc, fontDict?.get(nm.n), fonts) : font;
          break;
        }
        case 'TL': leading = n(ops.length - 1); break;
        case 'Td': curY += n(ops.length - 1); moved = true; break;
        case 'TD': leading = -n(ops.length - 1); curY += n(ops.length - 1); moved = true; break;
        case 'Tm': curY = n(ops.length - 1); moved = true; break;
        case 'T*': curY -= leading || size; moved = true; break;
        case 'Tj': { const s = ops[ops.length - 1]; if (s instanceof Str) show(s); break; }
        case "'": { curY -= leading || size; moved = true; const s = ops[ops.length - 1]; if (s instanceof Str) show(s); break; }
        case '"': { curY -= leading || size; moved = true; const s = ops[ops.length - 1]; if (s instanceof Str) show(s); break; }
        case 'TJ': {
          const arr = ops[ops.length - 1];
          if (Array.isArray(arr)) {
            for (const x of arr) {
              if (x instanceof Str) show(x);
              else if (typeof x === 'number' && x < -180 && c.out.length && !/\s$/.test(c.out[c.out.length - 1])) c.out.push(' ');
            }
          }
          break;
        }
        case 'Do': {
          const nm = ops[ops.length - 1];
          if (depth >= MAX_FORM_DEPTH || !(nm instanceof Name)) break;
          const xo = resolve(doc, xobjects?.get(nm.n));
          if (!(xo instanceof Stream) || nameOf(doc, xo.dict.get('Subtype')) !== 'Form') break;
          let body: Uint8Array;
          try { body = decodeStream(doc, xo); } catch (e) { if (e instanceof PdfError) throw e; break; }
          c.out.push('\n');
          pageText(doc, [body], dictOf(doc, xo.dict.get('Resources')) ?? resources, fonts, c, depth + 1);
          c.out.push('\n');
          break;
        }
        default: break;
      }
      ops.length = 0;
    }
  }
}

function indexOfEI(data: Uint8Array, from: number): number {
  for (let i = from; i + 1 < data.length; i++) {
    if (data[i] === 0x45 && data[i + 1] === 0x49 && WS[data[i - 1]] && (i + 2 >= data.length || WS[data[i + 2]])) return i;
  }
  return -1;
}

function tidy(s: string): string {
  return s.replace(/\u0000/g, '').replace(/[ \t ]+/g, ' ').split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* --------------------------------------------------------------- pages */

function collectPages(doc: Doc, root: Dict): Array<{ dict: Dict; resources: Dict | undefined }> {
  const out: Array<{ dict: Dict; resources: Dict | undefined }> = [];
  const seen = new Set<Val>();
  const walk = (ref: Val | undefined, inherited: Dict | undefined, depth: number) => {
    if (depth > 64 || out.length >= PDF_MAX_PAGES) return;
    const node = resolve(doc, ref);
    if (!isDict(node) || seen.has(node)) return;
    seen.add(node);
    const res = dictOf(doc, node.get('Resources')) ?? inherited;
    const kids = arrOf(doc, node.get('Kids'));
    const type = nameOf(doc, node.get('Type'));
    if (kids && type !== 'Page') { for (const k of kids) walk(k, res, depth + 1); return; }
    out.push({ dict: node, resources: res });
  };
  walk(root.get('Pages'), undefined, 0);
  return out;
}

function findRoot(doc: Doc): Dict | undefined {
  for (let i = doc.trailers.length - 1; i >= 0; i--) {
    const r = dictOf(doc, doc.trailers[i].get('Root'));
    if (r) return r;
  }
  for (const v of doc.objs.values()) if (isDict(v) && nameOf(doc, v.get('Type')) === 'Catalog') return v;
  return undefined;
}

/** Extract the text of every page, or say why it cannot be read. */
export function extractPdfText(buf: Buffer): PdfResult {
  if (buf.length > PDF_MAX_BYTES) return { ok: false, reason: 'too_large' };
  const head = buf.subarray(0, 1024).toString('latin1');
  if (!head.includes('%PDF-')) return { ok: false, reason: 'not_pdf' };
  const doc: Doc = { objs: new Map(), trailers: [], totalOut: 0 };
  try {
    readObjects(buf, doc);
    if (doc.trailers.some((t) => t.has('Encrypt'))) return { ok: false, reason: 'encrypted' };
    const root = findRoot(doc);
    if (!root) return { ok: false, reason: 'damaged' };
    const pages = collectPages(doc, root);
    if (pages.length === 0) return { ok: false, reason: 'damaged' };
    const fonts = new Map<Val, Font>();
    const c: Collect = { out: [], codes: 0, unknown: 0 };
    const result: PdfPage[] = [];
    pages.forEach((p, i) => {
      const contentsVal = resolve(doc, p.dict.get('Contents'));
      const streams = (Array.isArray(contentsVal) ? contentsVal.map((x) => resolve(doc, x)) : [contentsVal]).filter((x): x is Stream => x instanceof Stream);
      const datas: Uint8Array[] = [];
      for (const s of streams) {
        try { datas.push(decodeStream(doc, s)); } catch (e) { if (e instanceof PdfError) throw e; }
      }
      c.out = [];
      // The streams of one page form one content stream (an operator may span two).
      pageText(doc, datas.length > 1 ? [joinStreams(datas)] : datas, p.resources, fonts, c, 0);
      result.push({ page: i + 1, text: tidy(c.out.join('')) });
    });
    const letters = result.reduce((s, p) => s + (p.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0), 0);
    if (c.codes > 0 && c.unknown / c.codes > MAX_UNKNOWN_SHARE) return { ok: false, reason: 'fonts' };
    if (letters < 1) return { ok: false, reason: 'no_text' };
    return { ok: true, pages: result, pageCount: pages.length };
  } catch (e) {
    if (e instanceof PdfError) return { ok: false, reason: e.reason };
    return { ok: false, reason: 'damaged' };
  }
}

function joinStreams(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length + 1, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; out[o++] = 10; }
  return out;
}
