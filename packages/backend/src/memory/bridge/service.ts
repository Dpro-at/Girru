/**
 * Memory bridge operations (MEM-BRIDGE-01), shared by the owner-only REST API,
 * the owner's agent tools and the dpro-memory MCP server:
 *
 *   owner        status, kill switch per CLI, managed files (preview -> confirm),
 *                registration (preview -> confirm -> undo), back-flow, sync
 *   MCP server   read tools (project_brief, pinned_facts, latest_handoff, memory_search, project_design)
 *                and write tools that only create review proposals (memory_propose)
 *                or handoff notes (handoff_write), for the project whose folder the
 *                CLI runs in; nothing for a folder Girru does not know
 */
import { designBlock, getDesign } from '../project-design.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { q } from '../../repositories/sql-steps.js';
import type { Project } from '../../repositories/chat-conversations.js';
import { findProject, listProjects } from '../../repositories/chat-conversations.js';
import { getMemoryStorage } from '../storage.js';
import { learn } from '../learning.js';
import { cleanHandoff, HandoffInputError } from '../handoff/store.js';
import { BRIDGE_CLIENTS, CLIENT_NAMES, clientConfigFile, isBridgeClient, launchReady, serverLaunch, type BridgeClient, type BridgeEnv } from './clients.js';
import { briefHash, briefMarkdown, clean, handoffText, projectBrief, projectDrawer, projectHandoff, pinnedFacts } from './brief.js';
import { applyFiles, ManagedFileError, previewFiles, type FilesPreview, type SectionExtras } from './managed-files.js';
import { createHash } from 'node:crypto';
import { applyRegistration, previewRegistration, RegistrationError, undoRegistration } from './registration.js';
import { runBackflow, type BackflowResult } from './backflow.js';
import { ensureToken, revokeToken, tokenMatches, checkSessionProof } from './auth.js';
import { CapabilityError, launchCapability, requireScope, revokeCapability, verifyCapability, type Capability } from './capability.js';
import { isPilotProject } from '../outbox/pilot.js';
import { storeP6Enabled } from '../../services/store-p6.js';
import {
  allFolderSettings, audit, auditLog, bridgeOwner, setCompanyFacts, clientEnabled, clientStates, folderSettings, lastCalls, listRegistrations, patchFolder,
  projectForFolder, saveBridgeHandoff, setClientEnabled,
} from './store.js';

export class BridgeError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'invalid_request') { super(message); }
}

/** Where CLI configs live; tests point this at a temporary HOME. */
let bridgeEnv: BridgeEnv = {};
export function setBridgeEnv(where: BridgeEnv): void { bridgeEnv = where; }
const where = (): BridgeEnv => ({ home: bridgeEnv.home ?? os.homedir(), env: bridgeEnv.env ?? process.env });

async function ownProject(ownerId: string, projectId: unknown): Promise<Project> {
  if (typeof projectId !== 'string' || !projectId) throw new BridgeError('projectId is required');
  const p = await findProject(ownerId, projectId);
  if (!p) throw new BridgeError('Not found', 404, 'not_found');
  if (!p.folder) throw new BridgeError('This project has no folder on this computer', 400, 'no_folder');
  return p;
}

function client(value: unknown): BridgeClient {
  if (!isBridgeClient(value)) throw new BridgeError(`client must be one of ${BRIDGE_CLIENTS.join(', ')}`);
  return value;
}

/** Errors of the parts as BridgeError (one shape for the API and the tools). */
async function wrap<T>(fn: () => Promise<T> | T): Promise<T> {
  try { return await fn(); } catch (err) {
    if (err instanceof ManagedFileError || err instanceof RegistrationError) throw new BridgeError(err.message, err.status, err.code);
    throw err;
  }
}

// --- owner -----------------------------------------------------------------

export async function bridgeStatus(ownerId: string) {
  const states = await clientStates(ownerId);
  const regs = await listRegistrations(ownerId);
  const folders = new Map((await allFolderSettings(ownerId)).map((f) => [f.projectId, f]));
  const projects = (await listProjects(ownerId)).filter((p) => p.folder);
  const calls = await lastCalls(ownerId);
  return {
    clients: BRIDGE_CLIENTS.map((c) => {
      const active = regs.find((r) => r.client === c && r.status === 'applied');
      const last = calls.get(c);
      return { client: c, name: CLIENT_NAMES[c], enabled: states[c], configPath: clientConfigFile(c, where()), registrationId: active?.id ?? null, registeredAt: active?.createdAt ?? null,
        lastCallAt: last?.at ?? null, lastTool: last?.tool ?? null };
    }),
    projects: projects.map((p) => {
      const f = folders.get(p.id);
      return { projectId: p.id, name: p.name, folder: p.folder, filesEnabled: !!f?.filesEnabled, backflowEnabled: !!f?.backflowEnabled, gitExclude: f?.gitExclude ?? true, writtenAt: f?.writtenAt ?? null, confirmedAt: f?.confirmedAt ?? null };
    }),
    registrations: regs,
    serverReady: launchReady(serverLaunch('claude-code')),
  };
}

/** Kill switch per CLI. Off also deletes the CLI's token (a running server loses access at once). */
export async function setClient(ownerId: string, c: unknown, enabled: unknown, actor = 'owner') {
  const cl = client(c);
  if (typeof enabled !== 'boolean') throw new BridgeError('enabled must be true or false');
  await setClientEnabled(ownerId, cl, enabled);
  if (!enabled) await revokeToken(ownerId, cl);
  await audit(ownerId, enabled ? 'client-on' : 'client-off', { client: cl, note: actor });
  return { client: cl, enabled };
}

export async function filesPreview(ownerId: string, projectId: unknown): Promise<FilesPreview> {
  const p = await ownProject(ownerId, projectId);
  const f = await folderSettings(ownerId, p.id);
  const extras = await extrasOf(p.id);
  return wrap(async () => previewFiles(p.id, await projectBrief(ownerId, p), p.folder, f.gitExclude, extras));
}

/** Owner confirm per folder: writes the previewed files and keeps them in sync from now on. */
export async function filesApply(ownerId: string, projectId: unknown, input: { previewHash?: unknown; confirm?: unknown }, actor = 'owner'): Promise<FilesPreview> {
  if (input?.confirm !== true) throw new BridgeError('Send confirm: true after reviewing the preview', 400, 'confirm_required');
  if (typeof input.previewHash !== 'string') throw new BridgeError('previewHash is required');
  const p = await ownProject(ownerId, projectId);
  const f = await folderSettings(ownerId, p.id);
  const brief = await projectBrief(ownerId, p);
  const extras = await extrasOf(p.id);
  const result = await wrap(() => applyFiles(p.id, brief, p.folder, f.gitExclude, input.previewHash as string, extras));
  await patchFolder(ownerId, p.id, { filesEnabled: true, briefHash: sectionHash(brief, extras), confirmed: true, written: true });
  await audit(ownerId, 'files-written', { projectId: p.id, note: `${result.changes} file(s) by ${actor}` });
  return result;
}

export async function setFolder(ownerId: string, projectId: unknown, patch: { filesEnabled?: unknown; backflowEnabled?: unknown; gitExclude?: unknown; companyFacts?: unknown }, actor = 'owner') {
  const p = await ownProject(ownerId, projectId);
  // P6 (SEC2-1): the owner decides per project whether company facts reach coding tools.
  if (storeP6Enabled() && patch?.companyFacts !== undefined) {
    if (typeof patch.companyFacts !== 'boolean') throw new BridgeError('companyFacts must be true or false');
    await setCompanyFacts(ownerId, p.id, patch.companyFacts);
    await audit(ownerId, 'folder-settings', { projectId: p.id, note: `${JSON.stringify({ companyFacts: patch.companyFacts })} by ${actor}` });
  }
  const next: { filesEnabled?: boolean; backflowEnabled?: boolean; gitExclude?: boolean } = {};
  for (const k of ['filesEnabled', 'backflowEnabled', 'gitExclude'] as const) {
    if (patch?.[k] === undefined) continue;
    if (typeof patch[k] !== 'boolean') throw new BridgeError(`${k} must be true or false`);
    next[k] = patch[k] as boolean;
  }
  // Turning files on happens only through preview + confirm (filesApply).
  if (next.filesEnabled === true) throw new BridgeError('Turn managed files on with the preview and confirm', 400, 'confirm_required');
  const f = await patchFolder(ownerId, p.id, next);
  await audit(ownerId, 'folder-settings', { projectId: p.id, note: `${JSON.stringify(next)} by ${actor}` });
  return f;
}

export async function backflowNow(ownerId: string, projectId: unknown, actor = 'owner'): Promise<BackflowResult> {
  const p = await ownProject(ownerId, projectId);
  const r = await runBackflow(ownerId, p, { home: where().home });
  await audit(ownerId, 'backflow-run', { projectId: p.id, note: `${r.proposed} proposal(s) by ${actor}` });
  return r;
}

export async function registrationPreview(_ownerId: string, c: unknown) {
  return wrap(() => previewRegistration(client(c), where()));
}

export async function registrationApply(ownerId: string, c: unknown, input: { previewHash?: unknown; confirm?: unknown }, actor = 'owner') {
  const cl = client(c);
  const r = await wrap(() => applyRegistration(ownerId, cl, input ?? {}, where()));
  await setClientEnabled(ownerId, cl, true);
  await audit(ownerId, 'registered', { client: cl, note: `${r.preview.action} by ${actor}` });
  return r;
}

export async function registrationUndo(ownerId: string, id: unknown, actor = 'owner') {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new BridgeError('Not found', 404, 'not_found');
  const r = await wrap(() => undoRegistration(ownerId, id));
  await setClientEnabled(ownerId, r.registration.client, false);
  await revokeToken(ownerId, r.registration.client);
  await audit(ownerId, 'unregistered', { client: r.registration.client, note: `${r.mode} by ${actor}` });
  return r;
}

/** The bridge's activity log for the owner (API and tool): newest first, optionally one CLI or one project. */
export async function activity(ownerId: string, input: { limit?: unknown; client?: unknown; projectId?: unknown } = {}) {
  const limit = input.limit === undefined ? 100 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new BridgeError('limit must be 1-500');
  const c = input.client === undefined ? undefined : client(input.client);
  let projectId: string | undefined;
  if (input.projectId !== undefined) {
    if (typeof input.projectId !== 'string' || !(await findProject(ownerId, input.projectId))) throw new BridgeError('Not found', 404, 'not_found');
    projectId = input.projectId;
  }
  return auditLog(ownerId, limit, { client: c, projectId });
}

export { auditLog };

/**
 * Keeps confirmed folders current: files are rewritten (inside the markers
 * only) when the brief changed; back-flow runs where the owner turned it on.
 */
export async function syncOwner(ownerId: string): Promise<{ written: number; proposed: number; conflicts: number }> {
  const out = { written: 0, proposed: 0, conflicts: 0 };
  for (const f of await allFolderSettings(ownerId)) {
    const p = await findProject(ownerId, f.projectId);
    if (!p?.folder) continue;
    if (f.filesEnabled) {
      const brief = await projectBrief(ownerId, p);
      const extras = await extrasOf(p.id);
      const h = sectionHash(brief, extras);
      if (h !== f.briefHash) {
        try {
          const r = applyFiles(p.id, brief, p.folder, f.gitExclude, null, extras);
          await patchFolder(ownerId, p.id, { briefHash: h, written: true });
          if (r.changes) { out.written += r.changes; await audit(ownerId, 'files-synced', { projectId: p.id, note: `${r.changes} file(s)` }); }
        } catch (err) {
          if (!(err instanceof ManagedFileError)) throw err;
          out.conflicts++;
          await audit(ownerId, 'files-conflict', { projectId: p.id, note: err.message });
        }
      }
    }
    if (f.backflowEnabled) out.proposed += (await runBackflow(ownerId, p, { home: where().home })).proposed;
  }
  return out;
}

// --- automatic connection (MEM-UX-02) ---------------------------------------

/**
 * Once the owner allowed reading this computer (at least one folder allowed in
 * Settings › Memory › Folders and drives, DISCOVER-02), coding apps connect on
 * their own:
 *   - each coding app whose config is on this computer gets the dpro-memory
 *     server registered (the same preview + apply: the original config is
 *     backed up first; Undo restores it). An app the owner switched off, or
 *     whose registration the owner undid, is never registered again by itself.
 *   - each project folder without folder settings gets its managed files
 *     (default on; written only between Girru's markers). A folder the owner
 *     turned off stays off; a conflict is recorded once and left alone.
 * Every step is audited ('automatic'). Never throws.
 */
export async function autoConnect(ownerId: string, allowed: boolean): Promise<{ registered: BridgeClient[]; folders: string[]; conflicts: number }> {
  const out = { registered: [] as BridgeClient[], folders: [] as string[], conflicts: 0 };
  if (!allowed) return out;
  const w = where();
  const regs = await listRegistrations(ownerId);
  const decided = new Set((await q.all<{ client: string }>('SELECT client FROM memory_bridge_clients WHERE owner_id = ?', ownerId)).map((r) => r.client));
  for (const cl of BRIDGE_CLIENTS) {
    if (decided.has(cl) || regs.some((r) => r.client === cl)) continue;
    const file = clientConfigFile(cl, w);
    const dirOk = path.dirname(file) !== (w.home ?? os.homedir()) && fs.existsSync(path.dirname(file));
    if (!fs.existsSync(file) && !dirOk) continue; // the app is not on this computer
    try {
      const preview = previewRegistration(cl, w);
      if (preview.action === 'conflict' || !launchReady(serverLaunch(cl))) continue;
      await applyRegistration(ownerId, cl, { previewHash: preview.previewHash, confirm: true }, w);
      await setClientEnabled(ownerId, cl, true);
      await audit(ownerId, 'registered', { client: cl, note: `${preview.action} automatic` });
      out.registered.push(cl);
    } catch (err) {
      if (!(err instanceof RegistrationError)) console.warn('[Memory bridge] automatic registration failed:', (err as Error)?.message);
    }
  }
  const known = new Set((await allFolderSettings(ownerId)).map((f) => f.projectId));
  for (const p of (await listProjects(ownerId)).filter((x) => x.folder && !known.has(x.id))) {
    try {
      const brief = await projectBrief(ownerId, p);
      const extras = await extrasOf(p.id);
      applyFiles(p.id, brief, p.folder, true, null, extras);
      await patchFolder(ownerId, p.id, { filesEnabled: true, briefHash: sectionHash(brief, extras), confirmed: true, written: true });
      await audit(ownerId, 'files-written', { projectId: p.id, note: 'automatic' });
      out.folders.push(p.id);
    } catch (err) {
      if (!(err instanceof ManagedFileError)) { console.warn('[Memory bridge] automatic files failed:', (err as Error)?.message); continue; }
      out.conflicts++;
      await patchFolder(ownerId, p.id, { filesEnabled: false });
      await audit(ownerId, 'files-conflict', { projectId: p.id, note: `automatic: ${err.message}` });
    }
  }
  return out;
}

// --- STORE-MAP-01 P2: one Girru section ---------------------------------------

/** The rules and task pointer of the one section (undefined while P2 is off). */
async function extrasOf(projectId: string): Promise<SectionExtras | undefined> {
  const { sectionExtras } = await import('../../services/agent-rule-files.js');
  return sectionExtras(projectId);
}

/** What the files are written from: the brief, plus (P2) the rules and the task pointer. */
function sectionHash(brief: Parameters<typeof briefHash>[0], extras: SectionExtras | undefined): string {
  return extras ? createHash('sha256').update(JSON.stringify([briefHash(brief), extras])).digest('hex') : briefHash(brief);
}

async function sectionInputs(projectId: string): Promise<{ ownerId: string; project: Project; brief: Awaited<ReturnType<typeof projectBrief>> | null; extras: SectionExtras; gitExclude: boolean }> {
  const row = await q.one<{ user_id: string }>('SELECT user_id FROM chat_projects WHERE id = ?', projectId);
  const project = row ? await findProject(row.user_id, projectId) : undefined;
  if (!row || !project) throw new BridgeError('Not found', 404, 'not_found');
  const extras = await extrasOf(projectId);
  if (!extras) throw new BridgeError('The one Girru section needs GIRRU_STORE_P2', 409, 'p2_off');
  const f = await folderSettings(row.user_id, projectId);
  // The memory brief goes into the files only where the owner turned memory files on.
  return { ownerId: row.user_id, project, brief: f.filesEnabled ? await projectBrief(row.user_id, project) : null, extras, gitExclude: f.gitExclude };
}

/** P2: what writing the one Girru section would do (reads only). */
export async function unifiedPreview(projectId: string, _opts: { rulesWritten?: boolean } = {}): Promise<FilesPreview> {
  const i = await sectionInputs(projectId);
  return wrap(async () => previewFiles(projectId, i.brief, i.project.folder, i.gitExclude, i.extras));
}

/** P2: write the one Girru section (the rules writer calls this after a rule change or the owner's button). */
export async function writeUnifiedSection(projectId: string): Promise<FilesPreview> {
  const i = await sectionInputs(projectId);
  const r = await wrap(async () => applyFiles(projectId, i.brief, i.project.folder, i.gitExclude, null, i.extras));
  if (i.brief) await patchFolder(i.ownerId, projectId, { briefHash: sectionHash(i.brief, i.extras), written: true });
  return r;
}

// --- MCP server ------------------------------------------------------------

export const MCP_TOOLS = ['project_brief', 'pinned_facts', 'latest_handoff', 'memory_search', 'project_design', 'memory_propose', 'handoff_write'] as const;
export type McpTool = (typeof MCP_TOOLS)[number];

/** Session start of the MCP server: install proof -> the CLI's token (only while the CLI is on). */
export async function openSession(c: unknown, nonce: unknown, proof: unknown): Promise<{ token: string }> {
  const cl = client(c);
  const ownerId = await bridgeOwner();
  if (!ownerId) throw new BridgeError('Girru has no owner yet', 403, 'no_owner');
  if (!checkSessionProof(cl, nonce, proof)) throw new BridgeError('Not allowed', 401, 'unauthenticated');
  if (!(await clientEnabled(ownerId, cl))) throw new BridgeError(`${CLIENT_NAMES[cl]} is switched off in Girru`, 403, 'client_off');
  await audit(ownerId, 'session', { client: cl });
  return { token: await ensureToken(ownerId, cl) };
}

export interface McpAnswer { text: string; data: Record<string, unknown> }

/**
 * One MCP tool call from a CLI running in `cwd`. With a session capability
 * (STORE-MAP-01 pilot) the project and the allowed tools come from the
 * capability; the `cwd` never grants anything and a `cwd` inside another
 * project is refused. The pilot project accepts no call without one.
 */
export async function mcpCall(c: unknown, token: unknown, cwd: unknown, tool: unknown, args: Record<string, unknown> = {}, capability?: unknown): Promise<McpAnswer> {
  const cl = client(c);
  const ownerId = await bridgeOwner();
  if (!ownerId || !(await tokenMatches(ownerId, cl, token))) throw new BridgeError('Not allowed', 401, 'unauthenticated');
  if (!(await clientEnabled(ownerId, cl))) throw new BridgeError(`${CLIENT_NAMES[cl]} is switched off in Girru`, 403, 'client_off');
  if (typeof tool !== 'string' || !(MCP_TOOLS as readonly string[]).includes(tool)) throw new BridgeError('Unknown tool', 400, 'unknown_tool');
  const folderProject = typeof cwd === 'string' ? await projectForFolder(ownerId, cwd) : null;
  let project: Project | null = folderProject;
  // Every call is checked; only a call that carries no capability at all goes on without one.
  let cap: Capability | null = null;
  try { cap = await verifyCapability(capability); requireScope(cap, tool); } catch (err) {
    if (!(err instanceof CapabilityError)) throw err;
    if (err.code !== 'absent') throw new BridgeError(err.message, err.status, err.code);
  }
  if (cap) {
    if (cap.ownerId !== ownerId || (cap.client && cap.client !== cl)) throw new BridgeError('Not allowed', 401, 'unauthenticated');
    project = (await findProject(ownerId, cap.projectId)) ?? null;
    if (!project) throw new BridgeError('The project of this session no longer exists', 404, 'unknown_project');
    if (folderProject && folderProject.id !== project.id) throw new BridgeError('This folder belongs to another project than this session', 403, 'capability_project_mismatch');
  } else if (storeP6Enabled() || (folderProject && isPilotProject(folderProject.id))) {
    // P6 (SEC2-1): no project is opened by a folder path alone, known or not.
    throw new BridgeError('This project needs a session started from Girru', 403, 'capability_required');
  }
  if (!project) throw new BridgeError('Girru does not know this folder. Add it as a project folder in Girru first.', 404, 'unknown_folder');
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const p6 = storeP6Enabled() && !!cap;
  // P6: company facts only where the owner allowed them (the capability carries it).
  const company = !p6 || cap!.scopes.includes('company:read');
  // Reads are logged too (tool name only, never the query), so the owner sees which app used the memory and when.
  // P6 read log (ENC-01 with CX5): the session's id goes with it, ids only.
  if (tool !== 'memory_propose' && tool !== 'handoff_write') {
    if (p6) await readVolumeCheck(ownerId, cl, project.id, cap!.id);
    await audit(ownerId, 'mcp-read', { client: cl, projectId: project.id, note: p6 ? `${tool} session:${cap!.id}` : tool });
  }

  switch (tool as McpTool) {
    case 'project_brief': {
      const b = await projectBrief(ownerId, project, company);
      return { text: briefMarkdown(b), data: { project: { id: project.id, name: b.name }, facts: b.facts.length, memories: b.memories.length, handoff: !!b.handoff } };
    }
    case 'pinned_facts': {
      const facts = await pinnedFacts(ownerId, project, company);
      return { text: facts.length ? facts.map((f) => `- ${f.content}`).join('\n') : 'The owner has not pinned facts for this project yet.', data: { facts } };
    }
    case 'latest_handoff': {
      const h = await projectHandoff(ownerId, project.id);
      return { text: h ? handoffText(h) : 'No handoff note in this project yet.', data: { handoff: h } };
    }
    case 'memory_search': {
      const query = typeof a.query === 'string' ? a.query.trim().slice(0, 500) : '';
      if (!query) throw new BridgeError('query is required');
      const limit = Math.min(Math.max(1, Number.isInteger(a.limit) ? (a.limit as number) : 8), 20);
      const hits = await getMemoryStorage().search({ userId: ownerId, query, drawers: [projectDrawer(project)], limit } as any);
      let results = hits.slice(0, limit).map((h) => ({ id: h.memory.id, content: clean(h.memory.content), score: Number(h.similarity.toFixed(3)) }));
      if (p6) results = capAnswer(results);
      return { text: results.length ? results.map((r) => `- ${r.content}`).join('\n') : 'Nothing found in this project.', data: { results } };
    }
    case 'project_design': {
      // DESIGN-FIND-01: the design Girru found for this project (the same text as DESIGN.md's Girru section).
      const v = await getDesign(ownerId, projectDrawer(project).key!).catch(() => null);
      const has = !!v && (v.colours.length + v.fonts.length + v.logos.length + v.rules.length) > 0;
      return { text: has ? designBlock(v!) : 'Girru has not found a design for this project yet.', data: { colours: v?.colours.length ?? 0, fonts: v?.fonts.length ?? 0, logos: v?.logos.length ?? 0, rules: v?.rules.length ?? 0, conflicts: v?.conflicts.length ?? 0 } };
    }
    case 'memory_propose': {
      const content = typeof a.content === 'string' ? a.content.trim() : '';
      if (!content || content.length > 4000) throw new BridgeError('content is required (at most 4000 characters)');
      // AG5: with a P6 session the proposal records the app (actor) AND the agent it works for.
      const r = await learn({ userId: ownerId, actor: `bridge:${cl}`, review: true, ...(p6 && cap!.agentId ? { agentId: cap!.agentId } : {}),
        candidates: [{ content, type: 'fact', importance: 5, drawer: projectDrawer(project), origin: 'agent' }] });
      const proposal = r.proposed[0];
      await audit(ownerId, 'mcp-propose', { client: cl, projectId: project.id, note: (proposal ? `proposal ${proposal.id}` : (r.skipped[0]?.reason ?? 'nothing')) + (p6 && cap!.agentId ? ` agent:${cap!.agentId}` : '') });
      if (!proposal) return { text: `Not proposed: ${r.skipped[0]?.reason ?? 'nothing to add'}.`, data: { proposalId: null, reason: r.skipped[0]?.reason ?? null } };
      return { text: 'Proposed. The owner reviews it in Girru; it becomes shared memory only after approval.', data: { proposalId: proposal.id } };
    }
    case 'handoff_write': {
      let body;
      try { body = cleanHandoff(a); } catch (err) {
        if (err instanceof HandoffInputError) throw new BridgeError(err.message);
        throw err;
      }
      const h = await saveBridgeHandoff(ownerId, project.id, cl, body, p6 ? cap!.agentId ?? null : null);
      await audit(ownerId, 'mcp-handoff', { client: cl, projectId: project.id, ...(p6 ? { note: `session:${cap!.id}${cap!.agentId ? ` agent:${cap!.agentId}` : ''}` } : {}) });
      return { text: 'Handoff saved. The next agent in this project, of any brand, starts from it.', data: { handoffId: h.id } };
    }
  }
}

// --- STORE-MAP-01 P6: session capability for every project (CX5, SEC2-1, SEC2-2) ---

/** SEC2-2: a search answer never exceeds this many characters, however many hits there are. */
export const MAX_SEARCH_ANSWER_CHARS = 6000;
/** SEC2-2: more reads than this in one minute from one session are refused and raise one notice. */
export const MAX_READS_PER_MINUTE = 30;

/** Keep whole results, best first, until the answer cap. */
export function capAnswer<T extends { content: string }>(results: T[], max = MAX_SEARCH_ANSWER_CHARS): T[] {
  const out: T[] = [];
  let used = 0;
  for (const r of results) {
    if (used + r.content.length > max) break;
    used += r.content.length;
    out.push(r);
  }
  return out;
}

const readWindows = new Map<string, number[]>();
/** Unusual volume (SEC2-2): count a session's reads per minute; over the limit = refused + one audit notice. */
async function readVolumeCheck(ownerId: string, cl: BridgeClient, projectId: string, sessionId: string): Promise<void> {
  const now = Date.now();
  const recent = (readWindows.get(sessionId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= MAX_READS_PER_MINUTE) {
    // One notice per window: only the first refused read writes it.
    if (recent.length === MAX_READS_PER_MINUTE) await audit(ownerId, 'mcp-volume', { client: cl, projectId, note: `session:${sessionId} over ${MAX_READS_PER_MINUTE} reads a minute` });
    recent.push(now);
    readWindows.set(sessionId, recent);
    throw new BridgeError('Too many memory reads from this session; wait a minute', 429, 'too_many_reads');
  }
  recent.push(now);
  readWindows.set(sessionId, recent);
  if (readWindows.size > 500) for (const [k, v] of readWindows) if (!v.some((t) => now - t < 60_000)) readWindows.delete(k);
}

/** Test seam: forget the per-session read counts. */
export function resetReadVolume(): void { readWindows.clear(); }

const SUBSCRIPTION_CLIENT: Record<string, BridgeClient> = { claude: 'claude-code', codex: 'codex', gemini: 'antigravity' };

/**
 * The trusted launcher (P6): before Girru starts a coding app in `folder`, it
 * issues a session capability for the owner's project of that folder and
 * hands it to the process as GIRRU_SESSION_CAPABILITY. The project is found
 * from Girru's own project list (real paths); a folder that is no project gets
 * nothing. The capability is revoked when the run ends. Null while P6 is off.
 */
export async function launchSession(folder: string, kind: string, agentId: string | null = null): Promise<{ env: Record<string, string>; end: () => Promise<void> } | null> {
  if (!storeP6Enabled()) return null;
  const ownerId = await bridgeOwner();
  if (!ownerId) return null;
  const project = await projectForFolder(ownerId, folder);
  if (!project) return null;
  const f = await folderSettings(ownerId, project.id);
  // AG5: the agent the run works for goes with the session (an unknown agent id is dropped, the run still gets its session).
  const agent = agentId ? await q.one<{ id: string }>('SELECT id FROM agents_config WHERE id = ?', agentId) : undefined;
  const { token, capability } = await launchCapability(ownerId, project.id, SUBSCRIPTION_CLIENT[kind] ?? null, !!f.companyFacts, agent?.id ?? null);
  await audit(ownerId, 'session-start', { client: SUBSCRIPTION_CLIENT[kind] ?? null, projectId: project.id, note: `session:${capability.id}${agent ? ` agent:${agent.id}` : ''}` });
  return { env: { GIRRU_SESSION_CAPABILITY: token }, end: async () => { await revokeCapability(ownerId, capability.id).catch(() => false); } };
}
