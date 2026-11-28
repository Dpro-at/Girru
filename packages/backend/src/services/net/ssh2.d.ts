/**
 * Minimal ambient types for the `ssh2` package (already a dependency; it ships
 * no types and we add no @types package). Only the small surface the SFTP
 * backup transport uses is declared here — our own code, kept deliberately
 * narrow so an unused part of ssh2 can never be called untyped.
 */
declare module 'ssh2' {
  export interface SFTPWrapper {
    fastPut(localPath: string, remotePath: string, cb: (err: Error | null | undefined) => void): void;
    fastGet(remotePath: string, localPath: string, cb: (err: Error | null | undefined) => void): void;
    readdir(location: string, cb: (err: Error | null | undefined, list: Array<{ filename: string }>) => void): void;
    unlink(path: string, cb: (err: Error | null | undefined) => void): void;
    mkdir(path: string, cb: (err: Error | null | undefined) => void): void;
    stat(path: string, cb: (err: Error | null | undefined, stats?: unknown) => void): void;
  }
  export interface ConnectConfig {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    privateKey?: string | Buffer;
    passphrase?: string;
    readyTimeout?: number;
    /** Called with the server's host key; return false to refuse the connection. */
    hostVerifier?: (key: Buffer) => boolean;
  }
  export class Client {
    on(event: 'ready', cb: () => void): this;
    on(event: 'error', cb: (err: Error) => void): this;
    on(event: string, cb: (...args: unknown[]) => void): this;
    connect(cfg: ConnectConfig): this;
    sftp(cb: (err: Error | undefined, sftp: SFTPWrapper) => void): this;
    end(): this;
  }
}
