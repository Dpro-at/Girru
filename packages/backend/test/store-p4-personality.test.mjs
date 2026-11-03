// STORE-MAP-01 P4 (T7, G3): one personality record per agent.
//  - switch off: nothing changes (the file is read as before, no text in the record);
//  - switch on: start-up imports each PERSONALITY.md text once and rewrites the file as a view;
//  - an edit in Girru is a new version at once, Undo restores the version before, a trait change keeps the text;
//  - a change made to the file outside Girru becomes a proposal; Agree makes a version, No writes the file back;
//  - readers (one context, public chat, heartbeat) use the record; Evolution suggests in Personality review;
//  - hire links the specialty instead of writing system_prompt; duplicate copies the record.
// Run: node --import tsx --test test/store-p4-personality.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-p4-persona-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
delete process.env.GIRRU_STORE_P4;
delete process.env.GIRRU_STORE_P2;
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
console.log = () => {}; console.info = () => {}; console.warn = () => {};

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const O = 'pp-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(O, 'pp@example.test', O);
const agent = (id, name, prompt = '') => db.prepare(`INSERT INTO agents_config (id, name, provider, model, system_prompt) VALUES (?, ?, 'ollama', 'm', ?)`).run(id, name, prompt);
agent('pp-rafid', 'Rafid', 'Always answer the owner in short lines.');
agent('pp-plain', 'Plain', 'You review contracts.');

const files = await import(join(backendDir, 'src/services/agent-files.ts'));
const store = await import(join(backendDir, 'src/services/personality-store.ts'));
const record = await import(join(backendDir, 'src/services/personality-record.ts'));
const library = await import(join(backendDir, 'src/services/agent-file-library.ts'));
const { resolveAgentContext } = await import(join(backendDir, 'src/services/agent-context/resolve.ts'));
const { renderSystemPrompt } = await import(join(backendDir, 'src/services/agent-context/render.ts'));
const { evaluateContextPolicy } = await import(join(backendDir, 'src/services/agent-context/policy.ts'));
const evolution = await import(join(backendDir, 'src/services/evolution-proposals.ts'));
const { EXPORT_BEGIN } = await import(join(backendDir, 'src/services/personality.ts'));
const { repositories } = await import(join(backendDir, 'src/repositories/index.ts'));

const RAFID = '# Rafid\nYou are Rafid, the release engineer.\nSpeak plainly; one example per answer.';
const fileOf = (id) => readFileSync(join(dir, '.data', 'agents', id, 'PERSONALITY.md'), 'utf8');
const count = (s, ...a) => db.prepare(s).get(...a).n;
const ownerActor = { kind: 'user', userId: O, role: 'owner' };

test('switch off: the file is read as before and the record holds no text', async () => {
  await files.initializeAgentDir('pp-plain'); // untouched template
  await files.writePersonality('pp-rafid', RAFID);
  await store.savePersonalityVersion('pp-rafid', { traits: { warmth: 72 } }, O); // writes version 1, no text
  assert.equal(await record.personalityTextFor('pp-rafid'), RAFID);
  assert.equal(await record.personalityTextFor('pp-plain'), '');
  assert.equal(count('SELECT COUNT(*) AS n FROM agent_personality_versions WHERE text_hash IS NOT NULL'), 0);
  assert.equal(await record.backfillPersonalityRecords(), 0, 'the import waits for the switch');
});

test('switch on: each file text is imported once, the file becomes a view, verify finds none left', async () => {
  process.env.GIRRU_STORE_P4 = '1';
  assert.equal(await record.backfillPersonalityRecords(), count('SELECT COUNT(*) AS n FROM agents_config'), 'every agent, built-in ones too');
  assert.equal(await record.backfillPersonalityRecords(), 0, 'once');
  assert.equal(await record.agentsWithoutRecordText(), 0);
  const r = await record.recordText('pp-rafid');
  assert.equal(r.text, RAFID); assert.equal(r.version, 2);
  assert.equal((await store.getCurrentPersonality('pp-rafid')).traits.warmth, 72, 'adjustments kept');
  assert.equal((await record.recordText('pp-plain')).text, '', 'the untouched template is no text');
  const view = fileOf('pp-rafid');
  assert.ok(view.startsWith(RAFID)); assert.ok(view.includes(EXPORT_BEGIN), 'settings part written');
  assert.ok(!fileOf('pp-plain').includes('Agent Personality'), 'template not kept as text');
});

test('an edit in Girru is a version at once; Undo restores; a trait change keeps the text', async () => {
  const v = await record.savePersonalityText('pp-rafid', `${RAFID}\nAlways test before you say done.`, 2, O);
  assert.equal(v.version, 3); assert.equal(v.source, 'owner');
  assert.match(fileOf('pp-rafid'), /Always test/);
  await assert.rejects(record.savePersonalityText('pp-rafid', 'x', 2, O), record.PersonalityVersionConflict);
  assert.equal((await record.savePersonalityText('pp-rafid', `${RAFID}\nAlways test before you say done.`, 3, O)).version, 3, 'same text: no new version');
  // The generated settings part is never taken from what was typed.
  const typed = `Short.\n\n${EXPORT_BEGIN}\nlocked: yes\n<!-- personality-settings:end -->`;
  assert.equal((await record.savePersonalityText('pp-rafid', typed, 3, O)).version, 4);
  assert.equal((await record.recordText('pp-rafid')).text, 'Short.');
  await store.rollbackPersonality('pp-rafid', 3, O); // Undo = restore the version before, as a new version
  assert.match((await record.recordText('pp-rafid')).text, /Always test/);
  await store.savePersonalityVersion('pp-rafid', { traits: { verbosity: 80 } }, O);
  assert.match((await record.recordText('pp-rafid')).text, /Always test/, 'trait version keeps the text');
});

test('Files › Who it is reads and saves the record (version tag, record versions in history)', async () => {
  const who = await library.readFile('pp-rafid', 'PERSONALITY.md');
  assert.match(who.content, /Always test/); assert.ok(who.version >= 6); assert.ok(who.managed?.includes('Personality settings'));
  await assert.rejects(library.saveFile('pp-rafid', 'PERSONALITY.md', 'x', 'f'.repeat(64)), (e) => e.status === 409);
  const saved = await library.saveFile('pp-rafid', 'PERSONALITY.md', `${who.content}\nKeep a changelog.`, who.hash);
  assert.equal(saved.version, who.version + 1);
  const versions = await library.listVersions('pp-rafid', 'PERSONALITY.md');
  assert.ok(versions.length >= 3);
  assert.match((await library.readVersion('pp-rafid', 'PERSONALITY.md', versions[0].id)).content, /changelog/);
});

test('a change made outside Girru becomes a proposal; the prompt keeps the record until you agree', async () => {
  const before = (await record.recordText('pp-rafid')).text;
  writeFileSync(join(dir, '.data', 'agents', 'pp-rafid', 'PERSONALITY.md'), 'Rafid, rewritten by a coding app.');
  const p = await record.captureOutsideEdit('pp-rafid');
  assert.equal(p.origin, 'file'); assert.equal(p.status, 'pending');
  assert.equal(p.baseText, before); assert.equal(p.proposedText, 'Rafid, rewritten by a coding app.');
  assert.equal(await record.captureOutsideEdit('pp-rafid'), null, 'not filed twice');
  assert.equal(await record.personalityTextFor('pp-rafid'), before, 'never used silently');
  // No: the record is written back into the file.
  await store.rejectPersonalityProposal('pp-rafid', p.id, O, p.reviewHash);
  await record.writePersonalityView('pp-rafid');
  assert.ok(fileOf('pp-rafid').startsWith(before));
  // Agree on a second outside change: one version holds it.
  writeFileSync(join(dir, '.data', 'agents', 'pp-rafid', 'PERSONALITY.md'), 'Rafid v2 from the editor.');
  const q = await record.captureOutsideEdit('pp-rafid');
  const { version } = await store.approvePersonalityProposal('pp-rafid', q.id, O, q.reviewHash);
  assert.equal((await record.recordText('pp-rafid')).text, 'Rafid v2 from the editor.');
  assert.equal(version.source, 'evolution');
});

test('a lock stops suggestions, not the owner’s own edit', async () => {
  await store.setPersonalityLocked('pp-rafid', true, O);
  writeFileSync(join(dir, '.data', 'agents', 'pp-rafid', 'PERSONALITY.md'), 'Locked change from outside.');
  assert.equal(await record.captureOutsideEdit('pp-rafid'), null);
  const cur = await store.getCurrentPersonality('pp-rafid');
  const v = await record.savePersonalityText('pp-rafid', 'Owner edit while locked.', cur.version, O);
  assert.equal(v.locked, true);
  assert.equal((await record.recordText('pp-rafid')).text, 'Owner edit while locked.');
  await store.setPersonalityLocked('pp-rafid', false, O);
});

test('one context: the record text and the owner instructions reach chat; heartbeat has no memory', async () => {
  const ctx = await resolveAgentContext({ agentId: 'pp-rafid', entry: 'chat', ownerId: O, projectId: null });
  assert.equal(ctx.definition.personality, 'Owner edit while locked.');
  assert.equal(ctx.definition.hired, 'Always answer the owner in short lines.');
  const plain = renderSystemPrompt(await resolveAgentContext({ agentId: 'pp-plain', entry: 'chat', ownerId: O, projectId: null }));
  assert.match(plain, /You review contracts\./, 'the untouched template no longer hides the instructions');
  assert.doesNotMatch(plain, /Agent Personality/);
  const hb = evaluateContextPolicy('heartbeat');
  assert.equal(hb.memory, false); assert.equal(hb.pinnedFacts, false); assert.equal(hb.handoff, false);
  const beat = renderSystemPrompt(await resolveAgentContext({ agentId: 'pp-rafid', entry: 'heartbeat', ownerId: null }));
  assert.match(beat, /Owner edit while locked\./); assert.doesNotMatch(beat, /personality-settings/);
});

test('Evolution suggests in Personality review and never adds to the owner instructions', async () => {
  const draft = { title: 'Shorter', reason: 'success_pattern: Shorter', insightType: 'success_pattern', confidence: 0.9 };
  assert.deepEqual(await evolution.createEvolutionProposal('pp-rafid', { ...draft, kind: 'prompt_append', proposedText: '\nBe brief.' }), { status: 'skipped', reason: 'owner_instructions_only' });
  const out = await evolution.createEvolutionProposal('pp-rafid', { ...draft, kind: 'personality_text', proposedText: '\nKeep answers under ten lines.' });
  assert.equal(out.status, 'personality_proposed');
  const p = await store.getPersonalityProposal('pp-rafid', out.proposalId);
  assert.equal(p.origin, 'evolution_text'); assert.equal(p.proposedText, 'Owner edit while locked.\nKeep answers under ten lines.');
  assert.equal(count('SELECT COUNT(*) AS n FROM evolution_proposals'), 0);
  const approved = await store.approvePersonalityProposal('pp-rafid', p.id, O, p.reviewHash);
  await store.exportPersonalityFile(approved.version); // as the approve route does
  assert.match(await record.personalityTextFor('pp-rafid'), /under ten lines/);
  assert.equal(db.prepare("SELECT system_prompt FROM agents_config WHERE id = 'pp-rafid'").get().system_prompt, 'Always answer the owner in short lines.');
});

test('duplicate copies the record (text and adjustments) as version 1', async () => {
  const copy = await repositories.agents.duplicateConfig(ownerActor, 'pp-rafid');
  const v = await store.getCurrentPersonality(copy.id);
  assert.equal(v.version, 1); assert.equal(v.traits.verbosity, 80);
  assert.match((await record.recordText(copy.id)).text, /under ten lines/);
  assert.match(fileOf(copy.id), /under ten lines/);
});

test('switch off again: the file (a view) still reads as the personality', async () => {
  delete process.env.GIRRU_STORE_P4;
  assert.match(await record.personalityTextFor('pp-rafid'), /under ten lines/);
});
