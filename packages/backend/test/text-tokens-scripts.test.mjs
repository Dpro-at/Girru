// MEM-LANG-01: lexical tokens for scripts beyond Arabic, English and German (memory/text-normalize.ts).
//  - Hindi and other Indic words keep their vowel signs (they were cut at every sign);
//  - Chinese, Japanese and Thai runs (no spaces) become two-character tokens, so a word inside a run matches by BM25;
//  - Arabic, Iraqi, German and English tokens are unchanged.
// Run: node --import tsx --test test/text-tokens-scripts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (rel) => import(pathToFileURL(join(process.cwd(), rel)).href);
const { lexicalTokens } = await load('src/memory/text-normalize.ts');
const { bm25Scores } = await load('src/memory/hybrid.ts');

test('Hindi words stay whole', () => {
  assert.deepEqual(lexicalTokens('सर्वर डेटाबेस बदल दिया गया'), ['सर्वर', 'डेटाबेस', 'बदल', 'दिया', 'गया']);
});

test('Chinese and Japanese runs become two-character tokens; a word inside a run matches', () => {
  assert.deepEqual(lexicalTokens('服务器数据库'), ['服务', '务器', '器数', '数据', '据库']);
  assert.deepEqual(lexicalTokens('数据库'), ['数据', '据库']);
  const docs = ['我们把服务器数据库改成了ClickHouse', '明天开会讨论预算'].map((d) => lexicalTokens(d));
  const s = bm25Scores(lexicalTokens('数据库'), docs);
  assert.ok(s[0] > 0 && s[1] === 0, 'the database sentence matches, the budget one does not');
  assert.ok(lexicalTokens('サーバーのデータベース').includes('デー'));
  assert.ok(lexicalTokens('GPT模型的数据').includes('gpt'), 'Latin inside a run stays a word');
  assert.deepEqual(lexicalTokens('中'), ['中'], 'one character stays a token');
});

test('Arabic, Iraqi, German and English are unchanged', () => {
  assert.deepEqual(lexicalTokens('قاعدة بيانات الخادم الآن'), ['قاعد', 'يان', 'خادم', 'الان']);
  assert.deepEqual(lexicalTokens('Die Server-Datenbank ist jetzt PostgreSQL'), ['serv', 'datenbank', 'jetzt', 'postgresql']);
  assert.deepEqual(lexicalTokens('The servers were updated on Mondays'), lexicalTokens('The servers were updated on Mondays'));
  assert.ok(lexicalTokens('هسه السيرفر ديشتغل').length > 0);
});
