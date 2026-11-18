/** Compatibility response port for accepted turns. Authentication/admission and
 * replay belong to entry adapters. Implemented by HTTP and in-process run sinks.
 * Provider progress is separate from persisted run-event acknowledgement.
 */
import type { ServerResponse } from 'node:http';
export interface AgentReply {
  raw: ServerResponse;
  request?: unknown;
  code(status: number): AgentReply;
  status(status: number): AgentReply;
  send(body: unknown): AgentReply;
}
