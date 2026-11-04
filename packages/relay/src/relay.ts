/**
 * The Girru relay (PROTOCOL.md, "Relay wire protocol").
 *
 * Devices dial out, prove they own their device id, and send opaque envelopes
 * to other device ids. The relay forwards an envelope only when the receiver
 * listed the sender in its allow list (or opened a one-time pairing id), and
 * drops it when the receiver is not connected: there is no store-and-forward.
 *
 * What it keeps: an in-memory map of live connections (device id → socket,
 * its allow list and open pairing ids). Nothing else, nothing on disk, and
 * nothing that outlives the process. It never decodes `env`, and it never
 * logs; callers get counts only from `stats()`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  ID_PATTERN, PAIRING_PATTERN, RELAY_NAME_PATTERN, b64url, deviceIdOf, fromB64url, p256PublicKey, relayHelloBytes,
} from './encoding.js';
import { CLOSE, WsConnection, completeUpgrade, refuseUpgrade } from './websocket.js';

export interface RelayOptions {
  /** Interface to bind. Default 127.0.0.1; put a TLS proxy in front for any public use. */
  host?: string;
  /** Port to bind. 0 picks a free port. Default 41540. */
  port?: number;
  /** Largest `env` string accepted, in bytes. Default 1 MiB. */
  maxEnvelopeBytes?: number;
  /** Steady message rate allowed per connection. Default 50 per second. */
  messagesPerSecond?: number;
  /** Message burst allowed per connection. Default 200. */
  burstMessages?: number;
  /** Steady byte rate allowed per connection. Default 4 MiB per second. */
  bytesPerSecond?: number;
  /** Byte burst allowed per connection. Default 8 MiB. */
  burstBytes?: number;
  /** Refused frames (rate or format) before the connection is closed. Default 50. */
  maxStrikes?: number;
  /** Live connections the whole relay accepts. Default 10000. */
  maxConnections?: number;
  /** Device ids one connection may allow. Default 64. */
  maxAllow?: number;
  /** Pairing ids one connection may hold open. Default 4. */
  maxPairings?: number;
  /** How long a pairing id stays open. Default 10 minutes. */
  pairingTtlMs?: number;
  /** Messages a pairing id passes before it closes. Default 16. */
  pairingMessages?: number;
  /** Time a new connection has to finish the hello. Default 10 s. */
  helloTimeoutMs?: number;
  /** Ping interval; a peer that misses one ping is dropped. Default 30 s. */
  heartbeatMs?: number;
  /** Bytes queued to a slow receiver before new envelopes to it are dropped as busy. Default 4 MiB. */
  maxQueuedBytes?: number;
  /** Control and continuation frames allowed per connection per second (burst is twice this). Default 100. */
  controlFramesPerSecond?: number;
  /**
   * This relay's name as devices are configured to reach it, e.g. `wss://relay.example.org/v1`.
   * Sent in every challenge and signed by the device. Default: `ws://<host>:<port>/v1` after listen.
   */
  relayUrl?: string;
}

export interface RelayStats {
  connections: number;
  devices: number;
  pairings: number;
}

export interface Relay {
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  stats(): RelayStats;
}

type DropReason = 'offline' | 'busy';

interface Peer {
  ws: WsConnection;
  nonce: string;
  id: string | null;
  allow: Set<string>;
  pairings: Set<string>;
  alive: boolean;
  strikes: number;
  msgTokens: number;
  byteTokens: number;
  refilledAt: number;
  helloTimer: NodeJS.Timeout | null;
}

interface Pairing {
  owner: Peer;
  expiresAt: number;
  left: number;
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 41540,
  maxEnvelopeBytes: 1024 * 1024,
  messagesPerSecond: 50,
  burstMessages: 200,
  bytesPerSecond: 4 * 1024 * 1024,
  burstBytes: 8 * 1024 * 1024,
  maxStrikes: 50,
  maxConnections: 10000,
  maxAllow: 64,
  maxPairings: 4,
  pairingTtlMs: 10 * 60 * 1000,
  pairingMessages: 16,
  helloTimeoutMs: 10_000,
  heartbeatMs: 30_000,
  maxQueuedBytes: 4 * 1024 * 1024,
  controlFramesPerSecond: 100,
  relayUrl: '',
} satisfies Required<RelayOptions>;

/** Room for the JSON around `env` in one frame. */
const FRAME_OVERHEAD = 1024;
const ENV_PATTERN = /^[A-Za-z0-9._-]+$/;
const REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function createRelay(options: RelayOptions = {}): Relay {
  const cfg: Required<RelayOptions> = { ...DEFAULTS, ...stripUndefined(options) };
  if (cfg.relayUrl && !RELAY_NAME_PATTERN.test(cfg.relayUrl)) throw new Error('relayUrl must look like wss://host/v1');
  let relayName = cfg.relayUrl;
  const peers = new Set<Peer>();
  const devices = new Map<string, Peer>();
  const pairings = new Map<string, Pairing>();
  let heartbeat: NodeJS.Timeout | null = null;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const ok = req.method === 'GET' && req.url === '/health';
    res.writeHead(ok ? 200 : 404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end(ok ? 'ok\n' : '');
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (req.url !== '/v1') return refuseUpgrade(socket, 404, 'Not Found');
    if (peers.size >= cfg.maxConnections) return refuseUpgrade(socket, 503, 'Service Unavailable');
    if (!completeUpgrade(req, socket)) return;
    accept(socket, head);
  });

  function accept(socket: Duplex, head: Buffer): void {
    const peer: Peer = {
      ws: null as unknown as WsConnection,
      nonce: b64url(randomBytes(32)),
      id: null,
      allow: new Set(),
      pairings: new Set(),
      alive: true,
      strikes: 0,
      msgTokens: cfg.burstMessages,
      byteTokens: cfg.burstBytes,
      refilledAt: Date.now(),
      helloTimer: null,
    };
    peer.ws = new WsConnection(socket, {
      maxMessageBytes: cfg.maxEnvelopeBytes + FRAME_OVERHEAD,
      // Above the per-receiver "busy" level: reached only by a peer that reads nothing at all.
      maxQueuedBytes: cfg.maxQueuedBytes * 2,
      controlFramesPerSecond: cfg.controlFramesPerSecond,
    }, {
      onText: (text) => onFrame(peer, text),
      onPong: () => { peer.alive = true; },
      onClose: () => forget(peer),
    }, head);
    if (!peer.ws.isOpen) return;
    peers.add(peer);
    peer.helloTimer = setTimeout(() => peer.ws.close(CLOSE.policy, 'hello timeout'), cfg.helloTimeoutMs);
    peer.helloTimer.unref();
    send(peer, { t: 'challenge', v: 1, relay: relayName, nonce: peer.nonce });
  }

  function forget(peer: Peer): void {
    if (peer.helloTimer) clearTimeout(peer.helloTimer);
    peers.delete(peer);
    if (peer.id && devices.get(peer.id) === peer) devices.delete(peer.id);
    for (const pid of peer.pairings) if (pairings.get(pid)?.owner === peer) pairings.delete(pid);
    peer.pairings.clear();
    peer.allow.clear();
  }

  function send(peer: Peer, frame: Record<string, unknown>): void {
    peer.ws.sendText(JSON.stringify(frame));
  }

  /** Refuses one frame; too many refusals close the connection. */
  function refuse(peer: Peer, code: string, ref?: string): void {
    peer.strikes++;
    if (peer.strikes >= cfg.maxStrikes) {
      peer.ws.close(CLOSE.policy, 'too many refused frames');
      return;
    }
    send(peer, ref ? { t: 'error', code, ref } : { t: 'error', code });
  }

  function withinRate(peer: Peer, bytes: number): boolean {
    const now = Date.now();
    const seconds = (now - peer.refilledAt) / 1000;
    peer.refilledAt = now;
    peer.msgTokens = Math.min(cfg.burstMessages, peer.msgTokens + seconds * cfg.messagesPerSecond);
    peer.byteTokens = Math.min(cfg.burstBytes, peer.byteTokens + seconds * cfg.bytesPerSecond);
    if (peer.msgTokens < 1 || peer.byteTokens < bytes) return false;
    peer.msgTokens -= 1;
    peer.byteTokens -= bytes;
    return true;
  }

  function onFrame(peer: Peer, text: string): void {
    peer.alive = true;
    // The rate check runs before anything is parsed, so a flood costs us almost nothing.
    if (!withinRate(peer, text.length)) return refuse(peer, 'rate_limited');
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      frame = parsed as Record<string, unknown>;
    } catch {
      return refuse(peer, 'bad_frame');
    }
    if (peer.id === null) return onHello(peer, frame);
    switch (frame.t) {
      case 'send': return onSend(peer, frame);
      case 'allow': return onAllow(peer, frame);
      case 'pairing': return onPairing(peer, frame);
      default: return refuse(peer, 'bad_frame');
    }
  }

  function onHello(peer: Peer, frame: Record<string, unknown>): void {
    if (frame.t !== 'hello' || frame.v !== 1 || typeof frame.key !== 'string' || typeof frame.sig !== 'string') {
      peer.ws.close(CLOSE.policy, 'hello expected');
      return;
    }
    let id: string;
    try {
      const key = p256PublicKey(fromB64url(frame.key));
      if (!verify('sha256', relayHelloBytes(relayName, peer.nonce), key, fromB64url(frame.sig))) throw new Error('bad_sig');
      id = deviceIdOf(key);
    } catch {
      peer.ws.close(CLOSE.policy, 'hello refused');
      return;
    }
    const allow = readIdList(frame.allow ?? [], cfg.maxAllow);
    const open = readIdList(frame.pairing ?? [], cfg.maxPairings, PAIRING_PATTERN);
    if (!allow || !open) {
      peer.ws.close(CLOSE.policy, 'hello refused');
      return;
    }
    if (peer.helloTimer) clearTimeout(peer.helloTimer);
    peer.helloTimer = null;
    // A device that reconnects takes over its id; only the key holder can sign the hello.
    const previous = devices.get(id);
    if (previous && previous !== peer) previous.ws.close(CLOSE.replaced, 'replaced');
    peer.id = id;
    peer.allow = new Set(allow);
    devices.set(id, peer);
    const refused = openPairings(peer, open);
    send(peer, refused.length ? { t: 'ready', id, refusedPairing: refused } : { t: 'ready', id });
  }

  function onSend(peer: Peer, frame: Record<string, unknown>): void {
    const ref = typeof frame.ref === 'string' && REF_PATTERN.test(frame.ref) ? frame.ref : undefined;
    if (frame.ref !== undefined && !ref) return refuse(peer, 'bad_frame');
    const { to, pairing: pid, env } = frame;
    // Exactly one target: `to` names a device, `pairing` names a pairing id. The two never mix.
    const toDevice = typeof to === 'string' && ID_PATTERN.test(to);
    const toPairing = typeof pid === 'string' && PAIRING_PATTERN.test(pid);
    if (toDevice === toPairing || (to !== undefined && !toDevice) || (pid !== undefined && !toPairing)) {
      return refuse(peer, 'bad_frame', ref);
    }
    if (typeof env !== 'string') return refuse(peer, 'bad_frame', ref);
    if (env.length === 0 || env.length > cfg.maxEnvelopeBytes) return refuse(peer, 'too_large', ref);
    if (!ENV_PATTERN.test(env)) return refuse(peer, 'bad_frame', ref);
    peer.strikes = Math.max(0, peer.strikes - 1);

    const from = peer.id as string;
    let target: Peer | undefined;
    let via: string | undefined;
    if (toDevice) {
      const device = devices.get(to as string);
      if (device && device.allow.has(from)) target = device;
    } else {
      const pairing = pairings.get(pid as string);
      if (pairing && pairing.expiresAt > Date.now() && pairing.left > 0) {
        pairing.left--;
        target = pairing.owner;
        via = pid as string;
      } else if (pairing) {
        pairings.delete(pid as string);
        pairing.owner.pairings.delete(pid as string);
      }
    }
    // Unknown, offline and not-allowed look the same to the sender, so nobody can probe who is online.
    if (!target || !target.ws.isOpen) return drop(peer, 'offline', ref);
    if (target.ws.queuedBytes > cfg.maxQueuedBytes) return drop(peer, 'busy', ref);
    send(target, via ? { t: 'msg', from, via, env } : { t: 'msg', from, env });
  }

  function drop(peer: Peer, reason: DropReason, ref?: string): void {
    send(peer, ref ? { t: 'drop', reason, ref } : { t: 'drop', reason });
  }

  function onAllow(peer: Peer, frame: Record<string, unknown>): void {
    const allow = readIdList(frame.allow, cfg.maxAllow);
    if (!allow) return refuse(peer, 'bad_frame');
    peer.allow = new Set(allow);
    send(peer, { t: 'allowed', count: allow.length });
  }

  function onPairing(peer: Peer, frame: Record<string, unknown>): void {
    const open = readIdList(frame.open, cfg.maxPairings, PAIRING_PATTERN);
    if (!open) return refuse(peer, 'bad_frame');
    for (const pid of peer.pairings) if (pairings.get(pid)?.owner === peer) pairings.delete(pid);
    peer.pairings.clear();
    const refused = openPairings(peer, open);
    send(peer, refused.length ? { t: 'paired', open: open.length - refused.length, refused } : { t: 'paired', open: open.length });
  }

  /** Opens pairing ids for this peer; returns the ones another connection already holds. */
  function openPairings(peer: Peer, ids: string[]): string[] {
    const refused: string[] = [];
    const now = Date.now();
    for (const pid of ids) {
      const held = pairings.get(pid);
      if (held && held.owner !== peer && held.expiresAt > now) {
        refused.push(pid);
        continue;
      }
      pairings.set(pid, { owner: peer, expiresAt: now + cfg.pairingTtlMs, left: cfg.pairingMessages });
      peer.pairings.add(pid);
    }
    return refused;
  }

  function tick(): void {
    const now = Date.now();
    for (const peer of peers) {
      if (!peer.alive) {
        peer.ws.destroy();
        continue;
      }
      peer.alive = false;
      peer.ws.ping();
    }
    for (const [pid, pairing] of pairings) {
      if (pairing.expiresAt <= now) {
        pairings.delete(pid);
        pairing.owner.pairings.delete(pid);
      }
    }
  }

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, cfg.host, () => {
          server.off('error', reject);
          heartbeat = setInterval(tick, cfg.heartbeatMs);
          heartbeat.unref();
          const address = server.address() as AddressInfo;
          if (!relayName) relayName = `ws://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}/v1`;
          resolve({ host: address.address, port: address.port });
        });
      });
    },
    close() {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      for (const peer of [...peers]) peer.ws.close(CLOSE.goingAway, 'relay stopping');
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
    stats() {
      return { connections: peers.size, devices: devices.size, pairings: pairings.size };
    },
  };
}

function readIdList(value: unknown, max: number, pattern: RegExp = ID_PATTERN): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  if (!value.every((item) => typeof item === 'string' && pattern.test(item))) return null;
  return [...new Set(value as string[])];
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
