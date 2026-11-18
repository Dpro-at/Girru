/**
 * STT (Speech-to-Text) Providers Configuration - TypeScript version for frontend
 */

export interface SttProvider {
  id: string;
  name: string;
  description: string;
  requiresApiKey: boolean;
  pricing: string;
  pricingDetails: string;
  supportedLanguages: number;
  features: string[];
  documentation: string;
}

export interface SttModel {
  id: string;
  name: string;
  speed?: string;
  quality?: string;
  pricing?: string;
}

export const STT_PROVIDERS: Record<string, SttProvider> = {
  openai: {
    id: 'openai',
    name: 'OpenAI Whisper',
    description: 'Industry-leading speech recognition from OpenAI',
    requiresApiKey: true,
    pricing: '$0.006 per minute',
    pricingDetails: 'Same price for all models and languages',
    supportedLanguages: 99,
    features: ['99+ languages', 'Timestamps', 'Word-level precision', 'Speaker detection'],
    documentation: 'https://platform.openai.com/docs/guides/speech-to-text'
  },

  google: {
    id: 'google',
    name: 'Google Cloud Speech-to-Text',
    description: 'Powerful speech recognition from Google Cloud',
    requiresApiKey: true,
    pricing: '$0.016 - $0.09 per minute',
    pricingDetails: 'Standard: $0.016/min, Enhanced: $0.04/min, Medical/Video: $0.09/min',
    supportedLanguages: 125,
    features: ['125+ languages', 'Real-time streaming', 'Speaker diarization', 'Punctuation'],
    documentation: 'https://cloud.google.com/speech-to-text/docs'
  },

  azure: {
    id: 'azure',
    name: 'Azure Speech-to-Text',
    description: 'Microsoft Azure speech recognition service',
    requiresApiKey: true,
    pricing: '$1 per audio hour',
    pricingDetails: 'Standard: $1/hour, Custom models available',
    supportedLanguages: 100,
    features: ['100+ languages', 'Custom models', 'Speaker recognition', 'Sentiment analysis'],
    documentation: 'https://azure.microsoft.com/en-us/products/ai-services/speech-to-text'
  },

  twilio: {
    id: 'twilio',
    name: 'Twilio (Google Speech)',
    description: 'Built-in speech recognition via Twilio',
    requiresApiKey: false,
    pricing: '$0.02 per minute',
    pricingDetails: 'Included in Twilio call pricing + $0.02/min for transcription',
    supportedLanguages: 119,
    features: ['119 languages', 'Real-time', 'Call recording transcription', 'Easy integration'],
    documentation: 'https://www.twilio.com/docs/voice/tutorials/how-to-gather-speech-input'
  },

  deepgram: {
    id: 'deepgram',
    name: 'Deepgram',
    description: 'Ultra-fast AI speech recognition',
    requiresApiKey: true,
    pricing: '$0.0043 per minute',
    pricingDetails: 'Nova-2: $0.0043/min, Enhanced: $0.0125/min, Whisper Cloud: $0.0048/min',
    supportedLanguages: 36,
    features: ['Fastest transcription', 'Real-time streaming', 'Custom vocabulary', 'Topic detection'],
    documentation: 'https://developers.deepgram.com/docs'
  },

  assemblyai: {
    id: 'assemblyai',
    name: 'AssemblyAI',
    description: 'Advanced AI transcription with understanding',
    requiresApiKey: true,
    pricing: '$0.00025 per second (~$0.015/min)',
    pricingDetails: 'Core: $0.015/min, Add-ons: $0.003-0.01/min each',
    supportedLanguages: 1,
    features: ['English only', 'Speaker labels', 'Chapter detection', 'Auto-highlights', 'Sentiment'],
    documentation: 'https://www.assemblyai.com/docs'
  }
};

/**
 * Get provider by ID
 */
export function getProvider(providerId: string): SttProvider | undefined {
  return STT_PROVIDERS[providerId];
}

/**
 * Get all providers as array
 */
export function getAllProviders(): SttProvider[] {
  return Object.values(STT_PROVIDERS);
}

/**
 * Get providers that require API keys
 */
export function getProvidersRequiringApiKey(): SttProvider[] {
  return Object.values(STT_PROVIDERS).filter(p => p.requiresApiKey);
}

/**
 * Check if provider requires API key
 */
export function providerRequiresApiKey(providerId: string): boolean {
  const provider = getProvider(providerId);
  return provider?.requiresApiKey || false;
}

/**
 * Get pricing comparison sorted by price
 */
export function getPricingComparison() {
  return Object.values(STT_PROVIDERS)
    .map(p => ({
      id: p.id,
      name: p.name,
      pricing: p.pricing,
      details: p.pricingDetails
    }))
    .sort((a, b) => {
      const priceA = parseFloat(a.pricing.match(/\$([\d.]+)/)?.[1] || '999');
      const priceB = parseFloat(b.pricing.match(/\$([\d.]+)/)?.[1] || '999');
      return priceA - priceB;
    });
}
