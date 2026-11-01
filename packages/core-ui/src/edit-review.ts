export type EditReview = { path: string; rows: { kind: 'context' | 'del' | 'add'; text: string; old: number | null; next: number | null }[] };
/** Only complete, unmasked, bounded saved proposals become a file review. */
export function editReview(tool: string, params: unknown, masked: readonly string[] = []): EditReview | null {
 if(tool!=='edit'||masked.length||!params||typeof params!=='object'||Array.isArray(params))return null;
 const p=params as Record<string,unknown>;
 if(Object.keys(p).sort().join(',')!=='after,before,path'||typeof p.path!=='string'||!p.path||p.path.length>1024||typeof p.before!=='string'||typeof p.after!=='string')return null;
 if([p.before,p.after].some(s=>s.length>24000||s.includes('\0')||s.split('\n').length>1000))return null;
 const old=p.before.split('\n'),next=p.after.split('\n');let first=0,last=0;
 while(first<old.length&&first<next.length&&old[first]===next[first])first++;
 while(last<old.length-first&&last<next.length-first&&old[old.length-last-1]===next[next.length-last-1])last++;
 const rows:EditReview['rows']=[];
 for(let i=Math.max(0,first-3);i<first;i++)rows.push({kind:'context',text:old[i],old:i+1,next:i+1});
 for(let i=first;i<old.length-last;i++)rows.push({kind:'del',text:old[i],old:i+1,next:null});
 for(let i=first;i<next.length-last;i++)rows.push({kind:'add',text:next[i],old:null,next:i+1});
 for(let i=0;i<Math.min(3,last);i++)rows.push({kind:'context',text:next[next.length-last+i],old:old.length-last+i+1,next:next.length-last+i+1});
 return {path:p.path,rows};
}
