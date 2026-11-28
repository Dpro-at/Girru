/**
 * MEM-PANEL-01: the memory helper's settings and its RAM.
 *
 * One file per installation (<data>/memory-helper-settings.json): RAM is the
 * computer's, not one owner's. It holds a RAM limit and the night writer.
 *
 *   RAM limit  auto    a quarter of this computer's RAM (default)
 *              light   about 1 GB: search only, the night writer stays off
 *              custom  the owner's number of GB (1 .. the computer's RAM)
 *
 * The local runtime has no hard cap, so the limit is kept by Girru itself:
 * a model whose RAM does not fit is never chosen or loaded, the night writer
 * is unloaded when the night work ends, and night work waits while the
 * computer has less than LOW_FREE_BYTES of RAM available.
 *
 * The night writer can only be a model already on this computer (a download
 * would need its size shown first; that comes with the Store, D3).
 * MEMORY_WORKER_MODEL (env) still wins when it is set, for tests and old setups.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { defaultOllamaUrl } from '../config/ollama-url.js';
import { defaultDataDir } from '../config/secrets-bootstrap.js';

export const SETTINGS_FILE = 'memory-helper-settings.json';
export const GIB = 1024 ** 3;
export const LIGHT_LIMIT_BYTES = Math.round(1.25 * GIB);
export const LOW_FREE_BYTES = 2 * GIB;

export type RamMode = 'auto' | 'light' | 'custom';
export interface HelperSettings { version: 1; ram: { mode: RamMode; customGb: number | null }; worker: string | null }
export interface LoadedModel { model: string; bytes: number }
export interface InstalledModel { model: string; diskBytes: number }
export interface RamView {
  totalBytes: number; availableBytes: number | null; modelsBytes: number; loaded: LoadedModel[];
  limitBytes: number; mode: RamMode; customGb: number | null; lowFreeBytes: number;
}
export interface WorkerCandidate { model: string; ramBytes: number; fits: boolean; chosen: boolean }

export class HelperSettingsError extends Error {
  constructor(message: string, readonly code: 'invalid_settings' | 'worker_not_installed' | 'worker_too_big' | 'worker_off_in_light') { super(message); }
}

/** The outside parts; tests replace them (no runtime, no real RAM). */
export interface RamDeps {
  dataDir: () => string;
  totalBytes: () => number;
  availableBytes: () => Promise<number | null>;
  baseUrl: () => string;
  fetch: typeof fetch;
}

/** RAM the system can give without swapping: macOS free+inactive+speculative+purgeable pages, Linux MemAvailable. */
async function systemAvailable(): Promise<number | null> {
  if (process.platform === 'darwin') {
    const out = await new Promise<string>((resolve) => execFile('vm_stat', [], { timeout: 2_000 }, (err, stdout) => resolve(err ? '' : String(stdout))));
    const page = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 0);
    if (!page) return null;
    let pages = 0;
    for (const key of ['Pages free', 'Pages inactive', 'Pages speculative', 'Pages purgeable']) {
      const m = new RegExp(`${key}:\\s+(\\d+)`).exec(out);
      if (m) pages += Number(m[1]);
    }
    return pages * page;
  }
  if (process.platform === 'linux') {
    try {
      const m = /MemAvailable:\s+(\d+) kB/.exec(await fs.promises.readFile('/proc/meminfo', 'utf8'));
      if (m) return Number(m[1]) * 1024;
    } catch { /* fall through */ }
  }
  return os.freemem();
}

const defaultDeps: RamDeps = {
  dataDir: () => defaultDataDir(),
  totalBytes: () => os.totalmem(),
  availableBytes: systemAvailable,
  baseUrl: () => defaultOllamaUrl().replace(/\/+$/, ''),
  fetch: (...a) => fetch(...a),
};
let deps: RamDeps = defaultDeps;
/** Tests: replace some outside parts; `null` restores the real ones. */
export function setRamDeps(partial: Partial<RamDeps> | null): void { deps = partial ? { ...defaultDeps, ...partial } : defaultDeps; }

// ---- settings file ------------------------------------------------------------------

let cached: HelperSettings | null = null;
const file = () => path.join(deps.dataDir(), SETTINGS_FILE);
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function helperSettings(): HelperSettings {
  if (cached) return structuredClone(cached);
  let saved: Partial<HelperSettings> | null = null;
  try { saved = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { /* first run */ }
  const mode = saved?.ram?.mode;
  const customGb = Number(saved?.ram?.customGb);
  cached = {
    version: 1,
    ram: { mode: mode === 'light' || mode === 'custom' ? mode : 'auto', customGb: mode === 'custom' && Number.isFinite(customGb) && customGb >= 1 ? Math.floor(customGb) : null },
    worker: typeof saved?.worker === 'string' && MODEL_NAME.test(saved.worker) ? saved.worker : null,
  };
  if (cached.ram.mode === 'custom' && cached.ram.customGb === null) cached.ram.mode = 'auto';
  return structuredClone(cached);
}

const MODES = { auto: 'auto', light: 'light', custom: 'custom' } as const;

function save(s: HelperSettings): void {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  // Only fixed words, a whole number and a checked model name reach the file.
  const mode = MODES[s.ram.mode] ?? 'auto';
  const customGb = mode === 'custom' && Number.isInteger(s.ram.customGb) ? Math.floor(Number(s.ram.customGb)) : null;
  const worker = typeof s.worker === 'string' && MODEL_NAME.test(s.worker) ? s.worker : null;
  const clean: HelperSettings = { version: 1, ram: { mode, customGb }, worker };
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
  cached = structuredClone(clean);
}

/** Tests: read the file again. */
export function resetHelperSettings(): void { cached = null; }

/** The night writer in use: the env (tests, old setups) first, then the owner's choice; light mode keeps it off. */
export function chosenWorker(): string | null {
  const env = String(process.env.MEMORY_WORKER_MODEL ?? '').trim();
  if (env) return /^(0|off|false|no)$/i.test(env) ? null : env;
  const s = helperSettings();
  return s.ram.mode === 'light' ? null : s.worker;
}

// ---- RAM ----------------------------------------------------------------------------

export function limitBytes(s: HelperSettings = helperSettings(), total = deps.totalBytes()): number {
  if (s.ram.mode === 'light') return LIGHT_LIMIT_BYTES;
  if (s.ram.mode === 'custom' && s.ram.customGb) return Math.min(total, s.ram.customGb * GIB);
  return Math.floor(total / 4);
}

async function getJson(pathname: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await deps.fetch(`${deps.baseUrl()}${pathname}`, { signal: AbortSignal.timeout(2_000) });
    return res.ok ? await res.json() as Record<string, unknown> : null;
  } catch { return null; }
}

/** Models the local runtime holds in RAM right now. */
export async function loadedModels(): Promise<LoadedModel[]> {
  const body = await getJson('/api/ps');
  const list = Array.isArray(body?.models) ? body!.models as Array<Record<string, unknown>> : [];
  return list.map((m) => ({ model: String(m.name ?? m.model ?? ''), bytes: Math.max(0, Number(m.size) || 0) })).filter((m) => m.model);
}

/** Models on this computer (download size). */
export async function installedModels(): Promise<InstalledModel[]> {
  const body = await getJson('/api/tags');
  const list = Array.isArray(body?.models) ? body!.models as Array<Record<string, unknown>> : [];
  return list.map((m) => ({ model: String(m.name ?? m.model ?? ''), diskBytes: Math.max(0, Number(m.size) || 0) })).filter((m) => m.model);
}

/** RAM a model needs once loaded: what the runtime reports when loaded, else its download size plus a margin. */
export function ramFor(model: string, installed: InstalledModel[], loaded: LoadedModel[]): number {
  const l = loaded.find((m) => m.model === model);
  if (l?.bytes) return l.bytes;
  const i = installed.find((m) => m.model === model || m.model === `${model}:latest`);
  return i ? Math.round(i.diskBytes * 1.25 + 256 * 1024 ** 2) : 0;
}

export async function ramView(): Promise<RamView> {
  const s = helperSettings();
  const total = deps.totalBytes();
  const loaded = await loadedModels();
  return {
    totalBytes: total, availableBytes: await deps.availableBytes(), modelsBytes: loaded.reduce((a, m) => a + m.bytes, 0), loaded,
    limitBytes: limitBytes(s, total), mode: s.ram.mode, customGb: s.ram.customGb, lowFreeBytes: LOW_FREE_BYTES,
  };
}

/** Night work waits while the computer has less than LOW_FREE_BYTES available (unknown = go on). */
export async function ramTooLow(): Promise<boolean> {
  const a = await deps.availableBytes();
  return a !== null && a < LOW_FREE_BYTES;
}

const isEmbedding = (m: string) => /embed/i.test(m);

/** Models on this computer that could be the night writer, smallest first, with whether each fits the limit. */
export async function workerCandidates(embeddingModel: string): Promise<WorkerCandidate[]> {
  const s = helperSettings();
  const limit = limitBytes(s);
  const installed = await installedModels();
  const loaded = await loadedModels();
  const embedRam = ramFor(embeddingModel, installed, loaded);
  const chosen = chosenWorker();
  return installed.filter((m) => !isEmbedding(m.model) && m.model !== embeddingModel)
    .map((m) => { const ram = ramFor(m.model, installed, loaded); return { model: m.model, ramBytes: ram, fits: s.ram.mode !== 'light' && embedRam + ram <= limit, chosen: chosen === m.model }; })
    .sort((a, b) => a.ramBytes - b.ramBytes);
}

/**
 * The owner changes the settings (route and agent tool). A night writer must be on this computer
 * and fit the RAM limit together with the search model; light mode turns it off.
 */
export async function setHelperSettings(input: unknown, embeddingModel: string): Promise<HelperSettings> {
  const b = input as Record<string, unknown>;
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => !['ram', 'worker'].includes(k))) throw new HelperSettingsError('Use ram and worker', 'invalid_settings');
  const cur = helperSettings();
  const next: HelperSettings = structuredClone(cur);
  if (b.ram !== undefined) {
    const r = b.ram as Record<string, unknown>;
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some((k) => !['mode', 'customGb'].includes(k))) throw new HelperSettingsError('ram is { mode, customGb? }', 'invalid_settings');
    if (r.mode !== 'auto' && r.mode !== 'light' && r.mode !== 'custom') throw new HelperSettingsError('mode is auto, light or custom', 'invalid_settings');
    let customGb: number | null = null;
    if (r.mode === 'custom') {
      const totalGb = Math.floor(deps.totalBytes() / GIB);
      const n = Number(r.customGb);
      if (!Number.isInteger(n) || n < 1 || n > Math.max(1, totalGb)) throw new HelperSettingsError(`customGb is a whole number from 1 to ${Math.max(1, totalGb)}`, 'invalid_settings');
      customGb = n;
    }
    next.ram = { mode: MODES[r.mode], customGb };
  }
  if (b.worker !== undefined) {
    if (b.worker !== null && (typeof b.worker !== 'string' || !MODEL_NAME.test(b.worker))) throw new HelperSettingsError('worker is a model name or null', 'invalid_settings');
    next.worker = b.worker as string | null;
  }
  if (next.worker) {
    if (next.ram.mode === 'light') {
      if (b.worker !== undefined) throw new HelperSettingsError('Light keeps the night writer off; choose Automatic or Custom first', 'worker_off_in_light');
    } else {
      const installed = await installedModels();
      const found = installed.find((m) => m.model === next.worker || m.model === `${next.worker}:latest`);
      if (!found) throw new HelperSettingsError('The night writer must already be on this computer', 'worker_not_installed');
      // Save the name as this computer lists it, never the text that came in.
      next.worker = found.model;
      const loaded = await loadedModels();
      const need = ramFor(embeddingModel, installed, loaded) + ramFor(next.worker, installed, loaded);
      if (need > limitBytes(next)) throw new HelperSettingsError('This model does not fit in the RAM limit', 'worker_too_big');
    }
  }
  save(next);
  return structuredClone(next);
}

/** Free a model's RAM now (the runtime unloads it when keep_alive is 0). Never throws. */
export async function unloadModel(model: string): Promise<boolean> {
  if (!(await loadedModels()).some((m) => m.model === model || m.model === `${model}:latest`)) return false;
  try {
    const res = await deps.fetch(`${deps.baseUrl()}/api/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }), signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch { return false; }
}
