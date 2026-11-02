import { randomUUID } from 'node:crypto';
import { all, run, sql } from '../repositories/sql-steps.js';
import { getEncryptionService } from '../credentials/encryption.js';
import type { ToolResult } from '../tools/types.js';
import { currentChatRun } from './chat-run-context.js';

export async function startTeamResult(scope: { owner: string; session: string; coordinator: string; agent: string; model: string }): Promise<string> {
  const id = randomUUID();
  const parent = currentChatRun()?.runId;
  await sql().read(run("INSERT INTO team_delegation_results(id,owner_id,session_id,coordinator_id,agent_id,model,status,parent_run_id) VALUES(?,?,?,?,?,?,'started',?)", id, scope.owner, scope.session, scope.coordinator, scope.agent, scope.model, parent ? `chat:${parent}` : null));
  return id;
}

export async function finishTeamResult(id: string, result: ToolResult): Promise<void> {
  const status = result.error ? 'failed' : result.details?.status === 'pending_approval' ? 'waiting_approval' : 'answered';
  const encrypted = await getEncryptionService().encrypt(JSON.stringify(result));
  await sql().read(run('UPDATE team_delegation_results SET status=?,result_encrypted=?,result_iv=?,result_tag=?,ended_at=? WHERE id=? AND status=?', status, encrypted.encrypted, encrypted.iv, encrypted.authTag, new Date().toISOString(), id, 'started'));
}

/** Only the same owner's conversation and coordinator can read a child receipt. */
export async function teamResults(owner: string, session: string, coordinator: string) {
  const rows = await sql().read(all<{ id: string; agent_id: string; model: string; status: string; result_encrypted: string | null; result_iv: string | null; result_tag: string | null }>('SELECT id,agent_id,model,status,result_encrypted,result_iv,result_tag FROM team_delegation_results WHERE owner_id=? AND session_id=? AND coordinator_id=? ORDER BY created_at DESC,id DESC LIMIT 5', owner, session, coordinator));
  const results = [];
  for (const row of rows) {
    const result = row.result_encrypted && row.result_iv && row.result_tag
      ? JSON.parse(await getEncryptionService().decrypt(row.result_encrypted, row.result_iv, row.result_tag)) as ToolResult : null;
    results.push({ id: row.id, agentId: row.agent_id, model: row.model, status: row.status, result });
  }
  return results;
}
