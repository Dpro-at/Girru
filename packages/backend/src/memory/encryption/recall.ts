import {observeEncryptedRunFieldProducer} from './run-admission.js';
/** ENC-01 lexical recall prototype: decrypt only authorized candidates; never creates an on-disk text index. */
import { lexicalTokens } from '../text-normalize.js';
import { bm25Scores,hybridScore,vectorScore,MIN_RECALL_SCORE,WORKING_LAYER_BOOST } from '../hybrid.js';
import {cosine,type EmbeddingResult} from '../embedding.js';
import {unpackVector} from '../vectors.js';
import { decryptMemoryRow, encryptedFieldProducer, type MemoryRowScope } from './row-codec.js';
import { MemoryCipherError } from './envelope.js';
type Row = Record<string, unknown>;
export interface EncryptedRecallOptions {
  scope: MemoryRowScope;
  query: string;
  limit?: number;
  /** Server-produced local query embedding only; no provider or network is invoked here. */
  embedding?: EmbeddingResult;
  /** Internal narrowing only, applied after authenticated decrypt and before ranking. */
  filter?: (row:Readonly<Row>)=>boolean;
  maxCandidates?: number;
  maxEncryptedBytes?: number;
  /** Must use the existing server-side permissions, not caller-supplied grants. */
  authorize: (metadata: Readonly<Row>) => boolean | Promise<boolean>;
  /** True only while the captured unlock AND permission revisions are current. */
  isCurrent: () => boolean;
  /** Recheck authoritative session/permission revisions without relying on cached snapshots. */
  validateCurrent: () => Promise<boolean>;
  /** Persist an authorized-decryption intent before any plaintext read. True means durable acknowledgement. */
  recordRead: (ids: readonly string[]) => Promise<boolean>;
  /** Return a fresh owned buffer; the recall operation wipes it even when interrupted. */
  resolveKey: (metadata: Readonly<Row>) => Promise<{ id: string; key: Buffer; scope: MemoryRowScope }>;
}
export async function recallEncryptedMemories(rows: Iterable<Row>, options: EncryptedRecallOptions): Promise<Array<{ id: string; content: string; score: number }>> {
  try {
    const scope = Object.freeze({ ...options.scope });
    const embedding=options.embedding?{...options.embedding,vector:[...options.embedding.vector]}:undefined;
    if(embedding&&(typeof embedding.model!=='string'||!embedding.model||Buffer.byteLength(embedding.model)>256||typeof embedding.semantic!=='boolean'||!Number.isInteger(embedding.dims)||embedding.dims<1||embedding.dims>8192||embedding.vector.length!==embedding.dims||embedding.vector.some(v=>!Number.isFinite(v))))throw new MemoryCipherError();
    const filter=options.filter;const authorize = options.authorize, resolveKey = options.resolveKey, isCurrent = options.isCurrent, recordRead = options.recordRead, validateCurrent = options.validateCurrent;
    const current = () => { if (isCurrent() !== true) throw new MemoryCipherError(); };
    const checkpoint = async () => { current(); if(typeof validateCurrent!=='function'||await validateCurrent()!==true)throw new MemoryCipherError(); current(); };
    await checkpoint();
    const limit = options.limit ?? 10, maximum = options.maxCandidates ?? 5000, cipherBudget = options.maxEncryptedBytes ?? 64 * 1024 * 1024;
    if (typeof recordRead !== 'function' || typeof options.query !== 'string' || Buffer.byteLength(options.query, 'utf8') > 4096
      || !Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(maximum) || maximum < 1 || maximum > 5000
      || !Number.isInteger(cipherBudget) || cipherBudget < 1024 || cipherBudget > 64 * 1024 * 1024) throw new MemoryCipherError();
    const query = lexicalTokens(options.query);
    if (!query.length&&!embedding) return [];
    const documents: Array<{ id: string; content: string; vector:number[]|null;model:unknown;layer:unknown }> = [];
    const authorized: Readonly<Row>[] = [], ids = new Set<string>();
    let seen = 0, plainBytes = 0, cipherBytes = 0;
    for (const candidate of rows) {
      await checkpoint();
      const row = Object.freeze({ ...candidate });
      if (++seen > maximum) throw new MemoryCipherError();
      if (row.user_id !== scope.ownerId || (row.status ?? 'active') !== 'active') continue;
      if (await authorize(row) !== true) { current(); continue; }
      await checkpoint();
      for (const value of Object.values(row)) cipherBytes += typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : Buffer.isBuffer(value) ? value.length : 0;
      if (cipherBytes > cipherBudget || typeof row.id !== 'string' || !row.id || ids.has(row.id)) throw new MemoryCipherError();
      ids.add(row.id); authorized.push(row);
    }
    // Log every candidate that will be decrypted, not just the final top results.
    for (let offset = 0; offset < authorized.length; offset += 1000) {
      await checkpoint();
      const batch = Object.freeze(authorized.slice(offset, offset + 1000).map(row => row.id as string));
      if (await recordRead(batch) !== true) throw new MemoryCipherError();
      await checkpoint();
    }
    for (const row of authorized) {
      await checkpoint();
      let material: Awaited<ReturnType<EncryptedRecallOptions['resolveKey']>> | undefined;
      try {
        material = await resolveKey(row);
        await checkpoint();
        if (material.scope.ownerId !== scope.ownerId || material.scope.memberId !== scope.memberId) throw new MemoryCipherError();
        const plain = decryptMemoryRow('memories', row, scope, material.key, material.id);
        await checkpoint();
        if (typeof plain.id !== 'string' || typeof plain.content !== 'string') throw new MemoryCipherError();
        plainBytes += Buffer.byteLength(plain.content, 'utf8');
        if (plainBytes > 8 * 1024 * 1024) throw new MemoryCipherError();
        if(filter&&filter(Object.freeze({...plain}))!==true)continue;
        let vector=unpackVector(plain.embedding_vec);
        if(!vector&&plain.embedding!==null){const parsed=JSON.parse(String(plain.embedding));if(!Array.isArray(parsed))throw new MemoryCipherError();vector=parsed;}
        if(vector&&(vector.length>8192||vector.some(v=>typeof v!=='number'||!Number.isFinite(v))||plain.embedding_dims!==null&&Number(plain.embedding_dims)!==vector.length))throw new MemoryCipherError();
        observeEncryptedRunFieldProducer(encryptedFieldProducer('memories',plain,'content',scope),{kind:'memory',id:plain.id});
        documents.push({ id: plain.id, content: plain.content,vector,model:plain.embedding_model,layer:plain.memory_layer });
      } finally { if (Buffer.isBuffer(material?.key)) material.key.fill(0); }
    }
    await checkpoint();
    const scores = bm25Scores(query, documents.map(d => lexicalTokens(d.content)));
    const result = documents.map((d, i) => {
      let score=scores[i];
      if(embedding){const comparable=d.vector&&d.model===embedding.model&&d.vector.length===embedding.dims;
       const vector=comparable&&(embedding.semantic||scores[i]>0)?vectorScore(cosine(embedding.vector,d.vector!),embedding.semantic):null;
       score=hybridScore(vector,scores[i],embedding.semantic);if(score>=MIN_RECALL_SCORE&&d.layer==='working')score+=WORKING_LAYER_BOOST;
      }
      return{id:d.id,content:d.content,score};
    }).filter(d => embedding?d.score>=MIN_RECALL_SCORE:d.score>0)
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, limit);
    await checkpoint();
    return result;
  } catch { throw new MemoryCipherError(); }
}
