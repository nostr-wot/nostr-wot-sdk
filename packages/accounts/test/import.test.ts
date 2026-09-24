import { describe, expect, test } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import { scrypt } from '@noble/hashes/scrypt.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bech32 } from '@scure/base';
import {
  DEFAULT_LOG_N,
  LEGACY_PBKDF2_ITERATIONS,
  MIN_LOG_N,
  VERSION_LEGACY,
  decryptNcryptsec,
  detectImportKind,
  encryptNcryptsec,
  npubDecode,
  npubEncode,
  nsecDecode,
  nsecEncode,
  parseImportInput,
  shortNpub,
} from '../src/index.js';

const MNEMONIC = 'leader monkey parrot ring guide accident before fence cannon height naive bean';
const KEY = new Uint8Array(32).fill(4);
const PUBKEY_HEX = 'e'.repeat(64);
const PUBKEY_NPUB = 'npub1amhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhqmtnwcq';
// The NIP-06 vector's public key: a real derived key, not a handpicked x-coordinate.
const DERIVED_PUBKEY_HEX = '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917';

function flipLastChar(value: string): string {
  return value.slice(0, -1) + (value.endsWith('q') ? 'p' : 'q');
}

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
    if (parsed?.kind !== 'nsec') throw new Error('unreachable');
    expect(bytesToHex(parsed.privkey)).toBe(bytesToHex(KEY));
  });

  test('a valid npub yields a hex pubkey and is not mistaken for a private key', () => {
    const parsed = parseImportInput(PUBKEY_NPUB);
    expect(parsed?.kind).toBe('npub');
    if (parsed?.kind !== 'npub') throw new Error('unreachable');
    expect(parsed.pubkey).toBe(PUBKEY_HEX);
  });

  test('a bech32 string with a bad checksum is rejected for every prefix', () => {
    expect(parseImportInput(flipLastChar(nsecEncode(KEY)))).toBe(null);
    expect(parseImportInput(flipLastChar(encryptNcryptsec(KEY, 'hunter22', 16)))).toBe(null);
    expect(parseImportInput(flipLastChar(npubEncode(PUBKEY_HEX)))).toBe(null);
  });

  test('a bare 64-char hex string is a private key', () => {
    const parsed = parseImportInput(bytesToHex(KEY));
    expect(parsed?.kind).toBe('hex-private');
  });

  test('an ncryptsec is recognised before anything else claims it', () => {
    const parsed = parseImportInput(encryptNcryptsec(KEY, 'hunter22', 16));
    expect(parsed?.kind).toBe('ncryptsec');
  });

  test('a bunker uri without a 64-char hex pubkey is rejected', () => {
    expect(parseImportInput('bunker://nope')).toBe(null);
  });

  test('a private key that is not a valid curve scalar is rejected', () => {
    // Right length, valid checksum, unusable key: every one of these throws inside the curve
    // later, so accepting them here would only move the failure somewhere less explainable.
    const zero = new Uint8Array(32);
    const overOrder = new Uint8Array(32).fill(0xff);

    expect(parseImportInput(nsecEncode(zero))).toBe(null);
    expect(parseImportInput(nsecEncode(overOrder))).toBe(null);
    expect(parseImportInput('0'.repeat(64))).toBe(null);
    expect(parseImportInput('f'.repeat(64))).toBe(null);

    // ...while the shape detector still says what they were meant to be.
    expect(detectImportKind(nsecEncode(zero))).toBe('nsec');
    expect(detectImportKind('0'.repeat(64))).toBe('hex-private');
  });

  test('an npub whose x-coordinate is not on the curve is rejected', () => {
    // x = 0 and x = 7 have no point on secp256k1; 0xff…ff is outside the field entirely.
    // A watch-only account on any of them could never verify a signature.
    for (const hex of ['0'.repeat(64), '0'.repeat(63) + '7', 'f'.repeat(64)]) {
      const npub = bech32.encode('npub', bech32.toWords(hexToBytes(hex)), 5000);
      expect(parseImportInput(npub)).toBe(null);
      // ...and the UI can still say which thing it was, per ruling B.
      expect(detectImportKind(npub)).toBe('npub');
    }
  });

  test('a real npub still parses after the curve check', () => {
    expect(parseImportInput(PUBKEY_NPUB)?.kind).toBe('npub');
    // A pubkey actually derived from a seed, not just a handpicked x-coordinate.
    const derived = npubEncode(DERIVED_PUBKEY_HEX);
    const parsed = parseImportInput(derived);
    expect(parsed?.kind).toBe('npub');
    if (parsed?.kind !== 'npub') throw new Error('unreachable');
    expect(parsed.pubkey).toBe(DERIVED_PUBKEY_HEX);
  });

  test('an ncryptsec with a bad version byte or a truncated payload is rejected', () => {
    const tiny = bech32.encode('ncryptsec', bech32.toWords(new Uint8Array(5)), 5000);
    expect(parseImportInput(tiny)).toBe(null);
    expect(detectImportKind(tiny)).toBe('ncryptsec');

    // Correct v2 length, unknown version byte.
    const wrongVersion = new Uint8Array(91);
    wrongVersion[0] = 0x07;
    const encoded = bech32.encode('ncryptsec', bech32.toWords(wrongVersion), 5000);
    expect(parseImportInput(encoded)).toBe(null);

    // Correct version byte, one byte short.
    const truncated = new Uint8Array(90);
    truncated[0] = 0x02;
    expect(parseImportInput(bech32.encode('ncryptsec', bech32.toWords(truncated), 5000))).toBe(
      null,
    );
  });

  test('a mnemonic with a mistyped word fails its checksum and is rejected', () => {
    const typo = MNEMONIC.replace('leader', 'ladder');
    expect(typo).not.toBe(MNEMONIC);
    expect(parseImportInput(typo)).toBe(null);
  });
});

describe('detectImportKind', () => {
  test('shape alone decides, with no validation at all', () => {
    expect(detectImportKind(MNEMONIC)).toBe('mnemonic');
    expect(detectImportKind(MNEMONIC.replace('leader', 'ladder'))).toBe('mnemonic');
    expect(detectImportKind('npub1' + 'q'.repeat(58))).toBe('npub');
    expect(detectImportKind('ncryptsec1anything')).toBe('ncryptsec');
    expect(detectImportKind('nsec1anything')).toBe('nsec');
    expect(detectImportKind('bunker://nope')).toBe('bunker');
    expect(detectImportKind('0'.repeat(64))).toBe('hex-private');
  });

  test('this is the point: bad material still reports what it was meant to be', () => {
    const typo = MNEMONIC.replace('leader', 'ladder');
    const badNpub = 'npub1' + 'q'.repeat(58);
    // The UI can say "that seed phrase has a typo" rather than "unrecognized input".
    expect(parseImportInput(typo)).toBe(null);
    expect(detectImportKind(typo)).toBe('mnemonic');
    expect(parseImportInput(badNpub)).toBe(null);
    expect(detectImportKind(badNpub)).toBe('npub');
  });

  test('genuinely unrecognizable input is null either way', () => {
    expect(detectImportKind('not a key')).toBe(null);
    expect(detectImportKind('   ')).toBe(null);
    expect(detectImportKind('')).toBe(null);
  });
});

describe('NIP-49 ncryptsec', () => {
  test('an ncryptsec round trips through its password', { timeout: 60_000 }, () => {
    const key = new Uint8Array(32).fill(4);
    const encoded = encryptNcryptsec(key, 'hunter22', 16);
    expect(encoded.startsWith('ncryptsec1')).toBe(true);
    expect(decryptNcryptsec(encoded, 'hunter22')).toEqual(key);
    expect(() => decryptNcryptsec(encoded, 'wrong')).toThrow();
  });

  test('the password is NFKC-normalized, so both spellings open the same key', { timeout: 60_000 }, () => {
    // U+00E9 versus e + U+0301: the same text, two encodings.
    const encoded = encryptNcryptsec(KEY, 'café', 16);
    expect(decryptNcryptsec(encoded, 'café')).toEqual(KEY);
  });

  test('only 32-byte keys can be encrypted', () => {
    // Checked before any derivation, so this costs nothing.
    expect(() => encryptNcryptsec(new Uint8Array(31), 'hunter22', 16)).toThrow();
  });

  // The two tests below run their KDFs at the shipping work factor: scrypt at N = 2^16 twice,
  // and PBKDF2 at 210000 three times. That is around a second of pure JavaScript on an idle
  // machine and well past vitest's 5s default on a loaded one. The cost factor is what is
  // under test, so the headroom goes on the timeout, never on the count.
  test('the default scrypt cost factor round trips', { timeout: 60_000 }, () => {
    const encoded = encryptNcryptsec(KEY, 'hunter22');
    expect(decryptNcryptsec(encoded, 'hunter22')).toEqual(KEY);
  });

  /**
   * The floor is the default. A backup is the one artefact of this system that leaves the
   * device and can be guessed at offline for as long as anyone likes, so the cost of a guess
   * is the whole protection; the parameter can raise it and can never lower it below what
   * the shipping extension writes and NIP-49 recommends (2^16, 64 MiB).
   */
  test('the encoder refuses a cost factor below the floor, which is the default', () => {
    expect(MIN_LOG_N).toBe(16);
    expect(DEFAULT_LOG_N).toBe(MIN_LOG_N);
    for (const logn of [1, 8, 15]) {
      expect(() => encryptNcryptsec(KEY, 'hunter22', logn)).toThrow(/cost factor/i);
    }
  });

  test('the decoder still opens a v2 backup another client wrote below the floor', () => {
    // Built independently from the NIP-49 layout, at log_n = 8, which the encoder refuses.
    const salt = new Uint8Array(16).fill(3);
    const nonce = new Uint8Array(24).fill(5);
    const key = scrypt(new TextEncoder().encode('hunter22'), salt, { N: 1 << 8, r: 8, p: 1, dkLen: 32 });
    const ciphertext = xchacha20poly1305(key, nonce, new Uint8Array([0x02])).encrypt(KEY);
    const payload = new Uint8Array(91);
    payload[0] = 0x02;
    payload[1] = 8;
    payload.set(salt, 2);
    payload.set(nonce, 18);
    payload[42] = 0x02;
    payload.set(ciphertext, 43);
    const weak = bech32.encode('ncryptsec', bech32.toWords(payload), 5000);
    expect(decryptNcryptsec(weak, 'hunter22')).toEqual(KEY);
    expect(parseImportInput(weak)?.kind).toBe('ncryptsec');
  });

  test('a legacy 0x01 backup written by the extension still opens', { timeout: 60_000 }, () => {
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
    // ...and it classifies as importable, which is the whole point of keeping the path.
    expect(parseImportInput(legacy)?.kind).toBe('ncryptsec');
  });
});

describe('bech32 entities', () => {
  test('npub encodes and decodes to a fixed, published-shape string', () => {
    expect(npubEncode(PUBKEY_HEX)).toBe(PUBKEY_NPUB);
    expect(npubDecode(PUBKEY_NPUB)).toBe(PUBKEY_HEX);
  });

  test('nsec round trips through bytes', () => {
    expect(bytesToHex(nsecDecode(nsecEncode(KEY)))).toBe(bytesToHex(KEY));
  });

  test('decoding throws on a bad checksum or the wrong prefix', () => {
    expect(() => npubDecode(flipLastChar(PUBKEY_NPUB))).toThrow();
    expect(() => npubDecode(nsecEncode(KEY))).toThrow();
    expect(() => nsecDecode(PUBKEY_NPUB)).toThrow();
  });

  test('only 32-byte material can be encoded', () => {
    expect(() => npubEncode(new Uint8Array(31))).toThrow();
    expect(() => nsecEncode(new Uint8Array(33))).toThrow();
  });
});

describe('display', () => {
  test('shortNpub abbreviates the bech32 form', () => {
    expect(shortNpub(PUBKEY_HEX)).toBe('npub1amhwamh...nwcq');
  });

  test('a pubkey that will not encode falls back to the hex form', () => {
    expect(shortNpub('deadbeef')).toBe('deadbeef...beef');
  });
});
