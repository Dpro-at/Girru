/** The name, system and app version this computer registers with in the Dpro account (instead of “Computer”). */
import {execFileSync} from 'node:child_process';
import {hostname} from 'node:os';
import {readFileSync} from 'node:fs';
import {safeLabel} from './protocol.js';

export type OsFamily='macos'|'windows'|'linux'|'other';
export function osFamilyOf(platform:string=process.platform):OsFamily{return platform==='darwin'?'macos':platform==='win32'?'windows':platform==='linux'?'linux':'other';}

/** A label the account service accepts: trimmed, no control characters, at most 64 characters. */
export function cleanComputerLabel(raw:unknown):string|null{
 if(typeof raw!=='string')return null;
 const text=raw.replace(/[\x00-\x1f\x7f]/g,' ').replace(/\.local$/i,'').replace(/\s+/g,' ').trim().slice(0,64).trim();
 return safeLabel(text)?text:null;
}

function systemName(platform:string):string|null{
 try{
  if(platform==='darwin')return cleanComputerLabel(execFileSync('/usr/sbin/scutil',['--get','ComputerName'],{encoding:'utf8',timeout:1500,stdio:['ignore','pipe','ignore']}));
  if(platform==='win32')return cleanComputerLabel(process.env.COMPUTERNAME);
 }catch{/* fall back to the host name */}
 return null;
}

export function thisComputerLabel(platform:string=process.platform):string{
 return systemName(platform)??cleanComputerLabel(hostname())??(platform==='darwin'?'Mac':platform==='win32'?'Windows PC':'Computer');
}

let version:string|null=null;
export function thisAppVersion():string{
 if(version)return version;
 const ok=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9.+_-]{1,40}$/.test(v);
 const fromEnv=process.env.GIRRU_APP_VERSION;
 if(ok(fromEnv))return version=fromEnv;
 try{const pkg=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8'));if(ok(pkg?.version))return version=pkg.version;}catch{/* unknown */}
 return version='1';
}

export function thisComputer(){return {label:thisComputerLabel(),osFamily:osFamilyOf(),appVersion:thisAppVersion()};}
