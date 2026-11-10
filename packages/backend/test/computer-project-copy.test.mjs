import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {packProject, unpackProject, copyParts, safeCopyPath, readListedFile} from '../src/devices/project-copy.ts';

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

test('names macOS or Windows could read as .git, or with invisible characters, never land', () => {
  for (const bad of ['a/.git./x', 'a/.git /x', 'GIT~1/config', 'a/name.', 'a/name ', 'a/.g​it/x', 'x/﻿file']) assert.equal(safeCopyPath(bad), false, JSON.stringify(bad));
  assert.equal(safeCopyPath('docs/readme.md'), true);
});

test('NTFS streams, Windows-reserved characters and every invisible format character are refused', () => {
  for (const bad of ['.git::$INDEX_ALLOCATION/x', '.GIT:$DATA', 'a/b:stream', 'a/.g‌it/x', 'a/.g⁪it/x', 'a/x?y', 'a/x|y', 'a/x<y', 'a/x*y']) assert.equal(safeCopyPath(bad), false, JSON.stringify(bad));
  assert.equal(safeCopyPath('src/notes-2026.md'), true);
});

test('a folder without git: a link to a file outside the project is never carried, real files are', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'girru-copy-nogit-')));
  try {
    const src = path.join(root, 'plain'); fs.mkdirSync(src);
    const outside = path.join(root, 'private.txt'); fs.writeFileSync(outside, 'outside the project\n');
    fs.writeFileSync(path.join(src, 'page.html'), '<p>ok</p>\n');
    fs.symlinkSync(outside, path.join(src, 'looks-normal.txt'));
    const packed = await packProject(src);
    assert.equal(packed.files, 1, 'only page.html');
    const out = path.join(root, 'out'); fs.mkdirSync(out);
    unpackProject(copyParts(packed.text).join(''), packed, out, 'plain');
    assert.equal(fs.existsSync(path.join(out, 'plain', 'looks-normal.txt')), false);
    assert.equal(fs.readFileSync(path.join(out, 'plain', 'page.html'), 'utf8'), '<p>ok</p>\n');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('clone from GitHub: the new folder sits exactly inside the chosen folder and is never reused', async () => {
  const {cloneFromGithub} = await import('../src/devices/work-result.ts');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'girru-clone-')));
  try {
    await assert.rejects(() => cloneFromGithub('https://github.com/owner/site', 'relative/place'), /folder_invalid/);
    await assert.rejects(() => cloneFromGithub('https://github.com/owner/site', path.join(root, 'missing')), /folder_invalid/);
    await assert.rejects(() => cloneFromGithub('https://github.com/owner/..', root), /url_invalid/);
    await assert.rejects(() => cloneFromGithub('https://example.com/owner/site', root), /url_invalid/);
    fs.mkdirSync(path.join(root, 'site'));
    await assert.rejects(() => cloneFromGithub('https://github.com/owner/site.git', root), /folder_exists/, 'checked before git runs');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('a listed file is read only when it is a plain file inside the project: no final link, no link in a parent folder', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'girru-copy-read-')));
  try {
    const project = path.join(root, 'project'), outside = path.join(root, 'outside');
    fs.mkdirSync(project); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'private.txt'), 'outside\n');
    fs.writeFileSync(path.join(project, 'real.txt'), 'inside\n');
    fs.symlinkSync(path.join(outside, 'private.txt'), path.join(project, 'link.txt'));
    fs.symlinkSync(outside, path.join(project, 'linked-dir'));
    const real = readListedFile(path.join(project, 'real.txt'), project);
    assert.equal(typeof real === 'object' && real.bytes.toString('utf8'), 'inside\n');
    assert.equal(readListedFile(path.join(project, 'link.txt'), project), 'skip', 'final link');
    assert.equal(readListedFile(path.join(project, 'linked-dir', 'private.txt'), project), 'skip', 'link in a parent folder');
    assert.equal(readListedFile(path.join(project, 'gone.txt'), project), 'missing');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
