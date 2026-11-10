process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {startSnapshot, finishWork, patchParts, saveResult, savePart, readResult, directPatch, bringInto, branchFor, PART_CHARS} from '../src/devices/work-result.ts';

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', ...a], {cwd, encoding: 'utf8'});
function repo(root, name) { const d = path.join(root, name); fs.mkdirSync(d); git(d, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(d, 'app.txt'), 'one\ntwo\n'); fs.writeFileSync(path.join(d, '.gitignore'), ''); git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base'); return d; }

test('CP10: the work comes back directly in parts and Bring into puts it in the project, uncommitted; secrets never travel', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'girru-work-')));
  try {
    const office = repo(root, 'office'), mac = path.join(root, 'mac');
    git(root, 'clone', '-q', office, mac);
    const start = await startSnapshot(office);
    assert.ok(start, 'a git folder gives a snapshot');
    fs.writeFileSync(path.join(office, 'app.txt'), 'one\ntwo changed\n' + 'x'.repeat(PART_CHARS * 2) + '\n');
    fs.writeFileSync(path.join(office, 'new.md'), '# New\n');
    fs.writeFileSync(path.join(office, '.env'), 'API_KEY=should-never-travel\n');
    const {result, patch} = await finishWork({folder: office, start, computer: 'Office PC', taskId: 'task1', title: 'Change app'});
    assert.equal(result.mode, 'direct', 'no GitHub remote: it travels inside the channel');
    assert.deepEqual(result.files.map(f => f.path).sort(), ['app.txt', 'new.md']);
    assert.ok(!patch.includes('should-never-travel'));
    const parts = patchParts(patch); assert.equal(parts.length, result.parts); assert.ok(parts.length >= 3);
    const data = path.join(root, 'data');
    parts.forEach((p, i) => savePart(data, 'task1', i, p)); saveResult(data, result, 'peer');
    const back = readResult(data, 'task1'); assert.equal(back.state, 'ready');
    const done = await bringInto(mac, directPatch(data, back));
    assert.deepEqual(done, {ok: true});
    assert.equal(fs.readFileSync(path.join(mac, 'app.txt'), 'utf8'), fs.readFileSync(path.join(office, 'app.txt'), 'utf8'));
    assert.equal(fs.existsSync(path.join(mac, '.env')), false);
    assert.match(git(mac, 'status', '--porcelain'), /app\.txt/, 'left for the owner to review and save');
    savePart(data, 'task1', 0, parts[0] + 'tampered');
    assert.throws(() => directPatch(data, back), /computer_result_changed/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('CP10: branch names are per computer and task, and plain', () => {
  assert.equal(branchFor('Office PC', 'abc-123'), 'girru/office-pc/abc-123');
  assert.equal(branchFor('***', 't'), 'girru/computer/t');
});

test('CP10: with a GitHub origin the work goes up as this computer\'s branch and comes back from there', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'girru-gh-')));
  try {
    const hub = path.join(root, 'hub.git'); execFileSync('git', ['init', '-q', '--bare', hub]);
    const office = repo(root, 'office'); git(office, 'remote', 'add', 'origin', hub); git(office, 'push', '-q', 'origin', 'main');
    git(office, 'config', 'user.name', 'Owner'); git(office, 'config', 'user.email', 'owner@example.invalid');
    const mac = path.join(root, 'mac'); git(root, 'clone', '-q', hub, mac);
    process.env.GIRRU_TEST_GITHUB_REMOTE = hub;
    const start = await startSnapshot(office);
    fs.writeFileSync(path.join(office, 'app.txt'), 'one\ntwo from office\n');
    const {result, patch} = await finishWork({folder: office, start, computer: 'Office PC', taskId: 'task2', title: 'Office change'});
    assert.equal(result.mode, 'github'); assert.equal(result.branch, 'girru/office-pc/task2'); assert.equal(patch, '');
    assert.match(git(office, 'status', '--porcelain'), /app\.txt/, 'the working folder on Office PC is left as it was');
    const {githubPatch} = await import('../src/devices/work-result.ts');
    const done = await bringInto(mac, await githubPatch(mac, result));
    assert.deepEqual(done, {ok: true});
    assert.equal(fs.readFileSync(path.join(mac, 'app.txt'), 'utf8'), 'one\ntwo from office\n');
    assert.match(git(hub, 'log', '-1', '--format=%an', 'girru/office-pc/task2'), /Owner/, 'committed as the owner, never as an agent');
  } finally { delete process.env.GIRRU_TEST_GITHUB_REMOTE; fs.rmSync(root, {recursive: true, force: true}); }
});
