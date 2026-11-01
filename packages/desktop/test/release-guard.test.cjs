'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { refuseDevAccounts } = require('../scripts/stage-payload.cjs');
test('release packaging refuses test login builds even after their private account config is removed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpro-release-guard-'));
  try {
    for (const content of ['enabled', '']) {
      fs.writeFileSync(path.join(root, 'index.html'), `<meta name="core-ui-dev-quick-login" content="${content}">`);
      assert.throws(() => refuseDevAccounts(root, root), /disabled dev quick-login provenance/);
    }
    fs.writeFileSync(path.join(root, 'index.html'), '<meta name="core-ui-dev-quick-login" content="disabled">');
    assert.doesNotThrow(() => refuseDevAccounts(root, root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('staged UI bridge imports outside the checkout and refuses a missing runtime module', () => {
  const { execFileSync } = require('node:child_process');
  const { stageUiBridge } = require('../scripts/stage-payload.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'girru-bridge-runtime-'));
  try {
    const ui = path.join(root, 'core-ui');
    stageUiBridge(path.resolve(__dirname, '..', '..', 'core-ui'), ui);
    const entry = path.join(ui, 'scripts', 'application-server.cjs');
    const script = "const m=require(process.argv[1]);if(typeof m.createApplicationServer!=='function')process.exit(2)";
    const options = { cwd: root, env: { ...process.env, NODE_PATH: '', HOME: root }, encoding: 'utf8', timeout: 15000, stdio: 'pipe' };
    assert.doesNotThrow(() => execFileSync(process.execPath, ['-e', script, entry], options));
    const voiceScript="(async()=>{const path=require('node:path'),fs=require('node:fs');const ui=process.argv[1];for(const file of ['chat-voice-worker.py','portable-voice-worker.py','voice-engine/voice-worker.py','voice-engine/voice-requirements.txt'])fs.accessSync(path.join(ui,'scripts',file));const host=require(path.join(ui,'scripts/voice-library-host.cjs')).createVoiceLibrary({packageRoot:ui,env:{DPRO_GENVR_VOICES:path.join(ui,'test-voices'),DPRO_GENVR_STATE:path.join(ui,'test-state')}});try{const s=await host.call('fixture');if(s.models.length!==6||s.engineId!=='')throw Error('Incomplete voice runtime');}finally{host.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;})";
    assert.doesNotThrow(()=>execFileSync(process.execPath,['-e',voiceScript,ui],options));

    fs.renameSync(path.join(ui, 'scripts', 'genvr-studio-host.cjs'), path.join(root, 'removed-studio.cjs'));
    assert.throws(() => execFileSync(process.execPath, ['-e', script, entry], options), error => /Cannot find module.*genvr-studio-host/.test(error.stderr));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
