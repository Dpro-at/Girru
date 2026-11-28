/**
 * Memory helper tools (MEM-PANEL-01): the same actions as Memory › Memory helper
 * and Settings › Memory › Memory helper, with the same gates.
 *
 * memory_helper_status    read only: state, RAM (used / limit / available), the
 *                         night writer, tonight's work and last night per project
 * memory_helper_settings  change the RAM limit or the night writer ('settings' approval)
 * memory_night_run        start tonight's work now (Run now)
 * memory_night_stop       stop it at the end of the current step (Stop)
 *
 * Gates (all): the owner account, in the owner's own turn, never a turn that
 * answers an outsider (scopes.ts ownerGate). No memory text is returned.
 */

import type { Tool, ToolResult, ToolExecutionContext } from '../types.js';
import { memoryHelperEnabled } from '../../services/memory-helper-switch.js';
import { helperEmbeddingModel, memoryHelperRow, memoryHelperStatus, retryMemoryHelper } from '../../memory/helper.js';
import { GIB, HelperSettingsError, helperSettings, ramView, setHelperSettings, workerCandidates } from '../../memory/helper-settings.js';
import { lastNight, nightEvents, nightRunning, nightSettings, runNightWork, stopNightWorkFor } from '../../memory/night-work.js';
import { auditTool, ownerGate } from './scopes.js';

const fail = (tool: string, msg: string): ToolResult => ({ content: [{ type: 'text', text: `${tool} refused: ${msg}` }], error: msg });
const ok = (text: string, data: Record<string, unknown>): ToolResult => ({ content: [{ type: 'text', text }], data: { success: true, ...data } } as ToolResult);
const gb = (b: number | null) => (b === null ? 'unknown' : `${(b / GIB).toFixed(1)} GB`);

async function gated(tool: string, context: ToolExecutionContext | undefined, fn: (ownerId: string) => Promise<ToolResult>): Promise<ToolResult> {
  if (!memoryHelperEnabled()) return fail(tool, 'the memory helper is turned off on this installation');
  const gate = await ownerGate(context);
  if ('refused' in gate) return fail(tool, gate.refused);
  try { return await fn(gate.ownerId); } catch (err) {
    if (err instanceof HelperSettingsError) return fail(tool, `${err.code}: ${err.message}`);
    throw err;
  }
}

export const memoryHelperStatusTool: Tool = {
  name: 'memory_helper_status',
  description: `The memory helper (owner only, read only): its state (Ready, Checking, Learning, Needs you), the search
model, the RAM it uses and its RAM limit, free RAM, the night writer, whether tonight's work runs now, and what
last night read and wrote per project. While it runs: the step, the file it is on and the newest things it did (file
names and counts, no memory text). Use it to tell the owner what the helper is doing, before asking to Run now or to change the RAM limit.`,
  input_schema: { type: 'object', properties: {} },
  async execute(_params: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
    return gated('memory_helper_status', context, async (ownerId) => {
      const status = memoryHelperStatus(), row = memoryHelperRow(), ram = await ramView();
      const settings = helperSettings(), candidates = await workerCandidates(helperEmbeddingModel());
      const night = await nightSettings(ownerId), now = nightRunning(ownerId), last = await lastNight(ownerId), events = (await nightEvents(ownerId)).slice(0, 12);
      const lines = [
        `Memory helper: ${row.word} (search model ${status.model}).`,
        `RAM: models use ${gb(ram.modelsBytes)} of ${gb(ram.totalBytes)}; limit ${gb(ram.limitBytes)} (${ram.mode}); available ${gb(ram.availableBytes)}.`,
        `Night writer: ${status.worker ? `${status.worker.model} (${status.worker.phase})` : 'off'}.`,
        `Night work: ${night.enabled ? `${night.from}–${night.to}` : 'off'}${now.waiting ? `, due but waiting: too little free RAM (needs 2 GB free) since ${now.waiting.since.slice(11, 16)}` : ''}${now.running ? `, running now (${now.step ?? 'starting'}${now.now?.file ? `, reading ${now.now.file}` : ''}, ${now.now?.read ?? 0} files read so far)` : ''}.`,
        ...(events.length ? [`${now.running ? 'Doing now' : 'Last run'}, newest first:`, ...events.map((e) => `- ${e.at.slice(11, 16)} ${e.text}${e.project ? ` (${e.project})` : ''}`)] : []),
        last ? `Last night: ${last.files} files read, ${last.summaries.length} summaries, ${last.proposals} ideas wait in Needs you (stopped: ${last.stopped}).` : 'No night work yet.',
      ];
      return ok(lines.join('\n'), {
        phase: status.phase, word: row.word, needsYou: row.state === 'needs_you', model: status.model,
        ram, settings, candidates, worker: status.worker, night: { ...night, ...now }, last, events,
      });
    });
  },
};

export const memoryHelperSettingsTool: Tool = {
  name: 'memory_helper_settings',
  description: `Change the memory helper's settings, after the owner approves this call.
- ram: { mode: "auto" (a quarter of the computer's RAM) | "light" (about 1 GB, search only, night writer off) | "custom", customGb? (whole GB, with custom) }
- worker: a model already on this computer to be the night writer (it must fit in the RAM limit with the search model), or null for off.
Night hours are changed in Settings › Memory › Memory helper by the owner.`,
  input_schema: {
    type: 'object',
    properties: {
      ram: { type: 'object', properties: { mode: { type: 'string', enum: ['auto', 'light', 'custom'] }, customGb: { type: 'number' } }, required: ['mode'] },
      worker: { type: 'string', description: 'A model name; send an empty string for off' },
    },
  },
  async execute(params: { ram?: unknown; worker?: unknown }, context?: ToolExecutionContext): Promise<ToolResult> {
    return gated('memory_helper_settings', context, async (ownerId) => {
      const input: Record<string, unknown> = {};
      if (params.ram !== undefined) input.ram = params.ram;
      if (params.worker !== undefined) input.worker = params.worker === '' ? null : params.worker;
      const before = helperSettings();
      const settings = await setHelperSettings(input, helperEmbeddingModel());
      auditTool(context, 'memory.helper_settings', 'memory_helper', ownerId, { ram: settings.ram, worker: settings.worker });
      if (settings.worker && settings.worker !== before.worker) void retryMemoryHelper().catch(() => undefined);
      const ram = await ramView();
      return ok(`Saved. RAM limit ${gb(ram.limitBytes)} (${settings.ram.mode}); night writer ${settings.ram.mode === 'light' ? 'off (light)' : settings.worker ?? 'off'}.`, { settings, ram });
    });
  },
};

export const memoryNightRunTool: Tool = {
  name: 'memory_night_run',
  description: `Start tonight's memory work now (the owner's "Run now"): read new and changed files, turn notes into
ideas that wait in Needs you, write the summaries, tidy. It runs in the background and stops when asked (memory_night_stop).`,
  input_schema: { type: 'object', properties: {} },
  async execute(_params: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
    return gated('memory_night_run', context, async (ownerId) => {
      if (nightRunning(ownerId).running) return ok('It is already running.', { started: false, running: true });
      void runNightWork(ownerId, { force: true }).catch(() => undefined);
      auditTool(context, 'memory.night_run', 'memory_night_work', ownerId, {});
      return ok('Started. It reports in Memory › Memory helper and in Needs you.', { started: true });
    });
  },
};

export const memoryNightStopTool: Tool = {
  name: 'memory_night_stop',
  description: `Stop tonight's memory work after the file it is on (the owner's "Stop"). Nothing is lost; Run now goes on later.`,
  input_schema: { type: 'object', properties: {} },
  async execute(_params: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
    return gated('memory_night_stop', context, async (ownerId) => {
      const stopped = stopNightWorkFor(ownerId);
      if (stopped) auditTool(context, 'memory.night_stop', 'memory_night_work', ownerId, {});
      return ok(stopped ? 'It stops after the file it is on.' : 'Nothing is running.', { stopped });
    });
  },
};
