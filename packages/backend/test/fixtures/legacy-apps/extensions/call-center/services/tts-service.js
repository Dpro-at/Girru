/**
 * TTS Service - Multi-Provider Text-to-Speech
 * Handles TTS generation for all supported providers
 */

const fs = require('fs');
const path = require('path');
const { getProvider } = require('../config/tts-providers.js');

class TtsService {
  /**
   * Generate speech from text using specified provider
   * @param {Object} options
   * @param {string} options.text - Text to convert to speech
   * @param {string} options.provider - Provider ID (twilio, openai, google, azure, elevenlabs)
   * @param {string} options.voice - Voice ID
   * @param {string} options.language - Language code
   * @param {string} options.apiKey - API key (if required)
   * @param {string} options.model - Model ID (optional, provider-specific)
   * @returns {Promise<Buffer>} Audio buffer
   */
  async generateSpeech(options) {
    const { text, provider, voice, language, apiKey, model } = options;

    // Validate provider
    const providerConfig = getProvider(provider);
    if (!providerConfig) {
      throw new Error(`Unsupported TTS provider: ${provider}`);
    }

    // Check API key requirement
    if (providerConfig.requiresApiKey && !apiKey) {
      throw new Error(`API key required for provider: ${provider}`);
    }

    // Route to appropriate provider
    switch (provider) {
      case 'openai':
        return await this.generateOpenAI({ text, voice, apiKey, model: model || 'tts-1' });

      case 'google':
        return await this.generateGoogleCloud({ text, voice, language, apiKey });

      case 'azure':
        return await this.generateAzure({ text, voice, language, apiKey });

      case 'elevenlabs':
        return await this.generateElevenLabs({ text, voice, apiKey, model });

      case 'twilio':
        // Twilio TTS is handled via TwiML, not direct API
        throw new Error('Twilio TTS is handled via TwiML in call flow');

      default:
        throw new Error(`Provider not implemented: ${provider}`);
    }
  }

  /**
   * Generate speech using OpenAI TTS
   */
  async generateOpenAI({ text, voice, apiKey, model }) {
    try {
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: model || 'tts-1',
          voice: voice || 'alloy',
          input: text,
          response_format: 'mp3'
        })
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(`OpenAI TTS error: ${error.error?.message || response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      throw new Error(`OpenAI TTS failed: ${error.message}`);
    }
  }

  /**
   * Generate speech using Google Cloud TTS
   */
  async generateGoogleCloud({ text, voice, language, apiKey }) {
    try {
      const response = await fetch(
        `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            input: { text },
            voice: {
              languageCode: language || 'en-US',
              name: voice || 'en-US-Neural2-A'
            },
            audioConfig: {
              audioEncoding: 'MP3',
              speakingRate: 1.0,
              pitch: 0.0
            }
          })
        }
      );

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(`Google Cloud TTS error: ${error.error?.message || response.statusText}`);
      }

      const data = await response.json();

      // Google returns base64 encoded audio
      return Buffer.from(data.audioContent, 'base64');
    } catch (error) {
      throw new Error(`Google Cloud TTS failed: ${error.message}`);
    }
  }

  /**
   * Generate speech using Azure Cognitive Services
   */
  async generateAzure({ text, voice, language, apiKey }) {
    try {
      // Extract region from API key format or use default
      const region = 'eastus'; // Should be configurable

      const ssml = `
        <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${language || 'en-US'}">
          <voice name="${voice || 'en-US-JennyNeural'}">
            ${text}
          </voice>
        </speak>
      `;

      const response = await fetch(
        `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
        {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': apiKey,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3'
          },
          body: ssml
        }
      );

      if (!response.ok) {
        throw new Error(`Azure TTS error: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      throw new Error(`Azure TTS failed: ${error.message}`);
    }
  }

  /**
   * Generate speech using ElevenLabs
   */
  async generateElevenLabs({ text, voice, apiKey, model }) {
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voice || 'EXAVITQu4vr4xnSDxMaL'}`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            text,
            model_id: model || 'eleven_monolingual_v1',
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75
            }
          })
        }
      );

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(`ElevenLabs TTS error: ${error.detail?.message || response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      throw new Error(`ElevenLabs TTS failed: ${error.message}`);
    }
  }

  /**
   * Get supported voices for a provider
   */
  async getProviderVoices(provider, apiKey) {
    switch (provider) {
      case 'openai':
        // OpenAI has fixed voices
        return [
          { id: 'alloy', name: 'Alloy' },
          { id: 'echo', name: 'Echo' },
          { id: 'fable', name: 'Fable' },
          { id: 'onyx', name: 'Onyx' },
          { id: 'nova', name: 'Nova' },
          { id: 'shimmer', name: 'Shimmer' }
        ];

      case 'elevenlabs':
        // Fetch available voices from ElevenLabs API
        try {
          const response = await fetch('https://api.elevenlabs.io/v1/voices', {
            headers: { 'xi-api-key': apiKey }
          });

          if (!response.ok) return [];

          const data = await response.json();
          return data.voices.map(v => ({
            id: v.voice_id,
            name: v.name,
            category: v.category
          }));
        } catch (error) {
          console.error('[TTS Service] Failed to fetch ElevenLabs voices:', error);
          return [];
        }

      case 'google':
      case 'azure':
        // These providers have too many voices to fetch dynamically
        // Return empty array, use config files
        return [];

      default:
        return [];
    }
  }

  /**
   * Test provider connection with sample text
   */
  async testProvider({ provider, apiKey, voice, language }) {
    try {
      const testText = language?.startsWith('ar')
        ? 'مرحباً، هذا اختبار للصوت'
        : 'Hello, this is a test of the voice';

      const audio = await this.generateSpeech({
        text: testText,
        provider,
        voice,
        language,
        apiKey
      });

      return {
        success: true,
        audioSize: audio.length,
        format: 'mp3'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = new TtsService();
