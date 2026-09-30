/**
 * NIP-49 against an implementation that is not ours.
 *
 * Every other ncryptsec test in this package decodes with our own decoder or builds a payload
 * from our own reading of the layout, so a systematic encoder error, a wrong offset, the AAD
 * omitted, the password normalized differently, would round-trip happily and pass all of them.
 *
 * `nostr-tools` ships an independent NIP-49 implementation and is already in the workspace, so
 * the other direction is cheap to check. A backup is the one artefact of this system that has
 * to be readable by software that is not this package, years from now.
 *
 * It also cross-checks the scrypt bound against a second `@noble/hashes`: this package resolves
 * its own nested 2.4.0 and `nostr-tools` resolves the hoisted copy, so these tests put two
 * versions of the library on the two ends of the same backup.
 *
 * Ported from the extension's `tests/crypto/nip49.test.ts`, which round-trips its own
 * `ncryptsecEncode` and `ncryptsecDecode` across the same key-security bytes and cost
 * factors.
 */
import { describe, expect, test } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { encrypt as ntEncrypt, decrypt as ntDecrypt } from 'nostr-tools/nip49';
import { DEFAULT_LOG_N, decryptNcryptsec, encryptNcryptsec } from '../src/index.js';

const KEY = new Uint8Array(32).fill(4);

describe('NIP-49 interoperability with an independent implementation', () => {
  test('writes an ncryptsec that nostr-tools can decrypt', { timeout: 60_000 }, () => {
    const encoded = encryptNcryptsec(KEY, 'correct horse battery staple');
    expect(bytesToHex(ntDecrypt(encoded, 'correct horse battery staple'))).toBe(bytesToHex(KEY));
  });

  test('reads an ncryptsec that nostr-tools wrote', { timeout: 60_000 }, () => {
    const foreign = ntEncrypt(KEY, 'hunter22', DEFAULT_LOG_N, 0x02);
    expect(bytesToHex(decryptNcryptsec(foreign, 'hunter22'))).toBe(bytesToHex(KEY));
  });

  test('reads every key_security_byte the spec defines', { timeout: 120_000 }, () => {
    // 0x00 "has been handled insecurely", 0x01 "has not been", 0x02 "not tracked". The byte is
    // the AAD, so a decode that succeeds for all three proves the AAD is wired from the
    // payload rather than assumed to be the 0x02 this package always writes.
    for (const ksb of [0x00, 0x01, 0x02] as const) {
      const foreign = ntEncrypt(KEY, 'pw', DEFAULT_LOG_N, ksb);
      expect(bytesToHex(decryptNcryptsec(foreign, 'pw')), `key_security_byte 0x0${ksb}`).toBe(
        bytesToHex(KEY),
      );
    }
  });

  test('reads foreign cost factors either side of the one it writes', { timeout: 120_000 }, () => {
    // Other clients choose their own log_n, and the decoder accepts 1..MAX_LOG_N even though
    // the encoder refuses anything below MIN_LOG_N. This also exercises `scryptMaxMem` at costs
    // the encoder never writes: the bound has to be right across the whole accepted range, not
    // only at 16.
    //
    // 18 rather than the 22 the decoder tops out at, on purpose. `nostr-tools` passes no
    // `maxmem` at all, so the writing side of this test is capped by noble's 1 GiB default and
    // could not build a log_n 20 backup on every version of it. `scrypt-maxmem.test.ts` covers
    // the bound to 22 without needing anybody to run scrypt there.
    for (const logN of [1, 8, 14, 18]) {
      const foreign = ntEncrypt(KEY, 'pw', logN, 0x02);
      expect(bytesToHex(decryptNcryptsec(foreign, 'pw')), `foreign log_n ${logN}`).toBe(
        bytesToHex(KEY),
      );
    }
  });

  test('a password spelled two ways opens the same foreign backup', { timeout: 60_000 }, () => {
    // U+00E9 against e + U+0301. Both implementations NFKC-normalize, and this is the assertion
    // that says so across the boundary rather than inside one of them.
    const foreign = ntEncrypt(KEY, 'café', DEFAULT_LOG_N, 0x02);
    expect(bytesToHex(decryptNcryptsec(foreign, 'café'))).toBe(bytesToHex(KEY));
  });
});
