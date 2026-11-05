/**
 * Complete list of Twilio supported voices and languages
 * Updated: 2026-03-08
 * Source: https://www.twilio.com/docs/voice/twiml/say/text-speech
 */

export const VOICE_CATEGORIES = {
  STANDARD: 'Standard Voices',
  POLLY: 'Amazon Polly Voices',
  GOOGLE: 'Google Voices',
  GOOGLE_GENERATIVE: 'Google Generative AI Voices'
};

export const LANGUAGES = [
  // Arabic
  { code: 'arb', name: 'Arabic (Gulf)', flag: '🇸🇦' },
  { code: 'ar-AE', name: 'Arabic (UAE)', flag: '🇦🇪' },
  { code: 'ar-SA', name: 'Arabic (Saudi Arabia)', flag: '🇸🇦' },

  // English
  { code: 'en-US', name: 'English (US)', flag: '🇺🇸' },
  { code: 'en-GB', name: 'English (UK)', flag: '🇬🇧' },
  { code: 'en-AU', name: 'English (Australia)', flag: '🇦🇺' },
  { code: 'en-CA', name: 'English (Canada)', flag: '🇨🇦' },
  { code: 'en-IN', name: 'English (India)', flag: '🇮🇳' },

  // French
  { code: 'fr-FR', name: 'French (France)', flag: '🇫🇷' },
  { code: 'fr-CA', name: 'French (Canada)', flag: '🇨🇦' },

  // German
  { code: 'de-DE', name: 'German', flag: '🇩🇪' },
  { code: 'de-AT', name: 'German (Austria)', flag: '🇦🇹' },

  // Spanish
  { code: 'es-ES', name: 'Spanish (Spain)', flag: '🇪🇸' },
  { code: 'es-MX', name: 'Spanish (Mexico)', flag: '🇲🇽' },
  { code: 'es-US', name: 'Spanish (US)', flag: '🇺🇸' },

  // Italian
  { code: 'it-IT', name: 'Italian', flag: '🇮🇹' },

  // Portuguese
  { code: 'pt-BR', name: 'Portuguese (Brazil)', flag: '🇧🇷' },
  { code: 'pt-PT', name: 'Portuguese (Portugal)', flag: '🇵🇹' },

  // Japanese
  { code: 'ja-JP', name: 'Japanese', flag: '🇯🇵' },

  // Korean
  { code: 'ko-KR', name: 'Korean', flag: '🇰🇷' },

  // Chinese
  { code: 'cmn-CN', name: 'Chinese (Mandarin)', flag: '🇨🇳' },
  { code: 'zh-CN', name: 'Chinese (Simplified)', flag: '🇨🇳' },
  { code: 'zh-HK', name: 'Chinese (Hong Kong)', flag: '🇭🇰' },
  { code: 'zh-TW', name: 'Chinese (Taiwan)', flag: '🇹🇼' },

  // Other European
  { code: 'nl-NL', name: 'Dutch', flag: '🇳🇱' },
  { code: 'pl-PL', name: 'Polish', flag: '🇵🇱' },
  { code: 'ru-RU', name: 'Russian', flag: '🇷🇺' },
  { code: 'sv-SE', name: 'Swedish', flag: '🇸🇪' },
  { code: 'da-DK', name: 'Danish', flag: '🇩🇰' },
  { code: 'no-NO', name: 'Norwegian', flag: '🇳🇴' },
  { code: 'tr-TR', name: 'Turkish', flag: '🇹🇷' },

  // Indian Languages
  { code: 'hi-IN', name: 'Hindi', flag: '🇮🇳' },
  { code: 'ta-IN', name: 'Tamil', flag: '🇮🇳' },
  { code: 'te-IN', name: 'Telugu', flag: '🇮🇳' }
];

export const VOICES = [
  // ========== STANDARD VOICES ==========
  {
    id: 'man',
    name: 'Man (Default)',
    category: VOICE_CATEGORIES.STANDARD,
    gender: 'male',
    languages: ['en-US', 'en-GB', 'es-ES', 'fr-FR', 'de-DE', 'it-IT']
  },
  {
    id: 'woman',
    name: 'Woman (Default)',
    category: VOICE_CATEGORIES.STANDARD,
    gender: 'female',
    languages: ['en-US', 'en-GB', 'es-ES', 'fr-FR', 'de-DE', 'it-IT']
  },
  {
    id: 'alice',
    name: 'Alice',
    category: VOICE_CATEGORIES.STANDARD,
    gender: 'female',
    languages: ['en-US', 'en-GB', 'es-ES', 'fr-FR', 'de-DE', 'it-IT', 'pt-BR', 'pt-PT', 'da-DK', 'nl-NL', 'pl-PL', 'ru-RU', 'sv-SE', 'tr-TR']
  },

  // ========== AMAZON POLLY - ARABIC ==========
  {
    id: 'Polly.Zeina',
    name: 'Zeina (Arabic Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['arb'],
    recommended: true
  },
  {
    id: 'Polly.Hala',
    name: 'Hala (Arabic UAE Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['ar-AE']
  },
  {
    id: 'Polly.Zayd',
    name: 'Zayd (Arabic UAE Male)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'male',
    languages: ['ar-AE']
  },

  // ========== AMAZON POLLY - ENGLISH ==========
  {
    id: 'Polly.Joanna',
    name: 'Joanna (US Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['en-US'],
    recommended: true
  },
  {
    id: 'Polly.Matthew',
    name: 'Matthew (US Male)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'male',
    languages: ['en-US']
  },
  {
    id: 'Polly.Ivy',
    name: 'Ivy (US Child Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['en-US']
  },
  {
    id: 'Polly.Kendra',
    name: 'Kendra (US Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['en-US']
  },
  {
    id: 'Polly.Kimberly',
    name: 'Kimberly (US Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['en-US']
  },
  {
    id: 'Polly.Salli',
    name: 'Salli (US Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['en-US']
  },
  {
    id: 'Polly.Joey',
    name: 'Joey (US Male)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'male',
    languages: ['en-US']
  },
  {
    id: 'Polly.Justin',
    name: 'Justin (US Child Male)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'male',
    languages: ['en-US']
  },
  {
    id: 'Polly.Amy',
    name: 'Amy (UK Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['en-GB']
  },
  {
    id: 'Polly.Emma',
    name: 'Emma (UK Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['en-GB']
  },
  {
    id: 'Polly.Brian',
    name: 'Brian (UK Male)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'male',
    languages: ['en-GB']
  },
  {
    id: 'Polly.Nicole',
    name: 'Nicole (AU Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['en-AU']
  },
  {
    id: 'Polly.Russell',
    name: 'Russell (AU Male)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'male',
    languages: ['en-AU']
  },
  {
    id: 'Polly.Raveena',
    name: 'Raveena (IN Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['en-IN']
  },

  // ========== AMAZON POLLY - FRENCH ==========
  {
    id: 'Polly.Celine',
    name: 'Céline (FR Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['fr-FR']
  },
  {
    id: 'Polly.Mathieu',
    name: 'Mathieu (FR Male)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'male',
    languages: ['fr-FR']
  },
  {
    id: 'Polly.Lea',
    name: 'Léa (FR Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['fr-FR']
  },
  {
    id: 'Polly.Chantal',
    name: 'Chantal (CA Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['fr-CA']
  },

  // ========== AMAZON POLLY - GERMAN ==========
  {
    id: 'Polly.Marlene',
    name: 'Marlene (DE Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['de-DE']
  },
  {
    id: 'Polly.Hans',
    name: 'Hans (DE Male)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'male',
    languages: ['de-DE']
  },
  {
    id: 'Polly.Vicki',
    name: 'Vicki (DE Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['de-DE']
  },

  // ========== AMAZON POLLY - SPANISH ==========
  {
    id: 'Polly.Conchita',
    name: 'Conchita (ES Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['es-ES']
  },
  {
    id: 'Polly.Enrique',
    name: 'Enrique (ES Male)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'male',
    languages: ['es-ES']
  },
  {
    id: 'Polly.Lucia',
    name: 'Lucía (ES Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['es-ES']
  },
  {
    id: 'Polly.Mia',
    name: 'Mia (MX Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['es-MX']
  },
  {
    id: 'Polly.Miguel',
    name: 'Miguel (US Male)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'male',
    languages: ['es-US']
  },
  {
    id: 'Polly.Penelope',
    name: 'Penélope (US Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['es-US']
  },
  {
    id: 'Polly.Lupe',
    name: 'Lupe (US Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['es-US']
  },

  // ========== AMAZON POLLY - OTHER LANGUAGES ==========
  {
    id: 'Polly.Giorgio',
    name: 'Giorgio (IT Male)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'male',
    languages: ['it-IT']
  },
  {
    id: 'Polly.Carla',
    name: 'Carla (IT Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['it-IT']
  },
  {
    id: 'Polly.Bianca',
    name: 'Bianca (IT Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['it-IT']
  },
  {
    id: 'Polly.Vitoria',
    name: 'Vitória (BR Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['pt-BR']
  },
  {
    id: 'Polly.Ricardo',
    name: 'Ricardo (BR Male)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'male',
    languages: ['pt-BR']
  },
  {
    id: 'Polly.Camila',
    name: 'Camila (BR Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['pt-BR']
  },
  {
    id: 'Polly.Ines',
    name: 'Inês (PT Female)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'female',
    languages: ['pt-PT']
  },
  {
    id: 'Polly.Cristiano',
    name: 'Cristiano (PT Male)',
    category: VOICE_CATEGORIES.POLLY,
    gender: 'male',
    languages: ['pt-PT']
  },

  // ========== GOOGLE VOICES - ARABIC ==========
  {
    id: 'Google.ar-XA-Wavenet-A',
    name: 'Wavenet A (Arabic Female)',
    category: VOICE_CATEGORIES.GOOGLE,
    gender: 'female',
    languages: ['ar-XA', 'arb', 'ar-AE', 'ar-SA']
  },
  {
    id: 'Google.ar-XA-Wavenet-B',
    name: 'Wavenet B (Arabic Male)',
    category: VOICE_CATEGORIES.GOOGLE,
    gender: 'male',
    languages: ['ar-XA', 'arb', 'ar-AE', 'ar-SA']
  },
  {
    id: 'Google.ar-XA-Wavenet-C',
    name: 'Wavenet C (Arabic Male)',
    category: VOICE_CATEGORIES.GOOGLE,
    gender: 'male',
    languages: ['ar-XA', 'arb', 'ar-AE', 'ar-SA']
  },
  {
    id: 'Google.ar-XA-Wavenet-D',
    name: 'Wavenet D (Arabic Female)',
    category: VOICE_CATEGORIES.GOOGLE,
    gender: 'female',
    languages: ['ar-XA', 'arb', 'ar-AE', 'ar-SA']
  },

  // ========== GOOGLE VOICES - ENGLISH ==========
  {
    id: 'Google.en-US-Wavenet-A',
    name: 'Wavenet A (US Male)',
    category: VOICE_CATEGORIES.GOOGLE,
    gender: 'male',
    languages: ['en-US']
  },
  {
    id: 'Google.en-US-Wavenet-B',
    name: 'Wavenet B (US Male)',
    category: VOICE_CATEGORIES.GOOGLE,
    gender: 'male',
    languages: ['en-US']
  },
  {
    id: 'Google.en-US-Wavenet-C',
    name: 'Wavenet C (US Female)',
    category: VOICE_CATEGORIES.GOOGLE,
    gender: 'female',
    languages: ['en-US']
  },
  {
    id: 'Google.en-US-Wavenet-D',
    name: 'Wavenet D (US Male)',
    category: VOICE_CATEGORIES.GOOGLE,
    gender: 'male',
    languages: ['en-US']
  },
  {
    id: 'Google.en-US-Wavenet-E',
    name: 'Wavenet E (US Female)',
    category: VOICE_CATEGORIES.GOOGLE,
    gender: 'female',
    languages: ['en-US']
  },
  {
    id: 'Google.en-US-Wavenet-F',
    name: 'Wavenet F (US Female)',
    category: VOICE_CATEGORIES.GOOGLE,
    gender: 'female',
    languages: ['en-US']
  },
  {
    id: 'Google.en-GB-Wavenet-A',
    name: 'Wavenet A (UK Female)',
    category: VOICE_CATEGORIES.GOOGLE,
    gender: 'female',
    languages: ['en-GB']
  },
  {
    id: 'Google.en-GB-Wavenet-B',
    name: 'Wavenet B (UK Male)',
    category: VOICE_CATEGORIES.GOOGLE,
    gender: 'male',
    languages: ['en-GB']
  },
  {
    id: 'Google.en-GB-Wavenet-C',
    name: 'Wavenet C (UK Female)',
    category: VOICE_CATEGORIES.GOOGLE,
    gender: 'female',
    languages: ['en-GB']
  },
  {
    id: 'Google.en-GB-Wavenet-D',
    name: 'Wavenet D (UK Male)',
    category: VOICE_CATEGORIES.GOOGLE,
    gender: 'male',
    languages: ['en-GB']
  }
];

/**
 * Get voices for a specific language
 */
export function getVoicesForLanguage(languageCode) {
  return VOICES.filter(voice =>
    voice.languages.includes(languageCode) ||
    voice.languages.includes(languageCode.split('-')[0])
  );
}

/**
 * Get recommended voice for a language
 */
export function getRecommendedVoice(languageCode) {
  const voices = getVoicesForLanguage(languageCode);
  const recommended = voices.find(v => v.recommended);
  return recommended || voices[0] || VOICES[0];
}

/**
 * Get voice by ID
 */
export function getVoiceById(voiceId) {
  return VOICES.find(v => v.id === voiceId);
}

/**
 * Get language by code
 */
export function getLanguageByCode(code) {
  return LANGUAGES.find(l => l.code === code);
}
