/** Per-server explicit mode. Never inferred from environment, disk contents or a request body. */
const encryptedServers=new WeakSet<object>();
export function bindEncryptedMemoryServer(server:object):void{encryptedServers.add(server);}
export function isEncryptedMemoryServer(server:object):boolean{return encryptedServers.has(server);}
