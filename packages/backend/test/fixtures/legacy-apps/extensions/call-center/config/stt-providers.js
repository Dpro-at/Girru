/**
 * STT (Speech-to-Text) Providers Configuration
 * Complete list of supported Speech-to-Text providers
 */

const STT_PROVIDERS = {
  // ========== OPENAI WHISPER ==========
  openai: {
    id: 'openai',
    name: 'OpenAI Whisper',
    description: 'Industry-leading speech recognition from OpenAI',
    requiresApiKey: true,
    pricing: '$0.006 per minute',
    pricingDetails: 'Same price for all models and languages',
    supportedLanguages: 99,
    features: ['99+ languages', 'Timestamps', 'Word-level precision', 'Speaker detection'],
    documentation: 'https://platform.openai.com/docs/guides/speech-to-text',
    models: [
      { id: 'whisper-1', name: 'Whisper-1', speed: 'Fast', quality: 'Excellent' }
    ],
    formats: ['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'wav', 'webm'],
    maxFileSize: '25 MB'
  },

  // ========== GOOGLE CLOUD STT ==========
  google: {
    id: 'google',
    name: 'Google Cloud Speech-to-Text',
    description: 'Powerful speech recognition from Google Cloud',
    requiresApiKey: true,
    pricing: '$0.016 - $0.09 per minute',
    pricingDetails: 'Standard: $0.016/min, Enhanced: $0.04/min, Medical/Video: $0.09/min',
    supportedLanguages: 125,
    features: ['125+ languages', 'Real-time streaming', 'Speaker diarization', 'Punctuation'],
    documentation: 'https://cloud.google.com/speech-to-text/docs',
    models: [
      { id: 'default', name: 'Standard', pricing: '$0.016/min', quality: 'Good' },
      { id: 'command_and_search', name: 'Command & Search', pricing: '$0.016/min', quality: 'Good' },
      { id: 'phone_call', name: 'Phone Call Enhanced', pricing: '$0.04/min', quality: 'Excellent' },
      { id: 'video', name: 'Video', pricing: '$0.09/min', quality: 'Premium' },
      { id: 'medical_dictation', name: 'Medical Dictation', pricing: '$0.09/min', quality: 'Premium' }
    ],
    formats: ['LINEAR16', 'FLAC', 'MULAW', 'AMR', 'AMR_WB', 'OGG_OPUS', 'WEBM_OPUS'],
    maxAudioLength: '480 minutes'
  },

  // ========== AZURE COGNITIVE SERVICES STT ==========
  azure: {
    id: 'azure',
    name: 'Azure Speech-to-Text',
    description: 'Microsoft Azure speech recognition service',
    requiresApiKey: true,
    pricing: '$1 per audio hour',
    pricingDetails: 'Standard: $1/hour, Custom models available',
    supportedLanguages: 100,
    features: ['100+ languages', 'Custom models', 'Speaker recognition', 'Sentiment analysis'],
    documentation: 'https://azure.microsoft.com/en-us/products/ai-services/speech-to-text',
    models: [
      { id: 'standard', name: 'Standard', pricing: '$1/hour', quality: 'Good' },
      { id: 'neural', name: 'Neural', pricing: '$1/hour', quality: 'Excellent' },
      { id: 'custom', name: 'Custom Speech', pricing: 'Custom pricing', quality: 'Custom' }
    ],
    formats: ['wav', 'mp3', 'ogg', 'webm'],
    features_advanced: ['Custom vocabulary', 'Profanity filter', 'Diarization', 'Word-level timestamps']
  },

  // ========== TWILIO (Google Speech) ==========
  twilio: {
    id: 'twilio',
    name: 'Twilio (Google Speech)',
    description: 'Built-in speech recognition via Twilio',
    requiresApiKey: false,
    pricing: '$0.02 per minute',
    pricingDetails: 'Included in Twilio call pricing + $0.02/min for transcription',
    supportedLanguages: 119,
    features: ['119 languages', 'Real-time', 'Call recording transcription', 'Easy integration'],
    documentation: 'https://www.twilio.com/docs/voice/tutorials/how-to-gather-speech-input',
    formats: ['Automatic from call'],
    maxDuration: 'Unlimited'
  },

  // ========== DEEPGRAM ==========
  deepgram: {
    id: 'deepgram',
    name: 'Deepgram',
    description: 'Ultra-fast AI speech recognition',
    requiresApiKey: true,
    pricing: '$0.0043 per minute',
    pricingDetails: 'Nova-2: $0.0043/min, Enhanced: $0.0125/min, Whisper Cloud: $0.0048/min',
    supportedLanguages: 36,
    features: ['Fastest transcription', 'Real-time streaming', 'Custom vocabulary', 'Topic detection'],
    documentation: 'https://developers.deepgram.com/docs',
    models: [
      { id: 'nova-2', name: 'Nova-2 (Latest)', pricing: '$0.0043/min', quality: 'Excellent' },
      { id: 'enhanced', name: 'Enhanced', pricing: '$0.0125/min', quality: 'Premium' },
      { id: 'whisper-cloud', name: 'Whisper Cloud', pricing: '$0.0048/min', quality: 'Excellent' }
    ],
    formats: ['wav', 'mp3', 'flac', 'opus', 'ogg', 'webm'],
    features_advanced: ['Live transcription', 'Language detection', 'Topic detection', 'Sentiment analysis']
  },

  // ========== ASSEMBLY AI ==========
  assemblyai: {
    id: 'assemblyai',
    name: 'AssemblyAI',
    description: 'Advanced AI transcription with understanding',
    requiresApiKey: true,
    pricing: '$0.00025 per second (~$0.015/min)',
    pricingDetails: 'Core: $0.015/min, Add-ons: $0.003-0.01/min each',
    supportedLanguages: 1,
    features: ['English only', 'Speaker labels', 'Chapter detection', 'Auto-highlights', 'Sentiment'],
    documentation: 'https://www.assemblyai.com/docs',
    models: [
      { id: 'best', name: 'Best (Recommended)', pricing: '$0.015/min', quality: 'Excellent' },
      { id: 'nano', name: 'Nano (Fast)', pricing: '$0.005/min', quality: 'Good' }
    ],
    formats: ['Most audio/video formats'],
    addons: [
      { id: 'speaker_labels', name: 'Speaker Labels', pricing: '$0.003/min' },
      { id: 'auto_chapters', name: 'Auto Chapters', pricing: '$0.003/min' },
      { id: 'sentiment_analysis', name: 'Sentiment Analysis', pricing: '$0.003/min' },
      { id: 'entity_detection', name: 'Entity Detection', pricing: '$0.003/min' },
      { id: 'content_safety', name: 'Content Moderation', pricing: '$0.01/min' }
    ]
  }
};

/**
 * Get provider by ID
 */
function getProvider(providerId) {
  return STT_PROVIDERS[providerId];
}

/**
 * Get all providers
 */
function getAllProviders() {
  return Object.values(STT_PROVIDERS);
}

/**
 * Get providers that require API keys
 */
function getProvidersRequiringApiKey() {
  return Object.values(STT_PROVIDERS).filter(p => p.requiresApiKey);
}

/**
 * Get provider pricing comparison
 */
function getProviderPricingComparison() {
  return Object.values(STT_PROVIDERS)
    .map(p => ({
      id: p.id,
      name: p.name,
      pricing: p.pricing,
      details: p.pricingDetails
    }))
    .sort((a, b) => {
      // Extract price per minute for sorting
      const priceA = parseFloat(a.pricing.match(/\$([\d.]+)/)?.[1] || '999');
      const priceB = parseFloat(b.pricing.match(/\$([\d.]+)/)?.[1] || '999');
      return priceA - priceB;
    });
}

module.exports = {
  STT_PROVIDERS,
  getProvider,
  getAllProviders,
  getProvidersRequiringApiKey,
  getProviderPricingComparison
};
