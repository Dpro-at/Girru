export const PROJECT_TRUST_PATH: string;
export const TRUST_OWNERS_PATH: string;
export function trustProjectPath(id: string): string;
export function projectTrustRoute(path: string): boolean;
export function allowedProjectTrust(method: string, path: string, body?: unknown): boolean;
export function projectTrustResponse(path: string, status: number, body: unknown): unknown;
export type TrustVerdict = { projectId: string; outside: boolean; source: 'auto' | 'owner' | 'none'; remote: { host: string; owner: string } | null; name?: string };
export type ProjectTrustView = { projects: TrustVerdict[]; owners: Array<{ name: string; host: string; builtIn: boolean }> };
