'use strict';

// Run interactively with docker compose exec. The private first-run link never enters service logs.
const { issueSetupCode } = require('../../packages/desktop/src/setup-code.cjs');
async function main() {
  const origin = 'http://127.0.0.1:41522';
  const response = await fetch(origin + '/api/setup/status', { mode: 'same-origin', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error('Start Girru and wait for the health check first.');
  const state = await response.json();
  if (state.setupComplete === true) { console.log(origin); return; }
  if (state.setupComplete !== false) throw Error('Cannot determine owner setup status.');
  const code = issueSetupCode(process.env.AGENT_PLAYER_DATA_DIR);
  console.log(code ? `${origin}/#setup=${code}` : origin);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
