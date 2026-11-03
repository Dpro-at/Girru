/**
 * STORE-MAP-01 P9 (PRIV3, PRIV7): personal data and special categories in
 * text that is about to become memory (GIRRU_STORE_P9).
 *
 * personalDataKinds: other people's contact and identity data that imported
 * chats and channel messages carry (e-mail addresses, phone numbers, bank
 * account and card numbers, street addresses, identity numbers). The review
 * shows which kinds were found, never the values. Pattern based and
 * conservative; nothing is logged.
 *
 * specialCategory: GDPR Art. 9 topics (health, religion or belief, political
 * opinions, sexual life or orientation, racial or ethnic origin, trade union
 * membership, genetic or biometric data). A memory about them is never saved
 * automatically; the owner decides (learning.ts adds 'special-category',
 * which always asks).
 */

export type PersonalDataKind = 'email' | 'phone' | 'bank-account' | 'card' | 'address' | 'id-number';

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
// +49 170 1234567, (030) 123-4567, 0770 123 4567, ٠٧٧٠١٢٣٤٥٦٧ (Arabic-Indic digits are normalized first).
const PHONE = /(?:^|[^\w])(?:\+|00)?\d[\d\s().-]{7,20}\d(?!\w)/;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/;
const CARD = /\b(?:\d[ -]?){13,19}\b/;
const ADDRESS = /\b\d{1,5}\s+[A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){0,4}\s+(?:street|st\.?|avenue|ave\.?|road|rd\.?|lane|blvd|boulevard|drive|way|platz|gasse|weg)\b|\b[A-ZÄÖÜ][\p{L}-]+(?:straße|strasse|gasse|weg|platz)\s+\d{1,4}\b|(?:شارع|حي|محلة|زقاق)\s+\S+/iu;
const ID_NUMBER = /\b(?:passport|ausweis|id card|national id|ssn|social security|tax id|steuer-?id|رقم (?:الجواز|الهوية|البطاقة)|جواز سفر رقم)\b[^\n]{0,20}?\b[A-Z0-9]{6,12}\b|\b\d{3}-\d{2}-\d{4}\b/iu;

function westernDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (dbl) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    dbl = !dbl;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

/** Longest text scanned (bounded work on untrusted text). */
export const MAX_SCAN_CHARS = 16_000;

/** Which kinds of personal data the text holds (never the values). */
export function personalDataKinds(text: string): PersonalDataKind[] {
  if (!text) return [];
  const t = westernDigits(text.slice(0, MAX_SCAN_CHARS));
  const out = new Set<PersonalDataKind>();
  if (EMAIL.test(t)) out.add('email');
  const iban = IBAN.exec(t);
  if (iban) out.add('bank-account');
  for (const m of t.matchAll(new RegExp(CARD.source, 'g'))) {
    if (luhn(m[0].replace(/\D/g, ''))) { out.add('card'); break; }
  }
  const phone = PHONE.exec(iban ? t.replace(iban[0], ' ') : t);
  if (phone) {
    const digits = phone[0].replace(/\D/g, '');
    // 8–15 digits, not a date or a plain year range, not a card number.
    if (digits.length >= 8 && digits.length <= 15 && !/^\s*\d{4}-\d{2}-\d{2}/.test(phone[0].trim()) && !luhn(digits)) out.add('phone');
  }
  if (ADDRESS.test(t)) out.add('address');
  if (ID_NUMBER.test(t)) out.add('id-number');
  return [...out];
}

const SPECIAL = /\b(health|doctor|diagnos\w*|disease|illness|hospital|therapy|therapist|medication|pregnan\w*|disabilit\w*|mental health|depress\w*|religio\w*|church|mosque|synagogue|pray(?:s|ed|ing)?|faith|atheis\w*|muslim|christian|jewish|hindu|buddhis\w*|politic\w*|votes? for|voted for|party member|left-wing|right-wing|sexual\w*|gay|lesbian|bisexual|transgender|ethnic\w*|racial|trade union|union member|genetic|dna|biometric|fingerprint)\b|صحة|طبيب|مرض|مستشفى|علاج|دواء|حامل|إعاقة|اكتئاب|دين|ديانة|مسلم|مسيحي|يهودي|مسجد|كنيسة|يصلي|سياس|حزب|ينتخب|جنسي|مثلي|عرق|قومية|نقابة|وراثي|بصمة|\b(gesundheit|arzt|krankheit|krankenhaus|therapie|schwanger|behinderung|religion|kirche|moschee|glaube|partei|wählt|sexuell|schwul|ethnisch|gewerkschaft|genetisch|biometrisch)\b/i;

/** True when the text is about a special category of personal data (GDPR Art. 9). */
export function specialCategory(text: string): boolean {
  return !!text && SPECIAL.test(text.slice(0, MAX_SCAN_CHARS));
}
