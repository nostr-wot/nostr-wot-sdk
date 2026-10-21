/**
 * A derived key that is zero or not below the curve order fails, with no retry. No real PRF
 * output is known to produce one, so HKDF is replaced to return chosen scalars.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '../../src/vault/serialization.js';

const next: { value?: Uint8Array } = {};
vi.mock('@noble/hashes/hkdf.js', async original => {
  const real = await original<typeof import('@noble/hashes/hkdf.js')>();
  return { ...real, hkdf: vi.fn((...args: Parameters<typeof real.hkdf>) => next.value ?? real.hkdf(...args)) };
});
const { deriveNostrKey, DEFAULT_DERIVED_PARAMETER_SET } = await import('../../src/vault/passkey-modes.js');
const { hkdf } = await import('@noble/hashes/hkdf.js');

const ORDER = secp256k1.Point.CURVE().n;
const scalar = (value: bigint) => hexToBytes(value.toString(16).padStart(64, '0'));
afterEach(() => { next.value = undefined; vi.mocked(hkdf).mockClear(); });

test.each([['zero', BigInt(0)], ['the curve order', ORDER], ['above the curve order', ORDER + BigInt(1)], ['all ones', (BigInt(1) << BigInt(256)) - BigInt(1)]])('rejects %s once and zeroes it', (_name, value) => {
  const output = scalar(value); next.value = output;
  expect(() => deriveNostrKey(new Uint8Array(32).fill(7), DEFAULT_DERIVED_PARAMETER_SET)).toThrow('scalar');
  expect(hkdf).toHaveBeenCalledTimes(1);
  expect(output.every(byte => byte === 0)).toBe(true);
});
test('accepts the largest valid scalar', () => {
  next.value = scalar(ORDER - BigInt(1));
  expect(deriveNostrKey(new Uint8Array(32).fill(7), DEFAULT_DERIVED_PARAMETER_SET).pubkey).toMatch(/^[a-f0-9]{64}$/);
});
