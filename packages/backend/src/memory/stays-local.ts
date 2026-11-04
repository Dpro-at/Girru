/**
 * STORE-MAP-01 P9 (PRIV2, D23): "Stays on this computer", enforced
 * (GIRRU_STORE_P9).
 *
 * A Memory place whose switch is on (People by default; place-settings.ts)
 * reaches only a model on this computer. Before a reply for any other model
 * (a provider's API, a coding app's subscription, an MCP client), its drawers
 * leave the turn: no recall, no memory tool, no pinned fact of that place.
 * There is no fallback that sends them elsewhere: a local reply that fails
 * does not retry with an online model while it holds them.
 *
 * Where a model runs is decided by trusted configuration only: Ollama is
 * local when OLLAMA_URL is a loopback address and the model is not one of
 * Ollama's cloud models (a `cloud` tag, e.g. `gpt-oss:120b-cloud`, runs on
 * Ollama's servers); LM Studio is always loopback; every other provider is
 * not local, whatever its name or a request says.
 */

import { openAiLocalUrl } from '../llm/openai-local.js';
import { isLoopbackUrl } from './embedding.js';
import { OLLAMA_URL } from '../llm/ollama.js';
import { localOnlyPlaces, placeOfDrawer } from './place-settings.js';
import type { DrawerRef } from './drawers.js';

/** An Ollama model that runs on Ollama's servers, not here (`…:cloud`, `…-cloud`). */
const OLLAMA_CLOUD_MODEL = /(^|[:-])cloud$/i;

/** True only for a model that runs on this computer (`model` given: also that it is not a cloud model). */
export function providerIsLocal(provider: string | null | undefined, model?: string | null): boolean {
  if (provider === 'lmstudio') return true;
  // STORE-MAP-01 P2b: the generic OpenAI-compatible server is used only on a loopback address.
  if (provider === 'openai-local') return !!openAiLocalUrl();
  if (provider === 'ollama') return isLoopbackUrl(OLLAMA_URL) && !(typeof model === 'string' && OLLAMA_CLOUD_MODEL.test(model.trim()));
  return false;
}

/** The drawers a reply for a model that is not local may read, and the ones withheld. */
export async function cloudSafeDrawers(ownerId: string, drawers: DrawerRef[]): Promise<{ drawers: DrawerRef[]; withheld: DrawerRef[] }> {
  if (drawers.length === 0) return { drawers, withheld: [] };
  const local = await localOnlyPlaces(ownerId);
  if (local.size === 0) return { drawers, withheld: [] };
  const keep: DrawerRef[] = [];
  const withheld: DrawerRef[] = [];
  for (const d of drawers) (local.has(placeOfDrawer(d)) ? withheld : keep).push(d);
  return { drawers: keep, withheld };
}

/**
 * Pinned facts for a reply for a model that is not local: company facts only
 * when the Company place may leave, project (and its department's) facts only
 * when that project's place may leave. `projectKey` is the project drawer's key.
 */
export async function cloudSafePinnedAllow<T extends { company: boolean; project: boolean; department?: boolean }>(
  ownerId: string, projectKey: string | null, allow: T,
): Promise<T> {
  const local = await localOnlyPlaces(ownerId);
  const projectLocal = !!projectKey && local.has(placeOfDrawer({ kind: 'project', key: projectKey }));
  return {
    ...allow,
    company: allow.company && !local.has('company'),
    project: allow.project && !projectLocal,
    ...(allow.department !== undefined ? { department: allow.department && !projectLocal } : {}),
  };
}
