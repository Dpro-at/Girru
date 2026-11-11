/** Durable local delivery receipts. Relay delivery is never execution acceptance. */
import { one, all, run, lockName, type StepRunner, type Step } from './sql-steps.js';
import { canonical, type Envelope } from '../devices/contracts.js';
export interface ComputerPeer {
    local_device_id: string;
    peer_id: string;
    workspace_id: string;
    owner_id: string;
    public_key: string;
    name: string;
    epoch: number;
    revoked: number;
}
export interface ComputerAttempt {
    local_device_id: string;
    owner_id: string;
    source_id: string;
    target_id: string;
    task_id: string;
    attempt_id: string;
    payload_hash: string;
    payload_json: string;
    epoch: number;
    state: string;
    fence: string;
    session_id: string | null;
    run_id: string | null;
    approval_id: string | null;
    status_sequence: number;
    detail: string;target_card_id?:string|null;target_card_version?:number|null;timing_json?:string|null;approval_intent_json?:string|null;source_session_id?:string|null;source_card_id?:string|null;
}
export interface ComputerDirectEndpoint {local_device_id:string;peer_id:string;owner_id:string;epoch:number;public_key:string;endpoint_url:string;binding_hash:string;expires_at:string}
function* guardedDeviceStep<T>(step:Step<T>,guard:(()=>void)|null):Step<T>{let result=step.next();while(!result.done){guard?.();try{result=step.next(yield result.value);}catch(error){result=step.throw(error);}}guard?.();return result.value;}
export class DeviceCoopRepository {
    private writeGuard:(()=>void)|null=null;
    bindWriteGuard(guard:()=>void){this.writeGuard=guard;}
    private writeTx<T>(body:()=>Step<T>){const guard=this.writeGuard;return this.runner.tx(()=>guardedDeviceStep(body(),guard));}
    private writeStep<T>(step:Step<T>){const guard=this.writeGuard;return this.runner.tx(()=>guardedDeviceStep(step,guard));}

    direct(peer:string){return this.runner.read(one<ComputerDirectEndpoint>('SELECT * FROM computer_direct_endpoints WHERE local_device_id=? AND peer_id=?',this.localId,peer));}
    async saveDirect(e:ComputerDirectEndpoint){await this.writeTx(function*(){yield* lockName('computer-direct:'+e.local_device_id+':'+e.peer_id);yield* run('DELETE FROM computer_direct_endpoints WHERE local_device_id=? AND peer_id=?',e.local_device_id,e.peer_id);yield* run('INSERT INTO computer_direct_endpoints(local_device_id,peer_id,owner_id,epoch,public_key,endpoint_url,binding_hash,expires_at) VALUES(?,?,?,?,?,?,?,?)',e.local_device_id,e.peer_id,e.owner_id,e.epoch,e.public_key,e.endpoint_url,e.binding_hash,e.expires_at);});}
    async forgetDirect(peer:string){await this.writeStep(run('DELETE FROM computer_direct_endpoints WHERE local_device_id=? AND peer_id=?',this.localId,peer));}

    constructor(readonly runner: StepRunner, readonly localId: string) { }
    peers() { return this.runner.read(all<ComputerPeer>('SELECT * FROM computer_peers WHERE local_device_id=?', this.localId)); }
    peer(id: string) { return this.runner.read(one<ComputerPeer>('SELECT * FROM computer_peers WHERE local_device_id=? AND peer_id=?', this.localId, id)); }
    async enroll(p: ComputerPeer) { await this.writeTx(function* () { yield* lockName('computer-peer:' + p.local_device_id + ':' + p.peer_id); const old = yield* one<ComputerPeer>('SELECT * FROM computer_peers WHERE local_device_id=? AND peer_id=?', p.local_device_id, p.peer_id); if(old){if(old.owner_id!==p.owner_id||old.workspace_id!==p.workspace_id||p.epoch<Number(old.epoch)||!old.revoked&&p.epoch===Number(old.epoch))throw Error('computer_peer_exists');yield* run('UPDATE computer_peers SET public_key=?,name=?,epoch=?,revoked=0 WHERE local_device_id=? AND peer_id=?',p.public_key,p.name,p.epoch,p.local_device_id,p.peer_id);return;} yield* run('INSERT INTO computer_peers(local_device_id,peer_id,workspace_id,owner_id,public_key,name,epoch,revoked) VALUES(?,?,?,?,?,?,?,0)', p.local_device_id, p.peer_id, p.workspace_id, p.owner_id, p.public_key, p.name, p.epoch); }); }
    async revoke(id: string) { const local = this.localId; await this.writeTx(function* () { yield* lockName('computer-peer:' + id); yield* run('UPDATE computer_peers SET revoked=1,epoch=epoch+1 WHERE local_device_id=? AND peer_id=?', local, id); });
        // What was still waiting to go to it, and what followed it, is dropped: it can never leave now (best effort; the store may hold no sync tables).
        try { await this.writeTx(function* () { yield* run("DELETE FROM computer_sync_records WHERE local_device_id=? AND peer_id=? AND direction='out' AND state IN ('queued','pending')", local, id); yield* run('DELETE FROM computer_sync_selections WHERE local_device_id=? AND peer_id=?', local, id); yield* run('DELETE FROM computer_delivery WHERE local_device_id=? AND peer_id=?', local, id); }); } catch { /* the revoke above already stands */ } }
    /** CP13: messages of computers that were forgotten are kept nowhere (best effort). */
    async pruneForgotten(){const local=this.localId;try{await this.writeTx(function*(){yield* run('DELETE FROM computer_delivery WHERE local_device_id=? AND peer_id IN (SELECT peer_id FROM computer_peers WHERE local_device_id=? AND revoked=1)',local,local);});}catch{/* kept for the next start */}}
    async sequence(){return Number((await this.runner.read(one<{next_sequence:number}>('SELECT next_sequence FROM computer_counters WHERE local_device_id=?',this.localId)))?.next_sequence??0);}
    async nextSequence() { const local = this.localId; return this.writeTx(function* () { yield* lockName('computer-sequence:' + local); const old = yield* one<{
        next_sequence: number;
    }>('SELECT next_sequence FROM computer_counters WHERE local_device_id=?', local); const n = Number(old?.next_sequence ?? 0) + 1; if (!Number.isSafeInteger(n))
        throw Error('computer_sequence_exhausted'); if (old)
        yield* run('UPDATE computer_counters SET next_sequence=? WHERE local_device_id=?', n, local);
    else
        yield* run('INSERT INTO computer_counters(local_device_id,next_sequence) VALUES(?,?)', local, n); return n; }); }
    async store(direction: 'in' | 'out', e: Envelope): Promise<boolean> { const local = this.localId; return this.writeTx(function* () { yield* lockName('computer-delivery:' + local + ':' + direction + ':' + e.eventId); const old = yield* one<{
        envelope_json: string;
    }>('SELECT envelope_json FROM computer_delivery WHERE local_device_id=? AND direction=? AND event_id=?', local, direction, e.eventId); const encoded = canonical(e); if (old) {
        if (old.envelope_json !== encoded)
            throw Error('computer_event_changed');
        return false;
    } const count = yield* one<{
        n: number;
    }>("SELECT COUNT(*) AS n FROM computer_delivery d WHERE d.local_device_id=? AND d.acknowledged=0 AND NOT EXISTS(SELECT 1 FROM computer_peers p WHERE p.local_device_id=d.local_device_id AND p.peer_id=d.peer_id AND p.revoked=1)", local); /* CP13: messages of forgotten computers and confirmed sends never fill the inbox. */ if (Number(count?.n) >= 20000)
        throw Error('computer_delivery_capacity'); yield* run('INSERT INTO computer_delivery(local_device_id,peer_id,direction,event_id,request_id,payload_hash,envelope_json) VALUES(?,?,?,?,?,?,?)', local, direction === 'in' ? e.sender : e.target, direction, e.eventId, e.requestId, e.fingerprint, encoded); return true; }); }
    pending() { return this.runner.read(all<{
        event_id: string;
        peer_id: string;
        envelope_json: string;
    }>("SELECT event_id,peer_id,envelope_json FROM computer_delivery WHERE local_device_id=? AND direction='out' AND acknowledged=0 ORDER BY event_id", this.localId)); }
    /** An incoming message that was handled: kept to refuse a replay, not counted as waiting. */
    async markHandled(peer: string, eventId: string) { await this.writeStep(run("UPDATE computer_delivery SET acknowledged=1 WHERE local_device_id=? AND peer_id=? AND event_id=? AND direction='in'", this.localId, peer, eventId)); }
    async acknowledge(peer: string, eventId: string) { await this.writeStep(run("UPDATE computer_delivery SET acknowledged=1 WHERE local_device_id=? AND peer_id=? AND event_id=? AND direction='out'", this.localId, peer, eventId)); }
    attempt(task: string) { return this.runner.read(one<ComputerAttempt>('SELECT * FROM computer_attempts WHERE local_device_id=? AND task_id=?', this.localId, task)); }
    attempts() { return this.runner.read(all<ComputerAttempt>('SELECT * FROM computer_attempts WHERE local_device_id=? ORDER BY task_id LIMIT 500', this.localId)); }
    async reserve(a: ComputerAttempt) { const local = this.localId; return this.writeTx(function* () { yield* lockName('computer-attempt:' + local + ':' + a.task_id); const old = yield* one<ComputerAttempt>('SELECT * FROM computer_attempts WHERE local_device_id=? AND task_id=?', local, a.task_id); if (old) {
        if (old.payload_hash !== a.payload_hash || old.source_id !== a.source_id || old.target_id !== a.target_id || old.attempt_id !== a.attempt_id)
            throw Error('computer_request_changed');
        return old;
    } const count = yield* one<{
        n: number;
    }>('SELECT COUNT(*) AS n FROM computer_attempts WHERE local_device_id=?', local); if (Number(count?.n) >= 500)
        throw Error('computer_attempt_capacity'); yield* run('INSERT INTO computer_attempts(local_device_id,owner_id,source_id,target_id,task_id,attempt_id,payload_hash,payload_json,epoch,state,fence,session_id,run_id,approval_id,status_sequence,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', local, a.owner_id, a.source_id, a.target_id, a.task_id, a.attempt_id, a.payload_hash, a.payload_json, a.epoch, a.state, a.fence, a.session_id, a.run_id, a.approval_id, a.status_sequence, a.detail); return a; }); }
    async mutate(task: string, fn: (a: ComputerAttempt) => Step<void>) { const local = this.localId; return this.writeTx(function* () { yield* lockName('computer-attempt:' + local + ':' + task); const a = yield* one<ComputerAttempt>('SELECT * FROM computer_attempts WHERE local_device_id=? AND task_id=?', local, task); if (!a)
        throw Error('computer_task_missing'); yield* fn(a); }); }
    /** Restart/restore cannot prove whether an effect happened. Never reacquire an attempt automatically. */
    async recover() { await this.writeStep(run("UPDATE computer_attempts SET state='unknown',fence='',detail='Execution interrupted; inspect the linked run before any further action.' WHERE local_device_id=? AND state IN ('accepted','running','cancel_requested')", this.localId)); }
}
