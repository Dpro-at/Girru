/**
 * Cryptographic Utilities
 * Core encryption/decryption functions
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  scryptSync,
  createHash,
} from 'crypto';
import type {
  EncryptedData,
  EncryptionAlgorithm,
  MasterKeyConfig,
} from './types.js';

/** IV sizes for different algorithms */
const IV_SIZES: Record<EncryptionAlgorithm, number> = {
  'aes-256-gcm': 12,
  'aes-256-cbc': 16,
  'chacha20-poly1305': 12,
};

/** Auth tag size for authenticated encryption */
const AUTH_TAG_SIZE = 16;

/** Current encryption version */
const ENCRYPTION_VERSION = 1;

/**
 * Generate a random encryption key
 */
export function generateKey(length: number = 32): Buffer {
  return randomBytes(length);
}

/**
 * Generate a random IV
 */
export function generateIV(algorithm: EncryptionAlgorithm): Buffer {
  return randomBytes(IV_SIZES[algorithm]);
}

/**
 * Generate a random salt
 */
export function generateSalt(length: number = 32): Buffer {
  return randomBytes(length);
}

/**
 * Derive a key from password using PBKDF2
 */
export function deriveKeyPBKDF2(
  password: string | Buffer,
  salt: Buffer,
  iterations: number = 100000,
  keyLength: number = 32
): Buffer {
  return pbkdf2Sync(password, salt, iterations, keyLength, 'sha256');
}

/**
 * Derive a key from password using scrypt
 */
export function deriveKeyScrypt(
  password: string | Buffer,
  salt: Buffer,
  keyLength: number = 32,
  cost: number = 16384,
  blockSize: number = 8,
  parallelism: number = 1
): Buffer {
  return scryptSync(password, salt, keyLength, {
    N: cost,
    r: blockSize,
    p: parallelism,
  });
}

/**
 * Derive key based on configuration
 */
export function deriveKey(
  password: string | Buffer,
  config: MasterKeyConfig
): Buffer {
  const salt = Buffer.from(config.salt, 'base64');

  if (config.kdf === 'scrypt') {
    return deriveKeyScrypt(
      password,
      salt,
      config.keyLength,
      config.iterations,
      8,
      config.parallelism || 1
    );
  }

  // Default to PBKDF2
  return deriveKeyPBKDF2(password, salt, config.iterations, config.keyLength);
}

/**
 * Encrypt data using AES-256-GCM
 */
export function encryptAES256GCM(
  plaintext: Buffer | string,
  key: Buffer,
  keyId: string,
  additionalData?: Buffer
): EncryptedData {
  const iv = generateIV('aes-256-gcm');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (additionalData) cipher.setAAD(additionalData);

  const plaintextBuffer = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: authTag.toString('base64'),
    keyId,
    version: ENCRYPTION_VERSION,
    encryptedAt: new Date().toISOString(),
  };
}

/**
 * Decrypt data using AES-256-GCM
 */
export function decryptAES256GCM(
  encrypted: EncryptedData,
  key: Buffer,
  additionalData?: Buffer
): Buffer {
  if (!encrypted.authTag) {
    throw new Error('Missing authentication tag for GCM decryption');
  }

  const iv = Buffer.from(encrypted.iv, 'base64');
  const ciphertext = Buffer.from(encrypted.ciphertext, 'base64');
  const authTag = Buffer.from(encrypted.authTag, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (additionalData) decipher.setAAD(additionalData);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Encrypt data using AES-256-CBC
 */
export function encryptAES256CBC(
  plaintext: Buffer | string,
  key: Buffer,
  keyId: string
): EncryptedData {
  const iv = generateIV('aes-256-cbc');
  const cipher = createCipheriv('aes-256-cbc', key, iv);

  const plaintextBuffer = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);

  return {
    algorithm: 'aes-256-cbc',
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    keyId,
    version: ENCRYPTION_VERSION,
    encryptedAt: new Date().toISOString(),
  };
}

/**
 * Decrypt data using AES-256-CBC
 */
export function decryptAES256CBC(
  encrypted: EncryptedData,
  key: Buffer
): Buffer {
  const iv = Buffer.from(encrypted.iv, 'base64');
  const ciphertext = Buffer.from(encrypted.ciphertext, 'base64');

  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Generic encrypt function
 */
export function encrypt(
  plaintext: Buffer | string,
  key: Buffer,
  keyId: string,
  algorithm: EncryptionAlgorithm = 'aes-256-gcm'
): EncryptedData {
  switch (algorithm) {
    case 'aes-256-gcm':
      return encryptAES256GCM(plaintext, key, keyId);
    case 'aes-256-cbc':
      return encryptAES256CBC(plaintext, key, keyId);
    default:
      throw new Error(`Unsupported algorithm: ${algorithm}`);
  }
}

/**
 * Generic decrypt function
 */
export function decrypt(
  encrypted: EncryptedData,
  key: Buffer
): Buffer {
  switch (encrypted.algorithm) {
    case 'aes-256-gcm':
      return decryptAES256GCM(encrypted, key);
    case 'aes-256-cbc':
      return decryptAES256CBC(encrypted, key);
    default:
      throw new Error(`Unsupported algorithm: ${encrypted.algorithm}`);
  }
}

/**
 * Hash data using SHA-256
 */
export function hashSHA256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Generate a secure random ID
 */
export function generateSecureId(prefix: string = ''): string {
  const id = randomBytes(16).toString('hex');
  return prefix ? `${prefix}_${id}` : id;
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
export function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }

  return result === 0;
}

/**
 * Securely wipe a buffer from memory
 */
export function secureWipe(buffer: Buffer): void {
  buffer.fill(0);
  randomBytes(buffer.length).copy(buffer);
  buffer.fill(0);
}
