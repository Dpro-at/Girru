/**
 * Minimal server side of WebSocket (RFC 6455) on Node built-ins only.
 *
 * Covers what the relay needs and nothing more: the upgrade handshake, masked
 * client frames, text messages (fragmented or not), ping/pong and close. No
 * extensions, no subprotocols. Every size check happens on the frame header,
 * before the payload is buffered, so an oversized frame never sits in memory.
 * Nothing here logs or stores frame contents.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CLOSE_GRACE_MS = 1000;

export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  unsupported: 1003,
  badData: 1007,
  policy: 1008,
  tooBig: 1009,
  replaced: 4001,
} as const;

export interface WsHandlers {
  onText(text: string): void;
  onPong(): void;
  onClose(code: number): void;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Refuses an HTTP upgrade with a bare status line; nothing from the request is echoed. */
export function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** Checks the upgrade request and answers 101; returns false (and refuses) when it is not a valid WebSocket upgrade. */
export function completeUpgrade(req: IncomingMessage, socket: Duplex): boolean {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  const connection = String(req.headers.connection ?? '').toLowerCase();
  if (
    req.method !== 'GET' ||
    upgrade !== 'websocket' ||
    !connection.split(',').some((part) => part.trim() === 'upgrade') ||
    req.headers['sec-websocket-version'] !== '13' ||
    typeof key !== 'string' ||
    Buffer.from(key, 'base64').length !== 16
  ) {
    refuseUpgrade(socket, 400, 'Bad Request');
    return false;
  }
  const accept = createHash('sha1').update(key + ACCEPT_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return true;
}

export class WsConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmenting = false;
  private closed = false;
  private readonly socket: Duplex;
  private readonly maxMessageBytes: number;
  private readonly handlers: WsHandlers;

  constructor(socket: Duplex, maxMessageBytes: number, handlers: WsHandlers, head?: Buffer) {
    this.socket = socket;
    this.maxMessageBytes = maxMessageBytes;
    this.handlers = handlers;
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this.finish(CLOSE.goingAway));
    if (head && head.length > 0) this.receive(head);
  }

  /** Bytes queued for this peer and not yet written; used for backpressure. */
  get queuedBytes(): number {
    return (this.socket as Duplex & { writableLength?: number }).writableLength ?? 0;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  sendText(text: string): void {
    if (!this.closed) this.writeFrame(0x1, Buffer.from(text, 'utf8'));
  }

  ping(): void {
    if (!this.closed) this.writeFrame(0x9, Buffer.alloc(0));
  }

  /** Starts the close handshake; the socket is destroyed if the peer does not finish it in time. */
  close(code: number, reason = ''): void {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, 'utf8');
    this.writeFrame(0x8, payload);
    this.finish(code);
    this.socket.end();
    setTimeout(() => this.socket.destroy(), CLOSE_GRACE_MS).unref();
  }

  destroy(): void {
    this.finish(CLOSE.goingAway);
    this.socket.destroy();
  }

  private finish(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.handlers.onClose(code);
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length]);
    } else if (payload.length < 0x10000) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (!this.closed && this.readFrame()) { /* keep reading complete frames */ }
  }

  /** Reads one frame from the buffer; returns false when more bytes are needed. */
  private readFrame(): boolean {
    const buf = this.buffer;
    if (buf.length < 2) return false;
    const fin = (buf[0] & 0x80) !== 0;
    const rsv = buf[0] & 0x70;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (rsv !== 0 || !masked) return this.fail(CLOSE.protocolError);
    if (length === 126) {
      if (buf.length < 4) return false;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return false;
      if (buf.readUInt32BE(2) !== 0) return this.fail(CLOSE.tooBig);
      length = buf.readUInt32BE(6);
      offset = 10;
    }
    const control = (opcode & 0x08) !== 0;
    if (control && (!fin || length > 125)) return this.fail(CLOSE.protocolError);
    if (!control && this.fragmentBytes + length > this.maxMessageBytes) return this.fail(CLOSE.tooBig);
    if (buf.length < offset + 4 + length) return false;

    const mask = buf.subarray(offset, offset + 4);
    const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + length));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buffer = buf.subarray(offset + 4 + length);

    switch (opcode) {
      case 0x0: // continuation
        if (!this.fragmenting) return this.fail(CLOSE.protocolError);
        return this.addFragment(payload, fin);
      case 0x1: // text
        if (this.fragmenting) return this.fail(CLOSE.protocolError);
        this.fragmenting = true;
        return this.addFragment(payload, fin);
      case 0x2: // binary: not part of the relay protocol
        return this.fail(CLOSE.unsupported);
      case 0x8: // the peer closes: answer and stop reading
        this.close(CLOSE.normal);
        return false;
      case 0x9:
        this.writeFrame(0xa, payload);
        return true;
      case 0xa:
        this.handlers.onPong();
        return true;
      default:
        return this.fail(CLOSE.protocolError);
    }
  }

  private addFragment(payload: Buffer, fin: boolean): boolean {
    this.fragments.push(payload);
    this.fragmentBytes += payload.length;
    if (!fin) return true;
    const whole = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmenting = false;
    let text: string;
    try {
      text = utf8.decode(whole);
    } catch {
      return this.fail(CLOSE.badData);
    }
    this.handlers.onText(text);
    return true;
  }

  private fail(code: number): boolean {
    this.close(code);
    return false;
  }
}
