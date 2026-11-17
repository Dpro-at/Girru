/**
 * Defensive security-header, CORS and cookie audit for a site you own.
 *
 * Makes one ordinary GET to the site (through the same checked, address-pinned request path scans
 * use) and inspects the response headers only: the standard security headers, whether CORS is wide
 * open, whether cookies are marked Secure/HttpOnly, and whether a rate-limit header is advertised.
 * It reads what the server already returns; it sends no attack. Each check yields a structured
 * result the scan engine turns into coverage rows and, where something is missing, a finding with
 * the request/response headers as evidence.
 */

import { request } from './target.js';

// header name -> { severity, title, fixHint }  (missing = finding)
const SECURITY_HEADERS = {
  'content-security-policy': { severity: 'medium', title: 'No Content-Security-Policy', fixHint: "Add a Content-Security-Policy, e.g. default-src 'self'." },
  'x-content-type-options': { severity: 'low', title: 'No X-Content-Type-Options', fixHint: 'Add X-Content-Type-Options: nosniff.' },
  'x-frame-options': { severity: 'medium', title: 'No clickjacking protection', fixHint: 'Add X-Frame-Options: SAMEORIGIN (or a frame-ancestors CSP).' },
  'strict-transport-security': { severity: 'medium', title: 'No HSTS', fixHint: 'Add Strict-Transport-Security: max-age=31536000; includeSubDomains (HTTPS only).' },
  'referrer-policy': { severity: 'low', title: 'No Referrer-Policy', fixHint: 'Add Referrer-Policy: strict-origin-when-cross-origin.' },
  'permissions-policy': { severity: 'low', title: 'No Permissions-Policy', fixHint: 'Add Permissions-Policy to turn off features you do not use.' },
};

function headerText(headers) {
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');
}

/**
 * Audit a site's response headers. Returns { url, status, checks: [{ id, checkKind, ok, severity,
 * title, detail, fixHint }], requestEvidence, responseEvidence }. Does not throw for HTTP errors.
 */
export async function auditHeaders(url, { allowPrivate = false } = {}) {
  const checks = [];
  let res;
  const reqLine = `GET ${url}`;
  try {
    res = await request(url, { allowPrivate, headers: { 'User-Agent': 'Girru-Security/2 (+defensive header audit)' }, redirects: 2 });
  } catch (err) {
    return { url, status: 0, error: err.message, checks: [{ id: 'reach', checkKind: 'reach', ok: false, severity: 'info', title: 'Site could not be reached', detail: err.message }], requestEvidence: reqLine, responseEvidence: null };
  }

  const h = res.headers || {};
  const responseHead = `HTTP ${res.status}\n${headerText(h)}`;

  for (const [name, meta] of Object.entries(SECURITY_HEADERS)) {
    const present = !!h[name];
    checks.push({
      id: `header:${name}`, checkKind: `header:${name}`, ok: present,
      severity: meta.severity, title: meta.title,
      detail: present ? `Present: ${String(h[name]).slice(0, 120)}` : 'Header not set',
      fixHint: present ? null : meta.fixHint,
    });
  }

  // CORS wide open
  const acao = h['access-control-allow-origin'];
  checks.push({
    id: 'cors', checkKind: 'cors', ok: acao !== '*',
    severity: 'high', title: 'CORS allows any origin',
    detail: acao === '*' ? 'Access-Control-Allow-Origin: *' : `Access-Control-Allow-Origin: ${acao || '(not set)'}`,
    fixHint: acao === '*' ? 'Restrict Access-Control-Allow-Origin to the origins you trust instead of *.' : null,
  });

  // Cookie flags
  const setCookie = h['set-cookie'] || '';
  if (setCookie) {
    const insecure = !/;\s*secure/i.test(setCookie) || !/;\s*httponly/i.test(setCookie);
    checks.push({
      id: 'cookie-flags', checkKind: 'cookie-flags', ok: !insecure,
      severity: 'medium', title: 'Cookie missing Secure/HttpOnly',
      detail: `Set-Cookie: ${String(setCookie).slice(0, 120)}`,
      fixHint: insecure ? 'Mark session cookies Secure and HttpOnly (and SameSite).' : null,
    });
  }

  // Rate-limit advertised (observation, not a test)
  const hasRateLimit = !!(h['ratelimit-limit'] || h['x-ratelimit-limit'] || h['retry-after']);
  checks.push({
    id: 'rate-limit', checkKind: 'rate-limit', ok: hasRateLimit, severity: 'low',
    title: 'No rate-limit headers advertised',
    detail: hasRateLimit ? 'Rate-limit headers present' : 'No RateLimit-* header seen on this response',
    fixHint: hasRateLimit ? null : 'Consider advertising RateLimit-* headers so clients can back off.',
  });

  return { url, status: res.status, checks, requestEvidence: reqLine, responseEvidence: responseHead };
}
