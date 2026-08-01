import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, generateKey } from '../src/crypto.js';

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);

describe('encrypt / decrypt', () => {
  it('round-trips a player token', () => {
    const token = 'some-rust-plus-player-token';
    expect(decrypt(encrypt(token, KEY), KEY)).toBe(token);
  });

  it('round-trips a whole credentials blob', () => {
    const blob = JSON.stringify({ fcm_credentials: { gcm: { androidId: '123', securityToken: '456' } } });
    expect(decrypt(encrypt(blob, KEY), KEY)).toBe(blob);
  });

  it('produces different ciphertext each time', () => {
    // A fresh IV per call, so identical tokens are not detectable as identical
    // by looking at the stored rows.
    expect(encrypt('same', KEY)).not.toBe(encrypt('same', KEY));
  });

  it('refuses a payload encrypted under a different key', () => {
    expect(() => decrypt(encrypt('secret', KEY), OTHER_KEY)).toThrow();
  });

  it('detects tampering via the GCM auth tag', () => {
    const payload = Buffer.from(encrypt('secret', KEY), 'base64');
    const last = payload.length - 1;
    payload.writeUInt8(payload.readUInt8(last) ^ 0xff, last);
    expect(() => decrypt(payload.toString('base64'), KEY)).toThrow();
  });

  it('rejects a truncated payload rather than misreading it', () => {
    expect(() => decrypt(Buffer.from('short').toString('base64'), KEY)).toThrow(/too short/);
  });

  it('rejects a key of the wrong length', () => {
    expect(() => encrypt('x', 'abcd')).toThrow(/32 bytes/);
  });

  it('handles unicode', () => {
    const text = 'Large Oil Rig 🛢️ W4';
    expect(decrypt(encrypt(text, KEY), KEY)).toBe(text);
  });
});

describe('generateKey', () => {
  it('produces a usable 64 character hex key', () => {
    const key = generateKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(decrypt(encrypt('ok', key), key)).toBe('ok');
  });
});
