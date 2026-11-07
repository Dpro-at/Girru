import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

export function getClaudeDir(): string {
  return path.join(os.homedir(), '.claude');
}

export async function claudeDirExists(): Promise<boolean> {
  try {
    await fs.access(getClaudeDir());
    return true;
  } catch {
    return false;
  }
}

export function cwdToSlug(cwd: string): string {
  return cwd
    .replace(':', '-')
    .replace(/[\\/]/g, '-')
    .replace(/^./, (c) => c.toLowerCase());
}

export async function findMemoryForCwd(cwd: string): Promise<string | null> {
  const projectsDir = path.join(getClaudeDir(), 'projects');
  const cwdSlug = cwdToSlug(cwd);

  let projects: string[] = [];
  try {
    projects = await fs.readdir(projectsDir);
  } catch {
    return null;
  }

  let bestSlug = '';
  for (const slug of projects) {
    if (cwdSlug.startsWith(slug) && slug.length > bestSlug.length) {
      bestSlug = slug;
    }
  }

  if (!bestSlug) return null;

  const memPath = path.join(projectsDir, bestSlug, 'memory', 'MEMORY.md');
  return fs.readFile(memPath, 'utf-8').catch(() => null);
}

export async function loadClaudeProjectMemory(): Promise<string | null> {
  try {
    return await findMemoryForCwd(process.cwd());
  } catch {
    return null;
  }
}
