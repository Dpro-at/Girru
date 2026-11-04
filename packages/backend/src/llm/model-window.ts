/**
 * The real context window of a local chat model (STORE-MAP-01 P2b,
 * LOCAL-ONLY-01 item 2). Many local models have 8k–32k tokens, so the turn
 * budget follows the model instead of a fixed number.
 *
 *  - Ollama: POST /api/show → model_info `<arch>.context_length` (what the
 *    model was trained for) and a `num_ctx` the owner set in its Modelfile.
 *  - LM Studio: GET /api/v0/models/<id> → `loaded_context_length` (what it
 *    was loaded with), else `max_context_length`.
 *  - A generic OpenAI-compatible server: `GIRRU_LOCAL_OPENAI_CONTEXT` when
 *    set; else GET <base>/models (vLLM `max_model_len`, `context_length`,
 *    llama.cpp `meta.n_ctx_train`) and llama.cpp GET /props (`n_ctx`).
 *
 * The window used is the smallest of: what the model reports, a num_ctx the
 * owner set, and CHAT_NUM_CTX (the RAM limit, default 32768). Unknown → the
 * safe 8192. Results are cached per server and model for ten minutes; a
 * lookup never throws and gives up after 1.5 s.
 */

import { contextBudget } from '../memory/context/budget.js';

export type WindowSource = 'ollama_show' | 'ollama_modelfile' | 'lmstudio' | 'openai_models' | 'llamacpp_props' | 'config' | 'fallback';
export interface ModelWindow { tokens: number; reported: number | null; source: WindowSource }

export const FALLBACK_WINDOW = 8192;
const MIN_WINDOW = 2048;
const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: ModelWindow }>();

export function clearModelWindowCache(): void { cache.clear(); }

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= 256 && n <= 10_000_000 ? Math.floor(n) : null;
};

/** Cap by the RAM limit (CHAT_NUM_CTX) and keep it at least 2048. */
function finish(reported: number | null, source: WindowSource, limit?: number | null, env: NodeJS.ProcessEnv = process.env): ModelWindow {
  const ram = contextBudget(env).numCtx;
  const base = reported ?? FALLBACK_WINDOW;
  const tokens = Math.max(MIN_WINDOW, Math.min(base, ram, limit ?? Number.POSITIVE_INFINITY));
  return { tokens, reported, source: reported === null ? 'fallback' : source };
}

async function getJson(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<any | null> {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(1500) });
    if (!res.ok) { try { await res.body?.cancel(); } catch { /* ignore */ } return null; }
    return await res.json();
  } catch {
    return null;
  }
}

async function cached(key: string, load: () => Promise<ModelWindow>): Promise<ModelWindow> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** The Modelfile `num_ctx` in Ollama's parameters text, if any. */
export function modelfileNumCtx(parameters: unknown): number | null {
  if (typeof parameters !== 'string') return null;
  const m = /^\s*num_ctx\s+(\d+)\s*$/m.exec(parameters);
  return m ? num(m[1]) : null;
}

/** model_info `<arch>.context_length` (the architecture key first, then any key ending so). */
export function ollamaContextLength(info: unknown): number | null {
  if (!info || typeof info !== 'object') return null;
  const o = info as Record<string, unknown>;
  const arch = typeof o['general.architecture'] === 'string' ? o['general.architecture'] : '';
  if (arch && num(o[`${arch}.context_length`])) return num(o[`${arch}.context_length`]);
  for (const [k, v] of Object.entries(o)) if (k.endsWith('.context_length') && num(v)) return num(v);
  return null;
}

export async function ollamaWindow(url: string, model: string, opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<ModelWindow> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return cached(`ollama|${url}|${model}`, async () => {
    const data = await getJson(fetchImpl, `${url}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
    const reported = ollamaContextLength(data?.model_info);
    const set = modelfileNumCtx(data?.parameters);
    const w = finish(reported, 'ollama_show', set, opts.env);
    return set && set === w.tokens ? { ...w, source: 'ollama_modelfile' } : w;
  });
}

export async function lmStudioWindow(apiUrl: string, model: string, opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<ModelWindow> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const origin = new URL(apiUrl).origin;
  return cached(`lmstudio|${origin}|${model}`, async () => {
    const data = await getJson(fetchImpl, `${origin}/api/v0/models/${encodeURIComponent(model)}`);
    const reported = num(data?.loaded_context_length) ?? num(data?.max_context_length);
    return finish(reported, 'lmstudio', null, opts.env);
  });
}

export async function openAiCompatWindow(baseUrl: string, model: string, opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<ModelWindow> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const configured = num(env.GIRRU_LOCAL_OPENAI_CONTEXT);
  if (configured) return finish(configured, 'config', null, env);
  return cached(`openai|${baseUrl}|${model}`, async () => {
    const list = await getJson(fetchImpl, `${baseUrl}/models`);
    const rows: any[] = Array.isArray(list?.data) ? list.data : [];
    const row = rows.find((r) => r?.id === model) ?? (rows.length === 1 ? rows[0] : null);
    const fromList = num(row?.max_model_len) ?? num(row?.context_length) ?? num(row?.context_window) ?? num(row?.meta?.n_ctx_train);
    // llama.cpp: the window it was started with is in /props (smaller than n_ctx_train, and the one that counts).
    const props = await getJson(fetchImpl, `${new URL(baseUrl).origin}/props`);
    const fromProps = num(props?.default_generation_settings?.n_ctx) ?? num(props?.n_ctx);
    if (fromProps) return finish(fromList ? Math.min(fromList, fromProps) : fromProps, 'llamacpp_props', null, env);
    return finish(fromList, 'openai_models', null, env);
  });
}
