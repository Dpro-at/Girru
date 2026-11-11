// Source fixture deferred until final whole-task verification.
import test from 'node:test';import assert from 'node:assert/strict';import {bindEncryptedMemoryServer,isEncryptedMemoryServer} from '../src/memory/encryption/server-mode.ts';
test('explicit encrypted mode belongs to one server instance and cannot be enabled by another object',()=>{const selected={},unrelated={};assert.equal(isEncryptedMemoryServer(selected),false);bindEncryptedMemoryServer(selected);assert.equal(isEncryptedMemoryServer(selected),true);assert.equal(isEncryptedMemoryServer(unrelated),false);});
