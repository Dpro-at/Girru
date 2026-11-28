/**
 * A tiny streaming HTTP client, our own code over node:http/https — the shared
 * transport for the WebDAV and S3 backup destinations (backup-destinations.ts).
 * It streams the request body and the response so a large encrypted backup
 * never has to sit whole in memory, and it is the single seam a test replaces
 * with an in-memory fake so no real network is touched.
 */
import http from 'node:http';
import https from 'node:https';
import type { Readable } from 'node:stream';

export interface HttpReq {
  method: string;
  /** Full absolute URL (http(s)). */
  url: string;
  headers?: Record<string, string>;
  /** Request body as a stream (e.g. a file read stream); omit for no body. */
  body?: Readable;
  /** Byte length of the body, when known, so Content-Length can be set. */
  contentLength?: number;
  /** Abort the request if it makes no progress for this many ms (default 120s). */
  timeoutMs?: number;
}
export interface HttpRes {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Response body as a stream; always present (may be empty). */
  body: Readable;
}
export interface HttpTransport {
  send(req: HttpReq): Promise<HttpRes>;
}

/** The real transport. */
export const nodeHttpTransport: HttpTransport = {
  send(req) {
    return new Promise<HttpRes>((resolve, reject) => {
      let u: URL;
      try { u = new URL(req.url); } catch { reject(new Error('The address is not a valid URL')); return; }
      const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
      if (!mod) { reject(new Error('Only http and https places are supported')); return; }
      const headers: Record<string, string> = { ...(req.headers ?? {}) };
      if (req.contentLength != null) headers['content-length'] = String(req.contentLength);
      const r = mod.request(u, { method: req.method, headers }, (res) => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res });
      });
      r.setTimeout(req.timeoutMs ?? 120_000, () => r.destroy(new Error('The place did not respond in time')));
      r.on('error', reject);
      if (req.body) { req.body.on('error', (e) => r.destroy(e)); req.body.pipe(r); } else r.end();
    });
  },
};

/** Collect a (small) response body to a string, capped so a huge body cannot exhaust memory. */
export async function readText(body: Readable, cap = 1 << 20): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of body) {
    const b = c as Buffer;
    n += b.length;
    if (n > cap) { body.destroy(); break; }
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Read and discard a response body (so the socket is freed). */
export async function drain(body: Readable): Promise<void> {
  try { for await (const _ of body) { /* discard */ } } catch { /* already gone */ }
}
