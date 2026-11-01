const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installNabuEditor, loopbackOrigin, CHANNELS } = require('../src/nabu-editor.cjs');

class Contents extends EventEmitter {
  mainFrame = { url: 'http://127.0.0.1:42522/' };
  sent = []; url = ''; destroyed = false; loads = 0; dirty = false;
  session = { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} };
  send(channel, value) { this.sent.push({ channel, value }); }
  getZoomFactor() { return 1; }
  isDestroyed() { return this.destroyed; }
  setWindowOpenHandler(fn) { this.open = fn; }
  getURL() { return this.url; }
  async loadURL(url) { this.loads++; if (this.failLoad) throw Error('Offline'); this.url = url; }
  input = [];
  sendInputEvent(value) { this.input.push(value); }
  focus() {}
  close() {
    let discard = false;
    if (this.dirty) this.emit('will-prevent-unload', { preventDefault() { discard = true; } });
    if (this.dirty && !discard) return;
    this.destroyed = true; this.emit('destroyed');
  }
}
function fixture({ start, onLoad, origin = 'http://127.0.0.1:42522' } = {}) {
  const ipc = new EventEmitter(); ipc.handlers = new Map();
  ipc.handle = (key, fn) => ipc.handlers.set(key, fn); ipc.removeHandler = key => ipc.handlers.delete(key);
  const win = new EventEmitter(); win.webContents = new Contents(); win.webContents.executeJavaScript = async () => ['Chat', 'Agents', 'Code', 'Settings']; win.isDestroyed = () => false;
  win.getContentSize = () => [1280, 720]; win.close = () => win.emit('closed');
  const views = [];
  win.contentView = { children:[],addChildView(view) {this.children.push(view);},removeChildView(view) {this.children=this.children.filter(x=>x!==view);} };
  class View { webContents = new Contents(); constructor(options) { this.options = options; views.push(this);if(onLoad){const load=this.webContents.loadURL.bind(this.webContents);this.webContents.loadURL=async url=>{await load(url);onLoad(this.webContents);};} } setVisible(value) { this.visible = value; } setBounds(value) { this.bounds = value; } }
  let starts = 0, stops = 0, discard = 0;
  const host = { async start() { starts++; return start ? await start() : { origin: 'http://127.0.0.1:42630', url: 'http://127.0.0.1:42630/?tkn=private-token' }; }, async stop() { stops++; } };
  const controller = installNabuEditor({ win, electron: { ipcMain: ipc, WebContentsView: View, dialog: { showMessageBoxSync() { return discard; }, async showOpenDialog() { return { canceled: false, filePaths: ['/tmp/girru-project'] }; } } }, getOrigin: () => origin, createHost: () => host });
  const event = () => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  const select = (mode, extras = {}) => ipc.handlers.get(CHANNELS.select)(event(), { mode, top: 48, bottom: 32, ...extras });
  return { win, ipc, views, controller, event, select, starts: () => starts, stops: () => stops, discard: () => { discard = 1; } };
}

test('only a precise loopback application can activate the local editor', async () => {
  for (const origin of ['https://remote.example', 'http://localhost:42522', 'file:///tmp/page', 'http://127.0.0.1:42522/path']) assert.equal(loopbackOrigin(origin), false);
  const f = fixture({ origin: 'https://remote.example' });
  assert.equal(await f.select('code'), null); assert.equal(f.starts(), 0); await f.controller.stop();
});
test('foreign contents, subframes, extra keys and invalid layout cannot activate Code', async () => {
  const f = fixture(); const handle = f.ipc.handlers.get(CHANNELS.select);
  assert.equal(await handle({ sender: new Contents(), senderFrame: {} }, { mode: 'code', top: 48 }), null);
  assert.equal(await handle({ sender: f.win.webContents, senderFrame: { url: f.win.webContents.mainFrame.url } }, { mode: 'code', top: 48 }), null);
  for (const extra of [{ command: 'run' }, { top: NaN }, { top: 1 }, { top: 200 }, {bottom:NaN}, {bottom:-1}, {bottom:97}]) assert.equal(await f.select('code', extra), null);
  assert.equal(f.starts(), 0); await f.controller.stop();
});
test('Code lives in one retained child view, and mode state never exposes the connection token', async () => {
  const f = fixture(); await f.select('code'); const v = f.views[0];
  assert.equal(f.controller.state().mode, 'code'); assert.equal(v.visible, true);
  assert.deepEqual(v.bounds, { x: 0, y: 48, width: 1280, height: 640 });
  assert.equal(v.options.webPreferences.sandbox, true); assert.equal(v.options.webPreferences.nodeIntegration, false);
  await f.select('chat'); await f.select('code');
  assert.equal(f.views.length, 1); assert.equal(v.webContents.loads, 1); assert.equal(f.starts(), 1);
  assert.equal(JSON.stringify(f.win.webContents.sent).includes('private-token'), false);
  await f.controller.stop(); assert.equal(f.stops(), 1); assert.equal(f.ipc.handlers.size, 0);
});
test('choosing Chat during startup never switches back when startup completes', async () => {
  let resolve; const f = fixture({ start: () => new Promise(r => { resolve = r; }) });
  const pending = f.select('code'); await new Promise(r => setImmediate(r));
  await f.select('chat'); resolve({ origin: 'http://127.0.0.1:42630', url: 'http://127.0.0.1:42630/?tkn=private-token' });
  await pending; assert.equal(f.views.length, 0); assert.equal(f.controller.state().mode, 'chat'); await f.controller.stop();
});
test('Code and Chat shortcuts work from the editor without granting Girru IPC to it', async () => {
  const f = fixture(); await f.select('code');
  const v = f.views[0]; v.webContents.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', code: 'Digit2', key: '™', meta: true, alt: true });
  assert.equal(v.visible, false); assert.equal(f.controller.state().mode, 'chat');
  assert.equal(await f.ipc.handlers.get(CHANNELS.status)({ sender: v.webContents, senderFrame: v.webContents.mainFrame }), null);
  await f.controller.stop();
});
test('unsaved work defaults to keep working, can be retried and requires explicit discard', async () => {
  const f = fixture(); await f.select('code'); const v = f.views[0]; v.webContents.dirty = true;
  assert.equal(await f.controller.requestClose(), false); assert.equal(v.webContents.destroyed, false);
  f.discard(); assert.equal(await f.controller.requestClose(), true); assert.equal(v.webContents.destroyed, true);
  await f.controller.stop();
});
test('a crashed renderer can reload and refuses navigation outside its authenticated host', async () => {
  const f = fixture(); await f.select('code'); const wc = f.views[0].webContents;
  let blocked = false; wc.emit('will-navigate', { preventDefault() { blocked = true; } }, 'https://external.example'); assert.equal(blocked, true);
  wc.emit('render-process-gone'); assert.equal(f.controller.state().mode, 'chat');
  await f.select('code'); assert.equal(wc.loads, 2); assert.equal(f.controller.state().mode, 'code'); await f.controller.stop();
});
test('closing during startup stops the owned host and ignores its late ready event', async () => {
  let resolve; const f = fixture({ start: () => new Promise(r => { resolve = r; }) });
  const pending = f.select('code'); await new Promise(r => setImmediate(r)); await f.controller.stop();
  resolve({ origin: 'http://127.0.0.1:42630', url: 'http://127.0.0.1:42630/?tkn=private-token' }); await pending;
  assert.equal(f.views.length, 0); assert.equal(f.stops(), 1);
});

// The surrounding Girru navigation must remain reachable while editing.
test('older runtimes preserve the shell footer and follow zoom without reloading',async()=>{
 const f=fixture();await f.select('code');const view=f.views[0];
 f.win.webContents.getZoomFactor=()=>1.25;
 f.ipc.emit(CHANNELS.layout,f.event(),{top:40,bottom:24});
 assert.deepEqual(view.bounds,{x:0,y:50,width:1280,height:640});
 f.ipc.emit(CHANNELS.layout,f.event(),{top:40,bottom:-1});
 assert.deepEqual(view.bounds,{x:0,y:50,width:1280,height:640});
 assert.equal(view.webContents.loads,1);await f.controller.stop();
});

test('reloading or losing the Girru renderer hides the local editor',async()=>{
 const f=fixture();await f.select('code');const view=f.views[0];
 f.win.webContents.emit('did-start-navigation',{},'http://127.0.0.1:42522/',false,true);
 assert.equal(view.visible,false);assert.equal(f.controller.state().mode,'chat');
 await f.select('code');f.win.webContents.emit('render-process-gone');
 assert.equal(view.visible,false);assert.equal(view.webContents.loads,1);
 await f.controller.stop();
});

test('shutdown tolerates Electron releasing the closed child webContents',async()=>{
 const f=fixture();await f.select('code');assert.equal(await f.controller.requestClose(),true);
 f.views[0].webContents=undefined;await f.controller.stop();assert.equal(f.stops(),1);
});

// These fixtures exercise files created by a competing writer without replacing its data.
test('preview settings creation never overwrites an existing or linked account file',t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const {initializeSettings}=require('../scripts/configure-editor-preview.cjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dpro-preview-settings-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const settings=path.join(root,'desktop.json');
 assert.equal(initializeSettings(settings,'http://127.0.0.1:42522'),true);
 const original=fs.readFileSync(settings,'utf8');
 assert.equal(initializeSettings(settings,'http://127.0.0.1:42524'),false);
 assert.equal(fs.readFileSync(settings,'utf8'),original);
 if(process.platform!=='win32'){
  const link=path.join(root,'linked.json');fs.symlinkSync(settings,link);
  assert.equal(initializeSettings(link,'http://127.0.0.1:42524'),false);
  assert.equal(fs.readFileSync(settings,'utf8'),original);
 }
});
test('runtime validation binds its size check and bounded read to the opened manifest',t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const {compatibleRuntime}=require('../src/nabu-editor.cjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dpro-runtime-manifest-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'nabu/dpro'),{recursive:true});
 const manifest=path.join(root,'nabu/runtime.json');
 fs.writeFileSync(manifest,JSON.stringify({protocolVersion:1,entry:'dpro/editor-runtime.mjs'}));
 fs.writeFileSync(path.join(root,'nabu/dpro/editor-runtime.mjs'),'');
 const fstat=fs.fstatSync;let swapped=false;
 fs.fstatSync=fd=>{const info=fstat(fd);if(!swapped){swapped=true;fs.renameSync(manifest,manifest+'.old');fs.writeFileSync(manifest,'invalid replacement');}return info;};
 try {assert.equal(compatibleRuntime(root),true);assert.equal(swapped,true);}finally{fs.fstatSync=fstat;}
 assert.equal(compatibleRuntime(root),false);
 fs.writeFileSync(manifest,' '.repeat(8193));assert.equal(compatibleRuntime(root),false);
});


test('editor footer and native folder bridge reject foreign frames, hidden views and unknown navigation', async () => {
 const f=fixture(); await f.select('code'); const v=f.views[0];
 v.webContents.mainFrame.url='http://127.0.0.1:42630/?tkn=private-token';
 const e={sender:v.webContents,senderFrame:v.webContents.mainFrame};
 const footer=f.ipc.handlers.get('girru:code-footer'),pick=f.ipc.handlers.get('girru:code-directory'),nav=f.ipc.handlers.get('girru:code-navigate');
 assert.deepEqual(await footer(f.event()),[]); assert.equal(await pick(f.event()),null);
 assert.deepEqual(await footer(e),[{id:'chat',label:'Chat'},{id:'agents',label:'Agents'},{id:'code',label:'Code'},{id:'settings',label:'Settings'}]);
 assert.deepEqual(v.bounds,{x:0,y:48,width:1280,height:672});
 assert.equal(await pick(e),'/tmp/girru-project');
 assert.equal(await pick({...e,senderFrame:{url:v.webContents.mainFrame.url}}),null);
 assert.equal(nav(e,'terminal'),false); assert.equal(nav(e,{}),false);
 assert.equal(nav(e,'agents'),true); assert.equal(f.win.webContents.sent.at(-2).channel,'dpro:code-footer');
 assert.equal(f.controller.state().mode,'chat'); assert.equal(await pick(e),null); assert.deepEqual(await footer(e),[]);
 await f.controller.stop(); assert.equal(f.ipc.handlers.size,0);
});


test('opening a chat project confines files, rejects escapes and reserves the actual chat pane', async t => {
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'girru-code-target-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const root=path.join(dir,'project');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'review.txt'),'review');fs.writeFileSync(path.join(dir,'outside.txt'),'outside');
 const f=fixture();const open=f.ipc.handlers.get(CHANNELS.open),body={folder:root,file:'review.txt',top:48,bottom:32,right:420};
 assert.equal(await open({...f.event(),senderFrame:{}},body),null);
 for(const file of ['../outside.txt','/tmp/private','C:\\private','.env','secret.key'])assert.equal(await open(f.event(),{...body,file}),null);
 if(process.platform!=='win32'){fs.symlinkSync(path.join(dir,'outside.txt'),path.join(root,'escape'));assert.equal(await open(f.event(),{...body,file:'escape'}),null);}
 assert.equal((await open(f.event(),body)).mode,'code');const v=f.views[0];assert.equal(v.bounds.width,860);
 v.webContents.mainFrame.url=v.webContents.url;const event={sender:v.webContents,senderFrame:v.webContents.mainFrame};
 const target=await f.ipc.handlers.get('girru:code-target')(event);assert.equal(target.folder,fs.realpathSync(root));assert.equal(target.file,fs.realpathSync(path.join(root,'review.txt')));
 assert.equal(f.ipc.handlers.get('girru:code-target-done')(event,target.id+1),false);assert.equal(f.ipc.handlers.get('girru:code-target-done')(event,target.id),true);
 assert.equal(f.ipc.handlers.get('girru:code-target')(event),null);
 await f.controller.stop();
});


test('the shared command bar opens only the editor command palette, and never exposes arbitrary commands',async()=>{
 const f=fixture();const commands=f.ipc.handlers.get('dpro:nabu-commands');assert.equal(commands(f.event()),false);
 await f.select('code');assert.equal(commands({...f.event(),senderFrame:{}}),false);assert.equal(commands(f.event()),true);
 assert.deepEqual(f.views[0].webContents.input.map(x=>[x.type,x.keyCode]),[['keyDown','P'],['keyUp','P']]);
 await f.select('chat');assert.equal(commands(f.event()),false);await f.controller.stop();assert.equal(f.ipc.handlers.size,0);
});


test('the initial editor load cannot navigate to the requested folder before the native view is ready',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const root=fs.mkdtempSync(path.join(os.tmpdir(),'girru-code-ready-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const seen=[];const f=fixture({onLoad:contents=>{contents.mainFrame.url=contents.url;seen.push(f.ipc.handlers.get('girru:code-target')({sender:contents,senderFrame:contents.mainFrame}));}});
 assert.equal((await f.ipc.handlers.get(CHANNELS.open)(f.event(),{folder:root,file:null,top:48,bottom:32})).mode,'code');assert.deepEqual(seen,[null]);
 const wc=f.views[0].webContents;assert.equal(f.ipc.handlers.get('girru:code-target')({sender:wc,senderFrame:wc.mainFrame}).folder,fs.realpathSync(root));await f.controller.stop();
});

test('native review only forwards a bounded saved proposal and a matching one-shot decision', async () => {
 const f=fixture();await f.select('code');const wc=f.views[0].webContents;wc.mainFrame.url='http://127.0.0.1:42630/';const editor={sender:wc,senderFrame:wc.mainFrame};
 const proposal={id:'970344f8-54d1-46e2-8abb-691c323fb261',path:'review.txt',before:'old\n',after:'new\n'};
 const publish=f.ipc.handlers.get('dpro:nabu-review'),get=f.ipc.handlers.get('girru:code-review'),decide=f.ipc.handlers.get('girru:code-review-decide');
 assert.equal(publish(editor,proposal),false);assert.equal(publish(f.event(),{...proposal,path:'../secret'}),false);assert.equal(publish(f.event(),{...proposal,after:'x'.repeat(24001)}),false);
 assert.equal(publish(f.event(),proposal),true);assert.deepEqual(get(editor),proposal);assert.equal(get(f.event()),null);
 assert.equal(decide(editor,'00000000-0000-0000-0000-000000000000','approve'),false);assert.equal(decide(editor,proposal.id,'execute'),false);assert.equal(decide(f.event(),proposal.id,'approve'),false);
 assert.equal(decide(editor,proposal.id,'approve'),true);assert.equal(decide(editor,proposal.id,'approve'),false);assert.equal(get(editor),null);
 assert.deepEqual(f.win.webContents.sent.find(x=>x.channel==='dpro:nabu-review-decision').value,{id:proposal.id,decision:'approve'});
 publish(f.event(),proposal);await f.select('chat');assert.equal(decide(editor,proposal.id,'approve'),false);await f.controller.stop();
});
