export const record=(x:unknown):x is Record<string,unknown>=>typeof x==='object'&&x!==null&&!Array.isArray(x);
export const str=(x:unknown,max=400)=>typeof x==='string'?x.slice(0,max):typeof x==='number'&&Number.isFinite(x)?String(x):'';
export const num=(x:unknown)=>typeof x==='number'&&Number.isFinite(x)?x:typeof x==='string'&&x.trim()!==''&&Number.isFinite(Number(x))?Number(x):null;
export const rows=(x:unknown)=>(Array.isArray(x)?x:[]).filter(record).slice(0,200);
export const bounded=(x:unknown,min:number,max:number,fallback:number)=>Math.min(max,Math.max(min,num(x)??fallback));
export const color=(x:unknown,fallback='currentColor')=>typeof x==='string'&&/^#[a-f0-9]{3}(?:[a-f0-9]{3})?$/i.test(x)?x:fallback;
