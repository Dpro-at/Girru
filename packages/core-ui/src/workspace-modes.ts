export type WorkspaceMode = 'code' | 'chat';
export type WorkspaceModeState = { available: boolean; mode: WorkspaceMode; busy: boolean; error: string | null };
export type CodeReview = {id:string;path:string;before:string;after:string};
export type NabuBridge = {
  review?(value:CodeReview):Promise<boolean>;
  clearReview?(id:string):Promise<boolean>;
  onReviewDecision?(callback:(value:{id:string;decision:'approve'|'deny'})=>void):()=>void;
  open(folder: string, file: string | null, top: number, bottom: number, right?: number): Promise<WorkspaceModeState | null>;
  showCommands?(): Promise<boolean>;
  status(): Promise<WorkspaceModeState | null>;
  select(mode: WorkspaceMode, top: number, bottom: number, right?: number): Promise<WorkspaceModeState | null>;
  layout(top: number, bottom: number, right?: number): void;
  onState(callback: (state: WorkspaceModeState) => void): () => void;
};
export function validWorkspaceState(value: unknown): value is WorkspaceModeState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.available === 'boolean' && (v.mode === 'code' || v.mode === 'chat') && typeof v.busy === 'boolean' && (v.error === null || (typeof v.error === 'string' && v.error.length <= 160));
}
