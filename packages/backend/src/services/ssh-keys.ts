/**
 * SSH keys on this computer (SSH-KEYS-01), for Settings › Security › SSH keys.
 *
 * Reads only the public half: `~/.ssh/*.pub` (its type, OpenSSH SHA256 fingerprint and comment)
 * and `~/.ssh/config` (which hosts use which key, by file name). A private key file is only
 * `lstat`ed to say it is there; it is never opened, hashed, copied or parsed. The same rule
 * holds on macOS, Linux and Windows (%USERPROFILE%\.ssh).
 */
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { discoveryFs, isolatedReadRegularFile } from './discovery-fs.js';

export const PUBLIC_KEY_TYPES = ['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com'] as const;
const LINE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) ([A-Za-z0-9+/]+={0,2})(?:[ \t]+([^\r\n]*))?\r?\n?$/;
const PRIVATE_NAME = /^id_(?:rsa|dsa|ecdsa|ed25519|ecdsa_sk|ed25519_sk)$/;

export interface PublicKeyInfo { type: string; fingerprint: string; comment: string; bits: number | null; line: string }

/** Type, fingerprint (as `ssh-keygen -lf` prints it) and comment of one public key line; null when it is not one. */
export function publicKeyInfo(text: string): PublicKeyInfo | null {
  const m = LINE.exec(text.trim() + '\n');
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length < 20) return null;
  const n = bytes.readUInt32BE(0);
  if (n > bytes.length - 4 || bytes.subarray(4, 4 + n).toString('ascii') !== m[1]) return null;
  return { type: m[1], fingerprint: 'SHA256:' + createHash('sha256').update(bytes).digest('base64').replace(/=+$/, ''), comment: (m[3] ?? '').trim().slice(0, 200), bits: bitsOf(m[1], bytes), line: `${m[1]} ${m[2]}${m[3] ? ' ' + m[3].trim() : ''}` };
}

/** Key size in bits where it is cheap to read from the public blob (RSA modulus, ECDSA curve, Ed25519). */
function bitsOf(type: string, blob: Buffer): number | null {
  if (type.includes('ed25519')) return 256;
  const curve = /nistp(256|384|521)/.exec(type);
  if (curve) return Number(curve[1]);
  if (type !== 'ssh-rsa') return null;
  try {
    let at = 4 + blob.readUInt32BE(0);
    at += 4 + blob.readUInt32BE(at); // exponent
    const len = blob.readUInt32BE(at);
    const mod = blob.subarray(at + 4, at + 4 + len);
    const lead = mod[0] === 0 ? 1 : 0;
    return (mod.length - lead) * 8 - (mod[lead] ? Math.clz32(mod[lead]) - 24 : 0);
  } catch { return null; }
}

export interface SshKey {
  /** Stable id: sha-256 of the key's file path under the home folder. */
  id: string;
  name: string;
  type: string | null;
  bits: number | null;
  fingerprint: string | null;
  comment: string;
  /** Where it is, with ~ for the home folder. */
  where: string;
  /** The folder it is in (absolute), for Show in Finder. */
  folder: string;
  hasPublic: boolean;
  hasPrivate: boolean;
  /** Hosts in ~/.ssh/config that name this key (alias and host name only). */
  hosts: { alias: string; host: string | null }[];
  updatedAt: string;
}

const tilde = (home: string, file: string) => { const r = path.relative(home, file); return r && !r.startsWith('..') && !path.isAbsolute(r) ? `~${path.sep}${r}` : file; };
const idOf = (home: string, file: string) => createHash('sha256').update(path.relative(home, file)).digest('hex');

/** Host blocks of ~/.ssh/config that name an IdentityFile, by that file's base name. */
function hostsByKey(text: string): Map<string, { alias: string; host: string | null }[]> {
  const out = new Map<string, { alias: string; host: string | null }[]>();
  let cur: { alias: string; host: string | null; key: string | null }[] = [];
  const flush = () => { for (const h of cur) if (h.key) { const l = out.get(h.key) ?? []; l.push({ alias: h.alias, host: h.host }); out.set(h.key, l); } };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const m = /^(\S+)\s*(?:=\s*|\s+)(.*)$/.exec(line); if (!m) continue;
    const key = m[1].toLowerCase(), value = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host' || key === 'match') { flush(); cur = key === 'host' ? value.split(/\s+/).filter((a) => a && !/[*?!]/.test(a)).map((alias) => ({ alias, host: null, key: null })) : []; }
    else for (const h of cur) { if (key === 'hostname') h.host = value.slice(0, 200); else if (key === 'identityfile') h.key = value.split(/[\\/]/).pop() ?? null; }
  }
  flush();
  return out;
}

async function readSmall(file: string, max: number): Promise<{ text: string; mtime: string } | null> {
  try { const { data, stat } = await isolatedReadRegularFile(file, max); const text = data.toString('utf8'); return text.includes('\0') ? null : { text, mtime: stat.mtime.toISOString() }; } catch { return null; }
}

/** Every SSH key in `home`/.ssh: public keys with their facts, and private key files that have no public half (name only). */
export async function listSshKeys(home = os.homedir()): Promise<SshKey[]> {
  const dir = path.join(home, '.ssh');
  if ((await discoveryFs.lstat(dir).catch(() => null))?.isDirectory() !== true) return [];
  const config = await readSmall(path.join(dir, 'config'), 256 * 1024);
  const hosts = config ? hostsByKey(config.text) : new Map();
  let entries;
  try { entries = await discoveryFs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const files = entries.filter((e) => e.isFile() && !e.isSymbolicLink());
  const out: SshKey[] = [];
  for (const e of files.filter((f) => f.name.endsWith('.pub')).slice(0, 200)) {
    const file = path.join(dir, e.name), t = await readSmall(file, 16 * 1024);
    const info = t ? publicKeyInfo(t.text) : null;
    if (!info) continue;
    const privateName = e.name.slice(0, -4);
    // Metadata only: never open the private key.
    const hasPrivate = (await discoveryFs.lstat(path.join(dir, privateName)).catch(() => null))?.isFile() === true;
    out.push({ id: idOf(home, file), name: privateName, type: info.type, bits: info.bits, fingerprint: info.fingerprint, comment: info.comment, where: tilde(home, file), folder: dir, hasPublic: true, hasPrivate, hosts: hosts.get(privateName) ?? [], updatedAt: t!.mtime });
  }
  for (const e of files.filter((f) => (PRIVATE_NAME.test(f.name) || hosts.has(f.name)) && !files.some((p) => p.name === f.name + '.pub')).slice(0, 200)) {
    const file = path.join(dir, e.name), st = await discoveryFs.lstat(file).catch(() => null);
    if (!st?.isFile()) continue;
    out.push({ id: idOf(home, file), name: e.name, type: null, bits: null, fingerprint: null, comment: '', where: tilde(home, file), folder: dir, hasPublic: false, hasPrivate: true, hosts: hosts.get(e.name) ?? [], updatedAt: st.mtime.toISOString() });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The public key line of one key, for Copy public key. Never a private key: only `.pub` files are read. */
export async function publicKeyLine(id: string, home = os.homedir()): Promise<string | null> {
  const dir = path.join(home, '.ssh');
  let entries;
  try { entries = await discoveryFs.readdir(dir, { withFileTypes: true }); } catch { return null; }
  const e = entries.find((x) => x.isFile() && !x.isSymbolicLink() && x.name.endsWith('.pub') && idOf(home, path.join(dir, x.name)) === id);
  if (!e) return null;
  const t = await readSmall(path.join(dir, e.name), 16 * 1024);
  return t ? publicKeyInfo(t.text)?.line ?? null : null;
}
