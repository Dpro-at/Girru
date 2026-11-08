// Opt-in acceptance of the MCP adapter against real routes and temporary databases.
// MCP_MEMORY_BACKEND_DIR must point to a disposable copy of packages/backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {callTool} from '../src/tools.ts';
import {BackendError} from '../src/backend.ts';

test('scoped memory adapter uses authenticated actual routes with synthetic storage', {skip:!process.env.MCP_MEMORY_BACKEND_DIR},async()=>{
 const source=resolve(process.env.MCP_MEMORY_BACKEND_DIR),previous=process.cwd(),home=mkdtempSync(join(tmpdir(),'mcp-memory-routes-'));
 mkdirSync(join(home,'.data'),{recursive:true});process.chdir(home);
 Object.assign(process.env,{HOME:home,AGENT_PLAYER_CONFIG_DIR:join(home,'config'),DATABASE_PATH:join(home,'.data','test.sqlite'),JWT_SECRET:randomBytes(64).toString('hex'),ENCRYPTION_KEY:randomBytes(32).toString('hex'),NODE_ENV:'test',OLLAMA_URL:'http://127.0.0.1:9',MEMORY_GRAPH_MODEL:'off'});
 const load=p=>import(join(source,'src',p));const fetchBefore=globalThis.fetch;let networks=0;
 globalThis.fetch=async()=>{networks++;throw Error('Network/model access forbidden in memory acceptance');};
 let app,db,pg;
 try{
  const database=await load('db/database.ts');db=database;await database.getDatabase({path:process.env.DATABASE_PATH}).initialize();
  if(process.env.AGENT_PLAYER_DB==='postgres'){
   pg=await load('db/pg/pool.ts');const {runPgMigrations}=await load('db/pg/migrate.ts');await runPgMigrations(await pg.getPgPool());
  }
  const {q,sql}=await load('repositories/sql-steps.ts');
  for(const [id,role]of [['mcp-owner','owner'],['mcp-foreign','owner'],['mcp-member','user']]){
   const values=[id,id+'@example.test',id,role];const statement="INSERT INTO users (id,email,username,password_hash,role,status,email_verified) VALUES (?,?,?,'x',?,'active',1)";
   await q.run(statement,...values);
   if(process.env.AGENT_PLAYER_DB==='postgres')database.getDatabase({path:process.env.DATABASE_PATH}).prepare(statement).run(...values);
  }
  const {default:Fastify}=await import(join(source,'node_modules/fastify/fastify.js'));
  app=Fastify();(await load('auth/auth-gate.ts')).registerAuthGate(app);
  for(const [file,fn]of [['mcp-memory-proposals.ts','mcpMemoryProposalRoutes'],['auth.ts','authRoutes'],['memory.ts','memoryRoutes'],['memory-scopes.ts','memoryScopeRoutes'],['memory-files.ts','memoryFilesRoutes']])await app.register((await load('api/routes/'+file))[fn]);
  await app.ready();const {generateToken}=await load('auth/jwt.ts');
  const {createProject}=await load('repositories/chat-conversations.ts');const {projectKeyOf}=await load('memory/project-keys.ts');
  const project=await createProject('mcp-owner',{name:'Synthetic Adapter Project'}),key=projectKeyOf(project),scope='project:'+key;
  const {newMemory}=await load('memory/learning.ts');const {recordVersionStep}=await load('memory/versions.ts');const {getMemoryStorage}=await load('memory/storage.ts');
  async function seed(user,drawer,content){const m=newMemory(user,drawer,{type:'fact',importance:7,content},{synthetic:true});m.embedding=[0.1,0.2,0.3];await sql().tx(function*(){yield* getMemoryStorage().writeRowStep(m);yield* recordVersionStep({memoryId:m.id,userId:user,drawer,change:'create',entry:{type:'fact',importance:7,content},actor:user,reason:'Synthetic fixture'});});return m;}
  const own=await seed('mcp-owner',{kind:'project',key},'Synthetic deadline is Friday.'),other=await seed('mcp-foreign',{kind:'project',key},'FOREIGN OWNER SECRET'),drawer=await seed('mcp-owner',{kind:'owner'},'OTHER DRAWER SECRET');
  const {createChangeProposal}=await load('memory/memory-files.ts');
  const proposal=await createChangeProposal({userId:'mcp-owner',agentId:'synthetic-agent',drawer:{kind:'project',key},source:'agent',createdBy:'mcp-owner',reasons:['Synthetic correction'],changes:[{op:'update',id:own.id,before:{type:'fact',importance:7,content:own.content},after:{type:'fact',importance:7,content:'Synthetic deadline is Monday.'}}]});
  await q.run("INSERT INTO agents_config (id,name,provider,model) VALUES ('synthetic-agent','Synthetic','ollama','off')");
  const paths=[];let actor='mcp-owner';const backend={async request(method,path,body){paths.push(path);const response=await app.inject({method,url:path,...(body?{payload:body}:{}),headers:{authorization:'Bearer '+generateToken(actor,1)}});if(response.statusCode>=400)throw new BackendError(response.json().message??response.json().error,response.statusCode);return response.json();}};
  const tool=async args=>callTool('workspace_memory',{scope,...args},{backend});
  for(const args of [{operation:'search',query:'deadline'},{operation:'read',id:own.id},{operation:'versions',id:own.id},{operation:'status'},{operation:'reviews'},{operation:'review',id:proposal.id}]){
   const response=await tool(args);assert.notEqual(response.isError,true,JSON.stringify(response));assert.doesNotMatch(JSON.stringify(response),/FOREIGN OWNER SECRET|OTHER DRAWER SECRET|reviewHash|baseHash/);
   if(args.operation==='search')assert.equal(response.structuredContent.items[0].id,own.id);
   if(args.operation==='review')assert.equal(response.structuredContent.changes[0].after.content,'Synthetic deadline is Monday.');
   if(args.operation==='versions')assert.equal(response.structuredContent.versions[0].content,own.content);
  }
  const revision=(await tool({operation:'status'})).structuredContent.revision;
  const add={operation:'propose_add',agentId:'synthetic-agent',requestId:'synthetic-add-1',expectedRevision:revision,after:{type:'fact',importance:7,content:'Synthetic new proposed fact.'}};
  const concurrent=await Promise.all([tool(add),tool(add)]);for(const response of concurrent)assert.notEqual(response.isError,true,JSON.stringify(response));assert.equal(concurrent[0].structuredContent.proposalId,concurrent[1].structuredContent.proposalId);assert.equal(concurrent[0].structuredContent.saved,false);
  const prepared=await q.one('SELECT source,created_by,agent_id,status FROM memory_file_proposals WHERE id = ?',concurrent[0].structuredContent.proposalId);assert.deepEqual({...prepared},{source:'import',created_by:'mcp-owner',agent_id:'synthetic-agent',status:'pending'});
  const update={operation:'propose_update',agentId:'synthetic-agent',requestId:'synthetic-update-1',expectedRevision:revision,id:own.id,expectedVersion:1,before:{type:'fact',importance:7,content:own.content},after:{type:'fact',importance:7,content:'Synthetic proposed correction.'}};
  assert.notEqual((await tool(update)).isError,true);
  assert.equal((await q.one('SELECT content FROM memories WHERE id = ?',own.id)).content,own.content,'Proposal does not mutate saved memory');
  for(const invalid of [{...add,after:{...add.after,content:'Changed request payload'}},{...add,requestId:'stale-revision',expectedRevision:revision+1},{...update,requestId:'stale-version',expectedVersion:2},{...update,requestId:'stale-before',before:{...update.before,content:'wrong'}},{...add,requestId:'missing-agent',agentId:'missing-agent'},{...update,requestId:'foreign-memory',id:other.id},{...add,requestId:'foreign-project',scope:'project:foreign-project'},{...add,requestId:'forged-owner',userId:'mcp-foreign'},{...add,requestId:'forged-source',source:'agent'}])assert.equal((await tool(invalid)).isError,true,JSON.stringify(invalid));
  const direct=async payload=>app.inject({method:'POST',url:'/api/memory/mcp-proposals',payload,headers:{authorization:'Bearer '+generateToken(actor,1)}});
  for(const payload of [{scope,...add,userId:'mcp-foreign'},{scope,...add,source:'agent'},{scope,...add,operation:'delete'},{scope,...update,requestId:'direct-stale',expectedVersion:55}])assert.ok((await direct(payload)).statusCode>=400);
  const canonicalReplay=await direct({after:{content:add.after.content,importance:7,type:'fact'},expectedRevision:revision,requestId:add.requestId,agentId:add.agentId,scope,operation:'propose_add'});assert.equal(canonicalReplay.statusCode,200);assert.equal(canonicalReplay.json().proposalId,concurrent[0].structuredContent.proposalId);
  assert.equal((await q.one('SELECT COUNT(*) AS n FROM mcp_memory_requests WHERE owner_id = ?',actor)).n,2,'Failed requests leave no partial receipt');
  assert.equal((await q.one('SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND content = ?',actor,add.after.content)).n,0,'Pending add never saves a memory');
  assert.deepEqual(Object.keys(await q.one('SELECT * FROM mcp_memory_requests WHERE owner_id = ? AND request_id = ?',actor,add.requestId)).sort(),['created_at','owner_id','payload_hash','proposal_id','request_id']);
  await q.run('DELETE FROM memory_file_proposals WHERE id = ?',concurrent[0].structuredContent.proposalId);
  assert.equal((await tool(add)).isError,true,'Removed proposal cannot be recreated by replaying the same request');
  assert.equal((await q.one('SELECT COUNT(*) AS n FROM mcp_memory_requests WHERE owner_id = ?',actor)).n,2,'Minimal idempotency receipts outlive proposal removal');
  const identity=await backend.request('GET','/api/auth/me');assert.equal(identity.user.id,'mcp-owner');
  const {prepareMemoryProposal}=await load('services/mcp-memory-proposals.ts');for(const fake of [{kind:'agent',userId:'mcp-owner',role:'owner',agentId:'synthetic-agent'},{kind:'service',userId:'mcp-owner',role:'owner'},{kind:'user',userId:'mcp-owner',role:'owner',channel:'outside'}])await assert.rejects(()=>prepareMemoryProposal(fake,{scope,...add}));
  for(const memory of [other,drawer])assert.equal((await tool({operation:'read',id:memory.id})).isError,true);
  const foreignProposal=await createChangeProposal({userId:'mcp-foreign',agentId:'synthetic-agent',drawer:{kind:'project',key},source:'agent',createdBy:'mcp-foreign',reasons:['Foreign synthetic fixture'],changes:[{op:'add',after:{type:'fact',importance:7,content:'FOREIGN PROPOSAL SECRET'}}]});
  const foreignReview=await tool({operation:'review',id:foreignProposal.id});assert.equal(foreignReview.isError,true);assert.doesNotMatch(JSON.stringify(foreignReview),/FOREIGN PROPOSAL SECRET/);
  await sql().tx(function*(){yield* recordVersionStep({memoryId:own.id,userId:'mcp-owner',drawer:{kind:'owner'},change:'baseline',entry:{type:'fact',importance:7,content:'FOREIGN HISTORY DRAWER'},actor:'mcp-owner',reason:'Synthetic historical drawer boundary'});});
  const historical=await tool({operation:'versions',id:own.id});assert.equal(historical.isError,true);assert.doesNotMatch(JSON.stringify(historical),/FOREIGN HISTORY DRAWER/);
  assert.equal(scope,'project:'+project.id,'Current Store P3 project identity uses its stable id');
  // Auth is checked on every operation and again by every actual route.
  actor='mcp-member';assert.equal((await tool({operation:'status'})).isError,true);assert.equal((await tool({...add,requestId:'member-denied'})).isError,true);actor='mcp-owner';
  await q.run("UPDATE users SET status = 'suspended' WHERE id = ?",actor);if(process.env.AGENT_PLAYER_DB==='postgres')database.getDatabase({path:process.env.DATABASE_PATH}).prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(actor);
  assert.equal((await tool({operation:'read',id:own.id})).isError,true);assert.equal((await tool(add)).isError,true);assert.equal(networks,0);assert.ok(paths.every(p=>!p.includes('/search')));
 }finally{if(app)await app.close();if(pg)await pg.closePgPool();if(db)db.closeDatabase();globalThis.fetch=fetchBefore;process.chdir(previous);rmSync(home,{recursive:true,force:true});}
});
