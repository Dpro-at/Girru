// Preload for the memory-encryption backend tests (`node --import <this file> --test ...`).
// Those tests refuse to run unless every default points into an explicit, private, synthetic
// test root (test/fixtures/memory-encryption-drivers.mjs). This makes that root under the
// system temp folder — never the real data — and removes it when the process ends.
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'girru-enc-final-'));
chmodSync(root, 0o700);
writeFileSync(join(root, '.girru-enc-test-root.json'), JSON.stringify({ version: 1, synthetic: true, nonce: randomBytes(16).toString('hex') }), { mode: 0o600 });
const home = join(root, 'home'), data = join(root, 'data');
mkdirSync(home, { mode: 0o700 }); mkdirSync(data, { mode: 0o700 });
process.env.NODE_ENV = 'test';
process.env.DPRO_ENC_TEST_ROOT = root;
process.env.HOME = home;
process.env.AGENT_PLAYER_DATA_DIR = data;
process.env.DATABASE_PATH = join(data, 'agent-player.db');
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } });
