// The memory switches are on by default (src/services/memory-switches.ts): a value of
// 0 / false / no / off turns one off, anything else (or nothing) keeps it on.
export const switchValueOn = (value) => !/^(0|false|no|off)$/i.test(String(value ?? '').trim());
export const switchOn = (name) => switchValueOn(process.env[name]);
const MEMORY_SWITCH = /^GIRRU_(STORE_P[0-9]+B?|MEMORY_HELPER|DOC_INDEX)$/;
/** Clear a variable for a test: a memory switch is turned off ('0'), anything else is removed. */
export const clearEnv = (name) => { if (MEMORY_SWITCH.test(name)) process.env[name] = '0'; else delete process.env[name]; };
