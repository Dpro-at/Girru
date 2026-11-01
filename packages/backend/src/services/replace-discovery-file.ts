/** Atomic checkpoint replacement tolerates brief Windows file-sharing locks. */
import fs from 'node:fs/promises';

export async function replaceDiscoveryFile(source: string, target: string, options: {
  platform?: NodeJS.Platform;
  rename?: typeof fs.rename;
  pause?: (ms: number) => Promise<void>;
} = {}) {
  const rename = options.rename ?? fs.rename;
  const pause = options.pause ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, target); return; }
    catch (error: any) {
      if ((options.platform ?? process.platform) !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt >= 5) throw error;
      await pause(25 * 2 ** attempt);
    }
  }
}
