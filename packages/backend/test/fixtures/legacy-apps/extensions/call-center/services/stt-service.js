/**
 * STT Service - Multi-Provider Speech-to-Text
 * Handles transcription for all supported providers
 */

const FormData = require('form-data');
const { getProvider } = require('../config/stt-providers.js');

class SttService {
  /**
   * Transcribe audio to text using specified provider
   * @param {Object} options
   * @param {Buffer} options.audio - Uploaded audio bytes (local paths are never accepted)
   * @param {string} options.provider - Provider ID (openai, google, azure, twilio, deepgram, assemblyai)
   * @param {string} options.language - Language code (optional)
   * @param {string} options.apiKey - API key (if required)
   * @param {Object} options.features - Additional features (timestamps, diarization, etc.)
   * @returns {Promise<Object>} Transcription result
   */
  async transcribe(options) {
    const { audio, provider, language, apiKey, features = {} } = options;

    // Validate provider
    const providerConfig = getProvider(provider);
    if (!providerConfig) {
      throw new Error(`Unsupported STT provider: ${provider}`);
    }

    // Check API key requirement
    if (providerConfig.requiresApiKey && !apiKey) {
      throw new Error(`API key required for provider: ${provider}`);
    }

    // The upload route supplies bytes. Never interpret caller input as a local file path.
    if (!Buffer.isBuffer(audio) || audio.length === 0 || audio.length > 25 * 1024 * 1024) {
      throw new TypeError('Audio must be uploaded bytes between 1 byte and 25 MiB');
    }
    const audioBuffer = Buffer.from(audio);

    // Route to appropriate provider
    switch (provider) {
      case 'openai':
        return await this.transcribeOpenAI({ audioBuffer, language, apiKey, features });

      case 'google':
        return await this.transcribeGoogleCloud({ audioBuffer, language, apiKey, features });

      case 'azure':
        return await this.transcribeAzure({ audioBuffer, language, apiKey, features });

      case 'deepgram':
        return await this.transcribeDeepgram({ audioBuffer, language, apiKey, features });

      case 'assemblyai':
        return await this.transcribeAssemblyAI({ audioBuffer, language, apiKey, features });

      case 'twilio':
        // Twilio transcription is handled via recording callbacks
        throw new Error('Twilio STT is handled via recording callbacks');

      default:
        throw new Error(`Provider not implemented: ${provider}`);
    }
  }

  /**
   * Transcribe using OpenAI Whisper
   */
  async transcribeOpenAI({ audioBuffer, language, apiKey, features }) {
    try {
      const formData = new FormData();
      formData.append('file', audioBuffer, {
        filename: 'audio.mp3',
        contentType: 'audio/mpeg'
      });
      formData.append('model', 'whisper-1');

      if (language) {
        formData.append('language', language);
      }

      if (features.timestamps) {
        formData.append('response_format', 'verbose_json');
        formData.append('timestamp_granularities[]', 'word');
      }

      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          ...formData.getHeaders()
        },
        body: formData
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(`OpenAI Whisper error: ${error.error?.message || response.statusText}`);
      }

      const result = await response.json();

      return {
        text: result.text,
        language: result.language,
        duration: result.duration,
        words: result.words || [],
        segments: result.segments || [],
        provider: 'openai'
      };
    } catch (error) {
      throw new Error(`OpenAI Whisper failed: ${error.message}`);
    }
  }

  /**
   * Transcribe using Google Cloud Speech-to-Text
   */
  async transcribeGoogleCloud({ audioBuffer, language, apiKey, features }) {
    try {
      const audioContent = audioBuffer.toString('base64');

      const response = await fetch(
        `https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            config: {
              encoding: 'MP3',
              sampleRateHertz: 16000,
              languageCode: language || 'en-US',
              enableAutomaticPunctuation: true,
              enableWordTimeOffsets: features.timestamps || false,
              enableSpeakerDiarization: features.diarization || false,
              model: features.model || 'default'
            },
            audio: {
              content: audioContent
            }
          })
        }
      );

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(`Google Cloud STT error: ${error.error?.message || response.statusText}`);
      }

      const result = await response.json();

      if (!result.results || result.results.length === 0) {
        return {
          text: '',
          language: language || 'en-US',
          confidence: 0,
          provider: 'google'
        };
      }

      const transcript = result.results
        .map(r => r.alternatives[0].transcript)
        .join(' ');

      const words = result.results.flatMap(r =>
        r.alternatives[0].words?.map(w => ({
          word: w.word,
          startTime: parseFloat(w.startTime),
          endTime: parseFloat(w.endTime),
          confidence: w.confidence
        })) || []
      );

      return {
        text: transcript,
        language: language || 'en-US',
        confidence: result.results[0].alternatives[0].confidence,
        words,
        provider: 'google'
      };
    } catch (error) {
      throw new Error(`Google Cloud STT failed: ${error.message}`);
    }
  }

  /**
   * Transcribe using Azure Speech Services
   */
  async transcribeAzure({ audioBuffer, language, apiKey, features }) {
    try {
      const region = 'eastus'; // Should be configurable

      const response = await fetch(
        `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${
          language || 'en-US'
        }`,
        {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': apiKey,
            'Content-Type': 'audio/wav'
          },
          body: audioBuffer
        }
      );

      if (!response.ok) {
        throw new Error(`Azure STT error: ${response.statusText}`);
      }

      const result = await response.json();

      return {
        text: result.DisplayText || '',
        language: language || 'en-US',
        confidence: result.Confidence || 0,
        duration: result.Duration / 10000000, // Convert from ticks to seconds
        provider: 'azure'
      };
    } catch (error) {
      throw new Error(`Azure STT failed: ${error.message}`);
    }
  }

  /**
   * Transcribe using Deepgram
   */
  async transcribeDeepgram({ audioBuffer, language, apiKey, features }) {
    try {
      const model = features.model || 'nova-2';
      const params = new URLSearchParams({
        model,
        smart_format: 'true',
        punctuate: 'true',
        diarize: features.diarization ? 'true' : 'false',
        utterances: 'true'
      });

      if (language) {
        params.append('language', language);
      }

      const response = await fetch(
        `https://api.deepgram.com/v1/listen?${params.toString()}`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Token ${apiKey}`,
            'Content-Type': 'audio/mpeg'
          },
          body: audioBuffer
        }
      );

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(`Deepgram error: ${error.err_msg || response.statusText}`);
      }

      const result = await response.json();
      const channel = result.results.channels[0];
      const alternative = channel.alternatives[0];

      return {
        text: alternative.transcript,
        language: result.results.language || language,
        confidence: alternative.confidence,
        duration: result.metadata.duration,
        words: alternative.words || [],
        utterances: result.results.utterances || [],
        provider: 'deepgram'
      };
    } catch (error) {
      throw new Error(`Deepgram failed: ${error.message}`);
    }
  }

  /**
   * Transcribe using AssemblyAI
   */
  async transcribeAssemblyAI({ audioBuffer, language, apiKey, features }) {
    try {
      // Step 1: Upload audio file
      const uploadResponse = await fetch('https://api.assemblyai.com/v2/upload', {
        method: 'POST',
        headers: {
          'Authorization': apiKey,
          'Content-Type': 'audio/mpeg'
        },
        body: audioBuffer
      });

      if (!uploadResponse.ok) {
        throw new Error(`AssemblyAI upload failed: ${uploadResponse.statusText}`);
      }

      const { upload_url } = await uploadResponse.json();

      // Step 2: Create transcription job
      const transcriptResponse = await fetch('https://api.assemblyai.com/v2/transcript', {
        method: 'POST',
        headers: {
          'Authorization': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          audio_url: upload_url,
          speaker_labels: features.diarization || false,
          auto_chapters: features.chapters || false,
          sentiment_analysis: features.sentiment || false,
          entity_detection: features.entities || false
        })
      });

      if (!transcriptResponse.ok) {
        throw new Error(`AssemblyAI transcription failed: ${transcriptResponse.statusText}`);
      }

      const transcriptJob = await transcriptResponse.json();

      // Step 3: Poll for completion
      let transcript = transcriptJob;
      while (transcript.status !== 'completed' && transcript.status !== 'error') {
        await new Promise(resolve => setTimeout(resolve, 1000));

        const pollResponse = await fetch(
          `https://api.assemblyai.com/v2/transcript/${transcript.id}`,
          {
            headers: { 'Authorization': apiKey }
          }
        );

        transcript = await pollResponse.json();
      }

      if (transcript.status === 'error') {
        throw new Error(`AssemblyAI error: ${transcript.error}`);
      }

      return {
        text: transcript.text,
        language: 'en',
        confidence: transcript.confidence,
        duration: transcript.audio_duration,
        words: transcript.words || [],
        chapters: transcript.chapters || [],
        sentiment: transcript.sentiment_analysis_results || [],
        entities: transcript.entities || [],
        provider: 'assemblyai'
      };
    } catch (error) {
      throw new Error(`AssemblyAI failed: ${error.message}`);
    }
  }

  /**
   * Test provider connection with sample audio
   */
  async testProvider({ provider, apiKey, language }) {
    try {
      // Create a minimal audio buffer for testing (1 second of silence as MP3)
      const testAudioBase64 = 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAADhAC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7////////////////////////////////////////////////////////AAAAAExhdmM1OC4xMzQAAAAAAAAAAAAAAAkAAAAAAAADhAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//sQZAAP8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xBkAA/wAABpAAAACAAADSAAAAEAAAGkAAAAIAAA0gAAABJVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=';
      const testAudio = Buffer.from(testAudioBase64, 'base64');

      const result = await this.transcribe({
        audio: testAudio,
        provider,
        language,
        apiKey
      });

      return {
        success: true,
        text: result.text,
        provider: result.provider
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = new SttService();
