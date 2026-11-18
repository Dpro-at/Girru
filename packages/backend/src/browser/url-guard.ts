/**
 * BROWSER-01: what the headless browser may load.
 *
 * The browser tools take URLs from the model (and pages they open link to
 * further URLs), so without a guard an agent or a prompt-injected page could
 * make the browser load 127.0.0.1 services, the private network or cloud
 * metadata addresses. Allowed:
 *   - http(s) whose host is, or resolves only to, public addresses (the same
 *     blocked list as services/net/safe-fetch.ts);
 *   - data:, about: and blob: (no network).
 * Everything else (file:, ftp:, chrome:, ws: …) is refused.
 *
 * guardPage() applies it to every request of a page (navigations, redirects,
 * sub-resources, iframes; tested). The controller also guards new targets
 * (pop-ups / new tabs) when Puppeteer reports them; that path is not covered
 * by a test (headless Chrome did not load a pop-up's URL in a probe).
 * Limits: DNS is checked here and resolved again by Chrome (a rebinding
 * window remains); WebSocket connections are not seen by request
 * interception.
 */

import { isIP } from 'node:net';
import { isBlockedAddress, resolvePublicAddress, type LookupFn } from '../services/net/safe-fetch.js';

export type UrlVerdict = { ok: true } | { ok: false; reason: string };

const NO_NETWORK_SCHEMES = new Set(['data:', 'about:', 'blob:']);
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; verdict: UrlVerdict }>();

/** Whether the browser may load `raw`. Never throws. */
export async function checkBrowserUrl(raw: string, lookup?: LookupFn): Promise<UrlVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  if (NO_NETWORK_SCHEMES.has(url.protocol)) return { ok: true };
  return checkPublicHttpUrl(raw, lookup);
}

/**
 * SEC-NET-01: whether a server-side request may go to `raw`: http(s) to a
 * public address only (no data:/about: either). Used by the web_fetch tool.
 * Never throws.
 */
export async function checkPublicHttpUrl(raw: string, lookup?: LookupFn): Promise<UrlVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: `scheme ${url.protocol} is not allowed` };
  if (url.username || url.password) return { ok: false, reason: 'credentials in the URL are not allowed' };

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  // Loopback by name, whatever a resolver answers.
  if (host === 'localhost' || host.endsWith('.localhost')) return { ok: false, reason: `host ${host} is loopback` };
  if (isIP(host)) {
    return isBlockedAddress(host) ? { ok: false, reason: `address ${host} is not public` } : { ok: true };
  }
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.verdict;
  let verdict: UrlVerdict;
  try {
    await resolvePublicAddress(host, lookup);
    verdict = { ok: true };
  } catch (err: any) {
    verdict = { ok: false, reason: err?.code === 'blocked_address' ? `host ${host} resolves to a non-public address` : `host ${host} could not be resolved` };
  }
  if (!lookup) cache.set(host, { at: Date.now(), verdict });
  return verdict;
}

/**
 * Check every request of a (Puppeteer) page. A refused request is aborted
 * ('blockedbyclient') and reported to `onBlocked`.
 */
const guarded = new WeakSet<object>();

export async function guardPage(page: any, onBlocked?: (url: string, reason: string) => void,isActive:()=>boolean=()=>true): Promise<void> {
  // Once per page (the first page also shows up as a new target).
  if (guarded.has(page)) return;
  guarded.add(page);
  await page.setRequestInterception(true);
  page.on('request', async (request: any) => {
    if (request.isInterceptResolutionHandled?.()) return;
    const url = String(request.url());
    const verdict = isActive()?await checkBrowserUrl(url):{ok:false as const,reason:'app_not_enabled'};
    try {
      if (verdict.ok&&isActive()) await request.continue();
      else {
        onBlocked?.(url, verdict.ok?'app_not_enabled':verdict.reason);
        await request.abort('blockedbyclient');
      }
    } catch {
      // The request was already handled or the page closed.
    }
  });
}

/** Test hook: forget cached host verdicts. */
export function clearBrowserUrlCache(): void {
  cache.clear();
}
