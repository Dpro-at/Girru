import { discoveryFs, isolatedReadRegularFile } from '../../services/discovery-fs.js';
/** Read-only discovery roots. OS permission grants are checked by actual reads, never inferred. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type ComputerRoots = { roots: string[]; unavailableRoots: number };

/** The OS account's own home folder, from the user database (not from $HOME / %USERPROFILE%). */
export function accountHome(): string | null { try { return os.userInfo().homedir || null; } catch { return null; } }

/**
 * True when Girru runs with a HOME that is not the account's own home: a test or separate profile
 * (open-fresh-test.command, CI, a second profile). Such a profile only sees its own HOME, so a scan
 * never reads or imports the real home's projects and memory files.
 */
export async function separateHome(home: string, account: string | null = accountHome()): Promise<boolean> {
  if (!account) return false;
  const real = async (p: string) => { try { return await fs.realpath(p); } catch { return path.resolve(p); } };
  const [a, b] = await Promise.all([real(home), real(account)]);
  return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() !== b.toLowerCase() : a !== b;
}

export async function computerRoots(options: { home?: string; roots?: string[]; platform?: NodeJS.Platform; accountHome?: string | null } = {}): Promise<ComputerRoots> {
  const home = options.home ?? os.homedir(), platform = options.platform ?? process.platform;
  // The whole computer is searched only from the account's own home; a separate HOME stays inside itself.
  const deviceWide = !options.roots && !(await separateHome(home, options.accountHome === undefined ? accountHome() : options.accountHome));
  const candidates = options.roots ? [...options.roots] : deviceWide ? [home, ...(platform === 'win32' ? [] : [path.parse(home).root])] : [home];
  let unavailableRoots = 0;
  if (deviceWide) {
    if (platform === 'win32') {
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        const drive = `${letter}:\\`;
        if ((await discoveryFs.stat(drive).catch(() => null))?.isDirectory()) candidates.push(drive);
      }
    } else {
      const bases = platform === 'darwin' ? ['/Volumes'] : [`/media/${os.userInfo().username}`, '/mnt'];
      for (const base of bases) {
        try { for (const entry of await discoveryFs.readdir(base, { withFileTypes: true })) if (entry.isDirectory() || entry.isSymbolicLink()) candidates.push(path.join(base, entry.name)); }
        catch (error: any) { if (error.code !== 'ENOENT') unavailableRoots++; }
      }
    }
  }
  const roots: string[] = [];
  for (const candidate of candidates) {
    try {
      const real = await discoveryFs.realpath(candidate);
      // Canonical aliases of the system disk collapse to the same single root.
      if (!(await discoveryFs.stat(real)).isDirectory()) continue;
      if (!roots.includes(real)) roots.push(real);
    } catch { unavailableRoots++; }
  }
  // A whole drive may contain home. Visit each physical tree once.
  return { roots: roots.filter(root => !roots.some(other => other !== root && root.startsWith(other.endsWith(path.sep) ? other : other + path.sep))), unavailableRoots };
}
