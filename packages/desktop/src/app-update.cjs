'use strict';
/**
 * Updates of the installed app (MACAPP-01, board MacApp1 › About and updates).
 *
 * Once a day the app asks GitHub for the latest published Girru release. It never
 * updates by itself: the owner presses "Back up and update", and then
 *   1. the release zip for this Mac is downloaded and checked against the release's
 *      SHA256SUMS file (both from github.com/Dpro-at/Girru only);
 *   2. the running program makes a "before update" backup (Settings › Backups);
 *   3. the new Girru.app is unpacked (ditto) and checked (same app id, the new version);
 *   4. it replaces the running app (the old one is kept beside it until the next start)
 *      and Girru starts again.
 * Windows (WIN-UPD-01): the release's installer (.exe) is downloaded and checked the
 * same way, the same backup is made, then Girru closes and the installer runs silently
 * into the same place and starts Girru again. Linux shows the release page.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');

const REPO = 'Dpro-at/Girru';
const APP_ID = 'app.dpro.desktop';
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const REDIRECT_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const DAY = 86_400_000;
const MAX_ZIP = 1024 * 1024 * 1024;

function platformId(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (platform === 'win32') return 'win-x64';
  return 'linux-x64';
}

/** 1.4.0 > 1.3.2; anything that is not x.y.z is never newer. */
function newer(a, b) {
  const p = v => /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).replace(/^v/, ''));
  const x = p(a), y = p(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
  return false;
}

/** What the page shows from GitHub's latest-release answer (pure; the tests feed it). */
function readRelease(body, current, platform = platformId()) {
  if (!body || typeof body !== 'object' || body.draft || body.prerelease) return { available: false };
  const version = String(body.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) return { available: false };
  const assets = Array.isArray(body.assets) ? body.assets : [];
  const url = name => { const a = assets.find(x => x && x.name === name); return a && typeof a.browser_download_url === 'string' && a.browser_download_url.startsWith(DOWNLOAD_PREFIX) ? a.browser_download_url : null; };
  // macOS: the app in a zip; Windows: the installer.
  const zipName = `Girru-${version}-${platform}.${platform.startsWith('win-') ? 'exe' : 'zip'}`;
  return {
    available: newer(version, current),
    version,
    publishedAt: typeof body.published_at === 'string' ? body.published_at : null,
    notes: typeof body.body === 'string' ? body.body.slice(0, 4000) : '',
    page: typeof body.html_url === 'string' && body.html_url.startsWith(`https://github.com/${REPO}/releases/`) ? body.html_url : `https://github.com/${REPO}/releases`,
    zipName,
    zip: url(zipName),
    sums: url(`SHA256SUMS-${platform}.txt`),
  };
}

/** GET over https, following GitHub's download redirects only to its own hosts. */
function get(url, { json = false, file = null, maxBytes = MAX_ZIP, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('Bad address')); }
    if (u.protocol !== 'https:' || !(REDIRECT_HOSTS.has(u.hostname) || u.hostname === 'api.github.com')) return reject(new Error('Refused address'));
    const req = https.get(u, { headers: { 'User-Agent': 'Girru-desktop', Accept: json ? 'application/vnd.github+json' : 'application/octet-stream' }, timeout: 30_000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(new URL(res.headers.location, u).href, { json, file, maxBytes, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GitHub answered ${res.statusCode}`)); }
      let size = 0;
      const hash = createHash('sha256');
      const chunks = [];
      const out = file ? fs.createWriteStream(file, { mode: 0o600 }) : null;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { req.destroy(new Error('Too large')); return; }
        hash.update(chunk);
        if (out) out.write(chunk); else chunks.push(chunk);
      });
      res.on('end', () => {
        const done = () => {
          if (!file) {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!json) return resolve(text);
            try { resolve(JSON.parse(text)); } catch { reject(new Error('GitHub sent something unexpected')); }
            return;
          }
          resolve(hash.digest('hex'));
        };
        if (out) out.end(done); else done();
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('GitHub did not answer in time')));
    req.on('error', reject);
  });
}

/** The checksum the release lists for one file name. */
function sumFor(text, name) {
  for (const line of String(text).split('\n')) {
    const m = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m && m[2] === name) return m[1];
  }
  return null;
}

const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 300_000 }, (error, stdout) => error ? reject(error) : resolve(String(stdout))));

/** The .app the running process belongs to (…/Girru.app/Contents/MacOS/Girru). */
function currentAppPath(execPath = process.execPath) {
  // A real macOS bundle path is POSIX; other paths (tests on Windows) use the platform's own rules.
  const app = (execPath.startsWith('/') ? path.posix : path).resolve(execPath, '..', '..', '..');
  return app.endsWith('.app') ? app : null;
}

async function appInfo(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const id = (await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist])).trim();
  const version = (await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist])).trim();
  return { id, version };
}

/**
 * The updater: state for the page, a daily check, and install. Everything that
 * touches the outside is passed in, so the tests run it with fakes.
 */
/** The backend's restore request file in the data folder (packages/backend/src/services/backups.ts RESTORE_MARKER). */
const RESTORE_MARKER = 'restore-pending.json';
const BACKUP_ID = /^\d{8}-\d{6}-before-update$/;
function validPrevious(p) {
  if (!p || typeof p !== 'object' || typeof p.version !== 'string' || typeof p.app !== 'string' || !path.isAbsolute(p.app)) return null;
  return { version: p.version.slice(0, 40), app: p.app, backupId: typeof p.backupId === 'string' && BACKUP_ID.test(p.backupId) ? p.backupId : null,
    backupFolder: typeof p.backupFolder === 'string' && path.isAbsolute(p.backupFolder) ? p.backupFolder : null, at: typeof p.at === 'string' ? p.at : null };
}

function createUpdater({ currentVersion, settingsDir, backUp, relaunch, runInstaller = null, fetchRelease = () => get(LATEST, { json: true }), download = get, now = () => Date.now(), platform = process.platform, arch = process.arch, execPath = process.execPath, unpack = (zip, dir) => run('/usr/bin/ditto', ['-x', '-k', zip, dir]), readApp = appInfo, keepPrevious = !/^(0|false|no|off)$/i.test(String(process.env.GIRRU_STORE_P3 || '').trim()) }) {
  const stateFile = path.join(settingsDir, 'app-update.json');
  // Windows: the installer is kept here until it has run (the next start removes it).
  const installers = path.join(settingsDir, 'updates');
  const windowsApp = platform === 'win32' && typeof runInstaller === 'function' && /(^|[\\/])girru\.exe$/i.test(String(execPath));
  let state = { version: currentVersion, checkedAt: null, release: null, busy: null, error: null, previous: null };
  // Only when it last looked is kept on disk; what GitHub offers (and where to download it) is asked again after a restart.
  // STORE-MAP-01 P3 (FD4a): also the version this one replaced, until this one has started once.
  try { const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); state = { ...state, checkedAt: typeof saved.checkedAt === 'string' ? saved.checkedAt : null, previous: validPrevious(saved.previous) }; } catch { /* first run */ }
  const listeners = new Set();
  const set = patch => {
    state = { ...state, ...patch };
    try { fs.writeFileSync(stateFile, JSON.stringify({ checkedAt: state.checkedAt, ...(state.previous ? { previous: state.previous } : {}) }), { mode: 0o600 }); } catch { /* not important */ }
    for (const l of listeners) l(view());
  };
  const view = () => ({
    version: state.version, checkedAt: state.checkedAt, busy: state.busy, error: state.error,
    update: state.release && state.release.available && newer(state.release.version, state.version)
      ? { version: state.release.version, publishedAt: state.release.publishedAt, notes: state.release.notes, page: state.release.page, canInstall: !!state.release.zip && !!state.release.sums && ((platform === 'darwin' && !!currentAppPath(execPath)) || windowsApp) }
      : null,
  });

  async function check() {
    if (state.busy) return view();
    set({ busy: 'checking', error: null });
    try { set({ release: readRelease(await fetchRelease(), state.version, platformId(platform, arch)), checkedAt: new Date(now()).toISOString(), busy: null }); }
    catch (error) { set({ busy: null, error: `Could not look for updates: ${error.message}` }); }
    return view();
  }
  /** Once a day, never more often. */
  function checkIfDue() {
    if (state.checkedAt && now() - Date.parse(state.checkedAt) < DAY) return Promise.resolve(view());
    return check();
  }

  async function install() {
    if (state.busy || !view().update || !view().update.canInstall) return view();
    // The download addresses come from GitHub's answer right now, never from anything saved.
    let r;
    try { r = readRelease(await fetchRelease(), state.version, platformId(platform, arch)); } catch (error) { set({ error: `Could not reach GitHub: ${error.message}` }); return view(); }
    if (!r.available || r.version !== state.release.version || !r.zip || !r.sums) { set({ release: r, error: 'The release changed; look at it again before updating.' }); return view(); }
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'girru-update-'));
    try {
      set({ busy: 'downloading', error: null });
      const sums = await download(r.sums, { maxBytes: 64 * 1024 });
      const expected = sumFor(sums, r.zipName);
      if (!expected) throw new Error('the release has no checksum for this computer');
      if (platform === 'win32') fs.mkdirSync(installers, { recursive: true, mode: 0o700 });
      const zip = path.join(platform === 'win32' ? installers : work, r.zipName);
      const actual = await download(r.zip, { file: zip });
      if (actual !== expected) { fs.rmSync(zip, { force: true }); throw new Error('the download does not match its checksum'); }
      set({ busy: 'backing-up' });
      const backup = await backUp();
      if (!backup || backup.ok !== true) throw new Error(`the backup before updating failed${backup && backup.error ? ` (${backup.error})` : ''}`);
      set({ busy: 'installing' });
      if (platform === 'win32') {
        // A Windows program starts with "MZ"; anything else is not run.
        const head = Buffer.alloc(2); const fd = fs.openSync(zip, 'r'); try { fs.readSync(fd, head, 0, 2, 0); } finally { fs.closeSync(fd); }
        if (head.toString('latin1') !== 'MZ') throw new Error('the download is not a Windows installer');
        set({ busy: 'installing', release: null, previous: null });
        runInstaller(zip);
        return view();
      }
      const unpacked = path.join(work, 'app');
      fs.mkdirSync(unpacked);
      await unpack(zip, unpacked);
      const found = fs.readdirSync(unpacked).filter(n => n.endsWith('.app'));
      if (found.length !== 1) throw new Error('the download holds no single app');
      const fresh = path.join(unpacked, found[0]);
      if (fs.lstatSync(fresh).isSymbolicLink()) throw new Error('the download is not a plain app');
      const info = await readApp(fresh);
      if (info.id !== APP_ID || info.version !== r.version) throw new Error('the download is not this app in the new version');
      const current = currentAppPath(execPath);
      const old = path.join(path.dirname(current), `.${path.basename(current)}.old-${now()}`);
      fs.renameSync(current, old);
      try { fs.renameSync(fresh, current); } catch (error) { fs.renameSync(old, current); throw error; }
      const previous = keepPrevious ? validPrevious({ version: state.version, app: old, backupId: backup.id, backupFolder: backup.folder, at: new Date(now()).toISOString() }) : null;
      set({ busy: null, release: null, previous });
      relaunch();
    } catch (error) {
      set({ busy: null, error: `The update did not finish: ${error.message}. Girru is unchanged.` });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    return view();
  }

  /**
   * On start: remove the app an earlier update kept beside this one. With P3 the
   * version this one replaced stays until this one has started once (startedFine).
   */
  function cleanOld() {
    // Windows: an installer that already ran is no longer needed.
    if (platform === 'win32') { try { fs.rmSync(installers, { recursive: true, force: true }); } catch { /* in use or gone */ } return; }
    const current = currentAppPath(execPath);
    if (!current) return;
    const keep = keepPrevious && state.previous ? state.previous.app : null;
    const dir = path.dirname(current), prefix = `.${path.basename(current)}.old-`;
    try { for (const n of fs.readdirSync(dir)) if (n.startsWith(prefix) && path.join(dir, n) !== keep) fs.rmSync(path.join(dir, n), { recursive: true, force: true }); } catch { /* not ours to clean */ }
  }

  /** This version started: the one it replaced is no longer needed. */
  function startedFine() {
    if (!state.previous) return;
    try { fs.rmSync(state.previous.app, { recursive: true, force: true }); } catch { /* gone already */ }
    set({ previous: null });
  }

  /** What "Restore and open" would bring back (FD4a), or null. */
  function previous() {
    const p = state.previous;
    if (!keepPrevious || !p || !p.backupId || !p.backupFolder) return null;
    try { if (!fs.statSync(p.app).isDirectory()) return null; } catch { return null; }
    return { version: p.version, backupId: p.backupId, at: p.at };
  }

  /**
   * FD4a: put the data back to the backup made before the update and open the
   * version that made it. The restore itself runs in that version's start-up,
   * before any store opens (the backend's restore marker); this version is moved
   * aside, never deleted.
   */
  function restorePrevious(dataDir) {
    const p = previous();
    const current = currentAppPath(execPath);
    if (!p || !current) throw new Error('There is no earlier version to open');
    const marker = path.join(dataDir, RESTORE_MARKER);
    fs.writeFileSync(marker + '.tmp', JSON.stringify({ id: state.previous.backupId, folder: state.previous.backupFolder, at: new Date(now()).toISOString() }), { mode: 0o600 });
    fs.renameSync(marker + '.tmp', marker);
    const failed = path.join(path.dirname(current), `.${path.basename(current)}.failed-${now()}`);
    fs.renameSync(current, failed);
    try { fs.renameSync(state.previous.app, current); } catch (error) { fs.renameSync(failed, current); fs.rmSync(marker, { force: true }); throw error; }
    set({ previous: null });
    relaunch();
    return { version: p.version };
  }

  return { view, check, checkIfDue, install, cleanOld, startedFine, previous, restorePrevious, onChange: l => { listeners.add(l); return () => listeners.delete(l); } };
}

module.exports = { createUpdater, readRelease, newer, sumFor, platformId, currentAppPath, get, LATEST };
