// STORE-MAP-01 P0 baseline: deterministic synthetic memories (DB2-7).
// Realistic text lengths (short notes, paragraphs, long notes), English,
// MSA Arabic, Iraqi dialect and mixed Arabic/English, split across the
// five drawers. Every fact is invented; no private data.

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, list) => list[Math.floor(r() * list.length)];

const EN = {
  person: ['Lena', 'Omar', 'Sara', 'Yusuf', 'Mira', 'Karim', 'Nora', 'Tariq', 'Hana', 'Jonas', 'Rami', 'Elif'],
  client: ['Northwind', 'Bluefield', 'Cedar Labs', 'Atlas Foods', 'Kestrel Bank', 'Orbit Media', 'Pine Clinic', 'Delta Print'],
  project: ['alpha', 'beta', 'gamma', 'delta', 'orion', 'nova', 'atlas', 'zephyr', 'lumen', 'vega'],
  component: ['login page', 'invoice export', 'search index', 'mobile app', 'billing worker', 'image cache', 'report builder', 'sync job', 'admin panel', 'webhook relay'],
  tech: ['PostgreSQL', 'SQLite', 'Redis', 'Rust', 'React', 'Go', 'Python', 'Kafka', 'S3 storage', 'GraphQL'],
  host: ['a Hetzner box', 'the office NAS', 'a small VPS', 'the staging cluster', 'a Raspberry Pi', 'the build server'],
  region: ['Frankfurt', 'Vienna', 'Helsinki', 'Dubai', 'Istanbul', 'Amsterdam'],
  day: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Sunday'],
  pref: ['short bullet summaries', 'a call before any change', 'dark mode screenshots', 'German invoices', 'weekly reports on Fridays', 'Arabic replies'],
  symptom: ['timeouts', 'duplicate rows', 'a blank screen', 'slow startup', 'wrong totals', 'lost sessions'],
  reason: ['it is cheaper', 'the team knows it', 'it survived the load test', 'the client asked for it', 'it keeps data local'],
};
const EN_T = [
  (r) => `${pick(r, EN.person)} prefers ${pick(r, EN.pref)} for ${pick(r, EN.project)} reviews.`,
  (r) => `The ${pick(r, EN.project)} ${pick(r, EN.component)} runs on ${pick(r, EN.host)} in ${pick(r, EN.region)}.`,
  (r) => `Invoice ${1000 + Math.floor(r() * 9000)} for ${pick(r, EN.client)} is due on ${pick(r, EN.day)}.`,
  (r) => `Meeting with ${pick(r, EN.client)} moved to ${pick(r, EN.day)} at ${8 + Math.floor(r() * 10)}:00.`,
  (r) => `Decision: ${pick(r, EN.project)} uses ${pick(r, EN.tech)} for the ${pick(r, EN.component)} because ${pick(r, EN.reason)}.`,
  (r) => `Bug in the ${pick(r, EN.component)}: ${pick(r, EN.symptom)} after the last deploy; ${pick(r, EN.person)} is on it.`,
  (r) => `${pick(r, EN.client)} pays by bank transfer and wants the ${pick(r, EN.component)} demo before ${pick(r, EN.day)}.`,
  (r) => `Lesson: test the ${pick(r, EN.component)} with real data before telling ${pick(r, EN.client)} it is done.`,
];

const AR = {
  person: ['أحمد', 'فاطمة', 'علي', 'زينب', 'حسن', 'مريم', 'يوسف', 'ليلى', 'كريم', 'نور'],
  client: ['شركة النخيل', 'مطبعة الرافدين', 'عيادة الشفاء', 'مخبز السلام', 'مكتب دجلة', 'متجر الفرات'],
  thing: ['صفحة الدخول', 'تصدير الفواتير', 'فهرس البحث', 'تطبيق الهاتف', 'تقرير المبيعات', 'نسخة الاحتياط', 'لوحة الإدارة'],
  place: ['بغداد', 'البصرة', 'أربيل', 'فيينا', 'دبي', 'عمّان'],
  day: ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس'],
  pref: ['ردوداً قصيرة', 'اتصالاً قبل أي تغيير', 'تقارير أسبوعية', 'فواتير باللغة العربية', 'ملخصاً في نهاية اليوم'],
};
const AR_T = [
  (r) => `يفضّل ${pick(r, AR.person)} ${pick(r, AR.pref)} عند مراجعة ${pick(r, AR.thing)}.`,
  (r) => `اجتماع ${pick(r, AR.client)} تأجّل إلى يوم ${pick(r, AR.day)} الساعة ${8 + Math.floor(r() * 10)}.`,
  (r) => `الخادم الخاص بـ${pick(r, AR.thing)} موجود في ${pick(r, AR.place)} ويعمل منذ سنتين.`,
  (r) => `قرار: نستخدم قاعدة بيانات محلية لـ${pick(r, AR.thing)} لأن العميل ${pick(r, AR.client)} يريد بقاء البيانات عنده.`,
  (r) => `فاتورة ${pick(r, AR.client)} رقم ${1000 + Math.floor(r() * 9000)} تُدفع يوم ${pick(r, AR.day)} بتحويل بنكي.`,
  (r) => `خطأ في ${pick(r, AR.thing)}: يظهر بطء شديد بعد التحديث الأخير، و${pick(r, AR.person)} يتابع الإصلاح.`,
  (r) => `درس مستفاد: نختبر ${pick(r, AR.thing)} ببيانات حقيقية قبل التسليم إلى ${pick(r, AR.client)}.`,
];
const IQ_T = [
  (r) => `${pick(r, AR.person)} يحب الردود قصيرة، ما يحب الحچي الطويل بالاجتماعات.`,
  (r) => `هسه ${pick(r, AR.thing)} ديشتغل على سيرفر ب${pick(r, AR.place)}، اكو مشكلة بالسرعة شوية.`,
  (r) => `${pick(r, AR.client)} گالوا راح يدفعون الفاتورة يوم ${pick(r, AR.day)} إن شاء الله.`,
  (r) => `ماكو داعي نغيّر ${pick(r, AR.thing)} هسه، خلّيه لبعد العيد.`,
  (r) => `شلون ما چان، لازم نخلّص ${pick(r, AR.thing)} قبل ${pick(r, AR.day)} لأن ${pick(r, AR.client)} مستعجلين.`,
  (r) => `${pick(r, AR.person)} يگول البزون مالته يلعب بالسلك، فخلّي الراوتر بعيد.`,
  (r) => `اكو اجتماع ويه ${pick(r, AR.client)} يوم ${pick(r, AR.day)}، لا تنسى تجيب العقد.`,
];
const MIX_T = [
  (r) => `الـ ${pick(r, EN.component)} مال مشروع ${pick(r, EN.project)} صار يستخدم ${pick(r, EN.tech)} بدل القديم.`,
  (r) => `نسخة الـ backup لـ${pick(r, AR.thing)} تنحفظ على ${pick(r, EN.host)} كل ليلة الساعة 2.`,
  (r) => `${pick(r, AR.person)} فتح PR جديد للـ ${pick(r, EN.component)} وينتظر review من ${pick(r, EN.person)}.`,
  (r) => `deploy الـ ${pick(r, EN.project)} يصير يوم ${pick(r, AR.day)} بعد ما نخلص الـ tests.`,
];

const LANGS = [['en', EN_T, 0.4], ['ar', AR_T, 0.25], ['iq', IQ_T, 0.2], ['mix', MIX_T, 0.15]];

function language(r) {
  let x = r();
  for (const [lang, t, w] of LANGS) { if ((x -= w) <= 0) return [lang, t]; }
  return [LANGS[0][0], LANGS[0][1]];
}

/** Realistic length: 55% one sentence, 35% a paragraph (2–4), 10% a long note (6–14). */
function sentences(r) {
  const x = r();
  if (x < 0.55) return 1;
  if (x < 0.9) return 2 + Math.floor(r() * 3);
  return 6 + Math.floor(r() * 9);
}

export const PROJECTS = EN.project;

/**
 * Drawer split (owner 30%, project 45% over 10 projects, experience 12%,
 * task 8%, people 5%).
 */
function drawer(r) {
  const x = r();
  if (x < 0.30) return { kind: 'owner', key: null };
  if (x < 0.75) return { kind: 'project', key: pick(r, PROJECTS) };
  if (x < 0.87) return { kind: 'experience', key: null };
  if (x < 0.95) return { kind: 'task', key: `t-${1 + Math.floor(r() * 400)}` };
  return { kind: 'people', key: `p-${1 + Math.floor(r() * 60)}` };
}

const TYPES = ['fact', 'fact', 'fact', 'preference', 'event', 'context', 'insight', 'task'];

/** Yields `count` synthetic memory rows: { content, lang, drawerKind, drawerKey, type, createdAt }. */
export function* syntheticMemories(count, seed = 7) {
  const r = rng(seed);
  const start = Date.UTC(2025, 0, 1);
  const span = Date.UTC(2026, 9, 31) - start;
  for (let i = 0; i < count; i++) {
    const [lang, templates] = language(r);
    const n = sentences(r);
    const parts = [];
    for (let s = 0; s < n; s++) parts.push(pick(r, templates)(r));
    const d = drawer(r);
    yield {
      content: parts.join(' '),
      lang,
      drawerKind: d.kind,
      drawerKey: d.key,
      type: pick(r, TYPES),
      createdAt: new Date(start + Math.floor(r() * span)).toISOString(),
    };
  }
}
