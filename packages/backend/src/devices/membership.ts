import {userActor} from '../repositories/actor.js';
import {isConfiguredComputerAuthority,type ComputerAuthority} from './authority.js';
import {lanHostAllowed} from '../phone/lan-listener.js';
import {fingerprint} from './contracts.js';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../repositories/actor.js';
import { one } from '../repositories/sql-steps.js';
import { DeviceCoopRepository, type ComputerPeer } from '../repositories/device-coop.js';
import { newPairingId, newPairingSecret, qrText, readQr, sealPairingRequest, openPairingRequest, sealChallenge, openChallenge, checkCode } from '../phone/protocol/pairing.js';
import { publicKeyText, peerKey, type Identity } from '../phone/protocol/e2e.js';
import { requireSyntheticAuthority, type SyntheticAuthority } from './synthetic-authority.js';
export class ComputerMembership {
    private pending = new Map<string, {
        secret: Buffer;
        expires: number;
        pairingId: string;
        peer?: string;
        key?: string;
        name?: string;
        code?: string;challengeEnv?:string;
    }>();
    private sequenceTail:Promise<unknown>=Promise.resolve();
    private joins=new Map<string,{request:ReturnType<ComputerMembership['request']>;challenge?:string;code?:string;name:string}>();
    constructor(readonly identity: Identity, readonly ownerId: string, readonly workspace: string, readonly repo: DeviceCoopRepository, readonly authority: ComputerAuthority, private now = Date.now) { if(authority.testOnly)requireSyntheticAuthority(authority as SyntheticAuthority);else if(!isConfiguredComputerAuthority(authority))throw Error('computer_authority_configuration_required'); if (!authority.identity(identity.id, ownerId) || repo.localId !== identity.id)
        throw Error('computer_identity_unknown'); }
    async assertOwner(actor: Actor) { await this.assertFresh(); this.authority.owner(actor); const u = await this.repo.runner.read(one<{
        role: string;
        status: string;
    }>('SELECT role,status FROM users WHERE id=?', this.ownerId)); if (u?.role !== 'owner' || u.status !== 'active')
        throw Error('computer_owner_inactive'); }
    async invite(actor: Actor, relay: string,name='Computer') { await this.assertOwner(actor);for(const [id,p]of this.pending)if(p.expires<=this.now())this.pending.delete(id);if(this.pending.size>=4)throw Error('computer_pairing_capacity'); const id = randomUUID(), pairingId = newPairingId(), secret = newPairingSecret(), expires = this.now() + 120000; this.pending.set(id, { pairingId, secret, expires }); return { id, expiresAt: expires, workspace: this.workspace, qr: qrText({ computer: this.identity, pairingId, secret, expiresAt: expires, relay,name }).replace('girru://pair?', 'girru-computer://pair?') }; }
    request(invite: {
        qr: string;
        workspace: string;
    }, name: string) { if (invite.workspace !== this.workspace || !invite.qr.startsWith('girru-computer://pair?'))
        throw Error('computer_pairing_role'); const text = invite.qr.replace('girru-computer://pair?', 'girru://pair?'); const url = new URL(text); if ([...url.searchParams.keys()].some(k => !['v', 'cid', 'ck', 'pid', 'ps', 'exp', 'relay', 'lan', 'name'].includes(k)))
        throw Error('computer_pairing_field'); const qr = readQr(text, this.now()); if (!this.authority.identity(qr.computerId, this.ownerId))
        throw Error('computer_cross_owner'); return { qr, env: sealPairingRequest(this.identity, qr.pairingId, qr.secret, { name, platform: 'computer' }) }; }
    async challenge(actor: Actor, id: string, from: string, env: string) { await this.assertOwner(actor); const p = this.pending.get(id); if (!p || p.expires <= this.now() || p.peer)
        throw Error('computer_pairing_closed'); const request = openPairingRequest(env, p.pairingId, p.secret, from); if (request.platform !== 'computer' || !this.authority.identity(from, this.ownerId))
        throw Error('computer_pairing_role'); const result = sealChallenge(this.identity, p.pairingId, p.secret, from); p.peer = from; p.key = publicKeyText(request.key); p.name = request.name; p.challengeEnv=result.env;p.code = checkCode(p.secret, this.identity.publicKey, request.key, result.challenge); return { env: result.env, code: p.code }; }
    check(request: ReturnType<ComputerMembership['request']>, env: string) { const { qr } = request; const challenge = openChallenge(env, qr.computerKey, qr.pairingId, qr.secret, this.identity.id); return checkCode(qr.secret, qr.computerKey, this.identity.publicKey, challenge); }
    async approve(actor: Actor, id: string, code: string) { await this.assertOwner(actor); const p = this.pending.get(id); if (!p || p.expires <= this.now() || !p.peer || !p.key || code !== p.code)
        throw Error('computer_pairing_not_verified'); this.pending.delete(id); const peer: ComputerPeer = { local_device_id: this.identity.id, peer_id: p.peer, workspace_id: this.workspace, owner_id: this.ownerId, public_key: p.key, name: p.name!, epoch: this.authority.epoch(this.identity.id, p.peer), revoked: 0 }; await this.repo.enroll(peer); return peer; }
    async acceptHost(actor: Actor, request: ReturnType<ComputerMembership['request']>, challenge: string, code: string, name: string) { await this.assertOwner(actor); if (this.check(request, challenge) !== code)
        throw Error('computer_pairing_not_verified'); const peer: ComputerPeer = { local_device_id: this.identity.id, peer_id: request.qr.computerId, workspace_id: this.workspace, owner_id: this.ownerId, public_key: publicKeyText(request.qr.computerKey), name, epoch: this.authority.epoch(this.identity.id, request.qr.computerId), revoked: 0 }; await this.repo.enroll(peer); return peer; }
    pairingStatus(){return {requests:[...this.pending.entries()].filter(([,p])=>p.expires>this.now()).map(([id,p])=>({id,expiresAt:p.expires,peerId:p.peer??null,name:p.name??null,checkCode:p.code??null,state:p.peer?'needs_approval':'waiting'})),joins:[...this.joins.entries()].filter(([,j])=>j.request.qr.expiresAt>this.now()).map(([id,j])=>({id,expiresAt:j.request.qr.expiresAt,peerId:j.request.qr.computerId,name:j.name,checkCode:j.code??null,state:j.code?'needs_approval':'waiting'}))};}
    pairingMailboxes(){return [...this.pending.values()].filter(p=>p.expires>this.now()).map(p=>p.pairingId).slice(0,4);}
    joiningHosts(){return [...this.joins.values()].filter(j=>j.request.qr.expiresAt>this.now()).map(j=>j.request.qr.computerId);}
    async join(actor:Actor,input:{qr:string;workspace:string;name:string}){await this.assertOwner(actor);for(const [id,j]of this.joins)if(j.request.qr.expiresAt<=this.now())this.joins.delete(id);if(this.joins.size>=4)throw Error('computer_pairing_capacity');const request=this.request(input,input.name),joinId=randomUUID();this.joins.set(joinId,{request,name:request.qr.name??'Computer'});return {id:joinId,expiresAt:request.qr.expiresAt};}
    async approveJoin(actor:Actor,id:string,code:string){await this.assertOwner(actor);const j=this.joins.get(id);if(!j?.challenge||code!==j.code)throw Error('computer_pairing_not_verified');const peer=await this.acceptHost(actor,j.request,j.challenge,code,j.name);this.joins.delete(id);return {deviceId:peer.peer_id};}
    async denyPairing(actor:Actor,id:string){await this.assertOwner(actor);this.pending.delete(id);this.joins.delete(id);}
    pendingJoinFrames(){return [...this.joins.values()].filter(j=>!j.challenge&&j.request.qr.expiresAt>this.now()).map(j=>({pairingId:j.request.qr.pairingId,env:j.request.env}));}
    async pairingFrame(from:string,env:string,via?:string):Promise<{to:string;env:string}|null>{if(via){const entry=[...this.pending.entries()].find(([,p])=>p.pairingId===via&&p.expires>this.now()&&(!p.peer||p.peer===from));if(!entry)return null;if(entry[1].peer===from&&entry[1].challengeEnv)return {to:from,env:entry[1].challengeEnv};const challenge=await this.challenge(userActor({id:this.ownerId,role:'owner'}),entry[0],from,env);return {to:from,env:challenge.env};}if(env.startsWith('g1.pchal.')){const j=[...this.joins.values()].find(j=>j.request.qr.computerId===from&&j.request.qr.expiresAt>this.now());if(!j)return null;j.code=this.check(j.request,env);j.challenge=env;}return null;}
    private directUrl(raw:string){const u=new URL(raw);return u.protocol==='ws:'&&(this.authority.testOnly?u.hostname==='127.0.0.1':lanHostAllowed(u.hostname.replace(/^\[|\]$/g,''))&&this.authority.permitDirect?.(raw)===true)&&Number.isInteger(Number(u.port))&&Number(u.port)>=1024&&Number(u.port)<=65535&&u.pathname==='/v1'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.href===raw;}
    async approveDirect(actor:Actor,peer:string,input:{url:string;epoch:number;publicKey:string;expiresAt:number}){await this.assertOwner(actor);const member=await this.current(peer);if(Object.keys(input).some(k=>!['url','epoch','publicKey','expiresAt'].includes(k))||!this.directUrl(input.url)||input.epoch!==Number(member.epoch)||input.publicKey!==member.public_key||!Number.isSafeInteger(input.expiresAt)||input.expiresAt<=this.now()||input.expiresAt>this.now()+600000)throw Error('computer_direct_approval_invalid');const record={local_device_id:this.identity.id,peer_id:peer,owner_id:this.ownerId,epoch:Number(member.epoch),public_key:member.public_key,endpoint_url:input.url,expires_at:String(input.expiresAt)};await this.repo.saveDirect({...record,binding_hash:fingerprint(record)});}
    async direct(peer:string){const e=await this.repo.direct(peer);if(!e)return null;const member=await this.current(peer);const {binding_hash,...record}=e;if(!this.directUrl(e.endpoint_url)||e.owner_id!==this.ownerId||e.epoch!==Number(member.epoch)||e.public_key!==member.public_key||Number(e.expires_at)<=this.now()||fingerprint(record)!==binding_hash)return null;return e;}
    async assertFresh(){await this.authority.assertReady?.();for(let n=0;n<3;n++)if(this.authority.freshCheckpoint(this.identity.id,await this.repo.sequence()))return;throw Error('computer_restore_freshness_unknown');}
    nextSequence(){const next=this.sequenceTail.then(async()=>{await this.assertFresh();const n=await this.repo.nextSequence();await this.authority.commitCheckpoint?.(n);this.authority.observeCheckpoint(this.identity.id,n);return n;});this.sequenceTail=next.catch(()=>undefined);return next;}
    async current(id: string) { await this.assertFresh(); const p = await this.repo.peer(id); if (!p || p.revoked || p.workspace_id !== this.workspace || p.owner_id !== this.ownerId || !this.authority.fresh(this.identity.id, id, Number(p.epoch)))
        throw Error('computer_membership_stale');await this.authority.assertPeerFresh?.(p.public_key,Number(p.epoch)); return p; }
    async revoke(actor: Actor, id: string) { await this.assertOwner(actor); if(this.authority.testOnly)this.authority.revoke(this.identity.id,id);else{if(!this.authority.revokePeer)throw Error('computer_revocation_authority_required');await this.authority.revokePeer(actor,this.identity.id,id,(await this.current(id)).epoch);}await this.repo.revoke(id); }
}
