import {useEffect, useState} from 'react';
import type {SessionClient} from './session';
import type {UiIconName} from './ui-icons';

/** CP9c: Girru picks a computer's picture from its system; the owner may change the picture and the name shown here. */
export const COMPUTER_ICONS: ReadonlyArray<{key: ComputerIconKey; name: string; icon: UiIconName}> = [
  {key: 'macbook', name: 'MacBook', icon: 'pc-macbook'},
  {key: 'imac', name: 'iMac', icon: 'pc-imac'},
  {key: 'mac-mini', name: 'Mac mini', icon: 'pc-mini'},
  {key: 'mac-studio', name: 'Mac Studio', icon: 'pc-studio'},
  {key: 'windows-laptop', name: 'Windows laptop', icon: 'pc-winlaptop'},
  {key: 'windows-pc', name: 'Windows PC', icon: 'pc-tower'},
  {key: 'linux', name: 'Linux', icon: 'pc-linux'},
  {key: 'other', name: 'Other', icon: 'pc-other'},
];
export type ComputerIconKey = 'macbook' | 'imac' | 'mac-mini' | 'mac-studio' | 'windows-laptop' | 'windows-pc' | 'linux' | 'other';
export type ComputerLookPrefs = {icons: Record<string, ComputerIconKey>; names: Record<string, string>};
/** The picture Girru picks by itself from the system the computer runs. */
export function systemIcon(osFamily?: string | null): ComputerIconKey {
  return osFamily === 'macos' ? 'macbook' : osFamily === 'windows' ? 'windows-pc' : osFamily === 'linux' ? 'linux' : 'other';
}
export function computerIcon(look: ComputerLookPrefs | null, id: string, osFamily?: string | null): UiIconName {
  const key = look?.icons[id] ?? systemIcon(osFamily);
  return COMPUTER_ICONS.find(i => i.key === key)?.icon ?? 'pc-other';
}
export function computerName(look: ComputerLookPrefs | null, id: string, name: string) { return look?.names[id] || name; }

/** The owner's pictures and names for computers, kept on this computer (Settings and the Computers section share them). */
export function useComputerLook(client: SessionClient, enabled = true) {
  const [look, setLook] = useState<ComputerLookPrefs | null>(null);
  useEffect(() => { if (!enabled) return; let live = true; void client.request({method: 'GET', path: '/api/computers/look'}).then(r => { if (live && r.status === 200) setLook(r.body as ComputerLookPrefs); }).catch(() => {}); return () => { live = false; }; }, [client, enabled]);
  const save = async (id: string, change: {icon?: ComputerIconKey; name?: string}) => {
    const r = await client.request({method: 'POST', path: '/api/computers/look', body: {deviceId: id, ...change}});
    if (r.status !== 200) throw Error('computer_look_refused');
    setLook(r.body as ComputerLookPrefs);
  };
  return {look, save};
}
