import {subscriptionEnabled,subscriptionBinary,subscriptionVariants,subscriptionModel} from './subscription-chat.js';
import { getSettingsManager } from '../settings/index.js';
import { listLocalModels } from '../llm/local-models.js';
import { LMSTUDIO_PREFIX, listLmStudioModels, isLmStudioModelId, lmStudioModelName } from '../llm/lmstudio.js';
import { hasGlobalProviderApiKey } from '../credentials/authority.js';

/** Existing model enumeration, shared by display and server-resolved selection. */
export async function loadModelCatalogue() {
  const settingsManager = getSettingsManager();
  const settings = await settingsManager.getSettings();

  const allModels: any[] = [];
  if(subscriptionEnabled())for(const kind of ['claude','codex','gemini'] as const)if(await subscriptionBinary(kind))allModels.push({id:'subscription:'+kind,provider:'subscription',...(kind==='gemini'?{}:{sessionPrefix:'subscription:'+kind+':'}),label:kind==='claude'?'Claude Code · existing account':kind==='codex'?'Codex · existing ChatGPT account':'Google Gemini · Antigravity account',size:'',variants:await subscriptionVariants(kind),think:true});

  // 1. Add Ollama chat models (if available). Embedding models are left
  // out: they cannot answer a chat (CORE-MODEL-01).
  try {
    const ollamaModels = (await listLocalModels()).filter((m) => m.chat).map((m) => ({
      id: m.name,
      name: `🏠 ${m.name}`,
      provider: 'local',
      size: formatSize(m.size),
      modifiedAt: m.modifiedAt,
      details: m.details,
      // CH3: only a model that says it can think gets the Thinking choice.
      ...(m.capabilities.includes('thinking') ? { think: true } : {}),
      available: true,
    }));
    allModels.push(...ollamaModels);
  } catch (error) {
    console.log('[Models] Ollama not available');
  }

  // 1b. LM Studio models on this computer (CHAT-PRO-02 G): listed only
  // while its local server answers; ids carry the `lmstudio:` prefix.
  const lmStudio = await listLmStudioModels();
  allModels.push(...lmStudio.models.map((id) => ({
    id: `${LMSTUDIO_PREFIX}${id}`,
    name: id,
    provider: 'lmstudio',
    size: '',
    available: true,
  })));

  // 2. Add Claude models (if API key configured)
  if (await hasGlobalProviderApiKey('claude')) {
    const claudeModels = [
      {
        id: 'claude-opus-4-6',
        name: '🧠 Claude Opus 4.6',
        provider: 'claude',
        description: 'Most powerful, best for complex tasks',
        size: 'API',
        think: true,
        available: true,
      },
      {
        id: 'claude-sonnet-4-5-20250929',
        name: '🧠 Claude Sonnet 4.5',
        provider: 'claude',
        description: 'Balanced performance and speed',
        size: 'API',
        think: true,
        available: true,
      },
      {
        id: 'claude-haiku-4-5-20251001',
        name: '🧠 Claude Haiku 4.5',
        provider: 'claude',
        description: 'Fastest, great for simple tasks',
        size: 'API',
        think: true,
        available: true,
      },
    ];
    allModels.push(...claudeModels);
  }

  // 3. Add OpenAI models (if API key configured)
  if (await hasGlobalProviderApiKey('openai')) {
    const openaiModels = [
      {
        id: 'gpt-4-turbo',
        name: '🤖 GPT-4 Turbo',
        provider: 'openai',
        description: 'Most capable OpenAI model',
        size: 'API',
        available: true,
      },
      {
        id: 'gpt-4',
        name: '🤖 GPT-4',
        provider: 'openai',
        description: 'Standard GPT-4 model',
        size: 'API',
        available: true,
      },
      {
        id: 'gpt-3.5-turbo',
        name: '🤖 GPT-3.5 Turbo',
        provider: 'openai',
        description: 'Fast and efficient',
        size: 'API',
        available: true,
      },
    ];
    allModels.push(...openaiModels);
  }

  // Return all models with active provider info
  return {
    models: allModels,
    activeProvider: settings.provider,
    defaultModel: settings[settings.provider]?.model || allModels[0]?.id,
  };
}

function formatSize(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)}GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)}MB`;
}

export class ModelSelectionError extends Error {}
/** Exact trusted catalogue membership, never inference from a client model name. */
export function canonicalModelSelection(id: unknown, models: readonly { id: string; provider: string; available?: boolean }[]): { model: string; provider: string } {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@\/-]{0,99}$/.test(id)) throw new ModelSelectionError('invalid_model');
  const matches = models.filter(m => m.id === id && m.available !== false);
  if (matches.length !== 1) throw new ModelSelectionError('invalid_model');
  const selected = matches[0];
  const provider = selected.provider === 'local' ? 'ollama' : selected.provider;
  if (!['ollama', 'claude', 'lmstudio', 'subscription'].includes(provider)) throw new ModelSelectionError('invalid_model');
  if (subscriptionModel(id) !== (provider === 'subscription') || (provider === 'lmstudio' && !lmStudioModelName(id)) || isLmStudioModelId(id) !== (provider === 'lmstudio')) throw new ModelSelectionError('invalid_model');
  return { model: selected.id, provider };
}
