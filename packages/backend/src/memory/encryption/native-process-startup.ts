/** Internal bootstrap handoff to the real server entry; never a request-settable dependency. */
import type {createNormalNativeBootstrap} from './normal-native-bootstrap.js';
let initialized=false,value:Awaited<ReturnType<typeof createNormalNativeBootstrap>>|null=null;
export function bindNativeProcessStartup(actual:Awaited<ReturnType<typeof createNormalNativeBootstrap>>|null){if(initialized)throw new Error('native_process_startup_already_bound');initialized=true;value=actual;}
export function nativeProcessStartup(){return value;}
