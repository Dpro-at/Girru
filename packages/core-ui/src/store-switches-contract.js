// Wire contract for the storage switches (STORE-MAP-01 P2), shared by the
// browser client (session.ts) and the local bridge (application-server.cjs).
// Read only: the page shows the words that match what the backend does.

export const STORE_SWITCHES_PATH = '/api/store-switches';

export function storeSwitchesRoute(path) { return path === STORE_SWITCHES_PATH; }
export function allowedStoreSwitches(method, path, body) {
  return storeSwitchesRoute(path) && method === 'GET' && body === undefined;
}
/** Only the known switches pass back; anything else is off. */
export function storeSwitchesResponse(status, body) {
  if (status !== 200) return { code: status === 403 ? 'forbidden' : 'unavailable' };
  return { p2: typeof body === 'object' && body !== null && body.p2 === true };
}
