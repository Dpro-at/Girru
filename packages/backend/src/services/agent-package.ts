/**
 * STORE-MAP-01 P5 (T4, S1, CX10): one agent as a package.
 *
 * Export writes nothing to disk: it answers one JSON document the owner
 * saves where they want (so it never overwrites a file the owner manages).
 *
 *   { format: 'girru.agent', schemaVersion: 1, packageHash,
 *     provenance: { app, exportedAt, sourceAgentId },
 *     capabilities: { personality: 1, knowledge: 1 },
 *     limits: { maxBytes, maxKnowledgeFiles, maxFileBytes },
 *     agent: { name, description, emoji, role, department },
 *     instructions,                       the owner's extra instructions
 *     personality: { text, traits, dialect, lockedTraits },
 *     specialties: [{ id, name, revision, contentHash }],   dependencies, by hash
 *     skills: [{ id, name, contentHash }],
 *     knowledge: [{ name, content, sha256, read }] }
 *
 * Import treats the package as untrusted data:
 *  - permissions, tool grants, credentials, keys, hooks/scripts and private
 *    history (memory, notes, conversations) are never imported: such fields
 *    are left out and listed; the new agent starts with the safe default
 *    permissions like every new agent;
 *  - a value that looks like a secret refuses the whole package; size, file
 *    count, names (no folders, no "..") and the package hash are checked;
 *  - a specialty or skill is linked only when this computer already has it
 *    with the same content hash (nothing is downloaded, online or offline);
 *  - imported text stays content (personality, instructions, knowledge),
 *    never authority; the import is recorded with its hash (provenance).
 * A preview answers exactly what an import would create.
 */

import { createHash, randomUUID } from 'node:crypto';
import { all, one, run, sql } from '../repositories/sql-steps.js';
import { insertAgentConfigStep, newAgentId } from '../repositories/agents-config.js';
import { AgentNameTakenError, resolveNamingLanguage, suggestAgentName, validateAgentName } from './agent-names.js';
import { redactImportText } from '../memory/import/redact.js';
import { DIALECTS, TRAIT_NAMES, isAgentRole, normalizeDepartment, validateTraits, type Traits } from './personality.js';
import { appendVersion, currentPersonalityStep, putPersonalityTextStep } from './personality-store.js';
import { personalityTextFor, writePersonalityView } from './personality-record.js';
import { addFile, listFiles, readFile } from './agent-file-library.js';
import { writePersonality } from './agent-files.js';
import { storeP4Enabled } from './store-p4.js';

export const PACKAGE_FORMAT = 'girru.agent';
export const PACKAGE_SCHEMA_VERSION = 1;
export const MAX_PACKAGE_BYTES = 4 * 1024 * 1024;
export const MAX_KNOWLEDGE_FILES = 50;
export const MAX_FILE_BYTES = 1024 * 1024;
const KNOWN = ['format', 'schemaVersion', 'packageHash', 'provenance', 'capabilities', 'limits', 'agent', 'instructions', 'personality', 'specialties', 'skills', 'knowledge'];
/** Never imported, whatever the package says (listed in `refused`). */
const NEVER = /^(permissions?|grants?|tools?|credentials?|secrets?|api_?keys?|keys?|tokens?|hooks?|scripts?|install|postinstall|preinstall|exec|commands?|memory|notes|history|conversations?|messages|chats?|mcp)$/i;
const KNOWLEDGE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,78}\.(md|txt|csv|json)$/i;
const HASH = /^[a-f0-9]{64}$/;

export class AgentPackageError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413, readonly code: string, readonly detail?: string) { super(code); }
}

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
/** Canonical JSON (sorted keys), so the hash names the content, not its layout. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export function packageHashOf(pkg: Record<string, unknown>): string {
  const { packageHash: _drop, ...rest } = pkg;
  return sha(canonical(rest));
}

/** Export one agent (owner only; checked by the route). Private history and authority are never in it. */
export async function exportAgentPackage(agentId: string): Promise<Record<string, unknown>> {
  const agent = await sql().read(one<{ id: string; name: string; description: string | null; emoji: string | null; role: string | null; department: string | null; system_prompt: string | null }>(
    'SELECT id, name, description, emoji, role, department, system_prompt FROM agents_config WHERE id = ?', agentId));
  if (!agent) throw new AgentPackageError(404, 'not_found');
  const current = await sql().read(currentPersonalityStep(agentId));
  const specialties = await sql().read(all<{ id: string; name: string; revision: number; content_hash: string }>(
    'SELECT t.id, t.name, t.revision, t.content_hash FROM agent_specialties s JOIN specialty_templates t ON t.id = s.template_id WHERE s.agent_id = ? ORDER BY t.name', agentId));
  const skills = await sql().read(all<{ id: string; name: string; content_hash: string }>(
    'SELECT k.id, k.name, k.content_hash FROM central_agent_skills a JOIN central_skills k ON k.id = a.skill_id WHERE a.agent_id = ? ORDER BY k.name', agentId));
  const knowledge: { name: string; content: string; sha256: string; read: boolean }[] = [];
  for (const f of (await listFiles(agentId)).files.filter((x) => x.kind === 'knowledge').slice(0, MAX_KNOWLEDGE_FILES)) {
    const view = await readFile(agentId, f.name); // secrets are already hidden when shown
    knowledge.push({ name: f.name, content: view.content, sha256: sha(view.content), read: f.read });
  }
  const pkg: Record<string, unknown> = {
    format: PACKAGE_FORMAT,
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    provenance: { app: 'Girru', exportedAt: new Date().toISOString(), sourceAgentId: agent.id },
    capabilities: { personality: 1, knowledge: 1 },
    limits: { maxBytes: MAX_PACKAGE_BYTES, maxKnowledgeFiles: MAX_KNOWLEDGE_FILES, maxFileBytes: MAX_FILE_BYTES },
    agent: { name: agent.name, description: agent.description ?? '', emoji: agent.emoji ?? '', role: agent.role, department: agent.department },
    instructions: redactImportText(agent.system_prompt ?? '').text,
    personality: {
      text: redactImportText(await personalityTextFor(agentId).catch(() => '')).text,
      traits: current?.traits ?? null, dialect: current?.dialect ?? null, lockedTraits: current?.lockedTraits ?? [],
    },
    specialties: specialties.map((s) => ({ id: s.id, name: s.name, revision: Number(s.revision), contentHash: s.content_hash })),
    skills: skills.map((s) => ({ id: s.id, name: s.name, contentHash: s.content_hash })),
    knowledge,
  };
  return { ...pkg, packageHash: packageHashOf(pkg) };
}

export interface PackagePlan {
  packageHash: string;
  schemaVersion: number;
  agent: { name: string; description: string; emoji: string; role: string | null; department: string | null };
  instructions: string;
  personality: { text: string; traits: Traits | null; dialect: string | null; lockedTraits: string[] };
  specialties: { id: string; name: string }[];
  skills: { id: string; name: string }[];
  knowledge: { name: string; content: string; read: boolean }[];
  /** What the package asked for that is left out, with why. */
  refused: { field: string; why: string }[];
  /** Dependencies this computer does not have with the same content (not downloaded). */
  missing: { kind: 'specialty' | 'skill'; name: string }[];
  alreadyImported: string | null;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
function secretCheck(field: string, text: string): void {
  if (redactImportText(text).text !== text) throw new AgentPackageError(400, 'secret_found', field);
}

/** Check an untrusted package and plan the import (nothing is written). */
export async function planAgentPackage(raw: unknown): Promise<PackagePlan> {
  let text: string;
  try { text = typeof raw === 'string' ? raw : JSON.stringify(raw); } catch { throw new AgentPackageError(400, 'invalid_package'); }
  if (Buffer.byteLength(text, 'utf8') > MAX_PACKAGE_BYTES) throw new AgentPackageError(413, 'too_large');
  let pkg: Record<string, unknown>;
  try { pkg = typeof raw === 'string' ? JSON.parse(raw) : raw as Record<string, unknown>; } catch { throw new AgentPackageError(400, 'invalid_package'); }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new AgentPackageError(400, 'invalid_package');
  if (pkg.format !== PACKAGE_FORMAT) throw new AgentPackageError(400, 'not_an_agent_package');
  const version = pkg.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new AgentPackageError(400, 'schema_version');
  if (version > PACKAGE_SCHEMA_VERSION) throw new AgentPackageError(400, 'newer_package', `made by a newer Girru (format ${version})`);
  const packageHash = packageHashOf(pkg);
  if (pkg.packageHash !== undefined && pkg.packageHash !== packageHash) throw new AgentPackageError(400, 'hash_mismatch');

  const refused: PackagePlan['refused'] = [];
  for (const k of Object.keys(pkg)) {
    if (NEVER.test(k)) refused.push({ field: k, why: 'never imported (permissions, credentials, hooks and private history stay on the computer that made them)' });
    else if (!KNOWN.includes(k)) refused.push({ field: k, why: 'unknown field' });
  }
  const a = (pkg.agent && typeof pkg.agent === 'object' && !Array.isArray(pkg.agent) ? pkg.agent : {}) as Record<string, unknown>;
  for (const k of Object.keys(a)) if (NEVER.test(k)) refused.push({ field: `agent.${k}`, why: 'never imported' });
  const name = str(a.name, 80).trim();
  if (!name) throw new AgentPackageError(400, 'invalid_package', 'agent.name');
  const role = typeof a.role === 'string' && isAgentRole(a.role) ? a.role : null;
  let department: string | null = null;
  try { department = typeof a.department === 'string' && a.department.trim() ? normalizeDepartment(a.department) : null; } catch { department = null; }
  const agent = { name, description: str(a.description, 2000), emoji: str(a.emoji, 8), role, department };
  const instructions = str(pkg.instructions, 32_000);

  const p = (pkg.personality && typeof pkg.personality === 'object' && !Array.isArray(pkg.personality) ? pkg.personality : {}) as Record<string, unknown>;
  let traits: Traits | null = null;
  try { traits = p.traits ? validateTraits(p.traits) : null; } catch { refused.push({ field: 'personality.traits', why: 'not valid' }); }
  const dialect = typeof p.dialect === 'string' && (DIALECTS as readonly string[]).includes(p.dialect) ? p.dialect : null;
  const lockedTraits = Array.isArray(p.lockedTraits) ? p.lockedTraits.filter((t): t is string => typeof t === 'string' && (TRAIT_NAMES as readonly string[]).includes(t)) : [];
  const personality = { text: str(p.text, MAX_FILE_BYTES), traits, dialect, lockedTraits };

  const knowledge: PackagePlan['knowledge'] = [];
  const files = Array.isArray(pkg.knowledge) ? pkg.knowledge : [];
  if (files.length > MAX_KNOWLEDGE_FILES) throw new AgentPackageError(413, 'too_many_files');
  const seen = new Set<string>();
  for (const f of files) {
    const e = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
    const n = typeof e.name === 'string' ? e.name : '';
    if (!KNOWLEDGE_NAME.test(n) || n.includes('..') || n.includes('/') || n.includes('\\') || ['personality.md', 'memory.md'].includes(n.toLowerCase())) { refused.push({ field: `knowledge:${n.slice(0, 80)}`, why: 'not a plain file name (folders, links and agent files are refused)' }); continue; }
    if (e.link !== undefined || e.symlink !== undefined || e.target !== undefined) { refused.push({ field: `knowledge:${n}`, why: 'links are refused' }); continue; }
    if (typeof e.content !== 'string' || Buffer.byteLength(e.content, 'utf8') > MAX_FILE_BYTES) { refused.push({ field: `knowledge:${n}`, why: 'not text, or larger than 1 MB' }); continue; }
    if (e.sha256 !== undefined && e.sha256 !== sha(e.content)) throw new AgentPackageError(400, 'hash_mismatch', `knowledge:${n}`);
    if (seen.has(n.toLowerCase())) { refused.push({ field: `knowledge:${n}`, why: 'the name is used twice' }); continue; }
    seen.add(n.toLowerCase());
    knowledge.push({ name: n, content: e.content, read: e.read !== false });
  }

  // A secret anywhere in what would be imported refuses the whole package.
  secretCheck('instructions', instructions);
  secretCheck('personality.text', personality.text);
  secretCheck('agent.description', agent.description);
  for (const k of knowledge) secretCheck(`knowledge:${k.name}`, k.content);

  // Dependencies: linked only when this computer has the same content (never fetched).
  const specialties: PackagePlan['specialties'] = [];
  const skills: PackagePlan['skills'] = [];
  const missing: PackagePlan['missing'] = [];
  for (const s of (Array.isArray(pkg.specialties) ? pkg.specialties : []).slice(0, 10)) {
    const e = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
    const label = str(e.name, 80) || 'a specialty';
    const hash = typeof e.contentHash === 'string' && HASH.test(e.contentHash) ? e.contentHash : null;
    const local = hash ? await sql().read(one<{ id: string; name: string }>(
      `SELECT id, name FROM specialty_templates WHERE content_hash = ?
       UNION SELECT template_id AS id, name FROM specialty_template_versions WHERE content_hash = ? LIMIT 1`, hash, hash)) : undefined;
    if (local) specialties.push({ id: local.id, name: local.name }); else missing.push({ kind: 'specialty', name: label });
  }
  for (const s of (Array.isArray(pkg.skills) ? pkg.skills : []).slice(0, 50)) {
    const e = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
    const hash = typeof e.contentHash === 'string' && HASH.test(e.contentHash) ? e.contentHash : null;
    const local = hash ? await sql().read(one<{ id: string; name: string }>('SELECT id, name FROM central_skills WHERE content_hash = ?', hash)) : undefined;
    if (local) skills.push({ id: local.id, name: local.name }); else missing.push({ kind: 'skill', name: str(e.name, 80) || 'a skill' });
  }
  const prior = await sql().read(one<{ agent_id: string }>('SELECT agent_id FROM agent_package_imports WHERE package_hash = ? ORDER BY imported_at DESC LIMIT 1', packageHash));
  return { packageHash, schemaVersion: version, agent, instructions, personality, specialties, skills, knowledge, refused, missing, alreadyImported: prior?.agent_id ?? null };
}

/**
 * Import a package as a new agent. `expectedPackageHash` is the hash the
 * owner saw in the preview (409 when the package differs). A package already
 * imported answers 409 `already_imported` unless `again` is true.
 */
export async function importAgentPackage(raw: unknown, ownerId: string, opts: { expectedPackageHash: unknown; again?: boolean }): Promise<{ agentId: string; plan: PackagePlan }> {
  const plan = await planAgentPackage(raw);
  if (opts.expectedPackageHash !== plan.packageHash) throw new AgentPackageError(409, 'preview_changed');
  if (plan.alreadyImported && opts.again !== true) throw new AgentPackageError(409, 'already_imported', plan.alreadyImported);
  const language = await resolveNamingLanguage(ownerId);
  let name = plan.agent.name;
  try { name = validateAgentName(name); } catch { name = (await suggestAgentName(language)).name; }
  const taken = await sql().read(one('SELECT id FROM agents_config WHERE lower(name) = lower(?)', name));
  if (taken) name = (await suggestAgentName(language)).name;
  const agentId = newAgentId();
  const p4 = storeP4Enabled();
  // A name used before stays reserved: one more try with a fresh name.
  for (let attempt = 0; ; attempt++) {
    try { await createStep(); break; }
    catch (err) { if (!(err instanceof AgentNameTakenError) || attempt > 0) throw err; name = (await suggestAgentName(language)).name; }
  }
  async function createStep() { await sql().tx(function* () {
    yield* insertAgentConfigStep({
      id: agentId, name, language, role: plan.agent.role as never, department: plan.agent.department, userId: ownerId,
      explicit: null, body: { description: plan.agent.description, emoji: plan.agent.emoji || undefined, system_prompt: plan.instructions },
    });
    // The personality: its adjustments (and with the record on, its text) as this agent's first version.
    const current = yield* currentPersonalityStep(agentId, { lock: true });
    if (current && (plan.personality.traits || p4)) {
      yield* appendVersion(agentId, ownerId, {
        traits: plan.personality.traits ?? current.traits, preset: null, dialect: (plan.personality.dialect ?? current.dialect) as never,
        locked: false, lockedTraits: plan.personality.lockedTraits as never, source: 'import', basedOnVersion: current.version || null,
        note: 'imported from an agent package', ...(p4 ? { textHash: yield* putPersonalityTextStep(plan.personality.text) } : {}),
      });
    }
    for (const s of plan.specialties) yield* run('INSERT INTO agent_specialties (agent_id, template_id, linked_by) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', agentId, s.id, ownerId);
    if (plan.skills.length) {
      yield* run('INSERT INTO central_skill_assignments (agent_id, revision) VALUES (?, 1) ON CONFLICT DO NOTHING', agentId);
      for (const s of plan.skills) yield* run('INSERT INTO central_agent_skills (agent_id, skill_id) VALUES (?, ?) ON CONFLICT DO NOTHING', agentId, s.id);
    }
    yield* run('INSERT INTO agent_package_imports (id, agent_id, package_hash, schema_version, source_name, refused, imported_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      randomUUID(), agentId, plan.packageHash, plan.schemaVersion, plan.agent.name.slice(0, 80), JSON.stringify([...plan.refused, ...plan.missing.map((m) => ({ field: `${m.kind}:${m.name}`, why: 'not on this computer' }))]), ownerId);
  }, { immediate: true }); }
  if (p4) await writePersonalityView(agentId).catch(() => {});
  else if (plan.personality.text) await writePersonality(agentId, plan.personality.text).catch(() => {});
  for (const k of plan.knowledge) await addFile(agentId, k.name, k.content, k.read).catch(() => {});
  return { agentId, plan };
}
