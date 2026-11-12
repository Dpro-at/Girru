/**
 * Text normalization for memory recall (CORE-06).
 *
 * Applied to both stored memory text and queries, for the lexical score and
 * for the embedding input (the stored text itself is never changed):
 *
 *  1. Arabic orthography (`normalizeArabicLetters`):
 *     - diacritics (tashkeel, U+064B–U+065F, U+0670, Quranic marks) and
 *       tatweel (U+0640) removed;
 *     - alef forms أ إ آ ٱ → ا, hamza carriers ؤ → و, ئ → ي, lone ء removed;
 *     - alef maqsura ى → ي, ta marbuta ة → ه;
 *     - Persian / Iraqi letters: چ → ك (Iraqi چ is mostly ك: چبير = كبير,
 *       شلونچ = شلونك), گ → ق (Iraqi گ is mostly ق: گال = قال, گاعد = قاعد),
 *       ڤ → ف, پ → ب, ژ → ز, ک → ك, ی → ي;
 *     - Arabic-Indic digits → ASCII digits.
 *  2. Iraqi → MSA dictionary (`IRAQI_TO_MSA`, below): common dialect words and
 *     phrases are replaced by their Modern Standard Arabic meaning, so an Iraqi
 *     query reaches an MSA memory (and the reverse) without a model. Longest
 *     phrase first (up to 3 words); a leading و / ف ("and") is kept.
 *  3. Lexical tokens only (`lexicalTokens`): lower case, German umlauts
 *     folded (ä→a, ö→o, ü→u, ß→ss, ae/oe/ue→a/o/u), stop words dropped, light
 *     stemming (Arabic article/conjunction prefixes and common suffixes;
 *     English/German plural and verb endings).
 *
 * Pure functions, no state: nothing of a memory is cached here (CORE-07).
 */

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭـ]/g;

const LETTER_MAP: Readonly<Record<string, string>> = {
  'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ٲ': 'ا', 'ٳ': 'ا',
  'ؤ': 'و', 'ئ': 'ي', 'ء': '',
  'ى': 'ي', 'ة': 'ه',
  'چ': 'ك', 'گ': 'ق', 'ڤ': 'ف', 'پ': 'ب', 'ژ': 'ز', 'ک': 'ك', 'ی': 'ي', 'ھ': 'ه', 'ۀ': 'ه',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};
const LETTER_RE = new RegExp(`[${Object.keys(LETTER_MAP).join('')}]`, 'g');

/** Step 1: Arabic orthographic normalization (other scripts unchanged). */
export function normalizeArabicLetters(text: string): string {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(DIACRITICS, '')
    .replace(LETTER_RE, (ch) => LETTER_MAP[ch] ?? ch);
}

/**
 * Iraqi dialect → MSA. Keys and values are written in normal spelling; they
 * are normalized with step 1 when the table is built, so spelling variants
 * (هسة / هسه, شلونچ / شلونك, گال / كال) match the same entry.
 * Ambiguous words that are also common MSA words with another meaning
 * (هم "also" vs "they", روح "go" vs "soul", جاهل "child" vs "ignorant",
 * راح future marker vs "went", اي "yes" vs "which") are left out on purpose.
 */
export const IRAQI_TO_MSA: ReadonlyArray<readonly [string, string]> = [
  // greetings and small talk
  ['شكو ماكو', 'ما الأخبار'],
  ['شلون صحتك', 'كيف صحتك'],
  ['شلونك', 'كيف حالك'],
  ['شلونكم', 'كيف حالكم'],
  ['شلونها', 'كيف حالها'],
  ['شلونه', 'كيف حاله'],
  ['شلون', 'كيف'],
  ['هلو', 'مرحبا'],
  ['هلا', 'أهلا'],
  ['مشتاقلك', 'اشتقت إليك'],
  ['عيوني', 'عزيزي'],
  ['اغاتي', 'سيدي'],
  ['يمعود', 'يا رجل'],
  ['ميخالف', 'لا بأس'],
  ['على راسي', 'بكل سرور'],
  // question words
  ['شنو', 'ماذا'],
  ['شني', 'ماذا'],
  ['شكو', 'ماذا يوجد'],
  ['شصار', 'ماذا حدث'],
  ['شبيك', 'ما بك'],
  ['شسمك', 'ما اسمك'],
  ['شسمه', 'ما اسمه'],
  ['شسمها', 'ما اسمها'],
  ['ليش', 'لماذا'],
  ['وين', 'أين'],
  ['منين', 'من أين'],
  ['شوكت', 'متى'],
  ['امتى', 'متى'],
  ['شكد', 'كم'],
  ['شقد', 'كم'],
  ['اشكد', 'كم'],
  ['منو', 'من'],
  // existence and negation
  ['ماكو', 'لا يوجد'],
  ['اكو', 'يوجد'],
  ['مو', 'ليس'],
  ['ماعدي', 'ليس عندي'],
  ['ميحب', 'لا يحب'],
  ['ميعرف', 'لا يعرف'],
  ['ميصير', 'لا يجوز'],
  // time
  ['هسه', 'الآن'],
  ['هسا', 'الآن'],
  ['لهسه', 'حتى الآن'],
  ['باجر', 'غدا'],
  ['باكر', 'غدا'],
  ['الصبح', 'الصباح'],
  ['بعدين', 'لاحقا'],
  ['عكب', 'بعد'],
  ['دوم', 'دائما'],
  ['تو', 'للتو'],
  // quantity and degree
  ['هواي', 'كثير'],
  ['هوايه', 'كثير'],
  ['كلش', 'جدا'],
  ['حيل', 'جدا'],
  ['شوي', 'قليلا'],
  ['شويه', 'قليلا'],
  ['بس', 'فقط'],
  ['كلشي', 'كل شيء'],
  // quality
  ['زين', 'جيد'],
  ['خوش', 'جيد'],
  ['صدك', 'حقا'],
  ['بلكي', 'ربما'],
  ['لعد', 'إذن'],
  // pronouns and demonstratives
  ['اني', 'أنا'],
  ['احنه', 'نحن'],
  ['احنا', 'نحن'],
  ['انته', 'أنت'],
  ['انتي', 'أنت'],
  ['انتو', 'أنتم'],
  ['همه', 'هم'],
  ['هاي', 'هذه'],
  ['هذوله', 'هؤلاء'],
  ['ذوله', 'هؤلاء'],
  ['هذاك', 'ذلك'],
  ['هذيك', 'تلك'],
  ['هيج', 'هكذا'],
  ['هيك', 'هكذا'],
  // prepositions and possession
  ['ويا', 'مع'],
  ['وياك', 'معك'],
  ['وياي', 'معي'],
  ['وياه', 'معه'],
  ['عدي', 'عندي'],
  ['عدك', 'عندك'],
  ['عده', 'عنده'],
  ['عدنا', 'عندنا'],
  ['قدام', 'أمام'],
  ['جوه', 'تحت'],
  ['فوك', 'فوق'],
  ['يم', 'بجانب'],
  ['ورا', 'وراء'],
  // verbs
  ['يسوي', 'يفعل'],
  ['تسوي', 'تفعل'],
  ['اسوي', 'أفعل'],
  ['سوى', 'فعل'],
  ['اشوف', 'أرى'],
  ['اشوفك', 'أراك'],
  ['شفت', 'رأيت'],
  ['كاعد', 'جالس'],
  ['كال', 'قال'],
  ['يكول', 'يقول'],
  ['اقلك', 'أقول لك'],
  ['اروح', 'أذهب'],
  ['يروح', 'يذهب'],
  ['رحت', 'ذهبت'],
  ['اجي', 'آتي'],
  ['اجيت', 'أتيت'],
  ['اقدر', 'أستطيع'],
  ['تقدر', 'تستطيع'],
  ['يقدر', 'يستطيع'],
  ['يكعد', 'يستيقظ'],
  ['كعد', 'استيقظ'],
  ['خابرني', 'اتصل بي'],
  ['خابر', 'اتصل'],
  ['سولف', 'تحدث'],
  ['نسولف', 'نتحدث'],
  ['سوالف', 'أحاديث'],
  ['يشتغل', 'يعمل'],
  ['اشتغل', 'أعمل'],
  // things
  ['ماي', 'ماء'],
  ['تمن', 'أرز'],
  ['كاي', 'شاي'], // چاي (چ → ك)
  ['جكاره', 'سيجارة'],
  ['بزون', 'قطة'],
  ['كهربا', 'كهرباء'],
  ['فلوس', 'مال'],
  ['عيله', 'عائلة'],
  ['دكتور', 'طبيب'],
  ['جلب', 'كلب'],
  ['شتا', 'شتاء'],
];

const ARABIC_LETTER = /[ء-ي]/;
const WORD_SPLIT = /([^\p{L}\p{N}]+)/u;

interface DictEntry { words: string[]; value: string }
const DICT_BY_FIRST = new Map<string, DictEntry[]>();
for (const [k, v] of IRAQI_TO_MSA) {
  const words = normalizeArabicLetters(k).split(/\s+/).filter(Boolean);
  const value = normalizeArabicLetters(v);
  const list = DICT_BY_FIRST.get(words[0]) ?? [];
  list.push({ words, value });
  list.sort((a, b) => b.words.length - a.words.length); // longest phrase first
  DICT_BY_FIRST.set(words[0], list);
}

/** Number of distinct dictionary entries (documented size). */
export const IRAQI_DICTIONARY_SIZE = IRAQI_TO_MSA.length;

const WORD_PREFIXES: ReadonlyArray<{ text: string; article: boolean }> = [
  { text: 'وال', article: true }, { text: 'بال', article: true }, { text: 'لل', article: true }, { text: 'ال', article: true },
  { text: 'و', article: false }, { text: 'ف', article: false },
];

function lookup(word: string): DictEntry[] | undefined {
  return DICT_BY_FIRST.get(word);
}

/**
 * Steps 1 + 2: Arabic letters normalized and Iraqi words/phrases replaced by
 * MSA. Punctuation and non-Arabic text are kept (this is also the embedding
 * input). Latin text is unchanged.
 */
export function normalizeMemoryText(text: string): string {
  const base = normalizeArabicLetters(text);
  if (!ARABIC_LETTER.test(base)) return base;
  // pieces alternate: word, separator, word, separator, ...
  const pieces = base.split(WORD_SPLIT);
  const out: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (i % 2 === 1 || !piece || !ARABIC_LETTER.test(piece)) { out.push(piece); continue; }
    // A leading و / ف ("and") on a dialect word is kept: وشلونك -> و كيف حالك;
    // an article (ال / بال / وال / لل) only on one-word entries: البزون -> القطة.
    let prefix = '';
    let word = piece;
    let entries = lookup(word);
    if (!entries) {
      for (const p of WORD_PREFIXES) {
        if (!word.startsWith(p.text) || word.length - p.text.length < 2) continue;
        const rest = lookup(word.slice(p.text.length))?.filter((e) => !p.article || (e.words.length === 1 && !e.value.includes(' ')));
        if (!rest?.length) continue;
        prefix = p.article ? p.text : `${p.text} `;
        word = word.slice(p.text.length);
        entries = rest;
        break;
      }
    }
    if (!entries) { out.push(piece); continue; }
    let matched: DictEntry | null = null;
    for (const e of entries) {
      let ok = true;
      for (let j = 1; j < e.words.length; j++) {
        const sep = pieces[i + 2 * j - 1];
        if (sep === undefined || !/^\s+$/.test(sep) || pieces[i + 2 * j] !== e.words[j]) { ok = false; break; }
      }
      if (ok) { matched = e; break; }
    }
    if (!matched) { out.push(piece); continue; }
    out.push(prefix + matched.value);
    i += 2 * (matched.words.length - 1);
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Lexical tokens
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  // English
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did', 'to', 'of', 'in', 'on', 'at',
  'for', 'and', 'or', 'it', 'its', 'this', 'that', 'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
  'i', 'me', 'my', 'you', 'your', 'he', 'his', 'she', 'her', 'we', 'our', 'they', 'their', 'with', 'by', 'from',
  'any', 'anything', 'there', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'should', 'must', 'about', 'than',
  'every', 'each', 'into', 'as', 'not', 'no', 'yes', 's',
  // German (after umlaut folding)
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'und', 'oder', 'ist', 'sind',
  'war', 'wird', 'werden', 'wurde', 'bin', 'bist', 'hat', 'haben', 'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr',
  'mein', 'meine', 'dein', 'sein', 'seine', 'im', 'am', 'um', 'zu', 'zum', 'zur', 'von', 'vom', 'mit', 'fur', 'auf',
  'bei', 'bis', 'nach', 'aus', 'was', 'wer', 'wie', 'wo', 'wann', 'warum', 'welche', 'welcher', 'welches', 'nicht',
  'kein', 'keine', 'muss', 'kann', 'soll', 'jeden', 'jede', 'jedes', 'dass', 'auch', 'noch', 'schon',
  // Arabic (after normalization)
  'في', 'من', 'على', 'الي', 'عن', 'ما', 'ماذا', 'هل', 'هو', 'هي', 'انا', 'انت', 'نحن', 'هم', 'هذا', 'هذه', 'ذلك',
  'تلك', 'التي', 'الذي', 'الذين', 'كان', 'كانت', 'يكون', 'تكون', 'او', 'ان', 'لا', 'لم', 'لن', 'قد', 'ثم', 'مع',
  'كل', 'اي', 'اين', 'متي', 'كيف', 'لماذا', 'كم', 'هناك', 'عند', 'عندما', 'بعد', 'قبل', 'الا', 'اذا', 'او', 'به',
  'بها', 'له', 'لها', 'منه', 'فيه', 'فيها', 'يا', 'و', 'ف', 'ب', 'ل', 'اذن',
]);

function foldLatin(word: string): string {
  return word
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
    .replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const AR_PREFIXES = ['وال', 'بال', 'كال', 'فال', 'لل', 'ال'];
const AR_SUFFIXES = ['هما', 'كما', 'تين', 'ها', 'هم', 'هن', 'كم', 'كن', 'نا', 'ان', 'ات', 'ون', 'ين', 'يه', 'ه', 'ي'];

/** Light Arabic stemmer (prefixes/suffixes only, keeps at least 3 letters). */
export function stemArabic(word: string): string {
  let w = word;
  for (const p of AR_PREFIXES) {
    if (w.startsWith(p) && w.length - p.length >= 3) { w = w.slice(p.length); break; }
  }
  if (w.length >= 5 && (w[0] === 'و' || w[0] === 'ف' || w[0] === 'ب' || w[0] === 'ل' || w[0] === 'ك')) w = w.slice(1);
  for (const s of AR_SUFFIXES) {
    if (w.endsWith(s) && w.length - s.length >= 3) { w = w.slice(0, -s.length); break; }
  }
  return w;
}

const LATIN_SUFFIXES = ['ungen', 'ung', 'ing', 'ies', 'ed', 'es', 'en', 'er', 'e', 's', 'n'];

/** Light English/German stemmer (keeps at least 3 letters). */
export function stemLatin(word: string): string {
  if (word.length <= 3 || /\d/.test(word)) return word;
  for (const s of LATIN_SUFFIXES) {
    if (word.endsWith(s) && word.length - s.length >= 3) {
      if (s === 's' && word.endsWith('ss')) return word;
      return s === 'ies' ? `${word.slice(0, -3)}y` : word.slice(0, -s.length);
    }
  }
  return word;
}

/**
 * MEM-LANG-01: scripts written without spaces between words (Chinese, Japanese, Thai, Lao, Khmer,
 * Burmese). A run of them becomes overlapping two-character tokens (the usual way to index these
 * languages without a dictionary), so a word inside a long run still matches.
 */
const NO_SPACE_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}ー]+/gu;

function noSpaceBigrams(run: string): string[] {
  const chars = [...run];
  if (chars.length === 1) return chars;
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}

/**
 * Lexical tokens of a text: normalized (steps 1–2), lower case, umlauts
 * folded, stop words dropped, light stemming. Used for BM25 and the offline
 * hash embedding. Combining marks are kept (MEM-LANG-01: Hindi and other Indic
 * words were cut at every vowel sign); runs of Chinese, Japanese, Thai, Lao,
 * Khmer or Burmese become two-character tokens.
 */
export function lexicalTokens(text: string): string[] {
  const norm = normalizeMemoryText(text).toLowerCase();
  const out: string[] = [];
  for (const piece of norm.split(/[^\p{L}\p{N}\p{M}]+/u)) {
    if (!piece) continue;
    NO_SPACE_RUN.lastIndex = 0;
    if (!NO_SPACE_RUN.test(piece)) { pushToken(out, piece); continue; }
    // Mixed text ("GPT模型的数据"): each no-space run gives bigrams, the rest stays a word.
    let last = 0;
    NO_SPACE_RUN.lastIndex = 0;
    for (const m of piece.matchAll(NO_SPACE_RUN)) {
      if (m.index! > last) pushToken(out, piece.slice(last, m.index));
      out.push(...noSpaceBigrams(m[0]));
      last = m.index! + m[0].length;
    }
    if (last < piece.length) pushToken(out, piece.slice(last));
  }
  return out;
}

function pushToken(out: string[], raw: string): void {
  {
    if (!raw) return;
    const isArabic = ARABIC_LETTER.test(raw);
    const word = isArabic ? raw : foldLatin(raw);
    if (STOP_WORDS.has(word)) return;
    const stem = isArabic ? stemArabic(word) : stemLatin(word);
    if (stem.length < 2 || STOP_WORDS.has(stem)) return;
    out.push(stem);
  }
}
