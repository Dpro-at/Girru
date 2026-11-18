// Owned subprocess fixture: input is data, never JavaScript source.
import {getDatabase} from '../../src/db/database.ts';
import {claimPaperDispatchAttempt} from '../../src/services/trading-paper-dispatch-attempts.ts';
const {ownerId,request,now}=JSON.parse(process.argv[2]);
const db=getDatabase().getDb(),original=Object.getPrototypeOf(db).prepare;
Object.getPrototypeOf(db).prepare=function(sql,...args){
 const statement=original.call(this,sql,...args);
 if(sql.startsWith('INSERT INTO main.paper_dispatch_attempts '))return {run(...values){statement.run(...values);process.kill(process.pid,'SIGKILL');}};
 return statement;
};
claimPaperDispatchAttempt(db,ownerId,request,now);
process.exit(2);
