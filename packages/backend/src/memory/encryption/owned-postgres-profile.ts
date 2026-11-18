/** Dedicated PostgreSQL leaf. Catalog checks are not a storage lock or protection from a server administrator. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomBytes} from 'node:crypto';
import type pg from 'pg';
import {postgresStepsOn,type SqlParam} from '../../repositories/sql-steps.js';
import {convertPlaceholders} from '../../db/pg/placeholders.js';
import {makePgTypes,type FallbackTypeParser} from '../../db/pg/types.js';
import {MemoryCipherError} from './envelope.js';
export type NativeOwnedPostgresGrant={kind:'new-app-owned-encrypted-memory'|'app-owned-encrypted-memory';profileId:string;ownerId:string;storageId:string;database:string;schema:string;role:string;serverId:string;isCurrent:()=>boolean};
/** Constructed only by a native server-isolation producer, never by an RPC DTO or an advisory lock. */
export type NativePostgresIsolationFence={profileId:string;storageId:string;serverId:string;database:string;schema:string;role:string;backendPid:number;isCurrent:()=>boolean;assertCurrent:()=>Promise<void>;release:()=>Promise<void>};
type PrivateConfig={host:string;port:number;database:string;user:string;password:string;ssl:false|{rejectUnauthorized:true;ca?:string}};
type Input={profileId:string;ownerId:string;database:string;schema:string;role:string;serverId:string;authorize:()=>Promise<NativeOwnedPostgresGrant|null>;connection:PrivateConfig;captureServerIsolation?:(actual:{profileId:string;storageId:string;serverId:string;database:string;schema:string;role:string;backendPid:number})=>Promise<NativePostgresIsolationFence|null>};
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(value);
const label=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value);
const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
/** No environment/default pool, role provisioning, database creation, session termination or reconnect. */
export async function openOwnedPostgresMemoryProfile(input:Input){
 let client:pg.Client|undefined,fence:NativePostgresIsolationFence|null=null,closed=false,revoked=false,activeOperations=0,transactionDepth=0,savepoint=0;
 let granted:NativeOwnedPostgresGrant;let backendPid=0,databaseOid=0,roleOid=0,schemaOid=0;const context=new AsyncLocalStorage<{active:boolean}>(),transactions=new AsyncLocalStorage<{child:boolean}>();let queryBusy=false;
 const fail=()=>{revoked=true;throw new MemoryCipherError();};
 const localCurrent=()=>{try{return !closed&&!revoked&&!!client&&!!granted&&granted.isCurrent()&&!!fence&&fence.isCurrent();}catch{return false;}};
 const query=async(text:string,values:unknown[]=[])=>{if(!client||closed||queryBusy)throw new MemoryCipherError();queryBusy=true;activeOperations++;try{return await client.query(text,values);}finally{queryBusy=false;activeOperations--;}};
 // Privileged server operators are outside this local guarantee. A real server isolation
 // fence is mandatory: connection limits/catalog observations alone are not exclusive ownership.
 const catalogCurrent=async()=>{
  if(!granted?.isCurrent()||closed||revoked)fail();
  const result=await query(`SELECT pg_backend_pid() AS pid,current_database() AS db,session_user::text AS session_role,current_user::text AS effective_role,
   d.oid::int AS database_oid,d.datdba::int AS database_owner,d.datconnlimit,d.datallowconn,d.datistemplate,
   r.oid::int AS role_oid,r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolcanlogin,r.rolreplication,r.rolbypassrls,r.rolconnlimit,
   n.oid::int AS schema_oid,n.nspowner::int AS schema_owner,current_setting('search_path') AS search_path,
   (SELECT count(*)::int FROM pg_catalog.pg_stat_activity a WHERE a.datid=d.oid) AS sessions,
   EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS memberships,
   EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(d.datacl,pg_catalog.acldefault('d',d.datdba))) a WHERE a.grantee<>r.oid) AS database_shared,
   EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(n.nspacl,pg_catalog.acldefault('n',n.nspowner))) a WHERE a.grantee<>r.oid) AS schema_shared,
   EXISTS(SELECT 1 FROM pg_catalog.pg_namespace x WHERE x.nspname NOT LIKE 'pg_%' AND x.nspname<>'information_schema' AND x.oid<>n.oid AND
    (has_schema_privilege(r.oid,x.oid,'CREATE') OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace=x.oid))) AS other_storage,
   EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace=n.oid AND (c.relowner<>r.oid OR c.relkind NOT IN ('r','i','S','t','p','I') OR c.relrowsecurity OR c.relforcerowsecurity OR
    EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a WHERE a.grantee<>r.oid))) AS unsafe_relations,
   EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace=n.oid) AS custom_functions,
   EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=n.oid AND NOT t.tgisinternal) AS user_triggers,
   EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite w JOIN pg_catalog.pg_class c ON c.oid=w.ev_class WHERE c.relnamespace=n.oid) AS rewrite_rules,
   EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl a WHERE a.defaclrole=r.oid AND EXISTS(SELECT 1 FROM pg_catalog.aclexplode(a.defaclacl) e WHERE e.grantee<>r.oid)) AS shared_defaults,
   EXISTS(SELECT 1 FROM pg_catalog.pg_foreign_server) AS foreign_servers,
   EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger) AS event_triggers,
   EXISTS(SELECT 1 FROM pg_catalog.pg_extension e WHERE e.extname<>'plpgsql') AS extensions
   FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.rolname=$2 JOIN pg_catalog.pg_namespace n ON n.nspname=$3 WHERE d.datname=$1`,[input.database,input.role,input.schema]);
  const r=result.rows[0];if(result.rows.length!==1||!r||r.pid!==backendPid||r.db!==input.database||r.session_role!==input.role||r.effective_role!==input.role||r.database_owner!==r.role_oid||r.schema_owner!==r.role_oid||r.datconnlimit!==1||!r.datallowconn||r.datistemplate||r.rolsuper||r.rolinherit||r.rolcreaterole||r.rolcreatedb||!r.rolcanlogin||r.rolreplication||r.rolbypassrls||r.rolconnlimit!==1||r.sessions!==1||r.search_path!==quote(input.schema)+', pg_catalog'||['memberships','database_shared','schema_shared','other_storage','unsafe_relations','custom_functions','user_triggers','rewrite_rules','shared_defaults','foreign_servers','event_triggers','extensions'].some(k=>r[k]!==false))fail();
  if(databaseOid&&(r.database_oid!==databaseOid||r.role_oid!==roleOid||r.schema_oid!==schemaOid))fail();databaseOid=r.database_oid;roleOid=r.role_oid;schemaOid=r.schema_oid;
  if(!granted.isCurrent())fail();
 };
 const checkCurrent=async()=>{if(!localCurrent())fail();await fence!.assertCurrent();if(!localCurrent())fail();await catalogCurrent();if(!localCurrent())fail();};
 const stop=async()=>{revoked=true;if(closed)return;if(activeOperations||transactionDepth)throw new MemoryCipherError();closed=true;try{await client?.end();}finally{await fence?.release();}};
 try{
  if(process.versions.electron||!label(input.profileId)||!label(input.ownerId)||!label(input.serverId)||![input.database,input.schema,input.role].every(id)||input.schema==='public'||input.schema.startsWith('pg_')||typeof input.authorize!=='function'||input.captureServerIsolation!==undefined&&typeof input.captureServerIsolation!=='function')throw new MemoryCipherError();
  const cfg=input.connection;if(!cfg||Object.keys(cfg).some(k=>!['host','port','database','user','password','ssl'].includes(k))||typeof cfg.host!=='string'||!cfg.host||cfg.host.length>1024||/[\u0000-\u001f]/.test(cfg.host)||!Number.isSafeInteger(cfg.port)||cfg.port<1||cfg.port>65535||cfg.database!==input.database||cfg.user!==input.role||cfg.ssl===false&&!['127.0.0.1','::1','localhost'].includes(cfg.host)&&!cfg.host.startsWith('/')||typeof cfg.password!=='string'||cfg.password.length<1||Buffer.byteLength(cfg.password)>4096||cfg.ssl!==false&&(!cfg.ssl||cfg.ssl.rejectUnauthorized!==true||Object.keys(cfg.ssl).some(k=>!['rejectUnauthorized','ca'].includes(k))))throw new MemoryCipherError();
  const grant=await input.authorize();if(!grant||!['new-app-owned-encrypted-memory','app-owned-encrypted-memory'].includes(grant.kind)||grant.profileId!==input.profileId||grant.ownerId!==input.ownerId||grant.database!==input.database||grant.schema!==input.schema||grant.role!==input.role||grant.serverId!==input.serverId||!label(grant.storageId)||typeof grant.isCurrent!=='function'||!grant.isCurrent())throw new MemoryCipherError();granted={...grant,isCurrent:grant.isCurrent.bind(grant)};
  const imported=await import('pg'),module=(imported.default??imported);if(!granted.isCurrent())throw new MemoryCipherError();
  client=new module.Client({host:cfg.host,port:cfg.port,database:cfg.database,user:cfg.user,password:cfg.password,ssl:cfg.ssl,application_name:'girru-owned-memory-'+randomBytes(16).toString('hex'),connectionTimeoutMillis:10000,query_timeout:10000,statement_timeout:10000,types:makePgTypes(module.types.getTypeParser as unknown as FallbackTypeParser),options:'-c TimeZone=UTC -c search_path='+quote(input.schema)+',pg_catalog'});
  client.on('error',()=>{revoked=true;});await client.connect();if(!granted.isCurrent())throw new MemoryCipherError();
  await query("SELECT pg_catalog.set_config('search_path',$1,false)",[quote(input.schema)+', pg_catalog']);
  backendPid=(await query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;if(!Number.isSafeInteger(backendPid)||backendPid<1)throw new MemoryCipherError();
  await catalogCurrent();if(input.captureServerIsolation)fence=await input.captureServerIsolation({profileId:input.profileId,storageId:granted.storageId,serverId:input.serverId,database:input.database,schema:input.schema,role:input.role,backendPid});
  if(input.captureServerIsolation&&(!fence||fence.profileId!==input.profileId||fence.storageId!==granted.storageId||fence.serverId!==input.serverId||fence.database!==input.database||fence.schema!==input.schema||fence.role!==input.role||fence.backendPid!==backendPid||typeof fence.isCurrent!=='function'||typeof fence.assertCurrent!=='function'||typeof fence.release!=='function'||!fence.isCurrent()))throw new MemoryCipherError();
  if(fence)await checkCurrent();
  const operation=async<T>(body:()=>Promise<T>):Promise<T>=>{const prior=context.getStore();if(prior){if(!prior.active)throw new MemoryCipherError();return body();}if(activeOperations)throw new MemoryCipherError();const token={active:true};activeOperations++;try{return await context.run(token,async()=>{await checkCurrent();const result=await body();await checkCurrent();return result;});}finally{token.active=false;activeOperations--;if(revoked&&!transactionDepth)await stop();}};
  // These steps originate in trusted backend repositories. This is not a SQL sandbox
  // for model/renderer strings; the dedicated native fence remains mandatory.
  const execute=async(sql:string,params:SqlParam[])=>operation(async()=>{if(typeof sql!=='string'||Buffer.byteLength(sql)>1024*1024||sql.includes(';')||!/^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH|LOCK)\b/i.test(sql))throw new MemoryCipherError();const converted=convertPlaceholders(sql);if(converted.count!==params.length)throw new MemoryCipherError();await checkCurrent();const result=await query(converted.text,params);await checkCurrent();return result;});
  const transaction=async<T>(body:()=>Promise<T>):Promise<T>=>operation(async()=>{const parent=transactions.getStore();if(parent?.child)throw new MemoryCipherError();if(parent)parent.child=true;let began=false,finished=false;const nested=transactionDepth>0,name='owned_memory_'+(++savepoint);try{return await transactions.run({child:false},async()=>{await checkCurrent();await query(nested?'SAVEPOINT '+name:'BEGIN ISOLATION LEVEL READ COMMITTED');began=true;transactionDepth++;try{await checkCurrent();const value=await body();await checkCurrent();await query(nested?'RELEASE SAVEPOINT '+name:'COMMIT');finished=true;transactionDepth--;await checkCurrent();return value;}catch(error){if(began&&!finished){try{await query(nested?'ROLLBACK TO SAVEPOINT '+name:'ROLLBACK');if(nested)await query('RELEASE SAVEPOINT '+name);}catch{revoked=true;}transactionDepth--;}throw error;}});}finally{if(parent)parent.child=false;}});
  const runner=postgresStepsOn({one:async<T>(sql:string,...params:SqlParam[])=>{const result=await execute(sql,params);return result.rows[0] as T|undefined;},all:async<T>(sql:string,...params:SqlParam[])=>{const result=await execute(sql,params);return result.rows as T[];},run:async(sql:string,...params:SqlParam[])=>({changes:(await execute(sql,params)).rowCount??0}),tx:transaction,inTransaction:()=>transactionDepth>0});
  return Object.freeze({catalogVerifiedClient:Object.freeze({exclusive:false as const,profileId:input.profileId,storageId:granted.storageId,backendPid,checkCurrent:catalogCurrent}),runner,profileId:input.profileId,storageId:granted.storageId,isCurrent:localCurrent,checkCurrent,captureExclusiveProfile:async()=>{await checkCurrent();return Object.freeze({profileId:input.profileId,storageId:granted.storageId,isCurrent:localCurrent});},counts:()=>({activeOperations,openTransactions:transactionDepth}),revoke:stop,close:stop});
 }catch{revoked=true;try{await client?.end();}catch{}try{await fence?.release();}catch{}closed=true;throw new MemoryCipherError();}
}
