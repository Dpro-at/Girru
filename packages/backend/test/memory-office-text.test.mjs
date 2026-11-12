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

test('hostile input stays fast and bounded', () => {
  const t0 = Date.now();
  O.htmlText('<'.repeat(300000)); O.htmlText('<script>'.repeat(50000)); O.htmlText('<!--'.repeat(100000));
  O.officeText('json', Buffer.from('<'.repeat(300000)));
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  // A part that unpacks past the budget is refused, not read.
  const bomb = zip({ 'word/document.xml': '<w:p><w:t>' + 'a'.repeat(40 * 1024 * 1024) + '</w:t></w:p>' });
  assert.deepEqual(O.officeText('docx', bomb), { ok: false, reason: 'too big' });
});

test('Excel: tab order from the workbook, chart sheets left out, hidden tabs marked; dates, percentages, booleans, gaps', () => {
  const x = zip({
    'xl/workbook.xml': '<workbook><workbookPr/><sheets><sheet name="Summary" r:id="rId2"/><sheet name="Sales" r:id="rId1"/><sheet name="Chart1" state="hidden" r:id="rId3"/><sheet name="Old" state="hidden" r:id="rId4"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="x/chartsheet" Target="chartsheets/sheet1.xml"/><Relationship Id="rId4" Type="x/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId9" Type="x/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml': '<styleSheet><numFmts><numFmt numFmtId="165" formatCode="dd.mm.yyyy"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="9"/><xf numFmtId="165"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Sales</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><r><t>Gro</t></r><r><t>wth</t></r></is></c><c r="B1" s="1"><v>0.19</v></c><c r="D1" s="2"><v>45000</v></c><c r="E1" t="b"><v>1</v></c><c r="F1" t="str"><f>A1</f><v>Growth</v></c></row></sheetData></worksheet>',
    'xl/chartsheets/sheet1.xml': '<chartsheet/>',
    'xl/worksheets/sheet3.xml': '<worksheet><sheetData><row><c t="inlineStr"><is><t>kept</t></is></c></row></sheetData></worksheet>' });
  const r = O.officeText('xlsx', x);
  assert.deepEqual(r.sections.map(s => s.label), ['sheet Summary', 'sheet Sales', 'sheet Old']);
  assert.equal(r.sections[0].text, '## Summary\nGrowth | 19% |  | 2023-03-15 | TRUE | Growth');
  assert.equal(r.sections[2].text, '## Old (hidden)\nkept');
  assert.equal(r.info, '3 sheets, 1 hidden');
});

test('Word footnotes and headers once; PowerPoint order from the presentation; OpenDocument repeated cells', () => {
  const d = zip({
    '_rels/.rels': '<Relationships><Relationship Id="r1" Type="x/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Main text</w:t></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del></w:p></w:body></w:document>',
    'word/_rels/document.xml.rels': '<Relationships><Relationship Id="a" Type="x/footnotes" Target="footnotes.xml"/><Relationship Id="b" Type="x/header" Target="header1.xml"/><Relationship Id="c" Type="x/header" Target="header2.xml"/></Relationships>',
    'word/footnotes.xml': '<w:footnotes><w:footnote><w:p><w:r><w:t>See the contract.</w:t></w:r></w:p></w:footnote></w:footnotes>',
    'word/header1.xml': '<w:hdr><w:p><w:r><w:t>Grenzer · confidential</w:t></w:r></w:p><w:p><w:r><w:t>Page 3</w:t></w:r></w:p></w:hdr>',
    'word/header2.xml': '<w:hdr><w:p><w:r><w:t>Grenzer · confidential</w:t></w:r></w:p></w:hdr>' });
  const w = O.officeText('docx', d);
  assert.deepEqual(w.sections.map(s => s.text), ['Main text', '## Notes\nSee the contract.', '## Headers and footers\nGrenzer · confidential']);
  const p = zip({
    'ppt/presentation.xml': '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId2" Type="x/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="x/slide" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>', 'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>',
    'ppt/slides/_rels/slide2.xml.rels': '<Relationships><Relationship Id="n" Type="x/notesSlide" Target="../notesSlides/notesSlide7.xml"/></Relationships>',
    'ppt/notesSlides/notesSlide7.xml': '<p:notes><a:p><a:r><a:t>Open with this</a:t></a:r></a:p></p:notes>' });
  assert.deepEqual(O.officeText('pptx', p).sections.map(s => s.text), ['## Slide 1\nFirst\nNotes: Open with this', '## Slide 2\nSecond']);
  const ods = zip({ 'content.xml': '<office:spreadsheet><table:table table:name="T"><table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="2"><text:p>x</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1000"/></table:table-row><table:table-row table:number-rows-repeated="1048000"><table:table-cell table:number-columns-repeated="1024"/></table:table-row></table:table></office:spreadsheet>' });
  assert.equal(O.officeText('ods', ods).sections[0].text, '## T\nx | x\nx | x');
});

test('a row of countless empty cells stays bounded and fast', () => {
  const cells = '<c/>'.repeat(200000) + '<c r="A1" t="inlineStr"><is><t>end</t></is></c>';
  const x = zip({ 'xl/workbook.xml': '<workbook><sheets><sheet name="S" r:id="r1"/></sheets></workbook>', 'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row>${cells}</row><row><c t="inlineStr"><is><t>next</t></is></c></row></sheetData></worksheet>` });
  const t0 = Date.now(); const r = O.officeText('xlsx', x);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  assert.equal(r.ok, true); assert.ok(r.sections[0].text.length < 5000);
});
