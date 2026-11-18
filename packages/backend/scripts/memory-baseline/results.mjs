// MEM-SPEED-01: the memory search results log (docs/internal/memory-search-results.json).
// Every measurement (latency.mjs --record, the playground's benchmark) is appended here
// with the machine, the commit and the settings, so each improvement shows its difference
// against the last run of the same size on the same machine. Numbers and test-set
// questions only: never memory text of a real user.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { cpus, totalmem, platform, arch, release } from 'node:os';
import { dirname, join } from 'node:path';

export function resultsFile(backendDir) {
  return join(backendDir, '..', '..', 'docs', 'internal', 'memory-search-results.json');
}

export function machineInfo() {
  return {
    cpu: cpus()[0]?.model?.trim() || 'unknown',
    threads: cpus().length,
    ramGB: Math.round(totalmem() / 1024 ** 3),
    os: `${platform()} ${arch()} ${release()}`,
  };
}

export function gitInfo(backendDir) {
  const git = (...args) => { try { return execFileSync('git', args, { cwd: backendDir, encoding: 'utf-8' }).trim(); } catch { return null; } };
  const dirty = git('status', '--porcelain', '--', 'src/memory');
  return { commit: git('rev-parse', '--short', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), memoryCodeChanged: !!dirty };
}

export function readResults(backendDir) {
  const f = resultsFile(backendDir);
  if (!existsSync(f)) return { version: 1, description: 'Memory search measurements (MEM-SPEED-01). Append only.', runs: [] };
  return JSON.parse(readFileSync(f, 'utf-8'));
}

/** Append one run; returns it with its id. */
export function appendResult(backendDir, run) {
  const f = resultsFile(backendDir);
  mkdirSync(dirname(f), { recursive: true });
  const data = readResults(backendDir);
  const rec = { id: `r${Date.now().toString(36)}`, date: new Date().toISOString(), machine: machineInfo(), git: gitInfo(backendDir), ...run };
  data.runs.push(rec);
  writeFileSync(f, `${JSON.stringify(data, null, 2)}\n`);
  return rec;
}

/** The settings that change how search runs (recorded with every result). */
export function searchSettings() {
  const pick = (k) => process.env[k] ?? 'default';
  return {
    p9: process.env.GIRRU_STORE_P9 === '1', store: process.env.GIRRU_RECALL_STORE !== '0',
    exactMax: pick('GIRRU_RECALL_EXACT_MAX'), annMin: pick('GIRRU_RECALL_ANN_MIN'),
    rescore: pick('GIRRU_RECALL_RESCORE'), indexMB: pick('GIRRU_RECALL_INDEX_MB'),
  };
}
