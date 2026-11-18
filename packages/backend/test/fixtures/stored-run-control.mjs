/** Deferred actual synthetic SQLite claim fixtures; native delegation and OS custody are deliberately absent. */
import Database from 'better-sqlite3';
import {sqliteStepsOn} from '../../src/repositories/sql-steps.ts';
import {loadStep} from '../../src/tools/agent-permissions.ts';
import {loadSnapshotStep} from '../../src/memory/scopes/access.ts';
import {captureStoredRunControlClaim,inspectStoredRunControlClaim,installStoredRunTaskScopeCapture,storedRunDigest as hash,storedRunModelPolicyHash} from '../../src/memory/encryption/stored-run-control.ts';
import {initializeStoredRunBindingsStep} from '../../src/memory/encryption/stored-run-binding.ts';
export async function createStoredRunControlFixture(){
 const db=new Database(':memory:'),runner=sqliteStepsOn(db);db.exec(`
 CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,status TEXT,token_version INTEGER);
 CREATE TABLE agents_config(id TEXT PRIMARY KEY,name TEXT,provider TEXT,model TEXT,system_prompt TEXT,temperature REAL,max_tokens INTEGER,cron_schedule TEXT,cron_enabled INTEGER);
 CREATE TABLE task_runs(id TEXT PRIMARY KEY,task_id TEXT,agent_id TEXT,user_id TEXT,status TEXT,cancel_requested INTEGER,lease_owner TEXT,lease_generation INTEGER,lease_expires_at INTEGER,input_encrypted TEXT,input_iv TEXT,input_tag TEXT,contract_encrypted TEXT,contract_iv TEXT,contract_tag TEXT,status_reason TEXT,segment_started_ms INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE task_contracts(task_id TEXT PRIMARY KEY,contract_encrypted TEXT,contract_iv TEXT,contract_tag TEXT);
 CREATE TABLE agent_permissions(agent_id TEXT,memory_read TEXT,memory_write TEXT,shared_memory INTEGER,modes TEXT,version INTEGER);
 CREATE TABLE memory_access_versions(owner_id TEXT,version INTEGER);
 CREATE TABLE memory_access_rules(id TEXT,owner_id TEXT,scope_kind TEXT,scope_id TEXT,agent_id TEXT,drawer_kind TEXT,read_mode TEXT,write_mode TEXT,ends_at TEXT,reason TEXT,created_by TEXT,created_at TEXT);
 CREATE TABLE memory_access_scope_rules AS SELECT * FROM memory_access_rules;
 CREATE TABLE memory_role_templates(id TEXT,owner_id TEXT,name TEXT,norm_name TEXT,memory_read TEXT,memory_write TEXT,scope_read TEXT,scope_write TEXT);
 CREATE TABLE memory_agent_roles(owner_id TEXT,agent_id TEXT,template_id TEXT);
 CREATE TABLE memory_project_scopes(owner_id TEXT,slug TEXT,department_id TEXT);CREATE TABLE memory_project_kinds(owner_id TEXT,slug TEXT,kind TEXT);
 INSERT INTO users VALUES('owner','owner','active',1);
 INSERT INTO agents_config VALUES('agent','Synthetic','ollama','synthetic-local',NULL,0,1000,'* * * * *',1);
 `);const expiry=Date.now()+30000;db.prepare('INSERT INTO task_runs(id,task_id,agent_id,user_id,status,cancel_requested,lease_owner,lease_generation,lease_expires_at,input_encrypted,input_iv,input_tag,contract_encrypted,contract_iv,contract_tag) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('run','task','agent','owner','running',0,'worker',1,expiry,'synthetic-cipher','iv','tag',null,null,null);
 await runner.tx(()=>initializeStoredRunBindingsStep());const permissions=await runner.read(loadStep('agent')),access=await runner.read(loadSnapshotStep('owner')),taskHash='a'.repeat(64),definition={kind:'task',taskId:'task'},scope={v:1,ownerId:'owner',agentId:'agent',definition,taskHash,contractHash:hash(null),permissionsHash:hash({permissions:[permissions],access}),scheduleHash:hash({schedule:'* * * * *',enabled:1}),modelPolicyHash:storedRunModelPolicyHash({provider:'ollama',model:'synthetic-local',system_prompt:null,temperature:0,max_tokens:1000}),modelPolicy:'local-only',keyPolicy:'current-unlocked-profile-only',drawers:['owner','experience','task:task'],delegatedFrom:[]};
 db.prepare('INSERT INTO memory_background_run_bindings VALUES(?,?,?,?,?,?,?,?)').run('run','owner',JSON.stringify(definition),JSON.stringify(scope),'A'.repeat(43),hash('synthetic-template'),hash(['synthetic-cipher','iv','tag']),hash([null,null,null]));
 const remove=installStoredRunTaskScopeCapture(()=>Object.freeze({taskHash,project:null,delegatedFrom:[],isCurrent:()=>true}));return{db,runner,expiry,close(){remove();db.close();}};
}
