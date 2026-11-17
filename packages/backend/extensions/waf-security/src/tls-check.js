/**
 * Defensive TLS / certificate check.
 *
 * For a server or site you own, this opens a TLS connection (no request body, no login) and reads
 * back the certificate and the negotiated protocol and cipher. It reports: days until the
 * certificate expires, whether the chain is trusted, whether the name matches, and whether the
 * negotiated protocol or cipher is weak (old TLS, known-weak cipher families). It never attacks the
 * server and never downgrades it on purpose; it simply observes what the server offers. Non-public
 * addresses are refused unless the owner allowed private targets.
 */

import tls from 'node:tls';
import { resolveHost } from './net-scan.js';

const WEAK_PROTOCOLS = new Set(['SSLv2', 'SSLv3', 'TLSv1', 'TLSv1.1']);
const WEAK_CIPHER_HINTS = [/RC4/i, /_DES_/i, /3DES/i, /\bMD5\b/i, /\bNULL\b/i, /EXPORT/i, /\bCBC\b.*SHA\b/i];

/** Days from now until `date` (negative if already past). */
function daysUntil(date) {
  const ms = new Date(date).getTime() - Date.now();
  return Math.floor(ms / 86_400_000);
}

/**
 * Check TLS for host:port (default 443). Resolves a summary object; never throws for an ordinary TLS
 * problem (it reports it) — only resolution/scope errors propagate.
 */
export async function checkTls(host, { port = 443, allowPrivate = false, timeoutMs = 8000 } = {}) {
  const { address, family } = await resolveHost(host, { allowPrivate });
  return new Promise((resolve) => {
    const result = {
      host, port, connected: false, protocol: null, cipher: null,
      authorized: false, authorizationError: null, issues: [],
      subject: null, issuer: null, validFrom: null, validTo: null, daysToExpiry: null,
    };
    const socket = tls.connect({
      host: address, port, family, servername: host,
      // We WANT to see an untrusted chain rather than fail the socket, so the report can say so.
      rejectUnauthorized: false, timeout: timeoutMs,
    }, () => {
      result.connected = true;
      result.protocol = socket.getProtocol();
      const cipher = socket.getCipher();
      result.cipher = cipher ? cipher.name : null;
      result.authorized = socket.authorized;
      result.authorizationError = socket.authorized ? null : String(socket.authorizationError || 'untrusted');
      const cert = socket.getPeerCertificate();
      if (cert && Object.keys(cert).length) {
        result.subject = cert.subject && cert.subject.CN ? cert.subject.CN : null;
        result.issuer = cert.issuer && cert.issuer.O ? cert.issuer.O : (cert.issuer && cert.issuer.CN) || null;
        result.validFrom = cert.valid_from || null;
        result.validTo = cert.valid_to || null;
        result.daysToExpiry = cert.valid_to ? daysUntil(cert.valid_to) : null;
      }
      // Grade it.
      if (result.daysToExpiry !== null) {
        if (result.daysToExpiry < 0) result.issues.push({ severity: 'critical', text: 'Certificate has expired' });
        else if (result.daysToExpiry <= 14) result.issues.push({ severity: 'high', text: `Certificate expires in ${result.daysToExpiry} day(s)` });
        else if (result.daysToExpiry <= 30) result.issues.push({ severity: 'medium', text: `Certificate expires in ${result.daysToExpiry} day(s)` });
      }
      if (!result.authorized) result.issues.push({ severity: 'high', text: `Certificate chain not trusted (${result.authorizationError})` });
      if (result.protocol && WEAK_PROTOCOLS.has(result.protocol)) result.issues.push({ severity: 'high', text: `Weak TLS protocol offered: ${result.protocol}` });
      if (result.cipher && WEAK_CIPHER_HINTS.some((re) => re.test(result.cipher))) result.issues.push({ severity: 'medium', text: `Weak cipher negotiated: ${result.cipher}` });
      try { socket.end(); } catch {}
      resolve(result);
    });
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => { try { socket.destroy(); } catch {} result.issues.push({ severity: 'info', text: 'TLS connection timed out' }); resolve(result); });
    socket.once('error', (err) => { result.issues.push({ severity: 'info', text: `TLS connection failed: ${err.message}` }); resolve(result); });
  });
}
