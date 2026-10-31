/** Read-only discovery roots. OS permission grants are checked by actual reads, never inferred. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type ComputerRoots = { roots: string[]; unavailableRoots: number };
export async function computerRoots(options: { home?: string; roots?: string[]; platform?: NodeJS.Platform } = {}): Promise<ComputerRoots> {
  const home = options.home ?? os.homedir(), platform = options.platform ?? process.platform;
  const candidates = options.roots ? [...options.roots] : [home, ...(platform === 'win32' ? [] : [path.parse(home).root])];
  let unavailableRoots = 0;
  if (!options.roots) {
    if (platform === 'win32') {
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        const drive = `${letter}:\\`;
        if ((await fs.stat(drive).catch(() => null))?.isDirectory()) candidates.push(drive);
      }
    } else {
      const bases = platform === 'darwin' ? ['/Volumes'] : [`/media/${os.userInfo().username}`, '/mnt'];
      for (const base of bases) {
        try { for (const entry of await fs.readdir(base, { withFileTypes: true })) if (entry.isDirectory() || entry.isSymbolicLink()) candidates.push(path.join(base, entry.name)); }
        catch (error: any) { if (error.code !== 'ENOENT') unavailableRoots++; }
      }
    }
  }
  const roots: string[] = [];
  for (const candidate of candidates) {
    try {
      const real = await fs.realpath(candidate);
      // Canonical aliases of the system disk collapse to the same single root.
      if (!(await fs.stat(real)).isDirectory()) continue;
      if (!roots.includes(real)) roots.push(real);
    } catch { unavailableRoots++; }
  }
  // A whole drive may contain home. Visit each physical tree once.
  return { roots: roots.filter(root => !roots.some(other => other !== root && root.startsWith(other.endsWith(path.sep) ? other : other + path.sep))), unavailableRoots };
}
