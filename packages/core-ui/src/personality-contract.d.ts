export const traitNames: readonly ['doubt','caution','creativity','thoroughness','independence','verbosity','warmth','curiosity','persistence'];
export type Trait = typeof traitNames[number];
export type Traits = Record<Trait, number>;
export const statuses: readonly string[];
export interface PersonalityProposal {
 id: string; agentId: string; baseVersion: number; baseTraits: Traits; proposedTraits: Traits; delta: Partial<Traits>;
 reason: string; evidence: string[]; source: 'agent'|'evolution'|'owner'; status: 'pending'|'approved'|'rejected'|'stale'|'cancelled';
 createdBy: string; createdAt: string|null; decidedBy: string|null; decidedAt: string|null; decisionNote: string|null; appliedVersion: number|null; reviewHash: string;
 /** STORE-MAP-01 P4: present only on a text suggestion ('file' = PERSONALITY.md changed outside Girru). */
 baseTextHash?: string|null; proposedTextHash?: string; origin?: 'file'|'evolution_text'|null; baseText?: string; proposedText?: string;
}
export function personalityAgentId(x: unknown): x is string;
export function personalityProposalId(x: unknown): x is string;
export function reviewHash(x: unknown): x is string;
export function personalityRoute(path: string): { agentId: string; id?: string; action?: string } | null;
export function allowedPersonality(method: string,path: string,body?: unknown): boolean;
export function parseTraits(x: unknown): Traits;
export function parsePersonalityProposal(x: unknown): PersonalityProposal;
export function parsePersonalityVersion(x: unknown): Record<string, unknown>;
export function personalityResponse(path: string,status: number,body: unknown): unknown;
