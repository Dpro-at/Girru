import {assertMemoryFilesystemAccess,readUnprotectedFileSync} from '../../memory/encryption/protected-filesystem.js';
import { dataPath } from '../../config/data-root.js';
import type { FastifyInstance } from 'fastify';
import { lockName, one, q, run, sql, type Step } from '../../repositories/sql-steps.js';
import { getAudioService } from '../../services/audio-service.js';
import { generateLipsync, isRhubarbAvailable } from '../../services/lipsync-service.js';
import fs from 'fs';
import path from 'path';
import { uploadsPath, uploadPathFromUrl } from '../../services/uploads.js';
import { randomBytes } from 'crypto';
import { handleError } from '../error-handler.js';
import {
  downloadAvatarModel,
  downloadAvatarPreview,
  writeFileAtomic,
  avatarDownloadErrorStatus,
} from '../../services/net/avatar-download.js';

/** One avatar in the API shape (camelCase aliases quoted: PostgreSQL folds unquoted names). */
const AVATAR_VIEW_SQL = `
        SELECT id, user_id as "userId", name, source, glb_url as "glbUrl",
          local_glb_path as "localGlbPath", preview_url as "previewUrl",
          bg_color as "bgColor", bg_scene as "bgScene", is_active as "isActive", created_at as "createdAt"
        FROM user_avatars WHERE id = ?
      `;

/**
 * B2.2c: add an avatar in one transaction under the user's avatar lock; it
 * is activated when it is the user's first (exactly one first avatar, also
 * for two concurrent adds). Returns the stored avatar.
 */
function addAvatar(userId: string, id: string, insert: (isActive: number) => Step<unknown>): Promise<any> {
  return sql().tx(function* () {
    yield* lockName(`user_avatars:${userId}`);
    const existingCount = (yield* one('SELECT COUNT(*) as count FROM user_avatars WHERE user_id = ?', userId)) as { count: number };
    yield* insert(existingCount.count === 0 ? 1 : 0);
    return yield* one(AVATAR_VIEW_SQL, id);
  });
}

/**
 * Avatar API Routes
 * Handles user avatar settings (Ready Player Me URLs, voice preferences)
 *
 * B2.2c: every query runs on the process driver (sql-steps). camelCase
 * aliases are quoted (PostgreSQL folds unquoted names; SQLite returns the
 * same names). Adding, activating and deleting avatars, and saving the
 * settings, are check-then-write transactions under a per-user lock.
 */
export async function registerAvatarRoutes(fastify: FastifyInstance) {
  fastify.log.info('[Avatar API] ✅ Routes registered');

  // SECURITY (S0-A.6): the user is the signed-in user (request.authUser, set
  // by the auth gate), never a `userId` from the query or body: any such
  // value is replaced. Routes that take an avatar id only act on the
  // caller's own avatars (the owner may act on all).
  fastify.addHook('preHandler', async (request, reply) => {
    const authUser = (request as any).authUser as { id: string; role: string } | null | undefined;
    if (!authUser) {
      // Only the optional-auth routes (system list, logos) run anonymously.
      const anonymousOk = ['/api/avatars/system', '/api/avatar/logo/:filename'].includes(request.routeOptions.url || '');
      if (anonymousOk) return;
      return reply.status(401).send({ error: 'Authentication required' });
    }
    const uid = String(authUser.id);
    // Routes read the user from query.userId or body.userId: always the caller.
    if (request.query && typeof request.query === 'object') (request.query as any).userId = uid;
    if (request.body && typeof request.body === 'object' && !Array.isArray(request.body)) {
      (request.body as any).userId = uid;
    }
    const url = request.routeOptions.url || '';
    if (url.startsWith('/api/avatars/:id') && authUser.role !== 'owner') {
      const id = (request.params as any)?.id;
      const row = await q.one('SELECT user_id FROM user_avatars WHERE id = ?', id) as { user_id: string } | undefined;
      if (row && String(row.user_id) !== uid) {
        return reply.status(404).send({ error: 'Avatar not found' });
      }
    }
  });

  // GET /api/avatar/settings - Get user's avatar settings
  fastify.get<{
    Querystring: { userId: string };
  }>('/api/avatar/settings', async (request, reply) => {
    try {
      const { userId } = request.query;

      if (!userId) {
        return reply.status(400).send({ error: 'userId is required' });
      }

      // Get settings from database
      const settings = await q.one(`
        SELECT
          id,
          user_id as "userId",
          rpm_avatar_url as "rpmAvatarUrl",
          voice_provider as "voiceProvider",
          voice_id as "voiceId",
          language_preference as "languagePreference",
          bg_color as "bgColor",
          bg_scene as "bgScene",
          wall_text as "wallText",
          wall_logo_url as "wallLogoUrl",
          wall_video_url as "wallVideoUrl",
          wall_spotify_url as "wallSpotifyUrl",
          wall_layout as "wallLayout",
          created_at as "createdAt",
          updated_at as "updatedAt"
        FROM avatar_settings
        WHERE user_id = ?
      `, userId);

      if (!settings) {
        // Return default settings if not found
        return reply.send({
          success: true,
          settings: {
            userId,
            rpmAvatarUrl: null,
            voiceProvider: 'openai',
            voiceId: 'alloy',
            languagePreference: 'auto',
            bgColor: '#09090b',
            bgScene: 'none',
            wallText: '',
            wallLogoUrl: '',
            wallVideoUrl: '',
            wallSpotifyUrl: '',
            wallLayout: '{}'
          }
        });
      }

      return reply.send({
        success: true,
        settings
      });
    } catch (error: any) {
      fastify.log.error('Get avatar settings error:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Avatar] Get settings failed');
    }
  });

  // POST /api/avatar/settings - Update user's avatar settings
  fastify.post<{
    Body: {
      userId: number;
      rpmAvatarUrl?: string;
      voiceProvider?: string;
      voiceId?: string;
      languagePreference?: string;
      bgColor?: string;
      bgScene?: string;
      wallText?: string;
      wallLogoUrl?: string;
      wallVideoUrl?: string;
      wallSpotifyUrl?: string;
      wallLayout?: string;
    };
  }>('/api/avatar/settings', async (request, reply) => {
    try {
      const { userId, rpmAvatarUrl, voiceProvider, voiceId, languagePreference, bgColor, bgScene, wallText, wallLogoUrl, wallVideoUrl, wallSpotifyUrl, wallLayout } = request.body;

      if (!userId) {
        return reply.status(400).send({ error: 'userId is required' });
      }

      // Check-then-write in one transaction under a per-user lock (no duplicate row).
      await sql().tx(function* () {
      yield* lockName(`avatar_settings:${userId}`);
      // Check if settings exist
      const existing = yield* one('SELECT id FROM avatar_settings WHERE user_id = ?', userId);

      if (existing) {
        // Update existing settings
        const updates: string[] = [];
        const values: any[] = [];

        if (rpmAvatarUrl !== undefined) {
          updates.push('rpm_avatar_url = ?');
          values.push(rpmAvatarUrl);
        }
        if (voiceProvider !== undefined) {
          updates.push('voice_provider = ?');
          values.push(voiceProvider);
        }
        if (voiceId !== undefined) {
          updates.push('voice_id = ?');
          values.push(voiceId);
        }
        if (languagePreference !== undefined) {
          updates.push('language_preference = ?');
          values.push(languagePreference);
        }
        if (bgColor !== undefined) {
          updates.push('bg_color = ?');
          values.push(bgColor);
        }
        if (bgScene !== undefined) {
          updates.push('bg_scene = ?');
          values.push(bgScene);
        }
        if (wallText !== undefined) {
          updates.push('wall_text = ?');
          values.push(wallText);
        }
        if (wallLogoUrl !== undefined) {
          updates.push('wall_logo_url = ?');
          values.push(wallLogoUrl);
        }
        if (wallVideoUrl !== undefined) {
          updates.push('wall_video_url = ?');
          values.push(wallVideoUrl);
        }
        if (wallSpotifyUrl !== undefined) {
          updates.push('wall_spotify_url = ?');
          values.push(wallSpotifyUrl);
        }
        if (wallLayout !== undefined) {
          updates.push('wall_layout = ?');
          values.push(wallLayout);
        }

        if (updates.length > 0) {
          updates.push('updated_at = CURRENT_TIMESTAMP');
          values.push(userId);

          yield* run(`
            UPDATE avatar_settings
            SET ${updates.join(', ')}
            WHERE user_id = ?
          `, ...values);
        }
      } else {
        // Insert new settings
        yield* run(`
          INSERT INTO avatar_settings (
            user_id,
            rpm_avatar_url,
            voice_provider,
            voice_id,
            language_preference,
            bg_color,
            bg_scene,
            wall_text,
            wall_logo_url,
            wall_video_url,
            wall_spotify_url,
            wall_layout
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, userId,
          rpmAvatarUrl || null,
          voiceProvider || 'openai',
          voiceId || 'alloy',
          languagePreference || 'auto',
          bgColor || '#09090b',
          bgScene || 'none',
          wallText || '',
          wallLogoUrl || '',
          wallVideoUrl || '',
          wallSpotifyUrl || '',
          wallLayout || '{}');
      }
      });

      // Return updated settings
      const settings = await q.one(`
        SELECT
          id,
          user_id as "userId",
          rpm_avatar_url as "rpmAvatarUrl",
          voice_provider as "voiceProvider",
          voice_id as "voiceId",
          language_preference as "languagePreference",
          bg_color as "bgColor",
          bg_scene as "bgScene",
          wall_text as "wallText",
          wall_logo_url as "wallLogoUrl",
          wall_video_url as "wallVideoUrl",
          wall_spotify_url as "wallSpotifyUrl",
          wall_layout as "wallLayout",
          created_at as "createdAt",
          updated_at as "updatedAt"
        FROM avatar_settings
        WHERE user_id = ?
      `, userId);

      return reply.send({
        success: true,
        settings
      });
    } catch (error: any) {
      fastify.log.error('Update avatar settings error:', error.message, error.stack);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Avatar] Update settings failed');
    }
  });

  // GET /api/avatar/voices - Get available voices
  fastify.get('/api/avatar/voices', async (request, reply) => {
    try {
      // OpenAI TTS voices
      const voices = [
        {
          id: 'alloy',
          name: 'Alloy',
          provider: 'openai',
          gender: 'neutral',
          description: 'Balanced and versatile'
        },
        {
          id: 'echo',
          name: 'Echo',
          provider: 'openai',
          gender: 'male',
          description: 'Clear and professional'
        },
        {
          id: 'fable',
          name: 'Fable',
          provider: 'openai',
          gender: 'neutral',
          description: 'Warm and expressive'
        },
        {
          id: 'onyx',
          name: 'Onyx',
          provider: 'openai',
          gender: 'male',
          description: 'Deep and authoritative'
        },
        {
          id: 'nova',
          name: 'Nova',
          provider: 'openai',
          gender: 'female',
          description: 'Bright and energetic'
        },
        {
          id: 'shimmer',
          name: 'Shimmer',
          provider: 'openai',
          gender: 'female',
          description: 'Soft and friendly'
        }
      ];

      return reply.send({
        success: true,
        voices
      });
    } catch (error: any) {
      fastify.log.error('Get voices error:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Avatar] Get voices failed');
    }
  });

  // POST /api/avatar/speak — TTS + optional Rhubarb lipsync
  // Returns audio blob directly (Content-Type: audio/mpeg)
  // Header X-Lipsync-Data: JSON array of mouth cues (if Rhubarb available)
  // Header X-Rhubarb-Available: "true" | "false"
  fastify.post<{
    Body: { text: string; language?: string; voice?: string };
  }>('/api/avatar/speak', async (request, reply) => {
    try {
      const { text, language = 'auto', voice } = request.body;
      if (!text?.trim()) return reply.status(400).send({ error: 'text is required' });

      const audioService = getAudioService();
      const { audioId } = await audioService.textToSpeech({ text, language, voice });
      const audioPath = dataPath('audio', `${audioId}.mp3`);

      if (!fs.existsSync(audioPath)) {
        return reply.status(500).send({ error: 'Audio file not found after TTS' });
      }

      // Try Rhubarb lipsync (soft-dependency)
      let lipsyncHeader = '[]';
      if (isRhubarbAvailable()) {
        const cues = await generateLipsync(audioPath);
        if (cues) lipsyncHeader = JSON.stringify(cues);
      }

      assertMemoryFilesystemAccess(audioPath);
      const audioBuffer = readUnprotectedFileSync(audioPath);

      return reply
        .header('Content-Type', 'audio/mpeg')
        .header('X-Lipsync-Data', lipsyncHeader)
        .header('X-Rhubarb-Available', isRhubarbAvailable() ? 'true' : 'false')
        .header('Access-Control-Expose-Headers', 'X-Lipsync-Data, X-Rhubarb-Available')
        .send(audioBuffer);
    } catch (error: any) {
      fastify.log.error('Avatar speak error:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Avatar] Speak failed');
    }
  });

  // POST /api/tts — alias for SupportChatBlock (returns raw audio blob)
  fastify.post<{
    Body: { text: string; language?: string; voice?: string };
  }>('/api/tts', async (request, reply) => {
    try {
      const { text, language = 'auto', voice } = request.body;
      if (!text?.trim()) return reply.status(400).send({ error: 'text is required' });

      const audioService = getAudioService();
      const { audioId } = await audioService.textToSpeech({ text, language, voice });
      const audioPath = dataPath('audio', `${audioId}.mp3`);

      if (!fs.existsSync(audioPath)) return reply.status(500).send({ error: 'Audio file not found' });

      assertMemoryFilesystemAccess(audioPath);
      const audioBuffer = readUnprotectedFileSync(audioPath);
      return reply.header('Content-Type', 'audio/mpeg').send(audioBuffer);
    } catch (error: any) {
      fastify.log.error('TTS error:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Avatar] TTS failed');
    }
  });

  // POST /api/avatar/upload-logo — upload logo image for wall board, returns local URL
  fastify.post('/api/avatar/upload-logo', async (request, reply) => {
    try {
      const data = await request.file();
      if (!data) return reply.status(400).send({ error: 'No file provided' });

      // Validate image type
      const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml'];
      if (!allowed.includes(data.mimetype)) {
        return reply.status(400).send({ error: 'Only image files are allowed' });
      }

      // Ensure logos directory exists
      const logosDir = uploadsPath('logos');
      if (!fs.existsSync(logosDir)) fs.mkdirSync(logosDir, { recursive: true });

      // Generate unique filename with original extension
      const ext = path.extname(data.filename || 'logo.png') || '.png';
      const filename = `logo_${Date.now()}${ext}`;
      const filePath = path.join(logosDir, filename);

      // Save file
      const buffer = await data.toBuffer();
      fs.writeFileSync(filePath, buffer);

      const url = `/storage/logos/${filename}`;
      fastify.log.info(`[Avatar] Logo uploaded: ${filename}`);
      return reply.send({ success: true, url, filename });
    } catch (error: any) {
      fastify.log.error('Logo upload error:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Avatar] Logo upload failed');
    }
  });

  // GET /api/avatar/logo/:filename — serve uploaded logo image
  fastify.get<{ Params: { filename: string } }>('/api/avatar/logo/:filename', async (request, reply) => {
    try {
      const { filename } = request.params;
      // Security: reject path traversal
      if (filename.includes('..') || filename.includes('/')) {
        return reply.status(400).send({ error: 'Invalid filename' });
      }
      const filePath = uploadsPath('logos', filename);
      if (!fs.existsSync(filePath)) return reply.status(404).send({ error: 'Not found' });

      const ext = path.extname(filename).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      };
      const mime = mimeMap[ext] || 'application/octet-stream';
      assertMemoryFilesystemAccess(filePath);
      const buffer = readUnprotectedFileSync(filePath);
      return reply
        .header('Content-Type', mime)
        .header('Cache-Control', 'public, max-age=86400')
        .send(buffer);
    } catch (error: any) {
      return reply.status(500).send({ error: 'Failed to serve logo' });
    }
  });


  // ── Avatar Collection Routes ────────────────────────────────────────────────

  // GET /api/avatars/system — list all system avatars from public/avatars/system/
  fastify.get('/api/avatars/system', async (request, reply) => {
    try {
      const projectRoot = path.join(process.cwd(), '..', '..');
      const systemDir = path.join(projectRoot, 'public', 'avatars', 'system');

      if (!fs.existsSync(systemDir)) {
        return reply.send({ success: true, avatars: [] });
      }

      const entries = fs.readdirSync(systemDir, { withFileTypes: true });
      const avatars = [];

      for (const entry of entries) {
        // Flat GLB file directly in system/
        if (entry.isFile() && /\.(glb|gltf)$/i.test(entry.name)) {
          const slug = entry.name.replace(/\.(glb|gltf)$/i, '');
          const label = slug.replace(/_/g, ' ');
          avatars.push({
            id: slug,
            name: label,
            description: '',
            glbUrl: `/avatars/system/${entry.name}`,
            previewUrl: null,
            bgColor: '#0a0a0a',
            bgScene: 'none',
            tags: [],
          });
          continue;
        }

        // Subdirectory layout: system/<slug>/avatar.glb
        if (!entry.isDirectory()) continue;
        const slug = entry.name;
        const dir = path.join(systemDir, slug);

        let config: any = {};
        const configPath = path.join(dir, 'config.json');
        if (fs.existsSync(configPath)) {
          try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
        }

        const hasGlb = fs.existsSync(path.join(dir, 'avatar.glb'));
        if (!hasGlb) continue;

        const hasPreview = fs.existsSync(path.join(dir, 'preview.png'));

        avatars.push({
          id: slug,
          name: config.name || slug,
          description: config.description || '',
          glbUrl: `/avatars/system/${slug}/avatar.glb`,
          previewUrl: hasPreview ? `/avatars/system/${slug}/preview.png` : null,
          bgColor: config.bgColor || '#0a0a0a',
          bgScene: config.bgScene || 'none',
          tags: config.tags || [],
        });
      }

      return reply.send({ success: true, avatars });
    } catch (error: any) {
      fastify.log.error('List system avatars error:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Avatar] List system avatars failed');
    }
  });

  // GET /api/avatars?userId= — list all user's saved avatars
  fastify.get<{ Querystring: { userId: string } }>('/api/avatars', async (request, reply) => {
    try {
      const { userId } = request.query;
      if (!userId) return reply.status(400).send({ error: 'userId is required' });


      // Auto-import existing rpm_avatar_url if no avatars yet (one transaction
      // under the user's avatar lock: two first visits never import twice)
      await sql().tx(function* () {
        yield* lockName(`user_avatars:${userId}`);
        const existing = (yield* one('SELECT COUNT(*) as cnt FROM user_avatars WHERE user_id = ?', userId)) as { cnt: number };
        if (existing.cnt === 0) {
          const settings = (yield* one('SELECT rpm_avatar_url FROM avatar_settings WHERE user_id = ?', userId)) as { rpm_avatar_url: string | null } | undefined;
          if (settings?.rpm_avatar_url) {
            yield* run(`
            INSERT INTO user_avatars (user_id, name, source, glb_url, is_active)
            VALUES (?, 'My Avatar', 'rpm', ?, 1)
          `, userId, settings.rpm_avatar_url);
          }
        }
      });

      const avatars = await q.all(`
        SELECT
          id, user_id as "userId", name, source,
          glb_url as "glbUrl", local_glb_path as "localGlbPath",
          preview_url as "previewUrl", bg_color as "bgColor", bg_scene as "bgScene",
          is_active as "isActive", created_at as "createdAt"
        FROM user_avatars
        WHERE user_id = ?
        ORDER BY is_active DESC, created_at ASC
      `, userId);

      // Sync active avatar to users.avatar_url for profile API
      const activeAvatar = avatars.find((a: any) => a.isActive);
      if (activeAvatar) {
        const effectiveUrl = activeAvatar.localGlbPath || activeAvatar.glbUrl;
        await q.run('UPDATE users SET avatar_url = ? WHERE id = ?', effectiveUrl, userId);
      }

      return reply.send({ success: true, avatars });
    } catch (error: any) {
      fastify.log.error('List avatars error:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Avatar] List avatars failed');
    }
  });

  // POST /api/avatars — add avatar by URL or from system
  fastify.post<{
    Body: { userId: string; name?: string; source: string; glbUrl?: string; previewUrl?: string; bgColor?: string; bgScene?: string };
  }>('/api/avatars', async (request, reply) => {
    try {
      const { userId, name, source, glbUrl, previewUrl, bgColor, bgScene } = request.body;
      if (!userId) return reply.status(400).send({ error: 'userId is required' });
      if (!glbUrl && source !== 'upload') return reply.status(400).send({ error: 'glbUrl is required' });

      const id = randomBytes(8).toString('hex');

      // One transaction under the user's avatar lock: the first avatar is
      // activated exactly once even when two are added at the same time.
      const avatar = await sql().tx(function* () {
        yield* lockName(`user_avatars:${userId}`);
        // Auto-activate if this is the user's first avatar
        const existingCount = (yield* one('SELECT COUNT(*) as count FROM user_avatars WHERE user_id = ?', userId)) as { count: number };
        const isActive = existingCount.count === 0 ? 1 : 0;

        yield* run(`
        INSERT INTO user_avatars (id, user_id, name, source, glb_url, preview_url, bg_color, bg_scene, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, id, userId,
          name || 'New Avatar',
          source || 'url',
          glbUrl || null,
          previewUrl || null,
          bgColor || '#0a0a0a',
          bgScene || 'none',
          isActive);

        return yield* one(`
        SELECT id, user_id as "userId", name, source, glb_url as "glbUrl",
          local_glb_path as "localGlbPath", preview_url as "previewUrl",
          bg_color as "bgColor", bg_scene as "bgScene", is_active as "isActive", created_at as "createdAt"
        FROM user_avatars WHERE id = ?
      `, id);
      });

      return reply.send({ success: true, avatar });
    } catch (error: any) {
      fastify.log.error('Add avatar error:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Avatar] Add avatar failed');
    }
  });

  // PATCH /api/avatars/:id — update name/bg/scene
  fastify.patch<{
    Params: { id: string };
    Body: { name?: string; bgColor?: string; bgScene?: string };
  }>('/api/avatars/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const { name, bgColor, bgScene } = request.body;

      const updates: string[] = [];
      const values: any[] = [];

      if (name !== undefined) { updates.push('name = ?'); values.push(name); }
      if (bgColor !== undefined) { updates.push('bg_color = ?'); values.push(bgColor); }
      if (bgScene !== undefined) { updates.push('bg_scene = ?'); values.push(bgScene); }

      if (updates.length === 0) return reply.send({ success: true });

      values.push(id);
      await q.run(`UPDATE user_avatars SET ${updates.join(', ')} WHERE id = ?`, ...values);

      return reply.send({ success: true });
    } catch (error: any) {
      fastify.log.error('Update avatar error:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Avatar] Update avatar failed');
    }
  });

  // PATCH /api/avatars/:id/activate — set as active avatar for user
  fastify.patch<{
    Params: { id: string };
    Body: { userId: string };
  }>('/api/avatars/:id/activate', async (request, reply) => {
    try {
      const { id } = request.params;
      const { userId } = request.body;
      if (!userId) return reply.status(400).send({ error: 'userId is required' });


      // One transaction under the user's avatar locks: exactly one active
      // avatar, and the settings / profile copies follow it.
      await sql().tx(function* () {
        yield* lockName(`user_avatars:${userId}`);
        yield* lockName(`avatar_settings:${userId}`);
        // Deactivate all for this user, then activate the selected one
        yield* run('UPDATE user_avatars SET is_active = 0 WHERE user_id = ?', userId);
        yield* run('UPDATE user_avatars SET is_active = 1 WHERE id = ? AND user_id = ?', id, userId);

        // Sync to avatar_settings AND users table for backward compat + profile API
        const avatar = (yield* one(`
        SELECT glb_url as "glbUrl", local_glb_path as "localGlbPath"
        FROM user_avatars WHERE id = ?
      `, id)) as { glbUrl: string | null; localGlbPath: string | null } | undefined;

        if (avatar) {
          const effectiveUrl = avatar.localGlbPath || avatar.glbUrl;

          // Update avatar_settings (for avatar viewer)
          const hasSettings = yield* one('SELECT id FROM avatar_settings WHERE user_id = ?', userId);
          if (hasSettings) {
            yield* run('UPDATE avatar_settings SET rpm_avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?', effectiveUrl, userId);
          } else {
            yield* run('INSERT INTO avatar_settings (user_id, rpm_avatar_url) VALUES (?, ?)', userId, effectiveUrl);
          }

          // Update users.avatar_url (for profile API + World Builder)
          yield* run('UPDATE users SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', effectiveUrl, userId);
        }
      });

      return reply.send({ success: true });
    } catch (error: any) {
      fastify.log.error('Activate avatar error:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Avatar] Activate avatar failed');
    }
  });

  // DELETE /api/avatars/:id — remove avatar (+ delete file if uploaded)
  fastify.delete<{
    Params: { id: string };
    Querystring: { userId: string };
  }>('/api/avatars/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const { userId } = request.query;
      if (!userId) return reply.status(400).send({ error: 'userId is required' });

      // The row delete and the hand-over of the active avatar: one
      // transaction under the user's avatar lock.
      const avatar = await sql().tx(function* () {
        yield* lockName(`user_avatars:${userId}`);
        const row = (yield* one(`
        SELECT source, local_glb_path as "localGlbPath", is_active as "isActive"
        FROM user_avatars WHERE id = ? AND user_id = ?
      `, id, userId)) as { source: string; localGlbPath: string | null; isActive: number } | undefined;
        if (!row) return undefined;

        yield* run('DELETE FROM user_avatars WHERE id = ? AND user_id = ?', id, userId);

        // If deleted avatar was active, activate the first remaining one
        if (row.isActive) {
          const next = (yield* one('SELECT id, glb_url as "glbUrl", local_glb_path as "localGlbPath" FROM user_avatars WHERE user_id = ? LIMIT 1', userId)) as any;
          if (next) {
            yield* run('UPDATE user_avatars SET is_active = 1 WHERE id = ?', next.id);
            const url = next.localGlbPath || next.glbUrl;
            yield* run('UPDATE avatar_settings SET rpm_avatar_url = ? WHERE user_id = ?', url, userId);
            yield* run('UPDATE users SET avatar_url = ? WHERE id = ?', url, userId);
          } else {
            // No avatars left - clear the users.avatar_url
            yield* run('UPDATE users SET avatar_url = NULL WHERE id = ?', userId);
          }
        }
        return row;
      });

      if (!avatar) return reply.status(404).send({ error: 'Avatar not found' });

      // Delete uploaded file if exists (after the row is gone)
      if (avatar.localGlbPath) {
        const absPath = uploadPathFromUrl(avatar.localGlbPath);
        const avatarDir = absPath ? path.dirname(absPath) : null;
        try {
          if (avatarDir && fs.existsSync(avatarDir)) fs.rmSync(avatarDir, { recursive: true, force: true });
        } catch {}
      }

      return reply.send({ success: true });
    } catch (error: any) {
      fastify.log.error('Delete avatar error:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Avatar] Delete avatar failed');
    }
  });

  // POST /api/avatars/upload — upload GLB/FBX file → save to public/avatars/user/{userId}/{id}/
  fastify.post<{ Querystring: { userId: string; name?: string } }>('/api/avatars/upload', async (request, reply) => {
    try {
      const { userId, name } = request.query;
      if (!userId) return reply.status(400).send({ error: 'userId is required' });

      const data = await request.file();
      if (!data) return reply.status(400).send({ error: 'No file provided' });

      const ext = path.extname(data.filename || 'avatar.glb').toLowerCase();
      if (ext !== '.glb' && ext !== '.gltf' && ext !== '.fbx') {
        return reply.status(400).send({ error: 'Only .glb, .gltf, or .fbx files are allowed' });
      }

      const id = randomBytes(8).toString('hex');
      const avatarDir = uploadsPath('avatars', 'user', userId, id);
      fs.mkdirSync(avatarDir, { recursive: true });

      const modelFilename = 'avatar' + ext;
      const modelPath = path.join(avatarDir, modelFilename);
      const buffer = await data.toBuffer();
      fs.writeFileSync(modelPath, buffer);

      const localModelPath = `/storage/avatars/user/${userId}/${id}/${modelFilename}`;

      // Auto-activate if this is the user's first avatar (one transaction, avatar lock)
      const avatar = await addAvatar(userId, id, (isActive) => run(`
        INSERT INTO user_avatars (id, user_id, name, source, local_glb_path, is_active)
        VALUES (?, ?, ?, 'upload', ?, ?)
      `, id, userId, name || data.filename || 'Uploaded Avatar', localModelPath, isActive));

      fastify.log.info(`[Avatar] Model uploaded: ${localModelPath}`);
      return reply.send({ success: true, avatar });
    } catch (error: any) {
      fastify.log.error('Avatar upload error:', error);
      return handleError(reply, error, 'internal', '[Avatar] Upload failed');
    }
  });

  // POST /api/avatars/:id/preview — upload a preview image (PNG) for an avatar
  fastify.post<{ Params: { id: string } }>('/api/avatars/:id/preview', async (request, reply) => {
    try {
      const { id } = request.params;

      const avatar = await q.one(`
        SELECT id, user_id as "userId", local_glb_path as "localGlbPath"
        FROM user_avatars WHERE id = ?
      `, id) as { id: string; userId: string; localGlbPath: string | null } | undefined;

      if (!avatar) return reply.status(404).send({ error: 'Avatar not found' });

      const data = await request.file();
      if (!data) return reply.status(400).send({ error: 'No file provided' });

      const buffer = await data.toBuffer();

      const avatarDir = uploadsPath('avatars', 'user', avatar.userId, id);
      fs.mkdirSync(avatarDir, { recursive: true });

      const previewPath = path.join(avatarDir, 'preview.png');
      fs.writeFileSync(previewPath, buffer);

      const previewUrl = `/storage/avatars/user/${avatar.userId}/${id}/preview.png`;

      await q.run('UPDATE user_avatars SET preview_url = ? WHERE id = ?', previewUrl, id);

      fastify.log.info(`[Avatar] Preview saved: ${previewUrl}`);
      return reply.send({ success: true, previewUrl });
    } catch (error: any) {
      fastify.log.error('Avatar preview upload error:', error);
      return handleError(reply, error, 'internal', '[Avatar] Preview upload failed');
    }
  });

  // POST /api/avatars/:id/localize — download existing avatar's remote glbUrl to local storage
  fastify.post<{ Params: { id: string } }>('/api/avatars/:id/localize', async (request, reply) => {
    try {
      const { id } = request.params;

      const avatar = await q.one(`
        SELECT id, user_id as "userId", glb_url as "glbUrl", local_glb_path as "localGlbPath"
        FROM user_avatars WHERE id = ?
      `, id) as { id: string; userId: string; glbUrl: string | null; localGlbPath: string | null } | undefined;

      if (!avatar) return reply.status(404).send({ error: 'Avatar not found' });
      if (avatar.localGlbPath) return reply.send({ success: true, message: 'Already local' });
      if (!avatar.glbUrl) return reply.status(400).send({ error: 'No remote URL to download' });

      // SECURITY (S0-A.13): the stored glbUrl came from the user -> SSRF guard
      // (Ready Player Me hosts only, public DNS answers, pinned IP, limits, GLB check).
      const glbBuffer = await downloadAvatarModel(avatar.glbUrl);
      const previewBuf = await downloadAvatarPreview(avatar.glbUrl);

      const avatarDir = uploadsPath('avatars', 'user', avatar.userId, id);
      fs.mkdirSync(avatarDir, { recursive: true });
      writeFileAtomic(path.join(avatarDir, 'avatar.glb'), glbBuffer);
      const localGlbPath = `/storage/avatars/user/${avatar.userId}/${id}/avatar.glb`;

      let localPreviewUrl: string | null = null;
      if (previewBuf) {
        writeFileAtomic(path.join(avatarDir, 'preview.png'), previewBuf);
        localPreviewUrl = `/storage/avatars/user/${avatar.userId}/${id}/preview.png`;
      }

      const updated = await sql().tx(function* () {
        yield* run(`
        UPDATE user_avatars SET local_glb_path = ?, preview_url = COALESCE(?, preview_url) WHERE id = ?
      `, localGlbPath, localPreviewUrl, id);
        return yield* one(AVATAR_VIEW_SQL, id);
      });

      fastify.log.info(`[Avatar] Localized: ${localGlbPath}`);
      return reply.send({ success: true, avatar: updated });
    } catch (error: any) {
      fastify.log.error('Avatar localize error:', error);
      const refused = avatarDownloadErrorStatus(error);
      if (refused) return reply.status(refused).send({ error: 'Avatar model could not be downloaded from this URL' });
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Avatar] Localize failed');
    }
  });

  // POST /api/avatars/download — download GLB (+ preview) from URL → save locally
  fastify.post<{
    Body: { userId: string; name?: string; glbUrl: string };
  }>('/api/avatars/download', async (request, reply) => {
    try {
      const { userId, name, glbUrl } = request.body;
      if (!userId) return reply.status(400).send({ error: 'userId is required' });
      if (!glbUrl) return reply.status(400).send({ error: 'glbUrl is required' });

      if (typeof glbUrl !== 'string') return reply.status(400).send({ error: 'glbUrl must be a string' });

      // SECURITY (S0-A.13): glbUrl is user input fetched by the server -> SSRF
      // guard (https, default port, Ready Player Me hosts only, every DNS answer
      // public, connection pinned to the checked IP, same-host redirects <= 3,
      // size + content-type limits, GLB magic). Nothing is written before it passes.
      const glbBuffer = await downloadAvatarModel(glbUrl);
      const previewBuf = await downloadAvatarPreview(glbUrl); // optional

      const id = randomBytes(8).toString('hex');
      const avatarDir = uploadsPath('avatars', 'user', userId, id);
      fs.mkdirSync(avatarDir, { recursive: true });
      writeFileAtomic(path.join(avatarDir, 'avatar.glb'), glbBuffer);
      const localGlbPath = `/storage/avatars/user/${userId}/${id}/avatar.glb`;

      let localPreviewUrl: string | null = null;
      if (previewBuf) {
        writeFileAtomic(path.join(avatarDir, 'preview.png'), previewBuf);
        localPreviewUrl = `/storage/avatars/user/${userId}/${id}/preview.png`;
      }

      // Auto-activate if this is the user's first avatar (one transaction, avatar lock)
      const avatar = await addAvatar(userId, id, (isActive) => run(`
        INSERT INTO user_avatars (id, user_id, name, source, local_glb_path, preview_url, is_active)
        VALUES (?, ?, ?, 'url', ?, ?, ?)
      `, id, userId, name || 'Downloaded Avatar', localGlbPath, localPreviewUrl, isActive));

      fastify.log.info(`[Avatar] Downloaded: ${localGlbPath}`);
      return reply.send({ success: true, avatar });
    } catch (error: any) {
      fastify.log.error('Avatar download error:', error);
      const refused = avatarDownloadErrorStatus(error);
      if (refused) return reply.status(refused).send({ error: 'Avatar model could not be downloaded from this URL' });
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Avatar] Download failed');
    }
  });

  // GET /api/avatars/:id — get single avatar by ID
  fastify.get<{ Params: { id: string } }>('/api/avatars/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const avatar = await q.one(`
        SELECT id, user_id as "userId", name, source, glb_url as "glbUrl",
          local_glb_path as "localGlbPath", preview_url as "previewUrl",
          bg_color as "bgColor", bg_scene as "bgScene", is_active as "isActive", created_at as "createdAt"
        FROM user_avatars WHERE id = ?
      `, id);
      if (!avatar) return reply.status(404).send({ error: 'Avatar not found' });
      return reply.send({ success: true, avatar });
    } catch (error: any) {
      fastify.log.error('Get avatar by ID error:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Avatar] Get avatar failed');
    }
  });

  // POST /api/avatar/background/upload — upload image/video as custom background
  fastify.post<{ Params: never; Querystring: { userId?: string } }>(
    '/api/avatar/background/upload',
    async (request, reply) => {
      try {
        const userId = (request.query as { userId?: string }).userId;
        if (!userId) return reply.status(401).send({ error: 'Authentication required' });
        const data = await request.file();
        if (!data) return reply.status(400).send({ error: 'No file provided' });

        const allowedExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.mov'];
        const ext = path.extname(data.filename || 'bg').toLowerCase();
        if (!allowedExts.includes(ext)) {
          return reply.status(400).send({ error: `Unsupported file type: ${ext}` });
        }

        const bgDir = uploadsPath('backgrounds', userId);
        fs.mkdirSync(bgDir, { recursive: true });

        const filename = `bg-${Date.now()}${ext}`;
        const filePath = path.join(bgDir, filename);
        const buffer = await data.toBuffer();
        fs.writeFileSync(filePath, buffer);

        const webPath = `/storage/backgrounds/${userId}/${filename}`;
        fastify.log.info(`[Avatar] Background uploaded: ${webPath}`);
        return reply.send({ success: true, url: webPath });
      } catch (error: any) {
        fastify.log.error('Background upload error:', error);
        // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
        return handleError(reply, error, 'internal', '[Avatar] Background upload failed');
      }
    }
  );

  // ── End Avatar Collection Routes ────────────────────────────────────────────

  // ── Animation Upload Routes (Custom FBX/GLB animations from Mixamo etc.) ──

  // POST /api/animations/upload — upload FBX/GLB animation file
  fastify.post<{ Querystring: { userId: string; name?: string; category?: string } }>(
    '/api/animations/upload',
    async (request, reply) => {
      try {
        const { userId, name, category } = request.query;
        if (!userId) return reply.status(400).send({ error: 'userId is required' });

        const data = await request.file();
        if (!data) return reply.status(400).send({ error: 'No file provided' });

        const ext = path.extname(data.filename || 'anim.fbx').toLowerCase();
        if (ext !== '.glb' && ext !== '.fbx') {
          return reply.status(400).send({ error: 'Only .glb or .fbx animation files are allowed' });
        }

        const id = randomBytes(8).toString('hex');
        const animDir = uploadsPath('animations', 'user', userId, id);
        fs.mkdirSync(animDir, { recursive: true });

        const animFilename = 'anim' + ext;
        const animPath = path.join(animDir, animFilename);
        const buffer = await data.toBuffer();
        fs.writeFileSync(animPath, buffer);

        const localPath = `/storage/animations/user/${userId}/${id}/${animFilename}`;
        const format = ext === '.fbx' ? 'fbx' : 'glb';

        const animation = await sql().tx(function* () {
          yield* run(`
          INSERT INTO user_animations (id, user_id, name, filename, format, category, local_path, file_size)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, id, userId,
          name || data.filename?.replace(/\.(fbx|glb)$/i, '') || 'Custom Animation',
          data.filename || animFilename,
          format,
          category || 'custom',
          localPath,
          buffer.length);
          return yield* one(`
          SELECT id, user_id as "userId", name, filename, format, category,
            local_path as "localPath", file_size as "fileSize", created_at as "createdAt"
          FROM user_animations WHERE id = ?
        `, id);
        });

        fastify.log.info(`[Animation] Uploaded: ${localPath} (${format})`);
        return reply.send({ success: true, animation });
      } catch (error: any) {
        fastify.log.error('Animation upload error:', error);
        return handleError(reply, error, 'internal', '[Animation] Upload failed');
      }
    }
  );

  // GET /api/animations — list user's custom animations
  fastify.get<{ Querystring: { userId: string } }>('/api/animations', async (request, reply) => {
    try {
      const { userId } = request.query;
      if (!userId) return reply.status(400).send({ error: 'userId is required' });

      const animations = await q.all(`
        SELECT id, user_id as "userId", name, filename, format, category,
          local_path as "localPath", file_size as "fileSize", created_at as "createdAt"
        FROM user_animations
        WHERE user_id = ?
        ORDER BY created_at DESC
      `, userId);

      return reply.send({ success: true, animations });
    } catch (error: any) {
      fastify.log.error('List animations error:', error);
      return handleError(reply, error, 'internal', '[Animation] List failed');
    }
  });

  // DELETE /api/animations/:id — delete custom animation
  fastify.delete<{ Params: { id: string }; Querystring: { userId: string } }>(
    '/api/animations/:id',
    async (request, reply) => {
      try {
        const { id } = request.params;
        const { userId } = request.query;
        if (!userId) return reply.status(400).send({ error: 'userId is required' });

          const anim = await q.one(
          'SELECT local_path as "localPath" FROM user_animations WHERE id = ? AND user_id = ?'
        , id, userId) as { localPath: string } | undefined;

        if (!anim) return reply.status(404).send({ error: 'Animation not found' });

        // Delete file from disk
        const animFile = uploadPathFromUrl(anim.localPath);
        const absDir = animFile ? path.dirname(animFile) : null;
        try {
          if (absDir && fs.existsSync(absDir)) fs.rmSync(absDir, { recursive: true, force: true });
        } catch { /* ignore cleanup errors */ }

        await q.run('DELETE FROM user_animations WHERE id = ? AND user_id = ?', id, userId);

        fastify.log.info(`[Animation] Deleted: ${anim.localPath}`);
        return reply.send({ success: true });
      } catch (error: any) {
        fastify.log.error('Delete animation error:', error);
        return handleError(reply, error, 'internal', '[Animation] Delete failed');
      }
    }
  );

  // ── End Animation Routes ──────────────────────────────────────────────────

  // POST /api/stt — alias for SupportChatBlock (multipart, returns transcript)
  fastify.post('/api/stt', async (request, reply) => {
    try {
      const data = await request.file();
      if (!data) return reply.status(400).send({ error: 'No audio file provided' });
      const buffer = await data.toBuffer();
      const audioService = getAudioService();
      const result = await audioService.transcribe(buffer, data.filename || 'speech.wav');
      return reply.send({ text: result.text, language: result.language });
    } catch (error: any) {
      fastify.log.error('STT error:', error);
      // SECURITY: Use centralized error handler to prevent info disclosure (H-09)
      return handleError(reply, error, 'internal', '[Avatar] STT failed');
    }
  });
}
