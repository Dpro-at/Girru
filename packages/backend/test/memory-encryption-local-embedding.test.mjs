// Deferred fixtures; no local or remote model is called while writing source.
import test from 'node:test';import assert from 'node:assert/strict';
import {createSelectedMemoryEmbedding} from '../src/memory/encryption/local-embedding.ts';
import {hashEmbed,HASH_MODEL} from '../src/memory/embedding.ts';
test('selected offline adapter reuses existing hash vectors and refuses use after close',async()=>{
 const service=createSelectedMemoryEmbedding({mode:'hash'});const result=await service.document('Synthetic temporary memory');assert.equal(result.model,HASH_MODEL);assert.deepEqual(result.vector,hashEmbed('Synthetic temporary memory'));service.close();await assert.rejects(service.query('Synthetic query'));
});
test('selected semantic adapter refuses remote, DNS, credentials and endpoint injection',()=>{
 for(const baseUrl of ['https://127.0.0.1:11434','http://localhost:11434','http://example.invalid','http://127.0.0.1:11434/other','http://user:pass@127.0.0.1:11434','http://127.0.0.1:11434/?token=secret'])assert.throws(()=>createSelectedMemoryEmbedding({mode:'ollama',baseUrl,model:'synthetic-model'}));
});
