/** Server validation uses the same OIDC verifier as native sign-in, not client identity claims. */
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {verifyGoogleIdToken,clientIdOk}=require('../../identity/src/google.cjs');
export {clientIdOk};
export interface GoogleIdentity {issuer:'https://accounts.google.com';subject:string;verifiedAt:number;expiresAt:number}
export const verifyGoogleProof=(token:string,clientId:string,nonce:string):Promise<GoogleIdentity>=>verifyGoogleIdToken(token,{clientId,nonce});
