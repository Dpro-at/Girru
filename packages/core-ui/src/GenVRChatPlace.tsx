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
  return <div className="genvr-chat-place">
    <div className="genvr-chat-place-row"><UiIcon name="globe" size={14}/><span><b>{world.title}</b><small>GenVR place</small></span><button type="button" className="link-button" title="Open this place in the Studio" onClick={open}>Open in Studio</button></div>
    {world.answerer && <p className="fine-print">Answers here · {world.answerer.name}</p>}
    <p className="fine-print">{team.length ? `Agents in this place · ${team.join(', ')}` : 'No agents in this place yet'}</p>
  </div>;
}
