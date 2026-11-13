/**
 * Isolated backend launcher (RUN-ISO F2/F3, ISO-1/2/3, read-only stage 1).
 *
 * Starts src/api/server.ts as a child process with an environment built from
 * nothing, so no real key, token, database or config reaches it, and with
 * every store under one fresh, private data root.
 *
 * Exact outer command (from packages/backend; <...> are placeholders):
 *
 *   env -i PATH=<node bin dir>:/usr/bin:/bin HOME=<parent of fresh root> \
 *     AGENT_PLAYER_DATA_DIR=<fresh root> PORT=42521 \
 *     ALLOWED_ORIGINS=http://127.0.0.1:42522 \
 *     <node> --import tsx scripts/isolated-server.ts
 *
 * <fresh root> must NOT exist yet. Its parent must be an existing, canonical
 * (no symlinked ancestor) directory owned by the current user and not
 * group/world-writable; the launcher creates the root itself with an
 * exclusive mkdir (0700) and refuses when it already exists.
 *
 * Refuses to start (exit 2) when:
 *  - ISO-3: the launcher's own environment has NODE_OPTIONS, NODE_PATH,
 *    NODE_EXTRA_CA_CERTS, NODE_TLS_REJECT_UNAUTHORIZED, UV_THREADPOOL_SIZE,
 *    any other NODE_* (except NODE_ENV), npm_config_*, TSX_* (except
 *    TSX_TSCONFIG_PATH=<backend tsconfig.json>), LD_* / DYLD_*,
 *    ELECTRON_RUN_AS_NODE; HOME is not the parent of the fresh root; or Node
 *    was started with any flag other than `--import tsx`;
 *  - AGENT_PLAYER_DATA_DIR is unset, relative, a filesystem root, inside (or
 *    containing) the source checkout or the real home, already exists, or
 *    its parent fails the checks above (ISO-1);
 *  - HOST is set to anything but 127.0.0.1 (it is forced to 127.0.0.1);
 *  - PORT is missing or not 1-65535;
 *  - ALLOWED_ORIGINS is missing or not an exact list of loopback origins;
 *  - AGENT_PLAYER_DB, AGENT_PLAYER_PG_URL or DATABASE_URL is set;
 *  - a per-store path override (DATABASE_PATH, UPLOADS_DIR, ...) is set;
 *  - AGENT_PLAYER_BACKGROUND, EXTENSIONS_DISABLED, MEMORY_EMBEDDINGS or
 *    AGENT_PLAYER_READONLY is set to anything but off / true / hash / 1;
 *  - ISO-2: OLLAMA_URL, LOCAL_MODEL_API_URL, OLLAMA_HOST or any *_BASE_URL /
 *    *_API_URL / *_API_BASE is set at all (both local endpoints are always
 *    forced to the dead port http://127.0.0.1:9);
 *  - AGENT_PLAYER_ISOLATED_STAGE is set to anything but 1, 2 or 3 (2 = chat
 *    with the local Ollama only; 3 = stage 2 plus hiring agents: create and
 *    tool grants, on the fresh fake data).
 *
 * The child gets AGENT_PLAYER_ISOLATED=1 and AGENT_PLAYER_READONLY=1, so the
 * server re-checks the same rules and the data tree (no symlinks, no foreign
 * owner, no group/world-writable entry) before it generates secrets or opens
 * any store, and serves only reads, login/logout and first-run setup. Its
 * cwd, HOME, XDG_CONFIG_HOME and TMPDIR are inside the data root; its output
 * goes to <data root>/logs/backend.log (created O_EXCL|O_NOFOLLOW, 0600).
 * This launcher prints only `listening on 127.0.0.1:<port>` and the data
 * dir, never a secret. Ctrl-C (SIGINT) or SIGTERM is passed to the server
 * for a clean shutdown.
 *
 * Limits: loopback endpoints are not a network sandbox. Request-time code
 * with its own hard-coded host can still dial out; stage 1 blocks the
 * requests that reach it (every non-read route).
 */

import { spawn } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIsolatedChildEnv, checkLauncherEnv } from '../src/config/isolation.js';
import { checkOuterLauncherEnv } from '../src/config/isolated-env-check.js';
import { checkIsolatedTree, checkTrustedParent, ISOLATED_DIRS, LOG_FILE, openFreshLogFile } from '../src/config/isolated-tree.js';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(backendDir, '..', '..');
const tsconfigPath = path.join(backendDir, 'tsconfig.json');

function refuse(errors: string[]): never {
  for (const e of errors) console.error(`refused: ${e}`);
  process.exit(2);
}

// ISO-3: the launcher's own environment and Node flags.
const outer = checkOuterLauncherEnv(process.env, process.execArgv, { tsconfigPath });
// The real home comes from the user database, not from HOME (HOME is the throwaway parent).
const checked = checkLauncherEnv(process.env, { repoRoot, homeDirs: [os.userInfo().homedir] });
if (outer.length || !checked.ok) refuse([...outer, ...(checked.ok ? [] : checked.errors)]);
const cfg = checked.config;

// ISO-1: a fresh root under a trusted parent, created exclusively.
const parentProblems = checkTrustedParent(path.dirname(cfg.dataDir));
if (parentProblems.length) refuse(parentProblems);
let exists = true;
try {
  lstatSync(cfg.dataDir);
} catch (err: any) {
  if (err?.code !== 'ENOENT') refuse(['AGENT_PLAYER_DATA_DIR cannot be checked']);
  exists = false;
}
if (exists) refuse(['AGENT_PLAYER_DATA_DIR must not exist yet (the launcher creates a fresh root)']);
try {
  mkdirSync(cfg.dataDir, { mode: 0o700 });
} catch (err: any) {
  refuse([err?.code === 'EEXIST' ? 'AGENT_PLAYER_DATA_DIR must not exist yet (the launcher creates a fresh root)' : 'AGENT_PLAYER_DATA_DIR cannot be created']);
}
for (const d of ISOLATED_DIRS) {
  try {
    mkdirSync(path.join(cfg.dataDir, ...d.split('/')), { mode: 0o700 });
  } catch {
    refuse([`<data root>/${d} cannot be created`]);
  }
}
const treeProblems = checkIsolatedTree(cfg.dataDir);
if (treeProblems.length) refuse(treeProblems);

const runDir = path.join(cfg.dataDir, 'run');
const logPath = path.join(cfg.dataDir, LOG_FILE);
let logFd = -1;
try {
  logFd = openFreshLogFile(logPath);
} catch {
  refuse(['<data root>/logs/backend.log cannot be created (it must not exist yet and must not be a link)']);
}

const env = buildIsolatedChildEnv(cfg, process.env, path.dirname(process.execPath));
env.TSX_TSCONFIG_PATH = tsconfigPath;

const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(backendDir, 'src', 'api', 'server.ts')], {
  cwd: runDir,
  env,
  stdio: ['ignore', logFd, logFd, 'ipc'],
});
closeSync(logFd);

child.on('message', (msg: any) => {
  // The server asks its parent for the memory-encryption plan first; this launcher never holds one (plain memory).
  if (msg && msg.type === 'memory-control-ready') { child.send({ v: 1, type: 'memory-control-bootstrap', plan: { control: null, selection: { selected: false, profileId: null, mode: 'none' } } }); return; }
  if (msg && msg.type === 'listening' && Number.isInteger(msg.port)) {
    console.log(`listening on 127.0.0.1:${msg.port}`);
    console.log(`data dir: ${cfg.dataDir}`);
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { child.kill(signal); });
}

child.on('exit', (code, signal) => {
  if (code !== 0) console.error(`server stopped (${signal ?? `exit ${code}`}); see ${logPath}`);
  process.exit(code ?? 1);
});
