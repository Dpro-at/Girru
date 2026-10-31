// Wire contract for the setup steps after the owner account (FIRSTRUN-01),
// shared by the browser client (session.ts) and the local bridge
// (application-server.cjs). Only these shapes pass in either direction.

import { validCompanyName } from './owner-setup-contract.js';

export const FIRST_RUN_PATH = '/api/first-run';
const STEPS = ['discovery', 'tools', 'model', 'team'];
const TOOLS = ['claude', 'codex', 'gemini'];
const record = x => typeof x === 'object' && x !== null && !Array.isArray(x);
const text = (x, max) => typeof x === 'string' && x.length <= max;
const command = x => x === null || (text(x, 300) && !/[\r\n]/.test(x));

export function firstRunRoute(path) {
  return path === FIRST_RUN_PATH || path === `${FIRST_RUN_PATH}/discovery` || path === `${FIRST_RUN_PATH}/tools` || path === `${FIRST_RUN_PATH}/local-model` || path === `${FIRST_RUN_PATH}/finish`;
}
export function allowedFirstRun(method, path, body) {
  if (!firstRunRoute(path)) return false;
  if (path === FIRST_RUN_PATH && method === 'PUT') return record(body) && Object.keys(body).every(k => ['step', 'workspaceType', 'companyName'].includes(k)) && STEPS.includes(body.step) && (!Object.hasOwn(body, 'workspaceType') || ['individual', 'company'].includes(body.workspaceType)) && (body.workspaceType === 'company' ? validCompanyName(body.companyName) : !Object.hasOwn(body, 'companyName'));
  if (path === `${FIRST_RUN_PATH}/discovery`) return ['GET', 'POST'].includes(method) && body === undefined;
  if (path === `${FIRST_RUN_PATH}/finish`) return method === 'POST' && body === undefined;
  return method === 'GET' && body === undefined;
}
const code = status => ({ code: status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 400 ? 'invalid_input' : 'unavailable' });
/** Only the known fields of each answer pass back to the page; commands are single lines. */
export function firstRunResponse(path, status, body) {
  if (status !== 200 || !record(body)) return code(status);
  if (path === `${FIRST_RUN_PATH}/discovery`) {
    const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000000;
    const keys = ['projects', 'memories', 'notes', 'skills', 'mcp', 'ssh'];
    if (!['idle', 'scanning', 'done', 'error'].includes(body.status) || !count(body.scanned) || !record(body.counts)
      || !keys.every(key => count(body.counts[key])) || !count(body.denied) || !count(body.unavailable)
      || typeof body.limited !== 'boolean' || !text(body.notice, 300)) throw Error('protocol');
    return { status: body.status, scanned: body.scanned, counts: Object.fromEntries(keys.map(key => [key, body.counts[key]])),
      denied: body.denied, unavailable: body.unavailable, limited: body.limited, notice: body.notice };
  }
  if (path === FIRST_RUN_PATH) {
    if (typeof body.pending !== 'boolean' || !STEPS.includes(body.step)) throw Error('protocol');
    if (Object.hasOwn(body, 'workspaceType') && !['individual', 'company'].includes(body.workspaceType)) throw Error('protocol');
    if (Object.hasOwn(body, 'companyName') && (body.workspaceType !== 'company' || !validCompanyName(body.companyName))) throw Error('protocol');
    return { pending: body.pending, step: body.step, ...(body.workspaceType ? { workspaceType: body.workspaceType } : {}), ...(body.workspaceType === 'company' && body.companyName ? { companyName: body.companyName } : {}) };
  }
  if (path === `${FIRST_RUN_PATH}/finish`) {
    if (body.conversationId !== null && !text(body.conversationId, 128)) throw Error('protocol');
    return { conversationId: body.conversationId };
  }
  if (path === `${FIRST_RUN_PATH}/tools`) {
    if (!Array.isArray(body.tools) || body.tools.length > 6) throw Error('protocol');
    return { tools: body.tools.filter(t => record(t) && TOOLS.includes(t.id) && text(t.name, 40) && typeof t.installed === 'boolean' && typeof t.signedIn === 'boolean' && command(t.install) && command(t.signIn) && t.signIn !== null)
      .map(t => ({ id: t.id, name: t.name, installed: t.installed, signedIn: t.signedIn, install: t.install, signIn: t.signIn, ...(t.needs === 'node' ? { needs: 'node' } : {}) })) };
  }
  if (!Array.isArray(body.choices) || body.choices.length > 6 || !Number.isFinite(body.memoryGb) || !text(body.recommended, 60) || !record(body.commands)) throw Error('protocol');
  const choices = body.choices.filter(c => record(c) && text(c.id, 60) && text(c.label, 60) && Number.isFinite(c.sizeGb) && text(c.note, 200))
    .map(c => ({ id: c.id, label: c.label, sizeGb: c.sizeGb, note: c.note, installed: c.installed === true, ...(Number.isFinite(c.minMemoryGb) && c.minMemoryGb >= 0 ? { minMemoryGb: c.minMemoryGb } : {}) }));
  const commands = Object.fromEntries(choices.map(c => [c.id, command(body.commands[c.id]) ? body.commands[c.id] ?? null : null]));
  const download = body.download === 'https://ollama.com/download' ? body.download : null;
  return { memoryGb: Math.round(body.memoryGb), recommended: body.recommended, choices, ollama: body.ollama === true,
    installed: Array.isArray(body.installed) ? body.installed.filter(n => text(n, 120)).slice(0, 100) : [], download, commands };
}
