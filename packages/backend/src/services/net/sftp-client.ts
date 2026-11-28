/**
 * SFTP transport for the backup destination, built on `ssh2` (already a
 * dependency). The adapter in backup-destinations.ts drives this through a
 * small interface so a test can swap in an in-memory fake and never open a
 * socket.
 *
 * Host keys are pinned: the first connection records the server's key
 * fingerprint, and every later connection must present the same one — a
 * swapped or man-in-the-middle host is refused. ssh2 is imported lazily so
 * merely loading this module (as a test does) never pulls the native parts in.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export interface SftpConnectOpts {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** Pinned host-key fingerprint (sha256, base64). Absent on the first connect. */
  pinnedHostKey?: string;
}
export interface SftpSession {
  mkdirp(dir: string): Promise<void>;
  put(remotePath: string, localFile: string): Promise<void>;
  get(remotePath: string, localFile: string): Promise<void>;
  list(dir: string): Promise<string[]>;
  remove(remotePath: string): Promise<void>;
  close(): Promise<void>;
}
export interface SftpTransport {
  /** Open a session; returns it with the host-key fingerprint actually seen. */
  connect(opts: SftpConnectOpts): Promise<{ session: SftpSession; hostKey: string }>;
}

const fingerprint = (key: Buffer): string => createHash('sha256').update(key).digest('base64');

/** The real transport. */
export const ssh2SftpTransport: SftpTransport = {
  async connect(opts) {
    const { Client } = await import('ssh2');
    return await new Promise((resolve, reject) => {
      const conn = new Client();
      let seen = '';
      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err || !sftp) { conn.end(); reject(err ?? new Error('SFTP is not available on the server')); return; }
          const call = <T>(fn: (cb: (e: Error | null | undefined, v?: T) => void) => void): Promise<T> =>
            new Promise((res, rej) => fn((e, v) => (e ? rej(e) : res(v as T))));
          const session: SftpSession = {
            async mkdirp(dir) {
              const parts = dir.split('/').filter(Boolean);
              let cur = dir.startsWith('/') ? '' : '.';
              for (const p of parts) {
                cur = cur === '' ? '/' + p : cur + '/' + p;
                try { await call<void>((cb) => sftp.mkdir(cur, cb)); } catch { /* already there */ }
              }
            },
            put: (remotePath, localFile) => call<void>((cb) => sftp.fastPut(localFile, remotePath, cb)),
            get: (remotePath, localFile) => call<void>((cb) => sftp.fastGet(remotePath, localFile, cb)),
            async list(dir) {
              const entries = await call<Array<{ filename: string }>>((cb) => sftp.readdir(dir, cb)).catch(() => []);
              return entries.map((e) => e.filename);
            },
            remove: (remotePath) => call<void>((cb) => sftp.unlink(remotePath, cb)),
            close: () => { conn.end(); return Promise.resolve(); },
          };
          resolve({ session, hostKey: seen });
        });
      });
      conn.on('error', (e) => reject(e));
      conn.connect({
        host: opts.host,
        port: opts.port,
        username: opts.username,
        ...(opts.password ? { password: opts.password } : {}),
        ...(opts.privateKey ? { privateKey: opts.privateKey } : {}),
        ...(opts.passphrase ? { passphrase: opts.passphrase } : {}),
        readyTimeout: 20_000,
        hostVerifier: (key: Buffer) => {
          seen = fingerprint(key);
          if (!opts.pinnedHostKey) return true; // trust on first use; the fingerprint is then pinned
          const a = Buffer.from(seen);
          const b = Buffer.from(opts.pinnedHostKey);
          return a.length === b.length && timingSafeEqual(a, b);
        },
      });
    });
  },
};
