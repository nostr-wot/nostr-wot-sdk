/**
 * What a caller is told when scrypt itself refuses the parameters.
 *
 * This is not hypothetical: it is what the `maxmem` regression actually looked like from the
 * outside. The library threw `"maxmem" limit was hit: memUsed(128*r*(N+p+1))=67110912`, this
 * package let it through unchanged, and the extension's import screen rendered it into the UI,
 * because hosts put `error.message` in front of the user. A person holding a backup they
 * cannot open was shown the internals of a hash library.
 *
 * Two things are asserted, and they matter in opposite directions. The message has to be
 * something a person can act on, and it has to NOT be the wrong-password message: a backup
 * this build cannot stretch at all is a different problem from a password that does not match,
 * and telling someone to retype a password that was already right sends them somewhere there
 * is no fix. The `cause` carries the library's own error for whoever is debugging.
 *
 * Mocking the library is the only way to make it fail on demand, and here it is the right
 * instrument: what is under test is this package's handling of a failure, not the library's
 * arithmetic. `test/scrypt-maxmem.test.ts` covers the arithmetic, and it deliberately mocks
 * nothing.
 *
 * Ported from the extension's `c7d0ec8`, "Fix NIP-49 scrypt bounds and guard dependency
 * compatibility".
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { bech32 } from '@scure/base';
import { scrypt } from '@noble/hashes/scrypt.js';
import { DEFAULT_LOG_N, V2_PAYLOAD_LENGTH, decryptNcryptsec, encryptNcryptsec } from '../src/index.js';

vi.mock('@noble/hashes/scrypt.js', () => ({ scrypt: vi.fn() }));

/** The shape noble throws when the bound is one block short of what it charges. */
const NOBLE_MAXMEM_ERROR = new Error('"maxmem" limit was hit: memUsed(128*r*(N+p+1))=67110912, maxmem=67110911');

const KEY = new Uint8Array(32).fill(4);

/** A structurally valid v2 ncryptsec. The ciphertext is never reached: scrypt throws first. */
function wellFormedNcryptsec(logN: number = DEFAULT_LOG_N): string {
  const payload = new Uint8Array(V2_PAYLOAD_LENGTH);
  payload[0] = 0x02;
  payload[1] = logN;
  payload[42] = 0x02;
  return bech32.encode('ncryptsec', bech32.toWords(payload), 5000);
}

describe('a scrypt derivation this build cannot perform', () => {
  beforeEach(() => {
    vi.mocked(scrypt).mockImplementation(() => {
      throw NOBLE_MAXMEM_ERROR;
    });
  });

  test('decoding reports something a person can act on, not the library internals', () => {
    expect(() => decryptNcryptsec(wellFormedNcryptsec(), 'hunter22')).toThrow(
      /Could not derive a key from this backup's scrypt parameters/,
    );
    // The exact string the unfixed package put in front of a user.
    expect(() => decryptNcryptsec(wellFormedNcryptsec(), 'hunter22')).not.toThrow(/maxmem/);
  });

  test('decoding does not blame the password, which was never checked', () => {
    // The decoder's wrong-password catch wraps the AEAD open only. If it ever grew to cover
    // the derivation, every unreadable backup would be reported as a typo and the user would
    // be sent to retype a password that was right.
    expect(() => decryptNcryptsec(wellFormedNcryptsec(), 'hunter22')).not.toThrow(
      /wrong password|corrupted/i,
    );
  });

  test('encoding reports the same thing, so a backup that cannot be written says why', () => {
    expect(() => encryptNcryptsec(KEY, 'hunter22')).toThrow(
      /Could not derive a key from this backup's scrypt parameters/,
    );
  });

  test('the library error survives as the cause, for whoever is debugging it', () => {
    // Readable on the surface, complete underneath: the point is to add a layer, not to
    // swallow what the library said.
    let caught: unknown;
    try {
      decryptNcryptsec(wellFormedNcryptsec(), 'hunter22');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).cause).toBe(NOBLE_MAXMEM_ERROR);
  });
});
