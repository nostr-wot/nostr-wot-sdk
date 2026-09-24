import { describe, expect, test } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { bech32 } from '@scure/base';
import {
  LEGACY_PBKDF2_ITERATIONS,
  VERSION_LEGACY,
  decryptNcryptsec,
  encryptNcryptsec,
  npubEncode,
  nsecEncode,
  parseImportInput,
  shortNpub,
} from '../src/index.js';

const MNEMONIC = 'leader monkey parrot ring guide accident before fence cannon height naive bean';
const KEY = new Uint8Array(32).fill(4);

describe('parseImportInput', () => {
  test('import input is classified by shape, and nonsense is rejected', () => {
    expect(parseImportInput(MNEMONIC)?.kind).toBe('mnemonic');
    // A checksum this bech32 string does not satisfy; it must not be accepted as an npub.
    expect(parseImportInput('npub1' + 'q'.repeat(58))).toBe(null);
    expect(parseImportInput('bunker://' + 'ab'.repeat(32))?.kind).toBe('bunker');
    expect(parseImportInput('not a key')).toBe(null);
  });

  test('a valid nsec yields its private key bytes', () => {
    const parsed = parseImportInput(nsecEncode(KEY));
    expect(parsed?.kind).toBe('nsec');
    expect(parsed).toMatchObject({ kind: 'nsec' });
    if (parsed?.kind !== 'nsec') throw new Error('unreachable');
    expect(bytesToHex(parsed.privkey)).toBe(bytesToHex(KEY));
  });

  test('a valid npub yields a hex pubkey and is not mistaken for a private key', () => {
    const pubkeyHex = 'e'.repeat(64);
    const parsed = parseImportInput(npubEncode(pubkeyHex));
    expect(parsed?.kind).toBe('npub');
    if (parsed?.kind !== 'npub') throw new Error('unreachable');
    expect(parsed.pubkey).toBe(pubkeyHex);
  });

  test('a bech32 string with a bad checksum is rejected for every prefix', () => {
    const goodNsec = nsecEncode(KEY);
    // Flip one data character; the checksum can no longer hold.
    const badNsec = goodNsec.slice(0, -1) + (goodNsec.endsWith('q') ? 'p' : 'q');
    expect(parseImportInput(badNsec)).toBe(null);

    const goodNcryptsec = encryptNcryptsec(KEY, 'hunter22', 8);
    const badNcryptsec =
      goodNcryptsec.slice(0, -1) + (goodNcryptsec.endsWith('q') ? 'p' : 'q');
    expect(parseImportInput(badNcryptsec)).toBe(null);
  });

  test('a bare 64-char hex string is a private key', () => {
    const parsed = parseImportInput(bytesToHex(KEY));
    expect(parsed?.kind).toBe('hex-private');
  });

  test('an ncryptsec is recognised before anything else claims it', () => {
    const parsed = parseImportInput(encryptNcryptsec(KEY, 'hunter22', 8));
    expect(parsed?.kind).toBe('ncryptsec');
  });

  test('a bunker uri without a 64-char hex pubkey is rejected', () => {
    expect(parseImportInput('bunker://nope')).toBe(null);
  });
});

describe('NIP-49 ncryptsec', () => {
  test('an ncryptsec round trips through its password', () => {
    const key = new Uint8Array(32).fill(4);
    const encoded = encryptNcryptsec(key, 'hunter22', 8);
    expect(encoded.startsWith('ncryptsec1')).toBe(true);
    expect(decryptNcryptsec(encoded, 'hunter22')).toEqual(key);
    expect(() => decryptNcryptsec(encoded, 'wrong')).toThrow();
  });

  test('the password is NFKC-normalized, so both spellings open the same key', () => {
    // U+00E9 versus e + U+0301: the same text, two encodings.
    const encoded = encryptNcryptsec(KEY, 'café', 8);
    expect(decryptNcryptsec(encoded, 'café')).toEqual(KEY);
  });

  test('only 32-byte keys can be encrypted', () => {
    expect(() => encryptNcryptsec(new Uint8Array(31), 'hunter22', 8)).toThrow();
  });

  test('the default scrypt cost factor round trips', () => {
    const encoded = encryptNcryptsec(KEY, 'hunter22');
    expect(decryptNcryptsec(encoded, 'hunter22')).toEqual(KEY);
  });

  test('a legacy 0x01 backup written by the extension still opens', () => {
    // Built independently, from the extension's legacy format:
    // version(1) + salt(16) + iv(12) + AES-256-GCM ciphertext(48), PBKDF2-SHA256 at 210K.
    const salt = new Uint8Array(16).fill(7);
    const iv = new Uint8Array(12).fill(9);
    const key = pbkdf2(sha256, new TextEncoder().encode('hunter22'), salt, {
      c: LEGACY_PBKDF2_ITERATIONS,
      dkLen: 32,
    });
    const ciphertext = gcm(key, iv).encrypt(KEY);
    const payload = new Uint8Array(1 + 16 + 12 + ciphertext.length);
    payload[0] = VERSION_LEGACY;
    payload.set(salt, 1);
    payload.set(iv, 17);
    payload.set(ciphertext, 29);
    const legacy = bech32.encode('ncryptsec', bech32.toWords(payload), 5000);

    expect(decryptNcryptsec(legacy, 'hunter22')).toEqual(KEY);
    expect(() => decryptNcryptsec(legacy, 'wrong')).toThrow();
  });
});

describe('display', () => {
  test('shortNpub abbreviates the bech32 form', () => {
    const pubkeyHex = 'e'.repeat(64);
    const npub = npubEncode(pubkeyHex);
    expect(shortNpub(pubkeyHex)).toBe(npub.slice(0, 12) + '...' + npub.slice(-4));
  });
});
