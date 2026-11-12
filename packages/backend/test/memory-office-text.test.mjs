// MEM-READ-01 MR8: own readers for .docx .xlsx .pptx OpenDocument .csv .rtf .html .json .yaml (text only, no packages).
// Run: node --import tsx --test test/memory-office-text.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const O = await import(pathToFileURL(join(process.cwd(), 'src/memory/docs/office-text.ts')).href);
const I = await import(pathToFileURL(join(process.cwd(), 'src/memory/docs/indexer.ts')).href);

/** A minimal zip (deflated entries, central directory) like an office app writes. */
function zip(files) {
  const locals = [], central = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), data = deflateRawSync(raw), n = Buffer.from(name), crc = crc32 ? crc32(raw) : 0;
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8); l.writeUInt32LE(crc >>> 0, 14); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc >>> 0, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(l, n, data); central.push(c, n); offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, e]);
}

test('Word: headings, lists, tables and the page count', () => {
  const doc = zip({
    'word/document.xml': `<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Hosting contract</w:t></w:r></w:p>
      <w:p><w:r><w:t xml:space="preserve">Server in </w:t></w:r><w:r><w:t>Frankfurt &amp; backups</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>Monthly price</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Plan</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Price</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>KVM 2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>8 €</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`,
    'docProps/app.xml': '<Properties><Pages>6</Pages></Properties>' });
  const r = O.officeText('docx', doc);
  assert.equal(r.ok, true);
  assert.equal(r.info, '6 pages, 1 table');
  assert.equal(r.sections[0].text, '# Hosting contract\nServer in Frankfurt & backups\n- Monthly price\nPlan | Price\nKVM 2 | 8 €');
});

test('Excel: each sheet as a table with shared strings; PowerPoint: slides with notes', () => {
  const x = zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Free" sheetId="1" r:id="rId1"/><sheet name="Pro" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Feature</t></si><si><t>Price</t></si><si><r><t>Fire</t></r><r><t>wall</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c t="s"><v>2</v></c><c><v>0</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row><c t="inlineStr"><is><t>Backups</t></is></c><c><v>9.5</v></c></row></sheetData></worksheet>' });
  const r = O.officeText('xlsx', x);
  assert.deepEqual([r.info, r.sections.map(s => s.label)], ['2 sheets', ['sheet Free', 'sheet Pro']]);
  assert.equal(r.sections[0].text, '## Free\nFeature | Price\nFirewall | 0');
  assert.equal(r.sections[1].text, '## Pro\nBackups | 9.5');
  const p = zip({ 'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Pricing</a:t></a:r></a:p></p:sld>', 'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Grenzer</a:t></a:r></a:p><a:p><a:r><a:t>Server security</a:t></a:r></a:p></p:sld>',
    'ppt/notesSlides/notesSlide1.xml': '<p:notes><a:p><a:r><a:t>Say hello</a:t></a:r></a:p><a:p><a:r><a:t>1</a:t></a:r></a:p></p:notes>' });
  const s = O.officeText('pptx', p);
  assert.equal(s.info, '2 slides with notes');
  assert.deepEqual(s.sections.map(x => x.text), ['## Slide 1\nGrenzer\nServer security\nNotes: Say hello', '## Slide 2\nPricing']);
});

test('OpenDocument sheet; CSV first rows; RTF; HTML; JSON as text', () => {
  const ods = zip({ 'content.xml': '<office:document-content><office:body><office:spreadsheet><table:table table:name="Customers"><table:table-row><table:table-cell><text:p>Name</text:p></table:table-cell><table:table-cell><text:p>Plan</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell><text:p>Ada</text:p></table:table-cell><table:table-cell><text:p>Pro</text:p></table:table-cell><table:table-cell/></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>' });
  const r = O.officeText('ods', ods);
  assert.equal(r.info, '1 sheet'); assert.equal(r.sections[0].label, 'sheet Customers'); assert.equal(r.sections[0].text, '## Customers\nName | Plan\nAda | Pro');
  const rows = ['name,plan', ...Array.from({ length: 250 }, (_, i) => `"Customer, ${i}",Pro`)].join('\n');
  const c = O.officeText('csv', Buffer.from(rows));
  assert.equal(c.info, 'columns and the first 200 rows'); assert.equal(c.sections[0].text.split('\n').length, 201); assert.equal(c.sections[0].text.split('\n')[1], 'Customer, 0 | Pro');
  assert.equal(O.rtfText('{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Hello \\b bold\\b0\\par Caf\\\'e9 \\u8364?}'), 'Hello bold\nCafé €');
  assert.equal(O.htmlText('<html><head><style>x{}</style></head><body><h1>Title</h1><p>One &amp; two</p><ul><li>a</li></ul><script>evil()</script></body></html>'), '# Title\nOne & two\n- a');
  assert.deepEqual(O.officeText('json', Buffer.from('{"a":1}')), { ok: true, sections: [{ label: 'json', text: '{"a":1}' }], count: 1, info: 'as text' });
});

test('unreadable files say why; the indexer cites sheets and slides and keeps the info line', () => {
  assert.deepEqual(O.officeText('docx', Buffer.from('not a zip')), { ok: false, reason: 'damaged or not really this format' });
  assert.deepEqual(I.extractChunks('notread', Buffer.alloc(0), 'Old offer.doc'), { ok: false, reason: 'old Word format; save it as .docx' });
  assert.deepEqual(I.extractChunks('notread', Buffer.alloc(0), 'backup.zip'), { ok: false, reason: 'archives are skipped' });
  const x = zip({ 'xl/workbook.xml': '<workbook><sheets><sheet name="Pro" r:id="rId1"/></sheets></workbook>', 'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c t="inlineStr"><is><t>api_key=sk_test_ABCDEFGHIJKLMNOP1234</t></is></c></row></sheetData></worksheet>' });
  const ex = I.extractChunks('xlsx', x, 'Pricing plans.xlsx');
  assert.equal(ex.ok, true); assert.equal(ex.info, '1 sheet'); assert.equal(ex.pages, 1);
  assert.doesNotMatch(JSON.stringify(ex.chunks), /ABCDEFGHIJKLMNOP/, 'keys inside a document are hidden before agents see the text');
});
