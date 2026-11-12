/**
 * Recall intent (STORE-MAP-01 P9b, MD5). Pure, rule based, no model: a reply
 * never waits for a generative model (LAT rule 1).
 *
 * What does the message need?
 *   decision  a decision and its why ("why did we choose X", "ليش قررنا")
 *   howto     how to do something ("how do I deploy", "شلون نوقّع")
 *   history   what happened when ("what happened last week", "شصار أمس")
 *   person    who someone is ("who is our accountant", "منو المحاسبة")
 *   fact      anything else (the default)
 *
 * The first match in that order wins. Each intent prefers some memory types
 * and drawers (INTENT_ROUTES); recall.ts gives those a small boost and, for
 * history, weighs recency more. It never hides the others: a question that
 * was classified wrongly still finds its memory, only a little lower.
 * Words in English, Arabic (MSA and Iraqi) and German.
 */

export type RecallIntent = 'fact' | 'howto' | 'history' | 'person' | 'decision';

const PATTERNS: ReadonlyArray<[RecallIntent, RegExp]> = [
  ['decision', /\b(why (did|do|have) (we|you|i)|what did we decide|decid\w*|decision|chose|chosen|agreed on|our policy)\b|لماذا (قرر|اختر|اتفق)\w*|ليش (قرر|اختر|اتفق|سوي)\w*|قرار|قررنا|اخترنا|اتفقنا|\b(warum haben wir|entschieden|entscheidung|beschlossen)\b/iu],
  // "How does Samir like his tea" / "كيف يحب" asks for a preference, not a procedure: only "how do I/we", "how can", "how to".
  ['howto', /\b(how (do|can|should) (i|we|you)|how to|steps? (to|for)|way to|procedure|instructions? for|guide to)\b|(كيف|شلون) (أ|ا|ن|يمكن|يتم)|طريقة|خطوات|\b(wie (kann|mache|machen|soll) (ich|man|wir)|anleitung|schritte)\b/iu],
  ['history', /\b(what happened|when did|when was|last (time|week|month|year)|yesterday|ago|previously|earlier this|history of|lately|recently|these days)\b|ماذا حدث|ما الذي حدث|شصار|شنو صار|أمس|امس|البارحة|سابقا|سابقاً|الأسبوع الماضي|الاسبوع الماضي|\b(was ist passiert|wann war|gestern|letzte woche|früher)\b/iu],
  ['person', /\b(who|whom|whose)\b|من (هو|هي|هم)|منو|مين|\b(wer|wem|wessen)\b/iu],
];

/**
 * MEM-HIST-01: does the message ask what WAS true (a month or year, "before the switch", "used to",
 * "originally", "چانت", "قبل التغيير", "früher", "vorher")? Then recall also reads replaced facts,
 * labelled as no longer current. Rules only.
 */
const MONTH = /\b(in|im|during|before|since|bis|seit)\s+(january|february|march|april|may|june|july|august|september|october|november|december|januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\b|\b(19|20)\d{2}\b/iu;
const AR_MONTH = /(ب|في |قبل |بشهر |في شهر )(كانون|شباط|آذار|اذار|نيسان|أيار|ايار|حزيران|تموز|آب|اب|أيلول|ايلول|تشرين|يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)/u;
const PAST_STATE = /\b(before (the|we|it)|used to|originally|at first|at the time|back then|previous(ly)?|old (one|plan|server|setup|database|version)|was (the|it|our)|were (the|we|our)|did we (use|have|plan))\b|قبل (التغيير|التبديل|الانتقال|النقل)|سابقاً|سابقا|في البداية|بالبداية|چان|چانت|چنا|كان |كانت |\b(früher|vorher|ursprünglich|damals|bevor)\b/iu;

export function asksAboutThePast(query: string): boolean {
  const q = String(query ?? '').slice(0, 2000);
  return MONTH.test(q) || AR_MONTH.test(q) || PAST_STATE.test(q);
}

export function classifyIntent(query: string): RecallIntent {
  const q = String(query ?? '').slice(0, 2000);
  for (const [intent, re] of PATTERNS) if (re.test(q)) return intent;
  return 'fact';
}

/** Memory types and drawer kinds each intent prefers. */
export const INTENT_ROUTES: Readonly<Record<RecallIntent, { types: ReadonlySet<string>; drawers: ReadonlySet<string>; text?: RegExp }>> = {
  fact: { types: new Set(['fact', 'preference']), drawers: new Set() },
  howto: { types: new Set(['procedure', 'skill', 'instruction', 'experience', 'lesson', 'howto']), drawers: new Set(['experience']) },
  history: { types: new Set(['event', 'episode', 'conversation', 'task', 'task-summary', 'summary']), drawers: new Set(['task']) },
  person: { types: new Set(['relationship', 'person', 'contact']), drawers: new Set(['people']) },
  decision: {
    types: new Set(['decision']),
    drawers: new Set(),
    text: /\b(decided|decision|because|so that|from now on|we chose)\b|قرار|قررنا|لأن|لان|من الآن|\b(entschieden|weil|ab jetzt)\b/iu,
  },
};

/** Does this memory fit what the intent looks for? (fact: no preference, never boosted) */
export function fitsIntent(intent: RecallIntent, m: { type?: string; drawer?: { kind: string } | null; content?: string }, viaGraph = false): boolean {
  if (intent === 'fact') return false;
  const r = INTENT_ROUTES[intent];
  if (m.type && r.types.has(m.type)) return true;
  if (m.drawer && r.drawers.has(m.drawer.kind)) return true;
  if (intent === 'person' && viaGraph) return true;
  return !!(r.text && m.content && r.text.test(m.content));
}

const QUESTION = /[?؟]|\b(what|who|whom|whose|where|when|which|how|why|do you (know|remember)|did (i|we)|is there|are there)\b|(^|\s)(ماذا|من هو|من هي|أين|اين|وين|متى|شوكت|كم|شگد|شكد|شنو|شنهو|منو|مين|هل|ليش|لماذا|كيف|شلون)(\s|$)|\b(wer|wo|wann|wie|welche[rsmn]?|warum|weißt du)\b/iu;

/**
 * MD8: is this message a question that memory could answer? Only then does
 * "no reliable memory" tell the agent to ask; a greeting, thanks or an order
 * gets no memory line at all (as before).
 */
export function isMemoryQuestion(query: string, contentWords: number): boolean {
  return contentWords >= 2 && QUESTION.test(String(query ?? '').slice(0, 2000));
}
