import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { decryptFile, encryptFile, FileIntegrityError } from '../src/file-cipher';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('file-cipher', () => {
  it('round-trips and reports hashes of both sides', async () => {
    const plain = bytes('a secret picture');
    const enc = await encryptFile(plain);
    expect(enc.key).toMatch(/^[0-9a-f]{64}$/);
    expect(enc.nonce).toMatch(/^[0-9a-f]{24}$/);
    expect(enc.size).toBe(plain.length);
    expect(enc.x).toBe(bytesToHex(sha256(enc.ciphertext)));
    expect(enc.ox).toBe(bytesToHex(sha256(plain)));
    // GCM appends a 16-byte tag; the plaintext must not appear in the blob.
    expect(enc.ciphertext.length).toBe(plain.length + 16);
    expect(new TextDecoder().decode(enc.ciphertext)).not.toContain('secret');

    const out = await decryptFile(enc.ciphertext, enc.key, enc.nonce, enc.x);
    expect(new TextDecoder().decode(out)).toBe('a secret picture');
  });

  it('uses a fresh key and nonce per file', async () => {
    const a = await encryptFile(bytes('same'));
    const b = await encryptFile(bytes('same'));
    expect(a.key).not.toBe(b.key);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.x).not.toBe(b.x);
  });

  it('rejects a blob whose hash does not match x', async () => {
    const enc = await encryptFile(bytes('payload'));
    const tampered = enc.ciphertext.slice();
    tampered[0] = tampered[0]! ^ 1;
    await expect(decryptFile(tampered, enc.key, enc.nonce, enc.x)).rejects.toBeInstanceOf(FileIntegrityError);
  });

  it('rejects tampering even without x (GCM tag)', async () => {
    const enc = await encryptFile(bytes('payload'));
    const tampered = enc.ciphertext.slice();
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    await expect(decryptFile(tampered, enc.key, enc.nonce)).rejects.toBeInstanceOf(FileIntegrityError);
  });

  it('accepts interoperable AES-128 files and byte views without neighboring data', async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(16));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, bytes('legacy')));
    expect(new TextDecoder().decode(await decryptFile(ciphertext, bytesToHex(keyBytes), bytesToHex(nonce)))).toBe('legacy');
    const source = bytes('outside:secret:outside');
    const encrypted = await encryptFile(source.subarray(8, 14));
    expect(encrypted.size).toBe(6);
    expect(new TextDecoder().decode(await decryptFile(encrypted.ciphertext, encrypted.key, encrypted.nonce, encrypted.x.toUpperCase()))).toBe('secret');
  });

  it('reports malformed keys and invalid nonces as integrity errors', async () => {
    const encrypted = await encryptFile(bytes('payload'));
    for (const badKey of ['not hex', '00', '00'.repeat(24)]) {
      await expect(decryptFile(encrypted.ciphertext, badKey, encrypted.nonce)).rejects.toBeInstanceOf(FileIntegrityError);
    }
    await expect(decryptFile(encrypted.ciphertext, encrypted.key, 'zz')).rejects.toBeInstanceOf(FileIntegrityError);
  });

  it('fails with the wrong key', async () => {
    const enc = await encryptFile(bytes('payload'));
    const other = await encryptFile(bytes('x'));
    await expect(decryptFile(enc.ciphertext, other.key, enc.nonce, enc.x)).rejects.toBeInstanceOf(FileIntegrityError);
  });
});
