// CHAT-PRO-02 D: search hits inside conversations, grouped by conversation.
// Snippets are plain text; the matches are <mark> pieces from offsets.
import type { ChatSearchState, SearchHit, SearchResult } from './chat-search';
import { snippetParts } from './chat-search';

const KIND_LABEL: Record<SearchHit['kind'], string> = { title: 'Title', user: 'You', assistant: 'Agent' };

/** CHAT-LIVE-01 (LW6): a hit reads as plain text: Markdown marks (** __ ` # >) are dropped, the matched words stay marked. */
export const plainSnippet = (text: string) => text.replace(/\*\*|__|`+/g, '').replace(/(^|\n)\s{0,3}(?:#{1,6}|>)\s+/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
export function HitSnippet({ hit }: { hit: SearchHit }) {
  return <span className="hit-snippet" dir="auto">{snippetParts(hit.snippet, hit.ranges).map((p, i) => p.hit ? <mark key={i}>{plainSnippet(p.text)}</mark> : <span key={i}>{plainSnippet(p.text)}</span>)}</span>;
}

/** A conversation's name for a result (title, else its first hit). */
export const resultTitle = (r: SearchResult) => r.title || 'Untitled chat';

/** The sidebar's search results: one block per conversation, its hits under it. */
export function SearchResults({ state, projectName, onOpen }: { state: ChatSearchState; projectName?: (id: string | null) => string | null; onOpen: (conversationId: string, messageId: string | null) => void }) {
  if (state.phase === 'searching' && !state.results.length) return <p className="session-empty" role="status">Searching…</p>;
  if (state.phase === 'error') return <p className="session-empty" role="status">Search is not available right now.</p>;
  if (state.phase === 'ready' && !state.results.length) return <p className="session-empty" role="status">No chat contains “{state.query}”.</p>;
  return <div className="search-results" aria-label="Search results" aria-busy={state.phase === 'searching' || undefined}>
    {state.results.map(r => {
      const project = projectName?.(r.projectId);
      const more = r.matchCount - r.hits.filter(h => h.kind !== 'title').length;
      const titleHit = r.hits.find(h => h.kind === 'title');
      return <section key={r.conversationId} className="search-result" aria-label={resultTitle(r)}>
        <button type="button" className="search-result-title" onClick={() => onOpen(r.conversationId, null)} dir="auto">
          <span className="search-result-name">{titleHit ? <HitSnippet hit={titleHit}/> : resultTitle(r)}</span>{project && <small className="search-result-project" title={project}>{project}</small>}
        </button>
        {r.hits.filter(h => h.kind !== 'title').map(h => <button key={h.messageId!} type="button" className="search-hit" onClick={() => onOpen(r.conversationId, h.messageId)}>
          <small className="search-hit-kind">{KIND_LABEL[h.kind]}</small><HitSnippet hit={h}/>
        </button>)}
        {more > 0 && <p className="search-more">+{more} more in this chat</p>}
      </section>;
    })}
    {state.truncated && <p className="search-more">Showing the newest matches. Type more to narrow the search.</p>}
  </div>;
}
