'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');

/** Only the trusted desktop process chooses executable and profile locations. */
function createBrowserRuntime({root, node, profile}) {
  const connectionFile = path.join(profile, 'connections', 'owner-runtime.json');
  let child, starting;
  async function connection() {
    const handle=await fs.open(connectionFile,'r');let value;
    try{const buffer=Buffer.alloc(4097),{bytesRead}=await handle.read(buffer,0,buffer.length,0);if(bytesRead>4096)throw Error('Invalid browser connection');value=JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));}finally{await handle.close();}
    if (value.presentation !== 'embedded') throw Error('Open the embedded browser runtime');
    const endpoint=/^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(value.url);
    if (!endpoint || Number(endpoint[1])<1 || Number(endpoint[1])>65535 || !/^[a-f0-9]{64}$/.test(value.token)) throw Error('Invalid browser connection');
    return value;
  }
  async function command(body) {
    const value = await connection();
    const reply = await fetch(value.url + '/ui', {method:'POST', redirect:'error', headers:{Authorization:'Bearer '+value.token, 'Content-Type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout(['state','frame'].includes(body.action)?2000:30000)});
    if (!reply.ok) throw Error('Browser unavailable');
    return reply.json();
  }
  async function available() {
    try { const manifest = JSON.parse(await fs.readFile(path.join(root, 'runtime', 'package.json'), 'utf8')); return manifest.name === '@girru/browser'; } catch { return false; }
  }
  async function status() {
    let running = false;
    try { await command({action:'state'}); running = true; } catch {}
    return {available:await available(), running};
  }
  async function open() {
    const current = await status();
    if (!current.available) throw Error('Browser runtime unavailable');
    if (current.running) {
      // The browser content is presented inside Girru; never focus a native Chrome window.
      return current;
    }
    if (!starting) starting = (async () => {
      const processHandle = spawn(node, [path.join(root, 'runtime', 'scripts', 'full-start.cjs')], {cwd:root, env:{...process.env, GIRRU_BROWSER_PROFILE:profile, GIRRU_BROWSER_EMBEDDED:'1'}, stdio:'ignore'});
      child = processHandle;
      let exited = false;
      processHandle.once('error', () => { exited = true; }); processHandle.once('exit', () => { exited = true; if(child===processHandle)child = undefined; });
      const deadline=Date.now()+60000;
      while (Date.now()<deadline && !exited) {
        const next = await status(); if (next.running) return next;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      processHandle.kill('SIGTERM'); throw Error('Browser could not start');
    })().finally(() => { starting = undefined; });
    return starting;
  }
  return {connectionFile, status, open, command, async close() { child?.kill('SIGTERM'); }};
}
module.exports = {createBrowserRuntime};
