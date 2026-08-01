/**
 * AES-256-GCM at rest for Rust+ credentials.
 *
 * `player_token` and the FCM credential blob are not merely private: together
 * they let anyone drive the paired account's Rust+ session, including its smart
 * switches and alarms. A Supabase project snapshot or a leaked service-role key
 * should not be enough to hand those over.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits, the GCM-recommended nonce size
const AUTH_TAG_LENGTH = 16;

function keyFrom(hexKey: string): Buffer {
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== 32) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes');
  }
  return key;
}

/**
 * Encrypt a UTF-8 string. Output is `base64(iv || authTag || ciphertext)`,
 * self-contained so no schema change is needed to store it.
 */
export function encrypt(plaintext: string, hexKey: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keyFrom(hexKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

/** Reverse of `encrypt`. Throws if the payload was tampered with. */
export function decrypt(payload: string, hexKey: string): string {
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Encrypted payload is too short to be valid');
  }

  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, keyFrom(hexKey), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Convenience for `node -e` style key generation. */
export function generateKey(): string {
  return randomBytes(32).toString('hex');
}
