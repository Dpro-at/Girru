'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const desktop = path.resolve(__dirname, '..');
const release = path.join(desktop, 'release');
const port = 42523;

function installer(extension) {
  const files = fs.readdirSync(release).filter(name => name.endsWith(extension));
  assert.equal(files.length, 1, `Expected one ${extension} installer`);
  return path.join(release, files[0]);
}

function install(root) {
  if (process.platform === 'win32') {
    const directory = path.join(root, 'installed');
    // Close the inherited handles so the NSIS process cannot keep the test waiting
    // on pipes held by a child after setup finishes.
    execFileSync(installer('.exe'), ['/S', '/currentuser', `/D=${directory}`], {
      timeout: 240_000,
      stdio: 'ignore',
    });
    const executable = path.join(directory, 'Girru.exe');
    assert.ok(fs.existsSync(executable), 'NSIS must install Girru.exe in the isolated directory');
    const icon = path.join(root, 'platform-icon.png');
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Drawing; ' +
      '$icon = [Drawing.Icon]::ExtractAssociatedIcon($env:GIRRU_BRANDING_EXE); ' +
      '$bitmap = $icon.ToBitmap(); ' +
      '$bitmap.Save($env:GIRRU_BRANDING_PNG, [Drawing.Imaging.ImageFormat]::Png); ' +
      '$bitmap.Dispose(); $icon.Dispose()',
    ], { env: { ...process.env, GIRRU_BRANDING_EXE: executable, GIRRU_BRANDING_PNG: icon } });
    return { executable, icon };
  }
  assert.equal(process.platform, 'linux');
  execFileSync(installer('.AppImage'), ['--appimage-extract'], {
    cwd: root, timeout: 120_000, stdio: 'ignore',
  });
  const directory = path.join(root, 'squashfs-root');
  return { executable: path.join(directory, 'AppRun'), icon: path.join(directory, '.DirIcon') };
}

async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const request = ++id;
    const listener = event => {
      const message = JSON.parse(event.data);
      if (message.id !== request) return;
      ws.removeEventListener('message', listener);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    };
    ws.addEventListener('message', listener);
    ws.send(JSON.stringify({ id: request, method, params }));
  });
  return { ws, call };
}

async function waitForPage(child) {
  let lastPage = 'none';
  const clicked = new Set();
  for (let retry = 0; retry < 180; retry++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`The installed app exited before opening its interface: ${child.exitCode ?? child.signalCode}`);
    }
    let pages;
    try {
      pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    } catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED') throw error;
    }
    const page = pages?.find(entry => entry.type === 'page');
    if (page && /^http:\/\/127\.0\.0\.1:/.test(page.url)) return page;
    if (page) {
      const name = new URL(page.url).pathname.split('/').at(-1);
      if (name !== lastPage) console.log(`First launch: ${name}`);
      lastPage = name;
      if (!clicked.has(name) && ['permissions.html', 'welcome.html', 'failed.html'].includes(name)) {
        const { ws, call } = await connect(page);
        try {
          const result = await call('Runtime.evaluate', {
            expression: `(() => {
              if (${JSON.stringify(name)} === 'failed.html') return document.body.innerText;
              const button = document.querySelector(${JSON.stringify(name === 'permissions.html' ? '#next' : '#primary')});
              if (!button || button.disabled) return false;
              button.click();
              document.querySelector('dialog[open] #confirm-separate')?.click();
              return true;
            })()`,
            returnByValue: true,
          });
          if (name === 'failed.html') throw new Error(`Installed app startup failed: ${result.result.value}`);
          if (result.result.value === true) clicked.add(name);
        } finally {
          ws.close();
        }
      }
    }
    await delay(500);
  }
  throw new Error(`The installed app did not open its local interface. Last page: ${lastPage}`);
}

async function inspect(executable, icon, root) {
  const profile = path.join(root, 'profile');
  if (process.platform === 'win32') {
    // Branding is checked after the optional Windows microphone review. This marker
    // belongs to the temporary CI profile and does not grant native permissions.
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'permissions-reviewed-v3.json'), '{"reviewed":true}\n');
  }
  const child = spawn(executable, [
    `--user-data-dir=${profile}`,
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
  ], { stdio: 'inherit' });
  let ws;
  try {
    const connection = await connect(await waitForPage(child));
    ws = connection.ws;
    const { call } = connection;
    const expected = fs.readFileSync(path.join(desktop, '..', 'core-ui', 'src', 'girru-mark.png')).toString('base64');
    const expression = `[...document.querySelectorAll('.setup-welcome img.dpro-mark')].some(image =>
      image.complete && image.naturalWidth === 128 && image.getBoundingClientRect().width >= 80 &&
      image.src === ${JSON.stringify(`data:image/png;base64,${expected}`)})`;
    let visible = false;
    for (let retry = 0; retry < 60 && !visible; retry++) {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true });
      visible = result.result.value === true;
      if (!visible) await delay(500);
    }
    assert.ok(visible, 'The approved larger transparent mark must appear in the installed welcome screen');
    const imageSource = `data:image/png;base64,${fs.readFileSync(icon).toString('base64')}`;
    const nativeIcon = await call('Runtime.evaluate', {
      expression: `(async () => {
        const image = new Image();
        image.src = ${JSON.stringify(imageSource)};
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const pixel = (x, y) => [...context.getImageData(Math.floor(x * image.width), Math.floor(y * image.height), 1, 1).data];
        return {corner: pixel(0,0), tile: pixel(.5,.07)};
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    assert.equal(nativeIcon.result.value?.corner[3], 0, 'The platform icon corner must be transparent');
    assert.deepEqual(nativeIcon.result.value?.tile, [255, 255, 255, 255], 'The platform icon tile must be white');
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    fs.copyFileSync(icon, path.join(release, 'installed-platform-icon.png'));
    fs.writeFileSync(path.join(release, 'installed-welcome.png'), Buffer.from(screenshot.data, 'base64'));
    console.log('Installed platform icon and transparent welcome mark verified.');
  } finally {
    ws?.close();
    child.kill();
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'girru-branding-'));
  const { executable, icon } = install(root);
  await inspect(executable, icon, root);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
