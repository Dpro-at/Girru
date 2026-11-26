export interface LegalDocument {title:string;sections:{title:string;paragraphs:string[]}[]}
export interface LegalPolicy {version:string;contentSha256:string;effectiveAt:string;locale:'en';termsUrl:string;privacyUrl:string;documents:{terms:LegalDocument;privacy:LegalDocument}}
export interface LegalAcceptance {accepted:true;version:string;contentSha256:string}
export function validLegalAcceptance(value:unknown):value is LegalAcceptance;
export function parseLegalPolicy(value:unknown):LegalPolicy;
export function canAgreeToPolicy(readToEnd:boolean,checked:boolean,busy?:boolean):boolean;
