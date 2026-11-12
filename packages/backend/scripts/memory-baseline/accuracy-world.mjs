// MEM-ACC-01: a simulated world for the memory accuracy test (accuracy.mjs).
// Ten projects, each with ten facts (local and server database, why the server database
// changed, hosting with a cancelled move, deploy day, client and contact, deadline, backend
// language, a known bug), plus fifteen people. Facts are written in English, MSA Arabic,
// German or Iraqi dialect; every fact has a known id. Questions (direct and with the project
// left out, in four languages, temporal, indirect and with no answer) carry the ids they must
// find. Deterministic; every fact is invented.
import { rng } from './corpus.mjs';

export const WORLD_PROJECTS = [
  { slug: 'falcon', en: 'Falcon', ar: 'فالكون' }, { slug: 'harbor', en: 'Harbor', ar: 'هاربر' },
  { slug: 'meridian', en: 'Meridian', ar: 'ميريديان' }, { slug: 'quill', en: 'Quill', ar: 'كويل' },
  { slug: 'saffron', en: 'Saffron', ar: 'سافرون' }, { slug: 'tundra', en: 'Tundra', ar: 'توندرا' },
  { slug: 'vertex', en: 'Vertex', ar: 'فيرتكس' }, { slug: 'willow', en: 'Willow', ar: 'ويلو' },
  { slug: 'cobalt', en: 'Cobalt', ar: 'كوبالت' }, { slug: 'juniper', en: 'Juniper', ar: 'جونيبر' },
];
/** Corpus project keys mapped onto the world's, so every world drawer also holds thousands of distractors. */
export const DISTRACTOR_PROJECT_MAP = { alpha: 'falcon', beta: 'harbor', gamma: 'meridian', delta: 'quill', orion: 'saffron', nova: 'tundra', atlas: 'vertex', zephyr: 'willow', lumen: 'cobalt', vega: 'juniper' };

const LOCAL_DB = ['SQLite', 'DuckDB', 'Realm', 'IndexedDB'];
const OLD_DB = ['MySQL 8', 'MongoDB', 'MariaDB', 'Microsoft SQL Server'];
const NEW_DB = ['PostgreSQL 16', 'CockroachDB', 'ClickHouse', 'TimescaleDB'];
const REASON = [
  { en: 'the monthly reports needed window functions', ar: 'التقارير الشهرية احتاجت دوال النوافذ', de: 'die Monatsberichte Fensterfunktionen brauchten', iq: 'التقارير الشهرية چانت تحتاج window functions' },
  { en: 'the old server lost data twice during backups', ar: 'الخادم القديم فقد البيانات مرتين أثناء النسخ الاحتياطي', de: 'der alte Server bei Backups zweimal Daten verloren hat', iq: 'السيرفر القديم ضيّع الداتا مرتين وقت الباك اب' },
  { en: 'the licence cost tripled', ar: 'تكلفة الترخيص تضاعفت ثلاث مرات', de: 'sich die Lizenzkosten verdreifacht haben', iq: 'سعر اللايسنس صار ثلاث أضعاف' },
  { en: 'queries on time series took minutes', ar: 'استعلامات السلاسل الزمنية كانت تأخذ دقائق', de: 'Abfragen auf Zeitreihen Minuten dauerten', iq: 'الكويريات على الداتا الزمنية چانت تاخذ دقايق' },
];
const HOST = ['Hetzner in Falkenstein', 'AWS in Frankfurt', 'OVH in Gravelines', 'DigitalOcean in Amsterdam', 'the own server in the Vienna office'];
const DAY = { en: ['Monday', 'Tuesday', 'Wednesday', 'Thursday'], ar: ['الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس'], de: ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag'] };
const CLIENT = ['Brightwater Insurance', 'Salam Pharmacy Group', 'Krones Logistik', 'Tigris Telecom', 'Alpenblick Hotels', 'Nakheel Real Estate', 'Rheintal Bank', 'Babylon Foods', 'Donau Energy', 'Mosul Textiles'];
const CONTACT = ['Ingrid Weber', 'Haider Kadhim', 'Lukas Brandt', 'Rana Saleh', 'Theo Fischer', 'Dalia Aziz', 'Martin Gruber', 'Sami Jabbar', 'Clara Huber', 'Yasir Talib'];
const DEADLINE = ['15 January 2027', '28 February 2027', '31 March 2027', '30 April 2027', '15 June 2027', '31 July 2027', '30 September 2027', '15 October 2027', '30 November 2027', '20 December 2027'];
const TECH = ['Go', 'Rust', 'Node.js', 'Python', 'Elixir'];
const BUG = [
  { en: 'exports time out above 10,000 rows; workaround: export per month', ar: 'التصدير يتوقف فوق 10,000 صف؛ الحل المؤقت: التصدير لكل شهر', de: 'Exporte brechen über 10.000 Zeilen ab; Umweg: monatsweise exportieren', iq: 'التصدير يوگف إذا فات 10,000 صف؛ الحل هسه: نصدّر كل شهر لحاله' },
  { en: 'login fails on Safari after 30 minutes; workaround: refresh the token earlier', ar: 'الدخول يفشل على سفاري بعد 30 دقيقة؛ الحل المؤقت: تجديد الرمز مبكراً', de: 'Login scheitert in Safari nach 30 Minuten; Umweg: Token früher erneuern', iq: 'اللوگن يطب على سفاري بعد نص ساعة؛ الحل: نجدد التوكن قبل' },
  { en: 'totals are off by one cent on invoices in euro; workaround: round per line', ar: 'المجاميع تختلف بسنت واحد في فواتير اليورو؛ الحل المؤقت: التقريب لكل سطر', de: 'Summen weichen bei Euro-Rechnungen um einen Cent ab; Umweg: pro Zeile runden', iq: 'المجموع يطلع غلط بسنت بالفواتير باليورو؛ الحل: نقرّب كل سطر' },
];

/** Fact texts per language. p: the project's names; v: its values. */
const FACT = {
  localdb: {
    en: (p, v) => `${p.en}: the desktop app keeps its data locally in ${v.localDb}.`,
    ar: (p, v) => `مشروع ${p.ar}: تطبيق سطح المكتب يحفظ بياناته محلياً في ${v.localDb}.`,
    de: (p, v) => `${p.en}: Die Desktop-App speichert ihre Daten lokal in ${v.localDb}.`,
    iq: (p, v) => `${p.ar}: تطبيق الديسكتوب يخزن الداتا محلياً ب${v.localDb}.`,
  },
  serverdb: {
    en: (p, v) => `${p.en}: the server database is now ${v.newDb} (we switched in March 2026).`,
    ar: (p, v) => `مشروع ${p.ar}: قاعدة بيانات الخادم الآن ${v.newDb} (انتقلنا في آذار 2026).`,
    de: (p, v) => `${p.en}: Die Server-Datenbank ist jetzt ${v.newDb} (Wechsel im März 2026).`,
    iq: (p, v) => `${p.ar}: داتابيس السيرفر هسه ${v.newDb}، بدّلناها بآذار 2026.`,
  },
  serverdb_old: {
    en: (p, v) => `${p.en}: the server database is ${v.oldDb}.`,
    ar: (p, v) => `مشروع ${p.ar}: قاعدة بيانات الخادم هي ${v.oldDb}.`,
    de: (p, v) => `${p.en}: Die Server-Datenbank ist ${v.oldDb}.`,
    iq: (p, v) => `${p.ar}: داتابيس السيرفر هي ${v.oldDb}.`,
  },
  reason: {
    en: (p, v) => `Why ${p.en} moved its server database from ${v.oldDb} to ${v.newDb}: ${v.reason.en}.`,
    ar: (p, v) => `سبب انتقال ${p.ar} من ${v.oldDb} إلى ${v.newDb} في الخادم: ${v.reason.ar}.`,
    de: (p, v) => `Warum ${p.en} die Server-Datenbank von ${v.oldDb} auf ${v.newDb} umgestellt hat: weil ${v.reason.de}.`,
    iq: (p, v) => `ليش ${p.ar} طلع من ${v.oldDb} وراح ل${v.newDb} بالسيرفر: لأن ${v.reason.iq}.`,
  },
  host_plan: {
    en: (p, v) => `${p.en}: plan to move production hosting to ${v.planHost} in May 2026.`,
    ar: (p, v) => `مشروع ${p.ar}: خطة لنقل الاستضافة إلى ${v.planHost} في أيار 2026.`,
    de: (p, v) => `${p.en}: Plan, das Produktions-Hosting im Mai 2026 zu ${v.planHost} zu verlegen.`,
    iq: (p, v) => `${p.ar}: ناوين ننقل الهوستنگ ل${v.planHost} بأيار 2026.`,
  },
  host: {
    en: (p, v) => `${p.en}: the move to ${v.planHost} was cancelled; production stays on ${v.host}.`,
    ar: (p, v) => `مشروع ${p.ar}: أُلغي النقل إلى ${v.planHost}؛ الإنتاج يبقى على ${v.host}.`,
    de: (p, v) => `${p.en}: Der Umzug zu ${v.planHost} wurde abgesagt; die Produktion bleibt auf ${v.host}.`,
    iq: (p, v) => `${p.ar}: لغينا النقل ل${v.planHost}، البرودكشن يبقى على ${v.host}.`,
  },
  deploy: {
    en: (p, v) => `${p.en} deploys go out every ${DAY.en[v.day]} after the tests pass.`,
    ar: (p, v) => `نشر ${p.ar} يتم كل يوم ${DAY.ar[v.day]} بعد نجاح الاختبارات.`,
    de: (p, v) => `${p.en} wird jeden ${DAY.de[v.day]} ausgerollt, wenn die Tests grün sind.`,
    iq: (p, v) => `ديبلوي ${p.ar} يصير كل ${DAY.ar[v.day]} بعد ما تعبر التستات.`,
  },
  client: {
    en: (p, v) => `${p.en} is built for ${v.client}; their contact person is ${v.contact}.`,
  },
  deadline: {
    en: (p, v) => `${p.en} release deadline: ${v.deadline}.`,
  },
  tech: {
    en: (p, v) => `${p.en}: the backend is written in ${v.tech}.`,
    ar: (p, v) => `مشروع ${p.ar}: الواجهة الخلفية مكتوبة بلغة ${v.tech}.`,
    de: (p, v) => `${p.en}: Das Backend ist in ${v.tech} geschrieben.`,
    iq: (p, v) => `${p.ar}: الباك اند مكتوب ب${v.tech}.`,
  },
  bug: {
    en: (p, v) => `${p.en} known issue: ${v.bug.en}.`,
    ar: (p, v) => `مشكلة معروفة في ${p.ar}: ${v.bug.ar}.`,
    de: (p, v) => `Bekanntes Problem bei ${p.en}: ${v.bug.de}.`,
    iq: (p, v) => `مشكلة بـ${p.ar} نعرفها: ${v.bug.iq}.`,
  },
};

/** Question texts: [lang]: (projectNameOrNull) => text. Null: the project is left out (the chat's project is open). */
const Q = {
  localdb: {
    en: (n) => `Where does the ${n ? n + ' ' : ''}desktop app store its data locally?`,
    ar: (n) => `أين يحفظ تطبيق سطح المكتب${n ? ' في ' + n : ''} بياناته محلياً؟`,
    de: (n) => `Wo speichert die Desktop-App${n ? ' von ' + n : ''} ihre Daten lokal?`,
    iq: (n) => `الديسكتوب${n ? ' مال ' + n : ''} وين يخزن الداتا محلياً؟`,
  },
  serverdb: {
    en: (n) => `Which database does the ${n ? n + ' ' : ''}server use now?`,
    ar: (n) => `ما قاعدة بيانات الخادم${n ? ' في ' + n : ''} حالياً؟`,
    de: (n) => `Welche Datenbank nutzt der Server${n ? ' von ' + n : ''} jetzt?`,
    iq: (n) => `شنو الداتابيس اللي يستخدمها السيرفر${n ? ' مال ' + n : ''} هسه؟`,
  },
  reason: {
    en: (n) => `Why did we change the server database${n ? ' of ' + n : ''}?`,
    ar: (n) => `لماذا غيّرنا قاعدة بيانات الخادم${n ? ' في ' + n : ''}؟`,
    de: (n) => `Warum haben wir die Server-Datenbank${n ? ' von ' + n : ''} gewechselt?`,
    iq: (n) => `تتذكر ليش بدّلنا داتابيس السيرفر${n ? ' مال ' + n : ''}؟`,
  },
  host: {
    en: (n) => `Where is ${n ? n : 'our project'} hosted in production now?`,
    ar: (n) => `أين تتم استضافة ${n ? n : 'مشروعنا'} في الإنتاج الآن؟`,
    de: (n) => `Wo läuft ${n ? n : 'unser Projekt'} jetzt in Produktion?`,
    iq: (n) => `${n ? n : 'مشروعنا'} وين مستضاف هسه بالبرودكشن؟`,
  },
  deploy: {
    en: (n) => `On which day do ${n ? n + ' ' : ''}deploys go out?`,
    ar: (n) => `في أي يوم يتم نشر${n ? ' ' + n : ' التحديثات'}؟`,
    de: (n) => `An welchem Tag wird${n ? ' ' + n : ''} ausgerollt?`,
    iq: (n) => `أي يوم نسوي ديبلوي${n ? ' ل' + n : ''}؟`,
  },
  client: {
    en: (n) => `Who is the client of ${n ? n : 'this project'} and who is our contact there?`,
    ar: (n) => `من هو عميل ${n ? n : 'هذا المشروع'} ومن الشخص المسؤول عندهم؟`,
    de: (n) => `Wer ist der Kunde von ${n ? n : 'diesem Projekt'} und wer ist dort Ansprechpartner?`,
    iq: (n) => `منو الكلاينت مال ${n ? n : 'هالمشروع'} ومنو نحچي وياه؟`,
  },
  deadline: {
    en: (n) => `When is the release deadline${n ? ' for ' + n : ''}?`,
    ar: (n) => `متى موعد الإطلاق النهائي${n ? ' لـ' + n : ''}؟`,
    de: (n) => `Wann ist der Release-Termin${n ? ' für ' + n : ''}?`,
    iq: (n) => `شوكت آخر موعد للإطلاق${n ? ' مال ' + n : ''}؟`,
  },
  tech: {
    en: (n) => `What language is the ${n ? n + ' ' : ''}backend written in?`,
    ar: (n) => `بأي لغة كُتبت الواجهة الخلفية${n ? ' لـ' + n : ''}؟`,
    de: (n) => `In welcher Sprache ist das Backend${n ? ' von ' + n : ''} geschrieben?`,
    iq: (n) => `الباك اند${n ? ' مال ' + n : ''} بأي لغة مكتوب؟`,
  },
  bug: {
    en: (n) => `Is there a known issue in ${n ? n : 'the project'} and a workaround?`,
    ar: (n) => `هل توجد مشكلة معروفة في ${n ? n : 'المشروع'} وما الحل المؤقت؟`,
    de: (n) => `Gibt es ein bekanntes Problem bei ${n ? n : 'dem Projekt'} und einen Umweg?`,
    iq: (n) => `اكو مشكلة معروفة ب${n ? n : 'المشروع'}؟ وشنو الحل هسه؟`,
  },
};
/** Indirect questions: the topic only, no project and none of the fact's exact words. */
const INDIRECT = [
  { attr: 'reason', lang: 'iq', q: 'شنو صار بموضوع السيرفر اللي ناقشناه قبل كم شهر؟' },
  { attr: 'reason', lang: 'en', q: 'Remind me what happened with that server thing we discussed a while ago.' },
  { attr: 'host', lang: 'iq', q: 'هذاك النقل اللي چنا ناويين عليه، شصار بي؟' },
  { attr: 'host', lang: 'de', q: 'Was ist eigentlich aus dem geplanten Umzug geworden?' },
  { attr: 'bug', lang: 'ar', q: 'ذكّرني بالمشكلة التي كانت تزعج العملاء.' },
  { attr: 'bug', lang: 'en', q: 'What was that annoying problem users kept hitting?' },
  { attr: 'client', lang: 'iq', q: 'منو چان الشخص اللي نتواصل وياه بالشركة؟' },
  { attr: 'deadline', lang: 'en', q: 'How much time do we have left before we have to ship?' },
  { attr: 'deadline', lang: 'ar', q: 'متى يجب أن نسلّم؟' },
  { attr: 'deploy', lang: 'iq', q: 'شوكت عادةً ننزّل التحديثات؟' },
];
/** No answer exists in memory for these. */
const NO_ANSWER = [
  { en: (n) => `Which CDN does ${n} use?`, ar: (n) => `ما شبكة توصيل المحتوى التي يستخدمها ${n}؟` },
  { en: (n) => `Who designed the ${n} logo?`, ar: (n) => `من صمّم شعار ${n}؟` },
  { en: (n) => `What is the monthly cloud bill for ${n}?`, ar: (n) => `كم فاتورة السحابة الشهرية لـ${n}؟` },
  { en: (n) => `Which payment provider does ${n} use?`, de: (n) => `Welchen Zahlungsanbieter nutzt ${n}?` },
  { en: (n) => `How many users signed up for ${n} last week?`, iq: (n) => `كم واحد سجّل ب${n} الأسبوع الماضي؟` },
  { en: (n) => `What is the Wi-Fi password at the ${n} client office?`, ar: (n) => `ما كلمة سر الواي فاي في مكتب عميل ${n}؟` },
];

/** Small talk that carries no fact (pads a conversation so the topic lies 10 or 30 messages back). */
const FILLER = [
  'ok thanks', 'تمام', 'passt', 'زين خلّينا نكمل', 'can you check the agenda for tomorrow?', 'هل وصلت رسالة البريد؟', 'Ich bin gleich zurück.', 'شكو ماكو اليوم؟',
  'let me grab a coffee first', 'أرسل لي الملف لاحقاً', 'Danke, das reicht erstmal.', 'خوش، بعدين نحچي', 'what time is the call?', 'نسيت كلمة السر مال الواي فاي', 'Kannst du das kurz zusammenfassen?', 'ماشي',
];
/** How a conversation brings up a project topic (by attribute), in the language of the indirect question. */
const OPENER = {
  reason: { en: (n) => `We were going through the ${n} server setup and its database yesterday.`, iq: (n) => `البارحة چنا نحچي عن سيرفر ${n} والداتابيس مالته.` },
  host: { en: (n) => `Let's talk about where ${n} runs in production.`, iq: (n) => `خلّينا نحچي عن وين ${n} مستضاف.`, de: (n) => `Lass uns über das Hosting von ${n} reden.` },
  bug: { en: (n) => `Users of ${n} keep complaining again.`, ar: (n) => `مستخدمو ${n} يشتكون مجدداً.` },
  client: { iq: (n) => `اليوم اتصلوا من الشركة اللي نشتغل وياها على ${n}.` },
  deadline: { en: (n) => `I'm worried about the ${n} release.`, ar: (n) => `أنا قلق بشأن إطلاق ${n}.` },
  deploy: { iq: (n) => `فريق ${n} سأل عن التحديثات.` },
};
function conversation(opener, distance, r) {
  const pad = distance === 'near' ? 1 : distance === 'mid' ? 10 : 30;
  const out = [opener];
  for (let k = 0; k < pad; k++) out.push(FILLER[Math.floor(r() * FILLER.length)]);
  return out;
}

export const WORLD_PEOPLE = ['Amira Saeed', 'Bernd Koller', 'Chiara Rossi', 'Dunya Hamid', 'Emil Strauss', 'Farah Naji', 'Georg Lindner', 'Huda Karim', 'Ivo Petrov', 'Jana Novak', 'Khalil Musa', 'Leonie Bauer', 'Mustafa Ali', 'Nadia Frei', 'Omar Haddad'];
const ALLERGY = ['penicillin', 'peanuts', 'shellfish', 'pollen', 'lactose'];
const CITY = ['Graz', 'Linz', 'Erbil', 'Basra', 'Salzburg', 'Najaf', 'Innsbruck'];

/** Arabic and Iraqi dialect count as one language for "cross-language". */
const family = (lang) => (lang === 'iq' ? 'ar' : lang);

/**
 * The world: { facts, questions }.
 * Fact: { id, content, drawer ('owner' | 'project:<slug>'), createdAt, status, project, attr, lang }.
 * Question: { id, kind (direct | context | indirect | no-answer | person), lang, project (the chat's open project),
 *   q, target (id or null), relevant [ids], stale [ids that must not outrank the target], temporal, crossLanguage }.
 */
export function buildWorld(seed = 31) {
  const r = rng(seed);
  const rc = rng(seed + 1000); // conversations: their own sequence, so the facts stay as they were
  const facts = [];
  const questions = [];
  const langs = ['en', 'ar', 'de', 'iq'];
  const at = (month, day = 10) => new Date(Date.UTC(2026, month - 1, day, 9, 0)).toISOString();
  const vals = {};
  WORLD_PROJECTS.forEach((p, i) => {
    const lang = langs[i % 4];
    const oldI = Math.floor(r() * OLD_DB.length);
    const v = {
      localDb: LOCAL_DB[i % LOCAL_DB.length], oldDb: OLD_DB[oldI], newDb: NEW_DB[(oldI + i) % NEW_DB.length],
      reason: REASON[i % REASON.length], host: HOST[i % HOST.length], planHost: HOST[(i + 2) % HOST.length],
      day: i % 4, client: CLIENT[i], contact: CONTACT[i], deadline: DEADLINE[i], tech: TECH[i % TECH.length], bug: BUG[i % BUG.length],
    };
    vals[p.slug] = v;
    const projectDrawer = `project:${p.slug}`;
    const add = (attr, drawer, createdAt, status = 'active') => {
      const id = `w-${p.slug}-${attr}`;
      const factLang = FACT[attr][lang] ? lang : 'en'; // client and deadline: the owner's own notes, in English
      facts.push({ id, content: FACT[attr][factLang](p, v), drawer, createdAt, status, project: p.slug, attr, lang: factLang });
      return id;
    };
    add('localdb', projectDrawer, at(1, 5));
    // Temporal: even projects had the old fact replaced through Girru (status 'replaced'); odd ones still hold both (the newer must win).
    const oldDbId = add('serverdb_old', projectDrawer, at(1, 12), i % 2 === 0 ? 'replaced' : 'active');
    add('serverdb', projectDrawer, at(3, 20));
    add('reason', projectDrawer, at(3, 21));
    const planId = add('host_plan', projectDrawer, at(2, 3)); // still active: the newer fact must win
    add('host', projectDrawer, at(4, 18));
    add('deploy', projectDrawer, at(2, 14));
    add('client', 'owner', at(1, 20)); // owner drawer: all ten projects' client notes side by side
    add('deadline', 'owner', at(5, 2)); // the same for deadlines
    add('tech', projectDrawer, at(1, 8));
    add('bug', projectDrawer, at(6, 9));
    const related = { serverdb: [`w-${p.slug}-reason`], reason: [`w-${p.slug}-serverdb`] };
    const stale = { serverdb: [oldDbId], host: [planId] };
    const langOf = (id) => facts.find((f) => f.id === id).lang;
    for (const attr of Object.keys(Q)) {
      const target = `w-${p.slug}-${attr}`;
      for (const ql of langs) {
        for (const named of [true, false]) {
          questions.push({
            id: `q-${p.slug}-${attr}-${ql}-${named ? 'n' : 'u'}`, kind: named ? 'direct' : 'context', lang: ql, project: p.slug,
            q: Q[attr][ql](named ? (ql === 'en' || ql === 'de' ? p.en : p.ar) : null),
            target, relevant: [target, ...(related[attr] || [])], stale: stale[attr] || [],
            temporal: !!stale[attr], crossLanguage: family(ql) !== family(langOf(target)),
          });
        }
      }
    }
    INDIRECT.forEach((ind, k) => {
      const target = `w-${p.slug}-${ind.attr}`;
      const openers = OPENER[ind.attr];
      const opener = (openers[ind.lang] || openers.en || Object.values(openers)[0])(ind.lang === 'en' || ind.lang === 'de' ? p.en : p.ar);
      for (const distance of ['near', 'mid', 'far']) {
        questions.push({ id: `q-${p.slug}-indirect-${k}-${distance}`, kind: 'indirect', distance, lang: ind.lang, project: p.slug, q: ind.q,
          history: conversation(opener, distance, rc), target, relevant: [target, ...(related[ind.attr] || [])], stale: stale[ind.attr] || [],
          temporal: !!stale[ind.attr], crossLanguage: family(ind.lang) !== family(langOf(target)) });
      }
    });
    NO_ANSWER.forEach((na, k) => {
      for (const [ql, fn] of Object.entries(na)) {
        questions.push({ id: `q-${p.slug}-none-${k}-${ql}`, kind: 'no-answer', lang: ql, project: p.slug, q: fn(ql === 'ar' || ql === 'iq' ? p.ar : p.en),
          target: null, relevant: [], stale: [], temporal: false, crossLanguage: false });
      }
    });
  });
  // Multi-hop: the question names a fact of one project (its new server database) and asks for another
  // fact of the same project (the client contact, in the owner drawer). Time travel: what was true in January.
  WORLD_PROJECTS.forEach((p, i) => {
    const db = vals[p.slug].newDb, host = vals[p.slug].host;
    questions.push({ id: `q-${p.slug}-hop-contact`, kind: 'multi-hop', lang: 'en', project: p.slug,
      q: `Who is our contact at the client of the project whose server runs on ${db} and whose production stays on ${host}?`,
      target: `w-${p.slug}-client`, relevant: [`w-${p.slug}-client`, `w-${p.slug}-serverdb`, `w-${p.slug}-host`], hops: [`w-${p.slug}-serverdb`, `w-${p.slug}-client`],
      stale: [], temporal: false, crossLanguage: false });
    questions.push({ id: `q-${p.slug}-hop-deadline-ar`, kind: 'multi-hop', lang: 'ar', project: p.slug,
      q: `متى موعد إطلاق المشروع الذي انتقل خادمه إلى ${db}؟`,
      target: `w-${p.slug}-deadline`, relevant: [`w-${p.slug}-deadline`, `w-${p.slug}-serverdb`], hops: [`w-${p.slug}-serverdb`, `w-${p.slug}-deadline`],
      stale: [], temporal: false, crossLanguage: true });
    questions.push({ id: `q-${p.slug}-past-db`, kind: 'time-travel', lang: 'en', project: p.slug,
      q: `What was the ${p.en} server database in January 2026, before the switch?`,
      target: `w-${p.slug}-serverdb_old`, relevant: [`w-${p.slug}-serverdb_old`, `w-${p.slug}-reason`], stale: [], temporal: true,
      crossLanguage: family(facts.find((f) => f.id === `w-${p.slug}-serverdb_old`).lang) !== 'en',
      note: i % 2 === 0 ? 'the old fact is marked replaced (hidden from search today)' : 'the old fact is still active' });
    questions.push({ id: `q-${p.slug}-past-host-iq`, kind: 'time-travel', lang: 'iq', project: p.slug,
      q: `بشباط شنو چانت خطتنا للهوستنگ مال ${p.ar}؟`, target: `w-${p.slug}-host_plan`, relevant: [`w-${p.slug}-host_plan`, `w-${p.slug}-host`],
      stale: [], temporal: true, crossLanguage: family(facts.find((f) => f.id === `w-${p.slug}-host_plan`).lang) !== 'ar' });
  });
  // Topic switch: talk about X's deadline (or client), switch to Y, ask without a name: Y's fact is right, X's is a mix-up.
  // Going back: the owner names X again before asking. Both facts are in the owner drawer, open in every chat.
  WORLD_PROJECTS.forEach((p, i) => {
    const x = p, y = WORLD_PROJECTS[(i + 1) % 10];
    for (const [attr, ask] of [['deadline', 'And when is the release deadline?'], ['client', 'Who is the contact person there again?']]) {
      questions.push({ id: `q-switch-${x.slug}-${y.slug}-${attr}`, kind: 'topic-switch', lang: 'en', project: y.slug, q: ask,
        history: [`Let's look at ${x.en} first.`, `The ${x.en} ${attr} worries me.`, 'ok thanks', `Now about ${y.en}.`, `${y.en} needs attention this week.`],
        target: `w-${y.slug}-${attr}`, relevant: [`w-${y.slug}-${attr}`], stale: [], mixUp: `w-${x.slug}-${attr}`, temporal: false, crossLanguage: false });
      questions.push({ id: `q-return-${x.slug}-${y.slug}-${attr}`, kind: 'topic-return', lang: 'en', project: y.slug, q: ask,
        history: [`Let's look at ${y.en}.`, `${y.en} needs attention this week.`, 'ok thanks', `Back to ${x.en} for a moment.`],
        target: `w-${x.slug}-${attr}`, relevant: [`w-${x.slug}-${attr}`], stale: [], mixUp: `w-${y.slug}-${attr}`, temporal: false, crossLanguage: false });
    }
  });
  // People (owner drawer): allergy and home city.
  WORLD_PEOPLE.forEach((name, i) => {
    const allergy = ALLERGY[i % ALLERGY.length], city = CITY[i % CITY.length];
    facts.push({ id: `w-person-${i}-allergy`, content: `${name} is allergic to ${allergy}.`, drawer: 'owner', createdAt: at(2, 1 + i), status: 'active', project: null, attr: 'allergy', lang: 'en' });
    facts.push({ id: `w-person-${i}-city`, content: `${name} lives in ${city} and prefers meetings there.`, drawer: 'owner', createdAt: at(2, 1 + i), status: 'active', project: null, attr: 'city', lang: 'en' });
    const first = name.split(' ')[0];
    const ask = (suffix, lang, k, q, attr) => questions.push({ id: `q-person-${i}-${suffix}`, kind: 'person', lang, project: WORLD_PROJECTS[(i + k) % 10].slug, q,
      target: `w-person-${i}-${attr}`, relevant: [`w-person-${i}-${attr}`], stale: [], temporal: false, crossLanguage: family(lang) !== 'en' });
    ask('allergy-en', 'en', 0, `Is ${first} allergic to anything?`, 'allergy');
    ask('allergy-ar', 'ar', 3, `هل عند ${first} حساسية من شيء؟`, 'allergy');
    ask('city-de', 'de', 5, `Wo wohnt ${first}?`, 'city');
    ask('city-iq', 'iq', 7, `${first} وين ساكن؟`, 'city');
  });
  return { facts, questions };
}
