// RULES-01: Agents › Rules. The owner's rules for how the agents work: where each applies
// (everywhere / one project) and who follows it (all agents / departments / chosen agents).
// Agents only suggest; the owner accepts, changes or dismisses. Delete keeps the rule for Undo.
import type { SessionClient } from './session';

export type RuleWho = 'all' | 'departments' | 'agents';
export type Rule = Readonly<{ id: string; text: string; when: string | null; projectId: string | null; who: RuleWho; targets: readonly string[]; paused: boolean; status: 'active' | 'suggested'; source: 'owner' | 'agent' | 'girru'; shipped: boolean; locked: boolean; suggestedBy: string | null; reason: string | null; version: number; createdAt: string; updatedAt: string;
  /** STORE-MAP-01 P2: precedence group, on the list an agent gets when the backend orders by precedence. */
  group?: PrecedenceGroup }>;
export type RuleVersion = Readonly<{ version: number; text: string; when: string | null; changedAt: string }>;
export type RuleProject = Readonly<{ id: string; name: string; folder?: string | null }>;
export type FilesState = Readonly<{ projectId: string; hasFolder: boolean; mode: 'private' | 'project'; written: boolean; upToDate: boolean; files: readonly { name: string; action: 'create' | 'add' | 'update' | 'unchanged' | 'tracked' | 'link' }[]; rules: string;
  /** TASKLOG-01: the project's task file (.girru/tasks.md): on or off, open tasks, lines to fix. */
  tasks?: Readonly<{ on: boolean; file: string; open: number; problems: readonly { line: number; message: string }[] }> }>;
export type RuleAgent = Readonly<{ id: string; name: string; department: string | null }>;
export type RuleGroup = Readonly<{ id: string; title: string; icon: 'bulb' | 'globe' | 'folder' | 'avatar'; rules: readonly Rule[] }>;
/** STORE-MAP-01 P2 (AG6): precedence groups, strongest first. */
export type PrecedenceGroup = 'safety' | 'project' | 'agents' | 'departments' | 'all';
export const PRECEDENCE_TITLES: Readonly<Record<PrecedenceGroup, string>> = { safety: 'Safety (always on)', project: 'This project', agents: 'For this agent', departments: 'Its department', all: 'All agents' };
export const PRECEDENCE_ORDER: readonly PrecedenceGroup[] = ['safety', 'project', 'agents', 'departments', 'all'];

export type RulesState = Readonly<{
  phase: 'idle' | 'loading' | 'ready' | 'error'; files: Readonly<Record<string, FilesState>>; rules: readonly Rule[]; suggestions: readonly Rule[]; departments: readonly string[]; projects: readonly RuleProject[];
  selected: string | null; notice: string | null; toast: { id: number; text: string; undo: boolean } | null; lastDeleted: string | null; busy: boolean;
  /** STORE-MAP-01 P2: the backend applies rules by precedence group (the page says so). */
  precedence: boolean;
}>;
export type RuleChange = Partial<{ text: string; when: string | null; projectId: string | null; who: RuleWho; targets: string[]; paused: boolean }>;

const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const err = (body: unknown, fallback: string) => (record(body) && typeof body.error === 'string' ? body.error : fallback);

/** Where a rule sits on the page (and in the order agents get it): suggestions, everywhere, each project, one agent. */
export function ruleGroups(rules: readonly Rule[], suggestions: readonly Rule[], projects: readonly RuleProject[]): RuleGroup[] {
  const out: RuleGroup[] = [];
  if (suggestions.length) out.push({ id: 'suggested', title: 'Suggested by an agent', icon: 'bulb', rules: suggestions });
  // RULES-04: plain group names that say what a rule reaches.
  out.push({ id: 'everywhere', title: 'Everywhere · all agents', icon: 'globe', rules: rules.filter(r => !r.projectId && r.who === 'all') });
  // Every project with a folder gets its heading (its files line lives there), even without rules of its own.
  const ids = [...new Set([...rules.filter(r => r.projectId && r.who !== 'agents').map(r => r.projectId!), ...projects.filter(p => p.folder).map(p => p.id)])];
  for (const id of ids) out.push({ id: `project:${id}`, title: `Project · ${projects.find(p => p.id === id)?.name ?? 'A project'}`, icon: 'folder', rules: rules.filter(r => r.projectId === id && r.who !== 'agents') });
  const chosen = rules.filter(r => r.who === 'agents' || (!r.projectId && r.who === 'departments'));
  if (chosen.length) out.push({ id: 'agents', title: 'Chosen agents', icon: 'avatar', rules: chosen });
  return out.filter(g => g.rules.length || g.id.startsWith('project:'));
}

/** How an agent reads a rule (the server's words): "When X: rule", or the rule alone. */
export const ruleLine = (r: Pick<Rule, 'text' | 'when'>) => (r.when ? `When ${r.when}: ${r.text}` : r.text);
/** Who follows a rule, in words ("All agents", "Development · 3 agents", "QA Tester"). */
export function whoWords(r: Pick<Rule, 'who' | 'targets' | 'projectId'>, agents: readonly RuleAgent[], projects: readonly RuleProject[] = []): string {
  const where = r.projectId ? ` · ${projects.find(p => p.id === r.projectId)?.name ?? 'a project'}` : '';
  if (r.who === 'all') return r.projectId ? 'All agents in this project' : 'All agents';
  if (r.who === 'agents') return r.targets.map(id => agents.find(a => a.id === id)?.name ?? 'An agent').join(', ') + where;
  const n = agents.filter(a => a.department && r.targets.includes(a.department.toLowerCase())).length;
  return `${r.targets.map(cap).join(', ')} · ${n} ${n === 1 ? 'agent' : 'agents'}`;
}
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** How many agents follow it now (before the project is known). */
export function followers(r: Pick<Rule, 'who' | 'targets'>, agents: readonly RuleAgent[]): number {
  return r.who === 'all' ? agents.length : r.who === 'agents' ? agents.filter(a => r.targets.includes(a.id)).length : agents.filter(a => a.department && r.targets.includes(a.department.toLowerCase())).length;
}
/** Does the rule reach this agent in this project (the backend's rule, for the page's filter)? */
export function reaches(r: Pick<Rule, 'who' | 'targets' | 'projectId'>, agent: RuleAgent | null, projectId: string | null): boolean {
  if (projectId !== null && r.projectId && r.projectId !== projectId) return false;
  if (!agent) return true;
  if (r.who === 'agents') return r.targets.includes(agent.id);
  if (r.who === 'departments') return !!agent.department && r.targets.includes(agent.department.toLowerCase());
  return true;
}

export class RulesController {
  #client: SessionClient;
  #state: RulesState = Object.freeze({ phase: 'idle', files: {}, rules: [], suggestions: [], departments: [], projects: [], selected: null, notice: null, toast: null, lastDeleted: null, busy: false, precedence: false });
  #listeners = new Set<() => void>();
  #toastId = 0;
  constructor(client: SessionClient) { this.#client = client; }
  subscribe = (l: () => void) => { this.#listeners.add(l); return () => this.#listeners.delete(l); };
  getSnapshot = () => this.#state;
  #publish(p: Partial<RulesState>) { this.#state = Object.freeze({ ...this.#state, ...p }); for (const l of this.#listeners) l(); }
  async #req(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) {
    const r = await this.#client.request({ method, path, ...(body !== undefined ? { body } : {}) } as never);
    return { status: r.status, body: r.body as unknown };
  }
  say(text: string, undo = false) { this.#publish({ toast: { id: ++this.#toastId, text, undo } }); }
  dismiss(id: number) { if (this.#state.toast?.id === id) this.#publish({ toast: null }); }
  select(id: string | null) { this.#publish({ selected: id, notice: null }); }
  find(id: string | null): Rule | undefined { return id ? [...this.#state.suggestions, ...this.#state.rules].find(r => r.id === id) : undefined; }

  async load(): Promise<void> {
    this.#publish({ phase: this.#state.phase === 'ready' ? 'ready' : 'loading' });
    try {
      const [r, p] = await Promise.all([this.#req('GET', '/api/agent-rules'), this.#req('GET', '/api/chat/projects').catch(() => ({ status: 0, body: null }))]);
      if (r.status !== 200 || !record(r.body)) { this.#publish({ phase: 'error', notice: err(r.body, 'Rules could not be read.') }); return; }
      const projects = record(p.body) && Array.isArray(p.body.projects) ? (p.body.projects as Record<string, unknown>[]).map(x => ({ id: String(x.id), name: String(x.name ?? 'Project'), folder: typeof x.folder === 'string' ? x.folder : null })) : [];
      const b = r.body;
      this.#publish({ phase: 'ready', rules: (b.rules as Rule[]) ?? [], suggestions: (b.suggestions as Rule[]) ?? [], departments: (b.departments as string[]) ?? [], projects, precedence: b.precedence === true });
      // RULES-03: each project with a folder: are its coding app files written and up to date?
      void Promise.all(projects.filter(p => p.folder).map(async p => [p.id, await this.filesState(p.id)] as const)).then(list => this.#publish({ files: Object.fromEntries(list.filter((x): x is readonly [string, FilesState] => !!x[1])) }));
    } catch { this.#publish({ phase: 'error', notice: 'Rules could not be read.' }); }
  }
  async #write(method: 'POST' | 'PUT', path: string, body?: unknown): Promise<Rule | null> {
    this.#publish({ busy: true, notice: null });
    try {
      const r = await this.#req(method, path, body);
      if ((r.status === 200 || r.status === 201) && record(r.body)) { await this.load(); return (r.body.rule as Rule) ?? null; }
      this.#publish({ notice: err(r.body, 'Not saved. Try again.') });
      return null;
    } catch { this.#publish({ notice: 'Not saved. Try again.' }); return null; } finally { this.#publish({ busy: false }); }
  }
  async create(input: RuleChange & { text: string }): Promise<Rule | null> {
    const rule = await this.#write('POST', '/api/agent-rules', input);
    if (rule) this.#publish({ selected: rule.id });
    return rule;
  }
  change(id: string, change: RuleChange) { return this.#write('PUT', `/api/agent-rules/${id}`, change); }
  async duplicate(id: string) {
    const r = this.find(id); if (!r) return null;
    return this.create({ text: r.text, when: r.when, projectId: r.projectId, who: r.who, targets: [...r.targets], paused: true });
  }
  async remove(id: string) {
    this.#publish({ busy: true });
    try {
      const r = await this.#req('POST', `/api/agent-rules/${id}/delete`);
      if (r.status !== 200) { this.#publish({ notice: err(r.body, 'Not deleted.') }); return; }
      this.#publish({ selected: this.#state.selected === id ? null : this.#state.selected, lastDeleted: id });
      await this.load();
      this.say('Rule deleted.', true);
    } finally { this.#publish({ busy: false }); }
  }
  async undo() {
    const id = this.#state.lastDeleted; if (!id) return;
    const rule = await this.#write('POST', `/api/agent-rules/${id}/undo-delete`);
    if (rule) this.#publish({ lastDeleted: null, selected: rule.id, toast: null });
  }
  async decide(id: string, use: boolean) {
    const rule = await this.#write('POST', `/api/agent-rules/${id}/${use ? 'accept' : 'dismiss'}`);
    if (rule) { this.#publish({ selected: use ? rule.id : null }); this.say(use ? 'The suggestion is a rule now.' : 'Suggestion dismissed.'); }
  }
  async starter() {
    this.#publish({ busy: true });
    try {
      const r = await this.#req('POST', '/api/agent-rules/starter');
      const added = record(r.body) && Array.isArray(r.body.added) ? r.body.added.length : 0;
      await this.load();
      this.say(added ? `${added} usual rules added, paused. Turn on the ones that fit.` : 'Our usual rules are already here.');
    } finally { this.#publish({ busy: false }); }
  }
  async versions(id: string): Promise<RuleVersion[]> {
    const r = await this.#req('GET', `/api/agent-rules/${id}/versions`).catch(() => null);
    return r?.status === 200 && record(r.body) && Array.isArray(r.body.versions) ? r.body.versions as RuleVersion[] : [];
  }
  async restore(id: string, version: number) {
    const rule = await this.#write('POST', `/api/agent-rules/${id}/versions/${version}/restore`);
    if (rule) this.say('Earlier version put back.');
  }
  /** Rules in this list that disagree (the local model compares them; b comes later, so b wins). */
  async conflicts(agentId: string, projectId: string | null): Promise<{ conflicts: { a: string; b: string; why: string }[]; checked: boolean } | null> {
    const q = new URLSearchParams({ agentId, ...(projectId ? { projectId } : {}) });
    const r = await this.#req('GET', `/api/agent-rules/conflicts?${q}`).catch(() => null);
    return r?.status === 200 && record(r.body) && Array.isArray(r.body.conflicts) ? { conflicts: r.body.conflicts as { a: string; b: string; why: string }[], checked: r.body.checked === true } : null;
  }
  /** RULES-04: a rule Girru ships, back as it came. */
  async putBack(id: string) {
    const rule = await this.#write('POST', `/api/agent-rules/${id}/put-back`);
    if (rule) this.say('Put back as it came.');
  }
  async filesState(projectId: string): Promise<FilesState | null> {
    const r = await this.#req('GET', `/api/agent-rules/files/${projectId}`).catch(() => null);
    return r?.status === 200 && record(r.body) && record(r.body.files) ? r.body.files as FilesState : null;
  }
  async writeFiles(projectId: string, mode: 'private' | 'project'): Promise<boolean> {
    this.#publish({ busy: true, notice: null });
    try {
      const r = await this.#req('POST', `/api/agent-rules/files/${projectId}`, { mode });
      if (r.status !== 200 || !record(r.body)) { this.#publish({ notice: err(r.body, 'The files were not written.') }); return false; }
      this.#publish({ files: { ...this.#state.files, [projectId]: r.body.files as FilesState } });
      this.say('Coding app files written.');
      return true;
    } catch { this.#publish({ notice: 'The files were not written.' }); return false; } finally { this.#publish({ busy: false }); }
  }
  /** TASKLOG-01: turn the project's task file on or off (its locked rule follows). */
  async setTasks(projectId: string, on: boolean): Promise<FilesState | null> {
    this.#publish({ busy: true, notice: null });
    try {
      const r = await this.#req('PUT', `/api/agent-rules/files/${projectId}/tasks`, { on });
      if (r.status !== 200 || !record(r.body) || !record(r.body.files)) { this.#publish({ notice: err(r.body, 'The task file was not changed.') }); return null; }
      const f = r.body.files as FilesState;
      this.#publish({ files: { ...this.#state.files, [projectId]: f } });
      this.say(on ? 'Task file on. Agents and apps keep their tasks in it.' : 'Task file off. The file stays in the folder.');
      void this.load();
      return f;
    } catch { this.#publish({ notice: 'The task file was not changed.' }); return null; } finally { this.#publish({ busy: false }); }
  }
  async effective(agentId: string, projectId: string | null): Promise<Rule[] | null> {
    const q = new URLSearchParams({ agentId, ...(projectId ? { projectId } : {}) });
    const r = await this.#req('GET', `/api/agent-rules/effective?${q}`).catch(() => null);
    return r?.status === 200 && record(r.body) && Array.isArray(r.body.rules) ? r.body.rules as Rule[] : null;
  }
}
