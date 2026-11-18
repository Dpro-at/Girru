// The PostgreSQL translation of each new migration must keep every column of the SQLite one.
// Run: node --test test/pg-migration-columns.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const columns = (sql) => {
  const out = {};
  for (const m of sql.replace(/--[^\n]*/g, '').matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\);/gi)) {
    // Split on top-level commas (a table may keep all its columns on one line), not on lines.
    const parts = []; let depth = 0, part = '';
    for (const ch of m[2]) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { parts.push(part); part = ''; } else part += ch; }
    parts.push(part);
    out[m[1]] = parts.map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => /^[a-z_]\w*\s+\w/i.test(l) && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(l)).map((l) => l.split(/\s+/)[0].toLowerCase()).sort();
  }
  return out;
};

test('PostgreSQL migrations from 142 on keep every SQLite column', () => {
  const files = readdirSync('src/db/migrations').filter((f) => /^(\d+)_.*\.sql$/.test(f) && Number(f.split('_')[0]) >= 142);
  assert.ok(files.length >= 2);
  for (const f of files) {
    const pg = `src/db/migrations-pg/${f}`;
    assert.ok(existsSync(pg), `${pg} is missing`);
    assert.deepEqual(columns(readFileSync(pg, 'utf8')), columns(readFileSync(`src/db/migrations/${f}`, 'utf8')), f);
  }
});
