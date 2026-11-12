/**
 * GENVR-WORLD-01 (board W1, GV1e): a GenVR world in Girru.
 *
 * - Each GenVR world gets a folder in ~/Girru/genvr_Worlds/<name>/ and is registered as a Girru chat
 *   project with that folder, so project memory and the document index work for it.
 * - Each world has one Girru chat in that project; the Studio chat sends to it as Girru's own chat run
 *   (core-ui GenVRPage), and the agent builds with the GenVR MCP tools on the open place.
 * - The agent last chosen for a world answers in it (else the primary agent).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { q } from '../repositories/sql-steps.js';
import { createConversation, createProject, findConversation, findProject, listConversationMessages, patchProject } from '../repositories/chat-conversations.js';

export class WorldError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) { super(message); }
}

/** Tools the agent may never call from the chat: publishing and sharing stay with the owner (board W1). */

export const WORLD_ID = /^[a-zA-Z0-9_-]{1,100}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** ~/Girru/genvr_Worlds (GIRRU_GENVR_WORLDS overrides it, for tests and other data folders). */
export const worldsRoot = () => path.resolve(process.env.GIRRU_GENVR_WORLDS || path.join(os.homedir(), 'Girru', 'genvr_Worlds'));

/** A folder name from the world's name: no separators, controls, leading dots or reserved names. */
export function worldFolderName(name: string): string {
  const cleaned = name.normalize('NFC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ').replace(/(^|\s)\.+(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, 80).trim();
  return !cleaned || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned) ? 'World' : cleaned;
}

/** The path as the chat shows it: ~/… when inside the home folder. */
export const shownFolder = (folder: string) => { const home = os.homedir(); return folder === home || folder.startsWith(home + path.sep) ? '~' + folder.slice(home.length) : folder; };

let ready: Promise<void> | null = null;
async function ensureTable() {
  ready ??= q.run('CREATE TABLE IF NOT EXISTS genvr_worlds (user_id TEXT NOT NULL, project_id TEXT NOT NULL, folder TEXT NOT NULL, chat_project_id TEXT, agent_id TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,project_id))')
    // GV1e: the one Girru chat of a world (older tables get the column once).
    .then(() => q.run('ALTER TABLE genvr_worlds ADD COLUMN chat_conversation_id TEXT').catch(() => undefined)).then(() => undefined);
  try { await ready; } catch (error) { ready = null; throw error; }
}

interface WorldRow { folder: string; chat_project_id: string | null; agent_id: string | null; chat_conversation_id?: string | null }
interface AgentRow { id: string; name: string; model: string | null; provider: string | null; is_primary: number }

export interface Answerer { id: string; name: string; detail: string; color: string }

/** A short line for the model the agent answers with. */
export function modelLabel(model: string | null | undefined): string {
  if (!model) return 'Local model';
  if (model.startsWith('subscription:claude')) return 'Claude Code';
  if (model.startsWith('subscription:codex')) return 'Codex';
  if (model.startsWith('subscription:gemini')) return 'Antigravity';
  if (/^claude-/.test(model)) return model.replace(/^claude-/, 'Claude ').replace(/-\d{8}$/, '');
  return model.replace(/^(lmstudio|openai-local):/, '').slice(0, 60);
}

const COLORS = ['#c2417a', '#3b82f6', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#4f46e5'];
const colorOf = (id: string) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };
const answererOf = (a: AgentRow): Answerer => ({ id: a.id, name: a.name.slice(0, 60), detail: modelLabel(a.model), color: colorOf(a.id) });

async function agentRow(id: string | null | undefined): Promise<AgentRow | undefined> {
  if (!id || !AGENT_ID.test(id) || id === 'small-local-agent') return undefined;
  return q.one<AgentRow>('SELECT id,name,model,provider,is_primary FROM agents_config WHERE id=?', id);
}
async function primaryAgent(): Promise<AgentRow | undefined> {
  return (await q.one<AgentRow>("SELECT id,name,model,provider,is_primary FROM agents_config WHERE is_primary=1 AND id<>'small-local-agent' ORDER BY id LIMIT 1"))
    ?? q.one<AgentRow>("SELECT id,name,model,provider,is_primary FROM agents_config WHERE id<>'small-local-agent' ORDER BY created_at,id LIMIT 1");
}
async function worldRow(userId: string, projectId: string) {
  await ensureTable();
  return q.one<WorldRow>('SELECT folder,chat_project_id,agent_id,chat_conversation_id FROM genvr_worlds WHERE user_id=? AND project_id=?', userId, projectId);
}
async function worldTitle(userId: string, projectId: string) {
  return (await q.one<{ title: string }>('SELECT title FROM genvr_projects WHERE user_id=? AND id=?', userId, projectId).catch(() => undefined))?.title;
}

/** Makes a world's folder once (a free name inside the worlds root) with its documents and exports. */
async function makeFolder(userId: string, name: string): Promise<string> {
  const root = worldsRoot();
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  const realRoot = await fs.promises.realpath(root);
  const taken = new Set((await q.all<{ folder: string }>('SELECT folder FROM genvr_worlds WHERE user_id=?', userId)).map(r => r.folder));
  const base = worldFolderName(name);
  for (let n = 1; n < 1000; n++) {
    const folder = path.resolve(realRoot, n === 1 ? base : `${base} ${n}`);
    if (!folder.startsWith(realRoot + path.sep)) throw new WorldError(400, 'invalid_folder');
    if (taken.has(folder)) continue;
    try { await fs.promises.mkdir(folder, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
    for (const part of ['documents', 'exports']) await fs.promises.mkdir(path.join(folder, part), { mode: 0o700 });
    await fs.promises.writeFile(path.join(folder, 'README.md'), '# GenVR world\n\nThis folder belongs to a GenVR world.\n\n- documents/ notes, story and rules (Girru reads them for the chat)\n- exports/ films, pictures and packages\n\nThe world itself is saved in Girru. Its memory is this project\'s memory in Girru.\n', { flag: 'wx', mode: 0o600 });
    return folder;
  }
  throw new WorldError(409, 'folder_unavailable');
}

/**
 * A world was opened (or renamed, or its tab changed): its folder and Girru project exist from now on.
 * Rename keeps the folder and memory, as projects do.
 */
export async function openWorld(userId: string, projectId: string, name: string): Promise<{ folder: string; path: string; chatProjectId: string | null; conversationId: string | null; answerer: Answerer | null }> {
  if (!WORLD_ID.test(projectId)) throw new WorldError(400, 'invalid_input');
  const title = (await worldTitle(userId, projectId)) ?? name.trim().slice(0, 200);
  if (!title) throw new WorldError(400, 'invalid_input');
  let row = await worldRow(userId, projectId);
  if (!row || !fs.existsSync(row.folder)) {
    const folder = await makeFolder(userId, title);
    await q.run('INSERT INTO genvr_worlds(user_id,project_id,folder) VALUES(?,?,?) ON CONFLICT(user_id,project_id) DO UPDATE SET folder=excluded.folder,chat_project_id=NULL,updated_at=CURRENT_TIMESTAMP', userId, projectId, folder);
    row = { folder, chat_project_id: null, agent_id: row?.agent_id ?? null };
  }
  let chatProjectId = row.chat_project_id;
  const chatProject = chatProjectId ? await findProject(userId, chatProjectId) : undefined;
  // A renamed place: its chat project follows the new name (the folder stays where its files are).
  if (chatProject && chatProject.name !== `World · ${title}`.slice(0, 80)) await patchProject(userId, chatProject.id, { name: `World · ${title}`.slice(0, 80) }).catch(() => undefined);
  if (!chatProjectId || !chatProject) {
    const project = await createProject(userId, { name: `World · ${title}`.slice(0, 80), folder: row.folder });
    chatProjectId = project.id;
    await q.run('UPDATE genvr_worlds SET chat_project_id=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND project_id=?', chatProjectId, userId, projectId);
  }
  const agent = (await agentRow(row.agent_id)) ?? (await primaryAgent());
  // GV1e: one Girru chat per world, in its project: the Studio chat and Girru Chat are the same conversation.
  let conversationId = row.chat_conversation_id ?? null;
  const conversation = conversationId ? await findConversation(userId, conversationId) : undefined;
  if (conversation && conversation.projectId === chatProjectId && conversation.title !== `${title} · Studio`.slice(0, 120)) await q.run('UPDATE chat_sessions SET title=? WHERE id=? AND user_id=?', `${title} · Studio`.slice(0, 120), conversation.id, userId).catch(() => undefined);
  if (!conversation || conversation.projectId !== chatProjectId) {
    conversationId = (await createConversation(userId, { title: `${title} · Studio`.slice(0, 120), projectId: chatProjectId, agentId: agent?.id ?? null })).id;
    await q.run('UPDATE genvr_worlds SET chat_conversation_id=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND project_id=?', conversationId, userId, projectId);
  }
  return { folder: shownFolder(row.folder), path: row.folder, chatProjectId, conversationId, answerer: agent ? answererOf(agent) : null };
}

/** The owner picked who answers in this world: remembered as the world's last agent. */
export async function chooseWorldAgent(userId: string, projectId: string, agentId: string): Promise<Answerer> {
  if (!WORLD_ID.test(projectId)) throw new WorldError(400, 'invalid_input');
  const agent = await agentRow(agentId);
  if (!agent) throw new WorldError(400, 'invalid_input');
  if (!(await worldRow(userId, projectId))) throw new WorldError(404, 'not_found');
  await q.run('UPDATE genvr_worlds SET agent_id=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND project_id=?', agent.id, userId, projectId);
  // GV1e: the place's Girru chat shows the same agent as the Studio.
  const conversation = (await worldRow(userId, projectId))?.chat_conversation_id;
  if (conversation) await q.run('UPDATE chat_sessions SET agent_id=? WHERE id=? AND user_id=?', agent.id, conversation, userId).catch(() => undefined);
  return answererOf(agent);
}

/** GV1e: the world's chat as the Studio shows it again (the latest person and agent lines). */
export async function worldHistory(userId: string, projectId: string): Promise<{ conversationId: string | null; messages: { role: 'user' | 'assistant'; text: string }[] }> {
  if (!WORLD_ID.test(projectId)) throw new WorldError(400, 'invalid_input');
  const id = (await worldRow(userId, projectId))?.chat_conversation_id ?? null;
  if (!id || !(await findConversation(userId, id))) return { conversationId: null, messages: [] };
  const rows = (await listConversationMessages(id)).filter(m => (m.role === 'user' || m.role === 'assistant') && m.content.trim()).slice(-40);
  return { conversationId: id, messages: rows.map(m => ({ role: m.role as 'user' | 'assistant', text: m.content.slice(0, 20_000) })) };
}

/** GV1e: the world behind a Girru chat project, for Chat's Details (Places, who answers, agents). */
export async function worldOfChatProject(userId: string, chatProjectId: string): Promise<{ projectId: string; title: string; folder: string; path: string; answerer: Answerer | null } | null> {
  await ensureTable();
  const row = await q.one<{ project_id: string; folder: string; agent_id: string | null }>('SELECT project_id,folder,agent_id FROM genvr_worlds WHERE user_id=? AND chat_project_id=?', userId, chatProjectId);
  if (!row) return null;
  const agent = (await agentRow(row.agent_id)) ?? (await primaryAgent());
  return { projectId: row.project_id, title: (await worldTitle(userId, row.project_id)) ?? 'GenVR place', folder: shownFolder(row.folder), path: row.folder, answerer: agent ? answererOf(agent) : null };
}
