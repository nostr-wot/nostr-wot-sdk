import { describe, expect, test } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  NIP06_ACCOUNT_PREFIX,
  NIP06_PATH,
  derivationPath,
  deriveFromMnemonic,
  derivePath,
  generateMnemonic,
  isValidPrivateKey,
  mnemonicToSeed,
  normalizeDerivationPath,
  publicKeyFromPrivate,
  standardDerivationIndex,
  toSafeAccount,
  validateMnemonic,
} from '../src/index.js';
import type { Account } from '../src/index.js';

// NIP-06 test vector: https://github.com/nostr-protocol/nips/blob/master/06.md
const MNEMONIC = 'leader monkey parrot ring guide accident before fence cannon height naive bean';
const EXPECTED_PRIV = '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a';
const EXPECTED_PUB = '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917';

describe('NIP-06 derivation', () => {
  test('the derivation path follows the extension, varying the last component', () => {
    expect(derivationPath(0)).toBe("m/44'/1237'/0'/0/0");
    // NOT m/44'/1237'/3'/0/0: the extension varies the last component, and its sub-accounts
    // have shipped. See the convention note in src/derivation.ts.
    expect(derivationPath(3)).toBe("m/44'/1237'/0'/0/3");
  });

  test('derivation matches the NIP-06 test vector', () => {
    const { privkey, pubkey, path } = deriveFromMnemonic(MNEMONIC, 0);
    expect(bytesToHex(privkey)).toBe(EXPECTED_PRIV);
    expect(pubkey).toBe(EXPECTED_PUB);
    expect(path).toBe("m/44'/1237'/0'/0/0");
  });

  test('sub accounts at different indexes produce different keys', () => {
    expect(bytesToHex(deriveFromMnemonic(MNEMONIC, 0).privkey)).not.toBe(
      bytesToHex(deriveFromMnemonic(MNEMONIC, 1).privkey),
    );
  });

  test('generateMnemonic defaults to 24 words and honours 128 bits', () => {
    expect(generateMnemonic().split(' ')).toHaveLength(24);
    expect(generateMnemonic(128).split(' ')).toHaveLength(12);
    expect(validateMnemonic(generateMnemonic())).toBe(true);
  });

  test('an invalid mnemonic is rejected rather than silently derived from', () => {
    expect(() => deriveFromMnemonic('not a real mnemonic at all', 0)).toThrow();
    expect(validateMnemonic('not a real mnemonic at all')).toBe(false);
  });

  test('deriveFromMnemonic agrees with derivePath over the same seed', () => {
    const seed = mnemonicToSeed(MNEMONIC);
    const direct = derivePath(seed, NIP06_PATH);
    expect(bytesToHex(direct)).toBe(EXPECTED_PRIV);
    expect(publicKeyFromPrivate(direct)).toBe(EXPECTED_PUB);
  });
});

describe('path round-tripping', () => {
  // The whole reason standardDerivationIndex exists: a stored path has to give the account
  // index back. When derivationPath and the prefix disagreed, only index 0 survived, and a
  // consumer silently lost derivationIndex for every sub-account after the first.
  test.each([0, 1, 3, 7, 42, 0x7fffffff])(
    'standardDerivationIndex(derivationPath(%i)) round-trips',
    (index) => {
      expect(standardDerivationIndex(derivationPath(index))).toBe(index);
    },
  );

  test('derivationPath is built from the account prefix', () => {
    expect(derivationPath(5)).toBe(NIP06_ACCOUNT_PREFIX + '5');
    expect(derivationPath(0)).toBe(NIP06_PATH);
  });

  test('derivationPath rejects indexes outside the BIP-32 range', () => {
    expect(() => derivationPath(-1)).toThrow();
    expect(() => derivationPath(1.5)).toThrow();
    expect(() => derivationPath(0x80000000)).toThrow();
  });

  test('a path outside the NIP-06 sequence has no account index', () => {
    expect(standardDerivationIndex("m/44'/0'/0'/0/0")).toBe(null);
    expect(standardDerivationIndex("m/44'/1237'/1'/0/0")).toBe(null);
    expect(standardDerivationIndex('nonsense')).toBe(null);
  });
});

describe('normalizeDerivationPath', () => {
  test('h and H are canonicalised to an apostrophe', () => {
    expect(normalizeDerivationPath("m/44h/1237H/0'/0/0")).toBe("m/44'/1237'/0'/0/0");
  });

  test('an already-canonical path is unchanged, and whitespace is trimmed', () => {
    expect(normalizeDerivationPath("  m/44'/1237'/0'/0/0  ")).toBe("m/44'/1237'/0'/0/0");
    expect(normalizeDerivationPath('m')).toBe('m');
  });

  test('malformed input is rejected', () => {
    expect(normalizeDerivationPath("44'/1237'/0'/0/0")).toBe(null); // no m
    expect(normalizeDerivationPath("m/44'/-1/0")).toBe(null);
    expect(normalizeDerivationPath('m/44/abc')).toBe(null);
    expect(normalizeDerivationPath(`m/${0x80000000}`)).toBe(null);
    expect(normalizeDerivationPath(null)).toBe(null);
    expect(normalizeDerivationPath(42)).toBe(null);
  });
});

describe('isValidPrivateKey', () => {
  test('a scalar in range is accepted', () => {
    expect(isValidPrivateKey(new Uint8Array(32).fill(4))).toBe(true);
  });

  test('zero, the curve order and beyond, and wrong lengths are rejected', () => {
    expect(isValidPrivateKey(new Uint8Array(32))).toBe(false);
    expect(isValidPrivateKey(new Uint8Array(32).fill(0xff))).toBe(false);
    expect(isValidPrivateKey(new Uint8Array(31).fill(4))).toBe(false);
    expect(isValidPrivateKey(new Uint8Array(33).fill(4))).toBe(false);
  });
});

describe('toSafeAccount', () => {
  const account: Account = {
    id: 'abc123',
    name: 'Main',
    type: 'generated',
    pubkey: EXPECTED_PUB,
    privkey: EXPECTED_PRIV,
    mnemonic: MNEMONIC,
    nip46Config: { bunkerUrl: 'bunker://x', relay: 'wss://r', secret: 'shhh' },
    readOnly: false,
    createdAt: 1_700_000_000,
    derivationIndex: 0,
    derivationPath: NIP06_PATH,
    pqKeys: {
      profile: 'nip-pqc/v1',
      kem: { public: 'pub', secret: 'SECRET' },
      dsa: { public: 'pub', secret: 'SECRET' },
      importedAt: 1_700_000_000,
    },
  };

  test('every private field is dropped', () => {
    const safe = toSafeAccount(account) as Record<string, unknown>;
    for (const field of ['privkey', 'mnemonic', 'nip46Config', 'pqKeys']) {
      expect(safe).not.toHaveProperty(field);
    }
    expect(JSON.stringify(safe)).not.toContain('SECRET');
    expect(JSON.stringify(safe)).not.toContain(EXPECTED_PRIV);
  });

  test('exactly the allowlisted fields survive', () => {
    expect(Object.keys(toSafeAccount(account)).sort()).toEqual([
      'createdAt',
      'derivationIndex',
      'derivationPath',
      'id',
      'name',
      'pubkey',
      'readOnly',
      'type',
    ]);
  });

  test('the optional derivation fields are omitted rather than set to undefined', () => {
    const { derivationIndex: _i, derivationPath: _p, ...rest } = account;
    const safe = toSafeAccount(rest);
    expect(safe).not.toHaveProperty('derivationIndex');
    expect(safe).not.toHaveProperty('derivationPath');
  });
});
