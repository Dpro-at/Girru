/**
 * Wi-Fi (local network) path: the phone dials the computer directly.
 *
 * OFF BY DEFAULT. It starts only when the `phone.lanListen` setting holds a
 * host and port, and nothing sets it yet: the owner's rule binds every
 * service to 127.0.0.1, so listening on the local network waits for his
 * decision (src/phone/README.md).
 *
 * Wire format: the relay's own frames on one connection (`challenge` →
 * signed `hello` → `ready`, then `send` / `msg`). The phone proves its device
 * id exactly as with the relay, signing over this listener's name
 * `ws://<host>:<port>/v1`. Only a paired phone, or a phone sending to an open
 * pairing id, gets anything through; the end-to-end layer is the same.
 *
 * It binds one private (or loopback) address, never 0.0.0.0 or ::. Only
 * connections that have not proven an id yet are capped; admission is checked
 * again whenever pairings or phones change (`recheck`), and a peer that misses
 * a ping is dropped.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomBytes, verify } from 'node:crypto';
import { isIP, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { ID_PATTERN, PAIRING_PATTERN, b64url, deviceIdOf, fromB64url, p256PublicKey, relayHelloBytes } from './protocol/encoding.js';
import { CLOSE, WsConnection, completeUpgrade, refuseUpgrade } from './protocol/websocket.js';

export interface LanEnvelope { from: string; env: string; via?: string }

export interface LanListenerOptions {
  host: string;
  port: number;
  /** The computer's device id: the only `to` accepted. */
  selfId: string;
  /** May this proven device id talk at all (paired, or an open pairing exists)? */
  admit(deviceId: string): boolean;
  onEnvelope(e: LanEnvelope): void;
  /** Ping interval; a peer that misses one ping is dropped. Default 30 s. */
  pingMs?: number;
}

/** One private, link-local or loopback address: never every address (0.0.0.0, ::). */
export function lanHostAllowed(host: string): boolean {
  const v = isIP(host);
  if (v === 4) return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/.test(host) && host !== '0.0.0.0';
  if (v === 6) { const h = host.toLowerCase(); return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h); }
  return false;
}

const MAX_ENV = 1024 * 1024;
const ENV_RE = /^[A-Za-z0-9._-]+$/;
/** Connections that have not proven an id; proven ones are bounded by the paired phones. */
const MAX_UNPROVEN = 16;
const MAX_PEERS = 96;
/** Above this many unsent bytes, bulk frames are refused; above the second, everything. */
const BULK_QUEUE_BYTES = 1024 * 1024;
const MAX_QUEUE_BYTES = 6 * 1024 * 1024;

interface Peer { ws: WsConnection; nonce: string; id: string | null; timer: NodeJS.Timeout | null; alive: boolean }

export class LanListener {
  private server: Server | null = null;
  private name = '';
  private readonly peers = new Set<Peer>();
  private readonly byId = new Map<string, Peer>();
  private pinger: NodeJS.Timeout | null = null;

  constructor(private readonly opts: LanListenerOptions) {}

  get address(): string { return this.name; }

  async listen(): Promise<{ host: string; port: number }> {
    if (!lanHostAllowed(this.opts.host)) throw new Error('bad_host');
    const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    server.on('clientError', (_e, s) => s.destroy());
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (req.url !== '/v1') return refuseUpgrade(socket, 404, 'Not Found');
      if (this.unproven() >= MAX_UNPROVEN || this.peers.size >= MAX_PEERS) return refuseUpgrade(socket, 503, 'Service Unavailable');
      if (!completeUpgrade(req, socket)) return;
      this.accept(socket, head);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.host, () => { server.off('error', reject); resolve(); });
    });
    const a = server.address() as AddressInfo;
    this.name = `ws://${a.address.includes(':') ? `[${a.address}]` : a.address}:${a.port}/v1`;
    this.pinger = setInterval(() => this.tick(), this.opts.pingMs ?? 30_000);
    this.pinger.unref();
    return { host: a.address, port: a.port };
  }

  /** Sends one envelope from the computer to a connected phone; false when it is not here or backed up. */
  send(to: string, env: string, bulk = false): boolean {
    const p = this.byId.get(to);
    if (!p || !p.ws.isOpen) return false;
    if (p.ws.queuedBytes > (bulk ? BULK_QUEUE_BYTES : MAX_QUEUE_BYTES)) return false;
    p.ws.sendText(JSON.stringify({ t: 'msg', from: this.opts.selfId, env }));
    return true;
  }

  /** Closes every proven peer that may no longer talk (its pairing closed, or it was forgotten). */
  recheck(): void {
    for (const p of [...this.byId.values()]) if (!this.opts.admit(p.id as string)) p.ws.close(CLOSE.policy, 'not paired');
  }

  private unproven(): number {
    let n = 0;
    for (const p of this.peers) if (p.id === null) n++;
    return n;
  }

  private tick(): void {
    for (const p of [...this.peers]) {
      if (!p.alive) { p.ws.destroy(); continue; }
      p.alive = false;
      p.ws.ping();
    }
  }

  isConnected(id: string): boolean { return !!this.byId.get(id)?.ws.isOpen; }

  /** Closes a phone's connection (forgotten or expired). */
  drop(id: string): void { this.byId.get(id)?.ws.close(CLOSE.policy, 'not paired'); }

  async close(): Promise<void> {
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
    for (const p of [...this.peers]) p.ws.close(CLOSE.goingAway, 'stopping');
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections?.(); });
  }

  private accept(socket: Duplex, head: Buffer): void {
    const peer: Peer = { ws: null as unknown as WsConnection, nonce: b64url(randomBytes(32)), id: null, timer: null, alive: true };
    peer.ws = new WsConnection(socket, { maxMessageBytes: MAX_ENV + 1024, maxQueuedBytes: 8 * 1024 * 1024, controlFramesPerSecond: 100 }, {
      onText: (t) => { peer.alive = true; this.onText(peer, t); },
      onPong: () => { peer.alive = true; },
      onClose: () => this.forget(peer),
    }, head);
    if (!peer.ws.isOpen) return;
    this.peers.add(peer);
    peer.timer = setTimeout(() => peer.ws.close(CLOSE.policy, 'hello timeout'), 10_000);
    peer.timer.unref();
    peer.ws.sendText(JSON.stringify({ t: 'challenge', v: 1, relay: this.name, nonce: peer.nonce }));
  }

  private forget(peer: Peer): void {
    if (peer.timer) clearTimeout(peer.timer);
    this.peers.delete(peer);
    if (peer.id && this.byId.get(peer.id) === peer) this.byId.delete(peer.id);
  }

  private onText(peer: Peer, text: string): void {
    let f: Record<string, unknown>;
    try { f = JSON.parse(text); if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error('x'); } catch { peer.ws.close(CLOSE.policy, 'bad frame'); return; }
    if (peer.id === null) {
      let id: string;
      try {
        if (f.t !== 'hello' || f.v !== 1 || typeof f.key !== 'string' || typeof f.sig !== 'string') throw new Error('hello expected');
        const key = p256PublicKey(fromB64url(f.key));
        if (!verify('sha256', relayHelloBytes(this.name, peer.nonce), key, fromB64url(f.sig))) throw new Error('bad sig');
        id = deviceIdOf(key);
      } catch { peer.ws.close(CLOSE.policy, 'hello refused'); return; }
      if (!this.opts.admit(id)) { peer.ws.close(CLOSE.policy, 'not paired'); return; }
      if (peer.timer) clearTimeout(peer.timer);
      peer.timer = null;
      const previous = this.byId.get(id);
      if (previous && previous !== peer) previous.ws.close(CLOSE.replaced, 'replaced');
      peer.id = id;
      this.byId.set(id, peer);
      peer.ws.sendText(JSON.stringify({ t: 'ready', id }));
      return;
    }
    if (f.t !== 'send' || typeof f.env !== 'string' || f.env.length > MAX_ENV || !ENV_RE.test(f.env)) return;
    if (typeof f.to === 'string' && ID_PATTERN.test(f.to) && f.pairing === undefined) {
      if (f.to === this.opts.selfId) this.opts.onEnvelope({ from: peer.id, env: f.env });
    } else if (typeof f.pairing === 'string' && PAIRING_PATTERN.test(f.pairing) && f.to === undefined) {
      this.opts.onEnvelope({ from: peer.id, env: f.env, via: f.pairing });
    }
  }
}
