'use strict';

const { createApplicationServer } = require('../../packages/core-ui/scripts/application-server.cjs');
const { newLaunchToken, startBackend } = require('../../packages/desktop/src/backend-process.cjs');
const { Index } = require('/app/packages/backend/node_modules/usearch');
const Database = require('/app/packages/backend/node_modules/better-sqlite3');

const origin = 'http://127.0.0.1:41522';
const controller = new AbortController();
let backend;
let bridge;

async function main() {
  // Exercise the native bindings on this architecture before advertising readiness.
  const db = new Database(':memory:');
  db.prepare('SELECT 1').get();
  db.close();
  new Index({ dimensions: 2, metric: 'cos', quantization: 'f32' });
  console.log('Loaded better-sqlite3 and usearch.');

  const token = newLaunchToken();
  backend = await startBackend({
    node: process.execPath,
    args: ['--import', 'tsx', 'src/api/server.ts'],
    cwd: '/app/packages/backend',
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', ALLOWED_ORIGINS: origin,
      NEXT_PUBLIC_APP_URL: origin, AGENT_PLAYER_LAUNCH_TOKEN: token },
    memoryControlBootstrap: () => ({ control: null, selection: { selected: false, profileId: null, mode: 'none' } }),
    signal: controller.signal,
    secrets: [process.env.JWT_SECRET, process.env.ENCRYPTION_KEY],
    onLog: line => console.log(line),
    onExit: ({ code }) => { stop(code || 1); },
  });
  bridge = createApplicationServer({
    channel: 'candidate', upstreamPort: backend.port, launchToken: token,
    storeAppsDataDir: process.env.AGENT_PLAYER_DATA_DIR,
    healthCheck: async () => {
      const reply = await fetch(`http://127.0.0.1:${backend.port}/health`, {
        headers: { 'x-agent-player-launch': token }, signal: AbortSignal.timeout(3000),
      });
      return reply.ok && (await reply.json()).status === 'ok';
    },
  });
  await new Promise((resolve, reject) => {
    bridge.once('error', reject);
    bridge.listen(41522, '0.0.0.0', resolve);
  });
  console.log(`Girru is ready at ${origin}`);
}

let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  controller.abort();
  if (bridge) {
    bridge.close();
    bridge.closeAllConnections();
  }
  try { await backend?.stop(); } finally { process.exit(code); }
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop(0));
main().catch(error => { console.error(error.message); void stop(1); });
