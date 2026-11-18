import { hash } from 'node:crypto';

/**
 * The SHA-256 fingerprint (hex) of file or text content: compare-and-set checks,
 * package hashes, "did this change" tests. Strings are hashed as UTF-8. Not for
 * passwords or other secrets a person types; those are never fingerprinted here.
 */
export const contentSha256 = (data: string | Buffer): string => hash('sha256', data, 'hex');
