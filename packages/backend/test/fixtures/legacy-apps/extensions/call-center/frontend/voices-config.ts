/**
 * Voice and Language configuration for Call Center
 * Complete list of Twilio supported voices
 */

export interface Language {
  code: string;
  name: string;
  flag: string;
}

export interface Voice {
  id: string;
  name: string;
  category: string;
  gender: string;
  languages: string[];
  recommended?: boolean;
}

export const LANGUAGES: Language[] = [
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

  // Other
  { code: 'hi-IN', name: 'Hindi', flag: '🇮🇳' },
  { code: 'ru-RU', name: 'Russian', flag: '🇷🇺' },
  { code: 'tr-TR', name: 'Turkish', flag: '🇹🇷' }
];

export const VOICES: Voice[] = [
  // ========== STANDARD VOICES ==========
  {
    id: 'man',
    name: 'Man (Default)',
    category: 'Standard',
    gender: 'male',
    languages: ['en-US', 'en-GB', 'es-ES', 'fr-FR', 'de-DE', 'it-IT']
  },
  {
    id: 'woman',
    name: 'Woman (Default)',
    category: 'Standard',
    gender: 'female',
    languages: ['en-US', 'en-GB', 'es-ES', 'fr-FR', 'de-DE', 'it-IT']
  },
  {
    id: 'alice',
    name: 'Alice',
    category: 'Standard',
    gender: 'female',
    languages: ['en-US', 'en-GB', 'es-ES', 'fr-FR', 'de-DE', 'it-IT', 'pt-BR', 'pt-PT', 'ru-RU', 'tr-TR']
  },

  // ========== AMAZON POLLY - ARABIC ==========
  {
    id: 'Polly.Zeina',
    name: 'Zeina (Arabic Female)',
    category: 'Polly',
    gender: 'female',
    languages: ['arb', 'ar-AE', 'ar-SA'],
    recommended: true
  },
  {
    id: 'Polly.Hala',
    name: 'Hala (Arabic UAE Female)',
    category: 'Polly',
    gender: 'female',
    languages: ['ar-AE']
  },
  {
    id: 'Polly.Zayd',
    name: 'Zayd (Arabic UAE Male)',
    category: 'Polly',
    gender: 'male',
    languages: ['ar-AE']
  },

  // ========== AMAZON POLLY - ENGLISH ==========
  {
    id: 'Polly.Joanna',
    name: 'Joanna (US Female)',
    category: 'Polly',
    gender: 'female',
    languages: ['en-US'],
    recommended: true
  },
  {
    id: 'Polly.Matthew',
    name: 'Matthew (US Male)',
    category: 'Polly',
    gender: 'male',
    languages: ['en-US']
  },
  {
    id: 'Polly.Kendra',
    name: 'Kendra (US Female)',
    category: 'Polly',
    gender: 'female',
    languages: ['en-US']
  },
  {
    id: 'Polly.Joey',
    name: 'Joey (US Male)',
    category: 'Polly',
    gender: 'male',
    languages: ['en-US']
  },
  {
    id: 'Polly.Amy',
    name: 'Amy (UK Female)',
    category: 'Polly',
    gender: 'female',
    languages: ['en-GB']
  },
  {
    id: 'Polly.Brian',
    name: 'Brian (UK Male)',
    category: 'Polly',
    gender: 'male',
    languages: ['en-GB']
  },
  {
    id: 'Polly.Nicole',
    name: 'Nicole (AU Female)',
    category: 'Polly',
    gender: 'female',
    languages: ['en-AU']
  },
  {
    id: 'Polly.Russell',
    name: 'Russell (AU Male)',
    category: 'Polly',
    gender: 'male',
    languages: ['en-AU']
  },
  {
    id: 'Polly.Raveena',
    name: 'Raveena (IN Female)',
    category: 'Polly',
    gender: 'female',
    languages: ['en-IN']
  },

  // ========== AMAZON POLLY - FRENCH ==========
  {
    id: 'Polly.Celine',
    name: 'Céline (FR Female)',
    category: 'Polly',
    gender: 'female',
    languages: ['fr-FR']
  },
  {
    id: 'Polly.Mathieu',
    name: 'Mathieu (FR Male)',
    category: 'Polly',
    gender: 'male',
    languages: ['fr-FR']
  },
  {
    id: 'Polly.Chantal',
    name: 'Chantal (CA Female)',
    category: 'Polly',
    gender: 'female',
    languages: ['fr-CA']
  },

  // ========== AMAZON POLLY - GERMAN ==========
  {
    id: 'Polly.Marlene',
    name: 'Marlene (DE Female)',
    category: 'Polly',
    gender: 'female',
    languages: ['de-DE']
  },
  {
    id: 'Polly.Hans',
    name: 'Hans (DE Male)',
    category: 'Polly',
    gender: 'male',
    languages: ['de-DE']
  },

  // ========== AMAZON POLLY - SPANISH ==========
  {
    id: 'Polly.Conchita',
    name: 'Conchita (ES Female)',
    category: 'Polly',
    gender: 'female',
    languages: ['es-ES']
  },
  {
    id: 'Polly.Enrique',
    name: 'Enrique (ES Male)',
    category: 'Polly',
    gender: 'male',
    languages: ['es-ES']
  },
  {
    id: 'Polly.Mia',
    name: 'Mia (MX Female)',
    category: 'Polly',
    gender: 'female',
    languages: ['es-MX']
  },
  {
    id: 'Polly.Miguel',
    name: 'Miguel (US Male)',
    category: 'Polly',
    gender: 'male',
    languages: ['es-US']
  },

  // ========== AMAZON POLLY - OTHER ==========
  {
    id: 'Polly.Giorgio',
    name: 'Giorgio (IT Male)',
    category: 'Polly',
    gender: 'male',
    languages: ['it-IT']
  },
  {
    id: 'Polly.Carla',
    name: 'Carla (IT Female)',
    category: 'Polly',
    gender: 'female',
    languages: ['it-IT']
  },
  {
    id: 'Polly.Vitoria',
    name: 'Vitória (BR Female)',
    category: 'Polly',
    gender: 'female',
    languages: ['pt-BR']
  },
  {
    id: 'Polly.Ricardo',
    name: 'Ricardo (BR Male)',
    category: 'Polly',
    gender: 'male',
    languages: ['pt-BR']
  },

  // ========== GOOGLE VOICES - ARABIC ==========
  {
    id: 'Google.ar-XA-Wavenet-A',
    name: 'Google Wavenet A (Arabic Female)',
    category: 'Google',
    gender: 'female',
    languages: ['arb', 'ar-AE', 'ar-SA']
  },
  {
    id: 'Google.ar-XA-Wavenet-B',
    name: 'Google Wavenet B (Arabic Male)',
    category: 'Google',
    gender: 'male',
    languages: ['arb', 'ar-AE', 'ar-SA']
  },
  {
    id: 'Google.ar-XA-Wavenet-C',
    name: 'Google Wavenet C (Arabic Male)',
    category: 'Google',
    gender: 'male',
    languages: ['arb', 'ar-AE', 'ar-SA']
  },
  {
    id: 'Google.ar-XA-Wavenet-D',
    name: 'Google Wavenet D (Arabic Female)',
    category: 'Google',
    gender: 'female',
    languages: ['arb', 'ar-AE', 'ar-SA']
  },

  // ========== GOOGLE VOICES - ENGLISH ==========
  {
    id: 'Google.en-US-Wavenet-A',
    name: 'Google Wavenet A (US Male)',
    category: 'Google',
    gender: 'male',
    languages: ['en-US']
  },
  {
    id: 'Google.en-US-Wavenet-C',
    name: 'Google Wavenet C (US Female)',
    category: 'Google',
    gender: 'female',
    languages: ['en-US']
  },
  {
    id: 'Google.en-US-Wavenet-D',
    name: 'Google Wavenet D (US Male)',
    category: 'Google',
    gender: 'male',
    languages: ['en-US']
  },
  {
    id: 'Google.en-GB-Wavenet-A',
    name: 'Google Wavenet A (UK Female)',
    category: 'Google',
    gender: 'female',
    languages: ['en-GB']
  },
  {
    id: 'Google.en-GB-Wavenet-B',
    name: 'Google Wavenet B (UK Male)',
    category: 'Google',
    gender: 'male',
    languages: ['en-GB']
  }
];

/**
 * Get voices compatible with a specific language
 */
export function getVoicesForLanguage(languageCode: string): Voice[] {
  return VOICES.filter(voice =>
    voice.languages.includes(languageCode) ||
    voice.languages.some(lang => lang.startsWith(languageCode.split('-')[0]))
  );
}

/**
 * Get recommended voice for a language (or first available)
 */
export function getRecommendedVoice(languageCode: string): Voice | undefined {
  const voices = getVoicesForLanguage(languageCode);
  return voices.find(v => v.recommended) || voices[0];
}

/**
 * Group voices by category
 */
export function groupVoicesByCategory(voices: Voice[]): Record<string, Voice[]> {
  const groups: Record<string, Voice[]> = {};
  voices.forEach(voice => {
    if (!groups[voice.category]) {
      groups[voice.category] = [];
    }
    groups[voice.category].push(voice);
  });
  return groups;
}
