import { chatReplyText } from './chat-response.js';
/** Terminal adapter only: inference, context and authorization belong to the backend. */
export async function requestChat(options: {
  messages: { role: string; content: string }[];
  model?: string;
  sessionId: string;
  url?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const base = new URL(options.url ?? 'http://127.0.0.1:41522');
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('Use a loopback backend URL.');
  }
  if (!options.token?.trim()) throw new Error('Set AGENT_PLAYER_TOKEN to an authenticated backend session token.');
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(new URL('/api/chat', base), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.token}` },
      body: JSON.stringify({ messages: options.messages, sessionId: options.sessionId, stream: false, ...(options.model ? { model: options.model } : {}) }),
      signal: AbortSignal.timeout(240_000), redirect: 'error',
    });
  } catch { throw new Error('Cannot reach the backend.'); }
  if (!response.ok) throw new Error(response.status === 401 ? 'Backend session expired or invalid.' : `Chat failed (${response.status}).`);
  const text = await response.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  return chatReplyText(data);
}
