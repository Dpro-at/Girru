// STORE-MAP-01 P9 (board P9c): one person in Memory › People. Reads what the
// memory holds about them (the export), saves it as one file, and forgets them in
// one action (the typed name is the confirm; only mentions the export listed).
// The routes answer 404 while the backend's P9 switch is off.
import { Store } from './memory-store';
import type { Requester } from './memory-store';
import { personExportPath, personForgetPath } from './memory-people-contract.js';
import type { PersonExport, PersonForgotten } from './memory-people-contract.js';

export type PeopleState = Readonly<{
  /** The open person's export (null while it loads or when it could not be read). */
  person: string | null; data: PersonExport | null; phase: 'idle' | 'loading' | 'ready' | 'error';
  busy: boolean; notice?: string;
}>;

/** "sam" → "Sam"; a key with capitals or digits stays as it is. */
export const personName = (key: string) => (/^[a-z][a-z.\- ]*$/.test(key) ? key.replace(/(^|[ .-])([a-z])/g, (_, s: string, c: string) => s + c.toUpperCase()) : key);
/** The file the export is saved as (the backend names it the same). */
export const exportFileName = (data: PersonExport) => `person-${data.person}-${(data.exportedAt || new Date().toISOString()).slice(0, 10)}.json`;

export class MemoryPeopleController extends Store<PeopleState> {
  #ticket = 0;
  constructor(client: Requester) { super({ person: null, data: null, phase: 'idle', busy: false }, client); }

  /** Reads everything about one person (for the inspector counts and both sheets). */
  async load(key: string, fresh = false) {
    const s = this.getSnapshot();
    if (!fresh && s.person === key && (s.phase === 'ready' || s.phase === 'loading')) return;
    const t = ++this.#ticket;
    this.publish({ person: key, data: s.person === key ? s.data : null, phase: 'loading', notice: undefined });
    try {
      const r = await this.req('GET', personExportPath(key));
      if (t !== this.#ticket) return;
      if (r.status === 200) this.publish({ data: r.body as PersonExport, phase: 'ready' });
      else this.publish({ data: null, phase: 'error', notice: r.status === 404 ? 'Not available yet.' : 'What memory holds about this person could not be read.' });
    } catch { if (t === this.#ticket) this.publish({ data: null, phase: 'error', notice: 'What memory holds about this person could not be read (no connection).' }); }
  }
  close() { ++this.#ticket; this.publish({ person: null, data: null, phase: 'idle', notice: undefined }); }

  /** Saves the export as one file where the owner chooses; nothing is sent. */
  async saveFile(key: string): Promise<boolean> {
    await this.load(key, true);
    const data = this.getSnapshot().data;
    if (!data || data.person !== key) return false;
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      a.download = exportFileName(data); a.click(); URL.revokeObjectURL(a.href);
      return true;
    } catch { this.publish({ notice: 'The file could not be saved.' }); return false; }
  }

  /** Forgets the person and the picked mentions; answers the counts, or null with a notice. */
  async forget(key: string, mentionIds: readonly string[]): Promise<PersonForgotten | null> {
    this.publish({ busy: true, notice: undefined });
    try {
      const r = await this.req('POST', personForgetPath(key), mentionIds.length ? { confirm: key, mentionIds: [...mentionIds] } : { confirm: key });
      if (r.status !== 200) {
        const error = (r.body as { error?: unknown } | null)?.error;
        this.publish({ busy: false, notice: typeof error === 'string' && error ? `Nothing was forgotten: ${error}.` : 'Nothing was forgotten.' });
        return null;
      }
      ++this.#ticket;
      this.publish({ busy: false, person: null, data: null, phase: 'idle' });
      return r.body as PersonForgotten;
    } catch { this.publish({ busy: false, notice: 'The result is unknown (no connection). Open the person again to see.' }); return null; }
  }
}
