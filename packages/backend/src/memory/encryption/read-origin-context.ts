/** Conservative classification of official automated read entrances; never an authorization grant. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {MemoryCipherError} from './envelope.js';
type Origin=Readonly<{readerKind:'coding-app';readerId:'girru-mcp'}>;
const origins=new AsyncLocalStorage<Origin>();
export function currentMemoryReadOrigin():Origin|null{return origins.getStore()??null;}
export function withMemoryCodingAppReadOrigin<T>(operation:()=>T):T{
 if(typeof operation!=='function')throw new MemoryCipherError();
 return origins.run(Object.freeze({readerKind:'coding-app',readerId:'girru-mcp'}),operation);
}
