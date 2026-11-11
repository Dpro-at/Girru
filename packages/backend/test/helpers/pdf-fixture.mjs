// Small PDF files built by hand for the document-memory tests (KNOW-INDEX-01). Plain Node (zlib).
// Each builder returns a Buffer. Cross-reference offsets are not needed by the reader, so the
// xref table is a placeholder, as in many damaged-but-readable files.
import { deflateSync } from 'node:zlib';

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

function assemble(objects, trailer) {
  const parts = ['%PDF-1.5\n%\xe2\xe3\xcf\xd3\n'];
  for (const [num, body] of objects) parts.push(typeof body === 'string' ? `${num} 0 obj\n${body}\nendobj\n` : body);
  if (trailer) parts.push(`xref\n0 1\n0000000000 65535 f \ntrailer\n${trailer}\nstartxref\n0\n%%EOF\n`);
  else parts.push('startxref\n0\n%%EOF\n');
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1'))));
}

function streamObj(num, dictExtra, data, { compress = true } = {}) {
  const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
  const body = compress ? deflateSync(raw) : raw;
  return Buffer.concat([
    Buffer.from(`${num} 0 obj\n<< /Length ${body.length}${compress ? ' /Filter /FlateDecode' : ''} ${dictExtra} >>\nstream\n`, 'latin1'),
    body,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]);
}

/** Lines of text per page with Helvetica (WinAnsi), Flate content streams, resources inherited from the page tree. */
export function simplePdf(pages, { encrypt = false } = {}) {
  const objs = [];
  const kids = pages.map((_, i) => `${10 + i * 2} 0 R`).join(' ');
  objs.push([1, '<< /Type /Catalog /Pages 2 0 R >>']);
  objs.push([2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} /Resources << /Font << /F1 3 0 R >> >> >>`]);
  objs.push([3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']);
  pages.forEach((lines, i) => {
    const content = ['BT', '/F1 12 Tf', '14 TL', '72 720 Td', ...lines.map((l, k) => `${k ? 'T* ' : ''}(${esc(Buffer.from(l, 'latin1').toString('latin1'))}) Tj`), 'ET'].join('\n');
    objs.push([10 + i * 2, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${11 + i * 2} 0 R >>`]);
    objs.push([11 + i * 2, streamObj(11 + i * 2, '', content)]);
  });
  return assemble(objs, `<< /Root 1 0 R /Size ${12 + pages.length * 2}${encrypt ? ' /Encrypt 9 0 R' : ''} >>`);
}

/**
 * One page set in a Type0 font (Identity-H, 2-byte codes) whose ToUnicode map gives the letters;
 * the page tree and the font live in a compressed object stream, the trailer is an XRef stream.
 * `toUnicode: false` leaves the map out (the letters cannot be known).
 */
export function cidPdf(text, { toUnicode = true } = {}) {
  const chars = [...new Set([...text])];
  const code = (c) => (chars.indexOf(c) + 1).toString(16).padStart(4, '0');
  const hex = [...text].map(code).join('');
  const bfchar = chars.map((c) => `<${code(c)}> <${c.codePointAt(0).toString(16).padStart(4, '0')}>`).join('\n');
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chars.length} beginbfchar\n${bfchar}\nendbfchar\nendcmap\nend\nend`;
  // Kerning in a TJ array: a large negative number between words is a space.
  const words = hex.match(/.{4}/g);
  const spaceCode = code(' ');
  const tj = words.map((w) => (w === spaceCode ? ') -400 (' : w)).join('');
  const content = `BT /F2 11 Tf 1 0 0 1 72 700 Tm [<${tj.split(') -400 (').join('> -400 <')}>] TJ ET`;
  const packed = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F2 5 0 R >> >> /Contents 4 0 R >>`],
    [5, `<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+NotoSans /Encoding /Identity-H /DescendantFonts [6 0 R]${toUnicode ? ' /ToUnicode 7 0 R' : ''} >>`],
    [6, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+NotoSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>'],
  ];
  let header = '', bodies = '';
  for (const [n, b] of packed) { header += `${n} ${bodies.length} `; bodies += `${b}\n`; }
  const objstm = header + bodies;
  return assemble([
    [4, streamObj(4, '', content)],
    ...(toUnicode ? [[7, streamObj(7, '', cmap)]] : []),
    [8, streamObj(8, `/Type /ObjStm /N ${packed.length} /First ${header.length}`, objstm)],
    [9, streamObj(9, '/Type /XRef /Size 10 /Root 1 0 R /W [1 2 1] /Index [0 10]', Buffer.alloc(40))],
  ], null);
}

/** A page with only a picture (a scan): no text at all. */
export function imageOnlyPdf() {
  const img = Buffer.alloc(30, 0x80);
  return assemble([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>'],
    [4, streamObj(4, '', 'q 100 0 0 100 0 0 cm /Im1 Do Q')],
    [5, streamObj(5, '/Type /XObject /Subtype /Image /Width 10 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8', img, { compress: false })],
  ], '<< /Root 1 0 R /Size 6 >>');
}
