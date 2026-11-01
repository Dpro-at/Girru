/** Protected filesystem reads have their own killable process, never the API's libuv pool. */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Stats, Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Shape = { size: number; mode: number; dev: number; ino: number; mtimeMs: number; mtime: string; file: boolean; directory: boolean; symlink: boolean; name?: string };
const hydrate = (value: Shape) => ({ ...value, mtime: new Date(value.mtime), isFile: () => value.file, isDirectory: () => value.directory, isSymbolicLink: () => value.symlink });
const failure = (code: string) => Object.assign(new Error('Local filesystem access is unavailable'), { code });
const worker = fileURLToPath(new URL('./discovery-fs-worker.cjs', import.meta.url));
export class DiscoveryFileSystem {
  private child?: ChildProcess;
  private tail: Promise<unknown> = Promise.resolve();
  private next = 0;
  private blocked = new Set<string>();
  private denied = 0;
  constructor(private options: { timeoutMs?: number; worker?: string } = {}) {}
  diagnostics() { return { denied: this.denied, pending: this.blocked.size }; }
  retry() { this.blocked.clear(); }
  private boundary(file: string, directory: boolean) {
    const home = os.homedir(), relative = path.relative(home, file).split(path.sep);
    if (['Desktop', 'Documents', 'Downloads', 'Library'].includes(relative[0])) return path.join(home, relative[0]);
    const volume = /^(\/Volumes\/[^/]+|\/mnt\/[^/]+|\/media\/[^/]+\/[^/]+)(?:\/|$)/.exec(file);
    return volume?.[1] ?? (directory ? file : path.dirname(file));
  }
  private launch() {
    if (this.child?.connected) return this.child;
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'SYSTEMROOT', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(process.execPath, [this.options.worker ?? worker], { cwd: path.dirname(this.options.worker ?? worker), env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    child.unref(); child.channel?.unref(); child.on('error', () => {});
    this.child = child; return child;
  }
  private request(op: string, file: string, extra: Record<string, unknown> = {}): Promise<any> {
    file = path.resolve(file);
    const pending = this.tail.catch(() => {}).then(() => {
      if (this.blocked.has(file) || [...this.blocked].some(root => file.startsWith(root + path.sep))) throw failure('EACCES');
      const child = this.launch(), id = ++this.next; child.channel?.ref();
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: unknown) => {
          if (settled) return; settled = true; clearTimeout(timer);
          child.off('message', message); child.off('exit', exited); child.off('error', errored); child.channel?.unref();
          error ? reject(error) : resolve(value);
        };
        const message = (answer: any) => { if (answer?.id === id) { if (answer.error && ['EACCES', 'EPERM'].includes(answer.error)) this.denied++; finish(answer.error ? failure(answer.error) : undefined, answer.value); } };
        const exited = () => { if (this.child === child) this.child = undefined; finish(failure('EIO')); };
        const errored = () => finish(failure('EIO'));
        const timer = setTimeout(() => {
          this.denied++; this.blocked.add(this.boundary(file, op === 'readdir'));
          if (this.child === child) this.child = undefined;
          child.kill('SIGKILL'); finish(failure('EACCES'));
        }, this.options.timeoutMs ?? 2500);
        child.on('message', message); child.once('exit', exited); child.once('error', errored);
        child.send({ id, op, file: path.resolve(file), ...extra }, error => { if (error) finish(failure('EIO')); });
      });
    });
    this.tail = pending; return pending;
  }
  async stat(file: string): Promise<Stats> { return hydrate(await this.request('stat', file)) as unknown as Stats; }
  async lstat(file: string): Promise<Stats> { return hydrate(await this.request('lstat', file)) as unknown as Stats; }
  async realpath(file: string): Promise<string> { return this.request('realpath', file); }
  readdir(file: string): Promise<string[]>;
  readdir(file: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  async readdir(file: string, options?: { withFileTypes: true }): Promise<string[] | Dirent[]> { const entries: Shape[] = await this.request('readdir', file); return options?.withFileTypes ? entries.map(hydrate) as unknown as Dirent[] : entries.map(entry => entry.name!); }
  async readRegularFile(file: string, limit: number, options: { truncate?: boolean; root?: string } = {}) {
    const result = await this.request('read', file, { limit, options });
    return { data: Buffer.from(result.data, 'base64'), stat: hydrate(result.stat) as unknown as Stats, truncated: result.truncated as boolean };
  }
  async copyToTemp(file: string, target: string) { await this.request('copyToTemp', file, { target }); }
  close() { this.child?.kill('SIGKILL'); this.child = undefined; }
}
export const discoveryFs = new DiscoveryFileSystem();
export const isolatedReadRegularFile = discoveryFs.readRegularFile.bind(discoveryFs);
