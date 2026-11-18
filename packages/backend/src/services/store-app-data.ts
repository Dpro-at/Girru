/** A reviewed app's data port never exposes the native database or another app's tables. */
import type Database from 'better-sqlite3';

function sqlTokens(text:string):string[]{
 const tokens:string[]=[];let i=0;
 while(i<text.length){const c=text[i];
  if(/\s/.test(c)){i++;continue;}
  if(text.startsWith('--',i)){const end=text.indexOf('\n',i+2);i=end<0?text.length:end+1;continue;}
  if(text.startsWith('/*',i)){const end=text.indexOf('*/',i+2);if(end<0)throw Error('Invalid app query.');i=end+2;continue;}
  if(c==="'"||c==='"'||c==='`'||c==='['){const end=c==='['?']':c;let value='',closed=false;i++;
   while(i<text.length){if(text[i]===end){if(text[i+1]===end&&c!=='['){value+=end;i+=2;continue;}i++;closed=true;break;}value+=text[i++];}
   if(!closed)throw Error('Invalid app query.');tokens.push(c==="'"?'?':'@'+value);continue;
  }
  const word=/^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));if(word){tokens.push(word[0]);i+=word[0].length;}else{tokens.push(c);i++;}
 }
 return tokens;
}
export function assertStoreAppQuery(id:string,text:string):void{
 if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)||typeof text!=='string'||text.length>65536)throw Error('Invalid app query.');
 const tokens=sqlTokens(text),upper=tokens.map(t=>t.toUpperCase()),prefix=`app_${id.replace(/-/g,'_')}__`;let tables=0;
 if(!['SELECT','INSERT','UPDATE','DELETE'].includes(upper[0]))throw Error('App data permits only its own row queries.');
 for(let i=0;i<tokens.length;i++){
  if(['ATTACH','DETACH','PRAGMA','CREATE','DROP','ALTER','VACUUM','REINDEX','LOAD_EXTENSION','READFILE','WRITEFILE','WITH','UNION','INTERSECT','EXCEPT'].includes(upper[i]))throw Error('App data query is outside its scope.');
  if(upper[i]==='IN'&&tokens[i+1]!=='(')throw Error('App data refuses table membership shorthand.');
  if(tokens[i]===';'&&i!==tokens.length-1)throw Error('App data accepts one statement.');
  if(['FROM','JOIN','INTO','UPDATE'].includes(upper[i])&&!(upper[i]==='UPDATE'&&upper[i+1]==='SET')){
   if(tokens[i+1]==='('){if(upper[i+2]!=='SELECT')throw Error('Only a scoped SELECT subquery is allowed.');continue;}
   const name=tokens[i+1]?.replace(/^@/,'');if(!name||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)||!name.toLowerCase().startsWith(prefix)||tokens[i+2]==='.')throw Error('App data cannot access this table.');tables++;
  }
 }
 if(!tables)throw Error('App data requires an owned table.');
 // Comma joins are not part of the reviewed queries. Track nesting so a subquery cannot hide one.
 const levels:number[]=[];let level=0;
 for(const token of tokens){levels.push(level);if(token==='(')level++;else if(token===')')level--;if(level<0)throw Error('Invalid app query.');}
 if(level!==0)throw Error('Invalid app query.');
 for(let i=0;i<tokens.length;i++)if(['FROM','JOIN'].includes(upper[i])){
  for(let j=i+1;j<tokens.length;j++){
   if(levels[j]<levels[i]||levels[j]===levels[i]&&['WHERE','GROUP','ORDER','HAVING','LIMIT',';'].includes(upper[j]))break;
   if(levels[j]===levels[i]&&tokens[j]===',')throw Error('Use an explicit scoped join.');
  }
 }
}

export function createStoreAppData(id:string,db:Database.Database,isActive:()=>boolean=()=>true){
 const active=()=>{if(!isActive())throw Error('The app is not enabled.');};
 const statement=(text:string)=>{active();assertStoreAppQuery(id,text);return db.prepare(text);};
 const prepare=(text:string)=>{const s=statement(text);return Object.freeze({get:(...p:unknown[])=>{active();return s.get(...p);},all:(...p:unknown[])=>{active();return s.all(...p);},run:(...p:unknown[])=>{active();return s.run(...p);}});};
 type Step=Generator<{kind:string;sql?:string;params?:unknown[];body?:()=>Step},unknown,unknown>;
 function drive(step:Step):unknown{let next=step.next();while(!next.done){const op=next.value;let value:unknown;
  try{if(op.kind==='dialect')value='sqlite';else if(op.kind==='tx'&&op.body)value=db.transaction(()=>drive(op.body!()))();else{if(typeof op.sql!=='string'||!['one','all','run'].includes(op.kind))throw Error('Invalid app step.');const s=statement(op.sql),p=op.params??[];value=op.kind==='one'?s.get(...p):op.kind==='all'?s.all(...p):s.run(...p);}next=step.next(value);}catch(error){next=step.throw(error);}}
  return next.value;
 }
 const runner=Object.freeze({dialect:'sqlite',read:async(step:Step)=>drive(step),tx:async(body:()=>Step)=>db.transaction(()=>drive(body()))()});
 const step=function*(kind:string,text:string,...params:unknown[]):Step{return yield {kind,sql:text,params};};
 const q=Object.freeze({dialect:'sqlite',one:async(text:string,...p:unknown[])=>prepare(text).get(...p),all:async(text:string,...p:unknown[])=>prepare(text).all(...p),run:async(text:string,...p:unknown[])=>prepare(text).run(...p)});
 return Object.freeze({database:Object.freeze({prepare}),steps:Object.freeze({q,one:(text:string,...p:unknown[])=>step('one',text,...p),run:(text:string,...p:unknown[])=>step('run',text,...p),sql:()=>runner,dialect:function*(){return 'sqlite';}})});
}
