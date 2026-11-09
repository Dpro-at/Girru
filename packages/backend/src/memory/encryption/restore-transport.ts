/** Bounded owned transport copy only. This is NOT authentication; package/manifest MAC checks remain mandatory. */
import {MEMORY_COPY_MAX_ROWS} from './copy-limits.js';
import type {MemoryRestorePackage} from './restore-package.js';
import {MemoryCipherError} from './envelope.js';
export function captureUnverifiedMemoryRestoreTransport(input:MemoryRestorePackage):MemoryRestorePackage{
 let bytes=0,nodes=0;const visiting=new Set<object>();
 function clone(value:unknown,depth:number):unknown{
  if(++nodes>2000000||depth>8||(bytes+=16)>128*1024*1024)throw new MemoryCipherError();
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number'){if(!Number.isFinite(value))throw new MemoryCipherError();return value;}
  if(typeof value==='string'){bytes+=Buffer.byteLength(value);if(bytes>128*1024*1024||Buffer.byteLength(value)>16*1024*1024)throw new MemoryCipherError();return value;}
  if(Buffer.isBuffer(value)){bytes+=value.length;if(bytes>128*1024*1024||value.length>16*1024*1024)throw new MemoryCipherError();return Buffer.from(value);}
  if(!value||typeof value!=='object'||visiting.has(value))throw new MemoryCipherError();visiting.add(value);
  try{
   if(Array.isArray(value)){if(value.length>MEMORY_COPY_MAX_ROWS||Object.keys(value).some(key=>! /^(0|[1-9][0-9]*)$/.test(key)))throw new MemoryCipherError();return Array.from({length:value.length},(_,i)=>{const descriptor=Object.getOwnPropertyDescriptor(value,String(i));if(!descriptor||!Object.hasOwn(descriptor,'value'))throw new MemoryCipherError();return clone(descriptor.value,depth+1);});}
   if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new MemoryCipherError();const fields=Object.keys(value);if(fields.length>64)throw new MemoryCipherError();
   return Object.fromEntries(fields.map(field=>{if(Buffer.byteLength(field)>256)throw new MemoryCipherError();const descriptor=Object.getOwnPropertyDescriptor(value,field);if(!descriptor||!Object.hasOwn(descriptor,'value'))throw new MemoryCipherError();return[field,clone(descriptor.value,depth+1)];}));
  }finally{visiting.delete(value);}
 }
 return clone(input,0) as MemoryRestorePackage;
}
