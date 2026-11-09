/** Deferred synthetic fixtures; no environment/default pool, original database or automatic provisioning. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {openOwnedPostgresMemoryProfile} from '../src/memory/encryption/owned-postgres-profile.ts';
import {one,run,atomic} from '../src/repositories/sql-steps.ts';
const input=()=>({profileId:'synthetic-profile',ownerId:'synthetic-owner',database:'synthetic_memory',schema:'memory_owned',role:'synthetic_role',serverId:'synthetic-server',connection:{host:'127.0.0.1',port:65432,database:'synthetic_memory',user:'synthetic_role',password:'synthetic-not-a-real-password',ssl:false},authorize:async()=>null});
test('owned PostgreSQL refuses missing native authorization without opening a connection',async()=>{await assert.rejects(openOwnedPostgresMemoryProfile(input()));});
test('owned PostgreSQL refuses identity mismatch before connection',async()=>{const source=input();source.authorize=async()=>({kind:'new-app-owned-encrypted-memory',profileId:source.profileId,ownerId:source.ownerId,storageId:'synthetic-storage',database:'different_database',schema:source.schema,role:source.role,serverId:source.serverId,isCurrent:()=>true});await assert.rejects(openOwnedPostgresMemoryProfile(source));});
test('owned PostgreSQL refuses insecure TLS and default connection configuration before authorization',async()=>{let calls=0;for(const connection of [undefined,{...input().connection,ssl:{rejectUnauthorized:false}},{...input().connection,database:undefined},{...input().connection,connectionString:'postgres://untrusted'}]){await assert.rejects(openOwnedPostgresMemoryProfile({...input(),connection,authorize:async()=>{calls++;return null;}}));}assert.equal(calls,0);});
/**
 * The final disposable-PG harness explicitly provisions a NEW database and a NEW
 * NONSUPERUSER NOBYPASSRLS NOINHERIT CONNECTION LIMIT 1 role, no memberships,
 * database CONNECTION LIMIT 1 owned by that role, only its dedicated schema,
 * REVOKE ALL ON DATABASE ... FROM PUBLIC, REVOKE ALL ON SCHEMA public FROM PUBLIC,
 * owner-only relation ACLs, and this empty fixture table in the dedicated schema.
 * Admin credentials stay in the harness. This module never provisions or kills sessions.
 * No fence callback may be synthesized merely to make this fixture pass.
 */
export async function acceptDisposableOwnedPostgres({nativeInput,adminInspect,provideActualServerFence}){
 const catalog=await openOwnedPostgresMemoryProfile({...nativeInput,captureServerIsolation:undefined});
 try{assert.equal(catalog.catalogVerifiedClient.exclusive,false);await catalog.catalogVerifiedClient.checkCurrent();assert.equal(catalog.isCurrent(),false);await assert.rejects(catalog.captureExclusiveProfile());await assert.rejects(catalog.runner.read(one('SELECT 1 AS n')));}finally{await catalog.close();}
 if(!provideActualServerFence)return {catalogVerified:true,exclusiveRuntime:'unsupported-no-native-server-fence'};
 const owned=await openOwnedPostgresMemoryProfile({...nativeInput,captureServerIsolation:provideActualServerFence});
 try{
  await owned.checkCurrent();assert.equal(owned.isCurrent(),true);assert.equal((await adminInspect()).sessions,1);
  await owned.runner.tx(function*(){yield* run('INSERT INTO memory_owned_fixture(id,value) VALUES(?,?)',1,'outer');try{yield* atomic(function*(){yield* run('INSERT INTO memory_owned_fixture(id,value) VALUES(?,?)',2,'rolled-back');throw new Error('synthetic rollback');});}catch{};});
  assert.equal((await owned.runner.read(one('SELECT count(*) AS n FROM memory_owned_fixture'))).n,1);
  await assert.rejects(owned.runner.tx(function*(){yield* run('INSERT INTO memory_owned_fixture(id,value) VALUES(?,?)',3,'rollback');throw new Error('synthetic outer rollback');}));
  assert.equal((await owned.runner.read(one('SELECT count(*) AS n FROM memory_owned_fixture'))).n,1);
  assert.deepEqual(owned.counts(),{activeOperations:0,openTransactions:0});await owned.captureExclusiveProfile();
  return {catalogVerified:true,exclusiveRuntime:'actual-native-fence-verified'};
 }finally{await owned.close();}
}
