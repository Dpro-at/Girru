/** Owner-scoped first-run inventory. Saves counts and source metadata, never creates agents or imports memories. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { q } from '../repositories/sql-steps.js';
import { dataPath } from '../config/data-root.js';
import { scanProjectDocuments } from '../memory/import/project-documents.js';
import { automaticNoteSource, discoveryInventory, preparedDiscoveryRoots } from '../discovery/service.js';
import { prepareAutomaticImport } from '../memory/import/automatic-project-import.js';

export type DiscoveryProgress = { status: 'idle' | 'scanning' | 'done' | 'error'; scanned: number; counts: { projects: number; memories: number; notes: number; skills: number; mcp: number; ssh: number }; denied: number; unavailable: number; limited: boolean; notice: string };
type Saved = DiscoveryProgress & { cursor?: string; documents: string[]; roots: string[]; homes: string[]; ids: Record<'memory' | 'skill' | 'mcp' | 'ssh', string[]>; inventoryOffset?: number; phase: 'files' | 'inventory' };
type Options = { home?: string; roots?: string[] };
const filename = (user: string) => dataPath('first-run-discovery', createHash('sha256').update(user).digest('hex') + '.json');
const initial = (): Saved => ({ status: 'idle', scanned: 0, counts: { projects: 0, memories: 0, notes: 0, skills: 0, mcp: 0, ssh: 0 }, denied: 0, unavailable: 0, limited: false, notice: 'Ready to discover files on this computer.', documents: [], roots: [], homes: [], ids: { memory: [], skill: [], mcp: [], ssh: [] }, phase: 'files' });
const visible = ({ status, scanned, counts, denied, unavailable, limited, notice }: Saved): DiscoveryProgress => ({ status, scanned, counts, denied, unavailable, limited, notice });
async function read(user: string): Promise<Saved> { try { return JSON.parse(await fs.readFile(filename(user), 'utf8')); } catch (error: any) { if (error.code === 'ENOENT') return initial(); throw error; } }
async function save(user: string, state: Saved) { const file = filename(user); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); const temp = file + '.' + randomUUID() + '.tmp'; await fs.writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file); }
const active = new Map<string, { work: Promise<void>; stopped: boolean }>();
export async function firstRunDiscovery(user: string): Promise<DiscoveryProgress> { return visible(await read(user)); }
const starting=new Map<string,Promise<DiscoveryProgress>>();
export function startFirstRunDiscovery(user:string,options:Options={}):Promise<DiscoveryProgress>{
 const previous=starting.get(user);if(previous)return previous;
 const next=begin(user,options).finally(()=>{if(starting.get(user)===next)starting.delete(user);});starting.set(user,next);return next;
}
async function begin(user: string, options: Options = {}): Promise<DiscoveryProgress> {
  if (active.has(user)) return firstRunDiscovery(user);
  const state = await read(user); if (state.status === 'done') return visible(state);
  state.status = 'scanning'; state.notice = 'Discovering memory files, projects and coding tools…'; await save(user, state);
  const task = { work: Promise.resolve(), stopped: false }; active.set(user, task);
  task.work = (async () => {
    try {
      const home = await fs.realpath(options.home ?? os.homedir());
      const allowed=async()=>{const owner=await q.one<{role:string;status:string}>('SELECT role,status FROM users WHERE id=?',user);return !task.stopped&&owner?.role==='owner'&&owner.status==='active';};
      const addInventory = async (sourceHome: string, roots: string[]) => {
        const found = await discoveryInventory(sourceHome, roots);
        for (const kind of ['memory', 'skill', 'mcp', 'ssh'] as const) state.ids[kind] = [...new Set([...state.ids[kind], ...found.ids[kind]])];
        state.roots = [...new Set([...state.roots, ...found.roots])];
        state.counts = { projects: state.roots.length, notes: state.documents.length, memories: state.ids.memory.length, skills: state.ids.skill.length, mcp: state.ids.mcp.length, ssh: state.ids.ssh.length };
      };
      if(!await allowed())return;
      // Known hidden coding-app locations are counted immediately, without waiting for the device walk.
      if (!state.homes.includes(home)) { await addInventory(home, []); state.homes.push(home); await save(user, state); }
      if (state.phase === 'files') do {
        if (!await allowed()) return;
        const page = await scanProjectDocuments(user, { auto: true, ...(state.cursor ? { cursor: state.cursor } : {}) }, { purpose: 'watch', home, ...(options.roots ? { roots: options.roots } : {}) });
        if ('allDocumentIds' in page) {
          for (const id of page.allDocumentIds) if (!state.documents.includes(id) && await automaticNoteSource(user, id, home)) state.documents.push(id);
          state.roots=[...new Set([...state.roots,...await preparedDiscoveryRoots(user)])];
          for (const sourceHome of page.memoryHomes) if (!state.homes.includes(sourceHome)) { await addInventory(sourceHome, []); state.homes.push(sourceHome); }
          state.scanned = page.scanned; state.denied = page.deniedRoots; state.unavailable = page.unavailableRoots; state.limited = page.limited; state.cursor = page.nextCursor ?? undefined;
        }
        state.counts.projects = state.roots.length; state.counts.notes = state.documents.length;
        state.notice = `Checked ${state.scanned} entries; found ${state.counts.projects} projects and ${state.counts.memories} memory files.`;
        if (!state.cursor) state.phase = 'inventory';
        await save(user, state); await new Promise<void>(resolve => setImmediate(resolve));
      } while (state.cursor);
      if (!await allowed()) return;
      // Per-project skills and MCP configurations are inventories only: no installation or activation.
      const roots = [...state.roots];
      for (let offset = state.inventoryOffset??0; offset < roots.length; offset += 10) { if (!await allowed()) return; await addInventory(home, roots.slice(offset, offset + 10)); state.inventoryOffset=offset+10;await save(user, state); await new Promise<void>(resolve => setImmediate(resolve)); }
      await prepareAutomaticImport(user, state.documents, state.homes);
      state.status = 'done'; state.notice = `Discovery complete. Files are prepared; memory import starts after your team is ready.${state.denied ? ' Some folders denied access.' : ''}${state.unavailable ? ' Some locations were unavailable.' : ''}${state.limited ? ' Some results reached the scan limit.' : ''}`; await save(user, state);
    } catch { state.status = 'error'; state.notice = 'Discovery could not finish. Saved progress is retained; retry to continue.'; await save(user, state); }
  })().catch(()=>{}).finally(() => { if (active.get(user) === task) active.delete(user); });
  return visible(state);
}
export async function stopFirstRunDiscovery() { await Promise.allSettled([...starting.values()]);for (const task of active.values()) task.stopped = true; await Promise.allSettled([...active.values()].map(task => task.work)); }
