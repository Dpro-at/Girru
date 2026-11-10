import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {packProject, unpackProject, copyParts, safeCopyPath} from '../src/devices/project-copy.ts';

test('a project copy carries its files, not ignored or secret files or links, and lands only in a new folder', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'girru-copy-')));
  try {
    const src = path.join(root, 'site'); fs.mkdirSync(src);
    execFileSync('git', ['init', '-q'], {cwd: src});
    fs.writeFileSync(path.join(src, '.gitignore'), 'node_modules/\nlogs/\n');
    fs.mkdirSync(path.join(src, 'src')); fs.writeFileSync(path.join(src, 'src', 'index.html'), '<h1>Hi</h1>\n');
    fs.writeFileSync(path.join(src, 'run.sh'), 'echo hi\n', {mode: 0o755});
    fs.mkdirSync(path.join(src, 'node_modules', 'x'), {recursive: true}); fs.writeFileSync(path.join(src, 'node_modules', 'x', 'a.js'), '1');
    fs.mkdirSync(path.join(src, 'logs')); fs.writeFileSync(path.join(src, 'logs', 'today.log'), 'x');
    fs.writeFileSync(path.join(src, '.env'), 'API_KEY=never-copy\n');
    fs.symlinkSync('/etc/hosts', path.join(src, 'hosts-link'));
    const packed = await packProject(src);
    assert.equal(packed.files, 3, '.gitignore, src/index.html and run.sh only');
    const text = copyParts(packed.text).join('');
    const out = path.join(root, 'office'); fs.mkdirSync(out);
    const got = unpackProject(text, packed, out, 'site');
    assert.equal(got.files, 3);
    assert.equal(fs.readFileSync(path.join(out, 'site', 'src', 'index.html'), 'utf8'), '<h1>Hi</h1>\n');
    assert.equal(fs.statSync(path.join(out, 'site', 'run.sh')).mode & 0o111, 0o111, 'runnable stays runnable');
    for (const n of ['.env', 'hosts-link', 'node_modules', 'logs']) assert.equal(fs.existsSync(path.join(out, 'site', n)), false, n);
    assert.throws(() => unpackProject(text, packed, out, 'site'), /folder_exists/, 'never into an existing folder');
    assert.throws(() => unpackProject(text + 'x', packed, out, 'site2'), /copy_changed/);
    const evil = gzipSync(Buffer.from(JSON.stringify({v: 1, files: [{p: '../escape.txt', m: 0o644, d: ''}]}))).toString('base64');
    assert.throws(() => unpackProject(evil, {size: evil.length, sha256: createHash('sha256').update(evil).digest('hex')}, out, 'evil'), /copy_invalid/);
    assert.equal(fs.existsSync(path.join(out, 'escape.txt')), false);
    for (const bad of ['../x', '/etc/x', 'a/.git/hooks/x', 'a/./b', '.env', 'a\\b', '']) assert.equal(safeCopyPath(bad), false, bad);
    assert.equal(safeCopyPath('src/app.ts'), true);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
