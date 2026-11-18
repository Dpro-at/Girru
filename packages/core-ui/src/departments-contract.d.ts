export const DEPARTMENT_RENAME_PATH: '/api/agents/departments/rename';
export const DEPARTMENTS_PATH: '/api/departments';
export function departmentName(x: unknown): x is string;
export function departmentsRoute(path: string): boolean;
export function allowedDepartments(method: string, path: string, body?: unknown): boolean;
export interface DepartmentLook { id: string; name: string; letter: string | null; color: string | null; leadAgentId: string | null; version: number }
export interface DepartmentEntry extends DepartmentLook { agents: { id: string; name: string }[]; projects: { key: string; name: string }[] }
export interface DepartmentQuestion { id: string; kind: string; subjectId: string; name: string }
export function departmentsResponse(status: number, body: unknown, path?: string):
  | { from: string; to: string; moved: number }
  | { departments: DepartmentEntry[]; questions: DepartmentQuestion[] }
  | { department: DepartmentLook }
  | { mergeId: string; into: DepartmentLook }
  | { ok: boolean }
  | { name: string; effects: { projects: number; agents: number; pinnedFacts: number; accessRules: number }; previewHash?: string }
  | { code: string; reason?: string };
