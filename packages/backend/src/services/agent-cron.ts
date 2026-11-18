import {isEncryptedMemoryProfileSelected} from '../memory/encryption/consumer-host.js';
import {createScheduledEncryptedRun} from '../agent/execution/stored-run-scheduler.js';
import {withStoredRunControl} from '../agent/execution/stored-run-entry.js';
/**
 * Agent Cron Service
 *
 * Runs scheduled heartbeats for agents that have cron_enabled=1.
 * On each tick: checks for assigned tasks → executes via agentic loop.
 *
 * Uses node-cron (already installed). Non-streaming execution —
 * results are stored back on the orchestrator task, not streamed to a client.
 */

import { backgroundEnabled } from '../config/background.js';
import cron from 'node-cron';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { all, one, run, sql } from '../repositories/sql-steps.js';
import { getOrchestrator } from '../multi-agent/index.js';
import { logActivity } from './activity-logger.js';
import { resolveProviderApiKey } from '../credentials/authority.js';
import { createRun } from './task-runs.js';
import { contractPrompt, getTaskContract } from './task-contracts.js';
import { backgroundPaidPurposes, modelCall, type PaidProviderConfig } from '../llm/model-call.js';
import { executeTaskRun, type AgentRow } from './task-run-executor.js';
import { storeP4Enabled } from './store-p4.js';
import { resolveAgentContext } from '../agent/context/resolve.js';
import { renderSystemPrompt } from '../agent/context/render.js';

const HEARTBEAT_OK_TOKEN = 'HEARTBEAT_OK';
const HEARTBEAT_ACK_MAX_CHARS = 300;

/**
 * Read HEARTBEAT.md from the workspace directory.
 * Checks per-agent file first (HEARTBEAT-{agentName}.md), then global HEARTBEAT.md.
 * Returns null if no file exists or the file is effectively empty (only headings/blank lines).
 */
function readHeartbeatFile(agentName: string): string | null {
  const workspaceDir = process.cwd();
  const candidates = [
    path.join(workspaceDir, `HEARTBEAT-${agentName}.md`),
    path.join(workspaceDir, 'HEARTBEAT.md'),
  ];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, 'utf-8');
    // Skip effectively empty files (only blank lines and markdown headings)
    const stripped = content.replace(/^#+\s.*$/gm, '').trim();
    if (!stripped) continue;
    return content.trim();
  }
  return null;
}

/**
 * Run a lightweight heartbeat check for an agent when no tasks are assigned.
 * Sends the HEARTBEAT.md checklist to the agent; logs an alert if the agent
 * returns anything other than a HEARTBEAT_OK acknowledgment.
 */
export async function runHeartbeat(agent: AgentRow, heartbeatContent: string): Promise<void> {
 if(isEncryptedMemoryProfileSelected()){await withStoredRunControl(async()=>{const run=await createScheduledEncryptedRun({kind:'agent-cron',agentId:agent.id});if(!run)throw Error('background_native_parent_required');await executeTaskRun(run.id);});return;}
  // STORE-MAP-01 P4 (D16): the heartbeat uses the agent's one context (no owner memory); off, as before.
  const systemPrompt = storeP4Enabled()
    ? await resolveAgentContext({ agentId: agent.id, entry: 'heartbeat', ownerId: null }).then((ctx) => renderSystemPrompt(ctx), () => agent.system_prompt ?? `You are ${agent.name}, an AI agent.`)
    : agent.system_prompt ?? `You are ${agent.name}, an AI agent.`;
  const prompt =
    `Read the HEARTBEAT.md checklist below. Follow it strictly. ` +
    `Do not infer or repeat old tasks from prior context. ` +
    `If nothing needs attention, reply with exactly: HEARTBEAT_OK\n\n` +
    `## HEARTBEAT.md\n${heartbeatContent}`;

  // R2.2 / D-BUDGET / Q-16 (provisional): a heartbeat is a background call
  // and runs on the free local model. The agent's own paid model provider is
  // used only when the owner listed `heartbeat` in BACKGROUND_PAID_PURPOSES,
  // and then through the daily cap (refused -> local model).
  let paid: PaidProviderConfig | null = null;
  if (agent.provider === 'claude' && backgroundPaidPurposes().has('heartbeat')) {
    // SECURITY (S1.1): key from the credential authority (agent's own key,
    // then the historical cron fallback row); never another agent's key.
    const apiKey = await resolveProviderApiKey('claude', { agentId: agent.id, noGlobal: true, legacySettingsRow: 'claude_api_key' });
    if (apiKey) paid = { provider: 'claude', model: agent.model, apiKey };
  }
  const response = await modelCall({ actor: agent.id }, {
    purpose: 'heartbeat',
    prompt,
    system: systemPrompt,
    maxOutputTokens: 1024,
    temperature: agent.temperature,
    paid,
  });
  if (response.refused) console.log(`[AgentCron] 💤 Paid heartbeat for "${agent.name}" refused: ${response.refused}`);
  if (!response.ok) {
    console.warn(`[AgentCron] ⚠️  Heartbeat model error for "${agent.name}": ${response.error}`);
    return;
  }

  const reply: string = (response.text ?? '').trim();

  // Detect HEARTBEAT_OK at start or end
  const startsOk = reply.startsWith(HEARTBEAT_OK_TOKEN);
  const endsOk = reply.endsWith(HEARTBEAT_OK_TOKEN);

  if (startsOk || endsOk) {
    const withoutToken = reply
      .replace(/^HEARTBEAT_OK\s*/i, '')
      .replace(/\s*HEARTBEAT_OK$/i, '')
      .trim();
    if (withoutToken.length <= HEARTBEAT_ACK_MAX_CHARS) {
      // Silent acknowledgment — nothing to report
      console.log(`[AgentCron] 💓 "${agent.name}" heartbeat OK`);
      return;
    }
  }

  // Agent sent an alert — log it as activity so it shows in the feed
  console.log(`[AgentCron] 🔔 Heartbeat ALERT from "${agent.name}": ${reply.slice(0, 120)}`);
  await logActivity({
    agentId: agent.id,
    actionType: 'task_completed',
    summary: `[HEARTBEAT] ${reply.slice(0, 200)}`,
  });
}

export type { AgentRow } from './task-run-executor.js';
export { delegatingAgents } from './task-run-executor.js';

const activeJobs = new Map<string, ReturnType<typeof cron.schedule>>();

/**
 * Run a single task for a given agent as a durable task run (CORE-08):
 * every model and tool call is a recorded step, so after a restart the run
 * resumes (startTaskRunRecovery) without repeating completed actions.
 * Returns the final output (or the reason it stopped). Exported for tests.
 */
export function runAgentTask(agent:AgentRow,taskId:string,taskDescription:string):Promise<string>{return withStoredRunControl(()=>runAgentTaskInControl(agent,taskId,taskDescription));}
async function runAgentTaskInControl(agent: AgentRow, taskId: string, taskDescription: string): Promise<string> {
  const encryptedRun=isEncryptedMemoryProfileSelected()?await createScheduledEncryptedRun({kind:'task',taskId},taskId):null;
  const orchestrator = getOrchestrator();

  // Mark task as in-progress
  orchestrator.startTask(taskId);
  await logActivity({
    agentId: agent.id,
    taskId,
    actionType: 'task_started',
    summary: `Agent ${agent.name} started task`,
  });

  // R1: the task's contract (if any) is pinned on the run and shown to the model.
  const contract = await getTaskContract(taskId);
  const prompt = contract ? `${taskDescription}\n${contractPrompt(contract)}` : taskDescription;
  const run = encryptedRun??await createRun({ taskId, agentId: agent.id, userId: null, prompt, contract });
  const res = await executeTaskRun(run.id);
  if(res.reason==='native-background-delegation-required')return `Task run ${run.id} remains queued until native background consent and an unlocked profile are available.`;
  if (res.status === 'waiting_approval') return `Task run ${run.id} is waiting for the owner (${res.reason}).`;
  if (res.status === 'not_claimed' || res.status === 'lease_lost') return `Task run ${run.id} is being executed by another worker.`;
  if (res.verification === 'needs_review') return `${res.output ?? ''}\n\n(Task run ${run.id} is waiting for a review.)`;
  return res.output ?? res.reason ?? '';
}

/**
 * Register cron heartbeat for a single agent.
 */
function registerAgentCron(agent: AgentRow): void {
  // Remove existing job if re-registering
  const existing = activeJobs.get(agent.id);
  if (existing) {
    existing.stop();
    activeJobs.delete(agent.id);
  }

  if (!cron.validate(agent.cron_schedule)) {
    console.warn(`[AgentCron] ⚠️  Invalid cron schedule for agent "${agent.name}": ${agent.cron_schedule}`);
    return;
  }

  // RUN-ISO F2: AGENT_PLAYER_BACKGROUND=off schedules nothing.
  if (!backgroundEnabled()) return;

  const task = cron.schedule(agent.cron_schedule, async () => withStoredRunControl(async()=>{
    // Update last_heartbeat (timestamptz on PostgreSQL; CURRENT_TIMESTAMP on both drivers)
    await sql().read(run(`UPDATE agents_config SET last_heartbeat = CURRENT_TIMESTAMP WHERE id = ?`, agent.id));

    // Check for an assigned task
    const orchestrator = getOrchestrator();
    const tasks = orchestrator.listTasks({ assignedTo: agent.id, status: 'assigned', limit: 1 });

    if (tasks.length === 0) {
      // No tasks assigned — run heartbeat check if HEARTBEAT.md exists
      if(isEncryptedMemoryProfileSelected()){try{await runHeartbeat(agent,'');}catch(error:any){console.warn('[AgentCron] Native background delegation required',error?.message);}return;}
      const heartbeatContent = readHeartbeatFile(agent.name);
      if (heartbeatContent) {
        try {
          await runHeartbeat(agent, heartbeatContent);
        } catch (err: any) {
          console.warn(`[AgentCron] ⚠️  Heartbeat error for "${agent.name}": ${err.message}`);
        }
      }
      return;
    }

    const pendingTask = tasks[0];
    console.log(`[AgentCron] 🔄 Agent "${agent.name}" picked up task: "${pendingTask.title}"`);

    try {
      // Build task prompt — include upstream pipeline output if available
      let taskPrompt = `${pendingTask.title}\n\n${pendingTask.description}`;
      const taskInput = pendingTask.input as Record<string, unknown> | undefined;
      if (taskInput?._upstream && typeof taskInput._upstream === 'object') {
        const upstream = JSON.stringify(taskInput._upstream, null, 2);
        taskPrompt += `\n\n## Results from Previous Tasks (Pipeline Input)\n\`\`\`json\n${upstream}\n\`\`\`\nUse these results as context for your work.`;
      }

      await runAgentTask(agent, pendingTask.id, taskPrompt);
      console.log(`[AgentCron] ✅ Task "${pendingTask.title}" completed`);
    } catch (err: any) {
      console.error(`[AgentCron] ❌ Task "${pendingTask.title}" failed:`, err.message);
    }
  }));

  activeJobs.set(agent.id, task);
  console.log(`[AgentCron] ⏰ Registered cron for agent "${agent.name}" (${agent.cron_schedule})`);
}

/**
 * Start the agent cron service.
 * Called once at server startup.
 */
export async function startAgentCronService(): Promise<void> {
  const agents = await sql().read(all<AgentRow>(`
    SELECT id, name, model, provider, system_prompt, temperature, max_tokens, cron_schedule, cron_enabled
    FROM agents_config
    WHERE cron_enabled = 1 AND cron_schedule IS NOT NULL
  `));

  if (agents.length === 0) {
    console.log('[AgentCron] ℹ️  No agents with cron enabled at startup');
    return;
  }

  for (const agent of agents) {
    registerAgentCron(agent);
  }

  console.log(`[AgentCron] ✅ Started ${agents.length} agent cron job(s)`);
}

/**
 * Refresh cron jobs when an agent's config changes.
 * Call this from the agents-config PUT route when cron fields are updated.
 */
export async function refreshAgentCron(agentId: string): Promise<void> {
  const agent = await sql().read(one<AgentRow>(`
    SELECT id, name, model, provider, system_prompt, temperature, max_tokens, cron_schedule, cron_enabled
    FROM agents_config WHERE id = ?
  `, agentId));

  if (!agent) return;

  if (agent.cron_enabled && agent.cron_schedule) {
    registerAgentCron(agent);
  } else {
    // Disable cron
    const existing = activeJobs.get(agentId);
    if (existing) {
      existing.stop();
      activeJobs.delete(agentId);
      console.log(`[AgentCron] 🛑 Stopped cron for agent "${agent.name}"`);
    }
  }
}
