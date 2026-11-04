/**
 * "Memory limited" for local chat models (STORE-MAP-01 P2b, LOCAL-ONLY-01
 * item 1, XP3). A local model that ran the five memory verbs is recorded per
 * provider and model in `<data>/local-model-conformance.json`; one that failed
 * is marked memory limited (a screen can show it later; SETTINGS-REVIEW-01).
 * The file holds provider, model, pass/fail, the failed checks and the time:
 * no memory text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir } from '../config/secrets-bootstrap.js';

export const CONFORMANCE_FILE = 'local-model-conformance.json';
export interface LocalConformanceRow { provider: string; model: string; passed: boolean; failures: string[]; window: number | null; at: string }

const file = (dataDir = process.env.AGENT_PLAYER_DATA_DIR || defaultDataDir()) => path.join(dataDir, CONFORMANCE_FILE);

export function readLocalConformance(dataDir?: string): LocalConformanceRow[] {
  try {
    const rows = JSON.parse(fs.readFileSync(file(dataDir), 'utf8'));
    return Array.isArray(rows) ? rows.filter((r) => r && typeof r.provider === 'string' && typeof r.model === 'string') : [];
  } catch { return []; }
}

export function recordLocalConformance(row: Omit<LocalConformanceRow, 'at'>, dataDir?: string): LocalConformanceRow {
  const clean: LocalConformanceRow = {
    provider: String(row.provider).slice(0, 40), model: String(row.model).slice(0, 120), passed: !!row.passed,
    failures: (row.failures ?? []).map((f) => String(f).slice(0, 120)).slice(0, 12), window: row.window ?? null, at: new Date().toISOString(),
  };
  const rows = readLocalConformance(dataDir).filter((r) => !(r.provider === clean.provider && r.model === clean.model));
  rows.push(clean);
  const target = file(dataDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(rows, null, 2), { mode: 0o600 });
  fs.renameSync(`${target}.tmp`, target);
  return clean;
}

/** true: the model failed the five verbs; false: it passed; null: never checked. */
export function memoryLimited(provider: string, model: string, dataDir?: string): boolean | null {
  const row = readLocalConformance(dataDir).find((r) => r.provider === provider && r.model === model);
  return row ? !row.passed : null;
}
