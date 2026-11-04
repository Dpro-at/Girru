// STORE-MAP-01 P9b (boards P9b-1 to P9b-3): how sure a memory is (the inspector
// row and the list chips), Mark as verified with Undo, and the two new views of
// Memory › Needs you: Corrected after use and Open questions. The routes answer
// 404 while the backend's P9b switch is off; the window then shows nothing new.
import { Store } from './memory-store';
import type { Requester } from './memory-store';
import { CORRECTED_PATH, MAX_TRUST_IDS, QUESTIONS_PATH, TRUST_WAITING_PATH, correctedPath, questionPath, trustPath, verifyPath } from './memory-trust-contract.js';
import type { CorrectedItem, OpenQuestion, TrustView } from './memory-trust-contract.js';

export type NeedsView = 'decide' | 'corrected' | 'questions';
export type TrustState = Readonly<{
  view: NeedsView;
  /** "How sure" per memory id (loaded for the shown rows and the open memory). */
  trust: Readonly<Record<string, TrustView>>;
  corrected: readonly CorrectedItem[] | null;
  questions: readonly OpenQuestion[] | null;
  /** What waits (the Needs you badge): unchecked corrections and open questions. */
  waiting: { corrected: number; questions: number };
  selected: string | null;
  busy: boolean; notice?: string;
}>;

/** What the undo list needs from the window's controller. */
export interface UndoSink { remember(label: string, run: () => Promise<boolean>): void; say(text: string): void }

export class MemoryTrustController extends Store<TrustState> {
  #asked = new Set<string>();
  #inFlight = new Map<string, Promise<void>>();
  /** One read at a time per list (the view switch and the list both ask). */
  #once(key: string, run: () => Promise<void>) { let p = this.#inFlight.get(key); if (!p) { p = run().finally(() => this.#inFlight.delete(key)); this.#inFlight.set(key, p); } return p; }
  constructor(client: Requester, private readonly sink: UndoSink) {
    super({ view: 'decide', trust: {}, corrected: null, questions: null, waiting: { corrected: 0, questions: 0 }, selected: null, busy: false }, client);
  }

  setView(view: NeedsView) {
    this.publish({ view, selected: null, notice: undefined });
    if (view === 'corrected') void this.loadCorrected();
    if (view === 'questions') void this.loadQuestions();
  }
  select(selected: string | null) { this.publish({ selected }); }

  /** Reads "how sure" for these memories (each id once, until it changes). */
  async loadTrust(ids: readonly string[], fresh = false) {
    const want = [...new Set(ids)].filter(id => fresh || !this.#asked.has(id)).slice(0, MAX_TRUST_IDS);
    if (!want.length) return;
    for (const id of want) this.#asked.add(id);
    try {
      const r = await this.req('GET', trustPath(want));
      if (r.status !== 200) return;
      const items = (r.body as { items: TrustView[] }).items;
      this.publish({ trust: { ...this.getSnapshot().trust, ...Object.fromEntries(items.map(i => [i.id, i])) } });
    } catch { for (const id of want) this.#asked.delete(id); }
  }
  /** The memory's text changed (an edit): read it again next time. */
  forgetTrust(id: string) { this.#asked.delete(id); }

  async loadWaiting() {
    try { const r = await this.req('GET', TRUST_WAITING_PATH); if (r.status === 200) this.publish({ waiting: r.body as TrustState['waiting'] }); } catch { /* the badge stays */ }
  }
  loadCorrected() { return this.#once('corrected', () => this.#loadCorrected()); }
  async #loadCorrected() {
    try {
      const r = await this.req('GET', CORRECTED_PATH);
      if (r.status !== 200) { this.publish({ corrected: [], notice: r.status === 404 ? undefined : 'The corrected memories could not be read.' }); return; }
      const corrected = (r.body as { items: CorrectedItem[] }).items;
      this.publish({ corrected, selected: this.getSnapshot().selected ?? corrected.find(c => !c.checked)?.memoryId ?? corrected[0]?.memoryId ?? null, waiting: { ...this.getSnapshot().waiting, corrected: corrected.filter(c => !c.checked).length } });
    } catch { this.publish({ corrected: [], notice: 'The corrected memories could not be read (no connection).' }); }
  }
  loadQuestions() { return this.#once('questions', () => this.#loadQuestions()); }
  async #loadQuestions() {
    try {
      const r = await this.req('GET', QUESTIONS_PATH);
      if (r.status !== 200) { this.publish({ questions: [], notice: r.status === 404 ? undefined : 'The questions could not be read.' }); return; }
      const questions = (r.body as { items: OpenQuestion[] }).items;
      this.publish({ questions, selected: this.getSnapshot().selected ?? questions.find(q => q.status === 'open')?.id ?? questions[0]?.id ?? null, waiting: { ...this.getSnapshot().waiting, questions: questions.filter(q => q.status === 'open').length } });
    } catch { this.publish({ questions: [], notice: 'The questions could not be read (no connection).' }); }
  }

  /** Mark as verified (⌘⇧V): High at once; Undo takes exactly that back. */
  async verify(id: string, undo = false): Promise<boolean> {
    this.publish({ busy: true });
    try {
      const r = await this.req('POST', verifyPath(id, undo));
      this.publish({ busy: false });
      if (r.status !== 200) { this.sink.say(undo ? 'The mark was not taken away.' : 'It was not marked as verified.'); return false; }
      const item = (r.body as { item: TrustView }).item;
      this.publish({ trust: { ...this.getSnapshot().trust, [id]: item } });
      if (!undo) this.sink.remember('Marked as verified.', () => this.verify(id, true));
      return true;
    } catch { this.publish({ busy: false }); this.sink.say('Nothing changed (no connection).'); return false; }
  }

  /** Mark as checked (Undo with ⌘Z). */
  async check(memoryId: string, checked = true): Promise<boolean> {
    this.publish({ busy: true });
    try {
      const r = await this.req('POST', correctedPath(memoryId), { checked });
      this.publish({ busy: false });
      if (r.status !== 200) { this.sink.say('Nothing changed.'); return false; }
      const list = (this.getSnapshot().corrected ?? []).map(c => (c.memoryId === memoryId ? { ...c, checked } : c));
      const next = checked ? list.find(c => !c.checked)?.memoryId ?? memoryId : memoryId;
      this.publish({ corrected: list, selected: next, waiting: { ...this.getSnapshot().waiting, corrected: list.filter(c => !c.checked).length } });
      if (checked) this.sink.remember('Marked as checked.', () => this.check(memoryId, false));
      return true;
    } catch { this.publish({ busy: false }); this.sink.say('Nothing changed (no connection).'); return false; }
  }

  /** Save the answer: a memory you said (High, verified); the question closes. */
  async answer(questionId: string, text: string, drawer?: string): Promise<boolean> {
    this.publish({ busy: true, notice: undefined });
    try {
      const r = await this.req('POST', questionPath(questionId, 'answer'), drawer ? { text, drawer } : { text });
      this.publish({ busy: false });
      if (r.status !== 200) { this.publish({ notice: r.status === 409 ? 'This question is not waiting any more.' : 'The answer was not saved.' }); return false; }
      this.sink.say('Saved as a memory you said.');
      await this.loadQuestions();
      return true;
    } catch { this.publish({ busy: false, notice: 'The answer was not saved (no connection).' }); return false; }
  }

  /** Forget the question: no confirmation, Undo brings it back. */
  async forget(questionId: string): Promise<boolean> {
    this.publish({ busy: true });
    try {
      const r = await this.req('POST', questionPath(questionId, 'forget'));
      this.publish({ busy: false });
      if (r.status !== 200) { this.sink.say('The question was not forgotten.'); return false; }
      this.publish({ selected: null });
      await this.loadQuestions();
      this.sink.remember('Forgot the question.', async () => {
        const back = await this.req('POST', questionPath(questionId, 'restore')).catch(() => null);
        if (back?.status !== 200) return false;
        await this.loadQuestions(); this.publish({ selected: questionId });
        return true;
      });
      return true;
    } catch { this.publish({ busy: false }); this.sink.say('The question was not forgotten (no connection).'); return false; }
  }
}

/** The words the window and the inspector use for a level (board P9b-1b). */
export const LEVEL: Record<TrustView['level'], { band: 'High' | 'Medium' | 'Low'; chip: string | null; bars: 1 | 2 | 3; word: string }> = {
  verified: { band: 'High', chip: 'Verified', bars: 3, word: 'You said it, you approved it, or a chat and an agent both said it.' },
  'heard-once': { band: 'Medium', chip: null, bars: 2, word: 'One chat or one agent said it. Used in replies; does not grow from use.' },
  'not-checked': { band: 'Low', chip: 'Not checked', bars: 1, word: 'Only a coding app, a tool or a channel said it. Agents see “not checked”.' },
};
