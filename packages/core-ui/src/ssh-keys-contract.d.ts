export type SshKey = { id: string; name: string; type: string | null; bits: number | null; fingerprint: string | null; comment: string; where: string; folder: string; hasPublic: boolean; hasPrivate: boolean; updatedAt: string; hosts: { alias: string; host: string | null }[] };
export function sshKeysPath(path: string): { kind: 'list' } | { kind: 'public'; id: string } | null;
export function sshKeysRoute(path: string): boolean;
export function allowedSshKeys(method: string, path: string, body?: unknown): boolean;
export function sshKeysResponse(path: string, status: number, body: unknown): unknown;
