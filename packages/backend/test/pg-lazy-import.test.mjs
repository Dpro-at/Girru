// B2.2a follow-up: SQLite mode must load without the `pg` package installed.
// Run: node --import tsx --test test/pg-lazy-import.test.mjs
//
// Method: a static scan of the import graph, starting at the app entry points.
// Every runtime import (static `import`/`export ... from`, side-effect
// imports, literal dynamic `import('./x')` of local files, `require`) is
// followed through src/. The scan fails if any reached module has a runtime
// (non type-only) import of `pg` or one of its parts. `import type` is erased
// by the compiler and is allowed; `await import('pg')` (the lazy load in
// db/pg/pool.ts) is allowed.
// Why static rather than running with pg hidden: it covers every module the
// app can reach, including ones only loaded by a later request, needs no
// node_modules tricks, and gives the same answer on every machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES = ['src/repositories/index.ts', 'src/api/app.ts', 'src/api/server.ts', 'src/api/server-main.ts'].map((p) => join(backend, p));
const PG_PACKAGES = /^(pg|pg-pool|pg-types|pg-protocol|pg-connection-string|pg-cloudflare|pgpass)(\/|$)/;

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');
}

/** Runtime imports of one source: [{ spec, dynamic }]; type-only imports are left out. */
export function runtimeImports(src) {
  const code = stripComments(src);
  const out = [];
  const stmt = /(?:^|[;\n}])\s*(import|export)\s+(type\s+)?([\w*{}\s,$]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(stmt)) {
    const [, , typeKw, clause, spec] = m;
    if (typeKw) continue;
    const braces = /^\{([\s\S]*)\}$/.exec(clause.trim());
    if (braces) {
      const members = braces[1].split(',').map((x) => x.trim()).filter(Boolean);
      if (members.length > 0 && members.every((x) => x.startsWith('type '))) continue;
    }
    out.push({ spec, dynamic: false });
  }
  for (const m of code.matchAll(/(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g)) out.push({ spec: m[1], dynamic: false });
  for (const m of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ spec: m[1], dynamic: true });
  for (const m of code.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ spec: m[1], dynamic: false });
  return out;
}

function resolveLocal(from, spec) {
  const base = resolve(dirname(from), spec);
  const candidates = [base.replace(/\.js$/, '.ts'), base, `${base}.ts`, join(base, 'index.ts')];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile() && /\.(ts|mjs|js)$/.test(c)) ?? null;
}

function scan(entries) {
  const seen = new Set();
  const offenders = [];
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { spec, dynamic } of runtimeImports(readFileSync(file, 'utf8'))) {
      if (PG_PACKAGES.test(spec)) {
        if (!dynamic) offenders.push(`${relative(backend, file)}: runtime import of '${spec}'`);
        continue;
      }
      if (!spec.startsWith('.')) continue;
      const next = resolveLocal(file, spec);
      if (next && next.startsWith(join(backend, 'src'))) queue.push(next);
    }
  }
  return { seen, offenders };
}

test('scanner: tells runtime imports of pg from type-only ones', () => {
  const specs = (src) => runtimeImports(src).filter((x) => !x.dynamic).map((x) => x.spec);
  assert.deepEqual(specs(`import pg from 'pg';`), ['pg']);
  assert.deepEqual(specs(`import { Pool } from "pg"`), ['pg']);
  assert.deepEqual(specs(`import pg, { type Pool } from 'pg';`), ['pg']);
  assert.deepEqual(specs(`export { Pool } from 'pg';`), ['pg']);
  assert.deepEqual(specs(`import 'pg';`), ['pg']);
  assert.deepEqual(specs(`const pg = require('pg');`), ['pg']);
  assert.deepEqual(specs(`import {\n  Pool,\n  Client,\n} from 'pg';`), ['pg']);
  assert.deepEqual(specs(`import type pg from 'pg';`), []);
  assert.deepEqual(specs(`import { type Pool, type Client } from 'pg';`), []);
  assert.deepEqual(specs(`export type { Pool } from 'pg';`), []);
  assert.deepEqual(specs(`// import pg from 'pg';\n/* import pg from 'pg' */`), []);
  assert.deepEqual(runtimeImports(`const m = await import('pg');`), [{ spec: 'pg', dynamic: true }]);
});

test('no module reachable from the app entry points imports pg at runtime', () => {
  const { seen, offenders } = scan(ENTRIES);
  // The scan really reaches the PostgreSQL modules (otherwise it proves nothing).
  for (const p of ['src/db/pg/pool.ts', 'src/db/pg/types.ts', 'src/repositories/pg/users-store.ts', 'src/repositories/pg/login-throttle.ts']) {
    assert.ok(seen.has(join(backend, p)), `scan did not reach ${p}`);
  }
  assert.ok(seen.size > 100, `only ${seen.size} modules scanned`);
  assert.deepEqual(offenders, []);
});
