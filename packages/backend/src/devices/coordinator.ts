import {readExecutionTiming,scheduledBackgroundEnabled,type ExecutionTiming} from './task-timing.js';
import {forUpdate} from '../db/pg/dialect.js';
import type {ComputerRunAdmission} from './run-admission.js';
import type {SyncPayload} from './replication-contract.js';
/** Device-local coordination. Configured execution uses existing target-local admission, grants and owner approval. */
import { randomUUID } from 'node:crypto';
import {userActor} from '../repositories/actor.js';
import type { Actor } from '../repositories/actor.js';
import { one, all, run, lockName, dialect, type Step } from '../repositories/sql-steps.js';
import { createConversationStep,findConversation,findProject } from '../repositories/chat-conversations.js';
import { acceptChatRunStep, finishChatRunStep } from '../repositories/chat-recovery.js';
import { createCardSteps,getBoard,updateCard } from '../services/task-board.js';
import { chatRuns, liveWork } from '../services/chat-runs.js';
import { requestApproval,denyApproval,approveAndRun } from '../tools/approvals.js';
import { readTaskRules, decideTask } from './task-rules.js';
import { startSnapshot, finishWork, patchParts, saveResult, savePart, readResult, markResult, directPatch, githubPatch, bringInto, inspectPatch } from './work-result.js';
import { dataRoot } from '../config/data-root.js';
import { packProject, copyParts, unpackProject } from './project-copy.js';
import { createProject } from '../repositories/chat-conversations.js';
import { mkdirSync as mkdirCopy, writeFileSync as writeCopy, readFileSync as readCopy, existsSync as hasCopy, rmSync as rmCopy } from 'node:fs';
import pathCopy from 'node:path';
import { addComment } from '../services/task-board.js';
import { computerTaskAcceptTool, registerComputerReceiver } from './tool.js';
import { ComputerMembership } from './membership.js';
import { ComputerTransport } from './transport.js';
import { fingerprint, canonical, readEnvelope, taskPayload, presencePayload, PRODUCTION_ENROLLMENT, type TaskPayload, type Envelope } from './contracts.js';
import { redactImportText } from '../memory/import/redact.js';
import type { ComputerAttempt } from '../repositories/device-coop.js';
export interface LocalComputerBinding {
    projectId: string;
    agentId: string;agentBinding?:string;
    model: string;modelBinding?:string;
    boardId: string;
    columnId: string;
}
export class ComputerCoordinator {
    readonly transport: ComputerTransport;
    private bootId = randomUUID();
    private presence = new Map<string, {
        payload: ReturnType<typeof presencePayload.parse>;
        receivedAt: number;
        sequence: number;
    }>();
    private timer: NodeJS.Timeout | null = null;
    private unregister: () => void;
    private stopped = true;private lifecycle=0;
    private lastAdvertisement=Number.NEGATIVE_INFINITY;
    private advertising=false;
    private authorityTimer:NodeJS.Timeout|null=null;
    private syncStatusReceiver:((peer:string,payload:Extract<Envelope,{kind:'sync_status'}>['payload'])=>Promise<void>)|null=null;
    onSyncStatus(receiver:(peer:string,payload:Extract<Envelope,{kind:'sync_status'}>['payload'])=>Promise<void>){this.syncStatusReceiver=receiver;}
    async sendSyncStatus(peer:string,payload:Extract<Envelope,{kind:'sync_status'}>['payload']){return this.queue(peer,'sync_status',payload,payload.recordId);}
    private syncReceiver:((peer:string,payload:SyncPayload,epoch:number)=>Promise<void>)|null=null;
    onSync(receiver:(peer:string,payload:SyncPayload,epoch:number)=>Promise<void>){this.syncReceiver=receiver;}
    async sendSync(peer:string,payload:SyncPayload){return this.queue(peer,'sync',payload,payload.recordId);}
    constructor(readonly membership: ComputerMembership, readonly name: string, readonly binding: ReadonlyMap<string, LocalComputerBinding>, url: string, private now = Date.now,private runAdmission?:ComputerRunAdmission,existingTransport?:ComputerTransport) { if(!membership.authority.testOnly&&!runAdmission)throw Error('computer_real_admission_required');this.transport = existingTransport??new ComputerTransport(membership, url, e => this.receive(e), s => { if (s !== 'connected'&&!this.transport?.hasDirectConnection())
        this.presence.clear(); });if(existingTransport){this.transport.adoptMembership(membership,e=>this.receive(e));this.transport.setStateReceiver(s=>{if(s!=='connected'&&!this.transport.hasDirectConnection())this.presence.clear();});} this.repo.bindWriteGuard(()=>{if(this.stopped)throw Error('computer_application_stopped');}); this.unregister = registerComputerReceiver(membership.authority,membership.identity.id, (a, p) => this.accept(a, p)); }
    get repo() { return this.membership.repo; }
    async start() {const generation=this.lifecycle;await this.membership.authority.assertReady?.(); await this.membership.assertFresh();if(generation!==this.lifecycle)throw Error('computer_application_stopped'); this.stopped = false; await this.repo.recover();if(generation!==this.lifecycle)throw Error('computer_application_stopped'); await this.transport.start();if(generation!==this.lifecycle)throw Error('computer_application_stopped'); for (const a of await this.repo.attempts())
        if (a.state === 'unknown' && a.target_id === this.repo.localId)
            await this.publish(a); this.timer = setInterval(() => { void this.flush().catch(() => undefined); }, 150); this.timer.unref();if(!this.membership.authority.testOnly){this.authorityTimer=setInterval(()=>{void this.renewAuthority().catch(()=>this.closeEffects());},5000);this.authorityTimer.unref();} }
    stop() { this.stopped = true;this.lifecycle++;for(const t of this.stepWatch.values())clearInterval(t);this.stepWatch.clear();if(this.authorityTimer)clearInterval(this.authorityTimer);this.authorityTimer=null; if (this.timer)
        clearInterval(this.timer); this.timer = null; this.transport.stop(); this.unregister(); }
    private async envelope(peer: string, kind: Envelope['kind'], payload: unknown, requestId: string = randomUUID()) { const p = await this.membership.current(peer); return readEnvelope({ protocol: 'girru-computer', version: 1, workspace: this.membership.workspace, epoch: Number(p.epoch), sender: this.membership.identity.id, target: peer, eventId: randomUUID(), requestId, sequence: await this.membership.nextSequence(), sentAt: this.now(), fingerprint: fingerprint(payload), kind, payload }); }
    private async queue(peer: string, kind: Envelope['kind'], payload: unknown, requestId?: string) { if(this.stopped)throw Error('computer_application_stopped');const e = await this.envelope(peer, kind, payload, requestId); await this.repo.store('out', e); return e; }
    private flushing=false;
    async flush(){if(this.flushing||this.stopped)return;this.flushing=true;try{await this.flushOne();}finally{this.flushing=false;}}
    private async flushOne() { if (this.stopped)
        return;await this.runScheduled();if(!this.advertising&&this.now()-this.lastAdvertisement>=5000){this.advertising=true;this.lastAdvertisement=this.now();try{await this.advertise(userActor({id:this.membership.ownerId,role:'owner'}));}finally{this.advertising=false;}}await this.transport.pairingTick(); for (const a of await this.repo.attempts()) {
        if (a.target_id === this.repo.localId && a.state === 'waiting_approval' && a.approval_id) {
            const decision = await this.repo.runner.read(one<{
                status: string;
            }>('SELECT status FROM tool_approvals WHERE id=? AND user_id=?', a.approval_id, a.owner_id));
            if (decision && ['denied', 'expired', 'failed'].includes(decision.status))
                await this.change(a.task_id, decision.status === 'denied' ? 'cancelled' : 'blocked', decision.status === 'denied' ? 'The target owner declined the task.' : 'The local approval did not admit execution.');
        }
    } for (const row of await this.repo.pending()) {
        try {
            await this.transport.send(readEnvelope(row.envelope_json));
        }
        catch { /* Revoked/offline work stays local and cannot execute. */ }
    } }
    async advertise(actor: Actor, state: 'available' | 'busy' | 'paused' = 'available') { if(this.stopped)return;await this.membership.assertOwner(actor);const active=(await this.repo.attempts()).filter(a=>a.target_id===this.repo.localId&&['accepted','running','cancel_requested'].includes(a.state)).length;const own=await readTaskRules(this.membership.ownerId);if(active>own.atOnce)throw Error('computer_capacity_unknown');if(!own.takes)state='paused';else if(active&&state==='available')state='busy';const slots=await this.dispatchOptions(); for (const p of await this.repo.peers()) {
        if(this.stopped)return;try {
            const e = await this.envelope(p.peer_id, 'presence', { bootId: this.bootId, name: this.name, state, expiresAt: this.now() + 15000, capabilities: this.membership.authority.testOnly?['synthetic-task-v1']:['task-v1','selected-sync-v1'],slots,capacity:{limit:(await readTaskRules(this.membership.ownerId)).atOnce,active} });
            await this.transport.send(e);
        }
        catch { /* Presence is transient; never queued as a future live claim. */ }
    } }
    async dispatch(actor: Actor, target: string, input: unknown) { if(this.stopped)throw Error('computer_application_stopped');await this.membership.assertOwner(actor); const payload = taskPayload.parse(input);readExecutionTiming(payload.timing,this.now()); if (redactImportText(payload.text).total)
        throw Error('computer_credentials_refused'); const peer = await this.membership.current(target);if(payload.source?.conversationId){const c=await findConversation(actor.userId!,payload.source.conversationId);if(!c||c.projectId&&!await findProject(actor.userId!,c.projectId))throw Error('computer_source_conversation_changed');}if(payload.source?.cardId){if(!payload.source.boardId)throw Error('computer_source_card_changed');const card=(await getBoard(actor.userId!,payload.source.boardId)).cards.find(c=>c.id===payload.source!.cardId);if(!card||card.version!==payload.source.cardVersion)throw Error('computer_source_card_changed');}const a = await this.repo.reserve({ local_device_id: this.repo.localId, owner_id: this.membership.ownerId, source_id: this.repo.localId, target_id: target, task_id: payload.taskId, attempt_id: payload.attemptId, payload_hash: fingerprint(payload), payload_json: canonical(payload), epoch: Number(peer.epoch), state: 'queued', fence: randomUUID(), session_id: null, run_id: null, approval_id: null, status_sequence: 0, detail: 'Queued on this computer; awaiting target receipt.' }); if(a.source_id===this.repo.localId&&payload.source)await this.repo.runner.read(run('UPDATE computer_attempts SET source_session_id=?,source_card_id=? WHERE local_device_id=? AND task_id=?',payload.source.conversationId??null,payload.source.cardId??null,this.repo.localId,payload.taskId));if (a.state === 'queued')
        await this.queue(target, 'task', payload, payload.attemptId); return this.viewAttempt(a); }
    async cancel(actor: Actor, taskId: string) { await this.membership.assertOwner(actor); const a = await this.repo.attempt(taskId);if(a?.target_id===this.repo.localId&&['waiting_approval','blocked','scheduled'].includes(a.state)){if(a.approval_id)await denyApproval(a.approval_id,actor.userId!).catch(()=>undefined);await this.change(taskId,'cancelled','The target owner cancelled before execution.');return this.viewAttempt((await this.repo.attempt(taskId))!);} if (!a || a.source_id !== this.repo.localId)
        throw Error('computer_task_missing'); if (['completed', 'cancelled', 'unknown'].includes(a.state))
        return this.viewAttempt(a); await this.repo.mutate(taskId, function* (current) { yield* run("UPDATE computer_attempts SET state='cancel_requested',detail='Waiting for the target to confirm cancellation.' WHERE local_device_id=? AND task_id=?", current.local_device_id, taskId); }); await this.queue(a.target_id, 'cancel', { taskId, attemptId: a.attempt_id }, a.attempt_id); return this.viewAttempt((await this.repo.attempt(taskId))!); }
    private async resources(payload: TaskPayload) { const b = this.binding.get(payload.projectBinding); if (!b || payload.agentBinding !== (b.agentBinding??b.agentId) || payload.modelBinding !== (b.modelBinding??(/^[A-Za-z0-9_-]{1,128}$/.test(b.model)?b.model:'model-'+fingerprint(b.model).slice(0,16))))
        throw Error('computer_local_binding_missing'); const runner = this.repo.runner; const user = await runner.read(one<any>('SELECT role,status FROM users WHERE id=?', this.membership.ownerId)); const project = await runner.read(one('SELECT id FROM chat_projects WHERE id=? AND user_id=?', b.projectId, this.membership.ownerId)); const agent = await runner.read(one<any>('SELECT model FROM agents_config WHERE id=?', b.agentId)); const grant = await runner.read(one('SELECT tool_name FROM agent_tool_grants WHERE agent_id=? AND tool_name=?', b.agentId, 'computer_task_accept')); if (user?.role !== 'owner' || user.status !== 'active' || !project || agent?.model !== b.model || !grant)
        throw Error('computer_local_authority_unavailable'); return b; }
    private async receive(e: Envelope) {
        if(this.stopped)throw Error('computer_application_stopped');
        await this.membership.current(e.sender);
        if (e.kind === 'presence') {
            if (e.sentAt > this.now() + 5000 || e.payload.expiresAt <= this.now() || e.payload.expiresAt - e.sentAt > 15000)
                throw Error('computer_presence_expired');
            const old = this.presence.get(e.sender);
            if (old && old.sequence >= e.sequence)
                return;
            this.presence.set(e.sender, { payload: e.payload, receivedAt: this.now(), sequence: e.sequence });
            return;
        }
        if (e.kind === 'ack') {
            await this.repo.acknowledge(e.sender, e.payload.eventId);this.transport.acknowledge(e.sender,e.payload.eventId);
            return;
        }
        // Project copy parts are compressed bytes, checked file by file before they were packed (packProject).
        if(e.kind!=='project_part'&&redactImportText(canonical(e.payload)).total)throw Error('computer_credentials_refused');
        await this.repo.store('in', e);
        {
            if(e.kind==='sync_status'){if(!this.syncStatusReceiver)throw Error('computer_sync_unconfigured');await this.syncStatusReceiver(e.sender,e.payload);}
            else if(e.kind==='sync'){if(!this.syncReceiver)throw Error('computer_sync_unconfigured');await this.syncReceiver(e.sender,e.payload,e.epoch);}
            else if (e.kind === 'project_request' || e.kind === 'project_offer' || e.kind === 'project_part') await this.receiveCopy(e);
            else if (e.kind === 'result' || e.kind === 'result_part') { const a = await this.repo.attempt(e.payload.taskId); if (!a || a.source_id !== e.target || a.target_id !== e.sender || a.attempt_id !== e.payload.attemptId) throw Error('computer_result_binding'); if (a.state !== 'completed' && a.state !== 'running') throw Error('computer_result_state'); if (e.kind === 'result' && a.state !== 'completed') throw Error('computer_result_state'); if (e.kind === 'result_part') savePart(dataRoot(), a.task_id, e.payload.index, e.payload.text); else { const { attemptId: _attempt, ...result } = e.payload; saveResult(dataRoot(), result, e.sender); } }
            else if (e.kind === 'task')
                await this.receiveTask(e);
            else if (e.kind === 'status')
                await this.receiveStatus(e);
            else if (e.kind === 'cancel')
                await this.receiveCancel(e);
        }
        // A durable receipt is sent only after handling. Duplicate envelopes repeat the acknowledgment.
        const ack = await this.envelope(e.sender, 'ack', { eventId: e.eventId }, e.requestId);
        await this.transport.send(ack);
    }
    private async receiveTask(e: Extract<Envelope, {
        kind: 'task';
    }>) {
        const active=()=>{if(this.stopped)throw Error('computer_application_stopped');};active();const p = e.payload;
        let a = await this.repo.reserve({ local_device_id: this.repo.localId, owner_id: this.membership.ownerId, source_id: e.sender, target_id: this.repo.localId, task_id: p.taskId, attempt_id: p.attemptId, payload_hash: e.fingerprint, payload_json: canonical(p), epoch: e.epoch, state: 'waiting_approval', fence: randomUUID(), session_id: null, run_id: null, approval_id: null, status_sequence: 0, detail: 'Waiting for the owner on this computer.' });
        if (a.approval_id || a.state !== 'waiting_approval') {
            await this.publish(a);
            return;
        }
        const receiptBinding=this.binding.get(p.projectBinding);if(receiptBinding&&!a.target_card_id){const owner=this.membership.ownerId,landing=await this.landingColumn(owner,receiptBinding.boardId);await this.repo.mutate(a.task_id,function*(current){if(current.target_card_id)return;const active=yield* one<any>('SELECT role,status FROM users WHERE id=?',owner);const project=yield* one('SELECT id FROM chat_projects WHERE id=? AND user_id=?',receiptBinding.projectId,owner);if(active?.role!=='owner'||active.status!=='active'||!project)throw Error('computer_receipt_owner_changed');const card=yield* createCardSteps(owner,receiptBinding.boardId,{columnId:landing??receiptBinding.columnId,title:p.text.slice(0,160),description:'Awaiting target-local owner approval.\n\n'+p.text,agents:[receiptBinding.agentId],type:'request'},{});yield* run('UPDATE computer_attempts SET target_card_id=?,target_card_version=? WHERE local_device_id=? AND task_id=?',card.id,card.version,current.local_device_id,current.task_id);});a=(await this.repo.attempt(a.task_id))!;}
        let b: LocalComputerBinding;
        try {
            b = await this.resources(p);
        }
        catch {
            await this.change(p.taskId, 'blocked', 'Local project, model or permission is unavailable.');
            return;
        }
        // CP6: “Don't accept” ends it here; “Allow automatically” approves the same record below.
        const rules=await readTaskRules(this.membership.ownerId);
        if(!rules.takes){await this.change(p.taskId,'cancelled','This computer is not taking new tasks right now.');return;}
        const rule=decideTask(rules,e.sender,b.projectId);
        if(rule==='refuse'){await this.change(p.taskId,'cancelled','This computer does not accept tasks from your other computers for this project.');return;}
        let timing:ExecutionTiming;try{timing=readExecutionTiming(a.timing_json?JSON.parse(a.timing_json):p.timing,this.now());}catch{await this.change(a.task_id,'blocked','The requested time is no longer valid. Choose a new exact execution review.');return;}
        const preview = { timing,targetCardId:a.target_card_id??null,targetCardVersion:a.target_card_version??null,sourceDevice: e.sender, targetDevice: this.repo.localId, project: b.projectId, agent: b.agentId, model: b.model, task: p, epoch: e.epoch };
        const params = { target: this.repo.localId, taskId: p.taskId, fingerprint: fingerprint({ payload: p, preview }), preview };
        active();const approvalResult = await requestApproval(computerTaskAcceptTool, params, { workspaceDir: process.cwd(), userId: this.membership.ownerId, agentId: b.agentId }, 'other', approvalId => (function* () { active();const result = yield* run("UPDATE computer_attempts SET approval_id=? WHERE local_device_id=? AND task_id=? AND state='waiting_approval' AND approval_id IS NULL", approvalId, a.local_device_id, a.task_id); if (result.changes !== 1)
            throw Error('computer_approval_exists'); })());
        if (approvalResult.error) {
            await this.change(p.taskId, 'blocked', 'The local approval queue refused this task.');
            return;
        }
        await this.publish((await this.repo.attempt(p.taskId))!);
        if(rule==='auto')await this.allowByRule(p.taskId);
    }
    /** Approves the pending record as the owner chose in Settings; anything the approval itself requires (quorum, verification) leaves it waiting. */
    private async allowByRule(taskId:string){try{const a=await this.repo.attempt(taskId);if(!a?.approval_id||a.state!=='waiting_approval')return;const row=await this.repo.runner.read(one<any>('SELECT params_hash FROM tool_approvals WHERE id=? AND status=?',a.approval_id,'pending'));if(!row?.params_hash)return;await approveAndRun(a.approval_id,a.owner_id,row.params_hash);}catch{/* stays in Needs you for the owner */}}
    /** CP5: the card that sent a task follows it: Running, Review when done (with the result as a comment), back to the first column when refused or failed. */
    /** CP6 “Where allowed tasks go”: the column the owner named, on this project's Board; otherwise the binding's own column. */
    private async landingColumn(owner:string,boardId:string):Promise<string|null>{try{const name=(await readTaskRules(owner)).column;if(!name)return null;const board=await getBoard(owner,boardId);const col=(board as any)?.columns?.find((c:any)=>String(c.title??c.name??'').trim().toLowerCase()===name.toLowerCase());return typeof col?.id==='string'?col.id:null;}catch{return null;}}
    private async followCard(a:ComputerAttempt,state:string,detail:string){try{if(!a.source_card_id)return;const p=taskPayload.parse(JSON.parse(a.payload_json)),boardId=p.source?.boardId;if(!boardId)return;const board=await getBoard(a.owner_id,boardId),card=board.cards.find(c=>c.id===a.source_card_id);if(!card)return;const cols=[...board.columns].sort((x,y)=>x.position-y.position),find=(re:RegExp)=>cols.find(c=>re.test(c.name)),target=state==='running'||state==='accepted'?find(/progress|doing|running|working/i):state==='completed'?find(/review/i)??find(/done|finished/i):['cancelled','blocked','unknown'].includes(state)?cols[0]:undefined;if(target&&target.id!==card.columnId)await updateCard(a.owner_id,boardId,card.id,{expectedVersion:card.version,columnId:target.id});const name=(await this.repo.peer(a.target_id).catch(()=>null))?.name??'The other computer';const author={kind:'agent' as const,id:'computer:'+a.target_id},quoted='Reported by '+name+' (another of your computers):\n\n';if(state==='completed')await addComment(a.owner_id,boardId,card.id,{body:(quoted+detail).slice(0,4000)},author);else if(['cancelled','blocked','unknown'].includes(state))await addComment(a.owner_id,boardId,card.id,{body:(quoted+detail).slice(0,4000)},author);}catch{/* the card stays where the owner left it */}}
    async reviewTiming(actor:Actor,taskId:string,raw:unknown){await this.membership.assertOwner(actor);const timing=readExecutionTiming(raw,this.now()),a=await this.repo.attempt(taskId);if(!a||a.target_id!==this.repo.localId||!['waiting_approval','blocked'].includes(a.state))throw Error('computer_task_not_reviewable');if(a.approval_id)await denyApproval(a.approval_id,actor.userId!).catch(()=>undefined);const p=taskPayload.parse(JSON.parse(a.payload_json)),binding=this.binding.get(p.projectBinding);if(!binding||!a.target_card_id)throw Error('computer_target_card_missing');const card=(await getBoard(actor.userId!,binding.boardId)).cards.find(c=>c.id===a.target_card_id);if(!card)throw Error('computer_target_card_missing');const reviewed=await updateCard(actor.userId!,binding.boardId,card.id,{expectedVersion:card.version,agents:[binding.agentId]});await this.repo.mutate(taskId,function*(current){if(!['waiting_approval','blocked'].includes(current.state))throw Error('computer_task_not_reviewable');yield* run("UPDATE computer_attempts SET state='waiting_approval',approval_id=NULL,timing_json=?,target_card_version=? WHERE local_device_id=? AND task_id=?",canonical(timing),reviewed.version,current.local_device_id,current.task_id);});await this.receiveTask({protocol:'girru-computer',version:1,workspace:this.membership.workspace,epoch:a.epoch,sender:a.source_id,target:a.target_id,eventId:randomUUID(),requestId:a.attempt_id,sequence:1,sentAt:this.now(),fingerprint:a.payload_hash,kind:'task',payload:p});return this.viewAttempt((await this.repo.attempt(taskId))!);}
    private scheduling=false;
    async runScheduled(){if(this.stopped||this.scheduling||!scheduledBackgroundEnabled())return;this.scheduling=true;try{for(const a of await this.repo.attempts()){if(a.target_id!==this.repo.localId||a.state!=='scheduled')continue;const timing=readExecutionTiming(a.timing_json?JSON.parse(a.timing_json):null,this.now(),true);if(timing.mode!=='scheduled')throw Error('computer_schedule_intent_invalid');if(this.now()<timing.executeAt)continue;if(this.now()>timing.latestStartAt){await this.change(a.task_id,'blocked','The approved start window was missed. A new owner review is required.');continue;}try{await this.membership.assertOwner(userActor({id:a.owner_id,role:'owner'}));const intent=a.approval_intent_json&&JSON.parse(a.approval_intent_json),p=taskPayload.parse(JSON.parse(a.payload_json)),b=await this.resources(p),peer=await this.membership.current(a.source_id),decision=await this.repo.runner.read(one<any>('SELECT status,user_id,agent_id,params_hash FROM tool_approvals WHERE id=?',a.approval_id));if(!intent||intent.version!==1||intent.approvalId!==a.approval_id||intent.ownerId!==a.owner_id||intent.agentId!==b.agentId||intent.source!==a.source_id||intent.target!==a.target_id||intent.epoch!==a.epoch||Number(peer.epoch)!==a.epoch||intent.payloadHash!==a.payload_hash||canonical(intent.timing)!==canonical(timing)||decision?.status!=='executed'||decision.user_id!==a.owner_id||decision.agent_id!==b.agentId||decision.params_hash!==intent.paramsHash)throw Error('computer_schedule_authority_changed');await this.membership.nextSequence();await this.admit(a,b,p,a.approval_id!,'scheduled');}catch{const current=await this.repo.attempt(a.task_id);if(current?.state==='scheduled')await this.change(a.task_id,'blocked','Scheduled authority or local resources changed. A new owner review is required.');}}}finally{this.scheduling=false;}}
    private async accept(approval: {
        approvalId: string;
        userId: string;
        agentId: string;
    }, params: Record<string, unknown>) {
        if (Object.keys(params).some(k => !['target', 'taskId', 'fingerprint', 'preview'].includes(k)))
            throw Error('computer_approval_changed');
        const a = await this.repo.attempt(String(params.taskId));
        if (!a || approval.userId !== a.owner_id || approval.approvalId !== a.approval_id || a.state !== 'waiting_approval')
            throw Error('computer_approval_changed');
        const peer = await this.membership.current(a.source_id), p = taskPayload.parse(JSON.parse(a.payload_json)), b = await this.resources(p);
        if (b.agentId !== approval.agentId || Number(peer.epoch) !== a.epoch)
            throw Error('computer_authority_changed');
        const timing=readExecutionTiming(a.timing_json?JSON.parse(a.timing_json):p.timing,this.now());
        const preview = { timing,targetCardId:a.target_card_id??null,targetCardVersion:a.target_card_version??null,sourceDevice: a.source_id, targetDevice: a.target_id, project: b.projectId, agent: b.agentId, model: b.model, task: p, epoch: a.epoch };
        if (canonical(params.preview) !== canonical(preview) || params.fingerprint !== fingerprint({ payload: p, preview }))
            throw Error('computer_approval_changed');
        if(timing.mode==='scheduled'){const decision=await this.repo.runner.read(one<any>('SELECT params_hash,status,user_id,agent_id FROM tool_approvals WHERE id=?',approval.approvalId));if(decision?.status!=='approved'||decision.user_id!==a.owner_id||decision.agent_id!==b.agentId||typeof decision.params_hash!=='string')throw Error('computer_schedule_approval_changed');await this.assertTargetCard(a,b);await this.membership.nextSequence();const intent={version:1,approvalId:approval.approvalId,ownerId:a.owner_id,agentId:b.agentId,source:a.source_id,target:a.target_id,epoch:a.epoch,payloadHash:a.payload_hash,targetCardId:a.target_card_id??null,targetCardVersion:a.target_card_version??null,timing,approvedAt:this.now(),paramsHash:decision.params_hash};await this.repo.mutate(a.task_id,function*(current){if(current.state!=='waiting_approval'||current.approval_id!==approval.approvalId)throw Error('computer_attempt_claimed');yield* run("UPDATE computer_attempts SET state='scheduled',timing_json=?,approval_intent_json=?,detail='Owner approved a one-shot scheduled intent; not running yet.' WHERE local_device_id=? AND task_id=?",canonical(timing),canonical(intent),current.local_device_id,current.task_id);});await this.publish((await this.repo.attempt(a.task_id))!);return this.viewAttempt((await this.repo.attempt(a.task_id))!);}
        return this.admit(a,b,p,approval.approvalId,'waiting_approval');
    }
    private async assertTargetCard(a:ComputerAttempt,b:LocalComputerBinding){const card=await this.repo.runner.read(one<any>('SELECT c.version FROM board_cards c JOIN boards b ON b.id=c.board_id WHERE c.id=? AND c.board_id=? AND b.owner_id=?',a.target_card_id??'',b.boardId,a.owner_id));if(!card||Number(card.version)!==Number(a.target_card_version))throw Error('computer_target_card_changed');}
    private async admit(a:ComputerAttempt,b:LocalComputerBinding,p:TaskPayload,approvalId:string,expectedState:'waiting_approval'|'scheduled'){
        await this.membership.authority.assertExecutionFresh?.(a.source_id,Number(a.epoch));
        const sessionId = randomUUID(), runId = 'computer-' + randomUUID(), fence = a.fence, now = this.now(), membership = this.membership,synthetic=this.membership.authority.testOnly,clock=this.now,atOnce=(await readTaskRules(a.owner_id)).atOnce;
        await this.repo.mutate(a.task_id, function* (current) {const lock=forUpdate(yield* dialect()); if (current.state !== expectedState || current.approval_id !== approvalId || current.fence !== fence)
            throw Error('computer_attempt_claimed');if(expectedState==='scheduled'){const intent=current.approval_intent_json&&JSON.parse(current.approval_intent_json),timing=readExecutionTiming(current.timing_json?JSON.parse(current.timing_json):null,clock(),true),decision=yield* one<any>('SELECT status,user_id,agent_id,params_hash FROM tool_approvals WHERE id=?'+lock,approvalId);if(timing.mode!=='scheduled'||clock()<timing.executeAt||clock()>timing.latestStartAt||!intent||intent.epoch!==current.epoch||intent.payloadHash!==current.payload_hash||decision?.status!=='executed'||decision.user_id!==current.owner_id||decision.agent_id!==b.agentId||decision.params_hash!==intent.paramsHash)throw Error('computer_schedule_authority_changed');} const owner = yield* one<any>('SELECT role,status FROM users WHERE id=?'+lock, a.owner_id); const localPeer = yield* one<any>('SELECT epoch,revoked FROM computer_peers WHERE local_device_id=? AND peer_id=?'+lock, a.local_device_id, a.source_id); const localAgent = yield* one<any>('SELECT model FROM agents_config WHERE id=?'+lock, b.agentId); const grant = yield* one('SELECT tool_name FROM agent_tool_grants WHERE agent_id=? AND tool_name=?'+lock, b.agentId, 'computer_task_accept'); const project = yield* one('SELECT id FROM chat_projects WHERE id=? AND user_id=?'+lock, b.projectId, a.owner_id); if (owner?.role !== 'owner' || owner.status !== 'active' || !grant || !project || localAgent?.model !== b.model || localPeer?.revoked || Number(localPeer?.epoch) !== a.epoch || !membership.authority.fresh(a.local_device_id, a.source_id, a.epoch))
            throw Error('computer_authority_revoked'); yield* lockName('computer-capacity:'+a.local_device_id);const occupancy=yield* one<{n:number}>("SELECT COUNT(*) AS n FROM computer_attempts WHERE local_device_id=? AND target_id=? AND state IN ('accepted','running','cancel_requested')",a.local_device_id,a.local_device_id);if(Number(occupancy?.n)>=atOnce)throw Error('computer_capacity_unavailable');yield* createConversationStep(a.owner_id, { title: 'Task from another computer', projectId: b.projectId, agentId: b.agentId, model: b.model, mode: 'ask' }, sessionId); if(synthetic)yield* acceptChatRunStep({ run_id: runId, session_id: sessionId, user_id: a.owner_id, agent_id: b.agentId, started_at: now }, p.text); if(current.target_card_id){const card=yield* one<any>('SELECT version FROM board_cards WHERE id=? AND board_id=?'+lock,current.target_card_id,b.boardId);if(!card||Number(card.version)!==Number(current.target_card_version))throw Error('computer_target_card_changed');yield* run('UPDATE board_cards SET conversation_id=? WHERE id=? AND board_id=?',sessionId,current.target_card_id,b.boardId);}else throw Error('computer_target_card_missing'); yield* run("UPDATE computer_attempts SET state='accepted',session_id=?,run_id=?,detail='Accepted by the target owner.' WHERE local_device_id=? AND task_id=?", sessionId, runId, a.local_device_id, a.task_id); });
        if(this.runAdmission){
            await this.repo.runner.read(run('INSERT INTO computer_execution_leases(local_device_id,task_id,fence,epoch,expires_at) VALUES(?,?,?,?,?)',this.repo.localId,a.task_id,fence,a.epoch,String(this.now()+15000)));
            try{await this.noteWorkStart(a.task_id,a.owner_id,b.projectId);await this.runAdmission.start({ownerId:a.owner_id,sessionId,runId,agentId:b.agentId,projectId:b.projectId,model:b.model,text:p.text,canExecute:async()=>{try{await this.fenced(a.task_id,fence);return true;}catch{return false;}},finished:status=>this.complete(a.task_id,fence,runId,status)});const fresh=await this.repo.attempt(a.task_id);if(fresh?.state==='accepted')await this.change(a.task_id,'running','Running on the target computer.');this.watchSteps(a.task_id,runId);}catch{await this.change(a.task_id,'unknown','Normal runtime admission did not return a durable outcome. Inspect the linked run; do not retry.');}return this.viewAttempt((await this.repo.attempt(a.task_id))!);
        }
        await this.change(a.task_id, 'running', 'Synthetic executor is running on the target computer.');
        chatRuns.start({ userId: a.owner_id, sessionId, runId, agentId: b.agentId, execute: async (reply) => { await new Promise(resolve => setTimeout(resolve, 150)); await this.fenced(a.task_id, fence); if (chatRuns.get(runId)?.stopping)
                return; reply.raw.write('data: ' + JSON.stringify({ type: 'text', content: 'Synthetic task completed on ' + this.name + '.' }) + '\n\n'); }, onPersisted: async (status) => { await this.complete(a.task_id, fence, runId, status); }, onUnstored: async () => { await this.change(a.task_id, 'unknown', 'The execution result could not be durably confirmed.'); } });
        return this.viewAttempt((await this.repo.attempt(a.task_id))!);
    }
    private async complete(task: string, fence: string, runId: string, status: string) { if (this.stopped)
        throw Error('computer_execution_fenced'); const membership = this.membership; await this.repo.mutate(task, function* (a) { if (a.fence !== fence || !['accepted', 'running', 'cancel_requested'].includes(a.state) || !membership.authority.fresh(a.local_device_id, a.source_id, a.epoch))
        throw Error('computer_execution_fenced'); yield* finishChatRunStep(runId, status); yield* run('UPDATE computer_attempts SET state=?,detail=? WHERE local_device_id=? AND task_id=?', status === 'complete' ? 'completed' : status === 'stopped' ? 'cancelled' : 'unknown', status === 'complete' ? (redactImportText(chatRuns.get(runId)?.answer??'').text.replace(/\[SECRET:[^\]]+\]/gi,'[redacted local reference]').slice(0,8000)||'The target confirmed completion.') : status === 'stopped' ? 'The target confirmed cancellation.' : 'The execution failed; inspect the linked run.', a.local_device_id, a.task_id); }); await this.publish((await this.repo.attempt(task))!); if(status==='complete')void this.sendWork(task); else this.workStart.delete(task); }
    private async fenced(task: string, fence: string) { const a = await this.repo.attempt(task); if (this.stopped || !a || a.fence !== fence || !['accepted', 'running', 'cancel_requested'].includes(a.state))
        throw Error('computer_execution_fenced');await this.membership.authority.assertExecutionFresh?.(a.source_id,Number(a.epoch)); const member=await this.membership.current(a.source_id);if(Number(member.epoch)!==a.epoch)throw Error('computer_membership_epoch_changed');await this.resources(taskPayload.parse(JSON.parse(a.payload_json)));await this.membership.authority.assertReady?.();if(!this.membership.authority.testOnly){const lease=await this.repo.runner.read(one<any>('SELECT fence,epoch,expires_at,revoked FROM computer_execution_leases WHERE local_device_id=? AND task_id=?',this.repo.localId,task));const owner=await this.repo.runner.read(one<any>('SELECT role,status FROM users WHERE id=?',a.owner_id));if(!lease||lease.revoked||lease.fence!==fence||Number(lease.epoch)!==a.epoch||Number(lease.expires_at)<=this.now()||owner?.role!=='owner'||owner.status!=='active')throw Error('computer_execution_lease_expired');} }
    private async receiveStatus(e: Extract<Envelope, {
        kind: 'status';
    }>) { const p = e.payload; const before=await this.repo.attempt(p.taskId).catch(()=>null); let bound=false; await this.repo.mutate(p.taskId, function* (a) { if (a.source_id !== e.target || a.target_id !== e.sender || a.attempt_id !== p.attemptId || e.sequence <= Number(a.status_sequence))
        return; bound=true; if (['completed', 'cancelled', 'unknown'].includes(a.state) || a.state === 'cancel_requested' && ['running', 'accepted', 'scheduled', 'waiting_approval'].includes(p.state))
        return; yield* run('UPDATE computer_attempts SET state=?,session_id=?,run_id=?,detail=?,status_sequence=? WHERE local_device_id=? AND task_id=?', p.state, p.sessionId, p.runId, p.detail, e.sequence, a.local_device_id, a.task_id);if(p.targetCardId)yield* run('UPDATE computer_attempts SET target_card_id=?,timing_json=? WHERE local_device_id=? AND task_id=?',p.targetCardId,canonical(p.timing??{mode:'immediate'}),a.local_device_id,a.task_id); });/* Steps only from the bound sender of this exact attempt; dropped once the task has ended. */if(bound&&p.steps&&!['completed','cancelled','unknown'].includes(p.state))this.stepsSeen.set(p.taskId,p.steps);else if(bound&&['completed','cancelled','unknown'].includes(p.state))this.stepsSeen.delete(p.taskId);const after=await this.repo.attempt(p.taskId);if(after?.source_card_id&&after.state===p.state&&before?.state!==p.state&&!this.stopped)void this.followCard(after,p.state,p.detail); }
    private async receiveCancel(e: Extract<Envelope, {
        kind: 'cancel';
    }>) { const a = await this.repo.attempt(e.payload.taskId); if (!a || a.source_id !== e.sender || a.target_id !== e.target || a.attempt_id !== e.payload.attemptId)
        throw Error('computer_cancel_binding'); if (['waiting_approval', 'scheduled', 'blocked'].includes(a.state)) {
        await this.change(a.task_id, 'cancelled', 'The target confirmed cancellation before execution.');
        return;
    } if (['accepted', 'running'].includes(a.state)) {
        await this.change(a.task_id, 'cancel_requested', 'The target is stopping its local run.');
        if(this.runAdmission&&a.run_id){if(!await this.runAdmission.stop(a.run_id))await this.change(a.task_id,'unknown','The target cannot confirm cancellation.');return;}
        const live = a.run_id && chatRuns.get(a.run_id);
        if (live)
            live.requestStop();
        else
            await this.change(a.task_id, 'unknown', 'No live executor can confirm cancellation.');
    } }
    async freezeForRecovery(){this.stop();for(const a of await this.repo.attempts())if(!['completed','cancelled','unknown'].includes(a.state)){if(a.run_id)await this.runAdmission?.stop(a.run_id);await this.repo.runner.read(run("UPDATE computer_attempts SET state='unknown',fence='',detail='Owner recovery locked the old group; inspect target outcomes before new work.' WHERE local_device_id=? AND task_id=?",a.local_device_id,a.task_id));}}
    private async closeEffects(){for(const a of await this.repo.attempts())if(a.target_id===this.repo.localId&&['accepted','running','cancel_requested'].includes(a.state)){if(a.run_id)await this.runAdmission?.stop(a.run_id);await this.repo.mutate(a.task_id,function*(current){yield* run("UPDATE computer_attempts SET state='unknown',fence='',detail='Authority or execution lease is unavailable.' WHERE local_device_id=? AND task_id=?",current.local_device_id,current.task_id);});}}
    private renewing=false;
    private async renewAuthority(){if(this.stopped||this.renewing)return;this.renewing=true;try{await this.renewAuthorityOne();}finally{this.renewing=false;}}
    private async renewAuthorityOne(){if(this.stopped)return;await this.membership.authority.refresh?.();await this.membership.authority.assertReady?.();for(const a of await this.repo.attempts())if(a.target_id===this.repo.localId&&['accepted','running','cancel_requested'].includes(a.state)){const member=await this.membership.current(a.source_id);if(Number(member.epoch)!==a.epoch)throw Error('computer_membership_epoch_changed');const changed=await this.repo.runner.read(run('UPDATE computer_execution_leases SET expires_at=? WHERE local_device_id=? AND task_id=? AND fence=? AND revoked=0 AND expires_at>?',String(this.now()+15000),this.repo.localId,a.task_id,a.fence,String(this.now())));if(changed.changes!==1)throw Error('computer_execution_lease_lost');}}
    private async change(task: string, state: string, detail: string) { if(this.stopped)throw Error('computer_application_stopped');await this.repo.mutate(task, function* (a) { yield* run('UPDATE computer_attempts SET state=?,detail=? WHERE local_device_id=? AND task_id=?', state, detail, a.local_device_id, task); }); await this.publish((await this.repo.attempt(task))!); }
    private async publish(a: ComputerAttempt, steps?: RunStep[]) { if(this.stopped)throw Error('computer_application_stopped');if (a.source_id === this.repo.localId)
        return; await this.queue(a.source_id, 'status', { taskId: a.task_id, attemptId: a.attempt_id, state: a.state,targetCardId:a.target_card_id??null,timing:a.timing_json?JSON.parse(a.timing_json):JSON.parse(a.payload_json).timing??{mode:'immediate'}, sessionId: a.session_id, runId: a.run_id, detail: a.detail, ...(steps ? { steps } : {}) }, a.attempt_id); }
    /** CP5 steps: on the target, the running task's plan (or its newest tool steps) every few seconds, only when it changes. */
    private stepWatch = new Map<string, ReturnType<typeof setInterval>>();
    private sentSteps = new Map<string, string>();
    private watchSteps(task: string, runId: string) {
        if (this.stepWatch.has(task)) return;
        const tick = async () => {
            try {
                const a = await this.repo.attempt(task);
                if (this.stopped || !a || a.state !== 'running') { clearInterval(this.stepWatch.get(task)); this.stepWatch.delete(task); this.sentSteps.delete(task); return; }
                const run = chatRuns.get(runId); if (!run) return;
                const steps = runSteps(liveWork(run.parts)); if (!steps.length) return;
                const key = JSON.stringify(steps); if (this.sentSteps.get(task) === key) return;
                this.sentSteps.set(task, key); await this.publish(a, steps);
            } catch { /* steps are a convenience; the status still arrives */ }
        };
        const timer = setInterval(() => void tick(), 4000); (timer as any).unref?.(); this.stepWatch.set(task, timer);
    }
    /** CP10: the project folder when a task starts here, so its work can go back when it ends. */
    private workStart = new Map<string, { folder: string; start: string; back?: 'github' | 'direct' }>();
    private async noteWorkStart(task: string, owner: string, projectId: string) { try { const folder = (await findProject(owner, projectId))?.folder; if (!folder) return; const start = await startSnapshot(folder); const back = (await readTaskRules(owner).catch(() => null))?.back[projectId]; if (start) this.workStart.set(task, { folder, start, back }); } catch { /* the result then comes back as text only */ } }
    private async sendWork(task: string) {
        const w = this.workStart.get(task); this.workStart.delete(task);
        try {
            const a = await this.repo.attempt(task); if (!w || !a || a.source_id === this.repo.localId || this.stopped) return;
            const title = taskPayload.parse(JSON.parse(a.payload_json)).text.split('\n')[0];
            const { result, patch } = await finishWork({ folder: w.folder, start: w.start, computer: this.name, taskId: a.task_id, title, back: w.back });
            if (result.mode === 'none') return;
            if (result.mode === 'direct') { const parts = patchParts(patch); for (let i = 0; i < parts.length; i++) await this.queue(a.source_id, 'result_part', { taskId: a.task_id, attemptId: a.attempt_id, index: i, text: parts[i] }, a.attempt_id + '-p' + i); }
            await this.queue(a.source_id, 'result', { attemptId: a.attempt_id, ...result }, a.attempt_id + '-r');
        } catch { /* the text result already went back with the status */ }
    }
    /** CP10c: what came back for a task this computer sent (files and how), and the projects it can go into. */
    async workResult(actor: Actor, taskId: string) {
        await this.membership.assertOwner(actor); const a = await this.repo.attempt(taskId);
        if (!a || a.source_id !== this.repo.localId) throw Error('computer_task_missing');
        const r = readResult(dataRoot(), a.task_id);
        const projects = (await this.repo.runner.read(all<{ id: string; name: string }>("SELECT id, name FROM chat_projects WHERE user_id=? AND folder IS NOT NULL AND folder<>'' ORDER BY name", a.owner_id))).slice(0, 200);
        const conv = a.source_session_id ? await findConversation(a.owner_id, a.source_session_id).catch(() => null) : null;
        return { result: r ? { mode: r.mode, branch: r.branch ?? null, files: r.files, state: r.state, from: (await this.repo.peer(r.from).catch(() => null))?.name ?? 'Another computer', receivedAt: r.receivedAt } : null, projects, suggested: (conv as any)?.projectId ?? null };
    }
    /** CP10c Bring into: the work goes into the chosen project's folder, not committed, after the owner pressed it. */
    async bringWork(actor: Actor, taskId: string, projectId: string, confirmRisky = false) {
        await this.membership.assertOwner(actor); const a = await this.repo.attempt(taskId);
        if (!a || a.source_id !== this.repo.localId) throw Error('computer_task_missing');
        const r = readResult(dataRoot(), a.task_id); if (!r || r.state !== 'ready') throw Error('computer_result_unavailable');
        const folder = (await findProject(a.owner_id, projectId))?.folder; if (!folder) throw Error('computer_project_folder_missing');
        const patch = r.mode === 'direct' ? directPatch(dataRoot(), r) : r.mode === 'github' ? await githubPatch(folder, r) : null;
        if (!patch) throw Error('computer_result_unavailable');
        // The list shown is the patch's own; links, git internals and secret files never come in; CI and automation files need a second press.
        const look = await inspectPatch(patch);
        if (look.blocked.length) return { ok: false as const, blocked: look.blocked, conflicts: [] };
        if ((r.mode === 'direct' || r.mode === 'github') && (new Set(look.files).size !== new Set(r.files.map(x => x.path)).size || look.files.some(f => !r.files.some(x => x.path === f)))) throw Error('computer_result_changed');
        if (look.risky.length && !confirmRisky) return { ok: false as const, risky: look.risky, conflicts: [] };
        const done = await bringInto(folder, patch);
        if (done.ok) markResult(dataRoot(), a.task_id, 'brought');
        return done;
    }
    /** CP10a copy: asks that arrived here (another computer wants a project), and copies on their way here. */
    private copyAsks = new Map<string, { from: string; name: string; at: number }>();
    private copies = new Map<string, { to: string; name: string; parent: string; state: 'waiting' | 'receiving' | 'ready' | 'refused' | 'failed'; size?: number; sha256?: string; parts?: number; received: number; projectId?: string; at: number }>();
    private copyDir(id: string) { if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw Error('computer_copy_invalid'); return pathCopy.join(dataRoot(), 'project-copies', id); }
    async requestProjectCopy(actor: Actor, target: string, name: string, parent: string) {
        await this.membership.assertOwner(actor);
        if (typeof parent !== 'string' || !pathCopy.isAbsolute(parent) || !hasCopy(parent)) throw Error('computer_project_folder_invalid');
        const clean = (typeof name === 'string' ? name : '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 80);
        if ([...this.copies.values()].filter(c => ['waiting', 'receiving'].includes(c.state)).length >= 3) throw Error('computer_copy_busy');
        const requestId = randomUUID();
        this.copies.set(requestId, { to: target, name: clean, parent, state: 'waiting', received: 0, at: this.now() });
        await this.queue(target, 'project_request', { requestId, name: clean }, requestId);
        return { requestId };
    }
    /** On the computer that has the project: the owner allowed it, so pack it and send it. */
    async allowProjectCopy(actor: Actor, requestId: string, projectId: string) {
        await this.membership.assertOwner(actor);
        const ask = this.copyAsks.get(requestId); if (!ask) throw Error('computer_copy_missing');
        const project = await findProject(this.membership.ownerId, projectId); if (!project?.folder) throw Error('computer_project_folder_missing');
        this.copyAsks.delete(requestId);
        let packed;
        try { packed = await packProject(project.folder); }
        catch (e) { await this.queue(ask.from, 'project_offer', { requestId, state: 'failed' }, requestId + '-o'); throw e; }
        const parts = copyParts(packed.text);
        await this.queue(ask.from, 'project_offer', { requestId, state: 'allowed', name: project.name.slice(0, 80), files: packed.files, size: packed.size, sha256: packed.sha256, parts: parts.length }, requestId + '-o');
        for (let i = 0; i < parts.length; i++) await this.queue(ask.from, 'project_part', { requestId, index: i, text: parts[i] }, requestId + '-' + i);
        return { sent: true, files: packed.files, leftBehind: packed.skipped, secrets: packed.secrets };
    }
    async denyProjectCopy(actor: Actor, requestId: string) {
        await this.membership.assertOwner(actor);
        const ask = this.copyAsks.get(requestId); if (!ask) throw Error('computer_copy_missing');
        this.copyAsks.delete(requestId);
        await this.queue(ask.from, 'project_offer', { requestId, state: 'refused' }, requestId + '-o');
        return { refused: true };
    }
    private async receiveCopy(e: Envelope) {
        if (e.kind === 'project_request') { if (this.copyAsks.size >= 8) throw Error('computer_copy_busy'); this.copyAsks.set(e.payload.requestId, { from: e.sender, name: e.payload.name, at: this.now() }); return; }
        if (e.kind !== 'project_offer' && e.kind !== 'project_part') return;
        const c = this.copies.get(e.payload.requestId);
        if (!c || c.to !== e.sender) throw Error('computer_copy_binding');
        if (e.kind === 'project_offer') {
            if (c.state !== 'waiting') throw Error('computer_copy_state');
            if (e.payload.state !== 'allowed') { c.state = e.payload.state === 'refused' ? 'refused' : 'failed'; return; }
            Object.assign(c, { state: 'receiving', size: e.payload.size, sha256: e.payload.sha256, parts: e.payload.parts, name: c.name || e.payload.name || 'Project' });
            mkdirCopy(this.copyDir(e.payload.requestId), { recursive: true, mode: 0o700 });
            return;
        }
        if (c.state !== 'receiving' || !c.parts || e.payload.index >= c.parts) throw Error('computer_copy_state');
        const file = pathCopy.join(this.copyDir(e.payload.requestId), 'part-' + e.payload.index);
        if (!hasCopy(file)) { writeCopy(file, e.payload.text, { mode: 0o600 }); c.received++; }
        if (c.received < c.parts) return;
        const dir = this.copyDir(e.payload.requestId);
        try {
            const text = Array.from({ length: c.parts }, (_, i) => readCopy(pathCopy.join(dir, 'part-' + i), 'utf8')).join('');
            const got = unpackProject(text, { size: c.size!, sha256: c.sha256! }, c.parent, c.name);
            const project = await createProject(this.membership.ownerId, { name: c.name, folder: got.folder });
            c.state = 'ready'; c.projectId = project.id;
        } catch { c.state = 'failed'; }
        finally { rmCopy(dir, { recursive: true, force: true }); }
    }
    /** For the overview: asks that wait for this owner's Allow, and copies on their way here. */
    private async copyView() {
        const name = async (id: string) => (await this.repo.peer(id).catch(() => null))?.name ?? 'Another computer';
        return {
            copyAsks: await Promise.all([...this.copyAsks].map(async ([requestId, a]) => ({ requestId, fromName: await name(a.from), name: a.name }))),
            copies: await Promise.all([...this.copies].filter(([, c]) => this.now() - c.at < 86_400_000).map(async ([requestId, c]) => ({ requestId, toName: await name(c.to), name: c.name, state: c.state, received: c.received, parts: c.parts ?? 0, projectId: c.projectId ?? null }))),
        };
    }
    /** On the source: the newest steps each task reported (kept while Girru runs). */
    private stepsSeen = new Map<string, RunStep[]>();
    private viewAttempt(a: ComputerAttempt) { const labels: Record<string, string> = { queued: 'Queued on this computer', waiting_approval: 'Waiting for target approval', scheduled:'Scheduled on target', blocked: 'Target unavailable', accepted: 'Accepted by target', running: 'Running on target', completed: 'Completed on target', cancel_requested: 'Waiting for target to cancel', cancelled: 'Cancelled by target', unknown: 'Outcome needs review' }; return { statusLabel: labels[a.state] ?? 'Outcome needs review', sourceSessionId:a.source_session_id??null,sourceCardId:a.source_card_id??null,targetCardId:a.target_card_id??null,timing:a.timing_json?JSON.parse(a.timing_json):JSON.parse(a.payload_json).timing??{mode:'immediate'},taskId: a.task_id, attemptId: a.attempt_id, sourceDevice: a.source_id, targetDevice: a.target_id, state:a.state,sessionId: a.session_id, runId: a.run_id, approvalId: a.target_id === this.repo.localId ? a.approval_id : null, detail: a.detail, steps: this.stepsSeen.get(a.task_id) ?? [] }; }
    private async dispatchOptions(){return await Promise.all([...this.binding.entries()].map(async([id,b])=>({id,label:((await findProject(this.membership.ownerId,b.projectId))?.name??'Project unavailable').slice(0,120),agentBinding:b.agentBinding??b.agentId,modelBinding:b.modelBinding??(/^[A-Za-z0-9_-]{1,128}$/.test(b.model)?b.model:'model-'+fingerprint(b.model).slice(0,16))})));}
    async view(actor:Actor){
        await this.membership.assertOwner(actor);const devices=[];
        for(const p of await this.repo.peers()){const current=this.presence.get(p.peer_id),fresh=!p.revoked&&this.membership.authority.fresh(p.local_device_id,p.peer_id,Number(p.epoch));devices.push({id:p.peer_id,name:p.name,publicKey:p.public_key,epoch:Number(p.epoch),state:!fresh?'revoked':current?(current.payload.expiresAt>this.now()?current.payload.state:'offline'):'unknown',lastSeenAt:current?.receivedAt??null,dispatchOptions:current?.payload.slots??[],capacity:fresh&&current&&current.payload.expiresAt>this.now()?current.payload.capacity:null,path:fresh?this.transport.path(p.peer_id):'waiting'});}
        const names=new Map(devices.map(d=>[d.id,d.name]));names.set(this.repo.localId,this.name);
        const dispatchOptions=await this.dispatchOptions();
        return {workspace:this.membership.workspace,dispatchOptions,testOnly:this.membership.authority.testOnly,configured:true,productionEnrollment:PRODUCTION_ENROLLMENT,self:{id:this.repo.localId,name:this.name},connection:this.transport.connector.status,devices,attempts:(await this.repo.attempts()).map(a=>({...this.viewAttempt(a),sourceName:names.get(a.source_id)??'Unknown computer',targetName:names.get(a.target_id)??'Unknown computer'})),...await this.copyView()};
    }
}

type RunStep = { title: string; state: 'done' | 'now' | 'next' | 'failed' };
/** The plan when the agent made one (its titles), otherwise its newest tool steps as plain names. */
export function runSteps(work: ReturnType<typeof liveWork>): RunStep[] {
    const clean = (t: string) => t.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (work.plan?.length) return work.plan.filter(p => !p.parent).slice(0, 12).map(p => ({ title: clean(p.title) || 'Step', state: p.status === 'done' || p.status === 'skipped' ? 'done' : p.status === 'active' ? 'now' : 'next' }));
    const steps = (work.steps ?? []).slice(-6);
    return steps.map((x, i) => ({ title: clean(x.name.replace(/[_-]+/g, ' ')) || 'Step', state: x.failed ? 'failed' : x.done ? 'done' : i === steps.length - 1 ? 'now' : 'done' }));
}
