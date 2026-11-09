// Source fixtures are deferred until the final whole-task verification round.
import test from 'node:test';import assert from 'node:assert/strict';
import {registerEncryptedMemoryRuntimeHooks} from '../src/memory/encryption/runtime-host.ts';
test('explicit runtime hooks propagate startup failure and still expose close cleanup',async()=>{const hooks=new Map();let closed=false;registerEncryptedMemoryRuntimeHooks({addHook:(name,handler)=>hooks.set(name,handler)},{start:async()=>{throw Error('Missing custody');},close:async()=>{closed=true;}});await assert.rejects(hooks.get('onReady')());await hooks.get('onClose')();assert.equal(closed,true);});
