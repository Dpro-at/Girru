/**
 * A generic OpenAI-compatible model server on this computer (STORE-MAP-01
 * P2b, LOCAL-ONLY-01): llama.cpp `llama-server`, vLLM, LocalAI and the like.
 *
 * Like LM Studio it is reached on the IPv4 loopback only:
 * `GIRRU_LOCAL_OPENAI_URL` must be a loopback http URL (for example
 * `http://127.0.0.1:8080/v1`), anything else is ignored and the provider is
 * not available. Chat model ids carry the prefix `openai-local:`
 * (`openai-local:qwen3-8b`). The turn runs the same OpenAI-compatible loop as
 * LM Studio (services/lmstudio-agent-loop.ts). Only while GIRRU_STORE_P2B is on.
 *
 *   GIRRU_LOCAL_OPENAI_URL       base URL, loopback only
 *   GIRRU_LOCAL_OPENAI_CONTEXT   the model's window in tokens when the server does not say
 */

export const OPENAI_LOCAL_PREFIX = 'openai-local:';
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:@\/-]{0,119}$/;

function loopbackHttp(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password || u.search || u.hash) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** The configured base URL, or '' when none (or not loopback) is set. */
export function openAiLocalUrl(env: NodeJS.ProcessEnv = process.env): string {
  const set = (env.GIRRU_LOCAL_OPENAI_URL ?? '').trim();
  return (set && loopbackHttp(set)) || '';
}

export const isOpenAiLocalModelId = (id: string | null | undefined): boolean => typeof id === 'string' && id.startsWith(OPENAI_LOCAL_PREFIX);

/** The model name the server knows ('' when the id is not one). */
export function openAiLocalModelName(id: string): string {
  if (!isOpenAiLocalModelId(id)) return '';
  const name = id.slice(OPENAI_LOCAL_PREFIX.length);
  return MODEL.test(name) ? name : '';
}

export function openAiLocalNotRunningMessage(env: NodeJS.ProcessEnv = process.env): string {
  const url = openAiLocalUrl(env);
  return url ? `The local model server on ${new URL(url).host} is not answering. Start it, then send again.`
    : 'No local model server is set. Set GIRRU_LOCAL_OPENAI_URL to its loopback address.';
}
