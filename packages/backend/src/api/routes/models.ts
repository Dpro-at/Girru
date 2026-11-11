import { loadModelCatalogue } from '../../services/model-catalogue.js';

/**
 * Models API Routes
 * Lists available AI models from all providers
 */

import type { FastifyInstance } from 'fastify';

import { OLLAMA_URL } from '../../llm/ollama.js';

import { listLmStudioModels } from '../../llm/lmstudio.js';
import { getEnvProviderApiKey } from '../../credentials/authority.js';

export async function modelsRoutes(fastify: FastifyInstance) {
  // GET /api/models - List ALL available models from ALL providers
  fastify.get('/api/models', async (request, reply) => {
    try { return await loadModelCatalogue(); } catch (error) {
      console.error('[Models] Error loading models:', error);
      return reply.status(500).send({
        error: 'Failed to load models',
        message: 'Check your configuration'
      });
    }
  });

  // GET /api/models/providers - List available providers
  fastify.get('/api/models/providers', async () => {
    const providers = [
      { name: 'ollama', available: await checkOllama() },
      { name: 'lmstudio', available: (await listLmStudioModels()).running },
      { name: 'openai', available: !!getEnvProviderApiKey('openai') },
      { name: 'anthropic', available: !!getEnvProviderApiKey('claude') },
    ];
    return { providers };
  });
}

// Helper: Check if Ollama is running
async function checkOllama(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000)
    });
    return res.ok;
  } catch {
    return false;
  }
}
