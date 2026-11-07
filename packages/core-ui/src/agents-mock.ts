import { namingKey, validatedDisplayName } from './naming';
import { validVersion } from './agents';
import type { PublicAgent } from './agents';
import type { WireRequest, WireResponse } from './session';
import type { CreateBody, Preset } from './hire';
import { rolesFor } from './team-split';
import type { TeamRole } from './team-split';

/** Fictional tools for offline practice only. */
const mockTools = [
  { name: 'memory_search', description: 'Search what the agent remembers.', execClass: false, allowedByServer: true, requiresApproval: false },
  { name: 'memory_save', description: 'Save a new memory.', execClass: false, allowedByServer: true, requiresApproval: false },
  { name: 'memory_forget', description: 'Forget a memory.', execClass: false, allowedByServer: true, requiresApproval: true },
  { name: 'storage_search', description: 'Search stored files.', execClass: false, allowedByServer: true, requiresApproval: false },
  { name: 'web_fetch', description: 'Read a public web page.', execClass: false, allowedByServer: true, requiresApproval: false },
  { name: 'telegram_send', description: 'Send a Telegram message.', execClass: false, allowedByServer: true, requiresApproval: true },
  { name: 'exec', description: 'Run a shell command.', execClass: true, allowedByServer: false, requiresApproval: false },
];
const defaultGrants = ['memory_search', 'memory_save', 'memory_forget', 'storage_search'];

/** Fictional in-memory registry with atomic name/version checks and own retired-name reclamation. */
export function createAgentsMock() {
  const rows = new Map<string, Extract<PublicAgent, { name: string }>>([
    ['sample-main', { id: 'sample-main', name: 'Offline main', version: 1 }],
    ['sample-helper', { id: 'sample-helper', name: 'Offline helper', version: 1 }],
  ]);
  const registry = new Map([...rows.values()].map(a => [namingKey(a.name), a.id]));
  const grants = new Map<string, { version: number; tools: string[] }>();
  const permissions = new Map<string, { agentId: string; memoryRead: string[]; memoryWrite: string[]; sharedMemory: boolean; modes: Record<string, string>; version: number }>();
  let hired = 0;
  // AGENTS-ORG-01 offline: the first agent is the main agent; everyone else reports to it unless moved.
  const reports = new Map<string, string>();
  const withOrg = (a: Extract<PublicAgent, { name: string }>) => a.id === 'sample-main' ? { ...a, placed: 'main', manager: null, reportsTo: null, subAgentOf: null } : { ...a, placed: reports.has(a.id) ? 'set' : 'auto', manager: reports.get(a.id) ?? 'sample-main', reportsTo: reports.get(a.id) ?? null, subAgentOf: null };
  const fictionalFile = (name: string) => ({ name, kind: name === 'PERSONALITY.md' ? 'who' : 'mind', content: name === 'PERSONALITY.md' ? '# Offline practice\nA fictional agent file.' : '', hash: null, managed: null, redacted: false, read: true });
  const grantsView = (id: string, withAvailable: boolean) => {
    const g = grants.get(id) ?? { version: 1, tools: [...defaultGrants] }; grants.set(id, g);
    return { agentId: id, source: 'default', parentAgentId: null, version: g.version, grants: g.tools.map(tool => ({ tool, scopes: null })),
      ...(withAvailable ? { available: mockTools.map(t => ({ ...t, extensionId: null, mcp: null })) } : {}) };
  };
  // ONBOARD-TEAM-02: fictional batches (equal split; same role rule as the server).
  const batches = new Map<string, { plan: string; items: { dep: string; role: TeamRole; preset: string; status: 'pending' | 'created' | 'failed'; name?: string }[] }>();
  const progressOf = (id: string) => {
    const b = batches.get(id)!; const deps = [...new Set(b.items.map(i => i.dep))];
    const n = (st: string, dep?: string) => b.items.filter(i => i.status === st && (!dep || i.dep === dep)).length;
    return { id, total: b.items.length, created: n('created'), failed: n('failed'), pending: n('pending'), done: n('pending') === 0, createdAt: 'x',
      departments: deps.map(dep => ({ department: dep, total: b.items.filter(i => i.dep === dep).length, created: n('created', dep), failed: n('failed', dep) })) };
  };
  const label = (dep: string) => dep.replace(/^./, c => c.toUpperCase());
  const share = (dep: string, count: number) => ({ department: dep, departmentLabel: label(dep), count, roles: rolesFor(count),
    titles: { manager: `${label(dep)} lead`, specialist: `${label(dep)} specialist`, evaluator: `${label(dep)} reviewer` },
    presets: { manager: dep === 'finance' ? 'careful-auditor' : dep === 'marketing' ? 'bold-creative' : 'balanced-assistant', specialist: dep === 'finance' ? 'careful-auditor' : dep === 'marketing' ? 'bold-creative' : 'balanced-assistant', evaluator: 'strict-evaluator' } });
  const create = (b: CreateBody): WireResponse => {
    let name = b.name ? validatedDisplayName(b.name) : `Offline hire ${hired + 1}`;
    if (!name) return { status: 400, body: null };
    if (registry.has(namingKey(name))) { if (b.name) return { status: 409, body: { code: 'name_taken' } }; name = `${name} ${Date.now() % 1000}`; }
    const id = `hired-${++hired}`;
    const agent = { id, name, version: 1 }; rows.set(id, agent); registry.set(namingKey(name), id);
    return { status: 201, body: { agent: { ...agent, role: b.role, department: b.department ?? null } } };
  };
  const update = (id: string, name: string, expectedVersion: unknown): WireResponse => {
    if (!validVersion(expectedVersion)) return { status: 400, body: { code: 'invalid_version' } };
    const a = rows.get(id); if (!a) return { status: 404, body: null };
    if (a.version !== expectedVersion) return { status: 409, body: { code: 'version_conflict', currentVersion: a.version, agent: { ...a } } };
    const normalized = validatedDisplayName(name); if (!normalized) return { status: 400, body: null };
    const key = namingKey(normalized); const owner = registry.get(key);
    if (owner && owner !== id) return { status: 409, body: { code: 'name_taken' } };
    registry.set(key, id);
    const current = { ...a, name: normalized, version: a.version + (normalized !== a.name ? 1 : 0) }; rows.set(id, current);
    return { status: 200, body: { agent: { ...current } } };
  };
  return {
    // Test-only concurrent fictional writer, never a UI transport escape hatch.
    update,
    transport(request: WireRequest): WireResponse {
      if (request.method === 'GET' && request.path === '/api/agents') return { status: 200, body: { agents: [...rows.values()].map(withOrg) } };
      const org = /^\/api\/agents\/([^/]+)\/reports-to$/.exec(request.path);
      if (org && request.method === 'PUT') {
        const a = rows.get(org[1]); const to = (request.body as { reportsTo?: string | null }).reportsTo ?? null;
        if (!a) return { status: 404, body: { code: 'not_found' } };
        if (a.id === 'sample-main') return { status: 400, body: { code: 'main_fixed' } };
        if (to !== null && (!rows.has(to) || to === a.id)) return { status: 400, body: { code: 'invalid_target' } };
        if (to === null) reports.delete(a.id); else reports.set(a.id, to);
        const next = { ...a, version: a.version + 1 }; rows.set(a.id, next);
        return { status: 200, body: { id: a.id, reportsTo: to, version: next.version } };
      }
      const lib = /^\/api\/agents\/([^/]+)\/library(\/file)?(\?.*)?$/.exec(request.path);
      if (lib && request.method === 'GET' && rows.has(lib[1])) {
        if (!lib[2]) return { status: 200, body: { files: [{ name: 'PERSONALITY.md', kind: 'who', size: 40, read: true }, { name: 'MEMORY.md', kind: 'mind', size: 0, read: true }], removed: [] } };
        const name = new URLSearchParams((lib[3] ?? '').slice(1)).get('name') ?? '';
        return name === 'PERSONALITY.md' || name === 'MEMORY.md' ? { status: 200, body: fictionalFile(name) } : { status: 404, body: { code: 'not_found' } };
      }
      if (request.path === '/api/me/agents-chart') return request.method === 'GET' ? { status: 200, body: { chart: { view: 'list', mode: 'reports', lines: 'elbow', zoom: 1, folded: [] } } } : { status: 200, body: { chart: { view: 'list', mode: 'reports', lines: 'elbow', zoom: 1, folded: [], ...(request.body as object) } } };
      if (request.method === 'POST' && request.path === '/api/agents/name-suggestion') {
        const b = request.body as { language: string; exclude: string[] }; let n = 1; let name = 'Offline candidate';
        while (registry.has(namingKey(name)) || b.exclude.some(x => namingKey(x) === namingKey(name))) name = `Offline candidate ${++n}`;
        return { status: 200, body: { name, language: b.language, exhausted: n > 1 } };
      }
      if (request.method === 'POST' && request.path === '/api/agents') return create(request.body as CreateBody);
      if (request.method === 'GET' && request.path === '/api/onboarding/team-catalogue') return { status: 200, body: {
        sizes: [{ id: 'solo', label: 'Just me' }, { id: 'small', label: '2–10 agents' }, { id: 'medium', label: '11–50 agents' }, { id: 'large', label: 'More than 50 agents' }],
        departments: [{ id: 'marketing', label: 'Marketing', summary: 'Fictional campaigns.' }, { id: 'finance', label: 'Finance', summary: 'Fictional invoices.' }, { id: 'support', label: 'Customer support', summary: 'Fictional customers.' }],
        maxDepartments: 12, maxCustomDepartments: 4 } };
      if (request.method === 'POST' && request.path === '/api/onboarding/team-plan') {
        const b = request.body as { size: 'solo' | 'small' | 'medium' | 'large'; departments: string[] };
        const roles = ({ solo: ['specialist'], small: ['manager', 'specialist'], medium: ['manager', 'specialist', 'specialist', 'evaluator'], large: ['manager', 'specialist', 'specialist', 'specialist', 'evaluator'] } as const)[b.size];
        let n = 0;
        const hires = b.departments.flatMap(dep => roles.map(role => ({ department: dep, departmentLabel: dep.replace(/^./, c => c.toUpperCase()), role, title: `Offline ${role}`, description: `Offline ${role} in ${dep}.`, preset: dep === 'finance' ? 'careful-auditor' : dep === 'marketing' ? 'bold-creative' : 'balanced-assistant', name: `Offline plan ${++n}` })));
        return { status: 200, body: { size: b.size, language: 'en', hires } };
      }
      if (request.method === 'POST' && request.path === '/api/onboarding/team-distribution') {
        const b = request.body as { departments: string[]; total?: number; counts?: Record<string, number> };
        let counts = b.counts;
        if (!counts) {
          const total = b.total!; if (total < b.departments.length) return { status: 400, body: { code: 'invalid_plan' } };
          const base = Math.floor(total / b.departments.length); let extra = total - base * b.departments.length;
          counts = Object.fromEntries(b.departments.map(d => [d, base + (extra-- > 0 ? 1 : 0)]));
        }
        const departments = b.departments.map(d => share(d, counts![d]));
        return { status: 200, body: { total: departments.reduce((a, d) => a + d.count, 0), departments } };
      }
      if (request.path === '/api/onboarding/team-batches') {
        if (request.method === 'GET') return { status: 200, body: { batches: [...batches.keys()].filter(id => batches.get(id)!.items.some(i => i.status !== 'created')).map(progressOf) } };
        const b = request.body as { id: string; departments: { department: string; count: number; presets?: Partial<Record<TeamRole, string>> }[] };
        const plan = JSON.stringify(b.departments);
        const existing = batches.get(b.id);
        if (existing) return existing.plan === plan ? { status: 200, body: { created: false, batch: progressOf(b.id) } } : { status: 409, body: { code: 'batch_conflict' } };
        const items = b.departments.flatMap(d => { const s = share(d.department, d.count); return (['manager', 'specialist', 'evaluator'] as const).flatMap(role => Array.from({ length: s.roles[role] }, () => ({ dep: d.department, role, preset: d.presets?.[role] ?? s.presets[role], status: 'pending' as const }))); });
        batches.set(b.id, { plan, items });
        return { status: 201, body: { created: true, batch: progressOf(b.id) } };
      }
      const batchMatch = /^\/api\/onboarding\/team-batches\/([^/]+)(\/run)?$/.exec(request.path);
      if (batchMatch) {
        const id = batchMatch[1]; const b = batches.get(id);
        if (!b) return { status: 404, body: { code: 'batch_not_found' } };
        if (!batchMatch[2]) return { status: 200, body: { batch: progressOf(id) } };
        const body = request.body as { max?: number; retryFailed?: boolean };
        if (body.retryFailed) b.items.forEach(i => { if (i.status === 'failed') i.status = 'pending'; });
        const results: unknown[] = [];
        b.items.forEach((item, i) => {
          if (item.status !== 'pending' || results.length >= (body.max ?? 25)) return;
          const r = create({ role: item.role, department: item.dep, description: `${label(item.dep)} ${item.role}.`, personality: { preset: item.preset as Preset } });
          const agent = (r.body as { agent?: { id: string; name: string } }).agent;
          if (r.status === 201 && agent) { item.status = 'created'; item.name = agent.name; results.push({ seq: i + 1, status: 'created', agentId: agent.id, name: agent.name }); }
          else { item.status = 'failed'; results.push({ seq: i + 1, status: 'failed', code: 'create_failed' }); }
        });
        return { status: 200, body: { results, batch: progressOf(id) } };
      }
      // CORE-PERMS-01: fictional per-agent memory scope and modes (new agents: everything on "ask").
      const permsFor = /^\/api\/agents\/([^/]+)\/permissions$/.exec(request.path)?.[1];
      if (permsFor) {
        if (!rows.has(permsFor)) return { status: 404, body: null };
        const kinds = ['owner', 'project', 'experience', 'task', 'people'];
        const current = permissions.get(permsFor) ?? { agentId: permsFor, memoryRead: kinds, memoryWrite: kinds, sharedMemory: false,
          modes: { browser: 'ask', network: 'ask', message: 'ask', delete: 'ask', install: 'ask', money: 'ask', settings: 'ask' }, version: 1 };
        if (request.method === 'GET') return { status: 200, body: { ...current, stored: true } };
        const b = request.body as { memoryRead: string[]; memoryWrite: string[]; sharedMemory: boolean; modes: Record<string, string>; expectedVersion: number };
        if (b.expectedVersion !== current.version) return { status: 409, body: { code: 'version_conflict', currentVersion: current.version, ...current } };
        const next = { agentId: permsFor, memoryRead: b.memoryRead, memoryWrite: b.memoryWrite, sharedMemory: b.sharedMemory, modes: b.modes, version: current.version + 1 };
        permissions.set(permsFor, next);
        return { status: 200, body: { ...next, stored: true } };
      }
      const grantsFor = /^\/api\/agents\/([^/]+)\/tool-grants$/.exec(request.path)?.[1];
      if (grantsFor) {
        if (!rows.has(grantsFor)) return { status: 404, body: null };
        if (request.method === 'GET') return { status: 200, body: grantsView(grantsFor, true) };
        const b = request.body as { grants: string[]; expectedVersion: number };
        const current = grantsView(grantsFor, false);
        if (b.expectedVersion !== current.version) return { status: 409, body: { code: 'version_conflict', currentVersion: current.version, ...current } };
        if (b.grants.some(t => !mockTools.some(m => m.name === t))) return { status: 400, body: null };
        grants.set(grantsFor, { version: current.version + 1, tools: [...b.grants] });
        return { status: 200, body: grantsView(grantsFor, false) };
      }
      const id = request.path.slice('/api/agents/'.length);
      if (request.method === 'GET') return rows.has(id) ? { status: 200, body: { agent: { ...rows.get(id) } } } : { status: 404, body: null };
      if (request.method === 'PUT') {
        const b = structuredClone(request.body) as { name?: string; expectedVersion: number; role?: string | null; department?: string | null; description?: string; model?: string; provider?: string; modelSelection?: string };
        if (b.name !== undefined) return update(id, b.name, b.expectedVersion);
        const row = rows.get(id);
        if (!row) return { status: 404, body: null };
        if (b.expectedVersion !== row.version) return { status: 409, body: { code: 'version_conflict', currentVersion: row.version, agent: { ...row } } };
        if (b.modelSelection !== undefined) {
          // Fixture backend catalogue, not live inference or authorization.
          const catalogue: Record<string, string> = { 'qwen-fiction:7b': 'ollama', 'llama-fiction:3b': 'ollama', 'subscription:claude': 'subscription', 'subscription:codex': 'subscription', 'subscription:gemini': 'subscription' };
          if (!catalogue[b.modelSelection]) return { status: 400, body: { code: 'invalid_model' } };
          b.model = b.modelSelection; b.provider = catalogue[b.modelSelection];
        }
        const next = { ...row, version: row.version + 1, ...(b.role !== undefined ? { role: b.role } : {}), ...(b.department !== undefined ? { department: b.department } : {}), ...(b.description !== undefined ? { description: b.description } : {}), ...(b.model !== undefined ? { model: b.model, provider: b.provider } : {}) } as typeof row;
        rows.set(id, next);
        return { status: 200, body: { agent: { ...next } } };
      }
      return { status: 400, body: null };
    },
  };
}
