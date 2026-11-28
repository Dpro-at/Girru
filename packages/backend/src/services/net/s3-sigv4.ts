/**
 * AWS Signature Version 4 for S3-compatible object storage — our own code, no
 * SDK. Only what the backup S3 destination needs: path-style requests signed
 * with the SHA-256 header scheme. Used for S3, MinIO, Backblaze B2, Wasabi and
 * the like. The secret key is used only to derive the per-request signing key
 * and never leaves this process.
 */
import { createHash, createHmac } from 'node:crypto';

export const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export interface S3SignInput {
  method: string;
  /** Host (and optional :port) that goes in the Host header. */
  host: string;
  /** Request path, already percent-encoded, beginning with "/". */
  canonicalUri: string;
  /** Query parameters, unencoded; the signer sorts and encodes them. */
  query?: Record<string, string>;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Hex SHA-256 of the body, or UNSIGNED_PAYLOAD for a streamed body over TLS. */
  payloadSha256: string;
  /** Fixed clock, for tests. */
  now?: Date;
}

/** RFC 3986 encoding (AWS style): encodeURIComponent plus the four it leaves alone. */
export function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Percent-encode a path, segment by segment, keeping the slashes. */
export function encodePath(p: string): string {
  return p.split('/').map(rfc3986).join('/');
}

const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** Returns the headers to merge into the request (Authorization, Host, x-amz-date, x-amz-content-sha256). */
export function signS3(i: S3SignInput): Record<string, string> {
  const now = i.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const service = 's3';
  const scope = `${dateStamp}/${i.region}/${service}/aws4_request`;

  const q = i.query ?? {};
  const canonicalQuery = Object.keys(q).sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(q[k])}`)
    .join('&');

  const headers: Record<string, string> = {
    host: i.host,
    'x-amz-content-sha256': i.payloadSha256,
    'x-amz-date': amzDate,
  };
  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((n) => `${n}:${headers[n].trim()}\n`).join('');
  const signedHeaders = signedNames.join(';');

  const canonicalRequest = [i.method, i.canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, i.payloadSha256].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')].join('\n');

  const kDate = hmac('AWS4' + i.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, i.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { ...headers, authorization };
}
