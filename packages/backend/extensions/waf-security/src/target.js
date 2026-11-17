/**
 * The sites a scan may reach, and the one way it reaches them.
 *
 * A scan sends test requests to an address someone typed (or an agent passed), so it must not
 * become a way into the owner's own network: by default it refuses loopback, private, link-local
 * (cloud metadata), carrier-grade NAT, multicast and other non-public addresses. The owner can
 * allow them in the app's settings, for testing a site on their own network.
 *
 * Every request: http or https only, no user:password in the address, the host's DNS answers all
 * checked (one non-public answer refuses it), and the connection pinned to the checked address so
 * a second DNS answer cannot swap in another one. Redirects are not followed unless asked, and each
 * hop is checked the same way. Bodies are read up to 1 MB.
 */

import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';

export class TargetError extends Error {}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 96], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) blocked.addSubnet(net, prefix, 'ipv6');

/** True for an address a scan may not reach unless the owner allowed private targets (or not an IP at all). */
export function isNonPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    let canonical = '';
    try { canonical = new URL(`http://[${address}]/`).hostname.toLowerCase(); } catch { return true; }
    if (canonical.startsWith('[::ffff:')) return true; // IPv4-mapped, any spelling
    return blocked.check(address, 'ipv6');
  }
  return true;
}

/** The parsed address of a site to test, or a TargetError. No DNS here. */
export function parseTarget(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) throw new TargetError('Enter the address of a site, starting with http:// or https://');
  let url;
  try { url = new URL(raw.trim()); } catch { throw new TargetError('Enter the address of a site, starting with http:// or https://'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TargetError('Only http:// and https:// addresses can be tested');
  if (url.username || url.password) throw new TargetError('An address with a user name or password in it cannot be tested');
  return url;
}

const defaultLookup = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));

/** The address to connect to: every DNS answer checked. */
async function resolveTarget(url, allowPrivate, lookup) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let answers;
  if (isIP(host)) answers = [{ address: host, family: isIP(host) }];
  else {
    try { answers = await lookup(host); } catch { throw new TargetError(`${host} could not be found`); }
    if (!answers.length) throw new TargetError(`${host} could not be found`);
  }
  if (!allowPrivate && answers.some((a) => isNonPublicAddress(a.address))) {
    throw new TargetError(`${host} is a local or private network address; the owner can allow those in the app's settings`);
  }
  return answers[0];
}

/** Checks a target before a scan starts (the same check runs again at every request). */
export async function checkTarget(raw, { allowPrivate = false, lookup = defaultLookup } = {}) {
  const url = parseTarget(raw);
  await resolveTarget(url, allowPrivate, lookup);
  return url.toString();
}

const MAX_BYTES = 1024 * 1024;

/**
 * One request to a checked, pinned address. Resolves { status, headers, body } (body as text,
 * at most 1 MB); follows up to `redirects` redirects, each one checked again.
 */
export async function request(raw, { allowPrivate = false, headers = {}, timeoutMs = 20_000, redirects = 0, lookup = defaultLookup } = {}) {
  let url = parseTarget(raw);
  for (let hop = 0; ; hop++) {
    const { address, family } = await resolveTarget(url, allowPrivate, lookup);
    const res = await send(url, address, family, headers, timeoutMs);
    const location = res.headers.location;
    if (hop < redirects && [301, 302, 303, 307, 308].includes(res.status) && location) {
      url = parseTarget(new URL(location, url).toString());
      continue;
    }
    return res;
  }
}

function send(url, address, family, headers, timeoutMs) {
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || undefined,
      path: url.pathname + url.search,
      method: 'GET',
      headers,
      timeout: timeoutMs,
      // Pinned to the checked address: no second DNS lookup.
      lookup: (_host, opts, cb) => (opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) { res.destroy(); return; }
        chunks.push(chunk);
      });
      const done = () => {
        const out = {};
        for (const [k, v] of Object.entries(res.headers)) out[k] = Array.isArray(v) ? v.join(', ') : v;
        resolve({ status: res.statusCode || 0, headers: out, body: Buffer.concat(chunks).toString('utf8') });
      };
      res.on('end', done);
      res.on('close', done); // also after a body cut at 1 MB
      res.on('error', reject);
    });
    req.on('timeout', () => { const e = new Error(`Request timeout after ${timeoutMs}ms`); e.name = 'AbortError'; req.destroy(e); });
    req.on('error', reject);
    req.end();
  });
}
