let ports=null;
export function bindHost(host){if(!host||!Object.isFrozen(host)||!host.core)throw Error('Update Girru before using Call Center.');ports=host.core;}
export function corePort(name){const port=ports?.[name];if(!port)throw Error('Call Center host capability unavailable.');return port;}
