// Score a model's answers to a question pack (accuracy.mjs --pack). Girru's own job is measured by
// recall; this measures the second half: did the model that reads the pack answer correctly?
//
// The pack holds, per question, exactly what a chat would send a model: the recalled memory block,
// the conversation and the question. Any model can be asked them — Claude, Codex, a local model —
// and its answers scored here, so a weak model's failure is never read as a memory failure.
//
// Run: node scripts/memory-baseline/pack-score.mjs <pack.json> <answers.json> [--out <file>]
//   answers.json: [{ "id": "q-...", "known": true, "answer": "ClickHouse" }, ...]
//     known false (or an empty answer) means the model said it is not in memory.
import { readFileSync, writeFileSync } from 'node:fs';

const [packFile, answersFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const outFile = (() => { const i = process.argv.indexOf('--out'); return i > 0 ? process.argv[i + 1] : null; })();
if (!packFile || !answersFile) { console.error('usage: pack-score.mjs <pack.json> <answers.json> [--out <file>]'); process.exit(2); }

const pack = JSON.parse(readFileSync(packFile, 'utf8'));
const given = JSON.parse(readFileSync(answersFile, 'utf8'));
const byId = new Map((Array.isArray(given) ? given : given.answers ?? []).map((a) => [a.id, a]));

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** An ISO date (2027-02-28) is the same answer as "28 February 2027": the key is matched against both. */
const spellDates = (s) => s.replace(/(\d{4})-(\d{2})-(\d{2})/g, (all, y, m, d) => (MONTHS[+m - 1] ? `${all} ${+d} ${MONTHS[+m - 1]} ${y}` : all));

const rows = [];
for (const q of pack.questions) {
  const a = byId.get(q.id);
  if (!a) { rows.push({ ...q, verdict: 'missing' }); continue; }
  const text = spellDates(String(a.answer ?? '').toLowerCase());
  const known = a.known === true && text.trim().length > 0;
  const verdict = !q.hasAnswer ? (known ? 'invented' : 'correct-unknown')
    : !known ? 'said-unknown'
      : (q.answerKey ?? []).some((k) => text.includes(String(k).toLowerCase())) ? 'correct' : 'wrong';
  rows.push({ id: q.id, kind: q.kind, lang: q.lang, retrieved: q.retrieved, verdict, answer: String(a.answer ?? '').slice(0, 160) });
}

const count = (f) => { const c = {}; for (const r of rows.filter(f)) c[r.verdict] = (c[r.verdict] || 0) + 1; return c; };
const answerable = rows.filter((r) => r.verdict !== 'invented' && r.verdict !== 'correct-unknown');
const wrong = answerable.filter((r) => r.verdict === 'wrong').length;
const report = {
  pack: packFile, mode: pack.mode, distractors: pack.distractors, questions: rows.length,
  answerable: count((r) => r.verdict !== 'invented' && r.verdict !== 'correct-unknown'),
  noAnswer: count((r) => r.verdict === 'invented' || r.verdict === 'correct-unknown'),
  // Only where Girru found the target: the model's own share of the result.
  answerableRetrieved: count((r) => r.retrieved === true),
  byKind: Object.fromEntries([...new Set(rows.map((r) => r.kind))].map((k) => [k, count((r) => r.kind === k)])),
  byLang: Object.fromEntries([...new Set(rows.map((r) => r.lang))].map((l) => [l, count((r) => r.lang === l)])),
  rows,
};
console.log(`questions      ${rows.length}${rows.some((r) => r.verdict === 'missing') ? ` (${rows.filter((r) => r.verdict === 'missing').length} unanswered)` : ''}`);
console.log(`answerable     ${JSON.stringify(report.answerable)}`);
console.log(`no answer      ${JSON.stringify(report.noAnswer)}`);
console.log(`wrong-answer rate    answerable ${answerable.length ? ((wrong / answerable.length) * 100).toFixed(1) : '0.0'}%`);
if (outFile) writeFileSync(outFile, JSON.stringify(report, null, 1));
