// Outside projects in the window (REPO-TRUST-01, board R1): one small store
// per session that knows which projects are someone else's repository, the
// "outside" tag every place shows next to a project name, and the two actions
// (Trust it / Put on Outside projects) with Undo. The wire rules live in
// project-trust-contract.js.
import { useEffect, useSyncExternalStore } from 'react';
import { PROJECT_TRUST_PATH, TRUST_OWNERS_PATH, trustProjectPath } from './project-trust-contract.js';
import type { ProjectTrustView, TrustVerdict } from './project-trust-contract.js';

type Requester = { request: (r: never) => Promise<{ status: number; body: unknown }> };
type State = { view: ProjectTrustView | null; off: boolean };

export class OutsideProjects {
  #state: State = { view: null, off: false };
  #listeners = new Set<() => void>();
  #loading: Promise<void> | null = null;
  constructor(private readonly client: Requester) {}
  subscribe = (fn: () => void) => { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; };
  getSnapshot = () => this.#state;
  #publish(p: Partial<State>) { this.#state = { ...this.#state, ...p }; this.#listeners.forEach(f => f()); }
  #req(method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, body?: unknown) {
    return this.client.request((body === undefined ? { method, path } : { method, path, body }) as never);
  }
  load(force = false): Promise<void> {
    if (this.#loading && !force) return this.#loading;
    this.#loading = (async () => {
      try {
        const r = await this.#req('GET', PROJECT_TRUST_PATH);
        if (r.status === 404) this.#publish({ off: true, view: { projects: [], owners: [] } });
        else if (r.status === 200) this.#publish({ off: false, view: r.body as ProjectTrustView });
      } catch { /* keeps what it had */ }
    })();
    return this.#loading;
  }
  verdict(id: string | null | undefined): TrustVerdict | null {
    return id ? this.#state.view?.projects.find(p => p.projectId === id) ?? null : null;
  }
  isOutside(id: string | null | undefined): boolean { return !!this.verdict(id)?.outside; }
  /**
   * Trust a project (outside = false) or put it on the list (true). Returns the
   * Undo: back to the state before (an automatic verdict comes back as automatic).
   */
  async set(id: string, outside: boolean): Promise<(() => Promise<void>) | null> {
    const before = this.verdict(id);
    const r = await this.#req('PUT', trustProjectPath(id), { outside }).catch(() => null);
    if (!r || r.status !== 200) return null;
    await this.load(true);
    return async () => {
      if (!before || before.source !== 'owner') await this.#req('DELETE', trustProjectPath(id)).catch(() => null);
      else await this.#req('PUT', trustProjectPath(id), { outside: before.outside }).catch(() => null);
      await this.load(true);
    };
  }
  async addAccount(name: string, host: string): Promise<boolean> {
    const r = await this.#req('POST', TRUST_OWNERS_PATH, { name, host }).catch(() => null);
    await this.load(true);
    return r?.status === 200;
  }
  async removeAccount(name: string, host: string): Promise<boolean> {
    const r = await this.#req('DELETE', TRUST_OWNERS_PATH, { name, host }).catch(() => null);
    await this.load(true);
    return r?.status === 200;
  }
}

const stores = new WeakMap<object, OutsideProjects>();
/** The one store of a session client. */
export function outsideProjectsOf(client: Requester): OutsideProjects {
  let s = stores.get(client);
  if (!s) { s = new OutsideProjects(client); stores.set(client, s); }
  return s;
}

/** The store, loaded once and kept current for this component. */
export function useOutsideProjects(client: Requester | null | undefined): OutsideProjects | null {
  const s = client ? outsideProjectsOf(client) : null;
  useSyncExternalStore(s?.subscribe ?? noop, s?.getSnapshot ?? none, s?.getSnapshot ?? none);
  useEffect(() => { if (s && !s.getSnapshot().view) void s.load(); }, [s]);
  return s;
}
const noop = () => () => {};
const none = () => null;

/** The small tag next to a project's name (nothing for a trusted project). */
export function OutsideTag({ store, projectId }: { store: OutsideProjects | null; projectId: string | null | undefined }) {
  if (!store?.isOutside(projectId)) return null;
  return <span className="outside-tag" title="Someone else’s repository: its files are data only">outside</span>;
}

/** Where a verdict came from, in plain words. */
export function verdictWhy(v: TrustVerdict): string {
  if (v.source === 'owner') return 'You put it here';
  return v.remote ? `${v.remote.host}/${v.remote.owner} · found by Girru` : 'Found by Girru';
}
