export const OWNER_SETUP_PATH: '/api/setup/admin';
export const SETUP_CODE: RegExp;
export type OwnerSetupCode = 'setup_token_missing' | 'setup_token_invalid' | 'setup_token_expired' | 'setup_not_local' | 'setup_complete'
  | 'missing_fields' | 'weak_password' | 'invalid_email' | 'user_exists';
export const OWNER_SETUP_CODES: readonly OwnerSetupCode[];
export type OwnerSetupBody = { name: string; email: string; password: string; setupToken: string; workspaceType?: 'individual' | 'company'; companyName?: string; companyKind?: string };
export function validCompanyName(value: unknown): value is string;
export function validOwnerSetupBody(body: unknown): body is OwnerSetupBody;
export function ownerSetupResponse(status: number, body: unknown): { success: true } | { code: OwnerSetupCode } | null;
export function setupCodeFromFragment(hash: unknown): string | null;
