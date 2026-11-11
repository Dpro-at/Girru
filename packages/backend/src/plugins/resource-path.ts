import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

const inside = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel === '' || (rel !== '..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel));
};
const prefixOf = (root: string) => (root.endsWith(path.sep) ? root : root + path.sep);

/** Resolve a declared extension resource without following links outside its root. */
export function extensionResourcePath(rootDir: string, relativeName: string): string {
  if (typeof relativeName !== 'string' || relativeName.includes('\0') || path.isAbsolute(relativeName)) throw new Error('Invalid extension resource path');
  const root = path.resolve(rootDir);
  const candidate = path.resolve(root, relativeName);
  // Two forms of the same rule (relative path, and prefix of the resolved path), checked right here next to the use.
  if (!inside(root, candidate) || (candidate !== root && !candidate.startsWith(prefixOf(root)))) throw new Error('Extension resource is outside its directory');
  if (!existsSync(candidate)) return candidate;
  const realRoot = realpathSync(root), real = realpathSync(candidate);
  if (!inside(realRoot, real) || (real !== realRoot && !real.startsWith(prefixOf(realRoot)))) throw new Error('Extension resource link is outside its directory');
  return real;
}
