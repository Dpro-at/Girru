// KNOW-INDEX-01: document recall quality. A synthetic project (one PDF, one Markdown guide and
// distractor documents) is indexed with the app's own indexer, then questions in English,
// Arabic and German go through the reply recall (context/pack.ts messageRecall) as an owner
// chat with that project open. Reports, per language: the right file AND page/heading cited
// first (hit@1), cited among the recalled lines (hit@k), and questions with no answer in the
// documents that still got a document line (false lines).
// Run from packages/backend:
//   node --import tsx scripts/memory-baseline/doc-recall.mjs --mode hash|ollama [--distractors 40] [--out file.json]
import { backendDir, addUser, argValue, cleanup, ollamaHas, openDb, quietly } from './env.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const mode = argValue('mode', 'hash');
const distractors = Number(argValue('distractors', '40'));
const out = argValue('out', null);
if (mode === 'ollama' && !(await ollamaHas('qwen3-embedding:0.6b'))) {
  console.error('qwen3-embedding:0.6b is not available on the local Ollama; nothing measured');
  process.exit(2);
}
process.env.MEMORY_EMBEDDINGS = mode;
process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
process.env.GIRRU_DOC_INDEX = '1';

const load = (rel) => import(pathToFileURL(join(backendDir, rel)).href);
const { db } = await openDb();
const OWNER = 'doc-owner';
addUser(db, OWNER, 'owner');
const F = await load('test/helpers/pdf-fixture.mjs');
const IX = await load('src/memory/docs/indexer.ts');
const P = await load('src/memory/context/pack.ts');
const { createProject } = await load('src/repositories/chat-conversations.ts');
const { projectKeyOf } = await load('src/memory/project-keys.ts');

const folder = join(process.cwd(), 'alpha');
mkdirSync(join(folder, 'docs', 'notes'), { recursive: true });
writeFileSync(join(folder, 'docs', 'spec.pdf'), F.simplePdf([
  ['Alpha specification', 'This document describes the parts of the Alpha system and how they work together.'],
  ['Networking', 'The relay listens on port 41588 for phone pairing.', 'A pairing code is valid for ten minutes.'],
  ['Storage', 'Nightly backups start at 02:30 and are kept for 35 days.'],
  ['Billing', 'The team plan costs 19 euro per seat each month.'],
]));
writeFileSync(join(folder, 'docs', 'guide.md'), `# Alpha guide

## Releases

A new release ships every Thursday after the smoke tests pass.

## Support

The support desk answers from 9:00 to 17:00 Vienna time, Monday to Friday.

## Design

The primary brand colour is teal #003f4d.
`);
const TOPICS = ['gardening', 'cooking pasta', 'bird watching', 'chess openings', 'river kayaking', 'baking bread', 'woodworking', 'astronomy', 'knitting', 'jazz history'];
for (let i = 0; i < distractors; i++) {
  const t = TOPICS[i % TOPICS.length];
  writeFileSync(join(folder, 'docs', 'notes', `note-${i}.md`), `# Notes on ${t} ${i}\n\nThese notes collect thoughts about ${t}. Session ${i} covered the basics of ${t} and a few tips for beginners.\n\n## Tips\n\nPractice ${t} a little every week; keep a small journal of what worked.\n`);
}
const project = await createProject(OWNER, { name: 'Alpha', folder });
const drawers = [{ kind: 'owner' }, { kind: 'project', key: projectKeyOf(project) }];
const source = await quietly(() => IX.setDocSource(OWNER, 'project', project.id, true));
await IX.docIndexIdle();
const t0 = Date.now();
const rep = await quietly(() => IX.indexSource(source.id));
const indexMs = Date.now() - t0;

const SPEC = (page) => `docs/spec.pdf, page ${page}`;
const GUIDE = (h) => `docs/guide.md › Alpha guide › ${h}`;
const SET = [
  { cite: SPEC(2), q: { en: 'What port does the relay use to pair phones?', ar: 'ما هو المنفذ الذي يستخدمه المرحّل لربط الهواتف؟', de: 'Welchen Port nutzt das Relay zum Koppeln von Telefonen?' } },
  { cite: SPEC(2), q: { en: 'How long is a pairing code valid?', ar: 'كم مدة صلاحية رمز الربط؟', de: 'Wie lange ist ein Kopplungscode gültig?' } },
  { cite: SPEC(3), q: { en: 'When do the nightly backups run?', ar: 'متى يبدأ النسخ الاحتياطي الليلي؟', de: 'Wann laufen die nächtlichen Sicherungen?' } },
  { cite: SPEC(4), q: { en: 'How much is the team plan per seat?', ar: 'كم سعر خطة الفريق لكل مقعد؟', de: 'Was kostet der Team-Tarif pro Platz?' } },
  { cite: GUIDE('Releases'), q: { en: 'On which day do we ship a release?', ar: 'في أي يوم نطلق إصدارًا جديدًا؟', de: 'An welchem Tag veröffentlichen wir ein Release?' } },
  { cite: GUIDE('Support'), q: { en: 'What are the support desk hours?', ar: 'ما هي ساعات عمل مكتب الدعم؟', de: 'Wann ist der Support erreichbar?' } },
  { cite: GUIDE('Design'), q: { en: 'What is our main brand colour?', ar: 'ما هو اللون الأساسي لعلامتنا التجارية؟', de: 'Was ist unsere Hauptmarkenfarbe?' } },
];
const NEGATIVE = [
  'What is the capital of Australia?', 'Who won the football match yesterday?', 'ما هو اسم مدير الشركة؟', 'Wie heißt der Hund des Nachbarn?',
];

const cites = (text) => [...text.matchAll(/^- \(([^)]+)\)/gm)].map((m) => m[1]);
const result = { mode, distractors, files: rep.files, chunks: rep.chunks, indexMs, perLang: {}, negatives: { total: NEGATIVE.length, withDocLines: 0 }, latencyMs: [] };
for (const lang of ['en', 'ar', 'de']) {
  let hit1 = 0, hitK = 0;
  for (const item of SET) {
    const pack = await P.contextPack({ userId: OWNER, agentId: null, drawers, persona: '' });
    const s = performance.now();
    const r = await quietly(() => P.messageRecall({ userId: OWNER, drawers, query: item.q[lang], pack, agentId: null }));
    result.latencyMs.push(Math.round(performance.now() - s));
    const c = cites(r.text);
    if (c[0] === item.cite) hit1++;
    if (c.includes(item.cite)) hitK++;
    else if (process.env.DOC_RECALL_VERBOSE) console.error(lang, item.q[lang], '→', c);
  }
  result.perLang[lang] = { total: SET.length, hit1: hit1 / SET.length, hitK: hitK / SET.length };
}
for (const q of NEGATIVE) {
  const pack = await P.contextPack({ userId: OWNER, agentId: null, drawers, persona: '' });
  const r = await quietly(() => P.messageRecall({ userId: OWNER, drawers, query: q, pack, agentId: null }));
  if (cites(r.text).length) { result.negatives.withDocLines++; if (process.env.DOC_RECALL_VERBOSE) console.error('negative', q, '→', cites(r.text)); }
}
result.latencyMs = { p50: result.latencyMs.sort((a, b) => a - b)[Math.floor(result.latencyMs.length / 2)], max: Math.max(...result.latencyMs) };
console.log(JSON.stringify(result, null, 2));
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
cleanup();
process.exit(0);
