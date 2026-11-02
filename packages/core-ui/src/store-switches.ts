// STORE-MAP-01 P2: which storage switches the backend has on, so a page shows
// the words that match what agents actually get. Read once per session client.
import { useEffect, useState } from 'react';
import type { SessionClient } from './session';
import { STORE_SWITCHES_PATH } from './store-switches-contract.js';

export type StoreSwitches = Readonly<{ p2: boolean }>;
const OFF: StoreSwitches = Object.freeze({ p2: false });
const cache = new WeakMap<SessionClient, Promise<StoreSwitches>>();

export function storeSwitches(client: SessionClient): Promise<StoreSwitches> {
  let p = cache.get(client);
  if (!p) {
    p = client.request({ method: 'GET', path: STORE_SWITCHES_PATH } as never)
      .then(r => (r.status === 200 && (r.body as { p2?: unknown })?.p2 === true ? { p2: true } : OFF))
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
