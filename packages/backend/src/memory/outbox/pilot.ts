/**
 * STORE-MAP-01 pilot switch: one project (and optionally one agent) runs on
 * the change log, the projection worker, the session capability and the
 * resolved agent context. Off unless the environment names them.
 *
 *   GIRRU_STORE_PILOT=<project id>        the pilot project
 *   GIRRU_STORE_PILOT_AGENT=<agent id>    the pilot agent (resolved context)
 */

export const STORE_PILOT_ENV = 'GIRRU_STORE_PILOT';
export const STORE_PILOT_AGENT_ENV = 'GIRRU_STORE_PILOT_AGENT';

const value = (name: string, env: NodeJS.ProcessEnv): string | null => {
  const v = String(env[name] ?? '').trim();
  return /^[A-Za-z0-9_.:-]{1,200}$/.test(v) ? v : null;
};

export function pilotProjectId(env: NodeJS.ProcessEnv = process.env): string | null {
  return value(STORE_PILOT_ENV, env);
}

export function pilotAgentId(env: NodeJS.ProcessEnv = process.env): string | null {
  return value(STORE_PILOT_AGENT_ENV, env);
}

export function isPilotProject(projectId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return !!projectId && projectId === pilotProjectId(env);
}

export function isPilotAgent(agentId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return !!agentId && agentId === pilotAgentId(env);
}
