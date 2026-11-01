import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceDiscoveryFile } from '../src/services/replace-discovery-file.ts';

test('Windows sharing locks retain the old checkpoint until atomic replacement succeeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'checkpoint-replace-'));
  const source = join(dir, 'next.json'), target = join(dir, 'current.json');
  await writeFile(source, 'new'); await writeFile(target, 'old');
  let attempts = 0; const waits = [];
  try {
    await replaceDiscoveryFile(source, target, { platform: 'win32',
      rename: async (from, to) => { if (++attempts < 4) throw Object.assign(new Error('locked'), { code: ['EPERM', 'EBUSY', 'EACCES'][attempts - 1] }); await rename(from, to); },
      pause: async ms => { waits.push(ms); assert.equal(await readFile(target, 'utf8'), 'old'); }
    });
    assert.equal(attempts, 4); assert.deepEqual(waits, [25, 50, 100]); assert.equal(await readFile(target, 'utf8'), 'new');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('persistent Windows locks fail after a bounded wait without hiding the error', async () => {
  let attempts = 0, wait = 0;
  const error = Object.assign(new Error('locked'), { code: 'EPERM' });
  await assert.rejects(replaceDiscoveryFile('next', 'current', { platform: 'win32', rename: async () => { attempts++; throw error; }, pause: async ms => { wait += ms; } }), error);
  assert.equal(attempts, 6); assert.equal(wait, 775);
});

for (const [platform, code] of [['linux', 'EPERM'], ['win32', 'ENOENT']]) test(`${platform} ${code} is not retried`, async () => {
  let attempts = 0;
  await assert.rejects(replaceDiscoveryFile('next', 'current', { platform, rename: async () => { attempts++; throw Object.assign(new Error('failure'), { code }); }, pause: async () => assert.fail('unexpected wait') }), { code });
  assert.equal(attempts, 1);
});
