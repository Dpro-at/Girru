/** Backend validation/catalogue only. Rendering and local presentation state live in the frontend. */
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
type DisplayValidation={ok:true;document:unknown;warnings:string[]}|{ok:false;error:string};
const contract=require('./display-runtime/contract.cjs') as {normalizeDisplay(input:unknown):DisplayValidation;COMPONENT_TYPES:readonly string[];COMPONENT_PROPS:Record<string,Record<string,string>>};
export const validateDisplayDocument=(input:unknown)=>contract.normalizeDisplay(input);
export const displayCatalogue=()=>({schemaVersion:1,components:contract.COMPONENT_TYPES.map(type=>({type,props:contract.COMPONENT_PROPS[type]})),authority:'display_only',actions:'Host authorization and approval remain required; JSON grants no capability.'});
