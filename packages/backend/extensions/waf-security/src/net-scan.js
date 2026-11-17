/**
 * Defensive TCP port inventory and service/banner detection.
 *
 * For a server you own and have put in scope, this opens a plain TCP connection to a small set of
 * common ports, notes which accept a connection, and reads the first bytes the service offers (its
 * banner) to guess the service and version. It never sends an attack, never logs in, and never
 * sends more than a tiny, protocol-polite nudge (a bare HTTP HEAD for web ports). Addresses are
 * resolved and checked the same way scans are: non-public addresses are refused unless the owner
 * allowed private targets. Pacing and concurrency come from the noise governor.
 */

import net from 'node:net';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isNonPublicAddress, TargetError } from './target.js';

// A short, sensible default set — the services that matter for a server's exposure.
export const COMMON_PORTS = [
  { port: 21, service: 'ftp' }, { port: 22, service: 'ssh' }, { port: 25, service: 'smtp' },
  { port: 53, service: 'dns' }, { port: 80, service: 'http' }, { port: 110, service: 'pop3' },
  { port: 143, service: 'imap' }, { port: 443, service: 'https' }, { port: 465, service: 'smtps' },
  { port: 587, service: 'submission' }, { port: 993, service: 'imaps' }, { port: 995, service: 'pop3s' },
  { port: 3306, service: 'mysql' }, { port: 3389, service: 'rdp' }, { port: 5432, service: 'postgresql' },
  { port: 6379, service: 'redis' }, { port: 8080, service: 'http-alt' }, { port: 8443, service: 'https-alt' },
  { port: 9200, service: 'elasticsearch' }, { port: 27017, service: 'mongodb' },
];

const BANNER_BYTES = 512;
const WEB_PORTS = new Set([80, 8080, 443, 8443]);

/** Resolve a host to one address and refuse non-public ones unless allowed. Returns { address, family }. */
export async function resolveHost(host, { allowPrivate = false } = {}) {
  const h = String(host).replace(/^\[|\]$/g, '');
  let answers;
  if (isIP(h)) answers = [{ address: h, family: isIP(h) }];
  else {
    try {
      answers = (await dnsLookup(h, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));
    } catch { throw new TargetError(`${h} could not be found`); }
    if (!answers.length) throw new TargetError(`${h} could not be found`);
  }
  if (!allowPrivate && answers.some((a) => isNonPublicAddress(a.address))) {
    throw new TargetError(`${h} is a local or private network address; the owner can allow those in the app's settings`);
  }
  return answers[0];
}

/** Try one port: connect, optionally nudge, read the banner. Resolves { port, open, banner, service }. */
function probePort(address, family, port, service, { connectTimeoutMs = 3000, bannerTimeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const out = { port, service, open: false, banner: null };
    const socket = new net.Socket();
    let settled = false;
    const finish = () => { if (settled) return; settled = true; try { socket.destroy(); } catch {} resolve(out); };
    socket.setTimeout(connectTimeoutMs);
    socket.once('timeout', finish);
    socket.once('error', finish);
    socket.connect({ host: address, port, family }, () => {
      out.open = true;
      // A bare, polite nudge for web ports so the server answers; nothing else is ever sent.
      if (WEB_PORTS.has(port)) { try { socket.write('HEAD / HTTP/1.0\r\n\r\n'); } catch {} }
      let buf = Buffer.alloc(0);
      socket.setTimeout(bannerTimeoutMs);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= BANNER_BYTES) { out.banner = buf.slice(0, BANNER_BYTES).toString('latin1').trim(); finish(); }
      });
      socket.once('timeout', () => { out.banner = buf.length ? buf.toString('latin1').trim() : null; finish(); });
      socket.once('end', () => { out.banner = buf.length ? buf.toString('latin1').trim() : null; finish(); });
    });
  });
}

/** Rough service/version guess from a banner line. Informational only. */
export function describeService(service, banner) {
  if (!banner) return { service, product: null, version: null, summary: `${service} (open, no banner)` };
  const first = banner.split(/\r?\n/)[0].slice(0, 200);
  const serverHdr = /^server:\s*(.+)$/im.exec(banner);
  const product = serverHdr ? serverHdr[1].trim() : first;
  const version = (/[\/ ]v?(\d+\.\d+(?:\.\d+)?)/.exec(product) || [])[1] || null;
  return { service, product: product || null, version, summary: `${service}: ${product || first}`.slice(0, 200) };
}

/**
 * Scan a host's common ports. `governor` is a NoiseGovernor; concurrency and pacing come from it.
 * Returns { host, address, open: [{port, service, banner, product, version, summary}], checked: [ports] }.
 */
export async function scanPorts(host, { allowPrivate = false, ports = COMMON_PORTS, governor = null } = {}) {
  const { address, family } = await resolveHost(host, { allowPrivate });
  const concurrency = governor ? governor.portConcurrency() : 8;
  const open = [];
  const queue = [...ports];

  async function worker() {
    while (queue.length) {
      const { port, service } = queue.shift();
      if (governor) await governor.pace(address);
      let res;
      try { res = await probePort(address, family, port, service); }
      catch { res = { port, service, open: false, banner: null }; }
      if (governor) governor.note(address, { errored: false });
      if (res.open) open.push({ ...res, ...describeService(service, res.banner) });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  open.sort((a, b) => a.port - b.port);
  return { host, address, open, checked: ports.map((p) => p.port) };
}
