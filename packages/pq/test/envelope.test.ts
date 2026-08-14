import { describe, it, expect } from 'vitest';
import { mnemonicToSeedSync } from '@scure/bip39';
import {
  derivePqKeys, encryptPq, decryptPq, isPqEnvelope, fromBase64, toBase64,
  ENVELOPE_VERSION, ALG_MLKEM1024_XCHACHA, KEM_CIPHERTEXT_BYTES, MAX_PLAINTEXT_BYTES,
  type EnvelopeParties,
} from '../src/index.js';

const M =
  'what bleak badge arrange retreat wolf trade produce cricket blur garlic valid proud rude strong choose busy staff weather area salt hollow arm fade';

const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const parties: EnvelopeParties = { sender: ALICE, recipient: BOB };

const bobKeys = () => derivePqKeys(mnemonicToSeedSync(M), 0);
const convKey = (fill = 7) => new Uint8Array(32).fill(fill);

describe('envelope round-trip', () => {
  it('encrypts and decrypts', () => {
    const bob = bobKeys();
    const ct = encryptPq('hello post-quantum world', bob.kem.publicKey, convKey(), parties);
    expect(decryptPq(ct, bob.kem.secretKey, convKey(), parties)).toBe('hello post-quantum world');
  });

  it('handles unicode and emoji', () => {
    const bob = bobKeys();
    const msg = 'ni hao 你好 — Grüße 🔐🛰️ Привет';
    const ct = encryptPq(msg, bob.kem.publicKey, convKey(), parties);
    expect(decryptPq(ct, bob.kem.secretKey, convKey(), parties)).toBe(msg);
  });

  it('handles a 1-character message', () => {
    const bob = bobKeys();
    const ct = encryptPq('x', bob.kem.publicKey, convKey(), parties);
    expect(decryptPq(ct, bob.kem.secretKey, convKey(), parties)).toBe('x');
  });

  it('handles a maximum-length message', () => {
    const bob = bobKeys();
    const msg = 'z'.repeat(MAX_PLAINTEXT_BYTES);
    const ct = encryptPq(msg, bob.kem.publicKey, convKey(), parties);
    expect(decryptPq(ct, bob.kem.secretKey, convKey(), parties)).toBe(msg);
  });

  it('produces a different ciphertext every time', () => {
    const bob = bobKeys();
    const a = encryptPq('same message', bob.kem.publicKey, convKey(), parties);
    const b = encryptPq('same message', bob.kem.publicKey, convKey(), parties);
    expect(a).not.toBe(b);
  });
});

describe('envelope framing', () => {
  it('starts with the version and algorithm bytes', () => {
    const bob = bobKeys();
    const bytes = fromBase64(encryptPq('hi', bob.kem.publicKey, convKey(), parties));
    expect(bytes[0]).toBe(ENVELOPE_VERSION);
    expect(bytes[1]).toBe(ALG_MLKEM1024_XCHACHA);
    expect(bytes.length).toBeGreaterThan(2 + KEM_CIPHERTEXT_BYTES);
  });

  it('isPqEnvelope recognises its own output and rejects other things', () => {
    const bob = bobKeys();
    expect(isPqEnvelope(encryptPq('hi', bob.kem.publicKey, convKey(), parties))).toBe(true);
    expect(isPqEnvelope('not base64 !!!')).toBe(false);
    expect(isPqEnvelope(toBase64(new Uint8Array([2, 1, 3])))).toBe(false);
  });
});

describe('envelope padding hides length', () => {
  it('short messages of different lengths produce identical ciphertext sizes', () => {
    const bob = bobKeys();
    const sizes = ['a', 'ab', 'a'.repeat(20), 'a'.repeat(32)].map(
      (m) => fromBase64(encryptPq(m, bob.kem.publicKey, convKey(), parties)).length,
    );
    expect(new Set(sizes).size).toBe(1);
  });

  it('a longer message still lands on a padded bucket', () => {
    const bob = bobKeys();
    const a = fromBase64(encryptPq('a'.repeat(33), bob.kem.publicKey, convKey(), parties)).length;
    const b = fromBase64(encryptPq('a'.repeat(48), bob.kem.publicKey, convKey(), parties)).length;
    expect(a).toBe(b);
  });
});

describe('envelope rejects tampering', () => {
  const mutate = (ct: string, index: number) => {
    const bytes = fromBase64(ct);
    bytes[index] = bytes[index]! ^ 0xff;
    return toBase64(bytes);
  };

  it('rejects a flipped bit in the KEM ciphertext', () => {
    const bob = bobKeys();
    const ct = encryptPq('secret', bob.kem.publicKey, convKey(), parties);
    expect(() => decryptPq(mutate(ct, 10), bob.kem.secretKey, convKey(), parties)).toThrow(
      /Decryption failed/,
    );
  });

  it('rejects a flipped bit in the sealed body', () => {
    const bob = bobKeys();
    const ct = encryptPq('secret', bob.kem.publicKey, convKey(), parties);
    const bytes = fromBase64(ct);
    expect(() =>
      decryptPq(mutate(ct, bytes.length - 5), bob.kem.secretKey, convKey(), parties),
    ).toThrow(/Decryption failed/);
  });

  it('rejects a downgraded algorithm byte', () => {
    const bob = bobKeys();
    const ct = encryptPq('secret', bob.kem.publicKey, convKey(), parties);
    const bytes = fromBase64(ct);
    bytes[1] = 0x02;
    expect(() => decryptPq(toBase64(bytes), bob.kem.secretKey, convKey(), parties)).toThrow(
      /Decryption failed/,
    );
  });

  it('rejects an unknown version byte', () => {
    const bob = bobKeys();
    const ct = encryptPq('secret', bob.kem.publicKey, convKey(), parties);
    const bytes = fromBase64(ct);
    bytes[0] = 0x09;
    expect(() => decryptPq(toBase64(bytes), bob.kem.secretKey, convKey(), parties)).toThrow(
      /Decryption failed/,
    );
  });

  it('rejects a truncated payload', () => {
    const bob = bobKeys();
    const ct = encryptPq('secret', bob.kem.publicKey, convKey(), parties);
    const bytes = fromBase64(ct).subarray(0, 100);
    expect(() => decryptPq(toBase64(bytes), bob.kem.secretKey, convKey(), parties)).toThrow(
      /Decryption failed/,
    );
  });
});

describe('envelope binds the conversation', () => {
  it('rejects a message replayed into a different conversation', () => {
    // The whole point of putting both pubkeys in the AEAD's associated data.
    const bob = bobKeys();
    const ct = encryptPq('for bob only', bob.kem.publicKey, convKey(), parties);
    const wrong: EnvelopeParties = { sender: 'c'.repeat(64), recipient: BOB };
    expect(() => decryptPq(ct, bob.kem.secretKey, convKey(), wrong)).toThrow(/Decryption failed/);
  });

  it('rejects swapped sender and recipient', () => {
    const bob = bobKeys();
    const ct = encryptPq('directional', bob.kem.publicKey, convKey(), parties);
    const swapped: EnvelopeParties = { sender: BOB, recipient: ALICE };
    expect(() => decryptPq(ct, bob.kem.secretKey, convKey(), swapped)).toThrow(
      /Decryption failed/,
    );
  });

  it('rejects a wrong NIP-44 conversation key — the hybrid actually binds both halves', () => {
    // If this passed, the classic half would be decorative and the construction
    // would not be hybrid at all.
    const bob = bobKeys();
    const ct = encryptPq('hybrid matters', bob.kem.publicKey, convKey(7), parties);
    expect(() => decryptPq(ct, bob.kem.secretKey, convKey(8), parties)).toThrow(
      /Decryption failed/,
    );
  });

  it('rejects a wrong ML-KEM secret key — and the PQ half binds too', () => {
    const bob = bobKeys();
    const mallory = derivePqKeys(mnemonicToSeedSync(M), 1);
    const ct = encryptPq('pq matters', bob.kem.publicKey, convKey(), parties);
    expect(() => decryptPq(ct, mallory.kem.secretKey, convKey(), parties)).toThrow(
      /Decryption failed/,
    );
  });
});

describe('envelope input validation', () => {
  it('refuses an empty message', () => {
    const bob = bobKeys();
    expect(() => encryptPq('', bob.kem.publicKey, convKey(), parties)).toThrow();
  });

  it('refuses an over-long message', () => {
    const bob = bobKeys();
    expect(() =>
      encryptPq('z'.repeat(MAX_PLAINTEXT_BYTES + 1), bob.kem.publicKey, convKey(), parties),
    ).toThrow(/too long/);
  });

  it('refuses a malformed KEM public key', () => {
    expect(() => encryptPq('hi', new Uint8Array(10), convKey(), parties)).toThrow(
      /Invalid ML-KEM public key length/,
    );
  });

  it('refuses a malformed conversation key', () => {
    const bob = bobKeys();
    expect(() => encryptPq('hi', bob.kem.publicKey, new Uint8Array(16), parties)).toThrow(
      /Invalid conversation key/,
    );
  });

  it('failure is indistinguishable across causes — no oracle', () => {
    const bob = bobKeys();
    const ct = encryptPq('secret', bob.kem.publicKey, convKey(), parties);
    const messages = [
      () => decryptPq(ct, bob.kem.secretKey, convKey(9), parties),
      () => decryptPq(ct, derivePqKeys(mnemonicToSeedSync(M), 2).kem.secretKey, convKey(), parties),
      () => decryptPq('AAAA', bob.kem.secretKey, convKey(), parties),
    ].map((f) => {
      try { f(); return 'no-throw'; } catch (e) { return (e as Error).message; }
    });
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe('Decryption failed');
  });
});

describe('party validation', () => {
  it('rejects a colon in a party pubkey, which would collapse distinct conversations', () => {
    // Same length as a real pubkey, so only the charset check catches it. Without this,
    // sealing as (A + ':' + B, C) produces associated data identical to (A, B + ':' + C).
    const injected = 'a'.repeat(31) + ':' + 'a'.repeat(32);
    expect(injected.length).toBe(64);
    const bob = bobKeys();
    expect(() =>
      encryptPq('hi', bob.kem.publicKey, convKey(), { ...parties, sender: injected }),
    ).toThrow();
    expect(() =>
      encryptPq('hi', bob.kem.publicKey, convKey(), { ...parties, recipient: injected }),
    ).toThrow();
  });

  it('rejects uppercase hex, which would interoperate with nothing', () => {
    const bob = bobKeys();
    expect(() =>
      encryptPq('hi', bob.kem.publicKey, convKey(), { ...parties, sender: 'A'.repeat(64) }),
    ).toThrow();
  });

  it('rejects wrong-length pubkeys', () => {
    const bob = bobKeys();
    expect(() =>
      encryptPq('hi', bob.kem.publicKey, convKey(), { ...parties, sender: 'abc' }),
    ).toThrow();
    expect(() =>
      encryptPq('hi', bob.kem.publicKey, convKey(), { ...parties, sender: '' }),
    ).toThrow();
  });

  it('still accepts well-formed pubkeys', () => {
    const bob = bobKeys();
    expect(() => encryptPq('hi', bob.kem.publicKey, convKey(), parties)).not.toThrow();
  });
});
