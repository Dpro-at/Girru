#!/usr/bin/env node
/**
 * Girru server sensor — REFERENCE implementation (our own code, Node built-ins only).
 *
 * Runs on a server you own. Outbound-only: it POSTs alerts to Girru and never listens or accepts a
 * connection, so Girru can never reach back into this machine. It observes a few local signals and
 * reports changes. It changes nothing on the server. See SENSOR.md for the protocol.
 *
 * This is a reference template to adapt, not a packaged install. Configure with env vars:
 *   GIRRU_URL           e.g. https://my-girru.example
 *   GIRRU_SENSOR_TOKEN  the gss_… token shown once when you paired the sensor
 *   SENSOR_WATCH_CERT   optional host:port to check a certificate for (e.g. example.com:443)
 *   SENSOR_WATCH_FILES  optional comma-separated config files to watch for drift
 *   SENSOR_INTERVAL_MS  loop interval (default 300000 = 5 min)
 *
 * Run:  GIRRU_URL=… GIRRU_SENSOR_TOKEN=… node girru-sensor.mjs
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import tls from 'node:tls';

const URL_BASE = process.env.GIRRU_URL;
const TOKEN = process.env.GIRRU_SENSOR_TOKEN;
const INTERVAL = Number(process.env.SENSOR_INTERVAL_MS || 300_000);
if (!URL_BASE || !TOKEN) { console.error('Set GIRRU_URL and GIRRU_SENSOR_TOKEN'); process.exit(1); }

const state = { ports: null, fileHashes: {} };

/** Push one alert to Girru. Outbound only; failures are retried next loop, never fatal. */
async function push(body) {
  try {
    const res = await fetch(`${URL_BASE}/api/ext/waf-security/sensor/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error('push rejected', res.status);
  } catch (err) { console.error('push failed (will retry):', err.message); }
}

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 8000 }, (e, out) => resolve(e ? '' : String(out))));

/** Listening TCP ports, best-effort across platforms. Returns a sorted array of numbers. */
async function listeningPorts() {
  let text = await run('ss', ['-ltn']);
  if (!text) text = await run('netstat', ['-ltn']);
  const ports = new Set();
  for (const m of text.matchAll(/[:.](\d{1,5})\s/g)) { const p = Number(m[1]); if (p > 0 && p < 65536) ports.add(p); }
  return [...ports].sort((a, b) => a - b);
}

/** Days until the certificate at host:port expires (null if it cannot be read). Observation only. */
function certDaysLeft(host, port) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 8000 }, () => {
      const c = s.getPeerCertificate(); s.end();
      resolve(c && c.valid_to ? Math.floor((new Date(c.valid_to).getTime() - Date.now()) / 86_400_000) : null);
    });
    s.once('error', () => resolve(null));
    s.once('timeout', () => { s.destroy(); resolve(null); });
  });
}

async function tick() {
  // 1. Open-port / new-listener changes.
  const ports = await listeningPorts();
  if (state.ports && ports.join(',') !== state.ports.join(',')) {
    const added = ports.filter((p) => !state.ports.includes(p));
    const removed = state.ports.filter((p) => !ports.includes(p));
    await push({ kind: added.length ? 'new-listener' : 'open-port-change', severity: added.length ? 'medium' : 'low',
      title: `Listening ports changed (${added.length} new, ${removed.length} gone)`, detail: { added, removed, now: ports } });
  }
  state.ports = ports;

  // 2. Certificate expiry.
  if (process.env.SENSOR_WATCH_CERT) {
    const [host, port] = process.env.SENSOR_WATCH_CERT.split(':');
    const days = await certDaysLeft(host, Number(port) || 443);
    if (days !== null && days <= 30) await push({ kind: 'cert-expiry', severity: days <= 7 ? 'high' : 'medium', title: `Certificate for ${host} expires in ${days} day(s)`, detail: { host, days } });
  }

  // 3. Config drift.
  for (const file of (process.env.SENSOR_WATCH_FILES || '').split(',').map((f) => f.trim()).filter(Boolean)) {
    try {
      const h = createHash('sha256').update(await readFile(file)).digest('hex');
      if (state.fileHashes[file] && state.fileHashes[file] !== h) await push({ kind: 'config-drift', severity: 'medium', title: `Config changed: ${file}`, detail: { file, from: state.fileHashes[file].slice(0, 12), to: h.slice(0, 12) } });
      state.fileHashes[file] = h;
    } catch { /* unreadable file: skip */ }
  }

  // 4. Heartbeat.
  await push({ kind: 'heartbeat', title: 'alive' });
}

console.log(`Girru sensor started → ${URL_BASE} (every ${INTERVAL} ms). Outbound-only.`);
await tick();
setInterval(tick, INTERVAL);
