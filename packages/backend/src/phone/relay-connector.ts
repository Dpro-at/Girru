/**
 * The computer's outbound connection to the relay (PROTOCOL.md "Relay wire
 * protocol"). It dials out only (Node's built-in WebSocket), proves the
 * computer's device id with the signed hello, keeps the allow list (paired
 * anywhere-phones) and the open pairing ids in step, and reconnects with
 * backoff and jitter. It never reads `env`; frames go to `onFrame`.
 */

import { relayHello, type Identity } from './protocol/e2e.js';

export type RelayState = 'off' | 'connecting' | 'connected' | 'waiting';

export interface RelayConnectorOptions {
  identity: Identity;
  url: string;
  onFrame(frame: Record<string, unknown>): void;
  onState?(state: RelayState): void;
  /** First retry delay; doubles up to maxDelayMs, each with ±50 % jitter. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A connection that does not get `ready` in this time is closed and retried. */
  readyTimeoutMs?: number;
}

export class RelayConnector {
  private ws: WebSocket | null = null;
  private ready = false;
  private wanted = false;
  private attempt = 0;
  private retry: NodeJS.Timeout | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private allow: string[] = [];
  private pairings: string[] = [];
  private state: RelayState = 'off';
  readonly url: string;

  constructor(private readonly opts: RelayConnectorOptions) {
    this.url = opts.url;
  }

  get status(): RelayState { return this.state; }
  get isReady(): boolean { return this.ready; }

  private setState(s: RelayState): void {
    if (this.state === s) return;
    this.state = s;
    this.opts.onState?.(s);
  }

  /** Connect while wanted; close when not. Safe to call often. */
  want(on: boolean): void {
    if (on === this.wanted) return;
    this.wanted = on;
    if (on) this.connect();
    else this.close();
  }

  setAllow(ids: string[]): void {
    const next = [...new Set(ids)].sort();
    if (next.join() === this.allow.join()) return;
    this.allow = next;
    if (this.ready) this.raw({ t: 'allow', allow: this.allow });
  }

  setPairings(ids: string[]): void {
    const next = [...new Set(ids)].sort();
    if (next.join() === this.pairings.join()) return;
    this.pairings = next;
    if (this.ready) this.raw({ t: 'pairing', open: this.pairings });
  }

  /** Sends one envelope to a device id; false when not connected (the caller keeps or drops it). */
  send(to: string, env: string): boolean {
    if (!this.ready) return false;
    return this.raw({ t: 'send', to, env });
  }

  stop(): void {
    this.wanted = false;
    this.close();
  }

  private raw(frame: Record<string, unknown>): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(frame)); return true; } catch { return false; }
  }

  private connect(): void {
    if (!this.wanted || this.ws) return;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.setState('connecting');
    let ws: WebSocket;
    try { ws = new WebSocket(this.url); } catch { this.scheduleRetry(); return; }
    this.ws = ws;
    this.readyTimer = setTimeout(() => { try { ws.close(); } catch { /* closing */ } }, this.opts.readyTimeoutMs ?? 15_000);
    this.readyTimer.unref?.();
    ws.addEventListener('message', (e) => {
      let frame: Record<string, unknown>;
      try {
        const v: unknown = JSON.parse(typeof e.data === 'string' ? e.data : '');
        if (!v || typeof v !== 'object' || Array.isArray(v)) return;
        frame = v as Record<string, unknown>;
      } catch { return; }
      if (!this.ready) return this.onHandshake(ws, frame);
      this.opts.onFrame(frame);
    });
    ws.addEventListener('close', () => this.onClosed(ws));
    ws.addEventListener('error', () => { /* a close event follows */ });
  }

  private onHandshake(ws: WebSocket, frame: Record<string, unknown>): void {
    if (frame.t === 'challenge') {
      try {
        // relayHello refuses a challenge that names another relay than the one configured.
        ws.send(JSON.stringify(relayHello(this.opts.identity, frame, this.url, this.allow, this.pairings)));
      } catch { ws.close(); }
      return;
    }
    if (frame.t === 'ready' && frame.id === this.opts.identity.id) {
      this.ready = true;
      this.attempt = 0;
      if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
      this.setState('connected');
      // Lists may have changed while the hello was in flight.
      this.raw({ t: 'allow', allow: this.allow });
      this.raw({ t: 'pairing', open: this.pairings });
      return;
    }
    ws.close();
  }

  private onClosed(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.ready = false;
    if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
    if (this.wanted) this.scheduleRetry();
    else this.setState('off');
  }

  private scheduleRetry(): void {
    this.ws = null;
    this.setState('waiting');
    const base = this.opts.baseDelayMs ?? 1000, max = this.opts.maxDelayMs ?? 60_000;
    const delay = Math.min(max, base * 2 ** Math.min(this.attempt, 16));
    this.attempt++;
    const jittered = Math.round(delay * (0.5 + Math.random()));
    this.retry = setTimeout(() => { this.retry = null; this.connect(); }, jittered);
    this.retry.unref?.();
  }

  private close(): void {
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    if (ws) { try { ws.close(); } catch { /* already closed */ } }
    this.setState('off');
  }
}
