/** Read-only projection of already-synchronized project task data. Never reads files or starts providers. */
import {all,one,dialect,type Step} from '../repositories/sql-steps.js';
import {forUpdate} from '../db/pg/dialect.js';
export const BOARD_REPORT_VIEWS={summary:'Text',tasks:'Table',progress:'Table',states:'BarChart',completed:'Metric',open:'Metric',overdue:'Metric'} as const;
export type BoardReportView=keyof typeof BOARD_REPORT_VIEWS;
export class BoardReportSourceError extends Error{}
type Section={id:string;boardView?:BoardReportView};
const clip=(v:unknown,max=200)=>typeof v==='string'?v.slice(0,max):'';
const list=(v:unknown)=>Array.isArray(v)?v.filter((x):x is string=>typeof x==='string').slice(0,4).map(x=>clip(x,80)).join('; '):'';
const document=(type:string,props:Record<string,unknown>)=>({schemaVersion:1,root:'r',elements:{r:{type,props,children:[]}}});
export function* projectBoardSections(owner:string,project:string,sections:Section[],capturedAt:string):Step<unknown[]>{
 const d=yield* dialect();const p=yield* one('SELECT id FROM chat_projects WHERE id=? AND user_id=?'+forUpdate(d),project,owner);if(!p)throw new BoardReportSourceError('report_source_unavailable');
 // File-linked project identity takes precedence over the card's originating chat project.
 const cards=yield* all<any>(`SELECT c.id,c.board_id,c.title,c.priority,c.due_date,col.name AS state,
 CASE WHEN t.finished=1 OR col.position=(SELECT MAX(last_col.position) FROM board_columns last_col WHERE last_col.board_id=b.id) THEN 1 ELSE 0 END AS completed,
 t.block,t.problem,t.updated_at AS synced_at,t.task_no
 FROM board_cards c JOIN boards b ON b.id=c.board_id JOIN board_columns col ON col.id=c.column_id AND col.board_id=b.id
 LEFT JOIN task_file_cards t ON t.card_id=c.id LEFT JOIN chat_sessions s ON s.id=c.conversation_id
 WHERE b.owner_id=? AND b.archived=0 AND c.archived=0 AND
 (t.project_id=? OR (t.card_id IS NULL AND s.project_id=? AND s.user_id=?))
 ORDER BY c.updated_at DESC,c.id LIMIT 5001`,owner,project,project,owner);
 if(cards.length>5000)throw new BoardReportSourceError('report_source_limit');
 const completed=cards.filter(c=>Number(c.completed)===1).length,open=cards.length-completed;
 const overdue=cards.filter(c=>!Number(c.completed)&&typeof c.due_date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(c.due_date)&&c.due_date<capturedAt.slice(0,10)).length;
 const problems=cards.filter(c=>c.problem).length,states=new Map<string,number>();for(const c of cards)states.set(c.state,(states.get(c.state)??0)+1);
 const visible=cards.slice(0,30),taskRows:Record<string,string>[]=[],progressRows:Record<string,string>[]=[],tasks:{boardId:string;cardId:string;title:string}[]=[];
 for(const c of visible){
  const agents=yield* all<{name:string}>(`SELECT a.name FROM board_card_agents ca JOIN agents_config a ON a.id=ca.agent_id WHERE ca.card_id=? ORDER BY a.name LIMIT 50`,c.id);
  let block:any={};if(typeof c.block==='string'&&c.block.length<=128000){try{block=JSON.parse(c.block);}catch{/* A broken sync block is displayed as unavailable, never interpreted. */}}
  if(!block||typeof block!=='object'||Array.isArray(block))block={};
  taskRows.push({task:clip(c.title,100),state:clip(c.state,80),agents:agents.map(a=>clip(a.name,40)).join(', ').slice(0,200)||'Unassigned',priority:c.priority,due:c.due_date??'No due date'});
  const healthy=!!c.task_no&&!c.problem;
  progressRows.push({task:clip(c.title,80),done:healthy?list(block.done):'No synchronized notes',left:healthy?list(block.left):'',next:healthy?list(block.next):'',sync:c.problem?'Task-file sync needs attention':c.task_no?'Last saved sync state':'Board only'});
  tasks.push({boardId:c.board_id,cardId:c.id,title:clip(c.title,160)});
 }
 const info=`${cards.length} tasks: ${completed} completed, ${open} open, ${overdue} overdue (UTC date). ${problems?`${problems} task-file sync issues. `:''}Tables show up to 30 tasks. The last board column or an archived-to-done task-file entry counts as completed. Counts use active, unarchived boards and cards linked to this project. Progress notes use the last saved Markdown sync; no files are scanned by Reports.`;
 return sections.map(s=>{
  const v=s.boardView??'summary';let doc;
  if(v==='summary')doc=document('Text',{content:info});
  else if(['completed','open','overdue'].includes(v))doc=document('Metric',{label:v==='completed'?'Completed tasks':v==='open'?'Open tasks':'Overdue tasks',value:String(v==='completed'?completed:v==='open'?open:overdue),detail:v==='overdue'?'Open tasks due before today (UTC)':'Current saved project board state'});
  else if(v==='states')doc=document('BarChart',{title:'Tasks by board column',xKey:'state',yKey:'tasks',data:[...states].slice(0,59).map(([state,tasks])=>({state,tasks})).concat(states.size>59?[{state:'Other columns (combined)',tasks:[...states.values()].slice(59).reduce((a,b)=>a+b,0)}]:[])});
  else if(v==='tasks')doc=document('Table',{columns:[{key:'task',label:'Task'},{key:'state',label:'State'},{key:'agents',label:'Assigned agents'},{key:'priority',label:'Priority'},{key:'due',label:'Due date'}],data:taskRows,emptyMessage:'No active project tasks.'});
  else doc=document('Table',{columns:[{key:'task',label:'Task'},{key:'done',label:'Done'},{key:'left',label:'Left'},{key:'next',label:'Next'},{key:'sync',label:'Task-file sync'}],data:progressRows,emptyMessage:'No project progress notes.'});
  return {id:s.id,document:doc,sourceLabel:'Project board and last saved task-file sync',dataAsOf:null,...(['tasks','progress'].includes(v)?{tasks}:{} )};
 });
}
