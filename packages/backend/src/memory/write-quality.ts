/**
 * Write-side memory quality (STORE-MAP-01 P9, M1). Pure: no I/O.
 *
 * What gets saved matters as much as how it is stored. Three checks run on a
 * learned item before learn() saves it (GIRRU_STORE_P9 only), and the test
 * set (test/store-p9-quality.test.mjs) holds cases for each:
 *
 *   one fact per memory  an extraction that packs several facts into one text
 *                        ("User lives in Berlin. User works as a nurse.") is
 *                        split into one candidate per fact. Only clear cases:
 *                        every part is a full sentence with its own words, and
 *                        no part leans on the one before ("He ...", "It ...").
 *   duplicates on write  the same words in another order or form ("Prefers
 *                        dark mode" / "dark mode is preferred") count as known,
 *                        not only a word-for-word copy.
 *   calibrated importance  a model's extraction cannot give itself a pinned
 *                        importance: a routine save from extraction is kept at
 *                        or below EXTRACTED_MAX_IMPORTANCE (the same ceiling an
 *                        agent has, CHAT-BUILD-01 M1), so it never lands in
 *                        every prompt. The owner can still raise it.
 */

import { lexicalTokens, normalizeArabicLetters } from './text-normalize.js';
import { detectContradiction } from './contradiction.js';

/** Highest importance a routine save from extraction keeps (8+ would be pinned or factual-forever). */
export const EXTRACTED_MAX_IMPORTANCE = 7;
/** At most this many facts are split out of one text. */
export const MAX_SPLIT_FACTS = 5;
/** A part needs at least this many content words to stand alone as a fact. */
const MIN_FACT_WORDS = 3;
/** Near-duplicates need at least this many content words (short texts compare word for word only). */
const MIN_DUPLICATE_WORDS = 2;

/** A part that starts with one of these points back to the sentence before it. */
const LEANS_BACK = new Set([
  'he', 'she', 'it', 'they', 'this', 'that', 'these', 'those', 'also', 'but', 'and', 'so', 'then', 'there',
  'er', 'sie', 'es', 'das', 'dies', 'auch', 'aber', 'und',
  'هو', 'هي', 'هم', 'هذا', 'هذه', 'ذلك', 'وهو', 'وهي', 'لكن', 'ولكن', 'كما', 'و',
]);

const SENTENCE_END = /(?<=[.!?؟])\s+|\s*[;؛]\s+|\n+/u;
const BULLET = /^\s*(?:[-*•]|\d{1,2}[.)])\s+/u;

function firstWord(s: string): string {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/u)?.[0] ?? '');
}

/**
 * The facts in one learned text: the text itself, or (clear cases only) one
 * part per sentence. Never more than MAX_SPLIT_FACTS parts; a text with more
 * sentences than that stays whole.
 */
export function splitFacts(text: string): string[] {
  const whole = String(text ?? '').trim();
  if (!whole) return [];
  const parts = whole.split(SENTENCE_END).map((p) => p.replace(BULLET, '').trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > MAX_SPLIT_FACTS) return [whole];
  for (const p of parts) {
    if (lexicalTokens(p).length < MIN_FACT_WORDS) return [whole];
    if (LEANS_BACK.has(firstWord(p))) return [whole];
    // A Latin part must start like a sentence ("e.g. tea" is no new fact).
    const c = p[0];
    if (/[a-z]/.test(c)) return [whole];
  }
  return parts;
}

/** A stem with a doubled last consonant ("preferr" from "preferred") compares as the single one. */
const words = (s: string) => new Set(lexicalTokens(s).map((t) => t.replace(/([b-df-hj-np-tv-z])\1$/, '$1')));

/** Negation and must/should words: the stop-word list drops them, so they are compared on their own. */
const POLARITY = new Set([
  'not', 'no', 'never', 'none', 'nothing', 'nobody', 'dont', 'doesnt', 'didnt', 'isnt', 'arent', 'wasnt', 'werent', 'wont', 'cant', 'cannot', 'without',
  'must', 'should', 'may', 'might', 'always',
  'nicht', 'kein', 'keine', 'keinen', 'keiner', 'nie', 'niemals', 'ohne', 'muss', 'soll', 'immer',
  'لا', 'لم', 'لن', 'ليس', 'ليست', 'مو', 'مش', 'ما', 'ماكو', 'بدون', 'يجب', 'دائما',
]);
const polarity = (s: string) => normalizeArabicLetters(String(s ?? '')).toLowerCase().replace(/['’]/g, '')
  .split(/[^\p{L}\p{N}]+/u).filter((w) => POLARITY.has(w)).sort().join(' ');

/**
 * True when both texts say the same with the same content words (any order,
 * any form) AND the same negation and must/should words: "User likes tea"
 * and "User does not like tea" are never duplicates.
 */
export function nearDuplicate(a: string, b: string): boolean {
  if (polarity(a) !== polarity(b) || detectContradiction(a, b)) return false;
  const ta = words(a);
  const tb = words(b);
  if (ta.size < MIN_DUPLICATE_WORDS || ta.size !== tb.size) return false;
  for (const t of ta) if (!tb.has(t)) return false;
  return true;
}

/** The importance a routine save keeps (see the module comment). */
export function calibratedImportance(origin: string, importance: number): number {
  return origin === 'extraction' ? Math.min(importance, EXTRACTED_MAX_IMPORTANCE) : importance;
}
