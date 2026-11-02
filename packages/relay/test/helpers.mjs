// Test client for the relay: Node's built-in WebSocket, a P-256 identity and a frame inbox.
import { createIdentity, relayHello } from '../src/e2e.ts';

export class TestClient {
  constructor(ws, identity) {
    this.ws = ws;
    this.identity = identity;
    this.inbox = [];
    this.waiters = [];
    this.closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
    ws.addEventListener('message', (e) => {
      const frame = JSON.parse(e.data);
      const i = this.waiters.findIndex((w) => w.match(frame));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(frame);
      else this.inbox.push(frame);
    });
  }

  get id() { return this.identity.id; }

  /** Next frame matching `match` (default: any), or a timeout error. */
  next(match = () => true, timeoutMs = 2000) {
    const i = this.inbox.findIndex(match);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve: (f) => { clearTimeout(timer); resolve(f); } };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error('timed out waiting for a frame'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  sendFrame(frame) { this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame)); }

  send(to, env, ref) { this.sendFrame(ref ? { t: 'send', to, env, ref } : { t: 'send', to, env }); }

  close() { this.ws.close(); return this.closed; }
}

/** A client whose inbox listens from the first byte; resolves once the socket is open. */
export function openClient(url, identity = createIdentity()) {
  const ws = new WebSocket(url);
  const client = new TestClient(ws, identity);
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(client), { once: true });
    ws.addEventListener('error', () => reject(new Error('socket error')), { once: true });
  });
}

/** Connects, answers the challenge and waits for `ready`. */
export async function connect(url, { identity = createIdentity(), allow = [], pairing = [] } = {}) {
  const client = await openClient(url, identity);
  const challenge = await client.next((f) => f.t === 'challenge');
  client.sendFrame(relayHello(identity, challenge.nonce, allow, pairing));
  client.ready = await client.next((f) => f.t === 'ready');
  return client;
}
