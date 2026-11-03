/**
 * The phone link on the computer (MOB-PAIR-01 + MOB-LINK-01): pairing, the
 * relay connection, the optional Wi-Fi listener, sessions and the command
 * gate. One instance per process (`phoneLink()`).
 *
 * Paths: an 'anywhere' phone is reached through the relay (and the local
 * network when the listener is on); a 'wifi' phone never through the relay:
 * it is never on the relay allow list and the relay's frames from it are
 * dropped here as well.
 *
 * Inside a session (g1.msg) the phone sends JSON: a signed command
 * {device, to, ctr, ts, nonce, body, sig}, or the one unsigned query
 * {"type":"approval.pending","id"}. The computer answers
 * {type:"reply", ref, ok, data | error}; a started chat turn then sends
 * {type:"run", ref, runId, seq, frame} frames and one {type:"run.end"}.
 * `ref` is the body's `ref` when given, else the command's nonce.
 */

import { hostname } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { backgroundEnabled } from '../config/background.js';
import { logAudit } from '../services/audit-logger.js';
import { CommandVerifier, DEFAULT_WINDOW_MS, answerHandshake, open, seal, type Identity, type PairingLifetimeDays, type Session } from './protocol/e2e.js';
import { b64url } from './protocol/encoding.js';
import {
  checkCode, cleanName, newPairingId, newPairingSecret, openPairingRequest, qrText, sealChallenge, sealNotice, sealWelcome, type PairingRequest,
} from './protocol/pairing.js';
import * as S from './store.js';
import { RelayConnector, type RelayState } from './relay-connector.js';
import { LanListener } from './lan-listener.js';
import { CommandError, approvalPending, forgetDetails, runCommand } from './commands.js';

/** A shown QR code renews this often (PROTOCOL.md "A shown QR code renews itself every 2 minutes"). */
export const QR_RENEW_MS = 2 * 60 * 1000;
/** A pairing screen gives up this long after it opened, a received request included (never restarted). */
export const PAIRING_MAX_MS = 10 * 60 * 1000;
/** A finished pairing still answers GET this long. */
const PAIRING_KEEP_MS = 10 * 60 * 1000;
const MAX_ENVELOPE = 1024 * 1024;
const ENV_RE = /^[A-Za-z0-9._-]+$/;
/** A handshake is answered once: its hash is kept a little longer than the time window it can pass. */
const HS1_KEEP_MS = 2 * DEFAULT_WINDOW_MS + 60_000;
const HS1_MAX = 4096;

export type PairingState = 'waiting' | 'request' | 'paired' | 'cancelled' | 'expired';
type Transport = 'relay' | 'lan';

interface Code { pid: string; secret: Buffer; exp: number; qr: string }
/** `pchal` is the signed check challenge sent back to this phone (sent again if the same request repeats). */
interface Received { pid: string; secret: Buffer; req: PairingRequest; checkCode: string; pchal: string; transport: Transport; at: number }
interface Pairing {
  id: string;
  ownerId: string;
  path: S.PhonePath;
  state: PairingState;
  warning?: 'second_request';
  code: Code | null;
  request: Received | null;
  deadline: number;
  deviceId?: string;
  /** Set while Allow runs, so a second click cannot pair twice. */
  allowing?: boolean;
  renewTimer: NodeJS.Timeout | null;
  endTimer: NodeJS.Timeout | null;
}

export class PhoneLinkError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}

interface Live { session: Session; transport: Transport }

export class PhoneLink {
  private started = false;
  private identity: Identity | null = null;
  private verifier: CommandVerifier | null = null;
  private devices = new Map<string, S.PhoneDevice>();
  private readonly sessions = new Map<string, Live>();
  private readonly pairings = new Map<string, Pairing>();
  private relay: RelayConnector | null = null;
  private lan: LanListener | null = null;
  private lanError: string | null = null;
  private readonly chains = new Map<string, Promise<void>>();
  /** Forgotten here: a refresh never brings these back; only a new Allow does. */
  private readonly revoked = new Set<string>();
  /** Refreshes run one after another, so an older read never lands after a newer one. */
  private refreshing: Promise<void> = Promise.resolve();
  /** Answered handshakes (hash → time): a replayed hs1 never swaps a session. */
  private readonly seenHs1 = new Map<string, number>();

  /** Starts the link (server.ts, background on). Connects only when something needs it. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.identity = await S.loadIdentity(false).catch(() => null);
    await this.refresh();
    await this.startLan();
  }

  async stop(): Promise<void> {
    this.started = false;
    for (const p of this.pairings.values()) this.clearTimers(p);
    this.pairings.clear();
    this.relay?.stop();
    this.relay = null;
    this.sessions.clear();
    const lan = this.lan;
    this.lan = null;
    if (lan) await lan.close();
  }

  get isStarted(): boolean { return this.started; }

  // ---------- state for the owner ----------

  async overview(ownerId: string, now = Date.now()) {
    const list = await S.listDevices(ownerId);
    return {
      computer: this.identity ? { id: this.identity.id, name: computerName() } : null,
      devices: list.map((d) => deviceView(d, now)),
      relayUrl: await S.relayUrl(),
      connection: this.relay?.status ?? 'off' as RelayState,
      wifi: this.lan ? 'on' : this.lanError ? 'failed' : 'off',
    };
  }

  // ---------- pairing ----------

  async startPairing(ownerId: string, path: S.PhonePath, now = Date.now()): Promise<{ id: string; qr: string; expiresAt: number }> {
    if (path === 'wifi' && !this.lan) throw new PhoneLinkError('wifi_off', 409);
    // An Allow still running finishes first; a new screen never cuts it in half.
    if ([...this.pairings.values()].some((p) => p.allowing)) throw new PhoneLinkError('allowing', 409);
    this.identity ??= await S.loadIdentity(true);
    if ([...this.pairings.values()].some((p) => p.allowing)) throw new PhoneLinkError('allowing', 409);
    // One pairing screen at a time: a new one closes the old.
    for (const p of this.pairings.values()) if (p.state === 'waiting' || p.state === 'request') this.finish(p, 'cancelled');
    const p: Pairing = { id: `ps_${b64url(randomBytes(16))}`, ownerId, path, state: 'waiting', code: null, request: null, deadline: now + PAIRING_MAX_MS, renewTimer: null, endTimer: null };
    this.pairings.set(p.id, p);
    await this.newCode(p, now);
    p.renewTimer = setInterval(() => { void this.renew(p.id).catch(() => undefined); }, QR_RENEW_MS);
    p.renewTimer.unref();
    this.armEnd(p);
    if (!this.started && backgroundEnabled()) await this.start();
    else this.syncRelay();
    const code = p.code as Code;
    return { id: p.id, qr: code.qr, expiresAt: code.exp };
  }

  /** Makes a new pairing id, secret and expiry; the old pairing id is closed on the relay at once. */
  async renew(id: string, now = Date.now()): Promise<boolean> {
    const p = this.pairings.get(id);
    if (!p || p.state !== 'waiting') return false;
    if (now >= p.deadline) { this.finish(p, 'expired'); return false; }
    await this.newCode(p, now);
    this.syncRelay();
    return true;
  }

  private async newCode(p: Pairing, now: number): Promise<void> {
    const identity = this.identity as Identity;
    const pid = newPairingId(), secret = newPairingSecret();
    const exp = Math.min(now + QR_RENEW_MS, p.deadline);
    const relay = p.path === 'anywhere' ? await S.relayUrl() : undefined;
    const qr = qrText({ computer: identity, pairingId: pid, secret, expiresAt: exp, relay, lan: this.lanAddresses(), name: computerName() }, now);
    p.code = { pid, secret, exp, qr };
  }

  pairingView(id: string, ownerId: string, now = Date.now()) {
    const p = this.pairings.get(id);
    if (!p || p.ownerId !== ownerId) return null;
    if ((p.state === 'waiting' || p.state === 'request') && now >= p.deadline) this.finish(p, 'expired');
    return {
      state: p.state,
      qr: p.state === 'waiting' ? p.code?.qr ?? null : null,
      expiresAt: p.state === 'waiting' ? p.code?.exp ?? null : null,
      ...(p.request && p.state === 'request' ? { request: { name: p.request.req.name, model: p.request.req.platform, checkCode: p.request.checkCode, ...(p.request.req.lifetimeDays ? { lifetimeDays: p.request.req.lifetimeDays } : {}) } } : {}),
      ...(p.warning ? { warning: p.warning } : {}),
      ...(p.deviceId ? { deviceId: p.deviceId } : {}),
    };
  }

  async allow(id: string, ownerId: string, choice: { lifetimeDays: PairingLifetimeDays; path: S.PhonePath }, now = Date.now()): Promise<{ deviceId: string }> {
    const p = this.pairings.get(id);
    if (!p || p.ownerId !== ownerId) throw new PhoneLinkError('not_found', 404);
    if (now >= p.deadline && (p.state === 'waiting' || p.state === 'request')) this.finish(p, 'expired');
    if (p.state !== 'request' || !p.request || p.allowing) throw new PhoneLinkError(p.state === 'waiting' ? 'no_request' : 'pairing_closed', 409);
    p.allowing = true;
    try { return await this.completeAllow(p, ownerId, choice, now); } finally { p.allowing = false; }
  }

  private async completeAllow(p: Pairing, ownerId: string, choice: { lifetimeDays: PairingLifetimeDays; path: S.PhonePath }, now: number): Promise<{ deviceId: string }> {
    const r = p.request as Received, identity = this.identity as Identity, id = r.req.phoneId;
    // Cancelled, expired, replaced or stopped while an await ran: nothing of this Allow stays.
    const alive = () => p.state === 'request' && p.request === r && this.pairings.get(p.id) === p;
    const notifyKey = await S.addDevice({ id, ownerId, name: r.req.name, model: r.req.platform, publicKey: r.req.key, path: choice.path, lifetimeDays: choice.lifetimeDays, push: r.req.push, now });
    if (!alive()) return this.abortAllow(id);
    // A phone paired again starts over: its old counter record and session go before the reload.
    this.revoked.delete(id);
    this.sessions.delete(id);
    this.verifier?.revoke(id);
    forgetDetails(id);
    // The allow list takes the phone first (the pairing id still holds the connection open), then the
    // welcome goes back the way the request came: one pairing message, whatever the final path.
    await this.refresh();
    if (!alive()) return this.abortAllow(id);
    const welcome = sealWelcome(identity, r.pid, r.secret, r.req.key, { computer: identity.id, phone: id, notifyKey: b64url(notifyKey), lifetimeDays: choice.lifetimeDays, name: computerName() });
    p.deviceId = id;
    this.deliver(id, welcome, r.transport, true);
    this.finish(p, 'paired');
    audit(ownerId, 'phone.pair', id, { name: r.req.name, model: r.req.platform, path: choice.path, lifetimeDays: choice.lifetimeDays });
    await this.noticeOthers(id, { kind: 'security', title: 'New phone paired', body: `${r.req.name} was paired with ${computerName()}. If this was not you, remove it on the computer.` }, now);
    return { deviceId: id };
  }

  /** Undoes a half-done Allow: the stored phone is forgotten again and nothing was sent. */
  private async abortAllow(id: string): Promise<never> {
    this.revoked.add(id);
    this.dropDevice(id);
    await S.forgetDevice(id, Date.now()).catch(() => undefined);
    await this.refresh().catch(() => undefined);
    throw new PhoneLinkError('pairing_closed', 409);
  }

  deny(id: string, ownerId: string): void {
    const p = this.pairings.get(id);
    if (!p || p.ownerId !== ownerId) throw new PhoneLinkError('not_found', 404);
    if ((p.state !== 'request' && p.state !== 'waiting') || p.allowing) throw new PhoneLinkError('pairing_closed', 409);
    if (p.request) audit(ownerId, 'phone.pair.deny', p.request.req.phoneId, { name: p.request.req.name });
    this.finish(p, 'cancelled');
  }

  closePairing(id: string, ownerId: string): void {
    const p = this.pairings.get(id);
    if (!p || p.ownerId !== ownerId) throw new PhoneLinkError('not_found', 404);
    if (p.allowing) throw new PhoneLinkError('allowing', 409);
    if (p.state === 'waiting' || p.state === 'request') this.finish(p, 'cancelled');
  }

  private finish(p: Pairing, state: PairingState): void {
    p.state = state;
    this.clearTimers(p);
    p.code = state === 'waiting' ? p.code : null;
    // Pairing secrets are dropped; a finished pairing keeps only what GET shows.
    if (p.request) p.request = state === 'request' ? p.request : { ...p.request, secret: Buffer.alloc(0), pchal: '' };
    p.endTimer = setTimeout(() => { if (this.pairings.get(p.id) === p) this.pairings.delete(p.id); }, PAIRING_KEEP_MS);
    p.endTimer.unref();
    this.syncRelay();
    // A phone let onto the Wi-Fi listener only for this pairing goes with it.
    this.lan?.recheck();
  }

  private clearTimers(p: Pairing): void {
    if (p.renewTimer) clearInterval(p.renewTimer);
    if (p.endTimer) clearTimeout(p.endTimer);
    p.renewTimer = null; p.endTimer = null;
  }

  private armEnd(p: Pairing): void {
    if (p.endTimer) clearTimeout(p.endTimer);
    p.endTimer = setTimeout(() => { if (p.state === 'waiting' || p.state === 'request') this.finish(p, 'expired'); }, Math.max(0, p.deadline - Date.now()));
    p.endTimer.unref();
  }

  private openPairingIds(): string[] {
    const ids: string[] = [];
    for (const p of this.pairings.values()) {
      if (p.state === 'waiting' && p.code && p.path === 'anywhere') ids.push(p.code.pid);
      // Kept open after a request so a second, different request is seen (and cancels).
      if (p.state === 'request' && p.request && p.request.transport === 'relay') ids.push(p.request.pid);
    }
    return ids;
  }

  private onPairingRequest(pid: string, from: string, env: string, transport: Transport, now = Date.now()): void {
    for (const p of this.pairings.values()) {
      if (p.state === 'waiting' && p.code?.pid === pid) {
        if (now > p.code.exp || now >= p.deadline) return;
        let req: PairingRequest;
        try { req = openPairingRequest(env, pid, p.code.secret, from); } catch { return; }
        const identity = this.identity as Identity;
        // The check code needs a challenge made only now, after the phone's key is fixed (PROTOCOL.md "Check challenge").
        const { env: pchal, challenge } = sealChallenge(identity, pid, p.code.secret, req.phoneId);
        p.request = { pid, secret: p.code.secret, req, checkCode: checkCode(p.code.secret, identity.publicKey, req.key, challenge), pchal, transport, at: now };
        p.state = 'request';
        p.code = null;
        if (p.renewTimer) clearInterval(p.renewTimer);
        p.renewTimer = null;
        // The deadline stays where the screen set it: a request never buys more time.
        this.syncRelay();
        this.deliver(req.phoneId, pchal, transport, true);
        return;
      }
      if (p.state === 'request' && p.request?.pid === pid) {
        let req: PairingRequest;
        try { req = openPairingRequest(env, pid, p.request.secret, from); } catch { return; }
        // The same phone sending again gets the same challenge again; any other request means someone else saw the code.
        if (req.phoneId === p.request.req.phoneId) { this.deliver(req.phoneId, p.request.pchal, transport, true); return; }
        p.warning = 'second_request';
        audit(p.ownerId, 'phone.pair.second_request', p.request.req.phoneId, {});
        this.finish(p, 'cancelled');
        return;
      }
    }
  }

  // ---------- devices ----------

  async patchDevice(ownerId: string, id: string, patch: { name?: string; path?: S.PhonePath; lifetimeDays?: PairingLifetimeDays }): Promise<boolean> {
    const d = await S.getDevice(id);
    if (!d || d.ownerId !== ownerId) return false;
    await S.patchDevice(id, patch);
    if (patch.path === 'wifi' && this.sessions.get(id)?.transport === 'relay') this.sessions.delete(id);
    audit(ownerId, 'phone.update', id, { ...patch });
    await this.refresh();
    return true;
  }

  async forget(ownerId: string, id: string, now = Date.now()): Promise<boolean> {
    const d = await S.getDevice(id);
    if (!d || d.ownerId !== ownerId) return false;
    this.revoked.add(id);
    this.dropDevice(id);
    await S.forgetDevice(id, now);
    audit(ownerId, 'phone.forget', id, { name: d.name });
    await this.refresh();
    return true;
  }

  async forgetAll(ownerId: string, now = Date.now()): Promise<number> {
    for (const d of await S.listDevices(ownerId)) { this.revoked.add(d.id); this.dropDevice(d.id); }
    const ids = await S.forgetAll(ownerId, now);
    for (const id of ids) { this.revoked.add(id); this.dropDevice(id); }
    audit(ownerId, 'phone.forget_all', ownerId, { count: ids.length });
    await this.refresh();
    return ids.length;
  }

  private dropDevice(id: string): void {
    this.devices.delete(id);
    this.sessions.delete(id);
    this.verifier?.revoke(id);
    this.lan?.drop(id);
    forgetDetails(id);
  }

  async setRelayUrl(url: string): Promise<void> {
    await S.setSetting('phone.relayUrl', url);
    if (this.relay && this.relay.url !== url) { this.relay.stop(); this.relay = null; for (const [id, l] of this.sessions) if (l.transport === 'relay') this.sessions.delete(id); }
    this.syncRelay();
  }

  /** Reloads paired phones into the command gate and the relay allow list. Calls queue up; each reads afresh. */
  refresh(): Promise<void> {
    const run = this.refreshing.then(() => this.load());
    this.refreshing = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<void> {
    const list = await S.listDevices();
    const owner = await S.activeOwner();
    const now = Date.now();
    const before = [...this.devices.keys()];
    // Applied in one step after the reads: a phone forgotten meanwhile is in `revoked` and stays out.
    this.devices = new Map(list.filter((d) => d.ownerId === owner && !S.isExpired(d, now) && !this.revoked.has(d.id)).map((d) => [d.id, d]));
    // Forgotten, expired or another owner's: out of the command gate, sessions closed.
    for (const id of before) if (!this.devices.has(id)) this.dropDevice(id);
    if (this.identity) {
      this.verifier ??= new CommandVerifier(this.identity.id);
      for (const d of this.devices.values()) {
        if (this.verifier.lastCounter(d.id) === undefined) this.verifier.addDevice(d.publicKey, { lastCounter: d.lastCounter, lastUsed: d.lastUsedAt, lifetimeDays: d.lifetimeDays });
        else this.verifier.setLifetime(d.id, d.lifetimeDays);
      }
    }
    for (const id of [...this.sessions.keys()]) if (!this.devices.has(id)) this.dropDevice(id);
    this.syncRelay();
    this.lan?.recheck();
  }

  private syncRelay(): void {
    if (!this.started || !this.identity) { this.relay?.want(false); return; }
    const allow = [...this.devices.values()].filter((d) => d.path === 'anywhere').map((d) => d.id);
    const pairings = this.openPairingIds();
    const needed = allow.length > 0 || pairings.length > 0;
    if (!this.relay && needed) {
      const identity = this.identity;
      void S.relayUrl().then((url) => {
        if (this.relay || !this.started) { this.syncRelay(); return; }
        this.relay = new RelayConnector({ identity, url, onFrame: (f) => this.onRelayFrame(f) });
        this.syncRelay();
      }).catch(() => { /* the setting could not be read: the next change tries again */ });
      return;
    }
    if (!this.relay) return;
    this.relay.setAllow(allow.slice(0, 64));
    this.relay.setPairings(pairings.slice(0, 4));
    this.relay.want(needed);
  }

  // ---------- Wi-Fi path (off by default) ----------

  private async startLan(): Promise<void> {
    const cfg = await S.lanListen();
    if (!cfg || this.lan) return;
    this.identity ??= await S.loadIdentity(true);
    const self = (this.identity as Identity).id;
    const lan = new LanListener({
      host: cfg.host, port: cfg.port, selfId: self,
      admit: (id) => this.devices.has(id) || [...this.pairings.values()].some((p) => p.state === 'waiting' || p.state === 'request'),
      onEnvelope: (e) => this.onEnvelope(e.from, e.env, e.via, 'lan'),
    });
    try { await lan.listen(); this.lan = lan; this.lanError = null; } catch (err) { this.lanError = err instanceof Error && err.message === 'bad_host' ? 'bad_host' : 'listen_failed'; }
  }

  /** Turns the Wi-Fi listener on from the stored setting (used after it changes). */
  async restartLan(): Promise<void> {
    const lan = this.lan;
    this.lan = null;
    if (lan) await lan.close();
    this.identity ??= await S.loadIdentity(true);
    if (this.started) await this.startLan();
  }

  /** The local addresses for the QR code, only while the listener is on. */
  private lanAddresses(): string[] {
    if (!this.lan) return [];
    const m = /^ws:\/\/(.+):(\d+)\/v1$/.exec(this.lan.address);
    if (!m) return [];
    // The listener binds one address (never 0.0.0.0 or ::), so that is the one address to show.
    return [`${m[1]}:${m[2]}`];
  }

  // ---------- inbound ----------

  private onRelayFrame(f: Record<string, unknown>): void {
    if (f.t !== 'msg' || typeof f.from !== 'string' || typeof f.env !== 'string') return;
    // The relay is not trusted with sizes either: what no device may send is dropped unread.
    if (f.env.length > MAX_ENVELOPE || !ENV_RE.test(f.env)) return;
    this.onEnvelope(f.from, f.env, typeof f.via === 'string' ? f.via : undefined, 'relay');
  }

  private onEnvelope(from: string, env: string, via: string | undefined, transport: Transport): void {
    if (!this.identity) return;
    if (via !== undefined) return this.onPairingRequest(via, from, env, transport);
    const device = this.devices.get(from);
    if (!device) return;
    // A Wi-Fi-only phone is never served through the relay.
    if (transport === 'relay' && device.path !== 'anywhere') return;
    const now = Date.now();
    if (S.isExpired(device, now)) { this.dropDevice(from); return; }
    if (env.startsWith('g1.hs1.')) {
      // A replayed hs1 (the relay or the network keeps a copy) would swap the session or its transport.
      const seen = createHash('sha256').update(env).digest('base64url');
      if (this.seenHs1.has(seen)) return;
      let answered: ReturnType<typeof answerHandshake>;
      try { answered = answerHandshake(this.identity, device.publicKey, env, now); } catch { return; }
      this.rememberHs1(seen, now);
      this.sessions.set(from, { session: answered.session, transport });
      this.deliver(from, answered.env, transport);
      if (this.verifier?.touch(from, now)) { device.lastUsedAt = Math.max(device.lastUsedAt, now); void S.markUsed(from, now).catch(() => undefined); }
      return;
    }
    if (!env.startsWith('g1.msg.')) return;
    const live = this.sessions.get(from);
    if (!live || live.transport !== transport) return;
    let plain: Buffer;
    try { plain = open(live.session, env); } catch { return; }
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(plain.toString('utf8')); if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('x'); } catch { this.reply(from, { type: 'reply', ref: null, ok: false, error: 'bad_format' }); return; }
    // Checks run now, in arrival order; the work runs one after another.
    if (msg.type === 'approval.pending' && typeof msg.id === 'string' && msg.sig === undefined) {
      const id = msg.id;
      this.enqueue(from, async () => { if (this.known(from)) this.reply(from, { type: 'approval.pending', id, pending: await approvalPending(from, id) }); });
      return;
    }
    this.onCommand(from, device, msg, now);
  }

  private onCommand(from: string, device: S.PhoneDevice, cmd: Record<string, unknown>, now: number): void {
    const nonce = typeof cmd.nonce === 'string' ? cmd.nonce : null;
    if (cmd.device !== from) { this.reply(from, { type: 'reply', ref: nonce, ok: false, error: 'wrong_device' }); return; }
    const check = this.verifier?.verify(cmd, now) ?? { ok: false as const, reason: 'unknown_device' as const };
    if (!check.ok) {
      if (check.reason === 'expired') this.dropDevice(from);
      this.reply(from, { type: 'reply', ref: nonce, ok: false, error: check.reason });
      return;
    }
    const record = this.verifier?.record(from);
    let body: Record<string, unknown>;
    try { body = JSON.parse(check.body); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('x'); } catch { body = {}; }
    const ref = typeof body.ref === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.ref) ? body.ref : nonce;
    this.enqueue(from, async () => {
      // Forgotten or expired while this waited in line: it never runs.
      const current = this.known(from) ? this.devices.get(from) as S.PhoneDevice : null;
      if (!current || !current.publicKey.equals(device.publicKey)) return;
      // The counter is stored before anything runs, so a restart never accepts it again.
      if (record) { current.lastCounter = record.lastCounter; current.lastUsedAt = record.lastUsed; await S.markUsed(from, record.lastUsed, record.lastCounter); }
      if (typeof body.type !== 'string') { this.reply(from, { type: 'reply', ref, ok: false, error: 'bad_format' }); return; }
      const owner = await S.activeOwner();
      if (owner !== current.ownerId) { this.reply(from, { type: 'reply', ref, ok: false, error: 'owner_changed' }); return; }
      const ctx = { deviceId: from, ownerId: owner, now: () => Date.now(), push: (frame: Record<string, unknown>) => this.reply(from, { ...frame, ref }) };
      try {
        const data = await runCommand(ctx, body) as Record<string, unknown>;
        const follow = typeof data?.follow === 'function' ? data.follow as () => Promise<void> : null;
        if (follow) delete data.follow;
        this.reply(from, { type: 'reply', ref, ok: true, data });
        if (follow) void follow().catch(() => undefined);
      } catch (err) {
        // Only the commands' own codes reach the phone; anything else is internal_error, never a raw code.
        const code = err instanceof CommandError ? err.code : 'internal_error';
        this.reply(from, { type: 'reply', ref, ok: false, error: code });
      }
    });
  }

  /** Still paired, not forgotten, not expired. */
  private known(id: string): boolean {
    const d = this.devices.get(id);
    return !!d && !this.revoked.has(id) && !S.isExpired(d);
  }

  private rememberHs1(hash: string, now: number): void {
    for (const [h, at] of this.seenHs1) { if (now - at <= HS1_KEEP_MS && this.seenHs1.size < HS1_MAX) break; this.seenHs1.delete(h); }
    this.seenHs1.set(hash, now);
  }

  /** One phone's commands run one after another; phones do not wait for each other. */
  private enqueue(deviceId: string, fn: () => Promise<void>): void {
    const next = (this.chains.get(deviceId) ?? Promise.resolve()).then(fn).catch(() => undefined);
    this.chains.set(deviceId, next);
    void next.then(() => { if (this.chains.get(deviceId) === next) this.chains.delete(deviceId); });
  }

  // ---------- outbound ----------

  /** Seals one reply for the phone's current session; false when it has none. */
  private reply(deviceId: string, obj: Record<string, unknown>): boolean {
    const live = this.sessions.get(deviceId);
    if (!live) return false;
    let text = JSON.stringify(obj);
    if (Buffer.byteLength(text) > MAX_ENVELOPE - 4096) text = JSON.stringify({ type: obj.type === 'run' ? 'run' : 'reply', ref: obj.ref ?? null, ok: false, error: 'too_large', ...(obj.runId ? { runId: obj.runId } : {}) });
    // Run frames are bulk: on a backed-up link they are refused first (the run then ends with a notice).
    return this.deliver(deviceId, seal(live.session, text), live.transport, false, obj.type === 'run');
  }

  private deliver(deviceId: string, env: string, transport: Transport, pairing = false, bulk = false): boolean {
    if (transport === 'lan') return this.lan?.send(deviceId, env, bulk) ?? false;
    // Only pairing messages may reach a phone that is not an 'anywhere' phone through the relay.
    if (!pairing && this.devices.get(deviceId)?.path !== 'anywhere') return false;
    return this.relay?.send(deviceId, env, bulk) ?? false;
  }

  /** A signed notice to every other paired phone that can be reached now (push comes later). */
  private async noticeOthers(except: string, content: { kind: 'security'; title: string; body: string }, now: number): Promise<void> {
    const identity = this.identity;
    if (!identity) return;
    for (const d of this.devices.values()) {
      if (d.id === except) continue;
      try {
        const key = await S.notifyKeyOf(d.id);
        if (!key) continue;
        const ctr = await S.nextNotifyCounter(d.id);
        const env = sealNotice(identity, d.id, key, ctr, content, now);
        if (!(this.lan?.isConnected(d.id) && this.deliver(d.id, env, 'lan'))) this.deliver(d.id, env, 'relay');
      } catch { /* one phone failing never stops the others */ }
    }
  }
}

function computerName(): string {
  return cleanName(hostname().replace(/\.local$/, ''), 'Girru');
}

function deviceView(d: S.PhoneDevice, now: number) {
  const end = S.expiresAt(d);
  return {
    id: d.id, name: d.name, model: d.model, path: d.path, lifetimeDays: d.lifetimeDays,
    status: S.isExpired(d, now) ? 'expired' : 'active',
    pairedAt: new Date(d.createdAt).toISOString(), lastUsedAt: new Date(d.lastUsedAt).toISOString(),
    expiresAt: end === null ? null : new Date(end).toISOString(),
  };
}

function audit(ownerId: string, action: string, deviceId: string, metadata: Record<string, unknown>): void {
  logAudit({
    event_type: action === 'phone.forget' || action === 'phone.forget_all' ? 'data.delete' : 'data.update', event_category: 'data_modification',
    severity: action === 'phone.pair' || action === 'phone.pair.second_request' ? 'warning' : 'info',
    user_id: ownerId, resource_type: 'phone_device', resource_id: deviceId, action, success: true, metadata: { device: deviceId, ...metadata },
  });
}

let instance: PhoneLink | null = null;
/** The process's phone link. */
export function phoneLink(): PhoneLink {
  instance ??= new PhoneLink();
  return instance;
}

export async function startPhoneLink(): Promise<void> {
  await phoneLink().start();
}

export async function stopPhoneLink(): Promise<void> {
  if (instance) await instance.stop();
}
