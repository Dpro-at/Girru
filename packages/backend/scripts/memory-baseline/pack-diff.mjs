// Pick the questions where two packs recalled something different, and write them as plain text for a
// strong model (Claude, Codex) to answer. Only those questions can change the outcome, so a two-level
// test stays small: everything else gets the same memory in both modes and must answer the same.
//
// Run: node scripts/memory-baseline/pack-diff.mjs <packA.json> <packB.json> --out <folder> [--limit 40]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const val = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const [fileA, fileB] = files;
const outDir = val('out', null);
const limit = Number(val('limit', '40'));
if (!fileA || !fileB || !outDir) { console.error('usage: pack-diff.mjs <packA.json> <packB.json> --out <folder> [--limit 40]'); process.exit(2); }

const A = JSON.parse(readFileSync(fileA, 'utf8'));
const B = JSON.parse(readFileSync(fileB, 'utf8'));
const byId = new Map(B.questions.map((q) => [q.id, q]));

const differ = A.questions.filter((a) => { const b = byId.get(a.id); return b && b.memory !== a.memory; }).slice(0, limit);
mkdirSync(outDir, { recursive: true });

/** One question as a model sees it: the rules, the recalled memory, the conversation, the question. */
const prompt = (pack, q) => {
  // The rules are printed once for the whole file; each question keeps its memory lines, the message
  // that set the topic and a count of the small talk after it (filler carries no fact and would be
  // most of the file).
  // A long memory is cut: what decides an answer is its start (project, date, status, then the fact).
  const lines = q.memory.split('\n').filter((l) => l.startsWith('- [') || l.startsWith('[No memory') || l.startsWith('[Memory: nothing'))
    .map((l) => (l.length > 190 ? `${l.slice(0, 190)}…` : l));
  const convo = q.conversation ?? [];
  const opening = convo.length ? `Conversation opened with: ${convo[0]}${convo.length > 1 ? `  (then ${convo.length - 1} filler messages)` : ''}` : '';
  return [`### ${q.id}`, lines.join('\n') || '[No memory was recalled for this message]', opening, `Question: ${q.question}`].filter(Boolean).join('\n');
};

/** The rules that every memory block carries, taken from the first block that has them. */
const rulesOf = (pack) => pack.questions.find((q) => q.memory.includes('How to use this memory'))?.memory
  .split('\n').filter((l) => l.startsWith('How to use') || (l.startsWith('- ') && !l.startsWith('- ['))).join('\n') ?? '';

for (const [name, pack] of [['A', A], ['B', B]]) {
  const map = new Map(pack.questions.map((q) => [q.id, q]));
  const text = [
    `# Pack ${name} (mode ${pack.mode}, ${pack.distractors} distractor memories)`,
    `# Answer every question from its recalled memory only. ${pack.rules ?? ''}`,
    `# Reply as JSON: [{ "id": "...", "known": true|false, "answer": "short answer or empty" }]`,
    `# The rules sent with every memory block:\n${rulesOf(pack)}`,
    '',
    ...differ.map((d) => prompt(pack, map.get(d.id))),
  ].join('\n\n');
  writeFileSync(join(outDir, `questions-${name}.txt`), text);
}
writeFileSync(join(outDir, 'keys.json'), JSON.stringify({ ids: differ.map((d) => d.id) }, null, 1));
console.log(`${differ.length} questions differ (of ${A.questions.length}) -> ${outDir}`);
