// The server, loaded by server.ts once load-env has finished (a pending restore
// is then in place before any store opens). Started directly (tests, tools),
// load-env still runs first.
import '../config/load-env.js';

// SECURITY: Default to production mode if NODE_ENV not set (L-04)
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
  console.warn('[Security] NODE_ENV not set - defaulting to production mode');
}

/**
 * Girru Backend Server
 * Fastify-based REST API
 */

import path from 'node:path';
import { buildServer } from './app.js';
import {nativeProcessStartup} from '../memory/encryption/native-process-startup.js';
import { initializeBackend } from './startup.js';
import { onRestartRequest, RESTART_EXIT_CODE } from './restart-request.js';
import { config } from '../config/index.js';
import { dataRoot, mainDatabasePath } from '../config/data-root.js';
import { dbDriver } from '../db/pg/config.js';
import { ISOLATED_ENV } from '../config/isolation.js';
import { LAUNCH_TOKEN_ENV } from './launch-token.js';
import { assertSafeIsolatedTree } from '../config/isolated-tree.js';
import { flushAuditWritesWithin, SHUTDOWN_AUDIT_FLUSH_MS } from '../services/audit-logger.js';
import { startAutomaticProjectImports, stopAutomaticProjectImports } from '../memory/import/automatic-project-import.js';
import { startDiscoveryWatch, stopDiscoveryWatch } from '../discovery/service.js';
import { startPhoneLink, stopPhoneLink } from '../phone/service.js';
import { bindPhoneApi } from '../phone/ui-bridge.js';
import { resumePendingImports, stopLocalImports } from '../memory/import/local-import.js';
import {recoverSubscriptionProcesses,stopSubscriptionProcesses} from '../services/subscription-chat.js';
import { getOrchestrator } from '../multi-agent/orchestrator.js';
import { START_PROBLEM_EXIT, reportStartProblem } from '../db/layout.js';

const PORT = config.port;
const HOST = config.host;

// STORE-MAP-01 P3: the database opens inside buildServer; a start-up problem is reported for the desktop.
const nativeStartup=nativeProcessStartup();
const fastify = await (nativeStartup?nativeStartup.runOperation(()=>buildServer(nativeStartup.buildOptions)):buildServer()).catch((err) => { if (reportStartProblem(err)) process.exit(START_PROBLEM_EXIT); throw err; });

/** Python availability for audio features (a startup probe: skipped with background off). */
async function probePython(): Promise<string> {
  let pythonStatus = '❌ Not found';
  try {
    const { execFileSync } = await import('child_process');
    const pythonPaths = [
      `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python312\\python.exe`,
      `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python311\\python.exe`,
      'python', 'py',
    ];
    for (const p of pythonPaths) {
      try {
        const ver = execFileSync(p, ['--version'], { timeout: 2000 }).toString().trim();
        pythonStatus = `✅ ${ver}`;
        break;
      } catch { /* try next */ }
    }
  } catch { /* ignore */ }
  return pythonStatus;
}

/** BUG-03: the real resolved locations (no fixed project path). */
function storageLines(): string {
  const db = dbDriver() === 'postgres' ? 'PostgreSQL (AGENT_PLAYER_PG_URL)' : path.resolve(mainDatabasePath());
  return `  📁 Data:     ${path.resolve(dataRoot())}\n  🗄️  Database: ${db}`;
}

// Start server
async function start() {
  try {
    console.log('[Server] 🚀 Initializing backend systems...\n');

    try{await recoverSubscriptionProcesses();}catch{console.warn('[Subscription] Process recovery unavailable; unverified groups were not signalled.');}
    const summary = await (nativeStartup?nativeStartup.runOperation(()=>initializeBackend(fastify)):initializeBackend(fastify));

    // RUN-ISO ISO-1: re-check the data tree after every store was opened.
    if (process.env[ISOLATED_ENV] === '1') assertSafeIsolatedTree(path.resolve(dataRoot()));

    // Startup hooks (fastify.ready) run inside a selected operation; listen() must not: the server's
    // connection handle would carry that finished operation into every request, and the request
    // admission refuses nested operations (every request failed with MemoryCipherError on a new Mac).
    if(nativeStartup)await nativeStartup.runOperation(async()=>{await fastify.ready();});
    await fastify.listen({port:PORT,host:HOST});

    // RUN-ISO / INSTALLER-05: tell the isolated launcher or the desktop app
    // (IPC only, no secrets) that we listen, with the real port (PORT=0 = random).
    if ((process.env[ISOLATED_ENV] === '1' || process.env[LAUNCH_TOKEN_ENV]) && typeof process.send === 'function') {
      const addr = fastify.server.address();
      process.send({ type: 'listening', host: HOST, port: typeof addr === 'object' && addr ? addr.port : PORT });
    }

    if (summary.background) {
      void resumePendingImports().catch(() => console.warn('[Memory import] Saved progress unavailable; no new import started.')).finally(() => { startAutomaticProjectImports(); startDiscoveryWatch(); });
      // MEM-READ-01 MR9: night work (01:00–06:00, idle and charging) checks every 5 minutes.
      void import('../memory/night-work.js').then((m) => m.startNightWork()).catch(() => undefined);
      // TASKLOG-01: read the projects' task files and watch them for changes from the coding apps.
      void import('../services/task-file.js').then((m) => m.syncAllTasks(true)).catch(() => undefined);
      // MOB-LINK-01: the phone link dials the relay only while a phone or an open pairing needs it.
      bindPhoneApi(fastify);
      void startPhoneLink().catch(() => console.warn('[Phone] Phone link unavailable; paired phones cannot reach this computer.'));
    }

    const pythonStatus = summary.background ? await probePython() : '— (background off)';

    console.log(`
╔══════════════════════════════════════════════════════╗
║            Girru Backend v1.3.0               ║
╠══════════════════════════════════════════════════════╣
║  🌐 Frontend:  ${config.frontendUrl.padEnd(32)}║
║  ⚙️  Backend:   http://${HOST}:${PORT}${' '.repeat(Math.max(0, 32 - (HOST.length + PORT.toString().length + 10)))}║
║  📖 API Docs:  http://${HOST}:${PORT}/docs${' '.repeat(Math.max(0, 26 - (HOST.length + PORT.toString().length + 10)))}║
║  💚 Health:    http://${HOST}:${PORT}/health${' '.repeat(Math.max(0, 24 - (HOST.length + PORT.toString().length + 10)))}║
╠══════════════════════════════════════════════════════╣
║  📦 Skills:       ${String(summary.skills).padEnd(2)} loaded                        ║
║  ⏰ Jobs:         ${String(summary.jobs).padEnd(2)} ${summary.background ? 'scheduled' : 'known (background off)'}                    ║
║  🧠 Memory:       Ready                              ║
║  🔐 Credentials:  Ready                              ║
║  🌐 Gateway:      ${String(summary.channels).padEnd(2)} channels active              ║
║  🐳 Sandbox:      ${(summary.dockerAvailable ? 'Docker Ready   ' : 'Native Mode    ')}                ║
║  🛡️  Audit:        Active                             ║
║  🔒 Encryption:   Ready                              ║
║  💓 Heartbeat:    ${summary.background ? 'Monitoring' : 'Off       '}                         ║
║  🪝 Webhooks:     Ready                              ║
║  🤖 Multi-Agent:  Ready                              ║
║  🌐 Browser:      Ready                              ║
║  📦 Storage:      Ready (Cache + CDN)                ║
║  ⏱️  Agent Cron:  ${summary.background ? 'Ready' : 'Off  '}                              ║
╠══════════════════════════════════════════════════════╣
║  🎙️  Python/TTS:   ${pythonStatus.padEnd(33)}║
╚══════════════════════════════════════════════════════╝
${storageLines()}
    `);
  } catch (err) {
    fastify.log.error(err);
    // STORE-MAP-01 P3: a start-up problem the desktop's start page can explain.
    if (reportStartProblem(err)) process.exit(START_PROBLEM_EXIT);
    process.exit(1);
  }
}

let shuttingDown = false;
async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // A restart (Store add/remove, BACKUP-01 restore) must come back as a restart even when a stream
  // (an open chat, a live view) keeps a connection open: those are closed after 5 s, and a
  // stop that still runs out of time keeps the restart code, so the desktop starts Girru again
  // instead of showing "Girru could not start" (Mohamed's Store test, 2026-11-04).
  const deadline = setTimeout(() => process.exit(code === RESTART_EXIT_CODE ? code : 1), 20000);
  deadline.unref();
  const force = setTimeout(() => { try { (fastify.server as { closeAllConnections?: () => void }).closeAllConnections?.(); } catch { /* already closed */ } }, 5000);
  force.unref();
  try {
    await stopSubscriptionProcesses();
    // Closing Fastify runs channel transport shutdown hooks before process exit.
    await stopAutomaticProjectImports();
    stopDiscoveryWatch();
    await stopPhoneLink();
    await stopLocalImports();
    // MODELS-01-INSTALL: a download in progress stops; it goes on at the next start.
    await import('../memory/helper.js').then((m) => m.stopMemoryHelper()).catch(() => undefined);
    await nativeStartup?.prepareShutdown();
    await fastify.close();
    await nativeStartup?.close();
    // B2.2b-2: audit rows still being written (PostgreSQL inserts are not
    // awaited by the request) get a short, bounded chance to land.
    if (!(await flushAuditWritesWithin(SHUTDOWN_AUDIT_FLUSH_MS))) {
      console.warn(`[Server] Some audit writes did not finish within ${SHUTDOWN_AUDIT_FLUSH_MS} ms of shutdown`);
    }
    // B2.2d-15: orchestrator writes queued for PostgreSQL get the same bounded chance.
    if (!(await flushAuditWritesWithin(SHUTDOWN_AUDIT_FLUSH_MS, () => getOrchestrator().flush()))) {
      console.warn(`[Server] Some orchestrator writes did not finish within ${SHUTDOWN_AUDIT_FLUSH_MS} ms of shutdown`);
    }
    process.exit(code);
  } catch {
    process.exit(1);
  }
}
// BACKUP-01: a restore asks for a clean stop with the restart code; the desktop app starts again.
onRestartRequest(() => { void shutdown(RESTART_EXIT_CODE); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void shutdown(); });
// INSTALLER-05: the desktop app asks over IPC (Windows has no SIGTERM for a child).
if (process.env[LAUNCH_TOKEN_ENV] && typeof process.send === 'function') {
  process.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'shutdown') void shutdown();
    // MACAPP-01: the app asks for a backup before it replaces itself with a new version.
    if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'backup') {
      // STORE-MAP-01 P3 (FD4a): the folder too, so the app can ask for this backup back if the update cannot finish.
      void import('../services/backups.js').then(async ({ backUpNow, workspaceBackupsDir }) => ({ b: await backUpNow('before-update'), folder: workspaceBackupsDir() }))
        .then(({ b, folder }) => process.send?.({ type: 'backup-done', ok: b.checked, id: b.id, folder, ...(b.checked ? {} : { error: 'a part did not pass its check' }) }))
        .catch((error: unknown) => process.send?.({ type: 'backup-done', ok: false, error: error instanceof Error ? error.message.slice(0, 200) : 'failed' }));
    }
  });
  // The app is gone (crash, force quit): do not keep running without it.
  process.once('disconnect', () => { void shutdown(); });
}

start();

export default fastify;
