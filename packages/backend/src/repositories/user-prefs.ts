/** Per-user interface preferences (TERM-PRO-01): one JSON value per key. */
import { q,sql,one,run,lockName,type Step } from './sql-steps.js';

export async function getPref(userId: string, key: string): Promise<unknown | undefined> {
  const r = await q.one<{ value: string }>('SELECT value FROM user_prefs WHERE user_id = ? AND key = ?', userId, key);
  if (!r) return undefined;
  try { return JSON.parse(r.value); } catch { return undefined; }
}

/** Saves a value the caller already validated. */
export async function setPref(userId: string, key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  await q.run(`INSERT INTO user_prefs (user_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`, userId, key, json);
}

/** Exact portable-preference review; concurrent local edits cannot be overwritten. */
export async function setPrefReviewed(user:string,key:string,value:unknown,expected:unknown,guard?:()=>Step<void>){const {canonical}=await import('../devices/contracts.js');await sql().tx(function*(){yield* lockName('user-pref:'+user+':'+key);if(guard)yield* guard();const old=yield* one<{value:string}>('SELECT value FROM user_prefs WHERE user_id=? AND key=?',user,key);if(canonical(old?JSON.parse(old.value):null)!==canonical(expected??null))throw Error('computer_preference_conflict');yield* run('INSERT INTO user_prefs(user_id,key,value,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP',user,key,JSON.stringify(value));});}
