import type {ComputerAuthority} from './authority.js';
/** Explicit disposable-test authority. Never registered by server startup or used as production identity. */
import type { Identity } from '../phone/protocol/e2e.js';
import type { Actor } from '../repositories/actor.js';
import { isOwner } from '../repositories/scope.js';
const issued = new WeakSet<object>();
export interface SyntheticAuthority extends ComputerAuthority {
    readonly testOnly: true;
    observeCheckpoint(id:string,sequence:number):void;
    freshCheckpoint(id:string,sequence:number):boolean;
    owner(actor: Actor): void;
    identity(id: string, owner: string): boolean;
    epoch(a: string, b: string): number;
    revoke(a: string, b: string): void;
    fresh(a: string, b: string, epoch: number): boolean;
}
export function createSyntheticAuthority(input: {
    disposable: true;
    ownerId: string;
    identities: Identity[];
}): SyntheticAuthority {
    if (process.env.NODE_ENV !== 'test' || input.disposable !== true || input.identities.length < 2 || input.identities.length > 16 || new Set(input.identities.map(i => i.id)).size !== input.identities.length)
        throw Error('synthetic_authority_test_only');
    const checkpoints=new Map<string,number>();
    const ids = new Set(input.identities.map(i => i.id)), epochs = new Map<string, number>(), key = (a: string, b: string) => [a, b].sort().join(':');
    const a: SyntheticAuthority = Object.freeze({ testOnly: true as const,observeCheckpoint(id:string,sequence:number){if(!ids.has(id)||!Number.isSafeInteger(sequence))throw Error('computer_checkpoint_invalid');checkpoints.set(id,Math.max(checkpoints.get(id)??0,sequence));},freshCheckpoint(id:string,sequence:number){return ids.has(id)&&sequence>=(checkpoints.get(id)??0);}, owner(actor: Actor) { if (!isOwner(actor) || actor.kind !== 'user' || actor.userId !== input.ownerId || actor.channel)
            throw Error('computer_owner_required'); }, identity(id: string, owner: string) { return owner === input.ownerId && ids.has(id); }, epoch(x: string, y: string) { if (!ids.has(x) || !ids.has(y) || x === y)
            throw Error('computer_identity_unknown'); return epochs.get(key(x, y)) ?? 1; }, revoke(x: string, y: string) { epochs.set(key(x, y), (epochs.get(key(x, y)) ?? 1) + 1); }, fresh(x: string, y: string, e: number) { return ids.has(x) && ids.has(y) && e === (epochs.get(key(x, y)) ?? 1); } });
    issued.add(a);
    return a;
}
export function requireSyntheticAuthority(value: SyntheticAuthority) { if (process.env.NODE_ENV !== 'test' || !issued.has(value))
    throw Error('production_computer_enrollment_closed'); }
