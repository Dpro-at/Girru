/**
 * Library folders are never projects (MEM-READ-01 MR3).
 *
 * Code that a package manager downloaded for other projects (the Go module
 * cache, node_modules, vendor, CocoaPods, Python site-packages, the Cargo and
 * Maven caches, …) holds READMEs and notes, but it is not the owner's work.
 * Discovery skips these folders on its own; projects found in them before this
 * rule are listed under "Not projects" (Settings › Memory › Projects), where
 * the owner can say "It's a project".
 */

import path from 'node:path';

/** A folder with one of these names holds downloaded code, wherever it is. */
export const LIBRARY_DIR_NAMES = new Set([
  'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'Pods', 'Carthage', 'DerivedData',
  'site-packages', 'dist-packages', '.pnpm-store', '.yarn', '.npm', '.m2', '.gradle', '.cargo', '.rustup',
  '.nuget', '.pub-cache', '.cocoapods', '.bundle', '.gem', '.cpan', '.stack', '.cabal', '.opam', '.julia',
]);

/** Folder pairs that hold downloaded code: <a>/<b> anywhere in the path. */
const LIBRARY_PAIRS: Array<[string, string]> = [
  ['pkg', 'mod'],          // Go module cache ($GOPATH/pkg/mod, ~/go/pkg/mod)
  ['Caches', 'Homebrew'],
  ['Library', 'Caches'],
  ['.cache', 'go-build'],
  ['.cache', 'pip'],
  ['.local', 'pipx'],
];

/** A Go module version folder: name@v1.2.3, name@v0.0.0-2023…-abcdef, name@v2.0.0+incompatible. */
const GO_MODULE_DIR = /^[^@/\\]+@v\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.+-]*)?$/;

const segments = (p: string) => p.split(/[\\/]+/).filter(Boolean);

/** True when this folder name alone marks downloaded code (to skip it while walking). */
export function libraryDirName(name: string, parent?: string): boolean {
  if (LIBRARY_DIR_NAMES.has(name) || GO_MODULE_DIR.test(name)) return true;
  if (parent) { const p = path.basename(parent); return LIBRARY_PAIRS.some(([a, b]) => a === p && b === name); }
  return false;
}

/** True when a path is inside (or is) a library folder. */
export function isLibraryPath(p: string | null | undefined): boolean {
  if (!p) return false;
  const parts = segments(p);
  for (let i = 0; i < parts.length; i++) {
    if (LIBRARY_DIR_NAMES.has(parts[i]) || GO_MODULE_DIR.test(parts[i])) return true;
    if (i > 0 && LIBRARY_PAIRS.some(([a, b]) => parts[i - 1] === a && parts[i] === b)) return true;
  }
  return false;
}

/**
 * True for a project key that was made from a Go module version folder:
 * "bubbletea@v1.3.10" became "bubbletea-v1-3-10", "ansi@v0.0.0-2023…" became "ansi-v0-0-0-2023…".
 */
export function libraryProjectKey(slug: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*-v\d+-\d+-\d+(?:-[a-z0-9-]*)?$/.test(slug);
}

/** A short, plain reason for the "Not projects" list. */
export function libraryKindOf(p: string | null | undefined, slug?: string): string {
  const parts = p ? segments(p) : [];
  if (parts.some(x => GO_MODULE_DIR.test(x)) || parts.join('/').includes('pkg/mod') || (slug && libraryProjectKey(slug))) return 'Go library';
  if (parts.includes('node_modules') || parts.includes('bower_components') || parts.includes('.npm') || parts.includes('.yarn') || parts.includes('.pnpm-store')) return 'JavaScript package';
  if (parts.includes('Pods') || parts.includes('Carthage') || parts.includes('.cocoapods')) return 'iOS library';
  if (parts.includes('site-packages') || parts.includes('dist-packages')) return 'Python package';
  if (parts.includes('.cargo') || parts.includes('.rustup')) return 'Rust library';
  if (parts.includes('vendor')) return 'Vendored code';
  return 'Downloaded code';
}

/** The display name of a library project: "bubbletea-v1-3-10" -> "bubbletea". */
export function libraryShortName(slug: string): string {
  const m = /^(.*?)-v\d+-\d+-\d+/.exec(slug);
  return (m ? m[1] : slug) || slug;
}
