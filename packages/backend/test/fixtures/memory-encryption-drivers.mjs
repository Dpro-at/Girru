// Explicit disposable drivers for the final encryption round. Never opens the process database/pool.
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';

function temporaryRoot() {
  const raw=process.env.DPRO_ENC_TEST_ROOT;
  if(process.env.NODE_ENV!=='test'||!raw||!path.isAbsolute(raw))throw Error('enc_fixture_explicit_temporary_root_required');
  const root=path.resolve(raw),stat=fs.lstatSync(root);
  if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(root)!==root||!path.basename(root).startsWith('girru-enc-final-'))throw Error('enc_fixture_temporary_root_refused');
  // One descriptor for check and read: O_NOFOLLOW refuses a link, fstat checks the file actually opened.
  const markerFile=path.join(root,'.girru-enc-test-root.json');
  let markerFd;
  try{markerFd=fs.openSync(markerFile,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));}catch{throw Error('enc_fixture_marker_refused');}
  let markerStat,marker;
  try{
    markerStat=fs.fstatSync(markerFd);
    if(!markerStat.isFile()||markerStat.nlink!==1||markerStat.size>1024)throw Error('enc_fixture_marker_refused');
    marker=JSON.parse(fs.readFileSync(markerFd,'utf8'));
  }finally{fs.closeSync(markerFd);}
  if(marker.version!==1||marker.synthetic!==true||typeof marker.nonce!=='string'||! /^[a-f0-9]{32}$/.test(marker.nonce))throw Error('enc_fixture_marker_refused');
  if(process.platform!=='win32'&&(stat.uid!==process.getuid()||(stat.mode&0o077)!==0||markerStat.uid!==process.getuid()||(markerStat.mode&0o077)!==0))throw Error('enc_fixture_private_root_required');
  // Fail before importing application modules unless all process defaults are explicitly synthetic too.
  for(const key of ['HOME','AGENT_PLAYER_DATA_DIR','DATABASE_PATH']) {
    const value=process.env[key],relative=value&&path.relative(root,path.resolve(value));
    if(!value||relative==='..'||relative?.startsWith('..'+path.sep)||path.isAbsolute(relative??''))throw Error('enc_fixture_synthetic_defaults_required');
  }
  return root;
}

export async function createEncryptionDriverFixture({driver,name}) {
  const temporary=temporaryRoot();
  if(!['sqlite','postgres'].includes(driver)||typeof name!=='string'||! /^[a-z][a-z0-9-]{0,47}$/.test(name))throw Error('enc_fixture_options_invalid');
  const root=fs.mkdtempSync(path.join(temporary,name+'-'));fs.chmodSync(root,0o700);
  const {sqliteStepsOn,postgresStepsOn}=await import('../../src/repositories/sql-steps.ts');
  if(driver==='sqlite') {
    const module=await import('better-sqlite3'),Database=module.default??module;
    const file=path.join(root,'owned.sqlite'),db=new Database(file);fs.chmodSync(file,0o600);
    db.pragma('foreign_keys = ON');db.pragma('journal_mode = WAL');db.pragma('synchronous = FULL');
    let closed=false;const check=()=>{if(closed)throw Error('enc_fixture_closed');};
    const checkedSql=sql=>{if(/\b(?:ATTACH|DETACH)\b|\bVACUUM\s+INTO\b/i.test(sql))throw Error('enc_fixture_file_boundary_refused');return sql;};
    const actual=sqliteStepsOn(db);
    function* guarded(step){check();let next=step.next();while(!next.done){let op=next.value;if(op.kind==='tx'){const body=op.body;op={...op,body:()=>guarded(body())};}else if(op.kind!=='dialect')checkedSql(op.sql);try{next=step.next(yield op);}catch(error){next=step.throw(error);}}return next.value;}
    const runner={dialect:'sqlite',inTransaction:()=>db.inTransaction,read:step=>actual.read(guarded(step)),tx:(body,options)=>actual.tx(()=>guarded(body()),options),...(actual.readSync?{readSync:step=>actual.readSync(guarded(step))}:{})};
    return {root,runner,async exec(sql){check();db.exec(checkedSql(sql));},async query(sql,...params){check();return db.prepare(checkedSql(sql)).all(...params);},async close(){if(closed)return;if(db.inTransaction)throw Error('enc_fixture_transaction_active');closed=true;db.close();}};
  }
  const raw=process.env.DPRO_ENC_PG_URL;if(!raw)throw Error('enc_fixture_postgres_url_required');
  const url=new URL(raw);
  if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','[::1]','::1'].includes(url.hostname)||url.search||url.hash||! /^\/girru_enc_final_[a-z0-9_]+$/.test(url.pathname)||!url.port||Number(url.port)<1||Number(url.port)>65535)throw Error('enc_fixture_postgres_target_refused');
  const pgModule=await import('pg'),pg=pgModule.default??pgModule;
  const {convertPlaceholders}=await import('../../src/db/pg/placeholders.ts');
  const {makePgTypes}=await import('../../src/db/pg/types.ts');
  const schema='enc_'+randomBytes(12).toString('hex');
  const client=new pg.Client({connectionString:raw,application_name:'girru-encryption-synthetic',statement_timeout:15000,query_timeout:20000,types:makePgTypes((oid,format)=>pg.types.getTypeParser(oid,format))});
  const context=new AsyncLocalStorage();let active=null,closed=false,poisoned=false,sequence=0,created=false;
  const check=()=>{if(closed||poisoned)throw Error('enc_fixture_closed');const current=context.getStore();if(current?.ended)throw Error('enc_fixture_transaction_expired');if(active&&current!==active.current)throw Error('enc_fixture_concurrent_transaction_refused');if(current&&!active)throw Error('enc_fixture_transaction_expired');};
  const execute=async(sql,params=[])=>{check();if(/\bpublic\s*\.|\b(?:SET|RESET)\s+(?:LOCAL\s+)?search_path\b|\b(?:CREATE|DROP|ALTER)\s+(?:DATABASE|ROLE|USER)\b/i.test(sql))throw Error('enc_fixture_schema_boundary_refused');const converted=convertPlaceholders(sql);if(converted.count!==params.length)throw Error('enc_fixture_parameter_count_invalid');return client.query(converted.text,params);};
  const rows=async(sql,...params)=>{const result=await execute(sql,params);if(Array.isArray(result))throw Error('enc_fixture_multiple_result_sets_refused');return result.rows;};
  const tx=async operation=>{
    check();const parent=context.getStore();
    if(parent) {
      if(parent.child)throw Error('enc_fixture_concurrent_nested_transaction_refused');
      const frame=active,child={ended:false,child:false},savepoint='enc_sp_'+(++sequence);parent.child=true;frame.current=child;
      const work=(async()=>{
        try {
          await client.query('SAVEPOINT '+savepoint);
          const result=await context.run(child,operation);
          if(child.child){await child.childWork?.catch(()=>{});throw Error('enc_fixture_nested_transaction_unsettled');}
          await client.query('RELEASE SAVEPOINT '+savepoint);return result;
        } catch(error) {
          if(child.child)await child.childWork?.catch(()=>{});
          try{await client.query('ROLLBACK TO SAVEPOINT '+savepoint);await client.query('RELEASE SAVEPOINT '+savepoint);}catch{poisoned=true;}
          throw error;
        } finally {child.ended=true;parent.child=false;frame.current=parent;}
      })();
      parent.childWork=work;
      return work;
    }
    const current={ended:false,child:false};active={current};let began=false;
    try {
      await client.query('BEGIN');began=true;
      const result=await context.run(current,operation);
      if(current.child){await current.childWork?.catch(()=>{});throw Error('enc_fixture_nested_transaction_unsettled');}
      await client.query('COMMIT');return result;
    } catch(error) {if(current.child)await current.childWork?.catch(()=>{});if(began)try{await client.query('ROLLBACK');}catch{poisoned=true;}throw error;}
    finally {current.ended=true;active=null;}
  };
  try {
    await client.connect();await client.query('CREATE SCHEMA "'+schema+'"');created=true;
    await client.query('SET search_path TO "'+schema+'", pg_temp');await client.query("SET TIME ZONE 'UTC'");
  } catch(error) {
    if(created)await client.query('DROP SCHEMA "'+schema+'" CASCADE').catch(()=>{});
    await client.end().catch(()=>{});throw error;
  }
  const connection={one:async(sql,...params)=>(await rows(sql,...params))[0],all:rows,run:async(sql,...params)=>{const result=await execute(sql,params);if(Array.isArray(result))throw Error('enc_fixture_multiple_result_sets_refused');return {changes:result.rowCount??0};},tx,inTransaction:()=>!!active&&context.getStore()===active.current};
  return {root,runner:postgresStepsOn(connection),async exec(sql){await execute(sql);},query:rows,async close(){if(closed)return;if(active)throw Error('enc_fixture_transaction_active');closed=true;try{await client.query('DROP SCHEMA "'+schema+'" CASCADE');}finally{await client.end();}}};
}
