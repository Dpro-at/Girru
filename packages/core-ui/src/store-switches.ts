// STORE-MAP-01 P2: which storage switches the backend has on, so a page shows
// the words that match what agents actually get. Read once per session client.
import { useEffect, useState } from 'react';
import type { SessionClient } from './session';
import { STORE_SWITCHES_PATH } from './store-switches-contract.js';

export type StoreSwitches = Readonly<{ p2: boolean; p3: boolean; p4: boolean; p6?: true; p8?: true; p9?: true }>;
const OFF: StoreSwitches = Object.freeze({ p2: false, p3: false, p4: false });
const cache = new WeakMap<SessionClient, Promise<StoreSwitches>>();

export function storeSwitches(client: SessionClient): Promise<StoreSwitches> {
  let p = cache.get(client);
  if (!p) {
    p = client.request({ method: 'GET', path: STORE_SWITCHES_PATH } as never)
      .then(r => (r.status === 200 ? { p2: (r.body as { p2?: unknown })?.p2 === true, p3: (r.body as { p3?: unknown })?.p3 === true, p4: (r.body as { p4?: unknown })?.p4 === true, ...((r.body as { p6?: unknown })?.p6 === true ? { p6: true as const } : {}), ...((r.body as { p8?: unknown })?.p8 === true ? { p8: true as const } : {}), ...((r.body as { p9?: unknown })?.p9 === true ? { p9: true as const } : {}) } : OFF))
      .catch(() => OFF);
    cache.set(client, p);
  }
  return p;
}

/** True while the backend's P2 switch is on (false until known, or when it cannot be read). */
export function useStoreP2(client: SessionClient | null | undefined): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!client) return;
    let live = true;
    void storeSwitches(client).then(s => { if (live) setOn(s.p2); });
    return () => { live = false; };
  }, [client]);
  return on;
}

/** True while the backend's P3 switch is on (one list of departments, memory details, projects by id). */
export function useStoreP3(client: SessionClient | null | undefined): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!client) return;
    let live = true;
    void storeSwitches(client).then(s => { if (live) setOn(s.p3); });
    return () => { live = false; };
  }, [client]);
  return on;
}

/** True while the backend's P4 switch is on (one personality record: its text is edited in Personality too). */
export function useStoreP4(client: SessionClient | null | undefined): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!client) return;
    let live = true;
    void storeSwitches(client).then(s => { if (live) setOn(s.p4); });
    return () => { live = false; };
  }, [client]);
  return on;
}

/** True while the backend's P6 switch is on (project files for coding apps, task numbers, place privacy). */
export function useStoreP6(client: SessionClient | null | undefined): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!client) return;
    let live = true;
    void storeSwitches(client).then(s => { if (live) setOn(s.p6 === true); });
    return () => { live = false; };
  }, [client]);
  return on;
}

/** True while the backend's P8 switch is on (task links, handoff blockers and files, a run's working notes). */
export function useStoreP8(client: SessionClient | null | undefined): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!client) return;
    let live = true;
    void storeSwitches(client).then(s => { if (live) setOn(s.p8 === true); });
    return () => { live = false; };
  }, [client]);
  return on;
}

/** True while the backend's P9 switch is on (one person's export and forget, the personal-data review). */
export function useStoreP9(client: SessionClient | null | undefined): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!client) return;
    let live = true;
    void storeSwitches(client).then(s => { if (live) setOn(s.p9 === true); });
    return () => { live = false; };
  }, [client]);
  return on;
}
