import { useEffect, useState } from 'react';
import { UiIcon } from './ui-icons';
import { GENVR_AGENTS, GENVR_PATH } from './genvr-contract.js';
import type { SessionClient } from './session';

/** GV1e: Girru Chat shows the GenVR place behind a world's chat under Places, with Open in Studio. */
export const OPEN_GENVR_EVENT = 'girru:open-genvr';
type World = { projectId: string; title: string; answerer: { name: string } | null };

export function GenVRChatPlace({ client, chatProjectId }: { client: SessionClient; chatProjectId: string }) {
  const [world, setWorld] = useState<World | null>(null), [team, setTeam] = useState<string[]>([]);
  useEffect(() => {
    let gone = false; setWorld(null); setTeam([]);
    void (async () => {
      try {
        const r = await client.request({ method: 'GET', path: `/api/genvr/worlds/of-chat-project/${chatProjectId}` } as never);
        if (gone || r.status !== 200) return;
        const w = r.body as World; setWorld(w);
        const [saved, roster] = await Promise.all([client.request({ method: 'GET', path: `${GENVR_PATH}/${w.projectId}` } as never), client.request({ method: 'GET', path: GENVR_AGENTS } as never)]);
        if (gone || saved.status !== 200 || roster.status !== 200) return;
        const names = new Map((roster.body as { agents: { id: string; name: string }[] }).agents.map(a => [a.id, a.name]));
        setTeam((saved.body as { agents: { id: string }[] }).agents.map(a => names.get(a.id) ?? a.id));
      } catch { /* not a GenVR place */ }
    })();
    return () => { gone = true; };
  }, [client, chatProjectId]);
  if (!world) return null;
  const open = () => window.dispatchEvent(new CustomEvent(OPEN_GENVR_EVENT, { detail: { placeId: world.projectId } }));
  // One row in the Details style (Mohamed): the place, who answers and the agents in it, and Open in Studio.
  const sub = ['GenVR place', world.answerer ? `answers here: ${world.answerer.name}` : '', team.length ? `in it: ${team.join(', ')}` : ''].filter(Boolean).join(' · ');
  return <div className="details-row">
    <span className="details-icon"><UiIcon name="globe" size={13}/></span>
    <span className="pop-text"><b dir="auto" title={world.title}>{world.title}</b><small>{sub}</small></span>
    <button type="button" className="link-button" title="Open this place in the Studio" onClick={open}>Open in Studio</button>
  </div>;
}
