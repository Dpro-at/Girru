/**
 * TTS Providers Configuration - TypeScript version for frontend
 */

export interface TtsProvider {
  id: string;
  name: string;
  description: string;
  requiresApiKey: boolean;
  pricing: string;
  pricingDetails: string;
  supportedLanguages: number;
  totalVoices: number;
  features: string[];
  documentation: string;
}

export interface TtsVoice {
  id: string;
  name: string;
  gender: string;
  description?: string;
  accent?: string;
  language?: string;
  type?: string;
  style?: string;
}

export interface TtsModel {
  id: string;
  name: string;
  speed?: string;
  quality?: string;
  pricing?: string;
}

export const TTS_PROVIDERS: Record<string, TtsProvider> = {
  twilio: {
    id: 'twilio',
    name: 'Twilio (Polly + Google)',
    description: 'Built-in Twilio voices (Amazon Polly and Google)',
    requiresApiKey: false,
    pricing: 'Included in Twilio call pricing',
    pricingDetails: '$0.0140/min for voice calls',
    supportedLanguages: 25,
    totalVoices: 100,
    features: ['Real-time streaming', 'No additional setup', 'Multiple accents'],
    documentation: 'https://www.twilio.com/docs/voice/twiml/say'
  },

  openai: {
    id: 'openai',
    name: 'OpenAI TTS',
    description: 'High-quality natural voices powered by OpenAI',
    requiresApiKey: true,
    pricing: '$0.015 - $0.030 per 1000 characters',
    pricingDetails: 'tts-1: $0.015/1k chars, tts-1-hd: $0.030/1k chars',
    supportedLanguages: 50,
    totalVoices: 6,
    features: ['Ultra-natural', 'Multiple models', '50+ languages', 'Fast generation'],
    documentation: 'https://platform.openai.com/docs/guides/text-to-speech'
  },

  google: {
    id: 'google',
    name: 'Google Cloud TTS',
    description: 'Premium neural voices from Google Cloud',
    requiresApiKey: true,
    pricing: '$4 - $16 per 1 million characters',
    pricingDetails: 'Standard: $4/1M, WaveNet: $16/1M, Neural2: $16/1M',
    supportedLanguages: 50,
    totalVoices: 400,
    features: ['WaveNet technology', 'Neural2 voices', 'SSML support', 'Custom voices'],
    documentation: 'https://cloud.google.com/text-to-speech/docs'
  },

  azure: {
    id: 'azure',
    name: 'Azure Neural TTS',
    description: 'Microsoft Azure neural text-to-speech',
    requiresApiKey: true,
    pricing: '$15 per 1 million characters',
    pricingDetails: 'Neural voices: $15/1M chars, Standard: $4/1M chars',
    supportedLanguages: 140,
    totalVoices: 400,
    features: ['Neural voices', 'Custom Neural Voice', 'SSML support', 'Emotional styles'],
    documentation: 'https://azure.microsoft.com/en-us/products/ai-services/text-to-speech'
  },

  elevenlabs: {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    description: 'Ultra-realistic AI voices with emotion',
    requiresApiKey: true,
    pricing: 'Free: 10k chars/mo, Starter: $5/mo (30k chars)',
    pricingDetails: 'Free tier available, paid plans from $5/month',
    supportedLanguages: 29,
    totalVoices: 100,
    features: ['Voice cloning', 'Emotion control', 'Ultra-realistic', 'Voice library'],
    documentation: 'https://elevenlabs.io/docs/api-reference'
  }
};

export const OPENAI_VOICES: TtsVoice[] = [
  { id: 'alloy', name: 'Alloy', gender: 'neutral', description: 'Balanced and neutral' },
  { id: 'echo', name: 'Echo', gender: 'male', description: 'Warm and approachable' },
  { id: 'fable', name: 'Fable', gender: 'male', description: 'Expressive and dynamic' },
  { id: 'onyx', name: 'Onyx', gender: 'male', description: 'Deep and authoritative' },
  { id: 'nova', name: 'Nova', gender: 'female', description: 'Friendly and energetic' },
  { id: 'shimmer', name: 'Shimmer', gender: 'female', description: 'Soft and clear' }
];

export const OPENAI_MODELS: TtsModel[] = [
  { id: 'tts-1', name: 'TTS-1 (Standard)', speed: 'Fast', quality: 'Good' },
  { id: 'tts-1-hd', name: 'TTS-1-HD (High Quality)', speed: 'Normal', quality: 'Excellent' }
];

export const ELEVENLABS_POPULAR_VOICES: TtsVoice[] = [
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella', gender: 'female', accent: 'American' },
  { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni', gender: 'male', accent: 'American' },
  { id: 'MF3mGyEYCl7XYWbV9V6O', name: 'Elli', gender: 'female', accent: 'American' },
  { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh', gender: 'male', accent: 'American' }
];

/**
 * Get provider by ID
 */
export function getProvider(providerId: string): TtsProvider | undefined {
  return TTS_PROVIDERS[providerId];
}

/**
 * Get all providers as array
 */
export function getAllProviders(): TtsProvider[] {
  return Object.values(TTS_PROVIDERS);
}

/**
 * Get providers that require API keys
 */
export function getProvidersRequiringApiKey(): TtsProvider[] {
  return Object.values(TTS_PROVIDERS).filter(p => p.requiresApiKey);
}

/**
 * Check if provider requires API key
 */
export function providerRequiresApiKey(providerId: string): boolean {
  const provider = getProvider(providerId);
  return provider?.requiresApiKey || false;
}

/**
 * Get voices for a specific provider
 */
export function getVoicesForProvider(providerId: string): TtsVoice[] {
  switch (providerId) {
    case 'openai':
      return OPENAI_VOICES;
    case 'elevenlabs':
      return ELEVENLABS_POPULAR_VOICES;
    case 'twilio':
      // Return from existing voices-config.ts
      return [];
    default:
      return [];
  }
}
