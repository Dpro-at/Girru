/** Selected memory results reuse the existing secret redactor without opening the default vault. */
import {redactImportText} from '../import/redact.js';
import type {ToolResult} from '../../tools/types.js';
import {MemoryCipherError} from './envelope.js';
export function redactSelectedMemoryToolResult(result:ToolResult):ToolResult{
 let bytes=0,nodes=0;const active=new Set<object>();
 function copy(value:unknown,depth:number):unknown{
  if(++nodes>50000||depth>10)throw new MemoryCipherError();
  if(typeof value==='string'){bytes+=Buffer.byteLength(value);if(bytes>2*1024*1024)throw new MemoryCipherError();return redactImportText(value).text;}
  if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||value===undefined)return value;
  if(!value||typeof value!=='object'||active.has(value)||Buffer.isBuffer(value))throw new MemoryCipherError();active.add(value);
  try{
   if(Array.isArray(value)){if(value.length>5000)throw new MemoryCipherError();return value.map(item=>copy(item,depth+1));}
   if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new MemoryCipherError();const fields=Object.keys(value);if(fields.length>256)throw new MemoryCipherError();
   return Object.fromEntries(fields.map(field=>{const property=Object.getOwnPropertyDescriptor(value,field);if(field.length>256||!property||!Object.hasOwn(property,'value'))throw new MemoryCipherError();return[field,copy(property.value,depth+1)];}));
  }finally{active.delete(value);}
 }
 return copy(result,0) as ToolResult;
}
