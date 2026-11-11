/** Persisted checked run events. These differ from provider progress events and
 * from the frontend's narrower allowlisted projection. No event grants rights.
 */
export type AgentRunFrame = Record<string, unknown> & { type: string };
export interface AgentRunEvent { seq: number; frame: AgentRunFrame }
/** The backend journal sequence is authoritative, even if a frame contains seq. */
export function runEventWire(event: AgentRunEvent): AgentRunFrame & { seq: number } {
  return { ...event.frame, seq: event.seq };
}
