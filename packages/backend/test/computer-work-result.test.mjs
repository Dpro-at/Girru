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
    fs.writeFileSync(path.join(data, 'computer-results', 'task1', 'part-0'), parts[0] + 'tampered');
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
    // CP12 C: “Directly, I look first” keeps the work off GitHub even when the folder has a GitHub address.
    const start2 = await startSnapshot(office);
    fs.writeFileSync(path.join(office, 'app.txt'), 'one\ntwo from office\nthree\n');
    const direct = await finishWork({folder: office, start: start2, computer: 'Office PC', taskId: 'task5', title: 'Direct', back: 'direct'});
    assert.equal(direct.result.mode, 'direct'); assert.ok(direct.patch.includes('three'));
    assert.throws(() => git(hub, 'rev-parse', '--verify', 'girru/office-pc/task5'), 'nothing was pushed');
  } finally { delete process.env.GIRRU_TEST_GITHUB_REMOTE; fs.rmSync(root, {recursive: true, force: true}); }
});

test('CP10 safety: secret files stop the send, the patch is read for itself, results are kept once', async () => {
  const {inspectPatch, secretPath, saveResult: save, savePart: part} = await import('../src/devices/work-result.ts');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'girru-safe-')));
  try {
    const office = repo(root, 'office');
    const start = await startSnapshot(office);
    fs.writeFileSync(path.join(office, 'service-account.json'), '{}');
    const sent = await finishWork({folder: office, start, computer: 'PC', taskId: 't3', title: 'x'});
    assert.equal(sent.result.mode, 'none', 'nothing leaves when a secret-looking file changed');
    for (const p of ['.envrc', 'a/.dev.vars', 'infra/x.tfstate', 'keys/id_ecdsa', 'k.keystore']) assert.equal(secretPath(p), true, p);
    assert.equal(secretPath('src/app.ts'), false);
    fs.rmSync(path.join(office, 'service-account.json'));
    fs.mkdirSync(path.join(office, '.github', 'workflows'), {recursive: true});
    fs.writeFileSync(path.join(office, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    fs.symlinkSync('/etc/hosts', path.join(office, 'link'));
    const s2 = await startSnapshot(office);
    const {patch} = await (await import('../src/devices/work-result.ts')).finishWork({folder: office, start, computer: 'PC', taskId: 't4', title: 'x'});
    const look = await inspectPatch(patch);
    assert.ok(look.files.includes('.github/workflows/ci.yml'));
    assert.ok(look.risky.includes('.github/workflows/ci.yml'), 'CI files need a second press');
    assert.ok(look.blocked.includes('link'), 'links never come in');
    assert.ok(s2);
    const data = path.join(root, 'data');
    save(data, {taskId: 't5', mode: 'none', files: []}, 'peer');
    assert.throws(() => save(data, {taskId: 't5', mode: 'none', files: []}, 'peer'), /computer_result_exists/);
    assert.throws(() => part(data, 't5', 0, 'x'), /computer_result_exists/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('CP10 safety: risky files at any depth and files made runnable need the owner\'s second press', async () => {
  const {inspectPatch} = await import('../src/devices/work-result.ts');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'girru-risky-')));
  try {
    const office = repo(root, 'office');
    fs.mkdirSync(path.join(office, 'web'));
    fs.writeFileSync(path.join(office, 'web', 'package.json'), '{"scripts":{}}\n');
    fs.writeFileSync(path.join(office, 'run.sh'), 'echo hi\n');
    git(office, 'add', '-A'); git(office, 'commit', '-qm', 'more');
    const start = await startSnapshot(office);
    fs.writeFileSync(path.join(office, 'web', 'package.json'), '{"scripts":{"postinstall":"x"}}\n');
    fs.chmodSync(path.join(office, 'run.sh'), 0o755);
    const {patch} = await finishWork({folder: office, start, computer: 'PC', taskId: 't6', title: 'x'});
    const look = await inspectPatch(patch);
    assert.ok(look.risky.includes('web/package.json'), 'a package.json in a sub-folder counts');
    assert.ok(look.risky.includes('run.sh'), 'a file made runnable counts');
    const renamed = 'diff --git a/a.txt b/.git/hooks/pre-commit\nsimilarity index 100%\nrename from a.txt\nrename to .git/hooks/pre-commit\n';
    assert.ok((await inspectPatch(renamed)).blocked.includes('.git/hooks/pre-commit'), 'a rename into git internals is blocked by its new name');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('CP10 safety: link modes in the index line, old modes, and upper-case names are caught too', async () => {
  const {inspectPatch} = await import('../src/devices/work-result.ts');
  const link = 'diff --git a/x b/x\nindex 1234567..89abcde 120000\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';
  assert.ok((await inspectPatch(link).catch(() => ({blocked: ['x']}))).blocked.includes('x'));
  const upper = 'diff --git a/.GIT/config b/.GIT/config\nnew file mode 100644\nindex 0000000..e69de29\n';
  assert.ok((await inspectPatch(upper).catch(() => ({blocked: ['.GIT/config']}))).blocked.includes('.GIT/config'));
  const {safeCopyPath} = await import('../src/devices/project-copy.ts');
  assert.equal(safeCopyPath('a/.Git/hooks/x'), false);
});

test('CP10 safety: a mode line written with extra spaces or another length still blocks a link', async () => {
  const {inspectPatch} = await import('../src/devices/work-result.ts');
  const spaced = 'diff --git a/y b/y\nnew file mode  120000\nindex 0000000..e69de29\n';
  assert.ok((await inspectPatch(spaced).catch(() => ({blocked: ['y']}))).blocked.includes('y'));
  const odd = 'diff --git a/z b/z\nnew file mode 0120000\nindex 0000000..e69de29\n';
  assert.ok((await inspectPatch(odd).catch(() => ({blocked: ['z']}))).blocked.includes('z'));
});
