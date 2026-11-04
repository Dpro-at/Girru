export type PersonalDataKind = 'email' | 'phone' | 'bank-account' | 'card' | 'address' | 'id-number';
export type SensitiveTopic = 'health' | 'religion' | 'politics' | 'sexuality' | 'origin' | 'union' | 'genetic';
export type PrivacyFlags = { personalData: PersonalDataKind[]; sensitive: SensitiveTopic[] };
export type PersonMemory = { id: string; drawer: string; type: string; status: string; content: string; createdAt: string; validTo: string | null };
/** Everything about one person (PRIV6). */
export type PersonExport = {
  person: string; exportedAt: string; names: string[];
  drawer: PersonMemory[];
  mentions: Array<PersonMemory & { why: 'graph' | 'name' }>;
  agentNotes: { count: number; ids: string[] };
  graph: Array<{ id: string; name: string; aliases: string[]; links: number }>;
  handoffs: Array<{ id: string; agentId: string; scope: string; createdAt: string; lines: string[] }>;
};
export type PersonForgotten = { drawer: number; mentions: number; graph: number };
export const PERSONAL_DATA_KINDS: readonly PersonalDataKind[];
export const SENSITIVE_TOPICS: readonly SensitiveTopic[];
export const MAX_MENTIONS: 5000;
export function personExportPath(key: string): string;
export function personForgetPath(key: string): string;
export function personPathOf(path: string): { route: 'export' | 'forget'; key: string } | null;
export function personRoute(path: string): boolean;
export function allowedPerson(method: string, path: string, body?: unknown): boolean;
export function privacyOf(x: unknown): PrivacyFlags | undefined;
export function personExportResponse(key: string, body: unknown): PersonExport;
export function personPathResponse(path: string, status: number, body: unknown): unknown;
