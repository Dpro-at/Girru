// CHAT-CONTENT-01: a PDF in the project folder opens in the viewer as its pages' text
// (the document memory's own reader); secrets and other files are refused.
// Run: node --import tsx --test test/project-pdf.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'project-pdf-')));
const { readFolderPdf } = await import(join(backendDir, 'src/repositories/project-files.ts'));

function pdf(text) {
  const stream = Buffer.from(`BT /F1 14 Tf 50 750 Td (${text}) Tj ET`);
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('a PDF opens as pages of text', async () => {
  writeFileSync(join(dir, 'invoice.pdf'), pdf('Total: 480.00 EUR'));
  const r = await readFolderPdf(dir, 'invoice.pdf');
  assert.equal(r.pageCount, 1);
  assert.match(r.pages[0].text, /Total: 480\.00 EUR/);
});

test('not a PDF, outside the folder, or not readable: refused or a reason', async () => {
  writeFileSync(join(dir, 'fake.pdf'), 'not a pdf');
  assert.equal((await readFolderPdf(dir, 'fake.pdf')).reason, 'not_pdf');
  await assert.rejects(readFolderPdf(dir, 'notes.md'));
  await assert.rejects(readFolderPdf(dir, '../x.pdf'));
});
