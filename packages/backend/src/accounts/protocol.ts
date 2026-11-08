/** Metadata-only public contract. Workload/configuration payloads have no field or route here. */
import {createHash,randomBytes} from 'node:crypto';
import {peerKey,publicKeyText,type SignedCommand} from '../phone/protocol/e2e.js';
import {deviceIdOf} from '../phone/protocol/encoding.js';
export const ACCOUNT_PROTOCOL='dpro-account-v1';
export const DEFAULT_GOOGLE_CLIENT_ID='281410907967-kaljlvtllp3kleqfp07j1v7ri68hdun6.apps.googleusercontent.com';
export const RETENTION=Object.freeze({challengeMs:10*60000,accessMs:10*60000,sessionIdleMs:30*86400000,sessionAbsoluteMs:90*86400000,auditMs:30*86400000,purgeMs:86400000,presenceMs:30000,backupMaximumDays:7});
export const servicePeerId=(origin:string)=>createHash('sha256').update(ACCOUNT_PROTOCOL+'\n'+origin).digest('base64url');
export const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export const opaque=()=>randomBytes(32).toString('base64url');
export function canonical(value:unknown):string{if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';return '{'+Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>JSON.stringify(key)+':'+canonical(v)).join(',')+'}';}
export const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function exact(value:unknown,allowed:readonly string[],required:readonly string[]=allowed):asserts value is Record<string,any>{if(!object(value)||Object.keys(value).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(value,k)))throw Error('account_input_invalid');}
export const validOpaque=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v);
export const validId=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
export const safeLabel=(v:unknown):v is string=>typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<=64&&!/[\x00-\x1f\x7f]/.test(v);
export function canonicalPublicKey(raw:unknown){if(typeof raw!=='string'||raw.length>256)throw Error('account_public_key_invalid');const key=peerKey(raw);if(publicKeyText(key)!==raw)throw Error('account_public_key_invalid');return {text:raw,key,id:deviceIdOf(key)};}
export function accountOrigin(raw:string,temporaryLoopback=false){const u=new URL(raw);if(u.username||u.password||u.search||u.hash||u.pathname!=='/identity/v1'||u.href.replace(/\/$/,'')!==raw||u.protocol!=='https:'&&!(temporaryLoopback&&u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.port))throw Error('account_origin_invalid');return u.href;}
export type DeviceStatus='pending'|'approved'|'revoked';
export interface AccountRow {id:string;issuer:string;subject:string;status:'active'|'disabled';security_epoch:number;registry_version:number;created_at:number;reset_required:number;bootstrap_device_id:string|null}
export interface DeviceRow {id:string;account_id:string;public_key:string;label:string;os_family:'macos'|'windows'|'linux'|'other';app_version:string;status:DeviceStatus;device_epoch:number;registered_at:number;approved_by:string|null;enrollment_hash:string;enrollment_expires_at:number}
export interface SessionRow {id:string;account_id:string;device_id:string;access_hash:string;refresh_hash:string;family_id:string;account_epoch:number;device_epoch:number;service_epoch:string;auth_time:number;issued_at:number;last_used_at:number;access_expires_at:number;absolute_expires_at:number;revoked_at:number|null}
export interface ChallengeRow {hash:string;purpose:'google'|'request'|'refresh';public_key:string;account_id:string|null;device_id:string|null;session_id:string|null;operation:string;body_hash:string;created_at:number;expires_at:number}
export interface AccountDeviceView {id:string;publicKey:string;label:string;osFamily:string;appVersion:string;status:DeviceStatus;epoch:number;registeredAt:number;presence:'online'|'unknown';lastHeartbeatAt:number|null}
export interface AccountView {id:string;securityEpoch:number;registryVersion:number;resetRequired:boolean;deviceId:string;deviceStatus:DeviceStatus;devices:AccountDeviceView[];protocol:typeof ACCOUNT_PROTOCOL}
export interface DeviceProof {challenge:string;command:SignedCommand}
export interface SessionMaterial {familyId:string;accessToken:string;refreshToken:string;accessExpiresAt:number;absoluteExpiresAt:number;accountId:string;deviceId:string;status:DeviceStatus;securityEpoch:number;serviceEpoch:string}
