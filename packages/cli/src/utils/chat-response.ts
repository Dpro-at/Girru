/** Transport projection only: accept the backend's JSON reply or completed SSE.
 * Tool/reasoning frames are never interpreted as execution instructions or shown
 * as the answer. A partial/error stream must not become a successful CLI reply.
 */
export function chatReplyText(value: unknown): string {
  if (value && typeof value === 'object' && 'message' in value) {
    const message = (value as { message?: { content?: unknown } }).message;
    if (typeof message?.content === 'string') return message.content;
  }
  if (typeof value !== 'string') throw new Error('Invalid backend chat response.');
  const answer: string[] = [];
  let done = false;
  for (const event of value.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    let frame: { type?: string; content?: unknown; done?: boolean; error?: unknown };
    try { frame = JSON.parse(data); } catch { throw new Error('Invalid backend chat response.'); }
    if (!frame || typeof frame !== 'object' || done) throw new Error('Invalid backend chat response.');
    if (frame.type === 'error' || frame.error !== undefined) throw new Error('Backend chat failed.');
    if ((frame.type === 'text' || frame.type === undefined) && typeof frame.content === 'string') answer.push(frame.content);
    if (frame.type === 'done' || frame.done === true) done = true;
  }
  if (!done) throw new Error('Backend chat response was interrupted.');
  return answer.join('');
}
