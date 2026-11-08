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
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16384) throw Error('device_google_installed_client_invalid');
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
function protectedGoogleLogin({ custody, login, selectInstalledClient }) {
  return async options => {
    const checkActive = () => { if (options.signal?.aborted) throw Error('device_google_login_cancelled'); };
    checkActive();
    let config = await custody.read(s => s.googleInstalledClient);
    if (!config || config.clientId !== options.clientId) {
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
module.exports = { validateInstalledClient, readInstalledClient, protectedGoogleLogin };
