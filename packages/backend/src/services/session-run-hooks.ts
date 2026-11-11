/** CP15: a run that continues a chat after the owner decided an approval tells the places that wait for that chat
 *  (a task from another computer) that it finished. Errors in a listener never reach the chat. */
type Listener = (sessionId: string, runId: string, status: string) => Promise<void> | void;
const listeners = new Set<Listener>();
export function onSessionRunFinished(fn: Listener): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
export async function sessionRunFinished(sessionId: string, runId: string, status: string): Promise<void> {
  for (const fn of [...listeners]) { try { await fn(sessionId, runId, status); } catch { /* the chat itself is done either way */ } }
}
