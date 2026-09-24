import { describe, expect, test } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { derivationPath, deriveFromMnemonic, generateMnemonic } from '../src/index.js';

// NIP-06 test vector: https://github.com/nostr-protocol/nips/blob/master/06.md
const MNEMONIC = 'leader monkey parrot ring guide accident before fence cannon height naive bean';
const EXPECTED_PRIV = '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a';

describe('NIP-06 derivation', () => {
  test('the derivation path follows NIP-06', () => {
    expect(derivationPath(0)).toBe("m/44'/1237'/0'/0/0");
    expect(derivationPath(3)).toBe("m/44'/1237'/3'/0/0");
  });

  test('derivation matches the NIP-06 test vector', () => {
    const { privkey, path } = deriveFromMnemonic(MNEMONIC, 0);
    expect(bytesToHex(privkey)).toBe(EXPECTED_PRIV);
    expect(path).toBe("m/44'/1237'/0'/0/0");
  });

  test('sub accounts at different indexes produce different keys', () => {
    expect(bytesToHex(deriveFromMnemonic(MNEMONIC, 0).privkey)).not.toBe(
      bytesToHex(deriveFromMnemonic(MNEMONIC, 1).privkey),
    );
  });

  test('the derived pubkey is the 32-byte x-only key', () => {
    const { pubkey } = deriveFromMnemonic(MNEMONIC, 0);
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  test('generateMnemonic defaults to 24 words and honours 128 bits', () => {
    expect(generateMnemonic().split(' ')).toHaveLength(24);
    expect(generateMnemonic(128).split(' ')).toHaveLength(12);
  });

  test('an invalid mnemonic is rejected rather than silently derived from', () => {
    expect(() => deriveFromMnemonic('not a real mnemonic at all', 0)).toThrow();
  });
});
