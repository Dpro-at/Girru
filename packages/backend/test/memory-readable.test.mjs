// MEM-READ-01 MR1: a memory row reads as a title and two clean lines (no ** marks, no file-name prefix).
// Run: node --import tsx --test test/memory-readable.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { readableMemory, plainWords } = await import(pathToFileURL(join(process.cwd(), 'src/memory/readable.ts')).href);

test('imported note: file name dropped, text before " — " is the title, Markdown marks gone', () => {
  const r = readableMemory('project-vps-ssh: VPS SSH access and deploy commands — **VPS:** Hostinger KVM 2 in Frankfurt, Ubuntu 24.04. **SSH login:** [SECRET:password:k3j9x0a1bq]\n## Deploy\nssh grenzer-vps');
  assert.equal(r.title, 'VPS SSH access and deploy commands');
  assert.equal(r.lines, 'VPS: Hostinger KVM 2 in Frankfurt, Ubuntu 24.04. SSH login: [SECRET:password:k3j9x0a1bq] Deploy ssh grenzer-vps');
  assert.doesNotMatch(r.lines, /\*\*|##/);
});

test('own heading first: it is the title; the rest are the lines', () => {
  const r = readableMemory('# Stripe test mode for billing\n\n- The **product**, price and [webhook](https://example.test/x) set up.\n- `sk_test` account is active.');
  assert.equal(r.title, 'Stripe test mode for billing');
  assert.equal(r.lines, 'The product, price and webhook set up. sk_test account is active.');
});

test('plain fact: first sentence; short text is the title alone; long text is cut on a word', () => {
  assert.deepEqual(readableMemory('Default local model is qwen3.5:9b.'), { title: 'Default local model is qwen3.5:9b', lines: '' });
  assert.deepEqual(readableMemory('Mohamed likes teal'), { title: 'Mohamed likes teal', lines: '' });
  const long = readableMemory('word '.repeat(120));
  assert.ok(long.title.length <= 61 && long.title.endsWith('…'));
  assert.ok(long.lines.length <= 241);
  assert.equal(plainWords('a *b* and __c__ | d'), 'a b and c d');
  assert.deepEqual(readableMemory(''), { title: '', lines: '' });
});
