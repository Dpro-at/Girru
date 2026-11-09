import {parseDrawerId} from '../../memory/drawers.js';
import type {createEncryptedMemoryRuntime} from '../../memory/encryption/runtime-host.js';
import type {EncryptedOpenQuestion} from '../../memory/encryption/questions-gateway.js';
/**
 * STORE-MAP-01 P9b screens (boards P9b-1 to P9b-3; GIRRU_STORE_P9B). Each
 * answers 404 while the switch is off; owner only.
 *
 *   GET   /api/memory/trust?ids=a,b              "How sure" per memory (level, heard from, uses)
 *   POST  /api/memory/trust/:id/verify           Mark as verified (owner only; agents never verify)
 *   POST  /api/memory/trust/:id/unverify         Undo of Mark as verified
 *   GET   /api/memory/trust-waiting              { corrected, questions } that wait (the Needs you badge)
 *   GET   /api/memory/corrected                  corrected after use: was / now and the replies that used it
 *   POST  /api/memory/corrected/:id              { checked: boolean } Mark as checked (false = Undo)
 *   GET   /api/memory/open-questions             the questions agents asked once
 *   POST  /api/memory/open-questions/:id/answer  { text, drawer? } saved as the owner's own fact; resolves it
 *   POST  /api/memory/open-questions/:id/forget  forget it (no confirmation)
 *   POST  /api/memory/open-questions/:id/restore Undo of forget (10 minutes)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authorizeActiveRole } from '../../auth/route-guards.js';
import { actorOf } from '../../auth/auth-gate.js';
import { storeP9bEnabled } from '../../services/store-p9b.js';
import { repositories } from '../../repositories/index.js';
import {
  TrustViewError, correctedList, forgetQuestion, markVerified, openQuestions, resolveQuestion, restoreQuestion, setCorrectedChecked, trustView, trustWaiting,
  unmarkVerified, waitingQuestion, answerDraft,
} from '../../memory/quality/owner-view.js';
import {OPEN_QUESTION_DAYS,QUESTION_KEEP_DAYS} from '../../memory/quality/pipeline.js';
import { sendMemoryError } from './memory-access.js';

const OWNER_ONLY = ['owner'] as const;
type Req = FastifyRequest<{ Params: Record<string, string>; Querystring: Record<string, string | undefined>; Body: unknown }>;
const bodyOf = (r: { body?: unknown }): Record<string, any> => (r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body as Record<string, any> : {});
const DRAWER = /^(owner|experience|people:[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}|project:[A-Za-z0-9][A-Za-z0-9_.@-]{0,127})$/;

export async function storeP9bRoutes(fastify: FastifyInstance,options:{getEncryptedMemoryRuntime?:()=>ReturnType<typeof createEncryptedMemoryRuntime>|null;isEncryptedMemorySelected?:()=>boolean}={}) {
  const config = { access: 'owner' as const };
  const asOwner = (fn: (ownerId: string, request: Req, reply: FastifyReply,encrypted:ReturnType<typeof createEncryptedMemoryRuntime>|null) => Promise<unknown>) => async (request: Req, reply: FastifyReply) => {
    if (!storeP9bEnabled()) return reply.code(404).send({ code: 'not_found' });
    const ownerId = authorizeActiveRole(request, reply, OWNER_ONLY);
    if (ownerId === null) return reply;
    try {const encrypted=options.getEncryptedMemoryRuntime?.()??null;if(encrypted&&(encrypted.ownerId!==ownerId||encrypted.status()!=='ready')||!encrypted&&(options.isEncryptedMemorySelected?.()===true||typeof options.getEncryptedMemoryRuntime==='function'&&typeof options.isEncryptedMemorySelected!=='function'))throw new TrustViewError('Encrypted memory is locked or awaiting native verification',503,'encrypted_memory_unavailable');return await fn(ownerId, request, reply,encrypted); } catch (err) {
      if (err instanceof TrustViewError) return reply.code(err.status).send({ error: err.message, code: err.code });
      const sent = sendMemoryError(reply, err, {});
      if (sent) return sent;
      throw err;
    }
  };

  fastify.get('/api/memory/trust', { config }, asOwner(async (o,r,_reply,encrypted)=>{const ids=String(r.query?.ids??'').split(',').filter(Boolean).slice(0,200);return{items:encrypted?await encrypted.ownerTrust(ids):await trustView(o,ids)};}));
  fastify.post('/api/memory/trust/:id/verify', { config }, asOwner(async(o,r,_reply,encrypted)=>({item:encrypted?await encrypted.ownerVerify(r.params.id,true):await markVerified(o,r.params.id)})));
  fastify.post('/api/memory/trust/:id/unverify', { config }, asOwner(async(o,r,_reply,encrypted)=>({item:encrypted?await encrypted.ownerVerify(r.params.id,false):await unmarkVerified(o,r.params.id)})));
  fastify.get('/api/memory/trust-waiting', { config }, asOwner(async(o,_r,_reply,encrypted)=>{if(!encrypted)return trustWaiting(o);const corrected=await encrypted.ownerCorrected(200),questions=await encrypted.ownerQuestions({openOnly:true});return{corrected:corrected.filter(row=>!row.checked).length,questions:questions.filter(row=>row.status==='open'&&Date.parse(row.askedAt)>=Date.now()-OPEN_QUESTION_DAYS*86400000).length};}));
  fastify.get('/api/memory/corrected', { config }, asOwner(async(o,_r,_reply,encrypted)=>({items:encrypted?await encrypted.ownerCorrected():await correctedList(o)})));
  fastify.post('/api/memory/corrected/:id', { config }, asOwner(async (o,r,_reply,encrypted) => {
    const checked = bodyOf(r).checked;
    if (typeof checked !== 'boolean') throw new TrustViewError('checked must be true or false', 400, 'invalid');
    return encrypted?encrypted.ownerCorrectedChecked(r.params.id,checked):setCorrectedChecked(o,r.params.id,checked);
  }));
  const ownerQuestion=(row:EncryptedOpenQuestion)=>({id:row.id,question:row.question.slice(0,300),agentId:row.agentId,status:row.status==='open'&&Date.parse(row.askedAt)<Date.now()-OPEN_QUESTION_DAYS*86400000?'expired':row.status,askedAt:row.askedAt,resolvedAt:row.resolvedAt,resolvedMemoryId:row.resolvedMemoryId,endsAt:new Date(Date.parse(row.askedAt)+OPEN_QUESTION_DAYS*86400000).toISOString()});
  fastify.get('/api/memory/open-questions', { config }, asOwner(async (o,_r,_reply,encrypted) => ({ items:encrypted?(await encrypted.ownerQuestions({})).filter(row=>Date.parse(row.askedAt)>=Date.now()-QUESTION_KEEP_DAYS*86400000).sort((a,b)=>b.askedAt.localeCompare(a.askedAt)||a.id.localeCompare(b.id)).slice(0,200).map(ownerQuestion).sort((a,b)=>Number(a.status!=='open')-Number(b.status!=='open')):await openQuestions(o) })));
  fastify.post('/api/memory/open-questions/:id/answer', { config }, asOwner(async (o, r,_reply,encrypted) => {
    const b = bodyOf(r);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!text || text.length > 2000) throw new TrustViewError('Write the answer (at most 2,000 characters)', 400, 'invalid');
    if (b.drawer !== undefined && (typeof b.drawer !== 'string' || !DRAWER.test(b.drawer))) throw new TrustViewError('Unknown place', 400, 'invalid');
    if(encrypted){const result=await encrypted.ownerAnswerQuestion({id:r.params.id,text,drawer:parseDrawerId(String(b.drawer??'owner'))});return{question:ownerQuestion(result.question),memoryId:result.memoryId};}
    await waitingQuestion(o, r.params.id);
    const actor = actorOf(r);
    if (!actor) throw new TrustViewError('Not signed in', 401, 'invalid');
    const [kind, ...key] = String(b.drawer ?? 'owner').split(':');
    // The owner's own words: saved through the one write pipeline (owner source, so High and verified).
    const memory = await repositories.memory.create(actor, answerDraft(text, key.length ? { kind, key: key.join(':') } : { kind }) as never, 'open-question answer');
    return { question: await resolveQuestion(o, r.params.id, memory.id), memoryId: memory.id };
  }));
  fastify.post('/api/memory/open-questions/:id/forget', { config }, asOwner(async(o,r,_reply,encrypted)=>{if(!encrypted)return forgetQuestion(o,r.params.id);const result=await encrypted.ownerQuestionMutation({id:r.params.id,operation:'delete'});if(!('undo'in result))throw new TrustViewError('Question unavailable',409,'encrypted_memory_unavailable');return result;}));
  fastify.post('/api/memory/open-questions/:id/restore', { config }, asOwner(async(o,r,_reply,encrypted)=>{if(!encrypted)return{question:await restoreQuestion(o,r.params.id)};const result=await encrypted.ownerQuestionMutation({id:r.params.id,operation:'restore'});if(!('question'in result))throw new TrustViewError('Question unavailable',409,'encrypted_memory_unavailable');return{question:ownerQuestion(result)};}));
}
