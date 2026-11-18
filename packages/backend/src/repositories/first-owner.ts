/** The existing first-owner transaction, shared by password and verified Google bootstrap. */
import {sql,one,run,lockName,type Step} from './sql-steps.js';
import {OWNER_EXISTS_SQL} from '../auth/default-accounts.js';
import {nowTs} from '../db/pg/dialect.js';
import {startFirstRunStep} from '../onboarding/first-run.js';
export function createFirstOwner(input:{id:string;name:string;email:string;passwordHash:string;workspaceType?:'individual'|'company';companyName?:string;companyKind?:string},afterInsert?:()=>Step<unknown>){return sql().tx(function*(){yield* lockName('setup:first-owner');if(yield* one(OWNER_EXISTS_SQL))return false;yield* run(`INSERT INTO users(id,email,username,password_hash,full_name,role,status,email_verified,created_at,updated_at,token_version) VALUES(?,?,?,?,?,'owner','active',1,${nowTs(sql().dialect)},${nowTs(sql().dialect)},1)`,input.id,input.email,input.email.split('@')[0],input.passwordHash,input.name);if(afterInsert)yield* afterInsert();yield* startFirstRunStep(input.id,input.workspaceType,input.companyName,input.companyKind);return true;},{immediate:true});}
