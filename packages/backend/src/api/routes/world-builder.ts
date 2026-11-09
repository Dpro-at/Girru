import {assertMemoryFilesystemAccess,readUnprotectedFileSync} from '../../memory/encryption/protected-filesystem.js';
/**
 * World Builder Routes
 * CRUD operations for world builder data
 */

import { FastifyInstance } from 'fastify';
import { createWorldWithFile, findOwnedWorld, updateWorldMeta, worldFilePath, worldsDir } from '../../repositories/user-worlds.js';
import { getUserIdFromRequest } from '../../auth/jwt.js';
import { sendInternalError } from '../error-handler.js';
import { safeErrorFields } from '../../services/safe-error-log.js';

export async function worldBuilderRoutes(fastify: FastifyInstance) {
  // ────────────────────────────────────────────────────────────────────
  // GET /api/world-builder/:id
  // Get world builder data by ID
  // ────────────────────────────────────────────────────────────────────
  fastify.get('/api/world-builder/:id', async (request, reply) => {
    try {
      const userId = getUserIdFromRequest(request);
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { id } = request.params as { id: string };
      // Get world from user_worlds table
      const world = await findOwnedWorld(id, userId);

      if (!world) {
        return reply.status(404).send({ error: 'World not found' });
      }

      // Try to load objects from file if it exists
      let objects = [];
      if (world.glb_file_id) {
        try {
          // Contained under the storage dir (B2.2d-10), else null.
          const fullPath = await worldFilePath(world.glb_file_id);

          if (fullPath) {
            const fs = await import('fs');

            if (fs.existsSync(fullPath)) {
              assertMemoryFilesystemAccess(fullPath);
              const content = readUnprotectedFileSync(fullPath, 'utf-8');
              const data = JSON.parse(content);
              objects = data.objects || [];
            }
          }
        } catch (err) {
          console.error('[WorldBuilder] loading world objects failed', safeErrorFields(err));
        }
      }

      return reply.send({
        world: {
          id: world.id,
          name: world.name,
          description: world.description,
          objects,
          created_at: world.created_at,
          updated_at: world.updated_at,
        },
      });
    } catch (error: any) {
      console.error('[WorldBuilder] GET /api/world-builder/:id failed', safeErrorFields(error));
      return reply.status(500).send({ error: 'Failed to get world' });
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // POST /api/world-builder
  // Create new world
  // ────────────────────────────────────────────────────────────────────
  fastify.post('/api/world-builder', async (request, reply) => {
    try {
      fastify.log.info('[World Builder API] 🔍 POST /api/world-builder called');
      fastify.log.info({ detail: JSON.stringify(request.body, null, 2) }, '[World Builder API] 🔍 Request body:');

      const userId = getUserIdFromRequest(request);
      fastify.log.info({ detail: userId }, '[World Builder API] 🔍 User ID from JWT:');

      if (!userId) {
        fastify.log.error('[World Builder API] ❌ Unauthorized - no user ID');
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { name, description, objects } = request.body as {
        name: string;
        description?: string;
        objects: any[];
      };

      fastify.log.info('[World Builder API] 🔍 Parsed data:');
      fastify.log.info({ detail: name }, '[World Builder API] 🔍 - name:');
      fastify.log.info({ detail: description }, '[World Builder API] 🔍 - description:');
      fastify.log.info({ detail: objects }, '[World Builder API] 🔍 - objects:');

      if (!name) {
        fastify.log.error('[World Builder API] ❌ World name is missing!');
        return reply.status(400).send({ error: 'World name is required' });
      }

      const timestamp = Date.now();
      const worldId = `world_${timestamp}`;

      fastify.log.info({ detail: worldId }, '[World Builder API] 🔍 Generated world ID:');

      // Save objects to file
      const fs = await import('fs');
      const path = await import('path');

      const storagePath = worldsDir();
      fastify.log.info({ detail: storagePath }, '[World Builder API] 🔍 Storage path:');

      if (!fs.existsSync(storagePath)) {
        fastify.log.info('[World Builder API] 📁 Creating storage directory...');
        fs.mkdirSync(storagePath, { recursive: true });
      }

      const filename = `world-builder-${timestamp}.json`;
      const filepath = path.join(storagePath, filename);
      const worldData = {
        name,
        description,
        objects,
        created_at: new Date().toISOString(),
      };

      fastify.log.info({ detail: filepath }, '[World Builder API] 💾 Writing file:');
      fs.writeFileSync(filepath, JSON.stringify(worldData, null, 2));
      fastify.log.info('[World Builder API] ✅ File written successfully');

      // Create the storage file record and the world row (one transaction)
      const fileId = `file_${timestamp}`;
      fastify.log.info('[World Builder API] 💾 Creating storage_files + user_worlds records...');
      await createWorldWithFile({
        worldId,
        userId,
        name,
        description: description || '',
        isPublic: 0, // private by default
        maxPlayers: 1, // single player
        file: { id: fileId, filename, sizeBytes: JSON.stringify(worldData).length, description: `World Builder: ${name}` },
      });
      fastify.log.info('[World Builder API] ✅ user_worlds record created');

      const response = {
        world: {
          id: worldId,
          name,
          description,
          objects,
        },
      };

      fastify.log.info('[World Builder API] ✅ POST successful!');
      fastify.log.info({ detail: JSON.stringify(response, null, 2) }, '[World Builder API] 🔍 Response:');

      return reply.send(response);
    } catch (error: any) {
      return sendInternalError(reply, '[WorldBuilder] POST /api/world-builder', error);
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // PUT /api/world-builder/:id
  // Update existing world
  // ────────────────────────────────────────────────────────────────────
  fastify.put('/api/world-builder/:id', async (request, reply) => {
    try {
      fastify.log.info('[World Builder API] 🔍 PUT /api/world-builder/:id called');

      const userId = getUserIdFromRequest(request);
      fastify.log.info({ detail: userId }, '[World Builder API] 🔍 User ID from JWT:');

      if (!userId) {
        fastify.log.error('[World Builder API] ❌ Unauthorized - no user ID');
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { id } = request.params as { id: string };
      const { name, description, objects } = request.body as {
        name: string;
        description?: string;
        objects: any[];
      };

      fastify.log.info({ detail: id }, '[World Builder API] 🔍 World ID:');
      fastify.log.info({ detail: { name, description, objectsCount: objects?.length } }, '[World Builder API] 🔍 Update data:');

      // Check if world exists and belongs to user
      const world = await findOwnedWorld(id, userId);

      fastify.log.info({ detail: world }, '[World Builder API] 🔍 Existing world:');

      if (!world) {
        fastify.log.error('[World Builder API] ❌ World not found or unauthorized');
        return reply.status(404).send({ error: 'World not found' });
      }

      // Update file content
      if (world.glb_file_id) {
        fastify.log.info('[World Builder API] 💾 Updating file content...');

        // Contained under the storage dir (B2.2d-10): a stored key that
        // leaves it is never written to.
        const fullPath = await worldFilePath(world.glb_file_id);

        if (fullPath) {
          const fs = await import('fs');

          fastify.log.info({ detail: fullPath }, '[World Builder API] 🔍 File full path:');

          const worldData = {
            name,
            description,
            objects,
            updated_at: new Date().toISOString(),
          };

          fs.writeFileSync(fullPath, JSON.stringify(worldData, null, 2));
          fastify.log.info('[World Builder API] ✅ File updated successfully');
        } else {
          fastify.log.warn({ detail: world.glb_file_id }, '[World Builder API] ⚠️ No file record found for glb_file_id:');
        }
      } else {
        fastify.log.warn('[World Builder API] ⚠️ No glb_file_id in world record');
      }

      // Update world record
      fastify.log.info('[World Builder API] 💾 Updating user_worlds record...');
      await updateWorldMeta(id, userId, name, description || '');
      fastify.log.info('[World Builder API] ✅ user_worlds record updated');

      const response = {
        world: {
          id,
          name,
          description,
          objects,
        },
      };

      fastify.log.info('[World Builder API] ✅ PUT successful!');
      fastify.log.info({ detail: JSON.stringify(response, null, 2) }, '[World Builder API] 🔍 Response:');

      return reply.send(response);
    } catch (error: any) {
      return sendInternalError(reply, '[WorldBuilder] PUT /api/world-builder/:id', error);
    }
  });
}
