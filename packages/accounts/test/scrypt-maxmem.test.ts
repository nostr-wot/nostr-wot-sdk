/**
 * The scrypt `maxmem` bound must clear what the installed `@noble/hashes` actually requires,
 * whatever version that is, including versions that did not exist when this was written.
 *
 * This package has been on the wrong side of that twice. `scryptMaxMem` first returned
 * `128·r·(N + p)`, the expression `@noble/hashes` 2.0.1 validates against; from 2.2.0 noble
 * validates against `128·r·(N + p + 1)`, counting a scratch block it had always allocated, so
 * every `encryptNcryptsec` and `decryptNcryptsec` threw `"maxmem" limit was hit`. The repair
 * was `128·r·(N + p + 1)`, which is 2.4.0's expression, character for character: it moved the
 * coupling one version along instead of removing it, and left zero blocks spare. The declared
 * `^2.4.0` range admits whatever noble ships next, so a release that charges one more block
 * takes the NIP-49 backup and import path out again.
 *
 * The existing NIP-49 suite could not see either one: every test there runs scrypt through
 * whichever version the lockfile pinned, so all of them agree with any bound that version
 * tolerates, including a wrong one.
 *
 * So the load-bearing assertion here does not restate any version's expression. It asks the
 * installed library, by binary-searching the smallest `maxmem` it will accept at a cheap cost
 * factor, and requires the bound to clear that with room to spare. A future noble that charges
 * more is discovered rather than assumed.
 *
 * The ceiling matters too, in the other direction. Headroom is only free while it stays a
 * handful of fixed blocks: slack that scaled with `N` would quietly authorise a multiple of
 * the V table, and `logN` comes from the payload.
 *
 * Ported from the extension's `tests/crypto/scrypt-maxmem.test.ts`, which probes the
 * installed `@noble/hashes` the same way rather than restating its expression.
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { scrypt } from '@noble/hashes/scrypt.js';
import {
  DEFAULT_LOG_N,
  MAX_LOG_N,
  SCRYPT_MAXMEM_SLACK_BLOCKS,
  SCRYPT_P,
  SCRYPT_R,
  scryptMaxMem,
} from '../src/index.js';

const BLOCK_SIZE = 128 * SCRYPT_R;

/** Both ends of the range the decoder accepts, the cost the encoder writes, and a spread between. */
const LOG_N_VALUES = [1, 2, 8, 14, DEFAULT_LOG_N, 20, MAX_LOG_N];

/** Costs cheap enough to actually run scrypt against, repeatedly, in a unit test. */
const PROBE_LOG_N_VALUES = [1, 2, 8, 10];

/**
 * The smallest `maxmem` the installed `@noble/hashes` accepts for these parameters, found by
 * binary search.
 *
 * This is the independent oracle. It reads no version number and restates no formula: it
 * discovers the library's requirement by observing which values it refuses, so it reports
 * `128·r·(N + p)` on 2.0.1 and `128·r·(N + p + 1)` on 2.2.0 onwards without being told that
 * either is the case, and would report a higher figure, and fail the assertions below, on a
 * release that charges more.
 *
 * Only `maxmem` rejections count as a refusal; any other error is a real failure and is
 * rethrown rather than silently widening the search.
 */
function smallestAcceptedMaxmem(logN: number): number {
  const N = 2 ** logN;
  const accepts = (maxmem: number): boolean => {
    try {
      scrypt(new Uint8Array(2), new Uint8Array(16), { N, r: SCRYPT_R, p: SCRYPT_P, dkLen: 32, maxmem });
      return true;
    } catch (e) {
      if (e instanceof Error && /maxmem/.test(e.message)) return false;
      throw e;
    }
  };

  // Generous ceiling for the search: if even this is refused, the assumption that `maxmem` is
  // what gates the call is wrong and the test should say so, not loop.
  let lo = 0;
  let hi = BLOCK_SIZE * (N + SCRYPT_P + 64);
  expect(accepts(hi), `installed @noble/hashes refused maxmem ${hi} at log_n ${logN}`).toBe(true);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (accepts(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

describe('scrypt maxmem accounting', () => {
  test('clears what the installed @noble/hashes actually requires', () => {
    // The assertion that would have caught the first regression, and that will catch the
    // next: no version, expression or release date appears in it.
    for (const logN of PROBE_LOG_N_VALUES) {
      const required = smallestAcceptedMaxmem(logN);
      expect(
        scryptMaxMem(logN),
        `log_n ${logN}: installed @noble/hashes requires maxmem >= ${required}`,
      ).toBeGreaterThanOrEqual(required);
    }
  });

  test('keeps headroom above that requirement rather than sitting on it', () => {
    // Being exactly right for the installed version is how this broke, twice, so sitting on
    // the line fails here even when the line is today's. Strictly positive headroom is the
    // contract, deliberately not "most of SLACK": this assertion is an early warning, and it
    // should go red when the headroom is spent rather than once users are broken. A noble
    // that charged one more block than this leaves spare would trip it while scryptMaxMem
    // still worked, which is the moment to raise SCRYPT_MAXMEM_SLACK_BLOCKS.
    for (const logN of PROBE_LOG_N_VALUES) {
      const required = smallestAcceptedMaxmem(logN);
      const spare = (scryptMaxMem(logN) - required) / BLOCK_SIZE;
      expect(
        spare,
        `log_n ${logN}: bound ${scryptMaxMem(logN)} sits on the installed library's requirement `
          + `(${required}); raise SCRYPT_MAXMEM_SLACK_BLOCKS`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        spare,
        `log_n ${logN}: ${spare} blocks spare exceeds the ${SCRYPT_MAXMEM_SLACK_BLOCKS} budgeted`,
      ).toBeLessThanOrEqual(SCRYPT_MAXMEM_SLACK_BLOCKS);
    }
  });

  test('stays within a fixed number of blocks of what the algorithm needs', () => {
    // The ceiling. Headroom is free only while it is a small constant: slack that grew with N
    // would authorise a multiple of the V table, and log_n is attacker supplied.
    for (const logN of LOG_N_VALUES) {
      const algorithmNeeds = BLOCK_SIZE * (2 ** logN + SCRYPT_P);
      const ceiling = algorithmNeeds + BLOCK_SIZE * SCRYPT_MAXMEM_SLACK_BLOCKS;
      expect(
        scryptMaxMem(logN),
        `log_n ${logN}: bound exceeds N + p + ${SCRYPT_MAXMEM_SLACK_BLOCKS} blocks (${ceiling})`,
      ).toBeLessThanOrEqual(ceiling);
      expect(
        scryptMaxMem(logN),
        `log_n ${logN}: bound is below the V table and B block the algorithm needs`,
      ).toBeGreaterThanOrEqual(algorithmNeeds);
    }
  });

  test('rejects both formulas that shipped broken, at every cost factor', () => {
    // The two specific regressions, pinned so neither can come back: `128·r·(N + p)` was
    // 2.0.1's expression and `128·r·(N + p + 1)` is 2.4.0's. Unlike the probe these name
    // expressions, so they are regression pins rather than the contract.
    for (const logN of LOG_N_VALUES) {
      const nobleLine201 = BLOCK_SIZE * (2 ** logN + SCRYPT_P);
      const nobleLine240 = BLOCK_SIZE * (2 ** logN + SCRYPT_P + 1);
      expect(
        scryptMaxMem(logN),
        `log_n ${logN}: bound is back on the 2.0.1 line, which throws from 2.2.0 onwards`,
      ).toBeGreaterThan(nobleLine201);
      expect(
        scryptMaxMem(logN),
        `log_n ${logN}: bound is back on the 2.4.0 line, which leaves the next noble no room`,
      ).toBeGreaterThan(nobleLine240);
    }
  });

  test('is the bound the NIP-49 derivation actually passes to scrypt', () => {
    // A correct helper that nothing calls is worth nothing, and this file could not see the
    // difference: reverting `deriveScryptKey` to an inline expression while leaving
    // `scryptMaxMem` intact would leave every assertion here green, because none of them touch
    // the call site.
    //
    // Reading the source is a blunt instrument, and deliberate: the alternative is to reach
    // into a module namespace to spy on `scrypt`, which is exactly the kind of library-shape
    // coupling this whole file exists to argue against.
    const source = readFileSync(new URL('../src/nip49.ts', import.meta.url), 'utf8');
    expect(source, 'deriveScryptKey must pass scryptMaxMem(logN) as maxmem').toMatch(
      /maxmem:\s*scryptMaxMem\(/,
    );
    expect(source, 'maxmem is being computed inline again instead of going through scryptMaxMem')
      .not.toMatch(/maxmem:\s*128\s*\*/);
  });

  test('derives the key the NIP-49 encoder needs at the cost it writes', { timeout: 60_000 }, () => {
    // End to end at the real cost factor, with the real bound.
    const key = scrypt(new TextEncoder().encode('pw'), new Uint8Array(16), {
      N: 2 ** DEFAULT_LOG_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      dkLen: 32,
      maxmem: scryptMaxMem(DEFAULT_LOG_N),
    });
    expect(key.length).toBe(32);
  });

  test('scales with the cost factor rather than being fixed', () => {
    // A constant would pass the round-trip tests while refusing a legitimate higher-cost
    // backup from another client.
    for (let logN = 2; logN <= MAX_LOG_N; logN++) {
      expect(scryptMaxMem(logN), `log_n ${logN}: bound must grow with N`).toBeGreaterThan(
        scryptMaxMem(logN - 1),
      );
    }
  });

  test('is 67,113,984 bytes at the cost the encoder writes (log_n 16, r 8, p 1)', () => {
    // 64 MiB of V table, one 1 KiB B block, four 1 KiB blocks of headroom. Recorded so the
    // number is reviewable, and as documentation of the scale involved.
    expect(scryptMaxMem(DEFAULT_LOG_N)).toBe(67_108_864 + 1_024 + 4 * 1_024);
    expect(scryptMaxMem(DEFAULT_LOG_N)).toBe(67_113_984);
  });
});
