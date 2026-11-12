'use strict';
const fs = require('node:fs');
const { clientIdOk } = require('./device-google.cjs');
function validateInstalledClient(value, expectedClientId) {
  const installed = value?.installed;
  if (!installed || !clientIdOk(installed.client_id) || installed.client_id !== expectedClientId ||
      typeof installed.client_secret !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(installed.client_secret) ||
      installed.auth_uri !== 'https://accounts.google.com/o/oauth2/auth' ||
      installed.token_uri !== 'https://oauth2.googleapis.com/token') throw Error('device_google_installed_client_invalid');
  return { clientId: installed.client_id, clientSecret: installed.client_secret };
}
async function readInstalledClient(file, expectedClientId) {
  // Windows has no O_NOFOLLOW: a link is refused by looking at the name first, and the opened file must be that same file.
  const named = await fs.promises.lstat(file);
  if (named.isSymbolicLink() || !named.isFile()) throw Error('device_google_installed_client_invalid');
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16384 || stat.ino !== named.ino || stat.dev !== named.dev) throw Error('device_google_installed_client_invalid');
    const bytes = Buffer.alloc(16385);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > 16384) throw Error('device_google_installed_client_invalid');
    return validateInstalledClient(JSON.parse(bytes.subarray(0, size).toString('utf8')), expectedClientId);
  } catch { throw Error('device_google_installed_client_invalid'); }
  finally { await handle.close(); }
}
/**
 * The Dpro account service finishes Google sign-in with the secret it keeps (POST <origin>/google/token),
 * so no computer needs a Google client file. Only the one-time code, the PKCE verifier and the loopback
 * redirect are sent; only the ID token comes back, and it is still verified here.
 */
function serverGoogleExchange(origin, fetcher = fetch) {
  let base;
  try { base = new URL(origin); } catch { return null; }
  if (!(base.protocol === 'https:' || base.protocol === 'http:' && base.hostname === '127.0.0.1') || base.search || base.hash) return null;
  const url = base.href.replace(/\/$/, '') + '/google/token';
  const post = async body => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const r = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: controller.signal });
      const text = await r.text();
      if (text.length > 32768) throw Error('device_google_server_exchange_refused');
      return { status: r.status, body: JSON.parse(text) };
    } finally { clearTimeout(timer); }
  };
  return {
    /** An empty request tells a configured service (input refused) from one without the secret or an older one. */
    async available() { try { const r = await post({}); return r.status === 403 && r.body?.code === 'account_input_invalid'; } catch { return false; } },
    async exchange(input) {
      const r = await post(input);
      if (r.status !== 200 || Object.keys(r.body ?? {}).join() !== 'idToken' || typeof r.body.idToken !== 'string' || r.body.idToken.length > 20000) throw Error('device_google_server_exchange_refused');
      return r.body.idToken;
    },
  };
}
function protectedGoogleLogin({ custody, login, selectInstalledClient, server = null }) {
  return async options => {
    const checkActive = () => { if (options.signal?.aborted) throw Error('device_google_login_cancelled'); };
    checkActive();
    let config = await custody.read(s => s.googleInstalledClient);
    if (!config || config.clientId !== options.clientId) {
      if (server && await server.available()) { checkActive(); return login({ ...options, exchange: server.exchange }); }
      if (!selectInstalledClient) return login(options);
      const selected = await selectInstalledClient(options.clientId);
      if (!selected) throw Error('device_google_configuration_cancelled');
      config = validateInstalledClient({ installed: { client_id: selected.clientId, client_secret: selected.clientSecret,
        auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token' } }, options.clientId);
      checkActive();
      await custody.transact(s => { s.googleInstalledClient = config; }, checkActive);
    }
    checkActive();
    return login({ ...options, clientSecret: config.clientSecret });
  };
}
module.exports = { validateInstalledClient, readInstalledClient, protectedGoogleLogin, serverGoogleExchange };
