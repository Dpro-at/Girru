// CHAT-LIVE-01: the read tool reads big files in parts, lists folders and
// searches; write says plainly that a project file was not changed; a big
// tool result is cut for the coding app instead of failing the reply.
// Throwaway folder; no DB, no network, no port.
// Run: node --import tsx --test test/read-parts-search.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-read-parts-')));
process.chdir(dir);
console.error = () => {};
console.log = () => {};

const project = join(dir, 'project');
mkdirSync(join(project, 'docs'), { recursive: true });
mkdirSync(join(project, 'node_modules', 'x'), { recursive: true });
const big = Array.from({ length: 120000 }, (_, i) => `line ${i + 1}${i === 99999 ? ' CHAT-LIVE-01 row' : ''}`).join('\n');
writeFileSync(join(project, 'docs', 'HANDOFF.md'), big); // ~1.3 MB, over the old 1 MiB limit
writeFileSync(join(project, 'notes.md'), '# Shop\nName: TBD\n');
writeFileSync(join(project, '.env'), 'SECRET=chat-live-01-secret\n');
writeFileSync(join(project, 'node_modules', 'x', 'a.js'), 'CHAT-LIVE-01 in a dependency');
writeFileSync(join(dir, 'outside.md'), 'CHAT-LIVE-01 outside');
symlinkSync(join(dir, 'outside.md'), join(project, 'link.md'));

const { readTool } = await import(join(backendDir, 'src/tools/core/read.ts'));
const { writeTool } = await import(join(backendDir, 'src/tools/core/write.ts'));
const { toolReceipt, RECEIPT_BYTES } = await import(join(backendDir, 'src/services/subscription-tool-loop.ts'));
const ctx = { workspaceDir: dir, agentId: 'a1', fileReadRoot: project };
const read = (p) => readTool.execute(p, ctx);
const text = (r) => r.content.map((b) => b.text).join('\n');

test('a big file is no longer refused: first lines and the line count', async () => {
  const r = await read({ path: 'docs/HANDOFF.md' });
  assert.equal(r.error, undefined, text(r));
  assert.match(text(r), /lines 1–\d+ of 120000/);
  assert.ok(text(r).length <= 16_200);
});

test('tail and offset/limit return the asked lines with numbers', async () => {
  const t = await read({ path: 'docs/HANDOFF.md', tail: 3 });
  assert.match(text(t), /lines 119998–120000 of 120000/);
  assert.match(text(t), /120000\tline 120000$/);
  const o = await read({ path: 'docs/HANDOFF.md', offset: 50, limit: 2 });
  assert.match(text(o), /50\tline 50\n51\tline 51$/);
});

test('pattern finds a row in a big file and across the folder, skipping secrets, dependencies and links', async () => {
  const one = await read({ path: 'docs/HANDOFF.md', pattern: 'chat-live-01' });
  assert.match(text(one), /1 matches/);
  assert.match(text(one), /docs\/HANDOFF\.md:100000: line 100000 CHAT-LIVE-01 row/);
  const all = await read({ path: '.', pattern: 'CHAT-LIVE-01' });
  assert.match(text(all), /HANDOFF\.md:100000/);
  assert.doesNotMatch(text(all), /dependency|outside|secret/i);
  const secret = await read({ path: '.', pattern: 'SECRET' });
  assert.match(text(secret), /No match/);
});

test('a folder lists its entries without secret files', async () => {
  const r = await read({ path: '.' });
  assert.match(text(r), /docs\//);
  assert.match(text(r), /notes\.md  \d+ bytes/);
  assert.doesNotMatch(text(r), /\.env/);
});

test('the old guards still hold', async () => {
  assert.ok((await read({ path: '.env' })).error);
  assert.ok((await read({ path: '../outside.md' })).error);
  assert.ok((await read({ path: 'link.md' })).error);
  assert.ok((await read({ path: 'notes.md', limit: -1 })).error);
});

test('write in a project chat says the project file is not changed', async () => {
  const r = await writeTool.execute({ path: 'notes.md', content: '# Shop\nName: Little Ember\n' }, ctx);
  assert.equal(r.error, undefined);
  assert.match(text(r), /private draft/);
  assert.match(text(r), /NOT changed/);
  assert.equal(r.details.privateDraft, true);
  assert.equal(readFileSync(join(project, 'notes.md'), 'utf8'), '# Shop\nName: TBD\n');
});

test('a big tool result is cut for the coding app instead of failing', () => {
  const huge = { content: [{ type: 'text', text: 'x'.repeat(700_000) }], details: { size: 1 } };
  const out = toolReceipt(huge);
  assert.ok(Buffer.byteLength(out) <= RECEIPT_BYTES);
  assert.match(JSON.parse(out).content[0].text, /cut to fit/);
  const small = { content: [{ type: 'text', text: 'ok' }] };
  assert.equal(toolReceipt(small), JSON.stringify(small));
});
