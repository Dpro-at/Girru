/**
 * Provider Test Routes
 * Endpoints for testing TTS and STT providers
 */

module.exports = async function (fastify, opts) {
  const ttsService = require('../services/tts-service.js');
  const sttService = require('../services/stt-service.js');

  /**
   * POST /test-tts - Test TTS provider connection
   * Body: { provider, voice, language, api_key, model }
   */
  fastify.post('/test-tts', async (request, reply) => {
    try {
      const { provider, voice, language, api_key, model } = request.body;

      if (!provider) {
        return reply.status(400).send({ error: 'Provider is required' });
      }

      fastify.log.info(`[Provider Test] Testing TTS provider: ${provider}`);

      const result = await ttsService.testProvider({
        provider,
        apiKey: api_key,
        voice: voice || 'default',
        language: language || 'en-US'
      });

      if (result.success) {
        fastify.log.info(`[Provider Test] TTS ${provider} test successful`);
        return {
          success: true,
          provider,
          audioSize: result.audioSize,
          format: result.format,
          message: `${provider} TTS is working correctly`
        };
      } else {
        fastify.log.error(`[Provider Test] TTS ${provider} test failed:`, result.error);
        return reply.status(500).send({
          success: false,
          provider,
          error: result.error
        });
      }
    } catch (error) {
      fastify.log.error('[Provider Test] TTS test error:', error);
      return reply.status(500).send({
        success: false,
        error: error.message
      });
    }
  });

  /**
   * POST /test-stt - Test STT provider connection
   * Body: { provider, language, api_key }
   */
  fastify.post('/test-stt', async (request, reply) => {
    try {
      const { provider, language, api_key } = request.body;

      if (!provider) {
        return reply.status(400).send({ error: 'Provider is required' });
      }

      fastify.log.info(`[Provider Test] Testing STT provider: ${provider}`);

      const result = await sttService.testProvider({
        provider,
        apiKey: api_key,
        language: language || 'en-US'
      });

      if (result.success) {
        fastify.log.info(`[Provider Test] STT ${provider} test successful`);
        return {
          success: true,
          provider,
          text: result.text,
          message: `${provider} STT is working correctly`
        };
      } else {
        fastify.log.error(`[Provider Test] STT ${provider} test failed:`, result.error);
        return reply.status(500).send({
          success: false,
          provider,
          error: result.error
        });
      }
    } catch (error) {
      fastify.log.error('[Provider Test] STT test error:', error);
      return reply.status(500).send({
        success: false,
        error: error.message
      });
    }
  });

  /**
   * POST /generate-tts - Generate TTS audio (for testing)
   * Body: { text, provider, voice, language, api_key, model }
   * Returns: Audio file (MP3)
   */
  fastify.post('/generate-tts', async (request, reply) => {
    try {
      const { text, provider, voice, language, api_key, model } = request.body;

      if (!text || !provider) {
        return reply.status(400).send({ error: 'Text and provider are required' });
      }

      fastify.log.info(`[Provider Test] Generating TTS with ${provider}`);

      const audioBuffer = await ttsService.generateSpeech({
        text,
        provider,
        voice: voice || 'default',
        language: language || 'en-US',
        apiKey: api_key,
        model
      });

      // Return audio file
      reply.header('Content-Type', 'audio/mpeg');
      reply.header('Content-Length', audioBuffer.length);
      reply.header('Content-Disposition', `attachment; filename="tts_${provider}_${Date.now()}.mp3"`);
      return reply.send(audioBuffer);
    } catch (error) {
      fastify.log.error('[Provider Test] TTS generation error:', error);
      return reply.status(500).send({
        success: false,
        error: error.message
      });
    }
  });

  /**
   * POST /transcribe-audio - Transcribe audio (for testing)
   * Body: multipart/form-data with 'audio' file + provider, language, api_key
   * Returns: Transcription result
   */
  fastify.post('/transcribe-audio', async (request, reply) => {
    try {
      // Handle multipart form data
      const data = await request.file();

      if (!data) {
        return reply.status(400).send({ error: 'Audio file is required' });
      }

      const audioBuffer = await data.toBuffer();
      const provider = request.body?.provider || data.fields?.provider?.value;
      const language = request.body?.language || data.fields?.language?.value;
      const api_key = request.body?.api_key || data.fields?.api_key?.value;

      if (!provider) {
        return reply.status(400).send({ error: 'Provider is required' });
      }

      fastify.log.info(`[Provider Test] Transcribing audio with ${provider}`);

      const result = await sttService.transcribe({
        audio: audioBuffer,
        provider,
        language,
        apiKey: api_key
      });

      return {
        success: true,
        provider,
        result
      };
    } catch (error) {
      fastify.log.error('[Provider Test] Transcription error:', error);
      return reply.status(500).send({
        success: false,
        error: error.message
      });
    }
  });

  /**
   * GET /provider-voices/:provider - Get available voices for a provider
   * Query: api_key
   */
  fastify.get('/provider-voices/:provider', async (request, reply) => {
    try {
      const { provider } = request.params;
      const { api_key } = request.query;

      if (!provider) {
        return reply.status(400).send({ error: 'Provider is required' });
      }

      fastify.log.info(`[Provider Test] Fetching voices for ${provider}`);

      const voices = await ttsService.getProviderVoices(provider, api_key);

      return {
        success: true,
        provider,
        count: voices.length,
        voices
      };
    } catch (error) {
      fastify.log.error('[Provider Test] Fetch voices error:', error);
      return reply.status(500).send({
        success: false,
        error: error.message
      });
    }
  });

  /**
   * GET /provider-status - Get status of all providers
   */
  fastify.get('/provider-status', async (request, reply) => {
    try {
      const { TTS_PROVIDERS } = require('../config/tts-providers.js');
      const { STT_PROVIDERS } = require('../config/stt-providers.js');

      return {
        success: true,
        tts: Object.values(TTS_PROVIDERS).map(p => ({
          id: p.id,
          name: p.name,
          requiresApiKey: p.requiresApiKey,
          pricing: p.pricing,
          supportedLanguages: p.supportedLanguages
        })),
        stt: Object.values(STT_PROVIDERS).map(p => ({
          id: p.id,
          name: p.name,
          requiresApiKey: p.requiresApiKey,
          pricing: p.pricing,
          supportedLanguages: p.supportedLanguages
        }))
      };
    } catch (error) {
      fastify.log.error('[Provider Test] Status error:', error);
      return reply.status(500).send({
        success: false,
        error: error.message
      });
    }
  });
};
