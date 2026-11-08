import {forUpdate} from '../db/pg/dialect.js';
import type {ComputerRunAdmission} from './run-admission.js';
import type {SyncPayload} from './replication-contract.js';
/** Device-local coordination. Configured execution uses existing target-local admission, grants and owner approval. */
import { randomUUID } from 'node:crypto';
import {userActor} from '../repositories/actor.js';
import type { Actor } from '../repositories/actor.js';
import { one, run, lockName, dialect, type Step } from '../repositories/sql-steps.js';
import { createConversationStep,findConversation,findProject } from '../repositories/chat-conversations.js';
import { acceptChatRunStep, finishChatRunStep } from '../repositories/chat-recovery.js';
import { createCardSteps,getBoard } from '../services/task-board.js';
import { chatRuns } from '../services/chat-runs.js';
import { requestApproval } from '../tools/approvals.js';
import { computerTaskAcceptTool, registerComputerReceiver } from './tool.js';
import { ComputerMembership } from './membership.js';
import { ComputerTransport } from './transport.js';
import { fingerprint, canonical, readEnvelope, taskPayload, presencePayload, PRODUCTION_ENROLLMENT, type TaskPayload, type Envelope } from './contracts.js';
import { redactImportText } from '../memory/import/redact.js';
import type { ComputerAttempt } from '../repositories/device-coop.js';
export interface LocalComputerBinding {
    projectId: string;
    agentId: string;
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
    private stopped = true;
    private lastAdvertisement=Number.NEGATIVE_INFINITY;
    private advertising=false;
    private authorityTimer:NodeJS.Timeout|null=null;
    private syncStatusReceiver:((peer:string,payload:Extract<Envelope,{kind:'sync_status'}>['payload'])=>Promise<void>)|null=null;
    onSyncStatus(receiver:(peer:string,payload:Extract<Envelope,{kind:'sync_status'}>['payload'])=>Promise<void>){this.syncStatusReceiver=receiver;}
    async sendSyncStatus(peer:string,payload:Extract<Envelope,{kind:'sync_status'}>['payload']){return this.queue(peer,'sync_status',payload,payload.recordId);}
    private syncReceiver:((peer:string,payload:SyncPayload,epoch:number)=>Promise<void>)|null=null;
    onSync(receiver:(peer:string,payload:SyncPayload,epoch:number)=>Promise<void>){this.syncReceiver=receiver;}
    async sendSync(peer:string,payload:SyncPayload){return this.queue(peer,'sync',payload,payload.recordId);}
    constructor(readonly membership: ComputerMembership, readonly name: string, readonly binding: ReadonlyMap<string, LocalComputerBinding>, url: string, private now = Date.now,private runAdmission?:ComputerRunAdmission) { if(!membership.authority.testOnly&&!runAdmission)throw Error('computer_real_admission_required');this.transport = new ComputerTransport(membership, url, e => this.receive(e), s => { if (s !== 'connected'&&!this.transport?.hasDirectConnection())
        this.presence.clear(); }); this.unregister = registerComputerReceiver(membership.authority,membership.identity.id, (a, p) => this.accept(a, p)); }
    get repo() { return this.membership.repo; }
    async start() {await this.membership.authority.assertReady?.(); await this.membership.assertFresh(); this.stopped = false; await this.repo.recover(); await this.transport.start(); for (const a of await this.repo.attempts())
        if (a.state === 'unknown' && a.target_id === this.repo.localId)
            await this.publish(a); this.timer = setInterval(() => { void this.flush().catch(() => undefined); }, 150); this.timer.unref();if(!this.membership.authority.testOnly){this.authorityTimer=setInterval(()=>{void this.renewAuthority().catch(()=>this.closeEffects());},5000);this.authorityTimer.unref();} }
    stop() { this.stopped = true;if(this.authorityTimer)clearInterval(this.authorityTimer);this.authorityTimer=null; if (this.timer)
        clearInterval(this.timer); this.timer = null; this.transport.stop(); this.unregister(); }
    private async envelope(peer: string, kind: Envelope['kind'], payload: unknown, requestId: string = randomUUID()) { const p = await this.membership.current(peer); return readEnvelope({ protocol: 'girru-computer', version: 1, workspace: this.membership.workspace, epoch: Number(p.epoch), sender: this.membership.identity.id, target: peer, eventId: randomUUID(), requestId, sequence: await this.membership.nextSequence(), sentAt: this.now(), fingerprint: fingerprint(payload), kind, payload }); }
    private async queue(peer: string, kind: Envelope['kind'], payload: unknown, requestId?: string) { const e = await this.envelope(peer, kind, payload, requestId); await this.repo.store('out', e); return e; }
    async flush() { if (this.stopped)
        return;if(!this.advertising&&this.now()-this.lastAdvertisement>=5000){this.advertising=true;this.lastAdvertisement=this.now();try{await this.advertise(userActor({id:this.membership.ownerId,role:'owner'}));}finally{this.advertising=false;}}await this.transport.pairingTick(); for (const a of await this.repo.attempts()) {
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
    async advertise(actor: Actor, state: 'available' | 'busy' | 'paused' = 'available') { if(this.stopped)return;await this.membership.assertOwner(actor);const active=(await this.repo.attempts()).filter(a=>a.target_id===this.repo.localId&&['accepted','running','cancel_requested'].includes(a.state)).length;if(active>3)throw Error('computer_capacity_unknown');if(active&&state==='available')state='busy'; for (const p of await this.repo.peers()) {
        if(this.stopped)return;try {
            const e = await this.envelope(p.peer_id, 'presence', { bootId: this.bootId, name: this.name, state, expiresAt: this.now() + 15000, capabilities: this.membership.authority.testOnly?['synthetic-task-v1']:['task-v1','selected-sync-v1'],capacity:{limit:3,active} });
            await this.transport.send(e);
        }
        catch { /* Presence is transient; never queued as a future live claim. */ }
    } }
    async dispatch(actor: Actor, target: string, input: unknown) { await this.membership.assertOwner(actor); const payload = taskPayload.parse(input); if (redactImportText(payload.text).total)
        throw Error('computer_credentials_refused'); const peer = await this.membership.current(target);if(payload.source?.conversationId){const c=await findConversation(actor.userId!,payload.source.conversationId);const binding=this.binding.get(payload.projectBinding);if(!c||c.projectId!==binding?.projectId)throw Error('computer_source_conversation_changed');}if(payload.source?.cardId){if(!payload.source.boardId)throw Error('computer_source_card_changed');const card=(await getBoard(actor.userId!,payload.source.boardId)).cards.find(c=>c.id===payload.source!.cardId);if(!card||card.version!==payload.source.cardVersion)throw Error('computer_source_card_changed');}const a = await this.repo.reserve({ local_device_id: this.repo.localId, owner_id: this.membership.ownerId, source_id: this.repo.localId, target_id: target, task_id: payload.taskId, attempt_id: payload.attemptId, payload_hash: fingerprint(payload), payload_json: canonical(payload), epoch: Number(peer.epoch), state: 'queued', fence: randomUUID(), session_id: null, run_id: null, approval_id: null, status_sequence: 0, detail: 'Queued on this computer; awaiting target receipt.' }); if(a.source_id===this.repo.localId&&payload.source)await this.repo.runner.read(run('UPDATE computer_attempts SET source_session_id=?,source_card_id=? WHERE local_device_id=? AND task_id=?',payload.source.conversationId??null,payload.source.cardId??null,this.repo.localId,payload.taskId));if (a.state === 'queued')
        await this.queue(target, 'task', payload, payload.attemptId); return this.viewAttempt(a); }
    async cancel(actor: Actor, taskId: string) { await this.membership.assertOwner(actor); const a = await this.repo.attempt(taskId); if (!a || a.source_id !== this.repo.localId)
        throw Error('computer_task_missing'); if (['completed', 'cancelled', 'unknown'].includes(a.state))
        return this.viewAttempt(a); await this.repo.mutate(taskId, function* (current) { yield* run("UPDATE computer_attempts SET state='cancel_requested',detail='Waiting for the target to confirm cancellation.' WHERE local_device_id=? AND task_id=?", current.local_device_id, taskId); }); await this.queue(a.target_id, 'cancel', { taskId, attemptId: a.attempt_id }, a.attempt_id); return this.viewAttempt((await this.repo.attempt(taskId))!); }
    private async resources(payload: TaskPayload) { const b = this.binding.get(payload.projectBinding); if (!b || payload.agentBinding !== b.agentId || payload.modelBinding !== (b.modelBinding??(/^[A-Za-z0-9_-]{1,128}$/.test(b.model)?b.model:'model-'+fingerprint(b.model).slice(0,16))))
        throw Error('computer_local_binding_missing'); const runner = this.repo.runner; const user = await runner.read(one<any>('SELECT role,status FROM users WHERE id=?', this.membership.ownerId)); const project = await runner.read(one('SELECT id FROM chat_projects WHERE id=? AND user_id=?', b.projectId, this.membership.ownerId)); const agent = await runner.read(one<any>('SELECT model FROM agents_config WHERE id=?', b.agentId)); const grant = await runner.read(one('SELECT tool_name FROM agent_tool_grants WHERE agent_id=? AND tool_name=?', b.agentId, 'computer_task_accept')); if (user?.role !== 'owner' || user.status !== 'active' || !project || agent?.model !== b.model || !grant)
        throw Error('computer_local_authority_unavailable'); return b; }
    private async receive(e: Envelope) {
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
        if(redactImportText(canonical(e.payload)).total)throw Error('computer_credentials_refused');
        await this.repo.store('in', e);
        {
            if(e.kind==='sync_status'){if(!this.syncStatusReceiver)throw Error('computer_sync_unconfigured');await this.syncStatusReceiver(e.sender,e.payload);}
            else if(e.kind==='sync'){if(!this.syncReceiver)throw Error('computer_sync_unconfigured');await this.syncReceiver(e.sender,e.payload,e.epoch);}
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
        const p = e.payload;
        const a = await this.repo.reserve({ local_device_id: this.repo.localId, owner_id: this.membership.ownerId, source_id: e.sender, target_id: this.repo.localId, task_id: p.taskId, attempt_id: p.attemptId, payload_hash: e.fingerprint, payload_json: canonical(p), epoch: e.epoch, state: 'waiting_approval', fence: randomUUID(), session_id: null, run_id: null, approval_id: null, status_sequence: 0, detail: 'Waiting for the owner on this computer.' });
        if (a.approval_id || a.state !== 'waiting_approval') {
            await this.publish(a);
            return;
        }
        let b: LocalComputerBinding;
        try {
            b = await this.resources(p);
        }
        catch {
            await this.change(p.taskId, 'blocked', 'Local project, model or permission is unavailable.');
            return;
        }
        const preview = { sourceDevice: e.sender, targetDevice: this.repo.localId, project: b.projectId, agent: b.agentId, model: b.model, task: p, epoch: e.epoch };
        const params = { target: this.repo.localId, taskId: p.taskId, fingerprint: fingerprint({ payload: p, preview }), preview };
        const approvalResult = await requestApproval(computerTaskAcceptTool, params, { workspaceDir: process.cwd(), userId: this.membership.ownerId, agentId: b.agentId }, 'other', approvalId => (function* () { const result = yield* run("UPDATE computer_attempts SET approval_id=? WHERE local_device_id=? AND task_id=? AND state='waiting_approval' AND approval_id IS NULL", approvalId, a.local_device_id, a.task_id); if (result.changes !== 1)
            throw Error('computer_approval_exists'); })());
        if (approvalResult.error) {
            await this.change(p.taskId, 'blocked', 'The local approval queue refused this task.');
            return;
        }
        await this.publish((await this.repo.attempt(p.taskId))!);
    }
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
        const preview = { sourceDevice: a.source_id, targetDevice: a.target_id, project: b.projectId, agent: b.agentId, model: b.model, task: p, epoch: a.epoch };
        if (canonical(params.preview) !== canonical(preview) || params.fingerprint !== fingerprint({ payload: p, preview }))
            throw Error('computer_approval_changed');
        const sessionId = randomUUID(), runId = 'computer-' + randomUUID(), fence = a.fence, now = this.now(), membership = this.membership,synthetic=this.membership.authority.testOnly;
        await this.repo.mutate(a.task_id, function* (current) {const lock=forUpdate(yield* dialect()); if (current.state !== 'waiting_approval' || current.approval_id !== approval.approvalId || current.fence !== fence)
            throw Error('computer_attempt_claimed'); const owner = yield* one<any>('SELECT role,status FROM users WHERE id=?'+lock, a.owner_id); const localPeer = yield* one<any>('SELECT epoch,revoked FROM computer_peers WHERE local_device_id=? AND peer_id=?'+lock, a.local_device_id, a.source_id); const localAgent = yield* one<any>('SELECT model FROM agents_config WHERE id=?'+lock, b.agentId); const grant = yield* one('SELECT tool_name FROM agent_tool_grants WHERE agent_id=? AND tool_name=?'+lock, b.agentId, 'computer_task_accept'); const project = yield* one('SELECT id FROM chat_projects WHERE id=? AND user_id=?'+lock, b.projectId, a.owner_id); if (owner?.role !== 'owner' || owner.status !== 'active' || !grant || !project || localAgent?.model !== b.model || localPeer?.revoked || Number(localPeer?.epoch) !== a.epoch || !membership.authority.fresh(a.local_device_id, a.source_id, a.epoch))
            throw Error('computer_authority_revoked'); yield* lockName('computer-capacity:'+a.local_device_id);const occupancy=yield* one<{n:number}>("SELECT COUNT(*) AS n FROM computer_attempts WHERE local_device_id=? AND target_id=? AND state IN ('accepted','running','cancel_requested')",a.local_device_id,a.local_device_id);if(Number(occupancy?.n)>=3)throw Error('computer_capacity_unavailable');yield* createConversationStep(a.owner_id, { title: 'Task from another computer', projectId: b.projectId, agentId: b.agentId, model: b.model, mode: 'ask' }, sessionId); if(synthetic)yield* acceptChatRunStep({ run_id: runId, session_id: sessionId, user_id: a.owner_id, agent_id: b.agentId, started_at: now }, p.text); yield* createCardSteps(a.owner_id, b.boardId, { columnId: b.columnId, title: p.text.slice(0, 160), description: p.text, agents: [b.agentId] }, { conversationId: sessionId }); yield* run("UPDATE computer_attempts SET state='accepted',session_id=?,run_id=?,detail='Accepted by the target owner.' WHERE local_device_id=? AND task_id=?", sessionId, runId, a.local_device_id, a.task_id); });
        if(this.runAdmission){
            await this.repo.runner.read(run('INSERT INTO computer_execution_leases(local_device_id,task_id,fence,epoch,expires_at) VALUES(?,?,?,?,?)',this.repo.localId,a.task_id,fence,a.epoch,String(this.now()+15000)));
            try{await this.runAdmission.start({ownerId:a.owner_id,sessionId,runId,agentId:b.agentId,projectId:b.projectId,model:b.model,text:p.text,canExecute:async()=>{try{await this.fenced(a.task_id,fence);return true;}catch{return false;}},finished:status=>this.complete(a.task_id,fence,runId,status)});const fresh=await this.repo.attempt(a.task_id);if(fresh?.state==='accepted')await this.change(a.task_id,'running','Running on the target computer.');}catch{await this.change(a.task_id,'unknown','Normal runtime admission did not return a durable outcome. Inspect the linked run; do not retry.');}return this.viewAttempt((await this.repo.attempt(a.task_id))!);
        }
        await this.change(a.task_id, 'running', 'Synthetic executor is running on the target computer.');
        chatRuns.start({ userId: a.owner_id, sessionId, runId, agentId: b.agentId, execute: async (reply) => { await new Promise(resolve => setTimeout(resolve, 150)); await this.fenced(a.task_id, fence); if (chatRuns.get(runId)?.stopping)
                return; reply.raw.write('data: ' + JSON.stringify({ type: 'text', content: 'Synthetic task completed on ' + this.name + '.' }) + '\n\n'); }, onPersisted: async (status) => { await this.complete(a.task_id, fence, runId, status); }, onUnstored: async () => { await this.change(a.task_id, 'unknown', 'The execution result could not be durably confirmed.'); } });
        return this.viewAttempt((await this.repo.attempt(a.task_id))!);
    }
    private async complete(task: string, fence: string, runId: string, status: string) { if (this.stopped)
        throw Error('computer_execution_fenced'); const membership = this.membership; await this.repo.mutate(task, function* (a) { if (a.fence !== fence || !['accepted', 'running', 'cancel_requested'].includes(a.state) || !membership.authority.fresh(a.local_device_id, a.source_id, a.epoch))
        throw Error('computer_execution_fenced'); yield* finishChatRunStep(runId, status); yield* run('UPDATE computer_attempts SET state=?,detail=? WHERE local_device_id=? AND task_id=?', status === 'complete' ? 'completed' : status === 'stopped' ? 'cancelled' : 'unknown', status === 'complete' ? (redactImportText(chatRuns.get(runId)?.answer??'').text.replace(/\[SECRET:[^\]]+\]/gi,'[redacted local reference]').slice(0,8000)||'The target confirmed completion.') : status === 'stopped' ? 'The target confirmed cancellation.' : 'The execution failed; inspect the linked run.', a.local_device_id, a.task_id); }); await this.publish((await this.repo.attempt(task))!); }
    private async fenced(task: string, fence: string) { const a = await this.repo.attempt(task); if (this.stopped || !a || a.fence !== fence || !['accepted', 'running', 'cancel_requested'].includes(a.state))
        throw Error('computer_execution_fenced'); const member=await this.membership.current(a.source_id);if(Number(member.epoch)!==a.epoch)throw Error('computer_membership_epoch_changed');await this.resources(taskPayload.parse(JSON.parse(a.payload_json)));await this.membership.authority.assertReady?.();if(!this.membership.authority.testOnly){const lease=await this.repo.runner.read(one<any>('SELECT fence,epoch,expires_at,revoked FROM computer_execution_leases WHERE local_device_id=? AND task_id=?',this.repo.localId,task));const owner=await this.repo.runner.read(one<any>('SELECT role,status FROM users WHERE id=?',a.owner_id));if(!lease||lease.revoked||lease.fence!==fence||Number(lease.epoch)!==a.epoch||Number(lease.expires_at)<=this.now()||owner?.role!=='owner'||owner.status!=='active')throw Error('computer_execution_lease_expired');} }
    private async receiveStatus(e: Extract<Envelope, {
        kind: 'status';
    }>) { const p = e.payload; await this.repo.mutate(p.taskId, function* (a) { if (a.source_id !== e.target || a.target_id !== e.sender || a.attempt_id !== p.attemptId || e.sequence <= Number(a.status_sequence))
        return; if (['completed', 'cancelled', 'unknown'].includes(a.state) || a.state === 'cancel_requested' && ['running', 'accepted', 'waiting_approval'].includes(p.state))
        return; yield* run('UPDATE computer_attempts SET state=?,session_id=?,run_id=?,detail=?,status_sequence=? WHERE local_device_id=? AND task_id=?', p.state, p.sessionId, p.runId, p.detail, e.sequence, a.local_device_id, a.task_id); }); }
    private async receiveCancel(e: Extract<Envelope, {
        kind: 'cancel';
    }>) { const a = await this.repo.attempt(e.payload.taskId); if (!a || a.source_id !== e.sender || a.target_id !== e.target || a.attempt_id !== e.payload.attemptId)
        throw Error('computer_cancel_binding'); if (['waiting_approval', 'blocked'].includes(a.state)) {
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
    private async closeEffects(){for(const a of await this.repo.attempts())if(a.target_id===this.repo.localId&&['accepted','running','cancel_requested'].includes(a.state)){if(a.run_id)await this.runAdmission?.stop(a.run_id);await this.repo.mutate(a.task_id,function*(current){yield* run("UPDATE computer_attempts SET state='unknown',fence='',detail='Authority or execution lease is unavailable.' WHERE local_device_id=? AND task_id=?",current.local_device_id,current.task_id);});}}
    private async renewAuthority(){if(this.stopped)return;await this.membership.authority.refresh?.();await this.membership.authority.assertReady?.();for(const a of await this.repo.attempts())if(a.target_id===this.repo.localId&&['accepted','running','cancel_requested'].includes(a.state)){const member=await this.membership.current(a.source_id);if(Number(member.epoch)!==a.epoch)throw Error('computer_membership_epoch_changed');const changed=await this.repo.runner.read(run('UPDATE computer_execution_leases SET expires_at=? WHERE local_device_id=? AND task_id=? AND fence=? AND revoked=0 AND expires_at>?',String(this.now()+15000),this.repo.localId,a.task_id,a.fence,String(this.now())));if(changed.changes!==1)throw Error('computer_execution_lease_lost');}}
    private async change(task: string, state: string, detail: string) { await this.repo.mutate(task, function* (a) { yield* run('UPDATE computer_attempts SET state=?,detail=? WHERE local_device_id=? AND task_id=?', state, detail, a.local_device_id, task); }); await this.publish((await this.repo.attempt(task))!); }
    private async publish(a: ComputerAttempt) { if (a.source_id === this.repo.localId)
        return; await this.queue(a.source_id, 'status', { taskId: a.task_id, attemptId: a.attempt_id, state: a.state, sessionId: a.session_id, runId: a.run_id, detail: a.detail }, a.attempt_id); }
    private viewAttempt(a: ComputerAttempt) { const labels: Record<string, string> = { queued: 'Queued on this computer', waiting_approval: 'Waiting for target approval', blocked: 'Target unavailable', accepted: 'Accepted by target', running: 'Running on target', completed: 'Completed on target', cancel_requested: 'Waiting for target to cancel', cancelled: 'Cancelled by target', unknown: 'Outcome needs review' }; return { statusLabel: labels[a.state] ?? 'Outcome needs review', sourceSessionId:a.source_session_id??null,sourceCardId:a.source_card_id??null,taskId: a.task_id, attemptId: a.attempt_id, sourceDevice: a.source_id, targetDevice: a.target_id, state: a.state, sessionId: a.session_id, runId: a.run_id, approvalId: a.target_id === this.repo.localId ? a.approval_id : null, detail: a.detail }; }
    async view(actor:Actor){
        await this.membership.assertOwner(actor);const devices=[];
        for(const p of await this.repo.peers()){const current=this.presence.get(p.peer_id),fresh=!p.revoked&&this.membership.authority.fresh(p.local_device_id,p.peer_id,Number(p.epoch));devices.push({id:p.peer_id,name:p.name,publicKey:p.public_key,epoch:Number(p.epoch),state:!fresh?'revoked':current?(current.payload.expiresAt>this.now()?current.payload.state:'offline'):'unknown',lastSeenAt:current?.receivedAt??null,capacity:fresh&&current&&current.payload.expiresAt>this.now()?current.payload.capacity:null,path:fresh?this.transport.path(p.peer_id):'waiting'});}
        const names=new Map(devices.map(d=>[d.id,d.name]));names.set(this.repo.localId,this.name);
        const dispatchOptions=await Promise.all([...this.binding.entries()].map(async([id,b])=>({id,label:((await findProject(this.membership.ownerId,b.projectId))?.name??'Project unavailable').slice(0,120),agentBinding:b.agentId,modelBinding:b.modelBinding??(/^[A-Za-z0-9_-]{1,128}$/.test(b.model)?b.model:'model-'+fingerprint(b.model).slice(0,16))})));
        return {workspace:this.membership.workspace,dispatchOptions,testOnly:this.membership.authority.testOnly,configured:true,productionEnrollment:PRODUCTION_ENROLLMENT,self:{id:this.repo.localId,name:this.name},connection:this.transport.connector.status,devices,attempts:(await this.repo.attempts()).map(a=>({...this.viewAttempt(a),sourceName:names.get(a.source_id)??'Unknown computer',targetName:names.get(a.target_id)??'Unknown computer'}))};
    }
}
