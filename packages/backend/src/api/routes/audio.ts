import {createUnprotectedReadStream,assertMemoryFilesystemAccess} from '../../memory/encryption/protected-filesystem.js';
import { dataPath } from '../../config/data-root.js';
import type { FastifyInstance } from 'fastify';
import { handleError } from '../error-handler.js';
import { getAudioService } from '../../services/audio-service.js';
import fs from 'fs';
import path from 'path';

/**
 * Audio API Routes
 * Handles Whisper STT, TTS, and audio file serving
 */

const AUDIO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function registerAudioRoutes(fastify: FastifyInstance) {
  const audioService = getAudioService();
  fastify.log.info('[Audio API] ✅ Routes registered');

  // POST /api/audio/transcribe - Speech-to-Text (Whisper)
  fastify.post('/api/audio/transcribe', async (request, reply) => {
    try {
      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: 'No audio file provided' });
      }

      // Validate file type
      const allowedTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/webm', 'audio/ogg'];
      if (!allowedTypes.includes(data.mimetype)) {
        return reply.status(400).send({ error: 'Invalid audio format. Allowed: mp3, wav, webm, ogg' });
      }

      // Validate file size (max 25MB)
      const buffer = await data.toBuffer();
      if (buffer.length > 25 * 1024 * 1024) {
        return reply.status(400).send({ error: 'File too large. Max size: 25MB' });
      }

      // Transcribe using Whisper
      const result = await audioService.transcribe(buffer, data.filename);

      return reply.send({
        success: true,
        transcript: result.text,
        language: result.language,
        duration: result.duration
      });
    } catch (error: any) {
      fastify.log.error('Transcription error:', error);
      return handleError(reply, error, 'internal', '[Audio] Transcription failed');
    }
  });

  // POST /api/audio/tts - Text-to-Speech
  fastify.post<{
    Body: {
      text: string;
      voice?: string;
      language?: string;
      sessionId?: string;
      messageId?: string;
      provider?: 'openai' | 'local' | 'qwen';
      emotion?: string;
      referenceAudio?: string;
    };
  }>('/api/audio/tts', async (request, reply) => {
    try {
      const { text, voice = 'alloy', language, sessionId, messageId, provider, emotion, referenceAudio } = request.body;

      if (!text || text.trim().length === 0) {
        return reply.status(400).send({ error: 'Text is required' });
      }

      // Validate text length (max 4096 chars for OpenAI TTS)
      if (text.length > 4096) {
        return reply.status(400).send({ error: 'Text too long. Max 4096 characters' });
      }

      // Generate speech
      const result = await audioService.textToSpeech({
        text,
        voice,
        language,
        sessionId,
        messageId,
        provider,
        emotion,
        referenceAudio
      });

      return reply.send({
        success: true,
        audioId: result.audioId,
        audioUrl: `/api/audio/download/${result.audioId}`,
        duration: result.duration
      });
    } catch (error: any) {
      fastify.log.error('TTS error:', error);
      return handleError(reply, error, 'internal', '[Audio] TTS generation failed');
    }
  });

  // GET /api/audio/download/:id - Download generated audio
  fastify.get<{ Params: { id: string } }>('/api/audio/download/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      // SECURITY (S0-A.1): ids are server-generated UUIDs (no path traversal).
      if (!AUDIO_ID.test(id)) {
        return reply.status(404).send({ error: 'Audio file not found' });
      }

      const audioPath = dataPath('audio', `${id}.mp3`);

      // Check if file exists
      if (!fs.existsSync(audioPath)) {
        return reply.status(404).send({ error: 'Audio file not found' });
      }

      // Stream the file
      assertMemoryFilesystemAccess(audioPath);
      const stream = createUnprotectedReadStream(audioPath);

      return reply
        .type('audio/mpeg')
        .header('Content-Disposition', `inline; filename="${id}.mp3"`)
        .header('Cache-Control', 'public, max-age=3600')
        .send(stream);
    } catch (error: any) {
      fastify.log.error('Audio download error:', error);
      return handleError(reply, error, 'internal', '[Audio] Download failed');
    }
  });

  // DELETE /api/audio/:id - Delete audio file (cleanup)
  fastify.delete<{ Params: { id: string } }>('/api/audio/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      if (!AUDIO_ID.test(id)) {
        return reply.status(400).send({ error: 'Invalid audio id' });
      }

      const audioPath = dataPath('audio', `${id}.mp3`);

      if (fs.existsSync(audioPath)) {
        fs.unlinkSync(audioPath);
      }

      return reply.send({ success: true });
    } catch (error: any) {
      fastify.log.error('Audio delete error:', error);
      return handleError(reply, error, 'internal', '[Audio] Delete failed');
    }
  });
}
