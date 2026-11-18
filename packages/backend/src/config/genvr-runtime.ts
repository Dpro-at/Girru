/** Shared runtime lookup without importing Store installation or database services. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPath } from './data-root.js';
import { installedGenvrRuntime, resolveGenvrRuntime } from './genvr-runtime-path.cjs';

export const genvrStoreActive = () => path.isAbsolute((process.env.GIRRU_APP_RUNTIMES_DIR ?? '').trim());
export const genvrRuntimesRoot = () => genvrStoreActive() ? path.resolve(process.env.GIRRU_APP_RUNTIMES_DIR!.trim()) : dataPath('app-runtimes');
export const genvrBundledRoot = () => fileURLToPath(new URL('../../../core-ui/vendor/genvr', import.meta.url));
export const genvrRuntime = () => resolveGenvrRuntime({ runtimesDir: genvrStoreActive() ? genvrRuntimesRoot() : undefined, bundledRoot: process.env.GIRRU_GENVR_BUNDLED === '0' ? undefined : genvrBundledRoot() });
export const genvrInstalled = () => genvrStoreActive() ? installedGenvrRuntime(genvrRuntimesRoot()) : null;
export const genvrBundled = () => genvrRuntime()?.source === 'bundled';
