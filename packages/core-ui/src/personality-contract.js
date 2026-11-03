// CORE-01c wire contract. Shared by the browser boundary and the local bridge.
export const traitNames = ['doubt', 'caution', 'creativity', 'thoroughness', 'independence', 'verbosity', 'warmth', 'curiosity', 'persistence'];
export const statuses = ['pending', 'approved', 'rejected', 'stale', 'cancelled'];
const fail = () => { throw Error('Invalid personality response'); };
const obj = x => { if (!x || typeof x !== 'object' || Array.isArray(x)) fail(); return x; };
const exact = (x, keys) => { obj(x); if (Object.keys(x).length !== keys.length || keys.some(k => !Object.hasOwn(x, k))) fail(); };
const text = (x, max = 1000) => typeof x === 'string' && x.length <= max;
const nullable = (x, max) => x === null || text(x, max);
const integer = x => Number.isSafeInteger(x) && x >= 0;
const time = x => x === null || (text(x, 40) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(x) && Number.isFinite(Date.parse(x)));
import { validAgentId } from './agent-id.js';
export const personalityAgentId = validAgentId;
export const personalityProposalId = x => typeof x === 'string' && /^[0-9a-f-]{36}$/.test(x);
export const reviewHash = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
export function personalityRoute(path) {
  const m = /^\/api\/agents\/([^/?#]+)\/personality\/proposals(?:\/([^/?#]+)(?:\/(approve|reject))?)?$/.exec(path);
  if (!m || !personalityAgentId(m[1]) || (m[2] && !personalityProposalId(m[2]))) return null;
  return { agentId: m[1], id: m[2], action: m[3] };
}
export function allowedPersonality(method, path, body) {
  const r = personalityRoute(path); if (!r) return false;
  if (method === 'GET') return !r.action && body === undefined;
  return method === 'POST' && !!r.action && !!body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).length === 1 && reviewHash(body.expectedReviewHash);
}
export function parseTraits(x) {
  exact(x, traitNames);
  if (traitNames.some(n => !integer(x[n]) || x[n] > 100)) fail();
  return Object.fromEntries(traitNames.map(n => [n, x[n]]));
}
// STORE-MAP-01 P4 (T7): a text suggestion also carries the text before and after
// (and where it came from); a trait drift looks exactly as before.
const TEXT_KEYS = ['baseTextHash','proposedTextHash','origin','baseText','proposedText'];
const MAX_TEXT = 1024 * 1024;
const textHash = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
export function parsePersonalityProposal(x) {
  const hasText = obj(x) && Object.hasOwn(x, 'proposedTextHash');
  exact(x, ['id','agentId','baseVersion','baseTraits','proposedTraits','delta','reason','evidence','source','status','createdBy','createdAt','decidedBy','decidedAt','decisionNote','appliedVersion','reviewHash', ...(hasText ? TEXT_KEYS : [])]);
  if (hasText && (!textHash(x.proposedTextHash) || !(x.baseTextHash === null || textHash(x.baseTextHash)) || ![null,'file','evolution_text'].includes(x.origin)
    || !text(x.baseText, MAX_TEXT) || !text(x.proposedText, MAX_TEXT))) fail();
  const textChanges = hasText && x.proposedTextHash !== x.baseTextHash;
  const baseTraits = parseTraits(x.baseTraits), proposedTraits = parseTraits(x.proposedTraits);
  const changed = traitNames.filter(n => baseTraits[n] !== proposedTraits[n]); exact(x.delta, changed);
  if ((!changed.length && !textChanges) || changed.some(n => x.delta[n] !== proposedTraits[n] - baseTraits[n] || Math.abs(x.delta[n]) > 5)) fail();
  if (!personalityAgentId(x.agentId) || !personalityProposalId(x.id) || !integer(x.baseVersion) || !reviewHash(x.reviewHash)
    || !text(x.reason) || !x.reason.trim() || !Array.isArray(x.evidence) || x.evidence.length > 20
    || x.evidence.some(e => !text(e,200) || !e.trim() || /[\u0000-\u001f\u007f]/.test(e))
    || !['agent','evolution','owner'].includes(x.source) || !statuses.includes(x.status)
    || !text(x.createdBy) || !x.createdBy || !time(x.createdAt) || !nullable(x.decidedBy) || !time(x.decidedAt)
    || !nullable(x.decisionNote,500) || !(x.appliedVersion === null || integer(x.appliedVersion))) fail();
  if (x.status === 'pending' && [x.decidedBy,x.decidedAt,x.decisionNote,x.appliedVersion].some(v => v !== null)) fail();
  if (x.status === 'approved' ? !integer(x.appliedVersion) || x.appliedVersion !== x.baseVersion + 1 : x.appliedVersion !== null) fail();
  if (['approved','rejected','stale'].includes(x.status) && (!x.decidedBy || !x.decidedAt)) fail();
  return { ...x, baseTraits, proposedTraits, delta: { ...x.delta }, evidence: [...x.evidence] };
}
export function parsePersonalityVersion(x) {
  // P4: a version of the one personality record names its text (textHash) once the agent has one.
  const hasText = obj(x) && Object.hasOwn(x, 'textHash');
  exact(x, ['agentId','version','traits','preset','dialect','locked','lockedTraits','source','basedOnVersion','note','createdBy','createdAt','behavior', ...(hasText ? ['textHash'] : [])]);
  if (hasText && !textHash(x.textHash)) fail();
  const dialects = ['ar-IQ','ar','en','de','fr','es','zh','ja','ko','pt-BR','ru','tr','hi'];
  const traits = parseTraits(x.traits);
  if (!personalityAgentId(x.agentId) || !integer(x.version) || !nullable(x.preset) || !dialects.includes(x.dialect)
    || typeof x.locked !== 'boolean' || !Array.isArray(x.lockedTraits) || x.lockedTraits.some(n => !traitNames.includes(n)) || new Set(x.lockedTraits).size !== x.lockedTraits.length
    || !['default','seed','owner','rollback','lock','unlock','evolution','import'].includes(x.source) || !(x.basedOnVersion === null || integer(x.basedOnVersion))
    || !nullable(x.note) || !nullable(x.createdBy) || !time(x.createdAt)) fail();
  const b = x.behavior;
  exact(b,['temperature','maxTokens','responseLength','verificationChecks','selfReviewPasses','confirmBefore','retryBudget','exploration','tone','dialect','promptBlock']);
  if (typeof b.temperature !== 'number' || b.temperature < .1 || b.temperature > 1 || !Number.isFinite(b.temperature)
    || !integer(b.maxTokens) || b.maxTokens < 512 || b.maxTokens > 4096 || !['brief','balanced','detailed'].includes(b.responseLength)
    || !integer(b.verificationChecks) || b.verificationChecks < 1 || b.verificationChecks > 5
    || !integer(b.selfReviewPasses) || b.selfReviewPasses > 3 || !['ambiguous','significant','irreversible'].includes(b.confirmBefore)
    || !integer(b.retryBudget) || b.retryBudget < 1 || b.retryBudget > 5 || !['on-scope','adjacent','explore'].includes(b.exploration)
    || !['formal','neutral','warm'].includes(b.tone) || b.dialect !== x.dialect || !text(b.promptBlock,10000)) fail();
  return { ...x, traits, lockedTraits: [...x.lockedTraits], behavior: { ...b } };
}
export function personalityResponse(path, status, body) {
  const r = personalityRoute(path); if (!r) fail();
  if (status !== 200) {
    const code = body?.code;
    const allowed = (status === 409 && ['personality_locked','already_decided','stale','review_changed'].includes(code))
      || (status === 400 && ['no_change','review_hash_required'].includes(code)) || (status === 429 && code === 'too_many_pending');
    return allowed ? { code } : null;
  }
  const scoped = value => { const p = parsePersonalityProposal(value); if (p.agentId !== r.agentId || (r.id && p.id !== r.id)) fail(); return p; };
  if (!r.id) {
    exact(body,['agentId','proposals']);
    if (body.agentId !== r.agentId || !Array.isArray(body.proposals) || body.proposals.length > 200) fail();
    const proposals = body.proposals.map(scoped); if (new Set(proposals.map(p => p.id)).size !== proposals.length) fail();
    return { agentId: r.agentId, proposals };
  }
  if (r.action === 'approve') {
    exact(body,['proposal','version']); const proposal = scoped(body.proposal), version = parsePersonalityVersion(body.version);
    if (proposal.status !== 'approved' || version.agentId !== r.agentId || version.version !== proposal.appliedVersion
      || version.createdBy !== proposal.decidedBy || !version.createdAt || proposal.decisionNote !== null
      || version.source !== 'evolution' || version.locked || version.basedOnVersion !== (proposal.baseVersion || null)
      || traitNames.some(n => version.traits[n] !== proposal.proposedTraits[n])) fail();
    return { proposal, version };
  }
  const p = scoped(body); if (r.action === 'reject' && p.status !== 'rejected') fail(); return p;
}
