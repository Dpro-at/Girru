/**
 * TTS Providers Configuration
 * Complete list of supported Text-to-Speech providers
 */

const TTS_PROVIDERS = {
  // ========== TWILIO (Amazon Polly + Google) ==========
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

  // ========== OPENAI TTS ==========
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
    documentation: 'https://platform.openai.com/docs/guides/text-to-speech',
    voices: [
      { id: 'alloy', name: 'Alloy', gender: 'neutral', description: 'Balanced and neutral' },
      { id: 'echo', name: 'Echo', gender: 'male', description: 'Warm and approachable' },
      { id: 'fable', name: 'Fable', gender: 'male', description: 'Expressive and dynamic' },
      { id: 'onyx', name: 'Onyx', gender: 'male', description: 'Deep and authoritative' },
      { id: 'nova', name: 'Nova', gender: 'female', description: 'Friendly and energetic' },
      { id: 'shimmer', name: 'Shimmer', gender: 'female', description: 'Soft and clear' }
    ],
    models: [
      { id: 'tts-1', name: 'TTS-1 (Standard)', speed: 'Fast', quality: 'Good' },
      { id: 'tts-1-hd', name: 'TTS-1-HD (High Quality)', speed: 'Normal', quality: 'Excellent' }
    ]
  },

  // ========== GOOGLE CLOUD TTS ==========
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
    documentation: 'https://cloud.google.com/text-to-speech/docs',
    voiceTypes: [
      { id: 'standard', name: 'Standard', quality: 'Good', pricing: '$4/1M chars' },
      { id: 'wavenet', name: 'WaveNet', quality: 'Premium', pricing: '$16/1M chars' },
      { id: 'neural2', name: 'Neural2', quality: 'Excellent', pricing: '$16/1M chars' },
      { id: 'studio', name: 'Studio', quality: 'Ultra-Premium', pricing: '$160/1M chars' }
    ],
    popularVoices: [
      { id: 'en-US-Neural2-A', language: 'en-US', gender: 'male', type: 'neural2' },
      { id: 'en-US-Neural2-C', language: 'en-US', gender: 'female', type: 'neural2' },
      { id: 'ar-XA-Wavenet-A', language: 'ar-XA', gender: 'female', type: 'wavenet' },
      { id: 'ar-XA-Wavenet-B', language: 'ar-XA', gender: 'male', type: 'wavenet' }
    ]
  },

  // ========== AZURE COGNITIVE SERVICES ==========
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
    documentation: 'https://azure.microsoft.com/en-us/products/ai-services/text-to-speech',
    popularVoices: [
      { id: 'en-US-JennyNeural', language: 'en-US', gender: 'female', style: 'General' },
      { id: 'en-US-GuyNeural', language: 'en-US', gender: 'male', style: 'General' },
      { id: 'ar-SA-ZariyahNeural', language: 'ar-SA', gender: 'female', style: 'General' },
      { id: 'ar-SA-HamedNeural', language: 'ar-SA', gender: 'male', style: 'General' }
    ],
    styles: ['General', 'Newscast', 'CustomerService', 'Chat', 'Cheerful', 'Sad', 'Angry']
  },

  // ========== ELEVENLABS ==========
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
    documentation: 'https://elevenlabs.io/docs/api-reference',
    popularVoices: [
      { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella', gender: 'female', accent: 'American' },
      { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni', gender: 'male', accent: 'American' },
      { id: 'MF3mGyEYCl7XYWbV9V6O', name: 'Elli', gender: 'female', accent: 'American' },
      { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh', gender: 'male', accent: 'American' }
    ],
    plans: [
      { id: 'free', name: 'Free', chars: '10,000/month', price: '$0' },
      { id: 'starter', name: 'Starter', chars: '30,000/month', price: '$5' },
      { id: 'creator', name: 'Creator', chars: '100,000/month', price: '$22' },
      { id: 'pro', name: 'Pro', chars: '500,000/month', price: '$99' }
    ]
  }
};

/**
 * Get provider by ID
 */
function getProvider(providerId) {
  return TTS_PROVIDERS[providerId];
}

/**
 * Get all providers
 */
function getAllProviders() {
  return Object.values(TTS_PROVIDERS);
}

/**
 * Get providers that require API keys
 */
function getProvidersRequiringApiKey() {
  return Object.values(TTS_PROVIDERS).filter(p => p.requiresApiKey);
}

/**
 * Get provider pricing comparison
 */
function getProviderPricingComparison() {
  return Object.values(TTS_PROVIDERS).map(p => ({
    id: p.id,
    name: p.name,
    pricing: p.pricing,
    details: p.pricingDetails
  }));
}

module.exports = {
  TTS_PROVIDERS,
  getProvider,
  getAllProviders,
  getProvidersRequiringApiKey,
  getProviderPricingComparison
};
