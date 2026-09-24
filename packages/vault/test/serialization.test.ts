/**
 * The in-memory projection of a stored account.
 *
 * Two properties matter here and nothing else does. Secrets have to land as `Uint8Array`, so
 * that `lock()` can zero them rather than leaving immutable strings for the collector to get
 * to whenever it feels like it. And the round trip has to be lossless, including for fields
 * this package does not model: the extension stores `walletConfig` on an account, and an app
 * that read a vault, dropped the field and saved would quietly destroy the user's wallet
 * connection.
 */
import { describe, test, expect } from 'vitest';
import type { Account } from '@nostr-wot/accounts';
import {
  toMemoryAccount,
  toStorageAccount,
  toStoragePayload,
  zeroMemoryAccount,
  bytesToBase64,
  base64ToBytes,
  bytesToHexBytes,
  hexBytesToBytes,
} from '../src/serialization.js';

const seeded: Account = {
  id: 'acct_1',
  name: 'Main',
  type: 'generated',
  pubkey: 'ab'.repeat(32),
  privkey: 'cd'.repeat(32),
  mnemonic: `${'abandon '.repeat(23)}art`,
  nip46Config: null,
  readOnly: false,
  createdAt: 1,
  derivationIndex: 0,
  derivationPath: "m/44'/1237'/0'/0/0",
};

const withPq: Account = {
  ...seeded,
  id: 'acct_pq',
  mnemonic: null,
  pqKeys: {
    profile: 'nip-pqc/v1',
    kem: { public: bytesToBase64(new Uint8Array(8).fill(1)), secret: bytesToBase64(new Uint8Array(8).fill(2)) },
    dsa: { public: bytesToBase64(new Uint8Array(8).fill(3)), secret: bytesToBase64(new Uint8Array(8).fill(4)) },
    importedAt: 1727136000000,
  },
};

/**
 * A remote-signer account. `secret` is the bunker's connect token and `localPrivkey` is the
 * client keypair the extension stores after the first connect, spelled exactly as it writes
 * them: the token verbatim, the key as lowercase hex.
 */
const remote: Account = {
  id: 'acct_bunker',
  name: 'Bunker',
  type: 'nip46',
  pubkey: '12'.repeat(32),
  privkey: null,
  mnemonic: null,
  nip46Config: {
    bunkerUrl: `bunker://${'12'.repeat(32)}?relay=wss%3A%2F%2Frelay.example`,
    relay: 'wss://relay.example',
    secret: 'topsecret-token',
    localPrivkey: '5a'.repeat(32),
    localPubkey: '6b'.repeat(32),
  },
  readOnly: false,
  createdAt: 3,
};

const watchOnly: Account = {
  id: 'acct_npub',
  name: 'Watch only',
  type: 'npub',
  pubkey: 'ef'.repeat(32),
  privkey: null,
  mnemonic: null,
  nip46Config: null,
  readOnly: true,
  createdAt: 2,
};

describe('memory account conversion', () => {
  test('secrets become zeroable bytes and the string fields are gone', () => {
    const mem = toMemoryAccount(seeded);
    expect(mem.privkeyBytes).toBeInstanceOf(Uint8Array);
    expect(mem.mnemonicBytes).toBeInstanceOf(Uint8Array);
    expect(Object.hasOwn(mem, 'privkey')).toBe(false);
    expect(Object.hasOwn(mem, 'mnemonic')).toBe(false);
    expect(Object.hasOwn(mem, 'pqKeys')).toBe(false);
    // The public metadata is not a secret and stays exactly where it was.
    expect(mem.pubkey).toBe(seeded.pubkey);
    expect(mem.derivationPath).toBe(seeded.derivationPath);
  });

  test('zeroing the memory bytes really does destroy the secret', () => {
    const mem = toMemoryAccount(seeded);
    mem.privkeyBytes?.fill(0);
    mem.mnemonicBytes?.fill(0);
    expect(toStorageAccount(mem).privkey).toBe('00'.repeat(32));
    expect(toStorageAccount(mem).mnemonic).not.toContain('abandon');
  });

  test('an account without pq keys round trips losslessly', () => {
    expect(toStorageAccount(toMemoryAccount(seeded))).toEqual(seeded);
  });

  test('an account with pq keys round trips losslessly', () => {
    const mem = toMemoryAccount(withPq);
    expect(mem.pqKemSecretBytes).toBeInstanceOf(Uint8Array);
    expect(mem.pqDsaSecretBytes).toBeInstanceOf(Uint8Array);
    // Public halves stay strings; only the secrets are held as zeroable bytes.
    expect(mem.pqPublic).toEqual({
      profile: 'nip-pqc/v1',
      kem: withPq.pqKeys!.kem.public,
      dsa: withPq.pqKeys!.dsa.public,
      importedAt: withPq.pqKeys!.importedAt,
    });
    expect(toStorageAccount(mem)).toEqual(withPq);
  });

  test('a read-only account with no private key round trips losslessly', () => {
    const mem = toMemoryAccount(watchOnly);
    expect(mem.privkeyBytes).toBeNull();
    expect(mem.mnemonicBytes).toBeNull();
    expect(toStorageAccount(mem)).toEqual(watchOnly);
  });

  /**
   * The extension stores `walletConfig` on an account. This package deliberately does not
   * model it, and must therefore carry it through untouched rather than drop it — a host
   * that reads a vault written by the extension and saves it back would otherwise wipe the
   * user's wallet connection with no error anywhere.
   */
  test('fields this package does not model survive the round trip untouched', () => {
    const withUnknown = {
      ...seeded,
      walletConfig: { provider: 'nwc', connectionString: 'nostr+walletconnect://deadbeef' },
      somethingFromTheFuture: { nested: [1, 2, 3] },
    } as unknown as Account;
    expect(toStorageAccount(toMemoryAccount(withUnknown))).toEqual(withUnknown);
  });

  /**
   * `Object.hasOwn` would call an explicitly-`undefined` property present and write back an
   * explicit `pqKeys: null`. Nothing `toMemoryAccount` produces looks like this, but a
   * hand-built memory account does, and `undefined` means absent everywhere else in JS.
   */
  test('an explicitly undefined pq field is treated as absent, not as null', () => {
    const mem = { ...toMemoryAccount(seeded), pqPublic: undefined };
    expect(Object.hasOwn(mem, 'pqPublic')).toBe(true);
    expect(Object.hasOwn(toStorageAccount(mem), 'pqKeys')).toBe(false);
    expect(toStorageAccount(mem)).toEqual(seeded);

    const acct = { ...seeded, pqKeys: undefined } as Account;
    expect(Object.hasOwn(toMemoryAccount(acct), 'pqPublic')).toBe(false);
  });

  test('an explicit null pqKeys stays an explicit null', () => {
    const explicitNull: Account = { ...seeded, pqKeys: null };
    const out = toStorageAccount(toMemoryAccount(explicitNull));
    expect(Object.hasOwn(out, 'pqKeys')).toBe(true);
    expect(out.pqKeys).toBeNull();
  });
});

describe('NIP-46 credentials', () => {
  test('the connect secret and the local private key become zeroable bytes, and no string copy stays', () => {
    const mem = toMemoryAccount(remote);
    expect(Object.hasOwn(mem, 'nip46Config')).toBe(false);
    expect(mem.nip46?.secretBytes).toBeInstanceOf(Uint8Array);
    expect(mem.nip46?.localPrivkeyBytes).toBeInstanceOf(Uint8Array);
    // The public halves stay strings, the secrets do not appear as strings anywhere on it.
    expect(mem.nip46?.relay).toBe('wss://relay.example');
    expect(mem.nip46?.localPubkey).toBe('6b'.repeat(32));
    const asText = JSON.stringify(mem, (_key, value: unknown) => (value instanceof Uint8Array ? '<bytes>' : value));
    expect(asText).not.toContain('topsecret-token');
    expect(asText).not.toContain('5a'.repeat(32));
  });

  test('a NIP-46 account round trips losslessly, and the config keeps the extension\'s key order', () => {
    const back = toStorageAccount(toMemoryAccount(remote));
    expect(back).toEqual(remote);
    // Field order inside the config is what the extension writes (`{ ...config, localPrivkey,
    // localPubkey }`), so a record saved here is byte for byte what it would have saved.
    expect(JSON.stringify(back.nip46Config)).toBe(JSON.stringify(remote.nip46Config));
  });

  test('a config without the local keypair round trips without gaining the fields', () => {
    const fresh: Account = {
      ...remote,
      nip46Config: { bunkerUrl: remote.nip46Config!.bunkerUrl, relay: null, secret: null },
    };
    const back = toStorageAccount(toMemoryAccount(fresh));
    expect(back).toEqual(fresh);
    expect(JSON.stringify(back.nip46Config)).toBe(JSON.stringify(fresh.nip46Config));
    expect(Object.hasOwn(back.nip46Config!, 'localPrivkey')).toBe(false);
    expect(Object.hasOwn(back.nip46Config!, 'localPubkey')).toBe(false);
  });

  test('a null nip46Config stays an explicit null', () => {
    const back = toStorageAccount(toMemoryAccount(seeded));
    expect(Object.hasOwn(back, 'nip46Config')).toBe(true);
    expect(back.nip46Config).toBeNull();
  });

  test('zeroing the memory account destroys both NIP-46 secrets', () => {
    const mem = toMemoryAccount(remote);
    zeroMemoryAccount(mem);
    expect(Array.from(mem.nip46!.secretBytes!)).toEqual(new Array('topsecret-token'.length).fill(0));
    expect(Array.from(mem.nip46!.localPrivkeyBytes!)).toEqual(new Array(64).fill(0));
    const back = toStorageAccount(mem);
    expect(back.nip46Config!.secret).not.toContain('topsecret');
    expect(back.nip46Config!.localPrivkey).not.toContain('5a5a');
  });
});

describe('hex as bytes', () => {
  // A hex string is what the record stores; a hex *byte array* is what memory holds, so the
  // conversion in either direction never has to pass through a string.
  test('encodes to the ASCII of lowercase hex and decodes back', () => {
    const raw = Uint8Array.from([0x00, 0x5a, 0xff, 0x10]);
    const hex = bytesToHexBytes(raw);
    expect(new TextDecoder().decode(hex)).toBe('005aff10');
    expect(hexBytesToBytes(hex)).toEqual(raw);
    expect(hexBytesToBytes(new TextEncoder().encode('005AFF10'))).toEqual(raw);
  });

  test('refuses an odd length and a non-hex byte', () => {
    expect(() => hexBytesToBytes(new TextEncoder().encode('abc'))).toThrow(/hex/i);
    expect(() => hexBytesToBytes(new TextEncoder().encode('zz'))).toThrow(/hex/i);
  });
});

describe('payload conversion', () => {
  test('the cache key becomes base64 and the accounts convert with it', () => {
    const cacheKeyBytes = new Uint8Array(32).fill(0x2b);
    const payload = toStoragePayload({
      cacheKeyBytes,
      accounts: [toMemoryAccount(seeded), toMemoryAccount(withPq)],
      activeAccountId: 'acct_1',
    });
    expect(payload.cacheKey).toBe(bytesToBase64(cacheKeyBytes));
    expect(payload.accounts).toEqual([seeded, withPq]);
    expect(payload.activeAccountId).toBe('acct_1');
  });

  test('no cache key in memory means no cacheKey field on the payload', () => {
    const payload = toStoragePayload({ accounts: [], activeAccountId: null });
    expect(Object.hasOwn(payload, 'cacheKey')).toBe(false);
    expect(payload.activeAccountId).toBeNull();
  });
});

describe('base64 codec', () => {
  /**
   * The extension's `arrayToBase64` is `btoa` over latin1, i.e. the standard alphabet with
   * padding. Anything URL-safe or unpadded here would write records it cannot read.
   */
  test('it is the standard padded alphabet, matching the extension btoa output', () => {
    expect(bytesToBase64(new Uint8Array([251, 255, 190, 0]))).toBe('+/++AA==');
    expect(base64ToBytes('+/++AA==')).toEqual(new Uint8Array([251, 255, 190, 0]));
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
  });

  test('it round trips a 32 byte key', () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => (i * 37) % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});
